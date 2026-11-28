/**
 * Grok Build's headless features through clawo: commands, local answers,
 * compaction, asides, per-send models, the native goal loop, quota, and the
 * one-off ACP calls behind the command list and the plan.
 *
 * Every grok process is a fake: `spawnEngine` is mocked, and each test scripts
 * what each spawned process prints. The fixtures are grok 1.0.92's measured
 * output.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';

const mockSpawn = vi.fn();
const mockKillTree = vi.fn();
vi.mock('../engine-spawn.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../engine-spawn.js')>()),
  spawnEngine: (...args: unknown[]) => mockSpawn(...args),
  killEngineTree: (...args: unknown[]) => mockKillTree(...args),
}));

const { PersistentGrokSession } = await import('../persistent-grok-session.js');
const commands = await import('../grok-commands.js');
const { GrokGoalSession, grokGoalCommand } = await import('../grok-goal-session.js');
const { latestGrokRefusal, grokQuotaFrom, readGrokQuota } = await import('../grok-quota.js');
const { grokAcpCall } = await import('../grok-acp-client.js');
const { classifyTurnError } = await import('../turn-goal-session.js');
const { SESSION_EVENT } = await import('../constants.js');

// ─── Fake processes ─────────────────────────────────────────────────────────

type Line = Record<string, unknown>;

interface FakeProc extends EventEmitter {
  stdout: Readable;
  stderr: EventEmitter;
  stdin: { end: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn>; write: ReturnType<typeof vi.fn> };
  kill: ReturnType<typeof vi.fn>;
  pid: number;
  args: string[];
  input: string;
}

function fakeProc(args: string[]): FakeProc {
  const proc = new EventEmitter() as FakeProc;
  proc.stdout = new Readable({ read() {} });
  proc.stderr = new EventEmitter();
  proc.input = '';
  proc.stdin = {
    end: vi.fn((data?: string) => {
      if (typeof data === 'string') proc.input += data;
    }),
    on: vi.fn(),
    write: vi.fn(),
  };
  proc.kill = vi.fn();
  proc.pid = 4242;
  proc.args = args;
  return proc;
}

/** Print `lines` as JSON lines and exit with `code`. */
function finish(proc: FakeProc, lines: Line[], code = 0): void {
  setTimeout(() => {
    proc.stdout.push(lines.map((l) => JSON.stringify(l) + '\n').join(''));
    proc.stdout.push(null);
    proc.emit('close', code);
  }, 2);
}

const SID = '01a220f0-b69e-75e0-80bb-564ba6a03fd5';
const ADVERTISED: Line = {
  type: 'available_commands',
  tools: ['run_terminal_command', 'read_file', 'write'],
  commands: ['compact', 'session-info', 'goal', 'loop', 'brainstorming', 'learn-traces'],
};

/** A model turn: text, one request's usage, an end with usage and cost. */
function modelTurn(text: string, cost = 0.05, extraEnd: Line = {}): Line[] {
  const usage = { input_tokens: 27_000, output_tokens: 600, cache_read_input_tokens: 8_576 };
  return [
    ADVERTISED,
    { type: 'thought', data: 'x' },
    { type: 'text', data: text },
    { type: 'usage', usage },
    { type: 'end', stopReason: 'end_turn', sessionId: SID, usage, total_cost_usd: cost, ...extraEnd },
  ];
}

/** A reply grok gave itself: one text line, an end without usage (measured on /goal status). */
function localReply(text: string): Line[] {
  return [ADVERTISED, { type: 'text', data: text }, { type: 'end', stopReason: 'end_turn', sessionId: SID }];
}

const sessionInfo = (used: number) =>
  `**Session ID:** ${SID}\n\n**Model:** grok-4.7\n\n**Turn:** 1\n\n**Context:** ${used} / 256000 tokens (10%)`;

/** The ACP agent (`grok agent stdio`): answers initialize, then `method` with `result`. */
function acpAgent(proc: FakeProc, answer: (method: string) => { result?: unknown; error?: unknown }): void {
  proc.stdin.write.mockImplementation((data: string) => {
    for (const line of data.split('\n').filter(Boolean)) {
      const msg = JSON.parse(line) as { id: number; method: string };
      const reply =
        msg.method === 'initialize' ? { result: { protocolVersion: 1, agentCapabilities: {} } } : answer(msg.method);
      setTimeout(() => {
        proc.stdout.push(JSON.stringify({ jsonrpc: '2.0', method: '_x.ai/mcp/servers_updated', params: {} }) + '\n');
        proc.stdout.push(JSON.stringify({ jsonrpc: '2.0', id: msg.id, ...reply }) + '\n');
      }, 1);
    }
    return true;
  });
}

const ACP_COMMANDS = {
  commands: [
    { name: 'compact', description: 'Compress conversation history to save context window', input: null },
    {
      name: 'brainstorming',
      description: 'You MUST use this before any creative work',
      input: null,
      _meta: { scope: 'user', pluginName: 'superpowers', qualifiedName: 'superpowers:brainstorming' },
    },
    {
      name: 'user:docs',
      description: 'docs (editable docs)',
      input: null,
      _meta: { scope: 'user', qualifiedName: 'user:docs' },
    },
    {
      name: 'review',
      description: 'Run a reviewer subagent',
      input: { hint: '[--main | --local]' },
      _meta: { scope: 'bundled' },
    },
    {
      name: 'learn-traces',
      description: 'Workflow: Map-reduce a collected set of Grok Build sessions',
      input: { hint: '[--agent-budget N] [--effort LEVEL] [args]' },
      _meta: { workflowSource: 'bundled', workflowPath: '/x/learn-traces.rhai' },
    },
  ],
};

/**
 * Script every spawn: `handler` gets the argv and the fake, and decides what
 * it prints. ACP processes (`agent stdio`) answer `_x.ai/commands/list`.
 */
