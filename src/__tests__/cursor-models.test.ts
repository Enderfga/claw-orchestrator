/**
 * Cursor's effort-in-the-id and its model listing.
 */

import { describe, it, expect } from 'vitest';
import { cursorModelForEffort, parseCursorModelList } from '../cursor-models.js';

const ids = parseCursorModelList(
  [
    'Available models',
    '',
    'auto - Auto (current, default)',
    'gpt-5.4-mini-low - GPT-5.4 Mini Low',
    'gpt-5.4-mini-medium - GPT-5.4 Mini',
    'gpt-5.4-mini-high - GPT-5.4 Mini High',
    'claude-opus-5-5-high - Opus 5.5 High',
    'claude-opus-5-5-high-fast - Opus 5.5 High Fast',
    'claude-opus-5-5-max - Opus 5.5 Max',
    '',
    "Tip: use --model <id> (or /model <id> in interactive mode) to switch. Parameterized models also accept quoted overrides, e.g. --model 'x[effort=high]'.",
  ].join('\n'),
);

describe('cursorModelForEffort', () => {
  it('reads only the id lines of the listing', () => {
    expect([...ids]).toEqual([
      'auto',
      'gpt-5.4-mini-low',
      'gpt-5.4-mini-medium',
      'gpt-5.4-mini-high',
      'claude-opus-5-5-high',
      'claude-opus-5-5-high-fast',
      'claude-opus-5-5-max',
    ]);
  });

  it('picks the listed id at the effort, keeping -fast last', () => {
    expect(cursorModelForEffort('gpt-5.4-mini', 'low', ids)).toEqual({ model: 'gpt-5.4-mini-low', applied: 'low' });
    expect(cursorModelForEffort('claude-opus-5-5-fast', 'high', ids).model).toBe('claude-opus-5-5-high-fast');
    expect(cursorModelForEffort('claude-opus-5-5', 'ultra', ids).model).toBe('claude-opus-5-5-max');
  });

  it('steps down to the nearest listed effort, and leaves the model alone when none is', () => {
    expect(cursorModelForEffort('gpt-5.4-mini', 'max', ids)).toEqual({ model: 'gpt-5.4-mini-high', applied: 'high' });
    expect(cursorModelForEffort('claude-opus-5-5', 'low', ids)).toEqual({ model: 'claude-opus-5-5' });
  });

  it('leaves an id that already names its effort or parameters, auto, and an unknown list as they are', () => {
    expect(cursorModelForEffort('claude-opus-5-5-high', 'low', ids).model).toBe('claude-opus-5-5-high');
    expect(cursorModelForEffort('gpt-5.4-mini[reasoning=low]', 'high', ids).model).toBe('gpt-5.4-mini[reasoning=low]');
    expect(cursorModelForEffort('auto', 'high', ids).model).toBe('auto');
    expect(cursorModelForEffort('gpt-5.4-mini', 'high', undefined).model).toBe('gpt-5.4-mini');
    expect(cursorModelForEffort('gpt-5.4-mini', 'auto', ids).model).toBe('gpt-5.4-mini');
  });
});
