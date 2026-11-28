/**
 * The held OpenCode server's plumbing: the server process and its calls (with a
 * stand-in `opencode serve` script), the message helpers, the work follower,
 * and the quota parser.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  OpencodeApiError,
  OpencodeServer,
  foldMessages,
  followSessionWork,
  messageComplete,
  messagesAfter,
  type OpencodeMessage,
} from '../opencode-server.js';
import { parseUsageLimits } from '../opencode-quota.js';

/** A stand-in for `opencode serve --stdio --port 0`: prints its URL, checks basic auth, exits on stdin's end. */
const FAKE_SERVE = `
const http = require('node:http');
const mode = process.env.FAKE_MODE || 'ok';
if (mode === 'nourl') { console.log('not json'); setInterval(() => {}, 1000); process.stdin.on('end', () => process.exit(0)); process.stdin.resume(); }
else {
  const server = http.createServer((req, res) => {
    const want = 'Basic ' + Buffer.from('opencode:' + process.env.OPENCODE_PASSWORD).toString('base64');
    if (req.headers.authorization !== want) { res.writeHead(401); return res.end(JSON.stringify({ _tag: 'UnauthorizedError', message: 'no' })); }
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      if (url.pathname === '/missing') { res.writeHead(404); return res.end(JSON.stringify({ _tag: 'CommandNotFoundError', message: 'Command not found: x' })); }
      if (url.pathname === '/empty') { res.writeHead(204); return res.end(); }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ method: req.method, path: url.pathname, dir: url.searchParams.get('location[directory]'), body: body ? JSON.parse(body) : null, cwd: process.cwd() }));
    });
  });
  server.listen(0, '127.0.0.1', () => console.log(JSON.stringify({ url: 'http://127.0.0.1:' + server.address().port })));
  process.stdin.on('end', () => process.exit(0));
  process.stdin.resume();
}
`;

describe('OpencodeServer', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawo-oc-server-'));
  const script = path.join(dir, 'fake-serve.cjs');
  fs.writeFileSync(script, FAKE_SERVE);
  const servers: OpencodeServer[] = [];
  const make = (env: NodeJS.ProcessEnv = {}) => {
    const s = new OpencodeServer({
      bin: 'opencode',
      cwd: dir,
      env: { ...process.env, ...env },
      launcher: [process.execPath, script],
    });
    servers.push(s);
    return s;
  };

  afterEach(() => {
    for (const s of servers.splice(0)) s.stop();
  });

  it('starts, and calls the API in its location with its password', async () => {
    const s = make();
    const url = await s.start();
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(s.alive).toBe(true);
    const r = await s.call<{ method: string; path: string; dir: string; body: unknown; cwd: string }>(
      'POST',
      '/api/session/ses_1/command',
      { name: 'x', text: '' },
    );
    expect(r).toMatchObject({ method: 'POST', path: '/api/session/ses_1/command', dir, body: { name: 'x', text: '' } });
    expect(fs.realpathSync(r.cwd)).toBe(fs.realpathSync(dir));
    expect(await s.call('POST', '/empty')).toBeUndefined();
    // The same start is shared.
    expect(await s.start()).toBe(url);
  });

  it("throws OpenCode's error class on a non-2xx answer", async () => {
    const s = make();
    await s.start();
    const err = await s.call('GET', '/missing').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OpencodeApiError);
    expect(err).toMatchObject({ status: 404, tag: 'CommandNotFoundError' });
    expect((err as Error).message).toMatch(/Command not found/);
  });

  it('fails to start when the first line is not its URL, and is not alive', async () => {
    const s = make({ FAKE_MODE: 'nourl' });
    await expect(s.start()).rejects.toThrow(/did not print its URL/);
    expect(s.alive).toBe(false);
    expect(s.pid).toBeUndefined();
    await expect(s.call('GET', '/x')).rejects.toThrow(/not running/);
  });

  it('stops when its stdin ends', async () => {
    const s = make();
    await s.start();
    const pid = s.pid!;
    s.stop();
    expect(s.alive).toBe(false);
    await new Promise((r) => setTimeout(r, 300));
    expect(() => process.kill(pid, 0)).toThrow();
  });
});

