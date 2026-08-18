/**
 * Unit tests for the durable run ledger.
 *
 * The property that matters most here is the negative one: a ledger failure must
 * never propagate. Everything else (schema, filtering, tolerance of corrupt
 * rows) exists so that a query after a restart still answers honestly.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  appendRunRow,
  formatRunTable,
  parseSince,
  readRunLedger,
  runsDir,
  summarizeRuns,
  type RunLedgerRow,
} from '../run-ledger.js';

let tmpDir: string;
const originalEnv = process.env.CLAWO_RUNS_DIR;

function row(over: Partial<RunLedgerRow> = {}): RunLedgerRow {
  return {
    ts: '2026-08-18T12:00:00.000Z',
    session: 'alpha',
    engine: 'claude',
    model: 'claude-opus-5',
    cwd: '/tmp/project',
    turn: 1,
    tokensIn: 100,
    tokensOut: 50,
    cachedTokens: 0,
    costUsd: 0.01,
    tokensEstimated: false,
    durationMs: 1200,
    toolCalls: 2,
    toolErrors: 0,
    ok: true,
    ...over,
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawo-ledger-'));
  process.env.CLAWO_RUNS_DIR = tmpDir;
});

afterEach(() => {
  if (originalEnv === undefined) delete process.env.CLAWO_RUNS_DIR;
  else process.env.CLAWO_RUNS_DIR = originalEnv;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('runsDir', () => {
  it('honours CLAWO_RUNS_DIR', () => {
    expect(runsDir()).toBe(tmpDir);
  });
});

describe('appendRunRow', () => {
  it('shards by the row timestamp date and round-trips the schema', () => {
    appendRunRow(row());
    const file = path.join(tmpDir, '2026-08-18.jsonl');
    expect(fs.existsSync(file)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8').trim());
    expect(parsed).toEqual(row());
  });

  it('appends rather than truncating', () => {
    appendRunRow(row({ turn: 1 }));
    appendRunRow(row({ turn: 2 }));
    const lines = fs.readFileSync(path.join(tmpDir, '2026-08-18.jsonl'), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
  });

  it('swallows I/O failures and only warns — a broken ledger must not break a turn', () => {
    // Point the ledger at a path that cannot be a directory.
    const blocker = path.join(tmpDir, 'blocked');
    fs.writeFileSync(blocker, 'not-a-directory');
    process.env.CLAWO_RUNS_DIR = path.join(blocker, 'runs');
    const warn = vi.fn();
    expect(() => appendRunRow(row(), { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() })).not.toThrow();
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0][0])).toContain('[run-ledger]');
  });
});

describe('parseSince', () => {
  const NOW = Date.parse('2026-08-18T12:00:00.000Z');

  it('returns undefined for an absent spec', () => {
    expect(parseSince(undefined, NOW)).toBeUndefined();
    expect(parseSince('', NOW)).toBeUndefined();
  });

  it('parses relative windows', () => {
    expect(parseSince('30m', NOW)).toBe(NOW - 1_800_000);
    expect(parseSince('24h', NOW)).toBe(NOW - 86_400_000);
    expect(parseSince('7d', NOW)).toBe(NOW - 604_800_000);
    expect(parseSince('2w', NOW)).toBe(NOW - 1_209_600_000);
  });

  it('parses ISO timestamps and epoch ms', () => {
    expect(parseSince('2026-08-18T00:00:00.000Z', NOW)).toBe(Date.parse('2026-08-18T00:00:00.000Z'));
    expect(parseSince(1_700_000_000_000, NOW)).toBe(1_700_000_000_000);
  });

  it('widens rather than narrows when the spec is junk', () => {
    expect(parseSince('not-a-time', NOW)).toBeUndefined();
  });
});

describe('readRunLedger', () => {
  it('returns rows oldest-first', () => {
    appendRunRow(row({ turn: 1, ts: '2026-08-18T10:00:00.000Z' }));
    appendRunRow(row({ turn: 2, ts: '2026-08-18T11:00:00.000Z' }));
    expect(readRunLedger().map((r) => r.turn)).toEqual([1, 2]);
  });

  it('reads across day shards', () => {
    appendRunRow(row({ turn: 1, ts: '2026-08-17T10:00:00.000Z' }));
    appendRunRow(row({ turn: 2, ts: '2026-08-18T10:00:00.000Z' }));
    expect(readRunLedger().map((r) => r.turn)).toEqual([1, 2]);
  });

  it('filters by session, engine and parent', () => {
    appendRunRow(row({ session: 'alpha', engine: 'claude' }));
    appendRunRow(row({ session: 'beta', engine: 'codex', parent: 'council-1' }));
    expect(readRunLedger({ session: 'beta' })).toHaveLength(1);
    expect(readRunLedger({ engine: 'codex' })[0].session).toBe('beta');
    expect(readRunLedger({ parent: 'council-1' })[0].session).toBe('beta');
    expect(readRunLedger({ parent: 'nope' })).toHaveLength(0);
  });

  it('filters by since', () => {
    appendRunRow(row({ turn: 1, ts: new Date(Date.now() - 3 * 86_400_000).toISOString() }));
    appendRunRow(row({ turn: 2, ts: new Date().toISOString() }));
    expect(readRunLedger({ since: '24h' }).map((r) => r.turn)).toEqual([2]);
  });

  it('keeps the most recent rows when limited', () => {
    for (let i = 1; i <= 5; i++) {
      appendRunRow(row({ turn: i, ts: `2026-08-18T1${i}:00:00.000Z` }));
    }
    expect(readRunLedger({ limit: 2 }).map((r) => r.turn)).toEqual([4, 5]);
  });

  it('skips corrupt lines instead of failing the whole query', () => {
    appendRunRow(row({ turn: 1 }));
    fs.appendFileSync(path.join(tmpDir, '2026-08-18.jsonl'), '{not json\n');
    fs.appendFileSync(path.join(tmpDir, '2026-08-18.jsonl'), '{"ts":123}\n');
    appendRunRow(row({ turn: 2 }));
    expect(readRunLedger().map((r) => r.turn)).toEqual([1, 2]);
  });

  it('returns an empty list when nothing has been recorded', () => {
    expect(readRunLedger()).toEqual([]);
  });
});

describe('summarizeRuns', () => {
  it('totals cost and tokens and buckets by engine', () => {
    const s = summarizeRuns([
      row({ engine: 'claude', costUsd: 0.02 }),
      row({ engine: 'codex', costUsd: 0.03 }),
      row({ engine: 'codex', costUsd: 0.04, tokensEstimated: true }),
    ]);
    expect(s.rows).toBe(3);
    expect(s.costUsd).toBeCloseTo(0.09, 4);
    expect(s.tokensIn).toBe(300);
    expect(s.estimatedRows).toBe(1);
    expect(s.byEngine.codex).toEqual({ rows: 2, costUsd: 0.07 });
  });
});

describe('formatRunTable', () => {
  it('says so plainly when there is nothing to show', () => {
    expect(formatRunTable([])).toBe('No runs recorded.');
  });

  it('marks estimated rows and surfaces the caveat in the footer', () => {
    const out = formatRunTable([row({ tokensEstimated: true, engine: 'cursor' })]);
    expect(out).toContain('$0.0100~');
    expect(out).toContain('estimated token counts');
  });

  it('shows the error for a failed turn', () => {
    const out = formatRunTable([row({ ok: false, error: 'engine exited 1' })]);
    expect(out).toContain('error: engine exited 1');
  });

  it('does not print a bare label when a failed turn carries no error text', () => {
    // Reachable since the ledger's `ok` reads the session's turnsSucceeded counter:
    // an interrupted codex-app turn or a non-SUCCESS agy turn resolves without
    // throwing, so `ok` is false while `error` is undefined.
    const out = formatRunTable([row({ ok: false })]);
    expect(out).toContain('not counted as succeeded');
    expect(out).not.toMatch(/error:\s*$/m);
  });
});
