/**
 * The council tools over the run forum, through SessionManager: `council_inject`
 * is a post that any process can write, and inject, status, abort and review
 * find a run's council node by its kind, not by the name `council_start` gives it.
 *
 * HOME is redirected before the dynamic import because `session-manager.ts`
 * resolves its persisted-session registry from `os.homedir()` at module load.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'clawo-council-forum-home-'));
process.env.HOME = FAKE_HOME;
process.env.USERPROFILE = FAKE_HOME;
const { SessionManager } = await import('../session-manager.js');
const { RunKernel } = await import('../kernel/engine.js');
const { councilWorkflow } = await import('../kernel/templates/index.js');
const { forumAuthority, forumPost, forumPosts, forumRuntimePost, forumSpoolDir } = await import('../kernel/forum.js');
type SessionManager = InstanceType<typeof SessionManager>;

let tmp: string;
let repo: string;
const envKeys = ['CLAWO_RUNS_DIR', 'CLAWO_WF_DIR', 'CLAWO_FORUM_SPOOL_ROOT'] as const;
const saved: Record<string, string | undefined> = {};
let manager: SessionManager;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clawo-council-forum-mgr-'));
  for (const k of envKeys) saved[k] = process.env[k];
  process.env.CLAWO_RUNS_DIR = path.join(tmp, 'runs');
  process.env.CLAWO_WF_DIR = path.join(tmp, 'wf');
  process.env.CLAWO_FORUM_SPOOL_ROOT = path.join(tmp, 'spool');
  repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo);
  execSync('git init -q -b main', { cwd: repo });
  execSync('git config user.email t@t.com && git config user.name T', { cwd: repo });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'hi\n');
  execSync('git add -A && git commit -q -m init', { cwd: repo });
  manager = new SessionManager();
});

afterEach(async () => {
  await manager.shutdown();
  for (const k of envKeys) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k] as string;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

const TASK = 'Build the thing the council was asked to build';
const responses = [
  { agent: 'alice', round: 1, content: 'Alice did it.', consensus: false, sessionKey: 's1', timestamp: '' },
  { agent: 'bob', round: 1, content: 'Bob did it.', consensus: false, sessionKey: 's2', timestamp: '' },
];

/**
 * A `council` template run (its node is `council`, not `main`) running in
 * another process — another kernel — held until `finish`.
 */
async function councilElsewhere() {
  const other = new RunKernel({ nodeTimeoutMs: 60_000 });
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let running!: () => void;
  const started = new Promise<void>((r) => (running = r));
  const data = {
    task: TASK,
    responses,
    councilStatus: 'running',
    agents: [{ name: 'alice' }, { name: 'bob' }],
    maxRounds: 3,
    projectDir: repo,
  };
  other.setExecutor('council', async (_node, ctx) => {
    ctx.publish(data);
    running();
    await gate;
    return { ok: true, output: 'done', data: { ...data, councilStatus: 'awaiting_user' } };
  });
  const record = await other.start(
    councilWorkflow({ task: TASK, cwd: repo, agents: [{ name: 'alice' }, { name: 'bob' }] }),
  );
  await started;
  return {
    runId: record.runId,
    finish: async () => {
      release();
      await other.wait(record.runId);
    },
  };
}

describe('council_inject', () => {
  it('posts to a council running in another process, as the user, and adds up', async () => {
    const run = await councilElsewhere();
    const a = manager.councilInject(run.runId, 'use postgres');
    const b = manager.councilInject(run.runId, 'and keep the API stable');
    expect(a.postId).not.toBe(b.postId);
    const posts = forumPosts(run.runId).filter((p) => p.from === 'user');
    expect(posts.map((p) => p.body)).toEqual(['use postgres', 'and keep the API stable']);
    expect(posts.every((p) => forumAuthority(run.runId, p) === 'user')).toBe(true);
    expect(posts[0].data).toMatchObject({ kind: 'inject', node: 'council' });
    await run.finish();
  });

  it('refuses a council that has finished, an empty message, and a run that is not a council', async () => {
    const run = await councilElsewhere();
    expect(() => manager.councilInject(run.runId, '   ')).toThrow(/empty/);
    await run.finish();
    expect(() => manager.councilInject(run.runId, 'too late')).toThrow(/is completed: it opens no further round/);
    expect(() => manager.councilInject('unknown', 'msg')).toThrow("Council 'unknown' not found");
  });
});

describe('council tools on a run whose council node is not main', () => {
  it('status reads the node the template calls council', async () => {
    const run = await councilElsewhere();
    const session = manager.councilStatus(run.runId)!;
    expect(session.status).toBe('running');
    expect(session.responses.map((r) => r.agent)).toEqual(['alice', 'bob']);
    expect(session.task).toBe(TASK);
    await run.finish();
    expect(manager.councilStatus(run.runId)!.status).toBe('awaiting_user');
  });

  it('getCouncil and abort reach a council live in this process, whatever its node is called', async () => {
    const kernel = (
      manager as unknown as {
        kernel: { setExecutor: (k: string, f: unknown) => void; wait: (id: string) => Promise<{ state: string }> };
      }
    ).kernel;
    const handle = { abort: () => {}, on: () => {}, getSession: () => undefined };
    let aborted = false;
    handle.abort = () => {
      aborted = true;
    };
    kernel.setExecutor(
      'council',
      async (_node: unknown, ctx: { signal: { aborted: boolean }; setHandle: (h: unknown) => void }) => {
        ctx.setHandle(handle);
        while (!ctx.signal.aborted) await new Promise((r) => setTimeout(r, 10));
        return { ok: false, error: 'cancelled' };
      },
    );
    const record = await manager.workflowStart(councilWorkflow({ task: TASK, cwd: repo, agents: [{ name: 'alice' }] }));
    for (let i = 0; i < 100 && !manager.getCouncil(record.runId); i++) await new Promise((r) => setTimeout(r, 10));
    expect(manager.getCouncil(record.runId)).toBe(handle);
    expect(manager.councilAbort(record.runId)).toEqual({ aborted: true });
    expect(aborted).toBe(true);
    expect((await kernel.wait(record.runId)).state).toBe('cancelled');
  });

  it('review adds the reviews the seats posted on the forum', async () => {
    const run = await councilElsewhere();
    const report = (
      await forumRuntimePost(run.runId, {
        from: 'bob',
        title: 'DONE: R1 report — vote NO',
        body: 'Bob did it.',
        via: 'round',
        data: { round: 1, vote: false },
      })
    ).post;
    forumPost(forumSpoolDir(run.runId), 'alice', {
      title: 'WIN: approve @bob — the tests pass',
      body: 'Ran npm test.',
      re: [report.id],
    });
    await run.finish();
    const review = await manager.councilReview(run.runId);
    expect(review.forumReviews).toEqual([
      expect.objectContaining({
        from: 'alice',
        to: ['bob'],
        verdict: 'approve',
        title: 'WIN: approve @bob — the tests pass',
        re: [report.id],
      }),
    ]);
    expect(review.reviews).toEqual([]);
  });
});
