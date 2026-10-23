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

/** Printable ASCII plus the em dash, 1–300 characters, one line. */
const BOUNDED_REASON = /^[\x20-\x7E\u2014]{1,300}$/;

/**
 * A short, single-line reason for a log line, or `unknown error`.
 *
 * Reads only a string `err` or the data-descriptor `message` of an object: no
 * getter, `toString` or class name is invoked. A Proxy's descriptor trap can
 * still run. Text outside the allowed form is replaced, never truncated, and
 * known secret shapes are redacted.
 */
export function boundedErrorReason(err: unknown): string {
  let text: unknown;
  try {
    if (typeof err === 'string') {
      text = err;
    } else if ((typeof err === 'object' && err !== null) || typeof err === 'function') {
      const descriptor = Object.getOwnPropertyDescriptor(err, 'message');
      if (descriptor && 'value' in descriptor) text = descriptor.value;
    }
  } catch {
    return 'unknown error';
  }
  if (typeof text !== 'string' || !BOUNDED_REASON.test(text)) return 'unknown error';
  const redacted = sanitizeSecrets(text);
  return BOUNDED_REASON.test(redacted) ? redacted : 'unknown error';
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
