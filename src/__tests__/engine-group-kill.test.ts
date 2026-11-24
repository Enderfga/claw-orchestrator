/**
 * Stopping an engine stops what it started. An engine runs in its own process
 * group off Windows, and the group gets the signal: signalling the engine alone
 * left the command it was running (a test run, a build) going after its turn
 * was stopped, still writing to the tree.
 */
import { describe, it, expect } from 'vitest';
import { killEngineTree, spawnEngine } from '../engine-spawn.js';

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe.skipIf(process.platform === 'win32')('killEngineTree', () => {
  it('ends the processes the engine started, not only the engine', async () => {
    // An "engine" that starts a long command and reports its pid.
    const script =
      "const { spawn } = require('node:child_process');" +
      "const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });" +
      'process.stdout.write(String(c.pid) + "\\n");' +
      'setInterval(() => {}, 1000);';
    const engine = spawnEngine(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'ignore'] });
    const grandchild = await new Promise<number>((resolve) => {
      engine.stdout!.once('data', (d) => resolve(Number(String(d).trim())));
    });
    expect(alive(grandchild)).toBe(true);
    killEngineTree(engine);
    for (let i = 0; i < 50 && alive(grandchild); i++) await new Promise((r) => setTimeout(r, 50));
    expect(alive(grandchild)).toBe(false);
  }, 15_000);
});
