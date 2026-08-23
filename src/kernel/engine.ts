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
 * Ownership contract, equally precisely: this class never writes to a run
 * directly. It holds a `RunGuard` from the store and every change — checkpoint,
 * event, node artifact, terminal verdict — goes through `RunTxn`, which applies
 * the change to a *copy*, commits it under the guard, and adopts the copy only
 * if the disk accepted it. There is no code path from here to `run.json` that
 * skips that, because the raw writers are no longer exported. An owner that has
 * been superseded therefore cannot change the run in memory either: its record
 * stops advancing at the last write the disk agreed to.
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
  commit,
  createAndAcquire,
  LEASE_HEARTBEAT_MS,
  renewLease,
  isValidRunId,
  releaseLease,
  deleteRunDir,
  listRuns,
  loadRun,
  nodeArtifactPath,
  runDir,
  summarize,
  type CommitBatch,
  type CommitOutcome,
  type ListRunsQuery,
  type RunGuard,
  type RunSummary,
} from './store.js';
import {
  isTerminalRunState,
  type ConsensusVote,
  type KernelEvent,
  type NodeKind,
  type NodeRecord,
  type NodeSpec,
  type RunOutcome,
  type RunRecord,
  type WorkflowSpec,
} from './types.js';

export const DEFAULT_NODE_TIMEOUT_MS = 30 * 60_000;
export const DEFAULT_MAX_NODE_VISITS = 50;
/**
 * How long a run about to claim `verified` waits for abandoned attempts to stop.
 *
 * Short on purpose. The wait exists to catch an attempt that is about to finish,
 * not to hold a run hostage to one that never will — a node stuck forever must
 * not stop the run from ending, only from being called verified.
 */
export const QUIESCE_GRACE_MS = 2_000;
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
  /** `StartOptions.tag` for the start that launched this node, when one was given. */
  tag?: string;
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

/**
 * One owner's transactional view of a run.
 *
 * It holds the guard and the last record the disk accepted, and it is the only
 * thing in this module that can change either. Three properties matter:
 *
 *  - **Copy-on-write.** A change is applied to a clone, committed, and adopted
 *    only if the commit succeeded. A refused write therefore leaves the record
 *    this process hands to its callers exactly as the disk has it. The previous
 *    version mutated first and committed second in most places, so a superseded
 *    owner returned a record saying `completed` while `run.json` correctly said
 *    `running` — the same lie, one layer up.
 *  - **Everything, not most things.** Checkpoints, events and node artifacts all
 *    go through here. There is no unfenced variant to reach for, because the
 *    store no longer exports one.
 *  - **One-way.** The first refusal sets `lost`, and nothing is attempted after
 *    that. An owner that has been replaced does not keep trying.
 */
class RunTxn {
  private _record: RunRecord;
  /** The run was taken over. Permanent: this owner may never write again. */
  lost = false;
  /**
   * A write could not get through, but nothing says we lost the run.
   *
   * Kept apart from `lost` because the responses are opposite. Treating a
   * millisecond of lock contention as a takeover made a run stop forever while
   * still holding its lease — so nobody could take it over either, and a live
   * local pid is never judged stale. Stalling stops the run and hands the claim
   * back, which leaves it resumable.
   */
  stalled = false;

  constructor(
    readonly guard: RunGuard,
    record: RunRecord,
    private readonly logger: Logger,
    /** Notified with the events of each accepted commit, for the in-process stream. */
    private readonly onEvents: (events: KernelEvent[]) => void,
    /** Called once, when this owner stops writing, with which of the two it was. */
    private readonly onStop: (outcome: 'superseded' | 'blocked', reason: string) => void,
  ) {
    this._record = record;
  }

  get record(): RunRecord {
    return this._record;
  }

  /** True once this owner has stopped writing, for either reason. */
  get finished(): boolean {
    return this.lost || this.stalled;
  }

