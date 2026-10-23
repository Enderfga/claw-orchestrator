/**
 * Autoloop — thin orchestrator.
 *
 * Pure transport: validates messages, dispatches to agents, handles the
 * tiny set of runner-self-targeted messages (iter_artifacts, review_verdict,
 * send_timeout, pause/resume/terminate, push_user). No LLM logic lives here — that's the
 * AgentDispatcher's job (S2-S4 will plug in real Claude sessions; S1 ships
 * with a mock dispatcher used by tests).
 *
 * The phase machine lives inside the Coder/Reviewer dispatchers, not here.
 */

import { EventEmitter } from 'node:events';
import {
  type AnyAutoloopMessage,
  AutoloopRoutingError,
  Msg,
  type SendTimeoutPayload,
  validateMessage,
} from './messages.js';
import {
  DEFAULT_PUSH_POLICY,
  MAX_METRIC_HISTORY,
  resolveAutoloopTimeoutConfig,
  type AutoloopConfig,
  type AutoloopState,
  type ResolvedAutoloopTimeoutConfig,
} from './types.js';

const MAX_DISPATCH_DEPTH = 64;
/** Cap on agent-bound messages parked during a pause, to bound memory if an
 *  operator pauses while policy pushes keep arriving. Oldest untracked
 *  messages are dropped; accepted chat is never evicted. */
const MAX_PAUSED_BUFFER = 1000;
/** Most accepted chat entries that may wait for handoff at once. */
export const MAX_PENDING_CHAT = 1000;
/** Most UTF-8 bytes of accepted chat text that may wait for handoff at once. */
export const MAX_PENDING_CHAT_BYTES = 8 * 1024 * 1024;
export const CHAT_PERSIST_ERROR = 'autoloop chat could not be persisted';
export const CHAT_STOPPING_ERROR = 'autoloop run is stopping; chat was not accepted';
export const CHAT_RESTORING_ERROR = 'autoloop run is still restoring; chat was not accepted';
export const CHAT_LIMIT_ERROR = 'autoloop chat refused: too much chat is already pending';
/** Ordinary-pause reason while an unconfirmed-chat notice could not be recorded. */
export const CHAT_NOTICE_PENDING = 'chat_notice_pending';
const MAX_DATE_MS = 8.64e15;

/** Chat accepted into the checkpoint but not yet handed to the dispatcher. */
export interface PendingChatEntry {
  msg_id: string;
  iter: number;
  ts: string;
  text: string;
}

/** The one accepted chat whose physical send may have started. */
export interface InFlightChat {
  msg_id: string;
  handed_at: string;
}

export type UnconfirmedChatStatus = NonNullable<AutoloopState['unconfirmed_chat']>;

/** Accepted-chat fields carried by the node checkpoint. Always replaced, never mutated. */
export interface AutoloopInputSnapshot {
  readonly pendingChat: readonly PendingChatEntry[];
  readonly inFlightChat: InFlightChat | null;
  readonly unconfirmed?: UnconfirmedChatStatus;
}

const EMPTY_INPUT: AutoloopInputSnapshot = Object.freeze({ pendingChat: Object.freeze([]), inFlightChat: null });

function freezeInput(input: AutoloopInputSnapshot): AutoloopInputSnapshot {
  return Object.freeze({
    pendingChat: Object.freeze(input.pendingChat.map((e) => (Object.isFrozen(e) ? e : Object.freeze({ ...e })))),
    inFlightChat: input.inFlightChat ? Object.freeze({ ...input.inFlightChat }) : null,
    ...(input.unconfirmed ? { unconfirmed: Object.freeze({ ...input.unconfirmed }) } : {}),
  });
}

/** Total UTF-8 bytes of pending chat text. */
export function pendingChatBytes(entries: readonly PendingChatEntry[]): number {
  let total = 0;
  for (const e of entries) total += Buffer.byteLength(e.text, 'utf8');
  return total;
}

function chatEnvelope(entry: PendingChatEntry): AnyAutoloopMessage {
  return {
    msg_id: entry.msg_id,
    iter: entry.iter,
    from: 'user',
    to: 'planner',
    type: 'chat',
    ts: entry.ts,
    payload: { text: entry.text },
  };
}
const DEFAULT_PHASE_ERROR_CIRCUIT = 3;
const DEFAULT_STALL_MS = 30 * 60_000;
const DEFAULT_STALL_CHECK_MS = 30_000;

/**
 * The single allow-list for activity-lease renewal. These values describe
 * externally validated forward progress, rather than work the runner creates
 * for itself. Timer checks and bookkeeping are explicit negative cases so a
 * caller cannot accidentally turn polling into an infinite lease.
 */
