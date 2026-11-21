/**
 * Persistent Antigravity Session — wraps Google `agy` CLI (Antigravity CLI)
 *
 * Antigravity CLI is Google's successor to Gemini CLI (consumer tiers of
 * Gemini CLI stopped serving 2026-06-18). Like Codex/Gemini, each send()
 * spawns a new `agy` process in print mode.
 *
 * agy speaks `--output-format stream-json` (verified against 1.1.13): one JSON
 * object per line, with an `init` event carrying the conversation id, progress
 * `step_update` events, and a final `result` carrying the response text and
 * real token usage. Three behaviors make this a real engine rather than a
 * custom-engine recipe:
 *
 *   - Conversation continuity: the id arrives on the `init` event and is passed
 *     back as `--conversation <id>` on later sends — true multi-turn context,
 *     like Codex thread resume. The --log-file scrape is kept only as a fallback
 *     for a turn that dies before emitting any event.
 *   - Real usage: input/output/cache-read tokens come from the `result` event,
 *     so cost is measured rather than guessed. Earlier versions of this wrapper
 *     read plain text and estimated ~4 chars/token, which is now only the
 *     fallback path when no result event arrives.
 *   - Timeout coherence: we derive --print-timeout from the send timeout so the
 *     two never disagree. Since 1.2.6 a headless run has no default timeout at
 *     all unless that flag is passed, so it is now the only bound there is.
 *
 * Unknown --model values are NOT reliably harmless. On 1.0.16 an unknown slug
 * fell back to the default silently; on 1.1.25 a slug agy has stopped serving
 * (gemini-3.5-flash) returns `status: ERROR` with an empty response and
 * nothing on stderr. Treat a wrong model as a failed turn, not a quiet swap.
 */

import { spawnEngine } from './engine-spawn.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { EffortLevel, SessionConfig, SessionSendOptions, StreamEvent, TurnResult } from './types.js';
import { estimateTokens, getModelPricing } from './models.js';
import { sanitizeSecrets } from './sanitize.js';
import {
  extractCreatedAgyConversationId,
  extractAgyToolPermissionDenials,
  hasAgyToolPermissionDenial,
  isAgyConversationId,
} from './agy-conversation.js';
import { SESSION_EVENT } from './constants.js';
import { BaseOneShotSession } from './base-oneshot-session.js';

/** Token usage as reported by agy's `result` event. */
interface AgyUsage {
  input_tokens?: number;
  output_tokens?: number;
  thinking_tokens?: number;
  cache_read_tokens?: number;
  total_tokens?: number;
}

/** One line of agy `--output-format stream-json`. Captured from agy 1.1.13. */
interface AgyStreamEvent {
  event?: string;
  conversation_id?: string;
  /** Progress of one step; an `agent_response` step carries its own request's usage (agy 1.5.3). */
  step_update?: {
    conversation_id?: string;
    /** Position in its conversation; a tool step is reported ACTIVE, then DONE, at the same index (1.5.13). */
    step_index?: number;
    state?: string;
    step_type?: string;
    usage?: AgyUsage;
    /** Present on every step that calls a tool: `{ name, parameters, output }`. */
    tool_info?: unknown;
    /** Present on a step that delegates to a subagent: `{ conversation_id, log_uri, ... }`. */
    subagent_info?: unknown;
  };
  result?: {
    conversation_id?: string;
    status?: string;
    response?: string;
    error?: string;
    usage?: AgyUsage;
    /** Why the turn ended early (agy 1.4.11+): `print_timeout`, `interrupted` or `error`; absent when it finished. */
    finished_reason?: string;
    /** The value `--json-schema` asked for; `response` carries it as JSON text too (1.5.13). */
    structured_output?: unknown;
  };
}

/** agy models with a reasoning tier above `high`; `agy models` lists them with a `-xhigh` slug. */
export const AGY_XHIGH_MODELS = /^gemini-4-(?:hydrogen|neon)(?:-|$)/;

const EMPTY_RESPONSE_ERROR =
  'Antigravity returned an empty response; the turn failed but the session remains available for retry';
const TOOL_DENIAL_EMPTY_RESPONSE_ERROR =
  'Antigravity returned an empty response after a tool permission denial; the turn failed but the session remains available for retry';
