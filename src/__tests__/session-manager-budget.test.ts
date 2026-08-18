/**
 * SessionManager-level tests for the run ledger and the spend cap.
 *
 * These use a real temp directory for the ledger (no fs mock) so the assertion
 * is on what actually lands on disk — the whole point of the feature is that the
 * record survives the process that wrote it.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  ISession,
  SessionConfig,
  SessionStats,
  SessionSendOptions,
  TurnResult,
  CostBreakdown,
  EffortLevel,
} from '../types.js';
import { readRunLedger } from '../run-ledger.js';
import { BudgetExceededError } from '../budget.js';

// SessionManager resolves its persisted-session registry and PID file from
// os.homedir() at module load, so HOME has to be redirected BEFORE the import
// or these tests write into the developer's real ~/.openclaw state.
const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'clawo-home-'));
process.env.HOME = FAKE_HOME;
process.env.USERPROFILE = FAKE_HOME;
const { SessionManager } = await import('../session-manager.js');
type SessionManager = InstanceType<typeof SessionManager>;

/** Mock engine whose per-turn cost is scripted by the test. */
class CostingSession extends EventEmitter implements ISession {
  sessionId?: string;
  turns = 0;
  toolCalls = 0;
  costUsd = 0;
  tokensEstimated = false;
  failNext?: string;
  /** USD added by each completed turn. */
  costPerTurn = 0.5;

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
    this.sessionId = 'mock-1';
    return this;
  }
  stop(): void {}
  pause(): void {}
  resume(): void {}

  async send(
    message: string | unknown[],
    options?: SessionSendOptions,
  ): Promise<TurnResult | { requestId: number; sent: boolean }> {
    this.turns++;
    this.toolCalls += 2;
    this.costUsd += this.costPerTurn;
    if (this.failNext) {
      const msg = this.failNext;
      this.failNext = undefined;
      throw new Error(msg);
    }
    void options;
    return { text: `ok: ${String(message)}`, event: { type: 'result', result: 'done' } };
  }

  getStats(): SessionStats & { sessionId?: string; uptime: number } {
    return {
      turns: this.turns,
      toolCalls: this.toolCalls,
      toolErrors: 0,
      tokensIn: this.turns * 100,
      tokensOut: this.turns * 40,
      cachedTokens: 0,
      costUsd: this.costUsd,
      isReady: true,
      startTime: new Date().toISOString(),
      lastActivity: new Date().toISOString(),
      contextPercent: 1,
      retries: 0,
      tokensEstimated: this.tokensEstimated,
      sessionId: this.sessionId,
      uptime: 1,
    };
  }
  getHistory(): Array<{ time: string; type: string; event: unknown }> {
    return [];
  }
  getCost(): CostBreakdown {
    return {
      model: 'mock-model',
      tokensIn: this.turns * 100,
      tokensOut: this.turns * 40,
      cachedTokens: 0,
      pricing: { inputPer1M: 1, outputPer1M: 1, cachedPer1M: 0 },
      breakdown: { inputCost: 0, cachedCost: 0, outputCost: 0 },
      totalUsd: this.costUsd,
    };
  }
  async compact(): Promise<void> {}
  getEffort(): EffortLevel {
    return 'auto';
  }
  setEffort(): void {}
  resolveModel(alias: string): string {
    return alias;
  }
}

let tmpDir: string;
let engines: CostingSession[] = [];
const envKeys = ['CLAWO_RUNS_DIR'] as const;
const savedEnv: Record<string, string | undefined> = {};

