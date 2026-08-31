/**
 * Persistent Claude Code Session — wraps `claude` CLI via child_process.spawn
 *
 * Maintains a long-running Claude Code process with streaming JSON I/O.
 * Enables multi-turn agent loops, continuous conversation, and real-time streaming.
 */

import { spawn, ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import * as readline from 'node:readline';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  type SessionConfig,
  type SessionStats,
  type EffortLevel,
  type HookConfig,
  type StreamEvent,
  type ISession,
  type SessionSendOptions,
  type StreamCallbacks,
  type TurnResult,
  type CostBreakdown,
  getModelPricing,
} from './types.js';
import { resolveAlias, getContextWindow, isClaudeModel } from './models.js';
import { sanitizeSecrets } from './sanitize.js';

import {
  CONTEXT_HIGH_THRESHOLD,
  MAX_HISTORY_ITEMS,
  DEFAULT_HISTORY_LIMIT,
  SESSION_READY_TIMEOUT_MS,
  SESSION_READY_FALLBACK_MS,
  TURN_TIMEOUT_MS,
  COMPACT_TIMEOUT_MS,
  STOP_SIGKILL_DELAY_MS,
  SESSION_EVENT,
} from './constants.js';

// ─── Internal Stats ──────────────────────────────────────────────────────────

interface InternalStats {
  turns: number;
  turnsSucceeded: number;
  toolCalls: number;
  toolErrors: number;
  tokensIn: number;
  tokensOut: number;
  cachedTokens: number;
  /** Prompt tokens written into the cache; excluded from `tokensIn` by the API. */
  cacheCreationTokens: number;
  /** Of `cacheCreationTokens`, the part written with the 1-hour TTL. */
  cacheCreation1hTokens: number;
  costUsd: number;
  startTime: string | null;
  lastActivity: string | null;
  history: Array<{ time: string; type: string; event: unknown }>;
  retries: number;
  lastRetryError?: string;
  pluginErrors?: Array<{ plugin: string; reason: string }>;
}

// ─── PersistentClaudeSession ─────────────────────────────────────────────────

export class PersistentClaudeSession extends EventEmitter implements ISession {
  private options: SessionConfig & { hooks?: HookConfig; modelOverrides?: Record<string, string> };
  private claudeBin: string;
  private proc: ChildProcess | null = null;
  private _rl: readline.Interface | null = null;
  private _isReady = false;
  private _isPaused = false;
  private _isBusy = false;
  private currentRequestId = 0;
  private _streamCallbacks: StreamCallbacks | null = null;
  private _contextHighFired = false;
  private _realModel: string | null = null;
  /**
   * Usage already applied for the assistant message being streamed. Its
   * `message_delta` events carry that message's running total, so each one
   * contributes only what it added since the last.
   */
  private _msgProvisional = { in: 0, out: 0, cacheRead: 0, cacheCreate: 0, cacheCreate1h: 0 };
  /**
   * Usage applied so far for the turn in flight, across every message in it.
   * The turn's `result` reports the same tokens once more, so this is taken
   * back out before the authoritative figure lands.
   */
  private _turnApplied = { in: 0, out: 0, cacheRead: 0, cacheCreate: 0, cacheCreate1h: 0 };
  /**
   * Last `total_cost_usd` seen from the current CLI process. That field is the
   * session running total, not the turn's cost — three consecutive turns on one
   * process read 0.02377 then 0.047559 — so spend advances by the difference.
   */
  private _lastReportedCost: number | null = null;
  /** Spend accumulated from the engine's own per-process running totals. */
  private _engineCostUsd = 0;
  /** Context window the engine reported for the model it actually used. */
  private _engineContextWindow: number | null = null;
  /** Full prompt size of the last turn: input + cached reads + cache writes. */
  private _lastTurnPromptTokens = 0;

  public sessionId?: string;
  public stats: InternalStats;

  constructor(config: SessionConfig, claudeBin?: string) {
    super();
    this.claudeBin = claudeBin || process.env.CLAUDE_BIN || 'claude';
    this.options = {
      ...config,
      permissionMode: config.permissionMode || 'acceptEdits',
      hooks: {},
      modelOverrides: config.modelOverrides || {},
    };
    this.stats = {
      turns: 0,
      turnsSucceeded: 0,
      toolCalls: 0,
      toolErrors: 0,
      tokensIn: 0,
      tokensOut: 0,
      cachedTokens: 0,
      cacheCreationTokens: 0,
      cacheCreation1hTokens: 0,
      costUsd: 0,
      startTime: null,
      lastActivity: null,
      history: [],
      retries: 0,
      lastRetryError: undefined,
    };
  }

  get pid(): number | undefined {
    return this.proc?.pid ?? undefined;
  }

  get isReady(): boolean {
    return this._isReady;
  }
  get isPaused(): boolean {
    return this._isPaused;
  }
  get isBusy(): boolean {
    return this._isBusy;
  }

