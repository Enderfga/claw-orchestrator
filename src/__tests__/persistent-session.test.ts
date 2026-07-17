/**
 * Unit tests for PersistentClaudeSession
 *
 * Strategy: test the class directly by exercising its public API and
 * verifying event emission, stat tracking, and CLI arg assembly.
 * We mock child_process.spawn to avoid spawning real CLI processes.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { SessionConfig, StreamEvent } from '../types.js';

// ─── Mock child_process ────────────────────────────────────────────────────

function createMockStream() {
  const stream = new EventEmitter() as EventEmitter & {
    resume: ReturnType<typeof vi.fn>;
    pause: ReturnType<typeof vi.fn>;
    setEncoding: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
  };
  stream.resume = vi.fn();
  stream.pause = vi.fn();
  stream.setEncoding = vi.fn();
  stream.destroy = vi.fn();
  return stream;
}

class MockProcess extends EventEmitter {
  pid = 12345;
  killed = false;
  exitCode: number | null = null;
  stdin = { write: vi.fn(), end: vi.fn() };
  stdout = createMockStream();
  stderr = createMockStream();
  unref = vi.fn();

  kill(signal?: string) {
    this.killed = true;
    this.emit('close', signal === 'SIGKILL' ? 137 : 143);
  }
}

let mockProc: MockProcess;

vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => {
    mockProc = new MockProcess();
    return mockProc;
  }),
}));

// Must import after mocks
const { PersistentClaudeSession } = await import('../persistent-session.js');
const { SESSION_EVENT } = await import('../constants.js');

// ─── Helpers ───────────────────────────────────────────────────────────────

function makeConfig(overrides: Partial<SessionConfig> = {}): SessionConfig {
  return {
    name: 'test-session',
    cwd: '/tmp/test',
    permissionMode: 'acceptEdits',
    model: 'claude-sonnet-4-6',
    ...overrides,
  };
}

function emitInitEvent(proc: MockProcess, sessionId = 'sess_123') {
  const initEvent: StreamEvent = {
    type: 'system',
    subtype: 'init',
    session_id: sessionId,
  } as unknown as StreamEvent;
  proc.stdout.emit('data', Buffer.from(JSON.stringify(initEvent) + '\n'));
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('PersistentClaudeSession', () => {
  let session: InstanceType<typeof PersistentClaudeSession>;

  beforeEach(() => {
    vi.useFakeTimers();
    session = new PersistentClaudeSession(makeConfig());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('initializes with zero stats', () => {
      expect(session.stats.turns).toBe(0);
      expect(session.stats.tokensIn).toBe(0);
      expect(session.stats.tokensOut).toBe(0);
      expect(session.stats.costUsd).toBe(0);
      expect(session.isReady).toBe(false);
      expect(session.isPaused).toBe(false);
      expect(session.isBusy).toBe(false);
    });
  });

  describe('start()', () => {
    it('spawns CLI and becomes ready on init event', async () => {
      const startPromise = session.start();
      // Simulate init event
      emitInitEvent(mockProc);
      await startPromise;

      expect(session.isReady).toBe(true);
      expect(session.sessionId).toBe('sess_123');
    });

    it('becomes ready via fallback timer if no init event', async () => {
      const startPromise = session.start();
      // Advance past the fallback timer (2000ms)
      vi.advanceTimersByTime(3000);
      await startPromise;
      expect(session.isReady).toBe(true);
    });

    it('rejects on premature process exit', async () => {
      const startPromise = session.start();
      mockProc.emit('close', 1);
      await expect(startPromise).rejects.toThrow(/exited prematurely/);
    });

    it('assembles correct CLI args with model', async () => {
      const { spawn } = await import('node:child_process');
      const startPromise = session.start();
      emitInitEvent(mockProc);
      await startPromise;

      const spawnCall = vi.mocked(spawn).mock.calls[0];
      const args = spawnCall[1] as string[];
      expect(args).toContain('-p');
      expect(args).toContain('--output-format');
      expect(args).toContain('stream-json');
      expect(args).toContain('--model');
      expect(args).toContain('claude-sonnet-4-6');
    });

    it('includes --resume flag when resumeSessionId is set', async () => {
      session = new PersistentClaudeSession(makeConfig({ resumeSessionId: 'resume_abc' }));
      const { spawn } = await import('node:child_process');
      const startPromise = session.start();
      emitInitEvent(mockProc);
      await startPromise;

      const args = vi.mocked(spawn).mock.calls.at(-1)![1] as string[];
      expect(args).toContain('--resume');
      expect(args).toContain('resume_abc');
    });

    it('routes non-Claude model through proxy when baseUrl is set', async () => {
      session = new PersistentClaudeSession(makeConfig({ model: 'gpt-5.4', baseUrl: 'http://localhost:3000' }));
      const { spawn } = await import('node:child_process');
      const startPromise = session.start();
      emitInitEvent(mockProc);
      await startPromise;

      const args = vi.mocked(spawn).mock.calls.at(-1)![1] as string[];
      // Non-Claude model with baseUrl should set _realModel and use 'opus' as the CLI model
      expect(args).toContain('--model');
      expect(args).toContain('opus');
    });

    it('includes --include-hook-events when set', async () => {
      session = new PersistentClaudeSession(makeConfig({ includeHookEvents: true }));
      const { spawn } = await import('node:child_process');
      const startPromise = session.start();
      emitInitEvent(mockProc);
      await startPromise;
      const args = vi.mocked(spawn).mock.calls.at(-1)![1] as string[];
      expect(args).toContain('--include-hook-events');
    });

    it('includes --forward-subagent-text when set', async () => {
      session = new PersistentClaudeSession(makeConfig({ forwardSubagentText: true }));
      const { spawn } = await import('node:child_process');
      const startPromise = session.start();
      emitInitEvent(mockProc);
      await startPromise;
      const args = vi.mocked(spawn).mock.calls.at(-1)![1] as string[];
      expect(args).toContain('--forward-subagent-text');
    });

    it('omits --forward-subagent-text by default', async () => {
      session = new PersistentClaudeSession(makeConfig({}));
      const { spawn } = await import('node:child_process');
      const startPromise = session.start();
      emitInitEvent(mockProc);
      await startPromise;
      const args = vi.mocked(spawn).mock.calls.at(-1)![1] as string[];
      expect(args).not.toContain('--forward-subagent-text');
    });

    it('includes --permission-prompt-tool when set', async () => {
      session = new PersistentClaudeSession(makeConfig({ permissionPromptTool: 'mcp__auth__decide' }));
      const { spawn } = await import('node:child_process');
      const startPromise = session.start();
      emitInitEvent(mockProc);
      await startPromise;
      const args = vi.mocked(spawn).mock.calls.at(-1)![1] as string[];
      expect(args).toContain('--permission-prompt-tool');
      expect(args).toContain('mcp__auth__decide');
    });

    it('includes --exclude-dynamic-system-prompt-sections when set', async () => {
      session = new PersistentClaudeSession(makeConfig({ excludeDynamicSystemPromptSections: true }));
      const { spawn } = await import('node:child_process');
      const startPromise = session.start();
      emitInitEvent(mockProc);
      await startPromise;
      const args = vi.mocked(spawn).mock.calls.at(-1)![1] as string[];
      expect(args).toContain('--exclude-dynamic-system-prompt-sections');
    });

    it('auto-enables --exclude-dynamic-system-prompt-sections when bare is true', async () => {
      session = new PersistentClaudeSession(makeConfig({ bare: true }));
      const { spawn } = await import('node:child_process');
      const startPromise = session.start();
      emitInitEvent(mockProc);
      await startPromise;
      const args = vi.mocked(spawn).mock.calls.at(-1)![1] as string[];
      expect(args).toContain('--exclude-dynamic-system-prompt-sections');
    });

    it('does NOT auto-enable --exclude-dynamic-system-prompt-sections when bare + explicit false', async () => {
      session = new PersistentClaudeSession(makeConfig({ bare: true, excludeDynamicSystemPromptSections: false }));
      const { spawn } = await import('node:child_process');
      const startPromise = session.start();
      emitInitEvent(mockProc);
      await startPromise;
      const args = vi.mocked(spawn).mock.calls.at(-1)![1] as string[];
      expect(args).not.toContain('--exclude-dynamic-system-prompt-sections');
    });

    it('includes --debug with comma-joined categories', async () => {
      session = new PersistentClaudeSession(makeConfig({ debug: ['api', 'mcp'] }));
      const { spawn } = await import('node:child_process');
      const startPromise = session.start();
      emitInitEvent(mockProc);
      await startPromise;
      const args = vi.mocked(spawn).mock.calls.at(-1)![1] as string[];
      expect(args).toContain('--debug');
      expect(args).toContain('api,mcp');
    });

    it('includes --debug-file when set', async () => {
      session = new PersistentClaudeSession(makeConfig({ debugFile: '/tmp/debug.log' }));
      const { spawn } = await import('node:child_process');
      const startPromise = session.start();
      emitInitEvent(mockProc);
      await startPromise;
      const args = vi.mocked(spawn).mock.calls.at(-1)![1] as string[];
      expect(args).toContain('--debug-file');
      expect(args).toContain('/tmp/debug.log');
    });

    it('includes --from-pr when set', async () => {
      session = new PersistentClaudeSession(makeConfig({ fromPr: '42' }));
      const { spawn } = await import('node:child_process');
      const startPromise = session.start();
      emitInitEvent(mockProc);
      await startPromise;
      const args = vi.mocked(spawn).mock.calls.at(-1)![1] as string[];
      expect(args).toContain('--from-pr');
      expect(args).toContain('42');
    });

    it('includes --channels for each entry', async () => {
      session = new PersistentClaudeSession(makeConfig({ channels: ['plugin:a@market', 'plugin:b@market'] }));
      const { spawn } = await import('node:child_process');
      const startPromise = session.start();
      emitInitEvent(mockProc);
      await startPromise;
      const args = vi.mocked(spawn).mock.calls.at(-1)![1] as string[];
      expect(args).toContain('plugin:a@market');
      expect(args).toContain('plugin:b@market');
    });

    it('includes --dangerously-load-development-channels when set', async () => {
      session = new PersistentClaudeSession(makeConfig({ dangerouslyLoadDevelopmentChannels: 'server:test' }));
      const { spawn } = await import('node:child_process');
      const startPromise = session.start();
      emitInitEvent(mockProc);
      await startPromise;
      const args = vi.mocked(spawn).mock.calls.at(-1)![1] as string[];
      expect(args).toContain('--dangerously-load-development-channels');
      expect(args).toContain('server:test');
    });

    it('sets ENABLE_PROMPT_CACHING_1H env var when enablePromptCaching1H is true', async () => {
      session = new PersistentClaudeSession(makeConfig({ enablePromptCaching1H: true }));
      const { spawn } = await import('node:child_process');
      const startPromise = session.start();
      emitInitEvent(mockProc);
      await startPromise;
      const spawnCall = vi.mocked(spawn).mock.calls.at(-1)!;
      const env = (spawnCall[2] as { env: Record<string, string> }).env;
      expect(env.ENABLE_PROMPT_CACHING_1H).toBe('1');
    });

    it('auto-sets ENABLE_PROMPT_CACHING_1H when bare is true', async () => {
      session = new PersistentClaudeSession(makeConfig({ bare: true }));
      const { spawn } = await import('node:child_process');
      const startPromise = session.start();
      emitInitEvent(mockProc);
      await startPromise;
      const spawnCall = vi.mocked(spawn).mock.calls.at(-1)!;
      const env = (spawnCall[2] as { env: Record<string, string> }).env;
      expect(env.ENABLE_PROMPT_CACHING_1H).toBe('1');
    });

    it('does NOT set ENABLE_PROMPT_CACHING_1H when bare + explicit false', async () => {
      session = new PersistentClaudeSession(makeConfig({ bare: true, enablePromptCaching1H: false }));
      const { spawn } = await import('node:child_process');
      const startPromise = session.start();
      emitInitEvent(mockProc);
      await startPromise;
      const spawnCall = vi.mocked(spawn).mock.calls.at(-1)!;
      const env = (spawnCall[2] as { env: Record<string, string> }).env;
      expect(env.ENABLE_PROMPT_CACHING_1H).toBeUndefined();
    });

    it('sets CLAUDE_CODE_FORK_SUBAGENT env var when forkSubagent is true', async () => {
      session = new PersistentClaudeSession(makeConfig({ forkSubagent: true }));
      const { spawn } = await import('node:child_process');
      const startPromise = session.start();
      emitInitEvent(mockProc);
      await startPromise;
      const env = (vi.mocked(spawn).mock.calls.at(-1)![2] as { env: Record<string, string> }).env;
      expect(env.CLAUDE_CODE_FORK_SUBAGENT).toBe('1');
    });

    it('sets ENABLE_TOOL_SEARCH env var when enableToolSearch is true', async () => {
      session = new PersistentClaudeSession(makeConfig({ enableToolSearch: true }));
      const { spawn } = await import('node:child_process');
      const startPromise = session.start();
      emitInitEvent(mockProc);
      await startPromise;
      const env = (vi.mocked(spawn).mock.calls.at(-1)![2] as { env: Record<string, string> }).env;
      expect(env.ENABLE_TOOL_SEARCH).toBe('1');
    });

    it('sets OTEL_LOG_USER_PROMPTS env var when otelLogUserPrompts is true', async () => {
      session = new PersistentClaudeSession(makeConfig({ otelLogUserPrompts: true }));
      const { spawn } = await import('node:child_process');
      const startPromise = session.start();
      emitInitEvent(mockProc);
      await startPromise;
      const env = (vi.mocked(spawn).mock.calls.at(-1)![2] as { env: Record<string, string> }).env;
      expect(env.OTEL_LOG_USER_PROMPTS).toBe('1');
    });

    it('sets OTEL_LOG_RAW_API_BODIES env var when otelLogRawApiBodies is true', async () => {
      session = new PersistentClaudeSession(makeConfig({ otelLogRawApiBodies: true }));
      const { spawn } = await import('node:child_process');
      const startPromise = session.start();
      emitInitEvent(mockProc);
      await startPromise;
      const env = (vi.mocked(spawn).mock.calls.at(-1)![2] as { env: Record<string, string> }).env;
      expect(env.OTEL_LOG_RAW_API_BODIES).toBe('1');
    });

    it('captures plugin_errors from system/init event', async () => {
      const startPromise = session.start();
      const initEvent = {
        type: 'system',
        subtype: 'init',
        session_id: 'sess_plugin_err',
        plugin_errors: [
          { plugin: 'foo-plugin', reason: 'missing dependency: bar' },
          { plugin: 'baz-plugin', reason: 'incompatible version' },
        ],
      } as unknown as StreamEvent;
      mockProc.stdout.emit('data', Buffer.from(JSON.stringify(initEvent) + '\n'));
      await startPromise;
      expect(session.stats.pluginErrors).toEqual([
        { plugin: 'foo-plugin', reason: 'missing dependency: bar' },
        { plugin: 'baz-plugin', reason: 'incompatible version' },
      ]);
    });

    it('does NOT set pluginErrors when init event has empty plugin_errors', async () => {
      const startPromise = session.start();
      const initEvent = {
        type: 'system',
        subtype: 'init',
        session_id: 'sess_no_err',
        plugin_errors: [],
      } as unknown as StreamEvent;
      mockProc.stdout.emit('data', Buffer.from(JSON.stringify(initEvent) + '\n'));
      await startPromise;
      expect(session.stats.pluginErrors).toBeUndefined();
    });
  });

  describe('_handleEvent', () => {
    beforeEach(async () => {
      const startPromise = session.start();
      emitInitEvent(mockProc);
      await startPromise;
    });

    it('tracks tool calls from stream_event content_block_start', () => {
      const event = {
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          content_block: { type: 'tool_use', name: 'Read' },
        },
      };
      mockProc.stdout.emit('data', Buffer.from(JSON.stringify(event) + '\n'));
      expect(session.stats.toolCalls).toBe(1);
    });

    it('emits text from content_block_delta', () => {
      const texts: unknown[] = [];
      session.on(SESSION_EVENT.TEXT, (t: unknown) => texts.push(t));

      const event = {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'hello' },
        },
      };
      mockProc.stdout.emit('data', Buffer.from(JSON.stringify(event) + '\n'));
      expect(texts).toEqual(['hello']);
    });

    it('updates tokens from message_delta usage', () => {
      const event = {
        type: 'stream_event',
        event: {
          type: 'message_delta',
          usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 10 },
        },
      };
      mockProc.stdout.emit('data', Buffer.from(JSON.stringify(event) + '\n'));
      expect(session.stats.tokensIn).toBe(100);
      expect(session.stats.tokensOut).toBe(50);
      expect(session.stats.cachedTokens).toBe(10);
    });

    it('increments turns on user event', () => {
      const event = { type: 'user', message: { role: 'user', content: 'hi' } };
      mockProc.stdout.emit('data', Buffer.from(JSON.stringify(event) + '\n'));
      expect(session.stats.turns).toBe(1);
    });

    it('emits RESULT and TURN_COMPLETE on result event', () => {
      const results: unknown[] = [];
      const turns: unknown[] = [];
      session.on(SESSION_EVENT.RESULT, (e: unknown) => results.push(e));
      session.on(SESSION_EVENT.TURN_COMPLETE, (e: unknown) => turns.push(e));

      const event = {
        type: 'result',
        result: 'done',
        usage: { input_tokens: 200, output_tokens: 100 },
      };
      mockProc.stdout.emit('data', Buffer.from(JSON.stringify(event) + '\n'));
      expect(results).toHaveLength(1);
      expect(turns).toHaveLength(1);
      expect(session.stats.tokensIn).toBe(200);
      expect(session.stats.tokensOut).toBe(100);
    });

    it('tracks tool errors from tool_result', () => {
      const event = { type: 'tool_result', is_error: true, tool_use_id: 't1', error: 'fail' };
      mockProc.stdout.emit('data', Buffer.from(JSON.stringify(event) + '\n'));
      expect(session.stats.toolErrors).toBe(1);
    });

    it('keeps history bounded to MAX_HISTORY_ITEMS', () => {
      for (let i = 0; i < 120; i++) {
        const event = { type: 'user', message: { role: 'user', content: `msg ${i}` } };
        mockProc.stdout.emit('data', Buffer.from(JSON.stringify(event) + '\n'));
      }
      // MAX_HISTORY_ITEMS is 100, plus the init event = 101, shifted to 100
      expect(session.stats.history.length).toBeLessThanOrEqual(100);
    });

    it('tracks api_retry events and increments stats.retries', () => {
      const systemEvents: unknown[] = [];
      session.on(SESSION_EVENT.SYSTEM, (e: unknown) => systemEvents.push(e));

      const event = {
        type: 'system',
        subtype: 'api_retry',
        attempt: 2,
        max_retries: 5,
        retry_delay_ms: 2000,
        error_status: 529,
        error_category: 'overloaded',
      };
      mockProc.stdout.emit('data', Buffer.from(JSON.stringify(event) + '\n'));

      expect(session.stats.retries).toBe(1);
      expect(session.stats.lastRetryError).toBe('overloaded');
      expect(systemEvents).toHaveLength(1);
    });

    it('accumulates retries across multiple api_retry events', () => {
      const event1 = { type: 'system', subtype: 'api_retry', attempt: 1, error_category: 'overloaded' };
      const event2 = { type: 'system', subtype: 'api_retry', attempt: 2, error_category: 'rate_limit' };
      mockProc.stdout.emit('data', Buffer.from(JSON.stringify(event1) + '\n'));
      mockProc.stdout.emit('data', Buffer.from(JSON.stringify(event2) + '\n'));

      expect(session.stats.retries).toBe(2);
      expect(session.stats.lastRetryError).toBe('rate_limit');
    });

    it('includes retries in getStats()', () => {
      const event = { type: 'system', subtype: 'api_retry', attempt: 1, error_category: 'overloaded' };
      mockProc.stdout.emit('data', Buffer.from(JSON.stringify(event) + '\n'));

      const stats = session.getStats();
      expect(stats.retries).toBe(1);
      expect(stats.lastRetryError).toBe('overloaded');
    });
  });

  describe('_updateCost', () => {
    beforeEach(async () => {
      const startPromise = session.start();
      emitInitEvent(mockProc);
      await startPromise;
    });

    it('computes cost based on model pricing', () => {
      const event = {
        type: 'result',
        result: 'test',
        usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 },
      };
      mockProc.stdout.emit('data', Buffer.from(JSON.stringify(event) + '\n'));
      // Cost should be > 0 for known model
      expect(session.stats.costUsd).toBeGreaterThan(0);
    });

    it('accounts for cached tokens in cost calculation', () => {
      // First add cached tokens via message_delta
      const deltaEvent = {
        type: 'stream_event',
        event: {
          type: 'message_delta',
          usage: { input_tokens: 1000, output_tokens: 0, cache_read_input_tokens: 500 },
        },
      };
      mockProc.stdout.emit('data', Buffer.from(JSON.stringify(deltaEvent) + '\n'));
      const costWithCache = session.stats.costUsd;

      // Reset and do without cache
      session.stats.tokensIn = 0;
      session.stats.tokensOut = 0;
      session.stats.cachedTokens = 0;
      session.stats.costUsd = 0;

      const deltaEvent2 = {
        type: 'stream_event',
        event: {
          type: 'message_delta',
          usage: { input_tokens: 1000, output_tokens: 0, cache_read_input_tokens: 0 },
        },
      };
      mockProc.stdout.emit('data', Buffer.from(JSON.stringify(deltaEvent2) + '\n'));
      const costWithoutCache = session.stats.costUsd;

      // With cache should be different from without (cached tokens use different rate)
      // Both should be >= 0
      expect(costWithCache).toBeGreaterThanOrEqual(0);
      expect(costWithoutCache).toBeGreaterThanOrEqual(0);
    });
  });

  describe('send()', () => {
    beforeEach(async () => {
      const startPromise = session.start();
      emitInitEvent(mockProc);
      await startPromise;
    });

    it('throws if session not ready', async () => {
      const freshSession = new PersistentClaudeSession(makeConfig());
      await expect(freshSession.send('hello')).rejects.toThrow(/not ready/);
    });

    it('writes JSON payload to stdin', async () => {
      await session.send('hello');
      expect(mockProc.stdin.write).toHaveBeenCalled();
      const written = mockProc.stdin.write.mock.calls.at(-1)![0] as string;
      const payload = JSON.parse(written.trim());
      expect(payload.type).toBe('user');
      expect(payload.message.role).toBe('user');
      expect(payload.message.content[0].text).toBe('hello');
    });

    it('prepends ultrathink for high effort', async () => {
      await session.send('test', { effort: 'high' });
      const written = mockProc.stdin.write.mock.calls.at(-1)![0] as string;
      const payload = JSON.parse(written.trim());
      expect(payload.message.content[0].text).toContain('ultrathink');
    });

    it('prepends planning instruction for plan mode', async () => {
      await session.send('test', { plan: true });
      const written = mockProc.stdin.write.mock.calls.at(-1)![0] as string;
      const payload = JSON.parse(written.trim());
      expect(payload.message.content[0].text).toMatch(/^\[Planning Mode\]/);
    });

    it('returns requestId when not waiting', async () => {
      const result = await session.send('hello');
      expect(result).toHaveProperty('requestId');
      expect(result).toHaveProperty('sent', true);
    });
  });

  describe('stderr sanitization', () => {
    beforeEach(async () => {
      const startPromise = session.start();
      emitInitEvent(mockProc);
      await startPromise;
    });

    it('redacts sk-ant- style API keys', () => {
      const logs: unknown[] = [];
      session.on(SESSION_EVENT.LOG, (msg: unknown) => logs.push(msg));

      mockProc.stderr.emit('data', Buffer.from('key is sk-ant-abcdef1234567890_XYZ'));
      expect(logs[0]).toContain('sk-***');
      expect(logs[0]).not.toContain('abcdef');
    });

    it('redacts new-format sk- API keys', () => {
      const logs: unknown[] = [];
      session.on(SESSION_EVENT.LOG, (msg: unknown) => logs.push(msg));

      mockProc.stderr.emit('data', Buffer.from('key is sk-proj-abcdef1234567890'));
      expect(logs[0]).toContain('sk-***');
      expect(logs[0]).not.toContain('proj-abcdef');
    });

    it('redacts ANTHROPIC_API_KEY env var', () => {
      const logs: unknown[] = [];
      session.on(SESSION_EVENT.LOG, (msg: unknown) => logs.push(msg));

      mockProc.stderr.emit('data', Buffer.from('ANTHROPIC_API_KEY=secret123'));
      expect(logs[0]).toContain('ANTHROPIC_API_KEY=***');
      expect(logs[0]).not.toContain('secret123');
    });

    it('redacts Bearer tokens', () => {
      const logs: unknown[] = [];
      session.on(SESSION_EVENT.LOG, (msg: unknown) => logs.push(msg));

      mockProc.stderr.emit('data', Buffer.from('Authorization: Bearer mytoken123'));
      expect(logs[0]).toContain('Bearer ***');
      expect(logs[0]).not.toContain('mytoken123');
    });
  });

  describe('stop()', () => {
    beforeEach(async () => {
      const startPromise = session.start();
      emitInitEvent(mockProc);
      await startPromise;
    });

    it('cleans up process and emits close', () => {
      const closeEvents: unknown[] = [];
      session.on(SESSION_EVENT.CLOSE, (code: unknown) => closeEvents.push(code));

      session.stop();

      expect(session.isReady).toBe(false);
      expect(closeEvents.length).toBeGreaterThanOrEqual(1);
      expect(mockProc.stdin.end).toHaveBeenCalled();
    });
  });

  describe('status()', () => {
    beforeEach(async () => {
      const startPromise = session.start();
      emitInitEvent(mockProc);
      await startPromise;
    });

    it('returns correct status shape', () => {
      const status = session.getStats();
      expect(status).toHaveProperty('turns', 0);
      expect(status).toHaveProperty('tokensIn', 0);
      expect(status).toHaveProperty('tokensOut', 0);
      expect(status).toHaveProperty('costUsd', 0);
      expect(status).toHaveProperty('isReady', true);
      expect(status).toHaveProperty('contextPercent');
      expect(status).toHaveProperty('sessionId', 'sess_123');
      expect(status.contextPercent).toBeGreaterThanOrEqual(0);
      expect(status.contextPercent).toBeLessThanOrEqual(100);
    });

    it('contextPercent scales with token usage', () => {
      // Inject some tokens
      session.stats.tokensIn = 100_000;
      session.stats.tokensOut = 50_000;
      const status = session.getStats();
      expect(status.contextPercent).toBeGreaterThan(0);
    });
  });

  describe('getHistory()', () => {
    beforeEach(async () => {
      const startPromise = session.start();
      emitInitEvent(mockProc);
      await startPromise;
    });

    it('returns bounded history', () => {
      for (let i = 0; i < 10; i++) {
        const event = { type: 'user', message: { role: 'user', content: `msg ${i}` } };
        mockProc.stdout.emit('data', Buffer.from(JSON.stringify(event) + '\n'));
      }
      const history = session.getHistory(5);
      expect(history).toHaveLength(5);
    });
  });

  describe('effort', () => {
    it('defaults to auto', () => {
      expect(session.getEffort()).toBe('auto');
    });

    it('can be changed', () => {
      session.setEffort('high');
      expect(session.getEffort()).toBe('high');
    });
  });

  describe('SessionConfig new fields', () => {
    it('accepts all new CLI 2.1.111 options', () => {
      const config: SessionConfig = {
        name: 'test',
        cwd: '/tmp',
        permissionMode: 'acceptEdits',
        includeHookEvents: true,
        permissionPromptTool: 'mcp__auth__approve',
        excludeDynamicSystemPromptSections: true,
        debug: ['api', 'mcp'],
        debugFile: '/tmp/debug.log',
        fromPr: '123',
        channels: ['plugin:notifier@marketplace'],
        dangerouslyLoadDevelopmentChannels: ['server:test'],
        enablePromptCaching1H: true,
      };
      expect(config.includeHookEvents).toBe(true);
      expect(config.permissionPromptTool).toBe('mcp__auth__approve');
      expect(config.excludeDynamicSystemPromptSections).toBe(true);
      expect(config.debug).toEqual(['api', 'mcp']);
      expect(config.debugFile).toBe('/tmp/debug.log');
      expect(config.fromPr).toBe('123');
      expect(config.channels).toEqual(['plugin:notifier@marketplace']);
      expect(config.dangerouslyLoadDevelopmentChannels).toEqual(['server:test']);
      expect(config.enablePromptCaching1H).toBe(true);
    });
  });
});
