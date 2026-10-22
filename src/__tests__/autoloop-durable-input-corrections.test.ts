/**
 * Phase B corrections-1: regressions for parent-audit findings F1–F8.
 * Each named test must fail on the pre-correction candidate and pass after.
 */

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it, expect } from 'vitest';
import {
  AutoloopInputPersistenceError,
  formatAutoloopBackgroundErrorReason,
  MAX_RECOVERY_ITEMS,
  MAX_RECOVERY_TEXT_BYTES,
  validateRecoveryField,
} from '../autoloop/recovery.js';
import { Msg, type AnyAutoloopMessage, type SendTimeoutPayload } from '../autoloop/messages.js';
import { AutoloopRunner } from '../autoloop/runner.js';
import type { AgentDispatcher, AutoloopConfig } from '../autoloop/types.js';
import { EmbeddedServer } from '../embedded-server.js';

const CORR_DIRS: string[] = [];
const CORR_RUNNERS: AutoloopRunner[] = [];

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      if (!a || typeof a === 'string') reject(new Error('no port'));
      else {
        const p = a.port;
        s.close(() => resolve(p));
      }
    });
    s.on('error', reject);
  });
}

function makeRunner(dispatcher: AgentDispatcher, overrides: Partial<AutoloopConfig> = {}): AutoloopRunner {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clawo-corr-'));
  CORR_DIRS.push(root);
  const config: AutoloopConfig = {
    run_id: 'corr-run',
    workspace: path.join(root, 'ws'),
    ledger_dir: path.join(root, 'ledger'),
    notifyUser: async () => {},
    dispatcher,
    stallCheckIntervalMs: 24 * 60 * 60 * 1000,
    ...overrides,
  };
  fs.mkdirSync(config.workspace, { recursive: true });
  fs.mkdirSync(config.ledger_dir, { recursive: true });
  const runner = new AutoloopRunner(config);
  CORR_RUNNERS.push(runner);
  return runner;
}

afterEach(() => {
  while (CORR_RUNNERS.length > 0) {
    const r = CORR_RUNNERS.pop()!;
    try {
      r.stop();
    } catch {
      /* ignore */
    }
  }
  while (CORR_DIRS.length > 0) {
    const d = CORR_DIRS.pop()!;
    fs.rmSync(d, { recursive: true, force: true });
  }
});

function timeoutPayload(dispatchId: string, messageId: string): SendTimeoutPayload {
  return {
    status: 'awaiting_resume',
    dispatch_id: dispatchId,
    agent: 'planner',
    message_id: messageId,
    message_type: 'chat',
    iter: 0,
    timeout_ms: 1000,
    error: 'send timed out',
  };
}

describe('F1 timeout is not completion', () => {
  it('F1_send_timeout_keeps_dispatched_item_and_dispatch_id', async () => {
    let committed: unknown = null;
    const dispatchId = 'dispatch_1111111111111111111111111111111111111111111111111111111111111111';
    const dispatcher: AgentDispatcher = {
      async deliver(env) {
        if (env.type !== 'chat') return [];
        return [Msg.sendTimeout(0, timeoutPayload(dispatchId, env.msg_id))];
      },
    };
    const runner = makeRunner(dispatcher, {
      persistCheckpoint: () => {
        committed = runner.getPublishRecovery();
        return true;
      },
    });
    await runner.start();
    const { message_id } = runner.acceptChat('KEEP_ME');
    await runner.deliverAccepted(message_id);
    const recovery = runner.getCommittedRecovery()!;
    expect(recovery.items).toHaveLength(1);
    expect(recovery.items[0]!.status).toBe('dispatched');
    expect(recovery.items[0]!.text).toBe('KEEP_ME');
    expect(recovery.items[0]!.dispatch_id).toBe(dispatchId);
    expect(runner.state.status).toBe('paused');
    expect(runner.state.pending_dispatch?.dispatch_id).toBe(dispatchId);
    expect(committed).toBeTruthy();
    runner.stop();
    expect(runner.getCommittedRecovery()!.items).toHaveLength(1);
    expect(runner.getCommittedRecovery()!.items[0]!.text).toBe('KEEP_ME');
  });
});

