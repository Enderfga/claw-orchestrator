/**
 * The run kernel.
 *
 * A durable executor for workflow runs. It owns what the existing state machines
 * each owned separately and differently: what is running, what to do when a step
 * fails, when to give up, how to stop, and — the part none of them had — how to
 * come back after the process dies.
 *
 * What it is not, yet: the single runtime every mode goes through. Council,
 * fanout, autoloop and ultraapp keep their own lifecycles, maps and cleanup, and
 * the `council` / `fanout` nodes call those runners from inside a kernel run
 * rather than replacing them. So a run started through `council_start` is not a
 * kernel run and gets none of this. Collapsing those lifecycles is the work this
 * layer exists to make possible; it has not happened, and nothing here should be
 * read as claiming it has.
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
  appendEvent,
  createRunDir,
  isValidRunId,
  deleteRunDir,
  listRuns,
  loadRun,
  runDir,
  saveRun,
  stampTerminal,
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
}

export type NodeExecutor = (node: NodeSpec, ctx: NodeContext) => Promise<NodeResult>;

interface RunHandle {
  signal: { aborted: boolean };
  steer: string[];
  /** Resolves when a parked human_gate is answered. */
  gate?: { resolve: (approved: boolean) => void };
  done: Promise<RunRecord>;
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
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Append the implicit terminal verifier when a run-level contract exists and the
 * author did not already place one. This is what makes `completed` mean "checked".
 */
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
    const contract = opts.contract !== undefined ? normalizeContract(opts.contract) : rawSpec.contract;
    const spec = prepareSpec({ ...rawSpec, contract });
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

    createRunDir(runId, spec);
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
  async resume(runId: string): Promise<RunRecord> {
    if (this.live.has(runId)) {
      const existing = loadRun(runId);
      if (!existing) throw new Error(`Run '${runId}' not found`);
      return existing;
    }
    const record = loadRun(runId);
    if (!record) throw new Error(`Run '${runId}' not found`);
    if (isTerminalRunState(record.state)) return record;

    for (const n of Object.values(record.nodes)) {
      if (n.state === 'running') {
        n.state = 'pending';
        n.attempts = 0;
        n.error = undefined;
      }
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

  list(query: ListRunsQuery = {}): RunSummary[] {
    return listRuns(query);
  }

  delete(runId: string): void {
    this.cancel(runId);
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
    for (const [, handle] of this.live) handle.signal.aborted = true;
    await Promise.allSettled([...this.live.values()].map((h) => h.done));
    this.live.clear();
  }

  // ─── Execution ────────────────────────────────────────────────────────────

  private _launch(record: RunRecord): void {
    const handle: RunHandle = {
      signal: { aborted: false },
      steer: [],
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

      if (handle.signal.aborted && !result.ok) {
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
      nodeRec.output = result.output.length > 4000 ? result.output.slice(0, 4000) + '\n…[truncated]' : result.output;
      this._event(record, {
        ts: new Date().toISOString(),
        type: 'node_output',
        node: nodeRec.id,
        text: nodeRec.output,
      });
    }
    if (result.artifacts?.length) nodeRec.artifacts = result.artifacts;
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
