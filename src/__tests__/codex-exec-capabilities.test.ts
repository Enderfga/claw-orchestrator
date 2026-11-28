/**
 * engine `codex` (exec): per-send model and effort, plan mode, sub-agent
 * usage from rollouts, and what runs on a short-lived app-server — compaction,
 * side questions, rewinds, reviews, info commands.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mockSpawn = vi.fn();
vi.mock('../engine-spawn.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../engine-spawn.js')>()),
  spawnEngine: (...args: unknown[]) => mockSpawn(...args),
}));

const { PersistentCodexSession } = await import('../persistent-codex-session.js');

const codexHome = mkdtempSync(join(tmpdir(), 'clawo-codex-exec-cap-'));
const originalCodexHome = process.env.CODEX_HOME;
afterAll(() => {
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
  rmSync(codexHome, { recursive: true, force: true });
});

const dayDir = () => join(codexHome, 'sessions', '2026', '11', '28');
function writeRollout(threadId: string, lines: unknown[]): void {
  mkdirSync(dayDir(), { recursive: true });
  writeFileSync(
    join(dayDir(), `rollout-2026-11-28T10-00-00-${threadId}.jsonl`),
    lines.map((l) => JSON.stringify(l)).join('\n') + '\n',
  );
}
const totals = (input: number, cached: number, output: number) => ({
  type: 'event_msg',
  payload: {
    type: 'token_count',
    info: {
      total_token_usage: {
        input_tokens: input,
        cached_input_tokens: cached,
        output_tokens: output,
        reasoning_output_tokens: 0,
      },
      last_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output },
      model_context_window: 400_000,
    },
  },
});

/** One `codex exec` process: it emits the given events when the test says. */
function execProc() {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: Readable;
    stderr: EventEmitter;
    stdin: { written: string; on: ReturnType<typeof vi.fn>; end: (t?: string) => void };
    kill: ReturnType<typeof vi.fn>;
    pid: number;
    exitCode: null;
  };
  proc.stdout = new Readable({ read() {} });
  proc.stderr = new EventEmitter();
  proc.stdin = {
    written: '',
    on: vi.fn(),
    end(t?: string) {
      this.written += t ?? '';
    },
  };
  proc.kill = vi.fn();
  proc.pid = 4242;
  proc.exitCode = null;
  return proc;
}

function finishTurn(proc: ReturnType<typeof execProc>, threadId: string, inputTokens: number, text = 'ok') {
  proc.stdout.push(JSON.stringify({ type: 'thread.started', thread_id: threadId }) + '\n');
  proc.stdout.push(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } }) + '\n');
  proc.stdout.push(
    JSON.stringify({
      type: 'turn.completed',
      usage: { input_tokens: inputTokens, cached_input_tokens: 0, output_tokens: 0 },
    }) + '\n',
  );
  proc.stdout.push(null);
  proc.emit('close', 0);
}

interface Rpc {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
}

