import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type AppSpec, validateAppSpec } from './spec.js';
import { type UltraappStore, type ChatEntry } from './store.js';
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
import { ultraappBuildContract, ultraappDeployContract, visualGateIsStrict } from './contract.js';
import { runChecks } from '../verify/runner.js';
import { contractPassed, type AcceptanceContract, type CheckResult } from '../verify/contract.js';
import { writeEvidence } from '../verify/evidence.js';
import { spawnFixerSessionWith } from './fix-on-failure-session.js';
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
  /** Test seam: stub the deploy state machine. */
  deployFn?: (a: DeployArgs) => Promise<DeployResult>;
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

export class UltraappManager {
  private readonly runs = new Map<string, ActiveRun>();
  private readonly skillContent: string;
  private readonly buildQueue: UltraappBuildQueue;
  private readonly narrators = new Map<string, Narrator>();
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
    });
    this.buildQueue.subscribe((ev) => this.onBuildEvent(ev));
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
  }

  buildPosition(runId: string): number {
    return this.buildQueue.position(runId);
  }

  private async runBuild(runId: string, emit: (e: BuildEvent) => void): Promise<void> {
    await this.opts.store.setMode(runId, 'building');

    // Start the narrator before any build event fires so onBuildEvent can
    // push synchronously without racing async session-spawn. Best-effort —
    // narrator failure shouldn't sink the build.
    const language = detectLanguage(await this.opts.store.readChat(runId));
    const run = this.runs.get(runId);
    if (run) {
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

    emit({ type: 'build-start', runId });
    const spec = await this.opts.store.readSpec(runId);
    const runDir = this.opts.store.runDirAbsolute(runId);

    const council = await runCouncilSynth({
      spec,
      runId,
      runDir,
      sessionManager: this.opts.sessionManager,
    });
    if (!council.ok) {
      emit({ type: 'build-failed', runId, phase: 'council', reason: council.reason ?? 'unknown' });
      await this.opts.store.setMode(runId, 'failed', council.reason);
      return;
    }
    emit({ type: 'council-consensus', runId, rounds: council.rounds });

    emit({ type: 'fix-start', runId });
    const useDocker = this.opts.runtimeMode === 'docker';
    const fix = await runFixOnFailure({
      worktreePath: council.worktreePath!,
      maxRounds: 5,
      // Reuse the same SessionManager so the fixer doesn't spawn a fresh one per fix.
      spawnFixer: (a) => spawnFixerSessionWith(this.opts.sessionManager, a),
      // The build contract adds the `npm run smoke` step that §4 of the
      // conventions has always told the council was binding, and that the code
      // never actually ran. Host mode drops the docker-build check.
      contract: ultraappBuildContract({ useDocker }),
      artifactDir: path.join(this.opts.store.runDirAbsolute(runId), 'evidence', 'build-artifacts'),
    });
    if (fix.results) {
      await writeEvidence({
        runDir: this.opts.store.runDirAbsolute(runId),
        runId,
        node: 'build',
        evidenceId: 'build-01',
        cwd: council.worktreePath!,
        contractId: 'ultraapp-build',
        results: fix.results,
        rounds: fix.rounds,
      });
    }
    if (!fix.ok) {
      emit({
        type: 'build-failed',
        runId,
        phase: 'fix-on-failure',
        reason: fix.lastError ?? 'budget exhausted',
      });
      await this.opts.store.setMode(runId, 'failed', fix.lastError);
      return;
    }
    emit({ type: 'fix-complete', runId, rounds: fix.rounds });

    const version = 'v1';
    await this.opts.store.recordBuildArtifact(runId, {
      worktreePath: council.worktreePath!,
      version,
    });
    await this.opts.store.setMode(runId, 'build-complete');
    emit({ type: 'build-complete', runId, worktreePath: council.worktreePath! });

    // If a router is wired, continue into deploy. Without a router (legacy v0.2
    // wiring or test setup), build-complete is the resting state.
    if (!this.opts.router) return;

    await this.runDeployStage({
      runId,
      version,
      worktreePath: council.worktreePath!,
      slug: spec.meta.name,
      emit,
    });
  }

  private async runDeployStage(args: {
    runId: string;
    version: string;
    worktreePath: string;
    slug: string;
    emit: (e: BuildEvent) => void;
  }): Promise<void> {
    const router = this.opts.router!;
    await this.opts.store.setMode(args.runId, 'deploying');
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
    if (!dep.ok) {
      args.emit({
        type: 'build-failed',
        runId: args.runId,
        phase: 'orchestrator',
        reason: `deploy: ${dep.reason ?? 'unknown'}`,
      });
      await this.opts.store.setMode(args.runId, 'failed', dep.reason);
      return;
    }
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
    const deployArtifactDir = path.join(this.opts.store.runDirAbsolute(args.runId), 'evidence', 'deploy-01');
    const deployChecks = this.opts.runDeployChecksFn
      ? await this.opts.runDeployChecksFn(deployContract, args.worktreePath, deployArtifactDir)
      : await runChecks(deployContract, { cwd: args.worktreePath, artifactDir: deployArtifactDir });
    await writeEvidence({
      runDir: this.opts.store.runDirAbsolute(args.runId),
      runId: args.runId,
      node: 'deploy',
      evidenceId: 'deploy-01',
      cwd: args.worktreePath,
      contractId: 'ultraapp-deploy',
      results: deployChecks,
      rounds: 0,
    });
    if (!contractPassed(deployChecks)) {
      const failed = deployChecks.filter((c) => c.required && !c.passed);
      args.emit({
        type: 'build-failed',
        runId: args.runId,
        phase: 'orchestrator',
        reason: `acceptance: ${failed.map((f) => f.detail).join('; ')}`,
      });
      await this.opts.store.setMode(args.runId, 'failed', failed[0]?.detail);
      return;
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

    await this.opts.store.setMode(args.runId, 'done');
    const run = this.runs.get(args.runId);
    if (run) {
      this.emit(run, { type: 'app-url', url: dep.url!, version: args.version });
    }
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
