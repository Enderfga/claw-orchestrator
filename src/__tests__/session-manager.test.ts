/**
 * Unit tests for SessionManager — the core orchestrator.
 *
 * Strategy: mock the ISession interface so no real CLI processes are spawned.
 * We test orchestration logic: lifecycle, concurrency guards, inbox, model
 * resolution, grep, ultraplan/ultrareview, and shutdown.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
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
      event: { type: 'result', result: 'done' },
    };
  }

  getStats(): SessionStats & { sessionId?: string; uptime: number } {
    return {
      turns: this.sendCalls.length,
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

/**
 * We intercept the _createSession private method to inject MockSession
 * instances instead of real PersistentClaudeSession / PersistentCodexSession.
 */
function patchCreateSession(manager: InstanceType<typeof SessionManager>): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (manager as any)._createSession = (_engine: string, _config: SessionConfig): ISession => {
    const mock = new MockSession();
    mockSessions.push(mock);
    return mock;
  };
}

// ─── Mock fs for persistence tests ──────────────────────────────────────────

// We mock the module-level persistence functions by mocking the node:fs module
// BEFORE importing SessionManager. However, SessionManager also uses fs for
// agents/skills/rules, so we only mock what we need.

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    default: {
      ...actual,
      // Override persistence-related functions to be no-ops in tests
      existsSync: vi.fn((p: string) => {
        if (typeof p === 'string' && p.includes('claude-sessions.json')) return false;
        return actual.existsSync(p);
      }),
      readFileSync: vi.fn((p: string, enc?: string) => {
        if (typeof p === 'string' && p.includes('claude-sessions.json')) return '[]';
        return actual.readFileSync(p, enc as BufferEncoding);
      }),
      writeFileSync: vi.fn((..._args: unknown[]) => {}),
      mkdirSync: vi.fn((..._args: unknown[]) => {}),
      renameSync: vi.fn((..._args: unknown[]) => {}),
      writeFile: vi.fn((_p: unknown, _d: unknown, cb: (err: null) => void) => cb(null)),
      rename: vi.fn((_o: unknown, _n: unknown, cb: (err: null) => void) => cb(null)),
      mkdir: vi.fn((_p: unknown, _opts: unknown, cb: (err: null) => void) => cb(null)),
      unlink: vi.fn((_p: unknown, cb: () => void) => cb()),
    },
    existsSync: vi.fn((p: string) => {
      if (typeof p === 'string' && p.includes('claude-sessions.json')) return false;
      return actual.existsSync(p);
    }),
    readFileSync: vi.fn((p: string, enc?: string) => {
      if (typeof p === 'string' && p.includes('claude-sessions.json')) return '[]';
      return actual.readFileSync(p, enc as BufferEncoding);
    }),
    writeFileSync: vi.fn((..._args: unknown[]) => {}),
    mkdirSync: vi.fn((..._args: unknown[]) => {}),
    renameSync: vi.fn((..._args: unknown[]) => {}),
    writeFile: vi.fn((_p: unknown, _d: unknown, cb: (err: null) => void) => cb(null)),
    rename: vi.fn((_o: unknown, _n: unknown, cb: (err: null) => void) => cb(null)),
    mkdir: vi.fn((_p: unknown, _opts: unknown, cb: (err: null) => void) => cb(null)),
    unlink: vi.fn((_p: unknown, cb: () => void) => cb()),
  };
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
    it('resolves known aliases (opus -> claude-opus-4-8)', async () => {
      await mgr.startSession({ name: 'alias-test', model: 'opus', cwd: '/tmp' });
      const list = mgr.listSessions();
      expect(list[0].model).toBe('claude-opus-4-8');
    });

    it('resolves sonnet alias', async () => {
      await mgr.startSession({ name: 'sonnet-test', model: 'sonnet', cwd: '/tmp' });
      const list = mgr.listSessions();
      expect(list[0].model).toBe('claude-sonnet-4-6');
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
      expect(list[0].model).toBe('claude-sonnet-4-6');
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

  // ─── Ultraplan ──────────────────────────────────────────────────────

  describe('ultraplan', () => {
    it('ultraplanStart creates a result with running status', () => {
      const result = mgr.ultraplanStart('build a feature', { cwd: '/tmp' });
      expect(result.id).toMatch(/^ultraplan-/);
      expect(result.status).toBe('running');
      expect(result.sessionName).toContain('ultraplan-');
      expect(result.startTime).toBeDefined();
    });

    it('ultraplanStatus returns the result by id', () => {
      const result = mgr.ultraplanStart('plan task', { cwd: '/tmp' });
      const status = mgr.ultraplanStatus(result.id);
      expect(status).toBeDefined();
      expect(status!.id).toBe(result.id);
      expect(status!.status).toBe('running');
    });

    it('ultraplanStatus returns undefined for unknown id', () => {
      expect(mgr.ultraplanStatus('nonexistent')).toBeUndefined();
    });
  });

  // ─── Ultrareview ────────────────────────────────────────────────────

  describe('ultrareview', () => {
    it('ultrareviewStart creates result with running status', () => {
      // We need to mock councilStart since it uses Council which we don't want to test here
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mgr as any).councilStart = vi.fn().mockReturnValue({
        id: 'council-mock-123',
        status: 'running',
        task: 'review',
        config: {},
        responses: [],
        startTime: new Date().toISOString(),
      });

      const result = mgr.ultrareviewStart('/tmp', { agentCount: 3 });
      expect(result.id).toMatch(/^ultrareview-/);
      expect(result.status).toBe('running');
      expect(result.agentCount).toBe(3);
      expect(result.councilId).toBe('council-mock-123');
    });

    it('ultrareviewStart clamps agentCount to max 20', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mgr as any).councilStart = vi.fn().mockReturnValue({
        id: 'council-mock-456',
        status: 'running',
        task: 'review',
        config: {},
        responses: [],
        startTime: new Date().toISOString(),
      });

      // agentCount: 0 is falsy, so `0 || 5` defaults to 5
      const result1 = mgr.ultrareviewStart('/tmp', { agentCount: 0 });
      expect(result1.agentCount).toBe(5);

      // Explicit 1 should stay 1
      const result3 = mgr.ultrareviewStart('/tmp', { agentCount: 1 });
      expect(result3.agentCount).toBe(1);

      // Over 20 gets clamped
      const result2 = mgr.ultrareviewStart('/tmp', { agentCount: 50 });
      expect(result2.agentCount).toBe(20);
    });

    it('ultrareviewStatus returns undefined for unknown id', () => {
      expect(mgr.ultrareviewStatus('nonexistent')).toBeUndefined();
    });

    it('ultrareviewStatus returns the stored result', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mgr as any).councilStart = vi.fn().mockReturnValue({
        id: 'council-mock-789',
        status: 'running',
        task: 'review',
        config: {},
        responses: [],
        startTime: new Date().toISOString(),
      });

      const result = mgr.ultrareviewStart('/tmp');
      const status = mgr.ultrareviewStatus(result.id);
      expect(status).toBeDefined();
      expect(status!.id).toBe(result.id);
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

    it('clears ultrareview pollers', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mgr as any).councilStart = vi.fn().mockReturnValue({
        id: 'council-shutdown',
        status: 'running',
        task: 'review',
        config: {},
        responses: [],
        startTime: new Date().toISOString(),
      });

      mgr.ultrareviewStart('/tmp');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((mgr as any).ultrareviewPollers.size).toBe(1);

      await mgr.shutdown();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((mgr as any).ultrareviewPollers.size).toBe(0);
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
