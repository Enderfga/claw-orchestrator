/**
 * A persistent custom engine speaks claude's stream-json, where every tool_use
 * block arrives twice: on `content_block_start` with an empty input, then as an
 * `assistant` event with the same id and the full input.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { SESSION_EVENT } from '../constants.js';
import type { CustomEngineConfig } from '../types.js';

const mockSpawn = vi.fn();
vi.mock('../engine-spawn.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../engine-spawn.js')>()),
  spawnEngine: (...args: unknown[]) => mockSpawn(...args),
}));

const { PersistentCustomSession } = await import('../persistent-custom-session.js');

describe('PersistentCustomSession tool events', () => {
  it('reports each tool call once, with its input', () => {
    const session = new PersistentCustomSession({
      name: 'custom-tools',
      cwd: process.cwd(),
      customEngine: { name: 'stream-json-cli', bin: 'node', persistent: true },
    });
    const seen: unknown[] = [];
    session.on(SESSION_EVENT.TOOL_USE, (e: unknown) => seen.push(e));
    const feed = (session as unknown as { _handlePersistentEvent(e: unknown): void })._handlePersistentEvent.bind(
      session,
    );

    for (const [id, command] of [
      ['toolu_1', 'echo one'],
      ['toolu_2', 'echo two'],
    ]) {
      feed({
        type: 'stream_event',
        event: { type: 'content_block_start', content_block: { type: 'tool_use', id, name: 'Bash', input: {} } },
      });
      feed({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } });
    }

    expect(session.getStats().toolCalls).toBe(2);
    expect(seen).toEqual([
      { tool: { name: 'Bash', input: { command: 'echo one' } } },
      { tool: { name: 'Bash', input: { command: 'echo two' } } },
    ]);
  });
});

function createMockProc() {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: Readable;
    stderr: EventEmitter;
    stdin: { writable: boolean; write: (s: string, cb?: (e?: Error) => void) => boolean };
    written: string[];
    kill: ReturnType<typeof vi.fn>;
    unref: () => void;
    pid: number;
    exitCode: number | null;
    killed: boolean;
  };
  proc.stdout = new Readable({ read() {} });
  proc.stderr = new EventEmitter();
  proc.written = [];
  proc.stdin = {
    writable: true,
    write(s: string, cb?: (e?: Error) => void) {
      proc.written.push(s);
      cb?.();
      return true;
    },
  };
  proc.kill = vi.fn();
  proc.unref = () => undefined;
  proc.pid = 5150;
  proc.exitCode = null;
  proc.killed = false;
  return proc;
}

// The charter of a council seat travels in `appendSystemPrompt`, so a custom
// engine has to deliver it whichever mode it runs in: through the configured
// flag, or else at the top of the first message of each conversation.
describe('PersistentCustomSession — appendSystemPrompt', () => {
  beforeEach(() => mockSpawn.mockReset());

  const oneShot = (args: CustomEngineConfig['args']): CustomEngineConfig => ({ name: 'one-shot-cli', bin: 'x', args });

  async function runOneShot(engine: CustomEngineConfig, message: string): Promise<string[]> {
    const proc = createMockProc();
    mockSpawn.mockReturnValueOnce(proc);
    const session = new PersistentCustomSession({
      name: 'seat',
      cwd: process.cwd(),
      customEngine: engine,
      appendSystemPrompt: 'SEAT RULES',
    });
    await session.start();
    const turn = session.send(message, { waitForComplete: true });
    setTimeout(() => {
      proc.stdout.push('done\n');
      proc.stdout.push(null);
      setTimeout(() => proc.emit('close', 0), 5);
    }, 5);
    await turn;
    return mockSpawn.mock.calls.at(-1)![1] as string[];
  }

  it('one-shot: leads every message when the CLI has no flag for it', async () => {
    const engine = oneShot({ print: '-p' });
    expect(await runOneShot(engine, 'hi')).toEqual(['-p', 'SEAT RULES\n\n---\n\nhi']);
    // Nothing carries over between one-shot sends, so each one is a new conversation.
    expect(await runOneShot(engine, 'again')).toEqual(['-p', 'SEAT RULES\n\n---\n\nagain']);
  });

  it('one-shot: goes through the configured flag when there is one', async () => {
    const argv = await runOneShot(oneShot({ print: '-p', appendSystemPrompt: '--append-system-prompt' }), 'hi');
    expect(argv).toEqual(['-p', 'hi', '--append-system-prompt', 'SEAT RULES']);
  });

  it('persistent: leads the first message only when the CLI has no flag for it', async () => {
    const proc = createMockProc();
    mockSpawn.mockReturnValue(proc);
    const session = new PersistentCustomSession({
      name: 'seat',
      cwd: process.cwd(),
      customEngine: { name: 'stream-json-cli', bin: 'x', persistent: true, args: {} },
      appendSystemPrompt: 'SEAT RULES',
    });
    const started = session.start();
    proc.stdout.push(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' }) + '\n');
    await started;
    await session.send('hi');
    await session.send('again');
    const texts = proc.written.map(
      (line) => (JSON.parse(line) as { message: { content: Array<{ text: string }> } }).message.content[0].text,
    );
    expect(texts).toEqual(['SEAT RULES\n\n---\n\nhi', 'again']);
  });
});
