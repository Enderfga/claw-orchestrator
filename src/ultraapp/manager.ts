import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type AppSpec, validateAppSpec } from './spec.js';
import { type UltraappStore, type ChatEntry, type RunMode } from './store.js';
import { parseInterviewReply, type QuestionEnvelope } from './interview-parser.js';
import { runToolCalls } from './interview-tools.js';
import {
  extractMetadata as defaultExtractMetadata,
  ingestUpload,
  validateLocalPath,
  defaultAllowedRoots,
} from './files.js';
import { applyPatch, type PatchOp } from './json-patch.js';
import { UltraappBuildQueue } from './build.js';
import type { BuildEvent } from './build-events.js';
import { runCouncilSynth } from './council-adapter.js';
import { runFixOnFailure } from './fix-on-failure.js';
import { RunKernel } from '../kernel/engine.js';
import { registerDefaultExecutors } from '../kernel/nodes/index.js';
import {
  makeUltraappDeployExecutor,
  makeUltraappSynthExecutor,
  type UltraappDeployOutcome,
  type UltraappNodeDeps,
} from '../kernel/nodes/ultraapp.js';
import { ultraappWorkflow } from '../kernel/templates/index.js';
import type { KernelEvent, RunRecord } from '../kernel/types.js';
import { ultraappBuildContract, ultraappDeployContract, visualGateIsStrict } from './contract.js';
import { runChecks } from '../verify/runner.js';
import { contractPassed, type AcceptanceContract, type CheckResult } from '../verify/contract.js';
import { writeEvidence } from '../verify/evidence.js';
import { deployArtifact, type DeployArgs, type DeployResult } from './deploy.js';
import { dockerBuild, dockerRun, dockerRmi } from './docker.js';
import { hostBuild, hostRun, hostRmi } from './host-strategy.js';
import { startContainerAndRegister, stopContainerAndDeregister, deleteContainerAndDeregister } from './lifecycle.js';
import type { UltraappRouter } from './router.js';
import { Narrator } from './narrator.js';
import { classifyFeedback, type FeedbackClass } from './feedback-classifier.js';
import { runPatcher } from './patcher.js';
import { startSpecDeltaInterview } from './spec-delta.js';
import { snapshotVersion, swapVersion, listVersions } from './versions.js';

export type RunEvent =
  | { type: 'question'; question: QuestionEnvelope }
  | { type: 'spec-updated'; spec: AppSpec }
  | { type: 'chat'; entry: ChatEntry }
  | { type: 'completeness'; ok: boolean; missing: string[] }
  | { type: 'interview-complete'; summary: string }
  | { type: 'build-event'; event: BuildEvent }
  | { type: 'app-url'; url: string; version: string }
  | { type: 'error'; message: string };

interface SessionManagerLike {
  startSession(config: {
    name?: string;
    engine?: string;
    model?: string;
    cwd?: string;
    systemPrompt?: string;
    permissionMode?: string;
  }): Promise<{ name: string }>;
  sendMessage(name: string, message: string): Promise<{ output: string }>;
  stopSession(name: string): Promise<void>;
}

export interface UltraappManagerOptions {
  store: UltraappStore;
  sessionManager: SessionManagerLike;
  skillPath?: string;
  /** Optional reverse-proxy router. When absent, the build pipeline ends in
      `build-complete` (v0.2 behaviour); when present, deploy runs after build
      and the run reaches `done` with a public-but-local URL. */
  router?: UltraappRouter;
  /**
   * The run kernel that drives the build pipeline.
   *
   * Supplied by SessionManager in production so UltraApp's runs share the one
   * run store, listing and ownership model as everything else. Left out, a
   * private kernel is wired up — which keeps the class usable on its own, and
   * still means there is only one execution model, not two.
   */
  kernel?: RunKernel;
  /** Test seam: stub the deploy state machine. */
  deployFn?: (a: DeployArgs) => Promise<DeployResult>;
  /**
   * Override the build-stage acceptance contract.
   *
   * A caller-supplied contract, never an agent-supplied one — the same rule as
   * everywhere else in the verification plane. It exists because the default
   * really does run `npm install && npm run build && npm test` in the generated
   * codebase, which a unit test has no business doing; tests declare a trivial
   * contract the way they inject `deployFn`.
   */
  buildContract?: AcceptanceContract;
  /**
   * Test seam: stub the deploy-stage acceptance checks. The real one drives a
   * headless browser against the deployed URL, which a stubbed deploy has not
   * got, so tests inject their own the same way they inject `deployFn`.
   */
  runDeployChecksFn?: (contract: AcceptanceContract, cwd: string, artifactDir: string) => Promise<CheckResult[]>;
  /** Runtime mode for build + deploy. 'host' (default) runs the generated
      app as a regular Node process — works anywhere Node works, no extra
      deps. 'docker' uses `docker build` + `docker run` for isolation; only
      use this when you want shared-host hardening. */
  runtimeMode?: 'host' | 'docker';
}

interface ActiveRun {
  runId: string;
  sessionName: string;
  emitter: EventEmitter;
  /** Set true by setModeForDelta. On the next interview-complete the
      manager auto-triggers startBuild instead of waiting for the user
      to click Start Build (which would be redundant for a focused
      spec-delta rerun). Cleared after the auto-build kicks off. */
  deltaPending?: boolean;
}

const SESSION_KICKOFF = 'Begin the ultraapp interview now. Ask the first question per the skill contract.';

