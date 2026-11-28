/**
 * PersistentAgySession's print-mode command surface: info commands that answer
 * without a turn, `/compact` judged by its summary pass, orchestrator models,
 * per-send models, `/plan`, turn commands, the command head kept first, the
 * conversation's running usage, and the spend of the agents a turn starts.
 * Stream shapes are agy 1.5.18–1.5.19's (captured).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const mockSpawn = vi.fn();
vi.mock('../engine-spawn.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../engine-spawn.js')>()),
  spawnEngine: (...args: unknown[]) => mockSpawn(...args),
  killEngineTree: vi.fn(),
}));

const { PersistentAgySession, agyPrefixPrompt, AGY_READ_ONLY_NOTE } = await import('../persistent-agy-session.js');
type Session = InstanceType<typeof PersistentAgySession>;

const CONV = '7f861d2c-e074-4c04-a581-a648fa4d43c8';

function mockProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: Readable;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
    pid: number;
    exitCode: null;
  };
  proc.stdout = new Readable({ read() {} });
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn();
  proc.pid = 4242;
  proc.exitCode = null;
  return proc;
}

/** Each spawn plays the next script: stream lines, then an exit code. */
function script(...runs: Array<{ lines: unknown[]; code?: number; stderr?: string }>) {
  const queue = [...runs];
  mockSpawn.mockImplementation(() => {
    const proc = mockProcess();
    const run = queue.shift() ?? { lines: [], code: 0 };
    setTimeout(() => {
      for (const l of run.lines) proc.stdout.push(`${typeof l === 'string' ? l : JSON.stringify(l)}\n`);
      if (run.stderr) proc.stderr.emit('data', Buffer.from(run.stderr));
      proc.stdout.push(null);
      proc.emit('close', run.code ?? 0);
    }, 5);
    return proc;
  });
}

const zero = { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 };
const init = (extra: Record<string, unknown> = {}) => ({
  event: 'init',
  conversation_id: CONV,
  init: { model: 'gemini-3.8-flash', ...extra },
});
const step = (index: number, type: string, usage?: Record<string, number>, extra: Record<string, unknown> = {}) => ({
  event: 'step_update',
  step_update: {
    conversation_id: CONV,
    step_index: index,
    state: 'DONE',
    step_type: type,
    ...(usage ? { usage } : {}),
    ...extra,
  },
});
const result = (response: string, usage: Record<string, number>, extra: Record<string, unknown> = {}) => ({
  event: 'result',
  result: { conversation_id: CONV, status: 'SUCCESS', response, num_turns: 1, usage, ...extra },
});
/** A plain model turn: one request. */
const turn = (text: string, usage = { input_tokens: 22_000, output_tokens: 5, cache_read_tokens: 0 }) => ({
  lines: [init(), step(0, 'user_input'), step(1, 'agent_response', usage), result(text, usage)],
});

function argsOf(call: number): string[] {
  return mockSpawn.mock.calls[call][1] as string[];
}

async function started(config: Record<string, unknown> = {}): Promise<Session> {
  const s = new PersistentAgySession({ name: 't', cwd: os.tmpdir(), model: 'gemini-3.8-flash', ...config } as never);
  await s.start();
  return s;
}

beforeEach(() => {
  mockSpawn.mockReset();
});

