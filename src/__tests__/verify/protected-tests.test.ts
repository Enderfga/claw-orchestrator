/**
 * Tests the contract runs are not the agent's to change. Real repositories and
 * real git, because the rule is about what git says existed at the baseline.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { runChecks, runContract } from '../../verify/runner.js';
import { normalizeContract } from '../../verify/contract.js';
import { isTestPath, snapshotChangedTests } from '../../verify/protected-tests.js';
import { RunKernel } from '../../kernel/engine.js';
import { registerDefaultExecutors } from '../../kernel/nodes/index.js';

let repo: string;
let base: string;

const git = (cmd: string) => execSync(`git ${cmd}`, { cwd: repo, stdio: 'pipe' }).toString().trim();
const write = (file: string, body: string) => {
  fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  fs.writeFileSync(path.join(repo, file), body);
};

// The repository's "test suite": exits 0 only while the assertion file says so.
const contract = (extra: Record<string, unknown> = {}) =>
  normalizeContract({
    checks: [{ type: 'command', cmd: 'sh', args: ['-c', 'grep -q "expect(sum).toBe(3)" test/sum.test.js'] }],
    ...extra,
  })!;

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'clawo-protect-'));
  git('init -b main');
  git('config user.email t@example.com');
  git('config user.name t');
  write('src/sum.js', 'module.exports = (a, b) => a - b;\n');
  write('test/sum.test.js', 'expect(sum).toBe(3)\n');
  write('package.json', JSON.stringify({ name: 'p', scripts: { test: 'vitest run' }, dependencies: {} }, null, 2));
  git('add -A');
  git('commit -m base');
  base = git('rev-parse HEAD');
});

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

const ctx = () => ({ cwd: repo, artifactDir: path.join(repo, '.artifacts'), baseSha: base });
const guard = async (c = contract()) => (await runChecks(c, ctx())).find((r) => r.id === 'protected-tests');

describe('protected tests', () => {
  it('passes, and says so, when only source changed', async () => {
    write('src/sum.js', 'module.exports = (a, b) => a + b;\n');
    const r = await guard();
    expect(r?.passed).toBe(true);
  });

  it('refutes a run that edited a test present at the baseline', async () => {
    write('test/sum.test.js', 'expect(sum).toBe(3)\nexpect(true).toBe(true)\n');
    const r = await guard();
    expect(r?.passed).toBe(false);
    expect(r?.required).toBe(true);
    expect(r?.detail).toContain('test/sum.test.js');
  });

  it('refutes an edit that was committed, not just left in the tree', async () => {
    write('test/sum.test.js', 'expect(sum).toBe(3) // relaxed\n');
    git('commit -am "loosen"');
    expect((await guard())?.passed).toBe(false);
  });

  it('refutes deleting a test', async () => {
    fs.rmSync(path.join(repo, 'test/sum.test.js'));
    expect((await guard())?.passed).toBe(false);
  });

  it('allows adding tests, committed or not', async () => {
    write('test/extra.test.js', 'expect(1).toBe(1)\n');
    write('test/more.test.js', 'expect(2).toBe(2)\n');
    git('add test/more.test.js');
    git('commit -m more');
    expect((await guard())?.passed).toBe(true);
  });

  it('refutes a change to the test scripts but not to the rest of package.json', async () => {
    write('package.json', JSON.stringify({ name: 'p', scripts: { test: 'vitest run' }, dependencies: { a: '1' } }));
    expect((await guard())?.passed).toBe(true);
    write('package.json', JSON.stringify({ name: 'p', scripts: { test: 'exit 0' }, dependencies: { a: '1' } }));
    const r = await guard();
    expect(r?.passed).toBe(false);
    expect(r?.detail).toContain('package.json (test scripts)');
  });

  it('makes the whole contract fail when the checks themselves pass on an edited test', async () => {
    write('test/sum.test.js', 'expect(sum).toBe(3) // now trivially satisfied\n');
    const results = await runChecks(contract(), ctx());
    expect(results.find((r) => r.id !== 'protected-tests')?.passed).toBe(true);
    const { passed } = await runContract(contract(), ctx());
    expect(passed).toBe(false);
  });

  it('keeps a fixer from going green by rewriting the test', async () => {
    write('test/sum.test.js', 'expect(sum).toBe(4)\n');
    const fixer = async () => write('test/sum.test.js', 'expect(sum).toBe(3)\n// fixed?\n');
    const out = await runContract(contract({ fixOnFailureRounds: 2 }), ctx(), fixer);
    expect(out.passed).toBe(false);
    expect(out.results.find((r) => r.id === 'protected-tests')?.passed).toBe(false);
  });

  it('does not blame the run for test edits already in the tree when it started', async () => {
    write('test/sum.test.js', 'expect(sum).toBe(3) // the developer was already editing this\n');
    write('package.json', JSON.stringify({ name: 'p', scripts: { test: 'vitest run --bail' } }));
    const baseTests = await snapshotChangedTests(repo, base);
    const withStart = () => runChecks(contract(), { ...ctx(), baseTests });

    write('src/sum.js', 'module.exports = (a, b) => a + b;\n');
    expect((await withStart()).find((r) => r.id === 'protected-tests')?.passed).toBe(true);

    // Changing them further during the run is still the run's doing.
    write('test/sum.test.js', 'expect(sum).toBe(3) // and then the agent\n');
    const r = (await withStart()).find((x) => x.id === 'protected-tests');
    expect(r?.passed).toBe(false);
    expect(r?.detail).toContain('test/sum.test.js');
    expect(r?.detail).not.toContain('package.json');
  });

  it('is off when the caller says changing tests is the task', async () => {
    write('test/sum.test.js', 'expect(sum).toBe(3)\n// rewritten on purpose\n');
    expect(await guard(contract({ protectTests: false }))).toBeUndefined();
  });

  it('does not apply without a command check or without a baseline', async () => {
    write('test/sum.test.js', 'changed\n');
    const fileOnly = normalizeContract({ checks: [{ type: 'file', path: 'src/sum.js' }] })!;
    expect((await runChecks(fileOnly, ctx())).find((r) => r.id === 'protected-tests')).toBeUndefined();
    const noBase = await runChecks(contract(), { cwd: repo, artifactDir: path.join(repo, '.artifacts') });
    expect(noBase.find((r) => r.id === 'protected-tests')).toBeUndefined();
  });
});

describe('protected tests in a kernel run', () => {
  const verifyRun = async (agentEdit: () => void) => {
    const kernel = registerDefaultExecutors(new RunKernel({ nodeTimeoutMs: 8000 }));
    kernel.setExecutor('agent', async () => {
      agentEdit();
      return { ok: true };
    });
    const rec = await kernel.start(
      { name: 'p', cwd: repo, nodes: [{ id: 'work', kind: 'agent', prompt: 'fix sum' }] },
      { contract: { checks: [{ type: 'command', cmd: 'sh', args: ['-c', 'grep -q "toBe(3)" test/sum.test.js'] }] } },
    );
    return (await kernel.wait(rec.runId))!;
  };

  it('verifies a run in a tree whose tests were already being edited when it started', async () => {
    write('test/sum.test.js', 'expect(sum).toBe(3) // uncommitted, before the run\n');
    const done = await verifyRun(() => write('src/sum.js', 'module.exports = (a, b) => a + b;\n'));
    expect(done.outcome).toBe('verified');
  });

  it('refutes a run whose agent edited the test', async () => {
    const done = await verifyRun(() => write('test/sum.test.js', 'expect(sum).toBe(3) // agent\n'));
    expect(done.outcome).not.toBe('verified');
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
  ])('treats %s as a test path', (p) => expect(isTestPath(p)).toBe(true));

  it.each(['src/index.ts', 'README.md', 'latest/notes.md', 'src/contest.ts', 'docs/testing-guide.md'])(
    'does not treat %s as a test path',
    (p) => expect(isTestPath(p)).toBe(false),
  );
});
