/**
 * Regressions for a live ordinary / activity-lease resume.
 * Companion cases R1/R2/C1/C2 live in session-manager.test.ts (same public API).
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
import type { Logger } from '../logger.js';

class MockSession extends EventEmitter implements ISession {
  sessionId?: string;
  private _isReady = true;
  private _isPaused = false;
  private _isBusy = false;
  private _effort: EffortLevel = 'auto';
  startCalled = 0;
  stopCalled = 0;
  sendCalls: Array<{ message: string | unknown[]; options?: SessionSendOptions }> = [];
  sendImplementation?: (
    message: string | unknown[],
    options?: SessionSendOptions,
  ) => Promise<TurnResult | { requestId: number; sent: boolean }>;

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
    if (options?.waitForComplete === false) return { requestId: 1, sent: true };
    if (this.sendImplementation) return await this.sendImplementation(message, options);
    return { text: 'ack', event: { type: 'result', result: 'ok' } };
  }
  getStats(): SessionStats & { sessionId?: string; uptime: number } {
    return {
      turns: this.sendCalls.length,
      turnsSucceeded: this.sendCalls.length,
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
  getHistory(): Array<{ time: string; type: string; event: unknown }> {
    return [];
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
  async compact(): Promise<TurnResult> {
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

let mockSessions: MockSession[] = [];
let createdConfigs: SessionConfig[] = [];

function patchCreateSession(manager: InstanceType<typeof SessionManager>): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (manager as any)._createSession = (_engine: string, _config: SessionConfig): ISession => {
    const mock = new MockSession();
    mockSessions.push(mock);
    createdConfigs.push(_config);
    return mock;
  };
}

const TEST_WF_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'clawo-live-resume-wf-'));
process.env.CLAWO_WF_DIR = TEST_WF_DIR;
process.env.CLAWO_SESSIONS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'clawo-live-resume-sessions-'));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
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
  const openSync = vi.fn((p: unknown, ...rest: unknown[]) =>
    (actual.openSync as (...a: unknown[]) => number)(p, ...rest),
  );
  const writeSync = vi.fn((fd: unknown, ...rest: unknown[]) =>
    (actual.writeSync as (...a: unknown[]) => number)(fd, ...rest),
  );
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
    openSync,
    writeSync,
    mkdirSync,
    renameSync,
    writeFile: vi.fn((_p: unknown, _d: unknown, cb: (err: null) => void) => cb(null)),
    rename: vi.fn((_o: unknown, _n: unknown, cb: (err: null) => void) => cb(null)),
    mkdir: vi.fn((_p: unknown, _opts: unknown, cb: (err: null) => void) => cb(null)),
    unlink: vi.fn((_p: unknown, cb: () => void) => cb()),
  };
  return { ...actual, ...shim, default: { ...actual, ...shim } };
});

const { SessionManager } = await import('../session-manager.js');

function createManager(logger?: Logger): InstanceType<typeof SessionManager> {
  const mgr = new SessionManager(
    {
      claudeBin: 'mock-claude',
      maxConcurrentSessions: 5,
      sessionTtlMinutes: 120,
      defaultPermissionMode: 'acceptEdits',
      defaultEffort: 'auto',
    },
    logger,
  );
  patchCreateSession(mgr);
  return mgr;
}

const fence = (tool: string, args: Record<string, unknown>): string =>
  `\`\`\`autoloop\n${JSON.stringify({ tool, args })}\n\`\`\``;

const messageText = (message: string | unknown[]): string =>
  typeof message === 'string' ? message : JSON.stringify(message);

const textsIncluding = (planner: MockSession, needle: string): string[] =>
  planner.sendCalls.map((call) => messageText(call.message)).filter((text) => text.includes(needle));

/** Exact parked-chat label match: U1 must not match U10. */
const textsExactChat = (planner: MockSession, needle: string): string[] =>
  planner.sendCalls.map((call) => messageText(call.message)).filter((text) => text === needle);

