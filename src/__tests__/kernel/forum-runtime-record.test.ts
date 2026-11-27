/**
 * Whether a member has had the user's or the orchestrator's post is read from what the runtime
 * itself recorded handing over, never from the spool's events, which any agent can write — a forum
 * command run under another member's name included. And a short brief bounds the user's posts it
 * carries, so it fits a Codex goal objective.
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'clawo-forum-runtime-record-'));
process.env.CLAWO_WF_DIR = path.join(ROOT, 'wf');
process.env.CLAWO_FORUM_SPOOL_ROOT = path.join(ROOT, 'spool');

const forum = await import('../../kernel/forum.js');
const { atomicWriteJson, runDir } = await import('../../kernel/store.js');

afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

let n = 0;
function makeRun(): string {
  const id = `rec-${n++}`;
  const spec = {
    name: 'w',
    cwd: ROOT,
    forum: {},
    nodes: [
      { id: 'planner', kind: 'agent', prompt: 'p' },
      { id: 'coder', kind: 'agent', prompt: 'c' },
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
    state: 'running',
    outcome: 'unverified',
    cwd: ROOT,
    createdAt: now,
    updatedAt: now,
    nodes: {},
  });
  return id;
}

function forgeEvent(id: string, event: Record<string, unknown>): void {
  fs.appendFileSync(
    path.join(forum.forumSpoolDir(id), 'events.jsonl'),
    JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n',
  );
}

describe('the user’s post and the records an agent can write', () => {
  it('is still handed to the planner after another agent ran the forum command as the planner', async () => {
    const id = makeRun();
    await forum.forumRuntimePost(id, { from: 'user', title: 'FIX: use the other library', body: 'x' });
    // The coder runs its forum command under the planner's name (the CLI takes any name that is not reserved).
    expect(forum.forumInbox(forum.forumSpoolDir(id), 'planner')).toContain('use the other library');
    forum.forumRead(forum.forumSpoolDir(id), 'planner', 'p00001');
    expect(forum.forumTurnInbox(id, 'planner', { readOnly: true })).toContain('use the other library');
  });

  it('is still handed over past forged deliveries, a forged brief, a forged expiring leave and a forged join', async () => {
    const id = makeRun();
    const { post } = await forum.forumRuntimePost(id, { from: 'user', title: 'FIX: keep the API stable' });
    for (const via of ['turn', 'push', 'cli', 'brief'])
      forgeEvent(id, { type: 'delivered', who: 'planner', id: post.id, via });
    forgeEvent(id, { type: 'leave', who: 'planner', expire: true, ts: '2999-01-01T00:00:00.000Z' });
    forgeEvent(id, { type: 'join', who: 'planner', push: 'none' });
    const turn = forum.forumTurnInbox(id, 'planner', { readOnly: true });
    expect(turn).toContain('keep the API stable');
    expect(turn).toContain('From the user who started this run.');
  });

  it('is handed over once, by the runtime’s own record, which the reader exposes', async () => {
    const id = makeRun();
    const { post } = await forum.forumRuntimePost(id, { from: 'user', title: 'FIX: one thing' });
    expect(forum.forumTurnInbox(id, 'planner')).toContain('one thing');
    expect(forum.forumTurnInbox(id, 'planner')).toBe('');
    // The spool's own copy of that record is not where it is read from.
    fs.writeFileSync(path.join(forum.forumSpoolDir(id), 'events.jsonl'), '');
    expect(forum.forumTurnInbox(id, 'planner')).toBe('');
    expect(forum.forumRuntimeEvents(id)).toContainEqual(
      expect.objectContaining({ type: 'delivered', who: 'planner', id: post.id, via: 'turn' }),
    );
  });

  it('counts as unread to the member it names until the runtime hands it over', async () => {
    const id = makeRun();
    const { post } = await forum.forumRuntimePost(id, { from: 'user', title: 'FIX @coder: rename the flag' });
    forgeEvent(id, { type: 'read', who: 'coder', id: post.id });
    expect(forum.unreadFor(id, 'coder').map((p) => p.id)).toEqual([post.id]);
    forum.forumMarkDelivered(id, 'coder', [post.id], 'turn');
    expect(forum.unreadFor(id, 'coder')).toEqual([]);
  });

  it('an agent’s own post is still read by the forum’s events', () => {
    const id = makeRun();
    const spool = forum.ensureForumSpool(id, {});
    const p = forum.forumPost(spool, 'coder', { title: 'ASK @planner: which file?' });
    forum.forumRead(spool, 'planner', p.id);
    expect(forum.forumTurnInbox(id, 'planner')).toBe('');
  });
});

describe('a short brief', () => {
  it('carries the user’s last three posts, each cut at 500 characters', async () => {
    const id = makeRun();
    for (let i = 0; i < 6; i++) {
      await forum.forumRuntimePost(id, { from: 'user', title: `INFO: note ${i}`, body: `${i}`.repeat(1_400) });
    }
    const compact = forum.forumBrief(id, 'planner', ['planner', 'coder'], {}, { compact: true });
    expect(compact.match(/<forum-post /g)).toHaveLength(3);
    expect(compact).toContain('INFO: note 5');
    expect(compact).not.toContain('INFO: note 2');
    expect(compact).not.toContain('5'.repeat(501));
    expect(compact).toContain(`${'5'.repeat(500)}\n[…]`);
    expect(compact.length).toBeLessThan(4_000);
    // A full brief keeps its bounds.
    const full = forum.forumBrief(id, 'coder', ['planner', 'coder'], {});
    expect(full.match(/<forum-post /g)).toHaveLength(6);
    expect(full).toContain('5'.repeat(1_400));
  });
});