describe('F2 reconstruct timeout identity', () => {
  it('F2_restore_genuine_pending_dispatch_enables_exact_timeout_resume', async () => {
    const dispatchId = 'dispatch_2222222222222222222222222222222222222222222222222222222222222222';
    const messageId = '33333333-3333-4333-8333-333333333333';
    const ledgerId = '44444444-4444-4444-8444-444444444444';
    let allowPersist = true;
    const runner = makeRunner(
      {
        async deliver() {
          return [];
        },
      },
      { persistCheckpoint: () => allowPersist },
    );
    await runner.start();
    const pending = timeoutPayload(dispatchId, messageId);
    // Second arg: previous node state carrying genuine pending_dispatch (F2).
    (runner.applyRestoredRecovery as (raw: unknown, state?: unknown) => void)(
      {
        v: 1,
        gate: { kind: 'input_uncertain' },
        ledger_id: ledgerId,
        revision: 2,
        items: [
          {
            message_id: messageId,
            iter: 0,
            ts: '2026-10-22T00:00:00.000Z',
            accepted_at: '2026-10-22T00:00:00.000Z',
            text: 'RESTORED',
            status: 'dispatched',
            dispatch_id: dispatchId,
          },
        ],
        resolved: [],
      },
      {
        status: 'paused',
        status_reason: `awaiting_resume:send_timeout:planner:${dispatchId}`,
        pending_dispatch: pending,
      },
    );
    expect(runner.state.pending_dispatch?.dispatch_id).toBe(dispatchId);
    expect(() =>
      runner.disposeUncertainInput({
        ledgerId,
        expectedRevision: 2,
        messageIds: [messageId],
        resolution: 'abandon',
      }),
    ).toThrow(/exact timeout resume/);
    allowPersist = true;
    expect(runner.resumeTimedOutDispatch(dispatchId)).toBe(true);
    expect(runner.state.pending_dispatch).toBeNull();
    expect(runner.getCommittedRecovery()!.items).toHaveLength(0);
    expect(runner.getCommittedRecovery()!.resolved[0]!.resolution).toBe('advanced_after_timeout');
  });

  it('F2_timeout_stop_reconstruct_allows_disposition_without_pending', async () => {
    const dispatchId = 'dispatch_5555555555555555555555555555555555555555555555555555555555555555';
    const messageId = '66666666-6666-4666-8666-666666666666';
    const ledgerId = '77777777-7777-4777-8777-777777777777';
    const runner = makeRunner(
      {
        async deliver() {
          return [];
        },
      },
      { persistCheckpoint: () => true },
    );
    await runner.start();
    // Terminate-cleared pending_dispatch: historical dispatch_id remains on item.
    (runner.applyRestoredRecovery as (raw: unknown, state?: unknown) => void)(
      {
        v: 1,
        gate: { kind: 'input_uncertain' },
        ledger_id: ledgerId,
        revision: 3,
        items: [
          {
            message_id: messageId,
            iter: 0,
            ts: '2026-10-22T00:00:00.000Z',
            accepted_at: '2026-10-22T00:00:00.000Z',
            text: 'UNCERTAIN',
            status: 'dispatched',
            dispatch_id: dispatchId,
          },
        ],
        resolved: [],
      },
      {
        status: 'paused',
        status_reason: 'input_uncertain',
        pending_dispatch: null,
      },
    );
    expect(runner.state.pending_dispatch).toBeNull();
    // Must NOT invent pending_dispatch from ledger dispatch_id alone.
    expect(runner.resumeTimedOutDispatch(dispatchId)).toBe(false);
    const outcome = runner.disposeUncertainInput({
      ledgerId,
      expectedRevision: 3,
      messageIds: [messageId],
      resolution: 'abandon',
    });
    expect(outcome).toBe('applied');
    expect(runner.getCommittedRecovery()!.items).toHaveLength(0);
  });
});

