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
    expect(registration.tools).toHaveLength(77);
    expect(registration.tools.has('codex_thread_list')).toBe(true);
    expect(registration.tools.has('codex_threads')).toBe(false);
  });
});
