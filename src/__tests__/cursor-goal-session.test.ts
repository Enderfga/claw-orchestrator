/**
 * CursorGoalSession — Cursor's own /goal behind the goal node's surface.
 * The host is a fake: each send is one goal process the test ends.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  CURSOR_GOAL_COMPLETE_GRACE_MS,
  CURSOR_GOAL_CONTINUE,
  CursorGoalSession,
  cursorGoalToolUpdate,
} from '../cursor-goal-session.js';
import { MAX_UNDECLARED_TURNS } from '../turn-goal-session.js';

interface Proc {
  text: string;
  opts: Record<string, unknown>;
  resolve: (r: unknown) => void;
  reject: (e: unknown) => void;
}

class FakeHost extends EventEmitter {
  procs: Proc[] = [];
  stats = { tokensIn: 0, tokensOut: 0, cursorChatId: undefined as string | undefined };
  interrupts = 0;
  send(text: string, opts: Record<string, unknown> = {}): Promise<unknown> {
    return new Promise((resolve, reject) => this.procs.push({ text, opts, resolve, reject }));
  }
  interruptRun(): boolean {
    this.interrupts += 1;
    return true;
  }
  getStats() {
    return this.stats;
  }
  /** End the latest process: spend `tokens`, then resolve with `text` or reject with `error`. */
  end(tokens: number, outcome: { text?: string; error?: string } = {}) {
    const p = this.procs.at(-1)!;
    this.stats.tokensIn += tokens;
    if (outcome.error !== undefined) p.reject(new Error(outcome.error));
    else p.resolve({ text: outcome.text ?? '' });
  }
  toolResult(call: Record<string, unknown>) {
    this.emit('tool_result', { type: 'tool_call', subtype: 'completed', tool_call: call });
  }
}

