import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import {
  ClaudeAccountPool,
  accountEnv,
  defaultTokenEnv,
  loadClaudeAccounts,
  readAccountSecret,
  removeAccountSettings,
  writeAccountSettings,
  type ClaudeAccountsConfig,
} from '../claude-accounts.js';

let dir: string;
let file: string;
const write = (doc: unknown) => fs.writeFileSync(file, typeof doc === 'string' ? doc : JSON.stringify(doc));

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawo-accounts-'));
  file = path.join(dir, 'claude-accounts.json');
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('loadClaudeAccounts', () => {
  it('treats a missing file as no accounts', () => {
    expect(loadClaudeAccounts(file)).toBeNull();
  });

  it('reads the three kinds, the rotation, the default and switchAt', () => {
    write({
      accounts: {
        team: {},
        payg: { kind: 'apiKey', tokenEnv: 'BACKUP_KEY' },
        gw: { kind: 'gateway', baseUrl: 'http://127.0.0.1:8080/', tokenCommand: ['pass', 'gw'], env: { X: '1' } },
      },
      rotation: ['team', 'payg', 'gw'],
      default: 'auto',
      switchAt: 0.9,
    });
    const c = loadClaudeAccounts(file)!;
    expect(c.accounts.team).toEqual({ name: 'team', kind: 'oauth' });
    expect(c.accounts.payg).toEqual({ name: 'payg', kind: 'apiKey', tokenEnv: 'BACKUP_KEY' });
    expect(c.accounts.gw).toEqual({
      name: 'gw',
      kind: 'gateway',
      tokenCommand: ['pass', 'gw'],
      baseUrl: 'http://127.0.0.1:8080',
      env: { X: '1' },
    });
    expect(c.rotation).toEqual(['team', 'payg', 'gw']);
    expect(c.default).toBe('auto');
    expect(c.switchAt).toBe(0.9);
  });

  it('defaults switchAt to 0.95 and leaves no default', () => {
    write({ accounts: { a: {} } });
    const c = loadClaudeAccounts(file)!;
    expect(c.switchAt).toBe(0.95);
    expect(c.default).toBeUndefined();
    expect(c.rotation).toEqual([]);
  });

  it.each([
    ['not JSON', '{ nope', /not valid JSON/],
    ['no accounts object', { rotation: [] }, /`accounts` must be an object/],
    ['a bad name', { accounts: { 'a b': {} } }, /letters, digits/],
    ['an unknown kind', { accounts: { a: { kind: 'magic' } } }, /unknown kind/],
    ['a gateway without baseUrl', { accounts: { g: { kind: 'gateway' } } }, /needs an http\(s\) baseUrl/],
    ['env on an oauth account', { accounts: { a: { env: { X: '1' } } } }, /gateway accounts only/],
    ['a bad tokenCommand', { accounts: { a: { tokenCommand: 'pass a' } } }, /tokenCommand must be/],
    ['an unknown account in rotation', { accounts: { a: {} }, rotation: ['b'] }, /unknown account "b"/],
    ['an account twice in rotation', { accounts: { a: {} }, rotation: ['a', 'a'] }, /twice/],
    ['default auto without a rotation', { accounts: { a: {} }, default: 'auto' }, /non-empty `rotation`/],
    ['an unknown default', { accounts: { a: {} }, default: 'b' }, /unknown account "b"/],
    ['switchAt out of range', { accounts: { a: {} }, switchAt: 1.5 }, /switchAt/],
    [
      'a gateway on another host over plain http',
      { accounts: { g: { kind: 'gateway', baseUrl: 'http://gw.example.com:8080' } } },
      /must use https unless it is on this machine/,
    ],
  ])('rejects %s', (_label, doc, error) => {
    write(doc);
    expect(() => loadClaudeAccounts(file)).toThrow(error);
  });

  it.each(['http://localhost:8080', 'http://127.0.0.1:8080', 'http://[::1]:8080', 'https://gw.example.com'])(
    'accepts a gateway at %s',
    (baseUrl) => {
      write({ accounts: { g: { kind: 'gateway', baseUrl } } });
      expect(loadClaudeAccounts(file)!.accounts.g.baseUrl).toBe(baseUrl);
    },
  );

  // The file names commands to run and endpoints to send credentials to.
  it.runIf(typeof process.getuid === 'function')('refuses a file that group or others can write', () => {
    write({ accounts: { a: {} } });
    for (const mode of [0o664, 0o646, 0o666]) {
      fs.chmodSync(file, mode);
      expect(() => loadClaudeAccounts(file)).toThrow(/must not be writable by group or others/);
    }
    for (const mode of [0o600, 0o644]) {
      fs.chmodSync(file, mode);
      expect(loadClaudeAccounts(file)).not.toBeNull();
    }
  });
});

