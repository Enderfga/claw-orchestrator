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
vi.mock('../engine-spawn.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../engine-spawn.js')>()),
  spawnEngine: (...args: unknown[]) => mockSpawn(...args),
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
    stdin: EventEmitter & { writable: boolean; write: (s: string, cb?: (e?: Error) => void) => boolean };
    kill: ReturnType<typeof vi.fn>;
    pid: number;
    written: WrittenMsg[];
  };
  proc.stdout = new Readable({ read() {} });
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn();
  proc.pid = 7777;
  proc.written = written;
  proc.stdin = Object.assign(new EventEmitter(), {
    writable: true,
    write(s: string, cb?: (e?: Error) => void) {
      for (const line of s.split('\n')) {
        if (!line.trim()) continue;
        const msg = JSON.parse(line) as WrittenMsg;
        written.push(msg);
        const result = responder(msg);
        if (msg.id !== undefined && result !== undefined) {
          // A responder returning { __rpcError: 'msg' } simulates a JSON-RPC error frame.
          if (result && typeof result === 'object' && '__rpcError' in result) {
            const message = (result as { __rpcError: string }).__rpcError;
            proc.stdout.push(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message } }) + '\n');
          } else {
            proc.stdout.push(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\n');
          }
        }
      }
      cb?.();
      return true;
    },
  });
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

  it('redacts secrets from app-server stderr in its log lines', async () => {
    const proc = createMockProc(defaultResponder());
    const session = await startSession(proc);
    const logs: string[] = [];
    session.on('log', (line: string) => logs.push(line));
    proc.stderr.emit('data', Buffer.from('OPENAI_API_KEY=sk-live-0123456789abcdef\n'));
    expect(logs.join('')).toContain('OPENAI_API_KEY=***');
    expect(logs.join('')).not.toContain('0123456789abcdef');
  });

  // Inside OpenClaw the session runs in the gateway process. A spawn that fails
  // (codex not on the gateway's PATH) emits 'error', and with no listener that
  // ended the gateway; it must fail the start instead.
  it('fails the start, rather than the process, when codex cannot be spawned', async () => {
    const proc = createMockProc(() => undefined);
    mockSpawn.mockReturnValue(proc);
    const session = new PersistentCodexAppServerSession({ name: 't', cwd: '/tmp', engine: 'codex-app' });
    const started = session.start();
    const enoent = Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' });
    proc.emit('error', enoent);
    await expect(started).rejects.toThrow(/ENOENT/);
    expect(session.isReady).toBe(false);
    // A dying process's stdin raises its own 'error'; that must be heard too.
    expect(() => proc.stdin.emit('error', new Error('write EPIPE'))).not.toThrow();
  });

  it('thread/start handshake captures the thread id', async () => {
    const session = await startSession(createMockProc(defaultResponder()));
    expect(session.codexThreadId).toBe('t1');
  });

  // With no model param the app-server runs the model in ~/.codex/config.toml
  // and names it in the thread/start response; bill that, not the default.
  it('prices a thread with no model as the model thread/start reports', async () => {
    const proc = createMockProc((msg) => {
      if (msg.method === 'initialize') return {};
      if (msg.method === 'thread/start') return { thread: { id: 't1' }, model: 'gpt-6-astra' };
      return {};
    });
    const session = await startSession(proc);
    const cost = session.getCost();
    expect(cost.model).toBe('gpt-6-astra');
    expect(cost.pricing.inputPer1M).toBe(10);
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

  // codex 0.171 removed `thread/rollback` ("unknown variant"). Its replacement
  // reverts to before a named turn, so the wrapper lists the newest N turns and
  // reverts to before the oldest of them. Measured on 0.171.0: two turns, list
  // 1 newest, revert before it, and `thread/turns/list` shows the first turn only.
  it('rollback() lists the newest N turns and reverts to before the oldest of them', async () => {
    const proc = createMockProc(
      defaultResponder((m) =>
        m.method === 'thread/turns/list'
          ? { data: [{ id: 'turn-c' }, { id: 'turn-b' }, { id: 'turn-a' }].slice(0, Number(m.params?.limit)) }
          : undefined,
      ),
    );
    const session = await startSession(proc);
    await session.rollback(2);
    const list = proc.written.find((m) => m.method === 'thread/turns/list');
    expect(list?.params).toEqual({ threadId: 't1', limit: 2, sortDirection: 'desc', itemsView: 'summary' });
    const revert = proc.written.find((m) => m.method === 'thread/revert');
    expect(revert?.params).toEqual({ threadId: 't1', beforeTurnId: 'turn-b' });
    expect(proc.written.some((m) => m.method === 'thread/rollback')).toBe(false);
    await expect(session.rollback(0)).rejects.toThrow(/positive integer/);
  });

  it('rollback() follows the cursor when a page holds fewer turns than asked for', async () => {
    const proc = createMockProc(
      defaultResponder((m) => {
        if (m.method !== 'thread/turns/list') return undefined;
        return m.params?.cursor === 'page2'
          ? { data: [{ id: 'turn-a' }], nextCursor: null }
          : { data: [{ id: 'turn-c' }, { id: 'turn-b' }], nextCursor: 'page2' };
      }),
    );
    const session = await startSession(proc);
    await session.rollback(3);
    const lists = proc.written.filter((m) => m.method === 'thread/turns/list');
    expect(lists.map((m) => m.params?.limit)).toEqual([3, 1]);
    expect(lists[1].params?.cursor).toBe('page2');
    expect(proc.written.find((m) => m.method === 'thread/revert')?.params).toEqual({
      threadId: 't1',
      beforeTurnId: 'turn-a',
    });
  });

  it('rollback() refuses to drop more turns than the thread has, and reverts nothing', async () => {
    const proc = createMockProc(
      defaultResponder((m) =>
        m.method === 'thread/turns/list' ? { data: [{ id: 'only' }], nextCursor: null } : undefined,
      ),
    );
    const session = await startSession(proc);
    await expect(session.rollback(2)).rejects.toThrow(/1 turn/);
    expect(proc.written.some((m) => m.method === 'thread/revert')).toBe(false);
  });

  it('rollback() refuses while a turn is in flight', async () => {
    const proc = createMockProc(defaultResponder());
    const session = await startSession(proc);
    proc.stdout.push(
      JSON.stringify({ jsonrpc: '2.0', method: 'turn/started', params: { threadId: 't1', turn: { id: 'live' } } }) +
        '\n',
    );
    await new Promise((r) => setTimeout(r, 5));
    await expect(session.rollback(1)).rejects.toThrow(/in flight/);
    expect(proc.written.some((m) => m.method === 'thread/turns/list')).toBe(false);
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

  // Codex's image generation reports each saved file as an imageGeneration item.
  it('attaches the images a turn generated to its result, and only that turn', async () => {
    const proc = createMockProc(defaultResponder());
    const session = await startSession(proc);
    const push = (method: string, params: Record<string, unknown>) =>
      proc.stdout.push(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');

    const first = session.send('draw a circle', { waitForComplete: true });
    setTimeout(() => {
      push('item/completed', {
        threadId: 't1',
        turnId: 'a',
        item: { type: 'imageGeneration', id: 'ig1', savedPath: '/img/one.png', revisedPrompt: 'a blue circle' },
      });
      push('item/completed', { threadId: 't1', turnId: 'a', item: { type: 'agentMessage', text: 'done' } });
      push('turn/completed', { threadId: 't1', turn: { id: 'a', status: 'completed' } });
    }, 5);
    const r1 = (await first) as { event: Record<string, unknown> };
    expect(r1.event.generated_images).toEqual([{ path: '/img/one.png', revisedPrompt: 'a blue circle' }]);

    const second = session.send('thanks', { waitForComplete: true });
    setTimeout(() => {
      push('item/completed', { threadId: 't1', turnId: 'b', item: { type: 'agentMessage', text: 'ok' } });
      push('turn/completed', { threadId: 't1', turn: { id: 'b', status: 'completed' } });
    }, 5);
    const r2 = (await second) as { event: Record<string, unknown> };
    expect(r2.event.generated_images).toBeUndefined();
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
    // The notification counts the turn and reports that it failed, in the same payload.
    expect(session.getStats().turns).toBe(1);
    expect(session.getStats().turnsSucceeded).toBe(0);
  });

  // The engine's TurnStatus is `completed | interrupted | failed | inProgress`, and
  // `interrupt()` on this class produces `interrupted` on purpose. Testing for the
  // absence of `failed` counted a cancelled turn as a success.
  it('does not count an interrupted turn as succeeded, and counts a completed one', async () => {
    const proc = createMockProc(defaultResponder());
    const session = await startSession(proc);

    const p1 = session.send('do it', { waitForComplete: true });
    setTimeout(() => {
      proc.stdout.push(
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'turn/completed',
          params: { threadId: 't1', turn: { id: 'turnI', status: 'interrupted' } },
        }) + '\n',
      );
    }, 5);
    await p1.catch(() => undefined);
    expect(session.getStats().turns).toBe(1);
    expect(session.getStats().turnsSucceeded).toBe(0);

    const p2 = session.send('do it again', { waitForComplete: true });
    setTimeout(() => {
      proc.stdout.push(
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'turn/completed',
          params: { threadId: 't1', turn: { id: 'turnC', status: 'completed' } },
        }) + '\n',
      );
    }, 5);
    await p2;
    expect(session.getStats().turns).toBe(2);
    expect(session.getStats().turnsSucceeded).toBe(1);
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

  // Without `sourceKinds` the server lists interactive threads only; threads
  // that `codex exec` (source `exec`) started are left out (0.171.0).
  it('listThreads() sends thread/list with filters and every source kind, and returns data + nextCursor', async () => {
    const proc = createMockProc(
      defaultResponder((m) =>
        m.method === 'thread/list' ? { data: [{ id: 'a' }, { id: 'b' }], nextCursor: 'cur2' } : undefined,
      ),
    );
    const session = await startSession(proc);
    const r = await session.listThreads({ searchTerm: 'auth', limit: 10 });
    expect(r).toEqual({ data: [{ id: 'a' }, { id: 'b' }], nextCursor: 'cur2' });
    const sent = proc.written.find((m) => m.method === 'thread/list');
    expect(sent?.params).toEqual({
      searchTerm: 'auth',
      limit: 10,
      sourceKinds: ['cli', 'vscode', 'exec', 'appServer'],
    });
  });

  it('start() uses thread/resume (not thread/start) when resumeSessionId is set', async () => {
    const proc = createMockProc((msg) => {
      if (msg.method === 'initialize') return {};
      if (msg.method === 'thread/resume') return { thread: { id: 't-prev' } };
      return {};
    });
    mockSpawn.mockReturnValue(proc);
    const session = new PersistentCodexAppServerSession({
      name: 't',
      cwd: '/tmp',
      engine: 'codex-app',
      resumeSessionId: 't-prev',
    });
    await session.start();
    expect(session.codexThreadId).toBe('t-prev');
    expect(proc.written.some((m) => m.method === 'thread/resume')).toBe(true);
    expect(proc.written.some((m) => m.method === 'thread/start')).toBe(false);
    const resume = proc.written.find((m) => m.method === 'thread/resume');
    // The session never reads the returned turns, so the server need not load them.
    expect(resume?.params).toMatchObject({ threadId: 't-prev', excludeTurns: true });
  });

  it('falls back to thread/start when thread/resume fails (stale id)', async () => {
    const proc = createMockProc((msg) => {
      if (msg.method === 'initialize') return {};
      if (msg.method === 'thread/resume') return { __rpcError: 'thread not found' };
      if (msg.method === 'thread/start') return { thread: { id: 'fresh1' } };
      return {};
    });
    mockSpawn.mockReturnValue(proc);
    const session = new PersistentCodexAppServerSession({
      name: 't',
      cwd: '/tmp',
      engine: 'codex-app',
      resumeSessionId: 'stale-id',
    });
    await session.start();
    expect(session.codexThreadId).toBe('fresh1');
    expect(proc.written.some((m) => m.method === 'thread/resume')).toBe(true);
    expect(proc.written.some((m) => m.method === 'thread/start')).toBe(true);
  });

  // `thread/tokenUsage/updated` carries everything contextPercent needs — this
  // turn's own prompt (`last`) and the window the server enforces — but both
  // were ignored in favour of the cumulative totals over the model's published
  // window. That made the figure monotonic (it can only climb, so it pins at
  // 100 on a long thread) and ~4x too low per turn, which is what let the
  // openai-compat auto-compaction gate sit under its threshold until the
  // context hard-failed. Same defect as the `codex exec` wrapper, issue #75.
  it('derives contextPercent from the turn prompt and the server reported window', async () => {
    const proc = createMockProc(defaultResponder());
    const session = await startSession(proc);

    proc.stdout.push(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'thread/tokenUsage/updated',
        params: {
          threadId: 't1',
          turnId: 'turn1',
          tokenUsage: {
            total: {
              totalTokens: 250_100,
              inputTokens: 250_000,
              cachedInputTokens: 100_000,
              outputTokens: 100,
              reasoningOutputTokens: 0,
            },
            last: {
              totalTokens: 129_250,
              inputTokens: 129_200,
              cachedInputTokens: 50_000,
              outputTokens: 50,
              reasoningOutputTokens: 0,
            },
            modelContextWindow: 258_400,
          },
        },
      }) + '\n',
    );
    await new Promise((r) => setTimeout(r, 20));

    const stats = session.getStats();
    // Cumulative totals still drive cost — those were always right.
    expect(stats.tokensIn).toBe(250_000);
    // 129,200 / 258,400 = 50%. The old formula gave (250,000 + 100) / 1,050,000 = 24%.
    expect(stats.contextPercent).toBe(50);
  });
});

