/**
 * A goal on an engine with no goal loop of its own — Antigravity, Grok Build,
 * OpenCode, an ACP agent — behind the `GoalSession` surface the kernel's `goal`
 * node drives.
 *
 * Codex's app-server and Claude Code's `/goal` each keep one thread working
 * turn after turn until the goal is met. These engines run one turn per send
 * and stop when the model does. So the loop is ours: the objective goes out
 * with a short protocol, and when a turn ends without the agent declaring the
 * goal complete or blocked, the next turn on the same conversation tells it to
 * continue. The agent declares an ending on the last line of a reply:
 *
 *     GOAL COMPLETE
 *     GOAL BLOCKED: <why>
 *
 * As on Codex, that is the agent's own call; the verifier's contract is the
 * verdict.
 *
 * Statuses: `active` while the loop runs; `complete` and `blocked` as declared;
 * `budgetLimited` once the turns have spent `tokenBudget`; `usageLimited` for a
 * turn refused at a usage or rate limit, and `paused` for any other failed turn
 * (a timeout, a network error, a crashed CLI) — the node resumes both within
 * its bound. A failed login is `blocked`: resuming cannot fix it. So is a loop
 * whose agent stops turn after turn without ever declaring an ending
 * (`MAX_UNDECLARED_TURNS`).
 *
 * Text the node steers in reaches the turn in flight where the engine takes
 * input mid-turn (`deliverMidTurn`), and otherwise opens the next turn. A turn
 * in flight cannot be cut short: a pause or a spent budget takes effect when it
 * ends, and the node's cancel stops the session itself.
 *
 * Tokens are the session's input and output tokens; cache reads are left out,
 * since every turn on a resumed conversation reads it again (see
 * `ClaudeGoalSession`). A reopened session starts its counters at zero, so the
 * node hands over what the conversation had already spent.
 */

import { EventEmitter } from 'node:events';
import { SESSION_EVENT } from './constants.js';
import { classifyClaudeError } from './claude-goal-session.js';
import type { GoalSession, GoalSnapshot, GoalStatus } from './kernel/nodes/goal.js';
import type { EngineType } from './types.js';

/** Engines whose goals this adapter runs: one turn per send, and no goal loop of their own. */
export const TURN_GOAL_ENGINES: ReadonlySet<EngineType> = new Set<EngineType>([
  'agy',
  'grok',
  'opencode',
  'cursor',
  'acp',
]);

/** What the adapter needs from a session. Every one-shot engine's session provides it. */
export interface TurnGoalHost {
  send(message: string, options?: { waitForComplete?: boolean; timeout?: number }): Promise<unknown>;
  /** Hand text to the turn in flight; false when the engine cannot take it mid-turn. */
  deliverMidTurn?(text: string): Promise<boolean>;
  getStats(): { tokensIn: number; tokensOut: number };
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  removeListener(event: string, listener: (...args: unknown[]) => void): unknown;
}

/** What the conversation had already spent when this session opened it. */
export interface TurnGoalOpen {
  /** The conversation id the session was resumed with. */
  threadId?: string;
  /** The session resumed an existing conversation. */
  resumed?: boolean;
  /** The objective the conversation was last given, as the node checkpointed it. */
  objective?: string;
  tokensUsed?: number;
  timeUsedSeconds?: number;
}

type GoalError = { message: string; code: string | null; willRetry: boolean; at: string };

export const GOAL_COMPLETE_MARKER = 'GOAL COMPLETE';
export const GOAL_BLOCKED_MARKER = 'GOAL BLOCKED';

/** How the agent ends the goal; sent with the objective and repeated in every continuation. */
export const TURN_GOAL_PROTOCOL =
  `When the objective is fully achieved, end your reply with a last line reading exactly ` +
  `\`${GOAL_COMPLETE_MARKER}\`. If you cannot make further progress without outside help, end it with ` +
  `\`${GOAL_BLOCKED_MARKER}: <the reason>\`. Until then keep working: when you stop without either line, ` +
  `you will be asked to continue. Nobody reads questions in between; decide for yourself and go on.`;

/** The first turn of a goal: the objective, then the protocol. */
export function turnGoalPrompt(objective: string): string {
  return `${objective}\n\n---\n\nThis is a goal that runs over as many turns as it needs. ${TURN_GOAL_PROTOCOL}`;
}

