/**
 * Persistent OpenCode Session — wraps `opencode run` (sst/opencode CLI).
 *
 * Each send() spawns a new `opencode` process in non-interactive mode.
 * `--format json` streams NDJSON events. The schema (from
 * packages/opencode/src/cli/cmd/run.ts) is:
 *
 *     { type, timestamp, sessionID, ...data }
 *
 * with these event types:
 *   - text          { part: { type:"text", text, id, ... } }
 *   - reasoning     { part: { type:"reasoning", text, ... } }
 *   - tool_use      { part: { type:"tool", callID, tool, state, ... } }
 *                   (re-emitted as state transitions; no separate tool_result)
 *   - step_start    { part: { type:"step-start", ... } }
 *   - step_finish   { part: { type:"step-finish", tokens:{input,output,
 *                             reasoning,cache:{read,write}}, cost, ... } }
 *   - error         { error: ... }
 *
 * `text` and `tool_use` events are CUMULATIVE — each emission carries the
 * latest snapshot of the same `part.id`. We diff against the previous
 * snapshot to compute streaming deltas for onText callbacks, and collapse
 * to the final per-part value at turn close.
 *
 * Provider-agnostic: opencode's `--model` uses `provider/model` form (e.g.
 * `anthropic/claude-sonnet-4`). We pass `--model` through only when the
 * configured value contains a `/`; otherwise opencode's default applies.
 *
 * Permissions: on opencode 1.17.15's `run`, a tool that would prompt for a
 * permission is auto-REJECTED in non-interactive mode (it does not hang), so a
 * write-enabled session needs no skip flag. `dangerouslySkipPermissions` sends
 * `--auto` (both lines), which answers those requests "once" instead; a rule
 * that denies still denies. It is not derived from `permissionMode`, which
 * defaults to `bypassPermissions` on every one-shot engine. OpenCode 2's `run`
 * rejects an `ask` the same way (measured on 2.3.2), but its default policy
 * allows everything, paths outside the project included, where V1 asked for
 * those.
 *
 * OpenCode 2 (2.x) keeps `run --format json` and the same event stream, and
 * differs where this wrapper touches it (all measured on 2.3.2):
 *   - `--standalone` is required. Without it `run` hands the turn to the
 *     background service when one is running (the desktop app starts one), and
 *     that service has its own configuration and environment: the read-only
 *     agent this wrapper injects comes back "Agent not found".
 *   - effort is `--model provider/model#variant`; `--variant` is gone. A variant
 *     the model does not offer fails the turn (`Variant unavailable`) before the
 *     model is called, where V1 ran the default.
 *   - agent configuration is a different shape (`agents`, ordered `permissions`
 *     rules, no `tools` map) and the shell tool is `shell`, not `bash`, so the
 *     read-only agent has its own V2 definition.
 *   - an `--agent` that does not exist fails the turn instead of falling back to
 *     the default, writable agent.
 *   - an `--agent` stays the session's agent for the turns after it, so a turn
 *     after a `plan` turn names the agent to go back to.
 *
 * On OpenCode 2 a session holds a private server (`OpencodeServer`) while it is
 * in use and runs its turns as `run --server <url>` clients of it; the server is
 * stopped after `SERVER_IDLE_MS` without use. Through it the session reaches what
 * `run` has no flag for: steering the turn in flight (`deliverMidTurn`), an
 * interrupt the server's execution honours, engine commands (`runCommand`, with
 * clawo's own operations beside them), compaction, side questions, reverts,
 * shell commands, skills and the native `/goal` (`OpencodeGoalSession`). A server
 * that does not start leaves turns on `--standalone`, as before. OpenCode 1 runs
 * a command as `run --command <name>`.
 */

import { execEngine, killEngineTree, spawnEngine } from './engine-spawn.js';
import * as readline from 'node:readline';
import type { ChildProcess } from 'node:child_process';

import type {
  AsideOutcome,
  CommandOutcome,
  CompactOutcome,
  EffortLevel,
  EngineCommand,
  RewindOutcome,
  RewindTarget,
  SessionConfig,
  SessionSendOptions,
  StreamCallbacks,
  StreamEvent,
  TurnResult,
} from './types.js';
import { estimateTokens } from './models.js';
import { sanitizeSecrets } from './sanitize.js';
import { SESSION_EVENT, TURN_TIMEOUT_MS } from './constants.js';
import { BaseOneShotSession } from './base-oneshot-session.js';
import {
  OPENCODE_BUILTIN_COMMANDS,
  OpencodeApiError,
  OpencodeServer,
  assistantText,
  foldMessages,
  followSessionWork,
  messagesAfter,
  newestMessageId,
  promptTokens,
  type OpencodeMessage,
  type OpencodeTokens,
} from './opencode-server.js';
import { OpencodeGoalSession, type OpencodeGoalState } from './opencode-goal-session.js';
import type { ClaudeGoalOpen } from './claude-goal-session.js';
import type { GoalSession } from './kernel/nodes/goal.js';
import { parseUsageLimits, readUsageLimitsStandalone, type OpencodeUsageLimits } from './opencode-quota.js';

/**
 * Read-only enforcement for opencode.
 *
 * opencode ships a `plan` agent, but it is a user-overridable preset: on a
 * stock install its rules begin with `{"permission":"*","action":"allow"}` and
 * deny neither `bash` nor `edit`, so a "read-only" session could still author
 * files through a shell heredoc. We therefore define our own agent and hand it
 * to the CLI via `OPENCODE_CONFIG_CONTENT`, with the write paths denied at the
 * permission-engine level AND the corresponding tools removed.
 *
 * Verify this config only with adversarial writes, and include prompts that ask
 * the agent to delegate — `opencode agent list` renders compiled rules that look
 * identical for a safe and an unsafe agent, and a probe that only asks the agent
 * to write directly passes even when the delegation path is wide open.
 */
const READ_ONLY_AGENT = 'clawo-readonly';
const READ_ONLY_AGENT_CONFIG = JSON.stringify({
  agent: {
    [READ_ONLY_AGENT]: {
      mode: 'primary',
      permission: {
        edit: 'deny',
        bash: 'deny',
        external_directory: 'deny',
        // Denying the write tools is not enough on its own: the agent can hand
        // the work to a subagent via `task`, and the subagent runs under the
        // default (writable) agent, so the denials above never apply to it.
        // Asked to "delegate this to a subagent", a session denied only
        // edit/bash/external_directory wrote to disk on every attempt.
        task: 'deny',
        webfetch: 'deny',
      },
      // Belt-and-suspenders: drop the tools outright as well, so enforcement
      // does not depend on the permission engine resolving our rules the way we
      // expect. `task` is the escalation path; the rest are the direct ones.
      tools: {
        task: false,
        write: false,
        edit: false,
        bash: false,
        patch: false,
      },
    },
  },
});

/**
 * The same agent for OpenCode 2, as an allowlist. V2 rules are ordered and the
 * last match wins; agent rules come after the global and project ones, so a
 * user's own `allow` cannot reopen what this denies. Denying `*` first covers
 * every action, including ones a plugin or MCP server adds and the
 * `subagent` action (V1's `task`) that would hand a write to another agent,
 * which on V2 runs under its own permissions rather than these. Measured on
 * 2.3.2: write, a shell heredoc, delegation to a subagent and a read outside the
 * project were all refused, and the denied tools are not offered to the model.
 */
const READ_ONLY_AGENT_CONFIG_V2 = JSON.stringify({
  agents: {
    [READ_ONLY_AGENT]: {
      mode: 'primary',
      description: 'claw-orchestrator read-only session',
      permissions: [
        { action: '*', resource: '*', effect: 'deny' },
        { action: 'read', resource: '*', effect: 'allow' },
        { action: 'glob', resource: '*', effect: 'allow' },
        { action: 'grep', resource: '*', effect: 'allow' },
        // V2's own default for secrets, which the `read` allow above would
        // otherwise override. `ask` is rejected in a non-interactive run.
        { action: 'read', resource: '*.env', effect: 'ask' },
        { action: 'read', resource: '*.env.*', effect: 'ask' },
        { action: 'read', resource: '*.env.example', effect: 'allow' },
      ],
    },
  },
});

/**
 * OpenCode 1's warning for an `--agent` it will not run, after which it runs
 * the default, writable agent. Two forms: `agent "X" not found` and `agent "X"
 * is a subagent, not a primary agent`. Measured on 1.19.6: it goes to stderr,
 * with ANSI colour codes, before the prompt is sent; stdout carries only JSON.
 * OpenCode 2 fails the turn instead.
 */
const AGENT_FALLBACK_RE =
  /(agent "[^"]*" (?:not found|is a subagent, not a primary agent))?\.? *Falling back to default agent/;

/**
 * `--flag=value` as one argument: a value that starts with `-` stays a value,
 * and OpenCode 1's yargs array options (`--file`) cannot swallow the tokens
 * after a bare flag. Both lines accept the form (measured on 1.19.6 and 2.3.2).
 */
function flagValue(flag: string, value: string): string {
  return `${flag}=${value}`;
}

/** How long a held server is kept with nothing using it. */
export const SERVER_IDLE_MS = 30_000;

/** Set to `1` to run every OpenCode 2 turn on `--standalone`, with no held server. */
const STANDALONE_ENV = 'CLAWO_OPENCODE_STANDALONE';

/** OpenCode 2's primary agent when nobody named one. */
const DEFAULT_AGENT = 'build';

/** `provider/model#variant` as the API's model reference. */
export function modelRef(model: string | undefined): { providerID: string; id: string; variant?: string } | undefined {
  if (!model || !model.includes('/')) return undefined;
  const slash = model.indexOf('/');
  const [id, variant] = model.slice(slash + 1).split('#', 2);
  if (!id) return undefined;
  return { providerID: model.slice(0, slash), id, ...(variant ? { variant } : {}) };
}

