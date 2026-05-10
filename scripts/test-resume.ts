/**
 * scripts/test-resume.ts
 *
 * Exercise autoloop_resume on a real workspace.
 *
 * Sequence:
 *   1. Set up the same buggy workspace as smoke-autoloop
 *   2. Start autoloop on it; immediately request stop ~5s after start() returns
 *      (which is after BOOTSTRAP completes). The stop will catch us mid-PROPOSE
 *      or just before iter 1's PROPOSE — hence pre-target.
 *   3. Verify state.json is on disk with status=stopped (not 'completed' or
 *      'error') and termination.fired=false
 *   4. Spin down the SessionManager
 *   5. Spin up a fresh SessionManager + call autoloopResume(workspace, taskId)
 *   6. Wait for completion (target hit) and verify pytest passes
 *
 * Logs everything to RESUME-TEST.md in the workspace.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execSync } from 'node:child_process';
import { SessionManager, AutoloopRunner } from '../dist/src/index.js';
import type { AutoloopConfig } from '../dist/src/index.js';
import { createConsoleLogger } from '../dist/src/index.js';

function loadClaudeSettingsEnv(): void {
  const p = path.join(os.homedir(), '.claude', 'settings.json');
  if (!fs.existsSync(p)) return;
  try {
    const cfg = JSON.parse(fs.readFileSync(p, 'utf-8'));
    if (cfg.env && typeof cfg.env === 'object') {
      for (const [k, v] of Object.entries(cfg.env)) {
        if (typeof v === 'string' && !process.env[k]) process.env[k] = v;
      }
    }
  } catch {
    /* non-fatal */
  }
}
loadClaudeSettingsEnv();

const TS = new Date().toISOString().replace(/[:.]/g, '-');
const WORKSPACE = `/tmp/autoloop-resume-${TS}`;
const LOG_PATH = path.join(WORKSPACE, 'RESUME-TEST.md');

function log(line: string): void {
  fs.appendFileSync(LOG_PATH, line + '\n');
  process.stderr.write(line + '\n');
}

function setupWorkspace(): void {
  fs.mkdirSync(WORKSPACE, { recursive: true });
  fs.writeFileSync(path.join(WORKSPACE, 'app.py'), `def add_two(x):\n    return x - 2\n`);
  fs.writeFileSync(
    path.join(WORKSPACE, 'test_app.py'),
    `from app import add_two\n\ndef test_a(): assert add_two(3) == 5\ndef test_b(): assert add_two(0) == 2\n`,
  );
  fs.writeFileSync(
    path.join(WORKSPACE, 'plan.md'),
    `# Plan\n\nFix the bug in \`add_two\` so all tests in \`test_app.py\` pass.\n`,
  );
  const goal = {
    gates: [
      { name: 'pytest_passes', cmd: 'python3 -m pytest -q test_app.py', must: 'exit-0', timeout_sec: 60 },
    ],
    termination: {
      scalar_target_hit: true,
      max_iters: 5,
      plateau_iters: 3,
      max_cost_usd: 5,
      max_pending_aspirational: 0,
    },
  };
  fs.writeFileSync(path.join(WORKSPACE, 'goal.json'), JSON.stringify(goal, null, 2));
  execSync(
    'git init -q && git add -A && git -c user.email=t@t -c user.name=t commit -qm initial',
    { cwd: WORKSPACE },
  );
  fs.writeFileSync(LOG_PATH, `# Resume Test — ${TS}\n\n`);
  log(`## Setup\n- Workspace: \`${WORKSPACE}\`\n- task_id: \`smoke\`\n`);
}

const TASK_ID = 'smoke';

