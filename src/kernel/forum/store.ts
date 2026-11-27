/**
 * Where a forum's files are and how they are kept: the spool the agents' CLI
 * reads and writes, the durable copy beside the run (or under `forums/` for a
 * forum with no run), the authored ledger, and the moves between them —
 * restore, store sync, retirement and the prune.
 *
 * The durable copy is a byte prefix of the spool. A store sync copies the
 * spool's whole lines past the store's size, under the forum's lock, so two
 * processes cannot both append the same chunk and nothing needs an in-memory
 * offset. A restore puts the store back in front of whatever the spool still
 * has, under the same lock.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { withFileLock } from '../file-lock.js';
import { isValidRunId, loadRun, runDir, wfDir } from '../store.js';
import { isTerminalRunState, type RunRecord, type RunState } from '../types.js';
import { liveHubs } from './registry.js';
import { forumRoster } from './roster.js';
import {
  isForumName,
  isLooseForumName,
  KNOWN_TAGS,
  MAX_BODY_CHARS,
  MAX_TITLE_CHARS,
  normalizeForumConfig,
  type ForumConfig,
  type ForumEvent,
  type ForumMember,
  type ForumPost,
  type ForumPushMode,
  type ForumScoreSource,
} from './types.js';

export const POSTS = 'posts.jsonl';
export const EVENTS = 'events.jsonl';
export const CONFIG = 'config.json';
export const LOCK = 'posts.lock';
/**
 * The posts the runtime wrote under a reserved name (`user`, `orchestrator`).
 * Kept in the store only: the spool is in the temp directory, where every agent
 * can write, so a line there proves nothing about who wrote it.
 */
export const AUTHORED = 'authored.jsonl';
/**
 * What the runtime itself recorded on a forum: the joins, leaves and deliveries
 * its hubs, briefs and turns made. In the store only, which no spool copy
 * writes: the spool's events are anyone's to write, a forum command run under
 * another member's name included.
 */
export const RUNTIME_EVENTS = 'runtime-events.jsonl';
/** A forum with no run whose store has not changed for this long has its spool removed. */
const STALE_SPOOL_MS = 7 * 24 * 3600_000;
/**
 * A forum lock older than this is broken whoever holds it. Its critical sections
 * take milliseconds, and the lock file sits in the spool, where any agent can leave one.
 */
const LOCK_STALE_MS = 5_000;
/**
 * A lock that names no live process is broken once it is this old. A holder
 * writes its pid the moment it has the lock, so only a holder that died, or a
 * file nobody holds (an agent's `touch`), is that old without a live pid in it.
 */
const UNHELD_LOCK_MS = 250;
/**
 * How long a caller waits for the lock before it is told the forum is busy. The
 * server's thread waits no longer, for a runtime post or a join.
 */
const LOCK_WAIT_MS = 1_000;
/** How often a wait looks again at who holds the lock. */
const LOCK_CHECK_MS = 50;
/** What a copy that runs again shortly waits for the lock: a busy one is left to the next copy. */
const TRY_LOCK_WAIT_MS = 20;
/** A post id: `p` and its number. */
const POST_ID_RE = /^p\d{1,12}$/;
/**
 * Post numbers past this are not counted when the next id is given out, so a
 * line written by hand with a huge id cannot push the count out of range.
 */
const MAX_COUNTED_POST = 1e9;

// ─── Locations ──────────────────────────────────────────────────────────────

let resolvedRoot: { tmp: string; uid: number | undefined; root: string } | undefined;

function rootState(dir: string, uid: number | undefined): 'missing' | 'ok' | 'unsafe' {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(dir);
  } catch {
    return 'missing';
  }
  if (!st.isDirectory()) return 'unsafe';
  if (uid === undefined) return 'ok';
  return st.uid !== uid || (st.mode & 0o022) !== 0 ? 'unsafe' : 'ok';
}

/**
 * The directory the spools live in: `CLAWO_FORUM_SPOOL_ROOT`, else
 * `<tmp>/clawo-forum`. A shared temp directory lets anyone create that path
 * first, so a root that is another user's, or that others can write, is passed
 * over for `<tmp>/clawo-forum-<uid>`.
 */
function spoolRoot(): string {
  const override = process.env.CLAWO_FORUM_SPOOL_ROOT;
  if (override) return override;
  const tmp = os.tmpdir();
  const uid = process.getuid?.();
  if (resolvedRoot && resolvedRoot.tmp === tmp && resolvedRoot.uid === uid) return resolvedRoot.root;
  const shared = path.join(tmp, 'clawo-forum');
  let root = shared;
  if (rootState(shared, uid) === 'unsafe') {
    root = path.join(tmp, `clawo-forum-${uid ?? 'user'}`);
    if (rootState(root, uid) === 'unsafe') {
      throw new Error(
        `No safe forum spool directory: ${shared} and ${root} belong to another user or can be written by others; set CLAWO_FORUM_SPOOL_ROOT`,
      );
    }
  }
  resolvedRoot = { tmp, uid, root };
  return root;
}

