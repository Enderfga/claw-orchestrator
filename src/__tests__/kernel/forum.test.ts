/**
 * The run forum: the files the agents' CLI reads and writes, the hub that
 * copies them into the run and pushes posts, and the forum inside a workflow.
 *
 * What these pin: a post's tags, addressees and references are read from its
 * text; NEW marks what an agent has not seen; the default push reaches only an
 * agent that an ASK or FAIL names, and only while it is on the forum; the run
 * directory keeps the forum when the spool is gone; and the metrics say when a
 * named agent saw a post and when an ASK was answered.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ensureForumSpool,
  forumBrief,
  ForumHub,
  forumList,
  forumMetrics,
  forumInbox,
  forumPost,
  forumPostNotes,
  forumRead,
  forumRoster,
  forumSpoolDir,
  forumStoreDir,
  ForumReplyRelay,
  normalizeForumConfig,
  postsInReply,
  parseMentions,
  parseRefs,
  parseTags,
  unreadFor,
} from '../../kernel/forum.js';
import { RunKernel } from '../../kernel/engine.js';
import { registerDefaultExecutors } from '../../kernel/nodes/index.js';
import type { WorkflowSpec } from '../../kernel/types.js';

let tmp: string;
const saved = { wf: process.env.CLAWO_WF_DIR, spool: process.env.CLAWO_FORUM_SPOOL_ROOT };

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clawo-forum-'));
  process.env.CLAWO_WF_DIR = path.join(tmp, 'wf');
  process.env.CLAWO_FORUM_SPOOL_ROOT = path.join(tmp, 'spool');
});

afterEach(() => {
  for (const [k, v] of [
    ['CLAWO_WF_DIR', saved.wf],
    ['CLAWO_FORUM_SPOOL_ROOT', saved.spool],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

const RUN = 'wf-forum-test';

describe('reading a post', () => {
  it('takes tags from the start of the title, addressees from @names, and references from post ids', () => {
    expect(parseTags('FAIL: shadows flicker')).toEqual(['FAIL']);
    expect(parseTags('[ASK] WIN what changed')).toEqual(['ASK', 'WIN']);
    expect(parseTags('Shadows FAIL')).toEqual([]);
    expect(parseMentions('ASK @lighting and @sound-2. thanks, not an@email')).toEqual(['lighting', 'sound-2']);
    expect(parseRefs('FIX re p00012 and p00003, not p12')).toEqual(['p00012', 'p00003']);
  });

  it('refuses a forum config it cannot follow rather than dropping it', () => {
    expect(normalizeForumConfig(true)).toEqual({});
    expect(normalizeForumConfig(undefined)).toBeUndefined();
    expect(normalizeForumConfig({ push: 'all', score: { file: 'check.json' } })).toEqual({
      push: 'all',
      score: { file: 'check.json' },
    });
    expect(() => normalizeForumConfig({ push: 'sometimes' })).toThrow(/push must be one of/);
    expect(() => normalizeForumConfig({ score: {} })).toThrow(/needs a file or a command/);
    expect(() => normalizeForumConfig({ digestMs: 10 })).toThrow(/at least 1000/);
  });
});

describe('the CLI side', () => {
  it('posts with ids in order, lists titles with NEW for what an agent has not seen, and reads one in full', () => {
    const dir = ensureForumSpool(RUN, {});
    const ask = forumPost(dir, 'parts', { title: 'ASK @lighting which light rig?', body: 'need the API' });
    const win = forumPost(dir, 'lighting', { title: 'WIN: baked shadows', body: 'see p00001', re: [] });
    expect(ask.id).toBe('p00001');
    expect(ask.tags).toEqual(['ASK']);
    expect(ask.to).toEqual(['lighting']);
    expect(win.id).toBe('p00002');
    expect(win.re).toEqual(['p00001']);

    const before = forumList(dir, 'lighting');
    expect(before).toMatch(/NEW p00001/);
    // Its own post is not new to it.
    expect(before).not.toMatch(/NEW p00002/);
    expect(forumRead(dir, 'lighting', 'p00001')).toContain('need the API');
    expect(forumList(dir, 'lighting')).not.toMatch(/NEW p00001/);
    // Reverse: another agent has still not seen it.
    expect(forumList(dir, 'sound')).toMatch(/NEW p00001/);
  });

  it('attaches the score the run configured, from a file in the agent’s directory', () => {
    const dir = ensureForumSpool(RUN, { score: { file: 'tools/check-last.json' } });
    const cwd = path.join(tmp, 'work');
    fs.mkdirSync(path.join(cwd, 'tools'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'tools', 'check-last.json'), JSON.stringify({ passed: 7, failed: 2 }));
    expect(forumPost(dir, 'parts', { title: 'WIN: x', cwd }).score).toEqual({ passed: 7, failed: 2 });
    // A missing score says so instead of failing the post.
    const other = path.join(tmp, 'elsewhere');
    fs.mkdirSync(other);
    expect(forumPost(dir, 'parts', { title: 'FAIL: y', cwd: other }).score).toMatchObject({
      error: expect.stringMatching(/score unavailable/),
    });
  });

  it('says where to post from when there is no forum', () => {
    expect(() => forumPost(path.join(tmp, 'nowhere'), 'a', { title: 'WIN' })).toThrow(/No forum/);
    expect(() => forumPost(ensureForumSpool(RUN, {}), 'bad name', { title: 'WIN' })).toThrow(/Invalid forum name/);
  });
});

describe('the hub', () => {
  function members(hub: ForumHub, names: string[]) {
    const got: Record<string, string[]> = {};
    const leave = names.map((n) => {
      got[n] = [];
      return hub.join(n, (text) => {
        got[n].push(text);
        return true;
      });
    });
    return { got, leaveAll: () => leave.forEach((l) => l()) };
  }

  it('by default pushes only an ASK or FAIL to the member it names, and nothing else', async () => {
    const hub = new ForumHub(RUN, {});
    const { got, leaveAll } = members(hub, ['parts', 'lighting', 'sound']);
    const dir = forumSpoolDir(RUN);
    forumPost(dir, 'parts', { title: 'ASK @lighting which rig?' });
    forumPost(dir, 'parts', { title: 'WIN: 60fps' });
    forumPost(dir, 'sound', { title: 'NOTE @lighting fyi' });
    forumPost(dir, 'parts', { title: 'FAIL @sound clipping at 0dB' });
    await hub.sync();
    expect(got.lighting).toHaveLength(1);
    expect(got.lighting[0]).toContain('ASK @lighting which rig?');
    expect(got.lighting[0]).toContain('not an instruction from the user');
    expect(got.sound).toHaveLength(1);
    expect(got.sound[0]).toContain('p00004');
    expect(got.parts).toHaveLength(0);
    leaveAll();
  });

  it('pushes every post by someone else under push: all, and titles in a digest under push: digest', async () => {
    const all = new ForumHub(RUN, { push: 'all' });
    const a = members(all, ['x', 'y']);
    forumPost(forumSpoolDir(RUN), 'x', { title: 'WIN: one' });
    await all.sync();
    expect(a.got.y).toHaveLength(1);
    expect(a.got.x).toHaveLength(0);
    a.leaveAll();

    const run2 = 'wf-forum-digest';
    const digest = new ForumHub(run2, { push: 'digest', digestMs: 60_000 });
    const d = members(digest, ['x', 'y']);
    forumPost(forumSpoolDir(run2), 'x', { title: 'WIN: two' });
    forumPost(forumSpoolDir(run2), 'x', { title: 'ASK @y now' });
    await digest.sync();
    // The ASK that names y goes at once; the rest waits for the digest.
    expect(d.got.y).toHaveLength(1);
    await (digest as unknown as { flushDigests(): Promise<void> }).flushDigests();
    expect(d.got.y).toHaveLength(2);
    expect(d.got.y[1]).toMatch(/digest[\s\S]*WIN: two/);
    d.leaveAll();
  });

  it('keeps the forum in the run directory, and puts the spool back from it', async () => {
    const hub = new ForumHub(RUN, {});
    const { leaveAll } = members(hub, ['a']);
    forumPost(forumSpoolDir(RUN), 'b', { title: 'FAIL @a broken' });
    await hub.sync();
    leaveAll();
    expect(fs.readFileSync(path.join(forumStoreDir(RUN), 'posts.jsonl'), 'utf8')).toContain('FAIL @a broken');

    fs.rmSync(forumSpoolDir(RUN), { recursive: true, force: true });
    const dir = ensureForumSpool(RUN, {});
    expect(forumList(dir, 'c')).toContain('FAIL @a broken');
    // The next post continues the numbering.
    expect(forumPost(dir, 'c', { title: 'WIN' }).id).toBe('p00002');
  });

  it('measures when a named agent saw a post, and when an ASK was answered', async () => {
    const hub = new ForumHub(RUN, {});
    const { leaveAll } = members(hub, ['lighting']);
    const dir = forumSpoolDir(RUN);
    const ask = forumPost(dir, 'tester', { title: 'ASK @lighting why is the bridge dark?' });
    forumPost(dir, 'tester', { title: 'FAIL @sound no audio' });
    await hub.sync();
    forumPost(dir, 'lighting', { title: 'FIX: bridge lamp re-enabled', re: [ask.id] });
    await hub.sync();
    leaveAll();
    await new Promise((r) => setTimeout(r, 20));

    const m = forumMetrics(RUN);
    expect(m.posts).toBe(3);
    expect(m.byTag).toMatchObject({ ASK: 1, FAIL: 1, FIX: 1 });
    expect(m.asks[0]).toMatchObject({ id: 'p00001', answeredBy: 'lighting', answerId: 'p00003' });
    expect(m.asks[0].latencyMs).toBeGreaterThanOrEqual(0);
    expect(m.openAsks).toEqual([]);
    const toLighting = m.mentions.find((x) => x.to === 'lighting')!;
    expect(toLighting).toMatchObject({ via: 'push' });
    // `sound` was never on the forum, so it has not seen the post addressed to it.
    expect(m.mentions.find((x) => x.to === 'sound')!.seenAt).toBeUndefined();
    expect(m.unseenMentions).toBe(1);
    expect(unreadFor(RUN, 'sound').map((p) => p.id)).toEqual(['p00002']);
  });

  it('tells an agent joining late what is open for it', () => {
    const dir = ensureForumSpool(RUN, { score: { file: 'x.json' } });
    forumPost(dir, 'tester', { title: 'FAIL @fix the boat sinks' });
    forumPost(dir, 'parts', { title: 'ASK @lighting which rig?' });
    const brief = forumBrief(RUN, 'fix', ['parts', 'lighting', 'tester', 'fix'], {});
    expect(brief).toContain(`--dir ${forumSpoolDir(RUN)} --as fix`);
    expect(brief).toContain('with parts, lighting, tester');
    expect(brief).toMatch(/name you \(@fix\)[\s\S]*p00001 tester: FAIL @fix the boat sinks/);
    expect(brief).toMatch(/Open ASKs[\s\S]*p00002 parts: ASK @lighting which rig\?/);
    expect(brief).toMatch(/ASK and FAIL posts that name you \(@fix\) are delivered/);
  });
});

describe('a forum in a workflow', () => {
  /** A manager whose sessions run a script per agent; mid-turn deliveries are recorded. */
  function scriptedManager(scripts: Record<string, (prompt: string) => Promise<string>>) {
    const prompts: Record<string, string> = {};
    const midTurn: Record<string, string[]> = {};
    const busy = new Set<string>();
    const agentOf = (session: string) => Object.keys(scripts).find((a) => session.endsWith(`-${a}`)) ?? session;
    const manager = {
      startSession: async (config: { name?: string }) => ({ name: config.name }) as never,
      sendMessage: async (name: string, message: string) => {
        const agent = agentOf(name);
        prompts[agent] = message;
        busy.add(name);
        try {
          return { output: await (scripts[agent] ?? (async () => 'ok'))(message), turns: 1 } as never;
        } finally {
          busy.delete(name);
        }
      },
      stopSession: async () => undefined,
      deliverMidTurn: async (name: string, text: string) => {
        if (!busy.has(name)) return false;
        (midTurn[agentOf(name)] ??= []).push(text);
        return true;
      },
    };
    return { manager, prompts, midTurn };
  }

  const cmdOf = (prompt: string) => {
    const m = /--dir (\S+) --as (\S+)/.exec(prompt);
    if (!m) throw new Error('no forum command in the prompt');
    return { dir: m[1], as: m[2] };
  };

  it('briefs each fan-out agent, pushes an ASK into the named agent’s turn, and names open ASKs in the result', async () => {
    const waitFor = async (cond: () => boolean, ms = 5_000) => {
      const end = Date.now() + ms;
      while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
    };
    const s = scriptedManager({
      parts: async (prompt) => {
        const { dir, as } = cmdOf(prompt);
        forumPost(dir, as, { title: 'ASK @lighting which light rig do you expose?' });
        await waitFor(() => (s.midTurn.lighting ?? []).length > 0);
        return 'parts done';
      },
      lighting: async () => {
        await waitFor(() => (s.midTurn.lighting ?? []).length > 0);
        return 'lighting done';
      },
    });
    const kernel = registerDefaultExecutors(new RunKernel({ manager: s.manager as never, nodeTimeoutMs: 20_000 }));
    const spec: WorkflowSpec = {
      name: 'team',
      cwd: tmp,
      forum: true,
      nodes: [
        {
          id: 'build',
          kind: 'fanout',
          prompt: 'build your part',
          agents: [
            { name: 'parts', engine: 'claude' },
            { name: 'lighting', engine: 'claude' },
          ],
        },
        { id: 'fix', kind: 'agent', prompt: 'fix what is open' },
      ],
    };
    const run = await kernel.start(spec);
    const done = await kernel.wait(run.runId);
    expect(done!.state).toBe('completed');

    expect(s.prompts.parts).toMatch(/You are "parts", one agent of a team that shares a forum with lighting, fix/);
    expect(s.midTurn.lighting).toHaveLength(1);
    expect(s.midTurn.lighting[0]).toContain('ASK @lighting which light rig do you expose?');
    // The ASK was never answered, so the node says so, and the next agent is told.
    const data = done!.nodes.build.data as { forum?: { openAsks: Array<{ id: string }> } };
    expect(data.forum?.openAsks.map((a) => a.id)).toEqual(['p00001']);
    const fixPrompt = Object.entries(s.prompts).find(([k]) => k.includes('-fix-'))?.[1];
    expect(fixPrompt).toMatch(/Open ASKs nobody has answered yet:\n {2}p00001 parts: ASK @lighting/);

    const m = forumMetrics(run.runId);
    // The agents start together, so lighting can have the ASK in its brief before the push reaches its turn.
    expect(m.mentions[0].to).toBe('lighting');
    expect(['push', 'brief']).toContain(m.mentions[0].via);
  });

  it('refuses a forum whose agent names cannot be addressed', async () => {
    const kernel = registerDefaultExecutors(new RunKernel({ nodeTimeoutMs: 5_000 }));
    await expect(
      kernel.start({
        name: 'bad',
        cwd: tmp,
        forum: true,
        nodes: [{ id: 'f', kind: 'fanout', prompt: 'x', agents: [{ name: 'has space', engine: 'claude' }] }],
      }),
    ).rejects.toThrow(/forum names must be/);
    // Without a forum the same name is not the forum's business.
    await expect(
      kernel.start({
        name: 'bad',
        cwd: tmp,
        forum: { push: 'loud' } as never,
        nodes: [{ id: 'a', kind: 'agent', prompt: 'x' }],
      }),
    ).rejects.toThrow(/push must be one of/);
  });
});

