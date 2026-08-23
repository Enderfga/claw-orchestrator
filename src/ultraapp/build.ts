/**
 * UltraappBuildQueue — global serial queue for ultraapp builds.
 *
 * Default concurrency = 1. Pending builds are FIFO. Subscribers receive every
 * BuildEvent emitted by the worker for any currently-running build.
 *
 * The queue is durable as of 6.0.0. It used to say so in this comment: "Disk
 * persistence (in-progress + pending lists) is NOT done in v0.2 — if the
 * orchestrator restarts mid-build, the build is marked failed and the user can
 * rerun." In practice a restart did not mark anything: the pending list simply
 * vanished, along with any queued build the user was waiting on, with no record
 * that it had ever been asked for.
 *
 * Now the pending list and the in-flight run id are written on every change and
 * restored on construction. A build that was in flight when the process died is
 * re-queued rather than resumed — each build starts from a fresh council
 * worktree, so re-running is safe and resuming a half-built tree is not.
 *
 * Durability without ownership would be worse than neither: two processes each
 * restoring the same file would each run the same builds, doing every side
 * effect twice. So restoring takes a lease on the state file, held by pid and
 * heartbeated. A queue that cannot take the lease starts empty and leaves the
 * work to whoever owns it.
 */

import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { withFileLock } from '../kernel/file-lock.js';
import type { BuildEvent } from './build-events.js';

export type Worker = (runId: string, emit: (e: BuildEvent) => void) => Promise<void>;

export interface UltraappBuildQueueOptions {
  worker: Worker;
  concurrency?: number; // default 1
  /**
   * Where the queue is persisted. Omit for an ephemeral queue — the tests that
   * only exercise ordering do not need a file.
   */
  statePath?: string;
  /** Notified when a restored in-flight build is re-queued. */
  onRestore?: (runIds: string[]) => void;
  /**
   * Notified when another live process owns the queue, so this one starts
   * empty. Not an error — it is the correct outcome.
   */
  onNotOwner?: (owner: QueueOwner) => void;
}

interface PendingItem {
  runId: string;
}

interface PersistedQueue {
  pending: string[];
  /** The build that was running when the state was last written. */
  current: string | null;
  /** Who is executing this queue. */
  owner?: QueueOwner;
}

export interface QueueOwner {
  /**
   * Identity of the owning queue instance, not of the process.
   *
   * Two queues in one process would otherwise share a pid and each read the
   * other's claim as its own — the same mistake a pid-keyed run lease made.
   */
  ownerId: string;
  pid: number;
  renewedAt: string;
}

/**
 * What a persist attempt did.
 *
 * `blocked` is not `superseded`: one says the claim moved on and this queue must
 * stop, the other says we could not get into the critical section and should try
 * again. Collapsing them into a boolean is what let a queue dispatch a build
 * while the state file on disk already named a different owner.
 */
type PersistOutcome = 'committed' | 'superseded' | 'blocked' | 'ephemeral';

/** How long an owner may go without a heartbeat before the queue is up for grabs. */
const OWNER_TTL_MS = 60_000;
/** Refresh interval, comfortably inside the TTL. */
const HEARTBEAT_MS = 15_000;

