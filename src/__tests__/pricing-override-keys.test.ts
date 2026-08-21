/**
 * Regression tests for the runtime pricing-override table.
 *
 * The table used to be keyed by whatever string the caller wrote while reads
 * were keyed by the prefix-stripped string, so an override written as an alias
 * ('opus') or with a vendor prefix ('openai/gpt-5.4') was silently unreachable,
 * and getModelPricing(undefined, default) skipped the table entirely. These
 * tests pin the invariant: ONE canonical key (prefix stripped, alias resolved)
 * shared by reads and writes.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pricing-keys-home-'));
process.env.HOME = TMP_HOME;
process.env.USERPROFILE = TMP_HOME;

function createMockStream() {
  const stream = new EventEmitter() as EventEmitter & Record<string, unknown>;
  stream.resume = vi.fn();
  stream.pause = vi.fn();
  stream.setEncoding = vi.fn();
  stream.destroy = vi.fn();
  return stream;
}
class MockProcess extends EventEmitter {
  pid = 4243;
  stdin = { write: vi.fn(), end: vi.fn() };
  stdout = createMockStream();
  stderr = createMockStream();
  unref = vi.fn();
  kill() {
    this.emit('close', 143);
  }
}
let mockProc: MockProcess | null = null;
vi.mock('node:child_process', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    spawn: vi.fn(() => {
      mockProc = new MockProcess();
      return mockProc;
    }),
  };
});

const { SessionManager } = await import('../session-manager.js');
const { getModelPricing, overrideModelPricing, _resetPricingOverrides, lookupModel, hasPricingOverride } =
  await import('../models.js');

const SENTINEL = { input: 777, output: 888 };

beforeEach(() => _resetPricingOverrides());
afterEach(() => _resetPricingOverrides());

describe('getModelPricing — the override table is consulted on every path', () => {
  it('honours an override on the DEFAULT model when no model is passed', () => {
    overrideModelPricing({ 'gpt-5.5': SENTINEL });
    expect(getModelPricing(undefined, 'gpt-5.5').input).toBe(777);
  });

  it('still returns the engine default (not sonnet) when nothing is overridden', () => {
    expect(getModelPricing(undefined, 'gpt-5.5')).toEqual(lookupModel('gpt-5.5')!.pricing);
  });

  it('honours an override on the default model when an unknown model falls back to it', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    overrideModelPricing({ 'gpt-5.5': SENTINEL });
    expect(getModelPricing('no-such-model', 'gpt-5.5').input).toBe(777);
    warnSpy.mockRestore();
  });

  it('an unknown model still warns and still falls back to the default list price', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(getModelPricing('totally-unknown-model')).toEqual(lookupModel('claude-sonnet-4-6')!.pricing);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Unknown model "totally-unknown-model"'));
    warnSpy.mockRestore();
  });
});

describe('overrideModelPricing — writes land on the same key reads use', () => {
  it('override on the canonical id is visible through the alias', () => {
    overrideModelPricing({ 'claude-opus-5': SENTINEL });
    expect(getModelPricing('opus').input).toBe(777);
  });

  it('override on the alias is visible through the canonical id', () => {
    overrideModelPricing({ opus: SENTINEL });
    expect(getModelPricing('claude-opus-5').input).toBe(777);
  });

  it('a vendor-prefixed key merges onto the real list price instead of zeroing output', () => {
    overrideModelPricing({ 'openai/gpt-5.4': { input: 1 } });
    const p = getModelPricing('gpt-5.4');
    expect(p.input).toBe(1);
    expect(p.output).toBe(lookupModel('gpt-5.4')!.pricing.output);
    expect(getModelPricing('openai/gpt-5.4')).toEqual(p);
  });

  it('partial override on a REGISTERED model still merges the rest from the registry', () => {
    overrideModelPricing({ 'claude-opus-4-6': { input: 99 } });
    const p = getModelPricing('claude-opus-4-6');
    expect(p).toEqual({ input: 99, output: 25, cached: 0.5 });
  });

  it('partial override on an UNREGISTERED id keeps 0 for the missing fields but warns loudly', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    overrideModelPricing({ 'my-custom-model': { input: 3 } });
    expect(getModelPricing('my-custom-model')).toEqual({ input: 3, output: 0 });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('unregistered model "my-custom-model"'));
    warnSpy.mockRestore();
  });

  it('a COMPLETE override on an unregistered id is a supported use case — no warning', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    overrideModelPricing({ 'my-custom-model': { input: 3, output: 9 } });
    expect(getModelPricing('my-custom-model')).toEqual({ input: 3, output: 9 });
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('explicit zeroing (subscription accounting) is preserved', () => {
    overrideModelPricing({ 'gemini-3.5-flash': { input: 0, output: 0 } });
    expect(getModelPricing('gemini-3.5-flash')).toMatchObject({ input: 0, output: 0 });
  });
});

describe('SessionManager — an override applies however the session named its model', () => {
  let mgr: InstanceType<typeof SessionManager>;
  beforeEach(() => {
    mockProc = null;
    mgr = new SessionManager({ maxConcurrentSessions: 20 });
  });
  afterEach(async () => await mgr.shutdown());

  async function startClaude(name: string, model: string) {
    const p = mgr.startSession({ name, engine: 'claude', cwd: TMP_HOME, model } as never);
    for (let i = 0; i < 200 && !mockProc; i++) await new Promise((r) => setImmediate(r));
    mockProc!.stdout.emit(
      'data',
      Buffer.from(JSON.stringify({ type: 'system', subtype: 'init', session_id: `sess-${name}` }) + '\n'),
    );
    return p;
  }

  it("claude engine: canonical override + session started as 'opus' (unchanged behaviour)", async () => {
    overrideModelPricing({ 'claude-opus-5': SENTINEL });
    await startClaude('c1', 'opus');
    expect(mgr.getCost('c1').pricing.inputPer1M).toBe(777);
  });

  it("claude engine: ALIAS-keyed override now also reaches a session started as 'opus'", async () => {
    overrideModelPricing({ opus: SENTINEL });
    await startClaude('c2', 'opus');
    expect(mgr.getCost('c2').pricing.inputPer1M).toBe(777);
  });

  it('gemini engine: a canonical override reaches a session started with the alias', async () => {
    overrideModelPricing({ 'gemini-3.1-pro-preview': SENTINEL });
    await mgr.startSession({ name: 'g1', engine: 'gemini', model: 'gemini-pro', cwd: TMP_HOME } as never);
    expect(mgr.getCost('g1').pricing.inputPer1M).toBe(777);
  });

  it('no resume flip: a canonical override prices the same before and after resume-by-name', async () => {
    overrideModelPricing({ 'gemini-3.1-pro-preview': SENTINEL });
    await mgr.startSession({ name: 'g2', engine: 'gemini', model: 'gemini-pro', cwd: TMP_HOME } as never);
    expect(mgr.getCost('g2').pricing.inputPer1M).toBe(777);
    await mgr.stopSession('g2', { keepPersisted: true });
    await mgr.startSession({ name: 'g2', engine: 'gemini', cwd: TMP_HOME } as never);
    expect(mgr.getCost('g2').pricing.inputPer1M).toBe(777);
  });

  it('no resume flip either way: an ALIAS-keyed override survives resume-by-name', async () => {
    overrideModelPricing({ 'gemini-pro': SENTINEL });
    await mgr.startSession({ name: 'g3', engine: 'gemini', model: 'gemini-pro', cwd: TMP_HOME } as never);
    expect(mgr.getCost('g3').pricing.inputPer1M).toBe(777);
    await mgr.stopSession('g3', { keepPersisted: true });
    await mgr.startSession({ name: 'g3', engine: 'gemini', cwd: TMP_HOME } as never);
    expect(mgr.getCost('g3').pricing.inputPer1M).toBe(777);
  });
});

describe('an explicit override is not mistaken for a registry miss', () => {
  // A custom engine keeps its own pricing table and reaches for it when the
  // registry knows nothing. A subscription override is all-zero, which reads
  // identically to a miss — so before hasPricingOverride() existed, zeroing a
  // model handed back the engine's own (dearer) rate instead of the zero asked
  // for: worse than not overriding at all.
  const enginePricing = { input: 12, output: 60 };
  const customRate = (model?: string) => {
    const base = getModelPricing(model, 'claude-sonnet-4-6');
    return base.input === 0 && base.output === 0 && !hasPricingOverride(model) ? enginePricing : base;
  };

  it('falls back to the engine rate when nothing was overridden', () => {
    expect(customRate('a-model-no-registry-knows')).toEqual({ input: 3, output: 15, cached: 0.3 });
  });

  it('honours a zeroing override on the engine default instead of the engine rate', () => {
    overrideModelPricing({ 'claude-sonnet-4-6': { input: 0, output: 0, cached: 0 } });
    expect(customRate(undefined)).toEqual({ input: 0, output: 0, cached: 0 });
  });

  it('reports an override under any spelling of the same model', () => {
    overrideModelPricing({ opus: { input: 0, output: 0 } });
    expect(hasPricingOverride('claude-opus-5')).toBe(true);
    expect(hasPricingOverride('anthropic/claude-opus-5')).toBe(true);
    expect(hasPricingOverride('claude-sonnet-5')).toBe(false);
  });
});

describe('an empty model string means "no model", not a model named ""', () => {
  it('prices by the engine default and does not warn', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(getModelPricing('')).toEqual({ input: 3, output: 15, cached: 0.3 });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('cannot be reached by an override, so the schema rejects the key up front', () => {
    overrideModelPricing({ '': { input: 9, output: 9 } });
    expect(getModelPricing('')).toEqual({ input: 3, output: 15, cached: 0.3 });
  });
});
