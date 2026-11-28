/**
 * The Claude Code session's engine capabilities: results the CLI answers itself,
 * turns it starts itself, settings changed per send and in place, and the
 * control requests behind compaction, side questions, rewinds, the context
 * breakdown, commands and quota.
 *
 * Event shapes are those Claude Code 2.1.332 emits on stream-json (captured in
 * a scratch directory with the same spawn clawo uses), trimmed to the fields
 * the wrapper reads.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { SessionConfig, TurnResult } from '../types.js';

function createMockStream() {
  const stream = new EventEmitter() as EventEmitter &
    Record<'resume' | 'pause' | 'setEncoding' | 'destroy', () => void>;
  stream.resume = vi.fn();
  stream.pause = vi.fn();
  stream.setEncoding = vi.fn();
  stream.destroy = vi.fn();
  return stream;
}

type Reply = { response?: unknown; error?: string } | null;

/** A `claude` process: answers control requests through `replies`, by subtype. */
class MockProcess extends EventEmitter {
  pid = 4321;
  killed = false;
  exitCode: number | null = null;
  stdout = createMockStream();
  stderr = createMockStream();
  unref = vi.fn();
  replies: Record<string, (req: Record<string, unknown>) => Reply> = {};
  written: Array<Record<string, unknown>> = [];
  stdin = {
    write: vi.fn((line: string) => {
      const msg = JSON.parse(String(line).trim()) as Record<string, unknown>;
      this.written.push(msg);
      if (msg.type === 'control_request') {
        const req = msg.request as Record<string, unknown>;
        const reply = this.replies[req.subtype as string]?.(req) ?? { response: null };
        if (reply === null) return true;
        const response = reply.error
          ? { subtype: 'error', request_id: msg.request_id, error: reply.error }
          : { subtype: 'success', request_id: msg.request_id, response: reply.response };
        queueMicrotask(() => this.emitLine({ type: 'control_response', response }));
      }
      return true;
    }),
    end: vi.fn(),
    on: vi.fn(),
    writable: true,
  };
  emitLine(event: unknown): void {
    this.stdout.emit('data', Buffer.from(JSON.stringify(event) + '\n'));
  }
  kill() {
    this.killed = true;
    this.emit('close', 143);
  }
  /** The control requests written, by subtype, in order. */
  controls(subtype?: string): Array<Record<string, unknown>> {
    return this.written
      .filter((m) => m.type === 'control_request')
      .map((m) => m.request as Record<string, unknown>)
      .filter((r) => !subtype || r.subtype === subtype);
  }
  /** The user messages written. */
  messages(): Array<{ uuid: string; text: string }> {
    return this.written
      .filter((m) => m.type === 'user')
      .map((m) => ({
        uuid: m.uuid as string,
        text: ((m.message as { content: Array<{ text?: string }> }).content.at(-1)?.text ?? '') as string,
      }));
  }
}

let proc: MockProcess;
vi.mock('../engine-spawn.js', () => ({
  spawnEngine: vi.fn(() => {
    proc = new MockProcess();
    return proc;
  }),
}));

const { PersistentClaudeSession } = await import('../persistent-session.js');
const { SESSION_EVENT } = await import('../constants.js');
const { readEngineQuota } = await import('../engine-quota.js');
const { getContextWindow } = await import('../models.js');
const { spawnEngine } = await import('../engine-spawn.js');

const flush = () => new Promise<void>((r) => setImmediate(r));

function config(overrides: Partial<SessionConfig> = {}): SessionConfig {
  return {
    name: 'c',
    cwd: '/tmp/clawo-claude-cap',
    permissionMode: 'acceptEdits',
    model: 'claude-sonnet-4-6',
    ...overrides,
  };
}

async function started(overrides: Partial<SessionConfig> = {}) {
  const session = new PersistentClaudeSession(config(overrides));
  const p = session.start();
  proc.emitLine({ type: 'system', subtype: 'init', session_id: 's1', slash_commands: ['compact'], skills: [] });
  await p;
  return session;
}

