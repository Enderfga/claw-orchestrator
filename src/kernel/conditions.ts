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

export function evaluateCondition(record: RunRecord, cond: RouterCondition): boolean {
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
  }
}
