/**
 * Unit tests for src/validation.ts — shared input validation utilities.
 */

import { describe, it, expect } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';

import { sanitizeCwd, validateRegex, validateName } from '../validation.js';

// ─── sanitizeCwd ────────────────────────────────────────────────────────────

describe('sanitizeCwd', () => {
  it('returns undefined for undefined input', () => {
    expect(sanitizeCwd(undefined)).toBeUndefined();
  });

  it('returns undefined for empty string', () => {
    expect(sanitizeCwd('')).toBeUndefined();
  });

  it('returns resolved absolute path for valid input', () => {
    const home = os.homedir();
    const result = sanitizeCwd(home);
    expect(result).toBe(home);
  });

  it('resolves relative paths', () => {
    const result = sanitizeCwd('./some-project');
    expect(path.isAbsolute(result!)).toBe(true);
  });

  it('throws for filesystem root /', () => {
    expect(() => sanitizeCwd('/')).toThrow('Unsafe working directory');
  });

  it('throws for /etc', () => {
    expect(() => sanitizeCwd('/etc')).toThrow('Unsafe working directory');
  });

  it('throws for /etc/passwd parent', () => {
    expect(() => sanitizeCwd('/etc/nginx')).toThrow('Unsafe working directory');
  });

  it('throws for /proc', () => {
    expect(() => sanitizeCwd('/proc')).toThrow('Unsafe working directory');
  });

  it('throws for /sys', () => {
    expect(() => sanitizeCwd('/sys/class')).toThrow('Unsafe working directory');
  });

  it('throws for /var/run', () => {
    expect(() => sanitizeCwd('/var/run')).toThrow('Unsafe working directory');
  });

  it('throws for /var/log', () => {
    expect(() => sanitizeCwd('/var/log')).toThrow('Unsafe working directory');
  });

  it('throws for /boot', () => {
    expect(() => sanitizeCwd('/boot')).toThrow('Unsafe working directory');
  });

  it('throws for /sbin', () => {
    expect(() => sanitizeCwd('/sbin')).toThrow('Unsafe working directory');
  });

  it('throws for ~/.ssh', () => {
    expect(() => sanitizeCwd(path.join(os.homedir(), '.ssh'))).toThrow('Unsafe working directory');
  });

  it('throws for ~/.ssh/keys subdir', () => {
    expect(() => sanitizeCwd(path.join(os.homedir(), '.ssh', 'keys'))).toThrow('Unsafe working directory');
  });

  it('throws for ~/.gnupg', () => {
    expect(() => sanitizeCwd(path.join(os.homedir(), '.gnupg'))).toThrow('Unsafe working directory');
  });

  it('throws for ~/.aws', () => {
    expect(() => sanitizeCwd(path.join(os.homedir(), '.aws'))).toThrow('Unsafe working directory');
  });

  it('throws for ~/.config/gcloud', () => {
    expect(() => sanitizeCwd(path.join(os.homedir(), '.config', 'gcloud'))).toThrow('Unsafe working directory');
  });

  it('resolves path traversal before checking', () => {
    // ../../../etc should resolve to /etc and be blocked
    expect(() => sanitizeCwd('/tmp/../etc')).toThrow('Unsafe working directory');
  });

  it('allows valid project directories', () => {
    const result = sanitizeCwd(path.join(os.homedir(), 'projects', 'my-app'));
    expect(result).toBe(path.join(os.homedir(), 'projects', 'my-app'));
  });

  it('allows /tmp as working directory', () => {
    const result = sanitizeCwd('/tmp');
    // /tmp may be a symlink on macOS to /private/tmp — both are acceptable
    expect(result).toBeTruthy();
  });
});

// ─── validateRegex ──────────────────────────────────────────────────────────