export const LEASE_RENEWING_ACTIVITY_KINDS = [
  'queue_message_accepted',
  'agent_progress',
  'lifecycle_transition',
  'checkpoint_persisted',
] as const;

export type LeaseRenewingActivityKind = (typeof LEASE_RENEWING_ACTIVITY_KINDS)[number];
export type AutoloopActivityKind = LeaseRenewingActivityKind | 'timer_check' | 'runner_bookkeeping';
export type AutoloopTimeoutKind = 'activity_lease_expired' | 'hard_timeout_exceeded';

export interface AutoloopTimeoutEvent {
  kind: AutoloopTimeoutKind;
  observed_at: number;
  deadline_at: number;
  last_activity_at: number;
}

const LEASE_RENEWING_ACTIVITY_SET = new Set<string>(LEASE_RENEWING_ACTIVITY_KINDS);

/**
 * Events emitted by the runner (string keys, documented payloads):
 * - 'message'    : (env: AnyAutoloopMessage) — every routed message
 * - 'state'      : (state: AutoloopState) — status / iter changes
 * - 'push'       : ({ level, summary, detail?, channel }) — fired before notifyUser
 * - 'iter_done'  : ({ iter, verdict, metric }) — Reviewer verdict committed
 * - 'send_timeout': (payload: SendTimeoutPayload) — recoverable agent deadline
 * - 'timeout'    : (event: AutoloopTimeoutEvent) — lease or hard deadline expired
 * - 'terminated' : (reason: string) — final state, no more messages
 * - 'error'      : (err: Error) — routing or dispatcher errors
 */
export class AutoloopRunner extends EventEmitter {
  readonly config: AutoloopConfig;
  state: AutoloopState;
  /** Queue of messages awaiting routing. Drained by the active dispatch loop. */
  private queue: AnyAutoloopMessage[] = [];
  /**
   * Holds agent-bound messages that arrived while status === 'paused'.
   * On `resume`, they are unshifted back onto the queue head in order so
   * the loop continues exactly where it stopped.
   */
  private pausedBuffer: AnyAutoloopMessage[] = [];
  private draining = false;
  private regressionStreak = 0;
  private rejectStreak = 0;
  /** Recent push events for dedup (5 min window). */
  private recentPushes: Array<{ key: string; ts: number }> = [];
  private stallTimer: ReturnType<typeof setInterval> | null = null;
  private activityLeaseTimer: ReturnType<typeof setTimeout> | null = null;
  private hardDeadlineTimer: ReturnType<typeof setTimeout> | null = null;
  private lifecycleTimersStarted = false;
  private timeoutMonitoringStopped = false;
  private activityLeaseExpired = false;
  private terminationStarted = false;
  private terminationPromise: Promise<void> | null = null;
  /** Timeout outcomes explicitly advanced by an operator resume. Retained so a
   *  late/replayed result for the same logical dispatch cannot pause the run a
   *  second time after it has already been resolved. */
  private readonly resolvedTimedOutDispatches = new Set<string>();
  private readonly timeouts: ResolvedAutoloopTimeoutConfig;
  private readonly hardDeadlineAt: number;
  /** Last accepted-chat snapshot the checkpoint confirmed. */
  private committedInput: AutoloopInputSnapshot = EMPTY_INPUT;
  /** Candidate visible to the checkpoint only during its own commit call. */
  private stagedInput: AutoloopInputSnapshot | null = null;
  /** 'loaded' refuses accept until reconcile; 'reconciled' waits for release. */
  private restorePhase: 'none' | 'loaded' | 'reconciled' = 'none';
  /** Restored pending chat ids, released in this order once the run is ready. */
  private restoredChatIds: string[] = [];

  constructor(config: AutoloopConfig) {
    super();
    this.config = config;
    this.timeouts = resolveAutoloopTimeoutConfig(config);
    const startedAt = Date.now();
    this.hardDeadlineAt = startedAt + this.timeouts.autoloopHardTimeoutMs;
    this.state = {
      run_id: config.run_id,
      status: 'planning',
      iter: 0,
      subagents_spawned: false,
      started_at: new Date(startedAt).toISOString(),
      workspace: config.workspace,
      ledger_dir: config.ledger_dir,
      push_log_count: 0,
      status_reason: null,
      pending_dispatch: null,
      consecutive_phase_errors: 0,
      recent_phase_errors: [],
      metric_history: [],
      last_activity_at: startedAt,
    };
  }

  async start(): Promise<void> {
    this.startLifecycleTimers();
    try {
      await this.config.dispatcher.init?.(this.state);
    } catch (err) {
      this.stop();
      throw err;
    }
    if (this.timeoutMonitoringStopped || this.terminationStarted) return;
    // Surface initial state so listeners can render the planning UI.
    this.emit('state', this.state);
    this.startStallDetector();
  }

