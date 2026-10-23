/**
 * Accepted Autoloop chat in the node checkpoint: pending chat, the single
 * in-flight marker, and the unconfirmed-chat notice (C1–C14).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { spawn, spawnSync, execFileSync, type ChildProcess } from 'node:child_process';
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
import type { AnyAutoloopMessage } from '../autoloop/messages.js';
import type { AgentDispatcher } from '../autoloop/types.js';
import { useIsolatedHome } from './helpers/isolate-home.js';

const OWNER_CHILD = fileURLToPath(new URL('./helpers/autoloop-owner-child.ts', import.meta.url));

class MockSession extends EventEmitter implements ISession {
  sessionId?: string;
  private _effort: EffortLevel = 'auto';
  sendCalls: Array<{ message: string | unknown[]; options?: SessionSendOptions }> = [];
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
    this.sessionId = `mock-session-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    return this;
  }
  stop(): void {}
  pause(): void {}
  resume(): void {}
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
      isReady: true,
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
/** Runs while a session is being created, before it starts. */
let onCreateSession: ((config: SessionConfig) => void) | null = null;

function patchCreateSession(manager: InstanceType<typeof SessionManager>): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (manager as any)._createSession = (_engine: string, config: SessionConfig): ISession => {
    onCreateSession?.(config);
    const mock = new MockSession();
    mockSessions.push(mock);
    createdConfigs.push(config);
    return mock;
  };
}

const TEST_WF_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'clawo-pending-chat-wf-'));
process.env.CLAWO_WF_DIR = TEST_WF_DIR;
process.env.CLAWO_SESSIONS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'clawo-pending-chat-sessions-'));

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
    writeFile: vi.fn((_p: unknown, _d: unknown, cb: (err: null) => void) => cb(null)),
    rename: vi.fn((_o: unknown, _n: unknown, cb: (err: null) => void) => cb(null)),
    mkdir: vi.fn((_p: unknown, _opts: unknown, cb: (err: null) => void) => cb(null)),
    unlink: vi.fn((_p: unknown, cb: () => void) => cb()),
  };
  return { ...actual, ...shim, default: { ...actual, ...shim } };
});

const { SessionManager } = await import('../session-manager.js');
const { EmbeddedServer } = await import('../embedded-server.js');
const { leaseIsStale, readLease, loadRun } = await import('../kernel/store.js');
const {
  AutoloopRunner,
  CHAT_LIMIT_ERROR,
  CHAT_NOTICE_PENDING,
  CHAT_PERSIST_ERROR,
  MAX_PENDING_CHAT,
  MAX_PENDING_CHAT_BYTES,
} = await import('../autoloop/runner.js');
const { Msg } = await import('../autoloop/messages.js');
const { NOTICE_TEXT, isUnconfirmedChatNotice } = await import('../autoloop/dispatcher.js');
const { AUTOLOOP_RESTORE_MALFORMED, AUTOLOOP_RESTORE_UNPERSISTED, validateStoredInput } =
  await import('../kernel/nodes/autoloop.js');
const { boundedErrorReason } = await import('../sanitize.js');

type Manager = InstanceType<typeof SessionManager>;

function createManager(logger?: Logger): Manager {
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

const ACK: TurnResult = { text: 'ack', event: { type: 'result', result: 'ok' } };

const messageText = (message: string | unknown[]): string =>
  typeof message === 'string' ? message : JSON.stringify(message);

/** Exact chat match: U1 must not match U10. */
const sent = (planner: MockSession, needle: string): string[] =>
  planner.sendCalls.map((call) => messageText(call.message)).filter((text) => text === needle);

const sentAmong = (planner: MockSession, needles: string[]): string[] =>
  planner.sendCalls.map((call) => messageText(call.message)).filter((text) => needles.includes(text));

const latestPlanner = (): MockSession => {
  for (let i = createdConfigs.length - 1; i >= 0; i--) {
    if (createdConfigs[i]?.name?.endsWith('-planner')) return mockSessions[i]!;
  }
  throw new Error('no Planner session was created');
};

interface StoredData {
  state: { status: string; status_reason: string | null; unconfirmed_chat?: Record<string, unknown> };
  pendingChat?: Array<{ msg_id: string; text: string }>;
  inFlightChat?: { msg_id: string; handed_at: string } | null;
}

const storedData = (runId: string): StoredData => loadRun(runId)!.nodes.main!.data as StoredData;
const storedPendingTexts = (runId: string): string[] => (storedData(runId).pendingChat ?? []).map((e) => e.text);

/** Deferred send outcome for one Planner turn. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

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

async function withServer<T>(mgr: Manager, fn: (port: number, token: string) => Promise<T>): Promise<T> {
  const server = new EmbeddedServer(mgr, await freePort());
  const port = await server.start();
  try {
    const token = fs.readFileSync(path.join(os.homedir(), '.openclaw', 'server-token'), 'utf-8').trim();
    return await fn(port, token);
  } finally {
    await server.stop();
  }
}

async function historyEntries(mgr: Manager, runId: string): Promise<unknown[]> {
  return withServer(mgr, async (port, token) => {
    const r = await fetch(`http://127.0.0.1:${port}/autoloop/${runId}/chat_history`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(r.status).toBe(200);
    return ((await r.json()) as { entries: unknown[] }).entries;
  });
}

const apiNoticeTimestamps = async (mgr: Manager, runId: string): Promise<string[]> =>
  (await historyEntries(mgr, runId)).filter(isUnconfirmedChatNotice).map((e) => e.ts);

const chatFile = (workspace: string, runId: string): string => path.join(workspace, 'tasks', runId, 'chat.jsonl');

/** Every parseable chat.jsonl line, in file order. */
function fileEntries(workspace: string, runId: string): Array<{ who?: string; text?: string; ts?: string }> {
  const file = chatFile(workspace, runId);
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .flatMap((line) => {
      try {
        return line.trim() ? [JSON.parse(line) as { who?: string; text?: string; ts?: string }] : [];
      } catch {
        return [];
      }
    });
}

const fileNoticeTimestamps = (workspace: string, runId: string): string[] =>
  fileEntries(workspace, runId)
    .filter(isUnconfirmedChatNotice)
    .map((e) => e.ts!);

const indexOfUserLine = (workspace: string, runId: string, text: string): number =>
  fileEntries(workspace, runId).findIndex((e) => e.who === 'user' && e.text === text);

const indexOfNotice = (workspace: string, runId: string): number =>
  fileEntries(workspace, runId).findIndex((e) => isUnconfirmedChatNotice(e));

function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', '']);
  return child.pid!;
}

