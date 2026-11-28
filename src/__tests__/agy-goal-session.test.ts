// agy's own /goal loop behind the goal node's surface: one long process per goal, its markers read, steers cut
// and continue the conversation, a spent budget cuts the process.
import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';

import {
  AGY_GOAL_CANCEL,
  AGY_GOAL_COMPLETE_MARKER,
  AGY_GOAL_CONTINUE,
  AGY_GOAL_RESUME_NOTE,
  AGY_TURN_USAGE_EVENT,
  AgyGoalSession,
  MAX_GOAL_SEGMENTS,
  MAX_UNMARKED_ENDINGS,
  readAgyGoalReply,
  type AgyGoalHost,
} from '../agy-goal-session.js';
import type { GoalSnapshot } from '../kernel/nodes/goal.js';

const CONV = '9554728a-353a-4d06-8b64-6e05f0e9cc68';

/** A host whose sends are settled by the test, one at a time. */
class FakeHost extends EventEmitter implements AgyGoalHost {
  conversationId: string | undefined = CONV;
  sent: string[] = [];
  interrupts = 0;
  tokensIn = 0;
  tokensOut = 0;
  private pending: Array<{ resolve: (v: unknown) => void; reject: (e: Error) => void }> = [];

  send(message: string): Promise<unknown> {
    this.sent.push(message);
    return new Promise((resolve, reject) => this.pending.push({ resolve, reject }));
  }
  interruptRun(): boolean {
    this.interrupts++;
    this.fail(new Error('Antigravity exited with code null'));
    return true;
  }
  getStats() {
    return { tokensIn: this.tokensIn, tokensOut: this.tokensOut };
  }
  reply(text: string): void {
    this.pending.shift()?.resolve({ text, event: { type: 'result', result: text, stop_reason: 'end_turn' } });
  }
  fail(err: Error): void {
    this.pending.shift()?.reject(err);
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0));

function statuses(goal: AgyGoalSession): string[] {
  const seen: string[] = [];
  goal.on('goal:updated', (g: unknown) => seen.push((g as GoalSnapshot).status));
  return seen;
}

describe('readAgyGoalReply', () => {
  it('reads the markers and strips them', () => {
    expect(readAgyGoalReply(`Done.\n\n${AGY_GOAL_COMPLETE_MARKER}\n`)).toEqual({ ending: 'complete', text: 'Done.' });
    expect(readAgyGoalReply('Stopping.\n<!-- GOAL_CANCELLED -->')).toEqual({ ending: 'cancelled', text: 'Stopping.' });
    expect(readAgyGoalReply('still going')).toEqual({ text: 'still going' });
  });
});

