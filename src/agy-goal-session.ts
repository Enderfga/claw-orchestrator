/**
 * Antigravity's own `/goal` loop behind the `GoalSession` surface the kernel's
 * `goal` node drives (`nativeGoal: true`).
 *
 * Measured on agy 1.5.18–1.5.19 in print mode:
 *
 *  - `/goal <objective>` sets the goal and works on it inside the one process:
 *    when the agent stops early, agy re-prompts it itself (a `system_message`
 *    step), and the run ends when a reply carries `<!-- GOAL_COMPLETE -->`, or
 *    `<!-- GOAL_CANCELLED -->` when the agent was asked to stop. The replies are
 *    concatenated in the result's `response`.
 *  - The goal belongs to the conversation. A process cut short (killed, or ended
 *    by `--print-timeout`) leaves it set, and the next message on the same
 *    `--conversation` is driven by it again until a marker ends it.
 *  - A bare `/goal` is not a status query: it starts a goal with no objective.
 *    Nothing reads the goal back, so the status here is the adapter's own.
 *
 * Statuses: `active` while a goal process runs; `complete` on the completion
 * marker; `blocked` on the cancel marker, a failed login, or a loop that keeps
 * ending without a marker (`MAX_UNMARKED_ENDINGS`); `usageLimited` for a turn
 * refused at a usage limit; `paused` for any other failed turn, for a pause, and
 * for a run that ended without a marker — the node resumes those within its
 * bound. A resume sets the goal again (`/goal <objective>`), which is harmless
 * when agy still holds it. A process that reaches its own time cap
 * (`AGY_GOAL_SEGMENT_MS`) is continued at once, not paused: a goal may run for
 * longer than one process should.
 *
 * Steering cuts the running process and continues the conversation with the
 * steer text; the goal stays set, so agy keeps driving it. A spent `tokenBudget`
 * cuts the process as soon as a step's usage shows it (`budgetLimited`).
 *
 * Tokens are input and output tokens, members' included (cache reads left out,
 * as on the other goal adapters).
 */

import { EventEmitter } from 'node:events';
import { SESSION_EVENT } from './constants.js';
import { classifyTurnError } from './turn-goal-session.js';
import type { GoalSession, GoalSnapshot, GoalStatus } from './kernel/nodes/goal.js';
import type { ClaudeGoalOpen } from './claude-goal-session.js';

export const AGY_GOAL_COMPLETE_MARKER = '<!-- GOAL_COMPLETE -->';
export const AGY_GOAL_CANCELLED_MARKER = '<!-- GOAL_CANCELLED -->';

/** The event a session emits with its running turn's usage, `{ tokensIn, tokensOut }`. */
export const AGY_TURN_USAGE_EVENT = 'agy:turn-usage';

/** One goal process may run this long; then it is cut and the conversation continued. */
export const AGY_GOAL_SEGMENT_MS = 3 * 60 * 60_000;

/** Segments in a row that may reach `AGY_GOAL_SEGMENT_MS` before the goal is held to be stuck. */
export const MAX_GOAL_SEGMENTS = 24;

/** Runs in a row that may end without a marker before the goal is held to be stuck. */
export const MAX_UNMARKED_ENDINGS = 5;

/** Sent after the steer text when a steer cuts the goal process. */
export const AGY_GOAL_CONTINUE = 'Continue working toward the active goal, taking the message above into account.';

/** Put after the objective when a goal is set again to resume it. */
export const AGY_GOAL_RESUME_NOTE =
  'This goal was set before and its work was interrupted. Continue from where the work stands; do not start over.';

/** Sent to end a goal agy still holds. */
export const AGY_GOAL_CANCEL = `The goal is cancelled: stop working on it now, and reply only with ${AGY_GOAL_CANCELLED_MARKER}.`;

const CANCEL_TIMEOUT_MS = 2 * 60_000;

/** What the adapter needs from an agy session. `PersistentAgySession.nativeGoalSession` provides it. */
export interface AgyGoalHost {
  readonly conversationId: string | undefined;
  /** Send with agy's slash commands on, whatever the session's `disableSlashCommands` says. */
  send(message: string, options?: { waitForComplete?: boolean; timeout?: number }): Promise<unknown>;
  /** Stop the turn now running; the conversation is kept. */
  interruptRun(): boolean;
  getStats(): { tokensIn: number; tokensOut: number };
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  off(event: string, listener: (...args: unknown[]) => void): unknown;
}

