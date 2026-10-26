/**
 * SessionManager's kernel + verification surface.
 *
 * HOME is redirected before the dynamic import because `session-manager.ts`
 * resolves its persisted-session registry and PID file from `os.homedir()` at
 * module load — a `beforeAll` runs too late and the test would write into the
 * developer's real ~/.openclaw state.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'clawo-wf-home-'));
process.env.HOME = FAKE_HOME;
process.env.USERPROFILE = FAKE_HOME;
const { SessionManager } = await import('../session-manager.js');
const { appendRunRow } = await import('../run-ledger.js');
type SessionManager = InstanceType<typeof SessionManager>;

let tmp: string;
const envKeys = ['CLAWO_RUNS_DIR', 'CLAWO_WF_DIR'] as const;
const saved: Record<string, string | undefined> = {};
let manager: SessionManager;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clawo-wf-'));
  for (const k of envKeys) saved[k] = process.env[k];
  process.env.CLAWO_RUNS_DIR = path.join(tmp, 'runs');
  process.env.CLAWO_WF_DIR = path.join(tmp, 'wf');
  manager = new SessionManager();
});

afterEach(async () => {
  await manager.shutdown();
  for (const k of envKeys) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k] as string;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

const row = (over: Record<string, unknown>) => ({
  ts: new Date().toISOString(),
  session: 's',
  engine: 'claude' as const,
  cwd: tmp,
  turn: 1,
  tokensIn: 10,
  tokensOut: 5,
  cachedTokens: 0,
  costUsd: 0.01,
  tokensEstimated: false,
  durationMs: 5,
  toolCalls: 0,
  toolErrors: 0,
  ok: true,
  ...over,
});

/** Replace the agent executor so nothing spawns a real engine. */
function stubAgents(m: SessionManager, result: { ok: boolean; output?: string } = { ok: true, output: 'done' }) {
  const kernel = (m as unknown as { kernel: { setExecutor: (k: string, f: unknown) => void } }).kernel;
  kernel.setExecutor('agent', async () => result);
  return kernel as unknown as {
    wait: (id: string) => Promise<{ state: string; outcome: string; evidenceId?: string }>;
  };
}

describe('workflow lifecycle', () => {
  it('completes as unverified when no contract is declared', async () => {
    const kernel = stubAgents(manager);
    const rec = await manager.workflowStart({ name: 'x', cwd: tmp, nodes: [{ id: 'a', kind: 'agent', prompt: 'go' }] });
    const done = await kernel.wait(rec.runId);
    expect(done.state).toBe('completed');
    expect(done.outcome).toBe('unverified');
  });

  it('completes as verified when the contract passes', async () => {
    const kernel = stubAgents(manager);
    const rec = await manager.workflowStart(
      { name: 'x', cwd: tmp, nodes: [{ id: 'a', kind: 'agent', prompt: 'go' }] },
      { contract: { checks: [{ type: 'command', cmd: 'true' }] } },
    );
    const done = await kernel.wait(rec.runId);
    expect(done.state).toBe('completed');
    expect(done.outcome).toBe('verified');
    expect(manager.workflowEvidence(rec.runId)?.passed).toBe(true);
  });

  it('fails — never completes — when the contract is red', async () => {
    const kernel = stubAgents(manager);
    const rec = await manager.workflowStart(
      { name: 'x', cwd: tmp, nodes: [{ id: 'a', kind: 'agent', prompt: 'go' }] },
      { contract: { checks: [{ type: 'command', cmd: 'false' }] } },
    );
    const done = await kernel.wait(rec.runId);
    expect(done.state).toBe('failed');
    expect(done.outcome).toBe('refuted');
    expect(manager.workflowEvidence(rec.runId)?.passed).toBe(false);
  });

  it('lists runs and reports an unknown one rather than returning undefined', async () => {
    const kernel = stubAgents(manager);
    const rec = await manager.workflowStart({ name: 'x', cwd: tmp, nodes: [{ id: 'a', kind: 'agent', prompt: 'go' }] });
    await kernel.wait(rec.runId);
    expect(manager.workflowList().map((r) => r.runId)).toContain(rec.runId);
    expect(() => manager.workflowStatus('nope')).toThrow(/not found/);
  });
});

