/**
 * Claude accounts — the credentials one server runs `claude` sessions under, and
 * rotation between them when one reaches its usage limit.
 *
 * File: `~/.claw-orchestrator/claude-accounts.json` (override: `CLAWO_CLAUDE_ACCOUNTS`)
 *
 *   {
 *     "accounts": {
 *       "team":    { "kind": "oauth" },
 *       "max":     { "kind": "oauth", "tokenCommand": ["security", "find-generic-password", "-s", "claude-max", "-w"] },
 *       "payg":    { "kind": "apiKey", "tokenEnv": "ANTHROPIC_BACKUP_KEY" },
 *       "gateway": { "kind": "gateway", "baseUrl": "http://127.0.0.1:8080", "env": { "ANTHROPIC_CUSTOM_HEADERS": "" } }
 *     },
 *     "rotation": ["team", "max", "payg", "gateway"],
 *     "default": "auto",
 *     "switchAt": 0.95
 *   }
 *
 * Every account keeps the one Claude Code configuration directory — skills,
 * hooks, settings and conversation transcripts are shared — and only the
 * credential changes, so a conversation continues under another account by its
 * own session id. Three kinds:
 *   - `oauth`: a subscription token from `claude setup-token` (CLAUDE_CODE_OAUTH_TOKEN);
 *   - `apiKey`: an Anthropic API key, billed per use;
 *   - `gateway`: an Anthropic-compatible endpoint with its own auth token.
 *
 * The secret comes from the server's own environment (`tokenEnv`, default
 * `CLAWO_CLAUDE_TOKEN_<NAME>`) or the stdout of a command the file names
 * (`tokenCommand`, an argv). Requests only ever name an account; a secret never
 * travels in a request, a session config, the session registry or a status reply.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { exec } from './kernel/exec.js';

export type ClaudeAccountKind = 'oauth' | 'apiKey' | 'gateway';

export interface ClaudeAccount {
  name: string;
  kind: ClaudeAccountKind;
  /** Environment variable holding the secret. Default `CLAWO_CLAUDE_TOKEN_<NAME>`. */
  tokenEnv?: string;
  /** Command whose trimmed stdout is the secret; wins over `tokenEnv`. */
  tokenCommand?: string[];
  /** `gateway` only: the endpoint. */
  baseUrl?: string;
  /** `gateway` only: extra environment the gateway needs (model discovery switches, headers). */
  env?: Record<string, string>;
}

export interface ClaudeAccountsConfig {
  accounts: Record<string, ClaudeAccount>;
  /** Accounts a session may rotate through, highest priority first. */
  rotation: string[];
  /** Account for sessions that name none: `auto` or an account name. Absent = the CLI's own login. */
  default?: string;
  /** Switch away from an account once any of its usage windows reaches this fraction. */
  switchAt: number;
}

const NAME = /^[A-Za-z0-9_-]{1,40}$/;
const KINDS: readonly ClaudeAccountKind[] = ['oauth', 'apiKey', 'gateway'];
export const DEFAULT_SWITCH_AT = 0.95;
const TOKEN_COMMAND_TIMEOUT_MS = 15_000;
const ANTHROPIC_API = 'https://api.anthropic.com';

export function claudeAccountsFile(): string {
  return process.env.CLAWO_CLAUDE_ACCOUNTS || path.join(os.homedir(), '.claw-orchestrator', 'claude-accounts.json');
}

/** `CLAWO_CLAUDE_TOKEN_<NAME>`, upper-cased, with `-` as `_`. */
export function defaultTokenEnv(name: string): string {
  return `CLAWO_CLAUDE_TOKEN_${name.toUpperCase().replace(/-/g, '_')}`;
}

function fail(file: string, message: string): never {
  throw new Error(`Claude accounts file ${file}: ${message}`);
}

