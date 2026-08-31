/**
 * Shared types for claw-orchestrator
 */

// Re-export model types and functions from centralized registry
import type { ModelPricing, ProviderName, ModelDef } from './models.js';
import { getAliases } from './models.js';
export type { ModelPricing, ProviderName, ModelDef };
export {
  getModelPricing,
  overrideModelPricing,
  _resetPricingOverrides,
  getModelList,
  resolveAlias,
  resolveEngineAndModel,
  resolveProvider,
  getContextWindow,
  isGeminiModel,
  isClaudeModel,
  estimateTokens,
  lookupModelStrict,
  getAliases,
} from './models.js';

// Backward compat: MODEL_ALIASES as a static object
export const MODEL_ALIASES: Record<string, string> = getAliases();

// ─── Permission & Effort ─────────────────────────────────────────────────────

// 'manual' is the CLI 2.1.200+ name for what used to be 'default'; the CLI
// accepts both, so we do too. 'delegate' was removed — the claude CLI now
// hard-rejects it at spawn ("Allowed choices are acceptEdits, auto,
// bypassPermissions, manual, dontAsk, plan"), verified against 2.1.206.
export type PermissionMode = 'acceptEdits' | 'bypassPermissions' | 'default' | 'manual' | 'dontAsk' | 'plan' | 'auto';

// Engines do not share one ladder, so a level is requested here and clamped by
// whichever wrapper receives it. Claude Code takes low|medium|high|xhigh|max,
// Codex adds `ultra` above `max`, Grok stops at `xhigh`, Antigravity at `high`,
// and OpenCode forwards the level to its provider without validating it. Each
// wrapper documents its own clamp; none of them silently drops the field.
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra' | 'auto';

// ─── Engine ─────────────────────────────────────────────────────────────────

export const ENGINE_TYPES = [
  'claude',
  'codex',
  'codex-app',
  'gemini',
  'agy',
  'cursor',
  'grok',
  'opencode',
  'custom',
] as const;
export type EngineType = (typeof ENGINE_TYPES)[number];

/**
 * The executables the built-in engines actually spawn — the defaults in each
 * `persistent-*-session.ts` (`CODEX_BIN || 'codex'` and friends). Not derivable
 * from ENGINE_TYPES: `codex-app` runs the `codex` binary and `cursor` runs
 * `cursor-agent`. `custom` names its own and so cannot appear here.
 *
 * Kept as one list because orphan reaping matches a live process against it, and
 * a name missing from that match is a CLI that survives a crash forever: `grok`
 * was added as an engine without being added there.
 */
export const ENGINE_BINARY_NAMES = ['claude', 'codex', 'gemini', 'agy', 'cursor-agent', 'grok', 'opencode'] as const;

/**
 * Does this engine carry conversation across sends on its own?
 *
 * claude keeps one subprocess alive. The one-shot engines each resume their own
 * conversation by id: codex / codex-app via `exec resume <thread>`, agy via
 * `--conversation <uuid>`, opencode via `--session <id>`, cursor via
 * `--resume <chatId>`. Only gemini and one-shot custom engines are genuinely
 * amnesiac, having no resume surface to drive.
 *
 * The distinction decides who owns the conversation history. For an engine that
 * carries it, anything injected into a turn stays in the transcript forever, so
 * per-turn boilerplate accumulates and eventually overflows the context window.
 * For an engine that does not, the same content has to be re-sent every turn or
 * it is simply gone.
 *
 * opencode and cursor sat on the `false` side of this for a long time, which was
 * never a property of those CLIs — both have always had a resume flag, and our
 * wrappers even captured the id; they just never passed it back. While that
 * lasted, the autoloop replayed a character-capped (therefore truncating)
 * transcript to them on every turn, and the openai-compat bridge re-sent the
 * whole tool schema block, every tool result, and the system prompt every turn.
 * grok resumes by its own session UUID (`--resume <id>`), verified the same way
 * against 1.0.5: turn 2 answered with the number turn 1 was asked to remember.
 *
 * This is an engine-capability claim, so check an entry with a real two-turn
 * recall test against the binary before trusting it.
 */
