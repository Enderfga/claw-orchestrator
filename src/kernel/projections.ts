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
import type { NodeRecord, RunRecord, RunState } from './types.js';

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

export function toCouncilSession(record: RunRecord): CouncilSession {
  const data = node(record)?.data as CouncilNodeData | undefined;
  const declared = spec<{ task: string; agents: CouncilSession['config']['agents']; maxRounds?: number }>(record);
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
    status: data?.councilStatus ?? (record.state === 'running' ? 'running' : 'error'),
    startTime: record.createdAt,
    endTime: record.endedAt,
    finalSummary: data?.finalSummary,
    compactContext: data?.compactContext,
  };
}

// ─── Fan-out ────────────────────────────────────────────────────────────────

export interface FanoutNodeData {
  task: string;
  agentCount: number;
  results: FanoutAgentResult[];
  synthesis?: string;
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
    error: record.error,
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
