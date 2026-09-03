/**
 * Unit tests for PersistentAgySession
 *
 * Tests flag construction, stream-json/plain-text collection, conversation-ID
 * capture, timeout coherence, and stats tracking. Uses vitest mocks for
 * child_process.spawn to avoid spawning real processes.
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

    it('passes the session reasoning effort to agy', async () => {
      const session = new PersistentAgySession({
        name: 'test',
        cwd: '/tmp',
        permissionMode: 'bypassPermissions',
        model: 'gemini-3.5-flash',
        effort: 'high',
      });
      await session.start();

      const sendPromise = session.send('hello', { waitForComplete: true });
      setTimeout(() => closeProc(mockProc, 0), 10);
      await sendPromise;

      const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
      const idx = spawnArgs.indexOf('--effort');
      expect(idx).toBeGreaterThan(-1);
      expect(spawnArgs[idx + 1]).toBe('high');
    });

    it('lets a per-turn reasoning effort override the session default', async () => {
      const session = new PersistentAgySession({
        name: 'test',
        cwd: '/tmp',
        permissionMode: 'bypassPermissions',
        effort: 'high',
      });
      await session.start();

      const sendPromise = session.send('hello', { waitForComplete: true, effort: 'medium' });
      setTimeout(() => closeProc(mockProc, 0), 10);
      await sendPromise;

      const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
      const idx = spawnArgs.indexOf('--effort');
      expect(spawnArgs[idx + 1]).toBe('medium');
      expect(spawnArgs.filter((arg) => arg === '--effort')).toHaveLength(1);
    });

    it.each(['max', 'xhigh'] as const)('maps engine-wide %s effort to agy high', async (effort) => {
      const session = new PersistentAgySession({
        name: 'test',
        cwd: '/tmp',
        permissionMode: 'bypassPermissions',
        effort,
      });
      await session.start();

      const sendPromise = session.send('hello', { waitForComplete: true });
      setTimeout(() => closeProc(mockProc, 0), 10);
      await sendPromise;

      const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
      const idx = spawnArgs.indexOf('--effort');
      expect(spawnArgs[idx + 1]).toBe('high');
    });

    it('uses agy high for an unsuffixed model when effort is auto', async () => {
      const session = new PersistentAgySession({
        name: 'test',
        cwd: '/tmp',
        permissionMode: 'bypassPermissions',
        model: 'gemini-3.5-flash',
        effort: 'auto',
      });
      await session.start();

      const sendPromise = session.send('hello', { waitForComplete: true });
      setTimeout(() => closeProc(mockProc, 0), 10);
      await sendPromise;

      const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
      const idx = spawnArgs.indexOf('--effort');
      expect(spawnArgs[idx + 1]).toBe('high');
    });

    it('omits --effort for auto when no model is selected', async () => {
      const session = new PersistentAgySession({
        name: 'test',
        cwd: '/tmp',
        permissionMode: 'bypassPermissions',
        effort: 'auto',
      });
      await session.start();

      const sendPromise = session.send('hello', { waitForComplete: true });
      setTimeout(() => closeProc(mockProc, 0), 10);
      await sendPromise;

      const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
      expect(spawnArgs).not.toContain('--effort');
    });

    it('does not duplicate effort for an effort-qualified model slug', async () => {
      const session = new PersistentAgySession({
        name: 'test',
        cwd: '/tmp',
        permissionMode: 'bypassPermissions',
        model: 'gemini-3.7-flash-high',
        effort: 'auto',
      });
      await session.start();

      const sendPromise = session.send('hello', { waitForComplete: true });
      setTimeout(() => closeProc(mockProc, 0), 10);
      await sendPromise;

      const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
      expect(spawnArgs).toContain('gemini-3.7-flash-high');
      expect(spawnArgs).not.toContain('--effort');
    });

    it('strips a conflicting model effort suffix for a per-turn override', async () => {
      const session = new PersistentAgySession({
        name: 'test',
        cwd: '/tmp',
        permissionMode: 'bypassPermissions',
        model: 'gemini-3.7-flash-low',
        effort: 'auto',
      });
      await session.start();

      const sendPromise = session.send('hello', { waitForComplete: true, effort: 'high' });
      setTimeout(() => closeProc(mockProc, 0), 10);
      await sendPromise;

      const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
      const modelIdx = spawnArgs.indexOf('--model');
      const effortIdx = spawnArgs.indexOf('--effort');
      expect(spawnArgs[modelIdx + 1]).toBe('gemini-3.7-flash');
      expect(spawnArgs[effortIdx + 1]).toBe('high');
    });
  });

  // ─── structured turn errors ─────────────────────────────────────────────

  describe('turn errors', () => {
    const ERROR_RESULT = JSON.stringify({
      event: 'result',
      result: {
        conversation_id: '',
        status: 'ERROR',
        response: '',
        error:
          'invalid model selection (--model "gemini-3.1-pro" --effort "medium"): gemini-3.1-pro has no "medium" effort (available: low, high)',
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });

    it("surfaces agy's own message instead of the bare exit code", async () => {
      const session = new PersistentAgySession({
        name: 'test',
        cwd: '/tmp',
        permissionMode: 'bypassPermissions',
      });
      await session.start();

      const sendPromise = session.send('hello', { waitForComplete: true });
      feedText(mockProc, ERROR_RESULT + '\n');
      setTimeout(() => closeProc(mockProc, 1), 10);

      // agy prints the rejection on stdout as a stream-json result event and
      // writes nothing to stderr, so without capturing `error` the caller only
      // ever saw "Antigravity exited with code 1".
      await expect(sendPromise).rejects.toThrow(/no "medium" effort \(available: low, high\)/);
    });

    it('rejects a result error even when the process exits 0', async () => {
      const session = new PersistentAgySession({
        name: 'test',
        cwd: '/tmp',
        permissionMode: 'bypassPermissions',
      });
      await session.start();

      const sendPromise = session.send('hello', { waitForComplete: true });
      feedText(mockProc, ERROR_RESULT + '\n');
      setTimeout(() => closeProc(mockProc, 0), 10);

      await expect(sendPromise).rejects.toThrow(/invalid model selection/);
    });

    it('still resolves a successful turn', async () => {
      const session = new PersistentAgySession({
        name: 'test',
        cwd: '/tmp',
        permissionMode: 'bypassPermissions',
      });
      await session.start();

      const sendPromise = session.send('hello', { waitForComplete: true });
      feedText(
        mockProc,
        JSON.stringify({ event: 'result', result: { conversation_id: 'c1', status: 'SUCCESS', response: 'OK' } }) +
          '\n',
      );
      setTimeout(() => closeProc(mockProc, 0), 10);

      const result = (await sendPromise) as { text: string };
      expect(result.text).toBe('OK');
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
    // Regression guard: agy grew `--output-format stream-json`, whose `result`
    // event carries real usage. Before that this wrapper estimated ~4 chars per
    // token from the message text, which under-counted the prompt by orders of
    // magnitude (a short prompt estimated ~27 tokens against a real ~15k).
    it('takes token usage from the result event instead of estimating', async () => {
      const session = new PersistentAgySession({ name: 'test', cwd: '/tmp' });
      await session.start();

      const p = session.send('hello', { waitForComplete: true });
      setTimeout(() => {
        feedText(
          mockProc,
          JSON.stringify({
            event: 'result',
            result: {
              conversation_id: '11111111-2222-3333-4444-555555555555',
              status: 'SUCCESS',
              response: 'OK',
              usage: { input_tokens: 14922, output_tokens: 24, cache_read_tokens: 7 },
            },
          }) + '\n',
        );
        closeProc(mockProc, 0);
      }, 10);
      await p;

      const stats = session.getStats();
      expect(stats.tokensIn).toBe(14922);
      expect(stats.tokensOut).toBe(24);
      expect(stats.cachedTokens).toBe(7);
      // The id comes off the stream, so no log-file scrape is needed.
      expect(session.conversationId).toBe('11111111-2222-3333-4444-555555555555');
    });

    it('takes the conversation id from the init event', async () => {
      const session = new PersistentAgySession({ name: 'test', cwd: '/tmp' });
      await session.start();

      const p = session.send('hello', { waitForComplete: true });
      setTimeout(() => {
        feedText(
          mockProc,
          JSON.stringify({ event: 'init', conversation_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }) + '\n',
        );
        closeProc(mockProc, 0);
      }, 10);
      await p;

      expect(session.conversationId).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    });

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

    it('getCost() uses gemini-3.8-flash pricing by default', async () => {
      const session = new PersistentAgySession({
        name: 'test',
        cwd: '/tmp',
        permissionMode: 'bypassPermissions',
      });
      await session.start();

      const cost = session.getCost();
      // 3.8, not 3.5: agy 1.1.25 stopped serving 3.5 (status: ERROR), and this
      // wrapper always sends --model, so the default here is what really runs.
      expect(cost.model).toBe('gemini-3.8-flash');
      expect(cost.pricing.inputPer1M).toBe(0.75);
      expect(cost.pricing.outputPer1M).toBe(3.75);
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

  // ─── turnsSucceeded ─────────────────────────────────────────────────────
  //
  // agy is the engine where the exit code is the weakest of the three signals: it
  // can exit 0 while its own result event reports a non-SUCCESS status. That turn
  // resolves — so it used to reach the caller, and the run ledger, as a success.
  describe('turnsSucceeded', () => {
    it('does not count exit 0 with a non-SUCCESS status, and says so in the event', async () => {
      const session = new PersistentAgySession({ name: 'test', cwd: '/tmp', permissionMode: 'default' });
      await session.start();

      const sendPromise = session.send('hello', { waitForComplete: true });
      feedText(
        mockProc,
        JSON.stringify({
          event: 'result',
          // No `error` field: nothing but the status marks this turn as failed.
          result: { conversation_id: 'c1', status: 'STOPPED', response: 'partial' },
        }) + '\n',
      );
      setTimeout(() => closeProc(mockProc, 0), 10);

      // It resolves — which is exactly why the status has to be read.
      const result = (await sendPromise) as { text: string; event: { stop_reason: string } };
      expect(result.event.stop_reason).toBe('error');

      const stats = session.getStats();
      expect(stats.turns).toBe(1);
      expect(stats.turnsSucceeded).toBe(0);
    });

    // Regression guard: agy can report SUCCESS and still exit non-zero (it answers,
    // then dies in cleanup). That turn's promise REJECTS, so counting it as succeeded
    // would put the counter and the caller's outcome in direct contradiction.
    it('does not count a SUCCESS status that exits non-zero', async () => {
      const session = new PersistentAgySession({ name: 'test', cwd: '/tmp', permissionMode: 'default' });
      await session.start();

      const sendPromise = session.send('hello', { waitForComplete: true });
      feedText(
        mockProc,
        JSON.stringify({ event: 'result', result: { conversation_id: 'c1', status: 'SUCCESS', response: 'OK' } }) +
          '\n',
      );
      setTimeout(() => closeProc(mockProc, 1), 10);
      await expect(sendPromise).rejects.toThrow(/exited with code 1/);

      const stats = session.getStats();
      expect(stats.turns).toBe(1);
      expect(stats.turnsSucceeded).toBe(0);
    });

    // A failure agy already reported must not be erased by a later SUCCESS in the same
    // turn: the status is recorded sticky.
    it('does not count a turn whose earlier result event reported a failure', async () => {
      const session = new PersistentAgySession({ name: 'test', cwd: '/tmp', permissionMode: 'default' });
      await session.start();

      const sendPromise = session.send('hello', { waitForComplete: true });
      feedText(
        mockProc,
        JSON.stringify({ event: 'result', result: { conversation_id: 'c1', status: 'STOPPED', response: 'partial' } }) +
          '\n' +
          JSON.stringify({ event: 'result', result: { conversation_id: 'c1', status: 'SUCCESS', response: 'OK' } }) +
          '\n',
      );
      setTimeout(() => closeProc(mockProc, 0), 10);
      const result = (await sendPromise) as { event: { stop_reason: string } };

      expect(result.event.stop_reason).toBe('error');
      expect(session.getStats().turnsSucceeded).toBe(0);
    });

    it('counts a SUCCESS status', async () => {
      const session = new PersistentAgySession({ name: 'test', cwd: '/tmp', permissionMode: 'default' });
      await session.start();

      const sendPromise = session.send('hello', { waitForComplete: true });
      feedText(
        mockProc,
        JSON.stringify({ event: 'result', result: { conversation_id: 'c1', status: 'SUCCESS', response: 'OK' } }) +
          '\n',
      );
      setTimeout(() => closeProc(mockProc, 0), 10);
      await sendPromise;

      const stats = session.getStats();
      expect(stats.turns).toBe(1);
      expect(stats.turnsSucceeded).toBe(1);
    });
  });
});
