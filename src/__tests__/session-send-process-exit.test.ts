/**
 * A Claude process that exits in the middle of a turn, before its result event,
 * is a failed turn at the tool boundary — not a reply.
 *
 * Issue #161's reproduction, kept offline: a Node fixture stands in for the
 * `claude` CLI through the public `launcher` option, speaks just enough
 * stream-json to start a session, and on the user message either exits with
 * code 1 (with and without partial output) or answers normally (the control).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clawo-exit-'));
const saved = { sessions: process.env.CLAWO_SESSIONS_DIR, runs: process.env.CLAWO_RUNS_DIR };
process.env.CLAWO_SESSIONS_DIR = path.join(tmp, 'sessions');
process.env.CLAWO_RUNS_DIR = path.join(tmp, 'runs');

const FIXTURE = `
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
const mode = process.argv[2];
const id = randomUUID();
const emit = (v) => process.stdout.write(JSON.stringify(v) + '\\n');
emit({ type: 'system', subtype: 'init', session_id: id });
createInterface({ input: process.stdin }).on('line', (line) => {
  if (JSON.parse(line).type !== 'user') return;
  if (mode === 'success') {
    emit({ type: 'result', subtype: 'success', is_error: false, result: 'Complete reply', session_id: id });
    return;
  }
  if (mode === 'partial') {
    const msg = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Partial reply before crash' }] } };
    process.stdout.write(JSON.stringify(msg) + '\\n', () => process.exit(1));
  } else process.exit(1);
});
`;

interface Tool {
  name: string;
  execute: (id: string, params: Record<string, unknown>) => Promise<{ details: Record<string, unknown> }>;
}

let tools: Tool[] = [];
const fixture = path.join(tmp, 'fake-claude.mjs');
const tool = (name: string) => tools.find((t) => t.name === name)!;

beforeAll(async () => {
  fs.writeFileSync(fixture, FIXTURE);
  const { default: plugin } = await import('../index.js');
  const api = {
    pluginConfig: {},
    logger: { info: () => {}, error: () => {}, warn: () => {} },
    registerTool: (def: Tool) => tools.push(def),
    on: () => {},
    registerHttpRoute: () => {},
    registerService: () => {},
  };
  (plugin as unknown as { register: (a: unknown) => void }).register(api);
});

afterAll(() => {
  tools = [];
  for (const [k, v] of [
    ['CLAWO_SESSIONS_DIR', saved.sessions],
    ['CLAWO_RUNS_DIR', saved.runs],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function sendOnce(mode: 'empty' | 'partial' | 'success') {
  const name = `exit-${mode}`;
  await tool('session_start').execute('start', {
    name,
    engine: 'claude',
    cwd: tmp,
    noSessionPersistence: true,
    launcher: [process.execPath, fixture, mode],
  });
  try {
    return (await tool('session_send').execute('send', { name, message: 'test', timeout: 10_000 })).details;
  } finally {
    await tool('session_stop')
      .execute('stop', { name })
      .catch(() => undefined);
  }
}

describe('session_send when the engine process exits mid-turn', () => {
  it('reports a failed turn when the process exits before any output', async () => {
    const r = await sendOnce('empty');
    expect(r.ok).toBe(false);
    expect(r.error).toBe('the claude process exited with code 1 before the turn finished');
    expect(r.output).toBe('');
  }, 30_000);

  it('reports a failed turn and keeps the partial output when the process exits after some', async () => {
    const r = await sendOnce('partial');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/exited with code 1 before the turn finished/);
    expect(r.output).toBe('Partial reply before crash');
  }, 30_000);

  it('still reports a completed turn as ok', async () => {
    const r = await sendOnce('success');
    expect(r.ok).toBe(true);
    expect(r.error).toBeUndefined();
    expect(r.output).toBe('Complete reply');
  }, 30_000);
});
