/**
 * OpenCode 2's own `/goal` behind the `GoalSession` surface the kernel's `goal`
 * node drives (`nativeGoal`), beside `TurnGoalSession`, clawo's turn loop.
 *
 * OpenCode 2.4.2 ships `/goal <objective> | pause | resume | clear` as a plugin
 * (`opencode.goal`): it runs a kickoff turn, has a judge model decide after each
 * round whether the objective is met, and runs continuation rounds (at most
 * `maxRounds`, 50) with no idle in between until the judge says it is done,
 * blocked or paused. Its state is read through `POST /api/rpc/opencode.goal/get`:
 * `{ objective, status, reason, rounds, maxRounds, … }`. There is no setter but
 * the command, so the goal is set with `/goal <objective>` on the session's held
 * server (`PersistentOpencodeSession.goalCommand`), which follows the loop to
 * its end the way a command is followed: usage into the session's stats, text
 * as it arrives, permission requests rejected and question forms cancelled.
 *
 * What differs from the turn loop: OpenCode's judge, not a marker in the reply,
 * decides the goal is complete; a steer reaches the round in flight (the held
 * server's `/prompt` with delivery `steer`), or waits in the conversation for
 * the next round; the token budget is clawo's — OpenCode's goal has none — and
 * a spent one interrupts the round and pauses the goal. The plugin keeps no
 * loop running across a server restart: a reopened goal reads `paused` until
 * the node resumes it.
 */

import { EventEmitter } from 'node:events';

import { SESSION_EVENT } from './constants.js';
import { classifyTurnError } from './turn-goal-session.js';
import type { GoalSession, GoalSnapshot, GoalStatus } from './kernel/nodes/goal.js';
import type { CommandOutcome } from './types.js';

/** What `opencode.goal/get` answers for a conversation with a goal. */
export interface OpencodeGoalState {
  id?: string;
  objective: string;
  status: string;
  reason?: string;
  rounds?: number;
  maxRounds?: number;
  stalls?: number;
  boot?: string;
  updatedAt?: number;
}

/** What the adapter needs from its session (`PersistentOpencodeSession`). */
export interface OpencodeGoalHost {
  readonly conversationId: string | undefined;
  goalCommand(args: string, opts: { timeout: number }): Promise<CommandOutcome>;
  goalState(): Promise<OpencodeGoalState | null>;
  goalContext(text: string): Promise<void>;
  deliverMidTurn(text: string): Promise<boolean>;
  interruptRun(): boolean;
  getStats(): { tokensIn: number; tokensOut: number };
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  removeListener(event: string, listener: (...args: unknown[]) => void): unknown;
}

/** What the node knows of the conversation when it opens the adapter. */
export interface OpencodeGoalOpen {
  threadId?: string;
  resumed?: boolean;
  objective?: string;
  tokensUsed?: number;
  timeUsedSeconds?: number;
}

type GoalError = { message: string; code: string | null; willRetry: boolean; at: string };

/** One follow of the goal loop may run this long; past it the round is interrupted and the goal reads `paused`. */
export const OPENCODE_GOAL_FOLLOW_MS = 3 * 60 * 60_000;
/** How often the plugin's state is read while the loop runs. */
const POLL_MS = 3_000;
const QUICK_MS = 60_000;

/** The plugin's status as the node's. One it does not name is `paused`: nothing is driving it. */
export function goalStatusOf(status: string | undefined): GoalStatus {
  switch (status) {
    case 'active':
      return 'active';
    case 'complete':
    case 'completed':
    case 'done':
      return 'complete';
    case 'blocked':
      return 'blocked';
    default:
      return 'paused';
  }
}

export class OpencodeGoalSession extends EventEmitter implements GoalSession {
  private _goal: GoalSnapshot | null = null;
  private _lastError: GoalError | null = null;
  private _turnActive = false;
  /** Bumped by every new objective and every clear: a loop from an older one reports to nobody. */
  private _epoch = 0;
  private _poll: ReturnType<typeof setInterval> | null = null;
  private readonly _tokensAtOpen: number;
  private readonly _seedTokens: number;
  private _budgetFrom = 0;
  private _budgetSpent = false;
  private _turnStartedAt: number | null = null;
  private _timeUsed: number;
  private _closed = false;
  private _rounds?: number;

  private readonly _onText = (...args: unknown[]) => this.emit(SESSION_EVENT.TEXT, ...args);
  private readonly _onClose = (...args: unknown[]) => {
    this._closed = true;
    this._endTurn();
    if (this._goal) this.emit('goal:updated', this._snapshot());
    this.emit(SESSION_EVENT.CLOSE, ...args);
  };

  constructor(
    readonly host: OpencodeGoalHost,
    private readonly open: OpencodeGoalOpen = {},
  ) {
    super();
    this._tokensAtOpen = this._sessionTokens();
    this._seedTokens = open.tokensUsed ?? 0;
    this._timeUsed = open.timeUsedSeconds ?? 0;
    host.on(SESSION_EVENT.TEXT, this._onText);
    host.on(SESSION_EVENT.CLOSE, this._onClose);
  }

  /** Stop listening to the host; the session is the manager's to stop. */
  detach(): void {
    this._epoch += 1;
    this._stopPoll();
    this.host.removeListener(SESSION_EVENT.TEXT, this._onText);
    this.host.removeListener(SESSION_EVENT.CLOSE, this._onClose);
  }

