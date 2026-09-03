/**
 * Tests for ClaudeAgentDispatcher — the layer between the runner's message
 * bus and the real persistent Claude sessions. We stub SessionManager so the
 * tests stay hermetic; only behaviour owned by the dispatcher (frozen-memory
 * injection, sandbox staging, send-failure surfacing, decisions audit, policy
 * silencing guard) is exercised.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { ClaudeAgentDispatcher } from '../autoloop/dispatcher.js';
import { AutoloopRunner } from '../autoloop/runner.js';
import { type AnyAutoloopMessage, Msg } from '../autoloop/messages.js';
import type { SessionManager } from '../session-manager.js';
import type { PushPolicy } from '../autoloop/types.js';
import { DEFAULT_PUSH_POLICY, LEDGER_SCHEMA_VERSION } from '../autoloop/types.js';

interface StubCalls {
  startSession: ReturnType<typeof vi.fn>;
  sendMessage: ReturnType<typeof vi.fn>;
  stopSession: ReturnType<typeof vi.fn>;
  getStatus: ReturnType<typeof vi.fn>;
  compactSession: ReturnType<typeof vi.fn>;
}

function makeStubManager(
  opts: {
    sendOutput?: string;
    sendOutputs?: string[];
    sendThrows?: number;
    startThrowsFor?: 'planner' | 'coder' | 'reviewer';
    contextPercent?: number;
  } = {},
): { manager: SessionManager; calls: StubCalls } {
  let throwsRemaining = opts.sendThrows ?? 0;
  let sendIndex = 0;
  const calls: StubCalls = {
    startSession: vi.fn(async (config: { name: string }) => {
      if (opts.startThrowsFor && config.name.endsWith(`-${opts.startThrowsFor}`)) {
        throw new Error(`${opts.startThrowsFor} failed to start`);
      }
      return { name: 'x', state: 'ready' };
    }),
    sendMessage: vi.fn(async () => {
      if (throwsRemaining > 0) {
        throwsRemaining -= 1;
        throw new Error('subprocess died');
      }
      const output = opts.sendOutputs?.[sendIndex] ?? opts.sendOutput ?? '';
      sendIndex += 1;
      return { output, error: undefined };
    }),
    stopSession: vi.fn(async () => undefined),
    getStatus: vi.fn(() => ({
      stats: { contextPercent: opts.contextPercent ?? 10, tokensIn: 0, tokensOut: 0, cachedTokens: 0 },
    })),
    compactSession: vi.fn(async () => undefined),
  };
  const manager = {
    startSession: calls.startSession,
    sendMessage: calls.sendMessage,
    stopSession: calls.stopSession,
    getStatus: calls.getStatus,
    compactSession: calls.compactSession,
  } as unknown as SessionManager;
  return { manager, calls };
}

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autoloop-disp-'));
});

afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function makeDispatcher(
  overrides: Partial<ConstructorParameters<typeof ClaudeAgentDispatcher>[0]> = {},
  managerOpts?: Parameters<typeof makeStubManager>[0],
): {
  dispatcher: ClaudeAgentDispatcher;
  calls: StubCalls;
  ledgerDir: string;
  workspace: string;
} {
  const { manager, calls } = makeStubManager(managerOpts);
  const workspace = tmpRoot;
  const dispatcher = new ClaudeAgentDispatcher({
    manager,
    runId: 'r1',
    workspace,
    ...overrides,
  });
  const ledgerDir = path.join(workspace, 'tasks', 'r1');
  return { dispatcher, calls, ledgerDir, workspace };
}

function findStart(calls: StubCalls, role: 'planner' | 'coder' | 'reviewer'): Record<string, unknown> {
  const call = calls.startSession.mock.calls.find(
    (entry) => (entry[0] as { name: string }).name === `autoloop-r1-${role}`,
  );
  expect(call, `${role} startSession call`).toBeDefined();
  return call![0] as Record<string, unknown>;
}

interface ObservedSendTimeout {
  type: 'send_timeout';
  payload: {
    status: 'awaiting_resume';
    dispatch_id: string;
    agent: 'planner' | 'coder' | 'reviewer';
    message_id: string;
    message_type: string;
    iter: number;
    timeout_ms: number;
    error: string;
  };
}

function fixedIdentity<T extends AnyAutoloopMessage>(env: T, messageId: string, ts = '2026-09-03T00:00:00.000Z'): T {
  return { ...env, msg_id: messageId, ts };
}

function sendTimeout(replies: AnyAutoloopMessage[]): ObservedSendTimeout {
  expect(replies).toHaveLength(1);
  expect(replies[0].type).toBe('send_timeout');
  return replies[0] as unknown as ObservedSendTimeout;
}

function genuineSendTimeout(): Error {
  return new Error('Timeout waiting for response');
}

describe('ClaudeAgentDispatcher — role engine configuration', () => {
  it('keeps the legacy Claude model defaults when no role overrides are provided', async () => {
    const { dispatcher, calls } = makeDispatcher();

    await dispatcher.deliver(Msg.chat(0, { text: 'hello' }));
    await dispatcher.spawnSubagents();

    expect(findStart(calls, 'planner')).toMatchObject({ engine: 'claude', model: 'opus' });
    expect(findStart(calls, 'coder')).toMatchObject({ engine: 'claude', model: 'sonnet' });
    expect(findStart(calls, 'reviewer')).toMatchObject({ engine: 'claude', model: 'sonnet' });
  });

  it('uses each non-Claude engine without injecting a Claude model default', async () => {
    const { dispatcher, calls } = makeDispatcher({
      plannerEngine: 'codex',
      coderEngine: 'gemini',
      reviewerEngine: 'opencode',
    });

    await dispatcher.deliver(Msg.chat(0, { text: 'hello' }));
    await dispatcher.spawnSubagents();

    for (const [role, engine] of [
      ['planner', 'codex'],
      ['coder', 'gemini'],
      ['reviewer', 'opencode'],
    ] as const) {
      const start = findStart(calls, role);
      expect(start.engine).toBe(engine);
      expect(start).toHaveProperty('model', undefined);
    }
  });

  it('delivers the Planner protocol in-band and starts non-Claude Planners read-only', async () => {
    const { dispatcher, calls } = makeDispatcher({ plannerEngine: 'codex' });

    await dispatcher.deliver(Msg.chat(0, { text: 'inspect this repository' }));

    expect(findStart(calls, 'planner')).toMatchObject({
      permissionMode: 'manual',
      sandboxMode: 'read-only',
    });
    const prompt = calls.sendMessage.mock.calls[0][1] as string;
    expect(prompt).toContain('<autoloop_role_instructions>');
    expect(prompt).toContain('Planner');
    expect(prompt).toContain('inspect this repository');
  });

  it('replays prior Planner chat for one-shot engines without native conversation resume', async () => {
    const { dispatcher, calls } = makeDispatcher(
      { plannerEngine: 'gemini' },
      { sendOutputs: ['FIRST_PLANNER_REPLY', 'SECOND_PLANNER_REPLY'] },
    );

    await dispatcher.deliver(Msg.chat(0, { text: 'Remember plan ORCHID and option B.' }));
    await dispatcher.deliver(Msg.chat(0, { text: 'Continue with the plan.' }));

    const secondPrompt = calls.sendMessage.mock.calls[1][1] as string;
    expect(secondPrompt).toContain('<conversation_history>');
    expect(secondPrompt).toContain('Remember plan ORCHID and option B.');
    expect(secondPrompt).toContain('FIRST_PLANNER_REPLY');
    expect(secondPrompt).toContain('Continue with the plan.');
  });

  it('delivers Coder and Reviewer protocols in-band for non-Claude engines', async () => {
    const { dispatcher, calls, ledgerDir } = makeDispatcher({
      coderEngine: 'codex',
      reviewerEngine: 'gemini',
    });
    await dispatcher.spawnSubagents();

    await dispatcher.deliver(
      Msg.directive(0, {
        goal: 'change one file',
        constraints: [],
        success_criteria: [],
        max_attempts: 1,
      }),
    );
    await dispatcher.deliver(
      Msg.reviewRequest(0, {
        iter: 0,
        ledger_path: ledgerDir,
        prior_metrics: [],
      }),
    );

    const coderPrompt = calls.sendMessage.mock.calls[0][1] as string;
    const reviewerPrompt = calls.sendMessage.mock.calls[1][1] as string;
    expect(coderPrompt).toContain('<autoloop_role_instructions>');
    expect(coderPrompt).toContain('Coder');
    expect(coderPrompt).toContain('change one file');
    expect(reviewerPrompt).toContain('<autoloop_role_instructions>');
    expect(reviewerPrompt).toContain('Reviewer');
    expect(reviewerPrompt).toContain('[review_request iter=0]');
  });

  it('passes explicit role models and custom engine configs through to startSession', async () => {
    const plannerCustomEngine = {
      name: 'planner-cli',
      bin: 'planner-cli',
      args: {},
      env: { TEST_TOKEN: 'planner-secret-sentinel' },
    };
    const coderCustomEngine = { name: 'coder-cli', bin: 'coder-cli', args: {} };
    const reviewerCustomEngine = { name: 'reviewer-cli', bin: 'reviewer-cli', args: {} };
    const { dispatcher, calls } = makeDispatcher({
      plannerEngine: 'custom',
      plannerModel: 'planner-model',
      plannerCustomEngine,
      coderEngine: 'custom',
      coderModel: 'coder-model',
      coderCustomEngine,
      reviewerEngine: 'custom',
      reviewerModel: 'reviewer-model',
      reviewerCustomEngine,
    });

    await dispatcher.deliver(Msg.chat(0, { text: 'hello' }));
    await dispatcher.spawnSubagents();

    expect(findStart(calls, 'planner')).toMatchObject({
      engine: 'custom',
      model: 'planner-model',
      customEngine: plannerCustomEngine,
    });
    expect(findStart(calls, 'coder')).toMatchObject({
      engine: 'custom',
      model: 'coder-model',
      customEngine: coderCustomEngine,
    });
    expect(findStart(calls, 'reviewer')).toMatchObject({
      engine: 'custom',
      model: 'reviewer-model',
      customEngine: reviewerCustomEngine,
    });
  });

  it('rejects a custom role before startSession when its trusted config is missing', async () => {
    const { dispatcher, calls } = makeDispatcher({ plannerEngine: 'custom' });

    await expect(dispatcher.deliver(Msg.chat(0, { text: 'hello' }))).rejects.toThrow(
      'Planner custom engine config is required',
    );
    expect(calls.startSession).not.toHaveBeenCalled();
  });

  it('applies spawn engine overrides and recomputes implicit model defaults', async () => {
    const { dispatcher, calls } = makeDispatcher({ reviewerEngine: 'gemini', reviewerModel: 'gemini-explicit' });

    await dispatcher.spawnSubagents({ coder_engine: 'codex' });

    expect(findStart(calls, 'coder')).toHaveProperty('model', undefined);
    expect(findStart(calls, 'coder').engine).toBe('codex');
    expect(findStart(calls, 'reviewer')).toMatchObject({ engine: 'gemini', model: 'gemini-explicit' });
  });

  it('drops a prior model when spawn changes only the engine', async () => {
    const { dispatcher, calls } = makeDispatcher({
      coderEngine: 'claude',
      coderModel: 'claude-specific-model',
    });

    await dispatcher.spawnSubagents({ coder_engine: 'codex' });

    expect(findStart(calls, 'coder')).toMatchObject({ engine: 'codex', model: undefined });
  });

  it('uses the current role engine when eagerly resetting a spawned subagent', async () => {
    const { dispatcher, calls } = makeDispatcher();
    await dispatcher.spawnSubagents({ coder_engine: 'codex', coder_model: 'gpt-coder' });

    await dispatcher.resetAgent('coder', { eagerRestart: true });

    const coderStarts = calls.startSession.mock.calls
      .map((entry) => entry[0] as Record<string, unknown>)
      .filter((config) => config.name === 'autoloop-r1-coder');
    expect(coderStarts).toHaveLength(2);
    expect(coderStarts[1]).toMatchObject({ engine: 'codex', model: 'gpt-coder' });
  });

  it('rejects engine changes after a subagent session has started', async () => {
    const { dispatcher, calls } = makeDispatcher();
    await dispatcher.spawnSubagents();

    await expect(dispatcher.spawnSubagents({ coder_engine: 'codex' })).rejects.toThrow(
      'Cannot change Coder engine or model after its session has started',
    );

    await dispatcher.resetAgent('coder', { eagerRestart: true });
    const coderStarts = calls.startSession.mock.calls
      .map((entry) => entry[0] as Record<string, unknown>)
      .filter((config) => config.name === 'autoloop-r1-coder');
    expect(coderStarts).toHaveLength(2);
    expect(coderStarts[1]).toMatchObject({ engine: 'claude', model: 'sonnet' });
  });

  it('stops a newly started Coder when Reviewer startup fails', async () => {
    const { dispatcher, calls } = makeDispatcher({}, { startThrowsFor: 'reviewer' });

    await expect(dispatcher.spawnSubagents()).rejects.toThrow('reviewer failed to start');

    expect(calls.stopSession).toHaveBeenCalledWith('autoloop-r1-coder');
    calls.startSession.mockImplementation(async () => ({ name: 'x', state: 'ready' }));
    await dispatcher.spawnSubagents();
    expect(findStart(calls, 'coder')).toBeDefined();
    expect(findStart(calls, 'reviewer')).toBeDefined();
  });
});

describe('ClaudeAgentDispatcher — frozen reviewer memory', () => {
  it('injects reviewer_memory.md contents into the Reviewer system prompt at startSession', async () => {
    const { dispatcher, calls, ledgerDir } = makeDispatcher();
    const sandbox = path.join(ledgerDir, 'reviewer_sandbox');
    fs.mkdirSync(sandbox, { recursive: true });
    fs.writeFileSync(path.join(sandbox, 'reviewer_memory.md'), 'Pattern: ZEBRA_OFFSET = sentinel\n');

    await dispatcher.spawnSubagents();

    // Reviewer is the second startSession call (after Coder).
    const reviewerStart = calls.startSession.mock.calls.find(
      (c) => (c[0] as { name: string }).name === 'autoloop-r1-reviewer',
    );
    expect(reviewerStart).toBeDefined();
    const sp = (reviewerStart![0] as { systemPrompt: string }).systemPrompt;
    expect(sp).toContain('<frozen_memory_snapshot>');
    expect(sp).toContain('Pattern: ZEBRA_OFFSET = sentinel');
  });

  it('omits the frozen snapshot tag when reviewer_memory.md is missing', async () => {
    const { dispatcher, calls } = makeDispatcher();
    await dispatcher.spawnSubagents();
    const reviewerStart = calls.startSession.mock.calls.find(
      (c) => (c[0] as { name: string }).name === 'autoloop-r1-reviewer',
    );
    const sp = (reviewerStart![0] as { systemPrompt: string }).systemPrompt;
    expect(sp).not.toContain('<frozen_memory_snapshot>');
  });

  it('keeps the non-Claude Reviewer memory snapshot frozen after session start', async () => {
    const { dispatcher, calls, ledgerDir } = makeDispatcher({ reviewerEngine: 'gemini' });
    const sandbox = path.join(ledgerDir, 'reviewer_sandbox');
    fs.mkdirSync(sandbox, { recursive: true });
    fs.writeFileSync(path.join(sandbox, 'reviewer_memory.md'), 'frozen-old-memory');
    await dispatcher.spawnSubagents();
    fs.writeFileSync(path.join(sandbox, 'reviewer_memory.md'), 'new-memory-must-wait-for-reset');

    await dispatcher.deliver(
      Msg.reviewRequest(0, {
        iter: 0,
        ledger_path: ledgerDir,
        prior_metrics: [],
      }),
    );

    const prompt = calls.sendMessage.mock.calls[0][1] as string;
    expect(prompt).toContain('frozen-old-memory');
    expect(prompt).not.toContain('new-memory-must-wait-for-reset');
  });
});

describe('ClaudeAgentDispatcher — phase_error surfacing', () => {
  it('returns a phase_error envelope (not a fake directive_ack) when Coder send fails twice', async () => {
    vi.useFakeTimers();
    const { dispatcher } = makeDispatcher({}, { sendThrows: 2 });
    await dispatcher.spawnSubagents();
    const pending = dispatcher.deliver(
      Msg.directive(0, { goal: 'g', constraints: [], success_criteria: [], max_attempts: 1 }),
    );
    void pending.catch(() => undefined);
    await vi.runAllTimersAsync();
    const replies = await pending;
    expect(replies).toHaveLength(1);
    expect(replies[0].type).toBe('phase_error');
    if (replies[0].type === 'phase_error') {
      expect(replies[0].payload.agent).toBe('coder');
      expect(replies[0].payload.phase).toBe('send');
    }
  });
});

describe('ClaudeAgentDispatcher — recoverable send timeout and dispatch identity', () => {
  const roleCases: Array<['planner' | 'coder' | 'reviewer', (ledgerDir: string) => AnyAutoloopMessage]> = [
    ['planner', () => fixedIdentity(Msg.chat(3, { text: 'continue' }), 'logical-planner-3')],
    [
      'coder',
      () =>
        fixedIdentity(
          Msg.directive(3, { goal: 'ship I3', constraints: [], success_criteria: [], max_attempts: 1 }),
          'logical-coder-3',
        ),
    ],
    [
      'reviewer',
      (ledgerDir) =>
        fixedIdentity(
          Msg.reviewRequest(3, { iter: 3, ledger_path: ledgerDir, prior_metrics: [] }),
          'logical-reviewer-3',
        ),
    ],
  ];

  it.each(roleCases)(
    'classifies a genuine %s send timeout once without reset or automatic retry',
    async (role, makeMessage) => {
      vi.useFakeTimers();
      const { dispatcher, calls, ledgerDir } = makeDispatcher({ sendTimeoutMs: 7_200_000 });
      calls.sendMessage.mockRejectedValue(genuineSendTimeout());
      const message = makeMessage(ledgerDir);

      const pending = dispatcher.deliver(message);
      void pending.catch(() => undefined);
      await vi.runAllTimersAsync();
      const observed = sendTimeout(await pending);

      expect(observed.payload).toMatchObject({
        status: 'awaiting_resume',
        agent: role,
        message_id: message.msg_id,
        message_type: message.type,
        iter: message.iter,
        timeout_ms: 7_200_000,
        error: 'Timeout waiting for response',
      });
      expect(observed.payload.dispatch_id).toMatch(/^dispatch_[a-f0-9]{64}$/);
      expect(calls.sendMessage).toHaveBeenCalledTimes(1);
      expect(calls.stopSession).not.toHaveBeenCalled();
    },
  );

  it('keeps a non-timeout failure on the reset-once/retry-once phase_error path', async () => {
    vi.useFakeTimers();
    const { dispatcher, calls } = makeDispatcher();
    calls.sendMessage.mockRejectedValue(new Error('subprocess failed while loading timeout configuration'));
    const message = fixedIdentity(
      Msg.directive(0, { goal: 'g', constraints: [], success_criteria: [], max_attempts: 1 }),
      'logical-non-timeout',
    );

    const pending = dispatcher.deliver(message);
    void pending.catch(() => undefined);
    await vi.runAllTimersAsync();
    const replies = await pending;

    expect(replies).toHaveLength(1);
    expect(replies[0].type).toBe('phase_error');
    expect(calls.sendMessage).toHaveBeenCalledTimes(2);
    expect(calls.stopSession).toHaveBeenCalledTimes(1);
  });

  it('coalesces concurrent and later re-delivery of one logical dispatch, while distinct identities still send', async () => {
    const { dispatcher, calls } = makeDispatcher();
    let resolveSend!: (value: { output: string; error: undefined }) => void;
    const underlying = new Promise<{ output: string; error: undefined }>((resolve) => {
      resolveSend = resolve;
    });
    calls.sendMessage.mockReturnValue(underlying);
    const first = fixedIdentity(Msg.chat(2, { text: 'same logical turn' }), 'logical-chat-a');
    const duplicate = fixedIdentity(
      Msg.chat(2, { text: 'same logical turn' }),
      'logical-chat-a',
      '2035-01-01T00:00:00.000Z',
    );

    const deliveryA = dispatcher.deliver(first);
    const deliveryB = dispatcher.deliver(duplicate);
    await Promise.resolve();
    await Promise.resolve();
    expect(calls.sendMessage).toHaveBeenCalledTimes(1);

    resolveSend({ output: '', error: undefined });
    await Promise.all([deliveryA, deliveryB]);
    await dispatcher.deliver(duplicate);
    expect(calls.sendMessage).toHaveBeenCalledTimes(1);

    await dispatcher.deliver(fixedIdentity(Msg.chat(2, { text: 'same logical turn' }), 'logical-chat-b'));
    expect(calls.sendMessage).toHaveBeenCalledTimes(2);
  });

  it('derives the same ID across dispatcher instances without using envelope time, but separates message identities', async () => {
    vi.useFakeTimers();
    const firstHarness = makeDispatcher({ sendTimeoutMs: 7_200_000 });
    const secondHarness = makeDispatcher({ sendTimeoutMs: 7_200_000 });
    firstHarness.calls.sendMessage.mockRejectedValue(genuineSendTimeout());
    secondHarness.calls.sendMessage.mockRejectedValue(genuineSendTimeout());
    const first = fixedIdentity(Msg.chat(4, { text: 'logical input' }), 'logical-stable-id', '2020-01-01T00:00:00Z');
    const sameLogical = fixedIdentity(
      Msg.chat(4, { text: 'logical input' }),
      'logical-stable-id',
      '2040-01-01T00:00:00Z',
    );
    const distinct = fixedIdentity(Msg.chat(4, { text: 'logical input' }), 'logical-distinct-id');

    const firstPending = firstHarness.dispatcher.deliver(first);
    const samePending = secondHarness.dispatcher.deliver(sameLogical);
    const distinctPending = firstHarness.dispatcher.deliver(distinct);
    for (const pending of [firstPending, samePending, distinctPending]) void pending.catch(() => undefined);
    await vi.runAllTimersAsync();
    const [firstResult, sameResult, distinctResult] = await Promise.all([firstPending, samePending, distinctPending]);
    const firstId = sendTimeout(firstResult).payload.dispatch_id;
    const sameId = sendTimeout(sameResult).payload.dispatch_id;
    const distinctId = sendTimeout(distinctResult).payload.dispatch_id;

    expect(sameId).toBe(firstId);
    expect(distinctId).not.toBe(firstId);
  });

  it('records one deterministic pending-dispatch audit row even when the logical dispatch is re-delivered', async () => {
    vi.useFakeTimers();
    const { dispatcher, calls, ledgerDir } = makeDispatcher({ sendTimeoutMs: 7_200_000 });
    calls.sendMessage.mockRejectedValue(genuineSendTimeout());
    const message = fixedIdentity(Msg.chat(5, { text: 'audit this pending turn' }), 'logical-audit-id');

    const firstPending = dispatcher.deliver(message);
    void firstPending.catch(() => undefined);
    await vi.runAllTimersAsync();
    const first = sendTimeout(await firstPending);
    const second = sendTimeout(await dispatcher.deliver({ ...message }));
    const rows = fs
      .readFileSync(path.join(ledgerDir, 'decisions.jsonl'), 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { kind: string; payload: Record<string, unknown> })
      .filter((row) => row.kind === 'send_timeout');

    expect(second.payload.dispatch_id).toBe(first.payload.dispatch_id);
    expect(rows).toHaveLength(1);
    expect(rows[0].payload).toEqual(first.payload);
    expect(calls.sendMessage).toHaveBeenCalledTimes(1);
  });
});

describe('AutoloopRunner — recoverable dispatcher timeout state', () => {
  function makeTimeoutRunner(hardTimeoutMs = 86_400_000): {
    runner: AutoloopRunner;
    calls: StubCalls;
    rejectSend: (error: Error) => void;
  } {
    const { dispatcher, calls, ledgerDir, workspace } = makeDispatcher({ sendTimeoutMs: 7_200_000 });
    let rejectSend!: (error: Error) => void;
    calls.sendMessage.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectSend = reject;
        }),
    );
    const runner = new AutoloopRunner({
      run_id: 'r1',
      workspace,
      ledger_dir: ledgerDir,
      dispatcher,
      notifyUser: vi.fn(async () => undefined),
      sendTimeoutMs: 7_200_000,
      activityLeaseMs: 7_200_000,
      autoloopHardTimeoutMs: hardTimeoutMs,
    });
    return { runner, calls, rejectSend: (error) => rejectSend(error) };
  }

  it('pauses in awaiting-resume state with pending metadata and one structured timeout event', async () => {
    const { runner, calls, rejectSend } = makeTimeoutRunner();
    const timeoutEvents: ObservedSendTimeout['payload'][] = [];
    runner.on('send_timeout', (event) => timeoutEvents.push(event as ObservedSendTimeout['payload']));
    await runner.start();

    const chat = runner.chat('wait for planner');
    await Promise.resolve();
    rejectSend(genuineSendTimeout());
    await chat;

    const state = runner.state as typeof runner.state & {
      pending_dispatch: ObservedSendTimeout['payload'] | null;
    };
    expect(state.status).toBe('paused');
    expect(state.status_reason).toBe(
      `awaiting_resume:send_timeout:planner:${state.pending_dispatch?.dispatch_id ?? ''}`,
    );
    expect(state.pending_dispatch).toMatchObject({
      status: 'awaiting_resume',
      agent: 'planner',
      timeout_ms: 7_200_000,
    });
    expect(timeoutEvents).toEqual([state.pending_dispatch]);
    expect(calls.sendMessage).toHaveBeenCalledTimes(1);
    runner.stop();
  });

  it('keeps the awaiting-resume timeout reason stable instead of letting the idle lease overwrite it', async () => {
    vi.useFakeTimers();
    const { runner, rejectSend } = makeTimeoutRunner();
    const lifecycleTimeouts: Array<{ kind: string }> = [];
    runner.on('timeout', (event) => lifecycleTimeouts.push(event as { kind: string }));
    await runner.start();

    const chat = runner.chat('wait for planner');
    await Promise.resolve();
    rejectSend(genuineSendTimeout());
    await chat;
    const reason = runner.state.status_reason;

    await runner.send(Msg.resume(0));
    await vi.advanceTimersByTimeAsync(7_200_000);
    expect(runner.state.status).toBe('paused');
    expect(runner.state.status_reason).toBe(reason);
    expect(lifecycleTimeouts).toEqual([]);
    runner.stop();
  });

  it('keeps operator termination terminal when its queued stop wins a late timeout result', async () => {
    const { runner, rejectSend } = makeTimeoutRunner();
    const timeoutEvents: unknown[] = [];
    runner.on('send_timeout', (event) => timeoutEvents.push(event));
    await runner.start();

    const chat = runner.chat('slow planner turn');
    await Promise.resolve();
    await runner.send(Msg.terminate(0, { reason: 'operator_stop' }));
    rejectSend(genuineSendTimeout());
    await chat;

    const state = runner.state as typeof runner.state & { pending_dispatch: unknown | null };
    expect(state.status).toBe('terminated');
    expect(state.status_reason).toBe('operator_stop');
    expect(state.pending_dispatch).toBeNull();
    expect(timeoutEvents).toEqual([]);
  });

  it('keeps the absolute hard timeout terminal when an in-flight send times out later', async () => {
    vi.useFakeTimers();
    const { runner, rejectSend } = makeTimeoutRunner(600_000);
    const sendTimeoutEvents: unknown[] = [];
    const deadlineEvents: Array<{ kind: string }> = [];
    runner.on('send_timeout', (event) => sendTimeoutEvents.push(event));
    runner.on('timeout', (event) => deadlineEvents.push(event as { kind: string }));
    await runner.start();

    const chat = runner.chat('outlive hard cap');
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(runner.state.status).toBe('terminated');
    rejectSend(genuineSendTimeout());
    await chat;

    const state = runner.state as typeof runner.state & { pending_dispatch: unknown | null };
    expect(state.status).toBe('terminated');
    expect(state.status_reason).toBe('hard_timeout_exceeded');
    expect(state.pending_dispatch).toBeNull();
    expect(sendTimeoutEvents).toEqual([]);
    expect(deadlineEvents.map((event) => event.kind)).toEqual(['hard_timeout_exceeded']);
  });
});

describe('ClaudeAgentDispatcher — updatePushPolicy guard', () => {
  it('strips silent=true from on_phase_error / on_decision_needed but applies other fields', async () => {
    const policyRef: PushPolicy = JSON.parse(JSON.stringify(DEFAULT_PUSH_POLICY));
    const reply = `OK
\`\`\`autoloop
{"tool": "update_push_policy", "args": {"on_phase_error": {"silent": true, "channel": "email"}, "on_target_hit": {"silent": true}}}
\`\`\`
`;
    const { dispatcher, ledgerDir } = makeDispatcher({ pushPolicyRef: policyRef }, { sendOutput: reply });
    await dispatcher.deliver(Msg.chat(0, { text: 'hi' }));

    // on_phase_error: silent stripped, channel applied.
    expect(policyRef.on_phase_error.silent).not.toBe(true);
    expect(policyRef.on_phase_error.channel).toBe('email');
    // on_target_hit is not critical → silence honoured.
    expect(policyRef.on_target_hit.silent).toBe(true);

    // decisions.jsonl should record both the block + the merge.
    const decisionsPath = path.join(ledgerDir, 'decisions.jsonl');
    expect(fs.existsSync(decisionsPath)).toBe(true);
    const lines = fs
      .readFileSync(decisionsPath, 'utf-8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(lines.some((l) => l.kind === 'policy_silence_blocked')).toBe(true);
    expect(lines.some((l) => l.kind === 'update_push_policy')).toBe(true);
  });
});

describe('ClaudeAgentDispatcher — stageReviewSandbox whitelist', () => {
  it('preserves reviewer_memory.md AND reviewer_log.jsonl across iters', async () => {
    const { dispatcher, ledgerDir } = makeDispatcher();
    await dispatcher.spawnSubagents();
    const sandbox = path.join(ledgerDir, 'reviewer_sandbox');
    fs.writeFileSync(path.join(sandbox, 'reviewer_memory.md'), 'memory');
    fs.writeFileSync(path.join(sandbox, 'reviewer_log.jsonl'), '{"a":1}\n');
    fs.writeFileSync(path.join(sandbox, 'scratch.txt'), 'temp');
    // Plant an iter dir so stageReviewSandbox can copy from it.
    const iterDir = path.join(ledgerDir, 'iter', '0');
    fs.mkdirSync(iterDir, { recursive: true });
    fs.writeFileSync(path.join(iterDir, 'directive.json'), '{}');

    // Reviewer needs to actually emit a review_complete or we'll observe a
    // 'hold' fallback. We just stub sendOutput to include a valid block.
    // Easier: directly call the private method via type assertion.
    (dispatcher as unknown as { stageReviewSandbox(iter: number): void }).stageReviewSandbox(0);

    expect(fs.existsSync(path.join(sandbox, 'reviewer_memory.md'))).toBe(true);
    expect(fs.existsSync(path.join(sandbox, 'reviewer_log.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(sandbox, 'scratch.txt'))).toBe(false);
  });
});

describe('ClaudeAgentDispatcher — auto-compact', () => {
  it('fires compact + writes decisions.jsonl when contextPercent crosses threshold', async () => {
    const { dispatcher, calls, ledgerDir } = makeDispatcher(
      { compactThresholds: { planner: 50 } },
      { contextPercent: 90, sendOutput: 'no autoloop blocks here' },
    );

    await dispatcher.deliver(Msg.chat(0, { text: 'hi' }));

    expect(calls.compactSession).toHaveBeenCalledTimes(1);
    const decisionsPath = path.join(ledgerDir, 'decisions.jsonl');
    const lines = fs
      .readFileSync(decisionsPath, 'utf-8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    const compactEntry = lines.find((l) => l.kind === 'compact');
    expect(compactEntry).toBeDefined();
    expect(compactEntry.payload.agent).toBe('planner');
  });
});

describe('ClaudeAgentDispatcher — ledger schema_version', () => {
  it('stamps schema_version on directive.json', async () => {
    const { dispatcher, calls, ledgerDir } = makeDispatcher({}, { sendOutput: 'no blocks' });
    await dispatcher.spawnSubagents();
    void calls; // unused
    await dispatcher.deliver(Msg.directive(0, { goal: 'g', constraints: [], success_criteria: [], max_attempts: 1 }));
    const written = JSON.parse(fs.readFileSync(path.join(ledgerDir, 'iter', '0', 'directive.json'), 'utf-8'));
    expect(written.schema_version).toBe(LEDGER_SCHEMA_VERSION);
  });
});
