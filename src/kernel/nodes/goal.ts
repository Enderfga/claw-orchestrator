/**
 * `goal` node — a `/goal` run on one thread: a Codex `codex-app` thread, or a
 * Claude Code session (`engine: 'claude'`).
 *
 * Codex's app-server runs a goal itself: `thread/goal/set` starts its turn loop,
 * which keeps going until the goal is `complete`, out of budget, blocked, or
 * stopped by a usage limit. Claude Code's `/goal` keeps a session working the
 * same way, through a Stop hook; `ClaudeGoalSession` puts it behind the same
 * surface, so everything below holds for both. What the kernel adds is what a
 * long unattended run needs around that loop:
 *
 *  - **Reattach, never restart.** The thread id is checkpointed as soon as the
 *    session opens. A resumed run hands it to `thread/resume`, and a resume
 *    that comes back on a different thread fails the attempt instead of quietly
 *    starting the objective over. A goal that had already ended when the
 *    process died ends the node with that result; it is not set again.
 *  - **Resume what stalls, within a bound.** A usage-limited goal, a paused
 *    one, or an active goal with no turn and no news for `stallMs` is set back
 *    to `active` after a backoff. Every attempt counts before it is made, and
 *    past `capacityRetry.max` the node fails for good.
 *  - **Repair on the same thread.** Revisited after a red verifier, the node
 *    sets a new objective on the thread it already has — the failing checks
 *    first, then the original objective — so the agent keeps its context.
 *  - **Steer live.** Text from `workflow_steer` goes into the running turn via
 *    `turn/steer`; with no turn running it waits for the next one.
 */

import { randomUUID } from 'node:crypto';
import { SESSION_EVENT } from '../../constants.js';
import type { NodeContext, NodeResult } from '../engine.js';
import type { GoalNode, NodeSpec } from '../types.js';
import { repairBrief } from './agent.js';

export type GoalStatus = 'active' | 'paused' | 'blocked' | 'usageLimited' | 'budgetLimited' | 'complete';

export interface GoalSnapshot {
  objective: string;
  status: GoalStatus;
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
}

/**
 * The goal surface this node drives. `PersistentCodexAppServerSession`
 * implements it for Codex, `ClaudeGoalSession` for Claude Code; `codexThreadId`
 * is the Claude session id there.
 */
export interface GoalSession {
  readonly codexThreadId: string | undefined;
  readonly goal: GoalSnapshot | null;
  readonly lastError: { message: string; code: string | null; willRetry: boolean; at: string } | null;
  readonly turnActive: boolean;
  setGoal(p: { objective?: string; status?: 'active' | 'paused'; tokenBudget?: number | null }): Promise<GoalSnapshot>;
  getGoal(): Promise<GoalSnapshot | null>;
  clearGoal(): Promise<void>;
  steer(text: string): Promise<{ steered: boolean }>;
  interrupt(): Promise<{ interrupted: boolean }>;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  off(event: string, listener: (...args: unknown[]) => void): unknown;
}

/** What the node checkpoints. Readable by `workflow_status` while the goal runs. */
export interface GoalNodeData {
  threadId: string;
  objective: string;
  status: GoalStatus | 'unset';
  tokensUsed: number;
  timeUsedSeconds: number;
  /** Resume attempts made after a usage limit, a pause or a stall. */
  resumes: number;
  /** The agent's last reply, at most 4,000 characters from its end. */
  lastMessage?: string;
  /** The thread's spend so far, priced from codex's cumulative token totals. */
  costUsd?: number;
  /**
   * How much of `costUsd` has been reported to the run. A result reports the
   * difference, so spend from an attempt that never returned — the process was
   * killed — is counted by the attempt that finally does.
   */
  reportedCostUsd?: number;
  lastError?: { message: string; code: string | null; at: string };
  /**
   * The evidence id of the red verdict in force when the current objective was
   * set, if there was one. A finished goal goes back to work only for a red
   * verdict other than this one.
   */
  repairOf?: string;
}

