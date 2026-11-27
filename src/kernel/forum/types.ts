/**
 * The forum's shapes and the rules read from a post's text: its config, its
 * names, its tags, the members it addresses, the posts it refers to.
 */

// ─── Shapes ─────────────────────────────────────────────────────────────────

export type ForumPushMode = 'mentions' | 'all' | 'digest' | 'none';

export interface ForumScoreSource {
  /**
   * A file, relative to the directory the posting agent works in (its node's
   * `cwd`, not its shell's), attached as JSON when it parses and as text otherwise.
   */
  file?: string;
  /** A command (argv), run in that directory; its stdout is attached the same way. */
  command?: string[];
  /** Bound on `command`. Default 30s. */
  timeoutMs?: number;
  /**
   * The fields of a JSON score to attach (`ok`, `summary.passed`), instead of
   * all of it. Every reader of a post pays for its score.
   */
  pick?: string[];
}

export interface ForumConfig {
  /**
   * What reaches an agent without it reading. `mentions` (default): an ASK or
   * FAIL that names it with `@name`. `all`: every post by someone else. `digest`:
   * those mentions at once, and the titles of everything else every `digestMs`.
   * `none`: nothing; agents read for themselves.
   */
  push?: ForumPushMode;
  /** Interval of the `digest` push. Default 60s. */
  digestMs?: number;
  /** Attach the posting agent's current score to each post. */
  score?: ForumScoreSource;
}

/** How a run that is not the forum's owner (a fan-out goal agent's or a subflow's child run) reaches it. */
export interface ForumBinding {
  /** The run that owns the forum. */
  runId: string;
  /** This run's agent name on it. */
  agent: string;
  /**
   * Put in front of each of this run's member names (a subflow's child run binds
   * with `<subflowId>.`), for a run with more than one agent.
   */
  prefix?: string;
}

/**
 * The names an agent cannot post under. `user` is the person who started the
 * run, `orchestrator` is clawo's runtime or the tool caller acting for it. Both
 * are valid addressees (`ASK @user`), though neither is a member.
 */
export const RESERVED_FORUM_NAMES = ['user', 'orchestrator'] as const;
export type ReservedForumName = (typeof RESERVED_FORUM_NAMES)[number];

/** Who a post speaks for, as verified against the forum's authored ledger, never as the post line says. */
export type ForumAuthority = 'agent' | 'orchestrator' | 'user';

/**
 * How a post got onto the forum. Absent: the agent's own forum command.
 * `reply`: a block in its reply, posted for it. `round`: a council seat's round
 * report. `envelope`: an autoloop message mirrored for its sender. `output`: a
 * node's handover. `runtime`: any other post the runtime wrote.
 */
export type ForumVia = 'reply' | 'round' | 'envelope' | 'output' | 'runtime';

export interface ForumPost {
  id: string;
  ts: string;
  from: string;
  title: string;
  body: string;
  /** Leading ALLCAPS words of the title (`WIN`, `FAIL`, `ASK`, …). */
  tags: string[];
  /**
   * Who it addresses: the explicit recipients (`direct`) and the `@name`s in the
   * title or body that are on the forum (all of them when the team is not
   * known). `user` and `orchestrator` count as addressees.
   */
  to: string[];
  /** Post ids it refers to, from `--re` or `p00012` in the text. */
  re: string[];
  score?: unknown;
  via?: ForumVia;
  /** Recipients the poster named explicitly rather than in the text. Always pushed to. */
  direct?: string[];
  /** `to`: only its author and the members in `to` see it. */
  visibility?: 'to';
  /** A mode's machine payload. Never rendered to an agent in full. */
  data?: Record<string, unknown>;
}

/**
 * How a post reached a member. `push`: mid-turn. `digest`: its title, in a
 * digest. `brief`: listed in the brief the agent read when it joined (the title,
 * as a digest gives it). `cli`: shown in full at the top of the agent's next
 * forum command, for an engine that takes nothing mid-turn. `turn`: handed to it
 * as (part of) a turn prompt.
 */
export type ForumDeliveryVia = 'push' | 'digest' | 'brief' | 'cli' | 'turn';

export type ForumEvent =
  | { ts: string; type: 'read'; who: string; id: string }
  | { ts: string; type: 'list'; who: string }
  | { ts: string; type: 'delivered'; who: string; id: string; via: ForumDeliveryVia }
  /**
   * `cwd`: the directory the agent works in, where its score is read. `push` and
   * `canRead`: the member's own push rule and whether it reads the forum, when
   * they differ from the forum's, so its forum command follows the same rules
   * as the hub.
   */
  | { ts: string; type: 'join'; who: string; cwd?: string; push?: ForumPushMode; canRead?: boolean }
  /** `expire`: the member's posts so far are behind it; what it has not seen of them is no longer unread. */
  | { ts: string; type: 'leave'; who: string; expire?: boolean };

/** The tags a title can start with. Anything else counts as `OTHER`. */
export const FORUM_TAGS = ['WIN', 'FAIL', 'ASK', 'FIX', 'DONE', 'INFO'] as const;

/** One name on a run's forum, and whether its node can run again once it has finished. */
export interface ForumMember {
  name: string;
  node: string;
  /** The node is on a loop of the workflow: the run can come back to it. */
  mayReturn: boolean;
}

/**
 * How the hub reaches a member mid-work. `true`: handed over. `false`: not now
 * (the post stays unread). `'queued'`: accepted, not yet in a turn — the hub
 * records nothing, and the member's owner calls `markDelivered` when it is.
 */
export type Deliver = (text: string, ids: string[]) => boolean | 'queued' | Promise<boolean | 'queued'>;

/** What a hub knows of a member, for a mode's own rendering. */
export interface ForumMemberInfo {
  readOnly: boolean;
  canRead: boolean;
  push: ForumPushMode;
}

