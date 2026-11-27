/**
 * The session forum: messages between plain sessions as posts on a forum with no run, answers that
 * go back to their sender, and sessions a run's mode started kept out of plain-session messaging.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  CostBreakdown,
  EffortLevel,
  ISession,
  SessionConfig,
  SessionSendOptions,
  SessionStats,
  TurnResult,
} from '../types.js';

const SPOOL_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'clawo-session-forum-spool-'));
process.env.CLAWO_FORUM_SPOOL_ROOT = SPOOL_ROOT;
const { SessionManager } = await import('../session-manager.js');
const { forumSnapshot, forumSpoolDir, forumStoreDir } = await import('../kernel/forum.js');
type SessionManager = InstanceType<typeof SessionManager>;

/** An engine whose busy state, mid-turn input and replies the test sets. */
class ScriptedSession extends EventEmitter implements ISession {
  sessionId?: string;
  busy = false;
  ready = true;
  /** Turns started on it (sends), in order. */
  turns: string[] = [];
  /** Text handed to the turn in flight. */
  midTurn: string[] = [];
  /** Set to give the engine a way in mid-turn. */
  takesMidTurn = false;
  /** The reply to a turn; default `ok`. */
  reply: (message: string) => string = () => 'ok';
  deliverMidTurn?: (text: string) => Promise<boolean>;

  constructor() {
    super();
    this.deliverMidTurn = async (text: string) => {
      if (!this.takesMidTurn || !this.busy) return false;
      this.midTurn.push(text);
      return true;
    };
  }

  get isReady() {
    return this.ready;
  }
  get isPaused() {
    return false;
  }
  get isBusy() {
    return this.busy;
  }
  async start(): Promise<this> {
    this.sessionId = `s-${Math.random().toString(36).slice(2, 8)}`;
    return this;
  }
  stop(): void {}
  pause(): void {}
  resume(): void {}
  async send(
    message: string | unknown[],
    options?: SessionSendOptions,
  ): Promise<TurnResult | { requestId: number; sent: boolean }> {
    const text = String(message);
    this.turns.push(text);
    if (options?.waitForComplete === false) return { requestId: 1, sent: true };
    return { text: this.reply(text), event: { type: 'result', result: 'done' } };
  }
  getStats(): SessionStats & { sessionId?: string; uptime: number } {
    return {
      turns: this.turns.length,
      turnsSucceeded: this.turns.length,
      toolCalls: 0,
      toolErrors: 0,
      tokensIn: 0,
      tokensOut: 0,
      cachedTokens: 0,
      costUsd: 0,
      isReady: true,
      startTime: new Date().toISOString(),
      lastActivity: new Date().toISOString(),
      contextPercent: 1,
      retries: 0,
      sessionId: this.sessionId,
      uptime: 1,
    };
  }
  getHistory(): Array<{ time: string; type: string; event: unknown }> {
    return [];
  }
  getCost(): CostBreakdown {
    return {
      model: 'mock',
      tokensIn: 0,
      tokensOut: 0,
      cachedTokens: 0,
      pricing: { inputPer1M: 0, outputPer1M: 0, cachedPer1M: 0 },
      breakdown: { inputCost: 0, cachedCost: 0, outputCost: 0 },
      totalUsd: 0,
    };
  }
  async compact(): Promise<void> {}
  getEffort(): EffortLevel {
    return 'auto';
  }
  setEffort(): void {}
  resolveModel(alias: string): string {
    return alias;
  }
}

let mgr: SessionManager;
let engines: Map<string, ScriptedSession>;
let configs: Map<string, SessionConfig>;

beforeEach(() => {
  engines = new Map();
  configs = new Map();
  mgr = new SessionManager({ claudeBin: 'mock-claude', maxConcurrentSessions: 8 });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (mgr as any)._createSession = (_engine: string, config: SessionConfig): ISession => {
    const s = new ScriptedSession();
    engines.set(config.name, s);
    configs.set(config.name, config);
    return s;
  };
});