const TERMINAL: ReadonlySet<string> = new Set(['complete', 'budgetLimited', 'blocked']);
/** Error codes that mean "the endpoint is out of capacity right now", not "this goal is wrong". */
const TRANSIENT_ERRORS: ReadonlySet<string> = new Set([
  'serverOverloaded',
  'usageLimitExceeded',
  'rateLimitExceeded',
  'httpConnectionFailed',
  'responseStreamConnectionFailed',
  'responseStreamDisconnected',
  'responseTooManyFailedAttempts',
  'internalServerError',
]);

const DEFAULT_RETRY = { max: 20, backoffMs: 60_000 };
/** Codex refuses a goal objective longer than this many characters. */
export const GOAL_OBJECTIVE_MAX_CHARS = 4_000;
const chars = (s: string) => [...s].length;

/**
 * The objective a revisit sets: what the agent must hear first (steers, the
 * failing checks), then the original objective. The original always survives
 * whole; when the two do not fit in Codex's limit the preface is cut, and the
 * full check output stays in the run's evidence.
 */
export function composeObjective(preface: string[], objective: string): string {
  if (preface.length === 0) return objective;
  const sep = '\n\n---\n\n';
  const cut = '\n[cut to fit the goal objective limit]';
  const head = preface.join('\n\n');
  const room = GOAL_OBJECTIVE_MAX_CHARS - chars(objective) - chars(sep);
  if (chars(head) <= room) return `${head}${sep}${objective}`;
  if (room <= chars(cut)) return objective;
  return `${[...head].slice(0, room - chars(cut)).join('')}${cut}${sep}${objective}`;
}
const MAX_BACKOFF_MS = 15 * 60_000;
const DEFAULT_STALL_MS = 5 * 60_000;
const TICK_MS = 1_000;
/** Progress (tokens, seconds) is checkpointed at most this often; status changes always are. */
const PUBLISH_EVERY_MS = 10_000;
/** The cached goal is refreshed from the server this often, in case a notification was missed. */
const POLL_EVERY_MS = 60_000;

