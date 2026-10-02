import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { withFileLock } from '../kernel/file-lock.js';
import type { AutoloopState } from './types.js';
import { inspectDeliveryOutbox } from './outbox.js';

export type AutoloopRecoveryPhase = 'PLANNER_BOUNDARY' | 'LIVE' | 'COMPLETED' | 'BLOCKED';
export type AutoloopRecoveryAction = 'resume_planner' | 'none' | 'manual_resolution';

export interface AutoloopRecoveryLeaseEvidence {
  incarnationId: string;
  ownerId: string;
  acquisitionId: string;
  fence: number;
  pid: number;
  host: string;
  acquiredAt: string;
  renewedAt: string;
}

export interface AutoloopRecoveryInspectionInput {
  runId: string;
  ledgerDir: string;
  runState: string;
  state: Pick<AutoloopState, 'status' | 'iter' | 'subagents_spawned' | 'status_reason' | 'pending_dispatch'>;
  liveInProcess: boolean;
  lease: AutoloopRecoveryLeaseEvidence | null;
  leaseStale: boolean;
  restartReady?: boolean;
}

export interface AutoloopRecoveryAssessment {
  schema_version: 1;
  run_id: string;
  phase: AutoloopRecoveryPhase;
  evidence: string[];
  next_safe_action: AutoloopRecoveryAction;
  evidence_sha256: string;
  action_sha256: string;
  action: { type: 'resume_planner'; run_id: string; iter: number };
  recovery_token: string;
}

export interface AutoloopRecoveryReceipt {
  schema_version: 1;
  record_type: 'autoloop_recovery_receipt';
  run_id: string;
  recovery_token: string;
  evidence_sha256: string;
  action_sha256: string;
  action: { type: 'resume_planner'; run_id: string; iter: number };
  claim_id: string;
  status: 'prepared' | 'applied';
  recorded_at: string;
}

export interface AutoloopRecoveryResult {
  assessment: AutoloopRecoveryAssessment;
  receipt?: AutoloopRecoveryReceipt;
}

export type AutoloopRecoveryErrorCode =
  | 'AUTOLOOP_RECOVERY_TOKEN_REQUIRED'
  | 'AUTOLOOP_RECOVERY_TOKEN_STALE'
  | 'AUTOLOOP_RECOVERY_MANUAL_RESOLUTION_REQUIRED'
  | 'AUTOLOOP_RECOVERY_INCOMPLETE'
  | 'AUTOLOOP_RECOVERY_LOCK_CONTENDED';

export class AutoloopRecoveryError extends Error {
  constructor(
    readonly code: AutoloopRecoveryErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'AutoloopRecoveryError';
  }
}

interface RecoveryReceiptGraph {
  rows: AutoloopRecoveryReceipt[];
  unresolved?: AutoloopRecoveryReceipt;
}

function fail(code: AutoloopRecoveryErrorCode, message: string, options?: ErrorOptions): never {
  throw new AutoloopRecoveryError(code, message, options);
}

