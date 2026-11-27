/**
 * The posts an autoloop role's turn carries while that turn is in flight. They
 * reach the role once: the hub does not push them to it again mid-turn, even
 * when it routes one (a teammate's forum command) after the turn was built.
 * They are on record as handed over once the turn is sent; a send that fails
 * leaves them unrecorded, for the next turn to carry.
 */
import { describe, it, expect, vi, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SessionConfig } from '../types.js';
import type { SessionManager as SessionManagerType } from '../session-manager.js';

const ROOT = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'clawo-autoloop-in-flight-'));
process.env.CLAWO_WF_DIR = path.join(ROOT, 'wf');
process.env.CLAWO_FORUM_SPOOL_ROOT = path.join(ROOT, 'spool');
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const { AutoloopForumBridge } = await import('../autoloop/forum-bridge.js');
const { ClaudeAgentDispatcher } = await import('../autoloop/dispatcher.js');
const { Msg } = await import('../autoloop/messages.js');
const forum = await import('../kernel/forum.js');

const NAMES = { planner: 'planner', coder: 'coder', reviewer: 'reviewer' } as const;
const quiet = { warn: () => undefined };

let seq = 0;

/**
 * A Planner on a forum, with the real bridge and dispatcher and a stub session
 * manager. `during` runs inside each Planner send, while its turn is in flight;
 * `refuse` makes the next send throw.
 */
function setup() {
  const id = `fm-al-inflight-${process.pid}-${++seq}`;
  forum.createForum(id, {
    team: (['planner', 'coder', 'reviewer'] as const).map((name) => ({ name, node: 'main', mayReturn: true })),
  });
  const workspace = fs.mkdtempSync(path.join(ROOT, 'ws-'));
  const ctl = {
    during: undefined as (() => Promise<void>) | undefined,
    refuse: false,
    sent: [] as string[],
    pushed: [] as string[],
  };
  const manager = {
    startSession: vi.fn(async (config: Partial<SessionConfig>) => ({ name: config.name, state: 'ready' })),
    sendMessage: vi.fn(async (_name: string, text: string) => {
      await ctl.during?.();
      if (ctl.refuse) throw new Error('Budget exceeded: $5.00 spent of $5.00 (maxBudgetUsd)');
      ctl.sent.push(text);
      return { output: 'ok', error: undefined };
    }),
    stopSession: vi.fn(async () => undefined),
    hasSession: vi.fn(() => true),
    getStatus: vi.fn(() => ({ stats: { contextPercent: 10 } })),
    compactSession: vi.fn(async () => undefined),
  };
  const bridge = new AutoloopForumBridge(
    {
      id,
      config: {},
      exposed: true,
      names: { ...NAMES },
      post: async (input) => (await forum.forumRuntimePost(id, input)).post,
    },
    {
      ledgerDir: path.join(workspace, 'tasks', 'r1'),
      // An engine that takes input mid-turn.
      deliverMidTurn: async (_session, text) => {
        ctl.pushed.push(text);
        return true;
      },
      logger: quiet,
    },
  );
  const dispatcher = new ClaudeAgentDispatcher({
    manager: manager as unknown as SessionManagerType,
    runId: 'r1',
    workspace,
    forum: bridge,
    ownerRunId: 'run-x',
  });
  /** The hub's next tick: it reads the spool and routes what it has not routed yet. */
  const tick = () => forum.forumHub(id, {}).sync();
  return { id, bridge, dispatcher, ctl, tick };
}

const delivered = (id: string, who: string, postId: string, via: string) =>
  forum
    .forumSnapshot(id)
    .events.filter((e) => e.type === 'delivered' && e.who === who && e.id === postId && e.via === via);

/** The Coder's `clawo forum post`, out of process: on the spool, not yet routed by the hub. */
function coderAsk(id: string, marker: string) {
  return forum.forumPost(forum.forumSpoolDir(id), 'coder', {
    title: 'ASK @planner: which cache should the parser use?',
    body: `LRU or TTL? ${marker}`,
  });
}

