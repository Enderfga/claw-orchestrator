/**
 * `verifier` node — the runtime checks the work itself.
 *
 * This is the node that makes `completed` mean something. It resolves a contract
 * (inline, or the workflow-level one), runs every check, writes an evidence
 * bundle, and reports pass/fail. Its verdict — not an agent's vote, not a regex
 * over prose — is what the kernel turns into `RunOutcome`.
 *
 * The optional fix-on-red loop spawns a repair session and re-runs the checks.
 * The fixer's own claim to have fixed it is ignored: only the re-run counts.
 */

import type { NodeContext, NodeResult } from '../engine.js';
import { runAgentStep } from '../agent-step.js';
import { runDir } from '../store.js';
import type { NodeSpec, VerifierNode } from '../types.js';
import { evidenceDir, makeEvidenceId, writeEvidence } from '../../verify/evidence.js';
import { runContract, type FixerSpawner } from '../../verify/runner.js';

function makeFixer(ctx: NodeContext, nodeId: string): FixerSpawner | undefined {
  if (!ctx.manager) return undefined;
  return async ({ cwd, failingCheck, tail, round }) => {
    await runAgentStep({
      manager: ctx.manager!,
      sessionName: `${ctx.runId}-${nodeId}-fix-${round}`,
      parentRunId: ctx.runId,
      logger: ctx.logger,
      config: { cwd, permissionMode: 'bypassPermissions' },
      prompt:
        `An acceptance check is failing in this working tree. Fix the underlying cause.\n\n` +
        `Failing check: ${failingCheck}\n\n` +
        `Output tail:\n${tail}\n\n` +
        `Make the minimum change that makes it pass. Do not modify or delete the check itself.`,
    });
  };
}

export async function executeVerifierNode(node: NodeSpec, ctx: NodeContext): Promise<NodeResult> {
  const spec = node as VerifierNode;
  const contract = spec.contract === 'run' ? ctx.runContract : spec.contract;

  if (!contract || contract.checks.length === 0) {
    // Nothing declared. Pass through without claiming verification — the run
    // stays `unverified`, which is the honest answer.
    return { ok: true, output: 'no acceptance contract declared — nothing verified' };
  }

  const attempt = ctx.record.nodes[spec.id]?.attempts ?? 1;
  const evidenceId = makeEvidenceId(spec.id, attempt);
  const dir = runDir(ctx.runId);
  const cwd = spec.cwd || ctx.cwd;

  const { results, passed, rounds } = await runContract(
    contract,
    {
      cwd,
      artifactDir: evidenceDir(dir, evidenceId),
      baseSha: ctx.record.baseSha,
      logger: ctx.logger,
      signal: ctx.signal,
    },
    makeFixer(ctx, spec.id),
  );

  const bundle = await writeEvidence({
    runDir: dir,
    runId: ctx.runId,
    node: spec.id,
    evidenceId,
    cwd,
    baseSha: ctx.record.baseSha,
    contractId: contract.id,
    results,
    rounds,
    logger: ctx.logger,
  });

  const failed = results.filter((r) => r.required && !r.passed);
  return {
    ok: passed,
    passed,
    evidenceId: bundle.evidenceId,
    treeFingerprint: bundle.treeFingerprint,
    // How many fix-on-red rounds it took, checkpointed with the node so a
    // caller can report it without re-reading the evidence bundle.
    data: { rounds, checks: results.length },
    output: results.map((r) => `[${r.passed ? 'PASS' : r.required ? 'FAIL' : 'warn'}] ${r.id}: ${r.detail}`).join('\n'),
    error: passed ? undefined : `acceptance contract failed: ${failed.map((r) => r.detail).join('; ')}`,
  };
}
