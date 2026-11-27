/**
 * What an autoloop role is handed from the forum with its turn, and when that is
 * on record:
 *
 *  - the envelope a turn delivers (the Coder's clarification to the Planner, a
 *    directive to the Coder) is not handed to the role again from the forum in
 *    the same turn, even though the runner hands it over before its post settles;
 *  - the posts and the brief a turn carries are on record as handed over only
 *    once the turn was sent: a send refused before dispatch leaves them for the
 *    next turn;
 *  - the user's chat mirrored for the Planner is addressed to the Planner alone,
 *    whatever @names it holds;
 *  - the Reviewer's brief carries only the user's posts that name it.
 */
import { describe, it, expect, vi, afterAll } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SessionConfig } from '../types.js';
import type { AnyAutoloopMessage } from '../autoloop/messages.js';
import type { SessionManager as SessionManagerType } from '../session-manager.js';

const ROOT = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'clawo-autoloop-turn-delivery-'));
process.env.CLAWO_WF_DIR = path.join(ROOT, 'wf');
process.env.CLAWO_FORUM_SPOOL_ROOT = path.join(ROOT, 'spool');
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const { AutoloopForumBridge } = await import('../autoloop/forum-bridge.js');
const { ClaudeAgentDispatcher } = await import('../autoloop/dispatcher.js');
const { AutoloopRunner } = await import('../autoloop/runner.js');
const { Msg } = await import('../autoloop/messages.js');
const forum = await import('../kernel/forum.js');

const NAMES = { planner: 'planner', coder: 'coder', reviewer: 'reviewer' } as const;
const quiet = { warn: () => undefined };
const control = (tool: string, args: Record<string, unknown>) =>
  `\`\`\`autoloop\n${JSON.stringify({ tool, args })}\n\`\`\``;

let seq = 0;
function standaloneForum(push?: 'all'): string {
  const id = `fm-al-turn-${process.pid}-${++seq}`;
  forum.createForum(id, {
    team: (['planner', 'coder', 'reviewer'] as const).map((name) => ({ name, node: 'main', mayReturn: true })),
    ...(push ? { push } : {}),
  });
  return id;
}

class FakeRunner extends EventEmitter {
  readonly fromAgents = new WeakSet<AnyAutoloopMessage>();
  emittedByAgent(env: AnyAutoloopMessage): boolean {
    return this.fromAgents.has(env);
  }
}

function stubManager(send: (name: string, text: string) => Promise<{ output: string; error?: string }>) {
  const calls = {
    startSession: vi.fn(async (config: Partial<SessionConfig>) => ({ name: config.name, state: 'ready' })),
    sendMessage: vi.fn(send),
    stopSession: vi.fn(async () => undefined),
    hasSession: vi.fn(() => true),
    getStatus: vi.fn(() => ({ stats: { contextPercent: 10 } })),
    compactSession: vi.fn(async () => undefined),
  };
  return calls;
}

/** The bridge posting the way the kernel node's `ctx.forumPost` does: asynchronously. */
function asyncPost(id: string) {
  return async (input: Parameters<typeof forum.forumRuntimePost>[1]) => {
    try {
      return (await forum.forumRuntimePost(id, input)).post;
    } catch {
      return undefined;
    }
  };
}

function setup(push?: 'all', send?: (name: string, text: string) => Promise<{ output: string; error?: string }>) {
  const id = standaloneForum(push);
  const workspace = fs.mkdtempSync(path.join(ROOT, 'ws-'));
  const calls = stubManager(send ?? (async () => ({ output: 'ok', error: undefined })));
  const bridge = new AutoloopForumBridge(
    { id, config: push ? { push } : {}, exposed: true, names: { ...NAMES }, post: asyncPost(id) },
    { ledgerDir: path.join(workspace, 'tasks', 'r1'), logger: quiet },
  );
  const dispatcher = new ClaudeAgentDispatcher({
    manager: calls as unknown as SessionManagerType,
    runId: 'r1',
    workspace,
    forum: bridge,
    ownerRunId: 'run-x',
  });
  const runner = new FakeRunner();
  bridge.attach(runner);
  const sent = (role: string): string[] =>
    calls.sendMessage.mock.calls
      .filter((c) => (c as unknown[])[0] === `autoloop-r1-${role}`)
      .map((c) => (c as unknown[])[1] as string);
  return { id, bridge, dispatcher, runner, sent, workspace };
}