export function engineHasNativeConversation(
  engine: EngineType | undefined,
  customEngine?: CustomEngineConfig,
): boolean {
  switch (engine) {
    case 'claude':
    case 'codex':
    case 'codex-app':
    case 'agy':
    case 'opencode':
    case 'cursor':
    case 'grok':
      return true;
    case 'custom':
      // A persistent custom engine is a long-running stdin/stdout process, so it
      // keeps context the same way claude does. One-shot ones do not.
      return customEngine?.persistent === true;
    default:
      return false;
  }
}

// ─── Custom Engine Config ───────────────────────────────────────────────────
//
// Allows users to plug in any coding agent CLI (internal or third-party)
// without writing engine-specific code. The config describes how to invoke
// the CLI binary and map its flags to OpenClaw session concepts.
//
// Two protocol modes:
//   persistent  — long-running subprocess with stream-json I/O over stdin/stdout
//                 (like Claude Code: start once, send messages as JSON lines)
//   one-shot    — spawn a new process per send(), message passed as CLI argument
//                 (like Gemini/Codex: each send is a fresh invocation)

export interface CustomEngineConfig {
  /** Display name for this engine (used in logs and session IDs) */
  name: string;

  /** Binary path or command name, e.g. 'my-agent' or '/usr/local/bin/my-agent' */
  bin: string;

  /**
   * Environment variable name that overrides `bin` at runtime.
   * e.g. 'MY_AGENT_BIN' → process.env.MY_AGENT_BIN takes precedence.
   */
  binEnv?: string;

  /**
   * true  = persistent subprocess (Claude Code style: start once, JSON I/O on stdin/stdout)
   * false = one-shot per send (Gemini/Codex style: spawn per message)
   * @default false
   */
  persistent?: boolean;

  /**
   * CLI flag mappings. Each key is an OpenClaw concept; the value is the CLI
   * flag string your agent expects. Omit any flag your CLI doesn't support.
   *
   * Example for a Claude Code-compatible CLI:
   * ```json
   * {
   *   "print": "-p",
   *   "outputFormat": "--output-format",
   *   "outputFormatValue": "stream-json",
   *   "inputFormat": "--input-format",
   *   "inputFormatValue": "stream-json",
   *   "skipPermissions": "-y",
   *   "permissionMode": "--permission-mode",
   *   "model": "--model",
   *   "systemPrompt": "--system-prompt",
   *   "appendSystemPrompt": "--append-system-prompt",
   *   "maxTurns": "--max-turns",
   *   "resume": "--resume",
   *   "verbose": "--verbose",
   *   "replayUserMessages": "--replay-user-messages",
   *   "includePartialMessages": "--include-partial-messages"
   * }
   * ```
   */
  args: {
    /** Flag for non-interactive / print mode, e.g. '-p' */
    print?: string;
    /** Flag for output format, e.g. '--output-format' */
    outputFormat?: string;
    /** Value for stream-json output format, e.g. 'stream-json' */
    outputFormatValue?: string;
    /** Flag for input format (persistent mode only), e.g. '--input-format' */
    inputFormat?: string;
    /** Value for stream-json input format, e.g. 'stream-json' */
    inputFormatValue?: string;
    /** Flag to skip all permissions, e.g. '-y' or '--dangerously-skip-permissions' */
    skipPermissions?: string;
    /** Flag for permission mode, e.g. '--permission-mode' */
    permissionMode?: string;
    /** Flag for model selection, e.g. '--model' */
    model?: string;
    /** Flag for system prompt override, e.g. '--system-prompt' */
    systemPrompt?: string;
    /** Flag for appending to system prompt, e.g. '--append-system-prompt' */
    appendSystemPrompt?: string;
    /** Flag for max agent turns, e.g. '--max-turns' */
    maxTurns?: string;
    /** Flag for resuming a session, e.g. '--resume' */
    resume?: string;
    /** Flag for verbose output, e.g. '--verbose' */
    verbose?: string;
    /** Flag for replaying user messages, e.g. '--replay-user-messages' (persistent only) */
    replayUserMessages?: string;
    /** Flag for including partial messages, e.g. '--include-partial-messages' (persistent only) */
    includePartialMessages?: string;
    /** Flag for effort level, e.g. '--effort' */
    effort?: string;
    /** Flag for workspace/cwd, e.g. '--workspace' (one-shot only; overrides cwd) */
    workspace?: string;
    /** Additional static arguments always appended to the CLI invocation */
    extra?: string[];
  };

