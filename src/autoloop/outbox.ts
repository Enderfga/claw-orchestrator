import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { withFileLock } from '../kernel/file-lock.js';

export type DeliveryKind = 'coder_directive' | 'review_request';
export type DeliveryTargetRole = 'coder' | 'reviewer';

export interface PrepareDeliveryInput {
  idempotency_key: string;
  kind: DeliveryKind;
  target_role: DeliveryTargetRole;
  target_generation: number;
  payload: unknown;
}

export interface DeliveryIntent extends PrepareDeliveryInput {
  schema_version: 1;
  record_type: 'delivery_intent';
  delivery_id: string;
  payload_sha256: string;
  created_at: string;
}

export interface DeliveryAcknowledgement {
  schema_version: 1;
  record_type: 'delivery_acknowledgement';
  delivery_id: string;
  payload_sha256: string;
  target_generation: number;
  acknowledged_at: string;
}

export interface DeliveryGenerationRebind {
  schema_version: 1;
  record_type: 'delivery_generation_rebind';
  delivery_id: string;
  payload_sha256: string;
  target_role: DeliveryTargetRole;
  from_generation: number;
  to_generation: number;
  rebound_at: string;
}

export type DeliveryOutboxErrorCode =
  | 'AUTOLOOP_DELIVERY_INPUT_INVALID'
  | 'AUTOLOOP_DELIVERY_LEDGER_INVALID'
  | 'AUTOLOOP_DELIVERY_IDEMPOTENCY_CONFLICT'
  | 'AUTOLOOP_DELIVERY_ACKNOWLEDGEMENT_CONFLICT'
  | 'AUTOLOOP_DELIVERY_GENERATION_REBIND_CONFLICT'
  | 'AUTOLOOP_DELIVERY_OUTBOX_LOCK_CONTENDED';

export class DeliveryOutboxError extends Error {
  constructor(
    readonly code: DeliveryOutboxErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'DeliveryOutboxError';
  }
}

export interface PrepareDeliveryOptions {
  now?: () => Date;
  deliveryId?: () => string;
}

export interface AcknowledgeDeliveryOptions {
  now?: () => Date;
}

export type RebindDeliveryOptions = AcknowledgeDeliveryOptions;

function fail(code: DeliveryOutboxErrorCode, message: string, options?: ErrorOptions): never {
  throw new DeliveryOutboxError(code, message, options);
}