/**
 * The kernel run id for an app's current build.
 *
 * Stable rather than per-attempt, so `clawo workflow show ultraapp-<id>` always
 * names the build that matters; a rebuild deletes the previous run and starts a
 * new one under the same id, which the incarnation check makes safe.
 */
export function ultraappKernelRunId(appRunId: string): string {
  return `ultraapp-${appRunId}`;
}

/**
 * UltraApp's `RunMode`, derived from the kernel record.
 *
 * The build pipeline no longer has a state machine of its own: this reads the
 * one the kernel keeps. `interview` and `queued` are not here because they are
 * not pipeline states — nothing is running yet, and the interview genuinely is
 * not a workflow.
 */
export function ultraappModeOf(record: RunRecord): RunMode {
  if (record.state === 'cancelled') return 'cancelled';
  if (record.state === 'failed') return 'failed';
  const deploys = Boolean(record.nodes.deploy);
  if (record.state === 'completed') return deploys ? 'done' : 'build-complete';
  const deploy = record.nodes.deploy;
  if (deploy && deploy.state !== 'pending') return 'deploying';
  if (record.nodes.build?.state === 'succeeded') return 'build-complete';
  return 'building';
}

/** Which stage a failed node belongs to, in the vocabulary `BuildEvent` uses. */
function buildPhaseOf(nodeId: string | undefined): 'council' | 'fix-on-failure' | 'orchestrator' {
  if (nodeId === 'synth') return 'council';
  if (nodeId === 'build') return 'fix-on-failure';
  return 'orchestrator';
}

export class UltraappManager {
  private readonly runs = new Map<string, ActiveRun>();
  private readonly skillContent: string;
  private readonly buildQueue: UltraappBuildQueue;
  private readonly narrators = new Map<string, Narrator>();
  private readonly kernel: RunKernel;
  /** Per-run serialisation for the mode projection. See {@link projectMode}. */
  private readonly projectChain = new Map<string, Promise<void>>();
  private readonly classifierSessions = new Set<string>();
  // Tracks fire-and-forget background work (driveTurn chains, build-queue
  // enqueue, narrator finalisation) so tests (and dispose flows) can drain
  // it before tearing down state. Without this, an in-flight appendChat can
  // race afterEach's tmp-dir cleanup and surface as an unhandled ENOENT
  // rejection that vitest treats as failure.
  private readonly inflightWork = new Set<Promise<unknown>>();

  constructor(private readonly opts: UltraappManagerOptions) {
    this.skillContent = loadSkill(opts.skillPath);
    this.buildQueue = new UltraappBuildQueue({
      worker: (runId, emit) => this.runBuild(runId, emit),
      // Durable: a queued build survives a restart of the orchestrator instead
      // of disappearing with the process that accepted it.
      statePath: path.join(opts.store.rootDir(), 'build-queue.json'),
      onRestore: (runIds) => {
        console.info(`[ultraapp] re-queued ${runIds.length} build(s) left by a previous process: ${runIds.join(', ')}`);
      },
    });
    this.buildQueue.subscribe((ev) => this.onBuildEvent(ev));

    // The two stages the kernel cannot know how to run on its own. Registered
    // here rather than in `registerDefaultExecutors` for the same reason the
    // autoloop executor is: they close over this manager's store, router and
    // deploy strategy, none of which belong in the kernel.
    this.kernel = opts.kernel ?? registerDefaultExecutors(new RunKernel({ manager: opts.sessionManager as never }));
    const deps = this.ultraappNodeDeps();
    this.kernel.setExecutor('ultraapp_synth', makeUltraappSynthExecutor(deps));
    this.kernel.setExecutor('ultraapp_deploy', makeUltraappDeployExecutor(deps));
  }

  private ultraappNodeDeps(): UltraappNodeDeps {
    return {
      synth: async ({ appRunId, runDir }) =>
        runCouncilSynth({
          spec: await this.opts.store.readSpec(appRunId),
          runId: appRunId,
          runDir,
          sessionManager: this.opts.sessionManager,
        }),
      deploy: async ({ appRunId, version, codebasePath, slug }) =>
        this.deployStage({ runId: appRunId, version, worktreePath: codebasePath, slug }),
    };
  }

  get store(): UltraappStore {
    return this.opts.store;
  }

  async createRun(): Promise<string> {
    const runId = await this.opts.store.createRun();
    const sessionName = `ultraapp-${runId}`;
    await this.opts.sessionManager.startSession({
      name: sessionName,
      engine: 'claude',
      model: 'claude-opus-4-7',
      cwd: process.cwd(),
      systemPrompt: this.skillContent,
      permissionMode: 'bypassPermissions',
    });
    const run: ActiveRun = { runId, sessionName, emitter: new EventEmitter() };
    this.runs.set(runId, run);
    this.fireDriveTurn(run, SESSION_KICKOFF);
    return runId;
  }

  async submitAnswer(runId: string, answer: { value: string; freeform?: string }): Promise<void> {
    const run = this.requireRun(runId);
    const text = answer.freeform ? answer.freeform : `I picked: ${answer.value}`;
    await this.opts.store.appendChat(runId, { role: 'user', kind: 'answer', text });
    this.emit(run, { type: 'chat', entry: { role: 'user', kind: 'answer', text } });
    this.fireDriveTurn(run, text);
  }

