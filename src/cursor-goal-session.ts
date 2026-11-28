/**
 * Cursor's own `/goal` behind the `GoalSession` surface the kernel's `goal` node
 * drives (`nativeGoal`).
 *
 * `/goal <objective>` arms a goal in the chat (`CreateGoal`), and Cursor's print
 * mode keeps the process going, request after request, until the model marks it
 * done (`UpdateGoal` with `GOAL_STATUS_COMPLETE`). The goal has no budget of its
 * own and no API to read it, so its state is read from those two tool calls in
 * the stream. What follows from how Cursor reports (2026.11.22, measured):
 *
 *  - Usage arrives once per process, in the `result` it writes as it ends — on
 *    its own, or on SIGTERM while it waits for background work. A process
 *    signalled mid-request exits without one. So a goal process is not cut
 *    short to read its spend: `tokenBudget` and the run's spend cap are checked
 *    when a process ends, and the spend the node reads moves then.
 *  - A steer cannot reach a running process. It waits for the process to end
 *    and opens the next one, in front of the continuation.
 *  - After the model marks the goal done, a process a background shell holds
 *    open is ended after `CURSOR_GOAL_COMPLETE_GRACE_MS` (it is idle by then,
 *    so its result is still written).
 *  - A process that fails is `usageLimited` (a usage or rate limit), `blocked`
 *    (a failed login) or `paused` (anything else), as on the turn loop; the node
 *    resumes the first and the last within its bound, on the same chat, where
 *    Cursor still holds the goal armed.
 *  - A process that ends cleanly with the goal still armed — Cursor stopped
 *    continuing it — is continued, up to `MAX_UNDECLARED_TURNS` times in a row.
 *  - A pause, a cancel or a new objective ends the running process at once; its
 *    usage is then not reported.
 */

import { EventEmitter } from 'node:events';
import { SESSION_EVENT } from './constants.js';
import type { GoalSession, GoalSnapshot, GoalStatus } from './kernel/nodes/goal.js';
import { MAX_UNDECLARED_TURNS, TURN_GOAL_TURN_TIMEOUT_MS, classifyTurnError } from './turn-goal-session.js';
import type { SessionSendOptions } from './types.js';

/** After the model marks the goal complete, how long the process may take to finish its reply. */
export const CURSOR_GOAL_COMPLETE_GRACE_MS = 30_000;

/** What a goal process is continued with. */
export const CURSOR_GOAL_CONTINUE = 'Continue working toward the active goal.';

/** What the adapter needs from a Cursor session. */
export interface CursorGoalHost {
  send(message: string, options?: SessionSendOptions & { goalRun?: boolean }): Promise<unknown>;
  /** End the running process. False when none runs. */
  interruptRun(): boolean;
  getStats(): { tokensIn: number; tokensOut: number; cursorChatId?: string };
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  removeListener(event: string, listener: (...args: unknown[]) => void): unknown;
}

/** What the goal node knows of the chat when it opens the adapter. */
export interface CursorGoalOpen {
  threadId?: string;
  resumed?: boolean;
  objective?: string;
  tokensUsed?: number;
  timeUsedSeconds?: number;
}

type GoalError = { message: string; code: string | null; willRetry: boolean; at: string };

/** The goal change a completed tool call reports: armed, or a new status (`complete`, `paused`, …). */
export function cursorGoalToolUpdate(event: unknown): { armed: true } | { status: string } | undefined {
  const e = event as { subtype?: unknown; tool_call?: Record<string, { result?: Record<string, unknown> }> };
  if (e?.subtype !== 'completed' || !e.tool_call) return undefined;
  const create = e.tool_call.createGoalToolCall;
  if (create?.result && 'success' in create.result) return { armed: true };
  const update = e.tool_call.updateGoalToolCall;
  const status = (update?.result?.success as { status?: unknown } | undefined)?.status;
  if (typeof status === 'string') {
    return { status: status.replace(/^GOAL_STATUS_/, '').toLowerCase() };
  }
  return undefined;
}

export class CursorGoalSession extends EventEmitter implements GoalSession {
  private _goal: GoalSnapshot | null = null;
  private _lastError: GoalError | null = null;
  private _running = false;
  /** Bumped by every new objective and every clear: a process of an older goal reports to nobody. */
  private _epoch = 0;
  private _pending: string[] = [];
  private _undeclared = 0;
  /** Why the running process was ended by us, when it was. */
  private _ending: 'complete' | 'pause' | 'interrupt' | null = null;
  private _completeSeen = false;
  private _completeTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly _tokensAtOpen: number;
  private readonly _seedTokens: number;
  private _budgetFrom = 0;
  private _startedAt: number | null = null;
  private _timeUsed: number;
  private _closed = false;
  private _threadAnnounced = false;
  /** The process to start once the running one has ended: a new objective set while it ran. */
  private _next: string | null = null;

