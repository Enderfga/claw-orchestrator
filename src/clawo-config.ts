/**
 * The defaults file: `~/.claw-orchestrator/config.json`, or `CLAWO_CONFIG`.
 *
 * It holds what a session gets when its caller leaves a field out — the
 * default engine first, and any other `session_start` field, for every engine
 * or for one:
 *
 *   { "defaults": { "engine": "codex", "effort": "high" },
 *     "engines":  { "codex": { "model": "gpt-6.2-sol" }, "claude": { "model": "opus" } } }
 *
 * The session manager reads it on every start, so it applies to the CLI, the
 * MCP tools, HTTP callers and workflow nodes alike, and a change applies to
 * the next session without a restart. Out of the box the default engine is
 * Claude Code. `clawo config` reads and writes it.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ENGINE_TYPES, type EngineType, type SessionConfig } from './types.js';
import { SESSION_START_PROPERTIES } from './session-params.js';

export const FACTORY_DEFAULT_ENGINE: EngineType = 'claude';

/** Fields that name one session and so have no default. */
const NOT_DEFAULTS = new Set(['name', 'cwd', 'resumeSessionId', 'engine']);

/** The `session_start` fields a default may set. */
export const CONFIG_FIELDS: readonly string[] = Object.keys(SESSION_START_PROPERTIES).filter(
  (k) => !NOT_DEFAULTS.has(k),
);

export interface ClawoConfig {
  defaults?: Record<string, unknown>;
  engines?: Partial<Record<EngineType, Record<string, unknown>>>;
}

export function configPath(): string {
  return process.env.CLAWO_CONFIG || path.join(os.homedir(), '.claw-orchestrator', 'config.json');
}

let cache: { file: string; mtimeMs: number; size: number; config: ClawoConfig; warnings: string[] } | undefined;
const warned = new Set<string>();

/** The file as written, its unknown keys dropped (and reported once). A missing file is an empty config. */
export function loadConfig(): { config: ClawoConfig; warnings: string[] } {
  const file = configPath();
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    return { config: {}, warnings: [] };
  }
  if (cache && cache.file === file && cache.mtimeMs === st.mtimeMs && cache.size === st.size) {
    return { config: cache.config, warnings: cache.warnings };
  }
  const warnings: string[] = [];
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    warnings.push(`${file} is not valid JSON (${(err as Error).message}); its defaults are ignored`);
    raw = {};
  }
  const config = sanitize(raw, warnings);
  cache = { file, mtimeMs: st.mtimeMs, size: st.size, config, warnings };
  for (const w of warnings) {
    if (!warned.has(w)) {
      warned.add(w);
      console.warn(`[clawo-config] ${w}`);
    }
  }
  return { config, warnings };
}

function sanitize(raw: unknown, warnings: string[]): ClawoConfig {
  const out: ClawoConfig = {};
  if (!isObject(raw)) return out;
  if (raw.defaults !== undefined) {
    if (!isObject(raw.defaults)) warnings.push('defaults must be an object');
    else {
      out.defaults = {};
      for (const [k, v] of Object.entries(raw.defaults)) {
        const problem = k === 'engine' ? engineProblem(v) : fieldProblem(k, v);
        if (problem) warnings.push(`defaults.${k}: ${problem}; ignored`);
        else out.defaults[k] = v;
      }
    }
  }
  if (raw.engines !== undefined) {
    if (!isObject(raw.engines)) warnings.push('engines must be an object');
    else {
      out.engines = {};
      for (const [engine, fields] of Object.entries(raw.engines)) {
        if (!ENGINE_TYPES.includes(engine as EngineType)) {
          warnings.push(`engines.${engine}: not an engine (${ENGINE_TYPES.join(', ')}); ignored`);
          continue;
        }
        if (!isObject(fields)) {
          warnings.push(`engines.${engine} must be an object; ignored`);
          continue;
        }
        const kept: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(fields)) {
          const problem = fieldProblem(k, v);
          if (problem) warnings.push(`engines.${engine}.${k}: ${problem}; ignored`);
          else kept[k] = v;
        }
        out.engines[engine as EngineType] = kept;
      }
    }
  }
  return out;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function engineProblem(v: unknown): string | undefined {
  return typeof v === 'string' && ENGINE_TYPES.includes(v as EngineType)
    ? undefined
    : `must be one of ${ENGINE_TYPES.join(', ')}`;
}

/** Why `value` cannot be the default of `field`, judged by the field's `session_start` schema. */
function fieldProblem(field: string, value: unknown): string | undefined {
  if (!CONFIG_FIELDS.includes(field)) return 'not a session field';
  const schema = SESSION_START_PROPERTIES[field];
  const types = schemaTypes(schema);
  if (types.length && !types.some((t) => matchesType(t, value))) return `must be ${types.join(' or ')}`;
  const allowed = schema.enum as unknown[] | undefined;
  if (allowed && !allowed.includes(value)) return `must be one of ${allowed.join(', ')}`;
  return undefined;
}

function schemaTypes(schema: Record<string, unknown>): string[] {
  if (Array.isArray(schema.type)) return schema.type as string[];
  if (typeof schema.type === 'string') return [schema.type];
  // `customEngine` / `acpAgent`: a preset id or an object.
  if (Array.isArray(schema.oneOf)) return ['string', 'object'];
  return [];
}

