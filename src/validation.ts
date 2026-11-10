/**
 * Shared validation utilities for input sanitization.
 *
 * Used by both the plugin tool handlers (index.ts) and the embedded HTTP
 * server (embedded-server.ts) to ensure consistent protection regardless
 * of entry point.
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { RE2JS } from 're2js';

// ─── Blocked Path Prefixes ─────────────────────────────────────────────────

/** System-critical directories that must never be used as a working directory */
const BLOCKED_PREFIXES = ['/etc', '/proc', '/sys', '/var/run', '/var/log', '/boot', '/sbin'];

/** Sensitive directories under the user's home that must never be used as cwd */
const BLOCKED_HOME_SUBDIRS = ['.ssh', '.gnupg', '.aws', '.config/gcloud'];

// ─── sanitizeCwd ────────────────────────────────────────────────────────────

/**
 * Resolve and validate a working directory path.
 *
 * Prevents path traversal and blocks access to system-critical and
 * sensitive directories. Resolves symlinks where possible to defeat
 * symlink-based bypasses.
 */
export function sanitizeCwd(cwd: string | undefined): string | undefined {
  if (!cwd) return undefined;

  // Logical path: resolves .. and . but does NOT follow symlinks.
  // This catches the obvious cases (/etc, /var/run, /sbin) on all platforms.
  const logical = path.resolve(cwd);

  // Real path: follows symlinks. This catches symlink-based bypasses
  // (e.g. /tmp/safe → /etc). Falls back to logical for non-existent paths.
  let real: string;
  try {
    real = fs.realpathSync(cwd);
  } catch {
    real = logical;
  }

  // Collect all paths to check — logical, real, and their de-prefixed
  // variants for macOS where /etc → /private/etc, /var → /private/var.
  const pathsToCheck = new Set([logical, real]);
  for (const p of [logical, real]) {
    if (p.startsWith('/private/')) {
      pathsToCheck.add(p.slice('/private'.length));
    }
  }

  // Block filesystem root
  for (const check of pathsToCheck) {
    if (check === '/') {
      throw new Error(`Unsafe working directory: ${logical}`);
    }
  }

  // Block system-critical prefixes
  for (const check of pathsToCheck) {
    for (const prefix of BLOCKED_PREFIXES) {
      if (check === prefix || check.startsWith(prefix + '/')) {
        throw new Error(`Unsafe working directory: ${logical}`);
      }
    }
  }

  // Block sensitive home subdirectories
  const home = os.homedir();
  for (const check of pathsToCheck) {
    for (const subdir of BLOCKED_HOME_SUBDIRS) {
      const sensitive = path.join(home, subdir);
      if (check === sensitive || check.startsWith(sensitive + '/')) {
        throw new Error(`Unsafe working directory: ${logical}`);
      }
    }
  }

  return real;
}

// ─── validateRegex ──────────────────────────────────────────────────────────

/** Unicode general-category long names accepted by `\p{…}`, as native `re2` maps them. */
const UNICODE_CLASS_NAMES: Readonly<Record<string, string>> = {
  Uppercase_Letter: 'Lu',
  Lowercase_Letter: 'Ll',
  Titlecase_Letter: 'Lt',
  Cased_Letter: 'LC',
  Modifier_Letter: 'Lm',
  Other_Letter: 'Lo',
  Letter: 'L',
  Nonspacing_Mark: 'Mn',
  Spacing_Mark: 'Mc',
  Enclosing_Mark: 'Me',
  Mark: 'M',
  Decimal_Number: 'Nd',
  Letter_Number: 'Nl',
  Other_Number: 'No',
  Number: 'N',
  Connector_Punctuation: 'Pc',
  Dash_Punctuation: 'Pd',
  Open_Punctuation: 'Ps',
  Close_Punctuation: 'Pe',
  Initial_Punctuation: 'Pi',
  Final_Punctuation: 'Pf',
  Other_Punctuation: 'Po',
  Punctuation: 'P',
  Math_Symbol: 'Sm',
  Currency_Symbol: 'Sc',
  Modifier_Symbol: 'Sk',
  Other_Symbol: 'So',
  Symbol: 'S',
  Space_Separator: 'Zs',
  Line_Separator: 'Zl',
  Paragraph_Separator: 'Zp',
  Separator: 'Z',
  Control: 'Cc',
  Format: 'Cf',
  Surrogate: 'Cs',
  Private_Use: 'Co',
  Unassigned: 'Cn',
  Other: 'C',
};

