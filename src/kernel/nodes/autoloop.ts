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
import type { AutoloopState } from '../../autoloop/types.js';
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
}

export interface AutoloopNodeDeps {
  /** `secrets` carries what the spec deliberately does not — custom-engine configs. */
  boot(
    config: Record<string, unknown>,
    secrets: Record<string, unknown>,
    opts: { freshStart: boolean; restoredInput?: AutoloopInputSnapshot },
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
}

/** The payload `autoloopStateFromRecord` reads back. */
export interface AutoloopNodeData {
  state: AutoloopState;
  plannerSession: string;
  /** Engines/models actually in use, as chosen by `spawn_subagents`. */
  roleSelection?: Record<string, unknown>;
  /** Accepted chat not yet handed to the dispatcher, in order. */
  pendingChat?: ReadonlyArray<PendingChatEntry>;
  /** The accepted chat whose physical send may have started. */
  inFlightChat?: InFlightChat | null;
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

export function makeAutoloopExecutor(deps: AutoloopNodeDeps) {
  return async function executeAutoloopNode(node: NodeSpec, ctx: NodeContext): Promise<NodeResult> {
    const spec = node as AutoloopNode;
    const readyKey = ctx.tag ?? ctx.runId;
    let handle: AutoloopHandle;
    let restoredInput: AutoloopInputSnapshot | undefined;
    try {
      // Kernel commits visits += 1 before execute; first visit in the run is fresh.
      const freshStart = ctx.record.nodes[node.id]?.visits === 1;
      if (!freshStart) restoredInput = validateStoredInput(ctx.record.nodes[node.id]?.data);
      handle = await deps.boot(spec.config, ctx.secrets, { freshStart, restoredInput });
    } catch (err) {
      deps.ready(readyKey, err as Error);
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
      deps.ready(readyKey, new Error(AUTOLOOP_RESTORE_UNPERSISTED));
      return { ok: false, error: AUTOLOOP_RESTORE_UNPERSISTED };
    }
    // The runner emits state after it writes pause fields (send timeout and
    // operator pause). Re-publish that snapshot so a non-owning autoloop_status
    // can read it while this process still owns the live handle.
    handle.runner.on('state', publish);
    handle.runner.reconcileRestoredInput?.();
    deps.ready(readyKey, {
      plannerSession: handle.dispatcher.sessionNames.planner,
      state: handle.runner.state,
    });
    handle.runner.releaseRestoredInput?.();

    try {
      await deps.waitForExit(handle, ctx.signal);
    } finally {
      handle.runner.off('state', publish);
      deps.unregisterPublisher(ctx.runId);
    }
    publish();

    const status = handle.runner.state.status;
    return {
      ok: status !== 'crashed',
      output: `autoloop ${status} at iter ${handle.runner.state.iter}`,
      error: status === 'crashed' ? (handle.runner.state.status_reason ?? 'autoloop crashed') : undefined,
      data: nodePayload(handle, deps.extra(ctx.runId)),
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
