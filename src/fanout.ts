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
  SessionStats,
} from './types.js';
import { type Logger } from './logger.js';

/** Minimal SessionManager surface used by Fanout (avoids a circular import). */
interface SessionManagerLike {
  startSession(config: Partial<SessionConfig> & { name?: string }): Promise<SessionInfo>;
  sendMessage(name: string, message: string, options?: Partial<SendOptions>): Promise<SendResult>;
  stopSession(name: string): Promise<void>;
  /** Optional so lightweight fakes stay valid; `ok` falls back to throw/no-throw without it. */
  getStatus?(name: string): SessionInfo & { stats: SessionStats };
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
  /**
   * Permission mode for the synthesis pass. Defaults to `bypassPermissions`
   * like the agents do, but a read-only fan-out has to pass `plan` here too:
   * synthesis shares the project directory, so a writable synthesiser can edit
   * the code the read-only agents were only allowed to look at.
   */
  synthesisPermissionMode?: PermissionMode;
  agentTimeoutMs?: number;
  maxTurnsPerAgent?: number;
  maxBudgetUsd?: number;
  /**
   * Identity for this run, supplied by the kernel.
   *
   * Without it the fan-out minted its own `fanout-<uuid>` and stamped THAT onto
   * every ledger row's `parentRunId` — so the rows could not be grouped by the
   * kernel run they belonged to, and the two ids had to be joined by hand.
   * One execution, one identity.
   */
  runId?: string;
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
      id: config.runId ?? `fanout-${randomUUID().slice(0, 8)}`,
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
      const before = this._stats(sessionName);
      const result = await this.manager.sendMessage(sessionName, spec.prompt || this.config.task, {
        timeout: this.config.agentTimeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS,
        parentRunId: this.session.id,
        nodeKind: 'fanout',
      });
      const after = this._stats(sessionName);
      // `ok` used to be an unconditional true in this block, i.e. "the call did
      // not throw" — so an engine that ran, failed, and reported the failure
      // cleanly was recorded as a success. Read the engine's own terminal
      // verdict instead, the same predicate the run ledger uses.
      const ok =
        !result.error &&
        (before && after ? (after.turns > before.turns ? after.turnsSucceeded > before.turnsSucceeded : true) : true);
      return {
        agent: spec.name,
        engine,
        model: spec.model,
        ok,
        output: result.output,
        error: ok ? undefined : result.error || 'engine did not report the turn as succeeded',
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

  /**
   * Engine-reported counters, when the manager can supply them.
   *
   * Copied rather than aliased on purpose: the real `getStats()` happens to build
   * a fresh object each call, but nothing states that as a contract, and a
   * before/after pair that turns out to be the same reference silently compares
   * a value against itself and always reports success.
   */
  private _stats(name: string): { turns: number; turnsSucceeded: number } | undefined {
    if (!this.manager.getStatus) return undefined;
    try {
      const s = this.manager.getStatus(name).stats;
      return { turns: s.turns, turnsSucceeded: s.turnsSucceeded };
    } catch {
      return undefined;
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
        permissionMode: this.config.synthesisPermissionMode ?? 'bypassPermissions',
        maxTurns: this.config.maxTurnsPerAgent ?? DEFAULT_MAX_TURNS,
        maxBudgetUsd: this.config.maxBudgetUsd,
      });
      const result = await this.manager.sendMessage(sessionName, prompt, {
        timeout: this.config.agentTimeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS,
        parentRunId: this.session.id,
      });
      // `sendMessage` reports a turn-level failure (auth loss mid-turn, invalid
      // model, rate-limit exhaustion) by RETURNING `{error}`, not by throwing —
      // so the catch below never saw those and `result.output` (the error text,
      // or '') was written to `session.synthesis` while `synthesisError` stayed
      // undefined and status went to 'done'. `_runAgent`, one method up in this
      // same file, already reads `result.error`; this is the same contract.
      if (result.error) {
        this.session.synthesisError = result.error;
        this.logger?.error?.(`Fanout synthesis failed: ${result.error}`);
        return undefined;
      }
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
