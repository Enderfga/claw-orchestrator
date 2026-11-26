/**
 * Unit tests for PersistentCursorSession
 *
 * Tests the stream-json parsing logic, flag construction, and stats tracking.
 * Uses vitest mocks for child_process.spawn to avoid spawning real processes.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Mock child_process before importing the session
const mockSpawn = vi.fn();
vi.mock('../engine-spawn.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../engine-spawn.js')>()),
  spawnEngine: (...args: unknown[]) => mockSpawn(...args),
}));

// Import after mocking
const { PersistentCursorSession, cursorPricingModel } = await import('../persistent-cursor-session.js');
const { getModelPricing, getContextWindow } = await import('../models.js');

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

describe('PersistentCursorSession', () => {
  let mockProc: ReturnType<typeof createMockProcess>;

  beforeEach(() => {
    mockProc = createMockProcess();
    mockSpawn.mockReset();
    mockSpawn.mockReturnValue(mockProc);
  });

  // ─── start() ────────────────────────────────────────────────────────────

  describe('start()', () => {
    it('initializes session and emits ready', async () => {
      const session = new PersistentCursorSession({ name: 'test', cwd: '/tmp', permissionMode: 'default' });
      const readyFn = vi.fn();
      session.on('ready', readyFn);

      await session.start();

      expect(session.isReady).toBe(true);
      expect(session.sessionId).toMatch(/^cursor-/);
      expect(readyFn).toHaveBeenCalled();
    });
  });

  // ─── spawn flags ────────────────────────────────────────────────────────

  describe('spawn flags', () => {
    it('uses -p --force --trust --output-format stream-json', async () => {
      const session = new PersistentCursorSession({
        name: 'test',
        cwd: '/tmp',
        permissionMode: 'bypassPermissions',
        model: 'sonnet-4',
      });
      await session.start();

      const sendPromise = session.send('hello', { waitForComplete: true });
      setTimeout(() => closeProc(mockProc, 0), 10);
      await sendPromise;

      const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
      expect(spawnArgs).toContain('-p');
      expect(spawnArgs).toContain('--force');
      expect(spawnArgs).toContain('--trust');
      expect(spawnArgs).toContain('--output-format');
      expect(spawnArgs).toContain('stream-json');
      expect(spawnArgs).toContain('--model');
      expect(spawnArgs).toContain('sonnet-4');
    });

    // Regression guard: `agent -p` opens a NEW chat unless --resume names one, so
    // omitting it made every turn amnesiac. Verified against 2026.08.11: without
    // the flag turn 2 has no memory of turn 1; with it, turn 2 recalls it.
    it('passes --resume with the harvested chat id on the second turn', async () => {
      const session = new PersistentCursorSession({ name: 'test', cwd: '/tmp' });
      await session.start();

      const p1 = session.send('first', { waitForComplete: true });
      setTimeout(() => {
        feedLines(mockProc, [JSON.stringify({ type: 'system', session_id: 'chat-abc123' })]);
        closeProc(mockProc, 0);
      }, 10);
      await p1;

      const proc2 = createMockProcess();
      mockSpawn.mockReturnValue(proc2);
      const p2 = session.send('second', { waitForComplete: true });
      setTimeout(() => closeProc(proc2, 0), 10);
      await p2;

      const args1 = mockSpawn.mock.calls[0][1] as string[];
      const args2 = mockSpawn.mock.calls[1][1] as string[];
      expect(args1).not.toContain('--resume');
      expect(args2).toContain('--resume');
      expect(args2[args2.indexOf('--resume') + 1]).toBe('chat-abc123');
      // --continue resumes "the latest chat" and would collide across sessions.
      expect(args2).not.toContain('--continue');
    });

    it('resumes a persisted cursor chat id from config', async () => {
      const session = new PersistentCursorSession({
        name: 'test',
        cwd: '/tmp',
        resumeSessionId: 'cursor-live-chat-persisted',
      });
      await session.start();

      const p = session.send('hello', { waitForComplete: true });
      setTimeout(() => closeProc(mockProc, 0), 10);
      await p;

      const args = mockSpawn.mock.calls[0][1] as string[];
      expect(args).toContain('--resume');
      expect(args[args.indexOf('--resume') + 1]).toBe('chat-persisted');
    });

    it('enforces read-only via an isolated deny config, not just --mode plan', async () => {
      const session = new PersistentCursorSession({
        name: 'test',
        cwd: '/tmp/realrepo',
        permissionMode: 'manual',
        sandboxMode: 'read-only',
      });
      await session.start();

      const sendPromise = session.send('hello', { waitForComplete: true });
      setTimeout(() => closeProc(mockProc, 0), 10);
      await sendPromise;

      const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
      const spawnOpts = mockSpawn.mock.calls[0][2] as { cwd: string };
      // --mode plan steers the model; --sandbox must NOT be added (it re-enables writes)
      expect(spawnArgs).toContain('--mode');
      expect(spawnArgs).toContain('plan');
      expect(spawnArgs).not.toContain('--force');
      expect(spawnArgs).not.toContain('--sandbox');
      // The real repo is the workspace, but the process cwd is an isolated temp
      // dir carrying the binding deny config — the repo tree is never touched.
      expect(spawnArgs).toContain('--workspace');
      expect(spawnArgs).toContain('/tmp/realrepo');
      expect(spawnOpts.cwd).not.toBe('/tmp/realrepo');
      expect(spawnOpts.cwd).toContain('claw-cursor-ro-');
      const cfg = JSON.parse(readFileSync(join(spawnOpts.cwd, '.cursor', 'cli.json'), 'utf8')) as {
        permissions: { deny: string[] };
      };
      expect(cfg.permissions.deny).toEqual(expect.arrayContaining(['Write(**)', 'Edit(**)', 'Shell(**)']));
      session.stop();
    });

    it('write-enabled sessions run from the real cwd with --force and no deny config', async () => {
      const session = new PersistentCursorSession({
        name: 'test',
        cwd: '/tmp/realrepo',
        permissionMode: 'bypassPermissions',
      });
      await session.start();
      const sendPromise = session.send('hello', { waitForComplete: true });
      setTimeout(() => closeProc(mockProc, 0), 10);
      await sendPromise;
      const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
      const spawnOpts = mockSpawn.mock.calls[0][2] as { cwd: string };
      expect(spawnArgs).toContain('--force');
      expect(spawnArgs).not.toContain('--mode');
      expect(spawnOpts.cwd).toBe('/tmp/realrepo');
    });

    it('passes --workspace for cwd', async () => {
      const session = new PersistentCursorSession({
        name: 'test',
        cwd: '/tmp/project',
        permissionMode: 'default',
      });
      await session.start();

      const sendPromise = session.send('hello', { waitForComplete: true });
      setTimeout(() => closeProc(mockProc, 0), 10);
      await sendPromise;

      const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
      expect(spawnArgs).toContain('--workspace');
      expect(spawnArgs).toContain('/tmp/project');
    });

    it('omits --model when not specified', async () => {
      const session = new PersistentCursorSession({
        name: 'test',
        cwd: '/tmp',
        permissionMode: 'default',
      });
      await session.start();

      const sendPromise = session.send('hello', { waitForComplete: true });
      setTimeout(() => closeProc(mockProc, 0), 10);
      await sendPromise;

      const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
      expect(spawnArgs).not.toContain('--model');
    });
  });

  // ─── stream-json parsing ────────────────────────────────────────────────

  describe('stream-json parsing', () => {
    it('accumulates text from assistant events (Cursor format)', async () => {
      const session = new PersistentCursorSession({
        name: 'test',
        cwd: '/tmp',
        permissionMode: 'bypassPermissions',
      });
      await session.start();

      const sendPromise = session.send('hello', { waitForComplete: true });
      setTimeout(() => {
        feedLines(mockProc, [
          JSON.stringify({ type: 'system', subtype: 'init', session_id: 'abc-123' }),
          JSON.stringify({
            type: 'assistant',
            message: { role: 'assistant', content: [{ type: 'text', text: 'Hello ' }] },
          }),
          JSON.stringify({
            type: 'assistant',
            message: { role: 'assistant', content: [{ type: 'text', text: 'world!' }] },
          }),
        ]);
        closeProc(mockProc, 0);
      }, 10);

      const result = await sendPromise;
      expect('text' in result && result.text).toBe('Hello world!');
    });

    it('extracts real token usage from result event (Cursor camelCase)', async () => {
      const session = new PersistentCursorSession({
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
            result: 'done',
            usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 20 },
          }),
        ]);
        closeProc(mockProc, 0);
      }, 10);

      await sendPromise;
      const stats = session.getStats();
      expect(stats.tokensIn).toBe(100);
      expect(stats.tokensOut).toBe(50);
      expect(stats.cachedTokens).toBe(20);
    });

    it('tracks tool_use and tool_result events', async () => {
      const session = new PersistentCursorSession({
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

    it('tracks the current tool_call events (Cursor 2026.05+: started/completed)', async () => {
      const session = new PersistentCursorSession({ name: 'test', cwd: '/tmp', permissionMode: 'bypassPermissions' });
      await session.start();

      const sendPromise = session.send('hello', { waitForComplete: true });
      setTimeout(() => {
        feedLines(mockProc, [
          JSON.stringify({ type: 'tool_call', subtype: 'started', name: 'edit' }),
          JSON.stringify({ type: 'tool_call', subtype: 'completed', name: 'edit', status: 'completed' }),
          JSON.stringify({ type: 'tool_call', subtype: 'started', name: 'shell' }),
          JSON.stringify({ type: 'tool_call', subtype: 'completed', name: 'shell', status: 'error' }),
        ]);
        closeProc(mockProc, 0);
      }, 10);

      await sendPromise;
      const stats = session.getStats();
      // Count once per call (on 'started'); error read off the 'completed' event.
      expect(stats.toolCalls).toBe(2);
      expect(stats.toolErrors).toBe(1);
    });

    it('falls back to token estimation when no usage in events', async () => {
      const session = new PersistentCursorSession({
        name: 'test',
        cwd: '/tmp',
        permissionMode: 'bypassPermissions',
      });
      await session.start();

      const sendPromise = session.send('a prompt message', { waitForComplete: true });
      setTimeout(() => {
        feedLines(mockProc, [
          JSON.stringify({
            type: 'assistant',
            message: { role: 'assistant', content: [{ type: 'text', text: 'some response text here' }] },
          }),
        ]);
        closeProc(mockProc, 0);
      }, 10);

      await sendPromise;
      const stats = session.getStats();
      expect(stats.tokensIn).toBeGreaterThan(0);
      expect(stats.tokensOut).toBeGreaterThan(0);
    });
  });

  // ─── exit codes ─────────────────────────────────────────────────────────

  describe('exit codes', () => {
    it('rejects on non-zero exit with no output', async () => {
      const session = new PersistentCursorSession({
        name: 'test',
        cwd: '/tmp',
        permissionMode: 'bypassPermissions',
      });
      await session.start();

      const sendPromise = session.send('hello', { waitForComplete: true });
      setTimeout(() => closeProc(mockProc, 1), 10);

      await expect(sendPromise).rejects.toThrow('Cursor exited with code 1');
    });
  });

  // ─── stop / compact / cost ──────────────────────────────────────────────

  describe('lifecycle', () => {
    it('stop() kills in-flight process', async () => {
      const session = new PersistentCursorSession({
        name: 'test',
        cwd: '/tmp',
        permissionMode: 'bypassPermissions',
      });
      await session.start();

      session.send('hello', { waitForComplete: false });

      session.stop();
      expect(mockProc.kill).toHaveBeenCalledWith('SIGTERM');
      expect(session.isReady).toBe(false);
    });

    it('compact() returns no-op message', async () => {
      const session = new PersistentCursorSession({
        name: 'test',
        cwd: '/tmp',
        permissionMode: 'bypassPermissions',
      });
      await session.start();

      const result = await session.compact();
      expect(result.text).toContain('does not support compaction');
    });

    it("getCost() names auto, Cursor's default, before a turn has reported a model", async () => {
      const session = new PersistentCursorSession({
        name: 'test',
        cwd: '/tmp',
        permissionMode: 'bypassPermissions',
      });
      await session.start();

      const cost = session.getCost();
      expect(cost.model).toBe('auto');
    });
  });

  // ─── stderr sanitization ────────────────────────────────────────────────

  describe('stderr sanitization', () => {
    it('redacts CURSOR_API_KEY from stderr', async () => {
      const session = new PersistentCursorSession({
        name: 'test',
        cwd: '/tmp',
        permissionMode: 'bypassPermissions',
      });
      await session.start();

      const logs: string[] = [];
      session.on('log', (msg: string) => logs.push(msg));

      const sendPromise = session.send('hello', { waitForComplete: true });
      setTimeout(() => {
        mockProc.stderr.emit('data', Buffer.from('Error: CURSOR_API_KEY=sk-12345 not valid'));
        closeProc(mockProc, 0);
      }, 10);

      await sendPromise;
      expect(logs.some((l) => l.includes('CURSOR_API_KEY=***'))).toBe(true);
      expect(logs.some((l) => l.includes('sk-12345'))).toBe(false);
    });
  });

  describe('turnsSucceeded', () => {
    it('counts a clean turn and not a non-zero exit', async () => {
      const session = new PersistentCursorSession({ name: 'test', cwd: '/tmp', permissionMode: 'bypassPermissions' });
      await session.start();

      const p1 = session.send('hello', { waitForComplete: true });
      setTimeout(() => closeProc(mockProc, 0), 10);
      await p1;
      expect(session.getStats().turnsSucceeded).toBe(1);

      const proc2 = createMockProcess();
      mockSpawn.mockReturnValue(proc2);
      const p2 = session.send('again', { waitForComplete: true });
      setTimeout(() => closeProc(proc2, 1), 10);
      await expect(p2).rejects.toThrow();

      const stats = session.getStats();
      expect(stats.turns).toBe(2);
      expect(stats.turnsSucceeded).toBe(1);
    });
  });

  // ─── Restored as an engine (2026.11.22) ─────────────────────────────────

  describe('sandbox, permissions and directories', () => {
    async function argsFor(config: Record<string, unknown>): Promise<string[]> {
      const session = new PersistentCursorSession({ name: 't', cwd: '/tmp', ...config } as never);
      await session.start();
      const sent = session.send('hi', { waitForComplete: true });
      setTimeout(() => closeProc(mockProc, 0), 10);
      await sent;
      return mockSpawn.mock.calls.at(-1)![1] as string[];
    }

    it("workspace-write runs in Cursor's sandbox and never with --force, which would run commands outside it", async () => {
      const args = await argsFor({ permissionMode: 'bypassPermissions', sandboxMode: 'workspace-write' });
      expect(args.join(' ')).toContain('--sandbox enabled');
      expect(args).not.toContain('--force');
    });

    it('auto takes Auto-review instead of --force; read-only stays in plan mode with neither', async () => {
      const auto = await argsFor({ permissionMode: 'auto' });
      expect(auto).toContain('--auto-review');
      expect(auto).not.toContain('--force');
      const ro = await argsFor({ permissionMode: 'auto', sandboxMode: 'read-only' });
      expect(ro.join(' ')).toContain('--mode plan');
      expect(ro).not.toContain('--auto-review');
      expect(ro).not.toContain('--sandbox');
      expect(await argsFor({ permissionMode: 'bypassPermissions' })).toContain('--force');
    });

    it('adds every addDir and streams partial output', async () => {
      const args = await argsFor({ permissionMode: 'bypassPermissions', addDir: ['/a', '/b'] });
      expect(args.join(' ')).toContain('--add-dir /a --add-dir /b');
      const one = await argsFor({ permissionMode: 'bypassPermissions', pluginDir: '/plugins/mine' });
      expect(one.join(' ')).toContain('--plugin-dir /plugins/mine');
      expect(one.filter((a) => a === '--plugin-dir')).toHaveLength(1);
      expect(args).toContain('--stream-partial-output');
    });
  });

  describe('streamed text and the model that ran', () => {
    it('takes the deltas once, not again from the complete message that follows them', async () => {
      const session = new PersistentCursorSession({ name: 't', cwd: '/tmp', permissionMode: 'bypassPermissions' });
      await session.start();
      const seen: string[] = [];
      const sent = session.send('hi', { waitForComplete: true, callbacks: { onText: (t: string) => seen.push(t) } });
      const msg = (text: string, delta: boolean) =>
        JSON.stringify({
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text }] },
          session_id: 's',
          ...(delta ? { timestamp_ms: 1 } : {}),
        });
      setTimeout(() => {
        feedLines(mockProc, [
          JSON.stringify({ type: 'system', subtype: 'init', session_id: 's', model: 'Auto' }),
          msg('1', true),
          msg('\n2', true),
          // complete, before a tool call: it carries a timestamp too, and a model call id
          JSON.stringify({
            type: 'assistant',
            message: { role: 'assistant', content: [{ type: 'text', text: '1\n2' }] },
            session_id: 's',
            timestamp_ms: 2,
            model_call_id: 'm1',
          }),
          // a second message of the same turn, after a tool call
          msg('done', true),
          msg('done', false),
          JSON.stringify({ type: 'result', result: '1\n2done' }),
        ]);
        closeProc(mockProc, 0);
      }, 10);
      const result = await sent;
      expect('text' in result && result.text).toBe('1\n2done');
      expect(seen).toEqual(['1', '\n2', 'done']);
    });

    it('bills the model Cursor reports: a registry model at its price, auto as Composer 2.5', async () => {
      const session = new PersistentCursorSession({ name: 't', cwd: '/tmp', permissionMode: 'bypassPermissions' });
      await session.start();
      const sent = session.send('hi', { waitForComplete: true });
      setTimeout(() => {
        feedLines(mockProc, [
          JSON.stringify({ type: 'system', subtype: 'init', session_id: 's', model: 'claude-opus-5-5-high-fast' }),
          JSON.stringify({ type: 'result', result: 'ok', usage: { inputTokens: 1_000_000, outputTokens: 0 } }),
        ]);
        closeProc(mockProc, 0);
      }, 10);
      await sent;
      const cost = session.getCost();
      expect(cost.model).toBe('claude-opus-5-5-high-fast');
      expect(cost.totalUsd).toBeCloseTo(getModelPricing('claude-opus-5-5').input, 6);
    });

    it('bills cache reads on top of the input, which Cursor reports without them', async () => {
      const session = new PersistentCursorSession({ name: 't', cwd: '/tmp', permissionMode: 'bypassPermissions' });
      await session.start();
      const sent = session.send('hi', { waitForComplete: true });
      setTimeout(() => {
        feedLines(mockProc, [
          JSON.stringify({ type: 'system', subtype: 'init', session_id: 's', model: 'Auto' }),
          JSON.stringify({
            type: 'result',
            result: 'ok',
            usage: { inputTokens: 1000, outputTokens: 0, cacheReadTokens: 100_000, cacheWriteTokens: 0 },
          }),
        ]);
        closeProc(mockProc, 0);
      }, 10);
      await sent;
      // Composer 2.5: $0.5 input, $0.2 cache read, per 1M.
      expect(session.getCost().totalUsd).toBeCloseTo(0.0005 + 0.02, 8);
    });

    it('measures the context against the window of the model it is priced as, suffixes and all', () => {
      const window = (model?: string) =>
        (
          new PersistentCursorSession({ name: 't', cwd: '/tmp', model } as never) as unknown as {
            _effectiveContextWindow(): number;
          }
        )._effectiveContextWindow();
      expect(window('claude-opus-5-5-high-fast')).toBe(getContextWindow('claude-opus-5-5'));
      expect(window(undefined)).toBe(getContextWindow('composer-2.5'));
    });

    it("maps Cursor's model ids to the registry", () => {
      expect(cursorPricingModel('auto')).toBe('composer-2.5');
      expect(cursorPricingModel('Auto')).toBe('composer-2.5');
      expect(cursorPricingModel('composer-2.5-fast')).toBe('composer-2.5-fast');
      expect(cursorPricingModel('claude-opus-5-5-xhigh-fast')).toBe('claude-opus-5-5');
      expect(cursorPricingModel('claude-sonnet-5-thinking-high')).toBe('claude-sonnet-5');
      expect(cursorPricingModel('claude-4.5-opus-high')).toBe('claude-opus-4-5');
      expect(cursorPricingModel('gpt-5.6-sol-none')).toBe('gpt-5.6-sol');
      expect(cursorPricingModel('cursor-grok-4.6-medium-fast')).toBe('grok-4.6');
      expect(cursorPricingModel('grok-4.7-low')).toBe('grok-4.7');
      expect(cursorPricingModel(undefined)).toBeUndefined();
    });
  });
});
