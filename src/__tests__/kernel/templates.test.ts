/**
 * Built-in workflows. These are ordinary specs, so the tests read them the way
 * the kernel does rather than trusting the builder's intent.
 */

import { describe, it, expect } from 'vitest';
import { councilWorkflow, fanoutWorkflow, solveWorkflow } from '../../kernel/templates/index.js';
import { prepareSpec, IMPLICIT_VERIFIER_ID } from '../../kernel/engine.js';
import type { RouterNode, VerifierNode } from '../../kernel/types.js';

const contract = { checks: [{ spec: { type: 'command' as const, cmd: 'npm', args: ['test'] }, required: true }] };
const agents = [{ name: 'a' }, { name: 'b' }];

describe('council workflow', () => {
  it('is a single council node', () => {
    const spec = councilWorkflow({ task: 't', agents, cwd: '/tmp' });
    expect(spec.nodes).toHaveLength(1);
    expect(spec.nodes[0]).toMatchObject({ kind: 'council', task: 't' });
  });

  it('gets an implicit terminal verifier once a contract is declared', () => {
    const prepared = prepareSpec(councilWorkflow({ task: 't', agents, contract }));
    expect(prepared.nodes.map((n) => n.id)).toEqual(['council', IMPLICIT_VERIFIER_ID]);
  });

  it('has no verifier at all without a contract, so the run stays unverified', () => {
    const prepared = prepareSpec(councilWorkflow({ task: 't', agents }));
    expect(prepared.nodes.some((n) => n.kind === 'verifier')).toBe(false);
  });
});

describe('fanout workflow', () => {
  it('carries the agents and the synthesis flag', () => {
    const spec = fanoutWorkflow({ task: 't', agents, synthesize: true, cwd: '/tmp' });
    expect(spec.nodes[0]).toMatchObject({ kind: 'fanout', synthesize: true });
  });
});

describe('solve workflow', () => {
  const build = (over = {}) => solveWorkflow({ task: 'fix the bug', scouts: agents, cwd: '/tmp', ...over });

  it('goes triage → implement → verify → repair gate', () => {
    expect(build().nodes.map((n) => n.id)).toEqual(['triage', 'implement', 'verify', 'repair-gate', 'repair-budget']);
  });

  it('inserts a human gate before anything is written when asked', () => {
    const ids = build({ humanGate: true }).nodes.map((n) => n.id);
    expect(ids.indexOf('approve')).toBeGreaterThan(ids.indexOf('triage'));
    expect(ids.indexOf('approve')).toBeLessThan(ids.indexOf('implement'));
  });

  it('appends reviewers after the verifier, not before it', () => {
    const ids = build({ reviewers: [{ name: 'r' }] }).nodes.map((n) => n.id);
    expect(ids.indexOf('review')).toBeGreaterThan(ids.indexOf('verify'));
  });

  it('loops back to implement only while the verifier is red and budget remains', () => {
    const spec = build({ maxRepairs: 2 });
    const gate = spec.nodes.find((n) => n.id === 'repair-gate') as RouterNode;
    const budget = spec.nodes.find((n) => n.id === 'repair-budget') as RouterNode;
    expect(gate.routes[0]).toMatchObject({ when: { type: 'node_failed', node: 'verify' }, to: 'repair-budget' });
    expect(budget.routes[0]).toMatchObject({ when: { type: 'visits_lt', node: 'implement', n: 3 }, to: 'implement' });
  });

  it('does not run the contract twice — one verifier, not a final duplicate', () => {
    const verifiers = build({ contract }).nodes.filter((n) => n.kind === 'verifier');
    expect(verifiers).toHaveLength(1);
    expect((verifiers[0] as VerifierNode).contract).toBe('run');
  });

  it('lets a failed implementation reach the verifier so the evidence says what broke', () => {
    const implement = build().nodes.find((n) => n.id === 'implement')!;
    expect(implement.onFailure).toBe('continue');
  });

  it('bounds the loop above the router budget, as a backstop not the mechanism', () => {
    expect(build({ maxRepairs: 3 }).maxNodeVisits).toBe(6);
  });

  it('does not add a second verifier when a contract is declared', () => {
    const prepared = prepareSpec(build({ contract }));
    expect(prepared.nodes.filter((n) => n.kind === 'verifier')).toHaveLength(1);
  });
});
