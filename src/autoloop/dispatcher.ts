/**
 * ClaudeAgentDispatcher — wires the v2 runner to real persistent coding
 * sessions managed by SessionManager. The historical class name is retained
 * for compatibility; each Autoloop role may use a different engine.
 *
 * Naming convention:
 *   autoloop-<run_id>-planner
 *   autoloop-<run_id>-coder      (S4)
 *   autoloop-<run_id>-reviewer   (S4)
 *
 * Reply path:
 *   When the user chats, we sendMessage(planner, text) and capture the
 *   Planner's natural-language reply. The reply is *not* a v2 message —
 *   it is emitted as the dispatcher's own 'planner_reply' event so the
 *   `autoloop_chat` plugin tool can return it to the user. Structured
 *   signals (S3+) will be parsed out of the same reply text and pushed
 *   into the runner queue.
 */

import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { SessionManager } from '../session-manager.js';
import type { Logger } from '../logger.js';
import { ENGINE_TYPES, type CustomEngineConfig, type EngineType } from '../types.js';
import { nullLogger } from '../logger.js';
import { spawn } from 'node:child_process';
import { type AnyAutoloopMessage, Msg } from './messages.js';
import {
  LEDGER_SCHEMA_VERSION,
  type AgentDispatcher,
  type AutoloopRoleName,
  type AutoloopState,
  type PushPolicy,
} from './types.js';

import {
  applyPlannerToolCalls,
  parsePlannerReply,
  type PlannerToolEffects,
  type SpawnSubagentsArgs,
} from './planner-tools.js';
import { extractIterComplete, extractReviewComplete, parseAgentReply } from './agent-tools.js';

/**
 * Character budget for the replayed transcript handed to engines without native
 * conversation (see hasNativeConversation). Oldest turns are dropped first, so a
 * long run keeps the recent context instead of growing the prompt forever.
 */
const REPLAY_CHAR_BUDGET = 24_000;

/**
 * Files inside <ledger>/reviewer_sandbox/ that survive `stageReviewSandbox`.
 * Anything not listed is wiped between iters. `reviewer_memory.md` is also
 * frozen-injected into the Reviewer system prompt at session start, so
 * mid-session edits won't be reread until the next reset.
 */
const REVIEWER_SANDBOX_PERSIST = new Set(['reviewer_memory.md', 'reviewer_log.jsonl']);

/**
 * Push-policy keys that callers MUST NOT be able to silence at runtime.
 * Prompt-injection could otherwise let a confused/malicious Planner mute the
 * channels we use to surface phase errors and decision points.
 */
const UNSILENCEABLE_POLICY_KEYS = new Set(['on_phase_error', 'on_decision_needed']);

export interface ClaudeAgentDispatcherConfig {
  manager: SessionManager;
  runId: string;
  workspace: string;
  /** Override the default Planner system prompt (default loads from configs/autoloop-planner-prompt.md). */
  plannerPromptPath?: string;
  /** Override Coder/Reviewer prompt paths (defaults walk-up to configs/autoloop-{coder,reviewer}-prompt.md). */
  coderPromptPath?: string;
  reviewerPromptPath?: string;
  /** Planner engine/model (default: claude/opus). */
  plannerEngine?: EngineType;
  plannerModel?: string;
  plannerCustomEngine?: CustomEngineConfig;
  /** Coder defaults. Engine/model can be overridden per spawn_subagents call. */
  coderEngine?: EngineType;
  coderModel?: string;
  coderCustomEngine?: CustomEngineConfig;
  /** Reviewer defaults. Engine/model can be overridden per spawn_subagents call. */
  reviewerEngine?: EngineType;
  reviewerModel?: string;
  reviewerCustomEngine?: CustomEngineConfig;
  /** Per-message wall-clock cap. Default 10 min. */
  sendTimeoutMs?: number;
  logger?: Logger;
  /**
   * Auto-compact thresholds (percent of context window). When the agent's
   * `contextPercent` (from getStats) climbs above its threshold after a
   * turn, the dispatcher dispatches `/compact <agent-specific summary>` to
   * that agent. Defaults: Planner 80%, Coder 70%, Reviewer 70%.
   *
   * Per the design doc §7: each agent's context is precious; don't let it
   * silently fill until the API rejects.
   */
  compactThresholds?: { planner?: number; coder?: number; reviewer?: number };
  /**
   * Push-policy ref that S3's update_push_policy mutates. Caller (SessionManager)
   * passes its own policy object so changes are visible to the runner.
   */
  pushPolicyRef?: PushPolicy;
  /** Called when Planner emits spawn_subagents. S4 implements; S3 records the intent. */
  onSpawnSubagents?: (args: SpawnSubagentsArgs) => Promise<void>;
  /** Persist the effective non-secret role selection after a successful spawn. */
  onRoleSelectionChanged?: (selection: {
    coder: { engine: EngineType; model?: string };
    reviewer: { engine: EngineType; model?: string };
  }) => Promise<void> | void;
}

function resolveConfigByName(filename: string): string {
  const filePath = fileURLToPath(import.meta.url);
  let dir = path.dirname(filePath);
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, 'configs', filename);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.join(path.dirname(filePath), '..', 'configs', filename);
}
const resolveDefaultPlannerPrompt = (): string => resolveConfigByName('autoloop-planner-prompt.md');
const resolveDefaultCoderPrompt = (): string => resolveConfigByName('autoloop-coder-prompt.md');
const resolveDefaultReviewerPrompt = (): string => resolveConfigByName('autoloop-reviewer-prompt.md');

interface SendMessageResult {
  output: string;
  error?: string;
  /** Set when even the recovery retry failed — caller surfaces as phase_error. */
  fatal?: boolean;
}

interface AutoloopRoleSelection {
  engine: EngineType;
  /** User-specified model. Undefined means use the role default for Claude, otherwise the engine default. */
  model?: string;
  /** Trusted config supplied at autoloop start/resume; never accepted from Planner output or written to the ledger. */
  customEngine?: CustomEngineConfig;
}

interface DecisionLogEntry {
  ts: string;
  kind:
    | 'terminate'
    | 'reset_agent'
    | 'update_push_policy'
    | 'compact'
    | 'spawn_subagents'
    | 'phase_error'
    | 'policy_silence_blocked';
  actor: 'planner' | 'runner' | 'dispatcher';
  payload: Record<string, unknown>;
}