  /**
   * Stop every runner-owned timer. Safe to call repeatedly; cancellation uses
   * this before shutting down agents so no late timeout callback can mutate
   * state or initiate a second shutdown.
   */
  stop(): void {
    this.timeoutMonitoringStopped = true;
    if (this.stallTimer) {
      clearInterval(this.stallTimer);
      this.stallTimer = null;
    }
    if (this.activityLeaseTimer) {
      clearTimeout(this.activityLeaseTimer);
      this.activityLeaseTimer = null;
    }
    if (this.hardDeadlineTimer) {
      clearTimeout(this.hardDeadlineTimer);
      this.hardDeadlineTimer = null;
    }
  }

  /**
   * Record a candidate activity signal through the centralized renewal rule.
   * Returns true only when the signal renewed the lease. Callers must validate
   * progress before selecting one of the four allow-listed kinds above.
   */
  recordActivity(kind: AutoloopActivityKind): boolean {
    if (!LEASE_RENEWING_ACTIVITY_SET.has(kind)) return false;
    if (
      this.timeoutMonitoringStopped ||
      this.activityLeaseExpired ||
      this.terminationStarted ||
      this.state.status === 'terminated' ||
      this.state.status === 'crashed'
    ) {
      return false;
    }
    const now = Date.now();
    if (now >= this.hardDeadlineAt) {
      void this.expireHardDeadline().catch((err) => this.emit('error', err));
      return false;
    }
    this.state.last_activity_at = now;
    this.armActivityLease();
    return true;
  }

  private startLifecycleTimers(): void {
    if (this.lifecycleTimersStarted || this.timeoutMonitoringStopped) return;
    this.lifecycleTimersStarted = true;
    // Arm the absolute deadline first. armActivityLease deliberately omits a
    // lease timer when both deadlines coincide, making hard-cap precedence
    // independent of timer insertion order.
    this.armHardDeadline();
    this.armActivityLease();
  }

  private armHardDeadline(): void {
    if (this.timeoutMonitoringStopped || this.terminationStarted) return;
    if (this.hardDeadlineTimer) clearTimeout(this.hardDeadlineTimer);
    const delay = Math.max(0, this.hardDeadlineAt - Date.now());
    this.hardDeadlineTimer = setTimeout(() => {
      this.hardDeadlineTimer = null;
      void this.expireHardDeadline().catch((err) => this.emit('error', err));
    }, delay);
    this.hardDeadlineTimer?.unref?.();
  }

  private armActivityLease(): void {
    if (this.activityLeaseTimer) {
      clearTimeout(this.activityLeaseTimer);
      this.activityLeaseTimer = null;
    }
    if (
      !this.lifecycleTimersStarted ||
      this.timeoutMonitoringStopped ||
      this.activityLeaseExpired ||
      this.terminationStarted ||
      this.state.pending_dispatch
    ) {
      return;
    }
    const activityDeadline = this.state.last_activity_at + this.timeouts.activityLeaseMs;
    if (activityDeadline >= this.hardDeadlineAt) return;
    this.activityLeaseTimer = setTimeout(
      () => {
        this.activityLeaseTimer = null;
        this.expireActivityLease();
      },
      Math.max(0, activityDeadline - Date.now()),
    );
    this.activityLeaseTimer?.unref?.();
  }

  private expireActivityLease(): void {
    if (this.timeoutMonitoringStopped || this.activityLeaseExpired || this.terminationStarted) return;
    const now = Date.now();
    if (now >= this.hardDeadlineAt) {
      void this.expireHardDeadline().catch((err) => this.emit('error', err));
      return;
    }
    const activityDeadline = this.state.last_activity_at + this.timeouts.activityLeaseMs;
    // A clock adjustment or renewal racing this callback may make it early.
    if (now < activityDeadline) {
      this.armActivityLease();
      return;
    }
    this.activityLeaseExpired = true;
    this.state.status = 'paused';
    this.state.status_reason = 'activity_lease_expired';
    const event: AutoloopTimeoutEvent = {
      kind: 'activity_lease_expired',
      observed_at: now,
      deadline_at: activityDeadline,
      last_activity_at: this.state.last_activity_at,
    };
    this.emit('state', this.state);
    this.emit('timeout', event);
  }

  private async expireHardDeadline(): Promise<void> {
    if (this.timeoutMonitoringStopped || this.terminationStarted) return;
    const now = Date.now();
    if (now < this.hardDeadlineAt) {
      this.armHardDeadline();
      return;
    }
    await this.terminate('hard_timeout_exceeded', {
      kind: 'hard_timeout_exceeded',
      observed_at: now,
      deadline_at: this.hardDeadlineAt,
      last_activity_at: this.state.last_activity_at,
    });
  }

