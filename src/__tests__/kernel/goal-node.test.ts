/**
 * The `goal` node: a Codex `/goal` on one `codex-app` thread.
 *
 * The session is a fake that speaks the node's `GoalSession` surface, scripted
 * per test. What these pin is the node's own contract: it finishes on the
 * goal's terminal status, it reattaches the same thread instead of starting
 * over, it resumes a stalled or usage-limited goal only within its bound, and a
 * red verifier sends the goal back to the same thread with the failing checks.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RunKernel } from '../../kernel/engine.js';
import { registerDefaultExecutors } from '../../kernel/nodes/index.js';
import { composeObjective, GOAL_OBJECTIVE_MAX_CHARS } from '../../kernel/nodes/goal.js';
import type { GoalSnapshot, GoalStatus, GoalNodeData } from '../../kernel/nodes/goal.js';
import { goalWorkflow } from '../../kernel/templates/index.js';
import type { WorkflowSpec } from '../../kernel/types.js';

let tmp: string;
const saved = process.env.CLAWO_WF_DIR;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clawo-goal-'));
  process.env.CLAWO_WF_DIR = path.join(tmp, 'wf');
});

afterEach(() => {
  if (saved === undefined) delete process.env.CLAWO_WF_DIR;
  else process.env.CLAWO_WF_DIR = saved;
  fs.rmSync(tmp, { recursive: true, force: true });
});

type SetParams = { objective?: string; status?: 'active' | 'paused'; tokenBudget?: number | null };

/** A codex-app thread whose goal moves only when a test (or its script) says so. */
class FakeGoalSession extends EventEmitter {
  goal: GoalSnapshot | null = null;
  lastError: { message: string; code: string | null; willRetry: boolean; at: string } | null = null;
  turnActive = false;
  sets: SetParams[] = [];
  clears = 0;
  steered: string[] = [];
  interrupted = 0;
  /** Called after every setGoal, to let the script move the goal on. */
  onSet: (p: SetParams, s: FakeGoalSession) => void = () => {};

  constructor(readonly codexThreadId: string) {
    super();
  }

  move(status: GoalStatus, over: Partial<GoalSnapshot> = {}): void {
    this.goal = { ...(this.goal as GoalSnapshot), status, ...over };
    setImmediate(() => this.emit('goal:updated', this.goal));
  }

  async setGoal(p: SetParams): Promise<GoalSnapshot> {
    this.sets.push(p);
    this.goal = {
      objective: p.objective ?? this.goal?.objective ?? '',
      status: p.status ?? 'active',
      tokenBudget: p.tokenBudget ?? this.goal?.tokenBudget ?? null,
      tokensUsed: this.goal?.tokensUsed ?? 0,
      timeUsedSeconds: this.goal?.timeUsedSeconds ?? 0,
    };
    const snapshot = { ...this.goal };
    setImmediate(() => this.onSet(p, this));
    return snapshot;
  }
  async getGoal(): Promise<GoalSnapshot | null> {
    return this.goal;
  }
  async clearGoal(): Promise<void> {
    this.clears++;
    this.goal = null;
  }
  async steer(text: string): Promise<{ steered: boolean }> {
    if (!this.turnActive) return { steered: false };
    this.steered.push(text);
    return { steered: true };
  }
  async interrupt(): Promise<{ interrupted: boolean }> {
    this.interrupted++;
    return { interrupted: true };
  }
}

/** Hands out fake sessions; `thread` decides which thread a (re)opened session lands on. */
function fakeManager(make: (config: Record<string, unknown>, n: number) => FakeGoalSession) {
  const sessions = new Map<string, FakeGoalSession>();
  const starts: Array<Record<string, unknown>> = [];
  const stopped: string[] = [];
  const manager = {
    starts,
    stopped,
    sessions,
    async startSession(config: Record<string, unknown>) {
      starts.push(config);
      sessions.set(String(config.name), make(config, starts.length));
      return { name: config.name } as never;
    },
    async sendMessage() {
      throw new Error('the goal node never sends a chat turn');
    },
    async stopSession(name: string) {
      stopped.push(name);
    },
    codexGoalSession(name: string) {
      return sessions.get(name) as never;
    },
  };
  return manager;
}