function ownerIsLive(owner: QueueOwner | undefined, selfId: string): boolean {
  if (!owner) return false;
  if (owner.ownerId === selfId) return true;
  const age = Date.now() - Date.parse(owner.renewedAt);
  if (Number.isNaN(age) || age > OWNER_TTL_MS) return false;
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export class UltraappBuildQueue {
  private readonly emitter = new EventEmitter();
  private readonly pending: PendingItem[] = [];
  private currentRunId: string | null = null;
  private readonly worker: Worker;
  private readonly concurrency: number;
  private readonly statePath?: string;
  private heartbeat?: ReturnType<typeof setInterval>;
  /** This queue instance's identity as an owner. Per instance, not per process. */
  readonly ownerId = `queue-${crypto.randomUUID()}`;
  /** Consecutive failed dispatch claims, per build. Cleared once it starts. */
  private readonly dispatchRetries = new Map<string, number>();
  private idlePromise: Promise<void> = Promise.resolve();
  private idleResolve: (() => void) | null = null;

  constructor(opts: UltraappBuildQueueOptions) {
    this.worker = opts.worker;
    this.concurrency = opts.concurrency ?? 1;
    this.statePath = opts.statePath;
    const restored = this.restore();
    if (this.statePath && !this.notOwner) {
      // Independent of any build finishing: a worker that runs for ten minutes
      // makes no state writes, and must not look abandoned for it.
      this.heartbeat = setInterval(() => this.persist(), HEARTBEAT_MS);
      if (typeof this.heartbeat.unref === 'function') this.heartbeat.unref();
    }
    if (this.notOwner) opts.onNotOwner?.(this.notOwner);
    if (restored.length > 0) {
      opts.onRestore?.(restored);
      this.markBusy();
      void this.tryDispatch();
    }
  }

  /** Set when another live queue holds the claim. */
  private notOwner?: QueueOwner;

  /**
   * True when this process is executing the queue.
   *
   * Reads the state file rather than answering from the last decision, so a
   * queue that has been taken over reports it even before its next write finds
   * out. Advisory only — nothing acts on this answer; `enqueue` and dispatch
   * re-check under the lock, because a lock-free read is a snapshot and a claim
   * is not.
   */
  ownsQueue(): boolean {
    if (this.notOwner) return false;
    if (!this.statePath) return true;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.statePath, 'utf8')) as PersistedQueue;
      if (parsed?.owner && parsed.owner.ownerId !== this.ownerId && ownerIsLive(parsed.owner, this.ownerId)) {
        return false;
      }
    } catch {
      // No state file yet, or unreadable: nothing says anyone else has it.
    }
    return true;
  }

  /** Refuse an operation that only the owner may perform. */
  private assertOwner(action: string): void {
    if (!this.notOwner) return;
    throw new Error(
      `Cannot ${action}: this build queue is owned by ${this.notOwner.ownerId} (pid ${this.notOwner.pid}) ` +
        `(last seen ${this.notOwner.renewedAt}). Running its builds here would execute them twice.`,
    );
  }

  /** Release the claim so another process can pick the queue up promptly. */
  stop(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
  }

  /**
   * Read back a queue left by a previous process.
   *
   * A build that was in flight goes to the FRONT of the restored queue: it was
   * asked for first, and the user has been waiting on it longest.
   */
  /**
   * Claim the queue and read back whatever the last owner left.
   *
   * Read-then-decide is not a claim. Two processes starting with no state file
   * both saw "free", both concluded they owned it, and nothing wrote an owner
   * until the first enqueue — by which time both were running the same builds.
   * The read and the claim happen inside one `O_EXCL` critical section now.
   */
  private restore(): string[] {
    if (!this.statePath) return [];
    let entered = false;
    const ids = this.withLock(() => {
      entered = true;
      return this.claimLocked();
    }, []);
    if (!entered && !this.notOwner) {
      // We never got inside the critical section — someone else is claiming
      // right now, or the lock file is unusable. Either way we have not taken
      // the queue, and acting as though we had is how both processes end up
      // running the same builds.
      this.notOwner = { ownerId: 'unknown', pid: -1, renewedAt: new Date().toISOString() };
    }
    return ids ?? [];
  }

  /**
   * Run `fn` inside the queue's lock, waiting briefly for it.
   *
   * Shared with the run store, and for the same reason: a lock that is merely
   * busy must not be reported the same way as a claim that has moved on.
   */
  private withLock<T>(fn: () => T, onContended: T): T | undefined {
    if (!this.statePath) return undefined;
    const result = withFileLock(`${this.statePath}.lock`, fn, { staleMs: OWNER_TTL_MS, createParent: true });
    return result.ok ? result.value : onContended;
  }

  /** The critical section of `restore`: inspect the owner and take it, or step aside. */
  private claimLocked(): string[] {
    if (!this.statePath) return [];
    let parsed: PersistedQueue;
    try {
      parsed = JSON.parse(fs.readFileSync(this.statePath!, 'utf8')) as PersistedQueue;
    } catch {
      parsed = { pending: [], current: null };
    }
    if (ownerIsLive(parsed.owner, this.ownerId)) {
      // Someone else is running these. Taking them would execute every build
      // twice; the honest move is to start empty and say so.
      this.notOwner = parsed.owner!;
      return [];
    }
    const ids = [
      ...(parsed.current ? [parsed.current] : []),
      ...(Array.isArray(parsed.pending) ? parsed.pending.filter((x) => typeof x === 'string') : []),
    ];
    for (const runId of ids) this.pending.push({ runId });
    // Stake the claim before releasing the lock, so a racer that gets in next
    // sees an owner rather than an empty file.
    this.writeStateUnchecked();
    return ids;
  }

  /**
   * Persist the queue, if we still own it.
   *
   * Best-effort about I/O, not about ownership: the check happens inside the
   * lock, in the same critical section as the write. Taking the claim at
   * construction and then writing unconditionally forever was not ownership — a
   * queue whose heartbeat had lapsed and been taken over would quietly stamp
   * itself back in as owner on its next persist, clobbering the new owner's
   * pending list and running its builds a second time.
   */
  private persist(): PersistOutcome {
    if (!this.statePath) return 'ephemeral';
    if (this.notOwner) return 'superseded';
    return this.withLock(() => this.writeStateLocked(), 'blocked' as PersistOutcome) ?? 'blocked';
  }

  /** Caller must hold the lock. Steps aside — permanently — if the claim moved on. */
  private writeStateLocked(): PersistOutcome {
    if (!this.statePath) return 'ephemeral';
    let parsed: PersistedQueue | undefined;
    try {
      parsed = JSON.parse(fs.readFileSync(this.statePath, 'utf8')) as PersistedQueue;
    } catch {
      parsed = undefined;
    }
    if (parsed?.owner && parsed.owner.ownerId !== this.ownerId && ownerIsLive(parsed.owner, this.ownerId)) {
      this.standDown(parsed.owner);
      return 'superseded';
    }
    this.writeStateUnchecked();
    return 'committed';
  }

  /**
   * Hand the queue over: stop heartbeating and drop the pending list.
   *
   * Keeping the list would be worse than losing it — every entry now belongs to
   * the new owner, who has its own copy, and dispatching from ours is the double
   * execution the claim exists to prevent. A build already in flight cannot be
   * recalled; it finishes, and nothing further starts.
   */
  private standDown(owner: QueueOwner): void {
    this.notOwner = owner;
    this.stop();
    this.pending.length = 0;
    if (this.currentRunId === null) this.markIdle();
  }

  private writeStateUnchecked(): void {
    if (!this.statePath) return;
    try {
      fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
      const state: PersistedQueue = {
        pending: this.pending.map((p) => p.runId),
        current: this.currentRunId,
        // Every write is also the heartbeat, so a queue that stops making
        // progress stops holding the claim.
        owner: { ownerId: this.ownerId, pid: process.pid, renewedAt: new Date().toISOString() },
      };
      const tmp = `${this.statePath}.tmp.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
      fs.writeFileSync(tmp, JSON.stringify(state));
      fs.renameSync(tmp, this.statePath);
    } catch {
      // A queue that cannot be persisted still works for this process.
    }
  }

  /**
   * Enqueue a build. Resolves immediately after the run is appended to the
   * pending list. Use {@link idle} to wait for the queue to drain.
   */
  async enqueue(runId: string): Promise<void> {
    // Refusing at construction is not enough: `ownsQueue()` returning false
    // while `enqueue` cheerfully ran the build — and rewrote the owner to
    // ourselves — is exactly the double execution the claim exists to stop.
    this.assertOwner('enqueue');
    this.pending.push({ runId });
    // The claim is re-checked inside the same critical section the write happens
    // in. Owning the queue at construction says nothing about owning it now: the
    // heartbeat can have lapsed and someone else can have taken over, and an
    // `enqueue` that only consulted the construction-time answer would run their
    // builds a second time.
    //
    // Three outcomes, not two. `superseded` refuses. `blocked` — we could not
    // even get into the critical section — also refuses, because an enqueue that
    // cannot be recorded may be an enqueue into a queue somebody else now owns;
    // the earlier version returned a bare `false` here and carried on, and ran a
    // build whose queue state on disk already belonged to another process.
    const persisted = this.persist();
    if (persisted === 'superseded') this.assertOwner('enqueue');
    if (persisted === 'blocked') {
      this.pending.pop();
      throw new Error(
        `Cannot enqueue: the build queue state file is locked by another process, so this build cannot be ` +
          `recorded. Retry in a moment.`,
      );
    }
    this.markBusy();
    const pos = this.position(runId);
    if (pos > 0) {
      this.emit({ type: 'queued', runId, position: pos });
    }
    void this.tryDispatch();
  }

  cancel(runId: string): void {
    const idx = this.pending.findIndex((p) => p.runId === runId);
    if (idx >= 0) {
      this.pending.splice(idx, 1);
      this.persist();
      this.emit({ type: 'build-cancelled', runId });
      if (this.pending.length === 0 && this.currentRunId === null) this.markIdle();
    }
    if (this.currentRunId === runId) {
      // Cancellation of in-flight build is best-effort: the worker is
      // expected to honour its own cancellation signal. v0.2 just emits
      // the event; v0.3+ may add an AbortController.
      this.emit({ type: 'build-cancelled', runId });
    }
  }

  position(runId: string): number {
    if (this.currentRunId === runId) return 0;
    const idx = this.pending.findIndex((p) => p.runId === runId);
    if (idx < 0) return -1;
    return this.currentRunId === null ? idx : idx + 1;
  }

  subscribe(listener: (e: BuildEvent) => void): () => void {
    this.emitter.on('event', listener);
    return () => this.emitter.off('event', listener);
  }

  idle(): Promise<void> {
    return this.idlePromise;
  }

  private async tryDispatch(): Promise<void> {
    if (this.notOwner) return;
    if (this.currentRunId !== null) return;
    if (this.concurrency !== 1) throw new Error('concurrency > 1 not implemented in v0.2');
    const next = this.pending.shift();
    if (!next) {
      this.markIdle();
      return;
    }
    this.currentRunId = next.runId;
    // Same check before starting work as before recording it, and with the same
    // three outcomes: only `committed` (or an ephemeral queue, which owns
    // nothing and persists nothing) may dispatch. Dispatching on `blocked` is
    // how a superseded queue ran a build whose state on disk already named
    // another owner.
    const persisted = this.persist();
    if (persisted === 'superseded') {
      this.currentRunId = null;
      this.markIdle();
      return;
    }
    if (persisted === 'blocked') {
      // Transient: put the build back at the front and try again shortly.
      this.currentRunId = null;
      this.pending.unshift(next);
      this._retryDispatch(next.runId);
      return;
    }
    this.dispatchRetries.delete(next.runId);
    try {
      await this.worker(next.runId, (e) => this.emit(e));
    } catch (e) {
      this.emit({
        type: 'build-failed',
        runId: next.runId,
        phase: 'orchestrator',
        reason: (e as Error).message,
      });
    } finally {
      this.currentRunId = null;
      this.persist();
      void this.tryDispatch();
    }
  }

  /**
   * Re-attempt a dispatch that could not claim the state file.
   *
   * Bounded: a queue that cannot record what it is doing must eventually say so
   * rather than spinning, and the build is failed with the reason instead of
   * quietly never starting.
   */
  private _retryDispatch(runId: string): void {
    const attempts = (this.dispatchRetries.get(runId) ?? 0) + 1;
    this.dispatchRetries.set(runId, attempts);
    if (attempts > 8) {
      this.dispatchRetries.delete(runId);
      const idx = this.pending.findIndex((p) => p.runId === runId);
      if (idx >= 0) this.pending.splice(idx, 1);
      this.emit({
        type: 'build-failed',
        runId,
        phase: 'orchestrator',
        reason: 'the build queue state file stayed locked by another process; the build was not started',
      });
      if (this.pending.length === 0 && this.currentRunId === null) this.markIdle();
      return;
    }
    const timer = setTimeout(() => void this.tryDispatch(), 100 * attempts);
    if (typeof timer.unref === 'function') timer.unref();
  }

  private emit(e: BuildEvent): void {
    this.emitter.emit('event', e);
  }

  private markBusy(): void {
    if (this.idleResolve === null) {
      this.idlePromise = new Promise<void>((resolve) => {
        this.idleResolve = resolve;
      });
    }
  }

  private markIdle(): void {
    if (this.idleResolve) {
      this.idleResolve();
      this.idleResolve = null;
    }
  }
}
