/**
 * How a workflow run's messages move over its forum: a steer is the user's
 * post and still the kernel's queue; a goal hands a steer over once, and gives
 * back what it never handed over; a gate asks on the forum and its answer is
 * posted there, its comment queued as a steer; an agent's output is handed
 * over as a post (`inputs` reads it from the run directory); the verifier
 * mirrors its verdict; the fixer and the synthesis are members; a subflow's
 * child joins its parent's forum under a prefix.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RunKernel, steerTitle } from '../../kernel/engine.js';
import { registerDefaultExecutors } from '../../kernel/nodes/index.js';
import type { GoalSnapshot, GoalStatus } from '../../kernel/nodes/goal.js';
import { acquireLease, commit, loadRun, readEvents, releaseLease } from '../../kernel/store.js';
import type { WorkflowSpec } from '../../kernel/types.js';
import { forumAuthority, forumPost, forumSnapshot, forumSpoolDir, openAsksOf } from '../../kernel/forum.js';

let tmp: string;
const saved = { wf: process.env.CLAWO_WF_DIR, spool: process.env.CLAWO_FORUM_SPOOL_ROOT };

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clawo-flow-'));
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await sleep(25);
}

/** A goal session that moves only when a test says so. */
class FakeGoal extends EventEmitter {
  goal: GoalSnapshot | null = null;
  lastError = null;
  turnActive = false;
  sets: Array<{ objective?: string; status?: string; context?: string }> = [];
  steered: string[] = [];
  constructor(readonly codexThreadId: string) {
    super();
  }
  move(status: GoalStatus): void {
    this.goal = { ...(this.goal as GoalSnapshot), status };
    setImmediate(() => this.emit('goal:updated', this.goal));
  }
  async setGoal(p: { objective?: string; status?: 'active' | 'paused'; context?: string }): Promise<GoalSnapshot> {
    this.sets.push(p);
    this.goal = {
      objective: p.objective ?? this.goal?.objective ?? '',
      status: p.status ?? 'active',
      tokenBudget: null,
      tokensUsed: 0,
      timeUsedSeconds: 0,
    };
    return { ...this.goal };
  }
  async getGoal() {
    return this.goal;
  }
  async clearGoal() {
    this.goal = null;
  }
  async steer(text: string) {
    if (!this.turnActive) return { steered: false };
    this.steered.push(text);
    return { steered: true };
  }
  async interrupt() {
    return { interrupted: true };
  }
}

/**
 * One manager for every kind of node: agent turns answer through `reply`, goal
 * sessions are `FakeGoal`s, and a session that is in a turn takes pushes.
 */
function fakeManager(reply: (name: string, prompt: string) => string | Promise<string> = () => 'ok') {
  const starts: Array<Record<string, unknown>> = [];
  const prompts: Record<string, string> = {};
  const midTurn: Record<string, string[]> = {};
  const busy = new Set<string>();
  const goals = new Map<string, FakeGoal>();
  const manager = {
    async startSession(config: Record<string, unknown>) {
      starts.push(config);
      if (config.engine === 'codex-app') goals.set(String(config.name), new FakeGoal(`thread-${goals.size + 1}`));
      return { name: config.name } as never;
    },
    async sendMessage(name: string, message: string, opts: { onChunk?: (t: string) => void } = {}) {
      prompts[name] = message;
      busy.add(name);
      try {
        const output = await reply(name, message);
        opts.onChunk?.(output);
        return { output, turns: 1 } as never;
      } finally {
        busy.delete(name);
      }
    },
    async stopSession() {},
    async deliverMidTurn(name: string, text: string) {
      if (!busy.has(name)) return false;
      (midTurn[name] ??= []).push(text);
      return true;
    },
    codexGoalSession(name: string) {
      return goals.get(name) as never;
    },
  };
  const promptOf = (node: string) => Object.entries(prompts).find(([k]) => k.includes(`-${node}-`))?.[1] ?? '';
  return { manager, starts, prompts, midTurn, goals, promptOf };
}

function kernelWith(m: ReturnType<typeof fakeManager>) {
  return registerDefaultExecutors(new RunKernel({ manager: m.manager as never, nodeTimeoutMs: 20_000 }));
}

const consumed = (runId: string) =>
  readEvents(runId)
    .filter((e) => e.type === 'steer_consumed')
    .map((e) => [(e as { node: string }).node, (e as { count: number }).count]);

