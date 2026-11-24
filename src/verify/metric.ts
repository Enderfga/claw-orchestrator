/**
 * The `metric` check: a number the runtime measures, held to bounds and to the
 * run's base commit.
 *
 * The base value comes from the same command run on a detached git worktree of
 * the base commit — never the caller's checkout, never the candidate tree —
 * with the candidate's untracked dependency directories linked in, so both
 * trees run with the same tools. It is measured once per base commit and check
 * and kept (`BaselineStore`), so a repair loop does not measure it again.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RE2JS } from 're2js';
import { exec, lastLines } from '../kernel/exec.js';
import { canonicalJson, type CheckResult, type MetricCheck } from './contract.js';

export interface BaselineStore {
  get(key: string): number | undefined;
  set(key: string, value: number): void;
}

/** A store kept in one JSON file (a run's `metric-baselines.json`). */
export function fileBaselineStore(file: string): BaselineStore {
  const read = (): Record<string, number> => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, number>;
    } catch {
      return {};
    }
  };
  return {
    get: (key) => {
      const v = read()[key];
      return typeof v === 'number' ? v : undefined;
    },
    set: (key, value) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ ...read(), [key]: value }, null, 2));
    },
  };
}

export function memoryBaselineStore(): BaselineStore {
  const m = new Map<string, number>();
  return { get: (k) => m.get(k), set: (k, v) => void m.set(k, v) };
}

const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const LAST_NUMBER = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;

/** The value in a command's output: by JSON path, by pattern, or the last number printed. */
export function readMetric(output: string, spec: Pick<MetricCheck, 'json' | 'pattern'>): number | undefined {
  if (spec.json !== undefined) {
    const doc = parseJsonOutput(output);
    if (doc === undefined) return undefined;
    let cur: unknown = doc;
    for (const key of spec.json.split('.').filter(Boolean)) {
      if (cur === null || typeof cur !== 'object') return undefined;
      cur = (cur as Record<string, unknown>)[key];
    }
    return toNumber(cur);
  }
  if (spec.pattern !== undefined) {
    // RE2 (linear time): the output is whatever the measured code printed.
    try {
      const m = RE2JS.compile(spec.pattern).matcher(output);
      if (!m.find()) return undefined;
      return toNumber(m.groupCount() >= 1 ? m.group(1) : m.group(0));
    } catch {
      return undefined;
    }
  }
  const all = output.match(LAST_NUMBER);
  return all ? toNumber(all[all.length - 1]) : undefined;
}

function parseJsonOutput(output: string): unknown {
  const text = output.trim();
  try {
    return JSON.parse(text);
  } catch {
    // A tool that logs before its result: the last line that is JSON.
    const lines = text.split('\n').reverse();
    for (const line of lines) {
      try {
        return JSON.parse(line);
      } catch {
        // Not this one.
      }
    }
    return undefined;
  }
}