function script(handler: (args: string[], proc: FakeProc) => void): FakeProc[] {
  const procs: FakeProc[] = [];
  mockSpawn.mockImplementation((_bin: string, args: string[]) => {
    const proc = fakeProc(args);
    procs.push(proc);
    if (args[0] === 'agent') {
      acpAgent(proc, (method) =>
        method === '_x.ai/commands/list' ? { result: ACP_COMMANDS } : { error: { code: -32601, message: 'nope' } },
      );
    } else {
      // The message is on stdin; it is written synchronously after the spawn.
      setTimeout(() => handler(args, proc), 0);
    }
    return proc;
  });
  return procs;
}

const printRuns = (procs: FakeProc[]) => procs.filter((p) => p.args[0] === '-p');

beforeEach(() => {
  mockSpawn.mockReset();
  mockKillTree.mockReset();
});

async function started(config: Record<string, unknown> = {}) {
  const s = new PersistentGrokSession({ name: 't', cwd: '/tmp', permissionMode: 'bypassPermissions', ...config });
  await s.start();
  return s;
}

/** A session that has had one model turn, so it holds grok session SID. */
async function withConversation(config: Record<string, unknown> = {}) {
  const s = await started(config);
  const procs = script((_a, p) => finish(p, modelTurn('hello')));
  await s.send('hi', { waitForComplete: true });
  procs.length = 0;
  return s;
}

// ─── Command parsing and refusals ───────────────────────────────────────────

describe('grok commands — parsing', () => {
  it('reads a command the way grok does', () => {
    expect(commands.parseGrokCommand('/goal status')).toEqual({ name: 'goal', args: 'status' });
    expect(commands.parseGrokCommand('  /user:docs write one')).toEqual({ name: 'user:docs', args: 'write one' });
    expect(commands.parseGrokCommand('/session-info')).toEqual({ name: 'session-info', args: '' });
    // grok sends these as typed: another `/`, a dot, an underscore.
    expect(commands.parseGrokCommand('/tmp/build.log is full')).toBeUndefined();
    expect(commands.parseGrokCommand('/README.md')).toBeUndefined();
    expect(commands.parseGrokCommand('/fix_issue')).toBeUndefined();
    expect(commands.parseGrokCommand('hello /help')).toBeUndefined();
  });

  it('tells a local answer from a turn', () => {
    const local = commands.grokCommandIsLocal;
    expect(local('goal', 'status')).toBe(true);
    expect(local('goal', '')).toBe(true);
    expect(local('goal', 'pause')).toBe(true);
    expect(local('goal', 'clear')).toBe(true);
    expect(local('goal', 'resume')).toBe(false);
    expect(local('goal', 'make it work')).toBe(false);
    expect(local('workflow', 'runs')).toBe(true);
    expect(local('workflow', '')).toBe(true);
    expect(local('workflow', 'review-changes x')).toBe(false);
    expect(local('session-info', '')).toBe(true);
    expect(local('status', '')).toBe(true);
    expect(local('plugins', 'list')).toBe(true);
    expect(local('compact', '')).toBe(false);
    expect(local('brainstorming', 'x')).toBe(false);
  });
});

describe('grok commands — refusals', () => {
  const refuse = (m: string, wf?: Set<string>) => commands.grokCommandRefusal(m, wf);

  it('refuses a TUI command, naming what to use instead', () => {
    expect(refuse('/help')).toMatch(/grok TUI command.*session_command list/);
    expect(refuse('/model grok-4.6')).toMatch(/session_switch_model/);
    expect(refuse('/btw what is 2+2')).toMatch(/session_aside/);
    expect(refuse('/usage')).toMatch(/engine_quota/);
    expect(refuse('/rewind')).toMatch(/nothing in its place/);
  });

  it('refuses what a one-shot process cannot hold', () => {
    expect(refuse('/loop 1m say hi')).toMatch(/\/loop schedules its job inside the grok process.*acpAgent 'grok'/);
    expect(refuse('/deep-research when was TCP specified')).toMatch(/runs a workflow in the background/);
    expect(refuse('/workflow review-changes {"a":1}')).toMatch(/\/workflow review-changes runs a workflow/);
    expect(refuse('/learn-traces', new Set(['learn-traces']))).toMatch(/runs a workflow in the background/);
    expect(refuse('/feedback great tool')).toMatch(/sends this session to xAI/);
    expect(refuse('/context')).toMatch(/empty reply/);
  });

  it('lets through what grok answers or runs headless', () => {
    for (const m of [
      'hello',
      '/goal status',
      '/goal make the tests pass',
      '/deep-research',
      '/workflow runs',
      '/workflow',
      '/session-info',
      '/brainstorming a new feature',
      '/tmp/x.log is full',
    ]) {
      expect(refuse(m)).toBeUndefined();
    }
  });

  it('lists the TUI commands as needing a person', () => {
    const pager = commands.grokPagerCommands();
    expect(pager.find((c) => c.name === 'help')).toMatchObject({ needsHuman: true, startsTurn: false });
    expect(pager.every((c) => c.needsHuman)).toBe(true);
    // None is also a shell built-in.
    for (const c of pager) expect(commands.grokShellCommand(c.name)).toBeUndefined();
  });
});