export class ClaudeAgentDispatcher extends EventEmitter implements AgentDispatcher {
  readonly config: ClaudeAgentDispatcherConfig;
  private logger: Logger;
  private plannerName: string;
  private coderName: string;
  private reviewerName: string;
  private plannerStarted = false;
  private coderStarted = false;
  private reviewerStarted = false;
  private plannerSystemPrompt: string;
  private coderSystemPrompt: string;
  private reviewerSystemPrompt: string;
  private reviewerSessionPrompt: string | null = null;
  private plannerSelection: AutoloopRoleSelection;
  private coderSelection: AutoloopRoleSelection;
  private reviewerSelection: AutoloopRoleSelection;
  /** Where Reviewer reads from. Created lazily by stageReviewSandbox(). */
  private reviewerSandboxDir: string;
  private ledgerDir: string;

  constructor(config: ClaudeAgentDispatcherConfig) {
    super();
    this.config = config;
    this.logger = config.logger ?? nullLogger;
    this.plannerName = `autoloop-${config.runId}-planner`;
    this.coderName = `autoloop-${config.runId}-coder`;
    this.reviewerName = `autoloop-${config.runId}-reviewer`;

    const promptPath = config.plannerPromptPath ?? resolveDefaultPlannerPrompt();
    this.plannerSystemPrompt = fs.readFileSync(promptPath, 'utf-8');
    this.coderSystemPrompt = fs.readFileSync(config.coderPromptPath ?? resolveDefaultCoderPrompt(), 'utf-8');
    this.reviewerSystemPrompt = fs.readFileSync(config.reviewerPromptPath ?? resolveDefaultReviewerPrompt(), 'utf-8');
    this.plannerSelection = {
      engine: config.plannerEngine ?? 'claude',
      model: config.plannerModel,
      customEngine: config.plannerCustomEngine,
    };
    this.coderSelection = {
      engine: config.coderEngine ?? 'claude',
      model: config.coderModel,
      customEngine: config.coderCustomEngine,
    };
    this.reviewerSelection = {
      engine: config.reviewerEngine ?? 'claude',
      model: config.reviewerModel,
      customEngine: config.reviewerCustomEngine,
    };
    this.ledgerDir = path.join(config.workspace, 'tasks', config.runId);
    this.reviewerSandboxDir = path.join(this.ledgerDir, 'reviewer_sandbox');
  }

  get sessionNames(): { planner: string; coder: string; reviewer: string } {
    return { planner: this.plannerName, coder: this.coderName, reviewer: this.reviewerName };
  }

  async init(state: AutoloopState): Promise<void> {
    void state;
    await this.ensurePlanner();
  }

  async shutdown(reason: string, opts: { purge?: boolean } = {}): Promise<void> {
    this.appendDecisionLog({
      kind: 'terminate',
      actor: reason === 'phase_error_circuit' ? 'runner' : 'planner',
      payload: { reason },
    });
    // Best-effort cleanup. Stopping a non-existent session is a no-op.
    // keepPersisted: true keeps the persistedSessions entry on disk so a
    // later /autoloop/<id>/resume can re-attach the Planner's Claude
    // conversation. Only autoloopDelete passes purge:true (real teardown).
    for (const name of [this.plannerName, this.coderName, this.reviewerName]) {
      try {
        await this.config.manager.stopSession(name, { keepPersisted: !opts.purge });
      } catch (err) {
        this.logger.warn?.(`[autoloop] failed to stop ${name}: ${(err as Error).message}`);
      }
    }
  }

  async deliver(env: AnyAutoloopMessage): Promise<AnyAutoloopMessage[]> {
    switch (env.to) {
      case 'planner':
        return await this.deliverToPlanner(env);
      case 'coder':
        return await this.deliverToCoder(env);
      case 'reviewer':
        return await this.deliverToReviewer(env);
      default:
        throw new Error(`[autoloop] unexpected dispatcher target: ${env.to}`);
    }
  }

  private roleModel(role: AutoloopRoleName, selection: AutoloopRoleSelection): string | undefined {
    if (selection.model !== undefined) return selection.model;
    if (selection.engine !== 'claude') return undefined;
    return role === 'planner' ? 'opus' : 'sonnet';
  }

  private validateSelection(role: AutoloopRoleName, selection: AutoloopRoleSelection): void {
    const label = role[0].toUpperCase() + role.slice(1);
    if (!ENGINE_TYPES.includes(selection.engine)) {
      throw new Error(`${label} engine '${String(selection.engine)}' is not supported`);
    }
    if (selection.engine === 'custom' && !selection.customEngine) {
      throw new Error(`${label} custom engine config is required`);
    }
  }

  /**
   * Stop a session we started during a failed spawn. Returns true only when the
   * session is genuinely gone — the caller uses that to decide whether it may
   * clear the role's `started` flag. Returning false keeps the role marked as
   * started, which is the safe lie: a later engine change is then rejected
   * instead of silently binding the run to a process that never went away.
   */
  private async stopRolledBackSession(name: string): Promise<boolean> {
    try {
      await this.config.manager.stopSession(name);
      return true;
    } catch (stopErr) {
      this.logger.error?.(
        `[autoloop] rollback could not stop ${name}: ${(stopErr as Error).message} — ` +
          `leaving it marked started so a later engine change is rejected rather than silently ignored`,
      );
      this.appendDecisionLog({
        kind: 'phase_error',
        actor: 'dispatcher',
        payload: { agent: name, phase: 'rollback_stop', error: (stopErr as Error).message },
      });
      return false;
    }
  }

  /**
   * Does this engine carry conversation across sends on its own?
   *
   * claude keeps one subprocess alive; codex / codex-app resume a thread; agy
   * resumes a harvested `--conversation <uuid>`. Everything else (gemini,
   * cursor, opencode, and non-persistent custom engines) spawns a FRESH process
   * per send with zero memory of the last turn — for those the dispatcher must
   * replay the transcript in-band, or the role is amnesiac and a chat-driven
   * Planner can never remember the plan it just proposed (let alone whether the
   * user approved it).
   */
  private hasNativeConversation(selection: AutoloopRoleSelection): boolean {
    switch (selection.engine) {
      case 'claude':
      case 'codex':
      case 'codex-app':
      case 'agy':
        return true;
      case 'custom':
        // A persistent custom engine is a long-running stdin/stdout process, so
        // it keeps context the same way claude does. One-shot ones do not.
        return selection.customEngine?.persistent === true;
      default:
        return false;
    }
  }

