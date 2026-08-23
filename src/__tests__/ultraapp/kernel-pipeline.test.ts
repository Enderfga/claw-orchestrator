/**
 * UltraApp's build pipeline is a kernel run.
 *
 * These are the claims the move was made for, asserted rather than described:
 * the build shows up in the run store like every other workflow, its stages are
 * checkpointed nodes, and a build that died after the council finished does not
 * pay for the council twice.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UltraappManager, ultraappKernelRunId } from '../../ultraapp/manager.js';
import { UltraappStore } from '../../ultraapp/store.js';
import { RunKernel } from '../../kernel/engine.js';
import { registerDefaultExecutors } from '../../kernel/nodes/index.js';
import { acquireLease, commit, loadRun, releaseLease } from '../../kernel/store.js';

const PASSING_BUILD = {
  id: 'test-build',
  checks: [{ id: 'exists', required: true, spec: { type: 'file' as const, path: '.', exists: true } }],
};

function fakeSessionManager() {
  return {
    startSession: vi.fn().mockImplementation(async (cfg: { name?: string }) => ({ name: cfg.name ?? 's' })),
    sendMessage: vi.fn().mockResolvedValue({ output: 'ok' }),
    stopSession: vi.fn().mockResolvedValue(undefined),
  };
}

let tmp: string;
let store: UltraappStore;
let kernel: RunKernel;
let mgr: UltraappManager;
const savedWfDir = process.env.CLAWO_WF_DIR;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ua-kern-'));
  store = new UltraappStore(tmp);
  process.env.CLAWO_WF_DIR = path.join(tmp, 'wf');
  kernel = registerDefaultExecutors(new RunKernel({ nodeTimeoutMs: 20_000 }));
});

afterEach(async () => {
  await mgr?.waitForIdle().catch(() => undefined);
  await kernel.shutdown();
  if (savedWfDir === undefined) delete process.env.CLAWO_WF_DIR;
  else process.env.CLAWO_WF_DIR = savedWfDir;
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Run a build to completion, counting how many times the council actually ran. */
async function buildOnce(): Promise<{ id: string; synthCalls: () => number }> {
  const councilMod = await import('../../ultraapp/council-adapter.js');
  let calls = 0;
  vi.spyOn(councilMod, 'runCouncilSynth').mockImplementation(async ({ runDir }) => {
    calls++;
    const codebase = path.join(runDir, 'versions', 'v1', 'codebase');
    fs.mkdirSync(codebase, { recursive: true });
    return { ok: true, worktreePath: codebase, rounds: 1 };
  });

  mgr = new UltraappManager({
    store,
    sessionManager: fakeSessionManager() as never,
    kernel,
    buildContract: PASSING_BUILD,
  });
  const id = await mgr.createRun();
  await mgr.startBuild(id);
  for (let i = 0; i < 200; i++) {
    const s = await store.readState(id);
    if (s.mode === 'build-complete' || s.mode === 'failed') break;
    await new Promise((r) => setTimeout(r, 20));
  }
  return { id, synthCalls: () => calls };
}

describe('the ultraapp build pipeline is a kernel run', () => {
  it('is listed, checkpointed per stage, and carries the build evidence', async () => {
    const { id } = await buildOnce();
    expect((await store.readState(id)).mode).toBe('build-complete');

    const runId = ultraappKernelRunId(id);
    // Listed alongside every other workflow — it used to be visible nowhere.
    expect(kernel.list().some((r) => r.runId === runId && r.workflow === 'ultraapp')).toBe(true);

    const record = loadRun(runId)!;
    expect(record.nodes.synth.state).toBe('succeeded');
    expect(record.nodes.build.state).toBe('succeeded');
    // The build stage is the ordinary verifier, so it leaves an evidence bundle
    // the same way every other verified run does.
    expect(record.nodes.build.evidenceId).toBeDefined();
    expect(record.outcome).toBe('verified');
  }, 30_000);

  it('a build that died after the council does not run the council again', async () => {
    // The point of the move. Before it, the pipeline had no checkpoint between
    // its stages, so a crash anywhere threw away a finished council — the most
    // expensive thing in the run — and started it from nothing.
    const { id, synthCalls } = await buildOnce();
    expect(synthCalls()).toBe(1);

    const runId = ultraappKernelRunId(id);
    const crashed = loadRun(runId)!;
    crashed.state = 'running';
    crashed.endedAt = undefined;
    crashed.nodes.build.state = 'running';
    const guard = acquireLease(runId, 'crashed-process');
    expect(commit(guard, { record: crashed }).outcome).toBe('committed');
    releaseLease(guard);

    await kernel.resume(runId);
    const done = await kernel.wait(runId);

    expect(done!.state).toBe('completed');
    expect(done!.nodes.synth.state).toBe('succeeded');
    // The council ran once, for the whole life of this run.
    expect(synthCalls()).toBe(1);
  }, 30_000);
});
