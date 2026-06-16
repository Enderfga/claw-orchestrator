/**
 * Unit tests for PersistentCodexAppServerSession app-server v2 RPCs.
 *
 * Mocks `child_process.spawn` with a JSON-RPC auto-responder: each line written
 * to stdin is parsed and answered on stdout by id. Verifies the exact request
 * payloads for turn/interrupt, thread/fork, thread/rollback, model/list (param
 * shapes confirmed against `codex app-server generate-json-schema`), plus the
 * turn-failure rejection path.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';

const mockSpawn = vi.fn();
vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
  ChildProcess: class {},
}));

const { PersistentCodexAppServerSession } = await import('../persistent-codex-app-session.js');

interface WrittenMsg {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
}

function createMockProc(responder: (msg: WrittenMsg) => Record<string, unknown> | undefined) {
  const written: WrittenMsg[] = [];
  const proc = new EventEmitter() as EventEmitter & {
    stdout: Readable;
    stderr: EventEmitter;
    stdin: { writable: boolean; write: (s: string, cb?: (e?: Error) => void) => boolean };
    kill: ReturnType<typeof vi.fn>;
    pid: number;
    written: WrittenMsg[];
  };
  proc.stdout = new Readable({ read() {} });
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn();
  proc.pid = 7777;
  proc.written = written;
  proc.stdin = {
    writable: true,
    write(s: string, cb?: (e?: Error) => void) {
      for (const line of s.split('\n')) {
        if (!line.trim()) continue;
        const msg = JSON.parse(line) as WrittenMsg;
        written.push(msg);
        const result = responder(msg);
        if (msg.id !== undefined && result !== undefined) {
          proc.stdout.push(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\n');
        }
      }
      cb?.();
      return true;
    },
  };
  return proc;
}

/** Default responder: resolves the start() handshake (initialize + thread/start). */
function defaultResponder(extra?: (msg: WrittenMsg) => Record<string, unknown> | undefined) {
  return (msg: WrittenMsg): Record<string, unknown> | undefined => {
    if (msg.method === 'initialize') return {};
    if (msg.method === 'thread/start') return { thread: { id: 't1' } };
    const e = extra?.(msg);
    if (e !== undefined) return e;
    return {}; // ack anything else so requests resolve
  };
}

async function startSession(proc: ReturnType<typeof createMockProc>) {
  mockSpawn.mockReturnValue(proc);
  const session = new PersistentCodexAppServerSession({ name: 't', cwd: '/tmp', engine: 'codex-app' });
  await session.start();
  return session;
}

