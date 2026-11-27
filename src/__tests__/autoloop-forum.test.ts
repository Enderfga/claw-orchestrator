/**
 * An autoloop on its run forum: the envelope mirror, the roles as members, what
 * a turn carries, reply blocks, steers, and the forum's events on the stream.
 *
 * What these pin: each envelope is posted once (a parked message is emitted
 * twice), from the role that sent it or from the orchestrator; the user's chat
 * is the user's post, handed to the Planner as its turn and not again; a role is
 * briefed once per new conversation, after its message, never in the system
 * prompt; the Planner and the Coder get the posts for them with their turns,
 * the Reviewer gets none; a post reaches a role mid-turn only during its own
 * turn; and with `forum: false` the roles are not told while the loop is still
 * recorded.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type {
  CostBreakdown,
  EffortLevel,
  ISession,
  SessionConfig,
  SessionSendOptions,
  SessionStats,
  TurnResult,
} from '../types.js';
import type { AnyAutoloopMessage } from '../autoloop/messages.js';
import type { SessionManager as SessionManagerType } from '../session-manager.js';

const ROOT = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'clawo-autoloop-forum-'));
process.env.CLAWO_WF_DIR = path.join(ROOT, 'wf');
process.env.CLAWO_FORUM_SPOOL_ROOT = path.join(ROOT, 'spool');

const { AutoloopForumBridge, FORUM_APPENDIX_SEPARATOR, followForumPosts, stripForumBlocks } =
  await import('../autoloop/forum-bridge.js');
const { ClaudeAgentDispatcher } = await import('../autoloop/dispatcher.js');
const { Msg } = await import('../autoloop/messages.js');
const forum = await import('../kernel/forum.js');
const { SessionManager } = await import('../session-manager.js');
const { EmbeddedServer } = await import('../embedded-server.js');
const { loadRun, readEvents } = await import('../kernel/store.js');

type Bridge = InstanceType<typeof AutoloopForumBridge>;
type Role = 'planner' | 'coder' | 'reviewer';

const NAMES = { planner: 'planner', coder: 'coder', reviewer: 'reviewer' } as const;
const quiet = { warn: () => undefined };

let seq = 0;
/** A forum with no run whose team is the three roles. */
function standaloneForum(): string {
  const id = `fm-autoloop-${process.pid}-${++seq}`;
  forum.createForum(id, {
    team: (['planner', 'coder', 'reviewer'] as const).map((name) => ({ name, node: 'main', mayReturn: true })),
  });
  return id;
}

let ledgerDir: string;

function makeBridge(
  id: string,
  opts: { exposed?: boolean; deliverMidTurn?: (session: string, text: string) => Promise<boolean> } = {},
): Bridge {
  return new AutoloopForumBridge(
    { id, config: {}, exposed: opts.exposed ?? true, names: { ...NAMES } },
    { ledgerDir, deliverMidTurn: opts.deliverMidTurn, logger: quiet },
  );
}

/** The runner as the mirror sees it: envelopes, and which of them a role's turn produced. */
class FakeRunner extends EventEmitter {
  readonly fromAgents = new WeakSet<AnyAutoloopMessage>();
  emittedByAgent(env: AnyAutoloopMessage): boolean {
    return this.fromAgents.has(env);
  }
  agent<T extends AnyAutoloopMessage>(env: T): T {
    this.fromAgents.add(env);
    return env;
  }
}

const posts = (id: string) => forum.forumSnapshot(id).posts;
const events = (id: string) => forum.forumSnapshot(id).events;
const deliveredTo = (id: string, who: string, via: string): string[] =>
  events(id)
    .filter((e) => e.type === 'delivered' && e.who === who && e.via === via)
    .map((e) => (e as { id: string }).id);

beforeEach(() => {
  ledgerDir = fs.mkdtempSync(path.join(ROOT, 'ledger-'));
});

afterEach(() => {
  vi.useRealTimers();
});

// ─── The mirror ─────────────────────────────────────────────────────────────