/** A short-lived app-server: answers each request, then pushes what `after` returns. */
function appServer(answer: (m: Rpc) => unknown, after?: (m: Rpc) => Array<{ method: string; params: unknown }>) {
  const written: Rpc[] = [];
  const proc = new EventEmitter() as EventEmitter & {
    stdout: Readable;
    stderr: EventEmitter;
    stdin: EventEmitter & { writable: boolean; write: (s: string, cb?: (e?: Error) => void) => boolean };
    kill: ReturnType<typeof vi.fn>;
    pid: number;
    exitCode: number | null;
    written: Rpc[];
  };
  proc.stdout = new Readable({ read() {} });
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn();
  proc.pid = 5151;
  proc.exitCode = null;
  proc.written = written;
  proc.stdin = Object.assign(new EventEmitter(), {
    writable: true,
    write(s: string, cb?: (e?: Error) => void) {
      for (const line of s.split('\n')) {
        if (!line.trim()) continue;
        const m = JSON.parse(line) as Rpc;
        written.push(m);
        if (m.id !== undefined && m.method) {
          const result = answer(m) ?? {};
          proc.stdout.push(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\n');
          for (const n of after?.(m) ?? []) proc.stdout.push(JSON.stringify({ jsonrpc: '2.0', ...n }) + '\n');
        }
      }
      cb?.();
      return true;
    },
  });
  return proc;
}

/** spawnEngine: `codex app-server …` gets `server`, any other `codex …` gets the next exec process. */
function route(server: () => ReturnType<typeof appServer>, execs: Array<ReturnType<typeof execProc>> = []) {
  const servers: Array<ReturnType<typeof appServer>> = [];
  mockSpawn.mockImplementation((_bin: string, args: string[]) => {
    if (args[0] === 'app-server') {
      const s = server();
      servers.push(s);
      return s;
    }
    return execs.shift() ?? execProc();
  });
  return servers;
}

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

/** A session whose first turn has run on thread `id`. */
async function withThread(id: string, config: Record<string, unknown> = {}) {
  const exec = execProc();
  mockSpawn.mockReturnValue(exec);
  const session = new PersistentCodexSession({
    permissionMode: 'bypassPermissions',
    name: 't',
    cwd: '/tmp',
    ...config,
  });
  await session.start();
  const p = session.send('hi', { waitForComplete: true });
  setTimeout(() => finishTurn(exec, id, 1000), 5);
  await p;
  return session;
}

describe('codex exec — per-send model, effort and plan', () => {
  beforeEach(() => {
    process.env.CODEX_HOME = codexHome;
    mockSpawn.mockReset();
  });

  it('runs one turn on a per-send model and effort, billed at that model, and the next on the session’s', async () => {
    const one = execProc();
    const two = execProc();
    mockSpawn.mockReturnValueOnce(one).mockReturnValueOnce(two);
    const session = new PersistentCodexSession({
      permissionMode: 'bypassPermissions',
      name: 't',
      cwd: '/tmp',
      model: 'gpt-5.5',
      effort: 'high',
    });
    expect(session.perSendModel).toBe(true);
    await session.start();
    const a = session.send('a', { waitForComplete: true, model: 'gpt-5.4-mini', effort: 'low' });
    setTimeout(() => finishTurn(one, 'th-1', 1_000_000), 5);
    await a;
    const args1 = mockSpawn.mock.calls[0][1] as string[];
    expect(args1[args1.indexOf('--model') + 1]).toBe('gpt-5.4-mini');
    expect(args1).toContain('model_reasoning_effort=low');
    const miniCost = session.getStats().costUsd;

    const b = session.send('b', { waitForComplete: true });
    setTimeout(() => finishTurn(two, 'th-1', 2_000_000), 5);
    await b;
    const args2 = mockSpawn.mock.calls[1][1] as string[];
    expect(args2[args2.indexOf('--model') + 1]).toBe('gpt-5.5');
    expect(args2).toContain('model_reasoning_effort=high');
    expect(session.getStats().costUsd - miniCost).toBeGreaterThan(miniCost);
  });

  it('prefixes a plan send, and takes /plan and a skill as turnCommand', async () => {
    const one = execProc();
    mockSpawn.mockReturnValueOnce(one);
    const session = new PersistentCodexSession({ permissionMode: 'bypassPermissions', name: 't', cwd: '/tmp' });
    await session.start();
    const p = session.send('fix it', { waitForComplete: true, plan: true });
    setTimeout(() => finishTurn(one, 'th-p', 10), 5);
    await p;
    expect(one.stdin.written).toMatch(/^\[Planning Mode\].*\n\nfix it$/s);

    const planned = new PersistentCodexSession({
      permissionMode: 'bypassPermissions',
      name: 'p',
      cwd: '/tmp',
      turnCommand: '/plan',
    });
    await planned.start();
    expect(planned.applyTurnCommand('plan', 'go')).toMatch(/^\[Planning Mode\]/);
    const skilled = new PersistentCodexSession({
      permissionMode: 'bypassPermissions',
      name: 's',
      cwd: '/tmp',
      turnCommand: '/probe-skill',
    });
    await skilled.start();
    expect(skilled.applyTurnCommand('probe-skill', 'go')).toBe('$probe-skill go');
    await expect(
      new PersistentCodexSession({
        permissionMode: 'bypassPermissions',
        name: 'x',
        cwd: '/tmp',
        turnCommand: '/compact',
      }).start(),
    ).rejects.toThrow(/turnCommand on Codex/);
  });

  it('switches model and effort live: the next process takes them', async () => {
    const session = new PersistentCodexSession({ permissionMode: 'bypassPermissions', name: 't', cwd: '/tmp' });
    await session.start();
    expect(await session.setModelLive('gpt-5.4')).toBe(true);
    expect(await session.setEffortLive('low')).toBe(true);
    expect(session.getCost().model).toBe('gpt-5.4');
  });
});

describe('codex exec — sub-agent usage', () => {
  beforeEach(() => {
    process.env.CODEX_HOME = codexHome;
    mockSpawn.mockReset();
  });

  it("adds the sub-agents' usage, read from their rollouts, to the session's", async () => {
    writeRollout('01a220f3-9100-7843-b2ac-1afc49cf08bd', [
      { type: 'turn_context', payload: { model: 'gpt-5.5' } },
      {
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          item: { type: 'SubAgentActivity', kind: 'started', agent_thread_id: '01a220f3-a5e2-7f13-9299-e2f990ebe5ed' },
        },
      },
      totals(1000, 0, 10),
    ]);
    writeRollout('01a220f3-a5e2-7f13-9299-e2f990ebe5ed', [
      { type: 'turn_context', payload: { model: 'gpt-5.4-mini' } },
      totals(500, 100, 5),
    ]);
    const session = await withThread('01a220f3-9100-7843-b2ac-1afc49cf08bd');
    const stats = session.getStats();
    expect(stats.tokensIn).toBe(1500);
    expect(stats.cachedTokens).toBe(100);
  });
});