  /**
   * Build the `--settings` argv fragment, merging in the session options that are
   * expressed as settings keys rather than flags.
   *
   * Two live here today:
   *   - `ultracode` enables dynamic workflows. It is a settings key, NOT an
   *     `--effort` value (the CLI rejects `--effort ultracode`).
   *   - `crossSessionInbound` sets this session's policy for peer messages from
   *     other Claude Code sessions on the machine.
   *
   * User-supplied settings are never dropped: inline JSON and readable settings
   * files are parsed and merged into a single object; if that fails we fall back
   * to passing the original `--settings` untouched plus a second one carrying
   * only our keys.
   */
  private buildSettingsArgs(): string[] {
    const injected: Record<string, unknown> = {};
    if (this.options.ultracode) injected.ultracode = true;
    if (this.options.crossSessionInbound) injected.crossSessionInbound = this.options.crossSessionInbound;

    const settings = this.options.settings;
    if (!Object.keys(injected).length) return settings ? ['--settings', settings] : [];
    if (!settings) return ['--settings', JSON.stringify(injected)];

    const trimmed = settings.trim();
    try {
      const raw = trimmed.startsWith('{') ? trimmed : fs.readFileSync(trimmed, 'utf8');
      const obj = JSON.parse(raw) as Record<string, unknown>;
      Object.assign(obj, injected);
      return ['--settings', JSON.stringify(obj)];
    } catch {
      // Couldn't parse/read to merge — keep the user's settings and add ours separately.
      return ['--settings', settings, '--settings', JSON.stringify(injected)];
    }
  }

  // ─── Start ───────────────────────────────────────────────────────────────

