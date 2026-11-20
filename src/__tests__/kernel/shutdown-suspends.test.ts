/**
 * A process that stops is not a caller that cancels.
 *
 * `clawo serve` stops on SIGTERM and SIGINT: a host reboot, a service restart,
 * an upgrade, Ctrl-C. None of those is a decision about the run, and a run the
 * shutdown marked `cancelled` was terminal, so the resume that was supposed to
 * bring it back returned it unchanged. These pin that a shutdown leaves each
 * live run where a crash would — non-terminal, its running node marked as
 * interrupted on the next resume — says so on the record, and hands the claim
 * back so the next process can take it at once.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RunKernel, type NodeExecutor } from '../../kernel/engine.js';
import { registerDefaultExecutors } from '../../kernel/nodes/index.js';
import { loadRun, readLease } from '../../kernel/store.js';
import { runReport, toCouncilSession, toFanoutSession } from '../../kernel/projections.js';
import type { WorkflowSpec } from '../../kernel/types.js';

let tmp: string;
const saved = process.env.CLAWO_WF_DIR;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clawo-shutdown-'));
  process.env.CLAWO_WF_DIR = path.join(tmp, 'wf');
});

afterEach(() => {
  if (saved === undefined) delete process.env.CLAWO_WF_DIR;
  else process.env.CLAWO_WF_DIR = saved;
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** An agent node that works until it is told to stop, as a long turn does. */
const untilAborted: NodeExecutor = async (_node, ctx) => {
  while (!ctx.signal.aborted) await new Promise((r) => setTimeout(r, 5));
  return { ok: false, error: 'cancelled' } as never;
};

const kernelWith = (agent: NodeExecutor) => {
  const kernel = registerDefaultExecutors(new RunKernel({ nodeTimeoutMs: 20_000 }));
  kernel.setExecutor('agent', agent);
  return kernel;
};

const spec = (): WorkflowSpec => ({
  name: 'long',
  cwd: tmp,
  contract: { checks: [{ type: 'command', cmd: 'true' }] } as never,
  nodes: [{ id: 'work', kind: 'agent', prompt: 'do it' }],
});

async function runningInWork(kernel: RunKernel): Promise<string> {
  const run = await kernel.start(spec());
  for (let i = 0; i < 200 && loadRun(run.runId)?.nodes.work.state !== 'running'; i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  expect(loadRun(run.runId)?.nodes.work.state).toBe('running');
  return run.runId;
}

describe('a kernel that shuts down', () => {
  it('leaves a live run resumable, not cancelled, and says it was suspended', async () => {
    const kernel = kernelWith(untilAborted);
    const runId = await runningInWork(kernel);

    await kernel.shutdown();

    const after = loadRun(runId)!;
    expect(after.state).toBe('running');
    expect(after.execution).toBeUndefined();
    expect(after.endedAt).toBeUndefined();
    expect(after.nodes.work.state).toBe('running');
    expect(after.suspended?.reason).toMatch(/stopped/);
    expect(runReport(after).execution).toBe('suspended');
    // The claim is handed back: the next process does not wait out the lease.
    expect(readLease(runId)).toBeUndefined();
  });

  it('is resumed by the next process like a crash: the node is interrupted and runs again, and the run verifies', async () => {
    const first = kernelWith(untilAborted);
    const runId = await runningInWork(first);
    await first.shutdown();

    const second = kernelWith(async () => ({ ok: true }) as never);
    await second.resume(runId);
    const done = (await second.wait(runId))!;
    expect(done.state).toBe('completed');
    expect(done.outcome).toBe('verified');
    expect(done.execution).toBe('completed');
    expect(done.suspended).toBeUndefined();
    expect(done.resumes!.at(-1)!.interruptedNodes).toEqual(['work']);
  });

  it('says so in the mode statuses, which read `running` for a run nobody is running', async () => {
    const kernel = kernelWith(untilAborted);
    const runId = await runningInWork(kernel);
    await kernel.shutdown();
    const suspended = loadRun(runId)!;
    expect(toFanoutSession(suspended)).toMatchObject({ status: 'running', suspended: suspended.suspended });
    expect(toCouncilSession(suspended).suspended).toEqual(suspended.suspended);
    const ended = { ...suspended, state: 'cancelled' as const };
    expect(toFanoutSession(ended).suspended).toBeUndefined();
  });

  it('still cancels a run a caller cancels', async () => {
    const kernel = kernelWith(untilAborted);
    const runId = await runningInWork(kernel);
    kernel.cancel(runId);
    const done = (await kernel.wait(runId))!;
    expect(done.state).toBe('cancelled');
    expect(done.execution).toBe('cancelled');
    expect(done.suspended).toBeUndefined();
  });
});
