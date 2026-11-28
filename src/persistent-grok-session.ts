/**
 * Grok Build (xAI) session wrapper.
 *
 * One-shot per send: `grok -p --output-format streaming-json` with the message on
 * stdin, which prints one JSON object per line and exits. Its final `end` event is
 * unusually complete for this engine class — a terminal `stopReason`, a resumable
 * `sessionId`, the folder the session ran in, real token usage, the model that
 * actually answered, and the engine's own `total_cost_usd` — and the reply arrives
 * as `text` pieces before it, which are passed on as they arrive. The
 * single-object `json` format carries the same, but its usage is only the turn's
 * sum; the stream also reports each request's own, which is what the context
 * size has to be read from.
 *
 * The message is never an argument. clap reads an argument that starts with `-`
 * as an option, so `-p "- item"` failed before the turn; `-p` with no value reads
 * the prompt from stdin, which also keeps it out of the argv size limit and out
 * of `ps`. A turn with images sends them, with the message, as ACP content blocks
 * from a `.json` file (`--prompt-file`); see `_writeImagePrompt`.
 *
 * Two consequences shape this file:
 *
 * 1. **Cost is passed through, not priced.** Every other engine here multiplies
 *    token counts by a rate in `models.ts`, which is the metadata that rots
 *    silently between releases. Grok reports what it charged, so this wrapper
 *    writes that number into `_stats.costUsd` directly and the registry is never
 *    consulted for it. The run ledger and the `maxBudgetUsd` gate both read that
 *    field, so both get the engine's own figure.
 * 2. **The binary is `grok`, never `agent`.** xAI's installer also symlinks the
 *    generic `agent` name, which Cursor's CLI already used; whichever installer
 *    ran last wins. Both wrappers now name the vendor-specific binary so the
 *    engine you asked for is the engine you get.
 *
 * Usage and cost are per-turn, not cumulative over the thread — verified against
 * 1.0.5 by resuming a session and reading the second turn (29,711 in / $0.0597,
 * then 70 in / $0.0152). Accumulating them is therefore correct here, unlike
 * codex, where the same-looking field is a running total.
 *
 * Commands (`commandStyle: 'text'`): a message that starts with `/name` is a
 * grok command. The shell built-ins answer locally with no usage on `end`,
 * which is how such a reply is told from a turn (`localCommand`); TUI-only
 * names, `/loop` and workflow launches are refused before anything runs, since
 * print mode cannot do what they ask (see grok-commands.ts). The command list,
 * with grok's descriptions, comes from ACP `_x.ai/commands/list`, which needs
 * no session; the plan from ACP `_x.ai/billing` (grok-quota.ts).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { ChildProcess } from 'node:child_process';
import { killEngineTree, spawnEngine } from './engine-spawn.js';

import type {
  AsideOutcome,
  CommandOutcome,
  CompactOutcome,
  EngineCommand,
  SessionConfig,
  SessionSendOptions,
  StreamCallbacks,
  StreamEvent,
  TurnResult,
} from './types.js';
import { sanitizeSecrets } from './sanitize.js';
import { BaseOneShotSession } from './base-oneshot-session.js';
import { SESSION_EVENT, TURN_TIMEOUT_MS } from './constants.js';
import {
  GROK_PAGER_COMMANDS,
  GROK_SHELL_COMMANDS,
  commandsFromGrokAcpList,
  grokCommandIsLocal,
  grokCommandRefusal,
  grokPagerCommands,
  grokShellCommand,
  parseGrokCommand,
  parseGrokGoalStateFile,
  parseGrokSessionContext,
  type GrokGoalState,
} from './grok-commands.js';
import { grokAcpCall } from './grok-acp-client.js';
import { GrokGoalSession, type GrokGoalOpen } from './grok-goal-session.js';
// Registers grok's quota reader (engine-quota.ts).
import { grokHome, latestGrokRefusal } from './grok-quota.js';
// Registers grok's ACP extensions, read by the `acp` engine under the `grok` preset.
import './grok-acp-extension.js';
import type { GoalSession } from './kernel/nodes/goal.js';

interface GrokUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

/**
 * The turn's result: the `end` event with the reply joined back onto it, which
 * is the object `--output-format json` prints. Only the fields we consume.
 */
interface GrokJsonResult {
  text?: string;
  stopReason?: string;
  sessionId?: string;
  /** The folder the session ran in: inside the new worktree with `--worktree`. */
  cwd?: string;
  /** The whole turn's usage: the sum of every request it made. */
  usage?: GrokUsage;
  total_cost_usd?: number;
  modelUsage?: Record<string, unknown>;
  /** Set on `end` when a hook stopped the turn, with the hook's message. */
  error?: string;
  /** `error` when grok refused the turn outright (usage limit, auth), with `message`. */
  type?: string;
  message?: string;
}

/** One line of `--output-format streaming-json`. Only the fields we consume. */
interface GrokStreamEvent extends GrokJsonResult {
  /** A piece of the reply, on a `text` event. */
  data?: unknown;
  /** On `tool_call` and `tool_call_update`. */
  toolCallId?: string;
  /** `pending`, `in_progress`, `completed` or `failed`; null on a progress update. */
  status?: string | null;
  /** On `available_commands`: the commands and the tools the run offers. */
  commands?: unknown;
  tools?: unknown;
  /** Set on `end` when grok could not count every call's cost (subagents, a cut-off turn). */
  cost_is_partial?: boolean;
  usage_is_incomplete?: boolean;
}

/** What one turn's stream has said so far. */
interface TurnState {
  text: string;
  end?: GrokStreamEvent;
  error?: GrokJsonResult;
  /** The usage of the turn's last request: the context size. */
  lastRequest?: GrokUsage;
  /** Requests that reported usage, and whether the model thought: either means a model call. */
  requests: number;
  thought: boolean;
  /** grok compacted the conversation during the run (`auto_compact_completed`). */
  compacted: boolean;
  /** Tool calls started, finished, and finished as failed, by `toolCallId`. */
  started: Set<string>;
  finished: Set<string>;
  failed: Set<string>;
}

/** Wrapper-internal choices for one turn, on top of the caller's options. */
interface GrokTurnOptions {
  /** A turn clawo starts itself: the command refusals do not apply. */
  internal?: boolean;
  /** Read a leading `/name` as a command even on a session that sends text verbatim. */
  slashCommands?: boolean;
  /** Let grok wait for the background work the turn starts (a native goal's later rounds). */
  waitForBackground?: boolean;
  /** Read the turn's spend from `grok usage <id>` afterwards. */
  reconcileCost?: boolean;
}

/** The options `send()` takes here: the engine-agnostic ones, and the wrapper's own. */
type GrokSendOptions = SessionSendOptions & { grok?: GrokTurnOptions };

/** What a print-mode run printed, read whole (probes, asides). */
interface PrintRun {
  text: string;
  end?: GrokStreamEvent;
  /** The `error` line's message, or what stderr said when there was no result line. */
  error?: string;
}

/** How long `/compact` may take: it summarises the whole conversation (172 s measured on a fresh session). */
const COMPACT_TIMEOUT_MS = 600_000;

/** How long a command grok answers locally may take (about 2 s measured). */
const LOCAL_COMMAND_TIMEOUT_MS = 60_000;

/** How long the command list read over ACP is reused. */
const COMMAND_LIST_TTL_MS = 60_000;

/** What an aside's run is told: the question is answered from the conversation, with no tools. */
const ASIDE_RULES =
  'This is a side question about the conversation so far. Answer it directly, from what the conversation ' +
  'already holds. No tools are available in this reply, so do not plan to use any; if the conversation ' +
  'does not hold the answer, say so.';

