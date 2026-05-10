/**
 * Types for the autoloop feature.
 *
 * Contracts are documented in tasks/autoloop.md. Schemas here are intentionally
 * narrow — additions belong in the design doc first.
 */

import type { EngineType } from './types.js';

// ─── Phases ──────────────────────────────────────────────────────────────────

export type AutoloopPhase =
  | 'BOOTSTRAP'
  | 'PROPOSE'
  | 'EXECUTE'
  | 'MEASURE'
  | 'RATCHET'
  | 'COMPRESS'
  | 'IDLE'
  | 'TERMINATED';

export type AutoloopStatus = 'starting' | 'running' | 'paused' | 'completed' | 'error' | 'stopped';

// ─── Goal Specification (goal.json) ──────────────────────────────────────────

export interface ScalarSpec {
  /** Name of the metric for display / logs */
  name: string;
  /** Optimisation direction */
  direction: 'min' | 'max';
  /**
   * Shell command that prints the scalar value to stdout (one number).
   * Run by EXECUTE in the workspace. Must be deterministic.
   */
  extract_cmd: string;
  /** Stop when scalar reaches this. For 'min' direction, stop when ≤ target. */
  target?: number;
  /** Changes within ±noise_floor are not considered improvements. Default 0. */
  noise_floor?: number;
}

export interface GateSpec {
  /** Stable identifier (used in state.json gate accounting) */
  name: string;
  /**
   * Shell command. Exit code 0 = pass, non-zero = fail.
   * Time-limited (see GateSpec.timeout_sec).
   */
  cmd: string;
  /**
   * Pass condition. Currently only 'exit-0' is supported.
   * Future: 'stdout-matches:<regex>', 'json-field:<path>=<value>'.
   */
  must: 'exit-0';
  /** Per-gate timeout in seconds. Default 300. */
  timeout_sec?: number;
}

export interface TerminationSpec {
  scalar_target_hit?: boolean;
  max_iters: number;
  /** Plateau triggers async push but loop continues unless user stops. */
  plateau_iters: number;
  max_cost_usd: number;
  /** Cap on un-locked aspirational gates (agent must rotate before adding more). */
  max_pending_aspirational: number;
}

export interface GoalSpec {
  /**
   * Optional: when null/absent, the loop has no faithful scalar; goal_completion
   * becomes the de-facto scalar (= locked_gates_passed / locked_gates_total).
   */
  scalar?: ScalarSpec;
  /** Locked gates (user-approved). Hard requirements; all must pass for ratchet. */
  gates: GateSpec[];
  /**
   * Aspirational gates proposed by agent during BOOTSTRAP or mid-loop.
   * Don't count toward goal_completion until user moves them to `gates`.
   * Capped by termination.max_pending_aspirational.
   */
  aspirational_gates?: GateSpec[];
  termination: TerminationSpec;
}

// ─── State Ledger (state.json) ───────────────────────────────────────────────

export interface BestPoint {
  iter: number;
  metric: number;
  git_sha: string;
  gate_completion: number;
}

export interface MetricPoint {
  iter: number;
  metric: number;
  gate_completion: number;
}

export interface StateTree {
  /** For serial v1: always points to last committed iter. */
  parent_iter: number | null;
  /** For population (v2): list of forks. v1 always [iter] or []. */
  children_iters: number[];
}

export type RatchetDecision = 'commit' | 'reset' | 'pending';

export interface AutoloopState {
  task_id: string;
  branch: string;
  phase: AutoloopPhase;
  status: AutoloopStatus;
  iter: number;
  started_at: string;
  best: BestPoint | null;
  last_metric: MetricPoint | null;
  plateau_count: number;
  /** Set by RATCHET only. PROPOSE / MEASURE may not write this. */
  decision: RatchetDecision | null;
  decision_reason: string | null;
  tree: StateTree;
  termination: {
    fired: boolean;
    reason: string | null;
  };
  cost_usd_so_far: number;
  /** Pushed-but-not-yet-locked aspirational gates the agent has proposed. */
  pending_aspirational_count: number;
}

// ─── Metric History (metric.json) — append-only array ───────────────────────

