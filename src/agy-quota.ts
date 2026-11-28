/**
 * agy's quota, read with its own print-mode info commands: `agy -p /usage` and
 * `agy -p /credits` answer without a model turn and spend nothing.
 *
 * Measured on 1.5.18: `/usage` gives `command.data.groups`, one per model group
 * (Gemini models; Claude and GPT models), each with a weekly and a 5-hour bucket:
 * `{ id, name, window: 'weekly' | '5h', remaining_fraction, reset_time }`. A
 * bucket nothing has used yet resets at the epoch (`1970-01-01T00:00:00Z`).
 * `/credits` gives `{ remaining_credits }`. With a `GEMINI_API_KEY` there is no
 * account quota: both exit 2 without a payload (1.5.10+).
 */

import type { ChildProcess } from 'node:child_process';

import { spawnEngine, killEngineTree } from './engine-spawn.js';
import { registerQuotaReader } from './engine-quota.js';
import { sanitizeSecrets } from './sanitize.js';
import type { EngineQuota, QuotaWindow } from './types.js';

/** One info command's structured answer, or undefined when it gave none. */
export interface AgyInfoAnswer {
  ok: boolean;
  /** `command.data`. */
  data?: unknown;
  /** The tab-separated `response`. */
  text: string;
  error?: string;
}

/**
 * Parse the stream-json of an info command: `command_result` (or the `command`
 * on the `result`) carries the answer; a `result` with `status` other than
 * SUCCESS or an `error` is a refusal.
 */
export function parseAgyInfoAnswer(stdout: string): AgyInfoAnswer | undefined {
  let data: unknown;
  let text = '';
  let error: string | undefined;
  let status: string | undefined;
  let sawResult = false;
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let evt: Record<string, unknown>;
    try {
      evt = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    const command = evt.command as { data?: unknown } | undefined;
    if (evt.event === 'command_result' && command && 'data' in command) data = command.data;
    if (evt.event === 'result' && evt.result && typeof evt.result === 'object') {
      sawResult = true;
      const r = evt.result as Record<string, unknown>;
      if (typeof r.response === 'string') text = r.response;
      if (typeof r.status === 'string') status = r.status;
      if (typeof r.error === 'string' && r.error.trim()) error = r.error.trim();
      const rc = r.command as { data?: unknown } | undefined;
      if (data === undefined && rc && 'data' in rc) data = rc.data;
    }
  }
  if (!sawResult && data === undefined) return undefined;
  const ok = !error && (status === undefined || status === 'SUCCESS');
  return { ok, text, ...(data !== undefined ? { data } : {}), ...(error ? { error } : {}) };
}

/** Run one info command (`/usage`, `/help`, …) as its own process. */
export function runAgyInfoCommand(
  command: string,
  opts: {
    bin?: string;
    cwd?: string;
    extraArgs?: string[];
    timeoutMs?: number;
    launcher?: readonly string[];
    /** Told about the process, so its owner can end it early. */
    onSpawn?: (proc: ChildProcess) => void;
  } = {},
): Promise<{ answer?: AgyInfoAnswer; code: number | null; stderr: string }> {
  const timeoutMs = opts.timeoutMs ?? 25_000;
  const args = [
    '-p',
    command,
    '--output-format',
    'stream-json',
    ...(opts.extraArgs ?? []),
    '--print-timeout',
    `${Math.max(1, Math.floor(timeoutMs / 1000) - 1)}s`,
  ];
  return new Promise((resolve, reject) => {
    const proc = spawnEngine(opts.bin || process.env.AGY_BIN || 'agy', args, {
      launcher: opts.launcher,
      cwd: opts.cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    opts.onSpawn?.(proc);
    let stdout = '';
    let stderr = '';
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      killEngineTree(proc);
      reject(new Error(`agy ${command} took longer than ${timeoutMs} ms`));
    }, timeoutMs);
    timer.unref?.();
    proc.stdout?.on('data', (d: Buffer) => (stdout += d.toString()));
    proc.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
    proc.on('error', (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(err);
    });
    proc.on('close', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ answer: parseAgyInfoAnswer(stdout), code, stderr });
    });
  });
}

const EPOCH = /^1970-01-01T00:00:00/;

/** `/usage`'s data as quota windows: one per group and window, e.g. `Gemini Models weekly`. */
export function agyQuotaWindows(usage: unknown): QuotaWindow[] {
  const groups = (usage as { groups?: unknown } | undefined)?.groups;
  if (!Array.isArray(groups)) return [];
  const windows: QuotaWindow[] = [];
  for (const g of groups) {
    const group = typeof (g as { name?: unknown })?.name === 'string' ? (g as { name: string }).name : 'quota';
    const buckets = (g as { buckets?: unknown }).buckets;
    if (!Array.isArray(buckets)) continue;
    for (const b of buckets) {
      const bucket = b as { window?: unknown; id?: unknown; remaining_fraction?: unknown; reset_time?: unknown };
      const label = typeof bucket.window === 'string' ? bucket.window : typeof bucket.id === 'string' ? bucket.id : '';
      const w: QuotaWindow = { name: label ? `${group} ${label}` : group };
      if (typeof bucket.remaining_fraction === 'number' && Number.isFinite(bucket.remaining_fraction)) {
        const remaining = Math.round(Math.min(1, Math.max(0, bucket.remaining_fraction)) * 1000) / 10;
        w.remainingPercent = remaining;
        w.usedPercent = Math.round((100 - remaining) * 10) / 10;
      }
      if (typeof bucket.reset_time === 'string' && !EPOCH.test(bucket.reset_time)) w.resetsAt = bucket.reset_time;
      windows.push(w);
    }
  }
  return windows;
}

/** Read agy's quota with `/usage` and `/credits`; undefined when the account has none (an API key). */
export async function readAgyQuota(opts: { cwd?: string; bin?: string } = {}): Promise<EngineQuota | undefined> {
  const [usage, credits] = await Promise.all([
    runAgyInfoCommand('/usage', opts),
    runAgyInfoCommand('/credits', opts).catch(() => undefined),
  ]);
  const answer = usage.answer;
  if (!answer || answer.data === undefined) {
    // No account quota to read (agy exits 2 under a GEMINI_API_KEY); anything else is a failure.
    if (usage.code === 2 || answer?.ok === false) return undefined;
    const why = sanitizeSecrets(usage.stderr.trim()).slice(0, 500);
    throw new Error(`agy /usage gave no quota (exit ${usage.code}${why ? `: ${why}` : ''})`);
  }
  const balance = (credits?.answer?.data as { remaining_credits?: unknown } | undefined)?.remaining_credits;
  return {
    engine: 'agy',
    windows: agyQuotaWindows(answer.data),
    source: 'agy /usage',
    readAt: new Date().toISOString(),
    raw: { usage: answer.data, ...(typeof balance === 'number' ? { credits: balance } : {}) },
  };
}

registerQuotaReader('agy', ({ cwd }) => readAgyQuota({ cwd }));
