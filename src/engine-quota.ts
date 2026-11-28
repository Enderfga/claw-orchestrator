/**
 * Engine quota readers — how much of an engine account's usage is left.
 *
 * One reader per engine, registered by the engine's own module with
 * `registerQuotaReader`. A reader that needs no session (agy `/usage`, `grok
 * usage`, codex `account/rateLimits/read` through a short-lived app-server)
 * ignores `session`; one that reads a live session's last report (Claude's
 * `rate_limit_event`) is given the session when there is one.
 *
 * The registry lives in a function's own property, not a module-level `const`:
 * an engine module imported below registers while this module is still being
 * evaluated (the import is circular), and only a function declaration is ready
 * that early.
 */

// ─── Readers ────────────────────────────────────────────────────────────────
// Each engine's reader module, imported for the registration it makes. A module
// that registers here imports `registerQuotaReader` from this file.
import './agy-quota.js';
import './codex-quota.js';

import type { EngineQuota, EngineType, ISession } from './types.js';

export interface QuotaReadOptions {
  /** A live session on the engine, when there is one; a reader that needs none ignores it. */
  session?: ISession;
  /** The directory a reader that runs the engine's CLI runs it in. */
  cwd?: string;
}

/** Read an engine's quota; undefined when there is nothing to read now (no live session, no login). */
export type QuotaReader = (opts: QuotaReadOptions) => Promise<EngineQuota | undefined>;

/** How long one reader may take before its reading is given up. */
export const QUOTA_READ_TIMEOUT_MS = 30_000;

function registry(): Map<EngineType, QuotaReader> {
  const self = registry as typeof registry & { readers?: Map<EngineType, QuotaReader> };
  return (self.readers ??= new Map());
}

/** Register `engine`'s quota reader, replacing any earlier one. */
export function registerQuotaReader(engine: EngineType, reader: QuotaReader): void {
  registry().set(engine, reader);
}

/** Remove `engine`'s reader (tests). */
export function unregisterQuotaReader(engine: EngineType): void {
  registry().delete(engine);
}

/** The engines that have a reader, in registration order. */
export function quotaEngines(): EngineType[] {
  return [...registry().keys()];
}

/**
 * Read `engine`'s quota. Throws when the engine has no reader, or the reader
 * fails or takes longer than `timeoutMs`; undefined when it had nothing to read.
 */
export async function readEngineQuota(
  engine: EngineType,
  opts: QuotaReadOptions & { timeoutMs?: number } = {},
): Promise<EngineQuota | undefined> {
  const reader = registry().get(engine);
  if (!reader) throw new Error(`quota is not supported on ${engine}: it has no quota reader`);
  const { timeoutMs = QUOTA_READ_TIMEOUT_MS, ...readOpts } = opts;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`reading the ${engine} quota took longer than ${timeoutMs} ms`)),
      timeoutMs,
    );
    timer.unref?.();
  });
  try {
    return await Promise.race([reader(readOpts), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