  private terminate(reason: string, timeoutEvent?: AutoloopTimeoutEvent): Promise<void> {
    if (this.terminationStarted) return this.terminationPromise ?? Promise.resolve();
    this.terminationStarted = true;
    this.state.status = 'terminated';
    this.state.status_reason = reason;
    this.state.pending_dispatch = null;
    this.queue.length = 0;
    this.pausedBuffer.length = 0;
    this.stop();
    // Pending chat stays in the checkpoint for the next resume; only the
    // in-flight marker becomes a notice.
    this.convertUnconfirmedChat();
    this.emit('state', this.state);
    if (timeoutEvent) this.emit('timeout', timeoutEvent);
    this.terminationPromise = (async () => {
      await this.config.dispatcher.shutdown?.(reason);
      this.emit('terminated', reason);
    })();
    return this.terminationPromise;
  }

  private startStallDetector(): void {
    if (this.stallTimer || this.timeoutMonitoringStopped || this.terminationStarted) return;
    const stallMs = this.config.stallMs ?? DEFAULT_STALL_MS;
    const intervalMs = this.config.stallCheckIntervalMs ?? DEFAULT_STALL_CHECK_MS;
    this.stallTimer = setInterval(() => {
      if (this.state.status !== 'running') return;
      const idleFor = Date.now() - this.state.last_activity_at;
      if (idleFor < stallMs) return;
      // Reuse the policy-push pipeline so dedup applies.
      void this.firePolicyPush('on_stall_30min', this.state.iter).catch((err) => {
        this.emit('error', err);
      });
    }, intervalMs);
    // Don't keep node alive solely for stall checking.
    this.stallTimer?.unref?.();
  }

  /** Enqueue a message and drain the queue. Resolves when the queue is idle. */
  async send(env: AnyAutoloopMessage): Promise<void> {
    validateMessage(env);
    this.recordActivity('queue_message_accepted');
    this.queue.push(env);
    await this.drain();
  }

  /** External entry: user typed something to Planner. */
  chat(text: string): Promise<void> {
    return this.send(Msg.chat(this.state.iter, { text }));
  }

  /**
   * Durably accept operator chat. Returns the envelope to hand to `send` once
   * the checkpoint holding it has committed; throws without side effects
   * otherwise.
   */
  acceptChat(text: string): AnyAutoloopMessage {
    if (this.terminationStarted || this.state.status === 'terminated' || this.state.status === 'crashed') {
      throw new Error(CHAT_STOPPING_ERROR);
    }
    if (!this.config.persistCheckpoint) throw new Error(CHAT_PERSIST_ERROR);
    if (this.restorePhase === 'loaded') throw new Error(CHAT_RESTORING_ERROR);
    const env = Msg.chat(this.state.iter, { text });
    const pendingChat = [...this.committedInput.pendingChat, { msg_id: env.msg_id, iter: env.iter, ts: env.ts, text }];
    if (pendingChat.length > MAX_PENDING_CHAT || pendingChatBytes(pendingChat) > MAX_PENDING_CHAT_BYTES) {
      throw new Error(CHAT_LIMIT_ERROR);
    }
    if (!this.commitInput({ ...this.committedInput, pendingChat })) throw new Error(CHAT_PERSIST_ERROR);
    return env;
  }

  /** The accepted-chat snapshot the next checkpoint should carry. */
  checkpointInput(): AutoloopInputSnapshot {
    return this.stagedInput ?? this.committedInput;
  }

  /**
   * Kernel cancel won out-of-band. No further agent-bound work starts, a late
   * settle neither clears the marker nor enqueues follow-ups, and an in-flight
   * marker becomes a notice now: `terminate` would return early from here on.
   */
  markCancelledByKernel(): void {
    this.terminationStarted = true;
    this.convertUnconfirmedChat();
  }

  /**
   * Load the accepted-chat snapshot restored from the checkpoint. Boot-time
   * only: nothing is converted, queued or sent until reconcile and release.
   */
  loadRestoredInput(input: AutoloopInputSnapshot): void {
    this.committedInput = freezeInput(input);
    this.adoptUnconfirmed(this.committedInput);
    this.restoredChatIds = this.committedInput.pendingChat.map((e) => e.msg_id);
    this.restorePhase = 'loaded';
  }

  /** Record a restored in-flight marker as a notice; pause visibly if that fails. */
  reconcileRestoredInput(): void {
    if (this.restorePhase !== 'loaded') return;
    this.restorePhase = 'reconciled';
    if (this.terminationStarted || this.state.status === 'terminated' || this.state.status === 'crashed') return;
    this.convertUnconfirmedChat();
    if (!this.inputResolved()) this.enterNoticePause();
  }

