/**
 * The engine-agnostic surface over the optional ISession capabilities: engine
 * commands, quota, compaction, side questions, rewinds, live model and effort
 * switches, a model per send, the turn command, native goal loops, and turns
 * the engine starts itself.
 *
 * Two fakes: one session that implements every capability, and a plain one
 * that implements none, which must be refused with "not supported on <engine>"
 * rather than quietly doing nothing.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  AsideOutcome,
  CommandOutcome,
  CompactOutcome,
  ContextBreakdown,
  CostBreakdown,
  EffortLevel,
  EngineCommand,
  ISession,
  RewindOutcome,
  RewindTarget,
  SessionConfig,
  SessionSendOptions,
  SessionStats,
  StreamCallbacks,
  TurnResult,
} from '../types.js';
import { SESSION_EVENT } from '../constants.js';
import { readRunLedger } from '../run-ledger.js';
import { registerQuotaReader, unregisterQuotaReader, readEngineQuota, quotaEngines } from '../engine-quota.js';
import type { GoalSession } from '../kernel/nodes/goal.js';

// SessionManager resolves its registry and PID file from os.homedir() at load.
const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'clawo-cap-home-'));
process.env.HOME = FAKE_HOME;
process.env.USERPROFILE = FAKE_HOME;
const { SessionManager } = await import('../session-manager.js');
type SessionManager = InstanceType<typeof SessionManager>;

/** A session with no optional capability: the shape every engine had before. */
class PlainSession extends EventEmitter implements ISession {
  sessionId?: string = 'plain-1';
  busy = false;
  turns = 0;
  costUsd = 0;
  sends: Array<{ message: string; options?: SessionSendOptions }> = [];
  /** The next send's result, when a test scripts it. */
  nextResult?: Partial<TurnResult>;
  compactReply: TurnResult = { text: 'compacted', event: { type: 'result' } };
  effort: EffortLevel = 'auto';

