/**
 * Unit tests for PersistentKimiSession
 *
 * Tests the Kimi `--output-format stream-json` parser, flag construction,
 * prompt truncation, token estimation, and stats tracking. Mocks
 * child_process.spawn to feed synthetic stream-json lines with roles
 * (assistant, tool, meta, error) — no real `kimi` process is spawned.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';

// Mock child_process before importing the session
const mockSpawn = vi.fn();
vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

const { PersistentKimiSession } = await import('../persistent-kimi-session.js');

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
  proc.pid = 34567;
  proc.exitCode = null;
  return proc;
}

function feedLines(proc: ReturnType<typeof createMockProcess>, lines: string[]) {
  for (const line of lines) {
    proc.stdout.push(line + '\n');
  }
}

function closeProc(proc: ReturnType<typeof createMockProcess>, code: number) {
  proc.stdout.push(null); // end stream
  proc.emit('close', code);
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('PersistentKimiSession', () => {
  let mockProc: ReturnType<typeof createMockProcess>;

  beforeEach(() => {
    mockProc = createMockProcess();
    mockSpawn.mockReset();
    mockSpawn.mockReturnValue(mockProc);
  });

  // ─── start() ──────────────────────────────────────────────────────────────

  describe('start()', () => {
    it('initializes session and emits ready', async () => {
      const session = new PersistentKimiSession({ name: 'test', cwd: '/tmp', permissionMode: 'default' });
      const readyFn = vi.fn();
      session.on('ready', readyFn);

      await session.start();

      expect(session.isReady).toBe(true);
      expect(session.sessionId).toMatch(/^kimi-/);
      expect(readyFn).toHaveBeenCalled();
    });
  });

  // ─── spawn flags ────────────────────────────────────────────────────────

  describe('spawn flags', () => {
    it('uses -p <prompt> --output-format stream-json', async () => {
      const session = new PersistentKimiSession({ name: 'test', cwd: '/tmp', permissionMode: 'bypassPermissions' });
      await session.start();

      const sendPromise = session.send('hello', { waitForComplete: true });
      setTimeout(() => closeProc(mockProc, 0), 10);
      await sendPromise;

      const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
      expect(spawnArgs[0]).toBe('-p');
      expect(spawnArgs[1]).toBe('hello');
      expect(spawnArgs).toContain('--output-format');
      expect(spawnArgs).toContain('stream-json');
    });

    it('passes --model when a model is set', async () => {
      const session = new PersistentKimiSession({
        name: 'test',
        cwd: '/tmp',
        permissionMode: 'bypassPermissions',
        model: 'kimi-code/kimi-for-coding',
      });
      await session.start();

      const sendPromise = session.send('hi', { waitForComplete: true });
      setTimeout(() => closeProc(mockProc, 0), 10);
      await sendPromise;

      const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
      expect(spawnArgs).toContain('--model');
      expect(spawnArgs).toContain('kimi-code/kimi-for-coding');
    });

    it('omits --model when no model is set', async () => {
      const session = new PersistentKimiSession({ name: 'test', cwd: '/tmp', permissionMode: 'bypassPermissions' });
      await session.start();

      const sendPromise = session.send('hi', { waitForComplete: true });
      setTimeout(() => closeProc(mockProc, 0), 10);
      await sendPromise;

      const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
      expect(spawnArgs).not.toContain('--model');
    });
  });

  // ─── prompt truncation ──────────────────────────────────────────────────

  describe('prompt truncation', () => {
    it('truncates prompts longer than the Windows command-line safe margin', async () => {
      const session = new PersistentKimiSession({ name: 'test', cwd: '/tmp', permissionMode: 'bypassPermissions' });
      await session.start();

      const logs: string[] = [];
      session.on('log', (msg: string) => logs.push(msg));

      const longPrompt = 'x'.repeat(25_000);
      const sendPromise = session.send(longPrompt, { waitForComplete: true });
      setTimeout(() => closeProc(mockProc, 0), 10);
      await sendPromise;

      const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
      const sentPrompt = spawnArgs[1];
      expect(sentPrompt.length).toBeLessThan(longPrompt.length);
      expect(sentPrompt.endsWith('[truncated]')).toBe(true);
      expect(logs.some((l) => l.includes('truncated'))).toBe(true);
    });

    it('does not truncate prompts under the limit', async () => {
      const session = new PersistentKimiSession({ name: 'test', cwd: '/tmp', permissionMode: 'bypassPermissions' });
      await session.start();

      const sendPromise = session.send('short prompt', { waitForComplete: true });
      setTimeout(() => closeProc(mockProc, 0), 10);
      await sendPromise;

      const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
      expect(spawnArgs[1]).toBe('short prompt');
    });
  });

  // ─── stream-json parsing ──────────────────────────────────────────────────

  describe('stream-json parsing', () => {
    it('accumulates text from assistant content events', async () => {
      const session = new PersistentKimiSession({ name: 'test', cwd: '/tmp', permissionMode: 'bypassPermissions' });
      await session.start();

      const sendPromise = session.send('hello', { waitForComplete: true });
      setTimeout(() => {
        feedLines(mockProc, [
          JSON.stringify({ role: 'assistant', content: 'Hello ' }),
          JSON.stringify({ role: 'assistant', content: 'world!' }),
        ]);
        closeProc(mockProc, 0);
      }, 10);

      const result = await sendPromise;
      expect('text' in result && result.text).toBe('Hello world!');
    });

    it('streams assistant content via the onText callback', async () => {
      const session = new PersistentKimiSession({ name: 'test', cwd: '/tmp', permissionMode: 'bypassPermissions' });
      await session.start();

      const deltas: string[] = [];
      const sendPromise = session.send('hi', {
        waitForComplete: true,
        callbacks: { onText: (t: string) => deltas.push(t) },
      });
      setTimeout(() => {
        feedLines(mockProc, [
          JSON.stringify({ role: 'assistant', content: 'First.' }),
          JSON.stringify({ role: 'assistant', content: 'Second.' }),
        ]);
        closeProc(mockProc, 0);
      }, 10);

      await sendPromise;
      expect(deltas).toEqual(['First.', 'Second.']);
    });

    it('counts tool_calls on assistant events and fires onToolUse', async () => {
      const session = new PersistentKimiSession({ name: 'test', cwd: '/tmp', permissionMode: 'bypassPermissions' });
      await session.start();

      const tools: unknown[] = [];
      const sendPromise = session.send('hi', {
        waitForComplete: true,
        callbacks: { onToolUse: (t: unknown) => tools.push(t) },
      });
      setTimeout(() => {
        feedLines(mockProc, [
          JSON.stringify({
            role: 'assistant',
            tool_calls: [
              { name: 'read_file', input: {} },
              { name: 'write_file', input: {} },
            ],
          }),
          JSON.stringify({ role: 'assistant', content: 'done' }),
        ]);
        closeProc(mockProc, 0);
      }, 10);

      const result = await sendPromise;
      const stats = session.getStats();
      expect(stats.toolCalls).toBe(2);
      expect(tools).toHaveLength(2);
      // tool_calls events contribute no text
      expect('text' in result && result.text).toBe('done');
    });

    it('routes tool role events to onToolResult', async () => {
      const session = new PersistentKimiSession({ name: 'test', cwd: '/tmp', permissionMode: 'bypassPermissions' });
      await session.start();

      const results: unknown[] = [];
      const sendPromise = session.send('hi', {
        waitForComplete: true,
        callbacks: { onToolResult: (r: unknown) => results.push(r) },
      });
      setTimeout(() => {
        feedLines(mockProc, [
          JSON.stringify({ role: 'tool', tool_call_id: 'c1', content: 'file contents' }),
          JSON.stringify({ role: 'assistant', content: 'ok' }),
        ]);
        closeProc(mockProc, 0);
      }, 10);

      const result = await sendPromise;
      expect(results).toHaveLength(1);
      // tool role events contribute no result text
      expect('text' in result && result.text).toBe('ok');
    });

    it('logs meta events without adding them to the result text', async () => {
      const session = new PersistentKimiSession({ name: 'test', cwd: '/tmp', permissionMode: 'bypassPermissions' });
      await session.start();

      const logs: string[] = [];
      session.on('log', (msg: string) => logs.push(msg));

      const sendPromise = session.send('hi', { waitForComplete: true });
      setTimeout(() => {
        feedLines(mockProc, [
          JSON.stringify({ role: 'meta', session_resume: 'abc123' }),
          JSON.stringify({ role: 'assistant', content: 'visible answer' }),
        ]);
        closeProc(mockProc, 0);
      }, 10);

      const result = await sendPromise;
      expect('text' in result && result.text).toBe('visible answer');
      expect(logs.some((l) => l.includes('kimi-meta'))).toBe(true);
    });

    it('treats non-JSON lines as plain text', async () => {
      const session = new PersistentKimiSession({ name: 'test', cwd: '/tmp', permissionMode: 'bypassPermissions' });
      await session.start();

      const sendPromise = session.send('hi', { waitForComplete: true });
      setTimeout(() => {
        feedLines(mockProc, ['plain log line, not JSON']);
        closeProc(mockProc, 0);
      }, 10);

      const result = await sendPromise;
      expect('text' in result && result.text).toContain('plain log line, not JSON');
    });
  });

  // ─── token estimation ─────────────────────────────────────────────────────

  describe('token estimation', () => {
    it('estimates tokens from text length (Kimi emits no usage events)', async () => {
      const session = new PersistentKimiSession({ name: 'test', cwd: '/tmp', permissionMode: 'bypassPermissions' });
      await session.start();

      const sendPromise = session.send('a prompt message of some length', { waitForComplete: true });
      setTimeout(() => {
        feedLines(mockProc, [
          JSON.stringify({ role: 'assistant', content: 'a meaningful response of nontrivial length' }),
        ]);
        closeProc(mockProc, 0);
      }, 10);

      await sendPromise;
      const stats = session.getStats();
      expect(stats.tokensIn).toBeGreaterThan(0);
      expect(stats.tokensOut).toBeGreaterThan(0);
    });
  });

  // ─── exit codes ────────────────────────────────────────────────────────────

  describe('exit codes', () => {
    it('rejects on non-zero exit', async () => {
      const session = new PersistentKimiSession({ name: 'test', cwd: '/tmp', permissionMode: 'bypassPermissions' });
      await session.start();

      const sendPromise = session.send('hi', { waitForComplete: true });
      setTimeout(() => closeProc(mockProc, 1), 10);

      await expect(sendPromise).rejects.toThrow('Kimi exited with code 1');
    });

    it('records a turn and resolves on clean exit', async () => {
      const session = new PersistentKimiSession({ name: 'test', cwd: '/tmp', permissionMode: 'bypassPermissions' });
      await session.start();

      const sendPromise = session.send('hi', { waitForComplete: true });
      setTimeout(() => {
        feedLines(mockProc, [JSON.stringify({ role: 'assistant', content: 'answer' })]);
        closeProc(mockProc, 0);
      }, 10);

      const result = await sendPromise;
      expect('event' in result && (result.event as Record<string, unknown>).stop_reason).toBe('end_turn');
      expect(session.getStats().turns).toBe(1);
    });
  });

  // ─── lifecycle ─────────────────────────────────────────────────────────────

  describe('lifecycle', () => {
    it('stop() kills in-flight process', async () => {
      const session = new PersistentKimiSession({ name: 'test', cwd: '/tmp', permissionMode: 'bypassPermissions' });
      await session.start();

      session.send('hi', { waitForComplete: false });

      session.stop();
      expect(mockProc.kill).toHaveBeenCalledWith('SIGTERM');
      expect(session.isReady).toBe(false);
    });

    it('compact() returns no-op message', async () => {
      const session = new PersistentKimiSession({ name: 'test', cwd: '/tmp', permissionMode: 'bypassPermissions' });
      await session.start();

      const result = await session.compact();
      expect(result.text).toContain('does not support compaction');
    });

    it('getCost() uses the default Kimi model and pricing', async () => {
      const session = new PersistentKimiSession({ name: 'test', cwd: '/tmp', permissionMode: 'bypassPermissions' });
      await session.start();

      const cost = session.getCost();
      expect(cost.model).toBe('kimi-code/kimi-for-coding');
      expect(cost.pricing.inputPer1M).toBe(0.6);
      expect(cost.pricing.outputPer1M).toBe(2.5);
    });
  });

  // ─── stderr sanitization ────────────────────────────────────────────────────

  describe('stderr sanitization', () => {
    it('redacts KIMI_API_KEY and MOONSHOT_API_KEY from stderr', async () => {
      const session = new PersistentKimiSession({ name: 'test', cwd: '/tmp', permissionMode: 'bypassPermissions' });
      await session.start();

      const logs: string[] = [];
      session.on('log', (msg: string) => logs.push(msg));

      const sendPromise = session.send('hi', { waitForComplete: true });
      setTimeout(() => {
        mockProc.stderr.emit('data', Buffer.from('Error: KIMI_API_KEY=sk-kimi-123 and MOONSHOT_API_KEY=sk-moon-456'));
        closeProc(mockProc, 0);
      }, 10);

      await sendPromise;
      expect(logs.some((l) => l.includes('KIMI_API_KEY=***'))).toBe(true);
      expect(logs.some((l) => l.includes('MOONSHOT_API_KEY=***'))).toBe(true);
      expect(logs.some((l) => l.includes('sk-kimi-123'))).toBe(false);
      expect(logs.some((l) => l.includes('sk-moon-456'))).toBe(false);
    });

    it('redacts Bearer tokens from stderr', async () => {
      const session = new PersistentKimiSession({ name: 'test', cwd: '/tmp', permissionMode: 'bypassPermissions' });
      await session.start();

      const logs: string[] = [];
      session.on('log', (msg: string) => logs.push(msg));

      const sendPromise = session.send('hi', { waitForComplete: true });
      setTimeout(() => {
        mockProc.stderr.emit('data', Buffer.from('Authorization: Bearer abc123secret'));
        closeProc(mockProc, 0);
      }, 10);

      await sendPromise;
      expect(logs.some((l) => l.includes('Bearer ***'))).toBe(true);
      expect(logs.some((l) => l.includes('abc123secret'))).toBe(false);
    });
  });
});
