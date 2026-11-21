import { describe, it, expect } from 'vitest';
import { codexConfigArgs, codexConfigObject, codexFeatureArgs } from '../codex-config.js';

describe('codexConfig', () => {
  it('passes overrides as TOML values: strings quoted, numbers and booleans bare', () => {
    expect(codexConfigArgs({ model_verbosity: 'low', 'tools.web_search': true, model_context_window: 400000 })).toEqual(
      ['-c', 'model_verbosity="low"', '-c', 'tools.web_search=true', '-c', 'model_context_window=400000'],
    );
    expect(codexConfigArgs({ developer_instructions: 'say "hi"\nthen stop' })).toEqual([
      '-c',
      'developer_instructions="say \\"hi\\"\\nthen stop"',
    ]);
    expect(codexConfigObject({ model_verbosity: 'low', n: 2 })).toEqual({ model_verbosity: 'low', n: 2 });
    expect(codexConfigArgs(undefined)).toEqual([]);
  });

  it('refuses the keys the wrapper sets, keys that are not config keys, and other values', () => {
    expect(() => codexConfigArgs({ sandbox_mode: 'danger-full-access' })).toThrow(/wrapper sets it/);
    expect(() => codexConfigArgs({ approval_policy: 'never' })).toThrow(/wrapper sets it/);
    expect(() => codexConfigArgs({ 'a=b': 'x' })).toThrow(/not a dotted config key/);
    expect(() => codexConfigArgs({ k: { nested: 1 } })).toThrow(/string, a finite number or a boolean/);
    expect(() => codexConfigArgs(['k'])).toThrow(/must be an object/);
  });

  it('turns features on and off by name', () => {
    expect(codexFeatureArgs({ enable: ['goals'], disable: ['web_search'] })).toEqual([
      '--enable',
      'goals',
      '--disable',
      'web_search',
    ]);
    expect(() => codexFeatureArgs({ enable: ['bad name'] })).toThrow(/feature names/);
  });
});