/**
 * Operations clawo runs through the held server beside OpenCode's own commands.
 * `startsTurn: false` ones only read, so they run beside a turn.
 */
const CLAWO_OPERATIONS: readonly EngineCommand[] = [
  {
    name: 'compact',
    description: 'compact the conversation and wait for it (OpenCode writes the summary)',
    source: 'rpc',
    startsTurn: true,
  },
  {
    name: 'shell',
    description: "run a shell command; its output goes to the agent's next turn, no model call",
    source: 'rpc',
    args: '<command>',
    startsTurn: true,
  },
  {
    name: 'skill',
    description: 'load a skill into the conversation without a turn',
    source: 'rpc',
    args: '<skill id>',
    startsTurn: true,
  },
  { name: 'goal-status', description: "the native goal's state", source: 'rpc', startsTurn: false },
  { name: 'models', description: 'the models OpenCode can run', source: 'rpc', startsTurn: false },
  { name: 'agents', description: 'the agents OpenCode has, primary and subagent', source: 'rpc', startsTurn: false },
  { name: 'skills', description: 'the skills OpenCode loads', source: 'rpc', startsTurn: false },
  { name: 'mcp', description: 'the MCP servers and their status', source: 'rpc', startsTurn: false },
  { name: 'usage', description: 'OpenCode Go usage limits', source: 'rpc', startsTurn: false },
];

/** `goal` arguments that change the goal's state without a turn. */
const GOAL_NO_TURN_ARGS: ReadonlySet<string> = new Set(['pause', 'clear']);

/**
 * Sessions a stopped ephemeral session created, waiting to be deleted, by
 * OpenCode session id.
 *
 * Deletion waits briefly because the session manager's restarts — a model
 * switch, a tool update — stop a session and at once start it again resuming
 * the same id, with the same `noSessionPersistence`. A new session constructed
 * with that id takes the pending delete over (see the constructor) and deletes
 * it when it stops in turn. The timer is not unref'd, so a process whose last
 * act is stopping a session still deletes it before exiting.
 */
const pendingDeletes = new Map<string, ReturnType<typeof setTimeout>>();
const DELETE_GRACE_MS = 2_000;

/** `opencode session delete <id>`, best effort. */
function deleteOpencodeSession(
  bin: string,
  id: string,
  v2: boolean,
  launcher: readonly string[] | undefined,
  log: (message: string) => void,
): void {
  // V2 without `--standalone` hands the command to the background service, and
  // starts one (left running) when none is up — measured on 2.3.2.
  const args = ['session', 'delete', ...(v2 ? ['--standalone'] : []), id];
  const [head, ...rest] = launcher ?? [];
  const run = head
    ? execEngine(head, [...rest, bin, ...args], { timeout: 30_000 })
    : execEngine(bin, args, { timeout: 30_000 });
  run.then(
    () => log(`[opencode] deleted session ${id}`),
    (err: unknown) =>
      log(`[opencode] could not delete session ${id}: ${sanitizeSecrets(String((err as Error)?.message ?? err))}`),
  );
}

interface TurnState {
  /** Per-part latest text snapshot, keyed by part.id (preserves insertion order). */
  textParts: Map<string, string>;
  /** Tool callIDs we've seen (count once per unique tool invocation). */
  seenTools: Set<string>;
  /** Tool callIDs that ended in error state. */
  erroredTools: Set<string>;
  gotUsage: boolean;
  /** The message of the last `error` event, so a failed turn says why. */
  errorMessage?: string;
  /** OpenCode 2 refused the `#variant` this turn asked for (`Variant unavailable`). */
  variantUnavailable: boolean;
  /**
   * This turn creates or forks a session, so the id its events carry is a new
   * one this session takes over. A fork's events all carry the fork's id.
   */
  adoptSessionId: boolean;
  /** The session it adopts was made by this turn (a new one or a fork), not named by the caller. */
  createsSession: boolean;
}

/** The text of an `error` event: V2 sends `{ error: { type, message } }`, V1 a string or `{ data: { message } }`. */
function errorEventMessage(event: Record<string, unknown>): string | undefined {
  const err = event.error ?? event.message;
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object') {
    const e = err as { message?: unknown; data?: { message?: unknown }; name?: unknown };
    if (typeof e.message === 'string') return e.message;
    if (typeof e.data?.message === 'string') return e.data.message;
    if (typeof e.name === 'string') return e.name;
  }
  return undefined;
}

// ─── OpenCode 2 ─────────────────────────────────────────────────────────────

/**
 * What `opencode --version` says, once per binary per process. `undefined`
 * when it could not be read — a check that cannot run blocks nothing.
 */
const versionCache = new Map<string, Promise<string | undefined>>();

function opencodeVersion(bin: string): Promise<string | undefined> {
  let v = versionCache.get(bin);
  if (!v) {
    v = execEngine(bin, ['--version'], { timeout: 15_000 }).then(
      (r) => `${r.stdout}${r.stderr}`.trim() || undefined,
      () => undefined,
    );
    versionCache.set(bin, v);
  }
  return v;
}

/** OpenCode 2: a 2.x release, or one of the `0.0.0-beta-N` builds that preceded it. */
export function isOpencodeV2(version: string | undefined): boolean {
  if (!version) return false;
  if (isOpencodeV2Prerelease(version)) return true;
  // No `\b` before the major: 2.3.2 prints `opencode v2.3.2`, and there is no
  // word boundary between the `v` and the `2`.
  const m = version.match(/(\d+)\.\d+\.\d+/);
  return !!m && Number(m[1]) >= 2;
}

/**
 * The OpenCode 2 builds that came before its first release (`0.0.0-beta-N`,
 * from `opencode upgrade --major` and the `@opencode-ai/cli` npm package).
 * Still refused: measured on 0.0.0-beta-17823 they sent no `step_finish`, so a
 * turn had no tokens and no cost. The 2.3.2 release sends it again.
 */
export function isOpencodeV2Prerelease(version: string | undefined): boolean {
  return !!version && (/\b0\.0\.0-(beta|next|dev)/.test(version) || /\bopencode2\b/.test(version));
}

// ─── PersistentOpencodeSession ──────────────────────────────────────────────

export class PersistentOpencodeSession extends BaseOneShotSession {
  private _currentRl: readline.Interface | null = null;

  /**
   * OpenCode's own session id, once the first turn has announced one.
   *
   * `opencode run` starts a brand-new session unless `--session <id>` names an
   * existing one, so without this every send was an amnesiac first turn. The id
   * was already being harvested off the event stream for `sessionId`; it just
   * was never fed back, which is what made this engine look like it had no
   * conversation of its own.
   */
  private opencodeSessionId?: string;

  /**
   * Spend opencode reported itself, summed over every `step_finish.cost`.
   * Undefined until a step reports one. When present it is the bill: the model
   * opencode picked is not in its JSON output, so pricing tokens against the
   * registry charged a free default model at Sonnet rates.
   */
  private _reportedCostUsd?: number;

  /** Set by start() from `opencode --version`. An unreadable version runs as V1, as before. */
  private _v2 = false;

  /**
   * `provider/model#variant` pairs OpenCode 2 refused in this session. Each is
   * asked for once: after the refusal the turn runs on the model's default,
   * which is what V1 did with an effort a provider did not offer.
   */
  private readonly _refusedVariants = new Set<string>();

  /** Notes about options a line cannot honour, logged once per session each. */
  private readonly _notes = new Set<string>();

  /**
   * The first turn forks `opencodeSessionId` (`forkSession` with a resumed id).
   * Cleared once a turn has adopted the fork's id.
   */
  private _forkPending = false;

  /**
   * `opencodeSessionId` was made by this session — a new session or a fork —
   * or taken over from a stopped one that made it, rather than named by the
   * caller. Only such a session is deleted on stop.
   */
  private _ownsSession = false;

  /** API retries OpenCode 2 reported (`retry` events), and the last one's category. */
  private _retries = 0;
  private _lastRetryError?: string;

  // ─── The held server (OpenCode 2) ─────────────────────────────────────

  private _server: OpencodeServer | null = null;
  /** The held server's start in progress, which every caller waits for. */
  private _opening: Promise<OpencodeServer> | null = null;
  /** Users of the held server now: a turn, a command, a goal. At zero it is stopped after `serverIdleMs`. */
  private _serverLeases = 0;
  private _serverIdleTimer: ReturnType<typeof setTimeout> | null = null;
  /** Held-server starts that failed in a row; at two, turns stay on `--standalone`. */
  private _serverFailures = 0;
  /** A `run --server` turn is in flight. */
  private _turnOnServer = false;
  /** Server-side work in flight that is not a `run` turn: a command, a compaction, a goal. */
  private _serverWork = 0;
  /** How long an unused held server is kept. */
  protected serverIdleMs = SERVER_IDLE_MS;
  /** How often server-side work is read while it runs. */
  protected serverPollMs = 500;
  /** Prompt tokens of the last model call, for a compaction's `preTokens`. */
  private _lastPromptTokens = 0;
  /** The message `applyTurnCommand` handed back, to run as the turn command when it arrives. */
  private _turnCommandFor?: { command: string; message: string };
  /** A `plan` turn moved the session to the `plan` agent; the next turn names this one to go back. */
  private _agentAfterPlan?: string;
  /**
   * A send's own model stays the conversation's on OpenCode 2, so a session that
   * names no model of its own names, from then on, the model the conversation
   * had before it (or the server's default).
   */
  private _modelAfterOverride?: string;
  /** Engine commands the held server listed, once it listed any. */
  private _engineCommands?: { server: OpencodeServer; commands: EngineCommand[] };

