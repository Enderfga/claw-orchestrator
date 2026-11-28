/**
 * Every plugin tool over HTTP: `GET /tool` lists them, `POST /tool/<name>` runs
 * one with the body as its parameters, so a caller with only a shell (`clawo
 * tool`) reaches the tools that have no route or command of their own.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import * as net from 'node:net';
import { EmbeddedServer, type HttpTool } from '../embedded-server.js';
import { toolsFor } from '../index.js';
import type { SessionManager } from '../session-manager.js';

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

function call(
  port: number,
  path: string,
  method = 'GET',
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path, method, headers: { 'Content-Type': 'application/json' } },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data ? JSON.parse(data) : undefined }));
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

describe('the /tool route', () => {
  let server: EmbeddedServer;
  let port: number;
  const calls: Array<Record<string, unknown>> = [];
  const saved = process.env.OPENCLAW_SERVER_TOKEN;

  beforeEach(async () => {
    process.env.OPENCLAW_SERVER_TOKEN = 'disabled';
    calls.length = 0;
    port = await freePort();
    server = new EmbeddedServer({ listSessions: () => [] } as unknown as SessionManager, port);
    const tools = new Map<string, HttpTool>([
      [
        'echo_tool',
        {
          description: 'Echo the parameters. Second sentence.',
          execute: async (_id, params) => {
            calls.push(params);
            return { content: [{ type: 'text', text: 'x' }], details: { ok: true, got: params } };
          },
        },
      ],
      ['refusing_tool', { execute: async () => ({ content: [], details: { ok: false, error: 'not today' } }) }],
    ]);
    server.setTools(tools);
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
    if (saved === undefined) delete process.env.OPENCLAW_SERVER_TOKEN;
    else process.env.OPENCLAW_SERVER_TOKEN = saved;
  });

  it('lists the tools, runs one with the body as its parameters, and returns its result', async () => {
    const list = await call(port, '/tool');
    expect(list.status).toBe(200);
    expect((list.body.tools as Array<{ name: string }>).map((t) => t.name)).toEqual(['echo_tool', 'refusing_tool']);

    const r = await call(port, '/tool/echo_tool', 'POST', { name: 'rev', engines: ['codex'] });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, result: { ok: true, got: { name: 'rev', engines: ['codex'] } } });
    expect(calls).toEqual([{ name: 'rev', engines: ['codex'] }]);

    // A tool's own failure is in its result; the route itself answered.
    expect((await call(port, '/tool/refusing_tool', 'POST', {})).body).toEqual({
      ok: true,
      result: { ok: false, error: 'not today' },
    });
  });

  it('refuses an unknown tool, a GET that would run one, and an inline custom engine', async () => {
    const unknown = await call(port, '/tool/no_such_tool', 'POST', {});
    expect(unknown.status).toBe(404);
    expect(unknown.body.error).toMatch(/no tool 'no_such_tool'/);
    expect((await call(port, '/tool/echo_tool', 'GET')).status).toBe(405);
    const inline = await call(port, '/tool/echo_tool', 'POST', {
      customEngine: { name: 'x', bin: '/bin/sh', args: {} },
    });
    expect(inline.status).toBe(400);
    expect(calls).toEqual([]);
  });
});

describe('toolsFor', () => {
  it("binds every tool to the host's manager, so a tool acts on its sessions", async () => {
    let listed = 0;
    const manager = {
      listSessions: () => {
        listed += 1;
        return [{ name: 'host-session' }];
      },
      listPersistedSessions: () => [],
    } as unknown as SessionManager;
    const tools = toolsFor(manager);
    expect(tools.size).toBe(85);
    for (const name of ['ultrareview_start', 'council_start', 'session_handoff', 'autoloop_start', 'fanout_start']) {
      expect(tools.has(name)).toBe(true);
    }
    const out = await tools.get('session_list')!.execute('t', {});
    expect(listed).toBe(1);
    expect(JSON.stringify(out)).toContain('host-session');
  });
});
