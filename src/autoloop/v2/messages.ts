/**
 * Inbox message envelope + discriminated union of v2 message types.
 *
 * Contract: see tasks/autoloop-v2.md §3.3.
 *
 * Wire format: serialised as JSON in InboxManager's `text` field, with
 * `summary` set to the message `type` for human-readable inbox listings.
 * Routing addressing convention: session name = `autoloop:<run_id>:<role>`,
 * where role ∈ { planner, coder, reviewer, runner }. The literal `user`
 * is *not* a session — it appears only as the `from` of an external chat
 * injection (`autoloop_chat`) and as the `to` of `push_user` messages
 * (which the runner consumes to invoke notify_user).
 */

export type AutoloopV2Role = 'planner' | 'coder' | 'reviewer' | 'runner' | 'user';

export interface AutoloopV2Envelope<T extends AutoloopV2MessageType = AutoloopV2MessageType> {
  msg_id: string;
  iter: number;
  from: AutoloopV2Role;
  to: AutoloopV2Role;
  type: T;
  ts: string;
  payload: PayloadFor<T>;
}

// ─── Payloads ────────────────────────────────────────────────────────────────

export interface UserChatPayload {
  text: string;
}

export interface DirectivePayload {
  goal: string;
  constraints: string[];
  success_criteria: string[];
  max_attempts: number;
}

export interface DirectiveAckPayload {
  understood: boolean;
  clarification?: string;
}

export interface IterArtifactsPayload {
  diff: string;
  eval_output: unknown; // Loosely typed at this layer; v1's EvalOutput shape will be reused in S4.
  files_changed: string[];
}

export interface ReviewRequestPayload {
  iter: number;
  ledger_path: string;
  prior_metrics: number[];
}

export interface ReviewVerdictPayload {
  decision: 'advance' | 'hold' | 'rollback';
  metric: number | null;
  audit_notes: string;
}

export interface IterDonePayload {
  iter: number;
  verdict: 'advance' | 'hold' | 'rollback';
  metric: number | null;
  regression?: boolean;
}

export type PushLevel = 'info' | 'warn' | 'decision' | 'error';
export type PushChannel = 'auto' | 'wechat' | 'webchat' | 'both' | 'email';

export interface PushUserPayload {
  level: PushLevel;
  summary: string;
  detail?: string;
  channel: PushChannel;
}

export interface PausePayload {
  reason: string;
}

export type ResumePayload = Record<string, never>;

export interface TerminatePayload {
  reason: string;
}

// ─── Discriminated union ─────────────────────────────────────────────────────

export type AutoloopV2MessageType =
  | 'chat'
  | 'directive'
  | 'directive_ack'
  | 'iter_artifacts'
  | 'review_request'
  | 'review_verdict'
  | 'iter_done'
  | 'push_user'
  | 'pause'
  | 'resume'
  | 'terminate';

type PayloadMap = {
  chat: UserChatPayload;
  directive: DirectivePayload;
  directive_ack: DirectiveAckPayload;
  iter_artifacts: IterArtifactsPayload;
  review_request: ReviewRequestPayload;
  review_verdict: ReviewVerdictPayload;
  iter_done: IterDonePayload;
  push_user: PushUserPayload;
  pause: PausePayload;
  resume: ResumePayload;
  terminate: TerminatePayload;
};

export type PayloadFor<T extends AutoloopV2MessageType> = PayloadMap[T];

export type AnyAutoloopV2Message = {
  [T in AutoloopV2MessageType]: AutoloopV2Envelope<T>;
}[AutoloopV2MessageType];

// ─── Sender/recipient validity table ────────────────────────────────────────
//
// Allowed (from, to, type) tuples. Anything else is a routing error caught
// by `validateMessage`. Centralising this table keeps the runner's switch
// statements honest and gives us one place to update when v2.1 adds new
// message types (e.g. weixin-inbound chat reply).