describe('AgyGoalSession', () => {
  it('sets the goal with /goal and completes on the marker, the reply handed on without it', async () => {
    const host = new FakeHost();
    const goal = new AgyGoalSession(host);
    const results: unknown[] = [];
    goal.on('result', (e: unknown) => results.push((e as { result: string }).result));
    const snap = await goal.setGoal({ objective: 'Create g.txt', tokenBudget: null });
    expect(snap.status).toBe('active');
    expect(host.sent).toEqual(['/goal Create g.txt']);
    expect(goal.turnActive).toBe(true);
    host.reply(`Created g.txt.\n\n${AGY_GOAL_COMPLETE_MARKER}`);
    await tick();
    expect(goal.goal?.status).toBe('complete');
    expect(results).toEqual(['Created g.txt.']);
    expect(goal.codexThreadId).toBe(CONV);
  });

  it('is blocked by the cancel marker', async () => {
    const host = new FakeHost();
    const goal = new AgyGoalSession(host);
    await goal.setGoal({ objective: 'x' });
    host.reply('Cancelling.\n<!-- GOAL_CANCELLED -->');
    await tick();
    expect(goal.goal?.status).toBe('blocked');
    expect(goal.lastError?.message).toMatch(/cancelled/);
  });

  it('pauses a run that ended without a marker, and blocks after too many', async () => {
    const host = new FakeHost();
    const goal = new AgyGoalSession(host);
    await goal.setGoal({ objective: 'x' });
    for (let i = 1; i < MAX_UNMARKED_ENDINGS; i++) {
      host.reply('stopped');
      await tick();
      expect(goal.goal?.status).toBe('paused');
      await goal.setGoal({ status: 'active' });
      expect(host.sent.at(-1)).toBe(`/goal x\n\n${AGY_GOAL_RESUME_NOTE}`);
    }
    host.reply('stopped');
    await tick();
    expect(goal.goal?.status).toBe('blocked');
  });

  it('maps a failed run: usage limit, login, anything else', async () => {
    for (const [message, status] of [
      ['RESOURCE_EXHAUSTED: quota exceeded', 'usageLimited'],
      ['not logged in: run agy and sign in', 'blocked'],
      ['socket hang up', 'paused'],
    ] as const) {
      const host = new FakeHost();
      const goal = new AgyGoalSession(host);
      await goal.setGoal({ objective: 'x' });
      host.fail(new Error(message));
      await tick();
      expect(goal.goal?.status).toBe(status);
    }
  });

  it('carries a run that reached its own time cap on in a new process, up to a bound', async () => {
    const host = new FakeHost();
    const goal = new AgyGoalSession(host);
    await goal.setGoal({ objective: 'x' });
    host.fail(new Error('Timeout waiting for Antigravity response'));
    await tick();
    expect(goal.goal?.status).toBe('active');
    expect(host.sent).toEqual(['/goal x', `/goal x\n\n${AGY_GOAL_RESUME_NOTE}`]);
    for (let i = 2; i <= MAX_GOAL_SEGMENTS; i++) {
      host.fail(new Error('Timeout waiting for Antigravity response'));
      await tick();
    }
    expect(goal.goal?.status).toBe('blocked');
  });

  it('steers by cutting the run and continuing the conversation; two steers go together', async () => {
    const host = new FakeHost();
    // A host whose interrupt only cuts: the test ends the process.
    host.interruptRun = function (this: FakeHost) {
      this.interrupts++;
      return true;
    };
    const goal = new AgyGoalSession(host);
    await goal.setGoal({ objective: 'x' });
    expect(await goal.steer('Also do A.')).toEqual({ steered: true });
    expect(await goal.steer('And B.')).toEqual({ steered: true });
    expect(host.interrupts).toBe(1);
    host.fail(new Error('Antigravity exited with code null'));
    await tick();
    expect(host.sent.at(-1)).toBe(`Also do A.\n\nAnd B.\n\n${AGY_GOAL_CONTINUE}`);
    expect(goal.goal?.status).toBe('active');
    host.reply(`ok ${AGY_GOAL_COMPLETE_MARKER}`);
    await tick();
    expect(goal.goal?.status).toBe('complete');
  });

  it('does not steer with no run in flight, or with no conversation yet', async () => {
    const host = new FakeHost();
    const goal = new AgyGoalSession(host);
    expect(await goal.steer('x')).toEqual({ steered: false });
    await goal.setGoal({ objective: 'x' });
    host.conversationId = undefined;
    expect(await goal.steer('x')).toEqual({ steered: false });
  });

  it('cuts the run once the budget is spent mid-run', async () => {
    const host = new FakeHost();
    const goal = new AgyGoalSession(host);
    const seen = statuses(goal);
    await goal.setGoal({ objective: 'x', tokenBudget: 1_000 });
    host.emit(AGY_TURN_USAGE_EVENT, { tokensIn: 500, tokensOut: 10 });
    expect(host.interrupts).toBe(0);
    host.emit(AGY_TURN_USAGE_EVENT, { tokensIn: 990, tokensOut: 20 });
    expect(host.interrupts).toBe(1);
    await tick();
    expect(goal.goal?.status).toBe('budgetLimited');
    expect(seen).toContain('budgetLimited');
  });

  it('pauses by cutting the run', async () => {
    const host = new FakeHost();
    const goal = new AgyGoalSession(host);
    await goal.setGoal({ objective: 'x' });
    await goal.setGoal({ status: 'paused' });
    await tick();
    expect(host.interrupts).toBe(1);
    expect(goal.goal?.status).toBe('paused');
    expect(goal.turnActive).toBe(false);
  });

  it('a new objective replaces the running one: the old run is cut and its ending ignored', async () => {
    const host = new FakeHost();
    host.interruptRun = function (this: FakeHost) {
      this.interrupts++;
      return true;
    };
    const goal = new AgyGoalSession(host);
    await goal.setGoal({ objective: 'first' });
    await goal.setGoal({ objective: 'second' });
    expect(host.interrupts).toBe(1);
    host.reply(`first done ${AGY_GOAL_COMPLETE_MARKER}`);
    await tick();
    expect(host.sent).toEqual(['/goal first', '/goal second']);
    expect(goal.goal).toMatchObject({ objective: 'second', status: 'active' });
  });

  it('clears a goal agy still holds by asking the agent to cancel it', async () => {
    const host = new FakeHost();
    const goal = new AgyGoalSession(host);
    await goal.setGoal({ objective: 'x' });
    const cleared = goal.clearGoal();
    await tick();
    await tick();
    expect(host.sent.at(-1)).toBe(AGY_GOAL_CANCEL);
    host.reply('<!-- GOAL_CANCELLED -->');
    await cleared;
    expect(goal.goal).toBeNull();
  });

  it('clearing a goal that already ended sends nothing', async () => {
    const host = new FakeHost();
    const goal = new AgyGoalSession(host);
    await goal.setGoal({ objective: 'x' });
    host.reply(AGY_GOAL_COMPLETE_MARKER);
    await tick();
    await goal.clearGoal();
    expect(host.sent).toEqual(['/goal x']);
  });

  it('a reopened conversation waits paused for the node to resume it', async () => {
    const host = new FakeHost();
    const goal = new AgyGoalSession(host, { threadId: CONV, resumed: true, objective: 'x', tokensUsed: 500 });
    expect((await goal.getGoal())?.status).toBe('paused');
    expect((await goal.getGoal())?.tokensUsed).toBe(500);
    await goal.setGoal({ status: 'active' });
    expect(host.sent).toEqual([`/goal x\n\n${AGY_GOAL_RESUME_NOTE}`]);
  });

  it('counts tokens from the session and the running process', async () => {
    const host = new FakeHost();
    const goal = new AgyGoalSession(host);
    await goal.setGoal({ objective: 'x' });
    host.emit(AGY_TURN_USAGE_EVENT, { tokensIn: 100, tokensOut: 5 });
    expect(goal.goal?.tokensUsed).toBe(105);
    host.tokensIn = 100;
    host.tokensOut = 5;
    host.reply('stopped');
    await tick();
    expect(goal.goal?.tokensUsed).toBe(105);
  });
});
