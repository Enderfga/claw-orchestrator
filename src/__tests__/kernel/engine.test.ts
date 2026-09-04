/**
 * The run kernel.
 *
 * The assertions that matter most are the honesty ones: a run with no acceptance
 * contract must finish `unverified` rather than claiming success, a run whose
 * contract failed must never reach `completed`, and a contract must never be
 * sourced from an agent's own output.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepareSpec, RunKernel, IMPLICIT_VERIFIER_ID } from '../../kernel/engine.js';
import type { NodeExecutor, NodeResult } from '../../kernel/engine.js';
import { loadRun, readEvents } from '../../kernel/store.js';
import type { WorkflowSpec } from '../../kernel/types.js';

let tmp: string;
const saved = process.env.CLAWO_WF_DIR;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clawo-engine-'));
  process.env.CLAWO_WF_DIR = tmp;
});

afterEach(() => {
  if (saved === undefined) delete process.env.CLAWO_WF_DIR;
  else process.env.CLAWO_WF_DIR = saved;
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** A kernel whose agent nodes just record that they ran. */
function makeKernel(over: Partial<Record<string, NodeExecutor>> = {}, ran: string[] = []) {
  const kernel = new RunKernel({ nodeTimeoutMs: 5000 });
  kernel.setExecutor('agent', async (node) => {
    ran.push(node.id);
    return { ok: true, output: `did ${node.id}` };
  });
  kernel.setExecutor('router', async () => ({ ok: true }));
  kernel.setExecutor('verifier', async () => ({ ok: true, output: 'nothing declared' }));
  for (const [kind, exec] of Object.entries(over)) {
    kernel.setExecutor(kind as never, exec as NodeExecutor);
  }
  return { kernel, ran };
}

const linear: WorkflowSpec = {
  name: 'linear',
  cwd: '/tmp',
  nodes: [
    { id: 'a', kind: 'agent', prompt: 'a' },
    { id: 'b', kind: 'agent', prompt: 'b' },
  ],
};

describe('linear execution', () => {
  it('runs nodes in order and completes', async () => {
    const { kernel, ran } = makeKernel();
    const started = await kernel.start(linear);
    const done = await kernel.wait(started.runId);
    expect(ran).toEqual(['a', 'b']);
    expect(done!.state).toBe('completed');
    expect(done!.nodes.a.state).toBe('succeeded');
  });

  it('checkpoints every transition so a reader sees progress on disk', async () => {
    const { kernel } = makeKernel();
    const started = await kernel.start(linear);
    await kernel.wait(started.runId);
    const events = readEvents(started.runId).map((e) => e.type);
    expect(events[0]).toBe('run_created');
    expect(events).toContain('node_state');
    expect(loadRun(started.runId)!.state).toBe('completed');
  });

  it('fails the run when a node fails and onFailure is the default', async () => {
    const { kernel } = makeKernel({ agent: async () => ({ ok: false, error: 'nope' }) });
    const started = await kernel.start(linear);
    const done = await kernel.wait(started.runId);
    expect(done!.state).toBe('failed');
    expect(done!.error).toContain('nope');
  });

  it('carries on when a node declares onFailure: continue', async () => {
    const ran: string[] = [];
    const kernel = new RunKernel();
    kernel.setExecutor('agent', async (node) => {
      ran.push(node.id);
      return node.id === 'a' ? { ok: false, error: 'soft' } : { ok: true };
    });
    const spec: WorkflowSpec = {
      name: 'soft',
      nodes: [
        { id: 'a', kind: 'agent', prompt: 'a', onFailure: 'continue' },
        { id: 'b', kind: 'agent', prompt: 'b' },
      ],
    };
    const started = await kernel.start(spec);
    const done = await kernel.wait(started.runId);
    expect(ran).toEqual(['a', 'b']);
    expect(done!.nodes.a.state).toBe('failed');
    expect(done!.state).toBe('completed');
  });
});

