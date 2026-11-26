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

import type { TestSnapshot } from '../verify/protected-tests.js';
import type { AcceptanceContract } from '../verify/contract.js';
import type { AgentBinding, EngineType } from '../types.js';

// ─── Run + node state ───────────────────────────────────────────────────────

/**
 * `completed` is entered from `running` once control runs out of nodes; a
 * verifier holds the run in `verifying` only while its checks run. A run
 * carrying a contract whose evidence is red goes to `failed`, never to
 * `completed` — that is the whole point of the state machine — and so does a
 * run that declares a run-level contract and ends without having run it.
 */
export type RunState = 'pending' | 'running' | 'awaiting_human' | 'verifying' | 'completed' | 'failed' | 'cancelled';

/**
 * Whether anything independent of the agent checked the work.
 * - `verified`   — a contract ran and every required check passed.
 * - `unverified` — no contract ran, or its verdict no longer describes the tree. We do not know.
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
  | 'goal'
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

export interface AgentNode extends NodeBase, AgentBinding {
  kind: 'agent';
  prompt: string;
  cwd?: string;
  /**
   * Pin the session name to keep one conversation across visits and nodes: each
   * turn's process stops when it ends, and the next start under this name
   * resumes the conversation (engines that resume by id). The name outlives the
   * run, so make it unique to the run. Omitted means a new session per attempt.
   */
  sessionName?: string;
  /**
   * Keep one conversation across this node's visits without naming it: a
   * revisit (a repair after a red verdict) continues the conversation the first
   * visit had, so the agent knows what it already tried. The session is named
   * for the run and node.
   */
  continueConversation?: boolean;
  /**
   * Nodes whose output this node reads before its prompt — scouts' findings for
   * an implementer, reviewers' for a repair. Each is framed as data, cut to a
   * bounded excerpt with the path of the whole; a node that has not run yet is
   * left out.
   */
  inputs?: string[];
  permissionMode?: string;
  /** Engine-agnostic sandbox, as on a session; `read-only` holds on every engine that supports it. */
  sandboxMode?: 'read-only' | 'workspace-write' | 'danger-full-access';
  /** Standing instructions for the session, appended to its system prompt. */
  appendSystemPrompt?: string;
  /** Tools the session may not use (`--disallowed-tools`). Engines `claude` and `grok`; refused on the others. */
  disallowedTools?: string[];
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
export interface FanoutAgentSpec extends AgentBinding {
  name: string;
  /** Complete per-agent prompt. Overrides persona and the node's shared prompt when non-empty. */
  prompt?: string;
  /** Role instructions composed before the shared fan-out task without a non-empty prompt. */
  persona?: string;
  permissionMode?: string;
  /** Engine-agnostic sandbox; `read-only` holds on every engine that supports it. */
  sandboxMode?: 'read-only' | 'workspace-write' | 'danger-full-access';
  baseUrl?: string;
  ultracode?: boolean;
  /**
   * Fan-out only: this agent's own working directory, absolute or relative to the
   * node's `cwd`. Council seats ignore it; they get worktrees of their own.
   */
  cwd?: string;
  /**
   * Fan-out only: run this agent as a goal instead of one turn — a goal on its
   * engine (any goal engine, see `GoalNode.engine`) with this objective, under the same
   * rules as a `goal` node: the goal ends when its judge or the agent says it is
   * met, out of budget, or blocked, and stalls and capacity errors are resumed.
   * It runs as a child run with one goal node, so a resumed parent picks it up
   * where it was rather than starting it again.
   */
  objective?: string;
  /** Goal agents: tokens the goal may spend. */
  tokenBudget?: number;
  /** Goal agents: resuming after usage limits, overload and stalls (as on a goal node). */
  capacityRetry?: { max: number; backoffMs?: number };
  /** Goal agents: an active goal with no turn and no news for this long is resumed. */
  stallMs?: number;
  /** Goal agents: how long the goal may run. Default: the kernel's node timeout. */
  timeoutMs?: number;
}