describe('a steer', () => {
  it('is the user’s FIX post on the run’s log, and the queued steer and its event carry the post id', async () => {
    const got: Array<{ text: string; postId?: string }> = [];
    let go!: () => void;
    const ready = new Promise<void>((r) => (go = r));
    const kernel = new RunKernel({ nodeTimeoutMs: 5_000 });
    kernel.setExecutor('agent', async (_n, ctx) => {
      await ready;
      got.push(...ctx.takeSteerEntries());
      return { ok: true };
    });
    const run = await kernel.start({ name: 's', cwd: tmp, nodes: [{ id: 'a', kind: 'agent', prompt: 'a' }] });
    expect(kernel.steer(run.runId, 'use the other library\nit has the API we need')).toBe(true);
    go();
    await kernel.wait(run.runId);

    const [post] = forumSnapshot(run.runId).posts;
    expect(post).toMatchObject({
      from: 'user',
      title: 'FIX: use the other library',
      body: 'use the other library\nit has the API we need',
      tags: ['FIX'],
      data: { kind: 'steer' },
    });
    expect(forumAuthority(run.runId, post)).toBe('user');
    expect(got).toEqual([{ text: 'use the other library\nit has the API we need', postId: post.id }]);
    const steer = readEvents(run.runId).find((e) => e.type === 'steer') as { postId?: string };
    expect(steer.postId).toBe(post.id);
    expect(consumed(run.runId)).toEqual([['a', 1]]);
  });

  it('has a title cut to fit, from its first line', () => {
    expect(steerTitle('\n\n  fix   the   build  \nmore')).toBe('FIX: fix the build');
    const long = steerTitle('x'.repeat(300));
    expect(long.length).toBeLessThanOrEqual(120);
    expect(long.endsWith('…')).toBe(true);
  });

  it('reaches an agent mid-turn as the user’s post, and the next agent once, in its brief', async () => {
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const m = fakeManager(async (name) => {
      if (name.includes('-a-')) await hold;
      return 'done';
    });
    const kernel = kernelWith(m);
    const run = await kernel.start({
      name: 'team',
      cwd: tmp,
      forum: true,
      nodes: [
        { id: 'a', kind: 'agent', prompt: 'build' },
        { id: 'b', kind: 'agent', prompt: 'check' },
      ],
    });
    await until(() => !!m.promptOf('a'));
    kernel.steer(run.runId, 'keep the public API stable');
    const aSession = Object.keys(m.prompts).find((k) => k.includes('-a-'))!;
    await until(() => (m.midTurn[aSession] ?? []).length > 0);
    release();
    await kernel.wait(run.runId);

    expect(m.midTurn[aSession][0]).toContain('from="user"');
    expect(m.midTurn[aSession][0]).toContain('From the user who started this run.');
    // b takes the steer from the queue; its brief shows the post whole, so it is not repeated after it.
    const b = m.promptOf('b');
    expect(b).toContain('From the user:');
    expect(b.split('keep the public API stable').length - 1).toBe(2); // the post's title and body, once
    expect(consumed(run.runId)).toEqual([['b', 1]]);
  });
});

