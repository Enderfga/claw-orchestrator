/**
 * The check runner — the part of the runtime that actually looks.
 *
 * Extracted and generalised from `ultraapp/fix-on-failure.ts`, which was the one
 * piece of real verification in the codebase but was private to ultraapp,
 * hardcoded to an npm/docker step list, and had two defects this module fixes:
 *
 *  1. No timeout. A wedged `npm test` hung the pipeline forever.
 *  2. `steps[].required` was declared in the type and never read — every step
 *     was fatal. Here a non-required failure is recorded and carries on.
 *
 * What is kept: the injectable runner seam (so tests drive it without spawning),
 * the byte-capped tail, and the fix-on-red retry loop.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Logger } from '../logger.js';
import { exec as realExec, lastLines, type ExecResult } from '../kernel/exec.js';
import { changedFilesSince, isUnder, resolveIn } from './baseline.js';
import {
  contractPassed,
  DEFAULT_CHECK_TIMEOUT_MS,
  DEFAULT_HTTP_TIMEOUT_MS,
  DEFAULT_SCREENSHOT_TIMEOUT_MS,
  type AcceptanceContract,
  type CheckResult,
  type CheckSpec,
  type ContractCheck,
} from './contract.js';

export type ExecFn = (cmd: string, args: string[], opts: { cwd?: string; timeoutMs?: number }) => Promise<ExecResult>;

export interface FixerArgs {
  cwd: string;
  failingCheck: string;
  tail: string;
  round: number;
}

export type FixerSpawner = (args: FixerArgs) => Promise<void>;

export interface VerifyContext {
  cwd: string;
  /** Directory for check-produced files (screenshots). Created on demand. */
  artifactDir: string;
  baseSha?: string;
  exec?: ExecFn;
  fetchFn?: typeof fetch;
  logger?: Logger;
  /** Aborts the run between checks. */
  signal?: { aborted: boolean };
}

export interface ContractRunResult {
  results: CheckResult[];
  passed: boolean;
  /** Fix rounds consumed. 0 means it went green first try (or there was no fixer). */
  rounds: number;
}

const TAIL_LINES = 200;

// ─── Individual check kinds ─────────────────────────────────────────────────

async function runCommandCheck(
  spec: Extract<CheckSpec, { type: 'command' }>,
  ctx: VerifyContext,
): Promise<Omit<CheckResult, 'id' | 'required' | 'type'>> {
  const run = ctx.exec ?? realExec;
  const cwd = spec.cwd ? resolveIn(ctx.cwd, spec.cwd) : ctx.cwd;
  const r = await run(spec.cmd, spec.args ?? [], { cwd, timeoutMs: spec.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS });
  const cmdline = [spec.cmd, ...(spec.args ?? [])].join(' ');
  const expect = spec.expectExit ?? 0;
  const passed = r.code === expect;
  return {
    passed,
    durationMs: r.durationMs,
    timedOut: r.timedOut,
    detail: r.timedOut
      ? `\`${cmdline}\` timed out after ${spec.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS}ms`
      : passed
        ? `\`${cmdline}\` exited ${r.code}`
        : `\`${cmdline}\` exited ${r.code}, expected ${expect}`,
    tail: passed ? undefined : lastLines(r.err || r.out, TAIL_LINES),
  };
}

async function runHttpCheck(
  spec: Extract<CheckSpec, { type: 'http' }>,
  ctx: VerifyContext,
): Promise<Omit<CheckResult, 'id' | 'required' | 'type'>> {
  // Same shape as ultraapp's waitForHealth: poll until the deadline rather than
  // failing on the first refused connection, because the thing under test is
  // usually still coming up.
  const doFetch = ctx.fetchFn ?? fetch;
  const expect = spec.expectStatus ?? 200;
  const timeoutMs = spec.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
  const intervalMs = spec.intervalMs ?? 1000;
  const startedAt = Date.now();
  let lastDetail = 'never reached';

  while (Date.now() - startedAt < timeoutMs) {
    if (ctx.signal?.aborted) break;
    try {
      const res = await doFetch(spec.url);
      if (res.status === expect) {
        return { passed: true, durationMs: Date.now() - startedAt, detail: `GET ${spec.url} → ${res.status}` };
      }
      lastDetail = `GET ${spec.url} → ${res.status}, expected ${expect}`;
    } catch (e) {
      lastDetail = `GET ${spec.url} → ${(e as Error).message}`;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return {
    passed: false,
    durationMs: Date.now() - startedAt,
    detail: `${lastDetail} (gave up after ${timeoutMs}ms)`,
    timedOut: true,
  };
}

const CHROME_CANDIDATES = [
  process.env.CLAWO_CHROME_BIN,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  'google-chrome',
  'chromium',
  'chromium-browser',
].filter((x): x is string => Boolean(x));

function onPath(name: string): string | undefined {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // Unreadable PATH entry — keep looking.
    }
  }
  return undefined;
}

