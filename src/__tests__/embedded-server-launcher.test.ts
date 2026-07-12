import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as net from 'node:net';
import * as path from 'node:path';
import { SessionManager } from '../session-manager.js';
import { EmbeddedServer } from '../embedded-server.js';
import type { CouncilSession } from '../types.js';
import { useIsolatedHome } from './helpers/isolate-home.js';

// Tests construct real EmbeddedServer instances, which write to
// ~/.openclaw/server-token and re-read it per request. Isolating $HOME to a
// per-file temp dir keeps that token file local to this worker, so the real
// user token is never touched and parallel test files don't clobber each
// other's token (which otherwise causes timing-dependent 401s).
useIsolatedHome();

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

describe('token file write-order', () => {
  it('does NOT overwrite ~/.openclaw/server-token when bind fails (EADDRINUSE)', async () => {
    const mgr1 = new SessionManager({});
    // EmbeddedServer treats `0 || DEFAULT_SERVER_PORT` as DEFAULT, not ephemeral,
    // so we explicitly grab a free port to keep this test isolated from any
    // standalone clawo-serve that may be running on the default port.
    const ephemeral = await freePort();
    const s1 = new EmbeddedServer(mgr1, ephemeral);
    const port = await s1.start();
    expect(port).toBeGreaterThan(0);

    const tokenPath = path.join(os.homedir(), '.openclaw', 'server-token');
    const winnerToken = fs.readFileSync(tokenPath, 'utf-8').trim();

    // Second instance forced onto the same port → must hit EADDRINUSE and skip
    // WITHOUT touching the token file the winner wrote.
    const mgr2 = new SessionManager({});
    const s2 = new EmbeddedServer(mgr2, port);
    const port2 = await s2.start();
    expect(port2).toBe(0);

    const afterToken = fs.readFileSync(tokenPath, 'utf-8').trim();
    expect(afterToken).toBe(winnerToken);

    await s1.stop();
    await mgr1.shutdown();
    await mgr2.shutdown();
  });

  it('reuses the on-disk token across restarts so the browser cookie stays valid', async () => {
    const mgr1 = new SessionManager({});
    const ephemeral = await freePort();
    const s1 = new EmbeddedServer(mgr1, ephemeral);
    const port1 = await s1.start();
    expect(port1).toBeGreaterThan(0);

    const tokenPath = path.join(os.homedir(), '.openclaw', 'server-token');
    const firstToken = fs.readFileSync(tokenPath, 'utf-8').trim();
    expect(firstToken).toMatch(/^[0-9a-fA-F]{32,}$/);

    // Stop the first server. The new contract is: stop does NOT remove the
    // token file. The token persists so the next server can pick it up.
    await s1.stop();
    expect(fs.existsSync(tokenPath)).toBe(true);
    const tokenAfterStop = fs.readFileSync(tokenPath, 'utf-8').trim();
    expect(tokenAfterStop).toBe(firstToken);

    // Start a fresh server on a (probably different) free port. It must
    // adopt the persisted token instead of rotating.
    const ephemeral2 = await freePort();
    const mgr2 = new SessionManager({});
    const s2 = new EmbeddedServer(mgr2, ephemeral2);
    const port2 = await s2.start();
    expect(port2).toBeGreaterThan(0);

    const secondToken = fs.readFileSync(tokenPath, 'utf-8').trim();
    expect(secondToken).toBe(firstToken);

    await s2.stop();
    await mgr1.shutdown();
    await mgr2.shutdown();
  });
});