describe('honesty about verification', () => {
  it('completes a contract-free run as unverified — it does not claim success', async () => {
    const { kernel } = makeKernel();
    const started = await kernel.start(linear);
    const done = await kernel.wait(started.runId);
    expect(done!.state).toBe('completed');
    expect(done!.outcome).toBe('unverified');
    expect(done!.evidenceId).toBeUndefined();
  });

  it('appends an implicit terminal verifier when the workflow declares a contract', () => {
    const prepared = prepareSpec({
      ...linear,
      contract: { checks: [{ spec: { type: 'command', cmd: 'true' }, required: true }] },
    });
    expect(prepared.nodes.at(-1)).toMatchObject({ id: IMPLICIT_VERIFIER_ID, kind: 'verifier', contract: 'run' });
  });

  it('does not append a second verifier when the author placed one', () => {
    const prepared = prepareSpec({
      ...linear,
      contract: { checks: [{ spec: { type: 'command', cmd: 'true' }, required: true }] },
      nodes: [...linear.nodes, { id: 'mine', kind: 'verifier', contract: 'run' }],
    });
    expect(prepared.nodes.filter((n) => n.kind === 'verifier')).toHaveLength(1);
  });

  it('marks a run verified when the contract passes', async () => {
    const { kernel } = makeKernel({
      verifier: async (): Promise<NodeResult> => ({ ok: true, passed: true, evidenceId: 'v-01' }),
    });
    const started = await kernel.start({
      ...linear,
      contract: { checks: [{ spec: { type: 'command', cmd: 'true' }, required: true }] },
    });
    const done = await kernel.wait(started.runId);
    expect(done!.state).toBe('completed');
    expect(done!.outcome).toBe('verified');
    expect(done!.evidenceId).toBe('v-01');
  });

  it('NEVER completes a run whose contract failed, however the agents voted', async () => {
    const { kernel } = makeKernel({
      verifier: async (): Promise<NodeResult> => ({
        ok: false,
        passed: false,
        evidenceId: 'v-01',
        error: 'acceptance contract failed: npm test exited 1',
      }),
    });
    const started = await kernel.start({
      ...linear,
      contract: { checks: [{ spec: { type: 'command', cmd: 'false' }, required: true }] },
    });
    const done = await kernel.wait(started.runId);
    expect(done!.state).toBe('failed');
    expect(done!.state).not.toBe('completed');
    expect(done!.outcome).toBe('refuted');
    expect(done!.error).toContain('npm test');
  });

  it('records consensus votes without letting them decide anything', async () => {
    const { kernel } = makeKernel({
      council: async (): Promise<NodeResult> => ({
        ok: true,
        output: 'done',
        consensusVotes: [{ agent: 'alice', round: 1, vote: true, source: 'strict' }],
      }),
      verifier: async (): Promise<NodeResult> => ({ ok: false, passed: false, evidenceId: 'v-01', error: 'red' }),
    });
    const started = await kernel.start({
      name: 'council-run',
      nodes: [{ id: 'c', kind: 'council', task: 't', agents: [] }],
      contract: { checks: [{ spec: { type: 'command', cmd: 'false' }, required: true }] },
    });
    const done = await kernel.wait(started.runId);
    expect(done!.consensusVotes?.[0]).toMatchObject({ agent: 'alice', vote: true });
    expect(done!.state).toBe('failed');
  });
});

