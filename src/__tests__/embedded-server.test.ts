/**
 * Unit tests for EmbeddedServer — HTTP server for standalone/CLI usage
 *
 * Strategy: create a real server on an ephemeral port, send HTTP requests,
 * and verify responses. SessionManager methods are mocked.
 */

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import * as http from 'node:http';
import * as net from 'node:net';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  EmbeddedServer,
  __sseSenderForTest as sseSenderForTest,
  loginRedirectTarget,
  parseRequestTarget,
  sameSecret,
} from '../embedded-server.js';
import type { SessionManager } from '../session-manager.js';
import { resolveAlias } from '../models.js';
import { useIsolatedHome } from './helpers/isolate-home.js';

// Isolate ~/.openclaw/server-token to a per-file temp dir — see helper docs.
useIsolatedHome();

/** Find a free ephemeral port */
function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address() as net.AddressInfo;
      srv.close(() => resolve(addr.port));
    });
    srv.on('error', reject);
  });
}

// ─── Mock SessionManager ──────────────────────────────────────────────────

function createMockManager(): SessionManager {
  return {
    getVersion: vi.fn().mockReturnValue('2.9.0-test'),
    listSessions: vi.fn().mockReturnValue([]),
    startSession: vi.fn().mockResolvedValue({ name: 'test', engine: 'claude' }),
    stopSession: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue({ output: 'hello', requestId: 'r1' }),
    getStatus: vi.fn().mockReturnValue({ isReady: true, turns: 0 }),
    getCost: vi.fn().mockReturnValue({ totalUsd: 0 }),
    setModel: vi.fn(),
    setEffort: vi.fn(),
    grepSession: vi.fn().mockResolvedValue([]),
    compactSession: vi.fn().mockResolvedValue(undefined),
    listAgents: vi.fn().mockReturnValue([]),
    createAgent: vi.fn().mockReturnValue('/path/to/agent'),
    listSkills: vi.fn().mockReturnValue([]),
    createSkill: vi.fn().mockReturnValue('/path/to/skill'),
    listRules: vi.fn().mockReturnValue([]),
    createRule: vi.fn().mockReturnValue('/path/to/rule'),
    teamList: vi.fn().mockResolvedValue('no teams'),
    teamSend: vi.fn().mockResolvedValue({ output: 'ok' }),
  } as unknown as SessionManager;
}

// ─── HTTP helpers ──────────────────────────────────────────────────────────

function request(
  port: number,
  path: string,
  options: {
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
  } = {},
): Promise<{ status: number; body: unknown; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: options.method || 'GET',
        headers: {
          'Content-Type': 'application/json',
          ...options.headers,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(data);
          } catch {
            parsed = data;
          }
          resolve({ status: res.statusCode || 0, body: parsed, headers: res.headers });
        });
      },
    );
    req.on('error', reject);
    if (options.body) {
      req.write(JSON.stringify(options.body));
    }
    req.end();
  });
}

