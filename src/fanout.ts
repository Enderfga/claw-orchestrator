/**
 * Fan-out — run one task across N engines/models in parallel and collect the
 * results, with an optional synthesis pass.
 *
 * This is the cross-engine "diverse perspectives / best-of-N" primitive: each
 * agent runs in its own session (any engine) against the shared projectDir and
 * returns an answer. Unlike `council`, there is no consensus voting, no rounds,
 * and no git-worktree isolation — so it is intended for analysis/generation
 * that returns text (review from N angles, best-of-N drafts), NOT parallel file
 * edits. For isolated parallel editing use `council` (per-agent worktrees).
 */

import { randomUUID } from 'node:crypto';

import type {
  EngineType,
  SessionConfig,
  SessionInfo,
  SendOptions,
  SendResult,
  PermissionMode,
  CustomEngineConfig,
} from './types.js';
import { type Logger } from './logger.js';

/** Minimal SessionManager surface used by Fanout (avoids a circular import). */
interface SessionManagerLike {
  startSession(config: Partial<SessionConfig> & { name?: string }): Promise<SessionInfo>;
  sendMessage(name: string, message: string, options?: Partial<SendOptions>): Promise<SendResult>;
  stopSession(name: string): Promise<void>;
}

export interface FanoutAgentSpec {
  /** Unique label for this agent (used in the session name and results). */
  name: string;
  engine?: EngineType;
  model?: string;
  /** Per-agent prompt; defaults to the shared task when omitted. */
  prompt?: string;
  baseUrl?: string;
  customEngine?: CustomEngineConfig;
  permissionMode?: PermissionMode;
}

export interface FanoutConfig {
  task: string;
  projectDir: string;
  agents: FanoutAgentSpec[];
  /** Run a final synthesis pass over the successful results (>=2 needed). */
  synthesize?: boolean;
  synthesisModel?: string;
  synthesisEngine?: EngineType;
  agentTimeoutMs?: number;
  maxTurnsPerAgent?: number;
  maxBudgetUsd?: number;
}

export interface FanoutAgentResult {
  agent: string;
  engine: EngineType;
  model?: string;
  ok: boolean;
  output: string;
  error?: string;
  durationMs: number;
}

export interface FanoutSession {
  id: string;
  status: 'running' | 'done' | 'error' | 'aborted';
  task: string;
  agentCount: number;
  startedAt: string;
  finishedAt?: string;
  results: FanoutAgentResult[];
  synthesis?: string;
  /** Set when synthesis was requested but failed, so callers can tell it apart from "not requested". */
  synthesisError?: string;
  error?: string;
}

const DEFAULT_AGENT_TIMEOUT_MS = 600_000;
const DEFAULT_MAX_TURNS = 30;

export class Fanout {
  private session: FanoutSession;
  private _aborted = false;

  constructor(
    private config: FanoutConfig,
    private manager: SessionManagerLike,
    private logger?: Logger,
  ) {
    this.session = {
      id: `fanout-${randomUUID().slice(0, 8)}`,
      status: 'running',
      task: config.task,
      agentCount: config.agents.length,
      startedAt: new Date().toISOString(),
      results: [],
    };
  }

  init(): FanoutSession {
    return this.session;
  }
  getSession(): FanoutSession {
    return this.session;
  }
  abort(): void {
    this._aborted = true;
    this.session.status = 'aborted';
  }

  async run(): Promise<FanoutSession> {
    try {
      // Each agent isolates its own failure (never throws); collect all.
      this.session.results = await Promise.all(this.config.agents.map((a) => this._runAgent(a)));
      if (!this._aborted && this.config.synthesize) {
        const ok = this.session.results.filter((r) => r.ok);
        if (ok.length >= 2) this.session.synthesis = await this._synthesize(ok);
      }
      if (!this._aborted) {
        this.session.status = 'done';
        this.session.finishedAt = new Date().toISOString();
      }
    } catch (err) {
      this.session.status = 'error';
      this.session.error = (err as Error).message;
      this.session.finishedAt = new Date().toISOString();
    }
    return this.session;
  }

  private async _runAgent(spec: FanoutAgentSpec): Promise<FanoutAgentResult> {
    const engine: EngineType = spec.engine || 'claude';
    const sessionName = `${this.session.id}-${spec.name}`;
    const start = Date.now();
    try {
      await this.manager.startSession({
        name: sessionName,
        cwd: this.config.projectDir,
        engine,
        model: spec.model,
        baseUrl: spec.baseUrl,
        permissionMode: spec.permissionMode ?? 'bypassPermissions',
        maxTurns: this.config.maxTurnsPerAgent ?? DEFAULT_MAX_TURNS,
        maxBudgetUsd: this.config.maxBudgetUsd,
        customEngine: spec.customEngine,
      });
      const result = await this.manager.sendMessage(sessionName, spec.prompt || this.config.task, {
        timeout: this.config.agentTimeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS,
      });
      return {
        agent: spec.name,
        engine,
        model: spec.model,
        ok: true,
        output: result.output,
        durationMs: Date.now() - start,
      };
    } catch (err) {
      return {
        agent: spec.name,
        engine,
        model: spec.model,
        ok: false,
        output: '',
        error: (err as Error).message,
        durationMs: Date.now() - start,
      };
    } finally {
      await this.manager.stopSession(sessionName).catch(() => {
        // Best-effort cleanup; a dead session is fine to ignore.
      });
    }
  }

  private async _synthesize(results: FanoutAgentResult[]): Promise<string | undefined> {
    const sessionName = `${this.session.id}-synthesis`;
    const combined = results
      .map((r, i) => `### Response ${i + 1} — ${r.agent} (${r.engine}${r.model ? `/${r.model}` : ''})\n\n${r.output}`)
      .join('\n\n---\n\n');
    const prompt =
      `You are synthesizing ${results.length} independent responses to the same task. Produce one ` +
      `consolidated best answer: reconcile agreements, note meaningful disagreements, and keep the ` +
      `strongest ideas from each.\n\nTask:\n${this.config.task}\n\nResponses:\n\n${combined}`;
    try {
      await this.manager.startSession({
        name: sessionName,
        cwd: this.config.projectDir,
        engine: this.config.synthesisEngine || 'claude',
        model: this.config.synthesisModel,
        permissionMode: 'bypassPermissions',
        maxTurns: this.config.maxTurnsPerAgent ?? DEFAULT_MAX_TURNS,
        maxBudgetUsd: this.config.maxBudgetUsd,
      });
      const result = await this.manager.sendMessage(sessionName, prompt, {
        timeout: this.config.agentTimeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS,
      });
      return result.output;
    } catch (err) {
      const msg = (err as Error).message;
      this.session.synthesisError = msg;
      this.logger?.error?.(`Fanout synthesis failed: ${msg}`);
      return undefined;
    } finally {
      await this.manager.stopSession(sessionName).catch(() => {
        // Best-effort cleanup.
      });
    }
  }
}
