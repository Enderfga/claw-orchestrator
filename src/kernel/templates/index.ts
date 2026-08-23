/**
 * Built-in workflows.
 *
 * These are ordinary `WorkflowSpec`s — the same thing a caller can hand to
 * `workflow_start` — so the built-ins are not privileged over anything a user
 * writes. Each is a builder rather than a constant because they all need the
 * caller's task, agents, and cwd.
 */

import type { AcceptanceContract } from '../../verify/contract.js';
import type { FanoutAgentSpec, WorkflowSpec } from '../types.js';

export interface CommonArgs {
  task: string;
  cwd?: string;
  contract?: AcceptanceContract;
}

export interface CouncilArgs extends CommonArgs {
  agents: FanoutAgentSpec[];
  maxRounds?: number;
}

/**
 * Council, with its verdict demoted.
 *
 * Structurally identical to what `council_start` did, except that reaching
 * consensus no longer ends the story: when a contract is supplied the kernel
 * appends a verifier and the run is judged on that. The votes are still
 * recorded on the run.
 */
export function councilWorkflow(args: CouncilArgs): WorkflowSpec {
  return {
    name: 'council',
    cwd: args.cwd,
    contract: args.contract,
    nodes: [
      {
        id: 'council',
        kind: 'council',
        task: args.task,
        agents: args.agents,
        projectDir: args.cwd,
        maxRounds: args.maxRounds,
      },
    ],
  };
}

export interface FanoutArgs extends CommonArgs {
  agents: FanoutAgentSpec[];
  synthesize?: boolean;
}

export function fanoutWorkflow(args: FanoutArgs): WorkflowSpec {
  return {
    name: 'fanout',
    cwd: args.cwd,
    contract: args.contract,
    nodes: [
      {
        id: 'fanout',
        kind: 'fanout',
        prompt: args.task,
        agents: args.agents,
        synthesize: args.synthesize,
        cwd: args.cwd,
      },
    ],
  };
}

export interface SolveArgs extends CommonArgs {
  /** Agents that explore the problem in parallel before anything is written. */
  scouts: FanoutAgentSpec[];
  /** Engine/model that does the implementation. */
  implementer?: { engine?: FanoutAgentSpec['engine']; model?: string };
  /** Reviewers that read the finished change. */
  reviewers?: FanoutAgentSpec[];
  /** Ask a human before writing anything. */
  humanGate?: boolean;
  /** How many repair attempts the router allows. Default 3. */
  maxRepairs?: number;
}

/**
 * The flagship: triage → (gate) → implement → verify → repair-until-green → review.
 *
 * The repair loop is the part that needs the kernel rather than a prompt: the
 * router sends control back to the implementer while the verifier is red and the
 * visit budget holds, and the run cannot leave in `completed` unless the last
 * verification passed.
 */
export function solveWorkflow(args: SolveArgs): WorkflowSpec {
  const maxRepairs = args.maxRepairs ?? 3;
  const nodes: WorkflowSpec['nodes'] = [
    {
      id: 'triage',
      kind: 'fanout',
      prompt: `Investigate this task and report what you found. Do not change any files yet.\n\n${args.task}`,
      agents: args.scouts,
      synthesize: args.scouts.length >= 2,
      cwd: args.cwd,
    },
  ];

  if (args.humanGate) {
    nodes.push({ id: 'approve', kind: 'human_gate', prompt: `Approve the plan for: ${args.task}` });
  }

  nodes.push({
    id: 'implement',
    kind: 'agent',
    prompt: args.task,
    engine: args.implementer?.engine,
    model: args.implementer?.model,
    cwd: args.cwd,
    // A failed implementation attempt still goes to the verifier, so the
    // evidence bundle records what was actually wrong rather than just "the
    // agent errored".
    onFailure: 'continue',
  });

  // Review sits BEFORE the gate, not after it.
  //
  // It used to come last, which put a fan-out that shares the project directory
  // downstream of the evidence: the reviewers could edit the tree the verifier
  // had already signed off, and the run still reported `verified`. "Reviewers
  // only read" was a sentence in a prompt, not something the runtime could
  // enforce. Ordering it before the gate makes the question moot — anything the
  // reviewers change is checked, and their findings feed the repair loop.
  if (args.reviewers?.length) {
    nodes.push({
      id: 'review',
      kind: 'fanout',
      prompt: `Review the change that was just made for this task. Report problems only.\n\n${args.task}`,
      agents: args.reviewers,
      synthesize: args.reviewers.length >= 2,
      cwd: args.cwd,
      onFailure: 'continue',
    });
  }

  nodes.push({ id: 'verify', kind: 'verifier', contract: 'run', cwd: args.cwd, onFailure: 'continue' });

  // Loop back only while the verifier is red AND there is repair budget left.
  // The `visits_lt` guard is what stops this becoming an infinite retry; the
  // kernel's visit bound is the backstop, not the mechanism.
  nodes.push({
    id: 'repair-gate',
    kind: 'router',
    routes: [
      {
        when: { type: 'node_failed', node: 'verify' },
        to: 'repair-budget',
      },
    ],
  });

  nodes.push({
    id: 'repair-budget',
    kind: 'router',
    routes: [{ when: { type: 'visits_lt', node: 'implement', n: maxRepairs + 1 }, to: 'implement' }],
    // Budget spent and still red: fall through, leaving the failed verdict to
    // decide the run.
  });

  // No second verifier at the end: the last `verify` visit already produced the
  // run's verdict, and re-running a contract that shells out to a test suite
  // would double the most expensive part of the run to learn nothing new.
  return {
    name: 'solve',
    cwd: args.cwd,
    contract: args.contract,
    // Each repair pass revisits implement / verify / the two routers once. The
    // router's own `visits_lt` guard is the real budget; this is the backstop.
    maxNodeVisits: maxRepairs + 3,
    nodes,
  };
}

export type TemplateName = 'council' | 'fanout' | 'solve';

export const TEMPLATE_NAMES: readonly TemplateName[] = ['council', 'fanout', 'solve'];