  get codexThreadId(): string | undefined {
    return this.host.conversationId ?? this.open.threadId;
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
      // Context informs the agent without becoming part of what the judge holds it to.
      if (p.context?.trim()) await this.host.goalContext(p.context.trim());
      this._goal = {
        objective: p.objective,
        status: 'active',
        tokenBudget: p.tokenBudget ?? null,
        tokensUsed: this._tokensUsed(),
        timeUsedSeconds: this._seconds(),
      };
      this._budgetFrom = this._tokensUsed();
      this._budgetSpent = false;
      this._follow(p.objective);
    } else if (p.status === 'paused') {
      if (this._goal) {
        await this._quick('pause');
        this._setStatus('paused');
      }
    } else if (p.status === 'active') {
      if (!this._goal) {
        const state = await this.host.goalState().catch(() => null);
        const objective = state?.objective ?? this.open.objective;
        if (!objective) throw new Error('no goal to resume: set an objective first');
        this._goal = {
          objective,
          status: 'paused',
          tokenBudget: null,
          tokensUsed: this._tokensUsed(),
          timeUsedSeconds: this._seconds(),
        };
      }
      this._budgetSpent = false;
      this._budgetFrom = this._tokensUsed();
      this._setStatus('active');
      if (!this._turnActive) {
        // The plugin's own goal resumes; one it no longer holds (a new server keeps none) is set again.
        const state = await this.host.goalState().catch(() => null);
        this._follow(state && goalStatusOf(state.status) !== 'complete' ? 'resume' : this._goal.objective);
      }
    }
    return this._snapshot();
  }

  async getGoal(): Promise<GoalSnapshot | null> {
    const state = await this.host.goalState().catch(() => null);
    if (state) this._absorb(state);
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
    return this._goal ? this._snapshot() : null;
  }

  async clearGoal(): Promise<void> {
    this._epoch += 1;
    this._goal = null;
    this._stopPoll();
    await this._quick('clear');
  }

  async steer(text: string): Promise<{ steered: boolean }> {
    if (!this._goal) return { steered: false };
    if (this._turnActive && (await this.host.deliverMidTurn(text).catch(() => false))) return { steered: true };
    // No round runs: it waits in the conversation for the next one.
    await this.host.goalContext(text);
    return { steered: true };
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
    return this._seedTokens + Math.max(0, this._sessionTokens() - this._tokensAtOpen);
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

  /** `pause` / `clear`: they change the plugin's state and run nothing. */
  private async _quick(args: string): Promise<void> {
    const outcome = await this.host.goalCommand(args, { timeout: QUICK_MS });
    if (!outcome.ok) throw new Error(outcome.error ?? `/goal ${args} failed`);
  }

  private _endTurn(): void {
    if (this._turnStartedAt !== null) this._timeUsed += (Date.now() - this._turnStartedAt) / 1000;
    this._turnStartedAt = null;
    this._turnActive = false;
    this._stopPoll();
  }

  private _stopPoll(): void {
    if (this._poll) clearInterval(this._poll);
    this._poll = null;
  }

  /** The plugin's state as the goal's, while a loop runs or after one ended. */
  private _absorb(state: OpencodeGoalState): void {
    if (!this._goal || this._budgetSpent) return;
    let status = goalStatusOf(state.status);
    // `active` with no loop following it is a goal nothing drives.
    if (status === 'active' && !this._turnActive) status = 'paused';
    const progressed = state.rounds !== undefined && state.rounds !== this._rounds;
    this._rounds = state.rounds;
    if (status !== this._goal.status) {
      if (status === 'blocked' && state.reason) this._fail(state.reason, null);
      this._setStatus(status);
    } else if (progressed) this.emit('goal:updated', this._snapshot());
  }

  /** `/goal <args>` followed to the loop's end, with the plugin's state read as it goes. */
  private _follow(args: string): void {
    if (this._closed) return;
    const epoch = this._epoch;
    this._turnActive = true;
    this._turnStartedAt = Date.now();
    this._stopPoll();
    this._poll = setInterval(() => void this._tick(epoch), POLL_MS);
    this._poll.unref?.();
    void this.host.goalCommand(args, { timeout: OPENCODE_GOAL_FOLLOW_MS }).then(
      (outcome) => this._ended(epoch, outcome, undefined),
      (err: unknown) => this._ended(epoch, undefined, err),
    );
  }

  private async _tick(epoch: number): Promise<void> {
    if (epoch !== this._epoch || !this._goal) return;
    const budget = this._goal.tokenBudget;
    if (budget && !this._budgetSpent && this._tokensUsed() - this._budgetFrom >= budget) {
      this._budgetSpent = true;
      this._setStatus('budgetLimited');
      await this._quick('pause').catch(() => undefined);
      this.host.interruptRun();
      return;
    }
    const state = await this.host.goalState().catch(() => null);
    if (state && epoch === this._epoch) this._absorb(state);
  }

  private async _ended(epoch: number, outcome: CommandOutcome | undefined, err: unknown): Promise<void> {
    this._endTurn();
    if (epoch !== this._epoch || !this._goal) return;
    if (outcome?.text) this.emit(SESSION_EVENT.RESULT, { type: 'result', result: outcome.text });
    const failure =
      err !== undefined ? (err instanceof Error ? err.message : String(err)) : outcome?.ok ? undefined : outcome?.error;
    if (this._budgetSpent) return;
    if (failure) {
      const code = classifyTurnError(failure);
      this._fail(failure, code);
      this._setStatus(code === 'usageLimitExceeded' ? 'usageLimited' : code === 'unauthorized' ? 'blocked' : 'paused');
      return;
    }
    const state = await this.host.goalState().catch(() => null);
    if (epoch !== this._epoch || !this._goal) return;
    if (state) this._absorb(state);
    // The loop ended and the plugin holds no goal: it was cleared behind the node's back.
    else this._setStatus('paused');
  }
}
