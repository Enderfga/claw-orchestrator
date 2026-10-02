import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { withFileLock } from '../kernel/file-lock.js';
import type { AutoloopState } from './types.js';
import { canonicalPayloadSha256, inspectDeliveryOutbox } from './outbox.js';
import type { AnyAutoloopMessage, CheckpointArtifactDigests, CheckpointReviewRequestPayload } from './messages.js';

export type AutoloopRecoveryPhase = 'PLANNER_BOUNDARY' | 'REVIEWER_BOUNDARY' | 'LIVE' | 'COMPLETED' | 'BLOCKED';
export type AutoloopRecoveryAction = 'resume_planner' | 'request_review' | 'none' | 'manual_resolution';

export type RecoveryReviewEnvelope = Extract<AnyAutoloopMessage, { type: 'review_request' }>;

export type AutoloopRecoveryActionSnapshot =
  | { type: 'resume_planner'; run_id: string; iter: number }
  | {
      type: 'request_review';
      run_id: string;
      iter: number;
      source_run_id: string;
      source_iter: number;
      checkpoint_sha: string;
      target_role: 'reviewer';
      target_generation: number;
      envelope: RecoveryReviewEnvelope;
    };

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
  action: AutoloopRecoveryActionSnapshot;
  recovery_token: string;
}

export interface AutoloopRecoveryReceipt {
  schema_version: 1;
  record_type: 'autoloop_recovery_receipt';
  run_id: string;
  recovery_token: string;
  evidence_sha256: string;
  action_sha256: string;
  action: AutoloopRecoveryActionSnapshot;
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

interface RecoveryReviewEnvelopeRecord {
  schema_version: 1;
  record_type: 'autoloop_recovery_review_envelope';
  run_id: string;
  envelope: RecoveryReviewEnvelope;
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

function parseRecoveryReviewEnvelope(value: unknown): RecoveryReviewEnvelopeRecord | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.record_type !== 'autoloop_recovery_review_envelope') return undefined;
  const envelope = record.envelope as Record<string, unknown> | undefined;
  const payload = envelope?.payload as Record<string, unknown> | undefined;
  if (
    !hasExactKeys(record, ['schema_version', 'record_type', 'run_id', 'envelope']) ||
    record.schema_version !== 1 ||
    typeof record.run_id !== 'string' ||
    !record.run_id ||
    typeof envelope !== 'object' ||
    envelope === null ||
    Array.isArray(envelope) ||
    !hasExactKeys(envelope, ['msg_id', 'iter', 'from', 'to', 'type', 'ts', 'payload']) ||
    typeof envelope.msg_id !== 'string' ||
    !envelope.msg_id ||
    !Number.isSafeInteger(envelope.iter) ||
    (envelope.iter as number) < 0 ||
    envelope.from !== 'runner' ||
    envelope.to !== 'reviewer' ||
    envelope.type !== 'review_request' ||
    typeof envelope.ts !== 'string' ||
    !Number.isFinite(Date.parse(envelope.ts)) ||
    typeof payload !== 'object' ||
    payload === null ||
    Array.isArray(payload) ||
    !hasExactKeys(payload, [
      'iter',
      'ledger_path',
      'prior_metrics',
      'checkpoint_sha',
      'source_run_id',
      'source_iter',
      'scope',
      'idempotency_key',
      'artifact_sha256',
    ]) ||
    payload.iter !== envelope.iter ||
    typeof payload.ledger_path !== 'string' ||
    !Array.isArray(payload.prior_metrics) ||
    payload.prior_metrics.some((metric) => typeof metric !== 'number' || !Number.isFinite(metric)) ||
    typeof payload.checkpoint_sha !== 'string' ||
    !/^[a-f0-9]{40}$/i.test(payload.checkpoint_sha) ||
    typeof payload.source_run_id !== 'string' ||
    !payload.source_run_id ||
    !Number.isSafeInteger(payload.source_iter) ||
    (payload.source_iter as number) < 0 ||
    !Array.isArray(payload.scope) ||
    payload.scope.length === 0 ||
    payload.scope.some((entry) => typeof entry !== 'string' || !entry.trim()) ||
    typeof payload.idempotency_key !== 'string' ||
    !payload.idempotency_key.trim() ||
    typeof payload.artifact_sha256 !== 'object' ||
    payload.artifact_sha256 === null ||
    Array.isArray(payload.artifact_sha256) ||
    !hasExactKeys(payload.artifact_sha256 as Record<string, unknown>, [
      'directive.json',
      'coder_summary.txt',
      'eval_output.json',
      'diff.patch',
    ]) ||
    Object.values(payload.artifact_sha256 as Record<string, unknown>).some(
      (digest) => typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest),
    )
  ) {
    return fail('AUTOLOOP_RECOVERY_INCOMPLETE', 'Autoloop Reviewer recovery envelope is malformed');
  }
  return record as unknown as RecoveryReviewEnvelopeRecord;
}