  /** Queue (or park, while paused) restored pending chat in its original order. */
  releaseRestoredInput(): void {
    if (this.restorePhase === 'loaded') return;
    this.restorePhase = 'none';
    const ids = this.restoredChatIds;
    this.restoredChatIds = [];
    if (this.terminationStarted || this.state.status === 'terminated' || this.state.status === 'crashed') return;
    const pending = new Map(this.committedInput.pendingChat.map((e) => [e.msg_id, e]));
    const envs = ids.flatMap((id) => {
      const entry = pending.get(id);
      return entry ? [chatEnvelope(entry)] : [];
    });
    if (envs.length === 0) return;
    if (this.state.status === 'paused') {
      for (const env of envs) this.park(env);
      return;
    }
    this.queue.push(...envs);
    void this.drain().catch((err) => this.emit('error', err));
  }

  /**
   * Continue a live ordinary or activity-lease pause. A pending send-timeout
   * dispatch is not this transition. The state write is synchronous; this
   * method returns once the run is active again (or hard-deadline expiry has
   * been started). Parked input is then delivered once, in order, by the
   * background drain. The original hard deadline is not moved.
   */
  resumePaused(): boolean {
    if (
      this.state.status !== 'paused' ||
      this.state.pending_dispatch !== null ||
      this.terminationStarted ||
      this.timeoutMonitoringStopped
    ) {
      return false;
    }
    if (Date.now() >= this.hardDeadlineAt) {
      void this.expireHardDeadline().catch((err) => {
        this.emit('error', err);
      });
      return false;
    }
    // Parked chat must not be handed over while an earlier unconfirmed chat
    // still lacks its notice.
    this.convertUnconfirmedChat();
    if (!this.inputResolved()) return false;
    this.activityLeaseExpired = false;
    this.state.status = this.state.subagents_spawned ? 'running' : 'planning';
    this.state.status_reason = null;
    this.recordActivity('lifecycle_transition');
    this.restorePausedMessages();
    this.emit('state', this.state);
    void this.drain().catch((err) => {
      this.emit('error', err);
    });
    return true;
  }

  /**
   * Advance one exact recoverable send-timeout pause without replaying the
   * logical dispatch that timed out. SessionManager validates and audits the
   * timeout increase before calling this synchronous transition.
   */
  resumeTimedOutDispatch(dispatchId: string): boolean {
    const pending = this.state.pending_dispatch;
    if (
      this.state.status !== 'paused' ||
      !pending ||
      pending.dispatch_id !== dispatchId ||
      this.state.status_reason !== `awaiting_resume:send_timeout:${pending.agent}:${dispatchId}`
    ) {
      return false;
    }

    this.resolvedTimedOutDispatches.add(dispatchId);
    this.state.pending_dispatch = null;
    this.state.status = 'running';
    this.state.status_reason = null;
    this.recordActivity('lifecycle_transition');
    this.restorePausedMessages();
    this.emit('state', this.state);
    // This entry point is called outside the normal queue drain. Resume only
    // the messages parked *after* the timed-out dispatch; the timed-out message
    // itself is deliberately never requeued.
    void this.drain().catch((err) => this.emit('error', err));
    return true;
  }

  /** Mark subagents spawned (called by S3's spawn_subagents tool handler). */
  markSubagentsSpawned(): void {
    if (this.state.subagents_spawned) return;
    this.recordActivity('lifecycle_transition');
    this.state.subagents_spawned = true;
    this.state.status = 'running';
    this.emit('state', this.state);
  }

  // ─── Drain loop ────────────────────────────────────────────────────────────

  private async drain(): Promise<void> {
    if (this.draining) return; // a previous send() is already draining; new items will be picked up
    this.draining = true;
    try {
      const maxDepth = this.config.maxDispatchDepth ?? MAX_DISPATCH_DEPTH;
      let depth = 0;
      while (this.queue.length > 0) {
        if (depth++ > maxDepth) {
          const next = this.queue[0];
          throw new AutoloopRoutingError(
            `dispatch depth exceeded ${maxDepth} at iter ${this.state.iter} (next='${next?.type ?? '?'}' to '${next?.to ?? '?'}') — likely message ping-pong; raise config.maxDispatchDepth for legitimately deep workflows`,
          );
        }
        const env = this.queue.shift();
        if (!env) break;
        await this.handleOne(env);
      }
    } finally {
      this.draining = false;
    }
  }

