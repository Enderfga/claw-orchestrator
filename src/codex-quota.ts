/**
 * The Codex account's rate limits (`account/rateLimits/read`), for both Codex
 * engines: one ChatGPT account backs `codex` and `codex-app` alike.
 *
 * A live `codex-app` session is asked on its own app-server; otherwise a
 * short-lived one is started for the read. The read is free: no turn, no tokens.
 */

import { tmpdir } from 'node:os';

import type { EngineQuota, EngineType, ISession } from './types.js';
import { registerQuotaReader, type QuotaReadOptions } from './engine-quota.js';
import { withCodexAppClient, type CodexAppClientOptions, type CodexRpc } from './codex-app-client.js';
import { codexQuotaFromRateLimits } from './codex-commands.js';

const SOURCE = 'codex account/rateLimits/read';

/** A session that can ask its own app-server (`codex-app`), or says how to start one like its own (`codex`). */
interface CodexSessionLike {
  codexRpc?(): CodexRpc | undefined;
  codexClientOptions?(): CodexAppClientOptions;
}

export async function readCodexQuota(engine: EngineType, opts: QuotaReadOptions): Promise<EngineQuota | undefined> {
  const session = opts.session as (ISession & CodexSessionLike) | undefined;
  const own = session?.codexRpc?.();
  if (own) return codexQuotaFromRateLimits(await own.request('account/rateLimits/read', {}), engine, SOURCE);
  const spawn = session?.codexClientOptions?.() ?? {};
  return withCodexAppClient({ ...spawn, cwd: spawn.cwd ?? opts.cwd ?? tmpdir() }, async (client) =>
    codexQuotaFromRateLimits(await client.request('account/rateLimits/read', {}), engine, SOURCE),
  );
}

registerQuotaReader('codex', (opts) => readCodexQuota('codex', opts));
registerQuotaReader('codex-app', (opts) => readCodexQuota('codex-app', opts));