describe('PersistentCodexAppServerSession v2 RPCs', () => {
  beforeEach(() => mockSpawn.mockReset());

  it('thread/start handshake captures the thread id', async () => {
    const session = await startSession(createMockProc(defaultResponder()));
    expect(session.codexThreadId).toBe('t1');
  });

  it('interrupt() sends turn/interrupt {threadId,turnId} for the active turn', async () => {
    const proc = createMockProc(defaultResponder());
    const session = await startSession(proc);
    // Simulate an in-flight turn so currentTurnId is populated.
    proc.stdout.push(
      JSON.stringify({ jsonrpc: '2.0', method: 'turn/started', params: { threadId: 't1', turn: { id: 'turn1' } } }) +
        '\n',
    );
    await new Promise((r) => setTimeout(r, 5));
    expect(session.activeTurnId).toBe('turn1');

    const res = await session.interrupt();
    expect(res).toEqual({ interrupted: true });
    const sent = proc.written.find((m) => m.method === 'turn/interrupt');
    expect(sent?.params).toEqual({ threadId: 't1', turnId: 'turn1' });
  });

  it('interrupt() is a no-op when no turn is active', async () => {
    const session = await startSession(createMockProc(defaultResponder()));
    const res = await session.interrupt();
    expect(res).toEqual({ interrupted: false });
  });

  it('forkThread() returns the forked thread id from thread/fork', async () => {
    const proc = createMockProc(
      defaultResponder((m) => (m.method === 'thread/fork' ? { thread: { id: 't2' } } : undefined)),
    );
    const session = await startSession(proc);
    const res = await session.forkThread();
    expect(res).toEqual({ threadId: 't2' });
    const sent = proc.written.find((m) => m.method === 'thread/fork');
    expect(sent?.params).toEqual({ threadId: 't1' });
  });

  it('rollback() sends thread/rollback {threadId,numTurns} and rejects bad counts', async () => {
    const proc = createMockProc(defaultResponder());
    const session = await startSession(proc);
    await session.rollback(3);
    const sent = proc.written.find((m) => m.method === 'thread/rollback');
    expect(sent?.params).toEqual({ threadId: 't1', numTurns: 3 });
    await expect(session.rollback(0)).rejects.toThrow(/positive integer/);
  });

  it('listModels() returns the model/list data array', async () => {
    const proc = createMockProc(
      defaultResponder((m) => (m.method === 'model/list' ? { data: [{ id: 'gpt-5.5' }, { id: 'o3' }] } : undefined)),
    );
    const session = await startSession(proc);
    const models = await session.listModels();
    expect(models).toEqual([{ id: 'gpt-5.5' }, { id: 'o3' }]);
  });

  it('clears the active turn id on completion so interrupt() no-ops when idle', async () => {
    const proc = createMockProc(defaultResponder());
    const session = await startSession(proc);
    const tick = () => new Promise((r) => setTimeout(r, 5));

    proc.stdout.push(
      JSON.stringify({ jsonrpc: '2.0', method: 'turn/started', params: { threadId: 't1', turn: { id: 'turn1' } } }) +
        '\n',
    );
    await tick();
    expect(session.activeTurnId).toBe('turn1');

    proc.stdout.push(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'turn/completed',
        params: { threadId: 't1', turn: { id: 'turn1', status: 'completed' } },
      }) + '\n',
    );
    await tick();
    expect(session.activeTurnId).toBeUndefined();

    const res = await session.interrupt();
    expect(res).toEqual({ interrupted: false });
    expect(proc.written.some((m) => m.method === 'turn/interrupt')).toBe(false);
  });

  it('rejects a send() and increments toolErrors when a turn completes with status failed', async () => {
    const proc = createMockProc(defaultResponder());
    const session = await startSession(proc);
    const p = session.send('do it', { waitForComplete: true });
    // turn/start was acked; now the server reports the turn failed.
    setTimeout(() => {
      proc.stdout.push(
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'turn/completed',
          params: { threadId: 't1', turn: { id: 'turnX', status: 'failed' } },
        }) + '\n',
      );
    }, 5);
    await expect(p).rejects.toThrow(/turn failed/i);
    expect(session.getStats().toolErrors).toBe(1);
  });

  it('steer() falls back to a normal turn when idle (no in-flight turn)', async () => {
    const proc = createMockProc(defaultResponder());
    const session = await startSession(proc);
    const p = session.steer('please also add tests');
    // Idle path issues a normal turn/start; complete it so steer() resolves.
    setTimeout(() => {
      proc.stdout.push(
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'item/completed',
          params: { threadId: 't1', turnId: 'tt', item: { type: 'agentMessage', text: 'done' } },
        }) + '\n',
      );
      proc.stdout.push(
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'turn/completed',
          params: { threadId: 't1', turn: { id: 'tt', status: 'completed' } },
        }) + '\n',
      );
    }, 5);
    const res = await p;
    expect(res.steered).toBe(false);
    expect(res.text).toBe('done');
    // It used turn/start, not turn/steer.
    expect(proc.written.some((m) => m.method === 'turn/steer')).toBe(false);
    expect(proc.written.some((m) => m.method === 'turn/start')).toBe(true);
  });
});