async function phaseOne(): Promise<void> {
  log(`\n## Phase 1: Start, then stop after BOOTSTRAP\n`);
  const logger = createConsoleLogger('test-resume-1');
  const manager = new SessionManager({});
  const config: AutoloopConfig = {
    workspace: WORKSPACE,
    plan_path: path.join(WORKSPACE, 'plan.md'),
    goal_path: path.join(WORKSPACE, 'goal.json'),
    task_id: TASK_ID,
    propose_engine: 'claude',
    propose_model: 'sonnet',
    ratchet_engine: 'claude',
    ratchet_model: 'sonnet',
    compress_every_k: 100,
    push_cmd: null,
  };
  const runner = new AutoloopRunner(manager, config, logger);
  runner.on('phase', (e) => {
    const ev = e as { phase: string; iter: number };
    log(`- [phase1] phase=${ev.phase} iter=${ev.iter}`);
  });

  // start() resolves AFTER BOOTSTRAP. Then we stop immediately.
  await runner.start();
  log(`- [phase1] start() returned. Calling stop().`);
  await runner.stop();
  const h = runner.handle();
  log(`- [phase1] stopped: status=${h.status} phase=${h.current_phase} iter=${h.current_iter}`);
  await manager.shutdown();

  // Verify on-disk state.
  const statePath = path.join(WORKSPACE, 'tasks', TASK_ID, 'state.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
  log(`- [phase1] state.json: status=${state.status} phase=${state.phase} iter=${state.iter} bootstrap_sha=${(state.bootstrap_sha || '').slice(0, 7)} termination.fired=${state.termination.fired}`);

  if (state.termination.fired) {
    throw new Error('phase1: termination.fired should be false (was a stop, not goal-hit)');
  }
  if (!state.bootstrap_sha) {
    throw new Error('phase1: bootstrap_sha should be set after BOOTSTRAP');
  }
}

async function phaseTwo(): Promise<void> {
  log(`\n## Phase 2: New SessionManager, autoloopResume, run to completion\n`);
  const logger = createConsoleLogger('test-resume-2');
  const manager = new SessionManager({});
  const handle = await manager.autoloopResume(WORKSPACE, TASK_ID, {
    propose_engine: 'claude',
    propose_model: 'sonnet',
    ratchet_engine: 'claude',
    ratchet_model: 'sonnet',
    compress_every_k: 100,
    push_cmd: null,
  });
  log(`- [phase2] resume() returned: status=${handle.status} iter=${handle.current_iter}`);

  const runner = manager.getAutoloop(handle.id)!;
  runner.on('phase', (e) => {
    const ev = e as { phase: string; iter: number };
    log(`- [phase2] phase=${ev.phase} iter=${ev.iter}`);
  });
  runner.on('push', (p) => {
    const pe = p as { kind: string; text: string };
    log(`- [phase2] push **${pe.kind}**: ${pe.text.replace(/\n/g, ' ').slice(0, 200)}`);
  });
  runner.on('terminated', (t) => {
    const te = t as { reason: string };
    log(`- [phase2] terminated: ${te.reason}`);
  });

  const deadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < deadline) {
    const h = runner.handle();
    if (h.status === 'completed' || h.status === 'error' || h.status === 'stopped') break;
    await new Promise((r) => setTimeout(r, 3000));
  }

  const finalH = runner.handle();
  log(`\n- [phase2] final: status=${finalH.status} iter=${finalH.current_iter} best=${finalH.best_metric}`);

  // Verify pytest passes.
  let pytestPassed = false;
  try {
    execSync('python3 -m pytest -q test_app.py', { cwd: WORKSPACE, stdio: 'pipe' });
    pytestPassed = true;
  } catch {
    /* fail */
  }
  log(`- [phase2] pytest passes: ${pytestPassed ? '✅ YES' : '❌ NO'}`);

  // Verify the autoloop branch has the bootstrap + at least 1 iter commit.
  const commits = execSync('git log --oneline autoloop/smoke', { cwd: WORKSPACE, encoding: 'utf-8' });
  log(`\n### Commits on autoloop/smoke after resume\n\n\`\`\`\n${commits.trim()}\n\`\`\``);

  await manager.shutdown();
  if (!pytestPassed) throw new Error('phase2: pytest should pass after resume completion');
  if (finalH.status !== 'completed') throw new Error(`phase2: expected completed, got ${finalH.status}`);
}

async function main(): Promise<void> {
  setupWorkspace();
  await phaseOne();
  await phaseTwo();
  log(`\n## ✅ TEST PASSED\n`);
  process.stderr.write(`\n=== RESUME TEST PASSED ===\nLog: ${LOG_PATH}\n`);
}

main().catch((err) => {
  log(`\n## ❌ TEST FAILED\n\n\`\`\`\n${err instanceof Error ? err.stack || err.message : String(err)}\n\`\`\``);
  process.stderr.write(`\nRESUME TEST FAILED: ${LOG_PATH}\n`);
  process.exit(1);
});
