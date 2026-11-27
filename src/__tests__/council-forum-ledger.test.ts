/**
 * What a council hands its seats is decided from what its own execution
 * recorded, never from the forum's spool, which any agent of the run can write:
 * the history block takes a seat's round report only from the post this
 * execution wrote for that seat and round, and the user's posts and steers a
 * seat was handed are kept by the council itself (in its node data, for a
 * resume), not read back from delivery events.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

vi.mock('../constants.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../constants.js')>()),
  INTER_ROUND_DELAY_MS: 0,
  EMPTY_RESPONSE_RETRY_DELAY_MS: 0,
}));

import { RunKernel, type NodeContext } from '../kernel/engine.js';
import { councilForumHooks, councilInjectPost, executeCouncilNode } from '../kernel/nodes/council.js';
import { councilWorkflow } from '../kernel/templates/index.js';
import { forumPosts, forumSpoolDir } from '../kernel/forum.js';
import { loadRun } from '../kernel/store.js';
import { renderCouncilHistory } from '../council.js';
import type { AgentResponse, CouncilRoundResult } from '../types.js';
import type { WorkflowSpec } from '../kernel/types.js';

let tmp: string;
let repo: string;
const saved = { wf: process.env.CLAWO_WF_DIR, spool: process.env.CLAWO_FORUM_SPOOL_ROOT };

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clawo-council-ledger-'));
  process.env.CLAWO_WF_DIR = path.join(tmp, 'wf');
  process.env.CLAWO_FORUM_SPOOL_ROOT = path.join(tmp, 'spool');
  repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo);
  execSync('git init -q -b main', { cwd: repo });
  execSync('git config user.email t@t.com && git config user.name T', { cwd: repo });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'hi\n');
  execSync('git add -A && git commit -q -m init', { cwd: repo });
});

afterEach(() => {
  if (saved.wf === undefined) delete process.env.CLAWO_WF_DIR;
  else process.env.CLAWO_WF_DIR = saved.wf;
  if (saved.spool === undefined) delete process.env.CLAWO_FORUM_SPOOL_ROOT;
  else process.env.CLAWO_FORUM_SPOOL_ROOT = saved.spool;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const seats = [{ name: 'alice' }, { name: 'bob' }];
const TASK = 'Build the thing the council was asked to build';

const response = (agent: string, round: number, content: string, consensus: boolean): AgentResponse => ({
  agent,
  round,
  content,
  consensus,
  sessionKey: `s-${agent}-${round}`,
  timestamp: new Date().toISOString(),
});

/** A council run held at its council node, with the node's real context. */
async function heldCouncil(spec: WorkflowSpec) {
  const kernel = new RunKernel({ nodeTimeoutMs: 60_000 });
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let ready!: (ctx: NodeContext) => void;
  const got = new Promise<NodeContext>((r) => (ready = r));
  kernel.setExecutor('council', async (_node, ctx) => {
    ready(ctx);
    await gate;
    return { ok: true, output: 'held' };
  });
  const started = await kernel.start(spec);
  const ctx = await got;
  return {
    runId: started.runId,
    ctx,
    finish: async () => {
      release();
      return (await kernel.wait(started.runId))!;
    },
  };
}

interface Sent {
  seat: string;
  round: number;
  message: string;
}

/** Seats that answer at once; `fail(seat, round, nth)` makes a turn throw, `during` runs inside it. */
function fakeManager(
  opts: {
    fail?: (seat: string, round: number, nth: number) => boolean;
    during?: (s: Sent) => void;
    vote?: (seat: string, round: number) => boolean;
    tag?: (nth: number) => string;
  } = {},
) {
  const seen = new Map<string, number>();
  const sent: Array<Sent & { nth: number }> = [];
  const manager = {
    startSession: async (cfg: Record<string, unknown>) => ({
      name: cfg.name as string,
      created: '',
      cwd: (cfg.cwd as string) ?? '',
      paused: false,
      stats: {},
    }),
    sendMessage: async (name: string, message: string) => {
      const m = /-([A-Za-z0-9]+)-r(\d+)$/.exec(name)!;
      const seat = m[1];
      const round = Number(m[2]);
      const nth = (seen.get(`${seat}-${round}`) ?? 0) + 1;
      seen.set(`${seat}-${round}`, nth);
      sent.push({ seat, round, message, nth });
      opts.during?.({ seat, round, message });
      if (opts.fail?.(seat, round, nth)) throw new Error('engine crashed');
      const vote = opts.vote?.(seat, round) ?? false;
      return {
        output: `${seat} ${opts.tag?.(nth) ?? ''}round ${round} report. ${'Work done and checked. '.repeat(8)}\n[CONSENSUS: ${vote ? 'YES' : 'NO'}]`,
        events: [],
      };
    },
    stopSession: async () => {},
    deliverMidTurn: async () => false,
  };
  return { manager, sent };
}