export interface MetricHistoryEntry {
  iter: number;
  ts: string;
  metric: number;
  gate_completion: number;
  phase_at_record: AutoloopPhase;
  git_sha_pre?: string;
  git_sha_post?: string;
}

// ─── Per-iter Eval Output (iter/<n>/eval.json) ──────────────────────────────

export interface GateResult {
  name: string;
  passed: boolean;
  exit_code: number;
  duration_ms: number;
  /** Truncated stdout/stderr tail for diagnostic context. */
  output_tail: string;
}

export interface EvalOutput {
  iter: number;
  ts: string;
  /** All locked-gate results, in goal.json order. */
  gates: GateResult[];
  /** null when no scalar in goal.json or extract_cmd failed. */
  scalar: number | null;
  /** Computed = (gates that passed) / (locked gates total). */
  gate_completion: number;
  /** True if every locked gate passed. */
  all_gates_passed: boolean;
}

// ─── RATCHET Output (iter/<n>/ratchet.json) ─────────────────────────────────

export interface RatchetOutput {
  iter: number;
  decision: RatchetDecision;
  reason: string;
  /** True if RATCHET wants the runner to push the user (e.g. unsure / new-best / plateau). */
  push_user?: {
    kind: 'new_best' | 'plateau' | 'unsure_no_metric' | 'aspirational_proposed';
    text: string;
  };
}

// ─── Push Triggers ──────────────────────────────────────────────────────────

export type PushKind =
  | 'bootstrap_aspirational'
  | 'new_best'
  | 'plateau'
  | 'unsure_no_metric'
  | 'aspirational_proposed'
  | 'termination'
  | 'hard_error';

export interface PushEvent {
  kind: PushKind;
  text: string;
  task_id: string;
  iter: number;
  ts: string;
}

// ─── Runner Configuration (passed to autoloop_start) ────────────────────────

export interface AutoloopConfig {
  /** Workspace path — must be a git repo. tasks/<id>/ will be created here. */
  workspace: string;
  /** Path to plan.md (will be copied into tasks/<id>/plan.md). */
  plan_path: string;
  /** Path to goal.json (will be copied + validated into tasks/<id>/goal.json). */
  goal_path: string;
  /** Override for the task id; defaults to a timestamped slug. */
  task_id?: string;

  /** Engine for PROPOSE/BOOTSTRAP/COMPRESS. Default 'claude'. */
  propose_engine?: EngineType;
  /** Model for PROPOSE/BOOTSTRAP/COMPRESS. Default 'opus'. */
  propose_model?: string;

  /** Engine for RATCHET. Default 'claude'. */
  ratchet_engine?: EngineType;
  /** Model for RATCHET. Default 'opus'. */
  ratchet_model?: string;

  /** How often to run COMPRESS. Default 10. */
  compress_every_k?: number;
  /** Per-iter wall clock for PROPOSE/EXECUTE phases (ms). Default 600_000 (10 min). */
  per_iter_timeout_ms?: number;

  /** Push hook command (defaults to `openclaw message send`). Set to null to disable pushes. */
  push_cmd?: string | null;
}

export interface AutoloopHandle {
  id: string;
  status: AutoloopStatus;
  task_dir: string;
  started_at: string;
  ended_at?: string;
  /** Last-known phase from state.json (cheap to read). */
  current_phase?: AutoloopPhase;
  current_iter?: number;
  best_metric?: number;
  error?: string;
}

// ─── Validation Helpers ─────────────────────────────────────────────────────

export class GoalSpecError extends Error {
  constructor(message: string) {
    super(`goal.json: ${message}`);
    this.name = 'GoalSpecError';
  }
}

export function validateGoalSpec(raw: unknown): GoalSpec {
  if (!raw || typeof raw !== 'object') throw new GoalSpecError('must be an object');
  const o = raw as Record<string, unknown>;

  if (!Array.isArray(o.gates)) throw new GoalSpecError('`gates` must be an array');
  const gates = o.gates.map((g, i) => validateGate(g, `gates[${i}]`));

  let scalar: ScalarSpec | undefined;
  if (o.scalar != null) scalar = validateScalar(o.scalar);

  let aspirational_gates: GateSpec[] | undefined;
  if (Array.isArray(o.aspirational_gates)) {
    aspirational_gates = o.aspirational_gates.map((g, i) => validateGate(g, `aspirational_gates[${i}]`));
  }

  if (!o.termination || typeof o.termination !== 'object') {
    throw new GoalSpecError('`termination` is required');
  }
  const termination = validateTermination(o.termination);

  // Cross-check: if no scalar, gates must be non-empty (otherwise the loop has nothing to ratchet against)
  if (!scalar && gates.length === 0) {
    throw new GoalSpecError('must have at least one of `scalar` or `gates`');
  }

  return { scalar, gates, aspirational_gates, termination };
}

