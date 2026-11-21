/**
 * Unit tests for PersistentGrokSession.
 *
 * Grok prints one JSON object per `-p` run, so these drive that object through
 * the wrapper and assert what it does with the pieces that are unusual for this
 * engine class: an engine-reported `total_cost_usd`, a resumable `sessionId`,
 * and a refusal to pretend it can enforce read-only.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';

const mockSpawn = vi.fn();
const mockKillTree = vi.fn();
vi.mock('../engine-spawn.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../engine-spawn.js')>()),
  spawnEngine: (...args: unknown[]) => mockSpawn(...args),
  // The real one signals the pid's process group — the mock's pid is a real
  // number on this machine.
  killEngineTree: (...args: unknown[]) => mockKillTree(...args),
}));

const { PersistentGrokSession } = await import('../persistent-grok-session.js');

function createMockProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: Readable;
    stderr: EventEmitter;
    stdin: { end: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn> };
    kill: ReturnType<typeof vi.fn>;
    pid: number;
  };
  proc.stdout = new Readable({ read() {} });
  proc.stderr = new EventEmitter();
  proc.stdin = { end: vi.fn(), on: vi.fn() };
  proc.kill = vi.fn();
  proc.pid = 4242;
  return proc;
}

let mockProc: ReturnType<typeof createMockProcess>;

/**
 * Print `body` the way `--output-format streaming-json` does: the reply as
 * `text` events, one `usage` event per request, then an `end` event carrying
 * the rest. A refusal is a single `error` line in either format.
 */
function reply(body: Record<string, unknown>, code = 0, requests?: Array<Record<string, number>>) {
  const lines: Array<Record<string, unknown>> = [];
  if (body.type === 'error') {
    lines.push(body);
  } else {
    const { text, ...rest } = body;
    if (typeof text === 'string') {
      for (const data of text.match(/[\s\S]{1,3}/g) ?? []) lines.push({ type: 'text', data });
    }
    for (const usage of requests ?? (body.usage ? [body.usage as Record<string, number>] : [])) {
      lines.push({ type: 'usage', usage });
    }
    lines.push({ type: 'end', ...rest });
  }
  mockProc.stdout.push(lines.map((l) => JSON.stringify(l) + '\n').join(''));
  mockProc.stdout.push(null);
  mockProc.emit('close', code);
}

const OK_RESULT = {
  text: 'PING',
  stopReason: 'end_turn',
  sessionId: '01a02a80-21f6-72e2-b923-fc7113f38fd7',
  usage: { input_tokens: 120, output_tokens: 8, cache_read_input_tokens: 40 },
  total_cost_usd: 0.0125,
};

beforeEach(() => {
  mockProc = createMockProcess();
  mockSpawn.mockReset();
  mockKillTree.mockReset();
  mockSpawn.mockReturnValue(mockProc);
});

function spawnArgs(): string[] {
  return mockSpawn.mock.calls[0][1] as string[];
}

