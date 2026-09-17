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
 * The rule: a test file or test configuration may not differ from what it was
 * when the run started. For a kernel run, "when it started" is a snapshot taken
 * then, so a developer's uncommitted test edits — including a new test they had
 * not committed yet — are theirs and stay protected in that state. Without a
 * snapshot (`verify_run` with a `baseSha`) the base commit is the reference.
 * Adding new tests stays allowed. When changing existing tests *is* the task, the
 * caller sets `protectTests: false`.
 *
 * It compares blob ids: the base tree's, from `git ls-tree`, against the working
 * tree's, from `git hash-object`. Nothing goes through `git diff`, so the index
 * (assume-unchanged, skip-worktree), path quoting, `diff.relative` and replace
 * refs cannot hide a change. When git cannot answer, the check fails rather than
 * passing.
 *
 * What this does not catch, stated so nobody reads it as tamper-proof: tests
 * inside source files (Rust `#[cfg(test)]`), test settings embedded in general
 * config (`vite.config.*`, `pyproject.toml`, `setup.cfg`), and source code that
 * special-cases the test environment.
 */
import fs from 'node:fs';
import path from 'node:path';
import { exec, type ExecResult } from '../kernel/exec.js';
import type { CheckResult } from './contract.js';

const GIT_TIMEOUT_MS = 60_000;
/** Listings of a large repository run far past exec's default capture. */
const GIT_CAPTURE_BYTES = 64 * 1024 * 1024;

const TEST_DIR = /(^|\/)(__tests__|__snapshots__|tests?)\//;
const TEST_FILE = [
  /\.(test|spec)\.[cm]?[jt]sx?$/,
  /(^|\/)test_[^/]*\.py$/,
  /_test\.(py|go)$/,
  /_spec\.rb$/,
  /Tests?\.(java|kt|cs)$/,
  /(^|\/)spec\/(spec_helper|rails_helper)\.rb$/,
  /(^|\/)spec\/support\//,
];
const TEST_CONFIG = [
  /(^|\/)(vitest|jest|playwright|cypress)\.config\.(json|[cm]?[jt]s)$/,
  /(^|\/)karma\.conf\.([cm]?[jt]s|coffee)$/,
  /(^|\/)(vitest|jest)\.setup\.[cm]?[jt]sx?$/,
  /(^|\/)setupTests\.[cm]?[jt]sx?$/,
  /(^|\/)vitest\.workspace\.[cm]?[jt]s$/,
  /(^|\/)\.mocharc(\.[a-z]+)?$/,
  /(^|\/)\.rspec$/,
  /(^|\/)(pytest\.ini|conftest\.py|tox\.ini)$/,
  /(^|\/)phpunit\.xml(\.dist)?$/,
];
const MANIFEST = /(^|\/)package\.json$/;

/** True for a path that holds tests or configures how they run. */
export function isTestPath(file: string): boolean {
  return TEST_DIR.test(file) || TEST_FILE.some((re) => re.test(file)) || TEST_CONFIG.some((re) => re.test(file));
}

const isProtected = (file: string): boolean => MANIFEST.test(file) || isTestPath(file);

/** Protected paths and their state at the start of a run; `null` means absent then. */
export type TestSnapshot = Record<string, string | null>;

class GitUnavailable extends Error {}

async function git(cwd: string, args: string[], input?: string): Promise<ExecResult> {
  // Replace refs could make the base tree say something the object store does not.
  const r = await exec('git', ['--no-replace-objects', '-C', cwd, ...args], {
    timeoutMs: GIT_TIMEOUT_MS,
    input,
    maxCaptureBytes: GIT_CAPTURE_BYTES,
  });
  // exec keeps the tail of an oversized stream; a listing missing its head would
  // silently drop files from the comparison.
  if (Buffer.byteLength(r.out) >= GIT_CAPTURE_BYTES) throw new GitUnavailable(`git ${args[0]} output too large`);
  return r;
}

/** The parts of a package.json that decide what `npm test` runs, or undefined when it does not parse. */
function testScripts(body: string): string | undefined {
  try {
    const pkg = JSON.parse(body) as { scripts?: Record<string, unknown>; jest?: unknown };
    const scripts = pkg.scripts ?? {};
    const picked = Object.keys(scripts)
      .filter((k) => k === 'test' || k.startsWith('test:') || k.startsWith('pretest') || k.startsWith('posttest'))
      .sort()
      .map((k) => [k, scripts[k]]);
    return JSON.stringify({ scripts: picked, jest: pkg.jest ?? null });
  } catch {
    return undefined;
  }
}

interface Repo {
  top: string;
  /** Protected paths in the base tree → blob id. */
  base: Map<string, string>;
}

