/**
 * Tests for Coder/Reviewer reply parsers.
 */

import { describe, it, expect } from 'vitest';
import {
  parseAgentReply,
  extractIterComplete,
  extractReviewComplete,
  extractClarification,
} from '../autoloop/v2/agent-tools.js';

describe('parseAgentReply', () => {
  it('extracts blocks from a coder reply', () => {
    const reply = `Fixed the off-by-one in add_two.

\`\`\`autoloop
{"tool": "iter_complete", "args": {"summary": "fixed add_two", "eval_output": {"metric": 0.95}, "files_changed": ["src/math.py"]}}
\`\`\``;
    const r = parseAgentReply(reply);
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0].tool).toBe('iter_complete');
    expect(r.cleaned_reply).toContain('Fixed the off-by-one');
    expect(r.cleaned_reply).not.toContain('autoloop');
  });
});

describe('extractIterComplete', () => {
  it('returns null when no iter_complete block', () => {
    expect(extractIterComplete([])).toBeNull();
    expect(extractIterComplete([{ tool: 'coder_log', args: { message: 'hi' } }])).toBeNull();
  });

  it('returns the last iter_complete when multiple are present', () => {
    const calls = [
      { tool: 'iter_complete', args: { summary: 'first', eval_output: { metric: 0.5 } } },
      { tool: 'iter_complete', args: { summary: 'last', eval_output: { metric: 0.9 } } },
    ];
    const ic = extractIterComplete(calls);
    expect(ic?.summary).toBe('last');
  });

  it('parses files_changed when supplied as string array', () => {
    const ic = extractIterComplete([
      { tool: 'iter_complete', args: { summary: 's', eval_output: {}, files_changed: ['a.py', 42, 'b.py'] } },
    ]);
    expect(ic?.files_changed).toEqual(['a.py', 'b.py']);
  });
});

describe('extractReviewComplete', () => {
  it('parses a typical advance verdict', () => {
    const rc = extractReviewComplete([
      {
        tool: 'review_complete',
        args: { decision: 'advance', metric: 0.92, audit_notes: 'all gates green' },
      },
    ]);
    expect(rc).toEqual({ decision: 'advance', metric: 0.92, audit_notes: 'all gates green', flags: undefined });
  });

  it('returns null on invalid decision', () => {
    const rc = extractReviewComplete([
      { tool: 'review_complete', args: { decision: 'maybe', metric: 0.5, audit_notes: 'x' } },
    ]);
    expect(rc).toBeNull();
  });

  it('preserves flags array when present', () => {
    const rc = extractReviewComplete([
      {
        tool: 'review_complete',
        args: {
          decision: 'hold',
          metric: 0.6,
          audit_notes: 'gate B fail',
          flags: ['gate_B_fail', 'sus_metric_jump'],
        },
      },
    ]);
    expect(rc?.flags).toEqual(['gate_B_fail', 'sus_metric_jump']);
  });

  it('coerces metric to null when non-numeric', () => {
    const rc = extractReviewComplete([
      { tool: 'review_complete', args: { decision: 'hold', metric: 'broken', audit_notes: 'x' } },
    ]);
    expect(rc?.metric).toBeNull();
  });
});

describe('extractClarification', () => {
  it('returns the question text', () => {
    const q = extractClarification([
      { tool: 'request_clarification', args: { question: 'should I touch the eval script?' } },
    ]);
    expect(q).toBe('should I touch the eval script?');
  });
  it('returns null when not present', () => {
    expect(extractClarification([])).toBeNull();
  });
});
