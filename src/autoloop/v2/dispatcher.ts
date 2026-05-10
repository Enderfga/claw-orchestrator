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
import { type AnyAutoloopV2Message } from './messages.js';
import type { AgentDispatcher, AutoloopV2RunState, PushPolicy } from './types.js';
import {
  applyPlannerToolCalls,
  parsePlannerReply,
  type PlannerToolEffects,
  type SpawnSubagentsArgs,
} from './planner-tools.js';

export interface ClaudeAgentDispatcherConfig {
  manager: SessionManager;
  runId: string;
  workspace: string;
  /** Override the default Planner system prompt (default loads from configs/autoloop-v2-planner-prompt.md). */
  plannerPromptPath?: string;
  /** Model alias for Planner (default: 'opus'). */
  plannerModel?: string;
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

function resolveDefaultPlannerPrompt(): string {
  // Walk up looking for configs/autoloop-v2-planner-prompt.md (matches the
  // robust resolver used in v1/runner.ts).
  const filePath = fileURLToPath(import.meta.url);
  let dir = path.dirname(filePath);
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, 'configs', 'autoloop-v2-planner-prompt.md');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fallback — caller will surface ENOENT if this is wrong.
  return path.join(path.dirname(filePath), '..', 'configs', 'autoloop-v2-planner-prompt.md');
}

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
  private plannerSystemPrompt: string;

  constructor(config: ClaudeAgentDispatcherConfig) {
    super();
    this.config = config;
    this.logger = config.logger ?? nullLogger;
    this.plannerName = `autoloop-v2-${config.runId}-planner`;
    this.coderName = `autoloop-v2-${config.runId}-coder`;
    this.reviewerName = `autoloop-v2-${config.runId}-reviewer`;

    const promptPath = config.plannerPromptPath ?? resolveDefaultPlannerPrompt();
    this.plannerSystemPrompt = fs.readFileSync(promptPath, 'utf-8');
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
      case 'reviewer':
        // S4 plugs these in. Until then, throwing is the right signal —
        // it means someone fired a directive/review_request before the
        // subagents were spawned, which is a bug at this stage.
        throw new Error(
          `[autoloop-v2] dispatch to '${env.to}' not implemented yet (S4). Got message type=${env.type}.`,
        );
      default:
        throw new Error(`[autoloop-v2] unexpected dispatcher target: ${env.to}`);
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
