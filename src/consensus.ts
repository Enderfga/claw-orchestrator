/**
 * Consensus vote parsing utilities
 *
 * Ported from three-minds — detects [CONSENSUS: YES/NO] tags in agent
 * responses with multiple fallback patterns for variant formats.
 */

/** Remove all [CONSENSUS: YES/NO] tags from text */
export function stripConsensusTags(text: string): string {
  return text.replace(/\[\s*CONSENSUS\s*[:：]\s*(?:YES|NO)\s*\]/gi, '').trim();
}

/**
 * The strict tag agents are asked for, and the loose spellings we accept anyway.
 *
 * One list, because two readers of it drifted: `hasConsensusMarker` restated
 * three of the five and so answered false for `**consensus**: yes`,
 * `CONSENSUS=YES` and `[CONSENSUS]: YES` — votes `parseConsensusWithSource`
 * reads perfectly well. A short reply carrying one of those tripped council's
 * follow-up gate and spent up to two extra 60s turns asking for a vote it had
 * already parsed.
 */
const CONSENSUS_STRICT = /\[\s*CONSENSUS\s*[:：]\s*(YES|NO)\s*\]/gi;
const CONSENSUS_VARIANTS = [
  /consensus[:\s]+(yes|no)/gi,
  /\*\*consensus\*\*[:\s]+(yes|no)/gi,
  /CONSENSUS=(YES|NO)/gi,
  /共识投票[:：\s]+(YES|NO)/gi,
  /\[CONSENSUS\][:\s]+(YES|NO)/gi,
];

/** Check whether text contains any consensus vote marker */
export function hasConsensusMarker(text: string): boolean {
  // `test` on a /g regex advances lastIndex, so match instead of test.
  return [CONSENSUS_STRICT, ...CONSENSUS_VARIANTS].some((re) => text.match(re) !== null);
}

/**
 * Parse a consensus vote from agent response text.
 *
 * Priority chain:
 * 1. Strict format: [CONSENSUS: YES] / [CONSENSUS: NO]
 * 2. Common variants: consensus: yes, **consensus**: no, CONSENSUS=YES, etc.
 * 3. Tail fallback: analyse last 8 lines for positive/negative signals
 * 4. Default: false (no consensus)
 */
export function parseConsensus(content: string): boolean {
  return parseConsensusWithSource(content).vote;
}

/**
 * Like {@link parseConsensus} but also reports HOW the vote was detected, so
 * callers can surface when a vote came from a loose variant (lower confidence)
 * or was absent entirely (`none` → defaulted to NO).
 */
export function parseConsensusWithSource(content: string): { vote: boolean; source: 'strict' | 'variant' | 'none' } {
  // Strict format (supports Chinese colon) — take the LAST match
  const strictMatches = [...content.matchAll(CONSENSUS_STRICT)];
  if (strictMatches.length > 0) {
    return { vote: strictMatches[strictMatches.length - 1][1].toUpperCase() === 'YES', source: 'strict' };
  }

  // Fallback: common variants — also take the last match
  for (const pattern of CONSENSUS_VARIANTS) {
    const matches = [...content.matchAll(pattern)];
    if (matches.length > 0) {
      return { vote: matches[matches.length - 1][1].toUpperCase() === 'YES', source: 'variant' };
    }
  }

  // No explicit consensus tag found — default to NO.
  // The previous tail-fallback heuristic was removed because it caused false
  // positives when agents echoed back prompt instructions containing consensus
  // keywords without actually voting.
  return { vote: false, source: 'none' };
}
