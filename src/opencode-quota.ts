/**
 * OpenCode's quota: the usage limits of an OpenCode Go subscription and the
 * account's budgets (`GET /api/experimental/usage/limits`, the TUI's `/usage`).
 *
 * Read through a live session's held server when there is one, else through
 * `opencode api --standalone`, which starts a private server for the one call.
 * An account with neither a Go subscription nor a budget answers `data: null`:
 * nothing is metered, and the reader has nothing to report.
 */

import { execEngine } from './engine-spawn.js';
import { registerQuotaReader } from './engine-quota.js';
import type { EngineQuota, QuotaWindow } from './types.js';

interface Meter {
  percent?: number;
  limited?: boolean;
  /** Milliseconds since the epoch. */
  resetsAt?: number;
}

/** The endpoint's answer (OpenCode 2.4.2's `UsageLimits.Info` under `data`). */
export interface OpencodeUsageLimits {
  data?: {
    workspace?: { id?: string; name?: string; usageURL?: string };
    go?: { rolling?: Meter; weekly?: Meter; monthly?: Meter };
    budgets?: Array<{ id?: string; limit?: number; spent?: number; resetsAt?: number; scope?: string }>;
  } | null;
}

const iso = (ms: unknown): string | undefined =>
  typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : undefined;

const pct = (n: number): number => Math.round(Math.min(100, Math.max(0, n)) * 10) / 10;

/** The quota in `raw`, or undefined when nothing is metered. */
export function parseUsageLimits(raw: OpencodeUsageLimits | undefined, source: string): EngineQuota | undefined {
  const info = raw?.data;
  if (!info) return undefined;
  const windows: QuotaWindow[] = [];
  for (const name of ['rolling', 'weekly', 'monthly'] as const) {
    const m = info.go?.[name];
    if (!m || typeof m.percent !== 'number') continue;
    const resetsAt = iso(m.resetsAt);
    windows.push({
      name: name === 'rolling' ? '5h' : name,
      usedPercent: pct(m.percent),
      remainingPercent: pct(100 - m.percent),
      ...(resetsAt ? { resetsAt } : {}),
    });
  }
  for (const b of info.budgets ?? []) {
    if (typeof b.limit !== 'number' || b.limit <= 0 || typeof b.spent !== 'number') continue;
    const used = (b.spent / b.limit) * 100;
    const resetsAt = iso(b.resetsAt);
    windows.push({
      name: `budget ${b.id ?? ''}`.trim(),
      usedPercent: pct(used),
      remainingPercent: pct(100 - used),
      ...(resetsAt ? { resetsAt } : {}),
    });
  }
  if (windows.length === 0) return undefined;
  return {
    engine: 'opencode',
    ...(info.go ? { plan: 'OpenCode Go' } : {}),
    windows,
    source,
    readAt: new Date().toISOString(),
    raw: info,
  };
}

/** `opencode api --standalone GET /api/experimental/usage/limits`. */
export async function readUsageLimitsStandalone(
  bin: string,
  cwd?: string,
  launcher?: readonly string[],
): Promise<OpencodeUsageLimits | undefined> {
  const args = ['api', '--standalone', 'GET', '/api/experimental/usage/limits'];
  const [head, ...rest] = launcher ?? [];
  const { stdout } = head
    ? await execEngine(head, [...rest, bin, ...args], { cwd, timeout: 25_000 })
    : await execEngine(bin, args, { cwd, timeout: 25_000 });
  return JSON.parse(stdout) as OpencodeUsageLimits;
}

interface UsageReader {
  readUsageLimits(): Promise<OpencodeUsageLimits | undefined>;
}

registerQuotaReader('opencode', async ({ session, cwd }) => {
  const live = session as Partial<UsageReader> | undefined;
  if (typeof live?.readUsageLimits === 'function') {
    return parseUsageLimits(await live.readUsageLimits(), 'opencode /usage (session server)');
  }
  const raw = await readUsageLimitsStandalone(process.env.OPENCODE_BIN || 'opencode', cwd);
  return parseUsageLimits(raw, 'opencode api --standalone /usage');
});
