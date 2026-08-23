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

/** Whatever SessionManager hands back from booting the loop. */
export interface AutoloopHandle {
  runner: { state: AutoloopState; stop(): void };
  dispatcher: {
    sessionNames: { planner: string };
    shutdown(reason: string, opts?: { purge?: boolean }): Promise<void>;
  };
  ledgerDir: string;
}

export interface AutoloopNodeDeps {
  boot(config: Record<string, unknown>): Promise<AutoloopHandle>;
  /** Resolve/reject the deferred `autoloopStart` is waiting on. */
  ready(runId: string, value: { plannerSession: string; state: AutoloopState } | Error): void;
  /** Wait until the loop reaches a terminal status. */
  waitForExit(handle: AutoloopHandle, signal: { aborted: boolean }): Promise<void>;
  /**
   * Hand back a way to refresh the checkpoint mid-run. The loop's role
   * selection changes when `spawn_subagents` picks engines, and that has to
   * reach the record — it used to be written to the registry file.
   */
  registerPublisher(runId: string, publish: () => void): void;
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
}

export function makeAutoloopExecutor(deps: AutoloopNodeDeps) {
  return async function executeAutoloopNode(node: NodeSpec, ctx: NodeContext): Promise<NodeResult> {
    const spec = node as AutoloopNode;
    let handle: AutoloopHandle;
    try {
      handle = await deps.boot(spec.config);
    } catch (err) {
      deps.ready(ctx.runId, err as Error);
      return { ok: false, error: (err as Error).message };
    }

    ctx.setHandle(handle);
    const publish = (): void =>
      ctx.publish({
        state: handle.runner.state,
        plannerSession: handle.dispatcher.sessionNames.planner,
        ...deps.extra(ctx.runId),
      });
    deps.registerPublisher(ctx.runId, publish);
    publish();
    deps.ready(ctx.runId, {
      plannerSession: handle.dispatcher.sessionNames.planner,
      state: handle.runner.state,
    });

    try {
      await deps.waitForExit(handle, ctx.signal);
    } finally {
      deps.unregisterPublisher(ctx.runId);
    }
    publish();

    const status = handle.runner.state.status;
    return {
      ok: status !== 'crashed',
      output: `autoloop ${status} at iter ${handle.runner.state.iter}`,
      error: status === 'crashed' ? (handle.runner.state.status_reason ?? 'autoloop crashed') : undefined,
      data: {
        state: handle.runner.state,
        plannerSession: handle.dispatcher.sessionNames.planner,
        ...deps.extra(ctx.runId),
      },
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
  return terminal && data.state.status !== 'terminated' && data.state.status !== 'crashed'
    ? { ...data.state, status: 'terminated', status_reason: data.state.status_reason ?? `run ${record.state}` }
    : data.state;
}