describe('info commands', () => {
  const help = { name: 'help', data: { commands: [{ name: 'usage', description: 'View model quota usage' }] } };

  it('answer without a turn: localCommand, the structured data, the counters and context untouched', async () => {
    const s = await started();
    script(turn('OK'), {
      lines: [
        { event: 'command_result', command: help },
        {
          event: 'result',
          result: {
            conversation_id: '',
            status: 'SUCCESS',
            response: '/usage\tView\n',
            num_turns: 0,
            usage: zero,
            command: help,
          },
        },
      ],
    });
    await s.send('hello', { waitForComplete: true });
    const before = s.getStats();
    const logs: string[] = [];
    s.on('log', (m: unknown) => logs.push(String(m)));
    const r = (await s.send('/help', { waitForComplete: true })) as {
      text: string;
      event: Record<string, unknown>;
      localCommand?: boolean;
    };
    expect(r.localCommand).toBe(true);
    expect(r.text).toBe('/usage\tView');
    expect(r.event.command).toEqual(help);
    const after = s.getStats();
    expect([after.turns, after.turnsSucceeded, after.tokensIn]).toEqual([
      before.turns,
      before.turnsSucceeded,
      before.tokensIn,
    ]);
    expect(after.contextPercent).toBe(before.contextPercent);
    expect(s.conversationId).toBe(CONV);
    expect(logs.join('\n')).not.toMatch(/no conversation ID/);
  });

  it('an empty answer (no agents) is an answer, not an empty-response failure', async () => {
    const s = await started();
    const agents = { name: 'agents', data: { agents: [] } };
    script({
      lines: [
        { event: 'command_result', command: agents },
        {
          event: 'result',
          result: { conversation_id: '', status: 'SUCCESS', response: '', num_turns: 0, usage: zero, command: agents },
        },
      ],
    });
    const r = (await s.send('/agents', { waitForComplete: true })) as { text: string; localCommand?: boolean };
    expect(r).toMatchObject({ text: '', localCommand: true });
    expect(s.getStats().turns).toBe(0);
  });

  it('a command agy refuses at no cost (/btw) is an error answer, not a failed turn', async () => {
    const s = await started();
    const error = '/btw is not available in print mode (a one-shot run has no in-flight turn to interject into)';
    script({
      lines: [
        {
          event: 'result',
          result: {
            conversation_id: '',
            status: 'ERROR',
            response: '',
            error,
            num_turns: 0,
            usage: zero,
            finished_reason: 'error',
          },
        },
      ],
      code: 1,
    });
    const r = (await s.send('/btw what was it?', { waitForComplete: true })) as {
      text: string;
      event: Record<string, unknown>;
      localCommand?: boolean;
    };
    expect(r.localCommand).toBe(true);
    expect(r.event).toMatchObject({ is_error: true, stop_reason: 'error' });
    expect(r.text).toBe(error);
    expect(s.getStats()).toMatchObject({ turns: 0, turnsSucceeded: 0 });
  });

  it('with disableSlashCommands a leading /word is a message, and a turn', async () => {
    const s = await started({ disableSlashCommands: true });
    script(turn('LITERAL'));
    const r = (await s.send('/help is what I typed', { waitForComplete: true })) as { localCommand?: boolean };
    expect(r.localCommand).toBeUndefined();
    expect(argsOf(0)).toContain('--disable-slash-commands');
    expect(s.getStats().turnsSucceeded).toBe(1);
  });
});