function rawRequest(
  port: number,
  path: string,
  options: { method?: string; body?: string; contentType?: string; headers?: Record<string, string> },
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: options.method || 'POST',
        headers: { 'Content-Type': options.contentType || 'application/json', ...options.headers },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode || 0, body: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode || 0, body: data });
          }
        });
      },
    );
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('EmbeddedServer', () => {
  let server: EmbeddedServer;
  let manager: SessionManager;
  let port: number;

  beforeEach(async () => {
    // 3.5.6+: server auto-generates a token by default. Most routing /
    // rate-limit / CORS tests don't care about auth and shouldn't have to
    // know about it, so opt out for these tests via the explicit sentinel.
    // Auth-specific tests below override this env back to a literal token.
    process.env.OPENCLAW_SERVER_TOKEN = 'disabled';
    delete process.env.OPENCLAW_RATE_LIMIT;
    delete process.env.OPENCLAW_CORS_ORIGINS;

    manager = createMockManager();
    port = await getFreePort();
    server = new EmbeddedServer(manager, port);
  });

  afterAll(() => {
    delete process.env.OPENCLAW_SERVER_TOKEN;
  });

  afterEach(async () => {
    await server.stop();
  });

  describe('health endpoint', () => {
    it('returns ok with version and session count', async () => {
      await server.start();

      const res = await request(port, '/health');
      expect(res.status).toBe(200);
      expect(res.body).toEqual(
        expect.objectContaining({
          ok: true,
          version: '2.9.0-test',
          sessions: 0,
        }),
      );
    });

    it('skips auth for health endpoint even when token is set', async () => {
      process.env.OPENCLAW_SERVER_TOKEN = 'secret-token';
      port = await getFreePort();
      server = new EmbeddedServer(manager, port);
      await server.start();

      const res = await request(port, '/health');
      expect(res.status).toBe(200);
      expect((res.body as Record<string, boolean>).ok).toBe(true);
    });
  });

  // `new URL` throws on some request targets, and the first parse ran before
  // authentication with nothing around it: one such request ended the process,
  // which in the OpenClaw plugin is the gateway.
  describe('malformed request targets', () => {
    function raw(target: string): Promise<string> {
      return new Promise((resolve, reject) => {
        const sock = net.connect(port, '127.0.0.1', () => {
          sock.write(`GET ${target} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`);
        });
        let data = '';
        sock.on('data', (d) => (data += d));
        sock.on('end', () => resolve(data));
        sock.on('error', reject);
      });
    }

    it.each([
      ['with auth on', 'secret-token'],
      ['with auth off', 'disabled'],
    ])('answers 400 and keeps serving, %s', async (_label, token) => {
      process.env.OPENCLAW_SERVER_TOKEN = token;
      port = await getFreePort();
      server = new EmbeddedServer(manager, port);
      await server.start();

      for (const target of ['//[/', '//[::1', '//evil.com/x']) {
        expect(await raw(target)).toMatch(/^HTTP\/1\.1 400 /);
      }
      expect((await request(port, '/health')).status).toBe(200);
    });
  });

  describe('auth token enforcement', () => {
    it('rejects requests without token when auth is enabled', async () => {
      process.env.OPENCLAW_SERVER_TOKEN = 'secret-token';
      port = await getFreePort();
      server = new EmbeddedServer(manager, port);
      await server.start();

      const res = await request(port, '/session/list', { method: 'POST', body: {} });
      expect(res.status).toBe(401);
      expect((res.body as Record<string, string>).error).toContain('Unauthorized');
    });

    it('accepts requests with correct Bearer token', async () => {
      process.env.OPENCLAW_SERVER_TOKEN = 'secret-token';
      port = await getFreePort();
      server = new EmbeddedServer(manager, port);
      await server.start();

      const res = await request(port, '/session/list', {
        method: 'POST',
        body: {},
        headers: { Authorization: 'Bearer secret-token' },
      });
      expect(res.status).toBe(200);
    });

    it('rejects requests with wrong token', async () => {
      process.env.OPENCLAW_SERVER_TOKEN = 'secret-token';
      port = await getFreePort();
      server = new EmbeddedServer(manager, port);
      await server.start();

      const res = await request(port, '/session/list', {
        method: 'POST',
        body: {},
        headers: { Authorization: 'Bearer wrong-token' },
      });
      expect(res.status).toBe(401);
    });

    it('accepts ?token=<v> query param and sets cookie for follow-up requests', async () => {
      process.env.OPENCLAW_SERVER_TOKEN = 'secret-token';
      port = await getFreePort();
      server = new EmbeddedServer(manager, port);
      await server.start();

      const res = await request(port, '/health?token=secret-token');
      expect(res.status).toBe(200);
      // /health skips auth, no cookie expected. Hit a real route to verify
      // the query→cookie handoff.
      const res2 = await request(port, '/agents?token=secret-token');
      expect(res2.status).toBe(200);
      const setCookie = res2.headers['set-cookie'];
      const cookieStr = Array.isArray(setCookie) ? setCookie[0] : setCookie;
      expect(cookieStr).toBeDefined();
      expect(String(cookieStr)).toMatch(/clawo_auth=secret-token/);
      expect(String(cookieStr)).toMatch(/HttpOnly/);
      expect(String(cookieStr)).toMatch(/SameSite=Strict/);
    });

    it('accepts clawo_auth cookie in lieu of Bearer header', async () => {
      process.env.OPENCLAW_SERVER_TOKEN = 'secret-token';
      port = await getFreePort();
      server = new EmbeddedServer(manager, port);
      await server.start();

      const res = await request(port, '/session/list', {
        method: 'POST',
        body: {},
        headers: { Cookie: 'clawo_auth=secret-token' },
      });
      expect(res.status).toBe(200);
    });

    it('auto-generates a token by default (no env var set)', async () => {
      delete process.env.OPENCLAW_SERVER_TOKEN;
      port = await getFreePort();
      server = new EmbeddedServer(manager, port);
      await server.start();

      // No token sent → 401
      const res = await request(port, '/session/list', { method: 'POST', body: {} });
      expect(res.status).toBe(401);
      // /health still works
      const health = await request(port, '/health');
      expect(health.status).toBe(200);
    });

    // A second server started with an explicit token (another port, a demo, a
    // test harness) used to overwrite the shared file, so every client reading
    // it lost access to the first server.
    it('an env-token server leaves an existing token file alone', async () => {
      const dir = path.join(os.homedir(), '.openclaw');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'server-token');
      const existing = 'ab'.repeat(32);
      fs.writeFileSync(file, existing, { mode: 0o600 });
      process.env.OPENCLAW_SERVER_TOKEN = 'secret-token';
      port = await getFreePort();
      server = new EmbeddedServer(manager, port);
      await server.start();

      expect(fs.readFileSync(file, 'utf-8')).toBe(existing);
      const res = await request(port, '/session/list', {
        method: 'POST',
        body: {},
        headers: { Authorization: 'Bearer secret-token' },
      });
      expect(res.status).toBe(200);
      fs.rmSync(file);
    });

    it('OPENCLAW_SERVER_TOKEN=disabled disables auth entirely', async () => {
      process.env.OPENCLAW_SERVER_TOKEN = 'disabled';
      port = await getFreePort();
      server = new EmbeddedServer(manager, port);
      await server.start();

      const res = await request(port, '/session/list', { method: 'POST', body: {} });
      expect(res.status).toBe(200);
    });
  });

  // ── The network surface must not be able to name a binary to spawn.
  //
  //    `rejectCustomEngineOverHttp` was wired into /autoloop/new and
  //    /autoloop/<id>/resume and matched three snake_case keys. `/session/start`
  //    had no guard at all and `session_start` spells the field `customEngine`,
  //    so the object reached `startSession()` verbatim (measured: HTTP 200, the
  //    full `{bin, args.extra}` handed over) and from there
  //    `PersistentCustomSession` spawns `bin`. The guard is now shape-matched
  //    and runs on every body in `route()`, so the next route added cannot
  //    reintroduce it by being forgotten.
  describe('custom engine over HTTP', () => {
    it('refuses a customEngine body on /session/start without reaching startSession', async () => {
      await server.start();

      const res = await request(port, '/session/start', {
        method: 'POST',
        body: {
          name: 'pwned',
          cwd: '/tmp',
          engine: 'custom',
          customEngine: { name: 'x', bin: '/bin/sh', args: { extra: ['-c', 'touch /tmp/proof'] } },
        },
      });

      expect(res.status).toBe(400);
      expect(String((res.body as { error?: string }).error)).toContain('customEngine');
      // The point of the assertion: refusing after the spawn would be no refusal.
      expect(manager.startSession).not.toHaveBeenCalled();
    });

    // Yesterday this asserted the opposite, and the reversal is deliberate.
    // The guard's own reason is that a custom engine "names an executable to
    // spawn" — but `engine: 'codex'` spawns one too and is allowed here, so
    // spawning was never the line. Arbitrary argv is, and a preset id cannot
    // carry any: it selects one of the descriptions this package ships. Keeping
    // it refused would also leave `-e custom` unreachable from the CLI, which
    // is how the first outside contributor discovered the path was dead.
    it('accepts a customEngine given as a preset id', async () => {
      await server.start();

      const res = await request(port, '/session/start', {
        method: 'POST',
        body: { name: 'preset-ok', cwd: '/tmp', engine: 'custom', customEngine: 'zcode' },
      });

      expect(res.status).not.toBe(400);
      expect(manager.startSession).toHaveBeenCalled();
    });

    // A body may describe this shape instead of carrying one. An OpenAI-style
    // `tools` array is JSON Schema, and this package's own `autoloop_start`
    // schema declares `planner_custom_engine` — so matching "any object under a
    // custom-engine key" rejected every tool-bearing turn through the
    // OpenAI-compatible endpoint with a 400. A tool-free request passed, which
    // is why a curl smoke test never showed it.
    it('accepts a tool schema that merely declares custom-engine properties', async () => {
      await server.start();

      const res = await request(port, '/session/start', {
        method: 'POST',
        body: {
          name: 'schema-ok',
          cwd: '/tmp',
          tools: [
            {
              type: 'function',
              function: {
                name: 'autoloop_start',
                parameters: {
                  type: 'object',
                  properties: {
                    planner_custom_engine: {
                      type: 'object',
                      description: 'Custom engine config.',
                      properties: { bin: { type: 'string' }, name: { type: 'string' } },
                    },
                  },
                },
              },
            },
          ],
        },
      });

      expect(res.status).not.toBe(400);
      expect(manager.startSession).toHaveBeenCalled();
    });

    it('refuses a nested custom engine, wherever in the body it sits', async () => {
      await server.start();

      const res = await request(port, '/session/start', {
        method: 'POST',
        body: { name: 'n', agents: [{ name: 'a' }, { name: 'b', customEngine: { bin: '/bin/sh' } }] },
      });

      expect(res.status).toBe(400);
      expect(String((res.body as { error?: string }).error)).toContain('agents[1].customEngine');
      expect(manager.startSession).not.toHaveBeenCalled();
    });

    it('still refuses the snake_case autoloop spellings', async () => {
      await server.start();

      for (const key of ['planner_custom_engine', 'coder_custom_engine', 'reviewer_custom_engine']) {
        const res = await request(port, '/autoloop/new', {
          method: 'POST',
          body: { goal: 'g', [key]: { bin: '/bin/sh' } },
        });
        expect(res.status).toBe(400);
        expect(String((res.body as { error?: string }).error)).toContain(key);
      }
    });

    it('leaves an ordinary body alone', async () => {
      await server.start();

      // Guarding every body means a false positive would break every route, so
      // the negative case is the other half of the assertion.
      const res = await request(port, '/session/start', {
        method: 'POST',
        body: { name: 'ok', cwd: '/tmp', engine: 'codex', model: 'gpt-5.1-codex' },
      });

      expect(res.status).toBe(200);
      expect(manager.startSession).toHaveBeenCalled();
    });
  });

  // ── An SSE event that fires after the client hangs up must not throw.
  //
  //    Every one of these endpoints writes from an EventEmitter callback, and an
  //    event can land between the socket closing and the `close` handler
  //    detaching the listener. `res.write` then throws
  //    ERR_STREAM_WRITE_AFTER_END inside the emitter callback, where nothing
  //    catches it. Only the autoloop handler was guarded.
  describe('SSE after the client disconnects', () => {
    it('swallows a write to a response that has already ended', async () => {
      await server.start();

      // Reach in for the guarded sender the routes use, and drive it against a
      // response that is already finished — which is what the emitter callback
      // does when it fires one tick too late.
      const res = new http.ServerResponse({ method: 'GET', url: '/x' } as never);
      const chunks: string[] = [];
      res.write = ((c: string) => {
        chunks.push(c);
        return true;
      }) as never;
      const send = sseSenderForTest(res);
      send('hello', { a: 1 });
      expect(chunks.length).toBe(2);

      // Now the socket goes away.
      res.emit('close');
      expect(() => send('after', { a: 2 })).not.toThrow();
      expect(chunks.length).toBe(2);
    });

    it('stops after a write throws rather than throwing again on the next event', () => {
      const res = new http.ServerResponse({ method: 'GET', url: '/x' } as never);
      let calls = 0;
      res.write = (() => {
        calls++;
        throw new Error('write after end');
      }) as never;
      const send = sseSenderForTest(res);

      expect(() => send('one', {})).not.toThrow();
      expect(() => send('two', {})).not.toThrow();
      expect(calls).toBe(1);
    });
  });

  describe('rate limiting', () => {
    it('allows requests within rate limit', async () => {
      process.env.OPENCLAW_RATE_LIMIT = '5';
      port = await getFreePort();
      server = new EmbeddedServer(manager, port);
      await server.start();

      for (let i = 0; i < 5; i++) {
        const res = await request(port, '/session/list', { method: 'POST', body: {} });
        expect(res.status).toBe(200);
      }
    });

    it('returns 429 when rate limit exceeded', async () => {
      process.env.OPENCLAW_RATE_LIMIT = '2';
      port = await getFreePort();
      server = new EmbeddedServer(manager, port);
      await server.start();

      await request(port, '/session/list', { method: 'POST', body: {} });
      await request(port, '/session/list', { method: 'POST', body: {} });
      const res = await request(port, '/session/list', { method: 'POST', body: {} });
      expect(res.status).toBe(429);
      expect((res.body as Record<string, string>).error).toContain('Rate limit');
    });

    // /health is open without a token. Counting it let anyone exhaust the limit
    // that authenticated clients from the same address (127.0.0.1, or a reverse
    // proxy) share, and its POST body was buffered before anything checked it.
    it('does not count /health, and answers it without reading a body', async () => {
      process.env.OPENCLAW_SERVER_TOKEN = 'secret-token';
      process.env.OPENCLAW_RATE_LIMIT = '3';
      port = await getFreePort();
      server = new EmbeddedServer(manager, port);
      await server.start();

      for (let i = 0; i < 20; i++) expect((await request(port, '/health')).status).toBe(200);
      const post = await request(port, '/health', { method: 'POST', body: { pad: 'x'.repeat(1024 * 1024) } });
      expect(post.status).toBe(200);
      const authed = await request(port, '/session/list', {
        method: 'POST',
        body: {},
        headers: { Authorization: 'Bearer secret-token' },
      });
      expect(authed.status).toBe(200);
    });
  });

  describe('body size limit', () => {
    it('rejects oversized POST bodies', async () => {
      await server.start();

      // 6MB body exceeds MAX_BODY_SIZE (5MB) — server destroys the request mid-write,
      // so we may get EPIPE on the client side. Both 413 and EPIPE are valid outcomes.
      const largeBody = 'x'.repeat(6 * 1024 * 1024);
      try {
        const res = await rawRequest(port, '/session/start', { body: largeBody });
        expect(res.status).toBe(413);
        expect((res.body as Record<string, string>).error).toContain('too large');
      } catch (err) {
        // EPIPE/ECONNRESET is expected — server killed the connection before we finished writing
        expect((err as NodeJS.ErrnoException).code).toMatch(/EPIPE|ECONNRESET/);
      }
    });
  });

  describe('content type enforcement', () => {
    it('rejects POST without application/json content type', async () => {
      await server.start();

      const res = await rawRequest(port, '/session/start', {
        body: 'hello',
        contentType: 'text/plain',
      });

      expect(res.status).toBe(415);
      expect((res.body as Record<string, string>).error).toContain('application/json');
    });
  });

  describe('route dispatching', () => {
    beforeEach(async () => {
      await server.start();
    });

    it('routes /session/list to manager.listSessions', async () => {
      const res = await request(port, '/session/list', { method: 'POST', body: {} });
      expect(res.status).toBe(200);
      expect(res.body).toEqual(expect.objectContaining({ ok: true, sessions: [] }));
      expect(manager.listSessions).toHaveBeenCalled();
    });

    it('routes /session/start to manager.startSession', async () => {
      const res = await request(port, '/session/start', {
        method: 'POST',
        body: { name: 'test', cwd: '/tmp' },
      });
      expect(res.status).toBe(200);
      expect((res.body as Record<string, boolean>).ok).toBe(true);
      expect(manager.startSession).toHaveBeenCalled();
    });

    it('routes /session/stop to manager.stopSession', async () => {
      const res = await request(port, '/session/stop', {
        method: 'POST',
        body: { name: 'test' },
      });
      expect(res.status).toBe(200);
      expect(manager.stopSession).toHaveBeenCalledWith('test');
    });

    it('routes /session/send to manager.sendMessage', async () => {
      const res = await request(port, '/session/send', {
        method: 'POST',
        body: { name: 'test', message: 'hello' },
      });
      expect(res.status).toBe(200);
      expect(manager.sendMessage).toHaveBeenCalledWith('test', 'hello', expect.any(Object));
    });

    it('routes /session/status to manager.getStatus', async () => {
      const res = await request(port, '/session/status', {
        method: 'POST',
        body: { name: 'test' },
      });
      expect(res.status).toBe(200);
      expect(manager.getStatus).toHaveBeenCalledWith('test');
    });

    it('routes /session/cost to manager.getCost', async () => {
      const res = await request(port, '/session/cost', {
        method: 'POST',
        body: { name: 'test' },
      });
      expect(res.status).toBe(200);
      expect(manager.getCost).toHaveBeenCalledWith('test');
    });

    it('starts the /council/new preset with every agent on the current Opus', async () => {
      const councilStart = vi.fn().mockResolvedValue({ id: 'c1', status: 'running' });
      (manager as unknown as { councilStart: typeof councilStart }).councilStart = councilStart;
      const res = await request(port, '/council/new', { method: 'POST', body: { task: 't', projectDir: '/tmp' } });
      expect(res.status).toBe(200);
      const agents = councilStart.mock.calls[0][1].agents as Array<{ model: string }>;
      expect(agents).toHaveLength(3);
      for (const a of agents) expect(resolveAlias(a.model)).toBe(resolveAlias('opus'));
    });

    // Only reads answer GET/HEAD; every other route answers only POST. Routing does
    // not look at the method and gives a GET an empty body, so a GET used to run
    // state-changing routes: GET /session/start started a session.
    const ACTIONS = [
      'startSession',
      'sendMessage',
      'stopSession',
      'compactSession',
      'setModel',
      'setEffort',
      'teamSend',
      'createAgent',
      'createSkill',
      'createRule',
      'councilStart',
      'workflowStart',
      'workflowCancel',
      'workflowResume',
      'workflowSteer',
      'workflowApprove',
      'autoloopStart',
      'acceptAutoloopChat',
      'autoloopDelete',
      'autoloopResume',
    ] as const;
    const UA_ACTIONS = [
      'createRun',
      'submitAnswer',
      'applySpecEdit',
      'startBuild',
      'cancelBuild',
      'startContainer',
      'stopContainer',
      'deleteRun',
      'submitDoneModeMessage',
      'promoteVersion',
      'addFile',
    ] as const;
    function spyOnActions() {
      const m = manager as unknown as Record<string, unknown>;
      const spies: Array<ReturnType<typeof vi.fn>> = [];
      for (const name of ACTIONS) {
        const fn = vi.fn().mockResolvedValue({});
        m[name] = fn;
        spies.push(fn);
      }
      const ua: Record<string, unknown> = { store: { listRuns: vi.fn().mockResolvedValue([]) } };
      for (const name of UA_ACTIONS) {
        const fn = vi.fn().mockResolvedValue({ ok: true });
        ua[name] = fn;
        spies.push(fn);
      }
      m.getUltraappManager = () => ua;
      return spies;
    }

    it.each([
      '/session/start',
      '/session/send',
      '/session/stop',
      '/session/compact',
      '/session/model',
      '/session/effort',
      '/session/team-send',
      '/agents/create',
      '/skills/create',
      '/rules/create',
      '/v1/chat/completions',
      '/council/new',
      '/workflow/new',
      '/workflow/r1/cancel',
      '/workflow/r1/resume',
      '/workflow/r1/steer',
      '/workflow/r1/approve',
      '/autoloop/new',
      '/autoloop/r1/chat',
      '/autoloop/r1/delete',
      '/autoloop/r1/resume',
      '/ultraapp/new',
      '/ultraapp/u1/answer',
      '/ultraapp/u1/answer/x',
      '/ultraapp/u1/spec-edit',
      '/ultraapp/u1/spec-edit/x',
      '/ultraapp/u1/build',
      '/ultraapp/u1/build/cancel',
      '/ultraapp/u1/start',
      '/ultraapp/u1/stop',
      '/ultraapp/u1/delete',
      '/ultraapp/u1/feedback',
      '/ultraapp/u1/promote-version',
      '/ultraapp/u1/files',
      '/ultraapp/u1/files/x',
    ])('answers 405 to GET on %s and runs nothing', async (route) => {
      const spies = spyOnActions();
      await server.start();

      for (const method of ['GET', 'HEAD', 'PUT', 'DELETE']) {
        const res = await request(port, route, { method });
        expect(res.status, method).toBe(405);
        expect(res.headers.allow).toBe('POST');
      }
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    });

    it('still answers GET on read routes', async () => {
      spyOnActions();
      await server.start();

      for (const route of [
        '/session/list',
        '/agents',
        '/v1/models',
        '/health',
        '/council/list',
        '/workflow/list',
        '/autoloop/list',
        '/ultraapp/list',
        '/workflow/r1/state',
        '/workflow/r1/evidence',
        '/autoloop/r1/state',
        '/ultraapp/u1',
        '/ultraapp/u1/artifacts',
        '/council/c1/state',
        '/autoloop/r1/resume-requirements',
      ]) {
        const res = await request(port, route);
        expect(res.status, route).not.toBe(405);
      }
      for (const route of ['/session/list', '/agents', '/v1/models', '/health']) {
        expect((await request(port, route)).status, route).toBe(200);
      }
    });

    // A gate is answered only by an explicit boolean: an empty body is not an approval.
    it('requires an explicit approved boolean to answer a workflow gate', async () => {
      const workflowApprove = vi.fn().mockResolvedValue({ answered: true });
      (manager as unknown as { workflowApprove: typeof workflowApprove }).workflowApprove = workflowApprove;
      await server.start();

      for (const body of [{}, { approved: 'yes' }, { approved: null }]) {
        const res = await request(port, '/workflow/r1/approve', { method: 'POST', body });
        expect(res.status, JSON.stringify(body)).toBe(400);
      }
      expect(workflowApprove).not.toHaveBeenCalled();

      for (const approved of [true, false]) {
        const res = await request(port, '/workflow/r1/approve', { method: 'POST', body: { approved } });
        expect(res.status).toBe(200);
        expect(workflowApprove).toHaveBeenLastCalledWith('r1', approved);
      }
    });

    it('returns 404 for unknown routes', async () => {
      const res = await request(port, '/nonexistent', { method: 'POST', body: {} });
      expect(res.status).toBe(404);
    });

    it('returns OpenAI-style error for unknown /v1/ routes', async () => {
      const res = await request(port, '/v1/unknown', { method: 'POST', body: {} });
      expect(res.status).toBe(404);
      expect(res.body).toEqual(
        expect.objectContaining({
          error: expect.objectContaining({
            type: 'invalid_request_error',
          }),
        }),
      );
    });

    it('routes /v1/models to model list', async () => {
      const res = await request(port, '/v1/models');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('data');
    });

    it('routes GET /agents to manager.listAgents', async () => {
      const res = await request(port, '/agents');
      expect(res.status).toBe(200);
      expect(manager.listAgents).toHaveBeenCalled();
    });
  });

  describe('CORS', () => {
    it('handles OPTIONS preflight requests', async () => {
      await server.start();

      const res = await request(port, '/session/list', { method: 'OPTIONS' });
      expect(res.status).toBe(200);
      expect(res.headers['access-control-allow-methods']).toContain('POST');
    });

    // A browser sends a custom header only if the preflight allows it. The
    // OpenAI-compat client keys and resets its conversation with these two.
    it('allows the session headers the OpenAI-compat endpoint reads', async () => {
      await server.start();

      const res = await request(port, '/v1/chat/completions', { method: 'OPTIONS' });
      const allowed = String(res.headers['access-control-allow-headers']).toLowerCase();
      expect(allowed).toContain('x-session-id');
      expect(allowed).toContain('x-session-reset');
    });

    // With auth off, nothing but the network stands between a request and the
    // agent behind /v1/chat/completions, so a web page in a browser on this host
    // must not be able to reach it: no foreign origin in the CORS reply, and no
    // DNS-rebound hostname in Host.
    it('does not echo a foreign Origin while auth is disabled', async () => {
      await server.start();

      const res = await request(port, '/v1/chat/completions', {
        method: 'OPTIONS',
        headers: { Origin: 'https://evil.example' },
      });
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('refuses a non-loopback Host while auth is disabled', async () => {
      await server.start();

      for (const host of [`evil.example:${port}`, 'evil.example', `192.168.1.5:${port}`]) {
        const res = await request(port, '/v1/models', { headers: { Host: host } });
        expect(res.status, host).toBe(403);
      }
      const post = await request(port, '/session/start', {
        method: 'POST',
        body: { name: 'x', cwd: '/tmp' },
        headers: { Host: `evil.example:${port}` },
      });
      expect(post.status).toBe(403);
      expect(manager.startSession).not.toHaveBeenCalled();
    });

    // A cross-site page can send a POST without a preflight when its Content-Type
    // is a CORS-safelisted type (text/plain), and a GET with no Origin from a
    // plain <img>. With auth off neither may reach a route.
    it('refuses a preflight-free POST from a foreign origin while auth is disabled', async () => {
      await server.start();

      const res = await rawRequest(port, '/session/start', {
        body: JSON.stringify({ name: 'pwn', cwd: '/tmp' }),
        contentType: 'text/plain;application/json',
        headers: { Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site' },
      });
      expect(res.status).toBe(403);
      expect(manager.startSession).not.toHaveBeenCalled();
    });

    it('refuses a cross-site request without an Origin while auth is disabled', async () => {
      await server.start();

      const res = await request(port, '/session/start', { headers: { 'Sec-Fetch-Site': 'cross-site' } });
      expect(res.status).toBe(403);
      expect(manager.startSession).not.toHaveBeenCalled();
    });

    it('does not echo foreign origins for OPENCLAW_CORS_ORIGINS=* while auth is disabled', async () => {
      process.env.OPENCLAW_CORS_ORIGINS = '*';
      await server.start();

      const res = await request(port, '/session/list', {
        method: 'OPTIONS',
        headers: { Origin: 'https://evil.example' },
      });
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('lets a loopback page call cross-site while auth is disabled', async () => {
      await server.start();

      const res = await request(port, '/v1/models', {
        headers: { Origin: 'http://localhost:3000', 'Sec-Fetch-Site': 'cross-site' },
      });
      expect(res.status).toBe(200);
      expect(res.headers['access-control-allow-origin']).toBe('http://localhost:3000');
    });

    it('still serves loopback hosts and origins while auth is disabled', async () => {
      await server.start();

      for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`, 'localhost']) {
        const res = await request(port, '/v1/models', { headers: { Host: host } });
        expect(res.status, host).toBe(200);
      }
      const res = await request(port, '/v1/chat/completions', {
        method: 'OPTIONS',
        headers: { Origin: 'http://localhost:3000' },
      });
      expect(res.headers['access-control-allow-origin']).toBe('http://localhost:3000');
    });

    it('keeps echoing /v1 origins and any Host when auth is on', async () => {
      process.env.OPENCLAW_SERVER_TOKEN = 'cors-test-token';
      server = new EmbeddedServer(manager, port);
      await server.start();

      const res = await request(port, '/v1/models', {
        headers: { Origin: 'https://chat.example', Host: 'chat.example', Authorization: 'Bearer cors-test-token' },
      });
      expect(res.status).toBe(200);
      expect(res.headers['access-control-allow-origin']).toBe('https://chat.example');
    });
  });

  describe('error handling', () => {
    it('returns 500 with error message when manager throws', async () => {
      (manager.startSession as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Session failed'));
      await server.start();

      const res = await request(port, '/session/start', {
        method: 'POST',
        body: { name: 'test', cwd: '/tmp' },
      });
      expect(res.status).toBe(500);
      expect((res.body as Record<string, string>).error).toBe('Session failed');
    });

    // Both refusals are about the caller's workspace, and the same request
    // succeeds once the workspace is fixed — not a server fault.
    it.each([
      'Autoloop workspace has uncommitted changes; commit or stash them before starting',
      'Autoloop could not isolate the run ledger from Git',
    ])('answers 409 when autoloop refuses the workspace: %s', async (message) => {
      (manager as unknown as Record<string, unknown>).autoloopStart = vi.fn().mockRejectedValue(new Error(message));
      await server.start();

      const res = await request(port, '/autoloop/new', { method: 'POST', body: { workspace: os.tmpdir() } });
      expect(res.status).toBe(409);
      expect((res.body as Record<string, string>).error).toBe(message);
    });

    it('requires the JSON media type itself, not a Content-Type that merely contains it', async () => {
      await server.start();

      const smuggled = await rawRequest(port, '/session/start', {
        body: JSON.stringify({ name: 't', cwd: '/tmp' }),
        contentType: 'text/plain;application/json',
      });
      expect(smuggled.status).toBe(415);
      const withCharset = await rawRequest(port, '/session/start', {
        body: JSON.stringify({ name: 't', cwd: '/tmp' }),
        contentType: 'Application/JSON; charset=utf-8',
      });
      expect(withCharset.status).toBe(200);
    });

    it('returns 400 for invalid JSON body', async () => {
      await server.start();

      const res = await rawRequest(port, '/session/start', { body: '{invalid json' });

      expect(res.status).toBe(400);
      expect((res.body as Record<string, string>).error).toContain('Invalid JSON');
    });

    // `//[/` is a network-path reference with an invalid host, so `new URL()`
    // throws on it. Thrown from the request listener, that took down the whole
    // process (the OpenClaw Gateway, for the plugin) before any token check.
    it.each([
      ['enabled', 'secret-token'],
      ['disabled', 'disabled'],
    ])('answers 400 to a request target that is not a valid URL, auth %s, and keeps serving', async (_, token) => {
      process.env.OPENCLAW_SERVER_TOKEN = token;
      port = await getFreePort();
      server = new EmbeddedServer(manager, port);
      await server.start();

      const res = await rawRequest(port, '//[/', { method: 'GET' });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ ok: false, error: 'Invalid request target' });

      const next = await request(port, '/session/list', {
        method: 'POST',
        body: {},
        headers: { Authorization: 'Bearer secret-token' },
      });
      expect(next.status).toBe(200);
    });
  });
});

// A run can be known to the store without running in this process — after a
// restart, or once it has ended. These routes have to say which, and a stream
// for a run that has already ended has to end rather than wait forever.
describe('EmbeddedServer — autoloop runs that are not running here', () => {
  let server: EmbeddedServer;
  let manager: SessionManager;
  let port: number;

  const persistedState = { run_id: 'r1', status: 'terminated', status_reason: 'goal met', iter: 3 };

  beforeEach(async () => {
    process.env.OPENCLAW_SERVER_TOKEN = 'disabled';
    delete process.env.OPENCLAW_RATE_LIMIT;
    delete process.env.OPENCLAW_CORS_ORIGINS;
    manager = createMockManager();
    port = await getFreePort();
    server = new EmbeddedServer(manager, port);
  });

  afterAll(() => {
    delete process.env.OPENCLAW_SERVER_TOKEN;
  });

  afterEach(async () => {
    await server.stop();
  });

  /** Fail fast instead of waiting out the test timeout on a stream that never ends. */
  function within<T>(p: Promise<T>, ms = 2_000): Promise<T> {
    return Promise.race([
      p,
      new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`no response within ${ms}ms`)), ms)),
    ]);
  }

  it('reports whether a run is live on /state', async () => {
    const m = manager as unknown as Record<string, unknown>;
    m.autoloopStatus = vi.fn().mockReturnValue(persistedState);
    m.getAutoloop = vi.fn().mockReturnValue(undefined);
    await server.start();

    const persisted = await request(port, '/autoloop/r1/state');
    expect(persisted.status).toBe(200);
    expect(persisted.body).toMatchObject({ ok: true, live: false });

    (m.getAutoloop as ReturnType<typeof vi.fn>).mockReturnValue({ runner: { state: persistedState } });
    const live = await request(port, '/autoloop/r1/state');
    expect(live.body).toMatchObject({ ok: true, live: true });
  });

  it('ends the event stream of a live run that has already terminated', async () => {
    const m = manager as unknown as Record<string, unknown>;
    m.getAutoloop = vi.fn().mockReturnValue({ runner: { state: persistedState, on: vi.fn(), off: vi.fn() } });
    await server.start();

    const res = await within(request(port, '/autoloop/r1/events'));
    const text = String(res.body);
    expect(text).toContain('event: snapshot');
    expect(text).toContain('event: terminated');
    expect(text).toContain('goal met');
    // Tells EventSource not to reconnect to a stream that can only end again.
    expect(text).toContain('retry: 864000000');
  });

  it('answers a chat to a stored but idle run with how to resume it', async () => {
    const m = manager as unknown as Record<string, unknown>;
    m.getAutoloop = vi.fn().mockReturnValue(undefined);
    m.autoloopStatus = vi.fn().mockReturnValue(persistedState);
    await server.start();

    const res = await request(port, '/autoloop/r1/chat', { method: 'POST', body: { text: 'hi' } });
    expect(res.status).toBe(404);
    expect((res.body as { error: string }).error).toBe(
      "Autoloop run 'r1' is not running in this process; resume it with POST /autoloop/r1/resume",
    );
  });

  it('answers a chat to an unknown or malformed run id with a plain not found', async () => {
    const m = manager as unknown as Record<string, unknown>;
    m.getAutoloop = vi.fn().mockReturnValue(undefined);
    m.autoloopStatus = vi.fn().mockReturnValue(undefined);
    await server.start();

    const unknown = await request(port, '/autoloop/nope/chat', { method: 'POST', body: { text: 'hi' } });
    expect(unknown.status).toBe(404);
    expect((unknown.body as { error: string }).error).toBe("Autoloop run 'nope' not found");

    (m.autoloopStatus as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('Invalid run id');
    });
    const malformed = await request(port, '/autoloop/bad..id/chat', { method: 'POST', body: { text: 'hi' } });
    expect(malformed.status).toBe(404);
    expect((malformed.body as { error: string }).error).toBe("Autoloop run 'bad..id' not found");
  });
});