describe('validateRegex', () => {
  it('returns a regex-like object for valid pattern', () => {
    const result = validateRegex('hello');
    expect(typeof result.test).toBe('function');
    expect(result.test('HELLO')).toBe(true); // case insensitive
  });

  it('returns case-insensitive regex', () => {
    const result = validateRegex('test');
    expect(result.flags).toContain('i');
  });

  it('supports regex special characters', () => {
    const result = validateRegex('foo.*bar');
    expect(result.test('foo123bar')).toBe(true);
  });

  it('throws for invalid regex syntax', () => {
    expect(() => validateRegex('[unclosed')).toThrow('Invalid regex pattern');
  });

  it('throws for unbalanced parentheses', () => {
    expect(() => validateRegex('(abc')).toThrow('Invalid regex pattern');
  });

  it('runs catastrophic-backtracking patterns in linear time (no ReDoS)', () => {
    // (a+)+$ against 'a'*30 + '!' would hang a backtracking engine for seconds.
    // RE2 evaluates this in microseconds.
    const regex = validateRegex('(a+)+$');
    const input = 'a'.repeat(30) + '!';
    const start = Date.now();
    expect(regex.test(input)).toBe(false);
    expect(Date.now() - start).toBeLessThan(100);
  });

  it('stays linear on long input', () => {
    const regex = validateRegex('(a+)+$');
    const input = 'a'.repeat(100_000) + '!';
    const start = Date.now();
    expect(regex.test(input)).toBe(false);
    expect(Date.now() - start).toBeLessThan(2000);
  });

  it('rejects lookbehind and backreferences', () => {
    expect(() => validateRegex('(?<=a)b')).toThrow('Invalid regex pattern');
    expect(() => validateRegex('(a)\\1')).toThrow('Invalid regex pattern');
  });

  it('accepts JavaScript escape syntax and named groups', () => {
    expect(validateRegex('caf\\u00e9').test('CAFÉ')).toBe(true);
    expect(validateRegex('(?<word>abc)').test('xABCx')).toBe(true);
  });

  it('rejects escapes RE2 does not define instead of reading them as literals', () => {
    for (const pattern of ['(?<n>a)\\k<n>', '\\8', '\\e', '\\q', '\\c', '\\ca', '[\\ca]', '\\u{L}', '\\x{L}']) {
      expect(() => validateRegex(pattern), pattern).toThrow('Invalid regex pattern');
    }
    expect(validateRegex('[\\cA]').test('\x01')).toBe(true);
  });

  it('reads a ] right after [ or [^ as a class member, as RE2 does', () => {
    expect(validateRegex('[]a]').test(']')).toBe(true);
    expect(validateRegex('token=[^]\\s"]+').test('token=abc] x')).toBe(true);
    expect(() => validateRegex('[]')).toThrow('Invalid regex pattern');
    expect(() => validateRegex('[^]')).toThrow('Invalid regex pattern');
  });

  it('accepts Unicode property long names and scripts', () => {
    expect(validateRegex('\\p{Letter}+').test('é')).toBe(true);
    expect(validateRegex('\\p{Uppercase_Letter}').test('x')).toBe(true); // case-insensitive
    expect(validateRegex('\\p{Script=Greek}').test('α')).toBe(true);
    expect(validateRegex('\\p{sc=Greek}').test('a')).toBe(false);
  });

  it('rejects \\C, which matches one UTF-8 byte rather than a character', () => {
    expect(() => validateRegex('\\C')).toThrow('Invalid regex pattern');
  });

  it('reads \\u with one to three hex digits as a code point', () => {
    expect(validateRegex('\\u41').test('a')).toBe(true);
    expect(validateRegex('\\u41').test('u41')).toBe(false);
  });

  it('folds non-ASCII case', () => {
    expect(validateRegex('ÄBC').test('äbc')).toBe(true);
  });

  it('is not stateful between calls', () => {
    const regex = validateRegex('abc');
    expect(regex.test('abc')).toBe(true);
    expect(regex.test('abc')).toBe(true);
  });
});

// ─── validateName ───────────────────────────────────────────────────────────

describe('validateName', () => {
  it('accepts simple alphanumeric name', () => {
    expect(validateName('myagent')).toBe('myagent');
  });

  it('accepts name with hyphens', () => {
    expect(validateName('my-agent')).toBe('my-agent');
  });

  it('accepts name with underscores', () => {
    expect(validateName('agent_1')).toBe('agent_1');
  });

  it('accepts mixed case', () => {
    expect(validateName('ABCdef123')).toBe('ABCdef123');
  });

  it('rejects path traversal attempt', () => {
    expect(() => validateName('../../etc/evil')).toThrow('Invalid name');
  });

  it('rejects name with spaces', () => {
    expect(() => validateName('name with spaces')).toThrow('Invalid name');
  });

  it('rejects name with dots', () => {
    expect(() => validateName('name.md')).toThrow('Invalid name');
  });

  it('rejects name with slashes', () => {
    expect(() => validateName('path/name')).toThrow('Invalid name');
  });

  it('rejects empty string', () => {
    expect(() => validateName('')).toThrow('Invalid name');
  });
});
