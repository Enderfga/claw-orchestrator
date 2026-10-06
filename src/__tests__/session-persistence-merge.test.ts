/**
 * Several processes share the persisted-session file: the server, the OpenClaw
 * plugin, and every `clawo-mcp` / `clawo acp` a host starts. Each used to write
 * its whole in-memory map back, so the last process to save erased whatever the
 * others had added since it loaded — a long-lived session's resume record could
 * vanish because an unrelated process exited. Saves now merge only the names a
 * process changed.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawo-persist-merge-'));
process.env.CLAWO_SESSIONS_DIR = dir;
process.env.CLAWO_WF_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'clawo-persist-merge-wf-'));
const file = path.join(dir, 'claude-sessions.json');

const { SessionManager } = await import('../session-manager.js');

/** A manager whose sessions report a resume id, so starting one persists it. */
function manager() {
  const mgr = new SessionManager({ claudeBin: 'mock-claude', maxConcurrentSessions: 5 });
  (mgr as unknown as { _createSession: () => unknown })._createSession = () => {
    const s = new EventEmitter() as EventEmitter & Record<string, unknown>;
    Object.assign(s, {
      sessionId: `sid-${Math.random().toString(36).slice(2)}`,
      isReady: true,
      isPaused: false,
      start: async () => s,
      stop: () => {},
      send: async () => ({ text: 'ok', event: { type: 'result' } }),
      getStats: () => ({
        turns: 0,
        turnsSucceeded: 0,
        toolCalls: 0,
        toolErrors: 0,
        tokensIn: 0,
        tokensOut: 0,
        cachedTokens: 0,
        costUsd: 0,
        isReady: true,
        startTime: '',
        lastActivity: '',
        contextPercent: 0,
        retries: 0,
      }),
      getCost: () => ({
        model: 'm',
        tokensIn: 0,
        tokensOut: 0,
        cachedTokens: 0,
        pricing: { inputPer1M: 0, outputPer1M: 0 },
        breakdown: { inputCost: 0, cachedCost: 0, outputCost: 0 },
        totalUsd: 0,
      }),
      getHistory: () => [],
      compact: async () => ({ text: '', event: { type: 'result' } }),
      getEffort: () => 'auto',
      setEffort: () => {},
      resolveModel: (m: string) => m,
    });
    return s;
  };
  return mgr;
}

const names = () => (JSON.parse(fs.readFileSync(file, 'utf8')) as Array<{ name: string }>).map((e) => e.name).sort();

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('shared persisted-session file', () => {
  it('keeps the other processes’ sessions when one saves or exits', async () => {
    const server = manager();
    const plugin = manager(); // loaded before the server saved anything

    await server.startSession({ name: 'long-lived', cwd: '/tmp' });
    await server.shutdown();
    expect(names()).toEqual(['long-lived']);

    await plugin.startSession({ name: 'short', cwd: '/tmp' });
    await plugin.shutdown();
    expect(names()).toEqual(['long-lived', 'short']);
  });

  it('removes only the session a process stopped', async () => {
    const a = manager();
    const b = manager();
    await a.startSession({ name: 'keep', cwd: '/tmp' });
    await a.shutdown();
    await b.startSession({ name: 'drop', cwd: '/tmp' });
    await b.stopSession('drop');
    await b.shutdown();
    expect(names()).toContain('keep');
    expect(names()).not.toContain('drop');
  });
});
