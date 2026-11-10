/**
 * The built-in proxy forwards requests with the host's provider and gateway
 * credentials, so only the engine it was started for may use it: callers must
 * present the per-process secret in the base URL path, and nothing is read or
 * forwarded before that check. Bodies are bounded and must be JSON.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import * as http from 'node:http';
import * as net from 'node:net';

import { SessionManager } from '../session-manager.js';

const silent = { info() {}, warn() {}, error() {}, debug() {} };
const saved = { url: process.env.GATEWAY_URL, key: process.env.GATEWAY_KEY };

let mgr: SessionManager;
let port: number;
let fetchSpy: ReturnType<typeof vi.spyOn>;

function send(
  path: string,
  options: { method?: string; body?: string; contentType?: string } = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: options.method ?? 'POST',
        headers: options.body === undefined ? {} : { 'Content-Type': options.contentType ?? 'application/json' },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on('error', reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

const messages = JSON.stringify({ model: 'gw-model', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] });

beforeAll(async () => {
  process.env.GATEWAY_URL = 'http://127.0.0.1:9';
  process.env.GATEWAY_KEY = 'gateway-test-key';
  mgr = new SessionManager({ logger: silent });
  port = (await (mgr as unknown as { _ensureProxyServer(): Promise<number | null> })._ensureProxyServer()) as number;
  expect(port).toBeGreaterThan(0);
});

afterAll(async () => {
  await mgr.shutdown();
  if (saved.url === undefined) delete process.env.GATEWAY_URL;
  else process.env.GATEWAY_URL = saved.url;
  if (saved.key === undefined) delete process.env.GATEWAY_KEY;
  else process.env.GATEWAY_KEY = saved.key;
});

beforeEach(() => {
  fetchSpy?.mockRestore();
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify({ id: 'x', choices: [{ message: { role: 'assistant', content: 'ok' } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );
});

describe('auto-proxy caller authentication', () => {
  it('refuses a request without the per-process secret and forwards nothing', async () => {
    for (const path of ['/v1/messages', '/real/gw-model/v1/messages', '/wrong-secret/v1/messages']) {
      const res = await send(path, { body: messages });
      expect(res.status, path).toBe(401);
    }
    const probe = await send('/v1/messages', { method: 'GET' });
    expect(probe.status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('forwards a request under the secret base URL, with the secret stripped', async () => {
    const base = new URL((mgr as unknown as { _proxyBaseUrl(p: number): string })._proxyBaseUrl(port));
    expect(base.pathname).toMatch(/^\/[0-9a-f]{48}$/);

    const res = await send(`${base.pathname}/real/gw-model/v1/messages`, { body: messages });
    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:9/chat/completions');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer gateway-test-key');

    const probe = await send(`${base.pathname}/v1/messages`, { method: 'HEAD' });
    expect(probe.status).toBe(200);
  });

  it('accepts only JSON POST bodies under the secret', async () => {
    const base = new URL((mgr as unknown as { _proxyBaseUrl(p: number): string })._proxyBaseUrl(port));
    const plain = await send(`${base.pathname}/v1/messages`, { body: messages, contentType: 'text/plain' });
    expect(plain.status).toBe(415);
    const put = await send(`${base.pathname}/v1/messages`, { method: 'PUT', body: messages });
    expect(put.status).toBe(405);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuses an oversized body without forwarding it', async () => {
    const base = new URL((mgr as unknown as { _proxyBaseUrl(p: number): string })._proxyBaseUrl(port));
    const status = await new Promise<number>((resolve, reject) => {
      const socket = net.connect(port, '127.0.0.1', () => {
        socket.write(
          `POST ${base.pathname}/v1/messages HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\n` +
            `Content-Length: ${64 * 1024 * 1024}\r\n\r\n{`,
        );
      });
      let data = '';
      socket.on('data', (c) => (data += c));
      socket.on('close', () => resolve(Number(/^HTTP\/1\.1 (\d{3})/.exec(data)?.[1] ?? 0)));
      socket.on('error', reject);
    });
    expect(status).toBe(413);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