  async applySpecEdit(runId: string, patch: PatchOp[]): Promise<void> {
    const run = this.requireRun(runId);
    const spec = await this.opts.store.readSpec(runId);
    const next = applyPatch(spec, patch);
    await this.opts.store.writeSpec(runId, next as typeof spec, 'manual-edit');
    this.emit(run, { type: 'spec-updated', spec: next as AppSpec });
    this.fireDriveTurn(
      run,
      `[system] User manually edited spec: ${JSON.stringify(patch)}. Re-evaluate later questions.`,
    );
  }

  async addFile(
    runId: string,
    args: { kind: 'upload'; filename: string; data: Buffer } | { kind: 'path'; absolutePath: string },
  ): Promise<{ ref: string }> {
    const run = this.requireRun(runId);
    let ref: string;
    if (args.kind === 'upload') {
      ref = await ingestUpload(this.opts.store.examplesDir(runId), args.filename, args.data);
    } else {
      validateLocalPath(args.absolutePath, { allow: defaultAllowedRoots() });
      ref = args.absolutePath;
    }
    await this.opts.store.appendChat(runId, {
      role: 'system',
      kind: 'free',
      text: `[file added] ${path.basename(ref)}`,
      payload: { ref },
    });
    this.fireDriveTurn(run, `[system] User added file: ${ref}. You may call extract_metadata.`);
    return { ref };
  }

  subscribe(runId: string, listener: (ev: RunEvent) => void): () => void {
    const run = this.requireRun(runId);
    run.emitter.on('event', listener);
    return () => run.emitter.off('event', listener);
  }

  async startBuild(runId: string): Promise<void> {
    const run = this.requireRun(runId);
    // Strict validate before enqueueing — pipeline cross-refs + DAG must
    // resolve. writeSpec only does the lax shape check during interview
    // iteration; this is the gate that catches real spec errors.
    const spec = await this.opts.store.readSpec(runId);
    try {
      validateAppSpec(spec);
    } catch (e) {
      const reason = (e as Error).message;
      const msg = `Cannot start build: spec is invalid — ${reason}`;
      await this.opts.store.appendChat(runId, { role: 'system', kind: 'error', text: msg });
      this.emit(run, { type: 'chat', entry: { role: 'system', kind: 'error', text: msg } });
      this.emit(run, { type: 'error', message: reason });
      throw new Error(reason);
    }
    await this.opts.store.setMode(runId, 'queued');
    const text = 'Build queued.';
    await this.opts.store.appendChat(runId, { role: 'system', kind: 'narrator', text });
    this.emit(run, { type: 'chat', entry: { role: 'system', kind: 'narrator', text } });
    this.trackBackground(this.buildQueue.enqueue(runId));
  }

  cancelBuild(runId: string): void {
    this.buildQueue.cancel(runId);
    // A queued item lives in the queue; a dispatched item lives in the kernel.
    // Cancelling only the former emitted a reassuring event while the workflow
    // continued through verification and deploy.
    this.kernel.cancel(ultraappKernelRunId(runId));
  }

  buildPosition(runId: string): number {
    return this.buildQueue.position(runId);
  }

  /**
   * Run the build pipeline as a kernel workflow.
   *
   * This used to be a hand-rolled sequence: council, then fix-on-failure, then
   * deploy, with a mode enum written at each step and nothing checkpointed
   * between them. It worked, but it meant UltraApp was a second runtime standing
   * beside the one this release exists to be — its runs were invisible to
   * `workflow_list` and the Runs tab, and a crash halfway through threw away a
   * finished council and started it again from nothing.
   *
   * Now the sequence is a `WorkflowSpec` and the kernel drives it. What is left
   * here is the part that is genuinely UltraApp's: turning kernel events into
   * `BuildEvent`s for the dashboard, and keeping `RunMode` — which the whole
   * UI and every stored run reads — as a projection of the kernel's state
   * rather than as a second source of truth.
   *
   * The interview and the done-mode conversation are deliberately NOT here.
   * They are user-driven and open-ended; expressing them as a workflow would
   * mean a router self-loop fighting the visit bound, or one fake node with a
   * state machine hidden inside it. That would be unification as theatre.
   */
  private async runBuild(runId: string, emit: (e: BuildEvent) => void): Promise<void> {
    await this.opts.store.setMode(runId, 'building');
    await this.startNarrator(runId);

    emit({ type: 'build-start', runId });
    const spec = await this.opts.store.readSpec(runId);
    const runDir = this.opts.store.runDirAbsolute(runId);
    const version = 'v1';
    const codebasePath = path.join(runDir, 'versions', version, 'codebase');
    const useDocker = this.opts.runtimeMode === 'docker';

    const workflow = ultraappWorkflow({
      appRunId: runId,
      runDir,
      slug: spec.meta.name,
      version,
      codebasePath,
      // §4 of the conventions has always told the council that `npm run smoke`
      // is binding; this is where it actually runs.
      buildContract: this.opts.buildContract ?? ultraappBuildContract({ useDocker }),
      deploy: Boolean(this.opts.router),
    });

    const kernelRunId = ultraappKernelRunId(runId);
    const previous = this.kernel.get(kernelRunId);
    const resumable = previous && !['completed', 'failed', 'cancelled'].includes(previous.state);

    const off = this.subscribeKernel(kernelRunId, runId, emit, { version, codebasePath });
    try {
      if (resumable) {
        // The durable queue re-enqueues an in-flight build after a process dies.
        // Resume its checkpoint instead of deleting it: otherwise the queue's
        // recovery path threw away the very per-stage durability the kernel move
        // was meant to provide and paid for the council twice.
        await this.kernel.resume(kernelRunId);
      } else {
        // An explicit rebuild reuses the stable id but is a new incarnation.
        if (previous && !this.kernel.delete(kernelRunId)) {
          throw new Error(`a previous build of ${runId} is still owned by another process`);
        }
        await this.kernel.start(workflow, { runId: kernelRunId, cwd: runDir });
      }
      const record = await this.kernel.wait(kernelRunId);
      // Unsubscribed BEFORE settling. A handler is async and re-reads the record
      // itself, so one that started just before the terminal transition can
      // finish just after it — and write the state it saw over the newer one.
      off();
      await this.settleBuild(runId, record, emit);
    } catch (err) {
      const reason = (err as Error).message;
      emit({ type: 'build-failed', runId, phase: 'orchestrator', reason });
      await this.opts.store.setMode(runId, 'failed', reason);
    } finally {
      off();
    }
  }

