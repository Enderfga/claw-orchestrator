import { describe, expect, it } from 'vitest';
import { resolveSecretRef, resolveSecretRefs, secretEnvVar } from '../kernel/secrets.js';

describe('secret references', () => {
  it('resolves a name to the JSON config in its environment variable', () => {
    const env = { CLAWO_CUSTOM_ENGINE_MY_ENGINE: '{"name":"e","bin":"x"}' };
    expect(secretEnvVar('my-engine')).toBe('CLAWO_CUSTOM_ENGINE_MY_ENGINE');
    expect(resolveSecretRef('my-engine', env)).toEqual({ name: 'e', bin: 'x' });
    expect(resolveSecretRefs({ planner: 'my-engine', coder: undefined }, env)).toEqual({
      planner: { name: 'e', bin: 'x' },
    });
  });

  it('an unknown name says which variable to set', () => {
    expect(() => resolveSecretRef('missing', {})).toThrow(/CLAWO_CUSTOM_ENGINE_MISSING/);
  });

  it('a value that is not JSON is reported by its variable alone', () => {
    const value = 'sk-not-json-0123456789';
    let message = '';
    try {
      resolveSecretRef('bad', { CLAWO_CUSTOM_ENGINE_BAD: value });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/CLAWO_CUSTOM_ENGINE_BAD\) is not valid JSON$/);
    expect(message).not.toContain(value);
    expect(message).not.toContain('sk-');
  });
});