describe('POST /council/new', () => {
  let manager: SessionManager;
  let server: EmbeddedServer;
  let port: number;
  let token: string;

  beforeAll(async () => {
    manager = new SessionManager({});
    // councilStart spawns real Claude subprocesses — stub it for the unit test.
    vi.spyOn(manager, 'councilStart').mockImplementation(
      (task: string): CouncilSession => ({
        id: 'fake-council-id-001',
        task,
        status: 'running',
        startTime: '2026-05-13T05:00:00.000Z',
        responses: [],
        config: { agents: [], maxRounds: 0, projectDir: '/tmp' },
      }),
    );
    const ephemeral = await freePort();
    server = new EmbeddedServer(manager, ephemeral);
    port = await server.start();
    token = fs.readFileSync(path.join(os.homedir(), '.openclaw', 'server-token'), 'utf-8').trim();
  });
  afterAll(async () => {
    await server.stop();
    await manager.shutdown();
  });

  it('starts a council and returns its id', async () => {
    const r = await fetch(`http://127.0.0.1:${port}/council/new`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ task: 'test task', projectDir: '/tmp' }),
    });
    expect(r.status).toBe(200);
    const j = (await r.json()) as { ok: boolean; id: string; status: string };
    expect(j.ok).toBe(true);
    expect(j.id).toBe('fake-council-id-001');
    expect(j.status).toBe('running');
    expect(manager.councilStart).toHaveBeenCalledOnce();
  });

  it('returns 400 when task is missing', async () => {
    const r = await fetch(`http://127.0.0.1:${port}/council/new`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ projectDir: '/tmp' }),
    });
    expect(r.status).toBe(400);
  });

  it('returns 400 when projectDir is missing', async () => {
    const r = await fetch(`http://127.0.0.1:${port}/council/new`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ task: 'just a task' }),
    });
    expect(r.status).toBe(400);
  });
});

describe('POST /autoloop/new', () => {
  let manager: SessionManager;
  let server: EmbeddedServer;
  let port: number;
  let token: string;

  beforeAll(async () => {
    manager = new SessionManager({});
    // autoloopStart kicks off Claude subprocesses — stub for unit tests.
    vi.spyOn(manager, 'autoloopStart').mockImplementation(async (opts) => ({
      runId: opts.runId,
      plannerSession: `planner-${opts.runId}`,
      state: {
        run_id: opts.runId,
        status: 'planning',
        iter: 0,
        subagents_spawned: false,
        started_at: '2026-05-13T05:00:00.000Z',
        workspace: opts.workspace,
        ledger_dir: path.join(opts.workspace, 'tasks', opts.runId),
        push_log_count: 0,
        status_reason: null,
        consecutive_phase_errors: 0,
        recent_phase_errors: [],
        metric_history: [],
        last_activity_at: 0,
      },
    }));
    const ephemeral = await freePort();
    server = new EmbeddedServer(manager, ephemeral);
    port = await server.start();
    token = fs.readFileSync(path.join(os.homedir(), '.openclaw', 'server-token'), 'utf-8').trim();
  });
  afterAll(async () => {
    await server.stop();
    await manager.shutdown();
  });

  it('starts an autoloop and returns a server-generated run_id', async () => {
    const r = await fetch(`http://127.0.0.1:${port}/autoloop/new`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ workspace: '/tmp' }),
    });
    expect(r.status).toBe(200);
    const j = (await r.json()) as { ok: boolean; run_id: string };
    expect(j.ok).toBe(true);
    expect(j.run_id).toMatch(/^auto-\d+-[a-f0-9]+$/);
  });

  it('honors an explicit well-shaped run_id', async () => {
    const r = await fetch(`http://127.0.0.1:${port}/autoloop/new`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ workspace: '/tmp', run_id: 'my-custom-id' }),
    });
    expect(r.status).toBe(200);
    const j = (await r.json()) as { run_id: string };
    expect(j.run_id).toBe('my-custom-id');
  });

  it('passes independent role engines and models to autoloopStart', async () => {
    const r = await fetch(`http://127.0.0.1:${port}/autoloop/new`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        workspace: '/tmp',
        run_id: 'multi-engine-http',
        planner_engine: 'codex',
        planner_model: 'gpt-planner',
        coder_engine: 'opencode',
        coder_model: 'anthropic/claude-sonnet-5',
        reviewer_engine: 'gemini',
        reviewer_model: 'gemini-reviewer',
      }),
    });

    expect(r.status).toBe(200);
    expect(manager.autoloopStart).toHaveBeenLastCalledWith({
      runId: 'multi-engine-http',
      workspace: fs.realpathSync('/tmp'),
      plannerEngine: 'codex',
      plannerModel: 'gpt-planner',
      coderEngine: 'opencode',
      coderModel: 'anthropic/claude-sonnet-5',
      reviewerEngine: 'gemini',
      reviewerModel: 'gemini-reviewer',
      sendTimeoutMs: undefined,
    });
  });

  // A custom engine names an executable to spawn. This HTTP surface is routinely
  // reverse-tunnelled to a public hostname and its token is a monitoring
  // credential, so accepting one from the request body would turn any dashboard
  // session into remote code execution. Built-in engines stay selectable.
  it('refuses a custom engine supplied over HTTP instead of spawning its binary', async () => {
    vi.mocked(manager.autoloopStart).mockClear();
    for (const key of ['planner_custom_engine', 'coder_custom_engine', 'reviewer_custom_engine']) {
      const r = await fetch(`http://127.0.0.1:${port}/autoloop/new`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          workspace: '/tmp',
          run_id: `rce-${key}`,
          [`${key.split('_')[0]}_engine`]: 'custom',
          [key]: { name: 'pwn', bin: '/bin/sh', args: { extra: ['-c', 'echo owned'] } },
        }),
      });
      expect(r.status).toBe(400);
      const payload = (await r.json()) as { ok: boolean; error: string };
      expect(payload.ok).toBe(false);
      expect(payload.error).toContain('not accepted over HTTP');
      expect(manager.autoloopStart).not.toHaveBeenCalled();
    }
  });

  it('returns 400 when autoloop role configuration is invalid', async () => {
    vi.mocked(manager.autoloopStart).mockRejectedValueOnce(new Error("Planner engine 'not-real' is not supported"));
    const r = await fetch(`http://127.0.0.1:${port}/autoloop/new`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ workspace: '/tmp', planner_engine: 'not-real' }),
    });
    expect(r.status).toBe(400);
  });

  it('returns 409 when an Autoloop reserved session name is already active', async () => {
    vi.mocked(manager.autoloopStart).mockRejectedValueOnce(
      new Error("Autoloop session name 'autoloop-conflict-planner' is already in use"),
    );
    const r = await fetch(`http://127.0.0.1:${port}/autoloop/new`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ workspace: '/tmp', run_id: 'conflict' }),
    });
    expect(r.status).toBe(409);
  });

  it('rejects a malformed run_id (server-generates instead)', async () => {
    const r = await fetch(`http://127.0.0.1:${port}/autoloop/new`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ workspace: '/tmp', run_id: 'has spaces and !@#$' }),
    });
    expect(r.status).toBe(200);
    const j = (await r.json()) as { run_id: string };
    expect(j.run_id).toMatch(/^auto-\d+-[a-f0-9]+$/);
  });

  it('returns 400 when workspace is missing', async () => {
    const r = await fetch(`http://127.0.0.1:${port}/autoloop/new`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: '{}',
    });
    expect(r.status).toBe(400);
  });
});