function validateScalar(raw: unknown): ScalarSpec {
  const o = raw as Record<string, unknown>;
  if (typeof o.name !== 'string') throw new GoalSpecError('scalar.name must be string');
  if (o.direction !== 'min' && o.direction !== 'max') {
    throw new GoalSpecError('scalar.direction must be "min" or "max"');
  }
  if (typeof o.extract_cmd !== 'string' || !o.extract_cmd.trim()) {
    throw new GoalSpecError('scalar.extract_cmd must be a non-empty string');
  }
  return {
    name: o.name,
    direction: o.direction,
    extract_cmd: o.extract_cmd,
    target: typeof o.target === 'number' ? o.target : undefined,
    noise_floor: typeof o.noise_floor === 'number' ? o.noise_floor : 0,
  };
}

function validateGate(raw: unknown, ctx: string): GateSpec {
  const o = raw as Record<string, unknown>;
  if (typeof o.name !== 'string') throw new GoalSpecError(`${ctx}.name must be string`);
  if (typeof o.cmd !== 'string' || !o.cmd.trim()) {
    throw new GoalSpecError(`${ctx}.cmd must be a non-empty string`);
  }
  if (o.must !== 'exit-0') {
    throw new GoalSpecError(`${ctx}.must must be "exit-0" (other modes not yet supported)`);
  }
  return {
    name: o.name,
    cmd: o.cmd,
    must: 'exit-0',
    timeout_sec: typeof o.timeout_sec === 'number' && o.timeout_sec > 0 ? o.timeout_sec : 300,
  };
}

function validateTermination(raw: unknown): TerminationSpec {
  const o = raw as Record<string, unknown>;
  const num = (k: string, def?: number): number => {
    if (typeof o[k] === 'number' && Number.isFinite(o[k] as number)) return o[k] as number;
    if (def !== undefined) return def;
    throw new GoalSpecError(`termination.${k} must be a number`);
  };
  return {
    scalar_target_hit: o.scalar_target_hit !== false,
    max_iters: num('max_iters', 200),
    plateau_iters: num('plateau_iters', 10),
    max_cost_usd: num('max_cost_usd', 200),
    max_pending_aspirational: num('max_pending_aspirational', 5),
  };
}

/**
 * Derive the metric value used for ratcheting from an EvalOutput.
 * Rule:
 *   - If goal has a scalar AND eval produced one, use the scalar.
 *   - Otherwise, use gate_completion (∈ [0, 1]).
 */
export function deriveMetric(eval_out: EvalOutput, goal: GoalSpec): number {
  if (goal.scalar && eval_out.scalar != null) return eval_out.scalar;
  return eval_out.gate_completion;
}

/**
 * Did `candidate` improve over `incumbent` for this goal? Honours noise_floor.
 * If no scalar, "improve" means strictly higher gate_completion.
 */
export function isImprovement(candidate: number, incumbent: number | null, goal: GoalSpec): boolean {
  if (incumbent === null) return true;
  if (goal.scalar) {
    const noise = goal.scalar.noise_floor ?? 0;
    if (goal.scalar.direction === 'min') return candidate < incumbent - noise;
    return candidate > incumbent + noise;
  }
  // No scalar: gate_completion, higher is better, no noise floor.
  return candidate > incumbent;
}

/** Has the scalar/gate target been hit? */
export function isTargetReached(metric: number, gate_completion: number, goal: GoalSpec): boolean {
  if (!goal.termination.scalar_target_hit) return false;
  if (goal.scalar?.target != null) {
    if (goal.scalar.direction === 'min') return metric <= goal.scalar.target;
    return metric >= goal.scalar.target;
  }
  // No scalar target set; "done" means all gates passing.
  return gate_completion >= 1.0;
}
