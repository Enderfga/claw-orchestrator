/**
 * Base class for one-shot (process-per-send) session engines.
 *
 * Shared by Codex, Gemini, and Cursor — eliminates ~200 LOC of duplication
 * per engine. Subclasses only implement _run() (engine-specific CLI invocation)
 * and optionally override _cleanupProc() for extra cleanup (readline, streams).
 */

import { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  type SessionConfig,
  type SessionStats,
  type EffortLevel,
  type StreamEvent,
  type ISession,
  type SessionSendOptions,
  type TurnResult,
  type CostBreakdown,
  getModelPricing as _getModelPricingBase,
} from './types.js';
import { resolveAlias, getContextWindow } from './models.js';
import { MAX_HISTORY_ITEMS, DEFAULT_HISTORY_LIMIT, SESSION_EVENT } from './constants.js';

// ─── Engine Configuration ──────────────────────────────────────────────────

/**
 * Parameterizes engine-specific behavior without requiring method overrides.
 * Passed to the BaseOneShotSession constructor by each subclass.
 */
export interface OneShotEngineConfig {
  /** Prefix for session ID generation, e.g. 'codex', 'gemini', 'cursor' */
  enginePrefix: string;
  /** Fallback model for pricing lookups when session has no explicit model */
  defaultModel: string;
  /** Model name shown in getCost() output; defaults to defaultModel if omitted */
  defaultModelDisplay?: string;
  /** Whether this engine tracks cached token pricing (Codex=false, Gemini/Cursor=true) */
  supportsCachedTokens: boolean;
  /** Human-readable engine name for compact() no-op message */
  engineDisplayName: string;
}

// ─── BaseOneShotSession ────────────────────────────────────────────────────

export abstract class BaseOneShotSession extends EventEmitter implements ISession {
  protected options: SessionConfig;
  protected engineBin: string;
  protected engineCfg: OneShotEngineConfig;

  private _isReady = false;
  private _isPaused = false;
  private _isBusy = false;
  /** Input tokens for the most recent turn only — see _recordTurnInputTokens(). */
  private _lastTurnTokensIn = 0;
  /** Set when a subclass reported the turn's prompt size itself for this turn. */
  private _turnTokensExplicit = false;
  /** Ensures the "cannot compact" warning is emitted once, not once per turn. */
  private _warnedNoCompaction = false;
  protected currentProc: ChildProcess | null = null;
  private currentRequestId = 0;
  private _startTime: string | null = null;
  private _history: Array<{ time: string; type: string; event: unknown }> = [];

  public sessionId?: string;
  protected _stats = {
    turns: 0,
    turnsSucceeded: 0,
    toolCalls: 0,
    toolErrors: 0,
    tokensIn: 0,
    tokensOut: 0,
    cachedTokens: 0,
    costUsd: 0,
    lastActivity: null as string | null,
    /** Set by _markTurnEstimated() when this turn fell back to estimateTokens(). */
    tokensEstimated: false,
  };

  constructor(config: SessionConfig, bin: string, engineCfg: OneShotEngineConfig) {
    super();
    this.engineBin = bin;
    this.engineCfg = engineCfg;
    this.options = {
      ...config,
      permissionMode: config.permissionMode || 'bypassPermissions',
    };
  }

  // ── Property Accessors ─────────────────────────────────────────────────

