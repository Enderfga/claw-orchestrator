/**
 * Tests for the autoloop notify fallback chain and JSONL log.
 *
 * Strategy: stub `node:child_process.spawn` so we don't actually shell out to
 * openclaw or send any messages. The tests assert which channel the chain
 * picks given different env-var / exit-code combinations.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('node:child_process', () => {
  return {
    spawn: vi.fn(),
  };
});

import * as child_process from 'node:child_process';
import { notifyUserFallbackChain, appendPushLog } from '../autoloop/notify.js';

interface SpawnCall {
  argv: string[];
}
const spawnCalls: SpawnCall[] = [];

function mockChildResult(opts: { exitCode: number; stdout?: string; stderr?: string }): EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: { write: () => void; end: () => void };
  kill: () => void;
} {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    stdin: { write: () => void; end: () => void };
    kill: () => void;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { write: () => undefined, end: () => undefined };
  child.kill = () => undefined;
  process.nextTick(() => {
    if (opts.stdout) child.stdout.emit('data', Buffer.from(opts.stdout));
    if (opts.stderr) child.stderr.emit('data', Buffer.from(opts.stderr));
    child.emit('exit', opts.exitCode);
  });
  return child;
}

function setSpawnSequence(results: Array<{ exitCode: number; stdout?: string; stderr?: string }>): void {
  let idx = 0;
  (child_process.spawn as unknown as ReturnType<typeof vi.fn>).mockImplementation((cmd: string, args: string[]) => {
    spawnCalls.push({ argv: [cmd, ...args] });
    const r = results[idx] ?? { exitCode: 127 };
    idx += 1;
    return mockChildResult(r);
  });
}

const savedEnv = { ...process.env };

beforeEach(() => {
  spawnCalls.length = 0;
  (child_process.spawn as unknown as ReturnType<typeof vi.fn>).mockReset();
});

afterEach(() => {
  process.env = { ...savedEnv };
});

describe('notifyUserFallbackChain', () => {
  it('returns "none" when no channel env vars are set', async () => {
    delete process.env.AUTOLOOP_WECHAT_RECIPIENT;
    delete process.env.AUTOLOOP_WECHAT_ACCOUNT;
    delete process.env.AUTOLOOP_WHATSAPP_RECIPIENT;
    setSpawnSequence([]); // nothing should spawn
    const r = await notifyUserFallbackChain({ level: 'info', summary: 'x', channel: 'auto' });
    // Email script may or may not exist on the machine; allow either none or email.
    expect(['none', 'email']).toContain(r.channel_used);
  });

  it('chooses wechat when env is set and openclaw returns the success marker', async () => {
    process.env.AUTOLOOP_WECHAT_RECIPIENT = 'fake-id';
    process.env.AUTOLOOP_WECHAT_ACCOUNT = 'fake-account';
    setSpawnSequence([{ exitCode: 0, stdout: '✅ Sent\n' }]);
    const r = await notifyUserFallbackChain({ level: 'info', summary: 'x', channel: 'auto' });
    expect(r.channel_used).toBe('wechat');
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].argv[0]).toBe('openclaw');
    expect(spawnCalls[0].argv).toContain('openclaw-weixin');
  });

  it('falls back to whatsapp when wechat fails', async () => {
    process.env.AUTOLOOP_WECHAT_RECIPIENT = 'fake-id';
    process.env.AUTOLOOP_WECHAT_ACCOUNT = 'fake-account';
    process.env.AUTOLOOP_WHATSAPP_RECIPIENT = 'fake-wa';
    setSpawnSequence([
      { exitCode: 1, stderr: 'wechat down' },
      { exitCode: 0, stdout: '✅ Sent\n' },
    ]);
    const r = await notifyUserFallbackChain({ level: 'warn', summary: 'y', channel: 'auto' });
    expect(r.channel_used).toBe('whatsapp');
    expect(spawnCalls).toHaveLength(2);
    expect(spawnCalls[1].argv).toContain('whatsapp');
  });

  it('webchat channel is a no-op (returns none) — kept for forward-compat', async () => {
    const r = await notifyUserFallbackChain({ level: 'info', summary: 'x', channel: 'webchat' });
    expect(r.channel_used).toBe('none');
    expect(spawnCalls).toHaveLength(0);
  });
});

describe('appendPushLog', () => {
  it('appends one JSONL row per call', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoloop-pushlog-'));
    try {
      appendPushLog(dir, {
        ts: '2026-01-01T00:00:00Z',
        level: 'info',
        summary: 's1',
        channel_requested: 'auto',
        channel_used: 'wechat',
      });
      appendPushLog(dir, {
        ts: '2026-01-01T00:00:01Z',
        level: 'warn',
        summary: 's2',
        channel_requested: 'wechat',
        channel_used: 'none',
      });
      const lines = fs
        .readFileSync(path.join(dir, 'push_log.jsonl'), 'utf-8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l));
      expect(lines).toHaveLength(2);
      expect(lines[0].summary).toBe('s1');
      expect(lines[1].channel_used).toBe('none');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