function isRecoveryActionSnapshot(value: unknown, runId: string): value is AutoloopRecoveryActionSnapshot {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const action = value as Record<string, unknown>;
  if (
    action.type === 'resume_planner' &&
    hasExactKeys(action, ['type', 'run_id', 'iter']) &&
    action.run_id === runId &&
    Number.isSafeInteger(action.iter) &&
    (action.iter as number) >= 0
  ) {
    return true;
  }
  if (
    action.type !== 'request_review' ||
    !hasExactKeys(action, [
      'type',
      'run_id',
      'iter',
      'source_run_id',
      'source_iter',
      'checkpoint_sha',
      'target_role',
      'target_generation',
      'envelope',
    ]) ||
    action.run_id !== runId ||
    action.source_run_id !== runId ||
    !Number.isSafeInteger(action.iter) ||
    (action.iter as number) < 0 ||
    action.source_iter !== action.iter ||
    typeof action.checkpoint_sha !== 'string' ||
    !/^[a-f0-9]{40}$/.test(action.checkpoint_sha) ||
    action.target_role !== 'reviewer' ||
    !Number.isSafeInteger(action.target_generation) ||
    (action.target_generation as number) < 1
  ) {
    return false;
  }
  const parsedEnvelope = parseRecoveryReviewEnvelope({
    schema_version: 1,
    record_type: 'autoloop_recovery_review_envelope',
    run_id: runId,
    envelope: action.envelope,
  });
  if (!parsedEnvelope) return false;
  const payload = parsedEnvelope.envelope.payload as CheckpointReviewRequestPayload;
  return (
    parsedEnvelope.envelope.iter === action.iter &&
    payload.source_run_id === action.source_run_id &&
    payload.source_iter === action.source_iter &&
    payload.checkpoint_sha.toLowerCase() === action.checkpoint_sha
  );
}

const CHECKPOINT_ARTIFACT_NAMES = [
  'directive.json',
  'coder_summary.txt',
  'eval_output.json',
  'diff.patch',
] as const satisfies readonly (keyof CheckpointArtifactDigests)[];

