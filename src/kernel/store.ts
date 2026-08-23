/**
 * Durable run store.
 *
 * Layout, one directory per run under `~/.claw-orchestrator/wf/<runId>/`:
 *
 *   spec.json      the WorkflowSpec, written once at creation, never mutated
 *   run.json       the mutable checkpoint, rewritten atomically on every transition
 *   events.jsonl   append-only audit + stream source
 *   nodes/<id>/    per-node artifacts
 *   evidence/<id>/ evidence bundles (see verify/evidence.ts)
 *
 * Splitting the immutable spec from the mutable checkpoint is what makes crash
 * recovery total: if `run.json` is missing or half-written, the state is rebuilt
 * by replaying `events.jsonl` against `spec.json`. The atomic rewrite makes that
 * path rare; the replay makes it survivable anyway.
 *
 * The two write helpers here replace four near-identical implementations that
 * had grown across the codebase (`session-manager.ts` sync + async variants,
 * `ultraapp/store.ts`, `ultraapp/patcher.ts`). The tmp-name shape is kept from
 * the ultraapp one, whose comment records the CI bug it fixed: a reader catching
 * a plain `writeFile` mid-flight and parsing a truncated object.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Logger } from '../logger.js';
import type { KernelEvent, NodeRecord, RunRecord, RunState, WorkflowSpec } from './types.js';

export function wfDir(): string {
  return process.env.CLAWO_WF_DIR || path.join(os.homedir(), '.claw-orchestrator', 'wf');
}

export function runDir(runId: string): string {
  return path.join(wfDir(), runId);
}

export function nodeDir(runId: string, nodeId: string): string {
  return path.join(runDir(runId), 'nodes', nodeId.replace(/[^\w.-]/g, '_'));
}

// ─── Shared write primitives ────────────────────────────────────────────────

/** Write JSON so a concurrent reader sees either the old file or the new one, never a partial. */
export function atomicWriteJson(file: string, value: unknown): void {
  const tmp = `${file}.tmp.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // Nothing to clean up.
    }
    throw err;
  }
}

/** Append one JSONL row. Best-effort: a log failure must never change control flow. */
export function appendJsonl(file: string, value: unknown, logger?: Logger): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(value) + '\n');
  } catch (err) {
    logger?.warn?.(`[kernel-store] append failed for ${path.basename(file)}: ${(err as Error).message}`);
  }
}

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

// ─── Run lifecycle ──────────────────────────────────────────────────────────

export function createRunDir(runId: string, spec: WorkflowSpec): void {
  const dir = runDir(runId);
  fs.mkdirSync(dir, { recursive: true });
  atomicWriteJson(path.join(dir, 'spec.json'), spec);
}

export function saveRun(record: RunRecord): void {
  atomicWriteJson(path.join(runDir(record.runId), 'run.json'), record);
}

export function loadSpec(runId: string): WorkflowSpec | undefined {
  return readJson<WorkflowSpec>(path.join(runDir(runId), 'spec.json'));
}

export function appendEvent(runId: string, event: KernelEvent, logger?: Logger): void {
  appendJsonl(path.join(runDir(runId), 'events.jsonl'), event, logger);
}

export function readEvents(runId: string, limit?: number): KernelEvent[] {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(runDir(runId), 'events.jsonl'), 'utf8');
  } catch {
    return [];
  }
  const out: KernelEvent[] = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as KernelEvent);
    } catch {
      // One corrupt line must not make the stream unreadable.
    }
  }
  return limit && limit > 0 ? out.slice(-limit) : out;
}

/**
 * Rebuild a run's state from its spec plus its event log. Used when `run.json`
 * is absent or unparseable — the belt to the atomic rewrite's braces.
 */
export function replayRun(runId: string, spec: WorkflowSpec): RunRecord | undefined {
  const events = readEvents(runId);
  if (events.length === 0) return undefined;

  const nodes: Record<string, NodeRecord> = {};
  for (const n of spec.nodes) {
    nodes[n.id] = { id: n.id, kind: n.kind, state: 'pending', attempts: 0, visits: 0 };
  }

  const created = events.find((e) => e.type === 'run_created');
  const record: RunRecord = {
    runId,
    workflow: spec.name,
    spec,
    state: 'pending',
    outcome: 'unverified',
    cwd: spec.cwd || process.cwd(),
    createdAt: created?.ts ?? events[0].ts,
    updatedAt: events[events.length - 1].ts,
    nodes,
  };

  for (const e of events) {
    switch (e.type) {
      case 'run_state':
        record.state = e.state;
        if (e.outcome) record.outcome = e.outcome;
        if (e.error) record.error = e.error;
        break;
      case 'node_state': {
        const n = (nodes[e.node] ??= { id: e.node, kind: 'agent', state: 'pending', attempts: 0, visits: 0 });
        n.state = e.state;
        if (e.attempt !== undefined) n.attempts = e.attempt;
        if (e.state === 'running') {
          n.visits++;
          n.startedAt = e.ts;
        }
        if (e.state === 'succeeded' || e.state === 'failed' || e.state === 'skipped') n.endedAt = e.ts;
        if (e.error) n.error = e.error;
        record.currentNode = e.node;
        break;
      }
      case 'node_output': {
        const n = nodes[e.node];
        if (n) n.output = e.text;
        break;
      }
      case 'evidence': {
        const n = nodes[e.node];
        if (n) n.evidenceId = e.evidenceId;
        record.evidenceId = e.evidenceId;
        break;
      }
      default:
        break;
    }
    record.updatedAt = e.ts;
  }

  // A run whose process died mid-flight left no terminal event. Say so rather
  // than reporting the stale `running` it was last seen in.
  if (record.state === 'running' || record.state === 'verifying') {
    record.error = record.error ?? 'process ended before the run reached a terminal state';
  }
  return record;
}

/** Load a run, preferring the checkpoint and falling back to an event replay. */
export function loadRun(runId: string): RunRecord | undefined {
  const spec = loadSpec(runId);
  if (!spec) return undefined;
  const checkpoint = readJson<RunRecord>(path.join(runDir(runId), 'run.json'));
  if (checkpoint && checkpoint.runId === runId && checkpoint.nodes) {
    checkpoint.spec = checkpoint.spec ?? spec;
    return checkpoint;
  }
  return replayRun(runId, spec);
}

export function listRunIds(): string[] {
  try {
    return fs
      .readdirSync(wfDir(), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}

/**
 * Remove a run's directory. Only ever called from an explicit user delete —
 * nothing in the kernel prunes runs on its own, for the same reason the ledger
 * does not: deleting someone's history is not ours to decide.
 */
export function deleteRunDir(runId: string, logger?: Logger): void {
  try {
    fs.rmSync(runDir(runId), { recursive: true, force: true });
  } catch (err) {
    logger?.warn?.(`[kernel-store] delete failed for ${runId}: ${(err as Error).message}`);
  }
}

export function writeNodeArtifact(runId: string, nodeId: string, name: string, body: string): string {
  const dir = nodeDir(runId, nodeId);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name.replace(/[^\w.-]/g, '_'));
  fs.writeFileSync(file, body);
  return path.relative(runDir(runId), file);
}

/** Terminal run states carry `endedAt`; this is the single place that stamps it. */
export function stampTerminal(record: RunRecord, state: RunState): void {
  record.state = state;
  record.endedAt = new Date().toISOString();
  record.updatedAt = record.endedAt;
}

// ─── Cross-process listing ──────────────────────────────────────────────────

export interface RunSummary {
  runId: string;
  workflow: string;
  state: RunState;
  outcome: RunRecord['outcome'];
  cwd: string;
  createdAt: string;
  updatedAt: string;
  endedAt?: string;
  currentNode?: string;
  evidenceId?: string;
  error?: string;
  costUsd?: number;
}

export interface ListRunsQuery {
  workflow?: string;
  state?: RunState;
  limit?: number;
}

export function summarize(record: RunRecord): RunSummary {
  return {
    runId: record.runId,
    workflow: record.workflow,
    state: record.state,
    outcome: record.outcome,
    cwd: record.cwd,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    endedAt: record.endedAt,
    currentNode: record.currentNode,
    evidenceId: record.evidenceId,
    error: record.error,
    costUsd: record.costUsd,
  };
}

/**
 * Every run on this machine, newest first — the cross-process listing the three
 * mode-specific enumerations each did differently (council regex-scraped its own
 * markdown transcripts, autoloop read a JSONL registry, ultraapp walked a store
 * directory). No separate index file is needed here because every run lives
 * under one root, so the directory *is* the index.
 */
export function listRuns(query: ListRunsQuery = {}): RunSummary[] {
  const out: RunSummary[] = [];
  for (const runId of listRunIds()) {
    const record = loadRun(runId);
    if (!record) continue;
    if (query.workflow && record.workflow !== query.workflow) continue;
    if (query.state && record.state !== query.state) continue;
    out.push(summarize(record));
  }
  out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  return query.limit && query.limit > 0 ? out.slice(0, query.limit) : out;
}
