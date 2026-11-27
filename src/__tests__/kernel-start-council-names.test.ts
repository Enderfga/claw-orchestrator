/**
 * A spec with a forum and a council whose seat names Council accepts
 * (/^[a-zA-Z0-9_-]+$/) but the forum does not (the reserved `user`, a leading
 * `_`) starts: the council's seats are left off the roster, and the council
 * runs log-only, as it does with no forum. Seats with forum names stay on it.
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

import { RunKernel } from '../kernel/engine.js';
import { executeCouncilNode } from '../kernel/nodes/council.js';
import { forumPosts, forumRoster } from '../kernel/forum.js';
import type { WorkflowSpec } from '../kernel/types.js';

let tmp: string;
let repo: string;
const saved = { wf: process.env.CLAWO_WF_DIR, spool: process.env.CLAWO_FORUM_SPOOL_ROOT };
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clawo-start-names-'));
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

function manager() {
  const sent: string[] = [];
  return {
    sent,
    startSession: async (cfg: Record<string, unknown>) => ({
      name: cfg.name as string,
      created: '',
      cwd: '',
      paused: false,
      stats: {},
    }),
    sendMessage: async (_name: string, message: string) => {
      sent.push(message);
      return { output: 'did it. '.repeat(20) + '\n[CONSENSUS: YES]', events: [] };
    },
    stopSession: async () => {},
    deliverMidTurn: async () => false,
  };
}

const spec = (names: string[]): WorkflowSpec =>
  ({
    name: 'with-council',
    forum: {},
    cwd: repo,
    nodes: [
      { id: 'scout', kind: 'agent', prompt: 'look around' },
      {
        id: 'c',
        kind: 'council',
        task: 'Build the thing the council was asked to build',
        agents: names.map((name) => ({ name })),
        projectDir: repo,
        maxRounds: 1,
      },
    ],
  }) as WorkflowSpec;

describe('a forum spec with a council whose seats cannot be forum names', { timeout: 30_000 }, () => {
  it('starts, leaves the seats off the roster, and runs the council log-only', async () => {
    expect(forumRoster(spec(['user', '_bob'])).map((m) => m.name)).toEqual(['scout']);
    expect(forumRoster(spec(['alice', 'bob'])).map((m) => m.name)).toEqual(['scout', 'alice', 'bob']);

    const m = manager();
    const kernel = new RunKernel({ nodeTimeoutMs: 60_000, manager: m as never });
    kernel.setExecutor('agent', async () => ({ ok: true, output: 'scouted' }));
    kernel.setExecutor('council', executeCouncilNode);
    const started = await kernel.start(spec(['user', '_bob']));
    const done = (await kernel.wait(started.runId))!;
    expect(done.state).toBe('completed');
    expect(done.nodes.c.state).toBe('succeeded');
    // Log-only: no seat was briefed as a member, and no round report was posted for one.
    expect(m.sent).toHaveLength(2);
    for (const msg of m.sent) expect(msg).not.toContain('forum --dir');
    expect(forumPosts(started.runId, { via: 'round' })).toEqual([]);
  });

  it('still refuses an agent node named like a reserved forum name', async () => {
    const kernel = new RunKernel({ nodeTimeoutMs: 60_000 });
    await expect(
      kernel.start({ name: 'bad', forum: {}, cwd: repo, nodes: [{ id: 'user', kind: 'agent', prompt: 'p' }] }),
    ).rejects.toThrow(/forum names must be/);
  });
});
