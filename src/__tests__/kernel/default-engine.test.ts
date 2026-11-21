/**
 * A workflow's engines are fixed when it starts. A node with no engine takes
 * the configured default then, and a resume keeps it even after the default
 * changes: a Codex thread resumed on Claude Code, or a Claude conversation on
 * Codex, would be lost. A record from before engines were written keeps the
 * meaning it had: Claude Code for sessions, Codex for goals.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RunKernel, stampEngines } from '../../kernel/engine.js';
import { registerDefaultExecutors } from '../../kernel/nodes/index.js';
import { acquireLease, commit, loadRun, releaseLease } from '../../kernel/store.js';
import type { WorkflowSpec } from '../../kernel/types.js';

let tmp: string;
const saved = { wf: process.env.CLAWO_WF_DIR, cfg: process.env.CLAWO_CONFIG };

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clawo-default-engine-'));
  process.env.CLAWO_WF_DIR = path.join(tmp, 'wf');
  process.env.CLAWO_CONFIG = path.join(tmp, 'config.json');
});
afterEach(() => {
  for (const [k, v] of [
    ['CLAWO_WF_DIR', saved.wf],
    ['CLAWO_CONFIG', saved.cfg],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

const setDefault = (engine: string) =>
  fs.writeFileSync(process.env.CLAWO_CONFIG!, JSON.stringify({ defaults: { engine } }));

/** A kernel whose agent nodes record the engine they were asked to run on. */
function kernelRecording(seen: string[]) {
  const kernel = registerDefaultExecutors(new RunKernel({ nodeTimeoutMs: 20_000 }));
  kernel.setExecutor('agent', (async (node: { engine?: string }) => {
    seen.push(node.engine ?? 'none');
    return { ok: true };
  }) as never);
  return kernel;
}

const spec = (): WorkflowSpec => ({ name: 'eng', cwd: tmp, nodes: [{ id: 'work', kind: 'agent', prompt: 'x' }] });

describe('engines fixed at start', () => {
  it('writes the configured default into a node with no engine, and keeps it on resume after the default changes', async () => {
    setDefault('codex');
    const seen: string[] = [];
    const k = kernelRecording(seen);
    const run = await k.start(spec());
    await k.wait(run.runId);
    expect(loadRun(run.runId)!.spec.nodes[0]).toMatchObject({ engine: 'codex' });
    expect(seen).toEqual(['codex']);

    // The default moves; the run is resumed from its agent node.
    setDefault('claude');
    const record = loadRun(run.runId)!;
    record.state = 'running';
    record.endedAt = undefined;
    record.execution = undefined;
    record.nodes.work.state = 'running';
    record.currentNode = 'work';
    const g = acquireLease(run.runId, 'crashed');
    commit(g, { record });
    releaseLease(g);
    const k2 = kernelRecording(seen);
    await k2.resume(run.runId);
    await k2.wait(run.runId);
    expect(seen).toEqual(['codex', 'codex']);
  });

  it('gives a record written before engines were fixed what it meant then', () => {
    const legacy: WorkflowSpec = {
      name: 'old',
      cwd: tmp,
      nodes: [
        { id: 'a', kind: 'agent', prompt: 'x' },
        { id: 'g', kind: 'goal', objective: 'y' } as never,
        { id: 'f', kind: 'fanout', prompt: 'z', agents: [{ name: 'one' }, { name: 'two', engine: 'grok' }] } as never,
      ],
    };
    const stamped = stampEngines(legacy, { session: 'claude', goal: () => 'codex' });
    expect(stamped.nodes.map((n) => (n as { engine?: string }).engine)).toEqual(['claude', 'codex', undefined]);
    expect((stamped.nodes[2] as { agents: Array<{ engine?: string }> }).agents.map((a) => a.engine)).toEqual([
      'claude',
      'grok',
    ]);
    // Nothing to stamp: the same spec back.
    expect(stampEngines(stamped, { session: 'agy', goal: () => 'claude' })).toBe(stamped);
  });

  it('refuses a goal with no engine when the default is an engine no goal runs on', async () => {
    setDefault('agy');
    const k = kernelRecording([]);
    await expect(
      k.start({ name: 'g', cwd: tmp, nodes: [{ id: 'g', kind: 'goal', objective: 'do it' } as never] }),
    ).rejects.toThrow(/A goal runs on Claude Code or Codex, and the default engine is agy/);
    // An agent node is fine on agy.
    const run = await k.start(spec());
    expect(loadRun(run.runId)!.spec.nodes[0]).toMatchObject({ engine: 'agy' });
  });
});
