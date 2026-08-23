/**
 * `council` node — wraps the existing Council engine.
 *
 * The behavioural change is what "done" means. Council used to terminate on
 * `[CONSENSUS: YES]` from every agent, i.e. on a regex over agent prose. Here the
 * votes are still collected and recorded — they are useful, and they are what the
 * agents were asked for — but they are advisory. Whether the run is acceptable is
 * decided downstream by a verifier node against a contract.
 */

import type { NodeContext, NodeResult } from '../engine.js';
import { parseConsensusWithSource } from '../../consensus.js';
import type { CouncilNode, NodeSpec } from '../types.js';
import type { ConsensusVote } from '../types.js';

export async function executeCouncilNode(node: NodeSpec, ctx: NodeContext): Promise<NodeResult> {
  const spec = node as CouncilNode;
  if (!ctx.manager) return { ok: false, error: 'council node requires a session manager' };

  // Same story as the fan-out node: forward every field. Dropping
  // `customEngine` here did not merely lose configuration — a council agent on a
  // custom engine could not start at all without it.
  const customEngines = (ctx.secrets.agentCustomEngines ?? {}) as Record<string, unknown>;
  const { Council } = await import('../../council.js');
  const council = new Council(
    {
      agents: spec.agents.map((a) => ({
        name: a.name,
        emoji: '',
        persona: a.persona ?? a.prompt ?? '',
        engine: a.engine,
        model: a.model,
        baseUrl: a.baseUrl,
        permissionMode: a.permissionMode as never,
        effort: a.effort as never,
        ultracode: a.ultracode,
        customEngine: customEngines[a.name] as never,
      })),
      maxRounds: spec.maxRounds ?? 8,
      projectDir: spec.projectDir || ctx.cwd,
      agentTimeoutMs: spec.timeoutMs,
      maxTurnsPerAgent: spec.maxTurnsPerAgent,
      maxBudgetUsd: spec.maxBudgetUsd,
      defaultPermissionMode: spec.defaultPermissionMode as never,
    },
    ctx.manager,
    ctx.logger,
  );

  if (ctx.signal.aborted) return { ok: false, error: 'cancelled' };
  // Published so `council_inject` / `council_abort` can reach the running
  // engine. Only meaningful while this process is running it.
  ctx.setHandle(council);
  council.on('council-event', () => {
    const live = council.getSession?.();
    if (live) {
      ctx.publish({
        task: live.task,
        responses: live.responses,
        councilStatus: live.status,
        finalSummary: live.finalSummary,
        compactContext: live.compactContext,
        agents: spec.agents,
        maxRounds: spec.maxRounds ?? 8,
        projectDir: spec.projectDir || ctx.cwd,
      });
    }
  });
  const session = await council.run(spec.task);

  const consensusVotes: ConsensusVote[] = session.responses.map((r) => {
    const { vote, source } = parseConsensusWithSource(r.content ?? '');
    return { agent: r.agent, round: r.round, vote, source };
  });

  // `error` is a real failure; every other terminal status means the council ran.
  // Reaching max rounds without agreement is a result, not a crash — and it is no
  // longer the thing that decides whether the work is acceptable.
  const ok = session.status !== 'error';

  return {
    ok,
    output:
      session.finalSummary ??
      session.responses.map((r) => `## ${r.agent} (round ${r.round})\n\n${r.content}`).join('\n\n'),
    error: ok ? undefined : 'council ended in error',
    consensusVotes,
    data: {
      task: session.task,
      responses: session.responses,
      councilStatus: session.status,
      finalSummary: session.finalSummary,
      compactContext: session.compactContext,
      agents: spec.agents,
      maxRounds: spec.maxRounds ?? 8,
      projectDir: spec.projectDir || ctx.cwd,
    },
  };
}
