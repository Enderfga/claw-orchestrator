/**
 * A Claude Code `/goal` behind the `GoalSession` surface the kernel's `goal`
 * node drives, so one node runs a goal on either engine.
 *
 * Codex's app-server owns a goal: it has RPCs to set, pause and read it, and
 * notifies every status change. Claude Code has none of that. What it has,
 * measured on CLI 2.1.312 in stream-json mode:
 *
 *  - `/goal <condition>` sets the goal and starts working. A Stop hook judges
 *    the condition after every turn and feeds the turn back while it does not
 *    hold, all inside the one send; a single `result` arrives when the goal is
 *    met, and the goal clears itself.
 *  - A bare `/goal` answers at once, without a model turn: `Goal active: …` or
 *    `No goal set. …`. That is the only way to read the goal.
 *  - The goal is part of the transcript. A process that dies and is resumed
 *    with `--resume` still has it, but nothing drives it until a message comes.
 *  - The `interrupt` control request ends the running turn with an
 *    `error_during_execution` result and leaves the goal set.
 *
 * So the status here is partly the adapter's own bookkeeping: `active` while a
 * goal turn runs, then a probe after its result decides between `complete` (no
 * goal any more) and `paused` (still set, nothing driving it — the node resumes
 * that within its bound). A goal still set on a freshly opened process is
 * `paused` for the same reason.
 *
 * Tokens are the session's input, output and cache-read tokens; the CLI reports
 * no goal-level count. A reopened process starts its counters at zero, so the
 * node hands over what the thread had already spent.
 */

import { EventEmitter } from 'node:events';
import { SESSION_EVENT } from './constants.js';
import type { GoalSession, GoalSnapshot, GoalStatus } from './kernel/nodes/goal.js';

/** What the adapter needs from a `claude` session. `PersistentClaudeSession` provides it. */
export interface ClaudeGoalHost {
  readonly sessionId?: string;
  send(message: string, options?: { waitForComplete?: boolean; timeout?: number }): Promise<unknown>;
  interruptTurn(): boolean;
  getStats(): { tokensIn: number; tokensOut: number; cachedTokens: number };
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  off(event: string, listener: (...args: unknown[]) => void): unknown;
}

/** What the thread had already spent when this process opened it. */
export interface ClaudeGoalOpen {
  /** The session id the process was started with (`--session-id` or `--resume`). */
  threadId?: string;
  /** The process resumed an existing thread: a goal set on it is not new. */
  resumed?: boolean;
  /** The objective the thread was last given, as the node checkpointed it. */
  objective?: string;
  tokensUsed?: number;
  timeUsedSeconds?: number;
}

type GoalError = { message: string; code: string | null; willRetry: boolean; at: string };

/** Sent to pick a goal back up: the Stop hook keeps it going from there. */
export const CLAUDE_GOAL_CONTINUE = 'Continue working toward the active goal. Pick up from where the work stands now.';

const PROBE_TIMEOUT_MS = 60_000;

/** Map a failed turn's text onto the codex error codes the node treats as transient. */
export function classifyClaudeError(text: string, apiStatus?: unknown): string | null {
  const status = typeof apiStatus === 'number' ? apiStatus : Number.NaN;
  if (status === 429 || /usage limit|rate limit|limit reached|hit your limit|\b429\b/i.test(text)) {
    return 'usageLimitExceeded';
  }
  if (status === 529 || /overloaded|\b529\b/i.test(text)) return 'serverOverloaded';
  if (
    (status >= 500 && status < 600) ||
    /\b5\d\d\b|internal server error|api error|ECONNRESET|ETIMEDOUT|socket hang up|fetch failed|network/i.test(text)
  ) {
    return 'internalServerError';
  }
  return null;
}

