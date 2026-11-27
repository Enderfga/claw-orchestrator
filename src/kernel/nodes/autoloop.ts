/**
 * `autoloop` node — a long-lived Planner / Coder / Reviewer loop.
 *
 * Unlike every other node kind this one settles when the loop terminates, not
 * when a turn returns: the user chats with the Planner for as long as the work
 * takes. That is precisely why it belongs here rather than in a private map —
 * the run it lives in is the thing that has to survive a restart, be listable
 * from another process, and be cancellable by one owner.
 *
 * The engine itself is built by SessionManager (it needs sessions, prompts and
 * push channels), so SessionManager registers this executor with a builder
 * closed over itself. The node spec carries only JSON, because it is
 * checkpointed with the run.
 */

import type { NodeContext, NodeResult } from '../engine.js';
import type { AutoloopNode, NodeSpec, RunRecord } from '../types.js';
import type { AutoloopRoleBindings, AutoloopRoleName, AutoloopState } from '../../autoloop/types.js';
import type { AutoloopForumTarget } from '../../autoloop/forum-bridge.js';
import { AUTOLOOP_FORUM_ROLES, autoloopForumName, runForum } from '../forum.js';
import { EFFORT_LEVELS, ENGINE_TYPES, type EffortLevel, type EngineType } from '../../types.js';
import {
  MAX_PENDING_CHAT,
  MAX_PENDING_CHAT_BYTES,
  pendingChatBytes,
  type AutoloopInputSnapshot,
  type InFlightChat,
  type PendingChatEntry,
  type UnconfirmedChatStatus,
} from '../../autoloop/runner.js';

export const AUTOLOOP_RESTORE_MALFORMED = 'Autoloop resume refused: stored chat checkpoint is malformed';
export const AUTOLOOP_RESTORE_UNPERSISTED = 'Autoloop resume refused: pending chat could not be checkpointed';

/** Whatever SessionManager hands back from booting the loop. */
export interface AutoloopHandle {
  runner: {
    state: AutoloopState;
    stop(): void;
    on(event: 'state', listener: () => void): unknown;
    off(event: 'state', listener: () => void): unknown;
    /** The accepted-chat snapshot the next checkpoint should carry. */
    checkpointInput?(): AutoloopInputSnapshot;
    /** Before ready: record a restored in-flight marker as a notice. */
    reconcileRestoredInput?(): void;
    /** After ready: queue or park restored pending chat. */
    releaseRestoredInput?(): void;
  };
  dispatcher: {
    sessionNames: { planner: string };
    shutdown(reason: string, opts?: { purge?: boolean }): Promise<void>;
  };
  ledgerDir: string;
  /** Called synchronously by `RunKernel.cancel`. */
  abort?(): void;
  /**
   * The loop on its run's forum; closed when the node ends. `handedOver`: whether
   * this process handed a post to a role, in a turn it sent or mid-turn.
   */
  forum?: { close(): void; flush?(): Promise<void>; handedOver?(postId: string): boolean };
  /**
   * After the initial publish and notice reconciliation, before `ready`.
   * SessionManager uses this for committed-iteration recovery so it cannot
   * send before the publisher gate. Failure rejects the start the same way
   * a refused initial publish does.
   */
  afterPublishReconcile?(): Promise<void>;
}

export interface AutoloopNodeDeps {
  /** `secrets` carries what the spec deliberately does not — custom-engine configs. */
  boot(
    config: Record<string, unknown>,
    secrets: Record<string, unknown>,
    opts: {
      freshStart: boolean;
      restoredInput?: AutoloopInputSnapshot;
      roleBindings?: AutoloopRoleBindings;
      /** The run's forum and the roles' names on it. */
      forum?: AutoloopForumTarget;
      /** The kernel run the role sessions belong to. */
      ownerRunId?: string;
    },
  ): Promise<AutoloopHandle>;
  /**
   * Resolve/reject the deferred the caller is waiting on.
   *
   * Keyed by the start's tag, not the run id: a failed start frees its run id
   * for a retry, and keying on the id let a dying start settle — or clear — the
   * retry's deferred instead of its own.
   */
  ready(key: string, value: { plannerSession: string; state: AutoloopState } | Error): void;
  /** Wait until the loop reaches a terminal status. */
  waitForExit(handle: AutoloopHandle, signal: { aborted: boolean }): Promise<void>;
  /**
   * Hand back a way to refresh the checkpoint mid-run. The loop's role
   * selection changes when `spawn_subagents` picks engines, and that has to
   * reach the record — it used to be written to the registry file. Returns
   * true only when the refreshed payload was committed.
   */
  registerPublisher(runId: string, publish: () => boolean): void;
  unregisterPublisher(runId: string): void;
  /** Extra payload to publish alongside the state (currently the role selection). */
  extra(runId: string): Record<string, unknown>;
  /**
   * The node is finishing, on any path, after its last publish: drop what
   * `extra` held for the run. Called synchronously, so it adds no delay.
   */
  release?(runId: string): void;
}

