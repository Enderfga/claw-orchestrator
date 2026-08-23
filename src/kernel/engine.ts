/**
 * The run kernel.
 *
 * A durable executor for workflow runs. It owns what the existing state machines
 * each owned separately and differently: what is running, what to do when a step
 * fails, when to give up, how to stop, and — the part none of them had — how to
 * come back after the process dies.
 *
 * Every mode goes through it. `council_start`, `fanout_start`, `ultraplan_start`,
 * `ultrareview_start` and `autoloop_start` each create a run here; the engines
 * they wrap (`Council`, `Fanout`, the autoloop dispatcher) still do the work,
 * but they no longer own a lifecycle. What that replaced: five result maps, four
 * 30-minute eviction timers, a 5-second poller, two `Set`s fencing a start
 * against a delete, and two incompatible ways of listing past runs across
 * processes.
 *
 * Durability contract, stated precisely: every state transition is checkpointed
 * (atomic `run.json`) and appended to `events.jsonl` before the next step
 * begins, and `resume` restarts at the last node boundary. That makes node
 * execution **at-least-once**, not exactly-once — there is no idempotency key,
 * no attempt lease, and no side-effect commit marker, so a node that died after
 * writing files but before its checkpoint runs again from the top. Workflows
 * whose nodes are not safe to repeat need to make them safe.
 *
 * Control flow is linear with an explicit `router` node for branches and loops.
 * Parallelism is the `fanout` node rather than a general parallel/join construct:
 * fan-out is the shape every existing mode actually needed, and a join barrier
 * would add failure modes (partial joins, orphaned branches) that nothing here
 * would exercise.
 *
 * What a node timeout can and cannot do: it stops the kernel waiting and marks
 * the node failed, but an in-flight agent turn is owned by the session layer and
 * finishes on its own schedule. The kernel does not pretend otherwise.
 */

import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import { createConsoleLogger, type Logger } from '../logger.js';
import { normalizeContract, type AcceptanceContract } from '../verify/contract.js';
import { captureBaseline, treeFingerprint } from '../verify/baseline.js';
import type { SessionManagerLike } from './agent-step.js';
import {
  acquireLease,
  appendEvent,
  createRunDir,
  isValidRunId,
  releaseLease,
  deleteRunDir,
  listRuns,
  loadRun,
  runDir,
  saveRun,
  stampTerminal,
  writeNodeArtifact,
  summarize,
  type ListRunsQuery,
  type RunSummary,
} from './store.js';
import {
  isTerminalRunState,
  type ConsensusVote,
  type KernelEvent,
  type NodeKind,
  type NodeRecord,
  type NodeSpec,
  type RouterCondition,
  type RunOutcome,
  type RunRecord,
  type WorkflowSpec,
} from './types.js';

export const DEFAULT_NODE_TIMEOUT_MS = 30 * 60_000;
export const DEFAULT_MAX_NODE_VISITS = 50;
/** Terminal verifier appended when the workflow declares a run-level contract. */
export const IMPLICIT_VERIFIER_ID = '__verify';
/** How much node text the checkpoint carries inline. The rest goes to disk. */
export const OUTPUT_PREVIEW_CHARS = 4000;

export interface NodeResult {
  ok: boolean;
  output?: string;
  error?: string;
  evidenceId?: string;
  /** Verifier nodes only: whether the contract passed. */
  passed?: boolean;
  /** Verifier nodes only: the tree digest at the moment the checks finished. */
  treeFingerprint?: string;
  /** human_gate nodes: park the run until a human answers. */
  awaitHuman?: boolean;
  costUsd?: number;
  artifacts?: string[];
  /** Advisory. Recorded on the run; never consulted for completion. */
  consensusVotes?: ConsensusVote[];
  /** Router nodes: the node id control should move to. */
  goto?: string;
  /** Subflow nodes: the child run this node started. */
  childRunId?: string;
  /** Mode-specific payload to checkpoint on the node record. */
  data?: unknown;
}