describe('EmbeddedServer — workflow event stream', () => {
  let server: EmbeddedServer;
  let manager: SessionManager;
  let port: number;

  beforeEach(async () => {
    process.env.OPENCLAW_SERVER_TOKEN = 'disabled';
    delete process.env.OPENCLAW_RATE_LIMIT;
    delete process.env.OPENCLAW_CORS_ORIGINS;
    manager = createMockManager();
    port = await getFreePort();
    server = new EmbeddedServer(manager, port);
  });

  afterAll(() => {
    delete process.env.OPENCLAW_SERVER_TOKEN;
  });

  afterEach(async () => {
    await server.stop();
  });

  /** What an SSE stream that never ends has sent within `ms`. */
  function readStream(path: string, ms = 500): Promise<string> {
    return new Promise((resolve, reject) => {
      let text = '';
      const req = http.get({ hostname: '127.0.0.1', port, path }, (res) => {
        res.on('data', (chunk) => (text += chunk));
      });
      req.on('error', reject);
      setTimeout(() => {
        req.destroy();
        resolve(text);
      }, ms);
    });
  }

  it('opens with the snapshot of a run older than any listing window', async () => {
    const m = manager as unknown as Record<string, unknown>;
    // A listing is newest first and capped; this run is not in it.
    m.workflowList = vi.fn((q: { limit?: number } = {}) =>
      Array.from({ length: q.limit ?? 25 }, (_, i) => ({ runId: `newer-${i}`, state: 'succeeded' })),
    );
    m.workflowStatus = vi.fn((runId: string) => {
      if (runId !== 'old-run') throw new Error(`Workflow run '${runId}' not found`);
      return {
        runId: 'old-run',
        workflow: 'solve',
        state: 'running',
        cwd: '/tmp',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:01.000Z',
        currentNode: 'agent',
        nodes: {},
      };
    });
    m.onWorkflowEvent = vi.fn().mockReturnValue(() => {});
    await server.start();

    const text = await readStream('/workflow/old-run/events');
    expect(text).toContain('event: snapshot');
    const data = JSON.parse(text.slice(text.indexOf('data: ') + 6, text.indexOf('\n\n')));
    expect(data).toMatchObject({ runId: 'old-run', state: 'running', currentNode: 'agent' });
    // A summary, like the listing's rows, not the whole record.
    expect(data).not.toHaveProperty('nodes');

    const unknown = await readStream('/workflow/nope/events');
    expect(unknown).not.toContain('event: snapshot');
  });
});