export interface FanoutNode extends NodeBase {
  kind: 'fanout';
  prompt: string;
  agents: FanoutAgentSpec[];
  synthesize?: boolean;
  synthesisEngine?: EngineType;
  synthesisModel?: string;
  /** The ACP agent preset for a synthesis pass on engine `acp`. */
  synthesisAcpAgent?: string;
  synthesisPermissionMode?: string;
  maxTurnsPerAgent?: number;
  maxBudgetUsd?: number;
  cwd?: string;
  /**
   * One agent's send. `timeoutMs` bounds the whole node, and agents past the free
   * session slots wait for one, so the two are not the same budget. Omitted, it
   * falls back to `timeoutMs`, which is what the field meant before.
   */
  agentTimeoutMs?: number;
}

/** One council seat: a fan-out agent plus the emoji its charter and transcript show. */
export interface CouncilAgentSpec extends FanoutAgentSpec {
  emoji?: string;
}

export interface CouncilNode extends NodeBase {
  kind: 'council';
  task: string;
  agents: CouncilAgentSpec[];
  projectDir?: string;
  /** Omitted means `DEFAULT_MAX_ROUNDS`, the same default `council_start` uses. */
  maxRounds?: number;
  maxTurnsPerAgent?: number;
  maxBudgetUsd?: number;
  defaultPermissionMode?: string;
  /** One agent's send; `timeoutMs` bounds the whole council. Falls back to `timeoutMs`. */
  agentTimeoutMs?: number;
}