/** A forum with no run (the session forum): its id starts with `fm-`. */
export function isStandaloneForumId(id: string): boolean {
  return id.startsWith('fm-');
}

/**
 * A forum's two places. A run's forum is stored in `<run>/forum`; a forum with
 * no run in `<clawo home>/forums/<id>`, next to `wf/` (never under it, which
 * `listRuns` scans).
 */
export function forumLocation(id: string): { spool: string; store: string } {
  if (!isValidRunId(id)) throw new Error(`Invalid forum id ${JSON.stringify(id)}: must be a single path segment`);
  const store = isStandaloneForumId(id)
    ? path.join(path.dirname(wfDir()), 'forums', id)
    : path.join(runDir(id), 'forum');
  return { spool: path.join(spoolRoot(), id), store };
}

/** The spool the agents' CLI uses for this forum. */
export function forumSpoolDir(runId: string): string {
  return forumLocation(runId).spool;
}

/** The durable copy. */
export function forumStoreDir(runId: string): string {
  return forumLocation(runId).store;
}

// ─── Files ──────────────────────────────────────────────────────────────────

let lastStamp = 0;

/**
 * Now, as an ISO time later than any this process gave out before: a leave
 * that closes a member's epoch and a post written the next moment keep their
 * order even within one millisecond.
 */
export function forumTimestamp(): string {
  lastStamp = Math.max(Date.now(), lastStamp + 1);
  return new Date(lastStamp).toISOString();
}

export function readBuf(file: string): Buffer | undefined {
  try {
    return fs.readFileSync(file);
  } catch {
    return undefined;
  }
}

export function fileSize(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

function lines(buf: Buffer | undefined): string[] {
  return buf ? buf.toString('utf8').split('\n') : [];
}

function tryReadJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

export function readJsonl<T>(file: string): T[] {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out: T[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // A torn line: a write cut short, or one still being written.
    }
  }
  return out;
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** A title as one line of at most MAX_TITLE_CHARS, cut with `…`. */
export function oneLineTitle(raw: string): string {
  const title = raw.replace(/[\s\p{Cc}]+/gu, ' ').trim();
  return title.length > MAX_TITLE_CHARS ? `${title.slice(0, MAX_TITLE_CHARS - 1)}…` : title;
}

/**
 * A post line as every reader takes it, or undefined for a line that is not a
 * post. The spool can be written by hand, so nothing on the line is trusted to
 * have the shape the writers give it: the id is `p` and digits, the author and
 * the addressees are names, the title is one line of at most MAX_TITLE_CHARS,
 * the body at most MAX_BODY_CHARS, the tags are forum tags, the references are
 * post ids. A post a writer made reads back unchanged.
 */
export function normalizePost(raw: unknown): ForumPost | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Partial<ForumPost>;
  if (typeof r.id !== 'string' || !POST_ID_RE.test(r.id)) return undefined;
  if (typeof r.from !== 'string' || !isLooseForumName(r.from)) return undefined;
  if (typeof r.title !== 'string') return undefined;
  const names = (v: unknown) => strings(v).filter(isLooseForumName);
  return {
    ...r,
    id: r.id,
    // eslint-disable-next-line no-control-regex
    ts: typeof r.ts === 'string' && r.ts.length <= 40 && !/[\u0000-\u001f\u007f]/.test(r.ts) ? r.ts : '',
    from: r.from,
    title: oneLineTitle(r.title),
    // No post is written longer; a line in the spool can be.
    body: typeof r.body === 'string' ? r.body.slice(0, MAX_BODY_CHARS) : '',
    tags: [...new Set(strings(r.tags).filter((t) => KNOWN_TAGS.has(t)))],
    to: names(r.to),
    re: strings(r.re).filter((x) => POST_ID_RE.test(x)),
    ...(r.direct !== undefined ? { direct: names(r.direct) } : {}),
  } as ForumPost;
}

/** The posts of a posts file, each id once (the first line with it), as `normalizePost` reads them. */
export function readPosts(file: string): ForumPost[] {
  const out: ForumPost[] = [];
  const seen = new Set<string>();
  for (const raw of readJsonl<unknown>(file)) {
    const post = normalizePost(raw);
    if (!post || seen.has(post.id)) continue;
    seen.add(post.id);
    out.push(post);
  }
  return out;
}

/**
 * Append text that ends in a newline. A file whose last line was cut short gets
 * the newline it lacks first, so the torn line stays one bad line instead of
 * swallowing the next one.
 */
