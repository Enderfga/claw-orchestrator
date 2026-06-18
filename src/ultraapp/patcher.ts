/**
 * Cosmetic-feedback patcher.
 *
 * Single-shot LLM call (caller injects the model — production wires this to
 * Opus). Output: a unified diff. We:
 *   1. take an in-memory snapshot of the worktree (text files only)
 *   2. apply the diff
 *   3. ask the validator to drive `npm install/build/test/docker build` with
 *      a fix-on-failure budget
 *   4. on any failure, restore the snapshot exactly
 *
 * The `validate` collaborator is `runFixOnFailure` in production wiring (the
 * v0.2 helper); we keep the parameter name generic here so this module
 * doesn't take a hard dep on the helper's name.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { applyUnifiedDiff } from './diff-apply.js';

export interface PatcherArgs {
  worktreePath: string;
  feedback: string;
  llmCall: (prompt: string) => Promise<{ output: string }>;
  validate: (a: { worktreePath: string }) => Promise<{ ok: boolean; reason?: string; rounds: number }>;
}

export interface PatcherResult {
  ok: boolean;
  reason?: string;
  newWorktreePath?: string;
}

const PATCHER_PROMPT = (
  codebaseSummary: string,
  feedback: string,
) => `You are the ultraapp patcher. The user has an already-deployed web app and
wants a small change. Your task: produce a unified diff (the exact format git
diff produces, with --- a/ and +++ b/ headers) that implements the user's
request.

## Constraints

- DO NOT change the AppSpec or pipeline behaviour. If the request implies a
  spec/pipeline change, refuse with the literal text "[OUT OF SCOPE: spec change required]".
- Touch as few files as possible. Surgical changes only.
- Preserve all architectural conventions (path-based deploy, async file-queue
  endpoints, BYOK, smoke test).
- Output ONLY a fenced \`\`\`diff block. No commentary.

## Codebase summary

${codebaseSummary}

## User feedback

${feedback}

Produce the diff now.`;

const DIFF_RE = /```diff\s*\n([\s\S]*?)\n```/;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.next', 'build']);

export async function runPatcher(args: PatcherArgs): Promise<PatcherResult> {
  const summary = summariseCodebase(args.worktreePath);
  const r = await args.llmCall(PATCHER_PROMPT(summary, args.feedback));
  if (r.output.includes('[OUT OF SCOPE')) {
    return {
      ok: false,
      reason: 'patcher refused — feedback requires a spec change (use spec-delta)',
    };
  }
  const m = DIFF_RE.exec(r.output);
  if (!m) return { ok: false, reason: 'patcher did not return a diff' };

  const backup = snapshotDir(args.worktreePath);
  const apply = applyUnifiedDiff(m[1], args.worktreePath);
  if (!apply.ok) {
    restoreSnapshot(args.worktreePath, backup);
    return { ok: false, reason: 'diff apply conflict: ' + JSON.stringify(apply.conflicts) };
  }
  const v = await args.validate({ worktreePath: args.worktreePath });
  if (!v.ok) {
    restoreSnapshot(args.worktreePath, backup);
    return { ok: false, reason: `validate failed: ${v.reason ?? 'unknown'}` };
  }
  return { ok: true, newWorktreePath: args.worktreePath };
}

function summariseCodebase(dir: string): string {
  const out: string[] = [];
  const walk = (p: string, depth = 0) => {
    if (depth > 3) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(p, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (SKIP_DIRS.has(e.name)) continue;
      const full = path.join(p, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else out.push(path.relative(dir, full));
    }
  };
  walk(dir);
  return out.slice(0, 200).join('\n');
}

function snapshotDir(dir: string): Map<string, Buffer> {
  // Snapshot as raw bytes (not utf8) so binary files are captured too. Reading
  // as utf8 and skipping unreadable files used to drop binaries from the
  // snapshot, and restore then deleted them as "not in snapshot" — data loss.
  const snap = new Map<string, Buffer>();
  const walk = (p: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(p, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (SKIP_DIRS.has(e.name)) continue;
      const full = path.join(p, e.name);
      if (e.isDirectory()) walk(full);
      else {
        try {
          snap.set(full, fs.readFileSync(full));
        } catch {
          /* truly unreadable (permission) — skip */
        }
      }
    }
  };
  walk(dir);
  return snap;
}

function restoreSnapshot(dir: string, snap: Map<string, Buffer>): void {
  const seen = new Set<string>();
  const walk = (p: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(p, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (SKIP_DIRS.has(e.name)) continue;
      const full = path.join(p, e.name);
      if (e.isDirectory()) walk(full);
      else seen.add(full);
    }
  };
  walk(dir);
  // Restore every snapshot file FIRST (atomically per file: write a temp then
  // rename, so a crash mid-write never leaves a half-written file), and only
  // then delete extras. The whole pass is also idempotent — re-running restore
  // after an interrupted attempt completes it.
  for (const [file, content] of snap) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.restore-${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, content);
      fs.renameSync(tmp, file);
    } catch (err) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* tmp may not exist */
      }
      throw err;
    }
  }
  for (const file of seen) {
    if (!snap.has(file)) {
      try {
        fs.unlinkSync(file);
      } catch {
        /* best effort */
      }
    }
  }
}