  get pid(): number | undefined {
    return this.currentProc?.pid ?? undefined;
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

  // ── start() ────────────────────────────────────────────────────────────

  async start(): Promise<this> {
    if (this.options.cwd) {
      this.options.cwd = path.resolve(this.options.cwd);
      if (!fs.existsSync(this.options.cwd)) {
        fs.mkdirSync(this.options.cwd, { recursive: true });
      }
    }
    this.sessionId = `${this.engineCfg.enginePrefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    this._startTime = new Date().toISOString();
    this._isReady = true;
    this.emit(SESSION_EVENT.READY);
    this.emit(SESSION_EVENT.INIT, { type: 'system', subtype: 'init', session_id: this.sessionId });
    return this;
  }

  // ── send() ─────────────────────────────────────────────────────────────

  async send(
    message: string | unknown[],
    options: SessionSendOptions = {},
  ): Promise<TurnResult | { requestId: number; sent: boolean }> {
    if (!this._isReady) throw new Error('Session not ready. Call start() first.');
    const requestId = ++this.currentRequestId;
    const textMessage = typeof message === 'string' ? message : JSON.stringify(message);

    // Per-turn flag: cleared here, set only if this turn takes the estimate
    // fallback. Reading it after the turn tells the ledger whether the numbers
    // it is about to record were measured or guessed.
    this._stats.tokensEstimated = false;

    if (!options.waitForComplete) {
      const before = this._stats.tokensIn;
      this._run(textMessage, options)
        .then(() => this._recordTurnInputTokens(before))
        .catch((err) => this.emit(SESSION_EVENT.ERROR, err));
      return { requestId, sent: true };
    }

    this._isBusy = true;
    const tokensInBefore = this._stats.tokensIn;
    try {
      return await this._run(textMessage, options);
    } finally {
      this._recordTurnInputTokens(tokensInBefore);
      this._isBusy = false;
    }
  }

  /**
   * Capture this turn's own input-token count.
   *
   * Subclasses accumulate into `_stats.tokensIn`, so the running total is the
   * sum over every turn — useless for "how full is the context right now".
   * Taking the delta around `_run()` gives the size of the prompt the engine
   * actually just processed, which for a thread-resuming engine (codex, agy) is
   * the live thread size. Without this, `contextPercent` was pinned at 0 and any
   * consumer gating on it — such as the openai-compat auto-compaction — could
   * never fire for a one-shot engine, so a thread grew until the CLI hard-failed
   * with a context-window error instead of degrading.
   */
  private _recordTurnInputTokens(before: number): void {
    // A subclass that can read the turn's prompt size directly wins over the
    // delta heuristic, which is only correct when `_stats.tokensIn` accumulates
    // per-turn values. Codex reports cumulative thread totals instead, so it
    // reports the subtraction itself — see PersistentCodexSession.
    if (this._turnTokensExplicit) {
      this._turnTokensExplicit = false;
      return;
    }
    const delta = this._stats.tokensIn - before;
    if (delta > 0) this._lastTurnTokensIn = delta;
  }

  /**
   * Report the exact prompt size for the turn currently running, overriding the
   * delta heuristic in `_recordTurnInputTokens()` for this turn only.
   */
  protected _reportTurnInputTokens(tokens: number): void {
    if (tokens > 0) {
      this._lastTurnTokensIn = tokens;
      this._turnTokensExplicit = true;
    }
  }

  /**
   * The context window `contextPercent` is measured against.
   *
   * Defaults to the registry entry for the session's model. Subclasses override
   * when the CLI enforces a smaller window than the model itself supports: the
   * number that matters here is the one that actually fails the request, not the
   * model's published maximum. Return 0 to disable the metric.
   */
  protected _effectiveContextWindow(): number {
    return getContextWindow(this.options.resolvedModel || this.options.model || '');
  }

  /**
   * How full the engine's context is, as a percentage of the model's window.
   *
   * Based on the last turn's input tokens rather than the running total: for an
   * engine that resumes a thread that is the live prompt size, and for one that
   * starts fresh each send it is that send's prompt. Returns 0 until a turn has
   * reported usage, so an engine that reports nothing behaves as before.
   */
  private _contextPercent(): number {
    if (this._lastTurnTokensIn <= 0) return 0;
    const window = this._effectiveContextWindow();
    if (!window) return 0;
    return Math.min(100, Math.round((this._lastTurnTokensIn / window) * 100));
  }

  /** Engine-specific: spawn the CLI and return a TurnResult. */
  protected abstract _run(message: string, options: SessionSendOptions): Promise<TurnResult>;

  // ── getStats() ─────────────────────────────────────────────────────────

  getStats(): SessionStats & { sessionId?: string; uptime: number } {
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
      contextPercent: this._contextPercent(),
      retries: 0,
      tokensEstimated: this._stats.tokensEstimated,
      sessionId: this.sessionId,
      uptime: this._startTime ? Math.round((Date.now() - new Date(this._startTime).getTime()) / 1000) : 0,
    };
  }

  // ── getHistory() ───────────────────────────────────────────────────────

  getHistory(limit = DEFAULT_HISTORY_LIMIT): Array<{ time: string; type: string; event: unknown }> {
    return this._history.slice(-limit);
  }

  // ── compact() ──────────────────────────────────────────────────────────

  /**
   * No-op for one-shot engines, but a *visible* one.
   *
   * The openai-compat auto-compaction gate calls this whenever contextPercent
   * crosses its threshold and discards the result, so an engine that cannot
   * compact used to fail silently: the thread kept growing until the CLI hard-
   * failed with a context-window error and nothing in the logs said why. The
   * warning is emitted once per session — the gate re-fires every turn once the
   * threshold is crossed, and repeating it would drown the log channel.
   */
  async compact(_summary?: string): Promise<TurnResult> {
    const message = `${this.engineCfg.engineDisplayName} engine does not support compaction`;
    if (!this._warnedNoCompaction) {
      this._warnedNoCompaction = true;
      this.emit(
        SESSION_EVENT.LOG,
        `[${this.engineCfg.enginePrefix}] ${message} — context will keep growing until the CLI refuses the request`,
      );
    }
    const event: StreamEvent = { type: 'result', result: message };
    return { text: message, event };
  }

  // ── Effort ─────────────────────────────────────────────────────────────

  getEffort(): EffortLevel {
    return this.options.effort || 'auto';
  }
  setEffort(level: EffortLevel): void {
    this.options.effort = level;
  }

  // ── getCost() ──────────────────────────────────────────────────────────

  getCost(): CostBreakdown {
    const pricing = this._getModelPricing();
    const displayModel = this.options.model || this.engineCfg.defaultModelDisplay || this.engineCfg.defaultModel;

    if (this.engineCfg.supportsCachedTokens) {
      const cachedPrice = pricing.cached ?? 0;
      const nonCachedIn = Math.max(0, this._stats.tokensIn - this._stats.cachedTokens);
      return {
        model: displayModel,
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
    // Non-cached path (e.g. Codex)
    return {
      model: displayModel,
      tokensIn: this._stats.tokensIn,
      tokensOut: this._stats.tokensOut,
      cachedTokens: 0,
      pricing: { inputPer1M: pricing.input, outputPer1M: pricing.output, cachedPer1M: undefined },
      breakdown: {
        inputCost: (this._stats.tokensIn / 1_000_000) * pricing.input,
        cachedCost: 0,
        outputCost: (this._stats.tokensOut / 1_000_000) * pricing.output,
      },
      totalUsd: this._stats.costUsd,
    };
  }

  // ── resolveModel() ─────────────────────────────────────────────────────

  resolveModel(alias: string): string {
    return resolveAlias(alias);
  }

  // ── pause / resume ─────────────────────────────────────────────────────

  pause(): void {
    this._isPaused = true;
    this.emit(SESSION_EVENT.PAUSED, { sessionId: this.sessionId });
  }
  resume(): void {
    this._isPaused = false;
    this.emit(SESSION_EVENT.RESUMED, { sessionId: this.sessionId });
  }

  // ── stop() ─────────────────────────────────────────────────────────────

  stop(): void {
    this._cleanupProc();
    this._isReady = false;
    this._isPaused = false;
    this.emit(SESSION_EVENT.CLOSE, 143);
  }

  /** Override in subclasses that need extra cleanup (readline, stream destroy). */
  protected _cleanupProc(): void {
    if (this.currentProc) {
      try {
        this.currentProc.kill('SIGTERM');
      } catch {
        // Process may have already exited
      }
      this.currentProc = null;
    }
  }

  // ── Protected Helpers (for subclass _run() implementations) ────────────

  protected _getModelPricing() {
    return _getModelPricingBase(this.options.model, this.engineCfg.defaultModel);
  }

  /**
   * Call once from a subclass's close handler, with the same expression that
   * decides the turn's `stop_reason` and whether its promise resolves.
   *
   * `ok` is a required parameter rather than a second method so that the outcome
   * has one expression per engine: a turn classified as succeeded here cannot
   * disagree with the `stop_reason` built beside it.
   */
  protected _recordTurnComplete(ok: boolean): void {
    this._stats.turns++;
    if (ok) this._stats.turnsSucceeded++;
    this._stats.lastActivity = new Date().toISOString();
  }

  /**
   * Call from the estimateTokens() fallback branch of a subclass's _run(). Marks
   * this turn's token counts (and therefore its cost) as estimated so the run
   * ledger can label them instead of presenting a guess as a measurement.
   */
  protected _markTurnEstimated(): void {
    this._stats.tokensEstimated = true;
  }

  protected _addHistory(event: { text: string; code: number | null }): void {
    const now = this._stats.lastActivity || new Date().toISOString();
    this._history.push({ time: now, type: 'result', event });
    if (this._history.length > MAX_HISTORY_ITEMS) this._history.shift();
  }

  protected _updateCost(): void {
    const pricing = this._getModelPricing();
    if (this.engineCfg.supportsCachedTokens) {
      const cachedPrice = pricing.cached ?? 0;
      const nonCachedIn = Math.max(0, this._stats.tokensIn - this._stats.cachedTokens);
      this._stats.costUsd =
        (nonCachedIn / 1_000_000) * pricing.input +
        (this._stats.cachedTokens / 1_000_000) * cachedPrice +
        (this._stats.tokensOut / 1_000_000) * pricing.output;
    } else {
      this._stats.costUsd =
        (this._stats.tokensIn / 1_000_000) * pricing.input + (this._stats.tokensOut / 1_000_000) * pricing.output;
    }
  }
}