export interface NodeContext {
  runId: string;
  record: RunRecord;
  cwd: string;
  /**
   * 1-based attempt number for this visit. Nodes that name external resources
   * must include it: a timed-out attempt is abandoned, not killed, so it is
   * still running — and still holds a `finally` that tears down whatever it
   * named. Sharing a name with the retry means the dying attempt stops the live
   * one's session.
   */
  attempt: number;
  manager?: SessionManagerLike;
  logger: Logger;
  signal: { aborted: boolean };
  /** Text injected by `steer()` since this node last ran. Consumed by the node. */
  takeSteer(): string[];
  emit(event: KernelEvent): void;
  /** The workflow-level contract, for a `contract: 'run'` verifier node. */
  runContract?: AcceptanceContract;
  /** In-memory values the spec deliberately does not carry. Never persisted. */
  secrets: Record<string, unknown>;
  /**
   * Publish the live engine object for this node (a `Council`, a `Fanout`, an
   * autoloop dispatcher) so in-flight control — inject, abort, chat — can reach
   * it. In-memory by necessity: you cannot inject into a turn in a process that
   * is gone, and pretending otherwise would be the kind of claim this release
   * exists to remove. After a restart a run resumes; it does not reconnect.
   */
  setHandle(handle: unknown): void;
  /** Checkpoint mode payload as the node runs, not only when it finishes. */
  publish(data: unknown): void;
  /**
   * Record a child run started by this node, immediately.
   *
   * It has to land before the child finishes, not with the node's result: the
   * whole point is that cancelling the parent can find the child, and a parent
   * cancelled mid-subflow is exactly when the id is not yet in the record.
   */
  setChild(childRunId: string): void;
}

export type NodeExecutor = (node: NodeSpec, ctx: NodeContext) => Promise<NodeResult>;

interface RunHandle {
  signal: { aborted: boolean };
  steer: string[];
  /** Never written anywhere; dies with the process, as intended. */
  secrets: Record<string, unknown>;
  /** Resolves when a parked human_gate is answered. */
  gate?: { resolve: (approved: boolean) => void };
  done: Promise<RunRecord>;
  /** Live engine objects published by running nodes, keyed by node id. */
  handles: Map<string, unknown>;
}

export interface KernelOptions {
  manager?: SessionManagerLike;
  logger?: Logger;
  executors?: Partial<Record<NodeKind, NodeExecutor>>;
  /** Default per-node wall clock. */
  nodeTimeoutMs?: number;
}

