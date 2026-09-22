/**
 * Tests the contract runs are not the agent's to change. Real repositories, real
 * git and the real kernel, because the rule is about the tree as a run found it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { runChecks, runContract } from '../../verify/runner.js';
import { normalizeContract } from '../../verify/contract.js';
import { isTestPath, needsTestSnapshot, snapshotTests, type TestSnapshot } from '../../verify/protected-tests.js';
import { RunKernel } from '../../kernel/engine.js';
import { registerDefaultExecutors } from '../../kernel/nodes/index.js';

let repo: string;

const git = (cmd: string, cwd = repo) => execSync(`git ${cmd}`, { cwd, stdio: 'pipe' }).toString().trim();
const write = (file: string, body: string) => {
  fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  fs.writeFileSync(path.join(repo, file), body);
};
const pkg = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ name: 'p', scripts: { test: 'vitest run', build: 'tsc' }, dependencies: {}, ...extra }, null, 2);

function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'clawo-protect-'));
  git('init -b main', dir);
  git('config user.email t@example.com', dir);
  git('config user.name t', dir);
  return dir;
}

// The repository's "test suite": exits 0 only while the assertion file says so.
const GREP = 'grep -q "expect(sum).toBe(3)" test/sum.test.js';
const contract = (extra: Record<string, unknown> = {}, cmd = GREP) =>
  normalizeContract({ checks: [{ type: 'command', cmd: 'sh', args: ['-c', cmd] }], ...extra })!;

beforeEach(() => {
  repo = makeRepo();
  write('src/sum.js', 'module.exports = (a, b) => a - b;\n');
  write('test/sum.test.js', 'expect(sum).toBe(3)\n');
  write('package.json', pkg());
  git('add -A');
  git('commit -m base');
});

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

const ctx = (baseTests: TestSnapshot | null | undefined) => ({
  cwd: repo,
  artifactDir: path.join(repo, '.artifacts'),
  baseTests,
});
const guard = async (snap: TestSnapshot | null | undefined, c = contract()) =>
  (await runChecks(c, ctx(snap))).find((r) => r.id === 'protected-tests');

describe('protected tests', () => {
  it('passes, and says so, when only source changed', async () => {
    const snap = await snapshotTests(repo);
    write('src/sum.js', 'module.exports = (a, b) => a + b;\n');
    const r = await guard(snap);
    expect(r?.passed).toBe(true);
    expect(r?.required).toBe(true);
  });

  it('refutes editing, committing an edit to, or deleting an existing test', async () => {
    const snap = await snapshotTests(repo);
    write('test/sum.test.js', 'expect(sum).toBe(3)\nexpect(true).toBe(true)\n');
    expect((await guard(snap))?.detail).toContain('test/sum.test.js');
    git('commit -am loosen');
    expect((await guard(snap))?.passed).toBe(false);
    fs.rmSync(path.join(repo, 'test/sum.test.js'));
    expect((await guard(snap))?.passed).toBe(false);
  });

  it('allows adding tests and packages, committed or not, including a package with its own test config', async () => {
    const snap = await snapshotTests(repo);
    write('test/extra.test.js', 'expect(1).toBe(1)\n');
    write('test/more.test.js', 'expect(2).toBe(2)\n');
    write('packages/new/package.json', pkg());
    write('packages/new/jest.config.ts', 'export default {};\n');
    write('packages/new/tests/conftest.py', 'import pytest\n');

    git('add test/more.test.js');
    git('commit -m more');
    expect((await guard(snap))?.passed).toBe(true);
  });

  it('leaves installed dependencies alone', async () => {
    write('node_modules/some-dep/test/index.test.js', 'old\n');
    const snap = await snapshotTests(repo);
    expect(Object.keys(snap!.files).some((f) => f.startsWith('node_modules/'))).toBe(false);
    write('node_modules/some-dep/test/index.test.js', 'upgraded\n');
    expect((await guard(snap))?.passed).toBe(true);
  });

  it('refutes test configuration added during the run over a test the run started with', async () => {
    const snap = await snapshotTests(repo);
    write('test/conftest.py', 'import pytest\n');
    const r = await guard(snap);
    expect(r?.passed).toBe(false);
    expect(r?.detail).toContain('test/conftest.py');
  });

  it('does not crash on, or refute, a new file it cannot read', async () => {
    const snap = await snapshotTests(repo);
    write('test/output/secret.log', 'x');
    fs.chmodSync(path.join(repo, 'test/output/secret.log'), 0o000);
    try {
      expect((await guard(snap))?.passed).toBe(true);
    } finally {
      fs.chmodSync(path.join(repo, 'test/output/secret.log'), 0o644);
    }
  });

  it('refutes a change to a script the checks run or to runner settings, not to other scripts or dependencies', async () => {
    write(
      'package.json',
      pkg({ scripts: { test: 'npm run unit', unit: 'vitest run', verify: 'tsc --noEmit', build: 'tsc' } }),
    );
    git('commit -am scripts');
    const snap = await snapshotTests(repo);
    const withScripts = (scripts: Record<string, string>, extra: Record<string, unknown> = {}) =>
      write('package.json', pkg({ scripts, ...extra }));
    const base = { test: 'npm run unit', unit: 'vitest run', verify: 'tsc --noEmit', build: 'tsc' };

    // Unrelated: a new lint script, a changed build, new dependencies, reordered keys.
    withScripts({ lint: 'eslint .', ...base, build: 'vite build' }, { dependencies: { a: '1' } });
    expect((await guard(snap))?.passed).toBe(true);
    // Reached through `test`: the script it runs by name.
    withScripts({ ...base, unit: 'exit 0' });
    expect((await guard(snap))?.detail).toContain('package.json (a script the checks run, or test settings)');
    // A pre-hook of a reachable script.
    withScripts({ ...base, preunit: 'cp /dev/null test/sum.test.js' });
    expect((await guard(snap))?.passed).toBe(false);
    // Named by the contract's own command.
    withScripts({ ...base, verify: 'true' });
    expect((await guard(snap))?.passed).toBe(true);
    expect((await guard(snap, contract({}, `npm run verify && ${GREP}`)))?.passed).toBe(false);
    withScripts(base, { jest: { testPathIgnorePatterns: ['test'] } });
    expect((await guard(snap))?.passed).toBe(false);
  });

  it('judges the tree before the checks run, so a test that restores itself is still caught', async () => {
    const snap = await snapshotTests(repo);
    write('test/sum.test.js', 'expect(true).toBe(true)\n');
    const restoring = contract({}, `git checkout -- test/sum.test.js && ${GREP}`);
    const results = await runChecks(restoring, ctx(snap));
    expect(results[0].id).toBe('protected-tests');
    expect(results[0].passed).toBe(false);
    expect(results[1].passed).toBe(true);
  });

  it('makes the contract fail when its checks pass on an edited test, fixer rounds included', async () => {
    const snap = await snapshotTests(repo);
    write('test/sum.test.js', 'expect(sum).toBe(4)\n');
    const fixer = async () => write('test/sum.test.js', 'expect(sum).toBe(3)\n// fixed?\n');
    const out = await runContract(contract({ fixOnFailureRounds: 2 }), ctx(snap), fixer);
    expect(out.results.find((r) => r.id !== 'protected-tests')?.passed).toBe(true);
    expect(out.passed).toBe(false);
  });

  it('keeps edits that were in the tree when the run started, including an uncommitted new test', async () => {
    // The TDD case: the developer writes the failing test, then hands the fix to an agent.
    write('test/sum.test.js', 'expect(sum).toBe(3) // the developer was editing this\n');
    write('test/bug.test.js', 'expect(sum(1, 2)).toBe(3)\n');
    write('test/staged.test.js', 'expect(sum(2, 2)).toBe(4)\n');
    git('add test/staged.test.js');
    const snap = await snapshotTests(repo);

    write('src/sum.js', 'module.exports = (a, b) => a + b;\n');
    expect((await guard(snap))?.passed).toBe(true);
    write('test/bug.test.js', 'expect(true).toBe(true)\n');
    expect((await guard(snap))?.detail).toContain('test/bug.test.js');
    write('test/bug.test.js', 'expect(sum(1, 2)).toBe(3)\n');
    fs.rmSync(path.join(repo, 'test/staged.test.js'));
    expect((await guard(snap))?.detail).toContain('test/staged.test.js');
  });

  it('is not fooled by the index, git attributes, or a quoted path', async () => {
    write('test/sümme.test.js', 'expect(sum).toBe(3)\n');
    git('add -A');
    git('commit -m unicode');
    const snap = await snapshotTests(repo);
    git('update-index --assume-unchanged test/sum.test.js');
    fs.writeFileSync(path.join(repo, '.git/info/attributes'), '*.js filter=hide\n');
    git('config filter.hide.clean "sed s/true/3/"');
    write('test/sum.test.js', 'expect(sum).toBe(true)\n');
    expect(git('diff --name-only')).toBe('');
    expect((await guard(snap))?.detail).toContain('test/sum.test.js');
    write('test/sum.test.js', 'expect(sum).toBe(3)\n');
    write('test/sümme.test.js', 'expect(true).toBe(true)\n');
    expect((await guard(snap))?.detail).toContain('sümme');
  });

  it('follows a symlinked test by its target, and leaves line endings alone when nothing changed', async () => {
    write('fixtures/real.test.js', 'expect(sum).toBe(3)\r\n');
    fs.symlinkSync('../fixtures/real.test.js', path.join(repo, 'test/link.test.js'));
    git('add -A');
    git('commit -m links');
    git('config core.autocrlf true');
    const snap = await snapshotTests(repo);
    expect((await guard(snap))?.passed).toBe(true);
    fs.unlinkSync(path.join(repo, 'test/link.test.js'));
    fs.symlinkSync('../fixtures/other.test.js', path.join(repo, 'test/link.test.js'));
    expect((await guard(snap))?.detail).toContain('test/link.test.js');
  });

  it('reports not checked, without refuting, when a run has no snapshot', async () => {
    write('test/sum.test.js', 'expect(sum).toBe(3) // could be the developer\n');
    const r = await guard(null);
    expect(r?.passed).toBe(false);
    expect(r?.required).toBe(false);
    expect(r?.detail).toContain('not checked');
  });

  it('does not apply when the caller opts out, without a command check, or outside a kernel run', async () => {
    const snap = await snapshotTests(repo);
    write('test/sum.test.js', 'changed\n');
    expect(await guard(snap, contract({ protectTests: false }))).toBeUndefined();
    expect(await guard(snap, normalizeContract({ checks: [{ type: 'file', path: 'src/sum.js' }] })!)).toBeUndefined();
    expect(await guard(undefined)).toBeUndefined();
  });

  it('has no snapshot to take outside a repository', async () => {
    const plain = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'clawo-plain-'));
    try {
      expect(await snapshotTests(plain)).toBeUndefined();
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }
  });
});

describe('needsTestSnapshot', () => {
  const command = { spec: { type: 'command', cmd: 'true' } };
  it('asks for a snapshot only when a command check protects tests, or a subflow might', () => {
    expect(needsTestSnapshot({ contract: { checks: [command] } as never, nodes: [] })).toBe(true);
    expect(needsTestSnapshot({ contract: { checks: [command], protectTests: false } as never, nodes: [] })).toBe(false);
    expect(
      needsTestSnapshot({ contract: { checks: [{ spec: { type: 'file', path: 'x' } }] } as never, nodes: [] }),
    ).toBe(false);
    expect(needsTestSnapshot({ nodes: [{ kind: 'verifier', contract: { checks: [command] } }] })).toBe(true);
    expect(needsTestSnapshot({ nodes: [{ kind: 'subflow' }] })).toBe(true);
    expect(needsTestSnapshot({ nodes: [{ kind: 'agent' }] })).toBe(false);
  });
});

describe('protected tests in a kernel run', () => {
  const grepCheck = { type: 'command', cmd: 'sh', args: ['-c', 'grep -q "toBe(3)" test/sum.test.js'] };

  const run = async (spec: Record<string, unknown>, agentEdit: () => void, opts: Record<string, unknown> = {}) => {
    const kernel = registerDefaultExecutors(new RunKernel({ nodeTimeoutMs: 8000 }));
    kernel.setExecutor('agent', async () => {
      agentEdit();
      return { ok: true };
    });
    const rec = await kernel.start({ name: 'p', cwd: repo, ...spec } as never, opts as never);
    return (await kernel.wait(rec.runId))!;
  };
  const agentOnly = { nodes: [{ id: 'work', kind: 'agent', prompt: 'fix sum' }] };

  it('verifies a run in a tree whose tests were already being edited when it started', async () => {
    write('test/sum.test.js', 'expect(sum).toBe(3) // uncommitted, before the run\n');
    const done = await run(agentOnly, () => write('src/sum.js', 'module.exports = (a, b) => a + b;\n'), {
      contract: { checks: [grepCheck] },
    });
    expect(done.outcome).toBe('verified');
  });

  it('refutes a run whose agent edited the test', async () => {
    const done = await run(agentOnly, () => write('test/sum.test.js', 'expect(sum).toBe(3) // agent\n'), {
      contract: { checks: [grepCheck] },
    });
    expect(done.outcome).not.toBe('verified');
  });

  it("holds a subflow's verifier to the tree as the parent run found it", async () => {
    const done = await run(
      {
        nodes: [
          { id: 'work', kind: 'agent', prompt: 'fix sum' },
          {
            id: 'check',
            kind: 'subflow',
            workflow: {
              name: 'child',
              nodes: [{ id: 'v', kind: 'verifier', contract: { checks: [{ spec: grepCheck }] } }],
            },
          },
        ],
      },
      () => write('test/sum.test.js', 'expect(sum).toBe(3) // agent, before the child started\n'),
    );
    expect(done.state).not.toBe('completed');
  });

  it('protects a project with no commits yet', async () => {
    const fresh = makeRepo();
    const prev = repo;
    repo = fresh;
    try {
      write('test/sum.test.js', 'expect(sum).toBe(3)\n');
      const done = await run(agentOnly, () => write('test/sum.test.js', 'expect(sum).toBe(3) // agent\n'), {
        contract: { checks: [grepCheck] },
      });
      expect(done.baseSha).toBeUndefined();
      expect(done.outcome).not.toBe('verified');
    } finally {
      repo = prev;
      fs.rmSync(fresh, { recursive: true, force: true });
    }
  });

  it('does not refute a verifier that checks a directory outside any repository', async () => {
    const plain = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'clawo-plain-'));
    try {
      const done = await run(
        {
          nodes: [
            {
              id: 'check',
              kind: 'verifier',
              cwd: plain,
              contract: { checks: [{ spec: { type: 'command', cmd: 'true' } }] },
            },
          ],
        },
        () => undefined,
      );
      expect(done.state).toBe('completed');
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }
  });

  it('does not refute a verifier that checks another repository', async () => {
    const other = makeRepo();
    try {
      fs.mkdirSync(path.join(other, 'test'));
      fs.writeFileSync(path.join(other, 'test/sum.test.js'), 'expect(sum).toBe(3)\n');
      git('add -A', other);
      git('commit -m other', other);
      const done = await run(
        { nodes: [{ id: 'check', kind: 'verifier', cwd: other, contract: { checks: [{ spec: grepCheck }] } }] },
        () => undefined,
      );
      expect(done.state).toBe('completed');
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });
});

describe('isTestPath', () => {
  it.each([
    'test/a.js',
    'pkg/tests/b.py',
    'src/__tests__/c.test.ts',
    'spec/d_spec.rb',
    'src/e.spec.tsx',
    'app/test_f.py',
    'g_test.go',
    'src/main/HTest.java',
    'vitest.config.ts',
    'web/jest.config.mjs',
    'conftest.py',
    '.mocharc.yml',
    'karma.conf.js',
    'jest.config.json',
    'jest.setup.ts',
    'src/setupTests.tsx',
    'spec/spec_helper.rb',
    'spec/support/factories.rb',
    '.rspec',
    'src/__snapshots__/app.test.ts.snap',
  ])('treats %s as a test path', (p) => expect(isTestPath(p)).toBe(true));

  it.each([
    'src/index.ts',
    'README.md',
    'latest/notes.md',
    'src/contest.ts',
    'docs/testing-guide.md',
    'specs/001-feature/tasks.md',
    '.kiro/specs/feat/tasks.md',
    'docs/spec/api.yaml',
  ])('does not treat %s as a test path', (p) => expect(isTestPath(p)).toBe(false));
});