  /**
   * Maps OpenClaw permission mode names to CLI-specific values.
   * e.g. { bypassPermissions: 'yolo', default: 'sandbox' }
   * If omitted, mode names are passed through as-is.
   */
  permissionModes?: Record<string, string>;

  /**
   * Default pricing per 1M tokens (for cost estimation when model is unknown).
   * Falls back to { input: 0, output: 0 } if omitted.
   */
  pricing?: { input: number; output: number; cached?: number };

  /** Context window size in tokens. @default 200000 */
  contextWindow?: number;

  /** Extra environment variables to set when spawning the CLI process */
  env?: Record<string, string>;

  /**
   * Regex patterns to sanitize from stderr output (e.g. API key patterns).
   * Applied as global replacements with '***'.
   */
  sanitizePatterns?: string[];
}

// ─── Session Config ──────────────────────────────────────────────────────────

export interface SessionConfig {
  name: string;
  cwd: string;
  engine?: EngineType;
  model?: string;
  baseUrl?: string;
  permissionMode: PermissionMode;
  // Tool control
  allowedTools?: string[];
  disallowedTools?: string[];
  tools?: string[];
  // Limits
  maxTurns?: number;
  maxBudgetUsd?: number;
  // System prompts
  systemPrompt?: string;
  appendSystemPrompt?: string;
  // Permissions
  dangerouslySkipPermissions?: boolean;
  // Agents
  agents?: Record<string, { description?: string; prompt: string }>;
  agent?: string;
  // Session identity
  customSessionId?: string;
  sessionName?: string;
  claudeResumeId?: string;
  resumeSessionId?: string;
  forkSession?: boolean;
  // Directories
  addDir?: string[];
  // Effort & model
  effort?: EffortLevel;
  modelOverrides?: Record<string, string>;
  enableAutoMode?: boolean;
  resolvedModel?: string;
  // New CLI flags
  bare?: boolean;
  worktree?: string | boolean;
  fallbackModel?: string | string[];
  jsonSchema?: string;
  mcpConfig?: string | string[];
  settings?: string;
  /**
   * Enable Claude Code "ultracode" / dynamic workflows for this session (Claude engine only).
   * NOT a --effort value — the CLI rejects `--effort ultracode`. It is the `ultracode: true`
   * settings key, merged into --settings (per Claude Code 2.1.x model-config docs). When on,
   * Claude writes a JS orchestration script per substantive task and fans out to subagents.
   */
  ultracode?: boolean;
  /**
   * Do not save this session to disk.
   *
   * Two stores, one switch: the engine's own transcript (Claude Code gets
   * `--no-session-persistence`; other CLIs have no equivalent flag) AND this
   * orchestrator's session registry, which is what auto-resume reads. Setting
   * only the first left the session in `~/.openclaw/claude-sessions.json`, so a
   * later `session-start` under the same name silently reattached to the
   * conversation the caller had asked not to keep.
   */
  noSessionPersistence?: boolean;
  /**
   * Internal spelling of the registry half, for callers that create ephemeral
   * sessions programmatically (the openai-compat bridge, the ACP adapter) and
   * must not pass an engine flag that some CLI forks do not accept. Declared
   * here so the check does not have to read it through a cast.
   */
  skipPersistence?: boolean;
  betas?: string | string[];
  enableAgentTeams?: boolean;
  // CLI 2.1.111 features
  /**
   * Policy for peer messages arriving from other Claude Code sessions on this
   * machine (Claude engine). Delivered as a `crossSessionInbound` settings key.
   *
   * `accept` delivers straight into the session, `hold` parks the message until
   * a human approves it in that session's terminal, `refuse` rejects it.
   *
   * Worth setting explicitly for orchestrated sessions. With no value, the CLI
   * decides from the two sides' permission modes and holds when they differ —
   * and an orchestrated session runs `bypassPermissions` or `acceptEdits` while
   * a human's own terminal is usually prompting, so the default outcome for a
   * message between them is `hold`. A held message waits for someone to approve
   * it in a terminal nobody is watching, which for a headless session means it
   * simply expires.
   */
  crossSessionInbound?: 'accept' | 'hold' | 'refuse';
  /** Stream hook lifecycle events (PreToolUse/PostToolUse) */
  includeHookEvents?: boolean;
  /**
   * Forward subagent text and thinking into the stream-json output (CLI 2.1.211+).
   * Without it the parent stream goes quiet while a subagent works, so sessions that
   * fan out (ultracode, agent teams) surface no intermediate output.
   */
  forwardSubagentText?: boolean;
  /** Delegate permission prompts to an MCP tool for non-interactive use */
  permissionPromptTool?: string;
  /** Move cwd/env/git status from system prompt to user message for better prompt cache hits */
  excludeDynamicSystemPromptSections?: boolean;
  /** Enable debug output for specific categories (e.g. "api", "mcp") */
  debug?: string | string[];
  /** Write debug output to file instead of stderr */
  debugFile?: string;
  /** Resume session linked to a GitHub PR number or URL */
  fromPr?: string;
  /** MCP channel subscriptions (research preview) */
  channels?: string | string[];
  /** Load development MCP channels */
  dangerouslyLoadDevelopmentChannels?: string | string[];
  /** Enable 1-hour prompt cache TTL (vs default 5-min) */
  enablePromptCaching1H?: boolean;
  // CLI 2.1.121 features
  /** Fork subagent for non-interactive sessions (sets CLAUDE_CODE_FORK_SUBAGENT=1) */
  forkSubagent?: boolean;
  /** Enable Vertex AI tool search (sets ENABLE_TOOL_SEARCH=1) */
  enableToolSearch?: boolean;
  /** OpenTelemetry: include user prompts in logs (sets OTEL_LOG_USER_PROMPTS=1) */
  otelLogUserPrompts?: boolean;
  /** OpenTelemetry: include raw API request/response bodies in logs (sets OTEL_LOG_RAW_API_BODIES=1) — debug only */
  otelLogRawApiBodies?: boolean;
  // CLI 2.1.122 features
  /**
   * AWS Bedrock service tier (sets ANTHROPIC_BEDROCK_SERVICE_TIER → X-Amzn-Bedrock-Service-Tier header).
   * Only effective when routing through Bedrock. Values: 'default' | 'flex' | 'priority'.
   */
  bedrockServiceTier?: 'default' | 'flex' | 'priority';
  // CLI 2.1.129 features
  /**
   * Fetch additional plugin .zip archive(s) from URL(s) for this session.
   * Each value is passed as `--plugin-url <url>` to Claude Code (2.1.129+).
   * Accepts a single URL or array. No effect when engine is not 'claude'.
   */
  pluginUrl?: string | string[];
  // ─── Sandbox policy ───────────────────────────────────────────────────
  /**
   * Sandbox policy. Codex supports all values; other built-in engines consume
   * `read-only` as their native plan/read-only mode when available.
   * Defaults to 'workspace-write' for Codex.
   */
  sandboxMode?: 'read-only' | 'workspace-write' | 'danger-full-access';
  /**
   * Codex only. Named config profile from `~/.codex/config.toml`, passed as
   * `codex exec --profile <name>`. Bundles model + reasoning effort + approval +
   * permissions on the Codex side.
   */
  codexProfile?: string;
  /**
   * Codex only. Run without loading `$CODEX_HOME/config.toml`
   * (`codex exec --ignore-user-config`), so an orchestrated run is decided by
   * what the caller passed rather than by whatever the machine's own Codex
   * config happens to say. Notably `model = …` in that file changes which model
   * a session with no explicit model actually uses, while the ledger still
   * records this engine's default. Auth continues to resolve from CODEX_HOME.
   */
  ignoreUserConfig?: boolean;
  /**
   * Claude Code only. Restricted mode (`--restricted`): the CLI removes the
   * built-in tools that run commands or code — Bash, PowerShell, the REPL — plus
   * WebFetch unless `tools` names them, and ignores user, project and local
   * settings files.
   *
   * Deliberately separate from `sandboxMode: 'read-only'` rather than folded
   * into it. Read-only maps to plan mode, which holds on its own: measured
   * against 2.1.251, a plan-mode session refused a direct write, a shell write
   * and a delegated subagent write. What `--restricted` adds is that the shell
   * is not merely refused but absent — worth having on an untrusted prompt, and
   * not something to switch on behind a caller's back, because dropping their
   * settings files also drops their CLAUDE.md and hooks.
   */
  restricted?: boolean;
  /** Custom engine configuration — required when engine is 'custom' */
  customEngine?: CustomEngineConfig;
}