/**
 * The tools grok's print mode offers (its `available_commands` line, 1.0.92),
 * used to strip an aside's run of tools before the session's own list is known.
 */
const GROK_TOOLS = [
  'run_terminal_command',
  'read_file',
  'search_replace',
  'list_dir',
  'grep',
  'kill_command_or_subagent',
  'todo_write',
  'get_command_or_subagent_output',
  'spawn_subagent',
  'scheduler_create',
  'scheduler_delete',
  'scheduler_list',
  'monitor',
  'search_tool',
  'use_tool',
  'workflow',
  'enter_plan_mode',
  'exit_plan_mode',
  'ask_user_question',
  'send_feedback',
  'web_search',
  'web_fetch',
  'image_gen',
  'image_edit',
  'image_to_video',
  'reference_to_video',
  'write',
];

/** A grok session's folder in its store: `<grok home>/sessions/<encoded cwd>/<id>`, found by id. */
function findGrokSessionDir(id: string): string | undefined {
  const root = path.join(grokHome(), 'sessions');
  let cwds: string[];
  try {
    cwds = fs.readdirSync(root);
  } catch {
    return undefined;
  }
  for (const cwd of cwds) {
    const dir = path.join(root, cwd, id);
    if (fs.existsSync(dir)) return dir;
  }
  return undefined;
}

/**
 * The one stop reason that is a completed turn. grok's list is open-ended
 * (`end_turn`, `max_tokens`, `max_turn_requests`, `refusal`, `cancelled`,
 * `hook_blocked`, `hook_stopped`, and "new stop reasons may be added"), and its
 * headless docs say to treat a reason you do not recognize as not a success.
 * Only `error` used to fail a turn, so a refusal or a reply cut off at its
 * output limit was counted as succeeded.
 */
const SUCCESS_STOP_REASON = 'end_turn';

/** grok's warning when a sandbox profile could not be applied (1.0.50). */
const SANDBOX_NOT_APPLIED_RE = /sandbox could not be applied/i;

/** grok's sandbox profile for each sandbox mode it enforces, and how errors name it. */
const SANDBOX_PROFILES: Partial<Record<NonNullable<SessionConfig['sandboxMode']>, { profile: string; label: string }>> =
  {
    'read-only': { profile: 'read-only', label: 'read-only' },
    'workspace-write': { profile: 'workspace', label: 'workspace' },
  };

/**
 * The tools grok's permission rules (`--allow` / `--deny`) can name, bare or with
 * a pattern. A rule for any other name is refused or skipped: on 1.0.92
 * `--deny NotebookEdit` exits 1 ("Grok has no NotebookEdit tool"), and so does
 * `--deny "Agent(explore)"` ("Grok has no tool named Agent").
 */
const RULE_TOOLS_RE = /^(?:Bash|Read|Edit|Write|Grep|Glob|WebFetch|WebSearch|MCPTool)(?:\([\s\S]*\))?$/;

/** `entry` as a grok permission rule, or undefined when grok has no rule for it. */
function permissionRule(entry: string): string | undefined {
  // Claude names an MCP tool `mcp__<server>__<tool>`; grok's rule is
  // `MCPTool(<server>__<tool>)`, and its tool names carry no `mcp__` prefix.
  const mcp = /^mcp__(.+)$/.exec(entry);
  if (mcp) return `MCPTool(${mcp[1].includes('__') ? mcp[1] : `${mcp[1]}__*`})`;
  return entry === '*' || RULE_TOOLS_RE.test(entry) ? entry : undefined;
}

/**
 * `flag=value`. clap reads a separate value that starts with `-` as an option
 * (`--rules "- be brief"` fails to parse), so caller text goes in the equals form.
 */
function withValue(flag: string, value: string): string {
  return `${flag}=${value}`;
}

/** The ACP `mimeType` of each image type the session manager lets through. */
const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

/** True when `dir` is inside the OS temp directory, which grok's read-only profile leaves writable. */
function underTempDir(dir: string): boolean {
  const real = (p: string): string => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  const target = real(dir);
  const roots = new Set([real(os.tmpdir()), real('/tmp'), real('/var/tmp')]);
  if (process.env.TMPDIR) roots.add(real(process.env.TMPDIR));
  return [...roots].some((root) => target === root || target.startsWith(root + path.sep));
}

/** Call a caller's stream callback; a throwing callback must not break the turn. */
function notify<T>(fn: ((value: T) => void) | undefined, value: T): void {
  try {
    fn?.(value);
  } catch {
    /* user callback */
  }
}

export class PersistentGrokSession extends BaseOneShotSession {
  /** Grok's own session UUID, captured from turn 1 and replayed via `--resume`. */
  private grokSessionId?: string;
  /** The model grok reports under `modelUsage`; it moves when grok's default does. */
  private grokModel?: string;
  /**
   * The worktree grok made for this session (`worktree`), read from the first
   * turn's `end` event. Later turns resume there; see `_buildArgs`.
   */
  private worktreePath?: string;
  /** Set once the allowedTools entries grok has no rule for have been logged. */
  private loggedIgnoredAllow = false;

  /** A `/name args` message is a grok command (see the file header). */
  readonly commandStyle = 'text' as const;
  /** Every turn is its own process, so `--model` can name a model for one turn. */
  readonly perSendModel = true;

  /** What the last run's `available_commands` line offered. */
  private advertisedCommands?: string[];
  private advertisedTools?: string[];
  /** The skills and workflows read over ACP, and when. */
  private acpCommands?: { at: number; commands: EngineCommand[]; workflows: Set<string> };
  /** The context window `/session-info` reported (grok's own, e.g. 256000). */
  private grokWindow?: number;
  /** The session's folder in grok's store, once found. */
  private grokSessionDir?: string;
  /** Print-mode runs beside the turns (local commands, asides, `grok usage`); one at a time. */
  private readonly sideProcs = new Set<ChildProcess>();
  private sideChain: Promise<unknown> = Promise.resolve();

  constructor(config: SessionConfig, grokBin?: string) {
    super(config, grokBin || process.env.GROK_BIN || 'grok', {
      enginePrefix: 'grok',
      defaultModel: 'grok-4.7',
      defaultModelDisplay: 'grok-4.7',
      supportsCachedTokens: true,
      // grok reports `total_tokens` as input + output + cache reads + cache
      // writes (30034 = 19393 + 17 + 10624 + 0 on a resumed turn), and its own
      // `total_cost_usd` for that turn decomposes the same way: 19393 at the
      // full input rate plus 10624 at the cached rate. `input_tokens` therefore
      // excludes the cached reads and must not have them subtracted out.
      inputIncludesCachedTokens: false,
      engineDisplayName: 'Grok Build',
      appendsSystemPromptNatively: true,
    });
    // Same shape cursor and opencode use: the real id is surfaced through
    // `sessionId` behind a `grok-live-` prefix so SessionManager can persist it,
    // and the prefix is stripped again on the way back in. A synthetic wrapper id
    // (`grok-<ts>-<rand>`) must never be handed to `--resume`.
    if (config.resumeSessionId && !/^grok-\d+-/.test(config.resumeSessionId)) {
      this.grokSessionId = config.resumeSessionId.replace(/^grok-live-/, '');
    }
  }

  /** The configured model, else the one grok reported running. */
  protected override _billedModel(): string | undefined {
    return this.options.model || this.grokModel;
  }

