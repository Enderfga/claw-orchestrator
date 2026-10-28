/**
 * `ClaudeGoalSession`: a Claude Code `/goal` behind the goal node's surface.
 *
 * The host is a fake `claude` session that answers a bare `/goal` the way CLI
 * 2.1.312 does (measured in stream-json mode) and lets each test end the goal
 * turn with whatever `result` it needs. What these pin is the adapter's reading
 * of the CLI: which ending means complete, paused, usage-limited or stopped,
 * and that a reopened thread carries on from what it had already spent.
 */

import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  CLAUDE_GOAL_CONTINUE,
  ClaudeGoalSession,
  classifyClaudeError,
  parseGoalProbe,
} from '../claude-goal-session.js';
import type { GoalSnapshot } from '../kernel/nodes/goal.js';

class FakeClaudeHost extends EventEmitter {
  sessionId?: string;
  sent: Array<{ text: string; wait: boolean }> = [];
  interrupts = 0;
  /** What a bare `/goal` answers right now. */
  probe = 'No goal set. Usage: `/goal <condition>`';
  stats = { tokensIn: 0, tokensOut: 0, cachedTokens: 0 };

  async send(text: string, options: { waitForComplete?: boolean } = {}): Promise<unknown> {
    this.sent.push({ text, wait: !!options.waitForComplete });
    if (text === '/goal') {
      const result = { type: 'result', subtype: 'success', result: this.probe };
      this.emit('result', result);
      return { text: this.probe, event: result };
    }
    if (text === '/goal clear') {
      this.probe = 'No goal set. Usage: `/goal <condition>`';
      return { text: 'Goal cleared', event: {} };
    }
    return { requestId: this.sent.length, sent: true };
  }
  interruptTurn(): boolean {
    this.interrupts++;
    return true;
  }
  getStats() {
    return this.stats;
  }
  /** End the running turn the way the CLI does. */
  end(result: Record<string, unknown>): void {
    this.emit('result', { type: 'result', ...result });
  }
}

const tick = () => new Promise((r) => setImmediate(r));

function updates(s: ClaudeGoalSession): GoalSnapshot[] {
  const seen: GoalSnapshot[] = [];
  s.on('goal:updated', (g) => seen.push(g as GoalSnapshot));
  return seen;
}

