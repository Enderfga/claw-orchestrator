/**
 * CursorConfigMirror — a session's own Cursor config directory, built from the user's.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CursorConfigMirror, cursorConfigHome } from '../cursor-config-dir.js';

const made: string[] = [];
const tmp = (prefix: string) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function userHome(): string {
  const home = tmp('cursor-home-');
  fs.writeFileSync(path.join(home, 'cli-config.json'), '{"model":{"modelId":"auto-smart"}}');
  fs.writeFileSync(path.join(home, 'mcp.json'), '{}');
  fs.mkdirSync(path.join(home, 'skills', 'mine'), { recursive: true });
  fs.writeFileSync(path.join(home, 'skills', 'mine', 'SKILL.md'), '# mine');
  fs.mkdirSync(path.join(home, 'acp-sessions'));
  return home;
}

describe('CursorConfigMirror', () => {
  it('links every entry of the user directory and copies only the config file', () => {
    const home = userHome();
    const dir = path.join(tmp('cursor-mirror-'), 'm');
    const mirror = new CursorConfigMirror(dir, { source: home });
    expect(mirror.prepare()).toBe(dir);
    expect(fs.lstatSync(path.join(dir, 'skills')).isSymbolicLink()).toBe(true);
    expect(fs.lstatSync(path.join(dir, 'mcp.json')).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'skills', 'mine', 'SKILL.md'), 'utf8')).toBe('# mine');
    // Chats are written through to the user's directory, made where Cursor would make it.
    expect(fs.lstatSync(path.join(dir, 'chats')).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(path.join(home, 'chats'))).toBe(true);
    const copy = path.join(dir, 'cli-config.json');
    expect(fs.lstatSync(copy).isSymbolicLink()).toBe(false);
    expect(fs.statSync(copy).mode & 0o777).toBe(0o600);
    // A write to the copy stays in the mirror; the next prepare takes the user's file again.
    fs.writeFileSync(copy, '{"model":{"modelId":"gpt-5.4-mini"}}');
    expect(fs.readFileSync(path.join(home, 'cli-config.json'), 'utf8')).toContain('auto-smart');
    mirror.prepare();
    expect(fs.readFileSync(copy, 'utf8')).toContain('auto-smart');
  });

  it('removes its links and never what they point at', () => {
    const home = userHome();
    const dir = path.join(tmp('cursor-mirror-'), 'm');
    const mirror = new CursorConfigMirror(dir, { source: home });
    mirror.prepare();
    mirror.remove();
    expect(fs.existsSync(dir)).toBe(false);
    expect(fs.readFileSync(path.join(home, 'skills', 'mine', 'SKILL.md'), 'utf8')).toBe('# mine');
    expect(fs.existsSync(path.join(home, 'mcp.json'))).toBe(true);
  });

  it('gives an isolated entry a directory of its own', () => {
    const home = userHome();
    const dir = path.join(tmp('cursor-mirror-'), 'm');
    new CursorConfigMirror(dir, { source: home, isolate: ['acp-sessions'] }).prepare();
    const own = path.join(dir, 'acp-sessions');
    expect(fs.lstatSync(own).isSymbolicLink()).toBe(false);
    fs.writeFileSync(path.join(own, 'x'), '');
    expect(fs.readdirSync(path.join(home, 'acp-sessions'))).toEqual([]);
  });

  it('builds nothing when the user has no Cursor config directory', () => {
    const dir = path.join(tmp('cursor-mirror-'), 'm');
    expect(new CursorConfigMirror(dir, { source: path.join(dir, 'absent') }).prepare()).toBeUndefined();
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('finds the user directory as Cursor does', () => {
    expect(cursorConfigHome({ CURSOR_CONFIG_DIR: '/x/cfg' })).toBe('/x/cfg');
    expect(cursorConfigHome({ XDG_CONFIG_HOME: '/x/xdg' })).toBe(path.join('/x/xdg', 'cursor'));
    expect(cursorConfigHome({})).toBe(path.join(os.homedir(), '.cursor'));
  });
});
