import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UltraappBuildQueue } from '../../ultraapp/build.js';
import type { BuildEvent } from '../../ultraapp/build-events.js';

describe('UltraappBuildQueue', () => {
  it('runs queued builds serially', async () => {
    const order: string[] = [];
    const worker = vi.fn().mockImplementation(async (runId: string) => {
      order.push(`start ${runId}`);
      await new Promise((r) => setTimeout(r, 20));
      order.push(`end ${runId}`);
    });
    const q = new UltraappBuildQueue({ worker });
    await Promise.all([q.enqueue('a'), q.enqueue('b'), q.enqueue('c')]);
    await q.idle();
    expect(order).toEqual(['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
  });

  it('reports queue position', async () => {
    const releases: Array<() => void> = [];
    const worker = vi.fn().mockImplementation(() => new Promise<void>((r) => releases.push(r)));
    const q = new UltraappBuildQueue({ worker });
    await q.enqueue('a');
    await q.enqueue('b');
    await q.enqueue('c');
    // a is in flight (position 0), b/c pending
    expect(q.position('a')).toBe(0);
    expect(q.position('b')).toBe(1);
    expect(q.position('c')).toBe(2);
    // Release all in order so the queue can drain
    while (releases.length || q.position('a') === 0) {
      const r = releases.shift();
      if (!r) {
        await new Promise((res) => setTimeout(res, 5));
        continue;
      }
      r();
      await new Promise((res) => setTimeout(res, 5));
    }
    await q.idle();
  });

  it('emits queued event with position when enqueued behind another build', async () => {
    const releases: Array<() => void> = [];
    const worker = vi.fn().mockImplementation(() => new Promise<void>((r) => releases.push(r)));
    const events: BuildEvent[] = [];
    const q = new UltraappBuildQueue({ worker });
    q.subscribe((e) => events.push(e));
    await q.enqueue('a');
    await q.enqueue('b');
    expect(events.find((e) => e.type === 'queued' && e.runId === 'b')).toBeTruthy();
    while (releases.length) releases.shift()!();
    // Drain
    for (let i = 0; i < 10 && releases.length === 0; i++) {
      await new Promise((res) => setTimeout(res, 5));
    }
    while (releases.length) releases.shift()!();
    await q.idle();
  });

  it('cancel removes pending', async () => {
    const releases: Array<() => void> = [];
    const worker = vi.fn().mockImplementation(() => new Promise<void>((r) => releases.push(r)));
    const q = new UltraappBuildQueue({ worker });
    await q.enqueue('a');
    await q.enqueue('b');
    q.cancel('b');
    expect(q.position('b')).toBe(-1);
    while (releases.length) releases.shift()!();
    await q.idle();
    expect(worker).toHaveBeenCalledTimes(1);
  });

  it('emits build-failed when worker throws', async () => {
    const worker = vi.fn().mockRejectedValue(new Error('boom'));
    const events: BuildEvent[] = [];
    const q = new UltraappBuildQueue({ worker });
    q.subscribe((e) => events.push(e));
    await q.enqueue('a');
    await q.idle();
    const failed = events.find((e) => e.type === 'build-failed');
    expect(failed).toBeTruthy();
    expect(failed!.type === 'build-failed' && failed.reason).toMatch(/boom/);
  });

  it('subscribe returns unsubscribe fn', async () => {
    const events: BuildEvent[] = [];
    const q = new UltraappBuildQueue({ worker: vi.fn().mockResolvedValue(undefined) });
    const off = q.subscribe((e) => events.push(e));
    off();
    await q.enqueue('a');
    await q.idle();
    expect(events).toEqual([]);
  });
});

// ─── Durability (6.0.0) ─────────────────────────────────────────────────────

describe('durable queue', () => {
  let dir: string;
  let statePath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawo-bq-'));
    statePath = path.join(dir, 'build-queue.json');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('survives a process that died, restoring the in-flight build first', async () => {
    // The old queue kept pending builds in an array and nothing else: a restart
    // dropped every queued build with no record it had been asked for.
    //
    // The dead owner is simulated by writing a state file whose pid cannot
    // exist. Constructing a live queue and then a second one in the SAME
    // process would prove the opposite of what this test is for — that two
    // owners can run the same builds concurrently.
    fs.writeFileSync(
      statePath,
      JSON.stringify({
        pending: ['run-b'],
        current: 'run-a',
        owner: { pid: 2 ** 30, renewedAt: new Date().toISOString() },
      }),
    );

    const seen: string[] = [];
    const restored: string[][] = [];
    const q = new UltraappBuildQueue({
      statePath,
      worker: async (runId) => {
        seen.push(runId);
      },
      onRestore: (ids) => restored.push(ids),
    });
    await q.idle();

    expect(q.ownsQueue()).toBe(true);
    // The in-flight build comes back first: it was asked for first, and the
    // user has been waiting on it longest.
    expect(restored[0]).toEqual(['run-a', 'run-b']);
    expect(seen).toEqual(['run-a', 'run-b']);
  });

  it('refuses to take builds a live OTHER process already owns', async () => {
    // Two owners restoring the same file would each run every build — every side
    // effect twice.
    //
    // The owner has to be a different live process, so pid 1 stands in: it
    // always exists, it is never us, and `kill(1, 0)` reports it as alive.
    // Constructing two queues in this process would not test this at all —
    // same-pid re-entrancy is allowed on purpose, so a manager can rebuild its
    // own queue.
    fs.writeFileSync(
      statePath,
      JSON.stringify({ pending: ['run-a'], current: null, owner: { pid: 1, renewedAt: new Date().toISOString() } }),
    );

    const seen: string[] = [];
    let refusedTo: { pid: number } | undefined;
    const second = new UltraappBuildQueue({
      statePath,
      worker: async (runId) => {
        seen.push(runId);
      },
      onNotOwner: (o) => {
        refusedTo = o;
      },
    });

    await new Promise((r) => setTimeout(r, 20));
    expect(second.ownsQueue()).toBe(false);
    expect(refusedTo?.pid).toBe(1);
    expect(seen).toEqual([]);
  });

  it('takes over from an owner whose heartbeat has gone stale', async () => {
    fs.writeFileSync(
      statePath,
      JSON.stringify({
        pending: ['run-a'],
        current: null,
        owner: { pid: 1, renewedAt: new Date(Date.now() - 10 * 60_000).toISOString() },
      }),
    );
    const seen: string[] = [];
    const q = new UltraappBuildQueue({
      statePath,
      worker: async (runId) => {
        seen.push(runId);
      },
    });
    await q.idle();
    expect(q.ownsQueue()).toBe(true);
    expect(seen).toEqual(['run-a']);
  });

  it('clears the state once the queue drains', async () => {
    const q = new UltraappBuildQueue({ statePath, worker: async () => undefined });
    await q.enqueue('run-a');
    await q.idle();
    expect(JSON.parse(fs.readFileSync(statePath, 'utf8'))).toMatchObject({ pending: [], current: null });
  });

  it('forgets a cancelled build', async () => {
    const blocked = new Promise<void>(() => undefined);
    const q = new UltraappBuildQueue({ statePath, worker: () => blocked });
    await q.enqueue('run-a');
    await q.enqueue('run-b');
    await new Promise((r) => setTimeout(r, 10));
    q.cancel('run-b');
    expect(JSON.parse(fs.readFileSync(statePath, 'utf8')).pending).toEqual([]);
  });

  it('ignores an unreadable or corrupt state file rather than refusing to start', () => {
    fs.writeFileSync(statePath, '{not json');
    const restored: string[][] = [];
    new UltraappBuildQueue({ statePath, worker: async () => undefined, onRestore: (ids) => restored.push(ids) });
    expect(restored).toEqual([]);
  });

  it('stays ephemeral when no statePath is given', async () => {
    const q = new UltraappBuildQueue({ worker: async () => undefined });
    await q.enqueue('run-a');
    await q.idle();
    expect(fs.existsSync(statePath)).toBe(false);
  });
});