describe('/login redirect target', () => {
  // The value is URL-decoded before it gets here, and browsers drop tabs and
  // newlines and read `\\` as `/` when they resolve `Location`.
  it.each([
    '//evil.com',
    '/\\evil.com',
    '/\t/evil.com',
    '/\n/evil.com',
    '/.//evil.com',
    '/a/..//evil.com',
    'https://evil.com',
    'evil.com',
    '',
  ])('keeps %j on this server', (raw) => {
    const target = loginRedirectTarget(raw);
    expect(new URL(target, 'http://127.0.0.1:18796').host).toBe('127.0.0.1:18796');
    expect(target.startsWith('//')).toBe(false);
  });

  it('passes an ordinary path through with its query and fragment', () => {
    expect(loginRedirectTarget('/dashboard?tab=runs#r1')).toBe('/dashboard?tab=runs#r1');
    expect(loginRedirectTarget(null)).toBe('/dashboard');
  });
});

describe('sameSecret', () => {
  it('matches only the exact secret', () => {
    expect(sameSecret('Bearer abc', 'Bearer abc')).toBe(true);
    expect(sameSecret('Bearer abd', 'Bearer abc')).toBe(false);
    expect(sameSecret('Bearer ab', 'Bearer abc')).toBe(false);
    expect(sameSecret(undefined, 'abc')).toBe(false);
    expect(sameSecret(null, 'abc')).toBe(false);
  });
});

describe('parseRequestTarget', () => {
  it('accepts origin-form paths and refuses everything else', () => {
    expect(parseRequestTarget('/session/list?x=1', 1)!.pathname).toBe('/session/list');
    expect(parseRequestTarget(undefined, 1)!.pathname).toBe('/');
    for (const t of ['//[/', '//evil.com/x', 'http://evil.com/', '*', 'session/list']) {
      expect(parseRequestTarget(t, 1)).toBeUndefined();
    }
  });
});
