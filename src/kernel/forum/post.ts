/**
 * Writing to a forum: an agent's post (its forum command, or a block in its
 * reply), and the runtime's post (`forumRuntimePost`), the only writer for the
 * reserved names and for posts made on an agent's behalf.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadRun } from '../store.js';
import { liveHubs } from './registry.js';
import {
  appendAuthored,
  appendLine,
  copySpoolToStore,
  ensureForumSpool,
  EVENTS,
  forumSpoolDir,
  forumTimestamp,
  isStandaloneForumId,
  nextPostId,
  normalizePost,
  oneLineTitle,
  POSTS,
  readJsonl,
  readPosts,
  readSpoolConfig,
  validForumName,
  withForumLock,
  type SpoolConfig,
} from './store.js';
import {
  FORUM_TAGS,
  isReservedForumName,
  MAX_BODY_CHARS,
  MAX_SCORE_CHARS,
  MAX_SCORE_FILE_BYTES,
  MAX_TITLE_CHARS,
  normalizeForumConfig,
  parseMentions,
  parseRefs,
  parseTags,
  type ForumEvent,
  type ForumMember,
  type ForumPost,
  type ForumRouteOutcome,
  type ForumScoreSource,
  type ForumVia,
} from './types.js';
import { memberStates } from './view.js';

function readScore(source: ForumScoreSource | undefined, cwd: string): unknown {
  if (!source) return undefined;
  let text: string | undefined;
  try {
    if (source.file) {
      const file = path.resolve(cwd, source.file);
      const size = fs.statSync(file).size;
      if (size > MAX_SCORE_FILE_BYTES) return { error: `score unavailable: ${file} is ${size} bytes` };
      text = fs.readFileSync(file, 'utf8');
    } else if (source.command) {
      const [cmd, ...args] = source.command;
      text = execFileSync(cmd, args, {
        cwd,
        encoding: 'utf8',
        timeout: source.timeoutMs ?? 30_000,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    }
  } catch (err) {
    return { error: `score unavailable: ${(err as Error).message.split('\n')[0].slice(0, 200)}` };
  }
  if (text === undefined) return undefined;
  // Parsed whole, then picked and bounded: cutting the text first turned any
  // score past the bound into hundreds of lines of broken JSON on every post.
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    value = text.trim();
  }
  if (source.pick && value && typeof value === 'object' && !Array.isArray(value)) {
    const picked: Record<string, unknown> = {};
    for (const key of source.pick) {
      let v: unknown = value;
      for (const part of key.split('.'))
        v = v && typeof v === 'object' ? (v as Record<string, unknown>)[part] : undefined;
      if (v !== undefined) picked[key] = v;
    }
    value = picked;
  }
  const compact = typeof value === 'string' ? value : JSON.stringify(value);
  if (compact.length <= MAX_SCORE_CHARS) return value;
  return `${compact.slice(0, MAX_SCORE_CHARS - 1)}…`;
}

/**
 * The names a text addresses: members, and the reserved addressees. Only those:
 * `@0.88` in a body is a number, not a recipient, and counting it made a post
 * look undelivered.
 */
function addressees(text: string, as: string, team: ForumMember[] | undefined): string[] {
  const named = parseMentions(text).filter((n) => n !== as);
  return team ? named.filter((n) => isReservedForumName(n) || team.some((m) => m.name === n)) : named;
}

/** Explicit recipients, each a member or a reserved addressee. */
function checkedRecipients(names: string[] | undefined, config: SpoolConfig): string[] {
  const out: string[] = [];
  for (const n of names ?? []) {
    const known =
      isReservedForumName(n) || (config.team ? config.team.some((m) => m.name === n) : validForumName(config, n));
    if (!known) throw new Error(`${JSON.stringify(n)} is not on this forum`);
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

/** The directory `as` last joined the forum from: where its score is. */
function joinedCwd(dir: string, as: string): string | undefined {
  const events = readJsonl<ForumEvent>(path.join(dir, EVENTS));
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === 'join' && e.who === as) return e.cwd;
  }
  return undefined;
}

/**
 * An agent's post, from its forum command or (`via: 'reply'`) a block in its
 * reply. The reserved names are not an agent's to post under.
 */
