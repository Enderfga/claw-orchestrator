/**
 * `council_inject` is refused once the run has moved past its council node:
 * no further round reads the message. A council the run is still on, running
 * or waiting for a resume, takes it.
 *
 * HOME is redirected before the dynamic import because `session-manager.ts`
 * resolves its persisted-session registry from `os.homedir()` at module load.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'clawo-council-inject-home-'));
process.env.HOME = FAKE_HOME;
process.env.USERPROFILE = FAKE_HOME;
const { SessionManager } = await import('../session-manager.js');
const { RunKernel } = await import('../kernel/engine.js');
const { councilWorkflow } = await import('../kernel/templates/index.js');
const { forumPosts } = await import('../kernel/forum.js');
const { acquireLease, commit, loadRun, releaseLease } = await import('../kernel/store.js');
type SessionManager = InstanceType<typeof SessionManager>;

let tmp: string;
let repo: string;
const envKeys = ['CLAWO_RUNS_DIR', 'CLAWO_WF_DIR', 'CLAWO_FORUM_SPOOL_ROOT'] as const;
const saved: Record<string, string | undefined> = {};
let manager: SessionManager;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clawo-council-inject-'));
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
const agents = [{ name: 'alice' }, { name: 'bob' }];
const nodeData = () => ({
  task: TASK,
  responses: [],
  councilStatus: 'awaiting_user',
  agents,
  maxRounds: 3,
  projectDir: repo,
});

describe('council_inject after the council node', () => {
  it('is refused while the run’s verifier runs, and nothing is posted', async () => {
    const other = new RunKernel({ nodeTimeoutMs: 60_000 });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let verifying!: () => void;
    const inVerifier = new Promise<void>((r) => (verifying = r));
    other.setExecutor('council', async (_node, ctx) => {
      const data = nodeData();
      ctx.publish(data);
      return { ok: true, output: 'done', data };
    });
    other.setExecutor('verifier', async () => {
      verifying();
      await gate;
      return { ok: true, output: 'verified' };
    });
    const record = await other.start(
      councilWorkflow({
        task: TASK,
        cwd: repo,
        agents,
        contract: { checks: [{ id: 't', type: 'command', cmd: 'true' }] } as never,
      }),
    );
    await inVerifier;
    expect(loadRun(record.runId)!.nodes.council.state).toBe('succeeded');
    expect(() => manager.councilInject(record.runId, 'please also add a README')).toThrow(
      /council has finished.*no further round reads this/,
    );
    expect(forumPosts(record.runId).filter((p) => p.from === 'user')).toEqual([]);
    release();
    await other.wait(record.runId);
  });

  it('is taken for a council a stopped process left running, which a resume carries on', async () => {
    const other = new RunKernel({ nodeTimeoutMs: 60_000 });
    other.setExecutor('council', async (_node, ctx) => {
      const data = nodeData();
      ctx.publish(data);
      return { ok: true, output: 'done', data };
    });
    const record = await other.start(councilWorkflow({ task: TASK, cwd: repo, agents }));
    await other.wait(record.runId);
    // As a process that stopped mid-council leaves it: the run and its council node running.
    const stopped = loadRun(record.runId)!;
    stopped.state = 'running';
    stopped.endedAt = undefined;
    stopped.nodes.council.state = 'running';
    stopped.nodes.council.endedAt = undefined;
    stopped.currentNode = 'council';
    stopped.suspended = { at: new Date().toISOString(), reason: 'the process running it stopped' };
    const lease = acquireLease(record.runId, 'stopped-process');
    commit(lease, { record: stopped });
    releaseLease(lease);
    expect(manager.councilInject(record.runId, 'use postgres').postId).toMatch(/^p\d+$/);
  });
});