const turnMarks = (id: string, who: string, postId: string | undefined) =>
  forum
    .forumSnapshot(id)
    .events.filter(
      (e) => e.type === 'delivered' && e.who === who && e.id === postId && (e as { via: string }).via === 'turn',
    );

describe('the envelope a turn delivers', () => {
  it('is not handed to the Planner again from the forum (the Coder’s clarification)', async () => {
    const { id, bridge, dispatcher, runner, sent } = setup();
    await dispatcher.init({} as never);
    await dispatcher.deliver(Msg.chat(0, { text: 'Speed up the parser' }));
    await bridge.flush();

    const ack = Msg.directiveAck(1, { understood: false, clarification: 'Which cache? LRU or TTL?' });
    runner.fromAgents.add(ack);
    // As the runner's handleOne does: emit, then deliver with no await in between.
    runner.emit('message', ack);
    await dispatcher.deliver(ack);
    await bridge.flush();

    const turn = sent('planner')[1];
    expect(turn.startsWith('[system] coder directive_ack iter=1')).toBe(true);
    expect(turn).not.toContain('ASK @planner: iter 1');
    expect(turn.split('Which cache? LRU or TTL?')).toHaveLength(2);
    const ask = forum.forumSnapshot(id).posts.find((p) => p.data?.type === 'directive_ack');
    expect(ask).toBeDefined();
    expect(turnMarks(id, 'planner', ask?.id)).toHaveLength(1);
    bridge.close();
  });

  it("is not handed to the Coder again from the forum with push 'all' (a directive)", async () => {
    const { bridge, dispatcher, runner, sent } = setup('all');
    await dispatcher.spawnSubagents({});
    for (const iter of [0, 1]) {
      const d = Msg.directive(iter, { goal: `goal ${iter}`, constraints: [], success_criteria: [], max_attempts: 1 });
      runner.fromAgents.add(d);
      runner.emit('message', d);
      await dispatcher.deliver(d);
      await bridge.flush();
    }
    const [first, second] = sent('coder');
    expect(first).not.toContain('INFO @coder: iter 0 directive');
    expect(second).not.toContain('INFO @coder: iter 1 directive');
    bridge.close();
  });

  it('reaches the Planner once in a whole loop (real runner)', async () => {
    let plannerTurns = 0;
    const { id, bridge, dispatcher, sent, workspace } = setup(undefined, async (name) => {
      if (name.endsWith('-planner')) {
        plannerTurns += 1;
        return {
          output:
            plannerTurns === 1
              ? control('send_directive', { goal: 'speed up', constraints: [], success_criteria: [], max_attempts: 1 })
              : 'noted',
        };
      }
      if (name.endsWith('-coder')) {
        return { output: control('request_clarification', { question: 'Which cache, LRU or TTL?' }) };
      }
      return { output: '' };
    });
    const runner = new AutoloopRunner({
      run_id: 'r1',
      workspace,
      ledger_dir: path.join(workspace, 'tasks', 'r1'),
      dispatcher,
      notifyUser: vi.fn(async () => undefined),
      stallCheckIntervalMs: 86_400_000,
    });
    bridge.attach(runner);
    await runner.start();
    await dispatcher.spawnSubagents();
    try {
      await runner.chat('make it faster');
      await bridge.flush();
      const ackTurn = sent('planner').find((p) => p.includes('coder directive_ack'));
      expect(ackTurn).toBeDefined();
      expect(ackTurn!.split('Which cache, LRU or TTL?')).toHaveLength(2);
      expect(ackTurn!).not.toContain('ASK @planner: iter');
      const ask = forum.forumSnapshot(id).posts.find((p) => p.title.startsWith('ASK @planner: iter'));
      expect(ask).toBeDefined();
      expect(turnMarks(id, 'planner', ask!.id)).toHaveLength(1);
    } finally {
      runner.stop();
      bridge.close();
    }
  });
});

