/**
 * PersistentOpencodeSession on OpenCode 2's held server: turns as `run
 * --server` clients, steering, interrupts, commands, compaction, asides,
 * rewinds, plan turns, per-send models, turn commands — and OpenCode 1's
 * `run --command`.
 *
 * The server is a fake (`OpencodeServer` replaced) answering the API calls
 * the wrapper and the real `followSessionWork` make from an in-memory message
 * list; `opencode run` is a mocked process, as in opencode-session.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';

import type { SessionConfig } from '../types.js';

const mockSpawn = vi.fn();
const versions: Record<string, string> = {};
vi.mock('../engine-spawn.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../engine-spawn.js')>()),
  spawnEngine: (...args: unknown[]) => mockSpawn(...args),
  killEngineTree: vi.fn(),
  execEngine: async (bin: string, args: string[] = []) => {
    if (args[0] === '--version') return { stdout: `${versions[bin] ?? 'opencode v2.4.2'}\n`, stderr: '' };
    return { stdout: '', stderr: '' };
  },
}));

type Call = { method: string; path: string; body?: unknown; query?: Record<string, string> };
type Handler = (c: Call) => unknown;
const srv = {
  failStart: false,
  /** How long a start takes before the URL arrives. */
  startDelayMs: 0,
  started: 0,
  stopped: 0,
  calls: [] as Call[],
  handler: (() => undefined) as Handler,
};
vi.mock('../opencode-server.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../opencode-server.js')>();
  class FakeServer {
    password = 'pw-test';
    url?: string;
    private _alive = false;
    get alive() {
      return this._alive;
    }
    get pid() {
      return 4242;
    }
    clientEnv(base: NodeJS.ProcessEnv) {
      return { ...base, OPENCODE_PASSWORD: this.password };
    }
    async start() {
      srv.started++;
      if (srv.startDelayMs) await new Promise((r) => setTimeout(r, srv.startDelayMs));
      if (srv.failStart) throw new Error('opencode serve printed no URL');
      this._alive = true;
      this.url = 'http://127.0.0.1:4096';
      return this.url;
    }
    stop() {
      if (this._alive) srv.stopped++;
      this._alive = false;
    }
    async call(method: string, path: string, body?: unknown, opts?: { query?: Record<string, string> }) {
      const c = { method, path, body, query: opts?.query };
      srv.calls.push(c);
      return srv.handler(c);
    }
  }
  return { ...real, OpencodeServer: FakeServer };
});

const { PersistentOpencodeSession, modelRef } = await import('../persistent-opencode-session.js');
const { OpencodeApiError } = await import('../opencode-server.js');

// ─── Helpers ────────────────────────────────────────────────────────────────

function createMockProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: Readable;
    stderr: EventEmitter & { destroy: ReturnType<typeof vi.fn> };
    stdin: { end: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn> };
    kill: ReturnType<typeof vi.fn>;
    pid: number;
    exitCode: null;
  };
  proc.stdout = new Readable({ read() {} });
  const stderr = new EventEmitter() as EventEmitter & { destroy: ReturnType<typeof vi.fn> };
  stderr.destroy = vi.fn();
  proc.stderr = stderr;
  proc.stdin = { end: vi.fn(), on: vi.fn() };
  proc.kill = vi.fn();
  proc.pid = 34567;
  proc.exitCode = null;
  return proc;
}
type Proc = ReturnType<typeof createMockProcess>;

const SID = 'ses_held1';
const line = (type: string, data: Record<string, unknown>) =>
  JSON.stringify({ type, timestamp: 1, sessionID: SID, ...data });

/** The run's lines, then its exit once readline has read them. */
function finish(p: Proc, lines: string[] = [], code = 0) {
  for (const l of lines) p.stdout.push(l + '\n');
  p.stdout.push(null);
  setTimeout(() => p.emit('close', code), 5);
}

type Msg = Record<string, unknown> & { id: string; type: string };

