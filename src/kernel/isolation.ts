/**
 * A run in a git worktree of its own (`WorkflowSpec.isolation: 'worktree'`).
 *
 * Without it every node edits the caller's checkout: a refuted attempt is left
 * in the tree, uncommitted changes made before the run are counted as the
 * run's, two runs on one repository edit the same files, and a run changing
 * clawo itself rebuilds the `dist/` the running server loads. With it the run
 * starts from the repository's HEAD in `<run dir>/worktree`, on a branch
 * `clawo/<runId>`, and the caller's checkout is never written.
 *
 * When the run ends, whatever it left is committed to that branch — verified
 * or not, so a refuted attempt can be read — and the worktree is removed; the
 * branch stays, local, for the caller to merge, inspect or delete. Nothing is
 * pushed. A resume after the worktree was removed checks the branch out again.
 *
 * Dependency directories the repository does not track (`node_modules`,
 * `.venv`) are linked into the worktree, so checks that run the project's tools
 * work without an install. A link is not a directory to git, so a `.gitignore`
 * entry `node_modules/` does not cover it; when git would list it, `/<name>` is
 * added to the repository's `info/exclude`, the one exclude file worktrees
 * share. The main checkout already ignores that directory, so nothing changes
 * there.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { wfDir } from './store.js';
import type { WorkflowSpec } from './types.js';

/** The isolation a spec asks for. */
export type IsolationSpec = 'worktree' | { mode: 'worktree'; link?: string[] };

/** What the run record keeps about its worktree. */
export interface RunIsolation {
  /** The repository's top-level directory: the caller's checkout. */
  repo: string;
  worktree: string;
  branch: string;
  baseSha: string;
  /** Directories linked from the checkout into the worktree. */
  linked: string[];
  /** The commit the run's work was saved as, once it ended. */
  commit?: string;
  /** The worktree has been removed; the branch holds the work. */
  removed?: boolean;
  /** Why the work could not be saved when the run ended; the worktree is left as it was. */
  saveError?: string;
}

/**
 * Where a run's worktree goes: beside the run directories, not in one, since a
 * run's directory is created as it is claimed — after the worktree is made and
 * the spec rewritten to it.
 */
export function worktreeDir(runId: string): string {
  return path.join(path.dirname(wfDir()), 'worktrees', runId);
}

/** Linked when present and untracked, unless the spec names its own list. */
export const DEFAULT_LINKS = ['node_modules', '.venv'];

const GIT_TIMEOUT_MS = 120_000;

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 16 * 1024 * 1024,
  }).trim();
}

export function isolationLinks(spec: IsolationSpec): string[] {
  return typeof spec === 'object' && Array.isArray(spec.link) ? spec.link : DEFAULT_LINKS;
}

/**
 * A worktree for the run at `worktree` (`worktreeDir`), from the repository that
 * holds `cwd`. Returns the record to keep and the run's working directory inside
 * it (the same subdirectory `cwd` is of the repository).
 */
export function createRunWorktree(
  cwd: string,
  runId: string,
  worktree: string,
  spec: IsolationSpec,
): { isolation: RunIsolation; cwd: string } {
  let repo: string;
  try {
    repo = fs.realpathSync(git(cwd, ['rev-parse', '--show-toplevel']));
  } catch {
    throw new Error(`isolation 'worktree' needs a git repository; ${cwd} is not in one`);
  }
  let baseSha: string;
  try {
    baseSha = git(repo, ['rev-parse', 'HEAD']);
  } catch {
    throw new Error(`isolation 'worktree' needs a commit to start from; ${repo} has none`);
  }
  const branch = `clawo/${runId}`;
  fs.mkdirSync(path.dirname(worktree), { recursive: true });
  git(repo, ['worktree', 'add', '--quiet', '-b', branch, worktree, baseSha]);
  const linked = linkDependencies(repo, worktree, isolationLinks(spec));
  const sub = path.relative(repo, fs.realpathSync(cwd));
  return {
    isolation: { repo, worktree, branch, baseSha, linked },
    cwd: sub && !sub.startsWith('..') ? path.join(worktree, sub) : worktree,
  };
}

function linkDependencies(repo: string, worktree: string, names: string[]): string[] {
  const linked: string[] = [];
  for (const name of names) {
    if (!/^[\w.-]+$/.test(name)) continue;
    const source = path.join(repo, name);
    const target = path.join(worktree, name);
    if (!fs.existsSync(source) || fs.existsSync(target)) continue;
    // A tracked directory is in the worktree already; only untracked ones are linked.
    try {
      if (git(repo, ['ls-files', '--', name])) continue;
    } catch {
      continue;
    }
    fs.symlinkSync(source, target);
    linked.push(name);
    if (!ignored(worktree, name)) excludeInRepo(repo, name);
  }
  return linked;
}

function ignored(worktree: string, name: string): boolean {
  try {
    execFileSync('git', ['-C', worktree, 'check-ignore', '-q', '--', name], { stdio: 'ignore', timeout: 30_000 });
    return true;
  } catch {
    return false;
  }
}

