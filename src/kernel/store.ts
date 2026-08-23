/**
 * Durable run store.
 *
 * Layout, one directory per run under `~/.claw-orchestrator/wf/<runId>/`:
 *
 *   spec.json      the WorkflowSpec, written once at creation, never mutated
 *   run.json       the mutable checkpoint, rewritten atomically on every transition
 *   events.jsonl   append-only audit + stream source
 *   nodes/<id>/    per-node artifacts
 *   evidence/<id>/ evidence bundles (see verify/evidence.ts)
 *
 * Splitting the immutable spec from the mutable checkpoint is what carries crash
 * recovery: if `run.json` is missing or half-written, the state is rebuilt by
 * replaying `events.jsonl` against `spec.json`. The atomic rewrite makes that
 * path rare; the replay makes it usually survivable.
 *
 * Usually, not always, and the reason is worth stating rather than hiding: event
 * appends are best-effort (a log failure is warned and swallowed, because a
 * logging failure must not break the run it describes), yet the replay treats
 * that same log as authoritative when the checkpoint is gone. Those two
 * properties are in tension. In practice the checkpoint is the primary record
 * and the replay is a fallback for the narrow window where it was being
 * rewritten; a run that lost both is unrecoverable and `loadRun` returns
 * undefined rather than inventing a state.
 *
 * The two write helpers here replace four near-identical implementations that
 * had grown across the codebase (`session-manager.ts` sync + async variants,
 * `ultraapp/store.ts`, `ultraapp/patcher.ts`). The tmp-name shape is kept from
 * the ultraapp one, whose comment records the CI bug it fixed: a reader catching
 * a plain `writeFile` mid-flight and parsing a truncated object.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Logger } from '../logger.js';
import type { KernelEvent, NodeRecord, RunRecord, RunState, WorkflowSpec } from './types.js';

export function wfDir(): string {
  return process.env.CLAWO_WF_DIR || path.join(os.homedir(), '.claw-orchestrator', 'wf');
}

/**
 * A run id is a single path segment: letters, digits, dot, dash, underscore.
 *
 * It has to be enforced, not merely expected. A run id can be supplied by the
 * caller — including through a tool call, which means through an agent — and
 * every path in this module is derived from it by `path.join`. `../escaped`
 * resolves outside the store, and `deleteRunDir` is a recursive `rmSync`, so an
 * unvalidated id turns a delete into arbitrary directory removal. A leading dot
 * is refused too, so no id can produce `.` or `..` by itself.
 */
const VALID_RUN_ID = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

export function isValidRunId(runId: string): boolean {
  return typeof runId === 'string' && VALID_RUN_ID.test(runId);
}

/**
 * Resolve a run's directory. Throws on an invalid id rather than returning a
 * path, because this is the chokepoint every other path derives from — checking
 * here means no caller can forget to.
 */
export function runDir(runId: string): string {
  if (!isValidRunId(runId)) {
    throw new Error(
      `Invalid run id ${JSON.stringify(runId)}: must match ${VALID_RUN_ID.source} (a single path segment)`,
    );
  }
  const dir = path.join(wfDir(), runId);
  // Belt to the regex's braces: if any future change to the pattern lets a
  // separator through, this still refuses to hand back a path outside the root.
  const root = wfDir();
  if (path.dirname(dir) !== root) {
    throw new Error(`Invalid run id ${JSON.stringify(runId)}: resolves outside the run store`);
  }
  return dir;
}

export function nodeDir(runId: string, nodeId: string): string {
  return path.join(runDir(runId), 'nodes', nodeId.replace(/[^\w.-]/g, '_'));
}

// ─── Shared write primitives ────────────────────────────────────────────────