describe('readAccountSecret', () => {
  it('reads CLAWO_CLAUDE_TOKEN_<NAME> by default', async () => {
    expect(defaultTokenEnv('team-2')).toBe('CLAWO_CLAUDE_TOKEN_TEAM_2');
    vi.stubEnv('CLAWO_CLAUDE_TOKEN_TEAM_2', ' tok-team \n');
    expect(await readAccountSecret({ name: 'team-2', kind: 'oauth' })).toBe('tok-team');
  });

  it('reads the named tokenEnv', async () => {
    vi.stubEnv('BACKUP_KEY', 'sk-backup');
    expect(await readAccountSecret({ name: 'payg', kind: 'apiKey', tokenEnv: 'BACKUP_KEY' })).toBe('sk-backup');
  });

  it("takes a tokenCommand's trimmed stdout", async () => {
    const secret = await readAccountSecret({
      name: 'cmd',
      kind: 'oauth',
      tokenCommand: [process.execPath, '-e', 'console.log("  tok-from-command  ")'],
    });
    expect(secret).toBe('tok-from-command');
  });

  it('names the source when the secret is missing, instead of falling back to another login', async () => {
    vi.stubEnv('CLAWO_CLAUDE_TOKEN_GONE', '');
    await expect(readAccountSecret({ name: 'gone', kind: 'oauth' })).rejects.toThrow(
      /CLAWO_CLAUDE_TOKEN_GONE is not set/,
    );
    await expect(
      readAccountSecret({ name: 'cmd', kind: 'oauth', tokenCommand: [process.execPath, '-e', 'process.exit(3)'] }),
    ).rejects.toThrow(/tokenCommand exited 3/);
  });
});

describe('accountEnv', () => {
  it('sets the kind’s credential and neutralises the others', () => {
    expect(accountEnv({ name: 'a', kind: 'oauth' }, 'tok')).toEqual({
      CLAUDE_CODE_OAUTH_TOKEN: 'tok',
      ANTHROPIC_API_KEY: '',
      ANTHROPIC_AUTH_TOKEN: '',
      ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
    });
    expect(accountEnv({ name: 'k', kind: 'apiKey' }, 'sk')).toEqual({
      ANTHROPIC_API_KEY: 'sk',
      CLAUDE_CODE_OAUTH_TOKEN: '',
      ANTHROPIC_AUTH_TOKEN: '',
      ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
    });
    // The gateway's own env first, so it cannot override the credential.
    expect(
      accountEnv(
        { name: 'g', kind: 'gateway', baseUrl: 'http://gw', env: { ANTHROPIC_AUTH_TOKEN: 'nope', X: '1' } },
        'gwtok',
      ),
    ).toEqual({
      X: '1',
      ANTHROPIC_BASE_URL: 'http://gw',
      ANTHROPIC_AUTH_TOKEN: 'gwtok',
      ANTHROPIC_API_KEY: '',
      CLAUDE_CODE_OAUTH_TOKEN: '',
    });
  });
});