/**
 * Rewrite the JavaScript-only escapes native `re2` accepted into RE2 syntax, as
 * its `translateRegExp` does: `\cX`, `\u` with one to four hex digits or
 * `\u{…}`, and `\p{…}` / `\P{…}` long names (`Letter`, `Script=Greek`,
 * `sc=Greek`). Everything else is left to the RE2 parser, which rejects what RE2
 * does not define (`\k<name>`, `\8`, lookbehind, …).
 */
function toRe2Syntax(pattern: string): string {
  const hexRun = /[0-9A-Fa-f]{1,4}/y;
  let noBraceAfter = pattern.length; // no '}' at or after this index
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch !== '\\' || i + 1 >= pattern.length) {
      out += ch;
      continue;
    }
    const next = pattern[i + 1];
    const after = pattern[i + 2] ?? '';
    let close = -1;
    if ((next === 'p' || next === 'P') && after === '{' && i + 3 < noBraceAfter) {
      close = pattern.indexOf('}', i + 3);
      if (close === -1) noBraceAfter = i + 3;
    }
    if (next === 'c' && after >= 'A' && after <= 'Z') {
      out += `\\x${(after.charCodeAt(0) - 64).toString(16).padStart(2, '0')}`;
      i += 2;
    } else if (next === 'u' && /[0-9A-Fa-f]/.test(after)) {
      hexRun.lastIndex = i + 2;
      const hex = hexRun.exec(pattern)![0];
      out += `\\x{${hex}}`;
      i += 1 + hex.length;
    } else if (next === 'u' && after === '{') {
      out += '\\x';
      i += 1;
    } else if (close !== -1) {
      let name = pattern.slice(i + 3, close);
      if (Object.hasOwn(UNICODE_CLASS_NAMES, name)) name = UNICODE_CLASS_NAMES[name];
      else if (name.length > 7 && name.startsWith('Script=')) name = name.slice(7);
      else if (name.length > 3 && name.startsWith('sc=')) name = name.slice(3);
      out += name.length === 1 ? `\\${next}${name}` : `\\${next}{${name}}`;
      i = close;
    } else {
      out += ch + next;
      i++;
    }
  }
  return out;
}

/** A user-supplied pattern compiled by {@link compileSafeRegex}. */
export interface SafeRegex {
  /** `'i'` when compiled case-insensitively, otherwise `''`. */
  readonly flags: string;
  /** Whether the pattern matches anywhere in `text`. */
  test(text: string): boolean;
  /** `text` with every match replaced by the literal `replacement`. */
  replaceAll(text: string, replacement: string): string;
}

/**
 * Compile a user-supplied pattern with RE2 semantics (re2js, pure JavaScript).
 *
 * RE2 runs in linear time and never backtracks, so it is immune to ReDoS
 * patterns like `(a+)+$`. JavaScript escape syntax is translated as native `re2`
 * did (`\u00e9`, `\cA`, `\p{Letter}`, `(?<name>…)`); lookbehind, backreferences
 * and `\C` (one UTF-8 byte) throw at compile time.
 */
export function compileSafeRegex(pattern: string, options: { ignoreCase?: boolean } = {}): SafeRegex {
  const ignoreCase = options.ignoreCase === true;
  const re = RE2JS.compile(toRe2Syntax(pattern), ignoreCase ? RE2JS.CASE_INSENSITIVE : 0);
  return {
    flags: ignoreCase ? 'i' : '',
    test: (text) => re.test(text),
    replaceAll: (text, replacement) => re.matcher(text).replaceAll(() => replacement),
  };
}

/** Compile a user-supplied search pattern, case-insensitively; throws `Invalid regex pattern: …`. */
export function validateRegex(pattern: string): SafeRegex {
  try {
    return compileSafeRegex(pattern, { ignoreCase: true });
  } catch (err) {
    throw new Error(`Invalid regex pattern: ${(err as Error).message}`);
  }
}

// ─── validateName ───────────────────────────────────────────────────────────

const VALID_NAME = /^[a-zA-Z0-9_-]+$/;

/**
 * Validate a resource name (agent, skill, rule) to prevent path injection.
 *
 * Only allows alphanumeric characters, hyphens, and underscores.
 * Rejects empty strings, dots, slashes, spaces, and any other characters
 * that could be used for path traversal.
 */
export function validateName(name: string): string {
  if (!name || !VALID_NAME.test(name)) {
    throw new Error(`Invalid name '${name}': must be non-empty and match /^[a-zA-Z0-9_-]+$/`);
  }
  return name;
}
