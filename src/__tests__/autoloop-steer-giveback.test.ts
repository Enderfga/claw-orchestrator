/**
 * The steers an autoloop node takes, and the ones it gives back when the loop
 * ends. What counts as handed to a role is what this process handed it: a turn
 * it sent (the brief, the posts after the message) or a post it pushed mid-turn.
 * A delivery record an agent can write (`clawo forum --as <role> list`) does not
 * count. What goes back is the tail of what was taken, from the first steer no
 * role had, so the kernel's count-over-log-order accounting stays exact.
 */
import { describe, it, expect, vi, afterAll } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SessionConfig } from '../types.js';
import type { SessionManager as SessionManagerType } from '../session-manager.js';

const ROOT = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'clawo-autoloop-steer-giveback-'));
process.env.CLAWO_WF_DIR = path.join(ROOT, 'wf');
process.env.CLAWO_FORUM_SPOOL_ROOT = path.join(ROOT, 'spool');
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const { RunKernel } = await import('../kernel/engine.js');
const { makeAutoloopExecutor } = await import('../kernel/nodes/autoloop.js');
const { AutoloopForumBridge } = await import('../autoloop/forum-bridge.js');
const { ClaudeAgentDispatcher } = await import('../autoloop/dispatcher.js');
const { Msg } = await import('../autoloop/messages.js');
const forum = await import('../kernel/forum.js');
const { readEvents } = await import('../kernel/store.js');

type Bridge = InstanceType<typeof AutoloopForumBridge>;
type Dispatcher = InstanceType<typeof ClaudeAgentDispatcher>;

/** An autoloop node in a kernel run on a forum, with the real bridge and dispatcher and a stub session manager. */
async function loopOnForum() {
  const sent: string[] = [];
  const manager = {
    startSession: vi.fn(async (config: Partial<SessionConfig>) => ({ name: config.name, state: 'ready' })),
    sendMessage: vi.fn(async (_name: string, text: string) => {
      sent.push(text);
      return { output: 'ok', error: undefined };
    }),
    stopSession: vi.fn(async () => undefined),
    hasSession: vi.fn(() => true),
    getStatus: vi.fn(() => ({ stats: { contextPercent: 10 } })),
    compactSession: vi.fn(async () => undefined),
  };
  /** What a role's engine does with a post handed to it mid-turn; none takes one by default. */
  const midTurn: { deliver: (session: string, text: string) => Promise<boolean> } = { deliver: async () => false };
  let bridge: Bridge | undefined;
  let dispatcher: Dispatcher | undefined;
  let exit!: () => void;
  const exited = new Promise<void>((r) => (exit = r));
  const runner = Object.assign(new EventEmitter(), {
    state: { status: 'running', iter: 0 } as Record<string, unknown>,
    stop() {},
  });
  const deps = {
    async boot(
      _config: unknown,
      _secrets: unknown,
      opts: { forum?: ConstructorParameters<typeof AutoloopForumBridge>[0]; ownerRunId?: string },
    ) {
      const workspace = fs.mkdtempSync(path.join(ROOT, 'ws-'));
      const ledgerDir = path.join(workspace, 'tasks', 'r1');
      bridge = new AutoloopForumBridge(opts.forum!, {
        ledgerDir,
        deliverMidTurn: (session, text) => midTurn.deliver(session, text),
        logger: { warn: () => undefined },
      });
      dispatcher = new ClaudeAgentDispatcher({
        manager: manager as unknown as SessionManagerType,
        runId: 'r1',
        workspace,
        forum: bridge,
        ownerRunId: opts.ownerRunId,
      });
      return {
        runner,
        dispatcher: { sessionNames: { planner: 'autoloop-r1-planner' }, shutdown: async () => undefined },
        ledgerDir,
        forum: bridge,
      };
    },
    ready() {},
    async waitForExit() {
      await exited;
    },
    registerPublisher() {},
    unregisterPublisher() {},
    extra: () => ({}),
  };
  const kernel = new RunKernel({ manager: {} as never, nodeTimeoutMs: 20_000 });
  kernel.setExecutor('autoloop', makeAutoloopExecutor(deps as never));
  const run = await kernel.start({
    name: 'al',
    forum: true,
    nodes: [{ id: 'main', kind: 'autoloop', config: {} } as never],
  } as never);
  await vi.waitFor(() => expect(dispatcher).toBeDefined(), { timeout: 2_000, interval: 10 });
  await dispatcher!.init({} as never);
  return {
    runId: run.runId,
    kernel,
    bridge: bridge!,
    dispatcher: dispatcher!,
    sent,
    midTurn,
    /** The node takes the steers waiting (it does on each runner state event). */
    take: () => runner.emit('state'),
    end: async () => {
      runner.state.status = 'terminated';
      exit();
      await kernel.wait(run.runId);
    },
    consumed: () =>
      readEvents(run.runId)
        .filter((e) => e.type === 'steer_consumed')
        .reduce((n, e) => n + (e as { count: number }).count, 0),
    replay: () =>
      (kernel as unknown as { _unconsumedSteers(id: string): Array<{ text: string }> })
        ._unconsumedSteers(run.runId)
        .map((s) => s.text),
  };
}

