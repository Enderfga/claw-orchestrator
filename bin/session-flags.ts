/**
 * One set of session flags for every engine.
 *
 * Every `session_start` field (src/session-params.ts) is a `clawo session-start`
 * flag named after the field (`strictMcpConfig` → `--strict-mcp-config`), typed
 * by its schema, and mapped by each engine's wrapper to that engine's own flag.
 * The flags are built from the schema, so a field added there is a flag here;
 * `src/__tests__/cli-session-flags.test.ts` holds the two together.
 *
 * The engine is picked with `-e <engine>` or a shorthand (`--codex`, `--agy`,
 * `--acp <preset>`, …); with neither, the server's configured default runs
 * (Claude Code out of the box; `clawo config set defaults.engine <engine>`).
 */

import type { Command } from 'commander';
import { SESSION_START_PROPERTIES } from '../src/session-params.js';

type Kind = 'bool' | 'string' | 'number' | 'list' | 'argv' | 'json' | 'kv' | 'stringOrBool' | 'stringOrNumber';

export interface SessionFlag {
  field: string;
  /** commander flag spec, e.g. `--strict-mcp-config` or `-m, --model <model>`. */
  spec: string;
  kind: Kind;
  /** Other spellings that set the same field (kept from earlier versions of the CLI). */
  aliases?: string[];
}

/** Fields that are not flags: the positional name, and the engine (`-e` and the shorthands). */
export const NOT_FLAGS: Record<string, string> = {
  name: 'the positional [name]',
  engine: '-e/--engine and the engine shorthands',
  customEngine: '--custom <preset> (a preset id; inline configs are not accepted over HTTP)',
  acpAgent: '--acp <preset> (a preset id; inline configs are not accepted over HTTP)',
};

/** Spellings and short forms the CLI had before the flags were built from the schema. */
const OVERRIDES: Record<string, Partial<SessionFlag>> = {
  cwd: { spec: '-d, --cwd <dir>' },
  model: { spec: '-m, --model <model>' },
  worktree: { spec: '-w, --worktree [name]' },
  maxBudgetUsd: { aliases: ['--max-budget <usd>'] },
  noSessionPersistence: { spec: '--skip-persistence' },
  sandboxMode: { aliases: ['--sandbox <mode>'] },
  launcher: { kind: 'argv' },
  codexConfig: { kind: 'kv' },
};

