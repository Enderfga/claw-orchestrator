/**
 * Built-in workflows.
 *
 * These are ordinary `WorkflowSpec`s — the same thing a caller can hand to
 * `workflow_start` — so the built-ins are not privileged over anything a user
 * writes. Each is a builder rather than a constant because they all need the
 * caller's task, agents, and cwd.
 */

import type { AcceptanceContract } from '../../verify/contract.js';
import type { CouncilNode, FanoutAgentSpec, FanoutNode, WorkflowSpec } from '../types.js';

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

// ─── Legacy mode workflows ──────────────────────────────────────────────────
//
// The `council_*`, `fanout_*`, `ultraplan_*` and `ultrareview_*` tools keep
// their signatures, but each now starts one of these instead of a mode-private
// state machine. Every one uses a single node called `main`, which is what the
// projections in `kernel/projections.ts` read.

import type { EngineType, EffortLevel, PermissionMode } from '../../types.js';
import { LEGACY_NODE } from '../projections.js';

export interface LegacyCouncilArgs {
  task: string;
  cwd: string;
  agents: CouncilNode['agents'];
  maxRounds: number;
  timeoutMs?: number;
  maxTurnsPerAgent?: number;
  maxBudgetUsd?: number;
  defaultPermissionMode?: string;
}

export function legacyCouncilWorkflow(args: LegacyCouncilArgs): WorkflowSpec {
  return {
    name: 'council',
    cwd: args.cwd,
    nodes: [
      {
        id: LEGACY_NODE,
        kind: 'council',
        task: args.task,
        agents: args.agents,
        projectDir: args.cwd,
        maxRounds: args.maxRounds,
        timeoutMs: args.timeoutMs,
        maxTurnsPerAgent: args.maxTurnsPerAgent,
        maxBudgetUsd: args.maxBudgetUsd,
        defaultPermissionMode: args.defaultPermissionMode,
      },
    ],
  };
}

export interface LegacyFanoutArgs {
  task: string;
  cwd: string;
  agents: FanoutNode['agents'];
  synthesize?: boolean;
  synthesisEngine?: FanoutNode['synthesisEngine'];
  synthesisModel?: string;
  synthesisPermissionMode?: string;
  maxTurnsPerAgent?: number;
  maxBudgetUsd?: number;
  timeoutMs?: number;
  name?: string;
}

export function legacyFanoutWorkflow(args: LegacyFanoutArgs): WorkflowSpec {
  return {
    name: args.name ?? 'fanout',
    cwd: args.cwd,
    nodes: [
      {
        id: LEGACY_NODE,
        kind: 'fanout',
        prompt: args.task,
        agents: args.agents,
        synthesize: args.synthesize,
        synthesisEngine: args.synthesisEngine,
        synthesisModel: args.synthesisModel,
        synthesisPermissionMode: args.synthesisPermissionMode,
        maxTurnsPerAgent: args.maxTurnsPerAgent,
        maxBudgetUsd: args.maxBudgetUsd,
        cwd: args.cwd,
        timeoutMs: args.timeoutMs,
      },
    ],
  };
}

/**
 * Split per-agent custom-engine configs out of a legacy agent list.
 *
 * They hold credentials and the spec is written to disk, so they travel through
 * `StartOptions.secrets` instead — keyed by agent name, which is unique within a
 * run because both council and fan-out already require it.
 */
export function splitAgentSecrets<T extends { name: string; customEngine?: unknown }>(
  agents: T[],
): { agents: Omit<T, 'customEngine'>[]; secrets: Record<string, unknown> } {
  const secrets: Record<string, unknown> = {};
  const stripped = agents.map((a) => {
    const { customEngine, ...rest } = a;
    if (customEngine) secrets[a.name] = customEngine;
    return rest;
  });
  return { agents: stripped, secrets };
}

export const ULTRAPLAN_SYSTEM_PROMPT =
  'You are in ultraplan mode. Explore the project thoroughly, analyze feasibility, and produce a detailed, ' +
  'actionable plan. Do NOT write code — plan only. Output your final plan in a clear markdown format.';

export interface LegacyUltraplanArgs {
  task: string;
  cwd: string;
  model?: string;
  engine?: EngineType;
  timeoutMs: number;
}

export function legacyUltraplanWorkflow(args: LegacyUltraplanArgs): WorkflowSpec {
  return {
    name: 'ultraplan',
    cwd: args.cwd,
    nodes: [
      {
        id: LEGACY_NODE,
        kind: 'agent',
        cwd: args.cwd,
        engine: args.engine,
        model: args.model,
        permissionMode: 'plan' as PermissionMode,
        effort: 'max' as EffortLevel,
        timeoutMs: args.timeoutMs,
        prompt:
          `# Ultraplan Task\n\n${args.task}\n\nExplore the project, understand the codebase, analyze ` +
          `feasibility, and produce a comprehensive implementation plan. Take your time (up to 30 minutes). ` +
          `Be thorough.`,
      },
    ],
  };
}

export type TemplateName = 'council' | 'fanout' | 'solve';

export const TEMPLATE_NAMES: readonly TemplateName[] = ['council', 'fanout', 'solve'];
