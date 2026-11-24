/**
 * The environment a contract's checks run with.
 *
 * A check usually runs code the agent wrote, outside whatever sandbox the agent
 * worked in. When the agent had the server's environment anyway (a Claude Code
 * session with bypassed permissions), the check adds nothing it could not
 * already read. When the agent was sandboxed — Codex's default
 * `workspace-write`, an explicit `read-only` / `workspace-write`, an outer
 * `launcher` — it had no network and, on Codex, no variable named like a
 * secret, and the check would be the way out: the agent's code, run with every
 * key the server holds. So a run with a sandboxed agent runs its checks with a
 * minimal environment: what toolchains need to start, nothing named like a
 * secret, plus what the contract names in `passEnv`.
 *
 * `checkEnv` on the contract overrides the choice either way. Only variable
 * names are ever recorded, never values.
 */

import type { AcceptanceContract } from './contract.js';
import { withoutServerCredential } from '../kernel/secrets.js';

export type CheckEnvMode = 'inherit' | 'minimal';

/** Variables a check keeps in a minimal environment, by exact name. */
const KEEP_NAMES = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LANGUAGE',
  'TERM',
  'COLORTERM',
  'NO_COLOR',
  'FORCE_COLOR',
  'TMPDIR',
  'TMP',
  'TEMP',
  'TZ',
  'CI',
  'DISPLAY',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
  'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE',
  'VIRTUAL_ENV',
  'JAVA_HOME',
  'GOPATH',
  'GOROOT',
  'GOCACHE',
  'GOMODCACHE',
  'GOFLAGS',
  'CARGO_HOME',
  'RUSTUP_HOME',
  'PNPM_HOME',
  'BUN_INSTALL',
  'VOLTA_HOME',
  'DENO_DIR',
  'NVM_DIR',
  'NVM_BIN',
  'PYENV_ROOT',
  'CUDA_HOME',
  'CUDA_VISIBLE_DEVICES',
  'LD_LIBRARY_PATH',
  'PKG_CONFIG_PATH',
  'CPATH',
  'LIBRARY_PATH',
  'CC',
  'CXX',
  'MAKEFLAGS',
  // Windows: a process does not start without some of these.
  'SYSTEMROOT',
  'SYSTEMDRIVE',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'APPDATA',
  'LOCALAPPDATA',
  'USERPROFILE',
  'PROGRAMFILES',
  'PROGRAMDATA',
]);

/** …and by prefix: locale, XDG dirs, and the toolchains' own settings. */
const KEEP_PREFIXES = [
  'LC_',
  'XDG_',
  'NODE_',
  'NPM_CONFIG_',
  'PYTHON',
  'PIP_',
  'UV_',
  'POETRY_',
  'CONDA_',
  'GRADLE_',
  'MAVEN_',
  'DOTNET_',
  'HOMEBREW_',
];

/**
 * Names that look like a secret, dropped even when a prefix above matches
 * (`npm_config_//registry.npmjs.org/:_authToken`, `HOMEBREW_GITHUB_API_TOKEN`);
 * the same idea as Codex's default exclusion of `*KEY*`, `*SECRET*`, `*TOKEN*`.
 * A variable the contract names in `passEnv` is passed regardless.
 */
const SECRET_NAME = /KEY|SECRET|TOKEN|PASSWORD|PASSWD|PASSPHRASE|CREDENTIAL|AUTH|COOKIE/i;

function kept(name: string): boolean {
  const upper = name.toUpperCase();
  if (SECRET_NAME.test(name)) return false;
  return KEEP_NAMES.has(upper) || KEEP_PREFIXES.some((p) => upper.startsWith(p));
}

/** `passEnv` entries: a name, or a prefix ending in `*` (`AWS_*`). */
function passed(name: string, passEnv: readonly string[]): boolean {
  return passEnv.some((p) => (p.endsWith('*') ? name.startsWith(p.slice(0, -1)) : name === p));
}

/** The minimal environment: kept variables, plus those `passEnv` names. Never the server's credential. */
export function minimalCheckEnv(base: NodeJS.ProcessEnv, passEnv: readonly string[] = []): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(withoutServerCredential(base))) {
    if (value === undefined) continue;
    if (kept(name) || passed(name, passEnv)) env[name] = value;
  }
  return env;
}

/** The engines whose sessions are sandboxed when no `sandboxMode` is given. */
const SANDBOXED_BY_DEFAULT = new Set(['codex', 'codex-app']);

interface AgentLike {
  engine?: string;
  sandboxMode?: string;
  launcher?: unknown;
}

function sandboxed(a: AgentLike): boolean {
  if (Array.isArray(a.launcher) && a.launcher.length > 0) return true;
  if (a.sandboxMode === 'read-only' || a.sandboxMode === 'workspace-write') return true;
  return !a.sandboxMode && !!a.engine && SANDBOXED_BY_DEFAULT.has(a.engine);
}

/**
 * The agents of a spec that worked in a sandbox, named for the evidence: agent
 * and goal nodes, and the agents of fan-out and council nodes. A goal on `codex`
 * runs on `codex-app`; both are sandboxed by default.
 */
export function sandboxedAgents(spec: { nodes: readonly unknown[] }): string[] {
  const out: string[] = [];
  for (const raw of spec.nodes) {
    const node = raw as AgentLike & { id?: string; kind?: string; agents?: AgentLike[] };
    if ((node.kind === 'agent' || node.kind === 'goal') && sandboxed(node)) out.push(String(node.id));
    if ((node.kind === 'fanout' || node.kind === 'council') && Array.isArray(node.agents)) {
      node.agents.forEach((a, i) => {
        if (sandboxed(a)) out.push(`${node.id}/${(a as { name?: string }).name ?? i}`);
      });
    }
  }
  return out;
}

export interface CheckEnvChoice {
  mode: CheckEnvMode;
  /** Why: the contract said so, or which agents were sandboxed. */
  reason: string;
  /** Names the contract passes in a minimal environment. */
  passEnv: string[];
  /** The environment itself; undefined means the server's, minus its credential. */
  env?: NodeJS.ProcessEnv;
}

/** The environment a run's checks get: the contract's `checkEnv`, else minimal when an agent was sandboxed. */
export function chooseCheckEnv(
  contract: Pick<AcceptanceContract, 'checkEnv' | 'passEnv'>,
  spec: { nodes: readonly unknown[] } | undefined,
  base: NodeJS.ProcessEnv = process.env,
): CheckEnvChoice {
  const passEnv = contract.passEnv ?? [];
  const boxed = spec ? sandboxedAgents(spec) : [];
  const mode: CheckEnvMode = contract.checkEnv ?? (boxed.length ? 'minimal' : 'inherit');
  const reason = contract.checkEnv
    ? `the contract sets checkEnv: ${contract.checkEnv}`
    : boxed.length
      ? `sandboxed agent${boxed.length > 1 ? 's' : ''}: ${boxed.join(', ')}`
      : 'no agent of the run was sandboxed';
  return mode === 'minimal'
    ? { mode, reason, passEnv, env: minimalCheckEnv(base, passEnv) }
    : { mode, reason, passEnv };
}
