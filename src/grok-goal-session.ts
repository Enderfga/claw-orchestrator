/**
 * Grok Build's own `/goal` loop behind the `GoalSession` surface the kernel's
 * `goal` node drives (`nativeGoal`).
 *
 * `/goal <objective> [--budget <tokens>]` makes grok plan, implement and have
 * skeptic verifiers check the claim, round after round, until an evidence
 * review accepts it — all inside one `grok -p` process when the process is let
 * wait for the goal's later turns (1.0.92, measured: planner, implementer,
 * three verifiers and a summary in one run, `end_turn`). So each "turn" here
 * is one such process, started without `--no-wait-for-background`.
 *
 * The turn's outcome says nothing about the goal: a goal whose planner was
 * refused at the usage limit ends `end_turn`, exit 0, like a finished one. The
 * verdict is grok's goal state, read after every process from the session's
 * `goal/state.json` (`status`: `complete`, `infra_paused`, `budget_limited`,
 * …) or, failing that, from a `/goal status` reply (local, free).
 *
 * Statuses: `complete` and `budgetLimited` as grok reports them; `paused` for
 * a goal grok paused (or still held as running when the process ended) and
 * for a failed turn; `usageLimited` for one paused by a usage-limit refusal —
 * the node resumes both with `/goal resume`. A failed login is `blocked`, and
 * so is a goal grok no longer holds after a turn.
 *
 * What the turn loop (`TurnGoalSession`) does that this does not: steer text
 * cannot reach a running grok process, so `steer` answers `steered: false`
 * (the node keeps the text for the next node); and spend is checked between
 * processes, not between rounds. What this does that the turn loop does not:
 * grok's verifiers judge completion, and `--budget` is enforced by grok.
 */

import { EventEmitter } from 'node:events';

import { SESSION_EVENT } from './constants.js';
import { classifyTurnError } from './turn-goal-session.js';
import { normalizeGrokGoalStatus, parseGrokGoalStatus, type GrokGoalState } from './grok-commands.js';
import type { GoalSession, GoalSnapshot, GoalStatus } from './kernel/nodes/goal.js';
import type { TurnResult } from './types.js';

/** A goal process may run this long before it counts as a failed turn. */
export const GROK_GOAL_TURN_TIMEOUT_MS = 3 * 60 * 60_000;

/** What the adapter needs from the grok session. */
export interface GrokGoalHost {
  /** grok's own session id, once a turn has made one. */
  readonly grokConversationId: string | undefined;
  /** Run one goal process: slash commands on, waiting for the goal's own later turns. */
  runGoalTurn(text: string, opts: { timeout: number }): Promise<TurnResult>;
  /** Run a command grok answers locally (`/goal status`, `/goal pause`, `/goal clear`). */
  runLocalCommand(text: string): Promise<{ text: string }>;
  /** The goal in the session's `goal/state.json`: null when there is none, undefined when unreadable. */
  readGoalState(): GrokGoalState | null | undefined;
  /** A usage-limit refusal grok logged since `sinceMs` (on any session of the account), if any. */
  usageLimitSince(sinceMs: number): string | undefined;
  /** Stop the process now running. */
  interruptRun(): boolean;
  getStats(): { tokensIn: number; tokensOut: number };
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  removeListener(event: string, listener: (...args: unknown[]) => void): unknown;
}

/** What the node knows of the conversation it reopens. */
export interface GrokGoalOpen {
  threadId?: string;
  resumed?: boolean;
  objective?: string;
  tokensUsed?: number;
  timeUsedSeconds?: number;
}

type GoalError = { message: string; code: string | null; willRetry: boolean; at: string };

/** The `/goal` command that sets `objective`. */
export function grokGoalCommand(objective: string, tokenBudget?: number | null): string {
  return `/goal ${objective.trim()}${tokenBudget ? ` --budget ${Math.floor(tokenBudget)}` : ''}`;
}

/** A grok goal status as the node reads it: `running` when the process ended with grok still on the goal, undefined for a status not known. */
function nodeStatus(status: string): 'complete' | 'budgetLimited' | 'paused' | 'running' | 'none' | undefined {
  switch (normalizeGrokGoalStatus(status)) {
    case 'complete':
    case 'completed':
    case 'achieved':
      return 'complete';
    case 'budgetlimited':
    case 'budgetexceeded':
      return 'budgetLimited';
    case 'infrapaused':
    case 'userpaused':
    case 'backoffpaused':
    case 'paused':
      return 'paused';
    case 'executing':
    case 'active':
    case 'working':
    case 'running':
    case 'planning':
    case 'verifying':
      return 'running';
    case 'cleared':
    case 'none':
      return 'none';
    default:
      return undefined;
  }
}