  /**
   * Replayed transcript for engines without native conversation. Capped so a
   * long run can't grow the prompt without bound: we keep the most recent
   * turns within REPLAY_CHAR_BUDGET, oldest dropped first.
   */
  private transcripts: Record<AutoloopRoleName, Array<{ who: 'user' | 'agent'; text: string }>> = {
    planner: [],
    coder: [],
    reviewer: [],
  };

  private recordTurn(role: AutoloopRoleName, who: 'user' | 'agent', text: string): void {
    if (!text) return;
    const log = this.transcripts[role];
    log.push({ who, text });
    let budget = REPLAY_CHAR_BUDGET;
    let keepFrom = log.length;
    for (let i = log.length - 1; i >= 0; i--) {
      budget -= log[i].text.length;
      if (budget < 0) break;
      keepFrom = i;
    }
    if (keepFrom > 0) log.splice(0, keepFrom);
  }

  private renderHistory(role: AutoloopRoleName, selection: AutoloopRoleSelection): string | null {
    if (this.hasNativeConversation(selection)) return null;
    const log = this.transcripts[role];
    if (log.length === 0) return null;
    const lines = log.map((entry) => `<${entry.who}>\n${entry.text}\n</${entry.who}>`);
    return ['<conversation_history>', ...lines, '</conversation_history>'].join('\n');
  }

  private withRoleInstructions(
    role: AutoloopRoleName,
    selection: AutoloopRoleSelection,
    systemPrompt: string,
    message: string,
  ): string {
    if (selection.engine === 'claude') return message;
    const parts = ['<autoloop_role_instructions>', systemPrompt.trim(), '</autoloop_role_instructions>', ''];
    const history = this.renderHistory(role, selection);
    if (history) parts.push(history, '');
    parts.push('<autoloop_message>', message, '</autoloop_message>');
    return parts.join('\n');
  }

  /**
   * Start Coder + Reviewer sessions. Idempotent. Called in response to a
   * Planner spawn_subagents tool (the SessionManager wires this via
   * onSpawnSubagents).
   */
  async spawnSubagents(args: SpawnSubagentsArgs = {}): Promise<void> {
    const nextCoderEngine = args.coder_engine ?? this.coderSelection.engine;
    const nextReviewerEngine = args.reviewer_engine ?? this.reviewerSelection.engine;
    const nextCoder: AutoloopRoleSelection = {
      ...this.coderSelection,
      engine: nextCoderEngine,
      model:
        args.coder_model !== undefined
          ? args.coder_model
          : nextCoderEngine !== this.coderSelection.engine
            ? undefined
            : this.coderSelection.model,
    };
    const nextReviewer: AutoloopRoleSelection = {
      ...this.reviewerSelection,
      engine: nextReviewerEngine,
      model:
        args.reviewer_model !== undefined
          ? args.reviewer_model
          : nextReviewerEngine !== this.reviewerSelection.engine
            ? undefined
            : this.reviewerSelection.model,
    };
    this.validateSelection('coder', nextCoder);
    this.validateSelection('reviewer', nextReviewer);

    const coderChanged =
      nextCoder.engine !== this.coderSelection.engine ||
      this.roleModel('coder', nextCoder) !== this.roleModel('coder', this.coderSelection);
    const reviewerChanged =
      nextReviewer.engine !== this.reviewerSelection.engine ||
      this.roleModel('reviewer', nextReviewer) !== this.roleModel('reviewer', this.reviewerSelection);
    if (this.coderStarted && coderChanged) {
      throw new Error('Cannot change Coder engine or model after its session has started');
    }
    if (this.reviewerStarted && reviewerChanged) {
      throw new Error('Cannot change Reviewer engine or model after its session has started');
    }

    const previousCoder = this.coderSelection;
    const previousReviewer = this.reviewerSelection;
    const coderWasStarted = this.coderStarted;
    const reviewerWasStarted = this.reviewerStarted;
    this.coderSelection = nextCoder;
    this.reviewerSelection = nextReviewer;
    try {
      await this.ensureCoder();
      await this.ensureReviewer();
    } catch (err) {
      // Roll back only what THIS call started. Crucially, `<role>Started` may be
      // cleared only when the stop actually succeeded: SessionManager.startSession
      // returns the EXISTING session for a name that is still live and ignores the
      // new engine/model. So if we lied about the session being gone, the next
      // spawn_subagents would sail past the "engine cannot change after start"
      // guard, silently reuse the old engine's process, and still record the new
      // engine in decisions.jsonl and the registry — the exact divergence that
      // guard exists to prevent.
      if (!coderWasStarted && this.coderStarted) {
        this.coderStarted = !(await this.stopRolledBackSession(this.coderName));
      }
      if (!reviewerWasStarted && this.reviewerStarted) {
        this.reviewerStarted = !(await this.stopRolledBackSession(this.reviewerName));
      }
      this.coderSelection = previousCoder;
      this.reviewerSelection = previousReviewer;
      throw err;
    }
    const effectiveSelection = {
      coder: { engine: nextCoder.engine, model: nextCoder.model },
      reviewer: { engine: nextReviewer.engine, model: nextReviewer.model },
    };
    this.appendDecisionLog({
      kind: 'spawn_subagents',
      actor: 'planner',
      payload: {
        coder_engine: nextCoder.engine,
        coder_model: this.roleModel('coder', nextCoder),
        reviewer_engine: nextReviewer.engine,
        reviewer_model: this.roleModel('reviewer', nextReviewer),
      },
    });
    await this.config.onRoleSelectionChanged?.(effectiveSelection);
  }