describe('F3 commit before adopt or release', () => {
  it('F3_refused_gate_clear_does_not_release', async () => {
    let allow = true;
    const runner = makeRunner(
      {
        async deliver() {
          return [];
        },
      },
      { persistCheckpoint: () => allow },
    );
    await runner.start();
    runner.applyRestoredRecovery({
      v: 1,
      gate: { kind: 'operator_pause' },
      ledger_id: '88888888-8888-4888-8888-888888888888',
      revision: 1,
      items: [],
      resolved: [],
    });
    expect(runner.state.status).toBe('paused');
    allow = false;
    expect(runner.resumePaused()).toBe(false);
    expect(runner.state.status).toBe('paused');
    expect(runner.getCommittedRecovery()!.gate?.kind).toBe('operator_pause');
  });

  it('F3_refused_timeout_resolution_keeps_pending_and_item', async () => {
    const dispatchId = 'dispatch_9999999999999999999999999999999999999999999999999999999999999999';
    const messageId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    let allow = true;
    const runner = makeRunner(
      {
        async deliver() {
          return [];
        },
      },
      { persistCheckpoint: () => allow },
    );
    await runner.start();
    (runner.applyRestoredRecovery as (raw: unknown, state?: unknown) => void)(
      {
        v: 1,
        gate: null,
        ledger_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        revision: 2,
        items: [
          {
            message_id: messageId,
            iter: 0,
            ts: '2026-10-22T00:00:00.000Z',
            accepted_at: '2026-10-22T00:00:00.000Z',
            text: 'HELD',
            status: 'dispatched',
            dispatch_id: dispatchId,
          },
        ],
        resolved: [],
      },
      {
        status: 'paused',
        status_reason: `awaiting_resume:send_timeout:planner:${dispatchId}`,
        pending_dispatch: timeoutPayload(dispatchId, messageId),
      },
    );
    allow = false;
    expect(runner.resumeTimedOutDispatch(dispatchId)).toBe(false);
    expect(runner.state.pending_dispatch?.dispatch_id).toBe(dispatchId);
    expect(runner.getCommittedRecovery()!.items).toHaveLength(1);
    expect(runner.getCommittedRecovery()!.resolved).toHaveLength(0);
    expect(runner.state.status).toBe('paused');
  });

  it('F3_throwing_persist_clears_staging_keeps_committed', async () => {
    let committedRev = -1;
    const runner = makeRunner(
      {
        async deliver() {
          return [];
        },
      },
      {
        persistCheckpoint: () => {
          const staging = runner.getPublishRecovery();
          if (staging && staging.revision > 0 && committedRev >= 0) {
            throw new Error('publish boom');
          }
          committedRev = staging?.revision ?? committedRev;
          return true;
        },
      },
    );
    await runner.start();
    const { message_id } = runner.acceptChat('first');
    expect(message_id).toBeTruthy();
    expect(() => runner.acceptChat('second')).toThrow(AutoloopInputPersistenceError);
    expect(runner.getPublishRecovery()?.items).toHaveLength(1);
    expect(runner.getCommittedRecovery()!.items[0]!.text).toBe('first');
  });
});

