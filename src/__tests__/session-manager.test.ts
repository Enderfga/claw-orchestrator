/**
 * Unit tests for SessionManager — the core orchestrator.
 *
 * Strategy: mock the ISession interface so no real CLI processes are spawned.
 * We test orchestration logic: lifecycle, concurrency guards, inbox, model
 * resolution, grep, ultraplan/ultrareview, and shutdown.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  ISession,
  SessionConfig,
  SessionStats,
  SessionSendOptions,
  TurnResult,
  CostBreakdown,
  EffortLevel,
} from '../types.js';

// ─── Mock ISession ──────────────────────────────────────────────────────────

class MockSession extends EventEmitter implements ISession {
  sessionId?: string;
  conversationId?: string;
  threadId?: string;
  private _isReady = true;
  private _isPaused = false;
  private _isBusy = false;
  private _effort: EffortLevel = 'auto';
  private _history: Array<{ time: string; type: string; event: unknown }> = [];

  // Track calls for assertions
  startCalled = 0;
  stopCalled = 0;
  sendCalls: Array<{ message: string | unknown[]; options?: SessionSendOptions }> = [];
  compactCalls: string[] = [];
  /** Overrides the result event this session resolves with. */
  nextEvent?: Record<string, unknown>;
  /** Overrides `turnsSucceeded`, to simulate a turn the engine did not count. */
  turnsSucceededOverride?: number;

  get isReady() {
    return this._isReady;
  }
  get isPaused() {
    return this._isPaused;
  }
  get isBusy() {
    return this._isBusy;
  }

  setBusy(b: boolean) {
    this._isBusy = b;
  }
  setReady(r: boolean) {
    this._isReady = r;
  }

  async start(): Promise<this> {
    this.startCalled++;
    this.sessionId = `mock-session-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    return this;
  }

  stop(): void {
    this.stopCalled++;
  }

  pause(): void {
    this._isPaused = true;
  }

  resume(): void {
    this._isPaused = false;
  }

  async send(
    message: string | unknown[],
    options?: SessionSendOptions,
  ): Promise<TurnResult | { requestId: number; sent: boolean }> {
    this.sendCalls.push({ message, options });
    if (options?.waitForComplete === false) {
      return { requestId: 1, sent: true };
    }
    return {
      text: `response to: ${typeof message === 'string' ? message : JSON.stringify(message)}`,
      event: this.nextEvent ?? { type: 'result', result: 'done' },
    };
  }

  private _settledSends(): Array<{ message: string | unknown[]; options?: SessionSendOptions }> {
    return this.sendCalls.filter((c) => c.options?.waitForComplete !== false);
  }

  getStats(): SessionStats & { sessionId?: string; uptime: number } {
    return {
      // A fire-and-forget send has not settled a turn, so a real engine's counters
      // have not moved yet either.
      turns: this._settledSends().length,
      turnsSucceeded: this.turnsSucceededOverride ?? this._settledSends().length,
      toolCalls: 0,
      toolErrors: 0,
      tokensIn: 100,
      tokensOut: 50,
      cachedTokens: 0,
      costUsd: 0.01,
      isReady: this._isReady,
      startTime: new Date().toISOString(),
      lastActivity: new Date().toISOString(),
      contextPercent: 5,
      retries: 0,
      sessionId: this.sessionId,
      uptime: 60,
    };
  }

  getHistory(limit?: number): Array<{ time: string; type: string; event: unknown }> {
    const h = this._history;
    return limit ? h.slice(-limit) : h;
  }

  addHistory(entries: Array<{ time: string; type: string; event: unknown }>) {
    this._history.push(...entries);
  }

  getCost(): CostBreakdown {
    return {
      model: 'mock-model',
      tokensIn: 100,
      tokensOut: 50,
      cachedTokens: 0,
      pricing: { inputPer1M: 3, outputPer1M: 15, cachedPer1M: 0.3 },
      breakdown: { inputCost: 0.0003, cachedCost: 0, outputCost: 0.00075 },
      totalUsd: 0.00105,
    };
  }

  async compact(summary?: string): Promise<TurnResult | { requestId: number; sent: boolean }> {
    this.compactCalls.push(summary || '');
    return { text: 'compacted', event: { type: 'result' } };
  }

  getEffort(): EffortLevel {
    return this._effort;
  }
  setEffort(level: EffortLevel): void {
    this._effort = level;
  }
  resolveModel(alias: string): string {
    return alias;
  }
}

// ─── Mock Factory ─────────────────────────────────────────────────────────

let mockSessions: MockSession[] = [];
let createdConfigs: SessionConfig[] = [];

/**
 * We intercept the _createSession private method to inject MockSession
 * instances instead of real PersistentClaudeSession / PersistentCodexSession.
 */
function patchCreateSession(manager: InstanceType<typeof SessionManager>): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (manager as any)._createSession = (_engine: string, _config: SessionConfig): ISession => {
    const mock = new MockSession();
    if (_engine === 'agy' && _config.resumeSessionId) mock.conversationId = _config.resumeSessionId;
    mockSessions.push(mock);
    createdConfigs.push(_config);
    return mock;
  };
}

// ─── Mock fs for persistence tests ──────────────────────────────────────────

// We mock the module-level persistence functions by mocking the node:fs module
// BEFORE importing SessionManager. However, SessionManager also uses fs for
// agents/skills/rules, so we only mock what we need.

// The kernel's run store writes under CLAWO_WF_DIR. Redirect it for the whole
// file: these tests use fixed run ids, and without this they would write into —
// and collide inside — the developer's real ~/.claw-orchestrator/wf.
const TEST_WF_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'clawo-sm-wf-'));
process.env.CLAWO_WF_DIR = TEST_WF_DIR;

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');

  // Only the two files SessionManager persists into the developer's real
  // ~/.openclaw are stubbed. Everything else passes through.
  //
  // This used to no-op every write in the process, which kept the home
  // directory clean and quietly broke any other code that touched the disk —
  // the run store writes its checkpoints through the same `fs`, so a
  // kernel-backed mode looked like it had lost every run. A mock that stubs a
  // whole module to protect two paths is a landmine; this one names them.
  const PROTECTED = ['claude-sessions.json', 'session-pids.json'];
  const isProtected = (p: unknown): boolean => typeof p === 'string' && PROTECTED.some((name) => p.includes(name));

  const existsSync = vi.fn((p: string) => (isProtected(p) ? false : actual.existsSync(p)));
  const readFileSync = vi.fn((p: string, enc?: string) =>
    isProtected(p) ? '[]' : actual.readFileSync(p, enc as BufferEncoding),
  );
  const writeFileSync = vi.fn((p: unknown, ...rest: unknown[]) => {
    if (isProtected(p)) return;
    (actual.writeFileSync as (...a: unknown[]) => void)(p, ...rest);
  });
  const appendFileSync = vi.fn((p: unknown, ...rest: unknown[]) => {
    if (isProtected(p)) return;
    (actual.appendFileSync as (...a: unknown[]) => void)(p, ...rest);
  });
  const mkdirSync = vi.fn((p: unknown, ...rest: unknown[]) => {
    if (isProtected(p)) return undefined;
    return (actual.mkdirSync as (...a: unknown[]) => string | undefined)(p, ...rest);
  });
  const renameSync = vi.fn((from: unknown, to: unknown) => {
    if (isProtected(from) || isProtected(to)) return;
    (actual.renameSync as (...a: unknown[]) => void)(from, to);
  });

  const shim = {
    existsSync,
    readFileSync,
    writeFileSync,
    appendFileSync,
    mkdirSync,
    renameSync,
    // The async persistence path is stubbed wholesale: nothing else in the
    // codebase uses these callback forms.
    writeFile: vi.fn((_p: unknown, _d: unknown, cb: (err: null) => void) => cb(null)),
    rename: vi.fn((_o: unknown, _n: unknown, cb: (err: null) => void) => cb(null)),
    mkdir: vi.fn((_p: unknown, _opts: unknown, cb: (err: null) => void) => cb(null)),
    unlink: vi.fn((_p: unknown, cb: () => void) => cb()),
  };

  return { ...actual, ...shim, default: { ...actual, ...shim } };
});

// Import AFTER mocking fs
const { SessionManager } = await import('../session-manager.js');

// ─── Helpers ────────────────────────────────────────────────────────────────

function createManager(overrides?: Record<string, unknown>): InstanceType<typeof SessionManager> {
  const mgr = new SessionManager({
    claudeBin: 'mock-claude',
    maxConcurrentSessions: 5,
    sessionTtlMinutes: 120,
    defaultPermissionMode: 'acceptEdits',
    defaultEffort: 'auto',
    ...overrides,
  });
  patchCreateSession(mgr);
  return mgr;
}

function lastMock(): MockSession {
  return mockSessions[mockSessions.length - 1];
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('SessionManager', () => {
  let mgr: InstanceType<typeof SessionManager>;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockSessions = [];
    createdConfigs = [];
    // Fresh run store per test. These cases use fixed run ids, and the store
    // now refuses to reuse one — which is the point, but it means the tests
    // have to start from an empty directory rather than leaking into each other.
    fs.rmSync(TEST_WF_DIR, { recursive: true, force: true });
    fs.mkdirSync(TEST_WF_DIR, { recursive: true });
    mgr = createManager();
  });

  afterEach(async () => {
    await mgr.shutdown();
    vi.useRealTimers();
  });

  // ─── Session Lifecycle ──────────────────────────────────────────────

  describe('session lifecycle', () => {
    it('startSession creates a session and returns SessionInfo', async () => {
      const info = await mgr.startSession({ name: 'test1', cwd: '/tmp' });

      expect(info.name).toBe('test1');
      expect(info.cwd).toBe('/tmp');
      expect(info.created).toBeDefined();
      expect(info.stats).toBeDefined();
      expect(info.stats.isReady).toBe(true);
      expect(lastMock().startCalled).toBe(1);
    });

    // ── "Do not save session to disk" means both stores.
    //
    //    The flag reached the engine (Claude Code's --no-session-persistence)
    //    but not this orchestrator's own registry, which is what auto-resume
    //    reads — so `clawo session-start x --skip-persistence` twice silently
    //    reattached to the first conversation.
    it('noSessionPersistence keeps the session out of the resume registry', async () => {
      await mgr.startSession({ name: 'ephemeral', cwd: '/tmp', noSessionPersistence: true });
      expect((mgr as unknown as { persistedSessions: Map<string, unknown> }).persistedSessions.has('ephemeral')).toBe(
        false,
      );
    });

    it('still registers an ordinary session', async () => {
      // Half the contract: skipping everything would be just as wrong.
      await mgr.startSession({ name: 'ordinary', cwd: '/tmp' });
      expect((mgr as unknown as { persistedSessions: Map<string, unknown> }).persistedSessions.has('ordinary')).toBe(
        true,
      );
    });

    // ── TTL cleanup must forget the PID it stopped.
    //
    //    `stopSession` deletes from `_activePids` and saves; the TTL path did
    //    not, so the map only ever grew and the next save rewrote dead PIDs to
    //    disk under the current owner. After an unclean exit those come back as
    //    orphan candidates and get probed — and a PID the OS has recycled to a
    //    coding-CLI-shaped process is killed.
    it('idle cleanup forgets the PID along with the session', async () => {
      await mgr.startSession({ name: 'idle-one', cwd: '/tmp' });
      const internals = mgr as unknown as {
        _activePids: Map<string, number>;
        sessions: Map<string, { lastActivity: number }>;
        _cleanupIdleSessions(): void;
      };
      internals._activePids.set('idle-one', 424242);
      internals.sessions.get('idle-one')!.lastActivity = 0; // long past the TTL

      internals._cleanupIdleSessions();

      expect(internals.sessions.has('idle-one')).toBe(false);
      expect(internals._activePids.has('idle-one')).toBe(false);
    });

    it('idle cleanup leaves a live session and its PID alone', async () => {
      await mgr.startSession({ name: 'busy-one', cwd: '/tmp' });
      const internals = mgr as unknown as {
        _activePids: Map<string, number>;
        sessions: Map<string, unknown>;
        _cleanupIdleSessions(): void;
      };
      internals._activePids.set('busy-one', 424243);

      internals._cleanupIdleSessions();

      expect(internals.sessions.has('busy-one')).toBe(true);
      expect(internals._activePids.get('busy-one')).toBe(424243);
    });

    // ── One proxy server, however many sessions start at once.
    //
    //    The `if (this._proxyPort)` guard is checked synchronously but the port
    //    is assigned inside listen()'s callback, several awaits later. Council
    //    and fanout start their agents with Promise.all under distinct names,
    //    and `_pendingSessions` only serialises per name — so two callers each
    //    bound a server and shutdown() closed only the last one.
    it('shares one proxy startup between concurrent callers', async () => {
      const internals = mgr as unknown as {
        _ensureProxyServer(): Promise<number | null>;
        _startProxyServer(): Promise<number | null>;
      };
      let starts = 0;
      internals._startProxyServer = async () => {
        starts++;
        await new Promise((r) => setTimeout(r, 20));
        return 4242;
      };

      const ports = await Promise.all([
        internals._ensureProxyServer(),
        internals._ensureProxyServer(),
        internals._ensureProxyServer(),
      ]);

      expect(starts).toBe(1);
      expect(ports).toEqual([4242, 4242, 4242]);
    });

    it('startSession returns existing session without re-creating', async () => {
      const info1 = await mgr.startSession({ name: 'dup', cwd: '/tmp' });
      const info2 = await mgr.startSession({ name: 'dup', cwd: '/other' });

      expect(info1.name).toBe(info2.name);
      // Only one mock was created
      expect(mockSessions.length).toBe(1);
    });

    it('startSession generates name if none provided', async () => {
      const info = await mgr.startSession({ cwd: '/tmp' });
      expect(info.name).toMatch(/^session-\d+$/);
    });

    it('stopSession removes the session', async () => {
      await mgr.startSession({ name: 'to-stop', cwd: '/tmp' });
      expect(mgr.listSessions().length).toBe(1);

      await mgr.stopSession('to-stop');
      expect(mgr.listSessions().length).toBe(0);
      expect(lastMock().stopCalled).toBe(1);
    });

    it('stopSession throws for unknown session', async () => {
      await expect(mgr.stopSession('nonexistent')).rejects.toThrow("Session 'nonexistent' not found");
    });

    it('listSessions returns all active sessions', async () => {
      await mgr.startSession({ name: 'a', cwd: '/tmp' });
      await mgr.startSession({ name: 'b', cwd: '/tmp' });
      await mgr.startSession({ name: 'c', cwd: '/tmp' });

      const list = mgr.listSessions();
      expect(list.length).toBe(3);
      expect(list.map((s) => s.name).sort()).toEqual(['a', 'b', 'c']);
    });

    it('getStatus returns detailed session info', async () => {
      await mgr.startSession({ name: 'status-test', cwd: '/tmp' });
      const status = mgr.getStatus('status-test');

      expect(status.name).toBe('status-test');
      expect(status.stats.uptime).toBeDefined();
      expect(status.stats.isReady).toBe(true);
    });

    it('getStatus throws for unknown session', () => {
      expect(() => mgr.getStatus('nope')).toThrow("Session 'nope' not found");
    });
  });

  // ─── Concurrent Session Guard ───────────────────────────────────────

  describe('concurrent session guard (_pendingSessions)', () => {
    it('deduplicates concurrent startSession calls for same name', async () => {
      // Launch two starts concurrently for the same name
      const [info1, info2] = await Promise.all([
        mgr.startSession({ name: 'concurrent', cwd: '/tmp' }),
        mgr.startSession({ name: 'concurrent', cwd: '/tmp' }),
      ]);

      expect(info1.name).toBe('concurrent');
      expect(info2.name).toBe('concurrent');
      // Only one underlying session should have been created
      expect(mockSessions.length).toBe(1);
    });

    it('allows creation of different names concurrently', async () => {
      const [a, b] = await Promise.all([
        mgr.startSession({ name: 'alpha', cwd: '/tmp' }),
        mgr.startSession({ name: 'beta', cwd: '/tmp' }),
      ]);

      expect(a.name).toBe('alpha');
      expect(b.name).toBe('beta');
      expect(mockSessions.length).toBe(2);
    });
  });

  // ─── Max Concurrent Sessions ────────────────────────────────────────

  describe('max concurrent sessions', () => {
    it('throws when limit is reached', async () => {
      const maxMgr = createManager({ maxConcurrentSessions: 2 });

      await maxMgr.startSession({ name: 's1', cwd: '/tmp' });
      await maxMgr.startSession({ name: 's2', cwd: '/tmp' });

      await expect(maxMgr.startSession({ name: 's3', cwd: '/tmp' })).rejects.toThrow(
        'Max concurrent sessions (2) reached',
      );

      await maxMgr.shutdown();
    });

    it('allows creation after stopping a session', async () => {
      const maxMgr = createManager({ maxConcurrentSessions: 2 });

      await maxMgr.startSession({ name: 's1', cwd: '/tmp' });
      await maxMgr.startSession({ name: 's2', cwd: '/tmp' });
      await maxMgr.stopSession('s1');

      // Now should succeed
      const info = await maxMgr.startSession({ name: 's3', cwd: '/tmp' });
      expect(info.name).toBe('s3');

      await maxMgr.shutdown();
    });
  });

  // ─── sendMessage ────────────────────────────────────────────────────

  describe('sendMessage', () => {
    it('sends message and returns output', async () => {
      await mgr.startSession({ name: 'msg-test', cwd: '/tmp' });
      const result = await mgr.sendMessage('msg-test', 'hello world');

      expect(result.output).toContain('hello world');
      expect(result.sessionId).toBeDefined();
      expect(lastMock().sendCalls.length).toBe(1);
      expect(lastMock().sendCalls[0].message).toBe('hello world');
    });

    it('throws for unknown session', async () => {
      await expect(mgr.sendMessage('nope', 'hi')).rejects.toThrow("Session 'nope' not found");
    });

    // agy resolves with `stop_reason: 'error'` while carrying a usable reply. That
    // must NOT become `SendResult.error`: openai-compat answers 502 on a non-empty
    // error and drops the text, and ultraplan discards the plan. The outcome is
    // recorded in the ledger instead, from the session's own counter.
    it('records a turn the engine did not count as ok:false without failing the caller', async () => {
      await mgr.startSession({ name: 'sr-error', cwd: '/tmp' });
      lastMock().nextEvent = { type: 'result', result: 'agy stopped early', stop_reason: 'error' };
      lastMock().turnsSucceededOverride = 0;
      const ledger = vi.mocked((await import('node:fs')).default.appendFileSync);
      ledger.mockClear();

      const result = await mgr.sendMessage('sr-error', 'hello');

      // The reply still reaches the caller.
      expect(result.error).toBeUndefined();
      expect(result.output).toContain('hello');
      const rows = ledger.mock.calls.map((c) => JSON.parse(String(c[1]))).filter((r) => r.session === 'sr-error');
      expect(rows).toHaveLength(1);
      expect(rows[0].ok).toBe(false);
    });

    // The guard: a session whose getStats() throws leaves both snapshots empty, so the
    // counter cannot be read. A telemetry failure must not be recorded as a failed turn —
    // the row falls back to what it meant before, "nothing was thrown".
    it('keeps ok:true when the counter cannot be read at all', async () => {
      await mgr.startSession({ name: 'sr-blind', cwd: '/tmp' });
      lastMock().getStats = () => {
        throw new Error('engine torn down');
      };
      const ledger = vi.mocked((await import('node:fs')).default.appendFileSync);
      ledger.mockClear();

      await mgr.sendMessage('sr-blind', 'hello');

      const rows = ledger.mock.calls.map((c) => JSON.parse(String(c[1]))).filter((r) => r.session === 'sr-blind');
      expect(rows).toHaveLength(1);
      expect(rows[0].ok).toBe(true);
    });

    // Positive control for the assertion above: the default event still reads as a
    // success, so `ok: false` above is the classification and not a constant.
    it('records a clean turn as ok in the ledger', async () => {
      await mgr.startSession({ name: 'sr-ok', cwd: '/tmp' });
      const ledger = vi.mocked((await import('node:fs')).default.appendFileSync);
      ledger.mockClear();

      const result = await mgr.sendMessage('sr-ok', 'hello');

      expect(result.error).toBeUndefined();
      const rows = ledger.mock.calls.map((c) => JSON.parse(String(c[1]))).filter((r) => r.session === 'sr-ok');
      expect(rows).toHaveLength(1);
      expect(rows[0].ok).toBe(true);
    });

    it('passes effort and plan options through', async () => {
      await mgr.startSession({ name: 'opts-test', cwd: '/tmp' });
      await mgr.sendMessage('opts-test', 'plan this', { effort: 'max', plan: true });

      const sendOpts = lastMock().sendCalls[0].options;
      expect(sendOpts).toBeDefined();
      expect(sendOpts!.effort).toBe('max');
      expect(sendOpts!.plan).toBe(true);
    });

    it('calls onChunk and onEvent callbacks via stream callbacks', async () => {
      await mgr.startSession({ name: 'cb-test', cwd: '/tmp' });
      const chunks: string[] = [];
      const events: unknown[] = [];

      // Override the mock's send to call callbacks
      const mock = lastMock();
      mock.send = async (message, options) => {
        mock.sendCalls.push({ message, options });
        if (options?.callbacks?.onText) options.callbacks.onText('chunk1');
        if (options?.callbacks?.onToolUse) options.callbacks.onToolUse({ tool: 'Read' });
        if (options?.callbacks?.onToolResult) options.callbacks.onToolResult({ result: 'ok' });
        return { text: 'done', event: { type: 'result' } };
      };

      await mgr.sendMessage('cb-test', 'test', {
        onChunk: (c) => chunks.push(c),
        onEvent: (e) => events.push(e),
      });

      expect(chunks).toEqual(['chunk1']);
      // onEvent should receive text, tool_use, and tool_result events
      expect(events.length).toBe(3);
    });

    it('serializes concurrent sendMessage calls on the same session', async () => {
      // Two concurrent sends on the same session must NOT interleave —
      // PersistentClaudeSession's _streamCallbacks and TURN_COMPLETE listener
      // are single-slot, so without serialization the second caller would
      // receive the first caller's response.
      await mgr.startSession({ name: 'race-test', cwd: '/tmp' });
      const mock = lastMock();
      const log: string[] = [];

      // Replace send() with a slow, instrumented version that logs entry/exit.
      mock.send = async (message) => {
        const tag = String(message);
        log.push(`enter:${tag}`);
        // Yield to the event loop so any concurrent caller would race here
        // if no mutex was holding them off.
        await new Promise((r) => setTimeout(r, 20));
        log.push(`exit:${tag}`);
        return { text: `reply:${tag}`, event: { type: 'result' } };
      };

      // Fire two sends in parallel — both should resolve with the correct
      // matching reply, and the log must show no interleaving.
      const [r1, r2] = await Promise.all([mgr.sendMessage('race-test', 'one'), mgr.sendMessage('race-test', 'two')]);

      expect(r1.output).toBe('reply:one');
      expect(r2.output).toBe('reply:two');
      // No interleaving: every enter must be immediately followed by its exit
      expect(log).toEqual(['enter:one', 'exit:one', 'enter:two', 'exit:two']);
    });

    it('does not deadlock subsequent sends after a failed send', async () => {
      // If the prior link in the chain rejects, the next caller must still
      // proceed (we catch in the chain hand-off so failures don't poison it).
      await mgr.startSession({ name: 'recover-test', cwd: '/tmp' });
      const mock = lastMock();
      let failedOnce = false;
      mock.send = async (message) => {
        if (!failedOnce) {
          failedOnce = true;
          throw new Error('boom');
        }
        return { text: `ok:${message}`, event: { type: 'result' } };
      };

      await expect(mgr.sendMessage('recover-test', 'first')).rejects.toThrow('boom');
      const r2 = await mgr.sendMessage('recover-test', 'second');
      expect(r2.output).toBe('ok:second');
    });
  });

  // ─── Model Resolution ───────────────────────────────────────────────

  describe('model resolution (_resolveModel)', () => {
    it('resolves known aliases (opus -> claude-opus-5)', async () => {
      await mgr.startSession({ name: 'alias-test', model: 'opus', cwd: '/tmp' });
      const list = mgr.listSessions();
      expect(list[0].model).toBe('claude-opus-5');
    });

    it('resolves sonnet alias', async () => {
      await mgr.startSession({ name: 'sonnet-test', model: 'sonnet', cwd: '/tmp' });
      const list = mgr.listSessions();
      expect(list[0].model).toBe('claude-sonnet-5');
    });

    it('resolves haiku alias', async () => {
      await mgr.startSession({ name: 'haiku-test', model: 'haiku', cwd: '/tmp' });
      const list = mgr.listSessions();
      expect(list[0].model).toBe('claude-haiku-4-5');
    });

    it('passes through unknown model strings as-is', async () => {
      await mgr.startSession({ name: 'custom-test', model: 'my-custom-model', cwd: '/tmp' });
      const list = mgr.listSessions();
      expect(list[0].model).toBe('my-custom-model');
    });

    it('respects modelOverrides over default aliases', async () => {
      await mgr.startSession({
        name: 'override-test',
        model: 'opus',
        modelOverrides: { opus: 'claude-opus-custom-v2' },
        cwd: '/tmp',
      });
      const list = mgr.listSessions();
      expect(list[0].model).toBe('claude-opus-custom-v2');
    });

    it('setModel updates model for a session', async () => {
      await mgr.startSession({ name: 'model-set', model: 'opus', cwd: '/tmp' });
      mgr.setModel('model-set', 'sonnet');
      const list = mgr.listSessions();
      expect(list[0].model).toBe('claude-sonnet-5');
    });
  });

  // ─── Grep Session ───────────────────────────────────────────────────

  describe('grepSession', () => {
    it('filters history entries by regex pattern', async () => {
      await mgr.startSession({ name: 'grep-test', cwd: '/tmp' });
      const mock = lastMock();
      mock.addHistory([
        { time: '2025-01-01T00:00:00Z', type: 'user', event: { text: 'hello world' } },
        { time: '2025-01-01T00:01:00Z', type: 'assistant', event: { text: 'foo bar' } },
        { time: '2025-01-01T00:02:00Z', type: 'user', event: { text: 'hello again' } },
        { time: '2025-01-01T00:03:00Z', type: 'tool', event: { text: 'something else' } },
      ]);

      const results = await mgr.grepSession('grep-test', 'hello');
      expect(results.length).toBe(2);
      expect(results[0].type).toBe('user');
      expect(results[1].type).toBe('user');
    });

    it('respects limit parameter', async () => {
      await mgr.startSession({ name: 'grep-limit', cwd: '/tmp' });
      const mock = lastMock();
      mock.addHistory(
        Array.from({ length: 100 }, (_, i) => ({
          time: `2025-01-01T00:${String(i).padStart(2, '0')}:00Z`,
          type: 'user',
          event: { text: `message ${i}` },
        })),
      );

      const results = await mgr.grepSession('grep-limit', 'message', 5);
      expect(results.length).toBe(5);
    });

    it('is case-insensitive', async () => {
      await mgr.startSession({ name: 'grep-ci', cwd: '/tmp' });
      lastMock().addHistory([
        { time: '2025-01-01T00:00:00Z', type: 'user', event: { text: 'Hello World' } },
        { time: '2025-01-01T00:01:00Z', type: 'user', event: { text: 'HELLO AGAIN' } },
      ]);

      const results = await mgr.grepSession('grep-ci', 'hello');
      expect(results.length).toBe(2);
    });

    it('returns empty array when no matches', async () => {
      await mgr.startSession({ name: 'grep-empty', cwd: '/tmp' });
      lastMock().addHistory([{ time: '2025-01-01T00:00:00Z', type: 'user', event: { text: 'nothing here' } }]);

      const results = await mgr.grepSession('grep-empty', 'zzz_not_found');
      expect(results.length).toBe(0);
    });

    it('throws for unknown session', async () => {
      await expect(mgr.grepSession('nope', 'test')).rejects.toThrow("Session 'nope' not found");
    });
  });

  // ─── setEffort ──────────────────────────────────────────────────────

  describe('setEffort', () => {
    it('updates effort on the session', async () => {
      await mgr.startSession({ name: 'effort-test', cwd: '/tmp' });
      mgr.setEffort('effort-test', 'max');

      expect(lastMock().getEffort()).toBe('max');
    });

    it('throws for unknown session', () => {
      expect(() => mgr.setEffort('nope', 'high')).toThrow("Session 'nope' not found");
    });
  });

  // ─── compactSession ─────────────────────────────────────────────────

  describe('compactSession', () => {
    it('calls compact on the underlying session', async () => {
      await mgr.startSession({ name: 'compact-test', cwd: '/tmp' });
      await mgr.compactSession('compact-test', 'summarize this');
      expect(lastMock().compactCalls).toEqual(['summarize this']);
    });

    it('works without summary', async () => {
      await mgr.startSession({ name: 'compact-test2', cwd: '/tmp' });
      await mgr.compactSession('compact-test2');
      expect(lastMock().compactCalls).toEqual(['']);
    });
  });

  // ─── getCost ────────────────────────────────────────────────────────

  describe('getCost', () => {
    it('returns cost breakdown from session', async () => {
      await mgr.startSession({ name: 'cost-test', cwd: '/tmp' });
      const cost = mgr.getCost('cost-test');
      expect(cost.model).toBe('mock-model');
      expect(cost.totalUsd).toBeGreaterThan(0);
    });
  });

  // ─── Inbox (cross-session messaging) ────────────────────────────────

  describe('inbox / sessionSendTo', () => {
    it('delivers message directly to idle session', async () => {
      await mgr.startSession({ name: 'sender', cwd: '/tmp' });
      await mgr.startSession({ name: 'receiver', cwd: '/tmp' });

      const receiverMock = mockSessions[1]; // second session is receiver
      receiverMock.setBusy(false);
      receiverMock.setReady(true);

      const result = await mgr.sessionSendTo('sender', 'receiver', 'hello from sender');
      expect(result.delivered).toBe(true);
      expect(result.queued).toBe(false);

      // The receiver should have received a send call with cross-session XML wrapper
      expect(receiverMock.sendCalls.length).toBe(1);
      const msg = receiverMock.sendCalls[0].message as string;
      expect(msg).toContain('<cross-session-message');
      expect(msg).toContain('from="sender"');
      expect(msg).toContain('hello from sender');
    });

    it('queues message when target is busy', async () => {
      await mgr.startSession({ name: 'sender', cwd: '/tmp' });
      await mgr.startSession({ name: 'busy-recv', cwd: '/tmp' });

      const receiverMock = mockSessions[1];
      receiverMock.setBusy(true);

      const result = await mgr.sessionSendTo('sender', 'busy-recv', 'queued msg');
      expect(result.delivered).toBe(false);
      expect(result.queued).toBe(true);

      // Check inbox
      const inbox = mgr.sessionInbox('busy-recv');
      expect(inbox.length).toBe(1);
      expect(inbox[0].text).toBe('queued msg');
      expect(inbox[0].from).toBe('sender');
      expect(inbox[0].read).toBe(false);
    });

    it('queues message when target is not ready', async () => {
      await mgr.startSession({ name: 'sender', cwd: '/tmp' });
      await mgr.startSession({ name: 'notready', cwd: '/tmp' });

      const receiverMock = mockSessions[1];
      receiverMock.setBusy(false);
      receiverMock.setReady(false);

      const result = await mgr.sessionSendTo('sender', 'notready', 'queued msg');
      expect(result.delivered).toBe(false);
      expect(result.queued).toBe(true);
    });

    it('broadcast sends to all other sessions', async () => {
      await mgr.startSession({ name: 'broadcaster', cwd: '/tmp' });
      await mgr.startSession({ name: 'recv1', cwd: '/tmp' });
      await mgr.startSession({ name: 'recv2', cwd: '/tmp' });

      const result = await mgr.sessionSendTo('broadcaster', '*', 'broadcast msg');
      expect(result.delivered).toBe(true);

      // Both receivers should have gotten the message
      expect(mockSessions[1].sendCalls.length).toBe(1);
      expect(mockSessions[2].sendCalls.length).toBe(1);
      // Broadcaster should NOT have gotten its own message
      expect(mockSessions[0].sendCalls.length).toBe(0);
    });

    it('throws when sender session does not exist', async () => {
      await mgr.startSession({ name: 'target', cwd: '/tmp' });
      await expect(mgr.sessionSendTo('ghost', 'target', 'hi')).rejects.toThrow("Sender session 'ghost' not found");
    });

    it('throws when target session does not exist', async () => {
      await mgr.startSession({ name: 'sender', cwd: '/tmp' });
      await expect(mgr.sessionSendTo('sender', 'ghost', 'hi')).rejects.toThrow("Target session 'ghost' not found");
    });

    it('sessionInbox returns unread messages by default', async () => {
      await mgr.startSession({ name: 's1', cwd: '/tmp' });
      await mgr.startSession({ name: 's2', cwd: '/tmp' });
      mockSessions[1].setBusy(true);

      await mgr.sessionSendTo('s1', 's2', 'msg1');
      await mgr.sessionSendTo('s1', 's2', 'msg2');

      const unread = mgr.sessionInbox('s2');
      expect(unread.length).toBe(2);

      const all = mgr.sessionInbox('s2', false);
      expect(all.length).toBe(2);
    });

    it('sessionDeliverInbox delivers queued messages', async () => {
      await mgr.startSession({ name: 's1', cwd: '/tmp' });
      await mgr.startSession({ name: 's2', cwd: '/tmp' });
      mockSessions[1].setBusy(true);

      await mgr.sessionSendTo('s1', 's2', 'queued1');
      await mgr.sessionSendTo('s1', 's2', 'queued2');

      mockSessions[1].setBusy(false);

      const delivered = await mgr.sessionDeliverInbox('s2');
      expect(delivered).toBe(2);

      // Messages should be marked as read
      const unread = mgr.sessionInbox('s2');
      expect(unread.length).toBe(0);
    });

    it('sessionDeliverInbox returns 0 when inbox is empty', async () => {
      await mgr.startSession({ name: 'empty-inbox', cwd: '/tmp' });
      const delivered = await mgr.sessionDeliverInbox('empty-inbox');
      expect(delivered).toBe(0);
    });

    it('MAX_INBOX_SIZE eviction drops oldest read first, then oldest unread', async () => {
      await mgr.startSession({ name: 's1', cwd: '/tmp' });
      await mgr.startSession({ name: 's2', cwd: '/tmp' });
      mockSessions[1].setBusy(true);

      // Fill inbox to MAX_INBOX_SIZE (200)
      for (let i = 0; i < 200; i++) {
        await mgr.sessionSendTo('s1', 's2', `msg-${i}`);
      }

      let inbox = mgr.sessionInbox('s2', false);
      expect(inbox.length).toBe(200);

      // Mark some as read
      inbox[0].read = true;
      inbox[1].read = true;

      // Send one more — should evict the first read message
      await mgr.sessionSendTo('s1', 's2', 'overflow-msg');
      inbox = mgr.sessionInbox('s2', false);
      expect(inbox.length).toBe(200);
      // The evicted one should have been the first read message (msg-0)
      expect(inbox.find((m) => m.text === 'msg-0')).toBeUndefined();
      // msg-1 (also read) should still be there
      expect(inbox.find((m) => m.text === 'msg-1')).toBeDefined();
      // overflow should be the last
      expect(inbox[inbox.length - 1].text).toBe('overflow-msg');
    });

    it('evicts oldest unread if no read messages exist', async () => {
      await mgr.startSession({ name: 's1', cwd: '/tmp' });
      await mgr.startSession({ name: 's2', cwd: '/tmp' });
      mockSessions[1].setBusy(true);

      for (let i = 0; i < 200; i++) {
        await mgr.sessionSendTo('s1', 's2', `msg-${i}`);
      }

      // All unread — send one more
      await mgr.sessionSendTo('s1', 's2', 'overflow-unread');
      const inbox = mgr.sessionInbox('s2', false);
      expect(inbox.length).toBe(200);
      // First message should have been evicted
      expect(inbox.find((m) => m.text === 'msg-0')).toBeUndefined();
      expect(inbox[inbox.length - 1].text).toBe('overflow-unread');
    });

    it('includes summary in cross-session message when provided', async () => {
      await mgr.startSession({ name: 's1', cwd: '/tmp' });
      await mgr.startSession({ name: 's2', cwd: '/tmp' });

      await mgr.sessionSendTo('s1', 's2', 'detailed message', 'TL;DR summary');

      const msg = mockSessions[1].sendCalls[0].message as string;
      expect(msg).toContain('summary="TL;DR summary"');
    });

    it('escapes XML special characters in from and summary', async () => {
      await mgr.startSession({ name: 'a<b', cwd: '/tmp' });
      await mgr.startSession({ name: 'recv', cwd: '/tmp' });

      await mgr.sessionSendTo('a<b', 'recv', 'test', 'say "hi" & <bye>');

      const msg = mockSessions[1].sendCalls[0].message as string;
      expect(msg).toContain('from="a&lt;b"');
      expect(msg).toContain('summary="say &quot;hi&quot; &amp; &lt;bye&gt;"');
    });
  });

  // ─── Team tools (issue #48 regression guard) ────────────────────────────
  // Claude Code CLI does not expose `/team` or `@teammate` syntax. team_list
  // and team_send must use the virtual-team / inbox layer for every engine.

  describe('teamList / teamSend (virtual team across all engines)', () => {
    it('teamList returns virtual team list for claude engine (no /team command)', async () => {
      await mgr.startSession({ name: 'lead', cwd: '/tmp', engine: 'claude' });
      await mgr.startSession({ name: 'helper', cwd: '/tmp', engine: 'claude' });

      const out = await mgr.teamList('lead');

      expect(out).toContain('Virtual team');
      expect(out).toContain('helper');
      expect(out).toContain('claude');
      // Critically, the caller's session must NOT have been sent the literal '/team' string
      expect(mockSessions[0].sendCalls.find((c) => c.message === '/team')).toBeUndefined();
    });

    it('teamList omits the calling session and reports "No other active sessions" when alone', async () => {
      await mgr.startSession({ name: 'solo', cwd: '/tmp', engine: 'claude' });
      const out = await mgr.teamList('solo');
      expect(out).toBe('No other active sessions');
    });

    it('teamSend routes via cross-session inbox for claude engine (no @teammate command)', async () => {
      await mgr.startSession({ name: 'sender', cwd: '/tmp', engine: 'claude' });
      await mgr.startSession({ name: 'receiver', cwd: '/tmp', engine: 'claude' });

      const result = await mgr.teamSend('sender', 'receiver', 'please review');

      // Sender must NOT have been sent a literal '@receiver ...' string
      expect(
        mockSessions[0].sendCalls.find((c) => typeof c.message === 'string' && c.message.startsWith('@')),
      ).toBeUndefined();
      // Receiver got a cross-session-message envelope instead
      expect(mockSessions[1].sendCalls.length).toBe(1);
      const msg = mockSessions[1].sendCalls[0].message as string;
      expect(msg).toContain('<cross-session-message');
      expect(msg).toContain('from="sender"');
      expect(msg).toContain('please review');
      expect(result.output).toContain('delivered');
    });

    it('teamSend throws clearly when teammate session does not exist', async () => {
      await mgr.startSession({ name: 'lone', cwd: '/tmp', engine: 'claude' });
      await expect(mgr.teamSend('lone', 'ghost', 'hi')).rejects.toThrow("Target session 'ghost' not found");
    });
  });

  // ─── Ultraplan / Ultrareview ────────────────────────────────────────
  //
  // Both are kernel runs now, so these drive the real path — a temp run store
  // and stubbed node executors — instead of stubbing `fanoutStart`, which
  // ultrareview no longer calls. The assertions moved with them: what used to be
  // checked on the arguments handed to `fanoutStart` is now checked on the spec
  // that reached the kernel, which is the thing that actually gets executed.

  describe('ultraplan / ultrareview', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let started: any[];

    beforeEach(() => {
      started = [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const kernel = (mgr as any).kernel;
      for (const kind of ['agent', 'fanout'] as const) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        kernel.setExecutor(kind, async (nodeSpec: any) => {
          started.push(nodeSpec);
          // Park so the run stays `running` while the assertions look at it.
          await new Promise((r) => setTimeout(r, 50));
          return { ok: true, output: 'stub' };
        });
      }
    });

    it('ultraplanStart creates a result with running status', async () => {
      const result = await mgr.ultraplanStart('build a feature', { cwd: '/tmp' });
      expect(result.id).toMatch(/^ultraplan-/);
      expect(result.status).toBe('running');
      expect(result.sessionName).toContain('ultraplan-');
      expect(result.startTime).toBeDefined();
    });

    it('ultraplanStatus returns the result by id, from disk', async () => {
      const result = await mgr.ultraplanStart('plan task', { cwd: '/tmp' });
      const status = mgr.ultraplanStatus(result.id);
      expect(status).toBeDefined();
      expect(status!.id).toBe(result.id);
      expect(status!.status).toBe('running');
    });

    it('plans in plan mode at max effort', async () => {
      await mgr.ultraplanStart('plan task', { cwd: '/tmp' });
      expect(started[0]).toMatchObject({ kind: 'agent', permissionMode: 'plan', effort: 'max' });
    });

    it('ultraplanStatus returns undefined for unknown id', () => {
      expect(mgr.ultraplanStatus('nonexistent')).toBeUndefined();
    });

    it('ultrareviewStart creates result with running status', async () => {
      const result = await mgr.ultrareviewStart('/tmp', { agentCount: 3 });
      expect(result.id).toMatch(/^ultrareview-/);
      expect(result.status).toBe('running');
      expect(result.agentCount).toBe(3);
      // The fan-out id and the run id are the same thing now.
      expect(result.councilId).toBe(result.id);
    });

    it('runs reviewers read-only (plan mode) and fans out with synthesis', async () => {
      await mgr.ultrareviewStart('/tmp', { agentCount: 2, engines: ['claude', 'codex'] });
      const spec = started[0];
      expect(spec.kind).toBe('fanout');
      expect(spec.synthesize).toBe(true);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(spec.agents.every((a: any) => a.permissionMode === 'plan')).toBe(true);
      expect(spec.agents.map((a: { engine: string }) => a.engine)).toEqual(['claude', 'codex']);
    });

    it('ultrareviewStart clamps agentCount', async () => {
      // agentCount: 0 is falsy, so `0 || 5` defaults to 5
      expect((await mgr.ultrareviewStart('/tmp', { agentCount: 0 })).agentCount).toBe(5);
      expect((await mgr.ultrareviewStart('/tmp', { agentCount: 1 })).agentCount).toBe(1);
      expect((await mgr.ultrareviewStart('/tmp', { agentCount: 50 })).agentCount).toBe(20);
    });

    it('ultrareviewStatus returns undefined for unknown id', () => {
      expect(mgr.ultrareviewStatus('nonexistent')).toBeUndefined();
    });

    it('ultrareviewStatus returns the stored result', async () => {
      const result = await mgr.ultrareviewStart('/tmp');
      const status = mgr.ultrareviewStatus(result.id);
      expect(status).toBeDefined();
      expect(status!.id).toBe(result.id);
    });

    it('keeps results readable after the run finishes — no 30-minute eviction', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const kernel = (mgr as any).kernel;
      kernel.setExecutor('fanout', async () => ({
        ok: true,
        output: 'done',
        data: { task: 't', agentCount: 1, results: [{ agent: 'a', ok: true, output: 'found a bug' }] },
      }));
      const result = await mgr.ultrareviewStart('/tmp', { agentCount: 1 });
      await kernel.wait(result.id);
      const status = mgr.ultrareviewStatus(result.id);
      expect(status!.status).toBe('completed');
      expect(status!.findings).toContain('found a bug');
    });
  });

  // ─── Health ─────────────────────────────────────────────────────────

  describe('health', () => {
    it('returns health with no sessions', () => {
      const h = mgr.health();
      expect(h.ok).toBe(true);
      expect(h.sessions).toBe(0);
      expect(h.sessionNames).toEqual([]);
      expect(h.details).toEqual([]);
    });

    it('returns health with active sessions', async () => {
      await mgr.startSession({ name: 'h1', cwd: '/tmp' });
      await mgr.startSession({ name: 'h2', cwd: '/tmp' });

      const h = mgr.health();
      expect(h.sessions).toBe(2);
      expect(h.sessionNames.sort()).toEqual(['h1', 'h2']);
      expect(h.details.length).toBe(2);
      expect(h.details[0].ready).toBe(true);
      expect(h.details[0].turns).toBeDefined();
    });
  });

  // ─── Shutdown ───────────────────────────────────────────────────────

  describe('shutdown', () => {
    it('stops all sessions', async () => {
      await mgr.startSession({ name: 'shutdown1', cwd: '/tmp' });
      await mgr.startSession({ name: 'shutdown2', cwd: '/tmp' });

      const mock1 = mockSessions[0];
      const mock2 = mockSessions[1];

      await mgr.shutdown();

      expect(mock1.stopCalled).toBe(1);
      expect(mock2.stopCalled).toBe(1);
      expect(mgr.listSessions().length).toBe(0);
    });

    it('clears cleanup timer', async () => {
      // After shutdown, the cleanup timer should be cleared
      // We can verify by checking that no cleanup runs after shutdown
      await mgr.shutdown();

      // Create a fresh manager to verify the timer cleanup logic path
      const mgr2 = createManager();
      // Access the private timer to verify it exists
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((mgr2 as any).cleanupTimer).not.toBeNull();
      await mgr2.shutdown();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((mgr2 as any).cleanupTimer).toBeNull();
    });

    it('cancels live kernel runs (there are no per-mode timers left to clear)', async () => {
      // Ultrareview used to keep a `setInterval` per review and a map of
      // results, both torn down here. Every mode is a kernel run now, so
      // shutdown has exactly one thing to stop.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const kernel = (mgr as any).kernel;
      let cancelled = false;
      kernel.setExecutor('fanout', async (_n: unknown, ctx: { signal: { aborted: boolean } }) => {
        for (let i = 0; i < 200; i++) {
          if (ctx.signal.aborted) {
            cancelled = true;
            return { ok: false, error: 'cancelled' };
          }
          await new Promise((r) => setTimeout(r, 5));
        }
        return { ok: true };
      });

      const review = await mgr.ultrareviewStart('/tmp');
      await vi.waitFor(() => expect(mgr.ultrareviewStatus(review.id)?.status).toBe('running'));
      await mgr.shutdown();
      expect(cancelled).toBe(true);
    });

    it('is idempotent', async () => {
      await mgr.startSession({ name: 'idempotent', cwd: '/tmp' });
      await mgr.shutdown();
      // Second shutdown should not throw
      await mgr.shutdown();
    });
  });

  // ─── TTL Cleanup ────────────────────────────────────────────────────

  describe('TTL cleanup', () => {
    it('cleans up sessions that exceed TTL', async () => {
      const shortTtlMgr = createManager({ sessionTtlMinutes: 1 });

      await shortTtlMgr.startSession({ name: 'ttl-test', cwd: '/tmp' });
      expect(shortTtlMgr.listSessions().length).toBe(1);

      // Advance time past the TTL (1 minute = 60_000ms) + cleanup interval (60_000ms)
      vi.advanceTimersByTime(2 * 60_000);

      expect(shortTtlMgr.listSessions().length).toBe(0);

      await shortTtlMgr.shutdown();
    });
  });

  // ─── Constructor Config ─────────────────────────────────────────────

  describe('constructor config', () => {
    it('uses defaults when no config provided', () => {
      const defaultMgr = new SessionManager();
      patchCreateSession(defaultMgr);

      const h = defaultMgr.health();
      expect(h.ok).toBe(true);

      // Clean up
      defaultMgr.shutdown();
    });

    it('applies pricing overrides', async () => {
      // This is tested indirectly — if pricingOverrides is passed,
      // overrideModelPricing should be called. We test the effect via getModelPricing:
      const { getModelPricing } = await import('../types.js');

      const overrideMgr = createManager({
        pricingOverrides: { 'claude-opus-4-6': { input: 999 } },
      });

      expect(getModelPricing('claude-opus-4-6').input).toBe(999);

      await overrideMgr.shutdown();
    });
  });

  // ─── switchModel ────────────────────────────────────────────────────

  describe('switchModel', () => {
    it('rejects when session is busy', async () => {
      await mgr.startSession({ name: 'busy-switch', cwd: '/tmp' });
      lastMock().setBusy(true);

      await expect(mgr.switchModel('busy-switch', 'sonnet')).rejects.toThrow('currently processing a message');
    });

    it('rejects when session has no session ID', async () => {
      await mgr.startSession({ name: 'no-id', cwd: '/tmp' });
      const mock = lastMock();
      mock.setBusy(false);
      mock.sessionId = undefined;
      // Also clear the managed session's claudeSessionId
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const managed = (mgr as any).sessions.get('no-id');
      managed.claudeSessionId = undefined;

      await expect(mgr.switchModel('no-id', 'sonnet')).rejects.toThrow('has no claude session ID');
    });

    // ── The guard checks the registry, not a frozen prefix list.
    //
    //    It was ['claude-','gemini-','gpt-','anthropic/','google/','openai/'],
    //    which rejects every model the registry has gained since — each of
    //    which `_createSession` can dispatch.
    it('accepts every model the registry actually knows', async () => {
      for (const model of ['grok-4.6', 'grok', 'composer-2', 'o3', 'o4-mini', 'codex-mini-latest']) {
        const name = `switch-${model}`;
        await mgr.startSession({ name, cwd: '/tmp' });
        lastMock().setBusy(false);
        await expect(mgr.switchModel(name, model)).resolves.toBeDefined();
        await mgr.stopSession(name); // the fixture caps concurrent sessions at 5
      }
    });

    it('still accepts a provider-qualified string, which the error message offers', async () => {
      await mgr.startSession({ name: 'switch-qualified', cwd: '/tmp' });
      lastMock().setBusy(false);
      await expect(mgr.switchModel('switch-qualified', 'someprovider/some-model')).resolves.toBeDefined();
    });

    it('rejects unknown model that does not match known patterns', async () => {
      await mgr.startSession({ name: 'bad-model', cwd: '/tmp' });
      lastMock().setBusy(false);

      await expect(mgr.switchModel('bad-model', 'totally-unknown')).rejects.toThrow("Unknown model 'totally-unknown'");
    });

    it('successfully switches model for a valid known-pattern model', async () => {
      await mgr.startSession({ name: 'switch-ok', cwd: '/tmp' });
      lastMock().setBusy(false);

      const info = await mgr.switchModel('switch-ok', 'sonnet');
      expect(info.name).toBe('switch-ok');
      // The session should have been recreated
      expect(mockSessions.length).toBe(2); // original + new
    });

    it('uses the agy conversation UUID, not the synthetic session ID, when switching models', async () => {
      await mgr.startSession({ name: 'agy-switch', cwd: '/tmp', engine: 'agy', model: 'gemini-3.5-flash' });
      lastMock().conversationId = '11111111-2222-3333-4444-555555555555';
      lastMock().setBusy(false);

      await mgr.sendMessage('agy-switch', 'hello');
      await mgr.switchModel('agy-switch', 'agy-pro');

      expect(createdConfigs[1].resumeSessionId).toBe('11111111-2222-3333-4444-555555555555');
      expect(createdConfigs[1].resumeSessionId).not.toMatch(/^mock-session-/);
    });
  });

  // ─── updateTools ────────────────────────────────────────────────────

  describe('updateTools', () => {
    it('rejects when session is busy', async () => {
      await mgr.startSession({ name: 'busy-tools', cwd: '/tmp' });
      lastMock().setBusy(true);

      await expect(mgr.updateTools('busy-tools', { allowedTools: ['Read'] })).rejects.toThrow(
        'currently processing a message',
      );
    });

    it('rejects when no session ID', async () => {
      await mgr.startSession({ name: 'no-id-tools', cwd: '/tmp' });
      const mock = lastMock();
      mock.setBusy(false);
      mock.sessionId = undefined;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mgr as any).sessions.get('no-id-tools').claudeSessionId = undefined;

      await expect(mgr.updateTools('no-id-tools', { allowedTools: ['Read'] })).rejects.toThrow(
        'has no claude session ID',
      );
    });

    it('restarts session with new tools when merge is false', async () => {
      await mgr.startSession({
        name: 'tools-replace',
        cwd: '/tmp',
        allowedTools: ['Read', 'Write'],
      });
      lastMock().setBusy(false);

      await mgr.updateTools('tools-replace', { allowedTools: ['Bash'] });
      // A new session should have been created
      expect(mockSessions.length).toBe(2);
    });

    it('merges tools when merge is true', async () => {
      await mgr.startSession({
        name: 'tools-merge',
        cwd: '/tmp',
        allowedTools: ['Read'],
      });
      lastMock().setBusy(false);

      const info = await mgr.updateTools('tools-merge', {
        allowedTools: ['Write'],
        merge: true,
      });
      expect(info.name).toBe('tools-merge');
    });

    it('uses the agy conversation UUID, not the synthetic session ID, when updating tools', async () => {
      await mgr.startSession({ name: 'agy-tools', cwd: '/tmp', engine: 'agy', model: 'gemini-3.5-flash' });
      lastMock().conversationId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
      lastMock().setBusy(false);

      await mgr.sendMessage('agy-tools', 'hello');
      await mgr.updateTools('agy-tools', { allowedTools: ['Read'] });

      expect(createdConfigs[1].resumeSessionId).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
      expect(createdConfigs[1].resumeSessionId).not.toMatch(/^mock-session-/);
    });
  });

  // ─── Autoloop role configuration ───────────────────────────────────

  describe('autoloop role configuration', () => {
    it('passes independent role engines, models, and custom configs into dispatcher sessions', async () => {
      const coderCustomEngine = { name: 'coder-cli', bin: 'coder-cli', args: {} };
      await mgr.autoloopStart({
        runId: 'multi-engine',
        workspace: '/tmp',
        plannerEngine: 'codex',
        coderEngine: 'custom',
        coderModel: 'coder-model',
        coderCustomEngine,
        reviewerEngine: 'gemini',
        reviewerModel: 'reviewer-model',
      });
      await mgr.getAutoloop('multi-engine')!.dispatcher.spawnSubagents();

      expect(createdConfigs[0]).toMatchObject({
        name: 'autoloop-multi-engine-planner',
        engine: 'codex',
        model: undefined,
      });
      expect(createdConfigs[1]).toMatchObject({
        name: 'autoloop-multi-engine-coder',
        engine: 'custom',
        model: 'coder-model',
        customEngine: coderCustomEngine,
      });
      expect(createdConfigs[2]).toMatchObject({
        name: 'autoloop-multi-engine-reviewer',
        engine: 'gemini',
        model: 'reviewer-model',
      });
    });

    it('suppresses a global default model for non-Claude roles with no explicit model', async () => {
      await mgr.shutdown();
      mgr = createManager({ defaultModel: 'global-claude-default' });

      await mgr.autoloopStart({ runId: 'no-global-model', workspace: '/tmp', plannerEngine: 'codex' });

      expect(createdConfigs[0]).toHaveProperty('model', undefined);
    });

    it('rejects an unknown role engine before creating a session', async () => {
      await expect(
        mgr.autoloopStart({
          runId: 'bad-engine',
          workspace: '/tmp',
          plannerEngine: 'not-real' as 'claude',
        }),
      ).rejects.toThrow("Planner engine 'not-real' is not supported");
      expect(createdConfigs).toEqual([]);
    });

    it('rejects a custom Planner without its trusted config before creating a session', async () => {
      await expect(
        mgr.autoloopStart({ runId: 'missing-custom', workspace: '/tmp', plannerEngine: 'custom' }),
      ).rejects.toThrow('Planner custom engine config is required');
      expect(createdConfigs).toEqual([]);
    });

    it('rejects malformed custom engine configs before creating a session', async () => {
      await expect(
        mgr.autoloopStart({
          runId: 'malformed-custom',
          workspace: '/tmp',
          plannerEngine: 'custom',
          plannerCustomEngine: {
            name: 'bad-custom',
            bin: 'custom-cli',
            args: null,
          } as unknown as NonNullable<SessionConfig['customEngine']>,
        }),
      ).rejects.toThrow('Planner custom engine config.args must be an object');
      expect(createdConfigs).toEqual([]);

      await expect(
        mgr.autoloopStart({
          runId: 'malformed-custom-flag',
          workspace: '/tmp',
          plannerEngine: 'custom',
          plannerCustomEngine: {
            name: 'bad-custom',
            bin: 'custom-cli',
            args: { permissionMode: 42 },
          } as unknown as NonNullable<SessionConfig['customEngine']>,
        }),
      ).rejects.toThrow('Planner custom engine config.args.permissionMode must be a string');
      expect(createdConfigs).toEqual([]);
    });

    it('rejects an autoloop whose reserved Planner session name is already active', async () => {
      await mgr.startSession({
        name: 'autoloop-name-collision-planner',
        cwd: '/tmp',
        engine: 'cursor',
        sandboxMode: 'workspace-write',
      });

      await expect(
        mgr.autoloopStart({ runId: 'name-collision', workspace: '/tmp', plannerEngine: 'codex' }),
      ).rejects.toThrow("Autoloop session name 'autoloop-name-collision-planner' is already in use");
      expect(mgr.getAutoloop('name-collision')).toBeUndefined();
    });

    it('rejects delete while an Autoloop Planner is still starting', async () => {
      let releaseStart!: () => void;
      const startGate = new Promise<void>((resolve) => {
        releaseStart = resolve;
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mgr as any)._createSession = (): ISession => {
        const mock = new MockSession();
        mock.start = async () => {
          await startGate;
          mock.sessionId = 'slow-planner-session';
          return mock;
        };
        mockSessions.push(mock);
        return mock;
      };

      const starting = mgr.autoloopStart({ runId: 'slow-start', workspace: '/tmp' });
      // The live handle is published only once the engine is up, which is
      // exactly what this test blocks. "A start is in flight" is observable from
      // the run record existing while nothing has been published on it yet.
      await vi.waitFor(() => expect(mgr.workflowList({ workflow: 'autoloop' }).length).toBe(1));

      await expect(mgr.autoloopDelete('slow-start')).rejects.toThrow("Autoloop with id 'slow-start' is still starting");
      releaseStart();
      await expect(starting).resolves.toMatchObject({ runId: 'slow-start' });
    });

    it('removes a failed autoloop start so the same run id can be retried', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mgr as any)._createSession = (): ISession => {
        const mock = new MockSession();
        mock.start = async () => {
          throw new Error('planner startup failed');
        };
        return mock;
      };

      await expect(mgr.autoloopStart({ runId: 'retry-start', workspace: '/tmp' })).rejects.toThrow(
        'planner startup failed',
      );
      expect(mgr.getAutoloop('retry-start')).toBeUndefined();

      patchCreateSession(mgr);
      await expect(mgr.autoloopStart({ runId: 'retry-start', workspace: '/tmp' })).resolves.toMatchObject({
        runId: 'retry-start',
      });
    });

    it('leaves the stored run intact when a resume fails to start', async () => {
      // The behaviour this protects: a resume that cannot bring the Planner up
      // must not destroy the record, or the run becomes unrecoverable. It used
      // to be phrased against an append-only registry file; the record is the
      // registry now, so that is what gets checked.
      await mgr.autoloopStart({ runId: 'resume-fail', workspace: '/tmp' });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const kernel = (mgr as any).kernel;
      kernel.cancel('resume-fail');
      await kernel.wait('resume-fail');

      const before = mgr.workflowStatus('resume-fail');
      expect(before).toBeDefined();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mgr as any)._createSession = (): ISession => {
        const mock = new MockSession();
        mock.start = async () => {
          throw new Error('resume planner failed');
        };
        return mock;
      };
      await expect(mgr.autoloopResume('resume-fail')).rejects.toThrow('resume planner failed');

      const after = mgr.workflowStatus('resume-fail');
      expect(after).toBeDefined();
      expect(after.spec).toEqual(before!.spec);
    });

    it('records the engines and models spawn_subagents actually chose', async () => {
      // Used to be written as a row into autoloop-registry.jsonl. It lands on
      // the run record now, which is what `autoloop_status` and a later resume
      // read — and unlike the registry, it survives alongside the rest of the
      // run's state rather than in a parallel file with its own lifecycle.
      await mgr.autoloopStart({ runId: 'spawn-persist', workspace: '/tmp' });
      await mgr.getAutoloop('spawn-persist')!.dispatcher.spawnSubagents({
        coder_engine: 'codex',
        coder_model: 'gpt-coder',
        reviewer_engine: 'gemini',
      });

      await vi.waitFor(() => {
        const run = mgr.workflowStatus('spawn-persist');
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const data = run.nodes.main?.data as any;
        expect(data?.roleSelection).toMatchObject({
          coder: { engine: 'codex', model: 'gpt-coder' },
          reviewer: { engine: 'gemini' },
        });
      });
    });
  });

  // ─── Persisted Sessions ─────────────────────────────────────────────

  describe('persisted sessions', () => {
    it('listPersistedSessions returns persisted entries', async () => {
      await mgr.startSession({ name: 'persist-test', cwd: '/tmp' });

      // After starting, the session should be persisted (since mock has sessionId)
      const persisted = mgr.listPersistedSessions();
      expect(persisted.length).toBeGreaterThanOrEqual(1);
      const entry = persisted.find((p) => p.name === 'persist-test');
      expect(entry).toBeDefined();
      expect(entry!.claudeSessionId).toBeDefined();
    });

    it('stopSession removes from persisted sessions', async () => {
      await mgr.startSession({ name: 'persist-remove', cwd: '/tmp' });
      expect(mgr.listPersistedSessions().find((p) => p.name === 'persist-remove')).toBeDefined();

      await mgr.stopSession('persist-remove');
      expect(mgr.listPersistedSessions().find((p) => p.name === 'persist-remove')).toBeUndefined();
    });

    it('persists and restores sandboxMode for non-Claude sessions', async () => {
      await mgr.startSession({
        name: 'readonly-persist',
        cwd: '/tmp',
        engine: 'cursor',
        sandboxMode: 'read-only',
      });
      await mgr.stopSession('readonly-persist', { keepPersisted: true });
      await mgr.startSession({ name: 'readonly-persist', cwd: '/tmp' });

      expect(createdConfigs.at(-1)).toMatchObject({
        engine: 'cursor',
        sandboxMode: 'read-only',
      });
    });

    it('persists and restores the real Codex thread ID', async () => {
      await mgr.startSession({ name: 'codex-persist', cwd: '/tmp', engine: 'codex', sandboxMode: 'read-only' });
      lastMock().threadId = '019c6dcb-93ad-7dc1-b531-418d213b8761';
      await mgr.sendMessage('codex-persist', 'hello');
      await mgr.stopSession('codex-persist', { keepPersisted: true });

      await mgr.startSession({ name: 'codex-persist', cwd: '/tmp' });

      expect(createdConfigs.at(-1)).toMatchObject({
        engine: 'codex',
        sandboxMode: 'read-only',
        resumeSessionId: '019c6dcb-93ad-7dc1-b531-418d213b8761',
      });
    });

    it('persists the agy conversation UUID after first send and never the synthetic session ID', async () => {
      const info = await mgr.startSession({ name: 'agy-persist', cwd: '/tmp', engine: 'agy' });
      expect(info.claudeSessionId).toBeUndefined();
      expect(mgr.listPersistedSessions().find((p) => p.name === 'agy-persist')).toBeUndefined();

      lastMock().conversationId = '99999999-8888-7777-6666-555555555555';
      const result = await mgr.sendMessage('agy-persist', 'hello');

      expect(result.sessionId).toBe('99999999-8888-7777-6666-555555555555');
      const entry = mgr.listPersistedSessions().find((p) => p.name === 'agy-persist');
      expect(entry?.claudeSessionId).toBe('99999999-8888-7777-6666-555555555555');
      expect(entry?.claudeSessionId).not.toMatch(/^mock-session-/);
    });
  });

  // ─── Council ────────────────────────────────────────────────────────

  describe('council', () => {
    it('councilStatus returns undefined for unknown council', () => {
      expect(mgr.councilStatus('unknown-council')).toBeUndefined();
    });

    it('councilAbort throws for unknown council', () => {
      expect(() => mgr.councilAbort('unknown')).toThrow("Council 'unknown' not found");
    });

    it('councilInject throws for unknown council', () => {
      expect(() => mgr.councilInject('unknown', 'msg')).toThrow("Council 'unknown' not found");
    });

    it('councilReview throws for unknown council', async () => {
      await expect(mgr.councilReview('unknown')).rejects.toThrow("Council 'unknown' not found");
    });

    it('councilAccept throws for unknown council', async () => {
      await expect(mgr.councilAccept('unknown')).rejects.toThrow("Council 'unknown' not found");
    });

    it('councilReject throws for unknown council', async () => {
      await expect(mgr.councilReject('unknown', 'bad work')).rejects.toThrow("Council 'unknown' not found");
    });
  });

  // ─── Input Validation ─────────────────────────────────────────────────

  describe('input validation', () => {
    it('createAgent rejects path-traversal names', () => {
      expect(() => mgr.createAgent('../../etc/evil', '/tmp')).toThrow('Invalid name');
    });

    it('createAgent rejects names with dots', () => {
      expect(() => mgr.createAgent('evil.md', '/tmp')).toThrow('Invalid name');
    });

    it('createSkill rejects path-traversal names', () => {
      expect(() => mgr.createSkill('../../etc/evil', '/tmp')).toThrow('Invalid name');
    });

    it('createRule rejects path-traversal names', () => {
      expect(() => mgr.createRule('../../etc/evil', '/tmp')).toThrow('Invalid name');
    });

    it('listAgents rejects unsafe cwd', () => {
      expect(() => mgr.listAgents('/etc')).toThrow('Unsafe working directory');
    });

    it('listSkills rejects unsafe cwd', () => {
      expect(() => mgr.listSkills('/etc')).toThrow('Unsafe working directory');
    });

    it('listRules rejects unsafe cwd', () => {
      expect(() => mgr.listRules('/etc')).toThrow('Unsafe working directory');
    });

    it('getVersion returns a version string', () => {
      const version = mgr.getVersion();
      expect(typeof version).toBe('string');
      expect(version.length).toBeGreaterThan(0);
    });
  });
});
