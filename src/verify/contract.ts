/**
 * Acceptance contracts — what the runtime itself checks before calling a run done.
 *
 * Every completion signal that existed before this module was the agent grading
 * its own work: council terminated on a regex over agent prose (`consensus.ts`),
 * autoloop's `eval_output` was whatever the Coder passed to a tool call
 * (`autoloop/agent-tools.ts`), ultraapp's frontend gate was a sentence in a
 * persona string (`ultraapp/council-adapter.ts`). A contract is the opposite:
 * a caller-declared list of checks that *we* execute and whose exit codes we read.
 *
 * Provenance rule, and the reason `normalizeContract` exists: a contract may
 * come from the caller or from a mode default, never from agent output. If an
 * agent could declare its own checks we would be back to self-grading with extra
 * steps. Nothing in the kernel reads a contract out of a node's result.
 */

import { createHash } from 'node:crypto';

/** Argv form only — there is no shell string anywhere, so there is nothing to inject into. */
export interface CommandCheck {
  type: 'command';
  cmd: string;
  args?: string[];
  /** Relative to the run cwd when not absolute. */
  cwd?: string;
  timeoutMs?: number;
  /** Exit code that counts as pass. Default 0. */
  expectExit?: number;
}

export interface HttpCheck {
  type: 'http';
  url: string;
  /** Default 200. */
  expectStatus?: number;
  /** Total time to keep retrying before failing. Default 30s. */
  timeoutMs?: number;
  intervalMs?: number;
}

/**
 * Captures and stores a screenshot; it does not judge pixels. The judgement is
 * still a human's or an agent's, but whether the capture actually happened is
 * now decided by the runtime instead of by an agent's self-report. Do not
 * describe this as visual regression — it is evidence collection.
 */
export interface ScreenshotCheck {
  type: 'screenshot';
  url: string;
  viewports: Array<{ width: number; height: number; label?: string }>;
  /** Chrome/Chromium binary; resolved from the usual locations when omitted. */
  browserBin?: string;
  timeoutMs?: number;
}

export interface DiffPolicyCheck {
  type: 'diff_policy';
  maxFiles?: number;
  /** Glob-ish prefixes that must not be touched. */
  forbidPaths?: string[];
  /** At least one changed file must sit under one of these. */
  requirePaths?: string[];
}

export interface FileCheck {
  type: 'file';
  path: string;
  /** Default true. `false` asserts absence. */
  exists?: boolean;
  /** Applied to file contents when present. */
  matches?: string;
}

/**
 * A number the runtime measures, not one an agent reports: the command runs, the
 * value is read from its output, and the check holds it to absolute bounds
 * and, with `minDelta` / `maxRegression`, to the same command run on the run's
 * base commit — so "faster", "more accurate", "smaller" is decided by
 * measurement on both trees.
 */
export interface MetricCheck {
  type: 'metric';
  cmd: string;
  args?: string[];
  /** Relative to the run cwd when not absolute. */
  cwd?: string;
  timeoutMs?: number;
  /** A dotted path into the output parsed as JSON (`results.score`, `runs.0.ms`). */
  json?: string;
  /** An RE2 pattern whose first group is the number. Without `json` or `pattern`, the last number printed. */
  pattern?: string;
  /** Which way is better. Default `higher`. */
  direction?: 'higher' | 'lower';
  min?: number;
  max?: number;
  /** Better than the base commit's value by at least this much. */
  minDelta?: number;
  /** Worse than the base commit's value by at most this much. */
  maxRegression?: number;
}

export type CheckSpec = CommandCheck | HttpCheck | ScreenshotCheck | DiffPolicyCheck | FileCheck | MetricCheck;

export interface ContractCheck {
  /** Stable id used in the evidence bundle. Generated when omitted. */
  id?: string;
  spec: CheckSpec;
  /**
   * A failing non-required check is recorded in the bundle but does not refute
   * the run. The predecessor field (`fix-on-failure.ts` `steps[].required`) was
   * declared but never read; here it is honoured.
   */
  required?: boolean;
}

export interface AcceptanceContract {
  id?: string;
  checks: ContractCheck[];
  /**
   * On red, spawn a fixer session and re-run the whole check list, up to N times.
   * Ported from ultraapp's fix-on-failure loop. 0 disables.
   */
  fixOnFailureRounds?: number;
  /**
   * Refute the run when a test file or test configuration that existed at the
   * baseline was modified or deleted (see `protected-tests.ts`). On by default for
   * a contract with a command check; set `false` when changing tests is the task.
   */
  protectTests?: boolean;
  /**
   * More files the run may not change, relative to the run's directory: a judge
   * script, an evaluation config, a fixture — a file or a directory. Changing
   * one refutes the run, as changing a test does. The repository files a
   * command check runs by path are protected without being named here.
   */
  protectPaths?: string[];
}