afterEach(async () => {
  await mgr.shutdown();
});

afterAll(() => {
  fs.rmSync(SPOOL_ROOT, { recursive: true, force: true });
});

const forumIdOf = (m: SessionManager): string => (m as unknown as { _inbox: { forumId: string } })._inbox.forumId;
const engine = (name: string): ScriptedSession => engines.get(name)!;
const start = (name: string, extra: Partial<SessionConfig> = {}) =>
  mgr.startSession({ name, cwd: os.tmpdir(), engine: 'codex', ...extra });
const settle = () => new Promise((r) => setTimeout(r, 20));

describe('messages on the session forum', () => {
  it('posts a message for its recipient only and records how it was handed over', async () => {
    await start('a');
    await start('b');
    await start('c');
    engine('c').busy = true;

    expect(await mgr.sessionSendTo('a', 'b', 'please review the diff', 'review')).toEqual({
      delivered: true,
      queued: false,
    });
    expect(await mgr.sessionSendTo('a', 'c', 'later')).toEqual({ delivered: false, queued: true });

    const { posts, events } = forumSnapshot(forumIdOf(mgr));
    const [toB, toC] = posts;
    expect(toB).toMatchObject({
      from: 'a',
      title: 'MSG @b: review',
      body: 'please review the diff',
      direct: ['b'],
      visibility: 'to',
      data: { kind: 'message', summary: 'review' },
    });
    expect(toC).toMatchObject({ title: 'MSG @c: later', direct: ['c'] });
    // b was woken with a turn; c's copy waits.
    expect(events).toContainEqual(expect.objectContaining({ type: 'delivered', who: 'b', id: toB.id, via: 'turn' }));
    expect(events.some((e) => e.type === 'delivered' && e.who === 'c')).toBe(false);
    // The envelope agents match, and the line that says how to answer, with the message's id.
    const handed = engine('b').turns[0];
    expect(handed).toContain('<cross-session-message from="a" summary="review">');
    expect(handed).toContain(`re="${toB.id}"`);
    // Nobody else sees a message that was not for them.
    expect(mgr.sessionInbox('c', false).map((m) => m.text)).toEqual(['later']);
    expect(mgr.sessionInbox('a', false)).toEqual([]);
  });

  it('hands a message to a busy session mid-turn, recorded as a push', async () => {
    await start('a');
    await start('b');
    engine('b').busy = true;
    engine('b').takesMidTurn = true;

    expect(await mgr.sessionSendTo('a', 'b', 'heads up')).toEqual({ delivered: true, queued: false });
    expect(engine('b').midTurn).toHaveLength(1);
    expect(engine('b').turns).toHaveLength(0);
    const { posts, events } = forumSnapshot(forumIdOf(mgr));
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'delivered', who: 'b', id: posts[0].id, via: 'push' }),
    );
  });

  it('reads the inbox without writing to the forum', async () => {
    await start('a');
    await start('b');
    engine('b').busy = true;
    await mgr.sessionSendTo('a', 'b', 'one');
    const spool = forumSpoolDir(forumIdOf(mgr));
    const before = fs.readdirSync(spool).map((f) => [f, fs.statSync(path.join(spool, f)).size]);

    expect(mgr.sessionInbox('b')).toEqual([{ from: 'a', text: 'one', timestamp: expect.any(String), read: false }]);
    mgr.sessionInbox('b', false);
    mgr.sessionInbox('nobody');
    expect(fs.readdirSync(spool).map((f) => [f, fs.statSync(path.join(spool, f)).size])).toEqual(before);
  });

  it('keeps the text of a message whose end the forum would trim', async () => {
    await start('a');
    await start('b');
    engine('b').busy = true;
    await mgr.sessionSendTo('a', 'b', 'indented\n  code  \n');
    expect(mgr.sessionInbox('b')[0].text).toBe('indented\n  code  \n');
  });

  it('flushes unread mail in one turn and counts it read once the turn has started', async () => {
    await start('a');
    await start('b');
    engine('b').busy = true;
    await mgr.sessionSendTo('a', 'b', 'first');
    await mgr.sessionSendTo('a', 'b', 'second');
    engine('b').busy = false;

    expect(await mgr.sessionDeliverInbox('b')).toBe(2);
    expect(engine('b').turns).toHaveLength(1);
    expect(engine('b').turns[0].match(/<cross-session-message /g)).toHaveLength(2);
    const { posts, events } = forumSnapshot(forumIdOf(mgr));
    for (const p of posts.slice(0, 2)) {
      expect(events).toContainEqual(expect.objectContaining({ type: 'delivered', who: 'b', id: p.id, via: 'turn' }));
    }
    expect(await mgr.sessionDeliverInbox('b')).toBe(0);
  });

  it('refuses a message to the sender itself', async () => {
    await start('a');
    await expect(mgr.sessionSendTo('a', 'a', 'me')).rejects.toThrow(/cannot send a message to itself/);
  });

  it('makes no forum until a message is sent, and retires its spool at shutdown', async () => {
    await start('a');
    await start('b');
    const id = forumIdOf(mgr);
    expect(fs.existsSync(forumStoreDir(id))).toBe(false);
    await mgr.sessionSendTo('a', 'b', 'hi');
    expect(fs.existsSync(forumSpoolDir(id))).toBe(true);
    await mgr.shutdown();
    await settle();
    expect(fs.existsSync(forumSpoolDir(id))).toBe(false);
    expect(fs.readFileSync(path.join(forumStoreDir(id), 'posts.jsonl'), 'utf8')).toContain('"MSG @b: hi"');
  });
});