describe('PersistentGrokSession — flags', () => {
  it('names the vendor-specific binary, never the contested `agent`', async () => {
    const s = new PersistentGrokSession({ name: 't', cwd: '/tmp', permissionMode: 'bypassPermissions' });
    await s.start();
    const p = s.send('hi', { waitForComplete: true });
    setTimeout(() => reply(OK_RESULT), 5);
    await p;
    expect(mockSpawn.mock.calls[0][0]).toBe('grok');
  });

  it('asks for streaming JSON and passes the cwd', async () => {
    const s = new PersistentGrokSession({ name: 't', cwd: '/tmp', permissionMode: 'bypassPermissions' });
    await s.start();
    const p = s.send('hi', { waitForComplete: true });
    setTimeout(() => reply(OK_RESULT), 5);
    const r = (await p) as { text: string };
    const args = spawnArgs();
    expect(args[0]).toBe('-p');
    expect(args[args.indexOf('--output-format') + 1]).toBe('streaming-json');
    expect(args[args.indexOf('--cwd') + 1]).toBe('/tmp');
    // The reply arrives in pieces and is joined back together.
    expect(r.text).toBe('PING');
  });

  it("measures the context by the turn's last request, not the turn's summed usage", async () => {
    // A turn makes one request per tool round; the `end` event's usage sums
    // them (four requests of ~35k reported 141k on 1.0.77). Each request has
    // its own `usage` event, and the last one is the context.
    const s = new PersistentGrokSession({ name: 't', cwd: '/tmp', model: 'grok-4.6' });
    await s.start();
    const p = s.send('hi', { waitForComplete: true });
    const request = (cached: number) => ({ input_tokens: 1_000, output_tokens: 30, cache_read_input_tokens: cached });
    setTimeout(
      () =>
        reply(
          {
            ...OK_RESULT,
            usage: { input_tokens: 4_000, output_tokens: 120, cache_read_input_tokens: 398_000 },
          },
          0,
          [request(98_000), request(99_000), request(100_000), request(101_000)],
        ),
      5,
    );
    await p;
    const stats = s.getStats();
    // Spend is still the whole turn's.
    expect(stats.tokensIn).toBe(4_000);
    expect(stats.cachedTokens).toBe(398_000);
    // grok-4.6's 500K window: 102,000 is 20%, where the sum read 80%.
    expect(stats.contextPercent).toBe(20);
  });

  it("maps our `manual` permission mode onto grok's `default`", async () => {
    const s = new PersistentGrokSession({ name: 't', cwd: '/tmp', permissionMode: 'manual' });
    await s.start();
    const p = s.send('hi', { waitForComplete: true });
    setTimeout(() => reply(OK_RESULT), 5);
    await p;
    expect(spawnArgs()[spawnArgs().indexOf('--permission-mode') + 1]).toBe('default');
  });

  it.each(['max', 'ultra'] as const)("clamps %s effort to grok's ceiling", async (effort) => {
    const s = new PersistentGrokSession({ name: 't', cwd: '/tmp', permissionMode: 'bypassPermissions', effort });
    await s.start();
    const p = s.send('hi', { waitForComplete: true });
    setTimeout(() => reply(OK_RESULT), 5);
    await p;
    expect(spawnArgs()[spawnArgs().indexOf('--effort') + 1]).toBe('xhigh');
  });

  // grok 1.0.5 takes xhigh natively — clamping it to `high` silently spent a
  // tier of the caller's request.
  it('passes xhigh through rather than clamping it', async () => {
    const s = new PersistentGrokSession({
      name: 't',
      cwd: '/tmp',
      permissionMode: 'bypassPermissions',
      effort: 'xhigh',
    });
    await s.start();
    const p = s.send('hi', { waitForComplete: true });
    setTimeout(() => reply(OK_RESULT), 5);
    await p;
    expect(spawnArgs()[spawnArgs().indexOf('--effort') + 1]).toBe('xhigh');
  });

  // grok's `total_tokens` is input + output + cache reads + cache writes, so
  // `input_tokens` is only the uncached remainder and must not have the cached
  // part subtracted back out of it.
  it('measures context against the whole prompt, not the uncached remainder', async () => {
    const s = new PersistentGrokSession({ name: 't', cwd: '/tmp', permissionMode: 'bypassPermissions' });
    await s.start();
    const p = s.send('hi', { waitForComplete: true });
    setTimeout(
      () =>
        reply({
          text: 'ok',
          usage: {
            input_tokens: 19_393,
            output_tokens: 17,
            cache_read_input_tokens: 230_590,
            cache_creation_input_tokens: 0,
          },
          total_cost_usd: 0.0442,
        }),
      5,
    );
    await p;

    const stats = s.getStats();
    expect(stats.tokensIn).toBe(19_393);
    expect(stats.cachedTokens).toBe(230_590);
    // 249,983 of grok-4.7's 500K window. `input_tokens` alone would say 4%.
    expect(stats.contextPercent).toBe(50);
    // Spend still comes from the engine, untouched by the registry.
    expect(stats.costUsd).toBeCloseTo(0.0442, 10);
  });

  it('bills as the model grok reports when none was configured', async () => {
    const s = new PersistentGrokSession({ name: 't', cwd: '/tmp', permissionMode: 'bypassPermissions' });
    await s.start();
    expect(s.getCost().model).toBe('grok-4.7');
    const p = s.send('hi', { waitForComplete: true });
    setTimeout(() => reply({ ...OK_RESULT, modelUsage: { 'grok-4.6': { modelCalls: 1, costUSD: 0.0125 } } }), 5);
    await p;
    expect(s.getCost().model).toBe('grok-4.6');
  });

  // grok 1.0.13 grew a programmatic surface for options this project already
  // had. Every one of these was being dropped on the floor before: the caller
  // set it, the wrapper never passed it, and nothing said so.
  it('forwards the session options grok can now accept', async () => {
    const s = new PersistentGrokSession({
      name: 't',
      cwd: '/tmp',
      permissionMode: 'bypassPermissions',
      appendSystemPrompt: 'extra rules',
      tools: ['read_file', 'grep'],
      jsonSchema: '{"type":"object"}',
      agent: 'reviewer',
      dangerouslySkipPermissions: true,
      customSessionId: '11111111-2222-3333-4444-555555555555',
    });
    await s.start();
    const p = s.send('hi', { waitForComplete: true });
    setTimeout(() => reply(OK_RESULT), 5);
    await p;

    const a = spawnArgs();
    expect(a).toContain('--rules=extra rules');
    // grok takes the instructions natively, so the message itself stays as sent —
    // the one-shot fallback that prefixes the first message must not fire here.
    expect(mockProc.stdin.end).toHaveBeenCalledWith('hi');
    expect(a[a.indexOf('--tools') + 1]).toBe('read_file,grep');
    expect(a[a.indexOf('--json-schema') + 1]).toBe('{"type":"object"}');
    expect(a[a.indexOf('--agent') + 1]).toBe('reviewer');
    expect(a).toContain('--always-approve');
    expect(a[a.indexOf('--session-id') + 1]).toBe('11111111-2222-3333-4444-555555555555');
  });

  // `--session-id` names a NEW conversation. Passing it alongside a resume is
  // rejected by grok unless the resume is also a fork, so it is withheld there.
  it('withholds --session-id on a plain resume', async () => {
    const s = new PersistentGrokSession({
      name: 't',
      cwd: '/tmp',
      permissionMode: 'bypassPermissions',
      resumeSessionId: 'grok-live-01a04318-209b-7fa1-aff0-c65a8c2ea23e',
      customSessionId: '11111111-2222-3333-4444-555555555555',
    });
    await s.start();
    const p = s.send('hi', { waitForComplete: true });
    setTimeout(() => reply(OK_RESULT), 5);
    await p;

    const a = spawnArgs();
    expect(a).toContain('--resume');
    expect(a).not.toContain('--session-id');
    expect(a).not.toContain('--fork-session');
  });

  it('names the forked session when a resume is forked', async () => {
    const s = new PersistentGrokSession({
      name: 't',
      cwd: '/tmp',
      permissionMode: 'bypassPermissions',
      resumeSessionId: 'grok-live-01a04318-209b-7fa1-aff0-c65a8c2ea23e',
      forkSession: true,
      customSessionId: '11111111-2222-3333-4444-555555555555',
    });
    await s.start();
    const p = s.send('hi', { waitForComplete: true });
    setTimeout(() => reply(OK_RESULT), 5);
    await p;

    const a = spawnArgs();
    expect(a).toContain('--fork-session');
    expect(a[a.indexOf('--session-id') + 1]).toBe('11111111-2222-3333-4444-555555555555');
  });

  // Measured against 1.0.13: a `--tools` allowlist of read-only built-ins plus
  // plan mode refused a direct write and a shell write, then lost to the third
  // prompt — the session spawned a subagent and the file appeared. Until that
  // is closed and proven, read-only stays refused rather than approximated.
  // Read-only is grok's OS sandbox profile, not a tool allowlist: the allowlist
  // was measured losing to a delegated subagent on 1.0.13.
  it("runs read-only inside grok's read-only sandbox profile", async () => {
    const s = new PersistentGrokSession({
      name: 't',
      cwd: process.cwd(),
      permissionMode: 'bypassPermissions',
      sandboxMode: 'read-only',
    });
    await s.start();
    const p = s.send('hi', { waitForComplete: true });
    setTimeout(() => reply(OK_RESULT), 5);
    await p;
    const args = spawnArgs();
    expect(args[args.indexOf('--sandbox') + 1]).toBe('read-only');
  });

  it('passes no sandbox profile when the session is not read-only', async () => {
    const s = new PersistentGrokSession({ name: 't', cwd: process.cwd(), permissionMode: 'bypassPermissions' });
    await s.start();
    const p = s.send('hi', { waitForComplete: true });
    setTimeout(() => reply(OK_RESULT), 5);
    await p;
    expect(spawnArgs()).not.toContain('--sandbox');
  });

  it('omits --effort for auto', async () => {
    const s = new PersistentGrokSession({
      name: 't',
      cwd: '/tmp',
      permissionMode: 'bypassPermissions',
      effort: 'auto',
    });
    await s.start();
    const p = s.send('hi', { waitForComplete: true });
    setTimeout(() => reply(OK_RESULT), 5);
    await p;
    expect(spawnArgs()).not.toContain('--effort');
  });
});