export interface CheckResult {
  id: string;
  type: CheckSpec['type'];
  required: boolean;
  passed: boolean;
  durationMs: number;
  /** Human-readable one-liner: the command that failed, the status we got, etc. */
  detail: string;
  /** Tail of captured output, byte-capped. */
  tail?: string;
  /** Paths (relative to the evidence dir) of files this check produced. */
  artifacts?: string[];
  /** A `metric` check: the value measured, and the base commit's when it was compared. */
  metric?: { value: number; baseline?: number };
  /** Set when the check was killed by its own timeout rather than exiting. */
  timedOut?: boolean;
}

export const DEFAULT_CHECK_TIMEOUT_MS = 10 * 60_000;
export const DEFAULT_HTTP_TIMEOUT_MS = 30_000;
export const DEFAULT_SCREENSHOT_TIMEOUT_MS = 60_000;

// ─── Normalization ──────────────────────────────────────────────────────────

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function strArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is string => typeof x === 'string');
  return out.length === v.length ? out : undefined;
}

function normalizeSpec(raw: unknown): CheckSpec | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  switch (r.type) {
    case 'command': {
      const cmd = str(r.cmd);
      if (!cmd) return undefined;
      const args = strArray(r.args) ?? [];
      return {
        type: 'command',
        cmd,
        args,
        cwd: str(r.cwd),
        timeoutMs: num(r.timeoutMs),
        expectExit: num(r.expectExit),
      };
    }
    case 'http': {
      const url = str(r.url);
      if (!url) return undefined;
      return {
        type: 'http',
        url,
        expectStatus: num(r.expectStatus),
        timeoutMs: num(r.timeoutMs),
        intervalMs: num(r.intervalMs),
      };
    }
    case 'screenshot': {
      const url = str(r.url);
      if (!url || !Array.isArray(r.viewports) || r.viewports.length === 0) return undefined;
      const viewports: ScreenshotCheck['viewports'] = [];
      for (const v of r.viewports) {
        if (!v || typeof v !== 'object') return undefined;
        const vv = v as Record<string, unknown>;
        const width = num(vv.width);
        const height = num(vv.height);
        if (!width || !height) return undefined;
        viewports.push({ width, height, label: str(vv.label) });
      }
      return { type: 'screenshot', url, viewports, browserBin: str(r.browserBin), timeoutMs: num(r.timeoutMs) };
    }
    case 'diff_policy':
      return {
        type: 'diff_policy',
        maxFiles: num(r.maxFiles),
        forbidPaths: strArray(r.forbidPaths),
        requirePaths: strArray(r.requirePaths),
      };
    case 'metric': {
      const cmd = str(r.cmd);
      if (!cmd) return undefined;
      const direction =
        r.direction === 'lower'
          ? 'lower'
          : r.direction === undefined || r.direction === 'higher'
            ? 'higher'
            : undefined;
      if (!direction) return undefined;
      const m: MetricCheck = {
        type: 'metric',
        cmd,
        args: strArray(r.args) ?? [],
        cwd: str(r.cwd),
        timeoutMs: num(r.timeoutMs),
        json: str(r.json),
        pattern: str(r.pattern),
        direction,
        min: num(r.min),
        max: num(r.max),
        minDelta: num(r.minDelta),
        maxRegression: num(r.maxRegression),
      };
      // A metric with nothing to hold it to would pass whatever it measured.
      if ([m.min, m.max, m.minDelta, m.maxRegression].every((v) => v === undefined)) return undefined;
      return m;
    }
    case 'file': {
      const p = str(r.path);
      if (!p) return undefined;
      return {
        type: 'file',
        path: p,
        exists: typeof r.exists === 'boolean' ? r.exists : true,
        matches: str(r.matches),
      };
    }
    default:
      return undefined;
  }
}

/**
 * Why each declared check could not be used, e.g. "checks[2] (lint): type 'rm_rf' is unknown or is missing a
 * field it needs". Entries marked `required: false` say "(optional, dropped)". Empty when every entry parses.
 */
export function contractProblems(raw: unknown): string[] {
  if (!raw || typeof raw !== 'object') return ['the contract is not an object'];
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.checks)) return ['the contract has no `checks` list'];
  if (r.checks.length === 0) return ['the `checks` list is empty'];
  const out: string[] = [];
  r.checks.forEach((entry, i) => {
    if (!entry || typeof entry !== 'object') {
      out.push(`checks[${i}]: not an object`);
      return;
    }
    const e = entry as Record<string, unknown>;
    const specRaw = 'spec' in e ? e.spec : e;
    if (normalizeSpec(specRaw)) return;
    const t = specRaw && typeof specRaw === 'object' ? (specRaw as Record<string, unknown>).type : undefined;
    const id = str(e.id) ? ` (${str(e.id)})` : '';
    const why = typeof t === 'string' ? `type '${t}' is unknown or is missing a field it needs` : 'it has no `type`';
    out.push(`checks[${i}]${id}: ${why}${e.required === false ? ' (optional, dropped)' : ''}`);
  });
  return out;
}

/**
 * Parse an untrusted contract. Nothing unrecognised is carried into the executor. A required check that
 * cannot be parsed rejects the whole contract (undefined): dropping it would let the remaining checks pass
 * the run while one the caller asked for was never run. Only entries explicitly marked `required: false`
 * are dropped. `contractProblems` says which entries were at fault, for the caller's error message.
 */
