// Turns the recorded runs into data/runs.js for the composition.
// Every number and verdict on screen comes from here; nothing is typed by hand.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';

const DEMO = process.env.DEMO ?? join(process.cwd(), "demo");
const ENGINES = [
  ['claude', 'Claude Code'],
  ['codex', 'Codex'],
  ['agy', 'Antigravity'],
  ['grok', 'Grok Build'],
  ['opencode', 'OpenCode'],
];
const ledger = JSON.parse(readFileSync(join(DEMO, 'json/ledger.json'), 'utf8'));

const serveLog = ['serve.log', 'serve2.log', 'serve3.log', 'serve4.log']
  .map((f) => (existsSync(join(DEMO, f)) ? readFileSync(join(DEMO, f), 'utf8') : ''))
  .join('\n');

function events(runId) {
  return readFileSync(join(DEMO, 'wf', runId, 'events.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

const runs = [];
for (const [engine, label] of ENGINES) {
  for (const take of [1, 2, 3]) {
    const r = JSON.parse(readFileSync(join(DEMO, `json/hero/${engine}-${take}.json`), 'utf8'));
    const ev = events(r.runId);
    const t0 = Date.parse(ev[0].ts);
    const at = (pred) => {
      const e = ev.find(pred);
      return e ? (Date.parse(e.ts) - t0) / 1000 : null;
    };
    const rows = ledger.rows.filter((row) => row.parent === r.runId);
    const triageErr = r.nodes.triage?.data?.results?.[0]?.error;
    // The reason an errored run never reached the checks, from the engine's own
    // stderr in the server log (the wrapper of the day reported it generically).
    const errLine = r.outcome === 'unverified' ? serveLog.split('\n').find((l) => l.includes(r.runId) && /stderr\] Error:/.test(l)) : undefined;
    const errorNote = errLine ? (/usage limit/i.test(errLine) ? 'usage limit' : errLine.replace(/.*Error:\s*/, '').slice(0, 40)) : undefined;
    const agentStepFailed = r.nodes.implement?.state === 'failed' && r.outcome === 'verified';
    runs.push({
      engine,
      label,
      take,
      runId: r.runId,
      state: r.state,
      // A run that never reached the verifier is reported as errored, not as refuted.
      verdict: r.outcome === 'verified' ? 'verified' : r.outcome === 'refuted' ? 'refuted' : 'errored',
      errorNote,
      agentStepFailed,
      triageError: triageErr,
      costUsd: r.costUsd ?? rows.reduce((s, x) => s + (x.costUsd || 0), 0),
      model: rows[0]?.model,
      tVerify: at((e) => e.type === 'node_state' && e.node === 'verify' && e.state === 'running'),
      tEnd: at((e) => e.type === 'run_state' && ['completed', 'failed'].includes(e.state)),
    });
  }
}

const tally = {
  runs: runs.length,
  verified: runs.filter((r) => r.verdict === 'verified').length,
  refuted: runs.filter((r) => r.verdict === 'refuted').length,
  errored: runs.filter((r) => r.verdict === 'errored').length,
};

// The refuted run the film quotes: the agent's own closing claim, and the runtime's evidence.
const quoted = JSON.parse(readFileSync(join(DEMO, 'json/hero/agy-2.json'), 'utf8'));
const evidence = JSON.parse(readFileSync(join(DEMO, 'json/agy-2-evidence.json'), 'utf8'));
const claim = (quoted.nodes.implement.output || '').match(/All tests now pass[^\n]*/)?.[0];
// The agent's closing lines, verbatim: from its "All tests now pass" to the end.
const lastMessage = (quoted.nodes.implement.output || '').slice((quoted.nodes.implement.output || '').indexOf(claim));

// opencode's JSON output does not name the model it ran; its own session
// database does. Read it from there rather than show the ledger's placeholder.
function opencodeModel() {
  try {
    const db = join(homedir(), '.local/share/opencode/opencode.db');
    const sql = `select distinct json_extract(data,'$.modelID') from message where json_extract(data,'$.path.cwd') like '${DEMO}/repos/opencode-%' and json_extract(data,'$.modelID') is not null`;
    return execFileSync('sqlite3', [db, sql], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).join(', ') || undefined;
  } catch {
    return undefined;
  }
}

// Only the turns of the 15 runs shown — the ledger also holds the dry runs and
// the superseded OpenCode takes.
const shown = new Set(runs.map((r) => r.runId));
const perEngine = ENGINES.map(([engine, label]) => {
  const rows = ledger.rows.filter((r) => r.engine === engine && shown.has(r.parent));
  const mine = runs.filter((r) => r.engine === engine);
  return {
    engine,
    label,
    model: engine === 'opencode' ? (opencodeModel() ?? rows[0]?.model) : rows[0]?.model,
    turns: rows.length,
    costUsd: +rows.reduce((s, r) => s + (r.costUsd || 0), 0).toFixed(4),
    verified: mine.filter((r) => r.verdict === 'verified').length,
    refuted: mine.filter((r) => r.verdict === 'refuted').length,
    errored: mine.filter((r) => r.verdict === 'errored').length,
  };
});

// The repair-loop run, read from its own event log: one entry per implement /
// verify visit, in the order they happened.
function repairTrail() {
  const castPath = join(DEMO, 'cast/repair.cast');
  if (!existsSync(castPath)) return null;
  const runId = readFileSync(castPath, 'utf8').match(/wf-[a-z0-9]+-[a-f0-9]+/)?.[0];
  if (!runId || !existsSync(join(DEMO, 'wf', runId, 'events.jsonl'))) return null;
  const ev = events(runId);
  const end = ev.find((e) => e.type === 'run_state' && ['completed', 'failed'].includes(e.state));
  if (!end) return null;
  const trail = [];
  let attempt = 0;
  for (const e of ev) {
    if (e.type !== 'node_state') continue;
    if (e.node === 'implement' && ['succeeded', 'failed'].includes(e.state)) {
      attempt += 1;
      trail.push({ label: 'implement', note: (attempt > 1 ? `attempt ${attempt} · given the failed check` : `attempt ${attempt}`) + (e.state === 'failed' ? ` · ${/Timeout/.test(e.error || '') ? 'timed out' : 'failed'}` : '') });
    }
    if (e.node === 'verify' && ['succeeded', 'failed'].includes(e.state)) {
      trail.push({ label: e.state === 'succeeded' ? 'verify ✓' : 'verify ✗', cls: e.state === 'succeeded' ? 'ok' : 'bad', note: e.state === 'succeeded' ? 'all checks pass' : 'holdout failed' });
    }
  }
  const t0 = Date.parse(ev[0].ts);
  const minutes = Math.round((Date.parse(end.ts) - t0) / 60000);
  trail.push({ label: end.outcome === 'verified' ? 'VERIFIED' : 'REFUTED', cls: end.outcome === 'verified' ? 'ok' : 'bad', note: `${minutes} min, real time` });
  const engine = readFileSync(castPath, 'utf8').match(/--engine (\w+)/)?.[1];
  const first = JSON.parse(readFileSync(join(DEMO, 'wf', runId, 'evidence', 'verify-v01-01', 'bundle.json'), 'utf8'));
  const failed = first.results.find((c) => !c.passed);
  const sentBack = failed ? `${failed.id}: ${(failed.tail || '').match(/applyDiscount\([^\n]*/)?.[0] ?? failed.detail}` : undefined;
  return { runId, engine, outcome: end.outcome, trail, sentBack, note: `clawo solve --engine ${engine} --max-repairs 2   ·   run ${runId}` };
}
const repair = repairTrail();

const data = {
  tally,
  runs,
  perEngine,
  ledgerSummary: { rows: ledger.rows.filter((r) => shown.has(r.parent)).length },
  quoted: {
    runId: quoted.runId,
    engine: 'Antigravity',
    claim,
    lastMessage,
    checks: evidence.results.map((c) => ({ id: c.id, passed: c.passed, detail: c.detail })),
    why: (evidence.results.find((c) => !c.passed)?.tail || '').match(/applyDiscount\([^\n]*/)?.[0],
    changed: evidence.changedFiles.map((f) => `${f.status} +${f.insertions} -${f.deletions} ${f.path}`),
  },
  repair,
};
// The recorded output carries absolute paths under the recording machine's home
// directory. Only that prefix is rewritten, to ~/demo; nothing else is edited.
const json = JSON.stringify(data, null, 2).split(DEMO).join('~/demo');
writeFileSync(new URL('./data/runs.js', import.meta.url), `window.DATA = ${json};\n`);
console.log(JSON.stringify({ tally, perEngine, claim: data.quoted.claim, why: data.quoted.why }, null, 2));