export interface VerifierNode extends NodeBase {
  kind: 'verifier';
  /** Inline contract, or `'run'` to use the workflow-level contract. */
  contract: AcceptanceContract | 'run';
  cwd?: string;
  /**
   * Who repairs on red when the contract sets `fixOnFailureRounds`: the engine,
   * model and permissions of the fix session. Default: the configured default
   * engine with `bypassPermissions`. `solve` gives it the implementer's, so a
   * repair runs with no more permission than the implementation had.
   */
  fixer?: AgentBinding & {
    permissionMode?: string;
    sandboxMode?: 'read-only' | 'workspace-write' | 'danger-full-access';
  };
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
  | { type: 'visits_lt'; node: string; n: number }
  /**
   * All of them. Added because chaining two routers does not mean AND: a router
   * whose routes all miss falls through to the next node, so a gate that failed
   * to match simply handed control to the router after it, which then matched
   * on its own. The `solve` repair loop read as "red AND budget left" and
   * behaved as "budget left".
   */
  | { type: 'and'; all: RouterCondition[] };

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
 * A `/goal`: one thread working on one objective, turn after turn on its own,
 * until the goal leaves `active`. A Codex `codex-app` thread by default, or a
 * Claude Code session with `engine: 'claude'`.
 *
 * The thread id is checkpointed on the node, so a resumed run reattaches the
 * same thread rather than starting the objective over. A revisit after a red
 * verifier sets a new objective on that thread, prefixed with the failing
 * checks. Like `autoloop`, it has no default node timeout; `timeoutMs` is the
 * wall-clock budget.
 */
/** The engines a goal runs on. */
export const GOAL_ENGINES = ['claude', 'codex', 'codex-app', 'agy', 'grok', 'opencode', 'cursor', 'acp'] as const;
export type GoalEngine = (typeof GOAL_ENGINES)[number];

export interface GoalNode extends NodeBase {
  kind: 'goal';
  objective: string;
  /**
   * Who runs the goal: Codex (`codex`, a `codex-app` thread) or Claude Code run
   * the goal loop themselves; on `agy`, `grok`, `opencode` and `acp` clawo runs
   * it turn by turn (`TurnGoalSession`). Omitted, the configured default engine,
   * fixed when the run starts.
   */
  engine?: GoalEngine;
  /** The ACP agent preset, for `engine: 'acp'`. */
  acpAgent?: string;
  cwd?: string;
  model?: string;
  effort?: string;
  /** Codex's own sandbox; Claude Code has no equivalent and ignores it. */
  sandboxMode?: 'read-only' | 'workspace-write' | 'danger-full-access';
  /**
   * Claude Code only: the account to run under, or `auto` for the rotation in
   * the accounts file; at a usage limit the goal moves to the next account and
   * goes on. Unset uses the configured default.
   */
  claudeAccount?: string;
  /** Argv prefix the engine runs under, e.g. a sandbox wrapper. Caller-authored. */
  launcher?: string[];
  /**
   * Start on this existing codex-app thread instead of a new one: its goal is
   * replaced by `objective`, and the agent keeps the thread's history. Used
   * once; a resumed run follows the thread id it checkpointed.
   */
  threadId?: string;
  /** Tokens the goal may spend; it ends as `budgetLimited` past this. */
  tokenBudget?: number;
  /**
   * Resuming a goal that stopped on a usage limit, an overloaded endpoint or a
   * stall. `max` counts attempts, made or not; past it the node fails. Default
   * 20 attempts, backoff from 60 s doubling to at most 15 min.
   */
  capacityRetry?: { max: number; backoffMs?: number };
  /** An active goal with no turn and no notification for this long is resumed. Default 5 min. */
  stallMs?: number;
  /**
   * Tools the session may not use (`--disallowed-tools`). `claude` and `grok`
   * only: Codex's app-server has no per-thread tool list, so it is refused there,
   * as on the other engines.
   */
  disallowedTools?: string[];
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
  /** Where to put the consensus codebase. Absent on runs recorded before builds were versioned: `versions/v1/codebase`. */
  codebasePath?: string;
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
  | GoalNode
  | UltraappSynthNode
  | UltraappDeployNode;

// ─── Workflow spec ──────────────────────────────────────────────────────────

export interface WorkflowSpec {
  /**
   * Run in a git worktree of its own, from the repository's HEAD, on a local
   * branch `clawo/<runId>` that keeps whatever the run left when it ends; the
   * caller's checkout is never written. `{ mode: 'worktree', link }` names the
   * untracked dependency directories linked in (default `node_modules`, `.venv`).
   */
  isolation?: import('./isolation.js').IsolationSpec;
  /**
   * The run's spend cap in USD, across every node. Checked before each node;
   * each node's sessions get what is left as their own cap, and a goal stops
   * when it has spent it. Reaching it fails the run.
   */
  maxBudgetUsd?: number;
  name: string;
  nodes: NodeSpec[];
  cwd?: string;
  /**
   * Run-level acceptance contract. When present the kernel appends an implicit
   * terminal verifier unless the spec places its own `contract: 'run'` one, and a
   * run that ends without a verdict from such a verifier fails — so `completed`
   * always means "this contract ran and passed". An outcome of `unverified` on a
   * completed run says the verdict stopped describing the tree afterwards.
   */
  contract?: AcceptanceContract;
  /** Loop bound. Exceeding it fails the run rather than spinning. Default 50. */
  maxNodeVisits?: number;
  /**
   * A forum every agent of this run shares (`kernel/forum.ts`): `true`, or a
   * config for what is pushed to agents and what score each post carries.
   */
  forum?: boolean | import('./forum.js').ForumConfig;
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
   * Times a resume found this node running, i.e. its process stopped part-way
   * through it. Execution is at-least-once, so the node runs again from the top;
   * an agent or goal node is told so in its prompt. Cleared when the node ends.
   */
  interrupted?: number;
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

/** One resume of a run: what it found interrupted, and the rules a caller declared for it. */
export interface RunResume {
  at: string;
  /** `restart`: a finished run started again from the top. */
  restart?: boolean;
  /** Nodes that were running when the previous process stopped; they run again from the beginning. */
  interruptedNodes: string[];
  /** The suspension this resume ended, when the previous process stopped cleanly (`RunRecord.suspended`). */
  suspended?: RunSuspension;
  /** Fingerprint of the run contract the caller declared at this resume, when it declared one. */
  declaredContract?: string;
  /**
   * Set when the declared rules differ from the ones the run started with. The run
   * still verifies with its own (`checkpoint`); a verdict under the declared rules
   * is a separate check (`verify_run`), never merged into this run's.
   */
  contractDrift?: ContractDrift;
  /** The same, per verifier node with an inline contract that the caller declared. */
  nodeContractDrift?: Record<string, ContractDrift>;
}

/** A run whose process stopped while it was live, and that is waiting to be resumed. */
export interface RunSuspension {
  at: string;
  reason: string;
}

export interface ContractDrift {
  /** The fingerprint recorded when the run started, or `unknown` for a run from before fingerprints. */
  checkpoint: string;
  declared: string;
  /** How the declared rules relate to the run's (`compareContracts`), `added` when the run had none. */
  relation: 'adds-checks' | 'removes-checks' | 'changed' | 'added';
}

export interface RunRecord {
  runId: string;
  /**
   * The forum this run's agent belongs to when the forum is another run's: a
   * fan-out goal agent's child run carries its parent's forum and its own name
   * on it, so a resume puts it back on the same forum.
   */
  forum?: import('./forum.js').ForumBinding;
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
  /**
   * The test files and test configuration as the run found them, for the
   * protected-tests check. Taken only when the run-level contract or a
   * verifier's inline contract has a `command` check and does not set
   * `protectTests: false`, or the spec has a subflow (`needsTestSnapshot`). A
   * subflow child uses its parent's, when the parent has one.
   */
  baseTests?: TestSnapshot;
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
  /**
   * The last verdict of the run's own contract (a `contract: 'run'` verifier),
   * kept apart from `verdict`, which the latest evidence-producing node writes.
   * A run whose declared contract failed is refuted whatever a later verifier
   * says: an inline verifier that passed after it does not stand in for it.
   */
  runContractVerdict?: { node: string; evidenceId: string; passed: boolean };
  /** The worktree a `isolation: 'worktree'` run works in, its branch, and the commit it was saved as. */
  isolation?: import('./isolation.js').RunIsolation;
  verdict?: {
    node: string;
    evidenceId: string;
    treeFingerprint?: string;
    /** Where that digest was taken — a verifier may declare its own cwd. */
    fingerprintCwd?: string;
    sideEffectSeq: number;
    /**
     * Fingerprint of the rules this verdict was reached under (`contractFingerprint`).
     * Absent on verdicts from before fingerprints, which are reported as unknown.
     */
    contractHash?: string;
  };
  /**
   * Fingerprints of the contracts the run was started with: the run-level one
   * and each verifier node's inline one, by node id. Written at start and never
   * changed: a resume re-checks with these rules, whatever is declared then.
   * Absent on runs from before fingerprints.
   */
  contractHashes?: { run?: string; nodes?: Record<string, string> };
  /**
   * Whether the run's nodes ran to the end, kept apart from whether the work
   * passed its contract (`outcome`). `completed` with `outcome: 'refuted'` is a
   * run that finished and failed its checks; `failed` is one that did not get
   * through its nodes (a node error, a gate rejected, a loop bound). Set when the
   * run ends; absent on runs from before this field.
   */
  execution?: 'completed' | 'failed' | 'cancelled';
  /** Every resume of this run, oldest first. */
  resumes?: RunResume[];
  /**
   * Set when the process running this run stopped (a shutdown: SIGTERM, SIGINT,
   * a service restart) while the run was live. The run is left where a crash
   * would leave it — not terminal, its running node to be run again — rather
   * than cancelled, because a process stopping is not a decision about the run.
   * Cleared by the resume that picks it up.
   */
  suspended?: RunSuspension;
  /**
   * Count of node results absorbed from kinds that can touch the workspace —
   * every kind but `verifier`, `router` and `human_gate` (`SIDE_EFFECT_KINDS` in
   * the engine). Compared against the value stored on the verdict, so the
   * kernel knows whether anything ran after the checks at all.
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
  /** A node finished holding `count` steers, taken in the order they were logged. */
  | { ts: string; type: 'steer_consumed'; node: string; count: number }
  | { ts: string; type: 'evidence'; node: string; evidenceId: string; passed: boolean }
  | { ts: string; type: 'log'; level: 'info' | 'warn' | 'error'; message: string };

export const TERMINAL_RUN_STATES: readonly RunState[] = ['completed', 'failed', 'cancelled'];

export function isTerminalRunState(s: RunState): boolean {
  return TERMINAL_RUN_STATES.includes(s);
}