  /**
   * Reset a single subagent — stop its session, clear the started flag, and
   * (optionally) eagerly start a fresh one. The session-level system prompt is
   * the same; persistent state lives in `<ledger>/{coder,reviewer}_memory.md`
   * which the agent reads on its first turn after reset.
   *
   * Refuses to reset Planner without `force: true` — Planner reset throws away
   * the user-conversation context and must be a deliberate action.
   */
  async resetAgent(
    agent: 'planner' | 'coder' | 'reviewer',
    opts: { force?: boolean; eagerRestart?: boolean } = {},
  ): Promise<void> {
    if (agent === 'planner' && !opts.force) {
      throw new Error('Refusing to reset Planner without force=true (would discard chat context)');
    }
    const name = agent === 'planner' ? this.plannerName : agent === 'coder' ? this.coderName : this.reviewerName;
    this.appendDecisionLog({
      kind: 'reset_agent',
      actor: 'dispatcher',
      payload: { agent, force: !!opts.force, eagerRestart: !!opts.eagerRestart },
    });
    try {
      await this.config.manager.stopSession(name);
    } catch (err) {
      this.logger.warn?.(`[autoloop] resetAgent stop failed for ${name}: ${(err as Error).message}`);
    }
    if (agent === 'planner') this.plannerStarted = false;
    if (agent === 'coder') this.coderStarted = false;
    if (agent === 'reviewer') {
      this.reviewerStarted = false;
      this.reviewerSessionPrompt = null;
    }
    if (opts.eagerRestart) {
      if (agent === 'planner') await this.ensurePlanner();
      else if (agent === 'coder') await this.ensureCoder();
      else await this.ensureReviewer();
    }
  }

  /**
   * Wrap a subagent send. If the underlying session throws or returns an
   * error string, auto-reset the subagent once and retry. Used by
   * deliverToCoder / deliverToReviewer to recover from subprocess deaths.
   */
  private async sendWithRecovery(
    agent: 'coder' | 'reviewer',
    name: string,
    promptText: string,
  ): Promise<SendMessageResult> {
    try {
      return (await this.config.manager.sendMessage(name, promptText, {
        timeout: this.config.sendTimeoutMs ?? 10 * 60_000,
      })) as SendMessageResult;
    } catch (err) {
      this.logger.warn?.(`[autoloop] ${agent} send threw, attempting reset+retry: ${(err as Error).message}`);
      await this.resetAgent(agent, { eagerRestart: true });
      // Let the freshly-restarted subprocess settle before retrying — an
      // immediate retry routinely hits the same transient failure (e.g. the
      // old socket still in TIME_WAIT → ECONNREFUSED). Small jitter avoids
      // lockstep retries across concurrent runs.
      await new Promise((r) => setTimeout(r, 500 + Math.floor(Math.random() * 250)));
      try {
        return (await this.config.manager.sendMessage(name, promptText, {
          timeout: this.config.sendTimeoutMs ?? 10 * 60_000,
        })) as SendMessageResult;
      } catch (err2) {
        this.logger.error?.(`[autoloop] ${agent} second attempt failed after reset: ${(err2 as Error).message}`);
        return { output: '', error: (err2 as Error).message, fatal: true };
      }
    }
  }

  /**
   * Append a structured audit row to `<ledger>/decisions.jsonl`. Best-effort:
   * any I/O failure is logged but never thrown. Captures terminate, reset,
   * push-policy mutations, compact triggers, subagent spawns, phase-error
   * passes, and policy-silence attempts that we rejected.
   */
  private appendDecisionLog(entry: Omit<DecisionLogEntry, 'ts'>): void {
    try {
      fs.mkdirSync(this.ledgerDir, { recursive: true });
      const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n';
      fs.appendFileSync(path.join(this.ledgerDir, 'decisions.jsonl'), line);
    } catch (err) {
      this.logger.warn?.(`[autoloop] decisions.jsonl append failed: ${(err as Error).message}`);
    }
  }

  /**
   * Append a Planner-pane chat entry to <ledger>/chat.jsonl. Used by the
   * dashboard's GET /autoloop/<id>/chat_history endpoint so a browser
   * refresh / cross-process / re-opening a terminated run can replay the
   * conversation instead of starting visibly blank.
   */
  private appendChatEntry(entry: {
    who: 'user' | 'planner' | 'coder' | 'reviewer' | 'system';
    text: string;
    ts: string;
  }): void {
    try {
      fs.mkdirSync(this.ledgerDir, { recursive: true });
      fs.appendFileSync(path.join(this.ledgerDir, 'chat.jsonl'), JSON.stringify(entry) + '\n');
    } catch (err) {
      this.logger.warn?.(`[autoloop] chat.jsonl append failed: ${(err as Error).message}`);
    }
  }

  // ─── Auto-compact ────────────────────────────────────────────────────────
  //
  // After each agent turn we check getStats().contextPercent. When it crosses
  // the per-agent threshold we send `/compact <hint>` to ask Claude Code to
  // drop chunks of history while preserving what each role needs to keep
  // working. /compact preserves the session id — no reset, no memory-file
  // dance, no reprime — so this is cheap.
  //
  // We track lastCompactAt per agent to avoid re-firing within 30 s in case
  // the immediate post-compact stats haven't refreshed yet.

  private lastCompactAt: Partial<Record<'planner' | 'coder' | 'reviewer', number>> = {};

  private compactSummaryFor(agent: 'planner' | 'coder' | 'reviewer'): string {
    if (agent === 'planner') {
      return [
        'Preserve: current plan.md state and goal.json criteria; what the user has asked',
        "for and approved; what directions have been tried and rejected; the user's style",
        'preferences for this run; iter-by-iter Reviewer verdicts. Drop: verbose tool',
        'output, intermediate file dumps, redundant context.',
      ].join(' ');
    }
    if (agent === 'coder') {
      return [
        'Preserve: codebase familiarity (what files do what), what patches you have already',
        'tried and why they failed, what is currently working, the current plan and goal.',
        'Drop: full file dumps, verbose stack traces, intermediate eval output beyond the',
        'last few iters.',
      ].join(' ');
    }
    return [
      'Preserve: patterns of fakery you have caught (in reviewer_memory.md), recent metric',
      'history, structural rules from goal.json, your accumulating model of what cheating',
      'looks like in this codebase. Drop: full diff dumps from older iters, verbose audit',
      'transcripts beyond the last few iters.',
    ].join(' ');
  }

  private async maybeCompact(agent: 'planner' | 'coder' | 'reviewer', name: string): Promise<void> {
    const cfg = this.config.compactThresholds ?? {};
    const threshold =
      agent === 'planner' ? (cfg.planner ?? 80) : agent === 'coder' ? (cfg.coder ?? 70) : (cfg.reviewer ?? 70);
    let pct: number | undefined;
    try {
      const stats = this.config.manager.getStatus(name).stats;
      pct = stats.contextPercent;
    } catch {
      // Session might be gone (terminate races); silent skip.
      return;
    }
    if (pct == null || pct < threshold) return;
    const last = this.lastCompactAt[agent] ?? 0;
    if (Date.now() - last < 30_000) return;
    this.lastCompactAt[agent] = Date.now();
    this.logger.info?.(
      `[autoloop/${this.config.runId}] ${agent} context ${pct.toFixed(0)}% ≥ ${threshold}% — auto-compact`,
    );
    this.emit('compact', { agent, percent: pct, threshold });
    this.appendDecisionLog({
      kind: 'compact',
      actor: 'dispatcher',
      payload: { agent, percent: pct, threshold },
    });
    try {
      await this.config.manager.compactSession(name, this.compactSummaryFor(agent));
    } catch (err) {
      this.logger.warn?.(`[autoloop/${this.config.runId}] compact ${agent} failed: ${(err as Error).message}`);
    }
  }

