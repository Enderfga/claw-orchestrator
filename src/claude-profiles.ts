/**
 * Claude account profiles.
 *
 * A profile names a Claude Code configuration directory (`CLAUDE_CONFIG_DIR`),
 * which is what selects the logged-in account. One server can then run sessions
 * for several accounts: a request says `claudeProfile: 'work'` and the server
 * looks the directory up in its own file. A request never carries a path, so a
 * caller cannot point a session at a directory the server's owner did not list.
 *
 * File: `~/.claw-orchestrator/claude-profiles.json` (override: `CLAWO_CLAUDE_PROFILES`)
 *
 *   { "personal": "C:\\Users\\me\\.claude", "work": "C:\\Users\\me\\.claude-work" }
 *
 * Each directory must already exist: Claude Code creates a missing one and asks
 * for a new login, which would turn a typo into a silent second account.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const PROFILE_NAME = /^[A-Za-z0-9_-]{1,40}$/;

export function claudeProfilesFile(): string {
  return process.env.CLAWO_CLAUDE_PROFILES || path.join(os.homedir(), '.claw-orchestrator', 'claude-profiles.json');
}

/** Read the profiles file. A missing file means no profiles; a bad one throws. */
export function loadClaudeProfiles(file: string = claudeProfilesFile()): Record<string, string> {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error(`Cannot read the Claude profiles file ${file}: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`The Claude profiles file ${file} is not valid JSON`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`The Claude profiles file ${file} must be an object mapping a profile name to a directory`);
  }
  const profiles: Record<string, string> = {};
  for (const [name, dir] of Object.entries(parsed as Record<string, unknown>)) {
    if (!PROFILE_NAME.test(name)) {
      throw new Error(`Claude profile name "${name}" is not valid: use letters, digits, "-" or "_" (1-40 characters)`);
    }
    if (typeof dir !== 'string' || !path.isAbsolute(dir)) {
      throw new Error(`Claude profile "${name}" must map to an absolute directory path`);
    }
    profiles[name] = path.resolve(dir);
  }
  return profiles;
}

/** The configuration directory a profile names. Throws on an unknown profile or a missing directory. */
export function resolveClaudeProfile(name: string, file: string = claudeProfilesFile()): string {
  const profiles = loadClaudeProfiles(file);
  const dir = Object.prototype.hasOwnProperty.call(profiles, name) ? profiles[name] : undefined;
  if (!dir) {
    const known = Object.keys(profiles);
    throw new Error(
      `Unknown Claude profile "${name}"` +
        (known.length > 0 ? ` (known: ${known.join(', ')})` : `; no profiles are defined, create ${file}`),
    );
  }
  let isDir = false;
  try {
    isDir = fs.statSync(dir).isDirectory();
  } catch {
    /* reported below */
  }
  if (!isDir) {
    throw new Error(`Claude profile "${name}" points at ${dir}, which is not an existing directory`);
  }
  return dir;
}