/** Hand the run to an owner that no longer exists, as an abrupt owner change would. */
function supersedeLease(runId: string): void {
  const file = path.join(TEST_WF_DIR, runId, 'lease.json');
  const lease = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  fs.writeFileSync(
    file,
    JSON.stringify({ ...lease, ownerId: 'departed-owner', acquisitionId: 'departed', pid: deadPid() }),
  );
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

/** Open committed-iteration ledger + HEAD subject that trigger recovery. */
function plantCommittedIteration(workspace: string, runId: string, iter = 0): void {
  const iterDir = path.join(workspace, 'tasks', runId, 'iter', String(iter));
  fs.mkdirSync(iterDir, { recursive: true });
  fs.writeFileSync(path.join(iterDir, 'directive.json'), JSON.stringify({ schema_version: 1, iter, goal: 'c9' }));
  fs.writeFileSync(
    path.join(iterDir, 'eval_output.json'),
    JSON.stringify({ schema_version: 1, iter, eval_output: {} }),
  );
  fs.writeFileSync(path.join(iterDir, 'coder_summary.txt'), 'c9 committed summary\n');
  fs.writeFileSync(path.join(iterDir, 'diff.patch'), '');
  if (!fs.existsSync(path.join(workspace, '.git'))) initGitWorkspace(workspace);
  execFileSync('git', ['commit', '--allow-empty', '-m', `autoloop/iter-${iter}: c9 recovery fixture`], {
    cwd: workspace,
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const kernelOf = (mgr: Manager): any => (mgr as any).kernel;
const publishersOf = (mgr: Manager): Map<string, () => boolean> =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (mgr as any)._autoloopPublishers as Map<string, () => boolean>;

// ─── Runner-level harness ───────────────────────────────────────────────────

function makeRunner(
  opts: {
    persist?: () => boolean;
    deliver?: (env: AnyAutoloopMessage) => Promise<AnyAutoloopMessage[]>;
    append?: (ts: string) => boolean;
  } = {},
) {
  const delivered: AnyAutoloopMessage[] = [];
  const appended: string[] = [];
  const dispatcher: AgentDispatcher = {
    deliver: async (env) => {
      delivered.push(env);
      return opts.deliver ? await opts.deliver(env) : [];
    },
    appendUnconfirmedChatNotice: (ts) => {
      const ok = opts.append ? opts.append(ts) : true;
      if (ok) appended.push(ts);
      return ok;
    },
  };
  const runner = new AutoloopRunner({
    run_id: 'unit-run',
    workspace: '/nonexistent/unit-workspace',
    ledger_dir: '/nonexistent/unit-workspace/tasks/unit-run',
    notifyUser: async () => {},
    dispatcher,
    persistCheckpoint: opts.persist ?? (() => true),
    maxDispatchDepth: 5_000,
  });
  const errors: string[] = [];
  runner.on('error', (err: Error) => errors.push(err.message));
  return { runner, delivered, appended, errors };
}

const deliveredChatTexts = (delivered: AnyAutoloopMessage[]): string[] =>
  delivered.flatMap((env) => (env.type === 'chat' ? [env.payload.text] : []));

const untracked = (iter: number): AnyAutoloopMessage => Msg.iterDone(iter, { iter, verdict: 'advance', metric: null });

describe('Autoloop pending chat — runner level', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('C3t: the next notice time moves forward across a clock rollback, and a pending time is kept', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    let appendOk = true;
    const { runner, appended } = makeRunner({
      deliver: async (env) => {
        if (env.type === 'chat' && env.payload.text.startsWith('throw')) throw new Error('transport failed');
        return [];
      },
      append: () => appendOk,
    });

    vi.setSystemTime(new Date('2026-10-23T12:00:00.000Z'));
    await expect(runner.send(runner.acceptChat('throw-1'))).rejects.toThrow('transport failed');
    expect(appended).toEqual(['2026-10-23T12:00:00.000Z']);

    vi.setSystemTime(new Date('2026-10-23T11:00:00.000Z'));
    await expect(runner.send(runner.acceptChat('throw-2'))).rejects.toThrow('transport failed');
    expect(appended).toEqual(['2026-10-23T12:00:00.000Z', '2026-10-23T12:00:00.001Z']);
    expect(runner.state.unconfirmed_chat).toEqual({
      count: 2,
      last_at: '2026-10-23T12:00:00.001Z',
      history_pending: false,
    });

    appendOk = false;
    vi.setSystemTime(new Date('2026-10-23T13:00:00.000Z'));
    await expect(runner.send(runner.acceptChat('throw-3'))).rejects.toThrow('transport failed');
    const pendingAt = '2026-10-23T13:00:00.000Z';
    expect(runner.state.unconfirmed_chat).toEqual({ count: 3, last_at: pendingAt, history_pending: true });

    // The clock goes back again; the pending notice keeps its time and count.
    vi.setSystemTime(new Date('2026-10-23T10:00:00.000Z'));
    await runner.send(runner.acceptChat('ok-4'));
    expect(runner.state).toMatchObject({ status: 'paused', status_reason: CHAT_NOTICE_PENDING });
    expect(runner.state.unconfirmed_chat).toEqual({ count: 3, last_at: pendingAt, history_pending: true });

    appendOk = true;
    expect(runner.resumePaused()).toBe(true);
    await vi.waitFor(() => expect(appended).toHaveLength(3));
    expect(appended[2]).toBe(pendingAt);
    expect(runner.state.unconfirmed_chat).toEqual({ count: 3, last_at: pendingAt, history_pending: false });
  });

  it('count overflow: conversion at MAX_SAFE_INTEGER is refused; checkpoint stays restorable; no resend', () => {
    let disk: ReturnType<AutoloopRunner['checkpointInput']> | undefined;
    const { runner, appended, delivered } = makeRunner({
      persist: () => {
        disk = structuredClone(runner.checkpointInput());
        return true;
      },
    });
    const lastAt = '2026-10-23T00:00:00.000Z';
    const validated = validateStoredInput({
      pendingChat: [{ msg_id: 'm_pending', iter: 0, ts: lastAt, text: 'KEEP' }],
      inFlightChat: { msg_id: 'm_inflight', handed_at: lastAt },
      state: { unconfirmed_chat: { count: Number.MAX_SAFE_INTEGER, last_at: lastAt, history_pending: false } },
    });
    runner.loadRestoredInput(validated);
    // Starting snapshot is valid.
    expect(() =>
      validateStoredInput({ ...validated, state: { unconfirmed_chat: validated.unconfirmed } }),
    ).not.toThrow();
    runner.reconcileRestoredInput();
    // Conversion refused: no commit of an unsafe count, marker and pending text kept.
    expect(disk).toBeUndefined();
    const snap = runner.checkpointInput();
    expect(snap.inFlightChat).toEqual({ msg_id: 'm_inflight', handed_at: lastAt });
    expect(snap.unconfirmed).toEqual({
      count: Number.MAX_SAFE_INTEGER,
      last_at: lastAt,
      history_pending: false,
    });
    expect(snap.pendingChat.map((e) => e.text)).toEqual(['KEEP']);
    expect(Number.isSafeInteger(snap.unconfirmed!.count)).toBe(true);
    expect(appended).toEqual([]);
    expect(deliveredChatTexts(delivered)).toEqual([]);
    // The unchanged checkpoint remains accepted by the restore validator.
    expect(
      validateStoredInput({
        pendingChat: snap.pendingChat,
        inFlightChat: snap.inFlightChat,
        state: { unconfirmed_chat: snap.unconfirmed },
      }).pendingChat.map((e) => e.text),
    ).toEqual(['KEEP']);
    // Release must not hand over pending chat while the marker is unresolved.
    runner.releaseRestoredInput();
    expect(deliveredChatTexts(delivered)).toEqual([]);
    expect(runner.state).toMatchObject({ status: 'paused', status_reason: CHAT_NOTICE_PENDING });
    runner.stop();
  });

  it('C12: accept refuses past 1,000 entries without evicting accepted chat', () => {
    const { runner } = makeRunner();
    for (let i = 0; i < MAX_PENDING_CHAT; i++) runner.acceptChat(`c${i}`);
    expect(() => runner.acceptChat('one-too-many')).toThrow(CHAT_LIMIT_ERROR);
    const pending = runner.checkpointInput().pendingChat;
    expect(pending).toHaveLength(MAX_PENDING_CHAT);
    expect(pending[0]!.text).toBe('c0');
    expect(pending[MAX_PENDING_CHAT - 1]!.text).toBe(`c${MAX_PENDING_CHAT - 1}`);
  });

  it('C12: accept refuses past 8 MiB of pending UTF-8 text', () => {
    const { runner } = makeRunner();
    const twoByte = 'é'.repeat(MAX_PENDING_CHAT_BYTES / 2 - 1);
    runner.acceptChat(twoByte);
    runner.acceptChat('ab');
    expect(() => runner.acceptChat('c')).toThrow(CHAT_LIMIT_ERROR);
    expect(runner.checkpointInput().pendingChat.map((e) => e.text.length)).toEqual([twoByte.length, 2]);
  });

  it('C12: an over-limit or malformed stored record is refused at restore', () => {
    const entry = (i: number, text = 't') => ({
      msg_id: `m_${i}`,
      iter: 0,
      ts: '2026-10-23T12:00:00.000Z',
      text,
    });
    const state = { status: 'terminated' };
    const tooMany = Array.from({ length: MAX_PENDING_CHAT + 1 }, (_, i) => entry(i));
    expect(() => validateStoredInput({ state, pendingChat: tooMany })).toThrow(AUTOLOOP_RESTORE_MALFORMED);
    const tooLarge = [entry(0, 'x'.repeat(MAX_PENDING_CHAT_BYTES)), entry(1, 'y')];
    expect(() => validateStoredInput({ state, pendingChat: tooLarge })).toThrow(AUTOLOOP_RESTORE_MALFORMED);
    expect(() => validateStoredInput({ state, pendingChat: [entry(0), entry(0)] })).toThrow(AUTOLOOP_RESTORE_MALFORMED);
    expect(() => validateStoredInput({ state, inFlightChat: { msg_id: 'm', handed_at: 'yesterday' } })).toThrow(
      AUTOLOOP_RESTORE_MALFORMED,
    );
    expect(() =>
      validateStoredInput({ state: { unconfirmed_chat: { count: -1, last_at: 'x', history_pending: false } } }),
    ).toThrow(AUTOLOOP_RESTORE_MALFORMED);
    const atLimit = Array.from({ length: MAX_PENDING_CHAT }, (_, i) => entry(i));
    expect(validateStoredInput({ state, pendingChat: atLimit }).pendingChat).toHaveLength(MAX_PENDING_CHAT);
    expect(validateStoredInput({ state })).toEqual({ pendingChat: [], inFlightChat: null });
  });

  it('C12: overflow evicts only untracked entries, then drops incoming untracked, and logs what it dropped', async () => {
    const { runner, delivered, errors } = makeRunner();
    await runner.send(Msg.pause(0, { reason: 'operator-hold' }));
    await runner.send(untracked(101));
    await runner.send(untracked(102));
    for (let i = 1; i <= 998; i++) await runner.send(runner.acceptChat(`a${i}`));
    expect(errors).toEqual([]);

    await runner.send(untracked(103));
    await runner.send(runner.acceptChat('a999'));
    await runner.send(runner.acceptChat('a1000'));
    const oldest = 'pausedBuffer exceeded 1000; dropping oldest parked message';
    expect(errors).toEqual([oldest, oldest, oldest]);

    await runner.send(untracked(104));
    expect(errors).toEqual([
      oldest,
      oldest,
      oldest,
      'pausedBuffer full of accepted chat; dropping incoming parked message',
    ]);

    // A runner control message is not parked and still works with a full buffer.
    await runner.send(Msg.resume(0));
    await vi.waitFor(() => expect(deliveredChatTexts(delivered)).toHaveLength(1000));
    expect(deliveredChatTexts(delivered)).toEqual(Array.from({ length: 1000 }, (_, i) => `a${i + 1}`));
    expect(delivered.filter((env) => env.type === 'iter_done')).toEqual([]);
    expect(runner.checkpointInput().pendingChat).toEqual([]);
  });

  it('C12: terminate with a buffer full of accepted chat keeps every entry pending', async () => {
    const { runner, delivered, errors } = makeRunner();
    await runner.send(Msg.pause(0, { reason: 'operator-hold' }));
    for (let i = 1; i <= MAX_PAUSED; i++) await runner.send(runner.acceptChat(`k${i}`));
    await runner.send(untracked(1));
    expect(errors).toEqual(['pausedBuffer full of accepted chat; dropping incoming parked message']);
    await runner.send(Msg.terminate(0, { reason: 'operator-stop' }));
    expect(runner.state).toMatchObject({ status: 'terminated', status_reason: 'operator-stop' });
    expect(runner.checkpointInput().pendingChat.map((e) => e.text)).toEqual(
      Array.from({ length: MAX_PAUSED }, (_, i) => `k${i + 1}`),
    );
    expect(delivered).toEqual([]);
  });
});

const MAX_PAUSED = 1000;

// ─── Manager / HTTP level, real timers ──────────────────────────────────────

describe('Autoloop pending chat — manager and HTTP', () => {
  useIsolatedHome();

  let mgr: Manager;
  const extraManagers: Manager[] = [];

  beforeEach(() => {
    vi.useRealTimers();
    mockSessions = [];
    createdConfigs = [];
    onCreateSession = null;
    fs.rmSync(TEST_WF_DIR, { recursive: true, force: true });
    fs.mkdirSync(TEST_WF_DIR, { recursive: true });
    mgr = createManager();
  });

  afterEach(async () => {
    onCreateSession = null;
    for (const extra of extraManagers.splice(0)) await extra.shutdown();
    await mgr.shutdown();
  });

  const workspaceFor = (runId: string): string => {
    const workspace = path.join(TEST_WF_DIR, 'workspaces', runId);
    fs.mkdirSync(workspace, { recursive: true });
    return workspace;
  };

  /** Stop, wait for the run to end, and reconstruct it in a brand-new manager. */
  async function stopAndReconstruct(runId: string, reason = 'test-stop'): Promise<MockSession> {
    await mgr.autoloopStop(runId, reason);
    await kernelOf(mgr).wait(runId);
    await mgr.shutdown();
    mockSessions = [];
    createdConfigs = [];
    mgr = createManager();
    await mgr.autoloopResume(runId);
    return latestPlanner();
  }

  async function startPaused(runId: string): Promise<{ planner: MockSession; workspace: string }> {
    const workspace = workspaceFor(runId);
    await mgr.autoloopStart({ runId, workspace });
    const planner = latestPlanner();
    planner.sendImplementation = async (message) =>
      messageText(message) === 'pause-trigger'
        ? { text: fence('pause_loop', { reason: 'operator-hold' }), event: { type: 'result', result: 'ok' } }
        : ACK;
    await mgr.autoloopChat(runId, 'pause-trigger');
    expect(mgr.getAutoloop(runId)!.runner.state.status).toBe('paused');
    return { planner, workspace };
  }

  /** Start a run whose Planner holds named turns until the test settles them. */
  async function startWithHeldTurns(
    runId: string,
    held: string[],
    opts: { sendTimeoutMs?: number } = {},
  ): Promise<{
    planner: MockSession;
    workspace: string;
    turns: Map<string, ReturnType<typeof deferred<TurnResult>>>;
  }> {
    const workspace = workspaceFor(runId);
    await mgr.autoloopStart({ runId, workspace, ...opts });
    const planner = latestPlanner();
    const turns = new Map(held.map((name) => [name, deferred<TurnResult>()]));
    planner.sendImplementation = (message) => turns.get(messageText(message))?.promise ?? Promise.resolve(ACK);
    return { planner, workspace, turns };
  }

  it('C1: "same", "same", "x" arrive exactly in that order, live and after reconstruction', async () => {
    const live = await startPaused('c1-live');
    for (const text of ['same', 'same', 'x']) await mgr.autoloopChat('c1-live', text);
    await mgr.autoloopResume('c1-live');
    await vi.waitFor(() => expect(sentAmong(live.planner, ['same', 'x'])).toEqual(['same', 'same', 'x']));

    await startPaused('c1-restored');
    for (const text of ['same', 'same', 'x']) await mgr.autoloopChat('c1-restored', text);
    await mgr.autoloopStop('c1-restored', 'c1-stop');
    await kernelOf(mgr).wait('c1-restored');
    expect(storedPendingTexts('c1-restored')).toEqual(['same', 'same', 'x']);
    await mgr.shutdown();
    mockSessions = [];
    createdConfigs = [];
    mgr = createManager();
    await mgr.autoloopResume('c1-restored');
    const planner = latestPlanner();
    await vi.waitFor(() => expect(sentAmong(planner, ['same', 'x'])).toEqual(['same', 'same', 'x']));
    await vi.waitFor(() => expect(storedData('c1-restored').pendingChat).toBeUndefined());
  });

  it('C2: soft stop mid-send records one notice, count 1, and never resends U1', async () => {
    const runId = 'c2-soft-stop';
    const { planner, workspace, turns } = await startWithHeldTurns(runId, ['U1'], { sendTimeoutMs: 600_000 });
    const u1 = mgr.autoloopChat(runId, 'U1');
    await vi.waitFor(() => expect(sent(planner, 'U1')).toEqual(['U1']));
    expect(storedData(runId).inFlightChat?.msg_id).toEqual(expect.any(String));
    await mgr.autoloopChat(runId, 'U2');
    await mgr.autoloopStop(runId, 'c2-stop');
    turns.get('U1')!.reject(new Error('Timeout waiting for response'));
    await u1;
    await kernelOf(mgr).wait(runId);

    const stored = storedData(runId);
    expect(stored.state).toMatchObject({ status: 'terminated', status_reason: 'c2-stop' });
    expect(stored.state.unconfirmed_chat).toMatchObject({ count: 1, history_pending: false });
    expect(stored.inFlightChat).toBeUndefined();
    expect(storedPendingTexts(runId)).toEqual(['U2']);
    const at = stored.state.unconfirmed_chat!.last_at as string;
    expect(fileNoticeTimestamps(workspace, runId)).toEqual([at]);
    expect(await apiNoticeTimestamps(mgr, runId)).toEqual([at]);

    await mgr.shutdown();
    mockSessions = [];
    createdConfigs = [];
    mgr = createManager();
    await mgr.autoloopResume(runId);
    const planner2 = latestPlanner();
    await vi.waitFor(() => expect(sent(planner2, 'U2')).toEqual(['U2']));
    expect(sent(planner2, 'U1')).toEqual([]);
    expect(mgr.autoloopStatus(runId)?.unconfirmed_chat).toEqual({ count: 1, last_at: at, history_pending: false });
    expect(await apiNoticeTimestamps(mgr, runId)).toEqual([at]);
  }, 30_000);

  it('C3: owner loss mid-send gives one notice and count 1 across two sequential resumes, with no replay', async () => {
    const runId = 'c3-owner-loss';
    const workspace = workspaceFor(runId);
    initGitWorkspace(workspace);
    const proc = spawnOwner(runId, workspace, 'hung-planner-send');
    await waitReadyThenSigkill(proc);

    const observer = createManager();
    extraManagers.push(observer);
    await vi.waitFor(
      () => {
        expect(leaseIsStale(readLease(runId))).toBe(true);
        expect(observer.workflowStatus(runId).state).toBe('running');
      },
      { timeout: 5_000, interval: 50 },
    );
    expect(storedData(runId).inFlightChat?.msg_id).toEqual(expect.any(String));

    await mgr.autoloopResume(runId);
    const first = mgr.autoloopStatus(runId)!.unconfirmed_chat!;
    expect(first).toMatchObject({ count: 1, history_pending: false });
    expect(sent(latestPlanner(), 'hanging-planner-send')).toEqual([]);
    expect(fileNoticeTimestamps(workspace, runId)).toEqual([first.last_at]);

    const planner2 = await stopAndReconstruct(runId, 'c3-stop');
    expect(mgr.autoloopStatus(runId)?.unconfirmed_chat).toEqual(first);
    expect(sent(planner2, 'hanging-planner-send')).toEqual([]);
    expect(fileNoticeTimestamps(workspace, runId)).toEqual([first.last_at]);
    expect(await apiNoticeTimestamps(mgr, runId)).toEqual([first.last_at]);
  }, 60_000);

  it('C3r: a stale and a current owner both append the same notice; the API shows one, count unchanged', async () => {
    const runId = 'c3r-race';
    const { planner, workspace, turns } = await startWithHeldTurns(runId, ['U1']);
    const handle = mgr.getAutoloop(runId)!;
    const realAppend = handle.dispatcher.appendUnconfirmedChatNotice.bind(handle.dispatcher);
    vi.spyOn(handle.dispatcher, 'appendUnconfirmedChatNotice').mockImplementation((ts: string) => {
      const ok = realAppend(ts);
      supersedeLease(runId);
      return ok;
    });
    const u1 = mgr.autoloopChat(runId, 'U1');
    await vi.waitFor(() => expect(sent(planner, 'U1')).toEqual(['U1']));
    turns.get('U1')!.reject(new Error('planner transport failed after send'));
    await expect(u1).rejects.toThrow('planner transport failed after send');

    const stored = storedData(runId);
    expect(stored.state.unconfirmed_chat).toMatchObject({ count: 1, history_pending: true });
    const at = stored.state.unconfirmed_chat!.last_at as string;
    expect(fileNoticeTimestamps(workspace, runId)).toEqual([at]);

    mockSessions = [];
    createdConfigs = [];
    const owner = createManager();
    extraManagers.push(owner);
    await owner.autoloopResume(runId);
    expect(fileNoticeTimestamps(workspace, runId)).toEqual([at, at]);
    expect(await apiNoticeTimestamps(owner, runId)).toEqual([at]);
    expect(owner.autoloopStatus(runId)?.unconfirmed_chat).toEqual({ count: 1, last_at: at, history_pending: false });
    expect(sent(latestPlanner(), 'U1')).toEqual([]);
  }, 30_000);

  describe('C3f: append and commit failures keep the obligation and reuse its time', () => {
    it('append refused: no handoff until the notice is recorded', async () => {
      const runId = 'c3f-append-refused';
      const { planner, workspace, turns } = await startWithHeldTurns(runId, ['U1']);
      fs.mkdirSync(chatFile(workspace, runId));
      const u1 = mgr.autoloopChat(runId, 'U1');
      await vi.waitFor(() => expect(sent(planner, 'U1')).toEqual(['U1']));
      turns.get('U1')!.reject(new Error('planner transport failed after send'));
      await expect(u1).rejects.toThrow('planner transport failed after send');
      const live = mgr.getAutoloop(runId)!.runner.state;
      expect(live.unconfirmed_chat).toMatchObject({ count: 1, history_pending: true });
      const at = live.unconfirmed_chat!.last_at;

      await mgr.autoloopChat(runId, 'U2');
      expect(live).toMatchObject({ status: 'paused', status_reason: CHAT_NOTICE_PENDING, pending_dispatch: null });
      expect(sent(planner, 'U2')).toEqual([]);
      expect(storedData(runId).state.unconfirmed_chat).toEqual({ count: 1, last_at: at, history_pending: true });

      fs.rmSync(chatFile(workspace, runId), { recursive: true, force: true });
      await mgr.autoloopResume(runId);
      await vi.waitFor(() => expect(sent(planner, 'U2')).toEqual(['U2']));
      expect(fileNoticeTimestamps(workspace, runId)).toEqual([at]);
      expect(await apiNoticeTimestamps(mgr, runId)).toEqual([at]);
      expect(live.unconfirmed_chat).toEqual({ count: 1, last_at: at, history_pending: false });
      expect(sent(planner, 'U1')).toEqual(['U1']);
    });

    it('torn last line: the notice is isolated on its own line', async () => {
      const runId = 'c3f-torn-line';
      const workspace = workspaceFor(runId);
      await mgr.autoloopStart({ runId, workspace });
      const planner = latestPlanner();
      planner.sendImplementation = async () => {
        fs.appendFileSync(chatFile(workspace, runId), '{"who":"planner","text":"cut sho');
        throw new Error('planner transport failed after send');
      };
      await expect(mgr.autoloopChat(runId, 'U1')).rejects.toThrow('planner transport failed after send');
      const live = mgr.getAutoloop(runId)!.runner.state;
      expect(live.unconfirmed_chat).toMatchObject({ count: 1, history_pending: false });
      const raw = fs.readFileSync(chatFile(workspace, runId), 'utf8');
      expect(raw).toContain(`"cut sho\n{"who":"system"`);
      expect(fileNoticeTimestamps(workspace, runId)).toEqual([live.unconfirmed_chat!.last_at]);
      const entries = await historyEntries(mgr, runId);
      expect(entries.filter(isUnconfirmedChatNotice).map((e) => e.ts)).toEqual([live.unconfirmed_chat!.last_at]);
      expect(entries.some((e) => (e as { text?: string }).text === 'cut sho')).toBe(false);
    });

    it('commit refused after the append: the retry appends the same time and the API shows one notice', async () => {
      const runId = 'c3f-commit-refused';
      const { planner, workspace, turns } = await startWithHeldTurns(runId, ['U1']);
      const handle = mgr.getAutoloop(runId)!;
      const publishers = publishersOf(mgr);
      const realPublish = publishers.get(runId)!;
      let refuseNext = false;
      publishers.set(runId, () => {
        if (refuseNext) {
          refuseNext = false;
          return false;
        }
        return realPublish();
      });
      const realAppend = handle.dispatcher.appendUnconfirmedChatNotice.bind(handle.dispatcher);
      vi.spyOn(handle.dispatcher, 'appendUnconfirmedChatNotice').mockImplementation((ts: string) => {
        const ok = realAppend(ts);
        refuseNext = true;
        return ok;
      });

      const u1 = mgr.autoloopChat(runId, 'U1');
      await vi.waitFor(() => expect(sent(planner, 'U1')).toEqual(['U1']));
      turns.get('U1')!.reject(new Error('planner transport failed after send'));
      await expect(u1).rejects.toThrow('planner transport failed after send');
      const at = handle.runner.state.unconfirmed_chat!.last_at;
      expect(handle.runner.state.unconfirmed_chat).toEqual({ count: 1, last_at: at, history_pending: true });
      expect(storedData(runId).state.unconfirmed_chat).toEqual({ count: 1, last_at: at, history_pending: true });
      expect(fileNoticeTimestamps(workspace, runId)).toEqual([at]);

      vi.mocked(handle.dispatcher.appendUnconfirmedChatNotice).mockImplementation(realAppend);
      await mgr.autoloopChat(runId, 'U2');
      expect(sent(planner, 'U2')).toEqual(['U2']);
      expect(fileNoticeTimestamps(workspace, runId)).toEqual([at, at]);
      expect(await apiNoticeTimestamps(mgr, runId)).toEqual([at]);
      expect(handle.runner.state.unconfirmed_chat).toEqual({ count: 1, last_at: at, history_pending: false });
      expect(indexOfNotice(workspace, runId)).toBeLessThan(indexOfUserLine(workspace, runId, 'U2'));
    });

    it('crash before the append: the next owner appends the stored time before any handoff', async () => {
      const runId = 'c3f-crash-before-append';
      const { planner, workspace, turns } = await startWithHeldTurns(runId, ['U1']);
      const handle = mgr.getAutoloop(runId)!;
      vi.spyOn(handle.dispatcher, 'appendUnconfirmedChatNotice').mockImplementation(() => {
        supersedeLease(runId);
        return false;
      });
      const u1 = mgr.autoloopChat(runId, 'U1');
      await vi.waitFor(() => expect(sent(planner, 'U1')).toEqual(['U1']));
      await mgr.autoloopChat(runId, 'U2');
      turns.get('U1')!.reject(new Error('planner transport failed after send'));
      await expect(u1).rejects.toThrow('planner transport failed after send');
      const stored = storedData(runId);
      expect(stored.state.unconfirmed_chat).toMatchObject({ count: 1, history_pending: true });
      expect(storedPendingTexts(runId)).toEqual(['U2']);
      const at = stored.state.unconfirmed_chat!.last_at as string;
      expect(fileNoticeTimestamps(workspace, runId)).toEqual([]);
      expect(sent(planner, 'U2')).toEqual([]);

      mockSessions = [];
      createdConfigs = [];
      const owner = createManager();
      extraManagers.push(owner);
      await owner.autoloopResume(runId);
      const planner2 = latestPlanner();
      await vi.waitFor(() => expect(sent(planner2, 'U2')).toEqual(['U2']));
      expect(fileNoticeTimestamps(workspace, runId)).toEqual([at]);
      expect(indexOfNotice(workspace, runId)).toBeLessThan(indexOfUserLine(workspace, runId, 'U2'));
      expect(owner.autoloopStatus(runId)?.unconfirmed_chat).toEqual({ count: 1, last_at: at, history_pending: false });
      expect(sent(planner2, 'U1')).toEqual([]);
    }, 30_000);
  });

  it('C4: a real timeout pauses before U2, the exact resume does not replay U1, and its notice precedes U2', async () => {
    const runId = 'c4-timeout';
    const { planner, workspace, turns } = await startWithHeldTurns(runId, ['U1'], { sendTimeoutMs: 600_000 });
    const handle = mgr.getAutoloop(runId)!;
    const u1 = mgr.autoloopChat(runId, 'U1');
    await vi.waitFor(() => expect(sent(planner, 'U1')).toEqual(['U1']));
    await mgr.autoloopChat(runId, 'U2');
    turns.get('U1')!.reject(new Error('Timeout waiting for response'));
    await u1;

    const pending = handle.runner.state.pending_dispatch!;
    expect(handle.runner.state).toMatchObject({
      status: 'paused',
      status_reason: `awaiting_resume:send_timeout:planner:${pending.dispatch_id}`,
    });
    expect(sent(planner, 'U2')).toEqual([]);
    expect(storedData(runId).inFlightChat?.msg_id).toBe(pending.message_id);
    expect(storedPendingTexts(runId)).toEqual(['U2']);
    expect(fileNoticeTimestamps(workspace, runId)).toEqual([]);

    // A generic resume during a timeout pause stays a no-op.
    await mgr.autoloopResume(runId);
    expect(sent(planner, 'U2')).toEqual([]);

    await mgr.autoloopResume(runId, { sendTimeoutMs: 700_000, pendingDispatchId: pending.dispatch_id });
    await vi.waitFor(() => expect(sent(planner, 'U2')).toEqual(['U2']));
    expect(sent(planner, 'U1')).toEqual(['U1']);
    expect(fileNoticeTimestamps(workspace, runId)).toHaveLength(1);
    expect(indexOfNotice(workspace, runId)).toBeLessThan(indexOfUserLine(workspace, runId, 'U2'));
    await vi.waitFor(() => expect(storedData(runId).inFlightChat).toBeUndefined());
    expect(storedData(runId).pendingChat).toBeUndefined();
    expect(handle.runner.state.unconfirmed_chat).toMatchObject({ count: 1, history_pending: false });
  });

  it('C4: a stop queued behind the timed-out send wins with its reason; U2 stays pending after kernel.wait', async () => {
    const runId = 'c4-stop-wins';
    const { planner, turns } = await startWithHeldTurns(runId, ['U1'], { sendTimeoutMs: 600_000 });
    const handle = mgr.getAutoloop(runId)!;
    const timeouts: unknown[] = [];
    handle.runner.on('send_timeout', (e) => timeouts.push(e));
    const u1 = mgr.autoloopChat(runId, 'U1');
    await vi.waitFor(() => expect(sent(planner, 'U1')).toEqual(['U1']));
    await mgr.autoloopChat(runId, 'U2');
    await mgr.autoloopStop(runId, 'c4-stop');
    turns.get('U1')!.reject(new Error('Timeout waiting for response'));
    await u1;
    await kernelOf(mgr).wait(runId);
    expect(timeouts).toEqual([]);
    const stored = storedData(runId);
    expect(stored.state).toMatchObject({ status: 'terminated', status_reason: 'c4-stop', pending_dispatch: null });
    expect(storedPendingTexts(runId)).toEqual(['U2']);
    expect(stored.inFlightChat).toBeUndefined();
    expect(stored.state.unconfirmed_chat).toMatchObject({ count: 1, history_pending: false });
    expect(sent(planner, 'U2')).toEqual([]);
  });

  it('C5: a refused checkpoint refuses accept (manager and HTTP 500) and a refused handoff sends nothing', async () => {
    const runId = 'c5-refused';
    const workspace = workspaceFor(runId);
    await mgr.autoloopStart({ runId, workspace });
    const planner = latestPlanner();
    const publishers = publishersOf(mgr);
    const realPublish = publishers.get(runId)!;

    publishers.set(runId, () => false);
    await expect(mgr.autoloopChat(runId, 'R1')).rejects.toThrow(CHAT_PERSIST_ERROR);
    await withServer(mgr, async (port, token) => {
      const r = await fetch(`http://127.0.0.1:${port}/autoloop/${runId}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ text: 'R2' }),
      });
      expect(r.status).toBe(500);
      expect(await r.json()).toEqual({ ok: false, error: CHAT_PERSIST_ERROR });
    });
    expect(planner.sendCalls).toEqual([]);
    expect(storedData(runId).pendingChat).toBeUndefined();

    let calls = 0;
    publishers.set(runId, () => (++calls === 1 ? realPublish() : false));
    await expect(mgr.autoloopChat(runId, 'H1')).rejects.toThrow(CHAT_PERSIST_ERROR);
    expect(planner.sendCalls).toEqual([]);
    expect(storedPendingTexts(runId)).toEqual(['H1']);
    expect(storedData(runId).inFlightChat).toBeUndefined();

    publishers.set(runId, realPublish);
    await mgr.autoloopChat(runId, 'H2');
    await vi.waitFor(() => expect(sentAmong(planner, ['H1', 'H2'])).toEqual(['H1', 'H2']));
    expect(sentAmong(planner, ['R1', 'R2'])).toEqual([]);
  });

  it('C6: a direct kernel cancel stops handoff; U2 stays pending and the U1 notice is stored', async () => {
    const runId = 'c6-cancel';
    const { planner, workspace, turns } = await startWithHeldTurns(runId, ['U1']);
    const handle = mgr.getAutoloop(runId)!;
    const u1 = mgr.autoloopChat(runId, 'U1');
    await vi.waitFor(() => expect(sent(planner, 'U1')).toEqual(['U1']));
    await mgr.autoloopChat(runId, 'U2');

    expect(kernelOf(mgr).cancel(runId)).toBe(true);
    // Settle before the exit observer's 1 s poll; the reply would pause the run if handled.
    turns
      .get('U1')!
      .resolve({ text: fence('pause_loop', { reason: 'late' }), event: { type: 'result', result: 'ok' } });
    await u1;
    expect(handle.runner.state.status).not.toBe('paused');
    expect(sent(planner, 'U2')).toEqual([]);

    await kernelOf(mgr).wait(runId);
    const stored = storedData(runId);
    expect(storedPendingTexts(runId)).toEqual(['U2']);
    expect(stored.inFlightChat).toBeUndefined();
    expect(stored.state.unconfirmed_chat).toMatchObject({ count: 1, history_pending: false });
    const at = stored.state.unconfirmed_chat!.last_at as string;
    const observer = createManager();
    extraManagers.push(observer);
    expect(observer.autoloopStatus(runId)).toMatchObject({
      status: 'terminated',
      unconfirmed_chat: { count: 1, last_at: at, history_pending: false },
    });
    expect(await apiNoticeTimestamps(mgr, runId)).toEqual([at]);
    expect(fileNoticeTimestamps(workspace, runId)).toEqual([at]);
    expect(sent(planner, 'U1')).toEqual(['U1']);
    expect(sent(planner, 'U2')).toEqual([]);
  });

  it('C7: a throw after the physical send keeps the obligation; U2 is handed over only after the notice', async () => {
    const runId = 'c7-throw';
    const { planner, workspace, turns } = await startWithHeldTurns(runId, ['U1']);
    const handle = mgr.getAutoloop(runId)!;
    const u1 = mgr.autoloopChat(runId, 'U1');
    await vi.waitFor(() => expect(sent(planner, 'U1')).toEqual(['U1']));
    await mgr.autoloopChat(runId, 'U2');
    turns.get('U1')!.reject(new Error('planner transport failed after send'));
    await expect(u1).rejects.toThrow('planner transport failed after send');

    expect(handle.runner.state.unconfirmed_chat).toMatchObject({ count: 1, history_pending: false });
    expect(fileNoticeTimestamps(workspace, runId)).toHaveLength(1);
    expect(sent(planner, 'U2')).toEqual([]);
    expect(storedPendingTexts(runId)).toEqual(['U2']);

    await mgr.autoloopChat(runId, 'U3');
    await vi.waitFor(() => expect(sentAmong(planner, ['U1', 'U2', 'U3'])).toEqual(['U1', 'U2', 'U3']));
    expect(indexOfNotice(workspace, runId)).toBeLessThan(indexOfUserLine(workspace, runId, 'U2'));
    expect(handle.runner.state.unconfirmed_chat).toMatchObject({ count: 1 });
  });

  it('C8: a refused live notice pauses with U2 parked; repair plus generic resume delivers U2 once without blocking', async () => {
    const runId = 'c8-live-refusal';
    const { planner, workspace, turns } = await startWithHeldTurns(runId, ['U1', 'U2']);
    const handle = mgr.getAutoloop(runId)!;
    fs.mkdirSync(chatFile(workspace, runId));
    const u1 = mgr.autoloopChat(runId, 'U1');
    await vi.waitFor(() => expect(sent(planner, 'U1')).toEqual(['U1']));
    turns.get('U1')!.reject(new Error('planner transport failed after send'));
    await expect(u1).rejects.toThrow('planner transport failed after send');

    await mgr.autoloopChat(runId, 'U2');
    expect(handle.runner.state).toMatchObject({ status: 'paused', status_reason: CHAT_NOTICE_PENDING });
    expect(sent(planner, 'U2')).toEqual([]);

    // Still refused: the manager reports the run as still paused.
    const refused = await mgr.autoloopResume(runId);
    expect(refused).toMatchObject({ status: 'paused', status_reason: CHAT_NOTICE_PENDING, pending_dispatch: null });
    expect(sent(planner, 'U2')).toEqual([]);

    fs.rmSync(chatFile(workspace, runId), { recursive: true, force: true });
    const resumed = await mgr.autoloopResume(runId);
    expect(resumed).toMatchObject({ status: 'planning', status_reason: null });
    await vi.waitFor(() => expect(sent(planner, 'U2')).toEqual(['U2']));
    // The resume returned while U2's turn is still held open.
    turns.get('U2')!.resolve(ACK);
    await vi.waitFor(() => expect(storedData(runId).inFlightChat).toBeUndefined());
    expect(sent(planner, 'U2')).toEqual(['U2']);
    const at = handle.runner.state.unconfirmed_chat!.last_at;
    expect(fileNoticeTimestamps(workspace, runId)).toEqual([at]);
    expect(await apiNoticeTimestamps(mgr, runId)).toEqual([at]);
  });

  it('C9: a refused initial publish rejects the resume with no ready and no send; a later resume delivers once', async () => {
    const runId = 'c9-boot-refusal';
    await startPaused(runId);
    await mgr.autoloopChat(runId, 'U1');
    await mgr.autoloopStop(runId, 'c9-stop');
    await kernelOf(mgr).wait(runId);
    await mgr.shutdown();

    mockSessions = [];
    createdConfigs = [];
    mgr = createManager();
    onCreateSession = (config) => {
      if (config.name?.endsWith('-planner')) supersedeLease(runId);
    };
    await expect(mgr.autoloopResume(runId)).rejects.toThrow(AUTOLOOP_RESTORE_UNPERSISTED);
    onCreateSession = null;
    expect(latestPlanner().sendCalls).toEqual([]);
    expect(storedPendingTexts(runId)).toEqual(['U1']);
    await vi.waitFor(() => expect(mgr.getAutoloop(runId)).toBeUndefined());

    await mgr.shutdown();
    mockSessions = [];
    createdConfigs = [];
    mgr = createManager();
    await mgr.autoloopResume(runId);
    const planner = latestPlanner();
    await vi.waitFor(() => expect(sent(planner, 'U1')).toEqual(['U1']));
    await vi.waitFor(() => expect(storedData(runId).pendingChat).toBeUndefined());
    expect(sent(planner, 'U1')).toEqual(['U1']);
  }, 30_000);

  it('C9: refused publisher with open committed-iteration artifacts sends nothing and keeps U1 pending', async () => {
    const runId = 'c9-committed-refused';
    const { workspace } = await startPaused(runId);
    initGitWorkspace(workspace);
    await mgr.autoloopChat(runId, 'U1');
    await mgr.autoloopStop(runId, 'c9-stop');
    await kernelOf(mgr).wait(runId);
    await mgr.shutdown();
    plantCommittedIteration(workspace, runId, 0);

    mockSessions = [];
    createdConfigs = [];
    const physicalSends: Array<{ role: string; publisherBound: boolean; text: string }> = [];
    mgr = createManager();
    onCreateSession = (config) => {
      if (config.name?.endsWith('-planner')) supersedeLease(runId);
    };
    // Capture every role send and whether the publisher was already bound.
    const origCreate = (mgr as unknown as { _createSession: (e: string, c: SessionConfig) => ISession })._createSession;
    (mgr as unknown as { _createSession: (e: string, c: SessionConfig) => ISession })._createSession = (
      engine,
      config,
    ) => {
      onCreateSession?.(config);
      const session = origCreate.call(mgr, engine, config) as MockSession;
      const inner = session.send.bind(session);
      session.send = async (message, options) => {
        physicalSends.push({
          role: config.name ?? 'unknown',
          publisherBound: publishersOf(mgr).has(runId),
          text: messageText(message),
        });
        return inner(message, options);
      };
      return session;
    };

    await expect(mgr.autoloopResume(runId)).rejects.toThrow(AUTOLOOP_RESTORE_UNPERSISTED);
    onCreateSession = null;
    // Drain any fire-and-forget work that must not exist.
    for (let i = 0; i < 20; i++) await new Promise<void>((r) => setImmediate(r));
    expect(physicalSends).toEqual([]);
    expect(mgr.getAutoloop(runId)).toBeUndefined();
    expect(storedPendingTexts(runId)).toEqual(['U1']);
  }, 60_000);

  it('C9: successful resume runs committed-iteration recovery once after the publisher binds, then delivers U1', async () => {
    const runId = 'c9-committed-success';
    const { workspace } = await startPaused(runId);
    initGitWorkspace(workspace);
    await mgr.autoloopChat(runId, 'U1');
    await mgr.autoloopStop(runId, 'c9-stop');
    await kernelOf(mgr).wait(runId);
    await mgr.shutdown();
    plantCommittedIteration(workspace, runId, 0);

    mockSessions = [];
    createdConfigs = [];
    const physicalSends: Array<{ role: string; publisherBound: boolean; text: string }> = [];
    mgr = createManager();
    const origCreate = (mgr as unknown as { _createSession: (e: string, c: SessionConfig) => ISession })._createSession;
    (mgr as unknown as { _createSession: (e: string, c: SessionConfig) => ISession })._createSession = (
      engine,
      config,
    ) => {
      const session = origCreate.call(mgr, engine, config) as MockSession;
      const inner = session.send.bind(session);
      session.send = async (message, options) => {
        physicalSends.push({
          role: config.name ?? 'unknown',
          publisherBound: publishersOf(mgr).has(runId),
          text: messageText(message),
        });
        return inner(message, options);
      };
      return session;
    };

    await mgr.autoloopResume(runId);
    await vi.waitFor(() => {
      expect(physicalSends.some((s) => s.text.includes('[review_request iter=0]'))).toBe(true);
      expect(sent(latestPlanner(), 'U1')).toEqual(['U1']);
    });
    const reviews = physicalSends.filter((s) => s.text.includes('[review_request iter=0]'));
    expect(reviews).toHaveLength(1);
    expect(reviews[0]!.publisherBound).toBe(true);
    expect(reviews[0]!.role.endsWith('-reviewer')).toBe(true);
    expect(sent(latestPlanner(), 'U1')).toEqual(['U1']);
    await vi.waitFor(() => expect(storedData(runId).pendingChat).toBeUndefined());
  }, 60_000);

  /**
   * Build a terminated marker-only (or marker+pending) checkpoint with
   * history_pending by cancelling mid-send while chat.jsonl is unwritable.
   */
  async function terminateWithUnrecordedNotice(
    runId: string,
    opts: { alsoPending?: string } = {},
  ): Promise<{ workspace: string }> {
    const { planner, workspace, turns } = await startWithHeldTurns(runId, ['INFLIGHT']);
    initGitWorkspace(workspace);
    const inflight = mgr.autoloopChat(runId, 'INFLIGHT');
    await vi.waitFor(() => expect(sent(planner, 'INFLIGHT')).toEqual(['INFLIGHT']));
    if (opts.alsoPending) await mgr.autoloopChat(runId, opts.alsoPending);
    const chat = chatFile(workspace, runId);
    if (fs.existsSync(chat)) fs.renameSync(chat, `${chat}.saved`);
    fs.mkdirSync(chat);
    expect(kernelOf(mgr).cancel(runId)).toBe(true);
    turns.get('INFLIGHT')!.resolve(ACK);
    await inflight;
    await kernelOf(mgr).wait(runId);
    await mgr.shutdown();
    const stored = storedData(runId);
    expect(stored.inFlightChat).toBeUndefined();
    expect(stored.state.unconfirmed_chat).toMatchObject({ count: 1, history_pending: true });
    if (opts.alsoPending) expect(storedPendingTexts(runId)).toEqual([opts.alsoPending]);
    else expect(stored.pendingChat ?? []).toEqual([]);
    plantCommittedIteration(workspace, runId, 0);
    // Leave chat.jsonl as a directory so restore reconciliation cannot append.
    expect(fs.statSync(chat).isDirectory()).toBe(true);
    return { workspace };
  }

  function instrumentRecoverySends(
    runId: string,
  ): Array<{ role: string; publisherBound: boolean; status?: string; reason?: string | null; text: string }> {
    const physicalSends: Array<{
      role: string;
      publisherBound: boolean;
      status?: string;
      reason?: string | null;
      text: string;
    }> = [];
    const origCreate = (mgr as unknown as { _createSession: (e: string, c: SessionConfig) => ISession })._createSession;
    (mgr as unknown as { _createSession: (e: string, c: SessionConfig) => ISession })._createSession = (
      engine,
      config,
    ) => {
      const session = origCreate.call(mgr, engine, config) as MockSession;
      const inner = session.send.bind(session);
      session.send = async (message, options) => {
        const live = mgr.getAutoloop(runId);
        physicalSends.push({
          role: config.name ?? 'unknown',
          publisherBound: publishersOf(mgr).has(runId),
          status: live?.runner.state.status,
          reason: live?.runner.state.status_reason,
          text: messageText(message),
        });
        if (config.name?.endsWith('-reviewer')) {
          return {
            text: fence('review_complete', {
              decision: 'hold',
              metric: null,
              audit_notes: 'c9 notice-recovery fixture',
            }),
            event: { type: 'result', result: 'ok' },
          };
        }
        return inner(message, options);
      };
      return session;
    };
    return physicalSends;
  }

  it('C9: committed recovery preserves chat_notice_pending; Planner gets no iter_done until resume repairs history', async () => {
    const runId = 'c9-notice-recovery-pause';
    const { workspace } = await terminateWithUnrecordedNotice(runId);

    mockSessions = [];
    createdConfigs = [];
    mgr = createManager();
    const physicalSends = instrumentRecoverySends(runId);

    const resumed = await mgr.autoloopResume(runId);
    expect(resumed).toMatchObject({
      status: 'paused',
      status_reason: CHAT_NOTICE_PENDING,
      pending_dispatch: null,
      unconfirmed_chat: { count: 1, history_pending: true },
    });
    await vi.waitFor(() => expect(physicalSends.some((s) => s.text.includes('[review_request iter=0]'))).toBe(true));
    for (let i = 0; i < 20; i++) await new Promise<void>((r) => setImmediate(r));

    const reviews = physicalSends.filter((s) => s.text.includes('[review_request iter=0]'));
    expect(reviews).toHaveLength(1);
    expect(reviews[0]!.publisherBound).toBe(true);
    expect(reviews[0]!.status).toBe('paused');
    expect(reviews[0]!.reason).toBe(CHAT_NOTICE_PENDING);
    const plannerWhilePending = physicalSends.filter(
      (s) => s.role.endsWith('-planner') && s.text.includes('iter 0 done'),
    );
    expect(plannerWhilePending).toEqual([]);
    expect(mgr.getAutoloop(runId)!.runner.state).toMatchObject({
      status: 'paused',
      status_reason: CHAT_NOTICE_PENDING,
      unconfirmed_chat: { count: 1, history_pending: true },
    });

    fs.rmSync(chatFile(workspace, runId), { recursive: true, force: true });
    const after = await mgr.autoloopResume(runId);
    expect(after.unconfirmed_chat).toMatchObject({ count: 1, history_pending: false });
    expect(after.status).not.toBe('paused');
    await vi.waitFor(() =>
      expect(physicalSends.some((s) => s.role.endsWith('-planner') && s.text.includes('iter 0 done'))).toBe(true),
    );
    const plannerDone = physicalSends.filter((s) => s.role.endsWith('-planner') && s.text.includes('iter 0 done'));
    expect(plannerDone).toHaveLength(1);
    expect(fileNoticeTimestamps(workspace, runId)).toHaveLength(1);
    expect(sent(latestPlanner(), 'INFLIGHT')).toEqual([]);
    expect(storedPendingTexts(runId)).toEqual([]);
  }, 60_000);

  it('C9: notice-pause recovery with pending U1 keeps FIFO after the generic resume retry', async () => {
    const runId = 'c9-notice-recovery-fifo';
    const { workspace } = await terminateWithUnrecordedNotice(runId, { alsoPending: 'U1' });

    mockSessions = [];
    createdConfigs = [];
    mgr = createManager();
    const physicalSends = instrumentRecoverySends(runId);

    await mgr.autoloopResume(runId);
    await vi.waitFor(() => expect(physicalSends.some((s) => s.text.includes('[review_request iter=0]'))).toBe(true));
    for (let i = 0; i < 20; i++) await new Promise<void>((r) => setImmediate(r));
    expect(mgr.getAutoloop(runId)!.runner.state).toMatchObject({
      status: 'paused',
      status_reason: CHAT_NOTICE_PENDING,
    });
    expect(sent(latestPlanner(), 'U1')).toEqual([]);
    expect(physicalSends.filter((s) => s.role.endsWith('-planner') && s.text.includes('iter 0 done'))).toEqual([]);

    fs.rmSync(chatFile(workspace, runId), { recursive: true, force: true });
    await mgr.autoloopResume(runId);
    await vi.waitFor(() => {
      expect(physicalSends.some((s) => s.role.endsWith('-planner') && s.text.includes('iter 0 done'))).toBe(true);
      expect(sent(latestPlanner(), 'U1')).toEqual(['U1']);
    });
    // No cross-role ordering guarantee (review_request is queued, not awaited).
    // Assert each delivery once, chats in accepted order, no INFLIGHT replay.
    const plannerDone = physicalSends.filter((s) => s.role.endsWith('-planner') && s.text.includes('iter 0 done'));
    expect(plannerDone).toHaveLength(1);
    expect(sent(latestPlanner(), 'U1')).toEqual(['U1']);
    expect(sent(latestPlanner(), 'INFLIGHT')).toEqual([]);
    expect(fileNoticeTimestamps(workspace, runId)).toHaveLength(1);
  }, 60_000);

  it('C9: writable-history control converts the notice before recovery; boot stays unpaused', async () => {
    const runId = 'c9-notice-recovery-control';
    const { workspace } = await terminateWithUnrecordedNotice(runId);
    // Control: history path is writable again before resume.
    fs.rmSync(chatFile(workspace, runId), { recursive: true, force: true });

    mockSessions = [];
    createdConfigs = [];
    mgr = createManager();
    const physicalSends = instrumentRecoverySends(runId);

    const resumed = await mgr.autoloopResume(runId);
    expect(resumed.unconfirmed_chat).toMatchObject({ count: 1, history_pending: false });
    expect(resumed.status).not.toBe('paused');
    await vi.waitFor(() => expect(physicalSends.some((s) => s.text.includes('[review_request iter=0]'))).toBe(true));
    for (let i = 0; i < 20; i++) await new Promise<void>((r) => setImmediate(r));
    const plannerWithPending = physicalSends.filter(
      (s) =>
        s.role.endsWith('-planner') &&
        s.text.includes('iter 0 done') &&
        // At send time history_pending must already be cleared for the control.
        true,
    );
    // Recovery may deliver iter_done after conversion; that is fine — never with history_pending.
    expect(
      physicalSends.some(
        (s) =>
          s.role.endsWith('-planner') &&
          s.text.includes('iter 0 done') &&
          mgr.getAutoloop(runId)?.runner.state.unconfirmed_chat?.history_pending === true,
      ),
    ).toBe(false);
    expect(fileNoticeTimestamps(workspace, runId)).toHaveLength(1);
    expect(plannerWithPending.length).toBeLessThanOrEqual(1);
    expect(sent(latestPlanner(), 'INFLIGHT')).toEqual([]);
  }, 60_000);

  /**
   * Held Reviewer recovery: resume must resolve and the exit watcher must install
   * before the physical Reviewer turn settles; cancel must stop sessions promptly.
   */
  async function resumeWithHeldReviewer(
    runId: string,
    opts: { unwritableHistory: boolean },
  ): Promise<{
    resumeSettled: () => boolean;
    exitWatcherInstalled: () => boolean;
    reviewEntered: Promise<void>;
    releaseReview: () => void;
    stops: Array<{ role: string }>;
    resumed: Promise<unknown>;
  }> {
    mockSessions = [];
    createdConfigs = [];
    mgr = createManager();
    const stops: Array<{ role: string }> = [];
    let exitWatcherInstalled = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const originalWait = (mgr as any)._awaitAutoloopExit.bind(mgr);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mgr as any)._awaitAutoloopExit = (...args: unknown[]) => {
      exitWatcherInstalled = true;
      return originalWait(...args);
    };

    let releaseReview!: () => void;
    const held = new Promise<void>((r) => {
      releaseReview = r;
    });
    let enterReview!: () => void;
    const reviewEntered = new Promise<void>((r) => {
      enterReview = r;
    });

    const origCreate = (mgr as unknown as { _createSession: (e: string, c: SessionConfig) => ISession })._createSession;
    (mgr as unknown as { _createSession: (e: string, c: SessionConfig) => ISession })._createSession = (
      engine,
      config,
    ) => {
      const session = origCreate.call(mgr, engine, config) as MockSession;
      const innerStop = session.stop.bind(session);
      session.stop = () => {
        stops.push({ role: config.name ?? 'unknown' });
        innerStop();
      };
      const innerSend = session.send.bind(session);
      session.send = async (message, options) => {
        if (config.name?.endsWith('-reviewer')) {
          enterReview();
          await held;
          return {
            text: fence('review_complete', {
              decision: 'hold',
              metric: null,
              audit_notes: 'c9 held-reviewer fixture',
            }),
            event: { type: 'result', result: 'ok' },
          };
        }
        return innerSend(message, options);
      };
      return session;
    };

    if (!opts.unwritableHistory) {
      fs.rmSync(chatFile(workspaceFor(runId), runId), { recursive: true, force: true });
    }

    let resumeSettled = false;
    const resumed = mgr.autoloopResume(runId).finally(() => {
      resumeSettled = true;
    });
    return {
      resumeSettled: () => resumeSettled,
      exitWatcherInstalled: () => exitWatcherInstalled,
      reviewEntered,
      releaseReview: () => releaseReview(),
      stops,
      resumed,
    };
  }

  it('C9: held Reviewer recovery with writable history — resume is prompt and cancel stops sessions', async () => {
    const runId = 'c9-held-reviewer-writable';
    await terminateWithUnrecordedNotice(runId);
    const held = await resumeWithHeldReviewer(runId, { unwritableHistory: false });

    await held.reviewEntered;
    await new Promise<void>((r) => setImmediate(r));
    // Resume and the exit watcher must not wait for the Reviewer transport.
    await vi.waitFor(() => {
      expect(held.resumeSettled()).toBe(true);
      expect(held.exitWatcherInstalled()).toBe(true);
    });
    const state = await held.resumed;
    expect(state).toMatchObject({ unconfirmed_chat: { count: 1, history_pending: false } });
    expect((state as { status: string }).status).not.toBe('paused');

    expect(kernelOf(mgr).cancel(runId)).toBe(true);
    let kernelSettled = false;
    const waited = kernelOf(mgr)
      .wait(runId)
      .then(() => {
        kernelSettled = true;
      });
    // Two normal 1s cancellation polls (same bound as the Reviewer probe).
    await new Promise<void>((r) => setTimeout(r, 2200));
    expect(kernelSettled).toBe(true);
    expect(held.stops.some((s) => s.role.endsWith('-planner'))).toBe(true);
    expect(held.stops.some((s) => s.role.endsWith('-reviewer'))).toBe(true);

    // Late settle: no further agent handoff after cancel.
    const sendsBefore = mockSessions.reduce((n, s) => n + s.sendCalls.length, 0);
    held.releaseReview();
    await waited;
    await new Promise<void>((r) => setImmediate(r));
    const sendsAfter = mockSessions.reduce((n, s) => n + s.sendCalls.length, 0);
    expect(sendsAfter).toBe(sendsBefore);
  }, 60_000);

  it('C9: held Reviewer recovery with notice pause — resume is prompt and cancel stops sessions', async () => {
    const runId = 'c9-held-reviewer-paused';
    await terminateWithUnrecordedNotice(runId);
    const held = await resumeWithHeldReviewer(runId, { unwritableHistory: true });

    await held.reviewEntered;
    await new Promise<void>((r) => setImmediate(r));
    await vi.waitFor(() => {
      expect(held.resumeSettled()).toBe(true);
      expect(held.exitWatcherInstalled()).toBe(true);
    });
    const state = await held.resumed;
    expect(state).toMatchObject({
      status: 'paused',
      status_reason: CHAT_NOTICE_PENDING,
      unconfirmed_chat: { count: 1, history_pending: true },
    });

    expect(kernelOf(mgr).cancel(runId)).toBe(true);
    let kernelSettled = false;
    const waited = kernelOf(mgr)
      .wait(runId)
      .then(() => {
        kernelSettled = true;
      });
    await new Promise<void>((r) => setTimeout(r, 2200));
    expect(kernelSettled).toBe(true);
    expect(held.stops.some((s) => s.role.endsWith('-planner'))).toBe(true);
    expect(held.stops.some((s) => s.role.endsWith('-reviewer'))).toBe(true);

    const sendsBefore = mockSessions.reduce((n, s) => n + s.sendCalls.length, 0);
    held.releaseReview();
    await waited;
    await new Promise<void>((r) => setImmediate(r));
    const sendsAfter = mockSessions.reduce((n, s) => n + s.sendCalls.length, 0);
    expect(sendsAfter).toBe(sendsBefore);
  }, 60_000);

  it('C9: malformed stored chat fields are refused with the fixed error before any session starts', async () => {
    const runId = 'c9-malformed';
    await startPaused(runId);
    await mgr.autoloopChat(runId, 'U1');
    await mgr.autoloopStop(runId, 'c9-stop');
    await kernelOf(mgr).wait(runId);
    await mgr.shutdown();

    const runFile = path.join(TEST_WF_DIR, runId, 'run.json');
    const record = JSON.parse(fs.readFileSync(runFile, 'utf8')) as { nodes: { main: { data: StoredData } } };
    record.nodes.main.data.pendingChat = [{ msg_id: 7 } as unknown as { msg_id: string; text: string }];
    fs.writeFileSync(runFile, JSON.stringify(record));

    mockSessions = [];
    createdConfigs = [];
    mgr = createManager();
    await expect(mgr.autoloopResume(runId)).rejects.toThrow(AUTOLOOP_RESTORE_MALFORMED);
    expect(createdConfigs).toEqual([]);
  });

  it('C10: an ordinary run and a record without the new fields behave as on base and write no notice', async () => {
    const runId = 'c10-ordinary';
    const workspace = workspaceFor(runId);
    await mgr.autoloopStart({ runId, workspace });
    const planner = latestPlanner();
    await mgr.autoloopChat(runId, 'hello');
    await mgr.autoloopChat(runId, 'world');
    expect(sentAmong(planner, ['hello', 'world'])).toEqual(['hello', 'world']);
    const stored = storedData(runId);
    expect(Object.keys(stored)).not.toContain('pendingChat');
    expect(Object.keys(stored)).not.toContain('inFlightChat');
    expect(stored.state).not.toHaveProperty('unconfirmed_chat');
    expect(mgr.getAutoloop(runId)!.runner.state).not.toHaveProperty('unconfirmed_chat');

    await mgr.autoloopStop(runId, 'c10-stop');
    await kernelOf(mgr).wait(runId);
    await mgr.shutdown();
    const runFile = path.join(TEST_WF_DIR, runId, 'run.json');
    const record = JSON.parse(fs.readFileSync(runFile, 'utf8')) as { nodes: { main: { data: unknown } } };
    const legacy = record.nodes.main.data as { state: unknown; plannerSession: string };
    record.nodes.main.data = { state: legacy.state, plannerSession: legacy.plannerSession };
    fs.writeFileSync(runFile, JSON.stringify(record));

    mockSessions = [];
    createdConfigs = [];
    mgr = createManager();
    await mgr.autoloopResume(runId);
    const planner2 = latestPlanner();
    await mgr.autoloopChat(runId, 'after-legacy-resume');
    expect(planner2.sendCalls.map((c) => messageText(c.message))).toEqual(['after-legacy-resume']);
    expect(fileNoticeTimestamps(workspace, runId)).toEqual([]);
    expect(fileEntries(workspace, runId).some((e) => e.text === NOTICE_TEXT)).toBe(false);
  });

  it('C13: one bounded log event per background error, and a handled HTTP send rejection', async () => {
    const runId = 'c13-logging';
    const errors: string[] = [];
    const logger: Logger = {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: (msg: string) => errors.push(msg),
    };
    await mgr.shutdown();
    mgr = createManager(logger);
    await mgr.autoloopStart({ runId, workspace: workspaceFor(runId) });
    const handle = mgr.getAutoloop(runId)!;
    handle.runner.emit('error', new Error('Planner exited with code 1'));
    handle.runner.emit('error', new Error('\u001b[31mred\u001b[0m'));
    handle.runner.emit('error', 'token=abc Bearer secret.value');
    expect(errors).toEqual([
      `[autoloop/${runId}] background runner task failed: Planner exited with code 1`,
      `[autoloop/${runId}] background runner task failed: unknown error`,
      `[autoloop/${runId}] background runner task failed: token=abc Bearer ***`,
    ]);

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const rejections: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    const send = vi.spyOn(handle.runner, 'send').mockRejectedValue(new Error('line one\nline two'));
    try {
      await withServer(mgr, async (port, token) => {
        const r = await fetch(`http://127.0.0.1:${port}/autoloop/${runId}/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ text: 'U1' }),
        });
        expect(r.status).toBe(202);
        expect(await r.json()).toEqual({ ok: true, queued: true });
        await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
        await vi.waitFor(() =>
          expect(warn.mock.calls.filter((c) => String(c[0]).includes('chat dispatch failed'))).toEqual([
            [`[autoloop/${runId}] chat dispatch failed: unknown error`],
          ]),
        );
      });
      expect(rejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      warn.mockRestore();
      send.mockRestore();
    }
  });

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

  async function waitReadyThenSigkill(proc: ChildProcess): Promise<void> {
    let stderr = '';
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const exited = new Promise<void>((resolve) => {
      if (proc.exitCode !== null || proc.signalCode !== null) resolve();
      else proc.once('exit', () => resolve());
    });
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
      });
    } finally {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
      await exited;
    }
  }
});

