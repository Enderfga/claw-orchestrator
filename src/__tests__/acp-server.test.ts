/**
 * Unit tests for the ACP adapter.
 *
 * These cover the pure translation helpers and the config-option shapes, which
 * are what a client renders and therefore what silently breaks a picker when a
 * field name drifts, and council mode driven over an in-process client
 * connection. Stdout purity is exercised against the real binary — see
 * skills/references/acp.md.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as acp from '@agentclientprotocol/sdk';

import {
  ACP_MODES,
  ACP_DEFAULT_MODE,
  ACP_CONFIG_MODEL,
  ACP_CONFIG_PERMISSION,
  ACP_COUNCIL_COMMANDS,
  buildModelConfigOption,
  buildPermissionConfigOption,
  createAcpAgent,
  flattenPromptContent,
  parseSlashCommand,
  resolveParkedCouncil,
  cancelAcpTurn,
  ACP_MODE_COMMANDS,
} from '../acp-server.js';
import { SessionManager } from '../session-manager.js';
import { nullLogger } from '../logger.js';
import type { CostBreakdown, EffortLevel, ISession, SessionSendOptions, SessionStats, TurnResult } from '../types.js';

describe('ACP modes', () => {
  it('advertises the default mode among the available ones', () => {
    expect(ACP_MODES.map((m) => m.id)).toContain(ACP_DEFAULT_MODE);
  });

  it('gives every mode a stable id and a human-readable name', () => {
    for (const mode of ACP_MODES) {
      expect(mode.id).toMatch(/^[a-z]+$/);
      expect(mode.name.length).toBeGreaterThan(0);
    }
    expect(new Set(ACP_MODES.map((m) => m.id)).size).toBe(ACP_MODES.length);
  });
});

describe('buildModelConfigOption', () => {
  // A client renders this as its model dropdown. The discriminant and the
  // `currentValue` field name are load-bearing: ACP's SessionConfigOption is a
  // union tagged by `type`, and an option missing either is silently unusable
  // rather than rejected.
  it('is a tagged select carrying the current model', () => {
    const opt = buildModelConfigOption('claude-sonnet-4-6') as unknown as Record<string, unknown>;
    expect(opt.type).toBe('select');
    expect(opt.id).toBe(ACP_CONFIG_MODEL);
    expect(opt.category).toBe('model');
    expect(opt.currentValue).toBe('claude-sonnet-4-6');
  });

  it('groups models by engine so one dropdown spans several CLIs', () => {
    const opt = buildModelConfigOption('claude-sonnet-4-6') as unknown as {
      options: Array<{ group: string; name: string; options: Array<{ value: string }> }>;
    };
    const engines = opt.options.map((g) => g.group);
    expect(engines).toContain('claude');
    expect(engines).toContain('codex');
    expect(engines).toContain('agy');
    expect(engines).toContain('grok');
    // Every group must be non-empty, or the client renders an empty header.
    for (const group of opt.options) expect(group.options.length).toBeGreaterThan(0);
  });

  // Gemini and Cursor are legacy engines, kept only for callers that already
  // name them. Listing them in a new picker would advertise a dead end.
  it('omits the legacy gemini and cursor engines', () => {
    const opt = buildModelConfigOption('claude-sonnet-4-6') as unknown as {
      options: Array<{ group: string }>;
    };
    const engines = opt.options.map((g) => g.group);
    expect(engines).not.toContain('gemini');
    expect(engines).not.toContain('cursor');
  });

  it('names every group it shows, rather than falling back to the raw engine id', () => {
    const opt = buildModelConfigOption('claude-sonnet-4-6') as unknown as {
      options: Array<{ group: string; name: string }>;
    };
    for (const group of opt.options) expect(group.name, group.group).not.toBe(group.group);
    expect(opt.options.find((g) => g.group === 'grok')?.name).toBe('Grok Build');
  });
});

describe('buildPermissionConfigOption', () => {
  // ACP can ask the user per turn via session/request_permission, but nothing in
  // this codebase can surface such a request — permission resolves once into
  // engine CLI flags. So the choice is offered up-front instead.
  it('offers the three modes the session layer can actually enforce', () => {
    const opt = buildPermissionConfigOption('plan') as unknown as {
      type: string;
      id: string;
      currentValue: string;
      options: Array<{ value: string }>;
    };
    expect(opt.type).toBe('select');
    expect(opt.id).toBe(ACP_CONFIG_PERMISSION);
    expect(opt.currentValue).toBe('plan');
    expect(opt.options.map((o) => o.value)).toEqual(['plan', 'acceptEdits', 'bypassPermissions']);
  });
});

describe('flattenPromptContent', () => {
  it('concatenates text blocks in order', () => {
    expect(
      flattenPromptContent([
        { type: 'text', text: 'a' },
        { type: 'text', text: 'b' },
      ]),
    ).toBe('ab');
  });

  it('renders a resource link as a textual reference rather than fetching it', () => {
    const out = flattenPromptContent([{ type: 'resource_link', name: 'notes', uri: 'file:///tmp/n.md' }]);
    expect(out).toBe('[resource_link name=notes uri=file:///tmp/n.md]');
  });

  it('ignores block types beyond the advertised baseline', () => {
    // promptCapabilities advertises image/audio/embeddedContext as false, so a
    // client should not send them; dropping them is safer than throwing.
    expect(
      flattenPromptContent([
        { type: 'image', data: 'x' },
        { type: 'text', text: 'ok' },
      ]),
    ).toBe('ok');
  });

  it('returns empty for a non-array, so an empty prompt is rejected by the caller', () => {
    expect(flattenPromptContent(undefined)).toBe('');
    expect(flattenPromptContent('hello')).toBe('');
  });
});

describe('parseSlashCommand', () => {
  it('splits the command from its argument', () => {
    expect(parseSlashCommand('/council_reject too risky')).toEqual({ name: 'council_reject', rest: 'too risky' });
  });

  it('accepts a bare command', () => {
    expect(parseSlashCommand('  /council_accept  ')).toEqual({ name: 'council_accept', rest: '' });
  });

  it('is null for ordinary prose, including a mid-sentence slash', () => {
    expect(parseSlashCommand('fix the bug in src/a.ts')).toBeNull();
    expect(parseSlashCommand('what does /usr/bin do?')).toBeNull();
  });
});

describe('resolveParkedCouncil', () => {
  // A council that reaches consensus parks awaiting a human decision rather than
  // completing, so these two commands are the only way the run ever finishes.
  const parkedState = () =>
    ({
      name: 'acp-x',
      cwd: '/tmp',
      model: 'claude-sonnet-4-6',
      engine: 'claude',
      permissionMode: 'plan',
      modeId: 'council',
      parkedCouncilId: 'council-1',
    }) as Parameters<typeof resolveParkedCouncil>[1];

  it('accepts, clears the park, and withdraws the commands', async () => {
    const calls: string[] = [];
    const manager = {
      councilAccept: async (id: string) => void calls.push(`accept:${id}`),
    } as unknown as Parameters<typeof resolveParkedCouncil>[0];
    const said: string[] = [];
    const emitted: Record<string, unknown>[] = [];
    const state = parkedState();

    const done = await resolveParkedCouncil(
      manager,
      state,
      { name: 'council_accept', rest: '' },
      async (t) => void said.push(t),
      async (u) => void emitted.push(u),
    );

    expect(done).toBe('decided');
    expect(calls).toEqual(['accept:council-1']);
    expect(state.parkedCouncilId).toBeUndefined();
    // Restored, not cleared — an empty list would strand the client with no way
    // back to any mode.
    expect(emitted.at(-1)).toEqual({
      sessionUpdate: 'available_commands_update',
      availableCommands: ACP_MODE_COMMANDS,
    });
    expect(said.join(' ')).toContain('accepted');
  });

  it('passes the text after /council_reject through as feedback', async () => {
    const calls: string[] = [];
    const manager = {
      councilReject: async (id: string, feedback: string) => void calls.push(`${id}|${feedback}`),
    } as unknown as Parameters<typeof resolveParkedCouncil>[0];
    const state = parkedState();

    await resolveParkedCouncil(
      manager,
      state,
      { name: 'council_reject', rest: 'the fix breaks negative inputs' },
      async () => {},
      async () => {},
    );

    expect(calls).toEqual(['council-1|the fix breaks negative inputs']);
    expect(state.parkedCouncilId).toBeUndefined();
  });

  // ── Three outcomes, because two of them are not each other's negation.
  //
  //    `false` used to mean both "no council is parked" and "one is, but this
  //    prompt is not a decision". The caller read both as "carry on", so an
  //    ordinary follow-up message in council mode started a SECOND councilStart
  //    over the worktrees and branches the parked run still held.
  it('blocks a non-council command and leaves the park intact', async () => {
    const state = parkedState();
    const done = await resolveParkedCouncil(
      {} as Parameters<typeof resolveParkedCouncil>[0],
      state,
      { name: 'something_else', rest: '' },
      async () => {},
      async () => {},
    );
    expect(done).toBe('blocked');
    expect(state.parkedCouncilId).toBe('council-1');
  });

  it('blocks a plain-text prompt, which carries no command at all', async () => {
    // This is the shape an ordinary follow-up message takes, and the one that
    // reached councilStart a second time.
    const state = parkedState();
    const done = await resolveParkedCouncil(
      {} as Parameters<typeof resolveParkedCouncil>[0],
      state,
      null,
      async () => {},
      async () => {},
    );
    expect(done).toBe('blocked');
    expect(state.parkedCouncilId).toBe('council-1');
  });

  // The agents merge their own work into the main branch during the rounds.
  // Accept cleans up after them and reject keeps the worktrees, so text that
  // promises a merge or a discard tells the user the opposite of what happens.
  it('describes accept as cleanup and reject as keeping the worktrees', async () => {
    const accept = ACP_COUNCIL_COMMANDS.find((c) => c.name === 'council_accept')?.description ?? '';
    const reject = ACP_COUNCIL_COMMANDS.find((c) => c.name === 'council_reject')?.description ?? '';
    expect(accept).not.toMatch(/merge the winning/i);
    expect(accept).toMatch(/worktrees/);
    expect(reject).not.toMatch(/discard/i);
    expect(reject).toMatch(/plan\.md/);

    const said: string[] = [];
    await resolveParkedCouncil(
      { councilReject: async () => {} } as unknown as Parameters<typeof resolveParkedCouncil>[0],
      parkedState(),
      { name: 'council_reject', rest: 'no' },
      async (t) => void said.push(t),
      async () => {},
    );
    await resolveParkedCouncil(
      { councilAccept: async () => {} } as unknown as Parameters<typeof resolveParkedCouncil>[0],
      parkedState(),
      { name: 'council_accept', rest: '' },
      async (t) => void said.push(t),
      async () => {},
    );
    expect(said[0]).not.toMatch(/discard/i);
    expect(said[0]).toMatch(/plan\.md/);
    expect(said[1]).not.toMatch(/has been merged/i);
  });

  it('reports none when nothing is parked, so an ordinary turn proceeds', async () => {
    const state = { ...parkedState(), parkedCouncilId: undefined };
    const done = await resolveParkedCouncil(
      {} as Parameters<typeof resolveParkedCouncil>[0],
      state,
      null,
      async () => {},
      async () => {},
    );
    expect(done).toBe('none');
  });
});

describe('ACP_MODE_COMMANDS', () => {
  // The VS Code ACP extension (0.2.0, measured) renders config options but not
  // modes, so without a slash command per mode the orchestration modes are
  // unreachable there — the picker ACP defines is advisory, not guaranteed.
  it('offers one command per advertised mode', () => {
    expect(ACP_MODE_COMMANDS.map((c) => c.name)).toEqual(ACP_MODES.map((m) => m.id));
    for (const cmd of ACP_MODE_COMMANDS) expect(cmd.description.length).toBeGreaterThan(0);
  });

  it('names commands so parseSlashCommand recognises them', () => {
    for (const cmd of ACP_MODE_COMMANDS) {
      expect(parseSlashCommand(`/${cmd.name} do the thing`)).toEqual({ name: cmd.name, rest: 'do the thing' });
    }
  });
});

// ── A cancel with nothing in flight must not destroy the session.
//
//    The teardown stops and recreates the underlying session, which drops the
//    engine's native conversation id (codex, codex-app, agy, cursor and
//    opencode capture theirs mid-turn). Running it on an idle session forked
//    the history silently: same ACP sessionId to the client, fresh engine
//    thread on the next prompt.
describe('cancelAcpTurn', () => {
  const idleState = () =>
    ({
      name: 'acp-x',
      cwd: '/tmp',
      model: 'claude-sonnet-4-6',
      engine: 'claude',
      permissionMode: 'plan',
      modeId: 'single',
    }) as Parameters<typeof cancelAcpTurn>[1];

  const spyManager = () => {
    const calls: string[] = [];
    return {
      calls,
      manager: {
        stopSession: async (n: string) => void calls.push(`stop:${n}`),
        startSession: async (c: { name?: string }) => {
          calls.push(`start:${c.name}`);
          return { name: c.name } as never;
        },
      } as unknown as Parameters<typeof cancelAcpTurn>[0],
    };
  };

  it('does nothing when no turn is in flight', () => {
    const { manager, calls } = spyManager();
    const state = idleState();

    expect(cancelAcpTurn(manager, state)).toBe(false);
    expect(calls).toEqual([]);
  });

  it('cancels and tears down when a turn IS in flight', async () => {
    // The other half: guarding everything would break cancel entirely.
    const { manager, calls } = spyManager();
    const state = idleState();
    let cancelled = false;
    state.cancelInFlight = () => {
      cancelled = true;
    };

    expect(cancelAcpTurn(manager, state)).toBe(true);
    expect(cancelled).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toEqual(['stop:acp-x', 'start:acp-x']);
  });
});

// ── Council mode, over a client connection ──────────────────────────────────

type Update = Record<string, unknown>;

async function connectAgent(manager: object, cwd: string) {
  const updates: Update[] = [];
  const app = createAcpAgent(manager as never, { defaultModel: 'claude-sonnet-4-6' });
  const conn = acp
    .client({ name: 'test-editor' })
    .onNotification('session/update', (ctx) => void updates.push(ctx.params.update as unknown as Update))
    .connect(app);
  await conn.agent.request('initialize', { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
  const { sessionId } = await conn.agent.request('session/new', { cwd, mcpServers: [] });
  const prompt = (text: string) =>
    conn.agent.request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] });
  return { conn, sessionId, updates, prompt };
}

/** An engine session that answers every turn with the same text, streamed once. */
class ScriptedSession extends EventEmitter implements ISession {
  sessionId?: string;
  private turns = 0;
  constructor(private readonly reply: string) {
    super();
  }
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
    this.sessionId = `scripted-${Math.random().toString(36).slice(2, 8)}`;
    return this;
  }
  stop(): void {}
  pause(): void {}
  resume(): void {}
  async send(_message: string | unknown[], options?: SessionSendOptions): Promise<TurnResult> {
    this.turns++;
    options?.callbacks?.onText?.(this.reply);
    return { text: this.reply, event: { type: 'result', result: this.reply } };
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
      model: 'scripted',
      tokensIn: 0,
      tokensOut: 0,
      cachedTokens: 0,
      pricing: { inputPer1M: 0, outputPer1M: 0, cachedPer1M: 0 },
      breakdown: { inputCost: 0, cachedCost: 0, outputCost: 0 },
      totalUsd: 0,
    };
  }
  async compact(): Promise<TurnResult> {
    return { text: '', event: { type: 'result', result: '' } };
  }
  getEffort(): EffortLevel {
    return 'auto';
  }
  setEffort(): void {}
  resolveModel(alias: string): string {
    return alias;
  }
}