function kernelWith(manager: ReturnType<typeof fakeManager>) {
  return registerDefaultExecutors(new RunKernel({ manager: manager as never, nodeTimeoutMs: 20_000 }));
}

const oneGoal = (over: Record<string, unknown> = {}): WorkflowSpec => ({
  name: 'goal-test',
  cwd: tmp,
  nodes: [{ id: 'goal', kind: 'goal', objective: 'make it faster', ...over } as never],
});

describe('goal node', () => {
  it('sets the objective, checkpoints the thread, and succeeds when the goal completes', async () => {
    const m = fakeManager(() => {
      const s = new FakeGoalSession('thread-A');
      s.onSet = (_p, self) => self.move('complete', { tokensUsed: 1234, timeUsedSeconds: 56 });
      return s;
    });
    const kernel = kernelWith(m);
    const run = await kernel.start(oneGoal({ tokenBudget: 9000, launcher: ['/opt/sandbox.sh', 'sf', '6 7'] }));
    const done = await kernel.wait(run.runId);

    expect(done!.nodes.goal.state).toBe('succeeded');
    const data = done!.nodes.goal.data as GoalNodeData;
    expect(data).toMatchObject({ threadId: 'thread-A', status: 'complete', tokensUsed: 1234, resumes: 0 });
    const session = [...m.sessions.values()][0];
    expect(session.sets).toEqual([{ objective: 'make it faster', tokenBudget: 9000 }]);
    // The session is opened the way the goal needs it, under the caller's launcher.
    expect(m.starts[0]).toMatchObject({
      engine: 'codex-app',
      launcher: ['/opt/sandbox.sh', 'sf', '6 7'],
      noSessionPersistence: true,
    });
    expect(m.starts[0].resumeSessionId).toBeUndefined();
    expect(m.stopped).toHaveLength(1);
  });

  it('fails on a spent budget and on a blocked goal, with the reason', async () => {
    for (const [status, needle] of [
      ['budgetLimited', 'token budget spent'],
      ['blocked', 'goal blocked'],
    ] as const) {
      const m = fakeManager(() => {
        const s = new FakeGoalSession('t');
        s.onSet = (_p, self) => self.move(status);
        return s;
      });
      const kernel = kernelWith(m);
      const done = await kernel.wait((await kernel.start(oneGoal())).runId);
      expect(done!.nodes.goal.state).toBe('failed');
      expect(done!.nodes.goal.error).toContain(needle);
    }
  });

  it('resumes a usage-limited goal after a backoff, within its bound', async () => {
    let limits = 2;
    const m = fakeManager(() => {
      const s = new FakeGoalSession('t');
      s.onSet = (p, self) => {
        if (limits-- > 0) self.move('usageLimited');
        else self.move('complete');
        void p;
      };
      return s;
    });
    const kernel = kernelWith(m);
    const done = await kernel.wait((await kernel.start(oneGoal({ capacityRetry: { max: 5, backoffMs: 5 } }))).runId);
    expect(done!.nodes.goal.state).toBe('succeeded');
    const session = [...m.sessions.values()][0];
    expect(session.sets.slice(1)).toEqual([{ status: 'active' }, { status: 'active' }]);
    expect((done!.nodes.goal.data as GoalNodeData).resumes).toBe(2);
  });

  it('gives up for good once the resume bound is spent', async () => {
    const m = fakeManager(() => {
      const s = new FakeGoalSession('t');
      s.onSet = (_p, self) => self.move('usageLimited');
      return s;
    });
    const kernel = kernelWith(m);
    const done = await kernel.wait((await kernel.start(oneGoal({ capacityRetry: { max: 2, backoffMs: 5 } }))).runId);
    expect(done!.nodes.goal.state).toBe('failed');
    expect(done!.nodes.goal.error).toContain('did not recover after 2 resume attempts');
    // The first set plus exactly two resumes: the third was never attempted.
    expect([...m.sessions.values()][0].sets).toHaveLength(3);
  });

  it('nudges an active goal that has stalled with no turn running', async () => {
    let first = true;
    const m = fakeManager(() => {
      const s = new FakeGoalSession('t');
      s.onSet = (_p, self) => {
        if (first)
          first = false; // goes quiet: active, no turn, no news
        else self.move('complete');
      };
      return s;
    });
    const kernel = kernelWith(m);
    const done = await kernel.wait(
      (await kernel.start(oneGoal({ stallMs: 30, capacityRetry: { max: 3, backoffMs: 5 } }))).runId,
    );
    expect(done!.nodes.goal.state).toBe('succeeded');
    expect([...m.sessions.values()][0].sets[1]).toEqual({ status: 'active' });
  });

  it('reattaches the same thread when the app-server exits mid-goal', async () => {
    const m = fakeManager((config, n) => {
      const s = new FakeGoalSession('thread-K');
      if (n === 1) {
        s.onSet = (_p, self) => setTimeout(() => self.emit('close', 1), 5);
      } else {
        // The resumed thread still has its goal and finishes it on its own.
        s.goal = {
          objective: 'make it faster',
          status: 'active',
          tokenBudget: null,
          tokensUsed: 10,
          timeUsedSeconds: 1,
        };
        setTimeout(() => s.move('complete'), 10);
      }
      void config;
      return s;
    });
    const kernel = kernelWith(m);
    const done = await kernel.wait((await kernel.start(oneGoal({ capacityRetry: { max: 3, backoffMs: 5 } }))).runId);
    expect(done!.nodes.goal.state).toBe('succeeded');
    expect(m.starts).toHaveLength(2);
    expect(m.starts[1].resumeSessionId).toBe('thread-K');
    // The objective was set once; the reopened session picked the goal up.
    expect([...m.sessions.values()][1].sets).toEqual([]);
    expect((done!.nodes.goal.data as GoalNodeData).resumes).toBe(1);
  });

  it('refuses to start the goal over when the stored thread cannot be resumed', async () => {
    const m = fakeManager((_c, n) => {
      const s = new FakeGoalSession(n === 1 ? 'thread-1' : 'some-new-thread');
      if (n === 1) s.onSet = (_p, self) => setTimeout(() => self.emit('close', 1), 5);
      return s;
    });
    const kernel = kernelWith(m);
    const done = await kernel.wait((await kernel.start(oneGoal({ capacityRetry: { max: 3, backoffMs: 5 } }))).runId);
    expect(done!.nodes.goal.state).toBe('failed');
    expect(done!.nodes.goal.error).toContain('could not resume codex thread thread-1');
    expect([...m.sessions.values()][1].sets).toEqual([]);
  });

  it('on cancel, interrupts the turn and pauses the goal rather than abandoning it', async () => {
    const m = fakeManager(() => new FakeGoalSession('t'));
    const kernel = kernelWith(m);
    const run = await kernel.start(oneGoal());
    await new Promise((r) => setTimeout(r, 50));
    kernel.cancel(run.runId);
    const done = await kernel.wait(run.runId);
    expect(done!.state).toBe('cancelled');
    const session = [...m.sessions.values()][0];
    expect(session.interrupted).toBe(1);
    expect(session.sets.at(-1)).toEqual({ status: 'paused' });
  });

  it('delivers a steer into the running turn', async () => {
    const m = fakeManager(() => {
      const s = new FakeGoalSession('t');
      s.onSet = (_p, self) => {
        self.turnActive = true;
      };
      return s;
    });
    const kernel = kernelWith(m);
    const run = await kernel.start(oneGoal());
    await new Promise((r) => setTimeout(r, 50));
    kernel.steer(run.runId, 'Log this round in WORK_LOG.md before the next one.');
    const session = [...m.sessions.values()][0];
    for (let i = 0; i < 40 && session.steered.length === 0; i++) await new Promise((r) => setTimeout(r, 50));
    expect(session.steered).toEqual(['Log this round in WORK_LOG.md before the next one.']);
    session.turnActive = false;
    session.move('complete');
    expect((await kernel.wait(run.runId))!.nodes.goal.state).toBe('succeeded');
  });
});

