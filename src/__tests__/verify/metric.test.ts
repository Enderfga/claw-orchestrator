/**
 * The `metric` check: a number the runtime measures and holds to bounds, and to
 * the same command on the run's base commit.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { memoryBaselineStore, readMetric } from '../../verify/metric.js';
import { normalizeContract } from '../../verify/contract.js';
import { runContract } from '../../verify/runner.js';

describe('readMetric', () => {
  it('reads a value by JSON path, by pattern, or as the last number printed', () => {
    expect(readMetric('{"results":{"score":0.91}}', { json: 'results.score' })).toBe(0.91);
    expect(readMetric('warming up\n{"runs":[{"ms":12.5}]}\n', { json: 'runs.0.ms' })).toBe(12.5);
    expect(readMetric('p50=3.2ms p99=41.0ms', { pattern: 'p99=([0-9.]+)ms' })).toBe(41);
    expect(readMetric('took 1.5s, 3 runs, total 4.75s', {})).toBe(4.75);
    expect(readMetric('no numbers here', {})).toBeUndefined();
    expect(readMetric('{"a":1}', { json: 'b.c' })).toBeUndefined();
  });

  it('refuses a metric check with nothing to hold the value to', () => {
    expect(normalizeContract({ checks: [{ type: 'metric', cmd: 'node', args: ['bench.js'] }] })).toBeUndefined();
    expect(
      normalizeContract({
        checks: [{ type: 'metric', cmd: 'node', args: ['bench.js'], direction: 'sideways', min: 1 }],
      }),
    ).toBeUndefined();
  });
});

describe('a metric against the base commit', () => {
  let repo: string;
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' })
      .toString()
      .trim();
  beforeEach(() => {
    repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clawo-metric-')));
    // The "benchmark": prints how long the work took, as JSON.
    fs.writeFileSync(path.join(repo, 'bench.js'), 'console.log(JSON.stringify({ ms: require("./work").ms }));\n');
    fs.writeFileSync(path.join(repo, 'work.js'), 'module.exports = { ms: 100 };\n');
    git('init', '-q');
    git('config', 'user.email', 't@e');
    git('config', 'user.name', 't');
    git('add', '-A');
    git('commit', '-qm', 'base');
  });
  afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

  const lowerMs = (extra: Record<string, unknown>) =>
    normalizeContract({
      checks: [
        { id: 'speed', type: 'metric', cmd: 'node', args: ['bench.js'], json: 'ms', direction: 'lower', ...extra },
      ],
    })!;

  it('passes a candidate that beats the base by the required margin, measured on both trees', async () => {
    const base = git('rev-parse', 'HEAD');
    fs.writeFileSync(path.join(repo, 'work.js'), 'module.exports = { ms: 80 };\n');
    const baselines = memoryBaselineStore();
    const r = await runContract(lowerMs({ minDelta: 10 }), {
      cwd: repo,
      artifactDir: path.join(repo, '.a'),
      baseSha: base,
      baselines,
    });
    expect(r.passed).toBe(true);
    expect(r.results[0]).toMatchObject({ passed: true, metric: { value: 80, baseline: 100 } });
    expect(r.results[0].detail).toBe('metric 80 (base 100, lower is better)');
    // The candidate's tree was not touched by the base measurement.
    expect(fs.readFileSync(path.join(repo, 'work.js'), 'utf8')).toContain('80');
    expect(git('worktree', 'list').split('\n')).toHaveLength(1);
  });

  it('refutes one that does not improve enough, or regresses more than allowed, and keeps the base value', async () => {
    const base = git('rev-parse', 'HEAD');
    fs.writeFileSync(path.join(repo, 'work.js'), 'module.exports = { ms: 95 };\n');
    const baselines = memoryBaselineStore();
    const ctx = { cwd: repo, artifactDir: path.join(repo, '.a'), baseSha: base, baselines };
    const small = await runContract(lowerMs({ minDelta: 10 }), ctx);
    expect(small.passed).toBe(false);
    expect(small.results[0].detail).toMatch(/improves on the base \(100\) by 5, less than 10/);

    fs.writeFileSync(path.join(repo, 'work.js'), 'module.exports = { ms: 130 };\n');
    const regress = await runContract(lowerMs({ maxRegression: 20 }), ctx);
    expect(regress.results[0].detail).toMatch(/worse than the base \(100\) by 30, more than 20/);
  });

  it('measures the base once per check, however many times the check runs', async () => {
    const base = git('rev-parse', 'HEAD');
    fs.writeFileSync(path.join(repo, 'work.js'), 'module.exports = { ms: 80 };\n');
    const inner = memoryBaselineStore();
    let measured = 0;
    const baselines = { get: inner.get, set: (k: string, v: number) => (measured++, inner.set(k, v)) };
    const ctx = { cwd: repo, artifactDir: path.join(repo, '.a'), baseSha: base, baselines };
    for (let i = 0; i < 3; i++) expect((await runContract(lowerMs({ minDelta: 10 }), ctx)).passed).toBe(true);
    expect(measured).toBe(1);
  });

  it("runs a check's absolute directory in the candidate's tree as the same directory in the base's", async () => {
    fs.mkdirSync(path.join(repo, 'bench'));
    fs.writeFileSync(path.join(repo, 'bench', 'run.js'), 'console.log(require("../work").ms);\n');
    git('add', '-A');
    git('commit', '-qm', 'bench dir');
    const base = git('rev-parse', 'HEAD');
    fs.writeFileSync(path.join(repo, 'work.js'), 'module.exports = { ms: 60 };\n');
    const c = normalizeContract({
      checks: [
        {
          type: 'metric',
          cmd: 'node',
          args: ['run.js'],
          cwd: path.join(repo, 'bench'),
          direction: 'lower',
          minDelta: 1,
        },
      ],
    })!;
    const r = await runContract(c, { cwd: repo, artifactDir: path.join(repo, '.a'), baseSha: base });
    expect(r.results[0]).toMatchObject({ passed: true, metric: { value: 60, baseline: 100 } });
  });

  it('holds a value to absolute bounds without a base, and fails when there is no base to compare with', async () => {
    const bounded = await runContract(lowerMs({ max: 120 }), { cwd: repo, artifactDir: path.join(repo, '.a') });
    expect(bounded.results[0]).toMatchObject({ passed: true, metric: { value: 100 } });
    const nobase = await runContract(lowerMs({ minDelta: 1 }), { cwd: repo, artifactDir: path.join(repo, '.a') });
    expect(nobase.passed).toBe(false);
    expect(nobase.results[0].detail).toMatch(/there is no base commit to compare against/);
  });
});

describe('a metric in a workflow contract', () => {
  let tmp: string;
  let repo: string;
  const saved = process.env.CLAWO_WF_DIR;
  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clawo-metric-wf-')));
    process.env.CLAWO_WF_DIR = path.join(tmp, 'wf');
    repo = path.join(tmp, 'repo');
    fs.mkdirSync(repo);
    fs.writeFileSync(path.join(repo, 'bench.js'), 'console.log(JSON.stringify({ ms: require("./work").ms }));\n');
    fs.writeFileSync(path.join(repo, 'work.js'), 'module.exports = { ms: 100 };\n');
    for (const args of [
      ['init', '-q'],
      ['config', 'user.email', 't@e'],
      ['config', 'user.name', 't'],
      ['add', '-A'],
      ['commit', '-qm', 'base'],
    ]) {
      execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
    }
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.CLAWO_WF_DIR;
    else process.env.CLAWO_WF_DIR = saved;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  async function runWith(ms: number) {
    const { RunKernel } = await import('../../kernel/engine.js');
    const { registerDefaultExecutors } = await import('../../kernel/nodes/index.js');
    const kernel = registerDefaultExecutors(new RunKernel({ nodeTimeoutMs: 30_000 }));
    kernel.setExecutor('agent', async () => {
      fs.writeFileSync(path.join(repo, 'work.js'), `module.exports = { ms: ${ms} };\n`);
      return { ok: true, output: 'optimised' };
    });
    const run = await kernel.start({
      name: 'speedup',
      cwd: repo,
      contract: {
        checks: [
          {
            id: 'speed',
            spec: { type: 'metric', cmd: 'node', args: ['bench.js'], json: 'ms', direction: 'lower', minDelta: 10 },
          },
        ],
      },
      nodes: [{ id: 'impl', kind: 'agent', prompt: 'make it faster' }],
    });
    return kernel.wait(run.runId);
  }

  it('verifies a run that beats the commit it started from, and refutes one that does not', async () => {
    const fast = await runWith(70);
    expect(fast!.outcome).toBe('verified');
    const fastDir = path.join(tmp, 'wf', fast!.runId);
    expect(Object.values(JSON.parse(fs.readFileSync(path.join(fastDir, 'metric-baselines.json'), 'utf8')))).toEqual([
      100,
    ]);

    execFileSync('git', ['-C', repo, 'checkout', '--', 'work.js']);
    const slow = await runWith(95);
    expect(slow!.outcome).toBe('refuted');
  });
});