function appendText(file: string, text: string): void {
  let prefix = '';
  const size = fileSize(file);
  if (size > 0) {
    const fd = fs.openSync(file, 'r');
    try {
      const last = Buffer.alloc(1);
      fs.readSync(fd, last, 0, 1, size - 1);
      if (last[0] !== 0x0a) prefix = '\n';
    } finally {
      fs.closeSync(fd);
    }
  }
  fs.appendFileSync(file, prefix + text, { mode: 0o600 });
}

export function appendLine(file: string, value: unknown): void {
  appendText(file, JSON.stringify(value) + '\n');
}

function readText(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

/** `n` bytes of a file from `start`; fewer when it ends sooner. */
export function readRange(file: string, start: number, n: number): Buffer {
  const buf = Buffer.alloc(n);
  let fd: number;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return Buffer.alloc(0);
  }
  try {
    return buf.subarray(0, fs.readSync(fd, buf, 0, n, start));
  } finally {
    fs.closeSync(fd);
  }
}

/** Write so a concurrent reader sees the old file or the new one, never a part. */
function writeFileAtomic(file: string, data: string | Buffer): void {
  const tmp = `${file}.tmp.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
  try {
    fs.writeFileSync(tmp, data, { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

// ─── The spool's config ─────────────────────────────────────────────────────

export interface SpoolConfig {
  /** The forum id: a run id, or `fm-…` for a forum with no run. */
  runId: string;
  score?: ForumScoreSource;
  /** The push mode, so an agent's own forum command can show what a push would have carried. */
  push?: ForumPushMode;
  /** Every name on the forum: from the spec of the run that owns it, or the members that joined. */
  team?: ForumMember[];
  /** The durable copy this spool is kept in, for a prune run under another store to tell it apart. */
  store?: string;
  /** A forum with no run. */
  standalone?: boolean;
  /** Names may be any 1–128 characters with no control characters (session names). */
  looseNames?: boolean;
}

export function readSpoolConfig(dir: string): SpoolConfig {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, CONFIG), 'utf8')) as SpoolConfig;
  } catch {
    throw new Error(`No forum at ${dir}: run this from an agent of a workflow run with a forum`);
  }
}

export function tryReadSpoolConfig(dir: string): SpoolConfig | undefined {
  return tryReadJson<SpoolConfig>(path.join(dir, CONFIG));
}

/** Whether `name` may post on a forum with this config. */
export function validForumName(config: SpoolConfig | undefined, name: string): boolean {
  return config?.looseNames ? isLooseForumName(name) : isForumName(name);
}

/**
 * Move aside a lock no live process holds: its holder's pid is not running, or
 * it names none, and it is UNHELD_LOCK_MS old. A forum command killed inside its
 * critical section, or a file an agent wrote, then keeps nobody waiting for long.
 */
function breakUnheldLock(lock: string): void {
  let st: fs.Stats;
  try {
    st = fs.statSync(lock);
  } catch {
    return;
  }
  if (Date.now() - st.mtimeMs < UNHELD_LOCK_MS) return;
  let text = '';
  try {
    text = readRange(lock, 0, 16).toString('utf8').trim();
  } catch {
    // Not a file (a directory made in its place): it names no holder.
  }
  const pid = /^\d{1,10}$/.test(text) ? Number(text) : 0;
  if (pid > 0 && processAlive(pid)) return;
  try {
    // Only the file looked at: one made since is a new holder's.
    if (fs.statSync(lock).ino !== st.ino) return;
    fs.renameSync(lock, `${lock}.stale.${process.pid}.${Date.now().toString(36)}`);
  } catch {
    // Released, or moved aside by another waiter.
  }
}

/**
 * Run `fn` holding the forum's lock (the spool's `posts.lock`), with this
 * process's pid in it. A lock no live process holds is broken; one a live
 * process holds is waited on for at most LOCK_WAIT_MS, then this throws that the
 * forum is busy. `wait: false` gives up almost at once, for a copy that runs
 * again shortly.
 */
export function withForumLock<T>(spool: string, fn: () => T, opts: { wait?: boolean } = {}): T {
  const lock = path.join(spool, LOCK);
  const deadline = Date.now() + (opts.wait === false ? TRY_LOCK_WAIT_MS : LOCK_WAIT_MS);
  const held = (): T => {
    try {
      // Into the file just made (`r+` makes none), for a waiter to tell a live holder from a dead one.
      fs.writeFileSync(lock, String(process.pid), { flag: 'r+' });
    } catch {
      // The lock holds without it; a waiter breaks it later.
    }
    return fn();
  };
  for (;;) {
    breakUnheldLock(lock);
    const slice = Math.max(1, Math.min(LOCK_CHECK_MS, deadline - Date.now()));
    const sliceEnd = Date.now() + slice;
    const r = withFileLock(lock, held, { staleMs: LOCK_STALE_MS, waitMs: slice });
    if (r.ok) return r.value;
    // Back before its wait ran out: the lock could not be made at all (no spool), not a busy one.
    if (Date.now() < sliceEnd || Date.now() >= deadline) throw new Error(`The forum is busy: ${r.error}`);
  }
}

// ─── The store directory ────────────────────────────────────────────────────

/** Forums of runs deleted in this process: nothing puts their spool back until a run takes the id again. */
const discarded = new Set<string>();

/**
 * The store directory, made when it may be: a forum with no run's always, a
 * run's only inside a run directory that is there, so a write that comes late
 * never brings back a run that was deleted. Whether the store is there now.
 */
function storeReady(id: string, store: string): boolean {
  if (fs.existsSync(store)) return true;
  if (!isStandaloneForumId(id) && !fs.existsSync(path.dirname(store))) return false;
  fs.mkdirSync(store, { recursive: true });
  return true;
}

/**
 * A deleted run's forum: its live hub stops, its spool goes, and what this
 * process kept of it is forgotten, so nothing writes the run directory back and
 * a later run under the same id starts on an empty forum.
 */
export function discardForum(id: string): void {
  const { spool, store } = forumLocation(id);
  discarded.add(id);
  const hub = liveHubs.get(id);
  liveHubs.delete(id);
  hub?.close();
  fs.rmSync(spool, { recursive: true, force: true });
  ledgers.delete(path.join(store, AUTHORED));
  runtimeRecords.delete(path.join(store, RUNTIME_EVENTS));
}

// ─── Restore ────────────────────────────────────────────────────────────────

/**
 * Put the durable copy back in the spool when the spool does not start with it
 * (a reboot cleared the temp directory, or the run's spool was retired), keeping
 * the lines the spool has that the store does not. Under the forum's lock.
 */
function restoreSpool(spool: string, store: string): void {
  for (const name of [POSTS, EVENTS]) {
    const d = readBuf(path.join(store, name));
    if (!d || d.length === 0) continue;
    const s = readBuf(path.join(spool, name)) ?? Buffer.alloc(0);
    if (s.length >= d.length && s.subarray(0, d.length).equals(d)) continue;
    let text = d.toString('utf8');
    if (!text.endsWith('\n')) text += '\n';
    if (s.length > 0) {
      const known = new Set(lines(d));
      const extra = lines(s).filter((l) => l.trim() && !known.has(l));
      if (extra.length) text += `${extra.join('\n')}\n`;
    }
    writeFileAtomic(path.join(spool, name), text);
  }
}

/**
 * Whether the spool lacks what the store has: a file missing or shorter, or one
 * whose bytes where the store ends are not the store's. Reads a few hundred
 * bytes of each file, never a whole one.
 */
function spoolBehind(spool: string, store: string): boolean {
  for (const name of [POSTS, EVENTS]) {
    const d = path.join(store, name);
    const dSize = fileSize(d);
    if (dSize === 0) continue;
    if (!tailMatches(readRange(path.join(spool, name), Math.max(0, dSize - 256), Math.min(dSize, 256)), d, dSize)) {
      return true;
    }
  }
  return false;
}

/**
 * Ready the spool for a config: the durable copy put back when the spool is
 * behind it, and the config written when it differs. The lock is taken only
 * when one of those has something to do, so a forum used often does not wait on
 * it, or read its files whole, for nothing.
 */
function prepareSpool(id: string, config: SpoolConfig | undefined): string {
  const { spool, store } = forumLocation(id);
  if (discarded.has(id)) {
    if (!fs.existsSync(path.dirname(store))) throw new Error(`No forum ${id}: its run was deleted`);
    discarded.delete(id);
  }
  fs.mkdirSync(spool, { recursive: true, mode: 0o700 });
  fs.mkdirSync(store, { recursive: true });
  const text = config ? JSON.stringify(config, null, 2) : undefined;
  const configFile = path.join(spool, CONFIG);
  if ((text !== undefined && readText(configFile) !== text) || spoolBehind(spool, store)) {
    withForumLock(spool, () => {
      restoreSpool(spool, store);
      if (text !== undefined && readText(configFile) !== text) writeFileAtomic(configFile, text);
    });
  }
  return spool;
}

/** The config of a forum with no run: the durable one, else the spool's. */
function standaloneConfig(id: string): SpoolConfig | undefined {
  const { spool, store } = forumLocation(id);
  return tryReadJson<SpoolConfig>(path.join(store, CONFIG)) ?? tryReadJson<SpoolConfig>(path.join(spool, CONFIG));
}

/**
 * Make the spool ready for agents: write its config, and put back the posts and
 * events of the durable copy when the spool is gone or behind it.
 */
export function ensureForumSpool(runId: string, config: ForumConfig): string {
  if (isStandaloneForumId(runId)) {
    const existing = standaloneConfig(runId);
    if (!existing) throw new Error(`No forum ${runId}: create it first`);
    return prepareSpool(runId, {
      ...existing,
      ...(config.score ? { score: config.score } : {}),
      ...(config.push ? { push: config.push } : {}),
    });
  }
  let owner: RunRecord | undefined;
  try {
    owner = loadRun(runId);
  } catch {
    owner = undefined;
  }
  return prepareSpool(runId, {
    runId,
    ...(config.score ? { score: config.score } : {}),
    ...(config.push ? { push: config.push } : {}),
    ...(owner ? { team: forumRoster(owner.spec) } : {}),
    store: forumLocation(runId).store,
  });
}

/**
 * The spool, put back from the store if it is gone, without rewriting a config
 * that is there. A run's forum gets the config its run gives it.
 */
export function spoolReady(id: string, config?: ForumConfig): string {
  const { spool } = forumLocation(id);
  if (fs.existsSync(path.join(spool, CONFIG))) return spool;
  return ensureForumSpool(id, config ?? runForumConfig(id));
}

/** The forum config a run's spec gives it; `{}` for a run that exposes none, or a forum with no run. */
function runForumConfig(id: string): ForumConfig {
  if (isStandaloneForumId(id)) return {};
  try {
    const spec = loadRun(id)?.spec;
    return (spec?.forum ? normalizeForumConfig(spec.forum) : undefined) ?? {};
  } catch {
    return {};
  }
}

/**
 * A forum with no run (`fm-…`): the session forum, or any board a mode keeps
 * outside a workflow. Made once; making it again keeps its posts and adds the
 * members given. `looseNames` lets any name of 1–128 characters with no control
 * characters post (session names).
 */
export function createForum(
  id: string,
  opts: { config?: ForumConfig; looseNames?: boolean; team?: ForumMember[] } = {},
): string {
  if (!isStandaloneForumId(id)) {
    throw new Error(`A forum with no run has an id that starts with fm-: ${JSON.stringify(id)}`);
  }
  const { store } = forumLocation(id);
  const existing = standaloneConfig(id);
  const looseNames = opts.looseNames ?? existing?.looseNames ?? false;
  const team = [...(existing?.team ?? [])];
  for (const m of opts.team ?? []) {
    if (!(looseNames ? isLooseForumName(m.name) : isForumName(m.name))) {
      throw new Error(`Invalid forum name ${JSON.stringify(m.name)}`);
    }
    if (!team.some((t) => t.name === m.name)) team.push(m);
  }
  const score = opts.config?.score ?? existing?.score;
  const push = opts.config?.push ?? existing?.push;
  const config: SpoolConfig = {
    runId: id,
    standalone: true,
    ...(looseNames ? { looseNames: true } : {}),
    ...(score ? { score } : {}),
    ...(push ? { push } : {}),
    team,
    store,
  };
  fs.mkdirSync(store, { recursive: true });
  writeFileAtomic(path.join(store, CONFIG), JSON.stringify(config, null, 2));
  return prepareSpool(id, config);
}

/** Put a member that joins a forum with no run on its team, in the spool and the store. */
export function addStandaloneMember(id: string, name: string): void {
  const { spool, store } = forumLocation(id);
  if (tryReadSpoolConfig(spool)?.team?.some((m) => m.name === name)) return;
  withForumLock(spool, () => {
    const config = tryReadSpoolConfig(spool) ?? standaloneConfig(id);
    if (!config) throw new Error(`No forum ${id}: create it first`);
    if (config.team?.some((m) => m.name === name)) return;
    const next: SpoolConfig = { ...config, team: [...(config.team ?? []), { name, node: '', mayReturn: true }] };
    const text = JSON.stringify(next, null, 2);
    writeFileAtomic(path.join(spool, CONFIG), text);
    fs.mkdirSync(store, { recursive: true });
    writeFileAtomic(path.join(store, CONFIG), text);
  });
}

// ─── Store sync, retirement, prune ──────────────────────────────────────────

/**
 * Whether `spoolTail` — the spool's bytes that end where the store ends, as
 * many as `storeSize` or 256 — ends a line and is the store's last bytes: the
 * spool still extends the store.
 */
function tailMatches(spoolTail: Buffer, store: string, storeSize: number): boolean {
  const n = Math.min(storeSize, 256);
  if (spoolTail.length !== n || spoolTail[n - 1] !== 0x0a) return false;
  return spoolTail.equals(readRange(store, storeSize - n, n));
}

/** The spool's whole lines that the store does not have yet, onto the store. */
function copyNewLines(src: string, dst: string): void {
  const sSize = fileSize(src);
  if (sSize === 0) return;
  const dSize = fileSize(dst);
  if (dSize > 0 && sSize >= dSize) {
    // The usual case reads only the spool past the store's end, and the few bytes before it.
    const from = Math.max(0, dSize - 256);
    const tail = readRange(src, from, sSize - from);
    if (tailMatches(tail.subarray(0, dSize - from), dst, dSize)) {
      const rest = tail.subarray(dSize - from);
      // Only whole lines; a line still being written waits for the next sync.
      const end = rest.lastIndexOf(0x0a) + 1;
      if (end > 0) fs.appendFileSync(dst, rest.subarray(0, end), { mode: 0o600 });
      return;
    }
  }
  const s = readBuf(src);
  if (!s) return;
  const end = s.lastIndexOf(0x0a) + 1;
  if (end === 0) return;
  if (dSize === 0) {
    fs.appendFileSync(dst, s.subarray(0, end), { mode: 0o600 });
    return;
  }
  // The two have diverged (a spool written before it was put back, or a store
  // written while the spool was away), whichever is longer: add the lines the store lacks.
  const known = new Set(lines(readBuf(dst)));
  const extra = lines(s.subarray(0, end)).filter((l) => l.trim() && !known.has(l));
  if (extra.length) appendText(dst, `${extra.join('\n')}\n`);
}

function copyToStore(spool: string, store: string): void {
  for (const name of [POSTS, EVENTS]) copyNewLines(path.join(spool, name), path.join(store, name));
}

/** Copy the spool's new posts and events into the store, for a caller that holds the forum's lock. */
export function copySpoolToStore(id: string): void {
  const { spool, store } = forumLocation(id);
  if (storeReady(id, store)) copyToStore(spool, store);
}

/**
 * Copy the spool's new posts and events into the store, under the forum's lock.
 * Idempotent. Throws when the lock is busy; with `wait: false` it does not wait
 * for it, for a copy that runs again shortly.
 */
export function syncForumStore(id: string, opts: { wait?: boolean } = {}): void {
  const { spool, store } = forumLocation(id);
  if (!fs.existsSync(spool) || !storeReady(id, store)) return;
  withForumLock(spool, () => copyToStore(spool, store), opts);
}

/**
 * Copy the spool into the store once more, then remove it; the store keeps the
 * forum. The copy and the move happen under one hold of the lock, so a writer
 * that comes after finds no forum and says so, rather than posting into a spool
 * about to go. `wait: false`: a busy lock is not waited for.
 */
export function retireForumSpool(id: string, opts: { wait?: boolean } = {}): void {
  const { spool, store } = forumLocation(id);
  if (!fs.existsSync(spool)) return;
  const keep = storeReady(id, store);
  let aside: string | undefined = `${spool}.retired.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
  // A copy that cannot get the lock throws, and the spool stays for a later prune.
  withForumLock(
    spool,
    () => {
      if (keep) copyToStore(spool, store);
      try {
        fs.renameSync(spool, aside!);
      } catch {
        // A platform that cannot move a directory with a file open in it: removed after the lock.
        aside = undefined;
      }
    },
    opts,
  );
  fs.rmSync(aside ?? spool, { recursive: true, force: true });
}