describe('answers', () => {
  const answer = (title: string, re?: string, body = 'details') =>
    `sure. <new-forum-post title="${title}"${re ? ` re="${re}"` : ''}>${body}</new-forum-post>`;

  it('goes back to the sender, mid-turn when it is busy', async () => {
    await start('lead');
    await start('worker');
    engine('lead').busy = true;
    engine('lead').takesMidTurn = true;
    engine('worker').reply = (msg) => answer('DONE: fixed', /re="(p\d+)"/.exec(msg)?.[1]);

    await mgr.sessionSendTo('lead', 'worker', 'fix the flaky test');
    await settle();
    expect(engine('lead').midTurn).toHaveLength(1);
    expect(engine('lead').midTurn[0]).toContain('<cross-session-message from="worker" summary="DONE: fixed">');
    expect(engine('lead').midTurn[0]).toContain('details');
    const reply = forumSnapshot(forumIdOf(mgr)).posts[1];
    expect(reply).toMatchObject({
      from: 'worker',
      title: 'DONE: fixed',
      direct: ['lead'],
      visibility: 'to',
      via: 'runtime',
      data: { kind: 'reply' },
    });
  });

  it('does not start a turn on an idle sender: it waits as unread mail', async () => {
    await start('lead');
    await start('worker');
    // An answer without `re` goes to whoever sent what the turn was started with.
    engine('worker').reply = () => answer('DONE: fixed');

    await mgr.sessionSendTo('lead', 'worker', 'fix the flaky test');
    await settle();
    expect(engine('lead').turns).toHaveLength(0);
    expect(mgr.sessionInbox('lead')).toEqual([
      { from: 'worker', text: 'details', summary: 'DONE: fixed', timestamp: expect.any(String), read: false },
    ]);
  });

  it('answers nobody from a turn the caller started, or for a message that was not sent to it', async () => {
    await start('a');
    await start('b');
    await start('c');
    engine('c').busy = true;
    await mgr.sessionSendTo('a', 'c', 'for c only');
    const forC = forumSnapshot(forumIdOf(mgr)).posts[0].id;

    engine('b').reply = () => `${answer('INFO: unprompted')} ${answer('INFO: not mine', forC)}`;
    await mgr.sendMessage('b', 'carry on');
    await settle();
    expect(forumSnapshot(forumIdOf(mgr)).posts).toHaveLength(1);
    expect(mgr.sessionInbox('a')).toEqual([]);
  });
});

