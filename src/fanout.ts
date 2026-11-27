/**
 * Fan-out — run one task across N engines/models in parallel and collect the
 * results, with an optional synthesis pass.
 *
 * This is the cross-engine "diverse perspectives / best-of-N" primitive: each
 * agent runs in its own session (any engine) against the shared projectDir, or
 * a directory of its own, and returns an answer. Unlike `council`, there is no consensus voting, no rounds,
 * and no git-worktree isolation — so it is intended for analysis/generation
 * that returns text (review from N angles, best-of-N drafts), NOT parallel file
 * edits. For isolated parallel editing use `council` (per-agent worktrees).
 */

import { defaultEngine } from './clawo-config.js';
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
  AgentBinding,
} from './types.js';
import { type Logger } from './logger.js';
import { mapBounded } from './concurrency.js';
import { sanitizeCwd } from './validation.js';
import { fenceForumText } from './kernel/forum/render.js';
import * as path from 'node:path';

/** Minimal SessionManager surface used by Fanout (avoids a circular import). */
interface SessionManagerLike {
  startSession(config: Partial<SessionConfig> & { name?: string }): Promise<SessionInfo>;
  sendMessage(name: string, message: string, options?: Partial<SendOptions>): Promise<SendResult>;
  stopSession(name: string): Promise<void>;
  /** Optional so lightweight fakes stay valid; `ok` falls back to throw/no-throw without it. */
  getStatus?(name: string): SessionInfo & { stats: SessionStats };
  /** Optional for the same reason; without it every agent starts at once. */
  freeSessionSlots?(): number;
}

export interface FanoutAgentSpec extends AgentBinding {
  /** Unique label for this agent (used in the session name and results). */
  name: string;
  /**
   * This agent's own working directory, absolute or relative to the fan-out's.
   * Agents that each write code need one apiece, or they edit the same files.
   */
  cwd?: string;
  /** Complete per-agent prompt; replaces the shared task when non-empty. */
  prompt?: string;
  /** Role instructions prepended to the shared task without a non-empty prompt. */
  persona?: string;
  baseUrl?: string;
  customEngine?: CustomEngineConfig;
  permissionMode?: PermissionMode;
  /**
   * The engine-agnostic sandbox. `permissionMode` goes to each engine's own
   * permission handling (Claude and Grok have a plan mode; Codex, Antigravity and
   * OpenCode ignore it), so `sandboxMode: 'read-only'` is what keeps an agent on
   * any engine from writing — an engine that cannot hold it refuses to start. It
   * matters here because every agent shares the one project directory.
   */
  sandboxMode?: 'read-only' | 'workspace-write' | 'danger-full-access';
}

export interface FanoutConfig {
  task: string;
  projectDir: string;
  agents: FanoutAgentSpec[];
  /** Run a final synthesis pass over the successful results (>=2 needed). */
  synthesize?: boolean;
  /** A forum the agents share while they work (`WorkflowSpec.forum`); `fanoutStart` only. */
  forum?: boolean | import('./kernel/forum.js').ForumConfig;
  synthesisModel?: string;
  synthesisEngine?: EngineType;
  /** The ACP agent preset the synthesis pass starts when `synthesisEngine` is `acp`. */
  synthesisAcpAgent?: string;
  /**
   * Kept for callers that set it. The synthesis pass reads the agents' answers
   * and writes one of its own, so it always runs read-only: `permissionMode:
   * 'plan'` and `sandboxMode: 'read-only'` (an ACP agent, which cannot be held
   * to a sandbox, gets `plan` alone).
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
  /** Polled before each queued agent starts and before synthesis; set by the kernel. */
  signal?: { aborted: boolean };
  /** Text put in front of an agent's message, such as the run forum's brief for it. */
  agentPreface?: (agent: string) => string | undefined;
  /** Put `agentPreface` after the agent's message instead, so the message's first line stays first. */
  agentPrefaceAfter?: boolean;
  /**
   * Called once an agent's session is up, with the session's name; the returned
   * function is called when the agent finishes. The run forum joins the agent here.
   */
  onAgentSession?: (agent: string, sessionName: string) => (() => void) | undefined;
  /** An agent's reply so far as it streams, and then its whole reply (the forum posts written in it). */
  onAgentText?: (agent: string, text: string) => void;
  /**
   * The name the synthesis pass goes by with `agentPreface`, `onAgentSession`
   * and `onAgentText` (its forum member name); without it those hooks are for
   * the agents alone.
   */
  synthesisName?: string;
}

