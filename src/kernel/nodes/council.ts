/**
 * `council` node — wraps the existing Council engine.
 *
 * The behavioural change is what "done" means. Council used to terminate on
 * `[CONSENSUS: YES]` from every agent, i.e. on a regex over agent prose. Here the
 * votes are still collected and recorded — they are useful, and they are what the
 * agents were asked for — but they are advisory. Whether the run is acceptable is
 * decided downstream by a verifier node against a contract.
 *
 * The seats talk through the run's forum. Each seat's round report is posted for
 * it when the round ends, and the history block of the next round's prompt is
 * rendered from those posts. The user's posts (`council_inject`, steers) reach
 * every seat's next round prompt. On an exposed forum a seat is also a member
 * for its round: briefed, pushed to, and its reply blocks posted. The votes
 * themselves never come from a post: they are read from each seat's own reply.
 */

import type { NodeContext, NodeResult, SteerEntry } from '../engine.js';
import { parseConsensusWithSource, stripConsensusTags } from '../../consensus.js';
import { councilHistoryEntries } from '../../council.js';
import { DEFAULT_MAX_ROUNDS } from '../../constants.js';
import type { AgentResponse, CouncilConfig, CouncilForumReview } from '../../types.js';
import type { CouncilNode, NodeSpec, RunRecord } from '../types.js';
import type { ConsensusVote } from '../types.js';
import {
  ForumReplyRelay,
  forumAuthority,
  forumBrief,
  forumHub,
  forumMarkDelivered,
  forumPosts,
  forumRuntimeAppend,
  forumSnapshot,
  forumTeamOf,
  isForumName,
  isReservedForumName,
  isVouched,
  runForum,
  type ForumPost,
} from '../forum.js';
import { councilSeatsAreForumNames } from '../forum/roster.js';
import { councilNodeId, type CouncilForumLedger, type CouncilNodeData } from '../projections.js';

export async function executeCouncilNode(node: NodeSpec, ctx: NodeContext): Promise<NodeResult> {
  const spec = node as CouncilNode;
  if (!ctx.manager) return { ok: false, error: 'council node requires a session manager' };
  const maxRounds = spec.maxRounds ?? DEFAULT_MAX_ROUNDS;
  const resumed = resumedRounds(ctx, spec);
  const previousResponses = resumed?.responses;
  // What this execution hands out on the forum, carried over for the rounds a resume keeps.
  const forumLedger: CouncilForumLedger = resumed?.ledger ?? { reports: {}, handed: {} };

  // Same story as the fan-out node: forward every field. Dropping
  // `customEngine` here did not merely lose configuration — a council agent on a
  // custom engine could not start at all without it.
  const customEngines = (ctx.secrets.agentCustomEngines ?? {}) as Record<string, unknown>;
  const { Council } = await import('../../council.js');
  const council = new Council(
    {
      runId: ctx.runId,
      agents: spec.agents.map((a) => ({
        name: a.name,
        emoji: a.emoji ?? '',
        persona: a.persona ?? a.prompt ?? '',
        engine: a.engine,
        model: a.model,
        acpAgent: a.acpAgent,
        baseUrl: a.baseUrl,
        permissionMode: a.permissionMode as never,
        sandboxMode: a.sandboxMode,
        effort: a.effort as never,
        ultracode: a.ultracode,
        customEngine: customEngines[a.name] as never,
      })),
      maxRounds,
      projectDir: spec.projectDir || ctx.cwd,
      agentTimeoutMs: spec.agentTimeoutMs ?? spec.timeoutMs,
      maxTurnsPerAgent: spec.maxTurnsPerAgent,
      // The node's per-agent cap, held to what is left of the run's.
      maxBudgetUsd: minDefined(spec.maxBudgetUsd, ctx.budgetUsd),
      defaultPermissionMode: spec.defaultPermissionMode as never,
      // A cancelled run, or an attempt the kernel timed out, must not keep opening rounds.
      signal: ctx.signal,
      ...(previousResponses ? { previousResponses } : {}),
      ...councilForumHooks(ctx, {
        nodeId: spec.id,
        seats: spec.agents,
        defaultPermissionMode: spec.defaultPermissionMode,
        ledger: forumLedger,
      }),
    },
    ctx.manager,
    ctx.logger,
  );

  if (ctx.signal.aborted) return { ok: false, error: 'cancelled' };
  // Published so `council_abort` can reach the running engine. Only meaningful
  // while this process is running it.
  ctx.setHandle(council);
  council.on('council-event', () => {
    const live = council.getSession?.();
    if (live) {
      ctx.publish({
        task: live.task,
        responses: live.responses,
        councilStatus: live.status,
        finalSummary: live.finalSummary,
        compactContext: live.compactContext,
        agents: spec.agents,
        maxRounds,
        projectDir: spec.projectDir || ctx.cwd,
        forumLedger: structuredClone(forumLedger),
      });
    }
  });
  const session = await council.run(spec.task);

  const consensusVotes: ConsensusVote[] = session.responses.map((r) => {
    const { vote, source } = parseConsensusWithSource(r.content ?? '');
    return { agent: r.agent, round: r.round, vote, source };
  });

  // `error` is a real failure; every other terminal status means the council ran.
  // Reaching max rounds without agreement is a result, not a crash — and it is no
  // longer the thing that decides whether the work is acceptable.
  const ok = session.status !== 'error';

  return {
    ok,
    output:
      session.finalSummary ??
      session.responses.map((r) => `## ${r.agent} (round ${r.round})\n\n${r.content}`).join('\n\n'),
    error: ok ? undefined : 'council ended in error',
    // What the agents spent, so the run's cost includes it.
    costUsd: session.costUsd,
    consensusVotes,
    data: {
      task: session.task,
      responses: session.responses,
      councilStatus: session.status,
      finalSummary: session.finalSummary,
      compactContext: session.compactContext,
      agents: spec.agents,
      maxRounds,
      projectDir: spec.projectDir || ctx.cwd,
      forumLedger: structuredClone(forumLedger),
    },
  };
}

