/**
 * The CLI as a script drives it: `--message-file`, `--json`, and a
 * failure's exit status. Runs bin/cli.ts against a stub HTTP server.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = path.join(ROOT, 'bin', 'cli.ts');
const TSX = path.join(ROOT, 'node_modules', '.bin', 'tsx');

let server: http.Server;
let url = '';
const bodies: Array<Record<string, unknown>> = [];

function run(args: string[], apiUrl = url): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(TSX, [CLI, ...args], {
      env: { ...process.env, CLAWO_API_URL: apiUrl, CLAWO_AUTH_TOKEN: 'test-token' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      bodies.push({ path: req.url, ...body });
      res.setHeader('content-type', 'application/json');
      if (req.url === '/session/send') res.end(JSON.stringify({ ok: true, output: 'DONE', sessionId: 'sid-1' }));
      else if (req.url === '/session/status') res.end(JSON.stringify({ ok: true, stats: { turns: 1, toolCalls: 3 } }));
      else if (req.url === '/workflow/new') res.end(JSON.stringify({ ok: true, runId: 'run-1' }));
      else res.end(JSON.stringify({ ok: false, error: 'no such route' }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => server.close());

describe('session CLI for scripts', () => {
  it('sends a message read from a file and prints the result as JSON', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawo-cli-'));
    const file = path.join(dir, 'msg.md');
    fs.writeFileSync(file, '--starts with a dash\nand spans lines');
    const r = await run(['session-send', 's', '--message-file', file, '--json']);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout.trim().split('\n').pop()!)).toMatchObject({ ok: true, output: 'DONE' });
    expect(bodies.find((b) => b.path === '/session/send')).toMatchObject({
      name: 's',
      message: '--starts with a dash\nand spans lines',
    });
  }, 30_000);

  // The server returns a reply when the turn ends and has no streamed form of
  // /session/send, so the flag stays only so existing scripts still parse.
  it('accepts --stream, says it has no effect, and sends nothing for it', async () => {
    const before = bodies.length;
    const r = await run(['session-send', 's', 'hi', '--stream']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('DONE');
    expect(bodies.slice(before).find((b) => b.path === '/session/send')).not.toHaveProperty('stream');
    const help = await run(['session-send', '--help']);
    expect(help.stdout).toMatch(/-s, --stream\s+No effect/);
  }, 30_000);

  it('prints the status as JSON', async () => {
    const r = await run(['session-status', 's', '--json']);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout.trim().split('\n').pop()!).stats.toolCalls).toBe(3);
  }, 30_000);

  it('names an ACP agent as acp:<preset> in an agent list', async () => {
    const r = await run(['fanout', 'task', '-e', 'claude,acp:kimi-code,acp:dsh', '--json']);
    expect(r.code).toBe(0);
    const spec = bodies.find((b) => b.path === '/workflow/new')!.spec as {
      nodes: Array<{ agents?: Array<Record<string, unknown>> }>;
    };
    expect(spec.nodes[0]!.agents).toEqual([
      { name: 'claude', engine: 'claude' },
      { name: 'kimi-code', engine: 'acp', acpAgent: 'kimi-code' },
      { name: 'dsh', engine: 'acp', acpAgent: 'dsh' },
    ]);
  }, 30_000);

  it('refuses engine acp without the agent, before calling the server', async () => {
    const before = bodies.length;
    const r = await run(['solve', 'task', '-e', 'acp']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('acp:<preset>');
    expect(bodies.length).toBe(before);
  }, 30_000);

  it('exits 1 when the server cannot be reached', async () => {
    const r = await run(['session-list'], 'http://127.0.0.1:1');
    expect(r.stderr).toContain('Failed: Cannot connect');
    expect(r.code).toBe(1);
  }, 30_000);
});

describe('clawo serve', () => {
  it('exits 1 with a message when its port is already taken', async () => {
    const holder = net.createServer();
    await new Promise<void>((r) => holder.listen(0, '127.0.0.1', r));
    const port = (holder.address() as AddressInfo).port;
    try {
      // Its own process group: tsx runs the script in a child process, which
      // killing tsx alone would leave behind.
      const child = spawn(TSX, [CLI, 'serve', '-p', String(port)], { env: process.env, detached: true });
      let stderr = '';
      child.stderr.on('data', (d) => (stderr += d));
      // A serve that cannot bind and does not exit keeps running forever, so
      // give it a deadline rather than wait for a close that never comes.
      const code = await new Promise<number | null>((resolve) => {
        const deadline = setTimeout(() => {
          process.kill(-child.pid!, 'SIGKILL');
          resolve(null);
        }, 20_000);
        child.on('close', (c) => {
          clearTimeout(deadline);
          resolve(c);
        });
      });
      expect(code).toBe(1);
      expect(stderr).toContain(`port ${port} is already in use`);
    } finally {
      holder.close();
    }
  }, 30_000);
});