describe('ClaudeAccountPool', () => {
  const config: ClaudeAccountsConfig = {
    accounts: { a: { name: 'a', kind: 'oauth' }, b: { name: 'b', kind: 'oauth' }, c: { name: 'c', kind: 'apiKey' } },
    rotation: ['a', 'b', 'c'],
    switchAt: 0.95,
  };
  let t = 1_000_000;
  const now = () => t;

  it('picks the first available account in rotation order', () => {
    const pool = new ClaudeAccountPool(config, now);
    expect(pool.pick()).toBe('a');
    expect(pool.pick('a')).toBe('b');
  });

  it('skips an account that refused a turn until its window resets', () => {
    const pool = new ClaudeAccountPool(config, now);
    pool.record('a', { limited: true, resetsAt: t + 5_000 });
    expect(pool.available('a')).toBe(false);
    expect(pool.pick()).toBe('b');
    t += 5_001;
    expect(pool.available('a')).toBe(true);
  });

  it('sets a refused account aside for an hour when no reset was reported', () => {
    const pool = new ClaudeAccountPool(config, now);
    pool.record('b', { limited: true });
    expect(pool.available('b')).toBe(false);
    t += 60 * 60_000 + 1;
    expect(pool.available('b')).toBe(true);
  });

  it('treats an account at switchAt as spent until its window resets', () => {
    const pool = new ClaudeAccountPool(config, now);
    pool.record('a', { limited: false, utilization: 0.94, resetsAt: t + 1_000 });
    expect(pool.available('a')).toBe(true);
    pool.record('a', { limited: false, utilization: 0.96, resetsAt: t + 1_000 });
    expect(pool.available('a')).toBe(false);
    t += 1_001;
    expect(pool.available('a')).toBe(true);
  });

  it('keeps usage across a reload when given the same state map', () => {
    const state = new Map();
    new ClaudeAccountPool(config, now, state).record('a', { limited: true, resetsAt: t + 10_000 });
    expect(new ClaudeAccountPool(config, now, state).available('a')).toBe(false);
  });

  it('returns nothing when every account is spent', () => {
    const pool = new ClaudeAccountPool(config, now);
    for (const n of ['a', 'b', 'c']) pool.record(n, { limited: true, resetsAt: t + 10_000 });
    expect(pool.pick()).toBeUndefined();
  });
});

describe('the credential file', () => {
  const tmp = os.tmpdir();

  it('is 0600 in a 0700 directory named for this process, and goes when removed', () => {
    const { dir, file } = writeAccountSettings({ env: { X: '1' } });
    expect(path.basename(dir)).toMatch(new RegExp(`^clawo-account-${process.pid}-`));
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ env: { X: '1' } });
    if (process.platform !== 'win32') {
      expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    }
    removeAccountSettings(dir);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("is removed after a crash by the next server, and a live server's is kept", async () => {
    const dead = spawnSync(process.execPath, ['-e', '']).pid;
    const stale = fs.mkdtempSync(path.join(tmp, `clawo-account-${dead}-`));
    const live = fs.mkdtempSync(path.join(tmp, `clawo-account-${process.ppid}-`));
    vi.resetModules();
    const fresh = await import('../claude-accounts.js');
    const { dir } = fresh.writeAccountSettings({});
    try {
      expect(fs.existsSync(stale)).toBe(false);
      expect(fs.existsSync(live)).toBe(true);
    } finally {
      fresh.removeAccountSettings(dir);
      fs.rmSync(live, { recursive: true, force: true });
      fs.rmSync(stale, { recursive: true, force: true });
    }
  });

  it('is removed when the server exits with it still in use', async () => {
    const mod = new URL('../claude-accounts.ts', import.meta.url).href;
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        `const m = await import(${JSON.stringify(mod)}); console.log(m.writeAccountSettings({}).dir);`,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    const code = await new Promise((resolve) => child.on('close', resolve));
    expect(code).toBe(0);
    const dir = out.trim();
    expect(path.basename(dir)).toMatch(/^clawo-account-\d+-/);
    expect(fs.existsSync(dir)).toBe(false);
  }, 30_000);
});