async function openRepo(cwd: string, baseSha: string): Promise<Repo> {
  // A base comes from a run record or a tool call; refuse anything git could read as an option.
  if (!/^[0-9a-f]{7,64}$/i.test(baseSha)) {
    throw new GitUnavailable(`baseline ${JSON.stringify(baseSha)} is not a commit id`);
  }
  const top = await git(cwd, ['rev-parse', '--show-toplevel']);
  if (top.code !== 0) throw new GitUnavailable(`${cwd} is not inside a git repository`);
  const root = top.out.trim();
  const tree = await git(root, ['ls-tree', '-r', '-z', '--full-tree', `${baseSha}^{commit}`]);
  if (tree.code !== 0) throw new GitUnavailable(`baseline ${baseSha} cannot be read from ${root}`);
  const base = new Map<string, string>();
  for (const entry of tree.out.split('\0')) {
    // "<mode> <type> <id>\t<path>"
    const tab = entry.indexOf('\t');
    if (tab < 0) continue;
    const [, type, id] = entry.slice(0, tab).split(' ');
    const file = entry.slice(tab + 1);
    if (type === 'blob' && isProtected(file)) base.set(file, id);
  }
  return { top: root, base };
}

/**
 * State now, in the form snapshots and the base are compared in: the blob id git
 * would store (clean filters applied), or for a package.json only its test
 * configuration. `null` when absent.
 */
async function statesNow(repo: Repo, files: string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const toHash: string[] = [];
  for (const file of files) {
    const abs = path.join(repo.top, file);
    let isFile = false;
    try {
      isFile = fs.statSync(abs).isFile();
    } catch {
      isFile = false;
    }
    if (!isFile) out.set(file, null);
    else if (MANIFEST.test(file)) out.set(file, testScripts(fs.readFileSync(abs, 'utf8')) ?? 'unparseable');
    else toHash.push(file);
  }
  if (toHash.length > 0) {
    const r = await git(repo.top, ['hash-object', '--stdin-paths'], toHash.join('\n') + '\n');
    const ids = r.out.split('\n').filter(Boolean);
    if (r.code !== 0 || ids.length !== toHash.length) {
      throw new GitUnavailable('git hash-object could not hash the test files');
    }
    toHash.forEach((file, i) => out.set(file, ids[i]));
  }
  return out;
}

async function baseState(repo: Repo, file: string): Promise<string | null> {
  const id = repo.base.get(file);
  if (id === undefined) return null;
  if (!MANIFEST.test(file)) return id;
  const blob = await git(repo.top, ['cat-file', 'blob', id]);
  if (blob.code !== 0) throw new GitUnavailable(`cannot read ${file} at the baseline`);
  return testScripts(blob.out) ?? 'unparseable';
}

/**
 * Taken when a run starts: every protected path whose state then differs from the
 * base commit, including test files that were new and not committed yet.
 * Undefined when git cannot say; the verifier then reports the check as not run.
 */
export async function snapshotChangedTests(
  cwd: string,
  baseSha: string | undefined,
): Promise<TestSnapshot | undefined> {
  if (!baseSha) return undefined;
  try {
    const repo = await openRepo(cwd, baseSha);
    const listed = await git(repo.top, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
    if (listed.code !== 0) return undefined;
    const present = listed.out.split('\0').filter((f) => f && isProtected(f));
    const candidates = [...new Set([...repo.base.keys(), ...present])];
    const now = await statesNow(repo, candidates);
    const snapshot: TestSnapshot = {};
    for (const file of candidates) {
      const state = now.get(file) ?? null;
      if (state !== (await baseState(repo, file))) snapshot[file] = state;
    }
    return snapshot;
  } catch {
    return undefined;
  }
}

/**
 * The `protected-tests` check; undefined when it does not apply (no baseline).
 * `atStart` is the run's snapshot. `null` means the run has a baseline but no
 * snapshot — a run created before snapshots existed, or one whose snapshot git
 * could not take — and is reported as not checked rather than compared against
 * a base commit that may hold the developer's own edits.
 */
export async function checkProtectedTests(
  cwd: string,
  baseSha: string | undefined,
  atStart?: TestSnapshot | null,
): Promise<CheckResult | undefined> {
  if (!baseSha) return undefined;
  const startedAt = Date.now();
  const result = (passed: boolean, detail: string, extra: Partial<CheckResult> = {}): CheckResult => ({
    id: 'protected-tests',
    type: 'diff_policy',
    required: true,
    passed,
    durationMs: Date.now() - startedAt,
    detail,
    ...extra,
  });

  if (atStart === null) {
    return result(false, 'not checked: there is no record of the tests as the run found them', { required: false });
  }

  try {
    const repo = await openRepo(cwd, baseSha);
    const candidates = [...new Set([...repo.base.keys(), ...Object.keys(atStart ?? {})])];
    const now = await statesNow(repo, candidates);
    const touched: string[] = [];
    for (const file of candidates) {
      const expected = atStart && file in atStart ? atStart[file] : await baseState(repo, file);
      if ((now.get(file) ?? null) !== expected) touched.push(MANIFEST.test(file) ? `${file} (test scripts)` : file);
    }
    if (touched.length === 0) return result(true, 'no test file or test configuration changed during the run');
    return result(
      false,
      `tests changed during the run, so the checks no longer test what they tested: ` +
        `${touched.slice(0, 10).join(', ')}. Set protectTests: false if changing them is the task.`,
      { tail: touched.length > 10 ? touched.join('\n') : undefined },
    );
  } catch (e) {
    return result(false, `could not check the tests against the baseline: ${(e as Error).message}`);
  }
}