function canonicalJson(value: unknown): string {
  const ancestors = new Set<object>();
  const encode = (candidate: unknown): string => {
    if (candidate === null || typeof candidate === 'string' || typeof candidate === 'boolean') {
      return JSON.stringify(candidate);
    }
    if (typeof candidate === 'number') {
      if (!Number.isFinite(candidate)) {
        return fail('AUTOLOOP_DELIVERY_INPUT_INVALID', 'Delivery payload numbers must be finite');
      }
      return JSON.stringify(candidate);
    }
    if (typeof candidate !== 'object') {
      return fail('AUTOLOOP_DELIVERY_INPUT_INVALID', 'Delivery payload must contain only JSON values');
    }
    if (ancestors.has(candidate)) {
      return fail('AUTOLOOP_DELIVERY_INPUT_INVALID', 'Delivery payload must not contain cycles');
    }
    ancestors.add(candidate);
    try {
      if (Array.isArray(candidate)) return `[${candidate.map(encode).join(',')}]`;
      const prototype = Object.getPrototypeOf(candidate);
      if (prototype !== Object.prototype && prototype !== null) {
        return fail('AUTOLOOP_DELIVERY_INPUT_INVALID', 'Delivery payload objects must be plain objects');
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

export function canonicalPayloadSha256(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function validateInput(input: PrepareDeliveryInput): void {
  if (!input.idempotency_key.trim() || input.idempotency_key.trim() !== input.idempotency_key) {
    fail('AUTOLOOP_DELIVERY_INPUT_INVALID', 'Delivery idempotency_key must be a non-empty unpadded string');
  }
  if (
    (input.kind !== 'coder_directive' && input.kind !== 'review_request') ||
    (input.target_role !== 'coder' && input.target_role !== 'reviewer') ||
    (input.kind === 'coder_directive' && input.target_role !== 'coder') ||
    (input.kind === 'review_request' && input.target_role !== 'reviewer')
  ) {
    fail('AUTOLOOP_DELIVERY_INPUT_INVALID', 'Delivery kind and target role do not match');
  }
  if (!Number.isSafeInteger(input.target_generation) || input.target_generation < 1) {
    fail('AUTOLOOP_DELIVERY_INPUT_INVALID', 'Delivery target_generation must be a positive safe integer');
  }
}

function readRows(decisionsPath: string): unknown[] {
  if (!fs.existsSync(decisionsPath)) return [];
  const contents = fs.readFileSync(decisionsPath, 'utf8');
  if (!contents) return [];
  if (!contents.endsWith('\n')) {
    fail('AUTOLOOP_DELIVERY_LEDGER_INVALID', 'Autoloop decisions ledger ends with a truncated row');
  }
  return contents
    .slice(0, -1)
    .split('\n')
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line) as unknown;
      } catch (error) {
        return fail('AUTOLOOP_DELIVERY_LEDGER_INVALID', `Autoloop decisions ledger row ${index + 1} is invalid`, {
          cause: error,
        });
      }
    });
}

export interface DeliveryGraph {
  intents: DeliveryIntent[];
  acknowledgements: DeliveryAcknowledgement[];
  rebinds: DeliveryGenerationRebind[];
}

const DELIVERY_RECORD_TYPES = new Set(['delivery_intent', 'delivery_generation_rebind', 'delivery_acknowledgement']);

function hasExactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(record);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

function canonicalTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function deliveryGraph(decisionsPath: string): DeliveryGraph {
  const graph: DeliveryGraph = { intents: [], acknowledgements: [], rebinds: [] };
  const intentsById = new Map<string, DeliveryIntent>();
  const intentsByKey = new Map<string, DeliveryIntent>();
  const acknowledgementsById = new Map<string, DeliveryAcknowledgement>();
  const rebindsById = new Map<string, DeliveryGenerationRebind>();

  for (const row of readRows(decisionsPath)) {
    if (typeof row !== 'object' || row === null || Array.isArray(row)) continue;
    const record = row as Record<string, unknown>;
    if (typeof record.record_type === 'string' && DELIVERY_RECORD_TYPES.has(record.record_type)) {
      if (record.schema_version !== 1) {
        return fail(
          'AUTOLOOP_DELIVERY_LEDGER_INVALID',
          `Autoloop decisions ledger contains unsupported ${record.record_type} schema`,
        );
      }
    }
    if (record.schema_version !== 1) continue;

    if (record.record_type === 'delivery_intent') {
      if (
        !hasExactKeys(record, [
          'schema_version',
          'record_type',
          'delivery_id',
          'idempotency_key',
          'kind',
          'target_role',
          'target_generation',
          'payload',
          'payload_sha256',
          'created_at',
        ]) ||
        typeof record.delivery_id !== 'string' ||
        !record.delivery_id.trim() ||
        typeof record.idempotency_key !== 'string' ||
        !record.idempotency_key.trim() ||
        (record.kind !== 'coder_directive' && record.kind !== 'review_request') ||
        (record.target_role !== 'coder' && record.target_role !== 'reviewer') ||
        (record.kind === 'coder_directive' && record.target_role !== 'coder') ||
        (record.kind === 'review_request' && record.target_role !== 'reviewer') ||
        !Number.isSafeInteger(record.target_generation) ||
        (record.target_generation as number) < 1 ||
        typeof record.payload_sha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(record.payload_sha256) ||
        !canonicalTimestamp(record.created_at)
      ) {
        return fail(
          'AUTOLOOP_DELIVERY_LEDGER_INVALID',
          'Autoloop decisions ledger contains an invalid delivery intent',
        );
      }
      let actualDigest: string;
      try {
        actualDigest = canonicalPayloadSha256(record.payload);
      } catch (error) {
        return fail('AUTOLOOP_DELIVERY_LEDGER_INVALID', 'Autoloop delivery intent payload is invalid', {
          cause: error,
        });
      }
      if (actualDigest !== record.payload_sha256) {
        return fail('AUTOLOOP_DELIVERY_LEDGER_INVALID', 'Autoloop delivery intent payload digest is invalid');
      }
      const intent = record as unknown as DeliveryIntent;
      if (intentsById.has(intent.delivery_id) || intentsByKey.has(intent.idempotency_key)) {
        return fail(
          'AUTOLOOP_DELIVERY_LEDGER_INVALID',
          'Autoloop decisions ledger contains duplicate delivery intents',
        );
      }
      intentsById.set(intent.delivery_id, intent);
      intentsByKey.set(intent.idempotency_key, intent);
      graph.intents.push(intent);
      continue;
    }

    if (record.record_type === 'delivery_generation_rebind') {
      if (
        !hasExactKeys(record, [
          'schema_version',
          'record_type',
          'delivery_id',
          'payload_sha256',
          'target_role',
          'from_generation',
          'to_generation',
          'rebound_at',
        ]) ||
        typeof record.delivery_id !== 'string' ||
        typeof record.payload_sha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(record.payload_sha256) ||
        (record.target_role !== 'coder' && record.target_role !== 'reviewer') ||
        !Number.isSafeInteger(record.from_generation) ||
        !Number.isSafeInteger(record.to_generation) ||
        !canonicalTimestamp(record.rebound_at)
      ) {
        return fail(
          'AUTOLOOP_DELIVERY_LEDGER_INVALID',
          'Autoloop decisions ledger contains an invalid delivery rebind',
        );
      }
      const rebind = record as unknown as DeliveryGenerationRebind;
      const intent = intentsById.get(rebind.delivery_id);
      if (
        !intent ||
        rebindsById.has(rebind.delivery_id) ||
        acknowledgementsById.has(rebind.delivery_id) ||
        rebind.payload_sha256 !== intent.payload_sha256 ||
        rebind.target_role !== intent.target_role ||
        rebind.from_generation !== intent.target_generation ||
        rebind.to_generation <= rebind.from_generation
      ) {
        return fail(
          'AUTOLOOP_DELIVERY_LEDGER_INVALID',
          'Autoloop decisions ledger contains an invalid delivery rebind graph',
        );
      }
      rebindsById.set(rebind.delivery_id, rebind);
      graph.rebinds.push(rebind);
      continue;
    }

    if (record.record_type === 'delivery_acknowledgement') {
      if (
        !hasExactKeys(record, [
          'schema_version',
          'record_type',
          'delivery_id',
          'payload_sha256',
          'target_generation',
          'acknowledged_at',
        ]) ||
        typeof record.delivery_id !== 'string' ||
        typeof record.payload_sha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(record.payload_sha256) ||
        !Number.isSafeInteger(record.target_generation) ||
        (record.target_generation as number) < 1 ||
        !canonicalTimestamp(record.acknowledged_at)
      ) {
        return fail(
          'AUTOLOOP_DELIVERY_LEDGER_INVALID',
          'Autoloop decisions ledger contains an invalid delivery acknowledgement',
        );
      }
      const acknowledgement = record as unknown as DeliveryAcknowledgement;
      const intent = intentsById.get(acknowledgement.delivery_id);
      const currentGeneration =
        rebindsById.get(acknowledgement.delivery_id)?.to_generation ?? intent?.target_generation;
      if (
        !intent ||
        acknowledgementsById.has(acknowledgement.delivery_id) ||
        acknowledgement.payload_sha256 !== intent.payload_sha256 ||
        acknowledgement.target_generation !== currentGeneration
      ) {
        return fail(
          'AUTOLOOP_DELIVERY_LEDGER_INVALID',
          'Autoloop decisions ledger contains an invalid delivery acknowledgement graph',
        );
      }
      acknowledgementsById.set(acknowledgement.delivery_id, acknowledgement);
      graph.acknowledgements.push(acknowledgement);
    }
  }
  return graph;
}

/** Read and validate the complete delivery graph without mutating its ledger. */
export function inspectDeliveryOutbox(decisionsPath: string): DeliveryGraph {
  return deliveryGraph(decisionsPath);
}

function appendDurably(decisionsPath: string, row: unknown): void {
  const parentDirectory = path.dirname(decisionsPath);
  fs.mkdirSync(parentDirectory, { recursive: true });
  const ledgerExisted = fs.existsSync(decisionsPath);
  const fd = fs.openSync(decisionsPath, 'a');
  try {
    const serialized = Buffer.from(`${JSON.stringify(row)}\n`, 'utf8');
    let offset = 0;
    while (offset < serialized.byteLength) {
      const written = fs.writeSync(fd, serialized, offset, serialized.byteLength - offset, null);
      if (written <= 0) {
        return fail('AUTOLOOP_DELIVERY_LEDGER_INVALID', 'Autoloop decisions ledger append made no progress');
      }
      offset += written;
    }
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  if (!ledgerExisted) {
    const directoryFd = fs.openSync(parentDirectory, 'r');
    try {
      fs.fsyncSync(directoryFd);
    } finally {
      fs.closeSync(directoryFd);
    }
  }
}

function withDeliveryGraphLock<T>(decisionsPath: string, operation: () => T): T {
  const locked = withFileLock(path.join(path.dirname(decisionsPath), '.delivery-outbox.lock'), operation, {
    createParent: true,
  });
  if (!locked.ok) {
    return fail('AUTOLOOP_DELIVERY_OUTBOX_LOCK_CONTENDED', `Autoloop delivery graph is contended: ${locked.error}`);
  }
  return locked.value;
}

export function prepareDelivery(
  decisionsPath: string,
  input: PrepareDeliveryInput,
  options: PrepareDeliveryOptions = {},
): DeliveryIntent {
  validateInput(input);
  const payloadCanonical = canonicalJson(input.payload);
  const payloadSha256 = canonicalPayloadSha256(input.payload);
  return withDeliveryGraphLock(decisionsPath, () => {
    const existing = deliveryGraph(decisionsPath).intents.filter(
      (row) => row.idempotency_key === input.idempotency_key,
    );
    if (existing.length > 1) {
      return fail('AUTOLOOP_DELIVERY_LEDGER_INVALID', `Delivery '${input.idempotency_key}' has duplicate intents`);
    }
    if (existing.length === 1) {
      const intent = existing[0];
      if (
        intent.kind !== input.kind ||
        intent.target_role !== input.target_role ||
        intent.target_generation !== input.target_generation ||
        intent.payload_sha256 !== payloadSha256 ||
        canonicalJson(intent.payload) !== payloadCanonical
      ) {
        return fail(
          'AUTOLOOP_DELIVERY_IDEMPOTENCY_CONFLICT',
          `Delivery '${input.idempotency_key}' conflicts with its durable intent`,
        );
      }
      return intent;
    }

    const createdAt = (options.now ?? (() => new Date()))().toISOString();
    const intent: DeliveryIntent = {
      schema_version: 1,
      record_type: 'delivery_intent',
      delivery_id: (options.deliveryId ?? randomUUID)(),
      idempotency_key: input.idempotency_key,
      kind: input.kind,
      target_role: input.target_role,
      target_generation: input.target_generation,
      payload: JSON.parse(payloadCanonical) as unknown,
      payload_sha256: payloadSha256,
      created_at: createdAt,
    };
    appendDurably(decisionsPath, intent);
    return intent;
  });
}

export function acknowledgeDelivery(
  decisionsPath: string,
  deliveryId: string,
  payloadSha256: string,
  targetGeneration: number,
  options: AcknowledgeDeliveryOptions = {},
): DeliveryAcknowledgement {
  if (
    !deliveryId.trim() ||
    deliveryId.trim() !== deliveryId ||
    !/^[a-f0-9]{64}$/.test(payloadSha256) ||
    !Number.isSafeInteger(targetGeneration) ||
    targetGeneration < 1
  ) {
    return fail('AUTOLOOP_DELIVERY_INPUT_INVALID', 'Delivery acknowledgement identity is invalid');
  }
  return withDeliveryGraphLock(decisionsPath, () => {
    const graph = deliveryGraph(decisionsPath);
    const intents = graph.intents.filter((row) => row.delivery_id === deliveryId);
    if (intents.length !== 1) {
      return fail('AUTOLOOP_DELIVERY_LEDGER_INVALID', `Delivery '${deliveryId}' does not identify one durable intent`);
    }
    if (intents[0].payload_sha256 !== payloadSha256) {
      return fail(
        'AUTOLOOP_DELIVERY_ACKNOWLEDGEMENT_CONFLICT',
        `Delivery '${deliveryId}' acknowledgement does not match its payload digest`,
      );
    }
    const currentGeneration =
      graph.rebinds.find((row) => row.delivery_id === deliveryId)?.to_generation ?? intents[0].target_generation;
    if (targetGeneration !== currentGeneration) {
      return fail(
        'AUTOLOOP_DELIVERY_ACKNOWLEDGEMENT_CONFLICT',
        `Delivery '${deliveryId}' acknowledgement targets generation ${targetGeneration}, expected ${currentGeneration}`,
      );
    }
    const acknowledgements = graph.acknowledgements.filter((row) => row.delivery_id === deliveryId);
    if (acknowledgements.length > 1) {
      return fail('AUTOLOOP_DELIVERY_LEDGER_INVALID', `Delivery '${deliveryId}' has duplicate acknowledgements`);
    }
    if (acknowledgements.length === 1) {
      if (
        acknowledgements[0].payload_sha256 !== payloadSha256 ||
        acknowledgements[0].target_generation !== targetGeneration
      ) {
        return fail(
          'AUTOLOOP_DELIVERY_ACKNOWLEDGEMENT_CONFLICT',
          `Delivery '${deliveryId}' has a conflicting durable acknowledgement`,
        );
      }
      return acknowledgements[0];
    }

    const acknowledgement: DeliveryAcknowledgement = {
      schema_version: 1,
      record_type: 'delivery_acknowledgement',
      delivery_id: deliveryId,
      payload_sha256: payloadSha256,
      target_generation: targetGeneration,
      acknowledged_at: (options.now ?? (() => new Date()))().toISOString(),
    };
    appendDurably(decisionsPath, acknowledgement);
    return acknowledgement;
  });
}

export function latestTargetGeneration(decisionsPath: string, role: DeliveryTargetRole): number {
  const graph = deliveryGraph(decisionsPath);
  const intended = graph.intents
    .filter((intent) => intent.target_role === role)
    .map((intent) => intent.target_generation);
  const rebound = graph.rebinds.filter((entry) => entry.target_role === role).map((entry) => entry.to_generation);
  return [...intended, ...rebound].reduce((latest, generation) => Math.max(latest, generation), 0);
}

export function rebindDelivery(
  decisionsPath: string,
  deliveryId: string,
  payloadSha256: string,
  targetGeneration: number,
  options: RebindDeliveryOptions = {},
): DeliveryGenerationRebind {
  if (
    !deliveryId.trim() ||
    deliveryId.trim() !== deliveryId ||
    !/^[a-f0-9]{64}$/.test(payloadSha256) ||
    !Number.isSafeInteger(targetGeneration) ||
    targetGeneration < 1
  ) {
    return fail('AUTOLOOP_DELIVERY_INPUT_INVALID', 'Delivery generation rebind identity is invalid');
  }
  return withDeliveryGraphLock(decisionsPath, () => {
    const graph = deliveryGraph(decisionsPath);
    const intents = graph.intents.filter((row) => row.delivery_id === deliveryId);
    if (intents.length !== 1 || intents[0].payload_sha256 !== payloadSha256) {
      return fail('AUTOLOOP_DELIVERY_LEDGER_INVALID', `Delivery '${deliveryId}' does not identify one durable intent`);
    }
    if (graph.acknowledgements.some((row) => row.delivery_id === deliveryId)) {
      return fail(
        'AUTOLOOP_DELIVERY_GENERATION_REBIND_CONFLICT',
        `Delivery '${deliveryId}' is already acknowledged and cannot be rebound`,
      );
    }
    const existing = graph.rebinds.filter((row) => row.delivery_id === deliveryId);
    if (existing.length > 1) {
      return fail('AUTOLOOP_DELIVERY_LEDGER_INVALID', `Delivery '${deliveryId}' has duplicate generation rebinds`);
    }
    if (existing.length === 1) {
      if (existing[0].payload_sha256 === payloadSha256 && existing[0].to_generation === targetGeneration) {
        return existing[0];
      }
      return fail(
        'AUTOLOOP_DELIVERY_GENERATION_REBIND_CONFLICT',
        `Delivery '${deliveryId}' already targets another replacement generation`,
      );
    }
    if (targetGeneration <= intents[0].target_generation) {
      return fail(
        'AUTOLOOP_DELIVERY_GENERATION_REBIND_CONFLICT',
        `Delivery '${deliveryId}' replacement generation must increase monotonically`,
      );
    }
    const rebind: DeliveryGenerationRebind = {
      schema_version: 1,
      record_type: 'delivery_generation_rebind',
      delivery_id: deliveryId,
      payload_sha256: payloadSha256,
      target_role: intents[0].target_role,
      from_generation: intents[0].target_generation,
      to_generation: targetGeneration,
      rebound_at: (options.now ?? (() => new Date()))().toISOString(),
    };
    appendDurably(decisionsPath, rebind);
    return rebind;
  });
}