describe('goal node on an existing thread', () => {
  it('starts on the thread it is given, replacing its goal, and keeps the last reply', async () => {
    const m = fakeManager(() => {
      const s = new FakeGoalSession('thread-given');
      s.goal = { objective: 'old', status: 'complete', tokenBudget: null, tokensUsed: 5, timeUsedSeconds: 1 };
      s.onSet = (_p, self) => {
        self.emit('result', { type: 'result', result: 'Round 3 logged.\nNO-HEADROOM: profiles show nothing left' });
        self.move('complete');
      };
      return s;
    });
    const kernel = kernelWith(m);
    const done = await kernel.wait(
      (await kernel.start(oneGoal({ objective: 'Time check: 90 minutes remain.', threadId: 'thread-given' }))).runId,
    );
    expect(done!.nodes.goal.state).toBe('succeeded');
    expect(m.starts[0].resumeSessionId).toBe('thread-given');
    const session = [...m.sessions.values()][0];
    expect(session.clears).toBe(1);
    expect(session.sets[0].objective).toBe('Time check: 90 minutes remain.');
    expect((done!.nodes.goal.data as GoalNodeData).lastMessage).toContain('NO-HEADROOM');
  });
});

describe('goal workflow', () => {
  it('sends a red verdict back to the same thread with the failing checks, then verifies', async () => {
    const cwd = path.join(tmp, 'repo');
    fs.mkdirSync(cwd);
    const m = fakeManager(() => {
      const s = new FakeGoalSession('thread-R');
      s.onSet = (p, self) => {
        // Second objective: the repair. Only then is the work actually done.
        if (p.objective?.includes('did not pass the acceptance checks'))
          fs.writeFileSync(path.join(cwd, 'done.txt'), 'x');
        self.move('complete');
      };
      return s;
    });
    const contract = {
      checks: [
        {
          id: 'done-file',
          type: 'command' as const,
          cmd: process.execPath,
          args: ['-e', "process.exit(require('fs').existsSync('done.txt') ? 0 : 1)"],
        },
      ],
    };
    const spec = goalWorkflow({ task: 'create done.txt', cwd, contract, maxRepairs: 1 });
    const kernel = kernelWith(m);
    const done = await kernel.wait((await kernel.start(spec, { contract } as never)).runId);

    expect(done!.state).toBe('completed');
    expect(done!.outcome).toBe('verified');
    // Both passes ran on one thread: the second session resumed the first's.
    expect(m.starts).toHaveLength(2);
    expect(m.starts[1].resumeSessionId).toBe('thread-R');
    const second = [...m.sessions.values()][1];
    expect(second.clears).toBe(1);
    expect(second.sets[0].objective).toContain('done-file');
    expect(second.sets[0].objective).toMatch(/---\n\ncreate done\.txt$/);
  });

  it('sizes the verifier from the checks, so an hours-long judge is not cut at 30 minutes', () => {
    const spec = goalWorkflow({
      task: 't',
      contract: { checks: [{ type: 'command', cmd: 'judge', timeoutMs: 6 * 3600_000 } as never] },
    });
    const verify = spec.nodes.find((n) => n.id === 'verify')!;
    expect(verify.timeoutMs).toBeGreaterThanOrEqual(6 * 3600_000);
    expect(spec.nodes.find((n) => n.id === 'goal')!.timeoutMs).toBeUndefined();
  });
});

