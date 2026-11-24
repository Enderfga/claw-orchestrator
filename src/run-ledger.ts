/**
 * Run ledger — a durable, append-only record of every turn this runtime executes.
 *
 * Why this exists: `SessionStats` (cost, tokens, turns) lives in memory and dies
 * with the process, and per-session history is capped at MAX_HISTORY_ITEMS and
 * evicted. So until now nothing survived a restart except the resume-id registry
 * — there was no way to answer "what did we run today, on which engine, for how
 * much". The ledger is that record.
 *
 * As of 6.0.0 it is also usable as a routing signal, which it was not before: a
 * row's `ok` is the engine's report on itself, and no amount of that teaches you
 * which engine is actually better at a task. `verified` is the runtime's own
 * measurement against an acceptance contract, and that is the column a router
 * can learn from. Rows carry both, and the read surfaces keep them apart.
 *
 * Durability rules, copied from the pattern autoloop's dispatcher already proved
 * (`appendDecisionLog`): mkdir + append + swallow. A ledger failure must never
 * break the turn it is describing.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Logger } from './logger.js';
import type { EngineType } from './types.js';

// ─── Row shape ──────────────────────────────────────────────────────────────

export interface RunLedgerRow {
  /** ISO timestamp of turn completion. */
  ts: string;
  /** SessionManager session name. */
  session: string;
  engine: EngineType;
  /** Resolved model, when the session has one. */
  model?: string;
  cwd: string;
  /** 1-based index of this send within the session, as counted by the process that recorded it. */
  turn: number;
  /** Per-turn deltas, not session totals. */
  tokensIn: number;
  tokensOut: number;
  cachedTokens: number;
  costUsd: number;
  /**
   * True when the engine did not report usage for this turn and the numbers came
   * from estimateTokens(). Cost derived from an estimate is an estimate — the
   * read surfaces must keep saying so rather than presenting it as measured.
   */
  tokensEstimated: boolean;
  durationMs: number;
  toolCalls: number;
  toolErrors: number;
  /**
   * The engine's own terminal verdict for this turn — it ran and did not report
   * failure. Distinct from `verified`: this is the engine talking about itself.
   */
  ok: boolean;
  error?: string;
  /** The model refused and the engine re-ran this turn on another one (Claude's refusal fallback). */
  refusalFallback?: { from: string; to: string; category?: string };
  /** council id / fanout id / autoloop run id / workflow run id, when this turn belongs to one. */
  parent?: string;

  // ─── Verification (v6) ────────────────────────────────────────────────────
  // Every field below is optional and absent on rows written before 6.0.0. The
  // reader already tolerates unknown and missing keys, so old shards stay
  // readable; nothing backfills them, because we cannot know retroactively.

  /**
   * True when an acceptance contract ran against the work this turn belonged to
   * and every required check passed. Absent means no contract was declared —
   * which is *not* the same as false, and the read surfaces must not collapse
   * the two. `ok` is the engine's self-report; this is our own measurement.
   *
   * Not written at turn time, and deliberately so: a turn finishes before the
   * verifier runs, so stamping a verdict there would be inventing one. It is
   * filled in by `annotateVerdicts()` at read time from the run record. A
   * standalone `verify_run` writes an evidence bundle, not a ledger row.
   */
  verified?: boolean;
  /** Evidence bundle id under the run directory, when a contract ran. */
  evidenceId?: string;
  contractId?: string;
  /** The kind of node this turn belonged to, when the caller said. Only fan-out does (`fanout`). */
  nodeKind?: string;
  /** Primary language detected from the repo's manifest. Detected, never guessed from prose. */
  repoLang?: string;
  /** Caller-declared task class. Never inferred — an inferred label is not a label. */
  taskKind?: string;
}