describe('F4 typed pauses and revision fencing', () => {
  it('F4_operator_pause_advances_revision_blocking_stale_disposition', async () => {
    const runner = makeRunner(
      {
        async deliver() {
          return [];
        },
      },
      { persistCheckpoint: () => true },
    );
    await runner.start();
    const messageId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const ledgerId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    runner.applyRestoredRecovery({
      v: 1,
      gate: { kind: 'input_uncertain' },
      ledger_id: ledgerId,
      revision: 3,
      items: [
        {
          message_id: messageId,
          iter: 0,
          ts: '2026-10-22T00:00:00.000Z',
          accepted_at: '2026-10-22T00:00:00.000Z',
          text: 'X',
          status: 'dispatched',
        },
      ],
      resolved: [],
    });
    const oldRevision = runner.getCommittedRecovery()!.revision;
    await runner.send(Msg.pause(0, { reason: 'operator-hold' }));
    const newRevision = runner.getCommittedRecovery()!.revision;
    expect(newRevision).toBeGreaterThan(oldRevision);
    expect(runner.getCommittedRecovery()!.gate?.kind).toBe('operator_pause');
    expect(() =>
      runner.disposeUncertainInput({
        ledgerId,
        expectedRevision: oldRevision,
        messageIds: [messageId],
        resolution: 'abandon',
      }),
    ).toThrow(/revision mismatch/);
    expect(runner.state.status).toBe('paused');
    expect(runner.getCommittedRecovery()!.gate?.kind).toBe('operator_pause');
  });

  it('F4_markSubagentsSpawned_does_not_activate_uncertain_run', async () => {
    const runner = makeRunner(
      {
        async deliver() {
          return [];
        },
      },
      { persistCheckpoint: () => true },
    );
    await runner.start();
    runner.applyRestoredRecovery({
      v: 1,
      gate: { kind: 'input_uncertain' },
      ledger_id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      revision: 1,
      items: [
        {
          message_id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
          iter: 0,
          ts: '2026-10-22T00:00:00.000Z',
          accepted_at: '2026-10-22T00:00:00.000Z',
          text: 'held',
          status: 'dispatched',
        },
      ],
      resolved: [],
    });
    runner.markSubagentsSpawned();
    expect(runner.state.subagents_spawned).toBe(true);
    expect(runner.state.status).toBe('paused');
    expect(runner.hasUncertainItems()).toBe(true);
  });
});

describe('F5 aggregate bounds', () => {
  it('F5_refuses_second_5MiB_when_aggregate_would_exceed_8MiB', async () => {
    const runner = makeRunner(
      {
        async deliver() {
          return [];
        },
      },
      { persistCheckpoint: () => true },
    );
    await runner.start();
    await runner.send(Msg.pause(0, { reason: 'hold' }));
    const five = 'a'.repeat(5 * 1024 * 1024);
    runner.acceptChat(five);
    expect(() => runner.acceptChat(five)).toThrow(/8 MiB|bound/);
    expect(runner.getCommittedRecovery()!.items).toHaveLength(1);
  });

  it('F5_exact_1000_ok_1001_refused', async () => {
    const items = Array.from({ length: MAX_RECOVERY_ITEMS }, (_, i) => ({
      message_id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      iter: 0,
      ts: '2026-10-22T00:00:00.000Z',
      accepted_at: '2026-10-22T00:00:00.000Z',
      text: 'x',
      status: 'pending' as const,
    }));
    expect(() =>
      validateRecoveryField({
        v: 1,
        gate: null,
        ledger_id: '12121212-1212-4121-8121-121212121212',
        revision: 1,
        items,
        resolved: [],
      }),
    ).not.toThrow();
    expect(() =>
      validateRecoveryField({
        v: 1,
        gate: null,
        ledger_id: '12121212-1212-4121-8121-121212121212',
        revision: 1,
        items: [
          ...items,
          {
            message_id: '00000000-0000-4000-8000-000000001001',
            iter: 0,
            ts: '2026-10-22T00:00:00.000Z',
            accepted_at: '2026-10-22T00:00:00.000Z',
            text: 'y',
            status: 'pending',
          },
        ],
        resolved: [],
      }),
    ).toThrow(AutoloopInputPersistenceError);
  });

  it('F5_multibyte_aggregate_boundary_and_restore', () => {
    // Euro sign is 3 UTF-8 bytes; fill to exact max then +1 refuses.
    const unit = '€';
    const unitBytes = Buffer.byteLength(unit, 'utf8');
    const n = Math.floor(MAX_RECOVERY_TEXT_BYTES / unitBytes);
    const exact = unit.repeat(n);
    const over = exact + unit;
    expect(Buffer.byteLength(exact, 'utf8')).toBeLessThanOrEqual(MAX_RECOVERY_TEXT_BYTES);
    expect(Buffer.byteLength(over, 'utf8')).toBeGreaterThan(MAX_RECOVERY_TEXT_BYTES);
    expect(() =>
      validateRecoveryField({
        v: 1,
        gate: null,
        ledger_id: '13131313-1313-4131-8131-131313131313',
        revision: 0,
        items: [
          {
            message_id: '14141414-1414-4141-8141-141414141414',
            iter: 0,
            ts: '2026-10-22T00:00:00.000Z',
            accepted_at: '2026-10-22T00:00:00.000Z',
            text: over,
            status: 'pending',
          },
        ],
        resolved: [],
      }),
    ).toThrow(AutoloopInputPersistenceError);
  });
});