describe('grok commands — parsers', () => {
  it("maps grok's ACP command list onto skills, plugin skills and workflows", () => {
    const workflows = new Set<string>();
    const list = commands.commandsFromGrokAcpList(ACP_COMMANDS, workflows);
    expect(list.map((c) => c.name)).toEqual(['brainstorming', 'user:docs', 'review', 'learn-traces']);
    expect(list[0]).toMatchObject({ source: 'plugin', startsTurn: true });
    expect(list[1]).toMatchObject({ source: 'skill' });
    expect(list[2]).toMatchObject({ args: '[--main | --local]' });
    expect(list[3]).toMatchObject({ source: 'custom', description: expect.stringMatching(/background workflow/) });
    expect([...workflows]).toEqual(['learn-traces']);
    expect(commands.commandsFromGrokAcpList({ nope: 1 })).toEqual([]);
  });

  it('reads the context out of /session-info', () => {
    expect(commands.parseGrokSessionContext(sessionInfo(24403))).toEqual({ used: 24403, total: 256000, turn: 1 });
    expect(commands.parseGrokSessionContext('nothing')).toBeUndefined();
  });

  it('reads /goal status replies', () => {
    expect(commands.parseGrokGoalStatus('No goal is currently set. Use /goal <objective> to start one.')).toBeNull();
    expect(commands.parseGrokGoalStatus('No goal set. Use /goal <objective> to start one.')).toBeNull();
    expect(
      commands.parseGrokGoalStatus(
        'Goal: Create ok.txt, verified by cat.\nStatus: InfraPaused | Phase: Idle\nGoal tokens used: 27270\nElapsed: 2m37s',
      ),
    ).toEqual({
      objective: 'Create ok.txt, verified by cat.',
      status: 'infrapaused',
      phase: 'Idle',
      tokensUsed: 27270,
      elapsedSeconds: 157,
    });
    expect(commands.parseGrokGoalStatus('Unknown command: /x')).toBeUndefined();
  });

  it("reads a goal's state.json", () => {
    expect(
      commands.parseGrokGoalStateFile({
        objective: 'hello',
        status: 'budget_limited',
        phase: 'Idle',
        token_budget: 5000,
        elapsed_ms: 157380,
        tokens_used_high_water: 187567,
        pause_message: 'x',
      }),
    ).toEqual({
      objective: 'hello',
      status: 'budgetlimited',
      phase: 'Idle',
      tokensUsed: 187567,
      elapsedSeconds: 157,
      tokenBudget: 5000,
      pauseMessage: 'x',
    });
    expect(commands.parseGrokGoalStateFile({ status: 'complete' })).toBeUndefined();
  });

  it("classifies grok's usage-limit refusals as usage limits", () => {
    for (const text of [
      'You’ve reached your free Grok Build usage limit for now. Get SuperGrok for much higher limits',
      'resource-exhausted: Too many requests for team abc and model grok...te limit tier is determined',
      "API error (status 429 Too Many Requests): subscription:free-usage-exhausted: You've used all the included free usage",
    ]) {
      expect(classifyTurnError(text)).toBe('usageLimitExceeded');
    }
  });
});

// ─── The wrapper ────────────────────────────────────────────────────────────

describe('PersistentGrokSession — local answers', () => {
  it('reports a reply grok gave itself as a local command, not a turn', async () => {
    const s = await withConversation({ model: 'grok-4.6' });
    const before = s.getStats();
    script((_a, p) => finish(p, localReply('No goal is currently set.')));
    const r = (await s.send('/goal status', { waitForComplete: true })) as { text: string; localCommand?: boolean };
    expect(r).toMatchObject({ text: 'No goal is currently set.', localCommand: true });
    const after = s.getStats();
    expect(after.turns).toBe(before.turns);
    expect(after.turnsSucceeded).toBe(before.turnsSucceeded);
    // The context figure is the last turn's, not zero.
    expect(after.contextPercent).toBe(before.contextPercent);
    expect(before.contextPercent).toBeGreaterThan(0);
  });

  it('counts a turn whose model call was refused, though its end has no usage', async () => {
    // `/goal <objective>` at the usage limit (1.0.92): the planner's request
    // logged usage, then the goal paused and the run ended end_turn, exit 0.
    const s = await started();
    script((_a, p) =>
      finish(p, [
        ADVERTISED,
        { type: 'thought', data: 'plan' },
        { type: 'usage', usage: { input_tokens: 25416, output_tokens: 698 } },
        { type: 'text', data: 'Goal paused. No plan was produced. Retry with /goal resume.' },
        { type: 'end', stopReason: 'end_turn', sessionId: SID },
      ]),
    );
    const r = (await s.send('/goal make ok.txt', { waitForComplete: true })) as { localCommand?: boolean };
    expect(r.localCommand).toBeUndefined();
    expect(s.getStats().turns).toBe(1);
  });

  it('keeps the advertised commands and tools of the last run', async () => {
    const s = await started();
    script((_a, p) => finish(p, modelTurn('hi')));
    await s.send('hi', { waitForComplete: true });
    // The ACP read fails: the names the run advertised stand in.
    mockSpawn.mockImplementation((_b: string, args: string[]) => {
      const proc = fakeProc(args);
      setTimeout(() => proc.emit('close', 1), 1);
      return proc;
    });
    const list = await s.listCommands();
    expect(list.find((c) => c.name === 'brainstorming')).toMatchObject({ source: 'skill', startsTurn: true });
    expect(list.find((c) => c.name === 'loop')).toMatchObject({ source: 'builtin' });
  });
});

describe('PersistentGrokSession — refusals before anything runs', () => {
  it('refuses a TUI command without starting grok', async () => {
    const s = await started();
    await expect(s.send('/help', { waitForComplete: true })).rejects.toThrow(/grok TUI command/);
    await expect(s.send('/loop 5m check CI', { waitForComplete: true })).rejects.toThrow(/schedules its job/);
    await expect(s.send('/deep-research TCP history', { waitForComplete: true })).rejects.toThrow(/background/);
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(s.getStats().turns).toBe(0);
  });

  it('refuses a workflow launched by its own name, read from the ACP list once a minute', async () => {
    const s = await started();
    const procs = script((_a, p) => finish(p, modelTurn('ok')));
    await expect(s.send('/learn-traces', { waitForComplete: true })).rejects.toThrow(/runs a workflow/);
    await s.send('/brainstorming a thing', { waitForComplete: true });
    expect(procs.filter((p) => p.args[0] === 'agent')).toHaveLength(1);
    expect(procs[0].args).toEqual(['agent', 'stdio']);
    // No session was opened over ACP: initialize, then the list.
    const methods = procs[0].stdin.write.mock.calls.map((c) => JSON.parse(c[0] as string).method);
    expect(methods).toEqual(['initialize', '_x.ai/commands/list']);
    expect(mockKillTree).toHaveBeenCalledWith(procs[0]);
  });

  it('sends anything as text on a verbatim session', async () => {
    const s = await started({ disableSlashCommands: true });
    const procs = script((_a, p) => finish(p, modelTurn('a model answer')));
    await s.send('/help', { waitForComplete: true });
    expect(procs[0].args).toContain('--verbatim');
  });
});