describe('verifyRun', () => {
  it('runs a caller contract against a directory and returns the bundle', async () => {
    fs.writeFileSync(path.join(tmp, 'present.txt'), 'x');
    const bundle = await manager.verifyRun({
      cwd: tmp,
      label: 'standalone',
      contract: {
        checks: [
          { type: 'file', path: 'present.txt' },
          { type: 'command', cmd: 'true' },
        ],
      },
    });
    expect(bundle.passed).toBe(true);
    expect(bundle.results).toHaveLength(2);
  });

  it('refuses a contract with nothing recognisable in it', async () => {
    await expect(manager.verifyRun({ cwd: tmp, contract: { checks: [{ type: 'rm_rf' }] } })).rejects.toThrow(
      /at least one recognised check/,
    );
  });
});

describe('ledger verdict join', () => {
  it('fills a turn row from the verdict of the run it belonged to', async () => {
    const kernel = stubAgents(manager);
    const rec = await manager.workflowStart(
      { name: 'x', cwd: tmp, nodes: [{ id: 'a', kind: 'agent', prompt: 'go' }] },
      { contract: { checks: [{ type: 'command', cmd: 'true' }] } },
    );
    await kernel.wait(rec.runId);

    appendRunRow(row({ session: 'in-run', parent: rec.runId, nodeKind: 'agent' }));
    appendRunRow(row({ session: 'loose' }));

    const { rows, summary } = manager.getRunLedger({ since: '1h' });
    const inRun = rows.find((r) => r.session === 'in-run')!;
    const loose = rows.find((r) => r.session === 'loose')!;
    expect(inRun.verified).toBe(true);
    expect(inRun.evidenceId).toBeTruthy();
    // Not false — nothing checked this turn, and saying "not verified" would
    // read as "checked and failed".
    expect(loose.verified).toBeUndefined();
    expect(summary.verifiedRows).toBe(1);
    expect(summary.unverifiedRows).toBe(1);
  });

  it('filters on verified AFTER the join, not before it', async () => {
    const kernel = stubAgents(manager);
    const rec = await manager.workflowStart(
      { name: 'x', cwd: tmp, nodes: [{ id: 'a', kind: 'agent', prompt: 'go' }] },
      { contract: { checks: [{ type: 'command', cmd: 'true' }] } },
    );
    await kernel.wait(rec.runId);
    appendRunRow(row({ session: 'in-run', parent: rec.runId }));
    appendRunRow(row({ session: 'loose' }));

    // Passing the filter down to the ledger read would match on a field no row
    // carries at that point and return nothing at all.
    expect(manager.getRunLedger({ since: '1h', verified: true }).rows.map((r) => r.session)).toEqual(['in-run']);
    expect(manager.getRunLedger({ since: '1h', verified: false }).rows).toEqual([]);
  });

  it('applies the row limit after the verified filter', async () => {
    const kernel = stubAgents(manager);
    const rec = await manager.workflowStart(
      { name: 'x', cwd: tmp, nodes: [{ id: 'a', kind: 'agent', prompt: 'go' }] },
      { contract: { checks: [{ type: 'command', cmd: 'true' }] } },
    );
    await kernel.wait(rec.runId);
    appendRunRow(row({ session: 'in-run-1', parent: rec.runId }));
    appendRunRow(row({ session: 'in-run-2', parent: rec.runId }));
    for (let i = 0; i < 5; i++) appendRunRow(row({ session: `loose-${i}` }));

    // The five newest rows are all unjudged. Limiting before filtering would
    // keep only those and find no verified row at all.
    expect(manager.getRunLedger({ since: '1h', verified: true, limit: 2 }).rows.map((r) => r.session)).toEqual([
      'in-run-1',
      'in-run-2',
    ]);
    expect(manager.getRunLedger({ since: '1h', verified: true, limit: 1 }).rows.map((r) => r.session)).toEqual([
      'in-run-2',
    ]);
  });

  it('leaves rows alone when their run has no verdict', async () => {
    const kernel = stubAgents(manager);
    const rec = await manager.workflowStart({ name: 'x', cwd: tmp, nodes: [{ id: 'a', kind: 'agent', prompt: 'go' }] });
    await kernel.wait(rec.runId);
    appendRunRow(row({ session: 'in-run', parent: rec.runId }));
    expect(manager.getRunLedger({ since: '1h' }).rows[0].verified).toBeUndefined();
  });
});