  private async handleOne(env: AnyAutoloopMessage): Promise<void> {
    // 'terminated' is the final state — once reached, no message of any kind is
    // processed (see events contract above). The terminate message itself still
    // runs because status only flips to 'terminated' while handling it.
    if (this.state.status === 'terminated' || this.state.status === 'crashed') return;
    // After a kernel cancel nothing agent- or user-bound is handled.
    if (this.terminationStarted && env.to !== 'runner') return;
    this.emit('message', env);

    // Runner is the target for a small set of messages — handle them inline.
    if (env.to === 'runner') {
      await this.handleRunnerInbox(env);
      return;
    }

    // user → planner: forward to dispatcher.
    // user is not a real agent; we don't dispatch to it, we consume `push_user`.
    if (env.to === 'user') {
      await this.handlePushUser(env);
      return;
    }

    // Everything else goes to the agent dispatcher. (terminated already
    // short-circuited at the top of handleOne.)
    // Pause: park agent-bound messages until resume. Runner-bound (resume /
    // terminate) and user-bound (push) flow through above and are unaffected.
    if (this.state.status === 'paused') {
      this.park(env);
      return;
    }
    const tracked = env.type === 'chat' && this.committedInput.pendingChat.some((e) => e.msg_id === env.msg_id);
    if (tracked) {
      if (!this.inputResolved()) {
        this.convertUnconfirmedChat();
        if (!this.inputResolved()) {
          this.enterNoticePause();
          this.park(env);
          return;
        }
      }
      const handoff: AutoloopInputSnapshot = {
        ...this.committedInput,
        pendingChat: this.committedInput.pendingChat.filter((e) => e.msg_id !== env.msg_id),
        inFlightChat: { msg_id: env.msg_id, handed_at: new Date().toISOString() },
      };
      if (!this.commitInput(handoff)) {
        // Nothing was handed over: keep the chat first in line and stop here.
        this.queue.unshift(env);
        throw new Error(CHAT_PERSIST_ERROR);
      }
    }
    let replies: AnyAutoloopMessage[];
    try {
      replies = await this.config.dispatcher.deliver(env);
    } catch (err) {
      // A throw does not prove the send never happened; never resend it.
      if (tracked) this.convertUnconfirmedChat();
      throw err;
    }
    if (tracked) {
      if (this.terminationStarted) return;
      const timeout = replies.find((r) => r.type === 'send_timeout');
      if (timeout?.type === 'send_timeout') {
        const queuedTerminate = this.queue.find((m) => m.type === 'terminate');
        if (queuedTerminate?.type === 'terminate') {
          await this.terminate(queuedTerminate.payload.reason);
          return;
        }
        // Pause before anything queued behind this chat is handed over.
        this.applySendTimeout(timeout.payload);
      } else if (this.committedInput.inFlightChat?.msg_id === env.msg_id) {
        // A refused clear leaves the marker; it later becomes a conservative notice.
        this.commitInput({ ...this.committedInput, inFlightChat: null });
      }
    }
    for (const r of replies) {
      validateMessage(r);
      // A dispatcher-generated deadline record is bookkeeping, not agent
      // progress. Letting it renew the lease would make a timeout extend the
      // run whose lack of progress caused it.
      if (r.type !== 'send_timeout') this.recordActivity('agent_progress');
      this.queue.push(r);
    }
  }

