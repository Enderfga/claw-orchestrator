/**
 * Cursor's model ids, and the effort written into them.
 *
 * Cursor has no `--effort`: the effort is part of the model id
 * (`claude-opus-5-5-high`, `gpt-5.4-mini-low`, `-fast` after it), and
 * `cursor-agent models` lists every id the account can run. A session's
 * `effort` is applied by picking the listed id for the model at that effort.
 */

import { withCursorConfigMirror } from './cursor-config-dir.js';
import { execEngine } from './engine-spawn.js';
import type { EffortLevel } from './types.js';

/** Cursor's effort suffixes, lowest first. */
const CURSOR_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
const EFFORT_SUFFIX = new RegExp(`-(?:${CURSOR_EFFORTS.join('|')})(?:-fast)?$`);

/** How long a model listing is reused. */
const MODEL_LIST_TTL_MS = 60 * 60_000;

let cached: { bin: string; ids: Set<string>; at: number } | undefined;
let pending: { bin: string; ids: Promise<Set<string> | undefined> } | undefined;

/** The ids `cursor-agent models` lists (`<id> - <name>` lines). */
export function parseCursorModelList(out: string): Set<string> {
  const ids = new Set<string>();
  for (const line of out.split(/\r?\n/)) {
    const m = /^(\S+) - \S/.exec(line.trim());
    if (m) ids.add(m[1]);
  }
  return ids;
}

/** The account's model ids, listed once an hour; undefined when the listing fails. */
export async function cursorModelIds(bin: string): Promise<Set<string> | undefined> {
  if (cached && cached.bin === bin && Date.now() - cached.at < MODEL_LIST_TTL_MS) return cached.ids;
  if (pending?.bin === bin) return pending.ids;
  const ids = withCursorConfigMirror((env) => execEngine(bin, ['models'], { timeout: 30_000, env }))
    .then(({ stdout }) => {
      const listed = parseCursorModelList(stdout);
      if (listed.size === 0) return undefined;
      cached = { bin, ids: listed, at: Date.now() };
      return listed;
    })
    .catch(() => undefined)
    .finally(() => {
      if (pending?.ids === ids) pending = undefined;
    });
  pending = { bin, ids };
  return ids;
}

/** Forget the cached listing (tests, a changed account). */
export function clearCursorModelIds(): void {
  cached = undefined;
}

/** The Cursor effort a clawo effort asks for; undefined for `auto`, which leaves the model's own. */
function cursorEffort(effort: EffortLevel | undefined): (typeof CURSOR_EFFORTS)[number] | undefined {
  if (!effort || effort === 'auto') return undefined;
  return effort === 'ultra' ? 'max' : effort;
}

/**
 * The id that runs `model` at `effort`, from the listed ids: `<model>-<effort>`
 * (before a `-fast`), or the nearest lower effort the model is listed with.
 * The model as given when it already names an effort or parameters (`[…]`),
 * is `auto`, or has no listed id at any effort at or below the one asked for.
 */
export function cursorModelForEffort(
  model: string,
  effort: EffortLevel | undefined,
  ids: ReadonlySet<string> | undefined,
): { model: string; applied?: string } {
  const want = cursorEffort(effort);
  if (!want || !ids || model.includes('[') || EFFORT_SUFFIX.test(model)) return { model };
  if (model === 'auto' || model.startsWith('auto-')) return { model };
  const fast = model.endsWith('-fast');
  const base = fast ? model.slice(0, -'-fast'.length) : model;
  for (let i = CURSOR_EFFORTS.indexOf(want); i >= 0; i--) {
    const id = `${base}-${CURSOR_EFFORTS[i]}${fast ? '-fast' : ''}`;
    if (ids.has(id)) return { model: id, applied: CURSOR_EFFORTS[i] };
  }
  return { model };
}