export interface FanoutAgentResult {
  agent: string;
  engine: EngineType;
  model?: string;
  /** The directory this agent ran in. */
  cwd?: string;
  ok: boolean;
  /**
   * The agent's answer. On a failed turn, what it had written before it failed —
   * as much as its engine streams: agy hands over its reply only when the turn
   * ends, so a timed-out agy turn has none.
   */
  output: string;
  error?: string;
  /** The turn ran out of `agentTimeoutMs`; `output` is what came before that. */
  timedOut?: boolean;
  /** The output written to the run directory, so a long report can be read whole. */
  outputFile?: string;
  durationMs: number;
  /** What this agent's turn cost, as its send measured it. */
  costUsd?: number;
  /** A goal agent: the child run its goal ran in, and how the goal ended. */
  goal?: { runId: string; status?: string; tokensUsed?: number; threadId?: string };
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
  /** The synthesis written to the run directory. */
  synthesisFile?: string;
  /** Set when synthesis was requested but failed, so callers can tell it apart from "not requested". */
  synthesisError?: string;
  /** Every agent turn and the synthesis pass, summed — the fan-out's share of its run's cost. */
  costUsd?: number;
  error?: string;
  /** Set while the process running it has stopped and the run waits for `workflow_resume`; `status` still reads `running`. */
  suspended?: { at: string; reason: string };
}

/**
 * How long one agent's turn may run. 30 minutes, as for a council seat: a review
 * or an analysis of a whole codebase takes 15 to 30 (10 minutes, the earlier
 * default, cut them off).
 */
export const DEFAULT_AGENT_TIMEOUT_MS = 1_800_000;

/** A send that failed because the turn outlived its timeout, in any engine's wording. */
export function isTurnTimeout(message: string): boolean {
  return /\btime(?:d)?\s?out\b|\btimeout\b/i.test(message);
}
const DEFAULT_MAX_TURNS = 30;