function kebab(field: string): string {
  return field.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

function kindOf(schema: Record<string, unknown>): Kind {
  const t = schema.type;
  const types = Array.isArray(t) ? (t as string[]) : typeof t === 'string' ? [t] : ['string'];
  if (types.includes('object')) return 'json';
  if (types.includes('array')) return 'list';
  if (types.includes('boolean') && types.includes('string')) return 'stringOrBool';
  if (types.includes('number') && types.includes('string')) return 'stringOrNumber';
  if (types.includes('boolean')) return 'bool';
  if (types.includes('number')) return 'number';
  return 'string';
}

function valueName(kind: Kind, field: string): string {
  switch (kind) {
    case 'number':
      return ' <n>';
    case 'list':
      return ' <a,b,...>';
    case 'argv':
      return ' <arg>';
    case 'json':
      return ' <json>';
    case 'kv':
      return ' <key=value>';
    case 'stringOrBool':
      return ' [value]';
    case 'bool':
      return '';
    default:
      return ` <${kebab(field).split('-').at(-1)}>`;
  }
}

/** The session flags, one per `session_start` field that is a flag. */
export const SESSION_FLAGS: SessionFlag[] = Object.entries(SESSION_START_PROPERTIES)
  .filter(([field]) => !(field in NOT_FLAGS))
  .map(([field, schema]) => {
    const o = OVERRIDES[field] ?? {};
    const kind = o.kind ?? kindOf(schema);
    return { field, spec: o.spec ?? `--${kebab(field)}${valueName(kind, field)}`, kind, aliases: o.aliases };
  });

function describe(field: string): string {
  const d = SESSION_START_PROPERTIES[field]?.description;
  const allowed = SESSION_START_PROPERTIES[field]?.enum as unknown[] | undefined;
  const text = typeof d === 'string' ? d : field;
  return allowed ? `${text} (${allowed.join(' | ')})` : text;
}

function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

/** The commander attribute a spec's long flag sets: `--strict-mcp-config` → `strictMcpConfig`. */
function attrOf(spec: string): string {
  const long = spec.match(/--([a-z0-9-]+)/)![1];
  return long.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

/** Register every session flag on `cmd`. */
export function addSessionFlags(cmd: Command): Command {
  for (const f of SESSION_FLAGS) {
    for (const spec of [f.spec, ...(f.aliases ?? [])]) {
      const help = spec === f.spec ? describe(f.field) : `Same as ${f.spec.replace(/ .*/, '').replace(/^-\w, /, '')}`;
      if (f.kind === 'argv' || f.kind === 'kv') cmd.option(spec, `${help} (repeatable)`, collect);
      else cmd.option(spec, help);
    }
  }
  return cmd;
}

function parseScalar(raw: string): string | number | boolean {
  if (raw === 'true' || raw === 'false') return raw === 'true';
  if (raw.trim() !== '' && Number.isFinite(Number(raw))) return Number(raw);
  return raw;
}

function parseValue(f: SessionFlag, value: unknown): unknown {
  switch (f.kind) {
    case 'bool':
      return value === true || value === 'true';
    case 'number': {
      const n = Number(value);
      if (!Number.isFinite(n)) throw new Error(`${f.spec.replace(/ .*/, '')} needs a number, got ${String(value)}`);
      return n;
    }
    case 'list':
      return typeof value === 'string'
        ? value
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : value;
    case 'argv':
      return value;
    case 'json':
      try {
        return JSON.parse(String(value));
      } catch (e) {
        throw new Error(`${f.spec.replace(/ .*/, '')} needs JSON: ${(e as Error).message}`);
      }
    case 'kv': {
      const pairs = value as string[];
      if (pairs.length === 1 && pairs[0].trim().startsWith('{')) return JSON.parse(pairs[0]);
      return Object.fromEntries(
        pairs.map((p) => {
          const i = p.indexOf('=');
          if (i <= 0) throw new Error(`${f.spec.replace(/ .*/, '')} takes key=value, got ${p}`);
          return [p.slice(0, i), parseScalar(p.slice(i + 1))];
        }),
      );
    }
    case 'stringOrBool':
      return value === true ? true : value;
    case 'stringOrNumber':
      return typeof value === 'string' && Number.isFinite(Number(value)) ? Number(value) : value;
    default:
      return value;
  }
}

/** The `session_start` fields the parsed options set. Throws on a value its field cannot take. */
export function sessionBody(opts: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const f of SESSION_FLAGS) {
    for (const spec of [f.spec, ...(f.aliases ?? [])]) {
      const v = opts[attrOf(spec)];
      if (v === undefined) continue;
      body[f.field] = parseValue(f, v);
    }
  }
  // `tools: ""` is the empty tool set, not "none given".
  if (opts.tools === '') body.tools = '';
  return body;
}

// ─── Engine shorthands ──────────────────────────────────────────────────────

export const ENGINE_SHORTHANDS = ['claude', 'codex', 'codex-app', 'agy', 'grok', 'opencode'] as const;

/** `--claude`, `--codex`, … `--acp <preset>`, `--custom <preset>`, beside `-e`. */
export function addEngineFlags(cmd: Command, what = 'Run on'): Command {
  for (const e of ENGINE_SHORTHANDS) cmd.option(`--${e}`, `${what} ${e} (same as -e ${e})`);
  cmd.option('--acp <preset>', `${what} an ACP agent preset (same as -e acp --acp-agent <preset>)`);
  cmd.option('--custom <preset>', `${what} a custom engine preset (same as -e custom --custom-engine <preset>)`);
  cmd.option('--acp-agent <preset>', 'With -e acp: the bundled ACP agent preset (see `clawo engines`)');
  cmd.option('--custom-engine <preset>', 'With -e custom: the bundled engine preset (see `clawo engines`)');
  return cmd;
}

/**
 * The engine the flags pick: `-e`, one shorthand, or none (the server's
 * default). Two different picks are an error, not a quiet precedence.
 */
export function engineFromFlags(opts: Record<string, unknown>): {
  engine?: string;
  acpAgent?: string;
  customEngine?: string;
} {
  const picks: Array<{ engine: string; acpAgent?: string; customEngine?: string; said: string }> = [];
  if (typeof opts.engine === 'string' && opts.engine) picks.push({ engine: opts.engine, said: `-e ${opts.engine}` });
  for (const e of ENGINE_SHORTHANDS) {
    if (opts[attrOf(`--${e}`)]) picks.push({ engine: e, said: `--${e}` });
  }
  if (typeof opts.acp === 'string') picks.push({ engine: 'acp', acpAgent: opts.acp, said: `--acp ${opts.acp}` });
  if (typeof opts.custom === 'string') {
    picks.push({ engine: 'custom', customEngine: opts.custom, said: `--custom ${opts.custom}` });
  }
  const engines = new Set(picks.map((p) => p.engine));
  if (engines.size > 1) throw new Error(`pick one engine, not ${picks.map((p) => p.said).join(' and ')}`);
  if (picks.length === 0) {
    if (opts.acpAgent || opts.customEngine)
      throw new Error('--acp-agent and --custom-engine go with -e acp / -e custom');
    return {};
  }
  const acpAgent = picks.find((p) => p.acpAgent)?.acpAgent ?? (opts.acpAgent as string | undefined);
  const customEngine = picks.find((p) => p.customEngine)?.customEngine ?? (opts.customEngine as string | undefined);
  return { engine: picks[0].engine, ...(acpAgent ? { acpAgent } : {}), ...(customEngine ? { customEngine } : {}) };
}

// ─── The same names on the workflow commands ────────────────────────────────

/**
 * What `solve` and `fanout` agents take of the session flags, under the same
 * names: `-m/--model`, `--effort`, `--permission-mode`, `--sandbox`/`--sandbox-mode`,
 * `--append-system-prompt`.
 */
export function addAgentFlags(cmd: Command, opts: { model?: boolean; appendSystemPrompt?: boolean } = {}): Command {
  if (opts.model !== false) cmd.option('-m, --model <model>', describe('model'));
  cmd.option('--effort <level>', describe('effort'));
  cmd.option('--permission-mode <mode>', describe('permissionMode'));
  cmd.option('--sandbox-mode <mode>', describe('sandboxMode'));
  cmd.option('--sandbox <mode>', 'Same as --sandbox-mode');
  if (opts.appendSystemPrompt !== false) cmd.option('--append-system-prompt <prompt>', describe('appendSystemPrompt'));
  return cmd;
}

/** The agent fields those flags set. */
export function agentFields(opts: Record<string, unknown>): {
  model?: string;
  effort?: string;
  permissionMode?: string;
  sandboxMode?: string;
  appendSystemPrompt?: string;
} {
  const sandbox = (opts.sandboxMode ?? opts.sandbox) as string | undefined;
  return {
    ...(typeof opts.model === 'string' ? { model: opts.model } : {}),
    ...(typeof opts.effort === 'string' ? { effort: opts.effort } : {}),
    ...(typeof opts.permissionMode === 'string' ? { permissionMode: opts.permissionMode } : {}),
    ...(sandbox ? { sandboxMode: sandbox } : {}),
    ...(typeof opts.appendSystemPrompt === 'string' ? { appendSystemPrompt: opts.appendSystemPrompt } : {}),
  };
}