  /**
   * Apply a change, persist it, and adopt it — or refuse all three.
   *
   * `mutate` receives a clone. Mutating `txn.record` inside it would defeat the
   * whole mechanism, which is why the clone is what is handed over.
   */
  apply(
    mutate: (draft: RunRecord) => void,
    events: KernelEvent[] = [],
    artifacts: NonNullable<CommitBatch['artifacts']> = [],
  ): boolean {
    if (this.finished) return false;
    const draft = JSON.parse(JSON.stringify(this._record)) as RunRecord;
    mutate(draft);
    const result = commit(this.guard, { record: draft, events, artifacts }, this.logger);
    if (result.outcome !== 'committed') return this._stop(result.outcome, result.reason);
    this._record = draft;
    this.onEvents(events);
    return true;
  }

  /** Append events without changing state. Fenced like every other write. */
  emit(...events: KernelEvent[]): boolean {
    if (this.finished) return false;
    const result = commit(this.guard, { events }, this.logger);
    if (result.outcome !== 'committed') return this._stop(result.outcome, result.reason);
    this.onEvents(events);
    return true;
  }

  private _stop(outcome: Exclude<CommitOutcome, 'committed'>, reason?: string): boolean {
    if (this.finished) return false;
    const why = reason ?? 'no reason given';
    if (outcome === 'superseded') {
      this.lost = true;
      this.logger.warn?.(
        `[kernel] ${this.guard.runId}: write refused — this owner (fence ${this.guard.fence}) no longer holds ` +
          `the run (${why}), so it stops here rather than carrying on in memory`,
      );
    } else {
      this.stalled = true;
      this.logger.warn?.(
        `[kernel] ${this.guard.runId}: write could not be committed (${why}) — the run stops and its claim is ` +
          `handed back, so it can be resumed rather than wedged`,
      );
    }
    this.onStop(outcome, why);
    return false;
  }
}

interface RunHandle {
  /** The guard, the record, and the only way to change either. */
  txn: RunTxn;
  signal: { aborted: boolean };
  steer: string[];
  tag?: string;
  /** Independent of any checkpoint, so a long node cannot look abandoned. */
  heartbeat?: ReturnType<typeof setInterval>;
  /**
   * Executor promises that have been abandoned (timed out) but are still
   * running. A run cannot claim `verified` while one of these could still write.
   */
  inflight: Set<Promise<unknown>>;
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
   * Opaque label for THIS start, handed to nodes as `ctx.tag`.
   *
   * A run id can be reused — a start that failed frees it for a retry — so
   * anything the caller keys on the run id can be clobbered by the next start.
   * The tag identifies one attempt at running it.
   */
  tag?: string;
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
   * This kernel's identity as a run owner.
   *
   * Per instance, not per process: two `RunKernel`s in one process — two
   * SessionManagers is not exotic — would otherwise share a pid and each treat
   * the other's lease as its own, so both would execute the same run.
   */
  readonly ownerId = `owner-${crypto.randomUUID()}`;
  /**
   * Per-run secrets, in memory only. Keyed by run id so a resume in this
   * process can re-use what the start supplied; a resume elsewhere must be
   * given them again.
   */
  private readonly _secrets = new Map<string, Record<string, unknown>>();
  /** Caller label for the most recent start of each run. */
  private readonly _tags = new Map<string, string>();

  constructor(opts: KernelOptions = {}) {
    super();
    this.manager = opts.manager;
    this.logger = opts.logger ?? createConsoleLogger('kernel');
    this.executors = opts.executors ?? {};
    this.nodeTimeoutMs = opts.nodeTimeoutMs ?? DEFAULT_NODE_TIMEOUT_MS;
  }

  /** Stop and await any live run holding this id, so a reuse cannot overlap it. */
  private async _retire(runId: string): Promise<void> {
    const existing = this.live.get(runId);
    if (!existing) return;
    this.cancel(runId);
    await existing.done.catch(() => undefined);
    if (this.live.get(runId) === existing) this.live.delete(runId);
  }

  /** Register (or replace) the executor for one node kind. */
  setExecutor(kind: NodeKind, executor: NodeExecutor): void {
    this.executors[kind] = executor;
  }