/** Read a bare `/goal` answer. */
export function parseGoalProbe(text: string): { active: true; objective: string } | { active: false } | undefined {
  const t = text.trim();
  if (/^no goal set/i.test(t)) return { active: false };
  const m = /^goal active:\s*([\s\S]*?)(?:\s*\((?:not yet evaluated|[^()]*)\))?\s*$/i.exec(t);
  if (m) return { active: true, objective: m[1].trim() };
  return undefined;
}

export class ClaudeGoalSession extends EventEmitter implements GoalSession {
  private _goal: GoalSnapshot | null = null;
  private _lastError: GoalError | null = null;
  private _turnActive = false;
  private _interrupting = false;
  private readonly _tokensAtOpen: number;
  private _budgetFrom = 0;
  private _turnStartedAt: number | null = null;
  private _timeUsed: number;
  private readonly _seedTokens: number;

  private readonly _onText = (...args: unknown[]) => this.emit(SESSION_EVENT.TEXT, ...args);
  private readonly _onClose = (...args: unknown[]) => {
    this._endTurn();
    // What the dead process spent, so the node hands it to the one it reopens.
    if (this._goal) this.emit('goal:updated', this._snapshot());
    this.emit(SESSION_EVENT.CLOSE, ...args);
  };
  private readonly _onResult = (...args: unknown[]) => {
    void this._settle(args[0] as Record<string, unknown> | undefined);
  };

  constructor(
    readonly host: ClaudeGoalHost,
    private readonly open: ClaudeGoalOpen = {},
  ) {
    super();
    this._tokensAtOpen = this._sessionTokens();
    this._seedTokens = open.tokensUsed ?? 0;
    this._timeUsed = open.timeUsedSeconds ?? 0;
    host.on(SESSION_EVENT.TEXT, this._onText);
    host.on(SESSION_EVENT.CLOSE, this._onClose);
    host.on(SESSION_EVENT.RESULT, this._onResult);
  }

  /** Stop listening to the host. The session itself is the manager's to stop. */
  detach(): void {
    this.host.off(SESSION_EVENT.TEXT, this._onText);
    this.host.off(SESSION_EVENT.CLOSE, this._onClose);
    this.host.off(SESSION_EVENT.RESULT, this._onResult);
  }