function readSafeArtifactBytes(target: string, label: string): Buffer | undefined {
  let fd: number;
  try {
    fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    return fail('AUTOLOOP_RECOVERY_INCOMPLETE', `Autoloop ${label} cannot be opened safely`, { cause: error });
  }
  try {
    const stats = fs.fstatSync(fd);
    if (!stats.isFile() || stats.nlink !== 1) {
      return fail('AUTOLOOP_RECOVERY_INCOMPLETE', `Autoloop ${label} is not a safe file`);
    }
    return fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function snapshotRoot(ledgerDir: string): string {
  return path.join(ledgerDir, '.autoloop-recovery', 'review-artifacts');
}

function fsyncDirectory(directory: string): void {
  const fd = fs.openSync(directory, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function ensureDurableSnapshotRoot(ledgerDir: string): string {
  let parent = ledgerDir;
  for (const segment of ['.autoloop-recovery', 'review-artifacts']) {
    const directory = path.join(parent, segment);
    try {
      const stats = fs.lstatSync(directory);
      if (!stats.isDirectory() || stats.isSymbolicLink()) {
        return fail('AUTOLOOP_RECOVERY_INCOMPLETE', `Autoloop snapshot path '${directory}' is not a safe directory`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        return fail('AUTOLOOP_RECOVERY_INCOMPLETE', `Autoloop snapshot path '${directory}' cannot be read`, {
          cause: error,
        });
      }
      fs.mkdirSync(directory, { mode: 0o700 });
      fsyncDirectory(directory);
      fsyncDirectory(parent);
    }
    parent = directory;
  }
  return parent;
}

function readSnapshotBlob(ledgerDir: string, digest: string, label: string): Buffer | undefined {
  const bytes = readSafeArtifactBytes(path.join(snapshotRoot(ledgerDir), digest), label);
  if (!bytes) return undefined;
  if (createHash('sha256').update(bytes).digest('hex') !== digest) {
    return fail('AUTOLOOP_RECOVERY_INCOMPLETE', `Autoloop ${label} does not match its content address`);
  }
  return bytes;
}

function persistSnapshotBlob(ledgerDir: string, digest: string, bytes: Buffer, label: string): void {
  const root = ensureDurableSnapshotRoot(ledgerDir);
  const target = path.join(root, digest);
  const existing = readSnapshotBlob(ledgerDir, digest, label);
  if (existing) return;
  let fd: number;
  try {
    fd = fs.openSync(
      target,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      0o400,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      if (readSnapshotBlob(ledgerDir, digest, label)) return;
    }
    return fail('AUTOLOOP_RECOVERY_INCOMPLETE', `Autoloop ${label} snapshot cannot be created`, { cause: error });
  }
  try {
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fsyncDirectory(root);
}

function snapshotCheckpointArtifacts(ledgerDir: string, sourceIter: number, expected: CheckpointArtifactDigests): void {
  const iterDir = path.join(ledgerDir, 'iter', String(sourceIter));
  for (const name of CHECKPOINT_ARTIFACT_NAMES) {
    const bytes = readSafeArtifactBytes(path.join(iterDir, name), `checkpoint artifact '${name}'`);
    if (!bytes || createHash('sha256').update(bytes).digest('hex') !== expected[name]) {
      return fail(
        'AUTOLOOP_RECOVERY_INCOMPLETE',
        `Autoloop checkpoint artifact '${name}' does not match the persisted review envelope`,
      );
    }
    persistSnapshotBlob(ledgerDir, expected[name], bytes, `checkpoint artifact '${name}'`);
  }
}

function snapshotCheckpointDigests(
  ledgerDir: string,
  expected: CheckpointArtifactDigests,
): CheckpointArtifactDigests | undefined {
  const observed = {} as CheckpointArtifactDigests;
  for (const name of CHECKPOINT_ARTIFACT_NAMES) {
    const bytes = readSnapshotBlob(ledgerDir, expected[name], `checkpoint snapshot '${name}'`);
    if (!bytes) return undefined;
    observed[name] = createHash('sha256').update(bytes).digest('hex');
  }
  return observed;
}

/** Stage exactly the four content-addressed files bound to a recovery envelope. */
export function stageAutoloopRecoveryReviewSnapshot(
  ledgerDir: string,
  targetDir: string,
  expected: CheckpointArtifactDigests,
): void {
  fs.mkdirSync(targetDir, { recursive: true });
  for (const name of CHECKPOINT_ARTIFACT_NAMES) {
    const bytes = readSnapshotBlob(ledgerDir, expected[name], `checkpoint snapshot '${name}'`);
    if (!bytes) {
      return fail('AUTOLOOP_RECOVERY_INCOMPLETE', `Autoloop checkpoint snapshot '${name}' is unavailable`);
    }
    fs.writeFileSync(path.join(targetDir, name), bytes, { flag: 'wx', mode: 0o400 });
  }
}

function readSafeFileDigest(target: string, label: string): string | undefined {
  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    return fail('AUTOLOOP_RECOVERY_INCOMPLETE', `Autoloop ${label} cannot be read`, { cause: error });
  }
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) {
    return fail('AUTOLOOP_RECOVERY_INCOMPLETE', `Autoloop ${label} is not a safe file`);
  }
  return createHash('sha256').update(fs.readFileSync(target)).digest('hex');
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
  const action = record.action;
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
    !isRecoveryActionSnapshot(action, record.run_id) ||
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

function appendDecisionRow(decisionsPath: string, row: unknown): void {
  const parent = path.dirname(decisionsPath);
  const existed = fs.existsSync(decisionsPath);
  const fd = fs.openSync(decisionsPath, 'a');
  try {
    const bytes = Buffer.from(`${JSON.stringify(row)}\n`, 'utf8');
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

/**
 * Persist the exact checkpoint-bound Reviewer envelope before the Runner may
 * admit it to the in-memory queue. Repeating the same envelope is a no-op;
 * reusing its message identity for different checkpoint evidence fails closed.
 */
export function persistAutoloopRecoveryReviewEnvelope(
  ledgerDir: string,
  runId: string,
  envelope: RecoveryReviewEnvelope,
): void {
  const candidate: RecoveryReviewEnvelopeRecord = {
    schema_version: 1,
    record_type: 'autoloop_recovery_review_envelope',
    run_id: runId,
    envelope,
  };
  parseRecoveryReviewEnvelope(candidate);
  const payload = envelope.payload as CheckpointReviewRequestPayload;
  if (
    payload.source_run_id !== runId ||
    payload.source_iter !== envelope.iter ||
    path.resolve(payload.ledger_path) !== path.resolve(ledgerDir)
  ) {
    return fail(
      'AUTOLOOP_RECOVERY_INCOMPLETE',
      `Autoloop run '${runId}' Reviewer recovery envelope provenance does not match its ledger boundary`,
    );
  }
  const decisionsPath = path.join(ledgerDir, 'decisions.jsonl');
  const locked = withFileLock(
    path.join(ledgerDir, '.autoloop-recovery.lock'),
    () => {
      const matches = readDecisionRows(decisionsPath).flatMap((row) => {
        const parsed = parseRecoveryReviewEnvelope(row);
        return parsed?.envelope.msg_id === envelope.msg_id ? [parsed] : [];
      });
      if (matches.length > 1 || matches.some((row) => canonicalJson(row) !== canonicalJson(candidate))) {
        return fail(
          'AUTOLOOP_RECOVERY_INCOMPLETE',
          `Autoloop run '${runId}' has conflicting Reviewer recovery envelopes for '${envelope.msg_id}'`,
        );
      }
      if (matches.length > 0) {
        const snapshot = snapshotCheckpointDigests(ledgerDir, payload.artifact_sha256);
        if (!snapshot || canonicalJson(snapshot) !== canonicalJson(payload.artifact_sha256)) {
          return fail(
            'AUTOLOOP_RECOVERY_INCOMPLETE',
            `Autoloop run '${runId}' Reviewer recovery snapshot is incomplete`,
          );
        }
        return;
      }
      snapshotCheckpointArtifacts(ledgerDir, payload.source_iter, payload.artifact_sha256);
      appendDecisionRow(decisionsPath, candidate);
      const observed = readDecisionRows(decisionsPath).flatMap((row) => {
        const parsed = parseRecoveryReviewEnvelope(row);
        return parsed?.envelope.msg_id === envelope.msg_id ? [parsed] : [];
      });
      if (observed.length !== 1 || canonicalJson(observed[0]) !== canonicalJson(candidate)) {
        return fail(
          'AUTOLOOP_RECOVERY_INCOMPLETE',
          `Autoloop run '${runId}' Reviewer recovery envelope was not durably observed`,
        );
      }
    },
    { waitMs: 500 },
  );
  if (!locked.ok) {
    return fail('AUTOLOOP_RECOVERY_LOCK_CONTENDED', `Autoloop recovery lock is ${locked.error}`);
  }
}

function plannerActionFor(input: AutoloopRecoveryInspectionInput): AutoloopRecoveryReceipt['action'] {
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
  const reviewEnvelopeRows = rows.flatMap((row) => {
    const parsed = parseRecoveryReviewEnvelope(row);
    return parsed ? [parsed] : [];
  });
  if (reviewEnvelopeRows.some((row) => row.run_id !== input.runId)) {
    return fail('AUTOLOOP_RECOVERY_INCOMPLETE', 'Autoloop Reviewer recovery envelope belongs to another run');
  }
  const currentReviewRows = reviewEnvelopeRows.filter((row) => row.envelope.iter === input.state.iter);
  if (currentReviewRows.length > 1) {
    return fail('AUTOLOOP_RECOVERY_INCOMPLETE', 'Autoloop has multiple current Reviewer recovery envelopes');
  }
  const currentReview = currentReviewRows[0];
  const reviewPayload = currentReview?.envelope.payload as CheckpointReviewRequestPayload | undefined;
  const reviewCheckpointMatches = Boolean(
    currentReview &&
    reviewPayload &&
    reviewPayload.source_run_id === input.runId &&
    reviewPayload.source_iter === input.state.iter &&
    reviewPayload.iter === input.state.iter &&
    path.resolve(reviewPayload.ledger_path) === path.resolve(input.ledgerDir),
  );
  const checkpointFiles = reviewCheckpointMatches
    ? snapshotCheckpointDigests(input.ledgerDir, reviewPayload!.artifact_sha256)
    : undefined;
  const reviewReady = Boolean(
    currentReview &&
    reviewCheckpointMatches &&
    checkpointFiles &&
    canonicalJson(checkpointFiles) === canonicalJson(reviewPayload?.artifact_sha256),
  );
  const completedReviewReceipt = receipts.rows.find(
    (receipt) =>
      receipt.status === 'applied' &&
      receipt.action.type === 'request_review' &&
      currentReview !== undefined &&
      receipt.action.envelope.msg_id === currentReview.envelope.msg_id,
  );
  const completedReviewGeneration =
    completedReviewReceipt?.action.type === 'request_review'
      ? completedReviewReceipt.action.target_generation
      : undefined;
  const expectedReviewMessageSha256 = currentReview
    ? canonicalPayloadSha256({
        msg_id: currentReview.envelope.msg_id,
        iter: currentReview.envelope.iter,
        from: currentReview.envelope.from,
        to: currentReview.envelope.to,
        type: currentReview.envelope.type,
        payload: currentReview.envelope.payload,
      })
    : undefined;
  const completedReviewIntents =
    completedReviewGeneration !== undefined
      ? outbox.intents.filter(
          (intent) =>
            intent.kind === 'review_request' &&
            intent.target_role === 'reviewer' &&
            intent.target_generation === completedReviewGeneration &&
            (intent.payload as { logical_message_sha256?: unknown }).logical_message_sha256 ===
              expectedReviewMessageSha256,
        )
      : [];
  const completedReviewAcks = completedReviewIntents.flatMap((intent) =>
    outbox.acknowledgements.filter(
      (ack) =>
        ack.delivery_id === intent.delivery_id &&
        ack.payload_sha256 === intent.payload_sha256 &&
        ack.target_generation === intent.target_generation,
    ),
  );
  const verdictDigest = reviewPayload
    ? readSafeFileDigest(
        path.join(input.ledgerDir, 'iter', String(reviewPayload.source_iter), 'verdict.json'),
        'Reviewer verdict',
      )
    : undefined;
  const reviewComplete = Boolean(
    completedReviewReceipt && completedReviewIntents.length === 1 && completedReviewAcks.length === 1 && verdictDigest,
  );

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
  if (currentReview) evidence.push(reviewReady ? 'checkpoint:review:exact' : 'checkpoint:review:ambiguous');
  if (reviewComplete) evidence.push('checkpoint:review:completed');

  let phase: AutoloopRecoveryPhase;
  let nextSafeAction: AutoloopRecoveryAction;
  if (receipts.unresolved) {
    phase = 'BLOCKED';
    nextSafeAction = 'manual_resolution';
  } else if (reviewComplete) {
    phase = 'COMPLETED';
    nextSafeAction = 'none';
  } else if (input.liveInProcess) {
    phase = 'LIVE';
    nextSafeAction = 'none';
  } else if (input.state.status_reason === 'completed') {
    phase = 'COMPLETED';
    nextSafeAction = 'none';
  } else if (
    reviewReady &&
    (input.lease === null || input.leaseStale) &&
    input.restartReady !== false &&
    outbox.intents.length === 0 &&
    !legacyDelivery &&
    !legacyRecovery &&
    !legacyTimeout &&
    input.state.pending_dispatch == null
  ) {
    phase = 'REVIEWER_BOUNDARY';
    nextSafeAction = 'request_review';
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
    checkpoint_files: checkpointFiles ?? null,
    verdict_sha256: verdictDigest ?? null,
  };
  const evidenceSha256 = sha256(evidenceSnapshot);
  const latestReviewerGeneration = [
    ...outbox.intents.filter((row) => row.target_role === 'reviewer').map((row) => row.target_generation),
    ...outbox.rebinds.filter((row) => row.target_role === 'reviewer').map((row) => row.to_generation),
  ].reduce((latest, generation) => Math.max(latest, generation), 0);
  const action: AutoloopRecoveryActionSnapshot =
    nextSafeAction === 'request_review' && currentReview && reviewPayload
      ? {
          type: 'request_review',
          run_id: input.runId,
          iter: input.state.iter,
          source_run_id: reviewPayload.source_run_id,
          source_iter: reviewPayload.source_iter,
          checkpoint_sha: reviewPayload.checkpoint_sha.toLowerCase(),
          target_role: 'reviewer',
          target_generation: latestReviewerGeneration + 1,
          envelope: currentReview.envelope,
        }
      : reviewComplete && completedReviewReceipt?.action.type === 'request_review'
        ? completedReviewReceipt.action
        : plannerActionFor(input);
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
  if (inspected.next_safe_action !== 'resume_planner' && inspected.next_safe_action !== 'request_review') {
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
          if (
            latest.recovery_token !== options.recoveryToken ||
            latest.next_safe_action !== inspected.next_safe_action ||
            (latest.next_safe_action !== 'resume_planner' && latest.next_safe_action !== 'request_review')
          ) {
            return fail(
              'AUTOLOOP_RECOVERY_TOKEN_STALE',
              `recovery_token is stale for Autoloop run '${inspected.run_id}'`,
            );
          }
          appendDecisionRow(decisionsPath, prepared);
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
      appendDecisionRow(decisionsPath, applied);
      return applied;
    },
    { waitMs: 500 },
  );
  if (!completed.ok) {
    return fail('AUTOLOOP_RECOVERY_LOCK_CONTENDED', `Autoloop recovery lock is ${completed.error}`);
  }
  return { assessment: inspected, receipt: completed.value };
}