  private async handleRunnerInbox(env: AnyAutoloopMessage): Promise<void> {
    switch (env.type) {
      case 'iter_artifacts': {
        // Coder produced work for iter N; ask Reviewer to audit.
        const req = Msg.reviewRequest(env.iter, {
          iter: env.iter,
          ledger_path: this.config.ledger_dir,
          prior_metrics: this.state.metric_history.slice(-10),
        });
        this.queue.push(req);
        return;
      }
      case 'review_verdict': {
        const v = env.payload;
        const regression = v.decision === 'rollback';
        if (v.decision === 'hold' || v.decision === 'rollback') {
          this.rejectStreak++;
        } else {
          this.rejectStreak = 0;
        }
        if (regression) this.regressionStreak++;
        else this.regressionStreak = 0;

        // A non-error iter resets the phase-error circuit.
        this.state.consecutive_phase_errors = 0;
        this.state.recent_phase_errors = [];

        // A7: record metric for prior_metrics on the next review_request.
        if (typeof v.metric === 'number' && Number.isFinite(v.metric)) {
          this.state.metric_history.push(v.metric);
          if (this.state.metric_history.length > MAX_METRIC_HISTORY) {
            this.state.metric_history.splice(0, this.state.metric_history.length - MAX_METRIC_HISTORY);
          }
        }

        const done = Msg.iterDone(env.iter, {
          iter: env.iter,
          verdict: v.decision,
          metric: v.metric,
          regression,
        });
        this.queue.push(done);
        // A1: advance iter counter after a verdict is committed. The new iter
        // becomes addressable for follow-up directives, push events, and SSE.
        this.state.iter = env.iter + 1;
        this.emit('state', this.state);
        this.emit('iter_done', { iter: env.iter, verdict: v.decision, metric: v.metric });
        // Trigger policy-based push hooks.
        if (this.regressionStreak >= 2) await this.firePolicyPush('on_metric_regression_2', env.iter);
        if (this.rejectStreak >= 2) await this.firePolicyPush('on_reviewer_reject_2', env.iter);
        // The one success signal in the policy set. It stayed silent for its
        // whole existence because nothing could tell when the goal was met — a
        // Reviewer verdict is a reading of the Coder's report, not a measurement.
        // An acceptance contract is a measurement, so this fires on it.
        if (v.accepted) await this.firePolicyPush('on_target_hit', env.iter);
        return;
      }
      case 'phase_error': {
        // A3 + C2: track consecutive failures and trip the circuit breaker.
        const p = env.payload;
        this.state.consecutive_phase_errors += 1;
        this.state.recent_phase_errors.push({
          ts: env.ts,
          agent: p.agent,
          phase: p.phase,
          error: p.error,
        });
        if (this.state.recent_phase_errors.length > 5) {
          this.state.recent_phase_errors.splice(0, this.state.recent_phase_errors.length - 5);
        }
        this.emit('state', this.state);
        this.emit('phase_error', p);
        await this.firePolicyPush('on_phase_error', env.iter);
        const circuit = this.config.phaseErrorCircuit ?? DEFAULT_PHASE_ERROR_CIRCUIT;
        if (this.state.consecutive_phase_errors >= circuit) {
          const detail = this.state.recent_phase_errors
            .map((e) => `${e.agent}/${e.phase}: ${e.error.slice(0, 160)}`)
            .join('\n');
          this.queue.push(
            Msg.pushUser(env.iter, {
              level: 'decision',
              summary: `phase-error circuit tripped (${this.state.consecutive_phase_errors} consecutive)`,
              detail,
              channel: 'both',
            }),
          );
          this.queue.push(
            Msg.terminate(env.iter, {
              reason: 'phase_error_circuit',
            }),
          );
        }
        return;
      }
      case 'send_timeout': {
        this.applySendTimeout(env.payload);
        return;
      }
      case 'pause': {
        this.state.status = 'paused';
        this.state.status_reason = env.payload.reason;
        this.emit('state', this.state);
        return;
      }
      case 'resume': {
        this.resumePaused();
        return;
      }
      case 'terminate': {
        await this.terminate(env.payload.reason);
        return;
      }
      default:
        // review_request / iter_done etc. arriving with to=runner is a routing bug.
        throw new AutoloopRoutingError(`Unexpected runner-targeted message type: ${env.type}`, env);
    }
  }

  private applySendTimeout(pending: SendTimeoutPayload): void {
    if (this.resolvedTimedOutDispatches.has(pending.dispatch_id)) return;
    // The dispatcher coalesces duplicate delivery, but the runner also
    // guards its public inbox so replaying the same structured outcome
    // cannot emit a second timeout event or mutate state twice.
    if (this.state.pending_dispatch?.dispatch_id === pending.dispatch_id) return;
    // Awaiting an operator decision is a deliberate pause, not subsequent
    // inactivity. Suspend only the renewable lease; the absolute hard
    // deadline stays armed and remains terminal.
    if (this.activityLeaseTimer) {
      clearTimeout(this.activityLeaseTimer);
      this.activityLeaseTimer = null;
    }
    this.state.status = 'paused';
    this.state.status_reason = `awaiting_resume:send_timeout:${pending.agent}:${pending.dispatch_id}`;
    this.state.pending_dispatch = { ...pending };
    this.emit('state', this.state);
    this.emit('send_timeout', this.state.pending_dispatch);
  }

  /** Restore parked agent-bound messages at the queue head in arrival order. */
  private restorePausedMessages(): void {
    while (this.pausedBuffer.length > 0) {
      const item = this.pausedBuffer.pop();
      if (item) this.queue.unshift(item);
    }
  }

  /**
   * Park an agent-bound message during a pause. When the buffer is full the
   * oldest message that is not accepted chat is evicted; accepted chat is
   * never dropped.
   */
  private park(env: AnyAutoloopMessage): void {
    if (this.pausedBuffer.length >= MAX_PAUSED_BUFFER) {
      const accepted = new Set(this.committedInput.pendingChat.map((e) => e.msg_id));
      const evict = this.pausedBuffer.findIndex((m) => !accepted.has(m.msg_id));
      if (evict >= 0) {
        this.pausedBuffer.splice(evict, 1);
        this.emit('error', new Error(`pausedBuffer exceeded ${MAX_PAUSED_BUFFER}; dropping oldest parked message`));
      } else {
        // The acceptance bound equals the buffer bound, so a full buffer of
        // accepted chat leaves no room for another accepted entry.
        if (accepted.has(env.msg_id)) {
          throw new AutoloopRoutingError('pausedBuffer full of accepted chat while parking accepted chat', env);
        }
        this.emit('error', new Error('pausedBuffer full of accepted chat; dropping incoming parked message'));
        return;
      }
    }
    this.pausedBuffer.push(env);
  }

