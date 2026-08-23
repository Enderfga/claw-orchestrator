/**
 * Baseline capture, against a real git repo in a temp dir.
 *
 * The headline case is the untracked file. `autoloop/dispatcher.ts` captures its
 * per-iteration patch with a bare `git diff`, which lists tracked modifications
 * only — so a file the agent *created* appears in neither the patch nor the
 * `--name-only` fallback, while the following `git add -A` commits it anyway.
 * The Reviewer then audits a diff that structurally cannot show new files. These
 * tests pin the fixed behaviour.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exec } from '../../kernel/exec.js';
import { capturePatch, captureBaseline, changedFilesSince, isUnder } from '../../verify/baseline.js';
import { runChecks } from '../../verify/runner.js';
import { normalizeContract } from '../../verify/contract.js';

let repo: string;

async function git(...args: string[]): Promise<void> {
  const r = await exec('git', ['-C', repo, ...args]);
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.err || r.out}`);
}

beforeEach(async () => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'clawo-baseline-'));
  await git('init', '-b', 'main');
  await git('config', 'user.email', 'test@example.com');
  await git('config', 'user.name', 'test');
  fs.writeFileSync(path.join(repo, 'existing.txt'), 'one\n');
  await git('add', '-A');
  await git('commit', '-m', 'base');
});

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

describe('captureBaseline', () => {
  it('records the current HEAD', async () => {
    const sha = await captureBaseline(repo);
    expect(sha).toMatch(/^[0-9a-f]{7,40}$/);
  });

  it('returns undefined outside a repo instead of inventing a base', async () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'clawo-norepo-'));
    try {
      expect(await captureBaseline(plain)).toBeUndefined();
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }
  });
});

describe('changedFilesSince', () => {
  it('sees a modification to a tracked file', async () => {
    const base = await captureBaseline(repo);
    fs.writeFileSync(path.join(repo, 'existing.txt'), 'one\ntwo\n');
    const changed = await changedFilesSince(repo, base);
    expect(changed.map((c) => c.path)).toContain('existing.txt');
    expect(changed.find((c) => c.path === 'existing.txt')?.status).toBe('modified');
  });

  it('sees a NEWLY CREATED file — the case a bare `git diff` misses entirely', async () => {
    const base = await captureBaseline(repo);
    fs.writeFileSync(path.join(repo, 'brand-new.ts'), 'export const x = 1;\n');
    const changed = await changedFilesSince(repo, base);
    const created = changed.find((c) => c.path === 'brand-new.ts');
    expect(created).toBeDefined();
    expect(created?.status).toBe('untracked');
    expect(created?.insertions).toBeGreaterThan(0);
  });

  it('sees created files that were subsequently committed', async () => {
    const base = await captureBaseline(repo);
    fs.writeFileSync(path.join(repo, 'committed-new.ts'), 'export const y = 2;\n');
    await git('add', '-A');
    await git('commit', '-m', 'add file');
    const changed = await changedFilesSince(repo, base);
    expect(changed.map((c) => c.path)).toContain('committed-new.ts');
  });

  it('does not double-count a file that is both committed and modified after', async () => {
    const base = await captureBaseline(repo);
    fs.writeFileSync(path.join(repo, 'x.ts'), 'a\n');
    await git('add', '-A');
    await git('commit', '-m', 'add x');
    fs.writeFileSync(path.join(repo, 'x.ts'), 'a\nb\n');
    const changed = await changedFilesSince(repo, base);
    expect(changed.filter((c) => c.path === 'x.ts')).toHaveLength(1);
  });

  it('respects .gitignore for untracked files', async () => {
    const base = await captureBaseline(repo);
    fs.writeFileSync(path.join(repo, '.gitignore'), 'ignored/\n');
    fs.mkdirSync(path.join(repo, 'ignored'));
    fs.writeFileSync(path.join(repo, 'ignored', 'junk.log'), 'noise\n');
    const changed = await changedFilesSince(repo, base);
    expect(changed.map((c) => c.path)).not.toContain('ignored/junk.log');
  });
});

describe('capturePatch', () => {
  it('includes a new-file hunk for an untracked file', async () => {
    const base = await captureBaseline(repo);
    fs.writeFileSync(path.join(repo, 'created.ts'), 'export const z = 3;\n');
    const patch = await capturePatch(repo, base);
    expect(patch).toContain('created.ts');
    expect(patch).toContain('+export const z = 3;');
  });

  it('includes tracked modifications alongside', async () => {
    const base = await captureBaseline(repo);
    fs.writeFileSync(path.join(repo, 'existing.txt'), 'one\nchanged\n');
    fs.writeFileSync(path.join(repo, 'created.ts'), 'new\n');
    const patch = await capturePatch(repo, base);
    expect(patch).toContain('existing.txt');
    expect(patch).toContain('created.ts');
  });

  it('is empty when nothing changed', async () => {
    const base = await captureBaseline(repo);
    expect((await capturePatch(repo, base)).trim()).toBe('');
  });
});

describe('diff_policy check', () => {
  const ctx = () => ({ cwd: repo, artifactDir: path.join(repo, '.artifacts') });

  it('fails when a forbidden path is touched, including by creation', async () => {
    const base = await captureBaseline(repo);
    fs.mkdirSync(path.join(repo, 'config'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'config', 'prod.json'), '{}\n');
    const c = normalizeContract({ checks: [{ type: 'diff_policy', forbidPaths: ['config'] }] })!;
    const [r] = await runChecks(c, { ...ctx(), baseSha: base });
    expect(r.passed).toBe(false);
    expect(r.detail).toContain('config');
  });

  it('enforces a max file count', async () => {
    const base = await captureBaseline(repo);
    for (const n of ['a', 'b', 'c']) fs.writeFileSync(path.join(repo, `${n}.txt`), 'x\n');
    const c = normalizeContract({ checks: [{ type: 'diff_policy', maxFiles: 2 }] })!;
    const [r] = await runChecks(c, { ...ctx(), baseSha: base });
    expect(r.passed).toBe(false);
    expect(r.detail).toContain('limit 2');
  });

  it('requires at least one change under a required path', async () => {
    const base = await captureBaseline(repo);
    fs.writeFileSync(path.join(repo, 'README.md'), 'docs only\n');
    const c = normalizeContract({ checks: [{ type: 'diff_policy', requirePaths: ['src'] }] })!;
    const [r] = await runChecks(c, { ...ctx(), baseSha: base });
    expect(r.passed).toBe(false);
    expect(r.detail).toContain('no change under');
  });

  it('passes a clean policy', async () => {
    const base = await captureBaseline(repo);
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'src', 'index.ts'), 'export {};\n');
    const c = normalizeContract({
      checks: [{ type: 'diff_policy', maxFiles: 5, requirePaths: ['src'], forbidPaths: ['config'] }],
    })!;
    const [r] = await runChecks(c, { ...ctx(), baseSha: base });
    expect(r.passed).toBe(true);
  });
});

describe('isUnder', () => {
  it('is path-segment aware, so a prefix match is not enough', () => {
    expect(isUnder('src/a.ts', 'src')).toBe(true);
    expect(isUnder('src', 'src')).toBe(true);
    expect(isUnder('srcfoo/a.ts', 'src')).toBe(false);
    expect(isUnder('./src/a.ts', 'src/')).toBe(true);
  });

  it("treats '.' and '' as the repo root, so a require-anything policy works", () => {
    // Found by the end-to-end run: `requirePaths: ['.']` reported "no change
    // under any of: ." while a created file sat right there in the change set.
    expect(isUnder('created-by-agent.ts', '.')).toBe(true);
    expect(isUnder('deep/nested/file.ts', '.')).toBe(true);
    expect(isUnder('a.ts', '')).toBe(true);
    expect(isUnder('a.ts', './')).toBe(true);
  });
});
