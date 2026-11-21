/**
 * A goal on an engine with no goal loop of its own: `TurnGoalSession` runs the
 * loop turn by turn, until the agent declares the goal complete or blocked, the
 * budget is spent, or a turn fails. The host here is a fake one-shot session
 * that answers each turn from a script.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import {
  MAX_UNDECLARED_TURNS,
  TURN_GOAL_CONTINUE,
  TurnGoalSession,
  classifyTurnError,
  parseGoalDeclaration,
} from '../turn-goal-session.js';
import { RunKernel } from '../kernel/engine.js';
import { registerDefaultExecutors } from '../kernel/nodes/index.js';
import { goalWorkflow } from '../kernel/templates/index.js';
import type { GoalNodeData } from '../kernel/nodes/goal.js';

type Reply = string | Error | ((prompt: string) => string | Error);

/** A one-shot session: each send is one turn, answered by the next scripted reply. */
class FakeTurnHost extends EventEmitter {
  prompts: string[] = [];
  tokensIn = 0;
  tokensOut = 0;
  conversation: string | undefined;
  constructor(
    private readonly script: Reply[],
    private readonly opts: { conversation?: string; tokensPerTurn?: number; hold?: Promise<void> } = {},
  ) {
    super();
  }
  async send(message: string): Promise<{ text: string }> {
    this.prompts.push(message);
    await this.opts.hold;
    await new Promise((r) => setTimeout(r, 1));
    const next = this.script.shift() ?? 'still working';
    const reply = typeof next === 'function' ? next(message) : next;
    this.tokensIn += this.opts.tokensPerTurn ?? 10;
    this.tokensOut += 5;
    // The engine hands out its conversation id with the first turn.
    this.conversation ??= this.opts.conversation;
    if (reply instanceof Error) throw reply;
    this.emit('text', reply);
    return { text: reply };
  }
  getStats() {
    return { tokensIn: this.tokensIn, tokensOut: this.tokensOut };
  }
}

function until(cond: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (cond()) return resolve();
      if (Date.now() - start > ms) return reject(new Error('timed out waiting'));
      setTimeout(tick, 2);
    };
    tick();
  });
}

const adapter = (host: FakeTurnHost, open = {}) => new TurnGoalSession(host, () => host.conversation, open);

describe('parseGoalDeclaration', () => {
  it('reads the last line only, with markdown around it', () => {
    expect(parseGoalDeclaration('done.\n\nGOAL COMPLETE')).toEqual({ status: 'complete' });
    expect(parseGoalDeclaration('done\n**GOAL COMPLETE**\n')).toEqual({ status: 'complete' });
    expect(parseGoalDeclaration('`goal complete`.')).toEqual({ status: 'complete' });
    expect(parseGoalDeclaration('GOAL BLOCKED: the GPU is gone')).toEqual({
      status: 'blocked',
      reason: 'the GPU is gone',
    });
    expect(parseGoalDeclaration('GOAL BLOCKED')).toMatchObject({ status: 'blocked' });
    // Quoting the protocol, or saying it before more work, is not a declaration.
    expect(parseGoalDeclaration('I will end with GOAL COMPLETE when done.')).toBeUndefined();
    expect(parseGoalDeclaration('GOAL COMPLETE\nbut first, the tests')).toBeUndefined();
    expect(parseGoalDeclaration('')).toBeUndefined();
  });

  it('counts an exhausted allowance as a usage limit', () => {
    expect(classifyTurnError('429 RESOURCE_EXHAUSTED: quota exceeded')).toBe('usageLimitExceeded');
    expect(classifyTurnError('You are out of credits')).toBe('usageLimitExceeded');
    expect(classifyTurnError('Timeout waiting for Antigravity response')).toBeNull();
  });
});

