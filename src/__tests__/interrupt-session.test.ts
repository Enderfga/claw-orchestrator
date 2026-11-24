// Stopping a session's running turn, whatever runs it: the Claude CLI (its `interrupt` control request),
// codex app-server (turn/interrupt), a one-shot engine such as agy (its process for the turn ended; the
// conversation id is kept, so the next send carries on).
import { describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { interruptRunning } from '../session-manager.js';
import { BaseOneShotSession } from '../base-oneshot-session.js';

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

  it('nothing to stop it with: says so', async () => {
    await expect(interruptRunning({}, 'custom')).rejects.toThrow(/custom/);
  });
});

describe('BaseOneShotSession.interruptRun', () => {
  class Probe extends (BaseOneShotSession as any) {
    constructor() {
      super({ name: 'p', cwd: '/tmp' }, 'probe', 'probe');
    }
    protected async _run() {
      return { output: '' } as any;
    }
    hold(proc: any) {
      (this as any).currentProc = proc;
    }
  }

  it('no turn running: nothing to stop', () => {
    expect(new (Probe as any)().interruptRun()).toBe(false);
  });

  it('a turn running: its process ends', async () => {
    const p = new (Probe as any)();
    const proc = spawn('sleep', ['30'], { detached: process.platform !== 'win32' });
    p.hold(proc);
    const gone = new Promise((r) => proc.on('exit', r));
    expect(p.interruptRun()).toBe(true);
    await gone;
    expect(proc.killed || proc.exitCode !== null || proc.signalCode !== null).toBe(true);
  });
});