/**
 * Resolve a browser, checking PATH for bare names rather than handing them to
 * spawn and hoping. A host with no Chrome should be told so immediately; letting
 * the spawn fail means paying the check's full timeout to learn it.
 */
function resolveChrome(explicit?: string): string | undefined {
  if (explicit) return explicit;
  for (const c of CHROME_CANDIDATES) {
    if (c.includes('/')) {
      if (fs.existsSync(c)) return c;
    } else {
      const resolved = onPath(c);
      if (resolved) return resolved;
    }
  }
  return undefined;
}

async function runScreenshotCheck(
  spec: Extract<CheckSpec, { type: 'screenshot' }>,
  ctx: VerifyContext,
): Promise<Omit<CheckResult, 'id' | 'required' | 'type'>> {
  const run = ctx.exec ?? realExec;
  const bin = resolveChrome(spec.browserBin);
  const startedAt = Date.now();
  if (!bin) {
    return { passed: false, durationMs: 0, detail: 'no Chrome/Chromium binary found (set CLAWO_CHROME_BIN)' };
  }
  fs.mkdirSync(ctx.artifactDir, { recursive: true });
  const artifacts: string[] = [];
  const failures: string[] = [];

  for (const vp of spec.viewports) {
    const label = vp.label || `${vp.width}x${vp.height}`;
    const file = path.join(ctx.artifactDir, `shot-${label.replace(/[^\w.-]/g, '_')}.png`);
    const r = await run(
      bin,
      [
        '--headless=new',
        '--disable-gpu',
        '--hide-scrollbars',
        `--window-size=${vp.width},${vp.height}`,
        '--virtual-time-budget=4000',
        `--screenshot=${file}`,
        spec.url,
      ],
      { cwd: ctx.cwd, timeoutMs: spec.timeoutMs ?? DEFAULT_SCREENSHOT_TIMEOUT_MS },
    );
    // Chrome's exit code is unreliable in headless screenshot mode; the file
    // landing on disk with content is the signal that matters.
    let bytes = 0;
    try {
      bytes = fs.statSync(file).size;
    } catch {
      bytes = 0;
    }
    if (bytes > 0) {
      artifacts.push(path.basename(file));
    } else {
      failures.push(`${label}: no image produced (${r.timedOut ? 'timed out' : `exit ${r.code}`})`);
    }
  }

  return {
    passed: failures.length === 0,
    durationMs: Date.now() - startedAt,
    detail:
      failures.length === 0
        ? `captured ${artifacts.length} screenshot(s) of ${spec.url}`
        : `screenshot capture failed — ${failures.join('; ')}`,
    artifacts,
  };
}

async function runDiffPolicyCheck(
  spec: Extract<CheckSpec, { type: 'diff_policy' }>,
  ctx: VerifyContext,
): Promise<Omit<CheckResult, 'id' | 'required' | 'type'>> {
  const startedAt = Date.now();
  const changed = await changedFilesSince(ctx.cwd, ctx.baseSha);
  const problems: string[] = [];

  if (spec.maxFiles !== undefined && changed.length > spec.maxFiles) {
    problems.push(`${changed.length} files changed, limit ${spec.maxFiles}`);
  }
  for (const prefix of spec.forbidPaths ?? []) {
    const hits = changed.filter((f) => isUnder(f.path, prefix)).map((f) => f.path);
    if (hits.length > 0) problems.push(`forbidden path ${prefix} touched: ${hits.slice(0, 5).join(', ')}`);
  }
  if (spec.requirePaths && spec.requirePaths.length > 0) {
    const any = changed.some((f) => spec.requirePaths!.some((p) => isUnder(f.path, p)));
    if (!any) problems.push(`no change under any of: ${spec.requirePaths.join(', ')}`);
  }

  return {
    passed: problems.length === 0,
    durationMs: Date.now() - startedAt,
    detail: problems.length === 0 ? `${changed.length} file(s) changed, policy satisfied` : problems.join('; '),
    tail: problems.length === 0 ? undefined : changed.map((f) => `${f.status} ${f.path}`).join('\n'),
  };
}