/** The payload `autoloopStateFromRecord` reads back. */
export interface AutoloopNodeData {
  state: AutoloopState;
  plannerSession: string;
  /** Engines/models actually in use, as chosen by `spawn_subagents`. */
  roleSelection?: Record<string, unknown>;
  /** Role bindings applied by an operator rebind; a resume starts those roles with them. */
  roleBindings?: AutoloopRoleBindings;
  /** Accepted chat not yet handed to the dispatcher, in order. */
  pendingChat?: ReadonlyArray<PendingChatEntry>;
  /** The accepted chat whose physical send may have started. */
  inFlightChat?: InFlightChat | null;
}

const AUTOLOOP_ROLES = ['planner', 'coder', 'reviewer'] as const;

/**
 * Read the stored role bindings. Anything malformed is ignored as a whole and
 * the run resumes with its start-time roles, rather than with a partial or
 * invented binding.
 */
export function validateStoredRoleBindings(data: unknown): AutoloopRoleBindings | undefined {
  if (!isRecord(data) || !isRecord(data.roleBindings)) return undefined;
  const out: AutoloopRoleBindings = {};
  for (const [role, raw] of Object.entries(data.roleBindings)) {
    if (!(AUTOLOOP_ROLES as readonly string[]).includes(role) || !isRecord(raw)) return undefined;
    const { engine, model, effort } = raw;
    if (typeof engine !== 'string' || !ENGINE_TYPES.includes(engine as EngineType) || engine === 'custom') {
      return undefined;
    }
    if (model !== undefined && typeof model !== 'string') return undefined;
    if (effort !== undefined && !EFFORT_LEVELS.includes(effort as EffortLevel)) return undefined;
    out[role as (typeof AUTOLOOP_ROLES)[number]] = {
      engine: engine as EngineType,
      ...(model === undefined ? {} : { model }),
      ...(effort === undefined ? {} : { effort: effort as EffortLevel }),
    };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** The boot config fields a set of bindings replaces: `<role>Engine`, `<role>Model`, `<role>Effort`. */
export function autoloopBindingConfig(bindings: AutoloopRoleBindings | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const role of AUTOLOOP_ROLES) {
    const b = bindings?.[role];
    if (!b) continue;
    out[`${role}Engine`] = b.engine;
    out[`${role}Model`] = b.model;
    out[`${role}Effort`] = b.effort;
  }
  return out;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isIsoTimestamp = (value: unknown): value is string => {
  if (typeof value !== 'string') return false;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value;
};

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/**
 * Validate the accepted-chat fields of a stored node payload. Absent fields
 * restore as empty; anything malformed or over the acceptance bounds is
 * refused with one fixed error.
 */
export function validateStoredInput(data: unknown): AutoloopInputSnapshot {
  const refuse = (): never => {
    throw new Error(AUTOLOOP_RESTORE_MALFORMED);
  };
  if (data === undefined || data === null) return { pendingChat: [], inFlightChat: null };
  if (!isRecord(data)) return refuse();

  const pendingChat: PendingChatEntry[] = [];
  if (data.pendingChat !== undefined) {
    if (!Array.isArray(data.pendingChat) || data.pendingChat.length > MAX_PENDING_CHAT) return refuse();
    const ids = new Set<string>();
    for (const raw of data.pendingChat as unknown[]) {
      if (!isRecord(raw)) return refuse();
      const { msg_id, iter, ts, text } = raw;
      if (typeof msg_id !== 'string' || msg_id.length === 0 || ids.has(msg_id)) return refuse();
      if (!isCount(iter) || !isIsoTimestamp(ts) || typeof text !== 'string') return refuse();
      ids.add(msg_id);
      pendingChat.push({ msg_id, iter, ts, text });
    }
    if (pendingChatBytes(pendingChat) > MAX_PENDING_CHAT_BYTES) return refuse();
  }

  let inFlightChat: InFlightChat | null = null;
  if (data.inFlightChat !== undefined && data.inFlightChat !== null) {
    const raw = data.inFlightChat;
    if (!isRecord(raw) || typeof raw.msg_id !== 'string' || raw.msg_id.length === 0) return refuse();
    if (!isIsoTimestamp(raw.handed_at)) return refuse();
    inFlightChat = { msg_id: raw.msg_id, handed_at: raw.handed_at };
  }

  let unconfirmed: UnconfirmedChatStatus | undefined;
  const state = data.state;
  if (isRecord(state) && state.unconfirmed_chat !== undefined) {
    const raw = state.unconfirmed_chat;
    if (!isRecord(raw) || !isCount(raw.count) || !isIsoTimestamp(raw.last_at)) return refuse();
    if (typeof raw.history_pending !== 'boolean') return refuse();
    unconfirmed = { count: raw.count, last_at: raw.last_at, history_pending: raw.history_pending };
  }

  return { pendingChat, inFlightChat, ...(unconfirmed ? { unconfirmed } : {}) };
}

function hasObligations(input: AutoloopInputSnapshot | undefined): boolean {
  return Boolean(input && (input.pendingChat.length > 0 || input.inFlightChat || input.unconfirmed?.history_pending));
}

function nodePayload(handle: AutoloopHandle, extra: Record<string, unknown>): AutoloopNodeData {
  const input = handle.runner.checkpointInput?.();
  const state: AutoloopState = { ...handle.runner.state };
  if (input?.unconfirmed) state.unconfirmed_chat = input.unconfirmed;
  else delete state.unconfirmed_chat;
  return {
    state,
    plannerSession: handle.dispatcher.sessionNames.planner,
    ...extra,
    ...(input && input.pendingChat.length > 0 ? { pendingChat: input.pendingChat } : {}),
    ...(input?.inFlightChat ? { inFlightChat: input.inFlightChat } : {}),
  };
}

/**
 * Where a loop's roles are on its run's forum. Every run has a forum log the
 * loop's envelopes are mirrored to; the roles are members only when the run
 * exposes its forum and the node does not opt out with `config.forum: false`.
 */
export function autoloopForumTarget(ctx: NodeContext, node: AutoloopNode): AutoloopForumTarget {
  // A subflow's child run puts its prefix in front of the names, as the roster does.
  const prefix = runForum(ctx.record).prefix ?? '';
  const names = Object.fromEntries(
    AUTOLOOP_FORUM_ROLES.map((role) => [role, `${prefix}${autoloopForumName(ctx.record.spec, node.id, role)}`]),
  ) as Record<AutoloopRoleName, string>;
  return {
    id: ctx.forum.id,
    config: ctx.forum.config,
    exposed: ctx.forum.exposed && node.config?.forum !== false,
    names,
    post: (input) => ctx.forumPost(input),
  };
}

function firstLine(text: string, max: number): string {
  const line = (text.split('\n').find((l) => l.trim()) ?? '').replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/**
 * The steers a running loop takes. A steer is the user's post on the run forum,
 * which reaches the Planner and the Coder mid-turn or with their next turn, so
 * the node only takes it off the kernel's queue. One that reached no role by
 * the time the node ends goes back, for whatever runs next. A run whose roles
 * are on no forum takes none: nothing would hand them over.
 *
 * Whether a role had a steer's post is what the bridge handed over in this
 * process (`handedOver`), never the forum's delivery records, which agents can
 * write. The kernel counts consumption over the log's order, so what goes back
 * is the tail of what was taken, from the first steer no role had.
 */
function steerTaker(
  ctx: NodeContext,
  forum: AutoloopForumTarget,
  handedOver: (postId: string) => boolean,
): { take(): void; giveBack(): void } {
  const taken: Array<{ text: string; postId?: string }> = [];
  return {
    take() {
      if (!forum.exposed) return;
      for (const e of ctx.takeSteerEntries()) {
        const entry: { text: string; postId?: string } = { text: e.text, ...(e.postId ? { postId: e.postId } : {}) };
        taken.push(entry);
        if (entry.postId) continue;
        // A steer written with no post of its own: post it as the user's now.
        void ctx
          .forumPost({
            from: 'user',
            title: `FIX: ${firstLine(e.text, 110) || 'steer'}`,
            body: e.text,
            data: { kind: 'steer' },
          })
          .then((post) => {
            if (post) entry.postId = post.id;
          });
      }
    },
    giveBack() {
      if (taken.length === 0) return;
      const first = taken.findIndex((e) => !e.postId || !handedOver(e.postId));
      const back = first < 0 ? [] : taken.slice(first).map((e) => e.text);
      taken.length = 0;
      if (back.length) ctx.untakeSteer(back);
    },
  };
}

export function makeAutoloopExecutor(deps: AutoloopNodeDeps) {
  return async function executeAutoloopNode(node: NodeSpec, ctx: NodeContext): Promise<NodeResult> {
    const spec = node as AutoloopNode;
    const readyKey = ctx.tag ?? ctx.runId;
    let handle: AutoloopHandle;
    let restoredInput: AutoloopInputSnapshot | undefined;
    let forum: AutoloopForumTarget;
    try {
      forum = autoloopForumTarget(ctx, spec);
      // Kernel commits visits += 1 before execute; first visit in the run is fresh.
      const freshStart = ctx.record.nodes[node.id]?.visits === 1;
      let roleBindings: AutoloopRoleBindings | undefined;
      if (!freshStart) {
        restoredInput = validateStoredInput(ctx.record.nodes[node.id]?.data);
        roleBindings = validateStoredRoleBindings(ctx.record.nodes[node.id]?.data);
      }
      handle = await deps.boot(spec.config, ctx.secrets, {
        freshStart,
        restoredInput,
        roleBindings,
        forum,
        ownerRunId: ctx.runId,
      });
    } catch (err) {
      deps.ready(readyKey, err as Error);
      deps.release?.(ctx.runId);
      return { ok: false, error: (err as Error).message };
    }

    ctx.setHandle(handle);
    const publish = (): boolean => ctx.publish(nodePayload(handle, deps.extra(ctx.runId)));
    deps.registerPublisher(ctx.runId, publish);
    if (!publish() && hasObligations(restoredInput)) {
      // Restored chat that cannot be checkpointed must not be delivered.
      deps.unregisterPublisher(ctx.runId);
      handle.runner.stop();
      await handle.dispatcher.shutdown('start-failed').catch(() => undefined);
      handle.forum?.close();
      deps.ready(readyKey, new Error(AUTOLOOP_RESTORE_UNPERSISTED));
      deps.release?.(ctx.runId);
      return { ok: false, error: AUTOLOOP_RESTORE_UNPERSISTED };
    }
    // The runner emits state after it writes pause fields (send timeout and
    // operator pause). Re-publish that snapshot so a non-owning autoloop_status
    // can read it while this process still owns the live handle.
    handle.runner.on('state', publish);
    handle.runner.reconcileRestoredInput?.();
    try {
      await handle.afterPublishReconcile?.();
    } catch (err) {
      handle.runner.off('state', publish);
      deps.unregisterPublisher(ctx.runId);
      handle.runner.stop();
      await handle.dispatcher.shutdown('start-failed').catch(() => undefined);
      handle.forum?.close();
      deps.ready(readyKey, err as Error);
      deps.release?.(ctx.runId);
      return { ok: false, error: (err as Error).message };
    }
    deps.ready(readyKey, {
      plannerSession: handle.dispatcher.sessionNames.planner,
      state: handle.runner.state,
    });
    handle.runner.releaseRestoredInput?.();

    // Steers are taken as the loop runs; the user's posts they were written as
    // reach the roles by themselves.
    const steers = steerTaker(ctx, forum, (postId) => handle.forum?.handedOver?.(postId) ?? false);
    const takeSteers = (): void => {
      try {
        steers.take();
      } catch (err) {
        ctx.logger.warn?.(`[autoloop ${ctx.runId}] could not take steers: ${(err as Error).message}`);
      }
    };
    takeSteers();
    const steerPoll = setInterval(takeSteers, 1_000);
    steerPoll.unref?.();
    handle.runner.on('state', takeSteers);

    try {
      await deps.waitForExit(handle, ctx.signal);
    } catch (err) {
      deps.release?.(ctx.runId);
      throw err;
    } finally {
      clearInterval(steerPoll);
      handle.runner.off('state', takeSteers);
      handle.runner.off('state', publish);
      deps.unregisterPublisher(ctx.runId);
      await handle.forum?.flush?.().catch(() => undefined);
      handle.forum?.close();
      steers.giveBack();
    }
    publish();

    const status = handle.runner.state.status;
    const data = nodePayload(handle, deps.extra(ctx.runId));
    deps.release?.(ctx.runId);
    return {
      ok: status !== 'crashed',
      output: `autoloop ${status} at iter ${handle.runner.state.iter}`,
      error: status === 'crashed' ? (handle.runner.state.status_reason ?? 'autoloop crashed') : undefined,
      data,
    };
  };
}

/**
 * Rebuild an `AutoloopState` for a run that is not live in this process.
 *
 * The registry fallback this replaces returned an all-zero stub with
 * `status_reason: 'reconstructed from registry — not in current process memory'`
 * — iter 0, no metrics, no error history — because the registry only ever held
 * identity, never state. The record holds the last state the loop published.
 */
export function autoloopStateFromRecord(record: RunRecord): AutoloopState | undefined {
  const data = record.nodes.main?.data as AutoloopNodeData | undefined;
  if (!data?.state) return undefined;
  const terminal = record.state === 'completed' || record.state === 'failed' || record.state === 'cancelled';
  const state: AutoloopState =
    terminal && data.state.status !== 'terminated' && data.state.status !== 'crashed'
      ? { ...data.state, status: 'terminated', status_reason: data.state.status_reason ?? `run ${record.state}` }
      : data.state;
  const inFlight = data.inFlightChat;
  if (!isRecord(inFlight) || typeof inFlight.handed_at !== 'string') return state;
  // A stored marker is a delivery nobody has confirmed yet.
  const prev = state.unconfirmed_chat;
  return {
    ...state,
    unconfirmed_chat: { count: prev?.count ?? 0, last_at: prev?.last_at ?? inFlight.handed_at, history_pending: true },
  };
}