const complete = { updateGoalToolCall: { args: {}, result: { success: { status: 'GOAL_STATUS_COMPLETE' } } } };
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('CursorGoalSession', () => {
  afterEach(() => vi.useRealTimers());

  it('sets the goal with /goal as one long goal process, and completes when the model marks it done', async () => {
    const host = new FakeHost();
    const goal = new CursorGoalSession(host);
    const updates: string[] = [];
    goal.on('goal:updated', (g: { status: string }) => updates.push(g.status));
    const g = await goal.setGoal({ objective: 'make count.txt hold 1 2 3', tokenBudget: null });
    expect(g.status).toBe('active');
    expect(host.procs[0].text).toBe('/goal make count.txt hold 1 2 3');
    expect(host.procs[0].opts.goalRun).toBe(true);
    expect(goal.turnActive).toBe(true);
    host.stats.cursorChatId = 'chat-1';
    host.emit('text', 'working');
    expect(goal.codexThreadId).toBe('chat-1');
    host.toolResult(complete);
    host.end(500, { text: 'done' });
    await flush();
    expect(goal.goal?.status).toBe('complete');
    expect(goal.goal?.tokensUsed).toBe(500);
    expect(updates.at(-1)).toBe('complete');
    expect(host.procs).toHaveLength(1);
  });

  it('continues the chat when Cursor ends a process with the goal still armed, within a bound', async () => {
    const host = new FakeHost();
    const goal = new CursorGoalSession(host);
    await goal.setGoal({ objective: 'x' });
    for (let i = 1; i < MAX_UNDECLARED_TURNS; i++) {
      host.end(1);
      await flush();
      expect(host.procs).toHaveLength(i + 1);
      expect(host.procs[i].text).toBe(CURSOR_GOAL_CONTINUE);
    }
    host.end(1);
    await flush();
    expect(goal.goal?.status).toBe('blocked');
    expect(goal.lastError?.message).toMatch(/without completing/);
  });

  it('holds a steer for the next process, in front of the continuation, without cutting the running one', async () => {
    const host = new FakeHost();
    const goal = new CursorGoalSession(host);
    await goal.setGoal({ objective: 'x' });
    expect(await goal.steer('use the other file')).toEqual({ steered: true });
    // Cursor writes no usage for a process signalled mid-request, so it is left to end.
    expect(host.interrupts).toBe(0);
    host.end(1);
    await flush();
    expect(host.procs[1].text).toBe(`use the other file\n\n${CURSOR_GOAL_CONTINUE}`);
  });

  it('checks the token budget when a process ends, before continuing', async () => {
    const host = new FakeHost();
    const goal = new CursorGoalSession(host);
    await goal.setGoal({ objective: 'x', tokenBudget: 1_000 });
    host.end(400);
    await flush();
    expect(goal.goal?.status).toBe('active');
    expect(host.procs).toHaveLength(2);
    host.end(700);
    await flush();
    expect(goal.goal?.status).toBe('budgetLimited');
    expect(host.procs).toHaveLength(2);
  });

  it('reads a failed process: usage limit, login, anything else', async () => {
    const cases: Array<[string, string]> = [
      ['You have hit your usage limit', 'usageLimited'],
      ['Error: not logged in', 'blocked'],
      ['Cursor exited with code 1', 'paused'],
    ];
    for (const [error, status] of cases) {
      const host = new FakeHost();
      const goal = new CursorGoalSession(host);
      await goal.setGoal({ objective: 'x' });
      host.end(1, { error });
      await flush();
      expect(goal.goal?.status).toBe(status);
      expect(host.procs).toHaveLength(1);
    }
  });

  it('pauses by ending the process; resuming continues the same chat', async () => {
    const host = new FakeHost();
    const goal = new CursorGoalSession(host);
    await goal.setGoal({ objective: 'x' });
    await goal.setGoal({ status: 'paused' });
    expect(host.interrupts).toBe(1);
    host.end(1, { error: 'the Cursor turn was interrupted' });
    await flush();
    expect(goal.goal?.status).toBe('paused');
    expect(host.procs).toHaveLength(1);
    await goal.setGoal({ status: 'active' });
    expect(host.procs[1].text).toBe(CURSOR_GOAL_CONTINUE);
  });

  it('picks up a reopened chat paused, and resumes it with a continuation', async () => {
    const host = new FakeHost();
    host.stats.cursorChatId = 'chat-9';
    const goal = new CursorGoalSession(host, {
      threadId: 'chat-9',
      resumed: true,
      objective: 'x',
      tokensUsed: 100,
    });
    const g = await goal.getGoal();
    expect(g).toMatchObject({ status: 'paused', objective: 'x', tokensUsed: 100 });
    await goal.setGoal({ status: 'active' });
    expect(host.procs[0].text).toBe(CURSOR_GOAL_CONTINUE);
  });

  it('ends a process a background shell holds open after completion, once the grace is over', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const host = new FakeHost();
    const goal = new CursorGoalSession(host);
    await goal.setGoal({ objective: 'x' });
    host.toolResult(complete);
    expect(goal.goal?.status).toBe('active');
    await vi.advanceTimersByTimeAsync(CURSOR_GOAL_COMPLETE_GRACE_MS);
    expect(host.interrupts).toBe(1);
    // Idle by then, so Cursor still writes its usage as it exits.
    host.end(300, { error: 'the Cursor turn was interrupted' });
    await vi.advanceTimersByTimeAsync(0);
    expect(goal.goal).toMatchObject({ status: 'complete', tokensUsed: 300 });
    expect(host.procs).toHaveLength(1);
  });

  it('reads the goal tool calls Cursor streams', () => {
    expect(cursorGoalToolUpdate({ subtype: 'completed', tool_call: complete })).toEqual({ status: 'complete' });
    expect(
      cursorGoalToolUpdate({
        subtype: 'completed',
        tool_call: { createGoalToolCall: { args: { objective: 'x' }, result: { success: {} } } },
      }),
    ).toEqual({ armed: true });
    expect(cursorGoalToolUpdate({ subtype: 'started', tool_call: complete })).toBeUndefined();
    expect(cursorGoalToolUpdate({ subtype: 'completed', tool_call: { readToolCall: {} } })).toBeUndefined();
  });
});