  private readonly _onText = (...args: unknown[]) => {
    this._announceThread();
    this.emit(SESSION_EVENT.TEXT, ...args);
  };
  private readonly _onToolResult = (...args: unknown[]) => {
    this._announceThread();
    if (!this._running) return;
    const update = cursorGoalToolUpdate(args[0]);
    if (!update || !this._goal) return;
    if ('armed' in update) return;
    if (update.status === 'complete') {
      this._completeSeen = true;
      // The process ends on its own once the goal is done; one held open by a
      // background shell is not waited on past the grace.
      this._completeTimer ??= setTimeout(() => this._end('complete'), CURSOR_GOAL_COMPLETE_GRACE_MS);
      this._completeTimer.unref?.();
    } else if (update.status === 'cleared') {
      this._fail('the agent cleared the goal', null);
      this._setStatus('blocked');
    } else if (update.status === 'paused') {
      this._setStatus('paused');
    }
  };
  private readonly _onClose = (...args: unknown[]) => {
    this._closed = true;
    this._endProcess();
    if (this._goal) this.emit('goal:updated', this._snapshot());
    this.emit(SESSION_EVENT.CLOSE, ...args);
  };

  constructor(
    readonly host: CursorGoalHost,
    private readonly open: CursorGoalOpen = {},
  ) {
    super();
    this._tokensAtOpen = this._sessionTokens();
    this._seedTokens = open.tokensUsed ?? 0;
    this._timeUsed = open.timeUsedSeconds ?? 0;
    host.on(SESSION_EVENT.TEXT, this._onText);
    host.on(SESSION_EVENT.TOOL_RESULT, this._onToolResult);
    host.on(SESSION_EVENT.CLOSE, this._onClose);
  }

  /** Stop listening to the host. The session itself is the manager's to stop. */
  detach(): void {
    this._epoch += 1;
    this._clearTimers();
    this.host.removeListener(SESSION_EVENT.TEXT, this._onText);
    this.host.removeListener(SESSION_EVENT.TOOL_RESULT, this._onToolResult);
    this.host.removeListener(SESSION_EVENT.CLOSE, this._onClose);
  }

  /** Cursor's chat id: known from the first process's init event. */
  get codexThreadId(): string | undefined {
    return this.host.getStats().cursorChatId || this.open.threadId;
  }

  get goal(): GoalSnapshot | null {
    return this._goal ? this._snapshot() : null;
  }

  get lastError(): GoalError | null {
    return this._lastError;
  }

  get turnActive(): boolean {
    return this._running;
  }

  async setGoal(p: {
    objective?: string;
    status?: 'active' | 'paused';
    tokenBudget?: number | null;
    context?: string;
  }): Promise<GoalSnapshot> {
    if (p.objective !== undefined) {
      if (!p.objective.trim()) throw new Error('a Cursor goal needs an objective');
      this._epoch += 1;
      this._goal = {
        objective: p.objective,
        status: 'active',
        tokenBudget: p.tokenBudget ?? null,
        tokensUsed: this._tokensUsed(),
        timeUsedSeconds: this._seconds(),
      };
      this._budgetFrom = this._tokensUsed();
      this._undeclared = 0;
      const text = `/goal ${p.objective}`;
      if (this._running) {
        this._next = text;
        this._end('interrupt');
      } else this._launch(text);
    } else if (p.status === 'paused') {
      this._setStatus('paused');
      if (this._running) this._end('pause');
    } else if (p.status === 'active') {
      if (!this._goal) {
        // A reopened chat whose goal the node had set: Cursor still holds it armed.
        if (!this.open.objective) throw new Error('no goal to resume: set an objective first');
        this._goal = {
          objective: this.open.objective,
          status: 'paused',
          tokenBudget: null,
          tokensUsed: this._tokensUsed(),
          timeUsedSeconds: this._seconds(),
        };
      }
      this._setStatus('active');
      this._undeclared = 0;
      if (!this._running) this._launch(this._continuation());
    }
    return this._snapshot();
  }

  async getGoal(): Promise<GoalSnapshot | null> {
    if (!this._goal && this.open.resumed && this.open.objective) {
      // Nothing drives the goal across a restart; it waits, `paused`, for the node to resume it.
      this._goal = {
        objective: this.open.objective,
        status: 'paused',
        tokenBudget: null,
        tokensUsed: this._tokensUsed(),
        timeUsedSeconds: this._seconds(),
      };
    }
    return this._goal ? this._snapshot() : null;
  }

  /**
   * Forget the goal here and end a process working on it. Cursor's chat may
   * still hold it armed; the next `/goal` replaces it.
   */
  async clearGoal(): Promise<void> {
    this._epoch += 1;
    this._goal = null;
    this._pending = [];
    this._next = null;
    if (this._running) this._end('interrupt');
  }

