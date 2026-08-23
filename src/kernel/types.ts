/**
 * Kernel types — one state vocabulary for every run this runtime executes.
 *
 * Before this module the six orchestration modes each carried their own status
 * union (`CouncilSession.status`, `FanoutSession.status`, `UltraplanResult.status`,
 * `UltrareviewResult.status`, ultraapp's `RunMode`, `AutoloopStatus`) with no
 * overlapping vocabulary, so "is it done" had six different answers and no
 * cross-mode listing was possible. These types replace that.
 *
 * The important distinction encoded here is between *finishing* and *being
 * right*. `RunState` says whether the work stopped; `RunOutcome` says whether
 * anything checked it. A run with no acceptance contract finishes `completed` /
 * `unverified` — it says it does not know, which is not the same as success.
 */

import type { AcceptanceContract } from '../verify/contract.js';
import type { EngineType } from '../types.js';

// ─── Run + node state ───────────────────────────────────────────────────────

/**
 * `completed` is reachable only from `verifying`. A run carrying a contract
 * whose evidence is red goes to `failed`, never to `completed` — that is the
 * whole point of the state machine.
 */
export type RunState = 'pending' | 'running' | 'awaiting_human' | 'verifying' | 'completed' | 'failed' | 'cancelled';

/**
 * Whether anything independent of the agent checked the work.
 * - `verified`   — a contract ran and every required check passed.
 * - `unverified` — no contract was declared. We do not know.
 * - `refuted`    — a contract ran and a required check failed.
 */
export type RunOutcome = 'verified' | 'unverified' | 'refuted';

export type NodeState = 'pending' | 'running' | 'awaiting_human' | 'succeeded' | 'failed' | 'skipped' | 'cancelled';

// ─── Node specs ─────────────────────────────────────────────────────────────

export type NodeKind =
  | 'agent'
  | 'fanout'
  | 'council'
  | 'verifier'
  | 'human_gate'
  | 'router'
  | 'subflow'
  | 'autoloop'
  | 'ultraapp_synth'
  | 'ultraapp_deploy';

export interface NodeBase {
  id: string;
  kind: NodeKind;
  /** Explicit successor. Omitted means "the next node in `nodes` order". */
  next?: string;
  retry?: { max: number; backoffMs?: number };
  /** Wall clock for one attempt. Omitted means the kernel default. */
  timeoutMs?: number;
  /** `continue` records the failure and proceeds; `fail` ends the run. Default `fail`. */
  onFailure?: 'fail' | 'continue';
}

export interface AgentNode extends NodeBase {
  kind: 'agent';
  prompt: string;
  engine?: EngineType;
  model?: string;
  cwd?: string;
  /** Reuse a named session across nodes; omitted means one session per attempt. */
  sessionName?: string;
  effort?: string;
  permissionMode?: string;
}

/**
 * One agent in a fan-out or council.
 *
 * This mirrors the legacy per-agent shape field for field, deliberately. The
 * first cut of the kernel carried only `name` / `engine` / `model` / `persona`,
 * and the adapters silently dropped everything else — so an ultrareview that
 * built a bespoke prompt and `permissionMode: 'plan'` per reviewer handed the
 * session neither: every reviewer got the shared task, under
 * `bypassPermissions`. A read-only review that can write is worse than no
 * review, and nothing failed to say so.
 *
 * `customEngine` is the one field NOT here. It can carry credentials, and a
 * spec is written to disk — see `StartOptions.secrets`.
 */
export interface FanoutAgentSpec {
  name: string;
  engine?: EngineType;
  model?: string;
  /** Per-agent prompt. Overrides the node's shared prompt when present. */
  prompt?: string;
  /** Council-style persona text. */
  persona?: string;
  permissionMode?: string;
  baseUrl?: string;
  effort?: string;
  ultracode?: boolean;
}

export interface FanoutNode extends NodeBase {
  kind: 'fanout';
  prompt: string;
  agents: FanoutAgentSpec[];
  synthesize?: boolean;
  synthesisEngine?: EngineType;
  synthesisModel?: string;
  synthesisPermissionMode?: string;
  maxTurnsPerAgent?: number;
  maxBudgetUsd?: number;
  cwd?: string;
}

export interface CouncilNode extends NodeBase {
  kind: 'council';
  task: string;
  agents: FanoutAgentSpec[];
  projectDir?: string;
  maxRounds?: number;
  maxTurnsPerAgent?: number;
  maxBudgetUsd?: number;
  defaultPermissionMode?: string;
}

export interface VerifierNode extends NodeBase {
  kind: 'verifier';
  /** Inline contract, or `'run'` to use the workflow-level contract. */
  contract: AcceptanceContract | 'run';
  cwd?: string;
}

export interface HumanGateNode extends NodeBase {
  kind: 'human_gate';
  prompt: string;
}

/**
 * Declarative conditions only — no expression string is ever evaluated, so a
 * workflow spec that reached us from an agent cannot execute code.
 */
export type RouterCondition =
  | { type: 'always' }
  | { type: 'node_failed'; node: string }
  | { type: 'node_succeeded'; node: string }
  | { type: 'verified'; node: string }
  | { type: 'visits_lt'; node: string; n: number };

export interface RouterNode extends NodeBase {
  kind: 'router';
  /** First matching route wins. A route may point backwards — that is the loop. */
  routes: Array<{ when: RouterCondition; to: string }>;
  /** Taken when nothing matches. Omitted means "fall through to the next node". */
  default?: string;
}

export interface SubflowNode extends NodeBase {
  kind: 'subflow';
  workflow: string | WorkflowSpec;
}

