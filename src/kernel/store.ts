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
  // Minted before the spec, so a run directory never exists without an
  // incarnation to identify it. See `Incarnation` for why this is not optional.
  atomicWriteJson(incarnationFile(runId), { incarnationId: crypto.randomUUID(), nextFence: 0 } as Incarnation);
  atomicWriteJson(path.join(dir, 'spec.json'), sanitizeForDisk(spec));
}

/**
 * Write a checkpoint.
 *
 * Deliberately NOT exported. "Unguarded on purpose, and nothing outside the
 * store should call it" was the previous comment, and it was not true: the
 * engine imported it and wrote checkpoints directly from `start`, `resume`,
 * `publish` and `setChild`. A rule enforced by a comment is not a rule. The only
 * way to a checkpoint is now {@link commit}, which cannot be reached without a
 * {@link RunGuard}.
 */
function writeRunRecord(record: RunRecord): void {
  // The checkpoint embeds the spec, so it gets the same scrub.
  atomicWriteJson(path.join(runDir(record.runId), 'run.json'), sanitizeForDisk(record));
}

export function loadSpec(runId: string): WorkflowSpec | undefined {
  // Lookups treat an invalid id as "no such run" rather than throwing: a query
  // for a nonsense id has an answer, and it is "nothing".
  if (!isValidRunId(runId)) return undefined;
  return readJson<WorkflowSpec>(path.join(runDir(runId), 'spec.json'));
}

/** Internal for the same reason as {@link writeRunRecord}: appends go through {@link commit}. */
function appendEventRaw(runId: string, event: KernelEvent, logger?: Logger): void {
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

/**
 * Where a node artifact will live, without writing it.
 *
 * Pure, because the checkpoint that references an artifact and the artifact
 * itself are written in the same {@link commit}: the caller needs the path
 * before the write, to put it in the record it is committing.
 */
export function nodeArtifactPath(runId: string, nodeId: string, name: string): string {
  const file = path.join(nodeDir(runId, nodeId), name.replace(/[^\w.-]/g, '_'));
  return path.relative(runDir(runId), file);
}

function writeNodeArtifactRaw(runId: string, nodeId: string, name: string, body: string): void {
  const dir = nodeDir(runId, nodeId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name.replace(/[^\w.-]/g, '_')), body);
}

// ─── Ownership: incarnation, lease, guard, commit ───────────────────────────
//
// A run has one owner at a time, and every durable change it makes is checked
// against a capability that only that owner holds. Without the first, two
// processes each `resume` the same run and every side effect happens twice.
// Without the second, the first is decoration: the previous version had a lease
// file and a fence, and the engine still wrote checkpoints, events and terminal
// verdicts straight past both.
//
// The capability is a `RunGuard`. It names four things, and all four are
// checked on every write:
//
//   incarnationId  which *creation* of this run id this is
//   ownerId        which RunKernel instance (never the pid — see `Owner`)
//   acquisitionId  which claim by that owner
//   fence          monotonic within the incarnation, for ordering and logs
//
// `incarnationId` exists because a run id is reusable. Delete a run and start
// another with the same id and the directory — fence counter included — is
// gone, so the new run's first fence is 1 again and a stale attempt still
// holding `{ownerId, fence: 1}` from the old run became valid a second time.
// That is a textbook ABA, and it is not hypothetical: an abandoned timed-out
// attempt outlives its run by construction. A fresh random id per creation
// makes an old guard unusable no matter what the counter says.

export const LEASE_TTL_MS = 60_000;
/** How often a live owner refreshes its claim, independently of any work it is doing. */
export const LEASE_HEARTBEAT_MS = 15_000;

/**
 * Identity of one creation of a run id, plus its fence counter.
 *
 * Kept in its own file so it survives `releaseLease` (the counter must never
 * restart while the run exists) and dies with the run directory (a new creation
 * must never inherit the old identity).
 */
interface Incarnation {
  incarnationId: string;
  nextFence: number;
}

/**
 * The capability to change a run.
 *
 * Held by the executing kernel, passed to every write, and impossible to forge
 * from a run id alone — which is what makes `commit` a boundary rather than a
 * convention.
 */
export interface RunGuard {
  runId: string;
  incarnationId: string;
  ownerId: string;
  acquisitionId: string;
  fence: number;
}

/**
 * Who holds a run, as recorded on disk.
 *
 * `ownerId` is the identity, not `pid`. Two `RunKernel` instances in one process
 * — two SessionManagers is not a strange thing to have — share a pid, so
 * treating the pid as the owner let both of them execute the same run and call
 * it re-entrancy. The pid is kept because it is what tells us whether the holder
 * is still alive; it is not what tells us whether the holder is us.
 */
export interface RunLease extends RunGuard {
  pid: number;
  host: string;
  acquiredAt: string;
  renewedAt: string;
}

/** What one `commit` may change. Everything durable about a run is in here. */
export interface CommitBatch {
  /** The new checkpoint. */
  record?: RunRecord;
  /** Appended to `events.jsonl`, in order, after the checkpoint. */
  events?: KernelEvent[];
  /** Node artifact files, written before the checkpoint that references them. */
  artifacts?: Array<{ nodeId: string; name: string; body: string }>;
}

function leaseFile(runId: string): string {
  return path.join(runDir(runId), 'lease.json');
}

