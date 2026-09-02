/**
 * Community engine presets — schema enforcement and id resolution.
 *
 * These guard a boundary that is social as much as technical: a preset is
 * shipped by this project but attested by someone else, so the parts that can
 * be checked without the engine's credentials have to actually be checked.
 */

import { describe, it, expect } from 'vitest';

import { validatePreset, resolveCustomEngine, loadEnginePresets, listEnginePresets } from '../engine-presets.js';

const VALID = {
  id: 'my-engine',
  tier: 'community',
  description: 'An engine for testing.',
  provenance: {
    maintainer: 'someone',
    verifiedAgainst: '0.4.2',
    verifiedOn: '2026-09-02',
  },
  engine: { name: 'my-engine', bin: 'my-engine-adapter', args: { print: '-p' } },
};

describe('preset validation', () => {
  it('accepts a complete preset', () => {
    expect(() => validatePreset(VALID, 'my-engine.json')).not.toThrow();
  });

  // Provenance is the whole basis on which a community preset is accepted. A
  // preset without it is an assurance; with it, it is a claim someone can go
  // and disprove.
  it.each([
    ['maintainer', { maintainer: '' }],
    ['verifiedAgainst', { verifiedAgainst: '' }],
    ['verifiedOn', { verifiedOn: 'last tuesday' }],
  ])('rejects a preset whose provenance.%s is missing or unusable', (_field, patch) => {
    const bad = { ...VALID, provenance: { ...VALID.provenance, ...patch } };
    expect(() => validatePreset(bad, 'x.json')).toThrow(/provenance/);
  });

  it('rejects a preset with no provenance at all', () => {
    const { provenance: _drop, ...bad } = VALID;
    expect(() => validatePreset(bad, 'x.json')).toThrow(/provenance/);
  });

  // An absolute path is one contributor's machine, not a portable description.
  it('rejects an absolute bin, pointing at binEnv instead', () => {
    const bad = { ...VALID, engine: { ...VALID.engine, bin: '/Users/someone/bin/my-engine' } };
    expect(() => validatePreset(bad, 'x.json')).toThrow(/binEnv/);
  });

  // The core tier promises a weekly live run against a pinned version. Nothing
  // declared in a JSON file can promise that, so the tier is not selectable here.
  it('refuses to let a preset declare itself core', () => {
    const bad = { ...VALID, tier: 'core' };
    expect(() => validatePreset(bad, 'x.json')).toThrow(/core engines are wrapped in code/);
  });

  it('rejects an id that is not lower-case kebab-case', () => {
    for (const id of ['My-Engine', 'my_engine', 'a', 'x'.repeat(50)]) {
      expect(() => validatePreset({ ...VALID, id }, 'x.json'), id).toThrow(/id/);
    }
  });
});

describe('resolving customEngine', () => {
  it('passes an inline config through untouched', () => {
    const inline = { name: 'inline', bin: 'foo', args: {} };
    expect(resolveCustomEngine(inline)).toBe(inline);
  });

  it('leaves undefined alone', () => {
    expect(resolveCustomEngine(undefined)).toBeUndefined();
  });

  // Falling back to a default engine here would run something the caller never
  // named, which is worse than failing.
  it('throws on an unknown id and names what is available', () => {
    expect(() => resolveCustomEngine('no-such-engine')).toThrow(/Unknown engine preset 'no-such-engine'/);
    expect(() => resolveCustomEngine('no-such-engine')).toThrow(/Bundled presets:/);
  });
});

describe('the bundled directory', () => {
  // Whatever ships must load. This is the check that catches a malformed
  // contribution before it reaches anyone, and it runs without any engine's
  // credentials — which is exactly as far as CI can honestly go.
  it('loads every bundled preset and validates each one', () => {
    expect(() => loadEnginePresets()).not.toThrow();
    for (const p of listEnginePresets()) {
      expect(p.tier).toBe('community');
      expect(p.provenance.maintainer).toBeTruthy();
      expect(p.provenance.verifiedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});