/**
 * A long-lived Planner / Coder / Reviewer loop.
 *
 * Unlike the other node kinds this one runs for as long as the user keeps
 * talking to it — it settles when the loop terminates, not when a turn returns.
 * The spec carries only JSON, because it is checkpointed; the executor that
 * knows how to build a dispatcher is registered by SessionManager.
 */
export interface AutoloopNode extends NodeBase {
  kind: 'autoloop';
  workspace: string;
  config: Record<string, unknown>;
}

/**
 * UltraApp's two expensive stages.
 *
 * They are their own kinds for the same reason `autoloop` is: the engine behind
 * them needs a store, a router and a deploy strategy that the kernel has no
 * business knowing about, so the executor is injected and the spec carries only
 * JSON. What the kernel owns is what it owns for every other node — the
 * checkpoint, the claim, the retry, the cancel, and the fact that a crash
 * between them does not redo the one that already finished.
 *
 * The stage between them — running the build contract — is not here, because it
 * is not UltraApp-specific: it is the ordinary `verifier` node.
 */
export interface UltraappSynthNode extends NodeBase {
  kind: 'ultraapp_synth';
  /** UltraApp's own run id — the key its store is organised by. */
  appRunId: string;
  /** Absolute per-run directory; the council project and the codebase live under it. */
  runDir: string;
  slug: string;
}

export interface UltraappDeployNode extends NodeBase {
  kind: 'ultraapp_deploy';
  appRunId: string;
  runDir: string;
  slug: string;
  version: string;
  /** Where the synthesised codebase lives, once `ultraapp_synth` has produced it. */
  codebasePath: string;
}

export type NodeSpec =
  | AgentNode
  | FanoutNode
  | CouncilNode
  | VerifierNode
  | HumanGateNode
  | RouterNode
  | SubflowNode
  | AutoloopNode
  | UltraappSynthNode
  | UltraappDeployNode;

// ─── Workflow spec ──────────────────────────────────────────────────────────

export interface WorkflowSpec {
  name: string;
  nodes: NodeSpec[];
  cwd?: string;
  /**
   * Run-level acceptance contract. When present the kernel appends an implicit
   * terminal verifier, so `completed` always means "a contract passed".
   */
  contract?: AcceptanceContract;
  /** Loop bound. Exceeding it fails the run rather than spinning. Default 50. */
  maxNodeVisits?: number;
}

// ─── Persisted records ──────────────────────────────────────────────────────

export interface NodeRecord {
  id: string;
  kind: NodeKind;
  state: NodeState;
  /** Attempts of the current visit (retry counter). */
  attempts: number;
  /** Times the router has sent control here (loop counter). */
  visits: number;
  startedAt?: string;
  endedAt?: string;
  error?: string;
  /** Truncated text output; the full text lives under `nodes/<id>/` when large. */
  output?: string;
  /** Paths relative to the run directory. */
  artifacts?: string[];
  evidenceId?: string;
  /** Subflow nodes: the child run this node started, so it stays addressable. */
  childRunId?: string;
  /**
   * Mode-specific payload, checkpointed with the run.
   *
   * This is what lets the legacy per-mode shapes (`CouncilSession`,
   * `FanoutSession`, …) be projected from a run instead of held in their own
   * in-memory maps. It has to be durable for the same reason the rest of the
   * record does: a fan-out's results used to evaporate 30 minutes after it
   * finished, because the only copy was in a `Map`.
   */
  data?: unknown;
}

/** Advisory only. A vote is recorded, never used as a termination condition. */
export interface ConsensusVote {
  agent: string;
  round: number;
  vote: boolean;
  source: 'strict' | 'variant' | 'none';
}

export interface RunRecord {
  runId: string;
  workflow: string;
  spec: WorkflowSpec;
  state: RunState;
  outcome: RunOutcome;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  endedAt?: string;
  currentNode?: string;
  nodes: Record<string, NodeRecord>;
  error?: string;
  /** Evidence bundle id of the terminal verifier, when one ran. */
  evidenceId?: string;
  /** `git rev-parse HEAD` captured at run start, when cwd is a repo. */
  baseSha?: string;
  /** Recorded for the record. Never consulted to decide completion. */
  consensusVotes?: ConsensusVote[];
  costUsd?: number;
  /**
   * Why the outcome is what it is, when that needs saying — chiefly when a
   * passing verdict was downgraded because the tree moved after the check.
   */
  outcomeReason?: string;
  /**
   * The verdict currently in force: which node produced it, and the tree digest
   * at that moment. Compared against the tree when the run ends, so evidence
   * overtaken by later edits cannot keep standing as `verified`.
   */
  verdict?: { node: string; evidenceId: string; treeFingerprint?: string; sideEffectSeq: number };
  /**
   * Count of completed nodes that can touch the workspace (`agent`, `fanout`,
   * `council`, `subflow`). Compared against the value stored on the verdict, so
   * the kernel knows whether anything ran after the checks at all.
   */
  sideEffectSeq?: number;
}

// ─── Events ─────────────────────────────────────────────────────────────────

export type KernelEvent =
  | { ts: string; type: 'run_created'; runId: string; workflow: string }
  | { ts: string; type: 'run_state'; state: RunState; outcome?: RunOutcome; error?: string }
  | { ts: string; type: 'node_state'; node: string; state: NodeState; attempt?: number; error?: string }
  | { ts: string; type: 'node_output'; node: string; text: string }
  | { ts: string; type: 'steer'; node: string; text: string }
  | { ts: string; type: 'evidence'; node: string; evidenceId: string; passed: boolean }
  | { ts: string; type: 'log'; level: 'info' | 'warn' | 'error'; message: string };

export const TERMINAL_RUN_STATES: readonly RunState[] = ['completed', 'failed', 'cancelled'];

export function isTerminalRunState(s: RunState): boolean {
  return TERMINAL_RUN_STATES.includes(s);
}
