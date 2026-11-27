/**
 * Deleting a live autoloop run takes its forum with it: nothing a member still does brings the run
 * directory back, and a later run under the same id starts on an empty forum, its Planner briefed.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  CostBreakdown,
  EffortLevel,
  ISession,
  SessionConfig,
  SessionSendOptions,
  SessionStats,
  TurnResult,
} from '../types.js';
import type { SessionManager as SessionManagerType } from '../session-manager.js';

const ROOT = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'clawo-forum-run-delete-'));
process.env.CLAWO_WF_DIR = path.join(ROOT, 'wf');
process.env.CLAWO_FORUM_SPOOL_ROOT = path.join(ROOT, 'spool');

const forum = await import('../kernel/forum.js');
const { SessionManager } = await import('../session-manager.js');
const { loadRun, runDir } = await import('../kernel/store.js');

afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

class MockSession extends EventEmitter implements ISession {
  sessionId?: string;
  private effort: EffortLevel = 'auto';
  sendCalls: string[] = [];
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
    this.sessionId = `mock-${Math.random().toString(36).slice(2, 8)}`;
    return this;
  }
  stop(): void {}
  pause(): void {}
  resume(): void {}
  async send(
    message: string | unknown[],
    options?: SessionSendOptions,
  ): Promise<TurnResult | { requestId: number; sent: boolean }> {
    this.sendCalls.push(typeof message === 'string' ? message : JSON.stringify(message));
    if (options?.waitForComplete === false) return { requestId: 1, sent: true };
    return { text: 'ack', event: { type: 'result', result: 'ok' } };
  }
  getStats(): SessionStats & { sessionId?: string; uptime: number } {
    return {
      turns: this.sendCalls.length,
      turnsSucceeded: this.sendCalls.length,
      toolCalls: 0,
      toolErrors: 0,
      tokensIn: 1,
      tokensOut: 1,
      cachedTokens: 0,
      costUsd: 0,
      isReady: true,
      startTime: new Date().toISOString(),
      lastActivity: new Date().toISOString(),
      contextPercent: 5,
      retries: 0,
      sessionId: this.sessionId,
      uptime: 1,
    };
  }
  getHistory(): Array<{ time: string; type: string; event: unknown }> {
    return [];
  }
  getCost(): CostBreakdown {
    return {
      model: 'mock',
      tokensIn: 1,
      tokensOut: 1,
      cachedTokens: 0,
      pricing: { inputPer1M: 0, outputPer1M: 0, cachedPer1M: 0 },
      breakdown: { inputCost: 0, cachedCost: 0, outputCost: 0 },
      totalUsd: 0,
    };
  }
  async compact(): Promise<TurnResult> {
    return { text: 'compacted', event: { type: 'result' } };
  }
  getEffort(): EffortLevel {
    return this.effort;
  }
  setEffort(level: EffortLevel): void {
    this.effort = level;
  }
  resolveModel(alias: string): string {
    return alias;
  }
}

describe('deleting a live autoloop run', () => {
  let mgr: InstanceType<typeof SessionManager>;
  let sessions: Map<string, MockSession>;

  beforeEach(() => {
    sessions = new Map();
    mgr = new SessionManager({
      claudeBin: 'mock-claude',
      maxConcurrentSessions: 5,
      sessionTtlMinutes: 120,
      defaultPermissionMode: 'acceptEdits',
      defaultEffort: 'auto',
    }) as SessionManagerType;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mgr as any)._createSession = (_engine: string, config: SessionConfig): ISession => {
      const mock = new MockSession();
      sessions.set(config.name, mock);
      return mock;
    };
  });

  afterEach(async () => {
    await mgr.shutdown();
  });

  const workspaceFor = (runId: string): string => fs.mkdtempSync(path.join(ROOT, `${runId}-`));

  it('leaves no forum for a run that takes the id next', async () => {
    const id = 'rdel-1';
    await mgr.autoloopStart({ runId: id, workspace: workspaceFor(id) });
    await mgr.autoloopChat(id, 'old secret plan');
    const firstPlanner = sessions.get(`autoloop-${id}-planner`)!;
    expect(firstPlanner.sendCalls[0]).toContain('You are "planner"');
    expect(forum.forumSnapshot(id).posts.map((p) => p.title)).toContain('INFO @planner: old secret plan');

    expect(await mgr.autoloopDelete(id)).toBe(true);
    // Let the cancelled node and every leave finish.
    await new Promise((r) => setTimeout(r, 2_500));
    expect(fs.existsSync(runDir(id))).toBe(false);
    expect(fs.existsSync(forum.forumSpoolDir(id))).toBe(false);
    expect(loadRun(id)).toBeUndefined();

    await mgr.autoloopStart({ runId: id, workspace: workspaceFor(id) });
    const snap = forum.forumSnapshot(id);
    await mgr.autoloopChat(id, 'new plan');
    const secondPlanner = sessions.get(`autoloop-${id}-planner`)!;
    expect(secondPlanner).not.toBe(firstPlanner);
    expect(snap.posts.map((p) => p.title)).not.toContain('INFO @planner: old secret plan');
    expect(secondPlanner.sendCalls[0]).toContain('You are "planner"');
  }, 30_000);

  it('does not bring the run directory back for a post an agent made just before the delete', async () => {
    const id = 'rdel-2';
    await mgr.autoloopStart({ runId: id, workspace: workspaceFor(id) });
    await mgr.autoloopChat(id, 'plan');
    // The Coder posts with the CLI a moment before the user deletes the run.
    forum.forumPost(forum.forumSpoolDir(id), 'coder', { title: 'ASK @planner: which file?' });
    expect(await mgr.autoloopDelete(id)).toBe(true);
    await new Promise((r) => setTimeout(r, 2_500));
    expect(fs.existsSync(runDir(id))).toBe(false);
    let restartError: string | undefined;
    try {
      await mgr.autoloopStart({ runId: id, workspace: workspaceFor(id) });
    } catch (err) {
      restartError = (err as Error).message;
    }
    expect(restartError).toBeUndefined();
  }, 30_000);
});