export interface StartOptions {
  runId?: string;
  cwd?: string;
  /** Overrides `spec.contract`. Callers only — never sourced from agent output. */
  contract?: unknown;
  /**
   * Values a node needs but the spec must not carry — custom-engine configs,
   * whose `env` holds credentials.
   *
   * These live only in this process's memory. They are never written to
   * `spec.json` or `run.json`, and a resume in another process has to supply
   * them again rather than reading them back, which is the point.
   */
  secrets?: Record<string, unknown>;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Append the implicit terminal verifier when a run-level contract exists and the
 * author did not already place one. This is what makes `completed` mean "checked".
 */
/**
 * Reject a spec that cannot execute correctly, before anything runs.
 *
 * These are all mistakes that used to surface much later and much worse: a
 * duplicate node id silently overwrote a record so one of the two nodes had no
 * state; a `next` or router target naming a node that does not exist failed the
 * run halfway through with `unknown node`; a negative retry or visit bound was
 * accepted and then behaved arbitrarily.
 */
export function validateSpec(spec: WorkflowSpec): void {
  if (!spec || typeof spec.name !== 'string' || !spec.name.trim()) {
    throw new Error('WorkflowSpec needs a name');
  }
  if (!Array.isArray(spec.nodes) || spec.nodes.length === 0) {
    throw new Error(`Workflow '${spec.name}' has no nodes`);
  }

  const ids = new Set<string>();
  for (const node of spec.nodes) {
    if (!node?.id || typeof node.id !== 'string') throw new Error(`Workflow '${spec.name}' has a node with no id`);
    if (ids.has(node.id)) throw new Error(`Workflow '${spec.name}' has duplicate node id '${node.id}'`);
    ids.add(node.id);
    if (node.retry && (!Number.isInteger(node.retry.max) || node.retry.max < 0)) {
      throw new Error(`Node '${node.id}': retry.max must be a non-negative integer`);
    }
    if (node.timeoutMs !== undefined && (!Number.isFinite(node.timeoutMs) || node.timeoutMs <= 0)) {
      throw new Error(`Node '${node.id}': timeoutMs must be a positive number`);
    }
  }

  if (spec.maxNodeVisits !== undefined && (!Number.isInteger(spec.maxNodeVisits) || spec.maxNodeVisits < 1)) {
    throw new Error(`Workflow '${spec.name}': maxNodeVisits must be a positive integer`);
  }

  const check = (target: string | undefined, where: string): void => {
    if (target !== undefined && !ids.has(target)) {
      throw new Error(`${where} points at unknown node '${target}'`);
    }
  };
  for (const node of spec.nodes) {
    check(node.next, `Node '${node.id}' next`);
    if (node.kind === 'router') {
      check(node.default, `Router '${node.id}' default`);
      for (const route of node.routes ?? []) {
        check(route.to, `Router '${node.id}' route`);
        if (!route.when?.type) throw new Error(`Router '${node.id}' has a route with no condition`);
      }
    }
  }
}

export function prepareSpec(spec: WorkflowSpec): WorkflowSpec {
  if (!spec.contract) return spec;
  const hasRunVerifier = spec.nodes.some((n) => n.kind === 'verifier' && n.contract === 'run');
  if (hasRunVerifier) return spec;
  return {
    ...spec,
    nodes: [...spec.nodes, { id: IMPLICIT_VERIFIER_ID, kind: 'verifier', contract: 'run' }],
  };
}

export class RunKernel extends EventEmitter {
  private readonly manager?: SessionManagerLike;
  private readonly logger: Logger;
  private readonly executors: Partial<Record<NodeKind, NodeExecutor>>;
  private readonly nodeTimeoutMs: number;
  private readonly live = new Map<string, RunHandle>();
  /**
   * Per-run secrets, in memory only. Keyed by run id so a resume in this
   * process can re-use what the start supplied; a resume elsewhere must be
   * given them again.
   */
  private readonly _secrets = new Map<string, Record<string, unknown>>();

  constructor(opts: KernelOptions = {}) {
    super();
    this.manager = opts.manager;
    this.logger = opts.logger ?? createConsoleLogger('kernel');
    this.executors = opts.executors ?? {};
    this.nodeTimeoutMs = opts.nodeTimeoutMs ?? DEFAULT_NODE_TIMEOUT_MS;
  }