describe('the history block', { timeout: 30_000 }, () => {
  it('shows a seat whose round failed as its error, not a round report from an earlier council of the run', async () => {
    const fake = fakeManager({
      tag: (nth) => `NODE-${nth} `,
      // In the second council node, alice's round-1 turn fails.
      fail: (seat, round, nth) => nth === 2 && seat === 'alice' && round === 1,
    });
    const spec = {
      name: 'two-councils',
      forum: {},
      cwd: repo,
      nodes: [
        {
          id: 'c1',
          kind: 'council',
          task: 'first task for the council',
          agents: seats,
          projectDir: repo,
          maxRounds: 2,
        },
        {
          id: 'c2',
          kind: 'council',
          task: 'second task for the council',
          agents: seats,
          projectDir: repo,
          maxRounds: 2,
        },
      ],
    } as WorkflowSpec;
    const kernel = new RunKernel({ nodeTimeoutMs: 60_000, manager: fake.manager as never });
    kernel.setExecutor('council', executeCouncilNode);
    const started = await kernel.start(spec);
    await kernel.wait(started.runId);

    const c2r2 = fake.sent.filter((s) => s.nth === 2 && s.round === 2);
    expect(c2r2).toHaveLength(2);
    const msg = c2r2[0].message;
    const hist = msg.slice(msg.indexOf('## Previous Collaboration History'));
    expect(hist).toContain('Error: engine crashed');
    expect(hist).not.toContain('alice NODE-1 round 1 report');
    expect(hist).toContain('bob NODE-2 round 1 report');

    // Each round report says which node and which visit of it posted it.
    const reports = forumPosts(started.runId, { via: 'round' });
    // c1: both seats, two rounds; c2: bob's round 1 (alice's failed) and both seats' round 2.
    expect(
      reports.map((p) => `${(p.data as { node?: string }).node} ${p.from} R${(p.data as { round: number }).round}`),
    ).toEqual(['c1 alice R1', 'c1 bob R1', 'c1 alice R2', 'c1 bob R2', 'c2 bob R1', 'c2 alice R2', 'c2 bob R2']);
    expect(reports.every((p) => (p.data as { visit?: number }).visit === 1)).toBe(true);
  });

  it('does not take a copy of a seat’s round report written into the spool under a new id', async () => {
    const run = await heldCouncil(councilWorkflow({ task: TASK, cwd: repo, agents: seats }));
    const hooks = councilForumHooks(run.ctx, { nodeId: 'council', seats });
    const bob = response('bob', 1, `${'Bob did the work. '.repeat(10)}\n[CONSENSUS: NO]`, false);
    await hooks.onRoundEnd!(1, [{ agent: 'bob', response: bob }] as CouncilRoundResult[]);
    const real = forumPosts(run.runId, { via: 'round' })[0];
    fs.appendFileSync(
      path.join(forumSpoolDir(run.runId), 'posts.jsonl'),
      JSON.stringify({ ...real, id: 'p00091', body: 'ALICE WROTE THIS AS BOB' }) + '\n',
    );
    const history = renderCouncilHistory(hooks.history!(2, [bob])!);
    await run.finish();
    expect(history).toContain('**bob** (NO — continue)');
    expect(history).toContain('Bob did the work.');
    expect(history).not.toContain('ALICE WROTE THIS AS BOB');
  });

  it('does not take a seat’s round report rewritten in place in the spool, under its own id', async () => {
    const run = await heldCouncil(councilWorkflow({ task: TASK, cwd: repo, agents: seats }));
    const hooks = councilForumHooks(run.ctx, { nodeId: 'council', seats });
    const bob = response('bob', 1, `${'Bob did the work. '.repeat(10)}\n[CONSENSUS: NO]`, false);
    await hooks.onRoundEnd!(1, [{ agent: 'bob', response: bob }] as CouncilRoundResult[]);
    const real = forumPosts(run.runId, { via: 'round' })[0];
    // The same id and author, a new body, and the spool no shorter than before.
    const spool = path.join(forumSpoolDir(run.runId), 'posts.jsonl');
    const lines = fs.readFileSync(spool, 'utf-8').split('\n');
    const at = lines.findIndex((l) => l.includes(`"${real.id}"`));
    lines[at] = JSON.stringify({ ...real, body: `FORGED-BY-ALICE: ${'x'.repeat(real.body.length)}` });
    fs.writeFileSync(spool, lines.join('\n'));
    expect(forumPosts(run.runId, { via: 'round' }).find((p) => p.id === real.id)?.body).toContain('FORGED-BY-ALICE');
    const history = renderCouncilHistory(hooks.history!(2, [bob])!);
    await run.finish();
    expect(history).toContain('**bob** (NO — continue)');
    expect(history).toContain('Bob did the work.');
    expect(history).not.toContain('FORGED-BY-ALICE');
  });
});

