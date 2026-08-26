/**
 * Evidence bundles. Real git repo, real files — the bundle's whole job is to be
 * readable after the process that wrote it is gone, so the assertions are on
 * what is on disk.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exec } from '../../kernel/exec.js';
import { captureBaseline } from '../../verify/baseline.js';
import {
  evidenceDir,
  formatEvidence,
  listEvidence,
  makeEvidenceId,
  readEvidence,
  writeEvidence,
} from '../../verify/evidence.js';
import type { CheckResult } from '../../verify/contract.js';

let repo: string;
let runRoot: string;

const pass = (id: string): CheckResult => ({
  id,
  type: 'command',
  required: true,
  passed: true,
  durationMs: 5,
  detail: `\`${id}\` exited 0`,
});
const failWith = (id: string, tail: string): CheckResult => ({
  id,
  type: 'command',
  required: true,
  passed: false,
  durationMs: 5,
  detail: `\`${id}\` exited 1, expected 0`,
  tail,
});

beforeEach(async () => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'clawo-ev-repo-'));
  runRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'clawo-ev-run-'));
  await exec('git', ['-C', repo, 'init', '-b', 'main']);
  await exec('git', ['-C', repo, 'config', 'user.email', 't@example.com']);
  await exec('git', ['-C', repo, 'config', 'user.name', 't']);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  await exec('git', ['-C', repo, 'add', '-A']);
  await exec('git', ['-C', repo, 'commit', '-m', 'base']);
});

afterEach(() => {
  for (const d of [repo, runRoot]) fs.rmSync(d, { recursive: true, force: true });
});

describe('writeEvidence', () => {
  it('records the verdict and every check', async () => {
    const bundle = await writeEvidence({
      runDir: runRoot,
      runId: 'r1',
      node: 'verify',
      evidenceId: 'verify-01',
      cwd: repo,
      results: [pass('build'), failWith('test', 'AssertionError: expected 1 to be 2')],
      rounds: 1,
    });
    expect(bundle.passed).toBe(false);
    expect(bundle.results).toHaveLength(2);
    expect(bundle.rounds).toBe(1);

    const onDisk = readEvidence(runRoot, 'verify-01')!;
    expect(onDisk.passed).toBe(false);
    expect(onDisk.results.map((r) => r.id)).toEqual(['build', 'test']);
  });

  it('writes the failure tail to its own file so a long log is readable', async () => {
    await writeEvidence({
      runDir: runRoot,
      runId: 'r1',
      node: 'verify',
      evidenceId: 'verify-01',
      cwd: repo,
      results: [failWith('test', 'AssertionError: expected 1 to be 2')],
      rounds: 0,
    });
    const log = path.join(evidenceDir(runRoot, 'verify-01'), 'checks', 'test.log');
    expect(fs.readFileSync(log, 'utf8')).toContain('AssertionError');
  });

  it('captures the patch the run produced, including files it created', async () => {
    const base = await captureBaseline(repo);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\n');
    fs.writeFileSync(path.join(repo, 'new.ts'), 'export const n = 1;\n');
    const bundle = await writeEvidence({
      runDir: runRoot,
      runId: 'r1',
      node: 'verify',
      evidenceId: 'verify-01',
      cwd: repo,
      baseSha: base,
      results: [pass('build')],
      rounds: 0,
    });
    expect(bundle.changedFiles.map((f) => f.path).sort()).toEqual(['a.txt', 'new.ts']);
    const patch = fs.readFileSync(path.join(evidenceDir(runRoot, 'verify-01'), 'diff.patch'), 'utf8');
    expect(patch).toContain('new.ts');
    expect(patch).toContain('+export const n = 1;');
  });

  it('records base and head so the bundle is anchored in history', async () => {
    const base = await captureBaseline(repo);
    const bundle = await writeEvidence({
      runDir: runRoot,
      runId: 'r1',
      node: 'verify',
      evidenceId: 'verify-01',
      cwd: repo,
      baseSha: base,
      results: [pass('build')],
      rounds: 0,
    });
    expect(bundle.baseSha).toBe(base);
    expect(bundle.headSha).toBe(base);
  });

  it('still returns a verdict when the bundle cannot be written', async () => {
    // The verdict is already decided by `results`; a failed write must not
    // change it, only lose the record.
    // A path whose parent is a regular file, so every write under it fails with
    // ENOTDIR on any platform. This used to point at `/proc/...`, which does not
    // exist on macOS (instant ENOENT) but is a live pseudo-filesystem on Linux —
    // a test whose failure mode differs by OS is not testing what it says.
    const blocked = path.join(runRoot, 'not-a-directory');
    fs.writeFileSync(blocked, 'regular file');
    const bundle = await writeEvidence({
      runDir: path.join(blocked, 'nested'),
      runId: 'r1',
      node: 'verify',
      evidenceId: 'verify-01',
      cwd: repo,
      results: [pass('build')],
      rounds: 0,
    });
    expect(bundle.passed).toBe(true);
  });
});

describe('reading back', () => {
  it('lists bundles in order', async () => {
    for (const id of ['verify-01', 'verify-02']) {
      await writeEvidence({
        runDir: runRoot,
        runId: 'r1',
        node: 'verify',
        evidenceId: id,
        cwd: repo,
        results: [pass('build')],
        rounds: 0,
      });
    }
    expect(listEvidence(runRoot)).toEqual(['verify-01', 'verify-02']);
  });

  it('returns undefined for a bundle that is not there', () => {
    expect(readEvidence(runRoot, 'nope')).toBeUndefined();
    expect(listEvidence('/nonexistent')).toEqual([]);
  });

  it('makes sortable ids', () => {
    expect(makeEvidenceId('verify', 1, 1)).toBe('verify-v01-01');
    expect(makeEvidenceId('my node/x', 3, 12)).toBe('my_node_x-v03-12');
  });
});

describe('formatEvidence', () => {
  it('marks a required failure as FAIL and a non-required one as a warning', () => {
    const text = formatEvidence({
      evidenceId: 'v-01',
      runId: 'r1',
      node: 'verify',
      createdAt: '2026-08-23T00:00:00.000Z',
      cwd: repo,
      passed: false,
      rounds: 0,
      results: [failWith('test', 'x'), { ...pass('lint'), passed: false, required: false }],
      changedFiles: [],
    });
    expect(text).toContain('FAILED');
    expect(text).toContain('[FAIL] test');
    expect(text).toContain('[warn] lint');
  });

  it('lists the changed files', () => {
    const text = formatEvidence({
      evidenceId: 'v-01',
      runId: 'r1',
      node: 'verify',
      createdAt: '2026-08-23T00:00:00.000Z',
      cwd: repo,
      passed: true,
      rounds: 0,
      results: [pass('build')],
      changedFiles: [{ path: 'new.ts', status: 'untracked', insertions: 3, deletions: 0 }],
    });
    expect(text).toContain('PASSED');
    expect(text).toContain('untracked');
    expect(text).toContain('new.ts');
  });
});
