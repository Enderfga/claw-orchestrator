/**
 * A run in a worktree of its own: it works from the repository's HEAD, the
 * caller's checkout is never written, and what it leaves is committed to a
 * local branch `clawo/<runId>` when it ends — verified or not — and the
 * worktree goes. Real git, a fake agent.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RunKernel } from '../../kernel/engine.js';
import { registerDefaultExecutors } from '../../kernel/nodes/index.js';
import { loadRun } from '../../kernel/store.js';
import type { WorkflowSpec } from '../../kernel/types.js';

let tmp: string;
let repo: string;
const saved = process.env.CLAWO_WF_DIR;

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clawo-iso-')));
  process.env.CLAWO_WF_DIR = path.join(tmp, 'state', 'wf');
  repo = path.join(tmp, 'repo');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'a.js'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n');
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.email', 't@e');
  git(repo, 'config', 'user.name', 't');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'base');
  // An installed dependency the repository does not track.
  fs.mkdirSync(path.join(repo, 'node_modules', 'dep'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'node_modules', 'dep', 'index.js'), 'module.exports = 42;\n');
});
afterEach(() => {
  if (saved === undefined) delete process.env.CLAWO_WF_DIR;
  else process.env.CLAWO_WF_DIR = saved;
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** A kernel whose agent writes `src/a.js` in its cwd and records what it could see there. */
function kernelWritingIn(seen: Array<{ cwd: string; dep: boolean }>) {
  const kernel = registerDefaultExecutors(new RunKernel({ nodeTimeoutMs: 20_000 }));
  kernel.setExecutor('agent', async (node, ctx) => {
    const cwd = (node as { cwd?: string }).cwd || ctx.cwd;
    seen.push({ cwd, dep: fs.existsSync(path.join(cwd, 'node_modules', 'dep', 'index.js')) });
    fs.writeFileSync(path.join(cwd, 'src', 'a.js'), 'module.exports = 2;\n');
    fs.writeFileSync(path.join(cwd, 'NEW.md'), 'made by the run\n');
    return { ok: true, output: 'edited' };
  });
  return kernel;
}

const editRun = (extra: Partial<WorkflowSpec> = {}): WorkflowSpec => ({
  name: 'edit',
  cwd: repo,
  isolation: 'worktree',
  nodes: [{ id: 'impl', kind: 'agent', prompt: 'edit', cwd: repo }],
  ...extra,
});

describe('a run in its own worktree', () => {
  it('works from HEAD in the worktree, leaves the checkout alone, and saves its work to clawo/<runId>', async () => {
    // An uncommitted change in the checkout is not the run's.
    fs.writeFileSync(path.join(repo, 'WIP.txt'), 'mine\n');
    const seen: Array<{ cwd: string; dep: boolean }> = [];
    const kernel = kernelWritingIn(seen);
    // Judged in the worktree: the linked node_modules is not one of the run's changes.
    const run = await kernel.start(
      editRun({ contract: { checks: [{ spec: { type: 'diff_policy', maxFiles: 2 } }] } as never }),
    );
    const done = await kernel.wait(run.runId);

    expect(done!.state).toBe('completed');
    expect(done!.outcome).toBe('verified');
    const iso = done!.isolation!;
    // The node's absolute cwd in the checkout was moved into the worktree.
    expect(seen[0].cwd).toBe(iso.worktree);
    expect(seen[0].dep).toBe(true);
    // The checkout: untouched, the uncommitted change still there and still only there.
    expect(fs.readFileSync(path.join(repo, 'src', 'a.js'), 'utf8')).toBe('module.exports = 1;\n');
    expect(fs.existsSync(path.join(repo, 'NEW.md'))).toBe(false);
    expect(git(repo, 'status', '--porcelain')).toBe('?? WIP.txt');
    // The branch holds the work, on the base, without the linked dependencies.
    expect(iso).toMatchObject({ branch: `clawo/${run.runId}`, removed: true, linked: ['node_modules'] });
    expect(git(repo, 'rev-parse', iso.branch)).toBe(iso.commit);
    expect(git(repo, 'rev-parse', `${iso.branch}~1`)).toBe(iso.baseSha);
    expect(git(repo, 'show', '--name-only', '--format=', iso.branch).split('\n').sort()).toEqual([
      'NEW.md',
      'src/a.js',
    ]);
    expect(git(repo, 'log', '-1', '--format=%s', iso.branch)).toMatch(/: completed, verified$/);
    // The worktree is gone; git no longer lists it.
    expect(fs.existsSync(iso.worktree)).toBe(false);
    expect(git(repo, 'worktree', 'list')).not.toContain(iso.worktree);
  });

  it('saves a refuted attempt too, so it can be read', async () => {
    const kernel = kernelWritingIn([]);
    const run = await kernel.start(
      editRun({ contract: { checks: [{ spec: { type: 'file', path: 'src/a.js', matches: 'module.exports = 3' } }] } }),
    );
    const done = await kernel.wait(run.runId);
    expect(done!.outcome).toBe('refuted');
    expect(git(repo, 'log', '-1', '--format=%s', done!.isolation!.branch)).toMatch(/: failed, refuted$/);
    expect(git(repo, 'show', `${done!.isolation!.branch}:src/a.js`)).toBe('module.exports = 2;');
  });

  it('gets its worktree back on the branch when a finished run is resumed', async () => {
    const kernel = kernelWritingIn([]);
    const run = await kernel.start(editRun());
    const done = await kernel.wait(run.runId);
    const iso = done!.isolation!;
    expect(fs.existsSync(iso.worktree)).toBe(false);
    await kernel.resume(run.runId, { restart: true });
    const again = await kernel.wait(run.runId);
    // It worked on the branch it had saved, and saved again.
    expect(again!.isolation).toMatchObject({ removed: true });
    expect(git(repo, 'rev-parse', `${iso.branch}`)).toBe(again!.isolation!.commit);
    expect(loadRun(run.runId)!.state).toBe('completed');
  });

  it('refuses a directory that is not in a git repository', async () => {
    const plain = path.join(tmp, 'plain');
    fs.mkdirSync(plain);
    const kernel = kernelWritingIn([]);
    await expect(
      kernel.start({ ...editRun(), cwd: plain, nodes: [{ id: 'a', kind: 'agent', prompt: 'x' }] }),
    ).rejects.toThrow(/isolation 'worktree' needs a git repository/);
  });
});

describe('the worktree directory', () => {
  it('is gone when the run ends, with nothing left beside it', async () => {
    const kernel = kernelWritingIn([]);
    const run = await kernel.start(editRun());
    const done = await kernel.wait(run.runId);
    const root = path.dirname(done!.isolation!.worktree);
    expect(fs.existsSync(done!.isolation!.worktree)).toBe(false);
    expect(fs.readdirSync(root)).toEqual([]);
  });
});
