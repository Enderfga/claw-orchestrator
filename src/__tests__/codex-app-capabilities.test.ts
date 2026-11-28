/**
 * codex-app: sub-agent threads, compaction, plan mode, per-send models, side
 * questions, live settings and RPC commands. The app-server is a JSON-RPC
 * auto-responder; notification shapes are the ones codex 0.172.0 sends.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Rollouts are read from here: nothing of the user's.
process.env.CODEX_HOME = '/nonexistent/clawo-test-codex-home';

const mockSpawn = vi.fn();
vi.mock('../engine-spawn.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../engine-spawn.js')>()),
  spawnEngine: (...args: unknown[]) => mockSpawn(...args),
}));

const { PersistentCodexAppServerSession } = await import('../persistent-codex-app-session.js');
const { SESSION_EVENT } = await import('../constants.js');
const { getModelPricing } = await import('../models.js');

interface WrittenMsg {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
}

type Responder = (msg: WrittenMsg) => unknown;

function createMockProc(responder: Responder) {
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
        if (msg.id !== undefined && msg.method !== undefined && result !== undefined) {
          if (result && typeof result === 'object' && '__rpcError' in result) {
            const message = (result as { __rpcError: string }).__rpcError;
            proc.stdout.push(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message } }) + '\n');
          } else if (result && typeof result === 'object' && '__raw' in result) {
            // The response and the notifications after it, in one chunk.
            const raw = (result as { __raw: (id: number) => string }).__raw(msg.id);
            proc.stdout.push(raw);
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

let turnSeq = 0;
/** initialize + thread/start; turn/start answers with a fresh turn id; anything else `{}`. */
function responder(extra?: Responder): Responder {
  return (msg) => {
    const e = extra?.(msg);
    if (e !== undefined) return e;
    if (msg.method === 'initialize') return {};
    if (msg.method === 'thread/start') return { thread: { id: 'T' }, model: 'gpt-5.5', reasoningEffort: 'xhigh' };
    if (msg.method === 'turn/start') return { turn: { id: `turn${++turnSeq}`, status: 'inProgress' } };
    return {};
  };
}

async function start(proc: ReturnType<typeof createMockProc>, config: Record<string, unknown> = {}) {
  mockSpawn.mockReturnValue(proc);
  const session = new PersistentCodexAppServerSession({
    permissionMode: 'bypassPermissions',
    name: 't',
    cwd: '/tmp',
    engine: 'codex-app',
    ...config,
  });
  await session.start();
  return session;
}

