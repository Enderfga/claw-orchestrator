/**
 * Windows npm-shim launch for engine CLIs.
 *
 * On Windows, `node:child_process` spawn cannot execute npm `.cmd` shims, so
 * `codex` and `opencode` failed with `spawn <bin> ENOENT` while true PE
 * executables (`claude.exe`, `agy.exe`) worked. `spawnEngine`/`execEngine`
 * route through cross-spawn, which resolves PATH/PATHEXT and escapes argv
 * for `cmd.exe` only when the target needs it.
 *
 * Coverage: direct executables keep argv intact on every platform (proving
 * non-Windows behaviour is unchanged), `.cmd` shims keep argv intact on
 * Windows — including spaces, quotes and shell metacharacters in args, cwd
 * and shim path — and the real codex/opencode npm shims launch. No test
 * here starts a real LLM session: `--version` and `node -e` probes only.
 */
import { describe, expect, it } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execEngine, spawnEngine } from '../engine-spawn.js';

const isWin = process.platform === 'win32';

/**
 * Args verified (battery-probed through a real `.cmd` shim) to round-trip
 * exactly: spaces, shell metacharacters, balanced quotes, unicode.
 * Deliberately EXCLUDED: unbalanced double-quotes (derail cmd.exe parsing)
 * and newlines (cmd.exe truncates the argument) — both are documented limits
 * of the shim path, not regressions: direct executables keep them intact.
 */
const SAFE_ARGS = ['a b', 'c&d', '100%', 'read "config" & go', "i'j", 'k|l', 'plain', 'ünïcodé'];

const ECHO_SCRIPT = `console.log(JSON.stringify({ argv: process.argv.slice(1), cwd: process.cwd() }));`;

function capture(child: ChildProcess): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    child.stderr?.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code: number | null) => resolve({ code, stdout, stderr }));
  });
}

/** True when a `.cmd`/`.exe` shim with this bare name is on PATH (npm global bin dir). */
function hasShim(name: string): boolean {
  const dirs = (process.env.PATH || '').split(isWin ? ';' : ':');
  const exts = isWin ? ['.cmd', '.exe'] : [''];
  return dirs.some((d) => exts.some((e) => d && existsSync(join(d.replace(/^"|"$/g, ''), name + e))));
}

/** Write a `.cmd` shim that forwards argv to a node echo script; dir name holds a space. */
function writeCmdFixture(): { cmdPath: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'clawo engine-spawn-'));
  const echoPath = join(dir, 'echo-argv.cjs');
  writeFileSync(echoPath, ECHO_SCRIPT, 'utf8');
  const cmdPath = join(dir, 'fake-engine.cmd');
  writeFileSync(cmdPath, `@echo off\r\n"${process.execPath}" "${echoPath}" %*\r\n`, 'utf8');
  return { cmdPath, dir };
}

describe('spawnEngine', () => {
  it('keeps argv and cwd intact through a direct executable', async () => {
    // Direct executables take the libuv path: everything round-trips,
    // including the unbalanced-quote and newline cases the .cmd path drops.
    const fullArgs = [...SAFE_ARGS, 'g"h', '', 'line1\nline2'];
    const cwd = mkdtempSync(join(tmpdir(), 'clawo cwd with spaces-'));
    try {
      const child = spawnEngine(process.execPath, ['-e', ECHO_SCRIPT, ...fullArgs], {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const { code, stdout } = await capture(child);
      expect(code).toBe(0);
      const parsed = JSON.parse(stdout) as { argv: string[]; cwd: string };
      expect(parsed.argv).toEqual(fullArgs);
      expect(parsed.cwd).toBe(cwd);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it.runIf(isWin)('keeps argv intact through a .cmd shim in a path with spaces', async () => {
    const { cmdPath, dir } = writeCmdFixture();
    try {
      // No unbalanced quotes or newlines: documented cmd.exe limits.
      // The shim forwards `%*` to node, so argv[0] is the echo script itself.
      const expected = [...SAFE_ARGS, ''];
      const child = spawnEngine(cmdPath, expected, { stdio: ['ignore', 'pipe', 'pipe'] });
      const { code, stdout, stderr } = await capture(child);
      expect(`${code} ${stderr}`).toBe('0 ');
      const parsed = JSON.parse(stdout) as { argv: string[] };
      expect(parsed.argv).toEqual([join(dir, 'echo-argv.cjs'), ...expected]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.runIf(isWin && hasShim('codex'))('launches the real codex npm shim', async () => {
    const { stdout, stderr } = await execEngine('codex', ['--version'], { timeout: 30_000 });
    expect(`${stdout}${stderr}`).toMatch(/codex/i);
  });

  it.runIf(isWin && hasShim('opencode'))('launches the real opencode npm shim', async () => {
    const { stdout, stderr } = await execEngine('opencode', ['--version'], { timeout: 30_000 });
    expect(`${stdout}${stderr}`).toMatch(/\d+\.\d+/);
  });
});

describe('execEngine', () => {
  it('captures stdout/stderr and resolves on exit 0', async () => {
    const res = await execEngine(process.execPath, ['-e', 'console.log("out");console.error("err")']);
    expect(res.stdout).toContain('out');
    expect(res.stderr).toContain('err');
  });

  it('rejects on non-zero exit with code, stdout and stderr attached', async () => {
    const err = await execEngine(process.execPath, ['-e', 'console.log("o");console.error("e");process.exit(3)']).then(
      () => null,
      (e: unknown) => e as Error & { code: number; stdout: string; stderr: string },
    );
    expect(err).not.toBeNull();
    expect(err?.code).toBe(3);
    expect(err?.stdout).toContain('o');
    expect(err?.stderr).toContain('e');
  });

  it('rejects on timeout', async () => {
    const err = await execEngine(process.execPath, ['-e', 'setTimeout(()=>{},30000)'], { timeout: 500 }).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err?.message).toMatch(/timed out/);
  });

  it('rejects on maxBuffer overrun', async () => {
    const err = await execEngine(process.execPath, ['-e', 'console.log("x".repeat(100000))'], {
      maxBuffer: 1024,
    }).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err?.message).toMatch(/maxBuffer/);
  });

  it('rejects when the binary does not exist', async () => {
    const err = await execEngine('clawo-definitely-missing-binary-xyz', []).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err).not.toBeNull();
  });
});
