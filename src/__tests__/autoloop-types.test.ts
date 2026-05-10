/**
 * Tests for autoloop-types validators and helpers.
 *
 * Runner / phase-machine integration tests are out of scope (require LLM
 * + git + child_process); covered by manual smoke runs.
 */

import { describe, it, expect } from 'vitest';
import {
  validateGoalSpec,
  GoalSpecError,
  deriveMetric,
  isImprovement,
  isTargetReached,
  type GoalSpec,
  type EvalOutput,
} from '../autoloop/v1/types.js';

const minimalScalarGoal: GoalSpec = {
  scalar: { name: 'loss', direction: 'min', extract_cmd: 'echo 0.5', noise_floor: 0.01 },
  gates: [],
  termination: {
    scalar_target_hit: true,
    max_iters: 100,
    plateau_iters: 10,
    max_cost_usd: 50,
    max_pending_aspirational: 5,
  },
};

const minimalGateGoal: GoalSpec = {
  gates: [{ name: 'g1', cmd: 'true', must: 'exit-0', timeout_sec: 300 }],
  termination: {
    scalar_target_hit: true,
    max_iters: 100,
    plateau_iters: 10,
    max_cost_usd: 50,
    max_pending_aspirational: 5,
  },
};

describe('validateGoalSpec', () => {
  it('accepts a scalar-only goal with empty gates', () => {
    const goal = validateGoalSpec({
      scalar: { name: 'x', direction: 'min', extract_cmd: 'true' },
      gates: [],
      termination: { max_iters: 10, plateau_iters: 2, max_cost_usd: 1, max_pending_aspirational: 1 },
    });
    expect(goal.scalar?.name).toBe('x');
    expect(goal.gates).toEqual([]);
  });

  it('accepts a gate-only goal with no scalar', () => {
    const goal = validateGoalSpec({
      gates: [{ name: 'g1', cmd: 'true', must: 'exit-0' }],
      termination: { max_iters: 10, plateau_iters: 2, max_cost_usd: 1, max_pending_aspirational: 1 },
    });
    expect(goal.scalar).toBeUndefined();
    expect(goal.gates[0].timeout_sec).toBe(300); // default applied
  });

  it('rejects when both scalar and gates are missing/empty', () => {
    expect(() =>
      validateGoalSpec({
        gates: [],
        termination: { max_iters: 10, plateau_iters: 2, max_cost_usd: 1, max_pending_aspirational: 1 },
      }),
    ).toThrow(GoalSpecError);
  });

  it('rejects unsupported `must` modes', () => {
    expect(() =>
      validateGoalSpec({
        gates: [{ name: 'g', cmd: 'x', must: 'stdout-matches:foo' }],
        termination: { max_iters: 10, plateau_iters: 2, max_cost_usd: 1, max_pending_aspirational: 1 },
      }),
    ).toThrow(/must/);
  });

  it('rejects bad direction', () => {
    expect(() =>
      validateGoalSpec({
        scalar: { name: 'x', direction: 'sideways', extract_cmd: 'true' },
        gates: [],
        termination: { max_iters: 10, plateau_iters: 2, max_cost_usd: 1, max_pending_aspirational: 1 },
      }),
    ).toThrow(/direction/);
  });
});

describe('deriveMetric', () => {
  const ev: EvalOutput = {
    iter: 1,
    ts: '',
    gates: [],
    scalar: 0.42,
    gate_completion: 0.5,
    all_gates_passed: false,
  };

  it('uses scalar when goal has one and eval produced one', () => {
    expect(deriveMetric(ev, minimalScalarGoal)).toBe(0.42);
  });

  it('falls back to gate_completion when goal has no scalar', () => {
    expect(deriveMetric(ev, minimalGateGoal)).toBe(0.5);
  });

  it('falls back to gate_completion when goal has scalar but eval has null scalar', () => {
    const evNull: EvalOutput = { ...ev, scalar: null };
    expect(deriveMetric(evNull, minimalScalarGoal)).toBe(0.5);
  });
});

describe('isImprovement', () => {
  it('returns true when incumbent is null', () => {
    expect(isImprovement(0.5, null, minimalScalarGoal)).toBe(true);
  });

  it('respects direction=min with noise_floor', () => {
    // incumbent 0.5, candidate 0.4, noise 0.01 → improvement
    expect(isImprovement(0.4, 0.5, minimalScalarGoal)).toBe(true);
    // incumbent 0.5, candidate 0.495, noise 0.01 → within noise → no
    expect(isImprovement(0.495, 0.5, minimalScalarGoal)).toBe(false);
  });

  it('respects direction=max', () => {
    const goal: GoalSpec = {
      ...minimalScalarGoal,
      scalar: { name: 'acc', direction: 'max', extract_cmd: 'true', noise_floor: 0.01 },
    };
    expect(isImprovement(0.6, 0.5, goal)).toBe(true);
    expect(isImprovement(0.505, 0.5, goal)).toBe(false);
  });

  it('without scalar: strictly higher gate_completion is improvement', () => {
    expect(isImprovement(0.6, 0.5, minimalGateGoal)).toBe(true);
    expect(isImprovement(0.5, 0.5, minimalGateGoal)).toBe(false);
  });
});

describe('isTargetReached', () => {
  it('honours scalar.target with min direction', () => {
    const g: GoalSpec = {
      ...minimalScalarGoal,
      scalar: { ...minimalScalarGoal.scalar!, target: 0.3 },
    };
    expect(isTargetReached(0.25, 0, g)).toBe(true);
    expect(isTargetReached(0.31, 0, g)).toBe(false);
  });

  it('honours scalar.target with max direction', () => {
    const g: GoalSpec = {
      ...minimalScalarGoal,
      scalar: { name: 'acc', direction: 'max', extract_cmd: 'true', target: 0.9 },
    };
    expect(isTargetReached(0.95, 0, g)).toBe(true);
    expect(isTargetReached(0.85, 0, g)).toBe(false);
  });

  it('without scalar target, requires gate_completion >= 1.0', () => {
    expect(isTargetReached(0, 1.0, minimalGateGoal)).toBe(true);
    expect(isTargetReached(0, 0.9, minimalGateGoal)).toBe(false);
  });

  it('returns false when scalar_target_hit is disabled', () => {
    const g: GoalSpec = {
      ...minimalScalarGoal,
      termination: { ...minimalScalarGoal.termination, scalar_target_hit: false },
    };
    expect(isTargetReached(0, 1, g)).toBe(false);
  });
});