describe('runCommand and listCommands', () => {
  it('runs an info command as a process of its own: no log file, no conversation, the data returned', async () => {
    const s = await started({ resumeSessionId: CONV, effort: 'low' });
    const usage = { name: 'usage', data: { groups: [] } };
    script({
      lines: [
        { event: 'command_result', command: usage },
        {
          event: 'result',
          result: {
            conversation_id: '',
            status: 'SUCCESS',
            response: 'Gemini\t80%\n',
            num_turns: 0,
            usage: zero,
            command: usage,
          },
        },
      ],
    });
    const out = await s.runCommand('usage');
    expect(out).toEqual({ name: 'usage', ok: true, text: 'Gemini\t80%', data: { groups: [] }, startedTurn: false });
    const args = argsOf(0);
    expect(args.slice(0, 2)).toEqual(['-p', '/usage']);
    expect(args).not.toContain('--log-file');
    expect(args).not.toContain('--conversation');
    // /model and /effort report the session's own flags.
    expect(args).toEqual(expect.arrayContaining(['--model', 'gemini-3.8-flash', '--effort', 'low']));
  });

  it('lists /plugin as `/plugin list`; a refusal is not ok', async () => {
    const s = await started();
    script(
      {
        lines: [
          { event: 'command_result', command: { name: 'plugin', data: { plugins: [] } } },
          result('', zero, { num_turns: 0, conversation_id: '' }),
        ],
      },
      {
        lines: [
          {
            event: 'result',
            result: {
              conversation_id: '',
              status: 'ERROR',
              response: '',
              error: '/skills takes no arguments, got "list"',
              num_turns: 0,
              usage: zero,
            },
          },
        ],
        code: 1,
      },
    );
    await s.runCommand('plugin');
    expect(argsOf(0)[1]).toBe('/plugin list');
    const bad = await s.runCommand('skills', 'list');
    expect(bad).toMatchObject({ ok: false, startedTurn: false, error: '/skills takes no arguments, got "list"' });
  });

  it('runs a turn command with slash commands on for it, /teamwork with [skip-interview]', async () => {
    const s = await started({ disableSlashCommands: true });
    script(turn('team done'));
    const out = await s.runCommand('teamwork', 'Create hello.txt');
    expect(out).toMatchObject({ name: 'teamwork', ok: true, text: 'team done', startedTurn: true });
    const args = argsOf(0);
    expect(args[1]).toBe('/teamwork [skip-interview] Create hello.txt');
    expect(args).not.toContain('--disable-slash-commands');
  });

  it('lists info commands, system commands and skills, once', async () => {
    const s = await started();
    const help = { name: 'help', data: { commands: [{ name: 'help' }, { name: 'usage', aliases: ['quota'] }] } };
    const skills = {
      name: 'skills',
      data: {
        skills: [
          { name: 'echo-word', description: 'Echo', path: '/ws/.agents/skills/echo-word/SKILL.md', builtin: false },
          {
            name: 'swarm',
            description: 'Swarm',
            path: '/x/antigravity-cli/builtin/plugins/swarm/skills/swarm/SKILL.md',
            builtin: true,
          },
          { name: 'goal', description: 'shadowed by the system command' },
        ],
      },
    };
    script(
      { lines: [{ event: 'command_result', command: help }, result('', zero, { num_turns: 0, conversation_id: '' })] },
      {
        lines: [{ event: 'command_result', command: skills }, result('', zero, { num_turns: 0, conversation_id: '' })],
      },
    );
    const list = await s.listCommands();
    const byName = new Map(list.map((c) => [c.name, c]));
    expect(byName.get('usage')).toMatchObject({ startsTurn: false, source: 'builtin' });
    expect(byName.get('goal')).toMatchObject({ startsTurn: true, source: 'builtin' });
    expect(byName.get('grill-me')).toMatchObject({ needsHuman: true });
    expect(byName.get('echo-word')).toMatchObject({ source: 'skill', startsTurn: true });
    expect(byName.get('swarm')).toMatchObject({ source: 'plugin' });
    expect(list.filter((c) => c.name === 'goal')).toHaveLength(1);
    await s.listCommands();
    expect(mockSpawn).toHaveBeenCalledTimes(2);
  });

  it('refuses a name agy lists no command for, after reading the listing again, with no turn', async () => {
    const s = await started();
    const help = { name: 'help', data: { commands: [{ name: 'help' }] } };
    const skills = { name: 'skills', data: { skills: [{ name: 'echo-word', description: 'Echo' }] } };
    const answers = () => [
      { lines: [{ event: 'command_result', command: help }, result('', zero, { num_turns: 0, conversation_id: '' })] },
      {
        lines: [{ event: 'command_result', command: skills }, result('', zero, { num_turns: 0, conversation_id: '' })],
      },
    ];
    script(...answers(), ...answers());
    await expect(s.runCommand('model-switcher')).rejects.toThrow(/there is no command \/model-switcher/);
    // Two listings (the cached one, then a fresh read), and no turn.
    expect(mockSpawn).toHaveBeenCalledTimes(4);
    expect(mockSpawn.mock.calls.every((c) => !(c[1] as string[]).includes('/model-switcher'))).toBe(true);
  });

  it('applyTurnCommand: the command in front, [skip-interview] once', async () => {
    const s = await started();
    expect(s.applyTurnCommand('boost', 'do it')).toBe('/boost do it');
    expect(s.applyTurnCommand('teamwork', 'do it')).toBe('/teamwork [skip-interview] do it');
    expect(s.applyTurnCommand('teamwork [skip-interview]', 'do it')).toBe('/teamwork [skip-interview] do it');
    expect(s.applyTurnCommand('teamwork', '[skip-interview] do it')).toBe('/teamwork [skip-interview] do it');
  });

  it('refuses turnCommand with disableSlashCommands', () => {
    expect(
      () =>
        new PersistentAgySession({
          name: 't',
          cwd: '/tmp',
          turnCommand: '/boost',
          disableSlashCommands: true,
        } as never),
    ).toThrow(/turnCommand needs agy to read slash commands/);
  });
});

