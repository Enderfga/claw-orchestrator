/**
 * Durable accepted Autoloop chat recovery ledger (fenced via node checkpoint).
 * Stage-commit-adopt only; never holds an uncommitted record in memory.
 */

import { randomUUID } from 'node:crypto';
import { AutoloopRoutingError } from './messages.js';

export const RECOVERY_VERSION = 1 as const;
export const MAX_RECOVERY_ITEMS = 1000;
export const MAX_RECOVERY_TEXT_BYTES = 8 * 1024 * 1024;
export const MAX_TOMBSTONES = 64;

/** UUID form used by ledger_id and accepted-chat message_id (randomUUID). */
const SYSTEM_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** Dispatcher deriveDispatchId: `dispatch_` + sha256 hex (64). */
const DISPATCH_ID_RE = /^dispatch_[a-f0-9]{64}$/;
/**
 * Envelope nextMsgId (`messages.ts`): `m_${Date.now().toString(36)}_${(counter|0).toString(36)}`.
 * Validation is a bounded lexical form only: first segment 1..11 base36 chars,
 * second segment optional leading `-` then 1..6 base36 chars (covers signed-int32
 * `| 0` stringification including `-zik0zk`). It does not prove numeric equality
 * with Date.now()/counter values — reject oversized or malformed shapes.
 */
const ENVELOPE_MSG_ID_RE = /^m_[0-9a-z]{1,11}_-?[0-9a-z]{1,6}$/;
const ENVELOPE_MSG_ID_MAX_LEN = 2 + 11 + 1 + 1 + 6; // m_ + ts + _ + optional - + counter

const RECOVERY_KEYS = new Set(['v', 'gate', 'ledger_id', 'revision', 'items', 'resolved']);
const GATE_KEYS = new Set(['kind']);
const ITEM_KEYS = new Set(['message_id', 'iter', 'ts', 'accepted_at', 'text', 'status', 'dispatch_id']);
const TOMB_KEYS = new Set(['message_id', 'resolution', 'revision', 'at']);

const GATE_KINDS = new Set(['operator_pause', 'activity_lease', 'input_uncertain', 'recovered_input']);
const ITEM_STATUSES = new Set(['pending', 'dispatched']);
const RESOLUTIONS = new Set(['abandon', 'confirm_delivered', 'advanced_after_timeout']);

const PERSISTENCE_CODES = new Set([
  'no_publisher',
  'terminating',
  'commit_refused',
  'bound_items',
  'bound_text',
  'malformed',
]);

const DEPTH_NEXT = new Set([
  'chat',
  'directive',
  'directive_ack',
  'iter_artifacts',
  'review_request',
  'review_verdict',
  'iter_done',
  'push_user',
  'pause',
  'resume',
  'terminate',
  'phase_error',
  'send_timeout',
  '?',
]);
const DEPTH_TO = new Set(['planner', 'coder', 'reviewer', 'runner', 'user', '?']);

export type RecoveryGateKind = 'operator_pause' | 'activity_lease' | 'input_uncertain' | 'recovered_input';
export type RecoveryItemStatus = 'pending' | 'dispatched';
export type RecoveryResolution = 'abandon' | 'confirm_delivered' | 'advanced_after_timeout';

export interface RecoveryGate {
  kind: RecoveryGateKind;
}

export interface RecoveryItem {
  message_id: string;
  iter: number;
  ts: string;
  accepted_at: string;
  text: string;
  status: RecoveryItemStatus;
  dispatch_id?: string;
}

export interface RecoveryTombstone {
  message_id: string;
  resolution: RecoveryResolution;
  revision: number;
  at: string;
}

export interface AutoloopRecovery {
  v: typeof RECOVERY_VERSION;
  gate: RecoveryGate | null;
  ledger_id: string;
  revision: number;
  items: RecoveryItem[];
  resolved: RecoveryTombstone[];
}

/** Text-free status projection (never includes chat text). */
export interface PendingInputStatus {
  ledger_id: string;
  revision: number;
  gate: RecoveryGate | null;
  items: Array<{
    message_id: string;
    accepted_at: string;
    status: 'pending' | 'uncertain';
    dispatch_id?: string;
  }>;
  resolved: RecoveryTombstone[];
}

