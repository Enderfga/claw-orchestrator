/**
 * The session CLI as a script drives it: `--message-file`, `--json`, and a
 * failure's exit status. Runs bin/cli.ts against a stub HTTP server.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
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

  it('prints the status as JSON', async () => {
    const r = await run(['session-status', 's', '--json']);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout.trim().split('\n').pop()!).stats.toolCalls).toBe(3);
  }, 30_000);

  it('exits 1 when the server cannot be reached', async () => {
    const r = await run(['session-list'], 'http://127.0.0.1:1');
    expect(r.stderr).toContain('Failed: Cannot connect');
    expect(r.code).toBe(1);
  }, 30_000);
});