describe('compaction', () => {
  it('waits for /compact and judges it by its summary pass; not a turn; the context drops', async () => {
    const s = await started({ resumeSessionId: CONV, disableSlashCommands: true });
    const big = { input_tokens: 2_000, output_tokens: 10, cache_read_tokens: 300_000 };
    const checkpoint = { input_tokens: 3_094, output_tokens: 332, cache_read_tokens: 21_753 };
    script(turn('OK', big), {
      lines: [
        init({ expanded_commands: [{ name: 'compact', type: 'system' }] }),
        step(8, 'user_input'),
        step(10, 'checkpoint', checkpoint),
        result('', { input_tokens: 99_000, output_tokens: 999, cache_read_tokens: 99_000 }, { num_turns: 4 }),
      ],
      stderr: 'warning: run ended with no output and no recorded error\n',
    });
    await s.send('hello', { waitForComplete: true });
    expect(s.getStats().contextPercent).toBe(30);
    const before = s.getStats();
    const outcome = await s.compactDetailed('focus on the API');
    expect(outcome).toMatchObject({ ok: true, trigger: 'manual', preTokens: 24_847, postTokens: 22_085 });
    expect(outcome.note).toMatch(/takes no instructions/);
    const args = argsOf(1);
    expect(args[1]).toBe('/compact');
    expect(args).not.toContain('--disable-slash-commands');
    const after = s.getStats();
    expect([after.turns, after.turnsSucceeded]).toEqual([before.turns, before.turnsSucceeded]);
    // The summary pass is billed (from its step, not the conversation's running total).
    expect(after.tokensIn - before.tokensIn).toBe(3_094);
    expect(after.contextPercent).toBe(2);
  });

  it('a /compact that ran no summary pass did not compact', async () => {
    const s = await started({ resumeSessionId: CONV });
    script({ lines: [init(), result('', zero, { num_turns: 2 })] });
    const outcome = await s.compactDetailed();
    expect(outcome.ok).toBe(false);
    expect(outcome.note).toMatch(/no summary pass/);
  });
});

describe('usage', () => {
  it("bills a resumed turn from its own steps, not the conversation's running total", async () => {
    const s = await started({ resumeSessionId: CONV });
    const own = { input_tokens: 2_243, output_tokens: 1, cache_read_tokens: 33_789 };
    script({
      lines: [
        init(),
        step(64, 'agent_response', own),
        result('OK', { input_tokens: 178_629, output_tokens: 2_634, cache_read_tokens: 559_233 }, { num_turns: 7 }),
      ],
    });
    await s.send('Reply with just OK.', { waitForComplete: true });
    expect(s.getStats()).toMatchObject({ tokensIn: 2_243, tokensOut: 1, cachedTokens: 33_789 });
  });

  it('without step usage, a later result counts from the one before', async () => {
    const s = await started();
    script(
      { lines: [init(), result('one', { input_tokens: 1_000, output_tokens: 10, cache_read_tokens: 0 })] },
      {
        lines: [
          init(),
          result('two', { input_tokens: 1_500, output_tokens: 15, cache_read_tokens: 400 }, { num_turns: 2 }),
        ],
      },
    );
    await s.send('a', { waitForComplete: true });
    await s.send('b', { waitForComplete: true });
    expect(s.getStats()).toMatchObject({ tokensIn: 1_500, tokensOut: 15, cachedTokens: 400 });
  });

  it('counts a cut run from its steps', async () => {
    const s = await started({ resumeSessionId: CONV });
    script({
      lines: [init(), step(1, 'agent_response', { input_tokens: 24_000, output_tokens: 100, cache_read_tokens: 0 })],
      code: 143,
    });
    await expect(s.send('work', { waitForComplete: true })).rejects.toThrow();
    expect(s.getStats().tokensIn).toBe(24_000);
  });

  it('prices a session without a model at the model agy reported', async () => {
    const s = new PersistentAgySession({ name: 't', cwd: '/tmp' } as never);
    await s.start();
    const usage = { input_tokens: 1_000_000, output_tokens: 0, cache_read_tokens: 0 };
    script({
      lines: [
        { ...init(), init: { model: 'gemini-4-neon-medium' } },
        step(1, 'agent_response', usage),
        result('OK', usage),
      ],
    });
    await s.send('hi', { waitForComplete: true });
    expect(s.getStats().costUsd).toBeCloseTo(3, 6);
    expect(s.getCost().model).toBe('gemini-4-neon-medium');
  });
});

