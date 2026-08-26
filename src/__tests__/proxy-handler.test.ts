/**
 * Unit tests for proxy/handler.ts — createProxyHandler
 *
 * Strategy: test through the exported createProxyHandler using mock
 * HttpRequest/HttpResponse objects. We mock global fetch to avoid
 * real network calls.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createProxyHandler,
  getAnthropicBaseUrl,
  _resetAnthropicBaseUrlCache,
  type ProxyEnv,
} from '../proxy/handler.js';
import { useIsolatedHome } from './helpers/isolate-home.js';

useIsolatedHome();

describe('getAnthropicBaseUrl (3-layer fallback)', () => {
  const savedEnv = process.env.ANTHROPIC_BASE_URL;
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.ANTHROPIC_BASE_URL;
    else process.env.ANTHROPIC_BASE_URL = savedEnv;
    _resetAnthropicBaseUrlCache();
  });

  it('Layer 1: ANTHROPIC_BASE_URL env var takes priority', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://example.test/anthropic';
    _resetAnthropicBaseUrlCache();
    expect(getAnthropicBaseUrl()).toBe('https://example.test/anthropic');
  });

  it('memoizes — a later env change is ignored until cache reset', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://first.test';
    _resetAnthropicBaseUrlCache();
    expect(getAnthropicBaseUrl()).toBe('https://first.test');
    process.env.ANTHROPIC_BASE_URL = 'https://second.test';
    expect(getAnthropicBaseUrl()).toBe('https://first.test'); // cached
    _resetAnthropicBaseUrlCache();
    expect(getAnthropicBaseUrl()).toBe('https://second.test'); // re-read after reset
  });

  // ── Layer 2 must read the anthropic provider, by name.
  //
  //    It iterated every provider and returned the first baseUrl it found, so a
  //    config listing any other provider above `anthropic` sent Anthropic
  //    passthrough — `x-api-key: $ANTHROPIC_API_KEY` and the whole prompt body
  //    — to that provider's host instead.
  it('Layer 2: reads the anthropic provider, not whichever key comes first', () => {
    delete process.env.ANTHROPIC_BASE_URL;
    const dir = path.join(os.homedir(), '.openclaw');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'openclaw.json'),
      JSON.stringify({
        providers: {
          openai: { baseUrl: 'https://someone-elses-proxy.test' },
          anthropic: { baseUrl: 'https://anthropic.test' },
        },
      }),
    );
    _resetAnthropicBaseUrlCache();

    expect(getAnthropicBaseUrl()).toBe('https://anthropic.test');
  });

  it('Layer 2: falls through to the default when no anthropic provider is configured', () => {
    delete process.env.ANTHROPIC_BASE_URL;
    const dir = path.join(os.homedir(), '.openclaw');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'openclaw.json'),
      JSON.stringify({ providers: { openai: { baseUrl: 'https://someone-elses-proxy.test' } } }),
    );
    _resetAnthropicBaseUrlCache();

    expect(getAnthropicBaseUrl()).not.toBe('https://someone-elses-proxy.test');
    expect(getAnthropicBaseUrl()).toMatch(/anthropic/);
  });

  it('returns a valid https URL when no env var is set (config or default layer)', () => {
    delete process.env.ANTHROPIC_BASE_URL;
    _resetAnthropicBaseUrlCache();
    expect(getAnthropicBaseUrl()).toMatch(/^https?:\/\//);
  });
});

// ─── Mock fetch ────────────────────────────────────────────────────────────

const mockFetch = vi.fn<typeof globalThis.fetch>();
vi.stubGlobal('fetch', mockFetch);

// ─── Helpers ───────────────────────────────────────────────────────────────

function makeReq(overrides: Partial<{ method: string; url: string; body: unknown }> = {}) {
  return {
    method: overrides.method || 'POST',
    url: overrides.url || '/v1/messages',
    headers: {} as Record<string, string>,
    json: vi.fn().mockResolvedValue(overrides.body || {}),
  };
}

function makeRes() {
  const res = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: null as unknown,
    written: [] as string[],
    ended: false,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(data: unknown) {
      res.body = data;
    },
    setHeader(key: string, value: string) {
      res.headers[key] = value;
    },
    write(data: string) {
      res.written.push(data);
    },
    end() {
      res.ended = true;
    },
    flushHeaders() {},
  };
  return res;
}

function makeAnthropicBody(model: string, stream = false) {
  return {
    model,
    max_tokens: 1024,
    messages: [{ role: 'user', content: 'Hello' }],
    stream,
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('createProxyHandler', () => {
  const env: ProxyEnv = {
    anthropicApiKey: 'sk-ant-test-key',
    openaiApiKey: 'sk-openai-test',
    geminiApiKey: 'gemini-test-key',
  };

  let handler: ReturnType<typeof createProxyHandler>;

  beforeEach(() => {
    mockFetch.mockReset();
    handler = createProxyHandler(undefined, env);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('HEAD/GET probes', () => {
    it('responds 200 to HEAD requests', async () => {
      const req = makeReq({ method: 'HEAD' });
      const res = makeRes();
      const result = await handler(req as never, res as never);
      expect(result).toBe(true);
      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({ status: 'ok' });
    });

    it('responds 200 to GET requests', async () => {
      const req = makeReq({ method: 'GET' });
      const res = makeRes();
      const result = await handler(req as never, res as never);
      expect(result).toBe(true);
      expect(res.statusCode).toBe(200);
    });
  });

  describe('model extraction from URL', () => {
    it('extracts model from /real/<model>/v1/messages path', async () => {
      // Mock the Anthropic passthrough
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 'msg_1', type: 'message', content: [], role: 'assistant' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      const req = makeReq({
        url: '/real/claude-sonnet-4-6/v1/messages',
        body: makeAnthropicBody('claude-opus-4-6'),
      });
      const res = makeRes();
      await handler(req as never, res as never);

      // The fetch should be called with the URL model (claude-sonnet-4-6), not body model
      // Since claude-sonnet-4-6 is an Anthropic model, it forwards to Anthropic
      expect(mockFetch).toHaveBeenCalled();
    });
  });

  describe('provider routing', () => {
    it('forwards Anthropic models to Anthropic API', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 'msg_1',
            type: 'message',
            content: [{ type: 'text', text: 'hi' }],
            role: 'assistant',
            stop_reason: 'end_turn',
            usage: { input_tokens: 10, output_tokens: 5 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );

      const req = makeReq({ body: makeAnthropicBody('claude-sonnet-4-6') });
      const res = makeRes();
      await handler(req as never, res as never);

      expect(mockFetch).toHaveBeenCalled();
      const fetchUrl = mockFetch.mock.calls[0][0] as string;
      expect(fetchUrl).toContain('anthropic');
    });

    it('converts and forwards GPT models to OpenAI API', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 'chatcmpl-1',
            object: 'chat.completion',
            choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );

      const req = makeReq({ body: makeAnthropicBody('gpt-5.4') });
      const res = makeRes();
      await handler(req as never, res as never);

      expect(mockFetch).toHaveBeenCalled();
      const fetchUrl = mockFetch.mock.calls[0][0] as string;
      expect(fetchUrl).toContain('openai.com');
    });

    it('converts and forwards Gemini models to Google API', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 'chatcmpl-1',
            object: 'chat.completion',
            choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );

      const req = makeReq({ body: makeAnthropicBody('gemini-2.5-pro') });
      const res = makeRes();
      await handler(req as never, res as never);

      expect(mockFetch).toHaveBeenCalled();
      const fetchUrl = mockFetch.mock.calls[0][0] as string;
      expect(fetchUrl).toContain('generativelanguage.googleapis.com');
    });

    it('returns 401 when no API key for provider', async () => {
      const noKeyHandler = createProxyHandler(undefined, {});
      const req = makeReq({ body: makeAnthropicBody('gpt-5.4') });
      const res = makeRes();
      await noKeyHandler(req as never, res as never);

      expect(res.statusCode).toBe(401);
    });
  });

  describe('Anthropic passthrough', () => {
    it('returns 401 when no ANTHROPIC_API_KEY', async () => {
      const noKeyHandler = createProxyHandler(undefined, {});
      const req = makeReq({ body: makeAnthropicBody('claude-sonnet-4-6') });
      const res = makeRes();
      await noKeyHandler(req as never, res as never);

      expect(res.statusCode).toBe(401);
      expect(res.body).toEqual({ error: 'No ANTHROPIC_API_KEY configured' });
    });

    it('forwards non-streaming Anthropic requests with retry support', async () => {
      // First call returns 429, second succeeds
      mockFetch
        .mockResolvedValueOnce(new Response('', { status: 429, headers: { 'Retry-After': '0' } }))
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ id: 'msg_2', type: 'message', content: [], role: 'assistant' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );

      const req = makeReq({ body: makeAnthropicBody('claude-sonnet-4-6', false) });
      const res = makeRes();
      await handler(req as never, res as never);

      // fetchWithRetry retries on 429
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(res.statusCode).toBe(200);
    });

    // ── A streaming error must not arrive as an empty success.
    //
    //    The streaming branch piped the body without checking `resp.ok`, so a
    //    401/429/500 reached the caller as HTTP 200 with SSE headers and a JSON
    //    error body — which an SSE parser reads as a stream that said nothing.
    //    The three sibling paths in this file already guarded it.
    it('reports an upstream error on the streaming path instead of an empty stream', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ type: 'error', error: { type: 'authentication_error' } }), { status: 401 }),
      );

      const req = makeReq({ body: makeAnthropicBody('claude-sonnet-4-6', true) });
      const res = makeRes();
      await handler(req as never, res as never);

      expect(res.statusCode).toBe(401);
      expect(res.headers['Content-Type']).not.toBe('text/event-stream');
    });

    it('still streams a successful upstream response', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response('event: message_start\ndata: {}\n\n', {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        }),
      );

      const req = makeReq({ body: makeAnthropicBody('claude-sonnet-4-6', true) });
      const res = makeRes();
      await handler(req as never, res as never);

      expect(res.headers['Content-Type']).toBe('text/event-stream');
    });

    it('passes through upstream error status', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ type: 'error', error: { type: 'rate_limit', message: 'Too many requests' } }), {
          status: 529,
        }),
      );

      const req = makeReq({ body: makeAnthropicBody('claude-sonnet-4-6', false) });
      const res = makeRes();
      await handler(req as never, res as never);

      // Non-retryable status (529 not in RETRY_STATUS_CODES) — passed through directly
      expect(res.statusCode).toBe(529);
    });
  });

  describe('streaming', () => {
    it('sets SSE headers and streams GPT response chunks', async () => {
      // Create a streaming response with SSE data
      const sseData = [
        'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}\n\n',
        'data: [DONE]\n\n',
      ].join('');

      mockFetch.mockResolvedValueOnce(
        new Response(sseData, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        }),
      );

      const req = makeReq({ body: makeAnthropicBody('gpt-5.4', true) });
      const res = makeRes();
      await handler(req as never, res as never);

      expect(res.headers['Content-Type']).toBe('text/event-stream');
      expect(res.headers['Cache-Control']).toBe('no-cache');
      expect(res.ended).toBe(true);
      // Should have written SSE chunks
      expect(res.written.length).toBeGreaterThan(0);
    });

    it('handles upstream streaming error', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response('{"error": "bad request"}', {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      const req = makeReq({ body: makeAnthropicBody('gpt-5.4', true) });
      const res = makeRes();
      await handler(req as never, res as never);

      expect(res.statusCode).toBe(400);
      expect(res.body).toEqual(
        expect.objectContaining({
          type: 'error',
          error: expect.objectContaining({ type: 'api_error' }),
        }),
      );
    });

    it('handles null response body gracefully', async () => {
      // Create a response without a body
      const resp = new Response(null, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
      // Override body to null
      Object.defineProperty(resp, 'body', { value: null });

      mockFetch.mockResolvedValueOnce(resp);

      const req = makeReq({ body: makeAnthropicBody('gpt-5.4', true) });
      const res = makeRes();
      await handler(req as never, res as never);

      expect(res.ended).toBe(true);
    });
  });

  describe('error handling', () => {
    it('returns 500 on fetch failure', async () => {
      mockFetch.mockRejectedValue(new Error('Network error'));

      const req = makeReq({ body: makeAnthropicBody('gpt-5.4') });
      const res = makeRes();
      await handler(req as never, res as never);

      expect(res.statusCode).toBe(500);
      expect(res.body).toEqual(
        expect.objectContaining({
          type: 'error',
          error: expect.objectContaining({ type: 'server_error' }),
        }),
      );
    });

    it('returns timeout message on AbortError', async () => {
      const err = new Error('Timeout');
      err.name = 'TimeoutError';
      mockFetch.mockRejectedValue(err);

      const req = makeReq({ body: makeAnthropicBody('gpt-5.4') });
      const res = makeRes();
      await handler(req as never, res as never);

      expect(res.statusCode).toBe(500);
      expect((res.body as Record<string, Record<string, string>>).error.message).toBe('Upstream request timed out');
    });

    it('handles JSON parse error from request body', async () => {
      const req = makeReq();
      req.json.mockRejectedValue(new Error('Invalid JSON'));
      const res = makeRes();
      await handler(req as never, res as never);

      expect(res.statusCode).toBe(500);
    });

    it('forwards non-200 from direct provider (non-streaming)', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response('{"error": "invalid"}', {
          status: 422,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      const req = makeReq({ body: makeAnthropicBody('gpt-5.4') });
      const res = makeRes();
      await handler(req as never, res as never);

      // 422 is not in RETRY_STATUS_CODES, so it passes through
      expect(res.statusCode).toBe(422);
    });
  });
});
