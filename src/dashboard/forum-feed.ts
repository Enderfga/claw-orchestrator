/**
 * A run's forum as the dashboard and the workflow event stream show it: each
 * post with who it speaks for (the forum's authored ledger decides, never the
 * post's own `from`), a listing, one post in full, and a tail that reports every
 * new post once.
 *
 * The view is the orchestrator's: every post, including those only for their
 * addressees. Reading here is not an agent's read and records nothing.
 *
 * There is no in-process event for a new post (an agent's CLI writes the spool
 * from another process), so the tail polls: it looks at the size and mtime of
 * the posts files and reads them only when one changed.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  forumAuthority,
  forumLocation,
  runForum,
  type ForumAuthority,
  type ForumPost,
  type RunForum,
} from '../kernel/forum.js';
import { POSTS, readPosts, withVouchedPosts } from '../kernel/forum/store.js';
import type { RunRecord } from '../kernel/types.js';

/** What a list row and a `forum_post` event carry. */
export interface ForumPostSummary {
  id: string;
  ts: string;
  from: string;
  /** Who the post speaks for. `agent` for a post under `user` or `orchestrator` the ledger does not vouch for. */
  authority: ForumAuthority;
  tags: string[];
  to: string[];
  title: string;
  re?: string[];
  via?: string;
  /** `to`: the post is for its author and its addressees only. */
  visibility?: 'to';
}

/** One post in full. */
export interface ForumPostDetail extends ForumPostSummary {
  body: string;
  score?: unknown;
  direct?: string[];
  data?: Record<string, unknown>;
}

export interface ForumListing {
  /** The forum's id: the run's own, or the run whose forum it is bound to. */
  id: string;
  /** Whether the run's agents are on the forum. When not, it holds the runtime's posts only. */
  exposed: boolean;
  /** Posts on the forum; `posts` holds the newest of them. */
  total: number;
  /** The highest post id on the forum (`p00000` when there is none), for `forumSince`. */
  last: string;
  posts: ForumPostSummary[];
}

/** How often the tail looks for new posts. */
export const FORUM_TAIL_MS = 1_000;
/** Posts a listing holds unless asked for another number. */
export const FORUM_LIST_DEFAULT = 500;
export const FORUM_LIST_MAX = 5_000;

const POST_ID = /^p(\d{1,12})$/;

/** The number in a post id (`p00012` → 12); NaN for anything else. */
export function forumPostNumber(id: string | undefined): number {
  const m = id === undefined ? null : POST_ID.exec(id);
  return m ? Number(m[1]) : NaN;
}

/** Whether `id` has the shape the forum gives post ids. */
export function isForumPostId(id: unknown): id is string {
  return typeof id === 'string' && POST_ID.test(id);
}

/** The forum a run's posts are on, or undefined for a record that names none it can resolve. */
export function forumOfRun(record: RunRecord): RunForum | undefined {
  try {
    return runForum(record);
  } catch {
    return undefined;
  }
}

/**
 * The posts file to read: the spool while it is at least as long as the store
 * (it is the live copy, and the store can trail it by a second), else the store,
 * which is all there is once the spool is retired.
 */
function postsFile(id: string): { file: string; signature: string } {
  const { spool, store } = forumLocation(id);
  const s = path.join(spool, POSTS);
  const d = path.join(store, POSTS);
  const st = (f: string) => {
    try {
      const x = fs.statSync(f);
      return { size: x.size, mtime: x.mtimeMs };
    } catch {
      return { size: -1, mtime: 0 };
    }
  };
  const a = st(s);
  const b = st(d);
  return { file: a.size >= b.size ? s : d, signature: `${a.size}:${a.mtime}:${b.size}:${b.mtime}` };
}

/** Every post on a forum, in the order written; none when it has no posts or its id is not valid. */
export function readForumPosts(id: string): ForumPost[] {
  try {
    return withVouchedPosts(id, readPosts(postsFile(id).file));
  } catch {
    return [];
  }
}

const stringList = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

