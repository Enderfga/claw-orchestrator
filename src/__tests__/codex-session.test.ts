/**
 * Unit tests for PersistentCodexSession
 *
 * Focused on flag construction — specifically the `jsonSchema` → `--output-schema`
 * wiring added for Codex 0.132+. Uses vitest mocks for child_process.spawn and a
 * real temp dir for the schema file (auto-cleaned on stop()).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { readFileSync, existsSync } from 'node:fs';

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

describe('PersistentCodexSession', () => {
  let mockProc: ReturnType<typeof createMockProcess>;

  beforeEach(() => {
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

  it('maps effort to `-c model_reasoning_effort` (max → xhigh)', async () => {
    const session = new PersistentCodexSession({ name: 'test', cwd: '/tmp', effort: 'max' });
    await session.start();
    const p = session.send('hi', { waitForComplete: true });
    setTimeout(() => runTurn(mockProc, 'thread-eff'), 10);
    await p;

    const argv = mockSpawn.mock.calls[0][1] as string[];
    const ci = argv.indexOf('-c');
    expect(ci).toBeGreaterThanOrEqual(0);
    expect(argv[ci + 1]).toBe('model_reasoning_effort=xhigh');
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

    // gpt-5.5 has a 1,050,000-token window; 105,000 in is 10%.
    const p1 = session.send('first', { waitForComplete: true });
    setTimeout(() => runTurnWithInput(mockProc, 105_000), 10);
    await p1;
    expect(session.getStats().contextPercent).toBe(10);

    // Second turn's prompt is smaller. Cumulative tokensIn is now 315k (30%),
    // so a total-based figure would report 30 — the last turn is what counts.
    const proc2 = createMockProcess();
    mockSpawn.mockReturnValue(proc2);
    const p2 = session.send('second', { waitForComplete: true });
    setTimeout(() => runTurnWithInput(proc2, 210_000), 10);
    await p2;
    expect(session.getStats().tokensIn).toBe(315_000);
    expect(session.getStats().contextPercent).toBe(20);
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
});
