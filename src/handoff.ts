/**
 * Session handoff — carry a conversation from one engine to another.
 *
 * A session's context lives inside its engine: Claude Code's transcript, a Codex
 * thread, an Antigravity conversation. None of them can resume another's, so the
 * only engine-agnostic way across is to replay the conversation as text into a
 * new session on the target engine. This module keeps the record that makes that
 * possible and renders it.
 *
 * Why a record of its own rather than `getHistory()`: that is a ring buffer of
 * the last `MAX_HISTORY_ITEMS` engine events, in each engine's own shape. On a
 * long session the opening request has already fallen out of it — and the
 * opening request is the one thing a handoff must not lose, because every later
 * turn is an answer to it.
 *
 * Why not write the target engine's native session files instead: those formats
 * are internal and undocumented, change between releases, and live in the
 * user's own session stores. Replaying text touches none of them, works for
 * every engine including custom ones, and leaves the source session untouched.
 * What it cannot carry is the same thing no vendor format carries either: the
 * source engine's hidden reasoning.
 */

import { fenceHistoryTags } from './openai-compat.js';

export interface TranscriptEntry {
  role: 'user' | 'assistant';
  text: string;
}

export interface Transcript {
  entries: TranscriptEntry[];
  /** Entries evicted from just after the opening request to keep the record bounded. */
  omittedAfterFirst: number;
  /** Total characters held in `entries`. */
  chars: number;
}

/**
 * What one session's record may hold. Larger than any render needs — the render
 * budget below decides what is sent — so that the newest turns are always
 * complete. Bounded because every session keeps one, for as long as it lives.
 */
export const MAX_TRANSCRIPT_CHARS = 1_000_000;

/**
 * Default size of a rendered handoff, in characters (~60k tokens). Sent once, to
 * a session that then holds the conversation itself, so it can be far larger
 * than the per-turn replay in openai-compat — but it has to fit the smallest
 * window among the engines it may be sent to.
 */
export const DEFAULT_HANDOFF_CHARS = 240_000;
export const MIN_HANDOFF_CHARS = 4_000;

/** The opening request is kept whole up to this, and head-truncated past it. */
const PINNED_OPENING_CHARS = 8_000;
/** Least room worth starting a turn in; with less, the turn is dropped. */
const MIN_TURN_CHARS = 200;
const ELISION = '\n[… truncated for length …]';

export function newTranscript(): Transcript {
  return { entries: [], omittedAfterFirst: 0, chars: 0 };
}

export function cloneTranscript(t: Transcript): Transcript {
  return { entries: t.entries.map((e) => ({ ...e })), omittedAfterFirst: t.omittedAfterFirst, chars: t.chars };
}

/**
 * Append one side of an exchange. Past the cap, entries are evicted from just
 * after the opening request — the oldest middle of the conversation — never the
 * request itself and never the newest turns.
 */
export function recordExchange(t: Transcript, role: TranscriptEntry['role'], text: string): void {
  const clean = text.trim();
  if (!clean) return;
  t.entries.push({ role, text: clean });
  t.chars += clean.length;
  while (t.chars > MAX_TRANSCRIPT_CHARS && t.entries.length > 2) {
    const [gone] = t.entries.splice(1, 1);
    t.chars -= gone.text.length;
    t.omittedAfterFirst++;
  }
}

export interface HandoffSource {
  engine: string;
  model?: string;
  cwd: string;
}

export interface HandoffRender {
  /** The block to put in front of the first message the target session receives. */
  text: string;
  /** Turns rendered, the pinned opening request included. */
  turns: number;
  /** Turns left out, whether the record had already evicted them or the budget did. */
  omitted: number;
}