describe('a goal and the steers it takes', () => {
  const spec = (forum?: boolean): WorkflowSpec => ({
    name: 'g',
    cwd: tmp,
    ...(forum ? { forum: true } : {}),
    nodes: [
      { id: 'goal', kind: 'goal', objective: 'make it fast', engine: 'codex' } as never,
      { id: 'b', kind: 'agent', prompt: 'next' },
    ],
  });

  it('gives a steer it never handed over back to the run, for the next node', async () => {
    const m = fakeManager();
    const kernel = kernelWith(m);
    const run = await kernel.start(spec());
    await until(() => [...m.goals.values()].some((g) => g.sets.length > 0));
    kernel.steer(run.runId, 'log every round');
    // The goal's loop takes it within a tick; no turn is running, so it cannot be handed over.
    await sleep(1_300);
    const goal = [...m.goals.values()][0];
    goal.move('complete');
    const done = await kernel.wait(run.runId);
    expect(done!.state).toBe('completed');
    expect(goal.steered).toEqual([]);
    expect(m.promptOf('b')).toContain('log every round');
    // Consumed by b, which handed it over; the goal is not counted, so a restart in between would replay it.
    expect(consumed(run.runId)).toEqual([['b', 1]]);
  });

  it('hands a steer it is both pushed and queued over once, and records it delivered only then', async () => {
    const m = fakeManager();
    const kernel = kernelWith(m);
    const run = await kernel.start(spec(true));
    await until(() => [...m.goals.values()].some((g) => g.sets.length > 0));
    const goal = [...m.goals.values()][0];
    kernel.steer(run.runId, 'log every round');
    const post = forumSnapshot(run.runId).posts.find((p) => p.data?.kind === 'steer')!;
    const delivered = () =>
      forumSnapshot(run.runId).events.filter((e) => e.type === 'delivered' && e.who === 'goal' && e.id === post.id);
    await sleep(1_300);
    // Queued, not in a turn yet: nothing on record.
    expect(delivered()).toEqual([]);
    goal.turnActive = true;
    await until(() => goal.steered.length > 0);
    await sleep(1_200);
    expect(goal.steered).toHaveLength(1);
    expect(goal.steered[0]).toContain('From the user who started this run.');
    expect(delivered().map((e) => (e as { via: string }).via)).toEqual(['push']);
    goal.turnActive = false;
    goal.move('complete');
    await kernel.wait(run.runId);
    // Handed over, so consumed by the goal: b does not take it again.
    expect(consumed(run.runId)).toEqual([['goal', 1]]);
  });

  it('gets the short brief on Codex', async () => {
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const m = fakeManager(async (name) => {
      if (name.includes('-scout-')) await hold;
      return 'ok';
    });
    const kernel = kernelWith(m);
    const run = await kernel.start({
      name: 'g',
      cwd: tmp,
      forum: true,
      nodes: [
        { id: 'scout', kind: 'agent', prompt: 'look' },
        { id: 'goal', kind: 'goal', objective: 'fix it', engine: 'codex', sandboxMode: 'read-only' } as never,
      ],
    });
    // Seven FAILs on the forum before the goal starts.
    await until(() => !!m.promptOf('scout'));
    for (let i = 1; i <= 7; i++) forumPost(forumSpoolDir(run.runId), 'scout', { title: `FAIL: case ${i}` });
    release();
    await until(() => [...m.goals.values()].some((g) => g.sets.length > 0));
    const goal = [...m.goals.values()][0];
    const objective = goal.sets[0].objective ?? '';
    goal.move('complete');
    await kernel.wait(run.runId);
    expect(objective).toMatch(/FAIL posts so far:[\s\S]*… 2 more/);
    expect(objective).not.toContain('The forum now:');
  });
});

describe('a human gate', () => {
  const gated = (): WorkflowSpec => ({
    name: 'gated',
    cwd: tmp,
    nodes: [
      { id: 'gate', kind: 'human_gate', prompt: 'Ship the migration?\nIt drops a column.' },
      { id: 'b', kind: 'agent', prompt: 'migrate' },
    ],
  });

  it('asks the user on the forum, and posts the answer with its comment, which the next agent hears', async () => {
    const m = fakeManager();
    const kernel = kernelWith(m);
    const run = await kernel.start(gated());
    await until(() => loadRun(run.runId)?.state === 'awaiting_human');
    const ask = forumSnapshot(run.runId).posts[0];
    expect(ask).toMatchObject({
      from: 'orchestrator',
      title: 'ASK @user: Ship the migration?',
      body: 'Ship the migration?\nIt drops a column.',
      to: ['user'],
      data: { gate: 'gate' },
    });
    expect(forumAuthority(run.runId, ask)).toBe('orchestrator');

    expect(kernel.approve(run.runId, true, 'back the table up first')).toBe(true);
    const done = await kernel.wait(run.runId);
    expect(done!.state).toBe('completed');
    const answer = forumSnapshot(run.runId).posts.find((p) => p.title === 'DONE: approved')!;
    expect(answer).toMatchObject({ from: 'user', body: 'back the table up first', re: [ask.id] });
    expect(forumAuthority(run.runId, answer)).toBe('user');
    expect(openAsksOf(run.runId)).toEqual([]);
    expect(m.promptOf('b')).toContain('back the table up first');
    const steer = readEvents(run.runId).find((e) => e.type === 'steer') as { text: string; postId?: string };
    expect(steer).toMatchObject({ text: 'back the table up first', postId: answer.id });
  });

  it('answers a gate a gone process parked, asks once, and still queues the comment', async () => {
    const m = fakeManager();
    const first = kernelWith(m);
    const run = await first.start(gated());
    await until(() => loadRun(run.runId)?.state === 'awaiting_human');
    first.cancel(run.runId);
    await first.wait(run.runId);
    // What a process that died at the gate leaves behind.
    const record = loadRun(run.runId)!;
    record.state = 'awaiting_human';
    record.endedAt = undefined;
    record.nodes.gate.state = 'awaiting_human';
    record.nodes.b.state = 'pending';
    record.currentNode = 'gate';
    const lease = acquireLease(record.runId, 'crashed-process');
    commit(lease, { record });
    releaseLease(lease);

    const kernel = kernelWith(m);
    expect(await kernel.approveStored(run.runId, false, 'not on a Friday')).toBe(true);
    const done = await kernel.wait(run.runId);
    expect(done!.state).toBe('failed');
    const posts = forumSnapshot(run.runId).posts;
    expect(posts.filter((p) => p.title.startsWith('ASK @user'))).toHaveLength(1);
    expect(posts.find((p) => p.title === 'FAIL: rejected')).toMatchObject({
      from: 'user',
      body: 'not on a Friday',
      re: [posts[0].id],
    });
    expect(readEvents(run.runId).some((e) => e.type === 'steer' && e.text === 'not on a Friday')).toBe(true);
  });
});

