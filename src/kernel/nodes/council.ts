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

  const { Council } = await import('../../council.js');
  const council = new Council(
    {
      agents: spec.agents.map((a) => ({
        name: a.name,
        emoji: '',
        persona: a.persona ?? '',
        engine: a.engine,
        model: a.model,
      })),
      maxRounds: spec.maxRounds ?? 8,
      projectDir: spec.projectDir || ctx.cwd,
      agentTimeoutMs: spec.timeoutMs,
    },
    ctx.manager,
    ctx.logger,
  );

  if (ctx.signal.aborted) return { ok: false, error: 'cancelled' };
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
  };
}