function toNumber(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

export interface MetricContext {
  cwd: string;
  baseSha?: string;
  baselines?: BaselineStore;
  signal?: { aborted: boolean };
  /** The environment the command runs with, on both trees; unset, the server's minus its credential. */
  env?: NodeJS.ProcessEnv;
}

type Outcome = Omit<CheckResult, 'id' | 'required' | 'type'>;

async function measure(
  spec: MetricCheck,
  cwd: string,
  signal: { aborted: boolean } | undefined,
  env: NodeJS.ProcessEnv | undefined,
): Promise<{ value?: number; detail: string; tail?: string; timedOut?: boolean; durationMs: number }> {
  const dir = spec.cwd ? path.resolve(cwd, spec.cwd) : cwd;
  const timeoutMs = spec.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const r = await exec(spec.cmd, spec.args ?? [], {
    cwd: dir,
    timeoutMs,
    ...(signal ? { signal } : {}),
    ...(env ? { env } : {}),
  });
  const cmdline = [spec.cmd, ...(spec.args ?? [])].join(' ');
  const output = `${r.out}\n${r.err}`;
  if (r.timedOut)
    return {
      detail: `\`${cmdline}\` timed out after ${timeoutMs}ms`,
      timedOut: true,
      durationMs: r.durationMs,
      tail: lastLines(output, 60),
    };
  if (r.code !== 0)
    return { detail: `\`${cmdline}\` exited ${r.code}`, durationMs: r.durationMs, tail: lastLines(output, 60) };
  const value = readMetric(r.out, spec);
  if (value === undefined) {
    return {
      detail: `\`${cmdline}\` printed no value the check could read`,
      durationMs: r.durationMs,
      tail: lastLines(output, 60),
    };
  }
  return { value, detail: '', durationMs: r.durationMs };
}

/** The base commit's value: measured once on a detached worktree of `baseSha`, then kept. */
async function baselineOf(spec: MetricCheck, ctx: MetricContext): Promise<{ value?: number; error?: string }> {
  if (!ctx.baseSha) return { error: 'there is no base commit to compare against (the run is not in a git repository)' };
  const key = crypto
    .createHash('sha256')
    .update(`${ctx.baseSha}\n${canonicalJson(spec)}`)
    .digest('hex')
    .slice(0, 32);
  const kept = ctx.baselines?.get(key);
  if (kept !== undefined) return { value: kept };

  const top = await exec('git', ['-C', ctx.cwd, 'rev-parse', '--show-toplevel'], { timeoutMs: 60_000 });
  if (top.code !== 0) return { error: 'the checks do not run in a git repository' };
  const repo = fs.realpathSync(top.out.trim());
  const tree = fs.mkdtempSync(path.join(os.tmpdir(), 'clawo-metric-base-'));
  fs.rmdirSync(tree);
  const added = await exec('git', ['-C', repo, 'worktree', 'add', '--detach', '--quiet', tree, ctx.baseSha], {
    timeoutMs: 120_000,
  });
  if (added.code !== 0) return { error: `could not check out the base commit: ${lastLines(added.err, 3)}` };
  try {
    // The candidate's dependency directories, so the base runs with the same tools.
    for (const name of ['node_modules', '.venv']) {
      const source = path.join(repo, name);
      if (fs.existsSync(source) && !fs.existsSync(path.join(tree, name))) {
        fs.symlinkSync(fs.realpathSync(source), path.join(tree, name));
      }
    }
    // The same directories, in the base's tree: the run's, and a check's own
    // when it names one in the candidate's tree by absolute path.
    const inBase = (dir: string): string => {
      let resolved = dir;
      try {
        resolved = fs.realpathSync(dir);
      } catch {
        // Not there: map it as written.
      }
      const rel = path.relative(repo, resolved);
      return rel.startsWith('..') || path.isAbsolute(rel) ? dir : path.join(tree, rel);
    };
    const baseSpec = spec.cwd && path.isAbsolute(spec.cwd) ? { ...spec, cwd: inBase(spec.cwd) } : spec;
    const m = await measure(baseSpec, inBase(ctx.cwd), ctx.signal, ctx.env);
    if (m.value === undefined) return { error: `on the base commit: ${m.detail}` };
    ctx.baselines?.set(key, m.value);
    return { value: m.value };
  } finally {
    await exec('git', ['-C', repo, 'worktree', 'remove', '--force', tree], { timeoutMs: 60_000 });
    fs.rmSync(tree, { recursive: true, force: true });
  }
}

const fmt = (n: number): string => (Number.isInteger(n) ? String(n) : n.toPrecision(6).replace(/\.?0+$/, ''));

export async function runMetricCheck(spec: MetricCheck, ctx: MetricContext): Promise<Outcome> {
  const m = await measure(spec, ctx.cwd, ctx.signal, ctx.env);
  if (m.value === undefined) {
    return { passed: false, durationMs: m.durationMs, timedOut: m.timedOut, detail: m.detail, tail: m.tail };
  }
  const value = m.value;
  const higher = spec.direction !== 'lower';
  const problems: string[] = [];
  if (spec.min !== undefined && value < spec.min) problems.push(`below the minimum ${fmt(spec.min)}`);
  if (spec.max !== undefined && value > spec.max) problems.push(`above the maximum ${fmt(spec.max)}`);

  let baseline: number | undefined;
  if (spec.minDelta !== undefined || spec.maxRegression !== undefined) {
    const b = await baselineOf(spec, ctx);
    if (b.value === undefined) {
      return { passed: false, durationMs: m.durationMs, detail: `metric ${fmt(value)}: ${b.error}`, metric: { value } };
    }
    baseline = b.value;
    // Positive when the candidate is better, in the check's direction.
    const gain = higher ? value - baseline : baseline - value;
    if (spec.minDelta !== undefined && gain < spec.minDelta) {
      problems.push(`improves on the base (${fmt(baseline)}) by ${fmt(gain)}, less than ${fmt(spec.minDelta)}`);
    }
    if (spec.maxRegression !== undefined && -gain > spec.maxRegression) {
      problems.push(`worse than the base (${fmt(baseline)}) by ${fmt(-gain)}, more than ${fmt(spec.maxRegression)}`);
    }
  }
  const against = baseline !== undefined ? ` (base ${fmt(baseline)}, ${higher ? 'higher' : 'lower'} is better)` : '';
  return {
    passed: problems.length === 0,
    durationMs: m.durationMs,
    detail:
      problems.length === 0
        ? `metric ${fmt(value)}${against}`
        : `metric ${fmt(value)}${against}: ${problems.join('; ')}`,
    metric: { value, ...(baseline !== undefined ? { baseline } : {}) },
  };
}
