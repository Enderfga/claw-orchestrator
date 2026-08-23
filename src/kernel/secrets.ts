/**
 * Secret references.
 *
 * Custom-engine configs carry credentials, so they are never written to a run's
 * spec and never accepted over HTTP. That left a real gap: a run started with a
 * custom engine could not be resumed after a crash through the dashboard or any
 * remote caller, because the material it needed could not be supplied.
 *
 * A reference closes it without putting anything on the wire. The caller names a
 * secret; the server resolves the name from its own environment. The name is not
 * sensitive, the value never leaves the host, and a name that resolves to
 * nothing is an error rather than a silent start with no credentials.
 */

const PREFIX = 'CLAWO_CUSTOM_ENGINE_';

/** Environment variable a reference resolves to. */
export function secretEnvVar(ref: string): string {
  return `${PREFIX}${ref.replace(/[^A-Za-z0-9_]/g, '_').toUpperCase()}`;
}

/**
 * Resolve a reference to a custom-engine config.
 *
 * Throws when the name is unknown: starting without the credentials the caller
 * asked for would fail later, further from the cause, and possibly after doing
 * work.
 */
export function resolveSecretRef(ref: string, env: NodeJS.ProcessEnv = process.env): unknown {
  const key = secretEnvVar(ref);
  const raw = env[key];
  if (!raw) {
    throw new Error(
      `Unknown secret reference '${ref}': set ${key} on the orchestrator host to the JSON custom-engine config`,
    );
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`Secret reference '${ref}' (${key}) is not valid JSON: ${(err as Error).message}`);
  }
}

/** Resolve a `{ role: ref }` map. Absent entries stay absent. */
export function resolveSecretRefs(
  refs: Record<string, string | undefined> | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [role, ref] of Object.entries(refs ?? {})) {
    if (ref) out[role] = resolveSecretRef(ref, env);
  }
  return out;
}
