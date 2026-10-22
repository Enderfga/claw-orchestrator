/**
 * Phase B corrections-2B — contract oracles + consumers for P1/P2/P3.
 */

import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AutoloopInputPersistenceError,
  formatAutoloopBackgroundErrorReason,
  isDispatchId,
  isGenuinePendingDispatch,
  isPendingMessageId,
  MAX_TOMBSTONES,
  validateRecoveryField,
  type AutoloopRecovery,
} from '../autoloop/recovery.js';
import { Msg, type AnyAutoloopMessage, type SendTimeoutPayload } from '../autoloop/messages.js';
import { AutoloopRunner } from '../autoloop/runner.js';
import type { AgentDispatcher, AutoloopConfig } from '../autoloop/types.js';
import { EmbeddedServer } from '../embedded-server.js';
import type {
  CostBreakdown,
  EffortLevel,
  ISession,
  SessionConfig,
  SessionSendOptions,
  SessionStats,
  TurnResult,
} from '../types.js';

const OWNER_CHILD = fileURLToPath(new URL('./helpers/autoloop-owner-child.ts', import.meta.url));
const TMP_ROOTS: string[] = [];
const STARTED_RUNNERS: AutoloopRunner[] = [];
const ORIG_WF = process.env.CLAWO_WF_DIR;
const ORIG_SESS = process.env.CLAWO_SESSIONS_DIR;

function trackTmp(dir: string): string {
  TMP_ROOTS.push(dir);
  return dir;
}

function freshWf(): string {
  const d = trackTmp(fs.mkdtempSync(path.join(os.tmpdir(), 'clawo-c2b-wf-')));
  process.env.CLAWO_WF_DIR = d;
  process.env.CLAWO_SESSIONS_DIR = trackTmp(fs.mkdtempSync(path.join(os.tmpdir(), 'clawo-c2b-sess-')));
  return d;
}

let TEST_WF_DIR = '';

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  const PROTECTED = ['claude-sessions.json', 'session-pids.json'];
  const isProtected = (p: unknown): boolean => typeof p === 'string' && PROTECTED.some((n) => p.includes(n));
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
    rmSync: actual.rmSync.bind(actual),
    writeFile: vi.fn((_p: unknown, _d: unknown, cb: (err: null) => void) => cb(null)),
    rename: vi.fn((_o: unknown, _n: unknown, cb: (err: null) => void) => cb(null)),
    mkdir: vi.fn((_p: unknown, _opts: unknown, cb: (err: null) => void) => cb(null)),
    unlink: vi.fn((_p: unknown, cb: () => void) => cb()),
  };
  return { ...actual, ...shim, default: { ...actual, ...shim } };
});

const { SessionManager } = await import('../session-manager.js');
const { acquireLease, atomicWriteJson, loadRun, readLease, runDir } = await import('../kernel/store.js');

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
const errorLogs: unknown[][] = [];

function patch(mgr: InstanceType<typeof SessionManager>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (mgr as any)._createSession = (_e: string, _c: SessionConfig): ISession => {
    const m = new MockSession();
    mockSessions.push(m);
    return m;
  };
}

function createManager(extra: Record<string, unknown> = {}) {
  const mgr = new SessionManager(
    {
      claudeBin: 'mock-claude',
      maxConcurrentSessions: 8,
      sessionTtlMinutes: 120,
      defaultPermissionMode: 'acceptEdits',
      ...extra,
    },
    {
      error: (...args: unknown[]) => {
        errorLogs.push(args);
      },
      warn: () => undefined,
      info: () => undefined,
      debug: () => undefined,
    },
  );
  patch(mgr);
  return mgr;
}

/** Reach terminate() while drain is blocked in deliver (Msg.terminate cannot drain). */
async function terminateNow(runner: AutoloopRunner, reason: string): Promise<void> {
  await (runner as unknown as { terminate: (r: string) => Promise<void> }).terminate(reason);
}

const fence = (tool: string, args: Record<string, unknown>) =>
  `\`\`\`autoloop\n${JSON.stringify({ tool, args })}\n\`\`\``;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      if (!a || typeof a === 'string') reject(new Error('no port'));
      else {
        const p = a.port;
        s.close(() => resolve(p));
      }
    });
    s.on('error', reject);
  });
}

function makeRunner(dispatcher: AgentDispatcher, overrides: Partial<AutoloopConfig> = {}): AutoloopRunner {
  const root = trackTmp(fs.mkdtempSync(path.join(os.tmpdir(), 'clawo-c2b-runner-')));
  const config: AutoloopConfig = {
    run_id: 'c2b-run',
    workspace: path.join(root, 'ws'),
    ledger_dir: path.join(root, 'ledger'),
    notifyUser: async () => {},
    dispatcher,
    stallCheckIntervalMs: 24 * 60 * 60 * 1000,
    ...overrides,
  };
  fs.mkdirSync(config.workspace, { recursive: true });
  fs.mkdirSync(config.ledger_dir, { recursive: true });
  const runner = new AutoloopRunner(config);
  STARTED_RUNNERS.push(runner);
  return runner;
}

function mid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

function ts(): string {
  return '2026-10-22T00:00:00.000Z';
}

function recoverySnapshot(runId: string): AutoloopRecovery | null | undefined {
  const rec = loadRun(runId);
  const data = rec?.nodes?.main?.data as { recovery?: unknown } | undefined;
  if (!data || !('recovery' in data)) return undefined;
  try {
    return validateRecoveryField(data.recovery);
  } catch {
    return null;
  }
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

async function waitReady(proc: ChildProcess, timeoutMs = 20_000): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('READY timeout')), timeoutMs);
    let buf = '';
    proc.stdout?.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      if (buf.includes('READY')) {
        clearTimeout(t);
        resolve();
      }
    });
    proc.stderr?.on('data', (c: Buffer) => process.stderr.write(c));
    proc.on('exit', (code) => {
      clearTimeout(t);
      reject(new Error(`child exited before READY code=${code}`));
    });
  });
}

function stealLease(runId: string): void {
  const lease = readLease(runId)!;
  atomicWriteJson(path.join(runDir(runId), 'lease.json'), {
    ...lease,
    host: 'a-machine-that-is-not-this-one',
    renewedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
  });
  acquireLease(runId, 'thief-owner');
}

/** Owner-loss: make the live lease stale without installing a lasting thief owner. */
function staleOwnerLease(runId: string): void {
  const lease = readLease(runId)!;
  atomicWriteJson(path.join(runDir(runId), 'lease.json'), {
    ...lease,
    host: 'a-machine-that-is-not-this-one',
    renewedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
  });
}

beforeEach(() => {
  TEST_WF_DIR = freshWf();
  mockSessions = [];
  errorLogs.length = 0;
});

