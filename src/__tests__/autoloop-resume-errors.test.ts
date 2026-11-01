/**
 * Amendment regressions for the native autoloop_resume facade:
 * finite caller-string screening, no blanket catch, genuine manager/resolver paths.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as secrets from '../kernel/secrets.js';
import plugin from '../index.js';
import type {
  ISession,
  SessionConfig,
  SessionStats,
  SessionSendOptions,
  TurnResult,
  CostBreakdown,
  EffortLevel,
} from '../types.js';

interface RegisteredTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (toolCallId: string, params: Record<string, unknown>) => Promise<unknown>;
}

interface RegisteredService {
  stop: () => void;
}

function collectRegistration(): { tools: RegisteredTool[]; services: RegisteredService[] } {
  const tools: RegisteredTool[] = [];
  const services: RegisteredService[] = [];
  const fakeApi = {
    pluginConfig: {},
    logger: { info: () => {}, error: () => {}, warn: () => {} },
    registerTool: (def: RegisteredTool) => {
      tools.push(def);
    },
    on: () => {},
    registerHttpRoute: () => {},
    registerService: (def: RegisteredService) => {
      services.push(def);
    },
  };
  (plugin as unknown as { register: (api: unknown) => void }).register(fakeApi);
  return { tools, services };
}

const CALLER_ID_ERROR = (field: string): string =>
  `${field} must be a valid identifier of 1-128 ASCII letters, digits, underscore, dot, colon or dash`;

const RUN_ID_ERROR = 'run_id must be a valid run identifier';

const CALLER_FIELDS = [
  'pending_dispatch_id',
  'plannerCustomEngineRef',
  'coderCustomEngineRef',
  'reviewerCustomEngineRef',
] as const;

function invalidCatalog(field: 'run_id' | (typeof CALLER_FIELDS)[number]): Array<{ label: string; value: unknown }> {
  const shared: Array<{ label: string; value: unknown }> = [
    { label: 'empty', value: '' },
    { label: 'undefined', value: undefined },
    { label: 'null', value: null },
    { label: 'number', value: 42 },
    { label: 'object', value: { x: 1 } },
    { label: 'LF', value: 'a\nb' },
    { label: 'terminal-LF', value: 'abc\n' },
    { label: 'CR', value: 'a\rb' },
    { label: 'tab', value: 'a\tb' },
    { label: 'NUL', value: 'a\0b' },
    { label: 'DEL', value: `a${String.fromCharCode(0x7f)}b` },
    { label: 'C1', value: `a${String.fromCharCode(0x85)}b` },
    { label: 'unicode', value: 'café' },
    { label: 'bidi', value: `a${String.fromCharCode(0x202e)}b` },
    { label: 'zwsp', value: `a${String.fromCharCode(0x200b)}b` },
    { label: 'space', value: 'a b' },
    { label: 'slash', value: 'a/b' },
    { label: 'quote', value: 'a"b' },
    { label: 'backtick', value: 'a`b' },
    { label: 'angle', value: 'a<b>' },
    { label: 'len129', value: 'a'.repeat(129) },
    { label: 'len5015', value: 'a'.repeat(5015) },
  ];
  if (field === 'run_id') {
    return [
      ...shared,
      { label: 'leading-dot', value: '.abc' },
      { label: 'leading-dash', value: '-abc' },
      { label: 'leading-colon', value: ':abc' },
    ];
  }
  return shared;
}

class MockSession extends EventEmitter implements ISession {
  sessionId?: string;
  private _isReady = true;
  private _isPaused = false;
  private _isBusy = false;
  private _effort: EffortLevel = 'auto';
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
  async start(): Promise<this> {
    this.sessionId = `mock-session-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    return this;
  }
  stop(): void {}
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

const TEST_WF_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'clawo-al-resume-err-wf-'));
process.env.CLAWO_WF_DIR = TEST_WF_DIR;
process.env.CLAWO_SESSIONS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'clawo-al-resume-err-sessions-'));
process.env.CLAWO_NO_EMBEDDED_SERVER = '1';

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

let mockSessions: MockSession[] = [];
let createSessionPatch: ReturnType<typeof vi.spyOn> | undefined;

function installMockSessions(): void {
  // Patch every SessionManager the plugin lazily constructs.
  const proto = SessionManager.prototype as unknown as {
    _createSession: (engine: string, config: SessionConfig) => ISession;
  };
  createSessionPatch = vi.spyOn(proto, '_createSession').mockImplementation((_engine, _config): ISession => {
    const mock = new MockSession();
    mockSessions.push(mock);
    return mock;
  });
}

const fence = (tool: string, args: Record<string, unknown>): string =>
  `\`\`\`autoloop\n${JSON.stringify({ tool, args })}\n\`\`\``;

describe('autoloop_resume amendment errors', () => {
  let registration: { tools: RegisteredTool[]; services: RegisteredService[] };
  let tool: RegisteredTool;
  let startTool: RegisteredTool;
  let chatTool: RegisteredTool;
  let statusTool: RegisteredTool;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    mockSessions = [];
    fs.rmSync(TEST_WF_DIR, { recursive: true, force: true });
    fs.mkdirSync(TEST_WF_DIR, { recursive: true });
    installMockSessions();
    registration = collectRegistration();
    tool = registration.tools.find((t) => t.name === 'autoloop_resume')!;
    startTool = registration.tools.find((t) => t.name === 'autoloop_start')!;
    chatTool = registration.tools.find((t) => t.name === 'autoloop_chat')!;
    statusTool = registration.tools.find((t) => t.name === 'autoloop_status')!;
    expect(tool).toBeDefined();
    expect(startTool).toBeDefined();
    expect(chatTool).toBeDefined();
  });

  const settleServiceStop = async (): Promise<void> => {
    const stop = registration.services[0]?.stop;
    if (!stop) return;
    const done = Promise.resolve(stop());
    let settled = false;
    void done.finally(() => {
      settled = true;
    });
    for (let step = 0; step < 120 && !settled; step += 1) {
      await vi.advanceTimersByTimeAsync(1_000);
    }
    if (!settled) throw new Error('plugin service stop did not settle after advancing fake timers');
    await done;
  };

  afterEach(async () => {
    await settleServiceStop();
    createSessionPatch?.mockRestore();
    createSessionPatch = undefined;
    vi.useRealTimers();
  });

  const workspaceFor = (runId: string): string => {
    const workspace = path.join(TEST_WF_DIR, 'workspaces', runId);
    fs.mkdirSync(workspace, { recursive: true });
    return workspace;
  };

  const assertConstantError = async (
    params: Record<string, unknown>,
    expected: string,
    spies: { resume: ReturnType<typeof vi.spyOn>; resolve: ReturnType<typeof vi.spyOn> },
  ): Promise<void> => {
    spies.resume.mockClear();
    spies.resolve.mockClear();
    let caught: unknown;
    try {
      await tool.execute('al-resume-neg', params);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe(expected);
    expect((caught as Error).cause).toBeUndefined();
    expect((caught as Error & { details?: unknown }).details).toBeUndefined();
    for (const value of Object.values(params)) {
      if (typeof value === 'string' && value.length > 0) {
        expect((caught as Error).message).not.toContain(value);
      }
    }
    expect(spies.resume).not.toHaveBeenCalled();
    expect(spies.resolve).not.toHaveBeenCalled();
  };

  describe('A4 finite invalid catalog and positives', () => {
    it('rejects the finite invalid catalog for run_id and optional caller ids with constant errors and zero effects', async () => {
      const resume = vi.spyOn(SessionManager.prototype, 'autoloopResume');
      const resolve = vi.spyOn(secrets, 'resolveSecretRefs');
      try {
        for (const sample of invalidCatalog('run_id')) {
          const params: Record<string, unknown> = { run_id: sample.value };
          // Own-property undefined/null still present — facade must reject before resolve.
          await assertConstantError(params, RUN_ID_ERROR, { resume, resolve });
        }

        for (const field of CALLER_FIELDS) {
          for (const sample of invalidCatalog(field)) {
            const params: Record<string, unknown> = { run_id: 'resume_ok', [field]: sample.value };
            await assertConstantError(params, CALLER_ID_ERROR(field), { resume, resolve });
          }
        }
      } finally {
        resume.mockRestore();
        resolve.mockRestore();
      }
    });

    it('validates every caller field before resolving an earlier valid ref', async () => {
      const resume = vi.spyOn(SessionManager.prototype, 'autoloopResume');
      const resolve = vi.spyOn(secrets, 'resolveSecretRefs');
      process.env.CLAWO_CUSTOM_ENGINE_PLANNER_OK = JSON.stringify({ name: 'p', bin: '/opt/p' });
      try {
        await expect(
          tool.execute('al-resume-order', {
            run_id: 'resume_ok',
            plannerCustomEngineRef: 'planner_ok',
            coderCustomEngineRef: 'bad ref',
          }),
        ).rejects.toThrow(CALLER_ID_ERROR('coderCustomEngineRef'));
        expect(resolve).not.toHaveBeenCalled();
        expect(resume).not.toHaveBeenCalled();
      } finally {
        delete process.env.CLAWO_CUSTOM_ENGINE_PLANNER_OK;
        resume.mockRestore();
        resolve.mockRestore();
      }
    });

    it('accepts length 1/128, punctuation/case, generated and custom dispatch formats', async () => {
      const sampleState = {
        run_id: 'r',
        status: 'planning',
        iter: 0,
        subagents_spawned: false,
        started_at: '2026-11-01T00:00:00.000Z',
        workspace: '/tmp',
        ledger_dir: '/tmp/tasks/r',
        push_log_count: 0,
        status_reason: null,
        consecutive_phase_errors: 0,
        recent_phase_errors: [],
        metric_history: [],
        last_activity_at: 0,
      };
      const resume = vi.spyOn(SessionManager.prototype, 'autoloopResume').mockResolvedValue(sampleState as never);
      try {
        const positives: Array<Record<string, unknown>> = [
          { run_id: 'a' },
          { run_id: `r${'a'.repeat(127)}` },
          { run_id: 'Run_1.ok-2' },
          {
            run_id: 'resume_ok',
            pending_dispatch_id: `dispatch_${'ab'.repeat(32)}`,
          },
          {
            run_id: 'resume_ok',
            pending_dispatch_id: 'dispatch-live-planner-0',
            send_timeout_ms: 700_000,
          },
          {
            run_id: 'resume_ok',
            pending_dispatch_id: 'dispatch-stale-planner-0',
            send_timeout_ms: 700_000,
          },
          {
            run_id: 'resume_ok',
            pending_dispatch_id: 'dispatch-planner-2',
            send_timeout_ms: 700_000,
          },
          {
            run_id: 'resume_ok',
            plannerCustomEngineRef: 'my-engine',
          },
          {
            run_id: 'resume_ok',
            plannerCustomEngineRef: 'planner.ref:v1',
          },
          {
            run_id: 'resume_ok',
            coderCustomEngineRef: 'A'.repeat(128),
          },
        ];
        process.env.CLAWO_CUSTOM_ENGINE_MY_ENGINE = JSON.stringify({ name: 'e', bin: 'x' });
        process.env.CLAWO_CUSTOM_ENGINE_PLANNER_REF_V1 = JSON.stringify({ name: 'e2', bin: 'y' });
        process.env[`CLAWO_CUSTOM_ENGINE_${'A'.repeat(128)}`] = JSON.stringify({ name: 'e3', bin: 'z' });
        for (const params of positives) {
          resume.mockClear();
          if (params.plannerCustomEngineRef === 'my-engine') {
            // resolve path exercises secretEnvVar normalization; still one manager call.
          }
          const result = await tool.execute('al-resume-pos', params);
          expect(resume).toHaveBeenCalledTimes(1);
          expect((result as { details: { ok: boolean } }).details.ok).toBe(true);
        }
      } finally {
        delete process.env.CLAWO_CUSTOM_ENGINE_MY_ENGINE;
        delete process.env.CLAWO_CUSTOM_ENGINE_PLANNER_REF_V1;
        delete process.env[`CLAWO_CUSTOM_ENGINE_${'A'.repeat(128)}`];
        resume.mockRestore();
      }
    });
  });

  describe('A3/A5 genuine manager and resolver paths', () => {
    it('propagates safe unknown run and unknown/malformed secret refs without retry', async () => {
      const resume = vi.spyOn(SessionManager.prototype, 'autoloopResume');
      const VALUE = 'VALUE_SENTINEL_DO_NOT_ECHO_9f3c';
      try {
        // Unknown run: real manager path (unmocked resume).
        resume.mockRestore();
        await expect(tool.execute('al-unknown-run', { run_id: 'no_such_run_safe' })).rejects.toThrow(
          "Autoloop run 'no_such_run_safe' not found",
        );

        await expect(
          tool.execute('al-missing-ref', { run_id: 'resume_ok', plannerCustomEngineRef: 'missing_ref_x' }),
        ).rejects.toThrow(
          /Unknown secret reference 'missing_ref_x': set CLAWO_CUSTOM_ENGINE_MISSING_REF_X on the orchestrator host/,
        );

        process.env.CLAWO_CUSTOM_ENGINE_BAD_JSON = `{"token":"${VALUE}"`;
        try {
          let caught: unknown;
          try {
            await tool.execute('al-bad-json', { run_id: 'resume_ok', plannerCustomEngineRef: 'bad-json' });
          } catch (err) {
            caught = err;
          }
          expect(caught).toBeInstanceOf(Error);
          const message = (caught as Error).message;
          expect(message).toBe("Secret reference 'bad-json' (CLAWO_CUSTOM_ENGINE_BAD_JSON) is not valid JSON");
          expect(message).not.toContain(VALUE);
          expect(JSON.stringify(caught)).not.toContain(VALUE);
          expect(String((caught as Error & { details?: unknown }).details ?? '')).not.toContain(VALUE);
        } finally {
          delete process.env.CLAWO_CUSTOM_ENGINE_BAD_JSON;
        }
      } finally {
        // resume may already be restored
      }
    });

    it('live send-timeout: pending id required, stale id, strict increase value, pending-without-increase, nonrecoverable', async () => {
      const runId = 'live_timeout_resume';
      await startTool.execute('al-start-timeout', {
        run_id: runId,
        workspace: workspaceFor(runId),
        send_timeout_ms: 600_000,
        activity_lease_ms: 60_000,
        autoloop_hard_timeout_ms: 600_000,
      });
      const planner = mockSessions[0]!;
      planner.sendImplementation = async () => {
        throw new Error('Timeout waiting for response');
      };
      await chatTool.execute('al-chat-timeout', { run_id: runId, text: 'timed-out-turn' });
      const status = (await statusTool.execute('al-status-timeout', { run_id: runId })) as {
        details: { state: { status: string; pending_dispatch: { dispatch_id: string } | null } };
      };
      expect(status.details.state.status).toBe('paused');
      expect(status.details.state.pending_dispatch).toBeTruthy();
      const dispatchId = status.details.state.pending_dispatch!.dispatch_id;

      await expect(tool.execute('al-need-pending', { run_id: runId, send_timeout_ms: 700_000 })).rejects.toThrow(
        `pendingDispatchId is required to resume timed-out dispatch '${dispatchId}'`,
      );

      await expect(
        tool.execute('al-pending-only', {
          run_id: runId,
          pending_dispatch_id: dispatchId,
        }),
      ).rejects.toThrow('pendingDispatchId requires a sendTimeoutMs increase');

      await expect(
        tool.execute('al-stale', {
          run_id: runId,
          send_timeout_ms: 700_000,
          pending_dispatch_id: 'dispatch-stale-planner-0',
        }),
      ).rejects.toThrow(`pending dispatch 'dispatch-stale-planner-0' does not match current dispatch '${dispatchId}'`);

      await expect(
        tool.execute('al-not-strict', {
          run_id: runId,
          send_timeout_ms: 600_000,
          pending_dispatch_id: dispatchId,
        }),
      ).rejects.toThrow('sendTimeoutMs must be strictly greater than the current effective value 600000');

      // Ordinary pause (no pending) is not a recoverable send-timeout target.
      const runId2 = 'live_ordinary_pause';
      await startTool.execute('al-start-ordinary', {
        run_id: runId2,
        workspace: workspaceFor(runId2),
      });
      const planner2 = mockSessions[mockSessions.length - 1]!;
      planner2.sendImplementation = async () => ({
        text: fence('pause_loop', { reason: 'operator-hold' }),
        event: { type: 'result', result: 'ok' },
      });
      await chatTool.execute('al-chat-ordinary', { run_id: runId2, text: 'pause-now' });
      const status2 = (await statusTool.execute('al-status-ordinary', { run_id: runId2 })) as {
        details: { state: { pending_dispatch: unknown } };
      };
      expect(status2.details.state.pending_dispatch).toBeNull();
      await expect(
        tool.execute('al-nonrecoverable', {
          run_id: runId2,
          send_timeout_ms: 700_000,
          pending_dispatch_id: 'dispatch-live-planner-0',
        }),
      ).rejects.toThrow(`Autoloop run '${runId2}' is not awaiting a recoverable send timeout`);
    });

    it('resolves three refs once, omits absent refs, and returns serializable normalized success', async () => {
      const plannerCfg = { name: 'planner-safe', bin: '/opt/planner-safe', args: {} };
      const coderCfg = { name: 'coder-safe', bin: '/opt/coder-safe', args: {} };
      const reviewerCfg = { name: 'reviewer-safe', bin: '/opt/reviewer-safe', args: {} };
      process.env.CLAWO_CUSTOM_ENGINE_PLANNER_SYN = JSON.stringify(plannerCfg);
      process.env.CLAWO_CUSTOM_ENGINE_CODER_SYN = JSON.stringify(coderCfg);
      process.env.CLAWO_CUSTOM_ENGINE_REVIEWER_SYN = JSON.stringify(reviewerCfg);
      const sampleState = {
        run_id: 'resume_refs',
        status: 'planning',
        iter: 0,
        subagents_spawned: false,
        started_at: '2026-11-01T00:00:00.000Z',
        workspace: '/tmp',
        ledger_dir: '/tmp/tasks/resume_refs',
        push_log_count: 0,
        status_reason: null,
        consecutive_phase_errors: 0,
        recent_phase_errors: [],
        metric_history: [],
        last_activity_at: 0,
      };
      const resume = vi.spyOn(SessionManager.prototype, 'autoloopResume').mockResolvedValue(sampleState as never);
      try {
        const result = await tool.execute('al-three-refs', {
          run_id: 'resume_refs',
          plannerCustomEngineRef: 'planner-syn',
          coderCustomEngineRef: 'coder-syn',
          reviewerCustomEngineRef: 'reviewer-syn',
        });
        expect(resume).toHaveBeenCalledTimes(1);
        expect(resume).toHaveBeenLastCalledWith('resume_refs', {
          plannerCustomEngine: plannerCfg,
          coderCustomEngine: coderCfg,
          reviewerCustomEngine: reviewerCfg,
        });
        const details = (result as { details: Record<string, unknown> }).details;
        expect(details.ok).toBe(true);
        expect(details.state).toEqual(sampleState);
        const serialized = JSON.stringify(details);
        expect(serialized).not.toContain('/opt/planner-safe');
        expect(serialized).not.toContain('planner-safe');
        // Round-trip serializable.
        expect(JSON.parse(serialized)).toEqual(details);

        resume.mockClear();
        await tool.execute('al-omit-refs', { run_id: 'resume_refs' });
        expect(resume).toHaveBeenCalledTimes(1);
        expect(resume.mock.calls[0]![1]).toEqual({});
      } finally {
        delete process.env.CLAWO_CUSTOM_ENGINE_PLANNER_SYN;
        delete process.env.CLAWO_CUSTOM_ENGINE_CODER_SYN;
        delete process.env.CLAWO_CUSTOM_ENGINE_REVIEWER_SYN;
        resume.mockRestore();
      }
    });
  });
});