describe('TurnGoalSession', () => {
  it('sends the objective with the protocol, continues the turns that declare nothing, and ends on GOAL COMPLETE', async () => {
    const host = new FakeTurnHost(['wrote half', 'wrote the rest', 'all checks pass\nGOAL COMPLETE'], {
      conversation: 'conv-1',
    });
    const g = adapter(host);
    expect(g.codexThreadId).toBeUndefined();
    const updates: string[] = [];
    g.on('goal:updated', (s) => updates.push((s as { status: string }).status));
    await g.setGoal({ objective: 'build the game', tokenBudget: null });
    await until(() => g.goal?.status === 'complete');
    expect(host.prompts).toHaveLength(3);
    expect(host.prompts[0]).toMatch(/^build the game\n\n---\n\n/);
    expect(host.prompts[0]).toContain('GOAL COMPLETE');
    expect(host.prompts[1]).toBe(TURN_GOAL_CONTINUE);
    expect(g.codexThreadId).toBe('conv-1');
    expect(g.goal).toMatchObject({ status: 'complete', tokensUsed: 45 });
    expect(updates.at(-1)).toBe('complete');
    expect(g.turnActive).toBe(false);
  });

  it('ends blocked on GOAL BLOCKED, with the reason as the error', async () => {
    const host = new FakeTurnHost(['GOAL BLOCKED: no network in the sandbox']);
    const g = adapter(host);
    await g.setGoal({ objective: 'x' });
    await until(() => g.goal?.status === 'blocked');
    expect(g.lastError).toMatchObject({ message: 'no network in the sandbox', code: null });
    expect(host.prompts).toHaveLength(1);
  });

  it('stops at the token budget without starting another turn', async () => {
    const host = new FakeTurnHost([], { tokensPerTurn: 100 });
    const g = adapter(host);
    await g.setGoal({ objective: 'x', tokenBudget: 250 });
    await until(() => g.goal?.status === 'budgetLimited');
    // 105 tokens a turn: the third turn crosses 250.
    expect(host.prompts).toHaveLength(3);
  });

  it('turns a usage limit into usageLimited and a failed login into blocked; resuming continues the conversation', async () => {
    const host = new FakeTurnHost([new Error('429: rate limit reached, try later'), 'GOAL COMPLETE']);
    const g = adapter(host);
    await g.setGoal({ objective: 'x' });
    await until(() => g.goal?.status === 'usageLimited');
    expect(g.lastError?.code).toBe('usageLimitExceeded');
    await g.setGoal({ status: 'active' });
    await until(() => g.goal?.status === 'complete');
    expect(host.prompts[1]).toBe(TURN_GOAL_CONTINUE);

    const auth = new FakeTurnHost([new Error('Not logged in. Please run /login')]);
    const a = adapter(auth);
    await a.setGoal({ objective: 'x' });
    await until(() => a.goal?.status === 'blocked');
    expect(a.lastError?.code).toBe('unauthorized');

    const flaky = new FakeTurnHost([new Error('Timeout waiting for Grok response')]);
    const f = adapter(flaky);
    await f.setGoal({ objective: 'x' });
    await until(() => f.goal?.status === 'paused');
  });

  it('puts steer text in front of the next turn when the engine takes nothing mid-turn', async () => {
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const host = new FakeTurnHost(['first', 'GOAL COMPLETE'], { hold });
    const g = adapter(host);
    await g.setGoal({ objective: 'x' });
    expect(g.turnActive).toBe(true);
    expect(await g.steer('Use the red palette.')).toEqual({ steered: true });
    release();
    await until(() => g.goal?.status === 'complete');
    expect(host.prompts[1]).toBe(`Use the red palette.\n\n${TURN_GOAL_CONTINUE}`);
  });

  it('gives up, blocked, on an agent that keeps stopping without declaring anything', async () => {
    const host = new FakeTurnHost([]);
    const g = adapter(host);
    await g.setGoal({ objective: 'x' });
    await until(() => g.goal?.status === 'blocked', 10_000);
    expect(host.prompts).toHaveLength(MAX_UNDECLARED_TURNS);
    expect(g.lastError?.message).toMatch(/without declaring the goal complete or blocked/);
  });

  it('refuses to go on when a resumed conversation comes back as another one', async () => {
    const host = new FakeTurnHost(['working'], { conversation: 'conv-NEW' });
    const g = adapter(host, { threadId: 'conv-OLD', resumed: true, objective: 'x' });
    expect(g.codexThreadId).toBe('conv-OLD');
    // A resumed conversation waits, paused, for the node to take it up.
    expect(await g.getGoal()).toMatchObject({ objective: 'x', status: 'paused' });
    await g.setGoal({ status: 'active' });
    await until(() => g.goal?.status === 'blocked');
    expect(g.lastError?.message).toMatch(/conv-OLD came back as conv-NEW/);
  });

  it('starts a new objective only after the turn in flight ends', async () => {
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const host = new FakeTurnHost(['old work', 'GOAL COMPLETE'], { hold });
    const g = adapter(host);
    await g.setGoal({ objective: 'first' });
    await g.clearGoal();
    await g.setGoal({ objective: 'second' });
    expect(host.prompts).toHaveLength(1);
    release();
    await until(() => g.goal?.status === 'complete');
    expect(host.prompts).toHaveLength(2);
    expect(host.prompts[1]).toMatch(/^second\n/);
  });
});

