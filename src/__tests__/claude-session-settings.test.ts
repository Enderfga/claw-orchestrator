/**
 * Unit tests for PersistentClaudeSession `--settings` / `ultracode` argv construction.
 *
 * ultracode (dynamic workflows) is enabled via the `ultracode: true` settings key — NOT a
 * --effort value (the CLI rejects `--effort ultracode`). These tests lock the merge logic so
 * user-supplied settings are never dropped. The binary-level behaviour (that
 * `--settings '{"ultracode":true}'` actually activates workflows) is verified out-of-band.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mockSpawn = vi.fn();
vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
  ChildProcess: class {},
}));

const { PersistentClaudeSession } = await import('../persistent-session.js');

function createMockProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: Readable;
    stderr: EventEmitter;
    stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
    kill: ReturnType<typeof vi.fn>;
    unref: ReturnType<typeof vi.fn>;
    pid: number;
    exitCode: null;
    killed: boolean;
  };
  proc.stdout = new Readable({ read() {} });
  proc.stderr = new EventEmitter();
  proc.stdin = { write: vi.fn(), end: vi.fn() };
  proc.kill = vi.fn();
  proc.unref = vi.fn();
  proc.pid = 4242;
  proc.exitCode = null;
  proc.killed = false;
  return proc;
}

/** Start the session and resolve readiness by emitting a `system/init` event. */
async function startReady(session: { start: () => Promise<unknown> }, proc: ReturnType<typeof createMockProcess>) {
  const p = session.start();
  setTimeout(() => {
    proc.stdout.push(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' }) + '\n');
  }, 5);
  await p;
}

/** Returns the value passed after the LAST `--settings` flag, or undefined. */
function settingsValues(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--settings') out.push(argv[i + 1]);
  }
  return out;
}

describe('PersistentClaudeSession --settings / ultracode', () => {
  let mockProc: ReturnType<typeof createMockProcess>;

  beforeEach(() => {
    mockProc = createMockProcess();
    mockSpawn.mockReset();
    mockSpawn.mockReturnValue(mockProc);
  });

  it('injects {"ultracode":true} when ultracode is set and no settings provided', async () => {
    const session = new PersistentClaudeSession({ name: 't', cwd: '/tmp', ultracode: true });
    await startReady(session, mockProc);
    const argv = mockSpawn.mock.calls[0][1] as string[];
    expect(settingsValues(argv)).toEqual(['{"ultracode":true}']);
  });

  it('merges ultracode into inline-JSON settings without dropping existing keys', async () => {
    const session = new PersistentClaudeSession({
      name: 't',
      cwd: '/tmp',
      ultracode: true,
      settings: '{"includeCoAuthoredBy":false}',
    });
    await startReady(session, mockProc);
    const argv = mockSpawn.mock.calls[0][1] as string[];
    const vals = settingsValues(argv);
    expect(vals).toHaveLength(1);
    expect(JSON.parse(vals[0])).toEqual({ includeCoAuthoredBy: false, ultracode: true });
  });

  it('merges ultracode into a settings file path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-settings-'));
    const file = join(dir, 'settings.json');
    writeFileSync(file, JSON.stringify({ model: 'opus' }));
    const session = new PersistentClaudeSession({ name: 't', cwd: '/tmp', ultracode: true, settings: file });
    await startReady(session, mockProc);
    const argv = mockSpawn.mock.calls[0][1] as string[];
    const vals = settingsValues(argv);
    expect(vals).toHaveLength(1);
    expect(JSON.parse(vals[0])).toEqual({ model: 'opus', ultracode: true });
  });

  it('keeps user settings and adds ultracode separately when the value is unparseable', async () => {
    const session = new PersistentClaudeSession({
      name: 't',
      cwd: '/tmp',
      ultracode: true,
      settings: '/no/such/file/path.json',
    });
    await startReady(session, mockProc);
    const argv = mockSpawn.mock.calls[0][1] as string[];
    expect(settingsValues(argv)).toEqual(['/no/such/file/path.json', '{"ultracode":true}']);
  });

  it('passes settings through unchanged when ultracode is not set', async () => {
    const session = new PersistentClaudeSession({ name: 't', cwd: '/tmp', settings: '{"foo":1}' });
    await startReady(session, mockProc);
    const argv = mockSpawn.mock.calls[0][1] as string[];
    expect(settingsValues(argv)).toEqual(['{"foo":1}']);
  });

  it('emits no --settings flag when neither settings nor ultracode are set', async () => {
    const session = new PersistentClaudeSession({ name: 't', cwd: '/tmp' });
    await startReady(session, mockProc);
    const argv = mockSpawn.mock.calls[0][1] as string[];
    expect(argv).not.toContain('--settings');
  });
});
