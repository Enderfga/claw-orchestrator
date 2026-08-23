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
  /** 1-based index of this turn within the session. */
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
   * filled in by `annotateVerdicts()` at read time from the run record, or
   * written directly by a standalone `verify_run`.
   */
  verified?: boolean;
  /** Evidence bundle id under the run directory, when a contract ran. */
  evidenceId?: string;
  contractId?: string;
  /** Kernel node kind this turn belonged to (`agent`, `council`, `verifier`, …). */
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
