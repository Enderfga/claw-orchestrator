/**
 * `SessionConfig.codexConfig`, shared by the `codex` and `codex-app` wrappers.
 *
 * Codex takes config overrides as `-c key=value`, the value parsed as TOML, and
 * the app-server takes the same keys in a thread's `config` object. A caller's
 * override of a key the wrapper sets itself would fight the wrapper's own value
 * (and, for the sandbox and approval keys, quietly widen what a session may
 * do), so those keys are refused rather than ordered.
 */

/** Keys the Codex wrappers set themselves. */
export const CODEX_RESERVED_KEYS = new Set([
  'sandbox_mode',
  'approval_policy',
  'approvals_reviewer',
  'model_reasoning_effort',
]);

const KEY_RE = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/;
const FEATURE_RE = /^[A-Za-z0-9_-]+$/;

/** The overrides as `[key, value]`, each value as TOML (a string quoted, a number or boolean bare). */
export function codexConfigEntries(config: unknown): Array<[string, string, string | number | boolean]> {
  if (config === undefined) return [];
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('codexConfig must be an object of key → string | number | boolean');
  }
  return Object.entries(config as Record<string, unknown>).map(([key, value]) => {
    if (!KEY_RE.test(key)) throw new Error(`codexConfig key ${JSON.stringify(key)} is not a dotted config key`);
    if (CODEX_RESERVED_KEYS.has(key)) {
      throw new Error(`codexConfig cannot set ${key}: the Codex wrapper sets it (use sandboxMode or effort)`);
    }
    if (typeof value === 'string') return [key, JSON.stringify(value), value];
    if (typeof value === 'boolean') return [key, String(value), value];
    if (typeof value === 'number' && Number.isFinite(value)) return [key, String(value), value];
    throw new Error(`codexConfig ${key} must be a string, a finite number or a boolean`);
  });
}

/** `-c key=value` pairs for `codex exec` and `codex exec resume`. */
export function codexConfigArgs(config: unknown): string[] {
  return codexConfigEntries(config).flatMap(([key, toml]) => ['-c', `${key}=${toml}`]);
}

/** The overrides as a JSON object for the app-server's thread `config`. */
export function codexConfigObject(config: unknown): Record<string, string | number | boolean> {
  return Object.fromEntries(codexConfigEntries(config).map(([key, , value]) => [key, value]));
}

/** `--enable f` / `--disable f` for `codexFeatures`. */
export function codexFeatureArgs(features: unknown): string[] {
  if (features === undefined) return [];
  if (!features || typeof features !== 'object' || Array.isArray(features)) {
    throw new Error('codexFeatures must be { enable?: string[], disable?: string[] }');
  }
  const f = features as { enable?: unknown; disable?: unknown };
  const list = (v: unknown, which: string): string[] => {
    if (v === undefined) return [];
    if (!Array.isArray(v) || !v.every((x) => typeof x === 'string' && FEATURE_RE.test(x))) {
      throw new Error(`codexFeatures.${which} must be an array of feature names`);
    }
    return v as string[];
  };
  return [
    ...list(f.enable, 'enable').flatMap((x) => ['--enable', x]),
    ...list(f.disable, 'disable').flatMap((x) => ['--disable', x]),
  ];
}
