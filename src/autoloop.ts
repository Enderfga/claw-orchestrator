/**
 * Autoloop driver — phase machine for autonomous workspace iteration.
 *
 * Contract: tasks/autoloop.md.  This file implements the runner; phase prompts
 * live in configs/autoloop-*-prompt.md.
 *
 * Lifecycle (one runner per task):
 *   start() → BOOTSTRAP → loop { PROPOSE → EXECUTE → MEASURE → RATCHET → maybe COMPRESS } → TERMINATED
 *
 * Termination triggers: scalar target hit, max_iters, max_cost_usd, hard error,
 * explicit stop(). Plateau pushes the user but does NOT halt the loop (per
 * design constraint C9 — proactivity).
 */

import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawn, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { SessionManager } from './session-manager.js';
import type { Logger } from './logger.js';
import { nullLogger } from './logger.js';
import type { EngineType } from './types.js';
import type {
  AutoloopConfig,
  AutoloopHandle,
  AutoloopState,
  EvalOutput,
  GateResult,
  GoalSpec,
  MetricHistoryEntry,
  PushEvent,
  PushKind,
  RatchetOutput,
} from './autoloop-types.js';
import type { SendResult, StreamEvent } from './types.js';
import { deriveMetric, isImprovement, isTargetReached, validateGoalSpec } from './autoloop-types.js';

// ─── Module-local config helpers ───────────────────────────────────────────

function resolveConfigPath(filename: string): string {
  const filePath = fileURLToPath(import.meta.url);
  const dir = path.dirname(filePath);
  const candidates = [path.join(dir, '..', 'configs', filename), path.join(dir, '..', '..', 'configs', filename)];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return candidates[0];
}

function loadPrompt(name: string, vars: Record<string, string | number>): string {
  const tpl = fs.readFileSync(resolveConfigPath(name), 'utf-8');
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => String(vars[k] ?? `{{${k}}}`));
}

// ─── Atomic state I/O ──────────────────────────────────────────────────────

function writeJsonAtomic(filePath: string, data: unknown): void {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, filePath);
}

function appendJsonArray(filePath: string, entry: unknown): void {
  let arr: unknown[] = [];
  if (fs.existsSync(filePath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      if (Array.isArray(parsed)) arr = parsed;
    } catch {
      // Treat malformed history as empty rather than crashing the loop.
    }
  }
  arr.push(entry);
  writeJsonAtomic(filePath, arr);
}

// ─── Shell helpers (with kill-switch enforcement) ──────────────────────────

interface ShellResult {
  exit_code: number;
  stdout: string;
  stderr: string;
  duration_ms: number;
  timed_out: boolean;
}

/**
 * Run a shell command with a hard wall-clock cap. The command is spawned in
 * its own process group so we can SIGKILL the entire tree on timeout — the
 * default exec/spawn behaviour only kills the shell wrapper, leaving children
 * orphaned (see CLAUDE.md recovery-path notes).
 */
async function runShell(cmd: string, opts: { cwd: string; timeout_ms: number }): Promise<ShellResult> {
  const start = Date.now();
  return new Promise((resolve) => {
    const child = spawn('/bin/sh', ['-c', cmd], {
      cwd: opts.cwd,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    child.stdout?.on('data', (b) => {
      stdout += b.toString();
      // Cap collected output to avoid OOM on chatty commands.
      if (stdout.length > 1024 * 1024) stdout = stdout.slice(-1024 * 1024);
    });
    child.stderr?.on('data', (b) => {
      stderr += b.toString();
      if (stderr.length > 256 * 1024) stderr = stderr.slice(-256 * 1024);
    });

    const killTimer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid != null) process.kill(-child.pid, 'SIGKILL');
      } catch {
        // Already dead.
      }
    }, opts.timeout_ms);

    child.on('close', (code) => {
      clearTimeout(killTimer);
      resolve({
        exit_code: code == null ? -1 : code,
        stdout,
        stderr,
        duration_ms: Date.now() - start,
        timed_out: timedOut,
      });
    });
  });
}

// ─── Runner ────────────────────────────────────────────────────────────────

export class AutoloopRunner extends EventEmitter {
  readonly id: string;
  readonly config: AutoloopConfig;
  readonly taskDir: string;
  readonly branch: string;