  /** Commands go through `runCommand`: the server's API on OpenCode 2, `run --command` on OpenCode 1. */
  readonly commandStyle = 'rpc' as const;
  /** A send's `model` runs that turn only: every turn names its model. */
  readonly perSendModel = true;

  // Capabilities that only OpenCode 2's server has; set by start() on a 2.x binary.
  compactDetailed?: (summary?: string) => Promise<CompactOutcome>;
  askAside?: (question: string, opts?: { timeout?: number }) => Promise<AsideOutcome>;
  rewind?: (target: RewindTarget) => Promise<RewindOutcome>;
  listCommands?: () => Promise<EngineCommand[]>;
  nativeGoalSession?: (open?: ClaudeGoalOpen) => GoalSession | undefined;

  protected override _continuesConversation(): boolean {
    return !!this.opencodeSessionId;
  }

  override async start(): Promise<this> {
    // The read-only guarantee is our own agent; a session cannot also run another.
    if (this.options.sandboxMode === 'read-only' && this.options.agent) {
      throw new Error(
        `OpenCode read-only sessions run claw-orchestrator's own read-only agent, so they cannot also run agent '${this.options.agent}'. Drop one of agent and sandboxMode 'read-only'.`,
      );
    }
    const version = await opencodeVersion(this.engineBin);
    if (isOpencodeV2Prerelease(version)) {
      throw new Error(
        `OpenCode 2 prerelease builds (${version}) are not supported: they send no per-turn usage events. ` +
          'Install an OpenCode 2 release or OpenCode 1.x.',
      );
    }
    this._v2 = isOpencodeV2(version);
    // OpenCode 2's session ids are checked to start with "ses" (2.3.2); any other
    // fails the turn after the process has started.
    const customId = this.options.customSessionId;
    if (this._v2 && customId && !this.opencodeSessionId && !customId.startsWith('ses')) {
      throw new Error(`OpenCode 2 session ids start with "ses"; customSessionId '${customId}' would be refused`);
    }
    if (this._v2) {
      this.compactDetailed = (summary) => this._compactOnServer(summary);
      this.askAside = (question, opts) => this._askAside(question, opts);
      this.rewind = (target) => this._rewind(target);
      this.listCommands = () => this._listCommands();
      this.nativeGoalSession = (open) => new OpencodeGoalSession(this, open);
    }
    return super.start();
  }

  /** The OpenCode session id this session continues, once there is one. */
  get conversationId(): string | undefined {
    return this.opencodeSessionId;
  }

  override get isBusy(): boolean {
    return super.isBusy || this._serverWork > 0;
  }

  private _noteOnce(key: string, message: string): void {
    if (this._notes.has(key)) return;
    this._notes.add(key);
    this.emit(SESSION_EVENT.LOG, `[opencode] ${message}`);
  }

  constructor(config: SessionConfig, opencodeBin?: string) {
    super(config, opencodeBin || process.env.OPENCODE_BIN || 'opencode', {
      enginePrefix: 'opencode',
      defaultModel: 'claude-sonnet-4-6',
      defaultModelDisplay: 'opencode-default',
      supportsCachedTokens: true,
      // `tokens.total` is input + output + cache.read + cache.write, so
      // `tokens.input` holds only the uncached remainder. On a resumed turn
      // that remainder is tiny next to the cached part (58 vs 26240), which is
      // exactly where subtracting one from the other goes wrong.
      inputIncludesCachedTokens: false,
      engineDisplayName: 'OpenCode',
    });
    // Process-level resume: a persisted id comes back as the raw OpenCode id,
    // never one of our generated `opencode-<ts>-<rand>` handles.
    if (config.resumeSessionId && !/^opencode-\d+-/.test(config.resumeSessionId)) {
      const id = config.resumeSessionId.replace(/^opencode-live-/, '');
      this.opencodeSessionId = id;
      // A restart of a stopped ephemeral session: take its pending delete over.
      // It continues that session — it does not fork it a second time.
      const pending = pendingDeletes.get(id);
      if (pending) {
        clearTimeout(pending);
        pendingDeletes.delete(id);
        this._ownsSession = true;
      }
      this._forkPending = !!config.forkSession && !pending;
    }
  }

  /** Not kept: `noSessionPersistence`, or the registry-only `skipPersistence`. */
  private get _ephemeral(): boolean {
    return !!(this.options.noSessionPersistence || this.options.skipPersistence);
  }

  /**
   * Stop, then delete the OpenCode session an ephemeral session created. Best
   * effort, and it never throws: OpenCode 1 has no flag that keeps a session
   * off disk, and an OpenCode 2 session is only archived (`--archived`).
   */
  override stop(): void {
    super.stop();
    this._dropServer();
    try {
      const id = this.opencodeSessionId;
      if (!id || !this._ownsSession || !this._ephemeral || pendingDeletes.has(id)) return;
      if (!/^ses[\w-]*$/.test(id)) return;
      this._ownsSession = false;
      const bin = this.engineBin;
      const v2 = this._v2;
      const launcher = this.options.launcher;
      const log = (m: string) => this.emit(SESSION_EVENT.LOG, m);
      pendingDeletes.set(
        id,
        setTimeout(() => {
          pendingDeletes.delete(id);
          deleteOpencodeSession(bin, id, v2, launcher, log);
        }, DELETE_GRACE_MS),
      );
    } catch {
      // stop() must not throw.
    }
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
    super._cleanupProc();
  }

  protected async _run(message: string, options: SessionSendOptions): Promise<TurnResult> {
    // The session's turn command takes this message: run it as that command.
    const turnCommand = this._turnCommandFor;
    this._turnCommandFor = undefined;
    if (turnCommand && message.endsWith(turnCommand.message)) {
      const [name, ...rest] = turnCommand.command.split(/\s+/);
      const text = [...rest, message].join(' ');
      return this._v2 ? this._commandTurn(name, text, options) : this._runProcess(text, options, undefined, name);
    }
    const lease = this._v2 ? await this._leaseForTurn() : undefined;
    try {
      if (this._v2 && options.model && !this.options.model && !this._modelAfterOverride) {
        this._modelAfterOverride = lease ? await this._defaultModel(lease.server) : undefined;
        if (!this._modelAfterOverride) {
          this._noteOnce('modelAfterOverride', "the turns after a send's own model keep running on that model");
        }
      }
      return await this._runProcess(message, options, lease?.server);
    } finally {
      lease?.release();
    }
  }