describe('autoloop forum — the envelope mirror', () => {
  it('posts an envelope once, from the role that sent it, and records it as the recipient’s turn', async () => {
    const id = standaloneForum();
    const bridge = makeBridge(id);
    const runner = new FakeRunner();
    bridge.attach(runner);
    const directive = runner.agent(
      Msg.directive(3, {
        goal: 'fix add_two',
        constraints: ['no new files'],
        success_criteria: ['g1'],
        max_attempts: 2,
      }),
    );
    // A parked message is emitted when it is parked and again when the pause ends.
    runner.emit('message', directive);
    runner.emit('message', directive);
    await bridge.flush();

    const mirrored = posts(id).filter((p) => p.via === 'envelope');
    expect(mirrored).toHaveLength(1);
    expect(mirrored[0]).toMatchObject({
      from: 'planner',
      title: 'INFO @coder: iter 3 directive — fix add_two',
      tags: ['INFO'],
      to: ['coder'],
      data: { type: 'directive', iter: 3, msg_id: directive.msg_id },
    });
    expect(mirrored[0].body).toContain('no new files');
    expect(forum.forumAuthority(id, mirrored[0])).toBe('agent');
    expect(deliveredTo(id, 'coder', 'turn')).toEqual([mirrored[0].id]);
  });

  it('posts what the runner or an operator sent as the orchestrator, addressed to the user', async () => {
    const id = standaloneForum();
    const bridge = makeBridge(id);
    const runner = new FakeRunner();
    bridge.attach(runner);
    runner.emit('message', Msg.terminate(4, { reason: 'phase_error_circuit' }));
    runner.emit('message', runner.agent(Msg.pause(4, { reason: 'waiting on the user' })));
    // Not mirrored: review_request stays between the runner and the Reviewer, iter_done repeats the verdict.
    runner.emit('message', Msg.reviewRequest(4, { iter: 4, ledger_path: ledgerDir, prior_metrics: [] }));
    runner.emit('message', Msg.iterDone(4, { iter: 4, verdict: 'hold', metric: null }));
    await bridge.flush();

    const [terminate, pause, ...rest] = posts(id);
    expect(rest).toEqual([]);
    expect(terminate).toMatchObject({ from: 'orchestrator', title: 'INFO: loop terminated — phase_error_circuit' });
    expect(terminate.to).toEqual(['user']);
    expect(forum.forumAuthority(id, terminate)).toBe('orchestrator');
    expect(pause).toMatchObject({ from: 'planner', title: 'INFO: loop paused — waiting on the user', to: ['user'] });
  });

  it('posts an iteration with its summary, files and paths, never its diff', async () => {
    const id = standaloneForum();
    const bridge = makeBridge(id);
    const runner = new FakeRunner();
    bridge.attach(runner);
    fs.mkdirSync(path.join(ledgerDir, 'iter', '2'), { recursive: true });
    fs.writeFileSync(
      path.join(ledgerDir, 'iter', '2', 'coder_summary.txt'),
      'Cached the parser\n\n--- coder cleaned reply ---\nlong reply',
    );
    runner.emit(
      'message',
      runner.agent(
        Msg.iterArtifacts(2, {
          diff: 'diff --git a/x b/x\n+SECRET-DIFF-LINE',
          eval_output: { score: 0.93 },
          files_changed: ['src/parse.ts', 'src/cache.ts'],
        }),
      ),
    );
    await bridge.flush();

    const [post] = posts(id);
    expect(post).toMatchObject({ from: 'coder', title: 'DONE: iter 2 — Cached the parser', tags: ['DONE'] });
    expect(post.body).not.toContain('SECRET-DIFF-LINE');
    expect(post.body).not.toContain('long reply');
    expect(post.body).toContain('src/parse.ts, src/cache.ts');
    expect(post.body).toContain('{"score":0.93}');
    expect(post.body).toContain(path.join(ledgerDir, 'iter', '2', 'diff.patch'));
  });

  it('posts a verdict for the Planner, with the audit and the acceptance line', async () => {
    const id = standaloneForum();
    const bridge = makeBridge(id);
    const runner = new FakeRunner();
    bridge.attach(runner);
    runner.emit(
      'message',
      runner.agent(
        Msg.reviewVerdict(2, {
          decision: 'advance',
          metric: 0.9,
          audit_notes: 'G1 PASS — re-ran the eval',
          accepted: true,
          evidence_id: 'iter-2',
        }),
      ),
    );
    runner.emit(
      'message',
      runner.agent(Msg.reviewVerdict(3, { decision: 'hold', metric: null, audit_notes: 'G2 FAIL — eval changed' })),
    );
    await bridge.flush();

    const [win, hold] = posts(id);
    expect(win).toMatchObject({ from: 'reviewer', title: 'WIN: iter 2 advance (metric 0.9)', direct: ['planner'] });
    expect(win.body).toContain('G1 PASS — re-ran the eval');
    expect(win.body).toContain('Acceptance contract: passed (evidence iter-2).');
    expect(hold).toMatchObject({ title: 'FAIL: iter 3 hold', tags: ['FAIL'], direct: ['planner'] });
  });

  it('mirrors a push to the user when it is pushed, not each time one is queued', async () => {
    const id = standaloneForum();
    const bridge = makeBridge(id);
    const runner = new FakeRunner();
    bridge.attach(runner);
    const push = Msg.pushUser(1, {
      level: 'decision',
      summary: 'approve the plan?',
      detail: 'two options',
      channel: 'both',
    });
    runner.emit('message', push);
    await bridge.flush();
    expect(posts(id)).toEqual([]);

    runner.emit('push', { level: 'decision', summary: 'approve the plan?', channel: 'both' }, push);
    await bridge.flush();
    const [post] = posts(id);
    expect(post).toMatchObject({ from: 'orchestrator', title: 'ASK: approve the plan?', to: ['user'] });
    expect(post.body).toContain('two options');
  });

  it('mirrors the user’s chat as the user’s post, handed to the Planner as its turn and not again', async () => {
    const id = standaloneForum();
    const bridge = makeBridge(id);
    bridge.join('planner', 'autoloop-r-planner', { brief: false });
    const chat = Msg.chat(0, { text: 'Please plan the parser cache.\nKeep it small.' });
    bridge.mirrorChat(chat);
    bridge.mirrorChat(chat);
    await bridge.flush();

    const [post, ...rest] = posts(id);
    expect(rest).toEqual([]);
    expect(post).toMatchObject({
      from: 'user',
      title: 'INFO @planner: Please plan the parser cache.',
      to: ['planner'],
      via: 'envelope',
    });
    expect(forum.forumAuthority(id, post)).toBe('user');
    expect(deliveredTo(id, 'planner', 'turn')).toEqual([post.id]);
    expect(bridge.turnMessage('planner', 'next')).toBe('next');
    bridge.close();
  });

  it('posts a refused Planner control for the Planner, and the Coder’s log entries as its INFO posts', async () => {
    const id = standaloneForum();
    const bridge = makeBridge(id);
    bridge.join('planner', 'autoloop-r-planner', { brief: false });
    bridge.controlRejected(5, 'dispatch_x', 'Planner control error. Requested actions are not confirmed.\n1. bad');
    bridge.coderLog(5, ['tried memoising parse()', 'reverted: slower']);
    await bridge.flush();

    const [rejected, log1, log2] = posts(id);
    expect(rejected).toMatchObject({ from: 'orchestrator', title: 'FAIL @planner: control rejected (iter 5)' });
    expect(forum.forumAuthority(id, rejected)).toBe('orchestrator');
    expect(log1).toMatchObject({ from: 'coder', title: 'INFO: tried memoising parse()', via: 'reply' });
    expect(log2.title).toBe('INFO: reverted: slower');
    const next = bridge.turnMessage('planner', 'iter 5 done');
    expect(next.startsWith(`iter 5 done${FORUM_APPENDIX_SEPARATOR}`)).toBe(true);
    expect(next).toContain('control rejected (iter 5)');
    expect(next).toContain('From the orchestrator of this run.');
    bridge.close();
  });

  it('does not mirror again what an earlier bridge on the forum mirrored (a resumed run)', async () => {
    const id = standaloneForum();
    const first = makeBridge(id);
    const runner = new FakeRunner();
    first.attach(runner);
    first.join('planner', 'autoloop-r-planner', { brief: true });
    const ack = runner.agent(Msg.directiveAck(1, { understood: false, clarification: 'Which cache?\nLRU or TTL' }));
    runner.emit('message', ack);
    await first.flush();
    first.close();

    const second = makeBridge(id);
    const again = new FakeRunner();
    second.attach(again);
    again.emit('message', again.agent(ack));
    await second.flush();
    const mirrored = posts(id).filter((p) => p.via === 'envelope');
    expect(mirrored).toHaveLength(1);
    expect(mirrored[0]).toMatchObject({ from: 'coder', title: 'ASK @planner: iter 1 — Which cache?' });
    // The Planner was on this forum before: an engine that resumes its conversation keeps the brief it had.
    expect(second.wasMember('planner', { acrossRuns: true })).toBe(true);
    expect(second.wasMember('planner', { acrossRuns: false })).toBe(false);
    expect(second.wasMember('coder', { acrossRuns: true })).toBe(false);
  });
});