// `thread/start` takes `developerInstructions` and `baseInstructions`. Measured
// on 0.171.0, both reach the model as developer messages of their own (the
// rollout's session_meta records the base instructions as `custom`), so the
// instructions no longer ride at the top of the first user message.
describe('PersistentCodexAppServerSession — system prompts', () => {
  beforeEach(() => mockSpawn.mockReset());

  const turnTexts = (proc: ReturnType<typeof createMockProc>): string[] =>
    proc.written
      .filter((m) => m.method === 'turn/start')
      .map((m) => (m.params?.input as Array<{ text: string }>).at(-1)!.text);

  it('opens a fresh thread with appendSystemPrompt as developerInstructions and systemPrompt as baseInstructions', async () => {
    const proc = createMockProc(defaultResponder());
    mockSpawn.mockReturnValue(proc);
    const session = new PersistentCodexAppServerSession({
      name: 't',
      cwd: '/tmp',
      engine: 'codex-app',
      appendSystemPrompt: 'SEAT RULES',
      systemPrompt: 'BASE PROMPT',
    });
    await session.start();
    await session.send('hi');
    await session.send('again');
    await new Promise((r) => setTimeout(r, 5));
    expect(proc.written.find((m) => m.method === 'thread/start')?.params).toMatchObject({
      developerInstructions: 'SEAT RULES',
      baseInstructions: 'BASE PROMPT',
    });
    expect(turnTexts(proc)).toEqual(['hi', 'again']);
  });

  it('does not restate them on a resumed thread, which already carries them', async () => {
    const proc = createMockProc(
      defaultResponder((m) => (m.method === 'thread/resume' ? { thread: { id: 't9' } } : undefined)),
    );
    mockSpawn.mockReturnValue(proc);
    const session = new PersistentCodexAppServerSession({
      name: 't',
      cwd: '/tmp',
      engine: 'codex-app',
      appendSystemPrompt: 'SEAT RULES',
      systemPrompt: 'BASE PROMPT',
      resumeSessionId: 't9',
    });
    await session.start();
    await session.send('continue');
    await new Promise((r) => setTimeout(r, 5));
    const resume = proc.written.find((m) => m.method === 'thread/resume')?.params;
    expect(resume).not.toHaveProperty('developerInstructions');
    expect(resume).not.toHaveProperty('baseInstructions');
    expect(turnTexts(proc)).toEqual(['continue']);
  });

  it('gives a fresh thread that replaces a stale resume id its instructions', async () => {
    const proc = createMockProc((msg) => {
      if (msg.method === 'initialize') return {};
      if (msg.method === 'thread/resume') return { __rpcError: 'thread not found' };
      if (msg.method === 'thread/start') return { thread: { id: 'fresh' } };
      return {};
    });
    mockSpawn.mockReturnValue(proc);
    await new PersistentCodexAppServerSession({
      name: 't',
      cwd: '/tmp',
      engine: 'codex-app',
      appendSystemPrompt: 'SEAT RULES',
      resumeSessionId: 'gone',
    }).start();
    expect(proc.written.find((m) => m.method === 'thread/start')?.params).toMatchObject({
      developerInstructions: 'SEAT RULES',
    });
  });
});