/** Read and validate the accounts file. A missing file means no accounts; a bad one throws. */
export function loadClaudeAccounts(file: string = claudeAccountsFile()): ClaudeAccountsConfig | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    fail(file, `cannot be read: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail(file, 'is not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) fail(file, 'must be a JSON object');
  const doc = parsed as Record<string, unknown>;
  const rawAccounts = doc.accounts;
  if (typeof rawAccounts !== 'object' || rawAccounts === null || Array.isArray(rawAccounts)) {
    fail(file, '`accounts` must be an object mapping a name to an account');
  }

  const accounts: Record<string, ClaudeAccount> = {};
  for (const [name, value] of Object.entries(rawAccounts as Record<string, unknown>)) {
    if (!NAME.test(name)) fail(file, `account name "${name}" must be letters, digits, "-" or "_" (1-40 characters)`);
    if (typeof value !== 'object' || value === null || Array.isArray(value))
      fail(file, `account "${name}" must be an object`);
    const a = value as Record<string, unknown>;
    const kind = a.kind ?? 'oauth';
    if (!KINDS.includes(kind as ClaudeAccountKind)) fail(file, `account "${name}" has unknown kind "${String(kind)}"`);
    if (a.tokenEnv !== undefined && (typeof a.tokenEnv !== 'string' || !a.tokenEnv)) {
      fail(file, `account "${name}": tokenEnv must be a variable name`);
    }
    if (
      a.tokenCommand !== undefined &&
      (!Array.isArray(a.tokenCommand) || !a.tokenCommand.length || !a.tokenCommand.every((s) => typeof s === 'string'))
    ) {
      fail(file, `account "${name}": tokenCommand must be a non-empty array of strings (an argv)`);
    }
    if (kind === 'gateway') {
      if (typeof a.baseUrl !== 'string' || !/^https?:\/\//.test(a.baseUrl)) {
        fail(file, `gateway account "${name}" needs an http(s) baseUrl`);
      }
    } else if (a.baseUrl !== undefined || a.env !== undefined) {
      fail(file, `account "${name}": baseUrl and env apply to gateway accounts only`);
    }
    if (a.env !== undefined) {
      const env = a.env as Record<string, unknown>;
      if (
        typeof env !== 'object' ||
        env === null ||
        Array.isArray(env) ||
        !Object.values(env).every((v) => typeof v === 'string')
      ) {
        fail(file, `gateway account "${name}": env must map names to strings`);
      }
    }
    accounts[name] = {
      name,
      kind: kind as ClaudeAccountKind,
      ...(a.tokenEnv ? { tokenEnv: a.tokenEnv as string } : {}),
      ...(a.tokenCommand ? { tokenCommand: a.tokenCommand as string[] } : {}),
      ...(a.baseUrl ? { baseUrl: (a.baseUrl as string).replace(/\/$/, '') } : {}),
      ...(a.env ? { env: { ...(a.env as Record<string, string>) } } : {}),
    };
  }

  const rotation = doc.rotation ?? [];
  if (!Array.isArray(rotation) || !rotation.every((n) => typeof n === 'string')) {
    fail(file, '`rotation` must be an array of account names');
  }
  for (const n of rotation as string[]) {
    if (!Object.hasOwn(accounts, n)) fail(file, `rotation names unknown account "${n}"`);
  }
  if (new Set(rotation as string[]).size !== (rotation as string[]).length)
    fail(file, '`rotation` lists an account twice');

  const dflt = doc.default;
  if (dflt !== undefined) {
    if (typeof dflt !== 'string') fail(file, '`default` must be "auto" or an account name');
    if (dflt === 'auto' && !(rotation as string[]).length) fail(file, '`default: "auto"` needs a non-empty `rotation`');
    if (dflt !== 'auto' && !Object.hasOwn(accounts, dflt)) fail(file, `default names unknown account "${dflt}"`);
  }

  const switchAt = doc.switchAt ?? DEFAULT_SWITCH_AT;
  if (typeof switchAt !== 'number' || !(switchAt > 0 && switchAt <= 1))
    fail(file, '`switchAt` must be a number in (0, 1]');

  return {
    accounts,
    rotation: rotation as string[],
    ...(dflt !== undefined ? { default: dflt as string } : {}),
    switchAt,
  };
}

/**
 * The account's secret: `tokenCommand`'s trimmed stdout, else `tokenEnv` (or its
 * default). Throws, naming the source, when it is empty — a session must not
 * quietly fall back to another login.
 */
export async function readAccountSecret(account: ClaudeAccount): Promise<string> {
  if (account.tokenCommand) {
    const [cmd, ...args] = account.tokenCommand;
    const r = await exec(cmd, args, { timeoutMs: TOKEN_COMMAND_TIMEOUT_MS });
    const secret = r.out.trim();
    if (r.timedOut) throw new Error(`Claude account "${account.name}": tokenCommand timed out`);
    if (r.code !== 0 || !secret) {
      throw new Error(
        `Claude account "${account.name}": tokenCommand exited ${r.code ?? 'abnormally'} without a token`,
      );
    }
    return secret;
  }
  const variable = account.tokenEnv ?? defaultTokenEnv(account.name);
  const secret = process.env[variable]?.trim();
  if (!secret) throw new Error(`Claude account "${account.name}": ${variable} is not set`);
  return secret;
}

/**
 * The environment a session needs to run under `account`, handed to the CLI
 * through `--settings` so it outranks the user's settings file — a value there
 * beats the process environment. Values the other kinds would use are set to
 * neutral ones rather than left out: a credential in the user settings (a
 * gateway's base URL and token, another login's token) would otherwise win.
 */
export function accountEnv(account: ClaudeAccount, secret: string): Record<string, string> {
  switch (account.kind) {
    case 'oauth':
      return {
        CLAUDE_CODE_OAUTH_TOKEN: secret,
        ANTHROPIC_API_KEY: '',
        ANTHROPIC_AUTH_TOKEN: '',
        ANTHROPIC_BASE_URL: ANTHROPIC_API,
      };
    case 'apiKey':
      return {
        ANTHROPIC_API_KEY: secret,
        CLAUDE_CODE_OAUTH_TOKEN: '',
        ANTHROPIC_AUTH_TOKEN: '',
        ANTHROPIC_BASE_URL: ANTHROPIC_API,
      };
    case 'gateway':
      return {
        ...(account.env ?? {}),
        ANTHROPIC_BASE_URL: account.baseUrl!,
        ANTHROPIC_AUTH_TOKEN: secret,
        ANTHROPIC_API_KEY: '',
        CLAUDE_CODE_OAUTH_TOKEN: '',
      };
  }
}

/** What a session learned about an account's usage on its last turn. */
export interface AccountUsage {
  /** The account refused the turn (usage limit reached). */
  limited: boolean;
  /** Highest utilization across the reported windows, 0–1. */
  utilization?: number;
  /** When the binding window resets, epoch ms. */
  resetsAt?: number;
}

export interface AccountState {
  limitedUntil?: number;
  utilization?: number;
  resetsAt?: number;
}

/**
 * Per-account usage, shared by every session on the server: when one session
 * sees an account reach its limit, the others stop starting on it too.
 */
export class ClaudeAccountPool {
  /**
   * `state` survives a reload of the accounts file: the server passes the map it
   * already has, so an edit to the file does not forget which accounts are limited.
   */
  constructor(
    private readonly config: ClaudeAccountsConfig,
    private readonly now: () => number = Date.now,
    private readonly state: Map<string, AccountState> = new Map(),
  ) {}

  get rotation(): readonly string[] {
    return this.config.rotation;
  }

  get defaultAccount(): string | undefined {
    return this.config.default;
  }

  account(name: string): ClaudeAccount | undefined {
    return Object.hasOwn(this.config.accounts, name) ? this.config.accounts[name] : undefined;
  }

  inRotation(name: string): boolean {
    return this.config.rotation.includes(name);
  }

  record(name: string, usage: AccountUsage): void {
    const s: AccountState = { ...this.state.get(name) };
    if (usage.utilization !== undefined) s.utilization = usage.utilization;
    if (usage.resetsAt !== undefined) s.resetsAt = usage.resetsAt;
    if (usage.limited) {
      // Without a reported reset, try it again in an hour rather than never.
      s.limitedUntil = usage.resetsAt && usage.resetsAt > this.now() ? usage.resetsAt : this.now() + 60 * 60_000;
    } else if (s.limitedUntil && (usage.utilization ?? 0) < this.config.switchAt) {
      delete s.limitedUntil;
    }
    this.state.set(name, s);
  }

  /** Usable now: not refused until a reset still ahead, and under `switchAt`. */
  available(name: string): boolean {
    const s = this.state.get(name);
    if (!s) return true;
    const t = this.now();
    if (s.limitedUntil && s.limitedUntil > t) return false;
    // A window that has since reset no longer counts against the account.
    if (s.utilization !== undefined && s.utilization >= this.config.switchAt) {
      return !!(s.resetsAt && s.resetsAt <= t);
    }
    return true;
  }

  /** The first available account in rotation order, skipping `except`. */
  pick(except?: string): string | undefined {
    return this.config.rotation.find((n) => n !== except && this.available(n));
  }
}
