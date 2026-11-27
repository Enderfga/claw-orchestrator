/**
 * What a post is to a reader: who it speaks for, who may see it, whether a
 * member has seen it, whether the route rules carry it to a member, and the
 * queries the modes ask of a forum.
 */

import path from 'node:path';
import { loadRun } from '../store.js';
import { liveHubs } from './registry.js';
import { forumTeam } from './roster.js';
import {
  authoredLedger,
  forumLocation,
  forumRuntimeEvents,
  isStandaloneForumId,
  postHash,
  spoolReady,
  tryReadSpoolConfig,
  viewOf,
  type ForumView,
} from './store.js';
import {
  isReservedForumName,
  MENTION_PUSH_TAGS,
  type ForumAuthority,
  type ForumEvent,
  type ForumPost,
  type ForumPushMode,
  type ForumVia,
} from './types.js';

// ─── Authority and visibility ───────────────────────────────────────────────

/**
 * Whether the runtime wrote this post: the forum's authored ledger, which only
 * the runtime writes, holds its id with the same author, text and recipients.
 * A line an agent wrote into the spool is not, whatever it says.
 */
export function isVouched(id: string, post: ForumPost): boolean {
  let store: string;
  try {
    store = forumLocation(id).store;
  } catch {
    return false;
  }
  const entry = authoredLedger(store).get(post.id);
  return !!entry && entry.from === post.from && entry.hash === postHash(post);
}

/**
 * Who a post speaks for. A post under a reserved name is the user's or the
 * orchestrator's only when the runtime wrote it (`isVouched`); any other post,
 * whatever its `from` says, is an agent's.
 */
export function forumAuthority(id: string, post: ForumPost): ForumAuthority {
  if (!isReservedForumName(post.from)) return 'agent';
  return isVouched(id, post) ? post.from : 'agent';
}

/** A `visibility: 'to'` post is for its author and its addressees only; any other post is for everyone. */
export function visibleTo(p: ForumPost, viewer: string | undefined): boolean {
  if (p.visibility !== 'to') return true;
  return viewer !== undefined && (p.from === viewer || p.to.includes(viewer));
}

// ─── Seen and unread ────────────────────────────────────────────────────────

/** When `name`'s current epoch began: its last leave with `expire`. Posts before it are not unread to it. */
export function epochStart(events: ForumEvent[], name: string): string {
  let start = '';
  for (const e of events) if (e.type === 'leave' && e.who === name && e.expire) start = e.ts;
  return start;
}

/**
 * Posts this agent has seen in full: read, pushed to it, handed to it in a turn
 * or at the top of its forum command, its own — and everything from before its
 * current epoch.
 */
export function seenBy(as: string, posts: ForumPost[], events: ForumEvent[]): Set<string> {
  const seen = new Set<string>();
  const epoch = epochStart(events, as);
  for (const p of posts) if (p.from === as || (epoch && p.ts <= epoch)) seen.add(p.id);
  for (const e of events) {
    if (
      e.who === as &&
      (e.type === 'read' || (e.type === 'delivered' && (e.via === 'push' || e.via === 'cli' || e.via === 'turn')))
    ) {
      seen.add(e.id);
    }
  }
  return seen;
}

/** Posts listed in a brief `as` read. A forum command or a turn does not hand them over again. */
export function briefedTo(as: string, events: ForumEvent[]): Set<string> {
  const out = new Set<string>();
  for (const e of events) if (e.type === 'delivered' && e.via === 'brief' && e.who === as) out.add(e.id);
  return out;
}

/**
 * Whether `as` has had a post, by who the post speaks for. An agent's post: by
 * the forum's events (`seenBy`). The user's or the orchestrator's: only by what
 * the runtime itself recorded handing `as` (`forumRuntimeEvents`), since the
 * forum's events are anyone's to write — a forum command run under `as`'s name
 * by another agent included. `byRuntime` says which record to go by when the
 * caller knows. `briefed`: a post listed in its brief counts too.
 */
