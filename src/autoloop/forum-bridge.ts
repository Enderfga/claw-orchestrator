/**
 * An autoloop on its run's forum.
 *
 * The runner still decides whose turn it is, and every decision the loop makes
 * is still read from the roles' own replies and from the ledger: control
 * blocks, `iter_complete`, `review_complete`, the acceptance gate. The forum
 * carries the rest and records all of it:
 *
 *  - The runner's envelopes are mirrored as posts, once per `msg_id` (a parked
 *    message is emitted again when the pause ends): from the role that sent it,
 *    or from `orchestrator` for what the runner or an operator sent. The user's
 *    chat is mirrored as the user's post, handed to the Planner as its turn.
 *  - The roles are members while their sessions live: the Planner read-only, the
 *    Coder writable, the Reviewer write-only and pushed nothing it is not named
 *    in. A role is briefed in the first message after its session starts, and a
 *    turn of the Planner or the Coder carries the posts addressed to it since
 *    its last one; both are on record as handed over once the turn is sent. A
 *    post reaches a role mid-turn only while that role's own turn is in flight
 *    and does not carry it already; otherwise it waits for the next one.
 *  - Blocks a role writes in its reply (`<new-forum-post>`) are posted for it,
 *    and taken out of the reply the user sees.
 *
 * Without exposure (`forum: false`) only the mirror runs: the roles are not
 * told, and the posts are the run's record.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  ForumReplyRelay,
  forumAuthority,
  forumBrief,
  forumHub,
  forumLocation,
  forumMarkDelivered,
  forumRuntimePost,
  forumSnapshot,
  forumTeamOf,
  isForumName,
  type Deliver,
  type ForumAuthority,
  type ForumBriefOptions,
  type ForumConfig,
  type ForumJoinOptions,
  type ForumPost,
  type ForumRuntimePostInput,
} from '../kernel/forum.js';
import { forumTurnInboxParts } from '../kernel/forum/brief.js';
import type { Logger } from '../logger.js';
import type { AnyAutoloopMessage } from './messages.js';
import type { AutoloopRoleName } from './types.js';

const ROLES: readonly AutoloopRoleName[] = ['planner', 'coder', 'reviewer'];

/** What a mirrored envelope's body may carry of a free-text field. */
const BODY_TEXT_CHARS = 4_000;
/** What an iteration post carries of the evaluator's output. */
const EVAL_OUTPUT_CHARS = 2_000;
/** File names an iteration post lists. */
const LISTED_FILES = 50;
/** What separates a role's message from what the forum adds to it. */
export const FORUM_APPENDIX_SEPARATOR = '\n\n---\n\n';

/** Where an autoloop's roles are on a forum, and how its runtime writes there. */
export interface AutoloopForumTarget {
  /** The forum's id: the run's own, or the forum the run is bound to. */
  id: string;
  config: ForumConfig;
  /** The roles are members: briefed, handed the posts for them, their reply blocks posted. */
  exposed: boolean;
  /** Each role's name on the forum. */
  names: Record<AutoloopRoleName, string>;
  /**
   * Writes a runtime post and returns it, or undefined when nothing was
   * written. The kernel node passes its `ctx.forumPost`, which stops writing
   * once the run has another owner. Default: `forumRuntimePost`, errors logged.
   */
  post?: (input: ForumRuntimePostInput) => Promise<ForumPost | undefined>;
}

export interface AutoloopForumBridgeOptions {
  /** The run ledger (`<workspace>/tasks/<runId>`), named in the posts that point at its files. */
  ledgerDir: string;
  /** Hand text to a session's turn in flight; false when there is none or the engine takes nothing mid-turn. */
  deliverMidTurn?: (session: string, text: string) => Promise<boolean>;
  logger?: Pick<Logger, 'warn'>;
}