  /** Best-effort narrator startup; its failure must not sink a build. */
  private async startNarrator(runId: string): Promise<void> {
    const language = detectLanguage(await this.opts.store.readChat(runId));
    const run = this.runs.get(runId);
    if (!run) return;
    const n = new Narrator({
      runId,
      sessionManager: this.opts.sessionManager,
      language,
      onChat: (text) => {
        void this.opts.store.appendChat(runId, { role: 'system', kind: 'narrator', text });
        this.emit(run, { type: 'chat', entry: { role: 'system', kind: 'narrator', text } });
      },
    });
    this.narrators.set(runId, n);
    try {
      await n.start();
    } catch {
      this.narrators.delete(runId);
    }
  }

  /**
   * Translate the run's kernel events into build events and mode transitions.
   *
   * The mode is recomputed from the record every time rather than stepped
   * forward, so a handler that arrives late cannot write a stale value over a
   * newer one — which it otherwise can, because these handlers are async and the
   * kernel does not wait for them.
   */
  private subscribeKernel(
    kernelRunId: string,
    runId: string,
    emit: (e: BuildEvent) => void,
    ctx: { version: string; codebasePath: string },
  ): () => void {
    const onEvent = (event: KernelEvent): void => {
      void this.onKernelEvent(event, runId, emit, ctx).catch(() => {
        // Projection is best-effort: a failed mode write must not stop the run.
      });
    };
    this.kernel.on(kernelRunId, onEvent);
    return () => this.kernel.off(kernelRunId, onEvent);
  }

  private async onKernelEvent(
    event: KernelEvent,
    runId: string,
    emit: (e: BuildEvent) => void,
    ctx: { version: string; codebasePath: string },
  ): Promise<void> {
    if (event.type !== 'node_state') return;
    const record = this.kernel.get(ultraappKernelRunId(runId));
    const node = record?.nodes[event.node];
    const rounds = Number((node?.data as { rounds?: number } | undefined)?.rounds ?? 0);

    if (event.node === 'build' && event.state === 'running') emit({ type: 'fix-start', runId });
    if (event.state === 'succeeded' && event.node === 'synth') {
      emit({ type: 'council-consensus', runId, rounds });
    }
    if (event.state === 'succeeded' && event.node === 'build') {
      emit({ type: 'fix-complete', runId, rounds });
      await this.opts.store.recordBuildArtifact(runId, { worktreePath: ctx.codebasePath, version: ctx.version });
      emit({ type: 'build-complete', runId, worktreePath: ctx.codebasePath });
    }
    await this.projectMode(runId);
  }

  /**
   * Write UltraApp's mode as it is implied by the kernel record, right now.
   *
   * Serialised per run, and that is the whole mechanism. These are fired from
   * async event handlers, so two of them can read the record at different
   * moments and still write in the opposite order — which showed up as a run
   * that had already failed reverting to `building`. Chaining read-compute-write
   * makes the last write the one computed last, and the kernel record only ever
   * moves forward, so the last computed value is the current one.
   */
  private projectMode(runId: string): Promise<void> {
    const previous = this.projectChain.get(runId) ?? Promise.resolve();
    const next = previous.then(() => this.projectModeNow(runId)).catch(() => undefined);
    this.projectChain.set(runId, next);
    return next;
  }

  private async projectModeNow(runId: string): Promise<void> {
    const record = this.kernel.get(ultraappKernelRunId(runId));
    if (!record) return;
    const mode = ultraappModeOf(record);
    const failure =
      mode === 'failed'
        ? (Object.values(record.nodes).find((n) => n.state === 'failed')?.error ?? record.error)
        : undefined;
    await this.opts.store.setMode(runId, mode, failure);
  }

  /** Emit the terminal build event and settle the mode from the final record. */
  private async settleBuild(
    runId: string,
    record: RunRecord | undefined,
    emit: (e: BuildEvent) => void,
  ): Promise<void> {
    if (!record) {
      await this.opts.store.setMode(runId, 'failed', 'the build run disappeared');
      return;
    }
    if (record.state !== 'completed' && record.state !== 'cancelled') {
      const failing = Object.values(record.nodes).find((n) => n.state === 'failed');
      emit({
        type: 'build-failed',
        runId,
        phase: buildPhaseOf(failing?.id),
        reason: failing?.error ?? record.error ?? 'build failed',
      });
    }
    await this.projectMode(runId);
  }

