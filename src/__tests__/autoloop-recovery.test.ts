import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import fsDefault from 'node:fs';
import * as fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';

import { acknowledgeDelivery, canonicalPayloadSha256, prepareDelivery } from '../autoloop/outbox.js';
import {
  applyAutoloopRecovery,
  AutoloopRecoveryError,
  inspectAutoloopRecovery,
  persistAutoloopRecoveryReviewEnvelope,
  stageAutoloopRecoveryReviewSnapshot,
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

  function writeCheckpointReviewEnvelope() {
    const iterDir = path.join(ledgerDir, 'iter', '0');
    fs.mkdirSync(iterDir, { recursive: true });
    fs.writeFileSync(path.join(iterDir, 'directive.json'), '{"iter":0}\n');
    fs.writeFileSync(path.join(iterDir, 'coder_summary.txt'), 'complete\n');
    fs.writeFileSync(path.join(iterDir, 'eval_output.json'), '{"ok":true}\n');
    fs.writeFileSync(path.join(iterDir, 'diff.patch'), 'diff --git a/a b/a\n');
    const artifact_sha256 = Object.fromEntries(
      ['directive.json', 'coder_summary.txt', 'eval_output.json', 'diff.patch'].map((name) => [
        name,
        createHash('sha256')
          .update(fs.readFileSync(path.join(iterDir, name)))
          .digest('hex'),
      ]),
    ) as {
      'directive.json': string;
      'coder_summary.txt': string;
      'eval_output.json': string;
      'diff.patch': string;
    };
    const envelope = {
      msg_id: 'review-checkpoint-0',
      iter: 0,
      from: 'runner' as const,
      to: 'reviewer' as const,
      type: 'review_request' as const,
      ts: '2026-10-02T12:00:00.000Z',
      payload: {
        iter: 0,
        ledger_path: ledgerDir,
        prior_metrics: [],
        checkpoint_sha: 'a'.repeat(40),
        source_run_id: 'recovery-run',
        source_iter: 0,
        scope: ['review-only'],
        idempotency_key: 'review-checkpoint-0',
        artifact_sha256,
      },
    };
    persistAutoloopRecoveryReviewEnvelope(ledgerDir, 'recovery-run', envelope);
    return envelope;
  }

  it('persists one exact checkpoint Reviewer envelope idempotently before queue admission', () => {
    const envelope = writeCheckpointReviewEnvelope();
    fs.writeFileSync(path.join(ledgerDir, 'decisions.jsonl'), '');

    persistAutoloopRecoveryReviewEnvelope(ledgerDir, 'recovery-run', envelope);
    persistAutoloopRecoveryReviewEnvelope(ledgerDir, 'recovery-run', envelope);

    const rows = fs
      .readFileSync(path.join(ledgerDir, 'decisions.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(rows).toEqual([
      {
        schema_version: 1,
        record_type: 'autoloop_recovery_review_envelope',
        run_id: 'recovery-run',
        envelope,
      },
    ]);
  });

  it('flushes each newly created snapshot directory entry before admitting the envelope', () => {
    const envelope = writeCheckpointReviewEnvelope();
    fs.rmSync(path.join(ledgerDir, '.autoloop-recovery'), { recursive: true });
    fs.writeFileSync(path.join(ledgerDir, 'decisions.jsonl'), '');
    const originalOpenSync = fsDefault.openSync;
    const originalFsyncSync = fsDefault.fsyncSync;
    const opened = new Map<number, string>();
    const flushed: string[] = [];
    fsDefault.openSync = ((target: fs.PathLike, ...args: unknown[]) => {
      const fd = (originalOpenSync as (...values: unknown[]) => number)(target, ...args);
      opened.set(fd, path.resolve(String(target)));
      return fd;
    }) as typeof fs.openSync;
    fsDefault.fsyncSync = ((fd: number) => {
      const target = opened.get(fd);
      if (target) flushed.push(target);
      return originalFsyncSync(fd);
    }) as typeof fs.fsyncSync;
    syncBuiltinESMExports();
    try {
      persistAutoloopRecoveryReviewEnvelope(ledgerDir, 'recovery-run', envelope);
    } finally {
      fsDefault.openSync = originalOpenSync;
      fsDefault.fsyncSync = originalFsyncSync;
      syncBuiltinESMExports();
    }

    const recoveryDir = path.join(ledgerDir, '.autoloop-recovery');
    const snapshotDir = path.join(recoveryDir, 'review-artifacts');
    const recoveryIndex = flushed.indexOf(recoveryDir);
    const ledgerIndex = flushed.indexOf(ledgerDir);
    const snapshotIndex = flushed.indexOf(snapshotDir);
    const recoveryParentIndex = flushed.findIndex((target, index) => index > snapshotIndex && target === recoveryDir);
    expect(recoveryIndex).toBeGreaterThanOrEqual(0);
    expect(ledgerIndex).toBeGreaterThan(recoveryIndex);
    expect(snapshotIndex).toBeGreaterThan(ledgerIndex);
    expect(recoveryParentIndex).toBeGreaterThan(snapshotIndex);
  });

  it('rejects a conflicting checkpoint Reviewer envelope identity', () => {
    const envelope = writeCheckpointReviewEnvelope();
    fs.writeFileSync(path.join(ledgerDir, 'decisions.jsonl'), '');
    persistAutoloopRecoveryReviewEnvelope(ledgerDir, 'recovery-run', envelope);

    expect(() =>
      persistAutoloopRecoveryReviewEnvelope(ledgerDir, 'recovery-run', {
        ...envelope,
        payload: { ...envelope.payload, checkpoint_sha: 'b'.repeat(40) },
      }),
    ).toThrowError(expect.objectContaining<Partial<AutoloopRecoveryError>>({ code: 'AUTOLOOP_RECOVERY_INCOMPLETE' }));
  });

  it('rejects artifact bytes that do not match the envelope before admission', () => {
    const envelope = writeCheckpointReviewEnvelope();
    fs.writeFileSync(path.join(ledgerDir, 'decisions.jsonl'), '');

    expect(() =>
      persistAutoloopRecoveryReviewEnvelope(ledgerDir, 'recovery-run', {
        ...envelope,
        msg_id: 'review-checkpoint-mismatch',
        payload: {
          ...envelope.payload,
          idempotency_key: 'review-checkpoint-mismatch',
          artifact_sha256: { ...envelope.payload.artifact_sha256, 'diff.patch': 'f'.repeat(64) },
        },
      }),
    ).toThrowError(expect.objectContaining<Partial<AutoloopRecoveryError>>({ code: 'AUTOLOOP_RECOVERY_INCOMPLETE' }));
    expect(fs.readFileSync(path.join(ledgerDir, 'decisions.jsonl'), 'utf8')).toBe('');
  });

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

  it('derives one Reviewer-only action from an exact immutable checkpoint envelope', () => {
    const envelope = writeCheckpointReviewEnvelope();

    const assessment = inspectAutoloopRecovery(
      input({ state: { ...input().state, status: 'running', subagents_spawned: true } }),
    );

    expect(assessment).toMatchObject({
      phase: 'REVIEWER_BOUNDARY',
      next_safe_action: 'request_review',
      action: {
        type: 'request_review',
        run_id: 'recovery-run',
        iter: 0,
        source_run_id: 'recovery-run',
        source_iter: 0,
        checkpoint_sha: 'a'.repeat(40),
        target_role: 'reviewer',
        target_generation: 1,
        envelope,
      },
    });
    expect(assessment.evidence).toContain('checkpoint:review:exact');
  });

  it('reviews only the immutable snapshot when mutable iteration files change or gain extras', () => {
    const envelope = writeCheckpointReviewEnvelope();
    fs.writeFileSync(path.join(ledgerDir, 'iter', '0', 'diff.patch'), 'mutated after admission\n');
    fs.writeFileSync(path.join(ledgerDir, 'iter', '0', 'unbound.txt'), 'must not reach reviewer\n');

    const assessment = inspectAutoloopRecovery(
      input({ state: { ...input().state, status: 'running', subagents_spawned: true } }),
    );
    const staged = path.join(root, 'staged');
    stageAutoloopRecoveryReviewSnapshot(ledgerDir, staged, envelope.payload.artifact_sha256);

    expect(assessment).toMatchObject({ phase: 'REVIEWER_BOUNDARY', next_safe_action: 'request_review' });
    expect(assessment.evidence).toContain('checkpoint:review:exact');
    expect(fs.readdirSync(staged).sort()).toEqual(
      ['directive.json', 'coder_summary.txt', 'eval_output.json', 'diff.patch'].sort(),
    );
    expect(fs.readFileSync(path.join(staged, 'diff.patch'), 'utf8')).toBe('diff --git a/a b/a\n');
  });

  it('persists and applies exactly one token-fenced Reviewer action', async () => {
    const envelope = writeCheckpointReviewEnvelope();
    const recoveryInput = input({ state: { ...input().state, status: 'running', subagents_spawned: true } });
    const assessment = inspectAutoloopRecovery(recoveryInput);
    const effect = vi.fn(async () => undefined);

    const result = await applyAutoloopRecovery({
      ledgerDir,
      recoveryToken: assessment.recovery_token,
      inspect: () => inspectAutoloopRecovery(recoveryInput),
      claimId: () => 'review-claim',
      effect,
    });

    expect(effect).toHaveBeenCalledOnce();
    expect(effect).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'request_review',
        target_role: 'reviewer',
        target_generation: 1,
        envelope,
      }),
    );
    expect(result.receipt).toMatchObject({
      status: 'applied',
      claim_id: 'review-claim',
      action: { type: 'request_review', target_role: 'reviewer', target_generation: 1 },
    });
  });

  it('observes a completed Reviewer recovery and a second apply never redelivers', async () => {
    writeCheckpointReviewEnvelope();
    const recoveryInput = input({ state: { ...input().state, status: 'running', subagents_spawned: true } });
    const assessment = inspectAutoloopRecovery(recoveryInput);
    const firstEffect = vi.fn(async (action) => {
      if (action.type !== 'request_review') throw new Error('unexpected action');
      const intent = prepareDelivery(path.join(ledgerDir, 'decisions.jsonl'), {
        idempotency_key: 'recovered-review-delivery',
        kind: 'review_request',
        target_role: 'reviewer',
        target_generation: action.target_generation,
        payload: {
          prompt: 'review immutable checkpoint',
          logical_message_sha256: canonicalPayloadSha256({
            msg_id: action.envelope.msg_id,
            iter: action.envelope.iter,
            from: action.envelope.from,
            to: action.envelope.to,
            type: action.envelope.type,
            payload: action.envelope.payload,
          }),
        },
      });
      acknowledgeDelivery(
        path.join(ledgerDir, 'decisions.jsonl'),
        intent.delivery_id,
        intent.payload_sha256,
        action.target_generation,
      );
      fs.writeFileSync(
        path.join(ledgerDir, 'iter', '0', 'verdict.json'),
        `${JSON.stringify({ decision: 'advance', metric: 1, audit_notes: 'verified' })}\n`,
      );
    });
    const first = await applyAutoloopRecovery({
      ledgerDir,
      recoveryToken: assessment.recovery_token,
      inspect: () => inspectAutoloopRecovery(recoveryInput),
      claimId: () => 'review-complete-claim',
      effect: firstEffect,
    });

    const completed = inspectAutoloopRecovery(recoveryInput);
    expect(completed).toMatchObject({ phase: 'COMPLETED', next_safe_action: 'none' });
    expect(completed.evidence).toContain('checkpoint:review:completed');

    const replayEffect = vi.fn(async () => undefined);
    const replay = await applyAutoloopRecovery({
      ledgerDir,
      recoveryToken: assessment.recovery_token,
      inspect: () => inspectAutoloopRecovery(recoveryInput),
      effect: replayEffect,
    });
    expect(replay.receipt).toEqual(first.receipt);
    expect(replayEffect).not.toHaveBeenCalled();
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
