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
 *   - Real usage: input/output/cache-read tokens come from the stream — each
 *     request's own step, since the `result` reports the conversation's running
 *     total (see `_turnUsage`) — so cost is measured rather than guessed. A
 *     ~4 chars/token estimate is only the fallback for a turn that reported none.
 *
 * Print-mode slash commands, a native `/goal` loop, `/compact`, `/plan`, the
 * quota and the spend of the agents a turn starts are documented where they are
 * handled below, and in skills/references/multi-engine.md.
 *   - Timeout coherence: we derive --print-timeout from the send timeout so the
 *     two never disagree. Since 1.2.6 a headless run has no default timeout at
 *     all unless that flag is passed, so it is now the only bound there is.
 *
 * Unknown --model values are NOT reliably harmless. On 1.0.16 an unknown slug
 * fell back to the default silently; on 1.1.25 a slug agy has stopped serving
 * (gemini-3.5-flash) returns `status: ERROR` with an empty response and
 * nothing on stderr. Treat a wrong model as a failed turn, not a quiet swap.
 */

import { killEngineTree, spawnEngine } from './engine-spawn.js';
import type { ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type {
  CommandOutcome,
  CompactOutcome,
  EffortLevel,
  EngineCommand,
  ModelPricing,
  SessionConfig,
  SessionSendOptions,
  StreamCallbacks,
  StreamEvent,
  TurnResult,
} from './types.js';
import { estimateTokens, getModelPricing } from './models.js';
import { sanitizeSecrets } from './sanitize.js';
import {
  extractCreatedAgyConversationId,
  extractAgyToolPermissionDenials,
  hasAgyToolPermissionDenial,
  isAgyConversationId,
} from './agy-conversation.js';
import {
  AGY_INFO_COMMAND_NAMES,
  AGY_SYSTEM_COMMANDS,
  agyCommandPrompt,
  agyInfoCommands,
  agyLeadingCommand,
  agySkillCommands,
} from './agy-commands.js';
import {
  AgyMemberSpend,
  agyBrainDir,
  agyBrainDirOf,
  agyTranscriptPath,
  priceAgyRequests,
  readAgyTranscript,
  type AgySpend,
} from './agy-transcripts.js';
import { runAgyInfoCommand } from './agy-quota.js';
import { AGY_TURN_USAGE_EVENT, AgyGoalSession, type AgyGoalHost } from './agy-goal-session.js';
import type { ClaudeGoalOpen } from './claude-goal-session.js';
import type { GoalSession } from './kernel/nodes/goal.js';
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

/** An info command's structured answer (`command_result`, and `result.command`; 1.5.x). */
interface AgyCommandAnswer {
  name?: string;
  data?: unknown;
}

/** One line of agy `--output-format stream-json`. Captured from agy 1.1.13; fields added through 1.5.19. */
interface AgyStreamEvent {
  event?: string;
  conversation_id?: string;
  /** On `init`: the model the run is on, and each command or skill a leading `/word` expanded to. */
  init?: { model?: string; expanded_commands?: Array<{ name?: string; type?: string }> };
  /** On `command_result`: an info command's answer; no `init` precedes it and no turn runs. */
  command?: AgyCommandAnswer;
  /** Progress of one step; an `agent_response` step carries its own request's usage (agy 1.5.3). */
  step_update?: {
    conversation_id?: string;
    /** Position in its conversation; a tool step is reported ACTIVE, then DONE, at the same index (1.5.13). */
    step_index?: number;
    state?: string;
    /** `agent_response`, `tool`, `subagent`, `checkpoint` (a compaction's summary pass), `system_message`, … */
    step_type?: string;
    tool_name?: string;
    usage?: AgyUsage;
    /** Present on every step that calls a tool: `{ name, parameters, output }`. */
    tool_info?: unknown;
    /** Present on a step that delegates to a subagent: `{ subagents: [{ conversation_id, log_uri, ... }] }`. */
    subagent_info?: unknown;
  };
  result?: {
    conversation_id?: string;
    status?: string;
    response?: string;
    error?: string;
    usage?: AgyUsage;
    /** Model requests of the turn; 0 for an answer agy gave without one. */
    num_turns?: number;
    /** Why the turn ended early (agy 1.4.11+): `print_timeout`, `interrupted` or `error`; absent when it finished. */
    finished_reason?: string;
    /** The value `--json-schema` asked for; `response` carries it as JSON text too (1.5.13). */
    structured_output?: unknown;
    /** An info command's answer, as on `command_result`. */
    command?: AgyCommandAnswer;
    /** Tools refused in a headless run: `[{ action, display_name }]`. */
    denied_actions?: Array<{ action?: string; display_name?: string }>;
  };
}

/** Options a turn of this wrapper takes beyond `SessionSendOptions`. */
interface AgyTurnOptions extends SessionSendOptions {
  /** Read a leading `/word` as agy's command on this turn, whatever `disableSlashCommands` says. */
  agyCommands?: boolean;
  /** The turn is a `/compact`: judged by its summary pass, and not counted as a turn. */
  agyCompact?: boolean;
}

/**
 * agy's orchestrator models (`gemini-pro-orchestrator`, `-neon`, `-argon`): two
 * phases, planner and executor, each on a model of agy's choosing. They take no
 * `--effort` (agy refuses one: "--effort is not supported for model …").
 */
export const AGY_ORCHESTRATOR_MODELS = /^gemini-pro-orchestrator(?:-[a-z]+)?$/;

/** Tools through which a turn starts agents of its own, whose spend is not in the turn's usage. */
const AGY_MEMBER_TOOLS: ReadonlySet<string> = new Set([
  'invoke_subagent',
  'define_subagent',
  'browser_subagent',
  'swarm',
  'run_workflow',
]);
/** Commands and skills that start such agents. */
const AGY_MEMBER_COMMANDS: ReadonlySet<string> = new Set(['teamwork', 'swarm', 'run-workflow', 'boost', 'browser']);

/** A plan `/plan` writes into agy's own folder for the conversation (`plan.md`, `implementation_plan.md`). */
const AGY_PLAN_FILE_RE = /(?:^|[\\/])[\w.-]*plan[\w.-]*\.md$/i;

/** The commands a session lists are read again after this long (skills come and go). */
const COMMANDS_TTL_MS = 10 * 60_000;

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

/**
 * Sent ahead of every turn of a read-only session. Read-only runs in agy's plan
 * mode, where a headless run refuses shell commands and file edits; measured on
 * agy 1.5.16, a refused tool then ends the turn with no reply at all ("no output
 * produced"), so an agent that reached for `cat` or `rg` while reviewing a
 * codebase returned nothing. Its own file tools still read. Allowing commands
 * instead is not read-only: `command(*)` also approves a command's request to
 * run outside the terminal sandbox (`BypassSandbox`), which then wrote to the
 * workspace, the home directory and git.
 */
/** Continuations a read-only turn gets after a refused tool ended it empty. */
export const AGY_READ_ONLY_CONTINUATIONS = 2;

export const AGY_READ_ONLY_NOTE =
  'This session is read-only: shell commands and file edits are refused, and a refused tool ends your turn with no ' +
  'answer. Read with your file tools (view_file, grep_search, list_dir, find_by_name) and give your answer as text.';

/** The smallest compaction window accepted, as on Claude Code: below it a turn has too little room to run. */
const MIN_AGY_AUTOCOMPACT_WINDOW = 100_000;

/**
 * `autoCompactWindow` → `AGY_CLI_AUTO_COMPACT_OVERRIDE` (agy 1.5.15+): the token
 * count at which agy compacts the conversation. Measured on 1.5.16 in print
 * mode: a window of 110000 compacted a conversation of two 65K-token messages
 * on the second turn (a summary pass of ~27K input and ~600 output tokens), and
 * one below the size of the message itself failed the turn
 * (`maxMessageTokens must be positive`). `auto` leaves agy's own default.
 */
export function agyAutoCompactEnv(window: SessionConfig['autoCompactWindow']): Record<string, string> {
  if (window == null || window === 'auto') return {};
  if (!Number.isInteger(window) || window < MIN_AGY_AUTOCOMPACT_WINDOW) {
    throw new Error(
      `autoCompactWindow must be 'auto' or a whole token count of at least ${MIN_AGY_AUTOCOMPACT_WINDOW} (got ${JSON.stringify(window)})`,
    );
  }
  return { AGY_CLI_AUTO_COMPACT_OVERRIDE: String(window) };
}

/**
 * Put `text` in front of `message` without hiding the command the message starts
 * with: agy reads a command only at the very start of `-p`. The text goes after
 * the command (and a bracketed directive such as `[skip-interview]`), as part of
 * what the command acts on. An info command takes no arguments, and a command
 * with nothing after it (`/compact`) has nothing to act on, so both are left as
 * they are.
 */
export function agyPrefixPrompt(message: string, text: string, commands: boolean): string {
  const lead = commands ? agyLeadingCommand(message) : undefined;
  if (!lead) return `${text}\n\n${message}`;
  if (AGY_INFO_COMMAND_NAMES.has(lead)) return message;
  const m = /^\s*(\/\S+(?:[ \t]+\[[^\]\n]*\])?)[ \t]*\n*([\s\S]*)$/.exec(message);
  if (!m || !m[2].trim()) return message;
  return `${m[1]} ${text}\n\n${m[2]}`;
}

