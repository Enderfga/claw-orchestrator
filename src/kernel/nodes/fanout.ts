/**
 * `fanout` node — N agents in parallel, wrapping the existing Fanout engine.
 *
 * The kernel supplies durability, timeout and cancellation around it; `fanout.ts`
 * itself is unchanged. Note what this fixes for free: a fan-out's results used to
 * live only in a 30-minute in-memory map, so a restart (or a slow reader) lost
 * them entirely. Here the node output is checkpointed like any other.
 */

import * as path from 'node:path';
import type { NodeContext, NodeResult, RunKernel } from '../engine.js';
import type { FanoutAgentSpec, FanoutNode, GoalNode, NodeSpec, RunRecord } from '../types.js';
import type { FanoutAgentResult, FanoutSession } from '../../fanout.js';
import type { GoalNodeData } from './goal.js';
import { loadRun } from '../store.js';
import { sanitizeCwd } from '../../validation.js';

/** The fan-out executor without goal agents; one with them needs the kernel (`makeFanoutExecutor`). */
export async function executeFanoutNode(node: NodeSpec, ctx: NodeContext): Promise<NodeResult> {
  return runFanout(node, ctx, undefined);
}

/**
 * The fan-out executor the default kernel registers. Agents with an `objective`
 * run as goals, each in a child run of one `goal` node, alongside the agents that
 * take one turn.
 */
export function makeFanoutExecutor(kernel: RunKernel) {
  return (node: NodeSpec, ctx: NodeContext) => runFanout(node, ctx, kernel);
}

/** Checkpointed on the node so a resumed parent reattaches to its goal runs. */
interface FanoutNodeData {
  goalRuns?: Record<string, string>;
}

async function runFanout(node: NodeSpec, ctx: NodeContext, kernel: RunKernel | undefined): Promise<NodeResult> {
  const spec = node as FanoutNode;
  if (!ctx.manager) return { ok: false, error: 'fanout node requires a session manager' };
  const goalAgents = spec.agents.filter((a) => !!a.objective?.trim());
  const turnAgents = spec.agents.filter((a) => !a.objective?.trim());
  if (goalAgents.length > 0 && !kernel) {
    return { ok: false, error: 'fanout goal agents need a kernel; register makeFanoutExecutor' };
  }
  const projectDir = spec.cwd || ctx.cwd;
  const prior = ctx.record.nodes[spec.id]?.data as FanoutNodeData | undefined;
  const goalRuns: Record<string, string> = { ...(prior?.goalRuns ?? {}) };
  const children = new Set<string>();
  let fanoutHandle: { abort?: () => void } | undefined;
  // One handle for the node: cancelling or timing it out stops the turn agents
  // and every goal run it started.
  ctx.setHandle({
    abort: () => {
      fanoutHandle?.abort?.();
      for (const id of children) kernel?.cancel(id);
    },
  });

  const [turns, goals] = await Promise.all([
    turnAgents.length > 0 ? runTurnAgents(spec, ctx, turnAgents, projectDir, (h) => (fanoutHandle = h)) : undefined,
    Promise.all(
      goalAgents.map((a) =>
        runGoalAgent(kernel!, spec, ctx, a, projectDir, goalRuns, (id) => {
          children.add(id);
          if (ctx.signal.aborted) kernel!.cancel(id);
        }),
      ),
    ),
  ]);
  if (ctx.signal.aborted) return { ok: false, error: 'cancelled', data: { goalRuns } };

  // Results in the order the spec lists the agents.
  const byName = new Map<string, FanoutAgentResult>();
  for (const r of [...(turns?.results ?? []), ...goals]) byName.set(r.agent, r);
  const results = spec.agents.map((a) => byName.get(a.name)).filter((r): r is FanoutAgentResult => !!r);
  const failures = results.filter((r) => !r.ok);
  const body =
    turns?.synthesis ??
    results.map((r) => `## ${r.agent}${r.ok ? '' : ' (failed)'}\n\n${r.output || r.error || ''}`).join('\n\n');
  const costUsd = (turns?.costUsd ?? 0) + goals.reduce((sum, r) => sum + (r.costUsd ?? 0), 0);

  return {
    ok: turns?.status !== 'error' && failures.length < results.length,
    output: body,
    error: failures.length > 0 ? `${failures.length}/${results.length} agent(s) failed` : undefined,
    // What the agents and the synthesis spent, so the run's cost includes it.
    costUsd,
    data: {
      task: spec.prompt,
      agentCount: spec.agents.length,
      results,
      synthesis: turns?.synthesis,
      synthesisError: turns?.synthesisError,
      ...(goalAgents.length > 0 ? { goalRuns } : {}),
    },
  };
}

/**
 * One goal agent: a child run of one `goal` node in the agent's directory. A run
 * id already checkpointed for this agent is reattached, so a goal interrupted by
 * the parent's process dying carries on instead of starting over.
 */
