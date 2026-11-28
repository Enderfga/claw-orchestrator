/**
 * What Codex records in its rollout files and reports nowhere else.
 *
 * Each thread writes `$CODEX_HOME/sessions/<year>/<month>/<day>/rollout-<time>-<thread_id>.jsonl`.
 * Two kinds of spend reach no stream clawo reads:
 *
 *   - sub-agents: `codex exec --json` reports the main thread's usage only, and
 *     each sub-agent is a thread of its own, named in the parent's rollout by a
 *     `SubAgentActivity` item's `agent_thread_id` (0.172.0);
 *   - reviews: `review/start` runs a reviewer thread (`"source":{"subagent":"review"}`,
 *     `parent_thread_id` the reviewed thread) and sends no `thread/tokenUsage/updated`
 *     while it runs.
 *
 * Every reader here is best effort: a file that is missing or torn reads as nothing.
 */

import { closeSync, fstatSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Token totals as a rollout's `total_token_usage` holds them; `output` includes reasoning. */
export interface CodexTokenTotals {
  input: number;
  cached: number;
  output: number;
}

export function codexSessionsRoot(): string {
  return join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'sessions');
}

function newestFirstDirs(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
    .reverse();
}

/**
 * The rollout `threadId` writes to now, searched newest day first; undefined
 * when there is none. A thread reverted with `thread/revert` goes on in a file
 * of its own, `rollout-<time>-<thread_id>_<segment>.jsonl` (0.172.0), so the
 * newest of the thread's files is the one.
 */
export function findCodexRollout(threadId: string, root = codexSessionsRoot()): string | undefined {
  const whole = `-${threadId}.jsonl`;
  const segment = `-${threadId}_`;
  try {
    for (const year of newestFirstDirs(root)) {
      for (const month of newestFirstDirs(join(root, year))) {
        for (const day of newestFirstDirs(join(root, year, month))) {
          const dir = join(root, year, month, day);
          const hits = readdirSync(dir).filter(
            (f) => f.endsWith(whole) || (f.includes(segment) && f.endsWith('.jsonl')),
          );
          // The name starts with the time the file was opened.
          if (hits.length) return join(dir, hits.sort().at(-1)!);
        }
      }
    }
  } catch {
    // No sessions directory.
  }
  return undefined;
}

/**
 * Part of a file and its size: the last `tail` bytes, the first `head`, the
 * bytes after offset `from`, or, with none of them, all of it.
 */
export function readFileSlice(
  file: string,
  opts: { tail?: number; head?: number; from?: number },
): { text: string; size: number } {
  let fd: number | undefined;
  try {
    fd = openSync(file, 'r');
    const size = fstatSync(fd).size;
    const start = opts.from !== undefined ? Math.min(opts.from, size) : Math.max(0, size - (opts.tail ?? size));
    const len = opts.head !== undefined ? Math.min(opts.head, size) : size - start;
    const buf = Buffer.alloc(len);
    if (len > 0) readSync(fd, buf, 0, len, start);
    return { text: buf.toString('utf8'), size };
  } catch {
    return { text: '', size: opts.from ?? 0 };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** The last `total_token_usage` in `text`. */
export function lastTotals(text: string): CodexTokenTotals | undefined {
  const all = text.match(/"total_token_usage":\s*\{[^}]*\}/g);
  const last = all?.[all.length - 1];
  if (!last) return undefined;
  try {
    const t = (JSON.parse(`{${last}}`) as { total_token_usage?: Record<string, number> }).total_token_usage ?? {};
    return {
      input: t.input_tokens ?? 0,
      cached: t.cached_input_tokens ?? 0,
      output: (t.output_tokens ?? 0) + (t.reasoning_output_tokens ?? 0),
    };
  } catch {
    return undefined;
  }
}

/** The thread's total as its rollout last recorded it. */
export function rolloutTotals(file: string): CodexTokenTotals | undefined {
  return lastTotals(readFileSlice(file, { tail: 256 * 1024 }).text);
}

/** The model of the last `turn_context` in `text`. */
export function lastTurnModel(text: string): string | undefined {
  let model: string | undefined;
  for (const line of text.split('\n')) {
    if (!line.includes('"turn_context"')) continue;
    try {
      const entry = JSON.parse(line) as { type?: string; payload?: { model?: unknown } };
      if (entry.type === 'turn_context' && typeof entry.payload?.model === 'string') model = entry.payload.model;
    } catch {
      // A torn last line while codex is still writing.
    }
  }
  return model;
}

/** The sub-agent threads `text` names (`SubAgentActivity.agent_thread_id`), in order, once each. */
export function subAgentThreadIds(text: string): string[] {
  const ids: string[] = [];
  for (const m of text.matchAll(/"agent_thread_id":\s*"([0-9a-fA-F-]{8,})"/g)) {
    if (!ids.includes(m[1])) ids.push(m[1]);
  }
  return ids;
}

/** One sub-agent thread's spend, as its rollout records it. */
export interface SubAgentUsage {
  threadId: string;
  totals: CodexTokenTotals;
  model?: string;
}

/**
 * The spend of the sub-agents of `threadIds`' threads and of their own
 * sub-agents, each thread once. A sub-agent whose rollout is not found yet is
 * left out, to be read on a later call.
 */
export function subAgentUsage(threadIds: readonly string[], root = codexSessionsRoot()): SubAgentUsage[] {
  const out: SubAgentUsage[] = [];
  const seen = new Set<string>();
  const queue = [...threadIds];
  while (queue.length && seen.size < 256) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const file = findCodexRollout(id, root);
    if (!file) continue;
    const { text } = readFileSlice(file, {});
    const totals = lastTotals(text);
    if (totals) out.push({ threadId: id, totals, model: lastTurnModel(text) });
    queue.push(...subAgentThreadIds(text));
  }
  return out;
}

/**
 * The reviewer thread a `review/start` on `parentThreadId` ran, started at or
 * after `sinceMs`: its totals and model. Only the two newest day directories are
 * read, and only files written since the review began.
 */
export function reviewRolloutUsage(
  parentThreadId: string,
  sinceMs: number,
  root = codexSessionsRoot(),
): { threadId?: string; totals?: CodexTokenTotals; model?: string } {
  try {
    const days: string[] = [];
    for (const year of newestFirstDirs(root)) {
      for (const month of newestFirstDirs(join(root, year))) {
        for (const day of newestFirstDirs(join(root, year, month))) {
          if (days.length < 2) days.push(join(root, year, month, day));
        }
      }
    }
    const parent = `"parent_thread_id":"${parentThreadId}"`;
    for (const dir of days) {
      const names = readdirSync(dir)
        .filter((f) => f.startsWith('rollout-') && f.endsWith('.jsonl'))
        .sort()
        .reverse();
      for (const name of names) {
        const file = join(dir, name);
        if (statSync(file).mtimeMs < sinceMs - 5_000) continue;
        const head = readFileSlice(file, { head: 16_384 }).text;
        if (!head.replace(/\s/g, '').includes(parent) || !/"subagent":\s*"review"/.test(head)) continue;
        const started = /"timestamp":\s*"([^"]+)"/.exec(head)?.[1];
        if (started && Date.parse(started) < sinceMs - 5_000) continue;
        const text = readFileSlice(file, {}).text;
        const threadId = /([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\.jsonl$/.exec(
          name,
        )?.[1];
        return { threadId, totals: lastTotals(text), model: lastTurnModel(text) };
      }
    }
  } catch {
    // Best effort: an unread review costs nothing rather than failing it.
  }
  return {};
}
