/**
 * A private OpenCode 2 server held by one session, and the calls clawo makes to it.
 *
 * `opencode run --standalone` starts a private server for every turn (`opencode
 * serve --stdio --port 0`, about 0.5 GB resident on 2.4.2) and stops it with the
 * turn. A session that holds that same server runs its turns as `run --server
 * <url>` clients of it, and reaches what `run` has no flag for through the
 * server's HTTP API: text steered into the turn in flight, an interrupt the
 * server's own execution honours, engine commands, compaction, side questions,
 * reverts, shell commands, skills and the native `/goal`.
 *
 * The server listens on 127.0.0.1 behind a random password (`OPENCODE_PASSWORD`,
 * HTTP basic auth as user `opencode`), runs in the session's directory with the
 * session's environment (the read-only agent's `OPENCODE_CONFIG_CONTENT`
 * included), and prints `{"url": …}` as its first stdout line. Ending its stdin
 * stops it.
 */

import { randomBytes } from 'node:crypto';
import * as readline from 'node:readline';
import type { ChildProcess } from 'node:child_process';

import { killEngineTree, spawnEngine } from './engine-spawn.js';
import { sanitizeSecrets } from './sanitize.js';

/** The commands OpenCode 2.4.2 ships; every other one `GET /api/command` lists is the user's or a project's. */
export const OPENCODE_BUILTIN_COMMANDS: ReadonlySet<string> = new Set(['init', 'review', 'goal', 'automation']);

/** What `run` tells an agent whose question form it cancels (OpenCode 2.4.2's own wording). */
export const NO_QUESTIONS_MESSAGE =
  'This non-interactive run cannot ask the user questions, so the question was cancelled. ' +
  'Continue without an answer; make reasonable assumptions and state them.';

const START_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 60_000;

/** A non-2xx answer from the server: `tag` is OpenCode's error class (`CommandNotFoundError`, …). */
export class OpencodeApiError extends Error {
  override name = 'OpencodeApiError';
  constructor(
    readonly status: number,
    readonly tag: string | undefined,
    message: string,
  ) {
    super(message);
  }
}

export interface OpencodeServerOptions {
  bin: string;
  cwd: string;
  /** The server's environment: the session's, with its read-only agent configuration when it has one. */
  env: NodeJS.ProcessEnv;
  launcher?: readonly string[];
  log?: (message: string) => void;
}

/** One server process; `start` once, then `call` until `stop`. */
export class OpencodeServer {
  readonly password = randomBytes(24).toString('base64url');
  private _url?: string;
  private _proc: ChildProcess | null = null;
  private _exited = false;
  private _starting?: Promise<string>;

  constructor(private readonly opts: OpencodeServerOptions) {}

  get url(): string | undefined {
    return this._url;
  }

  /** Started, and its process has not exited. */
  get alive(): boolean {
    return !!this._url && !this._exited;
  }

  get pid(): number | undefined {
    return this._proc?.pid ?? undefined;
  }