function spawnArgs(): string[] {
  return vi.mocked(spawnEngine).mock.calls.at(-1)![1] as string[];
}

/** A model turn's result for the message `uuid`. */
function turnResult(uuid: string, extra: Record<string, unknown> = {}) {
  return {
    type: 'result',
    subtype: 'success',
    result: 'ok',
    num_turns: 1,
    user_message_uuids: [uuid],
    usage: { input_tokens: 2, output_tokens: 3, cache_read_input_tokens: 40_000, cache_creation_input_tokens: 0 },
    model_usage_since_last_result: { 'claude-sonnet-4-6': { inputTokens: 2 } },
    ...extra,
  };
}

/** What a command the CLI answers itself ends with (2.1.332, `/usage`). */
function localResult(uuid: string, name: string, text: string, extra: Record<string, unknown> = {}) {
  return {
    type: 'result',
    subtype: 'success',
    result: text,
    num_turns: 0,
    local_command: name,
    user_message_uuids: [uuid],
    usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    model_usage_since_last_result: {},
    ...extra,
  };
}

/** Send and answer: the replay of the message, then `result(uuid)`. */
async function exchange(
  session: InstanceType<typeof PersistentClaudeSession>,
  text: string,
  result: (uuid: string) => unknown,
  options: Record<string, unknown> = {},
): Promise<TurnResult> {
  const reply = session.send(text, { waitForComplete: true, timeout: 5_000, ...options }) as Promise<TurnResult>;
  for (let i = 0; i < 5 && proc.messages().at(-1)?.text !== text; i++) await flush();
  const uuid = proc.messages().at(-1)!.uuid;
  proc.emitLine({ type: 'user', message: { role: 'user', content: text }, uuid, isReplay: true });
  proc.emitLine(result(uuid));
  return reply;
}

