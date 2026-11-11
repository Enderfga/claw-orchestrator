/**
 * Minimal unified-diff applier — wraps the well-tested `diff` npm package
 * (BSD-2). Used by the patcher for cosmetic post-deploy changes.
 *
 * Handles multi-file diffs, --- /dev/null create, +++ /dev/null delete,
 * and reports per-file conflicts when context lines don't match.
 *
 * The diff comes from a model, so its file names are not trusted: every target
 * must resolve inside `cwd`, through symlinks too. The whole diff is checked
 * and computed before anything is written, so a diff with one bad or
 * conflicting file changes nothing.
 */

import * as Diff from 'diff';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface ApplyResult {
  ok: boolean;
  conflicts?: Array<{ file: string; reason: string }>;
}

export function applyUnifiedDiff(diff: string, cwd: string): ApplyResult {
  const root = fs.realpathSync(cwd);
  const patches = Diff.parsePatch(diff);
  const conflicts: Array<{ file: string; reason: string }> = [];
  // Target → its new content, or null to delete it. Later patches to the same
  // file apply on top of earlier ones.
  const pending = new Map<string, string | null>();

  for (const patch of patches) {
    const oldFile = patch.oldFileName ?? '';
    const newFile = patch.newFileName ?? '';
    const isCreate = oldFile === '/dev/null';
    const isDelete = newFile === '/dev/null';
    const targetRel = (isDelete ? oldFile : newFile).replace(/^[ab]\//, '');
    const target = resolveInside(root, targetRel);
    if (!target) {
      conflicts.push({ file: targetRel, reason: 'path is outside the worktree' });
      continue;
    }

    if (isDelete) {
      if (pending.get(target) === null || (!pending.has(target) && !fs.existsSync(target))) {
        conflicts.push({ file: targetRel, reason: 'no such file to delete' });
      } else {
        pending.set(target, null);
      }
      continue;
    }

    let original: string;
    if (isCreate) {
      original = '';
    } else if (pending.has(target)) {
      const prior = pending.get(target);
      if (prior === null) {
        conflicts.push({ file: targetRel, reason: 'file was deleted earlier in this diff' });
        continue;
      }
      original = prior as string;
    } else {
      try {
        original = fs.readFileSync(target, 'utf8');
      } catch (e) {
        conflicts.push({ file: targetRel, reason: `read failed: ${(e as Error).message}` });
        continue;
      }
    }
    const next = Diff.applyPatch(original, patch);
    if (next === false) {
      conflicts.push({ file: targetRel, reason: 'context mismatch' });
      continue;
    }
    pending.set(target, next);
  }

  if (conflicts.length > 0) return { ok: false, conflicts };

  for (const [target, content] of pending) {
    const file = path.relative(root, target);
    try {
      if (content === null) {
        fs.unlinkSync(target);
      } else {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content);
      }
    } catch (e) {
      conflicts.push({ file, reason: (e as Error).message });
    }
  }
  return conflicts.length === 0 ? { ok: true } : { ok: false, conflicts };
}

/** `p` is `root` or below it. Both must be absolute. */
function isInside(root: string, p: string): boolean {
  const rel = path.relative(root, p);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
}

/**
 * The absolute target for a diff file name, or null when it would land outside
 * `root` (already a real path): an empty or absolute name, `..` segments, or a
 * symlink — on the target or any directory above it — that leads out. A
 * target that does not exist yet is judged by its nearest existing ancestor.
 */
function resolveInside(root: string, rel: string): string | null {
  if (!rel || rel.includes('\0') || path.isAbsolute(rel)) return null;
  const target = path.resolve(root, rel);
  if (target === root || !isInside(root, target)) return null;
  let probe = target;
  for (;;) {
    try {
      fs.lstatSync(probe);
      break;
    } catch {
      probe = path.dirname(probe);
    }
  }
  let real: string;
  try {
    real = fs.realpathSync(probe);
  } catch {
    return null; // a dangling symlink: writing through it would create its target, wherever that is
  }
  return isInside(root, real) ? target : null;
}
