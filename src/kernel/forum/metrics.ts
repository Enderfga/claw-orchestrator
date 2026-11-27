/** How a forum was used: who posted and read what, how ASKs were answered, and whether named agents saw their posts. */

import { viewOf } from './store.js';
import { isReservedForumName, KNOWN_TAGS, type ForumEvent, type ForumPost } from './types.js';
import { answers, forumTeamOf } from './view.js';

export interface ForumMetrics {
  /** Agents' posts: by their own forum command or a block in their reply. */
  posts: number;
  byTag: Record<string, number>;
  agents: Record<
    string,
    { posts: number; reads: number; lists: number; readsOfTheirPosts: number; firstPostAt?: string }
  >;
  /**
   * Every other post: the user's, the orchestrator's, and those the runtime made
   * for an agent (a round report, an envelope, a handover), by `via` and author.
   */
  runtime: { posts: number; byVia: Record<string, number>; byAuthor: Record<string, number> };
  /** Every ASK: when it was answered (a later post by someone else that refers to it), and how long that took. */
  asks: Array<{
    id: string;
    from: string;
    to: string[];
    at: string;
    answeredBy?: string;
    answerId?: string;
    latencyMs?: number;
  }>;
  openAsks: string[];
  /**
   * Every post that names someone: when each named agent first saw it, pushed
   * into its work or read by it, and how long after the post that was.
   */
  mentions: Array<{
    id: string;
    from: string;
    to: string;
    at: string;
    seenAt?: string;
    /**
     * `brief`: in the brief it read when it started, which lists the posts that
     * name it. `cli`: at the top of its next forum command, for an engine that
     * takes nothing mid-turn. `turn`: handed to it with a turn.
     */
    via?: 'push' | 'digest' | 'brief' | 'cli' | 'turn' | 'read';
    latencyMs?: number;
    /**
     * Set when the named agent never saw it and an agent that started after the
     * post did instead — in its brief, or by reading it. A FAIL addressed to a
     * fan-out agent that had finished reaches the node after it this way.
     */
    handedTo?: { who: string; via: 'brief' | 'read'; at: string };
  }>;
  /** Mentions that nobody saw: not the named agent, and no agent that started after the post. */
  unseenMentions: number;
  /** Mentions that the named agent never saw, but a later agent did (`handedTo`). */
  handedMentions: number;
}

/** A post an agent made itself: its forum command, or a block in its reply. */
function isAgentPost(p: ForumPost): boolean {
  return (!p.via || p.via === 'reply') && !isReservedForumName(p.from);
}

export function forumMetrics(runId: string): ForumMetrics {
  const view = viewOf(runId);
  const agents: ForumMetrics['agents'] = {};
  const agent = (n: string) => (agents[n] ??= { posts: 0, reads: 0, lists: 0, readsOfTheirPosts: 0 });
  const byTag: Record<string, number> = {};
  const runtime: ForumMetrics['runtime'] = { posts: 0, byVia: {}, byAuthor: {} };
  const byId = new Map(view.posts.map((p) => [p.id, p]));
  let posts = 0;
  for (const p of view.posts) {
    if (!isAgentPost(p)) {
      runtime.posts++;
      const via = p.via ?? 'none';
      runtime.byVia[via] = (runtime.byVia[via] ?? 0) + 1;
      runtime.byAuthor[p.from] = (runtime.byAuthor[p.from] ?? 0) + 1;
      continue;
    }
    posts++;
    const a = agent(p.from);
    a.posts++;
    if (!a.firstPostAt || p.ts < a.firstPostAt) a.firstPostAt = p.ts;
    // Posts from before the tags were closed can carry others; they count as OTHER too.
    const tags = p.tags.filter((t) => KNOWN_TAGS.has(t));
    if (tags.length === 0) byTag.OTHER = (byTag.OTHER ?? 0) + 1;
    for (const t of tags) byTag[t] = (byTag[t] ?? 0) + 1;
  }
  for (const e of view.events) {
    if (e.type === 'read') {
      agent(e.who).reads++;
      const p = byId.get(e.id);
      if (p && p.from !== e.who && isAgentPost(p)) agent(p.from).readsOfTheirPosts++;
    } else if (e.type === 'list') agent(e.who).lists++;
  }
  const ms = (a: string, b: string) => Date.parse(b) - Date.parse(a);
  const asks: ForumMetrics['asks'] = view.posts
    .filter((p) => p.tags.includes('ASK'))
    .map((p) => {
      const ans = answers(view, p);
      return {
        id: p.id,
        from: p.from,
        to: p.to,
        at: p.ts,
        ...(ans ? { answeredBy: ans.from, answerId: ans.id, latencyMs: ms(p.ts, ans.ts) } : {}),
      };
    });
  // Posts written before only members were addressees can name anything; the
  // team, when it is known, keeps a number after @ out of the counts.
  const teamList = forumTeamOf(runId);
  const team = teamList.length ? new Set(teamList) : undefined;
  const byTime = (a: { ts: string }, b: { ts: string }) => (a.ts < b.ts ? -1 : 1);
  const seen = view.events
    .filter((e): e is Extract<ForumEvent, { id: string }> => e.type === 'read' || e.type === 'delivered')
    .sort(byTime);
  const joins = view.events.filter((e) => e.type === 'join');
  const mentions: ForumMetrics['mentions'] = [];
  for (const p of view.posts) {
    for (const to of p.to) {
      if (isReservedForumName(to) || (team && !team.has(to))) continue;
      const first = seen.find((e) => e.who === to && e.id === p.id);
      // Otherwise: an agent that started after the post and had it in its brief, or read it.
      const handed = first
        ? undefined
        : seen.find(
            (e) =>
              e.id === p.id &&
              e.who !== to &&
              e.who !== p.from &&
              e.ts >= p.ts &&
              // A brief is written as an agent starts, so one that lists the post is a later
              // agent's; a read counts when its reader joined after the post.
              (e.type === 'delivered'
                ? e.via === 'brief'
                : joins.some((j) => j.who === e.who && j.ts >= p.ts && j.ts <= e.ts)),
          );
      mentions.push({
        id: p.id,
        from: p.from,
        to,
        at: p.ts,
        ...(first
          ? { seenAt: first.ts, via: first.type === 'read' ? 'read' : first.via, latencyMs: ms(p.ts, first.ts) }
          : {}),
        ...(handed
          ? { handedTo: { who: handed.who, via: handed.type === 'read' ? 'read' : 'brief', at: handed.ts } }
          : {}),
      });
    }
  }
  return {
    posts,
    byTag,
    agents,
    runtime,
    asks,
    openAsks: asks.filter((a) => !a.answerId).map((a) => a.id),
    mentions,
    unseenMentions: mentions.filter((m) => !m.seenAt && !m.handedTo).length,
    handedMentions: mentions.filter((m) => !m.seenAt && m.handedTo).length,
  };
}
