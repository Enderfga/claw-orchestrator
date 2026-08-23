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
  /**
   * Which file we created, so releasing can never remove someone else's.
   *
   * Unlinking by path is not release, it is "delete whatever is called that" —
   * and the two stop being the same file the moment anything else can break a
   * lock.
   */
  let ino: number | undefined;
  let lastError = 'lock is held by another process';
  for (;;) {
    // Checked once per iteration, before anything can `continue` past it. Two
    // of the retry paths below used to skip it, which made this loop unbounded
    // in exactly the case it exists for: another process churning the lock file
    // meant the vanished-lock branch retried forever, with no deadline and no
    // yield. On a two-core CI runner that pegged a core and starved the test
    // runner for fourteen minutes — a busy-wait that a comment described as
    // "waits before giving up".
    if (Date.now() >= deadline) return { ok: false, reason: 'contended', error: lastError };

    try {
      if (opts.createParent) fs.mkdirSync(path.dirname(lockPath), { recursive: true });
      fd = fs.openSync(lockPath, 'wx');
      ino = fs.fstatSync(fd).ino;
      break;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') return { ok: false, reason: 'contended', error: (err as Error).message };

      let age: number;
      try {
        age = Date.now() - fs.statSync(lockPath).mtimeMs;
      } catch {
        // The lock vanished between our EEXIST and this stat: its holder
        // released it. Retry the create — whoever gets there first wins.
        //
        // Treating this as "stale, therefore delete it" is what broke mutual
        // exclusion. By the time we looked, another caller had already created
        // *their* lock; deleting it and creating ours put two callers inside the
        // section at once. That is not a theoretical hazard — under two
        // processes committing in a loop it happened several times a second, and
        // one of them recursively removing its staging directory would empty the
        // transaction directory the other had just published, wedging the run.
        lastError = 'lock was being released and retaken';
        sleepSync(1);
        continue;
      }

      if (age >= staleMs) {
        // Debris from a holder that died inside the section. Broken by an atomic
        // rename rather than an unlink, so two waiters deciding the same thing
        // at the same moment cannot both delete-then-create: only one rename can
        // succeed, and the O_EXCL create still decides the winner either way.
        try {
          fs.renameSync(lockPath, `${lockPath}.stale.${process.pid}.${Date.now().toString(36)}`);
        } catch {
          // Someone else got there first; just retry the create.
        }
        lastError = `broke a lock abandoned for ${Math.round(age)}ms`;
        sleepSync(1);
        continue;
      }

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
    try {
      // Only if it is still the file we created. If a stale-breaker moved ours
      // aside and another caller has since made its own, removing "the lock" by
      // name would remove theirs while they are still inside it.
      if (fs.statSync(lockPath).ino === ino) fs.rmSync(lockPath, { force: true });
    } catch {
      // Already gone.
    }
  }
}
