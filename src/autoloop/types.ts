/**
 * Runner-level types for autoloop (three-agent architecture).
 */

import type { AnyAutoloopMessage, PushChannel, PushLevel, SendTimeoutPayload } from './messages.js';

export type AutoloopStatus = 'planning' | 'running' | 'paused' | 'terminated' | 'crashed';

/** The three autoloop roles. Single source of truth — dispatcher and SessionManager both use it. */
export type AutoloopRoleName = 'planner' | 'coder' | 'reviewer';

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
  /**
   * The one logical agent dispatch awaiting an explicit resume decision.
   * Optional for backward compatibility with state checkpointed before I3.
   */
  pending_dispatch?: SendTimeoutPayload | null;
  /**
   * Phase-error circuit breaker — incremented on every `phase_error` message,
   * cleared on each successful (non-error) `iter_done`. When it reaches
   * `AutoloopConfig.phaseErrorCircuit`, the runner auto-terminates.
   */
  consecutive_phase_errors: number;
  /** Recent (≤ 3) phase_error payloads kept around for circuit-trip push detail. */
  recent_phase_errors: Array<{ ts: string; agent: string; phase: string; error: string }>;
  /** Recent metric history (most-recent last, capped at MAX_METRIC_HISTORY). */
  metric_history: number[];
  /** ms since epoch of the last handled message; used by stall detector. */
  last_activity_at: number;
}

/** How many metric points the runner remembers for prior_metrics injection. */
export const MAX_METRIC_HISTORY = 20;
/** Schema version stamped onto every ledger artifact (directive/eval/verdict.json). */
export const LEDGER_SCHEMA_VERSION = 1;

/** Default wall-clock cap for one Planner, Coder, or Reviewer message. */
export const DEFAULT_SEND_TIMEOUT_MS = 600_000;
/** Shortest supported wall-clock cap for one agent message. */
export const MIN_SEND_TIMEOUT_MS = 5_000;
/** Longest supported wall-clock cap for one agent message. */
export const MAX_SEND_TIMEOUT_MS = 7_200_000;
/** Default inactivity lease for an Autoloop run. */
export const DEFAULT_ACTIVITY_LEASE_MS = 1_800_000;
/** Shortest supported inactivity lease. */
export const MIN_ACTIVITY_LEASE_MS = 60_000;
/** Longest supported inactivity lease. */
export const MAX_ACTIVITY_LEASE_MS = 7_200_000;
/** Default absolute lifetime cap for an Autoloop run. */
export const DEFAULT_AUTOLOOP_HARD_TIMEOUT_MS = 86_400_000;
/** Shortest supported absolute lifetime cap. */
export const MIN_AUTOLOOP_HARD_TIMEOUT_MS = 600_000;
/** Longest supported absolute lifetime cap (72 hours). */
export const MAX_AUTOLOOP_HARD_TIMEOUT_MS = 259_200_000;

/** User-configurable Autoloop timeout values. Omitted values use the defaults above. */
export interface AutoloopTimeoutConfig {
  sendTimeoutMs?: number;
  activityLeaseMs?: number;
  autoloopHardTimeoutMs?: number;
}

/** Fully resolved timeout values used by the Autoloop runtime. */
export type ResolvedAutoloopTimeoutConfig = Required<AutoloopTimeoutConfig>;

export interface AutoloopTimeoutFieldSchema {
  readonly type: 'number';
  readonly default: number;
  readonly minimum: number;
  readonly maximum: number;
}

/** JSON-Schema-compatible metadata shared by runtime validation and later API schemas. */
export const AUTOLOOP_TIMEOUT_SCHEMA = {
  sendTimeoutMs: {
    type: 'number',
    default: DEFAULT_SEND_TIMEOUT_MS,
    minimum: MIN_SEND_TIMEOUT_MS,
    maximum: MAX_SEND_TIMEOUT_MS,
  },
  activityLeaseMs: {
    type: 'number',
    default: DEFAULT_ACTIVITY_LEASE_MS,
    minimum: MIN_ACTIVITY_LEASE_MS,
    maximum: MAX_ACTIVITY_LEASE_MS,
  },
  autoloopHardTimeoutMs: {
    type: 'number',
    default: DEFAULT_AUTOLOOP_HARD_TIMEOUT_MS,
    minimum: MIN_AUTOLOOP_HARD_TIMEOUT_MS,
    maximum: MAX_AUTOLOOP_HARD_TIMEOUT_MS,
  },
} as const satisfies Record<keyof ResolvedAutoloopTimeoutConfig, AutoloopTimeoutFieldSchema>;

const AUTOLOOP_TIMEOUT_FIELDS = [
  'sendTimeoutMs',
  'activityLeaseMs',
  'autoloopHardTimeoutMs',
] as const satisfies readonly (keyof AutoloopTimeoutConfig)[];

export function validateAutoloopTimeoutConfig(config: AutoloopTimeoutConfig): void {
  for (const field of AUTOLOOP_TIMEOUT_FIELDS) {
    const value = config[field];
    if (value === undefined) continue;
    const { minimum, maximum } = AUTOLOOP_TIMEOUT_SCHEMA[field];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
      throw new Error(`${field} must be a finite number in the inclusive range [${minimum}, ${maximum}]`);
    }
  }
}

export function resolveAutoloopTimeoutConfig(config: AutoloopTimeoutConfig = {}): ResolvedAutoloopTimeoutConfig {
  validateAutoloopTimeoutConfig(config);
  return {
    sendTimeoutMs: config.sendTimeoutMs ?? DEFAULT_SEND_TIMEOUT_MS,
    activityLeaseMs: config.activityLeaseMs ?? DEFAULT_ACTIVITY_LEASE_MS,
    autoloopHardTimeoutMs: config.autoloopHardTimeoutMs ?? DEFAULT_AUTOLOOP_HARD_TIMEOUT_MS,
  };
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

export interface AutoloopConfig extends AutoloopTimeoutConfig {
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
  /**
   * Phase-error circuit threshold. After this many consecutive `phase_error`
   * messages the runner auto-terminates with reason `phase_error_circuit`
   * (and emits a decision-level push first). Default 3.
   */
  phaseErrorCircuit?: number;
  /**
   * Max messages routed in a single drain pass before the runner assumes a
   * message ping-pong loop and aborts. Raise for legitimately deep workflows
   * (many directive/policy-push chains per turn). Default 64.
   */
  maxDispatchDepth?: number;
  /**
   * Stall detection wall-clock budget (ms). When no message has been
   * processed for this long and status is 'running', the runner fires
   * `on_stall_30min`. Default 30 min.
   */
  stallMs?: number;
  /**
   * Stall check interval (ms). Default 30 s. Tests pass a smaller value
   * along with shorter `stallMs` so the assertions complete quickly.
   */
  stallCheckIntervalMs?: number;
}
