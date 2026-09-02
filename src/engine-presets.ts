/**
 * Community engine presets.
 *
 * The custom-engine boundary (`CustomEngineConfig`) has always been able to
 * describe a third-party CLI. What was missing is a place to put such a
 * description so other people get it, and a way to say who stands behind it.
 * This module is both.
 *
 * The tier a preset lives in is decided by verification, not by code quality:
 *
 *   core       — wrapped in this repo, exercised live every week, and pinned to
 *                a version someone here actually ran. Entry requires that the
 *                binary can be obtained and run by the maintainers.
 *   community  — shipped as data. The schema is validated here; whether it runs
 *                is attested by its maintainer against a named engine version,
 *                on a named date. This project does not claim it works.
 *   legacy     — still wired, no longer tracked.
 *
 * That middle tier exists because the alternative is worse. Most of the CLIs
 * worth supporting are gated behind credentials this project does not hold, so
 * a "a maintainer must run it" bar would keep the tier permanently empty — and
 * an empty tier is indistinguishable from not having done the work. Requiring
 * an attributable, dated, falsifiable claim instead keeps the door open without
 * anyone here pretending to have tested what they have not.
 *
 * A preset never carries the protocol translation itself. A CLI that speaks its
 * own wire format needs an adapter binary, and that adapter belongs in its
 * author's own package, with the preset here pointing `bin` at it. Keeping the
 * translation out of this repo is what makes a preset something we can honestly
 * ship without owning.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { CustomEngineConfig } from './types.js';

/** Who attests that a preset works, against what, and when. */
export interface EnginePresetProvenance {
  /** GitHub handle or name of the person answering for this preset. */
  maintainer: string;
  /** Engine CLI version the smoke run was performed against, e.g. `0.4.2`. */
  verifiedAgainst: string;
  /** ISO date (YYYY-MM-DD) of that run. */
  verifiedOn: string;
  /** Where the adapter or engine lives. */
  sourceUrl?: string;
  /** Where the captured smoke transcript can be read. */
  smokeUrl?: string;
}

export interface EnginePreset {
  /** Name callers pass as `customEngine`. */
  id: string;
  tier: 'community';
  description: string;
  provenance: EnginePresetProvenance;
  /** The custom-engine configuration this preset expands to. */
  engine: CustomEngineConfig;
}

const ID_RE = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Resolve `configs/engines/` from either src/ or dist/. */
function presetDir(): string {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [path.join(dir, '..', 'configs', 'engines'), path.join(dir, '..', '..', 'configs', 'engines')];
  return candidates.find((p) => fs.existsSync(p)) ?? candidates[0];
}

/**
 * Reject anything that does not carry a complete, checkable claim.
 *
 * Everything here is verifiable without the engine's credentials, which is the
 * point: CI can enforce the shape of the attestation even though it can never
 * reproduce the run behind it.
 */
export function validatePreset(raw: unknown, source: string): EnginePreset {
  const fail = (why: string): never => {
    throw new Error(`Invalid engine preset in ${source}: ${why}`);
  };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('not an object');
  const p = raw as Record<string, unknown>;

  if (typeof p.id !== 'string' || !ID_RE.test(p.id)) fail('`id` must be lower-case kebab-case, 3-40 chars');
  if (p.tier !== 'community') fail("`tier` must be 'community' — core engines are wrapped in code, not declared here");
  if (typeof p.description !== 'string' || !p.description.trim()) fail('`description` is required');

  const prov = p.provenance as Record<string, unknown> | undefined;
  if (!prov || typeof prov !== 'object') fail('`provenance` is required');
  if (typeof prov!.maintainer !== 'string' || !prov!.maintainer.trim()) fail('`provenance.maintainer` is required');
  if (typeof prov!.verifiedAgainst !== 'string' || !prov!.verifiedAgainst.trim()) {
    fail('`provenance.verifiedAgainst` must name the engine version the smoke run used');
  }
  if (typeof prov!.verifiedOn !== 'string' || !DATE_RE.test(prov!.verifiedOn)) {
    fail('`provenance.verifiedOn` must be an ISO date (YYYY-MM-DD)');
  }

  const eng = p.engine as Record<string, unknown> | undefined;
  if (!eng || typeof eng !== 'object') fail('`engine` is required');
  if (typeof eng!.name !== 'string' || !eng!.name.trim()) fail('`engine.name` is required');
  if (typeof eng!.bin !== 'string' || !eng!.bin.trim()) fail('`engine.bin` is required');
  // An absolute path is one machine's layout, not a preset. `binEnv` is how a
  // preset stays portable across the people who install the engine elsewhere.
  if (path.isAbsolute(eng!.bin as string))
    fail('`engine.bin` must be a command name, not an absolute path — use `binEnv`');
  if (!eng!.args || typeof eng!.args !== 'object') fail('`engine.args` is required (may be empty)');

  return p as unknown as EnginePreset;
}

let _cache: Map<string, EnginePreset> | null = null;

/** Every bundled preset, keyed by id. Read once, then cached. */
export function loadEnginePresets(): Map<string, EnginePreset> {
  if (_cache) return _cache;
  const out = new Map<string, EnginePreset>();
  const dir = presetDir();
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && !f.startsWith('.'));
  } catch {
    // No preset directory is a valid state — there may simply be none yet.
  }
  for (const file of entries.sort()) {
    const full = path.join(dir, file);
    const preset = validatePreset(JSON.parse(fs.readFileSync(full, 'utf8')), file);
    if (preset.id !== path.basename(file, '.json')) {
      throw new Error(`Invalid engine preset in ${file}: \`id\` must match the filename`);
    }
    if (out.has(preset.id)) throw new Error(`Duplicate engine preset id '${preset.id}'`);
    out.set(preset.id, preset);
  }
  _cache = out;
  return out;
}

/** Test seam: drop the cache so a fixture directory is re-read. */
export function _resetEnginePresetCache(): void {
  _cache = null;
}

export function listEnginePresets(): EnginePreset[] {
  return [...loadEnginePresets().values()];
}

/**
 * Expand a `customEngine` that was given as a preset name.
 *
 * A caller may pass either an inline `CustomEngineConfig` — unchanged, and
 * still the only form the HTTP surface refuses — or the id of a bundled preset.
 * An unknown id fails loudly and lists what is available, rather than falling
 * back to a default engine that would run something the caller did not ask for.
 */
export function resolveCustomEngine(value: CustomEngineConfig | string | undefined): CustomEngineConfig | undefined {
  if (value === undefined || typeof value === 'object') return value;
  const preset = loadEnginePresets().get(value);
  if (!preset) {
    const known = [...loadEnginePresets().keys()];
    throw new Error(
      `Unknown engine preset '${value}'. Bundled presets: ${known.length ? known.join(', ') : '(none)'}.`,
    );
  }
  return preset.engine;
}