function excludeInRepo(repo: string, name: string): void {
  const common = path.resolve(repo, git(repo, ['rev-parse', '--git-common-dir']));
  const file = path.join(common, 'info', 'exclude');
  const line = `/${name}`;
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (current.split('\n').includes(line)) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${current && !current.endsWith('\n') ? '\n' : ''}${line}\n`);
}

/** Where a directory of the caller's checkout is in the run's worktree; others unchanged. */
export function inWorktree(dir: string, isolation: RunIsolation): string {
  if (!path.isAbsolute(dir)) return dir;
  let resolved = dir;
  try {
    resolved = fs.realpathSync(dir);
  } catch {
    // Not there yet: map it as written.
  }
  const rel = path.relative(isolation.repo, resolved);
  if (rel === '') return isolation.worktree;
  return rel.startsWith('..') || path.isAbsolute(rel) ? dir : path.join(isolation.worktree, rel);
}

/**
 * The spec with every directory of the caller's checkout moved into the run's
 * worktree: the run's, each node's and fan-out agent's, and each check's. A
 * relative directory is already relative to the run's cwd, which is the
 * worktree's; one outside the checkout stays where it is.
 */
export function specInWorktree(spec: WorkflowSpec, isolation: RunIsolation): WorkflowSpec {
  const move = (dir: unknown): unknown => (typeof dir === 'string' && dir ? inWorktree(dir, isolation) : dir);
  const contract = (c: unknown): unknown => {
    if (!c || typeof c !== 'object' || !Array.isArray((c as { checks?: unknown }).checks)) return c;
    const checks = (c as { checks: Array<Record<string, unknown>> }).checks.map((check) => {
      const s = check.spec as Record<string, unknown> | undefined;
      return s && typeof s.cwd === 'string' ? { ...check, spec: { ...s, cwd: move(s.cwd) } } : check;
    });
    return { ...(c as object), checks };
  };
  const nodes = spec.nodes.map((node) => {
    const n = { ...(node as unknown as Record<string, unknown>) };
    if (typeof n.cwd === 'string') n.cwd = move(n.cwd);
    if (typeof n.projectDir === 'string') n.projectDir = move(n.projectDir);
    if (Array.isArray(n.agents)) {
      n.agents = (n.agents as Array<Record<string, unknown>>).map((a) =>
        typeof a.cwd === 'string' ? { ...a, cwd: move(a.cwd) } : a,
      );
    }
    if (n.kind === 'verifier' && n.contract !== 'run') n.contract = contract(n.contract);
    return n as unknown as (typeof spec.nodes)[number];
  });
  return {
    ...spec,
    ...(spec.cwd ? { cwd: move(spec.cwd) as string } : {}),
    ...(spec.contract ? { contract: contract(spec.contract) as WorkflowSpec['contract'] } : {}),
    nodes,
  };
}

/** For a run that never started: its worktree and the branch made for it, with no work on it, go. */
export function discardRunWorktree(isolation: RunIsolation): void {
  try {
    git(isolation.repo, ['worktree', 'remove', '--force', isolation.worktree]);
  } catch {
    // Best-effort.
  }
  try {
    git(isolation.repo, ['branch', '-D', isolation.branch]);
  } catch {
    // Best-effort.
  }
}

/**
 * Save what the run left on its branch and remove the worktree. Returns the
 * commit (the base when there was nothing to save). Synchronous and bounded: it
 * runs as the run takes its terminal state.
 */
export function finalizeRunWorktree(isolation: RunIsolation, message: string): string {
  const wt = isolation.worktree;
  let commit = isolation.baseSha;
  if (fs.existsSync(wt)) {
    // The links point into the checkout; they are not the run's work.
    for (const name of isolation.linked) {
      try {
        fs.unlinkSync(path.join(wt, name));
      } catch {
        // Already gone.
      }
    }
    git(wt, ['add', '-A']);
    const staged = git(wt, ['diff', '--cached', '--name-only']);
    if (staged) {
      // The repository's own identity when it has one; hooks are skipped, as the
      // run's agents could write them.
      let identity: string[] = [];
      try {
        git(wt, ['config', 'user.email']);
      } catch {
        identity = ['-c', 'user.name=clawo', '-c', 'user.email=clawo@localhost'];
      }
      git(wt, [...identity, 'commit', '--quiet', '--no-verify', '-m', message]);
    }
    commit = git(wt, ['rev-parse', 'HEAD']);
  }
  try {
    git(isolation.repo, ['worktree', 'remove', '--force', wt]);
  } catch {
    // Removed by hand, or never fully added: prune what git still records.
    try {
      git(isolation.repo, ['worktree', 'prune']);
    } catch {
      // Best-effort.
    }
  }
  return commit;
}

/** Check the run's branch out again for a resume, when its worktree is gone. */
export function restoreRunWorktree(isolation: RunIsolation): void {
  if (fs.existsSync(isolation.worktree)) return;
  try {
    git(isolation.repo, ['worktree', 'prune']);
  } catch {
    // Best-effort.
  }
  git(isolation.repo, ['worktree', 'add', '--quiet', isolation.worktree, isolation.branch]);
  linkDependencies(isolation.repo, isolation.worktree, isolation.linked);
}
