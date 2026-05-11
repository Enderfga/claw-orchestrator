/**
 * Autoloop — thin orchestrator.
 *
 * Pure transport: validates messages, dispatches to agents, handles the
 * tiny set of runner-self-targeted messages (iter_artifacts, review_verdict,
 * pause/resume/terminate, push_user). No LLM logic lives here — that's the
 * AgentDispatcher's job (S2-S4 will plug in real Claude sessions; S1 ships
 * with a mock dispatcher used by tests).
 *
 * Contract: tasks/autoloop.md §3.4 (phase machine lives inside Coder/Reviewer
 * dispatchers, not here).
 */

import { EventEmitter } from 'node:events';
import { type AnyAutoloopMessage, AutoloopRoutingError, Msg, validateMessage } from './messages.js';
import { DEFAULT_PUSH_POLICY, MAX_METRIC_HISTORY, type AutoloopConfig, type AutoloopState } from './types.js';

const MAX_DISPATCH_DEPTH = 64;
const DEFAULT_PHASE_ERROR_CIRCUIT = 3;
const DEFAULT_STALL_MS = 30 * 60_000;
const DEFAULT_STALL_CHECK_MS = 30_000;

/**
 * Events emitted by the runner (string keys, documented payloads):
 * - 'message'    : (env: AnyAutoloopMessage) — every routed message
 * - 'state'      : (state: AutoloopState) — status / iter changes
 * - 'push'       : ({ level, summary, detail?, channel }) — fired before notifyUser
 * - 'iter_done'  : ({ iter, verdict, metric }) — Reviewer verdict committed
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

  constructor(config: AutoloopConfig) {
    super();
    this.config = config;
    this.state = {
      run_id: config.run_id,
      status: 'planning',
      iter: 0,
      subagents_spawned: false,
      started_at: new Date().toISOString(),
      workspace: config.workspace,
      ledger_dir: config.ledger_dir,
      push_log_count: 0,
      status_reason: null,
      consecutive_phase_errors: 0,
      recent_phase_errors: [],
      metric_history: [],
      last_activity_at: Date.now(),
    };
  }

  async start(): Promise<void> {
    await this.config.dispatcher.init?.(this.state);
    // Surface initial state so listeners can render the planning UI.
    this.emit('state', this.state);
    this.startStallDetector();
  }

  /** Stop the stall detector; safe to call multiple times. Tests use this. */
  stop(): void {
    if (this.stallTimer) {
      clearInterval(this.stallTimer);
      this.stallTimer = null;
    }
  }

  private startStallDetector(): void {
    if (this.stallTimer) return;
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
    this.queue.push(env);
    await this.drain();
  }

  /** External entry: user typed something to Planner. */
  chat(text: string): Promise<void> {
    return this.send(Msg.chat(this.state.iter, { text }));
  }

  /** Mark subagents spawned (called by S3's spawn_subagents tool handler). */
  markSubagentsSpawned(): void {
    if (this.state.subagents_spawned) return;
    this.state.subagents_spawned = true;
    this.state.status = 'running';
    this.emit('state', this.state);
  }

  // ─── Drain loop ────────────────────────────────────────────────────────────

  private async drain(): Promise<void> {
    if (this.draining) return; // a previous send() is already draining; new items will be picked up
    this.draining = true;
    try {
      let depth = 0;
      while (this.queue.length > 0) {
        if (depth++ > MAX_DISPATCH_DEPTH) {
          throw new AutoloopRoutingError(`dispatch depth exceeded ${MAX_DISPATCH_DEPTH} — likely message ping-pong`);
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
    this.emit('message', env);
    this.state.last_activity_at = Date.now();

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

    // Everything else goes to the agent dispatcher.
    if (this.state.status === 'terminated') return;
    // Pause: park agent-bound messages until resume. Runner-bound (resume /
    // terminate) and user-bound (push) flow through above and are unaffected.
    if (this.state.status === 'paused') {
      this.pausedBuffer.push(env);
      return;
    }
    const replies = await this.config.dispatcher.deliver(env);
    for (const r of replies) {
      validateMessage(r);
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
      case 'pause': {
        this.state.status = 'paused';
        this.state.status_reason = env.payload.reason;
        this.emit('state', this.state);
        return;
      }
      case 'resume': {
        if (this.state.status === 'paused') {
          this.state.status = 'running';
          this.state.status_reason = null;
          // Restore parked agent-bound messages at the queue head, preserving
          // arrival order so the loop continues from where pause caught it.
          while (this.pausedBuffer.length > 0) {
            const item = this.pausedBuffer.pop();
            if (item) this.queue.unshift(item);
          }
          this.emit('state', this.state);
        }
        return;
      }
      case 'terminate': {
        this.state.status = 'terminated';
        this.state.status_reason = env.payload.reason;
        this.stop();
        this.emit('state', this.state);
        await this.config.dispatcher.shutdown?.(env.payload.reason);
        this.emit('terminated', env.payload.reason);
        return;
      }
      default:
        // review_request / iter_done etc. arriving with to=runner is a routing bug.
        throw new AutoloopRoutingError(`Unexpected runner-targeted message type: ${env.type}`, env);
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
