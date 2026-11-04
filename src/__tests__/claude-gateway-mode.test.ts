/**
 * `CLAWO_CLAUDE_GATEWAY=1`: a `claude` session on a non-Claude model talks to the
 * caller's own Anthropic-compatible gateway with the model's own name.
 *
 * Without it, a non-Claude model on the claude engine is routed through the
 * built-in proxy (no baseUrl) or renamed to `opus` behind a `/real/<model>` base
 * URL (with one), both of which only clawo's proxy understands. A fixture stands
 * in for the CLI through `launcher` and records what it was started with.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clawo-gateway-'));
const savedEnv = { ...process.env };
process.env.CLAWO_SESSIONS_DIR = path.join(tmp, 'sessions');
process.env.CLAWO_RUNS_DIR = path.join(tmp, 'runs');

const FIXTURE = `
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
writeFileSync(process.env.GATEWAY_PROBE_OUT, JSON.stringify({ argv: process.argv.slice(2), base: process.env.ANTHROPIC_BASE_URL ?? null }));
const id = randomUUID();
const emit = (v) => process.stdout.write(JSON.stringify(v) + '\\n');
emit({ type: 'system', subtype: 'init', session_id: id });
createInterface({ input: process.stdin }).on('line', (line) => {
  if (JSON.parse(line).type !== 'user') return;
  emit({ type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: id, total_cost_usd: 1.5,
    usage: { input_tokens: 1000, output_tokens: 100 } });
});
`;

type Manager = {
  startSession(c: Record<string, unknown>): Promise<unknown>;
  stopSession(n: string): Promise<void>;
  sendMessage(n: string, m: string, o?: Record<string, unknown>): Promise<unknown>;
  getStatus(n: string): { stats: { costUsd: number } };
};
let SessionManager: new (o: unknown) => Manager;
const fixture = path.join(tmp, 'fake-claude.mjs');
let n = 0;
let proxyStarts = 0;

beforeAll(async () => {
  fs.writeFileSync(fixture, FIXTURE);
  ({ SessionManager } = (await import('../session-manager.js')) as unknown as {
    SessionManager: typeof SessionManager;
  });
});

afterEach(() => {
  for (const k of ['CLAWO_CLAUDE_GATEWAY', 'ANTHROPIC_BASE_URL']) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

afterAll(() => {
  for (const k of ['CLAWO_SESSIONS_DIR', 'CLAWO_RUNS_DIR']) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Start one claude session through the fixture and return what the CLI was started with. */
async function started(config: Record<string, unknown>): Promise<{ argv: string[]; base: string | null }> {
  const out = path.join(tmp, `probe-${++n}.json`);
  process.env.GATEWAY_PROBE_OUT = out;
  const mgr = new SessionManager({ logger: { info() {}, warn() {}, error() {}, debug() {} } });
  // The built-in proxy, as if an OpenClaw gateway were configured; without one
  // it would not start, and the no-baseUrl cases would prove nothing.
  proxyStarts = 0;
  (mgr as unknown as { _ensureProxyServer: () => Promise<number> })._ensureProxyServer = async () => {
    proxyStarts++;
    return 54321;
  };
  const name = `gw-${n}`;
  await mgr.startSession({
    name,
    engine: 'claude',
    cwd: tmp,
    noSessionPersistence: true,
    launcher: [process.execPath, fixture],
    ...config,
  });
  try {
    return JSON.parse(fs.readFileSync(out, 'utf8'));
  } finally {
    await mgr.stopSession(name).catch(() => undefined);
  }
}

const modelArg = (argv: string[]) => argv[argv.indexOf('--model') + 1];

describe('claude engine in gateway mode (CLAWO_CLAUDE_GATEWAY=1)', () => {
  it('sends a non-Claude model by name to the gateway in ANTHROPIC_BASE_URL, with no proxy', async () => {
    process.env.CLAWO_CLAUDE_GATEWAY = '1';
    process.env.ANTHROPIC_BASE_URL = 'https://gateway.example.com';
    const r = await started({ model: 'gw-model-1' });
    expect(modelArg(r.argv)).toBe('gw-model-1');
    expect(r.base).toBe('https://gateway.example.com');
    expect(proxyStarts).toBe(0);
  }, 30_000);

  it('uses an explicit baseUrl as given, without the /real/ rewrite', async () => {
    process.env.CLAWO_CLAUDE_GATEWAY = '1';
    delete process.env.ANTHROPIC_BASE_URL;
    const r = await started({ model: 'gw-model-1', baseUrl: 'https://gateway.example.com' });
    expect(modelArg(r.argv)).toBe('gw-model-1');
    expect(r.base).toBe('https://gateway.example.com');
  }, 30_000);

  it('keeps a model name that contains a slash whole', async () => {
    process.env.CLAWO_CLAUDE_GATEWAY = '1';
    process.env.ANTHROPIC_BASE_URL = 'https://gateway.example.com';
    const r = await started({ model: 'vendor/model-x' });
    expect(modelArg(r.argv)).toBe('vendor/model-x');
  }, 30_000);

  it('still routes a non-Claude model through the built-in proxy when the switch is off', async () => {
    delete process.env.CLAWO_CLAUDE_GATEWAY;
    process.env.ANTHROPIC_BASE_URL = 'https://gateway.example.com';
    const r = await started({ model: 'gw-model-1' });
    expect(proxyStarts).toBe(1);
    expect(modelArg(r.argv)).toBe('opus');
    expect(r.base).toBe('http://127.0.0.1:54321/real/gw-model-1');
  }, 30_000);

  it('leaves the built-in proxy mapping alone when the switch is off', async () => {
    delete process.env.CLAWO_CLAUDE_GATEWAY;
    const r = await started({ model: 'gw-model-1', baseUrl: 'http://127.0.0.1:9' });
    expect(modelArg(r.argv)).toBe('opus');
    expect(r.base).toBe('http://127.0.0.1:9/real/gw-model-1');
  }, 30_000);

  it('does not take the CLI cost figure for a gateway model, which the CLI cannot price', async () => {
    process.env.CLAWO_CLAUDE_GATEWAY = '1';
    process.env.ANTHROPIC_BASE_URL = 'https://gateway.example.com';
    const cost = async (model: string) => {
      const mgr = new SessionManager({ logger: { info() {}, warn() {}, error() {}, debug() {} } });
      const name = `gw-cost-${++n}`;
      process.env.GATEWAY_PROBE_OUT = path.join(tmp, `probe-${n}.json`);
      await mgr.startSession({
        name,
        engine: 'claude',
        cwd: tmp,
        noSessionPersistence: true,
        model,
        launcher: [process.execPath, fixture],
      });
      try {
        await mgr.sendMessage(name, 'hi', { timeout: 10_000 });
        return mgr.getStatus(name).stats.costUsd;
      } finally {
        await mgr.stopSession(name).catch(() => undefined);
      }
    };
    expect(await cost('gw-model-1')).toBe(0);
    // A Claude model through the same gateway keeps the CLI's figure.
    expect(await cost('sonnet')).toBe(1.5);
  }, 30_000);
});