describe('F6 formatter allowlist', () => {
  it('F6_rejects_canary_newline_proxy_code_getter_subclass', () => {
    const forged = new Error(
      `dispatch depth exceeded 64 at iter 3 (next='QA_CANARY\nFORGED_LOG' to 'planner') — likely message ping-pong; raise config.maxDispatchDepth for legitimately deep workflows`,
    );
    const forgedOut = formatAutoloopBackgroundErrorReason(forged);
    expect(forgedOut).not.toContain('QA_CANARY');
    expect(forgedOut).not.toContain('\n');

    const proxy = new Proxy(
      {},
      {
        get() {
          throw new Error('QA_PROXY_TRAP');
        },
        getPrototypeOf() {
          throw new Error('QA_PROXY_TRAP');
        },
      },
    );
    expect(() => formatAutoloopBackgroundErrorReason(proxy)).not.toThrow();
    expect(formatAutoloopBackgroundErrorReason(proxy)).toBe('background task failed (details withheld)');

    let codeReads = 0;
    const spoof = {};
    Object.defineProperty(spoof, 'message', {
      value: 'autoloop input refused',
      enumerable: true,
    });
    Object.defineProperty(spoof, 'code', {
      get() {
        codeReads += 1;
        return 'QA_CODE_CANARY\nFORGED_LOG';
      },
      enumerable: true,
    });
    const codeOut = formatAutoloopBackgroundErrorReason(spoof);
    expect(codeReads).toBe(0);
    expect(codeOut).not.toContain('QA_CODE_CANARY');

    class Sub extends Error {}
    expect(formatAutoloopBackgroundErrorReason(new Sub('secret'))).toBe('background task failed (details withheld)');

    const depthOk = new Error(
      `dispatch depth exceeded 64 at iter 3 (next='chat' to 'planner') — likely message ping-pong; raise config.maxDispatchDepth for legitimately deep workflows`,
    );
    expect(formatAutoloopBackgroundErrorReason(depthOk)).toContain("next='chat' to 'planner'");

    expect(formatAutoloopBackgroundErrorReason(new AutoloopInputPersistenceError('commit_refused', 'x'))).toBe(
      'input persistence refused (commit_refused)',
    );
  });
});