/** A server object answering from a message list (newest last). */
function fakeServer(messages: OpencodeMessage[], extra: (method: string, p: string) => unknown = () => undefined) {
  const calls: Array<{ method: string; path: string; query?: Record<string, string> }> = [];
  const server = {
    calls,
    async call(method: string, p: string, _body?: unknown, opts?: { query?: Record<string, string> }) {
      calls.push({ method, path: p, query: opts?.query });
      const x = extra(method, p);
      if (x !== undefined) return x;
      if (p.endsWith('/message')) {
        const limit = Number(opts?.query?.limit ?? 100);
        const newestFirst = [...messages].reverse();
        const start = opts?.query?.cursor ? Number(opts.query.cursor) : 0;
        const page = newestFirst.slice(start, start + limit);
        const next = start + limit < newestFirst.length ? String(start + limit) : null;
        return { data: page, cursor: { next } };
      }
      if (p === '/api/session/active') return { data: {} };
      if (p === '/api/permission/request' || p === '/api/form') return { data: [] };
      return undefined;
    },
  };
  return server as unknown as OpencodeServer & { calls: typeof calls };
}

describe('messages', () => {
  it('pages back to the message it follows, and returns oldest first', async () => {
    const msgs = Array.from({ length: 7 }, (_, i) => ({ id: `m${i}`, type: 'user' }));
    const s = fakeServer(msgs);
    expect((await messagesAfter(s, 'ses', 'm2', 2)).map((m) => m.id)).toEqual(['m3', 'm4', 'm5', 'm6']);
    expect((await messagesAfter(s, 'ses', undefined, 3)).map((m) => m.id)).toEqual(msgs.map((m) => m.id));
  });

  it('an assistant message is complete once it has a completion time, a finish or an error', () => {
    expect(messageComplete({ id: 'a', type: 'assistant', content: [] })).toBe(false);
    expect(messageComplete({ id: 'a', type: 'assistant', time: { created: 1, completed: 2 } })).toBe(true);
    expect(messageComplete({ id: 'a', type: 'assistant', finish: 'stop' })).toBe(true);
    expect(messageComplete({ id: 'c', type: 'compaction', status: 'running' })).toBe(false);
    expect(messageComplete({ id: 'u', type: 'user' })).toBe(true);
  });

  it('folds the text of each step, the tools, and why the work failed', () => {
    const fold = foldMessages([
      { id: 'u', type: 'user', text: 'x' },
      {
        id: 'a1',
        type: 'assistant',
        content: [
          { type: 'text', text: 'first.' },
          { type: 'tool', name: 'shell', state: { status: 'error' } },
        ],
      },
      {
        id: 'a2',
        type: 'assistant',
        content: [
          { type: 'reasoning', text: 'hidden' },
          { type: 'text', text: 'second' },
        ],
      },
      { id: 'i', type: 'idle', outcome: 'failed', error: { message: 'boom ANTHROPIC_API_KEY=sk-abcdefghijklmnop' } },
    ]);
    expect(fold).toMatchObject({ text: 'first.\n\nsecond', toolCalls: 1, toolErrors: 1, outcome: 'failed' });
    expect(fold.error).toContain('ANTHROPIC_API_KEY=***');
    expect(foldMessages([{ id: 'i', type: 'idle', outcome: 'succeeded' }]).error).toBeUndefined();
  });
});

