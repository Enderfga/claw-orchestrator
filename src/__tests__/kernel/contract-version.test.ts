/**
 * Which acceptance rules a verdict was reached under.
 *
 * A run's contract is fixed when it starts and is what a resume re-checks with;
 * these pin that the rules are named by a fingerprint of their content (not by
 * the contract's `id`, which a maintainer can keep while changing what it
 * checks), that the fingerprint reaches the run record, the verdict and every
 * evidence bundle, that a resume declaring different rules is recorded as drift
 * and still verifies with the rules the run started with, that a run's
 * execution and its verification are reported apart, and that a record from
 * before fingerprints says `unknown` rather than inventing one.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RunKernel } from '../../kernel/engine.js';
import { registerDefaultExecutors } from '../../kernel/nodes/index.js';
import { acquireLease, commit, loadRun, releaseLease, runDir } from '../../kernel/store.js';
import { runReport } from '../../kernel/projections.js';
import { compareContracts, contractFingerprint, normalizeContract } from '../../verify/contract.js';
import { readEvidence } from '../../verify/evidence.js';
import type { WorkflowSpec } from '../../kernel/types.js';

let tmp: string;
const saved = process.env.CLAWO_WF_DIR;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clawo-contract-version-'));
  process.env.CLAWO_WF_DIR = path.join(tmp, 'wf');
});

afterEach(() => {
  if (saved === undefined) delete process.env.CLAWO_WF_DIR;
  else process.env.CLAWO_WF_DIR = saved;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const c = (raw: unknown) => normalizeContract(raw)!;
const PASS = { checks: [{ id: 'ok', spec: { type: 'command', cmd: 'true' }, required: true }] };
const PASS_AND_FAIL = {
  checks: [
    { id: 'ok', spec: { type: 'command', cmd: 'true' }, required: true },
    { id: 'strict', spec: { type: 'command', cmd: 'false' }, required: true },
  ],
};

describe('the fingerprint of a contract', () => {
  it('names the rules, not how they were written', () => {
    const a = contractFingerprint(c({ id: 'v1', checks: [{ spec: { type: 'command', cmd: 'npm', args: ['test'] } }] }));
    // Same rules: bare checks instead of { spec }, another id, the default required spelled out, a repair budget.
    const b = contractFingerprint(
      c({ id: 'v2', fixOnFailureRounds: 2, checks: [{ args: ['test'], cmd: 'npm', type: 'command', required: true }] }),
    );
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(b).toBe(a);
    // Different rules under the same id.
    expect(
      contractFingerprint(c({ id: 'v1', checks: [{ type: 'command', cmd: 'npm', args: ['run', 'test'] }] })),
    ).not.toBe(a);
    expect(
      contractFingerprint(c({ id: 'v1', checks: [{ type: 'command', cmd: 'npm', args: ['test'], required: false }] })),
    ).not.toBe(a);
    expect(
      contractFingerprint(
        c({ id: 'v1', protectTests: false, checks: [{ type: 'command', cmd: 'npm', args: ['test'] }] }),
      ),
    ).not.toBe(a);
  });

  it('says how two versions relate: the same, checks only added, checks only removed, or changed', () => {
    expect(compareContracts(c(PASS), c({ ...PASS, id: 'renamed' }))).toBe('same');
    expect(compareContracts(c(PASS), c(PASS_AND_FAIL))).toBe('adds-checks');
    expect(compareContracts(c(PASS_AND_FAIL), c(PASS))).toBe('removes-checks');
    expect(compareContracts(c(PASS), c({ checks: [{ type: 'command', cmd: 'false' }] }))).toBe('changed');
    // Relaxing a check to optional is a change, not an addition.
    expect(
      compareContracts(
        c(PASS_AND_FAIL),
        c({ checks: [...PASS.checks, { ...PASS_AND_FAIL.checks[1], required: false }] }),
      ),
    ).toBe('changed');
    expect(compareContracts(c(PASS), c({ ...PASS, protectTests: false }))).toBe('changed');
  });
});

/** A kernel whose agent nodes succeed at once, and whose verifiers are real. */
function kernelWith(agent: () => Promise<{ ok: boolean; error?: string }> = async () => ({ ok: true })) {
  const kernel = registerDefaultExecutors(new RunKernel({ nodeTimeoutMs: 20_000 }));
  kernel.setExecutor('agent', agent as never);
  return kernel;
}

const spec = (contract: unknown, extra: Partial<WorkflowSpec> = {}): WorkflowSpec => ({
  name: 'versioned',
  cwd: tmp,
  contract: contract as never,
  nodes: [{ id: 'work', kind: 'agent', prompt: 'do it' }],
  ...extra,
});

/** Rewind a finished run to the moment its agent node was running, as a killed process leaves it. */
function crashedInWork(runId: string, edit: (r: ReturnType<typeof loadRun> & object) => void = () => undefined) {
  const record = loadRun(runId)!;
  record.state = 'running';
  record.endedAt = undefined;
  record.outcome = 'unverified';
  record.verdict = undefined;
  record.evidenceId = undefined;
  record.execution = undefined;
  for (const n of Object.values(record.nodes)) {
    n.state = 'pending';
    n.evidenceId = undefined;
  }
  record.nodes.work.state = 'running';
  record.currentNode = 'work';
  edit(record);
  const crashed = acquireLease(runId, 'crashed-process');
  commit(crashed, { record });
  releaseLease(crashed);
}