// The real SessionManager, kernel and Council, with every engine replaced by a
// scripted session: what is under test is the timing between them, which a
// hand-written fake manager would only restate.
describe('council mode on the real council', () => {
  const managers: SessionManager[] = [];
  const dirs: string[] = [];
  afterEach(async () => {
    for (const m of managers.splice(0)) await m.shutdown();
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  const tempDir = () => {
    const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'clawo-acp-council-'));
    dirs.push(dir);
    return dir;
  };
  const realManager = (reply: string) => {
    const mgr = new SessionManager({ maxConcurrentSessions: 8 }, nullLogger);
    (mgr as unknown as { _createSession: () => ISession })._createSession = () => new ScriptedSession(reply);
    managers.push(mgr);
    return mgr;
  };

  // The kernel publishes the live Council from inside its node, after
  // `councilStart` has returned, so a lookup made straight after the start
  // found nothing and the client saw none of the agents.
  it('reports each agent as a tool call and each round as a plan', async () => {
    const { conn, updates, prompt } = await connectAgent(realManager('Looks right. [CONSENSUS: YES]'), tempDir());

    await expect(prompt('/council add a greeting to the readme')).resolves.toMatchObject({ stopReason: 'end_turn' });

    const calls = updates.filter((u) => u.sessionUpdate === 'tool_call').map((u) => u.title);
    expect(calls.sort()).toEqual(['Builder — round 1', 'Critic — round 1']);
    const finished = updates.filter((u) => u.sessionUpdate === 'tool_call_update');
    expect(finished).toHaveLength(2);
    for (const u of finished) {
      expect(u.status).toBe('completed');
      expect(JSON.stringify(u.content)).toContain('Looks right.');
    }
    expect(updates.some((u) => u.sessionUpdate === 'plan')).toBe(true);
    conn.close();
  });

  // The council's guardrails now run inside the kernel run, so `councilStart`
  // no longer throws them; they have to be read back from the run.
  it('names the guardrail that refused the run', async () => {
    const { conn, prompt } = await connectAgent(realManager('[CONSENSUS: YES]'), tempDir());
    await expect(prompt('/council hi')).rejects.toMatchObject({
      code: -32602,
      data: expect.stringMatching(/Council could not start: Task description too short/),
    });
    conn.close();
  });

  // A run that failed during worktree setup still said `running`, so the turn
  // waited out the thirty-minute cap with nothing to show for it.
  it('reports a run that failed while setting up its worktrees instead of waiting it out', async () => {
    const file = path.join(tempDir(), 'not-a-directory');
    fs.writeFileSync(file, '');
    const { conn, prompt } = await connectAgent(realManager('[CONSENSUS: YES]'), file);
    await expect(prompt('/council add a greeting to the readme')).rejects.toMatchObject({
      code: -32602,
      data: expect.stringMatching(/Council could not start: .*Not a directory/),
    });
    conn.close();
  }, 15_000);
});