  get isReady() {
    return true;
  }
  get isPaused() {
    return false;
  }
  get isBusy() {
    return this.busy;
  }
  async start(): Promise<this> {
    return this;
  }
  stop(): void {}
  pause(): void {}
  resume(): void {}
  async send(message: string | unknown[], options?: SessionSendOptions): Promise<TurnResult> {
    this.sends.push({ message: String(message), options });
    const next = this.nextResult;
    this.nextResult = undefined;
    if (!next?.localCommand) {
      this.turns++;
      this.costUsd += 0.25;
    }
    return { text: `reply: ${String(message)}`, event: { type: 'result', result: 'done' }, ...next };
  }
  getStats(): SessionStats & { sessionId?: string; uptime: number } {
    return {
      turns: this.turns,
      turnsSucceeded: this.turns,
      toolCalls: 0,
      toolErrors: 0,
      tokensIn: this.turns * 100,
      tokensOut: this.turns * 10,
      cachedTokens: 0,
      costUsd: this.costUsd,
      isReady: true,
      startTime: null,
      lastActivity: null,
      contextPercent: 90,
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
      model: 'mock-model',
      tokensIn: 0,
      tokensOut: 0,
      cachedTokens: 0,
      pricing: { inputPer1M: 0, outputPer1M: 0, cachedPer1M: 0 },
      breakdown: { inputCost: 0, cachedCost: 0, outputCost: 0 },
      totalUsd: this.costUsd,
    };
  }
  async compact(): Promise<TurnResult> {
    return this.compactReply;
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

/** A session that implements every capability, recording what it was asked. */
class CapableSession extends PlainSession {
  readonly commandStyle = 'rpc' as const;
  readonly perSendModel = true;
  commands: EngineCommand[] = [
    { name: 'review', source: 'builtin', startsTurn: true },
    { name: 'usage', source: 'builtin', startsTurn: false },
    { name: 'interview', source: 'builtin', startsTurn: true, needsHuman: true },
  ];
  ran: Array<{ name: string; args?: string }> = [];
  compacted: Array<string | undefined> = [];
  asked: string[] = [];
  rewound: RewindTarget[] = [];
  liveModel?: string;
  liveModelResult = true;
  liveEffort?: EffortLevel;
  nativeGoal?: GoalSession;
  turnCommands: Array<{ command: string; message: string }> = [];

  async listCommands(): Promise<EngineCommand[]> {
    return this.commands;
  }
  async runCommand(
    name: string,
    args?: string,
    _opts?: { timeout?: number; callbacks?: StreamCallbacks },
  ): Promise<CommandOutcome> {
    this.ran.push({ name, args });
    const startedTurn = name !== 'usage';
    if (startedTurn) {
      this.turns++;
      this.costUsd += 1;
    }
    return { name, ok: true, text: `${name} done`, startedTurn };
  }
  applyTurnCommand(command: string, message: string): string {
    this.turnCommands.push({ command, message });
    return `[${command}] ${message}`;
  }
  async compactDetailed(summary?: string): Promise<CompactOutcome> {
    this.compacted.push(summary);
    return { ok: true, preTokens: 9000, postTokens: 1200, trigger: 'manual' };
  }
  async askAside(question: string): Promise<AsideOutcome> {
    this.asked.push(question);
    return { text: `aside: ${question}` };
  }
  async rewind(target: RewindTarget): Promise<RewindOutcome> {
    this.rewound.push(target);
    return { ok: true, turnsRemoved: target.turns, filesRestored: !!target.files };
  }
  async setModelLive(model: string): Promise<boolean> {
    this.liveModel = model;
    return this.liveModelResult;
  }
  async setEffortLive(level: EffortLevel): Promise<boolean> {
    this.liveEffort = level;
    return true;
  }
  async contextBreakdown(): Promise<ContextBreakdown | undefined> {
    return { totalTokens: 5000, windowTokens: 200000, categories: [{ name: 'messages', tokens: 4000 }] };
  }
  nativeGoalSession(): GoalSession | undefined {
    return this.nativeGoal;
  }
}

/** A text-command engine with no runCommand: commands go as `/name args` messages. */
class TextCommandSession extends PlainSession {
  readonly commandStyle = 'text' as const;
}

/** A codex-app look-alike: the `interrupt` + `rollback` pair is how the manager tells. */
class CodexAppLike extends PlainSession {
  rollbacks: number[] = [];
  async interrupt(): Promise<{ interrupted: boolean }> {
    return { interrupted: false };
  }
  async rollback(numTurns: number): Promise<void> {
    this.rollbacks.push(numTurns);
  }
}

let tmpDir: string;
let made: PlainSession[] = [];
let make: () => PlainSession = () => new PlainSession();
const saved = process.env.CLAWO_RUNS_DIR;
let mgr: SessionManager;

function newManager(): SessionManager {
  const m = new SessionManager({
    claudeBin: 'mock-claude',
    maxConcurrentSessions: 8,
    sessionTtlMinutes: 120,
    defaultPermissionMode: 'acceptEdits',
    defaultEffort: 'auto',
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (m as any)._createSession = (_engine: string, _config: SessionConfig): ISession => {
    const s = make();
    made.push(s);
    return s;
  };
  return m;
}

async function start<T extends PlainSession>(
  factory: () => T,
  name: string,
  extra: Partial<SessionConfig> = {},
): Promise<T> {
  make = factory;
  await mgr.startSession({ name, cwd: tmpDir, engine: 'agy', ...extra });
  return made[made.length - 1] as T;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawo-cap-'));
  process.env.CLAWO_RUNS_DIR = path.join(tmpDir, 'runs');
  made = [];
  mgr = newManager();
});

afterEach(async () => {
  await mgr.shutdown();
  if (saved === undefined) delete process.env.CLAWO_RUNS_DIR;
  else process.env.CLAWO_RUNS_DIR = saved;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

afterAll(() => {
  fs.rmSync(FAKE_HOME, { recursive: true, force: true });
});

describe('engine commands', () => {
  it('lists and runs through the session, with a ledger row only for a command that started a turn', async () => {
    const s = await start(() => new CapableSession(), 'cmd');
    expect((await mgr.listSessionCommands('cmd')).map((c) => c.name)).toEqual(['review', 'usage', 'interview']);
    const review = await mgr.runSessionCommand('cmd', '/review', '  HEAD~1 ');
    expect(review).toMatchObject({ name: 'review', ok: true, startedTurn: true });
    expect(s.ran[0]).toEqual({ name: 'review', args: 'HEAD~1' });
    await mgr.runSessionCommand('cmd', 'usage');
    const rows = readRunLedger({ session: 'cmd' });
    expect(rows).toHaveLength(1);
    expect(rows[0].costUsd).toBe(1);
  });

  it('refuses a command the engine lists as needing a person, and a name that is not one word', async () => {
    const s = await start(() => new CapableSession(), 'cmd');
    await expect(mgr.runSessionCommand('cmd', 'interview')).rejects.toThrow(/needs a person on agy/);
    await expect(mgr.runSessionCommand('cmd', 'two words')).rejects.toThrow(/one name/);
    expect(s.ran).toEqual([]);
  });

  it('runs a command on a text-command engine as a `/name args` message', async () => {
    const s = await start(() => new TextCommandSession(), 'txt');
    const out = await mgr.runSessionCommand('txt', 'compact', 'keep the plan');
    expect(s.sends.map((x) => x.message)).toEqual(['/compact keep the plan']);
    expect(out).toMatchObject({ name: 'compact', ok: true, startedTurn: true, text: 'reply: /compact keep the plan' });
  });

  it('refuses a name a text-command engine does not list, rather than send it to the model', async () => {
    class Listing extends TextCommandSession {
      async listCommands(): Promise<EngineCommand[]> {
        return [{ name: 'compact', source: 'builtin', startsTurn: true }];
      }
    }
    const s = await start(() => new Listing(), 'txt');
    await expect(mgr.runSessionCommand('txt', 'model')).rejects.toThrow(/there is no command \/model on agy/);
    await mgr.runSessionCommand('txt', 'compact');
    expect(s.sends.map((x) => x.message)).toEqual(['/compact']);
  });

  it('says commands are not supported on an engine whose sessions take none', async () => {
    const s = await start(() => new PlainSession(), 'plain');
    await expect(mgr.listSessionCommands('plain')).rejects.toThrow(/not supported on agy/);
    await expect(mgr.runSessionCommand('plain', 'review')).rejects.toThrow(
      /running engine commands is not supported on agy/,
    );
    expect(s.sends).toEqual([]);
  });
});

describe('turnCommand', () => {
  it('is refused at start on an engine whose messages take no commands, before anything runs', async () => {
    await expect(start(() => new PlainSession(), 'tc', { turnCommand: '/boost' })).rejects.toThrow(
      /turnCommand is not supported on agy/,
    );
    expect(mgr.hasSession('tc')).toBe(false);
    await expect(start(() => new TextCommandSession(), 'tc2', { turnCommand: '  /  ' })).rejects.toThrow(
      /must name an engine command/,
    );
  });

  it('prefixes every message on a text engine, except a message that is itself a command', async () => {
    const s = await start(() => new TextCommandSession(), 'tc', { turnCommand: '/boost' });
    await mgr.sendMessage('tc', 'fix the build');
    await mgr.sendMessage('tc', '/goal clear');
    expect(s.sends.map((x) => x.message)).toEqual(['/boost fix the build', '/goal clear']);
  });

  it("goes through the wrapper's applyTurnCommand when it has one", async () => {
    const s = await start(() => new CapableSession(), 'tc', { turnCommand: 'teamwork' });
    await mgr.sendMessage('tc', 'build it');
    expect(s.turnCommands).toEqual([{ command: 'teamwork', message: 'build it' }]);
    expect(s.sends[0].message).toBe('[teamwork] build it');
  });
});

describe('a model per send', () => {
  it('is passed, resolved, to an engine that takes one', async () => {
    const s = await start(() => new CapableSession(), 'm');
    await mgr.sendMessage('m', 'hi', { model: 'opus' });
    expect(s.sends[0].options?.model).toMatch(/^claude-opus/);
  });

  it("is the model the turn's ledger row names, over the session's own", async () => {
    await start(() => new CapableSession(), 'm', { model: 'gemini-3.8-flash' });
    await mgr.sendMessage('m', 'hi', { model: 'gemini-3.8-pro' });
    await mgr.sendMessage('m', 'again');
    expect(readRunLedger({ session: 'm' }).map((r) => r.model)).toEqual(['gemini-3.8-pro', 'gemini-3.8-flash']);
  });

  it('is refused before the turn on an engine that cannot', async () => {
    const s = await start(() => new PlainSession(), 'm');
    await expect(mgr.sendMessage('m', 'hi', { model: 'opus' })).rejects.toThrow(
      /model per send is not supported on agy/,
    );
    expect(s.sends).toEqual([]);
  });
});

describe('compaction', () => {
  it('returns the outcome of an engine that waits for its compaction', async () => {
    const s = await start(() => new CapableSession(), 'c');
    expect(await mgr.compactSession('c', 'keep tests')).toEqual({
      ok: true,
      preTokens: 9000,
      postTokens: 1200,
      trigger: 'manual',
    });
    expect(s.compacted).toEqual(['keep tests']);
  });

  it('falls back to compact(), and says so when the engine compacted nothing', async () => {
    const s = await start(() => new PlainSession(), 'c');
    expect(await mgr.compactSession('c')).toEqual({ ok: true, trigger: 'manual' });
    s.compactReply = {
      text: 'Agy engine does not support compaction',
      event: { type: 'result', compacted: false },
    };
    await expect(mgr.compactSession('c')).rejects.toThrow(/compaction is not supported on agy/);
  });

  it('autoCompactPercent stops trying once the engine said it cannot compact', async () => {
    const s = await start(() => new PlainSession(), 'nc', { autoCompactPercent: 80 });
    let calls = 0;
    s.compact = async () => {
      calls++;
      return { text: 'Agy engine does not support compaction', event: { type: 'result', compacted: false } };
    };
    await mgr.sendMessage('nc', 'one');
    await mgr.sendMessage('nc', 'two');
    expect(calls).toBe(1);
    expect(s.sends).toHaveLength(2);
  });

  it('autoCompactPercent waits for compactDetailed before the send', async () => {
    const s = await start(() => new CapableSession(), 'c', { autoCompactPercent: 80 });
    await mgr.sendMessage('c', 'go on');
    expect(s.compacted).toEqual([undefined]);
    expect(s.sends).toHaveLength(1);
  });
});

describe('asides and rewinds', () => {
  it('answers aside through the session, and refuses where the engine has no way', async () => {
    const s = await start(() => new CapableSession(), 'a');
    expect(await mgr.askAside('a', 'what file?')).toEqual({ text: 'aside: what file?' });
    expect(s.asked).toEqual(['what file?']);
    await start(() => new PlainSession(), 'p');
    await expect(mgr.askAside('p', 'what file?')).rejects.toThrow(/side question is not supported on agy/);
  });

  it('rewinds through the session and drops the turns from the handoff record', async () => {
    const s = await start(() => new CapableSession(), 'r');
    await mgr.sendMessage('r', 'one');
    await mgr.sendMessage('r', 'two');
    expect(await mgr.rewindSession('r', { turns: 1, files: true })).toEqual({
      ok: true,
      turnsRemoved: 1,
      filesRestored: true,
    });
    expect(s.rewound).toEqual([{ turns: 1, files: true }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const transcript = (mgr as any).sessions.get('r').transcript;
    expect(transcript.entries.map((e: { text: string }) => e.text)).toEqual(['one', 'reply: one']);
  });

  it('maps a rewind by turns on codex-app to its rollback, and refuses what that cannot do', async () => {
    const s = await start(() => new CodexAppLike(), 'cx', { engine: 'codex-app' });
    expect(await mgr.rewindSession('cx', { turns: 2 })).toEqual({ ok: true, turnsRemoved: 2, filesRestored: false });
    expect(s.rollbacks).toEqual([2]);
    await expect(mgr.rewindSession('cx', { turns: 1, files: true })).rejects.toThrow(/restoring files/);
    await expect(mgr.rewindSession('cx', { messageId: 'm1' })).rejects.toThrow(/by turns/);
  });

  it('refuses a rewind on an engine that has none, and a target that is not one thing', async () => {
    await start(() => new PlainSession(), 'p');
    await expect(mgr.rewindSession('p', { turns: 1 })).rejects.toThrow(/rewind is not supported on agy/);
    await start(() => new CapableSession(), 'r');
    await expect(mgr.rewindSession('r', {})).rejects.toThrow(/one of the two/);
    await expect(mgr.rewindSession('r', { turns: 0 })).rejects.toThrow(/at least 1/);
  });
});

describe('live model and effort switches', () => {
  it('switches the model in place when the engine can, without a restart', async () => {
    const s = await start(() => new CapableSession(), 'sw');
    const info = await mgr.switchModel('sw', 'opus');
    expect(info.live).toBe(true);
    expect(s.liveModel).toMatch(/^claude-opus/);
    expect(made).toHaveLength(1);
    expect(mgr.getStatus('sw').model).toMatch(/^claude-opus/);
  });

  it('restarts the session when the engine cannot switch in place', async () => {
    const first = await start(() => new CapableSession(), 'sw');
    first.liveModelResult = false;
    const info = await mgr.switchModel('sw', 'opus');
    expect(info.live).toBe(false);
    expect(made).toHaveLength(2);
  });

  it('switches effort in place when the engine can, else from the next turn', async () => {
    const s = await start(() => new CapableSession(), 'e');
    expect(await mgr.switchEffort('e', 'high')).toEqual({ effort: 'high', live: true });
    expect(s.liveEffort).toBe('high');
    const p = await start(() => new PlainSession(), 'p');
    expect(await mgr.switchEffort('p', 'low')).toEqual({ effort: 'low', live: false });
    expect(p.effort).toBe('low');
    await expect(mgr.switchEffort('p', 'loud' as EffortLevel)).rejects.toThrow(/effort must be one of/);
  });
});

describe('turns the engine starts itself', () => {
  it('get their own ledger row, marked engine, and are kept on the status — not counted in a send', async () => {
    const s = await start(() => new CapableSession(), 'loop');
    await mgr.sendMessage('loop', 'start the loop');
    // A tick: the engine spent on its own and reported a result no send asked for.
    s.costUsd += 2;
    s.turns++;
    s.emit(SESSION_EVENT.UNSOLICITED_RESULT, { text: 'tick 1', event: { type: 'result', result: 'tick 1' } });
    // Claude's wrapper emits the bare event.
    s.costUsd += 3;
    s.emit(SESSION_EVENT.UNSOLICITED_RESULT, { type: 'result', result: 'tick 2', is_error: true });
    const rows = readRunLedger({ session: 'loop' });
    expect(rows.map((r) => [r.origin ?? 'send', r.costUsd, r.ok])).toEqual([
      ['send', 0.25, true],
      ['engine', 2, true],
      ['engine', 3, false],
    ]);
    const status = await mgr.getStatusDetailed('loop');
    expect(status.engineTurns?.map((t) => [t.text, t.ok, t.costUsd])).toEqual([
      ['tick 1', true, 2],
      ['tick 2', false, 3],
    ]);
    expect(status.contextBreakdown?.totalTokens).toBe(5000);
  });

  it('does not charge a send for an engine turn that ended while it waited', async () => {
    const s = await start(() => new CapableSession(), 'mid');
    const send = s.send.bind(s);
    s.send = async (message, options) => {
      s.costUsd += 4;
      s.emit(SESSION_EVENT.UNSOLICITED_RESULT, { text: 'late result', event: { type: 'result' } });
      return send(message, options);
    };
    const result = await mgr.sendMessage('mid', 'next');
    expect(result.usage?.costUsd).toBe(0.25);
    expect(readRunLedger({ session: 'mid' }).map((r) => [r.origin ?? 'send', r.costUsd])).toEqual([
      ['engine', 4],
      ['send', 0.25],
    ]);
  });

  it('leave the spend of a session a goal drives to the goal, and are still kept on its status', async () => {
    const s = await start(() => new CapableSession(), 'goal-s');
    expect(mgr.goalSession('goal-s')).toBeDefined();
    s.costUsd += 1.5;
    s.emit(SESSION_EVENT.UNSOLICITED_RESULT, { text: 'workflow done', event: { type: 'result' } });
    expect(readRunLedger({ session: 'goal-s' })).toEqual([]);
    expect(mgr.getStatus('goal-s').engineTurns).toMatchObject([{ text: 'workflow done', costUsd: 1.5 }]);
  });

  it('records no turn for an info command the engine answered itself', async () => {
    const s = await start(() => new PlainSession(), 'info');
    s.nextResult = { localCommand: true, text: 'Goal active: x' };
    const result = await mgr.sendMessage('info', '/goal');
    expect(result.localCommand).toBe(true);
    expect(readRunLedger({ session: 'info' })).toEqual([]);
  });
});

describe('quota', () => {
  // The engines' own readers would run their CLIs; these tests register their own.
  beforeEach(() => {
    for (const engine of quotaEngines()) unregisterQuotaReader(engine);
  });
  afterEach(() => {
    unregisterQuotaReader('agy');
    unregisterQuotaReader('grok');
  });

  it('reads a registered engine, gives the reader the live session, and lists the rest as unavailable', async () => {
    const s = await start(() => new CapableSession(), 'q');
    let given: ISession | undefined;
    registerQuotaReader('agy', async ({ session }) => {
      given = session;
      return { engine: 'agy', windows: [{ name: 'weekly', remainingPercent: 40 }], source: 'test', readAt: 'now' };
    });
    registerQuotaReader('grok', async () => {
      throw new Error('not logged in');
    });
    const all = await mgr.engineQuota();
    expect(all.quotas.map((q) => q.engine)).toEqual(['agy']);
    // Engines whose own modules register a reader (claude) are listed too; this test's are agy and grok.
    expect(all.unavailable.filter((u) => u.engine === 'agy' || u.engine === 'grok')).toEqual([
      { engine: 'grok', reason: 'not logged in' },
    ]);
    expect(given).toBe(s);
    expect((await mgr.sessionQuota('q'))?.windows[0].remainingPercent).toBe(40);
  });

  it('says quota is not supported on an engine with no reader', async () => {
    await expect(mgr.engineQuota('custom')).rejects.toThrow(/quota is not supported on custom/);
  });

  it('gives up on a reader that does not answer in time', async () => {
    registerQuotaReader('agy', () => new Promise(() => {}));
    await expect(readEngineQuota('agy', { timeoutMs: 20 })).rejects.toThrow(/longer than 20 ms/);
  });
});

describe('native goal loops', () => {
  it("selects the engine's own adapter with native, and keeps today's turn loop without it", async () => {
    const s = await start(() => new CapableSession(), 'g');
    const adapter = new EventEmitter() as unknown as GoalSession;
    s.nativeGoal = adapter;
    expect(mgr.goalSession('g', undefined, { native: true })).toBe(adapter);
    const turnLoop = mgr.goalSession('g');
    expect(turnLoop).toBeDefined();
    expect(turnLoop).not.toBe(adapter);
  });

  it('refuses native on an engine that has no goal loop of its own', async () => {
    await start(() => new PlainSession(), 'g');
    expect(() => mgr.goalSession('g', undefined, { native: true })).toThrow(/native goal loop is not supported on agy/);
  });
});
