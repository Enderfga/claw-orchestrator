/**
 * Centralized Model Registry — single source of truth for all model metadata.
 *
 * Every model definition lives here. All other files derive from this registry.
 * To add a model: add one entry to MODELS[]. Everything else auto-generates.
 */

import type { EngineType } from './types.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export type ProviderName = 'anthropic' | 'openai' | 'google' | 'kimi' | 'cursor' | 'custom';

export interface ModelPricing {
  input: number; // per 1M tokens
  output: number;
  cached?: number;
}

export interface ModelDef {
  /** Canonical model ID, e.g. 'claude-opus-4-6' */
  id: string;
  /** Which CLI engine to use */
  engine: EngineType;
  /** Upstream provider for API routing */
  provider: ProviderName;
  /** Token pricing */
  pricing: ModelPricing;
  /** Short aliases that resolve to this model */
  aliases?: string[];
  /** Whether to expose in /v1/models (default: true) */
  listed?: boolean;
  /** Context window size in tokens */
  contextWindow?: number;
}

// ─── Model Definitions ───────────────────────────────────────────────────────

const MODELS: ModelDef[] = [
  // ── Anthropic ──────────────────────────────────────────────────────────
  {
    id: 'claude-opus-4-6',
    engine: 'claude',
    provider: 'anthropic',
    pricing: { input: 5, output: 25, cached: 0.5 },
    aliases: ['opus'],
    contextWindow: 200_000,
  },
  {
    id: 'claude-sonnet-4-6',
    engine: 'claude',
    provider: 'anthropic',
    pricing: { input: 3, output: 15, cached: 0.3 },
    aliases: ['sonnet'],
    contextWindow: 200_000,
  },
  {
    id: 'claude-haiku-4-5',
    engine: 'claude',
    provider: 'anthropic',
    pricing: { input: 1, output: 5, cached: 0.1 },
    aliases: ['haiku'],
    contextWindow: 200_000,
  },

  // ── OpenAI GPT-5.5 ────────────────────────────────────────────────────
  // TODO(gpt-5.5-pricing): pricing copied from gpt-5.4 as a placeholder until
  // OpenAI publishes official pricing for gpt-5.5. Update on confirmation.
  {
    id: 'gpt-5.5',
    engine: 'codex',
    provider: 'openai',
    pricing: { input: 2.5, output: 15, cached: 0.25 },
    contextWindow: 256_000,
  },

  // ── OpenAI GPT-5.4 ────────────────────────────────────────────────────
  {
    id: 'gpt-5.4',
    engine: 'codex',
    provider: 'openai',
    pricing: { input: 2.5, output: 15, cached: 0.25 },
    contextWindow: 256_000,
  },
  {
    id: 'gpt-5.4-mini',
    engine: 'codex',
    provider: 'openai',
    pricing: { input: 0.75, output: 4.5, cached: 0.075 },
    contextWindow: 256_000,
  },
  {
    id: 'gpt-5.4-nano',
    engine: 'codex',
    provider: 'openai',
    pricing: { input: 0.2, output: 1.25, cached: 0.02 },
    contextWindow: 128_000,
  },

  // ── OpenAI Reasoning ───────────────────────────────────────────────────
  {
    id: 'o3',
    engine: 'codex',
    provider: 'openai',
    pricing: { input: 2, output: 8 },
    contextWindow: 200_000,
  },
  {
    id: 'o4-mini',
    engine: 'codex',
    provider: 'openai',
    pricing: { input: 0.55, output: 2.2 },
    contextWindow: 200_000,
  },
  {
    id: 'codex-mini-latest',
    engine: 'codex',
    provider: 'openai',
    pricing: { input: 1.5, output: 6 },
    contextWindow: 200_000,
  },

  // ── Google Gemini 3.x ──────────────────────────────────────────────────
  {
    id: 'gemini-3.1-pro-preview',
    engine: 'gemini',
    provider: 'google',
    pricing: { input: 2, output: 12 },
    aliases: ['gemini-pro'],
    contextWindow: 1_000_000,
  },
  {
    id: 'gemini-3-flash-preview',
    engine: 'gemini',
    provider: 'google',
    pricing: { input: 0.5, output: 3 },
    aliases: ['gemini-flash'],
    contextWindow: 1_000_000,
  },

  // ── Google Gemini 2.5 (stable) ─────────────────────────────────────────
  {
    id: 'gemini-2.5-pro',
    engine: 'gemini',
    provider: 'google',
    pricing: { input: 1.25, output: 10, cached: 0.315 },
    listed: false,
    contextWindow: 1_000_000,
  },
  {
    id: 'gemini-2.5-flash',
    engine: 'gemini',
    provider: 'google',
    pricing: { input: 0.15, output: 0.6, cached: 0.0375 },
    listed: false,
    contextWindow: 1_000_000,
  },

  // ── Moonshot Kimi ──────────────────────────────────────────────────────
  // Kimi Code CLI model names follow the provider/model format from its
  // config.toml. The canonical coding model is "kimi-code/kimi-for-coding".
  {
    id: 'kimi-code/kimi-for-coding',
    engine: 'kimi',
    provider: 'kimi',
    pricing: { input: 0.6, output: 2.5, cached: 0.15 },
    aliases: ['kimi-k2', 'kimi-for-coding', 'kimi-k2-0711-preview'],
    contextWindow: 262_144,
  },
  {
    id: 'kimi-code/kimi-for-coding-flash',
    engine: 'kimi',
    provider: 'kimi',
    pricing: { input: 0.15, output: 0.6 },
    aliases: ['kimi-flash'],
    contextWindow: 262_144,
  },

  // ── Cursor Composer ────────────────────────────────────────────────────
  {
    id: 'composer-2',
    engine: 'cursor',
    provider: 'cursor',
    pricing: { input: 0.5, output: 2.5 },
    contextWindow: 200_000,
  },
  {
    id: 'composer-2-fast',
    engine: 'cursor',
    provider: 'cursor',
    pricing: { input: 1.5, output: 7.5 },
    contextWindow: 200_000,
  },
  {
    id: 'composer-1.5',
    engine: 'cursor',
    provider: 'cursor',
    pricing: { input: 3.5, output: 17.5 },
    listed: false,
    contextWindow: 200_000,
  },

  // ── Legacy (backward compat) ───────────────────────────────────────────
  {
    id: 'gpt-4o',
    engine: 'codex',
    provider: 'openai',
    pricing: { input: 2.5, output: 10, cached: 1.25 },
    listed: false,
    contextWindow: 128_000,
  },
];