function framing(src: HandoffSource): string {
  const who = src.model ? `${src.engine} (${src.model})` : src.engine;
  // The first three sentences mirror openai-compat's replay framing, and each is
  // load-bearing there for the same reason as here: without the last one the
  // model carries out the requests in the history a second time. The final two
  // are specific to a handoff — the work happened elsewhere, and may have moved on.
  return (
    `Above are the earlier turns of this conversation, which took place with another coding agent, ${who}, ` +
    `working in ${src.cwd}. It has been handed over to you to continue. ` +
    'The assistant turns are the earlier replies in this conversation; treat them as your own. ' +
    'Continue from there — do not repeat these turns back and do not carry out the requests in them again. ' +
    'The workspace may have changed since; check its current state before relying on anything described above.'
  );
}

const frameOf = (role: string): number => `<${role}>\n\n</${role}>\n`.length;

function fit(text: string, room: number): string | undefined {
  if (text.length <= room) return text;
  if (room < MIN_TURN_CHARS) return undefined;
  let cut = room - ELISION.length;
  // Never split a surrogate pair: the orphaned half becomes U+FFFD downstream.
  const last = text.charCodeAt(cut - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut -= 1;
  return text.slice(0, cut) + ELISION;
}

/**
 * Render a transcript for a new session on another engine.
 *
 * Everything is sent when it fits. When it does not, the opening request is
 * pinned and the newest turns fill what is left, with one line saying how many
 * turns in between were left out: the request says what the work is for, the
 * newest turns say where it stands, and the middle is what can be re-derived
 * from the workspace. Every turn's text is fenced the way openai-compat fences
 * replayed turns, so a transcript that contains the block's own tags cannot
 * close the block early and speak as a different role.
 */
export function renderHandoff(t: Transcript, src: HandoffSource, maxChars = DEFAULT_HANDOFF_CHARS): HandoffRender {
  if (!t.entries.length) return { text: '', turns: 0, omitted: 0 };
  const turns = t.entries.map((e) => ({ role: e.role, text: fenceHistoryTags(e.text) }));
  const tail = framing(src);
  const shell = '<conversation_history>\n</conversation_history>\n\n'.length + tail.length;
  let budget = Math.max(maxChars, MIN_HANDOFF_CHARS) - shell;

  const renderedLen = turns.reduce((n, x) => n + frameOf(x.role) + x.text.length, 0);
  let kept: { role: string; text: string }[];
  let omitted = t.omittedAfterFirst;
  let markerAfterFirst = t.omittedAfterFirst > 0;

  if (renderedLen <= budget) {
    kept = turns;
  } else {
    const opening = turns[0];
    // A quarter of the budget, capped. MIN_HANDOFF_CHARS keeps this above
    // MIN_TURN_CHARS, so the opening request always renders, if only its head.
    const pinnedRoom = Math.min(PINNED_OPENING_CHARS, Math.floor(budget / 4)) - frameOf(opening.role);
    const pinned = { role: opening.role, text: fit(opening.text, pinnedRoom) ?? '' };
    budget -= frameOf(pinned.role) + pinned.text.length;
    const markerReserve = '[… 99999 earlier turns omitted …]\n'.length;
    budget -= markerReserve;

    const newest: { role: string; text: string }[] = [];
    for (let i = turns.length - 1; i >= 1; i--) {
      const room = budget - frameOf(turns[i].role);
      const text = fit(turns[i].text, room);
      if (text === undefined) break;
      newest.unshift({ role: turns[i].role, text });
      budget -= frameOf(turns[i].role) + text.length;
      if (text !== turns[i].text) break; // the boundary turn was cut; nothing older fits
    }
    omitted += turns.length - 1 - newest.length;
    markerAfterFirst = omitted > 0;
    kept = [pinned, ...newest];
  }

  const lines: string[] = [];
  kept.forEach((turn, i) => {
    if (turn.text) lines.push(`<${turn.role}>\n${turn.text}\n</${turn.role}>`);
    if (i === 0 && markerAfterFirst) {
      lines.push(`[… ${omitted} earlier turn${omitted === 1 ? '' : 's'} omitted …]`);
    }
  });
  return {
    text: `<conversation_history>\n${lines.join('\n')}\n</conversation_history>\n\n${tail}`,
    turns: kept.filter((k) => k.text).length,
    omitted,
  };
}