  /** Queue `text` for the next process: it opens it, in front of the continuation. */
  async steer(text: string): Promise<{ steered: boolean }> {
    if (!this._goal) return { steered: false };
    this._pending.push(text);
    return { steered: true };
  }

  async interrupt(): Promise<{ interrupted: boolean }> {
    if (!this._running) return { interrupted: false };
    this._end('interrupt');
    return { interrupted: true };
  }

  // ─── Internals ─────────────────────────────────────────────────────────

  private _announceThread(): void {
    if (this._threadAnnounced || !this._goal || !this.host.getStats().cursorChatId) return;
    this._threadAnnounced = true;
    this.emit('goal:updated', this._snapshot());
  }

  private _sessionTokens(): number {
    try {
      const s = this.host.getStats();
      return (s.tokensIn || 0) + (s.tokensOut || 0);
    } catch {
      return 0;
    }
  }

  private _tokensUsed(): number {
    return this._seedTokens + Math.max(0, this._sessionTokens() - this._tokensAtOpen);
  }

  private _seconds(): number {
    const running = this._startedAt === null ? 0 : (Date.now() - this._startedAt) / 1000;
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

  private _continuation(): string {
    const steers = this._pending.splice(0);
    return steers.length ? `${steers.join('\n\n')}\n\n${CURSOR_GOAL_CONTINUE}` : CURSOR_GOAL_CONTINUE;
  }

  private _budgetSpent(): boolean {
    const budget = this._goal?.tokenBudget;
    return !!budget && this._tokensUsed() - this._budgetFrom >= budget;
  }

  private _clearTimers(): void {
    if (this._completeTimer) clearTimeout(this._completeTimer);
    this._completeTimer = null;
  }

  private _endProcess(): void {
    this._clearTimers();
    if (this._startedAt !== null) this._timeUsed += (Date.now() - this._startedAt) / 1000;
    this._startedAt = null;
    this._running = false;
  }

  private _end(why: NonNullable<CursorGoalSession['_ending']>): void {
    this._ending = why;
    this.host.interruptRun();
  }

  /** Run one goal process and act on how it ended. */
  private _launch(text: string): void {
    if (this._closed || this._running) return;
    const epoch = this._epoch;
    this._running = true;
    this._ending = null;
    this._completeSeen = false;
    this._startedAt = Date.now();
    // As on the turn loop, a process that outlives this is a failed one, and the node resumes the goal.
    void this.host.send(text, { waitForComplete: true, timeout: TURN_GOAL_TURN_TIMEOUT_MS, goalRun: true }).then(
      (r) => this._ended(epoch, r, undefined),
      (err: unknown) => this._ended(epoch, undefined, err),
    );
  }

  private _ended(epoch: number, result: unknown, err: unknown): void {
    const ending = this._ending;
    const completeSeen = this._completeSeen;
    this._ending = null;
    this._endProcess();
    if (epoch !== this._epoch || !this._goal) {
      // A process of an earlier goal: a new objective set meanwhile starts now.
      const next = this._next;
      this._next = null;
      if (next && this._goal?.status === 'active') this._launch(next);
      return;
    }
    const text = typeof (result as { text?: unknown })?.text === 'string' ? (result as { text: string }).text : '';
    if (text.trim()) this.emit(SESSION_EVENT.RESULT, { type: 'result', result: text });
    // A chat resumed by id must come back as that chat, or the goal is starting over.
    const id = this.host.getStats().cursorChatId;
    if (this.open.resumed && this.open.threadId && id && id !== this.open.threadId) {
      this._fail(`resumed chat ${this.open.threadId} came back as ${id}`, null);
      this._setStatus('blocked');
      return;
    }
    if (completeSeen) return this._setStatus('complete');
    if (this._goal.status !== 'active') {
      // Paused or ended by the agent while the process ran: it stays so.
      this.emit('goal:updated', this._snapshot());
      return;
    }
    if (this._budgetSpent()) return this._setStatus('budgetLimited');
    if (err !== undefined && ending === null) {
      const message = err instanceof Error ? err.message : String(err);
      const code = classifyTurnError(message);
      this._fail(message, code);
      this._setStatus(code === 'usageLimitExceeded' ? 'usageLimited' : code === 'unauthorized' ? 'blocked' : 'paused');
      return;
    }
    if (ending === 'interrupt') {
      this.emit('goal:updated', this._snapshot());
      return;
    }
    if (ending === null) {
      // Cursor ended the process with the goal still armed and not done.
      this._undeclared += 1;
      if (this._undeclared >= MAX_UNDECLARED_TURNS) {
        this._fail(`Cursor ended ${this._undeclared} goal processes in a row without completing the goal`, null);
        return this._setStatus('blocked');
      }
    }
    this.emit('goal:updated', this._snapshot());
    this._launch(this._continuation());
  }
}
