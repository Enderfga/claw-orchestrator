/**
 * Claude accounts through the session manager: the credential reaches the CLI
 * in a private `--settings` file, a refused turn moves the session to the next
 * account in the rotation and continues the same conversation, and an account
 * near its limit is left before the next turn.
 *
 * A fixture stands in for the CLI through `launcher`. It reads the credential
 * from the `--settings` it was given, records what it was started with, and
 * answers like the CLI does: `tok-spent` gets the refusal measured on 2.1.322
 * (`rate_limit_event` rejected, `api_error: usage_limit_reached`), every other
 * token a reply naming it.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clawo-rotation-'));
const savedEnv = { ...process.env };
process.env.CLAWO_SESSIONS_DIR = path.join(tmp, 'sessions');
process.env.CLAWO_RUNS_DIR = path.join(tmp, 'runs');

const FIXTURE = `
import { readFileSync, statSync, appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
const argv = process.argv.slice(2);
const at = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
let env = {};
let mode = null;
argv.forEach((a, i) => {
  if (a !== '--settings') return;
  const v = argv[i + 1];
  if (v.trim().startsWith('{')) { env = { ...env, ...(JSON.parse(v).env || {}) }; return; }
  env = { ...env, ...(JSON.parse(readFileSync(v, 'utf8')).env || {}) };
  mode = (statSync(v).mode & 0o777).toString(8);
});
const token = env.CLAUDE_CODE_OAUTH_TOKEN || env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN || '';
const resume = at('--resume') ?? null;
const id = resume || randomUUID();
appendFileSync(process.env.ACCOUNT_PROBE_OUT, JSON.stringify({ argv, token, resume, mode, settings: argv[argv.indexOf('--settings') + 1] ?? null }) + '\\n');
const emit = (v) => process.stdout.write(JSON.stringify(v) + '\\n');
emit({ type: 'system', subtype: 'init', session_id: id });
const util = Number(process.env['ACCOUNT_UTIL_' + token] || '0.1');
const resetsAt = Math.floor(Date.now() / 1000) + 3600;
createInterface({ input: process.stdin }).on('line', (line) => {
  if (JSON.parse(line).type !== 'user') return;
  if (token === 'tok-spent') {
    emit({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt, rateLimitType: 'seven_day',
      unifiedWindows: { seven_day: { utilization: 1, resetsAt, status: 'rejected' } } } });
    emit({ type: 'result', subtype: 'success', is_error: true, api_error: 'usage_limit_reached', api_error_status: 429,
      result: "You've hit your weekly limit", session_id: id });
    return;
  }
  emit({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', resetsAt,
    unifiedWindows: { five_hour: { utilization: util, resetsAt, status: 'allowed' } } } });
  emit({ type: 'result', subtype: 'success', is_error: false, result: 'reply from ' + token, session_id: id });
});
`;

type Info = { claudeAccount?: string };
type Manager = {
  startSession(c: Record<string, unknown>): Promise<Info>;
  stopSession(n: string): Promise<void>;
  sendMessage(n: string, m: string, o?: Record<string, unknown>): Promise<{ output: string; error?: string }>;
  getStatus(n: string): Info;
};
let SessionManager: new (o: unknown) => Manager;
const fixture = path.join(tmp, 'fake-claude.mjs');
let n = 0;

beforeAll(async () => {
  fs.writeFileSync(fixture, FIXTURE);
  ({ SessionManager } = (await import('../session-manager.js')) as unknown as {
    SessionManager: typeof SessionManager;
  });
});

afterEach(() => {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('CLAWO_CLAUDE_') || k.startsWith('ACCOUNT_')) delete process.env[k];
  }
  for (const k of ['ANTHROPIC_BASE_URL', 'CLAWO_CLAUDE_GATEWAY']) {
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

/** An accounts file, the tokens in the environment, and a fresh probe log. */
function setup(doc: Record<string, unknown>, tokens: Record<string, string>): () => Array<Record<string, unknown>> {
  delete process.env.ANTHROPIC_BASE_URL;
  delete process.env.CLAWO_CLAUDE_GATEWAY;
  const file = path.join(tmp, `accounts-${++n}.json`);
  fs.writeFileSync(file, JSON.stringify(doc));
  process.env.CLAWO_CLAUDE_ACCOUNTS = file;
  for (const [name, token] of Object.entries(tokens)) process.env[`CLAWO_CLAUDE_TOKEN_${name.toUpperCase()}`] = token;
  const probe = path.join(tmp, `probe-${n}.jsonl`);
  process.env.ACCOUNT_PROBE_OUT = probe;
  return () =>
    fs.existsSync(probe)
      ? fs
          .readFileSync(probe, 'utf8')
          .trim()
          .split('\n')
          .map((l) => JSON.parse(l))
      : [];
}

function manager(): Manager {
  return new SessionManager({ logger: { info() {}, warn() {}, error() {}, debug() {} } });
}

async function start(mgr: Manager, config: Record<string, unknown>): Promise<string> {
  const name = `acct-${++n}`;
  await mgr.startSession({ name, engine: 'claude', cwd: tmp, launcher: [process.execPath, fixture], ...config });
  return name;
}

