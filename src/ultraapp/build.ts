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

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
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
  onNotOwner?: (owner: { pid: number; renewedAt: string }) => void;
}

interface PendingItem {
  runId: string;
}

interface PersistedQueue {
  pending: string[];
  /** The build that was running when the state was last written. */
  current: string | null;
  /** Who is executing this queue. */
  owner?: { pid: number; renewedAt: string };
}

/** How long an owner may go without a heartbeat before the queue is up for grabs. */
const OWNER_TTL_MS = 60_000;

function ownerIsLive(owner: PersistedQueue['owner']): boolean {
  if (!owner) return false;
  if (owner.pid === process.pid) return true;
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
  private idlePromise: Promise<void> = Promise.resolve();
  private idleResolve: (() => void) | null = null;

  constructor(opts: UltraappBuildQueueOptions) {
    this.worker = opts.worker;
    this.concurrency = opts.concurrency ?? 1;
    this.statePath = opts.statePath;
    const restored = this.restore();
    if (this.notOwner) opts.onNotOwner?.(this.notOwner);
    if (restored.length > 0) {
      opts.onRestore?.(restored);
      this.markBusy();
      void this.tryDispatch();
    }
  }

  /** Set when another live process holds the queue. */
  private notOwner?: { pid: number; renewedAt: string };

  /** True when this process is executing the queue. */
  ownsQueue(): boolean {
    return !this.notOwner;
  }

  /**
   * Read back a queue left by a previous process.
   *
   * A build that was in flight goes to the FRONT of the restored queue: it was
   * asked for first, and the user has been waiting on it longest.
   */
  private restore(): string[] {
    if (!this.statePath) return [];
    let raw: string;
    try {
      raw = fs.readFileSync(this.statePath, 'utf8');
    } catch {
      return [];
    }
    let parsed: PersistedQueue;
    try {
      parsed = JSON.parse(raw) as PersistedQueue;
    } catch {
      return [];
    }
    if (ownerIsLive(parsed.owner) && parsed.owner!.pid !== process.pid) {
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
    return ids;
  }

  /** Best-effort, like every other log write here: never break a build over it. */
  private persist(): void {
    if (!this.statePath) return;
    try {
      fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
      const state: PersistedQueue = {
        pending: this.pending.map((p) => p.runId),
        current: this.currentRunId,
        // Every write is also the heartbeat, so a queue that stops making
        // progress stops holding the claim.
        owner: { pid: process.pid, renewedAt: new Date().toISOString() },
      };
      const tmp = `${this.statePath}.tmp.${process.pid}`;
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
    this.pending.push({ runId });
    this.persist();
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
    if (this.currentRunId !== null) return;
    if (this.concurrency !== 1) throw new Error('concurrency > 1 not implemented in v0.2');
    const next = this.pending.shift();
    if (!next) {
      this.markIdle();
      return;
    }
    this.currentRunId = next.runId;
    this.persist();
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
