// Stopping a session's running turn, whatever runs it: the Claude CLI (its `interrupt` control request),
// codex app-server (turn/interrupt), a one-shot engine such as agy (its process for the turn ended; the
// conversation id is kept, so the next send carries on).
import { describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { interruptRunning } from '../session-manager.js';
import { BaseOneShotSession } from '../base-oneshot-session.js';
import type { TurnResult } from '../types.js';

describe('interruptRunning', () => {
  it('a Claude CLI session: its interrupt control request', async () => {
    const s = { interruptTurn: vi.fn(() => true), interrupt: vi.fn() };
    expect(await interruptRunning(s, 'claude')).toEqual({ interrupted: true });
    expect(s.interruptTurn).toHaveBeenCalled();
    expect(s.interrupt).not.toHaveBeenCalled();
  });

  it('a codex app-server session: turn/interrupt', async () => {
    const s = { interrupt: vi.fn(async () => ({ interrupted: true })) };
    expect(await interruptRunning(s, 'codex')).toEqual({ interrupted: true });
  });

  it("a one-shot engine: the turn's process stopped", async () => {
    const s = { interruptRun: vi.fn(() => true) };
    expect(await interruptRunning(s, 'agy')).toEqual({ interrupted: true });
  });

  it('no turn running: nothing is sent, and it says nothing was interrupted', async () => {
    // the Claude CLI answers an interrupt even between turns: without this, "interrupted" was reported
    // for a session that had nothing running
    const s = { isBusy: false, interruptTurn: vi.fn(() => true) };
    expect(await interruptRunning(s, 'claude')).toEqual({ interrupted: false });
    expect(s.interruptTurn).not.toHaveBeenCalled();
  });

  it("a turn nobody is waiting on is still stopped: a goal's, an inbox delivery's", async () => {
    // codex app-server: the goal loop starts turns itself; the session knows its turn, not its sender
    const codexApp = { isBusy: false, interrupt: vi.fn(async () => ({ interrupted: true })) };
    expect(await interruptRunning(codexApp, 'codex-app')).toEqual({ interrupted: true });
    // a one-shot engine: a fire-and-forget send runs a process without marking the session busy
    const oneShot = { isBusy: false, interruptRun: vi.fn(() => true) };
    expect(await interruptRunning(oneShot, 'agy')).toEqual({ interrupted: true });
    // the Claude CLI: a turn written without waiting is still a turn
    const claude = { isBusy: false, turnRunning: true, interruptTurn: vi.fn(() => true) };
    expect(await interruptRunning(claude, 'claude')).toEqual({ interrupted: true });
    expect(claude.interruptTurn).toHaveBeenCalled();
  });

  it('nothing to stop it with: says so', async () => {
    await expect(interruptRunning({}, 'custom')).rejects.toThrow(/custom/);
  });
});

describe('BaseOneShotSession.interruptRun', () => {
  class Probe extends BaseOneShotSession {
    constructor() {
      super({ name: 'p', cwd: '/tmp' } as never, 'probe', 'probe' as never);
    }
    protected async _run(): Promise<TurnResult> {
      return { output: '' } as unknown as TurnResult;
    }
    hold(proc: ChildProcess) {
      this.currentProc = proc;
    }
  }

  it('no turn running: nothing to stop', () => {
    expect(new Probe().interruptRun()).toBe(false);
  });

  it('a turn running: its process ends', async () => {
    const p = new Probe();
    const proc = spawn('sleep', ['30'], { detached: process.platform !== 'win32' });
    p.hold(proc);
    const gone = new Promise((r) => proc.on('exit', r));
    expect(p.interruptRun()).toBe(true);
    await gone;
    expect(proc.killed || proc.exitCode !== null || proc.signalCode !== null).toBe(true);
  });
});

describe('POST /session/interrupt on a Claude CLI session', () => {
  // A CLI that takes five seconds per turn, ends a turn on an interrupt control request, and logs each interrupt.
  const FIXTURE = `
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const id = 'sess-interrupt';
const emit = (v) => process.stdout.write(JSON.stringify(v) + '\\n');
emit({ type: 'system', subtype: 'init', session_id: id });
let pending = null;
createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.type === 'control_request' && m.request && m.request.subtype === 'interrupt') {
    appendFileSync(process.env.INTERRUPT_PROBE, 'interrupt\\n');
    if (pending) {
      clearTimeout(pending);
      pending = null;
      emit({ type: 'result', subtype: 'error_during_execution', is_error: true, result: '', session_id: id });
    }
    return;
  }
  if (m.type !== 'user') return;
  pending = setTimeout(() => {
    pending = null;
    emit({ type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: id });
  }, 5000);
});
`;

  it('stops a turn nobody waits on, and sends nothing between turns', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const { SessionManager } = await import('../session-manager.js');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clawo-interrupt-'));
    const fixture = path.join(tmp, 'fake-claude.mjs');
    fs.writeFileSync(fixture, FIXTURE);
    const probe = path.join(tmp, 'probe.log');
    process.env.INTERRUPT_PROBE = probe;
    const interrupts = () => (fs.existsSync(probe) ? fs.readFileSync(probe, 'utf8').trim().split('\n').length : 0);
    const mgr = new SessionManager({ logger: { info() {}, warn() {}, error() {}, debug() {} } } as never);
    const name = 'interrupt-me';
    await mgr.startSession({ name, engine: 'claude', cwd: tmp, launcher: [process.execPath, fixture] });
    try {
      expect(await mgr.interruptSession(name)).toEqual({ interrupted: false });
      expect(interrupts()).toBe(0);

      // How a goal sends its turns: written, not waited on.
      const host = (mgr.goalSession(name) as unknown as { host: { send(t: string, o: object): Promise<unknown> } })
        .host;
      await host.send('work for a while', { waitForComplete: false });
      expect(await mgr.interruptSession(name)).toEqual({ interrupted: true });
      // The CLI reads the control request in its own time.
      for (let i = 0; i < 50 && interrupts() === 0; i++) await new Promise((r) => setTimeout(r, 50));
      expect(interrupts()).toBe(1);

      // The interrupted turn's result arrives; the session is idle again.
      for (let i = 0; i < 50 && (host as { turnRunning?: boolean }).turnRunning; i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(await mgr.interruptSession(name)).toEqual({ interrupted: false });
      expect(interrupts()).toBe(1);
    } finally {
      await mgr.stopSession(name);
      delete process.env.INTERRUPT_PROBE;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 30_000);
});