describe('PersistentGrokSession — conversation continuity', () => {
  it('replays the captured sessionId on the next turn', async () => {
    const s = new PersistentGrokSession({ name: 't', cwd: '/tmp', permissionMode: 'bypassPermissions' });
    await s.start();
    const p1 = s.send('one', { waitForComplete: true });
    setTimeout(() => reply(OK_RESULT), 5);
    await p1;
    expect(spawnArgs()).not.toContain('--resume');

    mockProc = createMockProcess();
    mockSpawn.mockReturnValue(mockProc);
    const p2 = s.send('two', { waitForComplete: true });
    setTimeout(() => reply(OK_RESULT), 5);
    await p2;
    const args2 = mockSpawn.mock.calls[1][1] as string[];
    expect(args2[args2.indexOf('--resume') + 1]).toBe(OK_RESULT.sessionId);
  });

  it('refuses to resume from a synthetic wrapper id', async () => {
    // `grok-<ts>-<rand>` is BaseOneShotSession's own identifier, not a grok
    // session. Handing it to --resume would fail the turn or silently start fresh.
    const s = new PersistentGrokSession({
      name: 't',
      cwd: '/tmp',
      permissionMode: 'bypassPermissions',
      resumeSessionId: 'grok-1750000000000-ab12',
    });
    await s.start();
    const p = s.send('hi', { waitForComplete: true });
    setTimeout(() => reply(OK_RESULT), 5);
    await p;
    expect(spawnArgs()).not.toContain('--resume');
  });

  it('accepts a persisted id behind the grok-live- prefix', async () => {
    const s = new PersistentGrokSession({
      name: 't',
      cwd: '/tmp',
      permissionMode: 'bypassPermissions',
      resumeSessionId: `grok-live-${OK_RESULT.sessionId}`,
    });
    await s.start();
    const p = s.send('hi', { waitForComplete: true });
    setTimeout(() => reply(OK_RESULT), 5);
    await p;
    expect(spawnArgs()[spawnArgs().indexOf('--resume') + 1]).toBe(OK_RESULT.sessionId);
  });
});