afterEach(() => {
  while (STARTED_RUNNERS.length > 0) {
    try {
      STARTED_RUNNERS.pop()!.stop();
    } catch {
      /* ignore */
    }
  }
  while (TMP_ROOTS.length > 0) {
    const d = TMP_ROOTS.pop()!;
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  if (ORIG_WF === undefined) delete process.env.CLAWO_WF_DIR;
  else process.env.CLAWO_WF_DIR = ORIG_WF;
  if (ORIG_SESS === undefined) delete process.env.CLAWO_SESSIONS_DIR;
  else process.env.CLAWO_SESSIONS_DIR = ORIG_SESS;
  TEST_WF_DIR = '';
  mockSessions = [];
  errorLogs.length = 0;
});

describe('2A2 row1/2 F7 receipts + eviction + negatives', () => {
  it('row1_F7_runner_original_body_retry_is_idempotent', async () => {
    let commits = 0;
    const runner = makeRunner(
      {
        async deliver() {
          return [];
        },
      },
      {
        persistCheckpoint: () => {
          commits += 1;
          return true;
        },
      },
    );
    await runner.start();
    const ledgerId = mid(9001);
    const a = mid(1);
    runner.applyRestoredRecovery({
      v: 1,
      gate: { kind: 'input_uncertain' },
      ledger_id: ledgerId,
      revision: 1,
      items: [{ message_id: a, iter: 0, ts: ts(), accepted_at: ts(), text: 'a', status: 'dispatched' }],
      resolved: [],
    });
    const original = { ledgerId, expectedRevision: 1, messageIds: [a], resolution: 'abandon' as const };
    expect(runner.disposeUncertainInput({ ...original })).toBe('applied');
    const commitsAfter = commits;
    expect(runner.getCommittedRecovery()!.resolved[0]!.revision).toBe(2); // expectedRevision+1
    expect(runner.disposeUncertainInput({ ...original })).toBe('idempotent');
    expect(commits).toBe(commitsAfter);
    // Later pause must not be released by original-body retry:
    await runner.send(Msg.pause(0, { reason: 'later-hold' }));
    expect(runner.state.status).toBe('paused');
    expect(runner.disposeUncertainInput({ ...original })).toBe('idempotent');
    expect(runner.state.status).toBe('paused');
    expect(runner.getCommittedRecovery()?.gate?.kind).toBe('operator_pause');
  });

  it('row1_F7_manager_and_http_original_body_retry_is_noop', async () => {
    const mgr = createManager();
    const runId = 'c2b-f7-http';
    const workspace = path.join(TEST_WF_DIR, 'workspaces', runId);
    fs.mkdirSync(workspace, { recursive: true });
    try {
      await mgr.autoloopStart({ runId, workspace });
      mockSessions[0]!.sendImplementation = async () => {
        throw new Error('planner transport failed');
      };
      await expect(mgr.autoloopChat(runId, 'boom')).rejects.toThrow();
      const handle = mgr.getAutoloop(runId)!;
      const pending = handle.runner.state.pending_input!;
      const originalHttp = {
        input_disposition: {
          ledger_id: pending.ledger_id,
          expected_revision: pending.revision,
          message_ids: pending.items.map((i) => i.message_id),
          resolution: 'abandon',
        },
      };
      const originalMgr = {
        ledgerId: pending.ledger_id,
        expectedRevision: pending.revision,
        messageIds: pending.items.map((i) => i.message_id),
        resolution: 'abandon' as const,
      };
      const server = new EmbeddedServer(mgr, await freePort());
      const port = await server.start();
      const token = fs.readFileSync(path.join(os.homedir(), '.openclaw', 'server-token'), 'utf-8').trim();
      try {
        const post = async (body: unknown) => {
          const res = await fetch(`http://127.0.0.1:${port}/autoloop/${runId}/resume`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
            body: JSON.stringify(body),
          });
          return { status: res.status, json: await res.json() };
        };
        expect((await post(originalHttp)).status).toBe(200);
        const sendsAfterFirst = mockSessions[0]!.sendCalls.length;
        const diskAfterFirst = JSON.stringify(loadRun(runId));
        // Authenticated HTTP identical original body — success no-op:
        expect((await post(originalHttp)).status).toBe(200);
        expect(mockSessions[0]!.sendCalls.length).toBe(sendsAfterFirst);
        expect(JSON.stringify(loadRun(runId))).toBe(diskAfterFirst);
        // Direct manager retry independently:
        await expect(mgr.autoloopResume(runId, { inputDisposition: { ...originalMgr } })).resolves.toBeTruthy();
        expect(mockSessions[0]!.sendCalls.length).toBe(sendsAfterFirst);
        // Later pause + pending stay held through original-body retry:
        await handle.runner.send(Msg.pause(0, { reason: 'post-f7-hold' }));
        const { message_id: laterId } = handle.runner.acceptChat('held-later');
        expect(handle.runner.state.status).toBe('paused');
        await expect(mgr.autoloopResume(runId, { inputDisposition: { ...originalMgr } })).resolves.toBeTruthy();
        expect(handle.runner.state.status).toBe('paused');
        expect(handle.runner.getCommittedRecovery()?.items.some((i) => i.message_id === laterId)).toBe(true);
      } finally {
        await server.stop();
      }
    } finally {
      await mgr.shutdown();
    }
  });

  it('row2_65_sequential_singleton_evicts_first_receipt_then_union_refused', async () => {
    const runner = makeRunner(
      {
        async deliver() {
          return [];
        },
      },
      { persistCheckpoint: () => true },
    );
    await runner.start();
    const ledgerId = mid(9002);
    const bodies: Array<{
      ledgerId: string;
      expectedRevision: number;
      messageIds: string[];
      resolution: 'abandon';
    }> = [];
    let resolved: AutoloopRecovery['resolved'] = [];
    let revision = 0;
    for (let i = 0; i < MAX_TOMBSTONES + 1; i++) {
      const id = mid(1000 + i);
      runner.applyRestoredRecovery({
        v: 1,
        gate: { kind: 'input_uncertain' },
        ledger_id: ledgerId,
        revision,
        items: [{ message_id: id, iter: 0, ts: ts(), accepted_at: ts(), text: `t${i}`, status: 'dispatched' }],
        resolved,
      });
      const body = {
        ledgerId,
        expectedRevision: runner.getCommittedRecovery()!.revision,
        messageIds: [id],
        resolution: 'abandon' as const,
      };
      expect(runner.disposeUncertainInput({ ...body })).toBe('applied');
      bodies.push(body);
      const snap = runner.getCommittedRecovery()!;
      resolved = snap.resolved;
      revision = snap.revision;
    }
    expect(runner.getCommittedRecovery()!.resolved.length).toBe(MAX_TOMBSTONES);
    // Evicted first original receipt → conflict, no mutation.
    const before = JSON.stringify(runner.getCommittedRecovery());
    expect(() => runner.disposeUncertainInput({ ...bodies[0]! })).toThrow();
    expect(JSON.stringify(runner.getCommittedRecovery())).toBe(before);
    // Union of two sequential decisions refused.
    expect(() =>
      runner.disposeUncertainInput({
        ledgerId,
        expectedRevision: bodies[bodies.length - 1]!.expectedRevision,
        messageIds: [bodies[bodies.length - 2]!.messageIds[0]!, bodies[bodies.length - 1]!.messageIds[0]!],
        resolution: 'abandon',
      }),
    ).toThrow();
    expect(JSON.stringify(runner.getCommittedRecovery())).toBe(before);
  });

  it('row2_65_eviction_and_union_refused_via_manager_and_http_409', async () => {
    const mgr = createManager();
    const runId = 'c2b-evict-http';
    const workspace = path.join(TEST_WF_DIR, 'workspaces', runId);
    fs.mkdirSync(workspace, { recursive: true });
    const server = new EmbeddedServer(mgr, await freePort());
    let publisherCalls = 0;
    try {
      await mgr.autoloopStart({ runId, workspace });
      const handle = mgr.getAutoloop(runId)!;
      const runner = handle.runner;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mgrAny = mgr as any;
      const priorPub = mgrAny._autoloopPublishers.get(runId) as (() => void) | undefined;
      mgrAny._autoloopPublishers.set(runId, () => {
        publisherCalls += 1;
        return priorPub?.() ?? false;
      });

      const ledgerId = mid(9010);
      const bodies: Array<{
        ledgerId: string;
        expectedRevision: number;
        messageIds: string[];
        resolution: 'abandon';
      }> = [];
      let resolved: AutoloopRecovery['resolved'] = [];
      let revision = 0;
      for (let i = 0; i < MAX_TOMBSTONES + 1; i++) {
        const id = mid(2000 + i);
        runner.applyRestoredRecovery({
          v: 1,
          gate: { kind: 'input_uncertain' },
          ledger_id: ledgerId,
          revision,
          items: [{ message_id: id, iter: 0, ts: ts(), accepted_at: ts(), text: `t${i}`, status: 'dispatched' }],
          resolved,
        });
        const body = {
          ledgerId,
          expectedRevision: runner.getCommittedRecovery()!.revision,
          messageIds: [id],
          resolution: 'abandon' as const,
        };
        await mgr.autoloopResume(runId, { inputDisposition: body });
        bodies.push(body);
        const snap = runner.getCommittedRecovery()!;
        resolved = snap.resolved;
        revision = snap.revision;
      }
      expect(runner.getCommittedRecovery()!.resolved.length).toBe(MAX_TOMBSTONES);
      const holdId = mid(2999);
      runner.applyRestoredRecovery({
        v: 1,
        gate: { kind: 'input_uncertain' },
        ledger_id: ledgerId,
        revision: runner.getCommittedRecovery()!.revision,
        items: [{ message_id: holdId, iter: 0, ts: ts(), accepted_at: ts(), text: 'hold', status: 'dispatched' }],
        resolved: runner.getCommittedRecovery()!.resolved,
      });
      expect(runner.state.status).toBe('paused');

      const port = await server.start();
      const token = fs.readFileSync(path.join(os.homedir(), '.openclaw', 'server-token'), 'utf-8').trim();
      const post = async (body: unknown) => {
        const res = await fetch(`http://127.0.0.1:${port}/autoloop/${runId}/resume`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify(body),
        });
        return { status: res.status, json: await res.json() };
      };

      const assertFrozen = (diskBefore: string, sendsBefore: number, statusBefore: string, pubBefore: number) => {
        expect(JSON.stringify(loadRun(runId))).toBe(diskBefore);
        expect(mockSessions.reduce((n, s) => n + s.sendCalls.length, 0)).toBe(sendsBefore);
        expect(runner.state.status).toBe(statusBefore);
        expect(runner.getCommittedRecovery()?.gate?.kind).toBe('input_uncertain');
        expect(publisherCalls).toBe(pubBefore);
      };

      const evictedMgr = { ...bodies[0]! };
      const evictedHttp = {
        input_disposition: {
          ledger_id: evictedMgr.ledgerId,
          expected_revision: evictedMgr.expectedRevision,
          message_ids: evictedMgr.messageIds,
          resolution: 'abandon',
        },
      };
      let diskSnap = JSON.stringify(loadRun(runId));
      let sendsSnap = mockSessions.reduce((n, s) => n + s.sendCalls.length, 0);
      let statusSnap = runner.state.status;
      let pubSnap = publisherCalls;
      await expect(mgr.autoloopResume(runId, { inputDisposition: evictedMgr })).rejects.toThrow();
      assertFrozen(diskSnap, sendsSnap, statusSnap, pubSnap);

      diskSnap = JSON.stringify(loadRun(runId));
      sendsSnap = mockSessions.reduce((n, s) => n + s.sendCalls.length, 0);
      statusSnap = runner.state.status;
      pubSnap = publisherCalls;
      expect((await post(evictedHttp)).status).toBe(409);
      assertFrozen(diskSnap, sendsSnap, statusSnap, pubSnap);

      const unionMgr = {
        ledgerId,
        expectedRevision: bodies[bodies.length - 1]!.expectedRevision,
        messageIds: [bodies[bodies.length - 2]!.messageIds[0]!, bodies[bodies.length - 1]!.messageIds[0]!],
        resolution: 'abandon' as const,
      };
      const unionHttp = {
        input_disposition: {
          ledger_id: unionMgr.ledgerId,
          expected_revision: unionMgr.expectedRevision,
          message_ids: unionMgr.messageIds,
          resolution: 'abandon',
        },
      };
      diskSnap = JSON.stringify(loadRun(runId));
      sendsSnap = mockSessions.reduce((n, s) => n + s.sendCalls.length, 0);
      statusSnap = runner.state.status;
      pubSnap = publisherCalls;
      await expect(mgr.autoloopResume(runId, { inputDisposition: unionMgr })).rejects.toThrow();
      assertFrozen(diskSnap, sendsSnap, statusSnap, pubSnap);

      diskSnap = JSON.stringify(loadRun(runId));
      sendsSnap = mockSessions.reduce((n, s) => n + s.sendCalls.length, 0);
      statusSnap = runner.state.status;
      pubSnap = publisherCalls;
      expect((await post(unionHttp)).status).toBe(409);
      assertFrozen(diskSnap, sendsSnap, statusSnap, pubSnap);
    } finally {
      await server.stop();
      await mgr.shutdown();
    }
  });

  it('row1_negatives_extra_key_subset_union_opposite_unknown_fixed_status_no_effects', async () => {
    const mgr = createManager();
    const runId = 'c2a2-f7-neg';
    const workspace = path.join(TEST_WF_DIR, 'workspaces', runId);
    fs.mkdirSync(workspace, { recursive: true });
    const server = new EmbeddedServer(mgr, await freePort());
    try {
      await mgr.autoloopStart({ runId, workspace });
      mockSessions[0]!.sendImplementation = async () => {
        throw new Error('fail');
      };
      await expect(mgr.autoloopChat(runId, 'u')).rejects.toThrow();
      const handle = mgr.getAutoloop(runId)!;
      const pending = handle.runner.state.pending_input!;
      const good = {
        ledger_id: pending.ledger_id,
        expected_revision: pending.revision,
        message_ids: pending.items.map((i) => i.message_id),
        resolution: 'abandon',
      };
      const port = await server.start();
      const token = fs.readFileSync(path.join(os.homedir(), '.openclaw', 'server-token'), 'utf-8').trim();
      const post = async (body: unknown) => {
        const res = await fetch(`http://127.0.0.1:${port}/autoloop/${runId}/resume`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify(body),
        });
        return res.status;
      };
      const diskBefore = JSON.stringify(loadRun(runId));
      const sendsBefore = mockSessions[0]!.sendCalls.length;
      const statusBefore = handle.runner.state.status;
      expect(await post({ input_disposition: { ...good, extra: true } })).toBe(400);
      expect(await post({ input_disposition: { ...good, message_ids: good.message_ids.slice(0, 0) } })).toBe(400);
      expect(
        await post({
          input_disposition: {
            ...good,
            message_ids: [...good.message_ids, mid(777)],
          },
        }),
      ).toBe(409);
      expect(
        await post({
          input_disposition: { ...good, message_ids: [mid(888)] },
        }),
      ).toBe(409);
      expect(JSON.stringify(loadRun(runId))).toBe(diskBefore);
      expect(mockSessions[0]!.sendCalls.length).toBe(sendsBefore);
      expect(handle.runner.state.status).toBe(statusBefore);
      expect(handle.runner.hasUncertainItems()).toBe(true);
      // Apply abandon, then opposite on original body.
      await mgr.autoloopResume(runId, {
        inputDisposition: {
          ledgerId: good.ledger_id,
          expectedRevision: good.expected_revision,
          messageIds: good.message_ids,
          resolution: 'abandon',
        },
      });
      await expect(
        mgr.autoloopResume(runId, {
          inputDisposition: {
            ledgerId: good.ledger_id,
            expectedRevision: good.expected_revision,
            messageIds: good.message_ids,
            resolution: 'confirm_delivered',
          },
        }),
      ).rejects.toThrow();
    } finally {
      await server.stop();
      await mgr.shutdown();
    }
  });

  it('row2_at_most_one_dispatched_invariant', () => {
    expect(() =>
      validateRecoveryField({
        v: 1,
        gate: null,
        ledger_id: mid(9003),
        revision: 1,
        items: [
          { message_id: mid(1), iter: 0, ts: ts(), accepted_at: ts(), text: 'a', status: 'dispatched' },
          { message_id: mid(2), iter: 0, ts: ts(), accepted_at: ts(), text: 'b', status: 'dispatched' },
        ],
        resolved: [],
      }),
    ).toThrow(AutoloopInputPersistenceError);
  });
});

describe('2A2 row3 same-kind pause midRev', () => {
  it('row3_midRev_between_two_same_kind_pauses_stale_after_second', async () => {
    const runner = makeRunner(
      {
        async deliver() {
          return [];
        },
      },
      { persistCheckpoint: () => true },
    );
    await runner.start();
    const ledgerId = mid(9004);
    const messageId = mid(50);
    runner.applyRestoredRecovery({
      v: 1,
      gate: { kind: 'input_uncertain' },
      ledger_id: ledgerId,
      revision: 3,
      items: [{ message_id: messageId, iter: 0, ts: ts(), accepted_at: ts(), text: 'x', status: 'dispatched' }],
      resolved: [],
    });
    await runner.send(Msg.pause(0, { reason: 'hold-1' }));
    const midRev = runner.getCommittedRecovery()!.revision;
    await runner.send(Msg.pause(0, { reason: 'hold-2' }));
    const afterRev = runner.getCommittedRecovery()!.revision;
    // Contract: second same-kind pause must bump so a midRev decision is stale.
    let midDispose: 'applied' | 'idempotent' | 'threw' = 'threw';
    try {
      midDispose = runner.disposeUncertainInput({
        ledgerId,
        expectedRevision: midRev,
        messageIds: [messageId],
        resolution: 'abandon',
      });
    } catch {
      midDispose = 'threw';
    }
    expect(afterRev).toBeGreaterThan(midRev);
    expect(midDispose).toBe('threw');
    expect(runner.hasUncertainItems()).toBe(true);
  });
});

