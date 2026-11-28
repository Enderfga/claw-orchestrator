/**
 * Persistent Claude Code Session — wraps `claude` CLI via child_process.spawn
 *
 * Maintains a long-running Claude Code process with streaming JSON I/O.
 * Enables multi-turn agent loops, continuous conversation, and real-time streaming.
 */

import { ChildProcess } from 'node:child_process';
import { spawnEngine } from './engine-spawn.js';
import { randomUUID } from 'node:crypto';
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
  type EngineCommand,
  type CommandOutcome,
  type CompactOutcome,
  type RewindTarget,
  type RewindOutcome,
  type AsideOutcome,
  type ContextBreakdown,
  type EngineQuota,
  getModelPricing,
} from './types.js';
import { resolveAlias, getContextWindow, isClaudeModel, claudeGatewayMode, gatewayModelPricing } from './models.js';
import { sanitizeSecrets } from './sanitize.js';
import { removeAccountSettings, writeAccountSettings, type AccountUsage } from './claude-accounts.js';
import {
  CLAUDE_CONTROL_COMMANDS,
  CLAUDE_REFUSED_COMMANDS,
  claudeCommandList,
  claudeCommandNames,
  contextFromUsage,
  quotaFromRateLimit,
  quotaFromUsage,
  type ClaudeInitLists,
} from './claude-commands.js';
import { registerQuotaReader } from './engine-quota.js';

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

// ─── Option checks and content blocks ────────────────────────────────────────

const SETTING_SOURCES = new Set<string>(['user', 'project', 'local']);

/**
 * The CLI refuses an `--autocompact` window below 100k tokens, and reads 100 to
 * 1000 as thousands ("200 as shorthand"). The field is a token count, so 200
 * is refused here rather than quietly meaning 200k.
 */
const MIN_AUTOCOMPACT_WINDOW = 100_000;

/** How long a control request may take before it is given up; they answer in milliseconds. */
const CONTROL_TIMEOUT_MS = 15_000;

/** Message ids remembered, to tell a command the CLI starts itself from one this session wrote. */
const WRITTEN_IDS_KEPT = 1_000;

/**
 * An effort as the CLI's `effortLevel` setting takes it: Claude Code's ladder
 * tops out at `max`, so `ultra` (Codex's) clamps to it; `auto` and no effort
 * are `null`, which clears the setting so the CLI's own default applies
 * (measured on 2.1.332: `effortLevel: 'auto'` is ignored, `null` clears it).
 */
function cliEffort(level: EffortLevel | undefined): string | null {
  if (!level || level === 'auto') return null;
  return level === 'ultra' ? 'max' : level;
}

/**
 * Refuse, before anything is spawned or written, a session option the CLI
 * would reject at startup or read differently from what the field says.
 */
function checkClaudeOptions(o: SessionConfig): void {
  if (o.settingSources != null) {
    const ok = Array.isArray(o.settingSources) && o.settingSources.every((s) => SETTING_SOURCES.has(s));
    if (!ok) {
      throw new Error(
        `settingSources must list only user, project and local (got ${JSON.stringify(o.settingSources)})`,
      );
    }
  }
  if (o.systemPromptSnapshot != null && o.systemPromptSnapshot !== 'on' && o.systemPromptSnapshot !== 'off') {
    throw new Error(`systemPromptSnapshot must be 'on' or 'off' (got ${JSON.stringify(o.systemPromptSnapshot)})`);
  }
  const w = o.autoCompactWindow;
  if (w != null && w !== 'auto' && !(Number.isInteger(w) && w >= MIN_AUTOCOMPACT_WINDOW)) {
    throw new Error(
      `autoCompactWindow must be 'auto' or a whole token count of at least ${MIN_AUTOCOMPACT_WINDOW} (got ${JSON.stringify(w)})`,
    );
  }
}

const IMAGE_MEDIA_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

interface ImageBlock {
  type: 'image';
  source: { type: 'base64'; media_type: string; data: string };
}