describe('PersistentGrokSession — accounting', () => {
  it('takes the cost the engine reported instead of pricing it from the registry', async () => {
    const s = new PersistentGrokSession({ name: 't', cwd: '/tmp', permissionMode: 'bypassPermissions' });
    await s.start();
    const p = s.send('hi', { waitForComplete: true });
    setTimeout(() => reply(OK_RESULT), 5);
    await p;
    // 120 in / 8 out at any registry rate is nowhere near $0.0125; the only way
    // to get this number is to have read total_cost_usd.
    expect(s.getStats().costUsd).toBeCloseTo(0.0125, 6);
    expect(s.getCost().totalUsd).toBeCloseTo(0.0125, 6);
  });

  it('accumulates per-turn usage and cost across turns', async () => {
    const s = new PersistentGrokSession({ name: 't', cwd: '/tmp', permissionMode: 'bypassPermissions' });
    await s.start();
    const p1 = s.send('one', { waitForComplete: true });
    setTimeout(() => reply(OK_RESULT), 5);
    await p1;

    mockProc = createMockProcess();
    mockSpawn.mockReturnValue(mockProc);
    const p2 = s.send('two', { waitForComplete: true });
    setTimeout(() => reply({ ...OK_RESULT, usage: { input_tokens: 30, output_tokens: 4 }, total_cost_usd: 0.002 }), 5);
    await p2;

    const st = s.getStats();
    expect(st.tokensIn).toBe(150);
    expect(st.tokensOut).toBe(12);
    expect(st.costUsd).toBeCloseTo(0.0145, 6);
    expect(st.turns).toBe(2);
    expect(st.turnsSucceeded).toBe(2);
  });

  it('never marks a turn estimated — grok always reports usage', async () => {
    const s = new PersistentGrokSession({ name: 't', cwd: '/tmp', permissionMode: 'bypassPermissions' });
    await s.start();
    const p = s.send('hi', { waitForComplete: true });
    setTimeout(() => reply(OK_RESULT), 5);
    await p;
    expect(s.getStats().tokensEstimated).toBe(false);
  });
});

describe('PersistentGrokSession — failure handling', () => {
  it('does not count a turn the engine reported as errored', async () => {
    const s = new PersistentGrokSession({ name: 't', cwd: '/tmp', permissionMode: 'bypassPermissions' });
    await s.start();
    const p = s.send('hi', { waitForComplete: true });
    setTimeout(() => reply({ ...OK_RESULT, stopReason: 'error' }), 5);
    await p;
    const st = s.getStats();
    expect(st.turns).toBe(1);
    expect(st.turnsSucceeded).toBe(0);
  });

  it('rejects when no JSON result was produced, whatever the exit code', async () => {
    const s = new PersistentGrokSession({ name: 't', cwd: '/tmp', permissionMode: 'bypassPermissions' });
    await s.start();
    const p = s.send('hi', { waitForComplete: true });
    setTimeout(() => {
      mockProc.stdout.push(null);
      mockProc.emit('close', 0);
    }, 5);
    await expect(p).rejects.toThrow(/no JSON result/);
  });

  it('surfaces the error field from the result object', async () => {
    const s = new PersistentGrokSession({ name: 't', cwd: '/tmp', permissionMode: 'bypassPermissions' });
    await s.start();
    const p = s.send('hi', { waitForComplete: true });
    setTimeout(() => reply({ error: 'model unavailable' }, 1), 5);
    await expect(p).rejects.toThrow('model unavailable');
  });

  // grok 1.0.46 answers a refused turn (free-tier usage limit, auth) with an
  // error object, not a result. Reading only `error` resolved the turn as an
  // empty reply, and the caller saw "did not report the turn as succeeded".
  it('surfaces the message of a type:error object', async () => {
    const s = new PersistentGrokSession({ name: 't', cwd: '/tmp', permissionMode: 'bypassPermissions' });
    await s.start();
    const p = s.send('hi', { waitForComplete: true });
    setTimeout(() => reply({ type: 'error', message: 'You have reached your usage limit for now.' }, 1), 5);
    await expect(p).rejects.toThrow('You have reached your usage limit for now.');
  });

  // A plain kill ends only the direct child: under a launcher, or behind a
  // Windows shim, the engine itself would keep running past the deadline.
  it('ends the whole process tree when a turn times out', async () => {
    const s = new PersistentGrokSession({ name: 't', cwd: '/tmp', permissionMode: 'bypassPermissions' });
    await s.start();
    await expect(s.send('hi', { waitForComplete: true, timeout: 10 })).rejects.toThrow(/Timeout waiting for Grok/);
    expect(mockKillTree).toHaveBeenCalledWith(mockProc);
    expect(mockProc.kill).not.toHaveBeenCalled();
  });

  // grok's read-only profile leaves the temp directory writable, so a project
  // there would be writable under a read-only label.
  it('refuses read-only for a project under the temp directory', async () => {
    const s = new PersistentGrokSession({
      name: 't',
      cwd: os.tmpdir(),
      permissionMode: 'bypassPermissions',
      sandboxMode: 'read-only',
    });
    await s.start();
    await expect(s.send('hi', { waitForComplete: true })).rejects.toThrow(/temp directory/);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  // grok 1.0.50 warns and runs unsandboxed when a profile cannot be applied.
  it('stops the turn when grok says the sandbox could not be applied', async () => {
    const s = new PersistentGrokSession({
      name: 't',
      cwd: process.cwd(),
      permissionMode: 'bypassPermissions',
      sandboxMode: 'read-only',
    });
    await s.start();
    const p = s.send('hi', { waitForComplete: true });
    setTimeout(
      () => mockProc.stderr.emit('data', Buffer.from('warning: sandbox could not be applied: Landlock unavailable\n')),
      5,
    );
    await expect(p).rejects.toThrow(/could not apply its read-only sandbox/);
    expect(mockKillTree).toHaveBeenCalledWith(mockProc);
  });

  it('refuses read-only on a platform without an OS sandbox', async () => {
    const original = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      const s = new PersistentGrokSession({
        name: 't',
        cwd: process.cwd(),
        permissionMode: 'bypassPermissions',
        sandboxMode: 'read-only',
      });
      await s.start();
      await expect(s.send('hi', { waitForComplete: true })).rejects.toThrow(/Seatbelt or Landlock/);
      expect(mockSpawn).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, 'platform', { value: original });
    }
  });
});