/** A spool moved aside by `retireForumSpool`, left by a process that died before removing it. */
const RETIRED_SPOOL_RE = /\.retired\.\d+\.[0-9a-f]{8}$/;

function newestMtime(files: string[]): number {
  let newest = 0;
  for (const f of files) {
    try {
      newest = Math.max(newest, fs.statSync(f).mtimeMs);
    } catch {
      // Not there.
    }
  }
  return newest;
}

/** Lock files moved aside by a stale-lock break, and temp files of an atomic write that died. */
function clearDebris(dir: string, now: number): void {
  for (const name of fs.readdirSync(dir)) {
    const stale = name.startsWith(`${LOCK}.stale.`);
    const tmp = /\.tmp\.\d+\.[0-9a-f]+$/.test(name);
    if (!stale && !tmp) continue;
    const file = path.join(dir, name);
    if (tmp && now - newestMtime([file]) < 60_000) continue;
    fs.rmSync(file, { force: true });
  }
}

/** What to do with one spool: keep it, copy it into its store and remove it, or remove it outright. */
function spoolVerdict(id: string, dir: string, now: number): 'keep' | 'retire' | 'drop' {
  const recorded = tryReadSpoolConfig(dir)?.store;
  const own = forumLocation(id).store;
  if (typeof recorded === 'string' && path.resolve(recorded) !== path.resolve(own)) {
    // Kept under another clawo home (another CLAWO_WF_DIR): not this process's
    // to judge while that home exists, and nothing to keep once it is gone.
    // The recorded path is only looked at, never written to.
    return fs.existsSync(isStandaloneForumId(id) ? recorded : path.dirname(recorded)) ? 'keep' : 'drop';
  }
  if (isStandaloneForumId(id)) {
    const files = [POSTS, EVENTS, CONFIG].flatMap((n) => [path.join(own, n), path.join(dir, n)]);
    return now - newestMtime(files) > STALE_SPOOL_MS ? 'retire' : 'keep';
  }
  const run = path.dirname(own);
  if (fs.existsSync(run)) {
    const state = tryReadJson<{ state?: RunState }>(path.join(run, 'run.json'))?.state;
    if (state) return isTerminalRunState(state) ? 'retire' : 'keep';
    // A run directory with neither record nor spec holds only what a late forum
    // write put back (its forum/): the run itself is gone. A run being created
    // writes its spec before anything touches its forum.
    if (!fs.existsSync(path.join(run, 'spec.json'))) return 'drop';
    return 'keep';
  }
  // No such run here. A spool that names this store lost its run; one from
  // before spools named their store may be another store's, so it gets a week.
  if (typeof recorded === 'string') return 'drop';
  const files = fs.readdirSync(dir).map((n) => path.join(dir, n));
  return now - newestMtime(files) > STALE_SPOOL_MS ? 'drop' : 'keep';
}