// ─── Members and turns ──────────────────────────────────────────────────────

describe('autoloop forum — the roles as members', () => {
  it('briefs a role once per new session, after its message', () => {
    const id = standaloneForum();
    const bridge = makeBridge(id);
    bridge.join('coder', 'autoloop-r-coder', { brief: true, cwd: ledgerDir });
    const first = bridge.turnMessage('coder', '[directive iter=0]\ngoal: g');
    expect(first.startsWith(`[directive iter=0]\ngoal: g${FORUM_APPENDIX_SEPARATOR}You are "coder"`)).toBe(true);
    expect(first).toContain('forum --dir');
    expect(first).toContain('Your iter_complete and request_clarification blocks are how you report');
    // Briefed again until a turn carrying the brief is sent.
    expect(bridge.turnMessage('coder', '[directive iter=0]')).toContain('You are "coder"');
    bridge.turnSent('coder');
    expect(bridge.turnMessage('coder', '[directive iter=1]')).toBe('[directive iter=1]');

    // A new session of the same role, with a new conversation, is briefed again.
    bridge.join('coder', 'autoloop-r-coder', { brief: true });
    expect(bridge.turnMessage('coder', '[directive iter=2]')).toContain('You are "coder"');
    bridge.close();
  });

  it('briefs the Planner read-only and compact, and the Reviewer write-only with no turn inbox', async () => {
    const id = standaloneForum();
    const bridge = makeBridge(id);
    bridge.join('planner', 'autoloop-r-planner', { brief: true });
    bridge.join('reviewer', 'autoloop-r-reviewer', { brief: true });
    await forum.forumRuntimePost(id, { from: 'user', title: 'FIX: keep the public API', body: 'no renames' });
    await forum.forumRuntimePost(id, { from: 'coder', title: 'FAIL @reviewer: you missed it' });

    const planner = bridge.turnMessage('planner', 'hello');
    expect(planner).toContain('This session is read-only');
    expect(planner).not.toContain('The forum now:');
    expect(planner).toContain('Your ```autoloop blocks are how you direct the loop');

    const reviewer = bridge.turnMessage('reviewer', '[review_request iter=0]');
    expect(reviewer.startsWith(`[review_request iter=0]${FORUM_APPENDIX_SEPARATOR}You are "reviewer"`)).toBe(true);
    expect(reviewer).toContain('you do not read it');
    expect(reviewer).toContain('Rule 2 stands');
    expect(reviewer).not.toContain('forum --dir');
    expect(reviewer).not.toContain('you missed it');
    bridge.turnSent('reviewer');
    // Its later turns carry nothing from the forum.
    await forum.forumRuntimePost(id, { from: 'user', title: 'FIX: and another thing' });
    expect(bridge.turnMessage('reviewer', '[review_request iter=1]')).toBe('[review_request iter=1]');
    bridge.close();
  });

  it('hands a post to a role mid-turn only while its own turn is in flight', async () => {
    const id = standaloneForum();
    const delivered: Array<{ session: string; text: string }> = [];
    const bridge = makeBridge(id, {
      deliverMidTurn: async (session, text) => {
        delivered.push({ session, text });
        return true;
      },
    });
    bridge.join('coder', 'autoloop-r-coder', { brief: false });
    bridge.join('reviewer', 'autoloop-r-reviewer', { brief: false });

    await forum.forumRuntimePost(id, { from: 'planner', title: 'FAIL @coder: the cache leaks' });
    expect(delivered).toEqual([]);

    const end = bridge.beginTurn('coder');
    await forum.forumRuntimePost(id, { from: 'planner', title: 'ASK @coder: which eviction policy?' });
    end();
    await forum.forumRuntimePost(id, { from: 'planner', title: 'FAIL @coder: still leaking' });
    expect(delivered.map((d) => d.session)).toEqual(['autoloop-r-coder']);
    expect(delivered[0].text).toContain('which eviction policy?');

    // What it did not get mid-turn comes with its next turn, once.
    const next = bridge.turnMessage('coder', '[directive iter=1]');
    expect(next).toContain('the cache leaks');
    expect(next).toContain('still leaking');
    expect(next).not.toContain('which eviction policy?');
    bridge.turnSent('coder');
    expect(bridge.turnMessage('coder', '[directive iter=2]')).toBe('[directive iter=2]');

    // The Reviewer takes nothing it is not named in, even mid-turn.
    const endReview = bridge.beginTurn('reviewer');
    await forum.forumRuntimePost(id, { from: 'user', title: 'FIX: to everyone' });
    await forum.forumRuntimePost(id, { from: 'coder', title: 'FAIL @reviewer: look again' });
    endReview();
    expect(delivered.map((d) => d.session)).not.toContain('autoloop-r-reviewer');
    bridge.close();
  });

  it('posts reply blocks under the role’s name and takes them out of the reply the user sees', () => {
    const id = standaloneForum();
    const bridge = makeBridge(id);
    bridge.join('planner', 'autoloop-r-planner', { brief: false });
    const reply =
      'Plan ready.\n\n<new-forum-post title="ASK @coder: is the eval seeded?">check eval.sh</new-forum-post>\n\nDone.';
    const posted = bridge.relay('planner', reply);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ from: 'planner', title: 'ASK @coder: is the eval seeded?', via: 'reply' });
    expect(bridge.relay('planner', reply)).toEqual([]);
    expect(bridge.strip(reply)).toBe('Plan ready.\n\nDone.');
    expect(stripForumBlocks('no blocks here')).toBe('no blocks here');
    bridge.close();
  });

  it('keeps the roles off a forum that is not exposed and still records the loop', async () => {
    const id = standaloneForum();
    const delivered: string[] = [];
    const bridge = makeBridge(id, {
      exposed: false,
      deliverMidTurn: async (session) => {
        delivered.push(session);
        return true;
      },
    });
    const runner = new FakeRunner();
    bridge.attach(runner);
    bridge.join('planner', 'autoloop-r-planner', { brief: true });
    expect(bridge.isMember('planner')).toBe(false);
    expect(bridge.turnMessage('planner', 'hello')).toBe('hello');
    expect(bridge.strip('a <new-forum-post title="X">y</new-forum-post>')).toBe(
      'a <new-forum-post title="X">y</new-forum-post>',
    );
    bridge.mirrorChat(Msg.chat(0, { text: 'hello' }));
    runner.emit('message', runner.agent(Msg.phaseError(0, { agent: 'coder', phase: 'send', error: 'died' })));
    await bridge.flush();
    expect(posts(id).map((p) => p.title)).toEqual(['INFO @planner: hello', 'FAIL @planner: coder send error (iter 0)']);
    expect(deliveredTo(id, 'planner', 'turn')).toEqual([]);
    expect(events(id).some((e) => e.type === 'join')).toBe(false);
    expect(delivered).toEqual([]);
  });

  it('streams each new post once, with who it speaks for', async () => {
    const id = standaloneForum();
    await forum.forumRuntimePost(id, { from: 'user', title: 'INFO: before the stream' });
    const seen: Array<{ id: string; from: string; authority: string; title: string; tags: string[]; to: string[] }> =
      [];
    const stop = followForumPosts(id, (p) => seen.push(p), 20);
    try {
      await forum.forumRuntimePost(id, { from: 'orchestrator', title: 'FAIL @coder: red build', to: ['coder'] });
      await forum.forumRuntimePost(id, { from: 'coder', title: 'WIN: green' });
      await vi.waitFor(() => expect(seen).toHaveLength(2), { timeout: 2_000, interval: 20 });
    } finally {
      stop();
    }
    expect(seen.map((p) => [p.from, p.authority, p.title, p.tags])).toEqual([
      ['orchestrator', 'orchestrator', 'FAIL @coder: red build', ['FAIL']],
      ['coder', 'agent', 'WIN: green', ['WIN']],
    ]);
    expect(seen[0].to).toEqual(['coder']);
  });
});