// ─── Session Stats ───────────────────────────────────────────────────────────

export interface SessionStats {
  /**
   * Turns that reached the engine, whatever their outcome — NOT sends, and not
   * successes.
   *
   * A turn that ran and then failed still counts here; a turn refused before the
   * engine saw it (spend cap, wrapper timeout) does not. On the one-shot engines
   * this is one per send. On `claude` and a persistent `custom` it counts `user`
   * events, and the CLI emits one per tool-result batch as well as the prompt echo,
   * so a send that used eight tools counts nine — measured against claude-code
   * stream-json, not inferred.
   */
  turns: number;
  /**
   * Turns the engine reported as successful — one per send, on every engine.
   *
   * The predicate is the engine's own terminal verdict, not the exit code: codex
   * fails a turn that emits `turn.failed` while exiting 0, gemini succeeds on exit
   * 53 (its turn limit is a completion), codex-app requires `status: 'completed'`
   * so an interrupted turn does not count.
   *
   * Because `turns` is not one-per-send everywhere, the difference between the two
   * is the failure count on the one-shot engines only. On `claude` and persistent
   * `custom`, compare `turnsSucceeded` against the number of sends instead.
   */
  turnsSucceeded: number;
  toolCalls: number;
  toolErrors: number;
  tokensIn: number;
  tokensOut: number;
  cachedTokens: number;
  costUsd: number;
  isReady: boolean;
  startTime: string | null;
  lastActivity: string | null;
  /**
   * How full the context is (0-100). Two different readings, by engine:
   *
   * - one-shot engines (4.11.0) and codex (4.12.1): the last turn's prompt over
   *   the window the engine enforces, so it rises and falls with the conversation.
   * - `claude` and persistent `custom`: cumulative `tokensIn + tokensOut` over the
   *   model's registry window, so it only grows and overcounts a conversation
   *   whose history is replayed each turn. `getContextWindow()` falls back to
   *   200,000 for a model that is not in the registry.
   *
   * Distinct in either case from `tokensIn`, which is total billed input tokens.
   */
  contextPercent: number;
  /** Total API retry attempts during this session */
  retries: number;
  /** Last API retry error category (e.g. "overloaded", "rate_limit") */
  lastRetryError?: string;
  /** Plugins that failed to load due to unmet dependencies (from system/init event, CLI 2.1.121+) */
  pluginErrors?: Array<{ plugin: string; reason: string }>;
  /** Codex thread ID captured from the most recent `thread.started` event (Codex 0.119+). Used by `codex_resume`. */
  codexThreadId?: string;
  /** Antigravity conversation ID harvested from the agy log file after the first turn. Reused via `--conversation` for multi-turn context. */
  agyConversationId?: string;
  /** Cursor chat ID captured from the stream's `session_id`. Reused via `--resume` for multi-turn context. */
  cursorChatId?: string;
  /** OpenCode session ID captured from the run's JSON output. Reused via `--session` for multi-turn context. */
  opencodeSessionId?: string;
  /**
   * True when the most recent turn's token counts came from estimateTokens()
   * because the engine reported no usage. Cost derived from those counts is an
   * estimate; the run ledger and budget docs surface it as such.
   */
  tokensEstimated?: boolean;
}

