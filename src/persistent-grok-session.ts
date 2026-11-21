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
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { killEngineTree, spawnEngine } from './engine-spawn.js';

import type { SessionConfig, SessionSendOptions, StreamEvent, TurnResult } from './types.js';
import { sanitizeSecrets } from './sanitize.js';
import { BaseOneShotSession } from './base-oneshot-session.js';
import { SESSION_EVENT } from './constants.js';

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
}

/** What one turn's stream has said so far. */
interface TurnState {
  text: string;
  end?: GrokJsonResult;
  error?: GrokJsonResult;
  /** The usage of the turn's last request: the context size. */
  lastRequest?: GrokUsage;
  /** Tool calls started, finished, and finished as failed, by `toolCallId`. */
  started: Set<string>;
  finished: Set<string>;
  failed: Set<string>;
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

  /** `--worktree[=name]` when this session asked for a new worktree, else undefined. */
  private _worktreeFlag(): string | undefined {
    const worktree = this.options.worktree;
    if (worktree === true || worktree === 'true') return '--worktree';
    // The equals form: `--worktree NAME` would also take the next word as its
    // name, which is how grok's own docs say a prompt gets swallowed.
    if (typeof worktree === 'string' && worktree) return withValue('--worktree', worktree);
    return undefined;
  }

  private _buildArgs(options: SessionSendOptions, promptFile?: string): string[] {
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

    const model = this.options.resolvedModel || this.options.model;
    if (model) args.push('--model', this.resolveModel(model.replace(/^grok\//, '')));

    // grok's --permission-mode vocabulary is the same set as ours, so this is a
    // passthrough rather than a mapping. 'manual' is ours alone; grok calls the
    // equivalent 'default'.
    const mode = this.options.permissionMode === 'manual' ? 'default' : this.options.permissionMode;
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

    if (this.options.dangerouslySkipPermissions) args.push('--always-approve');

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
    // Without it a message starting with /name is taken as a slash command.
    if (this.options.disableSlashCommands) args.push('--verbatim');

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
    args.push('--no-wait-for-background');

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
        if (evt.usage) turn.lastRequest = evt.usage;
        break;
      case 'end':
        turn.end = evt;
        break;
      case 'error':
        turn.error = evt;
        break;
    }
  }

  protected _run(message: string, options: SessionSendOptions): Promise<TurnResult> {
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

    return new Promise<TurnResult>((resolve, reject) => {
      const turn: TurnState = { text: '', started: new Set(), finished: new Set(), failed: new Set() };
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

        this._recordTurnComplete(ok);
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

        if (turnError) reject(new Error(turnError));
        else resolve({ text, event });
      });
    });
  }

  /** Grok's resumable session id and the worktree it made, surfaced through getStats(). */
  getStats(): ReturnType<BaseOneShotSession['getStats']> & { grokSessionId?: string; grokWorktreePath?: string } {
    return { ...super.getStats(), grokSessionId: this.grokSessionId, grokWorktreePath: this.worktreePath };
  }
}