function lockFile(runId: string): string {
  return path.join(runDir(runId), 'lease.lock');
}

function incarnationFile(runId: string): string {
  return path.join(runDir(runId), 'incarnation.json');
}

function readIncarnation(runId: string): Incarnation | undefined {
  const raw = readJson<Incarnation>(incarnationFile(runId));
  return raw && typeof raw.incarnationId === 'string' && raw.incarnationId ? raw : undefined;
}

/**
 * The run's incarnation, minting one if the directory predates this field.
 *
 * Only ever called inside the lock. A directory with no incarnation is a run
 * from an older layout; giving it one now is correct, because whatever guards
 * existed before this file did are already unusable.
 */
function ensureIncarnationLocked(runId: string): Incarnation {
  const existing = readIncarnation(runId);
  if (existing) return existing;
  const fresh: Incarnation = { incarnationId: crypto.randomUUID(), nextFence: 0 };
  atomicWriteJson(incarnationFile(runId), fresh);
  return fresh;
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
  if (!isValidRunId(runId)) return undefined;
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
 * Claim a run and receive the capability to write to it.
 *
 * Refused when someone else's claim is still live. Allowed for the same owner —
 * but the guard it returns is a NEW one, and the previous guard is dead from
 * that moment: re-acquiring is a fresh claim, not a renewal of the old one, so
 * anything still holding the old guard stops being able to write.
 */
export function acquireLease(runId: string, ownerId: string): RunGuard {
  return withLock(runId, () => {
    const incarnation = ensureIncarnationLocked(runId);
    const existing = readLease(runId);
    if (existing && existing.ownerId !== ownerId && !leaseIsStale(existing)) {
      throw new Error(
        `Run '${runId}' is owned by ${existing.ownerId} (pid ${existing.pid} on ${existing.host}, ` +
          `last seen ${existing.renewedAt}) — only one owner may run it at a time`,
      );
    }
    const fence = incarnation.nextFence + 1;
    atomicWriteJson(incarnationFile(runId), { ...incarnation, nextFence: fence });
    const now = new Date().toISOString();
    const lease: RunLease = {
      runId,
      incarnationId: incarnation.incarnationId,
      ownerId,
      acquisitionId: crypto.randomUUID(),
      fence,
      pid: process.pid,
      host: os.hostname(),
      acquiredAt: existing?.ownerId === ownerId ? existing.acquiredAt : now,
      renewedAt: now,
    };
    atomicWriteJson(leaseFile(runId), lease);
    return {
      runId,
      incarnationId: lease.incarnationId,
      ownerId,
      acquisitionId: lease.acquisitionId,
      fence,
    };
  });
}

/** Whether the on-disk lease still answers to this guard. Caller must hold the lock. */
function guardIsCurrentLocked(guard: RunGuard): boolean {
  const incarnation = readIncarnation(guard.runId);
  if (!incarnation || incarnation.incarnationId !== guard.incarnationId) return false;
  const lease = readLease(guard.runId);
  return Boolean(
    lease &&
    lease.incarnationId === guard.incarnationId &&
    lease.ownerId === guard.ownerId &&
    lease.acquisitionId === guard.acquisitionId &&
    lease.fence === guard.fence,
  );
}

/** Heartbeat. Best-effort: losing a renewal must not break the run. */
export function renewLease(guard: RunGuard): void {
  try {
    withLock(guard.runId, () => {
      if (!guardIsCurrentLocked(guard)) return;
      const existing = readLease(guard.runId)!;
      atomicWriteJson(leaseFile(guard.runId), { ...existing, renewedAt: new Date().toISOString() });
    });
  } catch {
    // The next renewal will try again.
  }
}

/**
 * The one way to change anything durable about a run.
 *
 * The guard is verified and every write happens inside a single critical
 * section, so a holder that has been superseded cannot land a write between the
 * check and the change. Returns false when the guard is no longer current — the
 * caller must then stop, not retry.
 *
 * Callers pass a record they have already produced by copying and mutating,
 * never the record they are still using: `commit` persists what it is given, and
 * the caller adopts it only if this returns true. That is what keeps a refused
 * write from leaving a run *in memory* claiming a state the disk rejected.
 */
export function commit(guard: RunGuard, batch: CommitBatch, logger?: Logger): boolean {
  try {
    return withLock(guard.runId, () => {
      if (!guardIsCurrentLocked(guard)) return false;
      for (const artifact of batch.artifacts ?? []) {
        writeNodeArtifactRaw(guard.runId, artifact.nodeId, artifact.name, artifact.body);
      }
      if (batch.record) writeRunRecord(batch.record);
      for (const event of batch.events ?? []) appendEventRaw(guard.runId, event, logger);
      const lease = readLease(guard.runId)!;
      atomicWriteJson(leaseFile(guard.runId), { ...lease, renewedAt: new Date().toISOString() });
      return true;
    });
  } catch {
    // A lock we could not take means someone else is mid-write; treat it the
    // same as having lost the run rather than writing without the lock.
    return false;
  }
}

/**
 * Release the claim. The incarnation file is deliberately NOT removed — the
 * fence must keep increasing for as long as this creation of the run exists.
 */
export function releaseLease(guard: RunGuard): void {
  try {
    withLock(guard.runId, () => {
      if (!guardIsCurrentLocked(guard)) return;
      fs.rmSync(leaseFile(guard.runId), { force: true });
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
