/**
 * The `acp` engine against a real ACP agent process: the scripted fixture in
 * fixtures/acp-agent.mjs, spoken to over stdio through the SDK, as `kimi acp`
 * or `opencode acp` would be.
 */

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PersistentAcpSession } from '../persistent-acp-session.js';
import { validatePreset, resolveAcpAgent, resolveCustomEngine, _resetEnginePresetCache } from '../engine-presets.js';
import { __rejectCustomEngineOverHttpForTest as rejectOverHttp } from '../embedded-server.js';
import type { AcpAgentConfig, SessionConfig, TurnResult } from '../types.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/acp-agent.mjs', import.meta.url));
const live: PersistentAcpSession[] = [];

function agent(env: Record<string, string> = {}): AcpAgentConfig {
  return { name: 'fixture', command: process.execPath, args: [FIXTURE], env };
}

async function open(over: Partial<SessionConfig> = {}, env: Record<string, string> = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'clawo-acp-'));
  const s = new PersistentAcpSession({ name: 'acp-test', cwd, acpAgent: agent(env), ...over } as SessionConfig);
  live.push(s);
  await s.start();
  return s;
}

const turn = async (s: PersistentAcpSession, text: string, timeout?: number) =>
  (await s.send(text, { waitForComplete: true, timeout })) as TurnResult;

afterEach(() => {
  for (const s of live.splice(0)) s.stop();
});

describe('acp engine', () => {
  it('runs turns on one agent session and keeps its accounting', async () => {
    const s = await open();
    const chunks: string[] = [];
    const first = (await s.send('hello', {
      waitForComplete: true,
      callbacks: { onText: (c) => chunks.push(c) },
    })) as TurnResult;
    const id = s.agentSessionId!;
    expect(first.text).toBe(`echo:hello turn=1 session=${id}`);
    expect(chunks.join('')).toBe(first.text);
    expect(first.event).toMatchObject({ type: 'result', subtype: 'success', stop_reason: 'end_turn' });

    const second = await turn(s, 'again');
    expect(second.text).toContain(`turn=2 session=${id}`);
    const stats = s.getStats();
    expect(stats).toMatchObject({
      turns: 2,
      turnsSucceeded: 2,
      toolCalls: 2,
      toolErrors: 0,
      // Usage is the session's running total, so it is taken, not summed.
      tokensIn: 200,
      tokensOut: 20,
      cachedTokens: 80,
      costUsd: 0.02,
      contextPercent: 10,
      acpSessionId: id,
    });
  });

  it('answers a permission request from the permission mode, without waiting', async () => {
    const allowing = await open({ permissionMode: 'bypassPermissions' });
    expect((await turn(allowing, 'PERMISSION')).text).toContain('permission=yes');
    const planning = await open({ permissionMode: 'plan' });
    expect((await turn(planning, 'PERMISSION')).text).toContain('permission=no');
  });

  it('fails a turn the agent did not end normally, and counts it', async () => {
    const s = await open();
    await expect(turn(s, 'REFUSE')).rejects.toThrow(/stopped the turn: refusal/);
    expect(s.getStats()).toMatchObject({ turns: 1, turnsSucceeded: 0 });
  });

  it('resumes the stored agent session, without counting its replay', async () => {
    const first = await open();
    await turn(first, 'one');
    const id = first.agentSessionId!;
    first.stop();

    const again = await open({ resumeSessionId: id }, { FIXTURE_PRIOR_TURNS: '1' });
    expect(again.agentSessionId).toBe(id);
    const r = await turn(again, 'two');
    expect(r.text).toBe(`echo:two turn=2 session=${id}`);
    expect(again.getStats().toolCalls).toBe(1);
  });

  it('refuses to resume on an agent that cannot load a session, instead of starting a new one', async () => {
    await expect(open({ resumeSessionId: 'fx-old' }, { FIXTURE_LOAD: '0' })).rejects.toThrow(/cannot resume a session/);
  });

  it('fails the turn when the agent process dies, and times a hung turn out', async () => {
    const crashing = await open();
    await expect(turn(crashing, 'CRASH')).rejects.toThrow(/exited/);
    expect(crashing.isReady).toBe(false);
    const slow = await open();
    await expect(turn(slow, 'SLOW', 300)).rejects.toThrow(/Timeout/);
  });

  it('runs the agent under the launcher', async () => {
    const marker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'clawo-acp-l-')), 'launched');
    const launcher = ['/bin/sh', '-c', `touch ${marker}; exec "$@"`, 'launcher'];
    const s = await open({ launcher });
    expect((await turn(s, 'hi')).text).toContain('echo:hi');
    expect(fs.existsSync(marker)).toBe(true);
  });
});

describe('acp presets and the HTTP rule', () => {
  const provenance = { maintainer: 'someone', verifiedAgainst: '1.0.0', verifiedOn: '2026-10-24' };

  it('validates an ACP preset and keeps the two kinds apart', () => {
    const ok = validatePreset(
      {
        id: 'demo-acp',
        tier: 'community',
        description: 'd',
        provenance,
        acp: { name: 'demo', command: 'demo', args: ['acp'] },
      },
      'demo-acp.json',
    );
    expect(ok.acp?.command).toBe('demo');
    expect(() =>
      validatePreset(
        { id: 'demo-acp', tier: 'community', description: 'd', provenance, acp: { name: 'x', command: '/usr/bin/x' } },
        'f',
      ),
    ).toThrow(/command name/);
    expect(() =>
      validatePreset(
        {
          id: 'demo-acp',
          tier: 'community',
          description: 'd',
          provenance,
          acp: { name: 'x', command: 'x' },
          engine: { name: 'x', bin: 'x', args: {} },
        },
        'f',
      ),
    ).toThrow(/exactly one/);
  });

  it('resolves the bundled ACP presets, and neither kind as the other', () => {
    _resetEnginePresetCache();
    expect(resolveAcpAgent('kimi-code')).toMatchObject({ command: 'kimi', args: ['acp'] });
    expect(() => resolveCustomEngine('kimi-code')).toThrow(/ACP agent/);
    expect(() => resolveAcpAgent('zcode')).toThrow(/custom engine/);
  });

  it('refuses an inline acpAgent over HTTP and accepts a preset id', () => {
    expect(rejectOverHttp({ engine: 'acp', acpAgent: { name: 'x', command: 'sh' } })).toMatch(
      /acpAgent may not be given/,
    );
    expect(rejectOverHttp({ engine: 'acp', acpAgent: 'kimi-code' })).toBeNull();
  });
});