type GoalError = { message: string; code: string | null; willRetry: boolean; at: string };

/** The ending a goal reply declares with agy's markers, and the reply without them. */
export function readAgyGoalReply(text: string): { ending?: 'complete' | 'cancelled'; text: string } {
  const complete = text.includes(AGY_GOAL_COMPLETE_MARKER);
  const cancelled = text.includes(AGY_GOAL_CANCELLED_MARKER);
  const clean = text.split(AGY_GOAL_COMPLETE_MARKER).join('').split(AGY_GOAL_CANCELLED_MARKER).join('').trimEnd();
  // Both in one reply: the later one is the last word.
  const ending =
    complete && cancelled
      ? text.lastIndexOf(AGY_GOAL_COMPLETE_MARKER) > text.lastIndexOf(AGY_GOAL_CANCELLED_MARKER)
        ? 'complete'
        : 'cancelled'
      : complete
        ? 'complete'
        : cancelled
          ? 'cancelled'
          : undefined;
  return { ...(ending ? { ending } : {}), text: clean };
}

function queuedText(q: { text?: string; steers?: string[] }): string {
  return q.steers ? `${q.steers.join('\n\n')}\n\n${AGY_GOAL_CONTINUE}` : (q.text ?? AGY_GOAL_CONTINUE);
}

/** Why the adapter itself cut the running process. */
type Cut = 'pause' | 'budget' | 'steer' | 'clear' | 'interrupt';

export class AgyGoalSession extends EventEmitter implements GoalSession {
  private _goal: GoalSnapshot | null = null;
  private _lastError: GoalError | null = null;
  private _turnActive = false;
  /** Bumped by every new objective and every clear: a turn from an older one reports to nobody. */
  private _epoch = 0;
  /** agy holds the goal: set by `/goal`, not yet ended by a marker. */
  private _armed = false;
  private _cut: Cut | null = null;
  /** A process to start once the one being cut has ended: a prompt, or the steers to continue with. */
  private _queued: { text?: string; steers?: string[]; epoch: number; arming: boolean } | null = null;
  /** Settles once the process running now (if any) has ended. */
  private _settling: Promise<void> = Promise.resolve();
  private _unmarked = 0;
  private _segments = 0;
  private readonly _tokensAtOpen: number;
  private readonly _seedTokens: number;
  private _budgetFrom = 0;
  /** Usage of the running process so far, from its steps; folded into the stats when it ends. */
  private _running = { tokensIn: 0, tokensOut: 0 };
  private _turnStartedAt: number | null = null;
  private _timeUsed: number;
  private _closed = false;

  private readonly _onText = (...args: unknown[]) => {
    const text = typeof args[0] === 'string' ? readAgyGoalReply(args[0]).text : args[0];
    this.emit(SESSION_EVENT.TEXT, text, ...args.slice(1));
  };
  private readonly _onClose = (...args: unknown[]) => {
    this._closed = true;
    this._endTurn();
    if (this._goal) this.emit('goal:updated', this._snapshot());
    this.emit(SESSION_EVENT.CLOSE, ...args);
  };
  private readonly _onUsage = (...args: unknown[]) => {
    const u = args[0] as { tokensIn?: number; tokensOut?: number } | undefined;
    if (!this._turnActive || !u) return;
    this._running = { tokensIn: u.tokensIn ?? 0, tokensOut: u.tokensOut ?? 0 };
    this._enforceBudget();
  };

  constructor(
    readonly host: AgyGoalHost,
    private readonly open: ClaudeGoalOpen = {},
  ) {
    super();
    this._tokensAtOpen = this._sessionTokens();
    this._seedTokens = open.tokensUsed ?? 0;
    this._timeUsed = open.timeUsedSeconds ?? 0;
    host.on(SESSION_EVENT.TEXT, this._onText);
    host.on(SESSION_EVENT.CLOSE, this._onClose);
    host.on(AGY_TURN_USAGE_EVENT, this._onUsage);
  }

  /** Stop listening to the host. The session itself is the manager's to stop. */
  detach(): void {
    this._epoch += 1;
    this.host.off(SESSION_EVENT.TEXT, this._onText);
    this.host.off(SESSION_EVENT.CLOSE, this._onClose);
    this.host.off(AGY_TURN_USAGE_EVENT, this._onUsage);
  }

