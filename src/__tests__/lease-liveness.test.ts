import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';

const { leaseIsStale, acquireLease, readLease, releaseLease, createAndAcquire } = await import('../kernel/store.js');

const BOOT_ID_FILE = '/proc/sys/kernel/random/boot_id';
const hasProc = fs.existsSync(BOOT_ID_FILE) && fs.existsSync(`/proc/${process.pid}/stat`);

function bootId(): string {
  return fs.readFileSync(BOOT_ID_FILE, 'utf8').trim();
}

function startTime(pid: number): string {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
}

function lease(extra: Record<string, unknown> = {}) {
  const now = new Date().toISOString();
  return {
    runId: 'r',
    incarnationId: 'i',
    ownerId: 'o',
    acquisitionId: 'a',
    fence: 1,
    pid: process.pid,
    host: os.hostname(),
    acquiredAt: now,
    renewedAt: now,
    ...extra,
  };
}

describe.skipIf(!hasProc)('a same-host lease after a reboot or pid reuse', () => {
  beforeAll(() => {
    expect(bootId()).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('is stale when it was taken before the machine rebooted, even if its pid is alive again', () => {
    // The recorded pid is alive (it is this process), but the lease was taken
    // under another boot: after a reboot the pid can only be a reuse.
    expect(
      leaseIsStale(lease({ bootId: '00000000-0000-0000-0000-000000000000', pidStartTime: startTime(process.pid) })),
    ).toBe(true);
  });

  it('is stale when the pid is alive but now belongs to a process started at another time', () => {
    expect(leaseIsStale(lease({ bootId: bootId(), pidStartTime: '1' }))).toBe(true);
  });

  it('stays live when the boot and the process start time both match', () => {
    expect(leaseIsStale(lease({ bootId: bootId(), pidStartTime: startTime(process.pid) }))).toBe(false);
  });

  it('keeps judging a lease written before these fields existed by its pid alone', () => {
    expect(leaseIsStale(lease())).toBe(false);
  });

  it('records the boot id and the owner process start time when the lease is taken', () => {
    const guard = createAndAcquire('lease-liveness-run', { name: 'x', cwd: os.tmpdir(), nodes: [] }, 'owner-a');
    try {
      const recorded = readLease('lease-liveness-run') as unknown as Record<string, unknown>;
      expect(recorded.bootId).toBe(bootId());
      expect(recorded.pidStartTime).toBe(startTime(process.pid));
      // A renewal by the same owner keeps them current.
      acquireLease('lease-liveness-run', 'owner-a');
      const renewed = readLease('lease-liveness-run') as unknown as Record<string, unknown>;
      expect(renewed.bootId).toBe(bootId());
      expect(renewed.pidStartTime).toBe(startTime(process.pid));
    } finally {
      releaseLease(guard);
    }
  });
});