  /** Register (or replace) the executor for one node kind. */
  setExecutor(kind: NodeKind, executor: NodeExecutor): void {
    this.executors[kind] = executor;
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  async start(rawSpec: WorkflowSpec, opts: StartOptions = {}): Promise<RunRecord> {
    let contract = rawSpec.contract;
    if (opts.contract !== undefined) {
      contract = normalizeContract(opts.contract);
      // A contract that survives normalisation with nothing in it used to leave
      // the run with no contract at all, which then completed `unverified` — a
      // caller who asked to be checked was told nothing had checked, and the
      // reason was a typo they never saw.
      if (!contract) {
        throw new Error(
          'The supplied acceptance contract has no recognised checks. Every check needs a `type` of ' +
            'command | http | screenshot | diff_policy | file, and a `command` check needs `cmd`.',
        );
      }
    }
    const spec = prepareSpec({ ...rawSpec, contract });
    validateSpec(spec);
    const runId = opts.runId || `wf-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
    // Validated here as well as in the store: failing before any directory is
    // created keeps a rejected id from leaving a half-made run behind.
    if (!isValidRunId(runId)) {
      throw new Error(`Invalid run id ${JSON.stringify(runId)}: must be a single path segment ([A-Za-z0-9._-])`);
    }
    const cwd = opts.cwd || spec.cwd || process.cwd();
    const now = new Date().toISOString();

    const nodes: Record<string, NodeRecord> = {};
    for (const n of spec.nodes) {
      nodes[n.id] = { id: n.id, kind: n.kind, state: 'pending', attempts: 0, visits: 0 };
    }

    const record: RunRecord = {
      runId,
      workflow: spec.name,
      spec,
      state: 'pending',
      outcome: 'unverified',
      cwd,
      createdAt: now,
      updatedAt: now,
      nodes,
      costUsd: 0,
    };

    if (opts.secrets) this._secrets.set(runId, opts.secrets);
    createRunDir(runId, spec);
    acquireLease(runId);
    record.baseSha = await captureBaseline(cwd);
    saveRun(record);
    this._event(record, { ts: now, type: 'run_created', runId, workflow: spec.name });

    this._launch(record);
    return record;
  }

  /**
   * Re-attach to a run whose process died. Nodes already marked succeeded are not
   * re-run; the node that was in flight when the process ended is retried from
   * the start, because a half-finished node left no result to trust.
   */
  async resume(runId: string, opts: { restart?: boolean; secrets?: Record<string, unknown> } = {}): Promise<RunRecord> {
    if (opts.secrets) this._secrets.set(runId, opts.secrets);
    if (this.live.has(runId)) {
      const existing = loadRun(runId);
      if (!existing) throw new Error(`Run '${runId}' not found`);
      return existing;
    }
    const record = loadRun(runId);
    if (!record) throw new Error(`Run '${runId}' not found`);
    // Claim it before touching anything: two processes resuming the same run
    // would each execute its nodes, with every side effect happening twice.
    acquireLease(runId);
    // A finished run stays finished by default: silently re-running a completed
    // workflow because someone polled `resume` would be a nasty surprise.
    // `restart` is for callers whose "resume" genuinely means "bring it back up"
    // — autoloop, whose runs terminate and are expected to be restartable.
    if (isTerminalRunState(record.state) && !opts.restart) return record;

    for (const n of Object.values(record.nodes)) {
      if (n.state === 'running' || (opts.restart && isTerminalRunState(record.state))) {
        n.state = 'pending';
        n.attempts = 0;
        n.error = undefined;
      }
    }
    if (opts.restart) {
      record.endedAt = undefined;
      record.outcome = 'unverified';
      record.outcomeReason = undefined;
      record.verdict = undefined;
    }
    record.error = undefined;
    saveRun(record);
    this._launch(record);
    return record;
  }

  cancel(runId: string): boolean {
    const handle = this.live.get(runId);
    if (!handle) return false;
    handle.signal.aborted = true;
    handle.gate?.resolve(false);
    // Reach the engines too. Setting a flag only works for runners that check
    // it; `Council` and `Fanout` have their own `abort()`, and without calling
    // it a shutdown waits out the node timeout instead of stopping.
    for (const [, live] of handle.handles) {
      const abortable = live as { abort?: () => void };
      try {
        abortable.abort?.();
      } catch {
        // Best-effort: an engine that fails to abort must not block the others.
      }
    }
    // Cancellation propagates to subflows. Without this a cancelled parent
    // leaves its children running and spending, with nothing pointing at them.
    const record = loadRun(runId);
    for (const node of Object.values(record?.nodes ?? {})) {
      if (node.childRunId) this.cancel(node.childRunId);
    }
    return true;
  }

  /** Queue text for the current (or next) agent node. */
  steer(runId: string, text: string): boolean {
    const handle = this.live.get(runId);
    if (!handle) return false;
    handle.steer.push(text);
    const record = loadRun(runId);
    if (record) {
      this._event(record, {
        ts: new Date().toISOString(),
        type: 'steer',
        node: record.currentNode ?? '',
        text,
      });
    }
    return true;
  }

  /** Answer a parked `human_gate`. */
  approve(runId: string, approved: boolean): boolean {
    const handle = this.live.get(runId);
    if (!handle?.gate) return false;
    handle.gate.resolve(approved);
    return true;
  }

  get(runId: string): RunRecord | undefined {
    return loadRun(runId);
  }

  /**
   * The live engine object a running node published, if the run is still going
   * in this process. Undefined once the node finishes or the process restarts —
   * which is the honest answer, not a gap.
   */
  handle<T>(runId: string, nodeId: string): T | undefined {
    return this.live.get(runId)?.handles.get(nodeId) as T | undefined;
  }

  list(query: ListRunsQuery = {}): RunSummary[] {
    return listRuns(query);
  }

  delete(runId: string): void {
    this.cancel(runId);
    releaseLease(runId);
    this._secrets.delete(runId);
    deleteRunDir(runId, this.logger);
  }

  /**
   * Resolves when the run reaches a terminal state. A run that already finished
   * (or belongs to another process) resolves from disk, so the caller does not
   * have to race the completion.
   */
  wait(runId: string): Promise<RunRecord | undefined> {
    const handle = this.live.get(runId);
    return handle ? handle.done : Promise.resolve(loadRun(runId));
  }

  async shutdown(): Promise<void> {
    for (const [runId] of this.live) this.cancel(runId);
    await Promise.allSettled([...this.live.values()].map((h) => h.done));
    this.live.clear();
  }

  // ─── Execution ────────────────────────────────────────────────────────────

  private _launch(record: RunRecord): void {
    const handle: RunHandle = {
      signal: { aborted: false },
      steer: [],
      secrets: this._secrets.get(record.runId) ?? {},
      handles: new Map(),
      done: Promise.resolve(record),
    };
    // Registered before the run starts: a workflow with no nodes finishes
    // synchronously up to its first await, and the `finally` below would
    // otherwise delete an entry that had not been added yet.
    this.live.set(record.runId, handle);
    handle.done = this._run(record, handle).finally(() => {
      this.live.delete(record.runId);
    });
    // The caller gets the record immediately; failures surface through the record.
    handle.done.catch(() => undefined);
  }

  private _event(record: RunRecord, event: KernelEvent): void {
    appendEvent(record.runId, event, this.logger);
    this.emit('kernel-event', { runId: record.runId, event });
    this.emit(record.runId, event);
  }

  private _setRunState(record: RunRecord, state: RunRecord['state'], error?: string): void {
    record.state = state;
    record.updatedAt = new Date().toISOString();
    if (error) record.error = error;
    if (isTerminalRunState(state)) stampTerminal(record, state);
    saveRun(record);
    // Hand the run back once it is over, so another process can pick it up
    // without waiting out the lease.
    if (isTerminalRunState(state)) releaseLease(record.runId);
    this._event(record, {
      ts: record.updatedAt,
      type: 'run_state',
      state,
      outcome: record.outcome,
      error,
    });
  }

  private _setNodeState(
    record: RunRecord,
    node: NodeRecord,
    state: NodeRecord['state'],
    extra: { attempt?: number; error?: string } = {},
  ): void {
    node.state = state;
    if (extra.error) node.error = extra.error;
    const ts = new Date().toISOString();
    if (state === 'running') node.startedAt = ts;
    if (state === 'succeeded' || state === 'failed' || state === 'skipped' || state === 'cancelled') node.endedAt = ts;
    record.currentNode = node.id;
    record.updatedAt = ts;
    saveRun(record);
    this._event(record, { ts, type: 'node_state', node: node.id, state, ...extra });
  }

  private _nodeSpec(record: RunRecord, id: string): NodeSpec | undefined {
    return record.spec.nodes.find((n) => n.id === id);
  }

  private _nextInOrder(record: RunRecord, id: string): string | undefined {
    const idx = record.spec.nodes.findIndex((n) => n.id === id);
    return idx >= 0 && idx + 1 < record.spec.nodes.length ? record.spec.nodes[idx + 1].id : undefined;
  }

  private _firstPending(record: RunRecord): string | undefined {
    for (const n of record.spec.nodes) {
      const rec = record.nodes[n.id];
      if (!rec || rec.state === 'pending' || rec.state === 'awaiting_human') return n.id;
    }
    return undefined;
  }

  private _evalCondition(record: RunRecord, cond: RouterCondition): boolean {
    switch (cond.type) {
      case 'always':
        return true;
      case 'node_failed':
        return record.nodes[cond.node]?.state === 'failed';
      case 'node_succeeded':
        return record.nodes[cond.node]?.state === 'succeeded';
      case 'verified':
        return Boolean(record.nodes[cond.node]?.evidenceId) && record.outcome === 'verified';
      case 'visits_lt':
        return (record.nodes[cond.node]?.visits ?? 0) < cond.n;
    }
  }

  private async _executeNode(
    node: NodeSpec,
    ctx: NodeContext,
    timeoutMs: number,
    attemptSignal: { aborted: boolean },
  ): Promise<NodeResult> {
    const executor = this.executors[node.kind];
    if (!executor) {
      return { ok: false, error: `no executor registered for node kind '${node.kind}'` };
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<NodeResult>((resolve) => {
      timer = setTimeout(() => {
        // Aborts this attempt only. A timeout is a node failure — it still gets
        // its retries and still honours `onFailure` — whereas cancelling the run
        // is a separate, user-initiated thing. Conflating the two made a hung
        // node report the whole run as `cancelled`.
        attemptSignal.aborted = true;
        resolve({ ok: false, error: `node timed out after ${timeoutMs}ms` });
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
    });
    try {
      return await Promise.race([executor(node, ctx), timeout]);
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async _run(record: RunRecord, handle: RunHandle): Promise<RunRecord> {
    const maxVisits = record.spec.maxNodeVisits ?? DEFAULT_MAX_NODE_VISITS;
    this._setRunState(record, 'running');

    let cursor = this._firstPending(record);

    while (cursor) {
      if (handle.signal.aborted) {
        this._setRunState(record, 'cancelled');
        return record;
      }

      const spec = this._nodeSpec(record, cursor);
      const nodeRec = record.nodes[cursor];
      if (!spec || !nodeRec) {
        this._setRunState(record, 'failed', `unknown node '${cursor}'`);
        return record;
      }

      nodeRec.visits++;
      if (nodeRec.visits > maxVisits) {
        this._setNodeState(record, nodeRec, 'failed', { error: `visit limit ${maxVisits} exceeded` });
        this._setRunState(record, 'failed', `node '${cursor}' exceeded the ${maxVisits}-visit loop bound`);
        return record;
      }

      if (spec.kind === 'verifier') this._setRunState(record, 'verifying');

      const result = await this._runWithRetry(record, spec, nodeRec, handle);

      // Cancel wins regardless of what the node returned. A runner that never
      // looked at the signal and reported success anyway used to carry the run
      // all the way to `completed` — so "I cancelled it" and "it completed"
      // could both be true, which makes cancellation meaningless.
      if (handle.signal.aborted) {
        this._absorb(record, nodeRec, result);
        this._setNodeState(record, nodeRec, 'cancelled');
        this._setRunState(record, 'cancelled');
        return record;
      }

      if (result.awaitHuman) {
        const approved = await this._park(record, nodeRec, handle);
        if (!approved) {
          this._setNodeState(record, nodeRec, 'failed', { error: 'rejected at human gate' });
          this._setRunState(record, handle.signal.aborted ? 'cancelled' : 'failed', 'rejected at human gate');
          return record;
        }
        this._setNodeState(record, nodeRec, 'succeeded');
        cursor = spec.next ?? this._nextInOrder(record, cursor);
        continue;
      }

      this._absorb(record, nodeRec, result);

      if (!result.ok) {
        this._setNodeState(record, nodeRec, 'failed', { error: result.error });
        if ((spec.onFailure ?? 'fail') === 'fail') {
          await this._finish(record, `node '${cursor}' failed: ${result.error ?? 'unknown'}`);
          return record;
        }
        // `continue` — record it and move on.
      } else {
        this._setNodeState(record, nodeRec, 'succeeded');
      }

      if (spec.kind === 'router') {
        cursor = result.goto ?? spec.default ?? this._nextInOrder(record, cursor);
        continue;
      }
      cursor = spec.next ?? this._nextInOrder(record, cursor);
    }

    await this._finish(record);
    return record;
  }

  private async _runWithRetry(
    record: RunRecord,
    spec: NodeSpec,
    nodeRec: NodeRecord,
    handle: RunHandle,
  ): Promise<NodeResult> {
    const maxAttempts = (spec.retry?.max ?? 0) + 1;
    const timeoutMs = spec.timeoutMs ?? this.nodeTimeoutMs;
    let last: NodeResult = { ok: false, error: 'not attempted' };

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (handle.signal.aborted) return { ok: false, error: 'cancelled' };
      nodeRec.attempts = attempt;
      this._setNodeState(record, nodeRec, 'running', { attempt });

      // A node sees one signal that is the union of "this attempt gave up" and
      // "the whole run was cancelled"; the kernel keeps them apart.
      const attemptSignal = { aborted: false };
      const ctx: NodeContext = {
        runId: record.runId,
        record,
        cwd: record.cwd,
        attempt,
        manager: this.manager,
        logger: this.logger,
        signal: {
          get aborted(): boolean {
            return handle.signal.aborted || attemptSignal.aborted;
          },
          set aborted(v: boolean) {
            attemptSignal.aborted = v;
          },
        },
        takeSteer: () => handle.steer.splice(0, handle.steer.length),
        emit: (event) => this._event(record, event),
        runContract: record.spec.contract,
        setHandle: (h) => handle.handles.set(spec.id, h),
        publish: (data) => {
          nodeRec.data = data;
          record.updatedAt = new Date().toISOString();
          saveRun(record);
        },
        secrets: handle.secrets,
        setChild: (childRunId) => {
          nodeRec.childRunId = childRunId;
          record.updatedAt = new Date().toISOString();
          saveRun(record);
        },
      };

      last = await this._executeNode(spec, ctx, timeoutMs, attemptSignal);
      if (last.ok || handle.signal.aborted) return last;

      if (attempt < maxAttempts) {
        const backoff = (spec.retry?.backoffMs ?? 1000) * attempt;
        this.logger.warn?.(
          `[kernel] ${record.runId}/${spec.id} attempt ${attempt}/${maxAttempts} failed: ${last.error} — retrying in ${backoff}ms`,
        );
        await sleep(backoff);
      }
    }
    return last;
  }

  private async _park(record: RunRecord, nodeRec: NodeRecord, handle: RunHandle): Promise<boolean> {
    this._setNodeState(record, nodeRec, 'awaiting_human');
    this._setRunState(record, 'awaiting_human');
    const approved = await new Promise<boolean>((resolve) => {
      handle.gate = { resolve };
    });
    handle.gate = undefined;
    if (!handle.signal.aborted) this._setRunState(record, 'running');
    return approved;
  }

  /** Node kinds that can change the workspace. Routers and gates cannot. */
  private static readonly SIDE_EFFECT_KINDS: readonly NodeKind[] = ['agent', 'fanout', 'council', 'subflow'];

  private _absorb(record: RunRecord, nodeRec: NodeRecord, result: NodeResult): void {
    if (RunKernel.SIDE_EFFECT_KINDS.includes(nodeRec.kind)) {
      record.sideEffectSeq = (record.sideEffectSeq ?? 0) + 1;
    }
    if (result.output !== undefined) {
      // The record keeps a preview so checkpoints stay small; the full text goes
      // to the node's artifact directory, because for some nodes the text *is*
      // the deliverable and a silent 4 kB cut would lose it.
      if (result.output.length > OUTPUT_PREVIEW_CHARS) {
        try {
          const rel = writeNodeArtifact(record.runId, nodeRec.id, 'output.txt', result.output);
          nodeRec.artifacts = [...new Set([...(nodeRec.artifacts ?? []), rel])];
        } catch (err) {
          this.logger.warn?.(`[kernel] could not store full output for ${nodeRec.id}: ${(err as Error).message}`);
        }
      }
      nodeRec.output =
        result.output.length > OUTPUT_PREVIEW_CHARS
          ? result.output.slice(0, OUTPUT_PREVIEW_CHARS) +
            '\n…[truncated — full text in nodes/' +
            nodeRec.id +
            '/output.txt]'
          : result.output;
      this._event(record, {
        ts: new Date().toISOString(),
        type: 'node_output',
        node: nodeRec.id,
        text: nodeRec.output,
      });
    }
    if (result.artifacts?.length) nodeRec.artifacts = result.artifacts;
    if (result.data !== undefined) nodeRec.data = result.data;
    if (result.childRunId) nodeRec.childRunId = result.childRunId;
    if (typeof result.costUsd === 'number') record.costUsd = (record.costUsd ?? 0) + result.costUsd;
    if (result.consensusVotes?.length) {
      record.consensusVotes = [...(record.consensusVotes ?? []), ...result.consensusVotes];
    }
    if (result.evidenceId) {
      nodeRec.evidenceId = result.evidenceId;
      record.evidenceId = result.evidenceId;
      record.outcome = result.passed ? 'verified' : 'refuted';
      record.outcomeReason = undefined;
      record.verdict = {
        node: nodeRec.id,
        evidenceId: result.evidenceId,
        treeFingerprint: result.treeFingerprint,
        sideEffectSeq: record.sideEffectSeq ?? 0,
      };
      this._event(record, {
        ts: new Date().toISOString(),
        type: 'evidence',
        node: nodeRec.id,
        evidenceId: result.evidenceId,
        passed: Boolean(result.passed),
      });
    }
  }

  /**
   * Decide the terminal state. `completed` requires that nothing refuted the run;
   * a run with no contract completes as `unverified`, which says we did not check
   * rather than claiming success.
   */
  private async _finish(record: RunRecord, error?: string): Promise<void> {
    await this._expireStaleVerdict(record);
    const outcome: RunOutcome = record.outcome;
    if (error || outcome === 'refuted') {
      this._setRunState(record, 'failed', error ?? 'acceptance contract was not satisfied');
      return;
    }
    this._setRunState(record, 'completed');
  }

  /**
   * A passing verdict only stands while it still describes the tree.
   *
   * `prepareSpec` cannot enforce this structurally: a router can send control
   * anywhere, so which node runs last is not a property of the spec. And a
   * "nothing after the verifier" rule would be the wrong rule anyway — what
   * matters is not that a node ran, but that the tree moved. So this measures.
   *
   * When it has moved, the outcome drops to `unverified` with the reason
   * recorded. Not `refuted`: no check failed. We simply no longer know, and
   * saying so is the whole point of having three outcomes.
   */
  private async _expireStaleVerdict(record: RunRecord): Promise<void> {
    if (record.outcome !== 'verified' || !record.verdict) return;

    // Nothing that could touch the workspace ran after the checks, so the
    // verdict still describes the tree. This is the ordinary case, and it must
    // not depend on git: a contract that passed in a plain directory passed.
    if ((record.sideEffectSeq ?? 0) === record.verdict.sideEffectSeq) return;

    const before = record.verdict.treeFingerprint;
    const after = await treeFingerprint(record.cwd);
    if (before !== undefined && after !== undefined && before === after) return;

    record.outcome = 'unverified';
    record.outcomeReason =
      before === undefined || after === undefined
        ? `evidence ${record.verdict.evidenceId} passed, but nodes ran afterwards and ${record.cwd} is not a git repository, so we cannot tell whether it still describes the tree`
        : `evidence ${record.verdict.evidenceId} passed, but the working tree changed afterwards — the verdict describes an earlier state`;
    this._event(record, {
      ts: new Date().toISOString(),
      type: 'log',
      level: 'warn',
      message: `[verify] ${record.outcomeReason}`,
    });
  }
}

/** Run directory for a given run — re-exported so callers need not import the store. */
export { runDir, summarize };