export function forumPost(
  dir: string,
  as: string,
  input: { title: string; body?: string; re?: string[]; cwd?: string; via?: 'reply'; direct?: string[] },
): ForumPost {
  if (isReservedForumName(as)) throw new Error(`"${as}" is reserved for the orchestrator`);
  const config = readSpoolConfig(dir);
  if (!validForumName(config, as)) throw new Error(`Invalid forum name ${JSON.stringify(as)}`);
  const title = input.title.replace(/[\s\p{Cc}]+/gu, ' ').trim();
  if (!title) throw new Error('A post needs a title');
  if (title.length > MAX_TITLE_CHARS) throw new Error(`A title is at most ${MAX_TITLE_CHARS} characters`);
  const body = (input.body ?? '').trimEnd();
  if (body.length > MAX_BODY_CHARS) throw new Error(`A body is at most ${MAX_BODY_CHARS} characters`);
  const direct = checkedRecipients(input.direct, config).filter((n) => n !== as);
  const score = readScore(config.score, joinedCwd(dir, as) ?? input.cwd ?? process.cwd());
  const text = `${title}\n${body}`;
  return withForumLock(dir, () => {
    const posts = readPosts(path.join(dir, POSTS));
    const id = nextPostId(posts);
    const re = [...new Set([...(input.re ?? []), ...parseRefs(text)])].filter((r) => r !== id);
    const named = addressees(text, as, config.team);
    const post: ForumPost = {
      id,
      ts: new Date().toISOString(),
      from: as,
      title,
      body,
      tags: parseTags(title),
      to: [...new Set([...direct, ...named])],
      re,
      ...(score === undefined ? {} : { score }),
      ...(input.via ? { via: input.via } : {}),
      ...(direct.length ? { direct } : {}),
    };
    appendLine(path.join(dir, POSTS), post);
    return post;
  });
}

/**
 * What a poster should know about a post it just made: that it has no tag, or
 * that an agent it names will not see it in time, or ever.
 */
export function forumPostNotes(dir: string, post: ForumPost): string[] {
  const config = readSpoolConfig(dir);
  const notes: string[] = [];
  if (post.tags.length === 0) {
    notes.push(
      `This post has no tag. Start a title with ${FORUM_TAGS.slice(0, -1).join(', ')} or ${FORUM_TAGS.at(-1)}; ` +
        'an ASK or FAIL reaches the agent it names only when its title starts with that tag.',
    );
  }
  const team = config.team;
  if (!team) return notes;
  // A name that is not on the forum is not an addressee; one that looks like a
  // name (not `@0.88`) gets a note, since it was probably meant as one.
  for (const name of parseMentions(`${post.title}\n${post.body}`)) {
    if (
      name !== post.from &&
      /[A-Za-z]/.test(name) &&
      !isReservedForumName(name) &&
      !team.some((m) => m.name === name)
    ) {
      notes.push(
        `@${name} is not on this forum, so nobody was addressed by it; its members are ${team.map((m) => m.name).join(', ')}.`,
      );
    }
  }
  const states = memberStates(readJsonl<ForumEvent>(path.join(dir, EVENTS)));
  for (const name of post.to) {
    const member = team.find((m) => m.name === name);
    if (!member) continue;
    const state = states.get(name);
    if (state === 'finished') {
      notes.push(
        member.mayReturn
          ? `@${name} has finished; it sees this only if the run comes back to it.`
          : `@${name} has finished and does not run again in this run: nobody will answer this as @${name}.`,
      );
    } else if (!state) {
      notes.push(`@${name} has not started; this post will be in its brief when it starts.`);
    }
  }
  return notes;
}

// ─── The runtime's posts ────────────────────────────────────────────────────

export interface ForumRuntimePostInput {
  /** `user`, `orchestrator`, or the agent the post is made for (a relayed round report, an envelope, a handover). */
  from: string;
  title: string;
  body?: string;
  /** Members (or reserved addressees) it is to, in addition to the `@name`s in its text. */
  to?: string[];
  /** Explicit recipients: pushed to whatever the tag and their push rule. Added to `to`. */
  direct?: string[];
  re?: string[];
  /** Default `runtime`. */
  via?: ForumVia;
  visibility?: 'to';
  data?: Record<string, unknown>;
  /** Where the whole text is, named at the end of a body cut to fit. */
  fullPath?: string;
  /**
   * `false`: the `@name`s in the text address nobody; only `to` and `direct` do.
   * For text the poster did not write to anyone, such as an agent's output or a
   * check's log, quoted in a handover or a verdict.
   */
  mentions?: boolean;
}