describe('2A2 row4 real kernel fence transitions', () => {
  it('row4_stolen_fence_blocks_accept_dispatch_complete_disposition_and_gate_release', async () => {
    // --- labelled false-callback + missing-publisher controls (not the fence) ---
    {
      const mgr = createManager();
      const runId = 'c2a2-fence-ctrl';
      const workspace = path.join(TEST_WF_DIR, 'workspaces', runId);
      fs.mkdirSync(workspace, { recursive: true });
      try {
        await mgr.autoloopStart({ runId, workspace });
        const handle = mgr.getAutoloop(runId)!;
        let allow = true;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (mgr as any)._autoloopPublishers.set(runId, () => allow);
        allow = false;
        expect(() => handle.runner.acceptChat('cb')).toThrow(AutoloopInputPersistenceError);
        allow = true;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (mgr as any)._autoloopPublishers.delete(runId);
        expect(() => handle.runner.acceptChat('nopub')).toThrow(AutoloopInputPersistenceError);
      } finally {
        await mgr.shutdown();
      }
    }

    // --- accept under stolen fence ---
    {
      const mgr = createManager();
      const runId = 'c2a2-fence-accept';
      const workspace = path.join(TEST_WF_DIR, 'workspaces', runId);
      fs.mkdirSync(workspace, { recursive: true });
      try {
        await mgr.autoloopStart({ runId, workspace });
        const live = mgr.getAutoloop(runId)!;
        const disk = JSON.stringify(loadRun(runId));
        const sends = mockSessions.reduce((n, s) => n + s.sendCalls.length, 0);
        stealLease(runId);
        expect(() => live.runner.acceptChat('stolen-ack')).toThrow(AutoloopInputPersistenceError);
        expect(JSON.stringify(loadRun(runId))).toBe(disk);
        expect(mockSessions.reduce((n, s) => n + s.sendCalls.length, 0)).toBe(sends);
      } finally {
        await mgr.shutdown();
      }
    }

    // --- dispatch mark under stolen fence (pending accepted while owning, not paused) ---
    {
      const mgr = createManager();
      const runId = 'c2a2-fence-dispatch';
      const workspace = path.join(TEST_WF_DIR, 'workspaces', runId);
      fs.mkdirSync(workspace, { recursive: true });
      try {
        await mgr.autoloopStart({ runId, workspace });
        const live = mgr.getAutoloop(runId)!;
        const { message_id } = live.runner.acceptChat('pre-dispatch');
        expect(live.runner.getCommittedRecovery()!.items[0]!.status).toBe('pending');
        const diskAfterAccept = JSON.stringify(loadRun(runId));
        stealLease(runId);
        const sendsBefore = mockSessions.reduce((n, s) => n + s.sendCalls.length, 0);
        await expect(live.runner.deliverAccepted(message_id)).rejects.toThrow(AutoloopInputPersistenceError);
        expect(mockSessions.reduce((n, s) => n + s.sendCalls.length, 0)).toBe(sendsBefore);
        expect(JSON.stringify(loadRun(runId))).toBe(diskAfterAccept);
        expect(live.runner.getCommittedRecovery()!.items[0]!.status).toBe('pending');
      } finally {
        await mgr.shutdown();
      }
    }

    // --- gate release under stolen fence ---
    {
      const mgr = createManager();
      const runId = 'c2a2-fence-gate';
      const workspace = path.join(TEST_WF_DIR, 'workspaces', runId);
      fs.mkdirSync(workspace, { recursive: true });
      try {
        await mgr.autoloopStart({ runId, workspace });
        const live = mgr.getAutoloop(runId)!;
        await live.runner.send(Msg.pause(0, { reason: 'operator-hold' }));
        expect(live.runner.state.status).toBe('paused');
        expect(live.runner.getCommittedRecovery()?.gate?.kind).toBe('operator_pause');
        const disk = JSON.stringify(loadRun(runId));
        const sendsBefore = mockSessions.reduce((n, s) => n + s.sendCalls.length, 0);
        stealLease(runId);
        expect(live.runner.resumePaused()).toBe(false);
        expect(mockSessions.reduce((n, s) => n + s.sendCalls.length, 0)).toBe(sendsBefore);
        expect(live.runner.state.status).toBe('paused');
        expect(JSON.stringify(loadRun(runId))).toBe(disk);
      } finally {
        await mgr.shutdown();
      }
    }

    // --- completion under stolen fence (mark dispatched, hang transport, steal, settle) ---
    {
      mockSessions = [];
      const mgr = createManager();
      const runId = 'c2a2-fence-complete';
      const workspace = path.join(TEST_WF_DIR, 'workspaces', runId);
      fs.mkdirSync(workspace, { recursive: true });
      let settle!: (v: TurnResult) => void;
      const gate = new Promise<TurnResult>((r) => {
        settle = r;
      });
      try {
        await mgr.autoloopStart({ runId, workspace });
        const live = mgr.getAutoloop(runId)!;
        const planner = mockSessions[0]!;
        const { message_id } = live.runner.acceptChat('COMPLETE_ME');
        let entered = false;
        const sendsBeforeDispatch = planner.sendCalls.length;
        planner.sendImplementation = async () => {
          entered = true;
          return gate;
        };
        const delivering = live.runner.deliverAccepted(message_id);
        const start = Date.now();
        while (!entered || !live.runner.hasUncertainItems()) {
          if (Date.now() - start > 3000) throw new Error('dispatch handshake timeout');
          await Promise.resolve();
        }
        const followups: string[] = [];
        const origDeliver = live.runner.config.dispatcher.deliver.bind(live.runner.config.dispatcher);
        live.runner.config.dispatcher.deliver = async (env: AnyAutoloopMessage) => {
          if (env.type !== 'chat') followups.push(env.type);
          return origDeliver(env);
        };
        const laterText = 'LATER_PENDING_UNDER_FENCE';
        const { message_id: laterId } = live.runner.acceptChat(laterText);
        const disk = JSON.stringify(loadRun(runId));
        const sendsAtUncertain = planner.sendCalls.length;
        expect(sendsAtUncertain).toBe(sendsBeforeDispatch + 1);
        stealLease(runId);
        settle({ text: 'late', event: { type: 'result', result: 'ok' } });
        await expect(delivering).rejects.toThrow(AutoloopInputPersistenceError);
        await live.runner.deliverAccepted(laterId);
        expect(JSON.stringify(loadRun(runId))).toBe(disk);
        expect(live.runner.hasUncertainItems()).toBe(true);
        expect(planner.sendCalls.length).toBe(sendsAtUncertain);
        expect(followups).toEqual([]);
        const rec = live.runner.getCommittedRecovery()!;
        const origItem = rec.items.find((it) => it.message_id === message_id);
        expect(origItem?.status).toBe('dispatched');
        expect(origItem?.text).toBe('COMPLETE_ME');
        const laterItem = rec.items.find((it) => it.message_id === laterId);
        expect(laterItem?.status).toBe('pending');
        expect(laterItem?.text).toBe(laterText);
      } finally {
        settle?.({ text: 'late', event: { type: 'result', result: 'ok' } });
        await mgr.shutdown();
      }
    }

    // --- disposition under stolen fence ---
    {
      mockSessions = [];
      const mgr = createManager();
      const runId = 'c2a2-fence-dispose';
      const workspace = path.join(TEST_WF_DIR, 'workspaces', runId);
      fs.mkdirSync(workspace, { recursive: true });
      try {
        await mgr.autoloopStart({ runId, workspace });
        const planner = mockSessions[0]!;
        planner.sendImplementation = async () => {
          throw new Error('transport fail');
        };
        await expect(mgr.autoloopChat(runId, 'unc')).rejects.toThrow();
        const live = mgr.getAutoloop(runId)!;
        const pending = live.runner.state.pending_input!;
        const disk = JSON.stringify(loadRun(runId));
        const sendsBefore = mockSessions.reduce((n, s) => n + s.sendCalls.length, 0);
        stealLease(runId);
        await expect(
          mgr.autoloopResume(runId, {
            inputDisposition: {
              ledgerId: pending.ledger_id,
              expectedRevision: pending.revision,
              messageIds: pending.items.map((i) => i.message_id),
              resolution: 'abandon',
            },
          }),
        ).rejects.toThrow();
        expect(JSON.stringify(loadRun(runId))).toBe(disk);
        expect(mockSessions.reduce((n, s) => n + s.sendCalls.length, 0)).toBe(sendsBefore);
        expect(live.runner.hasUncertainItems()).toBe(true);
      } finally {
        await mgr.shutdown();
      }
    }
  });

  it('row4_stale_owner_lease_resume_is_refused_or_safe', async () => {
    const mgr = createManager();
    const runId = 'c2b-stale-lease';
    const workspace = path.join(TEST_WF_DIR, 'workspaces', runId);
    fs.mkdirSync(workspace, { recursive: true });
    try {
      await mgr.autoloopStart({ runId, workspace });
      const disk = JSON.stringify(loadRun(runId));
      const sends = mockSessions.reduce((n, s) => n + s.sendCalls.length, 0);
      staleOwnerLease(runId);
      const diskBefore = JSON.stringify(loadRun(runId));
      let resumeErr: unknown;
      try {
        await mgr.autoloopResume(runId);
      } catch (err) {
        resumeErr = err;
      }
      expect(mockSessions.reduce((n, s) => n + s.sendCalls.length, 0)).toBe(sends);
      if (resumeErr) {
        expect(JSON.stringify(loadRun(runId))).toBe(diskBefore);
      } else {
        expect(JSON.stringify(loadRun(runId))).toBe(disk);
      }
    } finally {
      await mgr.shutdown();
    }
  });
});

