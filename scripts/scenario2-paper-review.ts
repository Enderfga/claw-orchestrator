/**
 * scripts/scenario2-paper-review.ts
 *
 * End-to-end Scenario 2 run: paper → written report.md + slides.md.
 *
 * - Downloads an arxiv paper PDF, converts to text via pdftotext
 * - Sets up a fresh git workspace at /tmp/autoloop-paper-<id>-<ts>/
 * - Authors plan.md and goal.json with structural gates
 * - Runs AutoloopRunner with sonnet/sonnet, max_iters=8, cap $15
 * - Logs all events + final state + report.md / slides.md previews
 *   to SMOKE-LOG.md
 *
 * Default paper: arxiv:2210.02747 (Lipman et al — Flow Matching).
 * Override with: ARXIV_ID=<id> npx tsx scripts/scenario2-paper-review.ts
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execSync } from 'node:child_process';
import { SessionManager, AutoloopRunner } from '../dist/src/index.js';
import type { AutoloopConfig } from '../dist/src/index.js';
import { createConsoleLogger } from '../dist/src/index.js';

// ─── Inject claude env from settings.json ──────────────────────────────────
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

// ─── Paper + workspace setup ───────────────────────────────────────────────
const ARXIV_ID = process.env.ARXIV_ID || '2210.02747';
const TS = new Date().toISOString().replace(/[:.]/g, '-');
const WORKSPACE = `/tmp/autoloop-paper-${ARXIV_ID}-${TS}`;
const LOG_PATH = path.join(WORKSPACE, 'SMOKE-LOG.md');

function log(line: string): void {
  fs.appendFileSync(LOG_PATH, line + '\n');
  process.stderr.write(line + '\n');
}

function setupWorkspace(): void {
  fs.mkdirSync(WORKSPACE, { recursive: true });

  // Download paper PDF.
  const pdfPath = path.join(WORKSPACE, 'paper.pdf');
  execSync(`curl -fsSL -o "${pdfPath}" "https://arxiv.org/pdf/${ARXIV_ID}.pdf"`, { stdio: 'inherit' });
  // Convert to text.
  execSync(`pdftotext "${pdfPath}" "${path.join(WORKSPACE, 'paper.txt')}"`, { stdio: 'inherit' });

  // plan.md — explicit Scope block tests the new prompt discipline.
  fs.writeFileSync(
    path.join(WORKSPACE, 'plan.md'),
    `# Plan

Produce a written report and slide deck reviewing the paper at \`paper.pdf\` (text already extracted into \`paper.txt\` — read that, not the PDF).

## Deliverables

1. **\`report.md\`** — written report (≥1500 words) with the following sections (exact \`##\` headings):
   - \`## Main Contribution\` — clearly stated, ≥150 words
   - \`## Method\` — high-level explanation of the technical approach
   - \`## Key Results\` — what the paper actually shows empirically
   - \`## Critique\` — ≥3 specific weaknesses or open questions, each justified by reference to a section/equation/figure of the paper
   - \`## Presentation Outline\` — slide-by-slide plan for \`slides.md\`
   - \`## References\` — at least 5 citations in \`[1] Author, ...\` form, each cited at least once in the body

2. **\`slides.md\`** — markdown slide deck (≥8 slides, slides separated by lines containing ONLY \`---\`) covering:
   - Title (paper name + 1-line takeaway)
   - Motivation / problem
   - Main contribution (1-2 slides)
   - Method (2-3 slides — equations welcome, use markdown math)
   - Results (1-2 slides)
   - Critique (1 slide, the strongest point)
   - Conclusion + references

## Scope (HARD constraints — RATCHET will reset on violations)

- **Read-only**: \`paper.pdf\`, \`paper.txt\`. Do NOT modify or delete.
- **Allowed paths to write**: \`report.md\`, \`slides.md\`, \`tasks/<id>/current.md\` only. No other files in workspace root.
- **No external downloads** beyond what BOOTSTRAP set up. The agent has \`paper.txt\` as its input.

## Style

- Technical, neutral, terse. No filler like "this paper is fascinating".
- Every factual claim about the paper must reference a section / equation / figure / table number.
- Slides separated by lines containing exactly \`---\` (no other text on the line).
`,
  );

  // goal.json — gate-driven, no scalar.
  const goal = {
    gates: [
      { name: 'report_exists', cmd: 'test -f report.md', must: 'exit-0', timeout_sec: 5 },
      { name: 'slides_exists', cmd: 'test -f slides.md', must: 'exit-0', timeout_sec: 5 },
      {
        name: 'report_min_1500_words',
        cmd: '[ "$(wc -w < report.md 2>/dev/null || echo 0)" -ge 1500 ]',
        must: 'exit-0',
        timeout_sec: 5,
      },
      {
        name: 'main_contribution_section',
        cmd: "grep -q '^## Main Contribution' report.md",
        must: 'exit-0',
        timeout_sec: 5,
      },
      { name: 'method_section', cmd: "grep -q '^## Method' report.md", must: 'exit-0', timeout_sec: 5 },
      { name: 'key_results_section', cmd: "grep -q '^## Key Results' report.md", must: 'exit-0', timeout_sec: 5 },
      { name: 'critique_section', cmd: "grep -q '^## Critique' report.md", must: 'exit-0', timeout_sec: 5 },
      {
        name: 'presentation_outline_section',
        cmd: "grep -q '^## Presentation Outline' report.md",
        must: 'exit-0',
        timeout_sec: 5,
      },
      { name: 'references_section', cmd: "grep -q '^## References' report.md", must: 'exit-0', timeout_sec: 5 },
      {
        name: 'report_min_5_citations',
        cmd: '[ "$(grep -cE \'^\\[[0-9]+\\]\' report.md 2>/dev/null || echo 0)" -ge 5 ]',
        must: 'exit-0',
        timeout_sec: 5,
      },
      {
        name: 'slides_min_8',
        cmd: '[ "$(grep -cE \'^---[[:space:]]*$\' slides.md 2>/dev/null || echo 0)" -ge 7 ]',
        must: 'exit-0',
        timeout_sec: 5,
      },
    ],
    aspirational_gates: [],
    termination: {
      scalar_target_hit: true,
      max_iters: 8,
      plateau_iters: 3,
      max_cost_usd: 15,
      max_pending_aspirational: 5,
    },
  };
  fs.writeFileSync(path.join(WORKSPACE, 'goal.json'), JSON.stringify(goal, null, 2));

  // Initialize git.
  execSync(
    'git init -q && git add -A && git -c user.email=scenario2@test -c user.name=Scenario2 commit -qm initial',
    { cwd: WORKSPACE },
  );

  // Sanity check: gates should ALL fail at this point (no report.md / slides.md yet).
  let initialGatesPassed = 0;
  for (const g of goal.gates) {
    try {
      execSync(g.cmd, { cwd: WORKSPACE, stdio: 'pipe' });
      initialGatesPassed++;
    } catch {
      // expected
    }
  }

  fs.writeFileSync(LOG_PATH, `# Scenario 2 — Paper Review (autoloop) — ${TS}\n\n`);
  log(`## Setup\n`);
  log(`- Paper: arxiv:${ARXIV_ID}`);
  log(`- Workspace: \`${WORKSPACE}\``);
  log(`- paper.txt size: ${fs.statSync(path.join(WORKSPACE, 'paper.txt')).size} bytes`);
  log(`- Goal gates: ${goal.gates.length} structural`);
  log(`- Initial gates passing: ${initialGatesPassed}/${goal.gates.length} (expected 0)`);
  log('');
}

async function run(): Promise<void> {
  setupWorkspace();

  const logger = createConsoleLogger('scenario2');
  const manager = new SessionManager({});

  const config: AutoloopConfig = {
    workspace: WORKSPACE,
    plan_path: path.join(WORKSPACE, 'plan.md'),
    goal_path: path.join(WORKSPACE, 'goal.json'),
    task_id: 'paper-review',
    propose_engine: 'claude',
    propose_model: 'sonnet',
    ratchet_engine: 'claude',
    ratchet_model: 'sonnet',
    compress_every_k: 100,
    per_iter_timeout_ms: 600_000, // 10 min per LLM call
    push_cmd: null, // do NOT push wechat for the smoke; just record to inbox.md
  };

  log(`## Config\n`);
  log('```json');
  log(
    JSON.stringify(
      { ...config, plan_path: '<workspace>/plan.md', goal_path: '<workspace>/goal.json' },
      null,
      2,
    ),
  );
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
    const best = st.best as { metric: number } | null;
    log(
      `  - state: phase=${String(st.phase)} iter=${String(st.iter)} best=${best ? `metric=${best.metric}` : 'null'} cost=$${(Number(st.cost_usd_so_far) || 0).toFixed(4)} plateau=${String(st.plateau_count)}`,
    );
  });
  runner.on('push', (p) => {
    const pe = p as { kind: string; text: string };
    log(`- 📨 push **${pe.kind}**: ${pe.text.replace(/\n/g, ' ').slice(0, 400)}`);
  });
  runner.on('terminated', (t) => {
    const te = t as { reason: string };
    log(`- ✅ **terminated**: ${te.reason}`);
  });
  runner.on('error', (e) => {
    log(`- ❌ **error**: ${e instanceof Error ? e.message : String(e)}`);
  });

  // Hard wall-clock for the whole script.
  const deadline = Date.now() + 60 * 60 * 1000; // 1h max

  await runner.start();

  while (Date.now() < deadline) {
    const h = runner.handle();
    if (h.status === 'completed' || h.status === 'error' || h.status === 'stopped') break;
    await new Promise((r) => setTimeout(r, 10_000));
  }

  if (Date.now() >= deadline) {
    log(`\n## Wall-clock cap hit; stopping`);
    await runner.stop();
  }

  const finalHandle = runner.handle();
  log(`\n## Final\n`);
  log('```json');
  log(JSON.stringify(finalHandle, null, 2));
  log('```');

  // Snapshot key files.
  const snapshot = (file: string, max = 4000): void => {
    try {
      const p = path.join(WORKSPACE, file);
      if (!fs.existsSync(p)) {
        log(`\n_no ${file} on disk_`);
        return;
      }
      const content = fs.readFileSync(p, 'utf-8');
      log(`\n### ${file} (${content.length} chars)\n\n\`\`\`markdown`);
      log(content.length > max ? content.slice(0, max) + '\n\n[... truncated ...]' : content);
      log('```');
    } catch (err) {
      log(`\n_failed to read ${file}: ${err instanceof Error ? err.message : String(err)}_`);
    }
  };
  snapshot('report.md');
  snapshot('slides.md');

  try {
    const stateJson = fs.readFileSync(path.join(WORKSPACE, 'tasks', 'paper-review', 'state.json'), 'utf-8');
    log(`\n### state.json (final)\n\n\`\`\`json\n${stateJson}\n\`\`\``);
  } catch {
    log(`\n_no state.json_`);
  }
  try {
    const metricJson = fs.readFileSync(path.join(WORKSPACE, 'tasks', 'paper-review', 'metric.json'), 'utf-8');
    log(`\n### metric.json\n\n\`\`\`json\n${metricJson}\n\`\`\``);
  } catch {
    log(`\n_no metric.json_`);
  }

  // Final gates re-run.
  log(`\n### Final gate status`);
  try {
    const goalJson = JSON.parse(fs.readFileSync(path.join(WORKSPACE, 'goal.json'), 'utf-8'));
    let pass = 0;
    const lines: string[] = [];
    for (const g of goalJson.gates as { name: string; cmd: string }[]) {
      let ok = false;
      try {
        execSync(g.cmd, { cwd: WORKSPACE, stdio: 'pipe' });
        ok = true;
      } catch {
        ok = false;
      }
      if (ok) pass++;
      lines.push(`- ${ok ? '✅' : '❌'} ${g.name}`);
    }
    log(`Gates passing: ${pass}/${goalJson.gates.length}`);
    for (const l of lines) log(l);
  } catch (err) {
    log(`gate replay failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // git log on autoloop branch.
  log(`\n### Commits on autoloop/paper-review`);
  try {
    const out = execSync('git log --oneline autoloop/paper-review', { cwd: WORKSPACE, encoding: 'utf-8' });
    log('```\n' + out + '\n```');
  } catch {
    log('_no autoloop branch_');
  }

  await manager.shutdown();
  process.stderr.write(`\n\n=== SCENARIO 2 COMPLETE ===\nLog: ${LOG_PATH}\nWorkspace: ${WORKSPACE}\n`);
}

run().catch((err) => {
  log(`\n## FATAL\n\n\`\`\`\n${err instanceof Error ? err.stack || err.message : String(err)}\n\`\`\``);
  process.stderr.write(`\nSCENARIO 2 FAILED: ${LOG_PATH}\n`);
  process.exit(1);
});
