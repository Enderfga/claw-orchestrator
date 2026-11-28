/**
 * Persistent Codex App-Server Session — wraps `codex app-server`
 *
 * Unlike `PersistentCodexSession` (which spawns `codex exec` per send), this
 * session keeps a long-running `codex app-server --listen stdio://` subprocess
 * and speaks Codex's v2 JSON-RPC 2.0 protocol over its stdin/stdout.
 *
 * The motivation is the `/goal` long-horizon objective system, which is
 * exclusively available through the app-server protocol — `codex exec` has no
 * access to it. Goals are stable and on by default since 0.172; `--enable goals`
 * is still passed for older builds, where the flag was off by default.
 *
 * Protocol notes (verified against codex-cli 0.164.0; thread options, turn
 * inputs, revert and thread listing against 0.171.0; sub-agents, compaction,
 * review, plan mode, side questions and live settings against 0.172.0):
 *   - Frames are line-delimited JSON-RPC 2.0 messages over stdio.
 *   - Lifecycle: `initialize` → `thread/start` (or `thread/resume`) →
 *     `turn/start` (per send). `initialize` declares `experimentalApi`, which
 *     plan mode, `thread/sample`, `thread/settings/update`, memories and the
 *     background-terminal RPCs need.
 *   - One app-server carries the session's thread and the threads of its
 *     sub-agents (multi-agent is on by default). Every notification names its
 *     thread; a sub-agent's item, usage and `turn/completed` arrive with the
 *     sub-agent's thread id, often before the parent's turn ends. Only this
 *     thread's notifications reach the turn; each thread's usage is summed.
 *   - A turn ends with `turn/completed` for its own id. A review's reviewer
 *     runs an inner turn whose `rootTurnId` is the review turn, and only the
 *     review turn completes.
 *   - Goals are typed RPCs: `thread/goal/set` (objective, status, tokenBudget),
 *     `thread/goal/get`, `thread/goal/clear`. Setting an objective starts the
 *     server's own turn loop, which runs until the goal leaves `active`; each
 *     change arrives as `thread/goal/updated`. A thread resumed with an active
 *     goal continues on its own.
 *   - `error` notifications carry `{ error: { message, codexErrorInfo },
 *     willRetry }`; `codexErrorInfo` names the failure (`serverOverloaded`,
 *     `usageLimitExceeded`, …) so callers need not match message text.
 *   - Slash text is not a command here: `turn/start` hands `/status` to the
 *     model. Commands are RPCs (`runCommand`, `codex-commands.ts`).
 */

import { ChildProcess } from 'node:child_process';
import { killEngineTree, signalEngineGroup, spawnEngine, STOPPED_ENGINE_GRACE_MS } from './engine-spawn.js';
import { EventEmitter } from 'node:events';
import * as readline from 'node:readline';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type {
  SessionConfig,
  SessionStats,
  EffortLevel,
  GeneratedImage,
  StreamEvent,
  ISession,
  SessionSendOptions,
  TurnResult,
  CostBreakdown,
  EngineCommand,
  CommandOutcome,
  CompactOutcome,
  RewindTarget,
  RewindOutcome,
  AsideOutcome,
  ContextBreakdown,
  StreamCallbacks,
} from './types.js';
import { getModelPricing, resolveAlias, getContextWindow } from './models.js';
import { SESSION_EVENT, MAX_HISTORY_ITEMS, DEFAULT_HISTORY_LIMIT, TURN_TIMEOUT_MS } from './constants.js';
import { sanitizeSecrets } from './sanitize.js';
import { codexReasoningEffort } from './persistent-codex-session.js';
import { codexConfigObject, codexFeatureArgs } from './codex-config.js';
import { codexInitializeParams, type CodexRpc } from './codex-app-client.js';
import {
  CODEX_INIT_PROMPT,
  CODEX_LISTED_SOURCE_KINDS,
  codexBuiltinCommands,
  codexSandboxPolicy,
  codexReviewTarget,
  codexSkillCommands,
  codexTurnCommand,
  latestCodexTurnId,
  listCodexSkills,
  revertCodexTurns,
  runCodexInfoCommand,
  unknownCodexCommand,
  type CodexSkill,
} from './codex-commands.js';
import { codexSessionsRoot, findCodexRollout, reviewRolloutUsage } from './codex-rollout.js';

// ─── Hand-translated protocol types (subset we use) ────────────────────────
//
// Mirrors `codex app-server generate-ts` output. Kept inline because we only
// touch a small slice; if upstream churn becomes painful, swap in the full
// generated bindings under `src/generated/codex-app/`.

type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
export type ThreadGoalStatus = 'active' | 'paused' | 'blocked' | 'usageLimited' | 'budgetLimited' | 'complete';

export interface ThreadGoal {
  threadId: string;
  objective: string;
  status: ThreadGoalStatus;
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAt: number;
  updatedAt: number;
}

/** The last `error` notification, with the server's own classification. */
export interface CodexAppError {
  message: string;
  /** `codexErrorInfo` as a name: a string variant, or the key of an object variant. */
  code: string | null;
  /** True when the server itself will retry the request. */
  willRetry: boolean;
  at: string;
}

/** Name of a `CodexErrorInfo` value: `'serverOverloaded'`, or `'httpConnectionFailed'` for `{ httpConnectionFailed: … }`. */
function errorInfoName(info: unknown): string | null {
  if (typeof info === 'string') return info;
  if (info && typeof info === 'object') return Object.keys(info)[0] ?? null;
  return null;
}

interface ThreadGoalUpdatedNotification {
  goal: ThreadGoal;
  threadId: string;
  turnId?: string | null;
}

interface ThreadStartedNotification {
  thread: { id: string; cwd?: string; status?: string };
}

interface TokenUsageBreakdown {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

interface ThreadTokenUsageUpdatedNotification {
  threadId: string;
  turnId: string;
  tokenUsage: { total: TokenUsageBreakdown; last: TokenUsageBreakdown; modelContextWindow?: number | null };
}

interface ItemCompletedNotification {
  threadId: string;
  turnId: string;
  item: {
    type: string;
    id?: string;
    text?: string;
    /** agentMessage: `commentary`, `partial_answer` or `final_answer`; null when the model does not say. */
    phase?: string | null;
    /** commandExecution: the command's exit code. */
    exitCode?: number | null;
    /** commandExecution: `userShell` for `thread/shellCommand`, which is no model tool call. */
    source?: string | null;
    aggregatedOutput?: string | null;
    savedPath?: string | null;
    revisedPrompt?: string | null;
    /** exitedReviewMode: the review's text. */
    review?: string | null;
    /** subAgentActivity: `started` or `completed`, the sub-agent's thread, path and model. */
    kind?: string | null;
    agentThreadId?: string | null;
    agentPath?: string | null;
    model?: string | null;
  };
}

/** The app-server's `SandboxPolicy`, as `thread/start` reports it and `turn/start` takes it. */
interface SandboxPolicy {
  type: string;
  writableRoots?: string[];
  [key: string]: unknown;
}

/**
 * `item/completed` types that are not tool calls: messages, reasoning, the
 * plan, and markers. Everything else (commandExecution, fileChange,
 * mcpToolCall, webSearch, imageGeneration, …) is counted, so a tool type a
 * later codex adds is counted rather than missed.
 */
const NON_TOOL_ITEMS = new Set([
  'userMessage',
  'hookPrompt',
  'agentMessage',
  'plan',
  'reasoning',
  'contextCompaction',
  'enteredReviewMode',
  'exitedReviewMode',
  'subAgentActivity',
]);

/**
 * Every source a thread can have that a person or a client started. Without
 * `sourceKinds`, `thread/list` returns interactive threads only, leaving out
 * the ones `codex exec` started (0.171.0).
 */
const LISTED_SOURCE_KINDS = CODEX_LISTED_SOURCE_KINDS;

interface AgentMessageDeltaNotification {
  threadId: string;
  turnId: string;
  itemId?: string;
  delta?: string;
}

interface TurnCompletedNotification {
  threadId: string;
  turn: {
    id: string;
    /** The turn a chain of work began with; an inner turn (a review's reviewer) names the turn it serves. */
    rootTurnId?: string | null;
    status: string;
    /** Set on a failed or interrupted turn: the same shape as an `error` notification's. */
    error?: { message?: string; codexErrorInfo?: unknown } | null;
    durationMs?: number | null;
  };
}

/** What a client-started turn waits for, by kind: each is counted and reported its own way. */
type TurnKind = 'send' | 'detached' | 'compact' | 'review' | 'shell';

/** A root turn of this thread that has ended. */
interface FinishedTurn {
  id: string;
  status: string;
  failed: boolean;
  text: string;
  images: GeneratedImage[];
  diff?: string;
  review?: string;
  shellOutput?: string;
  shellExitCode?: number | null;
  durationMs?: number;
  errorMessage?: string;
}

interface TurnWaiter {
  kind: TurnKind;
  resolve: (turn: FinishedTurn) => void;
  reject: (error: Error) => void;
}

/** Token counts a thread reported, `output` with the reasoning tokens. */
interface UsageTotals {
  input: number;
  cached: number;
  output: number;
}

const ZERO_USAGE: UsageTotals = { input: 0, cached: 0, output: 0 };

/** How long a compaction may take. */
const COMPACT_TIMEOUT_MS = 600_000;
/** How long the skills list is reused. */
const SKILLS_CACHE_MS = 60_000;

// ─── PersistentCodexAppServerSession ───────────────────────────────────────

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  method: string;
}

export class PersistentCodexAppServerSession extends EventEmitter implements ISession {
  /** Commands are app-server RPCs: slash text in a message reaches the model as text. */
  readonly commandStyle = 'rpc' as const;
  /** `turn/start` takes a model; the session's own is restored on the next turn. */
  readonly perSendModel = true;

  private options: SessionConfig;
  private codexBin: string;
  private proc: ChildProcess | null = null;
  private _rl: readline.Interface | null = null;
  private _isReady = false;
  private _isPaused = false;
  private _isBusy = false;
  private _startTime: string | null = null;
  private _nextRpcId = 1;
  private pendingRequests = new Map<number, PendingRequest>();
  private _history: Array<{ time: string; type: string; event: unknown }> = [];

  // Per-session state populated by notifications
  private threadId?: string;
  /** The root turn in flight on this thread: a send's, a goal loop's, a compaction's, a review's. */
  private currentTurnId?: string;
  private currentGoal: ThreadGoal | null = null;
  private _lastError: CodexAppError | null = null;
  /** The turn the last `error` notification the server would not retry belonged to. */
  private _lastErrorTurn: string | null = null;
  /** `jsonSchema`, parsed once in start(), sent as each turn's `outputSchema`. */
  private _outputSchema?: unknown;
  /** The sandbox policy the server reported for the thread; `addDir` extends its writable roots. */
  private _threadSandbox?: SandboxPolicy;