  /** The window grok itself reported for the session, else the registry's. */
  protected override _effectiveContextWindow(): number {
    return this.grokWindow || super._effectiveContextWindow();
  }

  /** grok's own session id, once a turn has made one. */
  get grokConversationId(): string | undefined {
    return this.grokSessionId;
  }

  /** The folder grok runs this session in. */
  private _runCwd(): string | undefined {
    return this.worktreePath ?? this.options.cwd;
  }

  /** `--worktree[=name]` when this session asked for a new worktree, else undefined. */
  private _worktreeFlag(): string | undefined {
    const worktree = this.options.worktree;
    if (worktree === true || worktree === 'true') return '--worktree';
    // The equals form: `--worktree NAME` would also take the next word as its
    // name, which is how grok's own docs say a prompt gets swallowed.
    if (typeof worktree === 'string' && worktree) return withValue('--worktree', worktree);
    return undefined;
  }

  private _buildArgs(options: GrokSendOptions, promptFile?: string): string[] {
    // The prompt is never an argument (see the file header): `-p` with no value
    // reads it from stdin, and a turn with images reads it from a `.json` file.
    const args: string[] = promptFile ? ['--prompt-file', promptFile] : ['-p'];
    args.push('--output-format', 'streaming-json');

    // A session in a worktree of its own keeps working there. grok itself
    // resumes a session in the folder it was created in, whatever `--cwd` says
    // (1.0.92: `--resume` with the main checkout as `--cwd` ran in the worktree,
    // "originally in <worktree>"), so a wrapper restarted without the path still
    // resumes there; naming the worktree keeps the argv and that folder in step.
    const cwd = this.worktreePath ?? this.options.cwd;
    if (cwd) args.push('--cwd', cwd);

    // Resume grok's own thread rather than starting fresh. `--continue` is
    // deliberately not used: it means "the most recent session for this cwd",
    // which collides between concurrent sessions on the same project.
    if (this.grokSessionId) {
      args.push('--resume', this.grokSessionId);
    } else {
      // Both shape the session when it is created, and neither applies to a
      // resume: clap refuses `--add-dir` beside `--resume` (a resumed session
      // keeps the folders it was created with), and `--worktree` beside
      // `--resume` would make another worktree for the same conversation.
      //
      // grok refuses an added folder that is not trusted, or one its sandbox
      // profile cannot write. And on 1.0.92 grok's headless shell route refuses
      // any: "additionalDirectories is not supported: a session works only in
      // its cwd", even for the home folder, which counts as trusted. The refusal
      // comes before the model is called, so the turn fails at no cost — loudly,
      // where dropping the option would leave the caller believing it held.
      for (const dir of this.options.addDir ?? []) args.push('--add-dir', dir);
      const worktree = this._worktreeFlag();
      if (worktree) args.push(worktree);
    }

    // A model for this turn only (`perSendModel`), else the session's.
    const model = options.model || this.options.resolvedModel || this.options.model;
    if (model) args.push('--model', this.resolveModel(model.replace(/^grok\//, '')));

    // grok's --permission-mode vocabulary is the same set as ours, so this is a
    // passthrough rather than a mapping. 'manual' is ours alone; grok calls the
    // equivalent 'default'. A plan turn (`plan` on the send) runs in grok's plan
    // mode, whatever the session's mode.
    const mode = options.plan
      ? 'plan'
      : this.options.permissionMode === 'manual'
        ? 'default'
        : this.options.permissionMode;
    if (mode) args.push('--permission-mode', mode);

    // The boundary is grok's own OS sandbox (Seatbelt / Landlock), not a tool
    // allowlist — see _run for what it was measured against.
    const sandbox = this.options.sandboxMode && SANDBOX_PROFILES[this.options.sandboxMode];
    if (sandbox) args.push('--sandbox', sandbox.profile);

    const effort = options.effort ?? this.options.effort;
    if (effort && effort !== 'auto') {
      // grok 1.0.5 takes low|medium|high|xhigh — it names the invalid ones in
      // its own rejection message. Only the two levels above its ceiling clamp;
      // `xhigh` used to clamp too and was silently costing callers a tier.
      args.push('--effort', effort === 'max' || effort === 'ultra' ? 'xhigh' : effort);
    }

    if (this.options.maxTurns) args.push('--max-turns', String(this.options.maxTurns));
    if (this.options.systemPrompt) args.push(withValue('--system-prompt-override', this.options.systemPrompt));
    // grok appends `--rules` to its system prompt, which is what our
    // engine-agnostic `appendSystemPrompt` means — distinct from the override
    // above, which replaces it.
    if (this.options.appendSystemPrompt) args.push(withValue('--rules', this.options.appendSystemPrompt));

    this._pushToolControl(args);

    // Structured output. grok's `--json-schema` takes the schema inline, the
    // same shape our engine-agnostic option carries; under streaming JSON the
    // reply's `text` pieces join into the conforming object (1.0.77).
    if (this.options.jsonSchema) args.push('--json-schema', this.options.jsonSchema);

    if (this.options.agent) args.push('--agent', this.options.agent);
    if (this.options.agents) {
      const json = typeof this.options.agents === 'string' ? this.options.agents : JSON.stringify(this.options.agents);
      args.push('--agents', json);
    }

    // Not on a plan turn: auto-approving every tool is the opposite of planning.
    if (this.options.dangerouslySkipPermissions && !options.plan) args.push('--always-approve');

    // `--session-id` names a NEW conversation, so it is only valid on a first
    // turn — or on a resumed one that is being forked, which is what grok's own
    // help says and what `--fork-session` is for.
    if (this.options.forkSession && this.grokSessionId) args.push('--fork-session');
    if (this.options.customSessionId && (!this.grokSessionId || this.options.forkSession)) {
      args.push('--session-id', this.options.customSessionId);
    }

    // Loads the folder's AGENTS.md, skills, MCP servers and hooks, which
    // headless grok otherwise skips, and records the grant in
    // ~/.grok/trusted_folders.toml, so it outlives the session.
    if (this.options.trustProject) args.push('--trust');
    // Without it a message starting with /name is taken as a slash command. A
    // command clawo runs itself (`/compact`, a goal) is one on any session.
    if (this.options.disableSlashCommands && !options.grok?.slashCommands) args.push('--verbatim');

    // grok's `--debug` takes no categories. It writes the log to
    // $GROK_HOME/debug/<session-id>.txt, or to `--debug-file`, not to stderr.
    const debug = this.options.debug;
    if (Array.isArray(debug) ? debug.length > 0 : !!debug) args.push('--debug');
    if (this.options.debugFile) args.push('--debug-file', this.options.debugFile);

    // After the turn, grok waits up to 600 s for background work it started (a
    // background shell, a background subagent) and answers each finished task in
    // a further turn. That is past the send timeout (300 s by default), which
    // then kills the process and loses the reply, the cost and the session id;
    // and a server left running in the background held every such turn for the
    // full 600 s. A shorter `--background-wait-timeout` does not help: when it
    // runs out grok exits 1 with an error in place of the result, without the
    // session id. Not waiting exits as soon as the turn ends and stops the work
    // still running, with the exit code and the closing `end` line unchanged
    // (measured on 1.0.92: a turn that left `sleep 90` running exited in 12 s,
    // `end_turn`, the sleep gone). A one-shot session keeps nothing running
    // between sends anyway; a model that needs a result waits for it in its turn.
    //
    // The exception is grok's own goal loop: its later rounds (implementer,
    // verifiers) are turns grok runs after the prompt, which the process must
    // wait for or the goal stops after its first round (`nativeGoalSession`).
    if (!options.grok?.waitForBackground) args.push('--no-wait-for-background');

    return args;
  }

  /**
   * Map the engine-agnostic tool options onto grok's three tool flags.
   *
   * `allowedTools` / `disallowedTools` are permission rules, as Claude Code's
   * are, and grok's own `--allowedTools` / `--disallowedTools` are aliases of
   * `--allow` / `--deny`. They used to go to `--tools` / `--disallowed-tools`,
   * which take grok's internal tool ids: `--disallowed-tools Bash` warned that
   * it "names no tool, so it removes nothing", and the shell ran (1.0.92).
   */
  private _pushToolControl(args: string[]): void {
    // `--tools` restricts the built-in toolset; one comma-separated value, as
    // clap refuses the flag twice. `default` is Claude's name for its full set,
    // which is what grok runs when the flag is absent.
    const tools = this.options.tools;
    if (tools !== undefined && tools !== 'default')
      args.push('--tools', Array.isArray(tools) ? tools.join(',') : tools);

    // An allow rule only auto-approves. One for a tool grok has no rule for
    // approves nothing, and some such names (`NotebookEdit`) stop grok at start.
    const ignored: string[] = [];
    for (const entry of this.options.allowedTools ?? []) {
      const rule = permissionRule(entry);
      if (rule) args.push('--allow', rule);
      else ignored.push(entry);
    }
    if (ignored.length && !this.loggedIgnoredAllow) {
      this.loggedIgnoredAllow = true;
      this.emit(
        SESSION_EVENT.LOG,
        `[grok] allowedTools left out, grok has no permission rule for them: ${ignored.join(', ')} ` +
          '(its rules name Bash, Read, Edit, Write, Grep, Glob, WebFetch, WebSearch and MCPTool)',
      );
    }

    // A deny rule refuses every call it matches, under any permission mode, and
    // deny wins over allow (1.0.92, bypassPermissions, `--deny Bash`: the shell
    // call came back "Denied by permission policy: deny rule on bash" and the
    // command did not run). A name grok has no rule for — a subagent (`Agent`,
    // `Agent(explore)`, `Task`), one of grok's own tool ids, a Claude tool grok
    // lacks — goes to `--disallowed-tools` instead, which removes the tool:
    // `Agent` entries are documented there, and an unknown name only warns.
    const removed: string[] = [];
    for (const entry of this.options.disallowedTools ?? []) {
      const rule = permissionRule(entry);
      if (rule) args.push('--deny', rule);
      else removed.push(entry);
    }
    if (removed.length) args.push('--disallowed-tools', removed.join(','));
  }

  /**
   * Write the message and its images as ACP content blocks to a private `.json`
   * file, for `--prompt-file`.
   *
   * `-p` carries text only. `--prompt-json` takes the same blocks, but as an
   * argument: a 20 MB image is ~27 MB of base64, past the 128 KiB Linux allows
   * one argument and the 1 MiB macOS allows all of them. `--prompt-file` reads a
   * file whose name ends in `.json` as content blocks (any other name as plain
   * text, which is why stdin cannot carry them) and has no such limit: a 28 MB
   * file was read whole on 1.0.92. The model saw an image sent this way; one sent
   * as a `resource_link` to the file did not reach it.
   */
  private _writeImagePrompt(message: string, images: string[]): { dir: string; file: string } {
    const blocks: Array<Record<string, string>> = [{ type: 'text', text: message }];
    for (const image of images) {
      const mimeType = IMAGE_MIME[path.extname(image).toLowerCase()];
      if (!mimeType) throw new Error(`Grok cannot send ${image}: not a PNG, JPEG, GIF or WebP file`);
      blocks.push({ type: 'image', mimeType, data: fs.readFileSync(image).toString('base64') });
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawo-grok-'));
    const file = path.join(dir, 'prompt.json');
    fs.writeFileSync(file, JSON.stringify(blocks), { mode: 0o600 });
    return { dir, file };
  }

  /** Handle one line of the stream, passing text and tool events on as they arrive. */
  private _onLine(raw: string, turn: TurnState, options: SessionSendOptions): void {
    const line = raw.trim();
    if (!line.startsWith('{')) return;
    let evt: GrokStreamEvent;
    try {
      evt = JSON.parse(line) as GrokStreamEvent;
    } catch {
      return;
    }
    switch (evt.type) {
      case 'text':
        if (typeof evt.data === 'string' && evt.data) {
          turn.text += evt.data;
          notify(options.callbacks?.onText, evt.data);
          this.emit(SESSION_EVENT.TEXT, evt.data);
        }
        break;
      case 'tool_call':
      case 'tool_call_update': {
        // A call arrives as `tool_call` (status `pending`), then as updates with
        // status null or `in_progress` while it runs and one `completed` or
        // `failed` when it ends (1.0.92). Only the start and the end are passed on.
        const id = evt.toolCallId;
        if (!id) break;
        if (evt.type === 'tool_call' && !turn.started.has(id)) {
          turn.started.add(id);
          notify(options.callbacks?.onToolUse, evt);
          this.emit(SESSION_EVENT.TOOL_USE, evt);
        }
        if ((evt.status === 'completed' || evt.status === 'failed') && !turn.finished.has(id)) {
          turn.finished.add(id);
          if (evt.status === 'failed') turn.failed.add(id);
          notify(options.callbacks?.onToolResult, evt);
          this.emit(SESSION_EVENT.TOOL_RESULT, evt);
        }
        break;
      }
      case 'usage':
        turn.requests += 1;
        if (evt.usage) turn.lastRequest = evt.usage;
        break;
      case 'thought':
        turn.thought = true;
        break;
      case 'available_commands':
        // Every run opens with it (twice, identical), before any model call.
        if (Array.isArray(evt.commands)) {
          this.advertisedCommands = evt.commands.filter((c): c is string => typeof c === 'string');
        }
        if (Array.isArray(evt.tools))
          this.advertisedTools = evt.tools.filter((t): t is string => typeof t === 'string');
        break;
      case 'auto_compact_completed':
        // `/compact`, or grok's own compaction once the context passes its threshold.
        turn.compacted = true;
        this.emit(SESSION_EVENT.LOG, '[grok] grok compacted the conversation');
        break;
      case 'end':
        turn.end = evt;
        break;
      case 'error':
        turn.error = evt;
        break;
    }
  }

  protected async _run(message: string, options: GrokSendOptions): Promise<TurnResult> {
    const startedAt = Date.now();
    const { result, reconcile, endCost } = await this._runProcess(message, options);
    if (reconcile) await this._reconcileCost(startedAt, endCost);
    return result;
  }

  private _runProcess(
    message: string,
    options: GrokSendOptions,
  ): Promise<{ result: TurnResult; reconcile: boolean; endCost: number }> {
    // Read-only and workspace-write are grok's built-in `--sandbox read-only`
    // and `--sandbox workspace` profiles, enforced by the OS (Seatbelt on macOS,
    // Landlock on Linux). Both read anywhere; read-only writes only to ~/.grok/
    // and the temp directory, workspace also to the working directory.
    //
    // Read-only replaced a refusal. A `--tools` allowlist plus plan mode,
    // measured on 1.0.13, held for a direct and a shell write and lost to
    // delegation: the subagent did not inherit the restriction and wrote the
    // file. The sandbox is inherited by the whole process tree. Measured on
    // 1.0.50 against a repo outside temp, with `--permission-mode
    // bypassPermissions`: a direct write, a shell redirect, a delegated subagent,
    // a write on a resumed turn and a write outside the project all failed with
    // `Operation not permitted`, each one actually attempted (the agent reported
    // the error, not a refusal or a quota stop).
    //
    // What a profile cannot cover is refused rather than claimed:
    //   - a platform without Seatbelt or Landlock;
    //   - for read-only, a project under the temp directory, which the profile
    //     leaves writable (workspace-write may write its project either way).
    // And a sandbox that fails to apply does not fail closed in grok: it warns
    // and runs unsandboxed. The warning comes at startup, before any model call
    // (13 ms, measured), so the turn is killed on sight of it — see the stderr
    // handler below.
    const sandboxMode = this.options.sandboxMode;
    const sandbox = sandboxMode && SANDBOX_PROFILES[sandboxMode];
    if (sandbox) {
      if (process.platform !== 'darwin' && process.platform !== 'linux') {
        return Promise.reject(
          new Error(
            `Grok ${sandboxMode} needs grok's OS sandbox (Seatbelt or Landlock), which ${process.platform} does not have. Use a different engine for ${sandboxMode} work.`,
          ),
        );
      }
      if (sandboxMode === 'read-only' && this.options.cwd && underTempDir(this.options.cwd)) {
        return Promise.reject(
          new Error(
            "Grok read-only cannot protect a project under the temp directory: grok's read-only sandbox leaves temp writable. Move the project or use a different engine for read-only work.",
          ),
        );
      }
    }

    let prompt: { dir: string; file: string } | undefined;
    if (options.images?.length) {
      try {
        prompt = this._writeImagePrompt(message, options.images);
      } catch (err) {
        return Promise.reject(err);
      }
    }
    // The prompt file holds the images; it does not outlive the turn.
    const removePrompt = (): void => {
      if (prompt) fs.rmSync(prompt.dir, { recursive: true, force: true });
      prompt = undefined;
    };

    const args = this._buildArgs(options, prompt?.file);
    const creatingWorktree = !this.grokSessionId && !!this._worktreeFlag();
    const timeout = options.timeout || 300_000;

    return new Promise((resolve, reject) => {
      const turn: TurnState = {
        text: '',
        requests: 0,
        thought: false,
        compacted: false,
        started: new Set(),
        finished: new Set(),
        failed: new Set(),
      };
      // A chunk can end inside a line, and inside a multi-byte character.
      const decoder = new StringDecoder('utf8');
      let pending = '';
      let stderr = '';
      let settled = false;

      let proc: ReturnType<typeof spawnEngine>;
      try {
        proc = spawnEngine(this.engineBin, args, {
          launcher: this.options.launcher,
          cwd: this.options.cwd,
          env: { ...process.env },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (err) {
        removePrompt();
        reject(err);
        return;
      }
      this.currentProc = proc;
      // grok can exit before it reads stdin (a refused flag); unheard, the EPIPE
      // would be an uncaught 'error'.
      proc.stdin?.on('error', () => {});
      if (prompt) proc.stdin?.end();
      else proc.stdin?.end(message);

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          killEngineTree(proc);
          removePrompt();
          reject(new Error('Timeout waiting for Grok response'));
        }
      }, timeout);

      proc.stdout?.on('data', (d: Buffer) => {
        if (settled) return;
        pending += decoder.write(d);
        let nl: number;
        while ((nl = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, nl);
          pending = pending.slice(nl + 1);
          this._onLine(line, turn, options);
        }
      });

      proc.stderr?.on('data', (d: Buffer) => {
        const sanitized = sanitizeSecrets(d.toString());
        stderr += sanitized;
        this.emit(SESSION_EVENT.LOG, `[grok-stderr] ${sanitized}`);
        // grok carries on unsandboxed when a profile cannot be applied. For a
        // sandboxed session that is the one outcome that must not run.
        if (sandbox && !settled && SANDBOX_NOT_APPLIED_RE.test(stderr)) {
          settled = true;
          clearTimeout(timer);
          killEngineTree(proc);
          removePrompt();
          reject(
            new Error(
              `Grok could not apply its ${sandbox.label} sandbox, so the turn was stopped before it ran: ${stderr.trim().split('\n')[0]}`,
            ),
          );
        }
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        removePrompt();
        this.currentProc = null;
        if (!settled) {
          settled = true;
          reject(err);
        }
      });

      proc.on('close', (code) => {
        clearTimeout(timer);
        removePrompt();
        this.currentProc = null;
        if (settled) return;
        settled = true;

        // The last line may come without a newline.
        const rest = pending + decoder.end();
        pending = '';
        if (rest.trim()) this._onLine(rest, turn, options);

        // The `end` event carries everything the json object does but the reply,
        // which arrived as the `text` pieces. A refused turn (usage limit, auth)
        // ends with `{"type":"error","message":...}` instead.
        const parsed: GrokJsonResult | undefined = turn.end ? { ...turn.end, text: turn.text } : turn.error;
        const lastRequest = turn.lastRequest;

        // A turn that produced no parseable result object failed, whatever the
        // exit code says: there is no reply to hand back.
        const refusal = parsed?.type === 'error' ? parsed.message?.trim() || 'Grok reported an error' : undefined;
        const turnError =
          parsed?.error?.trim() ||
          refusal ||
          (!parsed ? stderr.trim() || `Grok exited with code ${code} and no JSON result` : undefined);

        if (parsed?.sessionId) {
          this.grokSessionId = parsed.sessionId;
          if (!this.sessionId?.startsWith('grok-live-')) this.sessionId = `grok-live-${parsed.sessionId}`;
        }
        // `cwd` on the turn that made the worktree is the worktree; the next
        // turn resumes there.
        if (creatingWorktree && turn.end?.cwd) this.worktreePath = turn.end.cwd;

        const text = parsed?.text ?? '';
        const ok = !turnError && code === 0 && parsed?.stopReason === SUCCESS_STOP_REASON;
        if (parsed && !turnError && parsed.stopReason !== SUCCESS_STOP_REASON) {
          this.emit(
            SESSION_EVENT.LOG,
            `[grok] the turn stopped for ${parsed.stopReason ?? 'no stated reason'}, which is not a completed turn`,
          );
        }

        // Answered by grok itself, with no model call: a shell built-in (`/goal
        // status`, `/session-info`, an unknown name). Its `end` carries no usage
        // and no cost, and nothing in the run asked the model. Not a turn: the
        // context figure stays what the last turn left (1.0.92: every local
        // reply measured this way; a refused model call still logs a `usage`).
        const local =
          ok &&
          !!turn.end &&
          turn.requests === 0 &&
          !turn.thought &&
          turn.started.size === 0 &&
          !turn.end.usage &&
          !turn.end.modelUsage &&
          turn.end.total_cost_usd === undefined;

        if (local) this._stats.lastActivity = new Date().toISOString();
        else this._recordTurnComplete(ok);
        this._stats.toolCalls += turn.started.size;
        this._stats.toolErrors += turn.failed.size;

        const usage = parsed?.usage;
        if (usage) {
          // Per-turn values (see the file header), so accumulate.
          const cacheRead = usage.cache_read_input_tokens ?? 0;
          const cacheWrite = usage.cache_creation_input_tokens ?? 0;
          this._stats.tokensIn += usage.input_tokens ?? 0;
          this._stats.tokensOut += usage.output_tokens ?? 0;
          this._stats.cachedTokens += cacheRead;
          this._stats.cacheCreationTokens += cacheWrite;
        }
        // The context is the prompt of the turn's last request — every
        // input-side token, not just the uncached remainder, since on a resumed
        // turn `input_tokens` is the small tail and the cached reads are most of
        // the context that has to fit. The turn's sum stands in only when no
        // request reported its own usage.
        const promptUsage = lastRequest ?? usage;
        if (promptUsage) {
          this._reportTurnInputTokens(
            (promptUsage.input_tokens ?? 0) +
              (promptUsage.cache_read_input_tokens ?? 0) +
              (promptUsage.cache_creation_input_tokens ?? 0),
          );
        }
        const reported = parsed?.modelUsage && Object.keys(parsed.modelUsage)[0];
        if (reported) this.grokModel = reported;
        // Engine-reported spend, not a registry lookup — see the file header.
        if (typeof parsed?.total_cost_usd === 'number' && Number.isFinite(parsed.total_cost_usd)) {
          this._stats.costUsd += parsed.total_cost_usd;
        }

        this._addHistory({ text, code });

        // The text itself went out piece by piece as it arrived (see _onLine).
        const event: StreamEvent = {
          type: 'result',
          result: text,
          stop_reason: ok ? 'end_turn' : 'error',
          session_id: this.grokSessionId,
        };
        this.emit(SESSION_EVENT.RESULT, event);
        this.emit(SESSION_EVENT.TURN_COMPLETE, event);

        if (turnError) {
          reject(new Error(turnError));
          return;
        }
        // The `end` line leaves out what grok could not cost (a cut-off
        // subagent, `cost_is_partial`) and some of a native goal's verifier
        // calls; `grok usage <id>` records the whole turn.
        const costMissing =
          (turn.requests > 0 || !!parsed?.usage) &&
          (typeof parsed?.total_cost_usd !== 'number' ||
            !!turn.end?.cost_is_partial ||
            !!turn.end?.usage_is_incomplete);
        resolve({
          result: { text, event, ...(local ? { localCommand: true } : {}) },
          // A goal's planner and verifiers run as subagents whose calls the
          // stream may not show, so a goal turn is read whatever it looked like.
          reconcile: !!options.grok?.reconcileCost || (!local && costMissing),
          endCost: typeof parsed?.total_cost_usd === 'number' ? parsed.total_cost_usd : 0,
        });
      });
    });
  }

  // ── Sends and commands ────────────────────────────────────────────────

  /**
   * A command print mode cannot do is refused here, before anything runs (see
   * `grokCommandRefusal`); `/compact` is compacted and checked (`compactDetailed`).
   * A session that sends text verbatim (`disableSlashCommands`) has no commands.
   */
  override async send(
    message: string | unknown[],
    options: GrokSendOptions = {},
  ): Promise<TurnResult | { requestId: number; sent: boolean }> {
    const commands = !this.options.disableSlashCommands || !!options.grok?.slashCommands;
    const cmd = typeof message === 'string' && commands ? parseGrokCommand(message) : undefined;
    if (cmd && !options.grok?.internal) {
      if (cmd.name === 'compact') {
        const outcome = await this.compactDetailed();
        if (!outcome.ok) throw new Error(outcome.note ?? 'grok did not compact the conversation');
        const text = this._compactSummary(outcome);
        return { text, event: { type: 'result', result: text, stop_reason: 'end_turn' }, localCommand: true };
      }
      const refusal = grokCommandRefusal(message as string, await this._workflowNames(cmd.name));
      if (refusal) throw new Error(refusal);
    }
    // A goal set or resumed by hand runs as the goal adapter's turns do (see runGoalTurn).
    if (cmd?.name === 'goal' && !grokCommandIsLocal('goal', cmd.args)) {
      options = { ...options, grok: { ...options.grok, waitForBackground: true, reconcileCost: true } };
    }
    return super.send(message, options);
  }

  /**
   * What this session can run: grok's shell built-ins, its skills and
   * workflows (ACP `_x.ai/commands/list`, else the names the last run
   * advertised), and its TUI commands, listed as needing a person.
   */
  async listCommands(): Promise<EngineCommand[]> {
    const read = await this._acpCommandList().catch((err: Error) => {
      this.emit(SESSION_EVENT.LOG, `[grok] could not read grok's command list over ACP: ${err.message}`);
      return undefined;
    });
    const extra: EngineCommand[] =
      read?.commands ??
      (this.advertisedCommands ?? [])
        .filter((n) => !grokShellCommand(n) && !(n in GROK_PAGER_COMMANDS))
        .map((name) => ({ name, source: 'skill' as const, startsTurn: true }));
    const seen = new Set<string>();
    return [...GROK_SHELL_COMMANDS, ...extra, ...grokPagerCommands()].filter((c) =>
      seen.has(c.name) ? false : (seen.add(c.name), true),
    );
  }

  /**
   * Run `/name args`. A command grok answers locally runs as a process of its
   * own beside the turns (no turn, nothing billed); one that starts a turn
   * runs as a send. `compact` is `compactDetailed`.
   */
  async runCommand(
    name: string,
    args?: string,
    opts: { timeout?: number; callbacks?: StreamCallbacks } = {},
  ): Promise<CommandOutcome> {
    const argText = args?.trim() ?? '';
    const text = `/${name}${argText ? ` ${argText}` : ''}`;
    const timeout = opts.timeout || TURN_TIMEOUT_MS;
    if (name === 'compact') {
      const outcome = await this.compactDetailed(argText || undefined);
      return {
        name,
        ok: outcome.ok,
        text: outcome.ok ? this._compactSummary(outcome) : '',
        data: outcome,
        startedTurn: false,
        ...(outcome.ok ? {} : { error: outcome.note ?? 'grok did not compact the conversation' }),
      };
    }
    const refusal = grokCommandRefusal(text, await this._workflowNames(name));
    if (refusal) throw new Error(refusal);
    if (grokCommandIsLocal(name, argText)) {
      const r = await this.runLocalCommand(text, Math.min(timeout, LOCAL_COMMAND_TIMEOUT_MS));
      return { name, ok: !r.error, text: r.text, startedTurn: false, ...(r.error ? { error: r.error } : {}) };
    }
    await this._checkCommandKnown(name);
    try {
      const r = (await this.send(text, {
        waitForComplete: true,
        timeout,
        callbacks: opts.callbacks,
        grok: { internal: true, slashCommands: true },
      })) as TurnResult;
      return { name, ok: true, text: r.text, startedTurn: !r.localCommand };
    } catch (err) {
      return { name, ok: false, text: '', startedTurn: true, error: (err as Error).message };
    }
  }

  /**
   * Run a command grok answers itself (`/session-info`, `/goal status`, …).
   *
   * With a conversation, as a process of its own on it, after the turn in
   * flight (grok runs one process per session at a time here). Before the first
   * turn, as a send: that run creates the conversation, with the session's
   * options, and the session keeps it.
   */
  async runLocalCommand(text: string, timeout = LOCAL_COMMAND_TIMEOUT_MS): Promise<{ text: string; error?: string }> {
    if (!this.grokSessionId) {
      await this._whenIdle(timeout);
      try {
        const r = (await this.send(text, {
          waitForComplete: true,
          timeout,
          grok: { internal: true, slashCommands: true },
        })) as TurnResult;
        return { text: r.text };
      } catch (err) {
        return { text: '', error: (err as Error).message };
      }
    }
    const run = await this._sidePrint(['--resume', this.grokSessionId], text, timeout, { slashCommands: true });
    return { text: run.text, ...(run.error ? { error: run.error } : {}) };
  }

  /**
   * `/compact`, and the proof it worked: grok reports `auto_compact_completed`
   * even when its compaction call was refused (1.0.92, at the usage limit:
   * 24403 → 24506 tokens), so the context is read from `/session-info` before
   * and after, and the outcome is `ok` only when it shrank. grok's `/compact`
   * takes no summary. The compaction's own call is billed nowhere grok reports.
   */
  async compactDetailed(summary?: string): Promise<CompactOutcome> {
    const unused = summary?.trim() ? " grok's /compact takes no summary; the one given was not used." : '';
    if (!this.grokSessionId) {
      return {
        ok: true,
        trigger: 'manual',
        note: `nothing to compact: the session has no grok conversation yet.${unused}`,
      };
    }
    const startedAt = Date.now();
    const before = await this._sessionContext();
    // A conversation no model turn has written to holds only grok's own
    // preamble; compacting it took 117 s and grew it (1266 → 31382 tokens, 1.0.92).
    if (before?.turn === 0) {
      return {
        ok: true,
        trigger: 'manual',
        preTokens: before.used,
        postTokens: before.used,
        note: `nothing to compact: the conversation has no turns yet.${unused}`,
      };
    }
    try {
      await this.send('/compact', {
        waitForComplete: true,
        timeout: COMPACT_TIMEOUT_MS,
        grok: { internal: true, slashCommands: true },
      });
    } catch (err) {
      return {
        ok: false,
        trigger: 'manual',
        ...(before ? { preTokens: before.used } : {}),
        note: `grok's /compact failed: ${(err as Error).message}${unused}`,
      };
    }
    const after = await this._sessionContext();
    const counts = { ...(before ? { preTokens: before.used } : {}), ...(after ? { postTokens: after.used } : {}) };
    if (before && after && after.used < before.used) {
      // The next turn reads the compacted conversation.
      this._reportTurnInputTokens(after.used);
      return { ok: true, trigger: 'manual', ...counts, ...(unused ? { note: unused.trim() } : {}) };
    }
    const refused = latestGrokRefusal({ sinceMs: startedAt });
    const why =
      !before || !after
        ? "grok's /compact ran, but /session-info did not report the context size, so whether it shrank is unknown"
        : `grok reported the compaction done, but the context did not shrink (${before.used} → ${after.used} tokens)`;
    return {
      ok: false,
      trigger: 'manual',
      ...counts,
      note: `${why}${refused ? `; grok's compaction call was refused: ${refused.message}` : ''}.${unused}`,
    };
  }

  /** `compact()` for a caller that does not use `compactDetailed`: the same, as a turn result. */
  override async compact(summary?: string): Promise<TurnResult> {
    const outcome = await this.compactDetailed(summary);
    const text = outcome.ok ? this._compactSummary(outcome) : (outcome.note ?? 'grok did not compact the conversation');
    return { text, event: { type: 'result', result: text, compacted: outcome.ok } };
  }

  private _compactSummary(outcome: CompactOutcome): string {
    if (outcome.preTokens !== undefined && outcome.postTokens !== undefined) {
      return `compacted: ${outcome.preTokens} → ${outcome.postTokens} tokens${outcome.note ? `. ${outcome.note}` : ''}`;
    }
    return outcome.note ?? 'compacted';
  }

  /**
   * A side question, answered on a fork of the conversation, so the session's
   * own conversation is unchanged: `--resume <id> --fork-session`, one model
   * round, every tool removed (built-ins through `--disallowed-tools`, MCP tools
   * by a deny rule, no subagents), and a rule that says so — told nothing, the
   * model answered with a plan to look around first (1.0.92). The fork stays in
   * grok's session store. Its spend counts in the session's stats; it is not a
   * turn.
   */
  async askAside(question: string, opts: { timeout?: number } = {}): Promise<AsideOutcome> {
    if (!this.grokSessionId) {
      throw new Error('a side question needs a grok conversation to ask about; send the session a message first');
    }
    const timeout = opts.timeout || TURN_TIMEOUT_MS;
    const tools = this.advertisedTools?.length ? this.advertisedTools : GROK_TOOLS;
    const model = this.options.resolvedModel || this.options.model;
    const run = await this._sidePrint(
      [
        '--resume',
        this.grokSessionId,
        '--fork-session',
        '--max-turns',
        '1',
        '--no-subagents',
        '--deny',
        'MCPTool',
        '--disallowed-tools',
        tools.join(','),
        withValue('--rules', ASIDE_RULES),
        ...(model ? ['--model', this.resolveModel(model.replace(/^grok\//, ''))] : []),
      ],
      question,
      timeout,
      { slashCommands: false },
    );
    const usage = run.end?.usage;
    if (usage) {
      this._stats.tokensIn += usage.input_tokens ?? 0;
      this._stats.tokensOut += usage.output_tokens ?? 0;
      this._stats.cachedTokens += usage.cache_read_input_tokens ?? 0;
      this._stats.cacheCreationTokens += usage.cache_creation_input_tokens ?? 0;
    }
    if (typeof run.end?.total_cost_usd === 'number') this._stats.costUsd += run.end.total_cost_usd;
    if (run.error) throw new Error(run.error);
    if (!run.text.trim()) {
      throw new Error(
        `grok gave no answer to the side question (it stopped for ${run.end?.stopReason ?? 'no stated reason'})`,
      );
    }
    return { text: run.text };
  }

  /** A model switch takes effect on the next process; nothing is running to restart. */
  async setModelLive(model: string): Promise<boolean> {
    this.options.model = model;
    this.options.resolvedModel = model;
    return true;
  }

  // ── Native goal ────────────────────────────────────────────────────────

  /** grok's own `/goal` loop behind the goal node's surface (`nativeGoal`); see grok-goal-session.ts. */
  nativeGoalSession(open?: GrokGoalOpen): GoalSession {
    return new GrokGoalSession(this, open);
  }

  /** One goal process: slash commands on, grok let wait for the goal's later rounds, spend read from `grok usage`. */
  async runGoalTurn(text: string, opts: { timeout: number }): Promise<TurnResult> {
    return (await this.send(text, {
      waitForComplete: true,
      timeout: opts.timeout,
      grok: { internal: true, slashCommands: true, waitForBackground: true, reconcileCost: true },
    })) as TurnResult;
  }

  /** The goal in the session's `goal/state.json`: null when the session has none, undefined when unreadable. */
  readGoalState(): GrokGoalState | null | undefined {
    const id = this.grokSessionId;
    if (!id) return undefined;
    this.grokSessionDir ??= findGrokSessionDir(id);
    if (!this.grokSessionDir) return undefined;
    const file = path.join(this.grokSessionDir, 'goal', 'state.json');
    if (!fs.existsSync(file)) return null;
    try {
      return parseGrokGoalStateFile(JSON.parse(fs.readFileSync(file, 'utf8'))) ?? undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * A usage-limit refusal grok logged since `sinceMs`, if no model call has
   * succeeded after it. Any session's: the limit is the account's, and a goal's
   * planner and verifiers run as subagents under session ids of their own
   * (1.0.92: the planner's 429 was logged under the subagent's id).
   */
  usageLimitSince(sinceMs: number): string | undefined {
    return latestGrokRefusal({ sinceMs })?.message;
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  /** Wait until no turn is running, at most `timeoutMs`. */
  private async _whenIdle(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.isBusy) {
      if (Date.now() >= deadline) throw new Error('the grok session is still running a turn; try again when it ends');
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  /** The skills and workflows grok lists over ACP, read at most once a minute. */
  private async _acpCommandList(): Promise<{ commands: EngineCommand[]; workflows: Set<string> }> {
    if (this.acpCommands && Date.now() - this.acpCommands.at < COMMAND_LIST_TTL_MS) return this.acpCommands;
    const workflows = new Set<string>();
    const result = await grokAcpCall(
      '_x.ai/commands/list',
      {},
      {
        bin: this.engineBin,
        cwd: this._runCwd(),
        launcher: this.options.launcher,
      },
    );
    const commands = commandsFromGrokAcpList(result, workflows);
    this.acpCommands = { at: Date.now(), commands, workflows };
    return this.acpCommands;
  }

  /**
   * Refuse a name grok has no command or workflow for: sent as `/name` it
   * reaches the model as a message, a paid turn. Only a listing read over ACP
   * refuses, and it is read again once first, for one added since.
   */
  private async _checkCommandKnown(name: string): Promise<void> {
    if (grokShellCommand(name)) return;
    const known = (r: { commands: EngineCommand[]; workflows: Set<string> } | undefined) =>
      !r || r.commands.some((c) => c.name === name) || r.workflows.has(name);
    if (known(await this._acpCommandList().catch(() => undefined))) return;
    this.acpCommands = undefined;
    if (!known(await this._acpCommandList().catch(() => undefined))) {
      throw new Error(
        `there is no command /${name} on this grok session: session_command list shows what there is, ` +
          'and session_send sends the text to the model as a message',
      );
    }
  }

  /** The workflows a `/name` could launch; read only for a name that is not a built-in. */
  private async _workflowNames(name: string): Promise<ReadonlySet<string>> {
    if (grokShellCommand(name) || name in GROK_PAGER_COMMANDS) return new Set();
    try {
      return (await this._acpCommandList()).workflows;
    } catch {
      return new Set();
    }
  }

  /** The context `/session-info` reports, and grok's window for it. */
  private async _sessionContext(): Promise<{ used: number; total: number; turn?: number } | undefined> {
    const r = await this.runLocalCommand('/session-info');
    const context = parseGrokSessionContext(r.text);
    if (context?.total) this.grokWindow = context.total;
    return context;
  }

  /**
   * Add what the turn cost beyond its `end` line, from grok's per-turn record
   * (`grok usage <id>`: costUsdTicks, 1e10 per dollar). Measured on a native
   * goal: $0.515 over 19 calls on `end`, $0.612 over 22 in the record.
   */
  private async _reconcileCost(startedAt: number, endCost: number): Promise<void> {
    const id = this.grokSessionId;
    if (!id) return;
    let record: { turns?: Array<{ endedAt?: string; costUsdTicks?: number }> };
    try {
      record = JSON.parse(await this._sideCapture(['usage', id], 15_000)) as typeof record;
    } catch (err) {
      this.emit(SESSION_EVENT.LOG, `[grok] could not read the turn's spend from grok usage: ${(err as Error).message}`);
      return;
    }
    const last = record.turns?.at(-1);
    const ended = last?.endedAt ? Date.parse(last.endedAt) : Number.NaN;
    // A record from before this turn is an earlier turn's, not this one's.
    if (!last || !Number.isFinite(ended) || ended < startedAt - 5_000) return;
    const ticks = Number(last.costUsdTicks);
    if (!Number.isFinite(ticks)) return;
    const missing = ticks / 1e10 - endCost;
    if (missing > 1e-9) {
      this._stats.costUsd += missing;
      this.emit(
        SESSION_EVENT.LOG,
        `[grok] the turn cost $${(ticks / 1e10).toFixed(4)} by grok's record; its end line reported $${endCost.toFixed(4)}`,
      );
    }
  }

  /** Run one side process at a time, after the ones before it. */
  private _sideQueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.sideChain.then(fn, fn);
    this.sideChain = run.catch(() => undefined);
    return run;
  }

  /**
   * A print-mode run beside the turns, read whole: `grok -p` with `extra`
   * after the folder, `message` on stdin. It waits for the turn in flight and
   * touches none of the turn bookkeeping.
   */
  private _sidePrint(
    extra: string[],
    message: string,
    timeoutMs: number,
    opts: { slashCommands: boolean },
  ): Promise<PrintRun> {
    return this._sideQueue(async () => {
      await this._whenIdle(timeoutMs);
      const cwd = this._runCwd();
      const args = ['-p', '--output-format', 'streaming-json', ...(cwd ? ['--cwd', cwd] : []), ...extra];
      if (this.options.trustProject) args.push('--trust');
      if (!opts.slashCommands) args.push('--verbatim');
      args.push('--no-wait-for-background');
      const { stdout, stderr, code } = await this._spawnSide(args, message, timeoutMs);
      let text = '';
      let end: GrokStreamEvent | undefined;
      let error: string | undefined;
      for (const raw of stdout.split('\n')) {
        const line = raw.trim();
        if (!line.startsWith('{')) continue;
        let evt: GrokStreamEvent;
        try {
          evt = JSON.parse(line) as GrokStreamEvent;
        } catch {
          continue;
        }
        if (evt.type === 'text' && typeof evt.data === 'string') text += evt.data;
        else if (evt.type === 'end') end = evt;
        else if (evt.type === 'error') error = evt.message?.trim() || 'Grok reported an error';
      }
      if (!end && !error) error = stderr.trim() || `Grok exited with code ${code} and no JSON result`;
      if (end?.error) error = end.error;
      return { text, ...(end ? { end } : {}), ...(error ? { error } : {}) };
    });
  }

  /** `grok <args>` beside the turns, its stdout; throws on a non-zero exit. */
  private _sideCapture(args: string[], timeoutMs: number): Promise<string> {
    return this._sideQueue(async () => {
      const { stdout, stderr, code } = await this._spawnSide(args, undefined, timeoutMs);
      if (code !== 0) throw new Error(stderr.trim().split('\n')[0] || `grok exited with code ${code}`);
      return stdout;
    });
  }

  private _spawnSide(
    args: string[],
    input: string | undefined,
    timeoutMs: number,
  ): Promise<{ stdout: string; stderr: string; code: number | null }> {
    return new Promise((resolve, reject) => {
      let proc: ChildProcess;
      try {
        proc = spawnEngine(this.engineBin, args, {
          launcher: this.options.launcher,
          cwd: this.options.cwd,
          env: { ...process.env },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (err) {
        reject(err);
        return;
      }
      this.sideProcs.add(proc);
      let stdout = '';
      let stderr = '';
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        killEngineTree(proc);
        this.sideProcs.delete(proc);
        reject(new Error(`grok ${args[0] === '-p' ? 'run' : args[0]} took longer than ${timeoutMs} ms`));
      }, timeoutMs);
      proc.stdin?.on('error', () => {});
      proc.stdin?.end(input ?? '');
      proc.stdout?.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
      proc.stderr?.on('data', (d: Buffer) => (stderr += sanitizeSecrets(d.toString())));
      proc.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.sideProcs.delete(proc);
        reject(err);
      });
      proc.on('close', (code) => {
        this.sideProcs.delete(proc);
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ stdout, stderr, code });
      });
    });
  }

  /** Also stops the side processes (local commands, asides, `grok usage`). */
  override stop(): void {
    for (const proc of this.sideProcs) killEngineTree(proc);
    this.sideProcs.clear();
    super.stop();
  }

  /** Grok's resumable session id and the worktree it made, surfaced through getStats(). */
  getStats(): ReturnType<BaseOneShotSession['getStats']> & { grokSessionId?: string; grokWorktreePath?: string } {
    return { ...super.getStats(), grokSessionId: this.grokSessionId, grokWorktreePath: this.worktreePath };
  }
}
