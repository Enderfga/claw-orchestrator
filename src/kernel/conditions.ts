/**
 * Router condition evaluation — pure, and deliberately not an expression language.
 *
 * A workflow spec can arrive from a tool call, which means it can arrive from an
 * agent. If routing accepted a JS expression the kernel would be an arbitrary
 * code execution surface. These five closed forms cover the branching the six
 * built-in modes actually do (retry-on-red, loop-while-under-N, skip-if-verified)
 * and nothing else is evaluated.
 */

import type { RouterCondition, RunRecord } from './types.js';

/**
 * Nesting bound. `and` is the one recursive form here, and a spec can arrive
 * from a tool call — so the recursion is capped rather than trusted. Six is far
 * past anything the built-in templates express.
 */
const MAX_CONDITION_DEPTH = 6;

export function evaluateCondition(record: RunRecord, cond: RouterCondition, depth = 0): boolean {
  if (depth > MAX_CONDITION_DEPTH) return false;
  switch (cond.type) {
    case 'always':
      return true;
    case 'node_failed':
      return record.nodes[cond.node]?.state === 'failed';
    case 'node_succeeded':
      return record.nodes[cond.node]?.state === 'succeeded';
    case 'verified':
      return Boolean(record.nodes[cond.node]?.evidenceId) && record.outcome === 'verified';
    case 'visits_lt':
      return (record.nodes[cond.node]?.visits ?? 0) < cond.n;
    case 'and':
      // Empty `all` is false, not true: a route that names no condition is a
      // spec mistake, and vacuous truth here means an unconditional loop.
      return cond.all.length > 0 && cond.all.every((c) => evaluateCondition(record, c, depth + 1));
  }
}
