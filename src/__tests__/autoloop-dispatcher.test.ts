/**
 * Tests for ClaudeAgentDispatcher — the layer between the runner's message
 * bus and the real persistent Claude sessions. We stub SessionManager so the
 * tests stay hermetic; only behaviour owned by the dispatcher (frozen-memory
 * injection, sandbox staging, send-failure surfacing, decisions audit, policy
 * silencing guard) is exercised.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import fsDefault, * as fs from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import { ClaudeAgentDispatcher } from '../autoloop/dispatcher.js';
import { AutoloopRunner } from '../autoloop/runner.js';
import { type AnyAutoloopMessage, Msg } from '../autoloop/messages.js';
import type { SessionManager } from '../session-manager.js';
import type { PushPolicy } from '../autoloop/types.js';
import { DEFAULT_PUSH_POLICY, LEDGER_SCHEMA_VERSION } from '../autoloop/types.js';

/** Mirror of dispatcher deriveDispatchId — system identity only, never model text. */
function expectedDispatchId(runId: string, env: AnyAutoloopMessage): string {
  const identity = JSON.stringify([runId, env.msg_id, env.iter, env.from, env.to, env.type]);
  return `dispatch_${createHash('sha256').update(identity).digest('hex')}`;
}

interface StubCalls {
  startSession: ReturnType<typeof vi.fn>;
  sendMessage: ReturnType<typeof vi.fn>;
  stopSession: ReturnType<typeof vi.fn>;
  hasSession: ReturnType<typeof vi.fn>;
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
    hasSession: vi.fn(() => true),
    getStatus: vi.fn(() => ({
      stats: { contextPercent: opts.contextPercent ?? 10, tokensIn: 0, tokensOut: 0, cachedTokens: 0 },
    })),
    compactSession: vi.fn(async () => undefined),
  };
  const manager = {
    startSession: calls.startSession,
    sendMessage: calls.sendMessage,
    stopSession: calls.stopSession,
    hasSession: calls.hasSession,
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

function plannerControl(tool: string, args: Record<string, unknown>): string {
  return `\`\`\`autoloop\n${JSON.stringify({ tool, args })}\n\`\`\``;
}

describe('ClaudeAgentDispatcher — role engine configuration', () => {
  it('keeps the legacy Claude model defaults when no role overrides are provided', async () => {
    const { dispatcher, calls } = makeDispatcher();

    await dispatcher.deliver(Msg.chat(0, { text: 'hello' }));
    await dispatcher.spawnSubagents();

    expect(findStart(calls, 'planner')).toMatchObject({
      engine: 'claude',
      model: 'opus',
      permissionMode: 'manual',
      sandboxMode: 'read-only',
    });
    expect(findStart(calls, 'coder')).toMatchObject({ engine: 'claude', model: 'sonnet' });
    expect(findStart(calls, 'reviewer')).toMatchObject({ engine: 'claude', model: 'sonnet' });
    expect(findStart(calls, 'planner')).not.toHaveProperty('effort');
    expect(findStart(calls, 'coder')).not.toHaveProperty('effort');
    expect(findStart(calls, 'reviewer')).not.toHaveProperty('effort');
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

  it('keeps each configured effort across Planner engine overrides and eager resets', async () => {
    const { dispatcher, calls } = makeDispatcher({
      plannerEffort: 'high',
      coderEffort: 'ultra',
      reviewerEffort: 'low',
    });

    await dispatcher.deliver(Msg.chat(0, { text: 'hello' }));
    await dispatcher.spawnSubagents({
      coder_engine: 'codex',
      coder_model: 'gpt-coder',
      reviewer_engine: 'gemini',
      coder_effort: 'low',
      reviewer_effort: 'max',
    } as never);

    expect(findStart(calls, 'planner')).toMatchObject({ effort: 'high' });
    expect(findStart(calls, 'coder')).toMatchObject({ engine: 'codex', model: 'gpt-coder', effort: 'ultra' });
    expect(findStart(calls, 'reviewer')).toMatchObject({ engine: 'gemini', effort: 'low' });

    await dispatcher.resetAgent('coder', { eagerRestart: true });
    await dispatcher.resetAgent('reviewer', { eagerRestart: true });

    const latestStart = (role: 'coder' | 'reviewer') =>
      calls.startSession.mock.calls
        .map((entry) => entry[0] as Record<string, unknown>)
        .filter((config) => config.name === `autoloop-r1-${role}`)
        .at(-1);
    expect(latestStart('coder')).toMatchObject({ effort: 'ultra' });
    expect(latestStart('reviewer')).toMatchObject({ effort: 'low' });
  });

  it('delivers the Planner protocol in-band and starts non-Claude Planners read-only', async () => {
    const { dispatcher, calls } = makeDispatcher({ plannerEngine: 'codex' });

    await dispatcher.deliver(Msg.chat(0, { text: 'inspect this repository' }));

    const start = findStart(calls, 'planner');
    expect(start).toMatchObject({
      permissionMode: 'manual',
      sandboxMode: 'read-only',
    });
    expect(start).not.toHaveProperty('permissionMode', 'bypassPermissions');
    const systemPrompt = start.systemPrompt as string;
    expect(systemPrompt).toMatch(/native shell\/file tools must not create `plan\.md` or `goal\.json`/i);
    expect(systemPrompt).toContain('fenced in-band controls');
    expect(systemPrompt).toContain('`write_plan`, `write_goal`, and approved `spawn_subagents`');
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

  it('rejects an acp role before startSession: a role cannot name the ACP agent', async () => {
    const { dispatcher, calls } = makeDispatcher({ plannerEngine: 'acp' });

    await expect(dispatcher.deliver(Msg.chat(0, { text: 'hello' }))).rejects.toThrow(
      "Planner engine 'acp' is not supported by Autoloop",
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

  it('does not restart or clear a role when its live session cannot be stopped', async () => {
    const { dispatcher, calls } = makeDispatcher();
    await dispatcher.spawnSubagents();

    calls.stopSession.mockRejectedValueOnce(new Error('coder still live'));

    await expect(dispatcher.resetAgent('coder', { eagerRestart: true })).rejects.toThrow('coder still live');

    const coderStarts = calls.startSession.mock.calls.filter(
      (entry) => (entry[0] as { name: string }).name === 'autoloop-r1-coder',
    );
    expect(coderStarts).toHaveLength(1);
    await expect(dispatcher.spawnSubagents({ coder_engine: 'codex' })).rejects.toThrow(
      'Cannot change Coder engine or model after its session has started',
    );
  });

  it('restarts a role once when the failed stop confirms its session is already absent', async () => {
    const { manager, calls } = makeStubManager();
    calls.hasSession.mockReturnValue(false);
    const dispatcher = new ClaudeAgentDispatcher({ manager, runId: 'r1', workspace: tmpRoot });
    await dispatcher.spawnSubagents();

    calls.stopSession.mockRejectedValueOnce(new Error("Session 'autoloop-r1-coder' not found"));

    await expect(dispatcher.resetAgent('coder', { eagerRestart: true })).resolves.toBeUndefined();

    const coderStarts = calls.startSession.mock.calls.filter(
      (entry) => (entry[0] as { name: string }).name === 'autoloop-r1-coder',
    );
    expect(coderStarts).toHaveLength(2);
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

describe('ClaudeAgentDispatcher — Planner control transactions', () => {
  it('rejects a malformed control batch without writes, spawn, or an initial directive', async () => {
    const originalPlan = '# original plan\n';
    const originalGoal = '{"original":true}\n';
    fs.writeFileSync(path.join(tmpRoot, 'plan.md'), originalPlan);
    fs.writeFileSync(path.join(tmpRoot, 'goal.json'), originalGoal);
    const spawn = vi.fn(async () => undefined);
    const reply = [
      plannerControl('write_plan', { content: '# replacement plan\n' }),
      '```autoloop\n{malformed json\n```',
      plannerControl('spawn_subagents', { initial_directive: { goal: 'must not run' } }),
    ].join('\n');
    const { dispatcher } = makeDispatcher({ onSpawnSubagents: spawn }, { sendOutput: reply });

    const emitted = await dispatcher.deliver(Msg.chat(0, { text: 'apply the batch' }));

    expect(fs.readFileSync(path.join(tmpRoot, 'plan.md'), 'utf-8')).toBe(originalPlan);
    expect(fs.readFileSync(path.join(tmpRoot, 'goal.json'), 'utf-8')).toBe(originalGoal);
    expect(spawn).not.toHaveBeenCalled();
    expect(emitted.filter((message) => message.type === 'directive')).toEqual([]);
  });

  it('restores pre-existing artifacts and suppresses spawn when an artifact write fails', async () => {
    const originalPlan = '# original plan\n';
    const originalGoal = '{"original":true}\n';
    const replacementPlan = '# replacement plan\n';
    const replacementGoal = '{"replacement":true}\n';
    const planPath = path.join(tmpRoot, 'plan.md');
    const goalPath = path.join(tmpRoot, 'goal.json');
    fs.writeFileSync(planPath, originalPlan);
    fs.writeFileSync(goalPath, originalGoal);
    const spawn = vi.fn(async () => undefined);
    const reply = [
      plannerControl('write_plan', { content: replacementPlan }),
      plannerControl('write_goal', { content: replacementGoal }),
      plannerControl('spawn_subagents', { initial_directive: { goal: 'must not run' } }),
    ].join('\n');
    const { dispatcher } = makeDispatcher({ onSpawnSubagents: spawn }, { sendOutput: reply });

    // Fail the second visible replacement, after plan.md has been replaced,
    // so the transaction must restore the first file from its byte snapshot.
    const originalRenameSync = fsDefault.renameSync;
    let failed = false;
    fsDefault.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
      if (!failed && path.resolve(String(to)) === goalPath) {
        failed = true;
        throw new Error('simulated artifact replacement failure');
      }
      return originalRenameSync(from, to);
    }) as typeof fs.renameSync;
    syncBuiltinESMExports();
    let emitted: AnyAutoloopMessage[] = [];
    try {
      emitted = await dispatcher.deliver(Msg.chat(0, { text: 'apply the batch' }));
    } finally {
      fsDefault.renameSync = originalRenameSync;
      syncBuiltinESMExports();
    }

    expect(fs.readFileSync(planPath, 'utf-8')).toBe(originalPlan);
    expect(fs.readFileSync(goalPath, 'utf-8')).toBe(originalGoal);
    expect(spawn).not.toHaveBeenCalled();
    expect(emitted.filter((message) => message.type === 'directive')).toEqual([]);
  });

  it('materializes exact artifacts before exactly one spawn and initial directive', async () => {
    const plan = '# exact plan\n\nNo normalization.\n';
    const goal = '{\n  "scalar": null,\n  "gates": []\n}\n';
    const observedAtSpawn: Array<{ plan: string; goal: string }> = [];
    const spawn = vi.fn(async () => {
      observedAtSpawn.push({
        plan: fs.readFileSync(path.join(tmpRoot, 'plan.md'), 'utf-8'),
        goal: fs.readFileSync(path.join(tmpRoot, 'goal.json'), 'utf-8'),
      });
    });
    const reply = [
      plannerControl('spawn_subagents', { initial_directive: { goal: 'ship exact artifacts' } }),
      plannerControl('write_plan', { content: plan }),
      plannerControl('write_goal', { content: goal }),
    ].join('\n');
    const { dispatcher } = makeDispatcher({ onSpawnSubagents: spawn }, { sendOutput: reply });

    const emitted = await dispatcher.deliver(Msg.chat(0, { text: 'approved' }));

    expect(observedAtSpawn).toEqual([{ plan, goal }]);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(emitted.filter((message) => message.type === 'directive')).toHaveLength(1);
  });

  it('rejects duplicate spawn controls without duplicate startup or directives', async () => {
    const spawn = vi.fn(async () => undefined);
    const reply = [
      plannerControl('spawn_subagents', { initial_directive: { goal: 'first' } }),
      plannerControl('spawn_subagents', { initial_directive: { goal: 'second' } }),
    ].join('\n');
    const { dispatcher } = makeDispatcher({ onSpawnSubagents: spawn }, { sendOutput: reply });

    const emitted = await dispatcher.deliver(Msg.chat(0, { text: 'approved once' }));

    expect(spawn).not.toHaveBeenCalled();
    expect(emitted.filter((message) => message.type === 'directive')).toEqual([]);
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
  it('returns a phase_error instead of an empty directive_ack when Coder returns no output', async () => {
    const { dispatcher } = makeDispatcher({}, { sendOutput: '   ' });
    await dispatcher.spawnSubagents();

    const replies = await dispatcher.deliver(
      Msg.directive(0, { goal: 'g', constraints: [], success_criteria: [], max_attempts: 1 }),
    );

    expect(replies).toHaveLength(1);
    expect(replies[0].type).toBe('phase_error');
    if (replies[0].type === 'phase_error') {
      expect(replies[0].payload.agent).toBe('coder');
    }
  });

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

  it('returns a phase_error when automatic reset cannot stop a live Coder', async () => {
    const { dispatcher, calls } = makeDispatcher({}, { sendThrows: 1 });
    await dispatcher.spawnSubagents();
    calls.stopSession.mockRejectedValueOnce(new Error('coder still live'));

    const replies = await dispatcher.deliver(
      Msg.directive(0, { goal: 'g', constraints: [], success_criteria: [], max_attempts: 1 }),
    );

    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({
      type: 'phase_error',
      payload: { agent: 'coder', phase: 'send', error: 'coder still live' },
    });
    expect(calls.sendMessage).toHaveBeenCalledTimes(1);
    expect(calls.stopSession).toHaveBeenCalledTimes(1);
    expect(
      calls.startSession.mock.calls.filter((entry) => (entry[0] as { name: string }).name === 'autoloop-r1-coder'),
    ).toHaveLength(1);
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

  it('bounds the retained dispatch cache while still coalescing a recent re-delivery', async () => {
    const { dispatcher, calls } = makeDispatcher();
    calls.sendMessage.mockResolvedValue({ output: '', error: undefined });
    const retained = dispatcher as unknown as { logicalDispatches: Map<string, unknown> };

    const recent = fixedIdentity(Msg.chat(1, { text: 'recent turn' }), 'logical-recent');
    await dispatcher.deliver(recent);
    const sendsAfterRecent = calls.sendMessage.mock.calls.length;

    // Far more distinct dispatches than the cache is allowed to hold.
    for (let i = 0; i < 200; i++) {
      await dispatcher.deliver(fixedIdentity(Msg.chat(1, { text: `turn ${i}` }), `logical-bulk-${i}`));
    }

    expect(retained.logicalDispatches.size).toBeLessThanOrEqual(64);

    // A dispatch well inside the retention window is still deduped, not re-sent.
    // Deliberately not the very last one: that survives even a cache of size 1,
    // so it could not tell a real window from a degenerate one.
    const sendsBeforeReplay = calls.sendMessage.mock.calls.length;
    await dispatcher.deliver(fixedIdentity(Msg.chat(1, { text: 'turn 190' }), 'logical-bulk-190'));
    expect(calls.sendMessage.mock.calls.length).toBe(sendsBeforeReplay);
    expect(sendsAfterRecent).toBeGreaterThan(0);
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

// The role prompts send these entries through a tool rather than a file write —
// the Coder may not touch `tasks/` at all — so nothing lands unless the
// dispatcher appends what the tool carries.
describe('ClaudeAgentDispatcher — coder_log / reviewer_log', () => {
  const readJsonl = (file: string) =>
    fs
      .readFileSync(file, 'utf-8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));

  it('appends each coder_log message to <ledger>/coder_log.jsonl', async () => {
    const { dispatcher, ledgerDir } = makeDispatcher(
      {},
      {
        sendOutput: [
          'Tried the cache, no gain.',
          plannerControl('coder_log', { message: 'LRU cache did not move the metric' }),
          plannerControl('coder_log', { message: 'next: try batching' }),
        ].join('\n'),
      },
    );
    await dispatcher.spawnSubagents();
    await dispatcher.deliver(Msg.directive(0, { goal: 'g', constraints: [], success_criteria: [], max_attempts: 1 }));

    const rows = readJsonl(path.join(ledgerDir, 'coder_log.jsonl'));
    expect(rows.map((r) => [r.iter, r.message])).toEqual([
      [0, 'LRU cache did not move the metric'],
      [0, 'next: try batching'],
    ]);
    expect(typeof rows[0].ts).toBe('string');
  });

  it('appends reviewer_log to the reviewer_log.jsonl kept in the Reviewer sandbox', async () => {
    const { dispatcher, ledgerDir } = makeDispatcher(
      {},
      { sendOutput: plannerControl('reviewer_log', { message: 'eval set unchanged since iter 1' }) },
    );
    await dispatcher.spawnSubagents();
    await dispatcher.deliver(Msg.reviewRequest(2, { iter: 2, ledger_path: ledgerDir, prior_metrics: [] }));

    const rows = readJsonl(path.join(ledgerDir, 'reviewer_sandbox', 'reviewer_log.jsonl'));
    expect(rows.map((r) => [r.iter, r.message])).toEqual([[2, 'eval set unchanged since iter 1']]);
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

// An Autoloop left idle past `sessionTtlMinutes` has its role sessions evicted
// by the manager, while the dispatcher still believed them started — so the
// next message failed with "Session not found". It now checks, and starts the
// role again under the same name, which picks the persisted conversation back up.
describe('ClaudeAgentDispatcher — evicted role sessions', () => {
  function makeTrackedDispatcher() {
    const { manager, calls } = makeStubManager();
    const live = new Set<string>();
    calls.startSession.mockImplementation(async (config: { name: string }) => {
      live.add(config.name);
      return { name: config.name, state: 'ready' };
    });
    (manager as unknown as { hasSession: (name: string) => boolean }).hasSession = (name) => live.has(name);
    const dispatcher = new ClaudeAgentDispatcher({ manager, runId: 'r1', workspace: tmpRoot });
    const starts = (role: string) =>
      calls.startSession.mock.calls.filter((c) => (c[0] as { name: string }).name === `autoloop-r1-${role}`).length;
    return { dispatcher, live, starts, ledgerDir: path.join(tmpRoot, 'tasks', 'r1') };
  }

  it('starts the Planner again after its session was evicted', async () => {
    const { dispatcher, live, starts } = makeTrackedDispatcher();
    await dispatcher.deliver(Msg.chat(0, { text: 'hello' }));
    await dispatcher.deliver(Msg.chat(0, { text: 'still there?' }));
    expect(starts('planner')).toBe(1);

    live.delete('autoloop-r1-planner');
    await dispatcher.deliver(Msg.chat(0, { text: 'after a long idle' }));
    expect(starts('planner')).toBe(2);
  });

  it('starts the Coder and the Reviewer again after their sessions were evicted', async () => {
    const { dispatcher, live, starts, ledgerDir } = makeTrackedDispatcher();
    const directive = () =>
      dispatcher.deliver(
        Msg.directive(0, { goal: 'change one file', constraints: [], success_criteria: [], max_attempts: 1 }),
      );
    const review = () =>
      dispatcher.deliver(Msg.reviewRequest(0, { iter: 0, ledger_path: ledgerDir, prior_metrics: [] }));

    await dispatcher.spawnSubagents();
    await directive();
    await review();
    expect([starts('coder'), starts('reviewer')]).toEqual([1, 1]);

    live.delete('autoloop-r1-coder');
    live.delete('autoloop-r1-reviewer');
    await directive();
    await review();
    expect([starts('coder'), starts('reviewer')]).toEqual([2, 2]);
  });
});

describe('ClaudeAgentDispatcher — partial Coder terminal handoff', () => {
  const MARKER = 'TERMINAL_PARTIAL_NO_FREEZE_CONCLUSION_UNIQUE_9f3c';
  const longReply = () => `${'A'.repeat(520)}\n${MARKER}\nend`;
  const d0 = (goal: string) => Msg.directive(0, { goal, constraints: [], success_criteria: [], max_attempts: 1 });
  const plannerPrompts = (c: StubCalls) =>
    c.sendMessage.mock.calls.filter((x) => x[0] === 'autoloop-r1-planner').map((x) => x[1] as string);
  const replyPath = (text: string) => text.match(/persisted at handoff:\s+([^\s"]+\.txt)/)?.[1];

  it('incomplete reply path characterization', async () => {
    const replies = ['ORDINARY_INCOMPLETE_REPLY_ITER_0_BYTES_UNIQUE', 'ORDINARY_INCOMPLETE_REPLY_ITER_1_BYTES_UNIQUE'];
    const { dispatcher, ledgerDir, workspace } = makeDispatcher({}, { sendOutputs: replies });
    await dispatcher.spawnSubagents();

    const seenRels: string[] = [];
    for (const iter of [0, 1] as const) {
      const acks = await dispatcher.deliver(
        Msg.directive(iter, {
          goal: `characterize-iter-${iter}`,
          constraints: [],
          success_criteria: [],
          max_attempts: 1,
        }),
      );
      expect(acks).toHaveLength(1);
      expect(acks[0]).toMatchObject({
        type: 'directive_ack',
        payload: { understood: false },
      });
      expect(acks.some((m) => m.type === 'review_request' || m.type === 'iter_artifacts')).toBe(false);

      const clarification = (acks[0] as { payload: { clarification: string } }).payload.clarification;
      const rel = replyPath(clarification);
      expect(rel).toBeTruthy();
      expect(path.basename(rel!)).toMatch(/^coder_reply_.+\.txt$/);
      expect(path.dirname(rel!)).toBe(path.join('tasks', 'r1', 'iter', String(iter)));

      const abs = path.join(workspace, rel!);
      expect(path.dirname(abs)).toBe(path.join(ledgerDir, 'iter', String(iter)));
      expect(fs.existsSync(abs)).toBe(true);
      expect(fs.readFileSync(abs, 'utf8')).toBe(replies[iter]);
      expect(path.resolve(workspace, rel!)).toBe(path.resolve(abs));
      expect(clarification).toContain(`Full coder reply persisted at handoff: ${rel}`);
      seenRels.push(rel!);
    }

    expect(seenRels[0]).not.toBe(seenRels[1]);
    expect(path.dirname(seenRels[0])).not.toBe(path.dirname(seenRels[1]));
  });

  it('G1: incomplete turn exposes status, terminal tail and persisted path', async () => {
    const reply = longReply();
    expect(reply.indexOf(MARKER)).toBeGreaterThan(500);
    const { dispatcher, calls, workspace } = makeDispatcher({}, { sendOutput: reply });
    await dispatcher.spawnSubagents();
    const acks = await dispatcher.deliver(d0('g'));
    const clarification = (acks[0] as { payload: { clarification: string } }).payload.clarification;
    expect(acks[0]).toMatchObject({ type: 'directive_ack', payload: { understood: false } });
    expect(clarification).toMatch(/without (a )?valid iter_complete/i);
    expect(clarification).toMatch(/send_directive[\s\S]*ask (the )?user[\s\S]*\bstop\b/i);
    expect(clarification).toContain(MARKER);
    const rel = replyPath(clarification);
    expect(rel && fs.readFileSync(path.join(workspace, rel), 'utf8')).toContain(MARKER);
    await dispatcher.deliver(acks[0]);
    expect(plannerPrompts(calls).at(-1) ?? '').toContain(MARKER);
  });

  it('G2: valid iter_complete emits iter_artifacts', async () => {
    const ic = plannerControl('iter_complete', {
      summary: 'ok',
      eval_output: { metric: 1 },
      files_changed: [],
    });
    const { dispatcher, workspace } = makeDispatcher({}, { sendOutput: `done\n${ic}` });
    const { execFileSync } = await import('node:child_process');
    for (const args of [
      ['init'],
      ['config', 'user.email', 't@e'],
      ['config', 'user.name', 't'],
      ['commit', '--allow-empty', '-m', 'b'],
    ]) {
      execFileSync('git', args, { cwd: workspace });
    }
    await dispatcher.spawnSubagents();
    const out = await dispatcher.deliver(d0('g'));
    expect(out.some((m) => m.type === 'iter_artifacts')).toBe(true);
    expect(out.some((m) => m.type === 'directive_ack')).toBe(false);
  });

  it('G3: short clarification ack (multiline normalized)', async () => {
    const q = 'Line one?\nLine two about eval?';
    const { dispatcher, calls } = makeDispatcher(
      {},
      { sendOutput: `Need a decision.\n${plannerControl('request_clarification', { question: q })}` },
    );
    await dispatcher.spawnSubagents();
    const acks = await dispatcher.deliver(d0('g'));
    expect(acks[0]).toMatchObject({
      type: 'directive_ack',
      payload: { understood: false, clarification: 'Line one? Line two about eval?' },
    });
    await dispatcher.deliver(acks[0]);
    const prompt = plannerPrompts(calls).at(-1) ?? '';
    expect(prompt).toContain('Line one? Line two about eval?');
    expect(prompt).not.toMatch(/without (a )?valid iter_complete/i);
  });

  it('G4: real Planner two-directive batch keeps distinct handoffs without review/advance', async () => {
    const { manager, calls } = makeStubManager();
    const workspace = tmpRoot;
    const dispatcher = new ClaudeAgentDispatcher({ manager, runId: 'r1', workspace });
    let coderTurns = 0;
    let plannerTurns = 0;
    const directiveBatch = ['first', 'second']
      .map((goal) => plannerControl('send_directive', { goal, constraints: [], success_criteria: [], max_attempts: 1 }))
      .join('\n');
    calls.sendMessage.mockImplementation(async (name: string) => {
      if (name === 'autoloop-r1-coder') {
        coderTurns += 1;
        const tag = coderTurns === 1 ? 'FIRST_QUEUED_REPLY' : 'SECOND_QUEUED_REPLY';
        return { output: `${'P'.repeat(800)}${tag}`, error: undefined };
      }
      if (name === 'autoloop-r1-planner') {
        plannerTurns += 1;
        return { output: plannerTurns === 1 ? directiveBatch : 'ack', error: undefined };
      }
      return { output: '', error: undefined };
    });
    const types: string[] = [];
    const runner = new AutoloopRunner({
      run_id: 'r1',
      workspace,
      ledger_dir: path.join(workspace, 'tasks', 'r1'),
      dispatcher,
      notifyUser: vi.fn(async () => undefined),
      stallCheckIntervalMs: 86_400_000,
    });
    runner.on('message', (env: AnyAutoloopMessage) => types.push(env.type));
    await runner.start();
    await dispatcher.spawnSubagents();
    try {
      await runner.chat('two explicit directives');
      expect(coderTurns).toBe(2);
      expect(runner.state.iter).toBe(0);
      expect(types.some((t) => t === 'review_request' || t === 'iter_artifacts' || t === 'iter_done')).toBe(false);
      const handoffs = plannerPrompts(calls).filter((p) => /without (a )?valid iter_complete/i.test(p));
      expect(handoffs).toHaveLength(2);
      expect(handoffs[0]).toContain('FIRST_QUEUED_REPLY');
      expect(handoffs[0]).not.toContain('SECOND_QUEUED_REPLY');
      expect(handoffs[1]).toContain('SECOND_QUEUED_REPLY');
      const refs = handoffs.map((p) => replyPath(p)!);
      expect(refs[0]).not.toBe(refs[1]);
      expect(fs.readFileSync(path.join(workspace, refs[0]), 'utf8')).toContain('FIRST_QUEUED_REPLY');
      expect(fs.readFileSync(path.join(workspace, refs[1]), 'utf8')).toContain('SECOND_QUEUED_REPLY');
    } finally {
      runner.stop();
    }
  });

  it('G5: oversized/control tails stay bounded; write failure reports not persisted', async () => {
    for (const output of [`${'A'.repeat(12_000)}SAFE_TAIL_END`, `${'A'.repeat(12_000)}\u0007BAD`]) {
      const { dispatcher } = makeDispatcher({}, { sendOutput: output });
      await dispatcher.spawnSubagents();
      const acks = await dispatcher.deliver(d0('g'));
      const q = (acks[0] as { payload: { clarification: string } }).payload.clarification;
      expect(q.length).toBeLessThan(1100);
      expect(q).not.toContain('A'.repeat(501));
      expect(q).not.toContain('\u0007');
      if (output.includes('SAFE_TAIL_END')) expect(q).toContain('SAFE_TAIL_END');
      else expect(q).toMatch(/tail omitted|disallowed form/i);
    }

    const originalWrite = fsDefault.writeFileSync;
    fsDefault.writeFileSync = ((
      file: fs.PathLike | number,
      data: string | NodeJS.ArrayBufferView,
      options?: fs.WriteFileOptions,
    ) => {
      if (typeof file === 'string' && String(file).includes('coder_reply_')) throw new Error('EACCES');
      return originalWrite(file, data, options);
    }) as typeof fs.writeFileSync;
    syncBuiltinESMExports();
    try {
      const { dispatcher, calls } = makeDispatcher({}, { sendOutput: longReply() });
      await dispatcher.spawnSubagents();
      const acks = await dispatcher.deliver(d0('g'));
      await dispatcher.deliver(acks[0]);
      const p = plannerPrompts(calls).at(-1) ?? '';
      expect(p).toMatch(/not persisted/i);
      expect(p).toContain(MARKER);
      expect(p).not.toMatch(/persisted at handoff:/);
    } finally {
      fsDefault.writeFileSync = originalWrite;
      syncBuiltinESMExports();
    }
  });
});

describe('planner-control-feedback', () => {
  const INVALID_CONSTRAINTS_REPLY = [
    'Submitting the small fixture task.',
    plannerControl('send_directive', {
      goal: 'Update a synthetic README fixture',
      constraints: 'Only README.md',
      success_criteria: ['The fixture heading is present'],
      max_attempts: 1,
    }),
  ].join('\n');

  const BLOCK_ONLY_INVALID = plannerControl('send_directive', {
    goal: 'Update a synthetic README fixture',
    constraints: 'Only README.md',
    success_criteria: ['The fixture heading is present'],
    max_attempts: 1,
  });

  function readJsonl(file: string): Array<Record<string, unknown>> {
    if (!fs.existsSync(file)) return [];
    const raw = fs.readFileSync(file, 'utf-8').trim();
    if (!raw) return [];
    return raw.split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  it('invalid constraints plus prose emits safe notice, audit, identical event/history', async () => {
    const { dispatcher, ledgerDir } = makeDispatcher({}, { sendOutput: INVALID_CONSTRAINTS_REPLY });
    const replies: string[] = [];
    dispatcher.on('planner_reply', (text: string) => replies.push(text));

    const emitted = await dispatcher.deliver(Msg.chat(0, { text: 'submit fixture' }));

    expect(emitted.filter((message) => message.type === 'directive')).toEqual([]);
    expect(replies).toHaveLength(1);
    const combined = replies[0]!;
    expect(combined).toContain('Planner control error');
    expect(combined).toContain('Requested actions are not confirmed');
    expect(combined).toContain('Submitting the small fixture task.');
    expect(combined).toContain('send_directive constraints must be an array of strings');

    const chat = readJsonl(path.join(ledgerDir, 'chat.jsonl'));
    const plannerEntries = chat.filter((entry) => entry.who === 'planner');
    expect(plannerEntries).toHaveLength(1);
    expect(plannerEntries[0]!.text).toBe(combined);

    const decisions = readJsonl(path.join(ledgerDir, 'decisions.jsonl'));
    const controlErrors = decisions.filter((row) => row.kind === 'planner_control_error');
    expect(controlErrors).toHaveLength(1);
    expect(controlErrors[0]).toMatchObject({
      actor: 'dispatcher',
      payload: { count: 1 },
    });
    const details = (controlErrors[0]!.payload as { details: string[] }).details;
    expect(details).toEqual(['send_directive constraints must be an array of strings']);
  });

  it('block-only invalid control emits nonempty notice and zero directives', async () => {
    const { dispatcher, ledgerDir } = makeDispatcher({}, { sendOutput: BLOCK_ONLY_INVALID });
    const replies: string[] = [];
    dispatcher.on('planner_reply', (text: string) => replies.push(text));

    const emitted = await dispatcher.deliver(Msg.chat(0, { text: 'block only' }));

    expect(emitted.filter((message) => message.type === 'directive')).toEqual([]);
    expect(replies).toHaveLength(1);
    const combined = replies[0]!;
    expect(combined.length).toBeGreaterThan(0);
    expect(combined).toContain('Planner control error');
    expect(combined).toContain('send_directive constraints must be an array of strings');

    const chat = readJsonl(path.join(ledgerDir, 'chat.jsonl'));
    const plannerEntries = chat.filter((entry) => entry.who === 'planner');
    expect(plannerEntries).toHaveLength(1);
    expect(plannerEntries[0]!.text).toBe(combined);

    const decisions = readJsonl(path.join(ledgerDir, 'decisions.jsonl'));
    expect(decisions.filter((row) => row.kind === 'planner_control_error')).toHaveLength(1);
  });

  it('malformed mixed batch rejects all effects with generic parse notice', async () => {
    const originalPlan = '# original plan\n';
    const originalGoal = '{"original":true}\n';
    fs.writeFileSync(path.join(tmpRoot, 'plan.md'), originalPlan);
    fs.writeFileSync(path.join(tmpRoot, 'goal.json'), originalGoal);
    const policyRef: PushPolicy = JSON.parse(JSON.stringify(DEFAULT_PUSH_POLICY));
    const policyBefore = JSON.stringify(policyRef);
    expect(policyRef.on_start.channel).not.toBe('email');
    expect(policyRef.on_start.level).not.toBe('warn');
    const spawn = vi.fn(async () => undefined);
    const reply = [
      plannerControl('write_plan', { content: '# replacement\n' }),
      '```autoloop\n{malformed json\n```',
      plannerControl('update_push_policy', {
        on_start: { silent: false, level: 'warn', channel: 'email' },
      }),
      plannerControl('spawn_subagents', { initial_directive: { goal: 'must not run' } }),
      plannerControl('send_directive', {
        goal: 'must not run',
        constraints: [],
        success_criteria: [],
        max_attempts: 1,
      }),
    ].join('\n');
    const { dispatcher, ledgerDir } = makeDispatcher(
      { onSpawnSubagents: spawn, pushPolicyRef: policyRef },
      { sendOutput: reply },
    );
    const replies: string[] = [];
    dispatcher.on('planner_reply', (text: string) => replies.push(text));

    const emitted = await dispatcher.deliver(Msg.chat(0, { text: 'mixed batch' }));

    expect(fs.readFileSync(path.join(tmpRoot, 'plan.md'), 'utf-8')).toBe(originalPlan);
    expect(fs.readFileSync(path.join(tmpRoot, 'goal.json'), 'utf-8')).toBe(originalGoal);
    expect(JSON.stringify(policyRef)).toBe(policyBefore);
    expect(policyRef.on_start.channel).not.toBe('email');
    expect(spawn).not.toHaveBeenCalled();
    expect(emitted).toEqual([]);
    expect(replies[0]).toContain('Planner control error');
    expect(replies[0]).toContain('Unrecognized or malformed planner control block');
    expect(replies[0]).not.toMatch(/malformed json|SyntaxError|JSON/);
    expect(
      readJsonl(path.join(ledgerDir, 'decisions.jsonl')).filter((row) => row.kind === 'planner_control_error'),
    ).toHaveLength(1);
  });

  it.each([
    {
      name: 'send_directive.constraints',
      detail: 'send_directive constraints must be an array of strings',
      reply: [
        plannerControl('write_plan', { content: '# rewritten\n' }),
        plannerControl('update_push_policy', {
          on_start: { silent: false, level: 'warn', channel: 'email' },
        }),
        plannerControl('send_directive', {
          goal: 'a',
          constraints: 'bad',
          success_criteria: ['ok'],
          max_attempts: 1,
        }),
      ].join('\n'),
    },
    {
      name: 'send_directive.success_criteria',
      detail: 'send_directive success_criteria must be an array of strings',
      reply: [
        plannerControl('write_plan', { content: '# rewritten\n' }),
        plannerControl('update_push_policy', {
          on_start: { silent: false, level: 'warn', channel: 'email' },
        }),
        plannerControl('send_directive', {
          goal: 'a',
          constraints: ['ok'],
          success_criteria: 'bad',
          max_attempts: 1,
        }),
      ].join('\n'),
    },
    {
      name: 'spawn.constraints',
      detail: 'spawn_subagents initial_directive constraints must be an array of strings',
      reply: [
        plannerControl('write_plan', { content: '# rewritten\n' }),
        plannerControl('update_push_policy', {
          on_start: { silent: false, level: 'warn', channel: 'email' },
        }),
        plannerControl('spawn_subagents', {
          initial_directive: {
            goal: 'b',
            constraints: 'bad',
            success_criteria: ['ok'],
            max_attempts: 1,
          },
        }),
      ].join('\n'),
    },
    {
      name: 'spawn.success_criteria',
      detail: 'spawn_subagents initial_directive success_criteria must be an array of strings',
      reply: [
        plannerControl('write_plan', { content: '# rewritten\n' }),
        plannerControl('update_push_policy', {
          on_start: { silent: false, level: 'warn', channel: 'email' },
        }),
        plannerControl('spawn_subagents', {
          initial_directive: {
            goal: 'b',
            constraints: ['ok'],
            success_criteria: 'bad',
            max_attempts: 1,
          },
        }),
      ].join('\n'),
    },
  ])('exact static detail for $name in reply and audit', async ({ detail, reply }) => {
    const originalPlan = '# keep\n';
    fs.writeFileSync(path.join(tmpRoot, 'plan.md'), originalPlan);
    const policyRef: PushPolicy = JSON.parse(JSON.stringify(DEFAULT_PUSH_POLICY));
    const policyBefore = JSON.stringify(policyRef);
    const spawn = vi.fn(async () => undefined);
    const { dispatcher, ledgerDir } = makeDispatcher(
      { onSpawnSubagents: spawn, pushPolicyRef: policyRef },
      { sendOutput: reply },
    );
    const replies: string[] = [];
    dispatcher.on('planner_reply', (text: string) => replies.push(text));

    const emitted = await dispatcher.deliver(Msg.chat(0, { text: `t04-${detail}` }));

    expect(fs.readFileSync(path.join(tmpRoot, 'plan.md'), 'utf-8')).toBe(originalPlan);
    expect(JSON.stringify(policyRef)).toBe(policyBefore);
    expect(spawn).not.toHaveBeenCalled();
    expect(emitted).toEqual([]);
    expect(replies[0]).toBe(
      [
        'Planner control error. Requested actions are not confirmed; inspect run artifacts before retrying.',
        `1. ${detail}`,
      ].join('\n'),
    );
    const row = readJsonl(path.join(ledgerDir, 'decisions.jsonl')).find((r) => r.kind === 'planner_control_error')!;
    const payload = row.payload as { count: number; details: string[] };
    expect(payload.count).toBe(1);
    expect(payload.details).toEqual([detail]);
    expect(replies[0]).toContain(detail);
  });

  it('invalid0 then corrected1 in same Planner emits exact arrays', async () => {
    const corrected = plannerControl('send_directive', {
      goal: 'Update a synthetic README fixture',
      constraints: ['Only README.md'],
      success_criteria: ['The fixture heading is present'],
      max_attempts: 1,
    });
    const { dispatcher, calls } = makeDispatcher(
      {},
      { sendOutputs: [INVALID_CONSTRAINTS_REPLY, `Retrying.\n${corrected}`] },
    );

    const first = await dispatcher.deliver(Msg.chat(0, { text: 'invalid0' }));
    expect(first.filter((message) => message.type === 'directive')).toEqual([]);

    const second = await dispatcher.deliver(Msg.chat(0, { text: 'corrected1' }));
    const directives = second.filter((message) => message.type === 'directive');
    expect(directives).toHaveLength(1);
    expect(directives[0]).toMatchObject({
      type: 'directive',
      payload: {
        goal: 'Update a synthetic README fixture',
        constraints: ['Only README.md'],
        success_criteria: ['The fixture heading is present'],
        max_attempts: 1,
      },
    });
    expect(
      calls.startSession.mock.calls.filter((c) => (c[0] as { name: string }).name.endsWith('-planner')),
    ).toHaveLength(1);
  });

  it('concurrent and settled same-envelope redelivery keeps one send/event/audit', async () => {
    const { dispatcher, calls, ledgerDir } = makeDispatcher({}, { sendOutput: INVALID_CONSTRAINTS_REPLY });
    const replies: string[] = [];
    dispatcher.on('planner_reply', (text: string) => replies.push(text));
    const envelope = fixedIdentity(Msg.chat(0, { text: 'same envelope' }), 'pcf-t06');

    const a = dispatcher.deliver(envelope);
    const b = dispatcher.deliver({ ...envelope, ts: '2035-01-01T00:00:00.000Z' });
    const [emittedA, emittedB] = await Promise.all([a, b]);
    const emittedC = await dispatcher.deliver({ ...envelope, ts: '2035-01-02T00:00:00.000Z' });

    expect(calls.sendMessage).toHaveBeenCalledTimes(1);
    expect(emittedA).toEqual([]);
    expect(emittedB).toEqual([]);
    expect(emittedC).toEqual([]);
    expect(replies).toHaveLength(1);
    expect(
      readJsonl(path.join(ledgerDir, 'decisions.jsonl')).filter((row) => row.kind === 'planner_control_error'),
    ).toHaveLength(1);
  });

  it('corrected runner chat one Coder send; retained envelope replay reuses identities', async () => {
    const corrected = `ok\n${plannerControl('send_directive', {
      goal: 'ship fixture',
      constraints: ['Only README.md'],
      success_criteria: ['heading present'],
      max_attempts: 1,
    })}`;
    const { manager, calls } = makeStubManager();
    const workspace = tmpRoot;
    const dispatcher = new ClaudeAgentDispatcher({ manager, runId: 'r1', workspace });
    let plannerTurns = 0;
    let coderTurns = 0;
    calls.sendMessage.mockImplementation(async (name: string) => {
      if (name === 'autoloop-r1-coder') {
        coderTurns += 1;
        return { output: `${'P'.repeat(800)}T07_CODER_ONCE`, error: undefined };
      }
      if (name === 'autoloop-r1-planner') {
        plannerTurns += 1;
        return { output: plannerTurns === 1 ? corrected : 'ack', error: undefined };
      }
      return { output: '', error: undefined };
    });

    const captured: Array<{ inbound: AnyAutoloopMessage; outbound: AnyAutoloopMessage[] }> = [];
    const realDeliver = dispatcher.deliver.bind(dispatcher);
    dispatcher.deliver = async (env: AnyAutoloopMessage) => {
      const outbound = await realDeliver(env);
      captured.push({ inbound: structuredClone(env), outbound: structuredClone(outbound) });
      return outbound;
    };

    const runner = new AutoloopRunner({
      run_id: 'r1',
      workspace,
      ledger_dir: path.join(workspace, 'tasks', 'r1'),
      dispatcher,
      notifyUser: vi.fn(async () => undefined),
      stallCheckIntervalMs: 86_400_000,
    });
    await runner.start();
    await dispatcher.spawnSubagents();
    try {
      await runner.chat('corrected single directive');
      expect(coderTurns).toBe(1);

      const chatCapture = captured.find((c) => c.inbound.type === 'chat');
      const directiveCapture = captured.find((c) => c.inbound.type === 'directive');
      expect(chatCapture).toBeDefined();
      expect(directiveCapture).toBeDefined();
      expect(chatCapture!.outbound.filter((m) => m.type === 'directive')).toHaveLength(1);

      const plannerAfterRunner = plannerTurns;
      const coderAfterRunner = coderTurns;

      const replayedChat = await dispatcher.deliver(chatCapture!.inbound);
      expect(replayedChat.map((m) => m.msg_id)).toEqual(chatCapture!.outbound.map((m) => m.msg_id));
      expect(plannerTurns).toBe(plannerAfterRunner);

      const replayedDirective = await dispatcher.deliver(directiveCapture!.inbound);
      expect(replayedDirective.map((m) => m.msg_id)).toEqual(directiveCapture!.outbound.map((m) => m.msg_id));
      expect(coderTurns).toBe(coderAfterRunner);
      // Explicit: this asserts dispatcher retained-envelope identity only — not global runner-queue dedup.
    } finally {
      runner.stop();
    }
  });

  it('valid, prose-only, and nonrecognized fences invent no error notice', async () => {
    const cases = [
      {
        label: 'valid',
        output: `Done.\n${plannerControl('send_directive', {
          goal: 'ok',
          constraints: [],
          success_criteria: [],
          max_attempts: 1,
        })}`,
      },
      { label: 'prose', output: 'Just thinking about the plan.' },
      {
        label: 'json-fence',
        output: '```json\n{"tool":"send_directive","args":{"goal":"x","constraints":"bad"}}\n```',
      },
    ];
    for (const c of cases) {
      const { dispatcher, ledgerDir } = makeDispatcher({}, { sendOutput: c.output });
      const replies: string[] = [];
      dispatcher.on('planner_reply', (text: string) => replies.push(text));
      await dispatcher.deliver(Msg.chat(0, { text: c.label }));
      expect(replies.join('\n'), c.label).not.toContain('Planner control error');
      expect(
        readJsonl(path.join(ledgerDir, 'decisions.jsonl')).filter((row) => row.kind === 'planner_control_error'),
        c.label,
      ).toEqual([]);
    }
  });

  const ARRAY_VALUES: Array<{ name: string; value: unknown; accept: boolean }> = [
    { name: 'omitted', value: undefined, accept: true },
    { name: 'empty', value: [], accept: true },
    { name: 'strings', value: ['ok'], accept: true },
    { name: 'string', value: 'bad', accept: false },
    { name: 'null', value: null, accept: false },
    { name: 'numbers', value: [1], accept: false },
    { name: 'object', value: { a: 1 }, accept: false },
  ];

  it.each(
    (['constraints', 'success_criteria'] as const).flatMap((field) =>
      (['send_directive', 'spawn'] as const).flatMap((loc) => ARRAY_VALUES.map((v) => ({ loc, field, ...v }))),
    ),
  )('$loc $field $name accept=$accept', async ({ loc, field, value, accept }) => {
    const args: Record<string, unknown> =
      loc === 'send_directive'
        ? {
            goal: 'g',
            max_attempts: 1,
            ...(value === undefined ? {} : { [field]: value }),
            ...(field === 'constraints' ? { success_criteria: [] } : { constraints: [] }),
          }
        : {
            initial_directive: {
              goal: 'g',
              max_attempts: 1,
              ...(value === undefined ? {} : { [field]: value }),
              ...(field === 'constraints' ? { success_criteria: [] } : { constraints: [] }),
            },
          };
    const tool = loc === 'send_directive' ? 'send_directive' : 'spawn_subagents';
    const spawn = vi.fn(async () => undefined);
    const { dispatcher } = makeDispatcher({ onSpawnSubagents: spawn }, { sendOutput: plannerControl(tool, args) });
    const emitted = await dispatcher.deliver(Msg.chat(0, { text: 't09' }));
    if (accept) {
      if (loc === 'send_directive') {
        expect(emitted.filter((m) => m.type === 'directive')).toHaveLength(1);
      } else {
        expect(spawn).toHaveBeenCalledTimes(1);
      }
    } else {
      expect(emitted.filter((m) => m.type === 'directive')).toEqual([]);
      expect(spawn).not.toHaveBeenCalled();
    }
  });

  it.each([
    { name: 'empty-goal', args: { goal: '', constraints: [], success_criteria: [], max_attempts: 1 }, ok: false },
    { name: 'ws-goal', args: { goal: '   ', constraints: [], success_criteria: [], max_attempts: 1 }, ok: false },
    { name: 'num-goal', args: { goal: 1, constraints: [], success_criteria: [], max_attempts: 1 }, ok: false },
    { name: 'attempts-0', args: { goal: 'g', constraints: [], success_criteria: [], max_attempts: 0 }, ok: false },
    { name: 'attempts-neg', args: { goal: 'g', constraints: [], success_criteria: [], max_attempts: -1 }, ok: false },
    {
      name: 'attempts-float',
      args: { goal: 'g', constraints: [], success_criteria: [], max_attempts: 1.5 },
      ok: false,
    },
    {
      name: 'attempts-string',
      args: { goal: 'g', constraints: [], success_criteria: [], max_attempts: '1' },
      ok: false,
    },
    { name: 'attempts-1', args: { goal: 'g', constraints: [], success_criteria: [], max_attempts: 1 }, ok: true },
    { name: 'attempts-omitted', args: { goal: 'g', constraints: [], success_criteria: [] }, ok: true },
  ])('$name ok=$ok', async ({ args, ok }) => {
    const { dispatcher } = makeDispatcher({}, { sendOutput: plannerControl('send_directive', args) });
    const emitted = await dispatcher.deliver(Msg.chat(0, { text: 't10' }));
    const directives = emitted.filter((m) => m.type === 'directive');
    if (ok) {
      expect(directives).toHaveLength(1);
      expect(directives[0]).toMatchObject({
        payload: { goal: 'g', constraints: [], success_criteria: [], max_attempts: 1 },
      });
    } else {
      expect(directives).toEqual([]);
    }
  });

  it('hidden unknown-tool/engine sentinels absent from new sinks', async () => {
    const SENTINEL = 'INJECT_MARK\n\u0001X';
    const warns: string[] = [];
    const reply = [
      plannerControl(SENTINEL, { x: 1 }),
      plannerControl('spawn_subagents', { coder_engine: SENTINEL }),
    ].join('\n');
    const { dispatcher, ledgerDir } = makeDispatcher(
      {
        logger: {
          debug: () => undefined,
          info: () => undefined,
          warn: (msg: string) => {
            warns.push(msg);
          },
          error: () => undefined,
        },
      },
      { sendOutput: reply },
    );
    const replies: string[] = [];
    dispatcher.on('planner_reply', (text: string) => replies.push(text));
    await dispatcher.deliver(Msg.chat(0, { text: 't11' }));

    // Legacy operator raw sink keeps original tool/error; projection is chat/audit only.
    expect(warns.some((w) => w.includes("tool '") && w.includes('failed:'))).toBe(true);
    expect(warns.join('\n')).toContain('INJECT_MARK');
    expect(warns.join('\n')).not.toContain('Planner control error');

    const newSinks = [
      replies.join('\n'),
      fs.readFileSync(path.join(ledgerDir, 'chat.jsonl'), 'utf-8'),
      fs.readFileSync(path.join(ledgerDir, 'decisions.jsonl'), 'utf-8'),
    ];
    for (const sink of newSinks) {
      expect(sink).not.toContain('INJECT_MARK');
      expect(sink).not.toContain('\u0001');
    }
    expect(replies[0]).toContain('unknown planner tool');
    expect(replies[0]).toContain('spawn_subagents coder_engine has unknown engine');
    expect(replies[0]).not.toContain('Planner control rejected');
    expect(replies[0]).not.toContain(SENTINEL);
  });

  it('malformed/write_goal sentinel absent from new sinks', async () => {
    const SENTINEL = 'LEAK_JSON\n\u0001Y';
    const captureLogger = (warns: string[]) => ({
      debug: () => undefined,
      info: () => undefined,
      warn: (msg: string) => {
        warns.push(msg);
      },
      error: () => undefined,
    });

    {
      const warns: string[] = [];
      const { dispatcher, ledgerDir } = makeDispatcher(
        { logger: captureLogger(warns) },
        { sendOutput: '```autoloop\n{"tool":"send_directive","args":{"goal":"' + SENTINEL + '"\n```' },
      );
      const replies: string[] = [];
      dispatcher.on('planner_reply', (text: string) => replies.push(text));
      await dispatcher.deliver(Msg.chat(0, { text: 't12-malformed' }));
      expect(warns.some((w) => w.includes("tool '") && w.includes('failed:'))).toBe(true);
      expect(warns.join('\n')).not.toContain('Planner control error');
      const newSinks = [
        replies.join('\n'),
        fs.readFileSync(path.join(ledgerDir, 'chat.jsonl'), 'utf-8'),
        fs.readFileSync(path.join(ledgerDir, 'decisions.jsonl'), 'utf-8'),
      ];
      for (const sink of newSinks) {
        expect(sink).not.toContain('LEAK_JSON');
        expect(sink).not.toContain('\u0001');
      }
      expect(replies[0]).toContain('Planner control error');
      expect(replies[0]).toContain('Unrecognized or malformed planner control block');
    }

    {
      const warns: string[] = [];
      const { dispatcher, ledgerDir } = makeDispatcher(
        { logger: captureLogger(warns) },
        { sendOutput: plannerControl('write_goal', { content: `{${SENTINEL}` }) },
      );
      const replies: string[] = [];
      dispatcher.on('planner_reply', (text: string) => replies.push(text));
      await dispatcher.deliver(Msg.chat(0, { text: 't12-write-goal' }));
      expect(warns.some((w) => w.includes("tool '") && w.includes('failed:'))).toBe(true);
      const newSinks = [
        replies.join('\n'),
        fs.readFileSync(path.join(ledgerDir, 'chat.jsonl'), 'utf-8'),
        fs.readFileSync(path.join(ledgerDir, 'decisions.jsonl'), 'utf-8'),
      ];
      for (const sink of newSinks) {
        expect(sink).not.toContain('LEAK_JSON');
        expect(sink).not.toContain('\u0001');
      }
      expect(replies[0]).toContain('write_goal content is not valid JSON');
      expect(replies[0]).not.toContain('Planner control rejected');
      expect(warns.join('\n')).not.toContain('Planner control error');
    }
  });

  it('twenty invalid controls bound details and report exact count', async () => {
    const longAttacker = `ATTACK_${'Z'.repeat(500)}`;
    const blocks = Array.from({ length: 20 }, (_, i) =>
      plannerControl('send_directive', {
        goal: 'g',
        constraints: i === 0 ? longAttacker : 'bad',
        success_criteria: [],
        max_attempts: 1,
      }),
    ).join('\n');
    const { dispatcher, ledgerDir } = makeDispatcher({}, { sendOutput: blocks });
    const replies: string[] = [];
    dispatcher.on('planner_reply', (text: string) => replies.push(text));
    await dispatcher.deliver(Msg.chat(0, { text: 't13' }));

    expect(replies).toHaveLength(1);
    expect(replies[0]!.length).toBeLessThanOrEqual(1024);
    expect(replies[0]).not.toContain('ATTACK_');
    expect(replies[0]).not.toContain(longAttacker.slice(0, 40));
    const row = readJsonl(path.join(ledgerDir, 'decisions.jsonl')).find((r) => r.kind === 'planner_control_error')!;
    const payload = row.payload as { count: number; details: string[]; omitted: number };
    expect(payload.count).toBe(20);
    expect(payload.details).toHaveLength(4);
    expect(payload.omitted).toBe(16);
    for (const d of payload.details) {
      expect(d.length).toBeLessThanOrEqual(160);
      expect(d).toBe('send_directive constraints must be an array of strings');
    }
  });

  it('partial artifact success then effect error stays generic without false rollback', async () => {
    const PRINTABLE = 'EFFECT_LEAK';
    const C0 = '\u0001';
    const SENTINEL = `${PRINTABLE}\n${C0}Z`;
    const plan = '# staged plan\n';
    const warns: string[] = [];
    const spawn = vi.fn(async () => {
      throw new Error(`spawn failed ${SENTINEL}`);
    });
    const reply = [
      plannerControl('write_plan', { content: plan }),
      plannerControl('spawn_subagents', { initial_directive: { goal: 'after write' } }),
    ].join('\n');
    const { dispatcher, ledgerDir, calls } = makeDispatcher(
      {
        onSpawnSubagents: spawn,
        logger: {
          debug: () => undefined,
          info: () => undefined,
          warn: (msg: string) => {
            warns.push(msg);
          },
          error: () => undefined,
        },
      },
      { sendOutput: reply },
    );
    const replies: string[] = [];
    dispatcher.on('planner_reply', (text: string) => replies.push(text));

    const emitted = await dispatcher.deliver(Msg.chat(0, { text: 't14' }));

    expect(fs.readFileSync(path.join(tmpRoot, 'plan.md'), 'utf-8')).toBe(plan);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(emitted.filter((m) => m.type === 'directive')).toEqual([]);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain('Planner control error');
    expect(replies[0]).toContain('Requested actions are not confirmed');
    expect(replies[0]).toContain('inspect run artifacts');
    expect(replies[0]).toContain('Planner control rejected');
    expect(replies[0]).not.toMatch(/nothing was applied|zero effects|rolled back|auto-?retr/i);

    const history = fs.readFileSync(path.join(ledgerDir, 'chat.jsonl'), 'utf-8');
    const audit = fs.readFileSync(path.join(ledgerDir, 'decisions.jsonl'), 'utf-8');
    // Legacy raw per-error warn keeps the effect failure text for operators.
    expect(warns.some((w) => w.includes("tool 'spawn_subagents' failed:") && w.includes(PRINTABLE))).toBe(true);
    expect(warns.join('\n')).not.toContain('Planner control error');
    const newSinks = [replies[0]!, history, audit];
    for (const sink of newSinks) {
      expect(sink).not.toContain(PRINTABLE);
      expect(sink).not.toContain(C0);
    }
    expect(calls.sendMessage).toHaveBeenCalledTimes(1);
    // No automatic resend of the failed effect path.
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('audit/history survive reconstruction without dispatch', async () => {
    const { dispatcher, ledgerDir, workspace } = makeDispatcher({}, { sendOutput: INVALID_CONSTRAINTS_REPLY });
    const replies: string[] = [];
    dispatcher.on('planner_reply', (text: string) => replies.push(text));
    const chatEnv = fixedIdentity(Msg.chat(0, { text: 't15' }), 'pcf-t15-chat');
    await dispatcher.deliver(chatEnv);
    expect(replies).toHaveLength(1);
    const expectedId = expectedDispatchId('r1', chatEnv);

    const decisionsBefore = readJsonl(path.join(ledgerDir, 'decisions.jsonl'));
    const controlRow = decisionsBefore.find((row) => row.kind === 'planner_control_error')!;
    expect(controlRow).toMatchObject({
      actor: 'dispatcher',
      payload: {
        iter: 0,
        dispatch_id: expectedId,
        count: 1,
        details: ['send_directive constraints must be an array of strings'],
      },
    });
    const historyBefore = readJsonl(path.join(ledgerDir, 'chat.jsonl'));
    const plannerHistory = historyBefore.filter((e) => e.who === 'planner');
    expect(plannerHistory).toHaveLength(1);
    expect(plannerHistory[0]!.text).toBe(replies[0]);

    const beforeDecisionsRaw = fs.readFileSync(path.join(ledgerDir, 'decisions.jsonl'), 'utf-8');
    const beforeChatRaw = fs.readFileSync(path.join(ledgerDir, 'chat.jsonl'), 'utf-8');

    const { manager, calls } = makeStubManager({ sendOutput: 'should not send' });
    const reconstructed = new ClaudeAgentDispatcher({ manager, runId: 'r1', workspace });
    void reconstructed;
    expect(fs.readFileSync(path.join(ledgerDir, 'decisions.jsonl'), 'utf-8')).toBe(beforeDecisionsRaw);
    expect(fs.readFileSync(path.join(ledgerDir, 'chat.jsonl'), 'utf-8')).toBe(beforeChatRaw);
    const decisionsAfter = readJsonl(path.join(ledgerDir, 'decisions.jsonl'));
    const rowAfter = decisionsAfter.find((row) => row.kind === 'planner_control_error')!;
    expect(rowAfter.payload).toMatchObject({
      iter: 0,
      dispatch_id: expectedId,
      count: 1,
    });
    expect(readJsonl(path.join(ledgerDir, 'chat.jsonl')).filter((e) => e.who === 'planner')[0]!.text).toBe(replies[0]);
    expect(calls.sendMessage).not.toHaveBeenCalled();
  });

  it('decision append failure preserves feedback without claimed persistence', async () => {
    const warns: string[] = [];
    const { dispatcher, ledgerDir } = makeDispatcher(
      {
        logger: {
          debug: () => undefined,
          info: () => undefined,
          warn: (msg: string) => {
            warns.push(msg);
          },
          error: () => undefined,
        },
      },
      { sendOutput: INVALID_CONSTRAINTS_REPLY },
    );
    fs.mkdirSync(ledgerDir, { recursive: true });
    fs.mkdirSync(path.join(ledgerDir, 'decisions.jsonl'));
    const replies: string[] = [];
    dispatcher.on('planner_reply', (text: string) => replies.push(text));

    const emitted = await dispatcher.deliver(Msg.chat(0, { text: 't16' }));

    expect(emitted).toEqual([]);
    expect(replies[0]).toContain('Planner control error');
    expect(replies[0]).toContain('Submitting the small fixture task.');
    expect(warns.some((w) => w.includes('decisions.jsonl append failed'))).toBe(true);
    expect(warns.join('\n')).not.toMatch(/persisted successfully|exactly-once/i);
    const chat = readJsonl(path.join(ledgerDir, 'chat.jsonl'));
    expect(chat.filter((e) => e.who === 'planner')[0]!.text).toBe(replies[0]);
  });

  it('valid multi-controls, two directives, iter_done N+1 preserved', async () => {
    const reply = [
      plannerControl('notify_user', { level: 'info', summary: 'hi' }),
      plannerControl('send_directive', {
        goal: 'first',
        constraints: [],
        success_criteria: [],
        max_attempts: 1,
      }),
      plannerControl('send_directive', {
        goal: 'second',
        constraints: ['c'],
        success_criteria: ['s'],
        max_attempts: 1,
      }),
    ].join('\n');
    const { dispatcher } = makeDispatcher({}, { sendOutput: reply });
    const chatOut = await dispatcher.deliver(Msg.chat(0, { text: 'multi' }));
    expect(chatOut.filter((m) => m.type === 'push_user')).toHaveLength(1);
    expect(chatOut.filter((m) => m.type === 'directive')).toHaveLength(2);

    const { dispatcher: d2 } = makeDispatcher(
      {},
      {
        sendOutput: plannerControl('send_directive', {
          goal: 'after-done',
          constraints: [],
          success_criteria: [],
          max_attempts: 1,
        }),
      },
    );
    const afterDone = await d2.deliver(Msg.iterDone(3, { iter: 3, verdict: 'advance', metric: 1 }));
    const next = afterDone.find((m) => m.type === 'directive');
    expect(next?.iter).toBe(4);
  });
});

describe('planner-control-revision', () => {
  function readJsonl(file: string): Array<Record<string, unknown>> {
    if (!fs.existsSync(file)) return [];
    const raw = fs.readFileSync(file, 'utf-8').trim();
    if (!raw) return [];
    return raw.split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  /**
   * Load the real private projector + its constants from dispatcher.ts via AST
   * extract + transpile. Artificial inputs only — not reachable producer text.
   */
  function loadActualPlannerControlProjector(): (
    errors: Array<{ tool: string; error: string }>,
    origin: 'validation' | 'effect' | 'parse',
  ) => { diagnostic: string; details: string[]; count: number; omitted: number } {
    const dispatcherPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../autoloop/dispatcher.ts');
    const source = fs.readFileSync(dispatcherPath, 'utf-8');
    const require = createRequire(import.meta.url);
    const ts = require('typescript') as typeof import('typescript');
    const ast = ts.createSourceFile('dispatcher.ts', source, ts.ScriptTarget.Latest, true);
    const selected = ast.statements.filter(
      (n) =>
        (ts.isVariableStatement(n) &&
          n.declarationList.declarations.some((d) => d.name.getText(ast).startsWith('PLANNER_CONTROL_'))) ||
        (ts.isFunctionDeclaration(n) && n.name?.text === 'projectPlannerControlErrors'),
    );
    expect(selected.filter((n) => ts.isFunctionDeclaration(n))).toHaveLength(1);
    const exactText = selected.map((n) => n.getText(ast)).join('\n');
    const js = ts.transpileModule(exactText, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText;
    return vm.runInNewContext(`${js}\nprojectPlannerControlErrors;`, {}) as (
      errors: Array<{ tool: string; error: string }>,
      origin: 'validation' | 'effect' | 'parse',
    ) => { diagnostic: string; details: string[]; count: number; omitted: number };
  }

  function captureLogger(warns: string[]) {
    return {
      debug: () => undefined,
      info: () => undefined,
      warn: (msg: string) => {
        warns.push(msg);
      },
      error: () => undefined,
    };
  }

  it('useful validation messages surface for empty write_plan, missing notify summary, typo tool, and duplicates', async () => {
    const cases: Array<{ reply: string; detail: string }> = [
      {
        reply: plannerControl('write_plan', { content: '   ' }),
        detail: 'write_plan requires non-empty `content` (full plan.md body)',
      },
      {
        reply: plannerControl('notify_user', { level: 'info', summary: '' }),
        detail: 'notify_user requires `summary`',
      },
      {
        reply: plannerControl('send_directiv', {
          goal: 'g',
          constraints: [],
          success_criteria: [],
          max_attempts: 1,
        }),
        detail: 'unknown planner tool: send_directiv',
      },
      {
        reply: [
          plannerControl('write_plan', { content: '# a\n' }),
          plannerControl('write_plan', { content: '# b\n' }),
        ].join('\n'),
        detail: 'duplicate write_plan control in one Planner batch',
      },
    ];
    for (const { reply, detail } of cases) {
      const warns: string[] = [];
      const { dispatcher, ledgerDir } = makeDispatcher({ logger: captureLogger(warns) }, { sendOutput: reply });
      const replies: string[] = [];
      dispatcher.on('planner_reply', (text: string) => replies.push(text));
      await dispatcher.deliver(Msg.chat(0, { text: `rev-${detail.slice(0, 24)}` }));
      expect(replies[0]).toContain(detail);
      expect(warns.some((w) => w.includes("tool '") && w.includes('failed:') && w.includes(detail))).toBe(true);
      expect(warns.join('\n')).not.toContain('Planner control error');
      // Shared tmp ledger accumulates rows across loop cases — take the latest.
      const audits = readJsonl(path.join(ledgerDir, 'decisions.jsonl')).filter(
        (r) => r.kind === 'planner_control_error',
      );
      const audit = audits[audits.length - 1]!;
      expect((audit.payload as { details: string[] }).details).toContain(detail);
    }
  });

  it('hostile unknown-tool names stay generic; permitted ASCII identifier bounds are reflected', async () => {
    const maxOk = 'a' + 'b'.repeat(47);
    const overlong = 'a' + 'b'.repeat(48);
    const cases: Array<{ tool: string; expectName: boolean }> = [
      { tool: 'send_directiv', expectName: true },
      { tool: maxOk, expectName: true },
      { tool: overlong, expectName: false },
      { tool: 'BadCase', expectName: false },
      { tool: 'has-dash', expectName: false },
      { tool: 'has space', expectName: false },
      { tool: 'newline\ntool', expectName: false },
      { tool: 'unicodé_tool', expectName: false },
      { tool: 'autoloop block 0', expectName: false },
    ];
    for (const { tool, expectName } of cases) {
      const { dispatcher } = makeDispatcher({}, { sendOutput: plannerControl(tool, { x: 1 }) });
      const replies: string[] = [];
      dispatcher.on('planner_reply', (text: string) => replies.push(text));
      await dispatcher.deliver(Msg.chat(0, { text: `tool-${tool.slice(0, 12)}` }));
      if (expectName) {
        expect(replies[0]).toContain(`unknown planner tool: ${tool}`);
      } else {
        expect(replies[0]).toContain('unknown planner tool');
        expect(replies[0]).not.toContain(tool.split('\n')[0]!);
        expect(replies[0]).not.toContain('Planner control rejected');
      }
    }
  });

  it('effect failures with validation-looking text and forged properties stay generic in new sinks', async () => {
    const LOOKS_VALID = 'write_plan requires non-empty `content` (full plan.md body)';
    const warns: string[] = [];
    const spawn = vi.fn(async () => {
      const err = new Error(LOOKS_VALID) as Error & { origin?: string; detail?: string };
      err.origin = 'validation';
      err.detail = LOOKS_VALID;
      throw err;
    });
    const { dispatcher, ledgerDir } = makeDispatcher(
      { onSpawnSubagents: spawn, logger: captureLogger(warns) },
      {
        sendOutput: [
          plannerControl('write_plan', { content: '# keep\n' }),
          plannerControl('spawn_subagents', { initial_directive: { goal: 'g' } }),
        ].join('\n'),
      },
    );
    const replies: string[] = [];
    dispatcher.on('planner_reply', (text: string) => replies.push(text));
    await dispatcher.deliver(Msg.chat(0, { text: 'forged-effect' }));
    expect(fs.readFileSync(path.join(tmpRoot, 'plan.md'), 'utf-8')).toBe('# keep\n');
    expect(replies[0]).toContain('Planner control rejected');
    expect(replies[0]).not.toContain(LOOKS_VALID);
    expect(warns.some((w) => w.includes(LOOKS_VALID))).toBe(true);
    const audit = fs.readFileSync(path.join(ledgerDir, 'decisions.jsonl'), 'utf-8');
    expect(audit).not.toContain(LOOKS_VALID);
  });

  it('spoofed autoloop-block tool name is not treated as parse origin', async () => {
    const { dispatcher } = makeDispatcher({}, { sendOutput: plannerControl('autoloop block 0', { goal: 'x' }) });
    const replies: string[] = [];
    dispatcher.on('planner_reply', (text: string) => replies.push(text));
    await dispatcher.deliver(Msg.chat(0, { text: 'spoof-parse' }));
    expect(replies[0]).not.toContain('Unrecognized or malformed planner control block');
    expect(replies[0]).toContain('unknown planner tool');
    expect(replies[0]).not.toContain('autoloop block 0');
  });

  it('records longest reachable producer safe detail under 160 and exercises renderer 160 boundary separately', async () => {
    // Natural producer-authored validation messages in planner-tools are all <160.
    // Longest currently reachable authored validation detail (measured, not fabricated):
    const LONGEST = 'spawn_subagents cannot include custom engine config; configure it at autoloop_start';
    // Measured length of this reachable producer message (all natural details are ≤160).
    expect(LONGEST.length).toBe(83);
    expect(LONGEST.length).toBeLessThanOrEqual(160);
    const { dispatcher, ledgerDir } = makeDispatcher(
      {},
      {
        sendOutput: plannerControl('spawn_subagents', {
          coder_custom_engine: { name: 'x', bin: 'y', args: {} },
        }),
      },
    );
    const replies: string[] = [];
    dispatcher.on('planner_reply', (text: string) => replies.push(text));
    await dispatcher.deliver(Msg.chat(0, { text: 'longest-natural' }));
    expect(replies[0]).toContain(LONGEST);
    const row = readJsonl(path.join(ledgerDir, 'decisions.jsonl')).find((r) => r.kind === 'planner_control_error')!;
    expect((row.payload as { details: string[] }).details[0]).toBe(LONGEST);

    // Artificial inputs into the ACTUAL private renderer (extracted from production
    // source). Not reachable producer messages and not a duplicated local algorithm.
    const project = loadActualPlannerControlProjector();
    for (const length of [159, 160, 161, 200] as const) {
      const errors = Array.from({ length: 7 }, () => ({
        tool: 'artificial_renderer_input',
        error: 'V'.repeat(length),
      }));
      const result = project(errors, 'validation');
      expect(result.count).toBe(7);
      expect(result.omitted).toBe(3);
      expect(result.details).toHaveLength(4);
      for (const detail of result.details) {
        expect(detail.length).toBe(Math.min(length, 160));
      }
      expect(result.diagnostic.length).toBeLessThanOrEqual(1024);
      expect(result.diagnostic).toContain('Planner control error');
    }
  });
});