/** A forum's spool, made ready for the runtime: a run's with the config its spec gives it; a forum with no run must exist. */
function runtimeSpool(id: string): string {
  if (isStandaloneForumId(id)) return ensureForumSpool(id, {});
  let spec;
  try {
    spec = loadRun(id)?.spec;
  } catch {
    spec = undefined;
  }
  if (!spec) throw new Error(`No run '${id}' to post to`);
  return ensureForumSpool(id, (spec.forum ? normalizeForumConfig(spec.forum) : undefined) ?? {});
}

function cutBody(raw: string, fullPath: string | undefined): string {
  const body = raw.trimEnd();
  if (body.length <= MAX_BODY_CHARS) return body;
  const tail = fullPath ? `\n[… cut; the whole text is at ${fullPath}]` : '\n[… cut]';
  return body.slice(0, MAX_BODY_CHARS - tail.length) + tail;
}

/** A runtime post as written: the post, the notes a poster gets, and the routing a live hub has started. */
export interface ForumRuntimeWrite {
  post: ForumPost;
  notes: string[];
  /** What the live hub's routing did for each recipient; undefined with no hub live in this process. */
  routed: Promise<Record<string, ForumRouteOutcome> | undefined>;
}

/**
 * Write a runtime post now, synchronously: the id and the stored post are known
 * when this returns, and a live hub has begun routing it (`routed`). For a
 * caller that cannot wait, such as a steer recorded with its post id; anyone
 * else uses `forumRuntimePost`.
 */
export function forumRuntimeAppend(id: string, input: ForumRuntimePostInput): ForumRuntimeWrite {
  const dir = runtimeSpool(id);
  const config = readSpoolConfig(dir);
  const reserved = isReservedForumName(input.from);
  if (!reserved && !validForumName(config, input.from)) {
    throw new Error(`Invalid forum name ${JSON.stringify(input.from)}`);
  }
  const title = oneLineTitle(input.title);
  if (!title) throw new Error('A post needs a title');
  const body = cutBody(input.body ?? '', input.fullPath);
  const direct = checkedRecipients(input.direct, config).filter((n) => n !== input.from);
  const to = checkedRecipients(input.to, config).filter((n) => n !== input.from);
  const text = `${title}\n${body}`;
  const post = withForumLock(dir, () => {
    const posts = readPosts(path.join(dir, POSTS));
    const postId = nextPostId(posts);
    const re = [...new Set([...(input.re ?? []), ...parseRefs(text)])].filter((r) => r !== postId);
    // As every reader will read it (a reference that is not a post id dropped),
    // so the post read back is the one vouched for, and the one routed now.
    const p = normalizePost({
      id: postId,
      ts: forumTimestamp(),
      from: input.from,
      title,
      body,
      tags: parseTags(title),
      to: [
        ...new Set([...direct, ...to, ...(input.mentions === false ? [] : addressees(text, input.from, config.team))]),
      ],
      re,
      via: input.via ?? 'runtime',
      ...(direct.length ? { direct } : {}),
      ...(input.visibility ? { visibility: input.visibility } : {}),
      ...(input.data ? { data: input.data } : {}),
    } satisfies ForumPost);
    if (!p) throw new Error(`Invalid forum name ${JSON.stringify(input.from)}`);
    // Every post the runtime writes is vouched for, whoever it is from, so a
    // line an agent wrote into the spool is never taken for one of them. The
    // ledger before the line: a hub that reads the line finds it vouched for.
    appendAuthored(id, p);
    appendLine(path.join(dir, POSTS), p);
    // Stored before this returns, under the same hold of the lock.
    copySpoolToStore(id);
    return p;
  });
  // The hub marks the post routed before its first await, so a sync cannot route it again.
  const hub = liveHubs.get(id);
  const routed = hub ? hub.routeNow(post).catch(() => undefined) : Promise.resolve(undefined);
  return { post, notes: forumPostNotes(dir, post), routed };
}