function agentMessage(spec: FanoutAgentSpec, task: string): string {
  if (spec.prompt) return spec.prompt;
  if (spec.persona) return `${spec.persona}\n\n## Shared task\n\n${task}`;
  return task;
}

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
      // Each agent isolates its own failure (never throws); collect all. No more
      // agents run at once than there are session slots, so the rest wait for one.
      const agents = this.config.agents;
      const slots = this.manager.freeSessionSlots?.() ?? agents.length;
      this.session.results = await mapBounded(agents, slots, (a) => this._runAgent(a));
      if (!this._stopped() && this.config.synthesize) {
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

  private _stopped(): boolean {
    return this._aborted || this.config.signal?.aborted === true;
  }

  private async _runAgent(spec: FanoutAgentSpec): Promise<FanoutAgentResult> {
    const engine: EngineType = spec.engine || defaultEngine();
    // An agent still queued for a slot when the run was aborted never starts.
    if (this._stopped()) {
      return {
        agent: spec.name,
        engine,
        model: spec.model,
        ok: false,
        output: '',
        error: 'aborted before start',
        durationMs: 0,
      };
    }
    const sessionName = `${this.session.id}-${spec.name}`;
    const start = Date.now();
    const timeoutMs = this.config.agentTimeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS;
    // What the agent has written so far, kept for a turn that does not finish.
    let streamed = '';
    let leave: (() => void) | undefined;
    let cwd = this.config.projectDir;
    try {
      cwd = spec.cwd ? sanitizeCwd(path.resolve(this.config.projectDir, spec.cwd))! : this.config.projectDir;
      await this.manager.startSession({
        name: sessionName,
        cwd,
        engine,
        model: spec.model,
        ...(spec.effort === undefined ? {} : { effort: spec.effort }),
        baseUrl: spec.baseUrl,
        permissionMode: spec.permissionMode ?? 'bypassPermissions',
        sandboxMode: spec.sandboxMode,
        maxTurns: this.config.maxTurnsPerAgent ?? DEFAULT_MAX_TURNS,
        maxBudgetUsd: this.config.maxBudgetUsd,
        customEngine: spec.customEngine,
        ...(spec.acpAgent === undefined ? {} : { acpAgent: spec.acpAgent }),
        ...this._owner(),
      });
      leave = this.config.onAgentSession?.(spec.name, sessionName);
      const preface = this.config.agentPreface?.(spec.name);
      const message = agentMessage(spec, this.config.task);
      const before = this._stats(sessionName);
      const result = await this.manager.sendMessage(sessionName, this._withPreface(message, preface), {
        timeout: timeoutMs,
        parentRunId: this.session.id,
        nodeKind: 'fanout',
        onChunk: (text: string) => {
          streamed += text;
          this.config.onAgentText?.(spec.name, streamed);
        },
      });
      if (result.output) this.config.onAgentText?.(spec.name, result.output);
      const after = this._stats(sessionName);
      // `ok` used to be an unconditional true in this block, i.e. "the call did
      // not throw" — so an engine that ran, failed, and reported the failure
      // cleanly was recorded as a success. Read the engine's own terminal
      // verdict instead, the same predicate the run ledger uses.
      const ok =
        !result.error &&
        (before && after ? (after.turns > before.turns ? after.turnsSucceeded > before.turnsSucceeded : true) : true);
      const error = ok ? undefined : result.error || 'engine did not report the turn as succeeded';
      return {
        agent: spec.name,
        engine,
        model: spec.model,
        cwd,
        ok,
        output: result.output || (ok ? '' : streamed),
        ...(error ? this._failure(error, timeoutMs) : {}),
        durationMs: Date.now() - start,
        ...(result.usage ? { costUsd: this._charge(result.usage.costUsd) } : {}),
      };
    } catch (err) {
      return {
        agent: spec.name,
        engine,
        model: spec.model,
        cwd,
        ok: false,
        output: streamed,
        ...this._failure((err as Error).message, timeoutMs),
        durationMs: Date.now() - start,
      };
    } finally {
      leave?.();
      await this.manager.stopSession(sessionName).catch(() => {
        // Best-effort cleanup; a dead session is fine to ignore.
      });
    }
  }

  /** The run whose sessions these are: their messages go through its forum. */
  private _owner(): { ownerRunId?: string } {
    return this.config.runId ? { ownerRunId: this.config.runId } : {};
  }

  /** `text` with `preface` before it, or after it when the config asks for that. */
  private _withPreface(text: string, preface: string | undefined): string {
    if (!preface) return text;
    return this.config.agentPrefaceAfter ? `${text}\n\n---\n\n${preface}` : `${preface}\n\n---\n\n${text}`;
  }

  /** A failed turn's error, said plainly when the cause was the timeout. */
  private _failure(message: string, timeoutMs: number): { error: string; timedOut?: true } {
    if (!isTurnTimeout(message)) return { error: message };
    const minutes = Math.round(timeoutMs / 60_000);
    return {
      error: `timed out after ${minutes} min (agentTimeoutMs ${timeoutMs}); the output is what the agent had written by then (${message})`,
      timedOut: true,
    };
  }

  /**
   * Engine-reported counters, when the manager can supply them.
   *
   * Copied rather than aliased on purpose: the real `getStats()` happens to build
   * a fresh object each call, but nothing states that as a contract, and a
   * before/after pair that turns out to be the same reference silently compares
   * a value against itself and always reports success.
   */
  /** Add one send's cost to the fan-out's total and hand it back. */
  private _charge(costUsd: number): number {
    this.session.costUsd = (this.session.costUsd ?? 0) + costUsd;
    return costUsd;
  }

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
    // The agents' answers are its material, and the forum posts written as
    // blocks in them were posted already: fenced, a synthesis that quotes one
    // does not post it again.
    const combined = results
      .map(
        (r, i) =>
          `### Response ${i + 1} — ${r.agent} (${r.engine}${r.model ? `/${r.model}` : ''})\n\n${fenceForumText(r.output)}`,
      )
      .join('\n\n---\n\n');
    const task =
      `You are synthesizing ${results.length} independent responses to the same task. Produce one ` +
      `consolidated best answer: reconcile agreements, note meaningful disagreements, and keep the ` +
      `strongest ideas from each.\n\nTask:\n${this.config.task}\n\nResponses:\n\n${combined}`;
    const engine = this.config.synthesisEngine || defaultEngine();
    const name = this.config.synthesisName;
    const onText = name ? this.config.onAgentText : undefined;
    let leave: (() => void) | undefined;
    let streamed = '';
    try {
      // Read-only on every engine: it shares the project directory, and its
      // work is text. An ACP agent cannot be held to a sandbox; `plan` refuses
      // the permission requests it sends.
      await this.manager.startSession({
        name: sessionName,
        cwd: this.config.projectDir,
        engine,
        model: this.config.synthesisModel,
        ...(this.config.synthesisAcpAgent === undefined ? {} : { acpAgent: this.config.synthesisAcpAgent }),
        permissionMode: 'plan',
        ...(engine === 'acp' ? {} : { sandboxMode: 'read-only' as const }),
        maxTurns: this.config.maxTurnsPerAgent ?? DEFAULT_MAX_TURNS,
        maxBudgetUsd: this.config.maxBudgetUsd,
        ...this._owner(),
      });
      leave = name ? this.config.onAgentSession?.(name, sessionName) : undefined;
      const preface = name ? this.config.agentPreface?.(name) : undefined;
      const result = await this.manager.sendMessage(sessionName, this._withPreface(task, preface), {
        timeout: this.config.agentTimeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS,
        parentRunId: this.session.id,
        ...(name && onText
          ? {
              onChunk: (text: string) => {
                streamed += text;
                onText(name, streamed);
              },
            }
          : {}),
      });
      if (name && onText && result.output) onText(name, result.output);
      if (result.usage) this._charge(result.usage.costUsd);
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
      leave?.();
      await this.manager.stopSession(sessionName).catch(() => {
        // Best-effort cleanup.
      });
    }
  }
}