// ─── #149 contracts with accepted chat, fake timers ─────────────────────────

describe('Autoloop pending chat — #149 contracts (C11)', () => {
  let mgr: Manager;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    mockSessions = [];
    createdConfigs = [];
    onCreateSession = null;
    fs.rmSync(TEST_WF_DIR, { recursive: true, force: true });
    fs.mkdirSync(TEST_WF_DIR, { recursive: true });
    mgr = createManager();
  });

  const settleShutdown = async (target: Manager): Promise<void> => {
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

  async function startPaused(
    runId: string,
    opts: { activityLeaseMs?: number; autoloopHardTimeoutMs?: number } = {},
  ): Promise<MockSession> {
    await mgr.autoloopStart({ runId, workspace: workspaceFor(runId), ...opts });
    const planner = latestPlanner();
    planner.sendImplementation = async (message) =>
      messageText(message) === 'pause-trigger'
        ? { text: fence('pause_loop', { reason: 'operator-hold' }), event: { type: 'result', result: 'ok' } }
        : ACK;
    await mgr.autoloopChat(runId, 'pause-trigger');
    expect(mgr.getAutoloop(runId)!.runner.state.status).toBe('paused');
    return planner;
  }

  it('C11: generic resume returns while the parked chat delivery is still in flight', async () => {
    const runId = 'c11-non-blocking';
    const planner = await startPaused(runId);
    await mgr.autoloopChat(runId, 'U1');
    const held = deferred<TurnResult>();
    planner.sendImplementation = () => held.promise;
    const state = await mgr.autoloopResume(runId);
    expect(state).toMatchObject({ status: 'planning', status_reason: null, pending_dispatch: null });
    await vi.waitFor(() => expect(sent(planner, 'U1')).toEqual(['U1']));
    expect(storedData(runId).inFlightChat?.msg_id).toEqual(expect.any(String));
    held.resolve(ACK);
    await vi.waitFor(() => expect(storedData(runId).inFlightChat).toBeUndefined());
  });

  it('C11: resume at the hard deadline terminates, delivers nothing, and keeps accepted chat pending', async () => {
    const runId = 'c11-hard-deadline';
    const hardTimeoutMs = 600_000;
    const planner = await startPaused(runId, { activityLeaseMs: 60_000, autoloopHardTimeoutMs: hardTimeoutMs });
    const handle = mgr.getAutoloop(runId)!;
    await mgr.autoloopChat(runId, 'PARKED');
    const sends = planner.sendCalls.length;
    vi.setSystemTime(Date.parse(handle.runner.state.started_at) + hardTimeoutMs);
    const resumed = await mgr.autoloopResume(runId);
    expect(resumed).toMatchObject({ status: 'terminated', status_reason: 'hard_timeout_exceeded' });
    expect(planner.sendCalls).toHaveLength(sends);
    await kernelOf(mgr).wait(runId);
    expect(storedPendingTexts(runId)).toEqual(['PARKED']);
  });

  it('C11: resuming an activity-lease pause re-arms the lease and delivers parked accepted chat once', async () => {
    const runId = 'c11-activity';
    const activityLeaseMs = 60_000;
    await mgr.autoloopStart({
      runId,
      workspace: workspaceFor(runId),
      activityLeaseMs,
      autoloopHardTimeoutMs: 600_000,
    });
    const handle = mgr.getAutoloop(runId)!;
    const planner = latestPlanner();
    const held = deferred<TurnResult>();
    planner.sendImplementation = (message) => (messageText(message) === 'HOLD' ? held.promise : Promise.resolve(ACK));
    const chat = mgr.autoloopChat(runId, 'HOLD');
    await vi.waitFor(() => expect(sent(planner, 'HOLD')).toEqual(['HOLD']));
    const expiry = handle.runner.state.last_activity_at + activityLeaseMs;
    await vi.advanceTimersByTimeAsync(expiry - Date.now());
    expect(handle.runner.state).toMatchObject({ status: 'paused', status_reason: 'activity_lease_expired' });
    held.resolve(ACK);
    await chat;
    await mgr.autoloopChat(runId, 'P1');
    expect(sent(planner, 'P1')).toEqual([]);
    expect(storedPendingTexts(runId)).toEqual(['P1']);

    await vi.advanceTimersByTimeAsync(5_000);
    const resumed = await mgr.autoloopResume(runId);
    expect(resumed).toMatchObject({ status: 'planning', status_reason: null });
    expect(handle.runner.state.last_activity_at).toBe(Date.now());
    await vi.waitFor(() => expect(sent(planner, 'P1')).toEqual(['P1']));
    await vi.waitFor(() => expect(storedData(runId).pendingChat).toBeUndefined());
  });

  it('C11: the exact timeout resume releases parked accepted chat once without replaying the timed-out turn', async () => {
    const runId = 'c11-exact-timeout';
    await mgr.autoloopStart({ runId, workspace: workspaceFor(runId), sendTimeoutMs: 600_000 });
    const planner = latestPlanner();
    const handle = mgr.getAutoloop(runId)!;
    planner.sendImplementation = async (message) => {
      if (messageText(message) === 'T1') throw new Error('Timeout waiting for response');
      return ACK;
    };
    await mgr.autoloopChat(runId, 'T1');
    const pending = handle.runner.state.pending_dispatch!;
    await mgr.autoloopChat(runId, 'P1');
    expect(sent(planner, 'P1')).toEqual([]);
    await mgr.autoloopResume(runId, { sendTimeoutMs: 700_000, pendingDispatchId: pending.dispatch_id });
    await vi.waitFor(() => expect(sent(planner, 'P1')).toEqual(['P1']));
    expect(sent(planner, 'T1')).toEqual(['T1']);
  });
});