/**
 * Post for the runtime: as the user, as the orchestrator, or for an agent. A
 * title past the limit is cut with `…` and a body ends with where the whole text
 * is; no score is attached. The post goes in the forum's authored ledger first:
 * that is what makes a post under a reserved name the user's or the
 * orchestrator's, and any post one the runtime wrote (`isVouched`). It is in
 * the store before this returns, and a hub live in this process has routed it
 * (`routed`: what that did for each recipient).
 */
export async function forumRuntimePost(
  id: string,
  input: ForumRuntimePostInput,
): Promise<{ post: ForumPost; notes: string[]; routed?: Record<string, ForumRouteOutcome> }> {
  const write = forumRuntimeAppend(id, input);
  const routed = await write.routed;
  return { post: write.post, notes: write.notes, ...(routed ? { routed } : {}) };
}

// ─── Posting by reply ───────────────────────────────────────────────────────
//
// An agent that cannot run the forum command — a read-only session, an engine
// with no shell — posts by writing a block in its reply, and the orchestrator,
// which sees the reply, posts it under the agent's name. Any agent may do it.
// The tag differs from the `<forum-post>` a push is wrapped in, so an agent
// quoting a post it was handed does not post it again.

const NEW_POST_RE = /<new-forum-post\b([^>]*)>([\s\S]*?)<\/new-forum-post>/gi;
const NEW_POST_END = /<\/new-forum-post>/i;

function attr(attrs: string, name: string): string | undefined {
  const m = attrs.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i'));
  return m ? (m[1] ?? m[2]) : undefined;
}

/** A post written as a block in a reply. */
export interface ReplyBlock {
  title: string;
  body: string;
  re: string[];
}

/** The posts written as `<new-forum-post title="…" re="p00012">body</new-forum-post>` blocks in `text`. */
export function postsInReply(text: string): ReplyBlock[] {
  const out: ReplyBlock[] = [];
  for (const m of text.matchAll(NEW_POST_RE)) {
    let body = m[2].trim();
    let title = (attr(m[1], 'title') ?? '').replace(/\s+/g, ' ').trim();
    if (!title) {
      // No title attribute: the first line is the title.
      const nl = body.indexOf('\n');
      title = (nl < 0 ? body : body.slice(0, nl)).replace(/\s+/g, ' ').trim();
      body = nl < 0 ? '' : body.slice(nl + 1).trim();
    }
    if (!title) continue;
    if (title.length > MAX_TITLE_CHARS) title = `${title.slice(0, MAX_TITLE_CHARS - 1)}…`;
    if (body.length > MAX_BODY_CHARS) body = body.slice(0, MAX_BODY_CHARS);
    const re = (attr(m[1], 're') ?? '').split(/[\s,]+/).filter((r) => /^p\d{5,}$/.test(r));
    out.push({ title, body, re });
  }
  return out;
}

/**
 * Posts one agent's reply blocks. `take` is given the reply so far — streamed
 * text as it grows, or the turn's whole reply — and posts each complete block
 * once. A mode that posts reply blocks its own way (the session forum posts
 * them as direct messages) passes `post`.
 */
export class ForumReplyRelay {
  private readonly done = new Set<string>();

  constructor(
    readonly runId: string,
    readonly as: string,
    private readonly logger?: { warn?(msg: string): void },
    private readonly opts: { post?: (p: ReplyBlock) => ForumPost | undefined } = {},
  ) {
    if (isReservedForumName(as)) throw new Error(`"${as}" is reserved for the orchestrator`);
  }

  take(text: string): ForumPost[] {
    if (!text || !NEW_POST_END.test(text)) return [];
    const posted: ForumPost[] = [];
    for (const p of postsInReply(text)) {
      const key = `${p.title}\n${p.body}\n${p.re.join(' ')}`;
      if (this.done.has(key)) continue;
      this.done.add(key);
      try {
        const post = this.opts.post
          ? this.opts.post(p)
          : forumPost(forumSpoolDir(this.runId), this.as, { ...p, via: 'reply' });
        if (post) posted.push(post);
      } catch (err) {
        this.logger?.warn?.(`[forum ${this.runId}] could not post ${this.as}'s reply block: ${(err as Error).message}`);
      }
    }
    return posted;
  }
}