  // ─── Accepted-chat checkpoint ──────────────────────────────────────────────

  /**
   * Stage one complete replacement snapshot, commit it through the node
   * checkpoint and adopt it only when that commit succeeded.
   */
  private commitInput(next: AutoloopInputSnapshot): boolean {
    const staged = freezeInput(next);
    this.stagedInput = staged;
    let committed = false;
    try {
      committed = this.config.persistCheckpoint?.() === true;
    } catch {
      committed = false;
    } finally {
      this.stagedInput = null;
    }
    if (committed) {
      this.committedInput = staged;
      this.adoptUnconfirmed(staged);
    }
    return committed;
  }

  private adoptUnconfirmed(input: AutoloopInputSnapshot): void {
    if (input.unconfirmed) this.state.unconfirmed_chat = input.unconfirmed;
    else delete this.state.unconfirmed_chat;
  }

  /** True when no in-flight marker or unrecorded notice is outstanding. */
  private inputResolved(): boolean {
    return !this.committedInput.inFlightChat && !this.committedInput.unconfirmed?.history_pending;
  }

  private enterNoticePause(): void {
    this.state.status = 'paused';
    this.state.status_reason = CHAT_NOTICE_PENDING;
    this.state.pending_dispatch = null;
    this.emit('state', this.state);
  }

  /**
   * Turn the in-flight marker into one logical notice: commit the obligation
   * with its timestamp, append the history line, then clear `history_pending`.
   * Any refusal keeps the obligation for the next attempt, which reuses the
   * same timestamp.
   */
  private convertUnconfirmedChat(): void {
    for (let step = 0; step < 2 && !this.inputResolved(); step++) {
      const input = this.committedInput;
      const prev = input.unconfirmed;
      if (input.inFlightChat && !prev?.history_pending) {
        const prevCount = prev?.count ?? 0;
        // Same as timestamp exhaustion: refuse before commit so the marker and
        // visible obligation stay, and the checkpoint remains restorable.
        if (prevCount >= Number.MAX_SAFE_INTEGER) return;
        const prevMillis = prev ? Date.parse(prev.last_at) : Number.NEGATIVE_INFINITY;
        const at = Math.max(Date.now(), prevMillis + 1);
        if (!Number.isFinite(at) || Math.abs(at) > MAX_DATE_MS) return;
        const converted: AutoloopInputSnapshot = {
          pendingChat: input.pendingChat,
          inFlightChat: null,
          unconfirmed: { count: prevCount + 1, last_at: new Date(at).toISOString(), history_pending: true },
        };
        if (!this.commitInput(converted)) return;
      }
      const pending = this.committedInput.unconfirmed;
      if (!pending?.history_pending) continue;
      let appended = false;
      try {
        appended = this.config.dispatcher.appendUnconfirmedChatNotice?.(pending.last_at) === true;
      } catch {
        appended = false;
      }
      if (!appended) return;
      if (!this.commitInput({ ...this.committedInput, unconfirmed: { ...pending, history_pending: false } })) return;
    }
  }

  private async handlePushUser(env: AnyAutoloopMessage): Promise<void> {
    if (env.type !== 'push_user') return;
    const p = env.payload;
    const key = `${p.level}:${p.summary}`;
    const now = Date.now();
    // 5 min dedup
    this.recentPushes = this.recentPushes.filter((r) => now - r.ts < 5 * 60_000);
    if (this.recentPushes.some((r) => r.key === key)) return;
    this.recentPushes.push({ key, ts: now });

    this.state.push_log_count++;
    this.emit('push', { level: p.level, summary: p.summary, detail: p.detail, channel: p.channel });
    await this.config.notifyUser(p.level, p.summary, p.detail, p.channel);
  }

  private async firePolicyPush(rule: keyof typeof DEFAULT_PUSH_POLICY, iter: number): Promise<void> {
    const policy = this.config.push_policy ?? DEFAULT_PUSH_POLICY;
    const r = policy[rule];
    if (!r || r.silent) return;
    const summary = `[${rule}] iter ${iter}`;
    // We synthesise a push_user envelope as if Planner had asked for it, so
    // dedup + push_log book-keeping go through the same path.
    this.queue.push(
      Msg.pushUser(iter, {
        level: r.level ?? 'info',
        summary,
        channel: r.channel ?? 'auto',
      }),
    );
    // When firePolicyPush is called from outside a running drain (e.g. the
    // stall-detector interval), the queued message would otherwise sit until
    // the next send(). Kick the drain — the re-entrancy guard makes this safe
    // when we ARE inside a drain.
    if (!this.draining) {
      await this.drain();
    }
  }
}