  // ─── Planner-specific ────────────────────────────────────────────────────

  private async ensurePlanner(): Promise<void> {
    if (this.plannerStarted) return;
    this.validateSelection('planner', this.plannerSelection);
    await this.config.manager.startSession({
      name: this.plannerName,
      cwd: this.config.workspace,
      engine: this.plannerSelection.engine,
      model: this.roleModel('planner', this.plannerSelection),
      customEngine: this.plannerSelection.engine === 'custom' ? this.plannerSelection.customEngine : undefined,
      permissionMode: this.plannerSelection.engine === 'claude' ? 'bypassPermissions' : 'manual',
      sandboxMode: this.plannerSelection.engine === 'claude' ? undefined : 'read-only',
      systemPrompt: this.plannerSystemPrompt,
      // Hard role boundary: Planner must NEVER author content files itself.
      // Its only writes are plan.md / goal.json via the write_plan /
      // write_goal autoloop tools. Disallowing the editing tools here is
      // the load-bearing enforcement — prompt rules alone proved
      // insufficient (the model would happily produce user-requested
      // deliverables directly). Read/Glob/Grep/Bash stay enabled so
      // Planner can still discover, audit, and `git status` the workspace.
      disallowedTools: ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'],
    });
    this.plannerStarted = true;
  }

  private async deliverToPlanner(env: AnyAutoloopMessage): Promise<AnyAutoloopMessage[]> {
    if (env.type !== 'chat' && env.type !== 'directive_ack' && env.type !== 'iter_done') {
      // Other types (push_user / pause / resume / terminate) are runner-only
      // or planner-emitted; they should never arrive *to* planner.
      throw new Error(`[autoloop] planner does not accept message type=${env.type}`);
    }

    await this.ensurePlanner();

    // Compose the prompt fed into the Planner session. For S2 we only handle
    // user chat; iter_done / directive_ack are wired in S4.
    let promptText: string;
    if (env.type === 'chat') {
      promptText = env.payload.text;
      // Persist user message so the dashboard can replay history after
      // refresh / cross-process / terminated-run reopen.
      this.appendChatEntry({ who: 'user', text: env.payload.text, ts: env.ts });
    } else if (env.type === 'directive_ack') {
      promptText = `[system] coder directive_ack iter=${env.iter}: ${JSON.stringify(env.payload)}`;
    } else {
      // iter_done
      promptText = `[system] iter ${env.iter} done. verdict=${env.payload.verdict} metric=${env.payload.metric}`;
    }

    const result = (await this.config.manager.sendMessage(
      this.plannerName,
      this.withRoleInstructions('planner', this.plannerSelection, this.plannerSystemPrompt, promptText),
      {
        timeout: this.config.sendTimeoutMs ?? 10 * 60_000,
      },
    )) as SendMessageResult;

    if (result.error) {
      this.logger.error?.(`[autoloop] planner send error: ${result.error}`);
      this.emit('planner_error', new Error(result.error));
    }

    const replyText = (result.output ?? '').trim();

    // Feed the transcript that engines without native conversation replay next
    // turn. Recorded AFTER the send so the current message isn't duplicated in
    // its own history block.
    this.recordTurn('planner', 'user', promptText);
    this.recordTurn('planner', 'agent', replyText);

    // S3: parse autoloop-fenced tool calls out of the reply, apply effects,
    // and bubble emitted messages back into the runner queue.
    const parsed = parsePlannerReply(replyText);
    if (parsed.parse_errors.length > 0) {
      this.logger.warn?.(`[autoloop] planner emitted ${parsed.parse_errors.length} malformed autoloop block(s)`);
    }
    const effects: PlannerToolEffects = {
      spawnSubagents: async (args) => {
        if (this.config.onSpawnSubagents) {
          await this.config.onSpawnSubagents(args);
        } else {
          this.logger.warn?.('[autoloop] spawn_subagents called but no handler is installed');
        }
      },
      updatePushPolicy: (delta) => {
        if (!this.config.pushPolicyRef) return;
        // Shallow-merge whitelisted keys onto the policy object.
        const policyKeys = new Set([
          'on_start',
          'on_iter_done_ok',
          'on_target_hit',
          'on_metric_regression_2',
          'on_reviewer_reject_2',
          'on_phase_error',
          'on_stall_30min',
          'on_decision_needed',
        ]);
        const applied: Record<string, unknown> = {};
        const silenced_blocked: string[] = [];
        const VALID_LEVELS = new Set(['info', 'warn', 'decision', 'error']);
        const VALID_CHANNELS = new Set(['auto', 'wechat', 'webchat', 'both', 'email']);
        for (const [k, v] of Object.entries(delta)) {
          if (!policyKeys.has(k) || typeof v !== 'object' || v === null) continue;
          // Only accept known, correctly-typed fields — a malformed rule
          // (wrong types, bogus level/channel) must not enter the live policy.
          const raw = v as Record<string, unknown>;
          const rule: Record<string, unknown> = {};
          if (typeof raw.silent === 'boolean') rule.silent = raw.silent;
          if (typeof raw.level === 'string' && VALID_LEVELS.has(raw.level)) rule.level = raw.level;
          if (typeof raw.channel === 'string' && VALID_CHANNELS.has(raw.channel)) rule.channel = raw.channel;
          // B2: refuse to silence the channels that surface phase errors and
          // user decisions. Other fields on the same rule still apply, so the
          // operator can re-target level/channel without going dark.
          if (UNSILENCEABLE_POLICY_KEYS.has(k) && rule.silent === true) {
            silenced_blocked.push(k);
            this.logger.warn?.(`[autoloop] refused to set silent=true on critical policy key ${k}`);
            delete rule.silent;
          }
          (this.config.pushPolicyRef as unknown as Record<string, unknown>)[k] = rule;
          applied[k] = rule;
        }
        if (silenced_blocked.length > 0) {
          this.appendDecisionLog({
            kind: 'policy_silence_blocked',
            actor: 'planner',
            payload: { keys: silenced_blocked },
          });
        }
        if (Object.keys(applied).length > 0) {
          this.appendDecisionLog({
            kind: 'update_push_policy',
            actor: 'planner',
            payload: { applied },
          });
        }
      },
      writePlanFile: async (file, content, commitMessage) => {
        // Author plan.md / goal.json on the Planner's behalf. The Planner
        // can't Write/Edit directly (disallowedTools), so this autoloop tool
        // is the single legitimate authoring path. Best-effort git commit
        // keeps the ledger honest.
        const target = path.join(this.config.workspace, file);
        fs.writeFileSync(target, content);
        await this.gitCommit(file, commitMessage ?? `autoloop: planner writes ${file}`);
      },
    };
    // After iter_done(N) the run has advanced to iter N+1 in runner state;
    // any directive Planner emits in response targets the new iter.
    const nextIter = env.type === 'iter_done' ? env.iter + 1 : env.iter;
    const handlerResult = await applyPlannerToolCalls(parsed.calls, effects, nextIter);
    for (const errEntry of handlerResult.errors) {
      this.logger.warn?.(`[autoloop] tool '${errEntry.tool}' failed: ${errEntry.error}`);
    }

    // Emit cleaned reply (without raw JSON blocks) for the chat tool to surface.
    if (parsed.cleaned_reply) {
      this.emit('planner_reply', parsed.cleaned_reply);
      this.appendChatEntry({ who: 'planner', text: parsed.cleaned_reply, ts: new Date().toISOString() });
    }
    // Auto-compact after each Planner turn if context is filling up.
    await this.maybeCompact('planner', this.plannerName);
    return handlerResult.emitted_messages;
  }