function canonicalJson(value: unknown): string {
  const ancestors = new Set<object>();
  const encode = (candidate: unknown): string => {
    if (candidate === null || typeof candidate === 'string' || typeof candidate === 'boolean') {
      return JSON.stringify(candidate);
    }
    if (typeof candidate === 'number') {
      if (!Number.isFinite(candidate)) return fail('AUTOLOOP_RECOVERY_INCOMPLETE', 'Recovery evidence is not finite');
      return JSON.stringify(candidate);
    }
    if (typeof candidate !== 'object') {
      return fail('AUTOLOOP_RECOVERY_INCOMPLETE', 'Recovery evidence is not JSON-serializable');
    }
    if (ancestors.has(candidate)) return fail('AUTOLOOP_RECOVERY_INCOMPLETE', 'Recovery evidence contains a cycle');
    ancestors.add(candidate);
    try {
      if (Array.isArray(candidate)) return `[${candidate.map(encode).join(',')}]`;
      const prototype = Object.getPrototypeOf(candidate);
      if (prototype !== Object.prototype && prototype !== null) {
        return fail('AUTOLOOP_RECOVERY_INCOMPLETE', 'Recovery evidence must use plain objects');
      }
      const record = candidate as Record<string, unknown>;
      return `{${Object.keys(record)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${encode(record[key])}`)
        .join(',')}}`;
    } finally {
      ancestors.delete(candidate);
    }
  };
  return encode(value);
}

function sha256(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function readDecisionRows(decisionsPath: string): unknown[] {
  if (!fs.existsSync(decisionsPath)) return [];
  let contents: string;
  try {
    contents = fs.readFileSync(decisionsPath, 'utf8');
  } catch (error) {
    return fail('AUTOLOOP_RECOVERY_INCOMPLETE', 'Autoloop recovery evidence could not be read', { cause: error });
  }
  if (!contents) return [];
  if (!contents.endsWith('\n')) {
    return fail('AUTOLOOP_RECOVERY_INCOMPLETE', 'Autoloop recovery ledger ends with a truncated row');
  }
  return contents
    .slice(0, -1)
    .split('\n')
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line) as unknown;
      } catch (error) {
        return fail('AUTOLOOP_RECOVERY_INCOMPLETE', `Autoloop recovery ledger row ${index + 1} is invalid`, {
          cause: error,
        });
      }
    });
}

function hasExactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(record);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

function parseRecoveryReceipt(value: unknown): AutoloopRecoveryReceipt | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.record_type !== 'autoloop_recovery_receipt') return undefined;
  const expected = [
    'schema_version',
    'record_type',
    'run_id',
    'recovery_token',
    'evidence_sha256',
    'action_sha256',
    'action',
    'claim_id',
    'status',
    'recorded_at',
  ];
  const action = record.action as Record<string, unknown> | undefined;
  if (
    !hasExactKeys(record, expected) ||
    record.schema_version !== 1 ||
    typeof record.run_id !== 'string' ||
    !record.run_id ||
    typeof record.recovery_token !== 'string' ||
    !/^[a-f0-9]{64}$/.test(record.recovery_token) ||
    typeof record.evidence_sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(record.evidence_sha256) ||
    typeof record.action_sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(record.action_sha256) ||
    typeof record.claim_id !== 'string' ||
    !record.claim_id ||
    (record.status !== 'prepared' && record.status !== 'applied') ||
    typeof record.recorded_at !== 'string' ||
    !Number.isFinite(Date.parse(record.recorded_at)) ||
    typeof action !== 'object' ||
    action === null ||
    Array.isArray(action) ||
    !hasExactKeys(action, ['type', 'run_id', 'iter']) ||
    action.type !== 'resume_planner' ||
    action.run_id !== record.run_id ||
    !Number.isSafeInteger(action.iter) ||
    (action.iter as number) < 0 ||
    sha256(action) !== record.action_sha256
  ) {
    return fail('AUTOLOOP_RECOVERY_INCOMPLETE', 'Autoloop recovery receipt is malformed');
  }
  return record as unknown as AutoloopRecoveryReceipt;
}

function isLegacyRecoveryReceipt(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    hasExactKeys(record, [
      'schema_version',
      'record_type',
      'kind',
      'run_id',
      'recovery_token',
      'action_sha256',
      'action_snapshot',
      'claim_id',
      'phase',
      'next_safe_action',
      'status',
      'recorded_at',
    ]) &&
    record.schema_version === 1 &&
    record.record_type === 'autoloop_recovery_receipt' &&
    record.kind === 'autoloop_recovery_receipt' &&
    typeof record.run_id === 'string' &&
    Boolean(record.run_id) &&
    typeof record.recovery_token === 'string' &&
    /^[a-f0-9]{64}$/.test(record.recovery_token) &&
    typeof record.action_sha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(record.action_sha256) &&
    typeof record.action_snapshot === 'object' &&
    record.action_snapshot !== null &&
    !Array.isArray(record.action_snapshot) &&
    typeof record.claim_id === 'string' &&
    Boolean(record.claim_id) &&
    typeof record.phase === 'string' &&
    typeof record.next_safe_action === 'string' &&
    (record.status === 'prepared' || record.status === 'applied') &&
    typeof record.recorded_at === 'string' &&
    Number.isFinite(Date.parse(record.recorded_at))
  );
}

function receiptGraph(rows: readonly unknown[], runId: string): RecoveryReceiptGraph {
  const receipts = rows.flatMap((row) => {
    if (isLegacyRecoveryReceipt(row)) return [];
    const receipt = parseRecoveryReceipt(row);
    return receipt ? [receipt] : [];
  });
  if (receipts.some((receipt) => receipt.run_id !== runId)) {
    return fail('AUTOLOOP_RECOVERY_INCOMPLETE', 'Autoloop recovery receipt belongs to another run');
  }
  const byClaim = new Map<string, AutoloopRecoveryReceipt[]>();
  for (const receipt of receipts) {
    const claim = byClaim.get(receipt.claim_id) ?? [];
    claim.push(receipt);
    byClaim.set(receipt.claim_id, claim);
  }
  let unresolved: AutoloopRecoveryReceipt | undefined;
  for (const claim of byClaim.values()) {
    const prepared = claim.filter((receipt) => receipt.status === 'prepared');
    const applied = claim.filter((receipt) => receipt.status === 'applied');
    if (
      prepared.length !== 1 ||
      applied.length > 1 ||
      (applied[0] &&
        (applied[0].recovery_token !== prepared[0].recovery_token ||
          applied[0].evidence_sha256 !== prepared[0].evidence_sha256 ||
          applied[0].action_sha256 !== prepared[0].action_sha256 ||
          canonicalJson(applied[0].action) !== canonicalJson(prepared[0].action)))
    ) {
      return fail('AUTOLOOP_RECOVERY_INCOMPLETE', 'Autoloop recovery receipt graph is invalid');
    }
    if (!applied[0]) {
      if (unresolved) return fail('AUTOLOOP_RECOVERY_INCOMPLETE', 'Multiple recovery effects are unresolved');
      unresolved = prepared[0];
    }
  }
  return { rows: receipts, unresolved };
}

function isLegacyDeliveryEvidence(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    row.schema_version === 1 &&
    row.record_type === undefined &&
    typeof row.delivery_id === 'string' &&
    typeof row.payload_sha256 === 'string' &&
    (typeof row.idempotency_key === 'string' || typeof row.acknowledged_at === 'string')
  );
}

function hasUnresolvedLegacyTimeoutEvidence(rows: readonly unknown[]): boolean {
  const pendingDispatches = new Set<string>();
  for (const value of rows) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue;
    const row = value as Record<string, unknown>;
    if (row.kind === 'send_timeout') {
      const payload = row.payload as Record<string, unknown> | undefined;
      if (
        typeof payload !== 'object' ||
        payload === null ||
        Array.isArray(payload) ||
        typeof payload.dispatch_id !== 'string' ||
        !payload.dispatch_id
      ) {
        return true;
      }
      pendingDispatches.add(payload.dispatch_id);
      continue;
    }
    if (row.kind === 'timeout_migration' && typeof row.pendingDispatchId === 'string') {
      pendingDispatches.delete(row.pendingDispatchId);
      continue;
    }
    if (row.kind === 'terminate') pendingDispatches.clear();
  }
  return pendingDispatches.size > 0;
}

function appendReceipt(decisionsPath: string, receipt: AutoloopRecoveryReceipt): void {
  const parent = path.dirname(decisionsPath);
  const existed = fs.existsSync(decisionsPath);
  const fd = fs.openSync(decisionsPath, 'a');
  try {
    const bytes = Buffer.from(`${JSON.stringify(receipt)}\n`, 'utf8');
    let offset = 0;
    while (offset < bytes.byteLength) {
      const written = fs.writeSync(fd, bytes, offset, bytes.byteLength - offset, null);
      if (written <= 0) return fail('AUTOLOOP_RECOVERY_INCOMPLETE', 'Recovery receipt append made no progress');
      offset += written;
    }
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  if (!existed) {
    const directoryFd = fs.openSync(parent, 'r');
    try {
      fs.fsyncSync(directoryFd);
    } finally {
      fs.closeSync(directoryFd);
    }
  }
}

function actionFor(input: AutoloopRecoveryInspectionInput): AutoloopRecoveryReceipt['action'] {
  return { type: 'resume_planner', run_id: input.runId, iter: input.state.iter };
}

export function inspectAutoloopRecovery(input: AutoloopRecoveryInspectionInput): AutoloopRecoveryAssessment {
  let directory: fs.Stats;
  try {
    directory = fs.statSync(input.ledgerDir);
  } catch (error) {
    return fail('AUTOLOOP_RECOVERY_INCOMPLETE', `Autoloop ledger for '${input.runId}' is unavailable`, {
      cause: error,
    });
  }
  if (!directory.isDirectory()) {
    return fail('AUTOLOOP_RECOVERY_INCOMPLETE', `Autoloop ledger for '${input.runId}' is not a directory`);
  }
  const decisionsPath = path.join(input.ledgerDir, 'decisions.jsonl');
  const rows = readDecisionRows(decisionsPath);
  const receipts = receiptGraph(rows, input.runId);
  const outbox = inspectDeliveryOutbox(decisionsPath);
  const acknowledged = new Set(outbox.acknowledgements.map((row) => row.delivery_id));
  const pendingDeliveries = outbox.intents.filter((row) => !acknowledged.has(row.delivery_id));
  const legacyDelivery = rows.some(isLegacyDeliveryEvidence);
  const legacyRecovery = rows.some(isLegacyRecoveryReceipt);
  const legacyTimeout = hasUnresolvedLegacyTimeoutEvidence(rows);

  const evidence: string[] = [];
  evidence.push(input.lease ? `kernel:lease:${input.leaseStale ? 'stale' : 'live'}` : 'kernel:lease:none');
  if (input.liveInProcess) evidence.push('runtime:live_in_process');
  if (input.restartReady === false) evidence.push('runtime:restart_config_unavailable');
  if (receipts.unresolved) evidence.push('recovery:prepared_unresolved');
  if (pendingDeliveries.length > 0) evidence.push('outbox:pending:delivery');
  if (outbox.intents.length > 0 && pendingDeliveries.length === 0) evidence.push('outbox:acknowledged:delivery');
  if (legacyDelivery) evidence.push('legacy:delivery_evidence');
  if (legacyRecovery) evidence.push('legacy:recovery_receipt');
  if (legacyTimeout || input.state.pending_dispatch) evidence.push('legacy:timeout_evidence');
  if (input.state.subagents_spawned) evidence.push('state:subagents_spawned');

  let phase: AutoloopRecoveryPhase;
  let nextSafeAction: AutoloopRecoveryAction;
  if (receipts.unresolved) {
    phase = 'BLOCKED';
    nextSafeAction = 'manual_resolution';
  } else if (input.liveInProcess) {
    phase = 'LIVE';
    nextSafeAction = 'none';
  } else if (input.state.status_reason === 'completed') {
    phase = 'COMPLETED';
    nextSafeAction = 'none';
  } else if (
    (input.lease !== null && !input.leaseStale) ||
    input.restartReady === false ||
    outbox.intents.length > 0 ||
    legacyDelivery ||
    legacyRecovery ||
    legacyTimeout ||
    input.state.pending_dispatch != null ||
    input.state.subagents_spawned
  ) {
    phase = 'BLOCKED';
    nextSafeAction = 'manual_resolution';
  } else {
    phase = 'PLANNER_BOUNDARY';
    nextSafeAction = 'resume_planner';
  }

  const sortedEvidence = [...new Set(evidence)].sort();
  const decisionsBytes = fs.existsSync(decisionsPath) ? fs.readFileSync(decisionsPath) : Buffer.alloc(0);
  const evidenceSnapshot = {
    run_id: input.runId,
    ledger_identity: { dev: directory.dev, ino: directory.ino },
    run_state: input.runState,
    state: input.state,
    live_in_process: input.liveInProcess,
    lease: input.lease,
    lease_stale: input.leaseStale,
    restart_ready: input.restartReady !== false,
    decisions_sha256: createHash('sha256').update(decisionsBytes).digest('hex'),
  };
  const evidenceSha256 = sha256(evidenceSnapshot);
  const action = actionFor(input);
  const actionSha256 = sha256(action);
  const withoutToken = {
    schema_version: 1 as const,
    run_id: input.runId,
    phase,
    evidence: sortedEvidence,
    next_safe_action: nextSafeAction,
    evidence_sha256: evidenceSha256,
    action_sha256: actionSha256,
    action,
  };
  return { ...withoutToken, recovery_token: sha256(withoutToken) };
}

export async function applyAutoloopRecovery(options: {
  ledgerDir: string;
  recoveryToken: string;
  inspect: () => AutoloopRecoveryAssessment;
  effect: (action: AutoloopRecoveryReceipt['action']) => Promise<void>;
  now?: () => Date;
  claimId?: () => string;
}): Promise<AutoloopRecoveryResult> {
  const inspected = options.inspect();
  const decisionsPath = path.join(options.ledgerDir, 'decisions.jsonl');
  const currentRows = readDecisionRows(decisionsPath);
  const currentReceipts = receiptGraph(currentRows, inspected.run_id);
  const alreadyApplied = currentReceipts.rows.find(
    (receipt) => receipt.recovery_token === options.recoveryToken && receipt.status === 'applied',
  );
  if (alreadyApplied) return { assessment: inspected, receipt: alreadyApplied };
  if (currentReceipts.unresolved) {
    return fail(
      'AUTOLOOP_RECOVERY_INCOMPLETE',
      `Autoloop run '${inspected.run_id}' has an unresolved prepared receipt`,
    );
  }
  if (options.recoveryToken !== inspected.recovery_token) {
    return fail('AUTOLOOP_RECOVERY_TOKEN_STALE', `recovery_token is stale for Autoloop run '${inspected.run_id}'`);
  }
  if (inspected.next_safe_action === 'none') return { assessment: inspected };
  if (inspected.next_safe_action !== 'resume_planner') {
    return fail(
      'AUTOLOOP_RECOVERY_MANUAL_RESOLUTION_REQUIRED',
      `Autoloop run '${inspected.run_id}' has ambiguous recovery evidence`,
    );
  }
  const action = inspected.action;
  if (sha256(action) !== inspected.action_sha256) {
    return fail('AUTOLOOP_RECOVERY_TOKEN_STALE', `Recovery action changed for Autoloop run '${inspected.run_id}'`);
  }
  const prepared: AutoloopRecoveryReceipt = {
    schema_version: 1,
    record_type: 'autoloop_recovery_receipt',
    run_id: inspected.run_id,
    recovery_token: inspected.recovery_token,
    evidence_sha256: inspected.evidence_sha256,
    action_sha256: inspected.action_sha256,
    action,
    claim_id: (options.claimId ?? randomUUID)(),
    status: 'prepared',
    recorded_at: (options.now ?? (() => new Date()))().toISOString(),
  };
  const claimed = withFileLock(
    path.join(options.ledgerDir, '.autoloop-recovery.lock'),
    () => {
      const deliveryLocked = withFileLock(
        path.join(options.ledgerDir, '.delivery-outbox.lock'),
        () => {
          const latest = options.inspect();
          const latestGraph = receiptGraph(readDecisionRows(decisionsPath), inspected.run_id);
          if (latestGraph.unresolved) {
            return fail(
              'AUTOLOOP_RECOVERY_INCOMPLETE',
              `Autoloop run '${inspected.run_id}' has an unresolved prepared receipt`,
            );
          }
          if (latest.recovery_token !== options.recoveryToken || latest.next_safe_action !== 'resume_planner') {
            return fail(
              'AUTOLOOP_RECOVERY_TOKEN_STALE',
              `recovery_token is stale for Autoloop run '${inspected.run_id}'`,
            );
          }
          appendReceipt(decisionsPath, prepared);
          return prepared;
        },
        { waitMs: 500 },
      );
      if (!deliveryLocked.ok) {
        return fail('AUTOLOOP_RECOVERY_LOCK_CONTENDED', `Autoloop delivery graph is ${deliveryLocked.error}`);
      }
      return deliveryLocked.value;
    },
    { waitMs: 500 },
  );
  if (!claimed.ok) {
    return fail('AUTOLOOP_RECOVERY_LOCK_CONTENDED', `Autoloop recovery lock is ${claimed.error}`);
  }

  await options.effect(claimed.value.action);

  const applied: AutoloopRecoveryReceipt = {
    ...claimed.value,
    status: 'applied',
    recorded_at: (options.now ?? (() => new Date()))().toISOString(),
  };
  const completed = withFileLock(
    path.join(options.ledgerDir, '.autoloop-recovery.lock'),
    () => {
      const graph = receiptGraph(readDecisionRows(decisionsPath), inspected.run_id);
      const matchingPrepared = graph.rows.filter(
        (receipt) => receipt.claim_id === applied.claim_id && receipt.status === 'prepared',
      );
      const matchingApplied = graph.rows.filter(
        (receipt) => receipt.claim_id === applied.claim_id && receipt.status === 'applied',
      );
      if (matchingPrepared.length !== 1 || matchingApplied.length > 0) {
        return fail('AUTOLOOP_RECOVERY_INCOMPLETE', 'Recovery claim changed before completion');
      }
      appendReceipt(decisionsPath, applied);
      return applied;
    },
    { waitMs: 500 },
  );
  if (!completed.ok) {
    return fail('AUTOLOOP_RECOVERY_LOCK_CONTENDED', `Autoloop recovery lock is ${completed.error}`);
  }
  return { assessment: inspected, receipt: completed.value };
}
