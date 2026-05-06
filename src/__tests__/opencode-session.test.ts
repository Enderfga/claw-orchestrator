/**
 * Unit tests for PersistentOpencodeSession
 *
 * Tests the opencode `--format json` event parser. Mocks child_process.spawn
 * to feed synthetic NDJSON events. The schema mirrors sst/opencode's
 * `packages/opencode/src/cli/cmd/run.ts` emit shape:
 *   { type, timestamp, sessionID, ...data }
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';

// Mock child_process before importing the session
const mockSpawn = vi.fn();
vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

const { PersistentOpencodeSession } = await import('../persistent-opencode-session.js');

// ─── Mock Process Helper ────────────────────────────────────────────────────

function createMockProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: Readable & { destroy: ReturnType<typeof vi.fn> };
    stderr: EventEmitter & { destroy: ReturnType<typeof vi.fn> };
    stdin: { end: ReturnType<typeof vi.fn> };
    kill: ReturnType<typeof vi.fn>;
    pid: number;
    exitCode: null;
  };
  proc.stdout = new Readable({ read() {} });
  (proc.stdout as Readable & { destroy: ReturnType<typeof vi.fn> }).destroy = vi.fn();
  const stderrEmitter = new EventEmitter() as EventEmitter & { destroy: ReturnType<typeof vi.fn> };
  stderrEmitter.destroy = vi.fn();
  proc.stderr = stderrEmitter;
  proc.stdin = { end: vi.fn() };
  proc.kill = vi.fn();
  proc.pid = 23456;
  proc.exitCode = null;
  return proc;
}

function feedLines(proc: ReturnType<typeof createMockProcess>, lines: string[]) {
  for (const line of lines) {
    proc.stdout.push(line + '\n');
  }
}

function closeProc(proc: ReturnType<typeof createMockProcess>, code: number) {
  proc.stdout.push(null);
  proc.emit('close', code);
}

const SID = 'opencode-test-session';
function envelope(type: string, data: Record<string, unknown>): string {
  return JSON.stringify({ type, timestamp: 1234567890, sessionID: SID, ...data });
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('PersistentOpencodeSession', () => {
  let mockProc: ReturnType<typeof createMockProcess>;

  beforeEach(() => {
    mockProc = createMockProcess();
    mockSpawn.mockReset();
    mockSpawn.mockReturnValue(mockProc);
  });

  describe('start()', () => {
    it('initializes session and emits ready', async () => {
      const session = new PersistentOpencodeSession({ name: 'test', cwd: '/tmp', permissionMode: 'default' });
      const readyFn = vi.fn();
      session.on('ready', readyFn);

      await session.start();

      expect(session.isReady).toBe(true);
      expect(session.sessionId).toMatch(/^opencode-/);
      expect(readyFn).toHaveBeenCalled();
    });
  });

  describe('spawn flags', () => {
    it('uses run --format json', async () => {
      const session = new PersistentOpencodeSession({
        name: 'test',
        cwd: '/tmp',
        permissionMode: 'bypassPermissions',
      });
      await session.start();

      const sendPromise = session.send('hello', { waitForComplete: true });
      setTimeout(() => closeProc(mockProc, 0), 10);
      await sendPromise;

      const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
      expect(spawnArgs[0]).toBe('run');
      expect(spawnArgs[1]).toBe('hello');
      expect(spawnArgs).toContain('--format');
      expect(spawnArgs).toContain('json');
      // 1.1.40 does not have / does not need --dangerously-skip-permissions.
      // Adding it would trigger yargs strict mode and print the help screen.
      expect(spawnArgs).not.toContain('--dangerously-skip-permissions');
    });

    it('passes --model only when model contains "/"', async () => {
      const session = new PersistentOpencodeSession({
        name: 'test',
        cwd: '/tmp',
        permissionMode: 'bypassPermissions',
        model: 'anthropic/claude-sonnet-4',
      });
      await session.start();

      const sendPromise = session.send('hi', { waitForComplete: true });
      setTimeout(() => closeProc(mockProc, 0), 10);
      await sendPromise;

      const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
      expect(spawnArgs).toContain('--model');
      expect(spawnArgs).toContain('anthropic/claude-sonnet-4');
    });

    it('omits --model when value is not in provider/model form', async () => {
      const session = new PersistentOpencodeSession({
        name: 'test',
        cwd: '/tmp',
        permissionMode: 'bypassPermissions',
        model: 'sonnet',
      });
      await session.start();

      const sendPromise = session.send('hi', { waitForComplete: true });
      setTimeout(() => closeProc(mockProc, 0), 10);
      await sendPromise;

      const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
      expect(spawnArgs).not.toContain('--model');
    });
  });

  describe('text event parsing', () => {
    it('treats sequential text events for same part.id as cumulative snapshots', async () => {
      const session = new PersistentOpencodeSession({
        name: 'test',
        cwd: '/tmp',
        permissionMode: 'bypassPermissions',
      });
      await session.start();

      const sendPromise = session.send('hi', { waitForComplete: true });
      setTimeout(() => {
        feedLines(mockProc, [
          envelope('text', { part: { type: 'text', id: 'p1', text: 'Hello' } }),
          envelope('text', { part: { type: 'text', id: 'p1', text: 'Hello world' } }),
          envelope('text', { part: { type: 'text', id: 'p1', text: 'Hello world!' } }),
        ]);
        closeProc(mockProc, 0);
      }, 10);

      const result = await sendPromise;
      expect('text' in result && result.text).toBe('Hello world!');
    });

    it('streams only the delta on each cumulative text event', async () => {
      const session = new PersistentOpencodeSession({
        name: 'test',
        cwd: '/tmp',
        permissionMode: 'bypassPermissions',
      });
      await session.start();

      const deltas: string[] = [];
      const sendPromise = session.send('hi', {
        waitForComplete: true,
        callbacks: { onText: (t: string) => deltas.push(t) },
      });
      setTimeout(() => {
        feedLines(mockProc, [
          envelope('text', { part: { type: 'text', id: 'p1', text: 'Hello' } }),
          envelope('text', { part: { type: 'text', id: 'p1', text: 'Hello world' } }),
          envelope('text', { part: { type: 'text', id: 'p1', text: 'Hello world!' } }),
        ]);
        closeProc(mockProc, 0);
      }, 10);

      await sendPromise;
      expect(deltas).toEqual(['Hello', ' world', '!']);
    });

    it('concatenates separate text parts in arrival order', async () => {
      const session = new PersistentOpencodeSession({
        name: 'test',
        cwd: '/tmp',
        permissionMode: 'bypassPermissions',
      });
      await session.start();

      const sendPromise = session.send('hi', { waitForComplete: true });
      setTimeout(() => {
        feedLines(mockProc, [
          envelope('text', { part: { type: 'text', id: 'p1', text: 'First.' } }),
          envelope('text', { part: { type: 'text', id: 'p2', text: 'Second.' } }),
        ]);
        closeProc(mockProc, 0);
      }, 10);

      const result = await sendPromise;
      expect('text' in result && result.text).toBe('First.Second.');
    });
  });

  describe('tool_use event parsing', () => {
    it('counts each unique callID once across re-emissions', async () => {
      const session = new PersistentOpencodeSession({
        name: 'test',
        cwd: '/tmp',
        permissionMode: 'bypassPermissions',
      });
      await session.start();

      const sendPromise = session.send('hi', { waitForComplete: true });
      setTimeout(() => {
        feedLines(mockProc, [
          envelope('tool_use', {
            part: { type: 'tool', callID: 'c1', tool: 'read', state: { status: 'pending' } },
          }),
          envelope('tool_use', {
            part: { type: 'tool', callID: 'c1', tool: 'read', state: { status: 'completed' } },
          }),
          envelope('tool_use', {
            part: { type: 'tool', callID: 'c2', tool: 'write', state: { status: 'pending' } },
          }),
          envelope('tool_use', {
            part: { type: 'tool', callID: 'c2', tool: 'write', state: { status: 'error', error: 'boom' } },
          }),
        ]);
        closeProc(mockProc, 0);
      }, 10);

      await sendPromise;
      const stats = session.getStats();
      expect(stats.toolCalls).toBe(2);
      expect(stats.toolErrors).toBe(1);
    });
  });

  describe('step_finish usage', () => {
    it('extracts tokens from part.tokens.{input,output} and cache.read', async () => {
      const session = new PersistentOpencodeSession({
        name: 'test',
        cwd: '/tmp',
        permissionMode: 'bypassPermissions',
      });
      await session.start();

      const sendPromise = session.send('hi', { waitForComplete: true });
      setTimeout(() => {
        feedLines(mockProc, [
          envelope('text', { part: { type: 'text', id: 'p1', text: 'done' } }),
          envelope('step_finish', {
            part: {
              type: 'step-finish',
              tokens: { input: 200, output: 80, reasoning: 0, cache: { read: 50, write: 0 } },
              cost: 0.001,
            },
          }),
        ]);
        closeProc(mockProc, 0);
      }, 10);

      await sendPromise;
      const stats = session.getStats();
      expect(stats.tokensIn).toBe(200);
      expect(stats.tokensOut).toBe(80);
      expect(stats.cachedTokens).toBe(50);
    });
  });

  describe('fallback estimation', () => {
    it('estimates tokens when no step_finish arrives', async () => {
      const session = new PersistentOpencodeSession({
        name: 'test',
        cwd: '/tmp',
        permissionMode: 'bypassPermissions',
      });
      await session.start();

      const sendPromise = session.send('a prompt message that has some length', { waitForComplete: true });
      setTimeout(() => {
        feedLines(mockProc, [
          envelope('text', { part: { type: 'text', id: 'p1', text: 'a meaningful response of nontrivial length' } }),
        ]);
        closeProc(mockProc, 0);
      }, 10);

      await sendPromise;
      const stats = session.getStats();
      expect(stats.tokensIn).toBeGreaterThan(0);
      expect(stats.tokensOut).toBeGreaterThan(0);
    });
  });

  describe('session id capture', () => {
    it('captures sessionID from event envelope', async () => {
      const session = new PersistentOpencodeSession({
        name: 'test',
        cwd: '/tmp',
        permissionMode: 'bypassPermissions',
      });
      await session.start();

      const sendPromise = session.send('hi', { waitForComplete: true });
      setTimeout(() => {
        feedLines(mockProc, [envelope('text', { part: { type: 'text', id: 'p1', text: 'hi' } })]);
        closeProc(mockProc, 0);
      }, 10);

      await sendPromise;
      expect(session.sessionId).toBe(`opencode-live-${SID}`);
    });
  });

  describe('reasoning events', () => {
    it('does not include reasoning text in the result', async () => {
      const session = new PersistentOpencodeSession({
        name: 'test',
        cwd: '/tmp',
        permissionMode: 'bypassPermissions',
      });
      await session.start();

      const sendPromise = session.send('hi', { waitForComplete: true });
      setTimeout(() => {
        feedLines(mockProc, [
          envelope('reasoning', { part: { type: 'reasoning', text: 'thinking internally...' } }),
          envelope('text', { part: { type: 'text', id: 'p1', text: 'final answer' } }),
        ]);
        closeProc(mockProc, 0);
      }, 10);

      const result = await sendPromise;
      expect('text' in result && result.text).toBe('final answer');
      expect('text' in result && result.text).not.toContain('thinking');
    });
  });

  describe('exit codes', () => {
    it('rejects on non-zero exit', async () => {
      const session = new PersistentOpencodeSession({
        name: 'test',
        cwd: '/tmp',
        permissionMode: 'bypassPermissions',
      });
      await session.start();

      const sendPromise = session.send('hi', { waitForComplete: true });
      setTimeout(() => closeProc(mockProc, 1), 10);

      await expect(sendPromise).rejects.toThrow('OpenCode exited with code 1');
    });
  });

  describe('lifecycle', () => {
    it('stop() kills in-flight process', async () => {
      const session = new PersistentOpencodeSession({
        name: 'test',
        cwd: '/tmp',
        permissionMode: 'bypassPermissions',
      });
      await session.start();

      session.send('hi', { waitForComplete: false });

      session.stop();
      expect(mockProc.kill).toHaveBeenCalledWith('SIGTERM');
      expect(session.isReady).toBe(false);
    });

    it('compact() returns no-op message', async () => {
      const session = new PersistentOpencodeSession({
        name: 'test',
        cwd: '/tmp',
        permissionMode: 'bypassPermissions',
      });
      await session.start();

      const result = await session.compact();
      expect(result.text).toContain('does not support compaction');
    });

    it('getCost() uses opencode-default model label', async () => {
      const session = new PersistentOpencodeSession({
        name: 'test',
        cwd: '/tmp',
        permissionMode: 'bypassPermissions',
      });
      await session.start();

      const cost = session.getCost();
      expect(cost.model).toBe('opencode-default');
    });
  });

  describe('stderr sanitization', () => {
    it('redacts ANTHROPIC_API_KEY from stderr', async () => {
      const session = new PersistentOpencodeSession({
        name: 'test',
        cwd: '/tmp',
        permissionMode: 'bypassPermissions',
      });
      await session.start();

      const logs: string[] = [];
      session.on('log', (msg: string) => logs.push(msg));

      const sendPromise = session.send('hi', { waitForComplete: true });
      setTimeout(() => {
        mockProc.stderr.emit('data', Buffer.from('Error: ANTHROPIC_API_KEY=sk-abcdef invalid'));
        closeProc(mockProc, 0);
      }, 10);

      await sendPromise;
      expect(logs.some((l) => l.includes('ANTHROPIC_API_KEY=***'))).toBe(true);
      expect(logs.some((l) => l.includes('sk-abcdef'))).toBe(false);
    });
  });
});
