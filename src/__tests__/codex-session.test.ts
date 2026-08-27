/**
 * Unit tests for PersistentCodexSession
 *
 * Focused on flag construction — specifically the `jsonSchema` → `--output-schema`
 * wiring added for Codex 0.132+. Uses vitest mocks for child_process.spawn and a
 * real temp dir for the schema file (auto-cleaned on stop()).
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { readFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mockSpawn = vi.fn();
vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

const { PersistentCodexSession } = await import('../persistent-codex-session.js');

function createMockProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: Readable;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
    pid: number;
    exitCode: null;
  };
  proc.stdout = new Readable({ read() {} });
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn();
  proc.pid = 4242;
  proc.exitCode = null;
  return proc;
}

function runTurn(proc: ReturnType<typeof createMockProcess>, threadId: string) {
  proc.stdout.push(JSON.stringify({ type: 'thread.started', thread_id: threadId }) + '\n');
  proc.stdout.push(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'ok' } }) + '\n');
  proc.stdout.push(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }) + '\n');
  proc.stdout.push(null);
  proc.emit('close', 0);
}

// The session harvests codex's own context window and a resumed thread's token
// baseline from `$CODEX_HOME/sessions`. Point that at an empty temp dir so unit
// tests never walk the developer's real rollout history.
const codexHome = mkdtempSync(join(tmpdir(), 'clawo-codexhome-'));
const originalCodexHome = process.env.CODEX_HOME;

/** Write a rollout file where the session's lookup will find it. */
function writeRollout(threadId: string, lines: string[]): void {
  const dir = join(codexHome, 'sessions', '2026', '08', '15');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `rollout-2026-08-15T20-10-40-${threadId}.jsonl`), lines.join('\n'));
}

afterAll(() => {
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
  rmSync(codexHome, { recursive: true, force: true });
});