  /** The Claude session id. Named for the interface, which Codex defined. */
  get codexThreadId(): string | undefined {
    return this.host.sessionId || this.open.threadId;
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
  }): Promise<GoalSnapshot> {
    if (p.objective !== undefined) {
      this._goal = {
        objective: p.objective,
        status: 'active',
        tokenBudget: p.tokenBudget ?? null,
        tokensUsed: this._tokensUsed(),
        timeUsedSeconds: this._seconds(),
      };
      this._budgetFrom = this._tokensUsed();
      await this._startTurn(`/goal ${p.objective}`);
    } else if (p.status === 'paused') {
      if (this._turnActive) this._interrupt();
      this._setStatus('paused');
    } else if (p.status === 'active') {
      if (!this._goal) throw new Error('no goal to resume: set an objective first');
      this._setStatus('active');
      if (!this._turnActive) await this._startTurn(CLAUDE_GOAL_CONTINUE);
    }
    return this._snapshot();
  }

  async getGoal(): Promise<GoalSnapshot | null> {
    if (this._turnActive) {
      this._enforceBudget();
      return this._snapshot();
    }
    if (this._goal?.status === 'complete' || this._goal?.status === 'budgetLimited') return this._snapshot();
    const probe = await this._probe();
    if (probe?.active) {
      // Set, and nothing is working on it: a node that sees `paused` resumes it.
      const keep = this._goal?.status === 'usageLimited' ? 'usageLimited' : 'paused';
      this._goal = this._goal
        ? { ...this._goal, status: keep }
        : {
            objective: this.open.objective || probe.objective,
            status: keep,
            tokenBudget: null,
            tokensUsed: 0,
            timeUsedSeconds: 0,
          };
      this._budgetFrom = this._budgetFrom || this._tokensUsed();
    } else if (probe && !probe.active) {
      // Claude clears a goal when it is met. A thread opened to resume had one set.
      if (this._goal) {
        this._goal = { ...this._goal, status: 'complete' };
      } else if (!this._goal && this.open.resumed) {
        const objective = this.open.objective ?? '';
        this._goal = { objective, status: 'complete', tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0 };
      }
    }
    return this._goal ? this._snapshot() : null;
  }

  async clearGoal(): Promise<void> {
    if (this._turnActive) this._interrupt();
    await this.host.send('/goal clear', { waitForComplete: true, timeout: PROBE_TIMEOUT_MS }).catch(() => undefined);
    this._goal = null;
  }

  async steer(text: string): Promise<{ steered: boolean }> {
    if (!this._turnActive) return { steered: false };
    // A message written during a turn is folded into it by the CLI.
    await this.host.send(text, { waitForComplete: false });
    return { steered: true };
  }

  async interrupt(): Promise<{ interrupted: boolean }> {
    if (!this._turnActive) return { interrupted: false };
    return { interrupted: this._interrupt() };
  }

  // ─── Internals ─────────────────────────────────────────────────────────

  private _sessionTokens(): number {
    try {
      const s = this.host.getStats();
      return (s.tokensIn || 0) + (s.tokensOut || 0) + (s.cachedTokens || 0);
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

  private async _startTurn(text: string): Promise<void> {
    this._turnActive = true;
    this._interrupting = false;
    this._turnStartedAt = Date.now();
    try {
      await this.host.send(text, { waitForComplete: false });
    } catch (err) {
      this._endTurn();
      this._fail((err as Error).message, null);
    }
  }

  private _endTurn(): void {
    if (this._turnStartedAt !== null) this._timeUsed += (Date.now() - this._turnStartedAt) / 1000;
    this._turnStartedAt = null;
    this._turnActive = false;
  }

  private _interrupt(): boolean {
    this._interrupting = true;
    return this.host.interruptTurn();
  }

  private _fail(message: string, code: string | null): void {
    this._lastError = { message, code, willRetry: false, at: new Date().toISOString() };
    this.emit('codex:error', this._lastError);
  }

  /** Past its budget the goal stops, as Codex's does: `budgetLimited` is terminal. */
  private _enforceBudget(): void {
    const budget = this._goal?.tokenBudget;
    if (!budget || this._goal?.status !== 'active') return;
    if (this._tokensUsed() - this._budgetFrom < budget) return;
    if (this._turnActive) this._interrupt();
    this._setStatus('budgetLimited');
  }

  private async _probe(): Promise<ReturnType<typeof parseGoalProbe>> {
    try {
      const r = (await this.host.send('/goal', { waitForComplete: true, timeout: PROBE_TIMEOUT_MS })) as {
        text?: unknown;
      };
      return typeof r?.text === 'string' ? parseGoalProbe(r.text) : undefined;
    } catch {
      return undefined;
    }
  }

  /** A goal turn ended: read why, and what the goal is now. */
  private async _settle(event: Record<string, unknown> | undefined): Promise<void> {
    if (!this._turnActive || !event) return;
    this._endTurn();
    this.emit(SESSION_EVENT.RESULT, event);
    const text = typeof event.result === 'string' ? event.result : '';
    const failed = !!event.is_error || event.stop_reason === 'error' || String(event.subtype ?? '').startsWith('error');
    if (this._interrupting) {
      this._interrupting = false;
      // A stop we asked for: pause and budget already set the status.
      if (this._goal?.status === 'active') this._setStatus('paused');
      return;
    }
    if (failed) {
      const code = classifyClaudeError(text, event.api_error_status);
      this._fail(text || String(event.subtype ?? 'the turn failed'), code);
      this._setStatus(code === 'usageLimitExceeded' ? 'usageLimited' : 'paused');
      return;
    }
    const probe = await this._probe();
    if (probe && !probe.active) this._setStatus('complete');
    else if (probe?.active) this._setStatus('paused');
    else this._enforceBudget();
  }
}
