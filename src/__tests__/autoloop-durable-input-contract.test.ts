/**
 * Phase B contract tests for durable accepted Autoloop chat (not the Phase A RED file).
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
import { formatAutoloopBackgroundErrorReason, AutoloopInputPersistenceError } from '../autoloop/recovery.js';

class MockSession extends EventEmitter implements ISession {
  sessionId?: string;
  sendCalls: Array<{ message: string | unknown[] }> = [];
  sendImplementation?: (
    message: string | unknown[],
    options?: SessionSendOptions,
  ) => Promise<TurnResult | { requestId: number; sent: boolean }>;
  get isReady() {
    return true;
  }
  get isPaused() {
    return false;
  }
  get isBusy() {
    return false;
  }
  async start(): Promise<this> {
    this.sessionId = `mock-${Date.now()}`;
    return this;
  }
  stop(): void {}
  pause(): void {}
  resume(): void {}
  async send(message: string | unknown[], options?: SessionSendOptions) {
    this.sendCalls.push({ message });
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
      tokensIn: 0,
      tokensOut: 0,
      cachedTokens: 0,
      costUsd: 0,
      isReady: true,
      startTime: new Date().toISOString(),
      lastActivity: new Date().toISOString(),
      contextPercent: 1,
      retries: 0,
      sessionId: this.sessionId,
      uptime: 1,
    };
  }
  getHistory() {
    return [];
  }
  getCost(): CostBreakdown {
    return {
      model: 'mock',
      tokensIn: 0,
      tokensOut: 0,
      cachedTokens: 0,
      pricing: { inputPer1M: 0, outputPer1M: 0, cachedPer1M: 0 },
      breakdown: { inputCost: 0, cachedCost: 0, outputCost: 0 },
      totalUsd: 0,
    };
  }
  async compact(): Promise<TurnResult> {
    return { text: '', event: { type: 'result' } };
  }
  getEffort(): EffortLevel {
    return 'auto';
  }
  setEffort(): void {}
  resolveModel(a: string) {
    return a;
  }
}

let mockSessions: MockSession[] = [];
const TEST_WF_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'clawo-durable-contract-wf-'));
process.env.CLAWO_WF_DIR = TEST_WF_DIR;
process.env.CLAWO_SESSIONS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'clawo-durable-contract-sessions-'));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  const PROTECTED = ['claude-sessions.json', 'session-pids.json'];
  const isProtected = (p: unknown): boolean => typeof p === 'string' && PROTECTED.some((name) => p.includes(name));
  const shim = {
    existsSync: vi.fn((p: string) => (isProtected(p) ? false : actual.existsSync(p))),
    readFileSync: vi.fn((p: string, enc?: string) =>
      isProtected(p) ? '[]' : actual.readFileSync(p, enc as BufferEncoding),
    ),
    writeFileSync: vi.fn((p: unknown, ...rest: unknown[]) => {
      if (isProtected(p)) return;
      (actual.writeFileSync as (...a: unknown[]) => void)(p, ...rest);
    }),
    appendFileSync: vi.fn((p: unknown, ...rest: unknown[]) => {
      if (isProtected(p)) return;
      (actual.appendFileSync as (...a: unknown[]) => void)(p, ...rest);
    }),
    openSync: actual.openSync.bind(actual),
    writeSync: actual.writeSync.bind(actual),
    mkdirSync: actual.mkdirSync.bind(actual),
    renameSync: actual.renameSync.bind(actual),
    writeFile: vi.fn((_p: unknown, _d: unknown, cb: (err: null) => void) => cb(null)),
    rename: vi.fn((_o: unknown, _n: unknown, cb: (err: null) => void) => cb(null)),
    mkdir: vi.fn((_p: unknown, _opts: unknown, cb: (err: null) => void) => cb(null)),
    unlink: vi.fn((_p: unknown, cb: () => void) => cb()),
  };
  return { ...actual, ...shim, default: { ...actual, ...shim } };
});

const { SessionManager } = await import('../session-manager.js');

function patch(mgr: InstanceType<typeof SessionManager>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (mgr as any)._createSession = (_e: string, _c: SessionConfig): ISession => {
    const m = new MockSession();
    mockSessions.push(m);
    return m;
  };
}

const fence = (tool: string, args: Record<string, unknown>) =>
  `\`\`\`autoloop\n${JSON.stringify({ tool, args })}\n\`\`\``;

describe('durable input contract', () => {
  let mgr: InstanceType<typeof SessionManager>;

  beforeEach(() => {
    mockSessions = [];
    fs.rmSync(TEST_WF_DIR, { recursive: true, force: true });
    fs.mkdirSync(TEST_WF_DIR, { recursive: true });
    mgr = new SessionManager({
      claudeBin: 'mock-claude',
      maxConcurrentSessions: 5,
      sessionTtlMinutes: 120,
      defaultPermissionMode: 'acceptEdits',
    });
    patch(mgr);
  });

  afterEach(async () => {
    await mgr.shutdown();
  });

  const workspaceFor = (runId: string) => {
    const w = path.join(TEST_WF_DIR, 'workspaces', runId);
    fs.mkdirSync(w, { recursive: true });
    return w;
  };

  async function startPaused(runId: string) {
    await mgr.autoloopStart({ runId, workspace: workspaceFor(runId) });
    const planner = mockSessions[0]!;
    let n = 0;
    planner.sendImplementation = async () => {
      n += 1;
      if (n === 1)
        return { text: fence('pause_loop', { reason: 'operator-hold' }), event: { type: 'result', result: 'ok' } };
      return { text: 'ack', event: { type: 'result', result: 'ok' } };
    };
    await mgr.autoloopChat(runId, 'pause-trigger');
    return planner;
  }

  it('second reconstruction before release still delivers pending once', async () => {
    const runId = 'contract-second-recovery';
    await startPaused(runId);
    await mgr.autoloopChat(runId, 'U1');
    await mgr.autoloopStop(runId, 'stop1');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (mgr as any).kernel.wait(runId);
    await mgr.shutdown();

    mgr = new SessionManager({
      claudeBin: 'mock-claude',
      maxConcurrentSessions: 5,
      sessionTtlMinutes: 120,
      defaultPermissionMode: 'acceptEdits',
    });
    patch(mgr);
    mockSessions = [];
    await mgr.autoloopResume(runId);
    await mgr.autoloopStop(runId, 'stop2');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (mgr as any).kernel.wait(runId);
    await mgr.shutdown();

    mgr = new SessionManager({
      claudeBin: 'mock-claude',
      maxConcurrentSessions: 5,
      sessionTtlMinutes: 120,
      defaultPermissionMode: 'acceptEdits',
    });
    patch(mgr);
    mockSessions = [];
    await mgr.autoloopResume(runId);
    await mgr.autoloopResume(runId);
    const planner = mockSessions[0]!;
    await vi.waitFor(() => {
      const texts = planner.sendCalls.map((c) => (typeof c.message === 'string' ? c.message : ''));
      expect(texts.filter((t) => t === 'U1')).toEqual(['U1']);
    });
  }, 60_000);

  it('generic resume with uncertain input returns input_disposition_required', async () => {
    const runId = 'contract-uncertain-409';
    await mgr.autoloopStart({ runId, workspace: workspaceFor(runId) });
    const planner = mockSessions[0]!;
    planner.sendImplementation = async () => {
      throw new Error('planner transport failed');
    };
    await expect(mgr.autoloopChat(runId, 'boom')).rejects.toThrow();
    const handle = mgr.getAutoloop(runId)!;
    expect(handle.runner.hasUncertainItems()).toBe(true);
    await expect(mgr.autoloopResume(runId)).rejects.toThrow('input_disposition_required');
    expect(handle.runner.state.status).toBe('paused');
  });

  it('status pending_input never includes chat text', async () => {
    const runId = 'contract-textfree-status';
    await startPaused(runId);
    await mgr.autoloopChat(runId, 'SECRET_TEXT_SHOULD_NOT_LEAK');
    const state = mgr.autoloopStatus(runId)!;
    expect(state.pending_input).toBeTruthy();
    expect(JSON.stringify(state.pending_input)).not.toContain('SECRET_TEXT_SHOULD_NOT_LEAK');
  });
});

describe('formatAutoloopBackgroundErrorReason negatives', () => {
  it('rebuilds depth template and withholds raw Error details', () => {
    const depth = new Error(
      `dispatch depth exceeded 64 at iter 3 (next='chat' to 'planner') — likely message ping-pong; raise config.maxDispatchDepth for legitimately deep workflows`,
    );
    expect(formatAutoloopBackgroundErrorReason(depth)).toContain('dispatch depth exceeded 64 at iter 3');
    expect(formatAutoloopBackgroundErrorReason(new Error('stack\nsecret'))).toBe('Error (details withheld)');
    expect(formatAutoloopBackgroundErrorReason(new TypeError('x'))).toBe('TypeError (details withheld)');
    expect(formatAutoloopBackgroundErrorReason(null)).toBe('background task failed (details withheld)');
    const proxy = new Proxy(
      {},
      {
        get() {
          throw new Error('trap');
        },
      },
    );
    expect(formatAutoloopBackgroundErrorReason(proxy)).toBe('background task failed (details withheld)');
    expect(formatAutoloopBackgroundErrorReason(new AutoloopInputPersistenceError('commit_refused', 'x'))).toBe(
      'input persistence refused (commit_refused)',
    );
  });
});
