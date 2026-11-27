/**
 * The forum's files under an agent that writes the spool and a server that must not stall: a lock
 * left in the spool does not block the server's thread for seconds or fail a post or a join; one
 * hand-written id does not make every later post share an id; a retirement loses no post written
 * while it runs, and copies a line the store lacks whatever the lengths; a forum used often is not
 * read whole or rewritten for nothing; a session forum's store goes once its process is gone.
 */
import { describe, it, expect, afterEach, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'clawo-forum-store-hardening-'));
process.env.CLAWO_WF_DIR = path.join(ROOT, 'wf');
process.env.CLAWO_FORUM_SPOOL_ROOT = path.join(ROOT, 'spool');

const forum = await import('../../kernel/forum.js');
const { atomicWriteJson, runDir, wfDir } = await import('../../kernel/store.js');

const leaves: Array<() => void> = [];
afterEach(() => {
  for (const l of leaves.splice(0)) l();
  vi.restoreAllMocks();
});
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

function makeRun(id: string, state = 'running'): void {
  const spec = {
    name: 'w',
    cwd: ROOT,
    forum: {},
    nodes: [
      { id: 'a', kind: 'agent', prompt: 'x' },
      { id: 'b', kind: 'agent', prompt: 'y' },
    ],
  };
  const dir = runDir(id);
  fs.mkdirSync(dir, { recursive: true });
  atomicWriteJson(path.join(dir, 'spec.json'), spec);
  const now = new Date().toISOString();
  atomicWriteJson(path.join(dir, 'run.json'), {
    runId: id,
    workflow: 'w',
    spec,
    state,
    outcome: 'unverified',
    cwd: ROOT,
    createdAt: now,
    updatedAt: now,
    nodes: {},
  });
}

describe('a lock left in the spool', () => {
  it('does not block a hub sync or a join, and a runtime post still goes through', async () => {
    const id = 'hard-lock-1';
    makeRun(id);
    const hub = forum.forumHub(id, {});
    leaves.push(hub.join('a', async () => true));
    // What a `clawo forum post` killed inside its critical section leaves (or an agent's `touch`).
    const lock = path.join(forum.forumSpoolDir(id), 'posts.lock');
    fs.writeFileSync(lock, '');

    let t = Date.now();
    await hub.sync();
    const syncMs = Date.now() - t;

    t = Date.now();
    let joinErr: string | undefined;
    try {
      leaves.push(hub.join('b', async () => true));
    } catch (err) {
      joinErr = (err as Error).message;
    }
    const joinMs = Date.now() - t;

    let postErr: string | undefined;
    try {
      await forum.forumRuntimePost(id, { from: 'orchestrator', title: 'INFO: hello' });
    } catch (err) {
      postErr = (err as Error).message;
    }
    fs.rmSync(lock, { force: true });
    expect(syncMs).toBeLessThan(1_000);
    expect(joinErr).toBeUndefined();
    expect(joinMs).toBeLessThan(1_000);
    expect(postErr).toBeUndefined();
    expect(forum.forumSnapshot(id).posts.map((p) => p.title)).toContain('INFO: hello');
  }, 20_000);
});

describe('a hand-written post id', () => {
  it('does not give every later post the same id', async () => {
    const id = 'hard-pid-1';
    makeRun(id);
    const hub = forum.forumHub(id, {});
    let pushedToB = 0;
    leaves.push(
      hub.join('b', async () => {
        pushedToB++;
        return true;
      }),
    );
    const spool = forum.forumSpoolDir(id);
    fs.appendFileSync(
      path.join(spool, 'posts.jsonl'),
      JSON.stringify({ id: 'p999999999999', from: 'a', title: 'x', body: '', tags: [], to: [], re: [] }) + '\n',
    );
    await hub.sync();
    const one = await forum.forumRuntimePost(id, { from: 'user', title: 'FIX @b: first steer', direct: ['b'] });
    const two = await forum.forumRuntimePost(id, { from: 'user', title: 'FIX @b: second steer', direct: ['b'] });
    const three = forum.forumPost(spool, 'a', { title: 'ASK @b: from the CLI' });
    await hub.sync();
    expect(new Set([one.post.id, two.post.id, three.id]).size).toBe(3);
    const titles = forum.forumSnapshot(id).posts.map((p) => p.title);
    expect(titles).toContain('FIX @b: second steer');
    expect(titles).toContain('ASK @b: from the CLI');
    expect(two.routed).toEqual({ b: 'delivered' });
    expect(pushedToB).toBe(3);
  });
});