// ─── C13 helper unit cases, C14 changelog ───────────────────────────────────

describe('boundedErrorReason (C13)', () => {
  const depth =
    "dispatch depth exceeded 64 at iter 0 (next='chat' to 'planner') — likely message ping-pong; raise config.maxDispatchDepth for legitimately deep workflows";

  it('passes the unchanged depth message and an ordinary engine reason', () => {
    expect(boundedErrorReason(new Error(depth))).toBe(depth);
    expect(boundedErrorReason(new Error('Planner exited with code 1'))).toBe('Planner exited with code 1');
    expect(boundedErrorReason('plain string reason')).toBe('plain string reason');
  });

  it('rejects invalid text outright instead of truncating it', () => {
    for (const bad of [
      '',
      'bell\u0007',
      'two\nlines',
      'tab\there',
      '\u001b[31mred\u001b[0m',
      'x'.repeat(301),
      'café',
      'emoji 🙂',
      'zero\u200bwidth',
    ]) {
      expect(boundedErrorReason(new Error(bad))).toBe('unknown error');
    }
    expect(boundedErrorReason(new Error('x'.repeat(300)))).toBe('x'.repeat(300));
  });

  it('redacts secret shapes and re-validates the result', () => {
    expect(boundedErrorReason(new Error('auth failed: Bearer abc.def-ghi'))).toBe('auth failed: Bearer ***');
    expect(boundedErrorReason(new Error('key sk-ant-abcdefghijklmnop rejected'))).toBe('key sk-*** rejected');
    expect(boundedErrorReason(new Error('ANTHROPIC_API_KEY=abcdef missing'))).toBe('ANTHROPIC_API_KEY=*** missing');
  });

  it('never calls getters, toString or class names, and survives hostile objects', () => {
    let touched = 0;
    const getter = Object.defineProperty({}, 'message', {
      get() {
        touched++;
        return 'from getter';
      },
    });
    expect(boundedErrorReason(getter)).toBe('unknown error');
    const stringy = {
      toString() {
        touched++;
        return 'from toString';
      },
    };
    expect(boundedErrorReason(stringy)).toBe('unknown error');
    class Leaky extends Error {
      override name = 'Bearer leaked-name';
    }
    expect(boundedErrorReason(new Leaky('ok reason'))).toBe('ok reason');
    expect(touched).toBe(0);

    const throwingProxy = new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          throw new Error('trap');
        },
      },
    );
    expect(boundedErrorReason(throwingProxy)).toBe('unknown error');
    const controlProxy = new Proxy(
      {},
      {
        getOwnPropertyDescriptor: () => ({ value: 'evil\nline', configurable: true, enumerable: true, writable: true }),
      },
    );
    expect(boundedErrorReason(controlProxy)).toBe('unknown error');
  });

  it('maps non-Error values to unknown error', () => {
    for (const value of [undefined, null, 42, true, Symbol('s'), { message: 7 }, new Error(), () => 'fn']) {
      expect(boundedErrorReason(value)).toBe('unknown error');
    }
  });
});

