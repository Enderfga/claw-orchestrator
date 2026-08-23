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
}

interface PendingItem {
  runId: string;
}

interface PersistedQueue {
  pending: string[];
  /** The build that was running when the state was last written. */
  current: string | null;
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
    if (restored.length > 0) {
      opts.onRestore?.(restored);
      this.markBusy();
      void this.tryDispatch();
    }
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
      const state: PersistedQueue = { pending: this.pending.map((p) => p.runId), current: this.currentRunId };
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
