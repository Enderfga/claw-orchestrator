/**
 * The hubs live in this process, by forum id. Kept apart from the hub itself so
 * the writers (`forumRuntimePost`) and readers (`forumTurnInbox`, the prune) can
 * reach a live hub without depending on the hub's module.
 */

import type { ForumDeliveryVia, ForumMemberInfo, ForumPost, ForumRender, ForumRouteOutcome } from './types.js';

export interface LiveForumHub {
  /** Route one post now; members that are not running are `unreached`. */
  routeNow(post: ForumPost): Promise<Record<string, ForumRouteOutcome>>;
  /** The mode's rendering of posts handed to members, when it has one. */
  readonly render?: ForumRender;
  /** What the hub knows of a member that is on it now. */
  memberInfo(name: string): ForumMemberInfo | undefined;
  /** Record that posts reached a member, so the hub does not push them again. */
  markDelivered(name: string, ids: string[], via: ForumDeliveryVia): void;
  /** Stop for good: no more copies, routing or records (the forum's run was deleted). */
  close(): void;
}

export const liveHubs = new Map<string, LiveForumHub>();