/** Start a session, send one message, answer it with `body`, and return the spawn argv. */
async function argsFor(config: Record<string, unknown>, body: Record<string, unknown> = OK_RESULT): Promise<string[]> {
  const s = new PersistentGrokSession({ name: 't', cwd: '/tmp', permissionMode: 'bypassPermissions', ...config });
  await s.start();
  const p = s.send('hi', { waitForComplete: true });
  setTimeout(() => reply(body), 5);
  await p;
  return spawnArgs();
}

/** Every value passed after `flag`, in order. */
function valuesOf(args: string[], flag: string): string[] {
  return args.flatMap((a, i) => (a === flag ? [args[i + 1]] : []));
}

describe('PersistentGrokSession — the prompt travels on stdin', () => {
  // clap read a message passed as `-p <msg>` as options when it started with
  // `-`: `- item`, `-5 degrees` and `--- heading` all failed before the turn.
  // `-p` with no value reads the prompt from stdin, which also keeps it out of
  // the argv size limit and out of `ps`.
  it.each(['- item one', '-5 degrees', '--- heading'])('sends %j verbatim on stdin, never in argv', async (msg) => {
    const s = new PersistentGrokSession({ name: 't', cwd: '/tmp', permissionMode: 'bypassPermissions' });
    await s.start();
    const p = s.send(msg, { waitForComplete: true });
    setTimeout(() => reply(OK_RESULT), 5);
    await p;
    const a = spawnArgs();
    expect(a[0]).toBe('-p');
    // `-p` takes no value: the next argument is a flag.
    expect(a[1].startsWith('--')).toBe(true);
    expect(a).not.toContain(msg);
    expect(mockProc.stdin.end).toHaveBeenCalledWith(msg);
    // grok may exit before reading stdin; an unheard EPIPE would crash the server.
    expect(mockProc.stdin.on).toHaveBeenCalledWith('error', expect.any(Function));
  });

  // The same clap rule applies to option values: `--rules "- be brief"` fails
  // to parse. The equals form keeps a leading dash inside the value.
  it('passes free-text instructions in the equals form', async () => {
    const a = await argsFor({ appendSystemPrompt: '- be brief', systemPrompt: '- you are a reviewer' });
    expect(a).toContain('--rules=- be brief');
    expect(a).toContain('--system-prompt-override=- you are a reviewer');
    expect(a).not.toContain('--rules');
  });
});

describe('PersistentGrokSession — tool control', () => {
  // `--disallowed-tools` takes grok's internal tool ids: `--disallowed-tools
  // Bash` warned "names no tool, so it removes nothing" and the shell ran
  // (1.0.92). `--deny` takes permission rules, which name `Bash`.
  it('maps disallowedTools that are permission rules onto --deny, one per entry', async () => {
    const a = await argsFor({ disallowedTools: ['Bash', 'Bash(rm -rf *)', 'Write', 'WebFetch(domain:example.com)'] });
    expect(valuesOf(a, '--deny')).toEqual(['Bash', 'Bash(rm -rf *)', 'Write', 'WebFetch(domain:example.com)']);
    expect(a).not.toContain('--disallowed-tools');
  });

  // `--deny Agent(explore)` and `--deny NotebookEdit` exit 1 before the session
  // starts ("Grok has no tool named Agent"); subagents are removed through
  // `--disallowed-tools`, and a name grok lacks only warns there.
  it('removes subagents and other non-rule names through --disallowed-tools', async () => {
    const a = await argsFor({
      disallowedTools: ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Agent', 'Agent(explore)', 'run_terminal_cmd'],
    });
    expect(valuesOf(a, '--deny')).toEqual(['Write', 'Edit']);
    expect(valuesOf(a, '--disallowed-tools')).toEqual(['MultiEdit,NotebookEdit,Agent,Agent(explore),run_terminal_cmd']);
  });

  it('translates Claude-style MCP tool names into MCPTool rules', async () => {
    const a = await argsFor({ disallowedTools: ['mcp__linear__create_issue', 'mcp__github'] });
    expect(valuesOf(a, '--deny')).toEqual(['MCPTool(linear__create_issue)', 'MCPTool(github__*)']);
  });

  // `--allowedTools` is grok's alias of `--allow`: permission rules that
  // auto-approve, not a toolset. `--allow NotebookEdit` exits 1, and an allow
  // rule for a tool grok lacks approves nothing, so such entries are left out.
  it('maps allowedTools onto --allow rules and leaves out names grok has no rule for', async () => {
    const s = new PersistentGrokSession({
      name: 't',
      cwd: '/tmp',
      permissionMode: 'default',
      allowedTools: ['Bash(npm *)', 'Read', 'NotebookEdit', 'read_file', 'mcp__srv__tool'],
    });
    const logs: string[] = [];
    s.on('log', (l: string) => logs.push(l));
    await s.start();
    const p = s.send('hi', { waitForComplete: true });
    setTimeout(() => reply(OK_RESULT), 5);
    await p;
    const a = spawnArgs();
    expect(valuesOf(a, '--allow')).toEqual(['Bash(npm *)', 'Read', 'MCPTool(srv__tool)']);
    expect(a).not.toContain('--tools');
    expect(logs.join('\n')).toMatch(/NotebookEdit, read_file/);
  });

  it('passes the tools allowlist as one comma-separated --tools', async () => {
    expect(valuesOf(await argsFor({ tools: ['read_file', 'grep'] }), '--tools')).toEqual(['read_file,grep']);
  });

  it("leaves --tools out for Claude's `default` toolset", async () => {
    expect(await argsFor({ tools: 'default' })).not.toContain('--tools');
  });
});

