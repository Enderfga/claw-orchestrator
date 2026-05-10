/**
 * scripts/smoke-autoloop.ts
 *
 * End-to-end smoke test for the autoloop feature.
 *
 * - Creates a throwaway workspace at /tmp/autoloop-smoke-<ts>/
 * - Initializes it as a git repo with a buggy Python file + failing pytest
 * - Runs the autoloop until termination (or hard cap)
 * - Writes a SMOKE-LOG.md with every phase / push / state event
 * - Prints the log path so the user can read it
 *
 * Run with:  npx tsx scripts/smoke-autoloop.ts
 *
 * Caps are deliberately tight so this runs in ~5-15 min and costs <$5.
 * Uses sonnet/sonnet for both propose and ratchet — the goal here is to
 * validate the wiring, not to evaluate model quality.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execSync } from 'node:child_process';
import { SessionManager, AutoloopRunner } from '../dist/src/index.js';
import type { AutoloopConfig } from '../dist/src/index.js';
import { createConsoleLogger } from '../dist/src/index.js';

// Inject env vars from ~/.claude/settings.json into our process.env so the
// child claude subprocesses spawned by SessionManager inherit them. Claude
// itself loads settings.json on interactive launch but does not export those
// vars to subprocess descendants.
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
const WORKSPACE = `/tmp/autoloop-smoke-${TS}`;
const LOG_PATH = path.join(WORKSPACE, 'SMOKE-LOG.md');

function log(line: string): void {
  fs.appendFileSync(LOG_PATH, line + '\n');
  // Mirror to stderr for live visibility.
  process.stderr.write(line + '\n');
}

function setupWorkspace(): void {
  fs.mkdirSync(WORKSPACE, { recursive: true });

  // Buggy add_two: returns x - 2 instead of x + 2. The propose agent must fix it.
  fs.writeFileSync(
    path.join(WORKSPACE, 'app.py'),
    `def add_two(x):
    return x - 2
`,
  );

  fs.writeFileSync(
    path.join(WORKSPACE, 'test_app.py'),
    `from app import add_two

def test_add_two_positive():
    assert add_two(3) == 5

def test_add_two_zero():
    assert add_two(0) == 2

def test_add_two_negative():
    assert add_two(-5) == -3
`,
  );

  fs.writeFileSync(
    path.join(WORKSPACE, 'plan.md'),
    `# Plan

The function \`add_two\` in \`app.py\` has a bug — it subtracts 2 instead of
adding 2. Fix it so all tests in \`test_app.py\` pass.

Constraints:
- Do not modify \`test_app.py\`.
- Keep the change minimal — fix the operator only.
`,
  );

  const goal = {
    gates: [
      {
        name: 'pytest_passes',
        cmd: 'python3 -m pytest -q test_app.py',
        must: 'exit-0',
        timeout_sec: 60,
      },
    ],
    termination: {
      scalar_target_hit: true,
      max_iters: 3,
      plateau_iters: 2,
      max_cost_usd: 5,
      max_pending_aspirational: 0,
    },
  };
  fs.writeFileSync(path.join(WORKSPACE, 'goal.json'), JSON.stringify(goal, null, 2));

  // Initialize git.
  execSync('git init -q && git add -A && git -c user.email=smoke@test -c user.name=Smoke commit -qm initial', {
    cwd: WORKSPACE,
  });

  // Verify the test fails initially (sanity check).
  let initialFailed = false;
  try {
    execSync('python3 -m pytest -q test_app.py', { cwd: WORKSPACE, stdio: 'pipe' });
  } catch {
    initialFailed = true;
  }

  fs.writeFileSync(LOG_PATH, `# Autoloop Smoke Run — ${TS}\n\n`);
  log(`## Setup\n`);
  log(`- Workspace: \`${WORKSPACE}\``);
  log(`- Buggy file: \`app.py\` (returns \`x - 2\` instead of \`x + 2\`)`);
  log(`- Test file: \`test_app.py\` (3 tests, all currently failing)`);
  log(`- Initial pytest expected to fail: **${initialFailed ? 'YES' : 'NO (smoke broken)'}**`);
  if (!initialFailed) {
    throw new Error('Initial test should have failed but passed; smoke setup is broken.');
  }
  log('');
}

async function run(): Promise<void> {
  setupWorkspace();

  const logger = createConsoleLogger('smoke');
  const manager = new SessionManager({});

  // sonnet/sonnet for the smoke — the point is wiring validation, not model eval.
  const config: AutoloopConfig = {
    workspace: WORKSPACE,
    plan_path: path.join(WORKSPACE, 'plan.md'),
    goal_path: path.join(WORKSPACE, 'goal.json'),
    task_id: 'smoke',
    propose_engine: 'claude',
    propose_model: 'sonnet',
    ratchet_engine: 'claude',
    ratchet_model: 'sonnet',
    compress_every_k: 100, // disable for this short run
    per_iter_timeout_ms: 180_000,
    push_cmd: null, // do NOT push wechat; just write inbox.md
  };

  log(`## Config\n`);
  log('```json');
  log(JSON.stringify({ ...config, plan_path: '<path>', goal_path: '<path>' }, null, 2));
  log('```\n');

  const runner = new AutoloopRunner(manager, config, logger);

  log(`## Event Stream\n`);

  runner.on('starting', () => log(`- \`starting\``));
  runner.on('phase', (e) => {
    const ev = e as { phase: string; iter: number };
    log(`- **phase=${ev.phase}** iter=${ev.iter}  (\`${new Date().toISOString()}\`)`);
  });
  runner.on('state', (s) => {
    const st = s as Record<string, unknown>;
    log(
      `  - state: phase=${String(st.phase)} iter=${String(st.iter)} best=${st.best ? `metric=${(st.best as { metric: number }).metric}` : 'null'} cost=$${(Number(st.cost_usd_so_far) || 0).toFixed(4)}`,
    );
  });
  runner.on('push', (p) => {
    const pe = p as { kind: string; text: string };
    log(`- 📨 push **${pe.kind}**: ${pe.text.replace(/\n/g, ' ')}`);
  });
  runner.on('terminated', (t) => {
    const te = t as { reason: string };
    log(`- ✅ **terminated**: ${te.reason}`);
  });
  runner.on('error', (e) => {
    log(`- ❌ **error**: ${e instanceof Error ? e.message : String(e)}`);
  });

  // Hard wall-clock for the smoke itself.
  const deadline = Date.now() + 25 * 60 * 1000;

  await runner.start();

  // Poll until terminated or deadline.
  while (Date.now() < deadline) {
    const h = runner.handle();
    if (h.status === 'completed' || h.status === 'error' || h.status === 'stopped') {
      break;
    }
    await new Promise((r) => setTimeout(r, 5_000));
  }

  if (Date.now() >= deadline) {
    log(`\n## Wall-clock cap hit; calling stop()`);
    await runner.stop();
  }

  // Snapshot final state.
  const finalHandle = runner.handle();
  log(`\n## Final\n`);
  log('```json');
  log(JSON.stringify(finalHandle, null, 2));
  log('```');

  // Read the on-disk state and metric history.
  try {
    const stateJson = fs.readFileSync(path.join(WORKSPACE, 'tasks', 'smoke', 'state.json'), 'utf-8');
    log(`\n### state.json (final)\n\n\`\`\`json\n${stateJson}\n\`\`\``);
  } catch {
    log(`\n_no state.json on disk — runner failed before persisting_`);
  }
  try {
    const metricJson = fs.readFileSync(path.join(WORKSPACE, 'tasks', 'smoke', 'metric.json'), 'utf-8');
    log(`\n### metric.json\n\n\`\`\`json\n${metricJson}\n\`\`\``);
  } catch {
    log(`\n_no metric.json — no MEASURE phase reached_`);
  }

  // Final pytest result on the autoloop branch.
  log(`\n### Final pytest on autoloop branch`);
  try {
    const out = execSync('python3 -m pytest -q test_app.py 2>&1', { cwd: WORKSPACE, encoding: 'utf-8' });
    log('```\n' + out + '\n```');
  } catch (e) {
    const err = e as { stdout?: Buffer; stderr?: Buffer; status?: number };
    log('```\n' + (err.stdout?.toString() || '') + (err.stderr?.toString() || '') + `\n[exit ${err.status}]\n` + '```');
  }

  // Final diff vs initial commit.
  log(`\n### git diff vs initial commit`);
  try {
    const diff = execSync('git diff HEAD~ HEAD -- app.py test_app.py 2>/dev/null || git log --oneline', {
      cwd: WORKSPACE,
      encoding: 'utf-8',
    });
    log('```diff\n' + diff + '\n```');
  } catch {
    log('_no diff available_');
  }

  await manager.shutdown();

  process.stderr.write(`\n\n=== SMOKE COMPLETE ===\nLog: ${LOG_PATH}\nWorkspace: ${WORKSPACE}\n`);
}

run().catch((err) => {
  log(`\n## FATAL\n\n\`\`\`\n${err instanceof Error ? err.stack || err.message : String(err)}\n\`\`\``);
  process.stderr.write(`\nSMOKE FAILED: ${LOG_PATH}\n`);
  process.exit(1);
});
