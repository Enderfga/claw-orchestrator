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
  /** Entries the record evicted from just before this one. */
  omittedBefore?: number;
}

export interface Transcript {
  entries: TranscriptEntry[];
  /**
   * Entries evicted to keep the record bounded, in total. Each eviction is also
   * counted on the entry that followed it (`omittedBefore`), so a render can
   * mark the gap where it was; a count not placed that way marks the gap after
   * the opening request.
   */
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
/**
 * A user turn from the middle of a trimmed conversation is kept up to this, and
 * head-truncated past it. User turns are usually short, and they carry the
 * requirements and corrections the receiving engine must not lose; a long one
 * is usually pasted output, whose head says what it was.
 */
const MIDDLE_USER_TURN_CHARS = 2_000;
const ELISION = '\n[… truncated for length …]';

export function newTranscript(): Transcript {
  return { entries: [], omittedAfterFirst: 0, chars: 0 };
}

export function cloneTranscript(t: Transcript): Transcript {
  return { entries: t.entries.map((e) => ({ ...e })), omittedAfterFirst: t.omittedAfterFirst, chars: t.chars };
}

/**
 * Drop the last `turns` exchanges — each a user entry and the replies after it —
 * after the session's conversation was rewound by that many turns.
 */
export function dropLastTurns(t: Transcript, turns: number): void {
  let cut = t.entries.length;
  for (let left = turns; left > 0 && cut > 0; ) {
    cut--;
    if (t.entries[cut].role === 'user') left--;
  }
  for (const gone of t.entries.splice(cut)) t.chars -= gone.text.length;
}

/**
 * Append one side of an exchange. Past the cap, entries are evicted from the
 * middle of the conversation, oldest first — never the opening request and never
 * the newest entry. Assistant replies go before user turns: a user turn is
 * usually short and may be a correction ("use lr 1e-4, not 3e-4") that the
 * receiving engine must see, while a reply's work is in the workspace.
 */
export function recordExchange(t: Transcript, role: TranscriptEntry['role'], text: string): void {
  const clean = text.trim();
  if (!clean) return;
  t.entries.push({ role, text: clean });
  t.chars += clean.length;
  while (t.chars > MAX_TRANSCRIPT_CHARS && t.entries.length > 2) {
    const last = t.entries.length - 1;
    let i = t.entries.findIndex((e, j) => j >= 1 && j < last && e.role === 'assistant');
    if (i < 0) i = 1;
    const [gone] = t.entries.splice(i, 1);
    t.chars -= gone.text.length;
    t.omittedAfterFirst++;
    const next = t.entries[i];
    next.omittedBefore = (next.omittedBefore ?? 0) + (gone.omittedBefore ?? 0) + 1;
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
 * pinned and the newest turn is kept, since the request says what the work is
 * for and the newest turn where it stands. The rest of the budget goes to the
 * user turns in between, newest first, then to assistant replies, newest first:
 * a user turn may be a correction the receiving engine must not lose, while what
 * a reply did can be re-derived from the workspace. User turns are dropped only
 * when they alone do not fit. Each gap left by an omitted run of turns gets one
 * line saying how many turns it held. Every turn's text is fenced the way
 * openai-compat fences replayed turns, so a transcript that contains the block's
 * own tags cannot close the block early and speak as a different role.
 */
export function renderHandoff(t: Transcript, src: HandoffSource, maxChars = DEFAULT_HANDOFF_CHARS): HandoffRender {
  if (!t.entries.length) return { text: '', turns: 0, omitted: 0 };
  const turns = t.entries.map((e) => ({ role: e.role, text: fenceHistoryTags(e.text) }));
  const tail = framing(src);
  const shell = '<conversation_history>\n</conversation_history>\n\n'.length + tail.length;
  let budget = Math.max(maxChars, MIN_HANDOFF_CHARS) - shell;

  // Evictions the record placed before an entry; any it did not place belong
  // after the opening request, where the record used to evict from.
  const evictedBefore = t.entries.map((e) => e.omittedBefore ?? 0);
  const placed = evictedBefore.reduce((n, x) => n + x, 0);
  if (t.omittedAfterFirst > placed && t.entries.length > 1) evictedBefore[1] += t.omittedAfterFirst - placed;
  const unplaced = t.entries.length > 1 ? 0 : Math.max(0, t.omittedAfterFirst - placed);

  const renderedLen = turns.reduce((n, x) => n + frameOf(x.role) + x.text.length, 0);
  const markerLen = '[… 99999 earlier turns omitted …]\n'.length;
  const anyEvicted = evictedBefore.some((x) => x > 0);
  const kept: Array<string | undefined> = turns.map(() => undefined);

  if (renderedLen + (anyEvicted ? markerLen * turns.length : 0) <= budget) {
    turns.forEach((x, i) => (kept[i] = x.text));
  } else {
    const opening = turns[0];
    // A quarter of the budget, capped. MIN_HANDOFF_CHARS keeps this above
    // MIN_TURN_CHARS, so the opening request always renders, if only its head.
    const pinnedRoom = Math.min(PINNED_OPENING_CHARS, Math.floor(budget / 4)) - frameOf(opening.role);
    kept[0] = fit(opening.text, pinnedRoom) ?? '';
    budget -= frameOf(opening.role) + kept[0].length;

    // Every kept turn after the opening may open a gap before it, and the
    // newest kept turn may close one after it; reserve a marker for each.
    const take = (i: number, cap: number): boolean => {
      const room = Math.min(cap, budget - frameOf(turns[i].role) - markerLen);
      const text = fit(turns[i].text, room);
      if (text === undefined) return false;
      kept[i] = text;
      budget -= frameOf(turns[i].role) + text.length + markerLen;
      return text === turns[i].text || room === cap;
    };
    budget -= markerLen;
    const last = turns.length - 1;
    if (last >= 1) take(last, Infinity);
    // A user turn cut by the budget, or one that did not fit, means no older one fits.
    for (let i = last - 1; i >= 1; i--) {
      if (turns[i].role === 'user' && !take(i, MIDDLE_USER_TURN_CHARS)) break;
    }
    for (let i = last - 1; i >= 1; i--) {
      if (turns[i].role !== 'assistant') continue;
      // The boundary reply was cut or did not fit; nothing older fits either.
      if (!take(i, Infinity)) break;
    }
  }

  const lines: string[] = [];
  let omitted = unplaced;
  let gap = 0;
  const flushGap = (): void => {
    if (gap > 0) lines.push(`[… ${gap} earlier turn${gap === 1 ? '' : 's'} omitted …]`);
    omitted += gap;
    gap = 0;
  };
  turns.forEach((turn, i) => {
    gap += evictedBefore[i];
    const text = kept[i];
    if (text === undefined) {
      gap += 1;
      return;
    }
    flushGap();
    if (text) lines.push(`<${turn.role}>\n${text}\n</${turn.role}>`);
  });
  flushGap();
  return {
    text: `<conversation_history>\n${lines.join('\n')}\n</conversation_history>\n\n${tail}`,
    turns: kept.filter((k) => k).length,
    omitted,
  };
}
