/**
 * One ledger row per workflow run: its verdict, cost and spend by engine and
 * model, so success and cost can be compared per model across runs.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  appendRunOutcome,
  appendRunRow,
  formatOutcomeGroups,
  groupRunOutcomes,
  outcomeKey,
  readRunLedger,
  readRunOutcomes,
  type RunOutcomeRow,
} from '../run-ledger.js';
import { RunKernel } from '../kernel/engine.js';
import { registerDefaultExecutors } from '../kernel/nodes/index.js';

let tmp: string;
const saved = { runs: process.env.CLAWO_RUNS_DIR, wf: process.env.CLAWO_WF_DIR };
beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clawo-outcomes-')));
  process.env.CLAWO_RUNS_DIR = path.join(tmp, 'runs');
  process.env.CLAWO_WF_DIR = path.join(tmp, 'wf');
});
afterEach(() => {
  for (const [k, v] of [
    ['CLAWO_RUNS_DIR', saved.runs],
    ['CLAWO_WF_DIR', saved.wf],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

const outcome = (over: Partial<RunOutcomeRow>): RunOutcomeRow => ({
  ts: new Date().toISOString(),
  runId: 'wf-1',
  workflow: 'solve',
  state: 'completed',
  outcome: 'verified',
  costUsd: 1,
  durationMs: 60_000,
  cwd: '/repo',
  agents: [{ engine: 'codex', model: 'gpt-6.1-terra', costUsd: 1, turns: 3 }],
  ...over,
});

describe('run rows', () => {
  it('group by model with the verified rate over checked runs, cost per verified run and the median time', () => {
    const terra = [{ engine: 'codex', model: 'gpt-6.1-terra', costUsd: 1, turns: 1 }];
    const rows = [
      outcome({ runId: 'a', costUsd: 1, durationMs: 10_000, agents: terra }),
      outcome({ runId: 'b', costUsd: 2, durationMs: 30_000, agents: terra, outcome: 'refuted', state: 'failed' }),
      outcome({ runId: 'c', costUsd: 3, durationMs: 20_000, agents: terra }),
      outcome({ runId: 'd', costUsd: 4, durationMs: 40_000, agents: terra, outcome: 'unverified' }),
      outcome({
        runId: 'e',
        agents: [
          { engine: 'codex', model: 'gpt-6.1-terra', costUsd: 1, turns: 1 },
          { engine: 'claude', costUsd: 1, turns: 1 },
        ],
      }),
    ];
    const groups = groupRunOutcomes(rows, 'model');
    expect(groups[0]).toEqual({
      key: 'codex:gpt-6.1-terra',
      runs: 4,
      verified: 2,
      refuted: 1,
      unverified: 1,
      notCompleted: 1,
      verifiedRate: 2 / 3,
      costUsd: 10,
      costPerVerified: 5,
      medianDurationMs: 25_000,
    });
    // A run several models took part in is its own group, not split between them.
    expect(groups[1].key).toBe('claude:default + codex:gpt-6.1-terra');
    expect(outcomeKey(rows[4], 'engine')).toBe('claude + codex');
    expect(formatOutcomeGroups(groups, 'model')).toMatch(/codex:gpt-6\.1-terra\s+4\s+2\s+1\s+1\s+67%/);
  });

  it('keep the latest row of a run that ended twice, and stay out of the turn ledger', () => {
    appendRunOutcome(outcome({ runId: 'x', ts: '2026-11-24T01:00:00.000Z', outcome: 'refuted' }));
    appendRunOutcome(outcome({ runId: 'x', ts: '2026-11-24T02:00:00.000Z', outcome: 'verified' }));
    appendRunOutcome(outcome({ runId: 'y', ts: '2026-11-23T02:00:00.000Z' }));
    const rows = readRunOutcomes({ since: '2026-11-24T00:00:00.000Z' });
    expect(rows.map((r) => [r.runId, r.outcome])).toEqual([['x', 'verified']]);
    expect(readRunLedger({ since: '2026-11-01T00:00:00.000Z' })).toEqual([]);
  });
});

describe('a workflow run as it ends', () => {
  it("writes its row: verdict, cost, and its agents' spend by engine and model", async () => {
    const repo = path.join(tmp, 'repo');
    fs.mkdirSync(repo);
    const kernel = registerDefaultExecutors(new RunKernel({ nodeTimeoutMs: 20_000 }));
    // What a session's turn writes: a row under the run's id.
    kernel.setExecutor('agent', async (node, ctx) => {
      const engine = (node as { engine?: string }).engine === 'claude' ? 'claude' : 'codex';
      const model = engine === 'claude' ? 'claude-opus-5' : 'gpt-6.1-terra';
      appendRunRow({
        ts: new Date().toISOString(),
        session: `${ctx.runId}-${node.id}`,
        engine,
        model,
        cwd: repo,
        turn: 1,
        tokensIn: 1,
        tokensOut: 1,
        cachedTokens: 0,
        costUsd: engine === 'claude' ? 0.2 : 0.3,
        tokensEstimated: false,
        durationMs: 1,
        toolCalls: 0,
        toolErrors: 0,
        ok: true,
        parent: ctx.runId,
      });
      fs.writeFileSync(path.join(repo, 'out.txt'), 'done\n');
      return { ok: true, output: 'ok', costUsd: engine === 'claude' ? 0.2 : 0.3 };
    });
    const run = await kernel.start({
      name: 'solve',
      cwd: repo,
      contract: { id: 'has-out', checks: [{ spec: { type: 'file', path: 'out.txt' } }] },
      nodes: [
        { id: 'scout', kind: 'agent', prompt: 'look', engine: 'claude', next: 'impl' },
        { id: 'impl', kind: 'agent', prompt: 'do', engine: 'codex' },
      ],
    });
    const done = await kernel.wait(run.runId);
    expect(done!.outcome).toBe('verified');

    const [row] = readRunOutcomes();
    expect(row).toMatchObject({
      runId: run.runId,
      workflow: 'solve',
      state: 'completed',
      outcome: 'verified',
      costUsd: 0.5,
      cwd: repo,
      contractId: 'has-out',
    });
    expect(row.agents.sort((a, b) => a.engine.localeCompare(b.engine))).toEqual([
      { engine: 'claude', model: 'claude-opus-5', costUsd: 0.2, turns: 1 },
      { engine: 'codex', model: 'gpt-6.1-terra', costUsd: 0.3, turns: 1 },
    ]);
    expect(row.durationMs).toBeGreaterThanOrEqual(0);
  });
});