  /** The agy conversation id; a new conversation has one once its first process has started. */
  get codexThreadId(): string | undefined {
    return this.host.conversationId || this.open.threadId;
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
      this._epoch += 1;
      this._goal = {
        objective: p.objective,
        status: 'active',
        tokenBudget: p.tokenBudget ?? null,
        tokensUsed: this._tokensUsed(),
        timeUsedSeconds: this._seconds(),
      };
      this._budgetFrom = this._tokensUsed();
      this._unmarked = 0;
      this._segments = 0;
      const context = p.context?.trim();
      this._start(`/goal ${p.objective}${context ? `\n\n${context}` : ''}`, true);
    } else if (p.status === 'paused') {
      if (this._turnActive) this._cutTurn('pause');
      this._setStatus('paused');
    } else if (p.status === 'active') {
      if (!this._goal) {
        // A reopened conversation whose goal the node had set: take it up again.
        if (!this.open.objective) throw new Error('no goal to resume: set an objective first');
        this._goal = {
          objective: this.open.objective,
          status: 'paused',
          tokenBudget: null,
          tokensUsed: this._tokensUsed(),
          timeUsedSeconds: this._seconds(),
        };
      }
      // `_unmarked` carries over: a loop that keeps ending without a marker is not fixed by resuming it.
      this._setStatus('active');
      if (!this._turnActive) this._start(this._resumePrompt(), true);
    }
    return this._snapshot();
  }

  async getGoal(): Promise<GoalSnapshot | null> {
    if (!this._goal && this.open.resumed && this.open.objective) {
      // Nothing drives a goal across a restart; it waits, `paused`, for the node to resume it.
      this._goal = {
        objective: this.open.objective,
        status: 'paused',
        tokenBudget: null,
        tokensUsed: this._tokensUsed(),
        timeUsedSeconds: this._seconds(),
      };
    }
    if (this._turnActive) this._enforceBudget();
    return this._goal ? this._snapshot() : null;
  }

  async clearGoal(): Promise<void> {
    this._epoch += 1;
    const armed = this._armed;
    this._goal = null;
    this._armed = false;
    if (this._turnActive) this._cutTurn('clear');
    // agy would drive a goal it still holds on the next message of this conversation.
    if (armed && this.host.conversationId) {
      await this._settling;
      await this.host
        .send(AGY_GOAL_CANCEL, { waitForComplete: true, timeout: CANCEL_TIMEOUT_MS })
        .catch(() => undefined);
    }
  }

  async steer(text: string): Promise<{ steered: boolean }> {
    if (!this._goal || !this._turnActive || !this.host.conversationId) return { steered: false };
    // agy takes no input mid-run: cut the process, and continue the conversation with the text.
    const queued = this._queued;
    if (queued?.steers && queued.epoch === this._epoch) queued.steers.push(text);
    else if (!queued) {
      this._queued = { steers: [text], epoch: this._epoch, arming: false };
      this._cutTurn('steer');
    } else return { steered: false };
    return { steered: true };
  }

  async interrupt(): Promise<{ interrupted: boolean }> {
    if (!this._turnActive) return { interrupted: false };
    return { interrupted: this._cutTurn('interrupt') };
  }

  // ─── Internals ─────────────────────────────────────────────────────────

  private _resumePrompt(): string {
    return `/goal ${(this._goal as GoalSnapshot).objective}\n\n${AGY_GOAL_RESUME_NOTE}`;
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
    const running = this._turnActive ? this._running.tokensIn + this._running.tokensOut : 0;
    return this._seedTokens + Math.max(0, this._sessionTokens() - this._tokensAtOpen) + running;
  }

  private _seconds(): number {
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

  private _enforceBudget(): void {
    const budget = this._goal?.tokenBudget;
    if (!budget || this._goal?.status !== 'active') return;
    if (this._tokensUsed() - this._budgetFrom < budget) return;
    if (this._turnActive) this._cutTurn('budget');
    this._setStatus('budgetLimited');
  }

  private _cutTurn(why: Cut): boolean {
    this._cut = why;
    return this.host.interruptRun();
  }

  private _endTurn(): void {
    if (this._turnStartedAt !== null) this._timeUsed += (Date.now() - this._turnStartedAt) / 1000;
    this._turnStartedAt = null;
    this._turnActive = false;
    this._running = { tokensIn: 0, tokensOut: 0 };
  }

  /** Start a goal process, or, with one running, cut it and start this one when it has ended. */
  private _start(text: string, arming: boolean): void {
    if (this._closed) return;
    if (this._turnActive) {
      this._queued = { text, epoch: this._epoch, arming };
      this._cutTurn('steer');
      return;
    }
    const epoch = this._epoch;
    this._turnActive = true;
    this._turnStartedAt = Date.now();
    this._running = { tokensIn: 0, tokensOut: 0 };
    this._cut = null;
    if (arming) this._armed = true;
    this._settling = this.host.send(text, { waitForComplete: true, timeout: AGY_GOAL_SEGMENT_MS }).then(
      (r) => this._ended(epoch, r, undefined),
      (err: unknown) => this._ended(epoch, undefined, err),
    );
  }

  private _ended(epoch: number, result: unknown, err: unknown): void {
    this._endTurn();
    const cut = this._cut;
    this._cut = null;
    const queued = this._queued;
    this._queued = null;
    const raw = typeof (result as { text?: unknown })?.text === 'string' ? (result as { text: string }).text : '';
    const reply = readAgyGoalReply(raw);
    if (epoch !== this._epoch) {
      // A new objective was set, or the goal cleared, while this ran: its ending is no longer news.
      if (queued && queued.epoch === this._epoch && this._goal) this._start(queuedText(queued), queued.arming);
      return;
    }
    if (reply.ending) this._armed = false;
    if (!this._goal) return;
    if (result !== undefined) {
      const event = (result as { event?: Record<string, unknown> }).event ?? {};
      this.emit(SESSION_EVENT.RESULT, { ...event, type: 'result', result: reply.text });
    }

    // A marker is the last word, even on a process that was being cut.
    if (reply.ending === 'complete') return this._setStatus('complete');
    if (reply.ending === 'cancelled') {
      this._fail('the agent cancelled the goal (<!-- GOAL_CANCELLED -->)', null);
      return this._setStatus('blocked');
    }
    if (queued && this._goal.status === 'active') {
      this.emit('goal:updated', this._snapshot());
      return this._start(queuedText(queued), queued.arming);
    }
    if (cut === 'budget') return this._setStatus('budgetLimited');
    if (cut) {
      if (this._goal.status === 'active') this._setStatus('paused');
      else this.emit('goal:updated', this._snapshot());
      return;
    }

    if (err !== undefined) {
      const message = err instanceof Error ? err.message : String(err);
      if (/^Timeout waiting for Antigravity/.test(message) && this._goal.status === 'active') {
        // The process reached its own cap with the goal still running: carry on in a new one.
        this._segments += 1;
        if (this._segments < MAX_GOAL_SEGMENTS) {
          this.emit('goal:updated', this._snapshot());
          return this._start(this._resumePrompt(), true);
        }
        this._fail(
          `the goal ran ${this._segments} processes of ${AGY_GOAL_SEGMENT_MS / 3_600_000}h each without ending`,
          null,
        );
        return this._setStatus('blocked');
      }
      const code = classifyTurnError(message);
      this._fail(message, code);
      if (this._goal.status === 'active') {
        this._setStatus(
          code === 'usageLimitExceeded' ? 'usageLimited' : code === 'unauthorized' ? 'blocked' : 'paused',
        );
      }
      return;
    }

    this._segments = 0;
    if (this._goal.status !== 'active') {
      this.emit('goal:updated', this._snapshot());
      return;
    }
    if (this._budgetSpent()) return this._setStatus('budgetLimited');
    // agy ended its loop with no marker: resumed within the node's bound, up to a limit.
    this._unmarked += 1;
    if (this._unmarked >= MAX_UNMARKED_ENDINGS) {
      this._fail(`the goal ended ${this._unmarked} runs in a row without agy's completion marker`, null);
      return this._setStatus('blocked');
    }
    this._setStatus('paused');
  }

  private _budgetSpent(): boolean {
    const budget = this._goal?.tokenBudget;
    return !!budget && this._tokensUsed() - this._budgetFrom >= budget;
  }
}