describe('contract provenance', () => {
  it('ignores a contract embedded in agent output', async () => {
    const seen: unknown[] = [];
    const { kernel } = makeKernel({
      agent: async () => ({
        ok: true,
        // An agent trying to declare its own acceptance criteria.
        output: JSON.stringify({ contract: { checks: [{ type: 'command', cmd: 'true' }] } }),
      }),
      verifier: async (_node, ctx) => {
        seen.push(ctx.runContract);
        return { ok: true, output: 'nothing declared' };
      },
    });
    const started = await kernel.start({
      ...linear,
      nodes: [...linear.nodes, { id: 'v', kind: 'verifier', contract: 'run' }],
    });
    const done = await kernel.wait(started.runId);
    expect(seen).toEqual([undefined]);
    expect(done!.outcome).toBe('unverified');
  });

  it('takes the contract from the caller, normalizing it', async () => {
    let received: unknown;
    const { kernel } = makeKernel({
      verifier: async (_node, ctx) => {
        received = ctx.runContract;
        return { ok: true, passed: true, evidenceId: 'v-01' };
      },
    });
    const started = await kernel.start(linear, {
      contract: { checks: [{ type: 'command', cmd: 'npm', args: ['test'], shell: 'rm -rf /' }] },
    });
    await kernel.wait(started.runId);
    expect(received).toMatchObject({ checks: [{ spec: { type: 'command', cmd: 'npm' } }] });
    expect(JSON.stringify(received)).not.toContain('rm -rf');
  });
});

