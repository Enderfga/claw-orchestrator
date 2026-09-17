/**
 * The session cap has to hold when many sessions start in the same tick, and
 * the multi-agent runners have to wait for a slot rather than fail on it.
 *
 * The cap used to be checked against the live-session map only. A session
 * enters that map after its process is up, so every start launched together —
 * a fan-out's agents — passed the check, and N agents meant N engine processes
 * whatever the cap said.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import type {
  ISession,
  SessionConfig,
  SessionStats,
  TurnResult,
  CostBreakdown,
  EffortLevel,
  CouncilConfig,
} from '../types.js';
import { mapBounded } from '../concurrency.js';
import { SessionManager } from '../session-manager.js';
import { Fanout } from '../fanout.js';
import { Council } from '../council.js';
import {
  legacyFanoutWorkflow,
  legacyCouncilWorkflow,
  fanoutWorkflow,
  councilWorkflow,
  solveWorkflow,
  fanoutNodeBudget,
  councilNodeBudget,
} from '../kernel/templates/index.js';
import { RunKernel } from '../kernel/engine.js';

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

const live = { now: 0, peak: 0 };
const sendMs = { value: 5 };
const started: Array<{ at: number }> = [];

class SlowStartSession extends EventEmitter implements ISession {
  sessionId?: string;
  private turns = 0;
  get isReady() {
    return true;
  }
  get isPaused() {
    return false;
  }
  get isBusy() {
    return false;
  }
  async start(): Promise<this> {
    // The window every concurrent start used to slip through.
    await tick();
    started.push({ at: Date.now() });
    live.now++;
    live.peak = Math.max(live.peak, live.now);
    this.sessionId = 'slow';
    return this;
  }
  stop(): void {
    live.now--;
  }
  pause(): void {}
  resume(): void {}
  async send(): Promise<TurnResult> {
    await tick(sendMs.value);
    this.turns++;
    return { text: 'answer', event: { type: 'result', result: 'answer' } };
  }
  getStats(): SessionStats & { sessionId?: string; uptime: number } {
    return {
      turns: this.turns,
      turnsSucceeded: this.turns,
      toolCalls: 0,
      toolErrors: 0,
      tokensIn: 0,
      tokensOut: 0,
      cachedTokens: 0,
      costUsd: 0,
      isReady: true,
      startTime: null,
      lastActivity: null,
      contextPercent: 0,
      retries: 0,
      sessionId: this.sessionId,
      uptime: 0,
    };
  }
  getHistory(): Array<{ time: string; type: string; event: unknown }> {
    return [];
  }
  getCost(): CostBreakdown {
    return {
      model: 'default',
      tokensIn: 0,
      tokensOut: 0,
      cachedTokens: 0,
      pricing: { inputPer1M: 0, outputPer1M: 0, cachedPer1M: 0 },
      breakdown: { inputCost: 0, cachedCost: 0, outputCost: 0 },
      totalUsd: 0,
    };
  }
  async compact(): Promise<void> {}
  getEffort(): EffortLevel {
    return 'auto';
  }
  setEffort(): void {}
  resolveModel(alias: string): string {
    return alias;
  }
}

const managers: SessionManager[] = [];

function makeManager(cap: number): SessionManager {
  const mgr = new SessionManager({
    claudeBin: 'mock-claude',
    maxConcurrentSessions: cap,
    sessionTtlMinutes: 120,
    defaultPermissionMode: 'acceptEdits',
    defaultEffort: 'auto',
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (mgr as any)._createSession = (_engine: string, _config: SessionConfig): ISession => new SlowStartSession();
  managers.push(mgr);
  return mgr;
}

afterEach(async () => {
  for (const m of managers.splice(0)) await m.shutdown();
  live.now = 0;
  live.peak = 0;
  sendMs.value = 5;
  started.length = 0;
});

const settle = async (mgr: SessionManager, id: string) => {
  for (let i = 0; i < 400; i++) {
    const s = mgr.fanoutStatus(id);
    if (s.status !== 'running') return s;
    await tick(10);
  }
  throw new Error('fan-out did not settle');
};

describe('mapBounded', () => {
  it('keeps input order and never exceeds the limit', async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await mapBounded([30, 5, 20, 1, 10], 2, async (ms, i) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await tick(ms);
      inFlight--;
      return i;
    });
    expect(out).toEqual([0, 1, 2, 3, 4]);
    expect(peak).toBe(2);
  });
});

describe('session cap', () => {
  it('holds when sessions start concurrently', async () => {
    const mgr = makeManager(3);
    const starts = await Promise.allSettled(
      Array.from({ length: 5 }, (_, i) => mgr.startSession({ name: `s${i}`, engine: 'codex', cwd: os.tmpdir() })),
    );
    expect(starts.filter((s) => s.status === 'fulfilled')).toHaveLength(3);
    const refused = starts.filter((s): s is PromiseRejectedResult => s.status === 'rejected');
    expect(refused).toHaveLength(2);
    expect(String(refused[0].reason)).toMatch(/Max concurrent sessions \(3\)/);
    expect(live.peak).toBe(3);
    expect(mgr.freeSessionSlots()).toBe(0);
  });

  it('gives a slot back when a start fails', async () => {
    const mgr = makeManager(1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mgr as any)._createSession = (): ISession => {
      const s = new SlowStartSession();
      s.start = async () => {
        await tick();
        throw new Error('engine would not start');
      };
      return s;
    };
    await expect(mgr.startSession({ name: 'broken', engine: 'codex', cwd: os.tmpdir() })).rejects.toThrow(
      'engine would not start',
    );
    expect(mgr.freeSessionSlots()).toBe(1);
  });
});

describe('multi-agent runners wait for a slot', () => {
  it('fan-out runs every agent, never more at once than the cap', async () => {
    const mgr = makeManager(2);
    const fan = new Fanout(
      {
        task: 'answer',
        projectDir: os.tmpdir(),
        agents: ['a', 'b', 'c', 'd', 'e'].map((name) => ({ name, engine: 'codex' as const })),
      },
      mgr,
    );
    const session = await fan.run();
    expect(session.results.map((r) => r.ok)).toEqual([true, true, true, true, true]);
    expect(live.peak).toBeLessThanOrEqual(2);
  });

  it('does not time a queued fan-out out on one agent budget', async () => {
    // Four 300ms agents through two slots take two waves, ~600ms, under a
    // 500ms per-agent timeout. Sized as one agent's budget, the node timed out
    // mid-way and returned no results at all.
    const mgr = makeManager(2);
    sendMs.value = 300;
    const run = await mgr.fanoutStart({
      task: 'answer',
      projectDir: os.tmpdir(),
      agentTimeoutMs: 500,
      agents: ['a', 'b', 'c', 'd'].map((name) => ({ name, engine: 'codex' as const })),
    });
    const done = await settle(mgr, run.id);
    expect(done.status).toBe('done');
    expect(done.results.map((r) => r.ok)).toEqual([true, true, true, true]);
  });

  it('sizes the legacy node timeout for the worst case and keeps the per-agent one', () => {
    const spec = legacyFanoutWorkflow({
      task: 't',
      cwd: os.tmpdir(),
      agents: [{ name: 'a' }, { name: 'b' }, { name: 'c' }],
      synthesize: true,
      timeoutMs: 1000,
    });
    const node = spec.nodes[0] as { timeoutMs?: number; agentTimeoutMs?: number };
    expect(node.agentTimeoutMs).toBe(1000);
    expect(node.timeoutMs).toBe(fanoutNodeBudget(3, true, 1000));
    expect(node.timeoutMs).toBeGreaterThanOrEqual(4 * 1000);
  });

  it("keeps an agent's own default timeout when the caller gives none, in every template", () => {
    // Left unset, the executor falls back to the node timeout — the whole mode's
    // budget — and one hung agent would hold its slot for hours.
    const agents = [{ name: 'a' }, { name: 'b' }];
    const nodesOf = (spec: { nodes: unknown[] }) =>
      spec.nodes as Array<{ kind: string; agentTimeoutMs?: number; timeoutMs?: number; synthesize?: boolean }>;
    const fanouts = [
      ...nodesOf(legacyFanoutWorkflow({ task: 't', cwd: '/x', agents })),
      ...nodesOf(fanoutWorkflow({ task: 't', agents })),
      ...nodesOf(solveWorkflow({ task: 't', scouts: agents, reviewers: agents })).filter((n) => n.kind === 'fanout'),
    ];
    const councils = [
      ...nodesOf(legacyCouncilWorkflow({ task: 't', cwd: '/x', agents, maxRounds: 3 })),
      ...nodesOf(councilWorkflow({ task: 't', agents })),
    ];
    expect(fanouts).toHaveLength(4);
    for (const n of fanouts) {
      expect(n.agentTimeoutMs).toBe(600_000);
      expect(n.timeoutMs).toBe(fanoutNodeBudget(2, n.synthesize));
    }
    for (const n of councils) {
      expect(n.agentTimeoutMs).toBe(1_800_000);
      expect(n.timeoutMs).toBeGreaterThanOrEqual(3 * 2 * 1_800_000);
    }
    expect(councilNodeBudget(2, 3)).toBe(councils[0].timeoutMs);
  });

  it('does not let a node timeout past the 32-bit timer limit fire at once', async () => {
    const kernel = new RunKernel({ nodeTimeoutMs: 8000 });
    kernel.setExecutor('agent', async () => {
      await tick(30);
      return { ok: true };
    });
    const rec = await kernel.start({
      name: 'long',
      nodes: [{ id: 'a', kind: 'agent', prompt: 'go', timeoutMs: 3_000_000_000 }],
    });
    expect((await kernel.wait(rec.runId))!.state).toBe('completed');
  });

  it('starts no queued agent after the fan-out is aborted', async () => {
    const mgr = makeManager(1);
    sendMs.value = 150;
    const run = await mgr.fanoutStart({
      task: 'answer',
      projectDir: os.tmpdir(),
      agents: ['a', 'b', 'c'].map((name) => ({ name, engine: 'codex' as const })),
    });
    await tick(80);
    const abortedAt = Date.now();
    mgr.fanoutAbort(run.id);
    await tick(600);
    expect(started.filter((s) => s.at > abortedAt)).toHaveLength(0);
  });

  it('stops starting queued agents once the kernel gives up on the node', async () => {
    const mgr = makeManager(1);
    sendMs.value = 250;
    await mgr.workflowStart({
      name: 'slow-fanout',
      cwd: os.tmpdir(),
      nodes: [
        {
          id: 'fan',
          kind: 'fanout',
          prompt: 'answer',
          timeoutMs: 300,
          agentTimeoutMs: 5000,
          agents: [{ name: 'a' }, { name: 'b' }, { name: 'c' }].map((a) => ({ ...a, engine: 'codex' as const })),
        },
      ],
    });
    await tick(320);
    const gaveUpAt = Date.now();
    await tick(900);
    // `b` may already be past its check when the node times out; `c` must not start.
    expect(started.filter((s) => s.at > gaveUpAt + 50).length).toBe(0);
  });

  it('council opens no further round once its signal is set', async () => {
    const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'council-signal-'));
    try {
      execSync('git init -b main && git config user.email t@example.com && git config user.name t', {
        cwd: dir,
        stdio: 'pipe',
      });
      fs.writeFileSync(path.join(dir, 'README.md'), '# t\n');
      execSync('git add -A && git commit -m init', { cwd: dir, stdio: 'pipe' });
      const signal = { aborted: false };
      let starts = 0;
      const manager = {
        startSession: async () => {
          starts++;
          return {} as never;
        },
        sendMessage: async () => {
          await tick(20);
          // The kernel gives up on the node during round one.
          signal.aborted = true;
          return { output: `${'a thorough report '.repeat(20)}\n[CONSENSUS: NO]`, events: [] } as never;
        },
        stopSession: async () => {},
      };
      const config: CouncilConfig = {
        agents: ['A', 'B'].map((name) => ({ name, emoji: '*', persona: 'reviewer', engine: 'codex' })),
        maxRounds: 3,
        projectDir: dir,
        signal,
      };
      await new Council(config, manager).run('review the readme');
      expect(starts).toBe(2);
      // Stopped by the kernel, not aborted: a retry of the node may be using these.
      expect(fs.readdirSync(path.join(dir, '.worktrees')).sort()).toEqual(['A', 'B']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('council runs a round no wider than the free slots', async () => {
    const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'council-cap-'));
    try {
      execSync('git init -b main && git config user.email t@example.com && git config user.name t', {
        cwd: dir,
        stdio: 'pipe',
      });
      fs.writeFileSync(path.join(dir, 'README.md'), '# t\n');
      execSync('git add -A && git commit -m init', { cwd: dir, stdio: 'pipe' });

      let inFlight = 0;
      let peak = 0;
      const manager = {
        startSession: async () => ({}) as never,
        sendMessage: async () => {
          inFlight++;
          peak = Math.max(peak, inFlight);
          await tick(10);
          inFlight--;
          return { output: `${'a thorough report '.repeat(20)}\n[CONSENSUS: YES]`, events: [] } as never;
        },
        stopSession: async () => {},
        freeSessionSlots: () => 2,
      };
      const config: CouncilConfig = {
        agents: ['A', 'B', 'C', 'D'].map((name) => ({ name, emoji: '*', persona: 'reviewer', engine: 'codex' })),
        maxRounds: 1,
        projectDir: dir,
      };
      const council = new Council(config, manager);
      const session = await council.run('review the readme');
      expect(session.responses.filter((r) => r.round === 1)).toHaveLength(4);
      expect(peak).toBe(2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
