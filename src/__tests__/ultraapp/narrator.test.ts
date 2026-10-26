import { describe, it, expect, vi } from 'vitest';
import { Narrator } from '../../ultraapp/narrator.js';
import { resolveAlias } from '../../models.js';

function fakeSessionManager(replies: string[]) {
  let i = 0;
  return {
    startSession: vi.fn().mockImplementation(async (cfg: { name?: string }) => ({ name: cfg.name ?? 'narrator-x' })),
    sendMessage: vi.fn().mockImplementation(async () => ({ output: replies[i++] ?? 'no more' })),
    stopSession: vi.fn().mockResolvedValue(undefined),
  };
}

async function flushMicrotasks() {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

describe('Narrator', () => {
  it('runs on the current Haiku', async () => {
    const sm = fakeSessionManager([]);
    const n = new Narrator({ runId: 'r1', sessionManager: sm as never, language: 'en', onChat: () => {} });
    await n.start();
    await n.stop();
    expect(resolveAlias(sm.startSession.mock.calls[0][0].model)).toBe(resolveAlias('haiku'));
  });

  it('flushes after eventCountThreshold events', async () => {
    const sm = fakeSessionManager(['Build started; agent-A and agent-B are spinning up.']);
    const out: string[] = [];
    const n = new Narrator({
      runId: 'r1',
      sessionManager: sm as never,
      language: 'en',
      onChat: (text) => out.push(text),
      flushIntervalMs: 999999,
      eventCountThreshold: 3,
    });
    await n.start();
    n.push({ type: 'build-start', runId: 'r1' });
    n.push({ type: 'council-round', runId: 'r1', round: 1, agentName: 'agent-A' });
    n.push({ type: 'council-round', runId: 'r1', round: 1, agentName: 'agent-B' });
    await flushMicrotasks();
    expect(out.length).toBe(1);
    expect(out[0]).toContain('agent-A');
    await n.stop();
  });

  it('flushes immediately on build-complete', async () => {
    const sm = fakeSessionManager(['final update']);
    const out: string[] = [];
    const n = new Narrator({
      runId: 'r1',
      sessionManager: sm as never,
      language: 'en',
      onChat: (text) => out.push(text),
      flushIntervalMs: 999999,
      eventCountThreshold: 999,
    });
    await n.start();
    n.push({ type: 'build-start', runId: 'r1' });
    n.push({ type: 'build-complete', runId: 'r1', worktreePath: '/wt' });
    await flushMicrotasks();
    expect(out.length).toBe(1);
    await n.stop();
  });

  it('flushes immediately on build-failed', async () => {
    const sm = fakeSessionManager(['failure update']);
    const out: string[] = [];
    const n = new Narrator({
      runId: 'r1',
      sessionManager: sm as never,
      language: 'en',
      onChat: (text) => out.push(text),
      flushIntervalMs: 999999,
      eventCountThreshold: 999,
    });
    await n.start();
    n.push({ type: 'build-failed', runId: 'r1', phase: 'council', reason: 'no consensus' });
    await flushMicrotasks();
    expect(out.length).toBe(1);
    await n.stop();
  });

  it('falls back to raw event lines if narrator LLM fails', async () => {
    const sm = {
      startSession: vi.fn().mockResolvedValue({ name: 'n' }),
      sendMessage: vi.fn().mockRejectedValue(new Error('llm down')),
      stopSession: vi.fn().mockResolvedValue(undefined),
    };
    const out: string[] = [];
    const n = new Narrator({
      runId: 'r1',
      sessionManager: sm as never,
      language: 'en',
      onChat: (text) => out.push(text),
      flushIntervalMs: 999999,
      eventCountThreshold: 1,
    });
    await n.start();
    n.push({ type: 'build-start', runId: 'r1' });
    await flushMicrotasks();
    expect(out.length).toBe(1);
    expect(out[0]).toMatch(/build-start/);
    await n.stop();
  });

  it('stop() flushes any remaining buffered events', async () => {
    const sm = fakeSessionManager(['final']);
    const out: string[] = [];
    const n = new Narrator({
      runId: 'r1',
      sessionManager: sm as never,
      language: 'en',
      onChat: (text) => out.push(text),
      flushIntervalMs: 999999,
      eventCountThreshold: 999,
    });
    await n.start();
    n.push({ type: 'council-round', runId: 'r1', round: 1, agentName: 'agent-A' });
    expect(out.length).toBe(0);
    await n.stop();
    expect(out.length).toBe(1);
  });

  it('stop() releases the session', async () => {
    const sm = fakeSessionManager(['x']);
    const n = new Narrator({
      runId: 'r1',
      sessionManager: sm as never,
      language: 'en',
      onChat: () => {},
    });
    await n.start();
    await n.stop();
    expect(sm.stopSession).toHaveBeenCalledWith('narrator-r1');
  });

  it('start() spawns a Haiku session with the system prompt', async () => {
    const sm = fakeSessionManager([]);
    const n = new Narrator({
      runId: 'r1',
      sessionManager: sm as never,
      language: 'en',
      onChat: () => {},
    });
    await n.start();
    const cfg = sm.startSession.mock.calls[0][0];
    expect(cfg.name).toBe('narrator-r1');
    expect(cfg.model).toMatch(/haiku/);
    expect(cfg.systemPrompt).toMatch(/narrator/i);
    await n.stop();
  });
});
