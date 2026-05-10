/**
 * scripts/smoke-autoloop-v2.ts
 *
 * End-to-end smoke test for autoloop v2 (three-agent architecture).
 *
 *   1. Creates a throwaway workspace at /tmp/autoloop-v2-smoke-<ts>/
 *      with a buggy add_two operator + failing pytest
 *   2. Starts a v2 run (Planner only at first)
 *   3. Chats with Planner; expects Planner to read the workspace, write
 *      plan.md / goal.json, and ask for "go"
 *   4. Sends "go" — Planner should spawn_subagents and send the first
 *      directive
 *   5. Coder fixes the bug, Reviewer audits, iter_done → loop terminates
 *   6. Asserts ledger artifacts (directive.json / diff.patch /
 *      eval_output.json / verdict.json) exist for at least iter 0
 *   7. Writes SMOKE-LOG.md with full transcript
 *
 * Run with:  npx tsx scripts/smoke-autoloop-v2.ts
 *
 * Caps deliberately tight: should converge in ≤3 iters at ~$1-3.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execSync } from 'node:child_process';
import { SessionManager, createConsoleLogger } from '../dist/src/index.js';

function loadClaudeSettingsEnv(): void {
  const p = path.join(os.homedir(), '.claude', 'settings.json');
  if (!fs.existsSync(p)) return;
  try {
    const cfg = JSON.parse(fs.readFileSync(p, 'utf-8')) as { env?: Record<string, string> };
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
const WORKSPACE = `/tmp/autoloop-v2-smoke-${TS}`;
const RUN_ID = `smoke-${TS}`;
const LOG_PATH = path.join(WORKSPACE, 'SMOKE-LOG.md');
const HARD_CAP_MIN = 25;

function log(line: string): void {
  if (fs.existsSync(WORKSPACE)) fs.appendFileSync(LOG_PATH, line + '\n');
  process.stderr.write(line + '\n');
}

function setupWorkspace(): void {
  fs.mkdirSync(WORKSPACE, { recursive: true });
  fs.writeFileSync(path.join(WORKSPACE, 'app.py'), `def add_two(x):\n    return x - 2\n`);
  fs.writeFileSync(
    path.join(WORKSPACE, 'test_app.py'),
    `from app import add_two\n\ndef test_pos():\n    assert add_two(3) == 5\n\ndef test_zero():\n    assert add_two(0) == 2\n\ndef test_neg():\n    assert add_two(-5) == -3\n`,
  );
  // README so Planner has something narrative to read first.
  fs.writeFileSync(
    path.join(WORKSPACE, 'README.md'),
    `# add_two smoke\n\nA toy module with a single \`add_two(x)\` function. The tests in test_app.py are correct; the implementation has a bug. Goal: fix \`add_two\` so all three tests pass.\n`,
  );
  // Eval helper — Coder runs this; output line "metric=<n>" is what we extract.
  fs.writeFileSync(
    path.join(WORKSPACE, 'eval.sh'),
    `#!/usr/bin/env bash\nset -uo pipefail\ncd "$(dirname "$0")"\nresult=$(python3 -m pytest test_app.py -q 2>&1 || true)\npassed=$(echo "$result" | grep -oE '([0-9]+) passed' | grep -oE '[0-9]+' | head -1 || echo 0)\nfailed=$(echo "$result" | grep -oE '([0-9]+) failed' | grep -oE '[0-9]+' | head -1 || echo 0)\ntotal=$((passed + failed))\nif [ "$total" -eq 0 ]; then total=3; fi\nratio=$(python3 -c "print($passed/$total)")\necho "metric=$ratio"\n`,
  );
  fs.chmodSync(path.join(WORKSPACE, 'eval.sh'), 0o755);
  execSync('git init -q && git add -A && git commit -qm "initial"', { cwd: WORKSPACE });
  fs.writeFileSync(LOG_PATH, `# autoloop v2 smoke — ${RUN_ID}\n\nworkspace: ${WORKSPACE}\n\n`);
}

async function main(): Promise<number> {
  setupWorkspace();
  log('## phase: setup ✓');

  const manager = new SessionManager({ defaultModel: 'sonnet' }, createConsoleLogger());

  // Hard cap: kill the whole process if the smoke runs too long. Convergence
  // on this trivial scenario should happen well under 25 min.
  const killer = setTimeout(
    () => {
      log(`\n❌ Hard cap of ${HARD_CAP_MIN}m hit — bailing out`);
      process.exit(2);
    },
    HARD_CAP_MIN * 60 * 1000,
  );

  try {
    log('## phase: start');
    const start = await manager.autoloopV2Start({
      runId: RUN_ID,
      workspace: WORKSPACE,
      plannerModel: 'opus',
      sendTimeoutMs: 8 * 60_000,
    });
    log(`run_id=${start.runId} planner=${start.plannerSession}`);

    // Listen for coder/reviewer/planner replies for visibility.
    const ctx = manager.getAutoloopV2(start.runId);
    if (!ctx) throw new Error('no ctx');
    ctx.dispatcher.on('coder_reply', (...args) => log(`\n### coder\n\n${(args[0] as string).slice(0, 1500)}`));
    ctx.dispatcher.on('reviewer_reply', (...args) =>
      log(`\n### reviewer\n\n${(args[0] as string).slice(0, 1500)}`),
    );
    ctx.runner.on('iter_done', (...args) => log(`\n### iter_done: ${JSON.stringify(args[0])}`));

    log('## phase: planner discovery');
    let r = await manager.autoloopV2Chat(
      start.runId,
      `I want to fix the buggy add_two function in this workspace. Read README.md, app.py, test_app.py, and eval.sh. Then design a small autoloop plan: success criteria, gates, constraints. The metric is the test pass rate from eval.sh (output line "metric=<n>", direction=max, target=1.0). When you have written plan.md and goal.json and committed both, ask if I'm ready to spawn subagents. Do not spawn until I say "go".`,
    );
    log(`\n### planner\n\n${r.reply.slice(0, 4000)}`);

    log('## phase: planner approval');
    r = await manager.autoloopV2Chat(
      start.runId,
      `Plan looks good. Go — spawn subagents with an initial directive that targets fixing add_two. coder_model=sonnet, reviewer_model=sonnet.`,
    );
    log(`\n### planner\n\n${r.reply.slice(0, 4000)}`);

    // Wait for the runner to finish iter 0. The chat above kicks off the loop;
    // we poll state until status changes to terminated, or we see a verdict
    // file for iter 0.
    log('## phase: waiting for first iter');
    const start_t = Date.now();
    while (Date.now() - start_t < 15 * 60_000) {
      const state = manager.autoloopV2Status(start.runId);
      if (!state) break;
      if (state.status === 'terminated') {
        log(`run terminated: ${state.status_reason ?? '(no reason)'}`);
        break;
      }
      const verdict0 = path.join(WORKSPACE, 'tasks', RUN_ID, 'iter', '0', 'verdict.json');
      if (fs.existsSync(verdict0)) {
        log('iter 0 verdict written ✓');
        break;
      }
      await new Promise((r) => setTimeout(r, 5_000));
    }

    // Final assertions.
    log('\n## phase: assertions');
    const iter0 = path.join(WORKSPACE, 'tasks', RUN_ID, 'iter', '0');
    const checks: Array<[string, boolean]> = [
      ['plan.md committed', fs.existsSync(path.join(WORKSPACE, 'plan.md'))],
      ['goal.json committed', fs.existsSync(path.join(WORKSPACE, 'goal.json'))],
      ['iter 0 directive.json', fs.existsSync(path.join(iter0, 'directive.json'))],
      ['iter 0 eval_output.json', fs.existsSync(path.join(iter0, 'eval_output.json'))],
      ['iter 0 diff.patch', fs.existsSync(path.join(iter0, 'diff.patch'))],
      ['iter 0 verdict.json', fs.existsSync(path.join(iter0, 'verdict.json'))],
    ];
    let pass = true;
    for (const [name, ok] of checks) {
      log(`  ${ok ? '✓' : '✗'} ${name}`);
      if (!ok) pass = false;
    }

    // Stop run + show final cost.
    await manager.autoloopV2Stop(start.runId, 'smoke-end');
    await manager.shutdown();

    log(`\n${pass ? '## ✅ smoke pass' : '## ❌ smoke FAIL'}`);
    log(`\nshare: cp ${LOG_PATH} /tmp/clawd-share/`);
    return pass ? 0 : 1;
  } finally {
    clearTimeout(killer);
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    log(`\n❌ uncaught: ${(err as Error).stack ?? String(err)}`);
    process.exit(1);
  });