// ─── Council: decisions and control on a run that is not live here ─────────

/**
 * A council that has finished and parked for the user's decision. The council
 * executor is stubbed with what the real one publishes on consensus, so the
 * run is a real record on disk and nothing spawns an engine.
 */
async function finishedCouncil(m: SessionManager, projectDir: string): Promise<string> {
  const kernel = (
    m as unknown as {
      kernel: { setExecutor: (k: string, f: unknown) => void; wait: (id: string) => Promise<unknown> };
    }
  ).kernel;
  kernel.setExecutor('council', async () => ({
    ok: true,
    output: 'consensus',
    data: {
      task: 'do the thing',
      responses: [],
      councilStatus: 'awaiting_user',
      agents: [{ name: 'a' }],
      maxRounds: 1,
      projectDir,
    },
  }));
  const session = await m.councilStart('do the thing', {
    agents: [{ name: 'a', emoji: '🔵', persona: 'p' }],
    maxRounds: 1,
    projectDir,
  });
  await kernel.wait(session.id);
  return session.id;
}

function gitRepo(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  execSync('git init -q -b main', { cwd: dir });
  execSync('git config user.email t@t.com && git config user.name T', { cwd: dir });
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hi\n');
  execSync('git add -A && git commit -q -m init', { cwd: dir });
  return dir;
}

describe('council accept / reject', () => {
  it('records accepted on the run, so council_status reports it — in this process and the next', async () => {
    const id = await finishedCouncil(manager, gitRepo(path.join(tmp, 'repo')));
    expect(manager.councilStatus(id)?.status).toBe('awaiting_user');

    await manager.councilAccept(id);

    expect(manager.councilStatus(id)?.status).toBe('accepted');
    const next = new SessionManager();
    try {
      expect(next.councilStatus(id)?.status).toBe('accepted');
    } finally {
      await next.shutdown();
    }
  });

  it('records rejected on the run', async () => {
    const id = await finishedCouncil(manager, gitRepo(path.join(tmp, 'repo')));
    await manager.councilReject(id, 'needs work');
    expect(manager.councilStatus(id)?.status).toBe('rejected');
  });
});

describe('council abort', () => {
  it('says nothing was aborted when the council is not running in this process', async () => {
    const id = await finishedCouncil(manager, gitRepo(path.join(tmp, 'repo')));
    const result = manager.councilAbort(id);
    expect(result.aborted).toBe(false);
    expect(result.state).toBe('completed');
    expect(result.reason).toMatch(/not running in this process/);
  });

  it('aborts a council that is running here', async () => {
    const kernel = (
      manager as unknown as {
        kernel: { setExecutor: (k: string, f: unknown) => void; wait: (id: string) => Promise<{ state: string }> };
      }
    ).kernel;
    kernel.setExecutor('council', async (_node: unknown, ctx: { signal: { aborted: boolean } }) => {
      while (!ctx.signal.aborted) await new Promise((r) => setTimeout(r, 10));
      return { ok: false, error: 'cancelled' };
    });
    const session = await manager.councilStart('do the thing', {
      agents: [{ name: 'a', emoji: '🔵', persona: 'p' }],
      maxRounds: 1,
      projectDir: tmp,
    });

    expect(manager.councilAbort(session.id)).toEqual({ aborted: true });
    expect((await kernel.wait(session.id)).state).toBe('cancelled');
  });

  it('still throws for a council that does not exist', () => {
    expect(() => manager.councilAbort('no-such-council')).toThrow("Council 'no-such-council' not found");
  });
});
