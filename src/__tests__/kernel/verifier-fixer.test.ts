/**
 * A verifier's fix-on-red round: what the fixer is shown, what it runs as, how
 * long its turn may take, and that its cost counts; and the check output both
 * a fixer and a repair visit read.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RunKernel } from '../../kernel/engine.js';
import { registerDefaultExecutors } from '../../kernel/nodes/index.js';
import { FIXER_TURN_TIMEOUT_MS } from '../../kernel/nodes/verifier.js';
import { solveWorkflow } from '../../kernel/templates/index.js';
import { checkTail } from '../../verify/runner.js';

let tmp: string;
const saved = process.env.CLAWO_WF_DIR;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clawo-fixer-'));
  process.env.CLAWO_WF_DIR = path.join(tmp, 'wf');
});
afterEach(() => {
  if (saved === undefined) delete process.env.CLAWO_WF_DIR;
  else process.env.CLAWO_WF_DIR = saved;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('checkTail', () => {
  it('keeps stdout when stderr has output too', () => {
    const tail = checkTail('FAIL src/a.test.ts\nexpected 2 to be 3\n', 'npm warn config deprecated\n');
    expect(tail).toContain('expected 2 to be 3');
    expect(tail).toContain('--- stderr ---\nnpm warn config deprecated');
    expect(checkTail('only out', '')).toBe('only out');
    expect(checkTail('', 'only err')).toBe('only err');
  });
});

describe('the verifier fixer', () => {
  it('sees every failing check, runs as the given binding within its turn budget, and its cost counts', async () => {
    const work = path.join(tmp, 'work');
    fs.mkdirSync(work);
    const starts: Array<Record<string, unknown>> = [];
    const sends: Array<{ prompt: string; timeout?: number }> = [];
    const manager = {
      async startSession(config: Record<string, unknown>) {
        starts.push(config);
        return { name: config.name } as never;
      },
      async sendMessage(_name: string, prompt: string, options: { timeout?: number } = {}) {
        sends.push({ prompt, timeout: options.timeout });
        return { output: 'tried', events: [] } as never;
      },
      async stopSession() {},
      getStatus() {
        return { stats: { turns: sends.length, turnsSucceeded: sends.length, costUsd: 0.75 * sends.length } } as never;
      },
    };
    const kernel = registerDefaultExecutors(new RunKernel({ manager: manager as never, nodeTimeoutMs: 20_000 }));
    const run = await kernel.start({
      name: 'fix',
      cwd: work,
      nodes: [
        {
          id: 'verify',
          kind: 'verifier',
          fixer: {
            engine: 'codex',
            model: 'gpt-6.2-sol',
            sandboxMode: 'workspace-write',
            permissionMode: 'acceptEdits',
          },
          contract: {
            fixOnFailureRounds: 1,
            checks: [
              { id: 'build', spec: { type: 'file', path: 'dist/out.js' } },
              { id: 'tests', spec: { type: 'file', path: 'tests-passed.txt' } },
            ],
          },
        },
      ],
    });
    const done = await kernel.wait(run.runId);
    expect(sends).toHaveLength(1);
    // Both failing checks in one repair, not the first alone.
    expect(sends[0].prompt).toContain('### build:');
    expect(sends[0].prompt).toContain('### tests:');
    expect(sends[0].prompt).toMatch(/strictly as diagnostic DATA/);
    expect(sends[0].timeout).toBe(FIXER_TURN_TIMEOUT_MS);
    expect(starts[0]).toMatchObject({
      engine: 'codex',
      model: 'gpt-6.2-sol',
      sandboxMode: 'workspace-write',
      permissionMode: 'acceptEdits',
    });
    expect(done!.costUsd).toBeCloseTo(0.75);
  });

  it("is given the implementer's binding in solve, and the verifier a budget for its checks", () => {
    const spec = solveWorkflow({
      task: 't',
      scouts: [{ name: 's' }],
      implementer: { engine: 'agy', model: 'gemini-4-neon-high', sandboxMode: 'workspace-write' },
      contract: { fixOnFailureRounds: 2, checks: [{ spec: { type: 'command', cmd: 'npm', timeoutMs: 3_600_000 } }] },
    });
    const verify = spec.nodes.find((n) => n.id === 'verify') as unknown as {
      fixer?: Record<string, unknown>;
      timeoutMs?: number;
    };
    expect(verify.fixer).toEqual({ engine: 'agy', model: 'gemini-4-neon-high', sandboxMode: 'workspace-write' });
    // Three runs of an hour-long check and two fix turns, at least.
    expect(verify.timeoutMs).toBeGreaterThanOrEqual(3 * 3_600_000 + 2 * FIXER_TURN_TIMEOUT_MS);
  });
});