describe('PersistentCodexSession', () => {
  let mockProc: ReturnType<typeof createMockProcess>;

  beforeEach(() => {
    process.env.CODEX_HOME = codexHome;
    mockProc = createMockProcess();
    mockSpawn.mockReset();
    mockSpawn.mockReturnValue(mockProc);
  });

  it('passes --output-schema with a temp file holding the jsonSchema', async () => {
    const schema = '{"type":"object","properties":{"answer":{"type":"string"}}}';
    const session = new PersistentCodexSession({ name: 'test', cwd: '/tmp', jsonSchema: schema });
    await session.start();

    const sendPromise = session.send('hi', { waitForComplete: true });
    setTimeout(() => runTurn(mockProc, 'thread-1'), 10);
    await sendPromise;

    const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
    const idx = spawnArgs.indexOf('--output-schema');
    expect(idx).toBeGreaterThanOrEqual(0);
    const schemaPath = spawnArgs[idx + 1];
    expect(existsSync(schemaPath)).toBe(true);
    expect(readFileSync(schemaPath, 'utf8')).toBe(schema);

    // stop() removes the temp file.
    session.stop();
    expect(existsSync(schemaPath)).toBe(false);
  });

  it('omits --output-schema when no jsonSchema is configured', async () => {
    const session = new PersistentCodexSession({ name: 'test', cwd: '/tmp' });
    await session.start();

    const sendPromise = session.send('hi', { waitForComplete: true });
    setTimeout(() => runTurn(mockProc, 'thread-2'), 10);
    await sendPromise;

    const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
    expect(spawnArgs).not.toContain('--output-schema');
  });

  it('starts with exec resume when resumeSessionId contains a Codex thread ID', async () => {
    const session = new PersistentCodexSession({
      name: 'test',
      cwd: '/tmp',
      resumeSessionId: '019c6dcb-93ad-7dc1-b531-418d213b8761',
    });
    await session.start();

    const sendPromise = session.send('continue', { waitForComplete: true });
    setTimeout(() => runTurn(mockProc, '019c6dcb-93ad-7dc1-b531-418d213b8761'), 10);
    await sendPromise;

    const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
    expect(spawnArgs.slice(0, 3)).toEqual(['exec', 'resume', '019c6dcb-93ad-7dc1-b531-418d213b8761']);
  });

  // Regression guard: `codex exec resume` rejects --sandbox, and the resumed
  // thread does NOT inherit the first turn's sandbox policy — verified against
  // codex 0.146.0, where a read-only session wrote to disk on its second turn.
  // The mode has to be restated as a `-c` override on every resume, or a
  // read-only session silently becomes writable after turn 1.
  it('restates the sandbox mode as a -c override on resume', async () => {
    const session = new PersistentCodexSession({
      name: 'test',
      cwd: '/tmp',
      sandboxMode: 'read-only',
    });
    await session.start();

    const p1 = session.send('first', { waitForComplete: true });
    setTimeout(() => runTurn(mockProc, 'thread-ro'), 10);
    await p1;

    const proc2 = createMockProcess();
    mockSpawn.mockReturnValue(proc2);
    const p2 = session.send('second', { waitForComplete: true });
    setTimeout(() => runTurn(proc2, 'thread-ro'), 10);
    await p2;

    const args1 = mockSpawn.mock.calls[0][1] as string[];
    const args2 = mockSpawn.mock.calls[1][1] as string[];
    // First turn uses the flag; resume must not (the CLI rejects it there).
    expect(args1).toContain('--sandbox');
    expect(args1[args1.indexOf('--sandbox') + 1]).toBe('read-only');
    expect(args2).not.toContain('--sandbox');
    // Resume carries the policy as a config override instead.
    expect(args2).toContain('resume');
    expect(args2).toContain('sandbox_mode="read-only"');
  });

  it('restates workspace-write on resume so write sessions are unaffected', async () => {
    const session = new PersistentCodexSession({ name: 'test', cwd: '/tmp' });
    await session.start();

    const p1 = session.send('first', { waitForComplete: true });
    setTimeout(() => runTurn(mockProc, 'thread-rw'), 10);
    await p1;

    const proc2 = createMockProcess();
    mockSpawn.mockReturnValue(proc2);
    const p2 = session.send('second', { waitForComplete: true });
    setTimeout(() => runTurn(proc2, 'thread-rw'), 10);
    await p2;

    const args2 = mockSpawn.mock.calls[1][1] as string[];
    expect(args2).toContain('sandbox_mode="workspace-write"');
  });

  it('reuses the same schema file across resume turns', async () => {
    const schema = '{"type":"object"}';
    const session = new PersistentCodexSession({ name: 'test', cwd: '/tmp', jsonSchema: schema });
    await session.start();

    const p1 = session.send('first', { waitForComplete: true });
    setTimeout(() => runTurn(mockProc, 'thread-3'), 10);
    await p1;

    // Second turn resumes; a fresh mock process is needed.
    const proc2 = createMockProcess();
    mockSpawn.mockReturnValue(proc2);
    const p2 = session.send('second', { waitForComplete: true });
    setTimeout(() => runTurn(proc2, 'thread-3'), 10);
    await p2;

    const args1 = mockSpawn.mock.calls[0][1] as string[];
    const args2 = mockSpawn.mock.calls[1][1] as string[];
    expect(args2).toContain('resume');
    const path1 = args1[args1.indexOf('--output-schema') + 1];
    const path2 = args2[args2.indexOf('--output-schema') + 1];
    expect(path2).toBe(path1);

    session.stop();
  });

  it('passes effort straight through to `-c model_reasoning_effort` (max stays max)', async () => {
    const session = new PersistentCodexSession({ name: 'test', cwd: '/tmp', effort: 'max' });
    await session.start();
    const p = session.send('hi', { waitForComplete: true });
    setTimeout(() => runTurn(mockProc, 'thread-eff'), 10);
    await p;

    const argv = mockSpawn.mock.calls[0][1] as string[];
    const ci = argv.indexOf('-c');
    expect(ci).toBeGreaterThanOrEqual(0);
    expect(argv[ci + 1]).toBe('model_reasoning_effort=max');
    session.stop();
  });

  // codex 0.149 added `ultra` above `max`. Folding either down loses a tier the
  // engine really offers — both levels were exercised against 0.149.1 and
  // completed a turn rather than erroring.
  it('reaches codex-only effort levels above max', async () => {
    const session = new PersistentCodexSession({ name: 'test', cwd: '/tmp', effort: 'ultra' });
    await session.start();
    const p = session.send('hi', { waitForComplete: true });
    setTimeout(() => runTurn(mockProc, 'thread-ultra'), 10);
    await p;

    const argv = mockSpawn.mock.calls[0][1] as string[];
    expect(argv[argv.indexOf('-c') + 1]).toBe('model_reasoning_effort=ultra');
    session.stop();
  });

  // `noSessionPersistence` used to reach only Claude Code. Codex's counterpart
  // is `--ephemeral`, which both `exec` and `exec resume` accept.
  it('honours noSessionPersistence with --ephemeral', async () => {
    const session = new PersistentCodexSession({ name: 'test', cwd: '/tmp', noSessionPersistence: true });
    await session.start();
    const p = session.send('hi', { waitForComplete: true });
    setTimeout(() => runTurn(mockProc, 'thread-eph'), 10);
    await p;

    expect(mockSpawn.mock.calls[0][1] as string[]).toContain('--ephemeral');
    session.stop();
  });

  it('passes --ignore-user-config only when asked', async () => {
    const off = new PersistentCodexSession({ name: 'test', cwd: '/tmp' });
    await off.start();
    const p1 = off.send('hi', { waitForComplete: true });
    setTimeout(() => runTurn(mockProc, 'thread-cfg-off'), 10);
    await p1;
    expect(mockSpawn.mock.calls[0][1] as string[]).not.toContain('--ignore-user-config');
    off.stop();

    const proc2 = createMockProcess();
    mockSpawn.mockReturnValue(proc2);
    const on = new PersistentCodexSession({ name: 'test', cwd: '/tmp', ignoreUserConfig: true });
    await on.start();
    const p2 = on.send('hi', { waitForComplete: true });
    setTimeout(() => runTurn(proc2, 'thread-cfg-on'), 10);
    await p2;
    expect(mockSpawn.mock.calls[1][1] as string[]).toContain('--ignore-user-config');
    on.stop();
  });

  // `--add-dir` is accepted by `exec` and rejected by `exec resume`, so it goes
  // on the first turn only — the resumed thread keeps the roots it opened with.
  it('passes extra writable roots on the first turn only', async () => {
    const session = new PersistentCodexSession({ name: 'test', cwd: '/tmp', addDir: ['/srv/a', '/srv/b'] });
    await session.start();
    const p1 = session.send('first', { waitForComplete: true });
    setTimeout(() => runTurn(mockProc, 'thread-dirs'), 10);
    await p1;

    const proc2 = createMockProcess();
    mockSpawn.mockReturnValue(proc2);
    const p2 = session.send('second', { waitForComplete: true });
    setTimeout(() => runTurn(proc2, 'thread-dirs'), 10);
    await p2;

    const args1 = mockSpawn.mock.calls[0][1] as string[];
    const args2 = mockSpawn.mock.calls[1][1] as string[];
    expect(args1.filter((a) => a === '--add-dir')).toHaveLength(2);
    expect(args1).toContain('/srv/a');
    expect(args1).toContain('/srv/b');
    expect(args2).toContain('resume');
    expect(args2).not.toContain('--add-dir');
    session.stop();
  });

  it('omits reasoning-effort override when effort is auto', async () => {
    const session = new PersistentCodexSession({ name: 'test', cwd: '/tmp', effort: 'auto' });
    await session.start();
    const p = session.send('hi', { waitForComplete: true });
    setTimeout(() => runTurn(mockProc, 'thread-auto'), 10);
    await p;

    const argv = mockSpawn.mock.calls[0][1] as string[];
    expect(argv).not.toContain('-c');
    session.stop();
  });

  it('passes --profile when codexProfile is set', async () => {
    const session = new PersistentCodexSession({ name: 'test', cwd: '/tmp', codexProfile: 'fast' });
    await session.start();
    const p = session.send('hi', { waitForComplete: true });
    setTimeout(() => runTurn(mockProc, 'thread-prof'), 10);
    await p;

    const argv = mockSpawn.mock.calls[0][1] as string[];
    const pi = argv.indexOf('--profile');
    expect(pi).toBeGreaterThanOrEqual(0);
    expect(argv[pi + 1]).toBe('fast');
    session.stop();
  });

  it('counts tool items, flags command failures, excludes reasoning/todo from tool counts', async () => {
    const session = new PersistentCodexSession({ name: 'test', cwd: '/tmp' });
    await session.start();
    const p = session.send('hi', { waitForComplete: true });
    setTimeout(() => {
      mockProc.stdout.push(JSON.stringify({ type: 'thread.started', thread_id: 'thread-items' }) + '\n');
      mockProc.stdout.push(
        JSON.stringify({ type: 'item.completed', item: { type: 'reasoning', text: 'thinking' } }) + '\n',
      );
      mockProc.stdout.push(JSON.stringify({ type: 'item.completed', item: { type: 'todo_list' } }) + '\n');
      mockProc.stdout.push(
        JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', exit_code: 0 } }) + '\n',
      );
      mockProc.stdout.push(
        JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', exit_code: 1 } }) + '\n',
      );
      mockProc.stdout.push(JSON.stringify({ type: 'item.completed', item: { type: 'file_change' } }) + '\n');
      mockProc.stdout.push(
        JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'done' } }) + '\n',
      );
      mockProc.stdout.push(
        JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }) + '\n',
      );
      mockProc.stdout.push(null);
      mockProc.emit('close', 0);
    }, 10);
    const result = await p;

    expect(result.text).toBe('done');
    const stats = session.getStats();
    // 3 tool items (2 command_execution + 1 file_change); reasoning + todo_list excluded.
    expect(stats.toolCalls).toBe(3);
    // One command_execution exited non-zero.
    expect(stats.toolErrors).toBe(1);
    session.stop();
  });

  // Regression guard: BaseOneShotSession hardcoded contextPercent to 0, so any
  // consumer gating on it — notably the openai-compat auto-compaction — could
  // never fire for a one-shot engine, and a resumed thread grew until the CLI
  // hard-failed on the context window instead of degrading. It has to reflect
  // the LAST turn's input tokens: `_stats.tokensIn` is cumulative across turns,
  // so it would keep climbing even for an engine that starts fresh each send.
  it('reports contextPercent from the last turn, not the running total', async () => {
    const session = new PersistentCodexSession({ name: 'test', cwd: '/tmp', model: 'gpt-5.5' });
    await session.start();
    expect(session.getStats().contextPercent).toBe(0);

    const runTurnWithInput = (proc: ReturnType<typeof createMockProcess>, inputTokens: number) => {
      proc.stdout.push(JSON.stringify({ type: 'thread.started', thread_id: 'thread-ctx' }) + '\n');
      proc.stdout.push(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'ok' } }) + '\n');
      proc.stdout.push(
        JSON.stringify({ type: 'turn.completed', usage: { input_tokens: inputTokens, output_tokens: 1 } }) + '\n',
      );
      proc.stdout.push(null);
      proc.emit('close', 0);
    };

    // Values below are what codex puts on the wire, i.e. CUMULATIVE thread
    // totals. gpt-5.5's registry window is 1,050,000.
    // Turn 1: thread total 105,000 → this turn's prompt is 105,000 → 10%.
    const p1 = session.send('first', { waitForComplete: true });
    setTimeout(() => runTurnWithInput(mockProc, 105_000), 10);
    await p1;
    expect(session.getStats().contextPercent).toBe(10);

    // Turn 2: thread total 210,000 → this turn's prompt is still 105,000, so
    // the thread has not grown and contextPercent must not move.
    const proc2 = createMockProcess();
    mockSpawn.mockReturnValue(proc2);
    const p2 = session.send('second', { waitForComplete: true });
    setTimeout(() => runTurnWithInput(proc2, 210_000), 10);
    await p2;
    expect(session.getStats().tokensIn).toBe(210_000);
    expect(session.getStats().contextPercent).toBe(10);

    // Turn 3: thread total 420,000 → the prompt doubled to 210,000 → 20%.
    const proc3 = createMockProcess();
    mockSpawn.mockReturnValue(proc3);
    const p3 = session.send('third', { waitForComplete: true });
    setTimeout(() => runTurnWithInput(proc3, 420_000), 10);
    await p3;
    expect(session.getStats().tokensIn).toBe(420_000);
    expect(session.getStats().contextPercent).toBe(20);
    session.stop();
  });

  // Regression guard for the accounting error behind issue #75.
  //
  // `turn.completed.usage` is cumulative over the thread, not per turn — three
  // identical trivial turns against codex 0.147.0 reported input_tokens
  // 13,856 → 27,727 → 41,613, and each value equals `total_token_usage` in that
  // thread's rollout file exactly (`last_token_usage` held the ~13.9k per-turn
  // figure). Accumulating them therefore summed a series of running totals:
  // with a constant prompt P, N turns reported P*N*(N+1)/2 instead of P*N.
  // Cost was overstated by (N+1)/2 and grew without bound.
  it('assigns cumulative usage rather than accumulating it', async () => {
    const session = new PersistentCodexSession({ name: 'test', cwd: '/tmp', model: 'gpt-5.5' });
    await session.start();

    const cumulative = [13_856, 27_727, 41_613];
    for (const [i, total] of cumulative.entries()) {
      const proc = i === 0 ? mockProc : createMockProcess();
      mockSpawn.mockReturnValue(proc);
      const p = session.send(`turn ${i}`, { waitForComplete: true });
      setTimeout(() => {
        proc.stdout.push(JSON.stringify({ type: 'thread.started', thread_id: 'thread-cum' }) + '\n');
        proc.stdout.push(
          JSON.stringify({
            type: 'turn.completed',
            usage: { input_tokens: total, cached_input_tokens: total - 3_000, output_tokens: (i + 1) * 6 },
          }) + '\n',
        );
        proc.stdout.push(null);
        proc.emit('close', 0);
      }, 10);
      await p;
    }

    // The thread total, NOT 13,856 + 27,727 + 41,613 = 83,196.
    expect(session.getStats().tokensIn).toBe(41_613);
    expect(session.getStats().tokensOut).toBe(18);
    expect(session.getStats().cachedTokens).toBe(38_613);
    session.stop();
  });

  it('passes --profile on the first turn but NOT on resume (resume rejects it)', async () => {
    const session = new PersistentCodexSession({ name: 'test', cwd: '/tmp', codexProfile: 'fast' });
    await session.start();

    const p1 = session.send('first', { waitForComplete: true });
    setTimeout(() => runTurn(mockProc, 'thread-pr'), 10);
    await p1;

    const proc2 = createMockProcess();
    mockSpawn.mockReturnValue(proc2);
    const p2 = session.send('second', { waitForComplete: true });
    setTimeout(() => runTurn(proc2, 'thread-pr'), 10);
    await p2;

    const args1 = mockSpawn.mock.calls[0][1] as string[];
    const args2 = mockSpawn.mock.calls[1][1] as string[];
    expect(args1).toContain('--profile');
    expect(args2).toContain('resume');
    expect(args2).not.toContain('--profile');
    session.stop();
  });

  // The registry holds each model's PUBLISHED window (1,050,000 for gpt-5.x).
  // Codex enforces its own, far smaller one — 258,400 measured on 0.147.0 — and
  // that is the limit a request actually dies on, so contextPercent has to be a
  // fraction of codex's number or it reads ~4x low and the auto-compaction gate
  // stays under its threshold right up to a hard context-window failure.
  // Codex does not put it on the JSON stream, only in the thread's rollout file.
  it('measures contextPercent against codex reported window, not the registry', async () => {
    writeRollout('thread-win', [
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', model_context_window: 258_400 } }),
    ]);
    const session = new PersistentCodexSession({ name: 'test', cwd: '/tmp', model: 'gpt-5.5' });
    await session.start();

    const p = session.send('hi', { waitForComplete: true });
    setTimeout(() => {
      mockProc.stdout.push(JSON.stringify({ type: 'thread.started', thread_id: 'thread-win' }) + '\n');
      mockProc.stdout.push(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 129_200 } }) + '\n');
      mockProc.stdout.push(null);
      mockProc.emit('close', 0);
    }, 10);
    await p;

    // 129,200 / 258,400 = 50%. Against the 1,050,000 registry window it is 12%.
    expect(session.getStats().contextPercent).toBe(50);
    session.stop();
  });

  // A resumed thread arrives with a token history this process never saw, so
  // the first `turn.completed` reports a cumulative total covering turns that
  // predate the session. Treating that as the turn's own prompt would report a
  // nearly-full context on the very first send.
  it('seeds the cumulative baseline from the rollout when resuming a thread', async () => {
    writeRollout('thread-resume', [
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', model_context_window: 258_400 } }),
      JSON.stringify({
        type: 'event_msg',
        payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 200_000, total_tokens: 200_010 } } },
      }),
    ]);
    const session = new PersistentCodexSession({
      name: 'test',
      cwd: '/tmp',
      model: 'gpt-5.5',
      resumeSessionId: 'thread-resume',
    });
    await session.start();

    const p = session.send('continue', { waitForComplete: true });
    setTimeout(() => {
      mockProc.stdout.push(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 250_000 } }) + '\n');
      mockProc.stdout.push(null);
      mockProc.emit('close', 0);
    }, 10);
    await p;

    // This turn's prompt is 250,000 - 200,000 = 50,000 → 19% of 258,400.
    // Unseeded it would read the whole 250,000 as one prompt, i.e. 97%.
    expect(session.getStats().contextPercent).toBe(19);
    session.stop();
  });

  // The openai-compat auto-compaction gate calls compact() and discards the
  // result, so a one-shot engine's inability to compact was invisible: the
  // thread grew until the CLI refused it with nothing in the log explaining why.
  it('warns once on the log channel when asked to compact', async () => {
    const session = new PersistentCodexSession({ name: 'test', cwd: '/tmp' });
    await session.start();
    const logs: string[] = [];
    session.on('log', (line: string) => logs.push(line));

    await session.compact();
    await session.compact();

    expect(logs.filter((l) => l.includes('does not support compaction'))).toHaveLength(1);
    session.stop();
  });

  // `turns` counts turns that reached the engine; `turnsSucceeded` counts the ones
  // that succeeded. A `turn.failed` with exit 0 is the case that separates them:
  // the process exits cleanly, so nothing in the exit code says the turn failed.
  describe('turnsSucceeded', () => {
    it('does not count a turn.failed that exits 0', async () => {
      const session = new PersistentCodexSession({ name: 'test', cwd: '/tmp' });
      await session.start();

      const p = session.send('hi', { waitForComplete: true });
      setTimeout(() => {
        mockProc.stdout.push(JSON.stringify({ type: 'thread.started', thread_id: 'thread-failed' }) + '\n');
        mockProc.stdout.push(
          JSON.stringify({ type: 'turn.failed', error: { message: 'model refused the request' } }) + '\n',
        );
        mockProc.stdout.push(null);
        mockProc.emit('close', 0);
      }, 10);
      await expect(p).rejects.toThrow('model refused the request');

      const stats = session.getStats();
      expect(stats.turns).toBe(1);
      expect(stats.turnsSucceeded).toBe(0);
      session.stop();
    });

    // Positive control: without this, the assertion above passes on a counter that
    // is simply never incremented.
    it('counts a clean turn', async () => {
      const session = new PersistentCodexSession({ name: 'test', cwd: '/tmp' });
      await session.start();

      const p = session.send('hi', { waitForComplete: true });
      setTimeout(() => runTurn(mockProc, 'thread-ok'), 10);
      await p;

      const stats = session.getStats();
      expect(stats.turns).toBe(1);
      expect(stats.turnsSucceeded).toBe(1);
      session.stop();
    });
  });
});