describe('F7 exact disposition idempotency', () => {
  it('F7_exact_batch_repeat_is_noop_union_is_not', async () => {
    const runner = makeRunner(
      {
        async deliver() {
          return [];
        },
      },
      { persistCheckpoint: () => true },
    );
    await runner.start();
    const ledgerId = '15151515-1515-4151-8151-151515151515';
    const a = '16161616-1616-4161-8161-161616161616';
    const b = '17171717-1717-4171-8171-171717171717';
    const c = '18181818-1818-4181-8181-181818181818';
    const ts = '2026-10-22T00:00:00.000Z';
    runner.applyRestoredRecovery({
      v: 1,
      gate: { kind: 'input_uncertain' },
      ledger_id: ledgerId,
      revision: 1,
      items: [{ message_id: a, iter: 0, ts, accepted_at: ts, text: 'a', status: 'dispatched' }],
      resolved: [],
    });
    // Original request body — must be resent unchanged for idempotent receipt.
    const bodyA = {
      ledgerId,
      expectedRevision: 1,
      messageIds: [a],
      resolution: 'abandon' as const,
    };
    expect(runner.disposeUncertainInput({ ...bodyA })).toBe('applied');
    // Authentic original-body retry (must NOT use tombstone.revision).
    expect(runner.disposeUncertainInput({ ...bodyA })).toBe('idempotent');

    const afterA = runner.getCommittedRecovery()!;
    runner.applyRestoredRecovery({
      v: 1,
      gate: { kind: 'input_uncertain' },
      ledger_id: ledgerId,
      revision: afterA.revision,
      items: [{ message_id: b, iter: 0, ts, accepted_at: ts, text: 'b', status: 'dispatched' }],
      resolved: afterA.resolved,
    });
    const bodyB = {
      ledgerId,
      expectedRevision: runner.getCommittedRecovery()!.revision,
      messageIds: [b],
      resolution: 'abandon' as const,
    };
    expect(runner.disposeUncertainInput({ ...bodyB })).toBe('applied');
    expect(runner.disposeUncertainInput({ ...bodyB })).toBe('idempotent');

    const afterB = runner.getCommittedRecovery()!;
    runner.applyRestoredRecovery({
      v: 1,
      gate: { kind: 'input_uncertain' },
      ledger_id: ledgerId,
      revision: afterB.revision,
      items: [{ message_id: c, iter: 0, ts, accepted_at: ts, text: 'c', status: 'dispatched' }],
      resolved: afterB.resolved,
    });
    const bodyC = {
      ledgerId,
      expectedRevision: runner.getCommittedRecovery()!.revision,
      messageIds: [c],
      resolution: 'abandon' as const,
    };
    expect(runner.disposeUncertainInput({ ...bodyC })).toBe('applied');
    expect(runner.disposeUncertainInput({ ...bodyC })).toBe('idempotent');

    // Union of separate decisions never counts as one receipt.
    expect(() =>
      runner.disposeUncertainInput({
        ledgerId,
        expectedRevision: bodyA.expectedRevision,
        messageIds: [a, b, c],
        resolution: 'abandon',
      }),
    ).toThrow();
    expect(() =>
      runner.disposeUncertainInput({
        ledgerId,
        expectedRevision: 999,
        messageIds: [b],
        resolution: 'abandon',
      }),
    ).toThrow();
  });

  it('F7_idempotent_after_resume_returns_without_second_commit', async () => {
    let commits = 0;
    const runner = makeRunner(
      {
        async deliver() {
          return [];
        },
      },
      {
        persistCheckpoint: () => {
          commits += 1;
          return true;
        },
      },
    );
    await runner.start();
    const ledgerId = '19191919-1919-4191-8191-191919191919';
    const messageId = '1a1a1a1a-1a1a-41a1-81a1-1a1a1a1a1a1a';
    runner.applyRestoredRecovery({
      v: 1,
      gate: { kind: 'input_uncertain' },
      ledger_id: ledgerId,
      revision: 2,
      items: [
        {
          message_id: messageId,
          iter: 0,
          ts: '2026-10-22T00:00:00.000Z',
          accepted_at: '2026-10-22T00:00:00.000Z',
          text: 'z',
          status: 'dispatched',
        },
      ],
      resolved: [],
    });
    const originalBody = {
      ledgerId,
      expectedRevision: 2,
      messageIds: [messageId],
      resolution: 'confirm_delivered' as const,
    };
    const commitsBefore = commits;
    expect(runner.disposeUncertainInput({ ...originalBody })).toBe('applied');
    expect(commits).toBeGreaterThan(commitsBefore);
    expect(runner.resumePaused()).toBe(true);
    expect(runner.state.status).not.toBe('paused');
    const commitsAfterResume = commits;
    // Resend IDENTICAL original body — must be no-op with no second commit.
    expect(runner.disposeUncertainInput({ ...originalBody })).toBe('idempotent');
    expect(commits).toBe(commitsAfterResume);
  });
});