  async start(): Promise<this> {
    const resolvedBin = this.claudeBin;
    const args = [
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--replay-user-messages',
      '--verbose',
      '--include-partial-messages',
      '--permission-mode',
      // `sandboxMode: 'read-only'` is the engine-agnostic "look, don't touch"
      // hint; Claude's native equivalent is plan mode. It must win over any
      // permissionMode the caller also passed, otherwise the DEFAULT engine
      // would accept the flag and still run write-enabled (acceptEdits) — a
      // silent no-op on the most likely call.
      this.options.sandboxMode === 'read-only' ? 'plan' : this.options.permissionMode || 'acceptEdits',
    ];

    // Model alias resolution
    if (this.options.model) {
      const resolved = this.resolveModel(this.options.model);
      if (resolved !== this.options.model) this.options.model = resolved;
    }

    // Resume / fork
    const resumeId = this.options.claudeResumeId || this.options.resumeSessionId;
    if (resumeId) {
      args.push('--resume', resumeId);
      if (this.options.forkSession) args.push('--fork-session');
    }
    if (this.options.customSessionId) args.push('--session-id', this.options.customSessionId);

    // Model — proxy mode mapping
    if (this.options.model) {
      if (!isClaudeModel(this.options.model!) && this.options.baseUrl) {
        this._realModel = this.options.model;
        args.push('--model', 'opus');
      } else {
        const cliModel = this.options.model.includes('/') ? this.options.model.split('/').pop()! : this.options.model;
        args.push('--model', cliModel);
      }
    }

    // Tool control
    if (this.options.allowedTools?.length) args.push('--allowed-tools', this.options.allowedTools.join(','));
    if (this.options.disallowedTools?.length) args.push('--disallowed-tools', this.options.disallowedTools.join(','));
    if (this.options.tools !== undefined && this.options.tools !== null) {
      const t = Array.isArray(this.options.tools) ? this.options.tools.join(',') : this.options.tools;
      args.push('--tools', t);
    }

    // System prompts
    if (this.options.systemPrompt) args.push('--system-prompt', this.options.systemPrompt);
    if (this.options.appendSystemPrompt) args.push('--append-system-prompt', this.options.appendSystemPrompt);

    // Limits
    if (this.options.maxTurns) args.push('--max-turns', String(this.options.maxTurns));
    if (this.options.maxBudgetUsd) args.push('--max-budget-usd', String(this.options.maxBudgetUsd));

    // Permissions
    if (this.options.dangerouslySkipPermissions) args.push('--dangerously-skip-permissions');

    // Agents
    if (this.options.agents) {
      const json = typeof this.options.agents === 'string' ? this.options.agents : JSON.stringify(this.options.agents);
      args.push('--agents', json);
    }
    if (this.options.agent) args.push('--agent', this.options.agent);

    // Directories
    if (this.options.addDir?.length) {
      for (const dir of this.options.addDir) args.push('--add-dir', dir);
    }

    // Effort. Claude Code's ladder tops out at `max` (it names the set in its
    // own warning), and an unknown value is only warned about before the turn
    // runs at the default — so `ultra`, which only Codex has, clamps here
    // rather than silently losing the caller's intent to the default.
    if (this.options.effort && this.options.effort !== 'auto') {
      args.push('--effort', this.options.effort === 'ultra' ? 'max' : this.options.effort);
    }

    // Restricted mode. Structural rather than cooperative: the command-running
    // tools are removed from the session instead of being denied on request.
    if (this.options.restricted) args.push('--restricted');

    // Auto mode
    if (this.options.enableAutoMode || this.options.permissionMode === 'auto') args.push('--enable-auto-mode');

    // Session name
    if (this.options.sessionName) args.push('-n', this.options.sessionName);

    // New CLI flags
    if (this.options.bare) args.push('--bare');
    if (this.options.worktree) {
      args.push('--worktree');
      if (typeof this.options.worktree === 'string' && this.options.worktree !== 'true')
        args.push(this.options.worktree);
    }
    if (this.options.fallbackModel) {
      // CLI 2.1.x accepts a comma-separated list to try each in order.
      const fm = Array.isArray(this.options.fallbackModel)
        ? this.options.fallbackModel.join(',')
        : this.options.fallbackModel;
      if (fm) args.push('--fallback-model', fm);
    }
    if (this.options.jsonSchema) args.push('--json-schema', this.options.jsonSchema);
    if (this.options.mcpConfig) {
      const configs = Array.isArray(this.options.mcpConfig) ? this.options.mcpConfig : [this.options.mcpConfig];
      for (const c of configs) args.push('--mcp-config', c);
    }
    args.push(...this.buildSettingsArgs());
    if (this.options.noSessionPersistence) args.push('--no-session-persistence');
    if (this.options.betas) {
      const bl = Array.isArray(this.options.betas) ? this.options.betas : this.options.betas.split(',');
      for (const b of bl) args.push('--betas', b.trim());
    }

    // CLI 2.1.111 features
    if (this.options.includeHookEvents) args.push('--include-hook-events');
    // CLI 2.1.211+: surface subagent output in the parent stream.
    if (this.options.forwardSubagentText) args.push('--forward-subagent-text');
    if (this.options.permissionPromptTool) args.push('--permission-prompt-tool', this.options.permissionPromptTool);

    // Smart default: bare mode auto-enables exclude-dynamic-system-prompt-sections for better cache hits
    const shouldExcludeDynamic =
      this.options.excludeDynamicSystemPromptSections === true ||
      (this.options.bare && this.options.excludeDynamicSystemPromptSections !== false);
    if (shouldExcludeDynamic) args.push('--exclude-dynamic-system-prompt-sections');

    if (this.options.debug) {
      const cats = Array.isArray(this.options.debug) ? this.options.debug.join(',') : this.options.debug;
      args.push('--debug', cats);
    }
    if (this.options.debugFile) args.push('--debug-file', this.options.debugFile);
    if (this.options.fromPr) args.push('--from-pr', this.options.fromPr);
    if (this.options.channels) {
      const ch = Array.isArray(this.options.channels) ? this.options.channels : [this.options.channels];
      for (const c of ch) args.push('--channels', c);
    }
    if (this.options.dangerouslyLoadDevelopmentChannels) {
      const ch = Array.isArray(this.options.dangerouslyLoadDevelopmentChannels)
        ? this.options.dangerouslyLoadDevelopmentChannels
        : [this.options.dangerouslyLoadDevelopmentChannels];
      for (const c of ch) args.push('--dangerously-load-development-channels', c);
    }
    // CLI 2.1.129 features
    if (this.options.pluginUrl) {
      const urls = Array.isArray(this.options.pluginUrl) ? this.options.pluginUrl : [this.options.pluginUrl];
      for (const u of urls) args.push('--plugin-url', u);
    }

    // Ensure CWD exists (normalize to prevent path traversal)
    if (this.options.cwd) {
      this.options.cwd = path.resolve(this.options.cwd);
      if (!fs.existsSync(this.options.cwd)) {
        fs.mkdirSync(this.options.cwd, { recursive: true });
      }
    }

    // Build spawn environment
    // Preserve the parent process PATH so the resolved binary and any PATH-relative
    // tools (git, node, npm, etc.) remain accessible on all platforms and distros.
    const spawnEnv: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
    };
    // Without a baseUrl the child talks to the official API — an inherited
    // proxy-scoped ANTHROPIC_API_KEY (not sk-ant-*) would take precedence over the
    // CLI's own login there and 401. Official-format keys are left untouched.
    const inheritedKey = spawnEnv.ANTHROPIC_API_KEY;
    if (
      inheritedKey &&
      !inheritedKey.startsWith('sk-ant-') &&
      !this.options.baseUrl &&
      !process.env.ANTHROPIC_BASE_URL
    ) {
      delete spawnEnv.ANTHROPIC_API_KEY;
    }
    if (this.options.baseUrl) spawnEnv.ANTHROPIC_BASE_URL = this.options.baseUrl;
    if (this.options.enableAgentTeams) spawnEnv.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = 'true';
    // Smart default: bare mode auto-enables 1H prompt caching
    if (
      this.options.enablePromptCaching1H === true ||
      (this.options.bare && this.options.enablePromptCaching1H !== false)
    ) {
      spawnEnv.ENABLE_PROMPT_CACHING_1H = '1';
    }
    // CLI 2.1.121 features
    if (this.options.forkSubagent) spawnEnv.CLAUDE_CODE_FORK_SUBAGENT = '1';
    if (this.options.enableToolSearch) spawnEnv.ENABLE_TOOL_SEARCH = '1';
    if (this.options.otelLogUserPrompts) spawnEnv.OTEL_LOG_USER_PROMPTS = '1';
    if (this.options.otelLogRawApiBodies) spawnEnv.OTEL_LOG_RAW_API_BODIES = '1';
    // CLI 2.1.122 features
    if (this.options.bedrockServiceTier) spawnEnv.ANTHROPIC_BEDROCK_SERVICE_TIER = this.options.bedrockServiceTier;
    if (this._realModel && this.options.baseUrl) {
      const base = this.options.baseUrl.replace(/\/$/, '');
      spawnEnv.ANTHROPIC_BASE_URL = `${base}/real/${this._realModel}`;
    }

    // Spawn
    this.proc = spawn(resolvedBin, args, {
      cwd: this.options.cwd,
      env: spawnEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });
    // Unref so the parent process can exit independently of the child.
    this.proc.unref();

    // Parse stdout line-by-line
    this._rl = readline.createInterface({ input: this.proc.stdout!, crlfDelay: Infinity });
    this._rl.on('line', (line) => {
      if (!line.trim()) return;
      try {
        const event = JSON.parse(line) as StreamEvent;
        this._handleEvent(event);
      } catch (err) {
        // Distinguish malformed JSON (a protocol bug) from plain log lines so
        // operators can triage. readline guarantees whole lines, so this is
        // never a frame-split artifact.
        this.emit(SESSION_EVENT.LOG, `[stdout] ${line}${err instanceof Error ? ` (parse: ${err.message})` : ''}`);
      }
    });
    // Without an 'error' handler a stdout stream fault (ECONNRESET, premature
    // close) makes readline emit an unhandled 'error' that crashes the monitor
    // process itself — exactly what Recovery > Complexity forbids.
    this._rl.on('error', (err: Error) => {
      this.emit(SESSION_EVENT.ERROR, new Error(`readline error: ${err.message}`));
    });