  /**
   * One `opencode run`: a client of the held server when there is one, else a
   * private server of its own (`--standalone`, OpenCode 2) or OpenCode 1's.
   * `command`: OpenCode 1's `--command`, with `message` as its arguments.
   */
  private _runProcess(
    message: string,
    options: SessionSendOptions,
    server: OpencodeServer | undefined,
    command?: string,
  ): Promise<TurnResult> {
    // opencode run --format json [--session <id>], with the message on stdin.
    // On Windows `opencode` is an npm `.cmd` shim that runs through cmd.exe,
    // which would cut a message at its first newline; stdin carries it unchanged.
    const args: string[] = ['run', '--format', 'json'];
    // A private server for this run. Without it OpenCode 2 hands the turn to its
    // background service when one is running, which reads its own configuration
    // and not this process's environment (see the header). The held server is
    // that same private server, kept for the session.
    if (server?.url) args.push('--server', server.url);
    else if (this._v2) args.push('--standalone');
    if (command) args.push(flagValue('--command', command));
    // Reasoning events. Both lines send `reasoning` only with this flag, which
    // changes nothing else in the JSON output; they go to the log channel.
    args.push('--thinking');

    // Continue OpenCode's own session rather than starting a fresh one. Verified
    // against 1.18.18: without this the second turn answers "you never asked me
    // to remember anything"; with it the same turn recalls the first turn's
    // content. `--continue` is deliberately not used — it means "the last
    // session on this machine", which would collide across concurrent sessions.
    const forking = this._forkPending && !!this.opencodeSessionId;
    const customId = !this.opencodeSessionId ? this.options.customSessionId : undefined;
    if (this.opencodeSessionId) {
      args.push('--session', this.opencodeSessionId);
      // The fork is a new session; its id comes back on every event of this turn.
      if (forking) args.push('--fork');
    } else if (customId && this._v2) {
      // OpenCode 2 creates the session under this id, or continues it if it exists.
      args.push('--session', customId);
    } else if (customId) {
      this._noteOnce('customSessionId', 'customSessionId not sent: OpenCode 1 cannot create a session under an id');
    }
    const creating = !this.opencodeSessionId;
    // Both lines apply a title only to a session they create (not to a resumed
    // one or a fork), and OpenCode 1 then skips its title-generation model call.
    if (creating) args.push(flagValue('--title', this.options.sessionName || this.options.name));
    // OpenCode 2 only: archived on creation and on fork, as it applies it.
    if (this._v2 && this._ephemeral && (creating || forking)) args.push('--archived');

    const readOnly = this.options.sandboxMode === 'read-only';
    // A plan turn runs OpenCode's own `plan` agent; a read-only session's agent is
    // stricter than plan, so it keeps that one.
    const plan = !!options.plan && !readOnly;
    const agentName = this._turnAgent(plan);
    // NOT opencode's built-in `plan` agent for read-only: that is a user-overridable
    // preset whose rules start with {"permission":"*","action":"allow"} and deny
    // neither `bash` nor `edit` — a "read-only" session could still write via
    // a shell heredoc. Instead we inject our own agent whose permissions deny
    // edit/bash/external_directory outright, so read-only is enforced by the
    // permission engine rather than requested politely.
    if (agentName) args.push('--agent', agentName);
    if (this._v2) {
      // OpenCode 2 keeps the agent for later turns: the turn after a plan turn goes back.
      if (plan && !this._agentAfterPlan) this._agentAfterPlan = this.options.agent || DEFAULT_AGENT;
      else if (!plan) this._agentAfterPlan = undefined;
    }

    // Never on a read-only session: there a request the agent's rules leave to
    // `ask` must stay rejected.
    if (this.options.dangerouslySkipPermissions && !readOnly) args.push('--auto');

    if (this.options.bare) {
      if (this._v2) this._noteOnce('bare', 'bare not sent: OpenCode 2 has no plugin-free mode');
      else args.push('--pure');
    }

    // Images: OpenCode 1 reads a local file through its Read tool, which hands
    // an image to the model as an attachment; OpenCode 2 sends it as a data URL
    // and refuses one over 10 MiB.
    for (const image of options.images ?? []) {
      if (this._v2) args.push('-f', image);
      else args.push(flagValue('--file', image));
    }

    // opencode wants `provider/model` format. Only pass through if it looks correct.
    // A send's own model runs that turn only (`perSendModel`).
    const configured = options.model || this.options.model || this._modelAfterOverride;
    let model = configured && configured.includes('/') ? configured : undefined;

    // `--variant` is opencode's reasoning-effort knob ("provider-specific
    // reasoning effort, e.g., high, max, minimal"). Before this the engine
    // received no effort at all and every caller's setting was dropped on the
    // floor. opencode does not validate the value — an unknown one runs the
    // turn at the provider's default rather than failing — so the level a
    // provider does not offer degrades instead of erroring.
    //
    // OpenCode 2 has no `--variant`: the variant joins the model as
    // `provider/model#variant`, and one the model does not offer fails the turn.
    // That refusal comes before the model is called, so the turn is run again
    // without it (see the close handler) and the level degrades as on V1.
    const effort = options.effort ?? this.options.effort;
    const wantsEffort = !!effort && effort !== 'auto';
    let variantTried: string | undefined;
    if (this._v2 && wantsEffort) {
      if (model && !model.includes('#')) {
        const withVariant = `${model}#${effort}`;
        if (!this._refusedVariants.has(withVariant)) model = variantTried = withVariant;
      } else if (!model) {
        // A variant names one model's level; with no model OpenCode picks the
        // default, and there is nothing to attach the level to.
        this._noteOnce(
          'effort',
          `effort '${effort}' not sent: OpenCode 2 takes a reasoning variant only with a provider/model`,
        );
      }
    }
    if (model) args.push('--model', model);
    if (!this._v2 && wantsEffort) args.push('--variant', effort);

    const timeout = options.timeout || 300_000;

    return new Promise<TurnResult>((resolve, reject) => {
      const state: TurnState = {
        textParts: new Map(),
        seenTools: new Set(),
        erroredTools: new Set(),
        gotUsage: false,
        variantUnavailable: false,
        adoptSessionId: creating || forking,
        // A V2 session under `customSessionId` may be the caller's existing one.
        createsSession: (creating && !customId) || forking,
      };
      let stderr = '';
      let settled = false;

      const env = this._engineEnv();
      const proc = spawnEngine(this.engineBin, args, {
        launcher: this.options.launcher,
        cwd: this.options.cwd,
        env: server ? server.clientEnv(env) : env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.currentProc = proc;
      if (server) this._turnOnServer = true;
      // Writing the message closes stdin too; opencode waits for EOF before it starts.
      proc.stdin?.on('error', () => {});
      proc.stdin?.end(message);

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          // On the held server the turn runs in the server: stop it there too.
          if (server) this._stopServerTurn(proc);
          killEngineTree(proc);
          reject(new Error('Timeout waiting for OpenCode response'));
        }
      }, timeout);

      // OpenCode 1 runs its DEFAULT, writable agent when the one asked for does
      // not load, and says so only in a warning (see AGENT_FALLBACK_RE). For a
      // read-only session that is the sandbox gone; for a chosen agent it is the
      // wrong agent. The warning comes before the prompt is sent, so the turn is
      // killed on sight rather than refused after it ran.
      const refuseAgentFallback = (text: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        killEngineTree(proc);
        // It reached the engine, so it counts as a turn, but not as a success.
        this._recordTurnComplete(false);
        const said = text.match(AGENT_FALLBACK_RE)?.[1] ?? `agent "${agentName}" did not load`;
        reject(
          new Error(
            readOnly
              ? `OpenCode read-only enforcement failed: ${said}, so the turn would have run on the default, writable agent. ` +
                  'Refused before it ran. (Check that OPENCODE_CONFIG_CONTENT is honored by this opencode version.)'
              : `OpenCode did not run the agent this session asked for: ${said}. Refused rather than run on the default agent.`,
          ),
        );
      };

      const rl = readline.createInterface({ input: proc.stdout!, crlfDelay: Infinity });
      this._currentRl = rl;
      rl.on('line', (line: string) => {
        if (!line.trim()) return;
        try {
          const event = JSON.parse(line) as Record<string, unknown>;
          this._handleStreamEvent(event, options, state);
        } catch {
          // Non-JSON line — opencode banner or stray text. Treat as plain text.
          // Earlier builds wrote the agent warning here rather than to stderr.
          if (agentName && AGENT_FALLBACK_RE.test(line)) refuseAgentFallback(line);
          const fallback = line + '\n';
          // Accumulate fallback text under one stable key (the old code wrote to
          // __raw_<size> but read __raw_acc, so it never actually accumulated).
          state.textParts.set('__raw_acc', (state.textParts.get('__raw_acc') || '') + fallback);
          try {
            options.callbacks?.onText?.(fallback);
          } catch {
            // User callback error
          }
          this.emit(SESSION_EVENT.TEXT, fallback);
        }
      });

      proc.stderr?.on('data', (data: Buffer) => {
        const sanitized = sanitizeSecrets(data.toString());
        stderr += sanitized;
        this.emit(SESSION_EVENT.LOG, `[opencode-stderr] ${sanitized}`);
        // Tested on everything received so far: the warning can span chunks.
        if (agentName && AGENT_FALLBACK_RE.test(stderr)) refuseAgentFallback(stderr);
      });

      proc.on('close', (code) => {
        clearTimeout(timer);
        this.currentProc = null;
        if (server) this._turnOnServer = false;
        if (this._currentRl) {
          this._currentRl.close();
          this._currentRl = null;
        }

        if (settled) return;
        settled = true;

        // OpenCode 2 refused the variant before calling the model, so nothing ran:
        // not a turn, and safe to run again on the model's default variant. Only
        // when nothing did run (no tool, no usage), and not once the session has
        // been stopped, which also kills this process.
        if (variantTried && state.variantUnavailable && this.isReady && state.seenTools.size === 0 && !state.gotUsage) {
          this._refusedVariants.add(variantTried);
          this.emit(
            SESSION_EVENT.LOG,
            `[opencode] ${state.errorMessage ?? `variant refused: ${variantTried}`}; running on the model's default`,
          );
          this._runProcess(message, options, server, command).then(resolve, reject);
          return;
        }

        // Collapse per-part text snapshots to a single string in insertion order.
        const finalText = Array.from(state.textParts.values()).join('');

        // Account tool usage stats (count uniques only).
        this._stats.toolCalls += state.seenTools.size;
        this._stats.toolErrors += state.erroredTools.size;

        // One expression for the outcome, feeding the counter here and the
        // `stop_reason` below.
        const ok = code === 0;
        this._recordTurnComplete(ok);

        // Fallback: estimate tokens if step_finish never arrived.
        if (!state.gotUsage && finalText.length > 0) {
          this._stats.tokensIn += estimateTokens(message);
          this._stats.tokensOut += estimateTokens(finalText);
          this._markTurnEstimated();
          this._updateCost();
        }

        this._addHistory({ text: finalText, code });

        // The held server's `/interrupt` ends `run` with an `aborted` error ("Session interrupted: …").
        const interrupted = !ok && /\bSession interrupted\b/i.test(state.errorMessage ?? '');
        const event: StreamEvent = {
          type: 'result',
          result: finalText,
          stop_reason: ok ? 'end_turn' : interrupted ? 'interrupted' : 'error',
        };

        this.emit(SESSION_EVENT.RESULT, event);
        this.emit(SESSION_EVENT.TURN_COMPLETE, event);

        if (code !== 0) {
          reject(new Error(state.errorMessage || stderr || `OpenCode exited with code ${code}`));
        } else {
          resolve({ text: finalText, event });
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

  // ─── Stream Event Handling ────────────────────────────────────────────

  private _handleStreamEvent(event: Record<string, unknown>, options: SessionSendOptions, state: TurnState): void {
    const type = event.type as string;

    // Capture the session id from the first event that carries one, on a turn
    // that created or forked a session. The raw id is kept separately because
    // that is the form `--session` expects; the prefixed one is our display and
    // persistence handle, which a restart resumes — after a fork, the fork's.
    const sid = (event.sessionID as string) || (event.sessionId as string) || (event.session_id as string);
    if (sid && state.adoptSessionId) {
      state.adoptSessionId = false;
      this.opencodeSessionId = sid;
      this.sessionId = `opencode-live-${sid}`;
      this._forkPending = false;
      if (state.createsSession) this._ownsSession = true;
    }
    if (sid && !this.sessionId?.startsWith('opencode-live-')) {
      this.sessionId = `opencode-live-${sid}`;
    }

    const part = event.part as Record<string, unknown> | undefined;

    switch (type) {
      case 'text': {
        if (!part) break;
        const text = (part.text as string) || '';
        const partId = (part.id as string) || `text-${state.textParts.size}`;
        const prev = state.textParts.get(partId) || '';
        if (text === prev) break;
        // Compute streaming delta (text events are cumulative snapshots).
        const delta = text.startsWith(prev) ? text.slice(prev.length) : text;
        state.textParts.set(partId, text);
        if (delta) {
          try {
            options.callbacks?.onText?.(delta);
          } catch {
            // User callback error
          }
          this.emit(SESSION_EVENT.TEXT, delta);
        }
        break;
      }

      case 'reasoning': {
        // Surface reasoning text on the log channel, but don't include it in
        // the user-visible result — it's the model's internal scratchpad.
        if (!part) break;
        const text = (part.text as string) || '';
        if (text) this.emit(SESSION_EVENT.LOG, `[opencode-reasoning] ${text}`);
        break;
      }

      case 'tool_use': {
        if (!part) break;
        const callID = (part.callID as string) || (part.id as string) || '';
        if (!callID) break;
        if (!state.seenTools.has(callID)) {
          state.seenTools.add(callID);
          try {
            options.callbacks?.onToolUse?.(event);
          } catch {
            // User callback error
          }
          this.emit(SESSION_EVENT.TOOL_USE, event);
        }
        // State transitions get re-emitted on the same callID. Check for terminal
        // states to mark errors and emit tool_result.
        const toolState = part.state as Record<string, unknown> | undefined;
        const status = toolState?.status as string | undefined;
        if (status === 'error' && !state.erroredTools.has(callID)) {
          state.erroredTools.add(callID);
        }
        if (status === 'completed' || status === 'error') {
          try {
            options.callbacks?.onToolResult?.(event);
          } catch {
            // User callback error
          }
          this.emit(SESSION_EVENT.TOOL_RESULT, event);
        }
        break;
      }

      case 'step_start':
        // No-op: lifecycle marker only.
        break;

      case 'retry': {
        // OpenCode 2 only: `{ messageID, attempt, nextRetryAt, error }`, where
        // `error` is a Session.StructuredError `{ type, message, status? }` (2.3.2).
        const err = (event.error ?? {}) as { type?: unknown; message?: unknown; status?: unknown };
        this._retries++;
        const category = typeof err.type === 'string' && err.type !== 'unknown' ? err.type : undefined;
        const status = typeof err.status === 'number' ? String(err.status) : undefined;
        this._lastRetryError = category ?? status ?? 'unknown';
        const said = typeof err.message === 'string' ? sanitizeSecrets(err.message) : this._lastRetryError;
        const attempt = typeof event.attempt === 'number' ? event.attempt : this._retries;
        this.emit(SESSION_EVENT.LOG, `[opencode] retrying (attempt ${attempt}): ${said}`);
        break;
      }

      case 'step_finish': {
        if (!part) break;
        const tokens = part.tokens as OpencodeTokens | undefined;
        if (tokens) {
          this._addUsage(tokens, part.cost, true);
          state.gotUsage = true;
        }
        break;
      }

      case 'background_wait': {
        // OpenCode 2: `run` waits for background jobs (a subagent) before it ends the turn.
        const jobs = Array.isArray(event.jobs) ? (event.jobs as Array<{ kind?: unknown; title?: unknown }>) : [];
        const what = jobs.map((j) => `${String(j.kind ?? 'job')}${j.title ? ` '${String(j.title)}'` : ''}`);
        this.emit(
          SESSION_EVENT.LOG,
          `[opencode] waiting for ${jobs.length || 'its'} background job(s)${what.length ? `: ${what.join(', ')}` : ''}`,
        );
        break;
      }

      case 'error': {
        // From the child's stdout, and it reaches logs and the caller's error the
        // way stderr does, so it is redacted the same way.
        const raw = errorEventMessage(event);
        const msg = raw === undefined ? undefined : sanitizeSecrets(raw);
        if (msg) state.errorMessage = msg;
        if (msg && /\bVariant unavailable\b/i.test(msg)) state.variantUnavailable = true;
        this.emit(SESSION_EVENT.LOG, `[opencode-error] ${msg ?? sanitizeSecrets(JSON.stringify(event))}`);
        break;
      }

      default:
        // Unknown event type — ignore for forward compatibility.
        break;
    }
  }

  // ─── Usage ────────────────────────────────────────────────────────────

  /**
   * Add one model call's usage to the session: a `step_finish` of a `run` turn,
   * or an assistant or compaction message the held server wrote. `context`: the
   * call's prompt is the conversation as it now stands.
   */
  private _addUsage(tokens: OpencodeTokens, cost: unknown, context: boolean): void {
    const cacheRead = tokens.cache?.read || 0;
    const cacheWrite = tokens.cache?.write || 0;
    this._stats.tokensIn += tokens.input || 0;
    this._stats.tokensOut += tokens.output || 0;
    this._stats.cachedTokens += cacheRead;
    this._stats.cacheCreationTokens += cacheWrite;
    if (context) {
      // `tokens.input` is only the uncached remainder, so the context this
      // call actually filled is the whole input side.
      const prompt = promptTokens(tokens);
      this._reportTurnInputTokens(prompt);
      if (prompt > 0) this._lastPromptTokens = prompt;
    }
    if (typeof cost === 'number' && Number.isFinite(cost)) {
      this._reportedCostUsd = (this._reportedCostUsd ?? 0) + cost;
    }
    this._updateCost();
  }

  /** The environment OpenCode runs in: the read-only agent's definition on a read-only session. */
  private _engineEnv(): NodeJS.ProcessEnv {
    return this.options.sandboxMode === 'read-only'
      ? { ...process.env, OPENCODE_CONFIG_CONTENT: this._v2 ? READ_ONLY_AGENT_CONFIG_V2 : READ_ONLY_AGENT_CONFIG }
      : { ...process.env };
  }

  /** The agent a turn names: read-only first, then a plan turn's, the session's, or the one a plan turn left. */
  private _turnAgent(plan: boolean): string | undefined {
    if (this.options.sandboxMode === 'read-only') return READ_ONLY_AGENT;
    if (plan) return 'plan';
    return this.options.agent || this._agentAfterPlan;
  }

  // ─── The held server ──────────────────────────────────────────────────

  /** Overridden in tests. */
  protected _createServer(): OpencodeServer {
    return new OpencodeServer({
      bin: this.engineBin,
      cwd: this.options.cwd || process.cwd(),
      env: this._engineEnv(),
      launcher: this.options.launcher,
      log: (m) => this.emit(SESSION_EVENT.LOG, m),
    });
  }

  /**
   * The held server, started when there is none (or it died). One start at a
   * time: a server is not `alive` until its URL arrives, so a second caller
   * during the start would otherwise take it for dead and stop it — a command
   * or an aside run beside a turn that is still opening the server.
   */
  private _openServer(): Promise<OpencodeServer> {
    if (this._server?.alive) return Promise.resolve(this._server);
    this._opening ??= this._startServer().finally(() => {
      this._opening = null;
    });
    return this._opening;
  }

  private async _startServer(): Promise<OpencodeServer> {
    if (!this.isReady) throw new Error('Session not ready. Call start() first.');
    this._server?.stop();
    const server = this._createServer();
    this._server = server;
    try {
      await server.start();
    } catch (err) {
      if (this._server === server) this._server = null;
      throw err;
    }
    // stop() may have run while it started.
    if (this._server !== server) {
      server.stop();
      throw new Error('Session not ready. Call start() first.');
    }
    this.emit(SESSION_EVENT.LOG, `[opencode] holding a private server at ${server.url} (pid ${server.pid ?? '?'})`);
    return server;
  }

  /** Use the held server; `release` when done, and the server stops once nothing has used it for a while. */
  private async _lease(): Promise<{ server: OpencodeServer; release: () => void }> {
    if (!this._v2) throw new Error('this needs OpenCode 2: OpenCode 1 has no server API clawo drives');
    this._serverLeases++;
    this._clearServerIdle();
    let server: OpencodeServer;
    try {
      server = await this._openServer();
    } catch (err) {
      this._releaseLease();
      throw err;
    }
    let released = false;
    return {
      server,
      release: () => {
        if (released) return;
        released = true;
        this._releaseLease();
      },
    };
  }

  private _releaseLease(): void {
    this._serverLeases = Math.max(0, this._serverLeases - 1);
    if (this._serverLeases > 0 || !this._server) return;
    this._clearServerIdle();
    this._serverIdleTimer = setTimeout(() => {
      this._serverIdleTimer = null;
      if (this._serverLeases === 0) this._dropServer();
    }, this.serverIdleMs);
    this._serverIdleTimer.unref?.();
  }

  private _clearServerIdle(): void {
    if (this._serverIdleTimer) clearTimeout(this._serverIdleTimer);
    this._serverIdleTimer = null;
  }

  /** Stop the held server now, with whatever it is running. */
  private _dropServer(): void {
    this._clearServerIdle();
    const server = this._server;
    this._server = null;
    this._engineCommands = undefined;
    server?.stop();
  }

  /**
   * The held server for a turn, or undefined to run it on `--standalone`: when
   * `CLAWO_OPENCODE_STANDALONE=1`, or the server failed to start twice in a row.
   */
  private async _leaseForTurn(): Promise<{ server: OpencodeServer; release: () => void } | undefined> {
    if (process.env[STANDALONE_ENV] === '1' || this._serverFailures >= 2) return undefined;
    try {
      const lease = await this._lease();
      this._serverFailures = 0;
      return lease;
    } catch (err) {
      if (!this.isReady) throw err;
      this._serverFailures++;
      this.emit(
        SESSION_EVENT.LOG,
        `[opencode] could not start a private server (${sanitizeSecrets((err as Error).message)}); running the turn on --standalone`,
      );
      return undefined;
    }
  }

  /**
   * Stop the server-side execution of a turn whose `run` client is going away:
   * `/interrupt` once the conversation id is known, else the whole server (the
   * execution is the server's alone, and a new one starts for the next use).
   */
  private _stopServerTurn(proc?: ChildProcess): void {
    const server = this._server;
    const id = this.opencodeSessionId;
    if (server?.alive && id) {
      void server
        .call<{ interrupted?: boolean }>('POST', `/api/session/${id}/interrupt`)
        .catch((err: Error) => this.emit(SESSION_EVENT.LOG, `[opencode] interrupt failed: ${err.message}`));
    } else if (server) {
      this._dropServer();
    }
    // `run` ends on the server's `aborted` error; one that does not is ended.
    if (proc) {
      const kill = setTimeout(() => {
        if (this.currentProc === proc) this._cleanupProc();
      }, 5_000);
      kill.unref?.();
    }
  }

  /**
   * Stop the turn now running. On the held server: the server's own interrupt,
   * which also stops the turn's background shells and subagents; `run` ends on
   * it, and the session stays usable. Otherwise the process, as before.
   */
  override interruptRun(): boolean {
    const onServer = !!this._server?.alive && (this._turnOnServer || this._serverWork > 0);
    if (!onServer) return super.interruptRun();
    this._stopServerTurn(this._turnOnServer ? (this.currentProc ?? undefined) : undefined);
    return true;
  }

  /**
   * Hand `text` to the turn in flight on the held server (`/prompt`, delivery
   * `steer`): the agent reads it before its next model call. False when no turn
   * runs there, as on `--standalone` or OpenCode 1, whose turns cannot be reached.
   */
  async deliverMidTurn(text: string): Promise<boolean> {
    const server = this._server;
    const id = this.opencodeSessionId;
    if (!server?.alive || !id || !(this._turnOnServer || this._serverWork > 0)) return false;
    await server.call('POST', `/api/session/${id}/prompt`, { text, delivery: 'steer' });
    return true;
  }

  /** A turn command runs through `runCommand`: the message is sent as it is and `_run` routes it. */
  applyTurnCommand(command: string, message: string): string {
    this._turnCommandFor = { command, message };
    return message;
  }

  // ─── Conversations on the server ──────────────────────────────────────

  private _adopt(id: string, owns: boolean): void {
    this.opencodeSessionId = id;
    this.sessionId = `opencode-live-${id}`;
    this._forkPending = false;
    if (owns) this._ownsSession = true;
  }

  /**
   * The conversation server-side work runs on: the one this session continues
   * (forked first when the session is a fork not yet made), or a new one, made
   * as a first turn would make it.
   */
  private async _ensureConversation(server: OpencodeServer): Promise<string> {
    if (this.opencodeSessionId && !this._forkPending) return this.opencodeSessionId;
    let id: string | undefined;
    let owns = true;
    if (this.opencodeSessionId) {
      const r = await server.call<{ data?: { id?: string } }>(
        'POST',
        `/api/session/${this.opencodeSessionId}/fork`,
        {},
      );
      id = r?.data?.id;
    } else {
      const customId = this.options.customSessionId;
      owns = !customId;
      const agent = this._turnAgent(false);
      const model = modelRef(this.options.model);
      const r = await server.call<{ data?: { id?: string } }>('POST', '/api/session', {
        ...(customId ? { id: customId } : {}),
        title: this.options.sessionName || this.options.name,
        location: { directory: this.options.cwd || process.cwd() },
        ...(agent ? { agent } : {}),
        ...(model ? { model } : {}),
      });
      id = r?.data?.id;
    }
    if (!id) throw new Error('OpenCode did not return a session id');
    this._adopt(id, owns);
    if (this._ephemeral && owns) {
      await server.call('PATCH', `/api/session/${id}`, { archived: true }).catch(() => undefined);
    }
    return id;
  }

  /**
   * Before server-side model work: the agent and the model this session's turns
   * name, since a command runs on the conversation's current ones. A read-only
   * session's work always runs its read-only agent.
   */
  private async _syncConversation(server: OpencodeServer, id: string): Promise<void> {
    const agent = this._turnAgent(false);
    if (agent) {
      await server.call('POST', `/api/session/${id}/agent`, { agent });
      this._agentAfterPlan = undefined;
    }
    const model = modelRef(this.options.model || this._modelAfterOverride);
    if (model) await server.call('POST', `/api/session/${id}/model`, { model });
  }

  /**
   * The model the conversation runs on now, as `provider/model`: its own, or
   * the server's default (which a fresh server answers null while it loads).
   */
  private async _defaultModel(server: OpencodeServer): Promise<string | undefined> {
    const id = this.opencodeSessionId;
    if (id && !this._forkPending) {
      const r = await server
        .call<{
          data?: { model?: { providerID?: string; id?: string; variant?: string } };
        }>('GET', `/api/session/${id}`)
        .catch(() => undefined);
      const m = r?.data?.model;
      if (m?.providerID && m.id)
        return `${m.providerID}/${m.id}${m.variant && m.variant !== 'default' ? `#${m.variant}` : ''}`;
    }
    for (let i = 0; i < 20; i++) {
      const r = await server
        .call<{ data?: { providerID?: string; modelID?: string; id?: string } | null }>('GET', '/api/model/default')
        .catch(() => undefined);
      const m = r?.data;
      if (m?.providerID && (m.modelID || m.id)) return `${m.providerID}/${m.modelID ?? m.id}`;
      await new Promise((res) => setTimeout(res, 150));
    }
    return undefined;
  }

  /** A message the held server wrote, as a `run` turn's stream would have carried it. */
  private _absorbMessage(
    m: OpencodeMessage,
    callbacks: StreamCallbacks | undefined,
    counts: { tools: number; errors: number },
  ): void {
    if (m.type === 'assistant') {
      for (const c of m.content ?? []) {
        if (c.type !== 'tool') continue;
        counts.tools++;
        if (c.state?.status === 'error') counts.errors++;
        const event = { type: 'tool_use', part: { type: 'tool', tool: c.name, state: c.state } };
        try {
          callbacks?.onToolUse?.(event);
          callbacks?.onToolResult?.(event);
        } catch {
          // User callback error
        }
        this.emit(SESSION_EVENT.TOOL_USE, event);
        this.emit(SESSION_EVENT.TOOL_RESULT, event);
      }
      const text = assistantText(m);
      if (text) {
        try {
          callbacks?.onText?.(text);
        } catch {
          // User callback error
        }
        this.emit(SESSION_EVENT.TEXT, text);
      }
      if (m.tokens) this._addUsage(m.tokens, m.cost, true);
    } else if (m.type === 'compaction' && m.tokens) {
      this._addUsage(m.tokens, m.cost, false);
    }
  }

  /**
   * Start work on the held server and follow it to idle: the session's
   * conversation (made or forked if needed), its agent and model, and every
   * message the work writes added to the stats as a `run` turn's events are.
   */
  private async _followOnServer(
    start: (server: OpencodeServer, id: string) => Promise<void>,
    opts: { timeout: number; callbacks?: StreamCallbacks; model?: boolean },
  ): Promise<{ id: string; result: Awaited<ReturnType<typeof followSessionWork>> }> {
    const lease = await this._lease();
    this._serverWork++;
    const counts = { tools: 0, errors: 0 };
    try {
      const { server } = lease;
      const id = await this._ensureConversation(server);
      if (opts.model !== false) await this._syncConversation(server, id);
      const result = await followSessionWork(server, id, () => start(server, id), {
        timeoutMs: opts.timeout,
        pollMs: this.serverPollMs,
        allowPermissions: !!this.options.dangerouslySkipPermissions && this.options.sandboxMode !== 'read-only',
        onMessage: (m) => this._absorbMessage(m, opts.callbacks, counts),
        log: (msg) => this.emit(SESSION_EVENT.LOG, msg),
        cancelled: () => !this.isReady,
      });
      return { id, result };
    } finally {
      this._stats.toolCalls += counts.tools;
      this._stats.toolErrors += counts.errors;
      this._serverWork--;
      lease.release();
    }
  }

  // ─── Engine commands ──────────────────────────────────────────────────

  /** OpenCode's commands (builtin ones and the user's and project's), then clawo's operations they do not shadow. */
  private async _listCommands(): Promise<EngineCommand[]> {
    const lease = await this._lease();
    try {
      const engine = await this._engineCommandList(lease.server);
      const names = new Set(engine.map((c) => c.name));
      const readOnly = this.options.sandboxMode === 'read-only';
      return [...engine, ...CLAWO_OPERATIONS.filter((op) => !names.has(op.name) && !(readOnly && op.name === 'shell'))];
    } finally {
      lease.release();
    }
  }

  /**
   * `GET /api/command`. A fresh server lists nothing for about 300 ms while it
   * loads the location, and the project's own commands can arrive after the
   * builtin ones, so a first listing is read again once.
   */
  private async _engineCommandList(server: OpencodeServer): Promise<EngineCommand[]> {
    if (this._engineCommands?.server === server) return this._engineCommands.commands;
    const read = async () =>
      (await server.call<{ data?: Array<{ name?: unknown; description?: unknown }> }>('GET', '/api/command'))?.data ??
      [];
    let listed = await read();
    for (let i = 0; i < 20 && listed.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 150));
      listed = await read();
    }
    await new Promise((r) => setTimeout(r, 250));
    const again = await read();
    if (again.length > listed.length) listed = again;
    const commands: EngineCommand[] = listed
      .filter((c): c is { name: string; description?: unknown } => typeof c.name === 'string' && !!c.name)
      .map((c) => ({
        name: c.name,
        ...(typeof c.description === 'string' ? { description: c.description } : {}),
        source: OPENCODE_BUILTIN_COMMANDS.has(c.name) ? 'builtin' : 'custom',
        startsTurn: true,
      }));
    if (commands.length) this._engineCommands = { server, commands };
    return commands;
  }

  /**
   * Run one command: OpenCode's own (`session.command` on OpenCode 2, `run
   * --command` on OpenCode 1), or one of clawo's operations on the held server.
   */
  async runCommand(
    name: string,
    args?: string,
    opts: { timeout?: number; callbacks?: StreamCallbacks } = {},
  ): Promise<CommandOutcome> {
    if (!this.isReady) throw new Error('Session not ready. Call start() first.');
    const timeout = opts.timeout || TURN_TIMEOUT_MS;
    if (!this._v2) {
      // OpenCode 1 refuses an unknown command with a server error before any model call: no usage, no turn.
      const used = () => this._stats.tokensIn + this._stats.tokensOut;
      const before = used();
      try {
        const r = await this._runProcess(args ?? '', { timeout, callbacks: opts.callbacks }, undefined, name);
        return { name, ok: true, text: r.text, startedTurn: true };
      } catch (err) {
        return { name, ok: false, text: '', startedTurn: used() > before, error: (err as Error).message };
      }
    }
    const op = CLAWO_OPERATIONS.find((o) => o.name === name);
    if (op) {
      const lease = await this._lease();
      let shadowed: boolean;
      try {
        shadowed = (await this._engineCommandList(lease.server)).some((c) => c.name === name);
      } finally {
        lease.release();
      }
      if (!shadowed) return this._runOperation(name, args, timeout);
    }
    return this._runServerCommand(name, args, { timeout, callbacks: opts.callbacks });
  }

  /** `session.command` on the held server, followed until the session is idle again. */
  private async _runServerCommand(
    name: string,
    args: string | undefined,
    opts: { timeout: number; callbacks?: StreamCallbacks },
  ): Promise<CommandOutcome> {
    const text = args ?? '';
    // `/goal pause` and `/goal clear` change the goal and run nothing: no follow.
    if (name === 'goal' && GOAL_NO_TURN_ARGS.has(text.trim())) {
      const lease = await this._lease();
      try {
        const id = await this._ensureConversation(lease.server);
        await lease.server.call('POST', `/api/session/${id}/command`, { name, text: text.trim() });
        const state = await this._goalStateOn(lease.server, id);
        return { name, ok: true, text: state ? JSON.stringify(state) : 'no goal', data: state, startedTurn: false };
      } catch (err) {
        return { name, ok: false, text: '', startedTurn: false, error: (err as Error).message };
      } finally {
        lease.release();
      }
    }
    let followed: Awaited<ReturnType<PersistentOpencodeSession['_followOnServer']>>;
    try {
      followed = await this._followOnServer(async (server, id) => {
        await server.call('POST', `/api/session/${id}/command`, { name, text });
      }, opts);
    } catch (err) {
      // Refused before it ran (no such command, bad arguments): not a turn.
      if (err instanceof OpencodeApiError) {
        return { name, ok: false, text: '', startedTurn: false, error: err.message };
      }
      throw err;
    }
    const { result } = followed;
    const fold = foldMessages(result.messages);
    const startedTurn = result.messages.some((m) => m.type === 'assistant');
    const ok = !result.timedOut && fold.outcome !== 'failed' && fold.outcome !== 'interrupted';
    const error = result.timedOut
      ? `Timeout waiting for OpenCode to finish /${name}`
      : fold.outcome === 'interrupted'
        ? `/${name} was interrupted`
        : fold.error;
    if (startedTurn) {
      this._recordTurnComplete(ok);
      this._addHistory({ text: fold.text, code: ok ? 0 : 1 });
      const event: StreamEvent = { type: 'result', result: fold.text, stop_reason: ok ? 'end_turn' : 'error' };
      this.emit(SESSION_EVENT.RESULT, event);
      this.emit(SESSION_EVENT.TURN_COMPLETE, event);
    }
    return { name, ok, text: fold.text, startedTurn, ...(ok ? {} : { error: error ?? `/${name} failed` }) };
  }

  /** A turn the session's `turnCommand` takes, as a send: rejects as a failed `run` would. */
  private async _commandTurn(name: string, text: string, options: SessionSendOptions): Promise<TurnResult> {
    const outcome = await this._runServerCommand(name, text, {
      timeout: options.timeout || TURN_TIMEOUT_MS,
      callbacks: options.callbacks,
    });
    if (!outcome.ok) throw new Error(outcome.error ?? `/${name} failed`);
    return { text: outcome.text, event: { type: 'result', result: outcome.text, stop_reason: 'end_turn' } };
  }

  /** One of clawo's operations (`CLAWO_OPERATIONS`). */
  private async _runOperation(name: string, args: string | undefined, timeout: number): Promise<CommandOutcome> {
    const done = (text: string, data?: unknown): CommandOutcome => ({
      name,
      ok: true,
      text,
      ...(data === undefined ? {} : { data }),
      startedTurn: false,
    });
    const failed = (error: string, data?: unknown): CommandOutcome => ({
      name,
      ok: false,
      text: '',
      ...(data === undefined ? {} : { data }),
      startedTurn: false,
      error,
    });
    if (name === 'compact') {
      const o = await this._compactOnServer();
      const sizes = o.preTokens && o.postTokens ? `: ${o.preTokens} → ${o.postTokens} tokens` : '';
      return o.ok ? done(o.note ?? `compacted${sizes}`, o) : failed(o.note ?? 'not compacted', o);
    }
    if ((name === 'shell' || name === 'skill') && !args)
      return failed(`${name} needs ${name === 'shell' ? 'a command' : 'a skill id'}`);
    // The user's shell, not the agent's: no permission rule applies to it.
    if (name === 'shell' && this.options.sandboxMode === 'read-only') {
      return failed('shell is refused on a read-only session: the command would run outside its read-only agent');
    }
    const lease = await this._lease();
    const { server } = lease;
    try {
      switch (name) {
        case 'shell':
          return await this._shell(server, args as string, timeout);
        case 'skill': {
          const id = await this._ensureConversation(server);
          await server.call('POST', `/api/experimental/session/${id}/skill`, { id: args, resume: false });
          return done(`skill '${args}' loaded into the conversation`);
        }
        case 'goal-status': {
          const id = this.opencodeSessionId;
          const state = id ? await this._goalStateOn(server, id) : null;
          return done(state ? `${state.status}: ${state.objective}` : 'no goal', state);
        }
        case 'models': {
          const models = await this._readList<{
            providerID?: string;
            modelID?: string;
            id?: string;
            name?: string;
            variants?: Array<{ id?: string }>;
          }>(server, '/api/model');
          const lines = models.map((m) => {
            const variants = (m.variants ?? []).map((v) => v.id).filter(Boolean);
            return `${m.providerID}/${m.modelID ?? m.id}${variants.length ? ` (variants: ${variants.join(', ')})` : ''}`;
          });
          return done(
            lines.join('\n'),
            models.map((m) => ({
              id: `${m.providerID}/${m.modelID ?? m.id}`,
              name: m.name,
              variants: (m.variants ?? []).map((v) => v.id),
            })),
          );
        }
        case 'agents': {
          const listed = await this._readList<{ id?: string; mode?: string; hidden?: boolean; description?: string }>(
            server,
            '/api/agent',
          );
          const agents = listed.map((a) => ({
            id: a.id,
            mode: a.mode,
            hidden: !!a.hidden,
            description: a.description,
          }));
          return done(
            agents
              .map(
                (a) => `${a.id} (${a.mode}${a.hidden ? ', hidden' : ''})${a.description ? ` — ${a.description}` : ''}`,
              )
              .join('\n'),
            agents,
          );
        }
        case 'skills': {
          const listed = await this._readList<{ id?: string; description?: string; path?: string }>(
            server,
            '/api/skill',
          );
          const skills = listed.map((s) => ({ id: s.id, description: s.description, path: s.path }));
          return done(skills.map((s) => `${s.id}${s.description ? ` — ${s.description}` : ''}`).join('\n'), skills);
        }
        case 'mcp': {
          const r = await server.call<{ data?: unknown[] }>('GET', '/api/mcp');
          const servers = r?.data ?? [];
          return done(servers.length ? JSON.stringify(servers, null, 2) : 'no MCP servers', servers);
        }
        case 'usage': {
          const raw = await server.call<OpencodeUsageLimits>('GET', '/api/experimental/usage/limits');
          const quota = parseUsageLimits(raw, 'opencode /usage');
          return done(
            quota
              ? quota.windows
                  .map((w) => `${w.name}: ${w.usedPercent ?? '?'}% used${w.resetsAt ? `, resets ${w.resetsAt}` : ''}`)
                  .join('\n')
              : 'no usage limits: no OpenCode Go subscription or budget on this account',
            raw?.data ?? null,
          );
        }
        default:
          return failed(`unknown operation '${name}'`);
      }
    } catch (err) {
      return failed((err as Error).message);
    } finally {
      lease.release();
    }
  }

  /** A listing a fresh server answers empty while it loads the location (about 300 ms): read until it has entries. */
  private async _readList<T>(server: OpencodeServer, path: string): Promise<T[]> {
    let data: T[] = [];
    for (let i = 0; i < 20; i++) {
      data = (await server.call<{ data?: T[] }>('GET', path))?.data ?? [];
      if (data.length) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    return data;
  }

  /** `session.shell`: the command's output goes into the conversation for the agent's next turn. */
  private async _shell(server: OpencodeServer, command: string, timeout: number): Promise<CommandOutcome> {
    const id = await this._ensureConversation(server);
    const before = await newestMessageId(server, id);
    await server.call('POST', `/api/session/${id}/shell`, { command });
    const deadline = Date.now() + timeout;
    for (;;) {
      const shell = (await messagesAfter(server, id, before)).find((m) => m.type === 'shell');
      if (shell && shell.status !== 'running') {
        const exit = typeof shell.exit === 'number' ? shell.exit : Number(shell.exit);
        const ok = shell.status === 'exited' && exit === 0;
        const text = shell.output?.output ?? '';
        const data = { status: shell.status, exit: shell.exit, truncated: !!shell.output?.truncated };
        return {
          name: 'shell',
          ok,
          text,
          data,
          startedTurn: false,
          ...(ok ? {} : { error: `${shell.status}, exit ${String(shell.exit)}` }),
        };
      }
      if (Date.now() >= deadline) {
        return {
          name: 'shell',
          ok: false,
          text: '',
          startedTurn: false,
          error: 'Timeout waiting for the shell command',
        };
      }
      await new Promise((r) => setTimeout(r, this.serverPollMs));
    }
  }

  // ─── Compaction, asides, rewinds, live switches ─────────────────────────

  /**
   * `session.compact`, waited for. OpenCode writes the summary with its own
   * prompt (`summary` is not sent); the compaction's tokens and cost are the
   * session's, and the context afterwards is the summary.
   */
  private async _compactOnServer(summary?: string): Promise<CompactOutcome> {
    if (!this.opencodeSessionId) return { ok: true, trigger: 'manual', note: 'nothing to compact: no turn yet' };
    const preTokens = this._lastPromptTokens || undefined;
    const { result } = await this._followOnServer(
      async (server, id) => {
        await server.call('POST', `/api/session/${id}/compact`, {});
      },
      { timeout: TURN_TIMEOUT_MS, model: false },
    );
    const compaction = result.messages.filter((m) => m.type === 'compaction').at(-1);
    const ignored = summary?.trim()
      ? '; OpenCode writes the summary with its own prompt, so the summary given was not sent'
      : '';
    if (!compaction || compaction.status !== 'completed') {
      const why = compaction?.error?.message ?? (result.timedOut ? 'timed out' : 'no compaction ran');
      return { ok: false, trigger: 'manual', note: `${sanitizeSecrets(why)}${ignored}` };
    }
    const postTokens = compaction.tokens?.output || undefined;
    if (postTokens) {
      this._reportTurnInputTokens(postTokens);
      this._lastPromptTokens = postTokens;
    }
    return {
      ok: true,
      trigger: 'manual',
      ...(preTokens ? { preTokens } : {}),
      ...(postTokens ? { postTokens } : {}),
      ...(ignored ? { note: ignored.replace(/^; /, '') } : {}),
    };
  }

  /** Compaction for callers of `compact()`: OpenCode 2 compacts on its server; OpenCode 1 cannot. */
  override async compact(summary?: string): Promise<TurnResult> {
    if (!this._v2) return super.compact(summary);
    const o = await this._compactOnServer(summary);
    const text = o.note ?? (o.ok ? 'compacted' : 'not compacted');
    return { text, event: { type: 'result', result: text, compacted: o.ok } };
  }

  /**
   * `session.generate`: an answer from the conversation's context, which stays
   * as it was. No tools run. Its tokens and cost are the session's.
   */
  private async _askAside(question: string, opts: { timeout?: number } = {}): Promise<AsideOutcome> {
    const id = this.opencodeSessionId;
    if (!id) throw new Error('a side question needs a conversation, and this session has had no turn yet');
    const lease = await this._lease();
    try {
      const r = await lease.server.call<{ data?: { text?: string; tokens?: OpencodeTokens; cost?: number } }>(
        'POST',
        `/api/session/${id}/generate`,
        { prompt: question },
        { timeoutMs: opts.timeout || TURN_TIMEOUT_MS },
      );
      if (r?.data?.tokens) this._addUsage(r.data.tokens, r.data.cost, false);
      return { text: r?.data?.text ?? '' };
    } finally {
      lease.release();
    }
  }

  /**
   * `session.revert`, staged and committed: the conversation goes back to
   * before the user message `turns` turns ago (or `messageId`), and with
   * `files` the files those turns changed are restored from OpenCode's snapshots.
   */
  private async _rewind(target: RewindTarget): Promise<RewindOutcome> {
    if (!this.opencodeSessionId) throw new Error('nothing to rewind: this session has had no turn yet');
    const lease = await this._lease();
    try {
      const { server } = lease;
      const id = await this._ensureConversation(server);
      const messages = await messagesAfter(server, id, undefined);
      const turnStarts = messages.filter((m) => m.type === 'user');
      let at: OpencodeMessage | undefined;
      let removed: number;
      if (target.turns !== undefined) {
        if (turnStarts.length < target.turns) {
          throw new Error(`the conversation has ${turnStarts.length} turn(s); cannot rewind ${target.turns}`);
        }
        at = turnStarts[turnStarts.length - target.turns];
        removed = target.turns;
      } else {
        const index = messages.findIndex((m) => m.id === target.messageId);
        if (index < 0) throw new Error(`no message '${target.messageId}' in this conversation`);
        at = messages[index];
        removed = messages.slice(index).filter((m) => m.type === 'user').length;
      }
      const staged = await server.call<{ data?: { files?: Array<{ file?: string }> } }>(
        'POST',
        `/api/session/${id}/revert/stage`,
        { messageID: at.id, files: !!target.files },
      );
      await server.call('POST', `/api/session/${id}/revert/commit`);
      const files = (staged?.data?.files ?? []).map((f) => f.file).filter((f): f is string => !!f);
      return {
        ok: true,
        turnsRemoved: removed,
        filesRestored: !!target.files && files.length > 0,
        ...(target.files ? { note: files.length ? `files restored: ${files.join(', ')}` : 'no files to restore' } : {}),
      };
    } finally {
      lease.release();
    }
  }

  /** Every turn names its model, so a switch applies from the next turn with nothing restarted. */
  async setModelLive(model: string): Promise<boolean> {
    this.options.model = model;
    this.options.resolvedModel = model;
    return true;
  }

  /** Effort is the model variant each turn names, so it applies from the next turn. */
  async setEffortLive(_level: EffortLevel): Promise<boolean> {
    return true;
  }

  // ─── The native goal (OpenCode 2's /goal) ───────────────────────────────

  /** The goal plugin's state; a fresh server answers `RPC is unavailable` until the plugin has loaded. */
  private async _goalStateOn(server: OpencodeServer, id: string): Promise<OpencodeGoalState | null> {
    for (let i = 0; ; i++) {
      try {
        const r = await server.call<{ output?: OpencodeGoalState | null }>('POST', '/api/rpc/opencode.goal/get', {
          input: { sessionID: id },
        });
        return r?.output ?? null;
      } catch (err) {
        const loading = err instanceof OpencodeApiError && err.tag === 'RpcError' && /unavailable/i.test(err.message);
        if (!loading || i >= 20) throw err;
        await new Promise((r) => setTimeout(r, 150));
      }
    }
  }

  /** The goal plugin's state for this conversation; null with no goal or no conversation. */
  async goalState(): Promise<OpencodeGoalState | null> {
    const id = this.opencodeSessionId;
    if (!id) return null;
    const lease = await this._lease();
    try {
      return await this._goalStateOn(lease.server, id);
    } finally {
      lease.release();
    }
  }

  /**
   * `/goal <args>`: an objective or `resume` is followed until the goal stops
   * (it runs its rounds with no idle between them); `pause` and `clear` return
   * at once.
   */
  goalCommand(args: string, opts: { timeout: number; callbacks?: StreamCallbacks }): Promise<CommandOutcome> {
    return this._runServerCommand('goal', args, opts);
  }

  /** Put `text` in the conversation without starting the agent; the next round reads it. */
  async goalContext(text: string): Promise<void> {
    const lease = await this._lease();
    try {
      const id = await this._ensureConversation(lease.server);
      await lease.server.call('POST', `/api/session/${id}/prompt`, { text, resume: false });
    } finally {
      lease.release();
    }
  }

  // ─── Quota ──────────────────────────────────────────────────────────────

  /** `GET /api/experimental/usage/limits`, through the held server when it runs, else `opencode api --standalone`. */
  async readUsageLimits(): Promise<OpencodeUsageLimits | undefined> {
    if (!this._v2) return undefined;
    if (this._server?.alive) {
      return this._server.call<OpencodeUsageLimits>('GET', '/api/experimental/usage/limits');
    }
    return readUsageLimitsStandalone(this.engineBin, this.options.cwd, this.options.launcher);
  }

  protected override _updateCost(): void {
    if (this._reportedCostUsd !== undefined) this._stats.costUsd = this._reportedCostUsd;
    else super._updateCost();
  }

  /**
   * Override getStats to expose the captured session ID.
   *
   * Consumers use its presence to tell "this session resumes a real conversation"
   * from "the session is merely in the manager's map". Without it a caller has to
   * assume the conversation exists, and a session whose first turn died before the
   * run reported an id looks identical to a healthy one.
   */
  getStats(): ReturnType<BaseOneShotSession['getStats']> {
    const base = super.getStats();
    return {
      ...base,
      retries: this._retries,
      ...(this._lastRetryError ? { lastRetryError: this._lastRetryError } : {}),
      opencodeSessionId: this.opencodeSessionId,
    };
  }
}