  /**
   * Deploy the built codebase and check the deployed thing.
   *
   * Returns an outcome rather than writing modes: the mode is projected from the
   * kernel now, and a stage that also wrote it would put the two back out of
   * step. The acceptance verdict comes back with the outcome because it is the
   * run's terminal verdict — §7g screenshots are taken against a URL that does
   * not exist until this has run, so the contract cannot sit in the spec.
   */
  private async deployStage(args: {
    runId: string;
    version: string;
    worktreePath: string;
    slug: string;
  }): Promise<UltraappDeployOutcome> {
    const router = this.opts.router!;
    // Recorded here rather than only from the build-succeeded handler: those
    // handlers are async and do not gate the next node, so the deploy could
    // reach `recordDeploy` before the artifact it belongs to existed. Writing
    // it is an upsert keyed by version, so doing it in both places is safe.
    await this.opts.store.recordBuildArtifact(args.runId, {
      worktreePath: args.worktreePath,
      version: args.version,
    });
    const taken = new Set(router.list().map((r) => r.port));
    const deploy = this.opts.deployFn ?? deployArtifact;
    const useDocker = this.opts.runtimeMode === 'docker';
    const dep = await deploy({
      runId: args.runId,
      version: args.version,
      worktreePath: args.worktreePath,
      slug: args.slug,
      hostDataDir: this.opts.store.runDirAbsolute(args.runId),
      // Host-spawn (default) runs the codebase as a regular Node process;
      // Docker (opt-in) runs `docker build` + `docker run`. Both use the
      // same orchestrator interface so the deploy state machine doesn't care.
      dockerBuild: (a) => (useDocker ? dockerBuild(a) : hostBuild({ tag: a.tag, cwd: a.cwd, buildArgs: a.buildArgs })),
      dockerRun: (a) =>
        useDocker
          ? dockerRun(a)
          : hostRun({
              ...a,
              // Host runner needs the cwd; smuggle it through env (deploy.ts
              // passes `image: tag` so we can't use that field).
              // Also set DATA_DIR to a writable per-run path — the conventions
              // tell generated codebases to use process.env.DATA_DIR ?? '/data'.
              // In Docker mode that defaults to '/data' (a mounted volume).
              // In host mode we point it at the run's host data dir.
              env: {
                ...a.env,
                HOST_CWD: args.worktreePath,
                DATA_DIR: path.join(this.opts.store.runDirAbsolute(args.runId), 'data'),
              },
            }),
      router,
      fetchFn: fetch,
      takenPorts: taken,
    });
    if (!dep.ok) return { ok: false, reason: `deploy: ${dep.reason ?? 'unknown'}` };

    await this.opts.store.recordDeploy(args.runId, args.version, {
      url: dep.url!,
      port: dep.port!,
      containerName: dep.containerName!,
      imageTag: dep.imageTag!,
    });

    // §7g, enforced by the runtime instead of by persona text. We capture the
    // two viewports ourselves against the deployed URL and store the PNGs as
    // evidence, so "did anyone actually look" stops being an agent's claim.
    // We do not judge the pixels — that is still a reader's call.
    const deployContract = ultraappDeployContract(dep.url!);
    const evidenceId = 'deploy-01';
    const deployArtifactDir = path.join(this.opts.store.runDirAbsolute(args.runId), 'evidence', evidenceId);
    const deployChecks = this.opts.runDeployChecksFn
      ? await this.opts.runDeployChecksFn(deployContract, args.worktreePath, deployArtifactDir)
      : await runChecks(deployContract, { cwd: args.worktreePath, artifactDir: deployArtifactDir });
    await writeEvidence({
      runDir: this.opts.store.runDirAbsolute(args.runId),
      runId: args.runId,
      node: 'deploy',
      evidenceId,
      cwd: args.worktreePath,
      contractId: 'ultraapp-deploy',
      results: deployChecks,
      rounds: 0,
    });
    const passed = contractPassed(deployChecks);
    if (!passed) {
      const failed = deployChecks.filter((c) => c.required && !c.passed);
      return {
        ok: false,
        reason: `acceptance: ${failed.map((f) => f.detail).join('; ')}`,
        url: dep.url,
        evidenceId,
        passed: false,
      };
    }
    if (!visualGateIsStrict()) {
      const shot = deployChecks.find((c) => c.id === 'frontend-gate');
      if (shot && !shot.passed) {
        await this.opts.store.appendChat(args.runId, {
          role: 'system',
          kind: 'error',
          text: `Frontend gate: ${shot.detail}. Screenshots are captured by the runtime; set CLAWO_ULTRAAPP_VISUAL_GATE=strict to make a failed capture block the deploy.`,
        });
      }
    }

    const run = this.runs.get(args.runId);
    if (run) this.emit(run, { type: 'app-url', url: dep.url!, version: args.version });
    return { ok: true, url: dep.url, evidenceId, passed: true };
  }

