/**
 * Unit tests for EmbeddedServer — HTTP server for standalone/CLI usage
 *
 * Strategy: create a real server on an ephemeral port, send HTTP requests,
 * and verify responses. SessionManager methods are mocked.
 */

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import * as http from 'node:http';
import * as net from 'node:net';
import { EmbeddedServer, __sseSenderForTest as sseSenderForTest } from '../embedded-server.js';
import type { SessionManager } from '../session-manager.js';
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
  options: { method?: string; body?: string; contentType?: string },
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: options.method || 'POST',
        headers: { 'Content-Type': options.contentType || 'application/json' },
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
        const res = await request(port, '/health');
        expect(res.status).toBe(200);
      }
    });

    it('returns 429 when rate limit exceeded', async () => {
      process.env.OPENCLAW_RATE_LIMIT = '2';
      port = await getFreePort();
      server = new EmbeddedServer(manager, port);
      await server.start();

      await request(port, '/health');
      await request(port, '/health');
      const res = await request(port, '/health');
      expect(res.status).toBe(429);
      expect((res.body as Record<string, string>).error).toContain('Rate limit');
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

    it('returns 400 for invalid JSON body', async () => {
      await server.start();

      const res = await rawRequest(port, '/session/start', { body: '{invalid json' });

      expect(res.status).toBe(400);
      expect((res.body as Record<string, string>).error).toContain('Invalid JSON');
    });
  });
});
