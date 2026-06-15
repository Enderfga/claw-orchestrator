/**
 * Unit tests for the Windows-aware engine spawn resolver.
 *
 * Mocks node:fs so the resolution logic can be exercised without a real
 * filesystem, and overrides process.platform per-test. Paths are built with
 * path.join so assertions hold on both POSIX (CI) and Windows runtimes.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';

const existsSync = vi.fn();
const readFileSync = vi.fn();
vi.mock('node:fs', () => ({
  existsSync: (p: string) => existsSync(p),
  readFileSync: (p: string, enc: string) => readFileSync(p, enc),
}));

const { resolveEngineBin } = await import('../engine-spawn.js');

const ORIG_PLATFORM = process.platform;
function setPlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: p, configurable: true });
}

describe('resolveEngineBin', () => {
  const origPath = process.env.PATH;

  beforeEach(() => {
    existsSync.mockReset();
    readFileSync.mockReset();
  });

  afterEach(() => {
    setPlatform(ORIG_PLATFORM);
    process.env.PATH = origPath;
  });

  it('is a no-op on non-Windows platforms', () => {
    setPlatform('linux');
    expect(resolveEngineBin('claude')).toEqual({ command: 'claude', prefixArgs: [] });
  });

  it('resolves a bare name to a real .exe already on PATH', () => {
    setPlatform('win32');
    const dir = path.join('C:', 'bin');
    process.env.PATH = dir;
    const exe = path.join(dir, 'kimi.exe');
    existsSync.mockImplementation((p: string) => p === exe);

    expect(resolveEngineBin('kimi')).toEqual({ command: exe, prefixArgs: [] });
  });

  it('resolves a .cmd shim that wraps a native .exe', () => {
    setPlatform('win32');
    const dir = path.join('C:', 'npm');
    process.env.PATH = dir;
    const cmd = path.join(dir, 'claude.cmd');
    const exe = path.join(dir, 'node_modules/@anthropic-ai/claude-code/bin/claude.exe');
    existsSync.mockImplementation((p: string) => p === cmd || p === exe);
    readFileSync.mockReturnValue('@ECHO off\n"%dp0%/node_modules/@anthropic-ai/claude-code/bin/claude.exe"   %*\n');

    expect(resolveEngineBin('claude')).toEqual({ command: exe, prefixArgs: [] });
  });

  it('resolves a .cmd shim that wraps node + a .js script', () => {
    setPlatform('win32');
    const dir = path.join('C:', 'npm');
    process.env.PATH = dir;
    const cmd = path.join(dir, 'codex.cmd');
    const js = path.join(dir, 'node_modules/@openai/codex/bin/codex.js');
    const node = path.join(dir, 'node.exe');
    existsSync.mockImplementation((p: string) => p === cmd || p === js || p === node);
    readFileSync.mockReturnValue('"%dp0%/node.exe" "%dp0%/node_modules/@openai/codex/bin/codex.js" %*');

    expect(resolveEngineBin('codex')).toEqual({ command: node, prefixArgs: [js] });
  });

  it('ignores the node.exe interpreter when picking the native target', () => {
    setPlatform('win32');
    const dir = path.join('C:', 'npm');
    process.env.PATH = dir;
    const cmd = path.join(dir, 'opencode.cmd');
    const exe = path.join(dir, 'node_modules/opencode-ai/bin/opencode.exe');
    const node = path.join(dir, 'node.exe');
    existsSync.mockImplementation((p: string) => p === cmd || p === exe || p === node);
    // Shim references node.exe in an IF EXIST guard, then execs the real opencode.exe.
    readFileSync.mockReturnValue(
      'IF EXIST "%dp0%/node.exe" ()\n"%dp0%/node_modules/opencode-ai/bin/opencode.exe"   %*\n',
    );

    expect(resolveEngineBin('opencode')).toEqual({ command: exe, prefixArgs: [] });
  });

  it('picks the entrypoint (last) .js when a shim references more than one', () => {
    setPlatform('win32');
    const dir = path.join('C:', 'npm');
    process.env.PATH = dir;
    const cmd = path.join(dir, 'tool.cmd');
    const entry = path.join(dir, 'node_modules/tool/bin/tool.js');
    const node = path.join(dir, 'node.exe');
    existsSync.mockImplementation((p: string) => p === cmd || p === entry || p === node);
    readFileSync.mockReturnValue(
      '"%dp0%/node.exe" --import "%dp0%/node_modules/tool/loader.js" "%dp0%/node_modules/tool/bin/tool.js" %*',
    );

    expect(resolveEngineBin('tool')).toEqual({ command: node, prefixArgs: [entry] });
  });

  it('falls back to the bare name when nothing is found', () => {
    setPlatform('win32');
    process.env.PATH = path.join('C:', 'bin');
    existsSync.mockReturnValue(false);

    expect(resolveEngineBin('agent')).toEqual({ command: 'agent', prefixArgs: [] });
  });

  it('throws (no unsafe shell) when a .cmd shim cannot be resolved', () => {
    setPlatform('win32');
    const dir = path.join('C:', 'npm');
    process.env.PATH = dir;
    const cmd = path.join(dir, 'weird.cmd');
    existsSync.mockImplementation((p: string) => p === cmd);
    readFileSync.mockReturnValue('@echo nothing resolvable here');

    expect(() => resolveEngineBin('weird')).toThrow(/Cannot resolve Windows shim/);
  });
});
