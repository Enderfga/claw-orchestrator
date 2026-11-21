/**
 * The one-shot `codex_resume` and `codex_review` tools (SessionManager.codexResume
 * / codexReview), against a mocked `spawnEngine`. Event shapes are the ones
 * codex 0.171.0 printed for real runs.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mockSpawn = vi.fn();
vi.mock('../engine-spawn.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../engine-spawn.js')>()),
  spawnEngine: (...args: unknown[]) => mockSpawn(...args),
}));

const { SessionManager } = await import('../session-manager.js');
const { readRunLedger } = await import('../run-ledger.js');

const nullLogger = { debug() {}, info() {}, warn() {}, error() {} };

function createMockProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: Readable;
    stderr: Readable;
    stdin: EventEmitter & { written: string; end: (text?: string) => void };
    kill: ReturnType<typeof vi.fn>;
    pid: number;
    exitCode: number | null;
  };
  proc.stdout = new Readable({ read() {} });
  proc.stderr = new Readable({ read() {} });
  proc.stdin = Object.assign(new EventEmitter(), {
    written: '',
    end(text?: string) {
      this.written += text ?? '';
    },
  });
  proc.kill = vi.fn();
  proc.pid = 5151;
  proc.exitCode = null;
  return proc;
}

/** Path passed with `--output-last-message`. */
const lastMessagePath = (args: string[]): string => args[args.indexOf('--output-last-message') + 1];

/** Finish the mocked run: print the events, write the last message, exit. */
function finish(
  proc: ReturnType<typeof createMockProcess>,
  events: unknown[],
  lastMessage: string | undefined,
  code = 0,
): void {
  const args = mockSpawn.mock.calls.at(-1)![1] as string[];
  if (lastMessage !== undefined) writeFileSync(lastMessagePath(args), lastMessage);
  for (const e of events) proc.stdout.push(JSON.stringify(e) + '\n');
  proc.stdout.push(null);
  proc.stderr.push(null);
  proc.exitCode = code;
  proc.emit('close', code);
}

const codexHome = mkdtempSync(join(tmpdir(), 'clawo-codex-tools-'));
const originalCodexHome = process.env.CODEX_HOME;
afterAll(() => {
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
  rmSync(codexHome, { recursive: true, force: true });
});

