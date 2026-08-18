/**
 * Unit tests for the uniform spend cap.
 *
 * The behaviour under test is the one `maxBudgetUsd` never actually had: a cap
 * that applies to every engine, not just the one whose CLI happens to take a
 * --max-budget-usd flag.
 */

import { describe, it, expect } from 'vitest';
import { BudgetExceededError, checkBudget, isBudgetExceeded } from '../budget.js';

const CTX = { session: 'test-session', engine: 'codex' };

describe('isBudgetExceeded', () => {
  it('is false when no cap is configured', () => {
    expect(isBudgetExceeded(99, undefined)).toBe(false);
  });

  it('treats a zero or negative cap as unset rather than as "refuse everything"', () => {
    expect(isBudgetExceeded(1, 0)).toBe(false);
    expect(isBudgetExceeded(1, -5)).toBe(false);
  });

  it('is false below the cap', () => {
    expect(isBudgetExceeded(0.9999, 1)).toBe(false);
  });

  it('is true exactly at the cap', () => {
    expect(isBudgetExceeded(1, 1)).toBe(true);
  });

  it('is true above the cap', () => {
    expect(isBudgetExceeded(1.5, 1)).toBe(true);
  });

  it('is false when spend is not a finite number', () => {
    expect(isBudgetExceeded(Number.NaN, 1)).toBe(false);
  });

  it('is false when the cap is not a finite number', () => {
    expect(isBudgetExceeded(10, Number.POSITIVE_INFINITY)).toBe(false);
  });
});

describe('checkBudget', () => {
  it('returns quietly when under the cap', () => {
    expect(() => checkBudget(0.5, 1, CTX)).not.toThrow();
  });

  it('returns quietly when no cap is set', () => {
    expect(() => checkBudget(1000, undefined, CTX)).not.toThrow();
  });

  it('throws a typed error carrying spend, cap, session and engine', () => {
    let caught: unknown;
    try {
      checkBudget(2.25, 1.5, CTX);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BudgetExceededError);
    const err = caught as BudgetExceededError;
    expect(err.code).toBe('BUDGET_EXCEEDED');
    expect(err.spentUsd).toBe(2.25);
    expect(err.capUsd).toBe(1.5);
    expect(err.session).toBe('test-session');
    expect(err.engine).toBe('codex');
  });

  it('names the numbers in the message so the caller can act on it', () => {
    expect(() => checkBudget(2.25, 1.5, CTX)).toThrow(/\$2\.2500 of \$1\.5000/);
    expect(() => checkBudget(2.25, 1.5, CTX)).toThrow(/test-session/);
  });
});
