/**
 * OpencodeGoalSession: OpenCode 2's `/goal` behind the goal node's surface,
 * against a fake host (the session's `goalCommand` / `goalState` / steering).
 */

import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';

import { OpencodeGoalSession, goalStatusOf, type OpencodeGoalState } from '../opencode-goal-session.js';
import type { CommandOutcome } from '../types.js';

class FakeHost extends EventEmitter {
  conversationId: string | undefined = 'ses_goal';
  state: OpencodeGoalState | null = null;
  commands: string[] = [];
  contexts: string[] = [];
  steered: string[] = [];
  interrupts = 0;
  stats = { tokensIn: 0, tokensOut: 0 };
  /** The pending follow of `/goal <objective>` or `resume`: resolve it to end the loop. */
  follow?: (o: CommandOutcome) => void;
  async goalCommand(args: string): Promise<CommandOutcome> {
    this.commands.push(args);
    if (args === 'pause' || args === 'clear') {
      if (args === 'clear') this.state = null;
      else if (this.state) this.state = { ...this.state, status: 'paused' };
      return { name: 'goal', ok: true, text: '', startedTurn: false };
    }
    if (args !== 'resume') this.state = { objective: args, status: 'active', rounds: 0, maxRounds: 50 };
    else if (this.state) this.state = { ...this.state, status: 'active' };
    return new Promise((resolve) => (this.follow = resolve));
  }
  async goalState() {
    return this.state;
  }
  async goalContext(text: string) {
    this.contexts.push(text);
  }
  async deliverMidTurn(text: string) {
    this.steered.push(text);
    return true;
  }
  interruptRun() {
    this.interrupts++;
    return true;
  }
  getStats() {
    return this.stats;
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('OpencodeGoalSession', () => {
  it('maps the plugin statuses, and one it does not name is paused', () => {
    expect(goalStatusOf('active')).toBe('active');
    expect(goalStatusOf('complete')).toBe('complete');
    expect(goalStatusOf('blocked')).toBe('blocked');
    expect(goalStatusOf('paused')).toBe('paused');
    expect(goalStatusOf('something-new')).toBe('paused');
    expect(goalStatusOf(undefined)).toBe('paused');
  });

  it('sets the goal with /goal <objective>, context first, and completes when the judge says so', async () => {
    const host = new FakeHost();
    const g = new OpencodeGoalSession(host);
    const updates: string[] = [];
    g.on('goal:updated', (s: { status: string }) => updates.push(s.status));
    const results: unknown[] = [];
    g.on('result', (r) => results.push(r));
    const snap = await g.setGoal({ objective: 'make both files', context: 'keep it short', tokenBudget: null });
    expect(snap.status).toBe('active');
    expect(host.contexts).toEqual(['keep it short']);
    expect(host.commands).toEqual(['make both files']);
    expect(g.turnActive).toBe(true);
    expect(g.codexThreadId).toBe('ses_goal');
    host.stats = { tokensIn: 900, tokensOut: 100 };
    host.state = { ...host.state!, status: 'complete', reason: 'both exist', rounds: 1 };
    host.follow!({ name: 'goal', ok: true, text: 'done', startedTurn: true });
    await vi.waitFor(() => expect(g.goal?.status).toBe('complete'));
    expect(g.turnActive).toBe(false);
    expect(g.goal?.tokensUsed).toBe(1000);
    expect(updates).toContain('complete');
    expect(results).toEqual([{ type: 'result', result: 'done' }]);
  });

  it('a failed loop is usageLimited on a usage limit, paused otherwise', async () => {
    for (const [error, status] of [
      ['Free usage limit reached. Connect a provider', 'usageLimited'],
      ['socket closed', 'paused'],
    ] as const) {
      const host = new FakeHost();
      const g = new OpencodeGoalSession(host);
      const errors: unknown[] = [];
      g.on('codex:error', (e) => errors.push(e));
      await g.setGoal({ objective: 'x' });
      host.follow!({ name: 'goal', ok: false, text: '', startedTurn: true, error });
      await vi.waitFor(() => expect(g.goal?.status).toBe(status));
      expect(errors).toHaveLength(1);
    }
  });

  it('a loop that ended with the plugin still active is a goal nothing drives: paused', async () => {
    const host = new FakeHost();
    const g = new OpencodeGoalSession(host);
    await g.setGoal({ objective: 'x' });
    host.follow!({ name: 'goal', ok: true, text: '', startedTurn: true });
    await vi.waitFor(() => expect(g.goal?.status).toBe('paused'));
  });

  it('resumes with /goal resume while the plugin holds the goal, and sets it again when it does not', async () => {
    const host = new FakeHost();
    const g = new OpencodeGoalSession(host);
    await g.setGoal({ objective: 'obj' });
    await g.setGoal({ status: 'paused' });
    expect(host.commands.at(-1)).toBe('pause');
    expect(g.goal?.status).toBe('paused');
    host.follow!({ name: 'goal', ok: true, text: '', startedTurn: true });
    await tick();
    await g.setGoal({ status: 'active' });
    expect(host.commands.at(-1)).toBe('resume');
    host.follow!({ name: 'goal', ok: true, text: '', startedTurn: true });
    await tick();
    host.state = null;
    await g.setGoal({ status: 'active' });
    expect(host.commands.at(-1)).toBe('obj');
  });

  it('steers the round in flight, and puts a steer in the conversation when no round runs', async () => {
    const host = new FakeHost();
    const g = new OpencodeGoalSession(host);
    expect(await g.steer('early')).toEqual({ steered: false });
    await g.setGoal({ objective: 'x' });
    expect(await g.steer('now')).toEqual({ steered: true });
    expect(host.steered).toEqual(['now']);
    host.follow!({ name: 'goal', ok: true, text: '', startedTurn: true });
    await vi.waitFor(() => expect(g.turnActive).toBe(false));
    expect(await g.steer('later')).toEqual({ steered: true });
    expect(host.contexts).toEqual(['later']);
    expect(await g.interrupt()).toEqual({ interrupted: false });
  });

  it("a spent token budget pauses the plugin's goal and interrupts the round", async () => {
    vi.useFakeTimers();
    try {
      const host = new FakeHost();
      const g = new OpencodeGoalSession(host);
      await g.setGoal({ objective: 'x', tokenBudget: 500 });
      host.stats = { tokensIn: 450, tokensOut: 100 };
      await vi.advanceTimersByTimeAsync(3_100);
      expect(g.goal?.status).toBe('budgetLimited');
      expect(host.commands).toContain('pause');
      expect(host.interrupts).toBe(1);
      // The loop's end does not turn it into another status.
      host.follow!({ name: 'goal', ok: true, text: '', startedTurn: true });
      await vi.advanceTimersByTimeAsync(10);
      expect(g.goal?.status).toBe('budgetLimited');
    } finally {
      vi.useRealTimers();
    }
  });

  it('a reopened conversation reads its goal paused until the node resumes it', async () => {
    const host = new FakeHost();
    const g = new OpencodeGoalSession(host, {
      threadId: 'ses_goal',
      resumed: true,
      objective: 'from checkpoint',
      tokensUsed: 70,
    });
    const snap = await g.getGoal();
    expect(snap).toMatchObject({ objective: 'from checkpoint', status: 'paused', tokensUsed: 70 });
    // The plugin's own record, when there is one, is read over the checkpoint's.
    host.state = { objective: 'plugin objective', status: 'active' };
    const fresh = new OpencodeGoalSession(host, { resumed: true, objective: 'x' });
    await fresh.setGoal({ status: 'active' });
    expect(host.commands.at(-1)).toBe('resume');
    expect(fresh.goal?.objective).toBe('plugin objective');
  });

  it('clears with /goal clear, and an older loop ending reports to nobody', async () => {
    const host = new FakeHost();
    const g = new OpencodeGoalSession(host);
    await g.setGoal({ objective: 'x' });
    const follow = host.follow!;
    await g.clearGoal();
    expect(host.commands.at(-1)).toBe('clear');
    expect(await g.getGoal()).toBeNull();
    const updates: unknown[] = [];
    g.on('goal:updated', (u) => updates.push(u));
    follow({ name: 'goal', ok: true, text: 'late', startedTurn: true });
    await tick();
    expect(updates).toEqual([]);
  });

  it('closes with the host and stops listening when detached', async () => {
    const host = new FakeHost();
    const g = new OpencodeGoalSession(host);
    const closed = vi.fn();
    g.on('close', closed);
    const text = vi.fn();
    g.on('text', text);
    host.emit('text', 'hello');
    expect(text).toHaveBeenCalledWith('hello');
    host.emit('close', 0);
    expect(closed).toHaveBeenCalled();
    g.detach();
    host.emit('text', 'gone');
    expect(text).toHaveBeenCalledTimes(1);
  });
});