const ALLOWED_ROUTES: ReadonlyArray<readonly [AutoloopV2Role, AutoloopV2Role, AutoloopV2MessageType]> = [
  ['user', 'planner', 'chat'],
  ['planner', 'coder', 'directive'],
  ['coder', 'planner', 'directive_ack'],
  ['coder', 'runner', 'iter_artifacts'],
  ['runner', 'reviewer', 'review_request'],
  ['reviewer', 'runner', 'review_verdict'],
  ['runner', 'planner', 'iter_done'],
  ['planner', 'user', 'push_user'],
  ['planner', 'runner', 'pause'],
  ['planner', 'runner', 'resume'],
  ['planner', 'runner', 'terminate'],
];

export class AutoloopV2RoutingError extends Error {
  constructor(
    msg: string,
    public envelope?: AnyAutoloopV2Message,
  ) {
    super(msg);
    this.name = 'AutoloopV2RoutingError';
  }
}

export function validateMessage(env: AnyAutoloopV2Message): void {
  const ok = ALLOWED_ROUTES.some(([f, t, ty]) => f === env.from && t === env.to && ty === env.type);
  if (!ok) {
    throw new AutoloopV2RoutingError(`Invalid v2 routing: ${env.from} → ${env.to} (type=${env.type})`, env);
  }
}

// ─── Constructors ────────────────────────────────────────────────────────────

let __counter = 0;
function nextMsgId(): string {
  // Cheap monotonic IDs; collisions across runs are not load-bearing.
  __counter = (__counter + 1) | 0;
  return `m_${Date.now().toString(36)}_${__counter.toString(36)}`;
}

function envelope<T extends AutoloopV2MessageType>(
  iter: number,
  from: AutoloopV2Role,
  to: AutoloopV2Role,
  type: T,
  payload: PayloadFor<T>,
): AutoloopV2Envelope<T> {
  return {
    msg_id: nextMsgId(),
    iter,
    from,
    to,
    type,
    ts: new Date().toISOString(),
    payload,
  };
}

export const Msg = {
  chat: (iter: number, payload: UserChatPayload) => envelope(iter, 'user', 'planner', 'chat', payload),
  directive: (iter: number, payload: DirectivePayload) => envelope(iter, 'planner', 'coder', 'directive', payload),
  directiveAck: (iter: number, payload: DirectiveAckPayload) =>
    envelope(iter, 'coder', 'planner', 'directive_ack', payload),
  iterArtifacts: (iter: number, payload: IterArtifactsPayload) =>
    envelope(iter, 'coder', 'runner', 'iter_artifacts', payload),
  reviewRequest: (iter: number, payload: ReviewRequestPayload) =>
    envelope(iter, 'runner', 'reviewer', 'review_request', payload),
  reviewVerdict: (iter: number, payload: ReviewVerdictPayload) =>
    envelope(iter, 'reviewer', 'runner', 'review_verdict', payload),
  iterDone: (iter: number, payload: IterDonePayload) => envelope(iter, 'runner', 'planner', 'iter_done', payload),
  pushUser: (iter: number, payload: PushUserPayload) => envelope(iter, 'planner', 'user', 'push_user', payload),
  pause: (iter: number, payload: PausePayload) => envelope(iter, 'planner', 'runner', 'pause', payload),
  resume: (iter: number) => envelope(iter, 'planner', 'runner', 'resume', {}),
  terminate: (iter: number, payload: TerminatePayload) => envelope(iter, 'planner', 'runner', 'terminate', payload),
};

// ─── Wire serialisation (for InboxManager transport) ─────────────────────────

export function serialise(env: AnyAutoloopV2Message): { text: string; summary: string } {
  return {
    text: JSON.stringify(env),
    summary: env.type,
  };
}

export function deserialise(text: string): AnyAutoloopV2Message {
  const parsed = JSON.parse(text) as AnyAutoloopV2Message;
  if (typeof parsed !== 'object' || parsed === null || typeof parsed.type !== 'string') {
    throw new AutoloopV2RoutingError('Malformed v2 envelope (not an object or missing type)');
  }
  return parsed;
}
