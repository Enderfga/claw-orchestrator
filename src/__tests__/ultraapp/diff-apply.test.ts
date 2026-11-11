import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { applyUnifiedDiff } from '../../ultraapp/diff-apply.js';

describe('applyUnifiedDiff', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ua-diff-'));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('applies a simple modify hunk', () => {
    fs.writeFileSync(path.join(tmp, 'a.txt'), 'hello\nworld\n');
    const diff = `--- a/a.txt
+++ b/a.txt
@@ -1,2 +1,2 @@
 hello
-world
+universe
`;
    const r = applyUnifiedDiff(diff, tmp);
    expect(r.ok).toBe(true);
    expect(fs.readFileSync(path.join(tmp, 'a.txt'), 'utf8')).toBe('hello\nuniverse\n');
  });

  it('creates a new file (--- /dev/null)', () => {
    const diff = `--- /dev/null
+++ b/new.txt
@@ -0,0 +1,2 @@
+line1
+line2
`;
    const r = applyUnifiedDiff(diff, tmp);
    expect(r.ok).toBe(true);
    expect(fs.readFileSync(path.join(tmp, 'new.txt'), 'utf8')).toBe('line1\nline2\n');
  });

  it('deletes a file (+++ /dev/null)', () => {
    fs.writeFileSync(path.join(tmp, 'gone.txt'), 'bye\n');
    const diff = `--- a/gone.txt
+++ /dev/null
@@ -1,1 +0,0 @@
-bye
`;
    const r = applyUnifiedDiff(diff, tmp);
    expect(r.ok).toBe(true);
    expect(fs.existsSync(path.join(tmp, 'gone.txt'))).toBe(false);
  });

  it('reports conflict when context lines do not match', () => {
    fs.writeFileSync(path.join(tmp, 'a.txt'), 'completely different\n');
    const diff = `--- a/a.txt
+++ b/a.txt
@@ -1,1 +1,1 @@
-hello
+goodbye
`;
    const r = applyUnifiedDiff(diff, tmp);
    expect(r.ok).toBe(false);
    expect(r.conflicts!.length).toBeGreaterThan(0);
  });

  it('applies a multi-file diff', () => {
    fs.writeFileSync(path.join(tmp, 'a.txt'), 'a1\n');
    fs.writeFileSync(path.join(tmp, 'b.txt'), 'b1\n');
    const diff = `--- a/a.txt
+++ b/a.txt
@@ -1,1 +1,1 @@
-a1
+a2
--- a/b.txt
+++ b/b.txt
@@ -1,1 +1,1 @@
-b1
+b2
`;
    const r = applyUnifiedDiff(diff, tmp);
    expect(r.ok).toBe(true);
    expect(fs.readFileSync(path.join(tmp, 'a.txt'), 'utf8')).toBe('a2\n');
    expect(fs.readFileSync(path.join(tmp, 'b.txt'), 'utf8')).toBe('b2\n');
  });

  it('creates parent directories when patching a nested new file', () => {
    const diff = `--- /dev/null
+++ b/sub/dir/x.txt
@@ -0,0 +1,1 @@
+nested
`;
    const r = applyUnifiedDiff(diff, tmp);
    expect(r.ok).toBe(true);
    expect(fs.readFileSync(path.join(tmp, 'sub', 'dir', 'x.txt'), 'utf8')).toBe('nested\n');
  });
  it('applies two patches to the same file in order', () => {
    fs.writeFileSync(path.join(tmp, 'a.txt'), 'one\ntwo\n');
    const diff = `--- a/a.txt
+++ b/a.txt
@@ -1,2 +1,2 @@
-one
+uno
 two
--- a/a.txt
+++ b/a.txt
@@ -1,2 +1,2 @@
 uno
-two
+dos
`;
    expect(applyUnifiedDiff(diff, tmp).ok).toBe(true);
    expect(fs.readFileSync(path.join(tmp, 'a.txt'), 'utf8')).toBe('uno\ndos\n');
  });
});

