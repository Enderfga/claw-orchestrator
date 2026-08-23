/** `human_gate` node — park the run until a person answers. */

import type { NodeContext, NodeResult } from '../engine.js';
import type { HumanGateNode, NodeSpec } from '../types.js';

export async function executeHumanGateNode(node: NodeSpec, ctx: NodeContext): Promise<NodeResult> {
  const spec = node as HumanGateNode;
  ctx.emit({ ts: new Date().toISOString(), type: 'log', level: 'info', message: `[gate] ${spec.prompt}` });
  return { ok: true, awaitHuman: true, output: spec.prompt };
}
