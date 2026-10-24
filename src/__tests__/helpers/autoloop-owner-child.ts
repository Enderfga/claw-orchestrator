/**
 * Owner-process child for abrupt-loss autoloop tests.
 *
 * Env:
 *   AUTOLOOP_MODE        committed-iter | planner-only | closed-iterations |
 *                        paused-input | hung-planner-send
 *   AUTOLOOP_RUN_ID      kernel run id
 *   AUTOLOOP_WORKSPACE   git workspace shared with the parent
 *   CLAWO_WF_DIR         shared run store
 *   AUTOLOOP_CLOSE_COUNT for closed-iterations: how many iters (0..N-1) to close
 *
 * Public API only: SessionManager.autoloopStart / autoloopChat.
 * Reviewer send in committed-iter never settles; stdout emits READY once
 * that send has started (or once start returns, for planner-only).
 * closed-iterations closes N verdicts via the real runner/dispatcher, then
 * emits READY and hangs so the parent can SIGKILL an owner with a current
 * closed-ledger checkpoint.
 * paused-input: Planner pause_loop, accept U1 then U2 while paused (public
 * autoloopChat), emit READY only after both acceptances return, then hang.
 * hung-planner-send: first Planner send never settles; emit READY only once
 * that send has started AND the store shows inFlightChat for this run (candidate
 * checkpoint field), then hang (parent SIGKILL mid-send). Not the same as
 * paused-input. Uses loadRun only — no runner-private recovery APIs.
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
import { loadRun } from '../../kernel/store.js';

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

function coderComplete(iter: number, metric: number): string {
  return fence('iter_complete', {
    summary: `closed-iterations iter ${iter}`,
    eval_output: { metric, gates: [] },
  });
}

function reviewAdvance(iter: number, metric: number): string {
  return fence('review_complete', {
    decision: 'advance',
    metric,
    audit_notes: `closed-iterations verdict ${iter}`,
  });
}

function sendDirective(iter: number): string {
  return fence('send_directive', {
    goal: `close iteration ${iter}`,
    constraints: ['closed-iterations owner mode'],
    success_criteria: [`iter ${iter} has verdict.json`],
    max_attempts: 1,
  });
}

function parseDirectiveIter(message: string | unknown[]): number | null {
  const text = typeof message === 'string' ? message : JSON.stringify(message);
  const m = text.match(/\[directive iter=(\d+)\]/);
  return m ? Number(m[1]) : null;
}

function parseReviewIter(message: string | unknown[]): number | null {
  const text = typeof message === 'string' ? message : JSON.stringify(message);
  const m = text.match(/\[review_request iter=(\d+)\]/);
  return m ? Number(m[1]) : null;
}

function parseIterDone(message: string | unknown[]): number | null {
  const text = typeof message === 'string' ? message : JSON.stringify(message);
  const m = text.match(/\[system\] iter (\d+) done\./);
  return m ? Number(m[1]) : null;
}

type OwnerBehavior = 'paused-input' | 'hung-planner-send' | null;

class OwnerMockSession extends EventEmitter implements ISession {
  sessionId?: string;
  private readonly role: 'planner' | 'coder' | 'reviewer' | 'other';
  private readonly workspace: string;
  private readonly closeCount: number | null;
  private readonly behavior: OwnerBehavior;
  private readonly ownerCtx: { mgr: SessionManager; runId: string } | null;
  private plannerReplies = 0;

  constructor(
    config: SessionConfig,
    workspace: string,
    closeCount: number | null = null,
    behavior: OwnerBehavior = null,
    ownerCtx: { mgr: SessionManager; runId: string } | null = null,
  ) {
    super();
    this.workspace = workspace;
    this.closeCount = closeCount;
    this.behavior = behavior;
    this.ownerCtx = ownerCtx;
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
    if (this.behavior === 'hung-planner-send' && this.role === 'planner') {
      // Handoff commits inFlightChat before deliver() awaits this send. Poll the
      // store (public loadRun) until the marker is visible, then READY.
      const runId = this.ownerCtx?.runId;
      if (!runId) {
        process.stderr.write('hung-planner-send: READY refused — missing runId\n');
        process.exit(1);
      }
      const deadline = Date.now() + 10_000;
      let marked = false;
      while (Date.now() < deadline) {
        const rec = loadRun(runId);
        const data = rec?.nodes?.main?.data as { inFlightChat?: { msg_id?: string } | null } | undefined;
        if (data?.inFlightChat && typeof data.inFlightChat.msg_id === 'string') {
          marked = true;
          break;
        }
        await new Promise<void>((r) => setImmediate(r));
      }
      if (!marked) {
        process.stderr.write('hung-planner-send: READY refused — inFlightChat not in store\n');
        process.exit(1);
      }
      process.stdout.write('READY\n');
      await new Promise(() => undefined);
      return { text: 'unreachable', event: { type: 'result', result: 'ok' } };
    }
    if (this.behavior === 'paused-input' && this.role === 'planner') {
      this.plannerReplies += 1;
      if (this.plannerReplies === 1) {
        return {
          text: fence('pause_loop', { reason: 'operator-hold' }),
          event: { type: 'result', result: 'ok' },
        };
      }
      return { text: 'ack', event: { type: 'result', result: 'ok' } };
    }
    if (this.closeCount !== null) {
      if (this.role === 'planner') {
        const text = typeof message === 'string' ? message : JSON.stringify(message);
        const doneIter = parseIterDone(message);
        if (doneIter !== null) {
          const next = doneIter + 1;
          if (next < this.closeCount) {
            return { text: sendDirective(next), event: { type: 'result', result: 'ok' } };
          }
          return { text: 'closed-iterations: ledger closed', event: { type: 'result', result: 'ok' } };
        }
        if (text.includes('directive_ack') || text.includes('[system] coder')) {
          return { text: 'ack noted', event: { type: 'result', result: 'ok' } };
        }
        return { text: PLANNER_SPAWN, event: { type: 'result', result: 'ok' } };
      }
      if (this.role === 'coder') {
        const iter = parseDirectiveIter(message) ?? 0;
        const metric = 100 + iter;
        fs.writeFileSync(path.join(this.workspace, `closed-${iter}.txt`), `closed-bytes-${iter}\n`);
        return { text: coderComplete(iter, metric), event: { type: 'result', result: 'ok' } };
      }
      if (this.role === 'reviewer') {
        const iter = parseReviewIter(message) ?? 0;
        const metric = 100 + iter;
        return { text: reviewAdvance(iter, metric), event: { type: 'result', result: 'ok' } };
      }
    }
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

function patchCreateSession(
  manager: SessionManager,
  workspace: string,
  closeCount: number | null = null,
  behavior: OwnerBehavior = null,
  runId: string | null = null,
): void {
  const ownerCtx = runId ? { mgr: manager, runId } : null;
  (manager as unknown as { _createSession: (engine: string, config: SessionConfig) => ISession })._createSession = (
    _engine: string,
    config: SessionConfig,
  ): ISession => new OwnerMockSession(config, workspace, closeCount, behavior, ownerCtx);
}

async function main(): Promise<void> {
  const mode = process.env.AUTOLOOP_MODE;
  const runId = process.env.AUTOLOOP_RUN_ID;
  const workspace = process.env.AUTOLOOP_WORKSPACE;
  if (!runId || !workspace) throw new Error('AUTOLOOP_RUN_ID and AUTOLOOP_WORKSPACE are required');
  if (
    mode !== 'committed-iter' &&
    mode !== 'planner-only' &&
    mode !== 'closed-iterations' &&
    mode !== 'paused-input' &&
    mode !== 'hung-planner-send'
  ) {
    throw new Error(`unknown AUTOLOOP_MODE ${String(mode)}`);
  }

  const closeCount =
    mode === 'closed-iterations' ? Math.max(1, Number(process.env.AUTOLOOP_CLOSE_COUNT ?? '2') || 2) : null;
  const behavior: OwnerBehavior = mode === 'paused-input' || mode === 'hung-planner-send' ? mode : null;

  const mgr = new SessionManager({
    claudeBin: 'mock-claude',
    maxConcurrentSessions: 5,
    sessionTtlMinutes: 120,
    defaultPermissionMode: 'acceptEdits',
  });
  patchCreateSession(mgr, workspace, closeCount, behavior, runId);

  await mgr.autoloopStart({ runId, workspace });
  if (mode === 'planner-only') {
    process.stdout.write('READY\n');
    await new Promise(() => undefined);
    return;
  }
  if (mode === 'closed-iterations') {
    await mgr.autoloopChat(runId, `close ${closeCount} iterations then park`);
    const ledgerIter = path.join(workspace, 'tasks', runId, 'iter');
    const target = closeCount!;
    for (let i = 0; i < target; i++) {
      const verdict = path.join(ledgerIter, String(i), 'verdict.json');
      if (!fs.existsSync(verdict)) {
        throw new Error(`closed-iterations missing verdict for iter ${i}`);
      }
    }
    process.stdout.write('READY\n');
    await new Promise(() => undefined);
    return;
  }
  if (mode === 'paused-input') {
    const handle = mgr.getAutoloop(runId);
    if (!handle) throw new Error('paused-input: missing live handle after start');
    await mgr.autoloopChat(runId, 'pause-trigger');
    if (handle.runner.state.status !== 'paused') {
      throw new Error(`paused-input: expected paused, got ${handle.runner.state.status}`);
    }
    // Acceptance = public autoloopChat resolved while paused (park returned).
    await mgr.autoloopChat(runId, 'U1');
    await mgr.autoloopChat(runId, 'U2');
    process.stdout.write('READY\n');
    await new Promise(() => undefined);
    return;
  }
  if (mode === 'hung-planner-send') {
    // Do not await: Planner send hangs; READY fires once that send has started.
    void mgr.autoloopChat(runId, 'hanging-planner-send');
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