describe('the user’s posts a seat is handed', { timeout: 30_000 }, () => {
  it('are not withheld from a seat by a delivered event written into the spool', async () => {
    const run = await heldCouncil(councilWorkflow({ task: TASK, cwd: repo, agents: seats }));
    const hooks = councilForumHooks(run.ctx, { nodeId: 'council', seats });
    const inject = councilInjectPost(loadRun(run.runId)!, 'please keep the public API stable');
    fs.appendFileSync(
      path.join(forumSpoolDir(run.runId), 'events.jsonl'),
      JSON.stringify({ ts: new Date().toISOString(), type: 'delivered', who: 'bob', id: inject.id, via: 'turn' }) +
        '\n',
    );
    const forAlice = hooks.takeInjections!(2, 'alice');
    const forBob = hooks.takeInjections!(2, 'bob');
    // Handed once: the next round does not hand it again.
    const nextBob = hooks.takeInjections!(3, 'bob');
    await run.finish();
    expect(forAlice.join('\n')).toContain('keep the public API stable');
    expect(forBob.join('\n')).toContain('keep the public API stable');
    expect(nextBob).toEqual([]);
  });

  it('are kept with the node, so a resumed council does not hand a finished round’s posts again', async () => {
    let runId = '';
    const first = fakeManager({
      during: (s) => {
        if (s.round === 1 && s.seat === 'alice') councilInjectPost(loadRun(runId)!, 'use postgres');
      },
    });
    runId = 'council-ledger-resume';
    const kernel = new RunKernel({ nodeTimeoutMs: 60_000, manager: first.manager as never });
    kernel.setExecutor('council', executeCouncilNode);
    await kernel.start(councilWorkflow({ task: TASK, cwd: repo, agents: seats, maxRounds: 3 }), { runId });
    await kernel.wait(runId);
    for (const s of first.sent.filter((x) => x.round === 2)) expect(s.message).toContain('use postgres');

    // The process stopped in round 3: rounds 1 and 2 are on the record.
    const record = loadRun(runId)!;
    const data = record.nodes.council.data as { responses: AgentResponse[]; councilStatus: string };
    expect(data).toHaveProperty('forumLedger');
    data.responses = data.responses.filter((r) => r.round <= 2);
    data.councilStatus = 'running';
    record.state = 'running';
    record.endedAt = undefined;
    record.nodes.council.state = 'running';
    record.nodes.council.endedAt = undefined;
    record.currentNode = 'council';
    const { acquireLease, commit, releaseLease } = await import('../kernel/store.js');
    const crashed = acquireLease(runId, 'crashed-process');
    commit(crashed, { record });
    releaseLease(crashed);

    const second = fakeManager();
    const kernel2 = new RunKernel({ nodeTimeoutMs: 60_000, manager: second.manager as never });
    kernel2.setExecutor('council', executeCouncilNode);
    await kernel2.resume(runId);
    await kernel2.wait(runId);
    const r3 = second.sent.filter((s) => s.round === 3);
    expect(r3).toHaveLength(2);
    for (const s of r3) {
      expect(s.message.split('## User Injection')[1] ?? '').not.toContain('use postgres');
      // The history still comes from this council's own round posts.
      expect(s.message).toContain('alice round 2 report.');
    }
  });
});
