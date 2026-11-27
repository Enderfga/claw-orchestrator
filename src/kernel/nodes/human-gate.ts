/** `human_gate` node — park the run until a person answers. */

import type { NodeContext, NodeResult } from '../engine.js';
import type { HumanGateNode, NodeSpec } from '../types.js';
import { forumAuthority, forumPosts, openAsksOf, type ForumPost } from '../forum.js';

/**
 * The orchestrator's latest ASK for gate `gateId` of run `runId` on forum
 * `forumId`, when the ledger vouches for it: a line an agent wrote into the
 * spool under `orchestrator` is not the gate's question.
 */
export function gateAsk(forumId: string, runId: string, gateId: string): ForumPost | undefined {
  let asks: ForumPost[];
  try {
    asks = forumPosts(forumId, { from: 'orchestrator', tags: ['ASK'] });
  } catch {
    return undefined;
  }
  for (let i = asks.length - 1; i >= 0; i--) {
    const p = asks[i];
    if (p.data?.gate === gateId && p.data?.runId === runId && forumAuthority(forumId, p) === 'orchestrator') return p;
  }
  return undefined;
}

/**
 * Asks the user on the run's forum, as the orchestrator's `ASK @user`, and
 * parks. The answer comes only through `workflow_approve`, never from a post. A
 * gate run again with its question still unanswered (a resume) does not ask
 * twice.
 */
export async function executeHumanGateNode(node: NodeSpec, ctx: NodeContext): Promise<NodeResult> {
  const spec = node as HumanGateNode;
  ctx.emit({ ts: new Date().toISOString(), type: 'log', level: 'info', message: `[gate] ${spec.prompt}` });
  const asked = gateAsk(ctx.forum.id, ctx.runId, spec.id);
  let open = false;
  try {
    open = !!asked && openAsksOf(ctx.forum.id).some((p) => p.id === asked.id);
  } catch {
    open = false;
  }
  if (!open) {
    const line =
      spec.prompt
        .split('\n')
        .map((l) => l.replace(/\s+/g, ' ').trim())
        .find((l) => l) ?? 'approve?';
    await ctx.forumPost({
      from: 'orchestrator',
      title: `ASK @user: ${line}`,
      body: spec.prompt,
      to: ['user'],
      // The prompt is the workflow author's; an @name in it addresses nobody.
      mentions: false,
      data: { gate: spec.id, runId: ctx.runId },
    });
  }
  return { ok: true, awaitHuman: true, output: spec.prompt };
}