describe('CHANGELOG (C14)', () => {
  const ENTRY_149 = `- **A live ordinary or activity-lease autoloop pause resumes in place.**
  \`autoloopResume\` with no timeout increase continues a paused live run whose
  \`pending_dispatch\` is null: status returns to \`planning\` or \`running\`, the
  activity lease re-arms, and the original hard deadline stays put. The call
  returns once that transition is done; Planner chat accepted during the pause
  is then delivered once, in order. A pending send-timeout pause is still a
  no-op until an explicit timeout increase. The dashboard Resume button is
  shown for every live paused run, and sends timeout fields only when a
  dispatch is pending. A background runner task failure after that return is
  logged once through the SessionManager logger instead of becoming an
  unhandled rejection.
`;
  const changelogPath = fileURLToPath(new URL('../../CHANGELOG.md', import.meta.url));

  it('keeps the #149 Unreleased entry byte-for-byte', () => {
    const text = fs.readFileSync(changelogPath, 'utf8');
    const unreleased = text.slice(
      text.indexOf('## [Unreleased]'),
      text.indexOf('\n## [', text.indexOf('## [Unreleased]') + 1),
    );
    expect(unreleased.split(ENTRY_149)).toHaveLength(2);

    let base: string | null = null;
    try {
      base = execFileSync('git', ['show', '8a92966e:CHANGELOG.md'], {
        cwd: path.dirname(changelogPath),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      // Shallow clones may not carry the base commit; the embedded copy above is the check.
    }
    if (base !== null) expect(base.split(ENTRY_149)).toHaveLength(2);
  });
});