describe('Claude accounts', () => {
  it('hands the credential over in a private settings file, never on the command line', async () => {
    const spawns = setup({ accounts: { team: {} } }, { team: 'tok-team' });
    const mgr = manager();
    const name = await start(mgr, { claudeAccount: 'team' });
    try {
      const r = await mgr.sendMessage(name, 'hi', { timeout: 10_000 });
      expect(r.output).toBe('reply from tok-team');
      const [s] = spawns();
      expect(s.token).toBe('tok-team');
      expect(s.mode).toBe('600');
      expect(JSON.stringify(s.argv)).not.toContain('tok-team');
      expect(mgr.getStatus(name).claudeAccount).toBe('team');
    } finally {
      await mgr.stopSession(name);
    }
    expect(fs.existsSync(spawns()[0].settings as string)).toBe(false);
  }, 30_000);

  it('moves a refused turn to the next account and continues the same conversation', async () => {
    const spawns = setup(
      { accounts: { spent: {}, fresh: {} }, rotation: ['spent', 'fresh'] },
      { spent: 'tok-spent', fresh: 'tok-fresh' },
    );
    const mgr = manager();
    // forkSession: a fork on the new process would start a different conversation.
    const name = await start(mgr, { claudeAccount: 'auto', forkSession: true });
    try {
      const r = await mgr.sendMessage(name, 'hi', { timeout: 10_000 });
      expect(r.error).toBeUndefined();
      expect(r.output).toBe('reply from tok-fresh');
      // The replaced process's exit must not take the new one down with it.
      expect((await mgr.sendMessage(name, 'again', { timeout: 10_000 })).output).toBe('reply from tok-fresh');
      const [first, second] = spawns();
      expect(first.token).toBe('tok-spent');
      expect(second.token).toBe('tok-fresh');
      // The new process resumes the first one's conversation, not a fork of it.
      expect(second.resume).toBeTruthy();
      expect(second.argv).not.toContain('--fork-session');
      expect(mgr.getStatus(name).claudeAccount).toBe('fresh');

      // The pool remembers: a new session asking for `auto` starts on the fresh account.
      const other = await start(mgr, { claudeAccount: 'auto' });
      expect(mgr.getStatus(other).claudeAccount).toBe('fresh');
      await mgr.stopSession(other);
    } finally {
      await mgr.stopSession(name);
    }
  }, 30_000);

  it('leaves an account at its switch threshold before the next turn', async () => {
    const spawns = setup(
      { accounts: { busy: {}, idle: {} }, rotation: ['busy', 'idle'], switchAt: 0.9 },
      { busy: 'tok-busy', idle: 'tok-idle' },
    );
    process.env['ACCOUNT_UTIL_tok-busy'] = '0.93';
    const mgr = manager();
    const name = await start(mgr, { claudeAccount: 'busy' });
    try {
      expect((await mgr.sendMessage(name, 'one', { timeout: 10_000 })).output).toBe('reply from tok-busy');
      expect((await mgr.sendMessage(name, 'two', { timeout: 10_000 })).output).toBe('reply from tok-idle');
      expect(spawns().map((s) => s.token)).toEqual(['tok-busy', 'tok-idle']);
    } finally {
      await mgr.stopSession(name);
    }
  }, 30_000);

  it('does not move an account outside the rotation', async () => {
    const spawns = setup(
      { accounts: { spent: {}, fresh: {} }, rotation: ['fresh'] },
      { spent: 'tok-spent', fresh: 'tok-fresh' },
    );
    const mgr = manager();
    const name = await start(mgr, { claudeAccount: 'spent' });
    try {
      const r = await mgr.sendMessage(name, 'hi', { timeout: 10_000 });
      expect(r.error).toMatch(/weekly limit/);
      expect(spawns()).toHaveLength(1);
    } finally {
      await mgr.stopSession(name);
    }
  }, 30_000);

  it('does not move a session that keeps no transcript to resume', async () => {
    const spawns = setup(
      { accounts: { spent: {}, fresh: {} }, rotation: ['spent', 'fresh'] },
      { spent: 'tok-spent', fresh: 'tok-fresh' },
    );
    const mgr = manager();
    const name = await start(mgr, { claudeAccount: 'spent', noSessionPersistence: true });
    try {
      expect((await mgr.sendMessage(name, 'hi', { timeout: 10_000 })).error).toMatch(/weekly limit/);
      expect(spawns()).toHaveLength(1);
    } finally {
      await mgr.stopSession(name);
    }
  }, 30_000);

  it("applies the file's default to a session that names no account, and only where it can", async () => {
    const spawns = setup({ accounts: { team: {} }, default: 'team' }, { team: 'tok-team' });
    const mgr = manager();
    const name = await start(mgr, {});
    expect(mgr.getStatus(name).claudeAccount).toBe('team');
    await mgr.stopSession(name);
    // A session pointed at its own endpoint keeps it.
    const own = await start(mgr, { baseUrl: 'http://127.0.0.1:9' });
    expect(mgr.getStatus(own).claudeAccount).toBeUndefined();
    await mgr.stopSession(own);
    expect(spawns().map((s) => s.token)).toEqual(['tok-team', '']);
  }, 30_000);

  it('refuses an account that cannot apply, or whose credential is missing', async () => {
    setup({ accounts: { team: {}, gone: {} } }, { team: 'tok-team' });
    const mgr = manager();
    await expect(start(mgr, { claudeAccount: 'team', baseUrl: 'http://127.0.0.1:9' })).rejects.toThrow(
      /cannot be combined with baseUrl/,
    );
    await expect(start(mgr, { claudeAccount: 'gone' })).rejects.toThrow(/CLAWO_CLAUDE_TOKEN_GONE is not set/);
    await expect(start(mgr, { claudeAccount: 'nobody' })).rejects.toThrow(/Unknown Claude account 'nobody'/);
  }, 30_000);
});
