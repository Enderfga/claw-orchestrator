/**
 * Cross-platform engine process spawning.
 *
 * On Windows, npm-installed coding CLIs are launched through `.cmd` shims, not by
 * a real executable on the bare name. Node's `child_process.spawn` cannot launch a
 * `.cmd` by bare name, and since Node 18.20 / 20.12 / 22 it refuses to run
 * `.cmd`/`.bat` without `shell: true` — but `shell: true` concatenates (does not
 * escape) arguments and breaks stdin piping, so it is not a reliable fix.
 *
 * Instead we resolve the shim to the **real** program it wraps and spawn that
 * directly (no shell):
 *   - `claude.cmd` / `opencode.cmd` exec a native `.exe`  → spawn the `.exe`.
 *   - `codex.cmd` / `gemini.cmd` exec `node <pkg>/bin/x.js` → spawn `node` with the
 *     script path prepended to the args.
 *   - a real `.exe` already on PATH (e.g. `kimi.exe`)      → spawn it directly.
 *
 * On non-Windows platforms this is a thin passthrough to `spawn()`.
 */

import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface ResolvedSpawn {
  /** Executable to spawn — a real `.exe` (or `node`) on Windows when resolvable. */
  command: string;
  /** Args to prepend (e.g. the `.js` script for node-based npm shims). */
  prefixArgs: string[];
  /** Last-resort shell fallback when a shim could not be resolved. */
  useShell: boolean;
}

/** Expand the `%dp0%` / `%~dp0%` shim variable to the shim's own directory. */
function expandDp0(raw: string, dir: string): string {
  return path.normalize(raw.replace(/%~?dp0%/gi, dir + path.sep));
}

/** Resolve `node` to a concrete `node.exe` (prefer one colocated with the shim). */
function resolveNode(shimDir: string): string {
  const local = path.join(shimDir, 'node.exe');
  if (fs.existsSync(local)) return local;
  for (const dir of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, 'node.exe');
    if (fs.existsSync(candidate)) return candidate;
  }
  return process.execPath || 'node';
}

/** Parse an npm `.cmd`/`.bat` shim and return the real program it execs, if any. */
function resolveShim(cmdPath: string): ResolvedSpawn | null {
  let content: string;
  try {
    content = fs.readFileSync(cmdPath, 'utf8');
  } catch {
    return null;
  }
  const dir = path.dirname(cmdPath);

  // node-based shim: prefer the wrapped `.js` script (ignore the node.exe interpreter).
  const jsMatch = content.match(/"(%~?dp0%[^"]*?\.js)"/i);
  if (jsMatch) {
    const script = expandDp0(jsMatch[1], dir);
    if (fs.existsSync(script)) {
      return { command: resolveNode(dir), prefixArgs: [script], useShell: false };
    }
  }

  // native shim: a real `.exe` target that is not the node interpreter itself.
  for (const m of content.matchAll(/"(%~?dp0%[^"]*?\.exe)"/gi)) {
    const exe = expandDp0(m[1], dir);
    if (/[\\/]node\.exe$/i.test(exe)) continue;
    if (fs.existsSync(exe)) return { command: exe, prefixArgs: [], useShell: false };
  }

  return null;
}

/**
 * Resolve an engine binary name to a directly-spawnable command. No-op on
 * non-Windows platforms (returns the bin unchanged, no shell).
 */
export function resolveEngineBin(bin: string): ResolvedSpawn {
  if (process.platform !== 'win32') return { command: bin, prefixArgs: [], useShell: false };

  // Explicit path: resolve a shim, else spawn directly.
  if (path.isAbsolute(bin) || bin.includes('/') || bin.includes('\\')) {
    if (/\.(cmd|bat)$/i.test(bin)) return resolveShim(bin) ?? { command: bin, prefixArgs: [], useShell: true };
    return { command: bin, prefixArgs: [], useShell: false };
  }

  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);

  // 1) A real .exe/.com already on PATH (e.g. kimi.exe) — spawn directly.
  for (const dir of dirs) {
    for (const ext of ['.exe', '.com', '.EXE', '.COM']) {
      const candidate = path.join(dir, bin + ext);
      if (fs.existsSync(candidate)) return { command: candidate, prefixArgs: [], useShell: false };
    }
  }

  // 2) A .cmd/.bat shim — resolve the real program it wraps.
  for (const dir of dirs) {
    for (const ext of ['.cmd', '.bat', '.CMD', '.BAT']) {
      const candidate = path.join(dir, bin + ext);
      if (fs.existsSync(candidate)) {
        return resolveShim(candidate) ?? { command: candidate, prefixArgs: [], useShell: true };
      }
    }
  }

  // 3) Not found — let spawn try as-is.
  return { command: bin, prefixArgs: [], useShell: false };
}

/** Spawn an engine process, transparently resolving Windows npm shims. */
export function spawnEngine(bin: string, args: readonly string[], options: SpawnOptions): ChildProcess {
  const { command, prefixArgs, useShell } = resolveEngineBin(bin);
  return spawn(command, [...prefixArgs, ...args], { ...options, shell: useShell });
}
