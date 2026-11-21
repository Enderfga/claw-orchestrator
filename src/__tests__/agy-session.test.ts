/**
 * Unit tests for PersistentAgySession
 *
 * Tests flag construction, stream-json/plain-text collection, conversation-ID
 * capture, timeout coherence, and stats tracking. Uses vitest mocks for
 * child_process.spawn to avoid spawning real processes.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Mock child_process before importing the session
const mockSpawn = vi.fn();
vi.mock('../engine-spawn.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../engine-spawn.js')>()),
  spawnEngine: (...args: unknown[]) => mockSpawn(...args),
}));

// Import after mocking
const { PersistentAgySession } = await import('../persistent-agy-session.js');

// ─── Mock Process Helper ────────────────────────────────────────────────────

function createMockProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: Readable & { destroy: ReturnType<typeof vi.fn> };
    stderr: EventEmitter & { destroy: ReturnType<typeof vi.fn> };
    stdin: { end: ReturnType<typeof vi.fn> };
    kill: ReturnType<typeof vi.fn>;
    pid: number;
    exitCode: null;
  };
  proc.stdout = new Readable({ read() {} });
  (proc.stdout as Readable & { destroy: ReturnType<typeof vi.fn> }).destroy = vi.fn();
  const stderrEmitter = new EventEmitter() as EventEmitter & { destroy: ReturnType<typeof vi.fn> };
  stderrEmitter.destroy = vi.fn();
  proc.stderr = stderrEmitter;
  proc.stdin = { end: vi.fn() };
  proc.kill = vi.fn();
  proc.pid = 12345;
  proc.exitCode = null;
  return proc;
}

function feedText(proc: ReturnType<typeof createMockProcess>, text: string) {
  proc.stdout.push(text);
}

function closeProc(proc: ReturnType<typeof createMockProcess>, code: number) {
  proc.stdout.push(null); // end stream
  proc.emit('close', code);
}

function succeedProc(proc: ReturnType<typeof createMockProcess>, text = 'OK') {
  feedText(proc, `${text}\n`);
  closeProc(proc, 0);
}

/** Read the private agy log path from the actual spawn args. */
function logPathFromSpawn(callIndex = mockSpawn.mock.calls.length - 1): string {
  const args = mockSpawn.mock.calls[callIndex][1] as string[];
  const idx = args.indexOf('--log-file');
  expect(idx).toBeGreaterThan(-1);
  return args[idx + 1];
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('PersistentAgySession', () => {
  let mockProc: ReturnType<typeof createMockProcess>;
  const tmpLogs: string[] = [];

  beforeEach(() => {
    mockProc = createMockProcess();
    mockSpawn.mockReset();
    mockSpawn.mockReturnValue(mockProc);
  });

  afterEach(() => {
    for (const f of tmpLogs.splice(0)) {
      try {
        fs.unlinkSync(f);
      } catch {
        /* already gone */
      }
    }
  });

  // ─── start() ────────────────────────────────────────────────────────────

  describe('start()', () => {
    it('initializes session and emits ready', async () => {
      const session = new PersistentAgySession({ name: 'test', cwd: '/tmp', permissionMode: 'default' });
      const readyFn = vi.fn();
      session.on('ready', readyFn);

      await session.start();

      expect(session.isReady).toBe(true);
      expect(session.sessionId).toMatch(/^agy-/);
      expect(readyFn).toHaveBeenCalled();
    });
  });

  // ─── spawn flags ────────────────────────────────────────────────────────

  describe('spawn flags', () => {
    it('uses --dangerously-skip-permissions for bypassPermissions', async () => {
      const session = new PersistentAgySession({
        name: 'test',
        cwd: '/tmp',
        permissionMode: 'bypassPermissions',
        model: 'gemini-3.5-flash',
      });
      await session.start();

      const sendPromise = session.send('hello', { waitForComplete: true });
      setTimeout(() => succeedProc(mockProc), 10);
      await sendPromise;

      const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
      expect(spawnArgs).toContain('-p');
      expect(spawnArgs).toContain('hello');
      expect(spawnArgs).toContain('--dangerously-skip-permissions');
      expect(spawnArgs).toContain('--model');
      expect(spawnArgs).toContain('gemini-3.5-flash');
      expect(spawnArgs).toContain('--log-file');
      expect(spawnArgs).not.toContain('--settings');
    });

    it('passes settings through as --settings', async () => {
      const settings = '{"autoUpdates":false}';
      const session = new PersistentAgySession({ name: 'test', cwd: '/tmp', settings } as never);
      await session.start();
      const sendPromise = session.send('hello', { waitForComplete: true });
      setTimeout(() => succeedProc(mockProc), 10);
      await sendPromise;
      const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
      expect(spawnArgs[spawnArgs.indexOf('--settings') + 1]).toBe(settings);
    });

    it('uses plan mode for read-only sessions', async () => {
      const session = new PersistentAgySession({
        name: 'test',
        cwd: '/tmp',
        permissionMode: 'manual',
        sandboxMode: 'read-only',
      });
      await session.start();

      const sendPromise = session.send('hello', { waitForComplete: true });
      setTimeout(() => succeedProc(mockProc), 10);
      await sendPromise;

      const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
      expect(spawnArgs).toContain('--mode');
      expect(spawnArgs).toContain('plan');
      expect(spawnArgs).not.toContain('--dangerously-skip-permissions');
    });

    async function argsFor(config: Record<string, unknown>): Promise<string[]> {
      const session = new PersistentAgySession({ name: 'test', cwd: '/tmp', ...config } as never);
      await session.start();
      const sendPromise = session.send('hello', { waitForComplete: true });
      setTimeout(() => succeedProc(mockProc), 10);
      await sendPromise;
      return mockSpawn.mock.calls.at(-1)![1] as string[];
    }
    const settingsOf = (args: string[]) =>
      args.includes('--settings') ? JSON.parse(args[args.indexOf('--settings') + 1]) : undefined;

    // agy 1.5.7 made Auto the default mode of a headless run, where its reviewer
    // lets commands run that the session was not given. Every mode is named, and
    // the ones that ask for permission pin agy's Default mode (agentMode "").
    it.each(['default', 'manual', 'dontAsk'])('runs %s in the sandbox, in agy Default mode', async (permissionMode) => {
      const args = await argsFor({ permissionMode });
      expect(args).toContain('--sandbox');
      expect(args).not.toContain('--mode');
      expect(args).not.toContain('--dangerously-skip-permissions');
      expect(settingsOf(args)).toEqual({ agentMode: '' });
    });

    it.each([
      ['acceptEdits', 'accept-edits'],
      ['auto', 'auto'],
      ['plan', 'plan'],
    ])('passes %s as --mode %s', async (permissionMode, agyMode) => {
      const args = await argsFor({ permissionMode });
      expect(args[args.indexOf('--mode') + 1]).toBe(agyMode);
      expect(args).not.toContain('--sandbox');
      expect(args).not.toContain('--settings');
    });

    // agy reads only the last --settings, so the mode goes into the caller's.
    it("merges Default mode into the caller's inline settings", async () => {
      const args = await argsFor({ permissionMode: 'default', settings: '{"model":"m","agentMode":"auto"}' });
      expect(settingsOf(args)).toEqual({ model: 'm', agentMode: '' });
    });

    it("merges Default mode into the caller's settings file", async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-settings-'));
      try {
        const file = path.join(dir, 'settings.json');
        fs.writeFileSync(file, '{"trustedWorkspaces":["/w"]}');
        const args = await argsFor({ permissionMode: 'manual', settings: file });
        expect(args.filter((a) => a === '--settings')).toHaveLength(1);
        expect(settingsOf(args)).toEqual({ trustedWorkspaces: ['/w'], agentMode: '' });
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('fails the turn rather than run without Default mode when settings are not a JSON object', async () => {
      const session = new PersistentAgySession({
        name: 'test',
        cwd: '/tmp',
        permissionMode: 'default',
        settings: '/no/such/settings.json',
      } as never);
      await session.start();
      await expect(session.send('hello', { waitForComplete: true })).rejects.toThrow(/must be a JSON object/);
    });

    it('derives --print-timeout from the send timeout', async () => {
      const session = new PersistentAgySession({
        name: 'test',
        cwd: '/tmp',
        permissionMode: 'bypassPermissions',
      });
      await session.start();

      const sendPromise = session.send('hello', { waitForComplete: true, timeout: 60_000 });
      setTimeout(() => succeedProc(mockProc), 10);
      await sendPromise;

      const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
      const idx = spawnArgs.indexOf('--print-timeout');
      expect(idx).toBeGreaterThan(-1);
      // agy's deadline comes first (60s less 10%), so a turn waiting on a
      // background task is ended by agy with its reply, not killed by our timer
      expect(spawnArgs[idx + 1]).toBe('54s');
    });

    it('caps the deadline margin at 10 seconds', async () => {
      const session = new PersistentAgySession({ name: 'test', cwd: '/tmp', permissionMode: 'bypassPermissions' });
      await session.start();

      const sendPromise = session.send('hello', { waitForComplete: true, timeout: 300_000 });
      setTimeout(() => succeedProc(mockProc), 10);
      await sendPromise;

      const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
      expect(spawnArgs[spawnArgs.indexOf('--print-timeout') + 1]).toBe('290s');
    });

    it('resolves agy model aliases before passing --model', async () => {
      const session = new PersistentAgySession({
        name: 'test',
        cwd: '/tmp',
        permissionMode: 'bypassPermissions',
        model: 'agy-pro',
      });
      await session.start();

      const sendPromise = session.send('hello', { waitForComplete: true });
      setTimeout(() => succeedProc(mockProc), 10);
      await sendPromise;

      const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
      const idx = spawnArgs.indexOf('--model');
      expect(idx).toBeGreaterThan(-1);
      expect(spawnArgs[idx + 1]).toBe('gemini-4-argon');
    });

    it('passes the session reasoning effort to agy', async () => {
      const session = new PersistentAgySession({
        name: 'test',
        cwd: '/tmp',
        permissionMode: 'bypassPermissions',
        model: 'gemini-3.5-flash',
        effort: 'high',
      });
      await session.start();

      const sendPromise = session.send('hello', { waitForComplete: true });
      setTimeout(() => succeedProc(mockProc), 10);
      await sendPromise;

      const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
      const idx = spawnArgs.indexOf('--effort');
      expect(idx).toBeGreaterThan(-1);
      expect(spawnArgs[idx + 1]).toBe('high');
    });

    it('lets a per-turn reasoning effort override the session default', async () => {
      const session = new PersistentAgySession({
        name: 'test',
        cwd: '/tmp',
        permissionMode: 'bypassPermissions',
        effort: 'high',
      });
      await session.start();

      const sendPromise = session.send('hello', { waitForComplete: true, effort: 'medium' });
      setTimeout(() => succeedProc(mockProc), 10);
      await sendPromise;

      const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
      const idx = spawnArgs.indexOf('--effort');
      expect(spawnArgs[idx + 1]).toBe('medium');
      expect(spawnArgs.filter((arg) => arg === '--effort')).toHaveLength(1);
    });

    it.each(['max', 'xhigh'] as const)('maps engine-wide %s effort to agy high', async (effort) => {
      const session = new PersistentAgySession({
        name: 'test',
        cwd: '/tmp',
        permissionMode: 'bypassPermissions',
        effort,
      });
      await session.start();

      const sendPromise = session.send('hello', { waitForComplete: true });
      setTimeout(() => succeedProc(mockProc), 10);
      await sendPromise;

      const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
      const idx = spawnArgs.indexOf('--effort');
      expect(spawnArgs[idx + 1]).toBe('high');
    });

    // gemini-4-hydrogen (agy 1.5.9) and gemini-4-neon (agy 1.5.12) have a tier above high.
    it.each([
      ['gemini-4-hydrogen', 'xhigh', 'xhigh'],
      ['gemini-4-hydrogen', 'max', 'xhigh'],
      ['gemini-4-neon', 'xhigh', 'xhigh'],
      ['gemini-4-neon', 'max', 'xhigh'],
      ['gemini-4-argon', 'xhigh', 'high'],
    ] as const)('gives %s %s effort as agy %s', async (model, effort, expected) => {
      const session = new PersistentAgySession({
        name: 'test',
        cwd: '/tmp',
        permissionMode: 'bypassPermissions',
        model,
        effort,
      });
      await session.start();
      const sendPromise = session.send('hello', { waitForComplete: true });
      setTimeout(() => succeedProc(mockProc), 10);
      await sendPromise;
      const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
      expect(spawnArgs[spawnArgs.indexOf('--effort') + 1]).toBe(expected);
    });

    it('keeps an xhigh-qualified slug as given', async () => {
      const session = new PersistentAgySession({
        name: 'test',
        cwd: '/tmp',
        permissionMode: 'bypassPermissions',
        model: 'gemini-4-hydrogen-xhigh',
      });
      await session.start();
      const sendPromise = session.send('hello', { waitForComplete: true });
      setTimeout(() => succeedProc(mockProc), 10);
      await sendPromise;
      const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
      expect(spawnArgs[spawnArgs.indexOf('--model') + 1]).toBe('gemini-4-hydrogen-xhigh');
      expect(spawnArgs).not.toContain('--effort');
    });

    it('uses agy high for an unsuffixed model when effort is auto', async () => {
      const session = new PersistentAgySession({
        name: 'test',
        cwd: '/tmp',
        permissionMode: 'bypassPermissions',
        model: 'gemini-3.5-flash',
        effort: 'auto',
      });
      await session.start();

      const sendPromise = session.send('hello', { waitForComplete: true });
      setTimeout(() => succeedProc(mockProc), 10);
      await sendPromise;

      const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
      const idx = spawnArgs.indexOf('--effort');
      expect(spawnArgs[idx + 1]).toBe('high');
    });

    it('omits --effort for auto when no model is selected', async () => {
      const session = new PersistentAgySession({
        name: 'test',
        cwd: '/tmp',
        permissionMode: 'bypassPermissions',
        effort: 'auto',
      });
      await session.start();

      const sendPromise = session.send('hello', { waitForComplete: true });
      setTimeout(() => succeedProc(mockProc), 10);
      await sendPromise;

      const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
      expect(spawnArgs).not.toContain('--effort');
    });

    it('does not duplicate effort for an effort-qualified model slug', async () => {
      const session = new PersistentAgySession({
        name: 'test',
        cwd: '/tmp',
        permissionMode: 'bypassPermissions',
        model: 'gemini-3.7-flash-high',
        effort: 'auto',
      });
      await session.start();

      const sendPromise = session.send('hello', { waitForComplete: true });
      setTimeout(() => succeedProc(mockProc), 10);
      await sendPromise;

      const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
      expect(spawnArgs).toContain('gemini-3.7-flash-high');
      expect(spawnArgs).not.toContain('--effort');
    });

    it('strips a conflicting model effort suffix for a per-turn override', async () => {
      const session = new PersistentAgySession({
        name: 'test',
        cwd: '/tmp',
        permissionMode: 'bypassPermissions',
        model: 'gemini-3.7-flash-low',
        effort: 'auto',
      });
      await session.start();

      const sendPromise = session.send('hello', { waitForComplete: true, effort: 'high' });
      setTimeout(() => succeedProc(mockProc), 10);
      await sendPromise;

      const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
      const modelIdx = spawnArgs.indexOf('--model');
      const effortIdx = spawnArgs.indexOf('--effort');
      expect(spawnArgs[modelIdx + 1]).toBe('gemini-3.7-flash');
      expect(spawnArgs[effortIdx + 1]).toBe('high');
    });
  });

  // ─── headless session flags ─────────────────────────────────────────────

  // agy is one process per turn, so every per-session flag is passed on every
  // turn, the resumed ones included.
  describe('session flags on every turn', () => {
    const SCHEMA = '{"type":"object","properties":{"files":{"type":"array","items":{"type":"string"}}}}';
    const CONV = 'a35ec168-0a1c-4dff-81a0-eed636ca97d9';

    async function twoTurns(config: Record<string, unknown>): Promise<string[][]> {
      const session = new PersistentAgySession({
        name: 'test',
        cwd: '/tmp',
        permissionMode: 'bypassPermissions',
        ...config,
      } as never);
      await session.start();
      const first = session.send('first', { waitForComplete: true });
      setTimeout(() => {
        feedText(mockProc, JSON.stringify({ event: 'init', conversation_id: CONV }) + '\n');
        succeedProc(mockProc);
      }, 10);
      await first;
      const proc2 = createMockProcess();
      mockSpawn.mockReturnValue(proc2);
      const second = session.send('second', { waitForComplete: true });
      setTimeout(() => succeedProc(proc2), 10);
      await second;
      const calls = mockSpawn.mock.calls.map((c) => c[1] as string[]);
      expect(calls[1][calls[1].indexOf('--conversation') + 1]).toBe(CONV);
      return calls;
    }
    const valuesOf = (args: string[], flag: string) => args.flatMap((a, i) => (a === flag ? [args[i + 1]] : []));

    it('passes an inline jsonSchema as --json-schema', async () => {
      for (const args of await twoTurns({ jsonSchema: SCHEMA })) {
        expect(valuesOf(args, '--json-schema')).toEqual([SCHEMA]);
      }
    });

    it('passes a jsonSchema file as its absolute path, resolved against the session directory', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-schema-'));
      try {
        fs.writeFileSync(path.join(dir, 'schema.json'), SCHEMA);
        for (const args of await twoTurns({ cwd: dir, jsonSchema: 'schema.json' })) {
          expect(valuesOf(args, '--json-schema')).toEqual([path.join(dir, 'schema.json')]);
        }
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    // agy exits 1 at startup on each of these; refusing at start() names the
    // problem once instead of failing every turn.
    it.each([
      ['plain text', 'string'],
      ['a non-object root type', '{"type":"string"}'],
      ['a root without a type', '{"properties":{"n":{"type":"integer"}}}'],
      ['an array', '[{"type":"object"}]'],
      ['invalid JSON', '{"type":'],
      ['a missing file', '/no/such/schema.json'],
    ])('refuses a jsonSchema that is %s at start', async (_kind, jsonSchema) => {
      const session = new PersistentAgySession({ name: 'test', cwd: '/tmp', jsonSchema } as never);
      await expect(session.start()).rejects.toThrow(/jsonSchema/);
      expect(session.isReady).toBe(false);
      expect(mockSpawn).not.toHaveBeenCalled();
    });

    it('does not quote a schema file it cannot parse', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-schema-'));
      try {
        const file = path.join(dir, 'secret.json');
        fs.writeFileSync(file, 'TOP-SECRET-CONTENT');
        const session = new PersistentAgySession({ name: 'test', cwd: dir, jsonSchema: file } as never);
        const err = await session.start().catch((e: Error) => e);
        expect((err as Error).message).not.toContain('TOP-SECRET');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('passes each addDir entry as its own --add-dir', async () => {
      for (const args of await twoTurns({ addDir: ['/srv/a', '/srv/b'] })) {
        expect(valuesOf(args, '--add-dir')).toEqual(['/srv/a', '/srv/b']);
      }
    });

    it('passes agent as --agent', async () => {
      for (const args of await twoTurns({ agent: 'reviewer' })) {
        expect(valuesOf(args, '--agent')).toEqual(['reviewer']);
      }
    });

    it('passes disableSlashCommands as --disable-slash-commands', async () => {
      for (const args of await twoTurns({ disableSlashCommands: true })) {
        expect(args).toContain('--disable-slash-commands');
      }
    });

    it('passes none of them by default', async () => {
      for (const args of await twoTurns({})) {
        for (const flag of ['--json-schema', '--add-dir', '--agent', '--disable-slash-commands']) {
          expect(args).not.toContain(flag);
        }
      }
    });

    // Measured on agy 1.5.13: with an unknown --agent, `-p` exits 1 before any
    // model turn and reports it as a result error.
    it('surfaces an unknown agent', async () => {
      const session = new PersistentAgySession({ name: 'test', cwd: '/tmp', agent: 'zz-none' } as never);
      await session.start();
      const sendPromise = session.send('hi', { waitForComplete: true });
      feedText(
        mockProc,
        JSON.stringify({
          event: 'result',
          result: {
            conversation_id: '',
            status: 'ERROR',
            response: '',
            error: 'unknown agent "zz-none" (no custom agents are available)',
            num_turns: 0,
            finished_reason: 'error',
          },
        }) + '\n',
      );
      mockProc.stderr.emit('data', Buffer.from('error: unknown agent "zz-none" (no custom agents are available)\n'));
      setTimeout(() => closeProc(mockProc, 1), 10);
      await expect(sendPromise).rejects.toThrow('unknown agent "zz-none" (no custom agents are available)');
    });
  });

  // ─── the -p value ───────────────────────────────────────────────────────

  // Measured on agy 1.5.13: a `-p` value that is exactly one of agy's flags is
  // read as that flag. `--version`/`-version` print the version and `--help`/
  // `-help`/`-h` the help, both exit 0 with no turn; `-v`, `-c`, `--continue`
  // exit 2. A dash followed by more text (`- item one`, `--help me`) and an
  // unknown single token (`-x`, `-`) reach the model as written.
  describe('the message as the -p value', () => {
    async function promptFor(message: string): Promise<string> {
      const session = new PersistentAgySession({ name: 'test', cwd: '/tmp', permissionMode: 'bypassPermissions' });
      await session.start();
      const sendPromise = session.send(message, { waitForComplete: true });
      setTimeout(() => succeedProc(mockProc), 10);
      await sendPromise;
      const args = mockSpawn.mock.calls.at(-1)![1] as string[];
      return args[args.indexOf('-p') + 1];
    }

    it.each(['--version', '-version', '--help', '-h', '-v', '-c', '--continue', '-x', '-'])(
      'keeps the single token %s from being read as a flag',
      async (message) => {
        const prompt = await promptFor(message);
        expect(prompt).not.toBe(message);
        expect(prompt.trim()).toBe(message);
      },
    );

    it.each(['- item one', '--help me', 'hello', '/Users/someone/notes.txt what is this', '/clear'])(
      'passes %s unchanged',
      async (message) => {
        expect(await promptFor(message)).toBe(message);
      },
    );
  });

  // ─── structured output ──────────────────────────────────────────────────

  describe('structured output (--json-schema)', () => {
    const resultLine = (result: Record<string, unknown>) =>
      JSON.stringify({
        event: 'result',
        result: { conversation_id: 'a35ec168-0a1c-4dff-81a0-eed636ca97d9', status: 'SUCCESS', ...result },
      }) + '\n';

    // agy 1.5.13 puts the JSON text in `response` and the parsed value in
    // `structured_output` (shape measured on a real turn).
    it('returns the response and exposes structured_output on the result event', async () => {
      const session = new PersistentAgySession({ name: 'test', cwd: '/tmp', jsonSchema: '{"type":"object"}' } as never);
      await session.start();
      const sendPromise = session.send('list', { waitForComplete: true });
      feedText(mockProc, resultLine({ response: '{"files":["b.txt"]}\n', structured_output: { files: ['b.txt'] } }));
      setTimeout(() => closeProc(mockProc, 0), 10);
      const result = await sendPromise;
      if (!('text' in result)) throw new Error('expected a completed turn');
      expect(result.text).toBe('{"files":["b.txt"]}');
      expect(result.event.structured_output).toEqual({ files: ['b.txt'] });
      expect(session.getStats().turnsSucceeded).toBe(1);
    });

    it('returns the structured output as the text when the response is empty', async () => {
      const session = new PersistentAgySession({ name: 'test', cwd: '/tmp', jsonSchema: '{"type":"object"}' } as never);
      await session.start();
      const chunks: string[] = [];
      const sendPromise = session.send('list', {
        waitForComplete: true,
        callbacks: { onText: (t: string) => chunks.push(t) },
      });
      feedText(mockProc, resultLine({ response: '', structured_output: { files: [] } }));
      setTimeout(() => closeProc(mockProc, 0), 10);
      const result = await sendPromise;
      if (!('text' in result)) throw new Error('expected a completed turn');
      expect(JSON.parse(result.text)).toEqual({ files: [] });
      expect(chunks.join('')).toBe(result.text);
      expect(result.event.stop_reason).toBe('end_turn');
      expect(session.getStats().turnsSucceeded).toBe(1);
    });
  });

  // ─── tool calls ─────────────────────────────────────────────────────────

  describe('tool calls', () => {
    const CONV = 'a35ec168-0a1c-4dff-81a0-eed636ca97d9';
    const stepLine = (step: Record<string, unknown>) =>
      JSON.stringify({ event: 'step_update', step_update: { conversation_id: CONV, ...step } }) + '\n';

    // Shapes from a real agy 1.5.13 turn: a tool step is reported ACTIVE, then
    // DONE with the same step_index and its output.
    it('counts each tool step once, whether reported once or twice', async () => {
      const session = new PersistentAgySession({ name: 'test', cwd: '/tmp', permissionMode: 'bypassPermissions' });
      await session.start();
      const sendPromise = session.send('list the files', { waitForComplete: true });
      setTimeout(() => {
        feedText(mockProc, JSON.stringify({ event: 'init', conversation_id: CONV }) + '\n');
        feedText(mockProc, stepLine({ step_index: 0, state: 'DONE', step_type: 'user_input' }));
        feedText(
          mockProc,
          stepLine({
            step_index: 1,
            state: 'DONE',
            step_type: 'agent_response',
            usage: { input_tokens: 21511, output_tokens: 46 },
          }),
        );
        const tool = { name: 'run_command', parameters: { CommandLine: 'ls -A' } };
        feedText(
          mockProc,
          stepLine({ step_index: 2, state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command', tool_info: tool }),
        );
        feedText(
          mockProc,
          stepLine({
            step_index: 2,
            state: 'DONE',
            step_type: 'tool',
            tool_name: 'run_command',
            tool_info: { ...tool, output: 'Command exited with code 0.\n\nCommand output:\nb.txt\r\n' },
          }),
        );
        feedText(
          mockProc,
          stepLine({ step_index: 3, state: 'DONE', step_type: 'tool', tool_name: 'view_file', tool_info: tool }),
        );
        // A subagent delegation, and a tool step inside the subagent's own conversation.
        feedText(
          mockProc,
          stepLine({
            step_index: 4,
            state: 'ACTIVE',
            step_type: 'tool',
            subagent_info: { conversation_id: '99999999-8888-7777-6666-555555555555', log_uri: 'file:///x' },
          }),
        );
        feedText(
          mockProc,
          JSON.stringify({
            event: 'step_update',
            step_update: {
              conversation_id: '99999999-8888-7777-6666-555555555555',
              step_index: 2,
              state: 'DONE',
              step_type: 'tool',
              tool_info: tool,
            },
          }) + '\n',
        );
        feedText(mockProc, stepLine({ step_index: 5, state: 'DONE', step_type: 'finish' }));
        feedText(
          mockProc,
          JSON.stringify({ event: 'result', result: { conversation_id: CONV, status: 'SUCCESS', response: 'b.txt' } }) +
            '\n',
        );
        closeProc(mockProc, 0);
      }, 10);
      await sendPromise;
      expect(session.getStats().toolCalls).toBe(4);
    });

    it('adds up across turns', async () => {
      const session = new PersistentAgySession({ name: 'test', cwd: '/tmp', permissionMode: 'bypassPermissions' });
      await session.start();
      for (let turn = 0; turn < 2; turn++) {
        const proc = createMockProcess();
        mockSpawn.mockReturnValue(proc);
        const sendPromise = session.send('again', { waitForComplete: true });
        setTimeout(() => {
          // The same step_index in a later turn is a different step.
          feedText(proc, stepLine({ step_index: 2, state: 'DONE', step_type: 'tool', tool_info: { name: 'x' } }));
          succeedProc(proc);
        }, 10);
        await sendPromise;
      }
      expect(session.getStats().toolCalls).toBe(2);
    });
  });

  // ─── structured turn errors ─────────────────────────────────────────────

  describe('turn errors', () => {
    const ERROR_RESULT = JSON.stringify({
      event: 'result',
      result: {
        conversation_id: '',
        status: 'ERROR',
        response: '',
        error:
          'invalid model selection (--model "gemini-3.1-pro" --effort "medium"): gemini-3.1-pro has no "medium" effort (available: low, high)',
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });

    it("surfaces agy's own message instead of the bare exit code", async () => {
      const session = new PersistentAgySession({
        name: 'test',
        cwd: '/tmp',
        permissionMode: 'bypassPermissions',
      });
      await session.start();

      const sendPromise = session.send('hello', { waitForComplete: true });
      feedText(mockProc, ERROR_RESULT + '\n');
      setTimeout(() => closeProc(mockProc, 1), 10);

      // agy prints the rejection on stdout as a stream-json result event and
      // writes nothing to stderr, so without capturing `error` the caller only
      // ever saw "Antigravity exited with code 1".
      await expect(sendPromise).rejects.toThrow(/no "medium" effort \(available: low, high\)/);
    });

    it('rejects a result error even when the process exits 0', async () => {
      const session = new PersistentAgySession({
        name: 'test',
        cwd: '/tmp',
        permissionMode: 'bypassPermissions',
      });
      await session.start();

      const sendPromise = session.send('hello', { waitForComplete: true });
      feedText(mockProc, ERROR_RESULT + '\n');
      setTimeout(() => closeProc(mockProc, 0), 10);

      await expect(sendPromise).rejects.toThrow(/invalid model selection/);
    });

    it.each([
      ['missing', undefined],
      [
        'blank',
        JSON.stringify({
          event: 'result',
          result: {
            conversation_id: '11111111-2222-3333-4444-555555555555',
            status: 'SUCCESS',
            response: ' \n\t ',
          },
        }) + '\n',
      ],
    ])('rejects an exit-0 %s response as a failed, recoverable turn', async (_kind, stdout) => {
      const session = new PersistentAgySession({
        name: 'test',
        cwd: '/tmp',
        permissionMode: 'bypassPermissions',
      });
      await session.start();

      const completed: Array<{ stop_reason?: string }> = [];
      session.on('turn_complete', (event: { stop_reason?: string }) => completed.push(event));

      const sendPromise = session.send('hello', { waitForComplete: true });
      if (stdout) feedText(mockProc, stdout);
      setTimeout(() => closeProc(mockProc, 0), 10);

      await expect(sendPromise).rejects.toThrow(
        'Antigravity returned an empty response; the turn failed but the session remains available for retry',
      );
      expect(completed).toEqual([expect.objectContaining({ stop_reason: 'error' })]);
      expect(session.getStats()).toMatchObject({ turns: 1, turnsSucceeded: 0 });
    });

    it('surfaces a fixed denial diagnosis and preserves conversation continuity for a retry', async () => {
      const session = new PersistentAgySession({
        name: 'test',
        cwd: '/tmp',
        permissionMode: 'manual',
        sandboxMode: 'read-only',
      });
      await session.start();

      const firstSend = session.send('first turn', { waitForComplete: true });
      const logFile = logPathFromSpawn();
      tmpLogs.push(logFile);
      fs.writeFileSync(
        logFile,
        'E0904 tool_confirmation_manager.go:188] mode: soft-denying tool confirmation "RunCommand"\n',
      );
      feedText(
        mockProc,
        JSON.stringify({ event: 'init', conversation_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }) + '\n',
      );
      setTimeout(() => closeProc(mockProc, 0), 10);

      const firstError = await firstSend.catch((error: Error) => error);
      expect(firstError).toBeInstanceOf(Error);
      expect((firstError as Error).message).toBe(
        'Antigravity returned an empty response after denying tool confirmation for "RunCommand"; the turn failed but the session remains available for retry',
      );
      expect(session.conversationId).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');

      const secondProc = createMockProcess();
      mockSpawn.mockReturnValue(secondProc);
      const secondSend = session.send('retry turn', { waitForComplete: true });
      const secondArgs = mockSpawn.mock.calls[1][1] as string[];
      expect(secondArgs.slice(secondArgs.indexOf('--conversation'), secondArgs.indexOf('--conversation') + 2)).toEqual([
        '--conversation',
        'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      ]);
      feedText(
        secondProc,
        JSON.stringify({
          event: 'result',
          result: {
            conversation_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
            status: 'SUCCESS',
            response: 'Recovered',
          },
        }) + '\n',
      );
      setTimeout(() => closeProc(secondProc, 0), 10);

      await expect(secondSend).resolves.toMatchObject({ text: 'Recovered' });
      expect(session.getStats()).toMatchObject({ turns: 2, turnsSucceeded: 1 });
    });

    it('uses the generic denial diagnosis when the denied tool name is not an identifier', async () => {
      const session = new PersistentAgySession({
        name: 'test',
        cwd: '/tmp',
        permissionMode: 'manual',
        sandboxMode: 'read-only',
      });
      await session.start();

      const sendPromise = session.send('first turn', { waitForComplete: true });
      const logFile = logPathFromSpawn();
      tmpLogs.push(logFile);
      const invalidToolName = 'not a tool';
      fs.writeFileSync(
        logFile,
        `E0904 tool_confirmation_manager.go:188] mode: soft-denying tool confirmation "${invalidToolName}"\n`,
      );
      feedText(
        mockProc,
        JSON.stringify({ event: 'init', conversation_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }) + '\n',
      );
      setTimeout(() => closeProc(mockProc, 0), 10);

      const error = await sendPromise.catch((err: Error) => err);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(
        'Antigravity returned an empty response after a tool permission denial; the turn failed but the session remains available for retry',
      );
      expect((error as Error).message).not.toContain(invalidToolName);
    });

    it('emits an agy 1.2.2 soft-denied tool on a successful turn with a non-empty reply', async () => {
      const session = new PersistentAgySession({
        name: 'test',
        cwd: '/tmp',
        permissionMode: 'manual',
        sandboxMode: 'read-only',
      });
      await session.start();

      const sendPromise = session.send('run the command', { waitForComplete: true });
      const logFile = logPathFromSpawn();
      tmpLogs.push(logFile);
      fs.writeFileSync(
        logFile,
        'E0912 tool_confirmation_manager.go:188] mode: soft-denying tool confirmation "RunCommand"\n',
      );
      feedText(
        mockProc,
        JSON.stringify({
          event: 'result',
          result: {
            conversation_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
            status: 'SUCCESS',
            response: 'I could not run that command.',
          },
        }) + '\n',
      );
      setTimeout(() => closeProc(mockProc, 0), 10);

      const result = await sendPromise;
      if (!('text' in result)) throw new Error('expected a completed turn');
      expect(result.text).toBe('I could not run that command.');
      expect(result.event.stop_reason).toBe('end_turn');
      expect(result.event.permission_denials).toEqual([{ tool_name: 'RunCommand' }]);
      expect(session.getStats()).toMatchObject({ turns: 1, turnsSucceeded: 1 });
    });

    it('does not classify a stale prior-turn denial log as the current empty response', async () => {
      const session = new PersistentAgySession({
        name: 'test',
        cwd: '/tmp',
        permissionMode: 'manual',
        sandboxMode: 'read-only',
      });
      await session.start();

      const firstSend = session.send('first turn', { waitForComplete: true });
      const logFile = logPathFromSpawn();
      tmpLogs.push(logFile);
      fs.writeFileSync(
        logFile,
        'E0904 tool_confirmation_manager.go:188] mode: soft-denying tool confirmation "RunCommand"\n',
      );
      setTimeout(() => succeedProc(mockProc), 10);
      await firstSend;

      const secondProc = createMockProcess();
      mockSpawn.mockReturnValue(secondProc);
      const secondSend = session.send('second turn', { waitForComplete: true });
      setTimeout(() => closeProc(secondProc, 0), 10);

      await expect(secondSend).rejects.toThrow(
        'Antigravity returned an empty response; the turn failed but the session remains available for retry',
      );
    });

    it('still resolves a successful turn', async () => {
      const session = new PersistentAgySession({
        name: 'test',
        cwd: '/tmp',
        permissionMode: 'bypassPermissions',
      });
      await session.start();

      const sendPromise = session.send('hello', { waitForComplete: true });
      feedText(
        mockProc,
        JSON.stringify({ event: 'result', result: { conversation_id: 'c1', status: 'SUCCESS', response: 'OK' } }) +
          '\n',
      );
      setTimeout(() => closeProc(mockProc, 0), 10);

      const result = (await sendPromise) as { text: string };
      expect(result.text).toBe('OK');
    });
  });

  // ─── conversation continuity ────────────────────────────────────────────

  describe('conversation continuity', () => {
    it('harvests conversation ID from the log and passes --conversation on the next send', async () => {
      const session = new PersistentAgySession({
        name: 'test',
        cwd: '/tmp',
        permissionMode: 'bypassPermissions',
      });
      await session.start();

      // Turn 1: agy writes its log; the engine harvests the new conversation ID
      const send1 = session.send('first turn', { waitForComplete: true });
      const logFile = logPathFromSpawn();
      tmpLogs.push(logFile);
      setTimeout(() => {
        fs.writeFileSync(logFile, 'I0705 server.go:825] Created conversation 4ebc13c0-4cd3-4f59-b19d-2ee98ad883b2\n');
        feedText(mockProc, 'STORED\n');
        closeProc(mockProc, 0);
      }, 10);
      await send1;

      expect(session.conversationId).toBe('4ebc13c0-4cd3-4f59-b19d-2ee98ad883b2');
      expect(session.getStats().agyConversationId).toBe('4ebc13c0-4cd3-4f59-b19d-2ee98ad883b2');
      const firstArgs = mockSpawn.mock.calls[0][1] as string[];
      expect(firstArgs).not.toContain('--conversation');

      // Turn 2: resume with the harvested ID
      const proc2 = createMockProcess();
      mockSpawn.mockReturnValue(proc2);
      const send2 = session.send('second turn', { waitForComplete: true });
      setTimeout(() => {
        succeedProc(proc2);
      }, 10);
      await send2;

      const secondArgs = mockSpawn.mock.calls[1][1] as string[];
      const idx = secondArgs.indexOf('--conversation');
      expect(idx).toBeGreaterThan(-1);
      expect(secondArgs[idx + 1]).toBe('4ebc13c0-4cd3-4f59-b19d-2ee98ad883b2');
    });

    // agy has no system-prompt flag, so `appendSystemPrompt` (a council seat's
    // whole charter) used to be dropped. It leads the turn that opens the
    // conversation; later turns resume a conversation that already holds it.
    it('puts appendSystemPrompt only on the turn that opens the conversation', async () => {
      const session = new PersistentAgySession({
        name: 'test',
        cwd: '/tmp',
        permissionMode: 'bypassPermissions',
        appendSystemPrompt: 'SEAT RULES',
      });
      await session.start();

      const send1 = session.send('first turn', { waitForComplete: true });
      const logFile = logPathFromSpawn();
      tmpLogs.push(logFile);
      setTimeout(() => {
        fs.writeFileSync(logFile, 'I0705 server.go:825] Created conversation 4ebc13c0-4cd3-4f59-b19d-2ee98ad883b2\n');
        feedText(mockProc, 'STORED\n');
        closeProc(mockProc, 0);
      }, 10);
      await send1;
      const firstArgs = mockSpawn.mock.calls[0][1] as string[];
      expect(firstArgs[firstArgs.indexOf('-p') + 1]).toBe('SEAT RULES\n\n---\n\nfirst turn');

      const proc2 = createMockProcess();
      mockSpawn.mockReturnValue(proc2);
      const send2 = session.send('second turn', { waitForComplete: true });
      setTimeout(() => succeedProc(proc2), 10);
      await send2;
      const secondArgs = mockSpawn.mock.calls[1][1] as string[];
      expect(secondArgs).toContain('--conversation');
      expect(secondArgs[secondArgs.indexOf('-p') + 1]).toBe('second turn');
    });

    it('seeds the conversation ID from resumeSessionId', async () => {
      const session = new PersistentAgySession({
        name: 'test',
        cwd: '/tmp',
        permissionMode: 'bypassPermissions',
        resumeSessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      });
      await session.start();

      const sendPromise = session.send('hello again', { waitForComplete: true });
      setTimeout(() => succeedProc(mockProc), 10);
      await sendPromise;

      const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
      const idx = spawnArgs.indexOf('--conversation');
      expect(idx).toBeGreaterThan(-1);
      expect(spawnArgs[idx + 1]).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    });

    it('ignores synthetic agy session IDs passed as resumeSessionId', async () => {
      const session = new PersistentAgySession({
        name: 'test',
        cwd: '/tmp',
        permissionMode: 'bypassPermissions',
        resumeSessionId: 'agy-1720000000000-ab3f',
      });
      await session.start();

      const sendPromise = session.send('hello again', { waitForComplete: true });
      setTimeout(() => succeedProc(mockProc), 10);
      await sendPromise;

      const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
      expect(spawnArgs).not.toContain('--conversation');
    });

    it('keeps the existing ID when the log has no Created line (resumed turn)', async () => {
      const session = new PersistentAgySession({
        name: 'test',
        cwd: '/tmp',
        permissionMode: 'bypassPermissions',
        resumeSessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      });
      await session.start();

      const sendPromise = session.send('hello', { waitForComplete: true });
      const logFile = logPathFromSpawn();
      tmpLogs.push(logFile);
      setTimeout(() => {
        fs.writeFileSync(logFile, 'I0705 server.go:825] Created conversation ffffffff-1111-2222-3333-444444444444\n');
        succeedProc(mockProc);
      }, 10);
      await sendPromise;

      expect(session.conversationId).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    });

    it('harvests the conversation ID even after the wrapper timeout settles the turn', async () => {
      const session = new PersistentAgySession({
        name: 'test',
        cwd: '/tmp',
        permissionMode: 'bypassPermissions',
      });
      await session.start();

      const observed = session.send('slow turn', { waitForComplete: true, timeout: 10 }).catch((err: Error) => err);
      const logFile = logPathFromSpawn();
      tmpLogs.push(logFile);
      fs.writeFileSync(logFile, 'I0705 server.go:825] Created conversation 11111111-2222-3333-4444-555555555555\n');

      await new Promise((resolve) => setTimeout(resolve, 20));
      closeProc(mockProc, 143);

      const err = await observed;
      expect(err.message).toContain('Timeout waiting for Antigravity response');
      expect(session.conversationId).toBe('11111111-2222-3333-4444-555555555555');
    });

    // A resumed conversation writes no "Created conversation" line, so the log
    // cannot give the id back: if the timeout path dropped it, the next send
    // would start a new conversation and an agy Planner would lose its chat.
    it('keeps a resumed conversation across a turn killed by the timeout', async () => {
      const session = new PersistentAgySession({
        name: 'test',
        cwd: '/tmp',
        permissionMode: 'bypassPermissions',
        resumeSessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      });
      await session.start();

      const observed = session.send('slow turn', { waitForComplete: true, timeout: 10 }).catch((err: Error) => err);
      tmpLogs.push(logPathFromSpawn());
      await new Promise((resolve) => setTimeout(resolve, 20));
      closeProc(mockProc, 143);
      expect((await observed).message).toContain('Timeout waiting for Antigravity response');
      expect(session.conversationId).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');

      const proc2 = createMockProcess();
      mockSpawn.mockReturnValue(proc2);
      const next = session.send('are you still there?', { waitForComplete: true });
      setTimeout(() => succeedProc(proc2), 10);
      await next;
      const args = mockSpawn.mock.calls[1][1] as string[];
      expect(args[args.indexOf('--conversation') + 1]).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    });

    it('logs a warning when the first turn cannot harvest a conversation ID', async () => {
      const session = new PersistentAgySession({
        name: 'test',
        cwd: '/tmp',
        permissionMode: 'bypassPermissions',
      });
      await session.start();

      const logs: string[] = [];
      session.on('log', (msg: string) => logs.push(msg));

      const sendPromise = session.send('hello', { waitForComplete: true });
      setTimeout(() => succeedProc(mockProc), 10);
      await sendPromise;

      expect(logs.some((l) => l.includes('no conversation ID found in log'))).toBe(true);
    });
  });

  // ─── plain-text output ──────────────────────────────────────────────────

  describe('plain-text output', () => {
    // Regression guard: agy grew `--output-format stream-json`, whose `result`
    // event carries real usage. Before that this wrapper estimated ~4 chars per
    // token from the message text, which under-counted the prompt by orders of
    // magnitude (a short prompt estimated ~27 tokens against a real ~15k).
    it('takes token usage from the result event instead of estimating', async () => {
      const session = new PersistentAgySession({ name: 'test', cwd: '/tmp' });
      await session.start();

      const p = session.send('hello', { waitForComplete: true });
      setTimeout(() => {
        feedText(
          mockProc,
          JSON.stringify({
            event: 'result',
            result: {
              conversation_id: '11111111-2222-3333-4444-555555555555',
              status: 'SUCCESS',
              response: 'OK',
              usage: { input_tokens: 14922, output_tokens: 24, cache_read_tokens: 7 },
            },
          }) + '\n',
        );
        closeProc(mockProc, 0);
      }, 10);
      await p;

      const stats = session.getStats();
      expect(stats.tokensIn).toBe(14922);
      expect(stats.tokensOut).toBe(24);
      expect(stats.cachedTokens).toBe(7);
      // The id comes off the stream, so no log-file scrape is needed.
      expect(session.conversationId).toBe('11111111-2222-3333-4444-555555555555');
    });

    // agy's input_tokens leaves the cache reads out; they used to be dropped from
    // the cost, so a turn that read most of its prompt from cache looked free.
    it('prices cache reads on their own, at the cached rate', async () => {
      const session = new PersistentAgySession({ name: 'test', cwd: '/tmp', model: 'gemini-3.8-flash' });
      await session.start();
      const p = session.send('hello', { waitForComplete: true });
      setTimeout(() => {
        feedText(
          mockProc,
          JSON.stringify({
            event: 'result',
            result: {
              conversation_id: '11111111-2222-3333-4444-555555555555',
              status: 'SUCCESS',
              response: 'OK',
              usage: { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_tokens: 2_000_000 },
            },
          }) + '\n',
        );
        closeProc(mockProc, 0);
      }, 10);
      await p;
      // 1M input at $0.75 + 2M cache reads at $0.075 + 1M output at $3.75
      expect(session.getStats().costUsd).toBeCloseTo(0.75 + 0.15 + 3.75, 6);
    });

    it("measures the context by the turn's last request, not the turn's summed usage", async () => {
      // agy's `result.usage` sums every request of the turn, and `input_tokens`
      // leaves the cached reads out. Each `agent_response` step reports its own
      // request; the last one is the context. Shapes from agy 1.5.3.
      const session = new PersistentAgySession({ name: 'test', cwd: '/tmp' });
      await session.start();
      const conv = 'fb445f86-e702-4506-8b45-56fe7b56ddb9';
      const step = (input: number, cached: number, conversation_id = conv) =>
        JSON.stringify({
          event: 'step_update',
          step_update: {
            conversation_id,
            state: 'DONE',
            step_type: 'agent_response',
            usage: { input_tokens: input, output_tokens: 40, cache_read_tokens: cached },
          },
        }) + '\n';

      const p = session.send('hello', { waitForComplete: true });
      setTimeout(() => {
        feedText(mockProc, JSON.stringify({ event: 'init', conversation_id: conv }) + '\n');
        for (const [input, cached] of [
          [200_000, 0],
          [2_000, 199_000],
          [2_000, 201_000],
          [2_000, 203_000],
        ])
          feedText(mockProc, step(input, cached));
        // A subagent works in a conversation of its own.
        feedText(mockProc, step(600_000, 0, '99999999-8888-7777-6666-555555555555'));
        feedText(
          mockProc,
          JSON.stringify({
            event: 'result',
            result: {
              conversation_id: conv,
              status: 'SUCCESS',
              response: 'done',
              usage: { input_tokens: 806_000, output_tokens: 200, cache_read_tokens: 603_000 },
            },
          }) + '\n',
        );
        closeProc(mockProc, 0);
      }, 10);
      await p;

      // 205,000 of a 1M window, not the summed 806,000 (81%).
      expect(session.getStats().contextPercent).toBe(21);
    });

    it('takes the conversation id from the init event', async () => {
      const session = new PersistentAgySession({ name: 'test', cwd: '/tmp' });
      await session.start();

      const p = session.send('hello', { waitForComplete: true });
      setTimeout(() => {
        feedText(
          mockProc,
          JSON.stringify({ event: 'init', conversation_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }) + '\n',
        );
        succeedProc(mockProc);
      }, 10);
      await p;

      expect(session.conversationId).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    });

    it('accumulates stdout chunks and trims the trailing newline', async () => {
      const session = new PersistentAgySession({
        name: 'test',
        cwd: '/tmp',
        permissionMode: 'bypassPermissions',
      });
      await session.start();

      const chunks: string[] = [];
      const sendPromise = session.send('hello', {
        waitForComplete: true,
        callbacks: { onText: (t: string) => chunks.push(t) },
      });
      setTimeout(() => {
        feedText(mockProc, 'Hello ');
        feedText(mockProc, 'world!\n');
        closeProc(mockProc, 0);
      }, 10);

      const result = await sendPromise;
      expect('text' in result && result.text).toBe('Hello world!');
      expect(chunks.join('')).toBe('Hello world!\n');
    });

    it('estimates tokens since agy emits no usage data', async () => {
      const session = new PersistentAgySession({
        name: 'test',
        cwd: '/tmp',
        permissionMode: 'bypassPermissions',
      });
      await session.start();

      const sendPromise = session.send('a prompt message', { waitForComplete: true });
      setTimeout(() => {
        feedText(mockProc, 'some response text here\n');
        closeProc(mockProc, 0);
      }, 10);

      await sendPromise;
      const stats = session.getStats();
      // Estimation: ~4 chars per token
      expect(stats.tokensIn).toBeGreaterThan(0);
      expect(stats.tokensOut).toBeGreaterThan(0);
    });
  });

  // ─── exit codes ─────────────────────────────────────────────────────────

  describe('exit codes', () => {
    it('rejects on non-zero exit', async () => {
      const session = new PersistentAgySession({
        name: 'test',
        cwd: '/tmp',
        permissionMode: 'bypassPermissions',
      });
      await session.start();

      const sendPromise = session.send('hello', { waitForComplete: true });
      setTimeout(() => closeProc(mockProc, 1), 10);

      await expect(sendPromise).rejects.toThrow('Antigravity exited with code 1');
    });
  });

  // ─── lifecycle ──────────────────────────────────────────────────────────

  describe('lifecycle', () => {
    it('stop() kills in-flight process and removes the log file', async () => {
      const session = new PersistentAgySession({
        name: 'test',
        cwd: '/tmp',
        permissionMode: 'bypassPermissions',
      });
      await session.start();

      session.send('hello', { waitForComplete: false });
      const logFile = logPathFromSpawn();
      fs.writeFileSync(logFile, 'leftover log\n');
      session.stop();

      expect(mockProc.kill).toHaveBeenCalledWith('SIGTERM');
      expect(session.isReady).toBe(false);
      expect(fs.existsSync(logFile)).toBe(false);
    });

    it('compact() returns no-op message', async () => {
      const session = new PersistentAgySession({
        name: 'test',
        cwd: '/tmp',
        permissionMode: 'bypassPermissions',
      });
      await session.start();

      const result = await session.compact();
      expect(result.text).toContain('does not support compaction');
    });

    it('prices an effort-qualified slug as its base model', async () => {
      const session = new PersistentAgySession({ name: 'test', cwd: '/tmp', model: 'gemini-4-argon-high' });
      await session.start();

      // gemini-4-argon is $2/$10; the Flash fallback it would get is $0.75/$3.75
      const cost = session.getCost();
      expect(cost.pricing.inputPer1M).toBe(2);
      expect(cost.pricing.outputPer1M).toBe(10);
    });

    it('prices an xhigh-qualified slug as its base model too', async () => {
      const session = new PersistentAgySession({ name: 'test', cwd: '/tmp', model: 'gemini-4-hydrogen-xhigh' });
      await session.start();
      expect(session.getCost().pricing.inputPer1M).toBe(1.5);
    });

    it('getCost() uses gemini-3.8-flash pricing by default', async () => {
      const session = new PersistentAgySession({
        name: 'test',
        cwd: '/tmp',
        permissionMode: 'bypassPermissions',
      });
      await session.start();

      const cost = session.getCost();
      // 3.8, not 3.5: agy 1.1.25 stopped serving 3.5 (status: ERROR), and this
      // wrapper always sends --model, so the default here is what really runs.
      expect(cost.model).toBe('gemini-3.8-flash');
      expect(cost.pricing.inputPer1M).toBe(0.75);
      expect(cost.pricing.outputPer1M).toBe(3.75);
    });
  });

  // ─── stderr sanitization ────────────────────────────────────────────────

  describe('stderr sanitization', () => {
    it('redacts bearer tokens from stderr', async () => {
      const session = new PersistentAgySession({
        name: 'test',
        cwd: '/tmp',
        permissionMode: 'bypassPermissions',
      });
      await session.start();

      const logs: string[] = [];
      session.on('log', (msg: string) => logs.push(msg));

      const sendPromise = session.send('hello', { waitForComplete: true });
      setTimeout(() => {
        mockProc.stderr.emit('data', Buffer.from('auth failed: Bearer ya29.secret-token not valid'));
        succeedProc(mockProc);
      }, 10);

      await sendPromise;
      expect(logs.some((l) => l.includes('Bearer ***'))).toBe(true);
      expect(logs.some((l) => l.includes('ya29.secret-token'))).toBe(false);
    });

    it('redacts sk-style keys and Google API key env vars from stderr', async () => {
      const session = new PersistentAgySession({
        name: 'test',
        cwd: '/tmp',
        permissionMode: 'bypassPermissions',
      });
      await session.start();

      const logs: string[] = [];
      session.on('log', (msg: string) => logs.push(msg));

      const sendPromise = session.send('hello', { waitForComplete: true });
      setTimeout(() => {
        mockProc.stderr.emit('data', Buffer.from('GEMINI_API_KEY=AIza12345 key=sk-proj-abcdef1234567890'));
        succeedProc(mockProc);
      }, 10);

      await sendPromise;
      expect(logs.some((l) => l.includes('GEMINI_API_KEY=***'))).toBe(true);
      expect(logs.some((l) => l.includes('sk-***'))).toBe(true);
      expect(logs.some((l) => l.includes('AIza12345'))).toBe(false);
      expect(logs.some((l) => l.includes('sk-proj-abcdef'))).toBe(false);
    });
  });

  // ─── turnsSucceeded ─────────────────────────────────────────────────────
  //
  // agy is the engine where the exit code is the weakest of the three signals: it
  // can exit 0 while its own result event reports a non-SUCCESS status. That turn
  // resolves so callers can use its partial reply, but remains counted as failed.
  describe('turnsSucceeded', () => {
    it('resolves but does not count exit 0 with a non-SUCCESS status', async () => {
      const session = new PersistentAgySession({ name: 'test', cwd: '/tmp', permissionMode: 'default' });
      await session.start();

      const sendPromise = session.send('hello', { waitForComplete: true });
      feedText(
        mockProc,
        JSON.stringify({
          event: 'result',
          // No `error` field: nothing but the status marks this turn as failed.
          result: { conversation_id: 'c1', status: 'STOPPED', response: 'partial' },
        }) + '\n',
      );
      setTimeout(() => closeProc(mockProc, 0), 10);

      const result = await sendPromise;
      if (!('text' in result)) throw new Error('expected a completed turn');
      expect(result.text).toBe('partial');
      expect(result.event.stop_reason).toBe('error');

      const stats = session.getStats();
      expect(stats.turns).toBe(1);
      expect(stats.turnsSucceeded).toBe(0);
    });

    // Regression guard: agy can report SUCCESS and still exit non-zero (it answers,
    // then dies in cleanup). That turn's promise REJECTS, so counting it as succeeded
    // would put the counter and the caller's outcome in direct contradiction.
    it('does not count a SUCCESS status that exits non-zero', async () => {
      const session = new PersistentAgySession({ name: 'test', cwd: '/tmp', permissionMode: 'default' });
      await session.start();

      const sendPromise = session.send('hello', { waitForComplete: true });
      feedText(
        mockProc,
        JSON.stringify({ event: 'result', result: { conversation_id: 'c1', status: 'SUCCESS', response: 'OK' } }) +
          '\n',
      );
      setTimeout(() => closeProc(mockProc, 1), 10);
      await expect(sendPromise).rejects.toThrow(/exited with code 1/);

      const stats = session.getStats();
      expect(stats.turns).toBe(1);
      expect(stats.turnsSucceeded).toBe(0);
    });

    // A failure agy already reported must not be erased by a later SUCCESS in the same
    // turn: the status is recorded sticky.
    it('does not count a turn whose earlier result event reported a failure', async () => {
      const session = new PersistentAgySession({ name: 'test', cwd: '/tmp', permissionMode: 'default' });
      await session.start();

      const sendPromise = session.send('hello', { waitForComplete: true });
      feedText(
        mockProc,
        JSON.stringify({ event: 'result', result: { conversation_id: 'c1', status: 'STOPPED', response: 'partial' } }) +
          '\n' +
          JSON.stringify({ event: 'result', result: { conversation_id: 'c1', status: 'SUCCESS', response: 'OK' } }) +
          '\n',
      );
      setTimeout(() => closeProc(mockProc, 0), 10);

      const result = await sendPromise;
      if (!('text' in result)) throw new Error('expected a completed turn');
      expect(result.event.stop_reason).toBe('error');
      expect(session.getStats().turnsSucceeded).toBe(0);
    });

    // agy 1.2.9+: a run whose deadline passes mid-turn exits 0 with SUCCESS and
    // a partial reply, and says so only on stderr.
    it('fails a turn that reached the agy deadline while still working', async () => {
      const session = new PersistentAgySession({ name: 'test', cwd: '/tmp', permissionMode: 'default' });
      await session.start();

      const observed = session.send('hello', { waitForComplete: true }).catch((err: Error) => err);
      feedText(mockProc, JSON.stringify({ event: 'init', conversation_id: 'c1' }) + '\n');
      mockProc.stderr.emit(
        'data',
        Buffer.from('[agy] print timeout after 270s with turn in progress; returning partial output\n'),
      );
      feedText(
        mockProc,
        JSON.stringify({ event: 'result', result: { conversation_id: 'c1', status: 'SUCCESS', response: 'Half' } }) +
          '\n',
      );
      setTimeout(() => closeProc(mockProc, 0), 10);

      expect(((await observed) as Error).message).toContain('Timeout waiting for Antigravity response');
      expect(session.getStats().turnsSucceeded).toBe(0);
      expect(session.conversationId).toBe('c1');
    });

    // agy 1.4.11+ says why a turn ended early in `result.finished_reason`. The
    // print timeout below is the exact result of a real 1.5.13 run (exit 3).
    // No stderr line is fed: the field alone must decide.
    it('fails a turn whose result reports finished_reason print_timeout as a timeout', async () => {
      const session = new PersistentAgySession({ name: 'test', cwd: '/tmp', permissionMode: 'default' });
      await session.start();

      const observed = session.send('hello', { waitForComplete: true }).catch((err: Error) => err);
      feedText(
        mockProc,
        JSON.stringify({
          event: 'result',
          result: {
            conversation_id: 'ccb11cf5-60d9-40aa-a69e-d506163e37d5',
            status: 'ERROR',
            response: '',
            error: 'print timeout after 1s with the turn still in progress; the response is partial',
            num_turns: 1,
            finished_reason: 'print_timeout',
          },
        }) + '\n',
      );
      setTimeout(() => closeProc(mockProc, 3), 10);

      expect(((await observed) as Error).message).toContain('Timeout waiting for Antigravity response');
      expect(session.getStats().turnsSucceeded).toBe(0);
      expect(session.conversationId).toBe('ccb11cf5-60d9-40aa-a69e-d506163e37d5');
    });

    it('fails a partial SUCCESS reply that reports finished_reason print_timeout', async () => {
      const session = new PersistentAgySession({ name: 'test', cwd: '/tmp', permissionMode: 'default' });
      await session.start();

      const observed = session.send('hello', { waitForComplete: true }).catch((err: Error) => err);
      feedText(
        mockProc,
        JSON.stringify({
          event: 'result',
          result: { conversation_id: 'c1', status: 'SUCCESS', response: 'Half', finished_reason: 'print_timeout' },
        }) + '\n',
      );
      setTimeout(() => closeProc(mockProc, 0), 10);

      expect(((await observed) as Error).message).toContain('Timeout waiting for Antigravity response');
      expect(session.getStats().turnsSucceeded).toBe(0);
    });

    it('does not count a turn that reports finished_reason interrupted', async () => {
      const session = new PersistentAgySession({ name: 'test', cwd: '/tmp', permissionMode: 'default' });
      await session.start();

      const sendPromise = session.send('hello', { waitForComplete: true });
      feedText(
        mockProc,
        JSON.stringify({
          event: 'result',
          result: { conversation_id: 'c1', status: 'SUCCESS', response: 'partial', finished_reason: 'interrupted' },
        }) + '\n',
      );
      setTimeout(() => closeProc(mockProc, 0), 10);

      const result = await sendPromise;
      if (!('text' in result)) throw new Error('expected a completed turn');
      expect(result.event.stop_reason).toBe('error');
      expect(session.getStats().turnsSucceeded).toBe(0);
    });

    // The reported reason outranks the elapsed-time backstop: a turn agy says
    // ended on an error is that error, however close to the deadline it came.
    it('surfaces finished_reason error as the error, not a timeout, even past the deadline', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        const session = new PersistentAgySession({ name: 'test', cwd: '/tmp', permissionMode: 'default' });
        await session.start();

        const observed = session.send('hello', { waitForComplete: true, timeout: 60_000 }).catch((err: Error) => err);
        feedText(
          mockProc,
          JSON.stringify({
            event: 'result',
            result: {
              conversation_id: 'c1',
              status: 'ERROR',
              response: '',
              error: 'model failed',
              finished_reason: 'error',
            },
          }) + '\n',
        );
        vi.setSystemTime(Date.now() + 55_000); // past agy's 54s, short of our 60s
        setTimeout(() => closeProc(mockProc, 3), 10);

        expect(((await observed) as Error).message).toBe('model failed');
        expect(session.getStats().turnsSucceeded).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it('counts a turn that ended at the deadline while waiting on a background task', async () => {
      const session = new PersistentAgySession({ name: 'test', cwd: '/tmp', permissionMode: 'default' });
      await session.start();

      const sendPromise = session.send('start the dev server', { waitForComplete: true });
      mockProc.stderr.emit('data', Buffer.from('root agent idle; waiting up to 4m30s for 1 background task(s)\n'));
      mockProc.stderr.emit('data', Buffer.from('terminating 1 background task(s) on exit\n'));
      feedText(
        mockProc,
        JSON.stringify({ event: 'result', result: { conversation_id: 'c1', status: 'SUCCESS', response: 'STARTED' } }) +
          '\n',
      );
      setTimeout(() => closeProc(mockProc, 0), 10);

      expect((await sendPromise).text).toBe('STARTED');
      expect(session.getStats().turnsSucceeded).toBe(1);
    });

    // Backstop for a reworded stderr line: a run that lasted until agy's deadline
    // without ever going idle was cut off mid-turn.
    it.each([
      ['fails', ''],
      ['counts', 'root agent idle; waiting up to 54s for 1 background task(s)\n'],
    ])('%s a turn that ran to the agy deadline by elapsed time', async (verdict, stderrLine) => {
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        const session = new PersistentAgySession({ name: 'test', cwd: '/tmp', permissionMode: 'default' });
        await session.start();

        const observed = session.send('hello', { waitForComplete: true, timeout: 60_000 }).catch((err: Error) => err);
        if (stderrLine) mockProc.stderr.emit('data', Buffer.from(stderrLine));
        feedText(
          mockProc,
          JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'Partial' } }) + '\n',
        );
        vi.setSystemTime(Date.now() + 55_000); // past agy's 54s, short of our 60s
        setTimeout(() => closeProc(mockProc, 0), 10);

        const outcome = await observed;
        if (verdict === 'fails') {
          expect((outcome as Error).message).toContain('Timeout waiting for Antigravity response');
          expect(session.getStats().turnsSucceeded).toBe(0);
        } else {
          expect((outcome as { text: string }).text).toBe('Partial');
          expect(session.getStats().turnsSucceeded).toBe(1);
        }
      } finally {
        vi.useRealTimers();
      }
    });

    it('counts a SUCCESS status', async () => {
      const session = new PersistentAgySession({ name: 'test', cwd: '/tmp', permissionMode: 'default' });
      await session.start();

      const sendPromise = session.send('hello', { waitForComplete: true });
      feedText(
        mockProc,
        JSON.stringify({ event: 'result', result: { conversation_id: 'c1', status: 'SUCCESS', response: 'OK' } }) +
          '\n',
      );
      setTimeout(() => closeProc(mockProc, 0), 10);
      await sendPromise;

      const stats = session.getStats();
      expect(stats.turns).toBe(1);
      expect(stats.turnsSucceeded).toBe(1);
    });
  });
});