export class GrokGoalSession extends EventEmitter implements GoalSession {
  private _goal: GoalSnapshot | null = null;
  private _lastError: GoalError | null = null;
  private _turnActive = false;
  /** Bumped by every new objective and every clear: a process from an older goal reports to nobody. */
  private _epoch = 0;
  private _closed = false;
  private _pauseAfterTurn = false;
  private _clearAfterTurn = false;
  private _turnStartedAt: number | null = null;
  private _timeUsed: number;
  private readonly _tokensAtOpen: number;
  private readonly _seedTokens: number;
  /** grok's own count for the goal, when its state was read. */
  private _grokTokens?: number;
  private _grokSeconds?: number;

  private readonly _onText = (...args: unknown[]) => this.emit(SESSION_EVENT.TEXT, ...args);
  private readonly _onClose = (...args: unknown[]) => {
    this._closed = true;
    this._endTurn();
    if (this._goal) this.emit('goal:updated', this._snapshot());
    this.emit(SESSION_EVENT.CLOSE, ...args);
  };

  constructor(
    readonly host: GrokGoalHost,
    private readonly open: GrokGoalOpen = {},
  ) {
    super();
    this._tokensAtOpen = this._sessionTokens();
    this._seedTokens = open.tokensUsed ?? 0;
    this._timeUsed = open.timeUsedSeconds ?? 0;
    host.on(SESSION_EVENT.TEXT, this._onText);
    host.on(SESSION_EVENT.CLOSE, this._onClose);
  }

  detach(): void {
    this._epoch += 1;
    this.host.removeListener(SESSION_EVENT.TEXT, this._onText);
    this.host.removeListener(SESSION_EVENT.CLOSE, this._onClose);
  }

  get codexThreadId(): string | undefined {
    return this.host.grokConversationId || this.open.threadId;
  }

  get goal(): GoalSnapshot | null {
    return this._goal ? this._snapshot() : null;
  }

  get lastError(): GoalError | null {
    return this._lastError;
  }

  get turnActive(): boolean {
    return this._turnActive;
  }

  async setGoal(p: {
    objective?: string;
    status?: 'active' | 'paused';
    tokenBudget?: number | null;
    context?: string;
  }): Promise<GoalSnapshot> {
    if (p.objective !== undefined) {
      if (!p.objective.trim()) throw new Error('a goal needs an objective');
      this._epoch += 1;
      this._grokTokens = undefined;
      this._grokSeconds = undefined;
      this._goal = {
        objective: p.objective,
        status: 'active',
        tokenBudget: p.tokenBudget ?? null,
        tokensUsed: this._tokensUsed(),
        timeUsedSeconds: this._seconds(),
      };
      this._startTurn(grokGoalCommand(p.objective, p.tokenBudget));
    } else if (p.status === 'paused') {
      if (this._turnActive) this._pauseAfterTurn = true;
      else await this._local('/goal pause');
      this._setStatus('paused');
    } else if (p.status === 'active') {
      if (!this._goal) {
        const state = this._readState();
        const objective = state?.objective || this.open.objective;
        if (!objective) throw new Error('no goal to resume: set an objective first');
        this._goal = {
          objective,
          status: 'paused',
          tokenBudget: state?.tokenBudget ?? null,
          tokensUsed: this._tokensUsed(),
          timeUsedSeconds: this._seconds(),
        };
      }
      this._pauseAfterTurn = false;
      this._setStatus('active');
      if (!this._turnActive) this._startTurn('/goal resume');
    }
    return this._snapshot();
  }

  async getGoal(): Promise<GoalSnapshot | null> {
    if (this._turnActive) return this._goal ? this._snapshot() : null;
    const state = this._readState();
    if (!this._goal) {
      // A reopened conversation: grok's own state says where its goal stands.
      if (!state || !this.open.resumed) return null;
      const mapped = nodeStatus(state.status);
      this._goal = {
        objective: state.objective,
        status: mapped === 'complete' || mapped === 'budgetLimited' ? mapped : 'paused',
        tokenBudget: state.tokenBudget ?? null,
        tokensUsed: this._tokensUsed(),
        timeUsedSeconds: this._seconds(),
      };
    }
    if (state) this._absorbCounts(state);
    return this._snapshot();
  }

  async clearGoal(): Promise<void> {
    this._epoch += 1;
    this._goal = null;
    this._pauseAfterTurn = false;
    if (this._turnActive) this._clearAfterTurn = true;
    else await this._local('/goal clear');
  }

  /** A running grok process takes no input; the node keeps the text. */
  async steer(_text: string): Promise<{ steered: boolean }> {
    return { steered: false };
  }

  async interrupt(): Promise<{ interrupted: boolean }> {
    if (!this._turnActive) return { interrupted: false };
    return { interrupted: this.host.interruptRun() };
  }

  // ─── Internals ─────────────────────────────────────────────────────────

  private _sessionTokens(): number {
    try {
      const s = this.host.getStats();
      return (s.tokensIn || 0) + (s.tokensOut || 0);
    } catch {
      return 0;
    }
  }

  private _tokensUsed(): number {
    return this._grokTokens ?? this._seedTokens + Math.max(0, this._sessionTokens() - this._tokensAtOpen);
  }

