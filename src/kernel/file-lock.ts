/**
 * A file lock with a bounded wait.
 *
 * Two callers need exactly this — the run store and the ultraapp build queue —
 * and both had their own copy, which is how they also had the same bug twice:
 * a lock that was merely *busy* was reported the same way as a lock we had lost
 * the right to. Those are different facts. Contention is transient and the
 * correct response is to wait; losing ownership is permanent and the correct
 * response is to stop. Collapsing them into one boolean meant a run that hit a
 * millisecond of contention stopped forever while still holding its lease, so
 * nothing else could take it over either.
 *
 * So this returns a result, not a boolean, and it waits before giving up. The
 * critical sections it guards are a few small writes, so real contention is
 * measured in microseconds; the default wait is three orders of magnitude more
 * than that, and reaching the end of it means something is genuinely wrong
 * rather than merely busy.
 */

import fs from 'node:fs';
import path from 'node:path';

export type LockResult<T> = { ok: true; value: T } | { ok: false; reason: 'contended'; error: string };

export interface FileLockOptions {
  /** A lock file older than this belongs to a crashed holder and is broken. */
  staleMs?: number;
  /** How long to keep trying before reporting contention. */
  waitMs?: number;
  /**
   * Create the lock file's directory if it is missing.
   *
   * Off by default, and that default matters: locking inside a directory that
   * has been deleted must not recreate it. A run whose teardown raced its own
   * last write came back as an empty directory, which then made the run id
   * permanently unusable — the id looked taken by a run that did not exist.
   */
  createParent?: boolean;
}

export const DEFAULT_LOCK_STALE_MS = 60_000;
export const DEFAULT_LOCK_WAIT_MS = 250;

/**
 * Block this thread for `ms`.
 *
 * Deliberately synchronous: every caller of `withFileLock` is a synchronous
 * write path (a checkpoint, a queue persist) reached from callbacks that cannot
 * be made async without changing the node-context API. The waits are single
 * -digit milliseconds and only happen under real contention.
 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Run `fn` while holding an exclusive lock file, waiting briefly for it.
 *
 * `ok: false` means only "could not enter the critical section" — never "you no
 * longer own this". Callers must not treat it as a loss.
 */
export function withFileLock<T>(lockPath: string, fn: () => T, opts: FileLockOptions = {}): LockResult<T> {
  const staleMs = opts.staleMs ?? DEFAULT_LOCK_STALE_MS;
  const waitMs = opts.waitMs ?? DEFAULT_LOCK_WAIT_MS;
  const deadline = Date.now() + waitMs;

  let fd: number | undefined;
  let lastError = 'lock is held by another process';
  for (;;) {
    try {
      if (opts.createParent) fs.mkdirSync(path.dirname(lockPath), { recursive: true });
      fd = fs.openSync(lockPath, 'wx');
      break;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') return { ok: false, reason: 'contended', error: (err as Error).message };
      let age = Infinity;
      try {
        age = Date.now() - fs.statSync(lockPath).mtimeMs;
      } catch {
        age = Infinity;
      }
      if (age >= staleMs) {
        // Debris from a holder that died inside the section.
        fs.rmSync(lockPath, { force: true });
        continue;
      }
      if (Date.now() >= deadline) return { ok: false, reason: 'contended', error: lastError };
      lastError = `lock held by another process for ${Math.round(age)}ms`;
      sleepSync(5);
    }
  }

  try {
    return { ok: true, value: fn() };
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // Already closed; the unlink below is what matters.
    }
    fs.rmSync(lockPath, { force: true });
  }
}
