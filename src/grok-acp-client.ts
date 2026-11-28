/**
 * One-off calls to grok's ACP agent (`grok agent stdio`) with no session open.
 *
 * Some of what Grok Build knows is only reachable over ACP: its command list
 * with descriptions and argument hints (`_x.ai/commands/list`) and the
 * account's plan (`_x.ai/billing`). Both answer after `initialize` alone, with
 * no `session/new`, so the call creates no grok session, runs no hooks and
 * makes no model call (1.0.92: the session store held the same 81 sessions
 * before and after). Extension methods take a leading underscore; `x.ai/…`
 * without it is "Method not found".
 *
 * The process is started for the one call and killed when it answers.
 */

import { killEngineTree, spawnEngine } from './engine-spawn.js';

/** How long one call may take, `initialize` included. */
export const GROK_ACP_CALL_TIMEOUT_MS = 20_000;

export interface GrokAcpCallOptions {
  /** The grok binary; `GROK_BIN` or `grok` by default. */
  bin?: string;
  /** The folder the agent starts in: it decides which project commands it lists. */
  cwd?: string;
  /** The argv prefix the session runs grok under (`SessionConfig.launcher`). */
  launcher?: readonly string[];
  timeoutMs?: number;
}

interface RpcReply {
  id?: number;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

/** Call `method` on a fresh `grok agent stdio` after `initialize`, and return its result. */
export function grokAcpCall(
  method: string,
  params: Record<string, unknown> = {},
  opts: GrokAcpCallOptions = {},
): Promise<unknown> {
  const bin = opts.bin || process.env.GROK_BIN || 'grok';
  const timeoutMs = opts.timeoutMs ?? GROK_ACP_CALL_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    let settled = false;
    let pending = '';
    let stderr = '';
    const proc = spawnEngine(bin, ['agent', 'stdio'], {
      launcher: opts.launcher,
      cwd: opts.cwd,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const finish = (err: Error | null, value?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killEngineTree(proc);
      if (err) reject(err);
      else resolve(value);
    };
    const timer = setTimeout(
      () => finish(new Error(`grok agent did not answer ${method} within ${timeoutMs} ms`)),
      timeoutMs,
    );
    const write = (id: number, m: string, p: Record<string, unknown>): void => {
      proc.stdin?.write(JSON.stringify({ jsonrpc: '2.0', id, method: m, params: p }) + '\n');
    };
    const onReply = (reply: RpcReply): void => {
      if (reply.error) {
        const data = typeof reply.error.data === 'string' ? `: ${reply.error.data}` : '';
        const what = reply.id === 1 ? 'initialize' : method;
        finish(new Error(`grok agent refused ${what}: ${reply.error.message ?? 'error'}${data}`));
        return;
      }
      if (reply.id === 1) write(2, method, params);
      else if (reply.id === 2) finish(null, reply.result);
    };
    proc.stdin?.on('error', () => {});
    proc.stdout?.on('data', (chunk: Buffer) => {
      pending += chunk.toString('utf8');
      let nl: number;
      while ((nl = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, nl).trim();
        pending = pending.slice(nl + 1);
        if (!line.startsWith('{')) continue;
        let msg: RpcReply & { method?: string };
        try {
          msg = JSON.parse(line) as RpcReply & { method?: string };
        } catch {
          continue;
        }
        // Notifications (`_x.ai/mcp/servers_updated`, …) carry no id.
        if (msg.method === undefined && typeof msg.id === 'number') onReply(msg);
      }
    });
    proc.stderr?.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-2000);
    });
    proc.on('error', (err) => finish(err));
    proc.on('close', (code) =>
      finish(
        new Error(
          `grok agent exited (code ${code}) before answering ${method}${stderr.trim() ? `: ${stderr.trim().split('\n')[0]}` : ''}`,
        ),
      ),
    );
    write(1, 'initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: 'claw-orchestrator', version: '1' },
    });
  });
}
