/**
 * Baseline capture — the primitive nothing in this repo had.
 *
 * Two existing call sites tried to answer "what did this run change" and both
 * get it wrong in a way that matters:
 *
 *  - `council.ts` diffs `HEAD~20..HEAD` (with a `HEAD~10` fallback), a hardcoded
 *    magic window that silently returns nothing on shallow history and has no
 *    relationship to when the run actually started.
 *  - `autoloop/dispatcher.ts` runs a bare `git diff`, which lists tracked
 *    modifications only. Files the Coder *created* appear in neither the patch
 *    nor the `--name-only` fallback, yet the following `git add -A` commits them.
 *    So the Reviewer audits a diff that structurally cannot show new files.
 *
 * Here the base commit is recorded when the run starts, and the change set is
 * tracked-diff ∪ untracked-files. Nothing mutates the caller's index: untracked
 * files are rendered with `git diff --no-index /dev/null <file>`, which emits a
 * proper new-file patch without an `add -N`.
 */

import crypto from 'node:crypto';
import path from 'node:path';
import { exec } from '../kernel/exec.js';

const GIT_TIMEOUT_MS = 60_000;

export type ChangeStatus = 'added' | 'modified' | 'deleted' | 'untracked';

export interface ChangedFile {
  path: string;
  status: ChangeStatus;
  insertions: number;
  deletions: number;
}

/** `git rev-parse HEAD`, or undefined when cwd is not a repo (or has no commits yet). */
export async function captureBaseline(cwd: string): Promise<string | undefined> {
  const r = await exec('git', ['-C', cwd, 'rev-parse', 'HEAD'], { timeoutMs: GIT_TIMEOUT_MS });
  if (r.code !== 0) return undefined;
  const sha = r.out.trim();
  return /^[0-9a-f]{7,40}$/i.test(sha) ? sha : undefined;
}

async function untrackedFiles(cwd: string): Promise<string[]> {
  const r = await exec('git', ['-C', cwd, 'ls-files', '--others', '--exclude-standard'], {
    timeoutMs: GIT_TIMEOUT_MS,
  });
  if (r.code !== 0) return [];
  return r.out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

async function countLines(cwd: string, file: string): Promise<number> {
  const r = await exec('git', ['-C', cwd, 'diff', '--no-index', '--numstat', '/dev/null', file], {
    timeoutMs: GIT_TIMEOUT_MS,
  });
  // `--no-index` exits 1 when there are differences, which is the normal case here.
  const first = r.out.split('\n').find((l) => l.trim() !== '');
  if (!first) return 0;
  const n = Number(first.split('\t')[0]);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Everything the run touched since `baseSha`: tracked changes in the working
 * tree (committed or not) plus every untracked file.
 */
export async function changedFilesSince(cwd: string, baseSha: string | undefined): Promise<ChangedFile[]> {
  const files: ChangedFile[] = [];

  if (baseSha) {
    const r = await exec('git', ['-C', cwd, 'diff', '--numstat', '--no-renames', baseSha, '--'], {
      timeoutMs: GIT_TIMEOUT_MS,
    });
    if (r.code === 0) {
      for (const line of r.out.split('\n')) {
        const parts = line.split('\t');
        if (parts.length < 3) continue;
        const insertions = Number(parts[0]);
        const deletions = Number(parts[1]);
        const file = parts.slice(2).join('\t').trim();
        if (!file) continue;
        // A binary file reports "-\t-"; count it as touched with zero line deltas.
        files.push({
          path: file,
          status: deletions > 0 && insertions === 0 ? 'deleted' : 'modified',
          insertions: Number.isFinite(insertions) ? insertions : 0,
          deletions: Number.isFinite(deletions) ? deletions : 0,
        });
      }
    }
  }

  const seen = new Set(files.map((f) => f.path));
  for (const file of await untrackedFiles(cwd)) {
    if (seen.has(file)) continue;
    files.push({ path: file, status: 'untracked', insertions: await countLines(cwd, file), deletions: 0 });
  }

  return files.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * A unified patch covering the same set: `git diff <base>` for tracked changes,
 * then a synthetic new-file patch per untracked file appended after it.
 */
export async function capturePatch(cwd: string, baseSha: string | undefined): Promise<string> {
  const parts: string[] = [];

  if (baseSha) {
    const r = await exec('git', ['-C', cwd, 'diff', '--unified=3', '--no-renames', baseSha, '--'], {
      timeoutMs: GIT_TIMEOUT_MS,
    });
    if (r.code === 0 && r.out.trim()) parts.push(r.out.replace(/\n*$/, '\n'));
  }

  for (const file of await untrackedFiles(cwd)) {
    const r = await exec('git', ['-C', cwd, 'diff', '--no-index', '--unified=3', '/dev/null', file], {
      cwd,
      timeoutMs: GIT_TIMEOUT_MS,
    });
    // Exit 1 = "differences found", the expected outcome for a new file.
    if ((r.code === 0 || r.code === 1) && r.out.trim()) parts.push(r.out.replace(/\n*$/, '\n'));
  }

  return parts.join('');
}

/**
 * A cheap digest of the working tree's current state.
 *
 * Evidence describes the tree as it was when the checks ran. If anything moves
 * afterwards the bundle still exists but no longer describes what is there, and
 * a run that keeps reporting `verified` on the strength of it is claiming
 * something nobody measured. Comparing this before and after is how the kernel
 * notices.
 *
 * `git status --porcelain` covers tracked modifications, staged changes, and
 * untracked files; HEAD covers commits. Returns undefined outside a repo — a
 * caller that cannot fingerprint must not assume the tree held still.
 */
export async function treeFingerprint(cwd: string): Promise<string | undefined> {
  const head = await exec('git', ['-C', cwd, 'rev-parse', 'HEAD'], { timeoutMs: GIT_TIMEOUT_MS });
  const status = await exec('git', ['-C', cwd, 'status', '--porcelain'], { timeoutMs: GIT_TIMEOUT_MS });
  if (status.code !== 0) return undefined;
  return crypto
    .createHash('sha256')
    .update(`${head.code === 0 ? head.out.trim() : 'no-head'}\n${status.out}`)
    .digest('hex');
}

/**
 * True when `file` sits under `prefix`.
 *
 * Segment-aware, so `srcfoo/a.ts` is not under `src`. `.` and `''` both mean the
 * repo root and match everything — without that, a policy of `requirePaths: ['.']`
 * ("the run must change something") reports that nothing changed no matter what
 * the run did.
 */
export function isUnder(file: string, prefix: string): boolean {
  const norm = (p: string): string =>
    p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '').replace(/^\.$/, '');
  const f = norm(file);
  const p = norm(prefix);
  if (p === '') return true;
  return f === p || f.startsWith(p + '/');
}

/** Resolve a check-relative path against the run cwd. */
export function resolveIn(cwd: string, p: string): string {
  return path.isAbsolute(p) ? p : path.join(cwd, p);
}
