/**
 * Unit tests for circuit breaker and rate limiting features.
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

// ─── Mock ISession ─────────────────────────────────────────────────────────

class MockSession extends EventEmitter implements ISession {
  sessionId?: string;
  private _isReady = true;
  private _isPaused = false;
  private _isBusy = false;
  private _effort: EffortLevel = 'auto';

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
    this.sessionId = `mock-${Date.now()}`;
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
    _options?: SessionSendOptions,
  ): Promise<TurnResult | { requestId: number; sent: boolean }> {
    return { text: `response: ${message}`, event: { type: 'result', result: 'done' } };
  }
  getStats(): SessionStats & { sessionId?: string; uptime: number } {
    return {
      turns: 0,
      turnsSucceeded: 0,
      toolCalls: 0,
      toolErrors: 0,
      tokensIn: 0,
      tokensOut: 0,
      cachedTokens: 0,
      costUsd: 0,
      isReady: this._isReady,
      startTime: null,
      lastActivity: null,
      contextPercent: 0,
      sessionId: this.sessionId,
      uptime: 0,
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
      pricing: { inputPer1M: 0, outputPer1M: 0, cachedPer1M: undefined },
      breakdown: { inputCost: 0, cachedCost: 0, outputCost: 0 },
      totalUsd: 0,
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

// ─── Failing Mock ──────────────────────────────────────────────────────────

class FailingSession extends MockSession {
  async start(): Promise<this> {
    throw new Error('Engine unavailable');
  }
}

// ─── Mock fs ───────────────────────────────────────────────────────────────

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn((p: string) => {
        if (typeof p === 'string' && (p.includes('claude-sessions.json') || p.includes('session-pids.json')))
          return false;
        return actual.existsSync(p);
      }),
      readFileSync: vi.fn((p: string, enc?: string) => {
        if (typeof p === 'string' && p.includes('claude-sessions.json')) return '[]';
        return actual.readFileSync(p, enc as BufferEncoding);
      }),
      writeFileSync: vi.fn(),
      mkdirSync: vi.fn(),
      unlinkSync: vi.fn(),
    },
    existsSync: vi.fn((p: string) => {
      if (typeof p === 'string' && (p.includes('claude-sessions.json') || p.includes('session-pids.json')))
        return false;
      return actual.existsSync(p);
    }),
    readFileSync: vi.fn((p: string, enc?: string) => {
      if (typeof p === 'string' && p.includes('claude-sessions.json')) return '[]';
      return actual.readFileSync(p, enc as BufferEncoding);
    }),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    unlinkSync: vi.fn(),
  };
});

const { SessionManager } = await import('../session-manager.js');

// ─── Helpers ───────────────────────────────────────────────────────────────

let failNext = false;

function patchCreateSession(manager: InstanceType<typeof SessionManager>): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (manager as any)._createSession = (_engine: string, _config: SessionConfig): ISession => {
    if (failNext) return new FailingSession();
    return new MockSession();
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('Circuit Breaker', () => {
  let manager: InstanceType<typeof SessionManager>;

  beforeEach(() => {
    failNext = false;
    manager = new SessionManager();
    patchCreateSession(manager);
  });

  afterEach(async () => {
    await manager.shutdown();
  });

  it('allows session creation normally', async () => {
    const info = await manager.startSession({ name: 'ok1', cwd: '/tmp' });
    expect(info.name).toBe('ok1');
    await manager.stopSession('ok1');
  });

  it('opens circuit after consecutive failures', async () => {
    failNext = true;
    // Fail 3 times (CIRCUIT_BREAKER_THRESHOLD = 3)
    for (let i = 0; i < 3; i++) {
      await expect(manager.startSession({ name: `fail-${i}`, cwd: '/tmp' })).rejects.toThrow();
    }
    // 4th attempt should be blocked by circuit breaker
    await expect(manager.startSession({ name: 'blocked', cwd: '/tmp' })).rejects.toThrow('circuit breaker open');
  });

  it('resets circuit breaker on success', async () => {
    failNext = true;
    // Fail twice (below threshold)
    await expect(manager.startSession({ name: 'f1', cwd: '/tmp' })).rejects.toThrow();
    await expect(manager.startSession({ name: 'f2', cwd: '/tmp' })).rejects.toThrow();

    // Succeed — should reset breaker
    failNext = false;
    const info = await manager.startSession({ name: 'success', cwd: '/tmp' });
    expect(info.name).toBe('success');
    await manager.stopSession('success');

    // Fail again — counter should be reset, so 1 failure should not trigger breaker
    failNext = true;
    await expect(manager.startSession({ name: 'f3', cwd: '/tmp' })).rejects.toThrow('Engine unavailable');
    // This should still throw engine error, not circuit breaker
    await expect(manager.startSession({ name: 'f4', cwd: '/tmp' })).rejects.toThrow('Engine unavailable');
  });

  it('exposes circuit breaker state in health', async () => {
    failNext = true;
    await expect(manager.startSession({ name: 'f1', cwd: '/tmp' })).rejects.toThrow();

    const health = manager.health();
    expect(health).toHaveProperty('circuitBreakers');
    const breakers = (health as Record<string, unknown>).circuitBreakers as Record<string, unknown>;
    expect(breakers).toHaveProperty('claude');
    const claudeBreaker = breakers.claude as Record<string, unknown>;
    expect(claudeBreaker.failures).toBe(1);
  });
});

describe('Rate Limiter (unit logic)', () => {
  it('RATE_LIMIT_MAX_REQUESTS and RATE_LIMIT_WINDOW_MS are positive', async () => {
    const { RATE_LIMIT_MAX_REQUESTS, RATE_LIMIT_WINDOW_MS } = await import('../constants.js');
    expect(RATE_LIMIT_MAX_REQUESTS).toBeGreaterThan(0);
    expect(RATE_LIMIT_WINDOW_MS).toBeGreaterThan(0);
  });
});

describe('CircuitBreaker (direct)', () => {
  it('caps failure count at CIRCUIT_BREAKER_MAX_COUNT', async () => {
    const { CircuitBreaker } = await import('../circuit-breaker.js');
    const { CIRCUIT_BREAKER_MAX_COUNT } = await import('../constants.js');
    const breaker = new CircuitBreaker();
    for (let i = 0; i < CIRCUIT_BREAKER_MAX_COUNT + 5; i++) {
      breaker.recordFailure('engineA');
    }
    expect(breaker.getStatus().engineA.failures).toBe(CIRCUIT_BREAKER_MAX_COUNT);
  });

  it('reset() clears the breaker entry', async () => {
    const { CircuitBreaker } = await import('../circuit-breaker.js');
    const breaker = new CircuitBreaker();
    breaker.recordFailure('engineB');
    breaker.recordFailure('engineB');
    expect(breaker.getStatus().engineB.failures).toBe(2);
    breaker.reset('engineB');
    expect(breaker.getStatus()).not.toHaveProperty('engineB');
  });
});
