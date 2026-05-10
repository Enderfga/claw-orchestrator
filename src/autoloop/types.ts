/**
 * Runner-level types for autoloop (three-agent architecture).
 *
 * Contract: tasks/autoloop.md.
 */

import type { AnyAutoloopMessage, PushChannel, PushLevel } from './messages.js';

export type AutoloopStatus = 'planning' | 'running' | 'paused' | 'terminated' | 'crashed';

export interface AutoloopState {
  run_id: string;
  status: AutoloopStatus;
  iter: number;
  /** Set once Planner calls `spawn_subagents`. Until then we are in "planning" mode. */
  subagents_spawned: boolean;
  started_at: string;
  workspace: string;
  ledger_dir: string;
  push_log_count: number;
  /** Last reason set when status flips to terminated/crashed/paused. */
  status_reason: string | null;
}

export interface PushPolicyRule {
  silent?: boolean;
  level?: PushLevel;
  channel?: PushChannel;
}

export interface PushPolicy {
  on_start: PushPolicyRule;
  on_iter_done_ok: PushPolicyRule;
  on_target_hit: PushPolicyRule;
  on_metric_regression_2: PushPolicyRule;
  on_reviewer_reject_2: PushPolicyRule;
  on_phase_error: PushPolicyRule;
  on_stall_30min: PushPolicyRule;
  on_decision_needed: PushPolicyRule;
}

export const DEFAULT_PUSH_POLICY: PushPolicy = {
  on_start: { level: 'info', channel: 'wechat' },
  on_iter_done_ok: { silent: true },
  on_target_hit: { level: 'info', channel: 'both' },
  on_metric_regression_2: { level: 'warn', channel: 'both' },
  on_reviewer_reject_2: { level: 'warn', channel: 'both' },
  on_phase_error: { level: 'error', channel: 'both' },
  on_stall_30min: { level: 'warn', channel: 'wechat' },
  on_decision_needed: { level: 'decision', channel: 'both' },
};

/**
 * Pluggable agent layer. The runner stays transport-only; an AgentDispatcher
 * implementation owns the actual Claude (or mock) sessions and turns inbound
 * messages into outbound replies. S2/S3/S4 swap mocks for real persistent
 * sessions; the runner contract stays the same.
 */
export interface AgentDispatcher {
  /**
   * Deliver `env` to its target agent and return any messages the agent emits
   * synchronously in reply. Asynchronous emissions should also be returned
   * (the runner awaits this call).
   */
  deliver(env: AnyAutoloopMessage): Promise<AnyAutoloopMessage[]>;
  /** Called once when the runner is starting up — agent may pre-warm sessions. */
  init?(state: AutoloopState): Promise<void>;
  /** Called on terminate — agent must release sessions cleanly. */
  shutdown?(reason: string): Promise<void>;
}

export interface AutoloopConfig {
  run_id: string;
  workspace: string;
  ledger_dir: string;
  /** Optional override; defaults to DEFAULT_PUSH_POLICY. */
  push_policy?: PushPolicy;
  /**
   * Notifier the runner calls when a `push_user` message arrives.
   * S3 will plug in the wechat→whatsapp→email fallback chain; S1/S2 use
   * a recording stub.
   */
  notifyUser: (level: PushLevel, summary: string, detail: string | undefined, channel: PushChannel) => Promise<void>;
  /** Agent transport layer (mockable). */
  dispatcher: AgentDispatcher;
}
