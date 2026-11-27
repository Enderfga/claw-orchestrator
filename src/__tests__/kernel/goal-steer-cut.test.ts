/**
 * A goal objective holds 4,000 characters, so the preface in front of it (the
 * forum brief, the steers, the failing checks) may be cut. A steer is handed
 * over with the objective only when its text is in what the objective kept;
 * one the cut dropped is steered into the live turn, or goes back to the run's
 * queue when the goal ends.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RunKernel } from '../../kernel/engine.js';
import { registerDefaultExecutors } from '../../kernel/nodes/index.js';
import { composeObjectiveKept, type GoalSnapshot, type GoalStatus } from '../../kernel/nodes/goal.js';
import { loadRun, readEvents } from '../../kernel/store.js';
import { forumRuntimePost, forumSnapshot } from '../../kernel/forum.js';
import type { WorkflowSpec } from '../../kernel/types.js';

let tmp: string;
const saved = { wf: process.env.CLAWO_WF_DIR, spool: process.env.CLAWO_FORUM_SPOOL_ROOT };

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clawo-goalcut-'));
  process.env.CLAWO_WF_DIR = path.join(tmp, 'wf');
  process.env.CLAWO_FORUM_SPOOL_ROOT = path.join(tmp, 'spool');
});

afterEach(() => {
  for (const [k, v] of [
    ['CLAWO_WF_DIR', saved.wf],
    ['CLAWO_FORUM_SPOOL_ROOT', saved.spool],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

type SetParams = { objective?: string; status?: 'active' | 'paused'; tokenBudget?: number | null; context?: string };

/**
 * A Codex goal session. Without a live turn its goal completes at once; with
 * one, it completes after the first steer (or after a short wait).
 */
class FakeGoalSession extends EventEmitter {
  goal: GoalSnapshot | null = null;
  lastError = null;
  turnActive = false;
  sets: SetParams[] = [];
  steered: string[] = [];
  constructor(
    readonly codexThreadId: string,
    private readonly liveTurn: boolean,
  ) {
    super();
  }
  move(status: GoalStatus): void {
    this.goal = { ...(this.goal as GoalSnapshot), status };
    if (status === 'complete') this.turnActive = false;
    setImmediate(() => this.emit('goal:updated', this.goal));
  }
  async setGoal(p: SetParams): Promise<GoalSnapshot> {
    this.sets.push(p);
    this.goal = {
      objective: p.objective ?? this.goal?.objective ?? '',
      status: p.status ?? 'active',
      tokenBudget: p.tokenBudget ?? null,
      tokensUsed: 0,
      timeUsedSeconds: 0,
    };
    const snap = { ...this.goal };
    if (this.liveTurn) {
      this.turnActive = true;
      setTimeout(() => this.goal?.status === 'active' && this.move('complete'), 1_500).unref();
    } else {
      setImmediate(() => this.move('complete'));
    }
    return snap;
  }
  async getGoal() {
    return this.goal;
  }
  async clearGoal() {
    this.goal = null;
  }
  async steer(text: string) {
    if (!this.turnActive) return { steered: false };
    this.steered.push(text);
    setImmediate(() => this.move('complete'));
    return { steered: true };
  }
  async interrupt() {
    return { interrupted: true };
  }
}

const STEER = 'STEER-MARKER ' + 'S'.repeat(780) + ' use the LRU cache';

/**
 * A codex goal behind a gate. While the gate is parked: a long user post to the
 * whole run and a steer, so the forum brief in front of the objective shows
 * both and pushes the steer past what the objective can hold.
 */
async function goalWithCutSteer(liveTurn: boolean) {
  const sessions = new Map<string, FakeGoalSession>();
  const manager = {
    async startSession(config: Record<string, unknown>) {
      sessions.set(String(config.name), new FakeGoalSession('thread-X', liveTurn));
      return { name: config.name } as never;
    },
    async sendMessage() {
      throw new Error('no chat');
    },
    async stopSession() {},
    codexGoalSession(name: string) {
      return sessions.get(name) as never;
    },
  };
  const kernel = registerDefaultExecutors(new RunKernel({ manager: manager as never, nodeTimeoutMs: 20_000 }));
  const spec: WorkflowSpec = {
    name: 'goal-cut',
    cwd: tmp,
    forum: true,
    nodes: [
      { id: 'gate', kind: 'human_gate', prompt: 'go?' },
      { id: 'goal', kind: 'goal', objective: 'O'.repeat(1_600) + ' make it fast', engine: 'codex' },
    ],
  };
  const run = await kernel.start(spec);
  for (let i = 0; i < 200 && loadRun(run.runId)?.state !== 'awaiting_human'; i++) {
    await new Promise((r) => setTimeout(r, 25));
  }
  await forumRuntimePost(run.runId, { from: 'user', title: 'INFO: background', body: 'B'.repeat(950) + ' background' });
  expect(kernel.steer(run.runId, STEER)).toBe(true);
  expect(kernel.approve(run.runId, true)).toBe(true);
  await kernel.wait(run.runId);
  const session = sessions.values().next().value as FakeGoalSession;
  const steerPost = forumSnapshot(run.runId).posts.find((p) => p.data?.kind === 'steer')!;
  const deliveries = forumSnapshot(run.runId)
    .events.filter((e) => e.type === 'delivered' && (e as { id?: string }).id === steerPost.id)
    .map((e) => `${e.who}/${(e as { via?: string }).via}`);
  const consumed = readEvents(run.runId)
    .filter((e) => e.type === 'steer_consumed')
    .reduce((n, e) => n + (e as { count: number }).count, 0);
  return { session, objective: String(session.sets[0].objective), deliveries, consumed };
}

describe('a goal steer the objective cut', () => {
  it('is not recorded as handed over, and goes back to the queue when no turn takes it', async () => {
    const { session, objective, deliveries, consumed } = await goalWithCutSteer(false);
    expect(objective).toContain('[cut to fit the goal objective limit]');
    expect(objective).not.toContain('STEER-MARKER');
    expect(session.steered).toEqual([]);
    expect(deliveries).not.toContain('goal/turn');
    expect(deliveries).not.toContain('goal/push');
    expect(consumed).toBe(0);
  });

  it('is steered into the live turn', async () => {
    const { session, objective, deliveries, consumed } = await goalWithCutSteer(true);
    expect(objective).not.toContain('STEER-MARKER');
    expect(session.steered).toEqual([STEER]);
    expect(deliveries).toContain('goal/push');
    expect(deliveries).not.toContain('goal/turn');
    expect(consumed).toBe(1);
  });
});

describe('composeObjectiveKept', () => {
  it('says how much of the preface the objective carries', () => {
    expect(composeObjectiveKept(['ab', 'cd'], 'task')).toEqual({ objective: 'ab\n\ncd\n\n---\n\ntask', kept: 6 });
    expect(composeObjectiveKept([], 'task')).toEqual({ objective: 'task', kept: 0 });
    const cut = composeObjectiveKept(['p'.repeat(5_000)], 'task');
    expect(cut.objective.startsWith('p'.repeat(cut.kept) + '\n[cut')).toBe(true);
    expect(cut.kept).toBeLessThan(5_000);
  });
});
