// agy's quota, read with its free print-mode info commands (`/usage`, `/credits`). Shapes captured from agy 1.5.18.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';

const mockSpawn = vi.fn();
vi.mock('../engine-spawn.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../engine-spawn.js')>()),
  spawnEngine: (...args: unknown[]) => mockSpawn(...args),
  killEngineTree: vi.fn(),
}));

const { agyQuotaWindows, parseAgyInfoAnswer, readAgyQuota } = await import('../agy-quota.js');
const { quotaEngines, readEngineQuota } = await import('../engine-quota.js');

const USAGE = {
  groups: [
    {
      name: 'Gemini Models',
      buckets: [
        {
          id: 'gemini-weekly',
          window: 'weekly',
          remaining_fraction: 0.82346147,
          reset_time: '2026-12-03T07:02:05Z',
        },
        { id: 'gemini-5h', window: '5h', remaining_fraction: 0.95337677, reset_time: '2026-11-28T09:02:05Z' },
      ],
    },
    {
      name: 'Claude and GPT models',
      buckets: [{ id: '3p-weekly', window: 'weekly', remaining_fraction: 1, reset_time: '1970-01-01T00:00:00Z' }],
    },
  ],
};
const zero = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0 };
const answer = (name: string, data: unknown, response = '') =>
  [
    JSON.stringify({ event: 'command_result', command: { name, data } }),
    JSON.stringify({
      event: 'result',
      result: { conversation_id: '', status: 'SUCCESS', response, num_turns: 0, usage: zero, command: { name, data } },
    }),
  ].join('\n') + '\n';

function proc(stdout: string, code: number) {
  const p = new EventEmitter() as EventEmitter & { stdout: Readable; stderr: EventEmitter; pid: number };
  p.stdout = new Readable({ read() {} });
  p.stderr = new EventEmitter();
  p.pid = 1;
  setTimeout(() => {
    p.stdout.push(stdout);
    p.stdout.push(null);
    p.emit('close', code);
  }, 2);
  return p;
}

beforeEach(() => {
  mockSpawn.mockReset();
});

describe('agy quota', () => {
  it('reads /usage buckets as windows; an unused bucket has no reset time', () => {
    expect(agyQuotaWindows(USAGE)).toEqual([
      { name: 'Gemini Models weekly', remainingPercent: 82.3, usedPercent: 17.7, resetsAt: '2026-12-03T07:02:05Z' },
      { name: 'Gemini Models 5h', remainingPercent: 95.3, usedPercent: 4.7, resetsAt: '2026-11-28T09:02:05Z' },
      { name: 'Claude and GPT models weekly', remainingPercent: 100, usedPercent: 0 },
    ]);
  });

  it('parses an info answer and a refusal', () => {
    expect(parseAgyInfoAnswer(answer('credits', { remaining_credits: 0 }, 'Remaining credits\t0\n'))).toEqual({
      ok: true,
      text: 'Remaining credits\t0\n',
      data: { remaining_credits: 0 },
    });
    const refused = JSON.stringify({ event: 'result', result: { status: 'ERROR', response: '', error: 'no' } });
    expect(parseAgyInfoAnswer(refused)).toEqual({ ok: false, text: '', error: 'no' });
    expect(parseAgyInfoAnswer('not json')).toBeUndefined();
  });

  it('runs /usage and /credits, and is the registered agy reader', async () => {
    mockSpawn.mockImplementation((_bin: string, args: string[]) =>
      args[1] === '/usage' ? proc(answer('usage', USAGE), 0) : proc(answer('credits', { remaining_credits: 12 }), 0),
    );
    expect(quotaEngines()).toContain('agy');
    const q = await readEngineQuota('agy', { cwd: '/tmp' });
    expect(q).toMatchObject({ engine: 'agy', source: 'agy /usage', raw: { usage: USAGE, credits: 12 } });
    expect(q?.windows).toHaveLength(3);
    const calls = mockSpawn.mock.calls.map((c) => (c[1] as string[]).slice(0, 4));
    expect(calls).toEqual(
      expect.arrayContaining([
        ['-p', '/usage', '--output-format', 'stream-json'],
        ['-p', '/credits', '--output-format', 'stream-json'],
      ]),
    );
  });

  it('has nothing to read under an API key (agy exits 2 without a payload)', async () => {
    mockSpawn.mockImplementation(() => proc('', 2));
    await expect(readAgyQuota()).resolves.toBeUndefined();
  });

  it('fails a reading that is neither an answer nor a refusal', async () => {
    mockSpawn.mockImplementation(() => proc('', 1));
    await expect(readAgyQuota()).rejects.toThrow(/gave no quota/);
  });
});