function notify(proc: ReturnType<typeof createMockProc>, method: string, params: Record<string, unknown>) {
  proc.stdout.push(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}

const usage = (input: number, cached = 0, output = 0) => ({
  totalTokens: input + output,
  inputTokens: input,
  cachedInputTokens: cached,
  outputTokens: output,
  reasoningOutputTokens: 0,
});

const tick = () => new Promise((r) => setTimeout(r, 5));

/** The id of the last turn/start the session sent. */
const lastTurnId = () => `turn${turnSeq}`;

describe('codex-app — sub-agent threads', () => {
  beforeEach(() => mockSpawn.mockReset());

  it("answers a send with its own thread's turn, not a sub-agent's, and sums every thread's usage", async () => {
    const proc = createMockProc(responder());
    const session = await start(proc);
    const results: unknown[] = [];
    session.on(SESSION_EVENT.RESULT, (e: unknown) => results.push(e));
    const texts: string[] = [];
    session.on(SESSION_EVENT.TEXT, (t: string) => texts.push(t));

    const sent = session.send('delegate 23*3', { waitForComplete: true });
    await tick();
    const parentTurn = lastTurnId();
    notify(proc, 'turn/started', { threadId: 'T', turn: { id: parentTurn, rootTurnId: parentTurn } });
    notify(proc, 'item/completed', {
      threadId: 'T',
      turnId: parentTurn,
      item: { type: 'subAgentActivity', kind: 'started', agentThreadId: 'C', agentPath: '/root/mul', model: 'gpt-5.4' },
    });
    notify(proc, 'thread/tokenUsage/updated', {
      threadId: 'T',
      turnId: parentTurn,
      tokenUsage: { total: usage(1000), last: usage(1000), modelContextWindow: 100_000 },
    });
    // The sub-agent: its own thread, its own turn, ending first.
    notify(proc, 'turn/started', { threadId: 'C', turn: { id: 'child1', rootTurnId: parentTurn } });
    notify(proc, 'item/agentMessage/delta', { threadId: 'C', turnId: 'child1', itemId: 'cm', delta: '69' });
    notify(proc, 'item/completed', {
      threadId: 'C',
      turnId: 'child1',
      item: { type: 'agentMessage', id: 'cm', text: '69', phase: 'final_answer' },
    });
    notify(proc, 'item/completed', {
      threadId: 'C',
      turnId: 'child1',
      item: { type: 'commandExecution', exitCode: 1 },
    });
    notify(proc, 'thread/tokenUsage/updated', {
      threadId: 'C',
      turnId: 'child1',
      tokenUsage: { total: usage(500), last: usage(500), modelContextWindow: 100_000 },
    });
    notify(proc, 'turn/completed', {
      threadId: 'C',
      turn: { id: 'child1', rootTurnId: parentTurn, status: 'completed' },
    });
    await tick();
    expect(session.turnActive).toBe(true);
    expect(session.getStats().turns).toBe(0);

    notify(proc, 'item/completed', {
      threadId: 'T',
      turnId: parentTurn,
      item: { type: 'agentMessage', id: 'pm', text: 'PARENT:69', phase: 'final_answer' },
    });
    notify(proc, 'thread/tokenUsage/updated', {
      threadId: 'T',
      turnId: parentTurn,
      tokenUsage: { total: usage(2000), last: usage(1000), modelContextWindow: 100_000 },
    });
    notify(proc, 'turn/completed', {
      threadId: 'T',
      turn: { id: parentTurn, rootTurnId: parentTurn, status: 'completed' },
    });

    const r = (await sent) as { text: string };
    expect(r.text).toBe('PARENT:69');
    expect(texts.join('')).not.toContain('69PARENT');
    expect(texts).not.toContain('69');
    const stats = session.getStats();
    expect(stats.turns).toBe(1);
    expect(stats.turnsSucceeded).toBe(1);
    expect(stats.tokensIn).toBe(2500);
    // The sub-agent's failed command is its own, not the session's tool call.
    expect(stats.toolErrors).toBe(0);
    // The context is the parent's last prompt.
    expect(stats.contextPercent).toBe(1);
    expect(results).toHaveLength(1);
    // The sub-agent's tokens bill at its own model.
    const cost = session.getCost();
    expect(cost.totalUsd).toBeGreaterThan(0);
  });

  it("takes a review's reviewer turn as part of the review and answers with the review", async () => {
    const proc = createMockProc(
      responder((msg) => (msg.method === 'review/start' ? { turn: { id: 'rev', rootTurnId: null } } : undefined)),
    );
    const session = await start(proc);
    const run = session.runCommand('review', 'base main');
    await tick();
    const reviewStart = proc.written.find((m) => m.method === 'review/start');
    expect(reviewStart?.params).toEqual({ threadId: 'T', target: { type: 'baseBranch', branch: 'main' } });
    notify(proc, 'item/completed', { threadId: 'T', turnId: 'rev', item: { type: 'enteredReviewMode', review: 'x' } });
    // The reviewer's inner turn: never completes on its own.
    notify(proc, 'turn/started', { threadId: 'T', turn: { id: 'inner', rootTurnId: 'rev' } });
    expect(session.activeTurnId).toBe('rev');
    notify(proc, 'item/completed', {
      threadId: 'T',
      turnId: 'rev',
      item: { type: 'exitedReviewMode', review: '[P1] add subtracts' },
    });
    notify(proc, 'item/completed', {
      threadId: 'T',
      turnId: 'rev',
      item: { type: 'agentMessage', text: 'summary', phase: null },
    });
    notify(proc, 'turn/completed', { threadId: 'T', turn: { id: 'rev', rootTurnId: 'rev', status: 'completed' } });
    const outcome = await run;
    expect(outcome).toMatchObject({ name: 'review', ok: true, text: '[P1] add subtracts', startedTurn: true });
    expect(session.turnActive).toBe(false);
    expect(session.getStats().turnsSucceeded).toBe(1);
  });
});

describe('codex-app — compaction', () => {
  beforeEach(() => mockSpawn.mockReset());

  it('waits for the compaction turn, counts no turn, reports no result, and a send right after runs', async () => {
    const proc = createMockProc(responder());
    const session = await start(proc);
    const results: unknown[] = [];
    session.on(SESSION_EVENT.RESULT, (e: unknown) => results.push(e));
    notify(proc, 'thread/tokenUsage/updated', {
      threadId: 'T',
      turnId: 'old',
      tokenUsage: { total: usage(50_000), last: usage(40_000), modelContextWindow: 100_000 },
    });
    await tick();
    let done = false;
    const compacting = session.compactDetailed().then((o) => {
      done = true;
      return o;
    });
    await tick();
    expect(proc.written.some((m) => m.method === 'thread/compact/start')).toBe(true);
    notify(proc, 'turn/started', { threadId: 'T', turn: { id: 'cmp', rootTurnId: 'cmp' } });
    notify(proc, 'item/completed', { threadId: 'T', turnId: 'cmp', item: { type: 'contextCompaction' } });
    await tick();
    expect(done).toBe(false);
    expect(session.turnActive).toBe(true);
    notify(proc, 'thread/tokenUsage/updated', {
      threadId: 'T',
      turnId: 'cmp',
      tokenUsage: { total: usage(50_000), last: { ...usage(0), totalTokens: 9000 }, modelContextWindow: 100_000 },
    });
    notify(proc, 'turn/completed', { threadId: 'T', turn: { id: 'cmp', rootTurnId: 'cmp', status: 'completed' } });
    const outcome = await compacting;
    expect(outcome).toEqual({ ok: true, trigger: 'manual', preTokens: 40_000, postTokens: 9000 });
    expect(session.turnActive).toBe(false);
    expect(session.getStats().turns).toBe(0);
    expect(session.getStats().contextPercent).toBe(9);
    expect(results).toHaveLength(0);

    const sent = session.send('next', { waitForComplete: true });
    await tick();
    notify(proc, 'item/completed', { threadId: 'T', turnId: lastTurnId(), item: { type: 'agentMessage', text: 'ok' } });
    notify(proc, 'turn/completed', { threadId: 'T', turn: { id: lastTurnId(), status: 'completed' } });
    expect(((await sent) as { text: string }).text).toBe('ok');
  });

  it('refuses to compact while a turn is in flight', async () => {
    const proc = createMockProc(responder());
    const session = await start(proc);
    notify(proc, 'turn/started', { threadId: 'T', turn: { id: 'goal1' } });
    await tick();
    await expect(session.compactDetailed()).rejects.toThrow(/turn is in flight/);
  });
});

describe('codex-app — turns no send waits for', () => {
  beforeEach(() => mockSpawn.mockReset());

  it('reports an engine-started turn as unsolicited, counted but not as a success', async () => {
    const proc = createMockProc(responder());
    const session = await start(proc);
    const unsolicited: unknown[] = [];
    session.on(SESSION_EVENT.UNSOLICITED_RESULT, (p: unknown) => unsolicited.push(p));
    notify(proc, 'turn/started', { threadId: 'T', turn: { id: 'e1' } });
    notify(proc, 'item/completed', { threadId: 'T', turnId: 'e1', item: { type: 'agentMessage', text: 'late' } });
    notify(proc, 'turn/completed', { threadId: 'T', turn: { id: 'e1', status: 'completed' } });
    await tick();
    expect(unsolicited).toHaveLength(1);
    expect((unsolicited[0] as { text: string }).text).toBe('late');
    expect(session.getStats().turns).toBe(1);
    expect(session.getStats().turnsSucceeded).toBe(0);
  });

  it("leaves a goal loop's turns to the goal: no unsolicited result while the thread has a goal", async () => {
    const proc = createMockProc(responder());
    const session = await start(proc);
    const unsolicited: unknown[] = [];
    const results: unknown[] = [];
    session.on(SESSION_EVENT.UNSOLICITED_RESULT, (p: unknown) => unsolicited.push(p));
    session.on(SESSION_EVENT.RESULT, (p: unknown) => results.push(p));
    notify(proc, 'thread/goal/updated', { threadId: 'T', goal: { threadId: 'T', objective: 'x', status: 'active' } });
    notify(proc, 'turn/started', { threadId: 'T', turn: { id: 'g1' } });
    notify(proc, 'turn/completed', { threadId: 'T', turn: { id: 'g1', status: 'completed' } });
    await tick();
    expect(results).toHaveLength(1);
    expect(unsolicited).toHaveLength(0);
  });

  it('resolves a send whose turn ended in the same chunk as the response that started it', async () => {
    const proc = createMockProc(
      responder((msg) =>
        msg.method === 'turn/start'
          ? {
              __raw: (id: number) =>
                [
                  { jsonrpc: '2.0', id, result: { turn: { id: 'fast' } } },
                  { jsonrpc: '2.0', method: 'turn/started', params: { threadId: 'T', turn: { id: 'fast' } } },
                  {
                    jsonrpc: '2.0',
                    method: 'item/completed',
                    params: { threadId: 'T', turnId: 'fast', item: { type: 'agentMessage', text: 'quick' } },
                  },
                  {
                    jsonrpc: '2.0',
                    method: 'turn/completed',
                    params: { threadId: 'T', turn: { id: 'fast', status: 'completed' } },
                  },
                ]
                  .map((m) => JSON.stringify(m))
                  .join('\n') + '\n',
            }
          : undefined,
      ),
    );
    const session = await start(proc);
    const unsolicited: unknown[] = [];
    session.on(SESSION_EVENT.UNSOLICITED_RESULT, (p: unknown) => unsolicited.push(p));
    const r = (await session.send('hi', { waitForComplete: true })) as { text: string };
    expect(r.text).toBe('quick');
    expect(unsolicited).toHaveLength(0);
    expect(session.getStats().turnsSucceeded).toBe(1);
  });
});

describe('codex-app — plan mode, per-send model and effort', () => {
  beforeEach(() => mockSpawn.mockReset());

  it('runs a plan turn in plan mode, answers with the plan, and puts the next turn back in default mode', async () => {
    const proc = createMockProc(responder());
    const session = await start(proc);
    const texts: string[] = [];
    session.on(SESSION_EVENT.TEXT, (t: string) => texts.push(t));
    const planned = session.send('plan it', { waitForComplete: true, plan: true });
    await tick();
    const first = proc.written.filter((m) => m.method === 'turn/start').at(-1)!;
    expect(first.params?.collaborationMode).toEqual({
      mode: 'plan',
      settings: { model: 'gpt-5.5', reasoning_effort: null, developer_instructions: null },
    });
    notify(proc, 'item/plan/delta', { threadId: 'T', turnId: lastTurnId(), itemId: 'p', delta: '1. Do it' });
    notify(proc, 'item/completed', { threadId: 'T', turnId: lastTurnId(), item: { type: 'plan', text: '1. Do it' } });
    notify(proc, 'turn/completed', { threadId: 'T', turn: { id: lastTurnId(), status: 'completed' } });
    expect(((await planned) as { text: string }).text).toBe('1. Do it');
    expect(texts).toContain('1. Do it');

    const next = session.send('go', { waitForComplete: true });
    await tick();
    const second = proc.written.filter((m) => m.method === 'turn/start').at(-1)!;
    expect((second.params?.collaborationMode as { mode: string }).mode).toBe('default');
    notify(proc, 'turn/completed', { threadId: 'T', turn: { id: lastTurnId(), status: 'completed' } });
    await next;

    const third = session.send('again', { waitForComplete: true });
    await tick();
    expect(proc.written.filter((m) => m.method === 'turn/start').at(-1)!.params?.collaborationMode).toBeUndefined();
    notify(proc, 'turn/completed', { threadId: 'T', turn: { id: lastTurnId(), status: 'completed' } });
    await third;
  });

  it('uses a per-send model for that turn only, billed at it, and restores the session model after', async () => {
    const proc = createMockProc(responder());
    const session = await start(proc, { model: 'gpt-5.5' });
    expect(session.perSendModel).toBe(true);
    const one = session.send('a', { waitForComplete: true, model: 'gpt-5.4-mini' });
    await tick();
    expect(proc.written.filter((m) => m.method === 'turn/start').at(-1)!.params?.model).toBe('gpt-5.4-mini');
    notify(proc, 'thread/tokenUsage/updated', {
      threadId: 'T',
      turnId: lastTurnId(),
      tokenUsage: { total: usage(1_000_000), last: usage(1_000_000) },
    });
    notify(proc, 'turn/completed', { threadId: 'T', turn: { id: lastTurnId(), status: 'completed' } });
    await one;
    const miniCost = session.getStats().costUsd;

    const two = session.send('b', { waitForComplete: true });
    await tick();
    expect(proc.written.filter((m) => m.method === 'turn/start').at(-1)!.params?.model).toBe('gpt-5.5');
    notify(proc, 'thread/tokenUsage/updated', {
      threadId: 'T',
      turnId: lastTurnId(),
      tokenUsage: { total: usage(2_000_000), last: usage(1_000_000) },
    });
    notify(proc, 'turn/completed', { threadId: 'T', turn: { id: lastTurnId(), status: 'completed' } });
    await two;
    const fullCost = session.getStats().costUsd - miniCost;
    expect(fullCost).toBeGreaterThan(miniCost);

    const three = session.send('c', { waitForComplete: true });
    await tick();
    // Restored once; nothing to undo now.
    expect(proc.written.filter((m) => m.method === 'turn/start').at(-1)!.params?.model).toBeUndefined();
    notify(proc, 'turn/completed', { threadId: 'T', turn: { id: lastTurnId(), status: 'completed' } });
    await three;
  });

  it("restores the thread's own effort after a per-send effort on a session that set none", async () => {
    const proc = createMockProc(responder());
    const session = await start(proc);
    const one = session.send('a', { waitForComplete: true, effort: 'low' });
    await tick();
    expect(proc.written.filter((m) => m.method === 'turn/start').at(-1)!.params?.effort).toBe('low');
    notify(proc, 'turn/completed', { threadId: 'T', turn: { id: lastTurnId(), status: 'completed' } });
    await one;
    const two = session.send('b', { waitForComplete: true });
    await tick();
    expect(proc.written.filter((m) => m.method === 'turn/start').at(-1)!.params?.effort).toBe('xhigh');
    notify(proc, 'turn/completed', { threadId: 'T', turn: { id: lastTurnId(), status: 'completed' } });
    await two;
  });

  it('switches model and effort in place with thread/settings/update', async () => {
    const proc = createMockProc(responder());
    const session = await start(proc);
    const atStart = proc.written.length;
    expect(await session.setModelLive('gpt-5.4')).toBe(true);
    expect(await session.setEffortLive('high')).toBe(true);
    expect(await session.setEffortLive('auto')).toBe(false);
    const updates = proc.written
      .slice(atStart)
      .filter((m) => m.method === 'thread/settings/update')
      .map((m) => m.params);
    expect(updates).toEqual([
      { threadId: 'T', model: 'gpt-5.4' },
      { threadId: 'T', effort: 'high' },
    ]);
    expect(session.getCost().model).toBe('gpt-5.4');
  });
});

describe('codex-app — project trust', () => {
  beforeEach(() => mockSpawn.mockReset());

  // A writable thread/start in a git repository records the project as trusted in
  // the user's ~/.codex/config.toml (0.172.0); resume and fork do not.
  it('opens a new thread read-only and gives it its sandbox before any turn', async () => {
    const proc = createMockProc(
      responder((m) =>
        m.method === 'config/read'
          ? { config: { sandbox_workspace_write: { network_access: false, exclude_slash_tmp: true } } }
          : undefined,
      ),
    );
    await start(proc, { codexConfig: { 'sandbox_workspace_write.network_access': true } });
    const methods = proc.written.map((m) => m.method);
    expect(methods.slice(0, 4)).toEqual(['initialize', 'thread/start', 'config/read', 'thread/settings/update']);
    expect(proc.written[1].params?.sandbox).toBe('read-only');
    expect(proc.written[3].params?.sandboxPolicy).toEqual({
      type: 'workspaceWrite',
      writableRoots: [],
      networkAccess: true,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: true,
    });

    const danger = createMockProc(responder());
    await start(danger, { sandboxMode: 'danger-full-access' });
    expect(danger.written.find((m) => m.method === 'thread/settings/update')?.params?.sandboxPolicy).toEqual({
      type: 'dangerFullAccess',
    });
  });

  it('opens a read-only thread, and resumes a thread, as asked, with no settings update', async () => {
    const ro = createMockProc(responder());
    await start(ro, { sandboxMode: 'read-only' });
    expect(ro.written.find((m) => m.method === 'thread/start')?.params?.sandbox).toBe('read-only');
    expect(ro.written.some((m) => m.method === 'thread/settings/update')).toBe(false);

    const resumed = createMockProc(
      responder((m) =>
        m.method === 'thread/resume' ? { thread: { id: 'T' }, sandbox: { type: 'workspaceWrite' } } : undefined,
      ),
    );
    await start(resumed, { resumeSessionId: 'T' });
    expect(resumed.written.find((m) => m.method === 'thread/resume')?.params?.sandbox).toBe('workspace-write');
    expect(resumed.written.some((m) => m.method === 'thread/settings/update')).toBe(false);
  });
});

describe('codex-app — capabilities and commands', () => {
  beforeEach(() => mockSpawn.mockReset());

  it('declares experimentalApi, and names the thread after sessionName', async () => {
    const proc = createMockProc(responder());
    await start(proc, { sessionName: 'nightly fix' });
    expect(proc.written.find((m) => m.method === 'initialize')?.params?.capabilities).toEqual({
      experimentalApi: true,
    });
    expect(proc.written.find((m) => m.method === 'thread/name/set')?.params).toEqual({
      threadId: 'T',
      name: 'nightly fix',
    });
  });

  it('answers a side question with thread/sample after the last turn and counts its usage', async () => {
    const proc = createMockProc(
      responder((msg) =>
        msg.method === 'thread/sample'
          ? {
              text: 'About printing hi.',
              inputTokens: 1000,
              cachedInputTokens: 800,
              outputTokens: 6,
              responseId: 'r',
              sourceTurnId: 'x',
            }
          : undefined,
      ),
    );
    const session = await start(proc);
    const sent = session.send('hi', { waitForComplete: true });
    await tick();
    const turnId = lastTurnId();
    notify(proc, 'turn/completed', { threadId: 'T', turn: { id: turnId, status: 'completed' } });
    await sent;
    const aside = await session.askAside('What was this about?');
    expect(aside.text).toBe('About printing hi.');
    expect(proc.written.find((m) => m.method === 'thread/sample')?.params).toEqual({
      threadId: 'T',
      expectedTurnId: turnId,
      prompt: 'What was this about?',
    });
    expect(session.getStats().tokensIn).toBe(1000);
    expect(session.getStats().turns).toBe(1);
  });

  it('refuses a side question that got no text', async () => {
    const proc = createMockProc(responder((msg) => (msg.method === 'thread/sample' ? { text: null } : undefined)));
    const session = await start(proc);
    const sent = session.send('hi', { waitForComplete: true });
    await tick();
    notify(proc, 'turn/completed', { threadId: 'T', turn: { id: lastTurnId(), status: 'completed' } });
    await sent;
    await expect(session.askAside('q')).rejects.toThrow(/no text answer/);
  });

  it('lists its RPC commands and skills, and runs an info command through its RPC', async () => {
    const proc = createMockProc(
      responder((msg) => {
        if (msg.method === 'skills/list') {
          return {
            data: [
              {
                skills: [
                  { name: 'probe-skill', path: '/s/SKILL.md', enabled: true, scope: 'repo' },
                  { name: 'review', path: '/r/SKILL.md', enabled: true },
                  { name: 'off', path: '/o/SKILL.md', enabled: false },
                ],
              },
            ],
          };
        }
        if (msg.method === 'account/rateLimits/read') {
          return {
            rateLimits: {
              limitId: 'codex',
              primary: { usedPercent: 5, windowDurationMins: 10080, resetsAt: 1796281404 },
              planType: 'pro',
            },
          };
        }
        return undefined;
      }),
    );
    const session = await start(proc);
    expect(session.commandStyle).toBe('rpc');
    const commands = await session.listCommands();
    const names = commands.map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(['status', 'compact', 'review', 'init', 'diff', 'probe-skill']));
    // A sandboxed session is not offered the unsandboxed shell; a skill named like a built-in loses.
    expect(names).not.toContain('shell');
    expect(names).not.toContain('off');
    expect(commands.filter((c) => c.name === 'review')).toHaveLength(1);
    expect(commands.find((c) => c.name === 'status')?.startsTurn).toBe(false);

    const status = await session.runCommand('status');
    expect(status.ok).toBe(true);
    expect(status.startedTurn).toBe(false);
    expect(status.text).toContain('weekly: 5% used');
    await expect(session.runCommand('goal')).rejects.toThrow(/codex_goal_set/);
    await expect(session.runCommand('nope')).rejects.toThrow(/TUI only/);
  });

  it('runs a skill command as a turn with the skill as an input item', async () => {
    const proc = createMockProc(
      responder((msg) =>
        msg.method === 'skills/list'
          ? { data: [{ skills: [{ name: 'probe-skill', path: '/s/SKILL.md', enabled: true }] }] }
          : undefined,
      ),
    );
    const session = await start(proc);
    const run = session.runCommand('probe-skill', 'do it');
    await new Promise((r) => setTimeout(r, 20));
    const turn = proc.written.filter((m) => m.method === 'turn/start').at(-1)!;
    expect(turn.params?.input).toEqual([
      { type: 'skill', name: 'probe-skill', path: '/s/SKILL.md' },
      { type: 'text', text: 'do it', text_elements: [] },
    ]);
    notify(proc, 'item/completed', {
      threadId: 'T',
      turnId: lastTurnId(),
      item: { type: 'agentMessage', text: 'PINEAPPLE' },
    });
    notify(proc, 'turn/completed', { threadId: 'T', turn: { id: lastTurnId(), status: 'completed' } });
    expect(await run).toEqual({ name: 'probe-skill', ok: true, text: 'PINEAPPLE', startedTurn: true });
  });

  it('refuses /shell on a sandboxed session, and runs it as no model turn on danger-full-access', async () => {
    const sandboxed = await start(createMockProc(responder()));
    await expect(sandboxed.runCommand('shell', 'echo hi')).rejects.toThrow(/danger-full-access/);

    const proc = createMockProc(responder());
    const session = await start(proc, { sandboxMode: 'danger-full-access' });
    const run = session.runCommand('shell', 'echo hi');
    await tick();
    expect(proc.written.find((m) => m.method === 'thread/shellCommand')?.params).toMatchObject({
      threadId: 'T',
      command: 'echo hi',
    });
    notify(proc, 'turn/started', { threadId: 'T', turn: { id: 'sh' } });
    notify(proc, 'item/completed', {
      threadId: 'T',
      turnId: 'sh',
      item: { type: 'commandExecution', source: 'userShell', aggregatedOutput: 'hi\n', exitCode: 0 },
    });
    notify(proc, 'turn/completed', { threadId: 'T', turn: { id: 'sh', status: 'completed' } });
    expect(await run).toEqual({ name: 'shell', ok: true, text: 'hi\n', data: { exitCode: 0 }, startedTurn: false });
    expect(session.getStats().turns).toBe(0);
    expect(session.getStats().toolCalls).toBe(0);
  });

  it('answers /rollout with the rollout path thread/start reported', async () => {
    const proc = createMockProc(
      responder((m) =>
        m.method === 'thread/start' ? { thread: { id: 'T', path: '/h/.codex/sessions/rollout-x-T.jsonl' } } : undefined,
      ),
    );
    const session = await start(proc);
    expect(await session.runCommand('rollout')).toEqual({
      name: 'rollout',
      ok: true,
      text: '/h/.codex/sessions/rollout-x-T.jsonl',
      data: { path: '/h/.codex/sessions/rollout-x-T.jsonl' },
      startedTurn: false,
    });
  });

  it("puts the turn's diff on its result and answers /diff with it", async () => {
    const proc = createMockProc(responder());
    const session = await start(proc);
    const sent = session.send('edit', { waitForComplete: true });
    await tick();
    notify(proc, 'turn/diff/updated', { threadId: 'T', turnId: lastTurnId(), diff: 'diff --git a/a b/a\n' });
    notify(proc, 'turn/completed', { threadId: 'T', turn: { id: lastTurnId(), status: 'completed' } });
    const r = (await sent) as { event: Record<string, unknown> };
    expect(r.event.diff).toBe('diff --git a/a b/a\n');
    expect((await session.runCommand('diff')).text).toBe('diff --git a/a b/a\n');
  });

  it('puts every turn in plan mode under turnCommand /plan, and refuses a turnCommand codex cannot take', async () => {
    const proc = createMockProc(responder());
    const session = await start(proc, { turnCommand: '/plan' });
    expect(session.applyTurnCommand('plan', 'msg')).toBe('msg');
    const sent = session.send('msg', { waitForComplete: true });
    await tick();
    expect(
      (proc.written.filter((m) => m.method === 'turn/start').at(-1)!.params?.collaborationMode as { mode: string })
        .mode,
    ).toBe('plan');
    notify(proc, 'turn/completed', { threadId: 'T', turn: { id: lastTurnId(), status: 'completed' } });
    await sent;

    mockSpawn.mockReturnValue(createMockProc(responder()));
    const bad = new PersistentCodexAppServerSession({
      permissionMode: 'bypassPermissions',
      name: 'b',
      cwd: '/tmp',
      engine: 'codex-app',
      turnCommand: '/review now',
    });
    await expect(bad.start()).rejects.toThrow(/turnCommand on Codex/);
  });

  it('rewinds by turns through thread/revert and refuses a message id or files', async () => {
    const proc = createMockProc(
      responder((msg) =>
        msg.method === 'thread/turns/list' ? { data: [{ id: 'b' }, { id: 'a' }], nextCursor: null } : undefined,
      ),
    );
    const session = await start(proc);
    expect(await session.rewind({ turns: 2 })).toEqual({ ok: true, turnsRemoved: 2, filesRestored: false });
    expect(proc.written.find((m) => m.method === 'thread/revert')?.params).toEqual({
      threadId: 'T',
      beforeTurnId: 'a',
    });
    await expect(session.rewind({ messageId: 'm' })).rejects.toThrow(/by turns/);
    await expect(session.rewind({ turns: 1, files: true })).rejects.toThrow(/omit files/);
  });

  it('refuses a goal on an ephemeral thread before asking the server', async () => {
    const proc = createMockProc(responder());
    const session = await start(proc, { noSessionPersistence: true });
    await expect(session.setGoal({ objective: 'x' })).rejects.toThrow(/ephemeral thread does not support goals/);
    expect(proc.written.some((m) => m.method === 'thread/goal/set')).toBe(false);
  });
});

