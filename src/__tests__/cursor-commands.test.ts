/**
 * Cursor's command listing (from a short-lived `cursor-agent acp`) and its quota reader.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const mockSpawn = vi.fn();
const mockExec = vi.fn();
vi.mock('../engine-spawn.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../engine-spawn.js')>()),
  spawnEngine: (...args: unknown[]) => mockSpawn(...args),
  execEngine: (...args: unknown[]) => mockExec(...args),
}));

const testTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-cmd-test-'));
const home = path.join(testTmp, 'home');
fs.mkdirSync(path.join(home, 'acp-sessions'), { recursive: true });
const savedTmpdir = process.env.TMPDIR;
process.env.CURSOR_CONFIG_DIR = home;
process.env.TMPDIR = testTmp;
afterAll(() => {
  delete process.env.CURSOR_CONFIG_DIR;
  if (savedTmpdir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = savedTmpdir;
  fs.rmSync(testTmp, { recursive: true, force: true });
});

const { cursorCommandOf, listCursorCommands } = await import('../cursor-commands.js');
const { readEngineQuota } = await import('../engine-quota.js');

/** A fake `cursor-agent acp`: answers initialize and session/new, then lists `commands`. */
function fakeAcp(commands: Array<{ name: string; description?: string }>) {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: Writable;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
    exitCode: number | null;
    signalCode: string | null;
    requests: Array<Record<string, unknown>>;
  };
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.exitCode = null;
  proc.signalCode = null;
  proc.requests = [];
  const out = (msg: unknown) => proc.stdout.write(`${JSON.stringify(msg)}\n`);
  proc.stdin = new Writable({
    write(chunk, _enc, cb) {
      for (const line of String(chunk).split('\n').filter(Boolean)) {
        const msg = JSON.parse(line) as { id: number; method: string; params: Record<string, unknown> };
        proc.requests.push(msg);
        if (msg.method === 'initialize') out({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
        if (msg.method === 'session/new') {
          // The session's ACP record goes in the session's own directory, not the user's.
          const dir = (mockSpawn.mock.calls.at(-1)![2] as { env: Record<string, string> }).env.CURSOR_CONFIG_DIR;
          fs.writeFileSync(path.join(dir, 'acp-sessions', 's1'), '');
          out({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 's1' } });
          out({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: 's1',
              update: { sessionUpdate: 'available_commands_update', availableCommands: commands },
            },
          });
        }
      }
      cb();
    },
  });
  proc.kill = vi.fn(() => {
    proc.signalCode = 'SIGTERM';
    setTimeout(() => proc.emit('close', null), 1);
    return true;
  });
  return proc;
}

describe('Cursor commands', () => {
  beforeEach(() => {
    mockSpawn.mockReset();
    mockExec.mockReset();
  });

  it('reads where each entry comes from off the end of its description', () => {
    expect(cursorCommandOf({ name: 'goal', description: 'Set a goal. (builtin skill)' })).toEqual({
      name: 'goal',
      description: 'Set a goal.',
      source: 'builtin',
      startsTurn: true,
    });
    expect(cursorCommandOf({ name: 'probe-skill', description: 'A probe. (project skill)' })?.source).toBe('skill');
    expect(cursorCommandOf({ name: 'pdf', description: 'PDFs. (user skill)' })?.source).toBe('skill');
    expect(cursorCommandOf({ name: 'probe-cmd', description: 'Reply. (project)' })?.source).toBe('custom');
    expect(cursorCommandOf({ name: 'best-of-n', description: 'Fan out. (global)' })?.source).toBe('custom');
    expect(cursorCommandOf({ name: 'copy-request-id', description: 'Copy the last request ID' })).toMatchObject({
      source: 'builtin',
      needsHuman: true,
    });
    expect(cursorCommandOf({ name: '' })).toBeUndefined();
  });

  it('lists them from a short-lived ACP server, in a config directory of its own, and ends it', async () => {
    const proc = fakeAcp([
      { name: 'loop', description: 'Run on an interval. (builtin skill)' },
      { name: 'probe-cmd', description: 'Reply. (project)' },
    ]);
    mockSpawn.mockReturnValue(proc);
    const list = await listCursorCommands('cursor-agent', '/tmp/ws');
    expect(list.map((c) => [c.name, c.source])).toEqual([
      ['loop', 'builtin'],
      ['probe-cmd', 'custom'],
    ]);
    expect(mockSpawn.mock.calls[0][1]).toEqual(['acp']);
    expect(proc.requests.map((r) => r.method)).toEqual(['initialize', 'session/new']);
    expect(proc.requests[1].params).toEqual({ cwd: '/tmp/ws', mcpServers: [] });
    expect(proc.kill).toHaveBeenCalled();
    expect(fs.readdirSync(path.join(home, 'acp-sessions'))).toEqual([]);
  });

  it('reports the subscription tier as the quota, with no usage windows', async () => {
    mockExec.mockResolvedValue({ stdout: JSON.stringify({ subscriptionTier: 'Team', userEmail: 'x' }), stderr: '' });
    const quota = await readEngineQuota('cursor', {});
    expect(quota).toMatchObject({ engine: 'cursor', plan: 'Team', windows: [] });
    expect(JSON.stringify(quota)).not.toContain('userEmail');
    expect(mockExec.mock.calls[0][1]).toEqual(['about', '--format', 'json']);
    // Even `about` refreshes caches in cli-config.json: it runs on a mirror, removed after.
    const env = (mockExec.mock.calls[0][2] as { env: Record<string, string> }).env;
    expect(env.CURSOR_CONFIG_DIR).toContain('claw-cursor-cfg-');
    expect(fs.existsSync(env.CURSOR_CONFIG_DIR)).toBe(false);
  });
});