export interface RunLedgerQuery {
  /** Epoch ms, ISO string, or a relative spec like "24h" / "7d" / "90m". */
  since?: string | number;
  session?: string;
  engine?: string;
  parent?: string;
  /** `true` keeps only verified rows, `false` keeps only refuted ones. Unset keeps all. */
  verified?: boolean;
  /** Most recent N rows (applied after filtering). Default 200. */
  limit?: number;
}

export interface RunLedgerSummary {
  rows: number;
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  /** Rows whose token counts were estimated rather than engine-reported. */
  estimatedRows: number;
  /** Rows an acceptance contract passed. */
  verifiedRows: number;
  /** Rows an acceptance contract refuted. */
  refutedRows: number;
  /** Rows with no contract at all — we do not know either way. */
  unverifiedRows: number;
  byEngine: Record<string, { rows: number; costUsd: number }>;
}

// ─── Location ───────────────────────────────────────────────────────────────

/**
 * Ledger directory. Shards are one file per UTC day; queries always filter on
 * the row timestamp, so the shard boundary is a storage detail, not a semantic
 * one. Nothing here prunes old shards — a row is ~250 bytes and deleting a
 * user's cost history is not ours to do automatically.
 */
export function runsDir(): string {
  return process.env.CLAWO_RUNS_DIR || path.join(os.homedir(), '.claw-orchestrator', 'runs');
}

function shardFor(ts: string): string {
  const day = (ts.length >= 10 ? ts.slice(0, 10) : new Date().toISOString().slice(0, 10)).replace(/[^0-9-]/g, '');
  return path.join(runsDir(), `${day}.jsonl`);
}

// ─── Write ──────────────────────────────────────────────────────────────────

/**
 * Append one row. Best-effort by contract: any I/O failure is logged at warn and
 * swallowed. Callers must not wrap this in error handling that changes turn flow.
 */
export function appendRunRow(row: RunLedgerRow, logger?: Logger): void {
  try {
    const file = shardFor(row.ts);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(row) + '\n');
  } catch (err) {
    logger?.warn?.(`[run-ledger] append failed: ${(err as Error).message}`);
  }
}

// ─── Read ───────────────────────────────────────────────────────────────────