export class PersistentAgySession extends BaseOneShotSession {
  /** A message starting with `/word` is a command on agy (unless `disableSlashCommands`). */
  readonly commandStyle = 'text' as const;

  /** Each turn is its own process, so a turn takes its own `--model`. */
  readonly perSendModel = true;

  /** The model agy reported on the last turn's `init` event. */
  private _reportedModel: string | undefined;

  /** The conversation's running usage, as the last `result` reported it. */
  private _conversationUsage: AgyUsage | undefined;

  /**
   * The smallest request prompt seen: close to what every request carries
   * whatever the history (system prompt, tools, the first message).
   */
  private _smallestPrompt: number | undefined;

  /** Spend of the agents the session's turns started (`/teamwork`, `/swarm`, `/run-workflow`, subagents). */
  private readonly _members: AgyMemberSpend;

  /** The commands `listCommands` read, and when. */
  private _commands: { at: number; list: EngineCommand[] } | undefined;

  /** Info-command processes, run beside the turns; stop() ends them. */
  private readonly _infoProcs = new Set<ChildProcess>();

  /** Set only while `send()` builds its message for a turn that reads agy's commands whatever the session says. */
  private _commandsForced = false;

  private readonly _warned = new Set<string>();

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
      // while 3.7 and 3.8 complete normally — measured, not inferred. This is
      // the price of a turn whose model is unknown: a session that names no
      // model runs on agy's own default, which the `init` event reports and the
      // turn is billed at (see `_pricing`). Re-check `agy models` when the next
      // tier appears.
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
    // Refused at start, not at the first turn.
    agyAutoCompactEnv(config.autoCompactWindow);
    if (config.turnCommand?.trim() && config.disableSlashCommands) {
      throw new Error('turnCommand needs agy to read slash commands, which disableSlashCommands turns off');
    }
    if (isAgyConversationId(config.resumeSessionId)) {
      this.agyConversationId = config.resumeSessionId;
    }
    this._members = new AgyMemberSpend(this.engineCfg.defaultModel, (m) => this.emit(SESSION_EVENT.LOG, m));
  }

  /** Log `message` once per session under `key`. */
  private _warnOnce(key: string, message: string): void {
    if (this._warned.has(key)) return;
    this._warned.add(key);
    this.emit(SESSION_EVENT.LOG, message);
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

  /** `appendSystemPrompt` on the first message, kept behind the command the message starts with. */
  protected override _withAppendedInstructions(message: string): string {
    const instructions = this.options.appendSystemPrompt?.trim();
    if (!instructions || this._continuesConversation()) return message;
    return agyPrefixPrompt(
      message,
      `${instructions}\n\n---`,
      this._commandsForced || !this.options.disableSlashCommands,
    );
  }

  /** `send()` for a turn that reads a leading `/word` as agy's command, whatever the session's setting. */
  private _sendCommandTurn(message: string, options: AgyTurnOptions): Promise<TurnResult> {
    this._commandsForced = true;
    try {
      return this.send(message, {
        ...options,
        waitForComplete: true,
        agyCommands: true,
      } as AgyTurnOptions) as Promise<TurnResult>;
    } finally {
      this._commandsForced = false;
    }
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
  /** Whether this turn reads a leading `/word` as agy's command. */
  private _readsCommands(turn: AgyTurnOptions): boolean {
    return !!turn.agyCommands || !!turn.plan || !this.options.disableSlashCommands;
  }

  /** The `-p` text of a turn: the message, as `/plan` asks for it, with the read-only note. */
  private _turnPrompt(message: string, turn: AgyTurnOptions): string {
    const commands = this._readsCommands(turn);
    const planned = turn.plan && agyLeadingCommand(message) !== 'plan' ? `/plan ${message}` : message;
    return this.options.sandboxMode === 'read-only' ? agyPrefixPrompt(planned, AGY_READ_ONLY_NOTE, commands) : planned;
  }

  /** The model a turn runs on: this send's, or the session's (aliases resolved, `agy/` dropped). */
  private _turnModel(turn: AgyTurnOptions): string | undefined {
    const configured = turn.model || this.options.resolvedModel || this.options.model;
    return configured ? this.resolveModel(configured.replace(/^agy\//, '')) : undefined;
  }

  private _buildArgs(text: string, timeoutMs: number, turn: AgyTurnOptions = {}): string[] {
    // stream-json gives the conversation id up front, progress events while the
    // turn runs, and a final `result` carrying the answer plus real token usage.
    // Before this, the wrapper read plain text, scraped the id out of the log
    // file, and had to ESTIMATE tokens — so this engine's cost was a guess.
    // --log-file is still passed as the fallback id source for a turn that dies
    // before emitting any event.
    const prompt = AGY_FLAG_LIKE_PROMPT_RE.test(text) ? `${text}\n` : text;
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
    let model = this._turnModel(turn);
    const requestedEffort = turn.effort ?? this.options.effort;
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
    let effort = explicitEffort ?? (model && !modelEffortMatch ? 'high' : undefined);
    if (model && AGY_ORCHESTRATOR_MODELS.test(model)) {
      if (explicitEffort) {
        this._warnOnce(
          'orchestrator-effort',
          `[agy] ${model} takes no reasoning effort; effort '${requestedEffort}' is not passed`,
        );
      }
      effort = undefined;
    }

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
    if (!this._readsCommands(turn)) args.push('--disable-slash-commands');

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

  /**
   * One turn, continued when a read-only session's turn ended on a refused tool.
   *
   * Plan mode refuses shell commands and edits, and agy then ends the turn with
   * no reply. The conversation is kept, so it is told which tool was refused and
   * continues from where it stopped, with its file tools — at most
   * `AGY_READ_ONLY_CONTINUATIONS` times, within the turn's own timeout.
   */
  protected async _run(message: string, options: AgyTurnOptions): Promise<TurnResult> {
    const deadline = Date.now() + (options.timeout || 300_000);
    let next = message;
    for (let attempt = 0; ; attempt++) {
      try {
        // A continuation is plain text: `/plan` went out with the turn's first message.
        const turn = attempt === 0 ? options : { ...options, plan: false };
        return await this._runOnce(next, { ...turn, timeout: Math.max(1, deadline - Date.now()) });
      } catch (err) {
        const denied = (err as { agyToolDenial?: string[] }).agyToolDenial;
        const room = deadline - Date.now();
        const retry =
          denied !== undefined &&
          this.options.sandboxMode === 'read-only' &&
          !!this.agyConversationId &&
          attempt < AGY_READ_ONLY_CONTINUATIONS &&
          room > 30_000;
        if (!retry) throw err;
        const tools = denied.length ? denied.map((t) => `\`${t}\``).join(', ') : 'the tool you called';
        next =
          `${tools} is refused in this read-only session, and that ended your turn without an answer. Continue the ` +
          'same task from where you stopped, using only view_file, grep_search, list_dir and find_by_name, and give ' +
          'your answer as text.';
      }
    }
  }

  private _runOnce(message: string, options: AgyTurnOptions): Promise<TurnResult> {
    const timeout = options.timeout || 300_000;
    const text = this._turnPrompt(message, options);
    const args = this._buildArgs(text, timeout, options);
    const turnModel = this._turnModel(options);
    // The command this turn's prompt starts with, when agy reads one.
    const commandWord = this._readsCommands(options) ? agyLeadingCommand(text) : undefined;

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
      // Prompt of the turn's latest request: the context's size. `result.usage`
      // sums every request of the conversation (see `_turnUsage`).
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
      // A model turn ran: agy sends `init` first. An info command has none.
      let sawInit = false;
      let expanded: string[] = [];
      let answer: AgyCommandAnswer | undefined;
      let numTurns: number | undefined;
      // The summary pass of a compaction (a `checkpoint` step), with its usage.
      let checkpoint: AgyUsage | undefined;
      let planPath: string | undefined;
      let deniedActions: string[] = [];
      // Agents this turn started (each in a conversation of its own), and where agy keeps them.
      const memberIds = new Set<string>();
      let startsMembers = false;
      let brainDir: string | undefined;
      // This conversation's own requests, summed from their steps: the turn's
      // running usage, and its spend should the process end before `result`.
      const own = { input: 0, output: 0, cache: 0 };
      let firstOwnStep: number | undefined;

      const startedAt = Date.now();
      const proc = spawnEngine(this.engineBin, args, {
        launcher: this.options.launcher,
        cwd: this.options.cwd,
        env: { ...process.env, ...agyAutoCompactEnv(this.options.autoCompactWindow) },
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
        if (evt.event === 'init') {
          sawInit = true;
          if (evt.conversation_id && !this.agyConversationId) this.agyConversationId = evt.conversation_id;
          if (typeof evt.init?.model === 'string' && evt.init.model) this._reportedModel = evt.init.model;
          expanded = (evt.init?.expanded_commands ?? [])
            .map((c) => c?.name)
            .filter((n): n is string => typeof n === 'string');
        }
        if (evt.event === 'command_result' && evt.command) answer = evt.command;
        const step = evt.event === 'step_update' ? evt.step_update : undefined;
        // A subagent's steps belong to a conversation of its own.
        const ownStep =
          !!step &&
          (!step.conversation_id || !this.agyConversationId || step.conversation_id === this.agyConversationId);
        if (step && ownStep && firstOwnStep === undefined && typeof step.step_index === 'number') {
          firstOwnStep = step.step_index;
        }
        if (step && ownStep && step.usage && (step.step_type === 'agent_response' || step.step_type === 'checkpoint')) {
          own.input += step.usage.input_tokens ?? 0;
          own.output += step.usage.output_tokens ?? 0;
          own.cache += step.usage.cache_read_tokens ?? 0;
          if (step.step_type === 'checkpoint') checkpoint = step.usage;
          // `input_tokens` leaves the cached reads out; the prompt is both.
          const prompt = (step.usage.input_tokens ?? 0) + (step.usage.cache_read_tokens ?? 0);
          if (step.step_type === 'agent_response' && prompt > 0) lastRequestPrompt = prompt;
          this.emit(AGY_TURN_USAGE_EVENT, { tokensIn: own.input, tokensOut: own.output });
        }
        // A tool call, or a delegation to a subagent, including the tool steps
        // a subagent streams from its own conversation.
        if (step && (step.tool_info || step.subagent_info)) {
          const key = step.step_index === undefined ? undefined : `${step.conversation_id ?? ''}#${step.step_index}`;
          if (key ? !toolSteps.has(key) : step.state !== 'ACTIVE') {
            if (key) toolSteps.add(key);
            this._stats.toolCalls++;
          }
          const info = step.tool_info as { name?: unknown; parameters?: { Path?: unknown } } | undefined;
          const tool = step.tool_name ?? (typeof info?.name === 'string' ? info.name : undefined);
          if (tool && AGY_MEMBER_TOOLS.has(tool)) startsMembers = true;
          const written = info?.parameters?.Path;
          if (ownStep && tool === 'write_file' && typeof written === 'string' && AGY_PLAN_FILE_RE.test(written)) {
            if (written.includes(`${path.sep}brain${path.sep}`) || written.includes('/brain/')) planPath = written;
          }
          const subagents = (step.subagent_info as { subagents?: unknown } | undefined)?.subagents;
          if (step.subagent_info) startsMembers = true;
          if (Array.isArray(subagents)) {
            for (const a of subagents) {
              const id = (a as { conversation_id?: unknown })?.conversation_id;
              if (typeof id === 'string' && isAgyConversationId(id)) memberIds.add(id);
              const uri = (a as { log_uri?: unknown })?.log_uri;
              if (typeof uri === 'string') brainDir ??= agyBrainDirOf(uri);
            }
          }
        }
        if (evt.event === 'result' && evt.result) {
          const r = evt.result;
          if (r.conversation_id && !this.agyConversationId) this.agyConversationId = r.conversation_id;
          if (r.structured_output !== undefined && r.structured_output !== null) structuredOutput = r.structured_output;
          if (typeof r.num_turns === 'number') numTurns = r.num_turns;
          if (r.command && !answer) answer = r.command;
          if (Array.isArray(r.denied_actions)) {
            deniedActions = r.denied_actions
              .map((d) => d?.display_name)
              .filter((n): n is string => typeof n === 'string' && !!n);
          }
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

        // An answer agy gave without a model turn: an info command, or a command it
        // refused (an interactive-only one, an argument an info command does not
        // take). No conversation, no usage, not a turn: the context figure and the
        // turn counters stay as the last turn left them.
        if (commandWord && !sawInit && (answer !== undefined || numTurns === 0)) {
          if (settled) return;
          settled = true;
          this._stats.lastActivity = new Date().toISOString();
          this._addHistory({ text, code });
          const failure =
            turnError || turnStatus || code !== 0
              ? turnError || stderr.trim() || `/${commandWord} failed (exit ${code})`
              : undefined;
          const command = {
            name: answer?.name ?? commandWord,
            ...(answer?.data !== undefined ? { data: answer.data } : {}),
          };
          const event: StreamEvent = failure
            ? { type: 'result', result: failure, is_error: true, stop_reason: 'error', command }
            : { type: 'result', result: text, stop_reason: 'end_turn', command };
          this.emit(SESSION_EVENT.RESULT, event);
          this.emit(SESSION_EVENT.TURN_COMPLETE, event);
          resolve({ text: failure ?? text, event, localCommand: true });
          return;
        }

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

        // What the turn spent, counted even when the wrapper's timeout already
        // settled it: the process ran and was billed either way.
        const usage = this._turnUsage(own, turnUsage, numTurns);
        if (turnUsage) this._conversationUsage = turnUsage;
        const accountFor = (): void => {
          // Real usage from the stream (see `_turnUsage`). estimateTokens() is the
          // fallback for a turn that produced none (killed early, crashed, or an
          // output-format change) — a ~4-chars-per-token guess, and the only
          // source before agy grew a structured output mode.
          if (usage) {
            this._stats.tokensIn += usage.input_tokens ?? 0;
            this._stats.tokensOut += usage.output_tokens ?? 0;
            this._stats.cachedTokens += usage.cache_read_tokens ?? 0;
            this._stats.costUsd += this._priceTurn(usage, turnModel, firstOwnStep);
          } else if (text.length > 0 || code === 0) {
            const tokensIn = estimateTokens(message);
            const tokensOut = estimateTokens(text);
            this._stats.tokensIn += tokensIn;
            this._stats.tokensOut += tokensOut;
            this._markTurnEstimated();
            this._stats.costUsd += priceTokens(this._pricing(turnModel), tokensIn, 0, tokensOut);
          }
        };

        if (settled) {
          accountFor();
          return;
        }
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
        const compact = !!options.agyCompact;
        // A compaction is judged by its summary pass: its reply is empty by design.
        const compacted =
          compact &&
          !hitDeadline &&
          !finishedReason &&
          !turnError &&
          !turnStatus &&
          code === 0 &&
          (checkpoint !== undefined || expanded.includes('compact'));
        // Any finished_reason means the turn ended early, whatever the status says.
        const ok = compact
          ? compacted
          : !hitDeadline && !finishedReason && !turnError && !turnStatus && code === 0 && !emptyResponse;
        // A compaction is not a turn of the conversation.
        if (compact) this._stats.lastActivity = new Date().toISOString();
        else this._recordTurnComplete(ok);

        accountFor();
        const sizes = compacted && checkpoint ? this._compactSizes(checkpoint) : undefined;
        if (sizes) this._reportTurnInputTokens(sizes.postTokens);
        else if (lastRequestPrompt > 0) {
          this._reportTurnInputTokens(lastRequestPrompt);
          this._smallestPrompt = Math.min(this._smallestPrompt ?? lastRequestPrompt, lastRequestPrompt);
        }

        // The agents the turn started spend outside its usage; their transcripts say what.
        let members: AgySpend | undefined;
        const followsMembers =
          startsMembers ||
          memberIds.size > 0 ||
          expanded.some((c) => AGY_MEMBER_COMMANDS.has(c)) ||
          this._members.members.length > 0;
        if (this.agyConversationId && followsMembers) {
          members = this._members.collect(this.agyConversationId, [...memberIds], brainDir);
          if (members.conversations > 0) {
            this._stats.tokensIn += members.tokensIn;
            this._stats.tokensOut += members.tokensOut;
            this._stats.cachedTokens += members.cachedTokens;
            this._stats.costUsd += members.costUsd;
          }
        }

        this._addHistory({ text, code });

        if (commandWord && sawInit && expanded.length === 0 && !AGY_INFO_COMMAND_NAMES.has(commandWord)) {
          this._warnOnce(
            `unknown:${commandWord}`,
            `[agy] /${commandWord} is not an agy command or skill here; it reached the model as text`,
          );
        }

        // The plan `/plan` wrote, read from agy's folder for the conversation.
        let plan: { path: string; text: string } | undefined;
        if (planPath && (options.plan || expanded.includes('plan'))) {
          try {
            plan = { path: planPath, text: fs.readFileSync(planPath, 'utf8').slice(0, 200_000) };
          } catch {
            // Written and gone, or not readable: agy's reply links it.
          }
        }
        // session_send `plan`: the plan is the answer; approving it is the next message.
        const replyText = options.plan && plan?.text.trim() ? plan.text.replace(/\n$/, '') : text;

        const permissionDenials = [...new Set([...deniedActions, ...extractAgyToolPermissionDenials(turnLog ?? '')])];
        const event: StreamEvent = {
          type: 'result',
          result: replyText,
          // agy can exit 0 while reporting a non-SUCCESS status, an error, or no
          // usable response, so all terminal signals participate in the verdict.
          stop_reason: ok ? 'end_turn' : 'error',
          ...(structuredOutput !== undefined ? { structured_output: structuredOutput } : {}),
          ...(permissionDenials.length > 0
            ? { permission_denials: permissionDenials.map((tool_name) => ({ tool_name })) }
            : {}),
          ...(expanded.length ? { expanded_commands: expanded } : {}),
          ...(this._reportedModel ? { model: this._reportedModel } : {}),
          ...(plan ? { plan } : {}),
          ...(members && members.conversations > 0
            ? {
                member_usage: {
                  conversations: members.conversations,
                  tokensIn: members.tokensIn,
                  tokensOut: members.tokensOut,
                  cachedTokens: members.cachedTokens,
                  costUsd: Math.round(members.costUsd * 10000) / 10000,
                },
              }
            : {}),
          ...(compact ? { compacted, ...(sizes ? { compact: sizes } : {}) } : {}),
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
        } else if (emptyResponse && !compact) {
          const echoableDenials = permissionDenials.filter((name) => AGY_ECHOABLE_TOOL_NAME_RE.test(name));
          const denied = echoableDenials.length > 0 || hasAgyToolPermissionDenial(turnLog ?? '');
          const emptyResponseError =
            echoableDenials.length > 0
              ? `Antigravity returned an empty response after denying tool confirmation for ${echoableDenials.map((name) => `"${name}"`).join(', ')}; the turn failed but the session remains available for retry`
              : denied
                ? TOOL_DENIAL_EMPTY_RESPONSE_ERROR
                : EMPTY_RESPONSE_ERROR;
          const err = new Error(emptyResponseError) as Error & { agyToolDenial?: string[] };
          if (denied) err.agyToolDenial = echoableDenials;
          reject(err);
        } else {
          resolve({ text: replyText, event });
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

  /**
   * A compaction's sizes, from its summary pass: before, that pass's prompt (the
   * whole conversation); after, the summary on top of what every request
   * carries — the prefix the pass read from cache, or the smallest prompt seen —
   * an estimate until the next turn measures it.
   */
  private _compactSizes(checkpoint: AgyUsage): { preTokens: number; postTokens: number } {
    const pre = (checkpoint.input_tokens ?? 0) + (checkpoint.cache_read_tokens ?? 0);
    const prefix = checkpoint.cache_read_tokens || this._smallestPrompt || 0;
    return { preTokens: pre, postTokens: Math.min(pre, prefix + (checkpoint.output_tokens ?? 0)) };
  }

  /**
   * This turn's usage. agy's `result.usage` is the conversation's running total,
   * not the turn's: measured on 1.5.18–1.5.19, a resumed conversation's result
   * reports every request since it began (`num_turns` counts its turns), and it
   * equals the sum of the conversation's transcript. Counting it per turn billed
   * each turn for the whole conversation again. The turn's own requests are its
   * `agent_response` and `checkpoint` steps, each with that request's usage;
   * their sum is the result's for a conversation's first turn, and the
   * difference between two results otherwise. Without step usage, a first
   * turn's result is the turn's, a later one's is the difference from the last
   * result seen, and with no earlier result there is nothing to measure.
   */
  private _turnUsage(
    steps: { input: number; output: number; cache: number },
    result: AgyUsage | undefined,
    numTurns: number | undefined,
  ): AgyUsage | undefined {
    if (steps.input + steps.output + steps.cache > 0) {
      return { input_tokens: steps.input, output_tokens: steps.output, cache_read_tokens: steps.cache };
    }
    if (!result) return undefined;
    if (numTurns === undefined || numTurns <= 1) return result;
    const before = this._conversationUsage;
    if (!before) return undefined;
    const delta = (k: keyof AgyUsage) => Math.max(0, (result[k] ?? 0) - (before[k] ?? 0));
    return {
      input_tokens: delta('input_tokens'),
      output_tokens: delta('output_tokens'),
      cache_read_tokens: delta('cache_read_tokens'),
    };
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

  private _pricing(model: string | undefined): ModelPricing {
    return getModelPricing(this._baseModel(model || this._reportedModel), this.engineCfg.defaultModel);
  }

  /**
   * What one turn cost, priced at the model it ran on: a send's own model
   * (`perSendModel`) is billed at its rates, not the session's. An orchestrator
   * turn runs its requests on models of agy's choosing, so it is priced request
   * by request from the conversation's transcript, and whatever the transcript
   * does not account for at the orchestrator's registered rates.
   */
  private _priceTurn(usage: AgyUsage, model: string | undefined, firstStep: number | undefined): number {
    const input = usage.input_tokens ?? 0;
    const output = usage.output_tokens ?? 0;
    const cache = usage.cache_read_tokens ?? 0;
    const pricing = this._pricing(model);
    const ran = model || this._reportedModel;
    if (!ran || !AGY_ORCHESTRATOR_MODELS.test(ran) || !this.agyConversationId || firstStep === undefined) {
      return priceTokens(pricing, input, cache, output);
    }
    const transcript = readAgyTranscript(agyTranscriptPath(this.agyConversationId, agyBrainDir()));
    const requests = (transcript?.requests ?? []).filter((r) => r.step >= firstStep);
    const seen = requests.reduce(
      (t, r) => ({
        input: t.input + r.inputTokens,
        cache: t.cache + r.cacheReadTokens,
        output: t.output + r.outputTokens,
      }),
      { input: 0, cache: 0, output: 0 },
    );
    return (
      priceAgyRequests(requests, this.engineCfg.defaultModel) +
      priceTokens(
        pricing,
        Math.max(0, input - seen.input),
        Math.max(0, cache - seen.cache),
        Math.max(0, output - seen.output),
      )
    );
  }

  protected override _billedModel(): string | undefined {
    return this.options.model || this._reportedModel;
  }

  protected override _getModelPricing() {
    return this._pricing(this.options.model);
  }

  /** Clean up the per-session log file along with the base teardown. */
  stop(): void {
    super.stop();
    for (const proc of this._infoProcs) killEngineTree(proc);
    this._infoProcs.clear();
    try {
      fs.unlinkSync(this._logFile);
    } catch {
      // Never created, or already gone
    }
  }

  // ── Engine commands ────────────────────────────────────────

  /** `--model`/`--effort` as the next turn would pass them, for an info command that reports them. */
  private _infoArgs(): string[] {
    let args: string[];
    try {
      args = this._buildArgs('', 1000);
    } catch {
      // Settings that are not a JSON object fail a turn; an info command runs without them.
      return [];
    }
    const out: string[] = [];
    for (const flag of ['--model', '--effort', '--settings']) {
      const i = args.indexOf(flag);
      if (i >= 0) out.push(flag, args[i + 1]);
    }
    return out;
  }

  /** Run one info command as a process of its own, beside any turn: no conversation, no log file. */
  private _infoCommand(name: string, args?: string, timeoutMs?: number) {
    return runAgyInfoCommand(`/${name}${args ? ` ${args}` : ''}`, {
      bin: this.engineBin,
      cwd: this.options.cwd,
      launcher: this.options.launcher,
      extraArgs: this._infoArgs(),
      timeoutMs: Math.min(timeoutMs ?? 60_000, 120_000),
      onSpawn: (proc) => {
        this._infoProcs.add(proc);
        proc.once('close', () => this._infoProcs.delete(proc));
      },
    });
  }

  /**
   * The commands this session can run: the info commands `/help` lists, agy's
   * system commands, and the skills `/skills` lists for the session's directory
   * (agy's own, the user's, the workspace's and plugins'). Read once, again after
   * `COMMANDS_TTL_MS`.
   */
  async listCommands(): Promise<EngineCommand[]> {
    if (this._commands && Date.now() - this._commands.at < COMMANDS_TTL_MS) return this._commands.list;
    const [help, skills] = await Promise.all([
      this._infoCommand('help').catch(() => undefined),
      this._infoCommand('skills').catch(() => undefined),
    ]);
    const info = agyInfoCommands(help?.answer?.data);
    const taken = new Set([...info, ...AGY_SYSTEM_COMMANDS].map((c) => c.name));
    const list = [...info, ...AGY_SYSTEM_COMMANDS, ...agySkillCommands(skills?.answer?.data, taken)];
    // A failed read is not cached: the next call tries again.
    if (help?.answer && skills?.answer) this._commands = { at: Date.now(), list };
    return list;
  }

  /**
   * Run `/<name> <args>`. An info command runs as a process of its own, beside
   * any turn, and returns its structured answer as `data`. `/compact` waits for
   * the compaction. Anything else is a turn on the conversation, with slash
   * commands read for it whatever `disableSlashCommands` says; `/teamwork` gets
   * `[skip-interview]`.
   */
  async runCommand(
    name: string,
    args?: string,
    opts: { timeout?: number; callbacks?: StreamCallbacks } = {},
  ): Promise<CommandOutcome> {
    const cmd = name.trim().replace(/^\//, '');
    if (AGY_INFO_COMMAND_NAMES.has(cmd)) {
      // A bare `/plugin` opens agy's interactive plugin manager; its listing is `/plugin list`.
      const given = cmd === 'plugin' && !args ? 'list' : args;
      try {
        const r = await this._infoCommand(cmd, given, opts.timeout);
        const a = r.answer;
        if (!a) {
          const why = sanitizeSecrets(r.stderr.trim()).slice(0, 500);
          return {
            name: cmd,
            ok: false,
            text: '',
            startedTurn: false,
            error: why || `/${cmd} gave no answer (exit ${r.code})`,
          };
        }
        const ok = a.ok && r.code === 0;
        return {
          name: cmd,
          ok,
          text: a.text.replace(/\n$/, ''),
          ...(a.data !== undefined ? { data: a.data } : {}),
          startedTurn: false,
          ...(ok ? {} : { error: sanitizeSecrets(a.error || r.stderr.trim() || `/${cmd} failed (exit ${r.code})`) }),
        };
      } catch (err) {
        return { name: cmd, ok: false, text: '', startedTurn: false, error: (err as Error).message };
      }
    }
    if (cmd === 'compact') {
      const outcome = await this.compactDetailed(args);
      // Not a turn of the conversation: no ledger row.
      return {
        name: cmd,
        ok: outcome.ok,
        text: outcome.note ?? '',
        data: outcome,
        startedTurn: false,
        ...(outcome.ok ? {} : { error: outcome.note ?? 'nothing was compacted' }),
      };
    }
    await this._checkCommandKnown(cmd);
    try {
      const r = await this._sendCommandTurn(agyCommandPrompt(cmd, args), {
        timeout: opts.timeout,
        callbacks: opts.callbacks,
      });
      const failed = r.event.is_error === true || r.event.stop_reason === 'error';
      const command = r.event.command as { data?: unknown } | undefined;
      const data = command?.data ?? r.event.plan;
      return {
        name: cmd,
        ok: !failed,
        text: r.text,
        ...(data !== undefined ? { data } : {}),
        startedTurn: !r.localCommand,
        ...(failed ? { error: r.text || `/${cmd} failed` } : {}),
      };
    } catch (err) {
      return { name: cmd, ok: false, text: '', startedTurn: true, error: (err as Error).message };
    }
  }

  /**
   * Refuse a name agy has no command for: sent as `/name` it reaches the model
   * as a message, a paid turn. Only a whole listing (help and skills both read)
   * refuses, and it is read again once first, for a skill added since.
   */
  private async _checkCommandKnown(cmd: string): Promise<void> {
    if (AGY_SYSTEM_COMMANDS.some((c) => c.name === cmd)) return;
    if ((await this.listCommands()).some((c) => c.name === cmd) || !this._commands) return;
    this._commands = undefined;
    const again = await this.listCommands();
    if (this._commands && !again.some((c) => c.name === cmd)) {
      throw new Error(
        `there is no command /${cmd} on this agy session: session_command list shows what there is, ` +
          'and session_send sends the text to the model as a message',
      );
    }
  }

  /** The session's `turnCommand` on a message: `/boost <message>`, `/teamwork [skip-interview] <message>`. */
  applyTurnCommand(command: string, message: string): string {
    return agyCommandPrompt(command, message);
  }

  /**
   * agy's own `/compact` (a summary pass over the conversation), waited for and
   * judged by that pass: the reply is empty by design. agy takes no instructions
   * for it — text after `/compact` is answered as a message once it is done — so
   * a `summary` is not sent. The sizes are `_compactSizes`'.
   */
  async compactDetailed(summary?: string): Promise<CompactOutcome> {
    if (!this.agyConversationId) {
      return { ok: false, trigger: 'manual', note: 'Nothing to compact yet: this agy session has no conversation' };
    }
    const ignored = summary?.trim() ? "agy's /compact takes no instructions; the summary text was not sent" : undefined;
    try {
      const r = await this._sendCommandTurn('/compact', { timeout: 600_000, agyCompact: true });
      const sizes = r.event.compact as { preTokens?: number; postTokens?: number } | undefined;
      const ok = r.event.compacted === true;
      const note = [ok ? undefined : r.text.trim() || 'agy ran no summary pass', ignored].filter(Boolean).join('; ');
      return {
        ok,
        trigger: 'manual',
        ...(sizes?.preTokens ? { preTokens: sizes.preTokens } : {}),
        ...(sizes?.postTokens ? { postTokens: sizes.postTokens } : {}),
        ...(note ? { note } : {}),
      };
    } catch (err) {
      return { ok: false, trigger: 'manual', note: [(err as Error).message, ignored].filter(Boolean).join('; ') };
    }
  }

  /** `compactDetailed`, as the engine-agnostic `compact()` result; `compacted` says whether it did. */
  async compact(summary?: string): Promise<TurnResult> {
    const outcome = await this.compactDetailed(summary);
    const message = outcome.note ?? 'Compacted the conversation';
    return { text: message, event: { type: 'result', result: message, compacted: outcome.ok } };
  }

  // ── Live switches ──────────────────────────────────────────

  /** Each turn is a new process: the next one runs on `model`, with nothing to restart. */
  async setModelLive(model: string): Promise<boolean> {
    this.options.model = model;
    this.options.resolvedModel = model;
    return true;
  }

  /** The next turn's process takes the effort; there is nothing to restart. */
  async setEffortLive(_level: EffortLevel): Promise<boolean> {
    return true;
  }

  // ── Native goal ────────────────────────────────────────────

  /** agy's own `/goal` loop behind the goal node's surface (`nativeGoal`); see `AgyGoalSession`. */
  nativeGoalSession(open?: ClaudeGoalOpen): GoalSession {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const session = this;
    const host: AgyGoalHost = {
      get conversationId() {
        return session.conversationId;
      },
      send: (message, o) => this._sendCommandTurn(message, { timeout: o?.timeout }),
      interruptRun: () => this.interruptRun(),
      getStats: () => this.getStats(),
      on: (event, listener) => this.on(event, listener),
      off: (event, listener) => this.off(event, listener),
    };
    return new AgyGoalSession(host, open);
  }

  /** Override getStats to expose the captured conversation ID. */
  getStats(): ReturnType<BaseOneShotSession['getStats']> {
    const base = super.getStats();
    return { ...base, agyConversationId: this.agyConversationId };
  }
}

function priceTokens(p: ModelPricing, input: number, cache: number, output: number): number {
  return (input * p.input + cache * (p.cached ?? 0) + output * p.output) / 1_000_000;
}
