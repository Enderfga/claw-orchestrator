/**
 * `workflow_forum post` from outside the team: the orchestrator (the default)
 * and the user post through the runtime's writer and are vouched for; any other
 * name posts as an agent would.
 *
 * HOME is redirected before the dynamic import, as in session-manager-workflow
 * tests: `session-manager.ts` resolves its persisted state from it at load.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'clawo-wf-forum-home-'));
process.env.HOME = FAKE_HOME;
process.env.USERPROFILE = FAKE_HOME;
const { SessionManager } = await import('../session-manager.js');
const { createForum, forumAuthority, forumRuntimeAppend, forumSnapshot, forumStoreDir } =
  await import('../kernel/forum.js');
type SessionManager = InstanceType<typeof SessionManager>;

let tmp: string;
const envKeys = ['CLAWO_RUNS_DIR', 'CLAWO_WF_DIR', 'CLAWO_FORUM_SPOOL_ROOT'] as const;
const saved: Record<string, string | undefined> = {};
let manager: SessionManager;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clawo-wf-forum-'));
  for (const k of envKeys) saved[k] = process.env[k];
  process.env.CLAWO_RUNS_DIR = path.join(tmp, 'runs');
  process.env.CLAWO_WF_DIR = path.join(tmp, 'wf');
  process.env.CLAWO_FORUM_SPOOL_ROOT = path.join(tmp, 'spool');
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

describe('workflow_forum post', () => {
  it('posts as the orchestrator by default, vouched for and stored, and as an agent under any other name', async () => {
    const kernel = (manager as unknown as { kernel: { setExecutor: (k: string, f: unknown) => void } }).kernel;
    kernel.setExecutor('agent', async () => ({ ok: true }));
    const run = await manager.workflowStart({
      name: 'f',
      cwd: tmp,
      forum: true,
      nodes: [{ id: 'a', kind: 'agent', prompt: 'go' }],
    });
    await (kernel as unknown as { wait: (id: string) => Promise<unknown> }).wait(run.runId);

    const mine = manager.workflowForum({ runId: run.runId, action: 'post', title: 'INFO: the run is done' }) as {
      id: string;
      from: string;
    };
    expect(mine.from).toBe('orchestrator');
    expect(forumAuthority(run.runId, mine as never)).toBe('orchestrator');
    expect(fs.readFileSync(path.join(forumStoreDir(run.runId), 'posts.jsonl'), 'utf8')).toContain(
      'INFO: the run is done',
    );
    const theirs = manager.workflowForum({ runId: run.runId, action: 'post', title: 'WIN: x', as: 'a' }) as {
      from: string;
    };
    expect(forumAuthority(run.runId, theirs as never)).toBe('agent');
    expect(forumSnapshot(run.runId).posts.map((p) => p.from)).toEqual(['orchestrator', 'a']);
  });

  it('posts as the user, answering a post and naming who it is for, with notes for its poster', async () => {
    const kernel = (manager as unknown as { kernel: { setExecutor: (k: string, f: unknown) => void } }).kernel;
    kernel.setExecutor('agent', async () => ({ ok: true }));
    const run = await manager.workflowStart({
      name: 'f',
      cwd: tmp,
      forum: true,
      nodes: [
        { id: 'plan', kind: 'agent', prompt: 'go' },
        { id: 'build', kind: 'agent', prompt: 'go' },
      ],
    });
    await (kernel as unknown as { wait: (id: string) => Promise<unknown> }).wait(run.runId);
    const ask = manager.workflowForum({ runId: run.runId, action: 'post', title: 'INFO: ready', as: 'plan' }) as {
      id: string;
    };
    const answer = manager.workflowForum({
      runId: run.runId,
      action: 'post',
      author: 'user',
      title: 'use the eu region',
      re: [ask.id],
      to: ['plan'],
    }) as { from: string; re: string[]; to: string[]; notes: string[] };
    expect(answer).toMatchObject({ from: 'user', re: [ask.id], to: ['plan'] });
    expect(answer.notes.join('\n')).toMatch(/This post has no tag/);
    expect(forumAuthority(run.runId, answer as never)).toBe('user');
    const list = manager.workflowForum({ runId: run.runId, action: 'list' }) as Array<{
      from: string;
      authority: string;
    }>;
    expect(list.map((p) => [p.from, p.authority])).toEqual([
      ['plan', 'agent'],
      ['user', 'user'],
    ]);
    expect(() =>
      manager.workflowForum({ runId: run.runId, action: 'post', title: 'x', author: 'user', as: 'plan' }),
    ).toThrow(/not both/);
    expect(() => manager.workflowForum({ runId: run.runId, action: 'post', title: 'x', author: 'plan' })).toThrow(
      /author must be orchestrator or user/,
    );
  });

  it('reads the log of a run whose agents are not on a forum, and a forum with no run, and posts to neither', async () => {
    const kernel = (manager as unknown as { kernel: { setExecutor: (k: string, f: unknown) => void } }).kernel;
    let go!: () => void;
    const ready = new Promise<void>((r) => (go = r));
    kernel.setExecutor('agent', async () => {
      await ready;
      return { ok: true };
    });
    const run = await manager.workflowStart({ name: 'f', cwd: tmp, nodes: [{ id: 'a', kind: 'agent', prompt: 'go' }] });
    expect(manager.workflowSteer(run.runId, 'mind the cache')).toEqual({ steered: true });
    go();
    await (kernel as unknown as { wait: (id: string) => Promise<unknown> }).wait(run.runId);
    const list = manager.workflowForum({ runId: run.runId, action: 'list' }) as Array<{
      title: string;
      authority: string;
    }>;
    expect(list).toMatchObject([{ title: 'FIX: mind the cache', authority: 'user' }]);
    expect(() => manager.workflowForum({ runId: run.runId, action: 'post', title: 'INFO: x' })).toThrow(/has no forum/);

    const fm = 'fm-sessions-test';
    createForum(fm, { looseNames: true, team: [{ name: 'alpha one', node: '', mayReturn: true }] });
    forumRuntimeAppend(fm, { from: 'orchestrator', title: 'INFO: hello', to: ['alpha one'] });
    const posts = manager.workflowForum({ runId: fm, action: 'list' }) as Array<{ title: string }>;
    expect(posts.map((p) => p.title)).toEqual(['INFO: hello']);
    expect(manager.workflowForum({ runId: fm, action: 'read', postId: 'p00001' })).toMatchObject({
      title: 'INFO: hello',
    });
    expect(
      (manager.workflowForum({ runId: fm, action: 'metrics' }) as { runtime: { posts: number } }).runtime.posts,
    ).toBe(1);
    expect(() => manager.workflowForum({ runId: fm, action: 'post', title: 'INFO: x' })).toThrow(/session_send_to/);
  });
});
