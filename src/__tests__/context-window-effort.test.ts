// The context window of a model named with agy's effort suffix (gemini-4-hydrogen-high): the model's own.
// 2026-11-24: the suffixed name wasn't in the registry, the window fell back to 200,000, and an agy
// conversation at 19 % of Gemini 4's million read as 95 % full.
import { describe, expect, it } from 'vitest';
import { getContextWindow } from '../models.js';

describe('getContextWindow with an effort suffix', () => {
  it("is the base model's window", () => {
    expect(getContextWindow('gemini-4-hydrogen-high')).toBe(getContextWindow('gemini-4-hydrogen'));
    expect(getContextWindow('gemini-4-neon-xhigh')).toBe(1_000_000);
    expect(getContextWindow('gemini-3.8-flash-low')).toBe(getContextWindow('gemini-3.8-flash'));
  });
  it('a name not known with or without it: the fallback, as before', () => {
    expect(getContextWindow('nothing-like-it-high')).toBe(200_000);
  });
});
