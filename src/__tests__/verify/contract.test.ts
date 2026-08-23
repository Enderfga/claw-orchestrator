/**
 * Contract normalization is the provenance boundary: a contract may come from a
 * caller or a mode default, never from agent output. `normalizeContract` is what
 * a tool-call payload passes through, so anything it fails to recognise must be
 * dropped rather than carried into the executor.
 */

import { describe, it, expect } from 'vitest';
import { contractPassed, normalizeContract, type CheckResult } from '../../verify/contract.js';

const result = (over: Partial<CheckResult>): CheckResult => ({
  id: 'c',
  type: 'command',
  required: true,
  passed: true,
  durationMs: 1,
  detail: '',
  ...over,
});

describe('normalizeContract', () => {
  it('accepts a wrapped check', () => {
    const c = normalizeContract({ checks: [{ spec: { type: 'command', cmd: 'npm', args: ['test'] } }] });
    expect(c?.checks).toHaveLength(1);
    expect(c?.checks[0].spec).toMatchObject({ type: 'command', cmd: 'npm', args: ['test'] });
  });

  it('accepts a bare check spec, since hand-written tool calls omit the wrapper', () => {
    const c = normalizeContract({ checks: [{ type: 'command', cmd: 'make' }] });
    expect(c?.checks[0].spec).toMatchObject({ type: 'command', cmd: 'make' });
  });

  it('defaults every check to required', () => {
    const c = normalizeContract({ checks: [{ type: 'file', path: 'a.txt' }] });
    expect(c?.checks[0].required).toBe(true);
  });

  it('honours an explicit required:false', () => {
    const c = normalizeContract({ checks: [{ type: 'file', path: 'a.txt', required: false }] });
    expect(c?.checks[0].required).toBe(false);
  });

  it('assigns stable ids when none are given', () => {
    const c = normalizeContract({
      checks: [
        { type: 'command', cmd: 'a' },
        { type: 'command', cmd: 'b' },
      ],
    });
    expect(c?.checks.map((x) => x.id)).toEqual(['command-1', 'command-2']);
  });

  it('drops unknown check types instead of passing them through', () => {
    const c = normalizeContract({
      checks: [
        { type: 'command', cmd: 'ok' },
        { type: 'rm_rf', path: '/' },
      ],
    });
    expect(c?.checks).toHaveLength(1);
    expect(c?.checks[0].spec.type).toBe('command');
  });

  it('rejects a command check with no cmd', () => {
    expect(normalizeContract({ checks: [{ type: 'command', args: ['x'] }] })).toBeUndefined();
  });

  it('strips fields it does not model — there is no shell string to inject into', () => {
    const c = normalizeContract({
      checks: [{ type: 'command', cmd: 'npm', args: ['test'], shell: 'rm -rf /', env: { EVIL: '1' } }],
    });
    expect(c?.checks[0].spec).not.toHaveProperty('shell');
    expect(c?.checks[0].spec).not.toHaveProperty('env');
  });

  it('coerces non-string args to a rejection rather than silently dropping one', () => {
    const c = normalizeContract({ checks: [{ type: 'command', cmd: 'npm', args: ['test', 5] }] });
    expect(c?.checks[0].spec).toMatchObject({ args: [] });
  });

  it('returns undefined when nothing usable survives', () => {
    expect(normalizeContract({ checks: [] })).toBeUndefined();
    expect(normalizeContract({ checks: [{ type: 'nope' }] })).toBeUndefined();
    expect(normalizeContract({})).toBeUndefined();
    expect(normalizeContract(null)).toBeUndefined();
    expect(normalizeContract('checks: [{type: command}]')).toBeUndefined();
  });

  it('requires viewports on a screenshot check', () => {
    expect(normalizeContract({ checks: [{ type: 'screenshot', url: 'http://x' }] })).toBeUndefined();
    const c = normalizeContract({
      checks: [{ type: 'screenshot', url: 'http://x', viewports: [{ width: 1440, height: 900 }] }],
    });
    expect(c?.checks).toHaveLength(1);
  });
});

describe('contractPassed', () => {
  it('passes when every required check passed', () => {
    expect(contractPassed([result({ passed: true }), result({ passed: true })])).toBe(true);
  });

  it('fails on a required red', () => {
    expect(contractPassed([result({ passed: true }), result({ passed: false, required: true })])).toBe(false);
  });

  it('tolerates a non-required red — the field the predecessor declared and never read', () => {
    expect(contractPassed([result({ passed: true }), result({ passed: false, required: false })])).toBe(true);
  });

  it('passes an empty result set (nothing ran, nothing refuted)', () => {
    expect(contractPassed([])).toBe(true);
  });
});