/** An in-memory OpenCode conversation behind the fake server. */
function fakeApi() {
  const api = {
    messages: [] as Msg[],
    perms: [] as Array<{ id: string; sessionID: string; action: string }>,
    forms: [] as Array<{ id: string; sessionID: string; title: string }>,
    commands: [
      { name: 'init', description: 'guided AGENTS.md setup' },
      { name: 'review', description: 'review changes' },
      { name: 'goal', description: 'keep working until an objective is met' },
      { name: 'pineapple', description: 'probe' },
    ] as Array<{ name: string; description?: string }>,
    /** What a command or compaction writes when it is posted. */
    onWork: (c: Call): Msg[] => [
      { id: `m${api.seq++}`, type: 'user', text: `expanded ${(c.body as { name?: string })?.name}` },
      {
        id: `m${api.seq++}`,
        type: 'assistant',
        time: { created: 1, completed: 2 },
        finish: 'stop',
        content: [
          { type: 'tool', name: 'read', state: { status: 'completed' } },
          { type: 'text', text: 'COMMAND-REPLY' },
        ],
        tokens: { input: 40, output: 7, reasoning: 0, cache: { read: 1000, write: 0 } },
        cost: 0.02,
      },
      { id: `m${api.seq++}`, type: 'idle', outcome: 'succeeded' },
    ],
    /** Set to answer a POST with an error. */
    fail: undefined as undefined | ((c: Call) => Error | undefined),
    seq: 1,
    staged: undefined as undefined | { messageID: string; files: boolean },
  };
  srv.handler = (c) => {
    const err = api.fail?.(c);
    if (err) throw err;
    const { method, path } = c;
    if (method === 'GET' && path === '/api/command') return { data: api.commands };
    if (method === 'GET' && path === '/api/permission/request') return { data: api.perms };
    if (method === 'GET' && path === '/api/form') return { data: api.forms };
    if (method === 'GET' && path === '/api/session/active') return { data: {} };
    if (method === 'GET' && path === '/api/model/default')
      return { data: { providerID: 'opencode', modelID: 'house-default' } };
    if (method === 'GET' && /\/message$/.test(path)) {
      const limit = Number(c.query?.limit ?? 100);
      return { data: [...api.messages].reverse().slice(0, limit) };
    }
    if (method === 'POST' && path === '/api/session') return { data: { id: SID } };
    if (method === 'POST' && /\/(command|compact)$/.test(path)) {
      api.messages.push(...api.onWork(c));
      return undefined;
    }
    if (method === 'POST' && /\/permission\/[^/]+\/reply$/.test(path)) {
      api.perms = [];
      return undefined;
    }
    if (method === 'DELETE' && /\/form\//.test(path)) {
      api.forms = [];
      return undefined;
    }
    if (method === 'POST' && /\/generate$/.test(path)) {
      return {
        data: {
          text: 'ASIDE',
          tokens: { input: 10, output: 3, reasoning: 0, cache: { read: 500, write: 0 } },
          cost: 0.01,
        },
      };
    }
    if (method === 'POST' && /\/revert\/stage$/.test(path)) {
      api.staged = c.body as { messageID: string; files: boolean };
      return { data: { messageID: api.staged.messageID, files: api.staged.files ? [{ file: 'a.txt' }] : [] } };
    }
    if (method === 'POST' && /\/revert\/commit$/.test(path)) {
      const at = api.messages.findIndex((m) => m.id === api.staged?.messageID);
      if (at >= 0) api.messages.splice(at);
      return undefined;
    }
    if (method === 'POST' && /\/shell$/.test(path)) {
      api.messages.push({
        id: `m${api.seq++}`,
        type: 'shell',
        status: 'exited',
        exit: 0,
        output: { output: 'SHELL-OUT\n' },
      });
      return undefined;
    }
    return undefined;
  };
  return api;
}

const V2 = 'opencode-held';
const V1 = 'opencode-one';