export const GATE_STATUS_REASON: Record<RecoveryGateKind, string> = {
  operator_pause: 'operator-hold',
  activity_lease: 'activity_lease_expired',
  input_uncertain: 'input_uncertain',
  recovered_input: 'recovered_input',
};

export class AutoloopInputPersistenceError extends Error {
  readonly code: 'no_publisher' | 'terminating' | 'commit_refused' | 'bound_items' | 'bound_text' | 'malformed';
  constructor(code: AutoloopInputPersistenceError['code'], message: string) {
    super(message);
    this.name = 'AutoloopInputPersistenceError';
    this.code = code;
  }
}

export function emptyRecovery(): AutoloopRecovery {
  return {
    v: RECOVERY_VERSION,
    gate: null,
    ledger_id: randomUUID(),
    revision: 0,
    items: [],
    resolved: [],
  };
}

export function cloneRecovery(r: AutoloopRecovery): AutoloopRecovery {
  return JSON.parse(JSON.stringify(r)) as AutoloopRecovery;
}

export function isSystemId(value: unknown): value is string {
  return typeof value === 'string' && SYSTEM_ID_RE.test(value);
}

/** True for dispatcher-emitted dispatch_<sha256hex64> identities. */
export function isDispatchId(value: unknown): value is string {
  return typeof value === 'string' && DISPATCH_ID_RE.test(value);
}

/** True for envelope msg ids (`m_…`) or accepted-chat UUIDs used as message_id on pending_dispatch. */
export function isPendingMessageId(value: unknown): value is string {
  if (isSystemId(value)) return true;
  return typeof value === 'string' && value.length <= ENVELOPE_MSG_ID_MAX_LEN && ENVELOPE_MSG_ID_RE.test(value);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function exactKeys(obj: Record<string, unknown>, allowed: Set<string>): boolean {
  const keys = Object.keys(obj);
  if (keys.length > allowed.size) return false;
  for (const k of keys) {
    if (!allowed.has(k)) return false;
  }
  return true;
}

function isSafeNonNegInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
}

function isSafeIsoTimestamp(v: unknown): v is string {
  if (typeof v !== 'string' || v.length < 10 || v.length > 64) return false;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(v)) return false;
  const t = Date.parse(v);
  return Number.isFinite(t);
}

function malformed(): never {
  throw new AutoloopInputPersistenceError('malformed', 'autoloop recovery record is malformed');
}