  // Turns this client started, waiting for their end
  /** By turn id, from the response that started the turn. */
  private _waiters = new Map<string, TurnWaiter>();
  /** A request whose turn id only `turn/started` tells (a compaction, a shell command). */
  private _claim: TurnWaiter | null = null;
  /** `turn/start` / `review/start` requests sent and not answered yet. */
  private _turnRequestsInFlight = 0;
  /** Root turns that ended before the response naming them arrived. */
  private _early = new Map<string, FinishedTurn>();
  /** The last root turn of this thread that ended; `thread/sample` samples after it. */
  private _lastFinishedTurnId?: string;
  /** The last client turn's diff, for the `diff` command. */
  private _lastDiff = '';

  // Per-turn buffers (reset when a root turn starts)
  /** Every agent-message delta of the turn, in order — the answer of last resort. */
  private turnAssistantText = '';
  /** The turn's completed agent messages, each with the phase the server gave it. */
  private turnMessages: Array<{ text: string; phase: string | null }> = [];
  /** Agent-message items of the turn whose text already streamed as deltas. */
  private turnStreamedItems = new Set<string>();
  /** A delta arrived without an item id, so items cannot be told apart by id. */
  private turnUntaggedDeltas = false;
  /** Images saved by `imageGeneration` items in the current turn. */
  private turnImages: GeneratedImage[] = [];
  /** A plan-mode turn's plan: it answers with a `plan` item and no agent message. */
  private turnPlan = '';
  /** A review turn's review (`exitedReviewMode`). */
  private turnReview?: string;
  /** The turn's working-tree diff (`turn/diff/updated`, the last one). */
  private turnDiff?: string;
  /** A `thread/shellCommand` turn's command output and exit code. */
  private turnShell?: { output: string; exitCode: number | null };

  public sessionId?: string;
  private _stats = {
    turns: 0,
    turnsSucceeded: 0,
    toolCalls: 0,
    toolErrors: 0,
    tokensIn: 0,
    tokensOut: 0,
    cachedTokens: 0,
    costUsd: 0,
    lastActivity: null as string | null,
  };

  /** Each thread's cumulative usage as it last reported it: this thread and its sub-agents'. */
  private _threadUsage = new Map<string, UsageTotals>();
  /** Usage no `thread/tokenUsage/updated` reports: side questions, reviewers. */
  private _extraUsage: UsageTotals = { ...ZERO_USAGE };
  /** Spend so far, priced as it was reported: a per-send model is billed at that model. */
  private _cost = { input: 0, cached: 0, output: 0 };
  /** Sub-agent threads, by id: the path and model `subAgentActivity` named. */
  private _subAgents = new Map<string, { path?: string; model?: string }>();

  /** This turn's own prompt size, from `tokenUsage.last` — see _estimateContextPercent(). */
  private _lastTurnTokensIn = 0;
  /** The window the app-server is enforcing, from `tokenUsage.modelContextWindow`. */
  private _modelContextWindow?: number;

  /**
   * The model the app-server reports for the thread. With no `model` param it
   * runs the one in the user's `~/.codex/config.toml`, and pricing that thread
   * at this wrapper's default misstates its cost.
   */
  private _reportedModel?: string;
  /** The reasoning effort the thread opened with, restored after a per-send effort. */
  private _threadEffort?: string;
  /** The model the server moved this thread to (`model/rerouted`). */
  private _reroutedModel?: string;
  /** The model of the turn in flight when it was given per send, or switched to with `/turn`. */
  private _turnModel?: string;
  /** The turn `/turn` switched the model of; its end ends the switch. */
  private _turnSettingsTurnId?: string;
  /** A per-send model or effort, or plan mode, stays on the thread after its turn; the next turn undoes it. */
  private _modelOverridden = false;
  private _effortOverridden = false;
  private _planMode = false;
  /** `skills/list`, reused for a minute. */
  private _skills?: { at: number; skills: CodexSkill[] };
  /** The thread's rollout file, as `thread/start` / `thread/resume` reported it. */
  private _rolloutFile?: string;

  constructor(config: SessionConfig, codexBin?: string) {
    super();
    this.codexBin = codexBin || process.env.CODEX_BIN || 'codex';
    this.options = { ...config, permissionMode: config.permissionMode || 'bypassPermissions' };
  }

