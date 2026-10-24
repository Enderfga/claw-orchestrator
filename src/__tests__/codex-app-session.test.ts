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

  it('listThreads() sends thread/list with filters and returns data + nextCursor', async () => {
    const proc = createMockProc(
      defaultResponder((m) =>
        m.method === 'thread/list' ? { data: [{ id: 'a' }, { id: 'b' }], nextCursor: 'cur2' } : undefined,
      ),
    );
    const session = await startSession(proc);
    const r = await session.listThreads({ searchTerm: 'auth', limit: 10 });
    expect(r).toEqual({ data: [{ id: 'a' }, { id: 'b' }], nextCursor: 'cur2' });
    const sent = proc.written.find((m) => m.method === 'thread/list');
    expect(sent?.params).toEqual({ searchTerm: 'auth', limit: 10 });
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
    expect(resume?.params).toMatchObject({ threadId: 't-prev' });
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

// Nothing passes `appendSystemPrompt` to `thread/start`, so it used to be
// dropped — including the charter of a council seat on this engine. It now
// leads the first turn of a fresh thread, and only that turn.
describe('PersistentCodexAppServerSession — appendSystemPrompt', () => {
  beforeEach(() => mockSpawn.mockReset());

  const turnTexts = (proc: ReturnType<typeof createMockProc>): string[] =>
    proc.written
      .filter((m) => m.method === 'turn/start')
      .map((m) => (m.params?.input as Array<{ text: string }>)[0].text);

  it('leads the first turn of a fresh thread, and only that turn', async () => {
    const proc = createMockProc(defaultResponder());
    mockSpawn.mockReturnValue(proc);
    const session = new PersistentCodexAppServerSession({
      name: 't',
      cwd: '/tmp',
      engine: 'codex-app',
      appendSystemPrompt: 'SEAT RULES',
    });
    await session.start();
    await session.send('hi');
    await session.send('again');
    await new Promise((r) => setTimeout(r, 5));
    expect(turnTexts(proc)).toEqual(['SEAT RULES\n\n---\n\nhi', 'again']);
  });

  it('is not repeated on a resumed thread, which already carries it', async () => {
    const proc = createMockProc(
      defaultResponder((m) => (m.method === 'thread/resume' ? { thread: { id: 't9' } } : undefined)),
    );
    mockSpawn.mockReturnValue(proc);
    const session = new PersistentCodexAppServerSession({
      name: 't',
      cwd: '/tmp',
      engine: 'codex-app',
      appendSystemPrompt: 'SEAT RULES',
      resumeSessionId: 't9',
    });
    await session.start();
    await session.send('continue');
    await new Promise((r) => setTimeout(r, 5));
    expect(turnTexts(proc)).toEqual(['continue']);
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