  async startContainer(runId: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.opts.router) return { ok: false, error: 'router not configured' };
    const arts = await this.opts.store.readArtifacts(runId);
    const latest = arts[arts.length - 1];
    if (!latest?.deploy) return { ok: false, error: 'no deployed artifact' };
    const spec = await this.opts.store.readSpec(runId);
    const useDocker = this.opts.runtimeMode === 'docker';
    const r = await startContainerAndRegister(
      latest.deploy.containerName,
      spec.meta.name,
      latest.deploy.port,
      this.opts.router,
      useDocker ? undefined : { dockerStartFn: async (n) => (await import('./host-strategy.js')).hostStart(n) },
    );
    return r;
  }

  async stopContainer(runId: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.opts.router) return { ok: false, error: 'router not configured' };
    const arts = await this.opts.store.readArtifacts(runId);
    const latest = arts[arts.length - 1];
    if (!latest?.deploy) return { ok: false, error: 'no deployed artifact' };
    const spec = await this.opts.store.readSpec(runId);
    const useDocker = this.opts.runtimeMode === 'docker';
    return stopContainerAndDeregister(
      latest.deploy.containerName,
      spec.meta.name,
      this.opts.router,
      useDocker ? undefined : { dockerStopFn: async (n) => (await import('./host-strategy.js')).hostStop(n) },
    );
  }

  async deleteRun(runId: string): Promise<{ ok: boolean; error?: string }> {
    const arts = await this.opts.store.readArtifacts(runId).catch(() => []);
    const latest = arts[arts.length - 1];
    let spec: AppSpec | null = null;
    try {
      spec = await this.opts.store.readSpec(runId);
    } catch {
      /* run already gone */
    }
    const useDocker = this.opts.runtimeMode === 'docker';
    if (latest?.deploy && spec && this.opts.router) {
      await deleteContainerAndDeregister(
        latest.deploy.containerName,
        spec.meta.name,
        this.opts.router,
        useDocker ? undefined : { dockerRmFn: async (n) => (await import('./host-strategy.js')).hostRm(n) },
      );
      const rmiFn = useDocker ? dockerRmi : hostRmi;
      await rmiFn(latest.deploy.imageTag).catch(() => {
        /* image may not exist */
      });
    }
    // Stop & forget the active run if any
    const run = this.runs.get(runId);
    if (run) {
      await this.opts.sessionManager.stopSession(run.sessionName).catch(() => {});
      this.runs.delete(runId);
    }
    await this.opts.store.deleteRunFiles(runId);
    return { ok: true };
  }

  /**
   * Done-mode chat message — classified into cosmetic / spec-delta /
   * structural and routed accordingly. Cosmetic runs the patcher inline;
   * spec-delta flips mode back to interview with a focused bootstrap;
   * structural posts a narrator note suggesting a new run.
   */
  async submitDoneModeMessage(runId: string, text: string): Promise<void> {
    const run = this.requireRun(runId);
    const state = await this.opts.store.readState(runId);
    if (state.mode !== 'done') {
      // Outside done mode, fall through to the standard interview answer flow
      return this.submitAnswer(runId, { value: '', freeform: text });
    }

    await this.opts.store.appendChat(runId, { role: 'user', kind: 'free', text });
    this.emit(run, { type: 'chat', entry: { role: 'user', kind: 'free', text } });

    const spec = await this.opts.store.readSpec(runId);
    const language = detectLanguage(await this.opts.store.readChat(runId));
    const cls = await classifyFeedback({
      text,
      currentSpec: spec,
      language,
      llmCall: (p) => this.classifierCall(runId, p),
    });

    const announce = `I read this as a ${cls.class} change. ${cls.proposedAction}. Stop me if that's wrong.`;
    await this.opts.store.appendChat(runId, { role: 'system', kind: 'narrator', text: announce });
    this.emit(run, { type: 'chat', entry: { role: 'system', kind: 'narrator', text: announce } });

    await this.routeFeedback(runId, cls.class, text, spec);
  }

  /**
   * Promote a previously-built version to the currently-deployed one.
   * Stops the current container, starts the target's container, and updates
   * the router map atomically.
   */
  async promoteVersion(runId: string, toVersion: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.opts.router) return { ok: false, error: 'router not configured' };
    const versions = listVersions(this.opts.store.versionsDir(runId));
    const current = versions.find((v) => v.deploy?.containerName);
    const target = versions.find((v) => v.version === toVersion);
    if (!target?.deploy) return { ok: false, error: `version ${toVersion} has no deploy` };
    const spec = await this.opts.store.readSpec(runId);
    const r = await swapVersion({
      versionsDir: this.opts.store.versionsDir(runId),
      fromVersion: current?.version ?? toVersion,
      toVersion,
      slug: spec.meta.name,
      router: this.opts.router,
      startContainer: async (name: string) => {
        const { dockerStart } = await import('./docker.js');
        return dockerStart(name);
      },
      stopContainer: async (name: string) => {
        const { dockerStop } = await import('./docker.js');
        return dockerStop(name);
      },
    });
    if (r.ok) {
      const run = this.runs.get(runId);
      if (run) this.emit(run, { type: 'app-url', url: target.deploy.url, version: toVersion });
    }
    return r;
  }

  /** Used by spec-delta to push a system-style bootstrap into the run session. */
  async injectSystemMessage(runId: string, text: string): Promise<void> {
    const run = this.requireRun(runId);
    await this.opts.sessionManager.sendMessage(run.sessionName, `[system] ${text}`);
  }

  /** Used by spec-delta to flip mode back to 'interview' for the focused
      interview, AND mark the run so the next interview-complete auto-fires
      a build (no need for the user to click Start Build for a delta rerun). */
  async setModeForDelta(runId: string): Promise<void> {
    await this.opts.store.setMode(runId, 'interview');
    const run = this.runs.get(runId);
    if (run) {
      run.deltaPending = true;
      const spec = await this.opts.store.readSpec(runId);
      this.emit(run, { type: 'spec-updated', spec });
    }
  }

  private async classifierCall(runId: string, prompt: string): Promise<{ output: string }> {
    const sessionName = `classifier-${runId}`;
    if (!this.classifierSessions.has(runId)) {
      await this.opts.sessionManager.startSession({
        name: sessionName,
        engine: 'claude',
        model: 'claude-haiku-4-5-20251001',
        permissionMode: 'bypassPermissions',
      });
      this.classifierSessions.add(runId);
    }
    return this.opts.sessionManager.sendMessage(sessionName, prompt);
  }

  private async routeFeedback(runId: string, klass: FeedbackClass, text: string, spec: AppSpec): Promise<void> {
    const run = this.requireRun(runId);
    if (klass === 'cosmetic') {
      await this.runPatcherFlow(runId, text);
      return;
    }
    if (klass === 'spec-delta') {
      await startSpecDeltaInterview(this, runId, text, spec);
      return;
    }
    // structural
    const note = 'This sounds like a different app entirely. Click + New in the sidebar to start a fresh ultraapp run.';
    await this.opts.store.appendChat(runId, { role: 'system', kind: 'narrator', text: note });
    this.emit(run, { type: 'chat', entry: { role: 'system', kind: 'narrator', text: note } });
  }

  private async runPatcherFlow(runId: string, feedback: string): Promise<void> {
    const run = this.requireRun(runId);
    const versions = listVersions(this.opts.store.versionsDir(runId));
    const current = versions.find((v) => v.deploy?.containerName) ?? versions[versions.length - 1];
    if (!current?.worktreePath) {
      const err = 'no buildable worktree found for patcher';
      this.emit(run, { type: 'error', message: err });
      return;
    }

    const patch = await runPatcher({
      worktreePath: current.worktreePath,
      feedback,
      llmCall: (p) => this.patcherCall(runId, p),
      validate: (a) => runFixOnFailure({ ...a, maxRounds: 3 }),
    });
    if (!patch.ok) {
      const msg = `Patcher failed: ${patch.reason ?? 'unknown'}`;
      await this.opts.store.appendChat(runId, { role: 'system', kind: 'error', text: msg });
      this.emit(run, { type: 'chat', entry: { role: 'system', kind: 'error', text: msg } });
      return;
    }
    const nextVersion = snapshotVersion(this.opts.store.versionsDir(runId), {
      worktreePath: current.worktreePath,
      source: 'patcher',
    });
    const msg = `Patched and saved as ${nextVersion}. Promote it from the AppSpec column to swap the deployed container.`;
    await this.opts.store.appendChat(runId, { role: 'system', kind: 'narrator', text: msg });
    this.emit(run, { type: 'chat', entry: { role: 'system', kind: 'narrator', text: msg } });
  }

  private async patcherCall(runId: string, prompt: string): Promise<{ output: string }> {
    const sessionName = `patcher-${runId}-${Date.now()}`;
    await this.opts.sessionManager.startSession({
      name: sessionName,
      engine: 'claude',
      model: 'claude-opus-4-7',
      permissionMode: 'bypassPermissions',
    });
    try {
      return await this.opts.sessionManager.sendMessage(sessionName, prompt);
    } finally {
      await this.opts.sessionManager.stopSession(sessionName).catch(() => {});
    }
  }

  private onBuildEvent(ev: BuildEvent): void {
    const run = this.runs.get(ev.runId);
    if (!run) return;
    // Always emit raw event for the dashboard mode pill.
    this.emit(run, { type: 'build-event', event: ev });
    // Push to the narrator (started in runBuild). The narrator owns chat
    // narration now — no raw-line writes from this handler.
    const narrator = this.narrators.get(ev.runId);
    if (narrator) narrator.push(ev);

    // Tear down narrator on terminal events. push() above already triggered
    // its urgent flush, so by the time we stop() any final summary is queued.
    if (ev.type === 'build-complete' || ev.type === 'build-failed' || ev.type === 'build-cancelled') {
      const n = this.narrators.get(ev.runId);
      if (n) {
        this.narrators.delete(ev.runId);
        this.trackBackground(n.stop());
      }
    }
  }

  /**
   * Drain all in-flight background work (driveTurn chains, build-queue
   * enqueue, narrator finalisation). Tests should await this in their
   * cleanup hook before removing the per-run tmp directory.
   */
  async waitForIdle(): Promise<void> {
    while (this.inflightWork.size > 0) {
      await Promise.allSettled([...this.inflightWork]);
    }
  }

  private fireDriveTurn(run: ActiveRun, message: string): void {
    this.trackBackground(this.driveTurn(run, message));
  }

  private trackBackground<T>(p: Promise<T>): void {
    const tracked = p.finally(() => this.inflightWork.delete(tracked));
    this.inflightWork.add(tracked);
  }

  private async driveTurn(run: ActiveRun, message: string): Promise<void> {
    try {
      const { output } = await this.opts.sessionManager.sendMessage(run.sessionName, message);
      // Debug capture for trace authoring: when UA_DEBUG_TURNS=<dir> is set,
      // append every turn's (in, out) pair to <dir>/<runId>.turns.jsonl. No
      // effect when unset. Used by scripts/ua-capture-trace.mjs to rebuild a
      // replayable JSONL trace from a real interview run.
      const debugDir = process.env.UA_DEBUG_TURNS;
      if (debugDir) {
        try {
          fs.mkdirSync(debugDir, { recursive: true });
          fs.appendFileSync(
            path.join(debugDir, `${run.runId}.turns.jsonl`),
            JSON.stringify({ ts: new Date().toISOString(), in: message, out: output }) + '\n',
          );
        } catch {
          /* best-effort */
        }
      }
      const parsed = parseInterviewReply(output);

      if (parsed.kind === 'tools' || parsed.kind === 'tools-and-question') {
        const results = await runToolCalls({
          runId: run.runId,
          store: this.opts.store,
          extractMetadata: defaultExtractMetadata,
          calls: parsed.toolCalls,
        });
        const spec = await this.opts.store.readSpec(run.runId);
        this.emit(run, { type: 'spec-updated', spec });
        const followup = results
          .map(
            (r) =>
              `<tool_result name="${r.name}">${r.ok ? JSON.stringify(r.result) : `ERROR: ${r.error}`}</tool_result>`,
          )
          .join('\n');
        if (parsed.kind === 'tools-and-question') {
          // Claude already wrote the next question; surface it to the user
          // immediately. Send the tool_result followup in the background so
          // the LLM sees the tool succeeded — but we don't block the user
          // on its reply (it's typically a "thanks, continuing" no-op).
          await this.opts.store.appendChat(run.runId, {
            role: 'assistant',
            kind: 'question',
            text: parsed.question.question,
            payload: { ...parsed.question },
          });
          this.emit(run, { type: 'question', question: parsed.question });
          this.fireDriveTurn(run, followup);
          return;
        }
        this.fireDriveTurn(run, followup);
        return;
      }

      if (parsed.kind === 'question') {
        await this.opts.store.appendChat(run.runId, {
          role: 'assistant',
          kind: 'question',
          text: parsed.question.question,
          payload: { ...parsed.question },
        });
        this.emit(run, { type: 'question', question: parsed.question });
        return;
      }

      if (parsed.kind === 'complete') {
        await this.opts.store.appendChat(run.runId, {
          role: 'assistant',
          kind: 'narrator',
          text: parsed.summary,
        });
        this.emit(run, { type: 'interview-complete', summary: parsed.summary });
        // If this completion came out of a spec-delta focused interview, the
        // user already signalled their intent to rebuild — auto-start so they
        // don't have to click again. Best-effort: a strict-validation failure
        // surfaces as an error chat entry and the user can fix + click Build.
        if (run.deltaPending) {
          run.deltaPending = false;
          const note = 'Spec delta complete — auto-starting build.';
          await this.opts.store.appendChat(run.runId, {
            role: 'system',
            kind: 'narrator',
            text: note,
          });
          this.emit(run, {
            type: 'chat',
            entry: { role: 'system', kind: 'narrator', text: note },
          });
          this.startBuild(run.runId).catch((err) => {
            const msg = `Auto-build failed: ${(err as Error).message}`;
            void this.opts.store.appendChat(run.runId, {
              role: 'system',
              kind: 'error',
              text: msg,
            });
            this.emit(run, {
              type: 'chat',
              entry: { role: 'system', kind: 'error', text: msg },
            });
          });
        }
        return;
      }

      if (parsed.kind === 'text') {
        await this.opts.store.appendChat(run.runId, {
          role: 'assistant',
          kind: 'free',
          text: parsed.text,
        });
        this.emit(run, {
          type: 'chat',
          entry: { role: 'assistant', kind: 'free', text: parsed.text },
        });
        return;
      }

      this.emit(run, { type: 'error', message: parsed.reason });
    } catch (e) {
      this.emit(run, { type: 'error', message: (e as Error).message });
    }
  }

  private emit(run: ActiveRun, ev: RunEvent): void {
    run.emitter.emit('event', ev);
  }

  private requireRun(runId: string): ActiveRun {
    const r = this.runs.get(runId);
    if (!r) throw new Error(`unknown runId: ${runId}`);
    return r;
  }
}