describe('PersistentGrokSession — per-send model and plan', () => {
  it('runs one turn on another model and the next on the session model', async () => {
    const s = await started({ model: 'grok-4.7' });
    const procs = script((_a, p) => finish(p, modelTurn('ok')));
    await s.send('a', { waitForComplete: true, model: 'grok-4.6' });
    await s.send('b', { waitForComplete: true });
    expect(s.perSendModel).toBe(true);
    const models = procs.map((p) => p.args[p.args.indexOf('--model') + 1]);
    expect(models).toEqual(['grok-4.6', 'grok-4.7']);
  });

  it("runs a plan turn in grok's plan mode, without auto-approval", async () => {
    const s = await started({ dangerouslySkipPermissions: true });
    const procs = script((_a, p) => finish(p, modelTurn('plan')));
    await s.send('plan it', { waitForComplete: true, plan: true });
    await s.send('do it', { waitForComplete: true });
    expect(procs[0].args[procs[0].args.indexOf('--permission-mode') + 1]).toBe('plan');
    expect(procs[0].args).not.toContain('--always-approve');
    expect(procs[1].args[procs[1].args.indexOf('--permission-mode') + 1]).toBe('bypassPermissions');
    expect(procs[1].args).toContain('--always-approve');
  });

  it('switches the model in place', async () => {
    const s = await started({ model: 'grok-4.7' });
    expect(await s.setModelLive('grok-4.6')).toBe(true);
    const procs = script((_a, p) => finish(p, modelTurn('ok')));
    await s.send('x', { waitForComplete: true });
    expect(procs[0].args[procs[0].args.indexOf('--model') + 1]).toBe('grok-4.6');
  });
});

describe('PersistentGrokSession — listing and running commands', () => {
  it('lists the built-ins, the skills and workflows from ACP, and the TUI commands', async () => {
    const s = await started();
    script(() => undefined);
    const list = await s.listCommands();
    const names = list.map((c) => c.name);
    expect(names.slice(0, 3)).toEqual(['compact', 'always-approve', 'context']);
    expect(list.find((c) => c.name === 'brainstorming')).toMatchObject({ source: 'plugin' });
    expect(list.find((c) => c.name === 'learn-traces')).toMatchObject({ source: 'custom' });
    expect(list.find((c) => c.name === 'help')).toMatchObject({ needsHuman: true });
    expect(list.find((c) => c.name === 'session-info')).toMatchObject({ startsTurn: false });
    expect(new Set(names).size).toBe(names.length);
  });

  it('runs a local command on the conversation beside the turns, as no turn', async () => {
    const s = await withConversation();
    const before = s.getStats();
    const procs = script((_a, p) => finish(p, localReply('Installed plugins (2)')));
    const out = await s.runCommand('plugins', 'list');
    expect(out).toEqual({ name: 'plugins', ok: true, text: 'Installed plugins (2)', startedTurn: false });
    const run = printRuns(procs)[0];
    expect(run.args).toEqual(expect.arrayContaining(['--resume', SID, '--no-wait-for-background']));
    expect(run.input).toBe('/plugins list');
    expect(s.getStats().turns).toBe(before.turns);
  });

  it('runs a skill as a turn', async () => {
    const s = await withConversation();
    const procs = script((_a, p) => finish(p, modelTurn('ideas')));
    const out = await s.runCommand('brainstorming', 'a feature');
    expect(out).toMatchObject({ ok: true, text: 'ideas', startedTurn: true });
    expect(printRuns(procs)[0].input).toBe('/brainstorming a feature');
    expect(s.getStats().turns).toBe(2);
  });

  it('refuses a name grok lists no command or workflow for, with no turn', async () => {
    const s = await withConversation();
    const procs = script((_a, p) => finish(p, modelTurn('about the text')));
    await expect(s.runCommand('no-such-command', 'x')).rejects.toThrow(/there is no command \/no-such-command/);
    expect(printRuns(procs)).toEqual([]);
    expect(s.getStats().turns).toBe(1);
  });

  it('refuses a command a one-shot process cannot hold', async () => {
    const s = await withConversation();
    await expect(s.runCommand('loop', '1m hi')).rejects.toThrow(/schedules its job/);
    await expect(s.runCommand('workflow', 'review-changes')).rejects.toThrow(/background/);
  });

  it('answers a failed turn as a failed outcome', async () => {
    const s = await withConversation();
    script((_a, p) => finish(p, [{ type: 'error', message: 'You’ve reached your free Grok Build usage limit' }], 1));
    const out = await s.runCommand('brainstorming', 'x');
    expect(out).toMatchObject({ ok: false, startedTurn: true, error: expect.stringMatching(/usage limit/) });
  });
});