export function normalizeContract(raw: unknown): AcceptanceContract | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const rawChecks = Array.isArray(r.checks) ? r.checks : undefined;
  if (!rawChecks) return undefined;
  const checks: ContractCheck[] = [];
  for (let i = 0; i < rawChecks.length; i++) {
    const entry = rawChecks[i] as Record<string, unknown> | undefined;
    if (!entry || typeof entry !== 'object') return undefined;
    // Accept both `{spec: {...}}` and a bare check spec, since hand-written
    // contracts in tool calls tend to omit the wrapper.
    const spec = normalizeSpec('spec' in entry ? entry.spec : entry);
    if (!spec) {
      if (entry.required === false) continue;
      return undefined;
    }
    checks.push({
      id: str(entry.id) ?? `${spec.type}-${i + 1}`,
      spec,
      required: entry.required === false ? false : true,
    });
  }
  if (checks.length === 0) return undefined;
  return {
    id: str(r.id),
    checks,
    fixOnFailureRounds: num(r.fixOnFailureRounds),
    ...(r.protectTests === false ? { protectTests: false } : {}),
    ...(Array.isArray(r.protectPaths)
      ? { protectPaths: r.protectPaths.filter((p): p is string => typeof p === 'string' && p.trim() !== '') }
      : {}),
  };
}

// ─── Which rules ────────────────────────────────────────────────────────────

/**
 * JSON with object keys sorted at every level and no whitespace, so the same
 * value always serialises the same way. `undefined` members are left out, as
 * `JSON.stringify` does; arrays keep their order, because the order of checks
 * is the order they run in.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? 'null' : canonicalJson(v))).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

/** Versions the fingerprint itself: a change to what it covers must not match an older fingerprint. */
const FINGERPRINT_SCHEME = 'clawo-contract/1';

/**
 * What a contract asks of the work: each check's spec and whether it is
 * required, in order, and whether tests are protected. Left out: the contract's
 * `id` and each check's `id`, which are names (a maintainer can keep a name
 * while changing what it checks, or rename without changing it), and
 * `fixOnFailureRounds`, which is how hard the run tries to pass, not what
 * passing means. Defaults are not filled in, so a contract that spells one out
 * fingerprints differently from one that leaves it implicit: two fingerprints
 * that match are the same rules; two that differ may still be equivalent.
 */
function rulesOf(contract: AcceptanceContract): unknown {
  const paths = [...new Set(contract.protectPaths ?? [])].sort();
  return {
    scheme: FINGERPRINT_SCHEME,
    checks: contract.checks.map(checkRules),
    protectTests: contract.protectTests !== false,
    // Only when there are any, so a contract without them keeps the fingerprint it always had.
    ...(paths.length ? { protectPaths: paths } : {}),
  };
}

function checkRules(check: ContractCheck): unknown {
  return { spec: check.spec, required: check.required !== false };
}

const sha256 = (text: string): string => `sha256:${createHash('sha256').update(text).digest('hex')}`;

/**
 * A digest of a contract's rules (see `rulesOf`), for the run record, the verdict
 * and every evidence bundle. It covers the contract as declared: the command
 * lines, paths and arguments of its checks, not the content of the programs or
 * files those checks run. A judge script that changes while the command that
 * runs it stays the same keeps the fingerprint; name its version in the command,
 * or check its digest in a check of its own.
 */
export function contractFingerprint(contract: AcceptanceContract): string {
  return sha256(canonicalJson(rulesOf(contract)));
}

/**
 * How the rules of `next` relate to those of `prev`: `same`; `adds-checks` (every
 * check of `prev` is in `next`, unchanged, and `next` has more), so passing `next`
 * implies passing `prev` but not the reverse; `removes-checks`, the converse; or
 * `changed`. A check whose spec or `required` changed is a different check, and
 * a change to `protectTests` is a change.
 */
export function compareContracts(
  prev: AcceptanceContract,
  next: AcceptanceContract,
): 'same' | 'adds-checks' | 'removes-checks' | 'changed' {
  if (contractFingerprint(prev) === contractFingerprint(next)) return 'same';
  if ((prev.protectTests !== false) !== (next.protectTests !== false)) return 'changed';
  const paths = (c: AcceptanceContract) => [...new Set(c.protectPaths ?? [])].sort().join('\n');
  if (paths(prev) !== paths(next)) return 'changed';
  const count = (c: AcceptanceContract) => {
    const m = new Map<string, number>();
    for (const check of c.checks) {
      const k = canonicalJson(checkRules(check));
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return m;
  };
  const a = count(prev);
  const b = count(next);
  const within = (x: Map<string, number>, y: Map<string, number>) => [...x].every(([k, n]) => (y.get(k) ?? 0) >= n);
  if (within(a, b)) return 'adds-checks';
  if (within(b, a)) return 'removes-checks';
  return 'changed';
}

/** True when every required check passed. Non-required failures are recorded, not fatal. */
export function contractPassed(results: CheckResult[]): boolean {
  return results.every((r) => r.passed || !r.required);
}
