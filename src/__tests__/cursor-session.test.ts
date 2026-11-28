/**
 * Unit tests for PersistentCursorSession
 *
 * Tests the stream-json parsing logic, flag construction, and stats tracking.
 * Uses vitest mocks for child_process.spawn to avoid spawning real processes.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Mock child_process before importing the session
const mockSpawn = vi.fn();
const mockExec = vi.fn();
vi.mock('../engine-spawn.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../engine-spawn.js')>()),
  spawnEngine: (...args: unknown[]) => mockSpawn(...args),
  execEngine: (...args: unknown[]) => mockExec(...args),
}));

// Every session here mirrors this directory, never the user's own Cursor config,
// and keeps its temporary directories under one that is removed afterwards.
const testTmp = mkdtempSync(join(tmpdir(), 'cursor-session-test-'));
const configHome = join(testTmp, 'home');
mkdirSync(join(configHome, 'skills'), { recursive: true });
writeFileSync(join(configHome, 'cli-config.json'), JSON.stringify({ model: { modelId: 'auto-smart' } }));
const savedTmpdir = process.env.TMPDIR;
process.env.CURSOR_CONFIG_DIR = configHome;
process.env.TMPDIR = testTmp;
afterAll(() => {
  delete process.env.CURSOR_CONFIG_DIR;
  if (savedTmpdir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = savedTmpdir;
  rmSync(testTmp, { recursive: true, force: true });
});

// Import after mocking
const { PersistentCursorSession, cursorPricingModel, cursorPlanText, CURSOR_LOOP_SETTLE_MS } =
  await import('../persistent-cursor-session.js');
const { clearCursorModelIds } = await import('../cursor-models.js');
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

    it('enforces read-only via an isolated deny config, not just the mode', async () => {
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
      // Ask mode steers the model and always answers in text; --sandbox must NOT be
      // added (it re-enables writes)
      expect(spawnArgs.join(' ')).toContain('--mode ask');
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

    // Without --model Cursor runs whatever any Cursor run last selected (it stores
    // every --model as the user's default), so the session always names one.
    it('passes --model auto when not specified', async () => {
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
      expect(spawnArgs[spawnArgs.indexOf('--model') + 1]).toBe('auto');
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

    it('auto takes Auto-review instead of --force; read-only stays in Ask mode with neither', async () => {
      const auto = await argsFor({ permissionMode: 'auto' });
      expect(auto).toContain('--auto-review');
      expect(auto).not.toContain('--force');
      const ro = await argsFor({ permissionMode: 'auto', sandboxMode: 'read-only' });
      expect(ro.join(' ')).toContain('--mode ask');
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

    // The init event names the model for display (`Auto Balance`, `GPT-5.4 Mini Low`),
    // which maps to no price; the id clawo passed with --model is what runs.
    it('bills the model id it passed, never the name Cursor displays', async () => {
      const session = new PersistentCursorSession({
        name: 't',
        cwd: '/tmp',
        permissionMode: 'bypassPermissions',
        model: 'claude-opus-5-5-high-fast',
      });
      await session.start();
      const sent = session.send('hi', { waitForComplete: true });
      setTimeout(() => {
        feedLines(mockProc, [
          JSON.stringify({ type: 'system', subtype: 'init', session_id: 's', model: 'GPT-5.4 Mini Low' }),
          JSON.stringify({ type: 'result', result: 'ok', usage: { inputTokens: 1_000_000, outputTokens: 0 } }),
        ]);
        closeProc(mockProc, 0);
      }, 10);
      await sent;
      const cost = session.getCost();
      expect(cost.model).toBe('claude-opus-5-5-high-fast');
      expect(cost.totalUsd).toBeCloseTo(getModelPricing('claude-opus-5-5').input, 6);
      expect(session.getStats().cursorModelName).toBe('GPT-5.4 Mini Low');
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

// ─── Headless features (2026.11.22) ─────────────────────────────────────────

describe('PersistentCursorSession headless features', () => {
  let proc: ReturnType<typeof createMockProcess>;
  const procs: Array<ReturnType<typeof createMockProcess>> = [];

  beforeEach(() => {
    mockSpawn.mockReset();
    mockExec.mockReset();
    clearCursorModelIds();
    procs.length = 0;
    mockSpawn.mockImplementation(() => {
      proc = createMockProcess();
      // No pid: a signal goes to the mock itself, never to a process group of that number.
      (proc as { pid?: number }).pid = undefined;
      procs.push(proc);
      return proc;
    });
  });

  const argsOf = (i = -1) => mockSpawn.mock.calls.at(i)![1] as string[];
  const flag = (args: string[], name: string) => args[args.indexOf(name) + 1];
  const started = async (config: Record<string, unknown> = {}) => {
    const session = new PersistentCursorSession({
      name: 't',
      cwd: '/tmp',
      permissionMode: 'bypassPermissions',
      ...config,
    } as never);
    await session.start();
    return session;
  };
  /** Send, feed the process these lines, close it with `code`. */
  const turn = async (
    session: InstanceType<typeof PersistentCursorSession>,
    message: string,
    lines: unknown[],
    opts: Record<string, unknown> = {},
    code = 0,
  ) => {
    const before = mockSpawn.mock.calls.length;
    const sent = session.send(message, { waitForComplete: true, ...opts });
    await vi.waitFor(() => expect(mockSpawn.mock.calls.length).toBeGreaterThan(before));
    const p = procs.at(-1)!;
    feedLines(
      p,
      lines.map((l) => JSON.stringify(l)),
    );
    setTimeout(() => closeProc(p, code), 5);
    return sent;
  };
  const result = (usage: Record<string, number>) => ({ type: 'result', subtype: 'success', result: '', usage });

  describe("the user's Cursor config", () => {
    it('runs Cursor on a config directory of its own: links to the user entries, a copy of cli-config.json', async () => {
      const session = await started({ model: 'gpt-5.4-mini' });
      await turn(session, 'hi', [result({ inputTokens: 1, outputTokens: 1 })]);
      const env = mockSpawn.mock.calls[0][2].env as Record<string, string>;
      const dir = env.CURSOR_CONFIG_DIR;
      expect(dir).toBeTruthy();
      expect(dir).not.toBe(configHome);
      expect(lstatSync(join(dir, 'skills')).isSymbolicLink()).toBe(true);
      expect(lstatSync(join(dir, 'chats')).isSymbolicLink()).toBe(true);
      expect(lstatSync(join(dir, 'cli-config.json')).isSymbolicLink()).toBe(false);
      // What Cursor writes into its copy (the model it was given) stays there …
      writeFileSync(join(dir, 'cli-config.json'), JSON.stringify({ model: { modelId: 'gpt-5.4-mini' } }));
      expect(JSON.parse(readFileSync(join(configHome, 'cli-config.json'), 'utf8')).model.modelId).toBe('auto-smart');
      // … and the next turn starts from the user's file again.
      await turn(session, 'again', [result({ inputTokens: 1, outputTokens: 1 })]);
      expect(JSON.parse(readFileSync(join(dir, 'cli-config.json'), 'utf8')).model.modelId).toBe('auto-smart');
      session.stop();
    });
  });

  describe('models and effort', () => {
    it('takes a model for one send, and prices each turn at the model it ran on', async () => {
      const session = await started({ model: 'claude-opus-5-5-high' });
      expect(session.perSendModel).toBe(true);
      await turn(session, 'one', [result({ inputTokens: 1_000_000, outputTokens: 0 })], { model: 'gpt-5.4-mini' });
      expect(flag(argsOf(), '--model')).toBe('gpt-5.4-mini');
      const first = session.getStats().costUsd;
      expect(first).toBeCloseTo(getModelPricing('gpt-5.4-mini').input, 6);
      await turn(session, 'two', [result({ inputTokens: 1_000_000, outputTokens: 0 })]);
      expect(flag(argsOf(), '--model')).toBe('claude-opus-5-5-high');
      // The first turn keeps its price: the second adds Opus's, nothing is repriced.
      expect(session.getStats().costUsd).toBeCloseTo(first + getModelPricing('claude-opus-5-5').input, 6);
      expect(session.getCost().model).toBe('claude-opus-5-5-high');
    });

    it('switches the model in place: the next process runs on it', async () => {
      const session = await started({ model: 'composer-2.5' });
      expect(await session.setModelLive('gpt-5.4-mini')).toBe(true);
      await turn(session, 'hi', [result({ inputTokens: 1, outputTokens: 1 })]);
      expect(flag(argsOf(), '--model')).toBe('gpt-5.4-mini');
    });

    it("writes the effort into the model id from Cursor's list, the send's over the session's", async () => {
      mockExec.mockResolvedValue({
        stdout: [
          'Available models',
          '',
          'claude-opus-5-5-low - Opus 5.5 Low',
          'claude-opus-5-5-high - Opus 5.5 High',
          'claude-opus-5-5-max - Opus 5.5 Max',
          'claude-opus-5-5-high-fast - Opus 5.5 High Fast',
        ].join('\n'),
        stderr: '',
      });
      const session = await started({ model: 'claude-opus-5-5', effort: 'high' });
      await turn(session, 'a', [result({ inputTokens: 1, outputTokens: 1 })]);
      expect(flag(argsOf(), '--model')).toBe('claude-opus-5-5-high');
      await turn(session, 'b', [result({ inputTokens: 1, outputTokens: 1 })], { effort: 'ultra' });
      expect(flag(argsOf(), '--model')).toBe('claude-opus-5-5-max');
      // No xhigh listed: the nearest lower effort that is.
      await turn(session, 'c', [result({ inputTokens: 1, outputTokens: 1 })], { effort: 'xhigh' });
      expect(flag(argsOf(), '--model')).toBe('claude-opus-5-5-high');
      await turn(session, 'd', [result({ inputTokens: 1, outputTokens: 1 })], { model: 'claude-opus-5-5-fast' });
      expect(flag(argsOf(), '--model')).toBe('claude-opus-5-5-high-fast');
      // Listed once, for every turn.
      expect(mockExec).toHaveBeenCalledTimes(1);
      expect(mockExec.mock.calls[0][1]).toEqual(['models']);
    });
  });

  describe('plan, ask and images', () => {
    it('puts the plan a plan-mode turn writes with CreatePlan into the reply, which Cursor leaves empty', async () => {
      const session = await started({ permissionMode: 'plan' });
      const planCall = {
        createPlanToolCall: {
          args: {
            name: 'Add CONTRIBUTING.md',
            overview: 'One short file.',
            plan: '- create it\n- check it',
            todos: [],
          },
          result: { success: {}, planUri: '' },
        },
      };
      const r = await turn(session, 'plan it', [
        { type: 'tool_call', subtype: 'started', call_id: 'c1', tool_call: planCall },
        { type: 'interaction_query', subtype: 'request', query_type: 'createPlanRequestQuery' },
        { type: 'tool_call', subtype: 'completed', call_id: 'c1', tool_call: planCall },
        result({ inputTokens: 1, outputTokens: 1 }),
      ]);
      expect('text' in r && r.text).toBe('## Add CONTRIBUTING.md\n\nOne short file.\n\n- create it\n- check it');
      // permissionMode 'plan' is read-only: Plan mode, the deny config, never --force.
      const args = argsOf();
      expect(flag(args, '--mode')).toBe('plan');
      expect(args).not.toContain('--force');
      expect(mockSpawn.mock.calls.at(-1)![2].cwd).toContain('claw-cursor-ro-');
      session.stop();
    });

    it('runs one send in Plan mode on a write session, and the next one as before', async () => {
      const session = await started();
      await turn(session, 'plan', [result({ inputTokens: 1, outputTokens: 1 })], { plan: true });
      expect(flag(argsOf(), '--mode')).toBe('plan');
      expect(argsOf()).not.toContain('--force');
      await turn(session, 'do', [result({ inputTokens: 1, outputTokens: 1 })]);
      expect(argsOf()).not.toContain('--mode');
      expect(argsOf()).toContain('--force');
      session.stop();
    });

    it('formats todos after the plan', () => {
      expect(
        cursorPlanText({
          plan: '# Plan\n\nsteps',
          name: 'ignored: the plan has its own heading',
          todos: [
            { content: 'write it', status: 'pending' },
            { content: 'ship it', status: 'TODO_STATUS_COMPLETED' },
          ],
        }),
      ).toBe('# Plan\n\nsteps\n\n- [ ] write it\n- [x] ship it');
      expect(cursorPlanText({})).toBeUndefined();
    });

    it('attaches every image with --image', async () => {
      const session = await started();
      await turn(session, 'look', [result({ inputTokens: 1, outputTokens: 1 })], {
        images: ['/tmp/a.png', '/tmp/b.png'],
      });
      expect(argsOf().join(' ')).toContain('--image /tmp/a.png --image /tmp/b.png');
    });
  });

  describe('/goal and /loop', () => {
    it('refuses /goal as a plain send, before anything runs, and names the goal surface', async () => {
      const session = await started();
      await expect(session.send('/goal ship it', { waitForComplete: true })).rejects.toThrow(/native-goal|nativeGoal/);
      expect(mockSpawn).not.toHaveBeenCalled();
      // A bare /goal only prints Cursor's usage line.
      await turn(session, '/goal', [result({ inputTokens: 1, outputTokens: 1 })]);
      expect(mockSpawn).toHaveBeenCalledTimes(1);
    });

    const delta = (text: string) => ({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text }] },
      timestamp_ms: 1,
    });
    const tick = (n: number) => ({
      type: 'system',
      subtype: 'task_notification',
      title: 'loop tick',
      task_id: `t:${n}`,
    });
    const backgroundShell = [
      { type: 'tool_call', subtype: 'started', tool_call: { shellToolCall: { args: { command: 'while true' } } } },
      {
        type: 'tool_call',
        subtype: 'completed',
        tool_call: { shellToolCall: { args: {}, result: { success: { shellId: 1 }, isBackground: true } } },
      },
    ];

    it('returns the loop setup as the reply and each tick as an engine turn, until interrupted', async () => {
      const session = await started({ model: 'gpt-5.4-mini' });
      const ticks: Array<{ text: string; event: Record<string, unknown> }> = [];
      session.on('unsolicited_result', (t: { text: string; event: Record<string, unknown> }) => ticks.push(t));
      const sent = session.send('/loop 20s say TICK', { waitForComplete: true, timeout: 1_000 });
      await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalled());
      feedLines(
        proc,
        [delta('Loop armed.'), ...backgroundShell, tick(1), delta('TICK 1')].map((l) => JSON.stringify(l)),
      );
      const r = await sent;
      expect('text' in r && r.text).toBe('Loop armed.');
      expect(session.getStats().turnsSucceeded).toBe(1);
      expect(session.isBusy).toBe(true);
      // The send's timeout no longer applies, and a message cannot run beside the loop.
      await new Promise((res) => setTimeout(res, 1_100));
      await expect(session.send('hello', { waitForComplete: true })).rejects.toThrow(/\/loop is running/);
      feedLines(
        proc,
        [tick(2), delta('TICK 2')].map((l) => JSON.stringify(l)),
      );
      await vi.waitFor(() => expect(ticks).toHaveLength(1));
      expect(ticks[0].text).toBe('TICK 1');
      // An interrupt ends the loop once it is quiet between ticks, when Cursor writes its
      // usage as it exits; that usage comes with the last tick.
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      try {
        expect(session.interruptRun()).toBe(true);
        expect(proc.kill).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(9_000);
        expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
      } finally {
        vi.useRealTimers();
      }
      feedLines(proc, [JSON.stringify(result({ inputTokens: 1_000_000, outputTokens: 0 }))]);
      closeProc(proc, 0);
      await vi.waitFor(() => expect(ticks).toHaveLength(2));
      expect(ticks[1].text).toBe('TICK 2');
      expect(ticks[1].event.stop_reason).toBe('end_turn');
      expect(session.getStats().costUsd).toBeCloseTo(getModelPricing('gpt-5.4-mini').input, 6);
      expect(session.getStats().turnsSucceeded).toBe(1);
      expect(session.isBusy).toBe(false);
    });

    it('returns once the loop has gone quiet after starting its ticker, when the first tick is far off', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        const session = await started();
        const sent = session.send('/loop 1h check CI', { waitForComplete: true, timeout: 300_000 });
        await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalled());
        feedLines(
          proc,
          [delta('Checked once; next in 1h.'), ...backgroundShell].map((l) => JSON.stringify(l)),
        );
        await vi.waitFor(() => expect(proc.stdout.readableLength).toBe(0));
        await vi.advanceTimersByTimeAsync(CURSOR_LOOP_SETTLE_MS + 10);
        const r = await sent;
        expect('text' in r && r.text).toBe('Checked once; next in 1h.');
        expect(session.isBusy).toBe(true);
        session.stop();
      } finally {
        vi.useRealTimers();
      }
    });

    it('keeps a plain send whole when a background shell is only part of its work', async () => {
      const session = await started();
      const r = await turn(session, 'run the build in the background and report', [
        delta('Started. '),
        ...backgroundShell,
        { type: 'system', subtype: 'task_notification', title: 'build finished' },
        delta('Build passed.'),
        result({ inputTokens: 1, outputTokens: 1 }),
      ]);
      expect('text' in r && r.text).toBe('Started. Build passed.');
      expect(session.isBusy).toBe(false);
    });
  });

  describe('agents', () => {
    it("writes the session's agents as Cursor subagents in a plugin directory it loads", async () => {
      const session = await started({
        agents: {
          'Probe Two': {
            description: 'Answers "fixed".',
            prompt: 'Reply with exactly: SUB2-OK',
            model: 'gpt-5.4-mini',
          },
        },
      });
      await turn(session, 'delegate', [result({ inputTokens: 1, outputTokens: 1 })]);
      const dir = flag(argsOf(), '--plugin-dir');
      expect(dir).toContain('claw-cursor-agents-');
      expect(JSON.parse(readFileSync(join(dir, '.cursor-plugin', 'plugin.json'), 'utf8'))).toEqual({
        name: 'clawo-agents',
      });
      expect(readFileSync(join(dir, 'agents', 'probe-two.md'), 'utf8')).toBe(
        '---\nname: "Probe Two"\ndescription: "Answers \\"fixed\\"."\nmodel: "gpt-5.4-mini"\n---\nReply with exactly: SUB2-OK\n',
      );
      session.stop();
      expect(() => lstatSync(dir)).toThrow();
    });
  });

  describe('interrupting a turn', () => {
    it('reads the usage Cursor writes on its way out, and fails the turn', async () => {
      const session = await started({ model: 'gpt-5.4-mini' });
      const sent = session.send('long job', { waitForComplete: true });
      await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalled());
      expect(session.interruptRun()).toBe(true);
      feedLines(proc, [JSON.stringify(result({ inputTokens: 1_000_000, outputTokens: 0 }))]);
      setTimeout(() => closeProc(proc, 0), 5);
      await expect(sent).rejects.toThrow(/interrupted/);
      expect(session.getStats().costUsd).toBeCloseTo(getModelPricing('gpt-5.4-mini').input, 6);
      expect(session.getStats().turnsSucceeded).toBe(0);
    });
  });
});
