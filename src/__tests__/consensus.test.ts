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

// ── The two readers of the vote formats must agree.
//
//    `hasConsensusMarker` restated three of the five variant patterns, so a
//    short reply voting as `**consensus**: yes` / `CONSENSUS=YES` /
//    `[CONSENSUS]: YES` answered false — and council's follow-up gate then
//    spent up to two extra 60s turns asking for a vote it had already parsed.
describe('hasConsensusMarker agrees with parseConsensusWithSource', () => {
  const votes = [
    '[CONSENSUS: YES]',
    '[CONSENSUS: NO]',
    '[CONSENSUS：YES]',
    'consensus: yes',
    'consensus no',
    '**consensus**: yes',
    'CONSENSUS=YES',
    'CONSENSUS=NO',
    '[CONSENSUS]: YES',
    '共识投票: YES',
    'Done. **consensus**: no',
  ];

  it('finds a marker for every format the parser reads a vote from', () => {
    for (const text of votes) {
      expect(parseConsensusWithSource(text).source).not.toBe('none');
      expect(hasConsensusMarker(text)).toBe(true);
    }
  });

  it('finds none where the parser reads none', () => {
    for (const text of ['no vote here', 'we reached agreement', 'the consensus of the group was unclear']) {
      if (parseConsensusWithSource(text).source === 'none') {
        expect(hasConsensusMarker(text)).toBe(false);
      }
    }
  });

  it('is stable across repeated calls', () => {
    // The patterns are module-level and global; a reader that advanced
    // lastIndex would answer differently the second time.
    for (const text of votes) {
      expect(hasConsensusMarker(text)).toBe(true);
      expect(hasConsensusMarker(text)).toBe(true);
      expect(parseConsensusWithSource(text).source).toBe(parseConsensusWithSource(text).source);
    }
  });
});