/** Write JSON so a concurrent reader sees either the old file or the new one, never a partial. */
export function atomicWriteJson(file: string, value: unknown): void {
  const tmp = `${file}.tmp.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // Nothing to clean up.
    }
    throw err;
  }
}

/** Append one JSONL row. Best-effort: a log failure must never change control flow. */
export function appendJsonl(file: string, value: unknown, logger?: Logger): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(value) + '\n');
  } catch (err) {
    logger?.warn?.(`[kernel-store] append failed for ${path.basename(file)}: ${(err as Error).message}`);
  }
}

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

// ─── Run lifecycle ──────────────────────────────────────────────────────────

export function runExists(runId: string): boolean {
  try {
    return fs.existsSync(path.join(runDir(runId), 'spec.json'));
  } catch {
    return false;
  }
}

/**
 * Create a run's directory. Refuses to reuse an existing run id: overwriting
 * `spec.json` would discard the first run's definition while its `events.jsonl`
 * kept accumulating, leaving one log describing two different runs and a replay
 * that reconstructs neither.
 */
/**
 * Keys whose values never reach disk.
 *
 * `customEngine` carries a `CustomEngineConfig`, whose `env` is explicitly for
 * environment variables — API tokens included. An autoloop started with a custom
 * engine wrote its whole options object into the node spec, and `spec.json`
 * ended up holding the token in plain text.
 *
 * The real fix is to route them through `StartOptions.secrets`, which stays in
 * memory. This is the second line: even a spec that should not contain one is
 * scrubbed on the way out, so a future field cannot leak by omission.
 */
const NEVER_PERSIST = new Set(['customengine', 'plannercustomengine', 'codercustomengine', 'reviewercustomengine']);

export function sanitizeForDisk<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => sanitizeForDisk(v)) as unknown as T;
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (NEVER_PERSIST.has(key.toLowerCase())) continue;
    out[key] = sanitizeForDisk(v);
  }
  return out as unknown as T;
}

export function createRunDir(runId: string, spec: WorkflowSpec): void {
  if (runExists(runId)) {
    throw new Error(`Run '${runId}' already exists — pick another id, or resume it instead of starting over`);
  }
  const dir = runDir(runId);
  fs.mkdirSync(dir, { recursive: true });
  atomicWriteJson(path.join(dir, 'spec.json'), sanitizeForDisk(spec));
}

/**
 * Write a checkpoint.
 *
 * Unguarded on purpose — it is the raw write, and the kernel only ever reaches
 * it through `commit()`, which confirms ownership in the same critical section.
 * Nothing outside the store should call this directly.
 */
export function saveRun(record: RunRecord): void {
  // The checkpoint embeds the spec, so it gets the same scrub.
  atomicWriteJson(path.join(runDir(record.runId), 'run.json'), sanitizeForDisk(record));
}

export function loadSpec(runId: string): WorkflowSpec | undefined {
  // Lookups treat an invalid id as "no such run" rather than throwing: a query
  // for a nonsense id has an answer, and it is "nothing".
  if (!isValidRunId(runId)) return undefined;
  return readJson<WorkflowSpec>(path.join(runDir(runId), 'spec.json'));
}

export function appendEvent(runId: string, event: KernelEvent, logger?: Logger): void {
  if (!isValidRunId(runId)) return;
  appendJsonl(path.join(runDir(runId), 'events.jsonl'), event, logger);
}

export function readEvents(runId: string, limit?: number): KernelEvent[] {
  if (!isValidRunId(runId)) return [];
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(runDir(runId), 'events.jsonl'), 'utf8');
  } catch {
    return [];
  }
  const out: KernelEvent[] = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as KernelEvent);
    } catch {
      // One corrupt line must not make the stream unreadable.
    }
  }
  return limit && limit > 0 ? out.slice(-limit) : out;
}

/**
 * Rebuild a run's state from its spec plus its event log. Used when `run.json`
 * is absent or unparseable — the belt to the atomic rewrite's braces.
 */
export function replayRun(runId: string, spec: WorkflowSpec): RunRecord | undefined {
  const events = readEvents(runId);
  if (events.length === 0) return undefined;

  const nodes: Record<string, NodeRecord> = {};
  for (const n of spec.nodes) {
    nodes[n.id] = { id: n.id, kind: n.kind, state: 'pending', attempts: 0, visits: 0 };
  }

  const created = events.find((e) => e.type === 'run_created');
  const record: RunRecord = {
    runId,
    workflow: spec.name,
    spec,
    state: 'pending',
    outcome: 'unverified',
    cwd: spec.cwd || process.cwd(),
    createdAt: created?.ts ?? events[0].ts,
    updatedAt: events[events.length - 1].ts,
    nodes,
  };

  for (const e of events) {
    switch (e.type) {
      case 'run_state':
        record.state = e.state;
        if (e.outcome) record.outcome = e.outcome;
        if (e.error) record.error = e.error;
        break;
      case 'node_state': {
        const n = (nodes[e.node] ??= { id: e.node, kind: 'agent', state: 'pending', attempts: 0, visits: 0 });
        n.state = e.state;
        if (e.attempt !== undefined) n.attempts = e.attempt;
        if (e.state === 'running') {
          n.visits++;
          n.startedAt = e.ts;
        }
        if (e.state === 'succeeded' || e.state === 'failed' || e.state === 'skipped') n.endedAt = e.ts;
        if (e.error) n.error = e.error;
        record.currentNode = e.node;
        break;
      }
      case 'node_output': {
        const n = nodes[e.node];
        if (n) n.output = e.text;
        break;
      }
      case 'evidence': {
        const n = nodes[e.node];
        if (n) n.evidenceId = e.evidenceId;
        record.evidenceId = e.evidenceId;
        break;
      }
      default:
        break;
    }
    record.updatedAt = e.ts;
  }

  // A run whose process died mid-flight left no terminal event. Say so rather
  // than reporting the stale `running` it was last seen in.
  if (record.state === 'running' || record.state === 'verifying') {
    record.error = record.error ?? 'process ended before the run reached a terminal state';
  }
  return record;
}

/** Load a run, preferring the checkpoint and falling back to an event replay. */
export function loadRun(runId: string): RunRecord | undefined {
  const spec = loadSpec(runId);
  if (!spec) return undefined;
  const checkpoint = readJson<RunRecord>(path.join(runDir(runId), 'run.json'));
  if (checkpoint && checkpoint.runId === runId && checkpoint.nodes) {
    checkpoint.spec = checkpoint.spec ?? spec;
    return checkpoint;
  }
  return replayRun(runId, spec);
}

export function listRunIds(): string[] {
  try {
    return fs
      .readdirSync(wfDir(), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .filter(isValidRunId);
  } catch {
    return [];
  }
}

/**
 * Remove a run's directory. Only ever called from an explicit user delete —
 * nothing in the kernel prunes runs on its own, for the same reason the ledger
 * does not: deleting someone's history is not ours to decide.
 */
export function deleteRunDir(runId: string, logger?: Logger): void {
  // Validate before the try, so a bad id surfaces as an error instead of being
  // swallowed alongside genuine I/O failures. This is a recursive rmSync — the
  // one call in this module where a bad id is not merely wrong but destructive.
  const dir = runDir(runId);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    logger?.warn?.(`[kernel-store] delete failed for ${runId}: ${(err as Error).message}`);
  }
}

/**
 * Full text a node produced, preferring the artifact file over the record's
 * preview. `NodeRecord.output` is capped so a checkpoint stays small, but the
 * whole point of some nodes is their text — an ultraplan whose plan is silently
 * cut at 4 kB has lost the deliverable.
 */
export function readNodeOutput(runId: string, nodeId: string): string | undefined {
  try {
    return fs.readFileSync(path.join(nodeDir(runId, nodeId), 'output.txt'), 'utf8');
  } catch {
    return loadRun(runId)?.nodes[nodeId]?.output;
  }
}

export function writeNodeArtifact(runId: string, nodeId: string, name: string, body: string): string {
  const dir = nodeDir(runId, nodeId);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name.replace(/[^\w.-]/g, '_'));
  fs.writeFileSync(file, body);
  return path.relative(runDir(runId), file);
}

/** Terminal run states carry `endedAt`; this is the single place that stamps it. */
export function stampTerminal(record: RunRecord, state: RunState): void {
  record.state = state;
  record.endedAt = new Date().toISOString();
  record.updatedAt = record.endedAt;
}

// ─── Ownership lease ────────────────────────────────────────────────────────
//
// A run has one owner at a time. Without this, two processes could each call
// `resume` on the same run and both start executing its nodes — every side
// effect twice, two writers to one checkpoint, and an event log interleaving two
// timelines. "At-least-once per node" is a tolerable contract; "twice,
// concurrently, by design" is not.
//
// The lease is a file with the owner's pid and a heartbeat. It is taken on
// start/resume, renewed on every checkpoint, and released when the run ends.
// A lease is stale when its holder is gone (same host: `kill(pid, 0)`) or when
// the heartbeat has not moved for LEASE_TTL_MS.

export const LEASE_TTL_MS = 60_000;
/** How often a live owner refreshes its claim, independently of any work it is doing. */
export const LEASE_HEARTBEAT_MS = 15_000;

/**
 * Who holds a run.
 *
 * `ownerId` is the identity, not `pid`. Two `RunKernel` instances in one process
 * — two SessionManagers is not a strange thing to have — share a pid, so
 * treating the pid as the owner let both of them execute the same run and call
 * it re-entrancy. The pid is kept because it is what tells us whether the holder
 * is still alive; it is not what tells us whether the holder is us.
 */
export interface Owner {
  ownerId: string;
  pid: number;
  host: string;
}

export interface RunLease extends Owner {
  acquiredAt: string;
  renewedAt: string;
  /** Strictly increasing across acquisitions, and never reset. */
  fence: number;
}

function leaseFile(runId: string): string {
  return path.join(runDir(runId), 'lease.json');
}

function lockFile(runId: string): string {
  return path.join(runDir(runId), 'lease.lock');
}

/**
 * The fence counter, kept apart from the lease.
 *
 * It has to outlive the lease. Reading the next fence off `lease.json` looked
 * fine until the file was deleted on release, at which point the counter
 * restarted at 1 — so a "monotonic" token repeated itself, and a stale holder
 * with fence 1 could match a fresh owner with fence 1.
 */
function fenceFile(runId: string): string {
  return path.join(runDir(runId), 'fence.json');
}

function nextFence(runId: string): number {
  const current = readJson<{ next: number }>(fenceFile(runId))?.next ?? 0;
  const next = current + 1;
  atomicWriteJson(fenceFile(runId), { next });
  return next;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists and belongs to someone else.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function readLease(runId: string): RunLease | undefined {
  return readJson<RunLease>(leaseFile(runId));
}

/**
 * True when a lease no longer represents a live owner.
 *
 * On the same host the pid is the authority and the heartbeat is not consulted:
 * a process running one long node makes no checkpoints, and judging it dead for
 * that reason is how two owners end up running the same work. The heartbeat is
 * the fallback for a holder we cannot ask about — another machine, or a pid
 * whose meaning we cannot trust across hosts.
 */
export function leaseIsStale(lease: RunLease | undefined, now = Date.now()): boolean {
  if (!lease) return true;
  if (lease.host === os.hostname()) return !processAlive(lease.pid);
  const age = now - Date.parse(lease.renewedAt);
  return Number.isNaN(age) || age > LEASE_TTL_MS;
}

/**
 * Run `fn` inside the run's lock.
 *
 * Everything that inspects or changes ownership goes through here, so a check
 * and the write that depends on it cannot be separated by another process.
 */
function withLock<T>(runId: string, fn: () => T): T {
  const lock = lockFile(runId);
  fs.mkdirSync(path.dirname(lock), { recursive: true });

  let fd: number;
  try {
    fd = fs.openSync(lock, 'wx');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    // A lock left by a crashed holder would block the run forever. Acquisition
    // is milliseconds; anything older than the TTL is debris.
    let age = Infinity;
    try {
      age = Date.now() - fs.statSync(lock).mtimeMs;
    } catch {
      age = Infinity;
    }
    if (age < LEASE_TTL_MS) throw new Error(`Run '${runId}' is locked by another process right now`);
    fs.rmSync(lock, { force: true });
    fd = fs.openSync(lock, 'wx');
  }

  try {
    return fn();
  } finally {
    fs.closeSync(fd);
    fs.rmSync(lock, { force: true });
  }
}

/**
 * Claim a run, atomically.
 *
 * Re-entrant for the same `ownerId` — one kernel reclaiming a run it already has
 * — and refused for anyone else whose predecessor is still alive.
 */
export function acquireLease(runId: string, ownerId: string): RunLease {
  return withLock(runId, () => {
    const existing = readLease(runId);
    if (existing && existing.ownerId !== ownerId && !leaseIsStale(existing)) {
      throw new Error(
        `Run '${runId}' is owned by ${existing.ownerId} (pid ${existing.pid} on ${existing.host}, ` +
          `last seen ${existing.renewedAt}) — only one owner may run it at a time`,
      );
    }
    const now = new Date().toISOString();
    const lease: RunLease = {
      ownerId,
      pid: process.pid,
      host: os.hostname(),
      acquiredAt: existing?.ownerId === ownerId ? existing.acquiredAt : now,
      renewedAt: now,
      fence: existing?.ownerId === ownerId ? existing.fence : nextFence(runId),
    };
    atomicWriteJson(leaseFile(runId), lease);
    return lease;
  });
}

/** Heartbeat. Best-effort: losing a renewal must not break the run. */
export function renewLease(runId: string, ownerId: string): void {
  try {
    withLock(runId, () => {
      const existing = readLease(runId);
      if (!existing || existing.ownerId !== ownerId) return;
      atomicWriteJson(leaseFile(runId), { ...existing, renewedAt: new Date().toISOString() });
    });
  } catch {
    // The next renewal will try again.
  }
}

/** Whether this owner still holds the run at the fence it was given. */
export function holdsLease(runId: string, ownerId: string, fence: number): boolean {
  const current = readLease(runId);
  return Boolean(current && current.ownerId === ownerId && current.fence === fence);
}

/**
 * The one way to change a run's persisted state.
 *
 * Ownership is confirmed and the write happens inside the same critical section,
 * so a holder that has been superseded cannot land a write between the check and
 * the change. Returns false when the caller no longer owns the run — the caller
 * must then stop, not retry.
 *
 * A fencing token is only a fencing token if the loser is prevented, not merely
 * informed at the next convenient moment. Checking it once per node, as an
 * earlier version did, left every checkpoint, event and terminal verdict after
 * that check unguarded: a superseded owner could still declare the run complete.
 */
export function commit(runId: string, ownerId: string, fence: number, mutation: () => void): boolean {
  try {
    return withLock(runId, () => {
      const current = readLease(runId);
      if (!current || current.ownerId !== ownerId || current.fence !== fence) return false;
      mutation();
      atomicWriteJson(leaseFile(runId), { ...current, renewedAt: new Date().toISOString() });
      return true;
    });
  } catch {
    // A lock we could not take means someone else is mid-write; treat it the
    // same as having lost the run rather than writing without the lock.
    return false;
  }
}

/**
 * Release the claim. The fence counter is deliberately NOT removed — it must
 * keep increasing across every acquisition for the life of the run directory.
 */
export function releaseLease(runId: string, ownerId: string): void {
  try {
    withLock(runId, () => {
      const existing = readLease(runId);
      if (existing && existing.ownerId !== ownerId) return;
      fs.rmSync(leaseFile(runId), { force: true });
    });
  } catch {
    // A lease left behind expires on its own.
  }
}

// ─── Cross-process listing ──────────────────────────────────────────────────

export interface RunSummary {
  runId: string;
  workflow: string;
  state: RunState;
  outcome: RunRecord['outcome'];
  cwd: string;
  createdAt: string;
  updatedAt: string;
  endedAt?: string;
  currentNode?: string;
  evidenceId?: string;
  error?: string;
  costUsd?: number;
}

export interface ListRunsQuery {
  workflow?: string;
  state?: RunState;
  limit?: number;
}

export function summarize(record: RunRecord): RunSummary {
  return {
    runId: record.runId,
    workflow: record.workflow,
    state: record.state,
    outcome: record.outcome,
    cwd: record.cwd,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    endedAt: record.endedAt,
    currentNode: record.currentNode,
    evidenceId: record.evidenceId,
    error: record.error,
    costUsd: record.costUsd,
  };
}

/**
 * Every run on this machine, newest first — the cross-process listing the three
 * mode-specific enumerations each did differently (council regex-scraped its own
 * markdown transcripts, autoloop read a JSONL registry, ultraapp walked a store
 * directory). No separate index file is needed here because every run lives
 * under one root, so the directory *is* the index.
 */
export function listRuns(query: ListRunsQuery = {}): RunSummary[] {
  const out: RunSummary[] = [];
  for (const runId of listRunIds()) {
    const record = loadRun(runId);
    if (!record) continue;
    if (query.workflow && record.workflow !== query.workflow) continue;
    if (query.state && record.state !== query.state) continue;
    out.push(summarize(record));
  }
  out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  return query.limit && query.limit > 0 ? out.slice(0, query.limit) : out;
}
