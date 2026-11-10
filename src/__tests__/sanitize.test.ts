/**
 * Unit tests for src/sanitize.ts — user-configured sanitize patterns.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

import { buildSanitizer } from '../sanitize.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('buildSanitizer extraPatterns', () => {
  it('redacts every match, and again on a second call', () => {
    const sanitize = buildSanitizer({ extraPatterns: ['tok-[0-9]+'] });
    const input = 'a tok-123 b tok-456 c';
    expect(sanitize(input)).toBe('a *** b *** c');
    expect(sanitize(input)).toBe('a *** b *** c');
  });

  it('is case-sensitive', () => {
    const sanitize = buildSanitizer({ extraPatterns: ['secret'] });
    expect(sanitize('secret SECRET')).toBe('*** SECRET');
  });

  it('keeps the built-in secret patterns', () => {
    const sanitize = buildSanitizer({ extraPatterns: ['tok-[0-9]+'] });
    expect(sanitize('Bearer abc.def tok-1')).toBe('Bearer *** ***');
  });

  it('accepts JavaScript escape syntax and matches non-ASCII text', () => {
    const sanitize = buildSanitizer({ extraPatterns: ['caf\\u00e9', '(?<word>ü+)'] });
    expect(sanitize('café Grüße')).toBe('*** Gr***ße');
  });

  it('keeps a ] right after [^ inside the class', () => {
    const sanitize = buildSanitizer({ extraPatterns: ['token=[^]\\s"]+'] });
    expect(sanitize('token=abc] x')).toBe('***] x');
  });

  it('inserts at empty matches like String.prototype.replace', () => {
    const sanitize = buildSanitizer({ extraPatterns: ['x*'] });
    expect(sanitize('ab')).toBe('ab'.replace(/x*/g, '***'));
  });

  it('ignores an invalid pattern with a warning and applies the rest', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sanitize = buildSanitizer({ extraPatterns: ['(?<=a)b', '[unclosed', 'tok'], label: 'eng' });
    expect(sanitize('ab tok')).toBe('ab ***');
    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[0][0])).toContain('[eng] ignoring invalid sanitizePattern "(?<=a)b"');
  });

  it('runs catastrophic-backtracking patterns in linear time', () => {
    const sanitize = buildSanitizer({ extraPatterns: ['(a+)+$'] });
    const input = 'a'.repeat(100_000) + '!';
    const start = Date.now();
    expect(sanitize(input)).toBe(input);
    expect(Date.now() - start).toBeLessThan(2000);
  });
});
