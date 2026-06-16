/**
 * Unit tests for consensus vote parsing
 */

import { describe, it, expect } from 'vitest';
import { parseConsensus, parseConsensusWithSource, stripConsensusTags, hasConsensusMarker } from '../consensus.js';

// ─── parseConsensus ─────────────────────────────────────────────────────────

describe('parseConsensus', () => {
  const cases: Array<{ name: string; content: string; expected: boolean }> = [
    // Strict format
    { name: 'standard YES', content: 'Some text\n[CONSENSUS: YES]\n', expected: true },
    { name: 'standard NO', content: 'Some text\n[CONSENSUS: NO]\n', expected: false },
    { name: 'Chinese colon YES', content: 'Report\n[CONSENSUS：YES]\n', expected: true },
    { name: 'Chinese colon NO', content: 'Report\n[CONSENSUS：NO]\n', expected: false },
    { name: 'extra whitespace', content: '[ CONSENSUS :  YES ]', expected: true },

    // Variant formats
    { name: 'lowercase consensus: yes', content: 'consensus: yes', expected: true },
    { name: 'markdown bold no', content: '**consensus**: no', expected: false },
    { name: 'CONSENSUS=YES', content: 'CONSENSUS=YES', expected: true },
    { name: 'Chinese voting YES', content: '共识投票：YES', expected: true },
    { name: '[CONSENSUS]: NO', content: '[CONSENSUS]: NO', expected: false },

    // Variant match (not tail fallback — these match the variant regex pattern)
    { name: 'tail: consensus yes', content: 'Text here\nconsensus yes', expected: true },
    { name: 'tail: consensus no (keyword)', content: 'Some text\nconsensus no', expected: false },

    // No explicit tag — default to NO (tail fallback removed to prevent false positives)
    { name: 'no Chinese consensus tag', content: 'Report\n我们已达成共识', expected: false },
    { name: 'no negative Chinese tag', content: 'Report\n我们未达成共识', expected: false },
    { name: 'no negative Chinese tag 2', content: 'Report\n我们没有达成共识', expected: false },
    { name: 'no consensus reached', content: 'Summary: we did not reach consensus yet', expected: false },

    // Default
    { name: 'no vote at all', content: 'Just some random text with no vote', expected: false },

    // Multiple votes — last one wins
    {
      name: 'multiple votes, last wins',
      content: '[CONSENSUS: NO]\nChanged my mind\n[CONSENSUS: YES]',
      expected: true,
    },
    { name: 'multiple votes, last NO', content: '[CONSENSUS: YES]\nActually\n[CONSENSUS: NO]', expected: false },
  ];

  for (const { name, content, expected } of cases) {
    it(name, () => {
      expect(parseConsensus(content)).toBe(expected);
    });
  }
});

// ─── stripConsensusTags ─────────────────────────────────────────────────────

describe('stripConsensusTags', () => {
  it('removes [CONSENSUS: YES] tag', () => {
    expect(stripConsensusTags('Report here\n[CONSENSUS: YES]\n')).toBe('Report here');
  });

  it('removes all consensus tags', () => {
    expect(stripConsensusTags('[CONSENSUS: NO] and [CONSENSUS: YES]')).toBe('and');
  });
});

// ─── hasConsensusMarker ─────────────────────────────────────────────────────

describe('hasConsensusMarker', () => {
  it('detects strict format', () => {
    expect(hasConsensusMarker('[CONSENSUS: YES]')).toBe(true);
  });

  it('detects lowercase variant', () => {
    expect(hasConsensusMarker('consensus: no')).toBe(true);
  });

  it('detects Chinese variant', () => {
    expect(hasConsensusMarker('共识投票：YES')).toBe(true);
  });

  it('returns false when no marker', () => {
    expect(hasConsensusMarker('no vote here')).toBe(false);
  });
});

describe('parseConsensusWithSource', () => {
  it('reports strict source for the [CONSENSUS: …] tag', () => {
    expect(parseConsensusWithSource('all good [CONSENSUS: YES]')).toEqual({ vote: true, source: 'strict' });
  });
  it('reports variant source for a loose vote', () => {
    expect(parseConsensusWithSource('my consensus: no')).toEqual({ vote: false, source: 'variant' });
  });
  it('reports none (defaulting to NO) when no vote is present', () => {
    expect(parseConsensusWithSource('I have not finished reviewing')).toEqual({ vote: false, source: 'none' });
  });
});