describe('codex exec — the short-lived app-server', () => {
  beforeEach(() => {
    process.env.CODEX_HOME = codexHome;
    mockSpawn.mockReset();
  });

  const THREAD = '01a2210c-0000-7000-8000-000000000001';

  it('compacts the thread: resume, compact/start, and waits for the compaction turn', async () => {
    const session = await withThread(THREAD);
    const servers = route(() =>
      appServer(
        () => ({}),
        (m) =>
          m.method === 'thread/compact/start'
            ? [
                { method: 'turn/started', params: { threadId: THREAD, turn: { id: 'c1', rootTurnId: 'c1' } } },
                {
                  method: 'thread/tokenUsage/updated',
                  params: {
                    threadId: THREAD,
                    turnId: 'c1',
                    tokenUsage: { last: { inputTokens: 0, totalTokens: 700 } },
                  },
                },
                {
                  method: 'turn/completed',
                  params: { threadId: THREAD, turn: { id: 'c1', rootTurnId: 'c1', status: 'completed' } },
                },
              ]
            : [],
      ),
    );
    const outcome = await session.compactDetailed();
    expect(outcome).toEqual({ ok: true, trigger: 'manual', preTokens: 1000, postTokens: 700 });
    const [server] = servers;
    expect((mockSpawn.mock.calls.at(-1)![1] as string[]).slice(0, 3)).toEqual(['app-server', '--listen', 'stdio://']);
    expect(server.written.map((m) => m.method)).toEqual(['initialize', 'thread/resume', 'thread/compact/start']);
    expect(server.written[0].params?.capabilities).toEqual({ experimentalApi: true });
    expect(server.written[1].params).toMatchObject({ threadId: THREAD, excludeTurns: true, approvalPolicy: 'never' });
    expect(session.getStats().turns).toBe(1);
    expect(server.kill).toHaveBeenCalled();
  });

  it('answers a side question with thread/sample after the latest turn, and counts its usage', async () => {
    const session = await withThread(THREAD);
    const before = session.getStats().tokensIn;
    const servers = route(() =>
      appServer((m) => {
        if (m.method === 'thread/turns/list') return { data: [{ id: 'last-turn' }] };
        if (m.method === 'thread/sample')
          return { text: 'It printed hi.', inputTokens: 200, cachedInputTokens: 0, outputTokens: 4 };
        return {};
      }),
    );
    expect(await session.askAside('what happened?')).toEqual({ text: 'It printed hi.' });
    expect(servers[0].written.find((m) => m.method === 'thread/sample')?.params).toEqual({
      threadId: THREAD,
      expectedTurnId: 'last-turn',
      prompt: 'what happened?',
    });
    expect(session.getStats().tokensIn - before).toBe(200);
  });

  it('rewinds the thread by turns with thread/revert', async () => {
    const session = await withThread(THREAD);
    const servers = route(() =>
      appServer((m) =>
        m.method === 'thread/turns/list' ? { data: [{ id: 't3' }, { id: 't2' }], nextCursor: null } : {},
      ),
    );
    expect(await session.rewind({ turns: 2 })).toEqual({ ok: true, turnsRemoved: 2, filesRestored: false });
    expect(servers[0].written.find((m) => m.method === 'thread/revert')?.params).toEqual({
      threadId: THREAD,
      beforeTurnId: 't2',
    });
    await expect(session.rewind({ turns: 1, files: true })).rejects.toThrow(/omit files/);
  });

  it('reviews on the thread: review/start inline, the review as the answer, the reviewer’s rollout as its spend', async () => {
    const session = await withThread(THREAD);
    const servers = route(() =>
      appServer(
        (m) => (m.method === 'review/start' ? { turn: { id: 'rv' }, reviewThreadId: THREAD } : {}),
        (m) => {
          if (m.method !== 'review/start') return [];
          writeRollout('01a2210c-e8c3-7fc3-977b-7706eeb40633', [
            {
              timestamp: new Date().toISOString(),
              type: 'session_meta',
              payload: { parent_thread_id: THREAD, source: { subagent: 'review' } },
            },
            totals(3000, 1000, 50),
          ]);
          return [
            { method: 'turn/started', params: { threadId: THREAD, turn: { id: 'inner', rootTurnId: 'rv' } } },
            {
              method: 'item/completed',
              params: { threadId: THREAD, turnId: 'rv', item: { type: 'exitedReviewMode', review: '[P1] bug' } },
            },
            {
              method: 'turn/completed',
              params: { threadId: THREAD, turn: { id: 'rv', rootTurnId: 'rv', status: 'completed' } },
            },
          ];
        },
      ),
    );
    const before = session.getStats();
    const outcome = await session.runCommand('review', 'commit abc123');
    expect(outcome).toEqual({ name: 'review', ok: true, text: '[P1] bug', startedTurn: true });
    expect(servers[0].written.find((m) => m.method === 'review/start')?.params).toEqual({
      threadId: THREAD,
      target: { type: 'commit', sha: 'abc123' },
    });
    const after = session.getStats();
    expect(after.turnsSucceeded).toBe(before.turnsSucceeded + 1);
    expect(after.tokensIn - before.tokensIn).toBe(3000);
  });

  it('runs an info command on an app-server of its own, before any turn', async () => {
    const servers = route(() =>
      appServer((m) =>
        m.method === 'account/rateLimits/read'
          ? {
              rateLimits: { limitId: 'codex', primary: { usedPercent: 12, windowDurationMins: 300 }, planType: 'plus' },
            }
          : {},
      ),
    );
    const session = new PersistentCodexSession({ permissionMode: 'bypassPermissions', name: 't', cwd: '/tmp' });
    await session.start();
    const outcome = await session.runCommand('status');
    expect(outcome.ok).toBe(true);
    expect(outcome.text).toContain('5h: 12% used');
    expect(servers[0].written.map((m) => m.method)).toEqual(['initialize', 'account/rateLimits/read', 'account/read']);
    await expect(session.runCommand('rename', 'x')).rejects.toThrow(/first message/);
    await expect(session.runCommand('thread')).rejects.toThrow(/first message/);
    await expect(session.runCommand('ps')).rejects.toThrow(/runs on codex-app only/);
  });

  it('reads the stored thread on an app-server of its own without loading it, a turn in flight or not', async () => {
    const session = await withThread(THREAD);
    const servers = route(() =>
      appServer((m) =>
        m.method === 'thread/read'
          ? { thread: { id: THREAD, status: { type: 'notLoaded' }, cwd: '/tmp' } }
          : m.method === 'thread/searchOccurrences'
            ? { data: [{ turnId: 'u1', itemId: 'i1', snippet: 'hi' }] }
            : {},
      ),
    );
    expect((await session.runCommand('thread')).text).toContain('status: notLoaded');
    expect((await session.runCommand('search', 'hi')).text).toBe('u1 i1: hi');
    const methods = servers.flatMap((s) => s.written.map((m) => m.method));
    expect(methods).toEqual(['initialize', 'thread/read', 'initialize', 'thread/searchOccurrences']);
    expect(methods).not.toContain('thread/resume');
  });

  it("runs /exec in a sandbox built from the session's mode, addDir writable", async () => {
    const servers = route(() =>
      appServer((m) => (m.method === 'command/exec' ? { exitCode: 0, stdout: 'ok\n', stderr: '' } : {})),
    );
    const session = new PersistentCodexSession({
      permissionMode: 'bypassPermissions',
      name: 't',
      cwd: '/tmp',
      addDir: ['../var/out'],
    });
    await session.start();
    expect(await session.runCommand('exec', 'echo ok', { timeout: 9000 })).toMatchObject({ ok: true, text: 'ok\n' });
    expect(servers[0].written.find((m) => m.method === 'command/exec')?.params).toEqual({
      command: ['/bin/sh', '-c', 'echo ok'],
      cwd: '/tmp',
      sandboxPolicy: {
        type: 'workspaceWrite',
        writableRoots: ['/var/out'],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      },
      timeoutMs: 9000,
    });
    await expect(session.runCommand('queue', 'add x')).rejects.toThrow(/runs on codex-app only/);
  });

  it('runs a skill as a $name mention turn', async () => {
    route(() =>
      appServer((m) =>
        m.method === 'skills/list'
          ? { data: [{ skills: [{ name: 'probe-skill', path: '/s/SKILL.md', enabled: true }] }] }
          : {},
      ),
    );
    const exec = execProc();
    const session = new PersistentCodexSession({ permissionMode: 'bypassPermissions', name: 't', cwd: '/tmp' });
    await session.start();
    const servers = route(
      () =>
        appServer((m) =>
          m.method === 'skills/list'
            ? { data: [{ skills: [{ name: 'probe-skill', path: '/s/SKILL.md', enabled: true }] }] }
            : {},
        ),
      [exec],
    );
    const run = session.runCommand('probe-skill', 'go');
    await tick(30);
    finishTurn(exec, 'th-s', 10, 'PINEAPPLE-42');
    expect(await run).toEqual({ name: 'probe-skill', ok: true, text: 'PINEAPPLE-42', startedTurn: true });
    expect(exec.stdin.written).toBe('$probe-skill go');
    expect(servers.length).toBe(1);
  });
});
