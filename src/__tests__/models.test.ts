/**
 * Unit tests for centralized model registry
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  lookupModel,
  lookupModelStrict,
  resolveAlias,
  resolveEngineAndModel,
  resolveProvider,
  getModelList,
  getContextWindow,
  getModelPricing,
  overrideModelPricing,
  _resetPricingOverrides,
  isGeminiModel,
  isClaudeModel,
  estimateTokens,
  getAliases,
} from '../models.js';

beforeEach(() => {
  _resetPricingOverrides();
});

describe('lookupModel', () => {
  it('finds model by canonical id', () => {
    const m = lookupModel('claude-opus-4-6');
    expect(m).toBeDefined();
    expect(m!.engine).toBe('claude');
    expect(m!.provider).toBe('anthropic');
  });

  it('finds model by alias', () => {
    const m = lookupModel('opus');
    expect(m).toBeDefined();
    expect(m!.id).toBe('claude-opus-4-8');
  });

  it('returns undefined for unknown model', () => {
    expect(lookupModel('nonexistent-model')).toBeUndefined();
  });

  it('finds all known models', () => {
    const ids = [
      'claude-fable-5',
      'claude-opus-4-6',
      'claude-sonnet-5',
      'claude-sonnet-4-6',
      'claude-haiku-4-5',
      'gpt-5.4',
      'gpt-5.4-mini',
      'gpt-5.4-nano',
      'o3',
      'o4-mini',
      'codex-mini-latest',
      'gemini-3.1-pro-preview',
      'gemini-3-flash-preview',
      'gemini-2.5-pro',
      'gemini-2.5-flash',
      'composer-2',
      'composer-2-fast',
      'composer-1.5',
      'gpt-4o',
    ];
    for (const id of ids) {
      expect(lookupModel(id), `missing: ${id}`).toBeDefined();
    }
  });
});

describe('resolveAlias', () => {
  it('resolves known aliases', () => {
    expect(resolveAlias('opus')).toBe('claude-opus-4-8');
    expect(resolveAlias('sonnet')).toBe('claude-sonnet-5');
    expect(resolveAlias('haiku')).toBe('claude-haiku-4-5');
    expect(resolveAlias('gemini-pro')).toBe('gemini-3.1-pro-preview');
    expect(resolveAlias('gemini-flash')).toBe('gemini-3-flash-preview');
  });

  it('returns input unchanged for non-aliases', () => {
    expect(resolveAlias('claude-opus-4-6')).toBe('claude-opus-4-6');
    expect(resolveAlias('unknown-model')).toBe('unknown-model');
  });
});

describe('resolveEngineAndModel', () => {
  it('resolves known models to correct engine', () => {
    expect(resolveEngineAndModel('claude-opus-4-6')).toEqual({ engine: 'claude', model: 'claude-opus-4-6' });
    expect(resolveEngineAndModel('gpt-5.4')).toEqual({ engine: 'codex', model: 'gpt-5.4' });
    expect(resolveEngineAndModel('o4-mini')).toEqual({ engine: 'codex', model: 'o4-mini' });
    expect(resolveEngineAndModel('gemini-3-flash-preview')).toEqual({
      engine: 'gemini',
      model: 'gemini-3-flash-preview',
    });
    expect(resolveEngineAndModel('composer-2')).toEqual({ engine: 'cursor', model: 'composer-2' });
  });

  it('resolves aliases to canonical id', () => {
    expect(resolveEngineAndModel('opus')).toEqual({ engine: 'claude', model: 'claude-opus-4-8' });
    expect(resolveEngineAndModel('gemini-flash')).toEqual({ engine: 'gemini', model: 'gemini-3-flash-preview' });
  });

  it('uses pattern fallback for unknown models', () => {
    expect(resolveEngineAndModel('gemini-future')).toEqual({ engine: 'gemini', model: 'gemini-future' });
    expect(resolveEngineAndModel('gpt-6')).toEqual({ engine: 'codex', model: 'gpt-6' });
    expect(resolveEngineAndModel('composer-3')).toEqual({ engine: 'cursor', model: 'composer-3' });
  });

  it('defaults to claude for truly unknown models', () => {
    expect(resolveEngineAndModel('some-random-model')).toEqual({ engine: 'claude', model: 'some-random-model' });
  });
});

describe('resolveProvider', () => {
  it('resolves known models to correct provider', () => {
    expect(resolveProvider('claude-opus-4-6')).toEqual({ provider: 'anthropic', apiModel: 'claude-opus-4-6' });
    expect(resolveProvider('gpt-5.4')).toEqual({ provider: 'openai', apiModel: 'gpt-5.4' });
    expect(resolveProvider('gemini-3-flash-preview')).toEqual({
      provider: 'google',
      apiModel: 'gemini-3-flash-preview',
    });
    expect(resolveProvider('composer-2')).toEqual({ provider: 'cursor', apiModel: 'composer-2' });
  });

  it('strips vendor prefixes', () => {
    expect(resolveProvider('anthropic/claude-opus-4-6').provider).toBe('anthropic');
    expect(resolveProvider('openai/gpt-5.4').provider).toBe('openai');
    expect(resolveProvider('google/gemini-3-flash-preview').provider).toBe('google');
    expect(resolveProvider('openai-codex/gpt-5.4').provider).toBe('openai');
  });

  it('uses pattern fallback for unknown models', () => {
    expect(resolveProvider('claude-future').provider).toBe('anthropic');
    expect(resolveProvider('gemini-future').provider).toBe('google');
    expect(resolveProvider('gpt-99').provider).toBe('openai');
  });
});

describe('getModelList', () => {
  it('returns only listed models', () => {
    const list = getModelList();
    const ids = list.data.map((m) => m.id);
    // Should include listed models
    expect(ids).toContain('claude-opus-4-6');
    expect(ids).toContain('claude-sonnet-4-6');
    expect(ids).toContain('gpt-5.4');
    // Should NOT include listed: false models
    expect(ids).not.toContain('gpt-4o');
    expect(ids).not.toContain('gemini-2.5-pro');
    expect(ids).not.toContain('composer-1.5');
  });

  it('has correct owned_by fields', () => {
    const list = getModelList();
    const opus = list.data.find((m) => m.id === 'claude-opus-4-6');
    expect(opus?.owned_by).toBe('anthropic');
    const gpt = list.data.find((m) => m.id === 'gpt-5.4');
    expect(gpt?.owned_by).toBe('openai');
  });
});

describe('getContextWindow', () => {
  it('returns correct window for known models', () => {
    expect(getContextWindow('claude-opus-4-6')).toBe(200_000);
    expect(getContextWindow('gpt-5.4')).toBe(256_000);
    expect(getContextWindow('gemini-3-flash-preview')).toBe(1_000_000);
    expect(getContextWindow('gpt-5.4-nano')).toBe(128_000);
  });

  it('strips vendor prefix', () => {
    expect(getContextWindow('anthropic/claude-opus-4-6')).toBe(200_000);
  });

  it('returns 200k default for unknown models', () => {
    expect(getContextWindow('unknown-model')).toBe(200_000);
  });
});

describe('getModelPricing', () => {
  it('returns pricing for known models', () => {
    const p = getModelPricing('claude-opus-4-6');
    expect(p.input).toBe(5);
    expect(p.output).toBe(25);
    expect(p.cached).toBe(0.5);
  });

  it('strips vendor prefix', () => {
    const p = getModelPricing('anthropic/claude-opus-4-6');
    expect(p.input).toBe(5);
  });

  it('falls back to default model for unknown', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const p = getModelPricing('unknown-model');
    // Should fall back to claude-sonnet-4-6
    expect(p.input).toBe(3);
    warnSpy.mockRestore();
  });

  it('returns overridden pricing', () => {
    overrideModelPricing({ 'claude-opus-4-6': { input: 999 } });
    const p = getModelPricing('claude-opus-4-6');
    expect(p.input).toBe(999);
    expect(p.output).toBe(25); // kept from base
  });
});

describe('claude-sonnet-5', () => {
  it('is registered with 1M context and standard $3/$15 pricing', () => {
    const m = lookupModel('claude-sonnet-5');
    expect(m).toBeDefined();
    expect(m!.contextWindow).toBe(1_000_000);
    expect(m!.pricing.input).toBe(3);
    expect(m!.pricing.output).toBe(15);
  });

  it('owns the `sonnet` alias so it tracks the CLI default', () => {
    expect(resolveAlias('sonnet')).toBe('claude-sonnet-5');
    expect(getContextWindow('sonnet')).toBe(1_000_000);
  });
});

describe('claude-fable-5', () => {
  it('is registered with 1M context and standard $10/$50 pricing (cache read $1)', () => {
    const m = lookupModel('claude-fable-5');
    expect(m).toBeDefined();
    expect(m!.contextWindow).toBe(1_000_000);
    expect(m!.pricing.input).toBe(10);
    expect(m!.pricing.output).toBe(50);
    expect(m!.pricing.cached).toBe(1);
  });

  it('resolves the `fable` alias to the claude engine', () => {
    expect(resolveAlias('fable')).toBe('claude-fable-5');
    expect(resolveEngineAndModel('fable')).toEqual({ engine: 'claude', model: 'claude-fable-5' });
  });

  it('fable/mythos strings are detected as Anthropic in the heuristics', () => {
    expect(isClaudeModel('fable')).toBe(true);
    expect(isClaudeModel('claude-mythos-5')).toBe(true);
    expect(resolveProvider('claude-fable-5')).toEqual({ provider: 'anthropic', apiModel: 'claude-fable-5' });
    expect(resolveProvider('claude-mythos-5').provider).toBe('anthropic');
  });
});

describe('gpt-5.5', () => {
  it('has published standard pricing ($5/$30) and 1M context', () => {
    const m = lookupModel('gpt-5.5');
    expect(m).toBeDefined();
    expect(m!.pricing.input).toBe(5);
    expect(m!.pricing.output).toBe(30);
    expect(m!.pricing.cached).toBe(0.5);
    expect(m!.contextWindow).toBe(1_000_000);
  });
});

describe('isGeminiModel / isClaudeModel', () => {
  it('detects gemini models', () => {
    expect(isGeminiModel('gemini-3-flash-preview')).toBe(true);
    expect(isGeminiModel('google/gemini-pro')).toBe(true);
    expect(isGeminiModel('claude-opus-4-6')).toBe(false);
  });

  it('detects claude models', () => {
    expect(isClaudeModel('claude-opus-4-6')).toBe(true);
    expect(isClaudeModel('opus')).toBe(true);
    expect(isClaudeModel('sonnet')).toBe(true);
    expect(isClaudeModel('gpt-5.4')).toBe(false);
  });
});

describe('getAliases', () => {
  it('returns all aliases as Record', () => {
    const aliases = getAliases();
    expect(aliases.opus).toBe('claude-opus-4-8');
    expect(aliases.sonnet).toBe('claude-sonnet-5');
    expect(aliases['gemini-pro']).toBe('gemini-3.1-pro-preview');
  });
});

describe('lookupModelStrict', () => {
  it('returns model for known id', () => {
    const m = lookupModelStrict('claude-opus-4-6');
    expect(m.id).toBe('claude-opus-4-6');
    expect(m.engine).toBe('claude');
  });

  it('returns model for alias', () => {
    const m = lookupModelStrict('opus');
    expect(m.id).toBe('claude-opus-4-8');
  });

  it('throws for unknown model', () => {
    expect(() => lookupModelStrict('nonexistent-model')).toThrow('Unknown model: nonexistent-model');
  });
});

describe('estimateTokens', () => {
  it('estimates ~1 token per 4 chars', () => {
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
    expect(estimateTokens('12345678')).toBe(2);
  });

  it('returns 0 for empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('rounds up', () => {
    expect(estimateTokens('a')).toBe(1);
    expect(estimateTokens('ab')).toBe(1);
    expect(estimateTokens('abc')).toBe(1);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
  });
});

describe('getModelPricing fallback warning', () => {
  it('warns when falling back to defaults for unknown model', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    getModelPricing('totally-unknown-model');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Unknown model "totally-unknown-model"'));
    warnSpy.mockRestore();
  });

  it('does not warn for known models', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    getModelPricing('claude-opus-4-6');
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