/** A mode's rendering of a post handed to a member, in place of `formatPush`. */
export type ForumRender = (post: ForumPost, recipient: string, member: ForumMemberInfo) => string;

/** What routing one post did for each member it was for. */
export type ForumRouteOutcome = 'delivered' | 'queued' | 'unreached';

// ─── Limits (shared by the forum's modules, not exported from the forum) ────

export const PUSH_MODES: readonly ForumPushMode[] = ['mentions', 'all', 'digest', 'none'];
export const MENTION_PUSH_TAGS = new Set(['ASK', 'FAIL']);
export const MAX_TITLE_CHARS = 120;
export const MAX_BODY_CHARS = 64_000;
export const MAX_SCORE_CHARS = 2_000;
/** What `read` and a push show of a score; the post keeps up to MAX_SCORE_CHARS. */
export const SHOWN_SCORE_CHARS = 300;
/** A score file larger than this is not read. */
export const MAX_SCORE_FILE_BYTES = 4 * 1024 * 1024;
export const KNOWN_TAGS = new Set<string>(FORUM_TAGS);
/** What a push carries of the body; the rest is a `read` away. */
export const PUSH_BODY_CHARS = 1_500;
export const DEFAULT_DIGEST_MS = 60_000;
export const SYNC_EVERY_MS = 1_000;
/** Posts shown in full at the top of a forum command, and in a read-only brief. */
export const INBOX_FULL_POSTS = 5;
const NAME_RE = /^[A-Za-z0-9][\w.-]{0,63}$/;

// ─── Config and names ───────────────────────────────────────────────────────

/** `true` or a config object; anything else malformed is refused, so a typo does not silently turn the forum off. */
export function normalizeForumConfig(raw: unknown, where = 'forum'): ForumConfig | undefined {
  if (raw === undefined || raw === null || raw === false) return undefined;
  if (raw === true) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${where} must be true or an object`);
  const r = raw as Record<string, unknown>;
  const out: ForumConfig = {};
  if (r.push !== undefined) {
    if (!PUSH_MODES.includes(r.push as ForumPushMode)) {
      throw new Error(`${where}.push must be one of ${PUSH_MODES.join(', ')}`);
    }
    out.push = r.push as ForumPushMode;
  }
  if (r.digestMs !== undefined) {
    if (typeof r.digestMs !== 'number' || !Number.isFinite(r.digestMs) || r.digestMs < 1_000) {
      throw new Error(`${where}.digestMs must be a number of milliseconds, at least 1000`);
    }
    out.digestMs = r.digestMs;
  }
  if (r.score !== undefined) {
    const s = r.score as Record<string, unknown>;
    if (!s || typeof s !== 'object' || Array.isArray(s)) throw new Error(`${where}.score must be an object`);
    const score: ForumScoreSource = {};
    if (s.file !== undefined) {
      if (typeof s.file !== 'string' || !s.file.trim()) throw new Error(`${where}.score.file must be a path`);
      score.file = s.file;
    }
    if (s.command !== undefined) {
      if (!Array.isArray(s.command) || s.command.length === 0 || !s.command.every((x) => typeof x === 'string')) {
        throw new Error(`${where}.score.command must be a non-empty argv array of strings`);
      }
      score.command = s.command as string[];
    }
    if (s.timeoutMs !== undefined) {
      if (typeof s.timeoutMs !== 'number' || !(s.timeoutMs > 0)) {
        throw new Error(`${where}.score.timeoutMs must be a positive number`);
      }
      score.timeoutMs = s.timeoutMs;
    }
    if (s.pick !== undefined) {
      if (
        !Array.isArray(s.pick) ||
        s.pick.length === 0 ||
        !s.pick.every((x) => typeof x === 'string' && x.trim() !== '')
      ) {
        throw new Error(`${where}.score.pick must be a non-empty array of field names`);
      }
      score.pick = s.pick as string[];
    }
    if (!score.file && !score.command) throw new Error(`${where}.score needs a file or a command`);
    out.score = score;
  }
  return out;
}

export function isForumName(name: string): boolean {
  return NAME_RE.test(name);
}

export function isReservedForumName(name: string): name is ReservedForumName {
  return (RESERVED_FORUM_NAMES as readonly string[]).includes(name);
}

/** A name on a forum created with `looseNames` (session names): 1–128 characters, no control characters. */
export function isLooseForumName(name: string): boolean {
  // eslint-disable-next-line no-control-regex
  return typeof name === 'string' && name.length >= 1 && name.length <= 128 && !/[\u0000-\u001f\u007f]/.test(name);
}

// ─── Parsing ────────────────────────────────────────────────────────────────

/**
 * The forum tags among the leading ALLCAPS words of a title: `FAIL: …`,
 * `[ASK] …`, `WIN FIX …`. Other leading capitals, such as a room code in
 * `R1 FAIL: …`, are passed over rather than taken for tags.
 */
export function parseTags(title: string): string[] {
  const tags: string[] = [];
  let rest = title;
  for (;;) {
    const m = /^\s*\[?([A-Z][A-Z0-9_]{1,15})\]?(?=[:\s\-—]|$)[:\s\-—]*/.exec(rest);
    if (!m) break;
    if (KNOWN_TAGS.has(m[1]) && !tags.includes(m[1])) tags.push(m[1]);
    rest = rest.slice(m[0].length);
  }
  return tags;
}

export function parseMentions(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/(?:^|[^\w@])@([A-Za-z0-9][\w.-]{0,63})/g)) out.add(m[1].replace(/[.-]+$/, ''));
  return [...out];
}

export function parseRefs(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\bp(\d{5,})\b/g)) out.add(`p${m[1]}`);
  return [...out];
}
