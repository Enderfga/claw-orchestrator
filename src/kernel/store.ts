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
 * There is exactly one way to write to a run — `commit()` — and it is not
 * optional: the checkpoint writer and the event appender are module-private, and
 * a batch is published by a single atomic directory rename rather than by a
 * sequence of writes that can each fail on their own. `atomicWriteJson` replaces
 * four near-identical implementations that had grown across the codebase
 * (`session-manager.ts` sync + async variants, `ultraapp/store.ts`,
 * `ultraapp/patcher.ts`); the tmp-name shape is kept from the ultraapp one,
 * whose comment records the CI bug it fixed: a reader catching a plain
 * `writeFile` mid-flight and parsing a truncated object.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Logger } from '../logger.js';
import { withFileLock, type LockResult } from './file-lock.js';
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

export function loadSpec(runId: string): WorkflowSpec | undefined {
  // Lookups treat an invalid id as "no such run" rather than throwing: a query
  // for a nonsense id has an answer, and it is "nothing".
  if (!isValidRunId(runId)) return undefined;
  return readJson<WorkflowSpec>(path.join(runDir(runId), 'spec.json'));
}

export function readEvents(runId: string, limit?: number): KernelEvent[] {
  if (!isValidRunId(runId)) return [];
  // A published transaction is authoritative even before its files have been
  // applied. Returning the old log while `.tx` is still present would expose a
  // state from before a commit that already succeeded.
  if (!recoverPending(runId)) {
    throw new Error(`Run '${runId}' has a committed transaction that could not be applied`);
  }
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
  // A transaction the last owner committed but died before applying is finished
  // here, so a reader never sees the state from before a committed change.
  if (!recoverPending(runId)) {
    throw new Error(`Run '${runId}' has a committed transaction that could not be applied`);
  }
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

// ─── Ownership and the storage transaction ──────────────────────────────────
//
// A run has one owner at a time, every durable change it makes is checked
// against a capability only that owner holds, and each change lands in full or
// not at all. Each of those three was added after the previous two turned out to
// be decoration without it.
//
// The capability is a `RunGuard`, naming four things, all checked on every
// write:
//
//   incarnationId  which *creation* of this run id this is
//   ownerId        which RunKernel instance (never the pid — see `RunLease`)
//   acquisitionId  which claim by that owner
//   fence          monotonic within the incarnation, for ordering and logs
//
// `incarnationId` exists because a run id is reusable. Delete a run and start
// another with the same id and the directory — fence counter included — is
// gone, so the new run's first fence is 1 again and a stale attempt still
// holding `{ownerId, fence: 1}` from the old run became valid a second time.
// That is a textbook ABA, and not hypothetical: an abandoned timed-out attempt
// outlives its run by construction.
//
// Two distinctions this module is careful about, because collapsing either one
// caused a real failure:
//
//   *Not the owner* is permanent; *could not take the lock* is transient. They
//   are separate outcomes (`superseded` vs `blocked`), and a caller that treats
//   a millisecond of contention as a loss stops forever while still holding its
//   lease — so nothing can take the run over either.
//
//   *Committed* means the whole batch is durable, not that most of it was
//   attempted. A batch is staged in a scratch directory and published by a
//   single atomic directory rename; the rename is the commit point, and what
//   follows is replayable application of an already-committed transaction.

export const LEASE_TTL_MS = 60_000;
/** How often a live owner refreshes its claim, independently of any work it is doing. */
export const LEASE_HEARTBEAT_MS = 15_000;

/** Staged, not yet committed. Removed on the next lock; never read. */
const TX_STAGING = '.tx.staging';
/** Committed and awaiting application. Its presence IS the commit. */
const TX_COMMITTED = '.tx';

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
  /** Appended to `events.jsonl`, in order. */
  events?: KernelEvent[];
  /** Node artifact files, published together with the record that references them. */
  artifacts?: Array<{ nodeId: string; name: string; body: string }>;
}

/**
 * Why a write did or did not happen.
 *
 * Three outcomes rather than a boolean, because the two failures call for
 * opposite responses: `superseded` means stop permanently, `blocked` means this
 * attempt did not get through and the run is still ours.
 */
export type CommitOutcome = 'committed' | 'superseded' | 'blocked';