describe('models', () => {
  it('passes no --effort for an orchestrator model, and says so once', async () => {
    const s = await started({ model: 'gemini-pro-orchestrator-argon', effort: 'high' });
    const logs: string[] = [];
    s.on('log', (m: unknown) => logs.push(String(m)));
    script(turn('OK'), turn('OK'));
    await s.send('a', { waitForComplete: true });
    await s.send('b', { waitForComplete: true });
    expect(argsOf(0)).toEqual(expect.arrayContaining(['--model', 'gemini-pro-orchestrator-argon']));
    expect(argsOf(0)).not.toContain('--effort');
    expect(logs.filter((l) => /takes no reasoning effort/.test(l))).toHaveLength(1);
  });

  it('runs one send on another model and prices it there; the next send is back on the session model', async () => {
    const s = await started({ effort: 'low' });
    expect(s.perSendModel).toBe(true);
    const usage = { input_tokens: 1_000_000, output_tokens: 0, cache_read_tokens: 0 };
    script(
      { lines: [init(), step(1, 'agent_response', usage), result('OK', usage)] },
      { lines: [init(), step(3, 'agent_response', usage), result('OK', usage, { num_turns: 2 })] },
    );
    await s.send('a', { waitForComplete: true, model: 'gemini-4-hydrogen-low' });
    expect(argsOf(0)).toEqual(expect.arrayContaining(['--model', 'gemini-4-hydrogen-low']));
    expect(s.getStats().costUsd).toBeCloseTo(1.5, 6);
    await s.send('b', { waitForComplete: true });
    expect(argsOf(1)).toEqual(expect.arrayContaining(['--model', 'gemini-3.8-flash']));
    expect(s.getStats().costUsd).toBeCloseTo(1.5 + 0.75, 6);
  });

  it('switches model and effort in place', async () => {
    const s = await started();
    expect(await s.setModelLive('gemini-4-argon')).toBe(true);
    expect(await s.setEffortLive('high')).toBe(true);
    script(turn('OK'));
    await s.send('a', { waitForComplete: true });
    expect(argsOf(0)).toEqual(expect.arrayContaining(['--model', 'gemini-4-argon']));
  });
});

describe('the command head stays first', () => {
  it('puts the read-only note after the command, and none on an info command', () => {
    expect(agyPrefixPrompt('/goal Read notes.txt', AGY_READ_ONLY_NOTE, true)).toBe(
      `/goal ${AGY_READ_ONLY_NOTE}\n\nRead notes.txt`,
    );
    expect(agyPrefixPrompt('/teamwork [skip-interview] Build it', 'NOTE', true)).toBe(
      '/teamwork [skip-interview] NOTE\n\nBuild it',
    );
    expect(agyPrefixPrompt('/usage', 'NOTE', true)).toBe('/usage');
    expect(agyPrefixPrompt('/compact', 'NOTE', true)).toBe('/compact');
    expect(agyPrefixPrompt('/Users/x/file.ts is broken', 'NOTE', true)).toBe('NOTE\n\n/Users/x/file.ts is broken');
    expect(agyPrefixPrompt('/goal x', 'NOTE', false)).toBe('NOTE\n\n/goal x');
  });

  it('puts appendSystemPrompt after the command of a first message', async () => {
    const s = await started({ appendSystemPrompt: 'Be brief.' });
    script(turn('OK'));
    await s.send('/goal Do the thing', { waitForComplete: true });
    expect(argsOf(0)[1]).toBe('/goal Be brief.\n\n---\n\nDo the thing');
  });

  it('warns once when a /word reached the model as text', async () => {
    const s = await started();
    const logs: string[] = [];
    s.on('log', (m: unknown) => logs.push(String(m)));
    script(turn('a theme?'), turn('again'));
    await s.send('/theme dark', { waitForComplete: true });
    await s.send('/theme light', { waitForComplete: true });
    expect(logs.filter((l) => /\/theme is not an agy command/.test(l))).toHaveLength(1);
  });
});

