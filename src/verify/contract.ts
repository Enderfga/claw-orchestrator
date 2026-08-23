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

export type CheckSpec = CommandCheck | HttpCheck | ScreenshotCheck | DiffPolicyCheck | FileCheck;

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
 * Parse an untrusted contract, dropping anything unrecognised. Returns undefined
 * when nothing usable survives, so a malformed contract fails loudly at declare
 * time rather than silently degrading to "no checks" at completion time.
 */
export function normalizeContract(raw: unknown): AcceptanceContract | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const rawChecks = Array.isArray(r.checks) ? r.checks : undefined;
  if (!rawChecks) return undefined;
  const checks: ContractCheck[] = [];
  for (let i = 0; i < rawChecks.length; i++) {
    const entry = rawChecks[i] as Record<string, unknown> | undefined;
    if (!entry || typeof entry !== 'object') continue;
    // Accept both `{spec: {...}}` and a bare check spec, since hand-written
    // contracts in tool calls tend to omit the wrapper.
    const spec = normalizeSpec('spec' in entry ? entry.spec : entry);
    if (!spec) continue;
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
  };
}

/** True when every required check passed. Non-required failures are recorded, not fatal. */
export function contractPassed(results: CheckResult[]): boolean {
  return results.every((r) => r.passed || !r.required);
}
