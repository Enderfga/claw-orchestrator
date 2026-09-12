/**
 * A turn in which the engine blocked a tool call still reports success.
 *
 * Measured against Claude Code 2.1.269 with `--permission-prompts none`: asked
 * to write a file, the result event came back `subtype: 'success'`,
 * `is_error: false`, with the Bash call listed under `permission_denials` — and
 * no file on disk. `sendMessage` used to drop that event, so every caller saw a
 * clean success. These tests pin that the denials now reach the caller, and
 * that nothing is invented when there were none.
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

// SessionManager resolves its persisted-session registry and PID file from
// os.homedir() at module load, so HOME has to be redirected BEFORE the import.
const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'clawo-home-denials-'));
process.env.HOME = FAKE_HOME;
process.env.USERPROFILE = FAKE_HOME;
const { SessionManager } = await import('../session-manager.js');
type SessionManager = InstanceType<typeof SessionManager>;

/** An engine whose next `result` event is scripted by the test. */
class ScriptedSession extends EventEmitter implements ISession {
  sessionId?: string;
  nextEvent: Record<string, unknown> = { type: 'result', subtype: 'success', result: 'done' };

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
    this.sessionId = 'scripted-1';
    return this;
  }
  stop(): void {}
  pause(): void {}
  resume(): void {}
  async send(
    _message: string | unknown[],
    _options?: SessionSendOptions,
  ): Promise<TurnResult | { requestId: number; sent: boolean }> {
    return { text: 'done', event: this.nextEvent as TurnResult['event'] };
  }
  getStats(): SessionStats & { sessionId?: string; uptime: number } {
    return {
      turns: 1,
      turnsSucceeded: 1,
      toolCalls: 0,
      toolErrors: 0,
      tokensIn: 0,
      tokensOut: 0,
      cachedTokens: 0,
      costUsd: 0,
      isReady: true,
      startTime: null,
      lastActivity: null,
      contextPercent: 0,
      retries: 0,
      sessionId: this.sessionId,
      uptime: 1,
    };
  }
  getHistory(): Array<{ time: string; type: string; event: unknown }> {
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
  async compact(): Promise<void> {}
  getEffort(): EffortLevel {
    return 'auto';
  }
  setEffort(): void {}
  resolveModel(alias: string): string {
    return alias;
  }
}

let engine: ScriptedSession;
let manager: SessionManager;
let runsDir: string;
const savedRunsDir = process.env.CLAWO_RUNS_DIR;

beforeEach(async () => {
  runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawo-denials-runs-'));
  process.env.CLAWO_RUNS_DIR = runsDir;
  manager = new SessionManager({ claudeBin: 'mock-claude', maxConcurrentSessions: 2 });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (manager as any)._createSession = (_engine: string, _config: SessionConfig): ISession => {
    engine = new ScriptedSession();
    return engine;
  };
  await manager.startSession({ name: 'd', cwd: FAKE_HOME });
});

afterEach(async () => {
  await manager.shutdown();
  fs.rmSync(runsDir, { recursive: true, force: true });
  if (savedRunsDir === undefined) delete process.env.CLAWO_RUNS_DIR;
  else process.env.CLAWO_RUNS_DIR = savedRunsDir;
});

afterAll(() => {
  fs.rmSync(FAKE_HOME, { recursive: true, force: true });
});

describe('permission denials on a turn the engine calls a success', () => {
  it('reaches the caller instead of being dropped with the result event', async () => {
    // The exact shape Claude Code 2.1.269 emitted in the measurement above.
    engine.nextEvent = {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'done',
      permission_denials: [
        {
          tool_name: 'Bash',
          tool_use_id: 'toolu_012N57Gjcim3v4b8qyDX197w',
          tool_input: { command: 'echo hello > out.txt', description: 'Create file with echo command' },
        },
      ],
    };

    const res = await manager.sendMessage('d', 'write the file');

    // Still a success by the engine's own verdict — this field is the only signal.
    expect(res.error).toBeUndefined();
    expect(res.permissionDenials).toEqual([
      {
        toolName: 'Bash',
        toolUseId: 'toolu_012N57Gjcim3v4b8qyDX197w',
        input: { command: 'echo hello > out.txt', description: 'Create file with echo command' },
      },
    ]);
  });

  it('adds no field at all when nothing was denied', async () => {
    engine.nextEvent = { type: 'result', subtype: 'success', result: 'done', permission_denials: [] };
    const res = await manager.sendMessage('d', 'hello');
    expect(res).not.toHaveProperty('permissionDenials');
  });

  // A persistent `custom` engine emits a result event of its own shape, so the
  // field is read defensively rather than trusted.
  it('ignores entries that do not name a tool', async () => {
    engine.nextEvent = {
      type: 'result',
      subtype: 'success',
      result: 'done',
      permission_denials: ['Bash', null, { tool_use_id: 'x' }, { tool_name: 'Write' }],
    };
    const res = await manager.sendMessage('d', 'hello');
    expect(res.permissionDenials).toEqual([{ toolName: 'Write' }]);
  });
});