  /**
   * Open a transaction over a run this kernel has just claimed.
   *
   * The abort signal is created here rather than in `_launch` because the
   * transaction has to be able to stop the run the moment a write is refused,
   * and that can happen before the handle exists.
   */
  private _open(guard: RunGuard, record: RunRecord): { txn: RunTxn; signal: { aborted: boolean } } {
    const signal = { aborted: false };
    const txn = new RunTxn(
      guard,
      record,
      this.logger,
      (events) => {
        for (const event of events) {
          this.emit('kernel-event', { runId: guard.runId, event });
          this.emit(guard.runId, event);
        }
      },
      (outcome, reason) => {
        signal.aborted = true;
        // Being superseded means someone else already owns the run; handing it
        // back would take it from them. Being blocked means we still hold a
        // claim we can no longer use, and leaving that behind is what wedges a
        // run permanently — a live local pid is never judged stale, so nobody
        // else could ever take it.
        if (outcome === 'blocked') this._scheduleRelease(guard, reason);
      },
    );
    return { txn, signal };
  }

  /**
   * Hand a claim back, retrying while the lock is merely busy.
   *
   * Best-effort with a bound: contention here is measured in microseconds, so a
   * few backed-off attempts cover everything short of a wedged filesystem — and
   * if it is wedged, saying so beats retrying forever.
   */
  private _scheduleRelease(guard: RunGuard, reason?: string, attempt = 0): void {
    const outcome = releaseLease(guard);
    if (outcome !== 'blocked') return;
    if (attempt >= 6) {
      this.logger.error?.(
        `[kernel] ${guard.runId}: could not hand the claim back after ${attempt} attempts` +
          `${reason ? ` (${reason})` : ''} — resuming it elsewhere will have to wait for the lease to expire`,
      );
      return;
    }
    const timer = setTimeout(() => this._scheduleRelease(guard, reason, attempt + 1), 250 * 2 ** attempt);
    if (typeof timer.unref === 'function') timer.unref();
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
    if (opts.tag) this._tags.set(runId, opts.tag);
    // A run id may be reused once its previous run is gone — a failed start
    // frees it. But two live runs with the same id in one process would write
    // over each other's checkpoints, so the old one is stopped and waited for
    // first. This is the in-process half of what the lease does across
    // processes.
    await this._retire(runId);
    // Creating and claiming are one step, and the directory creation is itself
    // the claim: two processes cannot both come away believing they made this
    // run. A fresh directory also means a fresh incarnation id, which is what
    // stops a guard from the previous life of this run id from ever being valid
    // again.
    const guard = createAndAcquire(runId, spec, this.ownerId);
    record.baseSha = await captureBaseline(cwd);
    const { txn, signal } = this._open(guard, record);
    if (!txn.apply(() => undefined, [{ ts: now, type: 'run_created', runId, workflow: spec.name }])) {
      throw new Error(`Run '${runId}' could not be checkpointed: the claim was lost before it started`);
    }

    this._launch(txn, signal);
    return txn.record;
  }

  /**
   * Re-attach to a run whose process died. Nodes already marked succeeded are not
   * re-run; the node that was in flight when the process ended is retried from
   * the start, because a half-finished node left no result to trust.
   */
  async resume(
    runId: string,
    opts: { restart?: boolean; secrets?: Record<string, unknown>; tag?: string } = {},
  ): Promise<RunRecord> {
    if (opts.secrets) this._secrets.set(runId, opts.secrets);
    if (opts.tag) this._tags.set(runId, opts.tag);
    if (this.live.has(runId)) {
      const existing = loadRun(runId);
      if (!existing) throw new Error(`Run '${runId}' not found`);
      return existing;
    }
    const record = loadRun(runId);
    if (!record) throw new Error(`Run '${runId}' not found`);
    // A finished run stays finished by default: silently re-running a completed
    // workflow because someone polled `resume` would be a nasty surprise.
    // `restart` is for callers whose "resume" genuinely means "bring it back up"
    // — autoloop, whose runs terminate and are expected to be restartable.
    //
    // Checked BEFORE the lease is taken. Taking it first meant that merely
    // polling `resume` on a completed run minted a lease nobody would ever
    // release, blocking the next process from restarting it.
    if (isTerminalRunState(record.state) && !opts.restart) return record;
    // Claim it: two processes resuming the same run would each execute its
    // nodes, with every side effect happening twice.
    const guard = acquireLease(runId, this.ownerId);
    const { txn, signal } = this._open(guard, record);

    const wasTerminal = isTerminalRunState(record.state);
    if (
      !txn.apply((draft) => {
        for (const n of Object.values(draft.nodes)) {
          if (n.state === 'running' || (opts.restart && wasTerminal)) {
            n.state = 'pending';
            n.attempts = 0;
            n.error = undefined;
          }
        }
        if (opts.restart) {
          draft.endedAt = undefined;
          draft.outcome = 'unverified';
          draft.outcomeReason = undefined;
          draft.verdict = undefined;
        }
        draft.error = undefined;
        draft.updatedAt = new Date().toISOString();
      })
    ) {
      throw new Error(`Run '${runId}' could not be checkpointed: the claim was lost before it resumed`);
    }
    this._launch(txn, signal);
    return txn.record;
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
    for (const node of Object.values(handle.txn.record.nodes)) {
      if (node.childRunId) this.cancel(node.childRunId);
    }
    return true;
  }