function minDefined(a: number | undefined, b: number | undefined): number | undefined {
  return a === undefined ? b : b === undefined ? a : Math.min(a, b);
}

/**
 * The rounds a previous process finished, for a council the resume found
 * interrupted: every round, from the first, in which each seat has a response
 * on the record. The council carries on with the round after them, with what
 * those rounds handed out on the forum.
 */
function resumedRounds(
  ctx: NodeContext,
  spec: CouncilNode,
): { responses: AgentResponse[]; ledger: CouncilForumLedger } | undefined {
  const rec = ctx.record.nodes[spec.id];
  if (!rec?.interrupted) return undefined;
  const data = rec.data as Partial<CouncilNodeData> | undefined;
  if (!data || !Array.isArray(data.responses) || (data.task ?? '').trim() !== spec.task.trim()) return undefined;
  const responses = data.responses;
  let done = 0;
  for (let round = 1; ; round++) {
    const seats = new Set(responses.filter((r) => r.round === round).map((r) => r.agent));
    if (!spec.agents.every((a) => seats.has(a.name))) break;
    done = round;
  }
  if (done === 0) return undefined;
  ctx.logger.info?.(
    `[council ${ctx.runId}] resumed: rounds 1-${done} are on the record; carrying on with round ${done + 1}`,
  );
  return { responses: responses.filter((r) => r.round <= done), ledger: ledgerUpTo(data.forumLedger, done) };
}

/** A recorded ledger's entries for rounds `1..done`, the rounds a resume keeps; the rest run again. */
function ledgerUpTo(recorded: unknown, done: number): CouncilForumLedger {
  const out: CouncilForumLedger = { reports: {}, handed: {} };
  const src = recorded as Partial<CouncilForumLedger> | undefined;
  for (const [seat, rounds] of Object.entries(src?.reports ?? {})) {
    for (const [round, id] of Object.entries(rounds ?? {})) {
      if (Number(round) <= done && typeof id === 'string') (out.reports[seat] ??= {})[round] = id;
    }
  }
  for (const [seat, ids] of Object.entries(src?.handed ?? {})) {
    for (const [id, round] of Object.entries(ids ?? {})) {
      if (typeof round === 'number' && round <= done) (out.handed[seat] ??= {})[id] = round;
    }
  }
  return out;
}

// ─── The run forum ──────────────────────────────────────────────────────────

/** A seat as the forum hooks need it. */
export interface CouncilSeat {
  name: string;
  permissionMode?: string;
  sandboxMode?: string;
}

/** One seat's round, once its report (or its failure) is on the forum. */
export interface CouncilRoundReport {
  round: number;
  /** The seat's name in the council (not prefixed). */
  agent: string;
  /** The seat's vote, from its own reply. Absent for a seat whose round failed. */
  vote?: boolean;
  error?: string;
  /** The post written for it, when it could be written. */
  postId?: string;
}

