/**
 * Legacy mode shapes, projected from a kernel run.
 *
 * Before 6.0.0 each mode kept its results in its own `Map` on SessionManager,
 * evicted after 30 minutes, gone on restart. The shapes those maps held —
 * `CouncilSession`, `FanoutSession`, `UltraplanResult`, `UltrareviewResult`,
 * `AutoloopState` — are the public contract of the `*_status` tools, so they
 * survive; what changes is where they come from. They are now derived from the
 * durable run record, which is why a fan-out's results are still there tomorrow.
 *
 * Pure functions, no I/O beyond the caller-supplied text and the forum ledger
 * an ASK's author is checked against, so the mapping is testable without
 * starting anything.
 */

import type { AgentResponse, CouncilSession, EngineType, UltraplanResult, UltrareviewResult } from '../types.js';
import type { FanoutAgentResult, FanoutSession } from '../fanout.js';
import { authorLabel, postsInReply, type ForumPost } from './forum.js';
import {
  isTerminalRunState,
  type ContractDrift,
  type NodeRecord,
  type RunRecord,
  type RunResume,
  type RunState,
} from './types.js';

/** Node id used by every single-node legacy workflow, so projections know where to look. */
export const LEGACY_NODE = 'main';

function node(record: RunRecord, id = LEGACY_NODE): NodeRecord | undefined {
  return record.nodes[id];
}

/**
 * The node's declaration, used as the fallback for fields the node has not
 * published yet. A run polled the instant it starts has no `data`, and reading
 * the task out of the spec beats reporting the workflow's name as the task.
 */
function spec<T>(record: RunRecord, id = LEGACY_NODE): T | undefined {
  return record.spec?.nodes?.find((n) => n.id === id) as T | undefined;
}

/** Terminal states that mean "it ran to the end", whatever the verdict was. */
function isDone(state: RunState): boolean {
  return state === 'completed' || state === 'failed' || state === 'cancelled';
}

// ─── Council ────────────────────────────────────────────────────────────────

export interface CouncilNodeData {
  task: string;
  responses: AgentResponse[];
  councilStatus: CouncilSession['status'];
  finalSummary?: string;
  compactContext?: string;
  agents: CouncilSession['config']['agents'];
  maxRounds: number;
  projectDir: string;
  /** What the council handed out on the run forum, kept for a resume. */
  forumLedger?: CouncilForumLedger;
}

/**
 * What a council's own execution handed out on the run forum. It is kept here,
 * with the run, and never read back from the forum's spool, which the council's
 * agents can write.
 */
export interface CouncilForumLedger {
  /** The round report posted for each seat: seat → round → post id. */
  reports: Record<string, Record<string, string>>;
  /** The user's posts and steers each seat's round prompts carried: seat → post id → round. */
  handed: Record<string, Record<string, number>>;
}

/**
 * A run's three answers, kept apart: did its nodes run to the end
 * (`execution`), how often and from where was it resumed (`resume`), and did the
 * work pass which rules (`verification`). A resume that went fine and a
 * verdict that passed are different facts; so are verdicts under different
 * rules, which are never folded into one.
 *
 * Fingerprints a record does not have are `unknown`, never computed after the
 * fact: a record from before fingerprints cannot show which rules its evidence
 * ran under, and saying so is the only honest report.
 */
export interface RunReport {
  /** `suspended`: its process stopped while it was live, and it waits for a resume. */
  execution: 'completed' | 'failed' | 'cancelled' | 'running' | 'suspended' | 'unknown';
  resume: { count: number; last?: RunResume };
  verification: {
    outcome: RunRecord['outcome'];
    outcomeReason?: string;
    evidenceId?: string;
    node?: string;
    /** The rules the current verdict was reached under. */
    contractHash?: string;
    /** The run-level contract the run started with; absent when it has none. */
    runContractHash?: string;
    nodeContractHashes?: Record<string, string>;
    /** The latest resume whose declared rules differed from the run's; the verdict is under the run's. */
    contractDrift?: ContractDrift;
  };
}

export function runReport(record: RunRecord): RunReport {
  const resumes = record.resumes ?? [];
  const drift = [...resumes].reverse().find((r) => r.contractDrift)?.contractDrift;
  const verifierNodes = (record.spec?.nodes ?? []).filter(
    (n) => n.kind === 'verifier' && n.contract && n.contract !== 'run',
  );
  return {
    execution:
      record.execution ?? (isTerminalRunState(record.state) ? 'unknown' : record.suspended ? 'suspended' : 'running'),
    resume: { count: resumes.length, ...(resumes.length ? { last: resumes[resumes.length - 1] } : {}) },
    verification: {
      outcome: record.outcome,
      ...(record.outcomeReason ? { outcomeReason: record.outcomeReason } : {}),
      ...(record.verdict
        ? {
            evidenceId: record.verdict.evidenceId,
            node: record.verdict.node,
            contractHash: record.verdict.contractHash ?? 'unknown',
          }
        : {}),
      ...(record.spec?.contract ? { runContractHash: record.contractHashes?.run ?? 'unknown' } : {}),
      ...(verifierNodes.length
        ? {
            nodeContractHashes: Object.fromEntries(
              verifierNodes.map((n) => [n.id, record.contractHashes?.nodes?.[n.id] ?? 'unknown']),
            ),
          }
        : {}),
      ...(drift ? { contractDrift: drift } : {}),
    },
  };
}