// ─── Hook Config ─────────────────────────────────────────────────────────────

export interface HookConfig {
  onToolError?: string;
  onContextHigh?: string;
  onStop?: string;
  onTurnComplete?: string;
  onStopFailure?: string;
}

// ─── Active Session ──────────────────────────────────────────────────────────

export interface ActiveSession {
  config: SessionConfig;
  claudeSessionId?: string;
  created: string;
  stats: SessionStats;
  hooks: HookConfig;
  paused: boolean;
  busy: boolean;
  currentEffort?: EffortLevel;
}

// ─── Send Options ────────────────────────────────────────────────────────────

export interface SendOptions {
  effort?: EffortLevel;
  plan?: boolean;
  autoResume?: boolean;
  timeout?: number;
  stream?: boolean;
  onChunk?: (chunk: string) => void;
  onEvent?: (event: StreamEvent) => void;
  /**
   * council id / fanout id / autoloop run id / workflow run id. Stamped onto the
   * run-ledger row so a multi-agent run can be reassembled from the ledger.
   */
  parentRunId?: string;
  /** Kernel node kind this turn belongs to (`agent`, `council`, `verifier`, …). */
  nodeKind?: string;
  /**
   * Caller-declared task class, for later grouping in the ledger. Never inferred
   * from the prompt — a guessed label would corrupt the comparison it exists to
   * enable.
   */
  taskKind?: string;
}

