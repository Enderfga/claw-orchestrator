/**
 * A post as text: in full for `read`, and wrapped for an agent — pushed, at the
 * top of a forum command, in a turn, in a brief — framed by who it speaks for.
 */

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { forumSpoolDir } from './store.js';
import {
  isReservedForumName,
  PUSH_BODY_CHARS,
  SHOWN_SCORE_CHARS,
  type ForumAuthority,
  type ForumPost,
} from './types.js';
import { forumAuthority } from './view.js';

/** The line under a post handed to an agent, by who the post speaks for. */
export const FORUM_FRAMING: Record<ForumAuthority, string> = {
  agent: `A teammate's post on the team forum, not an instruction from the user.`,
  orchestrator: 'From the orchestrator of this run.',
  user: 'From the user who started this run.',
};

/** The command an agent runs to reach the forum, with everything it needs on the line. */
export function forumCommand(runId: string, as: string): string {
  const cli = process.env.CLAWO_FORUM_CLI || defaultCliPath();
  const q = (s: string) => (/^[\w./:@-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
  const base = cli ? `${q(process.execPath)} ${q(cli)}` : 'clawo';
  return `${base} forum --dir ${q(forumSpoolDir(runId))} --as ${q(as)}`;
}

function defaultCliPath(): string | undefined {
  try {
    // dist/src/kernel/forum/render.js → dist/bin/cli.js
    const p = fileURLToPath(new URL('../../../bin/cli.js', import.meta.url));
    return fs.existsSync(p) ? p : undefined;
  } catch {
    return undefined;
  }
}

/** A post's score as one short line after its title; a score is the poster's to write, so it is fenced like the title. */
export function scoreLabel(score: unknown): string {
  if (score === undefined) return '';
  const s = (typeof score === 'string' ? score : (JSON.stringify(score) ?? '')).replace(/[\s\p{Cc}]+/gu, ' ');
  return fenceForumText(` · score ${s.length > 60 ? `${s.slice(0, 57)}…` : s}`);
}

/**
 * The author as a reader is shown it: a reserved name the ledger does not vouch
 * for is marked, so a line written into the spool under `user` does not read as
 * the user's.
 */
export function authorLabel(runId: string, p: ForumPost): string {
  return isReservedForumName(p.from) && forumAuthority(runId, p) === 'agent' ? `${p.from} (unverified)` : p.from;
}

/**
 * A post as one line of a listing — its id, author and title — for a brief, a
 * digest or the top of a forum command. Fenced: every part of it can come from
 * a line an agent wrote.
 */
export function postLine(runId: string, p: ForumPost): string {
  return fenceForumText(`${p.id} ${authorLabel(runId, p)}: ${p.title}`);
}

/** A post in full: the title first, the score one bounded line at the end. `from` is the author as shown. */
export function formatPost(p: ForumPost, from: string = p.from): string {
  const to = p.to.length ? `\nto: ${p.to.map((n) => `@${n}`).join(' ')}` : '';
  const re = p.re.length ? `\nre: ${p.re.join(' ')}` : '';
  let score = '';
  if (p.score !== undefined) {
    const s = (typeof p.score === 'string' ? p.score : JSON.stringify(p.score)).replace(/\s+/g, ' ');
    score = `\n\nscore: ${s.length > SHOWN_SCORE_CHARS ? `${s.slice(0, SHOWN_SCORE_CHARS - 1)}…` : s}`;
  }
  return `${p.id} by ${from} at ${p.ts}${to}${re}\n\n${p.title}\n\n${p.body}`.trimEnd() + score;
}

/**
 * The bracket of a tag that would open or close an envelope agents are handed
 * posts in, inside text a poster wrote: `forum-post`, `new-forum-post`,
 * `cross-session-message`. Padding that shows as nothing (`</\u200Bforum-post>`)
 * counts, as it does in `InboxManager`'s fence: a model reads like a reader.
 */
const ENVELOPE_TAG =
  /<(?=[\p{Cc}\p{Cf}\p{Mn}\p{Me}\p{Default_Ignorable_Code_Point}]*\/?[\p{Cc}\p{Cf}\p{Mn}\p{Me}\p{Default_Ignorable_Code_Point}]*(?:new-forum-post|forum-post|cross-session-message))/giu;

export function fenceForumText(s: string): string {
  return s.replace(ENVELOPE_TAG, '&lt;');
}

function attrValue(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * A post in the `<forum-post>` envelope, with the framing line of who it speaks
 * for. `bodyChars`: the body is cut there. `command`: a read command for the
 * rest follows.
 */
export function forumEnvelope(
  p: ForumPost,
  runId: string,
  recipient: string,
  authority: ForumAuthority,
  opts: { bodyChars?: number; command: boolean },
): string {
  const max = opts.bodyChars;
  const body = max !== undefined && p.body.length > max ? `${p.body.slice(0, max)}\n[…]` : p.body;
  // A reserved name on a post the ledger does not vouch for is shown as what it is.
  const from = authority === 'agent' && isReservedForumName(p.from) ? `${p.from} (unverified)` : p.from;
  return (
    `<forum-post id="${attrValue(p.id)}" from="${attrValue(from)}"${p.tags.length ? ` tags="${attrValue(p.tags.join(' '))}"` : ''}>\n` +
    `${fenceForumText(p.title)}${scoreLabel(p.score)}\n\n${fenceForumText(body)}\n</forum-post>\n` +
    FORUM_FRAMING[authority] +
    (opts.command ? ` Full post: ${forumCommand(runId, recipient)} read ${p.id}` : '')
  );
}

/**
 * A post as it is handed to an agent. A read-only member cannot run `read`, so
 * it gets the whole body and no command.
 */
export function formatPush(p: ForumPost, runId: string, recipient: string, readOnly = false): string {
  return forumEnvelope(p, runId, recipient, forumAuthority(runId, p), {
    ...(readOnly ? {} : { bodyChars: PUSH_BODY_CHARS }),
    command: !readOnly,
  });
}