describe('a goal node on a turn-driven engine', () => {
  it('checkpoints the conversation from the first turn, and repairs on it after a red verdict', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clawo-turn-goal-'));
    const starts: Array<Record<string, unknown>> = [];
    const hosts: FakeTurnHost[] = [];
    const sessions = new Map<string, TurnGoalSession>();
    const manager = {
      async startSession(config: Record<string, unknown>) {
        starts.push(config);
        // Second pass: the repair, on the same conversation. Only then is the work done.
        const repair = starts.length > 1;
        const host = new FakeTurnHost(
          [
            (prompt: string) => {
              if (repair && prompt.includes('did not pass the acceptance checks'))
                fs.writeFileSync(path.join(tmp, 'done.txt'), 'x');
              return 'GOAL COMPLETE';
            },
          ],
          { conversation: (config.resumeSessionId as string) ?? 'conv-A' },
        );
        hosts.push(host);
        const open = { threadId: config.resumeSessionId as string | undefined, resumed: !!config.resumeSessionId };
        sessions.set(String(config.name), new TurnGoalSession(host, () => host.conversation, open));
        return { name: config.name } as never;
      },
      async sendMessage() {
        throw new Error('the goal node never sends a chat turn');
      },
      async stopSession() {},
      goalSession(name: string) {
        return sessions.get(name) as never;
      },
    };
    const kernel = registerDefaultExecutors(new RunKernel({ manager: manager as never, nodeTimeoutMs: 20_000 }));
    const contract = {
      checks: [
        {
          id: 'done-file',
          type: 'command' as const,
          cmd: process.execPath,
          args: ['-e', "process.exit(require('fs').existsSync('done.txt') ? 0 : 1)"],
        },
      ],
    };
    const spec = goalWorkflow({
      task: 'create done.txt',
      cwd: tmp,
      contract: contract as never,
      maxRepairs: 1,
      engine: 'agy',
    });
    const done = await kernel.wait((await kernel.start(spec, { contract } as never)).runId);
    try {
      expect(done!.outcome).toBe('verified');
      expect(starts).toHaveLength(2);
      expect(starts[0]).toMatchObject({ engine: 'agy', skipPersistence: true });
      expect(starts[0].resumeSessionId).toBeUndefined();
      // The conversation id appeared with the first turn, was checkpointed, and the repair resumed it.
      expect(starts[1].resumeSessionId).toBe('conv-A');
      expect((done!.nodes.goal.data as GoalNodeData).threadId).toBe('conv-A');
      expect(hosts[1].prompts[0]).toContain('done-file');
      expect(hosts[1].prompts[0]).toContain('mark the goal complete');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
  it('runs a fan-out goal agent on the engine it names, and reports that engine', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clawo-turn-fanout-'));
    const starts: Array<Record<string, unknown>> = [];
    const sessions = new Map<string, TurnGoalSession>();
    const manager = {
      async startSession(config: Record<string, unknown>) {
        starts.push(config);
        const host = new FakeTurnHost(['GOAL COMPLETE'], { conversation: `conv-${starts.length}` });
        sessions.set(String(config.name), new TurnGoalSession(host, () => host.conversation));
        return { name: config.name } as never;
      },
      async sendMessage() {
        throw new Error('no chat turns here');
      },
      async stopSession() {},
      goalSession(name: string) {
        return sessions.get(name) as never;
      },
    };
    const kernel = registerDefaultExecutors(new RunKernel({ manager: manager as never, nodeTimeoutMs: 20_000 }));
    const run = await kernel.start({
      name: 'team',
      cwd: tmp,
      nodes: [
        {
          id: 'team',
          kind: 'fanout',
          prompt: 'unused',
          agents: [
            { name: 'a', engine: 'agy', model: 'gemini-4-neon-low', objective: 'part a' },
            { name: 'k', engine: 'acp', acpAgent: 'kimi-code', objective: 'part k' },
          ],
        } as never,
      ],
    });
    const done = await kernel.wait(run.runId);
    try {
      expect(done!.nodes.team.state).toBe('succeeded');
      const results = (done!.nodes.team.data as { results: Array<{ agent: string; engine: string; goal?: unknown }> })
        .results;
      expect(results.map((r) => [r.agent, r.engine])).toEqual([
        ['a', 'agy'],
        ['k', 'acp'],
      ]);
      expect(starts.find((c) => c.engine === 'acp')).toMatchObject({ acpAgent: 'kimi-code' });
      expect(starts.find((c) => c.engine === 'agy')).toMatchObject({ model: 'gemini-4-neon-low' });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