/**
 * Remove the spools nothing needs: those of runs that are terminal (copied into
 * their store first) or gone, and those of forums with no run whose store has
 * not changed for 7 days. A forum with a hub live in this process is left
 * alone. Returns the ids removed.
 */
export function pruneForumSpools(now = Date.now()): string[] {
  let root: string;
  let entries: fs.Dirent[];
  try {
    root = spoolRoot();
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const e of entries) {
    if (e.isDirectory() && RETIRED_SPOOL_RE.test(e.name)) {
      fs.rmSync(path.join(root, e.name), { recursive: true, force: true });
      continue;
    }
    if (!e.isDirectory() || !isValidRunId(e.name) || liveHubs.has(e.name)) continue;
    const dir = path.join(root, e.name);
    try {
      clearDebris(dir, now);
      const verdict = spoolVerdict(e.name, dir, now);
      if (verdict === 'keep') continue;
      // As a retirement does it, so nothing posted meanwhile is lost; a busy lock
      // is left for the next prune rather than waited on as the process starts.
      if (verdict === 'retire') retireForumSpool(e.name, { wait: false });
      else fs.rmSync(dir, { recursive: true, force: true });
      removed.push(e.name);
    } catch {
      // Left for the next prune.
    }
  }
  for (const id of pruneSessionStores(now)) if (!removed.includes(id)) removed.push(id);
  return removed;
}

function processAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * The session forums (`fm-sessions-<pid>-…`, one per process) whose process is
 * gone and whose store has not changed for 7 days: nothing uses the id again,
 * so their store goes, with any spool left of them.
 */
function pruneSessionStores(now: number): string[] {
  const dir = path.join(path.dirname(wfDir()), 'forums');
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const id of names) {
    const m = /^fm-sessions-(\d+)-/.exec(id);
    if (!m || !isValidRunId(id) || liveHubs.has(id) || processAlive(Number(m[1]))) continue;
    try {
      const { spool, store } = forumLocation(id);
      const files = [store, spool].flatMap((d) => {
        try {
          return fs.readdirSync(d).map((n) => path.join(d, n));
        } catch {
          return [];
        }
      });
      if (now - newestMtime(files) <= STALE_SPOOL_MS) continue;
      fs.rmSync(spool, { recursive: true, force: true });
      fs.rmSync(store, { recursive: true, force: true });
      removed.push(id);
    } catch {
      // Left for the next prune.
    }
  }
  return removed;
}

// ─── The authored ledger ────────────────────────────────────────────────────

/**
 * What the ledger holds of a post: every field a reader acts on or shows — its
 * author, text, tags, recipients, references, time, how it got there, its
 * payload and score — so a copy with any of them changed does not match. Of a
 * post as `normalizePost` reads it, which is how the runtime writes one.
 */
