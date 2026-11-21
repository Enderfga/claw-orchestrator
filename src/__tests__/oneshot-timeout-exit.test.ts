/**
 * A one-shot turn that times out asks its engine process to stop and rejects
 * at once, but the process can keep running, and writing, after that. The
 * session reported itself idle meanwhile, the next turn started a second
 * engine beside it, and when the first one closed it cleared the session's
 * handle on the second, so `stop()` no longer reached the engine that was
 * running. These run real processes: a fake engine that ignores SIGTERM for
 * a while, like an engine finishing a write.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EngineProcessSet } from '../engine-spawn.js';
import { PersistentCodexSession } from '../persistent-codex-session.js';
import { PersistentCustomSession } from '../persistent-custom-session.js';

const posix = process.platform !== 'win32';

let dir: string;
let bin: string;
let events: string;

/** One fake engine per test. Turn n runs `lifetimesMs[n]` ms and ignores SIGTERM, logging what it sees. */
function writeEngine(lifetimesMs: number[]): void {
  writeFileSync(
    bin,
    `#!${process.execPath}\n` +
      `import { appendFileSync, readFileSync } from 'node:fs';\n` +
      `const log = ${JSON.stringify(events)};\n` +
      `process.on('SIGTERM', () => appendFileSync(log, 'term ' + process.pid + '\\n'));\n` +
      `const turn = readFileSync(log, 'utf8').split('\\n').filter((l) => l.startsWith('start ')).length;\n` +
      `const life = ${JSON.stringify(lifetimesMs)}[turn] ?? 0;\n` +
      `appendFileSync(log, 'start ' + process.pid + '\\n');\n` +
      `process.stdin.resume();\n` +
      `setTimeout(() => { appendFileSync(log, 'exit ' + process.pid + '\\n'); process.exit(0); }, life);\n`,
  );
  chmodSync(bin, 0o755);
}

