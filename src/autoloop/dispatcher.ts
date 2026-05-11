/**
 * ClaudeAgentDispatcher — wires the v2 runner to real persistent Claude
 * sessions managed by SessionManager.
 *
 * S2 scope: Planner only (chat-mode, no subagents yet). Coder/Reviewer
 * delivery throws — S4 wires them in.
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
import { nullLogger } from '../logger.js';
import { spawn } from 'node:child_process';
import { type AnyAutoloopMessage, Msg } from './messages.js';
import { LEDGER_SCHEMA_VERSION, type AgentDispatcher, type AutoloopState, type PushPolicy } from './types.js';
import {
  applyPlannerToolCalls,
  parsePlannerReply,
  type PlannerToolEffects,
  type SpawnSubagentsArgs,
} from './planner-tools.js';
import { extractIterComplete, extractReviewComplete, parseAgentReply } from './agent-tools.js';

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
  /** Model alias for Planner (default: 'opus'). */
  plannerModel?: string;
  /** Default Coder model (default: 'sonnet'). Can be overridden per spawn_subagents call. */
  coderModel?: string;
  /** Default Reviewer model (default: 'sonnet'). */
  reviewerModel?: string;
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
  private coderModel: string;
  private reviewerModel: string;
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
    this.coderModel = config.coderModel ?? 'sonnet';
    this.reviewerModel = config.reviewerModel ?? 'sonnet';
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

  async shutdown(reason: string): Promise<void> {
    this.appendDecisionLog({
      kind: 'terminate',
      actor: reason === 'phase_error_circuit' ? 'runner' : 'planner',
      payload: { reason },
    });
    // Best-effort cleanup. Stopping a non-existent session is a no-op.
    for (const name of [this.plannerName, this.coderName, this.reviewerName]) {
      try {
        await this.config.manager.stopSession(name);
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

  /**
   * Start Coder + Reviewer sessions. Idempotent. Called in response to a
   * Planner spawn_subagents tool (the SessionManager wires this via
   * onSpawnSubagents).
   */
  async spawnSubagents(args: SpawnSubagentsArgs = {}): Promise<void> {
    if (args.coder_model) this.coderModel = args.coder_model;
    if (args.reviewer_model) this.reviewerModel = args.reviewer_model;
    await this.ensureCoder();
    await this.ensureReviewer();
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
    if (agent === 'reviewer') this.reviewerStarted = false;
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
    await this.config.manager.startSession({
      name: this.plannerName,
      cwd: this.config.workspace,
      engine: 'claude',
      model: this.config.plannerModel ?? 'opus',
      permissionMode: 'bypassPermissions',
      systemPrompt: this.plannerSystemPrompt,
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
    } else if (env.type === 'directive_ack') {
      promptText = `[system] coder directive_ack iter=${env.iter}: ${JSON.stringify(env.payload)}`;
    } else {
      // iter_done
      promptText = `[system] iter ${env.iter} done. verdict=${env.payload.verdict} metric=${env.payload.metric}`;
    }

    const result = (await this.config.manager.sendMessage(this.plannerName, promptText, {
      timeout: this.config.sendTimeoutMs ?? 10 * 60_000,
    })) as SendMessageResult;

    if (result.error) {
      this.logger.error?.(`[autoloop] planner send error: ${result.error}`);
      this.emit('planner_error', new Error(result.error));
    }

    const replyText = (result.output ?? '').trim();

    // S3: parse autoloop-fenced tool calls out of the reply, apply effects,
    // and bubble emitted messages back into the runner queue.
    const parsed = parsePlannerReply(replyText);
    if (parsed.parse_errors.length > 0) {
      this.logger.warn?.(`[autoloop] planner emitted ${parsed.parse_errors.length} malformed autoloop block(s)`);
    }
    const effects: PlannerToolEffects = {
      spawnSubagents: async (args) => {
        this.appendDecisionLog({
          kind: 'spawn_subagents',
          actor: 'planner',
          payload: { args },
        });
        if (this.config.onSpawnSubagents) {
          await this.config.onSpawnSubagents(args);
        } else {
          this.logger.warn?.('[autoloop] spawn_subagents called but no handler installed (S4 not wired yet)');
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
        for (const [k, v] of Object.entries(delta)) {
          if (!policyKeys.has(k) || typeof v !== 'object' || v === null) continue;
          // B2: refuse to silence the channels that surface phase errors and
          // user decisions. Other fields on the same rule still apply, so the
          // operator can re-target level/channel without going dark.
          const rule = { ...(v as Record<string, unknown>) };
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
      commitPlanFile: async (file, message) => {
        await this.gitCommit(file, message ?? `autoloop: planner commits ${file}`);
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
    if (parsed.cleaned_reply) this.emit('planner_reply', parsed.cleaned_reply);
    // Auto-compact after each Planner turn if context is filling up.
    await this.maybeCompact('planner', this.plannerName);
    return handlerResult.emitted_messages;
  }

  // ─── Coder ──────────────────────────────────────────────────────────────

  private async ensureCoder(): Promise<void> {
    if (this.coderStarted) return;
    await this.config.manager.startSession({
      name: this.coderName,
      cwd: this.config.workspace,
      engine: 'claude',
      model: this.coderModel,
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

    const result = await this.sendWithRecovery('coder', this.coderName, promptText);
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
    fs.mkdirSync(this.reviewerSandboxDir, { recursive: true });
    await this.config.manager.startSession({
      name: this.reviewerName,
      cwd: this.reviewerSandboxDir,
      engine: 'claude',
      model: this.reviewerModel,
      permissionMode: 'bypassPermissions',
      systemPrompt: this.buildReviewerSystemPrompt(),
    });
    this.reviewerStarted = true;
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
      } catch {
        /* ignore */
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

    const result = await this.sendWithRecovery('reviewer', this.reviewerName, promptText);
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
      this.logger.warn?.(`[autoloop] git commit failed: ${commit.err.slice(0, 200)}`);
    }
  }
}
