/**
 * Cursor's commands and skills, and its account's plan.
 *
 * Print mode expands a `/name args` message into the command or skill it names
 * (`.cursor/commands`, Cursor's built-in skills, project and user skills), so a
 * command runs as an ordinary turn. The list of what a directory can run is not
 * printed anywhere in print mode; Cursor's ACP server sends it, structured, right
 * after `session/new` (`available_commands_update`). `listCursorCommands` asks a
 * short-lived `cursor-agent acp` for it and ends the process: no prompt, no turn.
 * The ACP session it opens is kept out of the user's `acp-sessions` (see
 * `CursorConfigMirror`).
 *
 * Usage windows are not readable headless (`/usage` is a TUI screen); the quota
 * reader reports the subscription tier `cursor-agent about` prints.
 */

import * as os from 'node:os';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { randomUUID } from 'node:crypto';

import { CursorConfigMirror, withCursorConfigMirror } from './cursor-config-dir.js';
import { execEngine, killEngineTree, spawnEngine } from './engine-spawn.js';
import { registerQuotaReader } from './engine-quota.js';
import type { EngineCommand } from './types.js';

/** Commands Cursor lists that act on its TUI (the clipboard), not on the conversation. */
const TUI_COMMANDS: ReadonlySet<string> = new Set(['copy-request-id']);

/** Read one `availableCommands` entry: Cursor puts where it comes from at the end of the description. */
export function cursorCommandOf(entry: { name?: unknown; description?: unknown }): EngineCommand | undefined {
  if (typeof entry.name !== 'string' || !entry.name.trim()) return undefined;
  const name = entry.name.trim().replace(/^\//, '');
  const raw = typeof entry.description === 'string' ? entry.description.trim() : '';
  const tag = /\s*\(([^()]+)\)$/.exec(raw);
  const origin = tag?.[1].toLowerCase() ?? '';
  const description = tag ? raw.slice(0, tag.index).trim() : raw;
  const source: EngineCommand['source'] = /^builtin/.test(origin)
    ? 'builtin'
    : /\bskill$/.test(origin)
      ? 'skill'
      : /^plugin/.test(origin)
        ? 'plugin'
        : origin
          ? 'custom'
          : 'builtin';
  return {
    name,
    ...(description ? { description } : {}),
    source,
    startsTurn: true,
    ...(TUI_COMMANDS.has(name) ? { needsHuman: true } : {}),
  };
}

/**
 * The commands and skills Cursor offers in `cwd`, from a short-lived ACP server.
 * Rejects when the server does not answer within `timeoutMs`.
 */
export async function listCursorCommands(
  bin: string,
  cwd: string,
  opts: { timeoutMs?: number; launcher?: readonly string[] } = {},
): Promise<EngineCommand[]> {
  const mirror = new CursorConfigMirror(path.join(os.tmpdir(), `claw-cursor-cmds-${randomUUID()}`), {
    isolate: ['acp-sessions'],
  });
  const configDir = mirror.prepare();
  const proc = spawnEngine(bin, ['acp'], {
    launcher: opts.launcher,
    cwd,
    env: { ...process.env, ...(configDir ? { CURSOR_CONFIG_DIR: configDir } : {}) },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const send = (msg: Record<string, unknown>) => proc.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
  try {
    return await new Promise<EngineCommand[]>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Cursor did not list its commands in time')),
        opts.timeoutMs ?? 20_000,
      );
      timer.unref?.();
      const done = (err: Error | undefined, list?: EngineCommand[]) => {
        clearTimeout(timer);
        if (err) reject(err);
        else resolve(list ?? []);
      };
      proc.on('error', (err) => done(err));
      proc.on('close', (code) => done(new Error(`cursor-agent acp exited with code ${code} before listing commands`)));
      const rl = readline.createInterface({ input: proc.stdout!, crlfDelay: Infinity });
      rl.on('line', (line) => {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(line) as Record<string, unknown>;
        } catch {
          return;
        }
        const error = msg.error as { message?: string } | undefined;
        if (error && (msg.id === 1 || msg.id === 2)) return done(new Error(error.message || 'ACP request failed'));
        if (msg.id === 1) send({ id: 2, method: 'session/new', params: { cwd, mcpServers: [] } });
        const update = (msg.params as { update?: Record<string, unknown> } | undefined)?.update;
        if (msg.method === 'session/update' && update?.sessionUpdate === 'available_commands_update') {
          const entries = Array.isArray(update.availableCommands) ? update.availableCommands : [];
          const list = entries.flatMap((e) => {
            const c = cursorCommandOf(e as Record<string, unknown>);
            return c ? [c] : [];
          });
          done(undefined, list);
        }
      });
      send({
        id: 1,
        method: 'initialize',
        params: { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } },
      });
    });
  } finally {
    proc.stdin?.end();
    killEngineTree(proc);
    // The directory goes once the server has exited, so nothing it still writes lands in the user's.
    if (proc.exitCode != null || proc.signalCode != null) mirror.remove();
    else proc.once('close', () => mirror.remove());
  }
}

/** The subscription tier `cursor-agent about --format json` reports. */
export async function readCursorPlan(bin: string): Promise<string | undefined> {
  const { stdout } = await withCursorConfigMirror((env) =>
    execEngine(bin, ['about', '--format', 'json'], { timeout: 20_000, env }),
  );
  const about = JSON.parse(stdout) as { subscriptionTier?: unknown };
  return typeof about.subscriptionTier === 'string' && about.subscriptionTier ? about.subscriptionTier : undefined;
}

registerQuotaReader('cursor', async () => {
  const plan = await readCursorPlan(process.env.CURSOR_BIN || 'cursor-agent');
  if (!plan) return undefined;
  return {
    engine: 'cursor',
    plan,
    windows: [],
    source: 'cursor-agent about (usage windows are shown only in the TUI)',
    readAt: new Date().toISOString(),
  };
});