describe('sessions a run started', () => {
  it('are left out of a broadcast and the team, and refused as sender or target', async () => {
    await start('a');
    await start('b');
    await start('seat', { ownerRunId: 'cn-123' });

    expect(await mgr.sessionSendTo('a', '*', 'all hands')).toEqual({ delivered: true, queued: false });
    expect(engine('b').turns).toHaveLength(1);
    expect(engine('seat').turns).toHaveLength(0);

    const team = await mgr.teamList('a');
    expect(team).toContain('- b (');
    expect(team).not.toContain('seat');

    await expect(mgr.sessionSendTo('a', 'seat', 'psst')).rejects.toThrow(
      "Session 'seat' belongs to run cn-123: use workflow_forum post on run cn-123 instead",
    );
    await expect(mgr.teamSend('a', 'seat', 'psst')).rejects.toThrow(/use workflow_forum post on run cn-123/);
    await expect(mgr.sessionSendTo('seat', 'a', 'psst')).rejects.toThrow(/belongs to run cn-123/);
    expect(mgr.sessionInbox('seat')).toEqual([]);
    expect(await mgr.sessionDeliverInbox('seat')).toBe(0);
  });

  it('are not on the session forum', async () => {
    await start('a');
    await start('b');
    await start('seat', { ownerRunId: 'cn-123' });
    await mgr.sessionSendTo('a', 'b', 'hi');
    const joined = forumSnapshot(forumIdOf(mgr))
      .events.filter((e) => e.type === 'join')
      .map((e) => e.who);
    expect(joined.sort()).toEqual(['a', 'b']);
  });

  it('refuse Claude Code peer messages unless the mode set a policy', async () => {
    await mgr.startSession({ name: 'owned', cwd: os.tmpdir(), engine: 'claude', ownerRunId: 'r1' });
    await mgr.startSession({
      name: 'owned-accept',
      cwd: os.tmpdir(),
      engine: 'claude',
      ownerRunId: 'r1',
      crossSessionInbound: 'accept',
    });
    await mgr.startSession({ name: 'plain', cwd: os.tmpdir(), engine: 'claude' });
    expect(configs.get('owned')?.crossSessionInbound).toBe('refuse');
    expect(configs.get('owned-accept')?.crossSessionInbound).toBe('accept');
    expect(configs.get('plain')?.crossSessionInbound).toBeUndefined();
  });
});

describe('a sender under a reserved name', () => {
  it('reaches only the session it names, not one its text mentions', async () => {
    await start('user');
    await start('b');
    await start('c');
    expect(await mgr.sessionSendTo('user', 'b', 'ask @c about the schema')).toEqual({
      delivered: true,
      queued: false,
    });
    expect(engine('b').turns).toHaveLength(1);
    expect(engine('c').turns).toHaveLength(0);
    expect(mgr.sessionInbox('c', false)).toEqual([]);
  });
});

describe('handoff', () => {
  it('records the handoff on the session forum, and the target receives messages under its name', async () => {
    await start('a');
    await mgr.sendMessage('a', 'remember the codename heron');
    await start('peer');
    const out = await mgr.handoffSession('a', { engine: 'opencode' });

    const note = forumSnapshot(forumIdOf(mgr)).posts.find((p) => p.data?.kind === 'handoff');
    expect(note).toMatchObject({
      from: 'orchestrator',
      title: `INFO: a handed off to ${out.name} (opencode)`,
      data: { kind: 'handoff', from: 'a', to: out.name, engine: 'opencode' },
    });
    // Recorded, not pushed: neither side was handed it.
    expect(engine('a').turns).toHaveLength(1);
    expect(engine('peer').turns).toHaveLength(0);

    expect(await mgr.sessionSendTo('peer', out.name, 'welcome')).toEqual({ delivered: true, queued: false });
  });
});
