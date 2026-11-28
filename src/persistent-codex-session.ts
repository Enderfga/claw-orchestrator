/**
 * Persistent Codex Session — wraps OpenAI `codex` CLI
 *
 * Unlike Claude Code, Codex does not maintain a persistent subprocess with
 * streaming JSON I/O.  Each send() spawns a new `codex` process in
 * `--sandbox workspace-write` mode (the modern replacement for the deprecated
 * `--full-auto` flag) with `--json` to get line-delimited JSON events.
 *
 * The "session" is persistent in the sense that:
 *   - Working directory (cwd) carries accumulated code changes across sends
 *   - Stats, history, and cost are tracked continuously
 *   - The `thread_id` from the first send is captured and reused via
 *     `codex exec resume <id>` for subsequent sends, giving the model real
 *     conversation continuity (Codex 0.119+). With `forkSession`, the first
 *     send runs `codex exec fork <resumeSessionId>` instead and the session
 *     continues the new thread.
 *
 * What `codex exec` cannot do — compact, review or sample the thread, revert
 * turns, list skills or read the rate limits — runs through a short-lived
 * `codex app-server` that loads the same thread (`codex-app-client.ts`); the
 * next `codex exec resume` reads what it left in the rollout. Sub-agents are
 * threads of their own whose usage `--json` leaves out; it is read from their
 * rollouts after each turn.
 */

import { killEngineTree, spawnEngine } from './engine-spawn.js';
import {
  writeFileSync,
  unlinkSync,
  readFileSync,
  readdirSync,
  openSync,
  fstatSync,
  readSync,
  closeSync,
} from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';

import type {
  AsideOutcome,
  CommandOutcome,
  CompactOutcome,
  ContextBreakdown,
  CostBreakdown,
  EffortLevel,
  EngineCommand,
  GeneratedImage,
  RewindOutcome,
  RewindTarget,
  SessionConfig,
  SessionSendOptions,
  StreamCallbacks,
  StreamEvent,
  TurnResult,
} from './types.js';
import { SESSION_EVENT, TURN_TIMEOUT_MS } from './constants.js';
import { BaseOneShotSession } from './base-oneshot-session.js';
import { getModelPricing } from './models.js';
import { sanitizeSecrets } from './sanitize.js';
import { codexConfigArgs, codexFeatureArgs } from './codex-config.js';
import { CodexAppClient, withCodexAppClient } from './codex-app-client.js';
import {
  CODEX_INIT_PROMPT,
  codexBuiltinCommands,
  codexCommandNeedsThread,
  codexCommandReadsStoredThread,
  codexReviewTarget,
  codexSandboxPolicy,
  codexSkillCommands,
  codexTurnCommand,
  latestCodexTurnId,
  listCodexSkills,
  revertCodexTurns,
  runCodexInfoCommand,
  unknownCodexCommand,
  type CodexSkill,
} from './codex-commands.js';
import {
  codexSessionsRoot,
  findCodexRollout,
  readFileSlice,
  reviewRolloutUsage,
  subAgentThreadIds,
  subAgentUsage,
  type CodexTokenTotals,
} from './codex-rollout.js';

// ─── Codex JSON event shapes (subset we consume) ────────────────────────────
//
// Captured from `codex exec --json` against Codex CLI 0.128. These are the
// only types we parse; anything else falls through to the log channel.

interface CodexThreadStarted {
  type: 'thread.started';
  thread_id: string;
}
interface CodexItemCompleted {
  type: 'item.completed';
  item: { id?: string; type?: string; text?: string; exit_code?: number };
}
interface CodexTurnCompleted {
  type: 'turn.completed';
  usage?: {
    input_tokens?: number;
    cached_input_tokens?: number;
    /**
     * Prompt tokens written into the cache this turn. Deliberately not added to
     * anything: codex counts it inside `input_tokens`, the same way it counts
     * `cached_input_tokens`, so charging for it again would double-bill.
     */
    cache_write_input_tokens?: number;
    output_tokens?: number;
    reasoning_output_tokens?: number;
  };
}
// Codex 0.13x surfaces turn-level failures as a top-level `error` event and/or
// a `turn.failed` event whose `error.message` carries the reason. Without
// handling these the process can exit 0 and we'd resolve an empty turn.
interface CodexTurnFailed {
  type: 'turn.failed';
  error?: { message?: string };
}
interface CodexError {
  type: 'error';
  message?: string;
}

/**
 * Codex's `model_reasoning_effort` value for an engine-agnostic effort, or
 * undefined to leave it to codex. `auto` means "leave it to the engine".
 *
 * codex 0.149's ladder is none|minimal|low|medium|high|xhigh|max|ultra, and its
 * release notes call out `max` and `ultra` as selectable levels. Every level in
 * our union has a same-named counterpart, so this is a passthrough. codex does
 * not validate the value — it sends whatever it is given — so an unknown level
 * would fail at the API, not at spawn. That is why the ladder is listed rather
 * than guessed.
 */
