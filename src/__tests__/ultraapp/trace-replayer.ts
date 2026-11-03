/**
 * Trace replayer — runs a JSONL reference trace through the real
 * UltraappManager + UltraappStore against a stubbed SessionManager whose
 * sendMessage replies are pre-loaded from `claude-*` entries in trace order.
 *
 * Returns the runId + the on-disk spec.json after replay; callers compare
 * against a frozen `expected/<trace>.appspec.json` snapshot.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { UltraappManager } from '../../ultraapp/manager.js';
import { UltraappStore } from '../../ultraapp/store.js';

export interface TraceEntry {
  kind: string;
  [k: string]: unknown;
}

interface ReplayResult {
  runId: string;
  specJson: unknown;
}

export async function replayTrace(traceFile: string, storeRoot: string): Promise<ReplayResult> {
  const entries: TraceEntry[] = fs
    .readFileSync(traceFile, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));

  // Build the reply queue from the claude-* entries in order. Each entry
  // becomes ONE sendMessage reply.
  const replies: string[] = [];
  for (const e of entries) {
    if (e.kind === 'claude-question') {
      replies.push('```question\n' + JSON.stringify(e.envelope) + '\n```');
    } else if (e.kind === 'claude-tool') {
      const args = JSON.stringify(e.args ?? {});
      replies.push(`<tool name="${e.tool as string}">${args}</tool>`);
    } else if (e.kind === 'claude-complete') {
      const summary = (e.summary as string) ?? 'Done.';
      replies.push(`${summary}\n[INTERVIEW: COMPLETE]`);
    }
  }

  let consumed = 0;
  const sm = {
    startSession: async (cfg: { name?: string }) => ({ name: cfg.name ?? 'replay' }),
    sendMessage: async () => ({
      output: replies[consumed++] ?? '[INTERVIEW: COMPLETE]',
    }),
    stopSession: async () => undefined,
  };

  /** Drain until either the reply queue is exhausted (consumed >= target)
      or a deadline elapses. driveTurn is fire-and-forget for tool-followup
      chains; we need many drain cycles so each chained sendMessage gets a
      chance to grab its slot. */
  async function drainUntil(targetConsumed: number, deadlineMs = 1500): Promise<void> {
    const start = Date.now();
    while (consumed < targetConsumed && Date.now() - start < deadlineMs) {
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  const store = new UltraappStore(storeRoot);
  // Note: extract_metadata calls fall through to the manager's default
  // implementation (file probe / ffprobe). Traces that need stubbed metadata
  // results should attach those results inside the trace's `claude-tool`
  // entries; richer wiring is a future-work item.

  // Pre-compute consumed targets: how many replies should have been served
  // by the time we move past each user-* entry. createRun's KICKOFF eats the
  // leading claude-* run; each user action eats the following claude-* run.
  const targets: number[] = [];
  let claudeAcc = 0;
  let firstUserSeen = false;
  for (const e of entries) {
    if (e.kind.startsWith('claude-')) {
      claudeAcc++;
    } else if (e.kind.startsWith('user-')) {
      targets.push(claudeAcc);
      firstUserSeen = true;
    }
  }
  // Total replies that exist for final drain.
  const totalReplies = claudeAcc;

  const mgr = new UltraappManager({ store, sessionManager: sm as never });
  const runId = await mgr.createRun();
  // Drain the kickoff replies (claude-* before any user action)
  const kickoffTarget = firstUserSeen ? targets[0] : totalReplies;
  await drainUntil(Math.min(kickoffTarget, totalReplies));

  let userIdx = 0;
  for (const e of entries) {
    if (e.kind === 'user-answer') {
      await mgr.submitAnswer(runId, {
        value: e.value as string,
        freeform: e.freeform as string | undefined,
      });
    } else if (e.kind === 'user-file') {
      const data = Buffer.from(e['contents-b64'] as string, 'base64');
      await mgr.addFile(runId, { kind: 'upload', filename: e.filename as string, data });
    } else if (e.kind === 'user-path') {
      await mgr.addFile(runId, { kind: 'path', absolutePath: e.absolutePath as string });
    } else {
      continue;
    }
    userIdx++;
    const next = userIdx < targets.length ? targets[userIdx] : totalReplies;
    await drainUntil(next);
  }

  // Final drain for any trailing claude-* entries past the last user action.
  await drainUntil(totalReplies);
  // A turn that took the last reply can still be writing the run's files; read
  // the spec, and let the caller remove the store, only once it has finished.
  await mgr.waitForIdle();

  const specJson = JSON.parse(fs.readFileSync(path.join(store.runDirAbsolute(runId), 'spec.json'), 'utf8'));
  return { runId, specJson };
}

/** Strips fields whose values change every replay (ids, timestamps). */
export function stripVolatile(spec: unknown): unknown {
  const s = JSON.parse(JSON.stringify(spec)) as {
    runId?: string;
    createdAt?: string;
    updatedAt?: string;
  };
  delete s.runId;
  delete s.createdAt;
  delete s.updatedAt;
  return s;
}