const AGY_ECHOABLE_TOOL_NAME_RE = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/;

// A run cut off by its own deadline. agy 1.4.11+ says so in the result's
// `finished_reason` (`print_timeout`; on 1.5.13 with status ERROR and exit 3),
// which decides whenever it is present. Before that, 1.2.9+ ended such a run
// with exit 0 and status SUCCESS, carrying whatever partial reply existed, and
// said so only on stderr; that line, and elapsed time, remain the fallback for a
// result without the field. The idle line means the agent had finished and agy
// was waiting on a background task, so a deadline after it is a clean end.
const AGY_DEADLINE_IN_PROGRESS_RE = /print timeout after \S+ with turn in progress/;
const AGY_IDLE_WAIT_RE = /agent idle; waiting up to/;

/**
 * A `-p` value agy may read as one of its own flags. Measured on 1.5.13: a value
 * that is exactly a flag is taken as that flag — `--version` and `--help` print
 * and exit 0 without a turn, `-v` and `--continue` exit 2 — while a dash followed
 * by more text (`- item one`, `--help me`) reaches the model as written. agy
 * compares the whole argument, so a trailing newline is enough to keep it a prompt.
 */
const AGY_FLAG_LIKE_PROMPT_RE = /^-\S*$/;

/**
 * Check a `jsonSchema` the way agy will, so a schema it would refuse fails
 * `start()` once instead of every turn. agy takes a value starting with `{` as
 * inline JSON and anything else as a file path, and exits 1 at startup unless
 * the root is an object with `"type": "object"`. Returns the value to pass:
 * inline JSON as given, a file as its absolute path, since agy resolves a
 * relative one against its own working directory.
 */