function runFileCheck(
  spec: Extract<CheckSpec, { type: 'file' }>,
  ctx: VerifyContext,
): Omit<CheckResult, 'id' | 'required' | 'type'> {
  const startedAt = Date.now();
  const target = resolveIn(ctx.cwd, spec.path);
  const shouldExist = spec.exists !== false;
  let exists = false;
  try {
    exists = fs.existsSync(target);
  } catch {
    exists = false;
  }
  if (exists !== shouldExist) {
    return {
      passed: false,
      durationMs: Date.now() - startedAt,
      detail: shouldExist ? `${spec.path} is missing` : `${spec.path} exists but must not`,
    };
  }
  if (exists && spec.matches) {
    let body = '';
    try {
      body = fs.readFileSync(target, 'utf8');
    } catch (e) {
      return {
        passed: false,
        durationMs: Date.now() - startedAt,
        detail: `${spec.path} unreadable: ${(e as Error).message}`,
      };
    }
    let re: RegExp;
    try {
      re = new RegExp(spec.matches);
    } catch (e) {
      return { passed: false, durationMs: Date.now() - startedAt, detail: `invalid matcher: ${(e as Error).message}` };
    }
    if (!re.test(body)) {
      return {
        passed: false,
        durationMs: Date.now() - startedAt,
        detail: `${spec.path} does not match /${spec.matches}/`,
      };
    }
  }
  return { passed: true, durationMs: Date.now() - startedAt, detail: `${spec.path} ok` };
}

// ─── Orchestration ──────────────────────────────────────────────────────────

async function runOne(check: ContractCheck, index: number, ctx: VerifyContext): Promise<CheckResult> {
  const id = check.id || `${check.spec.type}-${index + 1}`;
  const required = check.required !== false;
  const base = { id, type: check.spec.type, required };
  switch (check.spec.type) {
    case 'command':
      return { ...base, ...(await runCommandCheck(check.spec, ctx)) };
    case 'http':
      return { ...base, ...(await runHttpCheck(check.spec, ctx)) };
    case 'screenshot':
      return { ...base, ...(await runScreenshotCheck(check.spec, ctx)) };
    case 'diff_policy':
      return { ...base, ...(await runDiffPolicyCheck(check.spec, ctx)) };
    case 'file':
      return { ...base, ...runFileCheck(check.spec, ctx) };
  }
}

/**
 * Run every check once, in order. Unlike the predecessor pipeline this does not
 * stop at the first red: a full result set is far more useful in an evidence
 * bundle than "the first thing that broke", and non-required checks must run
 * regardless. Required failures short-circuit only the *remaining required*
 * command checks when `stopOnRequiredFailure` is set.
 */
export async function runChecks(
  contract: AcceptanceContract,
  ctx: VerifyContext,
  opts: { stopOnRequiredFailure?: boolean } = {},
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (let i = 0; i < contract.checks.length; i++) {
    if (ctx.signal?.aborted) break;
    const check = contract.checks[i];
    if (opts.stopOnRequiredFailure && results.some((r) => r.required && !r.passed) && check.required !== false) {
      results.push({
        id: check.id || `${check.spec.type}-${i + 1}`,
        type: check.spec.type,
        required: true,
        passed: false,
        durationMs: 0,
        detail: 'skipped — an earlier required check failed',
      });
      continue;
    }
    try {
      results.push(await runOne(check, i, ctx));
    } catch (e) {
      results.push({
        id: check.id || `${check.spec.type}-${i + 1}`,
        type: check.spec.type,
        required: check.required !== false,
        passed: false,
        durationMs: 0,
        detail: `check threw: ${(e as Error).message}`,
      });
    }
  }
  return results;
}

/**
 * Run the contract, and on red optionally hand the failure to a fixer agent and
 * run the whole list again. The fixer's own claim of success is ignored — only
 * the re-run decides, which is what made the ultraapp version trustworthy.
 */
export async function runContract(
  contract: AcceptanceContract,
  ctx: VerifyContext,
  spawnFixer?: FixerSpawner,
): Promise<ContractRunResult> {
  const maxRounds = spawnFixer ? (contract.fixOnFailureRounds ?? 0) : 0;
  let rounds = 0;

  for (;;) {
    const results = await runChecks(contract, ctx);
    if (contractPassed(results) || rounds >= maxRounds || ctx.signal?.aborted) {
      return { results, passed: contractPassed(results), rounds };
    }
    const failed = results.find((r) => r.required && !r.passed);
    rounds++;
    ctx.logger?.info?.(`[verify] round ${rounds}/${maxRounds} — fixing: ${failed?.detail ?? 'unknown'}`);
    await spawnFixer!({
      cwd: ctx.cwd,
      failingCheck: failed?.detail ?? 'unknown',
      tail: failed?.tail ?? '',
      round: rounds,
    });
  }
}