function log(): string[] {
  return readFileSync(events, 'utf8').trim().split('\n').filter(Boolean);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * The first turn's timeout, and how long its engine outlives a SIGTERM. The
 * timeout has to land after the fake engine has booted and installed its
 * SIGTERM handler: under a full parallel run Node took longer than 500 ms to
 * get there, the SIGTERM killed it before it logged anything, and the second
 * engine was taken for the first.
 */
const FIRST_TURN_MS = 2_000;
const OUTLIVES_MS = 4_000;

/** The premise of these tests: the first engine was running, and held on through the SIGTERM. */
function expectFirstHeldOn(): void {
  const [start] = log();
  expect(start, 'the first engine never started').toMatch(/^start /);
  expect(log(), 'the first engine was not running when the turn timed out').toContain(`term ${start.split(' ')[1]}`);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oneshot-timeout-'));
  bin = join(dir, 'fake-engine.mjs');
  events = join(dir, 'events.log');
  writeFileSync(events, '');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe.runIf(posix)('one-shot turn timeout waits for the engine process to exit', () => {
  it('keeps the session busy and starts the next turn only after the timed-out process exits', async () => {
    writeEngine([OUTLIVES_MS, 0]);
    const session = new PersistentCodexSession({ name: 'timeout-exit', cwd: dir }, bin);
    await session.start();

    await expect(session.send('first', { waitForComplete: true, timeout: FIRST_TURN_MS })).rejects.toThrow(/Timeout/);
    expectFirstHeldOn();
    expect(session.isBusy).toBe(true);

    // Generous: under a full parallel run the fake engine's start has been seen to
    // take seconds; this measures order, not speed.
    await session.send('second', { waitForComplete: true, timeout: 20_000 }).catch(() => undefined);
    const [startA, ...rest] = log();
    const pidA = startA.split(' ')[1];
    expect(rest.indexOf(`exit ${pidA}`)).toBeGreaterThanOrEqual(0);
    const startB = rest.findIndex((line) => line.startsWith('start '));
    expect(startB).toBeGreaterThan(rest.indexOf(`exit ${pidA}`));
    expect(session.isBusy).toBe(false);
    session.stop();
  }, 30_000);

  it('stop() reaches the turn that runs after a timed-out one', async () => {
    writeEngine([OUTLIVES_MS, 3_000]);
    const session = new PersistentCodexSession({ name: 'timeout-stop', cwd: dir }, bin);
    await session.start();

    await expect(session.send('first', { waitForComplete: true, timeout: FIRST_TURN_MS })).rejects.toThrow(/Timeout/);
    expectFirstHeldOn();
    const second = session.send('second', { waitForComplete: true, timeout: 20_000 }).catch(() => undefined);
    // Wait until the second engine has started and the first has exited.
    const starts = (): string[] => log().filter((l) => l.startsWith('start '));
    const firstExited = (): boolean => log().includes(`exit ${starts()[0]?.split(' ')[1]}`);
    for (let i = 0; i < 300 && (starts().length < 2 || !firstExited()); i++) await sleep(50);
    const pidB = starts()[1]?.split(' ')[1];
    expect(pidB).toBeDefined();
    expect(firstExited()).toBe(true);

    session.stop();
    for (let i = 0; i < 40 && !log().includes(`term ${pidB}`); i++) await sleep(50);
    expect(log()).toContain(`term ${pidB}`);
    await second;
  }, 30_000);

  it('does not start a turn on a session stopped while the turn waited', async () => {
    writeEngine([OUTLIVES_MS, 0]);
    const session = new PersistentCodexSession({ name: 'timeout-stopped', cwd: dir }, bin);
    await session.start();

    await expect(session.send('first', { waitForComplete: true, timeout: FIRST_TURN_MS })).rejects.toThrow(/Timeout/);
    expectFirstHeldOn();
    const waiting = session.send('second', { waitForComplete: true, timeout: 5_000 });
    session.stop();

    await expect(waiting).rejects.toThrow(/not ready/);
    expect(log().filter((line) => line.startsWith('start '))).toHaveLength(1);
  });

  it('applies to a one-shot custom engine too', async () => {
    writeEngine([OUTLIVES_MS, 0]);
    const session = new PersistentCustomSession({
      name: 'timeout-custom',
      cwd: dir,
      customEngine: { name: 'fake', bin, persistent: false, args: {} },
    });
    await session.start();

    await expect(session.send('first', { waitForComplete: true, timeout: FIRST_TURN_MS })).rejects.toThrow(/Timeout/);
    expectFirstHeldOn();
    expect(session.isBusy).toBe(true);

    // Generous: under a full parallel run the second spawn has been seen to take
    // longer than 5 s to log its start, and this measures order, not speed.
    await session.send('second', { waitForComplete: true, timeout: 20_000 }).catch(() => undefined);
    const [startA, ...rest] = log();
    const pidA = startA.split(' ')[1];
    const startB = rest.findIndex((line) => line.startsWith('start '));
    expect(startB).toBeGreaterThan(rest.indexOf(`exit ${pidA}`));
    session.stop();
  }, 30_000);
});

describe.runIf(posix)('EngineProcessSet', () => {
  const spawned: ChildProcess[] = [];
  afterEach(() => {
    for (const child of spawned.splice(0)) child.kill('SIGKILL');
  });

  function node(code: string): ChildProcess {
    const child = spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'pipe', 'ignore'] });
    spawned.push(child);
    return child;
  }

  /** Resolves once the child has printed its first output, i.e. installed its handlers. */
  const ready = (child: ChildProcess): Promise<void> =>
    new Promise((resolve) => child.stdout!.once('data', () => resolve()));

  it('SIGKILLs a stopped process that outlives the grace period, then lets the next turn start', async () => {
    const set = new EngineProcessSet(100, 2_000);
    const child = node("process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000);");
    await ready(child);
    set.track(child);
    child.kill('SIGTERM');
    expect(set.stopping).toBe(true);

    await set.settle('fake');

    expect(child.signalCode).toBe('SIGKILL');
    expect(set.stopping).toBe(false);
  });

  it('refuses the next turn when a stopped process still has not closed after SIGKILL', async () => {
    const set = new EngineProcessSet(100, 200);
    const pidFile = join(dir, 'grandchild.pid');
    // A grandchild holds the engine's stdout open, so the engine never closes.
    const child = node(
      "const { spawn } = require('node:child_process'); const { writeFileSync } = require('node:fs');" +
        "const g = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: ['ignore', 'inherit', 'ignore'] });" +
        `writeFileSync(${JSON.stringify(pidFile)}, String(g.pid));` +
        "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);",
    );
    for (let i = 0; i < 100; i++) {
      try {
        readFileSync(pidFile, 'utf8');
        break;
      } catch {
        await sleep(20);
      }
    }
    const grandchild = Number(readFileSync(pidFile, 'utf8'));
    try {
      set.track(child);
      child.kill('SIGTERM');

      await expect(set.settle('fake')).rejects.toThrow(/has not exited; not starting another turn beside it/);
      expect(set.stopping).toBe(true);
    } finally {
      process.kill(grandchild, 'SIGKILL');
    }
  });

  it('leaves a process that was never told to stop alone', async () => {
    const set = new EngineProcessSet(100, 100);
    const child = node('setTimeout(() => {}, 1500);');
    set.track(child);

    expect(set.stopping).toBe(false);
    await set.settle('fake');

    expect(child.exitCode).toBeNull();
    expect(child.signalCode).toBeNull();
  });
});
