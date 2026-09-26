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
 * but an UNBALANCED double-quote derails the whole command line. Newlines
 * cannot pass through `cmd.exe` at all, so `spawnEngine`/`execEngine`
 * flatten `\r\n`/`\n` to spaces for batch targets only (detected via
 * PATH/PATHEXT lookup in `isWindowsBatchTarget`) — every word survives,
 * line structure does not. Direct executables keep byte-identical argv.
 * This is still strictly better than the previous unconditional ENOENT.
 */
import crossSpawn from 'cross-spawn';
import { statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import type { ChildProcess, SpawnOptions } from 'node:child_process';

/** Extensions CreateProcess runs directly — everything else needs cmd.exe. */
const DIRECT_EXEC_EXTS = new Set(['.exe', '.com']);
const BATCH_EXTS = new Set(['.cmd', '.bat']);

/** Lower-cased extension, '' when the name has none. */
function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  const j = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'));
  return i > j ? name.slice(i).toLowerCase() : '';
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * True when `bin` will run through `cmd.exe` on Windows (npm `.cmd` shims,
 * extensionless shell shims, …) rather than launching directly. On other
 * platforms always false. `env`/`cwd` mirror what the child process will see,
 * so the verdict matches cross-spawn's own resolution.
 */
export function isWindowsBatchTarget(
  bin: string,
  env: NodeJS.ProcessEnv = process.env,
  cwd?: string,
): boolean {
  if (process.platform !== 'win32' || !bin) return false;
  const pathext = (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.startsWith('.'));
  // An exact hit decides first: a real `.exe` next to a shim name wins.
  const dirs: string[] = [];
  if (/[\\/]/.test(bin)) {
    dirs.push(isAbsolute(bin) ? '' : (typeof cwd === 'string' ? cwd : process.cwd()));
  } else {
    const raw = env.PATH ?? env.Path ?? '';
    for (const d of raw.split(';')) {
      const dir = d.trim().replace(/^"|"$/g, '');
      if (dir) dirs.push(dir);
    }
  }
  for (const dir of dirs) {
    const base = dir ? join(dir, bin) : bin;
    const ordered = [base, ...pathext.map((e) => base + e)];
    for (const candidate of ordered) {
      const resolved = dir && !isAbsolute(candidate) ? resolve(candidate) : candidate;
      if (!isFile(dir ? resolved : candidate)) continue;
      const ext = extOf(candidate);
      if (!ext) return true; // extensionless shim: not directly executable
      if (DIRECT_EXEC_EXTS.has(ext)) return false;
      if (BATCH_EXTS.has(ext)) return true;
      return true; // .ps1, .js, … : cmd.exe cannot run them directly either
    }
  }
  return false; // unresolved: leave cross-spawn's own error path untouched
}

/**
 * Newlines do not survive `cmd.exe` — it truncates the argument at the first
 * one. Flattening to spaces keeps every word (formatting is degraded, content
 * is complete), which strictly dominates the silent truncation. Applied only
 * to batch targets; direct executables keep byte-identical argv.
 */
function flattenNewlines(args: string[]): string[] {
  return args.map((a) => a.replace(/\r\n|[\r\n]/g, ' '));
}

function prepareArgs(
  bin: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string | undefined,
): string[] {
  return isWindowsBatchTarget(bin, env, cwd) ? flattenNewlines(args) : args;
}

/**
 * Streaming spawn for engine CLIs. Same signature and return type as
 * `node:child_process` spawn, so call sites change by one import line.
 */
export function spawnEngine(bin: string, args: string[], options: SpawnOptions): ChildProcess {
  const env = options.env ?? process.env;
  const cwd = typeof options.cwd === 'string' ? options.cwd : undefined;
  return crossSpawn(bin, prepareArgs(bin, args, env, cwd), options);
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
      const childEnv = env ?? process.env;
      child = crossSpawn(bin, prepareArgs(bin, args, childEnv, cwd), {
        cwd,
        env: childEnv,
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
