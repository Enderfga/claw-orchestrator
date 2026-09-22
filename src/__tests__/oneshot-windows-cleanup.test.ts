/**
 * On Windows, `ChildProcess.kill` ends only the process it is given, so an
 * engine CLI's own children outlived a stopped or timed-out session. Cleanup
 * now takes the whole tree with `taskkill /T /F`, bounded so a hung taskkill
 * cannot stall the server, and falls back to `kill` if taskkill fails.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';

const mockSpawn = vi.fn();
const mockExecFileSync = vi.fn();
vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
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

describe('one-shot session cleanup on Windows', () => {
  const realPlatform = process.platform;
  let proc: ReturnType<typeof createMockProcess>;

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    proc = createMockProcess();
    mockSpawn.mockReset().mockReturnValue(proc);
    mockExecFileSync.mockReset();
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform });
  });

  async function stopMidTurn() {
    const session = new PersistentCodexSession({ name: 'w', cwd: '/tmp' });
    await session.start();
    void session.send('hi').catch(() => undefined);
    await new Promise((r) => setTimeout(r, 5));
    await session.stop();
  }

  it('kills the whole process tree with a bounded taskkill', async () => {
    await stopMidTurn();
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'taskkill',
      ['/pid', '4242', '/T', '/F'],
      expect.objectContaining({ timeout: 5_000 }),
    );
    expect(proc.kill).not.toHaveBeenCalled();
  });

  it('falls back to kill when taskkill fails', async () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error('taskkill: access denied');
    });
    await stopMidTurn();
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
  });
});