describe('PersistentGrokSession — stop reasons', () => {
  it('counts end_turn as a success', async () => {
    const s = new PersistentGrokSession({ name: 't', cwd: '/tmp', permissionMode: 'bypassPermissions' });
    await s.start();
    const p = s.send('hi', { waitForComplete: true });
    setTimeout(() => reply(OK_RESULT), 5);
    const r = (await p) as { event: { stop_reason: string } };
    expect(r.event.stop_reason).toBe('end_turn');
    expect(s.getStats().turnsSucceeded).toBe(1);
  });

  // grok documents its stop reasons as open-ended: "treat one you do not
  // recognize as not a success". Only `error` used to fail a turn.
  it.each(['refusal', 'max_tokens', 'cancelled', 'max_turn_requests', 'some_future_reason', undefined])(
    'does not count a turn that stopped for %s',
    async (stopReason) => {
      const s = new PersistentGrokSession({ name: 't', cwd: '/tmp', permissionMode: 'bypassPermissions' });
      await s.start();
      const p = s.send('hi', { waitForComplete: true });
      setTimeout(() => reply({ ...OK_RESULT, stopReason }), 5);
      const r = (await p) as { text: string; event: { stop_reason: string } };
      expect(r.text).toBe('PING');
      expect(r.event.stop_reason).toBe('error');
      const st = s.getStats();
      expect(st.turns).toBe(1);
      expect(st.turnsSucceeded).toBe(0);
    },
  );

  // A hook that stops the turn ends it with `hook_stopped` and the hook's message as `error`.
  it("rejects with the hook's message when a hook stopped the turn", async () => {
    const s = new PersistentGrokSession({ name: 't', cwd: '/tmp', permissionMode: 'bypassPermissions' });
    await s.start();
    const p = s.send('hi', { waitForComplete: true });
    setTimeout(() => reply({ ...OK_RESULT, stopReason: 'hook_stopped', error: 'build is frozen' }, 1), 5);
    await expect(p).rejects.toThrow('build is frozen');
  });
});

describe('PersistentGrokSession — background work', () => {
  // grok waits up to 600 s for background tasks after the turn, past the send
  // timeout (300 s by default), which then killed the turn and lost its reply,
  // cost and session id. Not waiting exits when the turn ends and stops the
  // work, without changing the exit code or the closing line.
  it('does not wait for background work after the turn', async () => {
    expect(await argsFor({})).toContain('--no-wait-for-background');
  });
});

describe('PersistentGrokSession — workspace-write sandbox', () => {
  it("maps workspace-write onto grok's workspace sandbox profile", async () => {
    const a = await argsFor({ cwd: process.cwd(), sandboxMode: 'workspace-write' });
    expect(valuesOf(a, '--sandbox')).toEqual(['workspace']);
  });

  it('allows workspace-write for a project under the temp directory', async () => {
    const a = await argsFor({ cwd: os.tmpdir(), sandboxMode: 'workspace-write' });
    expect(valuesOf(a, '--sandbox')).toEqual(['workspace']);
  });

  it('stops a workspace-write turn when grok says the sandbox could not be applied', async () => {
    const s = new PersistentGrokSession({
      name: 't',
      cwd: process.cwd(),
      permissionMode: 'bypassPermissions',
      sandboxMode: 'workspace-write',
    });
    await s.start();
    const p = s.send('hi', { waitForComplete: true });
    setTimeout(
      () => mockProc.stderr.emit('data', Buffer.from('warning: sandbox could not be applied: Landlock unavailable\n')),
      5,
    );
    await expect(p).rejects.toThrow(/could not apply its workspace sandbox/);
    expect(mockKillTree).toHaveBeenCalledWith(mockProc);
  });

  it('refuses workspace-write on a platform without an OS sandbox', async () => {
    const original = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      const s = new PersistentGrokSession({
        name: 't',
        cwd: process.cwd(),
        permissionMode: 'bypassPermissions',
        sandboxMode: 'workspace-write',
      });
      await s.start();
      await expect(s.send('hi', { waitForComplete: true })).rejects.toThrow(/Seatbelt or Landlock/);
      expect(mockSpawn).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, 'platform', { value: original });
    }
  });
});

