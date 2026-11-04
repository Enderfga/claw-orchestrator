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
import { acquireLease, commit, loadRun, releaseLease } from '../../kernel/store.js';
import type { RunRecord, WorkflowSpec } from '../../kernel/types.js';

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

type SetParams = { objective?: string; status?: 'active' | 'paused'; tokenBudget?: number | null; context?: string };

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

  it('resumes a goal codex blocked over a model at capacity, within its bound', async () => {
    // codex 0.166.0: the turn ends with turn.error serverOverloaded and the goal
    // goes `blocked`. That is a transient condition, not a finished goal.
    let overloads = 2;
    const m = fakeManager(() => {
      const s = new FakeGoalSession('t');
      s.onSet = (_p, self) => {
        if (overloads-- > 0) {
          const err = {
            message: 'Selected model is at capacity. Please try a different model.',
            code: 'serverOverloaded',
            willRetry: false,
            at: new Date().toISOString(),
          };
          self.lastError = err;
          self.emit('codex:error', err);
          self.move('blocked');
        } else self.move('complete');
      };
      return s;
    });
    const kernel = kernelWith(m);
    const done = await kernel.wait((await kernel.start(oneGoal({ capacityRetry: { max: 5, backoffMs: 5 } }))).runId);
    expect(done!.nodes.goal.state).toBe('succeeded');
    const session = [...m.sessions.values()][0];
    // Same thread, same objective: only the status is set back to active.
    expect(m.starts).toHaveLength(1);
    expect(session.sets.slice(1)).toEqual([{ status: 'active' }, { status: 'active' }]);
    const data = done!.nodes.goal.data as GoalNodeData;
    expect(data.resumes).toBe(2);
    expect(data.lastError?.code).toBe('serverOverloaded');
  });

  it('gives up on a goal blocked over capacity once the bound is spent, naming the cause', async () => {
    const m = fakeManager(() => {
      const s = new FakeGoalSession('t');
      s.onSet = (_p, self) => {
        self.emit('codex:error', { message: 'at capacity', code: 'serverOverloaded', willRetry: false, at: '' });
        self.move('blocked');
      };
      return s;
    });
    const kernel = kernelWith(m);
    const done = await kernel.wait((await kernel.start(oneGoal({ capacityRetry: { max: 2, backoffMs: 5 } }))).runId);
    expect(done!.nodes.goal.state).toBe('failed');
    expect(done!.nodes.goal.error).toMatch(/did not recover after 2 resume attempts.*serverOverloaded/);
  });

  it('still fails at once on a goal blocked for any other reason', async () => {
    const m = fakeManager(() => {
      const s = new FakeGoalSession('t');
      s.onSet = (_p, self) => {
        self.emit('codex:error', { message: 'bad request', code: 'badRequest', willRetry: false, at: '' });
        self.move('blocked');
      };
      return s;
    });
    const kernel = kernelWith(m);
    const done = await kernel.wait((await kernel.start(oneGoal({ capacityRetry: { max: 5, backoffMs: 5 } }))).runId);
    expect(done!.nodes.goal.state).toBe('failed');
    expect(done!.nodes.goal.error).toBe('goal blocked: bad request');
    expect((done!.nodes.goal.data as GoalNodeData).resumes).toBe(0);
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

describe('goal node after a crash', () => {
  /** Rewrite a finished run's checkpoint to what a process that died at `goal` left behind. */
  async function crashedInGoal(runId: string, edit: (r: RunRecord) => void = () => undefined) {
    const record = loadRun(runId)!;
    record.state = 'running';
    record.endedAt = undefined;
    record.nodes.goal.state = 'running';
    record.currentNode = 'goal';
    edit(record);
    const crashed = acquireLease(runId, 'crashed-process');
    commit(crashed, { record });
    releaseLease(crashed);
  }

  /** The resumed process: any goal it is asked to set completes, so a restart shows up as a session. */
  const finishesAnyGoal = (thread: string) =>
    fakeManager(() => {
      const s = new FakeGoalSession(thread);
      s.onSet = (_p, self) => self.move('complete');
      return s;
    });

  it('finishes a goal that completed before its result was committed, instead of running it again', async () => {
    const m = fakeManager(() => {
      const s = new FakeGoalSession('thread-C');
      s.onSet = (_p, self) => self.move('complete', { tokensUsed: 50 });
      return s;
    });
    const kernel = kernelWith(m);
    const first = await kernel.start(oneGoal());
    expect((await kernel.wait(first.runId))!.nodes.goal.state).toBe('succeeded');
    // The goal reached `complete` and the checkpoint said so; the process died
    // before the node's result landed.
    await crashedInGoal(first.runId);

    const m2 = finishesAnyGoal('thread-C');
    const kernel2 = kernelWith(m2);
    await kernel2.resume(first.runId);
    const done = await kernel2.wait(first.runId);
    expect(m2.starts).toHaveLength(0);
    expect(done!.nodes.goal.state).toBe('succeeded');
    expect(done!.state).toBe('completed');
  });

  it('picks a goal blocked over capacity back up after a crash in the backoff', async () => {
    const m = fakeManager(() => {
      const s = new FakeGoalSession('thread-K');
      s.onSet = (_p, self) => self.move('complete', { tokensUsed: 50 });
      return s;
    });
    const kernel = kernelWith(m);
    const first = await kernel.start(oneGoal());
    await kernel.wait(first.runId);
    // The process died while waiting to resume a goal codex had blocked over capacity.
    await crashedInGoal(first.runId, (r) => {
      const data = r.nodes.goal.data as GoalNodeData;
      data.status = 'blocked';
      data.lastError = { message: 'Selected model is at capacity.', code: 'serverOverloaded', at: '' };
    });

    const m2 = fakeManager(() => {
      const s = new FakeGoalSession('thread-K');
      s.goal = {
        objective: 'make it faster',
        status: 'blocked',
        tokenBudget: null,
        tokensUsed: 50,
        timeUsedSeconds: 1,
      };
      s.onSet = (p, self) => {
        if (p.status === 'active') self.move('complete');
      };
      return s;
    });
    const kernel2 = kernelWith(m2);
    await kernel2.resume(first.runId);
    const done = await kernel2.wait(first.runId);
    expect(m2.starts[0].resumeSessionId).toBe('thread-K');
    expect([...m2.sessions.values()][0].sets).toEqual([{ status: 'active' }]);
    expect(done!.nodes.goal.state).toBe('succeeded');
  });

  it('finishes a repair pass that completed, rather than repairing the same red verdict again', async () => {
    const cwd = path.join(tmp, 'repo');
    fs.mkdirSync(cwd);
    const m = fakeManager(() => {
      const s = new FakeGoalSession('thread-P');
      s.onSet = (p, self) => {
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
    const kernel = kernelWith(m);
    const first = await kernel.start(goalWorkflow({ task: 'create done.txt', cwd, contract, maxRepairs: 1 }));
    const finished = (await kernel.wait(first.runId))!;
    expect(finished.outcome).toBe('verified');
    // Put the run back to the moment the repair goal had completed: the first,
    // red verdict still in force, the second verification not yet run.
    const red = 'verify-v01-01';
    await crashedInGoal(first.runId, (r) => {
      r.outcome = 'refuted';
      r.evidenceId = red;
      r.verdict = { node: 'verify', evidenceId: red, sideEffectSeq: 1 };
      r.nodes.verify.state = 'failed';
      r.nodes.verify.evidenceId = red;
    });

    const m2 = finishesAnyGoal('thread-P');
    const kernel2 = kernelWith(m2);
    await kernel2.resume(first.runId);
    const done = await kernel2.wait(first.runId);
    expect(m2.starts).toHaveLength(0);
    expect(done!.outcome).toBe('verified');
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
    // The fresh thread still hears why the run came back.
    const fresh = [...m.sessions.values()][1].sets[0].objective ?? '';
    expect(fresh).toContain('did not pass the acceptance checks');
    expect(fresh).toContain('done-file');
  });

  it('briefs another goal node that takes over after a red verdict', async () => {
    const cwd = path.join(tmp, 'repo');
    fs.mkdirSync(cwd);
    const m = fakeManager((_c, n) => {
      const s = new FakeGoalSession(`thread-${n}`);
      s.onSet = (_p, self) => {
        if (n === 2) fs.writeFileSync(path.join(cwd, 'done.txt'), 'x');
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
    const spec: WorkflowSpec = {
      name: 'fresh-node',
      cwd,
      contract,
      nodes: [
        { id: 'implement', kind: 'goal', objective: 'create done.txt', onFailure: 'continue' } as never,
        { id: 'verify', kind: 'verifier', contract: 'run', cwd, onFailure: 'continue' } as never,
        {
          id: 'gate',
          kind: 'router',
          routes: [{ when: { type: 'node_failed', node: 'verify' }, to: 'implement-fresh' }],
          default: 'end',
        } as never,
        { id: 'implement-fresh', kind: 'goal', objective: 'create done.txt', onFailure: 'continue' } as never,
        { id: 'verify-2', kind: 'verifier', contract: 'run', cwd, onFailure: 'continue' } as never,
        { id: 'end', kind: 'router', routes: [] } as never,
      ],
    };
    const kernel = kernelWith(m);
    const done = await kernel.wait((await kernel.start(spec, { contract } as never)).runId);
    expect(done!.outcome).toBe('verified');
    const first = [...m.sessions.values()][0].sets[0].objective;
    const takeover = [...m.sessions.values()][1].sets[0].objective ?? '';
    // The first visit of the run has nothing to report; the takeover, on its own
    // first visit, gets the failing checks.
    expect(first).toBe('create done.txt');
    expect(takeover).toContain('done-file');
    expect(takeover).toMatch(/---\n\ncreate done\.txt$/);
  });
});

/**
 * The same node on Claude Code. The manager hands out the goal surface through
 * `goalSession(name, open)`; the fake stands in for `ClaudeGoalSession`, whose
 * thread is the session id the node chose (`open.threadId`).
 */
function claudeManager(script: (s: FakeGoalSession, n: number) => void) {
  const base = fakeManager(() => new FakeGoalSession(''));
  const opens: Array<Record<string, unknown>> = [];
  const sessions = new Map<string, FakeGoalSession>();
  const manager = {
    ...base,
    opens,
    sessions,
    async startSession(config: Record<string, unknown>) {
      base.starts.push(config);
      return { name: config.name } as never;
    },
    goalSession(name: string, open: Record<string, unknown> = {}) {
      let s = sessions.get(name);
      if (!s) {
        opens.push(open);
        s = new FakeGoalSession(String(open.threadId ?? ''));
        sessions.set(name, s);
        script(s, opens.length);
      }
      return s as never;
    },
  };
  return manager;
}

describe('goal node on claude', () => {
  it('on a repair sends the failing checks before the goal, whose condition is the objective alone', async () => {
    // Claude's /goal is judged by a model that reads only the conversation. A
    // repair objective that called the runtime's checks the definition of done
    // could never be met in it: the hook blocked the stop until the CLI gave up.
    const cwd = path.join(tmp, 'repo');
    fs.mkdirSync(cwd);
    const m = claudeManager((s) => {
      s.onSet = (p, self) => {
        if ((p as { context?: string }).context?.includes('done-file'))
          fs.writeFileSync(path.join(cwd, 'done.txt'), 'x');
        self.move('complete');
      };
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
    const spec = goalWorkflow({ task: 'create done.txt', cwd, contract, maxRepairs: 1, engine: 'claude' });
    const kernel = kernelWith(m as never);
    const done = await kernel.wait((await kernel.start(spec, { contract } as never)).runId);

    expect(done!.outcome).toBe('verified');
    const repair = [...m.sessions.values()][1].sets[0] as { objective?: string; context?: string };
    // The condition the judge holds the agent to is the caller's objective and nothing else.
    expect(repair.objective).toBe('create done.txt');
    expect(repair.context).toContain('done-file');
    expect(repair.context).toContain('not part of the goal');
    expect(repair.context).not.toContain('definition of done');
  });

  it('passes disallowedTools to the claude session, and refuses them on codex before starting', async () => {
    const m = claudeManager((s) => {
      s.onSet = (_p, self) => self.move('complete');
    });
    const kernel = kernelWith(m as never);
    const done = await kernel.wait(
      (await kernel.start(oneGoal({ engine: 'claude', disallowedTools: ['ScheduleWakeup', 'Monitor'] }))).runId,
    );
    expect(done!.nodes.goal.state).toBe('succeeded');
    expect(m.starts[0].disallowedTools).toEqual(['ScheduleWakeup', 'Monitor']);

    const codex = kernelWith(fakeManager(() => new FakeGoalSession('t')));
    await expect(codex.start(oneGoal({ disallowedTools: ['shell'] }))).rejects.toThrow(
      /disallowedTools is not supported on engine 'codex'/,
    );
  });

  it('opens a claude session with its own id and a transcript it can resume, then completes', async () => {
    const m = claudeManager((s) => {
      s.onSet = (_p, self) => self.move('complete', { tokensUsed: 42 });
    });
    const kernel = kernelWith(m as never);
    const run = await kernel.start(
      oneGoal({ engine: 'claude', sandboxMode: 'danger-full-access', launcher: ['/opt/sandbox.sh', 'llava', '0 1'] }),
    );
    const done = await kernel.wait(run.runId);

    expect(done!.nodes.goal.state).toBe('succeeded');
    const start = m.starts[0];
    expect(start).toMatchObject({
      engine: 'claude',
      skipPersistence: true,
      launcher: ['/opt/sandbox.sh', 'llava', '0 1'],
      permissionMode: 'bypassPermissions',
    });
    // `noSessionPersistence` would stop claude writing the transcript `--resume` needs.
    expect(start.noSessionPersistence).toBeUndefined();
    expect(start.sandboxMode).toBeUndefined();
    expect(start.customSessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(m.opens[0]).toMatchObject({ threadId: start.customSessionId, resumed: false });
    expect((done!.nodes.goal.data as GoalNodeData).threadId).toBe(start.customSessionId);
  });

  it('resumes the same claude session after the process exits, handing over what it spent', async () => {
    const m = claudeManager((s, n) => {
      if (n === 1) {
        s.onSet = (_p, self) => {
          self.move('active', { tokensUsed: 700, timeUsedSeconds: 30 });
          setTimeout(() => self.emit('close', 1), 10);
        };
      } else {
        s.goal = {
          objective: 'make it faster',
          status: 'active',
          tokenBudget: null,
          tokensUsed: 700,
          timeUsedSeconds: 30,
        };
        setTimeout(() => s.move('complete', { tokensUsed: 900 }), 10);
      }
    });
    const kernel = kernelWith(m as never);
    const done = await kernel.wait(
      (await kernel.start(oneGoal({ engine: 'claude', capacityRetry: { max: 3, backoffMs: 5 } }))).runId,
    );

    expect(done!.nodes.goal.state).toBe('succeeded');
    expect(m.starts).toHaveLength(2);
    const first = m.starts[0].customSessionId;
    expect(m.starts[1].resumeSessionId).toBe(first);
    expect(m.starts[1].customSessionId).toBeUndefined();
    expect(m.opens[1]).toMatchObject({
      threadId: first,
      resumed: true,
      objective: 'make it faster',
      tokensUsed: 700,
      timeUsedSeconds: 30,
    });
  });

  it('fails clearly when the manager has no goal surface for claude', async () => {
    const m = fakeManager(() => new FakeGoalSession('t'));
    const kernel = kernelWith(m);
    const done = await kernel.wait((await kernel.start(oneGoal({ engine: 'claude' }))).runId);
    expect(done!.nodes.goal.state).toBe('failed');
    expect(done!.nodes.goal.error).toContain('the claude session has no goal surface');
  });

  it('carries the engine through the goal template, and leaves codex the default', () => {
    const claude = goalWorkflow({ task: 'x', cwd: tmp, engine: 'claude' });
    expect(claude.nodes[0]).toMatchObject({ kind: 'goal', engine: 'claude' });
    const codex = goalWorkflow({ task: 'x', cwd: tmp });
    expect('engine' in codex.nodes[0]).toBe(false);
  });
});

describe('fan-out agents that run goals', () => {
  /** Goal sessions complete when set; plain sends answer for the turn agents. */
  function mixedManager() {
    const m = fakeManager((c) => {
      const s = new FakeGoalSession(`thread-${String(c.name).split('-').pop()}`);
      s.onSet = (_p, self) => self.move('complete', { tokensUsed: 7 });
      return s;
    });
    return Object.assign(m, {
      async sendMessage() {
        return { output: 'turn answer' } as never;
      },
    });
  }

  const spec = (cwd: string): WorkflowSpec => ({
    name: 'parallel-impl',
    cwd,
    nodes: [
      {
        id: 'impl',
        kind: 'fanout',
        prompt: 'review it',
        agents: [
          { name: 'alpha', engine: 'codex', objective: 'build it in alpha', cwd: 'copy-a' },
          { name: 'beta', engine: 'codex', objective: 'build it in beta', cwd: 'copy-b' },
          { name: 'gamma', engine: 'claude' },
        ],
      } as never,
    ],
  });

  it('runs each goal agent as its own goal run in its own directory, beside the turn agents', async () => {
    const m = mixedManager();
    const kernel = kernelWith(m);
    const done = await kernel.wait((await kernel.start(spec(tmp))).runId);
    expect(done!.nodes.impl.state).toBe('succeeded');
    const data = done!.nodes.impl.data as {
      results: Array<{ agent: string; ok: boolean; cwd: string; goal?: { runId: string; status?: string } }>;
      goalRuns: Record<string, string>;
    };
    const by = Object.fromEntries(data.results.map((r) => [r.agent, r]));
    expect(Object.keys(by)).toEqual(['alpha', 'beta', 'gamma']);
    expect(by.alpha).toMatchObject({ ok: true, cwd: path.join(tmp, 'copy-a'), goal: { status: 'complete' } });
    expect(by.beta).toMatchObject({ ok: true, cwd: path.join(tmp, 'copy-b'), goal: { status: 'complete' } });
    expect(by.gamma).toMatchObject({ ok: true, cwd: tmp });
    expect(by.gamma.goal).toBeUndefined();
    // Each goal set on a session started in its agent's directory, under its own child run.
    const goalStarts = m.starts.filter((c) => c.engine === 'codex-app');
    expect(goalStarts.map((c) => c.cwd).sort()).toEqual([path.join(tmp, 'copy-a'), path.join(tmp, 'copy-b')]);
    expect(data.goalRuns.alpha).toBe(by.alpha.goal!.runId);
    expect(data.goalRuns.alpha).not.toBe(data.goalRuns.beta);
    const objectives = [...m.sessions.values()].map((s) => s.sets[0]?.objective).filter(Boolean);
    expect(objectives.sort()).toEqual(['build it in alpha', 'build it in beta']);
  });

  it('refuses at start a goal agent without claude or codex, and synthesis beside goal agents', async () => {
    const kernel = kernelWith(mixedManager());
    const one = (agent: Record<string, unknown>, extra: Record<string, unknown> = {}): WorkflowSpec => ({
      name: 'bad',
      cwd: tmp,
      nodes: [{ id: 'impl', kind: 'fanout', prompt: 'x', agents: [agent], ...extra } as never],
    });
    await expect(kernel.start(one({ name: 'a', objective: 'do it' }))).rejects.toThrow(
      /needs engine 'claude' or 'codex'/,
    );
    await expect(kernel.start(one({ name: 'a', engine: 'opencode', objective: 'do it' }))).rejects.toThrow(
      /needs engine/,
    );
    await expect(
      kernel.start(one({ name: 'a', engine: 'codex', objective: 'do it' }, { synthesize: true })),
    ).rejects.toThrow(/synthesize is not supported/);
  });

  it('reattaches to its goal runs after the parent process dies, instead of starting them again', async () => {
    const m = mixedManager();
    const kernel = kernelWith(m);
    const first = await kernel.start(spec(tmp));
    await kernel.wait(first.runId);
    // Put the parent back to the moment its fan-out node was still running.
    const record = loadRun(first.runId)!;
    record.state = 'running';
    record.endedAt = undefined;
    record.nodes.impl.state = 'running';
    record.currentNode = 'impl';
    const crashed = acquireLease(first.runId, 'crashed-process');
    commit(crashed, { record });
    releaseLease(crashed);

    const m2 = mixedManager();
    const kernel2 = kernelWith(m2);
    await kernel2.resume(first.runId);
    const done = await kernel2.wait(first.runId);
    expect(done!.nodes.impl.state).toBe('succeeded');
    // The goals had already finished: they are adopted, not set again.
    expect(m2.starts.filter((c) => c.engine === 'codex-app')).toHaveLength(0);
    const data = done!.nodes.impl.data as { goalRuns: Record<string, string> };
    expect(data.goalRuns).toEqual((record.nodes.impl.data as { goalRuns: Record<string, string> }).goalRuns);
  });
});