function makeManager(): SessionManager {
  const mgr = new SessionManager({
    claudeBin: 'mock-claude',
    maxConcurrentSessions: 5,
    sessionTtlMinutes: 120,
    defaultPermissionMode: 'acceptEdits',
    defaultEffort: 'auto',
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (mgr as any)._createSession = (_engine: string, _config: SessionConfig): ISession => {
    const s = new CostingSession();
    engines.push(s);
    return s;
  };
  return mgr;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawo-mgr-ledger-'));
  for (const k of envKeys) savedEnv[k] = process.env[k];
  process.env.CLAWO_RUNS_DIR = tmpDir;
  engines = [];
});

afterEach(() => {
  for (const k of envKeys) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k] as string;
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

afterAll(() => {
  fs.rmSync(FAKE_HOME, { recursive: true, force: true });
});

describe('run ledger integration', () => {
  it('records one durable row per turn, with per-turn deltas', async () => {
    const mgr = makeManager();
    await mgr.startSession({ name: 'ledger-a', engine: 'codex', cwd: tmpDir });
    await mgr.sendMessage('ledger-a', 'first');
    await mgr.sendMessage('ledger-a', 'second');

    const rows = readRunLedger({ session: 'ledger-a' });
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.turn)).toEqual([1, 2]);
    // Deltas, not cumulative totals — summing a window must not double-count.
    expect(rows.every((r) => r.tokensIn === 100)).toBe(true);
    expect(rows.every((r) => r.costUsd === 0.5)).toBe(true);
    expect(rows.every((r) => r.toolCalls === 2)).toBe(true);
    expect(rows[0].engine).toBe('codex');
    expect(rows[0].cwd).toBe(tmpDir);
    expect(rows.every((r) => r.ok)).toBe(true);
    await mgr.shutdown();
  });

  it('records a failed turn with ok:false and the error text', async () => {
    const mgr = makeManager();
    await mgr.startSession({ name: 'ledger-fail', engine: 'codex', cwd: tmpDir });
    engines[0].failNext = 'engine exploded';
    await expect(mgr.sendMessage('ledger-fail', 'boom')).rejects.toThrow('engine exploded');

    const rows = readRunLedger({ session: 'ledger-fail' });
    expect(rows).toHaveLength(1);
    expect(rows[0].ok).toBe(false);
    expect(rows[0].error).toContain('engine exploded');
    await mgr.shutdown();
  });

  it('stamps parentRunId so a multi-agent run can be reassembled', async () => {
    const mgr = makeManager();
    await mgr.startSession({ name: 'ledger-child', engine: 'codex', cwd: tmpDir });
    await mgr.sendMessage('ledger-child', 'hi', { parentRunId: 'council-42' });
    expect(readRunLedger({ parent: 'council-42' })).toHaveLength(1);
    await mgr.shutdown();
  });

  it('labels estimated token counts so an estimate is never shown as a measurement', async () => {
    const mgr = makeManager();
    await mgr.startSession({ name: 'ledger-est', engine: 'cursor', cwd: tmpDir });
    engines[0].tokensEstimated = true;
    await mgr.sendMessage('ledger-est', 'hi');
    expect(readRunLedger({ session: 'ledger-est' })[0].tokensEstimated).toBe(true);
    await mgr.shutdown();
  });

  it('getRunLedger returns rows plus a summary', async () => {
    const mgr = makeManager();
    await mgr.startSession({ name: 'ledger-sum', engine: 'codex', cwd: tmpDir });
    await mgr.sendMessage('ledger-sum', 'one');
    const { rows, summary } = mgr.getRunLedger({ session: 'ledger-sum' });
    expect(rows).toHaveLength(1);
    expect(summary.costUsd).toBeCloseTo(0.5, 4);
    expect(summary.byEngine.codex.rows).toBe(1);
    await mgr.shutdown();
  });
});

describe('budget cap', () => {
  it('refuses the next turn once the cap is reached — on an engine with no native budget flag', async () => {
    const mgr = makeManager();
    await mgr.startSession({ name: 'capped', engine: 'codex', cwd: tmpDir, maxBudgetUsd: 0.75 });

    // First turn is allowed (spend starts at 0) and takes the session to $0.50.
    await mgr.sendMessage('capped', 'one');
    // Second turn is allowed ($0.50 < $0.75) and takes it to $1.00.
    await mgr.sendMessage('capped', 'two');
    // Third must be refused before the engine is invoked at all.
    await expect(mgr.sendMessage('capped', 'three')).rejects.toBeInstanceOf(BudgetExceededError);
    expect(engines[0].turns).toBe(2);
    await mgr.shutdown();
  });

  it('does not cap a session that configured no budget', async () => {
    const mgr = makeManager();
    await mgr.startSession({ name: 'uncapped', engine: 'codex', cwd: tmpDir });
    for (let i = 0; i < 4; i++) await mgr.sendMessage('uncapped', `turn ${i}`);
    expect(engines[0].turns).toBe(4);
    await mgr.shutdown();
  });

  it('surfaces spend and exhaustion in the session listing', async () => {
    const mgr = makeManager();
    await mgr.startSession({ name: 'shown', engine: 'codex', cwd: tmpDir, maxBudgetUsd: 0.4 });
    await mgr.sendMessage('shown', 'one');
    const info = mgr.listSessions().find((s) => s.name === 'shown');
    expect(info?.costUsd).toBeCloseTo(0.5, 4);
    expect(info?.budgetUsd).toBe(0.4);
    expect(info?.budgetExhausted).toBe(true);
    await mgr.shutdown();
  });
});