describe('PersistentGrokSession — directories, trust and debug', () => {
  // `--add-dir` cannot be combined with `--resume` (clap refuses the pair): a
  // resumed session keeps the folders it was created with.
  it('passes each addDir on the first turn only', async () => {
    const s = new PersistentGrokSession({
      name: 't',
      cwd: '/tmp',
      permissionMode: 'bypassPermissions',
      addDir: ['/srv/a', '/srv/b'],
    });
    await s.start();
    const p1 = s.send('one', { waitForComplete: true });
    setTimeout(() => reply(OK_RESULT), 5);
    await p1;
    expect(valuesOf(spawnArgs(), '--add-dir')).toEqual(['/srv/a', '/srv/b']);

    mockProc = createMockProcess();
    mockSpawn.mockReturnValue(mockProc);
    const p2 = s.send('two', { waitForComplete: true });
    setTimeout(() => reply(OK_RESULT), 5);
    await p2;
    const a2 = mockSpawn.mock.calls[1][1] as string[];
    expect(a2).toContain('--resume');
    expect(a2).not.toContain('--add-dir');
  });

  it('sends a message verbatim when slash commands are disabled', async () => {
    // A leading /name is a slash command unless --verbatim says otherwise.
    expect(await argsFor({ disableSlashCommands: true })).toContain('--verbatim');
    mockSpawn.mockClear();
    mockProc = createMockProcess();
    mockSpawn.mockReturnValue(mockProc);
    expect(await argsFor({})).not.toContain('--verbatim');
  });

  it('trusts the project with --trust when asked', async () => {
    expect(await argsFor({ trustProject: true })).toContain('--trust');
    mockSpawn.mockClear();
    mockProc = createMockProcess();
    mockSpawn.mockReturnValue(mockProc);
    expect(await argsFor({})).not.toContain('--trust');
  });

  // grok's `--debug` takes no categories; it writes the log to
  // $GROK_HOME/debug/<session-id>.txt, or to `--debug-file`.
  it('turns debug categories into a bare --debug and passes the debug file', async () => {
    const a = await argsFor({ debug: ['api', 'mcp'], debugFile: '/tmp/grok-debug.log' });
    expect(a).toContain('--debug');
    expect(a[a.indexOf('--debug') + 1].startsWith('--')).toBe(true);
    expect(valuesOf(a, '--debug-file')).toEqual(['/tmp/grok-debug.log']);
  });
});

describe('PersistentGrokSession — streaming', () => {
  function line(obj: Record<string, unknown>) {
    mockProc.stdout.push(JSON.stringify(obj) + '\n');
  }

  // The reply used to reach callers only when the process exited.
  it('emits text as it arrives, before the turn ends', async () => {
    const s = new PersistentGrokSession({ name: 't', cwd: '/tmp', permissionMode: 'bypassPermissions' });
    await s.start();
    const pieces: string[] = [];
    const events: string[] = [];
    s.on('text', (t: string) => events.push(t));
    const p = s.send('hi', { waitForComplete: true, callbacks: { onText: (t) => pieces.push(t) } });
    await new Promise((r) => setTimeout(r, 5));
    // A line split across two chunks is joined before it is parsed.
    const first = JSON.stringify({ type: 'text', data: 'Hel' }) + '\n';
    mockProc.stdout.push(first.slice(0, 10));
    mockProc.stdout.push(first.slice(10));
    expect(pieces).toEqual(['Hel']);
    line({ type: 'text', data: 'lo' });
    expect(pieces).toEqual(['Hel', 'lo']);
    // The last line may arrive without a newline.
    mockProc.stdout.push(JSON.stringify({ type: 'end', ...OK_RESULT, text: undefined }));
    mockProc.stdout.push(null);
    mockProc.emit('close', 0);
    const r = (await p) as { text: string };
    expect(r.text).toBe('Hello');
    expect(pieces).toEqual(['Hel', 'lo']);
    expect(events).toEqual(['Hel', 'lo']);
    expect(s.getStats().turnsSucceeded).toBe(1);
  });

  // Shapes measured on 1.0.92: `tool_call` with status `pending`, then
  // `tool_call_update`s with status null, `in_progress`, and a final `completed`.
  it('reports tool calls and their results, and counts them', async () => {
    const s = new PersistentGrokSession({ name: 't', cwd: '/tmp', permissionMode: 'bypassPermissions' });
    await s.start();
    const uses: unknown[] = [];
    const results: unknown[] = [];
    const used: unknown[] = [];
    s.on('tool_use', (e: unknown) => uses.push(e));
    s.on('tool_result', (e: unknown) => results.push(e));
    const p = s.send('hi', { waitForComplete: true, callbacks: { onToolUse: (e) => used.push(e) } });
    await new Promise((r) => setTimeout(r, 5));
    const call = (id: string) => ({
      type: 'tool_call',
      toolCallId: id,
      title: 'run_terminal_command',
      kind: 'execute',
      status: 'pending',
      toolName: 'run_terminal_command',
      rawInput: { command: 'echo hi' },
    });
    line(call('c1'));
    line(call('c2'));
    expect(uses).toHaveLength(2);
    line({ type: 'tool_call_update', toolCallId: 'c1', status: null, content: [] });
    line({ type: 'tool_call_update', toolCallId: 'c1', status: 'in_progress', content: [] });
    expect(results).toHaveLength(0);
    line({ type: 'tool_call_update', toolCallId: 'c1', status: 'completed', rawOutput: { exit_code: 0 } });
    line({ type: 'tool_call_update', toolCallId: 'c2', status: 'failed', rawOutput: { error: 'denied' } });
    expect(results).toHaveLength(2);
    reply(OK_RESULT);
    await p;
    expect(used).toHaveLength(2);
    const st = s.getStats();
    expect(st.toolCalls).toBe(2);
    expect(st.toolErrors).toBe(1);
  });
});

