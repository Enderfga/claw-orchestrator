/**
 * Grok Build's ACP extensions, as the `acp` engine reads them (the `grok`
 * preset, `grok agent stdio`).
 *
 * The long-lived ACP route is where grok's background features finish: a
 * `/deep-research` or `/workflow` run reports back, and a `/loop` job fires, as
 * a turn grok starts itself. Measured on 1.0.92:
 *
 *  - every turn ends with `_x.ai/session_notification`, `update.sessionUpdate:
 *    'turn_completed'`, carrying `prompt_id`, `stop_reason`, the turn's own
 *    usage (`inputTokens` with the cached reads in it, `costUsdTicks` at 1e10
 *    per dollar) and, when it failed, `error`. A finished deep-research run's
 *    turn had `prompt_id: 'workflow-completed-<run>-<rev>'`;
 *  - the prompt response carries no standard `usage`, only `_meta.usage`, so
 *    without this the route would bill nothing;
 *  - subagents' sessions report their own turns under their own session ids.
 */

import { registerAcpExtension, type AcpTurnEnd } from './persistent-acp-session.js';

interface GrokAcpUsage {
  inputTokens?: unknown;
  outputTokens?: unknown;
  cachedReadTokens?: unknown;
  costUsdTicks?: unknown;
}

interface GrokSessionNotification {
  sessionId?: unknown;
  update?: {
    sessionUpdate?: unknown;
    stop_reason?: unknown;
    usage?: GrokAcpUsage;
    error?: { message?: unknown; data?: unknown };
  };
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** A `turn_completed` session notification as a turn end; undefined for any other notification. */
export function grokTurnEnd(params: unknown): AcpTurnEnd | undefined {
  const p = params as GrokSessionNotification | undefined;
  const update = p?.update;
  if (update?.sessionUpdate !== 'turn_completed' || typeof p?.sessionId !== 'string') return undefined;
  const u = update.usage;
  const ticks = num(u?.costUsdTicks);
  const usage =
    u && (num(u.inputTokens) !== undefined || num(u.outputTokens) !== undefined)
      ? {
          inputTokens: num(u.inputTokens) ?? 0,
          outputTokens: num(u.outputTokens) ?? 0,
          cachedReadTokens: num(u.cachedReadTokens) ?? 0,
          ...(ticks !== undefined ? { costUsd: ticks / 1e10 } : {}),
        }
      : undefined;
  const data = update.error?.data;
  const message = update.error?.message;
  const error = typeof data === 'string' && data ? data : typeof message === 'string' && message ? message : undefined;
  return {
    sessionId: p.sessionId,
    ...(typeof update.stop_reason === 'string' ? { stopReason: update.stop_reason } : {}),
    ...(error ? { error } : {}),
    ...(usage ? { usage } : {}),
  };
}

registerAcpExtension('grok', { turnEnds: { '_x.ai/session_notification': grokTurnEnd } });