describe('a handover', () => {
  it('posts an agent’s output when it succeeds; a later node reads its inputs from the run directory', async () => {
    const long = 'finding '.repeat(1_250); // 10,000 characters: past the record's preview, within the excerpt
    const m = fakeManager((name) => (name.includes('-scout-') ? long : 'ok'));
    const kernel = kernelWith(m);
    const run = await kernel.start({
      name: 'h',
      cwd: tmp,
      nodes: [
        { id: 'scout', kind: 'agent', prompt: 'look' },
        { id: 'impl', kind: 'agent', prompt: 'build', inputs: ['scout'] },
      ],
    });
    await kernel.wait(run.runId);
    const handover = forumSnapshot(run.runId).posts.find((p) => p.via === 'output' && p.from === 'scout')!;
    expect(handover).toMatchObject({ title: 'DONE: scout output', to: [], data: { node: 'scout', runId: run.runId } });
    expect(handover.body).toBe(long.trim());
    const prompt = m.promptOf('impl');
    expect(prompt).toContain(`### scout\n\n${long.trim()}`);
    expect(prompt).not.toContain('[truncated');
  });

  it('hands over each fan-out answer and the synthesis when the node ends, the synthesis a read-only member', async () => {
    const m = fakeManager((name, prompt) => {
      if (name.endsWith('-synthesis')) {
        return 'Merged. <new-forum-post title="INFO: both agree">on the cache</new-forum-post>';
      }
      if (name.endsWith('-a')) return 'use a cache <new-forum-post title="WIN: cache">hit rate 90%</new-forum-post>';
      return prompt ? 'use a cache too' : '';
    });
    const kernel = kernelWith(m);
    const run = await kernel.start({
      name: 'f',
      cwd: tmp,
      forum: true,
      nodes: [
        {
          id: 'review',
          kind: 'fanout',
          prompt: 'how to make it fast',
          synthesize: true,
          agents: [
            { name: 'a', engine: 'claude' },
            { name: 'b', engine: 'claude' },
          ],
        },
      ],
    });
    await kernel.wait(run.runId);
    const synthStart = m.starts.find((s) => String(s.name).endsWith('-synthesis'))!;
    expect(synthStart).toMatchObject({ permissionMode: 'plan', sandboxMode: 'read-only', ownerRunId: run.runId });
    const synthPrompt = Object.entries(m.prompts).find(([k]) => k.endsWith('-synthesis'))![1];
    expect(synthPrompt).toContain('You are "synthesis", one agent of a team');
    expect(synthPrompt).toMatch(/This session is read-only/);
    // The agents' blocks were posted already; in its material they are fenced.
    expect(synthPrompt).toContain('&lt;new-forum-post title="WIN: cache">');
    const posts = forumSnapshot(run.runId).posts;
    expect(posts.filter((p) => p.title === 'WIN: cache')).toHaveLength(1);
    expect(posts.find((p) => p.title === 'INFO: both agree')).toMatchObject({ from: 'synthesis', via: 'reply' });
    expect(posts.filter((p) => p.via === 'output').map((p) => p.title)).toEqual([
      'DONE: a output',
      'DONE: b output',
      'DONE: synthesis output',
    ]);
    for (const s of m.starts) expect(s.ownerRunId).toBe(run.runId);
  });
});