export function hadBy(
  id: string,
  as: string,
  posts: ForumPost[],
  events: ForumEvent[],
  opts: { briefed?: boolean } = {},
): (p: ForumPost, byRuntime?: boolean) => boolean {
  const runtimeEvents = forumRuntimeEvents(id);
  const spool = seenBy(as, posts, events);
  const runtime = seenBy(as, posts, runtimeEvents);
  if (opts.briefed) {
    for (const pid of briefedTo(as, events)) spool.add(pid);
    for (const pid of briefedTo(as, runtimeEvents)) runtime.add(pid);
  }
  return (p, byRuntime = forumAuthority(id, p) !== 'agent') => (byRuntime ? runtime : spool).has(p.id);
}

// ─── Members ────────────────────────────────────────────────────────────────

export type MemberState = 'running' | 'finished' | 'not started';

/** Where each member is, from the joins and leaves on record. */
export function memberStates(events: ForumEvent[]): Map<string, MemberState> {
  const states = new Map<string, MemberState>();
  for (const e of events) {
    if (e.type === 'join') states.set(e.who, 'running');
    else if (e.type === 'leave') states.set(e.who, 'finished');
  }
  return states;
}

/** A member's own push rule and whether it reads the forum, from its last join. */
export function joinedAs(events: ForumEvent[], name: string): { push?: ForumPushMode; canRead?: boolean } {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === 'join' && e.who === name) {
      return { ...(e.push ? { push: e.push } : {}), ...(e.canRead === false ? { canRead: false } : {}) };
    }
  }
  return {};
}

/** The team of a forum: from the spec of the run that owns it, or the members of a forum with no run. */
export function forumTeamOf(runId: string): string[] {
  if (isStandaloneForumId(runId)) {
    try {
      const { spool, store } = forumLocation(runId);
      const config = tryReadSpoolConfig(spool) ?? tryReadSpoolConfig(store);
      return (config?.team ?? []).map((m) => m.name);
    } catch {
      return [];
    }
  }
  let owner;
  try {
    owner = loadRun(runId);
  } catch {
    owner = undefined;
  }
  return owner ? forumTeam(owner.spec) : [];
}

// ─── Routing ────────────────────────────────────────────────────────────────

/** A member as the route rules see it. */
export interface RouteMember {
  push: ForumPushMode;
  canRead: boolean;
}

/**
 * A post to the whole run: it names no member and no reserved addressee. With
 * no team known, any name it carries counts.
 */
export function toWholeRun(p: ForumPost, team: string[] | undefined): boolean {
  if (!team) return p.to.length === 0;
  return !p.to.some((n) => isReservedForumName(n) || team.includes(n));
}

/**
 * Whether the route rules carry `p` to member `name` the moment it is posted:
 * `push`, into its digest (`digest`), or not at all (`skip`).
 *
 *  1. A post only for its addressees does not reach anyone else.
 *  2. An explicit recipient gets it, whatever its tag and push rule.
 *  3. The user's or the orchestrator's post reaches the members it names, and
 *     every member that takes pushes when it names none.
 *  4. A teammate's post follows the member's push rule; a member that does not
 *     read the forum gets none.
 */
export function routeDecision(
  p: ForumPost,
  name: string,
  member: RouteMember,
  authority: ForumAuthority,
  team: string[] | undefined,
): 'push' | 'digest' | 'skip' {
  if (p.from === name) return 'skip';
  if (p.visibility === 'to' && !p.to.includes(name)) return 'skip';
  if (p.direct?.includes(name)) return 'push';
  if (authority !== 'agent') {
    if (p.to.includes(name)) return 'push';
    return toWholeRun(p, team) && member.push !== 'none' ? 'push' : 'skip';
  }
  if (!member.canRead) return 'skip';
  if (member.push === 'none') return 'skip';
  if (member.push === 'all') return 'push';
  if (p.to.includes(name) && p.tags.some((t) => MENTION_PUSH_TAGS.has(t))) return 'push';
  return member.push === 'digest' ? 'digest' : 'skip';
}

/** The names on a forum's team, as its spool config has them; undefined when it does not say. */
export function teamNames(id: string): string[] | undefined {
  try {
    const config = tryReadSpoolConfig(forumLocation(id).spool);
    return config?.team?.map((m) => m.name);
  } catch {
    return undefined;
  }
}

// ─── Queries ────────────────────────────────────────────────────────────────

/** An ASK is answered once someone else posts with a reference to it. */
export function answers(view: ForumView, ask: ForumPost): ForumPost | undefined {
  return view.posts.find((p) => p.id !== ask.id && p.from !== ask.from && p.re.includes(ask.id) && p.ts >= ask.ts);
}