/** A run whose process stopped reads as running; this says it is waiting for a resume. */
function suspension(record: RunRecord): { suspended?: { at: string; reason: string } } {
  return record.suspended && !isDone(record.state) ? { suspended: record.suspended } : {};
}

/**
 * The id of a run's council node. `council_start` names it `main`, the
 * `council` template `council`, and a spec of its own anything: the node the
 * run is on when that is a council, else the council that started last, else
 * the first council in the spec. Undefined for a run with no council node.
 */
export function councilNodeId(record: RunRecord): string | undefined {
  const councils = (record.spec?.nodes ?? []).filter((n) => n.kind === 'council');
  if (councils.length === 0) return undefined;
  if (record.currentNode && councils.some((n) => n.id === record.currentNode)) return record.currentNode;
  let latest: { id: string; at: string } | undefined;
  for (const n of councils) {
    const at = record.nodes?.[n.id]?.startedAt;
    if (at && (!latest || at > latest.at)) latest = { id: n.id, at };
  }
  return latest?.id ?? councils[0].id;
}

export function toCouncilSession(record: RunRecord): CouncilSession {
  const id = councilNodeId(record) ?? LEGACY_NODE;
  const data = node(record, id)?.data as CouncilNodeData | undefined;
  const declared = spec<{ task: string; agents: CouncilSession['config']['agents']; maxRounds?: number }>(record, id);
  // A council that throws during setup publishes `running` on its first event
  // and nothing after, so a finished run would read as running forever.
  const reported = data?.councilStatus === 'running' && isDone(record.state) ? undefined : data?.councilStatus;
  const error = node(record, id)?.error ?? record.error;
  return {
    id: record.runId,
    task: data?.task ?? declared?.task ?? record.workflow,
    config: {
      agents: data?.agents ?? declared?.agents ?? [],
      maxRounds: data?.maxRounds ?? declared?.maxRounds ?? 0,
      projectDir: data?.projectDir ?? record.cwd,
    },
    responses: data?.responses ?? [],
    // The council's own status is preserved when it reported one; otherwise the
    // run's state stands in. A run that was cancelled or failed before the
    // council spoke has no council status to report, and inventing `consensus`
    // for it would be the exact kind of claim this release removes.
    status: reported ?? (record.state === 'running' ? 'running' : 'error'),
    startTime: record.createdAt,
    endTime: record.endedAt,
    finalSummary: data?.finalSummary,
    compactContext: data?.compactContext,
    ...(error ? { error } : {}),
    ...suspension(record),
  };
}

// ─── Fan-out ────────────────────────────────────────────────────────────────

export interface FanoutNodeData {
  task: string;
  agentCount: number;
  results: FanoutAgentResult[];
  synthesis?: string;
  synthesisFile?: string;
  synthesisError?: string;
}

export function toFanoutSession(record: RunRecord): FanoutSession {
  const data = node(record)?.data as FanoutNodeData | undefined;
  const declared = spec<{ prompt: string; agents: unknown[] }>(record);
  const status: FanoutSession['status'] =
    record.state === 'cancelled'
      ? 'aborted'
      : record.state === 'failed'
        ? 'error'
        : isDone(record.state)
          ? 'done'
          : 'running';
  return {
    id: record.runId,
    status,
    task: data?.task ?? declared?.prompt ?? record.workflow,
    agentCount: data?.agentCount ?? declared?.agents?.length ?? 0,
    startedAt: record.createdAt,
    finishedAt: record.endedAt,
    results: data?.results ?? [],
    synthesis: data?.synthesis,
    ...(data?.synthesisFile ? { synthesisFile: data.synthesisFile } : {}),
    synthesisError: data?.synthesisError,
    error: record.error,
    ...suspension(record),
  };
}

// ─── Ultraplan ──────────────────────────────────────────────────────────────

/**
 * An engine that answers with a bare error string counts as failed even though
 * the turn technically completed. Kept verbatim from the previous
 * implementation so behaviour does not shift under existing callers.
 */
const LOOKS_LIKE_ERROR = /^(Error|not logged in|authentication|auth failed|permission denied)/i;

/** What a status reports of the run's forum, read by the caller. */
export interface UltraForumView {
  posts: ForumPost[];
  openAsks: ForumPost[];
}

/**
 * An ASK as a status lists it, its author as every listing shows it: a reserved
 * name the forum's ledger does not vouch for is marked unverified. `forumId`:
 * the run's own forum, which is where an ultra mode's run posts.
 */
function askSummary(forumId: string, p: ForumPost): { id: string; from: string; to: string[]; title: string } {
  return { id: p.id, from: authorLabel(forumId, p), to: p.to, title: p.title };
}

/**
 * The note an agent node's result ends with when ASKs are left open
 * (`openAsksNote`). It is not part of the plan: a status lists those ASKs in
 * `openAsks`.
 */