describe('ClaudeGoalSession', () => {
  it('sets the goal with /goal and ends complete when the CLI has cleared it', async () => {
    const host = new FakeClaudeHost();
    const s = new ClaudeGoalSession(host, { threadId: 'sess-1' });
    const seen = updates(s);
    const results: unknown[] = [];
    s.on('result', (r) => results.push(r));

    const g = await s.setGoal({ objective: 'tests pass', tokenBudget: null });
    expect(g.status).toBe('active');
    expect(s.turnActive).toBe(true);
    expect(host.sent[0]).toEqual({ text: '/goal tests pass', wait: false });
    expect(s.codexThreadId).toBe('sess-1');

    host.end({ subtype: 'success', result: 'all green' });
    await tick();
    expect(s.turnActive).toBe(false);
    expect(seen.at(-1)?.status).toBe('complete');
    // The goal turn's result is passed on; the probe's is not.
    expect(results).toHaveLength(1);
    expect((results[0] as { result: string }).result).toBe('all green');
  });

  it('reads a goal still set after its turn ended as paused, and continues it on active', async () => {
    const host = new FakeClaudeHost();
    const s = new ClaudeGoalSession(host);
    const seen = updates(s);
    await s.setGoal({ objective: 'ship it' });
    host.probe = 'Goal active: ship it (not yet evaluated)';
    host.end({ subtype: 'success', result: 'stopped early' });
    await tick();
    expect(seen.at(-1)?.status).toBe('paused');

    await s.setGoal({ status: 'active' });
    expect(s.turnActive).toBe(true);
    expect(host.sent.at(-1)).toEqual({ text: CLAUDE_GOAL_CONTINUE, wait: false });
  });

  it('turns a usage-limit failure into usageLimited with a transient error code', async () => {
    const host = new FakeClaudeHost();
    const s = new ClaudeGoalSession(host);
    const seen = updates(s);
    const errors: Array<{ code: string | null }> = [];
    s.on('codex:error', (e) => errors.push(e as { code: string | null }));
    await s.setGoal({ objective: 'x' });
    host.end({ subtype: 'error_during_execution', is_error: true, result: 'Claude AI usage limit reached|1793190600' });
    await tick();
    expect(errors[0].code).toBe('usageLimitExceeded');
    expect(seen.at(-1)?.status).toBe('usageLimited');
    expect(s.lastError?.willRetry).toBe(false);
  });

  it('treats the result of a stop it asked for as a pause, not an error', async () => {
    const host = new FakeClaudeHost();
    const s = new ClaudeGoalSession(host);
    const errors: unknown[] = [];
    s.on('codex:error', (e) => errors.push(e));
    await s.setGoal({ objective: 'x' });
    const r = await s.interrupt();
    expect(r.interrupted).toBe(true);
    expect(host.interrupts).toBe(1);
    host.end({ subtype: 'error_during_execution', is_error: true, stop_reason: 'tool_use' });
    await tick();
    expect(errors).toHaveLength(0);
    expect(s.goal?.status).toBe('paused');
  });

  it('pauses by interrupting the running turn', async () => {
    const host = new FakeClaudeHost();
    const s = new ClaudeGoalSession(host);
    await s.setGoal({ objective: 'x' });
    const g = await s.setGoal({ status: 'paused' });
    expect(host.interrupts).toBe(1);
    expect(g.status).toBe('paused');
  });

  it('reads a reopened thread: a goal still set is paused, a cleared one is complete', async () => {
    const host = new FakeClaudeHost();
    host.probe = 'Goal active: make it faster (not yet evaluated)';
    const open = { threadId: 'sess-9', resumed: true, objective: 'make it faster (2x)' };
    const s = new ClaudeGoalSession(host, open);
    const g = await s.getGoal();
    expect(g?.status).toBe('paused');
    // The checkpointed objective wins over the probe's rendering of it.
    expect(g?.objective).toBe('make it faster (2x)');

    const done = new ClaudeGoalSession(new FakeClaudeHost(), open);
    expect((await done.getGoal())?.status).toBe('complete');
  });

  it('has no goal on a new thread nobody set one on', async () => {
    const s = new ClaudeGoalSession(new FakeClaudeHost(), { threadId: 'fresh' });
    expect(await s.getGoal()).toBeNull();
  });

  it('carries the thread spend across a reopen and stops past the token budget', async () => {
    const host = new FakeClaudeHost();
    host.stats = { tokensIn: 100, tokensOut: 0, cachedTokens: 0 };
    const s = new ClaudeGoalSession(host, { tokensUsed: 5000, timeUsedSeconds: 60 });
    const seen = updates(s);
    await s.setGoal({ objective: 'x', tokenBudget: 1000 });
    // Counted from this process's open, on top of what the thread already spent.
    expect(s.goal?.tokensUsed).toBe(5000);
    expect(s.goal?.timeUsedSeconds).toBeGreaterThanOrEqual(60);

    host.stats = { tokensIn: 600, tokensOut: 200, cachedTokens: 300 };
    const g = await s.getGoal();
    expect(g?.tokensUsed).toBe(6000);
    expect(host.interrupts).toBe(1);
    expect(seen.at(-1)?.status).toBe('budgetLimited');
  });

  it('steers only into a running turn', async () => {
    const host = new FakeClaudeHost();
    const s = new ClaudeGoalSession(host);
    expect((await s.steer('log the round')).steered).toBe(false);
    await s.setGoal({ objective: 'x' });
    expect((await s.steer('log the round')).steered).toBe(true);
    expect(host.sent.at(-1)).toEqual({ text: 'log the round', wait: false });
  });

  it('refuses to resume a goal it never knew', async () => {
    const s = new ClaudeGoalSession(new FakeClaudeHost());
    await expect(s.setGoal({ status: 'active' })).rejects.toThrow(/no goal to resume/);
  });

  it('ends the turn when the process exits', async () => {
    const host = new FakeClaudeHost();
    const s = new ClaudeGoalSession(host);
    const closed: unknown[] = [];
    s.on('close', (c) => closed.push(c));
    const seen = updates(s);
    await s.setGoal({ objective: 'x' });
    host.stats = { tokensIn: 50, tokensOut: 10, cachedTokens: 0 };
    host.emit('close', 1);
    expect(s.turnActive).toBe(false);
    expect(closed).toEqual([1]);
    // The spend up to the exit reaches the node before it reopens the thread.
    expect(seen.at(-1)?.tokensUsed).toBe(60);
  });

  it('stops listening to the host once detached', async () => {
    const host = new FakeClaudeHost();
    const s = new ClaudeGoalSession(host);
    s.detach();
    expect(host.listenerCount('result')).toBe(0);
    expect(host.listenerCount('text')).toBe(0);
    expect(host.listenerCount('close')).toBe(0);
  });
});

describe('parseGoalProbe', () => {
  it('reads the two answers of a bare /goal', () => {
    expect(parseGoalProbe('No goal set. Usage: `/goal <condition>`')).toEqual({ active: false });
    expect(parseGoalProbe('Goal active: files exist (not yet evaluated)')).toEqual({
      active: true,
      objective: 'files exist',
    });
    expect(parseGoalProbe('something else')).toBeUndefined();
  });
});

describe('classifyClaudeError', () => {
  it('maps capacity failures onto the codes the node retries', () => {
    expect(classifyClaudeError('', 429)).toBe('usageLimitExceeded');
    expect(classifyClaudeError("You've hit your limit · resets 3am")).toBe('usageLimitExceeded');
    expect(classifyClaudeError('API Error: 529 {"type":"overloaded_error"}')).toBe('serverOverloaded');
    expect(classifyClaudeError('API Error: 500 Internal server error')).toBe('internalServerError');
    expect(classifyClaudeError('the model refused')).toBeNull();
  });
});
