/**
 * Persistent Cursor Session — wraps `cursor-agent` CLI
 *
 * Like Codex/Gemini, each send() spawns a new `cursor-agent` process in
 * headless print mode. Cursor CLI supports `--output-format stream-json`
 * which provides NDJSON events similar to Gemini's stream protocol.
 *
 * The "session" is persistent in the same sense as Codex:
 *   - Working directory carries accumulated code changes across sends
 *   - Stats, history, and cost are tracked continuously
 *   - Consistent lifecycle semantics (start/stop/pause/resume)
 */

import type { ChildProcess } from 'node:child_process';
import { killEngineTree, spawnEngine } from './engine-spawn.js';
import * as readline from 'node:readline';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type {
  AgentDefinition,
  EffortLevel,
  EngineCommand,
  SessionConfig,
  SessionSendOptions,
  StreamEvent,
  TurnResult,
  GoalSessionOpen,
} from './types.js';
import { estimateTokens, getContextWindow, getModelPricing, hasOwnPricing } from './models.js';
import { sanitizeSecrets } from './sanitize.js';
import { SESSION_EVENT } from './constants.js';
import { BaseOneShotSession } from './base-oneshot-session.js';
import { CursorConfigMirror } from './cursor-config-dir.js';
import { cursorModelForEffort, cursorModelIds } from './cursor-models.js';
import { listCursorCommands } from './cursor-commands.js';
import { CursorGoalSession } from './cursor-goal-session.js';

/**
 * Enforced read-only for Cursor Agent.
 *
 * `--mode plan` is NOT a permission boundary — Cursor's docs say the mode
 * "influences how the agent approaches tasks rather than enforcing permissions",
 * and it was verified empirically to let an adversarial prompt write files
 * (edit-tool calls went through). Cursor's ACTUAL enforcement is the permission
 * config (`.cursor/cli.json`): "Deny rules take precedence over allow rules",
 * and a `deny` was verified to hold even under `--force` and even against a
 * repo that ships a permissive config of its own.
 *
 * `allow: []` means default-allow, so read / grep / search / list still work;
 * only the write vectors are denied. We write this config into a throwaway temp
 * dir and run Cursor with that dir as its process cwd (Cursor reads the config
 * from cwd) while pointing `--workspace` at the real project — so the user's
 * repository is never touched.
 */
const READ_ONLY_CLI_CONFIG = JSON.stringify({
  permissions: { allow: [], deny: ['Write(**)', 'Edit(**)', 'Shell(**)'] },
});

/**
 * The registry model a Cursor model id is priced as.
 *
 * Cursor names a model with its effort and speed in the id
 * (`claude-opus-5-5-high-fast`, `gpt-5.6-sol-xhigh`, `cursor-grok-4.6-medium`),
 * or with bracketed parameters (`gpt-5.4-mini[reasoning=low]`), and bills a
 * third-party model at its provider's list price, so the provider's entry is
 * the price. `auto` (which Cursor runs as `auto-smart`) has no per-token price
 * of its own: on individual plans it bills as a Cursor-model request, priced
 * here as Composer 2.5. A fast variant's surcharge (2x on GPT and Grok,
 * unpublished on Claude) is not modelled: it is priced at the base rate.
 */
export function cursorPricingModel(id: string | undefined): string | undefined {
  if (!id) return undefined;
  let m = id
    .toLowerCase()
    .trim()
    .replace(/\[[^\]]*\]$/, '');
  if (m === 'auto' || m.startsWith('auto-')) return 'composer-2.5';
  if (hasOwnPricing(m)) return m;
  m = m.replace(/^cursor-/, '').replace(/-fast$/, '');
  m = m.replace(/-thinking(?:-(?:low|medium|high|xhigh|max))?$/, '');
  m = m.replace(/-(?:none|minimal|low|medium|high|xhigh|max|extra)$/, '');
  // Older Claude ids put the version first: claude-4.5-opus is claude-opus-4-5.
  const older = m.match(/^claude-(\d+)(?:\.(\d+))?-(opus|sonnet|haiku)$/);
  if (older) m = `claude-${older[3]}-${older[1]}${older[2] ? `-${older[2]}` : ''}`;
  return m;
}

/** A message that starts a Cursor `/loop` (an interval and a prompt; a bare `/loop` only prints its usage). */
export function isCursorLoopCommand(message: string): boolean {
  return /^\/loop\s+\S/.test(message.trimStart());
}

/** A message that sets a Cursor goal (`/goal <objective>`). */
export function isCursorGoalCommand(message: string): boolean {
  return /^\/goal\s+\S/.test(message.trimStart());
}