describe('retiring a spool', () => {
  it('loses no post written while it runs: the writer either lands in the store or finds no forum', () => {
    const id = 'hard-ret-1';
    makeRun(id);
    const spool = forum.ensureForumSpool(id, {});
    forum.forumPost(spool, 'a', { title: 'INFO: before' });
    const realRm = fs.rmSync;
    let posted: string | undefined;
    let refused: string | undefined;
    // Another process (an agent's CLI) posts once the lock is free, just before the spool is removed.
    vi.spyOn(fs, 'rmSync').mockImplementation(((p: fs.PathLike, o?: fs.RmOptions) => {
      // The spool itself, or where it was moved aside (not the lock file released inside it).
      const target = String(p);
      if ((target === spool || target.startsWith(`${spool}.retired.`)) && !posted && !refused) {
        try {
          posted = forum.forumPost(spool, 'b', { title: 'INFO: in the window' }).id;
        } catch (err) {
          refused = (err as Error).message;
        }
      }
      return realRm(p, o);
    }) as typeof fs.rmSync);
    forum.retireForumSpool(id);
    vi.restoreAllMocks();
    const stored = forum.forumSnapshot(id).posts.map((p) => p.title);
    expect(stored).toContain('INFO: before');
    if (posted) expect(stored).toContain('INFO: in the window');
    else expect(refused).toBeTruthy();
    expect(fs.existsSync(spool)).toBe(false);
  });

  it('copies a spool line the store lacks when the store has a longer line the spool lacks', () => {
    const id = 'hard-ret-2';
    makeRun(id);
    const spool = forum.ensureForumSpool(id, {});
    const store = forum.forumStoreDir(id);
    const S = JSON.stringify({ ts: 't', type: 'join', who: 'a' }) + '\n';
    const L = JSON.stringify({ ts: 't', type: 'leave', who: 'a-long-name-for-the-store-only' }) + '\n';
    const M = JSON.stringify({ ts: 't', type: 'join', who: 'b' }) + '\n';
    fs.writeFileSync(path.join(spool, 'events.jsonl'), S + M);
    fs.writeFileSync(path.join(store, 'events.jsonl'), S + L);
    expect(M.length).toBeLessThanOrEqual(L.length);
    forum.retireForumSpool(id);
    const events = fs.readFileSync(path.join(store, 'events.jsonl'), 'utf8');
    expect(events).toContain('"who":"b"');
    expect(events).toContain('a-long-name-for-the-store-only');
  });

  it('leaves no moved-aside spool behind for long: a prune removes one a dead process left', () => {
    const root = path.dirname(forum.forumSpoolDir('x'));
    const debris = path.join(root, 'hard-ret-3.retired.12345.0a1b2c3d');
    fs.mkdirSync(debris, { recursive: true });
    fs.writeFileSync(path.join(debris, 'posts.jsonl'), '');
    forum.pruneForumSpools();
    expect(fs.existsSync(debris)).toBe(false);
  });
});

describe('a forum used often', () => {
  it('is not read whole by a hub sync that finds nothing new', async () => {
    const id = 'hard-cost-1';
    makeRun(id);
    const hub = forum.forumHub(id, {});
    leaves.push(hub.join('b', async () => true));
    forum.forumPost(forum.forumSpoolDir(id), 'a', { title: 'INFO: one' });
    await hub.sync();
    const spy = vi.spyOn(fs, 'readFileSync');
    await hub.sync();
    await hub.sync();
    const reads = spy.mock.calls.map((c) => String(c[0])).filter((f) => f.endsWith('.jsonl'));
    expect(reads).toEqual([]);
  });

  it('has a runtime post neither restore the spool nor rewrite its config when nothing changed', async () => {
    const id = 'hard-cost-2';
    makeRun(id);
    await forum.forumRuntimePost(id, { from: 'orchestrator', title: 'INFO: first' });
    const config = path.join(forum.forumSpoolDir(id), 'config.json');
    const before = fs.statSync(config);
    const storePosts = path.join(forum.forumStoreDir(id), 'posts.jsonl');
    const spy = vi.spyOn(fs, 'readFileSync');
    await forum.forumRuntimePost(id, { from: 'orchestrator', title: 'INFO: second' });
    const reads = spy.mock.calls.map((c) => String(c[0]));
    vi.restoreAllMocks();
    expect(reads).not.toContain(storePosts);
    const after = fs.statSync(config);
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    // Still put back when the spool is gone.
    fs.rmSync(forum.forumSpoolDir(id), { recursive: true, force: true });
    await forum.forumRuntimePost(id, { from: 'orchestrator', title: 'INFO: third' });
    expect(forum.forumSnapshot(id).posts.map((p) => p.title)).toEqual(['INFO: first', 'INFO: second', 'INFO: third']);
  });

  it('a session forum’s store goes once its process is gone and it has not changed for a week', async () => {
    const forums = path.join(path.dirname(wfDir()), 'forums');
    // A pid no process has: past the highest pid a system gives out.
    const dead = `fm-sessions-4194999-old`;
    const live = `fm-sessions-${process.pid}-old`;
    for (const id of [dead, live]) {
      forum.createForum(id, { looseNames: true });
      await forum.forumRuntimePost(id, { from: 'user', title: 'INFO: dm' });
      forum.retireForumSpool(id);
    }
    expect(forum.pruneForumSpools(Date.now())).not.toContain(dead);
    expect(fs.existsSync(path.join(forums, dead))).toBe(true);
    const later = Date.now() + 8 * 24 * 3600_000;
    expect(forum.pruneForumSpools(later)).toContain(dead);
    expect(fs.existsSync(path.join(forums, dead))).toBe(false);
    expect(fs.existsSync(path.join(forums, live))).toBe(true);
  });
});
