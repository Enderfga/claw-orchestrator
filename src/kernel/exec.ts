/**
 * The one child-process wrapper.
 *
 * Before this module the repo had four, with three different failure contracts:
 * `council.ts` `spawnAsync` rejects on a non-zero exit (so every caller wraps it
 * in `.catch(() => ({stdout:'',stderr:''}))` and loses the exit code),
 * `autoloop/dispatcher.ts` `runGit` returns `{code,out,err}`, and ultraapp had
 * both a `spawnSync` and its own `realShell`. This takes the non-throwing shape
 * — a non-zero exit is data, not an exception — and adds the two things none of
 * them had: a timeout that actually kills, and a cap on captured output.
 *
 * Kill discipline follows the same rule as the rest of our recovery paths: a
 * wedged process does not respond to SIGTERM, and killing only the direct child
 * orphans its grandchildren (an `npm test` that spawned a watcher). So the child
 * gets its own process group via `detached` and the timeout kills the group with
 * SIGKILL.
 */

import { spawn } from 'node:child_process';

export interface ExecResult {
  code: number | null;
  out: string;
  err: string;
  /** True when the timeout fired. `code` is then the signal-terminated null. */
  timedOut: boolean;
  durationMs: number;
}

export interface ExecOptions {
  cwd?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  /** Fed to the child's stdin and then closed. */
  input?: string;
  /** Per-stream capture cap. Older bytes are dropped, keeping the tail. */
  maxCaptureBytes?: number;
}

/** Only the tail of output is ever used, so a runaway printer cannot OOM us. */
export const MAX_CAPTURE_BYTES = 512 * 1024;
export const DEFAULT_EXEC_TIMEOUT_MS = 10 * 60_000;

function appendCapped(buf: string, chunk: string, cap: number): string {
  const next = buf + chunk;
  return next.length > cap ? next.slice(next.length - cap) : next;
}

/**
 * Kill the child's whole process group, falling back to the bare pid when the
 * platform refused to give us a group (Windows, or a spawn that never started).
 */
function killTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    process.kill(-pid, 'SIGKILL');
    return;
  } catch {
    // No process group — fall through to the direct kill.
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Already gone.
  }
}

/** Run a command. Never throws: a spawn failure comes back as `code: null` with the message in `err`. */
export function exec(cmd: string, args: string[] = [], opts: ExecOptions = {}): Promise<ExecResult> {
  const cap = opts.maxCaptureBytes ?? MAX_CAPTURE_BYTES;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
  const startedAt = Date.now();

  return new Promise<ExecResult>((resolve) => {
    let out = '';
    let err = '';
    let timedOut = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ code, out, err, timedOut, durationMs: Date.now() - startedAt });
    };

    let child;
    try {
      child = spawn(cmd, args, {
        cwd: opts.cwd,
        env: opts.env ?? process.env,
        stdio: [opts.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        // Own process group, so the timeout can take the whole tree down.
        detached: process.platform !== 'win32',
      });
    } catch (e) {
      err = (e as Error).message;
      finish(null);
      return;
    }

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        err = appendCapped(err, `\n[exec] timed out after ${timeoutMs}ms — killed\n`, cap);
        killTree(child.pid);
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
    }

    child.stdout?.on('data', (d: Buffer) => (out = appendCapped(out, d.toString(), cap)));
    child.stderr?.on('data', (d: Buffer) => (err = appendCapped(err, d.toString(), cap)));
    child.on('error', (e: Error) => {
      err = appendCapped(err, e.message, cap);
      finish(null);
    });
    child.on('close', (code: number | null) => finish(code));

    if (opts.input !== undefined && child.stdin) {
      child.stdin.end(opts.input);
    }
  });
}

/** Convenience for the common "did it exit 0" question. */
export async function execOk(cmd: string, args: string[] = [], opts: ExecOptions = {}): Promise<boolean> {
  const r = await exec(cmd, args, opts);
  return r.code === 0;
}

/** Last N lines of a string — the shape every failure tail wants. */
export function lastLines(s: string, n: number): string {
  const lines = s.split('\n');
  return lines.length <= n ? s : lines.slice(-n).join('\n');
}
