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

export type PermissionMode = 'acceptEdits' | 'bypassPermissions' | 'default' | 'delegate' | 'dontAsk' | 'plan' | 'auto';

export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'auto';

// ─── Engine ─────────────────────────────────────────────────────────────────

export type EngineType = 'claude' | 'codex' | 'codex-app' | 'gemini' | 'cursor' | 'opencode' | 'custom';

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
  fallbackModel?: string;
  jsonSchema?: string;
  mcpConfig?: string | string[];
  settings?: string;
  noSessionPersistence?: boolean;
  betas?: string | string[];
  enableAgentTeams?: boolean;
  // CLI 2.1.111 features
  /** Stream hook lifecycle events (PreToolUse/PostToolUse) */
  includeHookEvents?: boolean;
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
  // ─── Codex (codex CLI) ────────────────────────────────────────────────
  /**
   * Codex sandbox policy. Replaces the deprecated `--full-auto` flag in Codex 0.124+.
   * Defaults to 'workspace-write' (matches the legacy --full-auto behavior).
   */
  sandboxMode?: 'read-only' | 'workspace-write' | 'danger-full-access';
  /** Custom engine configuration — required when engine is 'custom' */
  customEngine?: CustomEngineConfig;
}

// ─── Session Stats ───────────────────────────────────────────────────────────

export interface SessionStats {
  turns: number;
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
   * Approximate context window utilization (0-100).
   * Estimated as (tokensIn + tokensOut) / 200,000 * 100.
   * Claude Code does not expose exact context usage via the JSON protocol,
   * so this is a best-effort heuristic that may overcount on long conversations.
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
}

export interface CouncilConfig {
  name?: string;
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

export type CouncilFileStatus = 'clean' | 'needs_rework' | 'redundant' | 'missing';

export interface CouncilChangedFile {
  file: string;
  status: CouncilFileStatus;
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