const steerPost = (runId: string, text: string) =>
  forum.forumSnapshot(runId).posts.find((p) => p.data?.kind === 'steer' && p.body === text);

describe('an autoloop node gives back the steers', () => {
  it('that only a delivery record an agent wrote says a role had', async () => {
    const loop = await loopOnForum();
    await loop.dispatcher.deliver(Msg.chat(0, { text: 'first' }));
    expect(loop.kernel.steer(loop.runId, 'use the other library')).toBe(true);
    loop.take();
    const post = steerPost(loop.runId, 'use the other library');
    expect(post).toBeDefined();
    // The Coder runs its forum command under the Planner's name: the CLI records
    // the steer as delivered to the Planner.
    expect(forum.forumInbox(forum.forumSpoolDir(loop.runId), 'planner')).toContain('use the other library');
    expect(
      forum
        .forumSnapshot(loop.runId)
        .events.some((e) => e.type === 'delivered' && e.who === 'planner' && e.id === post!.id),
    ).toBe(true);
    await loop.end();
    expect(loop.consumed()).toBe(0);
    expect(loop.replay()).toEqual(['use the other library']);
  });

  it('from the first one no role had, so a restart replays the right ones', async () => {
    const loop = await loopOnForum();
    await loop.dispatcher.deliver(Msg.chat(0, { text: 'first' }));
    expect(loop.kernel.steer(loop.runId, 'S1 use the cache')).toBe(true);
    for (let i = 0; i < 19; i++) {
      await forum.forumRuntimePost(loop.runId, {
        from: 'orchestrator',
        title: `FAIL @planner: phase error ${i}`,
        to: ['planner'],
      });
    }
    expect(loop.kernel.steer(loop.runId, 'S2 keep the API')).toBe(true);
    loop.take();
    // The Planner's next turn hands the newest 20 posts: S2's, not S1's.
    await loop.dispatcher.deliver(Msg.chat(0, { text: 'second' }));
    const turn = loop.sent[loop.sent.length - 1];
    expect(turn).toContain('earlier ones come with a later turn');
    expect(turn).toContain('S2 keep the API');
    expect(turn).not.toContain('S1 use the cache');
    await loop.end();
    expect(loop.consumed()).toBe(0);
    expect(loop.replay()).toEqual(['S1 use the cache', 'S2 keep the API']);
  });
});

describe('an autoloop node keeps the steers', () => {
  it('a role was handed with a turn it was sent', async () => {
    const loop = await loopOnForum();
    await loop.dispatcher.deliver(Msg.chat(0, { text: 'first' }));
    loop.kernel.steer(loop.runId, 'keep the public API stable');
    loop.take();
    await loop.dispatcher.deliver(Msg.chat(0, { text: 'second' }));
    expect(loop.sent[loop.sent.length - 1]).toContain('keep the public API stable');
    await loop.end();
    expect(loop.consumed()).toBe(1);
    expect(loop.replay()).toEqual([]);
  });

  it('a role was handed in the brief of its first turn', async () => {
    const loop = await loopOnForum();
    loop.kernel.steer(loop.runId, 'log every round');
    loop.take();
    await loop.dispatcher.deliver(Msg.chat(0, { text: 'first' }));
    const first = loop.sent[0];
    expect(first).toContain('You are "planner"');
    expect(first).toContain('log every round');
    await loop.end();
    expect(loop.consumed()).toBe(1);
    expect(loop.replay()).toEqual([]);
  });

  it('a role was handed mid-turn', async () => {
    const loop = await loopOnForum();
    await loop.dispatcher.deliver(Msg.chat(0, { text: 'first' }));
    // A post reaches the Planner mid-turn only while its turn is in flight, on an engine that takes it.
    const handedMidTurn: string[] = [];
    loop.midTurn.deliver = async (_session, text) => {
      handedMidTurn.push(text);
      return true;
    };
    const endTurn = loop.bridge.beginTurn('planner');
    loop.kernel.steer(loop.runId, 'stop after this round');
    await vi.waitFor(() => expect(handedMidTurn.join('\n')).toContain('stop after this round'), {
      timeout: 2_000,
      interval: 10,
    });
    endTurn();
    loop.take();
    await loop.end();
    expect(loop.consumed()).toBe(1);
  });
});
