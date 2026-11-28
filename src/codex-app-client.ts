/**
 * A short-lived `codex app-server` for one job.
 *
 * `codex exec` has no RPC surface: what only the app-server can do — read the
 * account's rate limits, list skills or MCP servers, compact, review, sample or
 * revert a thread — runs through one of these. It is spawned, initialized,
 * asked, and killed. A thread `codex exec` holds is loaded with `thread/resume`
 * first; `codex exec resume` picks the thread up afterwards from the same rollout.
 *
 * It answers every request the server makes (approvals, user input) with an
 * error at once, as the codex-app session does: nothing here can answer one,
 * and an unanswered request leaves its turn waiting.
 */

import { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import * as readline from 'node:readline';

import { killEngineTree, signalEngineGroup, spawnEngine, STOPPED_ENGINE_GRACE_MS } from './engine-spawn.js';
import { sanitizeSecrets } from './sanitize.js';

/**
 * What the command and quota helpers need of a connection: one request at a
 * time, answered or failed, within `timeoutMs` when given (else the
 * connection's own default).
 */
export interface CodexRpc {
  request(method: string, params: unknown, timeoutMs?: number): Promise<unknown>;
}

/**
 * The `initialize` params. `experimentalApi` opens plan mode, `thread/sample`,
 * `thread/settings/update`, `thread/memoryMode/set` and the background-terminal
 * RPCs; without it each refuses with "requires experimentalApi capability"
 * (measured on 0.172.0).
 */
export function codexInitializeParams(): Record<string, unknown> {
  return {
    clientInfo: { name: 'claw-orchestrator', title: null, version: '3.0.0' },
    capabilities: { experimentalApi: true },
  };
}

export interface CodexAppClientOptions {
  /** The codex binary; `CODEX_BIN`, else `codex`. */
  bin?: string;
  cwd?: string;
  launcher?: readonly string[];
  /** Extra `codex app-server` arguments: `-c key=value`, `--enable`/`--disable` feature switches. */
  args?: string[];
  /** How long `initialize` may take. */
  startTimeoutMs?: number;
}

interface Pending {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  method: string;
  timer?: ReturnType<typeof setTimeout>;
}

/** Default time one request may take. */
const REQUEST_TIMEOUT_MS = 60_000;

export class CodexAppClient extends EventEmitter implements CodexRpc {
  private proc: ChildProcess;
  private rl: readline.Interface;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private closed = false;
  private stderrTail = '';

  private constructor(proc: ChildProcess) {
    super();
    this.proc = proc;
    this.rl = readline.createInterface({ input: proc.stdout!, crlfDelay: Infinity });
    this.rl.on('line', (line) => this.handleLine(line));
    this.rl.on('error', () => {});
    proc.stderr?.on('data', (data: Buffer) => {
      this.stderrTail = (this.stderrTail + sanitizeSecrets(data.toString())).slice(-2000);
    });
    proc.stdin?.on('error', () => {});
    const end = (reason: string): void => {
      if (this.closed) return;
      this.closed = true;
      for (const p of this.pending.values()) {
        if (p.timer) clearTimeout(p.timer);
        const tail = this.stderrTail.trim();
        p.reject(
          new Error(`codex app-server ${reason} before answering ${p.method}${tail ? `: ${tail.slice(-500)}` : ''}`),
        );
      }
      this.pending.clear();
      this.emit('close');
    };
    proc.on('exit', (code) => end(`exited (code=${code})`));
    proc.on('error', (err) => end(`failed (${err.message})`));
  }

  /** Spawn `codex app-server --listen stdio://` and initialize it. */
  static async open(opts: CodexAppClientOptions = {}): Promise<CodexAppClient> {
    const bin = opts.bin || process.env.CODEX_BIN || 'codex';
    const proc = spawnEngine(bin, ['app-server', '--listen', 'stdio://', ...(opts.args ?? [])], {
      launcher: opts.launcher,
      cwd: opts.cwd,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const client = new CodexAppClient(proc);
    try {
      await client.request('initialize', codexInitializeParams(), opts.startTimeoutMs ?? 30_000);
    } catch (err) {
      client.close();
      throw err;
    }
    return client;
  }

  /** Send one request and resolve with its result; a JSON-RPC error, an exit or the timeout rejects. */
  request(method: string, params: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<unknown> {
    if (this.closed || !this.proc.stdin?.writable) {
      return Promise.reject(new Error(`codex app-server is not running (${method})`));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const entry: Pending = { resolve, reject, method };
      if (timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`codex app-server did not answer ${method} within ${timeoutMs} ms`));
        }, timeoutMs);
        entry.timer.unref?.();
      }
      this.pending.set(id, entry);
      this.proc.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n', (err) => {
        if (err) {
          if (entry.timer) clearTimeout(entry.timer);
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  /**
   * Resolve with the params of the first notification `match` accepts. Register
   * it before sending the request that leads to the notification.
   */
  waitFor(match: (method: string, params: unknown) => boolean, timeoutMs: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const onNote = (method: string, params: unknown) => {
        if (!match(method, params)) return;
        cleanup();
        resolve(params);
      };
      const onClose = () => {
        cleanup();
        reject(new Error('codex app-server exited before the turn ended'));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`codex app-server: no answer within ${timeoutMs} ms`));
      }, timeoutMs);
      timer.unref?.();
      const cleanup = () => {
        clearTimeout(timer);
        this.off('notification', onNote);
        this.off('close', onClose);
      };
      this.on('notification', onNote);
      this.on('close', onClose);
    });
  }

  /** Kill the server and what it started; SIGKILL for a group that ignored the SIGTERM. */
  close(): void {
    this.rl.close();
    if (this.closed && this.proc.exitCode !== null) return;
    const proc = this.proc;
    killEngineTree(proc);
    const escalate = setTimeout(() => {
      try {
        signalEngineGroup(proc, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }, STOPPED_ENGINE_GRACE_MS);
    escalate.unref?.();
    proc.once('exit', () => clearTimeout(escalate));
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: {
      id?: number | string | null;
      method?: string;
      params?: unknown;
      result?: unknown;
      error?: { message?: string };
    };
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (typeof msg.id === 'number' && msg.method === undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (p.timer) clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(`${p.method} failed: ${msg.error.message ?? 'unknown error'}`));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method && msg.id !== undefined && msg.id !== null) {
      if (this.proc.stdin?.writable) {
        this.proc.stdin.write(
          JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            error: { code: -32601, message: `${msg.method} is not supported by this client` },
          }) + '\n',
        );
      }
      return;
    }
    if (msg.method) this.emit('notification', msg.method, msg.params);
  }
}

/**
 * Run `fn` against a short-lived app-server, and close it whatever happens.
 */
export async function withCodexAppClient<T>(
  opts: CodexAppClientOptions,
  fn: (client: CodexAppClient) => Promise<T>,
): Promise<T> {
  const client = await CodexAppClient.open(opts);
  try {
    return await fn(client);
  } finally {
    client.close();
  }
}
