/**
 * The defaults file: what a session gets when its caller leaves a field out.
 * These pin that the file is read on every use (a change applies without a
 * restart), that keys and values are checked against the session_start
 * fields, and that an engine's own defaults go over the general ones.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  configPath,
  defaultEngine,
  getConfigValue,
  loadConfig,
  sessionDefaults,
  setConfigValue,
  unsetConfigValue,
} from '../clawo-config.js';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawo-config-'));
  process.env.CLAWO_CONFIG = path.join(dir, 'config.json');
});
afterEach(() => {
  delete process.env.CLAWO_CONFIG;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('the defaults file', () => {
  it('defaults to Claude Code with no file', () => {
    expect(fs.existsSync(configPath())).toBe(false);
    expect(defaultEngine()).toBe('claude');
    expect(sessionDefaults('codex')).toEqual({ fields: {} });
  });

  it('sets, reads and unsets values typed as the session field they name', () => {
    expect(setConfigValue('defaults.engine', 'codex')).toBe('codex');
    expect(defaultEngine()).toBe('codex');
    expect(setConfigValue('defaults.effort', 'high')).toBe('high');
    expect(setConfigValue('engines.codex.model', 'gpt-6.2-sol')).toBe('gpt-6.2-sol');
    expect(setConfigValue('engines.claude.strictMcpConfig', 'true')).toBe(true);
    expect(setConfigValue('engines.claude.maxTurns', '12')).toBe(12);
    expect(setConfigValue('engines.claude.addDir', '/a,/b')).toEqual(['/a', '/b']);
    expect(setConfigValue('engines.codex.codexConfig', '{"model_verbosity":"low"}')).toEqual({
      model_verbosity: 'low',
    });
    expect(getConfigValue('engines.codex.model')).toBe('gpt-6.2-sol');
    expect(unsetConfigValue('defaults.engine')).toBe(true);
    expect(defaultEngine()).toBe('claude');
    expect(unsetConfigValue('defaults.engine')).toBe(false);
  });

  it('refuses keys and values that are not session fields', () => {
    expect(() => setConfigValue('defaults.engine', 'emacs')).toThrow(/must be one of/);
    expect(() => setConfigValue('defaults.colour', 'red')).toThrow(/not a session field/);
    expect(() => setConfigValue('engines.emacs.model', 'x')).toThrow(/not an engine/);
    expect(() => setConfigValue('engines.codex.name', 'x')).toThrow(/not a session field/);
    expect(() => setConfigValue('defaults.effort', 'enormous')).toThrow(/must be one of/);
    expect(() => setConfigValue('defaults.maxTurns', 'lots')).toThrow(/must be number/);
    expect(() => setConfigValue('engine', 'codex')).toThrow(/defaults\.<field>/);
  });

  it('puts an engine’s own defaults over the general ones, and keeps the general model apart', () => {
    fs.writeFileSync(
      configPath(),
      JSON.stringify({
        defaults: { engine: 'codex', effort: 'high', model: 'opus', permissionMode: 'acceptEdits' },
        engines: { codex: { effort: 'xhigh' } },
      }),
    );
    expect(sessionDefaults('codex')).toEqual({
      fields: { effort: 'xhigh', permissionMode: 'acceptEdits' },
      generalModel: 'opus',
    });
    expect(sessionDefaults('claude').fields.effort).toBe('high');
  });

  it('reads the file again when it changes, and drops what it cannot use', () => {
    fs.writeFileSync(configPath(), JSON.stringify({ defaults: { engine: 'agy' } }));
    expect(defaultEngine()).toBe('agy');
    // A hand edit with a bad key and a bad value: both dropped, the rest kept.
    fs.writeFileSync(
      configPath(),
      JSON.stringify({ defaults: { engine: 'grok', colour: 'red', effort: 'enormous' }, engines: { emacs: {} } }),
    );
    const { config, warnings } = loadConfig();
    expect(config.defaults).toEqual({ engine: 'grok' });
    expect(warnings.join('\n')).toMatch(/colour.*not a session field/);
    expect(warnings.join('\n')).toMatch(/effort/);
    expect(warnings.join('\n')).toMatch(/emacs.*not an engine/);
    expect(defaultEngine()).toBe('grok');
    fs.writeFileSync(configPath(), '{not json');
    expect(defaultEngine()).toBe('claude');
  });
});
