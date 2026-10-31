import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import plugin from '../index.js';
import { SessionManager } from '../session-manager.js';

interface RegisteredTool {
  name: string;
  execute: (toolCallId: string, params: Record<string, unknown>) => Promise<unknown>;
}

interface AgentToolResult {
  content: Array<{ type: 'text'; text: string }>;
  details: unknown;
}

function collectTools(): { tools: Map<string, RegisteredTool>; stop: () => void } {
  const tools = new Map<string, RegisteredTool>();
  let stop = () => {};
  const fakeApi = {
    pluginConfig: {},
    logger: { info: () => {}, error: () => {}, warn: () => {} },
    registerTool: (definition: RegisteredTool) => tools.set(definition.name, definition),
    on: () => {},
    registerHttpRoute: () => {},
    registerService: (service: { stop: () => void }) => {
      stop = service.stop;
    },
  };

  (plugin as unknown as { register: (api: unknown) => void }).register(fakeApi);
  return { tools, stop: () => stop() };
}

describe('OpenClaw tool result contract', () => {
  const registration = collectTools();
  const codexModels = vi.spyOn(SessionManager.prototype, 'codexModels');

  beforeAll(() => {
    vi.stubEnv('CLAWO_NO_EMBEDDED_SERVER', '1');
  });

  afterAll(() => {
    registration.stop();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('wraps a plain handler payload in content and details', async () => {
    const payload = { ok: true as const, models: [{ id: 'gpt-test' }] };
    codexModels.mockResolvedValueOnce(payload);

    const result = (await registration.tools.get('codex_models')!.execute('call-1', {
      name: 'session-1',
    })) as AgentToolResult;

    expect(result).toEqual({
      content: [
        { type: 'text', text: '{\n  "ok": true,\n  "models": [\n    {\n      "id": "gpt-test"\n    }\n  ]\n}' },
      ],
      details: payload,
    });
    expect(result.details).toBe(payload);
  });

  it('serializes BigInt values in text while preserving the details payload', async () => {
    const payload = { ok: true as const, models: [{ contextWindow: 128_000n }] };
    codexModels.mockResolvedValueOnce(payload);

    const result = (await registration.tools.get('codex_models')!.execute('call-2', {
      name: 'session-1',
    })) as AgentToolResult;

    expect(result.content).toEqual([
      {
        type: 'text',
        text: '{\n  "ok": true,\n  "models": [\n    {\n      "contextWindow": "128000"\n    }\n  ]\n}',
      },
    ]);
    expect(result.details).toBe(payload);
  });

  it('preserves an existing AgentToolResult object by identity', async () => {
    const existing: AgentToolResult = {
      content: [{ type: 'text', text: 'already wrapped' }],
      details: { ok: true },
    };
    codexModels.mockResolvedValueOnce(existing as never);

    const result = await registration.tools.get('codex_models')!.execute('call-3', {
      name: 'session-1',
    });

    expect(result).toBe(existing);
  });

  it('propagates the original handler exception', async () => {
    const error = new Error('codex app-server unavailable');
    codexModels.mockRejectedValueOnce(error);

    const promise = registration.tools.get('codex_models')!.execute('call-4', {
      name: 'session-1',
    });

    await expect(promise).rejects.toBe(error);
  });

  it('registers only the namespaced Codex thread-listing tool', () => {
    expect(registration.tools).toHaveLength(79);
    expect(registration.tools.has('codex_thread_list')).toBe(true);
    expect(registration.tools.has('codex_threads')).toBe(false);
    expect(registration.tools.has('autoloop_resume')).toBe(true);
  });

  it('autoloop_resume normalizes {ok,state} by identity and masks thrown manager errors', async () => {
    const state = {
      run_id: 'resume-contract',
      status: 'paused',
      iter: 1,
      subagents_spawned: true,
      started_at: '2026-10-29T00:00:00.000Z',
      workspace: '/tmp',
      ledger_dir: '/tmp/tasks/resume-contract',
      push_log_count: 0,
      status_reason: 'awaiting_resume',
      consecutive_phase_errors: 0,
      recent_phase_errors: [],
      metric_history: [],
      last_activity_at: 0,
    };
    const resume = vi.spyOn(SessionManager.prototype, 'autoloopResume').mockResolvedValue(state as never);
    try {
      const result = (await registration.tools.get('autoloop_resume')!.execute('resume-ok', {
        run_id: 'resume-contract',
      })) as AgentToolResult;
      const payload = { ok: true as const, state };
      expect(result.details).toEqual(payload);
      expect((result.details as { state: unknown }).state).toBe(state);
      expect(result.content[0]?.type).toBe('text');
      expect(result.content[0]?.text).toContain('"ok": true');

      const sentinel = 'SECRET_SENTINEL_CONTRACT';
      resume.mockRejectedValueOnce(new Error(`manager boom ${sentinel}`));
      let caught: unknown;
      try {
        await registration.tools.get('autoloop_resume')!.execute('resume-err', { run_id: 'resume-contract' });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toBe('Autoloop resume failed');
      expect(String(caught)).not.toContain(sentinel);
      expect(resume).toHaveBeenCalledTimes(2);
    } finally {
      resume.mockRestore();
    }
  });
});