// ─── The dispatcher on a forum ──────────────────────────────────────────────

describe('autoloop forum — the dispatcher', () => {
  function stubManager(outputs: string[]) {
    let i = 0;
    const calls = {
      startSession: vi.fn(async (config: Partial<SessionConfig>) => ({ name: config.name, state: 'ready' })),
      sendMessage: vi.fn(async (_name: string, _text: string) => ({ output: outputs[i++] ?? 'ok', error: undefined })),
      stopSession: vi.fn(async () => undefined),
      hasSession: vi.fn(() => true),
      getStatus: vi.fn(() => ({ stats: { contextPercent: 10 } })),
      compactSession: vi.fn(async () => undefined),
    };
    return { manager: calls as unknown as SessionManagerType, calls };
  }

  function dispatcherOn(id: string, outputs: string[]) {
    const workspace = fs.mkdtempSync(path.join(ROOT, 'ws-'));
    const { manager, calls } = stubManager(outputs);
    const bridge = new AutoloopForumBridge(
      { id, config: {}, exposed: true, names: { ...NAMES } },
      { ledgerDir: path.join(workspace, 'tasks', 'r1'), logger: quiet },
    );
    const dispatcher = new ClaudeAgentDispatcher({
      manager,
      runId: 'r1',
      workspace,
      forum: bridge,
      ownerRunId: 'run-x',
    });
    const sent = (role: Role): string[] =>
      calls.sendMessage.mock.calls.filter((c) => c[0] === `autoloop-r1-${role}`).map((c) => c[1] as string);
    return { dispatcher, calls, bridge, sent, workspace };
  }

  it('starts every role session as the run’s, and briefs the Planner after the user’s chat', async () => {
    const id = standaloneForum();
    const { dispatcher, calls, bridge, sent } = dispatcherOn(id, ['Here is a plan.', 'Noted.']);
    await dispatcher.init({} as never);
    await dispatcher.deliver(Msg.chat(0, { text: 'Speed up the parser' }));
    await dispatcher.deliver(Msg.chat(0, { text: 'Use a cache' }));
    await bridge.flush();

    expect(calls.startSession.mock.calls[0][0]).toMatchObject({ name: 'autoloop-r1-planner', ownerRunId: 'run-x' });
    const [first, second] = sent('planner');
    expect(first.startsWith(`Speed up the parser${FORUM_APPENDIX_SEPARATOR}You are "planner"`)).toBe(true);
    // The chat itself is the turn: not briefed again, not handed again from the forum.
    expect(second).toBe('Use a cache');
    expect(
      posts(id)
        .filter((p) => p.from === 'user')
        .map((p) => p.title),
    ).toEqual(['INFO @planner: Speed up the parser', 'INFO @planner: Use a cache']);
    // Never in the system prompt.
    expect(String(calls.startSession.mock.calls[0][0].systemPrompt)).not.toContain('forum');
    bridge.close();
  });

  it('tells the Planner of a refused control at its next turn', async () => {
    const id = standaloneForum();
    const bad = '```autoloop\n{not json}\n```';
    const { dispatcher, bridge, sent } = dispatcherOn(id, [bad, 'ok']);
    await dispatcher.init({} as never);
    await dispatcher.deliver(Msg.chat(0, { text: 'go' }));
    await bridge.flush();
    await dispatcher.deliver(Msg.chat(0, { text: 'and now?' }));
    const second = sent('planner')[1];
    expect(second.startsWith(`and now?${FORUM_APPENDIX_SEPARATOR}`)).toBe(true);
    expect(second).toContain('FAIL @planner: control rejected (iter 0)');
    bridge.close();
  });

  it('keeps the Coder’s directive header first, posts its log and reply blocks, and strips them from its reply', async () => {
    const id = standaloneForum();
    const coderReply =
      'Working on it.\n<new-forum-post title="ASK @planner: may I add a dependency?">lru-cache</new-forum-post>\n' +
      '```autoloop\n{"tool":"coder_log","args":{"message":"profiled: parse() is 80%"}}\n```\n' +
      '```autoloop\n{"tool":"request_clarification","args":{"question":"Which cache?"}}\n```';
    const { dispatcher, bridge, sent } = dispatcherOn(id, [coderReply]);
    await dispatcher.spawnSubagents({});
    const replies: string[] = [];
    dispatcher.on('coder_reply', (t: string) => replies.push(t));
    const out = await dispatcher.deliver(
      Msg.directive(0, { goal: 'speed up', constraints: [], success_criteria: [], max_attempts: 1 }),
    );
    await bridge.flush();

    expect(out[0]).toMatchObject({ type: 'directive_ack', payload: { understood: false } });
    const [prompt] = sent('coder');
    expect(prompt.startsWith('[directive iter=0]\ngoal: speed up')).toBe(true);
    expect(prompt).toContain(`${FORUM_APPENDIX_SEPARATOR}You are "coder"`);
    expect(replies).toEqual(['Working on it.']);
    const byCoder = posts(id).filter((p) => p.from === 'coder');
    expect(byCoder.map((p) => [p.title, p.via])).toEqual([
      ['ASK @planner: may I add a dependency?', 'reply'],
      ['INFO: profiled: parse() is 80%', 'reply'],
    ]);
    bridge.close();
  });

  it('briefs a role again after a reset, and not after a rebind that keeps its conversation', async () => {
    const id = standaloneForum();
    const { dispatcher, bridge, sent } = dispatcherOn(id, []);
    await dispatcher.init({} as never);
    await dispatcher.deliver(Msg.chat(0, { text: 'one' }));
    dispatcher.requestRoleRebind('planner', { model: 'sonnet' });
    await dispatcher.deliver(Msg.chat(0, { text: 'two' }));
    await dispatcher.resetAgent('planner', { force: true });
    await dispatcher.deliver(Msg.chat(0, { text: 'three' }));
    const [one, two, three] = sent('planner');
    expect(one).toContain('You are "planner"');
    expect(two).toBe('two');
    expect(three).toContain('You are "planner"');
    await dispatcher.shutdown('test');
    expect(bridge.isMember('planner')).toBe(false);
    bridge.close();
  });
});