/**
 * The diff is model output: its file names must not reach outside the worktree,
 * by `..`, an absolute path, or a symlink, and one bad file must leave the
 * whole worktree untouched.
 */
describe('applyUnifiedDiff keeps to the worktree', () => {
  let base: string;
  let tree: string;
  let outside: string;
  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'ua-diff-jail-'));
    tree = path.join(base, 'tree');
    outside = path.join(base, 'outside');
    fs.mkdirSync(tree);
    fs.mkdirSync(outside);
  });
  afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

  const create = (name: string) => `--- /dev/null
+++ b/${name}
@@ -0,0 +1,1 @@
+planted
`;

  it('refuses a new file whose name climbs out with ..', () => {
    const r = applyUnifiedDiff(create('../outside/planted.txt'), tree);
    expect(r.ok).toBe(false);
    expect(r.conflicts![0].reason).toMatch(/outside the worktree/);
    expect(fs.existsSync(path.join(outside, 'planted.txt'))).toBe(false);
  });

  it('refuses to change or delete a file outside through ..', () => {
    fs.writeFileSync(path.join(outside, 'victim.txt'), 'keep\n');
    const modify = `--- a/../outside/victim.txt
+++ b/../outside/victim.txt
@@ -1,1 +1,1 @@
-keep
+changed
`;
    const remove = `--- a/../outside/victim.txt
+++ /dev/null
@@ -1,1 +0,0 @@
-keep
`;
    expect(applyUnifiedDiff(modify, tree).ok).toBe(false);
    expect(applyUnifiedDiff(remove, tree).ok).toBe(false);
    expect(fs.readFileSync(path.join(outside, 'victim.txt'), 'utf8')).toBe('keep\n');
  });

  it('refuses an absolute file name', () => {
    const target = path.join(outside, 'abs.txt');
    expect(applyUnifiedDiff(create(target).replace('b/' + target, target), tree).ok).toBe(false);
    expect(fs.existsSync(target)).toBe(false);
  });

  it('refuses to write through a symlinked directory that leads out', () => {
    fs.symlinkSync(outside, path.join(tree, 'link'));
    expect(applyUnifiedDiff(create('link/planted.txt'), tree).ok).toBe(false);
    expect(applyUnifiedDiff(create('link/deeper/planted.txt'), tree).ok).toBe(false);
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it('refuses to write through a dangling symlink that points out', () => {
    fs.symlinkSync(path.join(outside, 'made.txt'), path.join(tree, 'dangling.txt'));
    expect(applyUnifiedDiff(create('dangling.txt'), tree).ok).toBe(false);
    expect(fs.existsSync(path.join(outside, 'made.txt'))).toBe(false);
  });

  it('follows a symlink that stays inside the worktree', () => {
    fs.mkdirSync(path.join(tree, 'real'));
    fs.symlinkSync(path.join(tree, 'real'), path.join(tree, 'alias'));
    expect(applyUnifiedDiff(create('alias/ok.txt'), tree).ok).toBe(true);
    expect(fs.readFileSync(path.join(tree, 'real', 'ok.txt'), 'utf8')).toBe('planted\n');
  });

  it('writes nothing when any file in the diff is refused or conflicts', () => {
    fs.writeFileSync(path.join(tree, 'a.txt'), 'a1\n');
    const escaping = `--- a/a.txt
+++ b/a.txt
@@ -1,1 +1,1 @@
-a1
+a2
${create('../outside/planted.txt')}`;
    expect(applyUnifiedDiff(escaping, tree).ok).toBe(false);
    const conflicting = `--- a/a.txt
+++ b/a.txt
@@ -1,1 +1,1 @@
-a1
+a2
--- a/missing.txt
+++ b/missing.txt
@@ -1,1 +1,1 @@
-x
+y
`;
    expect(applyUnifiedDiff(conflicting, tree).ok).toBe(false);
    expect(fs.readFileSync(path.join(tree, 'a.txt'), 'utf8')).toBe('a1\n');
    expect(fs.readdirSync(outside)).toEqual([]);
  });
});
