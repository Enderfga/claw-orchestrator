/**
 * Persistent Claude Code Session — wraps `claude` CLI via child_process.spawn
 *
 * Maintains a long-running Claude Code process with streaming JSON I/O.
 * Enables multi-turn agent loops, continuous conversation, and real-time streaming.
 */

import { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import * as readline from 'node:readline';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { spawnEngine } from './engine-spawn.js';

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
  toolCalls: number;
  toolErrors: number;
  tokensIn: number;
  tokensOut: number;
  cachedTokens: number;
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
      toolCalls: 0,
      toolErrors: 0,
      tokensIn: 0,
      tokensOut: 0,
      cachedTokens: 0,
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
      this.options.permissionMode || 'acceptEdits',
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

    // Effort
    if (this.options.effort && this.options.effort !== 'auto') args.push('--effort', this.options.effort);

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
    if (this.options.fallbackModel) args.push('--fallback-model', this.options.fallbackModel);
    if (this.options.jsonSchema) args.push('--json-schema', this.options.jsonSchema);
    if (this.options.mcpConfig) {
      const configs = Array.isArray(this.options.mcpConfig) ? this.options.mcpConfig : [this.options.mcpConfig];
      for (const c of configs) args.push('--mcp-config', c);
    }
    if (this.options.settings) args.push('--settings', this.options.settings);
    if (this.options.noSessionPersistence) args.push('--no-session-persistence');
    if (this.options.betas) {
      const bl = Array.isArray(this.options.betas) ? this.options.betas : this.options.betas.split(',');
      for (const b of bl) args.push('--betas', b.trim());
    }

    // CLI 2.1.111 features
    if (this.options.includeHookEvents) args.push('--include-hook-events');
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
    this.proc = spawnEngine(resolvedBin, args, {
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
      } catch {
        this.emit(SESSION_EVENT.LOG, `[stdout] ${line}`);
      }
    });

    this.proc.stderr?.on('data', (data: Buffer) => {
      const sanitized = data
        .toString()
        .replace(/sk-[a-zA-Z0-9_-]{10,}/g, 'sk-***')
        .replace(/ANTHROPIC_API_KEY=[^\s]+/g, 'ANTHROPIC_API_KEY=***')
        .replace(/OPENAI_API_KEY=[^\s]+/g, 'OPENAI_API_KEY=***')
        .replace(/GEMINI_API_KEY=[^\s]+/g, 'GEMINI_API_KEY=***')
        .replace(/Bearer [a-zA-Z0-9_-]+/g, 'Bearer ***');
      this.emit(SESSION_EVENT.LOG, `[stderr] ${sanitized}`);
    });

    this.proc.on('close', (code) => {
      this._isReady = false;
      this.emit(SESSION_EVENT.CLOSE, code);
    });

    this.proc.on('error', (err) => {
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

        if (innerType === 'content_block_start') {
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
          if (usage) {
            this.stats.tokensIn += usage.input_tokens || 0;
            this.stats.tokensOut += usage.output_tokens || 0;
            this.stats.cachedTokens += usage.cache_read_input_tokens || 0;
            this._updateCost();
          }
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
        if (usage) {
          this.stats.tokensIn += usage.input_tokens || 0;
          this.stats.tokensOut += usage.output_tokens || 0;
          this.stats.cachedTokens += usage.cache_read_input_tokens || 0;
          this._updateCost();
        }
        this.emit(SESSION_EVENT.RESULT, event);
        this.emit(SESSION_EVENT.TURN_COMPLETE, event);
        this._fireHook('onTurnComplete', {
          text: event.result,
          usage,
          stopReason: (event as Record<string, unknown>).stop_reason,
        });

        const totalTokens = this.stats.tokensIn + this.stats.tokensOut;
        if (totalTokens > CONTEXT_HIGH_THRESHOLD && !this._contextHighFired) {
          this._contextHighFired = true;
          this._fireHook('onContextHigh', { tokensUsed: totalTokens, threshold: CONTEXT_HIGH_THRESHOLD });
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

    let finalMessage = typeof message === 'string' ? message : message;
    if (typeof finalMessage === 'string') {
      if (options.effort === 'high' || options.effort === 'xhigh' || options.effort === 'max') {
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

    this.proc.stdin!.write(JSON.stringify(payload) + '\n');

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
      // Claude Code doesn't expose exact context usage via the JSON protocol,
      // so this is a best-effort heuristic. May overcount because cumulative
      // token counts include the full conversation history replayed each turn.
      contextPercent: Math.min(
        100,
        Math.round(
          ((this.stats.tokensIn + this.stats.tokensOut) /
            getContextWindow(this.options.resolvedModel || this.options.model || 'claude-sonnet-4-6')) *
            100,
        ),
      ),
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
      setTimeout(() => {
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
      this.proc = null;
    }
    this._isReady = false;
    this._isPaused = false;
    this.emit(SESSION_EVENT.CLOSE, 143);
  }

  // ─── Private ─────────────────────────────────────────────────────────────

  private _updateCost(): void {
    const pricing = getModelPricing(this.options.model);
    const nonCachedIn = Math.max(0, this.stats.tokensIn - this.stats.cachedTokens);
    this.stats.costUsd =
      (nonCachedIn / 1_000_000) * pricing.input +
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