describe('the verifier on the forum', () => {
  it('mirrors a red verdict as the orchestrator’s FAIL that names nobody, and puts its fixer on the forum', async () => {
    const m = fakeManager((name) =>
      name.includes('-fix-')
        ? 'patched <new-forum-post title="FIX: guarded the null">in parse()</new-forum-post>'
        : 'built',
    );
    const kernel = kernelWith(m);
    const run = await kernel.start({
      name: 'v',
      cwd: tmp,
      forum: true,
      nodes: [
        { id: 'goal', kind: 'agent', prompt: 'build' },
        {
          id: 'check',
          kind: 'verifier',
          contract: {
            fixOnFailureRounds: 1,
            checks: [
              {
                id: 'tests',
                spec: {
                  type: 'command',
                  cmd: process.execPath,
                  args: ['-e', 'console.log("FAIL @goal broke it"); process.exit(1)'],
                },
              },
            ],
          },
        },
      ],
    });
    const done = await kernel.wait(run.runId);
    expect(done!.outcome).toBe('refuted');
    const posts = forumSnapshot(run.runId).posts;
    const verdict = posts.find((p) => p.from === 'orchestrator' && p.tags.includes('FAIL'))!;
    expect(verdict.title).toBe('FAIL: verification — 1 required checks failed (tests)');
    expect(verdict.body).toContain('FAIL @goal broke it');
    expect(verdict.to).toEqual([]);
    expect(verdict.data).toEqual({ evidenceId: done!.evidenceId, passed: false });
    expect(forumAuthority(run.runId, verdict)).toBe('orchestrator');
    // The fixer: briefed as check.fix, its reply block posted under that name, its session the run's.
    const fixPrompt = Object.entries(m.prompts).find(([k]) => k.includes('-fix-'))![1];
    expect(fixPrompt).toContain('You are "check.fix", one agent of a team');
    expect(fixPrompt).toContain('Acceptance checks are failing in this working tree.');
    expect(posts.find((p) => p.title === 'FIX: guarded the null')).toMatchObject({ from: 'check.fix', via: 'reply' });
    expect(m.starts.find((s) => String(s.name).includes('-fix-'))).toMatchObject({ ownerRunId: run.runId });
  });

  it('mirrors a green verdict as a WIN', async () => {
    const kernel = kernelWith(fakeManager());
    const run = await kernel.start({
      name: 'v',
      cwd: tmp,
      nodes: [
        {
          id: 'check',
          kind: 'verifier',
          contract: { checks: [{ id: 'ok', spec: { type: 'command', cmd: process.execPath, args: ['-e', ''] } }] },
        },
      ],
    });
    const done = await kernel.wait(run.runId);
    expect(done!.outcome).toBe('verified');
    expect(forumSnapshot(run.runId).posts.map((p) => [p.from, p.title, p.data])).toEqual([
      ['orchestrator', 'WIN: verified (1 checks)', { evidenceId: done!.evidenceId, passed: true }],
    ]);
  });
});

describe('a subflow', () => {
  it('puts its child’s agents on the parent’s forum, each under the subflow’s prefix', async () => {
    const m = fakeManager(() => 'ok <new-forum-post title="WIN: child done">all of it</new-forum-post>');
    const kernel = kernelWith(m);
    const run = await kernel.start({
      name: 'parent',
      cwd: tmp,
      forum: true,
      nodes: [
        {
          id: 'sub',
          kind: 'subflow',
          workflow: { name: 'child', nodes: [{ id: 'impl', kind: 'agent', prompt: 'do it' }] },
        },
      ],
    });
    const done = await kernel.wait(run.runId);
    expect(done!.state).toBe('completed');
    const child = loadRun(done!.nodes.sub.childRunId!)!;
    expect(child.forum).toEqual({ runId: run.runId, agent: '', prefix: 'sub.' });
    expect(Object.values(m.prompts)[0]).toContain('You are "sub.impl", one agent of a team');
    const posts = forumSnapshot(run.runId).posts;
    expect(posts.map((p) => [p.from, p.title])).toEqual([
      ['sub.impl', 'WIN: child done'],
      ['sub.impl', 'DONE: sub.impl output'],
    ]);
    expect(posts[1].data).toMatchObject({ node: 'impl', runId: child.runId });
  });
});

describe('an agent node’s result', () => {
  it('names the ASKs it left open', async () => {
    const m = fakeManager(() => 'stuck <new-forum-post title="ASK @user which region?">eu or us</new-forum-post>');
    const kernel = kernelWith(m);
    const run = await kernel.start({
      name: 'a',
      cwd: tmp,
      forum: true,
      nodes: [{ id: 'a', kind: 'agent', prompt: 'x' }],
    });
    const done = await kernel.wait(run.runId);
    expect(done!.nodes.a.output).toMatch(/Open ASKs on the forum: p00001 a: ASK @user which region\?$/);
    expect(done!.nodes.a.data).toEqual({
      forum: { openAsks: [{ id: 'p00001', from: 'a', to: ['user'], title: 'ASK @user which region?' }] },
    });
    expect(m.starts[0]).toMatchObject({ ownerRunId: run.runId });
  });
});