// ─── Derived Lookup Tables (generated once at import time) ───────────────────

/** id → ModelDef */
const _byId = new Map<string, ModelDef>();
/** alias → ModelDef */
const _byAlias = new Map<string, ModelDef>();

for (const m of MODELS) {
  _byId.set(m.id, m);
  if (m.aliases) {
    for (const a of m.aliases) _byAlias.set(a, m);
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/** Resolve a model string (id or alias) to its full definition. Returns undefined for unknown models. */
export function lookupModel(idOrAlias: string): ModelDef | undefined {
  return _byId.get(idOrAlias) || _byAlias.get(idOrAlias);
}

/** Resolve alias → canonical id. Returns the input unchanged if not an alias. */
export function resolveAlias(alias: string): string {
  const m = _byAlias.get(alias);
  return m ? m.id : alias;
}

/** Resolve model string to engine + canonical model. Pattern fallback for unknown models. */
export function resolveEngineAndModel(model: string): { engine: EngineType; model: string } {
  // 1. Exact match (id or alias)
  const known = lookupModel(model);
  if (known) return { engine: known.engine, model: known.id };

  // 2. Pattern-based fallback for unknown models
  if (model.startsWith('gemini') || model.includes('gemini')) return { engine: 'gemini', model };
  if (model.startsWith('kimi')) return { engine: 'kimi', model };
  if (model.startsWith('gpt') || model.startsWith('o3') || model.startsWith('o4') || model.startsWith('codex'))
    return { engine: 'codex', model };
  if (model.startsWith('composer') || model.startsWith('cursor') || model === 'auto')
    return { engine: 'cursor', model };

  // 3. Default: claude engine passthrough
  return { engine: 'claude', model };
}

/** Resolve model string to provider + API model name. Used by proxy handler. */
export function resolveProvider(model: string): { provider: ProviderName; apiModel: string } {
  // Strip vendor prefixes
  let clean = model;
  for (const prefix of ['anthropic/', 'openai/', 'openai-codex/', 'gemini/', 'google/', 'kimi/', 'moonshot/', 'cursor/']) {
    if (clean.startsWith(prefix)) {
      clean = clean.slice(prefix.length);
      break;
    }
  }

  const known = lookupModel(clean);
  if (known) return { provider: known.provider, apiModel: known.id };

  // Pattern fallback
  const lower = clean.toLowerCase();
  if (lower.includes('claude') || lower.includes('opus') || lower.includes('sonnet') || lower.includes('haiku'))
    return { provider: 'anthropic', apiModel: clean };
  if (lower.includes('gemini')) return { provider: 'google', apiModel: clean };
  if (lower.includes('kimi') || lower.startsWith('moonshot')) return { provider: 'kimi', apiModel: clean };
  if (
    lower.includes('gpt') ||
    lower.startsWith('o1') ||
    lower.startsWith('o3') ||
    lower.startsWith('o4') ||
    lower.startsWith('codex')
  )
    return { provider: 'openai', apiModel: clean };
  if (lower.startsWith('composer') || lower.startsWith('cursor')) return { provider: 'cursor', apiModel: clean };

  return { provider: 'openai', apiModel: clean };
}

/** Get context window size for a model. Returns 200k default for unknown models. */
export function getContextWindow(model: string): number {
  const clean = model.replace(/^(anthropic|openai|openai-codex|google|gemini|kimi|moonshot|cursor)\//g, '');
  const known = lookupModel(clean);
  return known?.contextWindow ?? 200_000;
}

/** Get pricing for a model. Falls back to sonnet pricing for unknown models. */
export function getModelPricing(model?: string, defaultModel = 'claude-sonnet-4-6'): ModelPricing {
  if (!model) return lookupModel(defaultModel)?.pricing ?? { input: 0, output: 0 };
  const clean = model.replace(/^(anthropic|openai|openai-codex|google|gemini|kimi|moonshot|cursor)\//g, '');
  // Check overrides first
  const override = _pricingOverrides.get(clean);
  if (override) return override;
  const known = lookupModel(clean);
  if (known) return known.pricing;
  console.warn(`[models] Unknown model "${model}" — falling back to ${defaultModel} pricing`);
  return lookupModel(defaultModel)?.pricing ?? { input: 0, output: 0 };
}

/** Mutable pricing table for runtime overrides (backward compat). */
const _pricingOverrides = new Map<string, ModelPricing>();

export function overrideModelPricing(overrides: Record<string, Partial<ModelPricing>>): void {
  for (const [model, pricing] of Object.entries(overrides)) {
    const base = lookupModel(model)?.pricing ?? { input: 0, output: 0 };
    _pricingOverrides.set(model, {
      input: pricing.input ?? base.input,
      output: pricing.output ?? base.output,
      cached: pricing.cached ?? base.cached,
    });
  }
}

/** Reset all pricing overrides (for testing). */
export function _resetPricingOverrides(): void {
  _pricingOverrides.clear();
}

/** Get /v1/models list — auto-generated from registry. */
export function getModelList(): { object: string; data: Array<{ id: string; object: string; owned_by: string }> } {
  const data = MODELS.filter((m) => m.listed !== false).map((m) => ({
    id: m.id,
    object: 'model' as const,
    owned_by: m.provider,
  }));
  return { object: 'list', data };
}

/** Get all model aliases as a Record (backward compat). */
export function getAliases(): Record<string, string> {
  const result: Record<string, string> = {};
  for (const m of MODELS) {
    if (m.aliases) {
      for (const a of m.aliases) result[a] = m.id;
    }
  }
  return result;
}

/** Check if a model string is a Gemini model. */
export function isGeminiModel(model: string): boolean {
  return model.toLowerCase().includes('gemini');
}

/** Check if a model string is a Claude model. */
export function isClaudeModel(model: string): boolean {
  const l = model.toLowerCase();
  return l.includes('claude') || l.includes('opus') || l.includes('sonnet') || l.includes('haiku');
}

/** Rough token estimate: ~4 chars per token. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Resolve a model string to its full definition. Throws for unknown models. */
export function lookupModelStrict(idOrAlias: string): ModelDef {
  const m = lookupModel(idOrAlias);
  if (!m) throw new Error(`Unknown model: ${idOrAlias}`);
  return m;
}