// ─── Stream Events ───────────────────────────────────────────────────────────

export interface StreamEvent {
  type: string;
  subtype?: string;
  session_id?: string;
  message?: {
    content?: Array<{ type: string; text?: string }>;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
  result?: string;
  is_error?: boolean;
  num_turns?: number;
  total_cost_usd?: number;
  [key: string]: unknown;
}

// ─── Results ─────────────────────────────────────────────────────────────────

export interface SessionInfo {
  name: string;
  claudeSessionId?: string;
  created: string;
  cwd: string;
  model?: string;
  paused: boolean;
  stats: SessionStats;
  /** Cumulative USD spent by this session, as reported by the engine's cost model. */
  costUsd?: number;
  /** The session's spend cap, when one was configured via `maxBudgetUsd`. */
  budgetUsd?: number;
  /** True once `costUsd` reached `budgetUsd` — further turns are refused. */
  budgetExhausted?: boolean;
}

export interface SendResult {
  output: string;
  sessionId?: string;
  error?: string;
  events: StreamEvent[];
}

export interface GrepMatch {
  time: string;
  type: string;
  content: string;
}

export interface AgentInfo {
  name: string;
  file: string;
  description: string;
}

export interface SkillInfo {
  name: string;
  hasSkillMd: boolean;
  description: string;
}

export interface RuleInfo {
  name: string;
  file: string;
  description: string;
  paths: string;
  condition: string;
}

// ─── Session Send Types (used by ISession) ──────────────────────────────────

export interface SessionSendOptions {
  effort?: EffortLevel;
  plan?: boolean;
  waitForComplete?: boolean;
  timeout?: number;
  callbacks?: StreamCallbacks;
}

export interface StreamCallbacks {
  onText?: (text: string) => void;
  onToolUse?: (event: unknown) => void;
  onToolResult?: (event: unknown) => void;
}

export interface TurnResult {
  text: string;
  event: StreamEvent;
}

export interface CostBreakdown {
  model: string;
  tokensIn: number;
  tokensOut: number;
  cachedTokens: number;
  pricing: { inputPer1M: number; outputPer1M: number; cachedPer1M: number | undefined };
  breakdown: { inputCost: number; cachedCost: number; outputCost: number };
  totalUsd: number;
}

// ─── ISession Interface ─────────────────────────────────────────────────────
//
// Engine-agnostic session interface. Every coding engine (Claude Code, Codex,
// Aider, …) implements this so SessionManager can orchestrate them uniformly.

export interface ISession {
  // ── Identity ────────────────────────────────────────────────────────────
  sessionId?: string;
  readonly pid?: number;

