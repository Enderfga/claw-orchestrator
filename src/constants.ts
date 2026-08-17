/**
 * Shared constants — consolidates magic numbers scattered across the codebase.
 *
 * Grouped by domain. Import what you need rather than using inline numbers.
 */

// ─── Context & Token Limits ────────────────────────────────────────────────

/** Token threshold that triggers the onContextHigh hook */
export const CONTEXT_HIGH_THRESHOLD = 140_000;

// ─── History ────────────────────────────────────────────────────────────────

/** Max history entries kept in memory per session (oldest evicted via shift) */
export const MAX_HISTORY_ITEMS = 100;
/** Default number of history entries returned by getHistory() */
export const DEFAULT_HISTORY_LIMIT = 50;
/** Number of history entries fetched for grep operations */
export const GREP_HISTORY_FETCH = 500;

// ─── Timeouts ───────────────────────────────────────────────────────────────

/** Wait for session init/ready event after spawn */
export const SESSION_READY_TIMEOUT_MS = 30_000;
/** Fallback delay before checking if proc is alive (resume path) */
export const SESSION_READY_FALLBACK_MS = 2_000;
/** Default timeout for a send() / turn completion */
export const TURN_TIMEOUT_MS = 300_000;
/** Timeout for compact / context summary operations */
export const COMPACT_TIMEOUT_MS = 60_000;
/** Delay before SIGKILL after initial SIGTERM on stop() */
export const STOP_SIGKILL_DELAY_MS = 3_000;
/** Timeout for most git CLI operations (branch, checkout, log, diff) */
export const GIT_CMD_TIMEOUT_MS = 5_000;
/** Timeout for git worktree add/remove (heavier operations) */
export const WORKTREE_CMD_TIMEOUT_MS = 10_000;
/** Default per-agent timeout in council */
export const DEFAULT_AGENT_TIMEOUT_MS = 1_800_000;
/** Delay between council rounds */
export const INTER_ROUND_DELAY_MS = 3_000;
/** Delay before retrying on empty agent response */
export const EMPTY_RESPONSE_RETRY_DELAY_MS = 5_000;
/** Timeout for council follow-up prompts */
export const FOLLOWUP_TIMEOUT_MS = 60_000;
/** Timeout for ultraplan sessions */
export const ULTRAPLAN_TIMEOUT_MS = 1_800_000;
/** How long completed results remain queryable */
export const RESULT_TTL_MS = 1_800_000;
/** Session TTL cleanup check interval */
export const CLEANUP_INTERVAL_MS = 60_000;
/** Debounce delay for persisted session writes */
export const DEBOUNCED_SAVE_MS = 5_000;
/** Persisted sessions disk TTL (7 days) */
export const PERSIST_DISK_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Fetch timeout for proxy forward requests */
export const FETCH_TIMEOUT_MS = 600_000;
/** Ultrareview polling interval */
export const ULTRAREVIEW_POLL_INTERVAL_MS = 5_000;

// ─── Server ─────────────────────────────────────────────────────────────────

/** Default port for the embedded HTTP server */
export const DEFAULT_SERVER_PORT = 18_796;
/** Maximum request body size (5 MB) */
export const MAX_BODY_SIZE = 5_242_880;
/** Rate limit: max requests per window per IP */
export const RATE_LIMIT_MAX_REQUESTS = 300;
/** Rate limit: sliding window duration */
export const RATE_LIMIT_WINDOW_MS = 60_000;

// ─── Council ────────────────────────────────────────────────────────────────

/** Minimum task description length */
export const MIN_TASK_LENGTH = 5;
/** Max retries for empty agent responses */
export const EMPTY_RESPONSE_MAX_RETRIES = 2;
/** Minimum response length to consider complete */
export const MIN_COMPLETE_RESPONSE_LENGTH = 100;
/** Max follow-up retries per agent */
export const FOLLOWUP_MAX_RETRIES = 2;
/** Character limit for history preview in council prompts */
export const HISTORY_PREVIEW_CHARS = 1_500;
/** Character limit for agent summary in review */
export const SUMMARY_PREVIEW_CHARS = 500;
/** Character limit for short summary in transcript */
export const SUMMARY_SHORT_CHARS = 400;
/** Character limit for compact context */
export const COMPACT_CONTEXT_CHARS = 300;
/** Default max rounds in council collaboration */
export const DEFAULT_MAX_ROUNDS = 15;
/** Default max turns per agent */
export const DEFAULT_MAX_TURNS_PER_AGENT = 50;
/** Git log depth for council review */
export const GIT_LOG_DEPTH = 50;

// ─── Session Manager Limits ─────────────────────────────────────────────────

/** Max messages per session inbox */
export const MAX_INBOX_SIZE = 200;

// ─── Circuit Breaker ────────────────────────────────────────────────────────

/** Consecutive failures before circuit opens */
export const CIRCUIT_BREAKER_THRESHOLD = 3;
/** Base backoff delay (doubles each failure) */
export const CIRCUIT_BREAKER_BACKOFF_BASE_MS = 1_000;
/** Maximum backoff duration cap */
export const CIRCUIT_BREAKER_MAX_BACKOFF_MS = 300_000;
/** Maximum failure count cap (prevents unbounded backoff growth) */
export const CIRCUIT_BREAKER_MAX_COUNT = 10;

// ─── Session Events ─────────────────────────────────────────────────────────

export const SESSION_EVENT = {
  READY: 'ready',
  INIT: 'init',
  TEXT: 'text',
  TOOL_USE: 'tool_use',
  TOOL_RESULT: 'tool_result',
  RESULT: 'result',
  TURN_COMPLETE: 'turn_complete',
  ERROR: 'error',
  LOG: 'log',
  CLOSE: 'close',
  PAUSED: 'paused',
  RESUMED: 'resumed',
  SYSTEM: 'system',
  API_RETRY: 'api_retry',
  STREAM_EVENT: 'stream_event',
  USER_ECHO: 'user_echo',
  ASSISTANT: 'assistant',
  EVENT: 'event',
} as const;

export type SessionEventName = (typeof SESSION_EVENT)[keyof typeof SESSION_EVENT];

// ─── OpenAI Compat ───────────────────────────────────────────────────────────

/** Default model when the OpenAI-compat request omits `model` */
export const OPENAI_COMPAT_DEFAULT_MODEL = 'claude-sonnet-4-6';
/** Context utilization % threshold for auto-compact */
export const OPENAI_COMPAT_AUTO_COMPACT_THRESHOLD = 80;
/** Session name prefix for OpenAI-compat sessions */
export const OPENAI_COMPAT_SESSION_PREFIX = 'openai-';
/** Session name prefix for ACP sessions. Also the prefix of the ACP session id itself. */
export const ACP_SESSION_PREFIX = 'acp-';
/**
 * Default for the legacy new-conversation heuristic gate.
 *
 * When env var `OPENAI_COMPAT_NEW_CONVO_HEURISTIC=1` is set, the old
 * "system + single user ⇒ new conversation" rule is restored for webchat
 * frontends (ChatGPT-Next-Web, Open WebUI, etc) that re-send the full
 * transcript every turn. Default off: assumes upstream clients forward
 * only the latest turn (OpenClaw main agent loop, cron jobs, subagents).
 *
 * The constant exists as a documentation anchor; openai-compat.ts reads
 * the env var directly so the value can be flipped without restart.
 */
export const OPENAI_COMPAT_NEW_CONVO_HEURISTIC_DEFAULT = false;
