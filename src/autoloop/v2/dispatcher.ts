/**
 * ClaudeAgentDispatcher — wires the v2 runner to real persistent Claude
 * sessions managed by SessionManager.
 *
 * S2 scope: Planner only (chat-mode, no subagents yet). Coder/Reviewer
 * delivery throws — S4 wires them in.
 *
 * Naming convention:
 *   autoloop-v2-<run_id>-planner
 *   autoloop-v2-<run_id>-coder      (S4)
 *   autoloop-v2-<run_id>-reviewer   (S4)
 *
 * Reply path:
 *   When the user chats, we sendMessage(planner, text) and capture the
 *   Planner's natural-language reply. The reply is *not* a v2 message —
 *   it is emitted as the dispatcher's own 'planner_reply' event so the
 *   `autoloop_v2_chat` plugin tool can return it to the user. Structured
 *   signals (S3+) will be parsed out of the same reply text and pushed
 *   into the runner queue.
 */

import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { SessionManager } from '../../session-manager.js';
import type { Logger } from '../../logger.js';
import { nullLogger } from '../../logger.js';
import { spawn } from 'node:child_process';
import { type AnyAutoloopV2Message, Msg } from './messages.js';
import type { AgentDispatcher, AutoloopV2RunState, PushPolicy } from './types.js';
import {
  applyPlannerToolCalls,
  parsePlannerReply,
  type PlannerToolEffects,
  type SpawnSubagentsArgs,
} from './planner-tools.js';
import { extractIterComplete, extractReviewComplete, parseAgentReply } from './agent-tools.js';

export interface ClaudeAgentDispatcherConfig {
  manager: SessionManager;
  runId: string;
  workspace: string;
  /** Override the default Planner system prompt (default loads from configs/autoloop-v2-planner-prompt.md). */
  plannerPromptPath?: string;
  /** Override Coder/Reviewer prompt paths (defaults walk-up to configs/autoloop-v2-{coder,reviewer}-prompt.md). */
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
const resolveDefaultPlannerPrompt = (): string => resolveConfigByName('autoloop-v2-planner-prompt.md');
const resolveDefaultCoderPrompt = (): string => resolveConfigByName('autoloop-v2-coder-prompt.md');
const resolveDefaultReviewerPrompt = (): string => resolveConfigByName('autoloop-v2-reviewer-prompt.md');

interface SendMessageResult {
  output: string;
  error?: string;
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
    this.plannerName = `autoloop-v2-${config.runId}-planner`;
    this.coderName = `autoloop-v2-${config.runId}-coder`;
    this.reviewerName = `autoloop-v2-${config.runId}-reviewer`;

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

  async init(state: AutoloopV2RunState): Promise<void> {
    void state;
    await this.ensurePlanner();
  }

  async shutdown(reason: string): Promise<void> {
    void reason;
    // Best-effort cleanup. Stopping a non-existent session is a no-op.
    for (const name of [this.plannerName, this.coderName, this.reviewerName]) {
      try {
        await this.config.manager.stopSession(name);
      } catch (err) {
        this.logger.warn?.(`[autoloop-v2] failed to stop ${name}: ${(err as Error).message}`);
      }
    }
  }