  private _seconds(): number {
    if (this._grokSeconds !== undefined && this._turnStartedAt === null) return this._grokSeconds;
    const running = this._turnStartedAt === null ? 0 : (Date.now() - this._turnStartedAt) / 1000;
    return Math.round(this._timeUsed + running);
  }

  private _snapshot(): GoalSnapshot {
    const g = this._goal as GoalSnapshot;
    return { ...g, tokensUsed: this._tokensUsed(), timeUsedSeconds: this._seconds() };
  }

  private _setStatus(status: GoalStatus): void {
    if (!this._goal || this._goal.status === status) return;
    this._goal = { ...this._goal, status };
    this.emit('goal:updated', this._snapshot());
  }

  private _fail(message: string, code: string | null): void {
    this._lastError = { message, code, willRetry: false, at: new Date().toISOString() };
    this.emit('codex:error', this._lastError);
  }

  private _readState(): GrokGoalState | null | undefined {
    if (!this.codexThreadId) return undefined;
    try {
      return this.host.readGoalState();
    } catch {
      return undefined;
    }
  }

  private _absorbCounts(state: GrokGoalState): void {
    if (state.tokensUsed !== undefined) this._grokTokens = Math.max(state.tokensUsed, this._seedTokens);
    if (state.elapsedSeconds !== undefined) this._grokSeconds = state.elapsedSeconds;
  }

  /** A command grok answers locally; nothing to do before the conversation exists. */
  private async _local(text: string): Promise<void> {
    if (!this.host.grokConversationId || this._closed) return;
    try {
      await this.host.runLocalCommand(text);
    } catch (err) {
      this._fail(`${text} failed: ${(err as Error).message}`, null);
    }
  }

  private _endTurn(): void {
    if (this._turnStartedAt !== null) this._timeUsed += (Date.now() - this._turnStartedAt) / 1000;
    this._turnStartedAt = null;
    this._turnActive = false;
  }

  private _startTurn(text: string): void {
    if (this._closed) return;
    const epoch = this._epoch;
    const startedAt = Date.now();
    this._turnActive = true;
    this._turnStartedAt = startedAt;
    void this.host.runGoalTurn(text, { timeout: GROK_GOAL_TURN_TIMEOUT_MS }).then(
      (r) => this._turnEnded(epoch, startedAt, r, undefined),
      (err: unknown) => this._turnEnded(epoch, startedAt, undefined, err),
    );
  }

  private async _turnEnded(epoch: number, startedAt: number, result: TurnResult | undefined, err: unknown) {
    this._endTurn();
    if (this._clearAfterTurn) {
      this._clearAfterTurn = false;
      await this._local('/goal clear');
    }
    if (epoch !== this._epoch || !this._goal) return;
    const text = result?.text ?? '';
    if (text) this.emit(SESSION_EVENT.RESULT, { type: 'result', result: text });

    const id = this.host.grokConversationId;
    if (this.open.resumed && this.open.threadId && id && id !== this.open.threadId) {
      this._fail(`resumed conversation ${this.open.threadId} came back as ${id}`, null);
      return this._setStatus('blocked');
    }
    if (this._pauseAfterTurn) {
      this._pauseAfterTurn = false;
      await this._local('/goal pause');
      this._setStatus('paused');
      return;
    }
    if (err !== undefined) {
      const message = err instanceof Error ? err.message : String(err);
      const code = classifyTurnError(message);
      this._fail(message, code);
      return this._setStatus(
        code === 'usageLimitExceeded' ? 'usageLimited' : code === 'unauthorized' ? 'blocked' : 'paused',
      );
    }

    let state = this._readState();
    if (state === undefined && id) {
      // No state file found: grok's own report, which answers locally.
      try {
        state = parseGrokGoalStatus((await this.host.runLocalCommand('/goal status')).text);
      } catch {
        state = undefined;
      }
    }
    if (state) this._absorbCounts(state);
    const mapped = state === null ? 'none' : state ? nodeStatus(state.status) : undefined;
    switch (mapped) {
      case 'complete':
      case 'budgetLimited':
        return this._setStatus(mapped);
      case 'none':
        this._fail('grok holds no goal after the turn', null);
        return this._setStatus('blocked');
      case 'paused':
      case 'running':
      case undefined: {
        const refusal = this.host.usageLimitSince(startedAt);
        if (refusal) {
          this._fail(refusal, 'usageLimitExceeded');
          return this._setStatus('usageLimited');
        }
        if (state?.pauseMessage) this._fail(state.pauseMessage, null);
        else if (mapped === undefined) {
          this._fail(
            state ? `grok reported goal status '${state.status}'` : "grok's goal state could not be read",
            null,
          );
        }
        // Already paused: still news, with the thread id and the counts.
        if (this._goal.status === 'paused') this.emit('goal:updated', this._snapshot());
        return this._setStatus('paused');
      }
    }
  }
}