  // ─── Coder ──────────────────────────────────────────────────────────────

  private async ensureCoder(): Promise<void> {
    if (this.coderStarted) return;
    this.validateSelection('coder', this.coderSelection);
    await this.config.manager.startSession({
      name: this.coderName,
      cwd: this.config.workspace,
      engine: this.coderSelection.engine,
      model: this.roleModel('coder', this.coderSelection),
      customEngine: this.coderSelection.engine === 'custom' ? this.coderSelection.customEngine : undefined,
      permissionMode: 'bypassPermissions',
      systemPrompt: this.coderSystemPrompt,
    });
    this.coderStarted = true;
  }

  private async deliverToCoder(env: AnyAutoloopMessage): Promise<AnyAutoloopMessage[]> {
    if (env.type !== 'directive') {
      throw new Error(`[autoloop] coder does not accept message type=${env.type}`);
    }
    await this.ensureCoder();

    // Compose directive prompt + write directive.json to ledger so Reviewer
    // and history can see exactly what the Coder was asked.
    const iterDir = path.join(this.ledgerDir, 'iter', String(env.iter));
    fs.mkdirSync(iterDir, { recursive: true });
    fs.writeFileSync(
      path.join(iterDir, 'directive.json'),
      JSON.stringify(
        {
          schema_version: LEDGER_SCHEMA_VERSION,
          iter: env.iter,
          ts: env.ts,
          ...env.payload,
        },
        null,
        2,
      ),
    );

    // Defensive: Planner may emit constraints / success_criteria as either
    // a string or a string[]. Normalise.
    const constraints: string[] = Array.isArray(env.payload.constraints)
      ? env.payload.constraints.map(String)
      : env.payload.constraints
        ? [String(env.payload.constraints)]
        : [];
    const success: string[] = Array.isArray(env.payload.success_criteria)
      ? env.payload.success_criteria.map(String)
      : env.payload.success_criteria
        ? [String(env.payload.success_criteria)]
        : [];

    const promptText = [
      `[directive iter=${env.iter}]`,
      `goal: ${env.payload.goal}`,
      constraints.length ? `constraints:\n  - ${constraints.join('\n  - ')}` : '',
      success.length ? `success_criteria:\n  - ${success.join('\n  - ')}` : '',
      `max_attempts: ${env.payload.max_attempts}`,
      '',
      'Read plan.md / goal.json, make the change, run the evaluator, then emit `iter_complete`.',
    ]
      .filter(Boolean)
      .join('\n');

    // Heartbeat so the dashboard's Coder pane shows "iter N started" even
    // before Coder produces a reply — useful for liveness checks on long
    // turns, and survives refresh because it's in chat.jsonl.
    this.appendChatEntry({
      who: 'coder',
      text: `🔨 Coder iter ${env.iter} working…`,
      ts: new Date().toISOString(),
    });

    const result = await this.sendWithRecovery(
      'coder',
      this.coderName,
      this.withRoleInstructions('coder', this.coderSelection, this.coderSystemPrompt, promptText),
    );
    this.recordTurn('coder', 'user', promptText);
    this.recordTurn('coder', 'agent', (result.output ?? '').trim());
    // A3: subprocess died (recovery retry exhausted). Surface as phase_error
    // rather than silently masquerading as a "clarification request"; the
    // runner's circuit breaker can then trip after enough consecutive failures.
    if (result.fatal) {
      this.appendDecisionLog({
        kind: 'phase_error',
        actor: 'dispatcher',
        payload: { agent: 'coder', phase: 'send', error: result.error ?? 'unknown' },
      });
      return [
        Msg.phaseError(env.iter, {
          agent: 'coder',
          phase: 'send',
          error: result.error ?? 'unknown send failure',
        }),
      ];
    }
    const replyText = (result.output ?? '').trim();
    const parsed = parseAgentReply(replyText);
    this.emit('coder_reply', parsed.cleaned_reply);
    if (parsed.cleaned_reply) {
      this.appendChatEntry({
        who: 'coder',
        text: parsed.cleaned_reply,
        ts: new Date().toISOString(),
      });
    }

    const ic = extractIterComplete(parsed.calls);
    if (!ic) {
      // No iter_complete emitted — could be a clarification request. Return a
      // directive_ack so Planner sees it next turn.
      await this.maybeCompact('coder', this.coderName);
      return [
        Msg.directiveAck(env.iter, {
          understood: false,
          clarification: parsed.cleaned_reply.slice(0, 500),
        }),
      ];
    }

    // Persist eval output to ledger.
    fs.writeFileSync(
      path.join(iterDir, 'eval_output.json'),
      JSON.stringify({ schema_version: LEDGER_SCHEMA_VERSION, iter: env.iter, eval_output: ic.eval_output }, null, 2),
    );
    fs.writeFileSync(
      path.join(iterDir, 'coder_summary.txt'),
      `${ic.summary}\n\n--- coder cleaned reply ---\n${parsed.cleaned_reply}\n`,
    );

    // Compute diff + files_changed via git so we don't trust Coder's claim.
    const diffOut = await this.runGit(['git', 'diff', '--unified=3']);
    fs.writeFileSync(path.join(iterDir, 'diff.patch'), diffOut.out);
    let filesChanged = ic.files_changed;
    if (!filesChanged) {
      const named = await this.runGit(['git', 'diff', '--name-only']);
      filesChanged = named.out
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
    }
    // Commit the iteration so Reviewer's git view is clean for the next iter.
    await this.runGit(['git', 'add', '-A']);
    const commitMsg = `autoloop/iter-${env.iter}: ${ic.summary}`.slice(0, 200);
    const commitRes = await this.runGit(['git', 'commit', '-m', commitMsg]);
    // A6: a non-"nothing to commit" failure (hook reject, signing missing,
    // index lock) means the next iter's diff would be wrong. Bail to runner.
    if (commitRes.code !== 0 && !/nothing to commit/i.test(commitRes.out + commitRes.err)) {
      this.appendDecisionLog({
        kind: 'phase_error',
        actor: 'dispatcher',
        payload: { agent: 'coder', phase: 'git_commit', error: commitRes.err.slice(0, 500) },
      });
      return [
        Msg.phaseError(env.iter, {
          agent: 'coder',
          phase: 'git_commit',
          error: `git commit failed (code=${commitRes.code}): ${commitRes.err.slice(0, 300)}`,
        }),
      ];
    }

    await this.maybeCompact('coder', this.coderName);
    return [
      Msg.iterArtifacts(env.iter, {
        diff: diffOut.out,
        eval_output: ic.eval_output,
        files_changed: filesChanged,
      }),
    ];
  }

