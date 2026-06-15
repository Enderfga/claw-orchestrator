/**
 * Cross-platform engine process spawning.
 *
 * On Windows, npm-installed coding CLIs are launched through `.cmd` shims, not by
 * a real executable on the bare name. Node's `child_process.spawn` cannot launch a
 * `.cmd` by bare name, and since Node 18.20 / 20.12 / 22 it refuses to run
 * `.cmd`/`.bat` without `shell: true` — but `shell: true` concatenates (does not
 * escape) arguments, which corrupts prompts containing shell metacharacters
 * (`& | < > ^ % "`) and breaks stdin piping. So `shell: true` is never used.
 *
 * Instead we resolve the shim to the **real** program it wraps and spawn that
 * directly:
 *   - `claude.cmd` / `opencode.cmd` exec a native `.exe`  → spawn the `.exe`.
 *   - `codex.cmd` / `gemini.cmd` exec `node <pkg>/bin/x.js` → spawn `node` with the
 *     script path prepended to the args.
 *   - a real `.exe` already on PATH (e.g. `kimi.exe`)      → spawn it directly.
 *
 * If a `.cmd`/`.bat` shim cannot be resolved to a real target, we throw a clear
 * error (rather than silently falling back to an unsafe shell) so the caller can
 * point the engine's `*_BIN` at the real executable.
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
}

/** Expand the `%dp0%` / `%~dp0%` shim variable to the shim's own directory. */
function expandDp0(raw: string, dir: string): string {
  return path.normalize(raw.replace(/%~?dp0%/gi, dir + path.sep));
}

/**
 * Resolve `node` for a node-based shim. Honors a node colocated with the shim
 * (as the shim itself does), then the Node already running the orchestrator
 * (guaranteed version-compatible), then PATH.
 */
function resolveNode(shimDir: string): string {
  const local = path.join(shimDir, 'node.exe');
  if (fs.existsSync(local)) return local;
  if (/[\\/]node(\.exe)?$/i.test(process.execPath)) return process.execPath;
  for (const dir of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, 'node.exe');
    if (fs.existsSync(candidate)) return candidate;
  }
  return 'node';
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

  // node-based shim: the entrypoint is the LAST quoted `.js` on the exec line
  // (npm puts the script as the final quoted token before `%*`).
  const jsMatches = [...content.matchAll(/"(%~?dp0%[^"]*?\.js)"/gi)];
  if (jsMatches.length) {
    const script = expandDp0(jsMatches[jsMatches.length - 1][1], dir);
    if (fs.existsSync(script)) return { command: resolveNode(dir), prefixArgs: [script] };
  }

  // native shim: a real `.exe` target that is not the node interpreter itself.
  for (const m of content.matchAll(/"(%~?dp0%[^"]*?\.exe)"/gi)) {
    const exe = expandDp0(m[1], dir);
    if (/[\\/]node\.exe$/i.test(exe)) continue;
    if (fs.existsSync(exe)) return { command: exe, prefixArgs: [] };
  }

  return null;
}

function unresolvable(shim: string): never {
  throw new Error(
    `Cannot resolve Windows shim "${shim}" to a real executable. ` +
      `Set the engine's *_BIN env var (or bin config) to the real .exe.`,
  );
}

/**
 * Resolve an engine binary name to a directly-spawnable command. No-op on
 * non-Windows platforms (returns the bin unchanged). Throws if a Windows
 * `.cmd`/`.bat` shim cannot be resolved to a real target.
 */
export function resolveEngineBin(bin: string): ResolvedSpawn {
  if (process.platform !== 'win32') return { command: bin, prefixArgs: [] };

  // Explicit path: resolve a shim, else spawn directly.
  if (path.isAbsolute(bin) || bin.includes('/') || bin.includes('\\')) {
    if (/\.(cmd|bat)$/i.test(bin)) return resolveShim(bin) ?? unresolvable(bin);
    return { command: bin, prefixArgs: [] };
  }

  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);

  // 1) A real .exe/.com already on PATH (e.g. kimi.exe) — spawn directly.
  for (const dir of dirs) {
    for (const ext of ['.exe', '.com']) {
      const candidate = path.join(dir, bin + ext);
      if (fs.existsSync(candidate)) return { command: candidate, prefixArgs: [] };
    }
  }

  // 2) A .cmd/.bat shim — resolve the real program it wraps.
  for (const dir of dirs) {
    for (const ext of ['.cmd', '.bat']) {
      const candidate = path.join(dir, bin + ext);
      if (fs.existsSync(candidate)) return resolveShim(candidate) ?? unresolvable(candidate);
    }
  }

  // 3) Not found — let spawn surface a clear ENOENT.
  return { command: bin, prefixArgs: [] };
}

/** Spawn an engine process, transparently resolving Windows npm shims. */
export function spawnEngine(bin: string, args: readonly string[], options: SpawnOptions): ChildProcess {
  const { command, prefixArgs } = resolveEngineBin(bin);
  return spawn(command, [...prefixArgs, ...args], options);
}
