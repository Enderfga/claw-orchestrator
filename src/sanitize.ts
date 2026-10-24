import RE2 from 're2';

/**
 * Shared stderr secret redaction.
 *
 * Every engine pipes CLI stderr into session LOG events, and failing CLIs
 * routinely dump auth headers or env vars there. These patterns used to be
 * hand-copied per engine (claude, gemini, cursor, opencode, custom — each a
 * slightly different subset), which meant every new engine grew another
 * divergent, weaker copy. This module is the single source of truth; engines
 * call sanitizeSecrets(), and persistent-custom-session's buildSanitizer()
 * extends SECRET_PATTERNS with user-configured RE2 patterns.
 */

export const SECRET_PATTERNS: ReadonlyArray<{ re: RegExp; replacement: string }> = [
  // Authorization headers. The charset includes '.' so dotted tokens
  // (e.g. Google OAuth ya29.* access tokens) are redacted whole.
  { re: /Bearer [a-zA-Z0-9._-]+/g, replacement: 'Bearer ***' },
  // OpenAI/Anthropic-style secret keys (sk-, sk-ant-, sk-proj-)
  { re: /sk-[a-zA-Z0-9_-]{10,}/g, replacement: 'sk-***' },
  // Generic `api_key: <value>` / `apiKey=<value>` assignments
  { re: /(api[_-]?key["':= ]+)[a-zA-Z0-9._-]+/gi, replacement: '$1***' },
  // SCREAMING_CASE secret env vars dumped to stderr
  // (GEMINI_API_KEY=…, CURSOR_API_KEY=…, ANTHROPIC_API_KEY=…, *_TOKEN=…, *_SECRET=…)
  { re: /\b([A-Z][A-Z0-9_]*(?:_KEY|_TOKEN|_SECRET))=\S+/g, replacement: '$1=***' },
];

/** Redact known secret shapes from a chunk of CLI output. */
export function sanitizeSecrets(text: string): string {
  let result = text;
  for (const { re, replacement } of SECRET_PATTERNS) {
    re.lastIndex = 0;
    result = result.replace(re, replacement);
  }
  return result;
}

/**
 * A short, single-line reason for a log line, or `unknown error`.
 *
 * Source is `err instanceof Error ? err.message : String(err)`; a throw during
 * that conversion returns `unknown error`. Whitespace runs become one space,
 * then trim; known secret shapes are redacted; the result is capped at 300
 * UTF-16 units (a trailing high surrogate is dropped). Empty output, or any
 * Unicode Cc/Cf code point, becomes `unknown error`.
 */
export function boundedErrorReason(err: unknown): string {
  let text: string;
  try {
    text = err instanceof Error ? err.message : String(err);
  } catch {
    return 'unknown error';
  }
  text = text.replace(/\s+/g, ' ').trim();
  text = sanitizeSecrets(text);
  text = text.slice(0, 300);
  if (/[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1);
  if (!text || /[\p{Cc}\p{Cf}]/u.test(text)) return 'unknown error';
  return text;
}

export interface SanitizerOptions {
  extraPatterns?: string[];
  label?: string;
}

/** Build a sanitizer from common secret patterns plus optional config patterns. */
export function buildSanitizer(options: SanitizerOptions = {}): (text: string) => string {
  const patterns: Array<{ re: RegExp; replacement: string }> = [...SECRET_PATTERNS];
  for (const pattern of options.extraPatterns || []) {
    try {
      // RE2 runs in linear time and never backtracks, so user-supplied sanitize
      // patterns cannot trigger ReDoS on attacker-influenced output.
      patterns.push({ re: new RE2(pattern, 'g') as unknown as RegExp, replacement: '***' });
    } catch (err) {
      const label = options.label ? `[${options.label}] ` : '';
      console.warn(`${label}ignoring invalid sanitizePattern ${JSON.stringify(pattern)}: ${(err as Error).message}`);
    }
  }

  return (text: string): string => {
    let result = text;
    for (const { re, replacement } of patterns) {
      re.lastIndex = 0;
      result = result.replace(re, replacement);
    }
    return result;
  };
}