describe('codex-app — exec, the queue, turn settings, approved plans', () => {
  beforeEach(() => mockSpawn.mockReset());

  it("runs /exec in the thread's own sandbox, the user's network setting included", async () => {
    const proc = createMockProc(
      responder((msg) => {
        if (msg.method === 'config/read') return { config: { sandbox_workspace_write: { network_access: true } } };
        if (msg.method === 'command/exec') return { exitCode: 0, stdout: 'ok\n', stderr: '' };
        return undefined;
      }),
    );
    const session = await start(proc);
    const out = await session.runCommand('exec', 'make test');
    expect(out).toMatchObject({ name: 'exec', ok: true, text: 'ok\n', startedTurn: false });
    expect(proc.written.find((m) => m.method === 'command/exec')?.params).toMatchObject({
      command: ['/bin/sh', '-c', 'make test'],
      cwd: '/tmp',
      sandboxPolicy: { type: 'workspaceWrite', networkAccess: true },
    });

    // A read-only thread as thread/start reported it; with no report, the session's mode.
    const ro = createMockProc(
      responder((msg) => {
        if (msg.method === 'thread/start') {
          return { thread: { id: 'T' }, model: 'gpt-5.5', sandbox: { type: 'readOnly', networkAccess: true } };
        }
        return msg.method === 'command/exec' ? { exitCode: 0, stdout: '', stderr: '' } : undefined;
      }),
    );
    const readOnly = await start(ro, { sandboxMode: 'read-only' });
    await readOnly.runCommand('exec', 'ls');
    const policyOf = (p: ReturnType<typeof createMockProc>) =>
      (p.written.find((m) => m.method === 'command/exec')?.params as { sandboxPolicy: unknown }).sandboxPolicy;
    expect(policyOf(ro)).toEqual({ type: 'readOnly', networkAccess: true });
    const bare = createMockProc(
      responder((msg) => (msg.method === 'command/exec' ? { exitCode: 0, stdout: '', stderr: '' } : undefined)),
    );
    await (await start(bare, { sandboxMode: 'read-only' })).runCommand('exec', 'ls');
    expect(policyOf(bare)).toEqual({ type: 'readOnly', networkAccess: false });
  });

  it('queues a message on the thread; the turn the server starts from it is an engine turn', async () => {
    const proc = createMockProc(
      responder((msg) => (msg.method === 'thread/queue/add' ? { queuedSubmission: { id: 'q1' } } : undefined)),
    );
    const session = await start(proc);
    const unsolicited: Array<{ text: string }> = [];
    session.on(SESSION_EVENT.UNSOLICITED_RESULT, (r: { text: string }) => unsolicited.push(r));
    const out = await session.runCommand('queue', 'add Reply with QUEUED.');
    expect(out.data).toEqual({ id: 'q1' });
    expect(proc.written.find((m) => m.method === 'thread/queue/add')?.params).toMatchObject({
      threadId: 'T',
      input: [{ type: 'text', text: 'Reply with QUEUED.' }],
    });
    notify(proc, 'turn/started', { threadId: 'T', turn: { id: 'qt' } });
    notify(proc, 'item/completed', { threadId: 'T', turnId: 'qt', item: { type: 'agentMessage', text: 'QUEUED.' } });
    notify(proc, 'turn/completed', { threadId: 'T', turn: { id: 'qt', status: 'completed' } });
    await tick();
    expect(unsolicited.map((r) => r.text)).toEqual(['QUEUED.']);
    expect(session.getStats().turnsSucceeded).toBe(0);
  });

  it("changes the running turn's model for that turn alone, billed at it until the turn ends", async () => {
    let status = 'applied';
    // 0.172.0 refuses the update unless the session turned the feature on.
    const off = { __rpcError: 'turn settings updates require the step_model_switching feature' };
    const proc = createMockProc(
      responder((msg) => (msg.method === 'turn/settings/update' ? (status === 'off' ? off : { status }) : undefined)),
    );
    const session = await start(proc);
    await expect(session.runCommand('turn', 'effort=low')).rejects.toThrow(/none is running/);
    const sent = session.send('long job', { waitForComplete: true });
    await tick();
    const turnId = lastTurnId();
    notify(proc, 'thread/tokenUsage/updated', { threadId: 'T', turnId, tokenUsage: { total: usage(1000) } });
    await expect(session.runCommand('turn', 'speed=fast')).rejects.toThrow(/model=<id>/);
    const out = await session.runCommand('turn', 'model=gpt-5.4-mini effort=low');
    expect(out).toMatchObject({ name: 'turn', ok: true, startedTurn: false });
    expect(proc.written.find((m) => m.method === 'turn/settings/update')?.params).toEqual({
      threadId: 'T',
      turnId,
      model: 'gpt-5.4-mini',
      effort: 'low',
    });
    notify(proc, 'thread/tokenUsage/updated', { threadId: 'T', turnId, tokenUsage: { total: usage(2000) } });
    notify(proc, 'turn/completed', { threadId: 'T', turn: { id: turnId, status: 'completed' } });
    await sent;
    // A turn the engine starts next (a goal's, a queued message's) bills at the session's model again.
    notify(proc, 'turn/started', { threadId: 'T', turn: { id: 'eng' } });
    notify(proc, 'thread/tokenUsage/updated', { threadId: 'T', turnId: 'eng', tokenUsage: { total: usage(3000) } });
    notify(proc, 'turn/completed', { threadId: 'T', turn: { id: 'eng', status: 'completed' } });
    await tick();
    const full = getModelPricing('gpt-5.5', 'gpt-5.5').input;
    const mini = getModelPricing('gpt-5.4-mini', 'gpt-5.5').input;
    expect(mini).not.toBe(full);
    expect(session.getCost().breakdown.inputCost).toBeCloseTo((2000 * full + 1000 * mini) / 1_000_000, 10);

    // And the next send's turn names no model: the switch was the turn's alone.
    const late = session.send('again', { waitForComplete: true });
    await tick();
    expect(proc.written.filter((m) => m.method === 'turn/start').at(-1)?.params?.model).toBeUndefined();
    status = 'targetUnavailable';
    expect(await session.runCommand('turn', 'summary=concise')).toMatchObject({ ok: false });
    status = 'off';
    await expect(session.runCommand('turn', 'effort=high')).rejects.toThrow(
      /codexFeatures \{ enable: \['step_model_switching'\] \}/,
    );
    notify(proc, 'turn/completed', { threadId: 'T', turn: { id: lastTurnId(), status: 'completed' } });
    await late;
  });

  it('puts an approved plan in the thread and runs the turn Codex prepares, from text or a plan file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'clawo-codex-plan-'));
    try {
      writeFileSync(join(dir, 'PLAN.md'), '1. Write a.txt\n');
      const proc = createMockProc(
        responder((msg) =>
          msg.method === 'thread/prepareApprovedPlan'
            ? {
                prompt: msg.params?.attachmentPath ? 'Read the approved plan and implement it.' : 'Implement the plan.',
              }
            : undefined,
        ),
      );
      const session = await start(proc, { cwd: dir });
      const run = session.runCommand('implement', '1. Write a.txt\n2. Stop.');
      await new Promise((r) => setTimeout(r, 20));
      expect(proc.written.find((m) => m.method === 'thread/prepareApprovedPlan')?.params).toEqual({
        threadId: 'T',
        markdown: '1. Write a.txt\n2. Stop.',
      });
      expect(proc.written.filter((m) => m.method === 'turn/start').at(-1)?.params?.input).toEqual([
        { type: 'text', text: 'Implement the plan.', text_elements: [] },
      ]);
      notify(proc, 'item/completed', {
        threadId: 'T',
        turnId: lastTurnId(),
        item: { type: 'agentMessage', text: 'Done.' },
      });
      notify(proc, 'turn/completed', { threadId: 'T', turn: { id: lastTurnId(), status: 'completed' } });
      expect(await run).toEqual({ name: 'implement', ok: true, text: 'Done.', startedTurn: true });

      const fromFile = session.runCommand('implement', 'PLAN.md');
      await new Promise((r) => setTimeout(r, 20));
      expect(proc.written.filter((m) => m.method === 'thread/prepareApprovedPlan').at(-1)?.params).toEqual({
        threadId: 'T',
        markdown: '1. Write a.txt\n',
        attachmentPath: join(dir, 'PLAN.md'),
      });
      notify(proc, 'turn/completed', { threadId: 'T', turn: { id: lastTurnId(), status: 'completed' } });
      await fromFile;
      await expect(session.runCommand('implement', '  ')).rejects.toThrow(/approved plan/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('cancels a side question it stopped waiting for', async () => {
    const base = responder();
    const proc = createMockProc((msg) => (msg.method === 'thread/sample' ? undefined : base(msg)));
    const session = await start(proc);
    const sent = session.send('hi', { waitForComplete: true });
    await tick();
    notify(proc, 'turn/completed', { threadId: 'T', turn: { id: lastTurnId(), status: 'completed' } });
    await sent;
    await expect(session.askAside('q', { timeout: 30 })).rejects.toThrow(/did not answer thread\/sample/);
    const sample = proc.written.find((m) => m.method === 'thread/sample');
    expect(proc.written.find((m) => m.method === 'thread/sample/cancel')?.params).toEqual({ requestId: sample?.id });
  });

  it('reads skills again after /skills roots adds a directory', async () => {
    const proc = createMockProc(responder((msg) => (msg.method === 'skills/list' ? { data: [] } : undefined)));
    const session = await start(proc);
    const lists = () => proc.written.filter((m) => m.method === 'skills/list').length;
    await session.listCommands();
    await session.listCommands();
    expect(lists()).toBe(1);
    await session.runCommand('skills', 'roots /opt/skills');
    expect(proc.written.find((m) => m.method === 'skills/extraRoots/set')?.params).toEqual({
      extraRoots: ['/opt/skills'],
    });
    await session.listCommands();
    expect(lists()).toBe(2);
  });
});
