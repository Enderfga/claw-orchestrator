/**
 * The one agent step: start → send → (optionally) stop.
 *
 * This exact sequence was written five times — `council.ts` runSingleAgent,
 * `fanout.ts` twice (agent and synthesis), `session-manager.ts` ultraplan, and
 * autoloop's three `ensure*` helpers — each with its own idea of what counts as
 * success. Four of the five decided by "did it throw", which is the weakest
 * possible signal: an engine that ran, failed, and reported the failure cleanly
 * came back as a success.
 *
 * So the success predicate here reads `turnsSucceeded` — the one honest
 * per-engine terminal verdict in the codebase (`SessionStats.turnsSucceeded`,
 * derived per engine: codex's `turn.failed` at exit 0, codex-app's
 * `status: 'completed'`, gemini's exit 53). Until now nothing outside the ledger
 * read it.
 */

import type { Logger } from '../logger.js';
import type { SendOptions, SendResult, SessionConfig, SessionInfo, SessionStats } from '../types.js';

/** Structural SessionManager surface. Declared once here; the four private copies are gone. */
export interface SessionManagerLike {
  startSession(config: Partial<SessionConfig> & { name?: string }): Promise<SessionInfo>;
  sendMessage(name: string, message: string, options?: Partial<SendOptions>): Promise<SendResult>;
  stopSession(name: string): Promise<void>;
  /** Optional so lightweight fakes stay valid; success falls back to throw/no-throw without it. */
  getStatus?(name: string): SessionInfo & { stats: SessionStats };
}

export interface AgentStepArgs {
  manager: SessionManagerLike;
  sessionName: string;
  prompt: string;
  config?: Partial<SessionConfig>;
  /** Stamped onto the ledger row so the turn can be traced back to this run. */
  parentRunId?: string;
  timeoutMs?: number;
  /** Leave the session running (a multi-turn node owns its own teardown). */
  keepAlive?: boolean;
  /** Skip startSession — the caller already started this session. */
  reuseSession?: boolean;
  logger?: Logger;
}

export interface AgentStepResult {
  ok: boolean;
  output: string;
  error?: string;
  sessionName: string;
  durationMs: number;
  costUsd?: number;
  /**
   * How `ok` was decided. `counter` means the engine's own verdict moved;
   * `no-throw` means this manager could not report stats and we fell back.
   */
  okSource: 'counter' | 'no-throw' | 'error';
}

/**
 * Snapshot the two counters we compare across a send.
 *
 * Copied rather than aliased on purpose: the real `getStats()` happens to build
 * a fresh object each call, but nothing states that as a contract, and a
 * before/after pair that turns out to be the same reference silently compares a
 * value against itself and always reports success.
 */
function statsOf(
  manager: SessionManagerLike,
  name: string,
): { turns: number; turnsSucceeded: number; costUsd: number } | undefined {
  if (!manager.getStatus) return undefined;
  try {
    const s = manager.getStatus(name).stats;
    return { turns: s.turns, turnsSucceeded: s.turnsSucceeded, costUsd: s.costUsd };
  } catch {
    return undefined;
  }
}

/** Run one agent turn. Never throws — a failure comes back as `ok: false` with the message. */
export async function runAgentStep(args: AgentStepArgs): Promise<AgentStepResult> {
  const { manager, sessionName, prompt } = args;
  const startedAt = Date.now();
  let started = false;

  try {
    if (!args.reuseSession) {
      await manager.startSession({
        name: sessionName,
        permissionMode: 'bypassPermissions',
        ...args.config,
      });
      started = true;
    }

    const before = statsOf(manager, sessionName);
    const result = await manager.sendMessage(sessionName, prompt, {
      timeout: args.timeoutMs,
      parentRunId: args.parentRunId,
    });
    const after = statsOf(manager, sessionName);

    let ok: boolean;
    let okSource: AgentStepResult['okSource'];
    if (before && after) {
      // Same predicate the ledger uses: the counter moved, or the engine ran no
      // new turn at all (a no-op send is not a failure).
      ok = after.turns > before.turns ? after.turnsSucceeded > before.turnsSucceeded : true;
      okSource = 'counter';
    } else {
      ok = true;
      okSource = 'no-throw';
    }
    if (result.error) {
      ok = false;
      okSource = 'error';
    }

    return {
      ok,
      output: result.output ?? '',
      error: result.error,
      sessionName,
      durationMs: Date.now() - startedAt,
      costUsd: after && before ? Math.max(0, after.costUsd - before.costUsd) : after?.costUsd,
      okSource,
    };
  } catch (err) {
    return {
      ok: false,
      output: '',
      error: (err as Error).message,
      sessionName,
      durationMs: Date.now() - startedAt,
      okSource: 'error',
    };
  } finally {
    if (started && !args.keepAlive) {
      await manager.stopSession(sessionName).catch(() => {
        // Best-effort teardown; a session that already died is fine.
      });
    }
  }
}