describe('a post the turn in flight carries', () => {
  it('is not pushed to the role again when the hub routes it mid-turn', async () => {
    const { id, bridge, dispatcher, ctl, tick } = setup();
    await dispatcher.init({} as never);
    await dispatcher.deliver(Msg.chat(0, { text: 'first' }));
    await bridge.flush();

    const ask = coderAsk(id, 'CACHE-MARKER');
    ctl.during = tick;
    await dispatcher.deliver(Msg.chat(0, { text: 'second' }));
    ctl.during = undefined;
    await bridge.flush();

    const turn = ctl.sent[ctl.sent.length - 1];
    expect(turn.startsWith('second')).toBe(true);
    expect(turn.split('CACHE-MARKER')).toHaveLength(2);
    expect(ctl.pushed.filter((t) => t.includes('CACHE-MARKER'))).toEqual([]);
    expect(delivered(id, 'planner', ask.id, 'push')).toEqual([]);
    expect(delivered(id, 'planner', ask.id, 'turn')).toHaveLength(1);
    expect(bridge.handedOver(ask.id)).toBe(true);
    bridge.close();
  });

  it('stays unrecorded when the send fails, and the next turn carries it', async () => {
    const { id, bridge, dispatcher, ctl, tick } = setup();
    await dispatcher.init({} as never);
    await dispatcher.deliver(Msg.chat(0, { text: 'first' }));
    await bridge.flush();

    const ask = coderAsk(id, 'RETRY-MARKER');
    ctl.during = tick;
    ctl.refuse = true;
    await expect(dispatcher.deliver(Msg.chat(0, { text: 'second' }))).rejects.toThrow(/Budget exceeded/);
    ctl.during = undefined;
    ctl.refuse = false;
    expect(ctl.pushed.filter((t) => t.includes('RETRY-MARKER'))).toEqual([]);
    expect(delivered(id, 'planner', ask.id, 'turn')).toEqual([]);
    expect(bridge.handedOver(ask.id)).toBe(false);

    await dispatcher.deliver(Msg.chat(0, { text: 'third' }));
    const third = ctl.sent[ctl.sent.length - 1];
    expect(third.startsWith('third')).toBe(true);
    expect(third).toContain('RETRY-MARKER');
    expect(delivered(id, 'planner', ask.id, 'turn')).toHaveLength(1);
    expect(bridge.handedOver(ask.id)).toBe(true);
    bridge.close();
  });

  it('is pushed mid-turn when the turn did not carry it', async () => {
    const { id, bridge, dispatcher, ctl, tick } = setup();
    await dispatcher.init({} as never);
    await dispatcher.deliver(Msg.chat(0, { text: 'first' }));
    await bridge.flush();

    let ask: ReturnType<typeof coderAsk> | undefined;
    // Posted after the turn was built: only the hub can hand it over now.
    ctl.during = async () => {
      ask = coderAsk(id, 'LATE-MARKER');
      await tick();
    };
    await dispatcher.deliver(Msg.chat(0, { text: 'second' }));
    ctl.during = undefined;

    expect(ctl.sent[ctl.sent.length - 1]).not.toContain('LATE-MARKER');
    expect(ctl.pushed.filter((t) => t.includes('LATE-MARKER'))).toHaveLength(1);
    expect(delivered(id, 'planner', ask!.id, 'push')).toHaveLength(1);
    expect(bridge.handedOver(ask!.id)).toBe(true);
    bridge.close();
  });
});

describe('a user post the Planner’s brief does not carry in full', () => {
  it('is handed whole with the turn, and counts as handed only once that turn is sent', async () => {
    const { id, bridge, dispatcher, ctl } = setup();
    // The oldest of four steers: the Planner's short brief holds the last three,
    // so this one comes with the turn's posts, the way a steer the brief cuts does.
    const tail = 'TAIL-MARKER the end of the steer';
    const long = await forum.forumRuntimePost(id, {
      from: 'user',
      title: 'FIX: keep the public API unchanged',
      body: `${'keep the API stable; '.repeat(40)}${tail}`,
      data: { kind: 'steer' },
    });
    for (const n of [1, 2, 3]) {
      await forum.forumRuntimePost(id, { from: 'user', title: `FIX: steer ${n}`, body: `steer ${n}` });
    }
    await dispatcher.init({} as never);

    let handedMidTurn: boolean | undefined;
    ctl.during = async () => {
      handedMidTurn = bridge.handedOver(long.post.id);
    };
    ctl.refuse = true;
    await expect(dispatcher.deliver(Msg.chat(0, { text: 'first' }))).rejects.toThrow(/Budget exceeded/);
    ctl.refuse = false;
    expect(handedMidTurn).toBe(false);
    expect(bridge.handedOver(long.post.id)).toBe(false);

    await dispatcher.deliver(Msg.chat(0, { text: 'second' }));
    ctl.during = undefined;
    const turn = ctl.sent[ctl.sent.length - 1];
    expect(turn.startsWith('second')).toBe(true);
    expect(turn).toContain('You are "planner"');
    expect(turn).toContain(tail);
    expect(handedMidTurn).toBe(false);
    expect(bridge.handedOver(long.post.id)).toBe(true);
    expect(delivered(id, 'planner', long.post.id, 'turn')).toHaveLength(1);
    bridge.close();
  });
});