/** What a seat's round report on the forum carries of its reply: all of it up to this, else its end. */
export const ROUND_REPORT_CHARS = 60_000;

/**
 * The body of a seat's round report: its reply without the consensus tag. A
 * reply past `ROUND_REPORT_CHARS` keeps its end, where the report and the vote
 * are, so the history block built from the post is the one built from the reply.
 */
export function roundReportBody(content: string): string {
  const clean = stripConsensusTags(content);
  if (clean.length <= ROUND_REPORT_CHARS) return clean;
  return (
    `[… ${clean.length - ROUND_REPORT_CHARS} characters cut from the start; the whole reply is in council_status]\n` +
    clean.slice(-ROUND_REPORT_CHARS)
  );
}

/** What the seats are asked of the forum, in place of the brief's default sentences. */
export function councilForumNorms(readOnly: boolean): string {
  const re = readOnly ? 're' : '--re';
  return (
    'Your round report is posted for you when your turn ends, so do not post a DONE for it. ' +
    'Your vote stays the [CONSENSUS: YES] or [CONSENSUS: NO] tag at the end of your reply, and task claims stay in plan.md. ' +
    `Post ASK @name when you need something from another seat during this round, and FAIL @name when you find a problem in its part; answer one with ${re} and its id. ` +
    `Post your reviews here: WIN: approve @name … or FAIL @name: request changes …, with ${re} naming the round report you reviewed.`
  );
}

/** A user's post as it goes into a seat's `## User Injection`: an injected message or a steer as written, else title and body. */
function injectionText(p: ForumPost): string {
  const kind = (p.data as { kind?: unknown } | undefined)?.kind;
  if (kind === 'inject' || kind === 'steer') return p.body || p.title;
  return p.body ? `${p.title}\n\n${p.body}` : p.title;
}

/**
 * The run-forum side of a council: the hooks a `Council` takes, for the run
 * `ctx` belongs to. Round reports are posted on the run's forum whether or not
 * its agents are on it; the user's posts reach the next round's prompts either
 * way. On an exposed forum each seat is also a member for its round. Seats whose
 * names cannot be forum names are left off it (`councilWorkflow` turns such a
 * council's forum off), and their rounds are not posted.
 */