describe('followSessionWork', () => {
  it('ends with no messages when the work wrote none and the session stayed idle', async () => {
    const s = fakeServer([{ id: 'old', type: 'idle', outcome: 'succeeded' }]);
    const r = await followSessionWork(s, 'ses', async () => {}, {
      timeoutMs: 5_000,
      allowPermissions: false,
      pollMs: 5,
      settleMs: 30,
    });
    expect(r).toEqual({ messages: [], idle: true, timedOut: false });
  });

  it('interrupts work that outlives its timeout', async () => {
    const msgs: OpencodeMessage[] = [{ id: 'old', type: 'idle' }];
    const s = fakeServer(msgs, (method, p) => {
      if (method === 'POST' && p.endsWith('/interrupt')) {
        msgs.push({ id: 'end', type: 'idle', outcome: 'interrupted' });
        return { interrupted: true };
      }
      return undefined;
    });
    const r = await followSessionWork(
      s,
      'ses',
      async () => {
        msgs.push({ id: 'u', type: 'user', text: 'long' }, { id: 'a', type: 'assistant', content: [] });
      },
      { timeoutMs: 30, allowPermissions: false, pollMs: 5 },
    );
    expect(s.calls.some((c) => c.path === '/api/session/ses/interrupt')).toBe(true);
    expect(r).toMatchObject({ idle: true, timedOut: true });
    expect(foldMessages(r.messages).outcome).toBe('interrupted');
  });

  it('hands each new message over once, when it is complete', async () => {
    const msgs: OpencodeMessage[] = [];
    const s = fakeServer(msgs);
    const seen: string[] = [];
    let polls = 0;
    const r = await followSessionWork(
      s,
      'ses',
      async () => {
        msgs.push({ id: 'a', type: 'assistant', content: [{ type: 'text', text: 'partial' }] });
      },
      {
        timeoutMs: 5_000,
        allowPermissions: false,
        pollMs: 5,
        onMessage: (m) => {
          seen.push(`${m.id}:${assistantTextOf(m)}`);
        },
        cancelled: () => {
          polls++;
          if (polls === 2) {
            msgs[0] = { id: 'a', type: 'assistant', finish: 'stop', content: [{ type: 'text', text: 'whole' }] };
            msgs.push({ id: 'i', type: 'idle', outcome: 'succeeded' });
          }
          return false;
        },
      },
    );
    expect(r.idle).toBe(true);
    expect(seen).toEqual(['a:whole', 'i:']);
  });
});

function assistantTextOf(m: OpencodeMessage): string {
  return (m.content ?? []).map((c) => c.text ?? '').join('');
}

describe('parseUsageLimits', () => {
  it('nothing metered is nothing to report', () => {
    expect(parseUsageLimits({ data: null }, 's')).toBeUndefined();
    expect(parseUsageLimits(undefined, 's')).toBeUndefined();
    expect(parseUsageLimits({ data: { workspace: { id: 'w' }, budgets: [] } }, 's')).toBeUndefined();
  });

  it('reads the Go meters and the budgets', () => {
    const q = parseUsageLimits(
      {
        data: {
          workspace: { id: 'w', name: 'Team' },
          go: {
            rolling: { percent: 12.5, limited: false, resetsAt: Date.UTC(2026, 11, 1) },
            weekly: { percent: 40, limited: false, resetsAt: 0 },
            monthly: { percent: 101, limited: true, resetsAt: Date.UTC(2027, 0, 1) },
          },
          budgets: [{ id: 'b1', limit: 20, spent: 5, resetsAt: Date.UTC(2026, 11, 31) }],
        },
      },
      'opencode /usage',
    );
    expect(q).toMatchObject({ engine: 'opencode', plan: 'OpenCode Go', source: 'opencode /usage' });
    expect(q!.windows).toEqual([
      { name: '5h', usedPercent: 12.5, remainingPercent: 87.5, resetsAt: '2026-12-01T00:00:00.000Z' },
      { name: 'weekly', usedPercent: 40, remainingPercent: 60 },
      { name: 'monthly', usedPercent: 100, remainingPercent: 0, resetsAt: '2027-01-01T00:00:00.000Z' },
      { name: 'budget b1', usedPercent: 25, remainingPercent: 75, resetsAt: '2026-12-31T00:00:00.000Z' },
    ]);
  });
});
