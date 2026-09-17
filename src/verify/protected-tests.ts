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
 * the checks run, each must still be exactly that. What may change is what cannot
 * alter an existing test: new test files, new packages, unrelated npm scripts,
 * and new configuration that governs no test the run started with.
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
import { mapBounded } from '../concurrency.js';
import type { AcceptanceContract, CheckResult } from './contract.js';

const GIT_TIMEOUT_MS = 60_000;
/** Listings of a large repository run far past exec's default capture. */
const GIT_CAPTURE_BYTES = 64 * 1024 * 1024;
const READ_CONCURRENCY = 32;

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
/** Installed dependencies ship their own tests and configs; they are not this repository's. */
const DEPENDENCY_DIR = /(^|\/)(node_modules|vendor|site-packages|\.venv)\//;
const RUNNER_KEYS = ['jest', 'mocha', 'ava', 'vitest', 'c8', 'nyc'];

const isTestConfig = (file: string): boolean => TEST_CONFIG.some((re) => re.test(file));

/** True for a path that holds tests or configures how they run. */
export function isTestPath(file: string): boolean {
  return TEST_DIR.test(file) || TEST_FILE.some((re) => re.test(file)) || isTestConfig(file);
}

const isManifest = (file: string): boolean => MANIFEST.test(file) && !isTestPath(file);
const isProtected = (file: string): boolean => !DEPENDENCY_DIR.test(file) && (MANIFEST.test(file) || isTestPath(file));

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

interface ManifestState {
  runners: string;
  scripts: Record<string, string>;
}

/**
 * A protected path's state: absent, a symlink's target, unreadable, the file's bytes —
 * or, for a package.json outside a test directory, its scripts (kept verbatim, so
 * references between them can be followed) and a digest of its test-runner keys.
 */
async function stateOf(root: string, file: string): Promise<string | null> {
  const abs = path.join(root, file);
  try {
    const stat = await fs.promises.lstat(abs);
    if (stat.isSymbolicLink()) return `link:${await fs.promises.readlink(abs)}`;
    if (!stat.isFile()) return null;
    const body = await fs.promises.readFile(abs);
    if (!isManifest(file)) return digest(body);
    try {
      const pkg = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
      const scripts = pkg.scripts && typeof pkg.scripts === 'object' ? (pkg.scripts as Record<string, unknown>) : {};
      const state: ManifestState = {
        runners: digest(canonical(Object.fromEntries(RUNNER_KEYS.map((k) => [k, pkg[k] ?? null])))),
        scripts: Object.fromEntries(Object.entries(scripts).map(([k, v]) => [k, String(v)])),
      };
      return `pkg:${canonical(state)}`;
    } catch {
      return `pkg-unparseable:${digest(body)}`;
    }
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === 'ENOENT' ? null : `unreadable:${code ?? 'error'}`;
  }
}

function parseManifest(state: string | null): ManifestState | undefined {
  if (!state?.startsWith('pkg:')) return undefined;
  try {
    return JSON.parse(state.slice(4)) as ManifestState;
  } catch {
    return undefined;
  }
}

const SCRIPT_REF =
  /\b(?:npm|pnpm|yarn|bun)\s+(?:run(?:-script)?\s+)?([A-Za-z0-9:._-]+)|\b(?:npm-run-all|run-s|run-p)\s+((?:[A-Za-z0-9:._*-]+\s*)+)/g;

/** Script names a command line runs through a package manager. */
function referencedScripts(command: string): string[] {
  const names: string[] = [];
  for (const m of command.matchAll(SCRIPT_REF)) {
    if (m[1]) names.push(m[1] === 't' ? 'test' : m[1]);
    if (m[2])
      names.push(
        ...m[2]
          .trim()
          .split(/\s+/)
          .filter((n) => !n.startsWith('-')),
      );
  }
  return names;
}

/** The scripts a contract's command checks run by name. */
export function contractScripts(contract: AcceptanceContract): string[] {
  return contract.checks.flatMap((c) =>
    c.spec.type === 'command' ? referencedScripts([c.spec.cmd, ...(c.spec.args ?? [])].join(' ')) : [],
  );
}

/**
 * Whether a package.json changed in a way a check could run into: its test-runner
 * keys, or any script reachable from the test scripts or the contract's own —
 * following references and pre/post hooks in both versions.
 */