export function councilForumHooks(
  ctx: NodeContext,
  opts: {
    /** The node the council runs in. */
    nodeId: string;
    seats: CouncilSeat[];
    defaultPermissionMode?: string;
    /** Called for each seat's round result once it is posted (UltraApp's build events). */
    onRoundReport?: (report: CouncilRoundReport) => void;
    /**
     * Where the hooks record what they hand out: the node keeps it with its
     * data for a resume. A fresh one when absent.
     */
    ledger?: CouncilForumLedger;
  },
): Partial<CouncilConfig> {
  const forum = runForum(ctx.record);
  const ledger: CouncilForumLedger = opts.ledger ?? { reports: {}, handed: {} };
  // A run bound to another run's forum under one agent name cannot give its
  // seats names of their own there. The seats' own names are held to the
  // roster's test as well, so a seat is a member only when the roster lists it.
  const memberOf = (seat: string): string | undefined => (forum.agent ? undefined : `${forum.prefix ?? ''}${seat}`);
  const named =
    councilSeatsAreForumNames(opts.seats.map((s) => s.name)) &&
    opts.seats.every((s) => {
      const m = memberOf(s.name);
      return m !== undefined && isForumName(m) && !isReservedForumName(m);
    });
  const visit = ctx.record.nodes[opts.nodeId]?.visits ?? 1;
  const exposed = forum.exposed && named;
  const readOnly = (agent: string): boolean => {
    const seat = opts.seats.find((s) => s.name === agent);
    return seat?.sandboxMode === 'read-only' || (seat?.permissionMode ?? opts.defaultPermissionMode) === 'plan';
  };
  const warn = (msg: string) => ctx.logger.warn?.(`[council ${ctx.runId}] ${msg}`);

  // User posts made before the run reached this node were for the nodes before it.
  const since = Object.values(ctx.record.nodes)
    .filter((n) => n.id !== opts.nodeId && n.endedAt)
    .reduce((max, n) => (n.endedAt! > max ? n.endedAt! : max), '');
  const seatNames = opts.seats.map((s) => memberOf(s.name) ?? s.name);
  let steerRound = 0;
  let steers: SteerEntry[] = [];

  const hooks: Partial<CouncilConfig> = {
    runId: ctx.runId,
    takeInjections: (round, agent) => {
      // Steers go to the council: taken once a round, so the next agent node is
      // not handed them again. One written as a post comes with the posts.
      if (round !== steerRound) {
        steerRound = round;
        steers = ctx.takeSteerEntries();
      }
      const who = memberOf(agent) ?? agent;
      // What this seat was handed is the council's own record, never the
      // forum's delivery events, which any agent of the run can write.
      const handed = (ledger.handed[agent] ??= {});
      const had = new Set(Object.keys(handed));
      let pending: ForumPost[] = [];
      try {
        pending = userPostsFor(forum.id, who, seatNames, since, had);
      } catch (err) {
        warn(`could not read the user's posts for ${who}: ${(err as Error).message}`);
      }
      const ids = new Set(pending.map((p) => p.id));
      const texts = pending.map(injectionText);
      for (const id of ids) handed[id] = round;
      for (const s of steers) {
        if (s.postId && (ids.has(s.postId) || had.has(s.postId))) continue;
        texts.push(s.text);
        if (s.postId) handed[s.postId] = round;
      }
      // The forum's own record of the hand-over, for its readers; nothing here reads it back.
      if (ids.size) {
        try {
          forumMarkDelivered(forum.id, who, [...ids], 'turn');
        } catch (err) {
          warn(`could not record the user's posts handed to ${who}: ${(err as Error).message}`);
        }
      }
      return texts;
    },
  };
  if (!named) return hooks;

  // Each seat's round report, posted for it; the history block is built from
  // these. The vote it carries is a mirror: the count is taken from the replies.
  hooks.onRoundEnd = async (round, results) => {
    for (const r of results) {
      const member = memberOf(r.agent)!;
      if ('response' in r) {
        const vote = r.response.consensus;
        const post = await ctx.forumPost({
          from: member,
          title: `DONE: R${round} report — vote ${vote ? 'YES' : 'NO'}`,
          body: roundReportBody(r.response.content),
          via: 'round',
          data: { round, vote, node: opts.nodeId, visit },
        });
        if (post) (ledger.reports[r.agent] ??= {})[String(round)] = post.id;
        opts.onRoundReport?.({ round, agent: r.agent, vote, ...(post ? { postId: post.id } : {}) });
      } else {
        const line = r.error.split('\n')[0].trim();
        const post = await ctx.forumPost({
          from: 'orchestrator',
          title: `FAIL: R${round} @${member} errored: ${line}`,
          body: r.error,
          data: { round, agent: member, error: r.error, node: opts.nodeId, visit },
        });
        opts.onRoundReport?.({ round, agent: r.agent, error: r.error, ...(post ? { postId: post.id } : {}) });
      }
    }
  };
  hooks.history = (_round, responses) => {
    // A seat's report for a round is the post this council wrote for it, by
    // the id it recorded: not another post that claims the seat and round (an
    // earlier council's, or a line written into the spool), and nothing for a
    // seat whose round failed, which keeps its error. The post must also be as
    // it was written (vouched): the spool line under that id can be rewritten,
    // and then the seat keeps its reply. Only the text comes from the post;
    // which replies count and how each seat voted come from the replies.
    const byId = new Map(forumPosts(forum.id, { via: 'round' }).map((p) => [p.id, p]));
    return councilHistoryEntries(responses).map((e) => {
      const id = ledger.reports[e.agent]?.[String(e.round)];
      const post = id ? byId.get(id) : undefined;
      return post && post.from === memberOf(e.agent) && isVouched(forum.id, post) ? { ...e, report: post.body } : e;
    });
  };
  if (!exposed) return hooks;

  const relays = new Map<string, { round: number; relay: ForumReplyRelay }>();
  hooks.forum = true;
  hooks.agentPreface = (agent) => {
    const self = memberOf(agent)!;
    try {
      return forumBrief(forum.id, self, forumTeamOf(forum.id), forum.config, {
        readOnly: readOnly(agent),
        norms: councilForumNorms(readOnly(agent)),
      });
    } catch (err) {
      warn(`no forum brief for ${self}: ${(err as Error).message}`);
      return undefined;
    }
  };
  hooks.onAgentSession = (agent, sessionName, _round, cwd) =>
    forumHub(forum.id, forum.config).join(
      memberOf(agent)!,
      (text) => ctx.manager?.deliverMidTurn?.(sessionName, text) ?? false,
      { cwd, readOnly: readOnly(agent) },
    );
  // A read-only seat posts by writing blocks in its reply; any seat may.
  hooks.onAgentText = (agent, text, round) => {
    let entry = relays.get(agent);
    if (!entry || entry.round !== round) {
      entry = { round, relay: new ForumReplyRelay(forum.id, memberOf(agent)!, ctx.logger) };
      relays.set(agent, entry);
    }
    entry.relay.take(text);
  };
  return hooks;
}

