/**
 * The agent's side of reading: `list`, `read`, and what the push rules would
 * have handed it, shown at the top of its next forum command.
 */

import path from 'node:path';
import { appendLine, EVENTS, POSTS, readJsonl, readPosts, readSpoolConfig, withVouchedPosts } from './store.js';
import { authorLabel, fenceForumText, formatPost, formatPush, postLine, scoreLabel } from './render.js';
import { INBOX_FULL_POSTS, type ForumEvent, type ForumMember } from './types.js';
import { briefedTo, forumAuthority, joinedAs, memberStates, routeDecision, seenBy, visibleTo } from './view.js';

export function rosterLine(team: ForumMember[], events: ForumEvent[], as: string): string {
  const states = memberStates(events);
  const items = team.map((m) => {
    const state = states.get(m.name) ?? 'not started';
    const again = state === 'finished' && m.mayReturn ? ', may run again' : '';
    return `${m.name} (${m.name === as ? 'you, ' : ''}${state}${again})`;
  });
  return `Team: ${items.join(', ')}`;
}

export function forumList(dir: string, as: string): string {
  appendLine(path.join(dir, EVENTS), { ts: new Date().toISOString(), type: 'list', who: as } satisfies ForumEvent);
  return listing(dir, as);
}

/** What `list` shows `as`, without putting a list on record. */
export function listing(dir: string, as: string): string {
  const config = readSpoolConfig(dir);
  const all = withVouchedPosts(config.runId, readPosts(path.join(dir, POSTS)));
  const posts = all.filter((p) => visibleTo(p, as));
  const events = readJsonl<ForumEvent>(path.join(dir, EVENTS));
  const roster = config.team ? `${rosterLine(config.team, events, as)}\n` : '';
  if (posts.length === 0) return `${roster}No posts yet.`;
  const seen = seenBy(as, all, events);
  const lines = posts.map((p) => {
    const mark = seen.has(p.id) ? '   ' : 'NEW';
    const to = p.to.length ? ` → ${p.to.map((n) => `@${n}`).join(' ')}` : '';
    return fenceForumText(
      `${mark} ${p.id}  ${authorLabel(config.runId, p)}${to}  ${p.ts.slice(11, 16)}${scoreLabel(p.score)}  ${p.title}`,
    );
  });
  const unread = posts.filter((p) => !seen.has(p.id)).length;
  return `${roster}${posts.length} posts, ${unread} new to you.\n${lines.join('\n')}`;
}

export function forumRead(dir: string, as: string, id: string): string {
  const config = readSpoolConfig(dir);
  const post = withVouchedPosts(config.runId, readPosts(path.join(dir, POSTS))).find(
    (p) => p.id === id && visibleTo(p, as),
  );
  if (!post) throw new Error(`No post ${id}`);
  appendLine(path.join(dir, EVENTS), { ts: new Date().toISOString(), type: 'read', who: as, id } satisfies ForumEvent);
  return formatPost(post, authorLabel(config.runId, post));
}

/**
 * What the push rules would have handed `as` mid-turn and it has not had: shown
 * at the top of its next forum command, then recorded as delivered (`cli`).
 *
 * Mid-turn delivery needs an engine that takes input during a turn (Claude Code,
 * `codex-app`, a goal). Every other engine — one process per turn, an ACP agent,
 * a custom CLI — still runs `clawo forum`, so this is where a post reaches it.
 * A post it read, had pushed, or saw in its brief is left out. `except` is the
 * post a `read` is about to show anyway.
 */
export function forumInbox(dir: string, as: string, except?: string): string {
  const config = readSpoolConfig(dir);
  const posts = withVouchedPosts(config.runId, readPosts(path.join(dir, POSTS)));
  const events = readJsonl<ForumEvent>(path.join(dir, EVENTS));
  const seen = seenBy(as, posts, events);
  for (const id of briefedTo(as, events)) seen.add(id);
  const joined = joinedAs(events, as);
  const member = { push: joined.push ?? config.push ?? 'mentions', canRead: joined.canRead !== false };
  const team = config.team?.map((m) => m.name);
  const pending = posts.filter(
    (p) =>
      p.id !== except &&
      !seen.has(p.id) &&
      routeDecision(p, as, member, forumAuthority(config.runId, p), team) === 'push',
  );
  if (pending.length === 0) return '';
  const ts = new Date().toISOString();
  for (const p of pending) {
    appendLine(path.join(dir, EVENTS), { ts, type: 'delivered', who: as, id: p.id, via: 'cli' } satisfies ForumEvent);
  }
  const full = pending.slice(-INBOX_FULL_POSTS);
  const older = pending.slice(0, -INBOX_FULL_POSTS);
  const lines = [
    `New on the team forum for you (${pending.length}):`,
    ...older.map((p) => `  ${postLine(config.runId, p)}`),
    ...full.map((p) => formatPush(p, config.runId, as)),
  ];
  return `${lines.join('\n')}\n────────\n`;
}
