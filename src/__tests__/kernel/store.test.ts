/**
 * The durable store. Real temp directories, no fs mock — the whole point of the
 * layer is what survives the process that wrote it, so the assertions are on
 * what actually lands on disk.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  appendEvent,
  atomicWriteJson,
  createRunDir,
  deleteRunDir,
  listRunIds,
  listRuns,
  loadRun,
  loadSpec,
  readEvents,
  replayRun,
  runDir,
  saveRun,
  writeNodeArtifact,
} from '../../kernel/store.js';
import type { RunRecord, WorkflowSpec } from '../../kernel/types.js';

let tmp: string;
const saved = process.env.CLAWO_WF_DIR;

const spec: WorkflowSpec = {
  name: 'demo',
  nodes: [
    { id: 'a', kind: 'agent', prompt: 'do a' },
    { id: 'b', kind: 'agent', prompt: 'do b' },
  ],
};

function baseRecord(runId: string): RunRecord {
  return {
    runId,
    workflow: spec.name,
    spec,
    state: 'running',
    outcome: 'unverified',
    cwd: '/tmp',
    createdAt: '2026-08-23T00:00:00.000Z',
    updatedAt: '2026-08-23T00:00:00.000Z',
    nodes: {
      a: { id: 'a', kind: 'agent', state: 'pending', attempts: 0, visits: 0 },
      b: { id: 'b', kind: 'agent', state: 'pending', attempts: 0, visits: 0 },
    },
  };
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clawo-wf-'));
  process.env.CLAWO_WF_DIR = tmp;
});

afterEach(() => {
  if (saved === undefined) delete process.env.CLAWO_WF_DIR;
  else process.env.CLAWO_WF_DIR = saved;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('atomicWriteJson', () => {
  it('leaves no temp file behind on success', () => {
    const file = path.join(tmp, 'x.json');
    atomicWriteJson(file, { a: 1 });
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ a: 1 });
    expect(fs.readdirSync(tmp).filter((f) => f.includes('.tmp.'))).toHaveLength(0);
  });

  it('creates missing parent directories', () => {
    const file = path.join(tmp, 'deep', 'nested', 'x.json');
    atomicWriteJson(file, { ok: true });
    expect(fs.existsSync(file)).toBe(true);
  });

  it('replaces an existing file wholesale rather than appending', () => {
    const file = path.join(tmp, 'x.json');
    atomicWriteJson(file, { long: 'a'.repeat(500) });
    atomicWriteJson(file, { short: 1 });
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ short: 1 });
  });
});

describe('run directory', () => {
  it('writes the spec once and keeps it separate from the mutable checkpoint', () => {
    createRunDir('r1', spec);
    expect(loadSpec('r1')).toEqual(spec);
    expect(fs.existsSync(path.join(runDir('r1'), 'run.json'))).toBe(false);
  });

  it('round-trips a checkpoint', () => {
    createRunDir('r1', spec);
    const rec = baseRecord('r1');
    rec.nodes.a.state = 'succeeded';
    saveRun(rec);
    expect(loadRun('r1')?.nodes.a.state).toBe('succeeded');
  });

  it('stores node artifacts under the run', () => {
    createRunDir('r1', spec);
    const rel = writeNodeArtifact('r1', 'a', 'out.txt', 'hello');
    expect(fs.readFileSync(path.join(runDir('r1'), rel), 'utf8')).toBe('hello');
  });

  it('deletes only on an explicit request', () => {
    createRunDir('r1', spec);
    expect(listRunIds()).toContain('r1');
    deleteRunDir('r1');
    expect(listRunIds()).not.toContain('r1');
  });
});

describe('events', () => {
  it('appends and reads back in order', () => {
    createRunDir('r1', spec);
    appendEvent('r1', { ts: '2026-08-23T00:00:01.000Z', type: 'run_created', runId: 'r1', workflow: 'demo' });
    appendEvent('r1', { ts: '2026-08-23T00:00:02.000Z', type: 'run_state', state: 'running' });
    const events = readEvents('r1');
    expect(events.map((e) => e.type)).toEqual(['run_created', 'run_state']);
  });

  it('skips one corrupt line rather than failing the whole stream', () => {
    createRunDir('r1', spec);
    appendEvent('r1', { ts: 't1', type: 'run_state', state: 'running' });
    fs.appendFileSync(path.join(runDir('r1'), 'events.jsonl'), '{not json\n');
    appendEvent('r1', { ts: 't2', type: 'run_state', state: 'completed' });
    expect(readEvents('r1')).toHaveLength(2);
  });

  it('returns empty for a run with no event log', () => {
    createRunDir('r1', spec);
    expect(readEvents('r1')).toEqual([]);
  });
});

describe('crash recovery', () => {
  it('replays state from the event log when run.json is missing', () => {
    createRunDir('r1', spec);
    appendEvent('r1', { ts: 't0', type: 'run_created', runId: 'r1', workflow: 'demo' });
    appendEvent('r1', { ts: 't1', type: 'run_state', state: 'running' });
    appendEvent('r1', { ts: 't2', type: 'node_state', node: 'a', state: 'running', attempt: 1 });
    appendEvent('r1', { ts: 't3', type: 'node_state', node: 'a', state: 'succeeded' });

    const replayed = replayRun('r1', spec)!;
    expect(replayed.nodes.a.state).toBe('succeeded');
    expect(replayed.nodes.b.state).toBe('pending');
    expect(replayed.nodes.a.visits).toBe(1);
  });

  it('falls back to a replay when run.json is half-written', () => {
    createRunDir('r1', spec);
    appendEvent('r1', { ts: 't0', type: 'run_created', runId: 'r1', workflow: 'demo' });
    appendEvent('r1', { ts: 't1', type: 'node_state', node: 'a', state: 'succeeded' });
    // Simulate the torn write the atomic rename is there to prevent.
    fs.writeFileSync(path.join(runDir('r1'), 'run.json'), '{"runId":"r1","nod');

    const loaded = loadRun('r1');
    expect(loaded).toBeDefined();
    expect(loaded!.nodes.a.state).toBe('succeeded');
  });

  it('says a replayed mid-flight run did not reach a terminal state', () => {
    createRunDir('r1', spec);
    appendEvent('r1', { ts: 't0', type: 'run_created', runId: 'r1', workflow: 'demo' });
    appendEvent('r1', { ts: 't1', type: 'run_state', state: 'running' });
    const replayed = replayRun('r1', spec)!;
    expect(replayed.state).toBe('running');
    expect(replayed.error).toContain('process ended');
  });

  it('carries the verdict through a replay', () => {
    createRunDir('r1', spec);
    appendEvent('r1', { ts: 't0', type: 'run_created', runId: 'r1', workflow: 'demo' });
    appendEvent('r1', { ts: 't1', type: 'evidence', node: 'a', evidenceId: 'a-01', passed: true });
    appendEvent('r1', { ts: 't2', type: 'run_state', state: 'completed', outcome: 'verified' });
    const replayed = replayRun('r1', spec)!;
    expect(replayed.outcome).toBe('verified');
    expect(replayed.evidenceId).toBe('a-01');
  });

  it('returns undefined for an unknown run', () => {
    expect(loadRun('nope')).toBeUndefined();
  });
});

describe('listRuns', () => {
  it('lists newest first and filters', () => {
    for (const [id, ts, state] of [
      ['old', '2026-08-01T00:00:00.000Z', 'completed'],
      ['new', '2026-08-20T00:00:00.000Z', 'failed'],
    ] as const) {
      createRunDir(id, spec);
      const rec = baseRecord(id);
      rec.createdAt = ts;
      rec.state = state;
      saveRun(rec);
    }
    expect(listRuns().map((r) => r.runId)).toEqual(['new', 'old']);
    expect(listRuns({ state: 'completed' }).map((r) => r.runId)).toEqual(['old']);
    expect(listRuns({ workflow: 'nothing' })).toEqual([]);
    expect(listRuns({ limit: 1 })).toHaveLength(1);
  });

  it('is empty when nothing has run', () => {
    expect(listRuns()).toEqual([]);
  });

  it('skips a directory whose spec is gone rather than failing the listing', () => {
    // Inherited from the enumerators this replaced: a workspace that was moved
    // or deleted out from under a run used to be dropped from the autoloop
    // registry listing. One unreadable run must not make the rest invisible.
    createRunDir('good', spec);
    saveRun(baseRecord('good'));
    fs.mkdirSync(path.join(tmp, 'half-deleted'), { recursive: true });
    expect(listRuns().map((r) => r.runId)).toEqual(['good']);
  });

  it('ignores directories whose names are not valid run ids', () => {
    fs.mkdirSync(path.join(tmp, '..hidden'), { recursive: true });
    fs.mkdirSync(path.join(tmp, '.tmp-junk'), { recursive: true });
    createRunDir('real', spec);
    saveRun(baseRecord('real'));
    expect(listRuns().map((r) => r.runId)).toEqual(['real']);
  });
});