describe('retry and timeout', () => {
  it('retries a failing node up to its limit', async () => {
    let attempts = 0;
    const kernel = new RunKernel();
    kernel.setExecutor('agent', async () => {
      attempts++;
      return attempts < 3 ? { ok: false, error: 'flaky' } : { ok: true };
    });
    const started = await kernel.start({
      name: 'retry',
      nodes: [{ id: 'a', kind: 'agent', prompt: 'a', retry: { max: 3, backoffMs: 1 } }],
    });
    const done = await kernel.wait(started.runId);
    expect(attempts).toBe(3);
    expect(done!.state).toBe('completed');
    expect(done!.nodes.a.attempts).toBe(3);
  });

  it('gives up after the retry limit', async () => {
    let attempts = 0;
    const kernel = new RunKernel();
    kernel.setExecutor('agent', async () => {
      attempts++;
      return { ok: false, error: 'always red' };
    });
    const started = await kernel.start({
      name: 'retry',
      nodes: [{ id: 'a', kind: 'agent', prompt: 'a', retry: { max: 2, backoffMs: 1 } }],
    });
    const done = await kernel.wait(started.runId);
    expect(attempts).toBe(3);
    expect(done!.state).toBe('failed');
  });

  it('fails a node that overruns its timeout instead of waiting forever', async () => {
    const kernel = new RunKernel();
    kernel.setExecutor('agent', () => new Promise(() => undefined));
    const started = await kernel.start({
      name: 'hang',
      nodes: [{ id: 'a', kind: 'agent', prompt: 'a', timeoutMs: 120 }],
    });
    const done = await kernel.wait(started.runId);
    expect(done!.state).toBe('failed');
    expect(done!.nodes.a.error).toContain('timed out');
  });

  it('lets an autoloop node continue past the kernel default timeout', async () => {
    vi.useFakeTimers();
    try {
      let finishAutoloop!: (result: NodeResult) => void;
      const kernel = new RunKernel();
      kernel.setExecutor(
        'autoloop',
        () =>
          new Promise<NodeResult>((resolve) => {
            finishAutoloop = resolve;
          }),
      );
      const started = await kernel.start({
        name: 'long-autoloop',
        nodes: [{ id: 'loop', kind: 'autoloop', workspace: tmp, config: {} }],
      });

      await vi.advanceTimersByTimeAsync(30 * 60_000 + 1);

      expect(loadRun(started.runId)!.nodes.loop.state).toBe('running');
      finishAutoloop({ ok: true });
      await vi.advanceTimersByTimeAsync(0);
      const done = await kernel.wait(started.runId);
      expect(done!.state).toBe('completed');
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports a missing executor rather than silently succeeding', async () => {
    const kernel = new RunKernel();
    const started = await kernel.start({ name: 'x', nodes: [{ id: 'a', kind: 'agent', prompt: 'a' }] });
    const done = await kernel.wait(started.runId);
    expect(done!.state).toBe('failed');
    expect(done!.error).toContain('no executor');
  });
});

describe('router', () => {
  it('loops back on failure and proceeds once green', async () => {
    let attempts = 0;
    const kernel = new RunKernel();
    kernel.setExecutor('agent', async (node) => {
      if (node.id !== 'work') return { ok: true };
      attempts++;
      return attempts < 3 ? { ok: false, error: 'red' } : { ok: true };
    });
    kernel.setExecutor('router', async (node, ctx) => {
      const { evaluateCondition } = await import('../../kernel/conditions.js');
      const r = (node as { routes: Array<{ when: never; to: string }> }).routes.find((x) =>
        evaluateCondition(ctx.record, x.when),
      );
      return { ok: true, goto: r?.to };
    });
    const started = await kernel.start({
      name: 'repair',
      nodes: [
        { id: 'work', kind: 'agent', prompt: 'work', onFailure: 'continue' },
        {
          id: 'gate',
          kind: 'router',
          routes: [{ when: { type: 'node_failed', node: 'work' }, to: 'work' }],
        },
        { id: 'ship', kind: 'agent', prompt: 'ship' },
      ],
    });
    const done = await kernel.wait(started.runId);
    expect(attempts).toBe(3);
    expect(done!.state).toBe('completed');
    expect(done!.nodes.ship.state).toBe('succeeded');
  });

  it('stops an unbounded loop at the visit limit rather than spinning', async () => {
    const kernel = new RunKernel();
    kernel.setExecutor('agent', async () => ({ ok: true }));
    kernel.setExecutor('router', async () => ({ ok: true, goto: 'a' }));
    const started = await kernel.start({
      name: 'spin',
      maxNodeVisits: 4,
      nodes: [
        { id: 'a', kind: 'agent', prompt: 'a' },
        { id: 'loop', kind: 'router', routes: [{ when: { type: 'always' }, to: 'a' }] },
      ],
    });
    const done = await kernel.wait(started.runId);
    expect(done!.state).toBe('failed');
    expect(done!.error).toContain('loop bound');
  });
});

describe('human gate', () => {
  it('parks until approved, then carries on', async () => {
    const ran: string[] = [];
    const { kernel } = makeKernel({}, ran);
    kernel.setExecutor('human_gate', async () => ({ ok: true, awaitHuman: true }));
    const started = await kernel.start({
      name: 'gated',
      nodes: [
        { id: 'a', kind: 'agent', prompt: 'a' },
        { id: 'gate', kind: 'human_gate', prompt: 'ok?' },
        { id: 'b', kind: 'agent', prompt: 'b' },
      ],
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(loadRun(started.runId)!.state).toBe('awaiting_human');
    expect(ran).toEqual(['a']);

    expect(kernel.approve(started.runId, true)).toBe(true);
    const done = await kernel.wait(started.runId);
    expect(ran).toEqual(['a', 'b']);
    expect(done!.state).toBe('completed');
  });

  it('fails the run when the gate is rejected', async () => {
    const { kernel } = makeKernel();
    kernel.setExecutor('human_gate', async () => ({ ok: true, awaitHuman: true }));
    const started = await kernel.start({
      name: 'gated',
      nodes: [{ id: 'gate', kind: 'human_gate', prompt: 'ok?' }],
    });
    await new Promise((r) => setTimeout(r, 30));
    kernel.approve(started.runId, false);
    const done = await kernel.wait(started.runId);
    expect(done!.state).toBe('failed');
    expect(done!.error).toContain('human gate');
  });
});

describe('cancel', () => {
  it('cancels a running node and marks the run cancelled', async () => {
    const kernel = new RunKernel();
    kernel.setExecutor('agent', async (_node, ctx) => {
      for (let i = 0; i < 200; i++) {
        if (ctx.signal.aborted) return { ok: false, error: 'cancelled' };
        await new Promise((r) => setTimeout(r, 5));
      }
      return { ok: true };
    });
    const started = await kernel.start({ name: 'slow', nodes: [{ id: 'a', kind: 'agent', prompt: 'a' }] });
    await new Promise((r) => setTimeout(r, 20));
    expect(kernel.cancel(started.runId)).toBe(true);
    const done = await kernel.wait(started.runId);
    expect(done!.state).toBe('cancelled');
  });

  it('reports false for an unknown run', () => {
    const kernel = new RunKernel();
    expect(kernel.cancel('nope')).toBe(false);
  });
});

describe('resume', () => {
  it('does not re-run nodes that already succeeded', async () => {
    const ran: string[] = [];
    const { kernel } = makeKernel({}, ran);
    const spec: WorkflowSpec = {
      name: 'resumable',
      nodes: [
        { id: 'a', kind: 'agent', prompt: 'a' },
        { id: 'b', kind: 'agent', prompt: 'b' },
        { id: 'c', kind: 'agent', prompt: 'c' },
      ],
    };
    const started = await kernel.start(spec);
    await kernel.wait(started.runId);
    expect(ran).toEqual(['a', 'b', 'c']);

    // Simulate the crash: rewind the checkpoint to mid-run, as a killed process
    // would have left it, and re-attach with a fresh kernel.
    const record = loadRun(started.runId)!;
    record.state = 'running';
    record.endedAt = undefined;
    record.nodes.b.state = 'running';
    record.nodes.c.state = 'pending';
    // No unguarded write exists any more, so the "crashed process" is simulated
    // the way a real one behaves: claim the run, write the checkpoint it died
    // holding, and let the claim go (a lease whose holder is gone is free).
    const { acquireLease, commit, releaseLease } = await import('../../kernel/store.js');
    const crashed = acquireLease(record.runId, 'crashed-process');
    commit(crashed, { record });
    releaseLease(crashed);

    const ran2: string[] = [];
    const { kernel: kernel2 } = makeKernel({}, ran2);
    await kernel2.resume(started.runId);
    const done = await kernel2.wait(started.runId);

    expect(ran2).toEqual(['b', 'c']);
    expect(done!.state).toBe('completed');
  });

  it('retries the node that was in flight, since a half-finished node left no result', async () => {
    const { kernel } = makeKernel();
    const started = await kernel.start(linear);
    await kernel.wait(started.runId);

    const record = loadRun(started.runId)!;
    record.state = 'running';
    record.nodes.b.state = 'running';
    record.nodes.b.attempts = 2;
    // No unguarded write exists any more, so the "crashed process" is simulated
    // the way a real one behaves: claim the run, write the checkpoint it died
    // holding, and let the claim go (a lease whose holder is gone is free).
    const { acquireLease, commit, releaseLease } = await import('../../kernel/store.js');
    const crashed = acquireLease(record.runId, 'crashed-process');
    commit(crashed, { record });
    releaseLease(crashed);

    const ran2: string[] = [];
    const { kernel: kernel2 } = makeKernel({}, ran2);
    await kernel2.resume(started.runId);
    await kernel2.wait(started.runId);
    expect(ran2).toEqual(['b']);
    expect(loadRun(started.runId)!.nodes.b.attempts).toBe(1);
  });

  it('returns a terminal run untouched', async () => {
    const { kernel } = makeKernel();
    const started = await kernel.start(linear);
    await kernel.wait(started.runId);
    const again = await kernel.resume(started.runId);
    expect(again.state).toBe('completed');
  });

  it('throws for an unknown run', async () => {
    const kernel = new RunKernel();
    await expect(kernel.resume('nope')).rejects.toThrow(/not found/);
  });
});

describe('steer', () => {
  it('hands queued text to the next agent node', async () => {
    const prompts: string[] = [];
    const kernel = new RunKernel();
    kernel.setExecutor('agent', async (node, ctx) => {
      const steer = ctx.takeSteer();
      prompts.push([...steer, (node as { prompt: string }).prompt].join(' | '));
      await new Promise((r) => setTimeout(r, 20));
      return { ok: true };
    });
    const started = await kernel.start(linear);
    kernel.steer(started.runId, 'use the other library');
    await kernel.wait(started.runId);
    expect(prompts.some((p) => p.includes('use the other library'))).toBe(true);
  });

  it('reports false for an unknown run', () => {
    expect(new RunKernel().steer('nope', 'x')).toBe(false);
  });
});
