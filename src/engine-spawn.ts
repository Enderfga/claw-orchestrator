/**
 * Engine process launcher — the one place engine CLIs get spawned.
 *
 * Why this module exists: on Windows, `node:child_process` spawn/execFile
 * cannot launch npm `.cmd` shims (`codex`, `opencode`). A bare name fails
 * with `spawn <bin> ENOENT` and an absolute path fails with `EINVAL`,
 * because only true PE executables run without a shell — while Claude
 * (`claude.exe`) and Antigravity (`agy.exe`) work fine. The `*_BIN` env
 * overrides (`CODEX_BIN`, `OPENCODE_BIN`, …) cannot fix this on their own:
 * resolution was never the problem, execution without a shell is.
 *
 * `shell: true` is deliberately NOT the fix: Node concatenates argv without
 * escaping (DEP0190), so a bin path with spaces breaks and metacharacters
 * (`&`, `%VAR%`, quotes) in prompts become injections. cross-spawn instead
 * resolves PATH/PATHEXT itself and escapes argv for `cmd.exe` only when the
 * target needs it; direct executables — and every non-Windows spawn — behave
 * exactly like `node:child_process`.
 *
 * Bins stay operator-controlled (config, env, PATH); argv is never
 * string-concatenated here, so no agent-controlled text reaches a shell.
 *
 * Known cmd.exe limits on the shim path (verified, see engine-spawn.test.ts):
 * arguments keep spaces, balanced quotes, `&|;%`, unicode and empty strings,
 * but an UNBALANCED double-quote derails the whole command line and a
 * NEWLINE truncates the argument — multi-line prompts lose everything after
 * the first line. Single-line missions are unaffected; this is still strictly
 * better than the previous unconditional ENOENT.
 */
import crossSpawn from 'cross-spawn';
import type { ChildProcess, SpawnOptions } from 'node:child_process';

/**
 * Streaming spawn for engine CLIs. Same signature and return type as
 * `node:child_process` spawn, so call sites change by one import line.
 */
export function spawnEngine(bin: string, args: string[], options: SpawnOptions): ChildProcess {
  return crossSpawn(bin, args, options);
}

export interface ExecEngineOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** 0 (default) disables the timeout. */
  timeout?: number;
  /** stdout+stderr cap in bytes, execFile-style. */
  maxBuffer?: number;
}

export interface ExecEngineResult {
  stdout: string;
  stderr: string;
}

/**
 * execFile-style capture exec for engine CLIs (one-shot `codex` helpers).
 * Rejects like execFile does: spawn failure, timeout, non-zero exit and
 * maxBuffer overrun all throw, with `stdout`/`stderr`/`code` attached.
 */
export function execEngine(bin: string, args: string[], opts: ExecEngineOptions = {}): Promise<ExecEngineResult> {
  const { cwd, env, timeout = 0, maxBuffer = 32 * 1024 * 1024 } = opts;
  return new Promise<ExecEngineResult>((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const fail = (message: string, code: number | null): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      const err = new Error(message) as Error & {
        code: number | null;
        stdout: string;
        stderr: string;
      };
      err.code = code;
      err.stdout = stdout;
      err.stderr = stderr;
      reject(err);
    };

    let child: ChildProcess;
    try {
      child = crossSpawn(bin, args, {
        cwd,
        env: env ?? process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
      return;
    }

    if (timeout > 0) {
      timer = setTimeout(() => {
        try {
          child.kill('SIGTERM');
        } catch {
          // Already gone — the close handler settles below.
        }
        fail(`execEngine: timed out after ${timeout}ms: ${bin}`, null);
      }, timeout);
      if (typeof timer.unref === 'function') timer.unref();
    }

    const onData = (chunk: Buffer, stream: 'out' | 'err'): void => {
      const text = chunk.toString('utf8');
      if (stream === 'out') stdout += text;
      else stderr += text;
      if (stdout.length + stderr.length > maxBuffer) {
        try {
          child.kill('SIGTERM');
        } catch {
          // Already gone.
        }
        fail(`execEngine: maxBuffer ${maxBuffer} bytes exceeded: ${bin}`, null);
      }
    };
    child.stdout?.on('data', (d: Buffer) => onData(d, 'out'));
    child.stderr?.on('data', (d: Buffer) => onData(d, 'err'));
    child.on('error', (e: Error) => fail(`execEngine: ${e.message}`, null));
    child.on('close', (code: number | null) => {
      if (settled) return;
      if (timer) clearTimeout(timer);
      if (code === 0) {
        settled = true;
        resolve({ stdout, stderr });
      } else {
        fail(`execEngine: ${bin} exited with code ${code}: ${stderr.trim().slice(0, 500)}`, code);
      }
    });
  });
}
