/**
 * Centralized Model Registry — single source of truth for all model metadata.
 *
 * Every model definition lives here. All other files derive from this registry.
 * To add a model: add one entry to MODELS[]. Everything else auto-generates.
 */

import type { EngineType } from './types.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export type ProviderName = 'anthropic' | 'openai' | 'google' | 'cursor' | 'xai' | 'custom';

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
  // Fable 5 — first model of the Claude 5 family, a Mythos-class tier above
  // Opus. $10/$50 per Mtok, cache read $1 (0.1× input), full 1M-token context
  // at standard pricing (no long-context surcharge). Claude Mythos 5 is the
  // same model at the same price but limited-availability (approved orgs
  // only), so we register only Fable.
  {
    id: 'claude-fable-5',
    engine: 'claude',
    provider: 'anthropic',
    pricing: { input: 10, output: 50, cached: 1 },
    aliases: ['fable'],
    contextWindow: 1_000_000,
  },
  // Opus pricing is flat across 4.6 through 5: input:5 / output:25 / cached:0.5,
  // each with a 1M-token context window. Fast mode (Opus 5 and 4.8) bills at 2×
  // the standard rate, but it's a human-interactive `/fast` toggle the CLI never
  // enables in our headless spawn path, so we model the standard rate only.
  // The `opus` alias points at Opus 5 because that is what the CLI's own `opus`
  // alias resolves to (verified against the binary, CLI 2.1.220).
  {
    id: 'claude-opus-5',
    engine: 'claude',
    provider: 'anthropic',
    pricing: { input: 5, output: 25, cached: 0.5 },
    aliases: ['opus'],
    contextWindow: 1_000_000,
  },
  {
    id: 'claude-opus-4-8',
    engine: 'claude',
    provider: 'anthropic',
    pricing: { input: 5, output: 25, cached: 0.5 },
    contextWindow: 1_000_000,
  },
  {
    id: 'claude-opus-4-7',
    engine: 'claude',
    provider: 'anthropic',
    pricing: { input: 5, output: 25, cached: 0.5 },
    contextWindow: 1_000_000,
  },
  {
    id: 'claude-opus-4-6',
    engine: 'claude',
    provider: 'anthropic',
    pricing: { input: 5, output: 25, cached: 0.5 },
    contextWindow: 1_000_000,
  },
  // Sonnet 5 is the current-generation Sonnet and the Claude Code default as of
  // CLI 2.1.197. Native 1M-token context. $2/$10 per Mtok, cached read 0.1× input.
  //
  // This entry used to carry $3/$15 deliberately: $2/$10 was announced as
  // introductory pricing through 2026-08-31, and pricing the scheduled rate kept
  // estimates from under-reporting. Anthropic has since made $2/$10 the standard
  // price and cancelled the September increase, so the old reasoning now
  // over-reports every Sonnet turn by 50% — including against `maxBudgetUsd`,
  // which trips on these numbers. Price what the vendor charges today; a
  // scheduled change is not a fact until it happens.
  //
  // The `sonnet` alias points here so it tracks the CLI's own `sonnet` default.
  // Mythos 5 shares Fable 5's specs and pricing exactly. Invitation-only
  // (Project Glasswing), but it is a documented id a caller can pass, and an
  // unregistered id silently prices at the family default instead.
  {
    id: 'claude-mythos-5',
    engine: 'claude',
    provider: 'anthropic',
    pricing: { input: 10, output: 50, cached: 1 },
    contextWindow: 1_000_000,
  },
  {
    id: 'claude-sonnet-5',
    engine: 'claude',
    provider: 'anthropic',
    pricing: { input: 2, output: 10, cached: 0.2 },
    aliases: ['sonnet'],
    contextWindow: 1_000_000,
  },
  {
    id: 'claude-sonnet-4-6',
    engine: 'claude',
    provider: 'anthropic',
    pricing: { input: 3, output: 15, cached: 0.3 },
    contextWindow: 1_000_000,
  },
  // The 4.5 generation is legacy but still served, and it predates the 1M
  // window — registering it is what keeps contextPercent from measuring a 200K
  // model against a 1M denominator.
  {
    id: 'claude-sonnet-4-5',
    engine: 'claude',
    provider: 'anthropic',
    pricing: { input: 3, output: 15, cached: 0.3 },
    contextWindow: 200_000,
  },
  {
    id: 'claude-opus-4-5',
    engine: 'claude',
    provider: 'anthropic',
    pricing: { input: 5, output: 25, cached: 0.5 },
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
  // Default Codex model. OpenAI's published standard pricing is $5/$30 per Mtok
  // (cached 0.5) with a 1,050,000-token context. A long-context price tier
  // applies above 272K tokens that we don't model separately (single-tier
  // pricing, as with every entry here).
  {
    id: 'gpt-5.5',
    engine: 'codex',
    provider: 'openai',
    pricing: { input: 5, output: 30, cached: 0.5 },
    contextWindow: 1_050_000,
  },

  // ── OpenAI GPT-5.6 (limited preview) ──────────────────────────────────
  // Three-tier family, API + Codex only (NOT served to ChatGPT-account Codex
  // auth — verified empirically: the API 400s with "not supported when using
  // Codex with a ChatGPT account", so we keep gpt-5.5 as the Codex default).
  // Ids, pricing and context windows from OpenAI's model docs: all three tiers
  // share a 1,050,000 window and 128K max output. Note the Codex CLI ships a
  // model config listing 272,000 for these ids — that is the CLI's own cap
  // (272K is also the price-tier breakpoint), NOT the model's window, so it is
  // deliberately not mirrored here.
  // Bare `gpt-5.6` IS documented (1,050,000 window, $5/$0.5/$30 — identical to
  // Sol) and codex 0.148.0 offers it, so it is registered. Unregistered it fell
  // back to Sonnet pricing and a 200K window, which over-reported contextPercent
  // by 5.25x. `gpt-5.6-pro` appears in the codex binary but has no model-docs
  // page (404), so it stays out rather than carry invented pricing.
  {
    id: 'gpt-5.6',
    engine: 'codex',
    provider: 'openai',
    pricing: { input: 5, output: 30, cached: 0.5 },
    contextWindow: 1_050_000,
  },
  {
    id: 'gpt-5.6-sol',
    engine: 'codex',
    provider: 'openai',
    pricing: { input: 5, output: 30, cached: 0.5 },
    contextWindow: 1_050_000,
  },
  {
    id: 'gpt-5.6-terra',
    engine: 'codex',
    provider: 'openai',
    pricing: { input: 2.5, output: 15, cached: 0.25 },
    contextWindow: 1_050_000,
  },
  {
    id: 'gpt-5.6-luna',
    engine: 'codex',
    provider: 'openai',
    pricing: { input: 1, output: 6, cached: 0.1 },
    contextWindow: 1_050_000,
  },

  // ── OpenAI GPT-5.4 ────────────────────────────────────────────────────
  {
    id: 'gpt-5.4',
    engine: 'codex',
    provider: 'openai',
    pricing: { input: 2.5, output: 15, cached: 0.25 },
    contextWindow: 1_050_000,
  },
  {
    id: 'gpt-5.4-mini',
    engine: 'codex',
    provider: 'openai',
    pricing: { input: 0.75, output: 4.5, cached: 0.075 },
    contextWindow: 400_000,
  },
  {
    id: 'gpt-5.4-nano',
    engine: 'codex',
    provider: 'openai',
    pricing: { input: 0.2, output: 1.25, cached: 0.02 },
    contextWindow: 400_000,
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

  // ── Google Antigravity (agy) ───────────────────────────────────────────
  // Antigravity CLI is Gemini CLI's successor (consumer Gemini CLI stopped
  // serving 2026-06-18). Consumer agy auth is subscription-based with no
  // per-token billing; pricing here mirrors Gemini API list rates so costUsd
  // approximates equivalent API value — use overrideModelPricing() to zero it
  // out for subscription accounting. Token counts come from the stream-json
  // `result` event when it carries usage and fall back to estimateTokens()
  // otherwise; the run ledger flags which of the two a turn used.
  //
  // Slugs verified against agy 1.1.13 (`agy models`), which lists ONLY
  // effort-qualified names (gemini-3.7-flash-high, gemini-3.1-pro-low, …).
  // The base slugs registered below are the halves agy composes with
  // `--effort`, which PersistentAgySession always supplies — passing a base
  // slug without one is a hard CLI error, not a silent fallback. Tiers are not
  // uniform: gemini-3.1-pro has low/high only. agy also proxies Claude/GPT-OSS
  // models and accepts qualified slugs directly; both pass through unregistered
  // and price at their family default.
  {
    id: 'gemini-3.5-flash',
    engine: 'agy',
    provider: 'google',
    pricing: { input: 0.5, output: 3 },
    aliases: ['agy-flash'],
    contextWindow: 1_000_000,
  },
  {
    id: 'gemini-3.1-pro',
    engine: 'agy',
    provider: 'google',
    pricing: { input: 2, output: 12 },
    aliases: ['agy-pro'],
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

  // ── xAI Grok Build ─────────────────────────────────────────────────────
  // Registered for the context window and the informational cost breakdown only:
  // PersistentGrokSession takes `total_cost_usd` straight from the CLI, so these
  // rates never decide what a turn cost. That also makes grok's two-tier pricing
  // a non-issue — $2/$0.50/$6 below a 200K prompt and $4/$1/$12 at or above it,
  // charged across the whole request. We register the base tier, as with every
  // other long-context tier in this file; the engine bills the right one itself.
  // Verified against docs.x.ai/docs/models and grok 1.0.5 (`grok models`).
  {
    id: 'grok-4.6',
    engine: 'grok',
    provider: 'xai',
    pricing: { input: 2, output: 6, cached: 0.5 },
    aliases: ['grok'],
    contextWindow: 500_000,
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
  // The `agy/` vendor prefix pins the Antigravity engine (mirroring the strip
  // lists in resolveProvider/getContextWindow/getModelPricing). It must win
  // over both the registry and the pattern heuristics: agy proxies Claude and
  // GPT-OSS models that are registered to other engines, and a bare
  // `gemini-*` heuristic would route `agy/gemini-3.5-flash` to the gemini
  // engine — the opposite of the prefix's intent. Other vendor prefixes are
  // deliberately NOT stripped here: prefixed strings fall through to the
  // claude engine, which proxies them to the gateway.
  if (model.startsWith('agy/')) {
    return { engine: 'agy', model: resolveAlias(model.slice('agy/'.length)) };
  }

  // 1. Exact match (id or alias)
  const known = lookupModel(model);
  if (known) return { engine: known.engine, model: known.id };

  // 2. Pattern-based fallback for unknown models
  if (model.startsWith('gemini') || model.includes('gemini')) return { engine: 'gemini', model };
  if (model.startsWith('gpt') || model.startsWith('o3') || model.startsWith('o4') || model.startsWith('codex'))
    return { engine: 'codex', model };
  if (model.startsWith('composer') || model.startsWith('cursor') || model === 'auto')
    return { engine: 'cursor', model };
  if (model.startsWith('grok')) return { engine: 'grok', model };

  // 3. Default: claude engine passthrough
  return { engine: 'claude', model };
}

/** Resolve model string to provider + API model name. Used by proxy handler. */
export function resolveProvider(model: string): { provider: ProviderName; apiModel: string } {
  // Strip vendor prefixes
  let clean = model;
  for (const prefix of [
    'anthropic/',
    'openai/',
    'openai-codex/',
    'gemini/',
    'google/',
    'agy/',
    'cursor/',
    'grok/',
    'xai/',
  ]) {
    if (clean.startsWith(prefix)) {
      clean = clean.slice(prefix.length);
      break;
    }
  }

  const known = lookupModel(clean);
  if (known) return { provider: known.provider, apiModel: known.id };

  // Pattern fallback
  const lower = clean.toLowerCase();
  if (
    lower.includes('claude') ||
    lower.includes('opus') ||
    lower.includes('sonnet') ||
    lower.includes('haiku') ||
    lower.includes('fable') ||
    lower.includes('mythos')
  )
    return { provider: 'anthropic', apiModel: clean };
  if (lower.includes('gemini')) return { provider: 'google', apiModel: clean };
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
  const clean = model.replace(/^(anthropic|openai|openai-codex|google|gemini|agy|cursor|grok|xai)\//g, '');
  const known = lookupModel(clean);
  return known?.contextWindow ?? 200_000;
}

/** Get pricing for a model. Falls back to sonnet pricing for unknown models. */
export function getModelPricing(model?: string, defaultModel = 'claude-sonnet-4-6'): ModelPricing {
  if (!model) return lookupModel(defaultModel)?.pricing ?? { input: 0, output: 0 };
  const clean = model.replace(/^(anthropic|openai|openai-codex|google|gemini|agy|cursor|grok|xai)\//g, '');
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
  return (
    l.includes('claude') ||
    l.includes('opus') ||
    l.includes('sonnet') ||
    l.includes('haiku') ||
    l.includes('fable') ||
    l.includes('mythos')
  );
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