  /** Queue text for the current (or next) agent node. */
  steer(runId: string, text: string): boolean {
    const handle = this.live.get(runId);
    if (!handle) return false;
    handle.steer.push(text);
    handle.txn.emit({
      ts: new Date().toISOString(),
      type: 'steer',
      node: handle.txn.record.currentNode ?? '',
      text,
    });
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

  /**
   * Remove a run.
   *
   * `expectTag` guards against deleting the wrong incarnation: a run id is
   * reused when a failed start frees it, so a dying start's cleanup could
   * otherwise delete the retry that had already taken the id. When the tag does
   * not match, nothing is touched.
   *
   * Deleting takes the incarnation with it, which is what makes the id safe to
   * reuse: any guard still held by an abandoned attempt of the deleted run names
   * an incarnation that no longer exists, so it cannot write to whatever takes
   * the id next.
   */
  delete(runId: string, opts: { expectTag?: string } = {}): boolean {
    if (opts.expectTag !== undefined && this._tags.get(runId) !== opts.expectTag) return false;
    // Claim before deleting and never release first. Releasing here used to open
    // a window in which another process could legally resume the run, only for
    // this process to delete the directory out from under its new owner.
    let claimed = false;
    try {
      acquireLease(runId, this.ownerId);
      claimed = true;
    } catch {
      claimed = false;
    }
    this.cancel(runId);
    // Whatever happened to the directory, this process is done with the run, so
    // its in-memory traces go — a refusal must not leave the caller's secrets
    // sitting in a map for a run we are no longer tracking. (`acquireLease`
    // throws for a run that no longer exists as well as for one someone else
    // owns, and forgetting the credentials is right in both cases.)
    this._secrets.delete(runId);
    this._tags.delete(runId);
    if (!claimed) return false;
    deleteRunDir(runId, this.logger);
    return true;
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

  private _launch(txn: RunTxn, signal: { aborted: boolean }): void {
    const runId = txn.guard.runId;
    const handle: RunHandle = {
      txn,
      signal,
      steer: [],
      tag: this._tags.get(runId),
      inflight: new Set(),
      secrets: this._secrets.get(runId) ?? {},
      handles: new Map(),
      done: Promise.resolve(txn.record),
    };
    handle.heartbeat = setInterval(() => renewLease(txn.guard), LEASE_HEARTBEAT_MS);
    if (typeof handle.heartbeat.unref === 'function') handle.heartbeat.unref();
    // Registered before the run starts: a workflow with no nodes finishes
    // synchronously up to its first await, and the `finally` below would
    // otherwise delete an entry that had not been added yet.
    this.live.set(runId, handle);
    handle.done = this._run(handle).finally(() => {
      if (handle.heartbeat) clearInterval(handle.heartbeat);
      // A run that stopped because it could not write still holds its claim.
      // `_scheduleRelease` was already started by the stop callback; this covers
      // the case where the run ended for another reason while stalled.
      if (txn.stalled) this._scheduleRelease(txn.guard);
      // Identity-checked: a run id can be reused, and deleting by key alone
      // meant a finishing run evicted the handle of the run that had just
      // replaced it.
      if (this.live.get(runId) === handle) this.live.delete(runId);
    });
    // The caller gets the record immediately; failures surface through the record.
    handle.done.catch(() => undefined);
  }

  private _setRunState(handle: RunHandle, state: RunRecord['state'], error?: string): boolean {
    const txn = handle.txn;
    const ts = new Date().toISOString();
    const terminal = isTerminalRunState(state);
    const outcome = txn.record.outcome;
    const ok = txn.apply(
      (draft) => {
        draft.state = state;
        draft.updatedAt = ts;
        if (error) draft.error = error;
        // Terminal states carry `endedAt`; this is the one place that stamps it.
        if (terminal) draft.endedAt = ts;
      },
      [{ ts, type: 'run_state', state, outcome, error }],
    );
    if (!ok) return false;
    // Hand the run back once it is over, so another owner can pick it up
    // without waiting out the lease. After the writes, never before.
    if (terminal) this._scheduleRelease(txn.guard);
    return true;
  }

  private _setNodeState(
    handle: RunHandle,
    nodeId: string,
    state: NodeRecord['state'],
    extra: { attempt?: number; error?: string } = {},
  ): boolean {
    const ts = new Date().toISOString();
    return handle.txn.apply(
      (draft) => {
        const node = draft.nodes[nodeId];
        if (!node) return;
        node.state = state;
        if (extra.attempt !== undefined) node.attempts = extra.attempt;
        if (extra.error) node.error = extra.error;
        if (state === 'running') node.startedAt = ts;
        if (state === 'succeeded' || state === 'failed' || state === 'skipped' || state === 'cancelled') {
          node.endedAt = ts;
        }
        draft.currentNode = nodeId;
        draft.updatedAt = ts;
      },
      [{ ts, type: 'node_state', node: nodeId, state, ...extra }],
    );
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

  private async _executeNode(
    node: NodeSpec,
    ctx: NodeContext,
    timeoutMs: number,
    attemptSignal: { aborted: boolean },
    inflight: Set<Promise<unknown>>,
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
    // The executor promise is tracked, not just raced. A timeout abandons the
    // wait, not the work — the executor keeps running and can still write — so
    // the run has to know it is out there before it calls anything verified.
    const running = Promise.resolve()
      .then(() => executor(node, ctx))
      .catch((err) => ({ ok: false, error: (err as Error).message }) as NodeResult)
      .finally(() => inflight.delete(running));
    inflight.add(running);

    try {
      return await Promise.race([running, timeout]);
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Wait for abandoned attempts to stop, so a terminal verdict describes a tree
   * nobody is still writing to.
   *
   * A timed-out node is not killed — JS gives us no way to — so a run used to
   * stamp `completed / verified`, then have the abandoned attempt write to the
   * workspace afterwards. The evidence was accurate at the moment it was taken
   * and wrong seconds later, with nothing recording that.
   */
  private async _awaitQuiescence(handle: RunHandle, graceMs: number): Promise<boolean> {
    if (handle.inflight.size === 0) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const grace = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), graceMs);
      if (typeof timer.unref === 'function') timer.unref();
    });
    const settled = Promise.allSettled([...handle.inflight]).then(() => 'settled' as const);
    try {
      return (await Promise.race([settled, grace])) === 'settled';
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async _run(handle: RunHandle): Promise<RunRecord> {
    const txn = handle.txn;
    const maxVisits = txn.record.spec.maxNodeVisits ?? DEFAULT_MAX_NODE_VISITS;
    this._setRunState(handle, 'running');

    let cursor = this._firstPending(txn.record);

    while (cursor) {
      // Losing the run outranks everything else: this owner may not write, so
      // there is nothing left for it to do but stop.
      if (txn.finished) return txn.record;
      if (handle.signal.aborted) {
        this._setRunState(handle, 'cancelled');
        return txn.record;
      }

      const nodeId: string = cursor;
      const spec = this._nodeSpec(txn.record, nodeId);
      if (!spec || !txn.record.nodes[nodeId]) {
        this._setRunState(handle, 'failed', `unknown node '${nodeId}'`);
        return txn.record;
      }

      // The visit counter is part of the loop bound, so it is committed like any
      // other state rather than incremented on a record nobody agreed to.
      if (
        !txn.apply((draft) => {
          const node = draft.nodes[nodeId];
          if (node) node.visits = (node.visits ?? 0) + 1;
          draft.updatedAt = new Date().toISOString();
        })
      ) {
        return txn.record;
      }
      if ((txn.record.nodes[nodeId]?.visits ?? 0) > maxVisits) {
        this._setNodeState(handle, nodeId, 'failed', { error: `visit limit ${maxVisits} exceeded` });
        this._setRunState(handle, 'failed', `node '${nodeId}' exceeded the ${maxVisits}-visit loop bound`);
        return txn.record;
      }

      if (spec.kind === 'verifier') this._setRunState(handle, 'verifying');

      const result = await this._runWithRetry(handle, spec);
      if (txn.finished) return txn.record;

      // Cancel wins regardless of what the node returned. A runner that never
      // looked at the signal and reported success anyway used to carry the run
      // all the way to `completed` — so "I cancelled it" and "it completed"
      // could both be true, which makes cancellation meaningless.
      if (handle.signal.aborted) {
        this._absorb(handle, nodeId, result);
        this._setNodeState(handle, nodeId, 'cancelled');
        this._setRunState(handle, 'cancelled');
        return txn.record;
      }

      if (result.awaitHuman) {
        const approved = await this._park(handle, nodeId);
        if (txn.finished) return txn.record;
        if (!approved) {
          this._setNodeState(handle, nodeId, 'failed', { error: 'rejected at human gate' });
          this._setRunState(handle, handle.signal.aborted ? 'cancelled' : 'failed', 'rejected at human gate');
          return txn.record;
        }
        this._setNodeState(handle, nodeId, 'succeeded');
        cursor = spec.next ?? this._nextInOrder(txn.record, nodeId);
        continue;
      }

      this._absorb(handle, nodeId, result);
      if (txn.finished) return txn.record;

      if (!result.ok) {
        this._setNodeState(handle, nodeId, 'failed', { error: result.error });
        if ((spec.onFailure ?? 'fail') === 'fail') {
          await this._finish(handle, `node '${nodeId}' failed: ${result.error ?? 'unknown'}`);
          return txn.record;
        }
        // `continue` — record it and move on.
      } else {
        this._setNodeState(handle, nodeId, 'succeeded');
      }

      if (spec.kind === 'router') {
        cursor = result.goto ?? spec.default ?? this._nextInOrder(txn.record, nodeId);
        continue;
      }
      cursor = spec.next ?? this._nextInOrder(txn.record, nodeId);
    }

    await this._finish(handle);
    return txn.record;
  }

  private async _runWithRetry(handle: RunHandle, spec: NodeSpec): Promise<NodeResult> {
    const txn = handle.txn;
    const maxAttempts = (spec.retry?.max ?? 0) + 1;
    const timeoutMs = spec.timeoutMs ?? this.nodeTimeoutMs;
    let last: NodeResult = { ok: false, error: 'not attempted' };

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (handle.signal.aborted) return { ok: false, error: 'cancelled' };
      // The attempt counter goes in with the state change, so a refused write
      // means the attempt never officially started.
      if (!this._setNodeState(handle, spec.id, 'running', { attempt })) {
        return { ok: false, error: 'the run was taken over by another owner' };
      }

      // A node sees one signal that is the union of "this attempt gave up" and
      // "the whole run was cancelled"; the kernel keeps them apart.
      const attemptSignal = { aborted: false };
      const ctx: NodeContext = {
        runId: txn.guard.runId,
        // A live view of the committed record, so a node holding `ctx` across an
        // await never reads a state the disk refused.
        get record(): RunRecord {
          return txn.record;
        },
        cwd: txn.record.cwd,
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
        // Fenced like everything else. It used to be the one context method that
        // wrote unguarded, so a superseded owner's node could still append to the
        // log its replacement was reading.
        emit: (event) => {
          txn.emit(event);
        },
        runContract: txn.record.spec.contract,
        setHandle: (h) => handle.handles.set(spec.id, h),
        publish: (data) => {
          txn.apply((draft) => {
            const node = draft.nodes[spec.id];
            if (node) node.data = data;
            draft.updatedAt = new Date().toISOString();
          });
        },
        secrets: handle.secrets,
        tag: handle.tag,
        setChild: (childRunId) => {
          txn.apply((draft) => {
            const node = draft.nodes[spec.id];
            if (node) node.childRunId = childRunId;
            draft.updatedAt = new Date().toISOString();
          });
        },
      };

      last = await this._executeNode(spec, ctx, timeoutMs, attemptSignal, handle.inflight);
      if (last.ok || handle.signal.aborted) return last;

      if (attempt < maxAttempts) {
        const backoff = (spec.retry?.backoffMs ?? 1000) * attempt;
        this.logger.warn?.(
          `[kernel] ${txn.guard.runId}/${spec.id} attempt ${attempt}/${maxAttempts} failed: ${last.error} — retrying in ${backoff}ms`,
        );
        await sleep(backoff);
      }
    }
    return last;
  }

  private async _park(handle: RunHandle, nodeId: string): Promise<boolean> {
    // If either write is refused the run is no longer ours, and parking on a
    // gate we can never record the answer to would hang the executor forever.
    if (!this._setNodeState(handle, nodeId, 'awaiting_human')) return false;
    if (!this._setRunState(handle, 'awaiting_human')) return false;
    const approved = await new Promise<boolean>((resolve) => {
      handle.gate = { resolve };
    });
    handle.gate = undefined;
    if (!handle.signal.aborted) this._setRunState(handle, 'running');
    return approved;
  }

  /** Node kinds that can change the workspace. Routers and gates cannot. */
  private static readonly SIDE_EFFECT_KINDS: readonly NodeKind[] = ['agent', 'fanout', 'council', 'subflow'];

  /**
   * Fold a node's result into the run — output, artifacts, cost, votes, verdict
   * — as one committed change.
   *
   * Every one of these used to be assigned straight onto the live record, with
   * only the events fenced. A superseded owner therefore returned a record
   * carrying an output, a cost and a passing verdict that the disk had refused.
   */
  private _absorb(handle: RunHandle, nodeId: string, result: NodeResult): boolean {
    const txn = handle.txn;
    const ts = new Date().toISOString();
    const kind = txn.record.nodes[nodeId]?.kind;
    const events: KernelEvent[] = [];
    const artifacts: NonNullable<CommitBatch['artifacts']> = [];

    // The record keeps a preview so checkpoints stay small; the full text goes
    // to the node's artifact directory, because for some nodes the text *is*
    // the deliverable and a silent 4 kB cut would lose it. The artifact is
    // written inside the same commit as the record that references it, so a
    // refused write leaves neither behind.
    let preview: string | undefined;
    let outputArtifact: string | undefined;
    if (result.output !== undefined) {
      if (result.output.length > OUTPUT_PREVIEW_CHARS) {
        outputArtifact = nodeArtifactPath(txn.guard.runId, nodeId, 'output.txt');
        artifacts.push({ nodeId, name: 'output.txt', body: result.output });
        preview =
          result.output.slice(0, OUTPUT_PREVIEW_CHARS) + `\n…[truncated — full text in nodes/${nodeId}/output.txt]`;
      } else {
        preview = result.output;
      }
      events.push({ ts, type: 'node_output', node: nodeId, text: preview });
    }
    if (result.evidenceId) {
      events.push({
        ts,
        type: 'evidence',
        node: nodeId,
        evidenceId: result.evidenceId,
        passed: Boolean(result.passed),
      });
    }

    return txn.apply(
      (draft) => {
        const node = draft.nodes[nodeId];
        if (!node) return;
        if (kind && RunKernel.SIDE_EFFECT_KINDS.includes(kind)) {
          draft.sideEffectSeq = (draft.sideEffectSeq ?? 0) + 1;
        }
        if (preview !== undefined) node.output = preview;
        if (outputArtifact) node.artifacts = [...new Set([...(node.artifacts ?? []), outputArtifact])];
        if (result.artifacts?.length) node.artifacts = result.artifacts;
        if (result.data !== undefined) node.data = result.data;
        if (result.childRunId) node.childRunId = result.childRunId;
        if (typeof result.costUsd === 'number') draft.costUsd = (draft.costUsd ?? 0) + result.costUsd;
        if (result.consensusVotes?.length) {
          draft.consensusVotes = [...(draft.consensusVotes ?? []), ...result.consensusVotes];
        }
        if (result.evidenceId) {
          node.evidenceId = result.evidenceId;
          draft.evidenceId = result.evidenceId;
          draft.outcome = result.passed ? 'verified' : 'refuted';
          draft.outcomeReason = undefined;
          draft.verdict = {
            node: nodeId,
            evidenceId: result.evidenceId,
            treeFingerprint: result.treeFingerprint,
            sideEffectSeq: draft.sideEffectSeq ?? 0,
          };
        }
        draft.updatedAt = ts;
      },
      events,
      artifacts,
    );
  }

  /**
   * Decide the terminal state. `completed` requires that nothing refuted the run;
   * a run with no contract completes as `unverified`, which says we did not check
   * rather than claiming success.
   */
  private async _finish(handle: RunHandle, error?: string): Promise<void> {
    const txn = handle.txn;
    let outcome: RunOutcome = txn.record.outcome;
    let downgrade: string | undefined;

    // Nothing may still be writing when a verdict is stamped. An abandoned
    // attempt keeps running after its timeout, so wait briefly for it — and if
    // it will not stop, say so instead of vouching for a tree it may yet change.
    //
    // Only when there is a verdict to protect: a run that was never verified has
    // nothing to lose by ending promptly, and blocking it would make one hung
    // node delay every run that contained it.
    if (outcome === 'verified' && !(await this._awaitQuiescence(handle, QUIESCE_GRACE_MS))) {
      outcome = 'unverified';
      downgrade =
        `evidence ${txn.record.verdict?.evidenceId ?? '(none)'} passed, but ${handle.inflight.size} abandoned ` +
        `attempt(s) were still running when the run ended — they can still change the tree, so the verdict ` +
        `cannot stand`;
    }
    if (outcome === 'verified') {
      const stale = await this._verdictWentStale(txn.record);
      if (stale) {
        outcome = 'unverified';
        downgrade = stale;
      }
    }
    if (downgrade) {
      const reason = downgrade;
      txn.apply(
        (draft) => {
          draft.outcome = outcome;
          draft.outcomeReason = reason;
        },
        [{ ts: new Date().toISOString(), type: 'log', level: 'warn', message: `[verify] ${reason}` }],
      );
      if (txn.finished) return;
    }

    if (error || outcome === 'refuted') {
      this._setRunState(handle, 'failed', error ?? 'acceptance contract was not satisfied');
      return;
    }
    this._setRunState(handle, 'completed');
  }

  /**
   * Why a passing verdict no longer stands, or undefined if it still does.
   *
   * `prepareSpec` cannot enforce this structurally: a router can send control
   * anywhere, so which node runs last is not a property of the spec. And a
   * "nothing after the verifier" rule would be the wrong rule anyway — what
   * matters is not that a node ran, but that the tree moved. So this measures.
   *
   * The caller drops the outcome to `unverified`, not `refuted`: no check
   * failed. We simply no longer know, and saying so is the whole point of having
   * three outcomes.
   */
  private async _verdictWentStale(record: RunRecord): Promise<string | undefined> {
    if (record.outcome !== 'verified' || !record.verdict) return undefined;

    // Nothing that could touch the workspace ran after the checks, so the
    // verdict still describes the tree. This is the ordinary case, and it must
    // not depend on git: a contract that passed in a plain directory passed.
    if ((record.sideEffectSeq ?? 0) === record.verdict.sideEffectSeq) return undefined;

    const before = record.verdict.treeFingerprint;
    const after = await treeFingerprint(record.cwd);
    if (before !== undefined && after !== undefined && before === after) return undefined;

    return before === undefined || after === undefined
      ? `evidence ${record.verdict.evidenceId} passed, but nodes ran afterwards and ${record.cwd} is not a git repository, so we cannot tell whether it still describes the tree`
      : `evidence ${record.verdict.evidenceId} passed, but the working tree changed afterwards — the verdict describes an earlier state`;
  }
}

/** Run directory for a given run — re-exported so callers need not import the store. */
export { runDir, summarize };