  async deliver(env: AnyAutoloopV2Message): Promise<AnyAutoloopV2Message[]> {
    switch (env.to) {
      case 'planner':
        return await this.deliverToPlanner(env);
      case 'coder':
        return await this.deliverToCoder(env);
      case 'reviewer':
        return await this.deliverToReviewer(env);
      default:
        throw new Error(`[autoloop-v2] unexpected dispatcher target: ${env.to}`);
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
    try {
      await this.config.manager.stopSession(name);
    } catch (err) {
      this.logger.warn?.(`[autoloop-v2] resetAgent stop failed for ${name}: ${(err as Error).message}`);
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
      this.logger.warn?.(`[autoloop-v2] ${agent} send threw, attempting reset+retry: ${(err as Error).message}`);
      await this.resetAgent(agent, { eagerRestart: true });
      try {
        return (await this.config.manager.sendMessage(name, promptText, {
          timeout: this.config.sendTimeoutMs ?? 10 * 60_000,
        })) as SendMessageResult;
      } catch (err2) {
        this.logger.error?.(`[autoloop-v2] ${agent} second attempt failed after reset: ${(err2 as Error).message}`);
        return { output: '', error: (err2 as Error).message };
      }
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

  private async deliverToPlanner(env: AnyAutoloopV2Message): Promise<AnyAutoloopV2Message[]> {
    if (env.type !== 'chat' && env.type !== 'directive_ack' && env.type !== 'iter_done') {
      // Other types (push_user / pause / resume / terminate) are runner-only
      // or planner-emitted; they should never arrive *to* planner.
      throw new Error(`[autoloop-v2] planner does not accept message type=${env.type}`);
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
      this.logger.error?.(`[autoloop-v2] planner send error: ${result.error}`);
      this.emit('planner_error', new Error(result.error));
    }

    const replyText = (result.output ?? '').trim();

    // S3: parse autoloop-fenced tool calls out of the reply, apply effects,
    // and bubble emitted messages back into the runner queue.
    const parsed = parsePlannerReply(replyText);
    if (parsed.parse_errors.length > 0) {
      this.logger.warn?.(`[autoloop-v2] planner emitted ${parsed.parse_errors.length} malformed autoloop block(s)`);
    }
    const effects: PlannerToolEffects = {
      spawnSubagents: async (args) => {
        if (this.config.onSpawnSubagents) {
          await this.config.onSpawnSubagents(args);
        } else {
          this.logger.warn?.('[autoloop-v2] spawn_subagents called but no handler installed (S4 not wired yet)');
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
        for (const [k, v] of Object.entries(delta)) {
          if (!policyKeys.has(k) || typeof v !== 'object' || v === null) continue;
          (this.config.pushPolicyRef as unknown as Record<string, unknown>)[k] = v as Record<string, unknown>;
        }
      },
      commitPlanFile: async (file, message) => {
        await this.gitCommit(file, message ?? `autoloop-v2: planner commits ${file}`);
      },
    };
    const handlerResult = await applyPlannerToolCalls(parsed.calls, effects, env.iter);
    for (const errEntry of handlerResult.errors) {
      this.logger.warn?.(`[autoloop-v2] tool '${errEntry.tool}' failed: ${errEntry.error}`);
    }

    // Emit cleaned reply (without raw JSON blocks) for the chat tool to surface.
    if (parsed.cleaned_reply) this.emit('planner_reply', parsed.cleaned_reply);
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

  private async deliverToCoder(env: AnyAutoloopV2Message): Promise<AnyAutoloopV2Message[]> {
    if (env.type !== 'directive') {
      throw new Error(`[autoloop-v2] coder does not accept message type=${env.type}`);
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
    const replyText = (result.output ?? '').trim();
    const parsed = parseAgentReply(replyText);
    this.emit('coder_reply', parsed.cleaned_reply);

    const ic = extractIterComplete(parsed.calls);
    if (!ic) {
      // No iter_complete emitted — could be a clarification request, or the
      // Coder bailed. Return a directive_ack so Planner sees it next turn.
      return [
        Msg.directiveAck(env.iter, {
          understood: false,
          clarification: parsed.cleaned_reply.slice(0, 500),
        }),
      ];
    }

    // Persist eval output to ledger.
    fs.writeFileSync(path.join(iterDir, 'eval_output.json'), JSON.stringify(ic.eval_output, null, 2));
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
    const commitMsg = `autoloop-v2/iter-${env.iter}: ${ic.summary}`.slice(0, 200);
    await this.runGit(['git', 'commit', '-m', commitMsg]);

    return [
      Msg.iterArtifacts(env.iter, {
        diff: diffOut.out,
        eval_output: ic.eval_output,
        files_changed: filesChanged,
      }),
    ];
  }

  // ─── Reviewer ───────────────────────────────────────────────────────────

  private async ensureReviewer(): Promise<void> {
    if (this.reviewerStarted) return;
    fs.mkdirSync(this.reviewerSandboxDir, { recursive: true });
    await this.config.manager.startSession({
      name: this.reviewerName,
      cwd: this.reviewerSandboxDir,
      engine: 'claude',
      model: this.reviewerModel,
      permissionMode: 'bypassPermissions',
      systemPrompt: this.reviewerSystemPrompt,
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
    // Wipe top-level files (keep reviewer_memory.md if present).
    for (const ent of fs.readdirSync(this.reviewerSandboxDir)) {
      if (ent === 'reviewer_memory.md') continue;
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

  private async deliverToReviewer(env: AnyAutoloopV2Message): Promise<AnyAutoloopV2Message[]> {
    if (env.type !== 'review_request') {
      throw new Error(`[autoloop-v2] reviewer does not accept message type=${env.type}`);
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
      return [verdict];
    }

    this.persistVerdict(env.payload.iter, rc);
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
      JSON.stringify({ iter, ts: new Date().toISOString(), ...payload }, null, 2),
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
      this.logger.warn?.(`[autoloop-v2] git status failed: ${status.err.slice(0, 200)}`);
      return;
    }
    if (status.out.trim() === '') {
      this.logger.info?.(`[autoloop-v2] commit_${filename}: no changes to commit`);
      return;
    }
    await run(['git', 'add', '-A']);
    const commit = await run(['git', 'commit', '-m', message]);
    if (commit.code !== 0) {
      this.logger.warn?.(`[autoloop-v2] git commit failed: ${commit.err.slice(0, 200)}`);
    }
  }
}
