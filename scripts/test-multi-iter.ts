/**
 * scripts/test-multi-iter.ts
 *
 * Exercise the multi-iter ratcheting path. Goal: a workspace where
 * gate_completion can advance partially per iter — so we observe ≥2 iters
 * each producing a strictly better best, RATCHET committing both, history.md
 * still empty (compress_every_k=100), final state.json with iter ≥2 and
 * monotonic metric.json.
 *
 * Forcing mechanism: 4 independent gates targeting changes in 4 different
 * files. The propose-prompt's "one hypothesis per iteration" rule biases
 * Sonnet toward fixing one at a time. Even if it batches some, we'll still
 * exercise multi-iter as long as it doesn't one-shot ALL four.
 *
 * Caps: max_iters=8, max_cost_usd=6, sonnet/sonnet, 30 min wall-clock.
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
const WORKSPACE = `/tmp/autoloop-multi-iter-${TS}`;
const LOG_PATH = path.join(WORKSPACE, 'MULTI-ITER-TEST.md');

function log(line: string): void {
  fs.appendFileSync(LOG_PATH, line + '\n');
  process.stderr.write(line + '\n');
}

function setupWorkspace(): void {
  fs.mkdirSync(WORKSPACE, { recursive: true });

  // Four independent buggy files. PROPOSE prompt asks for one hypothesis per iter,
  // so Sonnet should ideally tackle these one at a time.
  fs.writeFileSync(path.join(WORKSPACE, 'add.py'), `def add_two(x):\n    return x - 2\n`); // bug
  fs.writeFileSync(path.join(WORKSPACE, 'mul.py'), `def triple(x):\n    return x + x + x + 1\n`); // bug: + 1 extraneous
  fs.writeFileSync(path.join(WORKSPACE, 'str_utils.py'), `def shout(s):\n    return s.lower()\n`); // bug: should be upper
  fs.writeFileSync(path.join(WORKSPACE, 'list_utils.py'), `def first(xs):\n    return xs[-1]\n`); // bug: should be xs[0]

  fs.writeFileSync(
    path.join(WORKSPACE, 'test_all.py'),
    `from add import add_two
from mul import triple
from str_utils import shout
from list_utils import first

def test_add():    assert add_two(3) == 5
def test_mul():    assert triple(4) == 12
def test_shout():  assert shout('hi') == 'HI'
def test_first():  assert first([10, 20, 30]) == 10
`,
  );

  fs.writeFileSync(
    path.join(WORKSPACE, 'plan.md'),
    `# Plan

There are four independent bugs across four files (\`add.py\`, \`mul.py\`, \`str_utils.py\`, \`list_utils.py\`). Each has its own pytest function in \`test_all.py\`. Make all tests pass.

## Strategy hint

Per the autoloop charter you should change ONE file per iteration. Pick the bug whose fix you are most confident about, fix it, let RATCHET ratchet, then the next iter pick the next bug.

## Scope (HARD)

- Read-only: \`test_all.py\`. Never modify or delete.
- Allowed paths to write: \`add.py\`, \`mul.py\`, \`str_utils.py\`, \`list_utils.py\`, and \`tasks/<id>/current.md\`.
- No new files in workspace root beyond what's listed above.
`,
  );

  // 4 separate gates — one per file's tests. gate_completion ramps 0 → 0.25 → 0.5 → 0.75 → 1.0.
  const goal = {
    gates: [
      {
        name: 'test_add_passes',
        cmd: 'python3 -m pytest -q test_all.py::test_add',
        must: 'exit-0',
        timeout_sec: 30,
      },
      {
        name: 'test_mul_passes',
        cmd: 'python3 -m pytest -q test_all.py::test_mul',
        must: 'exit-0',
        timeout_sec: 30,
      },
      {
        name: 'test_shout_passes',
        cmd: 'python3 -m pytest -q test_all.py::test_shout',
        must: 'exit-0',
        timeout_sec: 30,
      },
      {
        name: 'test_first_passes',
        cmd: 'python3 -m pytest -q test_all.py::test_first',
        must: 'exit-0',
        timeout_sec: 30,
      },
    ],
    termination: {
      scalar_target_hit: true,
      max_iters: 8,
      plateau_iters: 3,
      max_cost_usd: 6,
      max_pending_aspirational: 0,
    },
  };
  fs.writeFileSync(path.join(WORKSPACE, 'goal.json'), JSON.stringify(goal, null, 2));

  execSync(
    'git init -q && git add -A && git -c user.email=t@t -c user.name=t commit -qm initial',
    { cwd: WORKSPACE },
  );

  fs.writeFileSync(LOG_PATH, `# Multi-iter Test — ${TS}\n\n`);
  log(`## Setup\n- Workspace: \`${WORKSPACE}\`\n- 4 files × 1 bug each, 4 separate pytest gates\n`);
}

async function main(): Promise<void> {
  setupWorkspace();

  const logger = createConsoleLogger('test-multi-iter');
  const manager = new SessionManager({});
  const config: AutoloopConfig = {
    workspace: WORKSPACE,
    plan_path: path.join(WORKSPACE, 'plan.md'),
    goal_path: path.join(WORKSPACE, 'goal.json'),
    task_id: 'multi',
    propose_engine: 'claude',
    propose_model: 'sonnet',
    ratchet_engine: 'claude',
    ratchet_model: 'sonnet',
    compress_every_k: 100,
    push_cmd: null,
  };

  const runner = new AutoloopRunner(manager, config, logger);

  log(`\n## Event Stream\n`);
  runner.on('phase', (e) => {
    const ev = e as { phase: string; iter: number };
    log(`- phase=${ev.phase} iter=${ev.iter}  (\`${new Date().toISOString()}\`)`);
  });
  runner.on('state', (s) => {
    const st = s as Record<string, unknown>;
    const best = st.best as { metric: number; iter: number } | null;
    log(
      `  - state: phase=${String(st.phase)} iter=${String(st.iter)} best=${best ? `iter${best.iter}@${best.metric}` : 'null'} cost=$${(Number(st.cost_usd_so_far) || 0).toFixed(4)}`,
    );
  });
  runner.on('push', (p) => {
    const pe = p as { kind: string; text: string };
    log(`- 📨 ${pe.kind}: ${pe.text.replace(/\n/g, ' ').slice(0, 200)}`);
  });
  runner.on('terminated', (t) => {
    const te = t as { reason: string };
    log(`- ✅ terminated: ${te.reason}`);
  });

  const deadline = Date.now() + 30 * 60 * 1000;
  await runner.start();

  while (Date.now() < deadline) {
    const h = runner.handle();
    if (h.status === 'completed' || h.status === 'error' || h.status === 'stopped') break;
    await new Promise((r) => setTimeout(r, 5000));
  }

  const finalH = runner.handle();
  log(`\n## Final\n\n\`\`\`json\n${JSON.stringify(finalH, null, 2)}\n\`\`\``);

  // metric.json — should show monotonic ramp.
  try {
    const m = fs.readFileSync(path.join(WORKSPACE, 'tasks', 'multi', 'metric.json'), 'utf-8');
    log(`\n### metric.json (expect monotonic ramp)\n\n\`\`\`json\n${m}\n\`\`\``);
  } catch {
    log(`\n_no metric.json_`);
  }

  // git log on autoloop branch — count commits.
  let commitsBlock = '';
  try {
    commitsBlock = execSync('git log --oneline autoloop/multi', { cwd: WORKSPACE, encoding: 'utf-8' });
    log(`\n### Commits on autoloop/multi\n\n\`\`\`\n${commitsBlock}\n\`\`\``);
  } catch {
    log('_no autoloop branch_');
  }

  // Final pytest.
  let pytestPassed = false;
  try {
    execSync('python3 -m pytest -q test_all.py', { cwd: WORKSPACE, stdio: 'pipe' });
    pytestPassed = true;
  } catch {
    /* */
  }
  log(`\n### Final pytest: ${pytestPassed ? '✅ all 4 passing' : '❌ failures remain'}`);

  // Validation:
  // - status === 'completed'
  // - final iter >= 2 (multi-iter actually exercised)
  // - all pytest passing
  // - commits on autoloop branch >= bootstrap + 2 propose commits
  let assertions = 0;
  let passed = 0;
  const assert = (label: string, ok: boolean): void => {
    assertions++;
    if (ok) passed++;
    log(`- ${ok ? '✅' : '❌'} ${label}`);
  };

  log(`\n## Assertions\n`);
  assert('status === completed', finalH.status === 'completed');
  assert('pytest passes (all 4 tests)', pytestPassed);
  assert('iter >= 2 (multi-iter exercised)', (finalH.current_iter ?? 0) >= 2);
  const proposeCommits = (commitsBlock.match(/autoloop\(iter-/g) || []).length;
  assert(`autoloop branch has ≥2 propose commits (got ${proposeCommits})`, proposeCommits >= 2);

  await manager.shutdown();
  log(`\n## Result: ${passed}/${assertions} assertions passed`);
  if (passed < assertions) {
    process.stderr.write(`\nMULTI-ITER TEST FAILED: ${LOG_PATH}\n`);
    process.exit(1);
  }
  process.stderr.write(`\n=== MULTI-ITER TEST PASSED ===\nLog: ${LOG_PATH}\n`);
}

main().catch((err) => {
  log(`\n## ❌ FATAL\n\n\`\`\`\n${err instanceof Error ? err.stack || err.message : String(err)}\n\`\`\``);
  process.stderr.write(`\nMULTI-ITER TEST FAILED: ${LOG_PATH}\n`);
  process.exit(1);
});