describe('2A2 row5 refused writes + real terminal boundaries', () => {
  it('row5_refused_completion_keeps_id_text_blocks_later_pending_zero_followups', async () => {
    let phase = 0;
    const followups: string[] = [];
    let chatAttempts = 0;
    const runner = makeRunner(
      {
        async deliver(env) {
          if (env.type === 'chat') {
            chatAttempts += 1;
            return [Msg.directiveAck(0, { understood: true })];
          }
          followups.push(env.type);
          return [];
        },
      },
      {
        persistCheckpoint: () => {
          phase += 1;
          // accept(1) + markDispatched(2) ok; refuse only completion(3); later accept ok
          return phase !== 3;
        },
      },
    );
    await runner.start();
    const { message_id } = runner.acceptChat('KEEP_TEXT');
    await expect(runner.deliverAccepted(message_id)).rejects.toThrow();
    expect(runner.hasUncertainItems()).toBe(true);
    const item = runner.getCommittedRecovery()!.items[0]!;
    expect(item.message_id).toBe(message_id);
    expect(item.text).toBe('KEEP_TEXT');
    const later = runner.acceptChat('LATER');
    expect(runner.getCommittedRecovery()!.items.some((i) => i.message_id === later.message_id)).toBe(true);
    expect(followups).toEqual([]);
    const chatBeforeLaterDeliver = chatAttempts;
    // Later pending delivery is blocked while uncertain/paused:
    const deliversBefore = followups.length;
    await runner.deliverAccepted(later.message_id);
    expect(chatAttempts).toBe(chatBeforeLaterDeliver);
    expect(followups.length).toBe(deliversBefore);
    expect(runner.getCommittedRecovery()!.items.find((i) => i.message_id === later.message_id)?.status).toBe('pending');
    expect(runner.hasUncertainItems()).toBe(true);
  });

  it('row5_terminate_mid_send_boundary_before_settle_keeps_obligations', async () => {
    let settle!: (v: AnyAutoloopMessage[]) => void;
    const gate = new Promise<AnyAutoloopMessage[]>((r) => {
      settle = r;
    });
    let sendStarted = false;
    const runner = makeRunner(
      {
        async deliver(env) {
          if (env.type !== 'chat') return [];
          sendStarted = true;
          return gate;
        },
      },
      { persistCheckpoint: () => true },
    );
    await runner.start();
    const { message_id } = runner.acceptChat('MID');
    const delivering = runner.deliverAccepted(message_id);
    const start = Date.now();
    while (!sendStarted || !runner.hasUncertainItems()) {
      if (Date.now() - start > 2000) throw new Error('handshake timeout');
      await Promise.resolve();
    }
    expect(runner.getCommittedRecovery()!.items[0]!.status).toBe('dispatched');
    // Msg.terminate cannot drain while deliver awaits; terminate() is the same handler body.
    await terminateNow(runner, 'user-stop');
    expect(runner.state.status).toBe('terminated');
    expect(runner.getCommittedRecovery()?.items.some((i) => i.message_id === message_id)).toBe(true);
    settle([]);
    await delivering.catch(() => undefined);
    expect(runner.getCommittedRecovery()?.items.some((i) => i.message_id === message_id && i.text === 'MID')).toBe(
      true,
    );
  });

  it('row5_hard_deadline_mid_send_keeps_obligations', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    let settle!: (v: AnyAutoloopMessage[]) => void;
    const gate = new Promise<AnyAutoloopMessage[]>((r) => {
      settle = r;
    });
    let sendStarted = false;
    try {
      const runner = makeRunner(
        {
          async deliver(env) {
            if (env.type !== 'chat') return [];
            sendStarted = true;
            return gate;
          },
        },
        { persistCheckpoint: () => true, autoloopHardTimeoutMs: 600_000, activityLeaseMs: 60_000 },
      );
      await runner.start();
      const { message_id } = runner.acceptChat('HD');
      const delivering = runner.deliverAccepted(message_id);
      while (!sendStarted || !runner.hasUncertainItems()) await vi.advanceTimersByTimeAsync(1);
      expect(runner.getCommittedRecovery()!.items[0]!.status).toBe('dispatched');
      await vi.advanceTimersByTimeAsync(600_000);
      expect(runner.state.status).toBe('terminated');
      expect(runner.state.status_reason).toBe('hard_timeout_exceeded');
      expect(runner.getCommittedRecovery()?.items.some((i) => i.message_id === message_id)).toBe(true);
      settle([]);
      await delivering.catch(() => undefined);
      expect(runner.getCommittedRecovery()?.items.some((i) => i.text === 'HD')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('row5_circuit_breaker_mid_send_keeps_obligations', async () => {
    // Representative circuit lifecycle BEFORE a hung mid-send (drain not blocked):
    const runner = makeRunner(
      {
        async deliver() {
          return [];
        },
      },
      { persistCheckpoint: () => true, phaseErrorCircuit: 2 },
    );
    await runner.start();
    const { message_id } = runner.acceptChat('CB_PRE');
    // Mark dispatched via restore so obligations exist, then trip circuit through public send:
    runner.applyRestoredRecovery({
      v: 1,
      gate: { kind: 'input_uncertain' },
      ledger_id: mid(9050),
      revision: 1,
      items: [
        {
          message_id,
          iter: 0,
          ts: ts(),
          accepted_at: ts(),
          text: 'CB_PRE',
          status: 'dispatched',
        },
      ],
      resolved: [],
    });
    await runner.send(Msg.phaseError(0, { agent: 'planner', phase: 'turn', error: 'e1' }));
    await runner.send(Msg.phaseError(0, { agent: 'planner', phase: 'turn', error: 'e2' }));
    expect(runner.state.status).toBe('terminated');
    expect(runner.state.status_reason).toBe('phase_error_circuit');
    expect(runner.getCommittedRecovery()?.items.some((i) => i.message_id === message_id && i.text === 'CB_PRE')).toBe(
      true,
    );
  });

  it('row5_cancel_mid_send_via_terminate_private_reason_control', async () => {
    let settle!: (v: AnyAutoloopMessage[]) => void;
    const gate = new Promise<AnyAutoloopMessage[]>((r) => {
      settle = r;
    });
    let sendStarted = false;
    const runner = makeRunner(
      {
        async deliver(env) {
          if (env.type !== 'chat') return [];
          sendStarted = true;
          return gate;
        },
      },
      { persistCheckpoint: () => true },
    );
    await runner.start();
    const { message_id } = runner.acceptChat('CANCEL_MID');
    const delivering = runner.deliverAccepted(message_id);
    while (!sendStarted || !runner.hasUncertainItems()) await Promise.resolve();
    await terminateNow(runner, 'cancelled');
    expect(runner.state.status).toBe('terminated');
    expect(runner.state.status_reason).toBe('cancelled');
    settle([]);
    await delivering.catch(() => undefined);
    expect(runner.getCommittedRecovery()?.items.some((i) => i.message_id === message_id)).toBe(true);
  });

  it('row5_cancel_mid_send_via_kernel_cancel_keeps_obligations', async () => {
    const mgr = createManager();
    const runId = 'c2b-kernel-cancel';
    const workspace = path.join(TEST_WF_DIR, 'workspaces', runId);
    fs.mkdirSync(workspace, { recursive: true });
    let settleTransport!: (v: TurnResult) => void;
    const transportGate = new Promise<TurnResult>((r) => {
      settleTransport = r;
    });
    let entered = false;
    const followups: string[] = [];
    try {
      await mgr.autoloopStart({ runId, workspace });
      const planner = mockSessions[0]!;
      const live = mgr.getAutoloop(runId)!;
      // Count non-chat follow-ups at the real dispatcher boundary.
      const origDeliver = live.dispatcher.deliver.bind(live.dispatcher);
      live.dispatcher.deliver = async (env: AnyAutoloopMessage) => {
        if (env.type !== 'chat') followups.push(env.type);
        return origDeliver(env);
      };
      planner.sendImplementation = async () => {
        entered = true;
        return transportGate;
      };
      const { message_id: originalId } = live.runner.acceptChat('KERNEL_CANCEL');
      const originalText = 'KERNEL_CANCEL';
      const delivering = live.runner.deliverAccepted(originalId);
      const start = Date.now();
      while (!entered || !live.runner.hasUncertainItems()) {
        if (Date.now() - start > 3000) throw new Error('dispatch handshake timeout');
        await Promise.resolve();
      }
      expect(live.runner.getCommittedRecovery()!.items.find((i) => i.message_id === originalId)?.status).toBe(
        'dispatched',
      );
      const { message_id: laterId } = live.runner.acceptChat('LATER_PAUSE');
      const laterText = 'LATER_PAUSE';
      expect(
        live.runner.getCommittedRecovery()!.items.some((i) => i.message_id === laterId && i.text === laterText),
      ).toBe(true);
      expect(followups).toEqual([]);
      const chatSendsBeforeLater = planner.sendCalls.length;
      await live.runner.deliverAccepted(laterId);
      expect(planner.sendCalls.length).toBe(chatSendsBeforeLater);
      const cancel = mgr.workflowCancel(runId);
      expect(cancel.cancelled).toBe(true);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const liveHandle = (mgr as any).kernel.live.get(runId);
      expect(liveHandle?.signal.aborted).toBe(true);
      expect(live.runner.hasUncertainItems()).toBe(true);
      expect(
        live.runner
          .getCommittedRecovery()
          ?.items.some((i) => i.message_id === originalId && i.text === originalText && i.status === 'dispatched'),
      ).toBe(true);
      // Settle AFTER abort confirmation — postconditions below must run after this.
      settleTransport({ text: 'late', event: { type: 'result', result: 'ok' } });
      let deliveryOutcome: 'resolved' | 'rejected' = 'resolved';
      let deliveryErr: unknown;
      try {
        await delivering;
      } catch (err) {
        deliveryOutcome = 'rejected';
        deliveryErr = err;
      }
      expect(deliveryOutcome).toBe('resolved');
      expect(deliveryErr).toBeUndefined();
      expect(followups).toEqual([]);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (mgr as any).kernel.wait(runId);
      expect(followups).toEqual([]);
      const finalRec = loadRun(runId)!;
      expect(finalRec.state).toBe('cancelled');
      expect(finalRec.nodes.main?.state).toBe('cancelled');
      const finalData = finalRec.nodes.main?.data as { recovery?: unknown; state?: { status?: string } };
      const finalRecovery = validateRecoveryField(finalData.recovery);
      expect(finalRecovery).toBeTruthy();
      const origFinal = finalRecovery!.items.find((i) => i.message_id === originalId);
      expect(origFinal?.text).toBe(originalText);
      expect(origFinal?.status).toBe('dispatched');
      const laterFinal = finalRecovery!.items.find((i) => i.message_id === laterId);
      expect(laterFinal?.text).toBe(laterText);
      expect(laterFinal?.status).toBe('pending');
      // Live committed ledger agrees with final persisted obligations.
      const liveRec = live.runner.getCommittedRecovery()!;
      expect(liveRec.items.find((i) => i.message_id === originalId)?.text).toBe(originalText);
      expect(liveRec.items.find((i) => i.message_id === originalId)?.status).toBe('dispatched');
      expect(liveRec.items.find((i) => i.message_id === laterId)?.text).toBe(laterText);
      expect(liveRec.items.find((i) => i.message_id === laterId)?.status).toBe('pending');
      const chatAfterCancel = planner.sendCalls.length;
      await live.runner.deliverAccepted(laterId);
      expect(planner.sendCalls.length).toBe(chatAfterCancel);
      expect(followups).toEqual([]);
    } finally {
      settleTransport?.({ text: 'late', event: { type: 'result', result: 'ok' } });
      await mgr.shutdown();
    }
  });

  it('row5_direct_kernel_cancel_settles_before_observer_keeps_obligations', async () => {
    const mgr = createManager();
    const runId = 'c2b-direct-kernel-cancel';
    const workspace = path.join(TEST_WF_DIR, 'workspaces', runId);
    fs.mkdirSync(workspace, { recursive: true });
    let settleTransport!: (v: TurnResult) => void;
    const transportGate = new Promise<TurnResult>((r) => {
      settleTransport = r;
    });
    let entered = false;
    const followups: string[] = [];
    try {
      await mgr.autoloopStart({ runId, workspace });
      const planner = mockSessions[0]!;
      const live = mgr.getAutoloop(runId)!;
      const origDeliver = live.dispatcher.deliver.bind(live.dispatcher);
      live.dispatcher.deliver = async (env: AnyAutoloopMessage) => {
        if (env.type !== 'chat') followups.push(env.type);
        return origDeliver(env);
      };
      planner.sendImplementation = async () => {
        entered = true;
        return transportGate;
      };
      const { message_id: originalId } = live.runner.acceptChat('KERNEL_CANCEL_DIRECT');
      const originalText = 'KERNEL_CANCEL_DIRECT';
      const delivering = live.runner.deliverAccepted(originalId);
      const start = Date.now();
      while (!entered || !live.runner.hasUncertainItems()) {
        if (Date.now() - start > 3000) throw new Error('dispatch handshake timeout');
        await Promise.resolve();
      }
      expect(live.runner.getCommittedRecovery()!.items.find((i) => i.message_id === originalId)?.status).toBe(
        'dispatched',
      );
      const { message_id: laterId } = live.runner.acceptChat('LATER_PAUSE_DIRECT');
      const laterText = 'LATER_PAUSE_DIRECT';
      expect(
        live.runner.getCommittedRecovery()!.items.some((i) => i.message_id === laterId && i.text === laterText),
      ).toBe(true);
      expect(followups).toEqual([]);
      const chatSendsBeforeLater = planner.sendCalls.length;
      await live.runner.deliverAccepted(laterId);
      expect(planner.sendCalls.length).toBe(chatSendsBeforeLater);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cancelled = (mgr as any).kernel.cancel(runId);
      expect(cancelled).toBe(true);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const liveHandle = (mgr as any).kernel.live.get(runId);
      expect(liveHandle?.signal.aborted).toBe(true);
      expect(live.runner.hasUncertainItems()).toBe(true);
      expect(
        live.runner
          .getCommittedRecovery()
          ?.items.some((i) => i.message_id === originalId && i.text === originalText && i.status === 'dispatched'),
      ).toBe(true);
      settleTransport({ text: 'late', event: { type: 'result', result: 'ok' } });
      let deliveryOutcome: 'resolved' | 'rejected' = 'resolved';
      let deliveryErr: unknown;
      try {
        await delivering;
      } catch (err) {
        deliveryOutcome = 'rejected';
        deliveryErr = err;
      }
      expect(deliveryOutcome).toBe('resolved');
      expect(deliveryErr).toBeUndefined();
      expect(followups).toEqual([]);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (mgr as any).kernel.wait(runId);
      expect(followups).toEqual([]);
      const finalRec = loadRun(runId)!;
      expect(finalRec.state).toBe('cancelled');
      expect(finalRec.nodes.main?.state).toBe('cancelled');
      const finalData = finalRec.nodes.main?.data as { recovery?: unknown; state?: { status?: string } };
      const finalRecovery = validateRecoveryField(finalData.recovery);
      expect(finalRecovery).toBeTruthy();
      const origFinal = finalRecovery!.items.find((i) => i.message_id === originalId);
      expect(origFinal?.text).toBe(originalText);
      expect(origFinal?.status).toBe('dispatched');
      const laterFinal = finalRecovery!.items.find((i) => i.message_id === laterId);
      expect(laterFinal?.text).toBe(laterText);
      expect(laterFinal?.status).toBe('pending');
      const liveRec = live.runner.getCommittedRecovery()!;
      expect(liveRec.items.find((i) => i.message_id === originalId)?.text).toBe(originalText);
      expect(liveRec.items.find((i) => i.message_id === originalId)?.status).toBe('dispatched');
      expect(liveRec.items.find((i) => i.message_id === laterId)?.text).toBe(laterText);
      expect(liveRec.items.find((i) => i.message_id === laterId)?.status).toBe('pending');
      const chatAfterCancel = planner.sendCalls.length;
      await live.runner.deliverAccepted(laterId);
      expect(planner.sendCalls.length).toBe(chatAfterCancel);
      expect(followups).toEqual([]);
    } finally {
      settleTransport?.({ text: 'late', event: { type: 'result', result: 'ok' } });
      await mgr.shutdown();
    }
  });

  it('row5_control_completed_turn_before_queued_soft_stop_may_complete', async () => {
    const runner = makeRunner(
      {
        async deliver(env) {
          if (env.type === 'chat') return [];
          return [];
        },
      },
      { persistCheckpoint: () => true },
    );
    await runner.start();
    const { message_id } = runner.acceptChat('DONE');
    await runner.deliverAccepted(message_id);
    expect(runner.getCommittedRecovery()?.items.some((i) => i.message_id === message_id)).toBe(false);
    await runner.send(Msg.terminate(0, { reason: 'after-complete' }));
    expect(runner.state.status).toBe('terminated');
  });

  it('row5_executor_final_node_data_overwrite_boundary_on_terminal', async () => {
    const mgr = createManager();
    const runId = 'c2a2-final-data';
    const workspace = path.join(TEST_WF_DIR, 'workspaces', runId);
    fs.mkdirSync(workspace, { recursive: true });
    try {
      await mgr.autoloopStart({ runId, workspace });
      mockSessions[0]!.sendImplementation = async () => {
        throw new Error('transport fail');
      };
      await expect(mgr.autoloopChat(runId, 'FINAL_BOUND')).rejects.toThrow();
      const live = mgr.getAutoloop(runId)!;
      const before = JSON.stringify(live.runner.getCommittedRecovery());
      expect(live.runner.hasUncertainItems()).toBe(true);
      await mgr.autoloopStop(runId, 'stop');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (mgr as any).kernel.wait(runId);
      const rec = loadRun(runId)!;
      expect(rec.state === 'completed' || rec.state === 'failed' || rec.state === 'cancelled').toBe(true);
      const data = rec.nodes.main?.data as { recovery?: unknown; state?: { status?: string } };
      expect(data.state?.status).toBe('terminated');
      // Causal: final node payload must still carry the uncertain ledger (or report wipe).
      expect(JSON.stringify(data.recovery)).toBe(before);
    } finally {
      await mgr.shutdown();
    }
  });
});

describe('2A2 row6 owned child mid-send', () => {
  it('row6_mid_send_kill_zero_replay_held_pending_then_dispose_deliver_once', async () => {
    const runId = 'c2a2-midsend';
    const workspace = trackTmp(fs.mkdtempSync(path.join(os.tmpdir(), 'clawo-c2a2-ms-ws-')));
    initGitWorkspace(workspace);
    const wf = trackTmp(fs.mkdtempSync(path.join(os.tmpdir(), 'clawo-c2a2-ms-wf-')));
    const home = trackTmp(fs.mkdtempSync(path.join(os.tmpdir(), 'clawo-c2a2-ms-home-')));
    const sess = trackTmp(fs.mkdtempSync(path.join(os.tmpdir(), 'clawo-c2a2-ms-sess-')));
    const prevWf = process.env.CLAWO_WF_DIR;
    const prevSess = process.env.CLAWO_SESSIONS_DIR;
    let proc: ChildProcess | null = null;
    let mgr: InstanceType<typeof SessionManager> | null = null;
    let mgr2: InstanceType<typeof SessionManager> | null = null;
    try {
      proc = spawn(process.execPath, ['--import', 'tsx', OWNER_CHILD], {
        env: {
          ...process.env,
          AUTOLOOP_MODE: 'hung-planner-send',
          AUTOLOOP_RUN_ID: runId,
          AUTOLOOP_WORKSPACE: workspace,
          CLAWO_WF_DIR: wf,
          CLAWO_SESSIONS_DIR: sess,
          HOME: home,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      await waitReady(proc);
      proc.kill('SIGKILL');
      await new Promise<void>((r) => proc!.on('exit', () => r()));
      proc = null;

      process.env.CLAWO_WF_DIR = wf;
      mgr = createManager();
      mockSessions = [];
      patch(mgr);
      await mgr.autoloopResume(runId);
      const handle = mgr.getAutoloop(runId)!;
      expect(handle.runner.hasUncertainItems()).toBe(true);
      const originalText = handle.runner.getCommittedRecovery()!.items.find((i) => i.status === 'dispatched')!.text;
      const sendsAtReconstruct = mockSessions[0]?.sendCalls.length ?? 0;
      // Zero replay of original before disposition:
      const replay = (mockSessions[0]?.sendCalls ?? [])
        .map((c) => (typeof c.message === 'string' ? c.message : ''))
        .filter((t) => t === originalText);
      expect(replay).toEqual([]);
      await expect(mgr.autoloopResume(runId)).rejects.toThrow(/input_disposition_required/);
      await mgr.autoloopChat(runId, 'later-pending');
      expect(handle.runner.state.status).toBe('paused');
      expect(handle.runner.state.pending_input?.items.some((i) => i.status === 'pending')).toBe(true);
      const planner = mockSessions[0]!;
      // BEFORE disposition: zero physical later-pending sends and zero original replay:
      expect(
        planner.sendCalls
          .map((c) => (typeof c.message === 'string' ? c.message : ''))
          .filter((t) => t === 'later-pending'),
      ).toEqual([]);
      expect(
        planner.sendCalls
          .map((c) => (typeof c.message === 'string' ? c.message : ''))
          .filter((t) => t === originalText),
      ).toEqual([]);
      const pending = handle.runner.state.pending_input!;
      const body = {
        ledgerId: pending.ledger_id,
        expectedRevision: pending.revision,
        messageIds: pending.items.filter((i) => i.status === 'uncertain').map((i) => i.message_id),
        resolution: 'abandon' as const,
      };
      await mgr.autoloopResume(runId, { inputDisposition: { ...body } });
      // F7 original-body retry is a successful no-op:
      await expect(mgr.autoloopResume(runId, { inputDisposition: { ...body } })).resolves.toBeTruthy();
      await vi.waitFor(() => {
        const texts = planner.sendCalls.map((c) => (typeof c.message === 'string' ? c.message : ''));
        expect(texts.filter((t) => t === 'later-pending')).toEqual(['later-pending']);
        expect(texts.filter((t) => t === originalText)).toEqual([]);
      });
      expect(planner.sendCalls.length).toBeGreaterThan(sendsAtReconstruct);
      await mgr.autoloopStop(runId, 'stop');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (mgr as any).kernel.wait(runId);
      await mgr.shutdown();
      mgr = null;

      mgr2 = createManager();
      mockSessions = [];
      patch(mgr2);
      await mgr2.autoloopResume(runId);
      // Meaningful bootstrap: ordinary resume must not require disposition; drain settles.
      await mgr2.autoloopResume(runId);
      const p2 = mockSessions[0]!;
      const handle2 = mgr2.getAutoloop(runId)!;
      const QUEUE_SENTINEL = 'C2C_QUEUE_SENTINEL_BARRIER_2C';
      p2.sendImplementation = async () => ({ text: 'ok', event: { type: 'result', result: 'ok' } });
      const { message_id: sentinelId } = handle2.runner.acceptChat(QUEUE_SENTINEL);
      await handle2.runner.deliverAccepted(sentinelId);
      await vi.waitFor(() => {
        const texts = p2.sendCalls.map((c) => (typeof c.message === 'string' ? c.message : ''));
        expect(texts.filter((t) => t === QUEUE_SENTINEL)).toEqual([QUEUE_SENTINEL]);
      });
      const texts2 = p2.sendCalls.map((c) => (typeof c.message === 'string' ? c.message : ''));
      expect(texts2.filter((t) => t === originalText || t === 'later-pending')).toEqual([]);
    } finally {
      if (proc) {
        try {
          if (!proc.killed) proc.kill('SIGKILL');
        } catch {
          /* ignore */
        }
        await new Promise<void>((r) => {
          if (proc!.exitCode !== null || proc!.signalCode) r();
          else proc!.once('exit', () => r());
        });
        proc = null;
      }
      if (mgr) await mgr.shutdown().catch(() => undefined);
      if (mgr2) await mgr2.shutdown().catch(() => undefined);
      if (prevWf === undefined) delete process.env.CLAWO_WF_DIR;
      else process.env.CLAWO_WF_DIR = prevWf;
      if (prevSess === undefined) delete process.env.CLAWO_SESSIONS_DIR;
      else process.env.CLAWO_SESSIONS_DIR = prevSess;
    }
  }, 90_000);
});

describe('2A2 row7 no-ledger pause, activity-lease, legacy, malformed manager', () => {
  it('row7_operator_pause_without_prior_chat_stores_gate_survives_reconstruct', async () => {
    const mgr = createManager();
    const runId = 'c2a2-noleger-pause';
    const workspace = path.join(TEST_WF_DIR, 'workspaces', runId);
    fs.mkdirSync(workspace, { recursive: true });
    try {
      await mgr.autoloopStart({ runId, workspace });
      const handle = mgr.getAutoloop(runId)!;
      expect(handle.runner.getCommittedRecovery()).toBeNull();
      // No autoloopChat — inject typed pause on runner.
      await handle.runner.send(Msg.pause(0, { reason: 'operator-hold' }));
      expect(handle.runner.state.status).toBe('paused');
      expect(handle.runner.getCommittedRecovery()?.gate?.kind).toBe('operator_pause');
      await mgr.autoloopStop(runId, 'stop');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (mgr as any).kernel.wait(runId);
      await mgr.shutdown();
      const mgr2 = createManager();
      try {
        await mgr2.autoloopResume(runId);
        const h2 = mgr2.getAutoloop(runId)!;
        expect(h2.runner.state.status).toBe('paused');
        expect(h2.runner.getCommittedRecovery()?.gate?.kind).toBe('operator_pause');
        await mgr2.autoloopResume(runId);
        expect(['planning', 'running']).toContain(h2.runner.state.status);
      } finally {
        await mgr2.shutdown();
      }
    } finally {
      await mgr.shutdown().catch(() => undefined);
    }
  });

  it('row7_activity_lease_pause_before_any_chat', async () => {
    // Store + reconstruct activity_lease gate before any chat (manager path).
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const mgr = createManager();
    const runId = 'c2b-lease';
    const workspace = path.join(TEST_WF_DIR, 'workspaces', runId);
    fs.mkdirSync(workspace, { recursive: true });
    try {
      await mgr.autoloopStart({
        runId,
        workspace,
        activityLeaseMs: 60_000,
        autoloopHardTimeoutMs: 600_000,
      });
      const handle = mgr.getAutoloop(runId)!;
      expect(handle.runner.getCommittedRecovery()).toBeNull();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(handle.runner.state.status).toBe('paused');
      expect(handle.runner.getCommittedRecovery()?.gate?.kind).toBe('activity_lease');
      await mgr.autoloopStop(runId, 'stop');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (mgr as any).kernel.wait(runId);
      await mgr.shutdown();
      vi.useRealTimers();
      const mgr2 = createManager();
      try {
        await mgr2.autoloopResume(runId);
        const h2 = mgr2.getAutoloop(runId)!;
        expect(h2.runner.state.status).toBe('paused');
        expect(h2.runner.getCommittedRecovery()?.gate?.kind).toBe('activity_lease');
      } finally {
        await mgr2.shutdown();
      }
    } finally {
      vi.useRealTimers();
      await mgr.shutdown().catch(() => undefined);
    }
  });

  it('row7_legacy_absent_recovery_via_manager', async () => {
    const mgr = createManager();
    const runId = 'c2a2-legacy';
    const workspace = path.join(TEST_WF_DIR, 'workspaces', runId);
    fs.mkdirSync(workspace, { recursive: true });
    try {
      await mgr.autoloopStart({ runId, workspace });
      expect(mgr.getAutoloop(runId)!.runner.getCommittedRecovery()).toBeNull();
      await mgr.autoloopStop(runId, 'stop');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (mgr as any).kernel.wait(runId);
      await mgr.shutdown();
      const mgr2 = createManager();
      try {
        await mgr2.autoloopResume(runId);
        expect(mgr2.getAutoloop(runId)!.runner.getCommittedRecovery()).toBeNull();
      } finally {
        await mgr2.shutdown();
      }
    } finally {
      await mgr.shutdown().catch(() => undefined);
    }
  });

  it('row7_malformed_ondisk_refused_by_manager_before_session_zero_effects', async () => {
    const mgr = createManager();
    const runId = 'c2a2-malformed';
    const workspace = path.join(TEST_WF_DIR, 'workspaces', runId);
    fs.mkdirSync(workspace, { recursive: true });
    try {
      await mgr.autoloopStart({ runId, workspace });
      await mgr.autoloopStop(runId, 'stop');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (mgr as any).kernel.wait(runId);
      const rec = loadRun(runId)!;
      const sentinel = 'BAD_SECRET_sk-CANARY_password';
      const data = {
        ...(rec.nodes.main?.data as object),
        recovery: {
          v: 1,
          ledger_id: 'not-a-uuid',
          revision: 0,
          gate: null,
          items: [],
          resolved: [],
          // Extra noise the schema must refuse; sentinel must not be echoed:
          _echo: sentinel,
        },
      };
      const runJson = path.join(runDir(runId), 'run.json');
      const raw = JSON.parse(fs.readFileSync(runJson, 'utf8')) as {
        nodes: { main: { data: Record<string, unknown> } };
      };
      raw.nodes.main.data = data as Record<string, unknown>;
      fs.writeFileSync(runJson, JSON.stringify(raw));
      await mgr.shutdown();
      mockSessions = [];
      const mgr2 = createManager();
      const sessionsBefore = mockSessions.length;
      const sendsBefore = 0;
      try {
        let thrown: unknown;
        try {
          await mgr2.autoloopResume(runId);
        } catch (err) {
          thrown = err;
        }
        expect(thrown).toBeTruthy();
        expect(String(thrown)).not.toContain(sentinel);
        expect(String(thrown)).not.toMatch(/BAD_SECRET|sk-CANARY|password/i);
        expect(mockSessions.length).toBe(sessionsBefore);
        expect(mockSessions.reduce((n, s) => n + s.sendCalls.length, 0)).toBe(sendsBefore);
        const errText = String(errorLogs.flat().join(' '));
        expect(errText).not.toContain(sentinel);
        expect(errText).not.toMatch(/BAD_SECRET|sk-CANARY/i);
      } finally {
        await mgr2.shutdown();
      }
    } finally {
      await mgr.shutdown().catch(() => undefined);
    }
  });
});

describe('2A2 row8 dispatcher timeout reconstruction branches', () => {
  function snap(
    runId: string,
    runner: AutoloopRunner,
    sends: number,
    entries: number,
  ): {
    disk: string;
    status: string;
    reason: string | null | undefined;
    gate: string | null;
    pending: string | null | undefined;
    sends: number;
    entries: number;
  } {
    return {
      disk: JSON.stringify(loadRun(runId)),
      status: runner.state.status,
      reason: runner.state.status_reason,
      gate: runner.getCommittedRecovery()?.gate?.kind ?? null,
      pending: runner.state.pending_dispatch?.dispatch_id ?? null,
      sends,
      entries,
    };
  }
  function expectFrozen(a: ReturnType<typeof snap>, b: ReturnType<typeof snap>): void {
    expect(b).toEqual(a);
  }

  it('row8_live_timeout_refusals_plus_lease_checkpoint_and_stop_clear_reconstruct', async () => {
    const mgr = createManager();
    const runId = 'c2b-timeout';
    const workspace = path.join(TEST_WF_DIR, 'workspaces', runId);
    fs.mkdirSync(workspace, { recursive: true });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mgrAny = mgr as any;
    const orig = mgrAny.sendMessage.bind(mgr);
    let sendMessageEntryCount = 0;
    mgrAny.sendMessage = async (...args: unknown[]) => {
      sendMessageEntryCount += 1;
      if (String(args[0] ?? '').includes('-planner')) {
        throw new Error('Timeout waiting for response');
      }
      return orig(...args);
    };
    const staleDispatchId = `dispatch_${'c'.repeat(64)}`;
    try {
      await mgr.autoloopStart({ runId, workspace, sendTimeoutMs: 600_000 });
      await mgr.autoloopChat(runId, 'TIMEOUT_CHAT').catch(() => undefined);
      const handle = mgr.getAutoloop(runId)!;
      expect(handle.runner.state.pending_dispatch).toBeTruthy();
      const dispatchId = handle.runner.state.pending_dispatch!.dispatch_id;
      expect(dispatchId).toMatch(/^dispatch_[a-f0-9]{64}$/);
      const entryAfterTimeout = sendMessageEntryCount;
      expect(entryAfterTimeout).toBeGreaterThan(0);
      const pendingInput = handle.runner.state.pending_input!;
      const refusalAttempts: Array<() => Promise<unknown>> = [
        () => mgr.autoloopResume(runId, { sendTimeoutMs: 600_000, pendingDispatchId: dispatchId }),
        () => mgr.autoloopResume(runId, { sendTimeoutMs: 500_000, pendingDispatchId: dispatchId }),
        () => mgr.autoloopResume(runId, { sendTimeoutMs: 700_000, pendingDispatchId: 'wrong' }),
        () => mgr.autoloopResume(runId, { sendTimeoutMs: 700_000, pendingDispatchId: staleDispatchId }),
        () =>
          mgr.autoloopResume(runId, {
            sendTimeoutMs: 700_000,
            pendingDispatchId: dispatchId,
            inputDisposition: {
              ledgerId: mid(1),
              expectedRevision: 0,
              messageIds: [mid(2)],
              resolution: 'abandon',
            },
          }),
        () =>
          mgr.autoloopResume(runId, {
            inputDisposition: {
              ledgerId: pendingInput.ledger_id,
              expectedRevision: pendingInput.revision,
              messageIds: pendingInput.items.filter((i) => i.status === 'uncertain').map((i) => i.message_id),
              resolution: 'abandon',
            },
          }),
      ];
      for (const attempt of refusalAttempts) {
        const sendsNow = mockSessions[0]!.sendCalls.length;
        const before = snap(runId, handle.runner, sendsNow, sendMessageEntryCount);
        await expect(attempt()).rejects.toThrow();
        const after = snap(runId, handle.runner, mockSessions[0]!.sendCalls.length, sendMessageEntryCount);
        expectFrozen(before, after);
      }
      const sendsAfterNegatives = mockSessions[0]!.sendCalls.length;
      await mgr.autoloopResume(runId, { sendTimeoutMs: 700_000, pendingDispatchId: dispatchId });
      expect(handle.runner.state.pending_dispatch).toBeNull();
      expect(handle.runner.hasUncertainItems()).toBe(false);
      expect(
        handle.runner.getCommittedRecovery()?.resolved.some((t) => t.resolution === 'advanced_after_timeout'),
      ).toBe(true);
      expect(mockSessions[0]!.sendCalls.length).toBe(sendsAfterNegatives);
      expect(sendMessageEntryCount).toBe(entryAfterTimeout);
    } finally {
      mgrAny.sendMessage = orig;
      await mgr.shutdown().catch(() => undefined);
    }

    // LEASE/CHECKPOINT owner-loss (stale lease, not child death) preserves genuine pending_dispatch:
    const mgrOwner = createManager();
    const runId2 = 'c2b-timeout-ownerloss';
    const ws2 = path.join(TEST_WF_DIR, 'workspaces', runId2);
    fs.mkdirSync(ws2, { recursive: true });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ownerAny = mgrOwner as any;
    const orig2 = ownerAny.sendMessage.bind(mgrOwner);
    let ownerSendMessageEntryCount = 0;
    ownerAny.sendMessage = async (...args: unknown[]) => {
      ownerSendMessageEntryCount += 1;
      if (String(args[0] ?? '').includes('-planner')) throw new Error('Timeout waiting for response');
      return orig2(...args);
    };
    let ownerDispatchId = '';
    let ownerMessageId = '';
    let ownerEntriesAtTimeout = 0;
    try {
      await mgrOwner.autoloopStart({ runId: runId2, workspace: ws2, sendTimeoutMs: 600_000 });
      await mgrOwner.autoloopChat(runId2, 'OWNER_LOSS_CHAT').catch(() => undefined);
      const ownerLive = mgrOwner.getAutoloop(runId2)!;
      ownerDispatchId = ownerLive.runner.state.pending_dispatch!.dispatch_id;
      ownerMessageId = ownerLive.runner
        .getCommittedRecovery()!
        .items.find((it) => it.text === 'OWNER_LOSS_CHAT')!.message_id;
      ownerEntriesAtTimeout = ownerSendMessageEntryCount;
      expect(ownerDispatchId).toMatch(/^dispatch_[a-f0-9]{64}$/);
      staleOwnerLease(runId2);
      await mgrOwner.shutdown().catch(() => undefined);
    } finally {
      ownerAny.sendMessage = orig2;
      await mgrOwner.shutdown().catch(() => undefined);
    }
    mockSessions = [];
    const mgr3 = createManager();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mgr3Any = mgr3 as any;
    const orig3sm = mgr3Any.sendMessage.bind(mgr3);
    let ownerReconstructSendEntries = 0;
    mgr3Any.sendMessage = async (...args: unknown[]) => {
      ownerReconstructSendEntries += 1;
      if (String(args[0] ?? '').includes('-planner')) throw new Error('Timeout waiting for response');
      return orig3sm(...args);
    };
    try {
      expect(ownerSendMessageEntryCount).toBeGreaterThan(0);
      await mgr3.autoloopResume(runId2);
      const h3 = mgr3.getAutoloop(runId2)!;
      expect(h3.runner.state.pending_dispatch?.dispatch_id).toBe(ownerDispatchId);
      expect(ownerReconstructSendEntries).toBe(0);
      const sends3 = mockSessions.reduce((n, s) => n + s.sendCalls.length, 0);
      await mgr3.autoloopResume(runId2, { sendTimeoutMs: 800_000, pendingDispatchId: ownerDispatchId });
      expect(h3.runner.state.pending_dispatch).toBeNull();
      expect(h3.runner.hasUncertainItems()).toBe(false);
      expect(
        h3.runner
          .getCommittedRecovery()
          ?.resolved.some((t) => t.resolution === 'advanced_after_timeout' && t.message_id === ownerMessageId),
      ).toBe(true);
      expect(h3.runner.getCommittedRecovery()?.gate).toBeNull();
      expect(mockSessions.reduce((n, s) => n + s.sendCalls.length, 0)).toBe(sends3);
      expect(ownerReconstructSendEntries).toBe(0);
      expect(ownerSendMessageEntryCount).toBe(ownerEntriesAtTimeout);
      for (const s of mockSessions) {
        for (const call of s.sendCalls) {
          expect(String(call.message)).not.toContain('OWNER_LOSS_CHAT');
        }
      }
      mgr3Any.sendMessage = orig3sm;
      const ownerPlanner = mockSessions[0]!;
      const OWNER_SENTINEL = 'C2E_OWNER_SENTINEL';
      const sendsBeforeOwnerSentinel = mockSessions.reduce((n, sess) => n + sess.sendCalls.length, 0);
      ownerPlanner.sendImplementation = async () => ({ text: 'ok', event: { type: 'result', result: 'ok' } });
      const { message_id: ownerSentinelId } = h3.runner.acceptChat(OWNER_SENTINEL);
      await h3.runner.deliverAccepted(ownerSentinelId);
      await vi.waitFor(() => {
        const texts = ownerPlanner.sendCalls.map((c) => (typeof c.message === 'string' ? c.message : ''));
        expect(texts.filter((t) => t === OWNER_SENTINEL)).toEqual([OWNER_SENTINEL]);
        expect(h3.runner.getCommittedRecovery()?.items.some((i) => i.message_id === ownerSentinelId)).toBe(false);
      });
      const ownerTexts = ownerPlanner.sendCalls.map((c) => (typeof c.message === 'string' ? c.message : ''));
      expect(ownerTexts.filter((t) => t === OWNER_SENTINEL)).toEqual([OWNER_SENTINEL]);
      expect(ownerTexts.filter((t) => t === 'OWNER_LOSS_CHAT')).toEqual([]);
      expect(mockSessions.reduce((n, sess) => n + sess.sendCalls.length, 0)).toBe(sendsBeforeOwnerSentinel + 1);
      expect(ownerReconstructSendEntries).toBe(0);
    } finally {
      mgr3Any.sendMessage = orig3sm;
      await mgr3.shutdown();
    }

    // Stop-cleared pending → targeted disposition with REAL dispatcher id:
    const mgrStop = createManager();
    const runId3 = 'c2b-timeout-stopclear';
    const ws3 = path.join(TEST_WF_DIR, 'workspaces', runId3);
    fs.mkdirSync(ws3, { recursive: true });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stopAny = mgrStop as any;
    const orig3 = stopAny.sendMessage.bind(mgrStop);
    let stopSendMessageEntryCount = 0;
    stopAny.sendMessage = async (...args: unknown[]) => {
      stopSendMessageEntryCount += 1;
      if (String(args[0] ?? '').includes('-planner')) throw new Error('Timeout waiting for response');
      return orig3(...args);
    };
    let stopEntriesAtTimeout = 0;
    try {
      await mgrStop.autoloopStart({ runId: runId3, workspace: ws3, sendTimeoutMs: 600_000 });
      await mgrStop.autoloopChat(runId3, 'STOP_CLEAR_CHAT').catch(() => undefined);
      stopEntriesAtTimeout = stopSendMessageEntryCount;
      expect(mgrStop.getAutoloop(runId3)!.runner.state.pending_dispatch).toBeTruthy();
      await mgrStop.autoloopStop(runId3, 'stop');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (mgrStop as any).kernel.wait(runId3);
      await mgrStop.shutdown();
    } finally {
      stopAny.sendMessage = orig3;
      await mgrStop.shutdown().catch(() => undefined);
    }
    mockSessions = [];
    const mgr4 = createManager();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mgr4Any = mgr4 as any;
    const orig4sm = mgr4Any.sendMessage.bind(mgr4);
    let stopReconstructSendEntries = 0;
    mgr4Any.sendMessage = async (...args: unknown[]) => {
      stopReconstructSendEntries += 1;
      return orig4sm(...args);
    };
    try {
      expect(stopSendMessageEntryCount).toBe(stopEntriesAtTimeout);
      await mgr4.autoloopResume(runId3);
      expect(stopReconstructSendEntries).toBe(0);
      const h4 = mgr4.getAutoloop(runId3)!;
      expect(h4.runner.state.pending_dispatch).toBeNull();
      expect(h4.runner.hasUncertainItems()).toBe(true);
      const item = h4.runner.getCommittedRecovery()!.items.find((i) => i.status === 'dispatched')!;
      expect(item.dispatch_id).toMatch(/^dispatch_[a-f0-9]{64}$/);
      const p = h4.runner.state.pending_input!;
      const sends4 = mockSessions.reduce((n, s) => n + s.sendCalls.length, 0);
      const entriesBeforeDispose = stopReconstructSendEntries;
      await mgr4.autoloopResume(runId3, {
        inputDisposition: {
          ledgerId: p.ledger_id,
          expectedRevision: p.revision,
          messageIds: p.items.filter((i) => i.status === 'uncertain').map((i) => i.message_id),
          resolution: 'abandon',
        },
      });
      expect(h4.runner.hasUncertainItems()).toBe(false);
      expect(h4.runner.getCommittedRecovery()?.resolved.some((t) => t.resolution === 'abandon')).toBe(true);
      expect(mockSessions.reduce((n, s) => n + s.sendCalls.length, 0)).toBe(sends4);
      expect(stopReconstructSendEntries).toBe(entriesBeforeDispose);
      for (const s of mockSessions) {
        for (const call of s.sendCalls) {
          expect(String(call.message)).not.toContain('STOP_CLEAR_CHAT');
        }
      }
      mgr4Any.sendMessage = orig4sm;
      const stopPlanner = mockSessions[0]!;
      const STOP_SENTINEL = 'C2E_STOP_SENTINEL';
      const sendsBeforeStopSentinel = mockSessions.reduce((n, sess) => n + sess.sendCalls.length, 0);
      stopPlanner.sendImplementation = async () => ({ text: 'ok', event: { type: 'result', result: 'ok' } });
      const { message_id: stopSentinelId } = h4.runner.acceptChat(STOP_SENTINEL);
      await h4.runner.deliverAccepted(stopSentinelId);
      await vi.waitFor(() => {
        const texts = stopPlanner.sendCalls.map((c) => (typeof c.message === 'string' ? c.message : ''));
        expect(texts.filter((t) => t === STOP_SENTINEL)).toEqual([STOP_SENTINEL]);
        expect(h4.runner.getCommittedRecovery()?.items.some((i) => i.message_id === stopSentinelId)).toBe(false);
      });
      const stopTexts = stopPlanner.sendCalls.map((c) => (typeof c.message === 'string' ? c.message : ''));
      expect(stopTexts.filter((t) => t === STOP_SENTINEL)).toEqual([STOP_SENTINEL]);
      expect(stopTexts.filter((t) => t === 'STOP_CLEAR_CHAT')).toEqual([]);
      expect(mockSessions.reduce((n, sess) => n + sess.sendCalls.length, 0)).toBe(sendsBeforeStopSentinel + 1);
      expect(stopReconstructSendEntries).toBe(entriesBeforeDispose);
    } finally {
      mgr4Any.sendMessage = orig4sm;
      await mgr4.shutdown();
    }
  });
});

describe('2A2 row9 production error listener', () => {
  it('row9_production_listener_depth_once_and_negatives_via_listener', async () => {
    const mgr = createManager();
    const runId = 'c2b-depth';
    const workspace = path.join(TEST_WF_DIR, 'workspaces', runId);
    fs.mkdirSync(workspace, { recursive: true });
    const unhandled: unknown[] = [];
    const onUnhandled = (r: unknown) => unhandled.push(r);
    process.on('unhandledRejection', onUnhandled);
    try {
      await mgr.autoloopStart({ runId, workspace });
      const handle = mgr.getAutoloop(runId)!;
      // Real depth failure on THIS manager's runner → production void.catch listener.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const live = handle.runner as any;
      live.config.maxDispatchDepth = 2;
      const origDeliver = live.config.dispatcher.deliver.bind(live.config.dispatcher);
      let hops = 0;
      live.config.dispatcher.deliver = async (env: AnyAutoloopMessage) => {
        if (env.type === 'chat' && hops++ < 8) {
          return [Msg.chat(env.iter, { text: `pong-${hops}` })];
        }
        return origDeliver(env);
      };
      errorLogs.length = 0;
      const sendsBefore = mockSessions.reduce((n, s) => n + s.sendCalls.length, 0);
      // Background path: pause then resume so drain runs under void.catch (same as production).
      await handle.runner.send(Msg.pause(0, { reason: 'arm-depth' }));
      live.pausedBuffer.push(Msg.chat(0, { text: 'depth-bait' }));
      expect(handle.runner.resumePaused()).toBe(true);
      await vi.waitFor(() => expect(errorLogs.length).toBeGreaterThanOrEqual(1), { timeout: 5_000 });
      expect(errorLogs.length).toBe(1);
      expect(String(errorLogs[0]![0])).toContain('background runner task failed');
      expect(String(errorLogs[0]![0])).toMatch(/dispatch depth exceeded/);
      expect(errorLogs[0]!).toHaveLength(1);
      expect(String(errorLogs[0]![0])).not.toContain('depth-bait');
      expect(String(errorLogs[0]![0])).not.toContain('pong-');
      expect(mockSessions.reduce((n, s) => n + s.sendCalls.length, 0)).toBe(sendsBefore);

      const negatives: unknown[] = [
        new Error('QA\nCANARY'),
        new Error('ctrl\u0001char'),
        new Error(`\u001b[31mANSI\u001b[0m`),
        new Error('x'.repeat(2000)),
        new Error('sk-SECRET_TOKEN_VALUE'),
        new Proxy(
          {},
          {
            get() {
              throw new Error('trap');
            },
            getPrototypeOf() {
              throw new Error('trap');
            },
          },
        ),
        Object.defineProperty({ name: 'Error' }, 'message', {
          get() {
            return 'getter-msg';
          },
        }),
        Object.defineProperty({}, 'code', {
          get() {
            return 'EVIL';
          },
        }),
        Object.defineProperty({ message: 'n' }, 'name', {
          get() {
            return 'EvilName';
          },
        }),
        (() => {
          const c: Record<string, unknown> = {};
          c.self = c;
          return c;
        })(),
        null,
        Symbol('s'),
        (() => {
          class Sub extends Error {}
          return new Sub('sub');
        })(),
        { spoof: true, message: 'spoofed' },
      ];
      for (const n of negatives) {
        errorLogs.length = 0;
        handle.runner.emit('error', n);
        expect(errorLogs.length).toBe(1);
        const line = String(errorLogs[0]![0]);
        expect(errorLogs[0]!).toHaveLength(1);
        expect(line.length).toBeLessThan(500);
        expect(line).not.toContain('QA');
        expect(line).not.toContain('CANARY');
        expect(line).not.toContain('\n');
        expect(line).not.toContain('\u0001');
        expect(line).not.toContain('ctrl');
        expect(line).not.toContain('\u001b');
        expect(line).not.toContain('[31m');
        expect(line).not.toContain('sk-SECRET_TOKEN_VALUE');
        expect(line).not.toContain('getter-msg');
        expect(line).not.toContain('EVIL');
        expect(line).not.toContain('EvilName');
        expect(line).not.toContain('spoofed');
        let longPayload = false;
        try {
          longPayload = n instanceof Error && n.message.length >= 100;
        } catch {
          longPayload = false;
        }
        if (longPayload) {
          expect(line.length).toBeLessThan((n as Error).message.length);
        }
      }
      expect(formatAutoloopBackgroundErrorReason(new Error('solo'))).toBe('Error (details withheld)');
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      await mgr.shutdown();
    }
  });
});

describe('2A2 row10 concurrent 50 accepts', () => {
  it('row10_promise_all_50_equal_texts_commit_before_202_ledger_order_delivery', async () => {
    const mgr = createManager();
    const runId = 'c2b-fifty';
    const workspace = path.join(TEST_WF_DIR, 'workspaces', runId);
    fs.mkdirSync(workspace, { recursive: true });
    const server = new EmbeddedServer(mgr, await freePort());
    const deliveredIds: string[] = [];
    try {
      await mgr.autoloopStart({ runId, workspace });
      mockSessions[0]!.sendImplementation = async () => ({
        text: fence('pause_loop', { reason: 'operator-hold' }),
        event: { type: 'result', result: 'ok' },
      });
      await mgr.autoloopChat(runId, 'pause-trigger');
      // Spy envelope ids at the real dispatcher boundary:
      const live = mgr.getAutoloop(runId)!;
      const origDeliver = live.dispatcher.deliver.bind(live.dispatcher);
      live.dispatcher.deliver = async (env: AnyAutoloopMessage) => {
        if (env.type === 'chat') deliveredIds.push(env.msg_id);
        return origDeliver(env);
      };
      const port = await server.start();
      const token = fs.readFileSync(path.join(os.homedir(), '.openclaw', 'server-token'), 'utf-8').trim();

      // Mix equal texts with unique ids; include equal-text pairs.
      const mgrAccepts = Array.from({ length: 25 }, (_, i) =>
        Promise.resolve().then(() => {
          const text = i % 5 === 0 ? 'SAME_TEXT' : `mgr-${i}`;
          const { message_id } = mgr.acceptAutoloopChat(runId, text);
          const snap = recoverySnapshot(runId);
          expect(snap?.items.some((it) => it.message_id === message_id)).toBe(true);
          return { source: 'mgr' as const, i, message_id, text };
        }),
      );
      const httpAccepts = Array.from({ length: 25 }, (_, i) => {
        const text = i % 5 === 0 ? 'SAME_TEXT' : `http-${i}`;
        return fetch(`http://127.0.0.1:${port}/autoloop/${runId}/chat`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify({ text }),
        }).then(async (res) => {
          expect(res.status).toBe(202);
          const body = (await res.json()) as { message_id: string };
          const snap = recoverySnapshot(runId);
          expect(snap?.items.some((it) => it.message_id === body.message_id)).toBe(true);
          return { source: 'http' as const, i, message_id: body.message_id, text };
        });
      });
      const results = await Promise.all([...mgrAccepts, ...httpAccepts]);
      expect(new Set(results.map((r) => r.message_id)).size).toBe(50);
      const ledgerOrder = recoverySnapshot(runId)!.items.map((it) => it.message_id);
      expect(ledgerOrder).toHaveLength(50);

      await mgr.autoloopStop(runId, 'stop');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (mgr as any).kernel.wait(runId);
      await mgr.shutdown();

      deliveredIds.length = 0;
      const mgr2 = createManager();
      mockSessions = [];
      patch(mgr2);
      try {
        await mgr2.autoloopResume(runId);
        const live2 = mgr2.getAutoloop(runId)!;
        const orig2 = live2.dispatcher.deliver.bind(live2.dispatcher);
        live2.dispatcher.deliver = async (env: AnyAutoloopMessage) => {
          if (env.type === 'chat') deliveredIds.push(env.msg_id);
          return orig2(env);
        };
        await mgr2.autoloopResume(runId);
        await vi.waitFor(() => {
          expect(deliveredIds).toHaveLength(50);
        }, 20_000);
        expect(deliveredIds).toEqual(ledgerOrder);
        expect(new Set(deliveredIds).size).toBe(50);
      } finally {
        await mgr2.shutdown();
      }
    } finally {
      await server.stop().catch(() => undefined);
      await mgr.shutdown().catch(() => undefined);
    }
  }, 90_000);
});

describe('2C P3 bounded ids + revision safe-integer', () => {
  const dispatchHex = 'a'.repeat(64);
  const realDispatchId = `dispatch_${dispatchHex}`;

  function baseRecoveryItem(messageId: string, dispatchId?: string) {
    return {
      message_id: messageId,
      iter: 0,
      ts: ts(),
      accepted_at: ts(),
      text: 't',
      status: 'dispatched' as const,
      ...(dispatchId ? { dispatch_id: dispatchId } : {}),
    };
  }

  function completePendingDispatch(overrides: Partial<SendTimeoutPayload> = {}): SendTimeoutPayload {
    return {
      status: 'awaiting_resume',
      dispatch_id: realDispatchId,
      agent: 'planner',
      message_id: Msg.chat(0, { text: 'env' }).msg_id,
      message_type: 'chat',
      iter: 0,
      timeout_ms: 60_000,
      error: 'Timeout waiting for response',
      ...overrides,
    };
  }

  it('p3_real_generated_envelope_and_dispatch_ids_restore_at_both_boundaries', () => {
    expect(isDispatchId(realDispatchId)).toBe(true);
    const envelopeId = Msg.chat(0, { text: 'env' }).msg_id;
    expect(isPendingMessageId(envelopeId)).toBe(true);
    const negativeCounterId = 'm_lk2j3_-zik0zk';
    expect(isPendingMessageId(negativeCounterId)).toBe(true);
    const ledgerId = mid(9100);
    const acceptedId = mid(9103);
    const record = validateRecoveryField({
      v: 1,
      gate: { kind: 'input_uncertain' },
      ledger_id: ledgerId,
      revision: 1,
      items: [baseRecoveryItem(acceptedId, realDispatchId)],
      resolved: [],
    });
    expect(record).toBeTruthy();
    expect(
      isGenuinePendingDispatch({
        status: 'awaiting_resume',
        dispatch_id: realDispatchId,
        agent: 'planner',
        message_id: envelopeId,
        message_type: 'chat',
        iter: 0,
        timeout_ms: 60_000,
        error: 'Timeout waiting for response',
      }),
    ).toBe(true);
  });

  it('p3_oversized_malformed_wrong_domain_ids_refused_at_both_boundaries', () => {
    const signedCounterId = 'm_1729612800_-zik0zk';
    expect(isPendingMessageId(signedCounterId)).toBe(true);
    const validPending = completePendingDispatch({ message_id: signedCounterId });
    expect(isGenuinePendingDispatch(validPending)).toBe(true);

    const oversizedM = `m_${'x'.repeat(40)}_${'y'.repeat(40)}`;
    const malformedM = 'm_notvalid';
    expect(isGenuinePendingDispatch({ ...validPending, message_id: oversizedM })).toBe(false);
    expect(isGenuinePendingDispatch({ ...validPending, message_id: malformedM })).toBe(false);

    const malformedDispatch = 'dispatch_short';
    const wrongDispatch = realDispatchId.slice(0, -1);
    const oversizedDispatch = `dispatch_${'f'.repeat(65)}`;
    expect(isGenuinePendingDispatch({ ...validPending, dispatch_id: malformedDispatch })).toBe(false);
    expect(isGenuinePendingDispatch({ ...validPending, dispatch_id: wrongDispatch })).toBe(false);
    expect(isGenuinePendingDispatch({ ...validPending, dispatch_id: oversizedDispatch })).toBe(false);

    expect(isPendingMessageId(mid(1))).toBe(true);
    expect(() =>
      validateRecoveryField({
        v: 1,
        gate: null,
        ledger_id: mid(9101),
        revision: 1,
        items: [baseRecoveryItem(mid(2), 'dispatch_not_64_hex_chars_total________________________________')],
        resolved: [],
      }),
    ).toThrow(AutoloopInputPersistenceError);
  });

  it('revision_max_safe_integer_boundary_refuse_next_mutation', async () => {
    let commits = 0;
    const runner = makeRunner(
      {
        async deliver() {
          return [];
        },
      },
      {
        persistCheckpoint: () => {
          commits += 1;
          return true;
        },
      },
    );
    await runner.start();
    const ledgerId = mid(9102);
    const atMaxMinusOne = Number.MAX_SAFE_INTEGER - 1;
    runner.applyRestoredRecovery({
      v: 1,
      gate: { kind: 'operator_pause' },
      ledger_id: ledgerId,
      revision: atMaxMinusOne,
      items: [],
      resolved: [],
    });
    expect(runner.getCommittedRecovery()!.revision).toBe(atMaxMinusOne);
    await runner.send(Msg.pause(0, { reason: 'bump-to-max' }));
    expect(runner.getCommittedRecovery()!.revision).toBe(Number.MAX_SAFE_INTEGER);
    const commitsAtMax = commits;
    const beforeMax = JSON.stringify(runner.getCommittedRecovery());
    expect(() =>
      runner.disposeUncertainInput({
        ledgerId,
        expectedRevision: Number.MAX_SAFE_INTEGER,
        messageIds: [mid(3)],
        resolution: 'abandon',
      }),
    ).toThrow();
    expect(JSON.stringify(runner.getCommittedRecovery())).toBe(beforeMax);
    expect(commits).toBe(commitsAtMax);
    expect(() => runner.acceptChat('refused-at-max')).toThrow(AutoloopInputPersistenceError);
    expect(commits).toBe(commitsAtMax);
    await runner.send(Msg.pause(0, { reason: 'second-pause-at-max' }));
    expect(runner.getCommittedRecovery()!.revision).toBe(Number.MAX_SAFE_INTEGER);
    expect(commits).toBe(commitsAtMax);
    expect(() =>
      validateRecoveryField({
        v: 1,
        gate: null,
        ledger_id: ledgerId,
        revision: Number.MAX_SAFE_INTEGER + 1,
        items: [],
        resolved: [],
      }),
    ).toThrow(AutoloopInputPersistenceError);

    const uncertainAtMax = mid(9205);
    runner.applyRestoredRecovery({
      v: 1,
      gate: { kind: 'input_uncertain' },
      ledger_id: ledgerId,
      revision: Number.MAX_SAFE_INTEGER,
      items: [
        {
          message_id: uncertainAtMax,
          iter: 0,
          ts: ts(),
          accepted_at: ts(),
          text: 'max-uncertain',
          status: 'dispatched',
        },
      ],
      resolved: [],
    });
    const recAtMaxUncertain = JSON.stringify(runner.getCommittedRecovery());
    const commitsBeforeUncertainDispose = commits;
    let uncertainDisposeErr: unknown;
    try {
      runner.disposeUncertainInput({
        ledgerId,
        expectedRevision: Number.MAX_SAFE_INTEGER,
        messageIds: [uncertainAtMax],
        resolution: 'abandon',
      });
    } catch (err) {
      uncertainDisposeErr = err;
    }
    expect(uncertainDisposeErr).toBeInstanceOf(AutoloopInputPersistenceError);
    expect((uncertainDisposeErr as AutoloopInputPersistenceError).code).toBe('commit_refused');
    expect(String((uncertainDisposeErr as Error).message)).toMatch(/revision exhausted/);
    expect(JSON.stringify(runner.getCommittedRecovery())).toBe(recAtMaxUncertain);
    expect(runner.getCommittedRecovery()!.items.find((it) => it.message_id === uncertainAtMax)?.text).toBe(
      'max-uncertain',
    );
    expect(commits).toBe(commitsBeforeUncertainDispose);

    const dispatchAtMaxMinusOne = `dispatch_${'a'.repeat(64)}`;
    const timeoutMsgIdAtMaxMinusOne = mid(9208);
    const timeoutLedgerAtMaxMinusOne = mid(9209);
    let timeoutCommitsAtMaxMinusOne = 0;
    const timeoutChatDelivered: string[] = [];
    const timeoutFollowups: string[] = [];
    const timeoutRunnerAtMaxMinusOne = makeRunner(
      {
        async deliver(env) {
          if (env.type === 'chat') timeoutChatDelivered.push(env.msg_id);
          else timeoutFollowups.push(env.type);
          return [];
        },
      },
      {
        persistCheckpoint: () => {
          timeoutCommitsAtMaxMinusOne += 1;
          return true;
        },
      },
    );
    await timeoutRunnerAtMaxMinusOne.start();
    const timeoutPendingAtMaxMinusOne: SendTimeoutPayload = {
      status: 'awaiting_resume',
      dispatch_id: dispatchAtMaxMinusOne,
      agent: 'planner',
      message_id: timeoutMsgIdAtMaxMinusOne,
      message_type: 'chat',
      iter: 0,
      timeout_ms: 60_000,
      error: 'Timeout waiting for response',
    };
    timeoutRunnerAtMaxMinusOne.applyRestoredRecovery(
      {
        v: 1,
        gate: null,
        ledger_id: timeoutLedgerAtMaxMinusOne,
        revision: atMaxMinusOne,
        items: [
          {
            message_id: timeoutMsgIdAtMaxMinusOne,
            iter: 0,
            ts: ts(),
            accepted_at: ts(),
            text: 'timeout-at-max-minus-one',
            status: 'dispatched',
            dispatch_id: dispatchAtMaxMinusOne,
          },
        ],
        resolved: [],
      },
      {
        pending_dispatch: timeoutPendingAtMaxMinusOne,
      },
    );
    expect(timeoutRunnerAtMaxMinusOne.resumeTimedOutDispatch(dispatchAtMaxMinusOne)).toBe(true);
    expect(timeoutCommitsAtMaxMinusOne).toBe(1);
    expect(timeoutRunnerAtMaxMinusOne.getCommittedRecovery()!.revision).toBe(Number.MAX_SAFE_INTEGER);
    expect(
      timeoutRunnerAtMaxMinusOne.getCommittedRecovery()!.items.some((i) => i.message_id === timeoutMsgIdAtMaxMinusOne),
    ).toBe(false);
    expect(
      timeoutRunnerAtMaxMinusOne
        .getCommittedRecovery()
        ?.resolved.some((t) => t.message_id === timeoutMsgIdAtMaxMinusOne && t.resolution === 'advanced_after_timeout'),
    ).toBe(true);
    expect(timeoutRunnerAtMaxMinusOne.state.pending_dispatch).toBeNull();
    expect(timeoutRunnerAtMaxMinusOne.getCommittedRecovery()?.gate).toBeNull();
    expect(timeoutChatDelivered).toEqual([]);
    expect(timeoutFollowups).toEqual([]);

    const dispatchAtMax = `dispatch_${'b'.repeat(64)}`;
    const timeoutMsgId = mid(9206);
    const timeoutLedger = mid(9207);
    let timeoutCommits = 0;
    const timeoutRunner = makeRunner(
      {
        async deliver() {
          return [];
        },
      },
      {
        persistCheckpoint: () => {
          timeoutCommits += 1;
          return true;
        },
      },
    );
    await timeoutRunner.start();
    const timeoutPending: SendTimeoutPayload = {
      status: 'awaiting_resume',
      dispatch_id: dispatchAtMax,
      agent: 'planner',
      message_id: timeoutMsgId,
      message_type: 'chat',
      iter: 0,
      timeout_ms: 60_000,
      error: 'Timeout waiting for response',
    };
    timeoutRunner.applyRestoredRecovery(
      {
        v: 1,
        gate: null,
        ledger_id: timeoutLedger,
        revision: Number.MAX_SAFE_INTEGER,
        items: [
          {
            message_id: timeoutMsgId,
            iter: 0,
            ts: ts(),
            accepted_at: ts(),
            text: 'timeout-at-max',
            status: 'dispatched',
            dispatch_id: dispatchAtMax,
          },
        ],
        resolved: [],
      },
      {
        pending_dispatch: timeoutPending,
      },
    );
    const timeoutSnap = JSON.stringify(timeoutRunner.getCommittedRecovery());
    const pendingBeforeTimeout = timeoutRunner.state.pending_dispatch?.dispatch_id;
    expect(timeoutRunner.resumeTimedOutDispatch(dispatchAtMax)).toBe(false);
    expect(timeoutRunner.state.pending_dispatch?.dispatch_id).toBe(pendingBeforeTimeout);
    expect(timeoutRunner.hasUncertainItems()).toBe(true);
    expect(JSON.stringify(timeoutRunner.getCommittedRecovery())).toBe(timeoutSnap);
    expect(timeoutCommits).toBe(0);

    const physicalId = mid(9210);
    const physicalLedger = mid(9211);
    let physicalCommits = 0;
    const followups: string[] = [];
    let settlePhysical!: (v: TurnResult) => void;
    const gatePromise = new Promise<TurnResult>((r) => {
      settlePhysical = r;
    });
    const physicalRunner = makeRunner(
      {
        async deliver(env) {
          if (env.type !== 'chat') followups.push(env.type);
          await gatePromise;
          return [];
        },
      },
      {
        persistCheckpoint: () => {
          physicalCommits += 1;
          return true;
        },
      },
    );
    await physicalRunner.start();
    const atMaxMinusTwo = Number.MAX_SAFE_INTEGER - 2;
    physicalRunner.applyRestoredRecovery({
      v: 1,
      gate: null,
      ledger_id: physicalLedger,
      revision: atMaxMinusTwo,
      items: [
        {
          message_id: physicalId,
          iter: 0,
          ts: ts(),
          accepted_at: ts(),
          text: 'physical-max-minus-one',
          status: 'pending',
        },
      ],
      resolved: [],
    });
    expect(physicalRunner.getCommittedRecovery()!.gate?.kind).toBe('recovered_input');
    expect(physicalRunner.state.status).toBe('paused');
    await physicalRunner.deliverAccepted(physicalId);
    expect(physicalRunner.getCommittedRecovery()!.revision).toBe(atMaxMinusTwo);
    expect(physicalRunner.resumePaused()).toBe(true);
    expect(physicalRunner.getCommittedRecovery()!.gate).toBeNull();
    expect(physicalRunner.getCommittedRecovery()!.revision).toBe(Number.MAX_SAFE_INTEGER);
    expect(physicalRunner.getCommittedRecovery()!.items.find((it) => it.message_id === physicalId)?.status).toBe(
      'dispatched',
    );
    const commitsAfterMark = physicalCommits;
    let drainErr: unknown;
    physicalRunner.once('error', (err) => {
      drainErr = err;
    });
    settlePhysical({ text: 'done', event: { type: 'result', result: 'ok' } });
    await vi.waitFor(() => {
      expect(drainErr).toBeInstanceOf(AutoloopInputPersistenceError);
    });
    expect((drainErr as AutoloopInputPersistenceError).code).toBe('commit_refused');
    expect(physicalRunner.getCommittedRecovery()!.revision).toBe(Number.MAX_SAFE_INTEGER);
    expect(physicalRunner.getCommittedRecovery()!.items.find((it) => it.message_id === physicalId)?.status).toBe(
      'dispatched',
    );
    expect(physicalCommits).toBe(commitsAfterMark);
    expect(followups).toEqual([]);

    const idemLedger = mid(9212);
    const idemMsg = mid(9213);
    const laterHeld = mid(9214);
    const maxRev = Number.MAX_SAFE_INTEGER;
    let idemCommits = 0;
    const idemRunner = makeRunner(
      {
        async deliver() {
          return [];
        },
      },
      {
        persistCheckpoint: () => {
          idemCommits += 1;
          return true;
        },
      },
    );
    await idemRunner.start();
    idemRunner.applyRestoredRecovery({
      v: 1,
      gate: { kind: 'operator_pause' },
      ledger_id: idemLedger,
      revision: maxRev,
      items: [
        {
          message_id: laterHeld,
          iter: 0,
          ts: ts(),
          accepted_at: ts(),
          text: 'later-held',
          status: 'pending',
        },
      ],
      resolved: [{ message_id: idemMsg, resolution: 'abandon', revision: maxRev, at: ts() }],
    });
    const idemBody = {
      ledgerId: idemLedger,
      expectedRevision: maxRev - 1,
      messageIds: [idemMsg],
      resolution: 'abandon' as const,
    };
    const idemCommitsBefore = idemCommits;
    expect(idemRunner.disposeUncertainInput(idemBody)).toBe('idempotent');
    expect(idemCommits).toBe(idemCommitsBefore);
    expect(idemRunner.getCommittedRecovery()?.gate?.kind).toBe('operator_pause');
    expect(idemRunner.getCommittedRecovery()!.items.some((it) => it.message_id === laterHeld)).toBe(true);

    const posLedger = mid(9220);
    const posUncertain = mid(9221);
    const posRunner = makeRunner(
      {
        async deliver() {
          return [];
        },
      },
      {
        persistCheckpoint: () => true,
      },
    );
    await posRunner.start();
    posRunner.applyRestoredRecovery({
      v: 1,
      gate: { kind: 'input_uncertain' },
      ledger_id: posLedger,
      revision: atMaxMinusOne,
      items: [
        {
          message_id: posUncertain,
          iter: 0,
          ts: ts(),
          accepted_at: ts(),
          text: 'positive-disposition',
          status: 'dispatched',
        },
      ],
      resolved: [],
    });
    expect(
      posRunner.disposeUncertainInput({
        ledgerId: posLedger,
        expectedRevision: atMaxMinusOne,
        messageIds: [posUncertain],
        resolution: 'abandon',
      }),
    ).toBe('applied');
    expect(posRunner.getCommittedRecovery()!.revision).toBe(maxRev);
    expect(posRunner.getCommittedRecovery()!.resolved.some((t) => t.message_id === posUncertain)).toBe(true);
  });
});