    this.proc.stderr?.on('data', (data: Buffer) => {
      this.emit(SESSION_EVENT.LOG, `[stderr] ${sanitizeSecrets(data.toString())}`);
    });

    this.proc.on('close', (code) => {
      this._isReady = false;
      this.emit(SESSION_EVENT.CLOSE, code);
    });

    this.proc.on('error', (err) => {
      // Spawn/runtime failure: drop references so a later send() fails the
      // readiness check instead of writing to a dead process.
      this._isReady = false;
      try {
        this._rl?.close();
      } catch {
        /* ignore */
      }
      this._rl = null;
      this.proc = null;
      this.emit(SESSION_EVENT.ERROR, err);
    });

    // Wait for ready
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('Timeout waiting for session ready')),
        SESSION_READY_TIMEOUT_MS,
      );

      this.once(SESSION_EVENT.READY, () => {
        clearTimeout(timeout);
        resolve(this);
      });
      this.once(SESSION_EVENT.ERROR, (err) => {
        clearTimeout(timeout);
        reject(err);
      });

      // Detect premature CLI exit to avoid hanging or marking a dead process as "ready".
      const onCloseBeforeReady = (code: number | null) => {
        if (!this._isReady) {
          clearTimeout(timeout);
          reject(new Error(`Claude process exited prematurely with code ${code}. Session failed to start.`));
        }
      };
      this.once(SESSION_EVENT.CLOSE, onCloseBeforeReady);

      // Emit ready on the first `system` init event from the CLI.
      // Fall back to a 2 s timer in case the CLI version doesn't emit one.
      const onInit = () => {
        if (!this._isReady) {
          this._isReady = true;
          // Cleanup the early-close listener since initialization succeeded
          this.removeListener(SESSION_EVENT.CLOSE, onCloseBeforeReady);
          this.emit(SESSION_EVENT.READY);
        }
      };
      this.once(SESSION_EVENT.INIT, onInit);
      setTimeout(() => {
        this.removeListener(SESSION_EVENT.INIT, onInit);
        // If process already exited, reject instead of falsely marking ready
        if (this.proc?.killed || this.proc?.exitCode !== null) {
          clearTimeout(timeout);
          this.removeListener(SESSION_EVENT.CLOSE, onCloseBeforeReady);
          reject(new Error('Claude CLI process crashed immediately upon startup. Fallback timer aborted.'));
          return;
        }
        if (!this._isReady) {
          this._isReady = true;
          this.removeListener(SESSION_EVENT.CLOSE, onCloseBeforeReady);
          this.emit(SESSION_EVENT.READY);
        }
      }, SESSION_READY_FALLBACK_MS);
    });
  }

  // ─── Event Handling ──────────────────────────────────────────────────────

  private _handleEvent(event: StreamEvent): void {
    const type = event.type;
    this.stats.lastActivity = new Date().toISOString();

    // Track history (keep last 100)
    this.stats.history.push({ time: this.stats.lastActivity, type, event });
    if (this.stats.history.length > MAX_HISTORY_ITEMS) this.stats.history.shift();

    switch (type) {
      case 'system':
        if (event.subtype === 'init') {
          this.sessionId = event.session_id;
          this.stats.startTime = new Date().toISOString();
          const pluginErrors = (event as Record<string, unknown>).plugin_errors;
          if (Array.isArray(pluginErrors) && pluginErrors.length > 0) {
            this.stats.pluginErrors = pluginErrors as Array<{ plugin: string; reason: string }>;
          }
          this.emit(SESSION_EVENT.INIT, event);
        } else if (event.subtype === 'api_retry') {
          this.stats.retries++;
          this.stats.lastRetryError =
            ((event as Record<string, unknown>).error_category as string) ||
            String((event as Record<string, unknown>).error_status || 'unknown');
        }
        this.emit(SESSION_EVENT.SYSTEM, event);
        break;

      case 'stream_event': {
        const inner = (event as Record<string, unknown>).event as Record<string, unknown> | undefined;
        if (!inner) break;
        const innerType = inner.type as string;

        if (innerType === 'message_start') {
          // A turn can contain several assistant messages (one per tool round),
          // and each carries its own `message_delta` usage series starting from
          // zero. Reset the per-message baseline so the next delta is measured
          // against this message, not the previous one.
          this._msgProvisional = { in: 0, out: 0, cacheRead: 0, cacheCreate: 0, cacheCreate1h: 0 };
        } else if (innerType === 'content_block_start') {
          const block = (inner as Record<string, unknown>).content_block as Record<string, unknown> | undefined;
          if (block?.type === 'tool_use') {
            this.stats.toolCalls++;
            const toolEvent = { tool: { name: block.name, input: {} } };
            try {
              this._streamCallbacks?.onToolUse?.(toolEvent);
            } catch (err) {
              this.emit(SESSION_EVENT.LOG, `[stream callback error] onToolUse: ${(err as Error).message}`);
            }
            this.emit(SESSION_EVENT.TOOL_USE, toolEvent);
          }
        } else if (innerType === 'content_block_delta') {
          const delta = (inner as Record<string, unknown>).delta as Record<string, unknown> | undefined;
          if (delta?.type === 'text_delta' && delta.text) {
            try {
              this._streamCallbacks?.onText?.(delta.text as string);
            } catch (err) {
              this.emit(SESSION_EVENT.LOG, `[stream callback error] onText: ${(err as Error).message}`);
            }
            this.emit(SESSION_EVENT.TEXT, delta.text);
          }
        } else if (innerType === 'message_delta') {
          const usage = (inner as Record<string, unknown>).usage as Record<string, number> | undefined;
          // Provisional: `message_delta` carries the running usage of the
          // assistant message being streamed, and the turn's `result` reports
          // the very same tokens again. Counting both doubled every figure —
          // measured against the CLI on a real turn, the engine reported
          // in=2/out=4/cache_read=47371 and getStats() returned 4/8/94742.
          // Apply it live so a long turn still moves, and remember how much so
          // `result` can take it back before applying the authoritative number.
          if (usage) this._applyTurnUsage(usage, false);
        }
        this.emit(SESSION_EVENT.STREAM_EVENT, event);
        break;
      }

      case 'user':
        this.stats.turns++;
        this.emit(SESSION_EVENT.USER_ECHO, event);
        break;

      case 'assistant':
        this.emit(SESSION_EVENT.ASSISTANT, event);
        if (event.message?.content && Array.isArray(event.message.content)) {
          for (const block of event.message.content) {
            if (block.type === 'tool_use') {
              this.stats.toolCalls++;
              const toolEvent = {
                tool: {
                  name: (block as Record<string, unknown>).name,
                  input: (block as Record<string, unknown>).input || {},
                },
              };
              try {
                this._streamCallbacks?.onToolUse?.(toolEvent);
              } catch (err) {
                this.emit(SESSION_EVENT.LOG, `[stream callback error] onToolUse: ${(err as Error).message}`);
              }
              this.emit(SESSION_EVENT.TOOL_USE, toolEvent);
            }
          }
        }
        break;

      case 'tool_use':
        this.stats.toolCalls++;
        try {
          this._streamCallbacks?.onToolUse?.(event);
        } catch (err) {
          this.emit(SESSION_EVENT.LOG, `[stream callback error] onToolUse: ${(err as Error).message}`);
        }
        this.emit(SESSION_EVENT.TOOL_USE, event);
        break;

      case 'tool_result':
        try {
          this._streamCallbacks?.onToolResult?.(event);
        } catch (err) {
          this.emit(SESSION_EVENT.LOG, `[stream callback error] onToolResult: ${(err as Error).message}`);
        }
        if ((event as Record<string, unknown>).is_error || (event as Record<string, unknown>).error) {
          this.stats.toolErrors++;
          this._fireHook('onToolError', {
            tool: (event as Record<string, unknown>).tool_use_id,
            error: (event as Record<string, unknown>).error,
          });
        }
        this.emit(SESSION_EVENT.TOOL_RESULT, event);
        break;

      case 'error':
        this.emit(
          SESSION_EVENT.ERROR,
          new Error(String((event as Record<string, unknown>).error) || JSON.stringify(event)),
        );
        break;

      case 'result': {
        const usage = (event as Record<string, unknown>).usage as Record<string, number> | undefined;
        if (usage) this._applyTurnUsage(usage, true);
        this._applyReportedCost((event as Record<string, unknown>).total_cost_usd);
        this._captureContextWindow((event as Record<string, unknown>).modelUsage);
        // The result event is the only place the outcome is known, and it arrives once
        // per send — unlike the `user` echo that drives `turns`, which the CLI also
        // emits per tool-result batch. `is_error` is read as truthy on purpose: for a
        // persistent `custom` engine this event comes from an arbitrary CLI.
        if (!(event.is_error || event.stop_reason === 'error')) {
          this.stats.turnsSucceeded++;
        }
        this.emit(SESSION_EVENT.RESULT, event);
        this.emit(SESSION_EVENT.TURN_COMPLETE, event);
        this._fireHook('onTurnComplete', {
          text: event.result,
          usage,
          stopReason: (event as Record<string, unknown>).stop_reason,
        });

        // The prompt the last turn actually carried, not the session's summed
        // `input_tokens` — the latter excludes cached reads, so on a resumed
        // conversation it stays near zero and this hook never fires however
        // full the context gets.
        const contextTokens = this._lastTurnPromptTokens;
        if (contextTokens > CONTEXT_HIGH_THRESHOLD && !this._contextHighFired) {
          this._contextHighFired = true;
          this._fireHook('onContextHigh', { tokensUsed: contextTokens, threshold: CONTEXT_HIGH_THRESHOLD });
        }
        const stopReason = (event as Record<string, unknown>).stop_reason;
        if (stopReason === 'error' || stopReason === 'rate_limit') {
          this._fireHook('onStopFailure', { reason: stopReason, error: (event as Record<string, unknown>).error });
        }
        break;
      }

      default:
        this.emit(SESSION_EVENT.EVENT, event);
    }
  }

  // ─── Send ────────────────────────────────────────────────────────────────

  async send(
    message: string | unknown[],
    options: SessionSendOptions = {},
  ): Promise<TurnResult | { requestId: number; sent: boolean }> {
    if (!this._isReady || !this.proc) throw new Error('Session not ready. Call start() first.');

    const requestId = ++this.currentRequestId;

    // A turn that died before its `result` leaves a partial baseline behind.
    // Clearing both here means the next turn measures from zero rather than
    // discounting itself by the abandoned turn's tokens.
    this._msgProvisional = { in: 0, out: 0, cacheRead: 0, cacheCreate: 0, cacheCreate1h: 0 };
    this._turnApplied = { in: 0, out: 0, cacheRead: 0, cacheCreate: 0, cacheCreate1h: 0 };

    let finalMessage = typeof message === 'string' ? message : message;
    if (typeof finalMessage === 'string') {
      if (
        options.effort === 'high' ||
        options.effort === 'xhigh' ||
        options.effort === 'max' ||
        options.effort === 'ultra'
      ) {
        finalMessage = `ultrathink\n\n${finalMessage}`;
      }
      if (options.plan) {
        // /plan slash command is unreliable across Claude Code versions and environments.
        // Instruction-based planning is universally compatible; actual plan permission
        // mode is controlled by --permission-mode plan at session start.
        finalMessage = `[Planning Mode] Analyze the request and create a detailed plan only. Do not write code or make changes yet.\n\n${finalMessage}`;
      }
    }

    const payload = {
      type: 'user',
      message: {
        role: 'user',
        content: typeof finalMessage === 'string' ? [{ type: 'text', text: finalMessage }] : finalMessage,
      },
    };

    const stdin = this.proc.stdin;
    if (!stdin || stdin.writable === false) {
      throw new Error('Session stdin is not writable (process may have exited). Call start() first.');
    }
    // Pass an error callback so a broken pipe / closed stdin surfaces instead of
    // silently dropping the write and leaving waitForComplete callers hung.
    stdin.write(JSON.stringify(payload) + '\n', (err) => {
      if (err) this.emit(SESSION_EVENT.ERROR, new Error(`Failed to write to stdin: ${err.message}`));
    });

    if (options.callbacks) this._streamCallbacks = options.callbacks;

    if (options.waitForComplete) {
      this._isBusy = true;
      try {
        return await this._waitForTurnComplete(options.timeout || TURN_TIMEOUT_MS);
      } finally {
        this._isBusy = false;
        if (options.callbacks) this._streamCallbacks = null;
      }
    }

    return { requestId, sent: true };
  }

  // ─── Wait for Turn Complete ──────────────────────────────────────────────

  private _waitForTurnComplete(timeout: number): Promise<TurnResult> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let streamedText = '';
      let allAssistantText = '';
      const toolNames: string[] = [];

      const onText = (chunk: string) => {
        streamedText += chunk;
      };
      this.on(SESSION_EVENT.TEXT, onText);

      const onAssistant = (event: StreamEvent) => {
        if (event.message?.content && Array.isArray(event.message.content)) {
          for (const block of event.message.content) {
            if (block.type === 'text' && block.text) allAssistantText += block.text + '\n';
          }
        }
      };
      this.on(SESSION_EVENT.ASSISTANT, onAssistant);

      const onToolUse = (event: Record<string, unknown>) => {
        const tool = event.tool as Record<string, string> | undefined;
        toolNames.push(tool?.name || (event.name as string) || 'unknown');
      };
      this.on(SESSION_EVENT.TOOL_USE, onToolUse);

      const cleanup = () => {
        clearTimeout(timer);
        this.removeListener(SESSION_EVENT.TEXT, onText);
        this.removeListener(SESSION_EVENT.ASSISTANT, onAssistant);
        this.removeListener(SESSION_EVENT.TOOL_USE, onToolUse);
        this.removeListener(SESSION_EVENT.TURN_COMPLETE, onTurnComplete);
        this.removeListener(SESSION_EVENT.ERROR, onError);
        this.removeListener(SESSION_EVENT.CLOSE, onClose);
      };

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error('Timeout waiting for response'));
      }, timeout);

      const onTurnComplete = (event: StreamEvent) => {
        if (settled) return;
        settled = true;
        cleanup();
        let text =
          ((event as Record<string, unknown>).result as string) || streamedText || allAssistantText.trim() || '';
        if (!text && toolNames.length > 0) {
          const unique = [...new Set(toolNames)];
          text = `[Agent completed ${toolNames.length} tool calls: ${unique.join(', ')}]`;
        }
        resolve({ text, event });
      };

      const onError = (err: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      };

      const onClose = (code: number) => {
        if (settled) return;
        settled = true;
        cleanup();
        const text = streamedText || allAssistantText.trim() || '';
        resolve({
          text,
          event: {
            type: 'result',
            result: text,
            stop_reason: 'process_exit',
            exit_code: code,
          } as StreamEvent,
        });
      };

      this.once(SESSION_EVENT.TURN_COMPLETE, onTurnComplete);
      this.once(SESSION_EVENT.ERROR, onError);
      this.once(SESSION_EVENT.CLOSE, onClose);
    });
  }

  // ─── Utilities ───────────────────────────────────────────────────────────

  getStats(): SessionStats & { sessionId?: string; uptime: number } {
    return {
      turns: this.stats.turns,
      turnsSucceeded: this.stats.turnsSucceeded,
      toolCalls: this.stats.toolCalls,
      toolErrors: this.stats.toolErrors,
      tokensIn: this.stats.tokensIn,
      tokensOut: this.stats.tokensOut,
      cachedTokens: this.stats.cachedTokens,
      costUsd: Math.round(this.stats.costUsd * 10000) / 10000,
      isReady: this._isReady,
      startTime: this.stats.startTime,
      lastActivity: this.stats.lastActivity,
      // Approximate context window utilization based on model's known window size.
      contextPercent: this._contextPercent(),
      retries: this.stats.retries,
      lastRetryError: this.stats.lastRetryError,
      sessionId: this.sessionId,
      uptime: this.stats.startTime ? Math.round((Date.now() - new Date(this.stats.startTime).getTime()) / 1000) : 0,
    };
  }

  getHistory(limit = DEFAULT_HISTORY_LIMIT): Array<{ time: string; type: string; event: unknown }> {
    return this.stats.history.slice(-limit);
  }

  async compact(summary?: string): Promise<TurnResult | { requestId: number; sent: boolean }> {
    const msg = summary ? `/compact ${summary}` : '/compact';
    return this.send(msg, { waitForComplete: true, timeout: COMPACT_TIMEOUT_MS });
  }

  getEffort(): EffortLevel {
    return this.options.effort || 'auto';
  }
  setEffort(level: EffortLevel): void {
    this.options.effort = level;
  }

  getCost(): CostBreakdown {
    const pricing = getModelPricing(this.options.model);
    const nonCachedIn = Math.max(0, this.stats.tokensIn - this.stats.cachedTokens);
    return {
      model: this.options.model || 'default',
      tokensIn: this.stats.tokensIn,
      tokensOut: this.stats.tokensOut,
      cachedTokens: this.stats.cachedTokens,
      pricing: { inputPer1M: pricing.input, outputPer1M: pricing.output, cachedPer1M: pricing.cached },
      breakdown: {
        inputCost: (nonCachedIn / 1_000_000) * pricing.input,
        cachedCost: (this.stats.cachedTokens / 1_000_000) * (pricing.cached ?? 0),
        outputCost: (this.stats.tokensOut / 1_000_000) * pricing.output,
      },
      totalUsd: this.stats.costUsd,
    };
  }

  resolveModel(alias: string): string {
    if (this.options.modelOverrides?.[alias]) return this.options.modelOverrides[alias];
    return resolveAlias(alias);
  }

  pause(): void {
    this._isPaused = true;
    this.emit(SESSION_EVENT.PAUSED, { sessionId: this.sessionId });
  }
  resume(): void {
    this._isPaused = false;
    this.emit(SESSION_EVENT.RESUMED, { sessionId: this.sessionId });
  }

  stop(): void {
    this._fireHook('onStop', { cost: this.getCost(), stats: this.getStats() });
    if (this._rl) {
      this._rl.close();
      this._rl = null;
    }
    if (this.proc) {
      const pid = this.proc.pid!;
      this.proc.stdin?.end();
      this.proc.stdout?.destroy();
      this.proc.stderr?.destroy();
      try {
        process.kill(-pid, 'SIGTERM');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ESRCH') {
          this.emit(SESSION_EVENT.LOG, `[stop] kill(-${pid}, SIGTERM) failed: ${(err as Error).message}`);
        }
        try {
          this.proc.kill('SIGTERM');
        } catch (innerErr) {
          if ((innerErr as NodeJS.ErrnoException).code !== 'ESRCH') {
            this.emit(SESSION_EVENT.LOG, `[stop] proc.kill(SIGTERM) failed: ${(innerErr as Error).message}`);
          }
        }
      }
      const p = this.proc;
      const sigkillTimer = setTimeout(() => {
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          /* ESRCH expected — process already gone */
        }
        try {
          p.kill('SIGKILL');
        } catch {
          /* ESRCH expected */
        }
      }, STOP_SIGKILL_DELAY_MS);
      // Don't keep the event loop alive just for the force-kill fallback.
      sigkillTimer.unref();
      this.proc = null;
    }
    this._isReady = false;
    this._isPaused = false;
    this.emit(SESSION_EVENT.CLOSE, 143);
  }

  // ─── Private ─────────────────────────────────────────────────────────────

  /**
   * Fold one turn's usage into the running totals.
   *
   * The CLI reports the same tokens twice per turn — once on the streaming
   * `message_delta`, once on the terminal `result` — so the two callers are not
   * additive. Provisional usage is applied as it streams and taken back out
   * when the authoritative figure arrives.
   *
   * The Anthropic shape is exclusive: `input_tokens` counts neither the cached
   * reads nor the cache writes, both of which are reported alongside it. On the
   * turn measured while writing this, `input_tokens` was 2 against 47,371
   * cached reads — which is why the prompt size is the sum, not `input_tokens`.
   */
  private _applyTurnUsage(usage: Record<string, unknown>, authoritative: boolean): void {
    const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    const creation = (usage.cache_creation as Record<string, unknown> | undefined) ?? {};
    const reported = {
      in: num(usage.input_tokens),
      out: num(usage.output_tokens),
      cacheRead: num(usage.cache_read_input_tokens),
      cacheCreate: num(usage.cache_creation_input_tokens),
      cacheCreate1h: num(creation.ephemeral_1h_input_tokens),
    };
    // A streaming delta reports its message's running total, so it contributes
    // the difference since the last one. The terminal `result` reports the
    // whole turn, so it contributes whatever the turn has not already applied.
    const baseline = authoritative ? this._turnApplied : this._msgProvisional;
    const delta = {
      in: reported.in - baseline.in,
      out: reported.out - baseline.out,
      cacheRead: reported.cacheRead - baseline.cacheRead,
      cacheCreate: reported.cacheCreate - baseline.cacheCreate,
      cacheCreate1h: reported.cacheCreate1h - baseline.cacheCreate1h,
    };

    // Floors, because these are a third party's numbers: a series that restarts
    // where we did not expect it must not drive a running total negative.
    this.stats.tokensIn = Math.max(0, this.stats.tokensIn + delta.in);
    this.stats.tokensOut = Math.max(0, this.stats.tokensOut + delta.out);
    this.stats.cachedTokens = Math.max(0, this.stats.cachedTokens + delta.cacheRead);
    this.stats.cacheCreationTokens = Math.max(0, this.stats.cacheCreationTokens + delta.cacheCreate);
    this.stats.cacheCreation1hTokens = Math.max(0, this.stats.cacheCreation1hTokens + delta.cacheCreate1h);

    if (authoritative) {
      this._lastTurnPromptTokens = reported.in + reported.cacheRead + reported.cacheCreate;
      this._msgProvisional = { in: 0, out: 0, cacheRead: 0, cacheCreate: 0, cacheCreate1h: 0 };
      this._turnApplied = { in: 0, out: 0, cacheRead: 0, cacheCreate: 0, cacheCreate1h: 0 };
    } else {
      this._msgProvisional = reported;
      this._turnApplied = {
        in: this._turnApplied.in + delta.in,
        out: this._turnApplied.out + delta.out,
        cacheRead: this._turnApplied.cacheRead + delta.cacheRead,
        cacheCreate: this._turnApplied.cacheCreate + delta.cacheCreate,
        cacheCreate1h: this._turnApplied.cacheCreate1h + delta.cacheCreate1h,
      };
    }
    this._updateCost();
  }

  /**
   * Take the engine's own spend figure when it offers one.
   *
   * `total_cost_usd` is cache-aware in a way the registry formula is not: on a
   * turn with 31,435 one-hour cache writes the CLI reported $0.322428 while the
   * formula produced $0.016 — a 20x under-report, on the number `maxBudgetUsd`
   * gates against. It is also the session running total rather than the turn's
   * cost, so spend advances by the difference; a drop means the CLI process was
   * replaced (a resume) and its counter restarted from zero.
   */
  private _applyReportedCost(reported: unknown): void {
    if (typeof reported !== 'number' || !Number.isFinite(reported) || reported < 0) return;
    // In proxy mode the CLI is pointed at another provider's model while being
    // told it is running `opus`, so the figure it computes is Opus list price
    // for someone else's tokens. Fall back to the registry, which at least
    // knows which model was really asked for.
    if (this._realModel) return;
    const previous = this._lastReportedCost;
    const delta = previous === null || reported < previous ? reported : reported - previous;
    this._lastReportedCost = reported;
    this._engineCostUsd += delta;
    this.stats.costUsd = this._engineCostUsd;
  }

  /**
   * Record the context window the engine reports for the model it actually ran.
   *
   * Preferring it over the registry closes the gap the registry keeps drifting
   * into, and matches what the codex-app session already does with
   * `tokenUsage.modelContextWindow`.
   */
  private _captureContextWindow(modelUsage: unknown): void {
    if (!modelUsage || typeof modelUsage !== 'object') return;
    for (const entry of Object.values(modelUsage as Record<string, unknown>)) {
      const w = (entry as Record<string, unknown> | null)?.contextWindow;
      if (typeof w === 'number' && w > 0) {
        this._engineContextWindow = w;
        return;
      }
    }
  }

  /**
   * How full the model's context is, measured on the last turn's prompt.
   *
   * Both halves used to be wrong in the same direction. The numerator summed
   * `tokensIn + tokensOut` across the session, but Anthropic's `input_tokens`
   * excludes cached reads and cache writes — which is where a resumed
   * conversation's entire history sits — so a turn carrying a 47k prompt
   * reported 2 input tokens and the metric read 0%. The denominator came from
   * the registry, which is exactly the number that keeps drifting; the engine
   * now reports the window it is enforcing, so prefer it and keep the registry
   * as the fallback.
   */
  private _contextPercent(): number {
    if (this._lastTurnPromptTokens <= 0) return 0;
    const window =
      this._engineContextWindow ??
      getContextWindow(this.options.resolvedModel || this.options.model || 'claude-sonnet-4-6');
    if (!window) return 0;
    return Math.min(100, Math.round((this._lastTurnPromptTokens / window) * 100));
  }

  private _updateCost(): void {
    // Only reached when the engine did not report its own spend — a custom CLI
    // driven through this class, or a turn that ended before `result`.
    if (this._lastReportedCost !== null) return;
    const pricing = getModelPricing(this.options.model);
    // Anthropic bills cache writes above the input rate and the premium depends
    // on the TTL: 1.25x for the 5-minute cache, 2x for the 1-hour one. Leaving
    // them out entirely is what made the old estimate collapse on cached
    // sessions, where the writes are most of what a turn pays for.
    const cacheCreate5h = Math.max(0, this.stats.cacheCreationTokens - this.stats.cacheCreation1hTokens);
    this.stats.costUsd =
      (this.stats.tokensIn / 1_000_000) * pricing.input +
      (cacheCreate5h / 1_000_000) * pricing.input * 1.25 +
      (this.stats.cacheCreation1hTokens / 1_000_000) * pricing.input * 2 +
      (this.stats.cachedTokens / 1_000_000) * (pricing.cached ?? 0) +
      (this.stats.tokensOut / 1_000_000) * pricing.output;
  }

  private _fireHook(hookName: string, data: unknown): void {
    const hooks = this.options.hooks as Record<string, unknown> | undefined;
    const hook = hooks?.[hookName];
    if (typeof hook === 'function') {
      try {
        (hook as (d: unknown) => void)(data);
      } catch (err) {
        this.emit(SESSION_EVENT.LOG, `[hook error] ${hookName}: ${(err as Error).message}`);
      }
    }
    this.emit(`hook:${hookName}`, data);
  }
}