describe('PersistentClaudeSession engine capabilities', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('results the CLI answers itself', () => {
    let session: InstanceType<typeof PersistentClaudeSession>;
    beforeEach(async () => {
      session = await started();
      await exchange(session, 'work', (u) => turnResult(u));
    });

    it('keep the context size and are not turns', async () => {
      const before = session.getStats();
      expect(before.contextPercent).toBeGreaterThan(0);
      const reply = await exchange(session, '/usage', (u) => localResult(u, 'usage', 'Estimated cost: $0.01'));
      expect(reply).toMatchObject({ text: 'Estimated cost: $0.01', localCommand: true });
      const after = session.getStats();
      expect(after.contextPercent).toBe(before.contextPercent);
      expect(after.turnsSucceeded).toBe(before.turnsSucceeded);
      expect(after.turns).toBe(before.turns);
    });

    it('count a forked skill that ran a model as a turn, without taking its context', async () => {
      const before = session.getStats();
      const reply = await exchange(session, '/code-review low', (u) => {
        // The forked agent's request, from a real model, carries its own context.
        proc.emitLine({
          type: 'assistant',
          parent_tool_use_id: 'forked-command-code-review',
          message: {
            model: 'claude-sonnet-4-6',
            content: [],
            usage: { input_tokens: 5, cache_read_input_tokens: 90_000 },
          },
        });
        return localResult(u, 'code_review', 'calc.py:2 — important', {
          model_usage_since_last_result: { 'claude-sonnet-4-6': { costUSD: 0.24 } },
        });
      });
      expect(reply.localCommand).toBeUndefined();
      expect(session.getStats().turnsSucceeded).toBe(before.turnsSucceeded + 1);
      expect(session.getStats().contextPercent).toBe(before.contextPercent);
    });

    // Measured: a side question's spend shows in the next result's model usage.
    it('stay local after a side question, whose usage the next result reports', async () => {
      const before = session.getStats();
      const reply = await exchange(session, '/context', (u) =>
        localResult(u, 'context', '## Context Usage', {
          model_usage_since_last_result: { 'claude-sonnet-4-6': { costUSD: 0.006 } },
        }),
      );
      expect(reply.localCommand).toBe(true);
      expect(session.getStats().turnsSucceeded).toBe(before.turnsSucceeded);
    });

    it('take the context from a compaction, which is not a turn either', async () => {
      const reply = session.compactDetailed('keep the plan');
      await flush();
      const uuid = proc.messages().at(-1)!.uuid;
      expect(proc.messages().at(-1)!.text).toBe('/compact keep the plan');
      proc.emitLine({
        type: 'system',
        subtype: 'compact_boundary',
        compact_metadata: { trigger: 'manual', pre_tokens: 52_447, post_tokens: 10_886 },
      });
      proc.emitLine(localResult(uuid, 'compact', '', { model_usage_since_last_result: { m: { costUSD: 0.03 } } }));
      expect(await reply).toEqual({ ok: true, trigger: 'manual', preTokens: 52_447, postTokens: 10_886 });
      expect(session.getStats().contextPercent).toBe(
        Math.round((10_886 / getContextWindow('claude-sonnet-4-6')) * 100),
      );
      expect(session.getStats().turnsSucceeded).toBe(1);
      expect(session.getStats().compactions).toBe(1);
    });

    it('report a /compact that compacted nothing as not ok', async () => {
      const reply = session.compactDetailed();
      await flush();
      const uuid = proc.messages().at(-1)!.uuid;
      proc.emitLine(localResult(uuid, 'compact', 'Not enough messages to compact.'));
      expect(await reply).toEqual({ ok: false, trigger: 'manual', note: 'Not enough messages to compact.' });
    });

    it('take the start time from the first init only', async () => {
      const start = session.getStats().startTime;
      await new Promise((r) => setTimeout(r, 5));
      proc.emitLine({ type: 'system', subtype: 'init', session_id: 's1' });
      expect(session.getStats().startTime).toBe(start);
    });
  });

  describe('turns the CLI starts itself', () => {
    it('a /loop tick neither answers a waiting send nor counts as its success', async () => {
      const session = await started();
      const unsolicited: unknown[] = [];
      session.on(SESSION_EVENT.UNSOLICITED_RESULT, (e: unknown) => unsolicited.push(e));
      const waiting = session.send('next', { waitForComplete: true, timeout: 5_000 }) as Promise<TurnResult>;
      const own = proc.messages().at(-1)!.uuid;
      // The tick runs first: its start names no message of this session.
      proc.emitLine({ type: 'command_lifecycle', command_uuid: own, state: 'queued' });
      proc.emitLine({
        type: 'command_lifecycle',
        command_uuid: 'tick-1',
        state: 'started',
        wakeup_source: 'schedule_wakeup',
      });
      proc.emitLine({ type: 'system', subtype: 'init', session_id: 's1' });
      expect(session.turnRunning).toBe(true);
      proc.emitLine({ type: 'result', subtype: 'success', result: 'TICK', num_turns: 1, total_cost_usd: 0.01 });
      proc.emitLine({ type: 'command_lifecycle', command_uuid: 'tick-1', state: 'completed' });
      expect(unsolicited).toHaveLength(1);
      expect(session.turnRunning).toBe(true);
      proc.emitLine({ type: 'command_lifecycle', command_uuid: own, state: 'started' });
      proc.emitLine(turnResult(own, { result: 'reply' }));
      expect((await waiting).text).toBe('reply');
      expect(session.getStats().turnsSucceeded).toBe(1);
    });

    it('a result with no ids after a command of its own is still its reply', async () => {
      const session = await started();
      const waiting = session.send('hi', { waitForComplete: true, timeout: 5_000 }) as Promise<TurnResult>;
      const own = proc.messages().at(-1)!.uuid;
      proc.emitLine({ type: 'command_lifecycle', command_uuid: own, state: 'started' });
      proc.emitLine({ type: 'result', subtype: 'success', result: 'hello' });
      expect((await waiting).text).toBe('hello');
    });
  });

  describe('settings for one send', () => {
    it('sets the effort before the message and puts the session effort back after the turn', async () => {
      const session = await started({ effort: 'low' });
      expect(spawnArgs()).toEqual(expect.arrayContaining(['--effort', 'low']));
      await exchange(session, 'think hard', (u) => turnResult(u), { effort: 'ultra' });
      expect(proc.controls('apply_flag_settings').map((r) => r.settings)).toEqual([
        { effortLevel: 'max' },
        { effortLevel: 'low' },
      ]);
      // The session's own effort is in place: the next send changes nothing.
      const writes = proc.written.length;
      await session.send('plain');
      expect(proc.written.length).toBe(writes + 1);
    });

    it('clears the effort for auto, which the CLI would ignore', async () => {
      const session = await started({ effort: 'high' });
      expect(await session.setEffortLive('auto')).toBe(true);
      expect(proc.controls('apply_flag_settings').at(-1)).toEqual({
        subtype: 'apply_flag_settings',
        settings: { effortLevel: null },
      });
    });

    it('runs one turn on another model and switches back', async () => {
      const session = await started();
      await exchange(session, 'quick one', (u) => turnResult(u), { model: 'claude-haiku-4-5' });
      expect(proc.controls('set_model').map((r) => r.model)).toEqual(['claude-haiku-4-5', 'claude-sonnet-4-6']);
      expect(session.perSendModel).toBe(true);
    });

    it('refuses a model per send it cannot run, before writing anything', async () => {
      const session = await started();
      const writes = proc.written.length;
      await expect(session.send('x', { model: 'gpt-5.5' })).rejects.toThrow(/must be a Claude model/);
      expect(proc.written.length).toBe(writes);
    });

    it('fails the send when the CLI refuses the model, rather than answer on its own', async () => {
      const session = await started();
      proc.replies.set_model = () => ({ error: 'Unknown model' });
      await expect(session.send('x', { model: 'claude-opus-4-8' })).rejects.toThrow(/Unknown model/);
      expect(proc.messages()).toHaveLength(0);
    });
  });

  describe('switches in place', () => {
    it('switches the model with set_model and prices the new one', async () => {
      const session = await started();
      proc.replies.set_model = () => ({ response: { model: 'claude-opus-4-8' } });
      expect(await session.setModelLive('claude-opus-4-8')).toBe(true);
      expect(proc.controls('set_model')).toEqual([{ subtype: 'set_model', model: 'claude-opus-4-8' }]);
      expect(session.getCost().model).toBe('claude-opus-4-8');
    });

    it('leaves a switch to another provider to a restart', async () => {
      const session = await started();
      expect(await session.setModelLive('gpt-5.5')).toBe(false);
      expect(proc.controls('set_model')).toHaveLength(0);
    });
  });

  describe('control requests', () => {
    it('reads the context breakdown once per result', async () => {
      const session = await started();
      proc.replies.get_context_usage = () => ({
        response: {
          totalTokens: 35_760,
          maxTokens: 1_000_000,
          categories: [
            { name: 'System prompt', tokens: 2_693, kind: 'used' },
            { name: 'MCP tools (deferred)', tokens: 154_599, kind: 'deferred' },
            { name: 'Messages', tokens: 33_067, kind: 'used' },
            { name: 'Free space', tokens: 931_240, kind: 'free' },
          ],
        },
      });
      const breakdown = await session.contextBreakdown();
      expect(breakdown).toEqual({
        totalTokens: 35_760,
        windowTokens: 1_000_000,
        categories: [
          { name: 'System prompt', tokens: 2_693 },
          { name: 'Messages', tokens: 33_067 },
        ],
      });
      await session.contextBreakdown();
      expect(proc.controls('get_context_usage')).toHaveLength(1);
      await exchange(session, 'more', (u) => turnResult(u));
      await session.contextBreakdown();
      expect(proc.controls('get_context_usage')).toHaveLength(2);
    });

    it('answers a side question without a message', async () => {
      const session = await started();
      proc.replies.side_question = (req) => ({
        response: { response: `asked: ${String(req.question)}`, synthetic: false },
      });
      expect(await session.askAside('which file?')).toEqual({ text: 'asked: which file?' });
      expect(proc.messages()).toHaveLength(0);
    });

    it('rewinds by turns to the message that started the first of them, files checked first', async () => {
      const session = await started();
      await exchange(session, 'one', (u) => turnResult(u));
      await exchange(session, 'two', (u) => turnResult(u));
      await exchange(session, '/usage', (u) => localResult(u, 'usage', 'cost'));
      await exchange(session, 'three', (u) => turnResult(u));
      const [one, two, , three] = proc.messages();
      proc.replies.rewind_files = () => ({ response: { canRewind: true } });
      proc.replies.rewind_conversation = () => ({ response: { rewound: true } });
      proc.replies.get_context_usage = () => ({ response: { totalTokens: 20_000 } });
      // The local command is not a turn: two turns back is `two`.
      const outcome = await session.rewind({ turns: 2, files: true });
      expect(outcome).toEqual({ ok: true, turnsRemoved: 2, filesRestored: true });
      expect(proc.controls().filter((r) => String(r.subtype).startsWith('rewind'))).toEqual([
        { subtype: 'rewind_files', user_message_id: two.uuid, dry_run: true },
        { subtype: 'rewind_conversation', target_message_uuid: two.uuid },
        { subtype: 'rewind_files', user_message_id: two.uuid },
      ]);
      expect(three.uuid).not.toBe(two.uuid);
      // One turn is left to rewind.
      await expect(session.rewind({ turns: 2 })).rejects.toThrow(/only 1 turn/);
      expect(one.uuid).toBeTruthy();
    });

    it('refuses to restore files it has no checkpoint for, before rewinding anything', async () => {
      const session = await started();
      await exchange(session, 'one', (u) => turnResult(u));
      proc.replies.rewind_files = () => ({ response: { canRewind: false, error: 'File rewinding is not enabled.' } });
      await expect(session.rewind({ turns: 1, files: true })).rejects.toThrow(/File rewinding is not enabled/);
      expect(proc.controls('rewind_conversation')).toHaveLength(0);
    });

    it('stops asking for a control request the CLI does not support', async () => {
      const session = await started();
      proc.replies.side_question = () => ({ error: 'Unsupported control request subtype: side_question' });
      await expect(session.askAside('q')).rejects.toThrow(/Unsupported/);
      await expect(session.askAside('q')).rejects.toThrow(/does not support/);
      expect(proc.controls('side_question')).toHaveLength(1);
    });

    it('fails a control request in flight when the process ends', async () => {
      const session = await started();
      proc.replies.side_question = () => null;
      const pending = session.askAside('q');
      proc.emit('close', 1);
      await expect(pending).rejects.toThrow(/exited/);
    });
  });

  describe('commands', () => {
    const initialize = {
      commands: [
        { name: 'compact', description: 'Free up context', argumentHint: '<instructions>', builtin: true },
        { name: 'focus', description: 'Toggle focus view', builtin: true },
        { name: 'superpowers:brainstorming', description: '(superpowers) Use before creative work' },
        { name: 'shout', description: 'Shout the argument (project)' },
        { name: 'echoarg', description: 'Echo the argument', argumentHint: '<word>' },
        { name: '__remote-workflow', description: 'internal', builtin: true },
      ],
    };

    it('lists the CLI commands from initialize, and clawo control commands', async () => {
      const session = await started();
      proc.emitLine({
        type: 'system',
        subtype: 'init',
        session_id: 's1',
        skills: ['shout'],
        slash_commands: ['compact'],
      });
      proc.replies.initialize = () => ({ response: initialize });
      const list = await session.listCommands();
      const byName = Object.fromEntries(list.map((c) => [c.name, c]));
      expect(byName.compact).toEqual({
        name: 'compact',
        description: 'Free up context',
        source: 'builtin',
        args: '<instructions>',
        startsTurn: true,
      });
      expect(byName.focus.needsHuman).toBe(true);
      expect(byName['superpowers:brainstorming'].source).toBe('plugin');
      expect(byName.shout.source).toBe('skill');
      expect(byName.echoarg.source).toBe('custom');
      expect(byName['__remote-workflow']).toBeUndefined();
      expect(byName['mcp-status']).toMatchObject({ source: 'rpc', startsTurn: false });
      await session.listCommands();
      expect(proc.controls('initialize')).toHaveLength(1);
    });

    it('falls back to the init lists when initialize fails', async () => {
      const session = await started();
      proc.replies.initialize = () => ({ error: 'Already initialized' });
      const names = (await session.listCommands()).map((c) => c.name);
      expect(names).toContain('compact');
      expect(names).toContain('mcp-status');
    });

    it('runs a control command and leaves an MCP server config out', async () => {
      const session = await started();
      proc.replies.mcp_status = () => ({
        response: {
          mcpServers: [
            {
              name: 'docs',
              status: 'connected',
              scope: 'user',
              config: { env: { TOKEN: 'secret' } },
              tools: [{ name: 'q' }],
            },
            { name: 'db', status: 'failed', error: 'ECONNREFUSED' },
          ],
        },
      });
      const outcome = await session.runCommand('mcp-status');
      expect(outcome).toEqual({
        name: 'mcp-status',
        ok: true,
        text: 'docs: connected\ndb: failed (ECONNREFUSED)',
        data: [
          { name: 'docs', status: 'connected', scope: 'user', tools: ['q'] },
          { name: 'db', status: 'failed', error: 'ECONNREFUSED' },
        ],
        startedTurn: false,
      });
      expect(JSON.stringify(outcome)).not.toContain('secret');
      await session.runCommand('mcp-reconnect', 'db');
      expect(proc.controls('mcp_reconnect')).toEqual([{ subtype: 'mcp_reconnect', serverName: 'db' }]);
    });

    it('turns ultracode on live with the Workflow tool allowed', async () => {
      const session = await started();
      await session.runCommand('ultracode', 'on');
      expect(proc.controls('apply_flag_settings').at(-1)).toEqual({
        subtype: 'apply_flag_settings',
        settings: { ultracode: true, permissions: { allow: ['Workflow'] } },
      });
    });

    it('returns only the applied block of the settings, which can carry credentials', async () => {
      const session = await started();
      proc.replies.get_settings = () => ({
        response: { effective: { env: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-x' } }, applied: { effort: 'high' } },
      });
      const outcome = await session.runCommand('applied-settings');
      expect(outcome.data).toEqual({ effort: 'high' });
      expect(JSON.stringify(outcome)).not.toContain('sk-ant');
    });

    it('sends any other command as its message and says whether a turn ran', async () => {
      const session = await started();
      proc.replies.initialize = () => ({
        response: { commands: [{ name: 'context', builtin: true }, { name: 'echoarg' }] },
      });
      const local = session.runCommand('context');
      await flush();
      const m = proc.messages().at(-1)!;
      expect(m.text).toBe('/context');
      proc.emitLine(localResult(m.uuid, 'context', '## Context Usage'));
      expect(await local).toEqual({ name: 'context', ok: true, text: '## Context Usage', startedTurn: false });

      const skill = session.runCommand('echoarg', 'banana');
      await flush();
      const s = proc.messages().at(-1)!;
      expect(s.text).toBe('/echoarg banana');
      proc.emitLine(turnResult(s.uuid, { result: 'ECHO:banana' }));
      expect(await skill).toMatchObject({ ok: true, text: 'ECHO:banana', startedTurn: true });
    });

    // Measured: `/nosuchcmd` is not refused by the CLI; it reaches the model as a paid turn.
    it('refuses a name the CLI has no command for, and takes an alias', async () => {
      const session = await started();
      let commands = [{ name: 'code-review', aliases: ['review'], builtin: true }];
      proc.replies.initialize = () => ({ response: { commands } });
      await expect(session.runCommand('nosuchcmd')).rejects.toThrow(/no command \/nosuchcmd/);
      expect(proc.messages()).toHaveLength(0);
      // Asked again before refusing, so a command added since the last listing runs.
      const before = proc.controls('initialize').length;
      commands = [...commands, { name: 'fresh', aliases: [], builtin: false }];
      const fresh = session.runCommand('fresh');
      for (let i = 0; i < 5 && !proc.messages().length; i++) await flush();
      expect(proc.controls('initialize').length).toBe(before + 1);
      proc.emitLine(turnResult(proc.messages().at(-1)!.uuid));
      await fresh;
      const review = session.runCommand('review', 'low');
      for (let i = 0; i < 5 && proc.messages().length < 2; i++) await flush();
      expect(proc.messages().at(-1)!.text).toBe('/review low');
      proc.emitLine(turnResult(proc.messages().at(-1)!.uuid));
      await review;
    });

    it("refuses commands that write the user's settings", async () => {
      const session = await started();
      await expect(session.runCommand('config', 'autoCompact=false')).rejects.toThrow(/settings file/);
      await expect(session.runCommand('output-style', 'Concise')).rejects.toThrow(/outputStyle/);
      expect(proc.messages()).toHaveLength(0);
    });
  });

  describe('spawn options', () => {
    it('allows the Workflow tool with ultracode, unless denied or read-only', async () => {
      await started({ ultracode: true, allowedTools: ['Read'] });
      expect(spawnArgs()[spawnArgs().indexOf('--allowed-tools') + 1]).toBe('Read,Workflow');
      await started({ ultracode: true, disallowedTools: ['Workflow'] });
      expect(spawnArgs()).not.toContain('--allowed-tools');
      await started({ ultracode: true, sandboxMode: 'read-only' });
      expect(spawnArgs()).not.toContain('--allowed-tools');
      await started({});
      expect(spawnArgs()).not.toContain('--allowed-tools');
    });

    it('passes fast mode and the output style as settings, the advisor as a flag', async () => {
      await started({ fastMode: true, outputStyle: 'Concise', advisor: 'opus' });
      const args = spawnArgs();
      expect(JSON.parse(args[args.indexOf('--settings') + 1])).toEqual({ fastMode: true, outputStyle: 'Concise' });
      expect(args[args.indexOf('--advisor') + 1]).toBe('opus');
    });

    it('keeps file checkpoints, for a rewind of the files', async () => {
      await started();
      const opts = vi.mocked(spawnEngine).mock.calls.at(-1)![2] as { env: NodeJS.ProcessEnv };
      expect(opts.env.CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING).toBe('1');
    });
  });

  describe('quota', () => {
    it("reads the session's last rate_limit_event", async () => {
      const session = await started();
      proc.emitLine({
        type: 'rate_limit_event',
        rate_limit_info: {
          status: 'allowed',
          rateLimitType: 'seven_day',
          unifiedWindows: { seven_day: { utilization: 0.31, resetsAt: 1_796_356_800, status: 'allowed' } },
        },
      });
      const quota = await readEngineQuota('claude', { session });
      expect(quota).toMatchObject({
        engine: 'claude',
        source: 'claude rate_limit_event',
        windows: [
          {
            name: 'seven_day',
            usedPercent: 31,
            remainingPercent: 69,
            resetsAt: new Date(1_796_356_800_000).toISOString(),
          },
        ],
      });
    });

    it('asks get_usage before the first turn, and has nothing to say when the login has no plan limits', async () => {
      const session = await started();
      proc.replies.get_usage = () => ({ response: { rate_limits_available: false, rate_limits: null } });
      expect(await readEngineQuota('claude', { session })).toBeUndefined();
      proc.replies.get_usage = () => ({
        response: {
          subscription_type: 'max',
          rate_limits_available: true,
          rate_limits: { five_hour: { utilization: 12, resets_at: '2026-11-28T12:00:00Z' }, seven_day: null },
        },
      });
      expect(await readEngineQuota('claude', { session })).toMatchObject({
        plan: 'max',
        source: 'claude get_usage',
        windows: [{ name: 'five_hour', usedPercent: 12, resetsAt: '2026-11-28T12:00:00.000Z' }],
      });
      expect(await readEngineQuota('claude', {})).toBeUndefined();
    });
  });
});
