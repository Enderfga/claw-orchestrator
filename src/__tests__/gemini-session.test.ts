/**
 * Unit tests for PersistentGeminiSession
 *
 * Tests the stream-json parsing logic, flag construction, and stats tracking.
 * Uses vitest mocks for child_process.spawn to avoid spawning real processes.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';

// Mock child_process before importing the session
const mockSpawn = vi.fn();
vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

// Import after mocking
const { PersistentGeminiSession } = await import('../persistent-gemini-session.js');

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
  proc.pid = 12345;
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

describe('PersistentGeminiSession', () => {
  let mockProc: ReturnType<typeof createMockProcess>;

  beforeEach(() => {
    mockProc = createMockProcess();
    mockSpawn.mockReset();
    mockSpawn.mockReturnValue(mockProc);
  });

  // ─── start() ────────────────────────────────────────────────────────────

  describe('start()', () => {
    it('initializes session and emits ready', async () => {
      const session = new PersistentGeminiSession({ name: 'test', cwd: '/tmp', permissionMode: 'default' });
      const readyFn = vi.fn();
      session.on('ready', readyFn);

      await session.start();

      expect(session.isReady).toBe(true);
      expect(session.sessionId).toMatch(/^gemini-/);
      expect(readyFn).toHaveBeenCalled();
    });
  });

  // ─── spawn flags ────────────────────────────────────────────────────────

  describe('spawn flags', () => {
    it('uses --yolo for bypassPermissions', async () => {
      const session = new PersistentGeminiSession({
        name: 'test',
        cwd: '/tmp',
        permissionMode: 'bypassPermissions',
        model: 'gemini-2.5-pro',
      });
      await session.start();

      const sendPromise = session.send('hello', { waitForComplete: true });
      // Let readline process then close
      setTimeout(() => closeProc(mockProc, 0), 10);
      await sendPromise;

      const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
      expect(spawnArgs).toContain('--yolo');
      expect(spawnArgs).toContain('--output-format');
      expect(spawnArgs).toContain('stream-json');
      expect(spawnArgs).toContain('--model');
      expect(spawnArgs).toContain('gemini-2.5-pro');
      // Gemini CLI 0.43 trusted-folders gate — must always be bypassed for headless runs.
      expect(spawnArgs).toContain('--skip-trust');
    });

    it('uses --sandbox for default permissionMode', async () => {
      const session = new PersistentGeminiSession({ name: 'test', cwd: '/tmp', permissionMode: 'default' });
      await session.start();

      const sendPromise = session.send('hello', { waitForComplete: true });
      setTimeout(() => closeProc(mockProc, 0), 10);
      await sendPromise;

      const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
      expect(spawnArgs).toContain('--sandbox');
      expect(spawnArgs).not.toContain('--yolo');
    });

    it('omits --yolo and --sandbox for other permission modes', async () => {
      const session = new PersistentGeminiSession({ name: 'test', cwd: '/tmp', permissionMode: 'acceptEdits' });
      await session.start();

      const sendPromise = session.send('hello', { waitForComplete: true });
      setTimeout(() => closeProc(mockProc, 0), 10);
      await sendPromise;

      const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
      expect(spawnArgs).not.toContain('--yolo');
      expect(spawnArgs).not.toContain('--sandbox');
    });
  });

  // ─── stream-json parsing ────────────────────────────────────────────────

  describe('stream-json parsing', () => {
    it('accumulates text from message events', async () => {
      const session = new PersistentGeminiSession({
        name: 'test',
        cwd: '/tmp',
        permissionMode: 'bypassPermissions',
      });
      await session.start();

      const sendPromise = session.send('hello', { waitForComplete: true });
      setTimeout(() => {
        feedLines(mockProc, [
          JSON.stringify({ type: 'message', content: 'Hello ' }),
          JSON.stringify({ type: 'message', content: 'world!' }),
        ]);
        closeProc(mockProc, 0);
      }, 10);

      const result = await sendPromise;
      expect('text' in result && result.text).toBe('Hello world!');
    });

    it('extracts real token usage from result event', async () => {
      const session = new PersistentGeminiSession({
        name: 'test',
        cwd: '/tmp',
        permissionMode: 'bypassPermissions',
      });
      await session.start();

      const sendPromise = session.send('hello', { waitForComplete: true });
      setTimeout(() => {
        feedLines(mockProc, [
          JSON.stringify({
            type: 'result',
            content: 'done',
            usage: { input_tokens: 100, output_tokens: 50 },
          }),
        ]);
        closeProc(mockProc, 0);
      }, 10);

      await sendPromise;
      const stats = session.getStats();
      expect(stats.tokensIn).toBe(100);
      expect(stats.tokensOut).toBe(50);
    });

    it('tracks tool_use and tool_result events', async () => {
      const session = new PersistentGeminiSession({
        name: 'test',
        cwd: '/tmp',
        permissionMode: 'bypassPermissions',
      });
      await session.start();

      const sendPromise = session.send('hello', { waitForComplete: true });
      setTimeout(() => {
        feedLines(mockProc, [
          JSON.stringify({ type: 'tool_use', tool: { name: 'write_file', input: {} } }),
          JSON.stringify({ type: 'tool_result', is_error: false }),
          JSON.stringify({ type: 'tool_use', tool: { name: 'read_file', input: {} } }),
          JSON.stringify({ type: 'tool_result', is_error: true }),
        ]);
        closeProc(mockProc, 0);
      }, 10);

      await sendPromise;
      const stats = session.getStats();
      expect(stats.toolCalls).toBe(2);
      expect(stats.toolErrors).toBe(1);
    });

    it('falls back to token estimation when no usage in events', async () => {
      const session = new PersistentGeminiSession({
        name: 'test',
        cwd: '/tmp',
        permissionMode: 'bypassPermissions',
      });
      await session.start();

      const sendPromise = session.send('a prompt message', { waitForComplete: true });
      setTimeout(() => {
        feedLines(mockProc, [JSON.stringify({ type: 'message', content: 'some response text here' })]);
        closeProc(mockProc, 0);
      }, 10);

      await sendPromise;
      const stats = session.getStats();
      // Fallback estimation: ~4 chars per token
      expect(stats.tokensIn).toBeGreaterThan(0);
      expect(stats.tokensOut).toBeGreaterThan(0);
    });
  });

  // ─── exit codes ─────────────────────────────────────────────────────────

  describe('exit codes', () => {
    it('maps exit code 53 to turn_limit stop reason', async () => {
      const session = new PersistentGeminiSession({
        name: 'test',
        cwd: '/tmp',
        permissionMode: 'bypassPermissions',
      });
      await session.start();

      const sendPromise = session.send('hello', { waitForComplete: true });
      setTimeout(() => {
        feedLines(mockProc, [JSON.stringify({ type: 'message', content: 'partial output' })]);
        closeProc(mockProc, 53);
      }, 10);

      const result = await sendPromise;
      expect('event' in result && (result.event as Record<string, unknown>).stop_reason).toBe('turn_limit');
    });

    it('rejects on non-zero exit with no output', async () => {
      const session = new PersistentGeminiSession({
        name: 'test',
        cwd: '/tmp',
        permissionMode: 'bypassPermissions',
      });
      await session.start();

      const sendPromise = session.send('hello', { waitForComplete: true });
      setTimeout(() => closeProc(mockProc, 1), 10);

      await expect(sendPromise).rejects.toThrow('Gemini exited with code 1');
    });
  });

  // ─── stop / compact / cost ──────────────────────────────────────────────

  describe('lifecycle', () => {
    it('stop() kills in-flight process', async () => {
      const session = new PersistentGeminiSession({
        name: 'test',
        cwd: '/tmp',
        permissionMode: 'bypassPermissions',
      });
      await session.start();

      // Start a send but don't resolve it
      session.send('hello', { waitForComplete: false });

      session.stop();
      expect(mockProc.kill).toHaveBeenCalledWith('SIGTERM');
      expect(session.isReady).toBe(false);
    });

    it('compact() returns no-op message', async () => {
      const session = new PersistentGeminiSession({
        name: 'test',
        cwd: '/tmp',
        permissionMode: 'bypassPermissions',
      });
      await session.start();

      const result = await session.compact();
      expect(result.text).toContain('does not support compaction');
    });

    it('getCost() uses gemini-2.5-pro pricing by default', async () => {
      const session = new PersistentGeminiSession({
        name: 'test',
        cwd: '/tmp',
        permissionMode: 'bypassPermissions',
      });
      await session.start();

      const cost = session.getCost();
      expect(cost.model).toBe('gemini-2.5-pro');
      expect(cost.pricing.inputPer1M).toBe(1.25);
      expect(cost.pricing.outputPer1M).toBe(10);
    });
  });

  // ─── stderr sanitization ────────────────────────────────────────────────

  describe('stderr sanitization', () => {
    it('redacts GEMINI_API_KEY from stderr', async () => {
      const session = new PersistentGeminiSession({
        name: 'test',
        cwd: '/tmp',
        permissionMode: 'bypassPermissions',
      });
      await session.start();

      const logs: string[] = [];
      session.on('log', (msg: string) => logs.push(msg));

      const sendPromise = session.send('hello', { waitForComplete: true });
      setTimeout(() => {
        mockProc.stderr.emit('data', Buffer.from('Error: GEMINI_API_KEY=AIza12345 not valid'));
        closeProc(mockProc, 0);
      }, 10);

      await sendPromise;
      expect(logs.some((l) => l.includes('GEMINI_API_KEY=***'))).toBe(true);
      expect(logs.some((l) => l.includes('AIza12345'))).toBe(false);
    });
  });
});
