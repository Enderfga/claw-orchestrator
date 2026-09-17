/**
 * Tests the contract runs are not the agent's to change.
 *
 * A command check executes in the tree the agent just worked in. Without this,
 * an agent that rewrites a failing assertion to `expect(true)`, deletes the test,
 * or points `scripts.test` somewhere harmless turns a refuted run into a verified
 * one — the checks still exit 0, they just no longer check anything. Published
 * measurements put that behaviour at half of the attempts on unsolvable tasks for
 * several frontier models (ImpossibleBench, arXiv 2510.20270).
 *
 * The rule: a test file or test configuration that existed at the baseline may
 * not be modified or deleted. Adding tests stays allowed, since tests are often
 * part of the task. When changing existing tests *is* the task, the caller sets
 * `protectTests: false`.
 *
 * "Existed at the baseline" is measured against the tree as the run found it, not
 * against the base commit alone: a developer's uncommitted edit to a test, made
 * before the run started, is theirs. `snapshotChangedTests` records those at start.
 *
 * What this does not catch, stated so nobody reads it as tamper-proof: tests
 * that live inside source files (Rust `#[cfg(test)]`), and source code that
 * special-cases the test environment. It only closes the direct route.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { exec } from '../kernel/exec.js';
import { changedFilesSince } from './baseline.js';
import type { CheckResult } from './contract.js';

const GIT_TIMEOUT_MS = 60_000;

const TEST_DIR = /(^|\/)(__tests__|tests?|specs?)\//;
const TEST_FILE = [
  /\.(test|spec)\.[cm]?[jt]sx?$/,
  /(^|\/)test_[^/]*\.py$/,
  /_test\.(py|go)$/,
  /_spec\.rb$/,
  /Tests?\.(java|kt|cs)$/,
];
const TEST_CONFIG = [
  /(^|\/)(vitest|jest|playwright|karma|cypress)\.config\.[cm]?[jt]s$/,
  /(^|\/)vitest\.workspace\.[cm]?[jt]s$/,
  /(^|\/)\.mocharc(\.[a-z]+)?$/,
  /(^|\/)(pytest\.ini|conftest\.py|tox\.ini)$/,
  /(^|\/)phpunit\.xml(\.dist)?$/,
];

/** True for a path that holds tests or configures how they run. */
export function isTestPath(file: string): boolean {
  return TEST_DIR.test(file) || TEST_FILE.some((re) => re.test(file)) || TEST_CONFIG.some((re) => re.test(file));
}

async function existedAt(cwd: string, baseSha: string, file: string): Promise<boolean> {
  // `git diff <base>` reports a file added and committed since the base as
  // modified, so the change set alone cannot say whether the file is new.
  const r = await exec('git', ['-C', cwd, 'cat-file', '-e', `${baseSha}:${file}`], { timeoutMs: GIT_TIMEOUT_MS });
  return r.code === 0;
}

async function showAt(cwd: string, rev: string, file: string): Promise<string | undefined> {
  const r = await exec('git', ['-C', cwd, 'show', `${rev}:${file}`], { timeoutMs: GIT_TIMEOUT_MS });
  return r.code === 0 ? r.out : undefined;
}

/** The `test*` scripts of a package.json, or undefined when it does not parse. */
function testScripts(body: string | undefined): string | undefined {
  if (body === undefined) return undefined;
  try {
    const scripts = (JSON.parse(body) as { scripts?: Record<string, unknown> }).scripts ?? {};
    const picked = Object.keys(scripts)
      .filter((k) => k === 'test' || k.startsWith('test:') || k.startsWith('pretest') || k.startsWith('posttest'))
      .sort()
      .map((k) => [k, scripts[k]]);
    return JSON.stringify(picked);
  } catch {
    return undefined;
  }
}

const isManifest = (file: string): boolean => /(^|\/)package\.json$/.test(file);

/**
 * What a protected file currently is: its content hash, or for a package.json only
 * its test scripts. Null when it is gone. Change-set paths are relative to the
 * repository root, not to cwd, hence `top`.
 */
function currentState(top: string, file: string): string | null {
  let body: Buffer;
  try {
    body = fs.readFileSync(path.join(top, file));
  } catch {
    return null;
  }
  if (isManifest(file)) return testScripts(body.toString('utf8')) ?? null;
  return crypto.createHash('sha256').update(body).digest('hex');
}

async function repoTop(cwd: string): Promise<string | undefined> {
  const r = await exec('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { timeoutMs: GIT_TIMEOUT_MS });
  return r.code === 0 ? r.out.trim() : undefined;
}

/** Protected files already changed relative to the base commit, and their state then. */
export type TestSnapshot = Record<string, string | null>;

/** Taken when a run starts, so edits that were already in the tree are not blamed on the run. */
export async function snapshotChangedTests(
  cwd: string,
  baseSha: string | undefined,
): Promise<TestSnapshot | undefined> {
  if (!baseSha) return undefined;
  const top = await repoTop(cwd);
  if (!top) return undefined;
  const snapshot: TestSnapshot = {};
  for (const f of await changedFilesSince(cwd, baseSha)) {
    if (f.status === 'untracked' || !(isManifest(f.path) || isTestPath(f.path))) continue;
    snapshot[f.path] = currentState(top, f.path);
  }
  return snapshot;
}

/**
 * Run the protection check against the change set since `baseSha`, discounting
 * files still as they were in `atStart`. Returns undefined when it does not
 * apply: no baseline to compare against.
 */
export async function checkProtectedTests(
  cwd: string,
  baseSha: string | undefined,
  atStart?: TestSnapshot,
): Promise<CheckResult | undefined> {
  if (!baseSha) return undefined;
  const top = await repoTop(cwd);
  if (!top) return undefined;
  const startedAt = Date.now();
  const touched: string[] = [];
  for (const f of await changedFilesSince(cwd, baseSha)) {
    if (f.status === 'untracked') continue;
    const manifest = isManifest(f.path);
    if (!manifest && !isTestPath(f.path)) continue;
    if (!(await existedAt(cwd, baseSha, f.path))) continue;
    const now = currentState(top, f.path);
    if (atStart && f.path in atStart && atStart[f.path] === now) continue;
    if (manifest && testScripts(await showAt(cwd, baseSha, f.path)) === now) continue;
    touched.push(manifest ? `${f.path} (test scripts)` : f.path);
  }
  return {
    id: 'protected-tests',
    type: 'diff_policy',
    required: true,
    passed: touched.length === 0,
    durationMs: Date.now() - startedAt,
    detail:
      touched.length === 0
        ? 'no test file or test configuration present at the baseline was changed'
        : `tests present at the baseline were changed, so the checks no longer test what they tested: ` +
          `${touched.slice(0, 10).join(', ')}. Set protectTests: false if changing them is the task.`,
    tail: touched.length > 10 ? touched.join('\n') : undefined,
  };
}