export function postHash(p: ForumPost): string {
  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify([
        p.from,
        p.title,
        p.body,
        p.to,
        p.direct ?? [],
        p.visibility ?? null,
        p.tags,
        p.re,
        p.ts,
        p.via ?? null,
        p.data ?? null,
        p.score ?? null,
      ]),
    )
    .digest('hex');
}

/**
 * Vouch for a post the runtime is about to write: in the ledger before the line,
 * so no reader finds the line unvouched. The post as `normalizePost` returns it,
 * so it reads back with the hash it was vouched with.
 */
export function appendAuthored(id: string, post: ForumPost): void {
  const { store } = forumLocation(id);
  if (!storeReady(id, store)) throw new Error(`No forum ${id}: its run is gone`);
  appendLine(path.join(store, AUTHORED), { id: post.id, from: post.from, hash: postHash(post) });
}

const ledgers = new Map<
  string,
  { size: number; mtimeMs: number; entries: Map<string, { from: string; hash: string }> }
>();

/** The authored ledger of a store, by post id; re-read only when the file changed. */
export function authoredLedger(store: string): Map<string, { from: string; hash: string }> {
  const file = path.join(store, AUTHORED);
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    return new Map();
  }
  const cached = ledgers.get(file);
  if (cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs) return cached.entries;
  const entries = new Map<string, { from: string; hash: string }>();
  for (const e of readJsonl<{ id?: unknown; from?: unknown; hash?: unknown }>(file)) {
    if (typeof e?.id === 'string' && typeof e.from === 'string' && typeof e.hash === 'string' && !entries.has(e.id)) {
      entries.set(e.id, { from: e.from, hash: e.hash });
    }
  }
  ledgers.set(file, { size: st.size, mtimeMs: st.mtimeMs, entries });
  return entries;
}