  // ─── Reviewer ───────────────────────────────────────────────────────────

  /**
   * Compose the Reviewer's system prompt with a frozen snapshot of
   * `reviewer_memory.md` appended. Read once at session start; mid-session
   * edits to the file do NOT take effect until the next Reviewer reset. This
   * keeps the per-iter prompt prefix stable so Claude's prefix cache hits.
   */
  private buildReviewerSystemPrompt(): string {
    const memoryPath = path.join(this.reviewerSandboxDir, 'reviewer_memory.md');
    let memory = '';
    try {
      if (fs.existsSync(memoryPath)) {
        memory = fs.readFileSync(memoryPath, 'utf-8').trim();
      }
    } catch (err) {
      this.logger.warn?.(`[autoloop] failed to read reviewer_memory.md: ${(err as Error).message}`);
    }
    if (!memory) return this.reviewerSystemPrompt;
    return [
      this.reviewerSystemPrompt.trimEnd(),
      '',
      '<frozen_memory_snapshot>',
      memory,
      '</frozen_memory_snapshot>',
      '',
      'The snapshot above was injected into your system prompt at session start',
      'and is frozen for this Reviewer session. Append new fakery patterns or',
      'observations to reviewer_memory.md on disk; they will be re-injected on',
      'the next Reviewer reset, not mid-session.',
    ].join('\n');
  }

  private async ensureReviewer(): Promise<void> {
    if (this.reviewerStarted) return;
    this.validateSelection('reviewer', this.reviewerSelection);
    fs.mkdirSync(this.reviewerSandboxDir, { recursive: true });
    const sessionPrompt = this.buildReviewerSystemPrompt();
    this.reviewerSessionPrompt = sessionPrompt;
    try {
      await this.config.manager.startSession({
        name: this.reviewerName,
        cwd: this.reviewerSandboxDir,
        engine: this.reviewerSelection.engine,
        model: this.roleModel('reviewer', this.reviewerSelection),
        customEngine: this.reviewerSelection.engine === 'custom' ? this.reviewerSelection.customEngine : undefined,
        permissionMode: 'bypassPermissions',
        systemPrompt: sessionPrompt,
      });
      this.reviewerStarted = true;
    } catch (err) {
      this.reviewerSessionPrompt = null;
      throw err;
    }
  }

