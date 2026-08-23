/** `agent` node — one session, one turn, through the shared agent step. */

import type { NodeContext, NodeResult } from '../engine.js';
import { runAgentStep } from '../agent-step.js';
import type { AgentNode, NodeSpec } from '../types.js';

export async function executeAgentNode(node: NodeSpec, ctx: NodeContext): Promise<NodeResult> {
  const spec = node as AgentNode;
  if (!ctx.manager) return { ok: false, error: 'agent node requires a session manager' };

  // Steering text is prepended, not appended: an instruction that arrives while
  // the previous node ran is a correction, and corrections belong before the task.
  const steer = ctx.takeSteer();
  const prompt = steer.length > 0 ? `${steer.join('\n\n')}\n\n---\n\n${spec.prompt}` : spec.prompt;

  const result = await runAgentStep({
    manager: ctx.manager,
    // Attempt-scoped unless the author pinned a name deliberately: an abandoned
    // attempt is still alive and will tear down whatever session it named.
    sessionName: spec.sessionName || `${ctx.runId}-${spec.id}-a${ctx.attempt}`,
    prompt,
    parentRunId: ctx.runId,
    timeoutMs: spec.timeoutMs,
    logger: ctx.logger,
    config: {
      cwd: spec.cwd || ctx.cwd,
      engine: spec.engine,
      model: spec.model,
      effort: spec.effort as never,
      permissionMode: (spec.permissionMode as never) ?? 'bypassPermissions',
    },
  });

  return {
    ok: result.ok,
    output: result.output,
    error: result.error,
    costUsd: result.costUsd,
  };
}
