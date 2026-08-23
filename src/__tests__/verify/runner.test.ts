/**
 * The check runner. Real temp directories and real processes where the assertion
 * is about what actually happens on disk or at an exit code — the point of the
 * feature is that it does not take anyone's word for it, so neither do the tests.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runChecks, runContract, type ExecFn } from '../../verify/runner.js';
import { normalizeContract, type AcceptanceContract } from '../../verify/contract.js';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clawo-verify-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const ctx = () => ({ cwd: tmp, artifactDir: path.join(tmp, '.artifacts') });

describe('command checks', () => {
  it('passes on exit 0', async () => {
    const c = normalizeContract({ checks: [{ type: 'command', cmd: 'true' }] })!;
    const [r] = await runChecks(c, ctx());
    expect(r.passed).toBe(true);
    expect(r.detail).toContain('exited 0');
  });

  it('fails on a non-zero exit and keeps the output tail', async () => {
    const c = normalizeContract({
      checks: [{ type: 'command', cmd: 'sh', args: ['-c', 'echo boom 1>&2; exit 1'] }],
    })!;
    const [r] = await runChecks(c, ctx());
    expect(r.passed).toBe(false);
    expect(r.tail).toContain('boom');
  });

  it('honours a non-zero expectExit', async () => {
    const c = normalizeContract({ checks: [{ type: 'command', cmd: 'sh', args: ['-c', 'exit 7'], expectExit: 7 }] })!;
    const [r] = await runChecks(c, ctx());
    expect(r.passed).toBe(true);
  });

  it('times a hung check out instead of hanging the run', async () => {
    const c = normalizeContract({
      checks: [{ type: 'command', cmd: 'sh', args: ['-c', 'sleep 30'], timeoutMs: 300 }],
    })!;
    const started = Date.now();
    const [r] = await runChecks(c, ctx());
    expect(r.passed).toBe(false);
    expect(r.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('runs in a check-relative cwd', async () => {
    fs.mkdirSync(path.join(tmp, 'sub'));
    fs.writeFileSync(path.join(tmp, 'sub', 'marker'), 'x');
    const c = normalizeContract({ checks: [{ type: 'command', cmd: 'test', args: ['-f', 'marker'], cwd: 'sub' }] })!;
    const [r] = await runChecks(c, ctx());
    expect(r.passed).toBe(true);
  });
});

describe('required semantics', () => {
  it('records a non-required failure without refuting the contract', async () => {
    const c = normalizeContract({
      checks: [
        { type: 'command', cmd: 'false', required: false },
        { type: 'command', cmd: 'true' },
      ],
    })!;
    const results = await runChecks(c, ctx());
    expect(results[0].passed).toBe(false);
    expect(results[0].required).toBe(false);
    expect(results.every((r) => r.passed || !r.required)).toBe(true);
  });

  it('runs every check rather than stopping at the first red, so the bundle is complete', async () => {
    const c = normalizeContract({
      checks: [
        { type: 'command', cmd: 'false' },
        { type: 'command', cmd: 'true' },
        { type: 'command', cmd: 'true' },
      ],
    })!;
    const results = await runChecks(c, ctx());
    expect(results).toHaveLength(3);
    expect(results.map((r) => r.passed)).toEqual([false, true, true]);
  });

  it('can be asked to skip remaining required checks after a red', async () => {
    const c = normalizeContract({
      checks: [
        { type: 'command', cmd: 'false' },
        { type: 'command', cmd: 'true' },
      ],
    })!;
    const results = await runChecks(c, ctx(), { stopOnRequiredFailure: true });
    expect(results[1].detail).toContain('skipped');
  });
});

describe('file checks', () => {
  it('passes when the file is there', async () => {
    fs.writeFileSync(path.join(tmp, 'a.txt'), 'hello world');
    const c = normalizeContract({ checks: [{ type: 'file', path: 'a.txt' }] })!;
    expect((await runChecks(c, ctx()))[0].passed).toBe(true);
  });

  it('fails when it is missing', async () => {
    const c = normalizeContract({ checks: [{ type: 'file', path: 'nope.txt' }] })!;
    const [r] = await runChecks(c, ctx());
    expect(r.passed).toBe(false);
    expect(r.detail).toContain('missing');
  });

  it('asserts absence when exists is false', async () => {
    fs.writeFileSync(path.join(tmp, 'secret.env'), 'x');
    const c = normalizeContract({ checks: [{ type: 'file', path: 'secret.env', exists: false }] })!;
    expect((await runChecks(c, ctx()))[0].passed).toBe(false);
  });

  it('applies a content matcher', async () => {
    fs.writeFileSync(path.join(tmp, 'a.txt'), 'version = 2');
    const ok = normalizeContract({ checks: [{ type: 'file', path: 'a.txt', matches: 'version = \\d' }] })!;
    const bad = normalizeContract({ checks: [{ type: 'file', path: 'a.txt', matches: 'nothing' }] })!;
    expect((await runChecks(ok, ctx()))[0].passed).toBe(true);
    expect((await runChecks(bad, ctx()))[0].passed).toBe(false);
  });

  it('reports an invalid matcher rather than throwing out of the run', async () => {
    fs.writeFileSync(path.join(tmp, 'a.txt'), 'x');
    const c = normalizeContract({ checks: [{ type: 'file', path: 'a.txt', matches: '([' }] })!;
    const [r] = await runChecks(c, ctx());
    expect(r.passed).toBe(false);
    expect(r.detail).toContain('invalid matcher');
  });
});

describe('http checks', () => {
  it('passes on the expected status', async () => {
    const c = normalizeContract({ checks: [{ type: 'http', url: 'http://x/health', timeoutMs: 2000 }] })!;
    const fetchFn = (async () => ({ status: 200 })) as unknown as typeof fetch;
    const [r] = await runChecks(c, { ...ctx(), fetchFn });
    expect(r.passed).toBe(true);
  });

  it('keeps polling while the service is still coming up', async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls++;
      if (calls < 3) throw new Error('ECONNREFUSED');
      return { status: 200 };
    }) as unknown as typeof fetch;
    const c = normalizeContract({
      checks: [{ type: 'http', url: 'http://x/health', timeoutMs: 5000, intervalMs: 10 }],
    })!;
    const [r] = await runChecks(c, { ...ctx(), fetchFn });
    expect(r.passed).toBe(true);
    expect(calls).toBe(3);
  });

  it('gives up at the deadline', async () => {
    const fetchFn = (async () => ({ status: 503 })) as unknown as typeof fetch;
    const c = normalizeContract({
      checks: [{ type: 'http', url: 'http://x/health', timeoutMs: 200, intervalMs: 10 }],
    })!;
    const [r] = await runChecks(c, { ...ctx(), fetchFn });
    expect(r.passed).toBe(false);
    expect(r.detail).toContain('gave up');
  });
});

describe('runContract fix-on-red loop', () => {
  const redThenGreen = (): AcceptanceContract =>
    normalizeContract({ fixOnFailureRounds: 3, checks: [{ type: 'file', path: 'fixed.txt' }] })!;

  it('re-runs the checks after the fixer and only the re-run decides', async () => {
    let rounds = 0;
    const out = await runContract(redThenGreen(), ctx(), async () => {
      rounds++;
      // The fixer claims nothing; it just changes the world on its second try.
      if (rounds === 2) fs.writeFileSync(path.join(tmp, 'fixed.txt'), 'ok');
    });
    expect(out.passed).toBe(true);
    expect(out.rounds).toBe(2);
  });

  it('stops at the round limit and reports red', async () => {
    const out = await runContract(redThenGreen(), ctx(), async () => {
      // A fixer that never fixes anything.
    });
    expect(out.passed).toBe(false);
    expect(out.rounds).toBe(3);
  });

  it('does not loop at all without a fixer', async () => {
    const out = await runContract(redThenGreen(), ctx());
    expect(out.passed).toBe(false);
    expect(out.rounds).toBe(0);
  });
});

describe('injectable exec seam', () => {
  it('drives checks without spawning anything', async () => {
    const calls: string[] = [];
    const fake: ExecFn = async (cmd, args) => {
      calls.push([cmd, ...args].join(' '));
      return { code: 0, out: '', err: '', timedOut: false, durationMs: 1 };
    };
    const c = normalizeContract({ checks: [{ type: 'command', cmd: 'npm', args: ['test'] }] })!;
    const [r] = await runChecks(c, { ...ctx(), exec: fake });
    expect(r.passed).toBe(true);
    expect(calls).toEqual(['npm test']);
  });
});