describe('OpenCode 2 held server', () => {
  let proc: Proc;
  let api: ReturnType<typeof fakeApi>;
  const sessions: Array<InstanceType<typeof PersistentOpencodeSession>> = [];

  const oc = async (config: Partial<SessionConfig> = {}, bin = V2) => {
    const s = new PersistentOpencodeSession({ name: 't', cwd: '/tmp', permissionMode: 'default', ...config }, bin);
    (s as unknown as { serverPollMs: number }).serverPollMs = 2;
    sessions.push(s);
    await s.start();
    return s;
  };

  /** One `run` turn: the args it was spawned with, and its result. */
  const turn = async (
    s: InstanceType<typeof PersistentOpencodeSession>,
    opts: Record<string, unknown> = {},
    lines: string[] = [line('text', { part: { id: 'p', type: 'text', text: 'OK' } })],
  ) => {
    const p = createMockProcess();
    mockSpawn.mockReturnValueOnce(p);
    const sent = s.send('hi', { waitForComplete: true, ...opts });
    await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalledTimes(spawned + 1));
    spawned++;
    finish(p, lines);
    const result = await sent;
    const call = mockSpawn.mock.calls.at(-1) as [string, string[], { env: NodeJS.ProcessEnv }];
    return { args: call[1], env: call[2].env, result };
  };
  let spawned = 0;

  beforeEach(() => {
    versions[V2] = 'opencode v2.4.2';
    versions[V1] = '1.19.6';
    delete process.env.CLAWO_OPENCODE_STANDALONE;
    mockSpawn.mockReset();
    proc = createMockProcess();
    spawned = 0;
    srv.failStart = false;
    srv.startDelayMs = 0;
    srv.started = 0;
    srv.stopped = 0;
    srv.calls = [];
    api = fakeApi();
  });

  afterEach(() => {
    for (const s of sessions.splice(0)) s.stop();
    vi.useRealTimers();
  });

  describe('turns', () => {
    it('runs a turn as a client of the held server, with its password, and keeps the server', async () => {
      const s = await oc();
      const { args, env } = await turn(s);
      expect(args.slice(0, 5)).toEqual(['run', '--format', 'json', '--server', 'http://127.0.0.1:4096']);
      expect(args).not.toContain('--standalone');
      expect(env.OPENCODE_PASSWORD).toBe('pw-test');
      await turn(s);
      expect(srv.started).toBe(1);
    });

    it('falls back to --standalone when the server does not start, and stops trying after two failures', async () => {
      srv.failStart = true;
      const s = await oc();
      expect((await turn(s)).args).toContain('--standalone');
      await turn(s);
      await turn(s);
      expect(srv.started).toBe(2);
    });

    it('runs on --standalone with CLAWO_OPENCODE_STANDALONE=1', async () => {
      process.env.CLAWO_OPENCODE_STANDALONE = '1';
      const s = await oc();
      expect((await turn(s)).args).toContain('--standalone');
      expect(srv.started).toBe(0);
    });

    it('stops the held server once nothing has used it for serverIdleMs, and starts a new one when needed', async () => {
      const s = await oc();
      (s as unknown as { serverIdleMs: number }).serverIdleMs = 20;
      await turn(s);
      await vi.waitFor(() => expect(srv.stopped).toBe(1));
      await turn(s);
      expect(srv.started).toBe(2);
    });

    it('stops the held server with the session', async () => {
      const s = await oc();
      await turn(s);
      s.stop();
      expect(srv.stopped).toBe(1);
    });
  });

  describe('steering and interrupts', () => {
    it('hands text to the turn in flight with /prompt delivery steer', async () => {
      const s = await oc();
      await turn(s, {}, [line('text', { part: { id: 'p', type: 'text', text: 'OK' } })]);
      const p = createMockProcess();
      mockSpawn.mockReturnValueOnce(p);
      const sent = s.send('again', { waitForComplete: true });
      await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalledTimes(2));
      expect(await s.deliverMidTurn('STEER')).toBe(true);
      expect(srv.calls.find((c) => c.path === `/api/session/${SID}/prompt`)?.body).toEqual({
        text: 'STEER',
        delivery: 'steer',
      });
      finish(p);
      await sent;
      // No turn in flight: the caller queues it.
      expect(await s.deliverMidTurn('LATER')).toBe(false);
    });

    it('cannot steer an OpenCode 1 turn', async () => {
      const s = await oc({}, V1);
      expect(await s.deliverMidTurn('x')).toBe(false);
    });

    it("interrupts a server turn through the server's /interrupt, and maps its error to interrupted", async () => {
      const s = await oc();
      await turn(s);
      const p = createMockProcess();
      mockSpawn.mockReturnValueOnce(p);
      const results: unknown[] = [];
      s.on('result', (e) => results.push(e));
      const sent = s.send('long', { waitForComplete: true });
      await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalledTimes(2));
      expect(s.interruptRun()).toBe(true);
      await vi.waitFor(() => expect(srv.calls.some((c) => c.path === `/api/session/${SID}/interrupt`)).toBe(true));
      // `run` ends on the server's `aborted` error.
      finish(p, [line('error', { error: { type: 'aborted', message: 'Session interrupted: user' } })], 1);
      await expect(sent).rejects.toThrow(/Session interrupted/);
      expect((results.at(-1) as { stop_reason?: string }).stop_reason).toBe('interrupted');
      expect(srv.stopped).toBe(0);
    });

    it('stops the whole server to interrupt a first turn whose conversation id is not known yet', async () => {
      const s = await oc();
      const p = createMockProcess();
      mockSpawn.mockReturnValueOnce(p);
      const sent = s.send('first', { waitForComplete: true });
      await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalledTimes(1));
      expect(s.interruptRun()).toBe(true);
      expect(srv.stopped).toBe(1);
      finish(p, [], 1);
      await expect(sent).rejects.toThrow();
    });
  });

  describe('commands', () => {
    it("lists OpenCode's commands, then clawo's operations; a read-only session is not offered shell", async () => {
      const s = await oc();
      const list = await s.listCommands!();
      expect(list.find((c) => c.name === 'review')).toMatchObject({ source: 'builtin', startsTurn: true });
      expect(list.find((c) => c.name === 'pineapple')).toMatchObject({ source: 'custom', startsTurn: true });
      expect(list.find((c) => c.name === 'compact')).toMatchObject({ source: 'rpc', startsTurn: true });
      expect(list.find((c) => c.name === 'models')).toMatchObject({ source: 'rpc', startsTurn: false });
      expect(list.some((c) => c.name === 'shell')).toBe(true);
      const ro = await oc({ sandboxMode: 'read-only' });
      expect((await ro.listCommands!()).some((c) => c.name === 'shell')).toBe(false);
    });

    it('two operations that open the server at once share one start', async () => {
      const s = await oc();
      srv.startDelayMs = 30;
      const [a, b] = await Promise.all([s.runCommand('mcp'), s.runCommand('mcp')]);
      expect([a.ok, b.ok]).toEqual([true, true]);
      expect({ started: srv.started, stopped: srv.stopped }).toEqual({ started: 1, stopped: 0 });
    });

    it('reads a listing again while a fresh server still answers it empty', async () => {
      const s = await oc();
      let reads = 0;
      const all = api.commands;
      api.commands = [];
      const base = srv.handler;
      srv.handler = (c) => {
        if (c.path === '/api/command' && ++reads === 3) api.commands = all;
        return base(c);
      };
      expect((await s.listCommands!()).some((c) => c.name === 'pineapple')).toBe(true);
    });

    it("an engine command's name is not taken by clawo's operation of the same name", async () => {
      api.commands.push({ name: 'models', description: "the project's own" });
      const s = await oc();
      const out = await s.runCommand('models');
      expect(
        srv.calls.some(
          (c) => c.method === 'POST' && c.path.endsWith('/command') && (c.body as { name?: string }).name === 'models',
        ),
      ).toBe(true);
      expect(out.startedTurn).toBe(true);
    });

    it('runs a command on the server and follows it to idle: text, tools, usage and one turn', async () => {
      const s = await oc({ model: 'opencode/big-pickle' });
      const texts: string[] = [];
      const out = await s.runCommand('pineapple', 'mango', { callbacks: { onText: (t) => texts.push(t) } });
      expect(out).toMatchObject({ name: 'pineapple', ok: true, text: 'COMMAND-REPLY', startedTurn: true });
      expect(texts).toEqual(['COMMAND-REPLY']);
      // The conversation was made for it, on the session's model.
      expect(srv.calls.find((c) => c.path === '/api/session')?.body).toMatchObject({
        model: { providerID: 'opencode', id: 'big-pickle' },
      });
      expect(srv.calls.find((c) => c.path.endsWith('/command'))?.body).toEqual({ name: 'pineapple', text: 'mango' });
      const stats = s.getStats();
      expect(stats).toMatchObject({
        turns: 1,
        turnsSucceeded: 1,
        toolCalls: 1,
        tokensIn: 40,
        tokensOut: 7,
        cachedTokens: 1000,
      });
      expect(stats.costUsd).toBe(0.02);
      expect(stats.contextPercent).toBeGreaterThan(0);
      expect(s.sessionId).toBe(`opencode-live-${SID}`);
    });

    it('a command the server refuses is no turn', async () => {
      const s = await oc();
      api.fail = (c) =>
        c.path.endsWith('/command')
          ? new OpencodeApiError(404, 'CommandNotFoundError', 'Command not found: nope')
          : undefined;
      const out = await s.runCommand('nope');
      expect(out).toMatchObject({ ok: false, startedTurn: false });
      expect(out.error).toMatch(/Command not found/);
      expect(s.getStats().turns).toBe(0);
    });

    it('a command whose run fails is a failed turn, with the reason', async () => {
      const s = await oc();
      api.onWork = () => [
        { id: 'u1', type: 'user', text: 'x' },
        { id: 'a1', type: 'assistant', finish: 'error', content: [], error: { message: 'Free usage limit reached' } },
        { id: 'i1', type: 'idle', outcome: 'failed', error: { message: 'Free usage limit reached' } },
      ];
      const out = await s.runCommand('review');
      expect(out).toMatchObject({ ok: false, startedTurn: true, error: 'Free usage limit reached' });
      expect(s.getStats()).toMatchObject({ turns: 1, turnsSucceeded: 0 });
    });

    it('rejects permission requests and cancels question forms while it follows, as run does', async () => {
      const s = await oc();
      const work = api.onWork;
      let polls = 0;
      api.onWork = () => [];
      const base = srv.handler;
      srv.handler = (c) => {
        if (c.path === '/api/permission/request' && ++polls === 1) {
          api.perms = [{ id: 'per1', sessionID: SID, action: 'edit' }];
          api.forms = [{ id: 'frm1', sessionID: SID, title: 'Which?' }];
        }
        if (c.path === '/api/form' && polls === 2) api.messages.push(...work(c));
        return base(c);
      };
      await s.runCommand('init');
      expect(srv.calls.find((c) => c.path.endsWith('/permission/per1/reply'))?.body).toEqual({ decision: 'reject' });
      const cancel = srv.calls.find((c) => c.method === 'DELETE' && c.path.endsWith('/form/frm1'));
      expect(cancel?.query?.message).toMatch(/cannot ask the user questions/);
    });

    it("answers a permission request 'once' under dangerouslySkipPermissions, never on a read-only session", async () => {
      for (const [config, decision] of [
        [{ dangerouslySkipPermissions: true }, 'once'],
        [{ dangerouslySkipPermissions: true, sandboxMode: 'read-only' as const }, 'reject'],
      ] as const) {
        srv.calls = [];
        api = fakeApi();
        api.perms = [{ id: 'per2', sessionID: SID, action: 'shell' }];
        const s = await oc(config);
        await s.runCommand('init');
        expect(srv.calls.find((c) => c.path.endsWith('/permission/per2/reply'))?.body).toEqual({ decision });
      }
    });

    it("a read-only session's command runs its read-only agent", async () => {
      const s = await oc({ sandboxMode: 'read-only' });
      await s.runCommand('pineapple');
      expect(srv.calls.find((c) => c.path === `/api/session/${SID}/agent`)?.body).toEqual({ agent: 'clawo-readonly' });
    });

    it('refuses shell on a read-only session and runs it otherwise', async () => {
      const ro = await oc({ sandboxMode: 'read-only' });
      const refused = await ro.runCommand('shell', 'touch x');
      expect(refused).toMatchObject({ ok: false, startedTurn: false });
      expect(refused.error).toMatch(/read-only/);
      expect(srv.calls.some((c) => c.path.endsWith('/shell'))).toBe(false);
      const s = await oc();
      const out = await s.runCommand('shell', 'echo hi');
      expect(out).toMatchObject({ ok: true, text: 'SHELL-OUT\n', startedTurn: false });
      expect(srv.calls.find((c) => c.path.endsWith('/shell'))?.body).toEqual({ command: 'echo hi' });
    });

    it('/goal pause and /goal clear return at once with the goal state', async () => {
      const s = await oc();
      const base = srv.handler;
      srv.handler = (c) =>
        c.path === '/api/rpc/opencode.goal/get' ? { output: { objective: 'o', status: 'paused' } } : base(c);
      api.onWork = () => [];
      const out = await s.runCommand('goal', 'pause');
      expect(out).toMatchObject({ ok: true, startedTurn: false, data: { status: 'paused' } });
    });

    it('routes a turn under the turn command through the command', async () => {
      const s = await oc();
      const sent = s.applyTurnCommand('pineapple', 'papaya');
      expect(sent).toBe('papaya');
      const r = (await s.send(sent, { waitForComplete: true })) as { text: string };
      expect(r.text).toBe('COMMAND-REPLY');
      expect(srv.calls.find((c) => c.path.endsWith('/command'))?.body).toEqual({ name: 'pineapple', text: 'papaya' });
      expect(mockSpawn).not.toHaveBeenCalled();
    });
  });

  describe('compaction, asides, rewinds', () => {
    it('compacts on the server, waits, and reports the context before and after', async () => {
      const s = await oc();
      await turn(s, {}, [
        line('step_finish', {
          part: { type: 'step-finish', cost: 0, tokens: { input: 100, output: 5, cache: { read: 9900, write: 0 } } },
        }),
      ]);
      api.onWork = () => [
        {
          id: `c${api.seq++}`,
          type: 'compaction',
          status: 'completed',
          reason: 'manual',
          summary: '## Objective',
          tokens: { input: 10000, output: 120, reasoning: 0, cache: { read: 0, write: 0 } },
          cost: 0.05,
        },
        { id: `i${api.seq++}`, type: 'idle', outcome: 'succeeded' },
      ];
      const before = s.getStats().contextPercent;
      const out = await s.compactDetailed!();
      expect(out).toMatchObject({ ok: true, trigger: 'manual', preTokens: 10000, postTokens: 120 });
      expect(s.getStats().contextPercent).toBeLessThan(before);
      expect(s.getStats().costUsd).toBe(0.05);
      // Through compact() too, for its callers.
      const r = await s.compact();
      expect(r.event.compacted).toBe(true);
      expect(s.getStats().costUsd).toBe(0.1);
    });

    it('says when a compaction did not complete', async () => {
      const s = await oc();
      await turn(s);
      api.onWork = () => [
        { id: 'c1', type: 'compaction', status: 'failed', reason: 'manual', error: { message: 'context too small' } },
        { id: 'i2', type: 'idle', outcome: 'failed' },
      ];
      expect(await s.compactDetailed!()).toMatchObject({ ok: false, note: 'context too small' });
    });

    it("answers a side question from the conversation with /generate, at the session's cost", async () => {
      const s = await oc();
      await expect(s.askAside!('q')).rejects.toThrow(/no turn yet/);
      await turn(s);
      expect(await s.askAside!('which word?')).toEqual({ text: 'ASIDE' });
      expect(srv.calls.find((c) => c.path.endsWith('/generate'))?.body).toEqual({ prompt: 'which word?' });
      expect(s.getStats().costUsd).toBe(0.01);
    });

    it('rewinds by turns to the user message that many turns back, restoring files when asked', async () => {
      const s = await oc();
      await turn(s);
      api.messages.push(
        { id: 'u1', type: 'user', text: 'one' },
        { id: 'a1', type: 'assistant', content: [] },
        { id: 'u2', type: 'user', text: 'two' },
        { id: 'a2', type: 'assistant', content: [] },
      );
      const out = await s.rewind!({ turns: 1, files: true });
      expect(api.staged).toEqual({ messageID: 'u2', files: true });
      expect(out).toMatchObject({ ok: true, turnsRemoved: 1, filesRestored: true });
      expect(srv.calls.some((c) => c.path.endsWith('/revert/commit'))).toBe(true);
      await expect(s.rewind!({ turns: 5 })).rejects.toThrow(/has 1 turn/);
    });

    it('rewinds to a message and counts the turns it removes', async () => {
      const s = await oc();
      await turn(s);
      api.messages.push(
        { id: 'u1', type: 'user', text: 'one' },
        { id: 'u2', type: 'user', text: 'two' },
        { id: 'u3', type: 'user', text: 'three' },
      );
      expect(await s.rewind!({ messageId: 'u2' })).toMatchObject({ ok: true, turnsRemoved: 2, filesRestored: false });
      expect(api.staged).toEqual({ messageID: 'u2', files: false });
    });
  });

  describe('agents and models', () => {
    it('runs a plan turn on the plan agent and the next turn back on the session agent', async () => {
      const s = await oc();
      const planned = await turn(s, { plan: true });
      expect(planned.args[planned.args.indexOf('--agent') + 1]).toBe('plan');
      const next = await turn(s);
      expect(next.args[next.args.indexOf('--agent') + 1]).toBe('build');
      expect((await turn(s)).args).not.toContain('--agent');
    });

    it('keeps the read-only agent for a plan turn on a read-only session', async () => {
      const s = await oc({ sandboxMode: 'read-only' });
      const { args } = await turn(s, { plan: true });
      expect(args[args.indexOf('--agent') + 1]).toBe('clawo-readonly');
    });

    it("runs a send's own model for that turn, and the conversation's model after it", async () => {
      const s = await oc();
      const one = await turn(s, { model: 'opencode/other' });
      expect(one.args[one.args.indexOf('--model') + 1]).toBe('opencode/other');
      const two = await turn(s);
      expect(two.args[two.args.indexOf('--model') + 1]).toBe('opencode/house-default');
    });

    it('switches the model and effort in place', async () => {
      const s = await oc({ model: 'opencode/a' });
      expect(s.perSendModel).toBe(true);
      expect(await s.setModelLive('opencode/b')).toBe(true);
      const { args } = await turn(s);
      expect(args[args.indexOf('--model') + 1]).toBe('opencode/b');
      expect(await s.setEffortLive('high')).toBe(true);
    });

    it('reads a model string as the API reference', () => {
      expect(modelRef('opencode/big-pickle')).toEqual({ providerID: 'opencode', id: 'big-pickle' });
      expect(modelRef('anthropic/claude-x#high')).toEqual({ providerID: 'anthropic', id: 'claude-x', variant: 'high' });
      expect(modelRef('no-provider')).toBeUndefined();
    });
  });

  describe('OpenCode 1', () => {
    it('runs a command as run --command with its arguments on stdin, and has no server capabilities', async () => {
      const s = await oc({}, V1);
      expect(s.commandStyle).toBe('rpc');
      expect(s.listCommands).toBeUndefined();
      expect(s.compactDetailed).toBeUndefined();
      expect(s.askAside).toBeUndefined();
      expect(s.rewind).toBeUndefined();
      expect(s.nativeGoalSession).toBeUndefined();
      mockSpawn.mockReturnValueOnce(proc);
      const out = s.runCommand('pineapple', 'mango');
      await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalledTimes(1));
      finish(proc, [
        line('text', { part: { id: 'p', type: 'text', text: 'PINEAPPLE-42 mango' } }),
        line('step_finish', {
          part: { type: 'step-finish', tokens: { input: 5, output: 3, cache: { read: 0, write: 0 } } },
        }),
      ]);
      expect(await out).toMatchObject({ ok: true, text: 'PINEAPPLE-42 mango', startedTurn: true });
      const [, args] = mockSpawn.mock.calls[0] as [string, string[]];
      expect(args).toContain('--command=pineapple');
      expect(args).not.toContain('--server');
      expect(proc.stdin.end).toHaveBeenCalledWith('mango');
      expect(srv.started).toBe(0);
    });

    it('an unknown OpenCode 1 command used nothing and is no turn', async () => {
      const s = await oc({}, V1);
      mockSpawn.mockReturnValueOnce(proc);
      const out = s.runCommand('nope');
      await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalledTimes(1));
      finish(
        proc,
        [line('error', { error: { name: 'UnknownError', data: { message: 'Unexpected server error' } } })],
        1,
      );
      expect(await out).toMatchObject({ ok: false, startedTurn: false });
    });
  });
});