/** A manager whose council the test drives by hand, event by event. */
function fakeCouncilManager() {
  const council = new EventEmitter();
  const state = { status: 'running', finalSummary: undefined as string | undefined, aborted: [] as string[] };
  const manager = {
    async startSession(config: Record<string, unknown>) {
      return { name: String(config.name) };
    },
    async sendMessage() {
      return { output: '' };
    },
    async stopSession() {},
    async councilStart(task: string) {
      return { id: 'council-1', task, responses: [], status: 'running' };
    },
    getCouncil: () => council,
    councilStatus: (id: string) => ({ id, status: state.status, responses: [], finalSummary: state.finalSummary }),
    councilAbort: (id: string) => void state.aborted.push(id),
  };
  const emit = (event: Record<string, unknown>) =>
    council.emit('council-event', { sessionId: 'council-1', timestamp: new Date().toISOString(), ...event });
  const attached = () => vi.waitFor(() => expect(council.listenerCount('council-event')).toBeGreaterThan(0));
  return { manager, state, emit, attached };
}

describe('council mode, event by event', () => {
  // ACP v1: a prompt the client cancelled must end with stopReason `cancelled`.
  it('ends a cancelled council prompt with stopReason cancelled', async () => {
    const { manager, state, attached } = fakeCouncilManager();
    const { conn, sessionId, prompt } = await connectAgent(manager, '/repo');
    const turn = prompt('/council add a greeting to the readme');
    await attached();

    await conn.agent.notify('session/cancel', { sessionId });

    await expect(turn).resolves.toMatchObject({ stopReason: 'cancelled' });
    expect(state.aborted).toEqual(['council-1']);
    conn.close();
  });

  // An agent error fails that agent's round; the council carries on with the
  // others, so the turn must not end on it.
  it('marks a failed agent as a failed tool call and keeps the turn open', async () => {
    const { manager, state, emit, attached } = fakeCouncilManager();
    const { conn, updates, prompt } = await connectAgent(manager, '/repo');
    let settled = false;
    const turn = prompt('/council add a greeting to the readme').finally(() => {
      settled = true;
    });
    await attached();

    emit({ type: 'agent-start', agent: 'Builder', round: 1 });
    emit({ type: 'error', agent: 'Builder', round: 1, error: 'engine exited' });
    await new Promise((r) => setTimeout(r, 50));
    expect(settled).toBe(false);

    state.status = 'max_rounds';
    state.finalSummary = 'No agreement.';
    emit({ type: 'complete', status: 'max_rounds' });
    await expect(turn).resolves.toMatchObject({ stopReason: 'end_turn' });
    expect(updates).toContainEqual(expect.objectContaining({ sessionUpdate: 'tool_call_update', status: 'failed' }));
    conn.close();
  });
});