describe('PersistentGrokSession — compaction', () => {
  it('has nothing to compact before the first turn', async () => {
    const s = await started();
    expect(await s.compactDetailed()).toMatchObject({ ok: true, note: expect.stringMatching(/nothing to compact/) });
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('does not compact a conversation no model turn has written to', async () => {
    const s = await withConversation();
    const seen: string[] = [];
    script((_a, p) => {
      seen.push(p.input);
      finish(p, localReply(sessionInfo(1266).replace('**Turn:** 1', '**Turn:** 0')));
    });
    expect(await s.compactDetailed()).toMatchObject({
      ok: true,
      preTokens: 1266,
      postTokens: 1266,
      note: expect.stringMatching(/no turns yet/),
    });
    expect(seen).toEqual(['/session-info']);
  });

  it('compacts, and proves it by the context /session-info reports', async () => {
    const s = await withConversation({ disableSlashCommands: true });
    const seen: string[] = [];
    let infos = 0;
    script((args, p) => {
      seen.push(p.input);
      if (p.input === '/session-info') finish(p, localReply(sessionInfo(infos++ === 0 ? 36521 : 24403)));
      else
        finish(p, [
          ADVERTISED,
          { type: 'auto_compact_completed' },
          { type: 'end', stopReason: 'end_turn', sessionId: SID },
        ]);
      // The compact run takes the command even on a verbatim session.
      if (p.input === '/compact') expect(args).not.toContain('--verbatim');
    });
    const outcome = await s.compactDetailed('keep the plan');
    expect(seen).toEqual(['/session-info', '/compact', '/session-info']);
    expect(outcome).toMatchObject({ ok: true, trigger: 'manual', preTokens: 36521, postTokens: 24403 });
    expect(outcome.note).toMatch(/takes no summary/);
    // The next turn reads the compacted conversation against grok's own window.
    expect(s.getStats().contextPercent).toBe(Math.round((24403 / 256000) * 100));
    expect(s.getStats().turns).toBe(1);
  });

  it('is not ok when grok said it compacted but the context did not shrink', async () => {
    const s = await withConversation();
    let infos = 0;
    script((_a, p) => {
      if (p.input === '/session-info') finish(p, localReply(sessionInfo(infos++ === 0 ? 24403 : 24506)));
      else finish(p, [ADVERTISED, { type: 'auto_compact_completed' }, { type: 'end', stopReason: 'end_turn' }]);
    });
    const outcome = await s.compactDetailed();
    expect(outcome).toMatchObject({ ok: false, preTokens: 24403, postTokens: 24506 });
    expect(outcome.note).toMatch(/did not shrink \(24403 → 24506 tokens\)/);
    // compact() says the same to a caller that reads `compacted`.
    script((_a, p) => {
      if (p.input === '/session-info') finish(p, localReply(sessionInfo(24506)));
      else finish(p, [ADVERTISED, { type: 'end', stopReason: 'end_turn' }]);
    });
    expect((await s.compact()).event.compacted).toBe(false);
  });

  it("compacts a '/compact' message, and fails it when nothing shrank", async () => {
    const s = await withConversation();
    let infos = 0;
    script((_a, p) => {
      if (p.input === '/session-info') finish(p, localReply(sessionInfo(infos++ === 0 ? 30000 : 20000)));
      else finish(p, [ADVERTISED, { type: 'auto_compact_completed' }, { type: 'end', stopReason: 'end_turn' }]);
    });
    const r = (await s.send('/compact', { waitForComplete: true })) as { text: string; localCommand?: boolean };
    expect(r).toMatchObject({ text: 'compacted: 30000 → 20000 tokens', localCommand: true });
    script((_a, p) => {
      if (p.input === '/session-info') finish(p, localReply(sessionInfo(20000)));
      else finish(p, [ADVERTISED, { type: 'end', stopReason: 'end_turn' }]);
    });
    await expect(s.send('/compact', { waitForComplete: true })).rejects.toThrow(/did not shrink/);
  });
});

describe('PersistentGrokSession — asides', () => {
  it('needs a conversation', async () => {
    const s = await started();
    await expect(s.askAside('what changed?')).rejects.toThrow(/needs a grok conversation/);
  });

  it('asks on a fork with every tool removed, and bills it without a turn', async () => {
    const s = await withConversation();
    const before = s.getStats();
    const procs = script((_a, p) => finish(p, modelTurn('two files', 0.03)));
    expect(await s.askAside('/which files changed?')).toEqual({ text: 'two files' });
    const args = printRuns(procs)[0].args;
    expect(args).toEqual(
      expect.arrayContaining(['--resume', SID, '--fork-session', '--max-turns', '1', '--no-subagents', '--verbatim']),
    );
    expect(args[args.indexOf('--deny') + 1]).toBe('MCPTool');
    expect(args.find((a) => a.startsWith('--rules='))).toMatch(/No tools are available/);
    // The tools the last run advertised.
    expect(args[args.indexOf('--disallowed-tools') + 1]).toBe('run_terminal_command,read_file,write');
    const after = s.getStats();
    expect(after.turns).toBe(before.turns);
    expect(after.costUsd).toBeCloseTo(before.costUsd + 0.03, 6);
    // The conversation is still the session's own.
    expect(after.grokSessionId).toBe(SID);
  });
});

describe('PersistentGrokSession — asides that answer nothing', () => {
  it('fails an aside that came back empty', async () => {
    const s = await withConversation();
    script((_a, p) =>
      finish(p, [
        ADVERTISED,
        { type: 'usage', usage: { input_tokens: 9 } },
        { type: 'end', stopReason: 'max_turn_requests' },
      ]),
    );
    await expect(s.askAside('what changed?')).rejects.toThrow(/no answer.*max_turn_requests/);
  });
});

describe('PersistentGrokSession — spend beyond the end line', () => {
  const usageRecord = (ticks: number, endedAt = new Date().toISOString()) =>
    JSON.stringify({
      sessionId: SID,
      session: { costUsdTicks: ticks },
      turns: [{ turnNumber: 1, endedAt, costUsdTicks: ticks }],
    });

  it("adds what grok's record has over the end line after a goal turn, which waits for the goal", async () => {
    const s = await started();
    const procs = script((args, p) => {
      if (args[0] === 'usage') {
        setTimeout(() => {
          p.stdout.push(usageRecord(6_121_160_000));
          p.stdout.push(null);
          p.emit('close', 0);
        }, 1);
      } else finish(p, modelTurn('done', 0.51516));
    });
    await s.runGoalTurn('/goal write hello.txt', { timeout: 60_000 });
    const goalRun = procs.find((p) => p.args[0] === '-p')!;
    expect(goalRun.args).not.toContain('--no-wait-for-background');
    expect(procs.find((p) => p.args[0] === 'usage')!.args).toEqual(['usage', SID]);
    expect(s.getStats().costUsd).toBeCloseTo(0.6121, 4);
  });

  it('reads the record when the end line has no cost, and not otherwise', async () => {
    const s = await started();
    const procs = script((args, p) => {
      if (args[0] === 'usage') {
        setTimeout(() => {
          p.stdout.push(usageRecord(500_000_000));
          p.stdout.push(null);
          p.emit('close', 0);
        }, 1);
      } else finish(p, modelTurn('ok', 0.01));
    });
    await s.send('a', { waitForComplete: true });
    expect(procs.some((p) => p.args[0] === 'usage')).toBe(false);
    script((args, p) => {
      if (args[0] === 'usage') {
        setTimeout(() => {
          p.stdout.push(usageRecord(500_000_000));
          p.stdout.push(null);
          p.emit('close', 0);
        }, 1);
      } else {
        const lines = modelTurn('ok');
        const end = lines.at(-1)!;
        delete end.total_cost_usd;
        end.cost_is_partial = true;
        finish(p, lines);
      }
    });
    await s.send('b', { waitForComplete: true });
    expect(s.getStats().costUsd).toBeCloseTo(0.01 + 0.05, 6);
  });

  it("ignores a record that is an earlier turn's", async () => {
    const s = await started();
    script((args, p) => {
      if (args[0] === 'usage') {
        setTimeout(() => {
          p.stdout.push(usageRecord(9_000_000_000, '2020-01-01T00:00:00Z'));
          p.stdout.push(null);
          p.emit('close', 0);
        }, 1);
      } else finish(p, modelTurn('done', 0.2));
    });
    await s.runGoalTurn('/goal x', { timeout: 60_000 });
    expect(s.getStats().costUsd).toBeCloseTo(0.2, 6);
  });

  it("sends a '/goal <objective>' message the same way", async () => {
    const s = await started();
    const procs = script((args, p) => {
      if (args[0] === 'usage') p.emit('close', 1);
      else finish(p, modelTurn('done'));
    });
    await s.send('/goal ship it', { waitForComplete: true });
    expect(printRuns(procs)[0].args).not.toContain('--no-wait-for-background');
    await s.send('/goal status', { waitForComplete: true });
    expect(printRuns(procs)[1].args).toContain('--no-wait-for-background');
  });
});

describe('PersistentGrokSession — goal state and stop', () => {
  let home: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-home-'));
    vi.stubEnv('GROK_HOME', home);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("reads the goal from the session's state.json", async () => {
    const s = await withConversation();
    expect(s.readGoalState()).toBeUndefined();
    const dir = path.join(home, 'sessions', '%2Fwork', SID);
    fs.mkdirSync(dir, { recursive: true });
    expect(s.readGoalState()).toBeNull();
    fs.mkdirSync(path.join(dir, 'goal'));
    fs.writeFileSync(
      path.join(dir, 'goal', 'state.json'),
      JSON.stringify({ objective: 'x', status: 'complete', phase: 'Idle', tokens_used_high_water: 10 }),
    );
    expect(s.readGoalState()).toMatchObject({ objective: 'x', status: 'complete', tokensUsed: 10 });
  });

  it("finds a usage-limit refusal logged under a subagent's session id", async () => {
    const s = await withConversation();
    fs.mkdirSync(path.join(home, 'logs'));
    const now = Date.now();
    fs.writeFileSync(
      path.join(home, 'logs', 'unified.jsonl'),
      JSON.stringify({
        ts: new Date(now - 1_000).toISOString(),
        sid: 'planner-subagent',
        msg: 'shell.turn.inference_failed',
        ctx: { kind: 'rate_limited', status_code: 429, message: 'subscription:free-usage-exhausted' },
      }) + '\n',
    );
    expect(s.usageLimitSince(now - 5_000)).toBe('subscription:free-usage-exhausted');
    expect(s.usageLimitSince(now)).toBeUndefined();
  });

  it('stops the side processes with the session', async () => {
    const s = await withConversation();
    const procs = script(() => undefined);
    const pending = s.runLocalCommand('/session-info');
    await new Promise((r) => setTimeout(r, 10));
    s.stop();
    expect(mockKillTree).toHaveBeenCalledWith(printRuns(procs)[0]);
    printRuns(procs)[0].emit('close', null);
    expect((await pending).error).toMatch(/no JSON result/);
  });
});

// ─── The native goal adapter ────────────────────────────────────────────────

class FakeHost extends EventEmitter {
  grokConversationId: string | undefined = undefined;
  state: ReturnType<InstanceType<typeof PersistentGrokSession>['readGoalState']> = undefined;
  refusal: string | undefined;
  turns: string[] = [];
  locals: string[] = [];
  localReplies: Record<string, string> = {};
  interrupted = 0;
  tokens = 0;
  private resolveTurn?: (r: { text: string; event: { type: string } }) => void;
  private rejectTurn?: (e: Error) => void;
  runGoalTurn(text: string) {
    this.turns.push(text);
    return new Promise<{ text: string; event: { type: string } }>((resolve, reject) => {
      this.resolveTurn = resolve;
      this.rejectTurn = reject;
    });
  }
  async runLocalCommand(text: string) {
    this.locals.push(text);
    return { text: this.localReplies[text] ?? '' };
  }
  readGoalState() {
    return this.state;
  }
  usageLimitSince() {
    return this.refusal;
  }
  interruptRun() {
    this.interrupted += 1;
    return true;
  }
  getStats() {
    return { tokensIn: this.tokens, tokensOut: 0 };
  }
  /** End the running goal process. */
  async end(text: string, state: FakeHost['state'], id = SID) {
    this.grokConversationId = id;
    this.state = state;
    this.resolveTurn?.({ text, event: { type: 'result' } });
    await new Promise((r) => setTimeout(r, 5));
  }
  async fail(message: string) {
    this.rejectTurn?.(new Error(message));
    await new Promise((r) => setTimeout(r, 5));
  }
}

const goalState = (status: string, extra: Record<string, unknown> = {}) => ({
  objective: 'write hello.txt',
  status,
  tokensUsed: 187567,
  elapsedSeconds: 157,
  tokenBudget: null,
  ...extra,
});

describe('GrokGoalSession', () => {
  it("sets the goal with grok's /goal and ends it complete by grok's own state", async () => {
    const host = new FakeHost();
    const goal = new GrokGoalSession(host);
    const results: unknown[] = [];
    goal.on(SESSION_EVENT.RESULT, (r) => results.push(r));
    const snap = await goal.setGoal({ objective: 'write hello.txt', tokenBudget: 200000 });
    expect(snap.status).toBe('active');
    expect(host.turns).toEqual(['/goal write hello.txt --budget 200000']);
    expect(goal.turnActive).toBe(true);
    await host.end('Done. Not Refuted.', goalState('complete'));
    expect(goal.turnActive).toBe(false);
    expect(goal.goal).toMatchObject({ status: 'complete', tokensUsed: 187567, timeUsedSeconds: 157 });
    expect(goal.codexThreadId).toBe(SID);
    expect(results).toEqual([{ type: 'result', result: 'Done. Not Refuted.' }]);
  });

  it('is usage-limited when grok paused the goal at a usage-limit refusal', async () => {
    const host = new FakeHost();
    const goal = new GrokGoalSession(host);
    const errors: Array<{ code: string | null }> = [];
    goal.on('codex:error', (e) => errors.push(e));
    await goal.setGoal({ objective: 'x' });
    host.refusal = 'subscription:free-usage-exhausted';
    await host.end('Goal paused. No plan was produced.', goalState('infrapaused', { pauseMessage: 'No plan' }));
    expect(goal.goal?.status).toBe('usageLimited');
    expect(errors.at(-1)?.code).toBe('usageLimitExceeded');
    // The node resumes it with grok's own command.
    await goal.setGoal({ status: 'active' });
    expect(host.turns.at(-1)).toBe('/goal resume');
  });

  it("is paused, with grok's message, when grok paused it for another reason", async () => {
    const host = new FakeHost();
    const goal = new GrokGoalSession(host);
    await goal.setGoal({ objective: 'x' });
    await host.end('', goalState('infrapaused', { pauseMessage: 'No plan was produced. Retry with /goal resume.' }));
    expect(goal.goal?.status).toBe('paused');
    expect(goal.lastError?.message).toMatch(/No plan was produced/);
  });

  it('is paused when the process ended with grok still on the goal, and budget-limited as grok says', async () => {
    const host = new FakeHost();
    const goal = new GrokGoalSession(host);
    await goal.setGoal({ objective: 'x' });
    await host.end('', goalState('executing'));
    expect(goal.goal?.status).toBe('paused');
    await goal.setGoal({ status: 'active' });
    await host.end('', goalState('budget_limited'));
    expect(goal.goal?.status).toBe('budgetLimited');
  });

  it('is blocked when grok holds no goal after the turn', async () => {
    const host = new FakeHost();
    const goal = new GrokGoalSession(host);
    await goal.setGoal({ objective: 'x' });
    await host.end('', null);
    expect(goal.goal?.status).toBe('blocked');
  });

  it('asks /goal status when the state file cannot be read', async () => {
    const host = new FakeHost();
    host.localReplies['/goal status'] = 'Goal: x\nStatus: Complete | Phase: Idle\nGoal tokens used: 9\nElapsed: 7s';
    const goal = new GrokGoalSession(host);
    await goal.setGoal({ objective: 'x' });
    await host.end('', undefined);
    expect(host.locals).toEqual(['/goal status']);
    expect(goal.goal).toMatchObject({ status: 'complete', tokensUsed: 9 });
  });

  it('classifies a failed goal process', async () => {
    const host = new FakeHost();
    const goal = new GrokGoalSession(host);
    await goal.setGoal({ objective: 'x' });
    await host.fail('You’ve reached your free Grok Build usage limit for now.');
    expect(goal.goal?.status).toBe('usageLimited');
    await goal.setGoal({ status: 'active' });
    await host.fail('Not logged in. Run grok login.');
    expect(goal.goal?.status).toBe('blocked');
    await goal.setGoal({ status: 'active' });
    await host.fail('Timeout waiting for Grok response');
    expect(goal.goal?.status).toBe('paused');
  });

  it("pauses through grok's /goal pause, at once or once the process ends", async () => {
    const host = new FakeHost();
    host.grokConversationId = SID;
    const goal = new GrokGoalSession(host);
    await goal.setGoal({ objective: 'x' });
    await goal.setGoal({ status: 'paused' });
    expect(host.locals).toEqual([]);
    await host.end('', goalState('executing'));
    expect(host.locals).toEqual(['/goal pause']);
    expect(goal.goal?.status).toBe('paused');
    // Idle: at once.
    await goal.setGoal({ status: 'active' });
    await host.end('', goalState('userpaused'));
    await goal.setGoal({ status: 'paused' });
    expect(host.locals.at(-1)).toBe('/goal pause');
  });

  it('clears, steers nothing into a running process, and interrupts it', async () => {
    const host = new FakeHost();
    host.grokConversationId = SID;
    const goal = new GrokGoalSession(host);
    expect(await goal.interrupt()).toEqual({ interrupted: false });
    await goal.setGoal({ objective: 'x' });
    expect(await goal.steer('also y')).toEqual({ steered: false });
    expect(await goal.interrupt()).toEqual({ interrupted: true });
    expect(host.interrupted).toBe(1);
    await goal.clearGoal();
    expect(goal.goal).toBeNull();
    await host.end('', goalState('executing'));
    // Cleared while the process ran: grok's goal is cleared once it ends, and the turn reports nothing.
    expect(host.locals).toEqual(['/goal clear']);
    expect(goal.goal).toBeNull();
  });

  it("picks up a reopened conversation's goal from grok's state", async () => {
    const host = new FakeHost();
    host.grokConversationId = SID;
    host.state = goalState('infrapaused');
    const goal = new GrokGoalSession(host, { threadId: SID, resumed: true, objective: 'write hello.txt' });
    expect(await goal.getGoal()).toMatchObject({ objective: 'write hello.txt', status: 'paused' });
    host.state = goalState('complete');
    const done = new GrokGoalSession(host, { threadId: SID, resumed: true });
    expect((await done.getGoal())?.status).toBe('complete');
  });

  it('blocks a resumed conversation that comes back as another', async () => {
    const host = new FakeHost();
    const goal = new GrokGoalSession(host, { threadId: 'old-id', resumed: true, objective: 'x' });
    await goal.setGoal({ status: 'active' });
    expect(host.turns).toEqual(['/goal resume']);
    await host.end('', goalState('complete'), 'new-id');
    expect(goal.goal?.status).toBe('blocked');
  });

  it('builds the goal command', () => {
    expect(grokGoalCommand('  do x  ')).toBe('/goal do x');
    expect(grokGoalCommand('do x', 1234.7)).toBe('/goal do x --budget 1234');
    expect(grokGoalCommand('do x', null)).toBe('/goal do x');
  });

  it('is what the wrapper offers as its native goal loop', async () => {
    const s = await started();
    expect(s.nativeGoalSession()).toBeInstanceOf(GrokGoalSession);
  });
});

// ─── Quota and the ACP client ───────────────────────────────────────────────

describe('grok quota', () => {
  let dir: string;
  let log: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-log-'));
    log = path.join(dir, 'unified.jsonl');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
  const refusalLine = (minutesAgo: number, sid = 's1') =>
    JSON.stringify({
      ts: at(minutesAgo),
      sid,
      msg: 'shell.turn.inference_failed',
      ctx: {
        kind: 'rate_limited',
        status_code: 429,
        message:
          "API error (status 429 Too Many Requests): subscription:free-usage-exhausted: You've used all the included free usage for model grok-4.7 for now. Usage resets over a rolling 24-hour window — tokens (actual/limit): 601197/600000.",
      },
    });
  const doneLine = (minutesAgo: number, sid = 's1') =>
    JSON.stringify({ ts: at(minutesAgo), sid, msg: 'shell.turn.inference_done', ctx: {} });

  it('reads the last refusal and its rolling-window counts', () => {
    fs.writeFileSync(log, [doneLine(30), 'not json', refusalLine(10), ''].join('\n'));
    expect(latestGrokRefusal({ logFile: log })).toMatchObject({
      used: 601197,
      limit: 600000,
      rolling24h: true,
      sessionId: 's1',
    });
  });

  it('reports nothing once a model call succeeded after the refusal, or outside the window', () => {
    fs.writeFileSync(log, [refusalLine(10), doneLine(5)].join('\n'));
    expect(latestGrokRefusal({ logFile: log })).toBeUndefined();
    fs.writeFileSync(log, refusalLine(25 * 60));
    expect(latestGrokRefusal({ logFile: log })).toBeUndefined();
    fs.writeFileSync(log, [refusalLine(10, 's2')].join('\n'));
    expect(latestGrokRefusal({ logFile: log, sessionId: 's1' })).toBeUndefined();
    expect(latestGrokRefusal({ logFile: log, sinceMs: Date.now() - 60_000 })).toBeUndefined();
    expect(latestGrokRefusal({ logFile: path.join(dir, 'missing.jsonl') })).toBeUndefined();
  });

  it('builds the quota from the plan and the refusal', () => {
    const billing = {
      config: {
        currentPeriod: {
          type: 'USAGE_PERIOD_TYPE_WEEKLY',
          start: '2026-11-22T00:00:00+00:00',
          end: '2026-11-29T00:00:00+00:00',
        },
        onDemandCap: { val: 0 },
        onDemandUsed: { val: 0 },
      },
      subscription_tier: 'Free',
    };
    const q = grokQuotaFrom(billing, {
      at: 'x',
      message: 'm',
      used: 601197,
      limit: 600000,
      rolling24h: true,
    });
    expect(q).toMatchObject({ engine: 'grok', plan: 'Free', source: expect.stringMatching(/_x.ai\/billing/) });
    expect(q.windows).toEqual([{ name: 'rolling 24h', usedPercent: 100.2, remainingPercent: 0 }]);
    const paid = grokQuotaFrom(
      { ...billing, config: { ...billing.config, onDemandCap: { val: 2000 }, onDemandUsed: { val: 500 } } },
      undefined,
    );
    expect(paid.windows).toEqual([
      { name: 'on-demand', usedPercent: 25, remainingPercent: 75, resetsAt: '2026-11-29T00:00:00.000Z' },
    ]);
  });

  it('reads the plan over ACP with no session', async () => {
    vi.stubEnv('GROK_HOME', dir);
    const procs: FakeProc[] = [];
    mockSpawn.mockImplementation((_b: string, args: string[]) => {
      const p = fakeProc(args);
      procs.push(p);
      acpAgent(p, (m) =>
        m === '_x.ai/billing' ? { result: { subscription_tier: 'Free' } } : { error: { message: 'x' } },
      );
      return p;
    });
    const q = await readGrokQuota({ cwd: dir });
    expect(q).toMatchObject({ engine: 'grok', plan: 'Free', windows: [] });
    expect(procs[0].args).toEqual(['agent', 'stdio']);
    vi.unstubAllEnvs();
  });

  it('fails when neither the plan nor a refusal can be read', async () => {
    vi.stubEnv('GROK_HOME', dir);
    mockSpawn.mockImplementation((_b: string, args: string[]) => {
      const p = fakeProc(args);
      setTimeout(() => p.emit('close', 1), 1);
      return p;
    });
    await expect(readGrokQuota()).rejects.toThrow(/exited \(code 1\) before answering _x.ai\/billing/);
    vi.unstubAllEnvs();
  });
});

describe('grokAcpCall', () => {
  it('initializes, calls the method, skips notifications and kills the agent', async () => {
    const p = fakeProc(['agent', 'stdio']);
    mockSpawn.mockReturnValue(p);
    acpAgent(p, () => ({ result: { ok: 1 } }));
    expect(await grokAcpCall('_x.ai/commands/list', {}, { bin: 'grok-bin', cwd: '/w' })).toEqual({ ok: 1 });
    expect(mockSpawn.mock.calls[0][0]).toBe('grok-bin');
    expect(mockSpawn.mock.calls[0][2]).toMatchObject({ cwd: '/w' });
    expect(mockKillTree).toHaveBeenCalledWith(p);
  });

  it("rejects with the agent's error", async () => {
    const p = fakeProc(['agent', 'stdio']);
    mockSpawn.mockReturnValue(p);
    acpAgent(p, () => ({ error: { code: -32602, message: 'Invalid params', data: 'missing field `sessionId`' } }));
    await expect(grokAcpCall('_x.ai/workflows/list')).rejects.toThrow(
      /refused _x.ai\/workflows\/list: Invalid params: missing field `sessionId`/,
    );
  });

  it('gives up on an agent that does not answer', async () => {
    const p = fakeProc(['agent', 'stdio']);
    mockSpawn.mockReturnValue(p);
    await expect(grokAcpCall('_x.ai/billing', {}, { timeoutMs: 20 })).rejects.toThrow(/did not answer/);
    expect(mockKillTree).toHaveBeenCalledWith(p);
  });
});