/** Fail-closed schema check. Returns null when field absent (legacy). Throws fixed errors. */
export function validateRecoveryField(raw: unknown): AutoloopRecovery | null {
  if (raw === undefined || raw === null) return null;
  if (!isPlainObject(raw)) malformed();
  if (!exactKeys(raw, RECOVERY_KEYS)) malformed();
  if (raw.v !== RECOVERY_VERSION) malformed();
  if (!isSystemId(raw.ledger_id)) malformed();
  if (!isSafeNonNegInt(raw.revision)) malformed();

  let gate: RecoveryGate | null = null;
  if (raw.gate === null) {
    gate = null;
  } else if (isPlainObject(raw.gate)) {
    if (!exactKeys(raw.gate, GATE_KEYS)) malformed();
    if (typeof raw.gate.kind !== 'string' || !GATE_KINDS.has(raw.gate.kind)) malformed();
    gate = { kind: raw.gate.kind as RecoveryGateKind };
  } else {
    malformed();
  }

  if (!Array.isArray(raw.items) || raw.items.length > MAX_RECOVERY_ITEMS) malformed();
  if (!Array.isArray(raw.resolved) || raw.resolved.length > MAX_TOMBSTONES) malformed();

  let dispatchedCount = 0;
  let aggregateBytes = 0;
  const ids = new Set<string>();
  const items: RecoveryItem[] = [];
  for (const it of raw.items) {
    if (!isPlainObject(it) || !exactKeys(it, ITEM_KEYS)) malformed();
    if (!isSystemId(it.message_id)) malformed();
    if (ids.has(it.message_id)) malformed();
    ids.add(it.message_id);
    if (typeof it.status !== 'string' || !ITEM_STATUSES.has(it.status)) malformed();
    if (it.status === 'dispatched') dispatchedCount += 1;
    if (typeof it.text !== 'string') malformed();
    if (!isSafeNonNegInt(it.iter)) malformed();
    if (!isSafeIsoTimestamp(it.ts) || !isSafeIsoTimestamp(it.accepted_at)) malformed();
    aggregateBytes += utf8ByteLength(it.text);
    if (aggregateBytes > MAX_RECOVERY_TEXT_BYTES) malformed();
    let dispatch_id: string | undefined;
    if (Object.prototype.hasOwnProperty.call(it, 'dispatch_id')) {
      // Recovery item.dispatch_id is the real dispatcher id, not a UUID.
      if (!isDispatchId(it.dispatch_id)) malformed();
      dispatch_id = it.dispatch_id;
    }
    if (it.status === 'pending' && dispatch_id !== undefined) malformed();
    items.push({
      message_id: it.message_id,
      iter: it.iter,
      ts: it.ts,
      accepted_at: it.accepted_at,
      text: it.text,
      status: it.status as RecoveryItemStatus,
      ...(dispatch_id ? { dispatch_id } : {}),
    });
  }
  if (dispatchedCount > 1) malformed();
  if (dispatchedCount === 1 && items[0]?.status !== 'dispatched') malformed();

  const resolvedIds = new Set<string>();
  const resolved: RecoveryTombstone[] = [];
  for (const t of raw.resolved) {
    if (!isPlainObject(t) || !exactKeys(t, TOMB_KEYS)) malformed();
    if (!isSystemId(t.message_id)) malformed();
    if (resolvedIds.has(t.message_id)) malformed();
    resolvedIds.add(t.message_id);
    if (ids.has(t.message_id)) malformed();
    if (typeof t.resolution !== 'string' || !RESOLUTIONS.has(t.resolution)) malformed();
    if (!isSafeNonNegInt(t.revision)) malformed();
    if (!isSafeIsoTimestamp(t.at)) malformed();
    resolved.push({
      message_id: t.message_id,
      resolution: t.resolution as RecoveryResolution,
      revision: t.revision,
      at: t.at,
    });
  }
  return {
    v: RECOVERY_VERSION,
    gate,
    ledger_id: raw.ledger_id,
    revision: raw.revision,
    items,
    resolved,
  };
}

export function projectPendingInput(recovery: AutoloopRecovery | null | undefined): PendingInputStatus | undefined {
  if (!recovery || recovery.items.length === 0) return undefined;
  return {
    ledger_id: recovery.ledger_id,
    revision: recovery.revision,
    gate: recovery.gate,
    items: recovery.items.map((it) => ({
      message_id: it.message_id,
      accepted_at: it.accepted_at,
      status: it.status === 'dispatched' ? ('uncertain' as const) : ('pending' as const),
      ...(it.dispatch_id ? { dispatch_id: it.dispatch_id } : {}),
    })),
    resolved: recovery.resolved.slice(),
  };
}

export function utf8ByteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

export function appendTombstone(resolved: RecoveryTombstone[], tomb: RecoveryTombstone): RecoveryTombstone[] {
  const next = [...resolved, tomb];
  if (next.length <= MAX_TOMBSTONES) return next;
  return next.slice(next.length - MAX_TOMBSTONES);
}

/** Own data-property string read; never invokes getters/Proxy traps beyond hasOwn. */
function trustedOwnDataString(obj: object, key: string): string | undefined {
  try {
    if (!Object.prototype.hasOwnProperty.call(obj, key)) return undefined;
    const desc = Object.getOwnPropertyDescriptor(obj, key);
    if (!desc || !Object.prototype.hasOwnProperty.call(desc, 'value')) return undefined;
    if (typeof desc.value !== 'string') return undefined;
    return desc.value;
  } catch {
    return undefined;
  }
}

function safePrototypeOf(obj: object): object | null | undefined {
  try {
    return Reflect.getPrototypeOf(obj);
  } catch {
    return undefined;
  }
}

/**
 * Pure background-error reason formatter (mandate 3.3 item 11).
 * Strictly allowlisted scalar classifications; never throws; never reflects
 * arbitrary code/message/name/stack through getters or Proxy traps.
 */