const OPEN_ASKS_NOTE = '\n\nOpen ASKs on the forum: ';

/** `text` without the open-ASKs note it ends with, when it has one. */
function withoutOpenAsksNote(text: string): string {
  const at = text.lastIndexOf(OPEN_ASKS_NOTE);
  return at >= 0 && /^p\d+ /.test(text.slice(at + OPEN_ASKS_NOTE.length)) ? text.slice(0, at) : text;
}

/** The most FAIL titles an ultrareview status lists; `posts` counts them all. */
export const ULTRAREVIEW_FAIL_TITLES = 200;

/**
 * Forum blocks (`<new-forum-post title="…">body</new-forum-post>`) in an
 * agent's reply, as plain text: the title in bold, then the body. A reviewer
 * on a forum writes its findings as these blocks, so dropping them would drop
 * the findings; the markup itself means nothing to whoever reads the report.
 */
export function replyBlocksAsText(text: string): string {
  return text.replace(/<new-forum-post\b[^>]*>[\s\S]*?<\/new-forum-post>/gi, (block) => {
    const [post] = postsInReply(block);
    if (!post) return '';
    return post.body ? `**${post.title}**\n\n${post.body}` : `**${post.title}**`;
  });
}

export function toUltraplanResult(
  record: RunRecord,
  plan: string | undefined,
  forum?: Pick<UltraForumView, 'openAsks'>,
): UltraplanResult {
  const text = replyBlocksAsText(withoutOpenAsksNote(plan ?? '')).trim();
  const failed = record.state === 'failed' || record.state === 'cancelled';
  const empty = isDone(record.state) && (!text || LOOKS_LIKE_ERROR.test(text));
  const status: UltraplanResult['status'] = !isDone(record.state) ? 'running' : failed || empty ? 'error' : 'completed';
  const planner = node(record);
  return {
    id: record.runId,
    status,
    // The agent node's own name for its session: `<run>-<node>-v<visit>a<attempt>`.
    // A run polled before its node started has neither counted yet.
    sessionName: `${record.runId}-${LEGACY_NODE}-v${Math.max(1, planner?.visits ?? 0)}a${Math.max(1, planner?.attempts ?? 0)}`,
    startTime: record.createdAt,
    endTime: record.endedAt,
    plan: status === 'completed' ? text : undefined,
    error: status === 'error' ? (record.error ?? text ?? 'Empty response from engine') : undefined,
    ...suspension(record),
    ...(forum ? { openAsks: forum.openAsks.map((p) => askSummary(record.runId, p)) } : {}),
  };
}

// ─── Ultrareview ────────────────────────────────────────────────────────────

export function toUltrareviewResult(
  record: RunRecord,
  findings: string | undefined,
  forum?: UltraForumView,
): UltrareviewResult {
  const data = node(record)?.data as FanoutNodeData | undefined;
  const declared = spec<{ agents: unknown[] }>(record);
  const status: UltrareviewResult['status'] =
    record.state === 'failed' || record.state === 'cancelled'
      ? 'error'
      : isDone(record.state)
        ? 'completed'
        : 'running';
  return {
    id: record.runId,
    status,
    // Kept for the UltrareviewResult contract; it now holds the run id, which is
    // also the fan-out id, because they are the same run.
    councilId: record.runId,
    agentCount: data?.agentCount ?? declared?.agents?.length ?? 0,
    startTime: record.createdAt,
    endTime: record.endedAt,
    findings: status === 'completed' ? findings : undefined,
    error: status === 'error' ? record.error : undefined,
    ...suspension(record),
    ...(forum ? { forum: ultrareviewForum(record, forum) } : {}),
  };
}

/** The forum part of an ultrareview status: the reviewers' FAIL titles so far, and what is open. */
function ultrareviewForum(record: RunRecord, forum: UltraForumView): NonNullable<UltrareviewResult['forum']> {
  const reviewers = new Set(
    (spec<{ agents?: Array<{ name: string }> }>(record)?.agents ?? []).map((a) => a.name).filter(Boolean),
  );
  const fails = forum.posts.filter((p) => reviewers.has(p.from) && p.tags.includes('FAIL'));
  return {
    posts: forum.posts.length,
    failTitles: fails.slice(0, ULTRAREVIEW_FAIL_TITLES).map((p) => `${p.from}: ${p.title}`),
    openAsks: forum.openAsks.map((p) => askSummary(record.runId, p)),
  };
}

/** Join per-agent results into the review text, when no synthesis pass ran. Forum blocks are shown as text. */
export function joinFindings(data: FanoutNodeData | undefined): string | undefined {
  if (!data) return undefined;
  if (data.synthesis) return replyBlocksAsText(data.synthesis);
  const ok = data.results.filter((r) => r.ok && r.output);
  if (ok.length === 0) return undefined;
  return ok.map((r) => `## ${r.agent}\n\n${replyBlocksAsText(r.output)}`).join('\n\n---\n\n');
}

/** Engine label used when a legacy caller supplied none. */
export const DEFAULT_ENGINE: EngineType = 'claude';
