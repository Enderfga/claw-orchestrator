/**
 * Owner-process child for abrupt-loss autoloop tests.
 *
 * Env:
 *   AUTOLOOP_MODE        committed-iter | planner-only
 *   AUTOLOOP_RUN_ID      kernel run id
 *   AUTOLOOP_WORKSPACE   git workspace shared with the parent
 *   CLAWO_WF_DIR         shared run store
 *
 * Public API only: SessionManager.autoloopStart / autoloopChat.
 * Reviewer send in committed-iter never settles; stdout emits READY once
 * that send has started (or once start returns, for planner-only).
 */
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  EffortLevel,
  ISession,
  SessionConfig,
  SessionSendOptions,
  SessionStats,
  TurnResult,
} from '../../types.js';
import { SessionManager } from '../../session-manager.js';

export const AUTOLOOP_PROOF_RELPATH = 'committed-proof.txt';
export const AUTOLOOP_PROOF_BYTES = 'committed-coder-bytes\n';

function fence(tool: string, args: Record<string, unknown>): string {
  return `\`\`\`autoloop\n${JSON.stringify({ tool, args })}\n\`\`\``;
}

const PLANNER_SPAWN = fence('spawn_subagents', {
  initial_directive: {
    goal: 'write the proof file with fixed bytes',
    constraints: ['do not invent ids or digests'],
    success_criteria: ['proof file exists'],
    max_attempts: 1,
  },
});

const CODER_COMPLETE = fence('iter_complete', {
  summary: 'wrote proof file',
  eval_output: { metric: 1, gates: [] },
});

class OwnerMockSession extends EventEmitter implements ISession {
  sessionId?: string;
  private readonly role: 'planner' | 'coder' | 'reviewer' | 'other';
  private readonly workspace: string;

  constructor(config: SessionConfig, workspace: string) {
    super();
    this.workspace = workspace;
    const name = config.name ?? '';
    if (name.endsWith('-planner')) this.role = 'planner';
    else if (name.endsWith('-coder')) this.role = 'coder';
    else if (name.endsWith('-reviewer')) this.role = 'reviewer';
    else this.role = 'other';
  }

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
    this.sessionId = `owner-mock-${this.role}-${Date.now()}`;
    return this;
  }

  stop(): void {}
  pause(): void {}
  resume(): void {}

  async send(
    message: string | unknown[],
    _options?: SessionSendOptions,
  ): Promise<TurnResult | { requestId: number; sent: boolean }> {
    if (this.role === 'planner') {
      return { text: PLANNER_SPAWN, event: { type: 'result', result: 'ok' } };
    }
    if (this.role === 'coder') {
      fs.writeFileSync(path.join(this.workspace, AUTOLOOP_PROOF_RELPATH), AUTOLOOP_PROOF_BYTES);
      return { text: CODER_COMPLETE, event: { type: 'result', result: 'ok' } };
    }
    if (this.role === 'reviewer') {
      process.stdout.write('READY\n');
      await new Promise(() => undefined);
    }
    return {
      text: `unused:${typeof message === 'string' ? message.slice(0, 20) : ''}`,
      event: { type: 'result', result: 'ok' },
    };
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
      isReady: true,
      startTime: new Date().toISOString(),
      lastActivity: new Date().toISOString(),
      contextPercent: 1,
      retries: 0,
      sessionId: this.sessionId,
      uptime: 1,
    };
  }

  getHistory(): Array<{ time: string; type: string; event: unknown }> {
    return [];
  }

  getCost() {
    return {
      model: 'mock-model',
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
  setEffort(_level: EffortLevel): void {}
  resolveModel(alias: string): string {
    return alias;
  }
}

function patchCreateSession(manager: SessionManager, workspace: string): void {
  (manager as unknown as { _createSession: (engine: string, config: SessionConfig) => ISession })._createSession = (
    _engine: string,
    config: SessionConfig,
  ): ISession => new OwnerMockSession(config, workspace);
}

async function main(): Promise<void> {
  const mode = process.env.AUTOLOOP_MODE;
  const runId = process.env.AUTOLOOP_RUN_ID;
  const workspace = process.env.AUTOLOOP_WORKSPACE;
  if (!runId || !workspace) throw new Error('AUTOLOOP_RUN_ID and AUTOLOOP_WORKSPACE are required');
  if (mode !== 'committed-iter' && mode !== 'planner-only') {
    throw new Error(`unknown AUTOLOOP_MODE ${String(mode)}`);
  }

  const mgr = new SessionManager({
    claudeBin: 'mock-claude',
    maxConcurrentSessions: 5,
    sessionTtlMinutes: 120,
    defaultPermissionMode: 'acceptEdits',
  });
  patchCreateSession(mgr, workspace);

  await mgr.autoloopStart({ runId, workspace });
  if (mode === 'planner-only') {
    process.stdout.write('READY\n');
    await new Promise(() => undefined);
    return;
  }
  await mgr.autoloopChat(runId, 'spawn coder and review the committed iteration');
  await new Promise(() => undefined);
}

if (process.env.AUTOLOOP_MODE) {
  main().catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exit(1);
  });
}
