/**
 * Persistent Codex App-Server Session — wraps `codex app-server`
 *
 * Unlike `PersistentCodexSession` (which spawns `codex exec` per send), this
 * session keeps a long-running `codex app-server --listen stdio://` subprocess
 * and speaks Codex's v2 JSON-RPC 2.0 protocol over its stdin/stdout.
 *
 * The motivation is the `/goal` long-horizon objective system, which is
 * exclusively available through the app-server protocol — `codex exec` has no
 * access to it. The flag `goals` is feature-flagged in 0.128 (default off);
 * we lift it per-session via `--enable goals` rather than touching global
 * config.
 *
 * Protocol notes (verified against codex-cli 0.128.0):
 *   - Frames are line-delimited JSON-RPC 2.0 messages over stdio.
 *   - Lifecycle: `initialize` → `thread/start` → `turn/start` (per send).
 *   - Goal lifecycle is **observation-only** for clients: there are no
 *     `thread/goal/*` request RPCs. Goal mutation is driven by sending the
 *     slash-commands `/goal <obj>` / `/goal pause` / `/goal resume` /
 *     `/goal clear` as plain user text via `turn/start`; the server-side
 *     parser interprets them and emits `thread/goal/updated` /
 *     `thread/goal/cleared` notifications.
 */

import { ChildProcess } from 'node:child_process';
import { spawnEngine } from './engine-spawn.js';
import { EventEmitter } from 'node:events';
import * as readline from 'node:readline';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type {
  SessionConfig,
  SessionStats,
  EffortLevel,
  StreamEvent,
  ISession,
  SessionSendOptions,
  TurnResult,
  CostBreakdown,
} from './types.js';
import { getModelPricing, resolveAlias, getContextWindow } from './models.js';
import { SESSION_EVENT, MAX_HISTORY_ITEMS, DEFAULT_HISTORY_LIMIT } from './constants.js';

// ─── Hand-translated protocol types (subset we use) ────────────────────────
//
// Mirrors `codex app-server generate-ts` output. Kept inline because we only
// touch a small slice; if upstream churn becomes painful, swap in the full
// generated bindings under `src/generated/codex-app/`.

type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
type ThreadGoalStatus = 'active' | 'paused' | 'budgetLimited' | 'complete';

interface ThreadGoal {
  threadId: string;
  objective: string;
  status: ThreadGoalStatus;
  createdAt: number;
  updatedAt: number;
  timeUsedSeconds: number;
  tokensUsed: number;
  tokenBudget?: number | null;
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
  item: { type: string; id?: string; text?: string };
}

interface AgentMessageDeltaNotification {
  threadId: string;
  turnId: string;
  itemId?: string;
  delta?: string;
}

interface TurnCompletedNotification {
  threadId: string;
  turn: { id: string; status: string };
}

// ─── PersistentCodexAppServerSession ───────────────────────────────────────

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  method: string;
}

export class PersistentCodexAppServerSession extends EventEmitter implements ISession {
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
  private currentTurnId?: string;
  private currentGoal: ThreadGoal | null = null;

  // Per-turn buffers (reset at each send)
  private turnAssistantText = '';
  private turnResolve: ((r: TurnResult) => void) | null = null;
  private turnReject: ((e: Error) => void) | null = null;

  public sessionId?: string;
  private _stats = {
    turns: 0,
    toolCalls: 0,
    toolErrors: 0,
    tokensIn: 0,
    tokensOut: 0,
    cachedTokens: 0,
    costUsd: 0,
    lastActivity: null as string | null,
  };

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

  // ── Lifecycle ──────────────────────────────────────────────────────────

