/**
 * Grok Build's long-lived ACP route: the `grok` preset, and the extension that
 * turns grok's `turn_completed` notifications into turn usage and engine turns.
 * Driven against a scripted agent (fixtures/grok-acp-agent.mjs) that speaks the
 * way `grok agent stdio` 1.0.92 was measured to.
 */

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PersistentAcpSession } from '../persistent-acp-session.js';
import { grokTurnEnd } from '../grok-acp-extension.js';
import { resolveAcpAgent, _resetEnginePresetCache } from '../engine-presets.js';
import { SESSION_EVENT } from '../constants.js';
import type { SessionConfig, TurnResult } from '../types.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/grok-acp-agent.mjs', import.meta.url));
const live: PersistentAcpSession[] = [];

async function open(extension: string | null = 'grok') {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'clawo-grok-acp-'));
  const s = new PersistentAcpSession({
    name: 'grok-acp',
    cwd,
    acpAgent: { name: 'grok-fixture', command: process.execPath, args: [FIXTURE], ...(extension ? { extension } : {}) },
  } as SessionConfig);
  live.push(s);
  await s.start();
  return s;
}

const turn = async (s: PersistentAcpSession, text: string) =>
  (await s.send(text, { waitForComplete: true })) as TurnResult;

function nextEngineTurn(s: PersistentAcpSession): Promise<{ text: string; event: Record<string, unknown> }> {
  return new Promise((resolve) => s.once(SESSION_EVENT.UNSOLICITED_RESULT, (r) => resolve(r as never)));
}

afterEach(() => {
  for (const s of live.splice(0)) s.stop();
});

describe('grok ACP route', () => {
  it('ships a grok preset that starts `grok agent stdio` with the grok extension', () => {
    _resetEnginePresetCache();
    expect(resolveAcpAgent('grok')).toMatchObject({
      command: 'grok',
      commandEnv: 'GROK_BIN',
      args: ['agent', 'stdio'],
      extension: 'grok',
    });
  });

  it("bills each turn from grok's turn report, which the prompt response leaves out", async () => {
    const s = await open();
    const r = await turn(s, 'hello');
    expect(r.text).toBe('echo:hello');
    const stats = s.getStats();
    expect(stats).toMatchObject({ turns: 1, turnsSucceeded: 1, tokensIn: 1000, tokensOut: 10, cachedTokens: 250 });
    expect(stats.costUsd).toBeCloseTo(0.01, 6);
  });

  it('bills nothing without the extension: grok sends no standard usage', async () => {
    const s = await open(null);
    await turn(s, 'hello');
    expect(s.getStats()).toMatchObject({ tokensIn: 0, costUsd: 0 });
  });

  it("delivers a turn grok started itself as an engine turn, and not a subagent's", async () => {
    const s = await open();
    const engine = nextEngineTurn(s);
    const r = await turn(s, '/deep-research BACKGROUND');
    expect(r.text).toBe('echo:/deep-research BACKGROUND');
    const late = await engine;
    expect(late.text).toBe('workflow report');
    expect(late.event).toMatchObject({ type: 'result', is_error: false, stop_reason: 'end_turn' });
    const stats = s.getStats();
    // The engine turn is billed, the subagent's report (another session) is not, and neither is a turn of ours.
    expect(stats.costUsd).toBeCloseTo(0.01 + 0.05, 6);
    expect(stats.turns).toBe(1);
    // The next prompt's text is its own.
    expect((await turn(s, 'again')).text).toBe('echo:again');
  });

  it('reports a refused engine turn as failed, with grok’s reason', async () => {
    const s = await open();
    const engine = nextEngineTurn(s);
    await turn(s, 'BACKGROUND_FAIL');
    const late = await engine;
    expect(late.event).toMatchObject({ is_error: true, stop_reason: 'error' });
    expect(late.text).toMatch(/429 Too Many Requests/);
  });

  it('refuses an extension nothing registered', () => {
    expect(
      () =>
        new PersistentAcpSession({
          name: 'x',
          cwd: os.tmpdir(),
          acpAgent: { name: 'x', command: 'x', extension: 'nope' },
        } as SessionConfig),
    ).toThrow(/unknown extension 'nope'/);
  });

  it("reads grok's turn_completed notification", () => {
    expect(
      grokTurnEnd({
        sessionId: 's',
        update: {
          sessionUpdate: 'turn_completed',
          prompt_id: 'p',
          stop_reason: 'end_turn',
          usage: { inputTokens: 35891, outputTokens: 302, cachedReadTokens: 2176, costUsdTicks: 703300000 },
        },
      }),
    ).toEqual({
      sessionId: 's',
      stopReason: 'end_turn',
      usage: { inputTokens: 35891, outputTokens: 302, cachedReadTokens: 2176, costUsd: 0.07033 },
    });
    expect(
      grokTurnEnd({
        sessionId: 's',
        update: { sessionUpdate: 'turn_completed', stop_reason: 'rate_limit', error: { message: 'Rate limited' } },
      }),
    ).toEqual({ sessionId: 's', stopReason: 'rate_limit', error: 'Rate limited' });
    expect(grokTurnEnd({ sessionId: 's', update: { sessionUpdate: 'workflow_updated' } })).toBeUndefined();
    expect(grokTurnEnd(undefined)).toBeUndefined();
  });
});