// ─── A run ──────────────────────────────────────────────────────────────────

class MockSession extends EventEmitter implements ISession {
  sessionId?: string;
  private effort: EffortLevel = 'auto';
  sendCalls: string[] = [];
  get isReady() {
    return true;
  }
  get isPaused() {
    return false;
  }
  get isBusy() {
    return false;
  }
  async start(): Promise<this> {
    this.sessionId = `mock-${Math.random().toString(36).slice(2, 8)}`;
    return this;
  }
  stop(): void {}
  pause(): void {}
  resume(): void {}
  async send(
    message: string | unknown[],
    options?: SessionSendOptions,
  ): Promise<TurnResult | { requestId: number; sent: boolean }> {
    this.sendCalls.push(typeof message === 'string' ? message : JSON.stringify(message));
    if (options?.waitForComplete === false) return { requestId: 1, sent: true };
    return { text: 'ack', event: { type: 'result', result: 'ok' } };
  }
  getStats(): SessionStats & { sessionId?: string; uptime: number } {
    return {
      turns: this.sendCalls.length,
      turnsSucceeded: this.sendCalls.length,
      toolCalls: 0,
      toolErrors: 0,
      tokensIn: 1,
      tokensOut: 1,
      cachedTokens: 0,
      costUsd: 0,
      isReady: true,
      startTime: new Date().toISOString(),
      lastActivity: new Date().toISOString(),
      contextPercent: 5,
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
      tokensIn: 1,
      tokensOut: 1,
      cachedTokens: 0,
      pricing: { inputPer1M: 0, outputPer1M: 0, cachedPer1M: 0 },
      breakdown: { inputCost: 0, cachedCost: 0, outputCost: 0 },
      totalUsd: 0,
    };
  }
  async compact(): Promise<TurnResult> {
    return { text: 'compacted', event: { type: 'result' } };
  }
  getEffort(): EffortLevel {
    return this.effort;
  }
  setEffort(level: EffortLevel): void {
    this.effort = level;
  }
  resolveModel(alias: string): string {
    return alias;
  }
}

