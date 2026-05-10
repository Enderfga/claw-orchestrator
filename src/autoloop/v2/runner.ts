/**
 * Autoloop v2 — thin orchestrator.
 *
 * Pure transport: validates messages, dispatches to agents, handles the
 * tiny set of runner-self-targeted messages (iter_artifacts, review_verdict,
 * pause/resume/terminate, push_user). No LLM logic lives here — that's the
 * AgentDispatcher's job (S2-S4 will plug in real Claude sessions; S1 ships
 * with a mock dispatcher used by tests).
 *
 * Contract: tasks/autoloop-v2.md §3.4 (phase machine lives inside Coder/Reviewer
 * dispatchers, not here).
 */

import { EventEmitter } from 'node:events';
import { type AnyAutoloopV2Message, AutoloopV2RoutingError, Msg, validateMessage } from './messages.js';
import { DEFAULT_PUSH_POLICY, type AutoloopV2Config, type AutoloopV2RunState } from './types.js';

const MAX_DISPATCH_DEPTH = 64;

/**
 * Events emitted by the runner (string keys, documented payloads):
 * - 'message'    : (env: AnyAutoloopV2Message) — every routed message
 * - 'state'      : (state: AutoloopV2RunState) — status / iter changes
 * - 'push'       : ({ level, summary, detail?, channel }) — fired before notifyUser
 * - 'iter_done'  : ({ iter, verdict, metric }) — Reviewer verdict committed
 * - 'terminated' : (reason: string) — final state, no more messages
 * - 'error'      : (err: Error) — routing or dispatcher errors
 */
export class AutoloopV2Runner extends EventEmitter {
  readonly config: AutoloopV2Config;
  state: AutoloopV2RunState;
  /** Queue of messages awaiting routing. Drained by the active dispatch loop. */
  private queue: AnyAutoloopV2Message[] = [];
  private draining = false;
  private regressionStreak = 0;
  private rejectStreak = 0;
  /** Recent push events for dedup (5 min window). */
  private recentPushes: Array<{ key: string; ts: number }> = [];

  constructor(config: AutoloopV2Config) {
    super();
    this.config = config;
    this.state = {
      run_id: config.run_id,
      run_mode: 'v2',
      status: 'planning',
      iter: 0,
      subagents_spawned: false,
      started_at: new Date().toISOString(),
      workspace: config.workspace,
      ledger_dir: config.ledger_dir,
      push_log_count: 0,
      status_reason: null,
    };
  }

  async start(): Promise<void> {
    await this.config.dispatcher.init?.(this.state);
    // Surface initial state so listeners can render the planning UI.
    this.emit('state', this.state);
  }

  /** Enqueue a message and drain the queue. Resolves when the queue is idle. */
  async send(env: AnyAutoloopV2Message): Promise<void> {
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
          throw new AutoloopV2RoutingError(`dispatch depth exceeded ${MAX_DISPATCH_DEPTH} — likely message ping-pong`);
        }
        const env = this.queue.shift();
        if (!env) break;
        await this.handleOne(env);
      }
    } finally {
      this.draining = false;
    }
  }

  private async handleOne(env: AnyAutoloopV2Message): Promise<void> {
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

    // Everything else goes to the agent dispatcher.
    if (this.state.status === 'terminated') return;
    const replies = await this.config.dispatcher.deliver(env);
    for (const r of replies) {
      validateMessage(r);
      this.queue.push(r);
    }
  }

  private async handleRunnerInbox(env: AnyAutoloopV2Message): Promise<void> {
    switch (env.type) {
      case 'iter_artifacts': {
        // Coder produced work for iter N; ask Reviewer to audit.
        const req = Msg.reviewRequest(env.iter, {
          iter: env.iter,
          ledger_path: this.config.ledger_dir,
          prior_metrics: [], // S4 will populate from metric.json
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

        const done = Msg.iterDone(env.iter, {
          iter: env.iter,
          verdict: v.decision,
          metric: v.metric,
          regression,
        });
        this.queue.push(done);
        this.emit('iter_done', { iter: env.iter, verdict: v.decision, metric: v.metric });
        // Trigger policy-based push hooks.
        if (this.regressionStreak >= 2) await this.firePolicyPush('on_metric_regression_2', env.iter);
        if (this.rejectStreak >= 2) await this.firePolicyPush('on_reviewer_reject_2', env.iter);
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
          this.emit('state', this.state);
        }
        return;
      }
      case 'terminate': {
        this.state.status = 'terminated';
        this.state.status_reason = env.payload.reason;
        this.emit('state', this.state);
        await this.config.dispatcher.shutdown?.(env.payload.reason);
        this.emit('terminated', env.payload.reason);
        return;
      }
      default:
        // review_request / iter_done etc. arriving with to=runner is a routing bug.
        throw new AutoloopV2RoutingError(`Unexpected runner-targeted message type: ${env.type}`, env);
    }
  }

  private async handlePushUser(env: AnyAutoloopV2Message): Promise<void> {
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
  }
}