/** The runner as the mirror listens to it. */
export interface AutoloopMessageSource {
  on(event: 'message' | 'push', listener: (...args: unknown[]) => void): unknown;
  off(event: 'message' | 'push', listener: (...args: unknown[]) => void): unknown;
  /** Whether an envelope came out of a role's turn, as opposed to the runner or an operator. */
  emittedByAgent?(env: AnyAutoloopMessage): boolean;
}

interface Membership {
  session: string;
  leave: (opts?: { expire?: boolean }) => void;
  briefPending: boolean;
  relay: ForumReplyRelay;
}

/** What a role's turn message carries from the forum, put on record once the turn is sent. */
interface UnsentTurn {
  /** The message settles the brief: it carries it, or the brief could not be made. */
  brief: boolean;
  /** The posts after the message, recorded as delivered in a turn. */
  inbox: string[];
  /** Every post the message hands over: those, and the user's posts in the brief. */
  handed: string[];
}

const NEW_POST_BLOCK = /<new-forum-post\b[^>]*>[\s\S]*?<\/new-forum-post>/gi;

/** A reply without the `<new-forum-post>` blocks that were posted from it. */
export function stripForumBlocks(text: string): string {
  if (!text || !/<\/new-forum-post>/i.test(text)) return text;
  return text
    .replace(NEW_POST_BLOCK, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function firstLine(text: string, max = 100): string {
  const line = (text ?? '').split('\n').find((l) => l.trim()) ?? '';
  const t = line.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function bounded(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n[…]` : text;
}

function isRole(name: string): name is AutoloopRoleName {
  return (ROLES as readonly string[]).includes(name);
}

/** The mode's sentences for each role's brief, in place of the forum's defaults. */
function roleNorms(role: AutoloopRoleName, names: Record<AutoloopRoleName, string>): string {
  if (role === 'planner') {
    return (
      'Your ```autoloop blocks are how you direct the loop: a post never replaces one, and nothing is done because a post says so. ' +
      `Post ASK @${names.coder} or FAIL @${names.coder} when the Coder should know something before its next directive. ` +
      "The user's chat reaches you as your turn. The loop's own messages (directives, acknowledgements, iterations, verdicts, errors) " +
      'are posted here for the role that sent them, or by the orchestrator.'
    );
  }
  if (role === 'coder') {
    return (
      'Your iter_complete and request_clarification blocks are how you report; the loop reads only those. ' +
      `Post FAIL or ASK @${names.planner} when you hit something the Planner must know before your next directive, ` +
      'and WIN with the exact change and what you measured. The Reviewer judges each iteration from its artifacts, not from posts.'
    );
  }
  return (
    'Your review_complete verdict is posted here for you after every review; you need not post it. ' +
    'Rule 2 stands: the forum is not a way to ask the Planner or the Coder anything.'
  );
}

/** How each role joins: the Planner cannot write, the Reviewer writes and is told nothing it is not named in. */
function joinOptions(role: AutoloopRoleName): ForumJoinOptions {
  if (role === 'planner') return { readOnly: true };
  if (role === 'reviewer') return { readOnly: true, canRead: false, push: 'none' };
  return {};
}

function briefOptions(role: AutoloopRoleName, names: Record<AutoloopRoleName, string>): ForumBriefOptions {
  const norms = roleNorms(role, names);
  // The Planner's forum fills with the loop's own posts; it gets what is open
  // for it, not a listing of every title.
  if (role === 'planner') return { readOnly: true, compact: true, norms };
  // The Reviewer writes only in its sandbox (Rule 3): it posts by reply block.
  // Of the user's posts it is told only those that name it: its turn stays the artifacts.
  if (role === 'reviewer') return { readOnly: true, canRead: false, norms, userPosts: 'named' };
  return { norms };
}

export class AutoloopForumBridge {
  private readonly members: Partial<Record<AutoloopRoleName, Membership>> = {};
  /** Roles whose turn is in flight now: the only time a post is handed to one mid-turn. */
  private readonly inTurn = new Set<AutoloopRoleName>();
  /** Envelopes already mirrored, by `msg_id`, on the forum before this bridge too. */
  private readonly mirrored = new Set<string>();
  /** Names that joined the forum before this bridge was made: a resumed run's roles. */
  private readonly priorMembers = new Set<string>();
  private readonly joinedHere = new Set<AutoloopRoleName>();
  private readonly pending = new Set<Promise<unknown>>();
  /** Each role's envelopes on their way to the forum: posts that are its turn, not yet on record as that. */
  private readonly turnWrites: Partial<Record<AutoloopRoleName, Set<Promise<unknown>>>> = {};
  /** The turn message each role was last given, until it is sent. */
  private readonly unsent: Partial<Record<AutoloopRoleName, UnsentTurn>> = {};
  /**
   * Posts this process handed to a role: with a turn it sent, or mid-turn. Kept
   * here, not read from the forum's delivery records, which agents can write.
   */
  private readonly handed = new Set<string>();
  private detachSource: (() => void) | undefined;
  private closed = false;
  /** False when a role name is not a forum name: then nothing is posted and no role joins. */
  private readonly writable: boolean;

  constructor(
    readonly target: AutoloopForumTarget,
    private readonly opts: AutoloopForumBridgeOptions,
  ) {
    this.writable = ROLES.every((r) => isForumName(target.names[r]));
    if (!this.writable) {
      this.warn(`role names ${ROLES.map((r) => target.names[r]).join(', ')} are not forum names; nothing is posted`);
      return;
    }
    let snapshot: ReturnType<typeof forumSnapshot> = { posts: [], events: [] };
    try {
      snapshot = forumSnapshot(target.id);
    } catch {
      // No forum yet: nothing mirrored, nobody joined.
    }
    for (const p of snapshot.posts) {
      const id = p.via === 'envelope' ? p.data?.msg_id : undefined;
      if (typeof id === 'string') this.mirrored.add(id);
    }
    for (const e of snapshot.events) if (e.type === 'join') this.priorMembers.add(e.who);
  }

  get id(): string {
    return this.target.id;
  }

  get exposed(): boolean {
    return this.target.exposed && this.writable;
  }

  nameOf(role: AutoloopRoleName): string {
    return this.target.names[role];
  }

  isMember(role: AutoloopRoleName): boolean {
    return this.members[role] !== undefined;
  }

  // ─── Membership ──────────────────────────────────────────────────────────

  /**
   * Whether `role` was on the forum before, so a session that continues its
   * conversation already holds the brief. `acrossRuns`: count a membership from
   * before this bridge (a resumed run), for an engine that resumes its
   * conversation.
   */
  wasMember(role: AutoloopRoleName, opts: { acrossRuns: boolean }): boolean {
    return this.joinedHere.has(role) || (opts.acrossRuns && this.priorMembers.has(this.nameOf(role)));
  }

  /**
   * Put a role's new session on the forum, in place of any earlier one.
   * `brief`: its next message carries the brief (a conversation that continues
   * has it already).
   */
  join(role: AutoloopRoleName, session: string, opts: { brief: boolean; cwd?: string }): void {
    if (!this.exposed || this.closed) return;
    // The hub's join replaces an earlier member of the same name and records
    // the new join; leaving first would record that leave after it.
    delete this.members[role];
    const name = this.nameOf(role);
    const deliver: Deliver = async (text, ids) => {
      if (!this.inTurn.has(role) || this.members[role]?.session !== session) return false;
      // Posts the turn in flight carries: not handed to the role a second time.
      // `turnSent` puts them on record once it is sent; a failed send leaves
      // them unrecorded, for the next turn to carry.
      if (this.carries(role, ids)) return 'queued';
      if (!this.opts.deliverMidTurn) return false;
      const ok = await this.opts.deliverMidTurn(session, text);
      if (ok === true) for (const id of ids) this.handed.add(id);
      return ok;
    };
    try {
      const hub = forumHub(this.target.id, this.target.config);
      const leave = hub.join(name, deliver, { ...joinOptions(role), ...(opts.cwd ? { cwd: opts.cwd } : {}) });
      this.members[role] = {
        session,
        leave,
        briefPending: opts.brief,
        relay: new ForumReplyRelay(this.target.id, name, this.opts.logger),
      };
      this.joinedHere.add(role);
    } catch (err) {
      this.warn(`${name} could not join: ${(err as Error).message}`);
    }
  }

  /** Take a role off the forum (its session stopped). */
  leave(role: AutoloopRoleName): void {
    const m = this.members[role];
    if (!m) return;
    delete this.members[role];
    this.inTurn.delete(role);
    try {
      m.leave();
    } catch (err) {
      this.warn(`${this.nameOf(role)} could not leave: ${(err as Error).message}`);
    }
  }

  leaveAll(): void {
    for (const role of ROLES) this.leave(role);
  }

  // ─── Turns ───────────────────────────────────────────────────────────────

  /**
   * The message a role's turn sends: `message` unchanged, then the brief when
   * the session is new, then (Planner and Coder) the posts for it it has not
   * had. Nothing is on record until `turnSent`: a turn that is never sent
   * leaves both for the next one.
   */
  turnMessage(role: AutoloopRoleName, message: string): string {
    delete this.unsent[role];
    const m = this.members[role];
    if (!m) return message;
    const parts: string[] = [];
    const name = this.nameOf(role);
    const turn: UnsentTurn = { brief: m.briefPending, inbox: [], handed: [] };
    if (m.briefPending) {
      try {
        parts.push(
          forumBrief(this.target.id, name, forumTeamOf(this.target.id), this.target.config, {
            ...briefOptions(role, this.target.names),
            onUserPosts: (ids) => turn.handed.push(...ids),
          }),
        );
      } catch (err) {
        this.warn(`no brief for ${name}: ${(err as Error).message}`);
      }
    }
    // The Reviewer works from the iteration's artifacts alone.
    if (role !== 'reviewer') {
      try {
        const inbox = forumTurnInboxParts(this.target.id, name, { readOnly: role === 'planner' });
        if (inbox.text) parts.push(inbox.text);
        turn.inbox = inbox.ids;
        turn.handed.push(...inbox.ids);
      } catch (err) {
        this.warn(`no turn inbox for ${name}: ${(err as Error).message}`);
      }
    }
    this.unsent[role] = turn;
    return parts.length ? `${message}${FORUM_APPENDIX_SEPARATOR}${parts.join('\n\n')}` : message;
  }

  /**
   * The message `turnMessage` last made for `role` was sent: the posts after it
   * are on record as handed over in a turn, and its brief is not given again.
   */
  turnSent(role: AutoloopRoleName): void {
    const turn = this.unsent[role];
    if (!turn) return;
    delete this.unsent[role];
    // A session started again for the same message (a reset and retry) was handed the brief with it.
    const m = this.members[role];
    if (turn.brief && m) m.briefPending = false;
    for (const id of turn.handed) this.handed.add(id);
    if (turn.inbox.length === 0) return;
    try {
      forumMarkDelivered(this.target.id, this.nameOf(role), turn.inbox, 'turn');
    } catch (err) {
      this.warn(`could not record the posts handed to ${this.nameOf(role)}: ${(err as Error).message}`);
    }
  }

  /** Whether the message `turnMessage` last made for `role`, not yet on record as sent, carries every post of `ids`. */
  private carries(role: AutoloopRoleName, ids: string[]): boolean {
    const turn = this.unsent[role];
    return !!turn && ids.length > 0 && ids.every((id) => turn.handed.includes(id));
  }

  /** Whether this process handed post `id` to a role: with a turn it sent, or mid-turn. */
  handedOver(id: string): boolean {
    return this.handed.has(id);
  }

  /** The role's turn is in flight until the returned call: posts for it are handed to it now. */
  beginTurn(role: AutoloopRoleName): () => void {
    this.inTurn.add(role);
    return () => {
      this.inTurn.delete(role);
    };
  }

  /** Post the `<new-forum-post>` blocks of a role's reply under its name. */
  relay(role: AutoloopRoleName, reply: string): ForumPost[] {
    const m = this.members[role];
    if (!m || !reply) return [];
    return m.relay.take(reply);
  }

  /** A reply as the user sees it: without the blocks that were posted from it. */
  strip(text: string): string {
    return this.exposed ? stripForumBlocks(text) : text;
  }

  // ─── The mirror ──────────────────────────────────────────────────────────

  /** Mirror the runner's envelopes from now on. */
  attach(source: AutoloopMessageSource): void {
    this.detachSource?.();
    const fromAgent = (env: AnyAutoloopMessage): boolean => source.emittedByAgent?.(env) ?? false;
    const onMessage = (...args: unknown[]): void => {
      const env = args[0] as AnyAutoloopMessage | undefined;
      if (env && typeof env === 'object') this.mirror(env, fromAgent(env));
    };
    // push_user is mirrored when it is pushed: a repeat inside the runner's
    // dedup window (the stall check re-queues one every interval) is not.
    const onPush = (...args: unknown[]): void => {
      const env = args[1] as AnyAutoloopMessage | undefined;
      if (env && typeof env === 'object' && env.type === 'push_user') this.mirrorPush(env, fromAgent(env));
    };
    source.on('message', onMessage);
    source.on('push', onPush);
    this.detachSource = () => {
      source.off('message', onMessage);
      source.off('push', onPush);
      this.detachSource = undefined;
    };
  }

  /** The user's chat, mirrored as the user's post when it becomes the Planner's turn. */
  mirrorChat(env: AnyAutoloopMessage): void {
    if (env.type !== 'chat' || !this.claim(env)) return;
    const planner = this.nameOf('planner');
    const text = env.payload.text ?? '';
    this.write(
      {
        from: 'user',
        title: `INFO @${planner}: ${firstLine(text) || 'chat'}`,
        body: text,
        to: [planner],
        // Written to the Planner: an @name in it does not address another role.
        mentions: false,
        via: 'envelope',
        data: { type: env.type, iter: env.iter, msg_id: env.msg_id },
        fullPath: path.join(this.opts.ledgerDir, 'chat.jsonl'),
      },
      'planner',
    );
  }

  /** A Planner turn whose controls were refused: the Planner hears of it at its next turn. */
  controlRejected(iter: number, dispatchId: string, diagnostic: string): void {
    const planner = this.nameOf('planner');
    this.write({
      from: 'orchestrator',
      title: `FAIL @${planner}: control rejected (iter ${iter})`,
      body: diagnostic,
      to: [planner],
      data: { type: 'control_rejected', iter, dispatch_id: dispatchId },
    });
  }

  /** The Coder's `coder_log` entries, as its INFO posts. */
  coderLog(iter: number, messages: string[]): void {
    for (const message of messages) {
      this.write({
        from: this.nameOf('coder'),
        title: `INFO: ${firstLine(message) || 'coder log'}`,
        body: message,
        via: 'reply',
        data: { type: 'coder_log', iter },
      });
    }
  }

  /**
   * Settles once the envelopes that are `role`'s turn are posted and on record
   * as handed to it; undefined when none is on its way.
   */
  turnWritten(role: AutoloopRoleName): Promise<unknown> | undefined {
    const writes = this.turnWrites[role];
    if (!writes?.size) return undefined;
    // A write never rejects: its errors are logged where it is made.
    return writes.size === 1 ? [...writes][0] : Promise.all(writes);
  }

  /** Wait for the posts in flight. */
  async flush(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  /** Stop mirroring and take every role off the forum. */
  close(): void {
    this.detachSource?.();
    this.leaveAll();
    this.closed = true;
  }

  private mirror(env: AnyAutoloopMessage, fromAgent: boolean): void {
    // chat is mirrored as the Planner's turn, push_user as it is pushed;
    // review_request stays between the runner and the Reviewer, and iter_done
    // is the verdict again.
    if (env.type === 'chat' || env.type === 'push_user' || env.type === 'review_request' || env.type === 'iter_done') {
      return;
    }
    const input = this.envelopePost(env, fromAgent);
    if (!input || !this.claim(env)) return;
    // An envelope bound for a role is that role's turn: it is not handed to it again.
    this.write(input, isRole(env.to) ? env.to : undefined);
  }

  private mirrorPush(env: AnyAutoloopMessage, fromAgent: boolean): void {
    if (env.type !== 'push_user' || !this.claim(env)) return;
    const p = env.payload;
    const tag = p.level === 'decision' ? 'ASK' : p.level === 'error' ? 'FAIL' : 'INFO';
    this.write({
      from: this.authorOf(env, fromAgent),
      title: `${tag}: ${firstLine(p.summary) || p.level}`,
      body: [p.detail ? bounded(p.detail, BODY_TEXT_CHARS) : '', `Pushed to the user (${p.level}, ${p.channel}).`]
        .filter(Boolean)
        .join('\n\n'),
      to: ['user'],
      via: 'envelope',
      data: { type: env.type, iter: env.iter, msg_id: env.msg_id },
    });
  }

  /** An envelope's post: from the role that sent it, or the orchestrator for the runner and operators. */
  private envelopePost(env: AnyAutoloopMessage, fromAgent: boolean): ForumRuntimePostInput | undefined {
    const n = this.target.names;
    const from = this.authorOf(env, fromAgent);
    const data = { type: env.type, iter: env.iter, msg_id: env.msg_id };
    const iterDir = path.join(this.opts.ledgerDir, 'iter', String(env.iter));
    const base = { from, via: 'envelope' as const };
    switch (env.type) {
      case 'directive': {
        const p = env.payload;
        const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : v ? [String(v)] : []);
        const constraints = list(p.constraints);
        const criteria = list(p.success_criteria);
        return {
          ...base,
          title: `INFO @${n.coder}: iter ${env.iter} directive — ${firstLine(String(p.goal ?? '')) || 'no goal'}`,
          body: [
            `Goal: ${bounded(String(p.goal ?? ''), BODY_TEXT_CHARS)}`,
            constraints.length ? `Constraints:\n${constraints.map((c) => `  - ${c}`).join('\n')}` : '',
            criteria.length ? `Success criteria:\n${criteria.map((c) => `  - ${c}`).join('\n')}` : '',
            `Max attempts: ${p.max_attempts}`,
            `Directive: ${path.join(iterDir, 'directive.json')}`,
          ]
            .filter(Boolean)
            .join('\n\n'),
          to: [n.coder],
          data,
        };
      }
      case 'directive_ack': {
        const p = env.payload;
        if (p.understood) {
          return {
            ...base,
            title: `INFO @${n.planner}: iter ${env.iter} directive acknowledged`,
            to: [n.planner],
            data,
          };
        }
        const question = p.clarification ?? '';
        return {
          ...base,
          title: `ASK @${n.planner}: iter ${env.iter} — ${firstLine(question) || 'the Coder needs a clarification'}`,
          body: bounded(question, BODY_TEXT_CHARS),
          to: [n.planner],
          data,
        };
      }
      case 'iter_artifacts': {
        const p = env.payload;
        const files = Array.isArray(p.files_changed) ? p.files_changed.map(String) : [];
        const summary = this.coderSummary(iterDir);
        let evaluation: string;
        try {
          evaluation = JSON.stringify(p.eval_output) ?? 'none';
        } catch {
          evaluation = String(p.eval_output);
        }
        const listed = files.slice(0, LISTED_FILES).join(', ');
        const more = files.length > LISTED_FILES ? `, and ${files.length - LISTED_FILES} more` : '';
        return {
          ...base,
          title: `DONE: iter ${env.iter} — ${firstLine(summary) || `${files.length} file(s) changed`}`,
          body: [
            summary ? bounded(summary, BODY_TEXT_CHARS) : '',
            `Files changed (${files.length})${files.length ? `: ${listed}${more}` : ''}`,
            `Evaluation: ${bounded(evaluation, EVAL_OUTPUT_CHARS)}`,
            `Diff: ${path.join(iterDir, 'diff.patch')}`,
            `Evaluation output: ${path.join(iterDir, 'eval_output.json')}`,
          ]
            .filter(Boolean)
            .join('\n\n'),
          data,
        };
      }
      case 'review_verdict': {
        const p = env.payload;
        const metric = typeof p.metric === 'number' ? ` (metric ${p.metric})` : '';
        const tag = p.decision === 'advance' ? 'WIN' : 'FAIL';
        return {
          ...base,
          title: `${tag}: iter ${env.iter} ${p.decision}${metric}`,
          body: [
            bounded(p.audit_notes ?? '', BODY_TEXT_CHARS),
            p.accepted ? `Acceptance contract: passed (evidence ${p.evidence_id ?? 'recorded'}).` : '',
            `Verdict: ${path.join(iterDir, 'verdict.json')}`,
          ]
            .filter(Boolean)
            .join('\n\n'),
          // The Planner decides what happens next; it hears the audit with its next turn.
          direct: [n.planner],
          data: {
            ...data,
            decision: p.decision,
            metric: p.metric,
            ...(p.accepted ? { accepted: true, evidence_id: p.evidence_id } : {}),
          },
        };
      }
      case 'phase_error': {
        const p = env.payload;
        return {
          ...base,
          title: `FAIL @${n.planner}: ${p.agent} ${p.phase} error (iter ${env.iter})`,
          body: bounded(p.error ?? '', BODY_TEXT_CHARS),
          to: [n.planner],
          data,
        };
      }
      case 'send_timeout': {
        const p = env.payload;
        return {
          ...base,
          title: `FAIL @${n.planner}: ${p.agent} turn timed out (iter ${env.iter})`,
          body:
            `${bounded(p.error ?? '', BODY_TEXT_CHARS)}\n\n` +
            `The run is paused until a resume names dispatch ${p.dispatch_id} with a sendTimeoutMs above ${p.timeout_ms}.`,
          to: [n.planner],
          data: { ...data, dispatch_id: p.dispatch_id },
        };
      }
      case 'pause':
        return {
          ...base,
          title: `INFO: loop paused — ${firstLine(env.payload.reason) || 'no reason'}`,
          to: ['user'],
          data,
        };
      case 'resume':
        return { ...base, title: 'INFO: loop resumed', to: ['user'], data };
      case 'terminate':
        return {
          ...base,
          title: `INFO: loop terminated — ${firstLine(env.payload.reason) || 'no reason'}`,
          to: ['user'],
          data,
        };
      default:
        return undefined;
    }
  }

  private authorOf(env: AnyAutoloopMessage, fromAgent: boolean): string {
    return fromAgent && isRole(env.from) ? this.nameOf(env.from) : 'orchestrator';
  }

  /** The Coder's own summary of an iteration, from the ledger. */
  private coderSummary(iterDir: string): string {
    try {
      const text = fs.readFileSync(path.join(iterDir, 'coder_summary.txt'), 'utf8');
      return text.split('\n\n--- coder cleaned reply ---')[0].trim();
    } catch {
      return '';
    }
  }

  /** True the first time an envelope is seen. */
  private claim(env: AnyAutoloopMessage): boolean {
    if (!this.writable || this.closed || typeof env.msg_id !== 'string') return false;
    if (this.mirrored.has(env.msg_id)) return false;
    this.mirrored.add(env.msg_id);
    return true;
  }

  /** Write a post; `turnOf`: the role whose turn it is, recorded as handed to it that way. */
  private write(input: ForumRuntimePostInput, turnOf?: AutoloopRoleName): void {
    if (!this.writable || this.closed) return;
    let pending: Promise<unknown>;
    try {
      pending = (this.target.post ?? ((i) => this.defaultPost(i)))(input)
        .then((post) => {
          if (post && turnOf && this.exposed) {
            forumMarkDelivered(this.target.id, this.nameOf(turnOf), [post.id], 'turn');
          }
        })
        .catch((err: unknown) => this.warn(`could not post "${input.title}": ${(err as Error).message}`));
    } catch (err) {
      this.warn(`could not post "${input.title}": ${(err as Error).message}`);
      return;
    }
    this.pending.add(pending);
    void pending.finally(() => this.pending.delete(pending));
    if (turnOf) {
      const writes = (this.turnWrites[turnOf] ??= new Set());
      writes.add(pending);
      void pending.finally(() => writes.delete(pending));
    }
  }

  private async defaultPost(input: ForumRuntimePostInput): Promise<ForumPost | undefined> {
    try {
      return (await forumRuntimePost(this.target.id, input)).post;
    } catch (err) {
      this.warn(`could not post "${input.title}": ${(err as Error).message}`);
      return undefined;
    }
  }

  private warn(msg: string): void {
    this.opts.logger?.warn?.(`[autoloop forum ${this.target.id}] ${msg}`);
  }
}

// ─── Following a forum ──────────────────────────────────────────────────────

/** A post as an event stream carries it: what it is and who it speaks for, not its body. */
export interface ForumPostEvent {
  id: string;
  ts: string;
  from: string;
  authority: ForumAuthority;
  tags: string[];
  to: string[];
  title: string;
}

/**
 * Call `onPost` for each post the forum's durable copy gains from now on, every
 * `intervalMs`. The runtime's posts are stored as they are written; an agent's
 * reach the store within a second while the forum has members. Returns the call
 * that stops it.
 */
export function followForumPosts(
  forumId: string,
  onPost: (post: ForumPostEvent) => void,
  intervalMs = 1_000,
): () => void {
  const file = path.join(forumLocation(forumId).store, 'posts.jsonl');
  const size = (): number => {
    try {
      return fs.statSync(file).size;
    } catch {
      return 0;
    }
  };
  let offset = size();
  const seen = new Set<string>();
  const poll = (): void => {
    const end = size();
    if (end < offset) offset = 0;
    if (end <= offset) return;
    let chunk: Buffer;
    try {
      const fd = fs.openSync(file, 'r');
      try {
        chunk = Buffer.alloc(end - offset);
        fs.readSync(fd, chunk, 0, chunk.length, offset);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return;
    }
    // Whole lines only; a line still being written waits for the next poll.
    const last = chunk.lastIndexOf(0x0a);
    if (last < 0) return;
    offset += last + 1;
    for (const line of chunk.subarray(0, last).toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      let p: ForumPost;
      try {
        p = JSON.parse(line) as ForumPost;
      } catch {
        continue;
      }
      if (!p || typeof p.id !== 'string' || typeof p.title !== 'string' || seen.has(p.id)) continue;
      seen.add(p.id);
      try {
        onPost({
          id: p.id,
          ts: p.ts,
          from: p.from,
          authority: forumAuthority(forumId, p),
          tags: Array.isArray(p.tags) ? p.tags : [],
          to: Array.isArray(p.to) ? p.to : [],
          title: p.title,
        });
      } catch {
        // A listener that throws loses that event only.
      }
    }
  };
  const timer = setInterval(poll, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
