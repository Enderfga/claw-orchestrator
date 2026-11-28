/**
 * A per-session Cursor config directory, so a session never writes the user's.
 *
 * `cursor-agent --model M` stores M as the user's default model: it rewrites
 * `model`, `selectedModel` and `modelSelectionHistory` in `cli-config.json`
 * (2026.11.22, measured), and a later run with no `--model` — the user's own, or
 * another session's — runs on it. `CURSOR_CONFIG_DIR` moves that file, and with
 * it everything else Cursor keeps in the directory: chats, permissions, skills,
 * commands, MCP servers, plugins. So the session gets a directory of its own in
 * which every entry links to the user's, except `cli-config.json`, which is a
 * copy taken before each turn: what the run writes into it stays there, and a
 * setting the user changes meanwhile reaches the next turn. Chats are written
 * through the `chats` link, so `--resume` finds them from any directory. The
 * login is not in this directory: on macOS it is in the keychain, elsewhere in an
 * `auth.json` whose path Cursor derives without `CURSOR_CONFIG_DIR`.
 */

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** The config file Cursor writes its model selection into. */
export const CURSOR_CONFIG_FILE = 'cli-config.json';

/** The directory Cursor reads its config from, as Cursor works it out. */
export function cursorConfigHome(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.CURSOR_CONFIG_DIR?.trim();
  if (explicit) return explicit;
  const xdg = env.XDG_CONFIG_HOME?.trim();
  return xdg ? path.join(xdg, 'cursor') : path.join(os.homedir(), '.cursor');
}

export interface CursorConfigMirrorOptions {
  /** The user's config directory; `cursorConfigHome()` by default. */
  source?: string;
  /** Entries made as empty directories of the mirror's own instead of links (what a run must not add to). */
  isolate?: readonly string[];
}

/**
 * A directory to run Cursor with as `CURSOR_CONFIG_DIR`. `prepare()` before
 * each process; `remove()` once no process uses it.
 */
export class CursorConfigMirror {
  private readonly source: string;
  private readonly isolate: ReadonlySet<string>;

  constructor(
    readonly dir: string,
    opts: CursorConfigMirrorOptions = {},
  ) {
    this.source = opts.source ?? cursorConfigHome();
    this.isolate = new Set(opts.isolate ?? []);
  }

  /**
   * Link what the user's directory holds now and copy its config file. Returns
   * the directory, or undefined when the user has no config directory (Cursor
   * then makes one on its first run, and there is nothing of the user's to
   * protect) or the links cannot be made here (Windows without symlink rights):
   * the caller then runs Cursor as it would without a mirror.
   */
  prepare(): string | undefined {
    if (!fs.existsSync(this.source)) return undefined;
    try {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      // Chats must land in the user's directory: create it where Cursor would, so the link has a target.
      fs.mkdirSync(path.join(this.source, 'chats'), { recursive: true });
      for (const name of fs.readdirSync(this.source)) {
        if (name === CURSOR_CONFIG_FILE) continue;
        const at = path.join(this.dir, name);
        if (this.isolate.has(name)) {
          fs.mkdirSync(at, { recursive: true });
          continue;
        }
        if (exists(at)) continue;
        const target = path.join(this.source, name);
        const dir = fs.statSync(target).isDirectory();
        fs.symlinkSync(target, at, dir && process.platform === 'win32' ? 'junction' : dir ? 'dir' : 'file');
      }
      const config = path.join(this.source, CURSOR_CONFIG_FILE);
      const copy = path.join(this.dir, CURSOR_CONFIG_FILE);
      if (fs.existsSync(config)) {
        fs.rmSync(copy, { force: true });
        fs.copyFileSync(config, copy);
        fs.chmodSync(copy, 0o600);
      }
      return this.dir;
    } catch {
      this.remove();
      return undefined;
    }
  }

  /** Delete the directory: its links, never what they point at. */
  remove(): void {
    try {
      fs.rmSync(this.dir, { recursive: true, force: true });
    } catch {
      // Already gone.
    }
  }
}

/**
 * Run a short Cursor command (`models`, `about`) with an environment whose
 * config directory is a throwaway mirror: even these refresh caches in
 * `cli-config.json`. The mirror is removed once `fn` settles, by which time the
 * command has exited.
 */
export async function withCursorConfigMirror<T>(fn: (env: NodeJS.ProcessEnv) => Promise<T>): Promise<T> {
  const mirror = new CursorConfigMirror(path.join(os.tmpdir(), `claw-cursor-cfg-${randomUUID()}`));
  const dir = mirror.prepare();
  try {
    return await fn({ ...process.env, ...(dir ? { CURSOR_CONFIG_DIR: dir } : {}) });
  } finally {
    mirror.remove();
  }
}

/** Whether `p` exists, a dangling link included. */
function exists(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}