// ─── The runtime's record ───────────────────────────────────────────────────

/** By file: the events read so far and where the reading stopped, and those this process could not write. */
const runtimeRecords = new Map<string, { offset: number; events: ForumEvent[]; unwritten: ForumEvent[] }>();

function runtimeRecord(file: string) {
  let rec = runtimeRecords.get(file);
  if (!rec) runtimeRecords.set(file, (rec = { offset: 0, events: [], unwritten: [] }));
  return rec;
}

/**
 * Put events the runtime itself made on the forum's runtime record (the
 * store's RUNTIME_EVENTS). Kept in this process when the store cannot take
 * them; dropped when the forum's run is gone, so nothing of a deleted run is
 * carried into one that takes its id.
 */
export function recordRuntimeEvents(id: string, events: ForumEvent[]): void {
  if (events.length === 0) return;
  const { store } = forumLocation(id);
  const file = path.join(store, RUNTIME_EVENTS);
  try {
    if (!storeReady(id, store)) return;
    appendText(file, events.map((e) => `${JSON.stringify(e)}\n`).join(''));
    return;
  } catch {
    // Kept in this process below.
  }
  runtimeRecord(file).unwritten.push(...events);
}

/**
 * The events the runtime itself recorded on a forum, oldest first: what its
 * hubs, briefs and turns handed to whom, and who joined and left. A user's or
 * the orchestrator's post counts as had by a member only by this record.
 */
export function forumRuntimeEvents(id: string): ForumEvent[] {
  let file: string;
  try {
    file = path.join(forumLocation(id).store, RUNTIME_EVENTS);
  } catch {
    return [];
  }
  const rec = runtimeRecord(file);
  const size = fileSize(file);
  if (size < rec.offset) {
    rec.offset = 0;
    rec.events = [];
  }
  if (size > rec.offset) {
    const buf = readRange(file, rec.offset, size - rec.offset);
    // Only whole lines; one still being written is read with the next call.
    const end = buf.lastIndexOf(0x0a) + 1;
    for (const line of buf.subarray(0, end).toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        rec.events.push(JSON.parse(line) as ForumEvent);
      } catch {
        // A torn line.
      }
    }
    rec.offset += end;
  }
  return rec.unwritten.length ? [...rec.events, ...rec.unwritten] : rec.events;
}

// ─── Reading a forum ────────────────────────────────────────────────────────

/** All of a forum's posts and events. */
export interface ForumView {
  posts: ForumPost[];
  events: ForumEvent[];
}

export function viewOf(id: string): ForumView {
  // The spool is the live copy; the durable one can trail it by a second, and is all there is once it retires.
  const { spool, store } = forumLocation(id);
  const pick = (name: string) => {
    const s = path.join(spool, name);
    const d = path.join(store, name);
    const sLen = fs.existsSync(s) ? fs.statSync(s).size : -1;
    const dLen = fs.existsSync(d) ? fs.statSync(d).size : -1;
    return sLen >= dLen ? s : d;
  };
  return { posts: readPosts(pick(POSTS)), events: readJsonl<ForumEvent>(pick(EVENTS)) };
}

/**
 * The id after the highest one on the forum, so a torn or removed line never
 * gives an id out twice. A number past MAX_COUNTED_POST is not counted, and an
 * id a post already has is passed over.
 */
export function nextPostId(posts: ForumPost[]): string {
  let max = 0;
  const taken = new Set<string>();
  for (const p of posts) {
    taken.add(p.id);
    const m = /^p(\d+)$/.exec(p.id);
    const n = m ? Number(m[1]) : NaN;
    if (n <= MAX_COUNTED_POST) max = Math.max(max, n);
  }
  const id = (n: number) => `p${String(n).padStart(5, '0')}`;
  let next = max + 1;
  while (taken.has(id(next))) next++;
  return id(next);
}