// Options the `codex` engine honours and this one used to drop without a word.
describe('PersistentCodexAppServerSession — session options', () => {
  beforeEach(() => mockSpawn.mockReset());

  const push = (proc: ReturnType<typeof createMockProc>, method: string, params: unknown) =>
    proc.stdout.push(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');

  it('opens an ephemeral thread for noSessionPersistence', async () => {
    const proc = createMockProc(defaultResponder());
    mockSpawn.mockReturnValue(proc);
    await new PersistentCodexAppServerSession({
      name: 't',
      cwd: '/tmp',
      engine: 'codex-app',
      noSessionPersistence: true,
    }).start();
    expect(proc.written.find((m) => m.method === 'thread/start')?.params).toMatchObject({ ephemeral: true });
  });

  it('sends jsonSchema as the outputSchema of every turn', async () => {
    const schema = { type: 'object', properties: { number: { type: 'string' } }, required: ['number'] };
    const proc = createMockProc(defaultResponder());
    mockSpawn.mockReturnValue(proc);
    const session = new PersistentCodexAppServerSession({
      name: 't',
      cwd: '/tmp',
      engine: 'codex-app',
      jsonSchema: JSON.stringify(schema),
    });
    await session.start();
    await session.send('one');
    await session.send('two');
    await new Promise((r) => setTimeout(r, 5));
    const turns = proc.written.filter((m) => m.method === 'turn/start');
    expect(turns.map((m) => m.params?.outputSchema)).toEqual([schema, schema]);
  });

  it('refuses a jsonSchema that is not JSON before starting codex', async () => {
    const session = new PersistentCodexAppServerSession({
      name: 't',
      cwd: '/tmp',
      engine: 'codex-app',
      jsonSchema: '{not json',
    });
    await expect(session.start()).rejects.toThrow(/jsonSchema/);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  // `exec --add-dir` adds writable roots; the app-server has no such flag, and
  // a turn's `sandboxPolicy` replaces the thread's. It is built from the policy
  // `thread/start` reports, so the user's network access and roots survive.
  // The thread opens read-only (a writable thread/start records the project as
  // trusted in ~/.codex/config.toml) and gets the policy codex would build from
  // [sandbox_workspace_write], which addDir then extends.
  it('adds addDir to the writable roots of the policy built from the config, on workspace-write only', async () => {
    const reported = {
      type: 'workspaceWrite',
      writableRoots: ['/already'],
      networkAccess: true,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    };
    const proc = createMockProc((msg) => {
      if (msg.method === 'initialize') return {};
      if (msg.method === 'thread/start') return { thread: { id: 't1' }, sandbox: { type: 'readOnly' } };
      if (msg.method === 'config/read') {
        return { config: { sandbox_workspace_write: { writable_roots: ['/already'], network_access: true } } };
      }
      return {};
    });
    mockSpawn.mockReturnValue(proc);
    const session = new PersistentCodexAppServerSession({
      name: 't',
      cwd: '/tmp',
      engine: 'codex-app',
      addDir: ['/srv/a', '/srv/b'],
    });
    await session.start();
    expect(proc.written.find((m) => m.method === 'thread/start')?.params?.sandbox).toBe('read-only');
    expect(proc.written.find((m) => m.method === 'thread/settings/update')?.params).toEqual({
      threadId: 't1',
      sandboxPolicy: reported,
    });
    await session.send('hi');
    await new Promise((r) => setTimeout(r, 5));
    expect(proc.written.find((m) => m.method === 'turn/start')?.params?.sandboxPolicy).toEqual({
      ...reported,
      writableRoots: ['/already', '/srv/a', '/srv/b'],
    });

    const ro = createMockProc(defaultResponder());
    mockSpawn.mockReturnValue(ro);
    const roSession = new PersistentCodexAppServerSession({
      name: 'r',
      cwd: '/tmp',
      engine: 'codex-app',
      sandboxMode: 'read-only',
      addDir: ['/srv/a'],
    });
    await roSession.start();
    await roSession.send('hi');
    await new Promise((r) => setTimeout(r, 5));
    expect(ro.written.find((m) => m.method === 'turn/start')?.params).not.toHaveProperty('sandboxPolicy');
  });

  it('puts the images before the text of the turn, as localImage inputs', async () => {
    const proc = createMockProc(defaultResponder());
    mockSpawn.mockReturnValue(proc);
    const session = new PersistentCodexAppServerSession({ name: 't', cwd: '/tmp', engine: 'codex-app' });
    await session.start();
    await session.send('What number is in the image?', { images: ['/tmp/n731.png', '/tmp/b.jpg'] });
    await session.send('thanks');
    await new Promise((r) => setTimeout(r, 5));
    const inputs = proc.written.filter((m) => m.method === 'turn/start').map((m) => m.params?.input);
    expect(inputs[0]).toEqual([
      { type: 'localImage', path: '/tmp/n731.png' },
      { type: 'localImage', path: '/tmp/b.jpg' },
      { type: 'text', text: 'What number is in the image?', text_elements: [] },
    ]);
    expect(inputs[1]).toEqual([{ type: 'text', text: 'thanks', text_elements: [] }]);
  });

  it('merges codexConfig into the thread config, and passes codexFeatures to the app-server', async () => {
    const proc = createMockProc(defaultResponder());
    mockSpawn.mockReturnValue(proc);
    await new PersistentCodexAppServerSession({
      name: 't',
      cwd: '/tmp',
      engine: 'codex-app',
      effort: 'high',
      codexConfig: { 'sandbox_workspace_write.network_access': true, model_verbosity: 'low' },
      codexFeatures: { enable: ['web_search'], disable: ['memories'] },
    }).start();
    expect(proc.written.find((m) => m.method === 'thread/start')?.params?.config).toEqual({
      model_reasoning_effort: 'high',
      'sandbox_workspace_write.network_access': true,
      model_verbosity: 'low',
    });
    expect(mockSpawn.mock.calls[0][1]).toEqual([
      'app-server',
      '--listen',
      'stdio://',
      '--enable',
      'goals',
      '--enable',
      'web_search',
      '--disable',
      'memories',
    ]);

    const resumed = createMockProc(
      defaultResponder((m) => (m.method === 'thread/resume' ? { thread: { id: 't9' } } : undefined)),
    );
    mockSpawn.mockReturnValue(resumed);
    await new PersistentCodexAppServerSession({
      name: 'r',
      cwd: '/tmp',
      engine: 'codex-app',
      codexConfig: { model_verbosity: 'low' },
      resumeSessionId: 't9',
    }).start();
    expect(resumed.written.find((m) => m.method === 'thread/resume')?.params?.config).toEqual({
      model_verbosity: 'low',
    });
  });

  it('refuses before starting codex: a reserved codexConfig key, and ignoreRules', async () => {
    await expect(
      new PersistentCodexAppServerSession({
        name: 't',
        cwd: '/tmp',
        engine: 'codex-app',
        codexConfig: { approval_policy: 'on-request' },
      }).start(),
    ).rejects.toThrow(/approval_policy/);
    // `codex app-server` rejects --ignore-rules ("unexpected argument", 0.171.0).
    await expect(
      new PersistentCodexAppServerSession({ name: 't', cwd: '/tmp', engine: 'codex-app', ignoreRules: true }).start(),
    ).rejects.toThrow(/ignoreRules/);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('counts tool items and failed commands, not messages or reasoning', async () => {
    const proc = createMockProc(defaultResponder());
    const session = await startSession(proc);
    const p = session.send('do it', { waitForComplete: true });
    setTimeout(() => {
      const item = (item: Record<string, unknown>) =>
        push(proc, 'item/completed', { threadId: 't1', turnId: 'x', item });
      item({ type: 'userMessage', id: 'u' });
      item({ type: 'reasoning', id: 'r' });
      item({ type: 'plan', id: 'p', text: 'plan' });
      item({ type: 'commandExecution', id: 'c1', exitCode: 0 });
      item({ type: 'commandExecution', id: 'c2', exitCode: 2 });
      item({ type: 'fileChange', id: 'f' });
      item({ type: 'mcpToolCall', id: 'm' });
      item({ type: 'agentMessage', id: 'a', text: 'done', phase: 'final_answer' });
      push(proc, 'turn/completed', { threadId: 't1', turn: { id: 'x', status: 'completed' } });
    }, 5);
    await p;
    expect(session.getStats().toolCalls).toBe(4);
    expect(session.getStats().toolErrors).toBe(1);
  });

  // Every agent message of a turn streams as deltas, commentary included. The
  // result is the one the server marks `final_answer` (0.171.0 sets the phase),
  // else the last agent message of the turn.
  it('answers with the final_answer message, not the commentary before it', async () => {
    const proc = createMockProc(defaultResponder());
    const session = await startSession(proc);
    const texts: string[] = [];
    const p = session.send('run it', { waitForComplete: true, callbacks: { onText: (t) => texts.push(t) } });
    setTimeout(() => {
      push(proc, 'item/agentMessage/delta', { threadId: 't1', turnId: 'x', itemId: 'm1', delta: 'Running it.' });
      push(proc, 'item/completed', {
        threadId: 't1',
        turnId: 'x',
        item: { type: 'agentMessage', id: 'm1', text: 'Running it.', phase: 'commentary' },
      });
      push(proc, 'item/agentMessage/delta', { threadId: 't1', turnId: 'x', itemId: 'm2', delta: '{"number":"731"}' });
      push(proc, 'item/completed', {
        threadId: 't1',
        turnId: 'x',
        item: { type: 'agentMessage', id: 'm2', text: '{"number":"731"}', phase: 'final_answer' },
      });
      push(proc, 'item/completed', {
        threadId: 't1',
        turnId: 'x',
        item: { type: 'agentMessage', id: 'm3', text: 'Anything else?', phase: 'commentary' },
      });
      push(proc, 'turn/completed', { threadId: 't1', turn: { id: 'x', status: 'completed' } });
    }, 5);
    const r = (await p) as { text: string; event: Record<string, unknown> };
    expect(r.text).toBe('{"number":"731"}');
    expect(r.event.result).toBe('{"number":"731"}');
    // Streaming is unchanged: each delta once, and a message that came without deltas once.
    expect(texts).toEqual(['Running it.', '{"number":"731"}', 'Anything else?']);
  });

  it('answers with the last agent message when none is marked final_answer', async () => {
    const proc = createMockProc(defaultResponder());
    const session = await startSession(proc);
    const p = session.send('hi', { waitForComplete: true });
    setTimeout(() => {
      push(proc, 'item/completed', {
        threadId: 't1',
        turnId: 'x',
        item: { type: 'agentMessage', id: 'a', text: 'first' },
      });
      push(proc, 'item/completed', {
        threadId: 't1',
        turnId: 'x',
        item: { type: 'agentMessage', id: 'b', text: 'second' },
      });
      push(proc, 'turn/completed', { threadId: 't1', turn: { id: 'x', status: 'completed' } });
    }, 5);
    expect(((await p) as { text: string }).text).toBe('second');
  });

  it('forks the thread named by resumeSessionId when forkSession is set, and continues the fork', async () => {
    const proc = createMockProc((msg) => {
      if (msg.method === 'initialize') return {};
      if (msg.method === 'thread/fork') return { thread: { id: 'forked' }, model: 'gpt-6-astra' };
      return {};
    });
    mockSpawn.mockReturnValue(proc);
    const session = new PersistentCodexAppServerSession({
      name: 't',
      cwd: '/tmp',
      engine: 'codex-app',
      resumeSessionId: 'src-thread',
      forkSession: true,
      noSessionPersistence: true,
      appendSystemPrompt: 'SEAT RULES',
      codexConfig: { model_verbosity: 'low' },
    });
    await session.start();
    expect(session.codexThreadId).toBe('forked');
    const fork = proc.written.find((m) => m.method === 'thread/fork')?.params;
    expect(fork).toMatchObject({
      threadId: 'src-thread',
      approvalPolicy: 'never',
      sandbox: 'workspace-write',
      ephemeral: true,
      excludeTurns: true,
      config: { model_verbosity: 'low' },
    });
    // The forked history already carries the instructions.
    expect(fork).not.toHaveProperty('developerInstructions');
    expect(proc.written.some((m) => m.method === 'thread/resume' || m.method === 'thread/start')).toBe(false);
    await session.send('go on');
    await new Promise((r) => setTimeout(r, 5));
    expect(proc.written.find((m) => m.method === 'turn/start')?.params?.threadId).toBe('forked');
  });

  it('starts a fresh thread when the fork source is gone', async () => {
    const proc = createMockProc((msg) => {
      if (msg.method === 'initialize') return {};
      if (msg.method === 'thread/fork') return { __rpcError: 'thread not found' };
      if (msg.method === 'thread/start') return { thread: { id: 'fresh' } };
      return {};
    });
    mockSpawn.mockReturnValue(proc);
    const session = new PersistentCodexAppServerSession({
      name: 't',
      cwd: '/tmp',
      engine: 'codex-app',
      resumeSessionId: 'gone',
      forkSession: true,
    });
    await session.start();
    expect(session.codexThreadId).toBe('fresh');
  });
});

// The goal loop runs turns no `turn/start` asked for, so the thread itself has
// to carry the effort; `turn/start` carries it too, so a later setEffort() or a
// per-send effort reaches the next turn.
describe('PersistentCodexAppServerSession — effort', () => {
  beforeEach(() => mockSpawn.mockReset());

  it('opens the thread with the effort and sends it on every turn', async () => {
    const proc = createMockProc(defaultResponder());
    mockSpawn.mockReturnValue(proc);
    const session = new PersistentCodexAppServerSession({
      name: 't',
      cwd: '/tmp',
      engine: 'codex-app',
      effort: 'xhigh',
    });
    await session.start();
    expect(proc.written.find((m) => m.method === 'thread/start')?.params?.config).toEqual({
      model_reasoning_effort: 'xhigh',
    });
    await session.send('one');
    session.setEffort('low');
    await session.send('two');
    await session.send('three', { effort: 'max' });
    await new Promise((r) => setTimeout(r, 5));
    expect(proc.written.filter((m) => m.method === 'turn/start').map((m) => m.params?.effort)).toEqual([
      'xhigh',
      'low',
      'max',
    ]);
  });

  it('carries the effort onto a resumed thread', async () => {
    const proc = createMockProc(
      defaultResponder((m) => (m.method === 'thread/resume' ? { thread: { id: 't9' } } : undefined)),
    );
    mockSpawn.mockReturnValue(proc);
    await new PersistentCodexAppServerSession({
      name: 't',
      cwd: '/tmp',
      engine: 'codex-app',
      effort: 'high',
      resumeSessionId: 't9',
    }).start();
    expect(proc.written.find((m) => m.method === 'thread/resume')?.params?.config).toEqual({
      model_reasoning_effort: 'high',
    });
  });

  it('leaves the effort to codex when it is auto or unset', async () => {
    const proc = createMockProc(defaultResponder());
    mockSpawn.mockReturnValue(proc);
    const session = new PersistentCodexAppServerSession({
      name: 't',
      cwd: '/tmp',
      engine: 'codex-app',
      effort: 'auto',
    });
    await session.start();
    await session.send('hi');
    await new Promise((r) => setTimeout(r, 5));
    expect(proc.written.find((m) => m.method === 'thread/start')?.params).not.toHaveProperty('config');
    expect(proc.written.find((m) => m.method === 'turn/start')?.params).not.toHaveProperty('effort');
  });
});

// Goals moved from `/goal …` chat text to typed RPCs. These pin the request
// shapes against `codex app-server generate-ts` (0.164) and the two behaviours
// the goal node leans on: a structured error, and a steer into a turn the goal
// loop started.
describe('PersistentCodexAppServerSession — goals', () => {
  beforeEach(() => mockSpawn.mockReset());

  const GOAL = {
    threadId: 't1',
    objective: 'ship it',
    status: 'active',
    tokenBudget: 5000,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    createdAt: 1,
    updatedAt: 1,
  };
  const push = (proc: ReturnType<typeof createMockProc>, method: string, params: unknown) =>
    proc.stdout.push(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');

  it('setGoal() sends thread/goal/set with origin "user" and only the fields given', async () => {
    const proc = createMockProc(defaultResponder((m) => (m.method === 'thread/goal/set' ? { goal: GOAL } : undefined)));
    const session = await startSession(proc);
    const goal = await session.setGoal({ objective: 'ship it', tokenBudget: 5000 });
    expect(goal.status).toBe('active');
    expect(session.goal?.objective).toBe('ship it');
    await session.setGoal({ status: 'paused' });
    const sets = proc.written.filter((m) => m.method === 'thread/goal/set').map((m) => m.params);
    expect(sets).toEqual([
      { threadId: 't1', origin: 'user', objective: 'ship it', tokenBudget: 5000 },
      { threadId: 't1', origin: 'user', status: 'paused' },
    ]);
    // Nothing went out as chat text.
    expect(proc.written.some((m) => m.method === 'turn/start')).toBe(false);
  });

  it('getGoal() asks the server, and clearGoal() sends thread/goal/clear', async () => {
    const proc = createMockProc(
      defaultResponder((m) =>
        m.method === 'thread/goal/get' ? { goal: { ...GOAL, status: 'complete', tokensUsed: 42 } } : undefined,
      ),
    );
    const session = await startSession(proc);
    expect((await session.getGoal())?.tokensUsed).toBe(42);
    await session.clearGoal();
    expect(session.goal).toBeNull();
    expect(proc.written.find((m) => m.method === 'thread/goal/clear')?.params).toEqual({
      threadId: 't1',
      origin: 'user',
    });
  });

  it('records a structured error and does not throw without an error listener', async () => {
    const proc = createMockProc(defaultResponder());
    const session = await startSession(proc);
    const seen: unknown[] = [];
    session.on('codex:error', (e) => seen.push(e));
    // Before the fix this emitted Node's 'error' event with no listener, which throws.
    push(proc, 'error', {
      error: { message: 'Selected model is at capacity', codexErrorInfo: 'serverOverloaded' },
      willRetry: false,
      threadId: 't1',
      turnId: 'x',
    });
    push(proc, 'error', {
      error: { message: 'stream dropped', codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 502 } } },
      willRetry: true,
      threadId: 't1',
      turnId: 'x',
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(seen).toHaveLength(2);
    expect(session.lastError).toMatchObject({ code: 'responseStreamDisconnected', willRetry: true });
    expect(seen[0]).toMatchObject({
      message: 'Selected model is at capacity',
      code: 'serverOverloaded',
      willRetry: false,
    });
  });

  it('reports the error a failed goal turn carries in turn/completed, once per turn', async () => {
    // codex 0.166.0: a model at capacity can end a goal turn with only
    // turn.error set and no `error` notification; the goal then goes blocked.
    const proc = createMockProc(defaultResponder());
    const session = await startSession(proc);
    const seen: Array<{ code: string | null; willRetry: boolean }> = [];
    session.on('codex:error', (e) => seen.push(e as { code: string | null; willRetry: boolean }));
    push(proc, 'turn/completed', {
      threadId: 't1',
      turn: {
        id: 'g1',
        status: 'failed',
        error: {
          message: 'Selected model is at capacity. Please try a different model.',
          codexErrorInfo: 'serverOverloaded',
        },
      },
    });
    // A turn whose final error already came as a notification is not reported twice.
    push(proc, 'error', {
      error: { message: 'usage limit', codexErrorInfo: 'usageLimitExceeded' },
      willRetry: false,
      threadId: 't1',
      turnId: 'g2',
    });
    push(proc, 'turn/completed', {
      threadId: 't1',
      turn: { id: 'g2', status: 'failed', error: { message: 'usage limit', codexErrorInfo: 'usageLimitExceeded' } },
    });
    // A completed turn reports nothing.
    push(proc, 'turn/completed', { threadId: 't1', turn: { id: 'g3', status: 'completed', error: null } });
    await new Promise((r) => setTimeout(r, 5));
    expect(seen.map((e) => e.code)).toEqual(['serverOverloaded', 'usageLimitExceeded']);
    expect(seen[0].willRetry).toBe(false);
    expect(session.lastError).toMatchObject({ code: 'usageLimitExceeded' });
  });

  it('steer() goes into a turn the goal loop started, which no send() is waiting on', async () => {
    const proc = createMockProc(defaultResponder((m) => (m.method === 'turn/steer' ? { turnId: 'g1' } : undefined)));
    const session = await startSession(proc);
    push(proc, 'turn/started', { threadId: 't1', turn: { id: 'g1' } });
    await new Promise((r) => setTimeout(r, 5));
    expect(session.turnActive).toBe(true);
    const r = await session.steer('log this round in WORK_LOG.md');
    expect(r.steered).toBe(true);
    expect(proc.written.find((m) => m.method === 'turn/steer')?.params).toMatchObject({
      threadId: 't1',
      expectedTurnId: 'g1',
    });
    push(proc, 'turn/completed', { threadId: 't1', turn: { id: 'g1', status: 'completed' } });
    await new Promise((r) => setTimeout(r, 5));
    expect(session.turnActive).toBe(false);
  });
});

// An unattended thread cannot stop for a person. Both halves are needed: the
// policy keeps the server from asking, and a request that comes anyway is
// answered, because an unanswered one blocks its turn for good.
describe('PersistentCodexAppServerSession — no approval prompts', () => {
  beforeEach(() => mockSpawn.mockReset());

  it('opens and resumes threads with approvalPolicy "never"', async () => {
    const proc = createMockProc(defaultResponder());
    await startSession(proc);
    expect(proc.written.find((m) => m.method === 'thread/start')?.params).toMatchObject({ approvalPolicy: 'never' });

    const resumed = createMockProc(
      defaultResponder((m) => (m.method === 'thread/resume' ? { thread: { id: 't7' } } : undefined)),
    );
    mockSpawn.mockReturnValue(resumed);
    await new PersistentCodexAppServerSession({
      name: 'r',
      cwd: '/tmp',
      engine: 'codex-app',
      resumeSessionId: 't7',
    }).start();
    expect(resumed.written.find((m) => m.method === 'thread/resume')?.params).toMatchObject({
      approvalPolicy: 'never',
    });
  });

  it('answers a server request it cannot handle instead of leaving the turn waiting', async () => {
    const proc = createMockProc(defaultResponder());
    await startSession(proc);
    proc.stdout.push(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 'srv-1',
        method: 'item/commandExecution/requestApproval',
        params: { threadId: 't1', turnId: 'x', itemId: 'i', command: 'rm -rf /' },
      }) + '\n',
    );
    await new Promise((r) => setTimeout(r, 5));
    const reply = proc.written.find((m) => (m as { id?: unknown }).id === 'srv-1') as
      | { error?: { message?: string } }
      | undefined;
    expect(reply?.error?.message).toContain('not supported');
  });
});