/** Posts that name `name`, that it may see and has not had (`hadBy`). */
export function unreadFor(runId: string, name: string): ForumPost[] {
  const view = viewOf(runId);
  const had = hadBy(runId, name, view.posts, view.events);
  return view.posts.filter((p) => p.to.includes(name) && visibleTo(p, name) && !had(p));
}

/** Open ASKs everyone may see. */
export function openAsks(runId: string): ForumPost[] {
  const view = viewOf(runId);
  return view.posts.filter((p) => p.tags.includes('ASK') && visibleTo(p, undefined) && !answers(view, p));
}

/** Open ASKs, only those posted by `names` when given. */
export function openAsksOf(id: string, names?: string[]): ForumPost[] {
  const by = names ? new Set(names) : undefined;
  return openAsks(id).filter((p) => !by || by.has(p.from));
}

/**
 * Posts whose `to` includes `name`, in its current epoch; only the ones it has
 * not had (`hadBy`) with `unreadOnly`. `vouchedOnly`: only posts the runtime
 * wrote (`isVouched`), each read by the runtime's own record — for a mode whose
 * every message is the runtime's, such as the session forum.
 */
export function addressedTo(
  id: string,
  name: string,
  opts: { unreadOnly?: boolean; vouchedOnly?: boolean } = {},
): ForumPost[] {
  const view = viewOf(id);
  const runtimeEvents = forumRuntimeEvents(id);
  const spoolEpoch = epochStart(view.events, name);
  const runtimeEpoch = epochStart(runtimeEvents, name);
  const had = opts.unreadOnly ? hadBy(id, name, view.posts, view.events) : undefined;
  return view.posts.filter((p) => {
    if (!p.to.includes(name)) return false;
    if (opts.vouchedOnly && !isVouched(id, p)) return false;
    const byRuntime = opts.vouchedOnly || forumAuthority(id, p) !== 'agent';
    const epoch = byRuntime ? runtimeEpoch : spoolEpoch;
    return (!epoch || p.ts > epoch) && !had?.(p, byRuntime);
  });
}

export interface ForumPostsQuery {
  /** The reader: posts for others only (`visibility: 'to'`) are left out. Without one, only posts for everyone. */
  as?: string;
  /** After this post id (`p00012`), or after this ISO time. */
  since?: string;
  /** How the posts got there; `agent` for an agent's own forum command (no `via`). */
  via?: ForumVia | 'agent' | Array<ForumVia | 'agent'>;
  from?: string | string[];
  /** Posts carrying any of these tags. */
  tags?: string[];
}

const idNumber = (id: string): number => Number(/^p(\d+)$/.exec(id)?.[1] ?? NaN);

/** A forum's posts, filtered, as `as` may see them. */
export function forumPosts(id: string, query: ForumPostsQuery = {}): ForumPost[] {
  const { posts } = viewOf(id);
  const vias = query.via === undefined ? undefined : new Set(Array.isArray(query.via) ? query.via : [query.via]);
  const froms = query.from === undefined ? undefined : new Set(Array.isArray(query.from) ? query.from : [query.from]);
  const since = query.since;
  const sinceId = since !== undefined && /^p\d+$/.test(since) ? idNumber(since) : undefined;
  return posts.filter((p) => {
    if (!visibleTo(p, query.as)) return false;
    if (since !== undefined) {
      if (sinceId !== undefined ? !(idNumber(p.id) > sinceId) : !(p.ts > since)) return false;
    }
    if (vias && !vias.has(p.via ?? 'agent')) return false;
    if (froms && !froms.has(p.from)) return false;
    if (query.tags && !query.tags.some((t) => p.tags.includes(t))) return false;
    return true;
  });
}

/** All posts and events, for a caller outside the team (the orchestrator, a tool). */
export function forumSnapshot(runId: string): { posts: ForumPost[]; events: ForumEvent[] } {
  return viewOf(runId);
}

/** A live hub's member, when there is one in this process. */
export function liveMember(id: string, name: string) {
  return liveHubs.get(id)?.memberInfo(name);
}

/** The events file of a forum's spool, put back from the store if it is gone. */
export function spoolEvents(id: string): string {
  return path.join(spoolReady(id), 'events.jsonl');
}