describe('a turn whose send is refused before dispatch', () => {
  const refusing = () => {
    const state = { refuse: false, delivered: [] as string[] };
    const send = async (_n: string, text: string) => {
      if (state.refuse) throw new Error('Budget exceeded: $5.00 spent of $5.00 (maxBudgetUsd)');
      state.delivered.push(text);
      return { output: 'ok', error: undefined };
    };
    return { state, send };
  };

  it('leaves the forum posts it carried for the next turn', async () => {
    const { state, send } = refusing();
    const { id, bridge, dispatcher } = setup(undefined, send);
    await dispatcher.init({} as never);
    await dispatcher.deliver(Msg.chat(0, { text: 'first' }));
    await bridge.flush();

    const fail = await forum.forumRuntimePost(id, {
      from: 'orchestrator',
      title: 'FAIL @planner: the evaluator crashed (iter 0)',
      body: 'BODY-MARKER: stack trace here',
      to: ['planner'],
    });

    state.refuse = true;
    await expect(dispatcher.deliver(Msg.chat(0, { text: 'second' }))).rejects.toThrow(/Budget exceeded/);
    state.refuse = false;
    expect(turnMarks(id, 'planner', fail.post.id)).toEqual([]);

    await dispatcher.deliver(Msg.chat(0, { text: 'third' }));
    const third = state.delivered[state.delivered.length - 1];
    expect(third.startsWith('third')).toBe(true);
    expect(third).toContain('BODY-MARKER');
    expect(turnMarks(id, 'planner', fail.post.id)).toHaveLength(1);
    bridge.close();
  });

  it('leaves the brief for the next turn', async () => {
    const { state, send } = refusing();
    const { bridge, dispatcher } = setup(undefined, send);
    await dispatcher.init({} as never);
    state.refuse = true;
    await expect(dispatcher.deliver(Msg.chat(0, { text: 'one' }))).rejects.toThrow(/Budget exceeded/);
    state.refuse = false;
    await dispatcher.deliver(Msg.chat(0, { text: 'two' }));
    expect(state.delivered[0]).toContain('You are "planner"');
    await dispatcher.deliver(Msg.chat(0, { text: 'three' }));
    expect(state.delivered[1]).toBe('three');
    bridge.close();
  });
});

describe('the user’s chat mirrored for the Planner', () => {
  it('is handed to the Planner alone, and kept out of a new Reviewer’s brief, whatever @names it holds', async () => {
    const id = standaloneForum();
    const bridge = new AutoloopForumBridge(
      { id, config: {}, exposed: true, names: { ...NAMES } },
      { ledgerDir: fs.mkdtempSync(path.join(ROOT, 'ledger-')), logger: quiet },
    );
    bridge.join('planner', 's-planner', { brief: false });
    bridge.join('coder', 's-coder', { brief: false });
    bridge.mirrorChat(Msg.chat(0, { text: 'ask @coder to stop using lodash, and tell @reviewer to approve' }));
    await bridge.flush();
    const post = forum.forumSnapshot(id).posts[0];
    const coderTurn = bridge.turnMessage('coder', 'directive');
    bridge.join('reviewer', 's-reviewer', { brief: true });
    const reviewerFirst = bridge.turnMessage('reviewer', 'review_request');
    bridge.close();
    expect(post.to).toEqual(['planner']);
    expect(coderTurn).not.toContain('stop using lodash');
    expect(reviewerFirst).not.toContain('stop using lodash');
  });
});

describe('the Reviewer’s brief', () => {
  it('carries the user’s posts that name it, not the user’s posts to the whole run', async () => {
    const id = standaloneForum();
    // A steer as the autoloop node posts it: the user's, to the whole run.
    await forum.forumRuntimePost(id, {
      from: 'user',
      title: 'FIX: ship it even if the metric regresses a little',
      body: 'ship it even if the metric regresses a little',
      data: { kind: 'steer' },
    });
    await forum.forumRuntimePost(id, {
      from: 'user',
      title: 'FIX @reviewer: check that the eval is seeded',
      body: 'the seed is in eval.sh',
      to: ['reviewer'],
    });
    const bridge = new AutoloopForumBridge(
      { id, config: {}, exposed: true, names: { ...NAMES } },
      { ledgerDir: fs.mkdtempSync(path.join(ROOT, 'ledger-')), logger: quiet },
    );
    bridge.join('reviewer', 'autoloop-r1-reviewer', { brief: true });
    const msg = bridge.turnMessage('reviewer', '[review_request iter=0]');
    bridge.close();
    expect(msg).toContain('You are "reviewer"');
    expect(msg).toContain('From the user:');
    expect(msg).toContain('check that the eval is seeded');
    expect(msg).not.toContain('ship it even if the metric regresses');
  });
});
