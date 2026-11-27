/**
 * The forum — a board of titled posts that the participants of a run share:
 * its agents, the orchestrator (clawo's runtime and the tool caller), and the
 * user. It is the transport and the record of what they say to each other.
 *
 * Shaped after the forum in "Test-Time Compute Scales Better with Parallel
 * Agent Teams" (arXiv 2611.09798): a post has a title and a body, the agent's
 * current score is attached to it automatically, `list` shows the titles with
 * the unread ones marked NEW, and `read` shows one post in full. Agents reach it
 * through a CLI (`clawo forum`), so any engine that can run a shell command can
 * post and read, and every read is on record. That paper's forum pushes nothing;
 * reading is the agent's own choice. Here push is a setting, and the default
 * pushes only what is addressed to an agent and asks something of it — an ASK
 * or FAIL that names it with `@name` — because a team that divides the work
 * (each agent its own part) needs a finding about a part to reach that part,
 * where the paper's teams all worked the same problem. The other settings
 * (`all`, `digest`, `none`) are there to be compared against it.
 *
 * Every kernel run has a forum log; `spec.forum` (or a binding to another run's
 * forum) exposes it to the run's agents. A forum with no run (`fm-…`) carries
 * messages between plain sessions.
 *
 * Two places hold the posts:
 *   - the spool, `<tmp>/clawo-forum/<id>/`, which the agents' CLI reads and
 *     writes. It lives in the temp directory because that is the one place every
 *     engine's sandbox lets a session write outside its workspace.
 *   - the store, `<run>/forum/` (or `<clawo home>/forums/<id>/`), the record
 *     that survives the process and a reboot. The runtime's own posts are stored
 *     as they are written; the hub copies the rest every second while the forum
 *     has members. A run's spool is removed when the run ends and put back from
 *     the store when it is needed again.
 *
 * Every post the runtime writes is in the store's authored ledger, which the
 * runtime alone writes (`isVouched`). A post under `user` or `orchestrator`
 * speaks for them only when the ledger vouches for it; framing and routing
 * follow that, never the post's own `from`. Whether a member has had such a
 * post is read from the runtime's own record of what it handed over
 * (`forumRuntimeEvents`, also in the store), never from the spool's events.
 *
 * Push goes through the delivery each member registers when it joins: the turn
 * in flight for a goal or a session that accepts mid-turn input, nothing for a
 * one-shot engine between turns. A post addressed to a member that has left
 * stays open and is listed in the brief of the next agent that joins.
 */

export {
  FORUM_TAGS,
  RESERVED_FORUM_NAMES,
  isForumName,
  isLooseForumName,
  isReservedForumName,
  normalizeForumConfig,
  parseMentions,
  parseRefs,
  parseTags,
  type Deliver,
  type ForumAuthority,
  type ForumBinding,
  type ForumConfig,
  type ForumDeliveryVia,
  type ForumEvent,
  type ForumMember,
  type ForumMemberInfo,
  type ForumPost,
  type ForumPushMode,
  type ForumRender,
  type ForumRouteOutcome,
  type ForumScoreSource,
  type ForumVia,
  type ReservedForumName,
} from './types.js';
export {
  createForum,
  discardForum,
  ensureForumSpool,
  forumLocation,
  forumRuntimeEvents,
  forumSpoolDir,
  forumStoreDir,
  isStandaloneForumId,
  pruneForumSpools,
  retireForumSpool,
  syncForumStore,
} from './store.js';
export {
  AUTOLOOP_FORUM_ROLES,
  autoloopForumName,
  fixerForumName,
  forumRoster,
  forumTeam,
  memberNameFor,
  resolveForum,
  runForum,
  subflowForumPrefix,
  synthesisForumName,
  type AutoloopForumRole,
  type ForumRosterOptions,
  type RunForum,
} from './roster.js';
export {
  addressedTo,
  forumAuthority,
  forumPosts,
  forumSnapshot,
  forumTeamOf,
  hadBy,
  isVouched,
  openAsks,
  openAsksOf,
  unreadFor,
  type ForumPostsQuery,
} from './view.js';
export {
  FORUM_FRAMING,
  authorLabel,
  fenceForumText,
  forumCommand,
  formatPost,
  formatPush,
  postLine,
} from './render.js';
export {
  ForumReplyRelay,
  forumPost,
  forumPostNotes,
  forumRuntimeAppend,
  forumRuntimePost,
  postsInReply,
  type ForumRuntimePostInput,
  type ForumRuntimeWrite,
  type ReplyBlock,
} from './post.js';
export { forumInbox, forumList, forumRead } from './read.js';
export { forumBrief, forumMarkDelivered, forumTurnInbox, type ForumBriefOptions } from './brief.js';
export { ForumHub, forumHub, onForum, type ForumJoinOptions } from './hub.js';
export { forumMetrics, type ForumMetrics } from './metrics.js';
