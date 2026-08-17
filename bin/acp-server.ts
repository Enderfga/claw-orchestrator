#!/usr/bin/env node
/**
 * claw-orchestrator ACP server
 *
 * Exposes the orchestrator as an Agent Client Protocol *agent* over JSON-RPC
 * stdio. Any ACP client can drive it: Zed, JetBrains, Neovim, Emacs, the VS Code
 * ACP extension, or `dsh` via `@deepseek-ai/dsh-subagent-acp`, whose provider
 * spawns an arbitrary command as a subagent.
 *
 * Stdout is reserved for the protocol — every log line goes to stderr. That is
 * not a style preference: a single stray `console.log` corrupts the frame stream
 * and the client fails in a way that looks like a protocol bug. Two things are
 * needed for it, and only doing one of them is the trap:
 *   1. suppress the plugin's HTTP control plane, whose `start()` prints; and
 *   2. hand SessionManager an explicit stderr logger, because its default is
 *      `createConsoleLogger`, whose `info`/`debug` write to stdout.
 *
 * Environment variables read at startup:
 *   CLAWO_ACP_MODEL      default model for a new session (default: claude-sonnet-4-6)
 *   CLAWO_ACP_PERMISSION default permission mode: plan | acceptEdits | bypassPermissions
 *                        (default: acceptEdits)
 *   OPENCLAW_LOG_LEVEL   as elsewhere; 'warn' keeps the stderr channel quiet
 */
import { Readable, Writable } from 'node:stream';

import * as acp from '@agentclientprotocol/sdk';

import type { PermissionMode } from '../src/types.js';

// Suppress the embedded HTTP server before anything can construct it — it is
// dead weight here and its start() writes to stdout.
process.env.CLAWO_NO_EMBEDDED_SERVER ??= '1';

const { SessionManager } = await import('../src/session-manager.js');
const { createAcpAgent } = await import('../src/acp-server.js');

/** Only the three modes the ACP config selector offers are accepted from the env. */
const PERMISSION_MODES = new Set<PermissionMode>(['plan', 'acceptEdits', 'bypassPermissions']);
function envPermissionMode(): PermissionMode | undefined {
  const raw = (process.env.CLAWO_ACP_PERMISSION || '').trim() as PermissionMode;
  if (!raw) return undefined;
  if (!PERMISSION_MODES.has(raw)) {
    console.error(`[clawo-acp] ignoring CLAWO_ACP_PERMISSION='${raw}' — expected one of ${[...PERMISSION_MODES]}`);
    return undefined;
  }
  return raw;
}

/** Every level to stderr. See the header: stdout belongs to the protocol. */
const log = {
  debug: (msg: string, ...args: unknown[]) => console.error('[clawo-acp]', msg, ...args),
  info: (msg: string, ...args: unknown[]) => console.error('[clawo-acp]', msg, ...args),
  warn: (msg: string, ...args: unknown[]) => console.error('[clawo-acp]', msg, ...args),
  error: (msg: string, ...args: unknown[]) => console.error('[clawo-acp]', msg, ...args),
};

const manager = new SessionManager(
  {
    maxConcurrentSessions: parseInt(process.env.OPENCLAW_SERVE_MAX_SESSIONS || '', 10) || 32,
    sessionTtlMinutes: parseInt(process.env.OPENCLAW_SERVE_TTL_MINUTES || '', 10) || 60,
  },
  log,
);

const agent = createAcpAgent(manager, {
  defaultModel: process.env.CLAWO_ACP_MODEL || undefined,
  defaultPermissionMode: envPermissionMode(),
  logger: log,
});

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await manager.shutdown();
  } finally {
    process.exit(0);
  }
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

const connection = agent.connect(
  acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>),
);

// Exit when the client goes away. A parent that disposes us — `dsh`'s ACP
// subagent provider is one — closes stdin first and allows a grace period for
// cooperative quiescence before escalating to SIGTERM/SIGKILL. Without this the
// process lingers until it is killed, leaking engine subprocesses each run.
connection.closed.then(
  () => void shutdown(),
  (err: unknown) => {
    log.error(`connection closed with error: ${String(err)}`);
    void shutdown();
  },
);

log.info('acp server ready — stdio');
