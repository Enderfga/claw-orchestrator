/**
 * Unit tests for PersistentAgySession
 *
 * Tests flag construction, plain-text collection, conversation-ID harvesting
 * from the agy log file, timeout coherence, and stats tracking. Uses vitest
 * mocks for child_process.spawn to avoid spawning real processes.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import * as fs from 'node:fs';

// Mock child_process before importing the session
const mockSpawn = vi.fn();
vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

// Import after mocking
const { PersistentAgySession } = await import('../persistent-agy-session.js');

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

function feedText(proc: ReturnType<typeof createMockProcess>, text: string) {
  proc.stdout.push(text);
}

function closeProc(proc: ReturnType<typeof createMockProcess>, code: number) {
  proc.stdout.push(null); // end stream
  proc.emit('close', code);
}

/** Read the private agy log path from the actual spawn args. */
function logPathFromSpawn(callIndex = mockSpawn.mock.calls.length - 1): string {
  const args = mockSpawn.mock.calls[callIndex][1] as string[];
  const idx = args.indexOf('--log-file');
  expect(idx).toBeGreaterThan(-1);
  return args[idx + 1];
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('PersistentAgySession', () => {
  let mockProc: ReturnType<typeof createMockProcess>;
  const tmpLogs: string[] = [];

  beforeEach(() => {
    mockProc = createMockProcess();
    mockSpawn.mockReset();
    mockSpawn.mockReturnValue(mockProc);
  });

  afterEach(() => {
    for (const f of tmpLogs.splice(0)) {
      try {
        fs.unlinkSync(f);
      } catch {
        /* already gone */
      }
    }
  });

  // ─── start() ────────────────────────────────────────────────────────────

  describe('start()', () => {
    it('initializes session and emits ready', async () => {
      const session = new PersistentAgySession({ name: 'test', cwd: '/tmp', permissionMode: 'default' });
      const readyFn = vi.fn();
      session.on('ready', readyFn);

      await session.start();

      expect(session.isReady).toBe(true);
      expect(session.sessionId).toMatch(/^agy-/);
      expect(readyFn).toHaveBeenCalled();
    });
  });

  // ─── spawn flags ────────────────────────────────────────────────────────

  describe('spawn flags', () => {
    it('uses --dangerously-skip-permissions for bypassPermissions', async () => {
      const session = new PersistentAgySession({
        name: 'test',
        cwd: '/tmp',
        permissionMode: 'bypassPermissions',
        model: 'gemini-3.5-flash',
      });
      await session.start();

      const sendPromise = session.send('hello', { waitForComplete: true });
      setTimeout(() => closeProc(mockProc, 0), 10);
      await sendPromise;

      const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
      expect(spawnArgs).toContain('-p');
      expect(spawnArgs).toContain('hello');
      expect(spawnArgs).toContain('--dangerously-skip-permissions');
      expect(spawnArgs).toContain('--model');
      expect(spawnArgs).toContain('gemini-3.5-flash');
      expect(spawnArgs).toContain('--log-file');
    });

    it('uses plan mode for read-only sessions', async () => {
      const session = new PersistentAgySession({
        name: 'test',
        cwd: '/tmp',
        permissionMode: 'manual',
        sandboxMode: 'read-only',
      });
      await session.start();

      const sendPromise = session.send('hello', { waitForComplete: true });
      setTimeout(() => closeProc(mockProc, 0), 10);
      await sendPromise;

      const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
      expect(spawnArgs).toContain('--mode');
      expect(spawnArgs).toContain('plan');
      expect(spawnArgs).not.toContain('--dangerously-skip-permissions');
    });

    it('uses --sandbox for default permissionMode', async () => {
      const session = new PersistentAgySession({ name: 'test', cwd: '/tmp', permissionMode: 'default' });
      await session.start();

      const sendPromise = session.send('hello', { waitForComplete: true });
      setTimeout(() => closeProc(mockProc, 0), 10);
      await sendPromise;

      const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
      expect(spawnArgs).toContain('--sandbox');
      expect(spawnArgs).not.toContain('--dangerously-skip-permissions');
    });

    it('uses --sandbox for manual permissionMode (CLI 2.1.200+ name for default)', async () => {
      const session = new PersistentAgySession({ name: 'test', cwd: '/tmp', permissionMode: 'manual' });
      await session.start();

      const sendPromise = session.send('hello', { waitForComplete: true });
      setTimeout(() => closeProc(mockProc, 0), 10);
      await sendPromise;

      const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
      expect(spawnArgs).toContain('--sandbox');
      expect(spawnArgs).not.toContain('--dangerously-skip-permissions');
    });

    it('omits permission flags for other permission modes', async () => {
      const session = new PersistentAgySession({ name: 'test', cwd: '/tmp', permissionMode: 'acceptEdits' });
      await session.start();

      const sendPromise = session.send('hello', { waitForComplete: true });
      setTimeout(() => closeProc(mockProc, 0), 10);
      await sendPromise;

      const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
      expect(spawnArgs).not.toContain('--sandbox');
      expect(spawnArgs).not.toContain('--dangerously-skip-permissions');
    });

    it('derives --print-timeout from the send timeout', async () => {
      const session = new PersistentAgySession({
        name: 'test',
        cwd: '/tmp',
        permissionMode: 'bypassPermissions',
      });
      await session.start();

      const sendPromise = session.send('hello', { waitForComplete: true, timeout: 60_000 });
      setTimeout(() => closeProc(mockProc, 0), 10);
      await sendPromise;

      const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
      const idx = spawnArgs.indexOf('--print-timeout');
      expect(idx).toBeGreaterThan(-1);
      // 60s send timeout + 5s margin so the wrapper timer, not agy, decides
      expect(spawnArgs[idx + 1]).toBe('65s');
    });

    it('resolves agy model aliases before passing --model', async () => {
      const session = new PersistentAgySession({
        name: 'test',
        cwd: '/tmp',
        permissionMode: 'bypassPermissions',
        model: 'agy-pro',
      });
      await session.start();

      const sendPromise = session.send('hello', { waitForComplete: true });
      setTimeout(() => closeProc(mockProc, 0), 10);
      await sendPromise;

      const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
      const idx = spawnArgs.indexOf('--model');
      expect(idx).toBeGreaterThan(-1);
      expect(spawnArgs[idx + 1]).toBe('gemini-3.1-pro');
    });
  });

  // ─── conversation continuity ────────────────────────────────────────────

  describe('conversation continuity', () => {
    it('harvests conversation ID from the log and passes --conversation on the next send', async () => {
      const session = new PersistentAgySession({
        name: 'test',
        cwd: '/tmp',
        permissionMode: 'bypassPermissions',
      });
      await session.start();

      // Turn 1: agy writes its log; the engine harvests the new conversation ID
      const send1 = session.send('first turn', { waitForComplete: true });
      const logFile = logPathFromSpawn();
      tmpLogs.push(logFile);
      setTimeout(() => {
        fs.writeFileSync(logFile, 'I0705 server.go:825] Created conversation 4ebc13c0-4cd3-4f59-b19d-2ee98ad883b2\n');
        feedText(mockProc, 'STORED\n');
        closeProc(mockProc, 0);
      }, 10);
      await send1;

      expect(session.conversationId).toBe('4ebc13c0-4cd3-4f59-b19d-2ee98ad883b2');
      expect(session.getStats().agyConversationId).toBe('4ebc13c0-4cd3-4f59-b19d-2ee98ad883b2');
      const firstArgs = mockSpawn.mock.calls[0][1] as string[];
      expect(firstArgs).not.toContain('--conversation');

      // Turn 2: resume with the harvested ID
      const proc2 = createMockProcess();
      mockSpawn.mockReturnValue(proc2);
      const send2 = session.send('second turn', { waitForComplete: true });
      setTimeout(() => {
        proc2.stdout.push(null);
        proc2.emit('close', 0);
      }, 10);
      await send2;

      const secondArgs = mockSpawn.mock.calls[1][1] as string[];
      const idx = secondArgs.indexOf('--conversation');
      expect(idx).toBeGreaterThan(-1);
      expect(secondArgs[idx + 1]).toBe('4ebc13c0-4cd3-4f59-b19d-2ee98ad883b2');
    });

    it('seeds the conversation ID from resumeSessionId', async () => {
      const session = new PersistentAgySession({
        name: 'test',
        cwd: '/tmp',
        permissionMode: 'bypassPermissions',
        resumeSessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      });
      await session.start();

      const sendPromise = session.send('hello again', { waitForComplete: true });
      setTimeout(() => closeProc(mockProc, 0), 10);
      await sendPromise;

      const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
      const idx = spawnArgs.indexOf('--conversation');
      expect(idx).toBeGreaterThan(-1);
      expect(spawnArgs[idx + 1]).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    });

    it('ignores synthetic agy session IDs passed as resumeSessionId', async () => {
      const session = new PersistentAgySession({
        name: 'test',
        cwd: '/tmp',
        permissionMode: 'bypassPermissions',
        resumeSessionId: 'agy-1720000000000-ab3f',
      });
      await session.start();

      const sendPromise = session.send('hello again', { waitForComplete: true });
      setTimeout(() => closeProc(mockProc, 0), 10);
      await sendPromise;

      const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
      expect(spawnArgs).not.toContain('--conversation');
    });

    it('keeps the existing ID when the log has no Created line (resumed turn)', async () => {
      const session = new PersistentAgySession({
        name: 'test',
        cwd: '/tmp',
        permissionMode: 'bypassPermissions',
        resumeSessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      });
      await session.start();

      const sendPromise = session.send('hello', { waitForComplete: true });
      const logFile = logPathFromSpawn();
      tmpLogs.push(logFile);
      setTimeout(() => {
        fs.writeFileSync(logFile, 'I0705 server.go:825] Created conversation ffffffff-1111-2222-3333-444444444444\n');
        closeProc(mockProc, 0);
      }, 10);
      await sendPromise;

      expect(session.conversationId).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    });

    it('harvests the conversation ID even after the wrapper timeout settles the turn', async () => {
      const session = new PersistentAgySession({
        name: 'test',
        cwd: '/tmp',
        permissionMode: 'bypassPermissions',
      });
      await session.start();

      const observed = session.send('slow turn', { waitForComplete: true, timeout: 10 }).catch((err: Error) => err);
      const logFile = logPathFromSpawn();
      tmpLogs.push(logFile);
      fs.writeFileSync(logFile, 'I0705 server.go:825] Created conversation 11111111-2222-3333-4444-555555555555\n');

      await new Promise((resolve) => setTimeout(resolve, 20));
      closeProc(mockProc, 143);

      const err = await observed;
      expect(err.message).toContain('Timeout waiting for Antigravity response');
      expect(session.conversationId).toBe('11111111-2222-3333-4444-555555555555');
    });

    it('logs a warning when the first turn cannot harvest a conversation ID', async () => {
      const session = new PersistentAgySession({
        name: 'test',
        cwd: '/tmp',
        permissionMode: 'bypassPermissions',
      });
      await session.start();

      const logs: string[] = [];
      session.on('log', (msg: string) => logs.push(msg));

      const sendPromise = session.send('hello', { waitForComplete: true });
      setTimeout(() => closeProc(mockProc, 0), 10);
      await sendPromise;

      expect(logs.some((l) => l.includes('no conversation ID found in log'))).toBe(true);
    });
  });

  // ─── plain-text output ──────────────────────────────────────────────────

  describe('plain-text output', () => {
    it('accumulates stdout chunks and trims the trailing newline', async () => {
      const session = new PersistentAgySession({
        name: 'test',
        cwd: '/tmp',
        permissionMode: 'bypassPermissions',
      });
      await session.start();

      const chunks: string[] = [];
      const sendPromise = session.send('hello', {
        waitForComplete: true,
        callbacks: { onText: (t: string) => chunks.push(t) },
      });
      setTimeout(() => {
        feedText(mockProc, 'Hello ');
        feedText(mockProc, 'world!\n');
        closeProc(mockProc, 0);
      }, 10);

      const result = await sendPromise;
      expect('text' in result && result.text).toBe('Hello world!');
      expect(chunks.join('')).toBe('Hello world!\n');
    });

    it('estimates tokens since agy emits no usage data', async () => {
      const session = new PersistentAgySession({
        name: 'test',
        cwd: '/tmp',
        permissionMode: 'bypassPermissions',
      });
      await session.start();

      const sendPromise = session.send('a prompt message', { waitForComplete: true });
      setTimeout(() => {
        feedText(mockProc, 'some response text here\n');
        closeProc(mockProc, 0);
      }, 10);

      await sendPromise;
      const stats = session.getStats();
      // Estimation: ~4 chars per token
      expect(stats.tokensIn).toBeGreaterThan(0);
      expect(stats.tokensOut).toBeGreaterThan(0);
    });
  });

  // ─── exit codes ─────────────────────────────────────────────────────────

  describe('exit codes', () => {
    it('rejects on non-zero exit', async () => {
      const session = new PersistentAgySession({
        name: 'test',
        cwd: '/tmp',
        permissionMode: 'bypassPermissions',
      });
      await session.start();

      const sendPromise = session.send('hello', { waitForComplete: true });
      setTimeout(() => closeProc(mockProc, 1), 10);

      await expect(sendPromise).rejects.toThrow('Antigravity exited with code 1');
    });
  });

  // ─── lifecycle ──────────────────────────────────────────────────────────

  describe('lifecycle', () => {
    it('stop() kills in-flight process and removes the log file', async () => {
      const session = new PersistentAgySession({
        name: 'test',
        cwd: '/tmp',
        permissionMode: 'bypassPermissions',
      });
      await session.start();

      session.send('hello', { waitForComplete: false });
      const logFile = logPathFromSpawn();
      fs.writeFileSync(logFile, 'leftover log\n');
      session.stop();

      expect(mockProc.kill).toHaveBeenCalledWith('SIGTERM');
      expect(session.isReady).toBe(false);
      expect(fs.existsSync(logFile)).toBe(false);
    });

    it('compact() returns no-op message', async () => {
      const session = new PersistentAgySession({
        name: 'test',
        cwd: '/tmp',
        permissionMode: 'bypassPermissions',
      });
      await session.start();

      const result = await session.compact();
      expect(result.text).toContain('does not support compaction');
    });

    it('getCost() uses gemini-3.5-flash pricing by default', async () => {
      const session = new PersistentAgySession({
        name: 'test',
        cwd: '/tmp',
        permissionMode: 'bypassPermissions',
      });
      await session.start();

      const cost = session.getCost();
      expect(cost.model).toBe('gemini-3.5-flash');
      expect(cost.pricing.inputPer1M).toBe(0.5);
      expect(cost.pricing.outputPer1M).toBe(3);
    });
  });

  // ─── stderr sanitization ────────────────────────────────────────────────

  describe('stderr sanitization', () => {
    it('redacts bearer tokens from stderr', async () => {
      const session = new PersistentAgySession({
        name: 'test',
        cwd: '/tmp',
        permissionMode: 'bypassPermissions',
      });
      await session.start();

      const logs: string[] = [];
      session.on('log', (msg: string) => logs.push(msg));

      const sendPromise = session.send('hello', { waitForComplete: true });
      setTimeout(() => {
        mockProc.stderr.emit('data', Buffer.from('auth failed: Bearer ya29.secret-token not valid'));
        closeProc(mockProc, 0);
      }, 10);

      await sendPromise;
      expect(logs.some((l) => l.includes('Bearer ***'))).toBe(true);
      expect(logs.some((l) => l.includes('ya29.secret-token'))).toBe(false);
    });

    it('redacts sk-style keys and Google API key env vars from stderr', async () => {
      const session = new PersistentAgySession({
        name: 'test',
        cwd: '/tmp',
        permissionMode: 'bypassPermissions',
      });
      await session.start();

      const logs: string[] = [];
      session.on('log', (msg: string) => logs.push(msg));

      const sendPromise = session.send('hello', { waitForComplete: true });
      setTimeout(() => {
        mockProc.stderr.emit('data', Buffer.from('GEMINI_API_KEY=AIza12345 key=sk-proj-abcdef1234567890'));
        closeProc(mockProc, 0);
      }, 10);

      await sendPromise;
      expect(logs.some((l) => l.includes('GEMINI_API_KEY=***'))).toBe(true);
      expect(logs.some((l) => l.includes('sk-***'))).toBe(true);
      expect(logs.some((l) => l.includes('AIza12345'))).toBe(false);
      expect(logs.some((l) => l.includes('sk-proj-abcdef'))).toBe(false);
    });
  });
});
