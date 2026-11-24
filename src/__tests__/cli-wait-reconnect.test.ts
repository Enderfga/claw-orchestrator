/**
 * `--wait` returns when the run does, not when its event stream does. A long
 * node can go many minutes without an event, and Node's fetch drops a response
 * body that stays silent for five; the CLI then read the run as still running
 * and exited 1 in the middle of it. Here the stub's stream closes at once, every
 * time, and the run finishes a few seconds later.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = path.join(ROOT, 'bin', 'cli.ts');
const TSX = path.join(ROOT, 'node_modules', '.bin', 'tsx');

let server: http.Server;
let url = '';
let startedAt = 0;
let streams = 0;

const run = (state: string) => ({
  runId: 'run-1',
  workflow: 'fanout',
  state,
  outcome: state === 'completed' ? 'unverified' : undefined,
  nodes: { fanout: { id: 'fanout', kind: 'fanout', state: state === 'completed' ? 'succeeded' : 'running' } },
});

beforeAll(async () => {
  server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (req.url === '/workflow/new') {
        startedAt = Date.now();
        res.setHeader('content-type', 'application/json');
        return res.end(JSON.stringify({ ok: true, runId: 'run-1', state: 'running' }));
      }
      if (req.url?.startsWith('/workflow/run-1/events')) {
        streams += 1;
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        return res.end(); // the stream ends with the run still going
      }
      if (req.url?.startsWith('/workflow/run-1/state')) {
        res.setHeader('content-type', 'application/json');
        const done = Date.now() - startedAt > 4000;
        return res.end(JSON.stringify({ ok: true, run: run(done ? 'completed' : 'running') }));
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: false, error: 'no such route' }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe('clawo … --wait', () => {
  it('keeps following a run whose event stream ends before it does, and exits with its verdict', async () => {
    const result = await new Promise<{ code: number | null; stdout: string; ms: number }>((resolve) => {
      const t0 = Date.now();
      const child = spawn(TSX, [CLI, 'fanout', 'x', '--codex', '--wait'], {
        env: { ...process.env, CLAWO_API_URL: url, CLAWO_AUTH_TOKEN: 'test-token' },
      });
      let stdout = '';
      child.stdout.on('data', (d) => (stdout += d));
      child.on('close', (code) => resolve({ code, stdout, ms: Date.now() - t0 }));
    });
    expect(result.code).toBe(0);
    expect(result.ms).toBeGreaterThan(4000);
    expect(streams).toBeGreaterThan(1);
    expect(result.stdout).toContain('completed');
  }, 60_000);
});