/**
 * The user's posts a seat has not been handed in a round prompt yet: posts the
 * forum's ledger vouches for as the user's, that the seat may see, to it or to
 * the whole run, made since `since`, and not in `had` (the ones the council
 * already handed it).
 */
function userPostsFor(id: string, who: string, seats: string[], since: string, had: Set<string>): ForumPost[] {
  const { posts } = forumSnapshot(id);
  const team = new Set([...forumTeamOf(id), ...seats]);
  // An injected message is for every seat, whoever it names.
  const forAll = (p: ForumPost) =>
    (p.data as { kind?: unknown } | undefined)?.kind === 'inject' ||
    !p.to.some((n) => isReservedForumName(n) || team.has(n));
  return posts.filter(
    (p) =>
      !had.has(p.id) &&
      (!since || p.ts > since) &&
      (p.visibility !== 'to' || p.to.includes(who)) &&
      (p.to.includes(who) || forAll(p)) &&
      forumAuthority(id, p) === 'user',
  );
}

// ─── Reviews ────────────────────────────────────────────────────────────────

/**
 * The reviews a council's seats posted on the forum: a seat's own post (not a
 * runtime one) tagged WIN or FAIL that names another seat, and that answers a
 * round report or says it approves or requests changes.
 */
export function councilForumReviews(id: string, seats: string[]): CouncilForumReview[] {
  const posts = forumPosts(id);
  const reports = new Set(posts.filter((p) => p.via === 'round').map((p) => p.id));
  const out: CouncilForumReview[] = [];
  for (const p of posts) {
    if (p.via !== undefined && p.via !== 'reply') continue;
    if (!seats.includes(p.from)) continue;
    const fail = p.tags.includes('FAIL');
    if (!fail && !p.tags.includes('WIN')) continue;
    const to = p.to.filter((n) => n !== p.from && seats.includes(n));
    if (to.length === 0) continue;
    if (!p.re.some((r) => reports.has(r)) && !/\b(approve[sd]?|request(?:s|ed)? changes)\b/i.test(p.title)) continue;
    out.push({
      id: p.id,
      ts: p.ts,
      from: p.from,
      to,
      verdict: fail ? 'request_changes' : 'approve',
      title: p.title,
      body: p.body,
      re: p.re,
    });
  }
  return out;
}

/** The forum reviews of a run's council, for `council_review`; empty when it has none or the forum cannot be read. */
export function councilReviewsOf(record: RunRecord): CouncilForumReview[] {
  const nodeId = councilNodeId(record);
  const node = record.spec.nodes.find((n) => n.id === nodeId);
  if (!node || node.kind !== 'council') return [];
  try {
    const forum = runForum(record);
    if (forum.agent) return [];
    return councilForumReviews(
      forum.id,
      node.agents.map((a) => `${forum.prefix ?? ''}${a.name}`),
    );
  } catch {
    return [];
  }
}

// ─── council_inject ─────────────────────────────────────────────────────────

/**
 * `council_inject`: the user's message as a post on the run's forum, durable
 * and written from any process. Every seat's next round prompt carries it under
 * `## User Injection`; a seat on an exposed forum that is running now is pushed
 * it as well. Messages add up; none replaces another.
 */
export function councilInjectPost(record: RunRecord, message: string): ForumPost {
  if (!message.trim()) throw new Error('Nothing to inject: the message is empty');
  const first = message.trim().split('\n')[0].replace(/\s+/g, ' ').trim();
  const nodeId = councilNodeId(record);
  return forumRuntimeAppend(runForum(record).id, {
    from: 'user',
    title: `INFO: ${first.length > 110 ? `${first.slice(0, 109)}…` : first}`,
    body: message,
    data: { kind: 'inject', ...(nodeId ? { node: nodeId } : {}) },
  }).post;
}

export { councilNodeId };