const RELATIVE_SINCE = /^(\d+(?:\.\d+)?)\s*(m|h|d|w)$/i;
const UNIT_MS: Record<string, number> = {
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

/**
 * Resolve a `since` spec to epoch ms. Accepts epoch ms, an ISO timestamp, or a
 * relative window ("30m", "24h", "7d", "2w"). Returns undefined when the spec is
 * absent or unparseable — an unreadable filter must widen the query, never
 * silently narrow it to nothing.
 */
export function parseSince(spec: string | number | undefined, now = Date.now()): number | undefined {
  if (spec === undefined || spec === null || spec === '') return undefined;
  if (typeof spec === 'number') return Number.isFinite(spec) ? spec : undefined;
  const trimmed = spec.trim();
  const rel = RELATIVE_SINCE.exec(trimmed);
  if (rel) return now - Number(rel[1]) * UNIT_MS[rel[2].toLowerCase()];
  const numeric = Number(trimmed);
  if (Number.isFinite(numeric) && /^\d+$/.test(trimmed)) return numeric;
  const parsed = Date.parse(trimmed);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function listShardsNewestFirst(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

/**
 * Read rows newest-first, filter, and return them oldest-first (reading order).
 * Malformed lines are skipped individually — one corrupt row must not make the
 * whole ledger unreadable.
 */
export function readRunLedger(query: RunLedgerQuery = {}, logger?: Logger): RunLedgerRow[] {
  const dir = runsDir();
  const since = parseSince(query.since);
  const limit = query.limit && query.limit > 0 ? query.limit : 200;
  const out: RunLedgerRow[] = [];

  for (const shard of listShardsNewestFirst(dir)) {
    // A UTC-day shard can only hold rows before its own end; once the whole
    // shard predates `since` there is nothing older worth opening.
    if (since !== undefined) {
      const shardEnd = Date.parse(`${shard.slice(0, 10)}T23:59:59.999Z`);
      if (!Number.isNaN(shardEnd) && shardEnd < since) break;
    }
    let raw: string;
    try {
      raw = fs.readFileSync(path.join(dir, shard), 'utf8');
    } catch (err) {
      logger?.warn?.(`[run-ledger] read failed for ${shard}: ${(err as Error).message}`);
      continue;
    }
    const lines = raw.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      let row: RunLedgerRow;
      try {
        row = JSON.parse(line) as RunLedgerRow;
      } catch {
        continue;
      }
      if (!row || typeof row.ts !== 'string' || typeof row.session !== 'string') continue;
      if (since !== undefined) {
        const at = Date.parse(row.ts);
        if (Number.isNaN(at) || at < since) continue;
      }
      if (query.session && row.session !== query.session) continue;
      if (query.engine && row.engine !== query.engine) continue;
      if (query.parent && row.parent !== query.parent) continue;
      if (query.verified !== undefined && row.verified !== query.verified) continue;
      out.push(row);
      if (out.length >= limit) return out.reverse();
    }
  }
  return out.reverse();
}

// ─── Verdict join ───────────────────────────────────────────────────────────

/** What a row's parent run says about it. Supplied by the caller so the ledger stays leaf-level. */
export interface RunVerdict {
  verified?: boolean;
  evidenceId?: string;
  contractId?: string;
}

export type VerdictLookup = (parent: string) => RunVerdict | undefined;

/**
 * Fill in each row's verdict from the run it belonged to.
 *
 * The join lives here rather than at write time because of the ordering: the
 * turns that produce the work all finish before the verifier that judges it, so
 * there is nothing truthful to stamp on them as they are written. The lookup is
 * injected rather than imported so this module keeps no dependency on the kernel.
 */
export function annotateVerdicts(rows: RunLedgerRow[], lookup: VerdictLookup): RunLedgerRow[] {
  const cache = new Map<string, RunVerdict | undefined>();
  return rows.map((row) => {
    if (!row.parent || row.verified !== undefined) return row;
    if (!cache.has(row.parent)) cache.set(row.parent, lookup(row.parent));
    const verdict = cache.get(row.parent);
    return verdict ? { ...row, ...verdict } : row;
  });
}

// ─── Aggregate + format (pure) ──────────────────────────────────────────────

export function summarizeRuns(rows: RunLedgerRow[]): RunLedgerSummary {
  const summary: RunLedgerSummary = {
    rows: rows.length,
    costUsd: 0,
    tokensIn: 0,
    tokensOut: 0,
    estimatedRows: 0,
    verifiedRows: 0,
    refutedRows: 0,
    unverifiedRows: 0,
    byEngine: {},
  };
  for (const r of rows) {
    summary.costUsd += r.costUsd || 0;
    summary.tokensIn += r.tokensIn || 0;
    summary.tokensOut += r.tokensOut || 0;
    if (r.tokensEstimated) summary.estimatedRows++;
    if (r.verified === true) summary.verifiedRows++;
    else if (r.verified === false) summary.refutedRows++;
    else summary.unverifiedRows++;
    const bucket = (summary.byEngine[r.engine] ??= { rows: 0, costUsd: 0 });
    bucket.rows++;
    bucket.costUsd = round4(bucket.costUsd + (r.costUsd || 0));
  }
  summary.costUsd = round4(summary.costUsd);
  return summary;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function pad(s: string, width: number): string {
  return s.length >= width ? s.slice(0, width) : s + ' '.repeat(width - s.length);
}

/** Render rows as a fixed-width table for the CLI. Pure — no I/O. */
export function formatRunTable(rows: RunLedgerRow[]): string {
  if (rows.length === 0) return 'No runs recorded.';
  const header = [
    pad('TIME', 20),
    pad('SESSION', 22),
    pad('ENGINE', 10),
    pad('TURN', 5),
    pad('IN', 9),
    pad('OUT', 9),
    pad('COST', 9),
    pad('DUR', 8),
    pad('VERIFIED', 9),
    'STATUS',
  ].join(' ');
  const lines = rows.map((r) => {
    const cost = `$${(r.costUsd || 0).toFixed(4)}${r.tokensEstimated ? '~' : ''}`;
    const dur = `${Math.round((r.durationMs || 0) / 100) / 10}s`;
    return [
      pad(r.ts.replace('T', ' ').slice(0, 19), 20),
      pad(r.session, 22),
      pad(r.engine, 10),
      pad(String(r.turn ?? ''), 5),
      pad(String(r.tokensIn ?? 0), 9),
      pad(String(r.tokensOut ?? 0), 9),
      pad(cost, 9),
      pad(dur, 8),
      // Three states, not two: `—` means no contract was declared, which is a
      // different claim from `no`. Collapsing them would let an unchecked run
      // read as a checked-and-failed one, or worse, the reverse.
      pad(r.verified === undefined ? '—' : r.verified ? 'yes' : 'NO', 9),
      // `ok: false` does not imply error text: a turn the engine declined to count as
      // succeeded (codex-app `interrupted`, agy's non-SUCCESS status) resolves without
      // throwing, so there is nothing to quote. Say so rather than print a bare label.
      r.ok ? 'ok' : r.error ? `error: ${r.error.slice(0, 60)}` : 'not counted as succeeded',
    ].join(' ');
  });
  const s = summarizeRuns(rows);
  const engines = Object.entries(s.byEngine)
    .map(([e, v]) => `${e} $${v.costUsd.toFixed(4)} (${v.rows})`)
    .join('  ');
  const footer =
    `\n${s.rows} turns  $${s.costUsd.toFixed(4)}  ` +
    `${s.tokensIn} in / ${s.tokensOut} out\n${engines}` +
    (s.verifiedRows + s.refutedRows > 0
      ? `\nverified ${s.verifiedRows} · refuted ${s.refutedRows} · unchecked ${s.unverifiedRows}`
      : `\n${s.unverifiedRows} turn(s) ran with no acceptance contract — unchecked, not passed.`) +
    (s.estimatedRows > 0
      ? `\n~ ${s.estimatedRows} turn(s) used estimated token counts (engine reported no usage).`
      : '');
  return [header, ...lines].join('\n') + footer;
}

// ─── One row per run ────────────────────────────────────────────────────────
//
// Turn rows say what each session spent; they cannot say whether the work was
// any good, nor which runs a model took part in. A run row can: it is written
// once as a workflow run ends, with the run's verdict and its spend split by
// engine and model, so success and cost can be compared per model across runs.
// Kept in `outcomes/` beside the turn shards, which the turn reader never opens.

/** What one engine/model spent in a run. */
export interface RunAgentSpend {
  engine: string;
  /** The model that answered; absent when the engine used its default and did not name it. */
  model?: string;
  costUsd: number;
  /** Turns recorded for it; a goal counts as one. */
  turns: number;
}

export interface RunOutcomeRow {
  /** When the run ended. */
  ts: string;
  runId: string;
  workflow: string;
  state: string;
  /** `verified` / `refuted` / `unverified` — a run with no contract is unverified, not failed. */
  outcome: string;
  costUsd: number;
  durationMs: number;
  cwd: string;
  /** Spend by engine and model, from the run's turns and its goals. */
  agents: RunAgentSpend[];
  error?: string;
  contractId?: string;
  evidenceId?: string;
  /** The local branch the run's work was saved to, when it ran in a worktree of its own. */
  branch?: string;
}

export type RunOutcomeGrouping = 'model' | 'engine' | 'workflow';

export interface RunOutcomeGroup {
  key: string;
  runs: number;
  verified: number;
  refuted: number;
  /** Runs with no acceptance contract: nothing was checked. */
  unverified: number;
  /** Runs that did not complete (failed or cancelled), whatever their verdict. */
  notCompleted: number;
  /** verified / (verified + refuted); undefined when no run in the group was checked. */
  verifiedRate?: number;
  costUsd: number;
  /** Total cost over verified runs; undefined with none verified. */
  costPerVerified?: number;
  medianDurationMs: number;
}

function outcomesDir(): string {
  return path.join(runsDir(), 'outcomes');
}

/** Best-effort, like `appendRunRow`: a ledger failure never touches the run. */
export function appendRunOutcome(row: RunOutcomeRow, logger?: Logger): void {
  try {
    const day = row.ts.slice(0, 10).replace(/[^0-9-]/g, '');
    const file = path.join(outcomesDir(), `${day}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(row) + '\n');
  } catch (err) {
    logger?.warn?.(`[run-ledger] run row append failed: ${(err as Error).message}`);
  }
}

/** Spend by engine and model from a run's turn rows. */
export function spendFromTurns(rows: RunLedgerRow[]): RunAgentSpend[] {
  const by = new Map<string, RunAgentSpend>();
  for (const r of rows) {
    const key = `${r.engine}|${r.model ?? ''}`;
    const s = by.get(key) ?? { engine: r.engine, ...(r.model ? { model: r.model } : {}), costUsd: 0, turns: 0 };
    s.costUsd = round4(s.costUsd + (r.costUsd || 0));
    s.turns++;
    by.set(key, s);
  }
  return [...by.values()];
}

/**
 * Run rows, oldest first. A run that ended, was resumed and ended again has a row
 * for each end; only its latest counts.
 */
export function readRunOutcomes(
  query: { since?: string | number; workflow?: string; limit?: number } = {},
  logger?: Logger,
): RunOutcomeRow[] {
  const dir = outcomesDir();
  const since = parseSince(query.since);
  const latest = new Map<string, RunOutcomeRow>();
  for (const shard of listShardsNewestFirst(dir)) {
    if (since !== undefined) {
      const shardEnd = Date.parse(`${shard.slice(0, 10)}T23:59:59.999Z`);
      if (!Number.isNaN(shardEnd) && shardEnd < since) break;
    }
    let raw: string;
    try {
      raw = fs.readFileSync(path.join(dir, shard), 'utf8');
    } catch (err) {
      logger?.warn?.(`[run-ledger] read failed for outcomes/${shard}: ${(err as Error).message}`);
      continue;
    }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let row: RunOutcomeRow;
      try {
        row = JSON.parse(line) as RunOutcomeRow;
      } catch {
        continue;
      }
      if (!row || typeof row.runId !== 'string' || typeof row.ts !== 'string' || !Array.isArray(row.agents)) continue;
      const prev = latest.get(row.runId);
      if (!prev || prev.ts <= row.ts) latest.set(row.runId, row);
    }
  }
  let rows = [...latest.values()].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  if (since !== undefined) rows = rows.filter((r) => Date.parse(r.ts) >= since);
  if (query.workflow) rows = rows.filter((r) => r.workflow === query.workflow);
  const limit = query.limit && query.limit > 0 ? query.limit : undefined;
  return limit ? rows.slice(-limit) : rows;
}

/**
 * The group a run belongs to. By model, a run is keyed by every engine/model
 * that spent in it (`claude:opus + codex:gpt-6.1-terra`): a run is not split
 * between the models that took part, and none is picked as the one that did
 * the work.
 */
export function outcomeKey(row: RunOutcomeRow, by: RunOutcomeGrouping): string {
  if (by === 'workflow') return row.workflow;
  const parts = new Set(row.agents.map((a) => (by === 'engine' ? a.engine : `${a.engine}:${a.model ?? 'default'}`)));
  return parts.size ? [...parts].sort().join(' + ') : '(no agent turns)';
}

export function groupRunOutcomes(rows: RunOutcomeRow[], by: RunOutcomeGrouping): RunOutcomeGroup[] {
  const groups = new Map<string, RunOutcomeRow[]>();
  for (const r of rows) {
    const k = outcomeKey(r, by);
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const out: RunOutcomeGroup[] = [];
  for (const [key, rs] of groups) {
    const verified = rs.filter((r) => r.outcome === 'verified').length;
    const refuted = rs.filter((r) => r.outcome === 'refuted').length;
    const costUsd = round4(rs.reduce((s, r) => s + (r.costUsd || 0), 0));
    const durations = rs.map((r) => r.durationMs || 0).sort((a, b) => a - b);
    const mid = durations.length >> 1;
    out.push({
      key,
      runs: rs.length,
      verified,
      refuted,
      unverified: rs.length - verified - refuted,
      notCompleted: rs.filter((r) => r.state !== 'completed').length,
      ...(verified + refuted > 0 ? { verifiedRate: verified / (verified + refuted) } : {}),
      costUsd,
      ...(verified > 0 ? { costPerVerified: round4(costUsd / verified) } : {}),
      medianDurationMs: durations.length % 2 ? durations[mid] : Math.round((durations[mid - 1] + durations[mid]) / 2),
    });
  }
  return out.sort((a, b) => b.runs - a.runs || a.key.localeCompare(b.key));
}

/** Groups as a fixed-width table for the CLI. Pure. */
export function formatOutcomeGroups(groups: RunOutcomeGroup[], by: RunOutcomeGrouping): string {
  if (groups.length === 0) return 'No workflow runs recorded in this window.';
  const width = Math.min(60, Math.max(by.length + 2, ...groups.map((g) => g.key.length + 2)));
  const header = [
    pad(by.toUpperCase(), width),
    pad('RUNS', 5),
    pad('VERIFIED', 9),
    pad('REFUTED', 8),
    pad('UNCHECKED', 10),
    pad('RATE', 6),
    pad('COST', 10),
    pad('$/VERIFIED', 11),
    'MEDIAN',
  ].join(' ');
  const lines = groups.map((g) =>
    [
      pad(g.key, width),
      pad(String(g.runs), 5),
      pad(String(g.verified), 9),
      pad(String(g.refuted), 8),
      pad(String(g.unverified), 10),
      // Over checked runs only: an unchecked run is neither a pass nor a fail.
      pad(g.verifiedRate === undefined ? '—' : `${Math.round(g.verifiedRate * 100)}%`, 6),
      pad(`$${g.costUsd.toFixed(2)}`, 10),
      pad(g.costPerVerified === undefined ? '—' : `$${g.costPerVerified.toFixed(2)}`, 11),
      `${Math.round(g.medianDurationMs / 1000)}s`,
    ].join(' '),
  );
  const notDone = groups.reduce((s, g) => s + g.notCompleted, 0);
  return (
    [header, ...lines].join('\n') +
    '\nRATE is verified / (verified + refuted); unchecked runs had no acceptance contract.' +
    (notDone ? `\n${notDone} run(s) did not complete (failed or cancelled).` : '')
  );
}

/** Run rows as a table for the CLI. Pure. */
export function formatOutcomeRows(rows: RunOutcomeRow[]): string {
  if (rows.length === 0) return 'No workflow runs recorded in this window.';
  const header = [
    pad('ENDED', 20),
    pad('RUN', 22),
    pad('WORKFLOW', 10),
    pad('OUTCOME', 11),
    pad('COST', 9),
    'MODELS',
  ].join(' ');
  const lines = rows.map((r) =>
    [
      pad(r.ts.replace('T', ' ').slice(0, 19), 20),
      pad(r.runId, 22),
      pad(r.workflow, 10),
      pad(r.state === 'completed' ? r.outcome : r.state, 11),
      pad(`$${(r.costUsd || 0).toFixed(4)}`, 9),
      outcomeKey(r, 'model'),
    ].join(' '),
  );
  return [header, ...lines].join('\n');
}