describe('POST /autoloop/:id/chat', () => {
  let manager: SessionManager;
  let server: EmbeddedServer;
  let port: number;
  let token: string;

  beforeAll(async () => {
    manager = new SessionManager({});
    const ephemeral = await freePort();
    server = new EmbeddedServer(manager, ephemeral);
    port = await server.start();
    token = fs.readFileSync(path.join(os.homedir(), '.openclaw', 'server-token'), 'utf-8').trim();
  });
  afterAll(async () => {
    await server.stop();
    await manager.shutdown();
  });

  it('returns 202 immediately (fire-and-forget) and dispatches autoloopChat in the background', async () => {
    // Pretend the run is alive in memory so the handler clears its 404 gate.
    vi.spyOn(manager, 'getAutoloop').mockReturnValue({
      runner: {} as never,
      dispatcher: {} as never,
    });
    // autoloopChat may take a long time — simulate by never resolving within
    // the test window. The handler must NOT await it.
    const slow = new Promise<{ reply: string }>(() => {
      /* never resolves */
    });
    const spy = vi.spyOn(manager, 'autoloopChat').mockReturnValue(slow);

    const r = await fetch(`http://127.0.0.1:${port}/autoloop/run-xyz/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ text: 'hello' }),
    });
    expect(r.status).toBe(202);
    const j = (await r.json()) as { ok: boolean; queued: boolean };
    expect(j.ok).toBe(true);
    expect(j.queued).toBe(true);
    expect(spy).toHaveBeenCalledWith('run-xyz', 'hello');
  });

  it('returns 400 when text is missing or empty', async () => {
    vi.spyOn(manager, 'getAutoloop').mockReturnValue({
      runner: {} as never,
      dispatcher: {} as never,
    });
    const r1 = await fetch(`http://127.0.0.1:${port}/autoloop/run-xyz/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: '{}',
    });
    expect(r1.status).toBe(400);
    const r2 = await fetch(`http://127.0.0.1:${port}/autoloop/run-xyz/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ text: '   ' }),
    });
    expect(r2.status).toBe(400);
  });

  it('returns 404 when the run is not in this process memory', async () => {
    vi.spyOn(manager, 'getAutoloop').mockReturnValue(undefined);
    const r = await fetch(`http://127.0.0.1:${port}/autoloop/nope/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ text: 'hi' }),
    });
    expect(r.status).toBe(404);
  });
});