function agyJsonSchemaArg(schema: string, cwd: string): string {
  const trimmed = schema.trim();
  const inline = trimmed.startsWith('{');
  const file = inline ? undefined : path.resolve(cwd, trimmed);
  let text: string;
  try {
    text = inline ? trimmed : fs.readFileSync(file!, 'utf8');
  } catch {
    throw new Error(`agy jsonSchema: cannot read the schema file ${file}`);
  }
  // The parse error is not repeated: it can quote the start of the file.
  const refused = new Error(
    'agy jsonSchema must be a JSON object whose root has "type": "object", inline or in a file',
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw refused;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw refused;
  if ((parsed as { type?: unknown }).type !== 'object') throw refused;
  return file ?? trimmed;
}

/**
 * agy's own `--print-timeout` for a send timeout. agy 1.2.9+ holds a headless
 * run open until this deadline while a background task the agent started (a
 * dev server, a watcher) is still running, and prints the reply only when it
 * exits. It must therefore expire before the wrapper's timer: agy then ends the
 * background tasks and delivers the reply. The other order killed the process
 * and failed a finished turn as a timeout. SIGTERM is no substitute: agy answers
 * it with an empty `interrupted` error and leaves the background task running.
 */
function agyPrintTimeoutSec(timeoutMs: number): number {
  const marginMs = Math.min(10_000, Math.floor(timeoutMs / 10));
  return Math.max(1, Math.floor((timeoutMs - marginMs) / 1000));
}

// ─── PersistentAgySession ───────────────────────────────────────────────────

export class PersistentAgySession extends BaseOneShotSession {
  /**
   * Antigravity conversation ID for this session. Captured from the agy log
   * file after the first turn, then reused via `--conversation <id>` so the
   * model sees prior turns. Seeded from `resumeSessionId` when provided.
   */
  private agyConversationId: string | undefined;

  /** The checked `--json-schema` value, set by start(). */
  private _jsonSchemaArg: string | undefined;

  constructor(config: SessionConfig, agyBin?: string) {
    super(config, agyBin || process.env.AGY_BIN || 'agy', {
      enginePrefix: 'agy',
      // 3.8 because 1.1.25 stopped serving 3.5: `--model gemini-3.5-flash`
      // returns `status: ERROR` with an empty response and nothing on stderr,
      // while 3.7 and 3.8 complete normally — measured, not inferred. This
      // wrapper always passes `--model`, so whatever sits here is what actually
      // runs; and agy's stream-json carries no model field at all, so its own
      // default cannot be read back and adopted. Re-check `agy models` when
      // the next tier appears.
      defaultModel: 'gemini-3.8-flash',
      // agy's `input_tokens` leaves out `cache_read_tokens` (the prompt is their
      // sum), so cache reads are counted and priced on their own; before, they
      // were dropped from the cost altogether.
      supportsCachedTokens: true,
      inputIncludesCachedTokens: false,
      engineDisplayName: 'Antigravity',
    });
    // Non-UUID ids (synthetic session ids from persistence/restart paths) are
    // ignored: starting a fresh conversation beats resuming a broken one.
    if (isAgyConversationId(config.resumeSessionId)) {
      this.agyConversationId = config.resumeSessionId;
    }
  }

  /** Expose the captured conversation ID for resume tooling and stats overlay. */
  get conversationId(): string | undefined {
    return this.agyConversationId;
  }

  override async start(): Promise<this> {
    if (this.options.jsonSchema !== undefined) {
      this._jsonSchemaArg = agyJsonSchemaArg(this.options.jsonSchema, path.resolve(this.options.cwd || '.'));
    }
    return super.start();
  }

  protected override _continuesConversation(): boolean {
    return !!this.agyConversationId;
  }

  /**
   * One log file per session (agy re-creates it each run; the harvest regex
   * only needs the latest `Created conversation` line). Deterministic path so
   * stop() can clean it up.
   */
  private get _logFile(): string {
    return path.join(os.tmpdir(), `agy-${this.sessionId}.log`);
  }

  /**
   * Build the agy spawn args for this turn.
   *
   * First turn:    `agy -p <msg> --log-file <tmp> [--mode M|--sandbox|--dangerously-skip-permissions] [--model M] [--effort E] [--settings S] [--json-schema J] [--add-dir D]... [--agent A] [--disable-slash-commands] --print-timeout Ns`
   * Resume turns:  same + `--conversation <id>`
   *
   * Every session-level flag goes on every turn: each turn is a new process.
   */
  private _buildArgs(message: string, timeoutMs: number, turnEffort?: EffortLevel): string[] {
    // stream-json gives the conversation id up front, progress events while the
    // turn runs, and a final `result` carrying the answer plus real token usage.
    // Before this, the wrapper read plain text, scraped the id out of the log
    // file, and had to ESTIMATE tokens — so this engine's cost was a guess.
    // --log-file is still passed as the fallback id source for a turn that dies
    // before emitting any event.
    const prompt = AGY_FLAG_LIKE_PROMPT_RE.test(message) ? `${message}\n` : message;
    const args: string[] = ['-p', prompt, '--output-format', 'stream-json', '--log-file', this._logFile];

    // Permission mode, always named rather than left to agy's own default: agy
    // 1.5.7 moved that default to Auto, where an LLM reviewer lets commands run
    // that the session was not given. Measured on 1.5.9: with `--sandbox` alone a
    // headless run wrote outside its workspace; with `agentMode: ""` (agy's
    // Default mode, set through --settings because --mode has no value for it)
    // every command that needs permission is refused, as headless mode cannot
    // ask. bypassPermissions stays the SessionConfig default for headless work.
    const mode = this.options.permissionMode;
    let agentMode: string | undefined;
    if (this.options.sandboxMode === 'read-only') {
      args.push('--mode', 'plan');
    } else if (mode === 'bypassPermissions' || this.options.dangerouslySkipPermissions) {
      args.push('--dangerously-skip-permissions');
    } else if (mode === 'plan') {
      args.push('--mode', 'plan');
    } else if (mode === 'acceptEdits') {
      args.push('--mode', 'accept-edits');
    } else if (mode === 'auto') {
      args.push('--mode', 'auto');
    } else if (mode === 'default' || mode === 'manual' || mode === 'dontAsk') {
      args.push('--sandbox');
      agentMode = '';
    }

    // Use the SessionManager-resolved model when available so documented
    // aliases (agy-pro → gemini-4-argon) do not silently fall back to agy's
    // default model.
    // agy 1.1.5+ exposes reasoning variants through --effort. Its tiers are
    // narrower than the engine-agnostic EffortLevel union and differ by model:
    // low|medium|high everywhere, and xhigh on gemini-4-hydrogen (agy 1.5.9)
    // and gemini-4-neon (1.5.12); agy refuses `gemini-4-argon --effort xhigh`,
    // naming the tiers it has. The sweep compares this list with `agy models`.
    // Preserve the caller's intent by clamping everything above a model's top
    // tier to that tier. A per-turn override wins over the session default,
    // matching session_send's documented contract.
    //
    // Current agy also requires an effort when --model is an unsuffixed base
    // slug, so the provider-specific meaning of auto is high in that case. A
    // fully-qualified `-low|-medium|-high|-xhigh` slug already carries its
    // effort and needs no flag. If a caller overrides such a slug to a different
    // effort, strip the suffix first: agy rejects conflicting --model/--effort pairs.
    const configuredModel = this.options.resolvedModel || this.options.model;
    let model = configuredModel ? this.resolveModel(configuredModel.replace(/^agy\//, '')) : undefined;
    const requestedEffort = turnEffort ?? this.options.effort;
    const topTier = model && AGY_XHIGH_MODELS.test(model) ? 'xhigh' : 'high';
    const explicitEffort =
      requestedEffort === 'max' || requestedEffort === 'xhigh' || requestedEffort === 'ultra'
        ? topTier
        : requestedEffort === 'auto'
          ? undefined
          : requestedEffort;
    const modelEffortMatch = model?.match(/-(low|medium|high|xhigh)$/);
    if (model && modelEffortMatch && explicitEffort && modelEffortMatch[1] !== explicitEffort) {
      model = model.slice(0, -modelEffortMatch[0].length);
    }
    const effort = explicitEffort ?? (model && !modelEffortMatch ? 'high' : undefined);

    if (model) args.push('--model', model);
    if (effort) args.push('--effort', effort);

    if (this.agyConversationId) args.push('--conversation', this.agyConversationId);

    // agy 1.4.12 takes the same `settings` value as Claude Code: inline JSON or a
    // file path, applied to this run only and never saved.
    const settings = this._settingsArg(agentMode);
    if (settings) args.push('--settings', settings);

    // agy enforces the schema on the turn's final result.
    if (this._jsonSchemaArg) args.push('--json-schema', this._jsonSchemaArg);
    for (const dir of this.options.addDir ?? []) args.push('--add-dir', dir);
    // An unknown name ends the run before any model turn with a result error
    // listing the agents there are, which the turn surfaces like any other.
    if (this.options.agent) args.push('--agent', this.options.agent);
    // Without it a message starting with `/` that names a skill or command is
    // read as one (agy 1.1.9+): a skill is expanded, a read-only command such as
    // `/help` answers without a model turn, and an interactive-only one such as
    // `/clear` fails with a result error. An absolute path names neither and
    // reaches the model as written (measured on 1.5.13).
    if (this.options.disableSlashCommands) args.push('--disable-slash-commands');

    // 1.2.6 changed the default for a headless run from 5 minutes to unlimited,
    // so passing this is also what keeps a stuck turn from running forever.
    args.push('--print-timeout', `${agyPrintTimeoutSec(timeoutMs)}s`);

    return args;
  }

  /**
   * The `--settings` value for this run. agy reads only the last `--settings`
   * it is given (a second one replaces the first, measured on 1.5.9), so a mode
   * the permission mode needs is merged into the caller's settings, not passed
   * beside them. Settings that cannot be read as a JSON object fail the turn:
   * running without the mode would quietly widen what the session may do.
   */
  private _settingsArg(agentMode: string | undefined): string | undefined {
    const given = this.options.settings;
    if (agentMode === undefined) return given;
    let base: Record<string, unknown> = {};
    if (given) {
      const trimmed = given.trim();
      // The reason is not repeated: a JSON parse error quotes the text it read,
      // which for a file path is the start of whatever file it names.
      const refused = new Error(
        `agy settings must be a JSON object, inline or in a file, for permissionMode '${this.options.permissionMode}'`,
      );
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed.startsWith('{') ? trimmed : fs.readFileSync(trimmed, 'utf8'));
      } catch {
        throw refused;
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw refused;
      base = parsed as Record<string, unknown>;
    }
    return JSON.stringify({ ...base, agentMode });
  }

  /**
   * Harvest the conversation ID from the agy log file. New conversations log
   * `Created conversation <uuid>`; resumed ones only log lookups, so an
   * existing ID is never overwritten by a miss.
   */
  private _harvestConversationId(log: string | undefined): void {
    // Once harvested (or seeded) the ID is final for the life of the session
    // — skip the fallback match on every later turn.
    if (this.agyConversationId) return;
    if (log) {
      this.agyConversationId = extractCreatedAgyConversationId(log);
    }
    if (!this.agyConversationId) {
      // Without an ID every later send silently starts a fresh conversation.
      // Make that observable — if this fires on every turn, agy most likely
      // reworded its log line and the harvest regex needs updating.
      this._warnHarvestMiss();
    }
  }

  private _warnHarvestMiss(): void {
    if (this._stats.turns !== 0) return;
    this.emit(
      SESSION_EVENT.LOG,
      '[agy] no conversation ID found in log after turn — resume unavailable; the next send starts a fresh conversation',
    );
  }

  protected _run(message: string, options: SessionSendOptions): Promise<TurnResult> {
    const timeout = options.timeout || 300_000;
    const args = this._buildArgs(message, timeout, options.effort);

    // The path is stable for the session, so remove the previous turn's file
    // before spawning. If that cannot be proven, do not inspect the file at all:
    // a stale denial must never be attributed to the current empty response.
    let mayReadTurnLog = true;
    try {
      fs.unlinkSync(this._logFile);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') mayReadTurnLog = false;
    }

    return new Promise<TurnResult>((resolve, reject) => {
      let resultText = '';
      let stderr = '';
      let settled = false;
      let turnUsage: AgyUsage | undefined;
      // Prompt of the turn's latest request. `result.usage` sums every request
      // of the turn, so it is the turn's spend, not the context's size.
      let lastRequestPrompt = 0;
      let turnStatus: string | undefined;
      // agy reports a rejected invocation (bad model/effort pair, unknown slug)
      // as a stream-json result event carrying `error`, and prints nothing on
      // stderr. Without capturing it the caller only ever saw "Antigravity
      // exited with code 1" — agy's own message names the valid values.
      let turnError: string | undefined;
      // Why agy ended the turn early, from the result (1.4.11+). `print_timeout`
      // is kept once seen, like a failure status.
      let finishedReason: string | undefined;
      let structuredOutput: unknown;
      // Tool steps already counted this turn, by conversation and step index:
      // agy reports a tool step when it starts and again when it is done.
      const toolSteps = new Set<string>();

      const startedAt = Date.now();
      const proc = spawnEngine(this.engineBin, args, {
        launcher: this.options.launcher,
        cwd: this.options.cwd,
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      this.currentProc = proc;

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          // Kill the whole process tree (on Windows `kill` would leave agy's own
          // children running), but keep the conversation id: a turn killed by
          // the timeout does not end the conversation, and the next send with the
          // same `--conversation` still recalls what came before (verified on
          // agy 1.2.4). Dropping the id would cost an agy Planner its whole chat.
          this._cleanupProc();
          reject(new Error('Timeout waiting for Antigravity response'));
        }
      }, timeout);

      // stream-json stdout: one JSON object per line. `init` carries the
      // conversation id, `step_update` reports progress, and the final `result`
      // carries the answer plus real usage. Anything unparseable is forwarded as
      // text so a format change degrades to the old plain-text behaviour instead
      // of losing the turn.
      let pending = '';
      const handleLine = (line: string, hadNewline: boolean) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let evt: AgyStreamEvent | undefined;
        if (trimmed.startsWith('{')) {
          try {
            evt = JSON.parse(trimmed) as AgyStreamEvent;
          } catch {
            evt = undefined;
          }
        }
        if (!evt) {
          // Not JSON — agy fell back to (or never left) plain text. Put back the
          // newline the line split consumed, so multi-line output is not
          // concatenated into a single run.
          const raw = hadNewline ? line + '\n' : line;
          resultText += raw;
          try {
            options.callbacks?.onText?.(raw);
          } catch {
            /* user callback */
          }
          this.emit(SESSION_EVENT.TEXT, raw);
          return;
        }
        if (evt.event === 'init' && evt.conversation_id && !this.agyConversationId) {
          this.agyConversationId = evt.conversation_id;
        }
        const step = evt.event === 'step_update' ? evt.step_update : undefined;
        if (step?.step_type === 'agent_response' && step.usage) {
          // A subagent's steps belong to a conversation of its own.
          const own =
            !step.conversation_id || !this.agyConversationId || step.conversation_id === this.agyConversationId;
          // `input_tokens` leaves the cached reads out; the prompt is both.
          const prompt = (step.usage.input_tokens ?? 0) + (step.usage.cache_read_tokens ?? 0);
          if (own && prompt > 0) lastRequestPrompt = prompt;
        }
        // A tool call, or a delegation to a subagent, including the tool steps
        // a subagent streams from its own conversation.
        if (step && (step.tool_info || step.subagent_info)) {
          const key = step.step_index === undefined ? undefined : `${step.conversation_id ?? ''}#${step.step_index}`;
          if (key ? !toolSteps.has(key) : step.state !== 'ACTIVE') {
            if (key) toolSteps.add(key);
            this._stats.toolCalls++;
          }
        }
        if (evt.event === 'result' && evt.result) {
          const r = evt.result;
          if (r.conversation_id && !this.agyConversationId) this.agyConversationId = r.conversation_id;
          if (r.structured_output !== undefined && r.structured_output !== null) structuredOutput = r.structured_output;
          // `response` carries the structured result as JSON text too; should it
          // come back empty, the structured value is the reply, not a failure.
          const reply =
            typeof r.response === 'string' && r.response.trim()
              ? r.response
              : structuredOutput !== undefined
                ? JSON.stringify(structuredOutput)
                : r.response;
          if (typeof reply === 'string') {
            resultText = reply;
            try {
              options.callbacks?.onText?.(reply);
            } catch {
              /* user callback */
            }
            this.emit(SESSION_EVENT.TEXT, reply);
          }
          if (r.usage) turnUsage = r.usage;
          // Only a non-SUCCESS status is recorded, and it is sticky on purpose: a later
          // SUCCESS in the same turn must not erase a failure agy already reported.
          if (r.status && r.status !== 'SUCCESS') turnStatus = r.status;
          if (typeof r.error === 'string' && r.error.trim()) turnError = sanitizeSecrets(r.error.trim());
          if (r.finished_reason && finishedReason !== 'print_timeout') finishedReason = r.finished_reason;
        }
      };
      proc.stdout?.on('data', (data: Buffer) => {
        pending += data.toString();
        const lines = pending.split('\n');
        pending = lines.pop() ?? '';
        for (const line of lines) handleLine(line, true);
      });

      proc.stderr?.on('data', (data: Buffer) => {
        const sanitized = sanitizeSecrets(data.toString());
        stderr += sanitized;
        this.emit(SESSION_EVENT.LOG, `[agy-stderr] ${sanitized}`);
      });

      proc.on('close', (code) => {
        clearTimeout(timer);
        this.currentProc = null;
        if (pending) handleLine(pending, false);

        const text = resultText.replace(/\n$/, '');
        const emptyResponse = text.trim().length === 0;
        let turnLog: string | undefined;
        const needsLog = !this.agyConversationId || (!settled && code === 0 && !turnError);
        if (mayReadTurnLog && needsLog) {
          try {
            turnLog = fs.readFileSync(this._logFile, 'utf8');
          } catch {
            // Log file missing — agy failed before logging anything.
          }
        }

        // Harvest BEFORE the settled check: a turn that hit the wrapper timeout
        // has already rejected (settled), but agy may still have announced the
        // conversation before being killed. Skipping this would lose the id
        // permanently and every later send would silently start fresh. The
        // stream normally supplies it from the `init` event; this is the
        // fallback for a turn that died before emitting one.
        this._harvestConversationId(turnLog);

        if (settled) return;
        settled = true;

        // One expression for the outcome feeds both the counter and `stop_reason`.
        // A non-SUCCESS status with a partial reply still resolves below so callers do
        // not lose useful output, but it deliberately remains a failed ledger turn.
        // Reached agy's deadline while still working: a partial reply is not an
        // answer. agy's `finished_reason` decides when the result carries one; the
        // stderr line, and elapsed time should agy reword it, decide otherwise.
        const hitDeadline =
          finishedReason !== undefined
            ? finishedReason === 'print_timeout'
            : AGY_DEADLINE_IN_PROGRESS_RE.test(stderr) ||
              (!AGY_IDLE_WAIT_RE.test(stderr) && Date.now() - startedAt >= agyPrintTimeoutSec(timeout) * 1000);
        // Any finished_reason means the turn ended early, whatever the status says.
        const ok = !hitDeadline && !finishedReason && !turnError && !turnStatus && code === 0 && !emptyResponse;
        this._recordTurnComplete(ok);

        // Real usage from the `result` event. estimateTokens() is the fallback
        // for a turn that produced no result event (killed, crashed, or an
        // output-format change) — it is a ~4-chars-per-token guess and was the
        // only source before agy grew a structured output mode, which is why
        // this engine's cost figures used to be approximate.
        if (turnUsage) {
          this._stats.tokensIn += turnUsage.input_tokens ?? 0;
          this._stats.tokensOut += turnUsage.output_tokens ?? 0;
          this._stats.cachedTokens += turnUsage.cache_read_tokens ?? 0;
          this._updateCost();
        } else if (text.length > 0 || code === 0) {
          this._stats.tokensIn += estimateTokens(message);
          this._stats.tokensOut += estimateTokens(text);
          this._markTurnEstimated();
          this._updateCost();
        }
        if (lastRequestPrompt > 0) this._reportTurnInputTokens(lastRequestPrompt);

        this._addHistory({ text, code });

        const permissionDenials = extractAgyToolPermissionDenials(turnLog ?? '');
        const event: StreamEvent = {
          type: 'result',
          result: text,
          // agy can exit 0 while reporting a non-SUCCESS status, an error, or no
          // usable response, so all terminal signals participate in the verdict.
          stop_reason: ok ? 'end_turn' : 'error',
          ...(structuredOutput !== undefined ? { structured_output: structuredOutput } : {}),
          ...(permissionDenials.length > 0
            ? { permission_denials: permissionDenials.map((tool_name) => ({ tool_name })) }
            : {}),
        };

        this.emit(SESSION_EVENT.RESULT, event);
        this.emit(SESSION_EVENT.TURN_COMPLETE, event);

        // A captured result error means the turn failed even when agy exits 0,
        // so surface it rather than resolving an empty string as a reply.
        if (hitDeadline) {
          reject(new Error('Timeout waiting for Antigravity response'));
        } else if (turnError) {
          reject(new Error(turnError));
        } else if (code !== 0) {
          reject(new Error(stderr || `Antigravity exited with code ${code}`));
        } else if (emptyResponse) {
          const echoableDenials = permissionDenials.filter((name) => AGY_ECHOABLE_TOOL_NAME_RE.test(name));
          const emptyResponseError =
            echoableDenials.length > 0
              ? `Antigravity returned an empty response after denying tool confirmation for ${echoableDenials.map((name) => `"${name}"`).join(', ')}; the turn failed but the session remains available for retry`
              : hasAgyToolPermissionDenial(turnLog ?? '')
                ? TOOL_DENIAL_EMPTY_RESPONSE_ERROR
                : EMPTY_RESPONSE_ERROR;
          reject(new Error(emptyResponseError));
        } else {
          resolve({ text, event });
        }
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

  // ── Pricing ────────────────────────────────────────────────

  /**
   * An effort-qualified slug (`gemini-4-argon-high`) is priced as the base
   * model it qualifies. Looked up verbatim it is unknown, and fell back to
   * the Flash default: a Pro turn billed at Flash rates.
   */
  private _baseModel(model: string | undefined): string | undefined {
    return model?.replace(/-(low|medium|high|xhigh)$/, '');
  }

  protected override _getModelPricing() {
    return getModelPricing(this._baseModel(this.options.model), this.engineCfg.defaultModel);
  }

  /** Clean up the per-session log file along with the base teardown. */
  stop(): void {
    super.stop();
    try {
      fs.unlinkSync(this._logFile);
    } catch {
      // Never created, or already gone
    }
  }

  /** Override getStats to expose the captured conversation ID. */
  getStats(): ReturnType<BaseOneShotSession['getStats']> {
    const base = super.getStats();
    return { ...base, agyConversationId: this.agyConversationId };
  }
}
