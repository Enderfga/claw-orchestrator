/**
 * `fanout` node — N agents in parallel, wrapping the existing Fanout engine.
 *
 * The kernel supplies durability, timeout and cancellation around it; `fanout.ts`
 * itself is unchanged. Note what this fixes for free: a fan-out's results used to
 * live only in a 30-minute in-memory map, so a restart (or a slow reader) lost
 * them entirely. Here the node output is checkpointed like any other.
 */

import type { NodeContext, NodeResult } from '../engine.js';
import type { FanoutNode, NodeSpec } from '../types.js';

export async function executeFanoutNode(node: NodeSpec, ctx: NodeContext): Promise<NodeResult> {
  const spec = node as FanoutNode;
  if (!ctx.manager) return { ok: false, error: 'fanout node requires a session manager' };

  // Every field, forwarded. The first cut mapped four of them and dropped the
  // rest, which is how an ultrareview's per-reviewer prompt and its
  // `permissionMode: 'plan'` stopped reaching the session — a read-only review
  // that ran under `bypassPermissions`.
  const customEngines = (ctx.secrets.agentCustomEngines ?? {}) as Record<string, unknown>;
  const { Fanout } = await import('../../fanout.js');
  const fanout = new Fanout(
    {
      task: spec.prompt,
      projectDir: spec.cwd || ctx.cwd,
      agents: spec.agents.map((a) => ({
        name: a.name,
        engine: a.engine,
        model: a.model,
        prompt: a.prompt ?? a.persona,
        baseUrl: a.baseUrl,
        permissionMode: a.permissionMode as never,
        // Credentials never travel in the spec; they arrive through the
        // in-memory side channel keyed by agent name.
        customEngine: customEngines[a.name] as never,
      })),
      synthesize: spec.synthesize,
      synthesisEngine: spec.synthesisEngine,
      synthesisModel: spec.synthesisModel,
      synthesisPermissionMode: spec.synthesisPermissionMode as never,
      maxTurnsPerAgent: spec.maxTurnsPerAgent,
      maxBudgetUsd: spec.maxBudgetUsd,
      agentTimeoutMs: spec.timeoutMs,
    },
    ctx.manager,
    ctx.logger,
  );

  if (ctx.signal.aborted) return { ok: false, error: 'cancelled' };
  ctx.setHandle(fanout);
  const session = await fanout.run();

  const failures = session.results.filter((r) => !r.ok);
  const body =
    session.synthesis ??
    session.results.map((r) => `## ${r.agent}${r.ok ? '' : ' (failed)'}\n\n${r.output || r.error || ''}`).join('\n\n');

  return {
    ok: session.status !== 'error' && failures.length < session.results.length,
    output: body,
    error: failures.length > 0 ? `${failures.length}/${session.results.length} agent(s) failed` : undefined,
    data: {
      task: session.task,
      agentCount: session.agentCount,
      results: session.results,
      synthesis: session.synthesis,
    },
  };
}