describe('POST /autoloop/:id/delete', () => {
  let manager: SessionManager;
  let server: EmbeddedServer;
  let port: number;
  let token: string;

  beforeAll(async () => {
    manager = new SessionManager({});
    const ephemeral = await freePort();
    server = new EmbeddedServer(manager, ephemeral);
    port = await server.start();
    token = fs.readFileSync(path.join(os.homedir(), '.openclaw', 'server-token'), 'utf-8').trim();
  });
  afterAll(async () => {
    await server.stop();
    await manager.shutdown();
  });

  it('returns 200 when the run is deleted', async () => {
    const spy = vi.spyOn(manager, 'autoloopDelete').mockResolvedValue(true);
    const r = await fetch(`http://127.0.0.1:${port}/autoloop/run-abc/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: '{}',
    });
    expect(r.status).toBe(200);
    const j = (await r.json()) as { ok: boolean };
    expect(j.ok).toBe(true);
    expect(spy).toHaveBeenCalledWith('run-abc');
  });

  it('returns 404 when nothing was removed', async () => {
    vi.spyOn(manager, 'autoloopDelete').mockResolvedValue(false);
    const r = await fetch(`http://127.0.0.1:${port}/autoloop/missing/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: '{}',
    });
    expect(r.status).toBe(404);
  });
});

