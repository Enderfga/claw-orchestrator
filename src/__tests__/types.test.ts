/**
 * Unit tests for shared types and model registry
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  MODEL_ALIASES,
  overrideModelPricing,
  getModelPricing,
  _resetPricingOverrides,
  engineHasNativeConversation,
  ENGINE_TYPES,
} from '../types.js';
import { lookupModel, getAliases } from '../models.js';

beforeEach(() => {
  _resetPricingOverrides();
});

describe('Model Pricing (via registry)', () => {
  it('contains expected models', () => {
    const expected = [
      'claude-opus-4-6',
      'claude-sonnet-4-6',
      'claude-haiku-4-5',
      'gemini-2.5-pro',
      'gpt-4o',
      'o4-mini',
    ];
    for (const model of expected) {
      expect(lookupModel(model), `missing model def for ${model}`).toBeDefined();
    }
  });

  it('has positive input and output prices for all models', () => {
    const aliases = getAliases();
    // Check all known models via getModelPricing
    const models = [
      'claude-opus-4-6',
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
      ...Object.keys(aliases),
    ];
    for (const model of models) {
      const pricing = getModelPricing(model);
      expect(pricing.input, `${model} input should be positive`).toBeGreaterThan(0);
      expect(pricing.output, `${model} output should be positive`).toBeGreaterThan(0);
    }
  });

  it('cached is optional but positive when defined', () => {
    const models = [
      'claude-opus-4-6',
      'claude-sonnet-4-6',
      'claude-haiku-4-5',
      'gpt-5.4',
      'gpt-5.4-mini',
      'gpt-5.4-nano',
      'gemini-2.5-pro',
      'gemini-2.5-flash',
      'gpt-4o',
    ];
    for (const model of models) {
      const pricing = getModelPricing(model);
      if (pricing.cached !== undefined) {
        expect(pricing.cached, `${model} cached should be positive`).toBeGreaterThan(0);
      }
    }
  });
});

describe('overrideModelPricing', () => {
  it('overrides existing model pricing', () => {
    overrideModelPricing({ 'claude-opus-4-6': { input: 20, output: 80, cached: 2.0 } });
    const pricing = getModelPricing('claude-opus-4-6');
    expect(pricing).toEqual({ input: 20, output: 80, cached: 2.0 });
  });

  it('partial merge keeps existing fields', () => {
    overrideModelPricing({ 'claude-opus-4-6': { input: 99 } });
    const pricing = getModelPricing('claude-opus-4-6');
    expect(pricing.input).toBe(99);
    // output and cached should come from the base model def
    expect(pricing.output).toBe(25);
    expect(pricing.cached).toBe(0.5);
  });

  it('adds a new model override', () => {
    overrideModelPricing({ 'custom-model-xyz': { input: 5, output: 25 } });
    const pricing = getModelPricing('custom-model-xyz');
    expect(pricing.input).toBe(5);
    expect(pricing.output).toBe(25);
  });

  it('overridden values are visible to getModelPricing', () => {
    overrideModelPricing({ 'claude-opus-4-6': { input: 42 } });
    const pricing = getModelPricing('claude-opus-4-6');
    expect(pricing.input).toBe(42);
  });
});

describe('MODEL_ALIASES', () => {
  it('all aliases resolve to a known model', () => {
    for (const [alias, model] of Object.entries(MODEL_ALIASES)) {
      expect(lookupModel(model), `alias '${alias}' -> '${model}' not found`).toBeDefined();
    }
  });

  it('contains expected aliases', () => {
    expect(MODEL_ALIASES['opus']).toBeDefined();
    expect(MODEL_ALIASES['sonnet']).toBeDefined();
    expect(MODEL_ALIASES['haiku']).toBeDefined();
  });
});

// ─── engineHasNativeConversation ─────────────────────────────────────────────

describe('engineHasNativeConversation', () => {
  // This split decides who owns the conversation history, and getting it wrong
  // breaks in one of two directions: treat a fresh-per-send engine as if it
  // remembered, and per-turn context (tool schemas, replayed transcript) is
  // silently dropped; treat a thread-resuming engine as if it forgot, and that
  // same content is re-sent every turn until the thread overflows its window.
  it('reports engines that carry the conversation themselves', () => {
    for (const engine of ['claude', 'codex', 'codex-app', 'agy'] as const) {
      expect(engineHasNativeConversation(engine), engine).toBe(true);
    }
  });

  it('reports engines that start from scratch on every send', () => {
    for (const engine of ['gemini', 'cursor', 'opencode'] as const) {
      expect(engineHasNativeConversation(engine), engine).toBe(false);
    }
  });

  it('keys custom engines off the persistent flag', () => {
    expect(engineHasNativeConversation('custom', { name: 'x', command: 'x', persistent: true })).toBe(true);
    expect(engineHasNativeConversation('custom', { name: 'x', command: 'x', persistent: false })).toBe(false);
    expect(engineHasNativeConversation('custom')).toBe(false);
  });

  it('classifies every registered engine type', () => {
    for (const engine of ENGINE_TYPES) {
      expect(typeof engineHasNativeConversation(engine), engine).toBe('boolean');
    }
  });

  it('treats an unknown engine as non-persistent', () => {
    expect(engineHasNativeConversation(undefined)).toBe(false);
  });
});