export async function executeGoalNode(node: NodeSpec, ctx: NodeContext): Promise<NodeResult> {
  const spec = node as GoalNode;
  const manager = ctx.manager;
  if (!manager?.goalSession && !manager?.codexGoalSession) {
    return { ok: false, error: 'goal node requires a session manager' };
  }
  const claude = spec.engine === 'claude';
  const engineName = claude ? 'claude' : 'codex-app';
  if (!spec.objective?.trim()) return { ok: false, error: `goal node '${spec.id}' has no objective` };
  if (chars(spec.objective) > GOAL_OBJECTIVE_MAX_CHARS) {
    return {
      ok: false,
      error:
        `goal node '${spec.id}': the objective is ${chars(spec.objective)} characters and a goal accepts at most ` +
        `${GOAL_OBJECTIVE_MAX_CHARS}; put the full brief in a file in the working directory and name that file in the objective`,
    };
  }

  const prior = ctx.record.nodes[spec.id]?.data as GoalNodeData | undefined;
  // Codex writes a thread to disk with its first turn, so a thread whose goal
  // was never set cannot be resumed, and there is nothing on it to keep.
  const priorThread =
    typeof prior?.threadId === 'string' && prior.threadId && (prior.status !== 'unset' || prior.tokensUsed > 0)
      ? prior.threadId
      : undefined;
  // A thread whose goal had not finished is picked up where it was. A finished
  // one goes back to work only for a red verdict its objective was not set
  // against — that is the verifier sending the run back. Without one, the
  // process died after the goal ended but before this node's result was
  // committed, and the goal's own ending is the result.
  const red = ctx.record.outcome === 'refuted' ? ctx.record.verdict?.evidenceId : undefined;
  const finished = !!priorThread && TERMINAL.has(prior?.status ?? '');
  const repairing = finished && red !== undefined && red !== prior?.repairOf;
  const resuming = !!priorThread && !finished;
  // The first visit may start on a thread the caller names; after that the
  // checkpoint decides.
  const startThread = priorThread ?? (spec.threadId?.trim() || undefined);
  const retry = { ...DEFAULT_RETRY, ...spec.capacityRetry };
  const stallMs = spec.stallMs ?? DEFAULT_STALL_MS;

  const data: GoalNodeData = {
    threadId: priorThread ?? '',
    objective: prior?.objective ?? spec.objective,
    status: prior?.status ?? 'unset',
    tokensUsed: prior?.tokensUsed ?? 0,
    timeUsedSeconds: prior?.timeUsedSeconds ?? 0,
    resumes: prior?.resumes ?? 0,
    ...(prior?.lastMessage ? { lastMessage: prior.lastMessage } : {}),
    costUsd: prior?.costUsd ?? 0,
    reportedCostUsd: prior?.reportedCostUsd ?? 0,
    ...(prior?.lastError ? { lastError: prior.lastError } : {}),
    ...(prior?.repairOf ? { repairOf: prior.repairOf } : {}),
  };
  const reported = prior?.reportedCostUsd ?? 0;
  let sessionName = '';
  // Codex reports thread totals, so the spend only ever grows; a reopened
  // session that has not been told the totals yet must not pull it back down.
  const readCost = () => {
    if (!sessionName) return;
    try {
      const cost = manager.getStatus?.(sessionName).stats.costUsd;
      if (typeof cost === 'number' && cost > (data.costUsd ?? 0)) data.costUsd = cost;
    } catch {
      // The session is gone; keep the last figure.
    }
  };
  let lastPublish = 0;
  const publish = (force = false) => {
    const now = Date.now();
    if (!force && now - lastPublish < PUBLISH_EVERY_MS) return;
    lastPublish = now;
    readCost();
    ctx.publish({ ...data });
  };
  const spent = () => {
    readCost();
    const delta = Math.max(0, (data.costUsd ?? 0) - reported);
    data.reportedCostUsd = reported + delta;
    return delta;
  };
  const absorb = (goal: GoalSnapshot | null) => {
    if (!goal) return;
    const changed = goal.status !== data.status;
    data.status = goal.status;
    data.objective = goal.objective;
    data.tokensUsed = goal.tokensUsed;
    data.timeUsedSeconds = goal.timeUsedSeconds;
    publish(changed);
  };
  const fail = (error: string): NodeResult => {
    const costUsd = spent();
    publish(true);
    return { ok: false, error, data: { ...data }, costUsd };
  };
  /** The node's result for a goal in a terminal status; undefined while it is not in one. */
  const ended = (): NodeResult | undefined => {
    if (data.status === 'complete') {
      const costUsd = spent();
      publish(true);
      return {
        ok: true,
        output: `goal complete: ${data.tokensUsed} tokens, ${data.timeUsedSeconds}s`,
        data: { ...data },
        costUsd,
      };
    }
    if (data.status === 'budgetLimited') return fail(`goal stopped: token budget spent (${data.tokensUsed} tokens)`);
    if (data.status === 'blocked') return fail(`goal blocked${data.lastError ? `: ${data.lastError.message}` : ''}`);
    return undefined;
  };

  const settled = finished && !repairing ? ended() : undefined;
  if (settled) {
    ctx.logger.info(`[goal ${ctx.runId}/${spec.id}] the goal had already ended (${data.status}); not setting it again`);
    return settled;
  }

  let lastNews = Date.now();
  // Set by an error the server will not retry itself and that names a capacity
  // problem; cleared by the next sign of life. Read on its own it would stay set
  // after the goal recovered and resume a healthy thread between two turns.
  let capacityError = false;
  let closed = false;
  // The loop naps between checks; any news from the session ends the nap early,
  // so a status change is acted on when it arrives, not on the next tick.
  let wake: (() => void) | null = null;
  const nap = (ms: number) =>
    new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        wake = null;
        resolve();
      };
      const timer = setTimeout(done, Math.max(1, ms));
      timer.unref?.();
      wake = done;
    });
  const onGoal = (...args: unknown[]) => {
    lastNews = Date.now();
    absorb(args[0] as GoalSnapshot | null);
    wake?.();
  };
  const onActivity = () => {
    lastNews = Date.now();
    capacityError = false;
  };
  const onError = (...args: unknown[]) => {
    const e = args[0] as GoalSession['lastError'];
    if (!e) return;
    data.lastError = { message: e.message, code: e.code, at: e.at };
    capacityError = !e.willRetry && TRANSIENT_ERRORS.has(e.code ?? '');
    publish(true);
    wake?.();
  };
  const onClose = () => {
    closed = true;
    wake?.();
  };
  const onResult = (...args: unknown[]) => {
    const text = (args[0] as { result?: unknown } | undefined)?.result;
    if (typeof text === 'string' && text.trim()) data.lastMessage = text.slice(-4000);
  };

  // One session at a time; a new one after the app-server exits, on the same
  // thread. Named per visit, attempt and reopen, so an abandoned attempt that is
  // still unwinding cannot stop the live one's session.
  let session: GoalSession | undefined;
  let opened = 0;
  const release = async () => {
    readCost();
    if (session) {
      session.off('goal:updated', onGoal);
      session.off(SESSION_EVENT.TEXT, onActivity);
      session.off('codex:error', onError);
      session.off(SESSION_EVENT.CLOSE, onClose);
      session.off(SESSION_EVENT.RESULT, onResult);
      session = undefined;
    }
    if (sessionName) await manager.stopSession(sessionName).catch(() => undefined);
  };
  const open = async (threadId: string | undefined): Promise<string | undefined> => {
    await release();
    const visit = ctx.record.nodes[spec.id]?.visits ?? 1;
    sessionName = `${ctx.runId}-${spec.id}-v${visit}a${ctx.attempt}${opened > 0 ? `-r${opened}` : ''}`;
    opened += 1;
    // Claude reports its session id only with a turn's `init`, so a new session
    // is given one up front: the thread is known before the goal is set.
    const claudeId = claude && !threadId ? randomUUID() : undefined;
    try {
      await manager.startSession({
        name: sessionName,
        engine: engineName,
        cwd: spec.cwd || ctx.cwd,
        model: spec.model,
        effort: spec.effort as never,
        ...(claude ? {} : { sandboxMode: spec.sandboxMode }),
        launcher: spec.launcher,
        permissionMode: 'bypassPermissions',
        // The node checkpoints the thread id itself; a registry entry would only
        // let a later session of the same name pick the thread up behind its back.
        // On claude, `noSessionPersistence` also stops the CLI writing the
        // transcript, and a transcript is what `--resume` reattaches.
        ...(claude ? { skipPersistence: true } : { noSessionPersistence: true }),
        ...(threadId ? { resumeSessionId: threadId } : {}),
        ...(claudeId ? { customSessionId: claudeId } : {}),
      });
    } catch (err) {
      return `could not start the ${engineName} session: ${(err as Error).message}`;
    }
    const opening = {
      threadId: threadId ?? claudeId,
      resumed: !!threadId,
      objective: data.objective,
      tokensUsed: data.tokensUsed,
      timeUsedSeconds: data.timeUsedSeconds,
    };
    const live = manager.goalSession
      ? manager.goalSession(sessionName, opening)
      : claude
        ? undefined
        : manager.codexGoalSession?.(sessionName);
    if (!live) return `the ${engineName} session has no goal surface`;
    if (!live.codexThreadId) return `the ${engineName} session has no thread`;
    if (threadId && live.codexThreadId !== threadId) {
      return `could not resume ${claude ? 'claude session' : 'codex thread'} ${threadId} (got ${live.codexThreadId}); refusing to start the goal over`;
    }
    session = live;
    closed = false;
    capacityError = false;
    lastNews = Date.now();
    live.on('goal:updated', onGoal);
    live.on(SESSION_EVENT.TEXT, onActivity);
    live.on('codex:error', onError);
    live.on(SESSION_EVENT.CLOSE, onClose);
    live.on(SESSION_EVENT.RESULT, onResult);
    data.threadId = live.codexThreadId;
    publish(true);
    return undefined;
  };

  ctx.setHandle({ abort: () => undefined });
  const steers: string[] = [];
  try {
    const opening = await open(startThread);
    if (opening) return fail(opening);

    // ── Set or pick up the goal ────────────────────────────────────────────
    if (resuming) {
      const goal = await session!.getGoal();
      if (goal) {
        absorb(goal);
        if (goal.status === 'paused' || goal.status === 'usageLimited') {
          absorb(await session!.setGoal({ status: 'active' }));
        }
      } else {
        absorb(await session!.setGoal({ objective: data.objective, tokenBudget: spec.tokenBudget ?? null }));
      }
    } else {
      const preface = [...ctx.takeSteer(), ...(priorThread ? [repairBrief(ctx, spec.id)] : [])].filter(
        (t): t is string => !!t,
      );
      const objective = composeObjective(preface, spec.objective);
      if (startThread) await session!.clearGoal();
      const goal = await session!.setGoal({ objective, tokenBudget: spec.tokenBudget ?? null });
      data.repairOf = red;
      absorb(goal);
    }
    publish(true);

    // ── Wait for the goal to finish ────────────────────────────────────────
    let lastPoll = Date.now();
    let retryAt: number | null = null;
    // One counter for every kind of recovery: counted when scheduled, not when
    // it succeeds, so a recovery that keeps failing still reaches the bound.
    const spendRecovery = (why: string): NodeResult | undefined => {
      data.resumes += 1;
      publish(true);
      if (data.resumes > retry.max) {
        return fail(
          `goal did not recover after ${retry.max} resume attempts (last: ${why}${
            data.lastError ? `, ${data.lastError.code ?? data.lastError.message}` : ''
          })`,
        );
      }
      const backoff = Math.min(MAX_BACKOFF_MS, retry.backoffMs * 2 ** Math.min(data.resumes - 1, 10));
      retryAt = Date.now() + backoff;
      ctx.logger.info(`[goal ${ctx.runId}/${spec.id}] ${why}; resuming in ${backoff}ms`);
      return undefined;
    };

    for (;;) {
      if (ctx.signal.aborted) {
        await session?.interrupt().catch(() => undefined);
        await session?.setGoal({ status: 'paused' }).catch(() => undefined);
        return fail('cancelled');
      }

      if (closed) {
        // The engine process is gone; the thread is on disk. Reattach after a backoff.
        if (retryAt === null) {
          const stop = spendRecovery(claude ? 'the claude process exited' : 'the codex app-server exited');
          if (stop) return stop;
        }
        if (Date.now() >= (retryAt ?? 0)) {
          retryAt = null;
          const reopening = await open(data.threadId);
          if (reopening) return fail(reopening);
          const goal = await session!.getGoal();
          absorb(goal);
          if (goal && (goal.status === 'paused' || goal.status === 'usageLimited')) {
            absorb(await session!.setGoal({ status: 'active' }));
          }
        }
        await nap(Math.min(TICK_MS, Math.max(0, (retryAt ?? 0) - Date.now())));
        continue;
      }
      const live = session!;

      steers.push(...ctx.takeSteer());
      while (steers.length > 0 && live.turnActive) {
        const r = await live.steer(steers[0]).catch(() => ({ steered: false }));
        if (!r.steered) break;
        steers.shift();
      }

      if (Date.now() - lastPoll >= POLL_EVERY_MS) {
        lastPoll = Date.now();
        absorb(await live.getGoal().catch(() => live.goal));
      }

      const end = ended();
      if (end) return end;

      const status = data.status;
      const stalled = status === 'active' && !live.turnActive && (Date.now() - lastNews >= stallMs || capacityError);
      const needsResume = status === 'paused' || status === 'usageLimited' || stalled;
      if (!needsResume) {
        retryAt = null;
      } else if (retryAt === null) {
        const stop = spendRecovery(stalled ? 'stalled' : status);
        if (stop) return stop;
      } else if (Date.now() >= retryAt) {
        retryAt = null;
        lastNews = Date.now();
        capacityError = false;
        absorb(await live.setGoal({ status: 'active' }).catch(() => live.goal));
      }

      const untilRetry = retryAt === null ? TICK_MS : retryAt - Date.now();
      const untilStall = stallMs - (Date.now() - lastNews);
      await nap(Math.min(TICK_MS, untilRetry, Math.max(1, untilStall)));
    }
  } catch (err) {
    return fail(`goal node failed: ${(err as Error).message}`);
  } finally {
    await release();
  }
}