  // ── State ───────────────────────────────────────────────────────────────
  readonly isReady: boolean;
  readonly isPaused: boolean;
  readonly isBusy: boolean;

  // ── Lifecycle ───────────────────────────────────────────────────────────
  /** Initialise the engine subprocess. Engine-specific; config passed via constructor. */
  start(): Promise<this>;
  stop(): void;
  pause(): void;
  resume(): void;

  // ── Communication ───────────────────────────────────────────────────────
  send(
    message: string | unknown[],
    options?: SessionSendOptions,
  ): Promise<TurnResult | { requestId: number; sent: boolean }>;

  // ── Observability ───────────────────────────────────────────────────────
  getStats(): SessionStats & { sessionId?: string; uptime: number };
  getHistory(limit?: number): Array<{ time: string; type: string; event: unknown }>;
  getCost(): CostBreakdown;

  // ── Context Management ──────────────────────────────────────────────────
  compact(summary?: string): Promise<TurnResult | { requestId: number; sent: boolean }>;
  getEffort(): EffortLevel;
  setEffort(level: EffortLevel): void;

  // ── Model ───────────────────────────────────────────────────────────────
  resolveModel(alias: string): string;

  // ── EventEmitter ────────────────────────────────────────────────────────
  on(event: string, listener: (...args: unknown[]) => void): this;
  once(event: string, listener: (...args: unknown[]) => void): this;
  emit(event: string, ...args: unknown[]): boolean;
  removeListener(event: string, listener: (...args: unknown[]) => void): this;
}

// ─── Plugin Config ───────────────────────────────────────────────────────────

export interface PluginConfig {
  claudeBin: string;
  defaultModel?: string;
  defaultPermissionMode: PermissionMode;
  defaultEffort: EffortLevel;
  maxConcurrentSessions: number;
  sessionTtlMinutes: number;
  proxy?: ProxyConfig;
  /** Override or extend model pricing at runtime without a new release. */
  pricingOverrides?: Record<string, Partial<ModelPricing>>;
}

export interface ProxyConfig {
  enabled: boolean;
  bigModel: string;
  smallModel: string;
}

// ─── Inbox Types ────────────────────────────────────────────────────────────

export interface InboxMessage {
  from: string;
  text: string;
  timestamp: string;
  read: boolean;
  summary?: string;
}

export interface UltraplanResult {
  id: string;
  status: 'running' | 'completed' | 'error' | 'timeout';
  plan?: string;
  sessionName: string;
  startTime: string;
  endTime?: string;
  error?: string;
}

export interface UltrareviewResult {
  id: string;
  status: 'running' | 'completed' | 'error';
  councilId: string;
  findings?: string;
  agentCount: number;
  startTime: string;
  endTime?: string;
  error?: string;
}

// ─── Council Types ──────────────────────────────────────────────────────────

export type CouncilEventType =
  | 'session-start'
  | 'round-start'
  | 'agent-start'
  | 'agent-chunk'
  | 'agent-tool'
  | 'agent-complete'
  | 'round-end'
  | 'complete'
  | 'error';

export interface CouncilEvent {
  type: CouncilEventType;
  sessionId: string;
  timestamp: string;
  round?: number;
  agent?: string;
  content?: string;
  consensus?: boolean;
  status?: string;
  task?: string;
  error?: string;
  tool?: string;
  toolInput?: string;
  toolStatus?: 'start' | 'end';
}

export interface AgentPersona {
  name: string;
  emoji: string;
  persona: string;
  engine?: EngineType;
  role?: string;
  model?: string;
  baseUrl?: string;
  permissionMode?: PermissionMode;
  customEngine?: CustomEngineConfig;
  /** Per-agent reasoning effort (council only; passed to the agent's session). */
  effort?: EffortLevel;
  /** Per-agent ultracode / dynamic workflows (council, claude engine only). */
  ultracode?: boolean;
}

export interface CouncilConfig {
  name?: string;
  /**
   * Identity for this run, supplied by the kernel. Omitted, the council mints
   * its own UUID — which then appears as the ledger's `parentRunId` instead of
   * the run id everything else uses.
   */
  runId?: string;
  agents: AgentPersona[];
  maxRounds: number;
  projectDir: string;
  agentTimeoutMs?: number;
  maxTurnsPerAgent?: number;
  maxBudgetUsd?: number;
  defaultPermissionMode?: PermissionMode;
}

export interface AgentResponse {
  agent: string;
  round: number;
  content: string;
  consensus: boolean;
  sessionKey: string;
  timestamp: string;
}

export interface CouncilSession {
  id: string;
  task: string;
  config: CouncilConfig;
  responses: AgentResponse[];
  status: 'running' | 'consensus' | 'awaiting_user' | 'max_rounds' | 'error' | 'accepted' | 'rejected';
  startTime: string;
  endTime?: string;
  finalSummary?: string;
  compactContext?: string;
}

// ─── Council Post-Processing Types ─────────────────────────────────────────

/**
 * A reviewer's assessment of a changed file. This is a judgement, not a git
 * fact — nothing in the orchestrator can compute it, and it is populated only
 * when a reviewer supplies one.
 */
export type CouncilFileStatus = 'clean' | 'needs_rework' | 'redundant' | 'missing';

/** What git says happened to the file. Computed, unlike `status`. */
export type CouncilFileChange = 'added' | 'modified' | 'deleted';

export interface CouncilChangedFile {
  file: string;
  /**
   * Absent until a reviewer assesses the file.
   *
   * Through 5.1.0 this was hardcoded to `'clean'` for every entry, which read as
   * "the council reviewed this and found nothing wrong" when in fact nothing had
   * looked at it at all. An unassessed file now says so by being undefined.
   */
  status?: CouncilFileStatus;
  /** Git's own account of the change. */
  change?: CouncilFileChange;
  insertions: number;
  deletions: number;
  note?: string;
}

export interface CouncilReviewResult {
  councilId: string;
  projectDir: string;
  status: 'consensus' | 'max_rounds' | 'error';
  rounds: number;
  planExists: boolean;
  planContent?: string;
  changedFiles: CouncilChangedFile[];
  branches: string[];
  worktrees: string[];
  reviews: string[];
  agentSummaries: Array<{ agent: string; consensus: boolean; preview: string }>;
  /** Reviewer guidance loaded from configs/council-reviewer-prompt.md */
  reviewerGuidance: string;
}

export interface CouncilAcceptResult {
  councilId: string;
  branchesDeleted: string[];
  worktreesRemoved: string[];
  planDeleted: boolean;
  reviewsDeleted: boolean;
}

export interface CouncilRejectResult {
  councilId: string;
  planRewritten: boolean;
  feedback: string;
}