export function formatAutoloopBackgroundErrorReason(err: unknown): string {
  const FALLBACK = 'background task failed (details withheld)';
  try {
    if (err === null || typeof err !== 'object') return FALLBACK;

    const message = trustedOwnDataString(err, 'message') ?? '';
    const bounded = message.length > 512 ? message.slice(0, 512) : message;

    // Depth: finite enums + safe integers only — never echo arbitrary [^']*.
    const depth =
      /^dispatch depth exceeded (\d+) at iter (\d+) \(next='([a-z0-9_?]+)' to '([a-z0-9_?]+)'\) — likely message ping-pong; raise config\.maxDispatchDepth for legitimately deep workflows$/.exec(
        bounded,
      );
    if (depth) {
      const maxDepth = Number(depth[1]);
      const iter = Number(depth[2]);
      const next = depth[3]!;
      const to = depth[4]!;
      if (
        Number.isSafeInteger(maxDepth) &&
        maxDepth >= 0 &&
        Number.isSafeInteger(iter) &&
        iter >= 0 &&
        DEPTH_NEXT.has(next) &&
        DEPTH_TO.has(to)
      ) {
        return `dispatch depth exceeded ${maxDepth} at iter ${iter} (next='${next}' to '${to}') — likely message ping-pong; raise config.maxDispatchDepth for legitimately deep workflows`;
      }
      return FALLBACK;
    }

    if (/^pausedBuffer exceeded \d+; dropping oldest parked message$/.test(bounded)) {
      return 'pausedBuffer overflow; dropping oldest parked message';
    }

    const name = trustedOwnDataString(err, 'name');
    if (name === 'AutoloopInputPersistenceError') {
      const code = trustedOwnDataString(err, 'code');
      if (code && PERSISTENCE_CODES.has(code)) {
        return `input persistence refused (${code})`;
      }
      return 'input persistence refused';
    }

    const proto = safePrototypeOf(err);
    if (proto === undefined) return FALLBACK;

    if (name === 'AutoloopRoutingError' || proto === AutoloopRoutingError.prototype) {
      // Only trust routing when prototype matches the real class (not a spoofed name).
      if (proto === AutoloopRoutingError.prototype) {
        return 'autoloop routing error (details withheld)';
      }
    }

    if (/^autoloop (?:input|recovery) /.test(bounded) || bounded.includes('input persistence')) {
      return 'input persistence refused';
    }

    // Exact intrinsic prototype only — subclasses (Sub.prototype ≠ Error.prototype) fall through.
    if (proto === Error.prototype) return 'Error (details withheld)';
    if (proto === TypeError.prototype) return 'TypeError (details withheld)';
    if (proto === RangeError.prototype) return 'RangeError (details withheld)';
    if (proto === SyntaxError.prototype) return 'SyntaxError (details withheld)';
    return FALLBACK;
  } catch {
    return FALLBACK;
  }
}

export function newMessageId(): string {
  return randomUUID();
}

export function messageIdInUse(recovery: AutoloopRecovery, id: string): boolean {
  if (recovery.items.some((it) => it.message_id === id)) return true;
  return recovery.resolved.some((t) => t.message_id === id);
}

/** Validate a genuine stored SendTimeoutPayload for restoration. */
export function isGenuinePendingDispatch(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  if (value.status !== 'awaiting_resume') return false;
  if (!isDispatchId(value.dispatch_id)) return false;
  if (value.agent !== 'planner' && value.agent !== 'coder' && value.agent !== 'reviewer') return false;
  // Pending message_id is either an accepted-chat UUID or an envelope m_* id.
  if (!isPendingMessageId(value.message_id)) return false;
  if (typeof value.message_type !== 'string' || !DEPTH_NEXT.has(value.message_type)) return false;
  if (!isSafeNonNegInt(value.iter)) return false;
  if (typeof value.timeout_ms !== 'number' || !Number.isSafeInteger(value.timeout_ms) || value.timeout_ms <= 0) {
    return false;
  }
  if (typeof value.error !== 'string' || value.error.length > 512) return false;
  return true;
}
