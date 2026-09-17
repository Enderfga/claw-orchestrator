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
 * The rule: when a kernel run starts, every test file and test configuration in
 * the tree is recorded as it is — bytes hashed here, not through git, so clean
 * filters, attributes, line-ending conversion and the index have no say. Before
 * the checks run, each of them must still be exactly that. New test files may be
 * added; new test *configuration* may not, since a `conftest.py` or `pytest.ini`
 * that appears mid-run changes what the existing tests do. When changing tests is
 * the task, the caller sets `protectTests: false`.
 *
 * It runs before the checks, so it judges the tree the agent handed over rather
 * than one a test command may have rewritten.
 *
 * What this does not catch, stated so nobody reads it as tamper-proof: tests
 * inside source files (Rust `#[cfg(test)]`), test settings inside general config
 * (`vite.config.*`, `pyproject.toml`, `setup.cfg`), files hidden by `.gitignore`,
 * and source code that special-cases the test environment.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { exec } from '../kernel/exec.js';
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

const isTestConfig = (file: string): boolean => TEST_CONFIG.some((re) => re.test(file));

/** True for a path that holds tests or configures how they run. */
export function isTestPath(file: string): boolean {
  return TEST_DIR.test(file) || TEST_FILE.some((re) => re.test(file)) || isTestConfig(file);
}

const isProtected = (file: string): boolean => MANIFEST.test(file) || isTestPath(file);

/** The tests as a run found them: repository root, and each protected path's state (`null` = absent). */
export interface TestSnapshot {
  root: string;
  files: Record<string, string | null>;
}

/** Stable JSON: object keys sorted, so reordering a package.json is not a change. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

const digest = (data: string | Buffer): string => crypto.createHash('sha256').update(data).digest('hex').slice(0, 32);

/**
 * A protected path's state: absent, a symlink's target, a package.json's scripts
 * and test-runner keys (the rest of it may change), or the file's bytes.
 * A package.json inside a test directory is a test file like any other.
 */
function stateOf(root: string, file: string): string | null {
  const abs = path.join(root, file);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(abs);
  } catch {
    return null;
  }
  if (stat.isSymbolicLink()) return `link:${fs.readlinkSync(abs)}`;
  if (!stat.isFile()) return null;
  const body = fs.readFileSync(abs);
  if (MANIFEST.test(file) && !isTestPath(file)) {
    try {
      const pkg = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
      const runners = ['scripts', 'jest', 'mocha', 'ava', 'vitest', 'c8', 'nyc'];
      return `pkg:${digest(canonical(Object.fromEntries(runners.map((k) => [k, pkg[k] ?? null]))))}`;
    } catch {
      return `pkg-unparseable:${digest(body)}`;
    }
  }
  return digest(body);
}

async function listProtected(cwd: string): Promise<{ root: string; files: string[] }> {
  const top = await exec('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { timeoutMs: GIT_TIMEOUT_MS });
  if (top.code !== 0) throw new Error(`${cwd} is not inside a git repository`);
  const root = top.out.trim();
  const listed = await exec('git', ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    timeoutMs: GIT_TIMEOUT_MS,
    maxCaptureBytes: GIT_CAPTURE_BYTES,
  });
  // exec keeps the tail of an oversized stream; a listing missing its head would
  // silently drop files from the comparison.
  if (listed.code !== 0 || Buffer.byteLength(listed.out) >= GIT_CAPTURE_BYTES) {
    throw new Error('git could not list the files in the repository');
  }
  return { root, files: [...new Set(listed.out.split('\0').filter((f) => f && isProtected(f)))] };
}

/** Record the tests as the run finds them. Undefined when there is no repository to read. */
export async function snapshotTests(cwd: string): Promise<TestSnapshot | undefined> {
  try {
    const { root, files } = await listProtected(cwd);
    return { root, files: Object.fromEntries(files.map((f) => [f, stateOf(root, f)])) };
  } catch {
    return undefined;
  }
}

/**
 * The `protected-tests` check against a run's snapshot. `null` means the run has
 * no snapshot — it predates them, or git could not take one — and is reported as
 * not checked rather than guessed at.
 */
export async function checkProtectedTests(cwd: string, atStart: TestSnapshot | null): Promise<CheckResult> {
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
  const notChecked = (why: string) => result(false, `not checked: ${why}`, { required: false });

  if (!atStart) return notChecked('there is no record of the tests as the run found them');
  let now: { root: string; files: string[] };
  try {
    now = await listProtected(cwd);
  } catch (e) {
    return result(false, `could not check the tests: ${(e as Error).message}`);
  }
  // A verifier with its own cwd in another repository checks a tree the snapshot never saw.
  if (now.root !== atStart.root) return notChecked('the checks run in a different repository from the one recorded');

  const touched: string[] = [];
  for (const file of new Set([...Object.keys(atStart.files), ...now.files])) {
    const expected = file in atStart.files ? atStart.files[file] : null;
    const current = stateOf(now.root, file);
    if (current === expected) continue;
    // A test or a package added during the run is allowed; test configuration added
    // during the run is not, since it changes what the existing tests do.
    if (expected === null && !isTestConfig(file)) continue;
    touched.push(MANIFEST.test(file) && !isTestPath(file) ? `${file} (scripts or test settings)` : file);
  }
  if (touched.length === 0) return result(true, 'no test file or test configuration changed during the run');
  return result(
    false,
    `tests changed during the run, so the checks no longer test what they tested: ` +
      `${touched.slice(0, 10).join(', ')}. Set protectTests: false if changing them is the task.`,
    { tail: touched.length > 10 ? touched.join('\n') : undefined },
  );
}
