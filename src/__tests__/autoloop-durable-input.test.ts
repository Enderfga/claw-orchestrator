/**
 * Phase A RED + positive controls for durable accepted Autoloop chat.
 * Public SessionManager / EmbeddedServer APIs only. No new production fields.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { spawn, type ChildProcess, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
import { useIsolatedHome } from './helpers/isolate-home.js';

const OWNER_CHILD = fileURLToPath(new URL('./helpers/autoloop-owner-child.ts', import.meta.url));

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

const TEST_WF_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'clawo-durable-input-wf-'));
process.env.CLAWO_WF_DIR = TEST_WF_DIR;
process.env.CLAWO_SESSIONS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'clawo-durable-input-sessions-'));

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
const { EmbeddedServer } = await import('../embedded-server.js');
const { leaseIsStale, readLease } = await import('../kernel/store.js');

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

/** Exact parked-chat label match: U1 must not match U10. */
const textsExactChat = (planner: MockSession, needle: string): string[] =>
  planner.sendCalls.map((call) => messageText(call.message)).filter((text) => text === needle);

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

function initGitWorkspace(workspace: string): void {
  fs.mkdirSync(workspace, { recursive: true });
  execFileSync('git', ['init', '-b', 'main'], { cwd: workspace });
  execFileSync('git', ['config', 'user.email', 'autoloop-test@example.com'], { cwd: workspace });
  execFileSync('git', ['config', 'user.name', 'autoloop-test'], { cwd: workspace });
  fs.writeFileSync(path.join(workspace, 'README.md'), 'workspace\n');
  execFileSync('git', ['add', 'README.md'], { cwd: workspace });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: workspace });
}

