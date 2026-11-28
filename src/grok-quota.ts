/**
 * Grok Build's account quota, and the usage-limit refusals it leaves behind.
 *
 * No grok command reads the remaining allowance (1.0.92): `grok usage` with no
 * session id answers "can't show your plan's usage here yet", and `/usage` is
 * a TUI screen. What can be read without a model call:
 *
 *  - the plan, from ACP `_x.ai/billing` (no session needed): the subscription
 *    tier, the billing period, the on-demand cap and what of it is used;
 *  - the free tier's rolling 24-hour token window, from the last usage-limit
 *    refusal grok logged (`~/.grok/logs/unified.jsonl`): "Usage resets over a
 *    rolling 24-hour window — tokens (actual/limit): 601197/600000". That
 *    number exists only in a refusal, so it is reported only while no model
 *    call has succeeded since.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { registerQuotaReader } from './engine-quota.js';
import { grokAcpCall } from './grok-acp-client.js';
import type { EngineQuota, QuotaWindow } from './types.js';

/** grok's home directory (`GROK_HOME`, else `~/.grok`). */
export function grokHome(): string {
  return process.env.GROK_HOME || path.join(os.homedir(), '.grok');
}

/** How much of the log's end is read: refusals of the last day sit well inside it. */
const LOG_TAIL_BYTES = 4 * 1024 * 1024;

const DAY_MS = 24 * 60 * 60_000;

/** A usage-limit refusal grok logged. */
export interface GrokRefusal {
  /** ISO time grok logged it. */
  at: string;
  sessionId?: string;
  message: string;
  /** Tokens counted against the window, and the window's limit, when the refusal names them. */
  used?: number;
  limit?: number;
  /** The refusal names grok's rolling 24-hour window. */
  rolling24h: boolean;
}

interface LogLine {
  ts?: string;
  sid?: string;
  msg?: string;
  ctx?: { kind?: string; status_code?: number; message?: string };
}

/** The last `bytes` of `file`, cut to whole lines; '' when it cannot be read. */
function readTail(file: string, bytes: number): string {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const text = buf.toString('utf8');
    return start > 0 ? text.slice(text.indexOf('\n') + 1) : text;
  } catch {
    return '';
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * The latest usage-limit refusal in grok's log, unless a model call succeeded
 * after it — then the limit was not binding any more.
 *
 * `sessionId` reads only that session's lines; `sinceMs` ignores anything
 * logged before it (default: the last 24 hours).
 */
export function latestGrokRefusal(
  opts: { sessionId?: string; sinceMs?: number; logFile?: string } = {},
): GrokRefusal | undefined {
  const file = opts.logFile ?? path.join(grokHome(), 'logs', 'unified.jsonl');
  const since = opts.sinceMs ?? Date.now() - DAY_MS;
  let refusal: GrokRefusal | undefined;
  for (const raw of readTail(file, LOG_TAIL_BYTES).split('\n')) {
    // Cheap filter first: the log is mostly other events.
    if (!raw.includes('shell.turn.inference_')) continue;
    let line: LogLine;
    try {
      line = JSON.parse(raw) as LogLine;
    } catch {
      continue;
    }
    if (opts.sessionId && line.sid !== opts.sessionId) continue;
    const at = line.ts ? Date.parse(line.ts) : Number.NaN;
    if (!Number.isFinite(at) || at < since) continue;
    if (line.msg === 'shell.turn.inference_done') {
      refusal = undefined;
    } else if (
      line.msg === 'shell.turn.inference_failed' &&
      (line.ctx?.kind === 'rate_limited' || line.ctx?.status_code === 429)
    ) {
      const message = line.ctx?.message ?? 'rate limited';
      const counts = /tokens \(actual\/limit\):\s*(\d+)\s*\/\s*(\d+)/i.exec(message);
      refusal = {
        at: new Date(at).toISOString(),
        ...(line.sid ? { sessionId: line.sid } : {}),
        message,
        ...(counts ? { used: Number(counts[1]), limit: Number(counts[2]) } : {}),
        rolling24h: /rolling 24-hour window/i.test(message),
      };
    }
  }
  return refusal;
}

interface GrokBilling {
  subscription_tier?: unknown;
  config?: {
    currentPeriod?: { type?: unknown; start?: unknown; end?: unknown };
    onDemandCap?: { val?: unknown };
    onDemandUsed?: { val?: unknown };
  };
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

/** Build grok's quota from what `_x.ai/billing` returned and the last refusal. */
export function grokQuotaFrom(billing: unknown, refusal: GrokRefusal | undefined, readAt = new Date()): EngineQuota {
  const b = (billing ?? {}) as GrokBilling;
  const windows: QuotaWindow[] = [];
  if (refusal?.used !== undefined && refusal.limit) {
    windows.push({
      name: refusal.rolling24h ? 'rolling 24h' : 'usage limit',
      usedPercent: round1((refusal.used / refusal.limit) * 100),
      remainingPercent: round1(Math.max(0, 100 - (refusal.used / refusal.limit) * 100)),
    });
  }
  const cap = Number(b.config?.onDemandCap?.val);
  const used = Number(b.config?.onDemandUsed?.val);
  if (Number.isFinite(cap) && cap > 0 && Number.isFinite(used)) {
    const end = b.config?.currentPeriod?.end;
    windows.push({
      name: 'on-demand',
      usedPercent: round1((used / cap) * 100),
      remainingPercent: round1(Math.max(0, 100 - (used / cap) * 100)),
      ...(typeof end === 'string' ? { resetsAt: new Date(end).toISOString() } : {}),
    });
  }
  const plan = typeof b.subscription_tier === 'string' ? b.subscription_tier : undefined;
  return {
    engine: 'grok',
    ...(plan ? { plan } : {}),
    windows,
    source: billing
      ? `grok _x.ai/billing${refusal ? " + the last usage-limit refusal in grok's log" : ''}`
      : "the last usage-limit refusal in grok's log",
    readAt: readAt.toISOString(),
    raw: { ...(billing ? { billing } : {}), ...(refusal ? { refusal } : {}) },
  };
}

/**
 * Read grok's quota: the plan over ACP, and the rolling window from the last
 * refusal. Neither needs a session or makes a model call.
 */
export async function readGrokQuota(opts: { cwd?: string; bin?: string } = {}): Promise<EngineQuota | undefined> {
  let billing: unknown;
  let billingError: Error | undefined;
  try {
    billing = await grokAcpCall('_x.ai/billing', {}, { cwd: opts.cwd, bin: opts.bin });
  } catch (err) {
    billingError = err as Error;
  }
  const refusal = latestGrokRefusal();
  if (billing === undefined && !refusal) {
    if (billingError) throw billingError;
    return undefined;
  }
  return grokQuotaFrom(billing, refusal);
}

registerQuotaReader('grok', ({ cwd }) => readGrokQuota({ cwd }));