function manifestChanged(before: string | null, after: string | null, roots: string[]): boolean {
  const a = parseManifest(before);
  const b = parseManifest(after);
  if (!a || !b) return before !== after;
  if (a.runners !== b.runners) return true;
  const names = new Set([...Object.keys(a.scripts), ...Object.keys(b.scripts)]);
  const queue = [...roots, ...[...names].filter((n) => /^(pre|post)?test(:|$)/.test(n))];
  const reachable = new Set<string>();
  while (queue.length > 0) {
    const name = queue.pop()!;
    // Only names that exist in either version: a hook of a hook of a hook is a
    // different string every time, and following those never ends.
    if (reachable.has(name) || !names.has(name)) continue;
    reachable.add(name);
    queue.push(`pre${name}`, `post${name}`);
    for (const body of [a.scripts[name], b.scripts[name]]) if (body) queue.push(...referencedScripts(body));
  }
  return [...reachable].some((n) => a.scripts[n] !== b.scripts[n]);
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
    const states = await mapBounded(files, READ_CONCURRENCY, (f) => stateOf(root, f));
    return { root, files: Object.fromEntries(files.map((f, i) => [f, states[i]])) };
  } catch {
    return undefined;
  }
}

/** Whether a configuration file added during the run sits over a test the run started with. */
function governsRecordedTests(config: string, atStart: TestSnapshot): boolean {
  const dir = path.posix.dirname(config);
  return Object.entries(atStart.files).some(
    ([f, state]) => state !== null && isTestPath(f) && !isTestConfig(f) && (dir === '.' || f.startsWith(`${dir}/`)),
  );
}

/**
 * The `protected-tests` check against a run's snapshot. `null` means the run has
 * no snapshot — it predates them, or git could not take one — and is reported as
 * not checked rather than guessed at. `scriptRoots` are the npm scripts the
 * contract runs by name (`contractScripts`).
 */
export async function checkProtectedTests(
  cwd: string,
  atStart: TestSnapshot | null,
  scriptRoots: string[] = [],
): Promise<CheckResult> {
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
  // A verifier with its own cwd may be checking a tree the snapshot never saw.
  let real: string;
  try {
    real = fs.realpathSync(cwd);
  } catch {
    real = cwd;
  }
  const rel = path.relative(atStart.root, real);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return notChecked('the checks run outside the repository recorded when the run started');
  }
  // Inside that repository a listing failure fails the check: deleting `.git` must
  // not be a way around it.
  let now: { root: string; files: string[] };
  try {
    now = await listProtected(cwd);
  } catch (e) {
    return result(false, `could not check the tests: ${(e as Error).message}`);
  }

  const candidates = [...new Set([...Object.keys(atStart.files), ...now.files])].filter((file) => {
    if (file in atStart.files) return true;
    // Added during the run: only configuration over a test the run started with can matter.
    return isTestConfig(file) && governsRecordedTests(file, atStart);
  });
  const states = await mapBounded(candidates, READ_CONCURRENCY, (f) => stateOf(now.root, f));
  const touched: string[] = [];
  candidates.forEach((file, i) => {
    const expected = file in atStart.files ? atStart.files[file] : null;
    const current = states[i];
    const changed = isManifest(file) ? manifestChanged(expected, current, scriptRoots) : current !== expected;
    if (changed) touched.push(isManifest(file) ? `${file} (a script the checks run, or test settings)` : file);
  });
  if (touched.length === 0) return result(true, 'no test file or test configuration changed during the run');
  return result(
    false,
    `tests changed during the run, so the checks no longer test what they tested: ` +
      `${touched.slice(0, 10).join(', ')}. Set protectTests: false if changing them is the task.`,
    { tail: touched.length > 10 ? touched.join('\n') : undefined },
  );
}

/** Whether a spec's checks could need the snapshot: a command check that protects tests, or a subflow. */
export function needsTestSnapshot(spec: {
  contract?: AcceptanceContract;
  nodes: Array<{ kind: string; contract?: unknown }>;
}): boolean {
  const protects = (c: unknown): boolean => {
    const contract = c as AcceptanceContract | undefined;
    return (
      !!contract &&
      Array.isArray(contract.checks) &&
      contract.protectTests !== false &&
      contract.checks.some((check) => check?.spec?.type === 'command')
    );
  };
  if (protects(spec.contract)) return true;
  return spec.nodes.some((n) => n.kind === 'subflow' || (n.kind === 'verifier' && protects(n.contract)));
}