describe('Autoloop durable accepted chat (Phase A)', () => {
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

  async function startPaused(runId: string): Promise<{ planner: MockSession }> {
    await mgr.autoloopStart({ runId, workspace: workspaceFor(runId) });
    const planner = mockSessions[0]!;
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

  it('positive: ordinary unpaused chat is delivered once', async () => {
    const runId = 'ctrl-unpaused-once';
    await mgr.autoloopStart({ runId, workspace: workspaceFor(runId) });
    const planner = mockSessions[0]!;
    await mgr.autoloopChat(runId, 'live-once');
    expect(textsExactChat(planner, 'live-once')).toEqual(['live-once']);
  });

  it('positive: live pause then live resume delivers a parked chat once without stop', async () => {
    const runId = 'ctrl-live-pause-resume';
    const { planner } = await startPaused(runId);
    await mgr.autoloopChat(runId, 'PARKED');
    expect(textsExactChat(planner, 'PARKED')).toEqual([]);
    await mgr.autoloopResume(runId);
    await vi.waitFor(() => {
      expect(textsExactChat(planner, 'PARKED')).toEqual(['PARKED']);
    });
  });
});

describe('Autoloop durable accepted chat — owner child + HTTP (real timers)', () => {
  useIsolatedHome();

  let mgr: InstanceType<typeof SessionManager>;

  beforeEach(() => {
    vi.useRealTimers();
    mockSessions = [];
    createdConfigs = [];
    fs.rmSync(TEST_WF_DIR, { recursive: true, force: true });
    fs.mkdirSync(TEST_WF_DIR, { recursive: true });
    mgr = createManager();
  });

  afterEach(async () => {
    await mgr.shutdown();
  });

  const workspaceFor = (runId: string): string => {
    const workspace = path.join(TEST_WF_DIR, 'workspaces', runId);
    fs.mkdirSync(workspace, { recursive: true });
    return workspace;
  };

  // Child inherits HOME/TMPDIR from the test process (fixture paths only on the CLI).
  const spawnOwner = (runId: string, workspace: string, mode: string): ChildProcess =>
    spawn(process.execPath, ['--import', 'tsx', OWNER_CHILD], {
      env: {
        ...process.env,
        AUTOLOOP_MODE: mode,
        AUTOLOOP_RUN_ID: runId,
        AUTOLOOP_WORKSPACE: workspace,
        CLAWO_WF_DIR: TEST_WF_DIR,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

  const waitReadyThenSigkill = async (proc: ChildProcess): Promise<void> => {
    let stderr = '';
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const awaitExit = (): Promise<void> =>
      new Promise<void>((resolve) => {
        if (proc.exitCode !== null || proc.signalCode !== null) {
          resolve();
          return;
        }
        proc.once('exit', () => resolve());
      });
    const forceKillAndAwait = async (): Promise<void> => {
      try {
        if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      await awaitExit();
    };
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`owner child never READY: ${stderr.slice(0, 800)}`)), 45_000);
        proc.stdout?.on('data', (chunk: Buffer) => {
          if (chunk.toString().includes('READY')) {
            clearTimeout(timer);
            resolve();
          }
        });
        proc.on('exit', (code, signal) => {
          clearTimeout(timer);
          reject(new Error(`owner child exited before READY code=${String(code)} signal=${String(signal)} ${stderr}`));
        });
        proc.on('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });
      });
      await forceKillAndAwait();
    } catch (err) {
      await forceKillAndAwait();
      throw err;
    }
  };

  const expectDeliveredOnceInOrder = async (planner: MockSession): Promise<void> => {
    await vi.waitFor(
      () => {
        expect(textsExactChat(planner, 'U1'), 'lost U1: expected exactly one Planner delivery of U1').toEqual(['U1']);
        expect(textsExactChat(planner, 'U2'), 'lost U2: expected exactly one Planner delivery of U2').toEqual(['U2']);
        const delivered = planner.sendCalls.map((call) => messageText(call.message));
        const i1 = delivered.indexOf('U1');
        const i2 = delivered.indexOf('U2');
        expect(i1, 'lost U1: U1 missing from Planner send order').toBeGreaterThanOrEqual(0);
        expect(i1, 'U1/U2 order: U1 must precede U2').toBeLessThan(i2);
      },
      { timeout: 8_000, interval: 50 },
    );
  };

  async function startPaused(runId: string): Promise<{ planner: MockSession }> {
    await mgr.autoloopStart({ runId, workspace: workspaceFor(runId) });
    const planner = mockSessions[0]!;
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

  it('positive: existing owner-child mode planner-only still runs (legacy harness reachable)', async () => {
    const runId = 'ctrl-owner-planner-only';
    const workspace = workspaceFor(runId);
    initGitWorkspace(workspace);
    const proc = spawnOwner(runId, workspace, 'planner-only');
    await waitReadyThenSigkill(proc);
    expect(proc.killed || proc.exitCode !== null || proc.signalCode === 'SIGKILL').toBe(true);
  }, 60_000);

  it('positive: stored run is reconstructed by a real new SessionManager', async () => {
    const runId = 'ctrl-reconstruct-reachable';
    await startPaused(runId);
    await mgr.autoloopStop(runId, 'ctrl-stop');
    // Same pattern as src/__tests__/session-manager.test.ts:3299 (terminateAndReconstruct).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (mgr as any).kernel.wait(runId);
    await mgr.shutdown();
    mockSessions = [];
    createdConfigs = [];
    mgr = createManager();
    const state = await mgr.autoloopResume(runId);
    expect(state).toBeTruthy();
    expect(mgr.getAutoloop(runId)).toBeTruthy();
    expect(mgr.autoloopStatus(runId)).toBeTruthy();
  }, 60_000);

  it('RED R1: pause, chat U1 U2, stop, new manager, resume twice delivers U1 U2 once in order', async () => {
    const runId = 'red-r1-stop-reconstruct';
    await startPaused(runId);
    await mgr.autoloopChat(runId, 'U1');
    await mgr.autoloopChat(runId, 'U2');
    await mgr.autoloopStop(runId, 'red-r1-stop');
    // Same pattern as src/__tests__/session-manager.test.ts:3299 (terminateAndReconstruct).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (mgr as any).kernel.wait(runId);
    await mgr.shutdown();

    mockSessions = [];
    createdConfigs = [];
    mgr = createManager();
    await mgr.autoloopResume(runId);
    await mgr.autoloopResume(runId);
    const planner = mockSessions.find((_, i) => createdConfigs[i]?.name?.endsWith('-planner'));
    expect(planner, 'resume must create a Planner session').toBeTruthy();
    await expectDeliveredOnceInOrder(planner!);
  }, 60_000);

  it('RED R2: paused-input owner accepts U1 U2, SIGKILL, resume twice delivers once in order', async () => {
    const runId = 'red-r2-paused-input-kill';
    const workspace = workspaceFor(runId);
    initGitWorkspace(workspace);
    const proc = spawnOwner(runId, workspace, 'paused-input');
    await waitReadyThenSigkill(proc);

    const observer = createManager();
    try {
      await vi.waitFor(
        () => {
          expect(leaseIsStale(readLease(runId))).toBe(true);
          expect(observer.workflowStatus(runId).state).toBe('running');
        },
        { timeout: 5_000, interval: 50 },
      );

      mockSessions = [];
      createdConfigs = [];
      const resumeMgr = createManager();
      try {
        await resumeMgr.autoloopResume(runId);
        await resumeMgr.autoloopResume(runId);
        const planner = mockSessions.find((_, i) => createdConfigs[i]?.name?.endsWith('-planner'));
        expect(planner, 'resume must create a Planner session').toBeTruthy();
        await expectDeliveredOnceInOrder(planner!);
      } finally {
        await resumeMgr.shutdown();
      }
    } finally {
      await observer.shutdown();
    }
  }, 60_000);

  it('RED R4: HTTP chat 202 while paused; stop; new manager; resume twice delivers once', async () => {
    const runId = 'red-r4-http-chat';
    const workspace = workspaceFor(runId);
    await mgr.autoloopStart({ runId, workspace });
    const planner0 = mockSessions[0]!;
    let replies = 0;
    planner0.sendImplementation = async () => {
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
    expect(mgr.getAutoloop(runId)!.runner.state.status).toBe('paused');

    const ephemeral = await freePort();
    const server = new EmbeddedServer(mgr, ephemeral);
    const port = await server.start();
    const token = fs.readFileSync(path.join(os.homedir(), '.openclaw', 'server-token'), 'utf-8').trim();

    try {
      // 202 is the acceptance claim under test — do not wrap SessionManager.autoloopChat.
      const r1 = await fetch(`http://127.0.0.1:${port}/autoloop/${runId}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ text: 'U1' }),
      });
      expect(r1.status).toBe(202);
      const r2 = await fetch(`http://127.0.0.1:${port}/autoloop/${runId}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ text: 'U2' }),
      });
      expect(r2.status).toBe(202);

      await mgr.autoloopStop(runId, 'red-r4-stop');
      // Same pattern as src/__tests__/session-manager.test.ts:3299 (terminateAndReconstruct).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (mgr as any).kernel.wait(runId);
    } finally {
      await server.stop();
    }

    await mgr.shutdown();
    mockSessions = [];
    createdConfigs = [];
    mgr = createManager();
    await mgr.autoloopResume(runId);
    await mgr.autoloopResume(runId);
    const planner = mockSessions.find((_, i) => createdConfigs[i]?.name?.endsWith('-planner'));
    expect(planner, 'resume must create a Planner session').toBeTruthy();
    await expectDeliveredOnceInOrder(planner!);
  }, 60_000);
});