describe('PersistentGrokSession — images', () => {
  // `-p` cannot carry images and conflicts with `--prompt-json`, whose JSON
  // sits in argv (128 KiB per argument on Linux). `--prompt-file` reads ACP
  // content blocks from a file whose name ends in `.json`, with no size cap
  // (a 28 MB file was read whole on 1.0.92).
  it('sends the message and its images as ACP content blocks from a .json prompt file', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-img-test-'));
    const png = path.join(dir, 'a.png');
    const jpg = path.join(dir, 'b.JPG');
    fs.writeFileSync(png, Buffer.from('png-bytes'));
    fs.writeFileSync(jpg, Buffer.from('jpg-bytes'));
    try {
      const s = new PersistentGrokSession({ name: 't', cwd: '/tmp', permissionMode: 'bypassPermissions' });
      await s.start();
      let prompt: unknown;
      let promptFile = '';
      mockSpawn.mockImplementation((_bin: string, args: string[]) => {
        promptFile = args[args.indexOf('--prompt-file') + 1];
        prompt = JSON.parse(fs.readFileSync(promptFile, 'utf8'));
        return mockProc;
      });
      const p = s.send('- what is shown?', { waitForComplete: true, images: [png, jpg] });
      setTimeout(() => reply(OK_RESULT), 5);
      await p;
      const a = spawnArgs();
      expect(a).not.toContain('-p');
      expect(promptFile.endsWith('.json')).toBe(true);
      expect(prompt).toEqual([
        { type: 'text', text: '- what is shown?' },
        { type: 'image', mimeType: 'image/png', data: Buffer.from('png-bytes').toString('base64') },
        { type: 'image', mimeType: 'image/jpeg', data: Buffer.from('jpg-bytes').toString('base64') },
      ]);
      expect(mockProc.stdin.end).toHaveBeenCalledWith();
      // The prompt file holds the images; it does not outlive the turn.
      expect(fs.existsSync(promptFile)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('removes the prompt file when the turn times out', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-img-test-'));
    const png = path.join(dir, 'a.png');
    fs.writeFileSync(png, Buffer.from('png-bytes'));
    try {
      const s = new PersistentGrokSession({ name: 't', cwd: '/tmp', permissionMode: 'bypassPermissions' });
      await s.start();
      await expect(s.send('hi', { waitForComplete: true, images: [png], timeout: 10 })).rejects.toThrow(/Timeout/);
      const a = spawnArgs();
      expect(fs.existsSync(a[a.indexOf('--prompt-file') + 1])).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('PersistentGrokSession — worktree', () => {
  const WT = '/home/u/.grok/worktrees/repo/feat';

  // `--worktree NAME` would take the next word as its name, so the equals form.
  // grok reports the folder the session ran in as the `end` event's `cwd`, and a
  // resumed turn runs there; `--worktree` again would make a second worktree.
  it('creates the worktree on the first turn and resumes inside it afterwards', async () => {
    const s = new PersistentGrokSession({
      name: 't',
      cwd: '/tmp',
      permissionMode: 'bypassPermissions',
      worktree: 'feat',
    });
    await s.start();
    const p1 = s.send('one', { waitForComplete: true });
    setTimeout(() => reply({ ...OK_RESULT, cwd: WT }), 5);
    await p1;
    const a1 = spawnArgs();
    expect(a1).toContain('--worktree=feat');
    expect(valuesOf(a1, '--cwd')).toEqual(['/tmp']);
    expect(s.getStats().grokWorktreePath).toBe(WT);

    mockProc = createMockProcess();
    mockSpawn.mockReturnValue(mockProc);
    const p2 = s.send('two', { waitForComplete: true });
    setTimeout(() => reply({ ...OK_RESULT, cwd: WT }), 5);
    await p2;
    const a2 = mockSpawn.mock.calls[1][1] as string[];
    expect(a2.some((x) => x.startsWith('--worktree'))).toBe(false);
    expect(valuesOf(a2, '--resume')).toEqual([OK_RESULT.sessionId]);
    expect(valuesOf(a2, '--cwd')).toEqual([WT]);
  });

  it('lets grok name the worktree when worktree is true', async () => {
    const a = await argsFor({ worktree: true }, { ...OK_RESULT, cwd: WT });
    expect(a).toContain('--worktree');
    expect(a[a.indexOf('--worktree') + 1].startsWith('--')).toBe(true);
  });

  it('does not move a session without a worktree to the cwd grok reports', async () => {
    const s = new PersistentGrokSession({ name: 't', cwd: '/tmp', permissionMode: 'bypassPermissions' });
    await s.start();
    const p1 = s.send('one', { waitForComplete: true });
    setTimeout(() => reply({ ...OK_RESULT, cwd: '/elsewhere' }), 5);
    await p1;
    mockProc = createMockProcess();
    mockSpawn.mockReturnValue(mockProc);
    const p2 = s.send('two', { waitForComplete: true });
    setTimeout(() => reply(OK_RESULT), 5);
    await p2;
    expect(valuesOf(mockSpawn.mock.calls[1][1] as string[], '--cwd')).toEqual(['/tmp']);
  });
});