describe('POST /autoloop/:id/resume + GET /autoloop/:id/chat_history', () => {
  let manager: SessionManager;
  let server: EmbeddedServer;
  let port: number;
  let token: string;

  beforeAll(async () => {
    manager = new SessionManager({});
    const ephemeral = await freePort();
    server = new EmbeddedServer(manager, ephemeral);
    port = await server.start();
    token = fs.readFileSync(path.join(os.homedir(), '.openclaw', 'server-token'), 'utf-8').trim();
  });
  afterAll(async () => {
    await server.stop();
    await manager.shutdown();
  });

  it('resume returns the new in-memory state', async () => {
    vi.spyOn(manager, 'autoloopResume').mockResolvedValue({
      run_id: 'run-rsm',
      status: 'planning',
      iter: 0,
      subagents_spawned: false,
      started_at: '2026-05-13T10:00:00.000Z',
      workspace: '/tmp',
      ledger_dir: '/tmp/tasks/run-rsm',
      push_log_count: 0,
      status_reason: null,
      consecutive_phase_errors: 0,
      recent_phase_errors: [],
      metric_history: [],
      last_activity_at: 0,
    });
    const r = await fetch(`http://127.0.0.1:${port}/autoloop/run-rsm/resume`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: '{}',
    });
    expect(r.status).toBe(200);
    const j = (await r.json()) as { ok: boolean; state: { run_id: string; status: string } };
    expect(j.ok).toBe(true);
    expect(j.state.run_id).toBe('run-rsm');
    expect(j.state.status).toBe('planning');
    expect(manager.autoloopResume).toHaveBeenCalledWith('run-rsm', {
      plannerCustomEngine: undefined,
      coderCustomEngine: undefined,
      reviewerCustomEngine: undefined,
    });
  });

  it('resumes without accepting a custom engine from the request body', async () => {
    vi.spyOn(manager, 'autoloopResume').mockResolvedValue({
      run_id: 'custom-rsm',
      status: 'planning',
      iter: 0,
      subagents_spawned: false,
      started_at: '2026-05-13T10:00:00.000Z',
      workspace: '/tmp',
      ledger_dir: '/tmp/tasks/custom-rsm',
      push_log_count: 0,
      status_reason: null,
      consecutive_phase_errors: 0,
      recent_phase_errors: [],
      metric_history: [],
      last_activity_at: 0,
    });
    const r = await fetch(`http://127.0.0.1:${port}/autoloop/custom-rsm/resume`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({}),
    });

    expect(r.status).toBe(200);
    expect(manager.autoloopResume).toHaveBeenLastCalledWith('custom-rsm', {});
  });

  it('refuses a custom engine supplied to resume over HTTP', async () => {
    const resumeSpy = vi.spyOn(manager, 'autoloopResume');
    const r = await fetch(`http://127.0.0.1:${port}/autoloop/custom-rsm/resume`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ planner_custom_engine: { name: 'pwn', bin: '/bin/sh', args: {} } }),
    });

    expect(r.status).toBe(400);
    const payload = (await r.json()) as { ok: boolean; error: string };
    expect(payload.error).toContain('not accepted over HTTP');
    expect(resumeSpy).not.toHaveBeenCalled();
  });

  it('resume returns 400 when a custom engine config is required', async () => {
    vi.spyOn(manager, 'autoloopResume').mockRejectedValue(new Error('Planner custom engine config is required'));
    const r = await fetch(`http://127.0.0.1:${port}/autoloop/custom-missing/resume`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: '{}',
    });
    expect(r.status).toBe(400);
  });

  it('resume returns 404 when registry has no record', async () => {
    vi.spyOn(manager, 'autoloopResume').mockRejectedValue(new Error("Autoloop run 'nope' not found in registry"));
    const r = await fetch(`http://127.0.0.1:${port}/autoloop/nope/resume`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: '{}',
    });
    expect(r.status).toBe(404);
  });

  it('resume returns 500 for engine runtime failures rather than treating them as bad config', async () => {
    vi.spyOn(manager, 'autoloopResume').mockRejectedValue(
      new Error("Engine 'claude' circuit breaker open after 3 consecutive failures. Retry in 30s."),
    );
    const r = await fetch(`http://127.0.0.1:${port}/autoloop/runtime-failure/resume`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: '{}',
    });
    expect(r.status).toBe(500);
  });

  it('chat_history reads <ledger>/chat.jsonl and returns entries', async () => {
    // Stage a fake ledger so /chat_history can read it.
    const tmpLedger = fs.mkdtempSync(path.join(os.tmpdir(), 'autoloop-hist-'));
    fs.writeFileSync(
      path.join(tmpLedger, 'chat.jsonl'),
      [
        JSON.stringify({ who: 'user', text: 'hi', ts: '2026-05-13T01:00:00Z' }),
        JSON.stringify({ who: 'planner', text: 'hello back', ts: '2026-05-13T01:00:05Z' }),
      ].join('\n') + '\n',
    );
    vi.spyOn(manager, 'autoloopStatus').mockReturnValue({
      run_id: 'hist-run',
      status: 'terminated',
      iter: 0,
      subagents_spawned: false,
      started_at: '2026-05-13T01:00:00Z',
      workspace: '/tmp',
      ledger_dir: tmpLedger,
      push_log_count: 0,
      status_reason: 'historical',
      consecutive_phase_errors: 0,
      recent_phase_errors: [],
      metric_history: [],
      last_activity_at: 0,
    });
    const r = await fetch(`http://127.0.0.1:${port}/autoloop/hist-run/chat_history`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(r.status).toBe(200);
    const j = (await r.json()) as { ok: boolean; entries: Array<{ who: string; text: string }> };
    expect(j.ok).toBe(true);
    expect(j.entries).toHaveLength(2);
    expect(j.entries[0].who).toBe('user');
    expect(j.entries[1].who).toBe('planner');
    fs.rmSync(tmpLedger, { recursive: true, force: true });
  });

  it('chat_history 404s when autoloopStatus has no record', async () => {
    vi.spyOn(manager, 'autoloopStatus').mockReturnValue(undefined);
    const r = await fetch(`http://127.0.0.1:${port}/autoloop/missing/chat_history`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(r.status).toBe(404);
  });
});
