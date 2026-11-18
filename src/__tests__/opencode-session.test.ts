/**
 * Unit tests for PersistentOpencodeSession
 *
 * Tests the opencode `--format json` event parser. Mocks child_process.spawn
 * to feed synthetic NDJSON events. The schema mirrors sst/opencode's
 * `packages/opencode/src/cli/cmd/run.ts` emit shape:
 *   { type, timestamp, sessionID, ...data }
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';

// Mock child_process before importing the session
const mockSpawn = vi.fn();
// `opencode --version`, keyed by binary — the session checks it once at start.
const versions: Record<string, string | Error> = {};
vi.mock('../engine-spawn.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../engine-spawn.js')>()),
  spawnEngine: (...args: unknown[]) => mockSpawn(...args),
  execEngine: async (bin: string) => {
    const v = versions[bin] ?? '1.19.0';
    if (v instanceof Error) throw v;
    return { stdout: `${v}\n`, stderr: '' };
  },
}));

const { PersistentOpencodeSession, isOpencodeV2, isOpencodeV2Prerelease } =
  await import('../persistent-opencode-session.js');

// ─── Mock Process Helper ────────────────────────────────────────────────────

function createMockProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: Readable & { destroy: ReturnType<typeof vi.fn> };
    stderr: EventEmitter & { destroy: ReturnType<typeof vi.fn> };
    stdin: { end: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn> };
    kill: ReturnType<typeof vi.fn>;
    pid: number;
    exitCode: null;
  };
  proc.stdout = new Readable({ read() {} });
  (proc.stdout as Readable & { destroy: ReturnType<typeof vi.fn> }).destroy = vi.fn();
  const stderrEmitter = new EventEmitter() as EventEmitter & { destroy: ReturnType<typeof vi.fn> };
  stderrEmitter.destroy = vi.fn();
  proc.stderr = stderrEmitter;
  proc.stdin = { end: vi.fn(), on: vi.fn() };
  proc.kill = vi.fn();
  proc.pid = 23456;
  proc.exitCode = null;
  return proc;
}

function feedLines(proc: ReturnType<typeof createMockProcess>, lines: string[]) {
  for (const line of lines) {
    proc.stdout.push(line + '\n');
  }
}

function closeProc(proc: ReturnType<typeof createMockProcess>, code: number) {
  proc.stdout.push(null);
  proc.emit('close', code);
}

const SID = 'opencode-test-session';
function envelope(type: string, data: Record<string, unknown>): string {
  return JSON.stringify({ type, timestamp: 1234567890, sessionID: SID, ...data });
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('PersistentOpencodeSession', () => {
  let mockProc: ReturnType<typeof createMockProcess>;

  beforeEach(() => {
    mockProc = createMockProcess();
    mockSpawn.mockReset();
    mockSpawn.mockReturnValue(mockProc);
  });

  describe('start()', () => {
    it('initializes session and emits ready', async () => {
      const session = new PersistentOpencodeSession({ name: 'test', cwd: '/tmp', permissionMode: 'default' });
      const readyFn = vi.fn();
      session.on('ready', readyFn);

      await session.start();

      expect(session.isReady).toBe(true);
      expect(session.sessionId).toMatch(/^opencode-/);
      expect(readyFn).toHaveBeenCalled();
    });
  });

  describe('reasoning effort', () => {
    // `--variant` is opencode's effort knob. Before this the engine got nothing
    // and every caller's `effort` was silently discarded.
    it('forwards effort as --variant', async () => {
      const session = new PersistentOpencodeSession({
        name: 'test',
        cwd: '/tmp',
        permissionMode: 'bypassPermissions',
        effort: 'high',
      });
      await session.start();
      const sendPromise = session.send('hi', { waitForComplete: true });
      setTimeout(() => closeProc(mockProc, 0), 10);
      await sendPromise;

      const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
      expect(spawnArgs[spawnArgs.indexOf('--variant') + 1]).toBe('high');
    });

    it('omits --variant for auto', async () => {
      const session = new PersistentOpencodeSession({
        name: 'test',
        cwd: '/tmp',
        permissionMode: 'bypassPermissions',
        effort: 'auto',
      });
      await session.start();
      const sendPromise = session.send('hi', { waitForComplete: true });
      setTimeout(() => closeProc(mockProc, 0), 10);
      await sendPromise;

      expect(mockSpawn.mock.calls[0][1] as string[]).not.toContain('--variant');
    });
  });

  describe('token accounting', () => {
    // `tokens.input` is only the uncached remainder: opencode's own arithmetic
    // is total = input + output + cache.read + cache.write (26315 = 58 + 17 +
    // 26240 + 0 on a resumed turn). Subtracting the cached part back out of it
    // is what made a cached session bill at nothing.
    it('bills the full input side rather than subtracting cached reads out of it', async () => {
      const session = new PersistentOpencodeSession({
        name: 'test',
        cwd: '/tmp',
        permissionMode: 'bypassPermissions',
        model: 'anthropic/claude-sonnet-4-6',
      });
      await session.start();
      const sendPromise = session.send('hi', { waitForComplete: true });
      setTimeout(() => {
        feedLines(mockProc, [
          envelope('step_finish', {
            part: {
              type: 'step-finish',
              tokens: { total: 26_315, input: 58, output: 17, reasoning: 0, cache: { write: 0, read: 26_240 } },
            },
          }),
        ]);
        closeProc(mockProc, 0);
      }, 10);
      await sendPromise;

      const cost = session.getCost();
      expect(cost.tokensIn).toBe(58);
      expect(cost.cachedTokens).toBe(26_240);
      // claude-sonnet-4-6: input 3, cached 0.3, output 15 per Mtok.
      const expected = (58 * 3 + 26_240 * 0.3 + 17 * 15) / 1_000_000;
      expect(cost.totalUsd).toBeCloseTo(expected, 10);
      // The clamp used to swallow the whole input side; it must not be free.
      expect(cost.breakdown.inputCost).toBeGreaterThan(0);
    });

    it('measures context against the whole prompt, not the uncached remainder', async () => {
      const session = new PersistentOpencodeSession({
        name: 'test',
        cwd: '/tmp',
        permissionMode: 'bypassPermissions',
        model: 'anthropic/claude-sonnet-4-6',
      });
      await session.start();
      const sendPromise = session.send('hi', { waitForComplete: true });
      setTimeout(() => {
        feedLines(mockProc, [
          envelope('step_finish', {
            part: {
              type: 'step-finish',
              tokens: { total: 500_017, input: 17, output: 0, cache: { write: 0, read: 500_000 } },
            },
          }),
        ]);
        closeProc(mockProc, 0);
      }, 10);
      await sendPromise;

      // 500,017 of a 1M window. Reading `input` alone would have said 0%.
      expect(session.getStats().contextPercent).toBe(50);
    });
  });

  describe('spawn flags', () => {
    it('uses run --format json', async () => {
      const session = new PersistentOpencodeSession({
        name: 'test',
        cwd: '/tmp',
        permissionMode: 'bypassPermissions',
      });
      await session.start();

      const sendPromise = session.send('hello', { waitForComplete: true });
      setTimeout(() => closeProc(mockProc, 0), 10);
      await sendPromise;

      const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
      expect(spawnArgs[0]).toBe('run');
      // The message goes on stdin: on Windows `opencode` is an npm .cmd shim,
      // and cmd.exe would cut an argv message at its first newline.
      expect(spawnArgs).not.toContain('hello');
      expect(mockProc.stdin.end).toHaveBeenCalledWith('hello');
      expect(spawnArgs).toContain('--format');
      expect(spawnArgs).toContain('json');
      // 1.1.40 does not have / does not need --dangerously-skip-permissions.
      // Adding it would trigger yargs strict mode and print the help screen.
      expect(spawnArgs).not.toContain('--dangerously-skip-permissions');
    });

    // Regression guard: `opencode run` opens a NEW session unless --session names
    // one, so omitting it made every turn an amnesiac first turn. Verified against
    // 1.18.18: without the flag turn 2 answers "you never asked me to remember
    // anything"; with it, turn 2 recalls turn 1.
    it('passes --session with the harvested id on the second turn', async () => {
      const session = new PersistentOpencodeSession({ name: 'test', cwd: '/tmp' });
      await session.start();

      const p1 = session.send('first', { waitForComplete: true });
      setTimeout(() => {
        feedLines(mockProc, [JSON.stringify({ type: 'step_start', sessionID: 'ses_abc123' })]);
        closeProc(mockProc, 0);
      }, 10);
      await p1;

      const proc2 = createMockProcess();
      mockSpawn.mockReturnValue(proc2);
      const p2 = session.send('second', { waitForComplete: true });
      setTimeout(() => closeProc(proc2, 0), 10);
      await p2;

      const args1 = mockSpawn.mock.calls[0][1] as string[];
      const args2 = mockSpawn.mock.calls[1][1] as string[];
      // The first turn has no id to resume yet.
      expect(args1).not.toContain('--session');
      expect(args2).toContain('--session');
      expect(args2[args2.indexOf('--session') + 1]).toBe('ses_abc123');
      // --continue means "the last session on this machine" and would collide
      // across concurrent sessions, so it must not be used.
      expect(args2).not.toContain('--continue');
    });

    // `opencode run` has no system-prompt flag, so `appendSystemPrompt` used to
    // be dropped. It leads the turn that opens the session, and only that turn.
    it('puts appendSystemPrompt only on the turn that opens the session', async () => {
      const session = new PersistentOpencodeSession({ name: 'test', cwd: '/tmp', appendSystemPrompt: 'SEAT RULES' });
      await session.start();

      const p1 = session.send('first', { waitForComplete: true });
      setTimeout(() => {
        feedLines(mockProc, [JSON.stringify({ type: 'step_start', sessionID: 'ses_abc123' })]);
        closeProc(mockProc, 0);
      }, 10);
      await p1;

      const proc2 = createMockProcess();
      mockSpawn.mockReturnValue(proc2);
      const p2 = session.send('second', { waitForComplete: true });
      setTimeout(() => closeProc(proc2, 0), 10);
      await p2;

      expect(mockProc.stdin.end).toHaveBeenCalledWith('SEAT RULES\n\n---\n\nfirst');
      expect(proc2.stdin.end).toHaveBeenCalledWith('second');
    });

    it('resumes a persisted opencode session id from config', async () => {
      const session = new PersistentOpencodeSession({
        name: 'test',
        cwd: '/tmp',
        resumeSessionId: 'opencode-live-ses_persisted',
      });
      await session.start();

      const p = session.send('hello', { waitForComplete: true });
      setTimeout(() => closeProc(mockProc, 0), 10);
      await p;

      const args = mockSpawn.mock.calls[0][1] as string[];
      expect(args).toContain('--session');
      // The `opencode-live-` display prefix is stripped; the CLI wants the raw id.
      expect(args[args.indexOf('--session') + 1]).toBe('ses_persisted');
    });

    it('uses the plan agent for read-only sessions', async () => {
      const session = new PersistentOpencodeSession({
        name: 'test',
        cwd: '/tmp',
        permissionMode: 'manual',
        sandboxMode: 'read-only',
      });
      await session.start();

      const sendPromise = session.send('hello', { waitForComplete: true });
      setTimeout(() => closeProc(mockProc, 0), 10);
      await sendPromise;

      const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
      expect(spawnArgs).toContain('--agent');
      expect(spawnArgs).toContain('clawo-readonly');
      const spawnOptions = mockSpawn.mock.calls[0][2] as { env: Record<string, string> };
      const config = JSON.parse(spawnOptions.env.OPENCODE_CONFIG_CONTENT) as {
        agent: Record<string, { permission: Record<string, string>; tools: Record<string, boolean> }>;
      };
      expect(config.agent['clawo-readonly'].permission).toMatchObject({
        edit: 'deny',
        bash: 'deny',
        external_directory: 'deny',
      });
    });

    // Regression guard: denying only the write tools leaves the delegation path
    // open — the agent hands the write to a subagent via `task`, and the
    // subagent runs under the default writable agent. Asked to delegate, a
    // session denied only edit/bash/external_directory wrote to disk every time.
    it('closes the subagent delegation path in the read-only config', async () => {
      const session = new PersistentOpencodeSession({
        name: 'test',
        cwd: '/tmp',
        sandboxMode: 'read-only',
      });
      await session.start();

      const sendPromise = session.send('hello', { waitForComplete: true });
      setTimeout(() => closeProc(mockProc, 0), 10);
      await sendPromise;

      const spawnOptions = mockSpawn.mock.calls[0][2] as { env: Record<string, string> };
      const agent = (
        JSON.parse(spawnOptions.env.OPENCODE_CONFIG_CONTENT) as {
          agent: Record<string, { permission: Record<string, string>; tools: Record<string, boolean> }>;
        }
      ).agent['clawo-readonly'];
      expect(agent.permission.task).toBe('deny');
      // The tool is also removed outright, so enforcement does not depend on
      // the permission engine resolving our rules the way we expect.
      expect(agent.tools).toMatchObject({ task: false, write: false, edit: false, bash: false });
    });

    it('rejects a read-only turn if the enforcement agent fails to load', async () => {
      // opencode prints this to stdout and silently runs the DEFAULT, writable
      // agent when --agent can't be resolved. A read-only session must fail
      // rather than hand back output produced without its sandbox.
      const session = new PersistentOpencodeSession({
        name: 'test',
        cwd: '/tmp',
        permissionMode: 'manual',
        sandboxMode: 'read-only',
      });
      await session.start();

      const sendPromise = session.send('hello', { waitForComplete: true });
      setTimeout(() => {
        feedLines(mockProc, ['! agent "clawo-readonly" not found. Falling back to default agent']);
        closeProc(mockProc, 0);
      }, 10);

      await expect(sendPromise).rejects.toThrow(/read-only enforcement failed/i);
      // The turn reached the engine and was refused on purpose: counted, not succeeded.
      const stats = session.getStats();
      expect(stats.turns).toBe(1);
      expect(stats.turnsSucceeded).toBe(0);
    });

    // Positive control for the refusal above, and the only cover for this engine's
    // normal close path.
    it('counts a clean turn', async () => {
      const session = new PersistentOpencodeSession({
        name: 'test',
        cwd: '/tmp',
        permissionMode: 'bypassPermissions',
      });
      await session.start();

      const sendPromise = session.send('hello', { waitForComplete: true });
      setTimeout(() => closeProc(mockProc, 0), 10);
      await sendPromise;

      const stats = session.getStats();
      expect(stats.turns).toBe(1);
      expect(stats.turnsSucceeded).toBe(1);
    });

    it('passes --model only when model contains "/"', async () => {
      const session = new PersistentOpencodeSession({
        name: 'test',
        cwd: '/tmp',
        permissionMode: 'bypassPermissions',
        model: 'anthropic/claude-sonnet-4',
      });
      await session.start();

      const sendPromise = session.send('hi', { waitForComplete: true });
      setTimeout(() => closeProc(mockProc, 0), 10);
      await sendPromise;

      const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
      expect(spawnArgs).toContain('--model');
      expect(spawnArgs).toContain('anthropic/claude-sonnet-4');
    });

    it('omits --model when value is not in provider/model form', async () => {
      const session = new PersistentOpencodeSession({
        name: 'test',
        cwd: '/tmp',
        permissionMode: 'bypassPermissions',
        model: 'sonnet',
      });
      await session.start();

      const sendPromise = session.send('hi', { waitForComplete: true });
      setTimeout(() => closeProc(mockProc, 0), 10);
      await sendPromise;

      const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
      expect(spawnArgs).not.toContain('--model');
    });
  });

  describe('text event parsing', () => {
    it('treats sequential text events for same part.id as cumulative snapshots', async () => {
      const session = new PersistentOpencodeSession({
        name: 'test',
        cwd: '/tmp',
        permissionMode: 'bypassPermissions',
      });
      await session.start();

      const sendPromise = session.send('hi', { waitForComplete: true });
      setTimeout(() => {
        feedLines(mockProc, [
          envelope('text', { part: { type: 'text', id: 'p1', text: 'Hello' } }),
          envelope('text', { part: { type: 'text', id: 'p1', text: 'Hello world' } }),
          envelope('text', { part: { type: 'text', id: 'p1', text: 'Hello world!' } }),
        ]);
        closeProc(mockProc, 0);
      }, 10);

      const result = await sendPromise;
      expect('text' in result && result.text).toBe('Hello world!');
    });

    it('streams only the delta on each cumulative text event', async () => {
      const session = new PersistentOpencodeSession({
        name: 'test',
        cwd: '/tmp',
        permissionMode: 'bypassPermissions',
      });
      await session.start();

      const deltas: string[] = [];
      const sendPromise = session.send('hi', {
        waitForComplete: true,
        callbacks: { onText: (t: string) => deltas.push(t) },
      });
      setTimeout(() => {
        feedLines(mockProc, [
          envelope('text', { part: { type: 'text', id: 'p1', text: 'Hello' } }),
          envelope('text', { part: { type: 'text', id: 'p1', text: 'Hello world' } }),
          envelope('text', { part: { type: 'text', id: 'p1', text: 'Hello world!' } }),
        ]);
        closeProc(mockProc, 0);
      }, 10);

      await sendPromise;
      expect(deltas).toEqual(['Hello', ' world', '!']);
    });

    it('concatenates separate text parts in arrival order', async () => {
      const session = new PersistentOpencodeSession({
        name: 'test',
        cwd: '/tmp',
        permissionMode: 'bypassPermissions',
      });
      await session.start();

      const sendPromise = session.send('hi', { waitForComplete: true });
      setTimeout(() => {
        feedLines(mockProc, [
          envelope('text', { part: { type: 'text', id: 'p1', text: 'First.' } }),
          envelope('text', { part: { type: 'text', id: 'p2', text: 'Second.' } }),
        ]);
        closeProc(mockProc, 0);
      }, 10);

      const result = await sendPromise;
      expect('text' in result && result.text).toBe('First.Second.');
    });
  });

  describe('tool_use event parsing', () => {
    it('counts each unique callID once across re-emissions', async () => {
      const session = new PersistentOpencodeSession({
        name: 'test',
        cwd: '/tmp',
        permissionMode: 'bypassPermissions',
      });
      await session.start();

      const sendPromise = session.send('hi', { waitForComplete: true });
      setTimeout(() => {
        feedLines(mockProc, [
          envelope('tool_use', {
            part: { type: 'tool', callID: 'c1', tool: 'read', state: { status: 'pending' } },
          }),
          envelope('tool_use', {
            part: { type: 'tool', callID: 'c1', tool: 'read', state: { status: 'completed' } },
          }),
          envelope('tool_use', {
            part: { type: 'tool', callID: 'c2', tool: 'write', state: { status: 'pending' } },
          }),
          envelope('tool_use', {
            part: { type: 'tool', callID: 'c2', tool: 'write', state: { status: 'error', error: 'boom' } },
          }),
        ]);
        closeProc(mockProc, 0);
      }, 10);

      await sendPromise;
      const stats = session.getStats();
      expect(stats.toolCalls).toBe(2);
      expect(stats.toolErrors).toBe(1);
    });
  });

  describe('step_finish usage', () => {
    it('extracts tokens from part.tokens.{input,output} and cache.read', async () => {
      const session = new PersistentOpencodeSession({
        name: 'test',
        cwd: '/tmp',
        permissionMode: 'bypassPermissions',
      });
      await session.start();

      const sendPromise = session.send('hi', { waitForComplete: true });
      setTimeout(() => {
        feedLines(mockProc, [
          envelope('text', { part: { type: 'text', id: 'p1', text: 'done' } }),
          envelope('step_finish', {
            part: {
              type: 'step-finish',
              tokens: { input: 200, output: 80, reasoning: 0, cache: { read: 50, write: 0 } },
              cost: 0.001,
            },
          }),
        ]);
        closeProc(mockProc, 0);
      }, 10);

      await sendPromise;
      const stats = session.getStats();
      expect(stats.tokensIn).toBe(200);
      expect(stats.tokensOut).toBe(80);
      expect(stats.cachedTokens).toBe(50);
    });

    // The model opencode chose is not in its JSON, so the registry priced every
    // turn as Sonnet — a free default model showed up in the ledger at $0.15 a turn.
    it('bills what opencode reported, a free model at zero', async () => {
      const session = new PersistentOpencodeSession({ name: 'test', cwd: '/tmp', permissionMode: 'bypassPermissions' });
      await session.start();
      const sendPromise = session.send('hi', { waitForComplete: true });
      setTimeout(() => {
        feedLines(mockProc, [
          envelope('step_finish', { part: { type: 'step-finish', tokens: { input: 90000, output: 2000 }, cost: 0 } }),
          envelope('step_finish', { part: { type: 'step-finish', tokens: { input: 1000, output: 100 }, cost: 0 } }),
        ]);
        closeProc(mockProc, 0);
      }, 10);
      await sendPromise;
      expect(session.getStats().costUsd).toBe(0);
    });

    it('sums reported cost across steps', async () => {
      const session = new PersistentOpencodeSession({ name: 'test', cwd: '/tmp', permissionMode: 'bypassPermissions' });
      await session.start();
      const sendPromise = session.send('hi', { waitForComplete: true });
      setTimeout(() => {
        feedLines(mockProc, [
          envelope('step_finish', { part: { type: 'step-finish', tokens: { input: 10, output: 5 }, cost: 0.0125 } }),
          envelope('step_finish', { part: { type: 'step-finish', tokens: { input: 10, output: 5 }, cost: 0.0075 } }),
        ]);
        closeProc(mockProc, 0);
      }, 10);
      await sendPromise;
      expect(session.getStats().costUsd).toBeCloseTo(0.02, 6);
    });

    it('still estimates when opencode reports no cost', async () => {
      const session = new PersistentOpencodeSession({ name: 'test', cwd: '/tmp', permissionMode: 'bypassPermissions' });
      await session.start();
      const sendPromise = session.send('hi', { waitForComplete: true });
      setTimeout(() => {
        feedLines(mockProc, [
          envelope('step_finish', { part: { type: 'step-finish', tokens: { input: 1_000_000, output: 0 } } }),
        ]);
        closeProc(mockProc, 0);
      }, 10);
      await sendPromise;
      expect(session.getStats().costUsd).toBeGreaterThan(0);
    });
  });

  describe('fallback estimation', () => {
    it('estimates tokens when no step_finish arrives', async () => {
      const session = new PersistentOpencodeSession({
        name: 'test',
        cwd: '/tmp',
        permissionMode: 'bypassPermissions',
      });
      await session.start();

      const sendPromise = session.send('a prompt message that has some length', { waitForComplete: true });
      setTimeout(() => {
        feedLines(mockProc, [
          envelope('text', { part: { type: 'text', id: 'p1', text: 'a meaningful response of nontrivial length' } }),
        ]);
        closeProc(mockProc, 0);
      }, 10);

      await sendPromise;
      const stats = session.getStats();
      expect(stats.tokensIn).toBeGreaterThan(0);
      expect(stats.tokensOut).toBeGreaterThan(0);
    });
  });

  describe('session id capture', () => {
    it('captures sessionID from event envelope', async () => {
      const session = new PersistentOpencodeSession({
        name: 'test',
        cwd: '/tmp',
        permissionMode: 'bypassPermissions',
      });
      await session.start();

      const sendPromise = session.send('hi', { waitForComplete: true });
      setTimeout(() => {
        feedLines(mockProc, [envelope('text', { part: { type: 'text', id: 'p1', text: 'hi' } })]);
        closeProc(mockProc, 0);
      }, 10);

      await sendPromise;
      expect(session.sessionId).toBe(`opencode-live-${SID}`);
    });
  });

  describe('reasoning events', () => {
    it('does not include reasoning text in the result', async () => {
      const session = new PersistentOpencodeSession({
        name: 'test',
        cwd: '/tmp',
        permissionMode: 'bypassPermissions',
      });
      await session.start();

      const sendPromise = session.send('hi', { waitForComplete: true });
      setTimeout(() => {
        feedLines(mockProc, [
          envelope('reasoning', { part: { type: 'reasoning', text: 'thinking internally...' } }),
          envelope('text', { part: { type: 'text', id: 'p1', text: 'final answer' } }),
        ]);
        closeProc(mockProc, 0);
      }, 10);

      const result = await sendPromise;
      expect('text' in result && result.text).toBe('final answer');
      expect('text' in result && result.text).not.toContain('thinking');
    });
  });

  describe('exit codes', () => {
    it('rejects on non-zero exit', async () => {
      const session = new PersistentOpencodeSession({
        name: 'test',
        cwd: '/tmp',
        permissionMode: 'bypassPermissions',
      });
      await session.start();

      const sendPromise = session.send('hi', { waitForComplete: true });
      setTimeout(() => closeProc(mockProc, 1), 10);

      await expect(sendPromise).rejects.toThrow('OpenCode exited with code 1');
    });
  });

  describe('lifecycle', () => {
    it('stop() kills in-flight process', async () => {
      const session = new PersistentOpencodeSession({
        name: 'test',
        cwd: '/tmp',
        permissionMode: 'bypassPermissions',
      });
      await session.start();

      session.send('hi', { waitForComplete: false });

      session.stop();
      expect(mockProc.kill).toHaveBeenCalledWith('SIGTERM');
      expect(session.isReady).toBe(false);
    });

    it('compact() returns no-op message', async () => {
      const session = new PersistentOpencodeSession({
        name: 'test',
        cwd: '/tmp',
        permissionMode: 'bypassPermissions',
      });
      await session.start();

      const result = await session.compact();
      expect(result.text).toContain('does not support compaction');
    });

    it('getCost() uses opencode-default model label', async () => {
      const session = new PersistentOpencodeSession({
        name: 'test',
        cwd: '/tmp',
        permissionMode: 'bypassPermissions',
      });
      await session.start();

      const cost = session.getCost();
      expect(cost.model).toBe('opencode-default');
    });
  });

  describe('stderr sanitization', () => {
    it('redacts ANTHROPIC_API_KEY from stderr', async () => {
      const session = new PersistentOpencodeSession({
        name: 'test',
        cwd: '/tmp',
        permissionMode: 'bypassPermissions',
      });
      await session.start();

      const logs: string[] = [];
      session.on('log', (msg: string) => logs.push(msg));

      const sendPromise = session.send('hi', { waitForComplete: true });
      setTimeout(() => {
        mockProc.stderr.emit('data', Buffer.from('Error: ANTHROPIC_API_KEY=sk-abcdef invalid'));
        closeProc(mockProc, 0);
      }, 10);

      await sendPromise;
      expect(logs.some((l) => l.includes('ANTHROPIC_API_KEY=***'))).toBe(true);
      expect(logs.some((l) => l.includes('sk-abcdef'))).toBe(false);
    });
  });
});

describe('OpenCode 2', () => {
  const V2 = 'opencode-v2-test';
  let proc: ReturnType<typeof createMockProcess>;

  beforeEach(() => {
    versions[V2] = 'opencode v2.3.2';
    proc = createMockProcess();
    mockSpawn.mockReset();
    mockSpawn.mockReturnValue(proc);
  });

  async function oneTurn(
    session: InstanceType<typeof PersistentOpencodeSession>,
    p: ReturnType<typeof createMockProcess>,
    lines: string[] = [],
    code = 0,
  ) {
    const sent = session.send('hi', { waitForComplete: true });
    setTimeout(() => {
      feedLines(p, lines);
      closeProc(p, code);
    }, 10);
    return sent;
  }

  it('recognizes OpenCode 2 builds and nothing else', () => {
    expect(isOpencodeV2('opencode2 v0.0.0-beta-17823')).toBe(true);
    expect(isOpencodeV2('0.0.0-beta-19271')).toBe(true);
    expect(isOpencodeV2('2.0.0')).toBe(true);
    expect(isOpencodeV2('opencode v2.3.2')).toBe(true);
    expect(isOpencodeV2('1.19.0')).toBe(false);
    expect(isOpencodeV2('1.18.35')).toBe(false);
    expect(isOpencodeV2(undefined)).toBe(false);
    // Only the builds before the first release are prereleases.
    expect(isOpencodeV2Prerelease('opencode2 v0.0.0-beta-17823')).toBe(true);
    expect(isOpencodeV2Prerelease('0.0.0-dev-19272')).toBe(true);
    expect(isOpencodeV2Prerelease('opencode v2.3.2')).toBe(false);
    expect(isOpencodeV2Prerelease('1.19.6')).toBe(false);
  });

  // On 0.0.0-beta-17823 there was no step_finish, so no tokens and no cost.
  it('refuses the prerelease builds', async () => {
    versions['opencode-beta-test'] = 'opencode2 v0.0.0-beta-17823';
    const s = new PersistentOpencodeSession({ name: 't', cwd: '/tmp' }, 'opencode-beta-test');
    await expect(s.start()).rejects.toThrow(/prerelease builds .*not supported/);
  });

  it('starts when the version cannot be read, as OpenCode 1', async () => {
    versions['opencode-noversion-test'] = new Error('spawn ENOENT');
    const s = new PersistentOpencodeSession({ name: 't', cwd: '/tmp', effort: 'high' }, 'opencode-noversion-test');
    await expect(s.start()).resolves.toBe(s);
    await oneTurn(s, proc);
    const args = mockSpawn.mock.calls[0][1] as string[];
    expect(args).not.toContain('--standalone');
    expect(args[args.indexOf('--variant') + 1]).toBe('high');
  });

  it('runs a release on a private server, and still bills from step_finish', async () => {
    const s = new PersistentOpencodeSession({ name: 't', cwd: '/tmp' }, V2);
    await s.start();
    await oneTurn(s, proc, [
      envelope('text', { part: { id: 'p1', type: 'text', text: 'OK' } }),
      envelope('step_finish', {
        part: { type: 'step-finish', cost: 0.25, tokens: { input: 100, output: 5, cache: { read: 900, write: 0 } } },
      }),
    ]);
    const args = mockSpawn.mock.calls[0][1] as string[];
    expect(args.slice(0, 4)).toEqual(['run', '--format', 'json', '--standalone']);
    const stats = s.getStats();
    expect(stats.costUsd).toBe(0.25);
    expect(stats.tokensOut).toBe(5);
    expect(stats.cachedTokens).toBe(900);
    // Reverse: OpenCode 1 is not given a flag it does not have.
    const v1 = new PersistentOpencodeSession({ name: 't1', cwd: '/tmp' });
    await v1.start();
    const p1 = createMockProcess();
    mockSpawn.mockReturnValue(p1);
    await oneTurn(v1, p1);
    expect(mockSpawn.mock.calls[1][1] as string[]).not.toContain('--standalone');
  });

  it('sends effort as the model variant, never as --variant', async () => {
    const s = new PersistentOpencodeSession(
      { name: 't', cwd: '/tmp', model: 'opencode/flint-40b-free', effort: 'high' },
      V2,
    );
    await s.start();
    await oneTurn(s, proc);
    const args = mockSpawn.mock.calls[0][1] as string[];
    expect(args[args.indexOf('--model') + 1]).toBe('opencode/flint-40b-free#high');
    expect(args).not.toContain('--variant');
  });

  it('keeps a variant the caller already named, and sends none for auto', async () => {
    const named = new PersistentOpencodeSession(
      { name: 't', cwd: '/tmp', model: 'opencode/flint-40b-free#max', effort: 'high' },
      V2,
    );
    await named.start();
    await oneTurn(named, proc);
    let args = mockSpawn.mock.calls[0][1] as string[];
    expect(args[args.indexOf('--model') + 1]).toBe('opencode/flint-40b-free#max');

    const auto = new PersistentOpencodeSession(
      { name: 't2', cwd: '/tmp', model: 'opencode/flint-40b-free', effort: 'auto' },
      V2,
    );
    await auto.start();
    const p2 = createMockProcess();
    mockSpawn.mockReturnValue(p2);
    await oneTurn(auto, p2);
    args = mockSpawn.mock.calls[1][1] as string[];
    expect(args[args.indexOf('--model') + 1]).toBe('opencode/flint-40b-free');
  });

  it('does not send effort without a model, and says so once', async () => {
    const s = new PersistentOpencodeSession({ name: 't', cwd: '/tmp', effort: 'high' }, V2);
    await s.start();
    const logs: string[] = [];
    s.on('log', (m: string) => logs.push(m));
    await oneTurn(s, proc);
    const p2 = createMockProcess();
    mockSpawn.mockReturnValue(p2);
    await oneTurn(s, p2);
    const args = mockSpawn.mock.calls[0][1] as string[];
    expect(args).not.toContain('--model');
    expect(args).not.toContain('--variant');
    expect(logs.filter((l) => l.includes("effort 'high' not sent"))).toHaveLength(1);
  });

  it('runs a turn again on the default variant when the model has no such variant, and asks once', async () => {
    const s = new PersistentOpencodeSession(
      { name: 't', cwd: '/tmp', model: 'opencode/big-pickle', effort: 'high' },
      V2,
    );
    await s.start();
    const refused = createMockProcess();
    const rerun = createMockProcess();
    const later = createMockProcess();
    mockSpawn.mockReturnValueOnce(refused).mockReturnValueOnce(rerun).mockReturnValueOnce(later);

    const sent = s.send('hi', { waitForComplete: true });
    setTimeout(() => {
      feedLines(refused, [
        envelope('error', {
          error: { type: 'provider.no-route', message: 'Variant unavailable for opencode/big-pickle: high' },
        }),
      ]);
      closeProc(refused, 1);
      setTimeout(() => {
        feedLines(rerun, [envelope('text', { part: { id: 'p1', type: 'text', text: 'OK' } })]);
        closeProc(rerun, 0);
      }, 10);
    }, 10);
    const result = await sent;

    expect(result.text).toBe('OK');
    const first = mockSpawn.mock.calls[0][1] as string[];
    const second = mockSpawn.mock.calls[1][1] as string[];
    expect(first[first.indexOf('--model') + 1]).toBe('opencode/big-pickle#high');
    expect(second[second.indexOf('--model') + 1]).toBe('opencode/big-pickle');
    // The refused attempt was not a turn.
    expect(s.getStats().turns).toBe(1);
    expect(s.getStats().turnsSucceeded).toBe(1);

    // The next turn does not ask for the refused variant again.
    await oneTurn(s, later);
    const third = mockSpawn.mock.calls[2][1] as string[];
    expect(third[third.indexOf('--model') + 1]).toBe('opencode/big-pickle');
    expect(mockSpawn).toHaveBeenCalledTimes(3);
  });

  it('does not run a refused turn again once the session is stopped', async () => {
    const s = new PersistentOpencodeSession(
      { name: 't', cwd: '/tmp', model: 'opencode/big-pickle', effort: 'high' },
      V2,
    );
    await s.start();
    const sent = s.send('hi', { waitForComplete: true });
    void sent.catch(() => undefined);
    await new Promise((r) => setTimeout(r, 10));
    feedLines(proc, [
      envelope('error', {
        error: { type: 'provider.no-route', message: 'Variant unavailable for opencode/big-pickle: high' },
      }),
    ]);
    await new Promise((r) => setTimeout(r, 10));
    await s.stop();
    closeProc(proc, 1);
    await expect(sent).rejects.toThrow(/Variant unavailable/);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });

  it('does not run a turn again after a tool ran, whatever the error says', async () => {
    const s = new PersistentOpencodeSession(
      { name: 't', cwd: '/tmp', model: 'opencode/big-pickle', effort: 'high' },
      V2,
    );
    await s.start();
    await expect(
      oneTurn(
        s,
        proc,
        [
          envelope('tool_use', { part: { callID: 'c1', tool: 'shell', state: { status: 'completed' } } }),
          envelope('error', { error: { type: 'provider.no-route', message: 'Variant unavailable for x: high' } }),
        ],
        1,
      ),
    ).rejects.toThrow(/Variant unavailable/);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });

  it('redacts secrets in the error it reports', async () => {
    const s = new PersistentOpencodeSession({ name: 't', cwd: '/tmp' }, V2);
    await s.start();
    const logs: string[] = [];
    s.on('log', (m: string) => logs.push(m));
    const err = await oneTurn(
      s,
      proc,
      [envelope('error', { error: { type: 'unknown', message: 'upstream said ANTHROPIC_API_KEY=sk-abcdef invalid' } })],
      1,
    ).catch((e: Error) => e);
    expect(String((err as Error).message)).toContain('ANTHROPIC_API_KEY=***');
    expect(String((err as Error).message)).not.toContain('sk-abcdef');
    expect(logs.some((l) => l.includes('sk-abcdef'))).toBe(false);
  });

  it('fails a turn with the error OpenCode 2 reported, not a bare exit code', async () => {
    const s = new PersistentOpencodeSession({ name: 't', cwd: '/tmp' }, V2);
    await s.start();
    await expect(
      oneTurn(s, proc, [envelope('error', { error: { type: 'unknown', message: 'Agent not found: "x"' } })], 1),
    ).rejects.toThrow('Agent not found: "x"');
  });

  it('gives a read-only session an allowlist agent in the OpenCode 2 format', async () => {
    const s = new PersistentOpencodeSession({ name: 't', cwd: '/tmp', sandboxMode: 'read-only' }, V2);
    await s.start();
    await oneTurn(s, proc);
    const args = mockSpawn.mock.calls[0][1] as string[];
    expect(args[args.indexOf('--agent') + 1]).toBe('clawo-readonly');
    const env = (mockSpawn.mock.calls[0][2] as { env: Record<string, string> }).env;
    const cfg = JSON.parse(env.OPENCODE_CONFIG_CONTENT) as {
      agent?: unknown;
      agents: Record<string, { permissions: Array<{ action: string; resource: string; effect: string }> }>;
    };
    // V2 reads `agents`; a V1-shaped entry is not mixed in.
    expect(cfg.agent).toBeUndefined();
    const rules = cfg.agents['clawo-readonly'].permissions;
    // Everything is denied first, so `shell`, `edit`, `subagent` and any action a
    // plugin adds are covered without being named.
    expect(rules[0]).toEqual({ action: '*', resource: '*', effect: 'deny' });
    const allowed = rules.filter((r) => r.effect === 'allow').map((r) => r.action);
    expect(new Set(allowed)).toEqual(new Set(['read', 'glob', 'grep']));
    // Reverse: OpenCode 1 still gets the V1 definition.
    const v1 = new PersistentOpencodeSession({ name: 't1', cwd: '/tmp', sandboxMode: 'read-only' });
    await v1.start();
    const p1 = createMockProcess();
    mockSpawn.mockReturnValue(p1);
    await oneTurn(v1, p1);
    const v1cfg = JSON.parse(
      (mockSpawn.mock.calls[1][2] as { env: Record<string, string> }).env.OPENCODE_CONFIG_CONTENT,
    );
    expect(v1cfg.agent['clawo-readonly'].permission.bash).toBe('deny');
  });
});