/**
 * The plan a `createPlanToolCall` carries, as markdown. In plan mode the plan is
 * the turn's whole answer and Cursor writes no text beside it.
 */
export function cursorPlanText(args: Record<string, unknown> | undefined): string | undefined {
  if (!args) return undefined;
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const plan = str(args.plan);
  const name = str(args.name);
  const overview = str(args.overview);
  const todos = (Array.isArray(args.todos) ? args.todos : []).flatMap((t) => {
    const todo = t as Record<string, unknown>;
    const text = str(todo.content) || str(todo.title) || str(todo.text) || str(todo.description);
    if (!text) return [];
    const done = /complete|done/i.test(str(todo.status));
    return [`- [${done ? 'x' : ' '}] ${text}`];
  });
  const parts = [
    ...(name && !plan.startsWith('#') ? [`## ${name}`] : []),
    ...(overview ? [overview] : []),
    ...(plan ? [plan] : []),
    ...(todos.length ? [todos.join('\n')] : []),
  ];
  return parts.length ? parts.join('\n\n') : undefined;
}

/**
 * A Cursor plugin directory holding the session's `agents` as Cursor subagents
 * (`agents/<name>.md`: front matter with the name and description, the prompt
 * as the body), loaded with `--plugin-dir`. A `model` given for an agent goes
 * in its front matter; Cursor runs a subagent only on the models it allows for
 * subagents.
 */
