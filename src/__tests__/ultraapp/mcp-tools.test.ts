/**
 * Verify the ultraapp MCP write tools dispatch correctly to the manager.
 *
 * Captures plugin tool registrations against a fake PluginAPI, replaces
 * SessionManager.getUltraappManager with a stub recording the calls, and
 * invokes each registered tool's `execute` to confirm method dispatch.
 */
import { describe, it, expect, vi } from 'vitest';
import plugin from '../../index.js';
import { SessionManager } from '../../session-manager.js';

interface CapturedTool {
  name: string;
  execute: (id: string, args: Record<string, unknown>) => Promise<unknown>;
}

function captureTools(): Map<string, CapturedTool> {
  const out = new Map<string, CapturedTool>();
  const fakeApi = {
    pluginConfig: {},
    logger: { info: () => {}, error: () => {}, warn: () => {} },
    registerTool: (def: { name: string; execute: CapturedTool['execute'] }) => {
      out.set(def.name, { name: def.name, execute: def.execute });
    },
    on: () => {},
    registerHttpRoute: () => {},
    registerService: () => {},
  };
  (plugin as unknown as { register: (api: unknown) => void }).register(fakeApi);
  return out;
}

function stubUltraappManager() {
  return {
    createRun: vi.fn().mockResolvedValue('ua-test-1'),
    submitAnswer: vi.fn().mockResolvedValue(undefined),
    addFile: vi.fn().mockResolvedValue({ ref: '/tmp/example.txt' }),
    applySpecEdit: vi.fn().mockResolvedValue(undefined),
    startBuild: vi.fn().mockResolvedValue(undefined),
    cancelBuild: vi.fn(),
    submitDoneModeMessage: vi.fn().mockResolvedValue(undefined),
    promoteVersion: vi.fn().mockResolvedValue({ ok: true }),
    startContainer: vi.fn().mockResolvedValue({ ok: true }),
    stopContainer: vi.fn().mockResolvedValue({ ok: true }),
    deleteRun: vi.fn().mockResolvedValue({ ok: true }),
    store: {
      listRuns: vi.fn().mockResolvedValue([]),
      readSpec: vi.fn().mockResolvedValue({ meta: { name: 'demo' } }),
      readChat: vi.fn().mockResolvedValue([]),
      readState: vi.fn().mockResolvedValue({ runId: 'ua-test-1', mode: 'interview' }),
    },
  };
}

describe('ultraapp write MCP tools dispatch', () => {
  const tools = captureTools();
  const stub = stubUltraappManager();
  // Patch SessionManager.prototype.getUltraappManager so any
  // `new SessionManager().getUltraappManager()` returns our stub.
  vi.spyOn(SessionManager.prototype, 'getUltraappManager').mockReturnValue(stub as never);

  it('ultraapp_new → createRun', async () => {
    const r = await tools.get('ultraapp_new')!.execute('id', {});
    expect(stub.createRun).toHaveBeenCalled();
    expect((r as { details: { runId: string } }).details.runId).toBe('ua-test-1');
  });

  it('ultraapp_answer → submitAnswer', async () => {
    await tools.get('ultraapp_answer')!.execute('id', {
      runId: 'ua-test-1',
      value: 'a',
      freeform: 'with caveat',
    });
    expect(stub.submitAnswer).toHaveBeenCalledWith('ua-test-1', {
      value: 'a',
      freeform: 'with caveat',
    });
  });

  it('ultraapp_add_file → addFile (path mode)', async () => {
    await tools.get('ultraapp_add_file')!.execute('id', {
      runId: 'ua-test-1',
      absolutePath: '/tmp/example.txt',
    });
    expect(stub.addFile).toHaveBeenCalledWith('ua-test-1', {
      kind: 'path',
      absolutePath: '/tmp/example.txt',
    });
  });

  it('ultraapp_spec_edit → applySpecEdit', async () => {
    await tools.get('ultraapp_spec_edit')!.execute('id', {
      runId: 'ua-test-1',
      patch: [{ op: 'replace', path: '/meta/name', value: 'x' }],
    });
    expect(stub.applySpecEdit).toHaveBeenCalled();
  });

  it('ultraapp_build_start → startBuild', async () => {
    await tools.get('ultraapp_build_start')!.execute('id', { runId: 'ua-test-1' });
    expect(stub.startBuild).toHaveBeenCalledWith('ua-test-1');
  });

  it('ultraapp_build_cancel → cancelBuild', async () => {
    await tools.get('ultraapp_build_cancel')!.execute('id', { runId: 'ua-test-1' });
    expect(stub.cancelBuild).toHaveBeenCalledWith('ua-test-1');
  });

  it('ultraapp_feedback → submitDoneModeMessage', async () => {
    await tools.get('ultraapp_feedback')!.execute('id', {
      runId: 'ua-test-1',
      text: 'make button green',
    });
    expect(stub.submitDoneModeMessage).toHaveBeenCalledWith('ua-test-1', 'make button green');
  });

  it('ultraapp_promote_version → promoteVersion', async () => {
    await tools.get('ultraapp_promote_version')!.execute('id', {
      runId: 'ua-test-1',
      version: 'v2',
    });
    expect(stub.promoteVersion).toHaveBeenCalledWith('ua-test-1', 'v2');
  });

  it('ultraapp_start_container → startContainer', async () => {
    await tools.get('ultraapp_start_container')!.execute('id', { runId: 'ua-test-1' });
    expect(stub.startContainer).toHaveBeenCalledWith('ua-test-1');
  });

  it('ultraapp_stop_container → stopContainer', async () => {
    await tools.get('ultraapp_stop_container')!.execute('id', { runId: 'ua-test-1' });
    expect(stub.stopContainer).toHaveBeenCalledWith('ua-test-1');
  });

  it('ultraapp_delete → deleteRun', async () => {
    await tools.get('ultraapp_delete')!.execute('id', { runId: 'ua-test-1' });
    expect(stub.deleteRun).toHaveBeenCalledWith('ua-test-1');
  });
});