describe('plan', () => {
  let home: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-plan-'));
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  it('sends /plan and answers with the plan agy wrote', async () => {
    const planFile = path.join(home, 'brain', CONV, 'plan.md');
    fs.mkdirSync(path.dirname(planFile), { recursive: true });
    fs.writeFileSync(planFile, '# Plan\n\n1. Create p.txt\n');
    const s = await started({ sandboxMode: 'read-only' });
    const usage = { input_tokens: 23_000, output_tokens: 400, cache_read_tokens: 0 };
    const write = { tool_name: 'write_file', tool_info: { name: 'write_file', parameters: { Path: planFile } } };
    script({
      lines: [
        init({ expanded_commands: [{ name: 'plan', type: 'system' }] }),
        step(1, 'agent_response', usage),
        step(3, 'tool', undefined, write),
        result(`The plan is in [plan.md](file://${planFile}); approve it to proceed.`, usage),
      ],
    });
    const r = (await s.send('Create p.txt containing hi.', { waitForComplete: true, plan: true })) as {
      text: string;
      event: Record<string, unknown>;
    };
    expect(argsOf(0)[1]).toBe(`/plan ${AGY_READ_ONLY_NOTE}\n\nCreate p.txt containing hi.`);
    expect(r.text).toBe('# Plan\n\n1. Create p.txt');
    expect(r.event.plan).toEqual({ path: planFile, text: '# Plan\n\n1. Create p.txt\n' });
  });
});

describe('member spend', () => {
  let home: string;
  const MEMBER = '74ec30b9-fd58-49ba-b6b0-6eb2b6674ce2';
  const WORKER = '5bee73a6-0c13-4cc3-b0c6-422210c1f44b';
  const transcript = (id: string, lines: unknown[]) => {
    const file = path.join(
      home,
      '.gemini',
      'antigravity-cli',
      'brain',
      id,
      '.system_generated',
      'logs',
      'transcript.jsonl',
    );
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    return file;
  };
  const request = (step_index: number, model: string, input: number, cache: number, output: number) => ({
    step_index,
    source: 'MODEL',
    type: 'PLANNER_RESPONSE',
    model,
    input_tokens: input,
    cache_read_tokens: cache,
    output_tokens: output,
  });
  let savedHome: string | undefined;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-members-'));
    savedHome = process.env.HOME;
    process.env.HOME = home;
  });
  afterEach(() => {
    process.env.HOME = savedHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("adds the members' spend, each request at its own model, once", async () => {
    const coordinator = transcript(MEMBER, [
      request(1, 'gemini-4-hydrogen-tiered-high', 1_000_000, 0, 0),
      {
        step_index: 2,
        source: 'MODEL',
        type: 'GENERIC',
        content: `Created the following subagent:\n{\n  "conversationId": "${WORKER}"\n}`,
      },
    ]);
    transcript(WORKER, [request(1, 'gemini-3.8-flash-low', 1_000_000, 0, 0)]);
    const s = await started({ resumeSessionId: CONV });
    const usage = { input_tokens: 30_000, output_tokens: 300, cache_read_tokens: 0 };
    const delegation = {
      tool_name: 'invoke_subagent',
      subagent_info: { subagents: [{ conversation_id: MEMBER, log_uri: `file://${coordinator}` }] },
    };
    script(
      {
        lines: [
          init({ expanded_commands: [{ name: 'teamwork', type: 'system' }] }),
          step(1, 'agent_response', usage),
          step(2, 'subagent', undefined, delegation),
          result('Team done', usage),
        ],
      },
      turn('OK', { input_tokens: 1_000, output_tokens: 1, cache_read_tokens: 0 }),
    );
    const r = (await s.send('/teamwork [skip-interview] go', { waitForComplete: true })) as {
      event: Record<string, unknown>;
    };
    expect(r.event.member_usage).toMatchObject({ conversations: 2, tokensIn: 2_000_000 });
    const stats = s.getStats();
    expect(stats.tokensIn).toBe(2_030_000);
    // 1M at Hydrogen's $1.5, 1M at Flash's $0.75, the parent's own 30K + 300 at Flash.
    expect(stats.costUsd).toBeCloseTo(1.5 + 0.75 + 0.0225 + 0.001125, 4);
    await s.send('next', { waitForComplete: true });
    expect(s.getStats().tokensIn).toBe(2_031_000);
  });
});
