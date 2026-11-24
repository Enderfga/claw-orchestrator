/**
 * `fanout` node — N agents in parallel, wrapping the existing Fanout engine.
 *
 * The kernel supplies durability, timeout and cancellation around it; `fanout.ts`
 * itself is unchanged. Note what this fixes for free: a fan-out's results used to
 * live only in a 30-minute in-memory map, so a restart (or a slow reader) lost
 * them entirely. Here the node output is checkpointed like any other.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { NodeContext, NodeResult, RunKernel } from '../engine.js';
import {
  isTerminalRunState,
  type FanoutAgentSpec,
  type FanoutNode,
  type GoalNode,
  type NodeSpec,
  type RunRecord,
} from '../types.js';
import type { FanoutAgentResult, FanoutSession } from '../../fanout.js';
import { forumBrief, forumHub, forumTeamOf, openAsks, resolveForum, unreadFor } from '../forum.js';
import type { GoalNodeData } from './goal.js';
import { loadRun, runDir } from '../store.js';
import { sanitizeCwd } from '../../validation.js';
import type { EngineType } from '../../types.js';

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
  const synthesisFile = writeOutputs(ctx, results, turns?.synthesis);
  const failures = results.filter((r) => !r.ok);
  const body =
    turns?.synthesis ??
    results.map((r) => `## ${r.agent}${r.ok ? '' : ' (failed)'}\n\n${r.output || r.error || ''}`).join('\n\n');
  const costUsd = (turns?.costUsd ?? 0) + goals.reduce((sum, r) => sum + (r.costUsd ?? 0), 0);

  // The ASKs this node's agents leave unanswered on the forum, named in its
  // result so a later node, and whoever reads the run, sees them.
  const forum = resolveForum(ctx.record);
  const names = new Set(spec.agents.map((a) => a.name));
  const unanswered = forum
    ? openAsks(forum.runId).filter((p) => names.has(p.from) || p.to.some((n) => names.has(n)))
    : [];
  const forumNote = unanswered.length
    ? `\n\nOpen ASKs on the forum: ${unanswered.map((p) => `${p.id} ${p.from}: ${p.title}`).join('; ')}`
    : '';

  return {
    ok: turns?.status !== 'error' && failures.length < results.length,
    output: body + forumNote,
    error: failures.length > 0 ? `${failures.length}/${results.length} agent(s) failed` : undefined,
    // What the agents and the synthesis spent, so the run's cost includes it.
    costUsd,
    data: {
      task: spec.prompt,
      agentCount: spec.agents.length,
      results,
      synthesis: turns?.synthesis,
      ...(synthesisFile ? { synthesisFile } : {}),
      synthesisError: turns?.synthesisError,
      ...(goalAgents.length > 0 ? { goalRuns } : {}),
      ...(forum
        ? { forum: { openAsks: unanswered.map((p) => ({ id: p.id, from: p.from, to: p.to, title: p.title })) } }
        : {}),
    },
  };
}

/**
 * Every agent's output, and the synthesis, as files in the run directory
 * (`outputs/<agent>.md`, `outputs/synthesis.md`), each result naming its own.
 * A caller reads a long report there whole: an MCP client may cut a large tool
 * result, and three full reviews in one status reply are large. A failed turn's
 * file holds the error and whatever the agent had written. Best effort: a file
 * that cannot be written leaves its result without `outputFile`.
 */
function writeOutputs(
  ctx: NodeContext,
  results: FanoutAgentResult[],
  synthesis: string | undefined,
): string | undefined {
  let dir: string;
  try {
    dir = path.join(runDir(ctx.runId), 'outputs');
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    return undefined;
  }
  const write = (name: string, text: string): string | undefined => {
    const file = path.join(dir, `${name.replace(/[^A-Za-z0-9._-]/g, '_')}.md`);
    try {
      fs.writeFileSync(file, text);
      return file;
    } catch {
      return undefined;
    }
  };
  for (const r of results) {
    const text = r.ok ? r.output : `<!-- failed: ${r.error ?? 'unknown error'} -->\n\n${r.output}`;
    const file = write(r.agent, text);
    if (file) r.outputFile = file;
  }
  return synthesis ? write('synthesis', synthesis) : undefined;
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
  // The session engine the goal runs on: a Codex goal is a `codex-app` thread.
  const engine: EngineType = !a.engine || a.engine === 'codex' ? 'codex-app' : a.engine;
  const started = Date.now();
  let cwd = projectDir;
  try {
    cwd = a.cwd ? sanitizeCwd(path.resolve(projectDir, a.cwd))! : projectDir;
    let record: RunRecord;
    const existing = goalRuns[a.name];
    const forum = resolveForum(ctx.record);
    const prev = existing ? loadRun(existing) : undefined;
    if (existing && prev) {
      // A finished goal run is taken up again, on its thread, when the forum has
      // posts that name its agent and that it has not seen; otherwise its result
      // stands, as a resume of a finished run returns it.
      const news = !!forum && isTerminalRunState(prev.state) && unreadFor(forum.runId, a.name).length > 0;
      record = await kernel.resume(existing, { secrets: ctx.secrets, ...(news ? { restart: true } : {}) });
    } else {
      const goal: GoalNode = {
        id: 'goal',
        kind: 'goal',
        objective: a.objective!,
        // Stamped and checked at start (`validateSpec`): one of the goal engines.
        engine: a.engine as GoalNode['engine'],
        ...(a.acpAgent ? { acpAgent: a.acpAgent } : {}),
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
        { cwd, secrets: ctx.secrets, ...(forum ? { forum: { runId: forum.runId, agent: a.name } } : {}) },
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
  const forum = resolveForum(ctx.record);
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
      // On a run with a forum, each agent is on it for its turn and reads its
      // brief first; a post pushed to it reaches the turn in flight where the
      // engine allows it.
      ...(forum
        ? {
            agentPreface: (agent: string) => forumBrief(forum.runId, agent, forumTeamOf(forum.runId), forum.config),
            onAgentSession: (agent: string, sessionName: string) => {
              // The directory the Fanout engine runs this agent in, where its score is read.
              const own = agents.find((a) => a.name === agent)?.cwd;
              return forumHub(forum.runId, forum.config).join(
                agent,
                (text) => ctx.manager!.deliverMidTurn?.(sessionName, text) ?? false,
                { cwd: own ? (sanitizeCwd(path.resolve(projectDir, own)) ?? projectDir) : projectDir },
              );
            },
          }
        : {}),
    },
    ctx.manager!,
    ctx.logger,
  );

  if (ctx.signal.aborted) return undefined;
  setHandle(fanout);
  return fanout.run();
}
