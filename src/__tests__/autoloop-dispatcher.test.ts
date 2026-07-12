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
import { Msg } from '../autoloop/messages.js';
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
    const { dispatcher } = makeDispatcher({}, { sendThrows: 2 });
    await dispatcher.spawnSubagents();
    const replies = await dispatcher.deliver(
      Msg.directive(0, { goal: 'g', constraints: [], success_criteria: [], max_attempts: 1 }),
    );
    expect(replies).toHaveLength(1);
    expect(replies[0].type).toBe('phase_error');
    if (replies[0].type === 'phase_error') {
      expect(replies[0].payload.agent).toBe('coder');
      expect(replies[0].payload.phase).toBe('send');
    }
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
