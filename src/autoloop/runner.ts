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
import { type AnyAutoloopMessage, AutoloopRoutingError, Msg, validateMessage } from './messages.js';
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
 *  operator pauses while policy pushes keep arriving. Oldest are dropped. */
const MAX_PAUSED_BUFFER = 1000;
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
      // Bound the buffer: a long pause + continuous policy pushes would
      // otherwise grow it without limit and OOM the process.
      if (this.pausedBuffer.length >= MAX_PAUSED_BUFFER) {
        this.pausedBuffer.shift();
        this.emit('error', new Error(`pausedBuffer exceeded ${MAX_PAUSED_BUFFER}; dropping oldest parked message`));
      }
      this.pausedBuffer.push(env);
      return;
    }
    const replies = await this.config.dispatcher.deliver(env);
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
        const pending = env.payload;
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
        return;
      }
      case 'pause': {
        this.state.status = 'paused';
        this.state.status_reason = env.payload.reason;
        this.emit('state', this.state);
        return;
      }
      case 'resume': {
        if (this.state.status === 'paused') {
          // I4 owns the explicit timeout-increase resume contract. Until that
          // arrives, an ordinary resume envelope must not silently discard a
          // pending send deadline and risk replaying its side effects.
          if (this.state.pending_dispatch) return;
          this.state.status = 'running';
          this.state.status_reason = null;
          this.restorePausedMessages();
          this.emit('state', this.state);
        }
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

  /** Restore parked agent-bound messages at the queue head in arrival order. */
  private restorePausedMessages(): void {
    while (this.pausedBuffer.length > 0) {
      const item = this.pausedBuffer.pop();
      if (item) this.queue.unshift(item);
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
