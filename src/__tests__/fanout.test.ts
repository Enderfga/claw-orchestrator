/**
 * Unit tests for the Fanout runner. Uses a fake SessionManagerLike that records
 * startSession/sendMessage/stopSession calls and returns canned outputs, so the
 * tests assert parallel execution, per-agent failure isolation, synthesis, and
 * session cleanup without spawning any real engine.
 */

import { describe, it, expect, vi } from 'vitest';
import { Fanout, type FanoutConfig } from '../fanout.js';

function makeManager(
  opts: {
    outputs?: Record<string, string>;
    fail?: Set<string>;
  } = {},
) {
  const started: string[] = [];
  const stopped: string[] = [];
  const sent: Array<{ name: string; message: string }> = [];
  const manager = {
    startSession: vi.fn(async (config: { name?: string }) => {
      started.push(config.name!);
      return { name: config.name } as never;
    }),
    sendMessage: vi.fn(async (name: string, message: string) => {
      sent.push({ name, message });
      const agent = name.split('-').pop()!;
      if (opts.fail?.has(agent)) throw new Error(`boom:${agent}`);
      return { output: opts.outputs?.[agent] ?? `out:${agent}`, events: [] } as never;
    }),
    stopSession: vi.fn(async (name: string) => {
      stopped.push(name);
    }),
  };
  return { manager, started, stopped, sent };
}

const baseConfig = (agents: FanoutConfig['agents'], extra: Partial<FanoutConfig> = {}): FanoutConfig => ({
  task: 'do the thing',
  projectDir: '/tmp/proj',
  agents,
  ...extra,
});

describe('Fanout', () => {
  it('runs all agents in parallel and collects their outputs', async () => {
    const { manager, started, stopped } = makeManager({ outputs: { a: 'A', b: 'B' } });
    const fan = new Fanout(
      baseConfig([
        { name: 'a', engine: 'claude' },
        { name: 'b', engine: 'codex' },
      ]),
      manager,
    );
    const session = await fan.run();

    expect(session.status).toBe('done');
    expect(session.results).toHaveLength(2);
    expect(session.results.map((r) => r.output).sort()).toEqual(['A', 'B']);
    expect(session.results.every((r) => r.ok)).toBe(true);
    // Each agent's session was started and stopped.
    expect(started).toHaveLength(2);
    expect(stopped).toHaveLength(2);
  });

  it('uses a per-agent prompt override when provided, else the shared task', async () => {
    const { manager, sent } = makeManager();
    const fan = new Fanout(baseConfig([{ name: 'a', prompt: 'custom prompt' }, { name: 'b' }]), manager);
    await fan.run();
    const byAgent = Object.fromEntries(sent.map((s) => [s.name.split('-').pop(), s.message]));
    expect(byAgent.a).toBe('custom prompt');
    expect(byAgent.b).toBe('do the thing');
  });

  it('isolates a single agent failure without failing the batch', async () => {
    const { manager, stopped } = makeManager({ fail: new Set(['b']) });
    const fan = new Fanout(baseConfig([{ name: 'a' }, { name: 'b' }, { name: 'c' }]), manager);
    const session = await fan.run();

    expect(session.status).toBe('done');
    const b = session.results.find((r) => r.agent === 'b')!;
    expect(b.ok).toBe(false);
    expect(b.error).toContain('boom:b');
    expect(session.results.filter((r) => r.ok)).toHaveLength(2);
    // Failed agent's session is still cleaned up.
    expect(stopped).toHaveLength(3);
  });

  it('runs a synthesis pass over successful results when enabled', async () => {
    const { manager, started } = makeManager({ outputs: { a: 'A', b: 'B', synthesis: 'MERGED' } });
    const fan = new Fanout(baseConfig([{ name: 'a' }, { name: 'b' }], { synthesize: true }), manager);
    const session = await fan.run();
    expect(session.synthesis).toBe('MERGED');
    // 2 agents + 1 synthesis session.
    expect(started).toHaveLength(3);
    expect(started.some((n) => n.endsWith('-synthesis'))).toBe(true);
  });

  it('skips synthesis when fewer than two agents succeed', async () => {
    const { manager } = makeManager({ fail: new Set(['b']) });
    const fan = new Fanout(baseConfig([{ name: 'a' }, { name: 'b' }], { synthesize: true }), manager);
    const session = await fan.run();
    expect(session.synthesis).toBeUndefined();
  });

  it('abort() skips synthesis and leaves status aborted', async () => {
    const { manager } = makeManager({ outputs: { a: 'A', b: 'B', synthesis: 'MERGED' } });
    const fan = new Fanout(baseConfig([{ name: 'a' }, { name: 'b' }], { synthesize: true }), manager);
    fan.abort();
    const session = await fan.run();
    expect(session.status).toBe('aborted');
    expect(session.synthesis).toBeUndefined();
  });

  it('records synthesisError (not silent undefined) when the synthesis pass fails', async () => {
    const { manager } = makeManager({ outputs: { a: 'A', b: 'B' }, fail: new Set(['synthesis']) });
    const fan = new Fanout(baseConfig([{ name: 'a' }, { name: 'b' }], { synthesize: true }), manager);
    const session = await fan.run();
    expect(session.synthesis).toBeUndefined();
    expect(session.synthesisError).toContain('boom:synthesis');
  });
});