export interface CommitResult {
  outcome: CommitOutcome;
  reason?: string;
}

export type ReleaseOutcome = 'released' | 'not-ours' | 'blocked';

function leaseFile(runId: string): string {
  return path.join(runDir(runId), 'lease.json');
}

function lockFile(runId: string): string {
  return path.join(runDir(runId), 'lease.lock');
}

function incarnationFile(runId: string): string {
  return path.join(runDir(runId), 'incarnation.json');
}

function eventsFile(runId: string): string {
  return path.join(runDir(runId), 'events.jsonl');
}

function fileSize(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
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

// ─── The transaction ────────────────────────────────────────────────────────

interface TxManifest {
  /**
   * The length `events.jsonl` had before this transaction.
   *
   * Application truncates to it and then appends, which makes applying a
   * transaction idempotent — a crash anywhere inside the apply cannot duplicate
   * an event, however many times recovery replays it. An append with no such
   * marker cannot offer that.
   */
  eventsOffset: number;
  hasRecord: boolean;
  hasEvents: boolean;
  /** Paths relative to the run directory. */
  artifacts: string[];
}

/**
 * Apply a committed transaction. Idempotent, and safe to re-run after a crash.
 *
 * Caller holds the lock.
 */
function applyTxLocked(runId: string, logger?: Logger): void {
  const dir = runDir(runId);
  const tx = path.join(dir, TX_COMMITTED);
  const manifest = readJson<TxManifest>(path.join(tx, 'manifest.json'));
  if (!manifest) {
    // No manifest means the rename landed a half-written staging directory,
    // which cannot happen — but if it somehow did, it is not a commitment.
    fs.rmSync(tx, { recursive: true, force: true });
    return;
  }

  for (const rel of manifest.artifacts) {
    const from = path.join(tx, 'files', rel);
    const to = path.join(dir, rel);
    try {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.renameSync(from, to);
    } catch (err) {
      // ENOENT means a previous application already moved it.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }

  if (manifest.hasEvents) {
    const events = eventsFile(runId);
    try {
      fs.truncateSync(events, manifest.eventsOffset);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    fs.appendFileSync(events, fs.readFileSync(path.join(tx, 'events.jsonl')));
  }

  if (manifest.hasRecord) {
    try {
      fs.renameSync(path.join(tx, 'run.json'), path.join(dir, 'run.json'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }

  fs.rmSync(tx, { recursive: true, force: true });
  logger?.debug?.(`[kernel-store] ${runId}: applied a pending transaction`);
}

/** Stage a batch and publish it with one atomic rename. Caller holds the lock. */
function stageLocked(runId: string, batch: CommitBatch): void {
  const dir = runDir(runId);
  const staging = path.join(dir, TX_STAGING);
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });

  const manifest: TxManifest = {
    eventsOffset: fileSize(eventsFile(runId)),
    hasRecord: Boolean(batch.record),
    hasEvents: Boolean(batch.events?.length),
    artifacts: [],
  };

  for (const artifact of batch.artifacts ?? []) {
    const rel = nodeArtifactPath(runId, artifact.nodeId, artifact.name);
    const dest = path.join(staging, 'files', rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, artifact.body);
    manifest.artifacts.push(rel);
  }
  if (batch.record) {
    // The checkpoint embeds the spec, so it gets the same scrub.
    fs.writeFileSync(path.join(staging, 'run.json'), JSON.stringify(sanitizeForDisk(batch.record), null, 2));
  }
  if (batch.events?.length) {
    fs.writeFileSync(path.join(staging, 'events.jsonl'), batch.events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  }
  fs.writeFileSync(path.join(staging, 'manifest.json'), JSON.stringify(manifest));

  // THE COMMIT POINT. Renaming a directory is atomic, so the transaction is
  // either wholly present or wholly absent — never a checkpoint whose events
  // were silently dropped, or an artifact left behind by a write that failed
  // afterwards. Both of those were real: the event append swallowed its own
  // errors, and artifacts were written before the checkpoint they belonged to.
  fs.renameSync(staging, path.join(dir, TX_COMMITTED));
}

/** Finish any transaction that was committed but not yet applied. Caller holds the lock. */
function recoverPendingLocked(runId: string, logger?: Logger): void {
  const dir = runDir(runId);
  try {
    // Staging that outlived its process was never committed.
    fs.rmSync(path.join(dir, TX_STAGING), { recursive: true, force: true });
  } catch {
    // Debris; the next attempt overwrites it.
  }
  if (!fs.existsSync(path.join(dir, TX_COMMITTED))) return;
  try {
    applyTxLocked(runId, logger);
  } catch (err) {
    logger?.warn?.(`[kernel-store] ${runId}: could not apply a pending transaction: ${(err as Error).message}`);
  }
}

/**
 * Run `fn` inside the run's lock, with any pending transaction applied first.
 *
 * Everything that inspects or changes ownership goes through here, so a check
 * and the write that depends on it cannot be separated by another process — and
 * so no caller can observe a run mid-transaction.
 */
function withRunLock<T>(runId: string, fn: () => T, logger?: Logger): LockResult<T> {
  return withFileLock(
    lockFile(runId),
    () => {
      recoverPendingLocked(runId, logger);
      return fn();
    },
    // Never `createParent`: a run directory that has been deleted must stay
    // deleted. Recreating it to hold a lock left an empty directory behind, and
    // the id then looked taken by a run that no longer existed.
    { staleMs: LEASE_TTL_MS },
  );
}

/** Whether the run directory is still there at all. A gone run is not contention. */
function runDirExists(runId: string): boolean {
  try {
    return fs.existsSync(runDir(runId));
  } catch {
    return false;
  }
}

/** Apply anything a crashed owner committed but did not finish writing. */
export function recoverPending(runId: string, logger?: Logger): boolean {
  if (!isValidRunId(runId)) return false;
  try {
    if (!fs.existsSync(path.join(runDir(runId), TX_COMMITTED))) return true;
  } catch {
    return false;
  }
  const locked = withRunLock(runId, () => undefined, logger);
  if (!locked.ok) return false;
  // `recoverPendingLocked` deliberately leaves a committed transaction in
  // place when application fails. Its continued presence means returning the
  // old checkpoint or event log would be a lie.
  return !fs.existsSync(path.join(runDir(runId), TX_COMMITTED));
}

// ─── Claiming ───────────────────────────────────────────────────────────────

function acquireLocked(runId: string, ownerId: string): RunGuard {
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
  return { runId, incarnationId: lease.incarnationId, ownerId, acquisitionId: lease.acquisitionId, fence };
}

/**
 * Create a run and claim it, atomically.
 *
 * The non-recursive `mkdir` IS the claim: it fails with EEXIST for everyone but
 * the first caller, so exactly one process can create a given run id. The
 * previous version asked `runExists()` and then created with
 * `{ recursive: true }`, which is a check-then-write race and lost it routinely
 * — two processes creating the same id 80 times had both "succeed" 76 times,
 * leaving one workflow executing while the other's `spec.json` sat on disk, and
 * a lease belonging to an incarnation that had already been overwritten.
 */
export function createAndAcquire(runId: string, spec: WorkflowSpec, ownerId: string): RunGuard {
  const dir = runDir(runId);
  fs.mkdirSync(wfDir(), { recursive: true });
  try {
    fs.mkdirSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`Run '${runId}' already exists — pick another id, or resume it instead of starting over`);
    }
    throw err;
  }
  // Nobody else can be inside a directory that did not exist a moment ago, so
  // this lock is uncontended by construction; taking it anyway keeps every
  // write to the run under the same discipline.
  const locked = withRunLock(runId, () => {
    atomicWriteJson(incarnationFile(runId), { incarnationId: crypto.randomUUID(), nextFence: 0 } as Incarnation);
    atomicWriteJson(path.join(dir, 'spec.json'), sanitizeForDisk(spec));
    return acquireLocked(runId, ownerId);
  });
  if (!locked.ok) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw new Error(`Run '${runId}' could not be created: ${locked.error}`);
  }
  return locked.value;
}

/**
 * Claim an existing run and receive the capability to write to it.
 *
 * Refused when someone else's claim is still live. Allowed for the same owner —
 * but the guard it returns is a NEW one, and the previous guard is dead from
 * that moment: re-acquiring is a fresh claim, not a renewal of the old one, so
 * anything still holding the old guard stops being able to write.
 */
export function acquireLease(runId: string, ownerId: string): RunGuard {
  if (!runDirExists(runId)) throw new Error(`Run '${runId}' not found`);
  const locked = withRunLock(runId, () => acquireLocked(runId, ownerId));
  if (!locked.ok) {
    throw new Error(`Run '${runId}' could not be claimed right now: ${locked.error}`);
  }
  return locked.value;
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
  if (!runDirExists(guard.runId)) return;
  withRunLock(guard.runId, () => {
    if (!guardIsCurrentLocked(guard)) return;
    const existing = readLease(guard.runId)!;
    try {
      atomicWriteJson(leaseFile(guard.runId), { ...existing, renewedAt: new Date().toISOString() });
    } catch {
      // The next renewal will try again.
    }
  });
}

/**
 * The one way to change anything durable about a run.
 *
 * The guard is verified and the transaction is published inside a single
 * critical section, so a holder that has been superseded cannot land a write
 * between the check and the change.
 *
 * Callers pass a record they have already produced by copying and mutating,
 * never the record they are still using: `commit` persists what it is given, and
 * the caller adopts it only on `committed`. That is what keeps a refused write
 * from leaving a run *in memory* claiming a state the disk rejected.
 */
export function commit(guard: RunGuard, batch: CommitBatch, logger?: Logger): CommitResult {
  // A deleted run is not contention, and must not be reported as something to
  // retry: there is nothing left to write to, ever.
  if (!runDirExists(guard.runId)) {
    return { outcome: 'superseded', reason: `run '${guard.runId}' no longer exists` };
  }
  const locked = withRunLock(
    guard.runId,
    (): CommitResult => {
      if (!guardIsCurrentLocked(guard)) {
        const current = readLease(guard.runId);
        return {
          outcome: 'superseded',
          reason: current
            ? `run is now held by ${current.ownerId} at fence ${current.fence}`
            : `run '${guard.runId}' no longer exists, or its claim was released`,
        };
      }
      try {
        stageLocked(guard.runId, batch);
      } catch (err) {
        try {
          fs.rmSync(path.join(runDir(guard.runId), TX_STAGING), { recursive: true, force: true });
        } catch {
          // Debris only; nothing was published.
        }
        return { outcome: 'blocked', reason: `could not stage the change: ${(err as Error).message}` };
      }
      // Past the commit point. Application is replayable, so a failure here is a
      // delay, not a loss — and reporting it as "not committed" would be wrong.
      try {
        applyTxLocked(guard.runId, logger);
      } catch (err) {
        logger?.warn?.(
          `[kernel-store] ${guard.runId}: change is committed but not yet applied ` +
            `(${(err as Error).message}); it will be applied on the next lock`,
        );
      }
      try {
        const lease = readLease(guard.runId)!;
        atomicWriteJson(leaseFile(guard.runId), { ...lease, renewedAt: new Date().toISOString() });
      } catch {
        // The heartbeat is not part of the commitment.
      }
      return { outcome: 'committed' };
    },
    logger,
  );
  return locked.ok ? locked.value : { outcome: 'blocked', reason: locked.error };
}

/**
 * Release the claim. The incarnation file is deliberately NOT removed — the
 * fence must keep increasing for as long as this creation of the run exists.
 *
 * `blocked` is not `not-ours`: an owner that is standing down and cannot take
 * the lock still has to hand the run back, so the caller retries rather than
 * leaving a lease behind that no one can take over.
 */
export function releaseLease(guard: RunGuard): ReleaseOutcome {
  if (!runDirExists(guard.runId)) return 'not-ours';
  const locked = withRunLock(guard.runId, (): ReleaseOutcome => {
    if (!guardIsCurrentLocked(guard)) return 'not-ours';
    fs.rmSync(leaseFile(guard.runId), { force: true });
    return 'released';
  });
  return locked.ok ? locked.value : 'blocked';
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
    let record: RunRecord | undefined;
    try {
      record = loadRun(runId);
    } catch {
      // One run whose committed transaction cannot currently be applied must
      // not make every other run disappear from the listing.
      continue;
    }
    if (!record) continue;
    if (query.workflow && record.workflow !== query.workflow) continue;
    if (query.state && record.state !== query.state) continue;
    out.push(summarize(record));
  }
  out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  return query.limit && query.limit > 0 ? out.slice(0, query.limit) : out;
}