describe('codex_resume', () => {
  let proc: ReturnType<typeof createMockProcess>;
  beforeEach(() => {
    process.env.CODEX_HOME = codexHome;
    proc = createMockProcess();
    mockSpawn.mockReset();
    mockSpawn.mockReturnValue(proc);
  });

  // The tool always said it ran workspace-write, and passed no sandbox at all,
  // so the thread ran under whatever the user's config said. `exec resume`
  // rejects --sandbox; the mode goes in as a -c override, as the exec engine
  // restates it on every resumed turn. The prompt goes on stdin.
  it('restates workspace-write, sends the prompt on stdin and answers with the last message', async () => {
    const m = new SessionManager({}, nullLogger);
    const p = m.codexResume({ sessionId: 'thr-1', message: 'line one\nsays "hi"', model: 'gpt-5.5' });
    setTimeout(
      () =>
        finish(
          proc,
          [
            { type: 'thread.started', thread_id: 'thr-1' },
            { type: 'item.completed', item: { type: 'agent_message', text: 'Checking.' } },
            { type: 'item.completed', item: { type: 'agent_message', text: 'done' } },
            { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } },
          ],
          'done',
        ),
      10,
    );
    const r = await p;
    const args = mockSpawn.mock.calls[0][1] as string[];
    expect(args).toEqual([
      'exec',
      'resume',
      'thr-1',
      '--skip-git-repo-check',
      '--json',
      '-c',
      'sandbox_mode="workspace-write"',
      '--model',
      'gpt-5.5',
      '--output-last-message',
      lastMessagePath(args),
      '-',
    ]);
    expect(proc.stdin.written).toBe('line one\nsays "hi"');
    expect(r.text).toBe('done');
    expect(r.threadId).toBe('thr-1');
    expect(r.usage).toEqual({ input_tokens: 10, output_tokens: 2 });
    expect(existsSync(lastMessagePath(args))).toBe(false);
  });

  it('resumes the most recent thread with --last, the prompt still on stdin', async () => {
    const m = new SessionManager({}, nullLogger);
    const p = m.codexResume({ last: true, message: 'continue', cwd: '/tmp' });
    setTimeout(() => finish(proc, [{ type: 'turn.completed', usage: {} }], undefined), 10);
    const r = await p;
    const args = mockSpawn.mock.calls[0][1] as string[];
    expect(args.slice(0, 3)).toEqual(['exec', 'resume', '--last']);
    expect(args.at(-1)).toBe('-');
    expect(args).not.toContain('continue');
    expect(proc.stdin.written).toBe('continue');
    expect(r.text).toBe('');
  });

  it('refuses a session id that codex would read as an option', async () => {
    const m = new SessionManager({}, nullLogger);
    await expect(
      m.codexResume({ sessionId: '--dangerously-bypass-approvals-and-sandbox', message: 'x' }),
    ).rejects.toThrow(/session id/);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('rejects with stderr when codex exits non-zero', async () => {
    const m = new SessionManager({}, nullLogger);
    const p = m.codexResume({ sessionId: 'missing', message: 'x' });
    setTimeout(() => {
      proc.stderr.push('Error: no rollout found for thread id missing\n');
      finish(proc, [], undefined, 1);
    }, 10);
    await expect(p).rejects.toThrow(/no rollout found/);
  });
});

describe('codex_review', () => {
  let proc: ReturnType<typeof createMockProcess>;
  beforeEach(() => {
    process.env.CODEX_HOME = codexHome;
    proc = createMockProcess();
    mockSpawn.mockReset();
    mockSpawn.mockReturnValue(proc);
  });

  // Measured on 0.171.0: `codex exec review --json` reports a turn.completed
  // whose usage is all zeros. The review runs as a sub-agent with a rollout of
  // its own (`source: {subagent: "review"}`, `parent_thread_id` = the exec
  // thread), and that rollout's token_count holds what it spent.
  it('runs `codex exec review --json`, answers with the last message and records the review sub-agent usage', async () => {
    const parent = '01a1fc82-6c05-77b0-b944-3f5411a6e062';
    const child = '01a1fc82-6cbf-7f91-9bca-71ce7eabb4b0';
    const dir = join(codexHome, 'sessions', '2026', '11', '21');
    mkdirSync(dir, { recursive: true });
    // An unrelated rollout of the same day, newer by name, that must not be taken.
    writeFileSync(
      join(dir, 'rollout-2026-11-21T13-09-29-01a1fc82-ffff-7000-8000-000000000000.jsonl'),
      JSON.stringify({ type: 'session_meta', payload: { id: 'other', source: 'exec' } }) + '\n',
    );

    const m = new SessionManager({}, nullLogger);
    const p = m.codexReview({ prompt: 'Review add.py. One sentence.', uncommitted: true, cwd: '/tmp' });
    setTimeout(() => {
      writeFileSync(
        join(dir, `rollout-2026-11-21T13-09-28-${child}.jsonl`),
        [
          JSON.stringify({
            type: 'session_meta',
            payload: { session_id: parent, id: child, parent_thread_id: parent, source: { subagent: 'review' } },
          }),
          JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-6.2-astra' } }),
          JSON.stringify({
            type: 'event_msg',
            payload: {
              type: 'token_count',
              info: {
                total_token_usage: {
                  input_tokens: 41381,
                  cached_input_tokens: 20480,
                  cache_write_input_tokens: 0,
                  output_tokens: 272,
                  reasoning_output_tokens: 0,
                  total_tokens: 41653,
                },
              },
            },
          }),
        ].join('\n'),
      );
      finish(
        proc,
        [
          { type: 'thread.started', thread_id: parent },
          { type: 'turn.started' },
          { type: 'item.completed', item: { id: 'item_0', type: 'command_execution', exit_code: 0 } },
          { type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: 'Returns a - b. [P1] …' } },
          {
            type: 'turn.completed',
            usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 },
          },
        ],
        'Returns a - b. [P1] …',
      );
    }, 10);
    const r = await p;

    const args = mockSpawn.mock.calls[0][1] as string[];
    expect(args.slice(0, 5)).toEqual(['exec', 'review', '--json', '--skip-git-repo-check', '--uncommitted']);
    expect(args.slice(-3)).toEqual(['--output-last-message', lastMessagePath(args), '-']);
    expect(args).not.toContain('--ephemeral');
    expect(proc.stdin.written).toBe('Review add.py. One sentence.');
    expect(r.stdout).toBe('Returns a - b. [P1] …');
    expect(r.threadId).toBe(parent);
    expect(r.usage).toEqual({
      input_tokens: 41381,
      cached_input_tokens: 20480,
      output_tokens: 272,
      reasoning_output_tokens: 0,
    });

    const rows = readRunLedger({ session: 'codex_review' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      engine: 'codex',
      model: 'gpt-6.2-astra',
      tokensIn: 41381,
      tokensOut: 272,
      cachedTokens: 20480,
      toolCalls: 1,
      toolErrors: 0,
      ok: true,
      tokensEstimated: false,
    });
    expect(rows[0].costUsd).toBeGreaterThan(0);
  });

  it('passes the scope flags and model, and no `-` without a prompt', async () => {
    const m = new SessionManager({}, nullLogger);
    const p = m.codexReview({ base: 'main', title: 'Fix add', model: 'gpt-5.5', cwd: '/tmp' });
    setTimeout(
      () => finish(proc, [{ type: 'turn.completed', usage: { input_tokens: 5, output_tokens: 1 } }], 'no findings'),
      10,
    );
    const r = await p;
    const args = mockSpawn.mock.calls[0][1] as string[];
    expect(args).toEqual([
      'exec',
      'review',
      '--json',
      '--skip-git-repo-check',
      '--base',
      'main',
      '--title',
      'Fix add',
      '--model',
      'gpt-5.5',
      '--output-last-message',
      lastMessagePath(args),
    ]);
    expect(r.stdout).toBe('no findings');
    // Usage codex did report is used as it is.
    expect(r.usage).toEqual({ input_tokens: 5, output_tokens: 1 });
  });

  it('still refuses two diff scopes and a ref that looks like an option', async () => {
    const m = new SessionManager({}, nullLogger);
    await expect(m.codexReview({ uncommitted: true, base: 'main' })).rejects.toThrow(/mutually exclusive/);
    await expect(m.codexReview({ commit: '--output-last-message=/etc/x' })).rejects.toThrow(/invalid commit/);
    expect(mockSpawn).not.toHaveBeenCalled();
  });
});