  /**
   * Stage the iter's artifacts into the Reviewer sandbox cwd. Reviewer is a
   * persistent session whose cwd is fixed at <ledger>/reviewer_sandbox/, so
   * every review must rewrite the sandbox to "this iter's view".
   */
  private stageReviewSandbox(iter: number): void {
    fs.mkdirSync(this.reviewerSandboxDir, { recursive: true });
    // Wipe top-level files but preserve the Reviewer's cross-iter memory and
    // append-only audit log (see REVIEWER_SANDBOX_PERSIST). The Reviewer prompt
    // promises both survive across iters; the wipe used to break the log.
    for (const ent of fs.readdirSync(this.reviewerSandboxDir)) {
      if (REVIEWER_SANDBOX_PERSIST.has(ent)) continue;
      const full = path.join(this.reviewerSandboxDir, ent);
      try {
        fs.rmSync(full, { recursive: true, force: true });
      } catch (err) {
        // A stale file the Reviewer then reads as "this iter" causes silent
        // context corruption — surface anything that isn't an already-gone file.
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          this.logger.warn?.(`[autoloop] failed to clear sandbox entry ${ent}: ${(err as Error).message}`);
        }
      }
    }
    const iterSrc = path.join(this.ledgerDir, 'iter', String(iter));
    if (!fs.existsSync(iterSrc)) return;
    const dest = path.join(this.reviewerSandboxDir, `iter-${iter}`);
    fs.mkdirSync(dest, { recursive: true });
    for (const ent of fs.readdirSync(iterSrc)) {
      fs.copyFileSync(path.join(iterSrc, ent), path.join(dest, ent));
    }
    // Also surface goal.json + plan.md if they exist at the workspace root.
    for (const f of ['plan.md', 'goal.json']) {
      const src = path.join(this.config.workspace, f);
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(this.reviewerSandboxDir, f));
    }
    // Last iter's verdict for context (if exists).
    if (iter > 0) {
      const prior = path.join(this.ledgerDir, 'iter', String(iter - 1), 'verdict.json');
      if (fs.existsSync(prior)) {
        fs.copyFileSync(prior, path.join(this.reviewerSandboxDir, 'prior_verdict.json'));
      }
    }
  }

  private async deliverToReviewer(env: AnyAutoloopMessage): Promise<AnyAutoloopMessage[]> {
    if (env.type !== 'review_request') {
      throw new Error(`[autoloop] reviewer does not accept message type=${env.type}`);
    }
    await this.ensureReviewer();
    this.stageReviewSandbox(env.payload.iter);

    const promptText = [
      `[review_request iter=${env.payload.iter}]`,
      `Artifacts staged at: iter-${env.payload.iter}/ (directive.json, diff.patch, eval_output.json)`,
      `prior_verdict: ${fs.existsSync(path.join(this.reviewerSandboxDir, 'prior_verdict.json')) ? 'prior_verdict.json' : '(none)'}`,
      `prior_metrics: ${JSON.stringify(env.payload.prior_metrics ?? [])}`,
      '',
      'Audit and emit `review_complete`.',
    ].join('\n');

    // Heartbeat so the dashboard's Reviewer pane shows "auditing" the moment
    // a review_request lands, instead of staying blank until the verdict.
    this.appendChatEntry({
      who: 'reviewer',
      text: `🔍 Reviewer iter ${env.payload.iter} auditing…`,
      ts: new Date().toISOString(),
    });

    const result = await this.sendWithRecovery(
      'reviewer',
      this.reviewerName,
      this.withRoleInstructions(
        'reviewer',
        this.reviewerSelection,
        this.reviewerSessionPrompt ?? this.reviewerSystemPrompt,
        promptText,
      ),
    );
    this.recordTurn('reviewer', 'user', promptText);
    this.recordTurn('reviewer', 'agent', (result.output ?? '').trim());
    if (result.fatal) {
      this.appendDecisionLog({
        kind: 'phase_error',
        actor: 'dispatcher',
        payload: { agent: 'reviewer', phase: 'send', error: result.error ?? 'unknown' },
      });
      return [
        Msg.phaseError(env.payload.iter, {
          agent: 'reviewer',
          phase: 'send',
          error: result.error ?? 'unknown send failure',
        }),
      ];
    }
    const replyText = (result.output ?? '').trim();
    const parsed = parseAgentReply(replyText);
    this.emit('reviewer_reply', parsed.cleaned_reply);
    if (parsed.cleaned_reply) {
      this.appendChatEntry({
        who: 'reviewer',
        text: parsed.cleaned_reply,
        ts: new Date().toISOString(),
      });
    }

    const rc = extractReviewComplete(parsed.calls);
    if (!rc) {
      // Reviewer didn't emit a verdict — treat as 'hold' with the cleaned
      // reply as audit notes so the loop doesn't stall silently.
      const verdict = Msg.reviewVerdict(env.payload.iter, {
        decision: 'hold',
        metric: null,
        audit_notes: `[no verdict emitted] ${parsed.cleaned_reply.slice(0, 500)}`,
      });
      this.persistVerdict(env.payload.iter, {
        decision: 'hold',
        metric: null,
        audit_notes: verdict.payload.audit_notes,
      });
      await this.maybeCompact('reviewer', this.reviewerName);
      return [verdict];
    }

    this.persistVerdict(env.payload.iter, rc);
    await this.maybeCompact('reviewer', this.reviewerName);
    return [Msg.reviewVerdict(env.payload.iter, rc)];
  }

  private persistVerdict(
    iter: number,
    payload: { decision: string; metric: number | null; audit_notes: string },
  ): void {
    const iterDir = path.join(this.ledgerDir, 'iter', String(iter));
    fs.mkdirSync(iterDir, { recursive: true });
    fs.writeFileSync(
      path.join(iterDir, 'verdict.json'),
      JSON.stringify(
        { schema_version: LEDGER_SCHEMA_VERSION, iter, ts: new Date().toISOString(), ...payload },
        null,
        2,
      ),
    );
  }

  /** Run a git command in the workspace; returns combined output. Used by Coder commits. */
  private async runGit(argv: string[]): Promise<{ code: number; out: string; err: string }> {
    return new Promise((resolve) => {
      const child = spawn(argv[0], argv.slice(1), {
        cwd: this.config.workspace,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      let err = '';
      child.stdout?.on('data', (b) => (out += b.toString()));
      child.stderr?.on('data', (b) => (err += b.toString()));
      child.on('error', (e) => resolve({ code: 127, out: '', err: (e as Error).message }));
      child.on('exit', (code) => resolve({ code: code ?? 0, out, err }));
    });
  }

  // ─── git helper for write_plan_committed / write_goal_committed ──────────

  private async gitCommit(filename: string, message: string): Promise<void> {
    const run = (argv: string[]): Promise<{ code: number; out: string; err: string }> =>
      new Promise((resolve) => {
        const child = spawn(argv[0], argv.slice(1), {
          cwd: this.config.workspace,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let out = '';
        let err = '';
        child.stdout?.on('data', (b) => (out += b.toString()));
        child.stderr?.on('data', (b) => (err += b.toString()));
        child.on('error', (e) => resolve({ code: 127, out: '', err: (e as Error).message }));
        child.on('exit', (code) => resolve({ code: code ?? 0, out, err }));
      });

    // Allow either a workspace-rooted plan.md or one inside tasks/<run_id>/.
    // We don't know which; best-effort `git add -A` keeps it simple and the
    // commit message captures the intent. Empty diff → skip (no error).
    const status = await run(['git', 'status', '--porcelain']);
    if (status.code !== 0) {
      this.logger.warn?.(`[autoloop] git status failed: ${status.err.slice(0, 200)}`);
      return;
    }
    if (status.out.trim() === '') {
      this.logger.info?.(`[autoloop] commit_${filename}: no changes to commit`);
      return;
    }
    await run(['git', 'add', '-A']);
    const commit = await run(['git', 'commit', '-m', message]);
    if (commit.code !== 0) {
      const detail = commit.err.slice(0, 200);
      // Surface, don't just log: a silent commit failure leaves the file on disk
      // but uncommitted, so the next Coder iter sees inconsistent git state.
      this.logger.error?.(`[autoloop] git commit failed for ${filename}: ${detail}`);
      this.emit('planner_error', new Error(`git commit failed for ${filename}: ${detail}`));
    }
  }
}