  /** The environment a `run --server` client of this server needs. */
  clientEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    return { ...base, OPENCODE_PASSWORD: this.password };
  }

  start(): Promise<string> {
    this._starting ??= this._start();
    return this._starting;
  }

  private _start(): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const proc = spawnEngine(this.opts.bin, ['serve', '--stdio', '--port', '0'], {
        launcher: this.opts.launcher,
        cwd: this.opts.cwd,
        env: { ...this.opts.env, OPENCODE_PASSWORD: this.password, PWD: this.opts.cwd },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this._proc = proc;
      let settled = false;
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // A server that never said where it listens is of no use: end it now, not after a grace.
        this._proc = null;
        this._exited = true;
        killEngineTree(proc);
        reject(err);
      };
      const timer = setTimeout(
        () => fail(new Error(`opencode serve printed no URL within ${START_TIMEOUT_MS / 1000}s`)),
        START_TIMEOUT_MS,
      );
      timer.unref?.();
      proc.stdin?.on('error', () => {});
      let stderr = '';
      proc.stderr?.on('data', (d: Buffer) => {
        const text = sanitizeSecrets(d.toString());
        if (stderr.length < 4_000) stderr += text;
        this.opts.log?.(`[opencode-server] ${text.trimEnd()}`);
      });
      const rl = readline.createInterface({ input: proc.stdout!, crlfDelay: Infinity });
      rl.once('line', (line: string) => {
        let url: unknown;
        try {
          url = (JSON.parse(line) as { url?: unknown }).url;
        } catch {
          // handled below
        }
        if (typeof url !== 'string' || !/^https?:\/\//.test(url)) {
          fail(new Error(`opencode serve did not print its URL: ${sanitizeSecrets(line).slice(0, 200)}`));
          return;
        }
        settled = true;
        clearTimeout(timer);
        this._url = url.replace(/\/+$/, '');
        // Once it listens, the server alone keeps no process alive: one that exits closes its stdin,
        // which ends the server. A call or a `run` client in flight keeps the process up meanwhile.
        proc.unref?.();
        for (const stream of [proc.stdin, proc.stdout, proc.stderr])
          (stream as { unref?: () => void } | null)?.unref?.();
        resolve(this._url);
      });
      proc.on('error', (err) => fail(err));
      proc.on('close', (code) => {
        this._exited = true;
        rl.close();
        fail(new Error(`opencode serve exited (${code})${stderr ? `: ${stderr.trim().slice(0, 300)}` : ''}`));
      });
    });
  }

  /** End the server and what it started (its PTY daemon among them). Idempotent. */
  stop(): void {
    const proc = this._proc;
    this._proc = null;
    this._exited = true;
    if (!proc) return;
    try {
      proc.stdin?.end();
    } catch {
      // Already closed.
    }
    // Stdin closing ends it within milliseconds; the group kill covers one that hangs.
    const kill = setTimeout(() => killEngineTree(proc), 1_500);
    kill.unref?.();
    proc.once('close', () => clearTimeout(kill));
  }

  /**
   * One API call in the session's location. Resolves with the parsed body (undefined for 204);
   * a non-2xx answer throws `OpencodeApiError`.
   */
  async call<T = unknown>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown,
    opts: { timeoutMs?: number; query?: Record<string, string> } = {},
  ): Promise<T> {
    if (!this.alive) throw new Error('the OpenCode server is not running');
    const query = new URLSearchParams({ 'location[directory]': this.opts.cwd, ...opts.query });
    const res = await fetch(`${this._url}${path}?${query.toString()}`, {
      method,
      headers: {
        authorization: `Basic ${Buffer.from(`opencode:${this.password}`).toString('base64')}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeoutMs ?? REQUEST_TIMEOUT_MS),
    });
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = text;
    }
    if (!res.ok) {
      const err = (parsed ?? {}) as { _tag?: unknown; message?: unknown };
      const tag = typeof err._tag === 'string' ? err._tag : undefined;
      const message = typeof err.message === 'string' ? err.message : text.slice(0, 300) || res.statusText;
      throw new OpencodeApiError(res.status, tag, sanitizeSecrets(`${method} ${path}: ${res.status} ${message}`));
    }
    return parsed as T;
  }
}

// ─── Messages ────────────────────────────────────────────────────────────────

export interface OpencodeTokens {
  input?: number;
  output?: number;
  reasoning?: number;
  cache?: { read?: number; write?: number };
}

/** A message of `GET /api/session/<id>/message`, as far as clawo reads it. */
export interface OpencodeMessage {
  id: string;
  type: string;
  time?: { created?: number; completed?: number };
  text?: string;
  agent?: string;
  content?: Array<{ type: string; text?: string; name?: string; state?: { status?: string } }>;
  finish?: string;
  tokens?: OpencodeTokens;
  cost?: number;
  error?: { type?: string; message?: string };
  /** idle */
  outcome?: 'succeeded' | 'failed' | 'interrupted';
  /** compaction, shell */
  status?: string;
  reason?: string;
  summary?: string;
  /** shell */
  command?: string;
  exit?: number | string;
  output?: { output?: string; truncated?: boolean };
}

/** An assistant message still being written has no completion time and no finish. */
export function messageComplete(m: OpencodeMessage): boolean {
  if (m.type === 'assistant') return !!m.time?.completed || !!m.finish || !!m.error;
  if (m.type === 'compaction') return m.status !== 'running';
  if (m.type === 'shell') return m.status !== 'running';
  return true;
}

/** The text an assistant message wrote, its parts joined. */
export function assistantText(m: OpencodeMessage): string {
  return (m.content ?? [])
    .filter((c) => c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text as string)
    .join('');
}

/**
 * The newest messages of a session, oldest first, after the message `afterId`
 * (exclusive; all of them when it is undefined). Pages back from the newest.
 */
export async function messagesAfter(
  server: OpencodeServer,
  sessionId: string,
  afterId: string | undefined,
  pageSize = 100,
): Promise<OpencodeMessage[]> {
  const found: OpencodeMessage[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 200; page++) {
    const res = await server.call<{ data?: OpencodeMessage[]; cursor?: { next?: string; previous?: string } }>(
      'GET',
      `/api/session/${sessionId}/message`,
      undefined,
      { query: cursor ? { limit: String(pageSize), cursor } : { limit: String(pageSize), order: 'desc' } },
    );
    const data = res?.data ?? [];
    for (const m of data) {
      if (afterId && m.id === afterId) return found.reverse();
      found.push(m);
    }
    cursor = res?.cursor?.next;
    if (!cursor || data.length === 0) break;
  }
  return found.reverse();
}

/** The id of the newest message of a session, or undefined for an empty one. */
export async function newestMessageId(server: OpencodeServer, sessionId: string): Promise<string | undefined> {
  const res = await server.call<{ data?: OpencodeMessage[] }>('GET', `/api/session/${sessionId}/message`, undefined, {
    query: { limit: '1', order: 'desc' },
  });
  return res?.data?.[0]?.id;
}

/** What a stretch of server-side work did, read from the messages it wrote. */
export interface WorkFold {
  /** The assistant messages' text, in order, as `run` joins a turn's text. */
  text: string;
  toolCalls: number;
  toolErrors: number;
  /** The idle message's outcome; undefined when the work wrote none. */
  outcome?: 'succeeded' | 'failed' | 'interrupted';
  /** Why it failed: the idle message's error, else the last assistant error. */
  error?: string;
}

export function foldMessages(messages: OpencodeMessage[]): WorkFold {
  const fold: WorkFold = { text: '', toolCalls: 0, toolErrors: 0 };
  let lastError: string | undefined;
  for (const m of messages) {
    if (m.type === 'assistant') {
      const text = assistantText(m);
      // Each message is a step of its own; `run` joins the parts of one turn with nothing between.
      if (text) fold.text += fold.text && !/\s$/.test(fold.text) ? `\n\n${text}` : text;
      for (const c of m.content ?? []) {
        if (c.type !== 'tool') continue;
        fold.toolCalls++;
        if (c.state?.status === 'error') fold.toolErrors++;
      }
      if (m.error?.message) lastError = m.error.message;
    } else if (m.type === 'idle') {
      fold.outcome = m.outcome;
      if (m.error?.message) lastError = m.error.message;
    } else if (m.type === 'compaction' && m.status === 'failed' && m.error?.message) {
      lastError = m.error.message;
    }
  }
  if (fold.outcome && fold.outcome !== 'succeeded' && lastError) fold.error = sanitizeSecrets(lastError);
  return fold;
}

/** The prompt an assistant message was given: its uncached input plus the cache it read and wrote. */
export function promptTokens(t: OpencodeTokens | undefined): number {
  if (!t) return 0;
  return (t.input || 0) + (t.cache?.read || 0) + (t.cache?.write || 0);
}

// ─── Following server-side work ─────────────────────────────────────────────

export interface FollowOptions {
  timeoutMs: number;
  /** Answer a permission request `once` (the session runs with `--auto`); otherwise it is rejected, as `run` does. */
  allowPermissions: boolean;
  pollMs?: number;
  /** Each new message, once, when it is complete. */
  onMessage?: (m: OpencodeMessage) => void;
  log?: (message: string) => void;
  /** Ends the follow early (the session stopped); the work is interrupted. */
  cancelled?: () => boolean;
  /**
   * Work that writes no message and leaves the session idle this long did not
   * run (a command that only changed state): the follow ends with no messages.
   */
  settleMs?: number;
}

export interface FollowResult {
  /** Every message the work wrote, oldest first. */
  messages: OpencodeMessage[];
  /** The work went idle (an idle message was written, an interrupt's included). */
  idle: boolean;
  /** It outlived `timeoutMs` and was interrupted. */
  timedOut: boolean;
}

/**
 * Start work on the server (`start`: a command, a compaction, a shell command)
 * and follow it until the session goes idle, the way `run` follows a turn:
 * permission requests are rejected (or answered `once` under `--auto`), and
 * question forms are cancelled, since nobody is there to answer them. Pending
 * requests are read server-wide, so a subagent's are answered too: the server
 * is this session's own.
 */
export async function followSessionWork(
  server: OpencodeServer,
  sessionId: string,
  start: () => Promise<void>,
  opts: FollowOptions,
): Promise<FollowResult> {
  const pollMs = opts.pollMs ?? 500;
  const baseline = await newestMessageId(server, sessionId);
  await start();
  const delivered = new Set<string>();
  const answered = new Set<string>();
  const startedAt = Date.now();
  const deadline = startedAt + opts.timeoutMs;
  const settleMs = opts.settleMs ?? 2_000;
  let interruptedAt: number | undefined;
  let timedOut = false;
  let messages: OpencodeMessage[] = [];
  const deliver = (all: boolean) => {
    for (const m of messages) {
      if (delivered.has(m.id) || (!all && !messageComplete(m))) continue;
      delivered.add(m.id);
      try {
        opts.onMessage?.(m);
      } catch {
        // A listener's error is not the work's.
      }
    }
  };
  for (;;) {
    await new Promise((r) => setTimeout(r, pollMs));
    await answerPendingAsks(server, opts, answered).catch((err: Error) =>
      opts.log?.(`[opencode] could not answer a pending request: ${err.message}`),
    );
    messages = await messagesAfter(server, sessionId, baseline);
    const newest = messages.at(-1);
    if (newest?.type === 'idle') {
      deliver(true);
      return { messages, idle: true, timedOut };
    }
    if (messages.length === 0 && Date.now() - startedAt >= settleMs && !(await sessionRunning(server, sessionId))) {
      return { messages, idle: true, timedOut: false };
    }
    deliver(false);
    const cancelled = opts.cancelled?.() ?? false;
    if ((cancelled || Date.now() >= deadline) && interruptedAt === undefined) {
      interruptedAt = Date.now();
      timedOut = !cancelled;
      await server.call('POST', `/api/session/${sessionId}/interrupt`).catch(() => undefined);
    }
    // An interrupt is answered with an idle message at once; one that does not come is given up on.
    if (interruptedAt !== undefined && Date.now() - interruptedAt > 5_000) {
      deliver(true);
      return { messages, idle: false, timedOut };
    }
  }
}

/** The server is running the session now (`GET /api/session/active`). */
export async function sessionRunning(server: OpencodeServer, sessionId: string): Promise<boolean> {
  const r = await server.call<{ data?: Record<string, unknown> }>('GET', '/api/session/active');
  return !!r?.data && Object.prototype.hasOwnProperty.call(r.data, sessionId);
}

async function answerPendingAsks(server: OpencodeServer, opts: FollowOptions, answered: Set<string>): Promise<void> {
  const [perms, forms] = await Promise.all([
    server.call<{ data?: Array<{ id: string; sessionID: string; action?: string }> }>('GET', '/api/permission/request'),
    server.call<{ data?: Array<{ id: string; sessionID: string; title?: string }> }>('GET', '/api/form'),
  ]);
  for (const p of perms?.data ?? []) {
    if (answered.has(p.id)) continue;
    answered.add(p.id);
    const decision = opts.allowPermissions ? 'once' : 'reject';
    opts.log?.(`[opencode] permission '${p.action ?? '?'}' answered ${decision}: nobody can be asked headless`);
    await server.call('POST', `/api/session/${p.sessionID}/permission/${p.id}/reply`, { decision });
  }
  for (const f of forms?.data ?? []) {
    if (answered.has(f.id)) continue;
    answered.add(f.id);
    opts.log?.(`[opencode] question form '${f.title ?? f.id}' cancelled: nobody can answer it headless`);
    await server.call('DELETE', `/api/session/${f.sessionID}/form/${f.id}`, undefined, {
      query: { message: NO_QUESTIONS_MESSAGE },
    });
  }
}
