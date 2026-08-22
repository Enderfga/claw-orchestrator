/**
 * Unit tests for PersistentGrokSession.
 *
 * Grok prints one JSON object per `-p` run, so these drive that object through
 * the wrapper and assert what it does with the pieces that are unusual for this
 * engine class: an engine-reported `total_cost_usd`, a resumable `sessionId`,
 * and a refusal to pretend it can enforce read-only.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';

const mockSpawn = vi.fn();
vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

const { PersistentGrokSession } = await import('../persistent-grok-session.js');

function createMockProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: Readable;
    stderr: EventEmitter;
    stdin: { end: ReturnType<typeof vi.fn> };
    kill: ReturnType<typeof vi.fn>;
    pid: number;
  };
  proc.stdout = new Readable({ read() {} });
  proc.stderr = new EventEmitter();
  proc.stdin = { end: vi.fn() };
  proc.kill = vi.fn();
  proc.pid = 4242;
  return proc;
}

let mockProc: ReturnType<typeof createMockProcess>;

function reply(body: Record<string, unknown>, code = 0) {
  mockProc.stdout.push(JSON.stringify(body));
  mockProc.stdout.push(null);
  mockProc.emit('close', code);
}

const OK_RESULT = {
  text: 'PING',
  stopReason: 'end_turn',
  sessionId: '01a02a80-21f6-72e2-b923-fc7113f38fd7',
  usage: { input_tokens: 120, output_tokens: 8, cache_read_input_tokens: 40 },
  total_cost_usd: 0.0125,
};

beforeEach(() => {
  mockProc = createMockProcess();
  mockSpawn.mockReset();
  mockSpawn.mockReturnValue(mockProc);
});

function spawnArgs(): string[] {
  return mockSpawn.mock.calls[0][1] as string[];
}

describe('PersistentGrokSession — flags', () => {
  it('names the vendor-specific binary, never the contested `agent`', async () => {
    const s = new PersistentGrokSession({ name: 't', cwd: '/tmp', permissionMode: 'bypassPermissions' });
    await s.start();
    const p = s.send('hi', { waitForComplete: true });
    setTimeout(() => reply(OK_RESULT), 5);
    await p;
    expect(mockSpawn.mock.calls[0][0]).toBe('grok');
  });

  it('asks for single-turn JSON and passes the cwd', async () => {
    const s = new PersistentGrokSession({ name: 't', cwd: '/tmp', permissionMode: 'bypassPermissions' });
    await s.start();
    const p = s.send('hi', { waitForComplete: true });
    setTimeout(() => reply(OK_RESULT), 5);
    await p;
    const args = spawnArgs();
    expect(args.slice(0, 2)).toEqual(['-p', 'hi']);
    expect(args[args.indexOf('--output-format') + 1]).toBe('json');
    expect(args[args.indexOf('--cwd') + 1]).toBe('/tmp');
  });

  it("maps our `manual` permission mode onto grok's `default`", async () => {
    const s = new PersistentGrokSession({ name: 't', cwd: '/tmp', permissionMode: 'manual' });
    await s.start();
    const p = s.send('hi', { waitForComplete: true });
    setTimeout(() => reply(OK_RESULT), 5);
    await p;
    expect(spawnArgs()[spawnArgs().indexOf('--permission-mode') + 1]).toBe('default');
  });

  it.each(['max', 'xhigh'] as const)("clamps %s effort to grok's ceiling", async (effort) => {
    const s = new PersistentGrokSession({ name: 't', cwd: '/tmp', permissionMode: 'bypassPermissions', effort });
    await s.start();
    const p = s.send('hi', { waitForComplete: true });
    setTimeout(() => reply(OK_RESULT), 5);
    await p;
    expect(spawnArgs()[spawnArgs().indexOf('--effort') + 1]).toBe('high');
  });

  it('omits --effort for auto', async () => {
    const s = new PersistentGrokSession({
      name: 't',
      cwd: '/tmp',
      permissionMode: 'bypassPermissions',
      effort: 'auto',
    });
    await s.start();
    const p = s.send('hi', { waitForComplete: true });
    setTimeout(() => reply(OK_RESULT), 5);
    await p;
    expect(spawnArgs()).not.toContain('--effort');
  });
});

describe('PersistentGrokSession — conversation continuity', () => {
  it('replays the captured sessionId on the next turn', async () => {
    const s = new PersistentGrokSession({ name: 't', cwd: '/tmp', permissionMode: 'bypassPermissions' });
    await s.start();
    const p1 = s.send('one', { waitForComplete: true });
    setTimeout(() => reply(OK_RESULT), 5);
    await p1;
    expect(spawnArgs()).not.toContain('--resume');

    mockProc = createMockProcess();
    mockSpawn.mockReturnValue(mockProc);
    const p2 = s.send('two', { waitForComplete: true });
    setTimeout(() => reply(OK_RESULT), 5);
    await p2;
    const args2 = mockSpawn.mock.calls[1][1] as string[];
    expect(args2[args2.indexOf('--resume') + 1]).toBe(OK_RESULT.sessionId);
  });

  it('refuses to resume from a synthetic wrapper id', async () => {
    // `grok-<ts>-<rand>` is BaseOneShotSession's own identifier, not a grok
    // session. Handing it to --resume would fail the turn or silently start fresh.
    const s = new PersistentGrokSession({
      name: 't',
      cwd: '/tmp',
      permissionMode: 'bypassPermissions',
      resumeSessionId: 'grok-1750000000000-ab12',
    });
    await s.start();
    const p = s.send('hi', { waitForComplete: true });
    setTimeout(() => reply(OK_RESULT), 5);
    await p;
    expect(spawnArgs()).not.toContain('--resume');
  });

  it('accepts a persisted id behind the grok-live- prefix', async () => {
    const s = new PersistentGrokSession({
      name: 't',
      cwd: '/tmp',
      permissionMode: 'bypassPermissions',
      resumeSessionId: `grok-live-${OK_RESULT.sessionId}`,
    });
    await s.start();
    const p = s.send('hi', { waitForComplete: true });
    setTimeout(() => reply(OK_RESULT), 5);
    await p;
    expect(spawnArgs()[spawnArgs().indexOf('--resume') + 1]).toBe(OK_RESULT.sessionId);
  });
});

describe('PersistentGrokSession — accounting', () => {
  it('takes the cost the engine reported instead of pricing it from the registry', async () => {
    const s = new PersistentGrokSession({ name: 't', cwd: '/tmp', permissionMode: 'bypassPermissions' });
    await s.start();
    const p = s.send('hi', { waitForComplete: true });
    setTimeout(() => reply(OK_RESULT), 5);
    await p;
    // 120 in / 8 out at any registry rate is nowhere near $0.0125; the only way
    // to get this number is to have read total_cost_usd.
    expect(s.getStats().costUsd).toBeCloseTo(0.0125, 6);
    expect(s.getCost().totalUsd).toBeCloseTo(0.0125, 6);
  });

  it('accumulates per-turn usage and cost across turns', async () => {
    const s = new PersistentGrokSession({ name: 't', cwd: '/tmp', permissionMode: 'bypassPermissions' });
    await s.start();
    const p1 = s.send('one', { waitForComplete: true });
    setTimeout(() => reply(OK_RESULT), 5);
    await p1;

    mockProc = createMockProcess();
    mockSpawn.mockReturnValue(mockProc);
    const p2 = s.send('two', { waitForComplete: true });
    setTimeout(() => reply({ ...OK_RESULT, usage: { input_tokens: 30, output_tokens: 4 }, total_cost_usd: 0.002 }), 5);
    await p2;

    const st = s.getStats();
    expect(st.tokensIn).toBe(150);
    expect(st.tokensOut).toBe(12);
    expect(st.costUsd).toBeCloseTo(0.0145, 6);
    expect(st.turns).toBe(2);
    expect(st.turnsSucceeded).toBe(2);
  });

  it('never marks a turn estimated — grok always reports usage', async () => {
    const s = new PersistentGrokSession({ name: 't', cwd: '/tmp', permissionMode: 'bypassPermissions' });
    await s.start();
    const p = s.send('hi', { waitForComplete: true });
    setTimeout(() => reply(OK_RESULT), 5);
    await p;
    expect(s.getStats().tokensEstimated).toBe(false);
  });
});

describe('PersistentGrokSession — failure handling', () => {
  it('does not count a turn the engine reported as errored', async () => {
    const s = new PersistentGrokSession({ name: 't', cwd: '/tmp', permissionMode: 'bypassPermissions' });
    await s.start();
    const p = s.send('hi', { waitForComplete: true });
    setTimeout(() => reply({ ...OK_RESULT, stopReason: 'error' }), 5);
    await p;
    const st = s.getStats();
    expect(st.turns).toBe(1);
    expect(st.turnsSucceeded).toBe(0);
  });

  it('rejects when no JSON result was produced, whatever the exit code', async () => {
    const s = new PersistentGrokSession({ name: 't', cwd: '/tmp', permissionMode: 'bypassPermissions' });
    await s.start();
    const p = s.send('hi', { waitForComplete: true });
    setTimeout(() => {
      mockProc.stdout.push(null);
      mockProc.emit('close', 0);
    }, 5);
    await expect(p).rejects.toThrow(/no JSON result/);
  });

  it('surfaces the error field from the result object', async () => {
    const s = new PersistentGrokSession({ name: 't', cwd: '/tmp', permissionMode: 'bypassPermissions' });
    await s.start();
    const p = s.send('hi', { waitForComplete: true });
    setTimeout(() => reply({ error: 'model unavailable' }, 1), 5);
    await expect(p).rejects.toThrow('model unavailable');
  });

  it('refuses read-only rather than running writable under a read-only label', async () => {
    const s = new PersistentGrokSession({
      name: 't',
      cwd: '/tmp',
      permissionMode: 'bypassPermissions',
      sandboxMode: 'read-only',
    });
    await s.start();
    await expect(s.send('hi', { waitForComplete: true })).rejects.toThrow(/do not support sandboxMode: read-only/);
    expect(mockSpawn).not.toHaveBeenCalled();
  });
});
