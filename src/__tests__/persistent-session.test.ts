/**
 * Unit tests for PersistentClaudeSession
 *
 * Strategy: test the class directly by exercising its public API and
 * verifying event emission, stat tracking, and CLI arg assembly.
 * We mock child_process.spawn to avoid spawning real CLI processes.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  stdin = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
  stdout = createMockStream();
  stderr = createMockStream();
  unref = vi.fn();

  kill(signal?: string) {
    this.killed = true;
    this.emit('close', signal === 'SIGKILL' ? 137 : 143);
  }
}

let mockProc: MockProcess;

vi.mock('../engine-spawn.js', () => ({
  spawnEngine: vi.fn(() => {
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
    vi.unstubAllEnvs();
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
      const { spawnEngine: spawn } = await import('../engine-spawn.js');
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
      const { spawnEngine: spawn } = await import('../engine-spawn.js');
      const startPromise = session.start();
      emitInitEvent(mockProc);
      await startPromise;

      const args = vi.mocked(spawn).mock.calls.at(-1)![1] as string[];
      expect(args).toContain('--resume');
      expect(args).toContain('resume_abc');
    });

    // The CLI's agent schema grows every few releases (2.1.271 added
    // `omitClaudeMd`). Agents are handed over verbatim, so a field the CLI adds
    // must reach it unchanged — mapping them through a list of known fields
    // would drop the next one silently.
    it('passes agent definitions to --agents verbatim, fields it does not name included', async () => {
      const agents = {
        scout: { description: 'Looks things up', prompt: 'You are a scout.', omitClaudeMd: true, maxTurns: 3 },
      };
      session = new PersistentClaudeSession(makeConfig({ agents }));
      const { spawnEngine: spawn } = await import('../engine-spawn.js');
      const startPromise = session.start();
      emitInitEvent(mockProc);
      await startPromise;

      const args = vi.mocked(spawn).mock.calls.at(-1)![1] as string[];
      const json = args[args.indexOf('--agents') + 1];
      expect(JSON.parse(json)).toEqual(agents);
    });

    it('routes non-Claude model through proxy when baseUrl is set', async () => {
      session = new PersistentClaudeSession(makeConfig({ model: 'gpt-5.4', baseUrl: 'http://localhost:3000' }));
      const { spawnEngine: spawn } = await import('../engine-spawn.js');
      const startPromise = session.start();
      emitInitEvent(mockProc);
      await startPromise;

      const args = vi.mocked(spawn).mock.calls.at(-1)![1] as string[];
      // Non-Claude model with baseUrl should set _realModel and use 'opus' as the CLI model
      expect(args).toContain('--model');
      expect(args).toContain('opus');
    });

    it('drops an inherited ANTHROPIC_API_KEY when no baseUrl is configured', async () => {
      vi.stubEnv('ANTHROPIC_API_KEY', 'proxy-key-not-for-official-api');
      // An inherited ANTHROPIC_BASE_URL keeps the key on purpose; the test runner's
      // own shell may have one, so it is cleared here rather than assumed absent.
      vi.stubEnv('ANTHROPIC_BASE_URL', '');
      session = new PersistentClaudeSession(makeConfig());
      const { spawnEngine: spawn } = await import('../engine-spawn.js');
      const startPromise = session.start();
      emitInitEvent(mockProc);
      await startPromise;

      const opts = vi.mocked(spawn).mock.calls.at(-1)![2] as { env: NodeJS.ProcessEnv };
      expect(opts.env.ANTHROPIC_API_KEY).toBeUndefined();
    });

    it('keeps an official-format ANTHROPIC_API_KEY even without baseUrl', async () => {
      vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-api03-real-key');
      session = new PersistentClaudeSession(makeConfig());
      const { spawnEngine: spawn } = await import('../engine-spawn.js');
      const startPromise = session.start();
      emitInitEvent(mockProc);
      await startPromise;

      const opts = vi.mocked(spawn).mock.calls.at(-1)![2] as { env: NodeJS.ProcessEnv };
      expect(opts.env.ANTHROPIC_API_KEY).toBe('sk-ant-api03-real-key');
    });

    it('keeps ANTHROPIC_API_KEY when a baseUrl is configured', async () => {
      vi.stubEnv('ANTHROPIC_API_KEY', 'proxy-key');
      session = new PersistentClaudeSession(makeConfig({ baseUrl: 'http://localhost:3000' }));
      const { spawnEngine: spawn } = await import('../engine-spawn.js');
      const startPromise = session.start();
      emitInitEvent(mockProc);
      await startPromise;

      const opts = vi.mocked(spawn).mock.calls.at(-1)![2] as { env: NodeJS.ProcessEnv };
      expect(opts.env.ANTHROPIC_API_KEY).toBe('proxy-key');
      expect(opts.env.ANTHROPIC_BASE_URL).toBe('http://localhost:3000');
    });

    it('keeps ANTHROPIC_API_KEY when the environment already sets ANTHROPIC_BASE_URL', async () => {
      vi.stubEnv('ANTHROPIC_API_KEY', 'proxy-key');
      vi.stubEnv('ANTHROPIC_BASE_URL', 'http://localhost:4000');
      session = new PersistentClaudeSession(makeConfig());
      const { spawnEngine: spawn } = await import('../engine-spawn.js');
      const startPromise = session.start();
      emitInitEvent(mockProc);
      await startPromise;

      const opts = vi.mocked(spawn).mock.calls.at(-1)![2] as { env: NodeJS.ProcessEnv };
      expect(opts.env.ANTHROPIC_API_KEY).toBe('proxy-key');
    });

    it('includes --include-hook-events when set', async () => {
      session = new PersistentClaudeSession(makeConfig({ includeHookEvents: true }));
      const { spawnEngine: spawn } = await import('../engine-spawn.js');
      const startPromise = session.start();
      emitInitEvent(mockProc);
      await startPromise;
      const args = vi.mocked(spawn).mock.calls.at(-1)![1] as string[];
      expect(args).toContain('--include-hook-events');
    });

    it('includes --forward-subagent-text when set', async () => {
      session = new PersistentClaudeSession(makeConfig({ forwardSubagentText: true }));
      const { spawnEngine: spawn } = await import('../engine-spawn.js');
      const startPromise = session.start();
      emitInitEvent(mockProc);
      await startPromise;
      const args = vi.mocked(spawn).mock.calls.at(-1)![1] as string[];
      expect(args).toContain('--forward-subagent-text');
    });

    // Chrome acts with the browser's own sign-ins, so it is off unless asked
    // for — and off has to be said: a user setting can turn it on by default.
    it('passes --chrome only when asked, and --no-chrome otherwise', async () => {
      const { spawnEngine: spawn } = await import('../engine-spawn.js');
      const argvFor = async (chrome: boolean | undefined) => {
        session = new PersistentClaudeSession(makeConfig(chrome === undefined ? {} : { chrome }));
        const started = session.start();
        emitInitEvent(mockProc);
        await started;
        return vi.mocked(spawn).mock.calls.at(-1)![1] as string[];
      };

      const on = await argvFor(true);
      expect(on).toContain('--chrome');
      expect(on).not.toContain('--no-chrome');
      for (const chrome of [undefined, false]) {
        const off = await argvFor(chrome);
        expect(off).toContain('--no-chrome');
        expect(off).not.toContain('--chrome');
      }
    });

    it('omits --forward-subagent-text by default', async () => {
      session = new PersistentClaudeSession(makeConfig({}));
      const { spawnEngine: spawn } = await import('../engine-spawn.js');
      const startPromise = session.start();
      emitInitEvent(mockProc);
      await startPromise;
      const args = vi.mocked(spawn).mock.calls.at(-1)![1] as string[];
      expect(args).not.toContain('--forward-subagent-text');
    });

    it('includes --permission-prompt-tool when set', async () => {
      session = new PersistentClaudeSession(makeConfig({ permissionPromptTool: 'mcp__auth__decide' }));
      const { spawnEngine: spawn } = await import('../engine-spawn.js');
      const startPromise = session.start();
      emitInitEvent(mockProc);
      await startPromise;
      const args = vi.mocked(spawn).mock.calls.at(-1)![1] as string[];
      expect(args).toContain('--permission-prompt-tool');
      expect(args).toContain('mcp__auth__decide');
    });

    it('includes --exclude-dynamic-system-prompt-sections when set', async () => {
      session = new PersistentClaudeSession(makeConfig({ excludeDynamicSystemPromptSections: true }));
      const { spawnEngine: spawn } = await import('../engine-spawn.js');
      const startPromise = session.start();
      emitInitEvent(mockProc);
      await startPromise;
      const args = vi.mocked(spawn).mock.calls.at(-1)![1] as string[];
      expect(args).toContain('--exclude-dynamic-system-prompt-sections');
    });

    it('auto-enables --exclude-dynamic-system-prompt-sections when bare is true', async () => {
      session = new PersistentClaudeSession(makeConfig({ bare: true }));
      const { spawnEngine: spawn } = await import('../engine-spawn.js');
      const startPromise = session.start();
      emitInitEvent(mockProc);
      await startPromise;
      const args = vi.mocked(spawn).mock.calls.at(-1)![1] as string[];
      expect(args).toContain('--exclude-dynamic-system-prompt-sections');
    });

    it('does NOT auto-enable --exclude-dynamic-system-prompt-sections when bare + explicit false', async () => {
      session = new PersistentClaudeSession(makeConfig({ bare: true, excludeDynamicSystemPromptSections: false }));
      const { spawnEngine: spawn } = await import('../engine-spawn.js');
      const startPromise = session.start();
      emitInitEvent(mockProc);
      await startPromise;
      const args = vi.mocked(spawn).mock.calls.at(-1)![1] as string[];
      expect(args).not.toContain('--exclude-dynamic-system-prompt-sections');
    });

    it('includes --debug with comma-joined categories', async () => {
      session = new PersistentClaudeSession(makeConfig({ debug: ['api', 'mcp'] }));
      const { spawnEngine: spawn } = await import('../engine-spawn.js');
      const startPromise = session.start();
      emitInitEvent(mockProc);
      await startPromise;
      const args = vi.mocked(spawn).mock.calls.at(-1)![1] as string[];
      expect(args).toContain('--debug');
      expect(args).toContain('api,mcp');
    });

    it('includes --debug-file when set', async () => {
      session = new PersistentClaudeSession(makeConfig({ debugFile: '/tmp/debug.log' }));
      const { spawnEngine: spawn } = await import('../engine-spawn.js');
      const startPromise = session.start();
      emitInitEvent(mockProc);
      await startPromise;
      const args = vi.mocked(spawn).mock.calls.at(-1)![1] as string[];
      expect(args).toContain('--debug-file');
      expect(args).toContain('/tmp/debug.log');
    });

    it('includes --from-pr when set', async () => {
      session = new PersistentClaudeSession(makeConfig({ fromPr: '42' }));
      const { spawnEngine: spawn } = await import('../engine-spawn.js');
      const startPromise = session.start();
      emitInitEvent(mockProc);
      await startPromise;
      const args = vi.mocked(spawn).mock.calls.at(-1)![1] as string[];
      expect(args).toContain('--from-pr');
      expect(args).toContain('42');
    });

    it('includes --channels for each entry', async () => {
      session = new PersistentClaudeSession(makeConfig({ channels: ['plugin:a@market', 'plugin:b@market'] }));
      const { spawnEngine: spawn } = await import('../engine-spawn.js');
      const startPromise = session.start();
      emitInitEvent(mockProc);
      await startPromise;
      const args = vi.mocked(spawn).mock.calls.at(-1)![1] as string[];
      expect(args).toContain('plugin:a@market');
      expect(args).toContain('plugin:b@market');
    });

    it('includes --dangerously-load-development-channels when set', async () => {
      session = new PersistentClaudeSession(makeConfig({ dangerouslyLoadDevelopmentChannels: 'server:test' }));
      const { spawnEngine: spawn } = await import('../engine-spawn.js');
      const startPromise = session.start();
      emitInitEvent(mockProc);
      await startPromise;
      const args = vi.mocked(spawn).mock.calls.at(-1)![1] as string[];
      expect(args).toContain('--dangerously-load-development-channels');
      expect(args).toContain('server:test');
    });

    it('sets ENABLE_PROMPT_CACHING_1H env var when enablePromptCaching1H is true', async () => {
      session = new PersistentClaudeSession(makeConfig({ enablePromptCaching1H: true }));
      const { spawnEngine: spawn } = await import('../engine-spawn.js');
      const startPromise = session.start();
      emitInitEvent(mockProc);
      await startPromise;
      const spawnCall = vi.mocked(spawn).mock.calls.at(-1)!;
      const env = (spawnCall[2] as { env: Record<string, string> }).env;
      expect(env.ENABLE_PROMPT_CACHING_1H).toBe('1');
    });

    it('auto-sets ENABLE_PROMPT_CACHING_1H when bare is true', async () => {
      session = new PersistentClaudeSession(makeConfig({ bare: true }));
      const { spawnEngine: spawn } = await import('../engine-spawn.js');
      const startPromise = session.start();
      emitInitEvent(mockProc);
      await startPromise;
      const spawnCall = vi.mocked(spawn).mock.calls.at(-1)!;
      const env = (spawnCall[2] as { env: Record<string, string> }).env;
      expect(env.ENABLE_PROMPT_CACHING_1H).toBe('1');
    });

    it('does NOT set ENABLE_PROMPT_CACHING_1H when bare + explicit false', async () => {
      session = new PersistentClaudeSession(makeConfig({ bare: true, enablePromptCaching1H: false }));
      const { spawnEngine: spawn } = await import('../engine-spawn.js');
      const startPromise = session.start();
      emitInitEvent(mockProc);
      await startPromise;
      const spawnCall = vi.mocked(spawn).mock.calls.at(-1)!;
      const env = (spawnCall[2] as { env: Record<string, string> }).env;
      expect(env.ENABLE_PROMPT_CACHING_1H).toBeUndefined();
    });

    it('sets CLAUDE_CODE_FORK_SUBAGENT env var when forkSubagent is true', async () => {
      session = new PersistentClaudeSession(makeConfig({ forkSubagent: true }));
      const { spawnEngine: spawn } = await import('../engine-spawn.js');
      const startPromise = session.start();
      emitInitEvent(mockProc);
      await startPromise;
      const env = (vi.mocked(spawn).mock.calls.at(-1)![2] as { env: Record<string, string> }).env;
      expect(env.CLAUDE_CODE_FORK_SUBAGENT).toBe('1');
    });

    it('sets ENABLE_TOOL_SEARCH env var when enableToolSearch is true', async () => {
      session = new PersistentClaudeSession(makeConfig({ enableToolSearch: true }));
      const { spawnEngine: spawn } = await import('../engine-spawn.js');
      const startPromise = session.start();
      emitInitEvent(mockProc);
      await startPromise;
      const env = (vi.mocked(spawn).mock.calls.at(-1)![2] as { env: Record<string, string> }).env;
      expect(env.ENABLE_TOOL_SEARCH).toBe('1');
    });

    it('sets OTEL_LOG_USER_PROMPTS env var when otelLogUserPrompts is true', async () => {
      session = new PersistentClaudeSession(makeConfig({ otelLogUserPrompts: true }));
      const { spawnEngine: spawn } = await import('../engine-spawn.js');
      const startPromise = session.start();
      emitInitEvent(mockProc);
      await startPromise;
      const env = (vi.mocked(spawn).mock.calls.at(-1)![2] as { env: Record<string, string> }).env;
      expect(env.OTEL_LOG_USER_PROMPTS).toBe('1');
    });

    it('sets OTEL_LOG_RAW_API_BODIES env var when otelLogRawApiBodies is true', async () => {
      session = new PersistentClaudeSession(makeConfig({ otelLogRawApiBodies: true }));
      const { spawnEngine: spawn } = await import('../engine-spawn.js');
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

  // Flags verified against CLI 2.1.330: each is accepted ahead of a bogus one,
  // and the `initialize` control request shows its effect (MCP servers, commands
  // and plugins loaded) without a model turn.
  describe('start() — settings, MCP, plugins, compaction, slash commands', () => {
    const argvFor = async (overrides: Partial<SessionConfig>) => {
      const { spawnEngine: spawn } = await import('../engine-spawn.js');
      session = new PersistentClaudeSession(makeConfig(overrides));
      const started = session.start();
      emitInitEvent(mockProc);
      await started;
      return vi.mocked(spawn).mock.calls.at(-1)![1] as string[];
    };
    const valuesOf = (argv: string[], flag: string) => argv.flatMap((a, i) => (a === flag ? [argv[i + 1]] : []));
    const spawnCount = async () => {
      const { spawnEngine: spawn } = await import('../engine-spawn.js');
      return vi.mocked(spawn).mock.calls.length;
    };

    it('passes none of the new flags by default', async () => {
      const argv = await argvFor({});
      for (const flag of [
        '--strict-mcp-config',
        '--setting-sources',
        '--system-prompt-snapshot',
        '--plugin-dir',
        '--autocompact',
        '--append-subagent-system-prompt',
        '--disable-slash-commands',
      ]) {
        expect(argv).not.toContain(flag);
      }
    });

    it('passes --strict-mcp-config when strictMcpConfig is set', async () => {
      expect(await argvFor({ strictMcpConfig: true })).toContain('--strict-mcp-config');
      expect(await argvFor({ strictMcpConfig: false })).not.toContain('--strict-mcp-config');
    });

    it('passes the setting sources comma-joined, and an empty list as an empty value', async () => {
      expect(valuesOf(await argvFor({ settingSources: ['project', 'local'] }), '--setting-sources')).toEqual([
        'project,local',
      ]);
      // `--setting-sources ''` loads no settings files (measured: the user's MCP
      // servers and plugin commands are gone), unlike leaving the flag out.
      expect(valuesOf(await argvFor({ settingSources: [] }), '--setting-sources')).toEqual(['']);
    });

    it('refuses an unknown setting source before spawning', async () => {
      const before = await spawnCount();
      session = new PersistentClaudeSession(makeConfig({ settingSources: ['user', 'global' as never] }));
      await expect(session.start()).rejects.toThrow(/settingSources.*global/);
      expect(await spawnCount()).toBe(before);
    });

    it('passes --system-prompt-snapshot on or off, and refuses anything else', async () => {
      expect(valuesOf(await argvFor({ systemPromptSnapshot: 'off' }), '--system-prompt-snapshot')).toEqual(['off']);
      expect(valuesOf(await argvFor({ systemPromptSnapshot: 'on' }), '--system-prompt-snapshot')).toEqual(['on']);
      session = new PersistentClaudeSession(makeConfig({ systemPromptSnapshot: 'OFF' as never }));
      await expect(session.start()).rejects.toThrow(/systemPromptSnapshot/);
    });

    it('passes one --plugin-dir per entry', async () => {
      expect(valuesOf(await argvFor({ pluginDir: '/p/one' }), '--plugin-dir')).toEqual(['/p/one']);
      expect(valuesOf(await argvFor({ pluginDir: ['/p/one', '/p/two.zip'] }), '--plugin-dir')).toEqual([
        '/p/one',
        '/p/two.zip',
      ]);
    });

    it('passes --autocompact auto or a token count of at least 100000', async () => {
      expect(valuesOf(await argvFor({ autoCompactWindow: 'auto' }), '--autocompact')).toEqual(['auto']);
      expect(valuesOf(await argvFor({ autoCompactWindow: 100_000 }), '--autocompact')).toEqual(['100000']);
      expect(valuesOf(await argvFor({ autoCompactWindow: 400_000 }), '--autocompact')).toEqual(['400000']);
    });

    // The CLI reads 100–1000 as thousands ("200 as shorthand") and refuses
    // 1001–99999; the field is a token count, so 200 must not quietly mean 200k.
    it('refuses an autocompact window that is not auto or a whole token count of at least 100000', async () => {
      const before = await spawnCount();
      for (const bad of [99_999, 200, 0, -1, 150_000.5, Number.NaN, '200000', 'AUTO']) {
        session = new PersistentClaudeSession(makeConfig({ autoCompactWindow: bad as never }));
        await expect(session.start()).rejects.toThrow(/autoCompactWindow/);
      }
      expect(await spawnCount()).toBe(before);
    });

    it('passes --append-subagent-system-prompt verbatim', async () => {
      const text = 'Report findings as a bulleted list.';
      expect(valuesOf(await argvFor({ appendSubagentSystemPrompt: text }), '--append-subagent-system-prompt')).toEqual([
        text,
      ]);
    });

    it('passes --disable-slash-commands when disableSlashCommands is set', async () => {
      expect(await argvFor({ disableSlashCommands: true })).toContain('--disable-slash-commands');
    });

    // With slash commands off, `/compact` would reach the model as plain text:
    // a model turn, and no compaction.
    it('refuses compact() without writing anything when slash commands are disabled', async () => {
      await argvFor({ disableSlashCommands: true });
      const writes = mockProc.stdin.write.mock.calls.length;
      await expect(session.compact()).rejects.toThrow(/disableSlashCommands/);
      await expect(session.compact('keep the plan')).rejects.toThrow(/disableSlashCommands/);
      expect(mockProc.stdin.write.mock.calls.length).toBe(writes);
    });

    it('still sends /compact when slash commands are enabled', async () => {
      await argvFor({});
      void session.compact().catch(() => undefined);
      const payload = JSON.parse((mockProc.stdin.write.mock.calls.at(-1)![0] as string).trim());
      expect(payload.message.content).toEqual([{ type: 'text', text: '/compact' }]);
    });
  });

  describe('_handleEvent', () => {
    beforeEach(async () => {
      const startPromise = session.start();
      emitInitEvent(mockProc);
      await startPromise;
    });

    // The event order of a real two-tool turn (claude 2.1.274, --include-partial-messages,
    // --replay-user-messages), trimmed to the fields the wrapper reads. Each tool_use
    // block arrives twice: first on `content_block_start` with an empty input, then as
    // an `assistant` event carrying the same id and the full input. The results come
    // back inside `user` messages.
    const twoToolTurn = [
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'run two commands' }] } },
      { type: 'stream_event', event: { type: 'message_start' } },
      {
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          content_block: { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} },
        },
      },
      {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'echo one' } }] },
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'one', is_error: false }],
        },
      },
      { type: 'stream_event', event: { type: 'message_start' } },
      {
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          content_block: { type: 'tool_use', id: 'toolu_2', name: 'Bash', input: {} },
        },
      },
      {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'toolu_2', name: 'Bash', input: { command: 'exit 3' } }] },
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_2', content: 'Exit code 3', is_error: true }],
        },
      },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'DONE' }] } },
      { type: 'result', subtype: 'success', result: 'DONE' },
    ];

    it('reports each tool call once, with its input, and counts failed tool results', () => {
      const seen: unknown[] = [];
      session.on(SESSION_EVENT.TOOL_USE, (e: unknown) => seen.push(e));
      for (const event of twoToolTurn) mockProc.stdout.emit('data', Buffer.from(JSON.stringify(event) + '\n'));
      expect(session.stats.toolCalls).toBe(2);
      expect(seen).toEqual([
        { tool: { name: 'Bash', input: { command: 'echo one' } } },
        { tool: { name: 'Bash', input: { command: 'exit 3' } } },
      ]);
      expect(session.stats.toolErrors).toBe(1);
      expect(session.stats.turnsSucceeded).toBe(1);
    });

    it('does not hand a waiting send the reply of a turn it did not send', async () => {
      const waiting = session.send('second message', { waitForComplete: true, timeout: 60_000 });
      // A background workflow finishing while this send is in flight: its own turn
      // ends in a result tagged with an origin (recorded on 2.1.274).
      const late = {
        type: 'result',
        subtype: 'success',
        result: 'The workflow finished: PONG',
        origin: { kind: 'task-notification' },
        total_cost_usd: 0.12,
      };
      mockProc.stdout.emit('data', Buffer.from(JSON.stringify(late) + '\n'));
      const own = { type: 'result', subtype: 'success', result: 'reply to the second message', total_cost_usd: 0.13 };
      mockProc.stdout.emit('data', Buffer.from(JSON.stringify(own) + '\n'));
      const reply = (await waiting) as { text: string };
      expect(reply.text).toBe('reply to the second message');
      expect(session.stats.turnsSucceeded).toBe(1);
    });

    const lastSentUuid = (): string => {
      const written = mockProc.stdin.write.mock.calls.at(-1)![0] as string;
      return JSON.parse(written.trim()).uuid as string;
    };
    const emit = (event: Record<string, unknown>) =>
      mockProc.stdout.emit('data', Buffer.from(JSON.stringify(event) + '\n'));

    it('resolves a send the CLI folded into a turn it started itself', async () => {
      const waiting = session.send('question', { waitForComplete: true, timeout: 60_000 });
      const uuid = lastSentUuid();
      expect(uuid).toMatch(/^[0-9a-f-]{36}$/);
      // Background-task turn that absorbed the message: tagged with an origin, but
      // it names the message it answers.
      emit({ type: 'result', result: 'answer', origin: { kind: 'task-notification' }, user_message_uuids: [uuid] });
      expect(((await waiting) as { text: string }).text).toBe('answer');
      expect(session.stats.turnsSucceeded).toBe(1);
    });

    it('ignores a result that names only messages this session did not send', async () => {
      const waiting = session.send('question', { waitForComplete: true, timeout: 60_000 });
      const uuid = lastSentUuid();
      emit({ type: 'result', result: 'someone else', user_message_uuids: ['00000000-0000-0000-0000-000000000000'] });
      emit({ type: 'result', result: 'mine', user_message_uuids: [uuid] });
      expect(((await waiting) as { text: string }).text).toBe('mine');
      expect(session.stats.turnsSucceeded).toBe(1);
    });

    it('does not hand a waiting send the reply to a message sent without waiting', async () => {
      // An inbox delivery writes without waiting; a caller then sends and waits.
      await session.send('inbox message', { waitForComplete: false });
      const inbox = lastSentUuid();
      const waiting = session.send('question', { waitForComplete: true, timeout: 60_000 });
      const mine = lastSentUuid();
      emit({ type: 'result', result: 'reply to the inbox message', user_message_uuids: [inbox] });
      emit({ type: 'result', result: 'reply to the question', user_message_uuids: [mine] });
      expect(((await waiting) as { text: string }).text).toBe('reply to the question');
      expect(session.stats.turnsSucceeded).toBe(2);
    });

    it('does not hand the next send the late reply to a send that timed out', async () => {
      const first = session.send('first', { waitForComplete: true, timeout: 1000 });
      const firstUuid = lastSentUuid();
      const firstOutcome = first.catch((e: Error) => e.message);
      vi.advanceTimersByTime(1001);
      expect(await firstOutcome).toMatch(/Timeout/);
      const second = session.send('second', { waitForComplete: true, timeout: 60_000 });
      const secondUuid = lastSentUuid();
      emit({ type: 'result', result: 'late reply to first', user_message_uuids: [firstUuid] });
      emit({ type: 'result', result: 'reply to second', user_message_uuids: [secondUuid] });
      expect(((await second) as { text: string }).text).toBe('reply to second');
      // The late turn is not the second send's success; counting it would mark a
      // failed second turn ok in the run ledger.
      expect(session.stats.turnsSucceeded).toBe(1);
    });

    it("does not build a reply's fallback text from a turn it did not send", async () => {
      const waiting = session.send('question', { waitForComplete: true, timeout: 60_000 });
      const uuid = lastSentUuid();
      emit({
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'NOT MINE' } },
      });
      emit({ type: 'result', result: 'workflow done', origin: { kind: 'task-notification' } });
      emit({
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'mine' } },
      });
      emit({ type: 'result', result: '', user_message_uuids: [uuid] });
      expect(((await waiting) as { text: string }).text).toBe('mine');
    });

    it('names the model the CLI reported in init when the caller set none', async () => {
      const unnamed = new PersistentClaudeSession(makeConfig({ model: undefined }));
      expect(unnamed.getCost().model).toBe('default');
      const started = unnamed.start();
      const init = { type: 'system', subtype: 'init', session_id: 'sess_456', model: 'claude-haiku-4-5-20251001' };
      mockProc.stdout.emit('data', Buffer.from(JSON.stringify(init) + '\n'));
      await started;
      expect(unnamed.getCost().model).toBe('claude-haiku-4-5-20251001');
      // A model the caller chose still wins over what init says.
      const named = new PersistentClaudeSession(makeConfig());
      const namedStarted = named.start();
      mockProc.stdout.emit('data', Buffer.from(JSON.stringify(init) + '\n'));
      await namedStarted;
      expect(named.getCost().model).toBe('claude-sonnet-4-6');
    });

    // Opus 5.5 and Sonnet 5.5 re-run a refused turn on an older model and say so
    // with system/model_refusal_fallback (snake_case on the stream-json wire).
    it('counts a refusal fallback and keeps the latest one', () => {
      const frame = (direction: string, to: string) => ({
        type: 'system',
        subtype: 'model_refusal_fallback',
        trigger: 'refusal',
        direction,
        scope: 'session',
        original_model: 'claude-opus-5-5',
        fallback_model: to,
        api_refusal_category: 'cyber',
      });
      mockProc.stdout.emit('data', Buffer.from(JSON.stringify(frame('retry', 'claude-opus-4-8')) + '\n'));
      mockProc.stdout.emit('data', Buffer.from(JSON.stringify(frame('revert', 'claude-opus-5-5')) + '\n'));
      const stats = session.getStats();
      expect(stats.refusalFallbacks).toBe(1);
      expect(stats.lastRefusalFallback).toEqual({ from: 'claude-opus-5-5', to: 'claude-opus-4-8', category: 'cyber' });
    });

    // An alias is the CLI's to resolve: `opus[1m]` meant Opus 5 until CLI 2.1.280
    // and Opus 5.5 after, so the ledger records the id init reports.
    it('names the model init reports when the caller set an alias', async () => {
      const aliased = new PersistentClaudeSession(makeConfig({ model: 'opus[1m]' }));
      const started = aliased.start();
      const init = { type: 'system', subtype: 'init', session_id: 'sess_789', model: 'claude-opus-5-5[1m]' };
      mockProc.stdout.emit('data', Buffer.from(JSON.stringify(init) + '\n'));
      await started;
      expect(aliased.getCost().model).toBe('claude-opus-5-5[1m]');
      expect(aliased.getCost().pricing.inputPer1M).toBe(4);
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
      // The echo of the message going out: no result exists yet, so nothing has
      // succeeded. This is what keeps `turnsSucceeded` from inheriting `turns`'
      // meaning here.
      expect(session.stats.turnsSucceeded).toBe(0);
    });

    it('counts turnsSucceeded on a clean result and not on an is_error one', () => {
      const ok = { type: 'result', result: 'done' };
      mockProc.stdout.emit('data', Buffer.from(JSON.stringify(ok) + '\n'));
      expect(session.stats.turnsSucceeded).toBe(1);

      // The CLI reports turn-level failures (invalid --model, auth loss) as a
      // result event carrying is_error.
      const bad = { type: 'result', result: 'model not found', is_error: true };
      mockProc.stdout.emit('data', Buffer.from(JSON.stringify(bad) + '\n'));
      expect(session.stats.turnsSucceeded).toBe(1);
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

  // Regression: the CLI reports one turn's usage twice — once on the streaming
  // `message_delta`, once on the terminal `result` — and both used to be added.
  // Measured against claude 2.1.246 on a live turn: the engine reported
  // in=2 / out=4 / cache_read=47371 and getStats() came back 4 / 8 / 94742.
  describe('turn usage is counted once', () => {
    beforeEach(async () => {
      const startPromise = session.start();
      emitInitEvent(mockProc);
      await startPromise;
    });

    const emit = (obj: unknown) => mockProc.stdout.emit('data', Buffer.from(JSON.stringify(obj) + '\n'));

    it('does not double-count when the delta and the result report the same turn', () => {
      const usage = { input_tokens: 2, output_tokens: 4, cache_read_input_tokens: 47_371 };
      emit({ type: 'stream_event', event: { type: 'message_start' } });
      emit({ type: 'stream_event', event: { type: 'message_delta', usage } });
      emit({ type: 'result', usage });

      expect(session.stats.tokensIn).toBe(2);
      expect(session.stats.tokensOut).toBe(4);
      expect(session.stats.cachedTokens).toBe(47_371);
    });

    it('keeps every message of a multi-message turn, without counting any twice', () => {
      // Two assistant messages (one tool round), then the turn total.
      emit({ type: 'stream_event', event: { type: 'message_start' } });
      emit({
        type: 'stream_event',
        event: { type: 'message_delta', usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100 } },
      });
      emit({ type: 'stream_event', event: { type: 'message_start' } });
      emit({
        type: 'stream_event',
        event: { type: 'message_delta', usage: { input_tokens: 7, output_tokens: 3, cache_read_input_tokens: 120 } },
      });
      emit({
        type: 'result',
        usage: { input_tokens: 17, output_tokens: 8, cache_read_input_tokens: 220 },
      });

      expect(session.stats.tokensIn).toBe(17);
      expect(session.stats.tokensOut).toBe(8);
      expect(session.stats.cachedTokens).toBe(220);
    });

    it("takes the engine's spend figure and treats it as a running total", () => {
      // `total_cost_usd` is the session total, not the turn's: two turns on one
      // process read 0.02377 then 0.047559. Accumulating them would bill 0.0713.
      emit({ type: 'result', usage: { input_tokens: 2, output_tokens: 3 }, total_cost_usd: 0.02377 });
      expect(session.stats.costUsd).toBeCloseTo(0.02377, 10);

      emit({ type: 'result', usage: { input_tokens: 2, output_tokens: 3 }, total_cost_usd: 0.047559 });
      expect(session.stats.costUsd).toBeCloseTo(0.047559, 10);
    });

    it('resumes accumulating when the CLI process restarts its own counter', () => {
      emit({ type: 'result', usage: { input_tokens: 2, output_tokens: 3 }, total_cost_usd: 0.05 });
      // A resume spawns a fresh CLI, whose running total starts over.
      emit({ type: 'result', usage: { input_tokens: 2, output_tokens: 3 }, total_cost_usd: 0.01 });
      expect(session.stats.costUsd).toBeCloseTo(0.06, 10);
    });

    it('prices cache writes when the engine reports no cost of its own', () => {
      // 1-hour cache writes bill at 2x input. Leaving them out is what made the
      // estimate read $0.016 on a turn the engine priced at $0.322428.
      emit({
        type: 'result',
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 1_000_000,
          cache_creation: { ephemeral_1h_input_tokens: 1_000_000, ephemeral_5m_input_tokens: 0 },
        },
      });
      // claude-sonnet-4-6 fallback pricing: input 3/Mtok, so 1M at 2x = 6.
      expect(session.stats.costUsd).toBeCloseTo(6, 6);
    });
  });

  // Regression: claude 2.1.277 made a headless process started with --resume
  // restore the totals the resumed session saved at exit, where it used to
  // begin at zero. Measured on 2.1.278: a turn reported $0.363044, and the same
  // session resumed in a new process reported $0.386463 for a turn whose own
  // usage was $0.023419. Reading that as this process's spend re-charges the
  // whole history on every model switch and every session recovery, and
  // `maxBudgetUsd` gates against that number.
  describe('cost on a process started with --resume', () => {
    const emit = (obj: unknown) => mockProc.stdout.emit('data', Buffer.from(JSON.stringify(obj) + '\n'));

    async function startWith(overrides: Partial<SessionConfig>) {
      session = new PersistentClaudeSession(makeConfig(overrides));
      const startPromise = session.start();
      emitInitEvent(mockProc);
      await startPromise;
    }

    it('treats the inherited total as a baseline, not as this process spend', async () => {
      await startWith({ resumeSessionId: 'resume_abc' });

      emit({ type: 'result', usage: { input_tokens: 2, output_tokens: 3 }, total_cost_usd: 0.386463 });
      const afterFirst = session.stats.costUsd;
      // The turn keeps the registry estimate for its own two tokens, which is
      // under a cent — the point is that it is not the inherited $0.386463.
      expect(afterFirst).toBeLessThan(0.001);

      // From the baseline on, the difference is this process's own spend.
      emit({ type: 'result', usage: { input_tokens: 2, output_tokens: 3 }, total_cost_usd: 0.4 });
      expect(session.stats.costUsd).toBeCloseTo(afterFirst + (0.4 - 0.386463), 10);
    });

    it('still takes the first total in full when the process was not resumed', async () => {
      await startWith({});

      emit({ type: 'result', usage: { input_tokens: 2, output_tokens: 3 }, total_cost_usd: 0.02377 });
      expect(session.stats.costUsd).toBeCloseTo(0.02377, 10);
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

      // Start a fresh message, so the next delta is a new series rather than a
      // continuation of the previous one.
      session.stats.tokensIn = 0;
      session.stats.tokensOut = 0;
      session.stats.cachedTokens = 0;
      session.stats.costUsd = 0;
      mockProc.stdout.emit(
        'data',
        Buffer.from(JSON.stringify({ type: 'stream_event', event: { type: 'message_start' } }) + '\n'),
      );

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
      // The API's `input_tokens` excludes cached reads, so the two turns are
      // not the same prompt: one carries 1500 tokens, the other 1000. Cached
      // reads therefore ADD to the bill instead of being carved out of it —
      // subtracting them out was what let a cached session bill at nothing.
      const cachedRate = 0.3 / 1_000_000; // claude-sonnet-4-6 fallback pricing
      expect(costWithCache).toBeCloseTo(costWithoutCache + 500 * cachedRate, 10);
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

    // stream-json takes Messages API content blocks: each image goes in as a
    // base64 `image` block ahead of the text, which keeps its prefixes.
    it('sends images as base64 image blocks ahead of the text block', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'clawo-img-'));
      const png = join(dir, 'a.png');
      const jpg = join(dir, 'b.JPEG');
      const webp = join(dir, 'c.webp');
      const gif = join(dir, 'd.gif');
      writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      writeFileSync(jpg, Buffer.from([0xff, 0xd8, 0xff]));
      writeFileSync(webp, Buffer.from('RIFF'));
      writeFileSync(gif, Buffer.from('GIF89a'));

      await session.send('What is shown?', { images: [png, jpg, webp, gif], effort: 'high', plan: true });
      const payload = JSON.parse((mockProc.stdin.write.mock.calls.at(-1)![0] as string).trim());
      const content = payload.message.content as Array<Record<string, unknown>>;
      expect(content.slice(0, 4)).toEqual([
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw==' } },
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: '/9j/' } },
        { type: 'image', source: { type: 'base64', media_type: 'image/webp', data: 'UklGRg==' } },
        { type: 'image', source: { type: 'base64', media_type: 'image/gif', data: 'R0lGODlh' } },
      ]);
      expect(content).toHaveLength(5);
      expect(content[4].type).toBe('text');
      expect(content[4].text).toMatch(/^\[Planning Mode\][\s\S]*ultrathink\n\nWhat is shown\?$/);
    });

    it('keeps a text-only message as a single text block when images is empty', async () => {
      await session.send('hello', { images: [] });
      const payload = JSON.parse((mockProc.stdin.write.mock.calls.at(-1)![0] as string).trim());
      expect(payload.message.content).toEqual([{ type: 'text', text: 'hello' }]);
    });

    it('refuses an unreadable or non-image file without writing or starting a turn', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'clawo-img-'));
      const txt = join(dir, 'notes.txt');
      writeFileSync(txt, 'x');
      const writes = mockProc.stdin.write.mock.calls.length;
      await expect(session.send('look', { images: [join(dir, 'missing.png')] })).rejects.toThrow(/missing\.png/);
      await expect(session.send('look', { images: [txt] })).rejects.toThrow(/notes\.txt/);
      expect(mockProc.stdin.write.mock.calls.length).toBe(writes);
      expect(session.isBusy).toBe(false);
    });

    // A message written while a turn runs is folded into it at the next tool
    // round (measured on 2.1.327); it must not restart the turn's accounting.
    it('delivers mid-turn only while one of its messages is unanswered, without resetting the turn', async () => {
      const writes = () => mockProc.stdin.write.mock.calls.length;
      const before = writes();
      expect(await session.deliverMidTurn('note')).toBe(false);
      expect(writes()).toBe(before);

      await session.send('do the work');
      const internals = session as unknown as { _turnApplied: { in: number } };
      internals._turnApplied.in = 5;
      expect(await session.deliverMidTurn('FORUM: a teammate posted')).toBe(true);
      const payload = JSON.parse((mockProc.stdin.write.mock.calls.at(-1)![0] as string).trim());
      expect(payload.type).toBe('user');
      expect(payload.uuid).toEqual(expect.any(String));
      expect(payload.message.content[0].text).toBe('FORUM: a teammate posted');
      expect(internals._turnApplied.in).toBe(5);
      // Reverse: a send starts a new turn's accounting.
      await session.send('next');
      expect(internals._turnApplied.in).toBe(0);
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

    it("contextPercent measures the last turn's prompt, not the session total", () => {
      // `input_tokens` alone is not the prompt: on a resumed conversation the
      // history arrives as cached reads, and summing the session's input and
      // output instead reported 0% for a full context.
      mockProc.stdout.emit(
        'data',
        Buffer.from(
          JSON.stringify({
            type: 'result',
            usage: { input_tokens: 2, output_tokens: 4, cache_read_input_tokens: 400_000 },
            modelUsage: { 'claude-opus-5': { contextWindow: 1_000_000 } },
          }) + '\n',
        ),
      );
      expect(session.getStats().contextPercent).toBe(40);
    });

    it("contextPercent is the turn's last request, not the turn's summed usage", () => {
      // A turn with tool calls makes one API request per round, and `result.usage`
      // sums them: five requests of ~170k each reported 860k, which read as 86%
      // of a 1M window and set off an 85% auto-compact with the context at 17%.
      // Measured on 2.1.321: four requests of 47,931 / 48,108 / 48,211 / 48,314
      // prompt tokens, and a result reporting 192,564.
      const emit = (e: Record<string, unknown>) => mockProc.stdout.emit('data', Buffer.from(JSON.stringify(e) + '\n'));
      const assistant = (prompt: number, parent: string | null = null) =>
        emit({
          type: 'assistant',
          parent_tool_use_id: parent,
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: '.' }],
            usage: { input_tokens: 2, cache_read_input_tokens: prompt - 1002, cache_creation_input_tokens: 1000 },
          },
        });
      for (const prompt of [170_000, 171_000, 172_000, 173_000, 174_000]) assistant(prompt);
      // A subagent's request is its own context, not this conversation's — even
      // when it is the turn's last, as in a turn stopped while a subagent runs.
      assistant(600_000, 'toolu_sub');
      emit({
        type: 'result',
        usage: {
          input_tokens: 10,
          output_tokens: 50,
          cache_read_input_tokens: 854_990,
          cache_creation_input_tokens: 5_000,
        },
        modelUsage: { 'claude-opus-5-5': { contextWindow: 1_000_000 } },
      });
      expect(session.getStats().contextPercent).toBe(17);

      // The next turn starts over: with no request of its own to read, it falls
      // back to its result rather than keeping the previous turn's figure.
      emit({ type: 'result', usage: { input_tokens: 2, output_tokens: 4, cache_read_input_tokens: 300_000 } });
      expect(session.getStats().contextPercent).toBe(30);
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