export function writeCursorAgentsPlugin(dir: string, agents: Record<string, AgentDefinition>): void {
  fs.mkdirSync(path.join(dir, '.cursor-plugin'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'agents'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.cursor-plugin', 'plugin.json'), JSON.stringify({ name: 'clawo-agents' }));
  for (const [name, def] of Object.entries(agents)) {
    const file = name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
    const front = [
      `name: ${JSON.stringify(name)}`,
      ...(def.description ? [`description: ${JSON.stringify(def.description)}`] : []),
      ...(typeof def.model === 'string' && def.model ? [`model: ${JSON.stringify(def.model)}`] : []),
    ];
    fs.writeFileSync(path.join(dir, 'agents', `${file}.md`), `---\n${front.join('\n')}\n---\n${def.prompt}\n`);
  }
}

/** Internal send option: a native goal process (`CursorGoalSession`), which may run `/goal`. */
type CursorSendOptions = SessionSendOptions & { goalRun?: boolean };

/** After a `/loop` has started its background shell, this long without output ends the send's turn. */
export const CURSOR_LOOP_SETTLE_MS = 15_000;
/** How long `listCommands` reuses what Cursor listed. */
const COMMANDS_TTL_MS = 5 * 60_000;
/** How long an interrupted process gets to write its final result before it is killed. */
const INTERRUPT_GRACE_MS = 10_000;
/**
 * A `/loop` is ended once its stream has been quiet this long: Cursor writes its
 * usage when signalled while it waits for the next tick, not mid-request
 * (2026.11.22, measured).
 */
const LOOP_IDLE_MS = 8_000;
/** How long an interrupted loop may take to go quiet before it is ended anyway. */
const LOOP_STOP_WAIT_MS = 60_000;

/** One `cursor-agent -p` process and what it has said so far. */
interface CursorRun {
  proc: ChildProcess;
  /** The send's reply. */
  text: string;
  /** A native goal process: its usage spans many requests. */
  goal: boolean;
  /** The process runs a `/loop`: each tick is a turn of its own. */
  loop: boolean;
  /** A background shell is running (a loop's ticker). */
  armed: boolean;
  /** The send has returned; what follows is engine turns. */
  detached: boolean;
  /** The reply of the engine turn now running, after the send returned. */
  tickText: string;
  tickStartedAt: number;
  toolsInFlight: number;
  /** When the process last wrote a line. */
  lastEventAt: number;
  /** Usage arrived since the last engine turn was reported. */
  usageSinceTick: boolean;
  /** Ended by `interruptRun()`: the output is still read, and the turn is not a success. */
  interrupted: boolean;
}

// ─── PersistentCursorSession ────────────────────────────────────────────────

export class PersistentCursorSession extends BaseOneShotSession {
  /** `/<command> <args>` in a message runs a Cursor command or skill. */
  readonly commandStyle = 'text' as const;
  /** Every process takes its own `--model`, so one send can run on another model. */
  readonly perSendModel = true;

  private _currentRl: readline.Interface | null = null;
  /** Throwaway dir holding the read-only `.cursor/cli.json`; removed on stop(). */
  private _roConfigDir?: string;
  /** The plugin directory the session's `agents` are written to, once; removed on stop(). */
  private _agentsDir?: string;
  /** The session's own Cursor config directory (`CURSOR_CONFIG_DIR`); see `CursorConfigMirror`. */
  private _mirror?: CursorConfigMirror;
  /** The process now running, and the `/loop` process held after its send returned. */
  private _runState?: CursorRun;
  private _loop?: CursorRun;
  private _commands?: { at: number; list: EngineCommand[] };
  /** Effort/model pairs already reported as not applicable, so the log says so once. */
  private readonly _effortNotes = new Set<string>();
  /** The token counts the cost has been computed for; see `_updateCost`. */
  private _priced = { tokensIn: 0, tokensOut: 0, cachedTokens: 0, cacheCreationTokens: 0 };
  /** The context size the last plain turn reported, kept across goal and loop processes. */
  private _contextTokens = 0;
  /** Processes this session started that have not closed yet. */
  private readonly _liveProcs = new Set<ChildProcess>();

  /**
   * Cursor's own chat id, once the first turn has announced one.
   *
   * `agent -p` opens a fresh chat unless `--resume <chatId>` names an existing
   * one. The id was already harvested off the `system` init event for
   * `sessionId`; feeding it back is what gives this engine a real conversation.
   */
  private cursorChatId?: string;

  /** The model the running process was given (`--model`), which it is billed as. */
  private _turnModel?: string;
  /** The display name Cursor's init event gives the model (`Auto Balance`, `GPT-5.4 Mini Low`). */
  private _cursorModelName?: string;

  /**
   * Text of the assistant message now streaming as deltas (`--stream-partial-output`);
   * the complete message that follows them repeats it and is not added again.
   */
  private _deltaText = '';

  /**
   * The model id clawo passes, never the name Cursor displays: the display name
   * maps to no price, and without `--model` Cursor runs whatever was last
   * selected anywhere.
   */
  protected override _billedModel(): string | undefined {
    return this._turnModel ?? this.options.model ?? 'auto';
  }

  protected override _getModelPricing() {
    return getModelPricing(cursorPricingModel(this._billedModel()), 'composer-2.5');
  }

  /** The window of the model it is priced as: `claude-opus-5-5-high-fast` has claude-opus-5-5's. */
  protected override _effectiveContextWindow(): number {
    return getContextWindow(cursorPricingModel(this._billedModel()) ?? 'composer-2.5');
  }

  /**
   * Price what was added since the last call at the running process's model, so
   * a send on another model (`perSendModel`) or a model switched in place does
   * not reprice the turns before it.
   */
  protected override _updateCost(): void {
    const p = this._getModelPricing();
    const s = this._stats;
    const d = {
      tokensIn: s.tokensIn - this._priced.tokensIn,
      tokensOut: s.tokensOut - this._priced.tokensOut,
      cachedTokens: s.cachedTokens - this._priced.cachedTokens,
      cacheCreationTokens: s.cacheCreationTokens - this._priced.cacheCreationTokens,
    };
    s.costUsd +=
      ((d.tokensIn + d.cacheCreationTokens) * p.input + d.cachedTokens * (p.cached ?? 0) + d.tokensOut * p.output) /
      1_000_000;
    this._priced = {
      tokensIn: s.tokensIn,
      tokensOut: s.tokensOut,
      cachedTokens: s.cachedTokens,
      cacheCreationTokens: s.cacheCreationTokens,
    };
  }

  protected override _continuesConversation(): boolean {
    return !!this.cursorChatId;
  }

  constructor(config: SessionConfig, cursorBin?: string) {
    // `cursor-agent` before `agent`: Cursor's installer provides both names, but
    // `agent` is generic enough that another vendor can claim it — xAI's Grok
    // installer does exactly that, symlinking `agent` to its own binary, which
    // then rejects `--force`/`--trust`/`--workspace` and fails the turn with
    // "unexpected argument". The specific name is the one Cursor owns.
    super(config, cursorBin || process.env.CURSOR_BIN || 'cursor-agent', {
      enginePrefix: 'cursor',
      // `auto`, Cursor's default, bills as a Cursor-model request (Composer 2.5).
      defaultModel: 'composer-2.5',
      defaultModelDisplay: 'auto',
      supportsCachedTokens: true,
      // `inputTokens` is the uncached remainder (2026.11.22, measured: a resumed
      // turn reported 883 input beside 16,896 cache reads), so cache reads are
      // billed on top of it, not carved out of it.
      inputIncludesCachedTokens: false,
      engineDisplayName: 'Cursor',
    });
    // Process-level resume: a persisted id is the raw Cursor chat id, never one
    // of our generated `cursor-<ts>-<rand>` handles.
    if (config.resumeSessionId && !/^cursor-\d+-/.test(config.resumeSessionId)) {
      this.cursorChatId = config.resumeSessionId.replace(/^cursor-live-/, '');
    }
  }

  /** A `/loop` process held after its send returned counts as work in progress. */
  override get isBusy(): boolean {
    return super.isBusy || !!this._loop;
  }

  // ─── Capabilities ─────────────────────────────────────────────────────

  /** The commands and skills Cursor offers in the session's directory, from its ACP server; cached. */
  async listCommands(): Promise<EngineCommand[]> {
    if (this._commands && Date.now() - this._commands.at < COMMANDS_TTL_MS) return this._commands.list;
    const list = await listCursorCommands(this.engineBin, this.options.cwd, { launcher: this.options.launcher });
    this._commands = { at: Date.now(), list };
    return list;
  }

  /** The next process runs on `model`: nothing to restart. */
  async setModelLive(model: string): Promise<boolean> {
    this.options.model = model;
    this.options.resolvedModel = model;
    return true;
  }

  /** Cursor's own `/goal` loop behind the goal node's surface (`nativeGoal`). */
  nativeGoalSession(open?: GoalSessionOpen): CursorGoalSession {
    return new CursorGoalSession(this, open);
  }

  /**
   * End the running process, or the `/loop` held after its send returned. It is
   * signalled rather than cut off, and its output is read to the end: Cursor
   * reports a process's usage only in the `result` it writes as it exits. A loop
   * is signalled between ticks, when it writes one.
   */
  override interruptRun(): boolean {
    const run = this._loop ?? this._runState;
    const proc = run?.proc ?? this.currentProc;
    if (!proc || proc.exitCode != null || proc.signalCode != null) return false;
    if (run) run.interrupted = true;
    const end = () => {
      killEngineTree(proc);
      const timer = setTimeout(() => {
        if (proc.exitCode == null && proc.signalCode == null && this.currentProc === proc) this._cleanupProc();
      }, INTERRUPT_GRACE_MS);
      timer.unref?.();
    };
    if (!run?.detached) {
      end();
      return true;
    }
    const deadline = Date.now() + LOOP_STOP_WAIT_MS;
    const whenQuiet = () => {
      if (proc.exitCode != null || proc.signalCode != null) return;
      const quiet = run.toolsInFlight === 0 && Date.now() - run.lastEventAt >= LOOP_IDLE_MS;
      if (quiet || Date.now() >= deadline) return end();
      setTimeout(whenQuiet, 500).unref?.();
    };
    whenQuiet();
    return true;
  }

  override stop(): void {
    super.stop();
    this._loop = undefined;
    // Removed once every process signalled above has exited, so nothing it still writes is lost.
    const dirs = [this._mirror, this._agentsDir];
    this._mirror = undefined;
    this._agentsDir = undefined;
    const remove = () => {
      for (const dir of dirs) {
        if (dir instanceof CursorConfigMirror) dir.remove();
        else if (dir) fs.rmSync(dir, { recursive: true, force: true });
      }
    };
    if (this._liveProcs.size === 0) remove();
    else for (const proc of this._liveProcs) proc.once('close', () => this._liveProcs.size === 0 && remove());
  }

  /** Materialize the read-only permission config once; return the dir to use as cwd. */
  private _ensureReadOnlyConfigDir(): string {
    if (this._roConfigDir) return this._roConfigDir;
    const dir = path.join(os.tmpdir(), `claw-cursor-ro-${this.sessionId}`);
    fs.mkdirSync(path.join(dir, '.cursor'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.cursor', 'cli.json'), READ_ONLY_CLI_CONFIG, 'utf8');
    this._roConfigDir = dir;
    return dir;
  }

  protected override _cleanupProc(): void {
    if (this._currentRl) {
      this._currentRl.close();
      this._currentRl = null;
    }
    if (this.currentProc) {
      this.currentProc.stdin?.end();
      this.currentProc.stdout?.destroy();
      this.currentProc.stderr?.destroy();
    }
    if (this._roConfigDir) {
      try {
        fs.rmSync(this._roConfigDir, { recursive: true, force: true });
      } catch {
        // Never created / already gone.
      }
      this._roConfigDir = undefined;
    }
    super._cleanupProc();
  }

  /** The id this process runs: the send's model or the session's, at the effort asked for. */
  private async _modelFor(model: string, effort: EffortLevel): Promise<string> {
    const mapped = cursorModelForEffort(model, effort, await cursorModelIds(this.engineBin));
    if (!mapped.applied && !this._effortNotes.has(`${model}/${effort}`)) {
      this._effortNotes.add(`${model}/${effort}`);
      this.emit(
        SESSION_EVENT.LOG,
        `[cursor] effort '${effort}' not applied to '${model}': Cursor lists no id for it at that effort`,
      );
    }
    return mapped.model;
  }

  protected async _run(message: string, options: CursorSendOptions): Promise<TurnResult> {
    // agent -p <prompt> [--mode plan | --mode ask | --sandbox enabled | --force] [--auto-review] --trust
    //   --output-format stream-json --stream-partial-output --model <id>
    if (this._loop) {
      throw new Error(
        'a /loop is running on this Cursor session; end it with session_interrupt (or session_stop) before sending',
      );
    }
    if (!options.goalRun && isCursorGoalCommand(message)) {
      throw new Error(
        "Cursor's /goal runs until the goal is complete, past any send's timeout: run it as a goal " +
          '(`clawo goal --cursor --native-goal`, or a workflow goal node with nativeGoal)',
      );
    }
    this._deltaText = '';
    let model = options.model ?? this.options.model ?? 'auto';
    const effort = options.effort ?? this.options.effort;
    if (effort && effort !== 'auto') {
      model = await this._modelFor(model, effort);
      // stop() may have run while the model list was read.
      if (!this.isReady) throw new Error('Session not ready. Call start() first.');
    }
    // Plan mode is a read-only turn whose answer is a plan; any other read-only
    // turn asks Cursor's Ask mode, which always answers in text.
    const plan = options.plan === true || this.options.permissionMode === 'plan';
    const readOnly = plan || this.options.sandboxMode === 'read-only';
    const workspaceWrite = this.options.sandboxMode === 'workspace-write';
    const args: string[] = ['-p', message];
    if (readOnly) {
      // The mode steers the model toward read-only behavior; the binding
      // guarantee comes from the deny config injected via the process cwd below.
      // Do NOT add `--sandbox` here — it does not restrict in-workspace writes and
      // was verified to override the mode and re-enable them.
      args.push('--mode', plan ? 'plan' : 'ask');
    } else if (workspaceWrite) {
      // Cursor's OS sandbox (2026.11.22, measured): edits and commands in the
      // workspace run, a write outside it and the network are refused. Never with
      // `--force`, which runs commands outside the sandbox (measured: the same
      // write outside the workspace succeeded).
      args.push('--sandbox', 'enabled');
    } else if (this.options.permissionMode !== 'auto') {
      args.push('--force');
    }
    // Cursor's Auto-review: a server classifier runs safe tool calls and declines
    // the rest; headless, a declined call is skipped, not waited on (measured).
    if (!readOnly && this.options.permissionMode === 'auto') args.push('--auto-review');
    args.push('--trust', '--output-format', 'stream-json', '--stream-partial-output');
    for (const dir of this.options.addDir ?? []) args.push('--add-dir', dir);
    const plugins = this.options.pluginDir;
    for (const dir of typeof plugins === 'string' ? [plugins] : (plugins ?? [])) args.push('--plugin-dir', dir);
    if (this.options.agents && Object.keys(this.options.agents).length > 0) {
      if (!this._agentsDir) {
        this._agentsDir = path.join(os.tmpdir(), `claw-cursor-agents-${this.sessionId}`);
        writeCursorAgentsPlugin(this._agentsDir, this.options.agents);
      }
      args.push('--plugin-dir', this._agentsDir);
    }
    // A flag `--help` does not list (2026.11.22: "internal only; can be used multiple times"), measured to work.
    for (const image of options.images ?? []) args.push('--image', image);

    // Continue Cursor's own chat rather than opening a new one each send.
    // Verified against 2026.08.11: without it the second turn has no memory of
    // the first; with it the same turn recalls the earlier content. `--continue`
    // is avoided on purpose — it resumes "the latest chat", which would collide
    // between concurrent sessions.
    if (this.cursorChatId) args.push('--resume', this.cursorChatId);

    // Always named: with no `--model` Cursor runs the last model selected by any
    // Cursor run on the machine.
    args.push('--model', model);
    // Workspace directory (prefer --workspace over cwd for explicit path)
    if (this.options.cwd) args.push('--workspace', this.options.cwd);

    const timeout = options.timeout || 300_000;
    const loop = isCursorLoopCommand(message);

    // Read-only sessions run with an isolated temp dir as their process cwd so
    // Cursor loads our deny config (`.cursor/cli.json`) from there while still
    // operating on the real project via `--workspace`. The repo is never touched.
    const spawnCwd = readOnly ? this._ensureReadOnlyConfigDir() : this.options.cwd;
    this._mirror ??= new CursorConfigMirror(path.join(os.tmpdir(), `claw-cursor-cfg-${this.sessionId}`));
    const configDir = this._mirror.prepare();
    this._turnModel = model;

    return new Promise<TurnResult>((resolve, reject) => {
      let stderr = '';
      let settled = false;
      let gotUsageFromEvents = false;
      let settleTimer: ReturnType<typeof setTimeout> | undefined;

      const proc = spawnEngine(this.engineBin, args, {
        launcher: this.options.launcher,
        cwd: spawnCwd,
        env: { ...process.env, ...(configDir ? { CURSOR_CONFIG_DIR: configDir } : {}) },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.currentProc = proc;
      this._liveProcs.add(proc);
      proc.once('close', () => this._liveProcs.delete(proc));
      const run: CursorRun = {
        proc,
        text: '',
        goal: options.goalRun === true,
        loop,
        armed: false,
        detached: false,
        tickText: '',
        tickStartedAt: Date.now(),
        toolsInFlight: 0,
        lastEventAt: Date.now(),
        usageSinceTick: false,
        interrupted: false,
      };
      this._runState = run;

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          proc.kill('SIGTERM');
          reject(new Error('Timeout waiting for Cursor response'));
        }
      }, timeout);

      /** The send returns with what the loop's first turn said; the process runs on (`_loop`). */
      const detach = () => {
        if (settled || run.detached) return;
        settled = true;
        clearTimeout(timer);
        if (settleTimer) clearTimeout(settleTimer);
        run.detached = true;
        run.tickStartedAt = Date.now();
        this._loop = run;
        this._recordTurnComplete(true);
        this._addHistory({ text: run.text, code: null });
        const event: StreamEvent = { type: 'result', result: run.text, stop_reason: 'end_turn' };
        this.emit(SESSION_EVENT.RESULT, event);
        this.emit(SESSION_EVENT.TURN_COMPLETE, event);
        this.emit(SESSION_EVENT.LOG, '[cursor] /loop running: each tick is an engine turn until session_interrupt');
        resolve({ text: run.text, event });
      };
      /** Report the engine turn that just ended (a tick), with what it said. */
      const reportTick = (ok: boolean) => {
        const text = run.tickText;
        if (!text.trim() && !run.usageSinceTick) return;
        run.tickText = '';
        run.usageSinceTick = false;
        const event: StreamEvent = {
          type: 'result',
          result: text,
          stop_reason: ok ? 'end_turn' : 'error',
          duration_ms: Date.now() - run.tickStartedAt,
        };
        run.tickStartedAt = Date.now();
        this.emit(SESSION_EVENT.UNSOLICITED_RESULT, { text, event } satisfies TurnResult);
      };
      /** While a loop's ticker runs and nothing else does, a quiet stream means its first turn is over. */
      const rearmSettle = () => {
        if (settleTimer) clearTimeout(settleTimer);
        if (run.loop && run.armed && !run.detached && run.toolsInFlight === 0) {
          settleTimer = setTimeout(detach, CURSOR_LOOP_SETTLE_MS);
          settleTimer.unref?.();
        }
      };
      const appendText = (text: string) => {
        if (run.detached) run.tickText += text;
        else {
          run.text += text;
          try {
            options.callbacks?.onText?.(text);
          } catch {
            // User callback error
          }
        }
        this.emit(SESSION_EVENT.TEXT, text);
      };

      // Parse stream-json output line by line
      const rl = readline.createInterface({ input: proc.stdout!, crlfDelay: Infinity });
      this._currentRl = rl;
      rl.on('line', (line: string) => {
        run.lastEventAt = Date.now();
        if (!line.trim()) return;
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(line) as Record<string, unknown>;
        } catch {
          // Non-JSON line — treat as plain text
          appendText(line + '\n');
          return;
        }
        if (event.type === 'system' && event.subtype === 'task_notification') {
          // A background task woke the agent: on a loop, the start of the next tick's turn.
          if (!run.loop && /\bloop\b/i.test(String(event.title ?? ''))) run.loop = true;
          if (run.loop) {
            if (run.detached) reportTick(true);
            else detach();
          }
        }
        this._handleStreamEvent(event, run, run.detached ? {} : options, appendText, () => {
          gotUsageFromEvents = true;
          run.usageSinceTick = true;
        });
        rearmSettle();
      });

      proc.stderr?.on('data', (data: Buffer) => {
        const sanitized = sanitizeSecrets(data.toString());
        stderr += sanitized;
        this.emit(SESSION_EVENT.LOG, `[cursor-stderr] ${sanitized}`);
      });

      proc.on('close', (code) => {
        clearTimeout(timer);
        if (settleTimer) clearTimeout(settleTimer);
        if (this.currentProc === proc) this.currentProc = null;
        if (this._runState === run) this._runState = undefined;
        if (this._currentRl === rl) {
          this._currentRl.close();
          this._currentRl = null;
        }
        if (this._turnModel === model) this._turnModel = undefined;

        if (run.detached) {
          // The held loop ended: its last tick is reported with the usage Cursor wrote on the way out.
          this._loop = undefined;
          reportTick(code === 0 || run.interrupted);
          this.emit(SESSION_EVENT.LOG, `[cursor] /loop ended (exit ${code})`);
          return;
        }
        if (settled) return;
        settled = true;

        // One expression for the outcome, feeding the counter here and the
        // `stop_reason` below. An interrupted turn did not finish, whatever the exit code.
        const ok = code === 0 && !run.interrupted;
        this._recordTurnComplete(ok);

        // Fallback: estimate tokens if stream events didn't provide usage
        if (!gotUsageFromEvents && run.text.length > 0) {
          this._stats.tokensIn += estimateTokens(message);
          this._stats.tokensOut += estimateTokens(run.text);
          this._updateCost();
          this._markTurnEstimated();
        }

        this._addHistory({ text: run.text, code });

        const event: StreamEvent = {
          type: 'result',
          result: run.text,
          stop_reason: ok ? 'end_turn' : 'error',
        };

        this.emit(SESSION_EVENT.RESULT, event);
        this.emit(SESSION_EVENT.TURN_COMPLETE, event);

        if (ok) resolve({ text: run.text, event });
        else if (run.interrupted) reject(new Error('the Cursor turn was interrupted'));
        else reject(new Error(stderr || `Cursor exited with code ${code}`));
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          reject(err);
        }
      });
    });
  }

  /** Detect an errored tool call across the shapes Cursor has used for it. */
  private _cursorToolErrored(event: Record<string, unknown>): boolean {
    if (event.is_error === true) return true;
    const status = (event.status as string) || ((event.result as Record<string, unknown>)?.status as string);
    return status === 'error' || status === 'failed';
  }

  // ─── Stream Event Handling ────────────────────────────────────────────

  private _handleStreamEvent(
    event: Record<string, unknown>,
    run: CursorRun,
    options: SessionSendOptions,
    appendText: (text: string) => void,
    markUsageReceived: () => void,
  ): void {
    const type = event.type as string;

    switch (type) {
      case 'system':
        if (event.subtype !== undefined && event.subtype !== 'init') break;
        // Init event — extract session_id if available
        // The raw id is what `--resume` expects; the prefixed one is our
        // display/persistence handle.
        if (event.session_id && !this.cursorChatId) this.cursorChatId = String(event.session_id);
        // What Cursor calls the model it runs (`Auto Balance`): shown, never priced.
        if (typeof event.model === 'string' && event.model.trim()) this._cursorModelName = event.model.trim();
        if (event.session_id && !this.sessionId?.startsWith('cursor-live-')) {
          this.sessionId = `cursor-live-${event.session_id}`;
        }
        break;

      case 'user':
        // Echo of user prompt — skip
        break;

      case 'assistant': {
        // Cursor format: { type: "assistant", message: { role, content: [{ type, text }] } }
        const msg = event.message as Record<string, unknown> | undefined;
        if (!msg) break;
        const contentArr = msg.content as Array<{ type: string; text?: string }> | undefined;
        // With --stream-partial-output a message arrives as deltas, each carrying
        // `timestamp_ms`, and then once more complete: without `timestamp_ms` at
        // the end of a turn, with a `model_call_id` before a tool call (2026.11.22).
        const delta = typeof event.timestamp_ms === 'number' && event.model_call_id === undefined;
        if (!delta && this._deltaText) {
          this._deltaText = '';
          break;
        }
        // The complete message at the end of a loop repeats every tick's text at once.
        if (!delta && run.detached) break;
        if (contentArr) {
          for (const block of contentArr) {
            if (delta && block.type === 'text' && block.text) this._deltaText += block.text;
            if (block.type === 'text' && block.text) appendText(block.text);
          }
        }
        break;
      }

      // Also support generic "message" format for forward compatibility
      case 'message': {
        if (event.role === 'user') break;
        const text = (event.content as string) || '';
        if (text) appendText(text);
        break;
      }

      // Cursor 2026.05+ emits `tool_call` with `subtype: 'started' | 'completed'`
      // (one event each) instead of the older `tool_use` / `tool_result` pair.
      // Count once on 'started'; read error state off the 'completed' event
      // (there is no top-level `is_error` on a separate result event anymore).
      case 'tool_call': {
        const subtype = event.subtype as string | undefined;
        const call = event.tool_call as
          | Record<string, { args?: Record<string, unknown>; result?: unknown }>
          | undefined;
        if (subtype === 'started') {
          run.toolsInFlight += 1;
          this._stats.toolCalls++;
          try {
            options.callbacks?.onToolUse?.(event);
          } catch {
            // User callback error
          }
          this.emit(SESSION_EVENT.TOOL_USE, event);
        } else if (subtype === 'completed') {
          run.toolsInFlight = Math.max(0, run.toolsInFlight - 1);
          try {
            options.callbacks?.onToolResult?.(event);
          } catch {
            // User callback error
          }
          if (this._cursorToolErrored(event)) this._stats.toolErrors++;
          // A shell left running in the background: a loop's ticker, once the loop is set up.
          if ((call?.shellToolCall?.result as { isBackground?: unknown } | undefined)?.isBackground === true) {
            run.armed = true;
          }
          // In plan mode the plan is only here, in the tool call's arguments.
          const planText = cursorPlanText(call?.createPlanToolCall?.args);
          if (planText) {
            const before = run.detached ? run.tickText : run.text;
            const sep = !before || before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
            appendText(sep + planText);
          }
          this.emit(SESSION_EVENT.TOOL_RESULT, event);
        }
        break;
      }

      // Legacy event names (older Cursor builds) — keep for back-compat.
      case 'tool_use':
        this._stats.toolCalls++;
        try {
          options.callbacks?.onToolUse?.(event);
        } catch {
          // User callback error
        }
        this.emit(SESSION_EVENT.TOOL_USE, event);
        break;

      case 'tool_result':
        try {
          options.callbacks?.onToolResult?.(event);
        } catch {
          // User callback error
        }
        if (event.is_error) this._stats.toolErrors++;
        this.emit(SESSION_EVENT.TOOL_RESULT, event);
        break;

      case 'result': {
        // Cursor uses camelCase: inputTokens, outputTokens, cacheReadTokens
        const usage = event.usage as Record<string, number> | undefined;
        if (usage) {
          const input = usage.inputTokens || usage.input_tokens || usage.prompt_tokens || 0;
          const cacheRead = usage.cacheReadTokens || usage.cached_tokens || 0;
          const cacheWrite = usage.cacheWriteTokens || 0;
          this._stats.tokensIn += input;
          // Output includes reasoning: `reasoningTokens` is a part of it, not more.
          this._stats.tokensOut += usage.outputTokens || usage.output_tokens || usage.completion_tokens || 0;
          this._stats.cachedTokens += cacheRead;
          this._stats.cacheCreationTokens += cacheWrite;
          // The context this turn filled is the whole input side. A goal or a
          // loop process reports the sum of all its requests, which is not one
          // context: the last plain turn's figure stands.
          if (run.loop || run.goal) this._reportTurnInputTokens(this._contextTokens);
          else {
            this._contextTokens = input + cacheRead + cacheWrite;
            this._reportTurnInputTokens(this._contextTokens);
          }
          this._updateCost();
          markUsageReceived();
        }
        // Result text (if not already captured from assistant events)
        const resultStr = event.result as string | undefined;
        if (resultStr && !run.text && !run.detached) run.text = resultStr;
        break;
      }

      case 'error':
        this.emit(SESSION_EVENT.LOG, `[cursor-error] ${event.error || JSON.stringify(event)}`);
        break;

      default:
        break;
    }
  }

  /**
   * Override getStats to expose the captured chat ID.
   *
   * Consumers use its presence to tell "this session resumes a real conversation"
   * from "the session is merely in the manager's map". Without it a caller has to
   * assume the conversation exists, and a session whose first turn died before the
   * stream announced an id looks identical to a healthy one.
   */
  getStats(): ReturnType<BaseOneShotSession['getStats']> & { cursorChatId?: string; cursorModelName?: string } {
    const base = super.getStats();
    return {
      ...base,
      cursorChatId: this.cursorChatId,
      ...(this._cursorModelName ? { cursorModelName: this._cursorModelName } : {}),
    };
  }
}
