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
import { resolveForum, subflowForumPrefix, type ForumBinding } from '../forum.js';

export type WorkflowResolver = (name: string) => WorkflowSpec | undefined;

/** What a binding's prefix may be: a forum name ending in a dot. */
const PREFIX_RE = /^[A-Za-z0-9][\w.-]{0,62}\.$/;

/**
 * The binding a subflow's child run takes on its parent's forum, when the
 * parent's agents are on one: each of the child's members is named
 * `<subflowId>.<name>` (after the parent's own prefix, for a parent that is
 * itself a child), as the parent's roster lists them.
 */
function childBinding(ctx: NodeContext, nodeId: string): ForumBinding | undefined {
  const forum = resolveForum(ctx.record);
  if (!forum) return undefined;
  if (forum.agent) return { runId: forum.runId, agent: forum.agent };
  const prefix = `${forum.prefix ?? ''}${subflowForumPrefix(nodeId)}`;
  // A prefix the forum cannot carry (too long, nested too deep) leaves the child off it rather than failing the node.
  return PREFIX_RE.test(prefix) ? { runId: forum.runId, agent: '', prefix } : undefined;
}

export function makeSubflowExecutor(kernel: RunKernel, resolve?: WorkflowResolver) {
  // The forum's roster lists a named subflow's members through the same resolver.
  kernel.setSubflowResolver(resolve);
  return async function executeSubflowNode(node: NodeSpec, ctx: NodeContext): Promise<NodeResult> {
    const spec = node as SubflowNode;
    const child = typeof spec.workflow === 'string' ? resolve?.(spec.workflow) : spec.workflow;
    if (!child) {
      return { ok: false, error: `unknown workflow '${String(spec.workflow)}'` };
    }

    // Secrets travel with the child. They are the custom-engine configs the
    // spec deliberately cannot carry, so a child that does not get them starts
    // its agents on a different engine than the parent was told to use — and
    // `kernel/nodes/council.ts` reads them straight out of `ctx.secrets`.
    const forum = childBinding(ctx, spec.id);
    const record = await kernel.start(child, {
      cwd: ctx.cwd,
      secrets: ctx.secrets,
      // The child works in the parent's tree; the tests as the parent found them are the reference.
      baseTests: ctx.record.baseTests,
      // On a parent whose agents share a forum, the child's agents are on it too.
      ...(forum ? { forum } : {}),
    });
    // Recorded now, not with the result: a parent cancelled while the child is
    // still running has to be able to find it.
    ctx.setChild(record.runId);
    // `kernel.start` awaits internally, and `cancel(parent)` walks the parent's
    // nodes looking for a `childRunId` that does not exist until the line
    // above. A cancel that landed in that window returned true having stopped
    // nothing, and this child then ran to completion — spending budget and
    // writing to the shared cwd after the parent was cancelled. The flag is
    // already set by then, so re-check it here rather than widen the window.
    if (ctx.signal.aborted) {
      kernel.cancel(record.runId);
      return {
        childRunId: record.runId,
        ok: false,
        error: 'cancelled',
      };
    }
    ctx.emit({
      ts: new Date().toISOString(),
      type: 'log',
      level: 'info',
      message: `[subflow] ${spec.id} → run ${record.runId}`,
    });

    const finished = (await kernel.wait(record.runId)) ?? record;
    // Only a verdict that stands is adopted. A child that ended `unverified`
    // has none — its checks may have passed on a tree that moved since — and
    // reporting its evidence as not passed would make the parent `refuted`.
    const judged = finished.outcome !== 'unverified';
    return {
      childRunId: record.runId,
      ok: finished.state === 'completed',
      output: `subflow ${finished.runId}: ${finished.state} / ${finished.outcome}`,
      error: finished.state === 'completed' ? undefined : (finished.error ?? `subflow ended ${finished.state}`),
      evidenceId: judged ? finished.evidenceId : undefined,
      passed: finished.outcome === 'verified',
      // The digest goes with the verdict: without it, any workspace-touching node
      // the parent runs afterwards finds nothing to compare and downgrades it.
      treeFingerprint: finished.verdict?.treeFingerprint,
      fingerprintCwd: finished.verdict?.fingerprintCwd ?? finished.cwd,
      costUsd: finished.costUsd,
    };
  };
}