  private state!: AutoloopState;
  private goal!: GoalSpec;
  private stopRequested = false;
  private startedAt = '';
  private endedAt?: string;
  private status: AutoloopState['status'] = 'starting';
  private errorMsg?: string;
  private readonly manager: SessionManager;
  private readonly logger: Logger;

  constructor(manager: SessionManager, config: AutoloopConfig, logger: Logger = nullLogger) {
    super();
    this.manager = manager;
    this.config = config;
    this.id = config.task_id || `autoloop-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    this.taskDir = path.join(config.workspace, 'tasks', this.id);
    this.branch = `autoloop/${this.id}`;
    this.logger = logger;
  }

  // ─── Public API ────────────────────────────────────────────────────────

  /** Start the loop. Resolves after BOOTSTRAP; iteration runs in the background. */
  async start(): Promise<void> {
    this.startedAt = new Date().toISOString();
    this.emit('starting');

    try {
      this.prepareTaskDir();
      this.goal = this.loadAndValidateGoal();
      this.state = this.initialState();
      this.persistState();
      this.ensureBranch();
    } catch (err) {
      this.fail(`init failed: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }

    // BOOTSTRAP synchronously — failure aborts before iteration starts.
    const ok = await this.runBootstrap();
    if (!ok) {
      this.fail('bootstrap failed');
      return;
    }

    this.status = 'running';
    this.persistState();

