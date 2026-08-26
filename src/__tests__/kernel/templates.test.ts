/**
 * Built-in workflows. These are ordinary specs, so the tests read them the way
 * the kernel does rather than trusting the builder's intent.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { councilWorkflow, fanoutWorkflow, solveWorkflow } from '../../kernel/templates/index.js';
import { prepareSpec, IMPLICIT_VERIFIER_ID, RunKernel } from '../../kernel/engine.js';
import { executeRouterNode } from '../../kernel/nodes/router.js';
import { executeVerifierNode } from '../../kernel/nodes/verifier.js';
import { evidenceRoot } from '../../verify/evidence.js';
import { runDir } from '../../kernel/store.js';
import type { RouterNode, VerifierNode } from '../../kernel/types.js';

let tmp: string;
const savedWfDir = process.env.CLAWO_WF_DIR;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clawo-templates-'));
  process.env.CLAWO_WF_DIR = tmp;
});

afterEach(() => {
  if (savedWfDir === undefined) delete process.env.CLAWO_WF_DIR;
  else process.env.CLAWO_WF_DIR = savedWfDir;
  fs.rmSync(tmp, { recursive: true, force: true });
});

/**
 * Run a solve spec with stub node executors and the REAL router, reporting how
 * many times each node ran. Reading the routes off the spec cannot answer what
 * the loop does — the two-router version's routes each looked right on their
 * own — so these assertions run the kernel.
 */
async function runSolve(over: Record<string, unknown>, verifierPasses: boolean) {
  const ran: string[] = [];
  const kernel = new RunKernel({ nodeTimeoutMs: 5000 });
  kernel.setExecutor('agent', async (node) => {
    ran.push(node.id);
    return { ok: true, output: 'ok' };
  });
  kernel.setExecutor('fanout', async (node) => {
    ran.push(node.id);
    return { ok: true, output: 'ok' };
  });
  kernel.setExecutor('router', executeRouterNode);
  kernel.setExecutor('verifier', async (node) => {
    ran.push(node.id);
    return verifierPasses ? { ok: true, output: 'green' } : { ok: false, error: 'red' };
  });
  const spec = solveWorkflow({ task: 't', scouts: [{ name: 'a' }], cwd: tmp, ...over });
  const started = await kernel.start(spec);
  const done = await kernel.wait(started.runId);
  const count = (id: string) => ran.filter((x) => x === id).length;
  return { ran, count, done: done! };
}

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
    expect(build().nodes.map((n) => n.id)).toEqual(['triage', 'implement', 'verify', 'repair-gate']);
  });

  it('inserts a human gate before anything is written when asked', () => {
    const ids = build({ humanGate: true }).nodes.map((n) => n.id);
    expect(ids.indexOf('approve')).toBeGreaterThan(ids.indexOf('triage'));
    expect(ids.indexOf('approve')).toBeLessThan(ids.indexOf('implement'));
  });

  it('puts reviewers BEFORE the gate, so nothing side-effecting follows the evidence', () => {
    // The reverse order shipped first and was wrong: a reviewer fan-out shares
    // the project directory, so it could edit the tree the verifier had already
    // signed off while the run still reported `verified`.
    const spec = build({ reviewers: [{ name: 'r' }] });
    const ids = spec.nodes.map((n) => n.id);
    expect(ids.indexOf('review')).toBeGreaterThan(ids.indexOf('implement'));
    expect(ids.indexOf('review')).toBeLessThan(ids.indexOf('verify'));

    const afterGate = spec.nodes.slice(spec.nodes.findIndex((n) => n.kind === 'verifier') + 1);
    expect(afterGate.every((n) => n.kind === 'router')).toBe(true);
  });

  it('gates the loop on both conditions at once, not on two chained routers', () => {
    const spec = build({ maxRepairs: 2 });
    const gate = spec.nodes.find((n) => n.id === 'repair-gate') as RouterNode;
    expect(gate.routes[0]).toMatchObject({
      when: {
        type: 'and',
        all: [
          { type: 'node_failed', node: 'verify' },
          { type: 'visits_lt', node: 'implement', n: 3 },
        ],
      },
      to: 'implement',
    });
  });

  // ── What the loop actually does, run rather than read.
  //
  //    The two chained routers each read correctly on their own. Chaining is
  //    not AND: a router whose routes all miss falls through to the next node,
  //    so a green verify skipped the red-check and landed in the budget check,
  //    which matched. Measured on the built spec: four implement passes on a
  //    run that succeeded the first time.
  it('does not repair a run that was green the first time', async () => {
    const { count, done } = await runSolve({ maxRepairs: 3 }, true);
    expect(count('implement')).toBe(1);
    expect(count('verify')).toBe(1);
    expect(done.state).toBe('completed');
  });

  it('still repairs a red run, up to the budget', async () => {
    // The other half: a fix that stopped looping altogether would pass the test
    // above and break the feature.
    const { count, done } = await runSolve({ maxRepairs: 2 }, false);
    expect(count('implement')).toBe(3); // first pass + 2 repairs
    expect(count('verify')).toBe(3);
    // `verify` carries onFailure: 'continue' so the run still finishes; what
    // must not happen is that it finishes claiming to be verified.
    expect(done.nodes.verify.state).toBe('failed');
    expect(done.outcome).not.toBe('verified');
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

// ── Every pass through the verifier keeps its own evidence.
//
//    `attempts` is the per-visit retry counter and restarts at 1 on each fresh
//    visit, so keying the bundle on it alone named the same directory on every
//    pass through the repair loop: visit 2's bundle.json and diff.patch
//    overwrote visit 1's, the record's evidenceId collapsed onto one string,
//    and two `evidence` events pointed at one bundle. The verdict stayed
//    correct; the record of what was red and what fixed it did not survive.
describe('solve workflow — evidence across repair passes', () => {
  it('writes a separate bundle for each visit to the verifier', async () => {
    const marker = path.join(tmp, 'green');
    const kernel = new RunKernel({ nodeTimeoutMs: 20_000 });
    kernel.setExecutor('agent', async () => {
      // First implement pass leaves the check red; the repair pass fixes it.
      if (fs.existsSync(marker)) return { ok: true, output: 'repaired' };
      fs.writeFileSync(marker, 'x');
      return { ok: true, output: 'first pass' };
    });
    kernel.setExecutor('fanout', async () => ({ ok: true, output: 'ok' }));
    kernel.setExecutor('router', executeRouterNode);
    kernel.setExecutor('verifier', executeVerifierNode);

    const spec = solveWorkflow({
      task: 't',
      scouts: [{ name: 'a' }],
      cwd: tmp,
      maxRepairs: 2,
      contract: {
        checks: [
          {
            spec: { type: 'command', cmd: 'sh', args: ['-c', `test -f ${JSON.stringify(marker)}.done || exit 1`] },
            required: true,
          },
        ],
      },
    });
    // The check goes green once the repair pass has run: the agent stub above
    // creates `<marker>` on its first pass and the second pass creates `.done`.
    kernel.setExecutor('agent', async () => {
      if (fs.existsSync(marker)) {
        fs.writeFileSync(`${marker}.done`, 'x');
        return { ok: true, output: 'repaired' };
      }
      fs.writeFileSync(marker, 'x');
      return { ok: true, output: 'first pass' };
    });

    const started = await kernel.start(spec);
    await kernel.wait(started.runId);

    const bundles = fs.readdirSync(evidenceRoot(runDir(started.runId))).sort();
    expect(bundles.length).toBeGreaterThan(1);
    expect(new Set(bundles).size).toBe(bundles.length);
    expect(bundles[0]).not.toBe(bundles[1]);
  });
});
