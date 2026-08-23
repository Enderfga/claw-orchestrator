/**
 * `subflow` node — run another workflow as a step and adopt its verdict.
 *
 * The child gets its own run directory and its own evidence, so a composed
 * workflow is still auditable one level down. Named workflows resolve through an
 * injected resolver rather than a global registry, which keeps the kernel free of
 * a module-level mutable table.
 */

import type { NodeContext, NodeResult } from '../engine.js';
import type { RunKernel } from '../engine.js';
import type { NodeSpec, SubflowNode, WorkflowSpec } from '../types.js';

export type WorkflowResolver = (name: string) => WorkflowSpec | undefined;

export function makeSubflowExecutor(kernel: RunKernel, resolve?: WorkflowResolver) {
  return async function executeSubflowNode(node: NodeSpec, ctx: NodeContext): Promise<NodeResult> {
    const spec = node as SubflowNode;
    const child = typeof spec.workflow === 'string' ? resolve?.(spec.workflow) : spec.workflow;
    if (!child) {
      return { ok: false, error: `unknown workflow '${String(spec.workflow)}'` };
    }

    const record = await kernel.start(child, { cwd: ctx.cwd });
    ctx.emit({
      ts: new Date().toISOString(),
      type: 'log',
      level: 'info',
      message: `[subflow] ${spec.id} → run ${record.runId}`,
    });

    const finished = (await kernel.wait(record.runId)) ?? record;
    return {
      childRunId: record.runId,
      ok: finished.state === 'completed',
      output: `subflow ${finished.runId}: ${finished.state} / ${finished.outcome}`,
      error: finished.state === 'completed' ? undefined : (finished.error ?? `subflow ended ${finished.state}`),
      evidenceId: finished.evidenceId,
      passed: finished.outcome === 'verified',
      costUsd: finished.costUsd,
    };
  };
}