    // Run the loop in the background; let start() return.
    void this.runLoop().catch((err) => {
      this.fail(`loop crashed: ${err instanceof Error ? err.stack || err.message : String(err)}`);
    });
  }

  /** Ask the loop to halt at the next phase boundary. Resolves when actually stopped. */
  async stop(): Promise<void> {
    this.stopRequested = true;
    // Spin briefly to wait for the loop to exit. Worst case the runner is mid-LLM-call.
    for (let i = 0; i < 60; i++) {
      if (this.status !== 'running') return;
      await new Promise((r) => setTimeout(r, 1000));
    }
    // Force mark stopped; the in-flight phase will discover stopRequested on next check.
    if (this.status === 'running') {
      this.status = 'stopped';
      this.endedAt = new Date().toISOString();
      this.persistState();
    }
  }

  /** Inject a hint that the next PROPOSE will read. */
  inject(text: string): void {
    const inbox = path.join(this.taskDir, 'inbox.md');
    const ts = new Date().toISOString();
    fs.appendFileSync(inbox, `\n---\n## ${ts} (injection)\n\n${text}\n`);
    this.emit('inject', { ts, text });
  }

  /** Cheap status snapshot from in-memory state. */
  handle(): AutoloopHandle {
    return {
      id: this.id,
      status: this.status,
      task_dir: this.taskDir,
      started_at: this.startedAt,
      ended_at: this.endedAt,
      current_phase: this.state?.phase,
      current_iter: this.state?.iter,
      best_metric: this.state?.best?.metric,
      error: this.errorMsg,
    };
  }

  // ─── Setup ─────────────────────────────────────────────────────────────

  private prepareTaskDir(): void {
    if (!fs.existsSync(this.config.workspace)) {
      throw new Error(`workspace does not exist: ${this.config.workspace}`);
    }
    const gitDir = path.join(this.config.workspace, '.git');
    if (!fs.existsSync(gitDir)) {
      throw new Error(`workspace is not a git repo (no .git/ at ${this.config.workspace})`);
    }
    fs.mkdirSync(this.taskDir, { recursive: true });
    fs.mkdirSync(path.join(this.taskDir, 'iter'), { recursive: true });
    fs.copyFileSync(this.config.plan_path, path.join(this.taskDir, 'plan.md'));
    fs.copyFileSync(this.config.goal_path, path.join(this.taskDir, 'goal.json'));
  }

  private loadAndValidateGoal(): GoalSpec {
    const raw = JSON.parse(fs.readFileSync(path.join(this.taskDir, 'goal.json'), 'utf-8'));
    return validateGoalSpec(raw);
  }

  private initialState(): AutoloopState {
    return {
      task_id: this.id,
      branch: this.branch,
      phase: 'BOOTSTRAP',
      status: 'starting',
      iter: 0,
      started_at: this.startedAt,
      best: null,
      last_metric: null,
      plateau_count: 0,
      decision: null,
      decision_reason: null,
      tree: { parent_iter: null, children_iters: [] },
      termination: { fired: false, reason: null },
      cost_usd_so_far: 0,
      pending_aspirational_count: this.goal.aspirational_gates?.length ?? 0,
    };
  }

  private ensureBranch(): void {
    // Create branch if not already on it. Fast-forward if exists.
    const cwd = this.config.workspace;
    runShell(`git rev-parse --verify ${this.branch} >/dev/null 2>&1 || git checkout -b ${this.branch}`, {
      cwd,
      timeout_ms: 10_000,
    }).then(() => {
      runShell(`git checkout ${this.branch}`, { cwd, timeout_ms: 10_000 });
    });
  }

  // ─── Phase: BOOTSTRAP ──────────────────────────────────────────────────

  private async runBootstrap(): Promise<boolean> {
    this.state.phase = 'BOOTSTRAP';
    this.persistState();
    this.emit('phase', { phase: 'BOOTSTRAP', iter: 0 });

    const prompt = loadPrompt('autoloop-bootstrap-prompt.md', {
      task_id: this.id,
      max_aspirational: this.goal.termination.max_pending_aspirational,
    });

    const sessionName = `autoloop-${this.id}-bootstrap`;
    let costUsd = 0;
    try {
      await this.manager.startSession({
        name: sessionName,
        cwd: this.config.workspace,
        engine: this.config.propose_engine || 'claude',
        model: this.config.propose_model || 'opus',
        permissionMode: 'bypassPermissions',
        bare: true,
        systemPrompt: prompt,
        maxTurns: 30,
      });
      const result = await this.manager.sendMessage(sessionName, 'Begin BOOTSTRAP for this task.', {
        timeout: this.config.per_iter_timeout_ms ?? 600_000,
      });
      costUsd = extractCost(result);
    } catch (err) {
      this.logger.error(`[autoloop ${this.id}] bootstrap session failed:`, err);
      return false;
    } finally {
      try {
        await this.manager.stopSession(sessionName);
      } catch {
        // Ignore stop errors.
      }
    }

    this.state.cost_usd_so_far += costUsd;

    // Did bootstrap leave a failure marker?
    const failPath = path.join(this.taskDir, 'bootstrap-failure.md');
    if (fs.existsSync(failPath)) {
      const reason = fs.readFileSync(failPath, 'utf-8').slice(0, 1000);
      await this.push({
        kind: 'hard_error',
        text: `BOOTSTRAP failed for ${this.id}:\n${reason}`,
        task_id: this.id,
        iter: 0,
        ts: new Date().toISOString(),
      });
      return false;
    }

    // If aspirational gates were proposed, push to user.
    const goal = this.loadAndValidateGoal();
    const newAspirational = (goal.aspirational_gates?.length ?? 0) - (this.goal.aspirational_gates?.length ?? 0);
    if (newAspirational > 0) {
      this.goal = goal;
      this.state.pending_aspirational_count = goal.aspirational_gates?.length ?? 0;
      const list = goal.aspirational_gates!.map((g, i) => `${i + 1}. ${g.name}: ${g.cmd}`).join('\n');
      await this.push({
        kind: 'bootstrap_aspirational',
        text: `Autoloop ${this.id} bootstrap done. ${newAspirational} aspirational gates proposed:\n${list}\n\nReply 'lock 1,3,4' or 'reject 2' or paste edits to lock or rotate.`,
        task_id: this.id,
        iter: 0,
        ts: new Date().toISOString(),
      });
    }

    return true;
  }

  // ─── Loop Driver ───────────────────────────────────────────────────────

  private async runLoop(): Promise<void> {
    while (!this.stopRequested) {
      // Termination checks (cheap, do every iter top).
      if (this.state.iter >= this.goal.termination.max_iters) {
        this.terminate('max_iters reached');
        return;
      }
      if (this.state.cost_usd_so_far >= this.goal.termination.max_cost_usd) {
        this.terminate(`max_cost_usd reached ($${this.state.cost_usd_so_far.toFixed(2)})`);
        return;
      }

      this.state.iter += 1;
      const iter = this.state.iter;
      const iterDir = path.join(this.taskDir, 'iter', String(iter));
      fs.mkdirSync(iterDir, { recursive: true });

      try {
        await this.runPropose(iter);
        if (this.stopRequested) break;

        const evalOut = await this.runExecute(iter);
        if (this.stopRequested) break;

        this.runMeasure(iter, evalOut);
        if (this.stopRequested) break;

        await this.runRatchet(iter, evalOut);
      } catch (err) {
        // One iter failure → reset and continue (soft fail). Hard errors still throw.
        this.logger.error(`[autoloop ${this.id}] iter ${iter} crashed:`, err);
        await this.gitReset();
        await this.push({
          kind: 'hard_error',
          text: `iter ${iter} crashed: ${err instanceof Error ? err.message : String(err)}. Continuing.`,
          task_id: this.id,
          iter,
          ts: new Date().toISOString(),
        });
      }

      // Termination from RATCHET decisions (target hit).
      if (this.state.termination.fired) return;

      // COMPRESS check.
      const k = this.config.compress_every_k ?? 10;
      if (iter > 0 && iter % k === 0) {
        await this.runCompress(iter - k + 1, iter);
      }
    }

    if (this.stopRequested) {
      this.status = 'stopped';
      this.endedAt = new Date().toISOString();
      this.state.phase = 'TERMINATED';
      this.persistState();
      this.emit('stopped');
    }
  }

  // ─── Phase: PROPOSE ────────────────────────────────────────────────────

  private async runPropose(iter: number): Promise<void> {
    this.state.phase = 'PROPOSE';
    this.persistState();
    this.emit('phase', { phase: 'PROPOSE', iter });

    const prompt = loadPrompt('autoloop-propose-prompt.md', {
      task_id: this.id,
      iter,
      workspace: this.config.workspace,
    });

    const sessionName = `autoloop-${this.id}-propose-${iter}`;
    try {
      await this.manager.startSession({
        name: sessionName,
        cwd: this.config.workspace,
        engine: this.config.propose_engine || 'claude',
        model: this.config.propose_model || 'opus',
        permissionMode: 'bypassPermissions',
        bare: true,
        systemPrompt: prompt,
        maxTurns: 40,
      });
      const result = await this.manager.sendMessage(sessionName, `Run PROPOSE for iter ${iter}.`, {
        timeout: this.config.per_iter_timeout_ms ?? 600_000,
      });
      this.state.cost_usd_so_far += extractCost(result);
    } finally {
      try {
        await this.manager.stopSession(sessionName);
      } catch {
        // Ignore.
      }
    }

    // Re-read goal in case PROPOSE added an aspirational gate.
    const fresh = this.loadAndValidateGoal();
    this.state.pending_aspirational_count = fresh.aspirational_gates?.length ?? 0;
    if ((fresh.aspirational_gates?.length ?? 0) > (this.goal.aspirational_gates?.length ?? 0)) {
      const added = fresh.aspirational_gates![fresh.aspirational_gates!.length - 1];
      this.goal = fresh;
      await this.push({
        kind: 'aspirational_proposed',
        text: `Autoloop ${this.id} iter ${iter} proposed aspirational gate: ${added.name} (cmd: ${added.cmd}). Reply 'lock' to promote.`,
        task_id: this.id,
        iter,
        ts: new Date().toISOString(),
      });
    }
    this.persistState();
  }

  // ─── Phase: EXECUTE ────────────────────────────────────────────────────

  private async runExecute(iter: number): Promise<EvalOutput> {
    this.state.phase = 'EXECUTE';
    this.persistState();
    this.emit('phase', { phase: 'EXECUTE', iter });

    const cwd = this.config.workspace;
    const gateResults: GateResult[] = [];
    for (const gate of this.goal.gates) {
      const res = await runShell(gate.cmd, {
        cwd,
        timeout_ms: (gate.timeout_sec ?? 300) * 1000,
      });
      gateResults.push({
        name: gate.name,
        passed: res.exit_code === 0 && !res.timed_out,
        exit_code: res.exit_code,
        duration_ms: res.duration_ms,
        output_tail: tail(res.stderr || res.stdout, 500),
      });
    }

    let scalar: number | null = null;
    if (this.goal.scalar) {
      const res = await runShell(this.goal.scalar.extract_cmd, {
        cwd,
        timeout_ms: (this.config.per_iter_timeout_ms ?? 600_000) - 1000,
      });
      if (res.exit_code === 0 && !res.timed_out) {
        const parsed = parseFloat(res.stdout.trim().split(/\s+/).pop() ?? '');
        if (Number.isFinite(parsed)) scalar = parsed;
      }
    }

    const passed = gateResults.filter((g) => g.passed).length;
    const total = gateResults.length;
    const gate_completion = total === 0 ? 1 : passed / total;
    const all_gates_passed = total === 0 ? true : passed === total;

    const evalOut: EvalOutput = {
      iter,
      ts: new Date().toISOString(),
      gates: gateResults,
      scalar,
      gate_completion,
      all_gates_passed,
    };
    writeJsonAtomic(path.join(this.taskDir, 'iter', String(iter), 'eval.json'), evalOut);
    return evalOut;
  }

  // ─── Phase: MEASURE ────────────────────────────────────────────────────

  private runMeasure(iter: number, evalOut: EvalOutput): void {
    this.state.phase = 'MEASURE';
    this.persistState();
    this.emit('phase', { phase: 'MEASURE', iter });

    const metric = deriveMetric(evalOut, this.goal);
    const entry: MetricHistoryEntry = {
      iter,
      ts: evalOut.ts,
      metric,
      gate_completion: evalOut.gate_completion,
      phase_at_record: 'MEASURE',
      git_sha_pre: this.state.best?.git_sha,
      git_sha_post: this.gitSha(),
    };
    appendJsonArray(path.join(this.taskDir, 'metric.json'), entry);
    this.state.last_metric = { iter, metric, gate_completion: evalOut.gate_completion };
    this.persistState();
  }

  // ─── Phase: RATCHET ────────────────────────────────────────────────────

  private async runRatchet(iter: number, evalOut: EvalOutput): Promise<void> {
    this.state.phase = 'RATCHET';
    this.persistState();
    this.emit('phase', { phase: 'RATCHET', iter });

    const sandbox = path.join(os.tmpdir(), `autoloop-ratchet-${this.id}-${iter}`);
    fs.mkdirSync(sandbox, { recursive: true });

    const prompt = loadPrompt('autoloop-ratchet-prompt.md', { task_id: this.id, iter });

    const lastRatchet = this.readLastRatchet(iter - 1);
    const currentMd = this.tryRead(path.join(this.taskDir, 'current.md'));

    const inputBlob = JSON.stringify(
      {
        goal: this.goal,
        eval: evalOut,
        metric_history: this.readMetricHistory(),
        current_md: currentMd,
        state_best: this.state.best,
        last_ratchet: lastRatchet,
      },
      null,
      2,
    );

    const sessionName = `autoloop-${this.id}-ratchet-${iter}`;
    let raw = '';
    let costUsd = 0;
    try {
      await this.manager.startSession({
        name: sessionName,
        cwd: sandbox,
        engine: this.config.ratchet_engine || 'claude',
        model: this.config.ratchet_model || 'opus',
        permissionMode: 'default',
        bare: true,
        systemPrompt: prompt,
        maxTurns: 1,
      });
      const result = await this.manager.sendMessage(sessionName, inputBlob, {
        timeout: 60_000,
      });
      raw = result.output || '';
      costUsd = extractCost(result);
    } finally {
      try {
        await this.manager.stopSession(sessionName);
      } catch {
        // Ignore.
      }
      try {
        fs.rmSync(sandbox, { recursive: true, force: true });
      } catch {
        // Ignore.
      }
    }

    this.state.cost_usd_so_far += costUsd;

    const decision = parseRatchetJson(raw, iter);
    writeJsonAtomic(path.join(this.taskDir, 'iter', String(iter), 'ratchet.json'), decision);

    this.state.decision = decision.decision;
    this.state.decision_reason = decision.reason;

    const metric = deriveMetric(evalOut, this.goal);
    const newBest = isImprovement(metric, this.state.best?.metric ?? null, this.goal);

    if (decision.decision === 'commit' && newBest) {
      const sha = this.gitSha();
      this.state.best = { iter, metric, git_sha: sha, gate_completion: evalOut.gate_completion };
      this.state.plateau_count = 0;
      this.state.tree = { parent_iter: iter, children_iters: [iter] };
      // Push: new best.
      await this.push({
        kind: 'new_best',
        text: `Autoloop ${this.id} iter ${iter}: new best ${metric.toFixed(4)} (gate ${(evalOut.gate_completion * 100).toFixed(0)}%, sha ${sha.slice(0, 7)})`,
        task_id: this.id,
        iter,
        ts: new Date().toISOString(),
      });
    } else if (decision.decision === 'commit') {
      // Committed but not a new best (rare — RATCHET should reset). Treat as plateau.
      this.state.plateau_count += 1;
    } else {
      // Reset.
      await this.gitReset();
      this.state.plateau_count += 1;
    }

    // Plateau push (continues; does NOT halt).
    if (
      this.state.plateau_count >= this.goal.termination.plateau_iters &&
      this.state.plateau_count % this.goal.termination.plateau_iters === 0
    ) {
      await this.push({
        kind: 'plateau',
        text: `Autoloop ${this.id} plateau ${this.state.plateau_count} iters; metric stuck at ${this.state.best?.metric?.toFixed(4) ?? 'n/a'}. Continuing. Reply 'stop' to halt or 'redirect: <hint>' to inject.`,
        task_id: this.id,
        iter,
        ts: new Date().toISOString(),
      });
    }

    // Custom push from RATCHET (e.g. unsure_no_metric).
    if (decision.push_user) {
      await this.push({
        kind: decision.push_user.kind as PushKind,
        text: decision.push_user.text,
        task_id: this.id,
        iter,
        ts: new Date().toISOString(),
      });
    }

    // Target hit?
    if (this.state.best && isTargetReached(this.state.best.metric, this.state.best.gate_completion, this.goal)) {
      this.terminate(`scalar/gate target reached at iter ${iter}: metric=${this.state.best.metric}`);
    }

    this.persistState();
  }

  // ─── Phase: COMPRESS ───────────────────────────────────────────────────

  private async runCompress(from: number, to: number): Promise<void> {
    this.state.phase = 'COMPRESS';
    this.persistState();
    this.emit('phase', { phase: 'COMPRESS', iter: to });

    const prompt = loadPrompt('autoloop-compress-prompt.md', {
      task_id: this.id,
      compress_every_k: this.config.compress_every_k ?? 10,
      compress_from: from,
      compress_to: to,
      compress_to_plus_1: to + 1,
    });

    const sessionName = `autoloop-${this.id}-compress-${to}`;
    try {
      await this.manager.startSession({
        name: sessionName,
        cwd: this.config.workspace,
        engine: this.config.propose_engine || 'claude',
        model: this.config.propose_model || 'opus',
        permissionMode: 'bypassPermissions',
        bare: true,
        systemPrompt: prompt,
        maxTurns: 20,
      });
      const result = await this.manager.sendMessage(sessionName, `Run COMPRESS for iters ${from}-${to}.`, {
        timeout: 180_000,
      });
      this.state.cost_usd_so_far += extractCost(result);
    } finally {
      try {
        await this.manager.stopSession(sessionName);
      } catch {
        // Ignore.
      }
    }
  }

  // ─── Helpers ───────────────────────────────────────────────────────────

  private persistState(): void {
    this.state.status = this.status;
    writeJsonAtomic(path.join(this.taskDir, 'state.json'), this.state);
    this.emit('state', this.state);
  }

  private gitSha(): string {
    try {
      const out = execSync('git rev-parse HEAD', {
        cwd: this.config.workspace,
        encoding: 'utf-8',
      });
      return String(out).trim();
    } catch {
      return 'unknown';
    }
  }

  private async gitReset(): Promise<void> {
    const target = this.state.best?.git_sha ?? 'HEAD~1';
    await runShell(`git reset --hard ${target}`, {
      cwd: this.config.workspace,
      timeout_ms: 30_000,
    });
  }

  private readMetricHistory(): MetricHistoryEntry[] {
    const p = path.join(this.taskDir, 'metric.json');
    if (!fs.existsSync(p)) return [];
    try {
      return JSON.parse(fs.readFileSync(p, 'utf-8')) as MetricHistoryEntry[];
    } catch {
      return [];
    }
  }

  private readLastRatchet(prevIter: number): RatchetOutput | null {
    if (prevIter < 1) return null;
    const p = path.join(this.taskDir, 'iter', String(prevIter), 'ratchet.json');
    if (!fs.existsSync(p)) return null;
    try {
      return JSON.parse(fs.readFileSync(p, 'utf-8')) as RatchetOutput;
    } catch {
      return null;
    }
  }

  private tryRead(p: string): string | null {
    try {
      return fs.readFileSync(p, 'utf-8');
    } catch {
      return null;
    }
  }

  private async push(event: PushEvent): Promise<void> {
    this.emit('push', event);
    // Append to inbox.md regardless of push command.
    const inbox = path.join(this.taskDir, 'inbox.md');
    fs.appendFileSync(inbox, `\n## ${event.ts} ${event.kind} (iter ${event.iter})\n\n${event.text}\n`);

    if (this.config.push_cmd === null) return;
    const cmd = this.config.push_cmd ?? 'openclaw message send';
    const escaped = event.text.replace(/'/g, `'\\''`);
    await runShell(`${cmd} '${escaped}'`, {
      cwd: this.config.workspace,
      timeout_ms: 30_000,
    }).catch(() => {
      // Push failure is non-fatal; inbox.md already has the record.
    });
  }

  private terminate(reason: string): void {
    this.state.termination = { fired: true, reason };
    this.state.phase = 'TERMINATED';
    this.status = 'completed';
    this.endedAt = new Date().toISOString();
    this.persistState();
    void this.push({
      kind: 'termination',
      text: `Autoloop ${this.id} done. ${reason}. Best ${this.state.best?.metric?.toFixed(4) ?? 'n/a'} at iter ${this.state.best?.iter ?? 0}. Cost $${this.state.cost_usd_so_far.toFixed(2)}.`,
      task_id: this.id,
      iter: this.state.iter,
      ts: this.endedAt,
    });
    this.emit('terminated', { reason });
  }

  private fail(msg: string): void {
    this.errorMsg = msg;
    this.status = 'error';
    this.endedAt = new Date().toISOString();
    if (this.state) {
      this.state.termination = { fired: true, reason: msg };
      this.state.phase = 'TERMINATED';
      this.persistState();
    }
    this.emit('error', new Error(msg));
  }
}

// ─── RATCHET output parsing ────────────────────────────────────────────────

function parseRatchetJson(raw: string, iter: number): RatchetOutput {
  // Strip code fences if present, then take last JSON object substring.
  const cleaned = raw.replace(/```json\n?|```\n?/g, '').trim();
  // Find the last balanced { ... } block.
  const lastClose = cleaned.lastIndexOf('}');
  const lastOpen = cleaned.lastIndexOf('{', lastClose);
  let payload: unknown = null;
  if (lastClose > lastOpen && lastOpen >= 0) {
    try {
      payload = JSON.parse(cleaned.slice(lastOpen, lastClose + 1));
    } catch {
      payload = null;
    }
  }
  if (!payload || typeof payload !== 'object') {
    return {
      iter,
      decision: 'reset',
      reason: 'malformed RATCHET output (could not parse JSON)',
    };
  }
  const o = payload as Record<string, unknown>;
  const decision = o.decision === 'commit' ? 'commit' : 'reset';
  const reason = typeof o.reason === 'string' ? o.reason : 'no reason given';
  type PushUser = NonNullable<RatchetOutput['push_user']>;
  let push_user: PushUser | undefined;
  if (o.push_user && typeof o.push_user === 'object') {
    const p = o.push_user as Record<string, unknown>;
    const validKinds: PushUser['kind'][] = ['new_best', 'plateau', 'unsure_no_metric', 'aspirational_proposed'];
    if (typeof p.kind === 'string' && typeof p.text === 'string' && (validKinds as string[]).includes(p.kind)) {
      push_user = { kind: p.kind as PushUser['kind'], text: p.text };
    }
  }
  return { iter, decision, reason, push_user };
}

function tail(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(-max);
}

function extractCost(result: SendResult): number {
  const events: StreamEvent[] = result.events ?? [];
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (typeof e.total_cost_usd === 'number') return e.total_cost_usd;
  }
  return 0;
}

// ─── Engine alias re-export (so callers can pass typed engine names) ───────

export type { EngineType };