describe('a run and its rules', () => {
  it('records the fingerprint of the run contract and of a node contract, on the record, the verdict and the evidence', async () => {
    const kernel = kernelWith();
    const run = await kernel.start(
      spec(PASS, {
        nodes: [
          { id: 'work', kind: 'agent', prompt: 'do it' },
          { id: 'lint', kind: 'verifier', contract: { checks: [{ type: 'command', cmd: 'true' }] } as never },
        ],
      }),
    );
    const done = (await kernel.wait(run.runId))!;
    expect(done.outcome).toBe('verified');
    const runHash = contractFingerprint(c(PASS));
    expect(done.contractHashes?.run).toBe(runHash);
    expect(done.contractHashes?.nodes?.lint).toBe(
      contractFingerprint(c({ checks: [{ type: 'command', cmd: 'true' }] })),
    );
    expect(done.verdict?.contractHash).toBe(runHash);
    const bundle = readEvidence(runDir(run.runId), done.verdict!.evidenceId)!;
    expect(bundle.contractHash).toBe(runHash);
    const lintBundle = readEvidence(runDir(run.runId), done.nodes.lint.evidenceId!)!;
    expect(lintBundle.contractHash).toBe(done.contractHashes?.nodes?.lint);
  });

  it('re-checks a resumed run with the rules it started with, and records a declared change as drift', async () => {
    const kernel = kernelWith();
    const run = await kernel.start(spec(PASS));
    await kernel.wait(run.runId);
    crashedInWork(run.runId);

    // The maintainer has since added a check that this tree fails.
    const kernel2 = kernelWith();
    await kernel2.resume(run.runId, { contract: PASS_AND_FAIL });
    const done = (await kernel2.wait(run.runId))!;

    // Verified under the rules the run started with; the new version was not swapped in.
    expect(done.state).toBe('completed');
    expect(done.outcome).toBe('verified');
    expect(done.verdict?.contractHash).toBe(contractFingerprint(c(PASS)));
    expect(readEvidence(runDir(run.runId), done.verdict!.evidenceId)!.contractHash).toBe(contractFingerprint(c(PASS)));
    // …and the change is on the record, with how the two versions relate.
    const last = done.resumes!.at(-1)!;
    expect(last.interruptedNodes).toEqual(['work']);
    expect(last.contractDrift).toEqual({
      checkpoint: contractFingerprint(c(PASS)),
      declared: contractFingerprint(c(PASS_AND_FAIL)),
      relation: 'adds-checks',
    });
    const report = runReport(done);
    expect(report.verification.contractDrift?.relation).toBe('adds-checks');
    expect(report.resume.count).toBe(1);
  });

  it('records no drift when the declared rules are the same rules written differently', async () => {
    const kernel = kernelWith();
    const run = await kernel.start(spec(PASS));
    await kernel.wait(run.runId);
    crashedInWork(run.runId);
    const kernel2 = kernelWith();
    await kernel2.resume(run.runId, { contract: { id: 'other-name', checks: [{ cmd: 'true', type: 'command' }] } });
    const done = (await kernel2.wait(run.runId))!;
    expect(done.resumes!.at(-1)!.contractDrift).toBeUndefined();
    expect(done.resumes!.at(-1)!.declaredContract).toBe(contractFingerprint(c(PASS)));
  });

  it('refuses a declared contract it cannot parse, as a start would', async () => {
    const kernel = kernelWith();
    const run = await kernel.start(spec(PASS));
    await kernel.wait(run.runId);
    crashedInWork(run.runId);
    await expect(kernelWith().resume(run.runId, { contract: { checks: [{ type: 'nonsense' }] } })).rejects.toThrow(
      /refused/,
    );
  });

  it('reports execution and verification apart', async () => {
    const refuted = kernelWith();
    const r1 = await refuted.start(spec(PASS_AND_FAIL));
    const d1 = (await refuted.wait(r1.runId))!;
    expect(d1.state).toBe('failed');
    expect(d1.execution).toBe('completed');
    expect(d1.outcome).toBe('refuted');
    expect(runReport(d1)).toMatchObject({ execution: 'completed', verification: { outcome: 'refuted' } });

    const broken = kernelWith(async () => ({ ok: false, error: 'boom' }));
    const r2 = await broken.start(spec(PASS));
    const d2 = (await broken.wait(r2.runId))!;
    expect(d2.execution).toBe('failed');
    expect(d2.outcome).toBe('unverified');
  });

  it('says unknown for a record and evidence written before fingerprints, rather than computing one', async () => {
    const kernel = kernelWith();
    const run = await kernel.start(spec(PASS));
    const done = (await kernel.wait(run.runId))!;
    const old = { ...done, contractHashes: undefined, verdict: { ...done.verdict!, contractHash: undefined } };
    const report = runReport(old);
    expect(report.verification.contractHash).toBe('unknown');
    expect(report.verification.runContractHash).toBe('unknown');
    // A run with no contract has no rules to name.
    const bare = (await kernel.wait((await kernel.start(spec(undefined))).runId))!;
    expect(runReport(bare).verification.runContractHash).toBeUndefined();
  });
});