async function runGoalAgent(
  kernel: RunKernel,
  spec: FanoutNode,
  ctx: NodeContext,
  a: FanoutAgentSpec,
  projectDir: string,
  goalRuns: Record<string, string>,
  track: (runId: string) => void,
): Promise<FanoutAgentResult> {
  const engine = a.engine === 'claude' ? 'claude' : 'codex-app';
  const started = Date.now();
  let cwd = projectDir;
  try {
    cwd = a.cwd ? sanitizeCwd(path.resolve(projectDir, a.cwd))! : projectDir;
    let record: RunRecord;
    const existing = goalRuns[a.name];
    if (existing && loadRun(existing)) {
      record = await kernel.resume(existing, { secrets: ctx.secrets });
    } else {
      const goal: GoalNode = {
        id: 'goal',
        kind: 'goal',
        objective: a.objective!,
        engine: a.engine === 'claude' ? 'claude' : 'codex',
        cwd,
        ...(a.model ? { model: a.model } : {}),
        ...(a.effort ? { effort: a.effort } : {}),
        ...(a.sandboxMode ? { sandboxMode: a.sandboxMode } : {}),
        ...(a.tokenBudget ? { tokenBudget: a.tokenBudget } : {}),
        ...(a.capacityRetry ? { capacityRetry: a.capacityRetry } : {}),
        ...(a.stallMs ? { stallMs: a.stallMs } : {}),
        ...(a.timeoutMs ? { timeoutMs: a.timeoutMs } : {}),
      };
      record = await kernel.start(
        { name: `${ctx.record.spec.name}/${spec.id}/${a.name}`, cwd, nodes: [goal] },
        { cwd, secrets: ctx.secrets },
      );
      goalRuns[a.name] = record.runId;
      // Checkpointed at once: a parent that dies from here on must find this run.
      ctx.publish({ goalRuns: { ...goalRuns } });
    }
    track(record.runId);
    const done = (await kernel.wait(record.runId)) ?? record;
    const node = done.nodes.goal;
    const data = node?.data as GoalNodeData | undefined;
    const ok = done.state === 'completed' && node?.state === 'succeeded';
    return {
      agent: a.name,
      engine,
      model: a.model,
      cwd,
      ok,
      output: data?.lastMessage ?? node?.output ?? '',
      error: ok ? undefined : (node?.error ?? done.error ?? `goal run ended ${done.state}`),
      durationMs: Date.now() - started,
      ...(typeof done.costUsd === 'number' ? { costUsd: done.costUsd } : {}),
      goal: { runId: done.runId, status: data?.status, tokensUsed: data?.tokensUsed, threadId: data?.threadId },
    };
  } catch (err) {
    return {
      agent: a.name,
      engine,
      model: a.model,
      cwd,
      ok: false,
      output: '',
      error: (err as Error).message,
      durationMs: Date.now() - started,
    };
  }
}

/** The agents that take one turn: the Fanout engine, as before. */
async function runTurnAgents(
  spec: FanoutNode,
  ctx: NodeContext,
  agents: FanoutAgentSpec[],
  projectDir: string,
  setHandle: (h: { abort?: () => void }) => void,
): Promise<FanoutSession | undefined> {
  // Every field, forwarded. The first cut mapped four of them and dropped the
  // rest, which is how an ultrareview's per-reviewer prompt and its
  // `permissionMode: 'plan'` stopped reaching the session — a read-only review
  // that ran under `bypassPermissions`.
  const customEngines = (ctx.secrets.agentCustomEngines ?? {}) as Record<string, unknown>;
  const { Fanout } = await import('../../fanout.js');
  const fanout = new Fanout(
    {
      // One identity for the whole execution: the ledger's `parentRunId` is the
      // kernel run id, so rows group by the run they belong to.
      runId: ctx.runId,
      task: spec.prompt,
      projectDir,
      agents: agents.map((a) => ({
        name: a.name,
        engine: a.engine,
        model: a.model,
        effort: a.effort,
        acpAgent: a.acpAgent,
        prompt: a.prompt,
        persona: a.persona,
        cwd: a.cwd,
        baseUrl: a.baseUrl,
        permissionMode: a.permissionMode as never,
        sandboxMode: a.sandboxMode,
        // Credentials never travel in the spec; they arrive through the
        // in-memory side channel keyed by agent name.
        customEngine: customEngines[a.name] as never,
      })),
      synthesize: spec.synthesize,
      synthesisEngine: spec.synthesisEngine,
      synthesisModel: spec.synthesisModel,
      synthesisAcpAgent: spec.synthesisAcpAgent,
      synthesisPermissionMode: spec.synthesisPermissionMode as never,
      maxTurnsPerAgent: spec.maxTurnsPerAgent,
      maxBudgetUsd: spec.maxBudgetUsd,
      agentTimeoutMs: spec.agentTimeoutMs ?? spec.timeoutMs,
      // A cancelled run, or an attempt the kernel timed out, must stop taking
      // queued agents off the queue rather than keep starting paid turns.
      signal: ctx.signal,
    },
    ctx.manager!,
    ctx.logger,
  );

  if (ctx.signal.aborted) return undefined;
  setHandle(fanout);
  return fanout.run();
}
