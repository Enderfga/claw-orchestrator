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
 * Pure functions, no I/O beyond the caller-supplied text, so the mapping is
 * testable without starting anything.
 */

import type { AgentResponse, CouncilSession, EngineType, UltraplanResult, UltrareviewResult } from '../types.js';
import type { FanoutAgentResult, FanoutSession } from '../fanout.js';
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

export function toCouncilSession(record: RunRecord): CouncilSession {
  const data = node(record)?.data as CouncilNodeData | undefined;
  const declared = spec<{ task: string; agents: CouncilSession['config']['agents']; maxRounds?: number }>(record);
  // A council that throws during setup publishes `running` on its first event
  // and nothing after, so a finished run would read as running forever.
  const reported = data?.councilStatus === 'running' && isDone(record.state) ? undefined : data?.councilStatus;
  const error = node(record)?.error ?? record.error;
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

export function toUltraplanResult(record: RunRecord, plan: string | undefined): UltraplanResult {
  const text = (plan ?? '').trim();
  const failed = record.state === 'failed' || record.state === 'cancelled';
  const empty = isDone(record.state) && (!text || LOOKS_LIKE_ERROR.test(text));
  const status: UltraplanResult['status'] = !isDone(record.state) ? 'running' : failed || empty ? 'error' : 'completed';
  return {
    id: record.runId,
    status,
    sessionName: `${record.runId}-${LEGACY_NODE}-a1`,
    startTime: record.createdAt,
    endTime: record.endedAt,
    plan: status === 'completed' ? text : undefined,
    error: status === 'error' ? (record.error ?? text ?? 'Empty response from engine') : undefined,
    ...suspension(record),
  };
}

// ─── Ultrareview ────────────────────────────────────────────────────────────

export function toUltrareviewResult(record: RunRecord, findings: string | undefined): UltrareviewResult {
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
  };
}

/** Join per-agent results into the review text, when no synthesis pass ran. */
export function joinFindings(data: FanoutNodeData | undefined): string | undefined {
  if (!data) return undefined;
  if (data.synthesis) return data.synthesis;
  const ok = data.results.filter((r) => r.ok && r.output);
  if (ok.length === 0) return undefined;
  return ok.map((r) => `## ${r.agent}\n\n${r.output}`).join('\n\n---\n\n');
}

/** Engine label used when a legacy caller supplied none. */
export const DEFAULT_ENGINE: EngineType = 'claude';
