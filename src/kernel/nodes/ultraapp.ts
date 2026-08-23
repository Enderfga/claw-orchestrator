/**
 * UltraApp's two agent-driven stages, as kernel nodes.
 *
 * Before this, UltraApp ran its build pipeline itself: a mode enum in its own
 * store, a call straight into `new Council().run()`, and no checkpoint between
 * the council and the build. A crash therefore restarted an expensive council
 * from nothing, the run appeared in none of the workflow listings, and the
 * project had two runtimes side by side — which is the last thing the 6.0 work
 * set out to remove.
 *
 * What is here is deliberately thin. The stages need UltraApp's store, router
 * and deploy strategy, so the work is injected exactly as the autoloop node
 * injects its dispatcher; the node specs carry only JSON, because they are
 * checkpointed with the run. The stage between these two — running the build
 * contract with its fix-on-red loop — needs no node of its own: that is what the
 * ordinary `verifier` node already does.
 */

import type { NodeContext, NodeExecutor, NodeResult } from '../engine.js';
import type { NodeSpec, UltraappDeployNode, UltraappSynthNode } from '../types.js';

export interface UltraappSynthOutcome {
  ok: boolean;
  /** The consensus codebase, snapshotted out of the council's main branch. */
  worktreePath?: string;
  reason?: string;
  rounds: number;
}

export interface UltraappDeployOutcome {
  ok: boolean;
  reason?: string;
  url?: string;
  /**
   * The deploy stage runs its own acceptance checks — the §7g screenshots have
   * to be taken against a URL that does not exist until the deploy has happened,
   * so the contract cannot be declared in the spec ahead of time. Returning the
   * verdict here is what makes this node terminal for the run's outcome.
   */
  evidenceId?: string;
  passed?: boolean;
}

export interface UltraappNodeDeps {
  synth(args: {
    appRunId: string;
    runDir: string;
    slug: string;
    signal: { aborted: boolean };
  }): Promise<UltraappSynthOutcome>;
  deploy(args: {
    appRunId: string;
    runDir: string;
    slug: string;
    version: string;
    codebasePath: string;
    signal: { aborted: boolean };
  }): Promise<UltraappDeployOutcome>;
}

export function makeUltraappSynthExecutor(deps: UltraappNodeDeps): NodeExecutor {
  return async function executeUltraappSynthNode(node: NodeSpec, ctx: NodeContext): Promise<NodeResult> {
    const spec = node as UltraappSynthNode;
    if (ctx.signal.aborted) return { ok: false, error: 'cancelled' };
    const result = await deps.synth({
      appRunId: spec.appRunId,
      runDir: spec.runDir,
      slug: spec.slug,
      signal: ctx.signal,
    });
    return {
      ok: result.ok,
      output: result.ok
        ? `council reached consensus after ${result.rounds} round(s)`
        : (result.reason ?? 'council did not converge'),
      error: result.ok ? undefined : (result.reason ?? 'council did not converge'),
      data: { worktreePath: result.worktreePath, rounds: result.rounds },
    };
  };
}

export function makeUltraappDeployExecutor(deps: UltraappNodeDeps): NodeExecutor {
  return async function executeUltraappDeployNode(node: NodeSpec, ctx: NodeContext): Promise<NodeResult> {
    const spec = node as UltraappDeployNode;
    if (ctx.signal.aborted) return { ok: false, error: 'cancelled' };
    const result = await deps.deploy({
      appRunId: spec.appRunId,
      runDir: spec.runDir,
      slug: spec.slug,
      version: spec.version,
      codebasePath: spec.codebasePath,
      signal: ctx.signal,
    });
    return {
      ok: result.ok,
      output: result.ok ? `deployed at ${result.url ?? '(no url)'}` : (result.reason ?? 'deploy failed'),
      error: result.ok ? undefined : (result.reason ?? 'deploy failed'),
      evidenceId: result.evidenceId,
      passed: result.passed,
      data: { url: result.url, version: spec.version },
    };
  };
}