export function codexReasoningEffort(effort: EffortLevel | undefined): string | undefined {
  const known: ReadonlySet<string> = new Set(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
  return effort && known.has(effort) ? effort : undefined;
}

// ─── PersistentCodexSession ─────────────────────────────────────────────────

/** The planning prefix the engines without a plan mode take (as Claude Code's and the custom engines'). */
const PLAN_PREFIX =
  '[Planning Mode] Analyze the request and create a detailed plan only. Do not write code or make changes yet.';

/** How long a compaction, review or shell command on the short-lived app-server may take. */
const THREAD_JOB_TIMEOUT_MS = 600_000;
/** How long the skills list is reused. */
const SKILLS_CACHE_MS = 60_000;

const ZERO: CodexTokenTotals = { input: 0, cached: 0, output: 0 };

export class PersistentCodexSession extends BaseOneShotSession {
  /** Commands are app-server RPCs, run on a short-lived app-server: slash text reaches the model as text. */
  readonly commandStyle = 'rpc' as const;
  /** Each turn is its own process, so `--model` can be this turn's alone. */
  readonly perSendModel = true;

  /**
   * Captured from the first `thread.started` event. Each subsequent send()
   * issues `codex exec resume <id>` so the model sees prior turns.
   */
  private codexThreadId?: string;

  /**
   * The recorded thread a `forkSession` session branches from. The first send
   * runs `codex exec fork <id>`, which starts a new thread holding that one's
   * history; the new id arrives in `thread.started` and this is cleared.
   */
  private _forkSourceId?: string;

  /**
   * Path to a temp file holding the `jsonSchema` config, written lazily on
   * first use. Codex's `--output-schema` takes a file path (unlike Claude's
   * `--json-schema`, which takes the schema inline), so we materialize the
   * config string to disk once and reuse it across turns. Removed on stop().
   */
  private _schemaFilePath?: string;

  /**
   * Codex's own context limit for this thread, harvested from its rollout file.
   *
   * The registry window is the model's published maximum (1.05M for gpt-5.x);
   * codex enforces a much smaller one of its own (258,400 measured on 0.147.0
   * for gpt-5.6-sol) and that is the limit a request actually dies on. Using the
   * registry value here made `contextPercent` read ~4x low, so the auto-compaction
   * gate stayed below its threshold right up to a hard context-window failure.
   * Undefined until the rollout has been read; falls back to the registry.
   */
  private _codexContextWindow?: number;

  /**
   * Cumulative `input_tokens` codex reported at the end of the previous turn.
   *
   * Codex's `turn.completed.usage` is cumulative over the whole thread, not the
   * turn — three identical trivial turns report 13,856 → 27,727 → 41,613, and
   * each of those equals `total_token_usage.input_tokens` in the rollout exactly.
   * Subtracting consecutive values recovers the per-turn prompt, which for a
   * thread-resuming engine is the live context occupancy.
   */
  private _prevCumulativeIn?: number;

  /** Guards the rollout lookup so it runs at most once per session. */
  private _rolloutRead = false;

  /** This thread's rollout file, once found. */
  private _rolloutPath?: string;

  /**
   * The model codex reports it ran, from the rollout's `turn_context`. With no
   * `--model`, codex runs the `model` in the user's `~/.codex/config.toml`, and
   * pricing that session at this wrapper's default misstates its cost.
   */
  private _codexModel?: string;

  /** The main thread's cumulative usage as the last `turn.completed` gave it. */
  private _mainTotals: CodexTokenTotals = { ...ZERO };
  /** Sub-agent threads this thread started, and the usage each one's rollout last recorded. */
  private _subAgents = new Map<string, { totals: CodexTokenTotals; model?: string }>();
  /** How far the main rollout has been read for sub-agent ids. */
  private _rolloutScanOffset = 0;
  /** Usage no `turn.completed` reports: side questions, reviewers. */
  private _extraTotals: CodexTokenTotals = { ...ZERO };
  /** What has been priced so far, per bucket (`main`, a sub-agent's thread id). */
  private _priced = new Map<string, CodexTokenTotals>();
  /** Spend so far, each report priced at the model it ran on. */
  private _costParts = { input: 0, cached: 0, output: 0 };
  /** The model of the turn in flight when it was given per send. */
  private _turnModel?: string;
  /** The last request's prompt, for `contextBreakdown`. */
  private _contextTokens = 0;
  /** `skills/list`, reused for a minute. */
  private _skills?: { at: number; skills: CodexSkill[] };

  constructor(config: SessionConfig, codexBin?: string) {
    super(config, codexBin || process.env.CODEX_BIN || 'codex', {
      enginePrefix: 'codex',
      defaultModel: 'gpt-5.5',
      supportsCachedTokens: true,
      // Verified against codex 0.149.1's own rollout record: for the same turn
      // `total_token_usage` reads `{input_tokens: 19699, cached_input_tokens:
      // 11008, output_tokens: 5, total_tokens: 19704}` — 19699 + 5, so the
      // cached reads are already inside `input_tokens` and must be subtracted
      // out before the rest bills at the full rate.
      inputIncludesCachedTokens: true,
      engineDisplayName: 'Codex',
    });
    if (config.resumeSessionId && !/^codex-\d+-/.test(config.resumeSessionId)) {
      if (config.forkSession) this._forkSourceId = config.resumeSessionId;
      else this.codexThreadId = config.resumeSessionId;
    }
  }

  /** Expose the captured thread ID for the codex_resume tool and stats overlay. */
  get threadId(): string | undefined {
    return this.codexThreadId;
  }

  /** Refuses a `codexConfig`, `codexFeatures` or `turnCommand` codex would not take before any turn runs. */
  override async start(): Promise<this> {
    codexConfigArgs(this.options.codexConfig);
    codexFeatureArgs(this.options.codexFeatures);
    codexTurnCommand(this.options.turnCommand);
    return super.start();
  }

  /**
   * The message under the session's `turnCommand`: plan mode as the planning
   * prefix (`codex exec` has no plan mode), a skill as Codex's `$name` mention.
   */
  applyTurnCommand(_command: string, message: string): string {
    const tc = codexTurnCommand(this.options.turnCommand);
    if (!tc) return message;
    return 'plan' in tc ? `${PLAN_PREFIX}\n\n${message}` : `$${tc.skill} ${message}`;
  }

  protected override _continuesConversation(): boolean {
    // A fork starts from the source thread's history, instructions included.
    return !!this.codexThreadId || !!this._forkSourceId;
  }

  // ── Context accounting ─────────────────────────────────────────────────

  /** Codex's enforced limit when we know it, else the model registry's. */
  protected override _billedModel(): string | undefined {
    return this.options.model || this._codexModel;
  }

  protected override _effectiveContextWindow(): number {
    return this._codexContextWindow ?? super._effectiveContextWindow();
  }

  /**
   * Harvest what `codex exec --json` does not emit from the thread's rollout file.
   *
   * The JSON stream carries only `turn.completed.usage`; codex's own context
   * limit and the pre-existing token total of a resumed thread live in
   * `$CODEX_HOME/sessions/**\/rollout-*-<thread_id>.jsonl`. Runs at most once
   * per session and is entirely best-effort: an unreadable, absent or
   * `--ephemeral` thread simply leaves both values unset and the registry
   * fallback applies.
   *
   * Before a fork's first turn the thread read is the source: the fork carries
   * on from the source's cumulative usage, so that is the first turn's baseline.
   * Once the fork's own id is known the read runs again, for its own rollout.
   */
  private _readRollout(): void {
    const threadId = this.codexThreadId ?? this._forkSourceId;
    if (this._rolloutRead || !threadId) return;
    this._rolloutRead = true;
    try {
      const match = findCodexRollout(threadId);
      if (!match) return;
      this._rolloutPath = match;

      const text = readFileSync(match, 'utf8');

      const windowMatch = /"model_context_window":\s*(\d+)/.exec(text);
      if (windowMatch) this._codexContextWindow = Number(windowMatch[1]);

      if (!this.options.model) {
        let lastModel: string | undefined;
        for (const line of text.split('\n')) {
          if (!line.includes('"turn_context"')) continue;
          try {
            const entry = JSON.parse(line) as { type?: string; payload?: { model?: unknown } };
            if (entry.type === 'turn_context' && typeof entry.payload?.model === 'string') {
              lastModel = entry.payload.model;
            }
          } catch {
            /* a torn last line is expected while codex is still writing */
          }
        }
        if (lastModel) {
          this._codexModel = lastModel;
          this._updateCost();
        }
      }

      // Last entry wins — it is the thread total as of the most recent turn.
      if (this._prevCumulativeIn === undefined) {
        const totals = text.match(/"total_token_usage":\s*\{[^}]*\}/g);
        const last = totals?.[totals.length - 1];
        if (last) {
          const parsed = JSON.parse(`{${last}}`) as { total_token_usage?: { input_tokens?: number } };
          const seed = parsed.total_token_usage?.input_tokens;
          if (typeof seed === 'number') this._prevCumulativeIn = seed;
        }
      }
    } catch {
      /* best effort — registry fallback covers every failure mode */
    }
  }

  /**
   * Prompt size of the latest request codex recorded for this thread.
   *
   * A turn makes one request per tool round, and `turn.completed.usage` — or
   * the difference between two of them — sums them all: it is the turn's spend,
   * not the context's size. The rollout records each request's own usage as a
   * `token_count` event's `last_token_usage`, whose `input_tokens` includes the
   * cached reads. Only the file's tail is read; undefined when there is no
   * rollout (an `--ephemeral` thread) or nothing in it to read.
   */
  private _lastRequestPrompt(): number | undefined {
    if (!this._rolloutPath) return undefined;
    let fd: number | undefined;
    try {
      fd = openSync(this._rolloutPath, 'r');
      const size = fstatSync(fd).size;
      const len = Math.min(size, 256 * 1024);
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, size - len);
      const all = buf.toString('utf8').match(/"last_token_usage":\s*\{[^}]*\}/g);
      const last = all?.[all.length - 1];
      if (!last) return undefined;
      const parsed = JSON.parse(`{${last}}`) as { last_token_usage?: { input_tokens?: number } };
      const prompt = parsed.last_token_usage?.input_tokens;
      return typeof prompt === 'number' && prompt > 0 ? prompt : undefined;
    } catch {
      return undefined;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  /**
   * Files Codex's built-in image generation has saved for this thread.
   *
   * `codex exec --json` emits no event for a generated image; the only record
   * is the file, under `$CODEX_HOME/generated_images/<thread_id>/`. Diffing the
   * directory around a turn gives that turn's images. Empty until the thread
   * id is known — a new thread's first turn reports it before it ends.
   */
  private _generatedImages(): Set<string> {
    if (!this.codexThreadId) return new Set();
    const dir = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'generated_images', this.codexThreadId);
    try {
      return new Set(
        readdirSync(dir)
          .filter((f) => /\.(png|jpe?g|webp|gif)$/i.test(f))
          .map((f) => join(dir, f)),
      );
    } catch {
      return new Set();
    }
  }

  /**
   * Build the Codex spawn args for this turn.
   *
   * First turn:    `codex exec --sandbox W --skip-git-repo-check --json -C cwd … -`
   * Fork turn:     `codex exec fork <source_id> --skip-git-repo-check --json -c sandbox_mode="W" … -`
   * Resume turns:  `codex exec resume <thread_id> --skip-git-repo-check --json -c sandbox_mode="W" … -`
   *
   * The prompt is always on stdin (`-`); `lastMessagePath` is where codex
   * writes the turn's final message.
   */
  private _buildArgs(
    images: readonly string[] | undefined,
    lastMessagePath: string,
    turn: { model?: string; effort?: EffortLevel } = {},
  ): string[] {
    const args: string[] = ['exec'];
    const isResume = !!this.codexThreadId;
    const isFork = !isResume && !!this._forkSourceId;
    const sandbox = this.options.sandboxMode || 'workspace-write';
    if (isResume || isFork) {
      // `codex exec resume` rejects --sandbox and -C (still true as of 0.146.0:
      // passing --sandbox errors with "unexpected argument"), so the policy has
      // to be restated as a `-c` config override, which resume does accept.
      // `codex exec fork` (0.171) takes the same options as resume.
      //
      // Do NOT rely on the resumed thread inheriting the first turn's sandbox.
      // It does not: against 0.146.0, a read-only session whose first turn was
      // spawned with `--sandbox read-only` wrote to disk on the very next turn,
      // reproducibly, when resume was left to inherit. Restating the mode keeps
      // a read-only session read-only for its whole life.
      if (isResume) args.push('resume', this.codexThreadId!);
      else args.push('fork', this._forkSourceId!);
      args.push('--skip-git-repo-check', '--json');
      args.push('-c', `sandbox_mode="${sandbox}"`);
    } else {
      args.push('--sandbox', sandbox, '--skip-git-repo-check', '--json');
      if (this.options.cwd) args.push('-C', this.options.cwd);
    }
    // Structured output: Codex 0.132+ accepts `--output-schema <FILE>` on both
    // `exec` and `exec resume`, enforcing the model's final response shape.
    // The engine-agnostic `jsonSchema` config is inline; Codex needs a path.
    const schemaPath = this._ensureSchemaFile();
    if (schemaPath) args.push('--output-schema', schemaPath);
    // A model or effort given for this send only: the next process goes back to the session's.
    const model = turn.model ?? this.options.model;
    if (model) args.push('--model', model);
    args.push(...this._reasoningEffortArgs(turn.effort));
    // The caller's config overrides and feature switches, on every turn: like
    // the sandbox, nothing says a resumed thread keeps them. Keys the wrapper
    // sets itself were refused in start().
    args.push(...codexConfigArgs(this.options.codexConfig));
    args.push(...codexFeatureArgs(this.options.codexFeatures));
    // `--profile` is rejected by `codex exec resume` and `fork` (like
    // --sandbox/-C); the resumed thread already carries the profile's config, so
    // only pass it on the first turn. (`-c` and `--model` ARE accepted on resume,
    // verified against `codex exec resume --help` on 0.137.)
    if (!isResume && !isFork && this.options.codexProfile) args.push('--profile', this.options.codexProfile);
    // `--ephemeral` is codex's counterpart to Claude Code's
    // `--no-session-persistence`, so the engine-agnostic option finally means
    // something here. Accepted by both `exec` and `exec resume`.
    if (this.options.noSessionPersistence) args.push('--ephemeral');
    // Opt-in isolation from `$CODEX_HOME/config.toml`. That file is the user's,
    // not the orchestrator's: a `model = …` line in it silently decides which
    // model an orchestrated run uses and which one we then price it as. Auth
    // still resolves from CODEX_HOME, so this does not log the session out.
    if (this.options.ignoreUserConfig) args.push('--ignore-user-config');
    // Skips the user's and the project's execpolicy `.rules` files.
    if (this.options.ignoreRules) args.push('--ignore-rules');
    // Extra writable roots. Rejected by `exec resume` and `fork` (like
    // --sandbox/-C), and the resumed thread keeps the roots the first turn opened.
    if (!isResume && !isFork && this.options.addDir?.length) {
      for (const dir of this.options.addDir) args.push('--add-dir', dir);
    }
    // The turn's final message alone. Every agent message of the turn, its
    // commentary included ("Running the command." before the answer, measured
    // on 0.171.0), arrives as the same `agent_message` item with no phase, so
    // the stream cannot tell the answer apart; codex writes it to this file.
    args.push('--output-last-message', lastMessagePath);
    // `-i/--image <FILE>...` takes any number of values and would read the `-`
    // below as one more image, losing the prompt; the `=` form takes exactly one.
    for (const image of images ?? []) args.push(['--image', image].join('='));
    // `-` reads the prompt from stdin. On Windows `codex` is an npm `.cmd` shim
    // that runs through cmd.exe, which would cut a prompt at its first newline
    // and mis-split one with an unbalanced quote; stdin carries it unchanged.
    args.push('-');
    return args;
  }

  /**
   * Map the engine-agnostic `effort` to Codex's reasoning-effort config override
   * (`-c model_reasoning_effort=<level>`), which both `exec` and `exec resume`
   * accept.
   */
  private _reasoningEffortArgs(effort?: EffortLevel): string[] {
    const e = codexReasoningEffort(effort ?? this.options.effort);
    return e ? ['-c', `model_reasoning_effort=${e}`] : [];
  }

  /**
   * Materialize the `jsonSchema` config to a temp file (once) and return its
   * path, or undefined when no schema is configured. The file is removed in
   * _cleanupProc() (i.e. on stop()).
   */
  private _ensureSchemaFile(): string | undefined {
    if (!this.options.jsonSchema) return undefined;
    if (this._schemaFilePath) return this._schemaFilePath;
    const path = join(tmpdir(), `claw-codex-schema-${this.sessionId}-${Date.now()}.json`);
    writeFileSync(path, this.options.jsonSchema, 'utf8');
    this._schemaFilePath = path;
    return path;
  }

  protected override _cleanupProc(): void {
    if (this._schemaFilePath) {
      try {
        unlinkSync(this._schemaFilePath);
      } catch {
        // Already gone / never written — nothing to clean.
      }
      this._schemaFilePath = undefined;
    }
    super._cleanupProc();
  }

  protected _run(message: string, options: SessionSendOptions): Promise<TurnResult> {
    // Read before spawning: on a resumed thread the baseline has to be the
    // cumulative total as of the *previous* turn, and this turn is about to
    // append its own to the same file.
    this._readRollout();
    const imagesBefore = this._generatedImages();
    const lastMessagePath = join(
      tmpdir(),
      `claw-codex-last-${this.sessionId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`,
    );
    if (options.plan && !message.startsWith(PLAN_PREFIX)) message = `${PLAN_PREFIX}\n\n${message}`;
    this._turnModel = options.model;
    const args = this._buildArgs(options.images, lastMessagePath, { model: options.model, effort: options.effort });
    const timeout = options.timeout || 300_000;

    /** The final message codex wrote, if it wrote one; the file is removed either way. */
    const takeLastMessage = (): string | undefined => {
      try {
        return readFileSync(lastMessagePath, 'utf8') || undefined;
      } catch {
        return undefined;
      } finally {
        try {
          unlinkSync(lastMessagePath);
        } catch {
          // Never written.
        }
      }
    };

    return new Promise<TurnResult>((resolve, reject) => {
      let stdoutBuf = '';
      let stderr = '';
      let assistantText = '';
      let lastUsage: CodexTurnCompleted['usage'] | undefined;
      let turnError: string | undefined;
      let settled = false;

      const proc = spawnEngine(this.engineBin, args, {
        launcher: this.options.launcher,
        cwd: this.options.cwd,
        env: { ...process.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.currentProc = proc;
      // A process that dies before reading surfaces through 'close'; the write
      // error itself carries nothing more.
      proc.stdin?.on('error', () => {});
      proc.stdin?.end(message);

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          killEngineTree(proc);
          takeLastMessage();
          reject(new Error('Timeout waiting for Codex response'));
        }
      }, timeout);

      const handleEvent = (line: string) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let event: unknown;
        try {
          event = JSON.parse(trimmed);
        } catch {
          // Not JSON — log it (could be a stray Codex banner or warning).
          this.emit(SESSION_EVENT.LOG, `[codex-stdout] ${trimmed}`);
          return;
        }
        const ev = event as { type?: string };
        switch (ev.type) {
          case 'thread.started': {
            const t = event as CodexThreadStarted;
            if (t.thread_id && !this.codexThreadId) {
              this.codexThreadId = t.thread_id;
              if (this._forkSourceId) {
                // The fork is a thread of its own now: later turns resume it,
                // and its own rollout replaces the source's for the context
                // window and the last request.
                this._forkSourceId = undefined;
                this._rolloutRead = false;
                this._rolloutPath = undefined;
              }
            }
            break;
          }
          case 'item.completed': {
            const it = event as CodexItemCompleted;
            const itemType = it.item?.type;
            if (itemType === 'agent_message' && typeof it.item.text === 'string') {
              const chunk = it.item.text;
              assistantText += chunk;
              try {
                options.callbacks?.onText?.(chunk);
              } catch {
                // User callback errors are not fatal.
              }
              this.emit(SESSION_EVENT.TEXT, chunk);
            } else if (itemType === 'reasoning') {
              // Reasoning summary — not a tool call; log without inflating toolCalls.
              this.emit(SESSION_EVENT.LOG, `[codex-reasoning] ${trimmed}`);
            } else if (itemType === 'todo_list') {
              // Plan / todo-list updates (model-initiated or via --include-plan-tool).
              this.emit(SESSION_EVENT.LOG, `[codex-plan] ${trimmed}`);
            } else {
              // Real tool-call items: command_execution, file_change, mcp_tool_call, web_search.
              this._stats.toolCalls++;
              if (
                itemType === 'command_execution' &&
                typeof it.item.exit_code === 'number' &&
                it.item.exit_code !== 0
              ) {
                this._stats.toolErrors++;
              }
              try {
                options.callbacks?.onToolUse?.(event);
              } catch {
                // Same swallow rule.
              }
              this.emit(SESSION_EVENT.LOG, `[codex-tool] ${trimmed}`);
            }
            break;
          }
          case 'turn.completed': {
            const tc = event as CodexTurnCompleted;
            if (tc.usage) lastUsage = tc.usage;
            break;
          }
          case 'turn.failed': {
            const tf = event as CodexTurnFailed;
            if (tf.error?.message) turnError = tf.error.message;
            this.emit(SESSION_EVENT.LOG, `[codex-error] ${trimmed}`);
            break;
          }
          case 'error': {
            const er = event as CodexError;
            if (er.message) turnError = er.message;
            this.emit(SESSION_EVENT.LOG, `[codex-error] ${trimmed}`);
            break;
          }
          default:
            // Unhandled event types still go to the log so users can debug.
            this.emit(SESSION_EVENT.LOG, `[codex-event] ${trimmed}`);
        }
      };

      proc.stdout?.on('data', (data: Buffer) => {
        stdoutBuf += data.toString();
        let nl: number;
        while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
          const line = stdoutBuf.slice(0, nl);
          stdoutBuf = stdoutBuf.slice(nl + 1);
          handleEvent(line);
        }
      });

      proc.stderr?.on('data', (data: Buffer) => {
        const sanitized = sanitizeSecrets(data.toString());
        stderr += sanitized;
        this.emit(SESSION_EVENT.LOG, `[codex-stderr] ${sanitized}`);
      });

      proc.on('close', (code) => {
        clearTimeout(timer);
        this.currentProc = null;

        if (settled) {
          // A timed-out turn's process may still have written the file.
          takeLastMessage();
          return;
        }
        settled = true;

        // Drain any final partial line as an event attempt.
        if (stdoutBuf.trim()) handleEvent(stdoutBuf);

        // One expression for the outcome: it feeds the counter here and the
        // `stop_reason` below. Classifying on the exit code alone reported
        // `end_turn` for a `turn.failed` that exits 0 — the same turn the reject
        // below has always treated as a failure.
        const ok = !turnError && code === 0;
        this._recordTurnComplete(ok);

        // Real usage from `turn.completed`. Falls back to zero rather than
        // estimated tokens — better to have an honest "0" than a guess that
        // misleads cost reporting.
        //
        // These are thread-cumulative, so they are *assigned*, not accumulated.
        // Adding them summed a running total of running totals: with a constant
        // per-turn prompt P, N turns reported P*N*(N+1)/2 against a true P*N —
        // an (N+1)/2 overstatement that grew without bound (measured at 3.6x on
        // a seven-turn session). The codex app-server sibling has always
        // assigned; this brings `codex exec` in line with it.
        if (lastUsage) {
          const cumulativeIn = lastUsage.input_tokens ?? 0;
          this._noteContext(cumulativeIn - (this._prevCumulativeIn ?? 0));
          this._prevCumulativeIn = cumulativeIn;
          this._mainTotals = {
            input: cumulativeIn,
            cached: lastUsage.cached_input_tokens ?? 0,
            output: (lastUsage.output_tokens ?? 0) + (lastUsage.reasoning_output_tokens ?? 0),
          };
        }
        // A fresh session has no rollout to read until its first turn has
        // created one; retry now that the thread id is known. Read before the
        // turn is priced, so its first turn bills at the model codex ran.
        this._readRollout();
        this._updateCost();
        // The sub-agents' usage, which `turn.completed` leaves out.
        this._readSubAgents();
        // The context is the turn's last request, which only the rollout records.
        const lastRequestPrompt = this._lastRequestPrompt();
        if (lastRequestPrompt !== undefined) this._noteContext(lastRequestPrompt);
        // The answer alone when codex wrote it; every message of the turn when it
        // did not (a failed turn, or an older codex).
        const text = takeLastMessage() ?? assistantText;
        this._addHistory({ text, code });

        const images = [...this._generatedImages()].filter((p) => !imagesBefore.has(p));
        const event: StreamEvent = {
          type: 'result',
          result: text,
          stop_reason: ok ? 'end_turn' : 'error',
          session_id: this.codexThreadId,
          ...(images.length ? { generated_images: images.map((path): GeneratedImage => ({ path })) } : {}),
        };

        this.emit(SESSION_EVENT.RESULT, event);
        this.emit(SESSION_EVENT.TURN_COMPLETE, event);

        // A captured turn.failed/error event means the turn failed even if the
        // process exits 0 — surface it rather than resolving an empty string.
        if (turnError) {
          reject(new Error(turnError));
        } else if (code !== 0) {
          reject(new Error(stderr || `Codex exited with code ${code}`));
        } else {
          resolve({ text, event });
        }
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          takeLastMessage();
          reject(err);
        }
      });
    });
  }

  /** Override getStats to expose the captured thread ID. */
  getStats(): ReturnType<BaseOneShotSession['getStats']> {
    const base = super.getStats();
    return { ...base, codexThreadId: this.codexThreadId };
  }

  // ── Usage and cost ─────────────────────────────────────────────────────

  /** The last request's prompt size: the context figure, and `contextBreakdown`'s total. */
  private _noteContext(tokens: number): void {
    if (tokens <= 0) return;
    this._contextTokens = tokens;
    this._reportTurnInputTokens(tokens);
  }

  /**
   * The session's totals: the main thread's, its sub-agents', and what no
   * stream reports (side questions, reviewers). What was added since the last
   * call is priced now, each part at the model it ran on, so a per-send model
   * or a sub-agent's own model bills as itself.
   */
  protected override _updateCost(): void {
    const turnModel = this._turnModel ?? this._billedModel();
    this._price('main', this._mainTotals, turnModel);
    for (const [id, sub] of this._subAgents) this._price(id, sub.totals, sub.model ?? turnModel);
    let input = this._mainTotals.input + this._extraTotals.input;
    let cached = this._mainTotals.cached + this._extraTotals.cached;
    let output = this._mainTotals.output + this._extraTotals.output;
    for (const sub of this._subAgents.values()) {
      input += sub.totals.input;
      cached += sub.totals.cached;
      output += sub.totals.output;
    }
    this._stats.tokensIn = input;
    this._stats.cachedTokens = cached;
    this._stats.tokensOut = output;
    this._stats.costUsd = this._costParts.input + this._costParts.cached + this._costParts.output;
  }

  private _price(bucket: string, now: CodexTokenTotals, model: string | undefined): void {
    const prev = this._priced.get(bucket) ?? ZERO;
    this._priced.set(bucket, { ...now });
    this._addCost(model, {
      input: Math.max(0, now.input - prev.input),
      cached: Math.max(0, now.cached - prev.cached),
      output: Math.max(0, now.output - prev.output),
    });
  }

  private _addCost(model: string | undefined, d: CodexTokenTotals): void {
    const pricing = getModelPricing(model, 'gpt-5.5');
    this._costParts.input += (Math.max(0, d.input - d.cached) / 1_000_000) * pricing.input;
    this._costParts.cached += (d.cached / 1_000_000) * (pricing.cached ?? 0);
    this._costParts.output += (d.output / 1_000_000) * pricing.output;
  }

  /** Add usage no `turn.completed` reports, priced at `model`. */
  private _addExtraUsage(usage: CodexTokenTotals, model?: string): void {
    this._extraTotals = {
      input: this._extraTotals.input + usage.input,
      cached: this._extraTotals.cached + usage.cached,
      output: this._extraTotals.output + usage.output,
    };
    this._addCost(model ?? this._billedModel(), usage);
    this._updateCost();
  }

  override getCost(): CostBreakdown {
    const base = super.getCost();
    return {
      ...base,
      breakdown: {
        inputCost: this._costParts.input,
        cachedCost: this._costParts.cached,
        outputCost: this._costParts.output,
      },
    };
  }

  /**
   * Read the sub-agents' usage from their rollouts: their ids from what the
   * main rollout gained since the last read, each one's total from its own.
   * Best effort; an `--ephemeral` thread has no rollouts.
   */
  private _readSubAgents(): void {
    if (!this._rolloutPath || this.options.noSessionPersistence) return;
    try {
      const { text, size } = readFileSlice(this._rolloutPath, { from: this._rolloutScanOffset });
      // Up to the last full line: a torn one is read again next time.
      const cut = text.lastIndexOf('\n');
      if (cut >= 0) this._rolloutScanOffset += Buffer.byteLength(text.slice(0, cut + 1));
      else if (size < this._rolloutScanOffset) this._rolloutScanOffset = 0;
      for (const id of subAgentThreadIds(cut >= 0 ? text.slice(0, cut + 1) : '')) {
        if (!this._subAgents.has(id)) this._subAgents.set(id, { totals: { ...ZERO } });
      }
      if (!this._subAgents.size) return;
      for (const u of subAgentUsage([...this._subAgents.keys()], codexSessionsRoot())) {
        this._subAgents.set(u.threadId, { totals: u.totals, model: u.model });
      }
      this._updateCost();
    } catch {
      // Best effort: the main thread's usage stands.
    }
  }

  // ── The short-lived app-server ─────────────────────────────────────────

  /** Spawn options for a short-lived app-server that sees what this session's turns see. */
  codexClientOptions(): { bin: string; cwd?: string; launcher?: readonly string[]; args: string[] } {
    return {
      bin: this.engineBin,
      cwd: this.options.cwd,
      launcher: this.options.launcher,
      args: [
        ...codexConfigArgs(this.options.codexConfig),
        ...codexFeatureArgs(this.options.codexFeatures),
        ...this._reasoningEffortArgs(),
      ],
    };
  }

  /** The thread, or why there is none to work on. */
  private _requireThread(what: string): string {
    if (!this.codexThreadId) throw new Error(`${what} needs the session's thread; send a first message`);
    if (this.options.noSessionPersistence) {
      throw new Error(
        `${what} loads the thread in another codex process, and an ephemeral thread (noSessionPersistence) has no rollout to load`,
      );
    }
    return this.codexThreadId;
  }

  /** Run `fn` with this session's thread loaded on a short-lived app-server. No turn may be running. */
  private async _withThread<T>(what: string, fn: (client: CodexAppClient, threadId: string) => Promise<T>): Promise<T> {
    const threadId = this._requireThread(what);
    if (this.isBusy) throw new Error(`${what}: a turn is running on the thread; wait for it to end`);
    return withCodexAppClient(this.codexClientOptions(), async (client) => {
      await client.request('thread/resume', {
        threadId,
        ...(this.options.cwd ? { cwd: this.options.cwd } : {}),
        ...(this.options.model ? { model: this.options.model } : {}),
        sandbox: this.options.sandboxMode || 'workspace-write',
        approvalPolicy: 'never',
        excludeTurns: true,
      });
      return fn(client, threadId);
    });
  }

  /**
   * Start a turn on the loaded thread and wait for it to end: the root turn
   * the response names, or, when it names none, the first root turn of the
   * thread to end. Returns what the turn left.
   */
  private async _threadTurn(
    client: CodexAppClient,
    threadId: string,
    start: () => Promise<unknown>,
    timeoutMs: number,
  ): Promise<{
    status: string;
    review?: string;
    answer?: string;
    shell?: { output: string; exitCode: number | null };
    error?: string;
    lastTokens?: number;
  }> {
    type Note = {
      threadId?: string;
      turnId?: string;
      turn?: { id?: string; rootTurnId?: string | null; status?: string; error?: { message?: string } | null };
      item?: Record<string, unknown>;
      tokenUsage?: { last?: { inputTokens?: number; totalTokens?: number } };
    };
    const ended = new Map<string, Note>();
    const out: {
      review?: string;
      answer?: string;
      shell?: { output: string; exitCode: number | null };
      lastTokens?: number;
    } = {};
    let wake: (() => void) | undefined;
    const onNote = (method: string, params: unknown) => {
      const p = (params ?? {}) as Note;
      if (p.threadId !== threadId) return;
      if (method === 'item/completed' && p.item) {
        if (p.item.type === 'exitedReviewMode' && typeof p.item.review === 'string') out.review = p.item.review;
        if (p.item.type === 'agentMessage' && typeof p.item.text === 'string') out.answer = p.item.text;
        if (p.item.type === 'commandExecution' && p.item.source === 'userShell') {
          out.shell = {
            output: typeof p.item.aggregatedOutput === 'string' ? p.item.aggregatedOutput : '',
            exitCode: typeof p.item.exitCode === 'number' ? p.item.exitCode : null,
          };
        }
      } else if (method === 'thread/tokenUsage/updated') {
        const last = p.tokenUsage?.last;
        const n = last?.inputTokens && last.inputTokens > 0 ? last.inputTokens : last?.totalTokens;
        if (typeof n === 'number' && n > 0) out.lastTokens = n;
      } else if (method === 'turn/completed' && p.turn?.id && (!p.turn.rootTurnId || p.turn.rootTurnId === p.turn.id)) {
        ended.set(p.turn.id, p);
        wake?.();
      }
    };
    client.on('notification', onNote);
    try {
      const resp = (await start()) as { turn?: { id?: string } } | undefined;
      const id = resp?.turn?.id;
      const deadline = Date.now() + timeoutMs;
      const pick = (): Note | undefined => (id ? ended.get(id) : [...ended.values()][0]);
      let done = pick();
      while (!done) {
        const left = deadline - Date.now();
        if (left <= 0) throw new Error(`codex app-server: the turn did not end within ${timeoutMs} ms`);
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, left);
          wake = () => {
            clearTimeout(timer);
            resolve();
          };
          client.once('close', () => {
            clearTimeout(timer);
            reject(new Error('codex app-server exited before the turn ended'));
          });
        });
        done = pick();
      }
      return {
        status: done.turn?.status ?? 'completed',
        ...out,
        ...(done.turn?.error?.message ? { error: done.turn.error.message } : {}),
      };
    } finally {
      client.off('notification', onNote);
    }
  }

  // ── Capabilities ───────────────────────────────────────────────────────

  /**
   * Compact the thread on a short-lived app-server (`thread/resume`, then
   * `thread/compact/start`), and resolve when the compaction's turn has ended.
   * The next `codex exec resume` goes on from the compacted thread. Codex
   * compacts with its own prompt; `summary` is not used.
   */
  async compactDetailed(_summary?: string): Promise<CompactOutcome> {
    const preTokens = this._contextTokens;
    // Nothing to compact, and no process to start: said, not thrown, so an
    // auto-compaction gate does not fail the send it runs before.
    if (!this.codexThreadId) {
      return { ok: false, trigger: 'manual', note: 'nothing to compact yet: the thread starts with the first message' };
    }
    if (this.options.noSessionPersistence) {
      return {
        ok: false,
        trigger: 'manual',
        note: 'an ephemeral thread (noSessionPersistence) has no rollout another codex process can load to compact it',
      };
    }
    const turn = await this._withThread('compaction', (client, threadId) =>
      this._threadTurn(
        client,
        threadId,
        () => client.request('thread/compact/start', { threadId }),
        THREAD_JOB_TIMEOUT_MS,
      ),
    );
    const ok = turn.status === 'completed';
    if (ok && turn.lastTokens) this._noteContext(turn.lastTokens);
    return {
      ok,
      trigger: 'manual',
      ...(preTokens > 0 ? { preTokens } : {}),
      ...(ok && turn.lastTokens && turn.lastTokens !== preTokens ? { postTokens: turn.lastTokens } : {}),
      ...(ok ? {} : { note: turn.error ?? `the compaction ended ${turn.status}` }),
    };
  }

  /** `compact()` is `compactDetailed()` as a TurnResult. */
  override async compact(summary?: string): Promise<TurnResult> {
    const outcome = await this.compactDetailed(summary);
    const text = outcome.ok
      ? 'Codex thread compacted'
      : `Codex thread compaction failed${outcome.note ? `: ${outcome.note}` : ''}`;
    return { text, event: { type: 'result', result: text, ...(outcome.ok ? {} : { is_error: true }) } };
  }

  /**
   * A side question (`thread/sample` on a short-lived app-server): answered
   * from the thread's context after its latest turn, not added to it, no tools.
   */
  async askAside(question: string, opts: { timeout?: number } = {}): Promise<AsideOutcome> {
    // Loading the thread appends to its rollout, which a running `codex exec`
    // writes too: the aside waits for no turn, it refuses beside one.
    const resp = await this._withThread('a side question', async (client, threadId) => {
      const expectedTurnId = await latestCodexTurnId(client, threadId);
      if (!expectedTurnId) throw new Error('a side question samples the thread after a turn; send a first message');
      return (await client.request(
        'thread/sample',
        { threadId, expectedTurnId, prompt: question },
        opts.timeout || TURN_TIMEOUT_MS,
      )) as {
        text?: string | null;
        inputTokens?: number | null;
        cachedInputTokens?: number | null;
        outputTokens?: number | null;
      };
    });
    this._addExtraUsage({
      input: resp?.inputTokens ?? 0,
      cached: resp?.cachedInputTokens ?? 0,
      output: resp?.outputTokens ?? 0,
    });
    if (typeof resp?.text !== 'string') {
      throw new Error(
        'the side question got no text answer: the model tried to call a tool, which a side question cannot',
      );
    }
    return { text: resp.text };
  }

  /** Drop the last `turns` turns (`thread/revert` on a short-lived app-server); the files stay as they are. */
  async rewind(target: RewindTarget): Promise<RewindOutcome> {
    if (target.messageId !== undefined)
      throw new Error('codex rewinds by turns (thread/revert), not to a message; give turns');
    if (target.files) {
      throw new Error(
        'restoring files on rewind is not supported on codex: thread/revert changes the conversation only; omit files',
      );
    }
    const turns = target.turns ?? 1;
    await this._withThread('rewind', (client, threadId) => revertCodexTurns(client, threadId, turns));
    // The reverted thread goes on in a rollout file of its own: read that one from now on.
    this._rolloutRead = false;
    this._rolloutPath = undefined;
    this._rolloutScanOffset = 0;
    return { ok: true, turnsRemoved: turns, filesRestored: false };
  }

  /** Each turn is a new process: the next one runs `--model <model>`. */
  async setModelLive(model: string): Promise<boolean> {
    this.options.model = model;
    return true;
  }

  /** Each turn is a new process: the next one takes the effort. */
  async setEffortLive(_level: EffortLevel): Promise<boolean> {
    return true;
  }

  /** The last request's prompt against the window codex enforces; codex gives no categories. */
  async contextBreakdown(): Promise<ContextBreakdown | undefined> {
    if (this._contextTokens <= 0) return undefined;
    const window = this._effectiveContextWindow();
    return { totalTokens: this._contextTokens, ...(window ? { windowTokens: window } : {}) };
  }

  // ── Commands ───────────────────────────────────────────────────────────

  private async _listSkills(): Promise<CodexSkill[]> {
    if (this._skills && Date.now() - this._skills.at < SKILLS_CACHE_MS) return this._skills.skills;
    const skills = await withCodexAppClient(this.codexClientOptions(), (client) =>
      listCodexSkills(client, this.options.cwd),
    );
    this._skills = { at: Date.now(), skills };
    return skills;
  }

  /** The built-in commands and the directory's enabled skills. */
  async listCommands(): Promise<EngineCommand[]> {
    const builtins = codexBuiltinCommands({
      engine: 'codex',
      sandboxMode: this.options.sandboxMode || 'workspace-write',
    });
    let skills: CodexSkill[] = [];
    try {
      skills = await this._listSkills();
    } catch (err) {
      this.emit(SESSION_EVENT.LOG, `[codex] skills/list failed: ${(err as Error).message}`);
    }
    return [...builtins, ...codexSkillCommands(skills, builtins)];
  }

  /**
   * Run a command: an info list, `exec`, and the reads of the stored thread
   * (`thread`, `items`, `search`) on a short-lived app-server; `rename`,
   * `memories <arg>`, `compact`, `review`, `inject`, `shell` with the thread
   * loaded on one; `init` and a skill as a turn (`$name` for a skill). Slash
   * text is never sent: Codex reads it as a prompt.
   */
  async runCommand(
    name: string,
    args?: string,
    opts: { timeout?: number; callbacks?: StreamCallbacks } = {},
  ): Promise<CommandOutcome> {
    if (!this.isReady) throw new Error('Session not ready. Call start() first.');
    const timeout = opts.timeout || TURN_TIMEOUT_MS;
    switch (name) {
      case 'rollout': {
        const file = this.codexThreadId ? (this._rolloutPath ?? findCodexRollout(this.codexThreadId)) : undefined;
        return {
          name,
          ok: !!file,
          text:
            file ??
            (this.codexThreadId
              ? 'the thread has no rollout file (an ephemeral thread writes none)'
              : "the session's thread starts with the first message"),
          data: { path: file ?? null },
          startedTurn: false,
        };
      }
      case 'compact': {
        const outcome = await this.compactDetailed();
        return {
          name,
          ok: outcome.ok,
          text: outcome.ok ? 'compacted' : (outcome.note ?? 'the compaction failed'),
          data: outcome,
          startedTurn: false,
          ...(outcome.ok ? {} : { error: outcome.note }),
        };
      }
      case 'review':
        return this._runReview(args, timeout);
      case 'init':
        return this._commandTurn(name, CODEX_INIT_PROMPT, timeout, opts.callbacks);
      case 'inject': {
        const text = args?.trim();
        if (!text) throw new Error('/inject takes the text to add to the thread');
        await this._withThread('/inject', (client, threadId) =>
          client.request('thread/inject_items', {
            threadId,
            items: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text }] }],
          }),
        );
        return { name, ok: true, text: 'added to the thread history; the next turn reads it', startedTurn: false };
      }
      case 'shell':
        return this._runShell(args, timeout);
    }
    const isBuiltin = codexBuiltinCommands({ engine: 'codex', sandboxMode: 'danger-full-access' }).some(
      (c) => c.name === name,
    );
    if (isBuiltin) {
      // `memories` without an argument reads a status; with one, and `rename`, need the thread loaded.
      const touchesThread = codexCommandNeedsThread(name) || (name === 'memories' && !!args?.trim());
      const cwd = this.options.cwd ?? process.cwd();
      const run = (client: CodexAppClient, threadId?: string) =>
        runCodexInfoCommand(client, name, args, {
          engine: 'codex',
          cwd: this.options.cwd,
          threadId,
          sandboxPolicy: codexSandboxPolicy(
            this.options.sandboxMode,
            (this.options.addDir ?? []).map((d) => resolvePath(cwd, d)),
          ),
          timeoutMs: timeout,
        });
      let outcome: CommandOutcome | undefined;
      if (touchesThread) outcome = await this._withThread(`/${name}`, (client, threadId) => run(client, threadId));
      else if (codexCommandReadsStoredThread(name)) {
        // The stored thread is read as it is, a turn in flight or not: nothing is loaded.
        const threadId = this._requireThread(`/${name}`);
        outcome = await withCodexAppClient(this.codexClientOptions(), (client) => run(client, threadId));
      } else outcome = await withCodexAppClient(this.codexClientOptions(), (client) => run(client, this.codexThreadId));
      if (outcome) return outcome;
    }
    const skill = (await this._listSkills()).find((s) => s.name === name && s.enabled);
    if (skill) {
      const text = args?.trim();
      return this._commandTurn(name, `$${skill.name}${text ? ` ${text}` : ''}`, timeout, opts.callbacks);
    }
    throw unknownCodexCommand(name, 'codex');
  }

  /** A command that runs one model turn (`init`, a skill), as a CommandOutcome. */
  private async _commandTurn(
    name: string,
    text: string,
    timeout: number,
    callbacks: StreamCallbacks | undefined,
  ): Promise<CommandOutcome> {
    try {
      const r = (await this.send(text, { waitForComplete: true, timeout, callbacks })) as TurnResult;
      return { name, ok: true, text: r.text, startedTurn: true };
    } catch (err) {
      return { name, ok: false, text: '', startedTurn: true, error: (err as Error).message };
    }
  }

  /**
   * `review/start` on the thread, loaded on a short-lived app-server: inline,
   * as the TUI's /review. The answer is the `exitedReviewMode` item. The
   * reviewer reports no usage while it runs, so its rollout is read after.
   * Counted as a turn of this session.
   */
  private async _runReview(args: string | undefined, timeout: number): Promise<CommandOutcome> {
    const since = Date.now();
    const turn = await this._withThread('/review', (client, threadId) =>
      this._threadTurn(
        client,
        threadId,
        () => client.request('review/start', { threadId, target: codexReviewTarget(args) }),
        Math.max(timeout, THREAD_JOB_TIMEOUT_MS),
      ),
    );
    const ok = turn.status === 'completed';
    this._recordTurnComplete(ok);
    if (this.codexThreadId) {
      const reviewer = reviewRolloutUsage(this.codexThreadId, since);
      if (reviewer.totals) this._addExtraUsage(reviewer.totals, reviewer.model);
    }
    const text = turn.review ?? turn.answer ?? '';
    this._addHistory({ text, code: ok ? 0 : 1 });
    return {
      name: 'review',
      ok,
      text,
      startedTurn: true,
      ...(ok ? {} : { error: turn.error ?? `the review ended ${turn.status}` }),
    };
  }

  /**
   * `thread/shellCommand`, the TUI's `!cmd`, on a short-lived app-server. It
   * runs unsandboxed, so only a `danger-full-access` session runs it.
   */
  private async _runShell(args: string | undefined, timeout: number): Promise<CommandOutcome> {
    if ((this.options.sandboxMode || 'workspace-write') !== 'danger-full-access') {
      throw new Error(
        '/shell runs its command unsandboxed (thread/shellCommand), so it runs only on a danger-full-access session',
      );
    }
    const command = args?.trim();
    if (!command) throw new Error('/shell takes the command to run');
    const turn = await this._withThread('/shell', (client, threadId) =>
      this._threadTurn(
        client,
        threadId,
        () => client.request('thread/shellCommand', { threadId, command, timeoutMs: timeout }),
        timeout + 5_000,
      ),
    );
    const exitCode = turn.shell?.exitCode ?? null;
    const ok = turn.status === 'completed' && (exitCode === null || exitCode === 0);
    return {
      name: 'shell',
      ok,
      text: turn.shell?.output ?? '',
      data: { exitCode },
      startedTurn: false,
      ...(ok ? {} : { error: `the command exited with ${exitCode ?? turn.status}` }),
    };
  }
}