describe('autoloop forum — a run', () => {
  let mgr: InstanceType<typeof SessionManager>;
  let sessions: Map<string, MockSession>;

  beforeEach(() => {
    sessions = new Map();
    mgr = new SessionManager({
      claudeBin: 'mock-claude',
      maxConcurrentSessions: 5,
      sessionTtlMinutes: 120,
      defaultPermissionMode: 'acceptEdits',
      defaultEffort: 'auto',
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mgr as any)._createSession = (_engine: string, config: SessionConfig): ISession => {
      const mock = new MockSession();
      sessions.set(config.name, mock);
      return mock;
    };
  });

  afterEach(async () => {
    await mgr.shutdown();
  });

  const workspaceFor = (runId: string): string => fs.mkdtempSync(path.join(ROOT, `${runId}-`));

  it('puts the roles on the run forum by default, and only records the loop with forum: false', async () => {
    await mgr.autoloopStart({ runId: 'fa-on', workspace: workspaceFor('fa-on') });
    expect(loadRun('fa-on')!.spec.forum).toEqual({});
    await mgr.autoloopChat('fa-on', 'plan it');
    const on = sessions.get('autoloop-fa-on-planner')!.sendCalls[0];
    expect(on.startsWith(`plan it${FORUM_APPENDIX_SEPARATOR}You are "planner"`)).toBe(true);
    const [chat] = forum.forumSnapshot('fa-on').posts;
    expect(chat).toMatchObject({ from: 'user', title: 'INFO @planner: plan it' });
    expect(forum.forumAuthority('fa-on', chat)).toBe('user');

    await mgr.autoloopStart({ runId: 'fa-off', workspace: workspaceFor('fa-off'), forum: false });
    expect(loadRun('fa-off')!.spec.forum).toBeUndefined();
    expect(loadRun('fa-off')!.spec.nodes[0]).not.toHaveProperty('config.forum');
    await mgr.autoloopChat('fa-off', 'plan it');
    expect(sessions.get('autoloop-fa-off-planner')!.sendCalls).toEqual(['plan it']);
    expect(forum.forumSnapshot('fa-off').posts.map((p) => p.title)).toEqual(['INFO @planner: plan it']);

    await expect(
      mgr.autoloopStart({ runId: 'fa-bad', workspace: workspaceFor('fa-bad'), forum: { push: 'loud' } as never }),
    ).rejects.toThrow(/autoloop forum\.push must be one of/);
    expect(loadRun('fa-bad')).toBeUndefined();
  });

  it('takes a steer, which reaches the Planner with its next turn as the user’s post', async () => {
    await mgr.autoloopStart({ runId: 'fa-steer', workspace: workspaceFor('fa-steer') });
    await mgr.autoloopChat('fa-steer', 'first');
    expect(mgr.workflowSteer('fa-steer', 'keep the public API stable').steered).toBe(true);
    await vi.waitFor(
      () =>
        expect(forum.forumSnapshot('fa-steer').posts.some((p) => p.title.startsWith('FIX: keep the public'))).toBe(
          true,
        ),
      { timeout: 5_000, interval: 50 },
    );
    await mgr.autoloopChat('fa-steer', 'second');
    const second = sessions.get('autoloop-fa-steer-planner')!.sendCalls[1];
    expect(second.startsWith(`second${FORUM_APPENDIX_SEPARATOR}`)).toBe(true);
    expect(second).toContain('FIX: keep the public API stable');
    expect(second).toContain('From the user who started this run.');
    expect(forum.forumSnapshot('fa-steer').posts.filter((p) => p.title.startsWith('FIX:'))).toHaveLength(1);

    await mgr.autoloopStop('fa-steer', 'done');
    await vi.waitFor(() =>
      expect(readEvents('fa-steer').some((e) => e.type === 'steer_consumed' && e.count === 1)).toBe(true),
    );
  });

  it('gives back a steer no role had by the time the loop ends', async () => {
    await mgr.autoloopStart({ runId: 'fa-steer-back', workspace: workspaceFor('fa-steer-back') });
    mgr.workflowSteer('fa-steer-back', 'nobody hears this');
    await vi.waitFor(
      () => expect(forum.forumSnapshot('fa-steer-back').posts.some((p) => p.title.startsWith('FIX:'))).toBe(true),
      { timeout: 5_000, interval: 50 },
    );
    await mgr.autoloopStop('fa-steer-back', 'done');
    await vi.waitFor(() => expect(loadRun('fa-steer-back')!.state).toBe('completed'));
    expect(readEvents('fa-steer-back').some((e) => e.type === 'steer_consumed')).toBe(false);
  });

  it('forwards forum from POST /autoloop/new', async () => {
    const start = vi.spyOn(mgr, 'autoloopStart').mockResolvedValue({
      runId: 'fa-http',
      plannerSession: 'autoloop-fa-http-planner',
      state: {} as never,
    });
    const port = await new Promise<number>((resolve, reject) => {
      const srv = net.createServer();
      srv.listen(0, '127.0.0.1', () => {
        const p = (srv.address() as net.AddressInfo).port;
        srv.close(() => resolve(p));
      });
      srv.on('error', reject);
    });
    const server = new EmbeddedServer(mgr, port);
    await server.start();
    try {
      const token = fs.readFileSync(path.join(os.homedir(), '.openclaw', 'server-token'), 'utf-8').trim();
      const r = await fetch(`http://127.0.0.1:${port}/autoloop/new`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace: workspaceFor('fa-http'), run_id: 'fa-http', forum: false }),
      });
      expect(r.status).toBe(200);
      expect(start).toHaveBeenCalledWith(expect.objectContaining({ runId: 'fa-http', forum: false }));
    } finally {
      await server.stop();
      start.mockRestore();
    }
  });
});