describe('Autoloop live pause resume regressions', () => {
  let mgr: InstanceType<typeof SessionManager>;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    mockSessions = [];
    createdConfigs = [];
    fs.rmSync(TEST_WF_DIR, { recursive: true, force: true });
    fs.mkdirSync(TEST_WF_DIR, { recursive: true });
    mgr = createManager();
  });

  const settleShutdown = async (target: InstanceType<typeof SessionManager>): Promise<void> => {
    const done = target.shutdown();
    let settled = false;
    void done.finally(() => {
      settled = true;
    });
    for (let step = 0; step < 120 && !settled; step += 1) {
      await vi.advanceTimersByTimeAsync(1_000);
    }
    if (!settled) throw new Error('shutdown did not settle after advancing fake timers');
    await done;
  };

  afterEach(async () => {
    await settleShutdown(mgr);
    vi.useRealTimers();
  });

  const workspaceFor = (runId: string): string => {
    const workspace = path.join(TEST_WF_DIR, 'workspaces', runId);
    fs.mkdirSync(workspace, { recursive: true });
    return workspace;
  };

  // Exact fake-time moves. shouldAdvanceTime is off, so a 1ms boundary
  // cannot be walked past by the 20ms auto-advance interval.
  const advanceTo = async (absoluteMs: number): Promise<void> => {
    const delta = absoluteMs - Date.now();
    if (delta > 0) await vi.advanceTimersByTimeAsync(delta);
  };

  const flushUntil = async (ready: () => boolean): Promise<void> => {
    for (let i = 0; i < 30; i++) {
      if (ready()) return;
      await Promise.resolve();
    }
    expect(ready()).toBe(true);
  };

  async function startPaused(runId: string): Promise<{ planner: MockSession }> {
    await mgr.autoloopStart({ runId, workspace: workspaceFor(runId) });
    const planner = mockSessions[0];
    let replies = 0;
    planner.sendImplementation = async () => {
      replies += 1;
      if (replies === 1) {
        return {
          text: fence('pause_loop', { reason: 'operator-hold' }),
          event: { type: 'result', result: 'ok' },
        };
      }
      return { text: 'ack', event: { type: 'result', result: 'ok' } };
    };
    await mgr.autoloopChat(runId, 'pause-trigger');
    expect(mgr.getAutoloop(runId)!.runner.state).toMatchObject({
      status: 'paused',
      status_reason: 'operator-hold',
      pending_dispatch: null,
    });
    return { planner };
  }

  it('(a) resume while already active is idempotent and sends nothing', async () => {
    const runId = 'regress-active-resume';
    await mgr.autoloopStart({ runId, workspace: workspaceFor(runId) });
    const planner = mockSessions[0];
    await mgr.autoloopChat(runId, 'already-live');
    const before = planner.sendCalls.length;
    const state = mgr.getAutoloop(runId)!.runner.state;
    const resumed = await mgr.autoloopResume(runId);
    expect(resumed).toBe(state);
    expect(resumed.status).toBe('planning');
    expect(planner.sendCalls).toHaveLength(before);
    expect(createdConfigs.map((config) => config.name)).toEqual([`autoloop-${runId}-planner`]);
  });

  it('(b) back-to-back resumes and Promise.all deliver parked input exactly once', async () => {
    const runId = 'regress-double-resume';
    const { planner } = await startPaused(runId);
    await mgr.autoloopChat(runId, 'U1');
    await mgr.autoloopChat(runId, 'U2');
    await mgr.autoloopResume(runId);
    await mgr.autoloopResume(runId);
    // Delivery is async once resume returns after the sync transition only.
    await vi.waitFor(() => {
      expect(textsIncluding(planner, 'U1')).toEqual(['U1']);
      expect(textsIncluding(planner, 'U2')).toEqual(['U2']);
    });

    const runId2 = 'regress-parallel-resume';
    mockSessions = [];
    createdConfigs = [];
    await mgr.autoloopStart({ runId: runId2, workspace: workspaceFor(runId2) });
    const planner2 = mockSessions[0];
    planner2.sendImplementation = async () => ({
      text: fence('pause_loop', { reason: 'operator-hold' }),
      event: { type: 'result', result: 'ok' },
    });
    await mgr.autoloopChat(runId2, 'pause-trigger');
    planner2.sendImplementation = async () => ({ text: 'ack', event: { type: 'result', result: 'ok' } });
    await mgr.autoloopChat(runId2, 'ONCE');
    await Promise.all([mgr.autoloopResume(runId2), mgr.autoloopResume(runId2)]);
    await vi.waitFor(() => {
      expect(textsIncluding(planner2, 'ONCE')).toEqual(['ONCE']);
    });
  });

  it('(c) after spawn_subagents, pause+resume gives running and creates no new role sessions', async () => {
    const runId = 'regress-spawn-resume';
    await mgr.autoloopStart({ runId, workspace: workspaceFor(runId) });
    const planner = mockSessions[0];
    planner.sendImplementation = async (message) => {
      const text = messageText(message);
      if (text.includes('spawn-now')) {
        return { text: fence('spawn_subagents', {}), event: { type: 'result', result: 'ok' } };
      }
      if (text.includes('pause-now')) {
        return {
          text: fence('pause_loop', { reason: 'operator-hold' }),
          event: { type: 'result', result: 'ok' },
        };
      }
      return { text: 'ack', event: { type: 'result', result: 'ok' } };
    };
    await mgr.autoloopChat(runId, 'spawn-now');
    expect(mgr.getAutoloop(runId)!.runner.state.status).toBe('running');
    const namesAfterSpawn = createdConfigs.map((config) => config.name);
    expect(namesAfterSpawn).toEqual([
      `autoloop-${runId}-planner`,
      `autoloop-${runId}-coder`,
      `autoloop-${runId}-reviewer`,
    ]);
    await mgr.autoloopChat(runId, 'pause-now');
    expect(mgr.getAutoloop(runId)!.runner.state.status).toBe('paused');
    const resumed = await mgr.autoloopResume(runId);
    expect(resumed).toMatchObject({ status: 'running', status_reason: null, pending_dispatch: null });
    expect(createdConfigs.map((config) => config.name)).toEqual(namesAfterSpawn);
    expect(mockSessions).toHaveLength(namesAfterSpawn.length);
  });

  it('(d) resume at/after the hard deadline terminates with hard_timeout_exceeded and delivers nothing', async () => {
    const runId = 'regress-hard-deadline-resume';
    const hardTimeoutMs = 600_000;
    await mgr.autoloopStart({
      runId,
      workspace: workspaceFor(runId),
      activityLeaseMs: 60_000,
      autoloopHardTimeoutMs: hardTimeoutMs,
    });
    const handle = mgr.getAutoloop(runId)!;
    const planner = mockSessions[0];
    planner.sendImplementation = async () => ({
      text: fence('pause_loop', { reason: 'operator-hold' }),
      event: { type: 'result', result: 'ok' },
    });
    await mgr.autoloopChat(runId, 'pause-trigger');
    planner.sendImplementation = async () => ({ text: 'ack', event: { type: 'result', result: 'ok' } });
    const sendsAtPark = planner.sendCalls.length;
    await mgr.autoloopChat(runId, 'PARKED');
    expect(textsIncluding(planner, 'PARKED')).toEqual([]);
    vi.setSystemTime(Date.parse(handle.runner.state.started_at) + hardTimeoutMs);
    expect(Date.now()).toBe(Date.parse(handle.runner.state.started_at) + hardTimeoutMs);
    const resumed = await mgr.autoloopResume(runId);
    expect(resumed).toMatchObject({ status: 'terminated', status_reason: 'hard_timeout_exceeded' });
    expect(planner.sendCalls).toHaveLength(sendsAtPark);
    expect(textsIncluding(planner, 'PARKED')).toEqual([]);
  });

  it('(e) Planner resume_loop after lease expiry re-arms the lease', async () => {
    const runId = 'regress-resume-loop-rearm';
    const activityLeaseMs = 60_000;
    await mgr.autoloopStart({
      runId,
      workspace: workspaceFor(runId),
      activityLeaseMs,
      autoloopHardTimeoutMs: 600_000,
    });
    const handle = mgr.getAutoloop(runId)!;
    const planner = mockSessions[0];
    const startedAt = Date.parse(handle.runner.state.started_at);
    const hardAt = startedAt + 600_000;
    const timeouts: string[] = [];
    handle.runner.on('timeout', (event: { kind: string }) => timeouts.push(event.kind));
    let release!: (value: TurnResult) => void;
    planner.sendImplementation = () =>
      new Promise<TurnResult>((resolve) => {
        release = resolve;
      });
    const chat = mgr.autoloopChat(runId, 'hold-for-lease');
    await flushUntil(() => planner.sendCalls.length === 1);
    await advanceTo(handle.runner.state.last_activity_at + activityLeaseMs);
    expect(handle.runner.state).toMatchObject({ status: 'paused', status_reason: 'activity_lease_expired' });
    expect(timeouts).toEqual(['activity_lease_expired']);
    release({ text: fence('resume_loop', {}), event: { type: 'result', result: 'ok' } });
    await chat;
    expect(handle.runner.state).toMatchObject({ status: 'planning', status_reason: null, pending_dispatch: null });
    const renewed = handle.runner.state.last_activity_at + activityLeaseMs;
    await advanceTo(renewed - 1);
    expect(Date.now()).toBe(renewed - 1);
    expect(handle.runner.state.status).toBe('planning');
    expect(timeouts).toEqual(['activity_lease_expired']);
    await advanceTo(renewed);
    expect(Date.now()).toBe(renewed);
    expect(handle.runner.state.status_reason).toBe('activity_lease_expired');
    expect(timeouts).toEqual(['activity_lease_expired', 'activity_lease_expired']);
    await advanceTo(hardAt - 1);
    expect(handle.runner.state.status_reason).toBe('activity_lease_expired');
    await advanceTo(hardAt);
    expect(handle.runner.state).toMatchObject({
      status: 'terminated',
      status_reason: 'hard_timeout_exceeded',
    });
    expect(Date.parse(handle.runner.state.started_at)).toBe(startedAt);
  });

  it('(f) the lease expiring during an in-flight Planner turn, then resume, gives no duplicate delivery', async () => {
    const runId = 'regress-inflight-lease';
    const activityLeaseMs = 60_000;
    await mgr.autoloopStart({
      runId,
      workspace: workspaceFor(runId),
      activityLeaseMs,
      autoloopHardTimeoutMs: 600_000,
    });
    const handle = mgr.getAutoloop(runId)!;
    const planner = mockSessions[0];
    let release!: (value: TurnResult) => void;
    planner.sendImplementation = () =>
      new Promise<TurnResult>((resolve) => {
        release = resolve;
      });
    const chat = mgr.autoloopChat(runId, 'INFLIGHT');
    await flushUntil(() => planner.sendCalls.length === 1);
    await advanceTo(handle.runner.state.last_activity_at + activityLeaseMs);
    expect(handle.runner.state.status_reason).toBe('activity_lease_expired');
    release({ text: 'ack', event: { type: 'result', result: 'ok' } });
    await chat;
    planner.sendImplementation = undefined;
    await mgr.autoloopResume(runId);
    expect(handle.runner.state).toMatchObject({ status: 'planning', status_reason: null });
    // Parked INFLIGHT is drained after the sync resume return.
    await vi.waitFor(() => {
      expect(textsIncluding(planner, 'INFLIGHT')).toEqual(['INFLIGHT']);
    });
  });

  it("(g) a non-owning manager's autoloopStatus agrees with the resumed status", async () => {
    const runId = 'regress-non-owning-status';
    const { planner } = await startPaused(runId);
    await mgr.autoloopChat(runId, 'U1');
    const resumed = await mgr.autoloopResume(runId);
    await vi.waitFor(() => {
      expect(textsIncluding(planner, 'U1')).toEqual(['U1']);
    });
    const observer = createManager();
    try {
      const observed = observer.autoloopStatus(runId);
      expect(observed?.status).toBe(resumed.status);
      expect(observed?.status_reason).toBe(resumed.status_reason);
      expect(observed?.pending_dispatch).toEqual(resumed.pending_dispatch);
    } finally {
      await settleShutdown(observer);
    }
  });

  it('(h) pending-dispatch no-option resume is a no-op and leaves the lease suspension untouched', async () => {
    const runId = 'regress-pending-noop';
    const activityLeaseMs = 60_000;
    await mgr.autoloopStart({
      runId,
      workspace: workspaceFor(runId),
      sendTimeoutMs: 600_000,
      activityLeaseMs,
      autoloopHardTimeoutMs: 600_000,
    });
    const handle = mgr.getAutoloop(runId)!;
    const planner = mockSessions[0];
    const timeouts: string[] = [];
    handle.runner.on('timeout', (event: { kind: string }) => timeouts.push(event.kind));
    planner.sendImplementation = async () => {
      throw new Error('Timeout waiting for response');
    };
    await mgr.autoloopChat(runId, 'timed-out-turn');
    const before = {
      status: handle.runner.state.status,
      status_reason: handle.runner.state.status_reason,
      pending: handle.runner.state.pending_dispatch,
      last_activity_at: handle.runner.state.last_activity_at,
      sends: planner.sendCalls.length,
    };
    expect(before.status).toBe('paused');
    expect(before.status_reason).toBe(`awaiting_resume:send_timeout:planner:${before.pending?.dispatch_id}`);
    const observed = await mgr.autoloopResume(runId);
    expect(observed).toBe(handle.runner.state);
    expect(observed.status).toBe(before.status);
    expect(observed.status_reason).toBe(before.status_reason);
    expect(observed.pending_dispatch).toEqual(before.pending);
    expect(observed.last_activity_at).toBe(before.last_activity_at);
    expect(planner.sendCalls).toHaveLength(before.sends);
    await advanceTo(before.last_activity_at + activityLeaseMs);
    expect(handle.runner.state.status_reason).toBe(before.status_reason);
    expect(handle.runner.state.pending_dispatch).toEqual(before.pending);
    expect(handle.runner.state.last_activity_at).toBe(before.last_activity_at);
    expect(timeouts).toEqual([]);
  });

  it('(i) public resume returns while a follow-up is blocked', async () => {
    const runId = 'regress-resume-returns-while-follow-up-blocked';
    await mgr.autoloopStart({ runId, workspace: workspaceFor(runId) });
    const planner = mockSessions[0];
    planner.sendImplementation = async (message) => {
      const text = messageText(message);
      if (text.includes('spawn-now')) {
        return { text: fence('spawn_subagents', {}), event: { type: 'result', result: 'ok' } };
      }
      if (text.includes('pause-now')) {
        return {
          text: fence('pause_loop', { reason: 'operator-hold' }),
          event: { type: 'result', result: 'ok' },
        };
      }
      if (text.includes('U1')) {
        return {
          text: fence('send_directive', {
            goal: 'follow-up-while-resume-returns',
            constraints: [],
            success_criteria: [],
            max_attempts: 1,
          }),
          event: { type: 'result', result: 'ok' },
        };
      }
      return { text: 'ack', event: { type: 'result', result: 'ok' } };
    };
    await mgr.autoloopChat(runId, 'spawn-now');
    expect(mgr.getAutoloop(runId)!.runner.state.status).toBe('running');
    const namesAfterSpawn = createdConfigs.map((config) => config.name);
    expect(namesAfterSpawn).toEqual([
      `autoloop-${runId}-planner`,
      `autoloop-${runId}-coder`,
      `autoloop-${runId}-reviewer`,
    ]);
    const coder = mockSessions[namesAfterSpawn.indexOf(`autoloop-${runId}-coder`)];
    await mgr.autoloopChat(runId, 'pause-now');
    expect(mgr.getAutoloop(runId)!.runner.state).toMatchObject({
      status: 'paused',
      status_reason: 'operator-hold',
      pending_dispatch: null,
    });
    await mgr.autoloopChat(runId, 'U1');
    await mgr.autoloopChat(runId, 'U2');
    expect(textsIncluding(planner, 'U1')).toEqual([]);
    expect(textsIncluding(planner, 'U2')).toEqual([]);

    let releaseCoder!: (value: TurnResult) => void;
    coder.sendImplementation = () =>
      new Promise<TurnResult>((resolve) => {
        releaseCoder = resolve;
      });

    let settled = false;
    let resolved: Awaited<ReturnType<typeof mgr.autoloopResume>> | undefined;
    const p = mgr.autoloopResume(runId).then((state) => {
      resolved = state;
      return state;
    });
    void p.finally(() => {
      settled = true;
    });
    await flushUntil(() => coder.sendCalls.length === 1);
    try {
      await flushUntil(() => settled);
      const live = mgr.getAutoloop(runId)!.runner.state;
      expect(resolved).toBe(live);
      expect(resolved).toMatchObject({
        status: 'running',
        status_reason: null,
        pending_dispatch: null,
      });
      expect(coder.sendCalls).toHaveLength(1);
      expect(
        coder.sendCalls.filter((call) => messageText(call.message).includes('follow-up-while-resume-returns')),
      ).toHaveLength(1);
    } finally {
      releaseCoder({ text: 'coder-ack', event: { type: 'result', result: 'ok' } });
      await p;
    }
    await vi.waitFor(() => {
      const delivered = planner.sendCalls.map((call) => messageText(call.message));
      const u1 = delivered.flatMap((text, index) => (text.includes('U1') ? [index] : []));
      const u2 = delivered.flatMap((text, index) => (text.includes('U2') ? [index] : []));
      const acks = delivered.flatMap((text, index) =>
        text.includes('directive_ack') || text.includes('[system] coder') ? [index] : [],
      );
      expect(u1).toHaveLength(1);
      expect(u2).toHaveLength(1);
      expect(u1[0]).toBeLessThan(u2[0]);
      expect(acks).toHaveLength(1);
      expect(acks[0]).toBeGreaterThan(u2[0]);
    });
    expect(coder.sendCalls).toHaveLength(1);
    expect(createdConfigs.map((config) => config.name)).toEqual(namesAfterSpawn);
    expect(mockSessions).toHaveLength(namesAfterSpawn.length);
  });

  it('(j) depth-guard drain failure logs once without unhandledRejection', async () => {
    const runId = 'regress-depth-guard-drain-error';
    const errorLogs: string[] = [];
    const logger: Logger = {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: (msg: string) => {
        errorLogs.push(msg);
      },
    };
    await settleShutdown(mgr);
    mgr = createManager(logger);
    const { planner } = await startPaused(runId);
    planner.sendImplementation = async () => ({ text: 'ack', event: { type: 'result', result: 'ok' } });

    for (let i = 1; i <= 66; i++) {
      await mgr.autoloopChat(runId, `U${i}`);
    }
    expect(planner.sendCalls.map((call) => messageText(call.message)).some((text) => text.includes('U1'))).toBe(false);

    const rejections: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      rejections.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const resumed = await mgr.autoloopResume(runId);
      expect(resumed).toMatchObject({
        status: 'planning',
        status_reason: null,
        pending_dispatch: null,
      });
      await vi.waitFor(() => {
        expect(errorLogs).toHaveLength(1);
      });
      expect(rejections).toEqual([]);
      expect(errorLogs[0]).toBe(`[autoloop/${runId}] background runner task failed`);
      await vi.waitFor(() => {
        for (let i = 1; i <= 65; i++) {
          expect(textsExactChat(planner, `U${i}`)).toEqual([`U${i}`]);
        }
      });
      expect(textsExactChat(planner, 'U66')).toEqual([]);

      const namesBefore = createdConfigs.map((config) => config.name);
      await mgr.autoloopChat(runId, 'U67');
      await vi.waitFor(() => {
        expect(textsExactChat(planner, 'U66')).toEqual(['U66']);
        expect(textsExactChat(planner, 'U67')).toEqual(['U67']);
      });
      for (let i = 1; i <= 67; i++) {
        expect(textsExactChat(planner, `U${i}`)).toEqual([`U${i}`]);
      }
      const delivered = planner.sendCalls.map((call) => messageText(call.message));
      const uIndexes = Array.from({ length: 67 }, (_, i) => {
        const needle = `U${i + 1}`;
        const hits = delivered.flatMap((text, index) => (text === needle ? [index] : []));
        expect(hits).toHaveLength(1);
        return hits[0]!;
      });
      for (let i = 1; i < uIndexes.length; i++) {
        expect(uIndexes[i]).toBeGreaterThan(uIndexes[i - 1]!);
      }
      expect(createdConfigs.map((config) => config.name)).toEqual(namesBefore);
      expect(mgr.getAutoloop(runId)!.runner.state).toMatchObject({
        status: 'planning',
        status_reason: null,
        pending_dispatch: null,
      });
      expect(rejections).toEqual([]);
      expect(errorLogs).toHaveLength(1);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