function matchesType(type: string, v: unknown): boolean {
  switch (type) {
    case 'string':
      return typeof v === 'string';
    case 'number':
      return typeof v === 'number' && Number.isFinite(v);
    case 'boolean':
      return typeof v === 'boolean';
    case 'array':
      return Array.isArray(v);
    case 'object':
      return isObject(v);
    default:
      return true;
  }
}

/** The engine a session runs on when its caller names none. */
export function defaultEngine(): EngineType {
  const e = loadConfig().config.defaults?.engine;
  return typeof e === 'string' ? (e as EngineType) : FACTORY_DEFAULT_ENGINE;
}

/**
 * The defaults for a session on `engine`: the general ones, then that engine's
 * own over them. The general `model` comes back apart, for the caller to give
 * only to an engine that runs it (models do not cross engines); an engine's own
 * `model` is in `fields`.
 */
export function sessionDefaults(engine: EngineType): { fields: Partial<SessionConfig>; generalModel?: string } {
  const { config } = loadConfig();
  const general = { ...(config.defaults ?? {}) };
  delete general.engine;
  const generalModel = typeof general.model === 'string' ? general.model : undefined;
  delete general.model;
  const fields = { ...general, ...(config.engines?.[engine] ?? {}) } as Partial<SessionConfig>;
  return { fields, ...(generalModel ? { generalModel } : {}) };
}

// ─── Writing (clawo config) ─────────────────────────────────────────────────

/** `defaults.engine`, `defaults.<field>` or `engines.<engine>.<field>`, checked. */
function parseKey(key: string): { scope: 'defaults' } | { scope: 'engines'; engine: EngineType } {
  const parts = key.split('.');
  if (parts[0] === 'defaults' && parts.length === 2) {
    if (parts[1] !== 'engine' && !CONFIG_FIELDS.includes(parts[1])) {
      throw new Error(`${parts[1]} is not a session field (see \`clawo session-start --help\`)`);
    }
    return { scope: 'defaults' };
  }
  if (parts[0] === 'engines' && parts.length === 3) {
    if (!ENGINE_TYPES.includes(parts[1] as EngineType)) {
      throw new Error(`${parts[1]} is not an engine (${ENGINE_TYPES.join(', ')})`);
    }
    if (!CONFIG_FIELDS.includes(parts[2])) throw new Error(`${parts[2]} is not a session field`);
    return { scope: 'engines', engine: parts[1] as EngineType };
  }
  throw new Error('a key is defaults.<field> or engines.<engine>.<field>, e.g. defaults.engine or engines.codex.model');
}

/** A value typed in a shell, read as the field's schema type. */
export function parseConfigValue(field: string, raw: string): unknown {
  const types = field === 'engine' ? ['string'] : schemaTypes(SESSION_START_PROPERTIES[field] ?? {});
  const trimmed = raw.trim();
  if (types.includes('boolean') && (trimmed === 'true' || trimmed === 'false')) return trimmed === 'true';
  if (types.includes('number') && trimmed !== '' && Number.isFinite(Number(trimmed))) return Number(trimmed);
  if ((types.includes('object') || types.includes('array')) && /^[[{]/.test(trimmed)) {
    try {
      return JSON.parse(trimmed);
    } catch {
      throw new Error(`${field}: not valid JSON`);
    }
  }
  if (types.includes('array') && !types.includes('string')) {
    return trimmed
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return raw;
}

function readRaw(): ClawoConfig {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath(), 'utf8')) as unknown;
    return isObject(raw) ? (raw as ClawoConfig) : {};
  } catch {
    return {};
  }
}

function writeRaw(config: ClawoConfig): void {
  const file = configPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n');
  fs.renameSync(tmp, file);
  cache = undefined;
}

export function setConfigValue(key: string, raw: string): unknown {
  const where = parseKey(key);
  const field = key.split('.').at(-1)!;
  const value = parseConfigValue(field, raw);
  const problem = field === 'engine' ? engineProblem(value) : fieldProblem(field, value);
  if (problem) throw new Error(`${key}: ${problem}`);
  const config = readRaw();
  if (where.scope === 'defaults') config.defaults = { ...(config.defaults ?? {}), [field]: value };
  else {
    config.engines = { ...(config.engines ?? {}) };
    config.engines[where.engine] = { ...(config.engines[where.engine] ?? {}), [field]: value };
  }
  writeRaw(config);
  return value;
}

export function unsetConfigValue(key: string): boolean {
  const where = parseKey(key);
  const field = key.split('.').at(-1)!;
  const config = readRaw();
  const bag = where.scope === 'defaults' ? config.defaults : config.engines?.[where.engine];
  if (!bag || !(field in bag)) return false;
  delete bag[field];
  writeRaw(config);
  return true;
}

export function getConfigValue(key: string): unknown {
  const where = parseKey(key);
  const field = key.split('.').at(-1)!;
  const { config } = loadConfig();
  if (where.scope === 'defaults') {
    return field === 'engine' ? defaultEngine() : config.defaults?.[field];
  }
  return config.engines?.[where.engine]?.[field];
}