function detectLanguage(chat: ChatEntry[]): 'zh' | 'en' {
  for (const e of chat) {
    if (e.role !== 'user') continue;
    if (/[一-龥]/.test(e.text)) return 'zh';
    return 'en';
  }
  return 'en';
}

function loadSkill(skillPath?: string): string {
  if (skillPath) {
    try {
      return fs.readFileSync(skillPath, 'utf8');
    } catch {
      /* fall through */
    }
  }
  // Resolve relative to this module: src/ultraapp/manager.ts → ../../skills/ultraapp/SKILL.md
  // After build, dist/src/ultraapp/manager.js → ../../../skills/ultraapp/SKILL.md
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, '../../skills/ultraapp/SKILL.md'),
    path.resolve(here, '../../../skills/ultraapp/SKILL.md'),
    path.resolve(process.cwd(), 'skills/ultraapp/SKILL.md'),
  ];
  for (const c of candidates) {
    try {
      return fs.readFileSync(c, 'utf8');
    } catch {
      /* try next */
    }
  }
  // Test fallback — minimal but functional contract
  return [
    'You are running the ultraapp interview. Emit one question per turn as a fenced ```question JSON block with',
    '{"question": str, "options": [{"label": str, "value": str}], "recommended": str, "freeformAccepted": bool, "context"?: str}.',
    'Use <tool name="update_spec">[...JSON Patch...]</tool>, <tool name="extract_metadata">{"ref": str}</tool>,',
    '<tool name="check_completeness">{}</tool>. End with [INTERVIEW: COMPLETE] when done.',
  ].join(' ');
}