  async start(): Promise<this> {
    if (this.options.cwd) {
      this.options.cwd = path.resolve(this.options.cwd);
      if (!fs.existsSync(this.options.cwd)) fs.mkdirSync(this.options.cwd, { recursive: true });
    }

    const args = ['app-server', '--listen', 'stdio://', '--enable', 'goals'];
    this.proc = spawnEngine(this.codexBin, args, {
      cwd: this.options.cwd,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this._rl = readline.createInterface({ input: this.proc.stdout!, crlfDelay: Infinity });
    this._rl.on('line', (line) => this._handleLine(line));

    this.proc.stderr?.on('data', (data: Buffer) => {
      this.emit(SESSION_EVENT.LOG, `[codex-app-stderr] ${data.toString()}`);
    });

    this.proc.on('exit', (code) => {
      this._isReady = false;
      // Reject any pending requests so callers don't hang.
      for (const pending of this.pendingRequests.values()) {
        pending.reject(new Error(`codex app-server exited (code=${code}) before responding`));
      }
      this.pendingRequests.clear();
      if (this.turnReject) {
        this.turnReject(new Error(`codex app-server exited mid-turn (code=${code})`));
        this.turnReject = null;
        this.turnResolve = null;
      }
      this.emit(SESSION_EVENT.CLOSE, code ?? 0);
    });

    // 1. initialize
    await this._request('initialize', {
      clientInfo: { name: 'claw-orchestrator', title: null, version: '3.0.0' },
    });

    // 2. thread/start — captures threadId both from the response and the
    //    `thread/started` notification (which arrives before the response per
    //    observed protocol semantics).
    const threadResp = (await this._request('thread/start', {
      cwd: this.options.cwd,
      model: this.options.model,
      sandbox: (this.options.sandboxMode || 'workspace-write') as SandboxMode,
    })) as { thread?: { id?: string } };
    if (!this.threadId && threadResp?.thread?.id) {
      this.threadId = threadResp.thread.id;
    }
    if (!this.threadId) {
      throw new Error('codex app-server did not return a thread id from thread/start');
    }

    this.sessionId = `codex-app-${this.threadId.slice(0, 8)}-${Date.now().toString(36)}`;
    this._startTime = new Date().toISOString();
    this._isReady = true;
    this.emit(SESSION_EVENT.READY);
    this.emit(SESSION_EVENT.INIT, { type: 'system', subtype: 'init', session_id: this.sessionId });
    return this;
  }

  stop(): void {
    if (this._rl) {
      this._rl.close();
      this._rl = null;
    }
    if (this.proc) {
      try {
        this.proc.kill('SIGTERM');
      } catch {
        // Already gone.
      }
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

    if (!options.waitForComplete) {
      this._fireAndForgetTurn(text).catch((err) => this.emit(SESSION_EVENT.ERROR, err));
      return { requestId: this._nextRpcId, sent: true };
    }

    this._isBusy = true;
    try {
      return await this._runTurn(text, options);
    } finally {
      this._isBusy = false;
    }
  }

  private async _fireAndForgetTurn(text: string): Promise<void> {
    await this._request('turn/start', {
      threadId: this.threadId,
      input: [{ type: 'text', text, text_elements: [] }],
    });
  }

  private async _runTurn(text: string, options: SessionSendOptions): Promise<TurnResult> {
    const timeout = options.timeout || 600_000;
    this.turnAssistantText = '';

    const turnPromise = new Promise<TurnResult>((resolve, reject) => {
      this.turnResolve = resolve;
      this.turnReject = reject;
    });

    // Wire up text streaming for this turn
    const onText = (chunk: string) => {
      try {
        options.callbacks?.onText?.(chunk);
      } catch {
        // User callback errors are not fatal.
      }
    };
    this.on(SESSION_EVENT.TEXT, onText);

    const timer = setTimeout(() => {
      if (this.turnReject) {
        const r = this.turnReject;
        this.turnResolve = null;
        this.turnReject = null;
        r(new Error('Timeout waiting for Codex app-server turn to complete'));
      }
    }, timeout);

    try {
      await this._request('turn/start', {
        threadId: this.threadId,
        input: [{ type: 'text', text, text_elements: [] }],
      });
      const result = await turnPromise;
      return result;
    } finally {
      clearTimeout(timer);
      this.removeListener(SESSION_EVENT.TEXT, onText);
    }
  }

  // ── JSON-RPC plumbing ──────────────────────────────────────────────────

  private _request(method: string, params: unknown): Promise<unknown> {
    if (!this.proc?.stdin?.writable) {
      return Promise.reject(new Error('codex app-server stdin not writable'));
    }
    const id = this._nextRpcId++;
    const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject, method });
      this.proc!.stdin!.write(msg, (err) => {
        if (err) {
          this.pendingRequests.delete(id);
          reject(err);
        }
      });
    });
  }

  private _handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: {
      jsonrpc?: string;
      id?: number;
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

    // Notification (has method, no id)
    if (msg.method) {
      this._dispatchNotification(msg.method, msg.params);
    }
  }

  private _dispatchNotification(method: string, params: unknown): void {
    switch (method) {
      case 'thread/started': {
        const p = params as ThreadStartedNotification;
        if (p.thread?.id && !this.threadId) this.threadId = p.thread.id;
        break;
      }
      case 'turn/started': {
        const p = params as { threadId: string; turn: { id: string } };
        this.currentTurnId = p.turn?.id;
        break;
      }
      case 'item/agentMessage/delta': {
        const p = params as AgentMessageDeltaNotification;
        if (typeof p.delta === 'string' && p.delta.length > 0) {
          this.turnAssistantText += p.delta;
          this.emit(SESSION_EVENT.TEXT, p.delta);
        }
        break;
      }
      case 'item/completed': {
        const p = params as ItemCompletedNotification;
        if (p.item?.type === 'agentMessage' && typeof p.item.text === 'string') {
          // Agent messages may arrive as one final text payload (when no
          // delta stream was used). Only append if we haven't already
          // accumulated this turn's text via deltas.
          if (this.turnAssistantText.length === 0) {
            this.turnAssistantText = p.item.text;
            this.emit(SESSION_EVENT.TEXT, p.item.text);
          }
        }
        break;
      }
      case 'thread/tokenUsage/updated': {
        const p = params as ThreadTokenUsageUpdatedNotification;
        if (p.tokenUsage?.total) {
          // Replace (not increment) — the server reports cumulative totals.
          this._stats.tokensIn = p.tokenUsage.total.inputTokens;
          this._stats.tokensOut = p.tokenUsage.total.outputTokens + p.tokenUsage.total.reasoningOutputTokens;
          this._stats.cachedTokens = p.tokenUsage.total.cachedInputTokens;
          this._updateCost();
        }
        break;
      }
      case 'thread/goal/updated': {
        const p = params as ThreadGoalUpdatedNotification;
        if (p.goal) this.currentGoal = p.goal;
        this.emit('goal:updated', this.currentGoal);
        break;
      }
      case 'thread/goal/cleared': {
        this.currentGoal = null;
        this.emit('goal:cleared');
        break;
      }
      case 'turn/completed': {
        const p = params as TurnCompletedNotification;
        this._stats.turns++;
        this._stats.lastActivity = new Date().toISOString();
        const turnText = this.turnAssistantText;
        const event: StreamEvent = {
          type: 'result',
          result: turnText,
          stop_reason: p.turn?.status === 'failed' ? 'error' : 'end_turn',
          session_id: this.threadId,
        };
        this.emit(SESSION_EVENT.RESULT, event);
        this.emit(SESSION_EVENT.TURN_COMPLETE, event);
        if (this.turnResolve) {
          const r = this.turnResolve;
          this.turnResolve = null;
          this.turnReject = null;
          r({ text: turnText, event });
        }
        break;
      }
      case 'error': {
        const p = params as { message?: string };
        this.emit(SESSION_EVENT.ERROR, new Error(p.message ?? 'codex app-server error'));
        break;
      }
      default:
        // Unhandled notifications still go to history for debugging
        break;
    }
  }

  // ── ISession surface ───────────────────────────────────────────────────

  getStats(): SessionStats & { sessionId?: string; uptime: number; goal?: ThreadGoal | null } {
    return {
      turns: this._stats.turns,
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

  async compact(_summary?: string): Promise<TurnResult> {
    // Codex has its own `thread/compact/start` RPC, but the existing public
    // ISession contract returns a TurnResult. Wire it as a request, ignore
    // the response shape, and return a synthesized result.
    if (!this.threadId) throw new Error('No thread id');
    await this._request('thread/compact/start', { threadId: this.threadId });
    const event: StreamEvent = { type: 'result', result: 'Codex thread compaction started' };
    return { text: 'Codex thread compaction started', event };
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
    const pricing = getModelPricing(this.options.model, 'gpt-5.5');
    const cachedPrice = pricing.cached ?? 0;
    const nonCachedIn = Math.max(0, this._stats.tokensIn - this._stats.cachedTokens);
    return {
      model: this.options.model || 'gpt-5.5',
      tokensIn: this._stats.tokensIn,
      tokensOut: this._stats.tokensOut,
      cachedTokens: this._stats.cachedTokens,
      pricing: { inputPer1M: pricing.input, outputPer1M: pricing.output, cachedPer1M: cachedPrice || undefined },
      breakdown: {
        inputCost: (nonCachedIn / 1_000_000) * pricing.input,
        cachedCost: (this._stats.cachedTokens / 1_000_000) * cachedPrice,
        outputCost: (this._stats.tokensOut / 1_000_000) * pricing.output,
      },
      totalUsd: this._stats.costUsd,
    };
  }

  // ── Public goal helpers (used by codex_goal_* tools) ───────────────────

  /**
   * Send a `/goal <args>` slash command as a regular user turn. The
   * server-side parser handles the actual goal mutation and emits a
   * `thread/goal/updated` or `thread/goal/cleared` notification.
   *
   * Awaits the resulting turn, then returns the cached goal state at
   * turn-end (which reflects the post-mutation state in the common case).
   */
  async sendGoalCommand(slashArgs: string, timeoutMs = 120_000): Promise<{ text: string; goal: ThreadGoal | null }> {
    const text = `/goal${slashArgs.length > 0 ? ' ' + slashArgs : ''}`;
    const result = (await this.send(text, { waitForComplete: true, timeout: timeoutMs })) as TurnResult;
    return { text: result.text, goal: this.currentGoal };
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  private _addHistory(entry: { time: string; type: string; event: unknown }): void {
    this._history.push(entry);
    if (this._history.length > MAX_HISTORY_ITEMS) this._history.shift();
  }

  private _estimateContextPercent(): number {
    const ctx = getContextWindow(this.options.model || 'gpt-5.5');
    if (!ctx) return 0;
    return Math.min(100, Math.round(((this._stats.tokensIn + this._stats.tokensOut) / ctx) * 100));
  }

  private _updateCost(): void {
    const pricing = getModelPricing(this.options.model, 'gpt-5.5');
    const cachedPrice = pricing.cached ?? 0;
    const nonCachedIn = Math.max(0, this._stats.tokensIn - this._stats.cachedTokens);
    this._stats.costUsd =
      (nonCachedIn / 1_000_000) * pricing.input +
      (this._stats.cachedTokens / 1_000_000) * cachedPrice +
      (this._stats.tokensOut / 1_000_000) * pricing.output;
  }
}
