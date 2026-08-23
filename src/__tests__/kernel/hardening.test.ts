/**
 * Regressions for two defects found by an adversarial review of the first cut,
 * both reproduced before they were fixed.
 *
 *  1. `runId` reached `path.join` unvalidated, and `deleteRunDir` is a recursive
 *     `rmSync` — so `workflow_delete("../x")` removed a directory outside the
 *     store. Reproduced against a real victim directory.
 *  2. A verifier was not a terminal barrier. `prepareSpec` only checked that a
 *     run-level verifier existed somewhere, and the flagship `solve` template
 *     placed the reviewer fan-out *after* it — so a node could edit the tree the
 *     evidence had already signed off while the run still reported `verified`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RunKernel } from '../../kernel/engine.js';
import { registerDefaultExecutors } from '../../kernel/nodes/index.js';
import { createAndAcquire, deleteRunDir, isValidRunId, listRunIds, loadRun, runDir } from '../../kernel/store.js';
import { exec } from '../../kernel/exec.js';
import type { WorkflowSpec } from '../../kernel/types.js';

let tmp: string;
const saved = process.env.CLAWO_WF_DIR;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clawo-harden-'));
  process.env.CLAWO_WF_DIR = path.join(tmp, 'wf');
});

afterEach(() => {
  if (saved === undefined) delete process.env.CLAWO_WF_DIR;
  else process.env.CLAWO_WF_DIR = saved;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('run id validation', () => {
  const traversals = ['../escaped', '../../escaped', 'a/../../escaped', '/tmp/absolute', 'a/b', '..', '.', ''];

  it('rejects every id that is not a single path segment', () => {
    for (const bad of traversals) {
      expect(isValidRunId(bad), bad).toBe(false);
      expect(() => runDir(bad), bad).toThrow(/Invalid run id/);
    }
  });

  it('accepts ordinary ids', () => {
    for (const good of ['wf-abc123', 'my_run.2', 'A1', 'auto-2026-08-23']) {
      expect(isValidRunId(good), good).toBe(true);
      expect(path.dirname(runDir(good))).toBe(path.join(tmp, 'wf'));
    }
  });

  it('does not delete outside the run store', () => {
    const victim = path.join(tmp, 'PRECIOUS');
    fs.mkdirSync(victim, { recursive: true });
    fs.writeFileSync(path.join(victim, 'data.txt'), 'do not delete me');

    expect(() => deleteRunDir('../PRECIOUS')).toThrow(/Invalid run id/);
    expect(fs.existsSync(path.join(victim, 'data.txt'))).toBe(true);
  });

  it('refuses a traversing id at workflow start, before any directory is made', async () => {
    const kernel = new RunKernel();
    await expect(
      kernel.start({ name: 'x', nodes: [{ id: 'a', kind: 'agent', prompt: 'go' }] }, { runId: '../evil' }),
    ).rejects.toThrow(/Invalid run id/);
    expect(fs.existsSync(path.join(tmp, 'evil'))).toBe(false);
  });

  it('refuses to reuse an existing run id rather than overwriting its spec', () => {
    createAndAcquire('dup', { name: 'first', nodes: [] } as WorkflowSpec, 'a');
    expect(() => createAndAcquire('dup', { name: 'second', nodes: [] } as WorkflowSpec, 'b')).toThrow(/already exists/);
    expect(loadRun('dup')?.workflow ?? 'first').toBeTruthy();
  });

  it('treats an unusable id as "no such run" on the read paths, not an exception', () => {
    const kernel = new RunKernel();
    expect(kernel.get('../nope')).toBeUndefined();
    expect(listRunIds()).toEqual([]);
  });
});

describe('the verifier is a terminal barrier', () => {
  let repo: string;

  beforeEach(async () => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'clawo-harden-repo-'));
    await exec('git', ['-C', repo, 'init', '-b', 'main']);
    await exec('git', ['-C', repo, 'config', 'user.email', 't@example.com']);
    await exec('git', ['-C', repo, 'config', 'user.name', 't']);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
    await exec('git', ['-C', repo, 'add', '-A']);
    await exec('git', ['-C', repo, 'commit', '-m', 'base']);
  });

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  const green = { checks: [{ spec: { type: 'command' as const, cmd: 'true' }, required: true }] };

  function kernelThat(mutate: boolean) {
    // Real verifier and router executors; only the agent is stubbed, so the
    // barrier under test is the production one.
    const kernel = registerDefaultExecutors(new RunKernel({ nodeTimeoutMs: 8000 }));
    kernel.setExecutor('agent', async (node) => {
      if (node.id === 'after' && mutate) {
        fs.writeFileSync(path.join(repo, 'SNUCK-IN.txt'), 'written after the evidence\n');
      }
      return { ok: true, output: 'ok' };
    });
    return kernel;
  }

  const specWithTrailingAgent: WorkflowSpec = {
    name: 'barrier',
    cwd: '/replaced-per-test',
    nodes: [
      { id: 'work', kind: 'agent', prompt: 'work' },
      { id: 'verify', kind: 'verifier', contract: 'run' },
      { id: 'after', kind: 'agent', prompt: 'runs after the gate' },
    ],
  };

  it('will not report verified when a later node changed the tree', async () => {
    const kernel = kernelThat(true);
    const rec = await kernel.start({ ...specWithTrailingAgent, cwd: repo }, { cwd: repo, contract: green });
    const done = await kernel.wait(rec.runId);

    expect(fs.existsSync(path.join(repo, 'SNUCK-IN.txt'))).toBe(true);
    expect(done!.outcome).not.toBe('verified');
    expect(done!.outcome).toBe('unverified');
    // Not `refuted`: no check failed. We stopped knowing, and say so.
    expect(done!.outcomeReason).toMatch(/changed afterwards/);
  });

  it('keeps the verdict when the later node changed nothing', async () => {
    const kernel = kernelThat(false);
    const rec = await kernel.start({ ...specWithTrailingAgent, cwd: repo }, { cwd: repo, contract: green });
    const done = await kernel.wait(rec.runId);
    expect(done!.outcome).toBe('verified');
    expect(done!.state).toBe('completed');
  });

  it('keeps the verdict when nothing ran after the verifier at all', async () => {
    const kernel = kernelThat(true);
    const rec = await kernel.start(
      {
        name: 'gate-last',
        cwd: repo,
        nodes: [
          { id: 'work', kind: 'agent', prompt: 'work' },
          { id: 'verify', kind: 'verifier', contract: 'run' },
        ],
      },
      { cwd: repo, contract: green },
    );
    const done = await kernel.wait(rec.runId);
    expect(done!.outcome).toBe('verified');
  });

  it('does not punish a non-git directory when nothing ran after the checks', async () => {
    // A contract that passed in a plain directory passed. Downgrading it for
    // want of a fingerprint would be lying in the other direction.
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'clawo-harden-plain-'));
    try {
      const kernel = kernelThat(false);
      const rec = await kernel.start(
        { name: 'plain', cwd: plain, nodes: [{ id: 'verify', kind: 'verifier', contract: 'run' }] },
        { cwd: plain, contract: green },
      );
      const done = await kernel.wait(rec.runId);
      expect(done!.outcome).toBe('verified');
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }
  });

  it('declines to vouch for a non-git directory once something ran after the checks', async () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'clawo-harden-plain2-'));
    try {
      const kernel = registerDefaultExecutors(new RunKernel({ nodeTimeoutMs: 8000 }));
      kernel.setExecutor('agent', async () => ({ ok: true }));
      const rec = await kernel.start(
        {
          name: 'plain',
          cwd: plain,
          nodes: [
            { id: 'verify', kind: 'verifier', contract: 'run' },
            { id: 'after', kind: 'agent', prompt: 'x' },
          ],
        },
        { cwd: plain, contract: green },
      );
      const done = await kernel.wait(rec.runId);
      expect(done!.outcome).toBe('unverified');
      expect(done!.outcomeReason).toMatch(/not a git repository/);
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }
  });

  it('does not count routers as side effects', async () => {
    const kernel = kernelThat(false);
    const rec = await kernel.start(
      {
        name: 'router-after',
        cwd: repo,
        nodes: [
          { id: 'verify', kind: 'verifier', contract: 'run' },
          { id: 'done', kind: 'router', routes: [] },
        ],
      },
      { cwd: repo, contract: green },
    );
    const done = await kernel.wait(rec.runId);
    expect(done!.outcome).toBe('verified');
  });
});

describe('attempt isolation', () => {
  it('gives each attempt its own session name', async () => {
    // A timed-out attempt is abandoned, not killed, and its `finally` tears down
    // whatever session it named. Sharing the name with the retry meant the dying
    // attempt stopped the live one.
    const names: string[] = [];
    const kernel = new RunKernel({ nodeTimeoutMs: 5000 });
    kernel.setExecutor('agent', async (node, ctx) => {
      names.push(`${ctx.runId}-${node.id}-a${ctx.attempt}`);
      return ctx.attempt < 3 ? { ok: false, error: 'flaky' } : { ok: true };
    });
    const rec = await kernel.start({
      name: 'retry',
      nodes: [{ id: 'a', kind: 'agent', prompt: 'go', retry: { max: 3, backoffMs: 1 } }],
    });
    await kernel.wait(rec.runId);
    expect(new Set(names).size).toBe(names.length);
    expect(names.at(-1)).toMatch(/-a3$/);
  });
});

describe('subflow', () => {
  it('records the child run id so the parent can address it', async () => {
    const kernel = registerDefaultExecutors(new RunKernel({ nodeTimeoutMs: 8000 }));
    kernel.setExecutor('agent', async () => ({ ok: true }));
    const child: WorkflowSpec = { name: 'child', nodes: [{ id: 'c', kind: 'agent', prompt: 'x' }] };
    const rec = await kernel.start({
      name: 'parent',
      nodes: [{ id: 'sub', kind: 'subflow', workflow: child }],
    });
    const done = await kernel.wait(rec.runId);
    const childId = done!.nodes.sub.childRunId;
    expect(childId).toBeTruthy();
    expect(loadRun(childId!)?.workflow).toBe('child');
  });
});