describe('goal node spend', () => {
  it('reports the thread spend once, including an attempt that never returned', async () => {
    // Session 1 has spent 0.30 on the thread when its app-server dies; session 2
    // resumes the same thread, whose total reaches 0.50, and completes.
    const costs = [0.3, 0.5];
    const m = fakeManager((_c, n) => {
      const s = new FakeGoalSession('thread-$');
      if (n === 1) s.onSet = (_p, self) => setTimeout(() => self.emit('close', 1), 5);
      else {
        s.goal = { objective: 'o', status: 'active', tokenBudget: null, tokensUsed: 1, timeUsedSeconds: 1 };
        setTimeout(() => s.move('complete'), 10);
      }
      return s;
    });
    const sessionCost = new Map<string, number>();
    const startSession = m.startSession.bind(m);
    Object.assign(m, {
      async startSession(config: Record<string, unknown>) {
        sessionCost.set(String(config.name), costs[m.starts.length] ?? 0);
        return startSession(config);
      },
      getStatus: (name: string) => ({ stats: { costUsd: sessionCost.get(name) ?? 0 } }),
    });
    const kernel = kernelWith(m);
    const done = await kernel.wait((await kernel.start(oneGoal({ capacityRetry: { max: 3, backoffMs: 5 } }))).runId);
    expect(done!.nodes.goal.state).toBe('succeeded');
    expect(done!.costUsd).toBeCloseTo(0.5, 6);
    expect((done!.nodes.goal.data as GoalNodeData).reportedCostUsd).toBeCloseTo(0.5, 6);
  });
});