/** Every later turn. Steer text, if any, goes in front of it. */
export const TURN_GOAL_CONTINUE = `Continue working toward the goal you were given. ${TURN_GOAL_PROTOCOL}`;

/**
 * Turns in a row the agent may end without declaring the goal complete or
 * blocked. A goal does need many turns on these engines, since each ends when
 * the model stops; an agent that keeps stopping and never says why is stuck.
 */
export const MAX_UNDECLARED_TURNS = 30;

/** One turn may run this long; a turn that outlives it is a failed turn, and the node resumes the goal. */
export const TURN_GOAL_TURN_TIMEOUT_MS = 3 * 60 * 60_000;

/** Map a failed turn's error onto the codes the node treats as transient; see `classifyClaudeError`. */
export function classifyTurnError(text: string): string | null {
  const code = classifyClaudeError(text);
  if (code) return code;
  // Antigravity and the Gemini API word an exhausted allowance this way.
  if (/quota|resource.?exhausted|out of credits|insufficient credits/i.test(text)) return 'usageLimitExceeded';
  return null;
}

/** The ending the agent declared on the last line of its reply, if any. */
export function parseGoalDeclaration(
  text: string,
): { status: 'complete' } | { status: 'blocked'; reason: string } | undefined {
  const last = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .at(-1);
  if (!last) return undefined;
  // Markdown around the line (`**GOAL COMPLETE**`, a code span, a heading) is not part of it.
  const line = last.replace(/^[#>*_`\s-]+|[*_`\s.!]+$/g, '');
  if (new RegExp(`^${GOAL_COMPLETE_MARKER}$`, 'i').test(line)) return { status: 'complete' };
  const blocked = new RegExp(`^${GOAL_BLOCKED_MARKER}\\b\\s*[:—–-]?\\s*(.*)$`, 'i').exec(line);
  if (blocked) return { status: 'blocked', reason: blocked[1].trim() || 'the agent declared the goal blocked' };
  return undefined;
}

export class TurnGoalSession extends EventEmitter implements GoalSession {
  private _goal: GoalSnapshot | null = null;
  private _lastError: GoalError | null = null;
  private _turnActive = false;
  /** Bumped by every new objective and every clear: a turn from an older loop reports to nobody. */
  private _epoch = 0;
  private _undeclared = 0;
  private _pending: string[] = [];
  private readonly _tokensAtOpen: number;
  private readonly _seedTokens: number;
  private _budgetFrom = 0;
  private _turnStartedAt: number | null = null;
  private _timeUsed: number;
  private _closed = false;
  /** A turn to start once the one in flight ends: a one-shot session runs one turn at a time. */
  private _next: { text: string; epoch: number } | null = null;

  private readonly _onText = (...args: unknown[]) => this.emit(SESSION_EVENT.TEXT, ...args);
  private readonly _onClose = (...args: unknown[]) => {
    this._closed = true;
    this._endTurn();
    // What the dead session spent, so the node hands it to the one it reopens.
    if (this._goal) this.emit('goal:updated', this._snapshot());
    this.emit(SESSION_EVENT.CLOSE, ...args);
  };

  constructor(
    readonly host: TurnGoalHost,
    /** The engine's own resumable conversation id, once it has one. */
    private readonly resumeId: () => string | undefined,
    private readonly open: TurnGoalOpen = {},
  ) {
    super();
    this._tokensAtOpen = this._sessionTokens();
    this._seedTokens = open.tokensUsed ?? 0;
    this._timeUsed = open.timeUsedSeconds ?? 0;
    host.on(SESSION_EVENT.TEXT, this._onText);
    host.on(SESSION_EVENT.CLOSE, this._onClose);
  }

  /** Stop listening to the host. The session itself is the manager's to stop. */
  detach(): void {
    this._epoch += 1;
    this.host.removeListener(SESSION_EVENT.TEXT, this._onText);
    this.host.removeListener(SESSION_EVENT.CLOSE, this._onClose);
  }

  /**
   * The conversation id. A new conversation has none until its first turn ends;
   * the node checkpoints it as soon as it appears.
   */
  get codexThreadId(): string | undefined {
    return this.resumeId() || this.open.threadId;
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
      this._undeclared = 0;
      const first = turnGoalPrompt(p.objective);
      this._startTurn(p.context?.trim() ? `${p.context.trim()}\n\n${first}` : first);
    } else if (p.status === 'paused') {
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
      this._setStatus('active');
      this._undeclared = 0;
      if (!this._turnActive) this._startTurn(this._continuation());
    }
    return this._snapshot();
  }

  async getGoal(): Promise<GoalSnapshot | null> {
    if (!this._goal && this.open.resumed && this.open.objective) {
      // Nothing here drives a goal across a restart; it waits, `paused`, for the node to resume it.
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
    this._pending = [];
  }

  async steer(text: string): Promise<{ steered: boolean }> {
    if (!this._goal) return { steered: false };
    if (this._turnActive && this.host.deliverMidTurn) {
      const delivered = await this.host.deliverMidTurn(text).catch(() => false);
      if (delivered) return { steered: true };
    }
    // Opens the next turn of the loop.
    this._pending.push(text);
    return { steered: true };
  }

  async interrupt(): Promise<{ interrupted: boolean }> {
    // A one-shot turn has no way to be cut short; the node stops the session to cancel.
    return { interrupted: false };
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

  private _continuation(): string {
    const steers = this._pending.splice(0);
    return steers.length ? `${steers.join('\n\n')}\n\n${TURN_GOAL_CONTINUE}` : TURN_GOAL_CONTINUE;
  }

  private _budgetSpent(): boolean {
    const budget = this._goal?.tokenBudget;
    return !!budget && this._tokensUsed() - this._budgetFrom >= budget;
  }

  private _endTurn(): void {
    if (this._turnStartedAt !== null) this._timeUsed += (Date.now() - this._turnStartedAt) / 1000;
    this._turnStartedAt = null;
    this._turnActive = false;
  }

  /** Run one turn and act on how it ended; the next one starts from here while the goal is active. */
  private _startTurn(text: string): void {
    if (this._closed) return;
    const epoch = this._epoch;
    if (this._turnActive) {
      this._next = { text, epoch };
      return;
    }
    this._turnActive = true;
    this._turnStartedAt = Date.now();
    void this.host.send(text, { waitForComplete: true, timeout: TURN_GOAL_TURN_TIMEOUT_MS }).then(
      (r) => this._turnEnded(epoch, r, undefined),
      (err: unknown) => this._turnEnded(epoch, undefined, err),
    );
  }

  private _turnEnded(epoch: number, result: unknown, err: unknown): void {
    this._endTurn();
    const next = this._next;
    this._next = null;
    if (next && next.epoch === this._epoch && this._goal) {
      // A new objective was set while this turn ran; this turn's ending is no longer news.
      if (epoch !== this._epoch) return this._startTurn(next.text);
    }
    if (epoch !== this._epoch || !this._goal) return;
    const text = typeof (result as { text?: unknown })?.text === 'string' ? (result as { text: string }).text : '';
    if (err !== undefined) {
      const message = err instanceof Error ? err.message : String(err);
      const code = classifyTurnError(message);
      this._fail(message, code);
      if (this._goal.status === 'active') {
        this._setStatus(
          code === 'usageLimitExceeded' ? 'usageLimited' : code === 'unauthorized' ? 'blocked' : 'paused',
        );
      }
      return;
    }
    this.emit(SESSION_EVENT.RESULT, { type: 'result', result: text });
    // A conversation resumed by id must come back as that conversation, or the goal is starting over.
    const id = this.resumeId();
    if (this.open.resumed && this.open.threadId && id && id !== this.open.threadId) {
      this._fail(`resumed conversation ${this.open.threadId} came back as ${id}`, null);
      this._setStatus('blocked');
      return;
    }
    if (this._goal.status !== 'active') {
      // Paused while the turn ran: it stays paused. A thread id that appeared is news worth checkpointing.
      this.emit('goal:updated', this._snapshot());
      return;
    }
    const declared = parseGoalDeclaration(text);
    if (declared?.status === 'complete') return this._setStatus('complete');
    if (declared?.status === 'blocked') {
      this._fail(declared.reason, null);
      return this._setStatus('blocked');
    }
    if (this._budgetSpent()) return this._setStatus('budgetLimited');
    this._undeclared += 1;
    if (this._undeclared >= MAX_UNDECLARED_TURNS) {
      this._fail(
        `the agent ended ${this._undeclared} turns in a row without declaring the goal complete or blocked`,
        null,
      );
      return this._setStatus('blocked');
    }
    // Progress so far, and the thread id once the first turn has made one.
    this.emit('goal:updated', this._snapshot());
    this._startTurn(this._continuation());
  }
}