export function summarizePost(forumId: string, p: ForumPost): ForumPostSummary {
  const re = stringList(p.re);
  return {
    id: p.id,
    ts: typeof p.ts === 'string' ? p.ts : '',
    from: p.from,
    authority: forumAuthority(forumId, p),
    tags: stringList(p.tags),
    to: stringList(p.to),
    title: p.title,
    ...(re.length ? { re } : {}),
    ...(typeof p.via === 'string' ? { via: p.via } : {}),
    ...(p.visibility === 'to' ? { visibility: 'to' as const } : {}),
  };
}

export function postDetail(forumId: string, p: ForumPost): ForumPostDetail {
  const direct = stringList(p.direct);
  return {
    ...summarizePost(forumId, p),
    body: typeof p.body === 'string' ? p.body : '',
    ...(p.score !== undefined ? { score: p.score } : {}),
    ...(direct.length ? { direct } : {}),
    ...(p.data && typeof p.data === 'object' && !Array.isArray(p.data) ? { data: p.data } : {}),
  };
}

/** A post-shaped value (what a writer returned), or undefined. */
export function asForumPost(v: unknown): ForumPost | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const p = v as Partial<ForumPost>;
  if (typeof p.id !== 'string' || typeof p.from !== 'string' || typeof p.title !== 'string') return undefined;
  return {
    ...p,
    id: p.id,
    from: p.from,
    title: p.title,
    ts: typeof p.ts === 'string' ? p.ts : '',
    body: typeof p.body === 'string' ? p.body : '',
    tags: stringList(p.tags),
    to: stringList(p.to),
    re: stringList(p.re),
  } as ForumPost;
}

/** The newest `limit` posts of a run's forum, and what the dashboard needs to follow it from there. */
export function forumListing(forum: RunForum, limit = FORUM_LIST_DEFAULT): ForumListing {
  const n = Number.isFinite(limit) ? Math.min(Math.max(Math.trunc(limit), 1), FORUM_LIST_MAX) : FORUM_LIST_DEFAULT;
  const posts = readForumPosts(forum.id);
  let last = 0;
  for (const p of posts) {
    const k = forumPostNumber(p.id);
    if (k > last) last = k;
  }
  return {
    id: forum.id,
    exposed: forum.exposed,
    total: posts.length,
    last: `p${String(last).padStart(5, '0')}`,
    posts: posts.slice(-n).map((p) => summarizePost(forum.id, p)),
  };
}

export interface ForumTailOptions {
  /**
   * Report the posts after this one (`p00012`) at once, then every new post.
   * Without it, or with an id that is not a post id, only posts written after
   * the tail starts are reported.
   */
  since?: string;
  intervalMs?: number;
}

/**
 * Report every new post of a forum to `onPost`, once each, in the order they
 * were written, until the returned function is called. A post is new when the
 * tail has not seen its id, so a line with an unusual id is still reported once,
 * and one the store and the spool both hold is not reported twice.
 */
export function tailForum(
  forumId: string,
  onPost: (post: ForumPostSummary) => void,
  opts: ForumTailOptions = {},
): () => void {
  const since = forumPostNumber(opts.since);
  const known = new Set<string>();
  let signature = '';
  let stopped = false;

  const emit = (p: ForumPost) => {
    known.add(p.id);
    try {
      onPost(summarizePost(forumId, p));
    } catch {
      // A broken listener must not stop the tail for the others it reports to.
    }
  };

  const look = (first: boolean) => {
    if (stopped) return;
    let current;
    try {
      current = postsFile(forumId);
    } catch {
      return;
    }
    if (!first && current.signature === signature) return;
    signature = current.signature;
    let posts: ForumPost[];
    try {
      posts = withVouchedPosts(forumId, readPosts(current.file));
    } catch {
      return;
    }
    for (const p of posts) {
      if (known.has(p.id)) continue;
      // At the start, what is already there is the past, unless it comes after `since`.
      if (first && !(forumPostNumber(p.id) > since)) known.add(p.id);
      else emit(p);
    }
  };

  look(true);
  const timer = setInterval(() => look(false), opts.intervalMs ?? FORUM_TAIL_MS);
  timer.unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