describe('after the first full run', () => {
  it('finds the score in the directory the agent works in, not wherever its shell happens to be', async () => {
    const dir = ensureForumSpool(RUN, { score: { file: 'tools/check-last.json' } });
    const work = path.join(tmp, 'game');
    fs.mkdirSync(path.join(work, 'tools'), { recursive: true });
    fs.writeFileSync(path.join(work, 'tools', 'check-last.json'), JSON.stringify({ ok: true }));
    const hub = new ForumHub(RUN, { score: { file: 'tools/check-last.json' } });
    const leave = hub.join('direction', () => true, { cwd: work });
    const shell = path.join(tmp, 'dir-posts');
    fs.mkdirSync(shell);
    expect(forumPost(dir, 'direction', { title: 'WIN: x', cwd: shell }).score).toEqual({ ok: true });
    leave();
  });

  it('attaches only the fields picked from the score, and keeps a large one short', () => {
    const big = { ok: false, failures: ['R1 warden'], log: Array.from({ length: 400 }, (_, i) => `line ${i}`) };
    const work = path.join(tmp, 'w');
    fs.mkdirSync(work);
    fs.writeFileSync(path.join(work, 'check.json'), JSON.stringify(big, null, 2));
    const picked = ensureForumSpool(RUN, { score: { file: 'check.json', pick: ['ok', 'failures', 'missing'] } });
    expect(forumPost(picked, 'a', { title: 'FAIL: x', cwd: work }).score).toEqual({
      ok: false,
      failures: ['R1 warden'],
    });

    const whole = ensureForumSpool('wf-forum-whole', { score: { file: 'check.json' } });
    const post = forumPost(whole, 'a', { title: 'FAIL: warden cannot be killed', body: 'steps', cwd: work });
    const stored = typeof post.score === 'string' ? post.score : JSON.stringify(post.score);
    expect(stored.length).toBeLessThanOrEqual(2_000);
    const shown = forumRead(whole, 'b', post.id);
    // The title comes first; the score is one short line after the body.
    expect(shown.indexOf('FAIL: warden cannot be killed')).toBeLessThan(shown.indexOf('score:'));
    expect(shown.split('\n').find((l) => l.startsWith('score:'))!.length).toBeLessThanOrEqual(320);
    expect(() => normalizeForumConfig({ score: { file: 'x', pick: 'ok' } })).toThrow(/pick/);
  });

  it('takes only the forum’s own tags, counts the rest as OTHER, and says when a post has none', () => {
    expect(parseTags('R1 Barrow Warden cannot be killed')).toEqual([]);
    expect(parseTags('R1 FAIL: warden cannot be killed')).toEqual(['FAIL']);
    expect(parseTags('NOTE: later')).toEqual([]);
    const dir = ensureForumSpool(RUN, {});
    const untagged = forumPost(dir, 'tester', { title: 'R1 Barrow Warden cannot be killed' });
    forumPost(dir, 'tester', { title: 'FAIL: R2 door' });
    expect(forumMetrics(RUN).byTag).toEqual({ OTHER: 1, FAIL: 1 });
    expect(forumPostNotes(dir, untagged).join('\n')).toMatch(/WIN, FAIL, ASK, FIX, DONE or INFO/);
  });

  it('knows which members can come back: only those on a loop', () => {
    const roster = forumRoster({
      name: 'team',
      cwd: tmp,
      nodes: [
        { id: 'play', kind: 'fanout', prompt: 'p', agents: [{ name: 'tester', engine: 'claude' }] },
        { id: 'fix', kind: 'agent', prompt: 'f' },
        { id: 'judge', kind: 'agent', prompt: 'j' },
        { id: 'again', kind: 'router', routes: [{ when: { type: 'always' }, to: 'fix' }] },
      ],
    } as WorkflowSpec);
    expect(roster).toEqual([
      { name: 'tester', node: 'play', mayReturn: false },
      { name: 'fix', node: 'fix', mayReturn: true },
      { name: 'judge', node: 'judge', mayReturn: true },
    ]);
  });

  it('tells a poster that the agent it names has finished for good, and lists who is running, finished or not started', async () => {
    const s = { notes: [] as string[], list: '' };
    const manager = {
      startSession: async (config: { name?: string }) => ({ name: config.name }) as never,
      sendMessage: async (name: string, message: string) => {
        if (name.includes('-fix-')) {
          const m = /--dir (\S+) --as (\S+)/.exec(message)!;
          const post = forumPost(m[1], m[2], { title: 'ASK @tester please post what you met' });
          s.notes = forumPostNotes(m[1], post);
          s.list = forumList(m[1], m[2]);
        }
        return { output: 'ok', turns: 1 } as never;
      },
      stopSession: async () => undefined,
    };
    const kernel = registerDefaultExecutors(new RunKernel({ manager: manager as never, nodeTimeoutMs: 20_000 }));
    const run = await kernel.start({
      name: 'team',
      cwd: tmp,
      forum: true,
      nodes: [
        { id: 'play', kind: 'fanout', prompt: 'p', agents: [{ name: 'tester', engine: 'claude' }] },
        { id: 'fix', kind: 'agent', prompt: 'f' },
        { id: 'ship', kind: 'agent', prompt: 's' },
      ],
    });
    expect((await kernel.wait(run.runId))!.state).toBe('completed');
    expect(s.notes.join('\n')).toMatch(/@tester has finished and does not run again in this run/);
    expect(s.list).toMatch(/^Team: tester \(finished\), fix \(you, running\), ship \(not started\)/);
    // Each member joined with the directory it works in, which is where its score is read.
    const joins = fs
      .readFileSync(path.join(forumSpoolDir(run.runId), 'events.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
      .filter((e) => e.type === 'join');
    expect(joins.map((e) => [e.who, e.cwd])).toEqual([
      ['tester', tmp],
      ['fix', tmp],
      ['ship', tmp],
    ]);
  });
});

describe('after the runs on 7.28.0', () => {
  it('addresses only members of the forum, so a number after @ is not a recipient', () => {
    const dir = ensureForumSpool(RUN, {});
    // A spool written for a run whose team is known.
    fs.writeFileSync(
      path.join(dir, 'config.json'),
      JSON.stringify({ runId: RUN, team: [{ name: 'feel', node: 'build', mayReturn: false }] }),
    );
    const post = forumPost(dir, 'look', { title: 'INFO @feel contrast', body: 'aim for @0.88, ask @ghost' });
    expect(post.to).toEqual(['feel']);
    const notes = forumPostNotes(dir, post).join('\n');
    expect(notes).toMatch(/@ghost is not on this forum/);
    expect(notes).not.toMatch(/0\.88/);
  });

  it('counts a mention as delivered when it reached the agent in its brief, or a later node instead', async () => {
    const posts: Record<string, () => void> = {};
    const manager = {
      startSession: async (config: { name?: string }) => ({ name: config.name }) as never,
      sendMessage: async (name: string, message: string) => {
        const m = /--dir (\S+) --as (\S+)/.exec(message)!;
        const who = m[2];
        if (who === 'direction') forumPost(m[1], who, { title: 'INFO @feel build the jump', body: 'gravity @0.88' });
        if (who === 'tester') forumPost(m[1], who, { title: 'FAIL @feel jump is too short' });
        posts[who] = () => undefined;
        return { output: 'ok', turns: 1 } as never;
      },
      stopSession: async () => undefined,
    };
    const kernel = registerDefaultExecutors(new RunKernel({ manager: manager as never, nodeTimeoutMs: 20_000 }));
    const run = await kernel.start({
      name: 'team',
      cwd: tmp,
      forum: true,
      nodes: [
        { id: 'direction', kind: 'agent', prompt: 'd' },
        { id: 'build', kind: 'fanout', prompt: 'b', agents: [{ name: 'feel', engine: 'claude' }] },
        { id: 'test', kind: 'fanout', prompt: 't', agents: [{ name: 'tester', engine: 'claude' }] },
        { id: 'fix', kind: 'agent', prompt: 'f' },
      ],
    });
    expect((await kernel.wait(run.runId))!.state).toBe('completed');
    await new Promise((r) => setTimeout(r, 50));

    const m = forumMetrics(run.runId);
    // The number was never a recipient, not even in metrics.
    expect(m.mentions.map((x) => x.to)).toEqual(['feel', 'feel']);
    // The INFO reached feel in its brief when it started.
    expect(m.mentions[0]).toMatchObject({ id: 'p00001', to: 'feel', via: 'brief' });
    // The FAIL came after feel had finished; it reached the fix node in its brief.
    expect(m.mentions[1].seenAt).toBeUndefined();
    expect(m.mentions[1].handedTo).toMatchObject({ who: 'fix', via: 'brief' });
    expect(m.unseenMentions).toBe(0);
    expect(m.handedMentions).toBe(1);

    // A post written before only members were addressees still names the number; the metrics leave it out.
    const old = {
      id: 'p00003',
      ts: new Date().toISOString(),
      from: 'look',
      title: 'INFO',
      body: '@0.88',
      tags: ['INFO'],
      to: ['0.88'],
      re: [],
    };
    fs.appendFileSync(path.join(forumSpoolDir(run.runId), 'posts.jsonl'), JSON.stringify(old) + '\n');
    expect(forumMetrics(run.runId).mentions.map((x) => x.to)).toEqual(['feel', 'feel']);
  });
});

describe('delivery to an agent whose engine takes nothing mid-turn', () => {
  it('shows what would have been pushed at the top of its next forum command, once', () => {
    const dir = ensureForumSpool(RUN, {});
    forumPost(dir, 'tester', { title: 'FAIL @feel jump is too short', body: 'measured 1.2 m, needs 2 m' });
    forumPost(dir, 'tester', { title: 'WIN: door opens' });
    forumPost(dir, 'tester', { title: 'ASK @other what is next?' });
    const first = forumInbox(dir, 'feel');
    expect(first).toContain('FAIL @feel jump is too short');
    expect(first).toContain('measured 1.2 m');
    // Only what the push rules would have pushed to feel: not the WIN, not someone else's ASK.
    expect(first).not.toContain('door opens');
    expect(first).not.toContain('what is next');
    // Once.
    expect(forumInbox(dir, 'feel')).toBe('');
    // It counts as seen and as delivered.
    expect(forumList(dir, 'feel')).not.toMatch(/NEW p00001/);
    const m = forumMetrics(RUN).mentions.find((x) => x.id === 'p00001' && x.to === 'feel')!;
    expect(m).toMatchObject({ via: 'cli' });
  });

  it('follows the push mode: all posts under all, nothing under none, and skips what the agent read', () => {
    const dirAll = ensureForumSpool('wf-forum-inbox-all', { push: 'all' });
    forumPost(dirAll, 'a', { title: 'WIN: one' });
    forumPost(dirAll, 'a', { title: 'INFO: two' });
    forumRead(dirAll, 'b', 'p00002');
    const shown = forumInbox(dirAll, 'b');
    expect(shown).toContain('WIN: one');
    expect(shown).not.toContain('INFO: two');

    const dirNone = ensureForumSpool('wf-forum-inbox-none', { push: 'none' });
    forumPost(dirNone, 'a', { title: 'FAIL @b broken' });
    expect(forumInbox(dirNone, 'b')).toBe('');
  });

  it('does not push again what the agent already had through its forum command', async () => {
    const hub = new ForumHub(RUN, {});
    const got: string[] = [];
    const leave = hub.join('feel', (text) => {
      got.push(text);
      return true;
    });
    const dir = forumSpoolDir(RUN);
    forumPost(dir, 'tester', { title: 'FAIL @feel jump is too short' });
    // The agent's own forum command comes first, before the hub's next sync.
    expect(forumInbox(dir, 'feel')).toContain('jump is too short');
    await hub.sync();
    expect(got).toHaveLength(0);
    leave();
  });
});

describe('a member that cannot run the forum command', () => {
  it('posts by writing blocks in its reply: a title, a body, the posts it answers', () => {
    const reply = [
      'Reviewed the diff.',
      '<new-forum-post title="FAIL: off-by-one in sum()" re="p00003 p00007">sum(1, 2) returns -1</new-forum-post>',
      '<new-forum-post>INFO no title attribute\nthe first line is the title</new-forum-post>',
      // a post it was handed and quotes, and an escaped block, are not posts of its own
      '<forum-post id="p00004" from="lighting">ASK @me what rig?</forum-post>',
      '&lt;new-forum-post title="WIN: quoted"&gt;x&lt;/new-forum-post&gt;',
    ].join('\n');
    expect(postsInReply(reply)).toEqual([
      { title: 'FAIL: off-by-one in sum()', body: 'sum(1, 2) returns -1', re: ['p00003', 'p00007'] },
      { title: 'INFO no title attribute', body: 'the first line is the title', re: [] },
    ]);
  });

  it('has each block posted once, as soon as it is complete in the streaming reply', () => {
    ensureForumSpool(RUN, {});
    const relay = new ForumReplyRelay(RUN, 'reviewer');
    let text = 'Looking. <new-forum-post title="WIN: tests pass">all 12';
    expect(relay.take(text)).toEqual([]);
    text += ' green</new-forum-post> and more text';
    const [post] = relay.take(text);
    expect(post).toMatchObject({ id: 'p00001', from: 'reviewer', title: 'WIN: tests pass', via: 'reply' });
    expect(relay.take(text)).toEqual([]);
    // The whole reply at the end of the turn does not post it again.
    expect(relay.take(`${text} DONE`)).toEqual([]);
    expect(forumList(forumSpoolDir(RUN), 'other')).toMatch(/p00001 {2}reviewer .*WIN: tests pass/);
  });

  it('gets a brief with the forum as it stands instead of commands, and its reply blocks reach the team', async () => {
    const manager = {
      startSession: async (config: { name?: string }) => ({ name: config.name }) as never,
      sendMessage: async (
        name: string,
        message: string,
        opts: { onChunk?: (t: string) => void } = {},
      ): Promise<never> => {
        if (name.includes('-build-')) {
          const m = /--dir (\S+) --as (\S+)/.exec(message)!;
          forumPost(m[1], m[2], { title: 'ASK @reviewer does the fix hold?', body: 'see sum.js' });
          return { output: 'built', turns: 1 } as never;
        }
        prompts.reviewer = message;
        // The block streams in; it is on the forum before the turn ends.
        opts.onChunk?.('Checked. <new-forum-post title="FAIL: @build sum(1,2) is -1" re="p00001">');
        opts.onChunk?.('subtraction, not addition</new-forum-post>');
        postedMidTurn = fs.existsSync(path.join(forumSpoolDir(runId), 'posts.jsonl'))
          ? fs.readFileSync(path.join(forumSpoolDir(runId), 'posts.jsonl'), 'utf8').includes('FAIL: @build')
          : false;
        return {
          output:
            'Checked. <new-forum-post title="FAIL: @build sum(1,2) is -1" re="p00001">subtraction, not addition</new-forum-post>',
          turns: 1,
        } as never;
      },
      stopSession: async () => undefined,
    };
    const prompts: Record<string, string> = {};
    let postedMidTurn = false;
    let runId = '';
    const kernel = registerDefaultExecutors(new RunKernel({ manager: manager as never, nodeTimeoutMs: 20_000 }));
    const spec: WorkflowSpec = {
      name: 'review',
      cwd: tmp,
      forum: true,
      nodes: [
        { id: 'build', kind: 'agent', prompt: 'build it', next: 'review' },
        {
          id: 'review',
          kind: 'fanout',
          prompt: 'review the build',
          agents: [{ name: 'reviewer', engine: 'claude', sandboxMode: 'read-only' }],
        },
      ],
    };
    const run = await kernel.start(spec);
    runId = run.runId;
    const done = await kernel.wait(run.runId);
    expect(done!.state).toBe('completed');

    const brief = prompts.reviewer;
    expect(brief).toMatch(/This session is read-only, so the forum command is not available to you/);
    expect(brief).not.toMatch(/forum --dir/);
    expect(brief).toMatch(/The forum now:[\s\S]*p00001 {2}build → @reviewer .*ASK @reviewer does the fix hold\?/);
    expect(brief).toMatch(/In full, the posts that name you:[\s\S]*see sum\.js/);

    expect(postedMidTurn).toBe(true);
    const posts = fs
      .readFileSync(path.join(forumStoreDir(run.runId), 'posts.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(posts).toHaveLength(2);
    expect(posts[1]).toMatchObject({ from: 'reviewer', to: ['build'], re: ['p00001'], via: 'reply' });
  });

  it('is handed whole posts and no command to run, live and in a digest', async () => {
    const long = 'x'.repeat(3_000);
    for (const push of ['mentions', 'digest'] as const) {
      const run = `${RUN}-${push}`;
      const hub = new ForumHub(run, { push, digestMs: 60_000 });
      const got: string[] = [];
      const leave = hub.join('reviewer', (text) => (got.push(text), true), { readOnly: true });
      forumPost(forumSpoolDir(run), 'builder', {
        title: push === 'digest' ? 'WIN: shipped' : 'ASK @reviewer ok?',
        body: long,
      });
      await hub.sync();
      if (push === 'digest') await (hub as unknown as { flushDigests(): Promise<void> }).flushDigests();
      expect(got).toHaveLength(1);
      expect(got[0]).toContain(long);
      expect(got[0]).not.toMatch(/forum --dir|read p0|read <id>/);
      leave();
    }
  });

  it('tells an agent that can run the command how to post when it cannot', () => {
    ensureForumSpool(RUN, {});
    const brief = forumBrief(RUN, 'builder', ['builder', 'reviewer'], {});
    expect(brief).toMatch(/forum --dir .* post --title/);
    expect(brief).toMatch(/If these cannot run where you are, write <new-forum-post title=/);
  });
});

describe('an agent node in plan mode on a forum', () => {
  it('posts the blocks in its reply under its node id', async () => {
    const manager = {
      startSession: async (config: { name?: string }) => ({ name: config.name }) as never,
      sendMessage: async () =>
        ({
          output: 'Read it. <new-forum-post title="WIN: no regressions">audited 3 files</new-forum-post>',
          turns: 1,
        }) as never,
      stopSession: async () => undefined,
    };
    const kernel = registerDefaultExecutors(new RunKernel({ manager: manager as never, nodeTimeoutMs: 20_000 }));
    const run = await kernel.start({
      name: 'audit',
      cwd: tmp,
      forum: true,
      nodes: [{ id: 'audit', kind: 'agent', prompt: 'audit', permissionMode: 'plan' }],
    });
    await kernel.wait(run.runId);
    const { forumSnapshot } = await import('../../kernel/forum.js');
    expect(forumSnapshot(run.runId).posts).toMatchObject([
      { from: 'audit', title: 'WIN: no regressions', via: 'reply' },
    ]);
  });
});

describe('a fan-out with a forum', () => {
  it('is one flag on the fan-out templates', async () => {
    const { fanoutWorkflow, legacyFanoutWorkflow } = await import('../../kernel/templates/index.js');
    const agents = [
      { name: 'a', engine: 'claude' as const },
      { name: 'b', engine: 'agy' as const },
    ];
    expect(fanoutWorkflow({ task: 't', cwd: tmp, agents, forum: true }).forum).toBe(true);
    expect(fanoutWorkflow({ task: 't', cwd: tmp, agents }).forum).toBeUndefined();
    expect(legacyFanoutWorkflow({ task: 't', cwd: tmp, agents, forum: { push: 'all' } }).forum).toEqual({
      push: 'all',
    });
  });
});