/** An image file as a Messages API content block, its media type taken from the extension. */
function imageBlock(file: string): ImageBlock {
  const mediaType = IMAGE_MEDIA_TYPES[path.extname(file).toLowerCase()];
  if (!mediaType) throw new Error(`not an image (png, jpg, jpeg, gif, webp): ${file}`);
  let data: Buffer;
  try {
    data = fs.readFileSync(file);
  } catch (err) {
    throw new Error(`cannot read image ${file}: ${(err as Error).message}`);
  }
  return { type: 'image', source: { type: 'base64', media_type: mediaType, data: data.toString('base64') } };
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
  /**
   * A user message was written and its turn's `result` has not come: set by every
   * send, waited on or not (a goal's turns and inbox deliveries are not waited on),
   * cleared by the result and by the process ending.
   */
  private _turnOpen = false;
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
  /** Set when the process was spawned with `--resume`: its first total is inherited, not ours. */
  private _costBaselinePending = false;
  private _refusalFallbacks = 0;
  private _lastRefusalFallback: { from: string; to: string; category?: string } | undefined;
  /** Context window the engine reported for the model it actually used. */
  private _engineContextWindow: number | null = null;
  /** Model id the CLI reported in its init event — what answers when no `model` was set. */
  private _engineModel: string | undefined;
  /** Ids of messages this session wrote whose result has not arrived yet. */
  private _unanswered = new Set<string>();
  /** Context size after the last turn: the prompt of its last request (input + cached reads + cache writes). */
  private _lastTurnPromptTokens = 0;
  /** Prompt of the current turn's latest request on this conversation (0 until one arrives). */
  private _turnRequestPromptTokens = 0;
  /** Credential environment of the Claude account this session runs under; see setAccountEnv(). */
  private _accountEnv: Record<string, string> | undefined;
  /** Private directory holding the settings file that carries the account's credential. */
  private _accountSettingsDir: string | undefined;
  /** The account's usage as the current turn reported it. */
  private _turnUsage: AccountUsage | undefined;
  /** The last `rate_limit_event` of this session, for the quota reader. */
  private _rateLimit: { info: unknown; at: string } | undefined;
  /** Control requests written and not answered yet, by request id. */
  private _controls = new Map<
    string,
    { resolve: (response: unknown) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  /** Ids of the messages this session wrote, the most recent `WRITTEN_IDS_KEPT`. */
  private _written = new Set<string>();
  /**
   * The command the CLI is running that no message of this session started: a
   * `/loop` tick, a scheduled wakeup. Its `command_lifecycle` start names it
   * (`wakeup_source`, or an id this session never wrote); its result carries no
   * message ids and no origin, so this is the only sign it is not a reply.
   */
  private _engineCommand: string | undefined;
  /** `user` events since the last result; taken back out of `turns` when the result was not a turn. */
  private _userEventsSinceResult = 0;
  /**
   * A model ran for the command in flight: an assistant message from a real
   * model in this conversation or in a forked command (a command the CLI answers
   * itself writes one from `<synthetic>`), or a compaction. Not read from the
   * result's `model_usage_since_last_result`, which also holds what a side
   * question asked in between spent.
   */
  private _modelRanSinceResult = false;
  /** Results that are not turns (a local command, a compaction), for `_waitForTurnComplete`. */
  private _notTurns = new WeakSet<object>();
  /** This session's messages whose answer was a model turn, oldest first: what `rewind` counts back through. */
  private _turnMessages: string[] = [];
  /** Compactions the CLI reported (`system/compact_boundary`), and the last one. */
  private _compactions = 0;
  private _lastCompaction: { preTokens?: number; postTokens?: number; trigger: 'manual' | 'auto' } | undefined;
  /** What the CLI's flag-settings layer holds for effort: `null` = no override, `undefined` = not known. */
  private _appliedEffort: string | null | undefined = null;
  /** The permission mode the process was started in, which a per-send plan returns to. */
  private _permissionMode = 'acceptEdits';
  /** Settings to put back once the result answering a message arrives (a per-send effort, model or plan). */
  private _afterTurn = new Map<string, Array<() => void>>();
  /** What `system/init` lists, and the command list made from it (cached until the lists change). */
  private _initLists: ClaudeInitLists = {};
  private _commands: Promise<{ list: EngineCommand[]; names: Set<string>; complete: boolean }> | undefined;
  private _fastModeState: string | undefined;
  /** Results seen; the context breakdown is cached until the next one. */
  private _resultCount = 0;
  private _context: { at: number; value: ContextBreakdown | undefined } | undefined;

  /** Claude sessions take slash commands in their messages, and run clawo's control commands themselves. */
  readonly commandStyle = 'text' as const;
  /** `send()` runs a turn on another model (`set_model`, put back after the turn). */
  readonly perSendModel = true;

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

  /** A turn is running, whoever started it (a `/loop` tick too) and whether anyone waits on it. */
  get turnRunning(): boolean {
    return this._isBusy || this._turnOpen || this._engineCommand !== undefined;
  }

  /**
   * Run under a Claude account: the environment its credential needs. Set by the
   * session manager before start(), never taken from a session config, so a
   * secret is not persisted or reported anywhere a config is.
   */
  setAccountEnv(env: Record<string, string> | undefined): void {
    this._accountEnv = env && Object.keys(env).length ? { ...env } : undefined;
  }

  /** What the last turn reported about the account's usage, if anything. */
  get accountUsage(): AccountUsage | undefined {
    return this._turnUsage;
  }

  /**
   * Build the `--settings` argv fragment, merging in the session options that are
   * expressed as settings keys rather than flags.
   *
   * They are:
   *   - `ultracode` enables dynamic workflows. Passed as the settings key rather
   *     than `--effort ultracode` (accepted since 2.1.203), so it composes with a
   *     separately chosen `effort`.
   *   - `crossSessionInbound` sets this session's policy for peer messages from
   *     other Claude Code sessions on the machine.
   *   - `fastMode` opts the session into fast mode, which a headless process is
   *     refused without (`fast_mode_disabled_reason: 'sdk_opt_in_required'`).
   *   - `outputStyle` picks the output style for this session only; `/output-style
   *     <style>` would write it into the project's settings file.
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
    if (this.options.fastMode) injected.fastMode = true;
    if (this.options.outputStyle) injected.outputStyle = this.options.outputStyle;

    const settings = this.options.settings;
    if (this._accountEnv) return this.buildAccountSettingsArgs(injected, settings);
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

  /**
   * `--settings` for a session that runs under a Claude account.
   *
   * The credential has to travel in `--settings`: the CLI applies the `env` of
   * the user's settings file over its own process environment, so a token in
   * the process environment loses to one written there by another tool, and a
   * `--settings` value outranks both (measured on 2.1.322). It goes in a 0600
   * file in a private directory rather than inline JSON, which any process could
   * read off the command line; stop() removes it, and so does the server's
   * exit or, after a crash, the next server.
   */
  private buildAccountSettingsArgs(injected: Record<string, unknown>, settings: string | undefined): string[] {
    let merged: Record<string, unknown> | undefined;
    if (settings) {
      const trimmed = settings.trim();
      try {
        const raw = trimmed.startsWith('{') ? trimmed : fs.readFileSync(trimmed, 'utf8');
        merged = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        merged = undefined;
      }
    }
    const base = merged ?? {};
    const userEnv = (base.env && typeof base.env === 'object' ? base.env : {}) as Record<string, unknown>;
    const obj = { ...base, ...injected, env: { ...userEnv, ...this._accountEnv } };

    this.removeAccountSettings();
    const { dir, file } = writeAccountSettings(obj);
    this._accountSettingsDir = dir;
    // Settings that could not be read are passed on as given, ahead of ours.
    return settings && !merged ? ['--settings', settings, '--settings', file] : ['--settings', file];
  }

  private removeAccountSettings(): void {
    if (!this._accountSettingsDir) return;
    removeAccountSettings(this._accountSettingsDir);
    this._accountSettingsDir = undefined;
  }

  /**
   * 'error' reaches listeners only. With none attached — between turns nothing
   * listens — an emitted 'error' throws out of the event loop, which in the
   * OpenClaw plugin is the gateway's.
   */
  private _emitError(err: Error): void {
    if (this.listenerCount(SESSION_EVENT.ERROR) > 0) this.emit(SESSION_EVENT.ERROR, err);
    else this.emit(SESSION_EVENT.LOG, `[claude] ${err.message}`);
  }

  // ─── Start ───────────────────────────────────────────────────────────────

  async start(): Promise<this> {
    // Before buildSettingsArgs(), which writes an account's credential file.
    checkClaudeOptions(this.options);
    const resolvedBin = this.claudeBin;
    // `sandboxMode: 'read-only'` is the engine-agnostic "look, don't touch"
    // hint; Claude's native equivalent is plan mode. It must win over any
    // permissionMode the caller also passed, otherwise the DEFAULT engine
    // would accept the flag and still run write-enabled (acceptEdits) — a
    // silent no-op on the most likely call.
    this._permissionMode =
      this.options.sandboxMode === 'read-only' ? 'plan' : this.options.permissionMode || 'acceptEdits';
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
      this._permissionMode,
    ];

    // Model alias resolution
    if (this.options.model) {
      const resolved = this.resolveModel(this.options.model);
      if (resolved !== this.options.model) this.options.model = resolved;
    }

    // Resume / fork
    const resumeId = this.options.claudeResumeId || this.options.resumeSessionId;
    // A resumed process inherits the spend of the turns it is resuming, so the
    // first `total_cost_usd` it reports is not this process's own. See
    // `_applyReportedCost`.
    this._costBaselinePending = !!resumeId;
    if (resumeId) {
      args.push('--resume', resumeId);
      if (this.options.forkSession) args.push('--fork-session');
    }
    if (this.options.customSessionId) args.push('--session-id', this.options.customSessionId);

    // Model — proxy mode mapping. In gateway mode the base URL is the caller's
    // own gateway, which knows the model by its own name: no `/real/` rewrite.
    if (this.options.model) {
      if (!isClaudeModel(this.options.model!) && this.options.baseUrl && !claudeGatewayMode()) {
        this._realModel = this.options.model;
        args.push('--model', 'opus');
      } else {
        const cliModel =
          this.options.model.includes('/') && !claudeGatewayMode()
            ? this.options.model.split('/').pop()!
            : this.options.model;
        args.push('--model', cliModel);
      }
    }

    // Tool control
    const allowed = this._allowedTools();
    if (allowed.length) args.push('--allowed-tools', allowed.join(','));
    if (this.options.disallowedTools?.length) args.push('--disallowed-tools', this.options.disallowedTools.join(','));
    if (this.options.tools !== undefined && this.options.tools !== null) {
      const t = Array.isArray(this.options.tools) ? this.options.tools.join(',') : this.options.tools;
      args.push('--tools', t);
    }

    // System prompts
    if (this.options.systemPrompt) args.push('--system-prompt', this.options.systemPrompt);
    if (this.options.appendSystemPrompt) args.push('--append-system-prompt', this.options.appendSystemPrompt);
    // `on` (the CLI's default outside --bare) records the system prompt on the
    // conversation's first request and resends that record on every resume.
    // Measured on 2.1.330: a conversation begun with "answer ALPHA" and resumed
    // with "answer BETA" answered ALPHA by default, BETA with `off` on the resume.
    if (this.options.systemPromptSnapshot) args.push('--system-prompt-snapshot', this.options.systemPromptSnapshot);
    // Not listed by `claude --help`; 2.1.330 accepts it.
    if (this.options.appendSubagentSystemPrompt) {
      args.push('--append-subagent-system-prompt', this.options.appendSubagentSystemPrompt);
    }

    // Limits
    if (this.options.maxTurns) args.push('--max-turns', String(this.options.maxTurns));
    if (this.options.maxBudgetUsd) args.push('--max-budget-usd', String(this.options.maxBudgetUsd));
    if (this.options.autoCompactWindow != null) args.push('--autocompact', String(this.options.autoCompactWindow));

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
    const effort = cliEffort(this.options.effort);
    if (effort) args.push('--effort', effort);
    // The process starts with this effort in its flag-settings layer, the same
    // layer `apply_flag_settings` changes (measured on 2.1.332).
    this._appliedEffort = effort;

    // The advisor model, for this session only. Not listed by `claude --help`;
    // 2.1.332 accepts it, and ignores an advisor less capable than the main model
    // (saying so on stderr).
    if (this.options.advisor) args.push('--advisor', this.options.advisor);

    // Restricted mode. Structural rather than cooperative: the command-running
    // tools are removed from the session instead of being denied on request.
    if (this.options.restricted) args.push('--restricted');
    // Messages go in as text: no skill or slash command expands, `/compact`
    // included (see compact()).
    if (this.options.disableSlashCommands) args.push('--disable-slash-commands');

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
    // Only the servers of --mcp-config; with none given, no MCP servers at all.
    if (this.options.strictMcpConfig) args.push('--strict-mcp-config');
    // An empty list is passed as '' and loads no settings file; leaving the flag
    // out would load all three. Measured on 2.1.330 through the `initialize`
    // control request: with '' the user's MCP servers and plugin skills are gone.
    if (this.options.settingSources != null) args.push('--setting-sources', this.options.settingSources.join(','));
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
    // Chrome acts with the browser's own sign-ins, so it is off unless asked
    // for, and off is said explicitly: a user setting can enable it by default.
    args.push(this.options.chrome === true ? '--chrome' : '--no-chrome');
    if (this.options.permissionPromptTool) {
      args.push('--permission-prompt-tool', this.options.permissionPromptTool);
    } else {
      // Nobody is attached to answer a prompt in this spawn shape: no TTY, and
      // no prompt tool. Before CLI 2.1.259 a tool call the permission mode did
      // not already decide would sit waiting for an answer that could never
      // come — the session hung until its turn timeout. `none` makes that
      // deterministic: the call is denied, the model sees the denial and can
      // adapt, and the permission mode still decides everything else.
      args.push('--permission-prompts', 'none');
    }

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
    if (this.options.pluginDir) {
      const dirs = Array.isArray(this.options.pluginDir) ? this.options.pluginDir : [this.options.pluginDir];
      for (const d of dirs) args.push('--plugin-dir', d);
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
    // File checkpoints, which `rewind` with `files` restores from: on, as in the
    // terminal, unless the environment says otherwise. Without it the CLI
    // answers every rewind_files with "File rewinding is not enabled."
    spawnEnv.CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING ??= '1';
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
    // A new process answers none of the old one's messages.
    this._unanswered.clear();
    this.proc = spawnEngine(resolvedBin, args, {
      launcher: this.options.launcher,
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
      this._emitError(new Error(`readline error: ${err.message}`));
    });

    this.proc.stderr?.on('data', (data: Buffer) => {
      this.emit(SESSION_EVENT.LOG, `[stderr] ${sanitizeSecrets(data.toString())}`);
    });
    // Writing to a CLI that has just died raises 'error' on stdin as well as in
    // the write callback; unheard, it would throw out of the event loop.
    this.proc.stdin?.on('error', (err) => this.emit(SESSION_EVENT.LOG, `[stdin] ${err.message}`));

    // Both handlers belong to this process only. switchAccount() replaces the
    // process in place, and the old one's `close` lands after the new one has
    // started; acting on it would mark the new process dead and delete its
    // credential file.
    const child = this.proc;
    const superseded = () => this.proc !== null && this.proc !== child;

    this.proc.on('close', (code) => {
      if (superseded()) return;
      this._isReady = false;
      this._turnOpen = false;
      this._engineCommand = undefined;
      this._failControls(`the Claude process exited (code ${code})`);
      this.removeAccountSettings();
      this.emit(SESSION_EVENT.CLOSE, code);
    });

    this.proc.on('error', (err) => {
      if (superseded()) return;
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
      this._emitError(err);
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
          // The CLI sends its first init with the first command, not at start.
          if (!this.stats.startTime) this.stats.startTime = new Date().toISOString();
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
          // The CLI sends an init ahead of every command, local ones included, so
          // only the first one is the session's start.
          if (!this.stats.startTime) this.stats.startTime = new Date().toISOString();
          const initModel = (event as Record<string, unknown>).model;
          if (typeof initModel === 'string' && initModel) this._engineModel = initModel;
          const pluginErrors = (event as Record<string, unknown>).plugin_errors;
          if (Array.isArray(pluginErrors) && pluginErrors.length > 0) {
            this.stats.pluginErrors = pluginErrors as Array<{ plugin: string; reason: string }>;
          }
          this._noteInitLists(event as Record<string, unknown>);
          this.emit(SESSION_EVENT.INIT, event);
        } else if (event.subtype === 'compact_boundary') {
          this._modelRanSinceResult = true;
          this._noteCompaction((event as Record<string, unknown>).compact_metadata);
        } else if (event.subtype === 'model_refusal_fallback') {
          // The model refused and the CLI re-ran the turn on another model.
          // The stream-json frame is snake_case; the in-process form camelCase.
          const e = event as Record<string, unknown>;
          const from = e.original_model ?? e.originalModel;
          const to = e.fallback_model ?? e.fallbackModel;
          const category = e.api_refusal_category ?? e.apiRefusalCategory;
          if (e.direction === 'retry' && typeof from === 'string' && typeof to === 'string') {
            this._refusalFallbacks++;
            this._lastRefusalFallback = { from, to, ...(typeof category === 'string' ? { category } : {}) };
          }
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
        } else if (innerType === 'content_block_delta') {
          // No tool_use handling on `content_block_start`: the same block arrives
          // again, with the same id and its full input, as an `assistant` event
          // (measured on 2.1.274). Reporting it from both counted every tool call
          // twice and sent ACP clients two tool_call updates, the first with no input.
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
        this._userEventsSinceResult++;
        // Tool results come back inside a user message, not as a top-level
        // `tool_result` event, so a failed tool is only visible here.
        if (Array.isArray(event.message?.content)) {
          for (const block of event.message.content as Array<Record<string, unknown>>) {
            if (block?.type === 'tool_result' && block.is_error === true) {
              this.stats.toolErrors++;
              this._fireHook('onToolError', { tool: block.tool_use_id, error: block.content });
            }
          }
        }
        this.emit(SESSION_EVENT.USER_ECHO, event);
        break;

      case 'assistant':
        if (this._ownModelMessage(event as Record<string, unknown>)) this._modelRanSinceResult = true;
        this.emit(SESSION_EVENT.ASSISTANT, event);
        this._noteRequestPrompt(event as Record<string, unknown>);
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

      case 'rate_limit_event': {
        const info = (event as Record<string, unknown>).rate_limit_info;
        this._noteRateLimit(info);
        if (info && typeof info === 'object') this._rateLimit = { info, at: new Date().toISOString() };
        this.emit(SESSION_EVENT.EVENT, event);
        break;
      }

      case 'control_response':
        this._settleControl((event as Record<string, unknown>).response);
        this.emit(SESSION_EVENT.EVENT, event);
        break;

      case 'command_lifecycle': {
        // One per command the CLI runs, queued → started → completed. A start
        // this session did not write is the CLI's own: a `/loop` tick or a
        // scheduled wakeup (`wakeup_source`, measured on 2.1.332).
        const e = event as Record<string, unknown>;
        const id = typeof e.command_uuid === 'string' ? e.command_uuid : undefined;
        if (e.state === 'started' && id) {
          const own = !e.wakeup_source && (this._written.has(id) || this._unanswered.has(id));
          this._engineCommand = own ? undefined : id;
        } else if (id && id === this._engineCommand && e.state !== 'queued') {
          this._engineCommand = undefined;
        }
        this.emit(SESSION_EVENT.EVENT, event);
        break;
      }

      case 'conversation_reset':
        // `/clear`: a new conversation, with none of the old one's messages to
        // rewind to and nothing of it in the context.
        this._turnMessages = [];
        this._lastTurnPromptTokens = 0;
        this._contextHighFired = false;
        this._context = undefined;
        this.emit(SESSION_EVENT.EVENT, event);
        break;

      case 'error':
        this._emitError(new Error(String((event as Record<string, unknown>).error) || JSON.stringify(event)));
        break;

      case 'result': {
        const e = event as Record<string, unknown>;
        this._resultCount++;
        // A command the CLI answered itself (`local_command`, `num_turns: 0`, all-zero
        // usage) is not a model turn, and neither is a compaction: the context keeps
        // the size the last turn (or the compaction) left, and `turnsSucceeded` does
        // not move. A forked skill such as /code-review is also reported as a local
        // command with zero usage, but ran a model and spent: that is a turn, whose
        // spend comes in `total_cost_usd`, though its context is the fork's, not this
        // conversation's.
        const local = typeof e.local_command === 'string' && e.local_command !== '' ? e.local_command : undefined;
        const notATurn = !!local && (local === 'compact' || !this._modelRanSinceResult);
        this._modelRanSinceResult = false;
        if (notATurn) {
          this._notTurns.add(event);
          this.stats.turns = Math.max(0, this.stats.turns - this._userEventsSinceResult);
        }
        this._userEventsSinceResult = 0;
        // An own turn ends here; a turn the CLI started itself says nothing of one
        // of this session's messages still waiting behind it.
        if (!this._engineCommand || this._unanswered.size === 0) this._turnOpen = false;
        const usage = e.usage as Record<string, number> | undefined;
        if (usage) this._applyTurnUsage(usage, true, !!local);
        // A turn the account refused: the CLI answers it itself (model `<synthetic>`)
        // with `api_error: usage_limit_reached` and HTTP 429 (measured on 2.1.322).
        if (e.api_error === 'usage_limit_reached') {
          this._turnUsage = { ...this._turnUsage, limited: true };
        }
        this._applyReportedCost(e.total_cost_usd);
        this._captureContextWindow(e.modelUsage);
        if (typeof e.fast_mode_state === 'string') this._fastModeState = e.fast_mode_state;
        const ids = this._resultIds(e);
        this._afterTurnFor(ids);
        if (notATurn && ids.length) this._turnMessages = this._turnMessages.filter((id) => !ids.includes(id));
        // A turn this session did not send ends with a result too: a background
        // workflow reporting back, a `/loop` tick, or a message from another session.
        // It answers no send, so it must not resolve the one waiting — which would
        // hand that caller the other turn's reply — nor count as that send's
        // success. Its usage and cost above are real and stay counted.
        const unsolicited = !this._answersOwnMessage(event);
        if (ids.length === 0) this._engineCommand = undefined;
        // The result event is the only place the outcome is known, and it arrives once
        // per send — unlike the `user` echo that drives `turns`, which the CLI also
        // emits per tool-result batch. `is_error` is read as truthy on purpose: for a
        // persistent `custom` engine this event comes from an arbitrary CLI.
        if (!unsolicited && !notATurn && !(event.is_error || event.stop_reason === 'error')) {
          this.stats.turnsSucceeded++;
        }
        this.emit(SESSION_EVENT.RESULT, event);
        if (unsolicited) this.emit(SESSION_EVENT.UNSOLICITED_RESULT, event);
        else this.emit(SESSION_EVENT.TURN_COMPLETE, event);
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
    // Read before anything changes, so a file that cannot be read fails the send
    // without starting a turn.
    const images = (options.images ?? []).map(imageBlock);
    if (options.model !== undefined) this._checkTurnModel(options.model);

    const requestId = ++this.currentRequestId;

    // A turn that died before its `result` leaves a partial baseline behind.
    // Clearing both here means the next turn measures from zero rather than
    // discounting itself by the abandoned turn's tokens.
    this._msgProvisional = { in: 0, out: 0, cacheRead: 0, cacheCreate: 0, cacheCreate1h: 0 };
    this._turnApplied = { in: 0, out: 0, cacheRead: 0, cacheCreate: 0, cacheCreate1h: 0 };
    this._turnRequestPromptTokens = 0;
    this._turnUsage = undefined;

    let finalMessage = typeof message === 'string' ? message : message;
    if (typeof finalMessage === 'string' && options.plan) {
      // The turn also runs in plan mode (`_applyTurnSettings`); the instruction
      // says what is wanted of it.
      finalMessage = `[Planning Mode] Analyze the request and create a detailed plan only. Do not write code or make changes yet.\n\n${finalMessage}`;
    }

    // The CLI echoes this id back on the result that answers the message
    // (`user_message_uuids`), which is how a result is matched to its send.
    const uuid = randomUUID();
    // Effort, model and plan mode for this turn go in before the message, and are
    // put back when its result arrives.
    // Awaited only when there is something to change, so a plain send writes its
    // message in the same tick it was called in.
    const restores = this._turnSettingsDiffer(options) ? await this._applyTurnSettings(options) : [];
    // Images go ahead of the text, as base64 content blocks: stream-json takes
    // the Messages API's content shape.
    const blocks = typeof finalMessage === 'string' ? [{ type: 'text', text: finalMessage }] : finalMessage;
    const payload = {
      type: 'user',
      uuid,
      message: { role: 'user', content: images.length ? [...images, ...blocks] : blocks },
    };

    const stdin = this.proc?.stdin;
    if (!stdin || stdin.writable === false) {
      for (const restore of restores) restore();
      throw new Error('Session stdin is not writable (process may have exited). Call start() first.');
    }
    if (restores.length) this._afterTurn.set(uuid, restores);
    this._unanswered.add(uuid);
    this._remember(uuid);
    this._turnMessages.push(uuid);
    // Pass an error callback so a broken pipe / closed stdin surfaces instead of
    // silently dropping the write and leaving waitForComplete callers hung.
    stdin.write(JSON.stringify(payload) + '\n', (err) => {
      if (err) this._emitError(new Error(`Failed to write to stdin: ${err.message}`));
    });
    this._turnOpen = true;

    if (options.callbacks) this._streamCallbacks = options.callbacks;

    if (options.waitForComplete) {
      this._isBusy = true;
      try {
        return await this._waitForTurnComplete(options.timeout || TURN_TIMEOUT_MS, uuid);
      } finally {
        this._isBusy = false;
        if (options.callbacks) this._streamCallbacks = null;
      }
    }

    return { requestId, sent: true };
  }

  /**
   * Write a user message into the stream without starting a send: the CLI folds
   * it into the turn in flight at its next tool round, or starts a turn with it
   * when none is running. Measured on 2.1.327 with a headless stream-json
   * session: a message written while a 35s tool call ran reached the model after
   * that call and before the next one, in the same turn. Unlike `send()`, it
   * leaves the turn's token accounting alone, and its id is registered so the
   * result that answers it is recognised as this session's own.
   */
  injectMessage(text: string): boolean {
    const stdin = this.proc?.stdin;
    if (!this._isReady || !stdin || stdin.writable === false) return false;
    const uuid = randomUUID();
    this._unanswered.add(uuid);
    this._remember(uuid);
    const payload = { type: 'user', uuid, message: { role: 'user', content: [{ type: 'text', text }] } };
    stdin.write(JSON.stringify(payload) + '\n', (err) => {
      if (err) this._emitError(new Error(`Failed to write to stdin: ${err.message}`));
    });
    return true;
  }

  /** Mid-turn delivery: only while a message of this session is still unanswered. */
  async deliverMidTurn(text: string): Promise<boolean> {
    if (!this._isBusy && this._unanswered.size === 0) return false;
    return this.injectMessage(text);
  }

  /**
   * Stop the running turn: stream-json's `interrupt` control request, the same
   * one the SDK sends. The CLI answers with a `control_response`, then ends the
   * turn with an `error_during_execution` result; an active `/goal` stays set.
   *
   * Not named `interrupt`: SessionManager reads a method of that name as the
   * mark of a codex-app session.
   */
  interruptTurn(): boolean {
    const stdin = this.proc?.stdin;
    if (!this._isReady || !stdin || stdin.writable === false) return false;
    const payload = {
      type: 'control_request',
      request_id: `interrupt-${randomUUID()}`,
      request: { subtype: 'interrupt' },
    };
    stdin.write(JSON.stringify(payload) + '\n', (err) => {
      if (err) this._emitError(new Error(`Failed to write to stdin: ${err.message}`));
    });
    return true;
  }

  // ─── Control requests ────────────────────────────────────────────────────

  /** Control subtypes this CLI answered "Unsupported control request subtype" to. */
  private _unsupportedControls = new Set<string>();

  /**
   * Send a stream-json control request and wait for its `control_response`.
   * Control requests are answered at once, between turns or during one, and
   * start no turn. Rejects with the CLI's error, on timeout, and when the
   * process ends.
   */
  private _control(
    subtype: string,
    fields: Record<string, unknown> = {},
    timeoutMs = CONTROL_TIMEOUT_MS,
  ): Promise<unknown> {
    const stdin = this.proc?.stdin;
    if (!this._isReady || !stdin || stdin.writable === false) {
      return Promise.reject(new Error(`the Claude process is not running (control request ${subtype})`));
    }
    if (this._unsupportedControls.has(subtype)) {
      return Promise.reject(new Error(`this Claude Code does not support the control request ${subtype}`));
    }
    const requestId = `clawo-${randomUUID()}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._controls.delete(requestId);
        reject(new Error(`control request ${subtype} got no answer in ${timeoutMs} ms`));
      }, timeoutMs);
      timer.unref?.();
      this._controls.set(requestId, {
        resolve,
        reject: (err) => {
          if (/unsupported control request subtype/i.test(err.message)) this._unsupportedControls.add(subtype);
          reject(err);
        },
        timer,
      });
      const payload = { type: 'control_request', request_id: requestId, request: { subtype, ...fields } };
      stdin.write(JSON.stringify(payload) + '\n', (err) => {
        if (err)
          this._settleControl({ subtype: 'error', request_id: requestId, error: `write failed: ${err.message}` });
      });
    });
  }

  /** A `control_response`: settle the request it answers. */
  private _settleControl(response: unknown): void {
    if (!response || typeof response !== 'object') return;
    const r = response as Record<string, unknown>;
    const pending = typeof r.request_id === 'string' ? this._controls.get(r.request_id) : undefined;
    if (!pending) return;
    this._controls.delete(r.request_id as string);
    clearTimeout(pending.timer);
    if (r.subtype === 'success') pending.resolve(r.response ?? null);
    else pending.reject(new Error(typeof r.error === 'string' && r.error ? r.error : 'the control request failed'));
  }

  private _failControls(reason: string): void {
    for (const [id, pending] of this._controls) {
      clearTimeout(pending.timer);
      this._controls.delete(id);
      pending.reject(new Error(reason));
    }
  }

  /** Run a control request whose answer is not waited for; a failure is logged. */
  private _controlInBackground(subtype: string, fields: Record<string, unknown>): void {
    this._control(subtype, fields).catch((err: Error) =>
      this.emit(SESSION_EVENT.LOG, `[claude] control request ${subtype} failed: ${err.message}`),
    );
  }

  /** Set the effort in the CLI's flag-settings layer (`null` clears it). */
  private async _setEffortSetting(value: string | null): Promise<void> {
    this._appliedEffort = value;
    try {
      await this._control('apply_flag_settings', { settings: { effortLevel: value } });
    } catch (err) {
      this._appliedEffort = undefined;
      throw err;
    }
  }

  /** Whether a send asks for an effort, model or plan mode the CLI does not have now. */
  private _turnSettingsDiffer(options: SessionSendOptions): boolean {
    const effort = options.effort !== undefined ? cliEffort(options.effort) : cliEffort(this.options.effort);
    if (effort !== this._appliedEffort) return true;
    if (
      options.model !== undefined &&
      (!this.options.model || this._cliModel(options.model) !== this._cliModel(this.options.model))
    ) {
      return true;
    }
    return !!options.plan && this._permissionMode !== 'plan';
  }

  /**
   * Put a send's effort, model and plan mode in place before its message is
   * written, and return what puts the session's own back after its turn.
   * Measured on 2.1.332: `apply_flag_settings {effortLevel}`, `set_model` and
   * `set_permission_mode` each answer in milliseconds and apply from the next
   * request, with no restart.
   */
  private async _applyTurnSettings(options: SessionSendOptions): Promise<Array<() => void>> {
    const restores: Array<() => void> = [];
    try {
      const sessionEffort = cliEffort(this.options.effort);
      const effort = options.effort !== undefined ? cliEffort(options.effort) : sessionEffort;
      if (effort !== this._appliedEffort) {
        try {
          await this._setEffortSetting(effort);
          if (effort !== sessionEffort) {
            restores.push(() => {
              const back = cliEffort(this.options.effort);
              this._appliedEffort = back;
              this._controlInBackground('apply_flag_settings', { settings: { effortLevel: back } });
            });
          }
        } catch (err) {
          // The turn still runs, at the effort the CLI has.
          this.emit(SESSION_EVENT.LOG, `[claude] effort ${effort ?? 'default'} not applied: ${(err as Error).message}`);
        }
      }
      if (options.model !== undefined) {
        const model = this._cliModel(options.model);
        if (!this.options.model || model !== this._cliModel(this.options.model)) {
          // No fallback: the answer of the session's own model would read as this one's.
          await this._control('set_model', { model });
          restores.push(() =>
            this._controlInBackground('set_model', {
              model: this.options.model ? this._cliModel(this.options.model) : 'default',
            }),
          );
        }
      }
      if (options.plan && this._permissionMode !== 'plan') {
        try {
          await this._control('set_permission_mode', { mode: 'plan' });
          restores.push(() => this._controlInBackground('set_permission_mode', { mode: this._permissionMode }));
        } catch (err) {
          this.emit(SESSION_EVENT.LOG, `[claude] plan mode not applied: ${(err as Error).message}`);
        }
      }
    } catch (err) {
      for (const restore of restores) restore();
      throw err;
    }
    return restores;
  }

  /** Run what a send changed for its turn, now that the turn has ended. */
  private _afterTurnFor(ids: string[]): void {
    for (const id of ids) {
      const restores = this._afterTurn.get(id);
      if (!restores) continue;
      this._afterTurn.delete(id);
      for (const restore of restores) restore();
    }
  }

  /** Remember a message id this session wrote, so the CLI's command for it is known as this session's. */
  private _remember(id: string): void {
    this._written.add(id);
    if (this._written.size > WRITTEN_IDS_KEPT) {
      const oldest = this._written.values().next().value;
      if (oldest !== undefined) this._written.delete(oldest);
    }
  }

  /** The model as `--model` and `set_model` take it. */
  private _cliModel(model: string): string {
    return model.includes('/') && !claudeGatewayMode() ? model.split('/').pop()! : model;
  }

  /** Refuse, before anything is written, a model this session cannot run one turn on. */
  private _checkTurnModel(model: string): void {
    if (this._realModel) {
      throw new Error("a model per send is not supported on a claude session that runs another provider's model");
    }
    if (!isClaudeModel(model) && !claudeGatewayMode()) {
      throw new Error(`a model per send on a claude session must be a Claude model (got ${model})`);
    }
  }

  /**
   * The tools auto-approved at spawn. With ultracode on, the Workflow tool its
   * workflows run through is one of them, unless the caller denied it: under the
   * default spawn (no permission prompts) it is otherwise refused on every call,
   * and no workflow runs. Not in plan mode, which is a promise of no changes.
   */
  private _allowedTools(): string[] {
    const allowed = [...(this.options.allowedTools ?? [])];
    if (
      this.options.ultracode &&
      this._permissionMode !== 'plan' &&
      !allowed.includes('Workflow') &&
      !(this.options.disallowedTools ?? []).includes('Workflow')
    ) {
      allowed.push('Workflow');
    }
    return allowed;
  }

  /**
   * An assistant message a model wrote for the command in flight: in this
   * conversation, or in the agent a forked command such as /code-review runs
   * (`parent_tool_use_id: 'forked-command-<name>'`, measured on 2.1.332); not a
   * background agent's.
   */
  private _ownModelMessage(e: Record<string, unknown>): boolean {
    const model = (e.message as Record<string, unknown> | undefined)?.model;
    if (model === '<synthetic>') return false;
    const parent = e.parent_tool_use_id;
    return !parent || (typeof parent === 'string' && parent.startsWith('forked-command'));
  }

  /** The command lists of a `system/init`; a change (a skill reloaded) drops the cached command list. */
  private _noteInitLists(e: Record<string, unknown>): void {
    const strings = (v: unknown): string[] | undefined =>
      Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : undefined;
    const next: ClaudeInitLists = {
      slashCommands: strings(e.slash_commands),
      skills: strings(e.skills),
      terminalCommands: strings(e.terminal_slash_commands),
    };
    if (JSON.stringify(next) !== JSON.stringify(this._initLists)) {
      this._initLists = next;
      this._commands = undefined;
    }
    if (typeof e.fast_mode_state === 'string') this._fastModeState = e.fast_mode_state;
  }

  /**
   * A compaction the CLI reports (`system/compact_boundary`), manual or one it
   * ran itself inside a turn. The context is what it kept, until the next request.
   */
  private _noteCompaction(meta: unknown): void {
    const m = meta && typeof meta === 'object' ? (meta as Record<string, unknown>) : {};
    const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
    const pre = num(m.pre_tokens);
    const post = num(m.post_tokens);
    this._compactions++;
    this._lastCompaction = {
      ...(pre !== undefined ? { preTokens: pre } : {}),
      ...(post !== undefined ? { postTokens: post } : {}),
      trigger: m.trigger === 'auto' ? 'auto' : 'manual',
    };
    if (post !== undefined) {
      this._lastTurnPromptTokens = post;
      this._contextHighFired = false;
    }
    this._context = undefined;
  }

  // ─── Capabilities ────────────────────────────────────────────────────────

  /**
   * The session's commands: the CLI's slash commands, skills and custom
   * commands, from the `initialize` control request (the names in
   * `system/init` when it fails), and clawo's control commands.
   */
  async listCommands(): Promise<EngineCommand[]> {
    return (await this._commandListing()).list;
  }

  private _commandListing(): Promise<{ list: EngineCommand[]; names: Set<string>; complete: boolean }> {
    if (!this._commands) {
      const lists = { ...this._initLists };
      const listing = this._control('initialize').then(
        (r) => ({ list: claudeCommandList(r, lists), names: claudeCommandNames(r, lists), complete: true }),
        () => ({
          list: claudeCommandList(undefined, lists),
          names: claudeCommandNames(undefined, lists),
          complete: !!lists.slashCommands?.length,
        }),
      );
      // A list with none of the CLI's commands in it is not kept, so the next call asks again.
      this._commands = listing.then((l) => {
        if (!l.complete) this._commands = undefined;
        return l;
      });
    }
    return this._commands;
  }

  /**
   * Refuse a name the CLI has no command for: sent as `/name` it reaches the
   * model as a message, a paid turn (measured on 2.1.332). Asked again once
   * before refusing, for a command added since the list was read.
   */
  private async _checkCommandKnown(name: string): Promise<void> {
    let listing = await this._commandListing();
    if (!listing.complete || listing.names.has(name)) return;
    this._commands = undefined;
    listing = await this._commandListing();
    if (listing.complete && !listing.names.has(name)) {
      throw new Error(`there is no command /${name} on this claude session (session_command list shows what there is)`);
    }
  }

  /**
   * Run a command: one of clawo's control commands as its control request, any
   * other as the message `/name args`. Commands that write a settings file of
   * the user's are refused.
   */
  async runCommand(
    name: string,
    args?: string,
    opts: { timeout?: number; callbacks?: StreamCallbacks } = {},
  ): Promise<CommandOutcome> {
    const control = CLAUDE_CONTROL_COMMANDS[name];
    if (control) {
      const { subtype, ...fields } = control.request(args);
      try {
        const response = await this._control(subtype, fields, opts.timeout ?? CONTROL_TIMEOUT_MS);
        const { text, data } = control.render(response);
        return { name, ok: true, text, ...(data !== undefined ? { data } : {}), startedTurn: false };
      } catch (err) {
        return { name, ok: false, text: '', startedTurn: false, error: (err as Error).message };
      }
    }
    const refused = CLAUDE_REFUSED_COMMANDS[name];
    if (refused && (!refused.withArgsOnly || args)) throw new Error(refused.why);
    if (this.options.disableSlashCommands) {
      throw new Error(
        `/${name} cannot run: the session was started with disableSlashCommands, so it would reach the model as text`,
      );
    }
    await this._checkCommandKnown(name);
    const result = (await this.send(`/${name}${args ? ` ${args}` : ''}`, {
      waitForComplete: true,
      timeout: opts.timeout ?? TURN_TIMEOUT_MS,
      ...(opts.callbacks ? { callbacks: opts.callbacks } : {}),
    })) as TurnResult;
    const e = result.event as Record<string, unknown>;
    const failed = !!(e.is_error || e.stop_reason === 'error' || e.stop_reason === 'process_exit');
    return {
      name,
      ok: !failed,
      text: result.text,
      startedTurn: !result.localCommand,
      ...(failed ? { error: result.text || `/${name} failed` } : {}),
    };
  }

  /**
   * `/compact`, waited for, with the sizes the CLI reports before and after
   * (`system/compact_boundary`). Not ok when no compaction was reported — the
   * CLI answers a conversation too short to compact with a message instead.
   */
  async compactDetailed(summary?: string): Promise<CompactOutcome> {
    const before = this._compactions;
    const result = (await this.compact(summary)) as TurnResult;
    const e = result.event as Record<string, unknown>;
    const failed = !!(e.is_error || e.stop_reason === 'error' || e.stop_reason === 'process_exit');
    const boundary = this._compactions > before ? this._lastCompaction : undefined;
    if (!boundary) {
      return { ok: false, trigger: 'manual', note: result.text || 'the CLI reported no compaction' };
    }
    return { ok: !failed, ...boundary, ...(failed && result.text ? { note: result.text } : {}) };
  }

  /**
   * A question answered from the conversation's context without adding to it
   * (control request `side_question`, the headless /btw). It can run while a
   * turn does; what it spends is in the next result's running cost.
   */
  async askAside(question: string, opts: { timeout?: number } = {}): Promise<AsideOutcome> {
    const r = await this._control('side_question', { question }, opts.timeout ?? TURN_TIMEOUT_MS);
    const text = r && typeof r === 'object' ? (r as Record<string, unknown>).response : undefined;
    if (typeof text !== 'string') throw new Error('the side question got no answer');
    return { text };
  }

  /**
   * Rewind the conversation to before one of this session's messages (control
   * request `rewind_conversation`), by turns or by the message's id; with
   * `files`, also put back the files changed since (`rewind_files`, from the
   * file checkpoints the session keeps). Files are checked before anything
   * changes, and restored only once the conversation is rewound.
   */
  async rewind(target: RewindTarget): Promise<RewindOutcome> {
    let index: number;
    if (target.messageId !== undefined) index = this._turnMessages.indexOf(target.messageId);
    else {
      const turns = target.turns ?? 0;
      if (turns > this._turnMessages.length) {
        throw new Error(
          `only ${this._turnMessages.length} turn(s) of this conversation can be rewound from this session`,
        );
      }
      index = this._turnMessages.length - turns;
    }
    const messageId = target.messageId ?? this._turnMessages[index];
    const asRecord = (v: unknown) => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});
    if (target.files) {
      const dry = asRecord(await this._control('rewind_files', { user_message_id: messageId, dry_run: true }));
      if (dry.canRewind !== true) {
        throw new Error(`the files cannot be restored: ${String(dry.error ?? 'no checkpoint for that message')}`);
      }
    }
    const conv = asRecord(await this._control('rewind_conversation', { target_message_uuid: messageId }));
    if (conv.rewound !== true) {
      return { ok: false, note: String(conv.error ?? conv.reason ?? 'the conversation was not rewound') };
    }
    let filesRestored = false;
    let note: string | undefined;
    if (target.files) {
      try {
        const files = asRecord(await this._control('rewind_files', { user_message_id: messageId }));
        filesRestored = files.canRewind === true && files.error === undefined;
        if (!filesRestored) note = `the conversation was rewound, the files were not: ${String(files.error ?? '')}`;
      } catch (err) {
        note = `the conversation was rewound, the files were not: ${(err as Error).message}`;
      }
    }
    const removed = index >= 0 ? this._turnMessages.length - index : undefined;
    if (index >= 0) this._turnMessages = this._turnMessages.slice(0, index);
    this._context = undefined;
    // The context is what is left, not what the last turn carried.
    const left = await this.contextBreakdown().catch(() => undefined);
    if (left) this._lastTurnPromptTokens = left.totalTokens;
    return {
      ok: true,
      ...(removed !== undefined ? { turnsRemoved: removed } : {}),
      filesRestored,
      ...(note ? { note } : {}),
    };
  }

  /**
   * Switch the model in place (`set_model`): no restart, no MCP or plugin reload.
   * A model of another provider, which runs through the proxy, takes a restart.
   */
  async setModelLive(model: string): Promise<boolean> {
    if (this._realModel || (!isClaudeModel(model) && !claudeGatewayMode())) return false;
    const r = await this._control('set_model', { model: this._cliModel(model) });
    this.options.model = model;
    this.options.resolvedModel = model;
    const reported = r && typeof r === 'object' ? (r as Record<string, unknown>).model : undefined;
    if (typeof reported === 'string' && reported) this._engineModel = reported;
    this._engineContextWindow = null;
    return true;
  }

  /** Switch the effort in place (`apply_flag_settings {effortLevel}`), keeping the prompt cache. */
  async setEffortLive(level: EffortLevel): Promise<boolean> {
    try {
      await this._setEffortSetting(cliEffort(level));
      return true;
    } catch (err) {
      this.emit(SESSION_EVENT.LOG, `[claude] effort not switched in place: ${(err as Error).message}`);
      return false;
    }
  }

  /** The context by category (`get_context_usage`), read once per result. */
  async contextBreakdown(): Promise<ContextBreakdown | undefined> {
    if (!this._isReady) return undefined;
    if (this._context && this._context.at === this._resultCount) return this._context.value;
    const value = contextFromUsage(await this._control('get_context_usage'));
    this._context = { at: this._resultCount, value };
    return value;
  }

  /**
   * The account's quota: the windows the last `rate_limit_event` reported (one
   * comes with every turn), or, before the first turn, `get_usage` — which has
   * them only for a claude.ai login with the profile scope.
   */
  async readQuota(): Promise<EngineQuota | undefined> {
    if (this._rateLimit) {
      const q = quotaFromRateLimit(this._rateLimit.info, this._rateLimit.at);
      if (q) return q;
    }
    if (!this._isReady) return undefined;
    const usage = await this._control('get_usage').catch(() => undefined);
    return usage === undefined ? undefined : quotaFromUsage(usage, new Date().toISOString());
  }

  // ─── Wait for Turn Complete ──────────────────────────────────────────────

  /**
   * Whether a result answers a message this session wrote.
   *
   * Measured on 2.1.274: a result carries the ids of the messages it answers in
   * `user_message_uuids`, and a turn the CLI started on its own (a finished
   * background workflow, `origin: {kind: 'task-notification'}`) carries none. The
   * ids decide when present — including a message the CLI folds into a turn it
   * started itself. Without them, which is what an older CLI or a custom engine
   * emits, a non-human `origin` is a sign of a turn nobody sent; so is a command
   * the CLI started itself (`_engineCommand`): on 2.1.332 a `/loop` tick or a
   * scheduled wakeup ends in a result with neither ids nor an origin.
   */
  private _answersOwnMessage(event: StreamEvent): boolean {
    const ids = this._resultIds(event as Record<string, unknown>);
    if (ids.length > 0) {
      let own = false;
      for (const id of ids) own = this._unanswered.delete(id) || own;
      return own;
    }
    if (this._engineCommand) return false;
    const origin = (event as Record<string, unknown>).origin as { kind?: unknown } | undefined;
    return !origin || origin.kind === 'human';
  }

  /** The ids of the messages a result answers. */
  private _resultIds(e: Record<string, unknown>): string[] {
    return Array.isArray(e.user_message_uuids)
      ? e.user_message_uuids.filter((id): id is string => typeof id === 'string')
      : typeof e.user_message_uuid === 'string'
        ? [e.user_message_uuid]
        : [];
  }

  private _waitForTurnComplete(timeout: number, uuid: string): Promise<TurnResult> {
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

      // Text and tools streamed before a turn this send did not start are that
      // turn's, not this reply's fallback.
      const onUnsolicited = () => {
        streamedText = '';
        allAssistantText = '';
        toolNames.length = 0;
      };

      // No longer waiting, so a result that arrives for it later is not this
      // session's to hand to the next send; what the send changed for its turn
      // is put back now, as its result would have.
      const abandon = () => {
        this._unanswered.delete(uuid);
        this._afterTurnFor([uuid]);
      };
      this.on(SESSION_EVENT.UNSOLICITED_RESULT, onUnsolicited);

      const cleanup = () => {
        clearTimeout(timer);
        this.removeListener(SESSION_EVENT.TEXT, onText);
        this.removeListener(SESSION_EVENT.ASSISTANT, onAssistant);
        this.removeListener(SESSION_EVENT.TOOL_USE, onToolUse);
        this.removeListener(SESSION_EVENT.UNSOLICITED_RESULT, onUnsolicited);
        this.removeListener(SESSION_EVENT.TURN_COMPLETE, onTurnComplete);
        this.removeListener(SESSION_EVENT.ERROR, onError);
        this.removeListener(SESSION_EVENT.CLOSE, onClose);
      };

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        abandon();
        reject(new Error('Timeout waiting for response'));
      }, timeout);

      const onTurnComplete = (event: StreamEvent) => {
        if (settled) return;
        // The answer to another message this session wrote — one sent without
        // waiting, such as an inbox delivery — is not this send's reply.
        const e = event as Record<string, unknown>;
        const ids = Array.isArray(e.user_message_uuids)
          ? e.user_message_uuids
          : typeof e.user_message_uuid === 'string'
            ? [e.user_message_uuid]
            : [];
        if (ids.length > 0 && !ids.includes(uuid)) {
          onUnsolicited();
          return;
        }
        settled = true;
        cleanup();
        let text =
          ((event as Record<string, unknown>).result as string) || streamedText || allAssistantText.trim() || '';
        if (!text && toolNames.length > 0) {
          const unique = [...new Set(toolNames)];
          text = `[Agent completed ${toolNames.length} tool calls: ${unique.join(', ')}]`;
        }
        resolve(this._notTurns.has(event) ? { text, event, localCommand: true } : { text, event });
      };

      const onError = (err: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        abandon();
        reject(err);
      };

      const onClose = (code: number) => {
        if (settled) return;
        settled = true;
        cleanup();
        abandon();
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

      this.on(SESSION_EVENT.TURN_COMPLETE, onTurnComplete);
      this.once(SESSION_EVENT.ERROR, onError);
      this.once(SESSION_EVENT.CLOSE, onClose);
    });
  }

  // ─── Utilities ───────────────────────────────────────────────────────────

  getStats(): SessionStats & {
    sessionId?: string;
    uptime: number;
    cacheCreationTokens: number;
    /** Fast mode as the CLI last reported it (`on`, `off`, `cooldown`). */
    fastModeState?: string;
    /** Compactions the CLI reported, manual and its own. */
    compactions?: number;
  } {
    return {
      turns: this.stats.turns,
      turnsSucceeded: this.stats.turnsSucceeded,
      toolCalls: this.stats.toolCalls,
      toolErrors: this.stats.toolErrors,
      tokensIn: this.stats.tokensIn,
      tokensOut: this.stats.tokensOut,
      cachedTokens: this.stats.cachedTokens,
      // Not in SessionStats: only the goal adapter reads it, to count a goal's
      // tokens without the cached conversation every turn re-reads.
      cacheCreationTokens: this.stats.cacheCreationTokens,
      costUsd: Math.round(this.stats.costUsd * 10000) / 10000,
      isReady: this._isReady,
      startTime: this.stats.startTime,
      lastActivity: this.stats.lastActivity,
      // Approximate context window utilization based on model's known window size.
      contextPercent: this._contextPercent(),
      retries: this.stats.retries,
      lastRetryError: this.stats.lastRetryError,
      ...(this._refusalFallbacks > 0
        ? { refusalFallbacks: this._refusalFallbacks, lastRefusalFallback: this._lastRefusalFallback }
        : {}),
      ...(this._fastModeState ? { fastModeState: this._fastModeState } : {}),
      ...(this._compactions > 0 ? { compactions: this._compactions } : {}),
      sessionId: this.sessionId,
      uptime: this.stats.startTime ? Math.round((Date.now() - new Date(this.stats.startTime).getTime()) / 1000) : 0,
    };
  }

  getHistory(limit = DEFAULT_HISTORY_LIMIT): Array<{ time: string; type: string; event: unknown }> {
    return this.stats.history.slice(-limit);
  }

  async compact(summary?: string): Promise<TurnResult | { requestId: number; sent: boolean }> {
    // With slash commands off the CLI takes `/compact` as plain text: a model
    // turn, and nothing compacted.
    if (this.options.disableSlashCommands) {
      throw new Error(
        'cannot compact: the session was started with disableSlashCommands, so /compact would reach the model as text',
      );
    }
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
    // A model the caller named explicitly wins over what init reports. An alias
    // (`opus`, `opus[1m]`) is different: what it means is the CLI's decision —
    // the alias has moved under us five times — so the id init reports wins.
    const configured = this.options.model;
    const bare = configured?.replace(/\[1m\]$/i, '');
    const isAlias = !!bare && resolveAlias(bare) !== bare;
    const model = (isAlias ? this._engineModel : undefined) || configured || this._engineModel;
    const pricing = this._pricing(model);
    const nonCachedIn = Math.max(0, this.stats.tokensIn - this.stats.cachedTokens);
    return {
      model: model || 'default',
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
    this._endProcess();
    this._isPaused = false;
    this.emit(SESSION_EVENT.CLOSE, 143);
  }

  /**
   * Continue this conversation under another Claude account.
   *
   * The CLI reads its credential once, at start, so the process is restarted:
   * same session id via `--resume`, new credential, never `--fork-session` (a
   * fork would start a new conversation). Statistics and spend carry over; the
   * cost baseline handles the resumed process reporting the session's totals.
   */
  async switchAccount(env: Record<string, string>): Promise<void> {
    const id = this.sessionId;
    if (!id) throw new Error('This session has no conversation id to continue under another account');
    this._endProcess();
    this.options.resumeSessionId = id;
    delete this.options.claudeResumeId;
    this.options.forkSession = false;
    this.setAccountEnv(env);
    await this.start();
  }

  /** End the CLI process and drop its credential file; the session object stays usable. */
  private _endProcess(): void {
    this.removeAccountSettings();
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
    this._turnOpen = false;
    this._engineCommand = undefined;
    this._failControls('the Claude process was stopped');
    this._afterTurn.clear();
    this._commands = undefined;
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
  private _applyTurnUsage(usage: Record<string, unknown>, authoritative: boolean, keepContext = false): void {
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
      // `result.usage` sums every request of the turn — one per tool round — so
      // it is the turn's spend, not the context's size. The context is the prompt
      // of the turn's last request; the summed figure stands in only when no
      // request reported its own usage. A command the CLI answered itself
      // (`keepContext`) reports no request of this conversation's: the context
      // stays what the last turn left.
      if (!keepContext) {
        this._lastTurnPromptTokens =
          this._turnRequestPromptTokens > 0
            ? this._turnRequestPromptTokens
            : reported.in + reported.cacheRead + reported.cacheCreate;
      }
      this._turnRequestPromptTokens = 0;
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
   * Remember the prompt size of one API request of the current turn.
   *
   * Every `assistant` event carries its request's usage, and the input side of
   * it is fixed for the whole request. A subagent's requests arrive here too,
   * marked with `parent_tool_use_id`; they measure the subagent's own context,
   * so they are skipped.
   */
  private _noteRequestPrompt(event: Record<string, unknown>): void {
    if (event.parent_tool_use_id) return;
    const usage = (event.message as Record<string, unknown> | undefined)?.usage as Record<string, unknown> | undefined;
    if (!usage) return;
    const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    const prompt =
      num(usage.input_tokens) + num(usage.cache_read_input_tokens) + num(usage.cache_creation_input_tokens);
    if (prompt > 0) this._turnRequestPromptTokens = prompt;
  }

  /**
   * Read a `rate_limit_event`: whether the account refused the turn, its highest
   * window utilization, and when the window that limits it resets. The CLI emits
   * one per turn, `status: allowed` with each window's utilization, or
   * `rejected` once a limit is reached.
   */
  private _noteRateLimit(info: unknown): void {
    if (!info || typeof info !== 'object') return;
    const i = info as Record<string, unknown>;
    let utilization: number | undefined;
    const windows = i.unifiedWindows;
    if (windows && typeof windows === 'object') {
      for (const w of Object.values(windows as Record<string, unknown>)) {
        const u = (w as Record<string, unknown> | null)?.utilization;
        if (typeof u === 'number' && Number.isFinite(u)) utilization = Math.max(utilization ?? 0, u);
      }
    }
    const resetsAt = typeof i.resetsAt === 'number' && i.resetsAt > 0 ? i.resetsAt * 1000 : undefined;
    this._turnUsage = {
      limited: i.status === 'rejected' || !!this._turnUsage?.limited,
      ...(utilization !== undefined ? { utilization } : {}),
      ...(resetsAt !== undefined ? { resetsAt } : {}),
    };
  }

  /**
   * Take the engine's own spend figure when it offers one.
   *
   * `total_cost_usd` is cache-aware in a way the registry formula is not: on a
   * turn with 31,435 one-hour cache writes the CLI reported $0.322428 while the
   * formula produced $0.016 — a 20x under-report, on the number `maxBudgetUsd`
   * gates against. It is also the session running total rather than the turn's
   * cost, so spend advances by the difference.
   *
   * What that total covers changed in Claude Code 2.1.277: a headless process
   * started with `--resume` used to begin at zero, and now restores the totals
   * the resumed session saved at exit. Measured on 2.1.278 — a turn reporting
   * $0.363044, resumed in a new process, reported $0.386463 for a turn whose
   * own usage was $0.023419. Reading that first figure as this process's spend
   * charges the whole history again, on every model switch and every session
   * recovery, and `maxBudgetUsd` then trips against a number the session never
   * spent. So a resumed process's first report is taken as a baseline, and the
   * turn carrying it keeps the registry estimate `_applyTurnUsage` already
   * computed: that is off by the cache-write premium for one turn, where the
   * alternative is off by everything the session spent before this process.
   */
  private _applyReportedCost(reported: unknown): void {
    if (typeof reported !== 'number' || !Number.isFinite(reported) || reported < 0) return;
    // In proxy mode the CLI is pointed at another provider's model while being
    // told it is running `opus`, so the figure it computes is Opus list price
    // for someone else's tokens. Fall back to the registry, which at least
    // knows which model was really asked for.
    if (this._realModel) return;
    // A gateway's own model: the CLI prices its tokens from Anthropic's table,
    // which does not know it. The registry or pricingOverrides decide instead.
    if (this._onGatewayModel()) return;
    const previous = this._lastReportedCost;
    if (this._costBaselinePending) {
      this._costBaselinePending = false;
      // Only the first report of the resumed process is ambiguous. A later
      // respawn already has a figure to subtract, so its difference is this
      // turn's cost and needs no special case.
      if (previous === null) {
        this._lastReportedCost = reported;
        this._engineCostUsd = this.stats.costUsd;
        return;
      }
    }
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

  /** A non-Claude model served by the caller's own gateway (`CLAWO_CLAUDE_GATEWAY`). */
  private _onGatewayModel(model = this.options.model): boolean {
    return !!model && claudeGatewayMode() && !isClaudeModel(model);
  }

  private _pricing(model: string | undefined) {
    return model && this._onGatewayModel(model) ? gatewayModelPricing(model) : getModelPricing(model);
  }

  private _updateCost(): void {
    // Only reached when the engine did not report its own spend — a custom CLI
    // driven through this class, or a turn that ended before `result`.
    if (this._lastReportedCost !== null) return;
    const pricing = this._pricing(this.options.model);
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

// The quota of the Claude account a live session runs under.
registerQuotaReader('claude', async ({ session }) =>
  session instanceof PersistentClaudeSession ? session.readQuota() : undefined,
);