describe('F8 strict validation and HTTP statuses', () => {
  it('F8_validate_rejects_malformed_authority_fields', () => {
    expect(validateRecoveryField(null)).toBeNull();
    expect(validateRecoveryField(undefined)).toBeNull();
    expect(() =>
      validateRecoveryField({
        v: 1,
        gate: null,
        ledger_id: 'not-a-uuid',
        revision: 0,
        items: [],
        resolved: [],
      }),
    ).toThrow(AutoloopInputPersistenceError);
    expect(() =>
      validateRecoveryField({
        v: 1,
        gate: null,
        ledger_id: '20202020-2020-4020-8020-202020202020',
        revision: 0,
        items: [
          {
            message_id: '21212121-2121-4121-8121-212121212121',
            iter: -1,
            ts: '2026-10-22T00:00:00.000Z',
            accepted_at: '2026-10-22T00:00:00.000Z',
            text: 'x',
            status: 'pending',
          },
        ],
        resolved: [],
      }),
    ).toThrow(AutoloopInputPersistenceError);
    expect(() =>
      validateRecoveryField({
        v: 1,
        gate: null,
        ledger_id: '20202020-2020-4020-8020-202020202020',
        revision: 0,
        items: [
          {
            message_id: 'QA_CANARY\nFORGED',
            iter: 0,
            ts: '2026-10-22T00:00:00.000Z',
            accepted_at: '2026-10-22T00:00:00.000Z',
            text: 'x',
            status: 'pending',
          },
        ],
        resolved: [],
      }),
    ).toThrow(AutoloopInputPersistenceError);
    expect(() =>
      validateRecoveryField({
        v: 1,
        gate: null,
        ledger_id: '20202020-2020-4020-8020-202020202020',
        revision: 0,
        items: [
          {
            message_id: '21212121-2121-4121-8121-212121212121',
            iter: 0,
            ts: '2026-10-22T00:00:00.000Z',
            accepted_at: '2026-10-22T00:00:00.000Z',
            text: 'x',
            status: 'dispatched',
            dispatch_id: 123 as unknown as string,
          },
        ],
        resolved: [],
      }),
    ).toThrow(AutoloopInputPersistenceError);
  });

  it('F8_http_malformed_input_disposition_is_400', async () => {
    const mgr = {
      async autoloopResume() {
        throw new Error('should not reach manager');
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const server = new EmbeddedServer(mgr as any, await freePort());
    const port = await server.start();
    const token = fs.readFileSync(path.join(os.homedir(), '.openclaw', 'server-token'), 'utf-8').trim();
    const post = async (body: unknown) => {
      const res = await fetch(`http://127.0.0.1:${port}/autoloop/r1/resume`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      return { status: res.status, json: await res.json() };
    };
    try {
      expect((await post({ input_disposition: null })).status).toBe(400);
      expect((await post({ input_disposition: { ledger_id: 'x' } })).status).toBe(400);
      expect(
        (
          await post({
            input_disposition: {
              ledger_id: '20202020-2020-4020-8020-202020202020',
              expected_revision: 1.5,
              message_ids: ['21212121-2121-4121-8121-212121212121'],
              resolution: 'abandon',
            },
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await post({
            input_disposition: {
              ledger_id: '20202020-2020-4020-8020-202020202020',
              expected_revision: 1,
              message_ids: ['21212121-2121-4121-8121-212121212121'],
              resolution: 'QA_INVALID',
            },
          })
        ).status,
      ).toBe(400);
    } finally {
      await server.stop();
    }
  });
});

describe('coverage extras', () => {
  it('coverage_50_concurrent_accepted_chats_delivered_in_order', async () => {
    const delivered: string[] = [];
    const runner = makeRunner(
      {
        async deliver(env: AnyAutoloopMessage) {
          if (env.type === 'chat') delivered.push(env.payload.text);
          return [];
        },
      },
      { persistCheckpoint: () => true },
    );
    await runner.start();
    await runner.send(Msg.pause(0, { reason: 'hold' }));
    const ids: string[] = [];
    for (let i = 0; i < 50; i++) {
      const { message_id } = runner.acceptChat(`msg-${i}`);
      ids.push(message_id);
      await runner.deliverAccepted(message_id);
    }
    expect(delivered).toEqual([]);
    expect(runner.resumePaused()).toBe(true);
    const start = Date.now();
    while (delivered.length < 50 && Date.now() - start < 5000) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(delivered).toEqual(Array.from({ length: 50 }, (_, i) => `msg-${i}`));
    expect(ids).toHaveLength(50);
  });
});
