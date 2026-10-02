/**
 * Coder + Reviewer tool-call parsers.
 *
 * Same fenced-block convention as planner-tools.ts: agents emit one or more
 *   ```autoloop
 *   {"tool": "...", "args": { ... }}
 *   ```
 * blocks per turn. The dispatcher extracts and acts on them.
 *
 * Coder tools:    iter_complete, request_clarification, coder_log
 * Reviewer tools: review_complete, reviewer_log
 */

export type CoderToolName = 'iter_complete' | 'request_clarification' | 'coder_log';
export type ReviewerToolName = 'review_complete' | 'reviewer_log';

export interface AgentToolCall {
  tool: string;
  args: Record<string, unknown>;
}

export interface AgentToolParseResult {
  calls: AgentToolCall[];
  cleaned_reply: string;
  parse_errors: Array<{ block_index: number; error: string }>;
}

const FENCE_RE = /```autoloop\s*\n([\s\S]*?)\n```/g;

/** Same parser as Planner's; agent-tools just describe a different vocabulary. */
export function parseAgentReply(reply: string): AgentToolParseResult {
  const calls: AgentToolCall[] = [];
  const parse_errors: Array<{ block_index: number; error: string }> = [];
  let blockIndex = 0;
  const cleaned = reply.replace(FENCE_RE, (_match, body: string) => {
    const idx = blockIndex++;
    try {
      const parsed = JSON.parse(body.trim()) as AgentToolCall;
      if (typeof parsed?.tool !== 'string' || typeof parsed?.args !== 'object' || parsed.args === null) {
        parse_errors.push({ block_index: idx, error: 'block missing tool/args fields' });
        return '';
      }
      calls.push(parsed);
    } catch (err) {
      parse_errors.push({ block_index: idx, error: (err as Error).message });
    }
    return '';
  });
  return { calls, cleaned_reply: cleaned.trim(), parse_errors };
}

// ─── Specialised typed extractors ────────────────────────────────────────────

export interface IterCompletePayload {
  summary: string;
  eval_output: unknown;
  files_changed?: string[];
  delivery_id?: string;
  payload_sha256?: string;
}

export interface ReviewCompletePayload {
  decision: 'advance' | 'hold' | 'rollback';
  metric: number | null;
  audit_notes: string;
  flags?: string[];
  delivery_id?: string;
  payload_sha256?: string;
}

export interface ClarificationPayload {
  question: string;
  delivery_id?: string;
  payload_sha256?: string;
}

function ownString(record: Record<string, unknown>, field: string): string | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(record, field);
  return descriptor?.enumerable === true && Object.hasOwn(descriptor, 'value') && typeof descriptor.value === 'string'
    ? descriptor.value
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

type DeliveryProvenance = { delivery_id: string; payload_sha256: string };
type DeliveryProvenanceState =
  | { state: 'absent' }
  | { state: 'invalid' }
  | { state: 'valid'; value: DeliveryProvenance };

function deliveryProvenanceState(args: Record<string, unknown>): DeliveryProvenanceState {
  const hasDeliveryId = Object.hasOwn(args, 'delivery_id');
  const hasPayloadSha256 = Object.hasOwn(args, 'payload_sha256');
  if (!hasDeliveryId && !hasPayloadSha256) return { state: 'absent' };
  const deliveryId = ownString(args, 'delivery_id');
  const payloadSha256 = ownString(args, 'payload_sha256');
  if (!deliveryId || !/^[a-f0-9]{64}$/.test(payloadSha256 ?? '')) return { state: 'invalid' };
  return { state: 'valid', value: { delivery_id: deliveryId, payload_sha256: payloadSha256! } };
}

function directDeliveryProvenance(args: Record<string, unknown>): DeliveryProvenance | undefined {
  const provenance = deliveryProvenanceState(args);
  return provenance.state === 'valid' ? provenance.value : undefined;
}

function iterCompleteDeliveryProvenance(args: Record<string, unknown>): DeliveryProvenance | undefined {
  const direct = deliveryProvenanceState(args);
  const evalOutput = Object.hasOwn(args, 'eval_output') ? args.eval_output : undefined;
  const extra = isRecord(evalOutput) && Object.hasOwn(evalOutput, 'extra') ? evalOutput.extra : undefined;
  const nested = isRecord(extra) ? deliveryProvenanceState(extra) : { state: 'absent' as const };
  if (direct.state === 'invalid' || nested.state === 'invalid') return undefined;
  if (direct.state === 'valid' && nested.state === 'valid') {
    return direct.value.delivery_id === nested.value.delivery_id &&
      direct.value.payload_sha256 === nested.value.payload_sha256
      ? direct.value
      : undefined;
  }
  return direct.state === 'valid' ? direct.value : nested.state === 'valid' ? nested.value : undefined;
}

/** Find the *last* iter_complete block (per coder prompt: at most one expected). */
export function extractIterComplete(calls: AgentToolCall[]): IterCompletePayload | null {
  const matches = calls.filter((c) => c.tool === 'iter_complete');
  if (matches.length === 0) return null;
  const last = matches[matches.length - 1];
  const summary = String(last.args.summary ?? '');
  const eval_output = last.args.eval_output ?? {};
  const filesRaw = last.args.files_changed;
  const files_changed = Array.isArray(filesRaw) ? filesRaw.filter((x) => typeof x === 'string') : undefined;
  return { summary, eval_output, files_changed, ...iterCompleteDeliveryProvenance(last.args) };
}

export function extractReviewComplete(calls: AgentToolCall[]): ReviewCompletePayload | null {
  const matches = calls.filter((c) => c.tool === 'review_complete');
  if (matches.length === 0) return null;
  const last = matches[matches.length - 1];
  const dec = String(last.args.decision ?? '');
  if (dec !== 'advance' && dec !== 'hold' && dec !== 'rollback') return null;
  const metricRaw = last.args.metric;
  const metric =
    typeof metricRaw === 'number' && Number.isFinite(metricRaw) ? metricRaw : metricRaw === null ? null : null;
  const audit_notes = String(last.args.audit_notes ?? '');
  const flagsRaw = last.args.flags;
  const flags = Array.isArray(flagsRaw) ? flagsRaw.filter((x) => typeof x === 'string') : undefined;
  return {
    decision: dec as ReviewCompletePayload['decision'],
    metric,
    audit_notes,
    flags,
    ...directDeliveryProvenance(last.args),
  };
}

/** Find the first structured clarification and any exact delivery provenance. */
export function extractClarificationCompletion(calls: AgentToolCall[]): ClarificationPayload | null {
  const m = calls.find((c) => c.tool === 'request_clarification');
  if (!m) return null;
  const q = m.args.question;
  return typeof q === 'string' && q.trim() ? { question: q, ...directDeliveryProvenance(m.args) } : null;
}

/** Backward-compatible convenience accessor for the clarification text. */
export function extractClarification(calls: AgentToolCall[]): string | null {
  return extractClarificationCompletion(calls)?.question ?? null;
}
