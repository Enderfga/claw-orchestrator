// agy's own /compact (a summary pass over the conversation), run as a turn of its own and waited for. Driven
// through the real close path: a mocked send could not tell a /compact that returned at once from one that ran.
import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import type { TurnResult } from '../types.js';

const mockSpawn = vi.fn();
vi.mock('../engine-spawn.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../engine-spawn.js')>()),
  spawnEngine: (...args: unknown[]) => mockSpawn(...args),
}));

const { PersistentAgySession } = await import('../persistent-agy-session.js');
const CONV = '3003cea8-3e09-4c7a-ba63-14ef444eab46';

/** One agy run: the `/compact` stream measured on 1.5.18 (a checkpoint step, an empty SUCCESS result). */
function compactRun(delayMs: number) {
  const proc = new EventEmitter() as EventEmitter & { stdout: Readable; stderr: EventEmitter; pid: number };
  proc.stdout = new Readable({ read() {} });
  proc.stderr = new EventEmitter();
  proc.pid = 7;
  const lines = [
    {
      event: 'init',
      conversation_id: CONV,
      init: { model: 'gemini-3.8-flash', expanded_commands: [{ name: 'compact', type: 'system' }] },
    },
    {
      event: 'step_update',
      step_update: {
        conversation_id: CONV,
        step_index: 10,
        state: 'DONE',
        step_type: 'checkpoint',
        usage: { input_tokens: 3094, output_tokens: 332, cache_read_tokens: 21753 },
      },
    },
    { event: 'result', result: { conversation_id: CONV, status: 'SUCCESS', response: '', num_turns: 4, usage: {} } },
  ];
  setTimeout(() => {
    for (const l of lines) proc.stdout.push(`${JSON.stringify(l)}\n`);
    proc.stderr.emit('data', Buffer.from('warning: run ended with no output and no recorded error\n'));
    proc.stdout.push(null);
    proc.emit('close', 0);
  }, delayMs);
  return proc;
}

describe('PersistentAgySession.compact', () => {
  it('a conversation to compact: a /compact turn with slash commands on for it alone, resolved once it is done', async () => {
    const s = new PersistentAgySession({
      name: 't',
      cwd: '/tmp',
      permissionMode: 'default',
      resumeSessionId: CONV,
      disableSlashCommands: true,
    });
    await s.start();
    mockSpawn.mockImplementation(() => compactRun(40));
    const startedAt = Date.now();
    const r = (await s.compact()) as TurnResult;
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(35);
    expect(r.event.compacted).toBe(true);
    const args = mockSpawn.mock.calls[0][1] as string[];
    expect(args[1]).toBe('/compact');
    expect(args).not.toContain('--disable-slash-commands');
    expect(args).toEqual(expect.arrayContaining(['--conversation', CONV]));
    // The empty reply is not a failed turn, and the compaction is not a turn at all.
    expect(s.getStats()).toMatchObject({ turns: 0, turnsSucceeded: 0 });
    expect(s.isBusy).toBe(false);
  });

  it('no conversation yet: nothing to compact, nothing sent', async () => {
    const s = new PersistentAgySession({ name: 't', cwd: '/tmp', permissionMode: 'default' });
    const send = vi.spyOn(s, 'send');
    const r = (await s.compact()) as TurnResult;
    expect(send).not.toHaveBeenCalled();
    expect(r.text).toMatch(/nothing to compact/i);
    expect(r.event.compacted).toBe(false);
  });
});
