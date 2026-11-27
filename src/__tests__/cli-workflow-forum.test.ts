/**
 * `clawo solve --forum` and `clawo goal --forum` put the run's agents on a run
 * forum, as `clawo fanout --forum` does. Runs bin/cli.ts against a stub server.
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
const specs: Array<{
  name?: string;
  forum?: unknown;
  nodes?: Array<{ id: string; agents?: Array<{ name: string }> }>;
}> = [];

function run(args: string[]): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn(TSX, [CLI, ...args], {
      env: { ...process.env, CLAWO_API_URL: url, CLAWO_AUTH_TOKEN: 'test-token' },
    });
    child.stdout.resume();
    child.stderr.resume();
    child.on('close', resolve);
  });
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/workflow/new') {
        specs.push((JSON.parse(raw) as { spec: (typeof specs)[number] }).spec);
        res.end(JSON.stringify({ ok: true, runId: 'run-1', state: 'pending' }));
      } else res.end(JSON.stringify({ ok: false, error: 'no such route' }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => server.close());

describe('--forum on solve and goal', () => {
  it('clawo solve --forum starts a run with a forum, and without the flag none', async () => {
    expect(await run(['solve', 'fix it', '--claude', '--forum', '--json'])).toBe(0);
    expect(await run(['solve', 'fix it', '--claude', '--json'])).toBe(0);
    const solves = specs.filter((s) => s.name === 'solve');
    expect(solves.map((s) => s.forum)).toEqual([true, undefined]);
  }, 60_000);

  it('clawo solve --forum names a reviewer apart from the scout of its engine; without the flag, as before', async () => {
    const before = specs.length;
    expect(await run(['solve', 'fix X', '--codex', '--reviewers', 'codex', '--forum', '--json'])).toBe(0);
    expect(await run(['solve', 'fix X', '--codex', '--reviewers', 'codex', '--json'])).toBe(0);
    const names = (s: (typeof specs)[number], id: string) =>
      s.nodes?.find((n) => n.id === id)?.agents?.map((a) => a.name);
    const [on, off] = specs.slice(before);
    expect(on.forum).toBe(true);
    expect(names(on, 'triage')).toEqual(['codex']);
    expect(names(on, 'review')).toEqual(['codex-review']);
    expect(off.forum).toBeUndefined();
    expect(names(off, 'review')).toEqual(['codex']);
  }, 60_000);

  it('clawo goal --forum starts a run with a forum, and without the flag none', async () => {
    expect(await run(['goal', 'make it pass', '--claude', '--forum', '--json'])).toBe(0);
    expect(await run(['goal', 'make it pass', '--claude', '--json'])).toBe(0);
    const goals = specs.filter((s) => s.name === 'goal');
    expect(goals.map((s) => s.forum)).toEqual([true, undefined]);
  }, 60_000);
});
