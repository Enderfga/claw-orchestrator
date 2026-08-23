/**
 * exec() is the one child-process wrapper. Its two reasons to exist over the four
 * it replaces are a timeout that actually kills and a cap on captured output, so
 * those are what these assert.
 */

import { describe, it, expect } from 'vitest';
import { exec, execOk, lastLines, MAX_CAPTURE_BYTES } from '../../kernel/exec.js';

describe('kernel exec', () => {
  it('returns the exit code as data rather than throwing', async () => {
    const r = await exec('sh', ['-c', 'exit 3']);
    expect(r.code).toBe(3);
    expect(r.timedOut).toBe(false);
  });

  it('captures stdout and stderr separately', async () => {
    const r = await exec('sh', ['-c', 'echo out; echo err 1>&2']);
    expect(r.out.trim()).toBe('out');
    expect(r.err.trim()).toBe('err');
  });

  it('reports a spawn failure as code null with the message, not a rejection', async () => {
    const r = await exec('definitely-not-a-real-binary-xyz');
    expect(r.code).toBeNull();
    expect(r.err).not.toBe('');
  });

  it('kills a hung command at the timeout instead of hanging forever', async () => {
    const started = Date.now();
    const r = await exec('sh', ['-c', 'sleep 30'], { timeoutMs: 300 });
    expect(r.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(r.err).toContain('timed out');
  });

  it('kills the whole process group, not just the direct child', async () => {
    // The shell backgrounds a sleeper and then waits on it. Killing only the
    // shell would leave the sleeper holding the pipe and the promise pending.
    const started = Date.now();
    const r = await exec('sh', ['-c', 'sleep 30 & wait'], { timeoutMs: 300 });
    expect(r.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('keeps only the tail when a command floods stdout', async () => {
    const r = await exec(
      'sh',
      ['-c', `for i in $(seq 1 40000); do echo "0123456789012345678901234567890123456789"; done`],
      {
        maxCaptureBytes: 4096,
      },
    );
    expect(r.code).toBe(0);
    expect(r.out.length).toBeLessThanOrEqual(4096);
  });

  it('runs in the requested cwd', async () => {
    const r = await exec('pwd', [], { cwd: '/tmp' });
    expect(r.out.trim()).toContain('tmp');
  });

  it('feeds stdin when input is supplied', async () => {
    const r = await exec('cat', [], { input: 'hello-stdin' });
    expect(r.out).toBe('hello-stdin');
  });

  it('execOk collapses to a boolean', async () => {
    expect(await execOk('true')).toBe(true);
    expect(await execOk('false')).toBe(false);
  });

  it('lastLines keeps the end of the output', () => {
    expect(lastLines('a\nb\nc\nd', 2)).toBe('c\nd');
    expect(lastLines('a\nb', 5)).toBe('a\nb');
  });

  it('exposes a capture cap so the default is auditable', () => {
    expect(MAX_CAPTURE_BYTES).toBe(512 * 1024);
  });
});