describe('goal objective limit', () => {
  it('refuses an objective Codex would reject, before opening a session', async () => {
    const m = fakeManager(() => new FakeGoalSession('t'));
    const kernel = kernelWith(m);
    const done = await kernel.wait(
      (await kernel.start(oneGoal({ objective: 'x'.repeat(GOAL_OBJECTIVE_MAX_CHARS + 1) }))).runId,
    );
    expect(done!.nodes.goal.state).toBe('failed');
    expect(done!.nodes.goal.error).toContain('put the full brief in a file');
    expect(m.starts).toHaveLength(0);
  });

  it('keeps the objective whole and cuts the preface to fit', () => {
    const objective = 'o'.repeat(GOAL_OBJECTIVE_MAX_CHARS - 100);
    const out = composeObjective(['p'.repeat(500)], objective);
    expect([...out].length).toBeLessThanOrEqual(GOAL_OBJECTIVE_MAX_CHARS);
    expect(out.endsWith(`---\n\n${objective}`)).toBe(true);
    expect(out).toContain('[cut to fit');
    expect(composeObjective(['short'], 'task')).toBe('short\n\n---\n\ntask');
    expect(composeObjective(['p'], 'o'.repeat(GOAL_OBJECTIVE_MAX_CHARS))).toBe('o'.repeat(GOAL_OBJECTIVE_MAX_CHARS));
  });

  it('starts a fresh thread on a revisit when the first goal was never set', async () => {
    // Codex writes a thread to disk with its first turn: a thread whose goal was
    // refused has nothing to resume, and resuming it would fail.
    const cwd = path.join(tmp, 'repo');
    fs.mkdirSync(cwd);
    const m = fakeManager((_c, n) => {
      const s = new FakeGoalSession(`thread-${n}`);
      if (n === 1) {
        s.setGoal = async () => {
          throw new Error('thread/goal/set failed: refused');
        };
      } else {
        s.onSet = (_p, self) => {
          fs.writeFileSync(path.join(cwd, 'done.txt'), 'x');
          self.move('complete', { tokensUsed: 10 });
        };
      }
      return s;
    });
    const contract = {
      checks: [
        {
          id: 'done-file',
          type: 'command' as const,
          cmd: process.execPath,
          args: ['-e', "process.exit(require('fs').existsSync('done.txt') ? 0 : 1)"],
        },
      ],
    };
    const spec = goalWorkflow({ task: 'create done.txt', cwd, contract, maxRepairs: 1 });
    const kernel = kernelWith(m);
    const done = await kernel.wait((await kernel.start(spec, { contract } as never)).runId);
    expect(done!.outcome).toBe('verified');
    expect(m.starts).toHaveLength(2);
    expect(m.starts[1].resumeSessionId).toBeUndefined();
    expect((done!.nodes.goal.data as GoalNodeData).threadId).toBe('thread-2');
  });
});