  // ── Property Accessors ─────────────────────────────────────────────────

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
  get goal(): ThreadGoal | null {
    return this.currentGoal;
  }
  get codexThreadId(): string | undefined {
    return this.threadId;
  }
  /** The most recent `error` notification, or null. */
  get lastError(): CodexAppError | null {
    return this._lastError;
  }
  /** True while a turn is in flight on this thread, including the goal loop's own turns. */
  get turnActive(): boolean {
    return this.currentTurnId !== undefined;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  async start(): Promise<this> {
    // What codex would not take is refused before a process exists.
    if (this.options.ignoreRules) {
      throw new Error(
        'ignoreRules is not available on codex-app: `codex app-server` has no --ignore-rules (engine "codex" passes it)',
      );
    }
    const userConfig = codexConfigObject(this.options.codexConfig);
    const featureArgs = codexFeatureArgs(this.options.codexFeatures);
    codexTurnCommand(this.options.turnCommand);
    if (this.options.jsonSchema) {
      try {
        this._outputSchema = JSON.parse(this.options.jsonSchema);
      } catch (err) {
        throw new Error(`jsonSchema is not valid JSON: ${(err as Error).message}`);
      }
    }

    if (this.options.cwd) {
      this.options.cwd = path.resolve(this.options.cwd);
      if (!fs.existsSync(this.options.cwd)) fs.mkdirSync(this.options.cwd, { recursive: true });
    }

    const args = ['app-server', '--listen', 'stdio://', '--enable', 'goals', ...featureArgs];
    this.proc = spawnEngine(this.codexBin, args, {
      launcher: this.options.launcher,
      cwd: this.options.cwd,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this._rl = readline.createInterface({ input: this.proc.stdout!, crlfDelay: Infinity });
    this._rl.on('line', (line) => this._handleLine(line));

    this.proc.stderr?.on('data', (data: Buffer) => {
      this.emit(SESSION_EVENT.LOG, `[codex-app-stderr] ${sanitizeSecrets(data.toString())}`);
    });

    // Ends the process's part in this session once, whether it exited or never
    // started. Pending requests and the turn are rejected so callers don't hang.
    let ended = false;
    const end = (code: number | null, reason: string): void => {
      if (ended) return;
      ended = true;
      this._isReady = false;
      for (const pending of this.pendingRequests.values()) {
        pending.reject(new Error(`codex app-server ${reason} before responding`));
      }
      this.pendingRequests.clear();
      this._rejectWaiters(new Error(`codex app-server ${reason} mid-turn`));
      this.emit(SESSION_EVENT.CLOSE, code ?? 0);
    };
    this.proc.on('exit', (code) => end(code, `exited (code=${code})`));
    // Every 'error' needs a listener: an unheard one throws out of the event
    // loop, and inside OpenClaw that loop is the gateway's. A spawn that fails
    // (codex not on PATH) raises one here, and writing to a process that has
    // just died raises one on stdin.
    this.proc.on('error', (err) => {
      this.emit(SESSION_EVENT.LOG, `[codex-app] process error: ${err.message}`);
      end(null, `failed (${err.message})`);
    });
    this.proc.stdin?.on('error', (err) => this.emit(SESSION_EVENT.LOG, `[codex-app] stdin: ${err.message}`));
    this._rl.on('error', (err) => this.emit(SESSION_EVENT.LOG, `[codex-app] stdout: ${err.message}`));

    // 1. initialize
    await this._request('initialize', codexInitializeParams());

    // 2. thread/start — captures threadId both from the response and the
    //    `thread/started` notification (which arrives before the response per
    //    observed protocol semantics).
    const effort = codexReasoningEffort(this.options.effort);
    // On the thread, not only on `turn/start`: the goal loop starts its own
    // turns, and those read the thread's config. The caller's overrides join
    // the effort; the keys the wrapper sets were refused above.
    const config = { ...(effort ? { model_reasoning_effort: effort } : {}), ...userConfig };
    const threadParams = {
      cwd: this.options.cwd,
      model: this.options.model,
      sandbox: (this.options.sandboxMode || 'workspace-write') as SandboxMode,
      // Nothing here can answer an approval prompt, so none may be asked: with
      // the server's default (the user's config, often `on-request`) a command
      // that wanted approval left the turn waiting forever. The sandbox mode is
      // the boundary instead.
      approvalPolicy: 'never',
      ...(Object.keys(config).length ? { config } : {}),
    };
    const ephemeral = this.options.noSessionPersistence ? { ephemeral: true } : {};
    // Native fields, verified on 0.171.0: each reaches the model as a developer
    // message of its own, `baseInstructions` in place of codex's own prompt. A
    // resumed or forked thread already carries the ones it was opened with.
    const developerInstructions = this.options.appendSystemPrompt?.trim();
    const baseInstructions = this.options.systemPrompt?.trim();
    // `thread/start` with a writable sandbox in a git repository records the
    // project as trusted in the user's `~/.codex/config.toml` (0.172.0; resume
    // and fork do not). A new thread is therefore opened read-only and given
    // its sandbox before any turn (`_applyStartSandbox`), so a session leaves
    // the user's trust list as it found it, as `codex exec` without `--trust` does.
    const writable = threadParams.sandbox !== 'read-only';
    const startParams = {
      ...threadParams,
      ...(writable ? { sandbox: 'read-only' as SandboxMode } : {}),
      ...ephemeral,
      ...(developerInstructions ? { developerInstructions } : {}),
      ...(baseInstructions ? { baseInstructions } : {}),
    };
    let started = false;
    // When resuming a known thread, use `thread/resume` (loads prior turns)
    // instead of `thread/start` (which opens a fresh thread); with
    // `forkSession`, `thread/fork` opens a new thread holding that one's
    // history. A stale/unknown thread id (e.g. a wrong-engine id from
    // auto-resume, or a thread that no longer exists) degrades gracefully to a
    // fresh thread rather than failing the whole session. `excludeTurns`: the
    // session never reads the turns these return.
    const resumeId = this.options.resumeSessionId;
    type ThreadResponse = {
      thread?: { id?: string; path?: unknown };
      model?: unknown;
      sandbox?: unknown;
      reasoningEffort?: unknown;
    };
    let threadResp: ThreadResponse;
    if (resumeId) {
      const method = this.options.forkSession ? 'thread/fork' : 'thread/resume';
      const params = this.options.forkSession
        ? { threadId: resumeId, ...threadParams, ...ephemeral, excludeTurns: true }
        : { threadId: resumeId, ...threadParams, excludeTurns: true };
      try {
        threadResp = (await this._request(method, params)) as ThreadResponse;
      } catch (err) {
        this.emit(SESSION_EVENT.LOG, `[codex-app] ${method} failed (${(err as Error).message}); starting fresh`);
        threadResp = (await this._request('thread/start', startParams)) as ThreadResponse;
        started = true;
      }
    } else {
      threadResp = (await this._request('thread/start', startParams)) as ThreadResponse;
      started = true;
    }
    if (!this.threadId && threadResp?.thread?.id) {
      this.threadId = threadResp.thread.id;
    }
    if (!this.threadId) {
      throw new Error('codex app-server did not return a thread id from thread/start');
    }
    if (typeof threadResp.model === 'string' && threadResp.model) this._reportedModel = threadResp.model;
    if (typeof threadResp.thread?.path === 'string' && threadResp.thread.path)
      this._rolloutFile = threadResp.thread.path;
    if (typeof threadResp.reasoningEffort === 'string' && threadResp.reasoningEffort) {
      this._threadEffort = threadResp.reasoningEffort;
    }
    const sandbox = threadResp.sandbox as SandboxPolicy | undefined;
    if (sandbox && typeof sandbox.type === 'string') this._threadSandbox = sandbox;
    if (started && writable) await this._applyStartSandbox(threadParams.sandbox, userConfig);
    // The TUI's /rename. Best effort: a name is a label, not worth a failed start.
    const title = this.options.sessionName?.trim();
    if (title) {
      await this._request('thread/name/set', { threadId: this.threadId, name: title }).catch((err: Error) =>
        this.emit(SESSION_EVENT.LOG, `[codex-app] thread/name/set failed: ${err.message}`),
      );
    }

    this.sessionId = `codex-app-${this.threadId.slice(0, 8)}-${Date.now().toString(36)}`;
    this._startTime = new Date().toISOString();
    this._isReady = true;
    this.emit(SESSION_EVENT.READY);
    this.emit(SESSION_EVENT.INIT, { type: 'system', subtype: 'init', session_id: this.sessionId });
    return this;
  }

  /**
   * Give a thread opened read-only (see start()) the session's sandbox, with
   * `thread/settings/update`. A workspace-write policy is built as codex builds
   * it from `[sandbox_workspace_write]`: the user's configuration for the
   * directory (`config/read`) under the session's `codexConfig` overrides.
   */
  private async _applyStartSandbox(
    mode: SandboxMode,
    userConfig: Record<string, string | number | boolean>,
  ): Promise<void> {
    let policy: SandboxPolicy;
    if (mode === 'danger-full-access') policy = { type: 'dangerFullAccess' };
    else {
      let section: Record<string, unknown> = {};
      try {
        const resp = (await this._request(
          'config/read',
          this.options.cwd ? { cwd: this.options.cwd } : {},
          30_000,
        )) as {
          config?: { sandbox_workspace_write?: Record<string, unknown> | null };
        };
        section = { ...(resp?.config?.sandbox_workspace_write ?? {}) };
      } catch (err) {
        this.emit(
          SESSION_EVENT.LOG,
          `[codex-app] config/read failed (${(err as Error).message}); default workspace-write policy`,
        );
      }
      for (const [key, value] of Object.entries(userConfig)) {
        if (key.startsWith('sandbox_workspace_write.')) section[key.slice('sandbox_workspace_write.'.length)] = value;
      }
      const roots = Array.isArray(section.writable_roots)
        ? section.writable_roots.filter((r): r is string => typeof r === 'string')
        : [];
      policy = {
        type: 'workspaceWrite',
        writableRoots: roots,
        networkAccess: section.network_access === true,
        excludeTmpdirEnvVar: section.exclude_tmpdir_env_var === true,
        excludeSlashTmp: section.exclude_slash_tmp === true,
      };
    }
    await this._request('thread/settings/update', { threadId: this.threadId, sandboxPolicy: policy }, 30_000);
    this._threadSandbox = policy;
  }

  stop(): void {
    if (this._rl) {
      this._rl.close();
      this._rl = null;
    }
    if (this.proc) {
      // The app-server and the commands its turns started, then SIGKILL for a
      // group that ignored the SIGTERM.
      const proc = this.proc;
      killEngineTree(proc);
      const escalate = setTimeout(() => {
        try {
          signalEngineGroup(proc, 'SIGKILL');
        } catch {
          // Already gone.
        }
      }, STOPPED_ENGINE_GRACE_MS);
      escalate.unref?.();
      proc.once('close', () => clearTimeout(escalate));
      this.proc = null;
    }
    this._isReady = false;
    this._isPaused = false;
  }

  pause(): void {
    this._isPaused = true;
    this.emit(SESSION_EVENT.PAUSED, { sessionId: this.sessionId });
  }
  resume(): void {
    this._isPaused = false;
    this.emit(SESSION_EVENT.RESUMED, { sessionId: this.sessionId });
  }

  // ── send() ─────────────────────────────────────────────────────────────

  async send(
    message: string | unknown[],
    options: SessionSendOptions = {},
  ): Promise<TurnResult | { requestId: number; sent: boolean }> {
    if (!this._isReady) throw new Error('Session not ready. Call start() first.');
    if (!this.threadId) throw new Error('Session has no thread id (start() did not complete?)');
    const text = typeof message === 'string' ? message : JSON.stringify(message);
    const input = await this._turnInput(text, options);

    if (!options.waitForComplete) {
      this._fireAndForgetTurn(input, options).catch((err) => this._emitError(err as Error));
      return { requestId: this._nextRpcId, sent: true };
    }

    this._isBusy = true;
    try {
      return await this._runTurn(input, options);
    } finally {
      this._isBusy = false;
    }
  }

  /**
   * Under a `turnCommand`, the message is sent as it is: plan mode and a skill
   * are turn parameters here, not text (see `_turnInput`, `_turnStartParams`).
   */
  applyTurnCommand(_command: string, message: string): string {
    return message;
  }

  /**
   * The turn's input items: the images first, as `codex exec --image` places
   * them, then a skill the session's `turnCommand` names, then the text.
   */
  private async _turnInput(text: string, options: SessionSendOptions, skill?: string | false): Promise<unknown[]> {
    let named: string | undefined;
    if (skill === undefined) {
      const tc = codexTurnCommand(this.options.turnCommand);
      named = tc && 'skill' in tc ? tc.skill : undefined;
    } else if (skill) named = skill;
    const skillItem = named ? await this._skillInput(named) : undefined;
    return [
      ...(options.images ?? []).map((imagePath) => ({ type: 'localImage', path: imagePath })),
      ...(skillItem ? [skillItem] : []),
      // A skill invoked with no message is the skill item alone.
      ...(text || !skillItem ? [{ type: 'text', text, text_elements: [] }] : []),
    ];
  }

  /** The `skill` input item for `name`, from `skills/list`; throws when there is no such skill. */
  private async _skillInput(name: string): Promise<Record<string, string>> {
    const skill = (await this._listSkills()).find((s) => s.name === name);
    if (!skill) throw new Error(`there is no Codex skill named '${name}' for ${this.options.cwd ?? 'this directory'}`);
    if (!skill.enabled) throw new Error(`the Codex skill '${name}' is disabled`);
    return { type: 'skill', name: skill.name, path: skill.path };
  }

  private async _listSkills(): Promise<CodexSkill[]> {
    if (this._skills && Date.now() - this._skills.at < SKILLS_CACHE_MS) return this._skills.skills;
    const skills = await listCodexSkills(this._rpc(), this.options.cwd);
    this._skills = { at: Date.now(), skills };
    return skills;
  }

  private async _fireAndForgetTurn(input: unknown[], options: SessionSendOptions): Promise<void> {
    const id = await this._startTurn(this._turnStartParams(input, options));
    this._awaitTurn(id, 'detached', 0).catch(() => undefined);
  }

  /**
   * `turn/start` params.
   *
   * The model, the effort and the collaboration mode a turn names stay on the
   * thread for the turns after it, so what one send asked for alone is undone
   * on the next: its model by the session's (or the thread's own), its effort
   * by the session's (or the one the thread opened with), plan mode by default
   * mode. The output schema is for this turn only, so every turn carries it.
   */
  private _turnStartParams(input: unknown[], options: SessionSendOptions): Record<string, unknown> {
    const sessionEffort = codexReasoningEffort(this.options.effort);
    const askedEffort = codexReasoningEffort(options.effort);
    const effort = askedEffort ?? sessionEffort ?? (this._effortOverridden ? this._threadEffort : undefined);
    this._effortOverridden = !!askedEffort && askedEffort !== sessionEffort;
    const model = options.model ?? (this._modelOverridden ? (this.options.model ?? this._reportedModel) : undefined);
    this._modelOverridden = !!options.model;
    this._turnModel = options.model;
    const tc = codexTurnCommand(this.options.turnCommand);
    const plan = !!options.plan || (!!tc && 'plan' in tc);
    let collaborationMode: Record<string, unknown> | undefined;
    if (plan || this._planMode) {
      // The mode takes precedence over the turn's model and effort, so it carries them.
      collaborationMode = {
        mode: plan ? 'plan' : 'default',
        settings: {
          model: model ?? this.options.model ?? this._reportedModel ?? 'gpt-5.5',
          reasoning_effort: effort ?? null,
          developer_instructions: null,
        },
      };
      this._planMode = plan;
    }
    const sandboxPolicy = this._addDirSandboxPolicy();
    return {
      threadId: this.threadId,
      input,
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      ...(collaborationMode ? { collaborationMode } : {}),
      ...(this._outputSchema !== undefined ? { outputSchema: this._outputSchema } : {}),
      ...(sandboxPolicy ? { sandboxPolicy } : {}),
    };
  }

  /**
   * `addDir` as writable roots, for a workspace-write session.
   *
   * `codex exec --add-dir` has no app-server counterpart on the thread; a turn's
   * `sandboxPolicy` replaces the thread's policy for that turn and the ones
   * after it. It is the policy `thread/start` reported with the directories
   * added, so the network access and roots the user's config gives stay as
   * they were. Undefined when there is nothing to add or the mode is not
   * workspace-write, where extra writable roots mean nothing.
   */
  private _addDirSandboxPolicy(): SandboxPolicy | undefined {
    const dirs = this.options.addDir;
    if (!dirs?.length || (this.options.sandboxMode || 'workspace-write') !== 'workspace-write') return undefined;
    const base: SandboxPolicy =
      this._threadSandbox?.type === 'workspaceWrite' ? this._threadSandbox : { type: 'workspaceWrite' };
    const roots = Array.isArray(base.writableRoots) ? base.writableRoots : [];
    const cwd = this.options.cwd ?? process.cwd();
    return { ...base, writableRoots: [...new Set([...roots, ...dirs.map((d) => path.resolve(cwd, d))])] };
  }

  /** Clear the per-turn buffers: a root turn has started. */
  private _resetTurnBuffers(): void {
    this.turnAssistantText = '';
    this.turnMessages = [];
    this.turnStreamedItems = new Set();
    this.turnUntaggedDeltas = false;
    this.turnImages = [];
    this.turnPlan = '';
    this.turnReview = undefined;
    this.turnDiff = undefined;
    this.turnShell = undefined;
  }

  /**
   * The turn's answer: the agent message the server marked `final_answer`,
   * else a plan-mode turn's plan, else the last agent message, else whatever
   * streamed. A turn's messages include its commentary ("Running the tests."
   * before a tool call; a plan turn's "I'll read calc.py first."), and a
   * `jsonSchema` caller has to get the schema-shaped answer alone.
   */
  private _turnAnswer(): string {
    for (let i = this.turnMessages.length - 1; i >= 0; i--) {
      if (this.turnMessages[i].phase === 'final_answer') return this.turnMessages[i].text;
    }
    if (this.turnPlan) return this.turnPlan;
    return this.turnMessages.at(-1)?.text ?? this.turnAssistantText;
  }

  /**
   * Start a turn (`turn/start` or `review/start`) and return its id, or
   * undefined when the response names none (then the next root turn of the
   * thread is taken as this one).
   */
  private async _startTurn(params: Record<string, unknown>, method = 'turn/start'): Promise<string | undefined> {
    this._turnRequestsInFlight++;
    let id: string | undefined;
    try {
      const resp = (await this._request(method, params)) as { turn?: { id?: unknown } } | undefined;
      id = typeof resp?.turn?.id === 'string' ? resp.turn.id : undefined;
    } finally {
      this._turnRequestsInFlight--;
    }
    // The turn this client now waits for; its own notifications follow the response.
    if (id && !this._early.has(id) && this.currentTurnId !== id) {
      this.currentTurnId = id;
      this._resetTurnBuffers();
    }
    return id;
  }

  /**
   * Wait for root turn `id` of this thread to end, counted and reported as
   * `kind`; with no id, for the next root turn to start and end. A `timeoutMs`
   * of 0 waits for as long as the server runs.
   */
  private _awaitTurn(id: string | undefined, kind: TurnKind, timeoutMs: number): Promise<FinishedTurn> {
    return new Promise<FinishedTurn>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const waiter: TurnWaiter = {
        kind,
        resolve: (t) => {
          if (timer) clearTimeout(timer);
          resolve(t);
        },
        reject: (e) => {
          if (timer) clearTimeout(timer);
          reject(e);
        },
      };
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          // A turn that ends later is one nobody waits for: an engine turn.
          for (const [key, w] of this._waiters) if (w === waiter) this._waiters.delete(key);
          if (this._claim === waiter) this._claim = null;
          reject(new Error('Timeout waiting for Codex app-server turn to complete'));
        }, timeoutMs);
      }
      // With no id: a turn that ended before this call, else the one in flight, else the next.
      const key = id ?? [...this._early.keys()].at(-1) ?? this.currentTurnId;
      const early = key !== undefined ? this._early.get(key) : undefined;
      if (early && key !== undefined) {
        this._early.delete(key);
        this._finishTurn(early, waiter);
      } else if (key !== undefined && !this._waiters.has(key)) {
        this._waiters.set(key, waiter);
      } else if (!this._claim) {
        this._claim = waiter;
      } else {
        waiter.reject(new Error('another request is waiting for its turn to start'));
      }
      this._flushEarly();
    });
  }

  /**
   * Run a request that starts a turn whose id only its `turn/started` tells
   * (`thread/compact/start`, `thread/shellCommand`), and wait for that turn.
   */
  private _claimNextTurn(kind: TurnKind, timeoutMs: number, request: () => Promise<unknown>): Promise<FinishedTurn> {
    if (this._claim) return Promise.reject(new Error(`another ${this._claim.kind} is waiting for its turn to start`));
    return new Promise<FinishedTurn>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this._claim === waiter) this._claim = null;
        for (const [id, w] of this._waiters) if (w === waiter) this._waiters.delete(id);
        reject(new Error(`Timeout waiting for the Codex ${kind} to end`));
      }, timeoutMs);
      const waiter: TurnWaiter = {
        kind,
        resolve: (t) => {
          clearTimeout(timer);
          resolve(t);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      };
      this._claim = waiter;
      request().catch((err: Error) => {
        if (this._claim === waiter) this._claim = null;
        waiter.reject(err);
      });
    });
  }

  private _rejectWaiters(err: Error): void {
    const waiters = [...this._waiters.values(), ...(this._claim ? [this._claim] : [])];
    this._waiters.clear();
    this._claim = null;
    for (const w of waiters) w.reject(err);
  }

  /** Report the turns that ended before any response named them, once no response is pending. */
  private _flushEarly(): void {
    if (this._turnRequestsInFlight > 0) return;
    for (const [id, turn] of this._early) {
      this._early.delete(id);
      this._finishTurn(turn, undefined);
    }
  }

  private async _runTurn(input: unknown[], options: SessionSendOptions): Promise<TurnResult> {
    const timeout = options.timeout || 600_000;
    // Wire up text streaming for this turn
    const onText = (chunk: string) => {
      try {
        options.callbacks?.onText?.(chunk);
      } catch {
        // User callback errors are not fatal.
      }
    };
    this.on(SESSION_EVENT.TEXT, onText);
    try {
      const id = await this._startTurn(this._turnStartParams(input, options));
      const turn = await this._awaitTurn(id, 'send', timeout);
      // A failed turn is surfaced as a rejection (mirrors the exec wrapper), not
      // an empty-text resolve, so callers see the failure.
      if (turn.failed) throw new Error(`Codex app-server turn failed${turn.text ? `: ${turn.text}` : ''}`);
      return { text: turn.text, event: this._resultEvent(turn) };
    } finally {
      this.removeListener(SESSION_EVENT.TEXT, onText);
    }
  }

  /** The `result` event for a finished turn. */
  private _resultEvent(turn: FinishedTurn): StreamEvent {
    return {
      type: 'result',
      result: turn.text,
      stop_reason: turn.failed ? 'error' : 'end_turn',
      session_id: this.threadId,
      ...(turn.durationMs ? { duration_ms: turn.durationMs } : {}),
      ...(turn.images.length ? { generated_images: [...turn.images] } : {}),
      ...(turn.diff ? { diff: turn.diff } : {}),
    };
  }

  /**
   * Count and report a finished root turn by what started it:
   *   - a send (or a fire-and-forget one) or a review: a turn, a success when
   *     it completed, `result` and `turn_complete`;
   *   - a compaction or a shell command: no model turn, nothing reported;
   *   - nothing this client waits for (a goal loop's turn, a send that timed
   *     out): a turn but never a success, `result`, and `unsolicited_result`
   *     unless a goal owns the thread — the goal reports its own spend.
   */
  private _finishTurn(turn: FinishedTurn, waiter: TurnWaiter | undefined): void {
    const kind = waiter?.kind;
    this._lastFinishedTurnId = turn.id;
    if (turn.id === this._turnSettingsTurnId) {
      this._turnModel = undefined;
      this._turnSettingsTurnId = undefined;
    }
    const modelTurn = kind !== 'compact' && kind !== 'shell';
    if (modelTurn) {
      this._stats.turns++;
      if (kind && turn.status === 'completed') this._stats.turnsSucceeded++;
      if (kind && turn.failed) this._stats.toolErrors++;
      this._stats.lastActivity = new Date().toISOString();
      if (kind) this._lastDiff = turn.diff ?? '';
      const event = this._resultEvent(turn);
      this.emit(SESSION_EVENT.RESULT, event);
      if (kind) this.emit(SESSION_EVENT.TURN_COMPLETE, event);
      else if (!this.currentGoal) this.emit(SESSION_EVENT.UNSOLICITED_RESULT, { text: turn.text, event });
    }
    waiter?.resolve(turn);
  }

  // ── JSON-RPC plumbing ──────────────────────────────────────────────────

  /**
   * One JSON-RPC request. A timeout rejects with an error marked `timedOut`;
   * `onSent` gets the request id, for a request a later one cancels.
   */
  private _request(method: string, params: unknown, timeoutMs = 0, onSent?: (id: number) => void): Promise<unknown> {
    if (!this.proc?.stdin?.writable) {
      return Promise.reject(new Error('codex app-server stdin not writable'));
    }
    const id = this._nextRpcId++;
    onSent?.(id);
    const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done =
        <T>(fn: (v: T) => void) =>
        (v: T) => {
          if (timer) clearTimeout(timer);
          fn(v);
        };
      this.pendingRequests.set(id, { resolve: done(resolve), reject: done(reject), method });
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          this.pendingRequests.delete(id);
          reject(
            Object.assign(new Error(`codex app-server did not answer ${method} within ${timeoutMs} ms`), {
              timedOut: true,
            }),
          );
        }, timeoutMs);
      }
      this.proc!.stdin!.write(msg, (err) => {
        if (err) {
          this.pendingRequests.delete(id);
          if (timer) clearTimeout(timer);
          reject(err);
        }
      });
    });
  }

  /** This session's app-server as a `CodexRpc`, for the command and quota helpers. */
  private _rpc(): CodexRpc {
    return { request: (method, params, timeoutMs) => this._request(method, params, timeoutMs ?? 120_000) };
  }

  /** The app-server, for a reader that asks it directly (the quota); undefined when it is not running. */
  codexRpc(): CodexRpc | undefined {
    return this._isReady ? this._rpc() : undefined;
  }

  private _reply(id: number | string, error: { code: number; message: string }): void {
    if (!this.proc?.stdin?.writable) return;
    this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, error }) + '\n');
  }

  private _handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: {
      jsonrpc?: string;
      id?: number | string | null;
      method?: string;
      params?: unknown;
      result?: unknown;
      error?: { code?: number; message?: string };
    };
    try {
      msg = JSON.parse(trimmed);
    } catch {
      this.emit(SESSION_EVENT.LOG, `[codex-app-stdout] ${trimmed}`);
      return;
    }

    this._addHistory({ time: new Date().toISOString(), type: 'event', event: msg });

    // Response (has id, no method)
    if (typeof msg.id === 'number' && msg.method === undefined) {
      const pending = this.pendingRequests.get(msg.id);
      if (!pending) return;
      this.pendingRequests.delete(msg.id);
      if (msg.error) {
        pending.reject(new Error(`${pending.method} failed: ${msg.error.message ?? 'unknown error'}`));
      } else {
        pending.resolve(msg.result);
      }
      return;
    }

    // Request from the server (has method and id): approvals, user input,
    // client-side tool calls. None is supported here, and an unanswered request
    // blocks the turn that sent it, so each gets an error reply at once.
    if (msg.method && msg.id !== undefined && msg.id !== null) {
      this.emit(SESSION_EVENT.LOG, `[codex-app] declined server request ${msg.method}`);
      this._reply(msg.id, { code: -32601, message: `${msg.method} is not supported by this client` });
      return;
    }

    // Notification (has method, no id)
    if (msg.method) {
      this._dispatchNotification(msg.method, msg.params);
    }
  }

  /**
   * Whether a notification is about this session's thread. One without a thread
   * id (an older server) is taken as this thread's.
   */
  private _ours(threadId: unknown): boolean {
    return typeof threadId !== 'string' || !threadId || threadId === this.threadId;
  }

  private _dispatchNotification(method: string, params: unknown): void {
    switch (method) {
      case 'thread/started': {
        const p = params as ThreadStartedNotification;
        if (p.thread?.id && !this.threadId) this.threadId = p.thread.id;
        break;
      }
      case 'turn/started': {
        const p = params as { threadId?: string; turn?: { id?: string; rootTurnId?: string | null } };
        // A sub-agent's turn runs on its own thread; it is not this one's.
        if (!this._ours(p.threadId) || !p.turn?.id) break;
        const root = p.turn.rootTurnId || p.turn.id;
        // An inner turn of the turn in flight (a review's reviewer) adds to it.
        if (root === this.currentTurnId) break;
        this.currentTurnId = root;
        // Also clears what a turn no send() waited on (the goal loop's, a
        // fire-and-forget one) left behind.
        this._resetTurnBuffers();
        if (this._claim && !this._waiters.has(root)) {
          this._waiters.set(root, this._claim);
          this._claim = null;
        }
        break;
      }
      case 'item/agentMessage/delta': {
        const p = params as AgentMessageDeltaNotification;
        if (!this._ours(p.threadId)) break;
        if (typeof p.delta === 'string' && p.delta.length > 0) {
          this.turnAssistantText += p.delta;
          if (p.itemId) this.turnStreamedItems.add(p.itemId);
          else this.turnUntaggedDeltas = true;
          this.emit(SESSION_EVENT.TEXT, p.delta);
        }
        break;
      }
      case 'item/plan/delta': {
        // A plan-mode turn streams its plan here instead of an agent message.
        const p = params as AgentMessageDeltaNotification;
        if (!this._ours(p.threadId)) break;
        if (typeof p.delta === 'string' && p.delta.length > 0) this.emit(SESSION_EVENT.TEXT, p.delta);
        break;
      }
      case 'item/completed': {
        const p = params as ItemCompletedNotification;
        const type = p.item?.type;
        if (!this._ours(p.threadId)) {
          // A sub-agent's work: its answer reaches this thread as its parent's
          // next message, so it is only logged.
          if (type === 'agentMessage' && p.item.text) {
            const path = this._subAgents.get(p.threadId)?.path ?? p.threadId;
            this.emit(SESSION_EVENT.LOG, `[codex-app subagent ${path}] ${p.item.text.slice(0, 2000)}`);
          }
          break;
        }
        if (type === 'subAgentActivity' && typeof p.item.agentThreadId === 'string') {
          const known = this._subAgents.get(p.item.agentThreadId) ?? {};
          this._subAgents.set(p.item.agentThreadId, {
            path: p.item.agentPath ?? known.path,
            model: p.item.model ?? known.model,
          });
          break;
        }
        // Codex's built-in image generation reports where it saved the file.
        if (type === 'imageGeneration' && typeof p.item.savedPath === 'string' && p.item.savedPath) {
          this.turnImages.push({
            path: p.item.savedPath,
            ...(typeof p.item.revisedPrompt === 'string' ? { revisedPrompt: p.item.revisedPrompt } : {}),
          });
        }
        if (type === 'plan' && typeof p.item.text === 'string') this.turnPlan = p.item.text;
        if (type === 'exitedReviewMode' && typeof p.item.review === 'string') this.turnReview = p.item.review;
        if (type === 'agentMessage' && typeof p.item.text === 'string') {
          this.turnMessages.push({ text: p.item.text, phase: p.item.phase ?? null });
          // A message that did not stream as deltas is streamed whole, once.
          const streamed = this.turnUntaggedDeltas
            ? this.turnAssistantText.length > 0
            : !!p.item.id && this.turnStreamedItems.has(p.item.id);
          if (!streamed && p.item.text) this.emit(SESSION_EVENT.TEXT, p.item.text);
        } else if (type === 'commandExecution' && p.item.source === 'userShell') {
          // `thread/shellCommand`: the user's command, not a model tool call.
          this.turnShell = { output: p.item.aggregatedOutput ?? '', exitCode: p.item.exitCode ?? null };
        } else if (type && !NON_TOOL_ITEMS.has(type)) {
          this._stats.toolCalls++;
          if (type === 'commandExecution' && typeof p.item.exitCode === 'number' && p.item.exitCode !== 0) {
            this._stats.toolErrors++;
          }
        }
        break;
      }
      case 'turn/diff/updated': {
        const p = params as { threadId?: string; turnId?: string; diff?: string };
        if (this._ours(p.threadId) && typeof p.diff === 'string' && (!p.turnId || p.turnId === this.currentTurnId)) {
          this.turnDiff = p.diff;
        }
        break;
      }
      case 'thread/tokenUsage/updated': {
        const p = params as ThreadTokenUsageUpdatedNotification;
        const thread = typeof p.threadId === 'string' && p.threadId ? p.threadId : (this.threadId ?? '');
        if (p.tokenUsage?.total) this._recordThreadUsage(thread, p.tokenUsage.total);
        if (!this._ours(p.threadId)) break;
        // `last` is this turn's own prompt, which for a thread-resuming engine
        // is the live context occupancy; `total` only ever grows and would pin
        // contextPercent at 100 on any long session. A compaction reports a
        // `last` of zero input with the compacted context's size as its total.
        const last = p.tokenUsage?.last;
        if (typeof last?.inputTokens === 'number' && last.inputTokens > 0) this._lastTurnTokensIn = last.inputTokens;
        else if (typeof last?.totalTokens === 'number' && last.totalTokens > 0)
          this._lastTurnTokensIn = last.totalTokens;
        if (typeof p.tokenUsage?.modelContextWindow === 'number') {
          this._modelContextWindow = p.tokenUsage.modelContextWindow;
        }
        break;
      }
      case 'thread/goal/updated': {
        const p = params as ThreadGoalUpdatedNotification;
        if (!this._ours(p.threadId)) break;
        if (p.goal) this.currentGoal = p.goal;
        this.emit('goal:updated', this.currentGoal);
        break;
      }
      case 'thread/goal/cleared': {
        const p = params as { threadId?: string };
        if (!this._ours(p?.threadId)) break;
        this.currentGoal = null;
        this.emit('goal:cleared');
        break;
      }
      case 'turn/completed': {
        const p = params as TurnCompletedNotification;
        // A sub-agent's turn ends on its own thread, before the parent's does.
        if (!this._ours(p.threadId) || !p.turn?.id) break;
        // An inner turn (a review's reviewer) ends with the turn it serves.
        if (p.turn.rootTurnId && p.turn.rootTurnId !== p.turn.id) break;
        // This notification can itself report how the turn ended. The engine's
        // TurnStatus is `completed | interrupted | failed | inProgress`, so the counter
        // tests for completion rather than for the absence of failure: an interrupted
        // turn — which `interrupt()` on this class produces on purpose — resolves with
        // partial text and is not a success. `stop_reason` keeps its own two-state
        // mapping, so `interrupted` stays out of the error bucket there.
        const failed = p.turn.status === 'failed';
        // A failed goal turn may report its cause only here, not as an `error`
        // notification: a model at capacity ends the turn with
        // `turn.error.codexErrorInfo: serverOverloaded` and the goal then goes
        // `blocked` (codex 0.166.0). Surfaced as `codex:error` unless the same
        // turn already raised a final one.
        const turnError = p.turn.error;
        if (turnError && p.turn.status !== 'completed' && this._lastErrorTurn !== p.turn.id) {
          this._lastError = {
            message: turnError.message ?? 'codex app-server turn failed',
            code: errorInfoName(turnError.codexErrorInfo),
            willRetry: false,
            at: new Date().toISOString(),
          };
          this._lastErrorTurn = p.turn.id;
          this.emit('codex:error', this._lastError);
        }
        // Clear the active-turn id so a later interrupt()/steer() does not target
        // an already-finished turn (only clear if it is the turn that completed).
        if (this.currentTurnId === p.turn.id) this.currentTurnId = undefined;
        const finished: FinishedTurn = {
          id: p.turn.id,
          status: p.turn.status,
          failed,
          text: this.turnReview ?? this._turnAnswer(),
          images: [...this.turnImages],
          ...(this.turnDiff ? { diff: this.turnDiff } : {}),
          ...(this.turnReview !== undefined ? { review: this.turnReview } : {}),
          ...(this.turnShell ? { shellOutput: this.turnShell.output, shellExitCode: this.turnShell.exitCode } : {}),
          ...(typeof p.turn.durationMs === 'number' ? { durationMs: p.turn.durationMs } : {}),
          ...(turnError?.message ? { errorMessage: turnError.message } : {}),
        };
        // What the turn left is in `finished` now; the next turn starts clean.
        this._resetTurnBuffers();
        let waiter = this._waiters.get(p.turn.id);
        if (waiter) this._waiters.delete(p.turn.id);
        else if (this._claim) {
          waiter = this._claim;
          this._claim = null;
        }
        // A turn whose starting response has not been read yet may be this
        // client's: held until that response names its turn.
        if (!waiter && this._turnRequestsInFlight > 0) this._early.set(p.turn.id, finished);
        else this._finishTurn(finished, waiter);
        break;
      }
      case 'error': {
        const p = params as {
          error?: { message?: string; codexErrorInfo?: unknown };
          willRetry?: boolean;
          turnId?: string;
          threadId?: string;
        };
        const message = p.error?.message ?? 'codex app-server error';
        if (!this._ours(p.threadId)) {
          this.emit(SESSION_EVENT.LOG, `[codex-app subagent ${p.threadId}] error: ${message}`);
          break;
        }
        this._lastError = {
          message,
          code: errorInfoName(p.error?.codexErrorInfo),
          willRetry: p.willRetry === true,
          at: new Date().toISOString(),
        };
        this._lastErrorTurn = p.willRetry === true ? null : (p.turnId ?? null);
        this.emit('codex:error', this._lastError);
        this._emitError(new Error(message));
        break;
      }
      case 'model/rerouted': {
        // The turn ran on another model than the thread's: billed as that one.
        const p = params as { threadId?: string; fromModel?: string; toModel?: string; reason?: unknown };
        if (!this._ours(p.threadId) || typeof p.toModel !== 'string' || !p.toModel) break;
        this._reroutedModel = p.toModel;
        this.emit(
          SESSION_EVENT.LOG,
          `[codex-app] model rerouted from ${p.fromModel ?? '?'} to ${p.toModel} (${JSON.stringify(p.reason ?? null)})`,
        );
        break;
      }
      case 'warning':
      case 'configWarning':
      case 'deprecationNotice':
      case 'guardianWarning': {
        const p = params as { message?: string; summary?: string; details?: string | null; threadId?: string | null };
        if (p?.threadId && !this._ours(p.threadId)) break;
        const text = p?.message ?? [p?.summary, p?.details].filter(Boolean).join(': ');
        this.emit(SESSION_EVENT.LOG, `[codex-app] ${method}: ${sanitizeSecrets(text || JSON.stringify(params))}`);
        break;
      }
      case 'hook/started':
      case 'hook/completed': {
        const p = params as { threadId?: string };
        if (!this._ours(p?.threadId)) break;
        this.emit(SESSION_EVENT.LOG, `[codex-app] ${method} ${JSON.stringify(params).slice(0, 500)}`);
        if (this.options.includeHookEvents) this.emit(SESSION_EVENT.EVENT, { type: 'hook', method, params });
        break;
      }
      default:
        // Unhandled notifications still go to history for debugging
        break;
    }
  }

  /**
   * Take a thread's cumulative usage. The spend since its last report is
   * priced now, at the model it ran on: a sub-agent's own, a per-send model, a
   * rerouted one, else the session's.
   */
  private _recordThreadUsage(threadId: string, total: TokenUsageBreakdown): void {
    const now: UsageTotals = {
      input: total.inputTokens ?? 0,
      cached: total.cachedInputTokens ?? 0,
      output: (total.outputTokens ?? 0) + (total.reasoningOutputTokens ?? 0),
    };
    const prev = this._threadUsage.get(threadId) ?? ZERO_USAGE;
    this._threadUsage.set(threadId, now);
    const model = this._ours(threadId)
      ? this._turnPricedModel()
      : (this._subAgents.get(threadId)?.model ?? this._turnPricedModel());
    this._addCost(model, {
      input: Math.max(0, now.input - prev.input),
      cached: Math.max(0, now.cached - prev.cached),
      output: Math.max(0, now.output - prev.output),
    });
  }

  /** Add usage no notification reports (a side question, a reviewer) to the session's. */
  private _recordExtraUsage(usage: UsageTotals, model?: string): void {
    this._extraUsage = {
      input: this._extraUsage.input + usage.input,
      cached: this._extraUsage.cached + usage.cached,
      output: this._extraUsage.output + usage.output,
    };
    this._addCost(model ?? this._turnPricedModel(), usage);
  }

  private _addCost(model: string | undefined, d: UsageTotals): void {
    const pricing = getModelPricing(model, 'gpt-5.5');
    this._cost.input += (Math.max(0, d.input - d.cached) / 1_000_000) * pricing.input;
    this._cost.cached += (d.cached / 1_000_000) * (pricing.cached ?? 0);
    this._cost.output += (d.output / 1_000_000) * pricing.output;
    let input = this._extraUsage.input;
    let cached = this._extraUsage.cached;
    let output = this._extraUsage.output;
    for (const u of this._threadUsage.values()) {
      input += u.input;
      cached += u.cached;
      output += u.output;
    }
    this._stats.tokensIn = input;
    this._stats.cachedTokens = cached;
    this._stats.tokensOut = output;
    this._stats.costUsd = this._cost.input + this._cost.cached + this._cost.output;
  }

  /** The model the usage now arriving ran on. */
  private _turnPricedModel(): string | undefined {
    return this._turnModel ?? this._billedModel();
  }

  // ── ISession surface ───────────────────────────────────────────────────

  getStats(): SessionStats & { sessionId?: string; uptime: number; goal?: ThreadGoal | null } {
    return {
      turns: this._stats.turns,
      turnsSucceeded: this._stats.turnsSucceeded,
      toolCalls: this._stats.toolCalls,
      toolErrors: this._stats.toolErrors,
      tokensIn: this._stats.tokensIn,
      tokensOut: this._stats.tokensOut,
      cachedTokens: this._stats.cachedTokens,
      costUsd: Math.round(this._stats.costUsd * 10000) / 10000,
      isReady: this._isReady,
      startTime: this._startTime,
      lastActivity: this._stats.lastActivity,
      contextPercent: this._estimateContextPercent(),
      retries: 0,
      sessionId: this.sessionId,
      uptime: this._startTime ? Math.round((Date.now() - new Date(this._startTime).getTime()) / 1000) : 0,
      codexThreadId: this.threadId,
      goal: this.currentGoal,
    };
  }

  getHistory(limit = DEFAULT_HISTORY_LIMIT): Array<{ time: string; type: string; event: unknown }> {
    return this._history.slice(-limit);
  }

  /** Compact the thread, waiting for the compaction to end (see `compactDetailed`). */
  async compact(summary?: string): Promise<TurnResult> {
    const outcome = await this.compactDetailed(summary);
    const text = outcome.ok
      ? 'Codex thread compacted'
      : `Codex thread compaction failed${outcome.note ? `: ${outcome.note}` : ''}`;
    return { text, event: { type: 'result', result: text, ...(outcome.ok ? {} : { is_error: true }) } };
  }

  /**
   * Compact the thread (`thread/compact/start`) and resolve once the
   * compaction's own turn has ended: a send right after it would otherwise be
   * refused with `ActiveTurnNotSteerable { turn_kind: Compact }` (measured on
   * 0.172.0). The compaction's turn is not a model turn: it is not counted and
   * reports no result. Codex compacts with its own prompt; `summary` is not used.
   */
  async compactDetailed(_summary?: string): Promise<CompactOutcome> {
    if (!this.threadId) throw new Error('No thread id');
    if (this.currentTurnId)
      throw new Error('compaction: a turn is in flight on the thread; wait for it or interrupt it');
    const preTokens = this._lastTurnTokensIn;
    const turn = await this._claimNextTurn('compact', COMPACT_TIMEOUT_MS, () =>
      this._request('thread/compact/start', { threadId: this.threadId }),
    );
    const ok = turn.status === 'completed';
    return {
      ok,
      trigger: 'manual',
      ...(preTokens > 0 ? { preTokens } : {}),
      ...(this._lastTurnTokensIn > 0 && this._lastTurnTokensIn !== preTokens
        ? { postTokens: this._lastTurnTokensIn }
        : {}),
      ...(ok ? {} : { note: turn.errorMessage ?? `the compaction ended ${turn.status}` }),
    };
  }

  getEffort(): EffortLevel {
    return this.options.effort || 'auto';
  }
  setEffort(level: EffortLevel): void {
    this.options.effort = level;
  }

  resolveModel(alias: string): string {
    return resolveAlias(alias);
  }

  getCost(): CostBreakdown {
    const pricing = getModelPricing(this._billedModel(), 'gpt-5.5');
    const cachedPrice = pricing.cached ?? 0;
    return {
      model: this._billedModel() || 'gpt-5.5',
      tokensIn: this._stats.tokensIn,
      tokensOut: this._stats.tokensOut,
      cachedTokens: this._stats.cachedTokens,
      pricing: { inputPer1M: pricing.input, outputPer1M: pricing.output, cachedPer1M: cachedPrice || undefined },
      // Each report priced at the model it ran on, so a per-send model or a
      // sub-agent's own model bills as itself.
      breakdown: { inputCost: this._cost.input, cachedCost: this._cost.cached, outputCost: this._cost.output },
      totalUsd: this._stats.costUsd,
    };
  }

  // ── Goals (`thread/goal/*`) ────────────────────────────────────────────

  /**
   * Set, update or resume the thread's goal (`thread/goal/set`). An objective
   * starts the server's turn loop; `status: 'active'` resumes a paused or
   * stopped one, `'paused'` pauses it. Fields left out keep their value.
   */
  async setGoal(p: {
    objective?: string;
    status?: 'active' | 'paused';
    tokenBudget?: number | null;
  }): Promise<ThreadGoal> {
    if (!this.threadId) throw new Error('No thread id');
    if (this.options.noSessionPersistence && p.objective !== undefined) {
      throw new Error(
        'a goal needs a persisted thread: Codex says "ephemeral thread does not support goals" (noSessionPersistence)',
      );
    }
    const params: Record<string, unknown> = { threadId: this.threadId, origin: 'user' };
    if (p.objective !== undefined) params.objective = p.objective;
    if (p.status !== undefined) params.status = p.status;
    if (p.tokenBudget !== undefined) params.tokenBudget = p.tokenBudget;
    const resp = (await this._request('thread/goal/set', params)) as { goal?: ThreadGoal };
    if (!resp?.goal) throw new Error('thread/goal/set returned no goal');
    this.currentGoal = resp.goal;
    return resp.goal;
  }

  /** The thread's goal as the server holds it now (`thread/goal/get`), or null. */
  async getGoal(): Promise<ThreadGoal | null> {
    if (!this.threadId) throw new Error('No thread id');
    const resp = (await this._request('thread/goal/get', { threadId: this.threadId })) as { goal?: ThreadGoal | null };
    this.currentGoal = resp?.goal ?? null;
    return this.currentGoal;
  }

  /** Remove the thread's goal (`thread/goal/clear`). */
  async clearGoal(): Promise<void> {
    if (!this.threadId) throw new Error('No thread id');
    await this._request('thread/goal/clear', { threadId: this.threadId, origin: 'user' });
    this.currentGoal = null;
  }

  // ── App-server v2 RPCs (Codex 0.137) ───────────────────────────────────
  //
  // Method names + param shapes verified against `codex app-server
  // generate-json-schema` (TurnInterruptParams/TurnSteerParams/ThreadForkParams/
  // ThreadTurnsListParams/ThreadRevertParams/ThreadListParams/ModelListResponse/
  // ThreadGoal*Params; 0.171.0 for the turn list, revert and thread list).

  /** The id of the most recent turn (set by the `turn/started` notification). */
  get activeTurnId(): string | undefined {
    return this.currentTurnId;
  }

  /** Cancel the in-flight turn (`turn/interrupt`). No-op when no turn is active. */
  async interrupt(): Promise<{ interrupted: boolean }> {
    if (!this.threadId) throw new Error('No thread id');
    if (!this.currentTurnId) return { interrupted: false };
    await this._request('turn/interrupt', { threadId: this.threadId, turnId: this.currentTurnId });
    return { interrupted: true };
  }

  /**
   * Add input to the in-flight turn without restarting it (`turn/steer`). That
   * includes a turn the goal loop started, which no `send()` is waiting on.
   * When no turn is in flight, falls back to a normal turn so the message is
   * not lost.
   */
  async steer(text: string): Promise<{ steered: boolean; turnId?: string; text?: string }> {
    if (!this.threadId) throw new Error('No thread id');
    if (this.currentTurnId) {
      const resp = (await this._request('turn/steer', {
        threadId: this.threadId,
        expectedTurnId: this.currentTurnId,
        input: [{ type: 'text', text, text_elements: [] }],
      })) as { turnId?: string };
      return { steered: true, turnId: resp?.turnId };
    }
    const r = (await this.send(text, { waitForComplete: true })) as TurnResult;
    return { steered: false, text: r.text };
  }

  /** Mid-turn delivery through `turn/steer`; false when no turn is in flight, rather than starting one. */
  async deliverMidTurn(text: string): Promise<boolean> {
    if (!this.threadId || !this.currentTurnId) return false;
    try {
      await this._request('turn/steer', {
        threadId: this.threadId,
        expectedTurnId: this.currentTurnId,
        input: [{ type: 'text', text, text_elements: [] }],
      });
      return true;
    } catch {
      return false;
    }
  }

  /** Branch this thread into a new one (`thread/fork`); returns the forked thread id. */
  async forkThread(): Promise<{ threadId: string }> {
    if (!this.threadId) throw new Error('No thread id');
    const resp = (await this._request('thread/fork', { threadId: this.threadId })) as { thread?: { id?: string } };
    const newId = resp?.thread?.id;
    if (!newId) throw new Error('thread/fork did not return a forked thread id');
    return { threadId: newId };
  }

  /**
   * Drop the last `numTurns` turns from this thread's conversation.
   *
   * codex 0.171 removed `thread/rollback`; `thread/revert` takes the turn to
   * revert to before instead. The newest `numTurns` turns are listed
   * (`thread/turns/list`, newest first, following the cursor) and the thread is
   * reverted to before the oldest of them. This changes the conversation
   * history only: files the dropped turns edited stay as they are. An
   * ephemeral thread (`noSessionPersistence`) cannot list its turns, so it
   * cannot be rolled back.
   */
  async rollback(numTurns: number): Promise<void> {
    if (!this.threadId) throw new Error('No thread id');
    if (!Number.isInteger(numTurns) || numTurns < 1) throw new Error('rollback: numTurns must be a positive integer');
    if (this.currentTurnId) throw new Error('rollback: a turn is in flight; interrupt it first');
    await revertCodexTurns(this._rpc(), this.threadId, numTurns);
    // The reverted thread goes on in a rollout file of its own.
    this._rolloutFile = undefined;
  }

  /** List available models (`model/list`); returns the `data` array. */
  async listModels(): Promise<unknown[]> {
    const resp = (await this._request('model/list', {})) as { data?: unknown[] };
    return resp?.data ?? [];
  }

  /** List threads (`thread/list`) with optional filters + pagination. */
  async listThreads(
    opts: { cwd?: string; searchTerm?: string; archived?: boolean; cursor?: string; limit?: number } = {},
  ): Promise<{ data: unknown[]; nextCursor: string | null }> {
    const params: Record<string, unknown> = {};
    if (opts.cwd !== undefined) params.cwd = opts.cwd;
    if (opts.searchTerm !== undefined) params.searchTerm = opts.searchTerm;
    if (opts.archived !== undefined) params.archived = opts.archived;
    if (opts.cursor !== undefined) params.cursor = opts.cursor;
    if (opts.limit !== undefined) params.limit = opts.limit;
    params.sourceKinds = LISTED_SOURCE_KINDS;
    const resp = (await this._request('thread/list', params)) as { data?: unknown[]; nextCursor?: string | null };
    return { data: resp?.data ?? [], nextCursor: resp?.nextCursor ?? null };
  }

  // ── Engine commands and capabilities ──────────────────────────────────

  /** The built-in commands (`codex-commands.ts`) and the directory's enabled skills. */
  async listCommands(): Promise<EngineCommand[]> {
    const builtins = codexBuiltinCommands({
      engine: 'codex-app',
      sandboxMode: this.options.sandboxMode || 'workspace-write',
    });
    let skills: CodexSkill[] = [];
    try {
      skills = await this._listSkills();
    } catch (err) {
      this.emit(SESSION_EVENT.LOG, `[codex-app] skills/list failed: ${(err as Error).message}`);
    }
    return [...builtins, ...codexSkillCommands(skills, builtins)];
  }

  /**
   * Run a command through its RPC: an info list, `exec`, `queue`, `turn`,
   * `compact`, `review`, `init`, `implement`, `inject`, `shell` (on a
   * danger-full-access session only), `diff`, or a skill by its name. Slash
   * text is never sent: Codex reads it as a prompt.
   */
  async runCommand(
    name: string,
    args?: string,
    opts: { timeout?: number; callbacks?: StreamCallbacks } = {},
  ): Promise<CommandOutcome> {
    if (!this._isReady || !this.threadId) throw new Error('Session not ready. Call start() first.');
    const timeout = opts.timeout || TURN_TIMEOUT_MS;
    switch (name) {
      case 'rollout': {
        const file = this._rolloutFile ?? findCodexRollout(this.threadId);
        return {
          name,
          ok: !!file,
          text: file ?? 'the thread has no rollout file (an ephemeral thread writes none)',
          data: { path: file ?? null },
          startedTurn: false,
        };
      }
      case 'diff':
        return {
          name,
          ok: true,
          text: this._lastDiff || 'the last turn changed no files',
          data: { diff: this._lastDiff },
          startedTurn: false,
        };
      case 'compact': {
        const outcome = await this.compactDetailed();
        return {
          name,
          ok: outcome.ok,
          text: outcome.ok ? 'compacted' : (outcome.note ?? 'the compaction failed'),
          data: outcome,
          startedTurn: false,
          ...(outcome.ok ? {} : { error: outcome.note }),
        };
      }
      case 'review':
        return this._runReview(args, timeout, opts.callbacks);
      case 'init':
        return this._commandTurn(name, CODEX_INIT_PROMPT, timeout, opts.callbacks);
      case 'inject': {
        const text = args?.trim();
        if (!text) throw new Error('/inject takes the text to add to the thread');
        await this._request(
          'thread/inject_items',
          {
            threadId: this.threadId,
            items: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text }] }],
          },
          60_000,
        );
        return { name, ok: true, text: 'added to the thread history; the next turn reads it', startedTurn: false };
      }
      case 'shell':
        return this._runShell(args, timeout);
      case 'turn':
        return this._turnSettings(args);
      case 'implement':
        return this._implementPlan(args, timeout, opts.callbacks);
    }
    const info = await runCodexInfoCommand(this._rpc(), name, args, {
      engine: 'codex-app',
      cwd: this.options.cwd,
      threadId: this.threadId,
      sandboxPolicy: this._execSandboxPolicy(),
      timeoutMs: timeout,
    });
    // `skills roots` changed where skills are read from.
    if (name === 'skills' && args?.trim()) this._skills = undefined;
    if (info) return info;
    const skill = (await this._listSkills()).find((s) => s.name === name && s.enabled);
    if (skill) return this._commandTurn(name, args?.trim() ?? '', timeout, opts.callbacks, skill.name);
    throw unknownCodexCommand(name, 'codex-app');
  }

  /** A command that runs one model turn (`init`, a skill), as a CommandOutcome. */
  private async _commandTurn(
    name: string,
    text: string,
    timeout: number,
    callbacks: StreamCallbacks | undefined,
    skill?: string,
  ): Promise<CommandOutcome> {
    const input = await this._turnInput(text, {}, skill ?? false);
    this._isBusy = true;
    try {
      const r = await this._runTurn(input, { timeout, callbacks, waitForComplete: true });
      return { name, ok: true, text: r.text, startedTurn: true };
    } catch (err) {
      return { name, ok: false, text: '', startedTurn: true, error: (err as Error).message };
    } finally {
      this._isBusy = false;
    }
  }

  /**
   * The sandbox `/exec` runs in: the thread's own policy (what `thread/start`
   * or the start-time settings update reported, the user's network setting
   * included) with `addDir` writable, else one built from the session's mode.
   */
  private _execSandboxPolicy(): Record<string, unknown> {
    const cwd = this.options.cwd ?? process.cwd();
    return (
      this._addDirSandboxPolicy() ??
      this._threadSandbox ??
      codexSandboxPolicy(
        this.options.sandboxMode,
        (this.options.addDir ?? []).map((d) => path.resolve(cwd, d)),
      )
    );
  }

  /**
   * `turn/settings/update` on the turn in flight: its model, effort or
   * reasoning summary for the rest of that turn only. The thread's settings,
   * and so the turns after it, stay as they were; the rest of the turn bills
   * at the model it switched to. Codex takes it only with its
   * `step_model_switching` feature on (under development and off by default
   * in 0.172.0), so a session that wants it enables the feature itself.
   */
  private async _turnSettings(args: string | undefined): Promise<CommandOutcome> {
    const turnId = this.currentTurnId;
    if (!turnId) {
      throw new Error(
        '/turn changes the turn in flight, and none is running; session_switch_model and the effort switch change the next turns',
      );
    }
    const settings: Record<string, string> = {};
    for (const pair of (args ?? '').trim().split(/\s+/).filter(Boolean)) {
      const m = /^(model|effort|summary)=(\S+)$/.exec(pair);
      if (!m) {
        throw new Error(
          `/turn takes model=<id>, effort=<level> and summary=<auto|concise|detailed|none>, not '${pair}'`,
        );
      }
      settings[m[1]] = m[2];
    }
    if (!Object.keys(settings).length) {
      throw new Error('/turn takes model=<id>, effort=<level> or summary=<auto|concise|detailed|none>');
    }
    const model = settings.model ? resolveAlias(settings.model) : undefined;
    let resp: { status?: string };
    try {
      resp = (await this._request(
        'turn/settings/update',
        {
          threadId: this.threadId,
          turnId,
          ...(model ? { model } : {}),
          ...(settings.effort ? { effort: settings.effort } : {}),
          ...(settings.summary ? { summary: settings.summary } : {}),
        },
        30_000,
      )) as { status?: string };
    } catch (err) {
      if (/step_model_switching/.test((err as Error).message)) {
        throw new Error(
          "/turn needs Codex's step_model_switching feature, which is off by default: start the session with " +
            "codexFeatures { enable: ['step_model_switching'] }",
        );
      }
      throw err;
    }
    const applied = resp?.status === 'applied';
    if (applied && model && this.currentTurnId === turnId) {
      this._turnModel = model;
      this._turnSettingsTurnId = turnId;
    }
    const changed = { ...settings, ...(model ? { model } : {}) };
    return {
      name: 'turn',
      ok: applied,
      text: applied
        ? `turn ${turnId}: ${Object.entries(changed)
            .map(([k, v]) => `${k} ${v}`)
            .join(', ')} for the rest of the turn`
        : `turn ${turnId} ended before the change reached it`,
      data: { turnId, status: resp?.status ?? null, ...changed },
      startedTurn: false,
      ...(applied ? {} : { error: `turn ${turnId} ended before the change reached it` }),
    };
  }

  /**
   * `thread/prepareApprovedPlan`, then the turn it prepares: the plan goes into
   * the thread's context as the plan tool's output, and Codex's own prompt
   * ("Implement the plan.") runs. A plan given as a file is read here and also
   * named as the attachment, which Codex then has the turn read instead.
   */
  private async _implementPlan(
    args: string | undefined,
    timeout: number,
    callbacks: StreamCallbacks | undefined,
  ): Promise<CommandOutcome> {
    const text = args?.trim();
    if (!text) throw new Error('/implement takes the approved plan, or the path of a file that holds it');
    if (this.currentTurnId) {
      throw new Error('implement: a turn is in flight on the thread; wait for it or interrupt it');
    }
    let markdown = text;
    let attachmentPath: string | undefined;
    if (!/\s/.test(text)) {
      const file = path.resolve(this.options.cwd ?? process.cwd(), text);
      if (fs.existsSync(file) && fs.statSync(file).isFile()) {
        markdown = fs.readFileSync(file, 'utf8');
        attachmentPath = file;
      }
    }
    const resp = (await this._request(
      'thread/prepareApprovedPlan',
      { threadId: this.threadId, markdown, ...(attachmentPath ? { attachmentPath } : {}) },
      60_000,
    )) as { prompt?: string };
    return this._commandTurn('implement', resp?.prompt || 'Implement the plan.', timeout, callbacks);
  }

  /**
   * `review/start` on this thread, inline: the review turn's id comes back in
   * the response, and its answer is the `exitedReviewMode` item. The reviewer
   * reports no usage while it runs, so its rollout is read when it ends.
   */
  private async _runReview(
    args: string | undefined,
    timeout: number,
    callbacks: StreamCallbacks | undefined,
  ): Promise<CommandOutcome> {
    if (this.currentTurnId) throw new Error('review: a turn is in flight on the thread; wait for it or interrupt it');
    const since = Date.now();
    const onText = (chunk: string) => {
      try {
        callbacks?.onText?.(chunk);
      } catch {
        // User callback errors are not fatal.
      }
    };
    this.on(SESSION_EVENT.TEXT, onText);
    this._isBusy = true;
    try {
      const id = await this._startTurn({ threadId: this.threadId, target: codexReviewTarget(args) }, 'review/start');
      const turn = await this._awaitTurn(id, 'review', timeout);
      await this._addReviewerUsage(since);
      const ok = turn.status === 'completed';
      return {
        name: 'review',
        ok,
        text: turn.review ?? turn.text,
        startedTurn: true,
        ...(ok ? {} : { error: turn.errorMessage ?? `the review ended ${turn.status}` }),
      };
    } finally {
      this._isBusy = false;
      this.removeListener(SESSION_EVENT.TEXT, onText);
    }
  }

  /** The reviewer thread's spend, from its rollout; read again once if codex has not written it yet. */
  private async _addReviewerUsage(since: number): Promise<void> {
    if (!this.threadId || this.options.noSessionPersistence || !fs.existsSync(codexSessionsRoot())) return;
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = reviewRolloutUsage(this.threadId, since);
      if (r.totals) {
        this._recordExtraUsage(r.totals, r.model);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  /**
   * `thread/shellCommand`, the TUI's `!cmd`. It runs unsandboxed, whatever the
   * thread's sandbox, so it is refused unless the session already runs
   * `danger-full-access`. Its turn is no model turn.
   */
  private async _runShell(args: string | undefined, timeout: number): Promise<CommandOutcome> {
    if ((this.options.sandboxMode || 'workspace-write') !== 'danger-full-access') {
      throw new Error(
        '/shell runs its command unsandboxed (thread/shellCommand), so it runs only on a danger-full-access session',
      );
    }
    const command = args?.trim();
    if (!command) throw new Error('/shell takes the command to run');
    if (this.currentTurnId) throw new Error('shell: a turn is in flight on the thread; wait for it or interrupt it');
    const turn = await this._claimNextTurn('shell', timeout + 5_000, () =>
      this._request('thread/shellCommand', { threadId: this.threadId, command, timeoutMs: timeout }),
    );
    const exitCode = turn.shellExitCode ?? null;
    const ok = turn.status === 'completed' && (exitCode === null || exitCode === 0);
    return {
      name: 'shell',
      ok,
      text: turn.shellOutput ?? '',
      data: { exitCode },
      startedTurn: false,
      ...(ok ? {} : { error: `the command exited with ${exitCode ?? turn.status}` }),
    };
  }

  /**
   * A side question (`thread/sample`): answered from the thread's context, not
   * added to it, no tools. It samples after the thread's latest turn, the one
   * in flight included. Its usage is in the response only, so it is added here.
   */
  async askAside(question: string, opts: { timeout?: number } = {}): Promise<AsideOutcome> {
    if (!this._isReady || !this.threadId) throw new Error('Session not ready. Call start() first.');
    const inFlight = this.currentTurnId;
    const expectedTurnId =
      inFlight ?? this._lastFinishedTurnId ?? (await latestCodexTurnId(this._rpc(), this.threadId));
    if (!expectedTurnId) {
      throw new Error('a side question samples the thread after a turn; send a first message');
    }
    let sampleId: number | undefined;
    let resp: {
      text?: string | null;
      inputTokens?: number | null;
      cachedInputTokens?: number | null;
      outputTokens?: number | null;
    };
    try {
      resp = (await this._request(
        'thread/sample',
        {
          threadId: this.threadId,
          expectedTurnId,
          prompt: question,
          ...(inFlight ? { allowInProgressTurn: true } : {}),
        },
        opts.timeout || TURN_TIMEOUT_MS,
        (id) => (sampleId = id),
      )) as typeof resp;
    } catch (err) {
      // A sample nobody waits for still runs, and spends what no response will count.
      if ((err as { timedOut?: boolean }).timedOut && sampleId !== undefined) {
        this._request('thread/sample/cancel', { requestId: sampleId }, 10_000).catch(() => undefined);
      }
      throw err;
    }
    this._recordExtraUsage({
      input: resp?.inputTokens ?? 0,
      cached: resp?.cachedInputTokens ?? 0,
      output: resp?.outputTokens ?? 0,
    });
    if (typeof resp?.text !== 'string') {
      throw new Error(
        'the side question got no text answer: the model tried to call a tool, which a side question cannot',
      );
    }
    return { text: resp.text };
  }

  /** Drop the last `turns` turns (`thread/revert`); the files they changed stay changed. */
  async rewind(target: RewindTarget): Promise<RewindOutcome> {
    if (target.messageId !== undefined) {
      throw new Error('codex-app rewinds by turns (thread/revert), not to a message; give turns');
    }
    if (target.files) {
      throw new Error(
        'restoring files on rewind is not supported on codex-app: thread/revert changes the conversation only; omit files',
      );
    }
    const turns = target.turns ?? 1;
    await this.rollback(turns);
    return { ok: true, turnsRemoved: turns, filesRestored: false };
  }

  /** Switch the thread's model in place (`thread/settings/update`); later turns bill at it. */
  async setModelLive(model: string): Promise<boolean> {
    if (!this._isReady || !this.threadId) return false;
    await this._request('thread/settings/update', { threadId: this.threadId, model }, 30_000);
    this.options.model = model;
    this._reroutedModel = undefined;
    this._modelOverridden = false;
    return true;
  }

  /** Switch the thread's effort in place; `auto` has no value to set, so it waits for the next turn. */
  async setEffortLive(level: EffortLevel): Promise<boolean> {
    const effort = codexReasoningEffort(level);
    if (!effort || !this._isReady || !this.threadId) return false;
    await this._request('thread/settings/update', { threadId: this.threadId, effort }, 30_000);
    this._effortOverridden = false;
    return true;
  }

  /** The last request's prompt against the window codex enforces; codex gives no categories. */
  async contextBreakdown(): Promise<ContextBreakdown | undefined> {
    if (this._lastTurnTokensIn <= 0) return undefined;
    const window = this._modelContextWindow ?? getContextWindow(this._billedModel() || 'gpt-5.5');
    return { totalTokens: this._lastTurnTokensIn, ...(window ? { windowTokens: window } : {}) };
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  /**
   * Report an error to whoever listens. An `error` notification is news about
   * the thread — the server often retries on its own, and a failed turn is
   * already reported by `turn/completed` — so it must not reach Node's
   * unhandled-`'error'` rule, which throws: with no listener attached, one
   * overloaded-endpoint notice took the whole server down.
   */
  private _emitError(err: Error): void {
    if (this.listenerCount(SESSION_EVENT.ERROR) > 0) this.emit(SESSION_EVENT.ERROR, err);
    else this.emit(SESSION_EVENT.LOG, `[codex-app] ${err.message}`);
  }

  private _addHistory(entry: { time: string; type: string; event: unknown }): void {
    this._history.push(entry);
    if (this._history.length > MAX_HISTORY_ITEMS) this._history.shift();
  }

  /**
   * How full the thread's context is right now.
   *
   * Both inputs come straight from `thread/tokenUsage/updated`: the turn's own
   * prompt (`last`) and the window the server is actually enforcing. The
   * registry window is only a fallback — it holds the model's published maximum
   * (1.05M for gpt-5.x) while codex caps threads far below that, so measuring
   * against it reads several times too low.
   */
  private _estimateContextPercent(): number {
    if (this._lastTurnTokensIn <= 0) return 0;
    const ctx = this._modelContextWindow ?? getContextWindow(this._billedModel() || 'gpt-5.5');
    if (!ctx) return 0;
    return Math.min(100, Math.round((this._lastTurnTokensIn / ctx) * 100));
  }

  /** The model the server rerouted the thread to, else the configured one, else the one it reported. */
  private _billedModel(): string | undefined {
    return this._reroutedModel || this.options.model || this._reportedModel;
  }
}
