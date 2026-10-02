import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { prepareDelivery } from '../autoloop/outbox.js';
import {
  applyAutoloopRecovery,
  AutoloopRecoveryError,
  inspectAutoloopRecovery,
  type AutoloopRecoveryInspectionInput,
} from '../autoloop/recovery.js';

describe('Autoloop inspect-first recovery', () => {
  let root: string;
  let ledgerDir: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'autoloop-recovery-'));
    ledgerDir = path.join(root, 'tasks', 'recovery-run');
    fs.mkdirSync(ledgerDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function input(overrides: Partial<AutoloopRecoveryInspectionInput> = {}): AutoloopRecoveryInspectionInput {
    return {
      runId: 'recovery-run',
      ledgerDir,
      runState: 'running',
      state: {
        status: 'planning',
        iter: 0,
        subagents_spawned: false,
        status_reason: null,
        pending_dispatch: null,
      },
      liveInProcess: false,
      lease: null,
      leaseStale: true,
      ...overrides,
    };
  }

  it('inspects a cold Planner boundary without changing ledger bytes or metadata', () => {
    const decisionsPath = path.join(ledgerDir, 'decisions.jsonl');
    fs.writeFileSync(decisionsPath, `${JSON.stringify({ kind: 'start', actor: 'runner' })}\n`);
    const beforeBytes = fs.readFileSync(decisionsPath);
    const beforeStats = fs.statSync(decisionsPath);

    const assessment = inspectAutoloopRecovery(input());

    expect(assessment).toMatchObject({
      schema_version: 1,
      run_id: 'recovery-run',
      phase: 'PLANNER_BOUNDARY',
      next_safe_action: 'resume_planner',
    });
    expect(assessment.recovery_token).toMatch(/^[a-f0-9]{64}$/);
    expect(assessment.evidence_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(fs.readFileSync(decisionsPath)).toEqual(beforeBytes);
    const afterStats = fs.statSync(decisionsPath);
    expect(afterStats.size).toBe(beforeStats.size);
    expect(afterStats.mtimeMs).toBe(beforeStats.mtimeMs);
  });

  it('blocks a cold run while another kernel lease is still live', () => {
    const assessment = inspectAutoloopRecovery(
      input({
        leaseStale: false,
        lease: {
          incarnationId: 'incarnation-1',
          ownerId: 'owner-1',
          acquisitionId: 'acquisition-1',
          fence: 4,
          pid: 1234,
          host: 'other-host',
          acquiredAt: '2026-10-02T10:00:00.000Z',
          renewedAt: '2026-10-02T10:01:00.000Z',
        },
      }),
    );

    expect(assessment).toMatchObject({ phase: 'BLOCKED', next_safe_action: 'manual_resolution' });
    expect(assessment.evidence).toContain('kernel:lease:live');
  });

  it('distinguishes a resumable operator stop from durable logical completion', () => {
    const stopped = inspectAutoloopRecovery(
      input({
        runState: 'completed',
        state: { ...input().state, status: 'terminated', status_reason: 'user-stop' },
      }),
    );
    const completed = inspectAutoloopRecovery(
      input({
        runState: 'completed',
        state: { ...input().state, status: 'terminated', status_reason: 'completed' },
      }),
    );

    expect(stopped).toMatchObject({ phase: 'PLANNER_BOUNDARY', next_safe_action: 'resume_planner' });
    expect(completed).toMatchObject({ phase: 'COMPLETED', next_safe_action: 'none' });
  });

  it('blocks before claiming when the stored engine cannot be restarted without process-local config', () => {
    const assessment = inspectAutoloopRecovery(input({ restartReady: false }));

    expect(assessment).toMatchObject({ phase: 'BLOCKED', next_safe_action: 'manual_resolution' });
    expect(assessment.evidence).toContain('runtime:restart_config_unavailable');
  });

  it('changes the token when the lease fence changes', () => {
    const baseLease = {
      incarnationId: 'incarnation-1',
      ownerId: 'owner-1',
      acquisitionId: 'acquisition-1',
      fence: 4,
      pid: 1234,
      host: 'host',
      acquiredAt: '2026-10-02T10:00:00.000Z',
      renewedAt: '2026-10-02T10:01:00.000Z',
    };
    const first = inspectAutoloopRecovery(input({ lease: baseLease, leaseStale: true }));
    const second = inspectAutoloopRecovery(
      input({
        lease: { ...baseLease, acquisitionId: 'acquisition-2', fence: 5 },
        leaseStale: true,
      }),
    );

    expect(first.recovery_token).not.toBe(second.recovery_token);
  });

  it('blocks a pending durable delivery instead of guessing whether its effect happened', () => {
    prepareDelivery(path.join(ledgerDir, 'decisions.jsonl'), {
      idempotency_key: 'dispatch-1',
      kind: 'coder_directive',
      target_role: 'coder',
      target_generation: 1,
      payload: { prompt: 'do the work', logical_message_sha256: 'a'.repeat(64) },
    });

    const assessment = inspectAutoloopRecovery(
      input({ state: { ...input().state, status: 'running', subagents_spawned: true } }),
    );

    expect(assessment).toMatchObject({ phase: 'BLOCKED', next_safe_action: 'manual_resolution' });
    expect(assessment.evidence).toContain('outbox:pending:delivery');
  });

  it('reads legacy delivery evidence without rewriting or fabricating current records', () => {
    const decisionsPath = path.join(ledgerDir, 'decisions.jsonl');
    const legacy = {
      schema_version: 1,
      delivery_id: 'legacy-delivery',
      idempotency_key: 'legacy-dispatch',
      kind: 'coder_directive',
      target_role: 'coder',
      target_generation: 1,
      payload: { prompt: 'legacy work' },
      payload_sha256: 'b'.repeat(64),
      created_at: '2026-09-30T10:00:00.000Z',
    };
    fs.writeFileSync(decisionsPath, `${JSON.stringify(legacy)}\n`);
    const before = fs.readFileSync(decisionsPath);

    const assessment = inspectAutoloopRecovery(input());

    expect(assessment).toMatchObject({ phase: 'BLOCKED', next_safe_action: 'manual_resolution' });
    expect(assessment.evidence).toContain('legacy:delivery_evidence');
    expect(fs.readFileSync(decisionsPath)).toEqual(before);
  });

  it('recognizes an earlier recovery receipt read-only and requires manual resolution', () => {
    const decisionsPath = path.join(ledgerDir, 'decisions.jsonl');
    const legacyReceipt = {
      schema_version: 1,
      record_type: 'autoloop_recovery_receipt',
      kind: 'autoloop_recovery_receipt',
      run_id: 'recovery-run',
      recovery_token: 'a'.repeat(64),
      action_sha256: 'b'.repeat(64),
      action_snapshot: { type: 'resume_planner', run_id: 'recovery-run', iter: 0, phase: 'PLANNING' },
      claim_id: '11111111-1111-4111-8111-111111111111',
      phase: 'PLANNING',
      next_safe_action: 'resume_planner',
      status: 'applied',
      recorded_at: '2026-09-30T10:00:00.000Z',
    };
    fs.writeFileSync(decisionsPath, `${JSON.stringify(legacyReceipt)}\n`);
    const before = fs.readFileSync(decisionsPath);

    const assessment = inspectAutoloopRecovery(input());

    expect(assessment).toMatchObject({ phase: 'BLOCKED', next_safe_action: 'manual_resolution' });
    expect(assessment.evidence).toContain('legacy:recovery_receipt');
    expect(fs.readFileSync(decisionsPath)).toEqual(before);
  });

  it('allows a timeout whose durable migration already resolved its exact dispatch', () => {
    const decisionsPath = path.join(ledgerDir, 'decisions.jsonl');
    const rows = [
      {
        kind: 'send_timeout',
        payload: { dispatch_id: 'dispatch-planner-0' },
      },
      {
        kind: 'timeout_migration',
        pendingDispatchId: 'dispatch-planner-0',
      },
    ];
    fs.writeFileSync(decisionsPath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);

    expect(inspectAutoloopRecovery(input())).toMatchObject({
      phase: 'PLANNER_BOUNDARY',
      next_safe_action: 'resume_planner',
    });
  });

  it('blocks legacy timeout evidence whose dispatch was never resolved', () => {
    fs.writeFileSync(
      path.join(ledgerDir, 'decisions.jsonl'),
      `${JSON.stringify({ kind: 'send_timeout', payload: { dispatch_id: 'dispatch-planner-0' } })}\n`,
    );

    const assessment = inspectAutoloopRecovery(input());

    expect(assessment).toMatchObject({ phase: 'BLOCKED', next_safe_action: 'manual_resolution' });
    expect(assessment.evidence).toContain('legacy:timeout_evidence');
  });

  it('fails closed on a truncated decision ledger', () => {
    fs.writeFileSync(path.join(ledgerDir, 'decisions.jsonl'), '{"kind":"start"');

    expect(() => inspectAutoloopRecovery(input())).toThrowError(
      expect.objectContaining<Partial<AutoloopRecoveryError>>({ code: 'AUTOLOOP_RECOVERY_INCOMPLETE' }),
    );
  });

  it('invalidates an inspected token when the ledger directory is replaced', () => {
    const first = inspectAutoloopRecovery(input());
    const moved = `${ledgerDir}-old`;
    fs.renameSync(ledgerDir, moved);
    fs.mkdirSync(ledgerDir, { recursive: true });
    const second = inspectAutoloopRecovery(input());

    expect(second.recovery_token).not.toBe(first.recovery_token);
  });

  it('requires the exact current token before preparing an effect', async () => {
    const effect = vi.fn(async () => undefined);

    await expect(
      applyAutoloopRecovery({
        ledgerDir,
        recoveryToken: '0'.repeat(64),
        inspect: () => inspectAutoloopRecovery(input()),
        effect,
      }),
    ).rejects.toMatchObject({ code: 'AUTOLOOP_RECOVERY_TOKEN_STALE' });
    expect(effect).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(ledgerDir, 'decisions.jsonl'))).toBe(false);
  });

  it('does not claim recovery while the delivery graph is being mutated', async () => {
    const assessment = inspectAutoloopRecovery(input());
    const deliveryLock = path.join(ledgerDir, '.delivery-outbox.lock');
    fs.writeFileSync(deliveryLock, 'held by delivery writer');
    const effect = vi.fn(async () => undefined);

    await expect(
      applyAutoloopRecovery({
        ledgerDir,
        recoveryToken: assessment.recovery_token,
        inspect: () => inspectAutoloopRecovery(input()),
        effect,
      }),
    ).rejects.toMatchObject({ code: 'AUTOLOOP_RECOVERY_LOCK_CONTENDED' });
    expect(effect).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(ledgerDir, 'decisions.jsonl'))).toBe(false);
  });

  it('persists prepared before the effect and applied only after its proven success', async () => {
    const assessment = inspectAutoloopRecovery(input());
    const observedRows: unknown[][] = [];

    const result = await applyAutoloopRecovery({
      ledgerDir,
      recoveryToken: assessment.recovery_token,
      inspect: () => inspectAutoloopRecovery(input()),
      claimId: () => 'claim-1',
      now: (() => {
        const values = [new Date('2026-10-02T10:00:00.000Z'), new Date('2026-10-02T10:01:00.000Z')];
        return () => values.shift()!;
      })(),
      effect: async () => {
        observedRows.push(
          fs
            .readFileSync(path.join(ledgerDir, 'decisions.jsonl'), 'utf8')
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line) as unknown),
        );
      },
    });

    expect(observedRows[0]).toEqual([
      expect.objectContaining({ record_type: 'autoloop_recovery_receipt', status: 'prepared', claim_id: 'claim-1' }),
    ]);
    expect(result.receipt).toMatchObject({ status: 'applied', claim_id: 'claim-1' });
    const rows = fs
      .readFileSync(path.join(ledgerDir, 'decisions.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { status?: string });
    expect(rows.map((row) => row.status)).toEqual(['prepared', 'applied']);
  });

  it('leaves a failed effect prepared and blocks every later apply without replay', async () => {
    const assessment = inspectAutoloopRecovery(input());
    const firstEffect = vi.fn(async () => {
      throw new Error('effect outcome unknown');
    });

    await expect(
      applyAutoloopRecovery({
        ledgerDir,
        recoveryToken: assessment.recovery_token,
        inspect: () => inspectAutoloopRecovery(input()),
        claimId: () => 'claim-orphan',
        effect: firstEffect,
      }),
    ).rejects.toThrow('effect outcome unknown');

    const afterFailure = inspectAutoloopRecovery(input());
    expect(afterFailure).toMatchObject({ phase: 'BLOCKED', next_safe_action: 'manual_resolution' });
    expect(afterFailure.evidence).toContain('recovery:prepared_unresolved');

    const retryEffect = vi.fn(async () => undefined);
    await expect(
      applyAutoloopRecovery({
        ledgerDir,
        recoveryToken: afterFailure.recovery_token,
        inspect: () => inspectAutoloopRecovery(input()),
        effect: retryEffect,
      }),
    ).rejects.toMatchObject({ code: 'AUTOLOOP_RECOVERY_INCOMPLETE' });
    expect(retryEffect).not.toHaveBeenCalled();
  });

  it('allows only one concurrent claimant to reach the recovery effect', async () => {
    const assessment = inspectAutoloopRecovery(input());
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const effect = vi.fn(async () => barrier);
    const first = applyAutoloopRecovery({
      ledgerDir,
      recoveryToken: assessment.recovery_token,
      inspect: () => inspectAutoloopRecovery(input()),
      claimId: () => 'claim-first',
      effect,
    });
    await vi.waitFor(() => expect(effect).toHaveBeenCalledTimes(1));

    const second = applyAutoloopRecovery({
      ledgerDir,
      recoveryToken: inspectAutoloopRecovery(input()).recovery_token,
      inspect: () => inspectAutoloopRecovery(input()),
      claimId: () => 'claim-second',
      effect,
    });
    await expect(second).rejects.toMatchObject({ code: 'AUTOLOOP_RECOVERY_INCOMPLETE' });
    release();
    await expect(first).resolves.toMatchObject({ receipt: { status: 'applied', claim_id: 'claim-first' } });
    expect(effect).toHaveBeenCalledTimes(1);
  });
});
