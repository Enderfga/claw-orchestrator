/** `router` node — pick the next node from declarative conditions. First match wins. */

import type { NodeContext, NodeResult } from '../engine.js';
import { evaluateCondition } from '../conditions.js';
import type { NodeSpec, RouterNode } from '../types.js';

export async function executeRouterNode(node: NodeSpec, ctx: NodeContext): Promise<NodeResult> {
  const spec = node as RouterNode;
  for (const route of spec.routes) {
    if (evaluateCondition(ctx.record, route.when)) {
      return { ok: true, goto: route.to, output: `→ ${route.to} (${route.when.type})` };
    }
  }
  return { ok: true, goto: spec.default, output: spec.default ? `→ ${spec.default} (default)` : '→ fall through' };
}
