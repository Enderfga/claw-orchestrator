/**
 * SessionManager — manages multiple PersistentClaudeSession instances
 *
 * Replaces the Express server layer. Pure class with no HTTP dependency.
 * Can be used by Plugin tools, CLI, or any other consumer.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFile, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
import * as http from 'node:http';
import { createRequire } from 'node:module';
import RE2 from 're2';

const _require = createRequire(import.meta.url);
function getPluginVersion(): string {
  try {
    // Walk up from this file to find package.json
    let dir = path.dirname(_require.resolve('./session-manager.js').replace('/dist/', '/'));
    for (let i = 0; i < 5; i++) {
      const pkgPath = path.join(dir, 'package.json');
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version?: string };
        if (pkg.version) return pkg.version;
      }
      dir = path.dirname(dir);
    }
  } catch {
    /* ignore */
  }
  return 'unknown';
}

// ─── Persistence ─────────────────────────────────────────────────────────────

const PERSIST_DIR = path.join(os.homedir(), '.openclaw');
const PERSIST_FILE = path.join(PERSIST_DIR, 'claude-sessions.json');
// PERSIST_DISK_TTL_MS imported from ./constants.js

interface PersistedSession {
  name: string;
  claudeSessionId: string;
  cwd: string;
  model?: string;
  engine?: EngineType;
  sandboxMode?: SessionConfig['sandboxMode'];
  originalCreated: string;
  lastResumed: string;
  lastActivity: number;
}

function loadPersistedSessions(): Map<string, PersistedSession> {
  try {
    if (!fs.existsSync(PERSIST_FILE)) return new Map();
    const raw = fs.readFileSync(PERSIST_FILE, 'utf8');
    const arr: PersistedSession[] = JSON.parse(raw);
    const now = Date.now();
    // Filter out entries older than disk TTL
    const valid = arr.filter((s) => now - s.lastActivity < PERSIST_DISK_TTL_MS);
    return new Map(valid.map((s) => [s.name, s]));
  } catch {
    return new Map();
  }
}

// Atomic write: write to .tmp then rename to avoid corrupt reads on crash
function savePersistedSessions(sessions: Map<string, PersistedSession>, logger?: Logger): void {
  try {
    fs.mkdirSync(PERSIST_DIR, { recursive: true });
    const arr = Array.from(sessions.values());
    const tmp = PERSIST_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(arr, null, 2));
    fs.renameSync(tmp, PERSIST_FILE);
  } catch (err) {
    (logger || createConsoleLogger('SessionManager')).warn('Failed to persist sessions:', (err as Error).message);
  }
}

// Async version for hot-path (sendMessage, TTL cleanup)
function savePersistedSessionsAsync(sessions: Map<string, PersistedSession>, logger?: Logger): void {
  const log = logger || createConsoleLogger('SessionManager');
  const arr = Array.from(sessions.values());
  const tmp = PERSIST_FILE + '.tmp';
  fs.mkdir(PERSIST_DIR, { recursive: true }, (mkdirErr) => {
    if (mkdirErr) {
      log.error('Failed to create persist dir:', mkdirErr.message);
      return;
    }
    fs.writeFile(tmp, JSON.stringify(arr, null, 2), (writeErr) => {
      if (writeErr) {
        log.error('Failed to write session file:', writeErr.message);
        return;
      }
      fs.rename(tmp, PERSIST_FILE, (renameErr) => {
        if (renameErr) {
          log.error('Failed to rename session file:', renameErr.message);
          // Clean up orphan tmp file
          fs.unlink(tmp, () => {});
        }
      });
    });
  });
}

// Debounce helper — coalesces rapid writes into one
function makeDebounced(fn: () => void, ms: number): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn();
    }, ms);
  };
}

import { type Logger, createConsoleLogger } from './logger.js';
import { CircuitBreaker } from './circuit-breaker.js';
import { detectRepoLang } from './kernel/repo.js';
import { RunKernel, runDir as kernelRunDir } from './kernel/engine.js';
import { registerDefaultExecutors } from './kernel/nodes/index.js';
import { autoloopStateFromRecord, makeAutoloopExecutor, type AutoloopHandle } from './kernel/nodes/autoloop.js';
import { loadRun, readNodeOutput, type RunSummary } from './kernel/store.js';
import {
  LEGACY_NODE,
  joinFindings,
  toCouncilSession,
  toFanoutSession,
  toUltraplanResult,
  toUltrareviewResult,
  type FanoutNodeData,
} from './kernel/projections.js';
import {
  legacyCouncilWorkflow,
  legacyFanoutWorkflow,
  legacyUltraplanWorkflow,
  splitAgentSecrets,
} from './kernel/templates/index.js';
import type { KernelEvent, RunRecord, RunState, WorkflowSpec } from './kernel/types.js';
import { normalizeContract } from './verify/contract.js';
import { runContract } from './verify/runner.js';
import { evidenceDir, listEvidence, readEvidence, writeEvidence, type EvidenceBundle } from './verify/evidence.js';
import {
  annotateVerdicts,
  appendRunRow,
  readRunLedger,
  summarizeRuns,
  type RunLedgerQuery,
  type RunLedgerRow,
  type RunLedgerSummary,
} from './run-ledger.js';
import { checkBudget, isBudgetExceeded } from './budget.js';
import { InboxManager, type SessionLookup } from './inbox-manager.js';
import { sanitizeCwd, validateName } from './validation.js';
import { PersistentClaudeSession } from './persistent-session.js';
import { PersistentGeminiSession } from './persistent-gemini-session.js';
import { PersistentCodexSession } from './persistent-codex-session.js';
import { PersistentCodexAppServerSession } from './persistent-codex-app-session.js';
import { PersistentCursorSession } from './persistent-cursor-session.js';
import { PersistentGrokSession } from './persistent-grok-session.js';
import { PersistentOpencodeSession } from './persistent-opencode-session.js';
import { PersistentAgySession } from './persistent-agy-session.js';
import { PersistentCustomSession } from './persistent-custom-session.js';
import {
  type SessionConfig,
  type SessionInfo,
  type SendOptions,
  type SendResult,
  type PluginConfig,
  type EffortLevel,
  ENGINE_TYPES,
  type EngineType,
  type CustomEngineConfig,
  type AgentInfo,
  type SkillInfo,
  type RuleInfo,
  type StreamEvent,
  type ISession,
  type CouncilConfig,
  type CouncilSession,
  type CouncilReviewResult,
  type CouncilAcceptResult,
  type CouncilRejectResult,
  type InboxMessage,
  type UltraplanResult,
  type UltrareviewResult,
  overrideModelPricing,
} from './types.js';
import { resolveAlias, isClaudeModel } from './models.js';
import { isAgyConversationId } from './agy-conversation.js';
import { Council } from './council.js';
import { Fanout, type FanoutConfig, type FanoutSession, type FanoutAgentSpec } from './fanout.js';
import { AutoloopRunner } from './autoloop/runner.js';
import { ClaudeAgentDispatcher, type ClaudeAgentDispatcherConfig } from './autoloop/dispatcher.js';
import type { AutoloopState, PushPolicy } from './autoloop/types.js';
import { DEFAULT_PUSH_POLICY } from './autoloop/types.js';
import { Msg as AutoloopMsg, type PushChannel, type PushLevel } from './autoloop/messages.js';
import { appendPushLog, notifyUserFallbackChain } from './autoloop/notify.js';
import { UltraappManager } from './ultraapp/manager.js';
import { UltraappStore, defaultStoreRoot } from './ultraapp/store.js';
import type { UltraappRouter } from './ultraapp/router.js';
import {
  PERSIST_DISK_TTL_MS,
  DEBOUNCED_SAVE_MS,
  CLEANUP_INTERVAL_MS,
  TURN_TIMEOUT_MS,
  GREP_HISTORY_FETCH,
  ULTRAPLAN_TIMEOUT_MS,
  STOP_SIGKILL_DELAY_MS,
  SESSION_EVENT,
  DEFAULT_HISTORY_LIMIT,
} from './constants.js';

// ─── Internal Types ──────────────────────────────────────────────────────────

interface ManagedSession {
  session: ISession;
  config: SessionConfig;
  created: string;
  lastActivity: number;
  cwd: string;
  claudeSessionId?: string;
  skipPersistence?: boolean;
  /**
   * Per-session send chain. Concurrent sendMessage() calls on the same session
   * MUST serialize, otherwise PersistentClaudeSession's single _streamCallbacks
   * field and shared TURN_COMPLETE listener race — the second caller would
   * receive the first caller's response. Each call awaits the previous chain
   * link, then installs its own; release happens in a finally block so a
   * thrown send still unblocks waiters.
   */
  sendChain?: Promise<unknown>;
  /**
   * Latched once cumulative spend reaches `config.maxBudgetUsd`. The gate in
   * sendMessage re-derives this from getCost() anyway; the flag exists so the
   * session listings can show *why* a session stopped accepting turns.
   */
  budgetExhausted?: boolean;
}

/**
 * Structural type for the `codex-app` engine session, exposing the app-server
 * v2 RPC methods used by the codex_interrupt/steer/fork/rollback/models tools.
 * The `interrupt` method is the discriminator for "this is a codex-app session".
 */
type CodexAppSession = ISession & {
  interrupt: () => Promise<{ interrupted: boolean }>;
  steer: (text: string) => Promise<{ steered: boolean; turnId?: string; text?: string }>;
  forkThread: () => Promise<{ threadId: string }>;
  rollback: (numTurns: number) => Promise<void>;
  listModels: () => Promise<unknown[]>;
  listThreads: (opts?: {
    cwd?: string;
    searchTerm?: string;
    archived?: boolean;
    cursor?: string;
    limit?: number;
  }) => Promise<{ data: unknown[]; nextCursor: string | null }>;
};

// ─── Cross-process visibility ───────────────────────────────────────────────
//
// There used to be two separate answers here, neither of them good. Councils
// were enumerated by reading `~/.openclaw/council-logs/*.md` and pulling the id,
// task and status out with regexes — a stub session with no responses and an
// empty config. Autoloop kept its own append-only JSONL registry at
// `~/.claw-orchestrator/autoloop-registry.jsonl`, with its own append / upsert /
// reverse-scan-dedup / rewrite-via-tmp-file implementation, because its ledgers
// lived in whichever workspace the user picked.
//
// Both are gone. Every mode is a kernel run, every run lives under one root, and
// the run store is the index — so `listRuns()` is the single answer, and it
// returns real records rather than reconstructions. Council transcripts are
// still written for humans to read; nothing parses them.

type AutoloopRoleName = 'planner' | 'coder' | 'reviewer';

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === 'string')
  );
}

function validateAutoloopCustomEngine(role: AutoloopRoleName, config: CustomEngineConfig): void {
  const label = role[0].toUpperCase() + role.slice(1);
  const raw = config as unknown as Record<string, unknown>;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`${label} custom engine config must be an object`);
  }
  if (typeof raw.name !== 'string' || !raw.name.trim()) {
    throw new Error(`${label} custom engine config.name must be a non-empty string`);
  }
  if (typeof raw.bin !== 'string' || !raw.bin.trim()) {
    throw new Error(`${label} custom engine config.bin must be a non-empty string`);
  }
  if (typeof raw.args !== 'object' || raw.args === null || Array.isArray(raw.args)) {
    throw new Error(`${label} custom engine config.args must be an object`);
  }
  for (const [key, value] of Object.entries(raw.args)) {
    if (value === undefined) continue;
    if (key === 'extra') {
      if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
        throw new Error(`${label} custom engine config.args.extra must be an array of strings`);
      }
    } else if (typeof value !== 'string') {
      throw new Error(`${label} custom engine config.args.${key} must be a string`);
    }
  }
  if (raw.persistent !== undefined && typeof raw.persistent !== 'boolean') {
    throw new Error(`${label} custom engine config.persistent must be a boolean`);
  }
  if (raw.env !== undefined && !isStringRecord(raw.env)) {
    throw new Error(`${label} custom engine config.env must contain only string values`);
  }
  if (raw.permissionModes !== undefined && !isStringRecord(raw.permissionModes)) {
    throw new Error(`${label} custom engine config.permissionModes must contain only string values`);
  }
  if (
    raw.sanitizePatterns !== undefined &&
    (!Array.isArray(raw.sanitizePatterns) || raw.sanitizePatterns.some((entry) => typeof entry !== 'string'))
  ) {
    throw new Error(`${label} custom engine config.sanitizePatterns must be an array of strings`);
  }
}

function validateAutoloopRole(
  role: AutoloopRoleName,
  engine: EngineType | undefined,
  customEngine: CustomEngineConfig | undefined,
): EngineType {
  const resolved = engine ?? 'claude';
  const label = role[0].toUpperCase() + role.slice(1);
  if (!ENGINE_TYPES.includes(resolved)) {
    throw new Error(`${label} engine '${String(resolved)}' is not supported`);
  }
  if (resolved === 'custom') {
    if (!customEngine) throw new Error(`${label} custom engine config is required`);
    validateAutoloopCustomEngine(role, customEngine);
  }
  return resolved;
}

export class SessionManager {
  private sessions = new Map<string, ManagedSession>();
  private _pendingSessions = new Map<string, Promise<SessionInfo>>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private pluginConfig: PluginConfig;
  private persistedSessions: Map<string, PersistedSession>;
  private _debouncedSave: () => void;
  private _proxyServer: http.Server | null = null;
  private _proxyPort: number | null = null;
  private _activePids = new Map<string, number>();
  private _circuitBreaker = new CircuitBreaker();
  private _inbox = new InboxManager();
  /** cwd → detected language, so the manifest probe runs once per directory. */
  private _repoLangCache = new Map<string, string | undefined>();
  private logger: Logger;
  private _ultraappManager: UltraappManager | null = null;
  private _ultraappRouter: UltraappRouter | null = null;
  private _ultraappRuntimeMode: 'host' | 'docker' = 'host';

  constructor(config?: Partial<PluginConfig>, logger?: Logger) {
    this.logger = logger || createConsoleLogger('SessionManager');
    this.pluginConfig = {
      claudeBin: config?.claudeBin || 'claude',
      defaultModel: config?.defaultModel,
      defaultPermissionMode: config?.defaultPermissionMode || 'acceptEdits',
      defaultEffort: config?.defaultEffort || 'auto',
      maxConcurrentSessions: config?.maxConcurrentSessions || 5,
      sessionTtlMinutes: config?.sessionTtlMinutes || 120,
    };

    // Apply pricing overrides if provided
    if (config?.pricingOverrides) {
      overrideModelPricing(config.pricingOverrides);
    }

    // Load persisted session registry from disk
    this.persistedSessions = loadPersistedSessions();
    // Clean up orphaned child processes from a previous unclean exit
    this._cleanupOrphanedPids();
    // Debounced async writer — at most one write per 5 seconds on hot paths
    this._debouncedSave = makeDebounced(
      () => savePersistedSessionsAsync(this.persistedSessions, this.logger),
      DEBOUNCED_SAVE_MS,
    );

    // Start TTL cleanup timer
    this.cleanupTimer = setInterval(() => this._cleanupIdleSessions(), CLEANUP_INTERVAL_MS);
  }

  /**
   * Lazily-constructed ultraapp manager. The ultraapp manager itself uses
   * `this` as its session-manager dependency; building it lazily avoids any
   * circular initialisation concerns.
   */
  getUltraappManager(): UltraappManager {
    if (!this._ultraappManager) {
      this._ultraappManager = new UltraappManager({
        store: new UltraappStore(defaultStoreRoot()),
        sessionManager: this,
        router: this._ultraappRouter ?? undefined,
        runtimeMode: this._ultraappRuntimeMode,
        // The same kernel every other mode runs on, so an ultraapp build is a
        // run like any other: listed by `workflow_list`, visible in the Runs
        // tab, owned by one process, and resumable at a node boundary.
        kernel: this.kernel,
      });
    }
    return this._ultraappManager;
  }

  /**
   * Inject a started UltraappRouter so deploy + lifecycle wiring becomes
   * available. Must be called BEFORE the first `getUltraappManager()` call —
   * the manager is constructed lazily and reads the router reference at that
   * point. Production: bin/cli.ts wires this. Tests: leave unset to keep
   * v0.2-style "build-complete is resting state" behaviour.
   */
  setUltraappRouter(router: UltraappRouter): void {
    if (this._ultraappManager) {
      throw new Error('setUltraappRouter must be called before getUltraappManager');
    }
    this._ultraappRouter = router;
  }

  /**
   * Pick the ultraapp runtime mode. 'host' (default) spawns the generated
   * app as a regular Node process — works anywhere Node works, no Docker
   * required. 'docker' uses `docker build` + `docker run` for isolation,
   * intended for shared production hosts. Must be called before the first
   * `getUltraappManager()` call.
   */
  setUltraappRuntimeMode(mode: 'host' | 'docker'): void {
    if (this._ultraappManager) {
      throw new Error('setUltraappRuntimeMode must be called before getUltraappManager');
    }
    this._ultraappRuntimeMode = mode;
  }

  // ─── Session Lifecycle ─────────────────────────────────────────────────

  async startSession(config: Partial<SessionConfig> & { name?: string }): Promise<SessionInfo> {
    const name = config.name || `session-${Date.now()}`;

    // Check pending first — a concurrent caller may have already started creation
    const pending = this._pendingSessions.get(name);
    if (pending) return pending;

    if (this.sessions.has(name)) {
      const existing = this.sessions.get(name)!;
      return this._toSessionInfo(name, existing);
    }

    // Create the promise and register it in _pendingSessions BEFORE any async work,
    // so concurrent callers arriving between now and completion see the pending entry.
    const promise = this._doStartSession(name, config);
    this._pendingSessions.set(name, promise);
    try {
      return await promise;
    } finally {
      this._pendingSessions.delete(name);
    }
  }

  private async _doStartSession(
    name: string,
    config: Partial<SessionConfig> & { name?: string },
  ): Promise<SessionInfo> {
    if (this.sessions.size >= this.pluginConfig.maxConcurrentSessions) {
      throw new Error(`Max concurrent sessions (${this.pluginConfig.maxConcurrentSessions}) reached`);
    }

    // Auto-resume: if we have a persisted claudeSessionId for this name, inject it.
    // Skip when the caller asked for no persistence — either spelling. This read
    // used to be `skipPersistence` alone, through a cast, and that field is set
    // only by in-process callers (openai-compat bridge, ACP adapter); everything
    // that arrives over the CLI (`--skip-persistence`) or the MCP tool spells it
    // `noSessionPersistence`, so those sessions were written to the registry and
    // auto-resumed on the next start under the same name.
    const skipPersist = !!(config.skipPersistence || config.noSessionPersistence);
    const persisted = skipPersist ? undefined : this.persistedSessions.get(name);
    // Unified: only use resumeSessionId (claudeResumeId is an internal alias, not exposed)
    const resumeId = config.resumeSessionId ?? persisted?.claudeSessionId;

    // ORDER IS LOAD-BEARING — do not "fix" it by moving `...config` up.
    //
    // Object spread copies own keys even when their value is `undefined`, so any
    // key the caller sets EXPLICITLY (even to undefined) wins over the resolved
    // fallbacks above it. That is deliberate: the autoloop dispatcher passes
    // `model: undefined` for a non-Claude role to mean "use that engine's own
    // default", which must NOT be replaced by the Claude-shaped global default;
    // likewise `sandboxMode: undefined` means "no sandbox". Callers that simply
    // omit a key (MCP session_start, HTTP /session/start, auto-resume by name)
    // leave it absent, so the persisted/default fallback below still applies.
    const fullConfig: SessionConfig = {
      name,
      cwd: config.cwd || persisted?.cwd || process.cwd(),
      permissionMode: config.permissionMode || this.pluginConfig.defaultPermissionMode,
      effort: config.effort || this.pluginConfig.defaultEffort,
      model: config.model || persisted?.model || this.pluginConfig.defaultModel,
      sandboxMode: config.sandboxMode ?? persisted?.sandboxMode,
      ...config,
      ...(resumeId ? { resumeSessionId: resumeId } : {}),
    };

    // Resolve model alias
    if (fullConfig.model) {
      fullConfig.resolvedModel = this._resolveModel(fullConfig.model, fullConfig.modelOverrides);
    }

    // Auto-inject proxy baseUrl for non-Claude models on the claude engine.
    // Starts a local proxy server that converts Anthropic → OpenAI format
    // and forwards to the OpenClaw gateway. Zero config required.
    const engine: EngineType = fullConfig.engine || persisted?.engine || 'claude';
    // Write the resolved engine back so downstream consumers of the managed
    // config (agy resume-id lookups, _persistSession's registry entry) see the
    // real engine even when it came from the persisted registry.
    fullConfig.engine = engine;

    // Circuit breaker — reject early if engine is in backoff
    this._circuitBreaker.check(engine);

    if (engine === 'claude' && fullConfig.resolvedModel && !fullConfig.baseUrl) {
      if (!isClaudeModel(fullConfig.resolvedModel!)) {
        const proxyPort = await this._ensureProxyServer();
        if (proxyPort) {
          fullConfig.baseUrl = `http://127.0.0.1:${proxyPort}`;
        }
      }
    }
    const session = this._createSession(engine, fullConfig);

    session.on(SESSION_EVENT.LOG, (...args: unknown[]) => this.logger.info(`[Session:${name}]`, ...args));

    try {
      await session.start();
    } catch (err) {
      this._circuitBreaker.recordFailure(engine);
      throw err;
    }

    // Engine started successfully — reset circuit breaker
    this._circuitBreaker.reset(engine);

    // Track child process PID for orphan cleanup
    if (session.pid) {
      this._activePids.set(name, session.pid);
      this._savePids();
    }

    const managed: ManagedSession = {
      session,
      config: fullConfig,
      created: persisted?.originalCreated || new Date().toISOString(),
      lastActivity: Date.now(),
      cwd: fullConfig.cwd,
      claudeSessionId: this._sessionResumeId(engine, session),
      skipPersistence: skipPersist,
    };

    this.sessions.set(name, managed);

    // Persist registry after session is live (skip for ephemeral sessions
    // like the openai-compat bridge that set skipPersistence: true)
    if (!skipPersist) {
      this._persistSession(name, managed);
    }

    return this._toSessionInfo(name, managed);
  }

  async sendMessage(name: string, message: string, options: SendOptions = {}): Promise<SendResult> {
    const managed = this._getSession(name);

    // Per-session serialization. Two concurrent sendMessage() calls on the
    // same session previously raced on PersistentClaudeSession._streamCallbacks
    // and the shared TURN_COMPLETE listener — the second caller would receive
    // the first caller's response, and stream callbacks would clobber each
    // other. Chain waiters via a per-session promise so a slow turn blocks
    // (rather than corrupts) subsequent sends.
    const prior = managed.sendChain ?? Promise.resolve();
    let releaseChain!: () => void;
    const link = new Promise<void>((resolve) => {
      releaseChain = resolve;
    });
    managed.sendChain = prior.then(() => link).catch(() => link);
    try {
      await prior;
    } catch {
      /* prior failure shouldn't block this caller */
    }

    // The prior-chain await can sleep arbitrarily long. In that window a
    // concurrent stopSession() may have stopped this session and removed it
    // from the map. Re-check before writing, so we fail cleanly instead of
    // calling send() on a detached/stopped session (TOCTOU on the sessions map).
    if (this.sessions.get(name) !== managed) {
      releaseChain();
      if (managed.sendChain === link) managed.sendChain = undefined;
      throw new Error(`Session '${name}' was stopped while a prior turn was in flight`);
    }

    try {
      managed.lastActivity = Date.now();

      // Spend cap, enforced here rather than per-engine. Claude Code also gets
      // --max-budget-usd (an in-CLI stop is cheaper than an after-the-fact one),
      // but every other engine ignores that flag, so this gate is what actually
      // makes `maxBudgetUsd` mean something on codex/cursor/agy/opencode/custom.
      checkBudget(this._spentUsd(managed), managed.config.maxBudgetUsd, {
        session: name,
        engine: managed.config.engine || 'claude',
      });

      const sendOpts: Record<string, unknown> = {
        waitForComplete: true,
        timeout: options.timeout || TURN_TIMEOUT_MS,
      };

      if (options.effort) sendOpts.effort = options.effort;
      if (options.plan) sendOpts.plan = true;

      if (options.onEvent || options.onChunk) {
        // A throwing user callback must not corrupt the turn or leave the
        // sendChain unreleased — isolate each invocation.
        const safe = (fn: () => void): void => {
          try {
            fn();
          } catch (err) {
            this.logger.warn?.(`sendMessage stream callback threw: ${(err as Error).message}`);
          }
        };
        sendOpts.callbacks = {
          onText: (text: string) => {
            safe(() => options.onChunk?.(text));
            safe(() => options.onEvent?.({ type: 'text', result: text } as StreamEvent));
          },
          onToolUse: (event: unknown) => {
            safe(() => options.onEvent?.({ type: 'tool_use', ...(event as object) } as StreamEvent));
          },
          onToolResult: (event: unknown) => {
            safe(() => options.onEvent?.({ type: 'tool_result', ...(event as object) } as StreamEvent));
          },
        };
      }

      // Ledger bookkeeping. The snapshot/record pair brackets the one place
      // every caller funnels through (council, fanout, autoloop, ACP,
      // openai-compat, MCP, CLI), so a single hook covers all of them.
      const ledgerBefore = this._statsSnapshot(managed);
      const startedAt = Date.now();
      let turnError: string | undefined;

      try {
        const result = await managed.session.send(message, sendOpts);

        // Update the resume-capable session ID if available (skip disk persist
        // for ephemeral sessions that were started with skipPersistence)
        const resumableId = this._managedResumeId(managed);
        if (resumableId) {
          managed.claudeSessionId = resumableId;
          if (!managed.skipPersistence) {
            this._persistSession(name, managed);
          }
        }

        if ('text' in result) {
          // The CLI reports turn-level failures (invalid --model, auth loss) as a
          // result event with is_error and the explanation as its text — without
          // surfacing that here, the error text is indistinguishable from a reply.
          //
          // Deliberately NOT widened to `stop_reason === 'error'`: agy reaches this
          // point with that stop reason while carrying a usable reply, and `error` is
          // read as a hard failure downstream — openai-compat answers 502 and drops
          // the reply, ultraplan discards the plan. The ledger learns the outcome from
          // the session's own counter instead (see `_recordRunTurn`).
          const evt = (result as { event?: Record<string, unknown> }).event;
          if (evt?.is_error) {
            turnError = String((evt.result as string) || result.text || 'turn failed');
          }
          return {
            output: result.text,
            sessionId: this._managedResumeId(managed),
            error: turnError,
            events: [],
          };
        }

        return { output: '', sessionId: this._managedResumeId(managed), events: [] };
      } catch (err) {
        turnError = (err as Error).message;
        throw err;
      } finally {
        this._recordRunTurn(name, managed, ledgerBefore, startedAt, turnError, options.parentRunId, {
          nodeKind: options.nodeKind,
          taskKind: options.taskKind,
        });
      }
    } finally {
      releaseChain();
      // If this was the tail of the chain, clear it so memory doesn't grow.
      if (managed.sendChain === link) managed.sendChain = undefined;
    }
  }

  // ─── Run ledger + budget bookkeeping ───────────────────────────────────
  //
  // Every helper here is defensive by design: a session that throws from
  // getCost()/getStats() (unknown model pricing, engine already torn down)
  // must degrade to "no data" rather than fail the turn it is measuring.

  /** Cumulative USD this session has spent, or 0 when the engine can't say. */
  private _spentUsd(managed: ManagedSession): number {
    try {
      const total = managed.session.getCost()?.totalUsd;
      return Number.isFinite(total) ? total : 0;
    } catch {
      return 0;
    }
  }

  private _statsSnapshot(managed: ManagedSession): {
    turns: number;
    turnsSucceeded: number;
    tokensIn: number;
    tokensOut: number;
    cachedTokens: number;
    toolCalls: number;
    toolErrors: number;
    costUsd: number;
  } {
    const empty = {
      turns: 0,
      turnsSucceeded: 0,
      tokensIn: 0,
      tokensOut: 0,
      cachedTokens: 0,
      toolCalls: 0,
      toolErrors: 0,
      costUsd: 0,
    };
    try {
      const st = managed.session.getStats();
      return {
        turns: st.turns || 0,
        turnsSucceeded: st.turnsSucceeded || 0,
        tokensIn: st.tokensIn || 0,
        tokensOut: st.tokensOut || 0,
        cachedTokens: st.cachedTokens || 0,
        toolCalls: st.toolCalls || 0,
        toolErrors: st.toolErrors || 0,
        costUsd: this._spentUsd(managed),
      };
    } catch {
      return empty;
    }
  }

  /**
   * Append one ledger row for the turn that just settled, and latch
   * budgetExhausted when this turn took the session over its cap.
   *
   * Rows carry per-turn deltas rather than session totals so that summing a
   * query gives the spend for that window without double-counting.
   */
  private _recordRunTurn(
    name: string,
    managed: ManagedSession,
    before: ReturnType<SessionManager['_statsSnapshot']>,
    startedAt: number,
    error: string | undefined,
    parent: string | undefined,
    dims: { nodeKind?: string; taskKind?: string } = {},
  ): void {
    const after = this._statsSnapshot(managed);
    const delta = (a: number, b: number): number => Math.max(0, a - b);
    const row: RunLedgerRow = {
      ts: new Date().toISOString(),
      session: name,
      engine: (managed.config.engine || 'claude') as EngineType,
      cwd: managed.cwd,
      turn: after.turns || before.turns + 1,
      tokensIn: delta(after.tokensIn, before.tokensIn),
      tokensOut: delta(after.tokensOut, before.tokensOut),
      cachedTokens: delta(after.cachedTokens, before.cachedTokens),
      costUsd: Math.round(delta(after.costUsd, before.costUsd) * 10000) / 10000,
      tokensEstimated: this._turnWasEstimated(managed),
      durationMs: Date.now() - startedAt,
      toolCalls: delta(after.toolCalls, before.toolCalls),
      toolErrors: delta(after.toolErrors, before.toolErrors),
      // One signal, not two predicates: the row is successful when the session's own
      // counter moved, so `ok` and `stats.turnsSucceeded` cannot disagree. `turns` is the
      // guard — when no turn was recorded at all (a getStats() that threw and left both
      // snapshots empty, so the counter cannot be read) this falls back to "nothing was
      // thrown", which is what the field meant before. The counter is also what closes
      // `stop_reason: 'process_exit'`: a CLI that dies mid-turn resolves without a result
      // event, so the counter never moves and the row is no longer recorded as a success.
      ok: !error && (after.turns > before.turns ? after.turnsSucceeded > before.turnsSucceeded : true),
    };
    // Fall back to the engine's own reported model, so a session started
    // without an explicit `model` still records what actually answered.
    const model = managed.config.resolvedModel || managed.config.model || this._reportedModel(managed);
    if (model) row.model = model;
    if (error) row.error = error.slice(0, 500);
    if (parent) row.parent = parent;
    if (dims.nodeKind) row.nodeKind = dims.nodeKind;
    if (dims.taskKind) row.taskKind = dims.taskKind;
    // Detected from a manifest, never guessed. `verified` is deliberately absent
    // here: the verdict does not exist yet at turn time, and is joined in at read
    // time by annotateVerdicts().
    const repoLang = this._repoLang(managed.cwd);
    if (repoLang) row.repoLang = repoLang;

    appendRunRow(row, this.logger);

    if (isBudgetExceeded(after.costUsd, managed.config.maxBudgetUsd)) {
      managed.budgetExhausted = true;
    }
  }

  /**
   * Repo language for the ledger row, memoised per cwd — the detector stats a
   * handful of manifest paths and a turn-rate filesystem probe is wasteful when
   * a session's cwd never changes.
   */
  private _repoLang(cwd: string): string | undefined {
    if (!cwd) return undefined;
    if (!this._repoLangCache.has(cwd)) {
      this._repoLangCache.set(cwd, detectRepoLang(cwd));
    }
    return this._repoLangCache.get(cwd);
  }

  private _reportedModel(managed: ManagedSession): string | undefined {
    try {
      return managed.session.getCost()?.model || undefined;
    } catch {
      return undefined;
    }
  }

  private _turnWasEstimated(managed: ManagedSession): boolean {
    try {
      return managed.session.getStats().tokensEstimated === true;
    } catch {
      return false;
    }
  }

  /**
   * Query the durable run ledger. Unlike getStats()/getCost(), this survives a
   * process restart and covers sessions this manager never owned.
   */
  getRunLedger(query: RunLedgerQuery = {}): { rows: RunLedgerRow[]; summary: RunLedgerSummary } {
    // Join each row to the verdict of the run it belonged to. The turns that did
    // the work all finish before the verifier that judged it, so the verdict
    // cannot be written at turn time — see `annotateVerdicts`.
    //
    // `verified` is deliberately withheld from the read: applying it there would
    // filter on a field no row carries yet and return nothing. It is applied
    // after the join instead.
    const { verified, ...readQuery } = query;
    const rows = annotateVerdicts(readRunLedger(readQuery, this.logger), (parent) => {
      const record = loadRun(parent);
      if (!record || record.outcome === 'unverified') return undefined;
      return {
        verified: record.outcome === 'verified',
        evidenceId: record.evidenceId,
        contractId: record.spec?.contract?.id,
      };
    });
    const filtered = verified === undefined ? rows : rows.filter((r) => r.verified === verified);
    return { rows: filtered, summary: summarizeRuns(filtered) };
  }

  // ─── Workflow kernel ──────────────────────────────────────────────────────

  /**
   * Lazily built, like every other subsystem here — constructing it at plugin
   * load would create run directories for a process that may never run anything.
   */
  private get kernel(): RunKernel {
    if (!this._kernel) {
      const kernel = registerDefaultExecutors(new RunKernel({ manager: this, logger: this.logger }), (name) =>
        this._resolveTemplate(name),
      );
      // The autoloop engine needs sessions, prompt files and push channels, so
      // its executor is registered here with a builder closed over `this`
      // rather than living in the kernel.
      kernel.setExecutor(
        'autoloop',
        makeAutoloopExecutor({
          boot: (config, secrets) =>
            this._bootAutoloop({
              ...(config as Parameters<SessionManager['_bootAutoloop']>[0]),
              // Custom-engine configs never reach the spec, so they come from
              // the run's in-memory secret bag — supplied at start, and
              // re-supplied by the caller on a resume.
              ...(secrets as Partial<Parameters<SessionManager['_bootAutoloop']>[0]>),
            }),
          ready: (key, value) => {
            const deferred = this._autoloopReady.get(key);
            if (!deferred) return;
            if (value instanceof Error) deferred.reject(value);
            else deferred.resolve(value);
          },
          waitForExit: (handle, signal) => this._awaitAutoloopExit(handle, signal),
          registerPublisher: (runId, publish) => this._autoloopPublishers.set(runId, publish),
          unregisterPublisher: (runId) => this._autoloopPublishers.delete(runId),
          extra: (runId) => {
            const roleSelection = this._autoloopSelection.get(runId);
            return roleSelection ? { roleSelection } : {};
          },
        }),
      );
      this._kernel = kernel;
    }
    return this._kernel;
  }

  /** Named built-ins available to `subflow` nodes and to `workflow_start`. */
  private _resolveTemplate(name: string): WorkflowSpec | undefined {
    // Built-ins need caller arguments, so a bare name only resolves to a
    // previously started run's spec — a subflow referencing a template by name
    // without arguments has nothing to run.
    const record = loadRun(name);
    return record?.spec;
  }

  /**
   * Subscribe to kernel events (for the SSE endpoint). Returns an unsubscribe
   * function — SessionManager is not an EventEmitter, and making it one just for
   * this would widen its surface for one consumer.
   */
  onWorkflowEvent(listener: (e: { runId: string; event: KernelEvent }) => void): () => void {
    const k = this.kernel;
    k.on('kernel-event', listener);
    return () => {
      k.off('kernel-event', listener);
    };
  }

  async workflowStart(
    spec: WorkflowSpec,
    opts: { runId?: string; cwd?: string; contract?: unknown } = {},
  ): Promise<RunRecord> {
    return this.kernel.start(spec, opts);
  }

  workflowStatus(runId: string): RunRecord {
    const record = this.kernel.get(runId);
    if (!record) throw new Error(`Workflow run '${runId}' not found`);
    return record;
  }

  workflowList(query: { workflow?: string; state?: RunState; limit?: number } = {}): RunSummary[] {
    return this.kernel.list(query);
  }

  workflowCancel(runId: string): { cancelled: boolean } {
    return { cancelled: this.kernel.cancel(runId) };
  }

  /**
   * Re-attach to a run.
   *
   * `secrets` re-supplies the material the spec deliberately does not carry —
   * per-agent custom-engine configs, keyed as `{ agentCustomEngines: { <name>: cfg } }`.
   * A run that used one cannot be resumed in a fresh process without them,
   * because they were never written down.
   */
  async workflowResume(runId: string, opts: { secrets?: Record<string, unknown> } = {}): Promise<RunRecord> {
    return this.kernel.resume(runId, { secrets: opts.secrets });
  }

  workflowSteer(runId: string, text: string): { steered: boolean } {
    return { steered: this.kernel.steer(runId, text) };
  }

  workflowApprove(runId: string, approved: boolean): { answered: boolean } {
    return { answered: this.kernel.approve(runId, approved) };
  }

  workflowDelete(runId: string): void {
    this.kernel.delete(runId);
  }

  workflowEvidence(runId: string, evidenceId?: string): EvidenceBundle | undefined {
    const dir = kernelRunDir(runId);
    const id = evidenceId ?? this.kernel.get(runId)?.evidenceId ?? listEvidence(dir).at(-1);
    return id ? readEvidence(dir, id) : undefined;
  }

  /**
   * Run an acceptance contract against a directory, outside any workflow.
   *
   * This is the escape hatch for work that did not come through the kernel — a
   * plain `session_send` that edited a repo, or a run from an older version. The
   * contract comes from the caller and is normalized before anything executes.
   */
  async verifyRun(args: { cwd: string; contract: unknown; baseSha?: string; label?: string }): Promise<EvidenceBundle> {
    const contract = normalizeContract(args.contract);
    if (!contract) throw new Error('verifyRun requires a contract with at least one recognised check');
    const runId = args.label || `verify-${Date.now().toString(36)}`;
    const dir = kernelRunDir(runId);
    const evidenceId = 'verify-01';
    const { results, rounds } = await runContract(contract, {
      cwd: args.cwd,
      artifactDir: evidenceDir(dir, evidenceId),
      baseSha: args.baseSha,
      logger: this.logger,
    });
    return writeEvidence({
      runDir: dir,
      runId,
      node: 'run',
      evidenceId,
      cwd: args.cwd,
      baseSha: args.baseSha,
      contractId: contract.id,
      results,
      rounds,
      logger: this.logger,
    });
  }

  async stopSession(name: string, opts: { keepPersisted?: boolean } = {}): Promise<void> {
    const managed = this._getSession(name);
    managed.session.stop();
    this.sessions.delete(name);
    // Remove PID tracking
    this._activePids.delete(name);
    this._savePids();
    if (!opts.keepPersisted) {
      // Explicit stop = user intent to end session — remove from disk too.
      // Callers that want the session resumable (autoloop terminate that
      // should still allow /autoloop/<id>/resume to reattach the Planner's
      // Claude conversation) pass keepPersisted: true.
      this.persistedSessions.delete(name);
      savePersistedSessions(this.persistedSessions, this.logger);
    }
  }

  listSessions(): SessionInfo[] {
    return Array.from(this.sessions.entries()).map(([name, managed]) => this._toSessionInfo(name, managed));
  }

  listPersistedSessions(): PersistedSession[] {
    return Array.from(this.persistedSessions.values());
  }

  getStatus(name: string): SessionInfo & { stats: ReturnType<ISession['getStats']> } {
    const managed = this._getSession(name);
    return {
      ...this._toSessionInfo(name, managed),
      stats: managed.session.getStats(),
    };
  }

  // ─── Session Operations ────────────────────────────────────────────────

  async grepSession(
    name: string,
    pattern: string,
    limit = DEFAULT_HISTORY_LIMIT,
  ): Promise<Array<{ time: string; type: string; content: string }>> {
    const managed = this._getSession(name);
    const history = managed.session.getHistory(GREP_HISTORY_FETCH);
    const regex = new RE2(pattern, 'i');
    return history
      .filter((ev) => regex.test(JSON.stringify(ev)))
      .slice(0, limit)
      .map((ev) => ({
        time: ev.time,
        type: ev.type,
        content: JSON.stringify(ev.event),
      }));
  }

  async compactSession(name: string, summary?: string): Promise<void> {
    const managed = this._getSession(name);
    await managed.session.compact(summary);
  }

  setEffort(name: string, level: EffortLevel): void {
    const managed = this._getSession(name);
    managed.session.setEffort(level);
    managed.config.effort = level;
  }

  /**
   * Switch model for a session.
   * Updates in-memory config only (takes effect on next restart/resume).
   * For immediate effect, call restartWithConfig() explicitly.
   */
  setModel(name: string, model: string): void {
    const managed = this._getSession(name);
    const resolved = this._resolveModel(model, managed.config.modelOverrides);
    managed.config.model = model;
    managed.config.resolvedModel = resolved;
  }

  /**
   * Switch model immediately by restarting the session with --resume.
   * Conversation history is preserved via the claude session ID.
   *
   * Guards:
   * - Rejects if session is currently processing a message (busy guard)
   * - Validates model string against known aliases before restarting
   * - Rolls back to old session if startSession fails
   */
  async switchModel(name: string, model: string): Promise<SessionInfo> {
    const managed = this._getSession(name);

    // Busy guard — don't restart mid-message
    if (managed.session.isBusy) {
      throw new Error(
        `Session '${name}' is currently processing a message. Wait for it to finish before switching model.`,
      );
    }

    // An agy session with no harvested conversation yet has no history to
    // preserve — restart it fresh instead of rejecting the switch.
    const sessionId = this._managedResumeId(managed);
    if (!sessionId && managed.config.engine !== 'agy') {
      throw new Error(`Session '${name}' has no claude session ID — cannot resume after restart`);
    }

    // Validate model — must be a known alias or contain a recognisable pattern
    const resolvedModel = this._resolveModel(model, managed.config.modelOverrides);
    const knownPatterns = ['claude-', 'gemini-', 'gpt-', 'anthropic/', 'google/', 'openai/'];
    const looksValid = knownPatterns.some((p) => resolvedModel.includes(p));
    if (!looksValid) {
      throw new Error(
        `Unknown model '${model}' (resolved: '${resolvedModel}'). Use a known alias (opus, sonnet, haiku, gemini-pro, etc.) or a full provider/model string.`,
      );
    }

    const oldConfig = { ...managed.config };
    managed.session.stop();
    this.sessions.delete(name);

    try {
      return await this.startSession({
        ...oldConfig,
        name,
        model,
        ...(sessionId ? { resumeSessionId: sessionId } : {}),
      });
    } catch (err) {
      // Rollback: restart with original config
      this.logger.error(`switchModel failed for '${name}', attempting rollback:`, err);
      try {
        await this.startSession({ ...oldConfig, name, ...(sessionId ? { resumeSessionId: sessionId } : {}) });
      } catch (rollbackErr) {
        this.logger.error(`Rollback also failed for '${name}':`, rollbackErr);
      }
      throw new Error(`Failed to switch model for '${name}': ${(err as Error).message}`);
    }
  }

  /**
   * Update allowedTools or disallowedTools at runtime.
   *
   * The claude CLI does not support changing tool lists while running, so
   * the only way to apply new constraints is to restart the process with
   * the updated flags and --resume to replay conversation history.
   *
   * Guards:
   * - Rejects if session is busy
   * - Rolls back to old session if startSession fails
   * - merge:true adds tools; removeTools removes specific tools from the list
   */
  async updateTools(
    name: string,
    opts: {
      allowedTools?: string[];
      disallowedTools?: string[];
      removeTools?: string[];
      merge?: boolean;
    },
  ): Promise<SessionInfo> {
    const managed = this._getSession(name);

    // Busy guard
    if (managed.session.isBusy) {
      throw new Error(
        `Session '${name}' is currently processing a message. Wait for it to finish before updating tools.`,
      );
    }

    // An agy session with no harvested conversation yet has no history to
    // preserve — restart it fresh instead of rejecting the update.
    const sessionId = this._managedResumeId(managed);
    if (!sessionId && managed.config.engine !== 'agy') {
      throw new Error(`Session '${name}' has no claude session ID — cannot resume after restart`);
    }

    const oldConfig = { ...managed.config };
    let newAllowed = opts.allowedTools;
    let newDisallowed = opts.disallowedTools;

    if (opts.merge) {
      newAllowed = opts.allowedTools
        ? [...new Set([...(oldConfig.allowedTools || []), ...opts.allowedTools])]
        : oldConfig.allowedTools;
      newDisallowed = opts.disallowedTools
        ? [...new Set([...(oldConfig.disallowedTools || []), ...opts.disallowedTools])]
        : oldConfig.disallowedTools;
    }

    // Remove specific tools if requested
    if (opts.removeTools?.length) {
      const removeSet = new Set(opts.removeTools);
      if (newAllowed) newAllowed = newAllowed.filter((t) => !removeSet.has(t));
      if (newDisallowed) newDisallowed = newDisallowed.filter((t) => !removeSet.has(t));
    }

    managed.session.stop();
    this.sessions.delete(name);

    try {
      return await this.startSession({
        ...oldConfig,
        name,
        allowedTools: newAllowed,
        disallowedTools: newDisallowed,
        ...(sessionId ? { resumeSessionId: sessionId } : {}),
      });
    } catch (err) {
      this.logger.error(`updateTools failed for '${name}', attempting rollback:`, err);
      try {
        await this.startSession({ ...oldConfig, name, ...(sessionId ? { resumeSessionId: sessionId } : {}) });
      } catch (rollbackErr) {
        this.logger.error(`Rollback also failed for '${name}':`, rollbackErr);
      }
      throw new Error(`Failed to update tools for '${name}': ${(err as Error).message}`);
    }
  }

  getCost(name: string) {
    const managed = this._getSession(name);
    return managed.session.getCost();
  }

  // ─── Agent/Skill/Rule Management ──────────────────────────────────────

  listAgents(cwd?: string): AgentInfo[] {
    const safeCwd = sanitizeCwd(cwd);
    const projectDir = path.join(safeCwd || os.homedir(), '.claude', 'agents');
    const globalDir = path.join(os.homedir(), '.claude', 'agents');
    const project = this._listMdFiles(projectDir);
    const global = this._listMdFiles(globalDir);
    const seen = new Set(project.map((a) => a.name));
    return [...project, ...global.filter((a) => !seen.has(a.name))];
  }

  createAgent(name: string, cwd?: string, description?: string, prompt?: string): string {
    validateName(name);
    const safeCwd = sanitizeCwd(cwd);
    const dir = path.join(safeCwd || os.homedir(), '.claude', 'agents');
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `${name}.md`);
    const content = `---\ndescription: ${description || name}\n---\n\n${prompt || `You are ${name}.`}\n`;
    fs.writeFileSync(filePath, content);
    return filePath;
  }

  listSkills(cwd?: string): SkillInfo[] {
    const safeCwd = sanitizeCwd(cwd);
    const dirs = [
      path.join(safeCwd || os.homedir(), '.claude', 'skills'),
      path.join(os.homedir(), '.claude', 'skills'),
    ];
    const all: SkillInfo[] = [];
    const seen = new Set<string>();
    for (const dir of dirs) {
      if (!fs.existsSync(dir)) continue;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory() || seen.has(entry.name)) continue;
        seen.add(entry.name);
        const skillMd = path.join(dir, entry.name, 'SKILL.md');
        let description = '';
        if (fs.existsSync(skillMd)) {
          const content = fs.readFileSync(skillMd, 'utf8');
          const match = content.match(/^---\n[\s\S]*?description:\s*(.+)/m);
          if (match) description = match[1].trim();
        }
        all.push({ name: entry.name, hasSkillMd: fs.existsSync(skillMd), description });
      }
    }
    return all;
  }

  createSkill(name: string, cwd?: string, opts?: { description?: string; prompt?: string; trigger?: string }): string {
    validateName(name);
    const safeCwd = sanitizeCwd(cwd);
    const dir = path.join(safeCwd || os.homedir(), '.claude', 'skills', name);
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, 'SKILL.md');
    let content = '---\n';
    if (opts?.description) content += `description: ${opts.description}\n`;
    if (opts?.trigger) content += `trigger: ${opts.trigger}\n`;
    content += `---\n\n${opts?.prompt || `# ${name}\n\nSkill instructions here.\n`}\n`;
    fs.writeFileSync(filePath, content);
    return filePath;
  }

  listRules(cwd?: string): RuleInfo[] {
    const safeCwd = sanitizeCwd(cwd);
    const dirs = [path.join(safeCwd || os.homedir(), '.claude', 'rules'), path.join(os.homedir(), '.claude', 'rules')];
    const all: RuleInfo[] = [];
    const seen = new Set<string>();
    for (const dir of dirs) {
      if (!fs.existsSync(dir)) continue;
      for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.md'))) {
        const name = f.replace('.md', '');
        if (seen.has(name)) continue;
        seen.add(name);
        const content = fs.readFileSync(path.join(dir, f), 'utf8');
        const descMatch = content.match(/^---\n[\s\S]*?description:\s*(.+)/m);
        const pathsMatch = content.match(/^---\n[\s\S]*?paths:\s*(.+)/m);
        const ifMatch = content.match(/^---\n[\s\S]*?if:\s*(.+)/m);
        all.push({
          name,
          file: f,
          description: descMatch?.[1]?.trim() || '',
          paths: pathsMatch?.[1]?.trim() || '',
          condition: ifMatch?.[1]?.trim() || '',
        });
      }
    }
    return all;
  }

  createRule(
    name: string,
    cwd?: string,
    opts?: { description?: string; content?: string; paths?: string; condition?: string },
  ): string {
    validateName(name);
    const safeCwd = sanitizeCwd(cwd);
    const dir = path.join(safeCwd || os.homedir(), '.claude', 'rules');
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `${name}.md`);
    let fileContent = '---\n';
    if (opts?.description) fileContent += `description: ${opts.description}\n`;
    if (opts?.paths) fileContent += `paths: ${opts.paths}\n`;
    if (opts?.condition) fileContent += `if: ${opts.condition}\n`;
    fileContent += `---\n\n${opts?.content || `# ${name}\n\nRule instructions here.\n`}\n`;
    fs.writeFileSync(filePath, fileContent);
    return filePath;
  }

  // ─── Agent Teams ───────────────────────────────────────────────────────

  async teamList(name: string): Promise<string> {
    // Validate the calling session exists, but list all other sessions as virtual
    // teammates regardless of engine. Claude Code's native Agent Teams (v2.1.32+,
    // gated by CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS) is an in-process TUI
    // mechanism — it has no `/team` slash command and no stdin-driven mailbox
    // accessible to a subprocess wrapper. Earlier code assumed `/team` existed
    // and got back `Unknown command: /team` (issue #48).
    this._getSession(name);

    const teammates: string[] = [];
    for (const [sessionName, m] of this.sessions) {
      if (sessionName === name) continue;
      const eng = m.config.engine || 'claude';
      const stats = m.session.getStats();
      const status = m.session.isBusy ? 'busy' : m.session.isPaused ? 'paused' : 'idle';
      teammates.push(`- ${sessionName} (${eng}, ${status}, ${stats.turns} turns)`);
    }
    return teammates.length > 0
      ? `Virtual team (${teammates.length} sessions):\n${teammates.join('\n')}`
      : 'No other active sessions';
  }

  async teamSend(name: string, teammate: string, message: string): Promise<SendResult> {
    const managed = this._getSession(name);

    if (!this.sessions.has(teammate)) {
      throw new Error(`Target session '${teammate}' not found. Use team_list to see available sessions.`);
    }
    const deliveryResult = await this.sessionSendTo(name, teammate, message, `team message from ${name}`);
    return {
      output: deliveryResult.delivered
        ? `Message delivered to ${teammate}`
        : `Message queued for ${teammate} (session is busy)`,
      sessionId: this._managedResumeId(managed),
      events: [],
    };
  }

  // ─── Health ────────────────────────────────────────────────────────────

  /**
   * Returns an overview of all active sessions — analogous to a dashboard.
   * Unlike coding_session_status (single session), this gives the aggregate
   * view: how many sessions are running, which are busy, total uptime, etc.
   */
  health(): {
    ok: boolean;
    version: string;
    sessions: number;
    sessionNames: string[];
    uptime: number;
    details: Array<{
      name: string;
      ready: boolean;
      busy: boolean;
      paused: boolean;
      turns: number;
      turnsSucceeded: number;
      costUsd: number;
      contextPercent: number;
      lastActivity: string | null;
    }>;
    circuitBreakers: Record<string, { failures: number; backoffUntil: string | null }>;
  } {
    const details = Array.from(this.sessions.entries()).map(([name, managed]) => {
      const stats = managed.session.getStats();
      return {
        name,
        ready: stats.isReady,
        busy: managed.session.isBusy,
        paused: managed.session.isPaused,
        turns: stats.turns,
        turnsSucceeded: stats.turnsSucceeded,
        costUsd: stats.costUsd,
        contextPercent: stats.contextPercent,
        lastActivity: stats.lastActivity,
      };
    });

    return {
      ok: true,
      version: getPluginVersion(),
      sessions: this.sessions.size,
      sessionNames: Array.from(this.sessions.keys()),
      uptime: process.uptime(),
      details,
      circuitBreakers: this._circuitBreaker.getStatus(),
    };
  }

  /** Return plugin version from package.json */
  getVersion(): string {
    return getPluginVersion();
  }

  // ─── Shutdown ──────────────────────────────────────────────────────────

  /**
   * Gracefully shut down the session manager.
   *
   * 1. Cancels the periodic TTL cleanup timer
   * 2. Stops all ultrareview polling intervals
   * 3. Sends SIGTERM to all active session child processes
   * 4. Persists final session registry to disk
   *
   * After shutdown(), no new sessions can be started. Idempotent.
   */
  async shutdown(): Promise<void> {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    // Council, fan-out, ultraplan and ultrareview no longer have timers or maps
    // to tear down here: the kernel owns their lifecycle, and `shutdown` on it
    // cancels every live run. Four separate 30-minute TTL closures used to sit
    // in this method, each capturing `this`.
    // Autoloops included: cancelling their run stops the loop, which shuts down
    // its three persistent agents. One teardown path for every mode.
    if (this._kernel) await this._kernel.shutdown();
    // Stop all sessions
    for (const [name, managed] of this.sessions) {
      try {
        managed.session.stop();
      } catch {
        // Best-effort — session may already be dead; must not block cleanup
      }
      this.logger.info(`Stopped session: ${name}`);
    }
    this.sessions.clear();
    // Clear PID tracking
    this._activePids.clear();
    this._savePids();
    // Stop proxy server
    if (this._proxyServer) {
      this._proxyServer.close();
      this._proxyServer = null;
      this._proxyPort = null;
    }
    // Persist final state (TTL-expired sessions already removed by cleanup)
    savePersistedSessions(this.persistedSessions, this.logger);
  }

  // ─── Codex /goal helpers (codex-app engine only) ─────────────────────

  /**
   * Send a `/goal <args>` slash command to a `codex-app` session. Used by
   * the `codex_goal_*` tools. The server-side parser interprets the slash
   * command and emits goal-related notifications which the session class
   * caches.
   *
   * Errors clearly when called against a non-`codex-app` session — those
   * sessions cannot interpret `/goal` (the `codex exec` path has no slash
   * command surface).
   */
  async codexGoalCommand(
    name: string,
    slashArgs: string,
    timeoutMs?: number,
  ): Promise<{ ok: true; text: string; goal: unknown }> {
    const managed = this.sessions.get(name);
    if (!managed) throw new Error(`Session not found: ${name}`);
    const session = managed.session as ISession & {
      sendGoalCommand?: (args: string, timeoutMs?: number) => Promise<{ text: string; goal: unknown }>;
    };
    if (typeof session.sendGoalCommand !== 'function') {
      const engine = managed.config.engine || 'claude';
      throw new Error(
        `Session "${name}" uses engine "${engine}" which does not support /goal. ` +
          `Start a session with engine: "codex-app" to use the goal tools.`,
      );
    }
    const result = await session.sendGoalCommand(slashArgs, timeoutMs);
    return { ok: true, text: result.text, goal: result.goal };
  }

  /**
   * Read the cached goal state from a `codex-app` session without sending
   * any command. Returns null if no goal is set or the session has not yet
   * received a `thread/goal/updated` notification.
   */
  codexGoalGet(name: string): { ok: true; goal: unknown } {
    const managed = this.sessions.get(name);
    if (!managed) throw new Error(`Session not found: ${name}`);
    const session = managed.session as ISession & { goal?: unknown };
    if (!('goal' in session)) {
      const engine = managed.config.engine || 'claude';
      throw new Error(
        `Session "${name}" uses engine "${engine}" which does not track goal state. ` +
          `Start a session with engine: "codex-app" to use the goal tools.`,
      );
    }
    return { ok: true, goal: session.goal ?? null };
  }

  // ─── Codex app-server v2 RPCs (codex-app engine only, Codex 0.137) ────────
  //
  // turn/interrupt, turn/steer, thread/fork, thread/rollback, model/list — the
  // high-value app-server surface beyond /goal. Each requires a `codex-app`
  // session; the discriminator is the presence of the `interrupt` method.

  private _getCodexAppSession(name: string, feature: string): CodexAppSession {
    const managed = this.sessions.get(name);
    if (!managed) throw new Error(`Session not found: ${name}`);
    const session = managed.session as CodexAppSession;
    if (typeof session.interrupt !== 'function') {
      const engine = managed.config.engine || 'claude';
      throw new Error(
        `Session "${name}" uses engine "${engine}" which does not support ${feature}. ` +
          `Start a session with engine: "codex-app".`,
      );
    }
    return session;
  }

  async codexInterrupt(name: string): Promise<{ ok: true; interrupted: boolean }> {
    const r = await this._getCodexAppSession(name, 'turn/interrupt').interrupt();
    return { ok: true, ...r };
  }

  async codexSteer(
    name: string,
    text: string,
  ): Promise<{ ok: true; steered: boolean; turnId?: string; text?: string }> {
    const r = await this._getCodexAppSession(name, 'turn/steer').steer(text);
    return { ok: true, ...r };
  }

  async codexForkThread(name: string): Promise<{ ok: true; threadId: string }> {
    const r = await this._getCodexAppSession(name, 'thread/fork').forkThread();
    return { ok: true, ...r };
  }

  async codexRollback(name: string, numTurns: number): Promise<{ ok: true; numTurns: number }> {
    await this._getCodexAppSession(name, 'thread/rollback').rollback(numTurns);
    return { ok: true, numTurns };
  }

  async codexModels(name: string): Promise<{ ok: true; models: unknown[] }> {
    const models = await this._getCodexAppSession(name, 'model/list').listModels();
    return { ok: true, models };
  }

  async codexThreads(
    name: string,
    opts: { cwd?: string; searchTerm?: string; archived?: boolean; cursor?: string; limit?: number } = {},
  ): Promise<{ ok: true; data: unknown[]; nextCursor: string | null }> {
    const r = await this._getCodexAppSession(name, 'thread/list').listThreads(opts);
    return { ok: true, ...r };
  }

  // ─── Claude /goal helpers (CLI 2.1.139, claude engine only) ────────
  //
  // Claude Code's /goal slash command works in non-interactive stream-json
  // sessions: the CLI parses any user message starting with `/goal` and
  // routes it to the goal subsystem. Unlike Codex's app-server protocol,
  // Claude does not emit a separate goal-state notification — the only
  // surface is the assistant's reply text. These wrappers are thin
  // pre-formatters around `sendMessage()` that enforce the engine guard
  // and pass the slash text through.

  private _assertClaudeSession(name: string): void {
    const managed = this.sessions.get(name);
    if (!managed) throw new Error(`Session not found: ${name}`);
    const engine = managed.config.engine || 'claude';
    if (engine !== 'claude') {
      throw new Error(
        `Session "${name}" uses engine "${engine}" which does not support Claude /goal. ` +
          `Start a session with engine: "claude" (or omit engine) to use claude_goal_* tools.`,
      );
    }
  }

  /** Send `/goal <objective>` to a claude session. Sets a completion condition that
   *  Claude Code pursues across turns, evaluating after each turn via Haiku. */
  async claudeGoalSet(name: string, objective: string, timeoutMs?: number): Promise<unknown> {
    this._assertClaudeSession(name);
    return await this.sendMessage(name, `/goal ${objective}`, { timeout: timeoutMs });
  }

  /** Send `/goal clear` to remove the active goal. */
  async claudeGoalClear(name: string, timeoutMs?: number): Promise<unknown> {
    this._assertClaudeSession(name);
    return await this.sendMessage(name, '/goal clear', { timeout: timeoutMs });
  }

  /** Send bare `/goal` to query the active goal (elapsed time, turns, tokens). */
  async claudeGoalStatus(name: string, timeoutMs?: number): Promise<unknown> {
    this._assertClaudeSession(name);
    return await this.sendMessage(name, '/goal', { timeout: timeoutMs });
  }

  // ─── Plugin Details (CLI 2.1.139) ─────────────────────────────────────

  /**
   * Wraps `claude plugin details <name>` — prints the plugin's component
   * inventory (commands, hooks, MCP servers, agents, skills) plus the
   * per-session token cost of loading it. Returns raw stdout/stderr.
   */
  async pluginDetails(name: string): Promise<{ stdout: string; stderr: string }> {
    if (!name || typeof name !== 'string') throw new Error('plugin name required');
    const { stdout, stderr } = await execFileAsync(this.pluginConfig.claudeBin, ['plugin', 'details', name], {
      maxBuffer: 8 * 1024 * 1024,
    });
    return { stdout, stderr };
  }

  /**
   * Wraps `claude agents --json` — lists Claude Code background agent sessions
   * (state/model/title/progress). One-shot spawn; not tied to a managed session.
   * `all` adds `--all` (include completed); `cwd` scopes to a directory.
   */
  async claudeAgentsList(opts: { all?: boolean; cwd?: string } = {}): Promise<{ ok: true; agents: unknown[] }> {
    const args = ['agents', '--json'];
    if (opts.all) args.push('--all');
    if (opts.cwd) args.push('--cwd', path.resolve(opts.cwd));
    const { stdout } = await execFileAsync(this.pluginConfig.claudeBin, args, {
      maxBuffer: 16 * 1024 * 1024,
      timeout: 30_000,
    });
    let agents: unknown[] = [];
    const trimmed = stdout.trim();
    if (trimmed) {
      try {
        const parsed = JSON.parse(trimmed);
        agents = Array.isArray(parsed) ? parsed : ((parsed as { agents?: unknown[] }).agents ?? []);
      } catch {
        throw new Error(`claude agents --json returned non-JSON output: ${trimmed.slice(0, 200)}`);
      }
    }
    return { ok: true, agents };
  }

  // ─── Codex one-shot wrappers ──────────────────────────────────────────

  private _codexBin(): string {
    return process.env.CODEX_BIN || 'codex';
  }

  /**
   * Parse Codex `--json` JSONL output from a stdout buffer.
   *
   * Codex 0.128 emits one event per line: `thread.started`, `turn.started`,
   * `item.completed` (with `item.type === 'agent_message'` for assistant text
   * or tool-use types for shell/MCP calls), `turn.completed` (with usage).
   *
   * Returns the concatenated assistant text plus the thread_id (if present)
   * and the raw event list for callers that want full visibility.
   */
  private _parseCodexJsonl(stdout: string): {
    assistantText: string;
    threadId?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cached_input_tokens?: number;
      reasoning_output_tokens?: number;
    };
    events: unknown[];
  } {
    let assistantText = '';
    let threadId: string | undefined;
    let usage:
      | {
          input_tokens?: number;
          output_tokens?: number;
          cached_input_tokens?: number;
          reasoning_output_tokens?: number;
        }
      | undefined;
    const events: unknown[] = [];
    for (const line of stdout.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let ev: unknown;
      try {
        ev = JSON.parse(trimmed);
      } catch {
        continue; // Non-JSON lines are tolerated (banners, etc.)
      }
      events.push(ev);
      const e = ev as { type?: string };
      if (e.type === 'thread.started') {
        const t = ev as { thread_id?: string };
        if (t.thread_id) threadId = t.thread_id;
      } else if (e.type === 'item.completed') {
        const it = ev as { item?: { type?: string; text?: string } };
        if (it.item?.type === 'agent_message' && typeof it.item.text === 'string') {
          assistantText += it.item.text;
        }
      } else if (e.type === 'turn.completed') {
        const tc = ev as { usage?: typeof usage };
        if (tc.usage) usage = tc.usage;
      }
    }
    return { assistantText, threadId, usage, events };
  }

  /**
   * Wraps `codex exec resume [SESSION_ID|--last] [PROMPT]` (Codex 0.119+).
   *
   * Resumes a previously recorded Codex thread by UUID/name or picks the most
   * recent via `--last`. Always uses `--json` + `--sandbox workspace-write`
   * so the output can be parsed into structured fields.
   *
   * Note: this is a one-shot operation independent of the session manager's
   * tracked sessions. For in-session continuity (each send within one session
   * resumes the prior thread automatically), `PersistentCodexSession`
   * already handles that via the captured `thread_id` from `thread.started`.
   */
  async codexResume(opts: {
    sessionId?: string;
    last?: boolean;
    message: string;
    cwd?: string;
    model?: string;
    timeout?: number;
  }): Promise<{
    ok: true;
    text: string;
    threadId?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cached_input_tokens?: number;
      reasoning_output_tokens?: number;
    };
    events: unknown[];
  }> {
    if (!opts.sessionId && !opts.last) {
      throw new Error('codexResume requires either sessionId or last=true');
    }
    // `codex exec resume` does not accept --sandbox or -C — sandbox policy
    // and cwd are inherited from the original session. Forward `cwd` via
    // the spawn process's working directory so Codex's --last picker scopes
    // correctly when no SESSION_ID is given.
    const args: string[] = ['exec', 'resume'];
    if (opts.last) args.push('--last');
    else if (opts.sessionId) args.push(opts.sessionId);
    args.push('--skip-git-repo-check', '--json');
    if (opts.model) args.push('--model', opts.model);
    args.push(opts.message);
    const { stdout } = await execFileAsync(this._codexBin(), args, {
      cwd: opts.cwd ? path.resolve(opts.cwd) : undefined,
      maxBuffer: 32 * 1024 * 1024,
      timeout: opts.timeout || 300_000,
    });
    const parsed = this._parseCodexJsonl(stdout);
    return {
      ok: true,
      text: parsed.assistantText,
      threadId: parsed.threadId,
      usage: parsed.usage,
      events: parsed.events,
    };
  }

  /**
   * Wraps `codex review [PROMPT] [--uncommitted | --base BRANCH | --commit SHA]`.
   *
   * Codex 0.128's review subcommand outputs plain text (no `--json` flag),
   * so the wrapper just captures stdout/stderr verbatim.
   */
  async codexReview(opts: {
    prompt?: string;
    cwd?: string;
    uncommitted?: boolean;
    base?: string;
    commit?: string;
    title?: string;
    model?: string;
    timeout?: number;
  }): Promise<{ ok: true; stdout: string; stderr: string }> {
    // Mutex: at most one diff scope flag.
    const scopes = [opts.uncommitted, opts.base, opts.commit].filter((v) => v != null && v !== false);
    if (scopes.length > 1) {
      throw new Error('codexReview: --uncommitted, --base, and --commit are mutually exclusive');
    }
    // Validate git refs: reject leading-dash (argument injection) and shell/path
    // metacharacters. args go through execFile (no shell) but a '--flag'-shaped
    // value could still be misread by codex's parser.
    const GIT_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
    if (opts.base != null && !GIT_REF.test(opts.base)) {
      throw new Error(`codexReview: invalid base ref '${opts.base}'`);
    }
    if (opts.commit != null && !GIT_REF.test(opts.commit)) {
      throw new Error(`codexReview: invalid commit ref '${opts.commit}'`);
    }
    const args: string[] = ['review'];
    if (opts.uncommitted) args.push('--uncommitted');
    if (opts.base) args.push('--base', opts.base);
    if (opts.commit) args.push('--commit', opts.commit);
    if (opts.title) args.push('--title', opts.title);
    if (opts.model) args.push('-c', `model="${opts.model}"`);
    if (opts.prompt) args.push(opts.prompt);
    const { stdout, stderr } = await execFileAsync(this._codexBin(), args, {
      cwd: opts.cwd ? path.resolve(opts.cwd) : undefined,
      maxBuffer: 16 * 1024 * 1024,
      timeout: opts.timeout || 600_000,
    });
    return { ok: true, stdout, stderr };
  }

  // ─── Project Purge (CLI 2.1.126) ──────────────────────────────────────

  /**
   * Wraps `claude project purge` — deletes Claude Code state for a project
   * (transcripts, tasks, file history, config entry).
   *
   * Defaults to dry-run for safety: callers must pass `dryRun: false` to
   * actually delete. When `all` is true, `path` is ignored.
   *
   * The `--yes` flag is always passed (we have no TTY for confirmation prompts);
   * safety is enforced via the dry-run default at the wrapper level instead.
   */
  async purgeProject(opts: {
    path?: string;
    all?: boolean;
    dryRun?: boolean;
  }): Promise<{ stdout: string; stderr: string; dryRun: boolean }> {
    const dryRun = opts.dryRun !== false; // default true
    const args = ['project', 'purge'];
    if (opts.all) args.push('--all');
    if (dryRun) args.push('--dry-run');
    else args.push('--yes');
    if (!opts.all && opts.path) args.push(path.resolve(opts.path));
    const { stdout, stderr } = await execFileAsync(this.pluginConfig.claudeBin, args, {
      maxBuffer: 8 * 1024 * 1024,
    });
    return { stdout, stderr, dryRun };
  }

  // ─── Auto Proxy ───────────────────────────────────────────────────────

  /**
   * Read OpenClaw gateway config from ~/.openclaw/openclaw.json.
   * Returns { url, key } or null if not configured.
   */
  private _readGatewayConfig(): { url: string; key: string } | null {
    try {
      const configPath = path.join(os.homedir(), '.openclaw', 'openclaw.json');
      if (!fs.existsSync(configPath)) return null;
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
      const gw = config.gateway as Record<string, unknown> | undefined;
      if (!gw) return null;

      const port = (gw.port as number) || 18789;
      const auth = gw.auth as Record<string, string> | undefined;
      // Support both password and token auth modes
      const key = auth?.password || auth?.token || '';

      return { url: `http://127.0.0.1:${port}/v1`, key };
    } catch {
      return null;
    }
  }

  /**
   * Start a local proxy server (if not running) that converts Anthropic format
   * to OpenAI format and forwards to the OpenClaw gateway.
   * Returns the proxy port, or null if gateway is not available.
   */
  private async _ensureProxyServer(): Promise<number | null> {
    if (this._proxyPort) return this._proxyPort;

    // Auto-detect gateway config
    const gwConfig = this._readGatewayConfig();
    const gatewayUrl = process.env.GATEWAY_URL || gwConfig?.url;
    const gatewayKey = process.env.GATEWAY_KEY || gwConfig?.key;

    if (!gatewayUrl) {
      this.logger.info('No OpenClaw gateway found — proxy not available');
      return null;
    }

    // Lazy import to avoid circular deps
    const { createProxyHandler } = await import('./proxy/handler.js');
    const proxyHandler = createProxyHandler(undefined, {
      anthropicApiKey: process.env.ANTHROPIC_API_KEY,
      openaiApiKey: process.env.OPENAI_API_KEY,
      geminiApiKey: process.env.GEMINI_API_KEY,
      gatewayUrl,
      gatewayKey,
    });

    return new Promise((resolve) => {
      const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (chunk: Buffer) => {
          body += chunk.toString();
        });
        req.on('end', () => {
          const httpReq = {
            method: req.method || 'GET',
            url: req.url || '/',
            headers: req.headers as Record<string, string>,
            json: async () => JSON.parse(body),
          };
          const httpRes = {
            status: (code: number) => {
              res.statusCode = code;
              return httpRes;
            },
            json: (data: unknown) => {
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify(data));
            },
            setHeader: (k: string, v: string) => res.setHeader(k, v),
            write: (data: string) => res.write(data),
            end: () => res.end(),
            flushHeaders: () => res.flushHeaders(),
          };
          proxyHandler(httpReq, httpRes).catch((err) => {
            res.statusCode = 500;
            res.end(JSON.stringify({ error: (err as Error).message }));
          });
        });
      });

      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as { port: number };
        this._proxyServer = server;
        this._proxyPort = addr.port;
        this.logger.info(`Auto-proxy started on port ${addr.port} (gateway: ${gatewayUrl})`);
        resolve(addr.port);
      });

      server.on('error', (err) => {
        this.logger.error('Failed to start proxy server:', err.message);
        resolve(null);
      });
    });
  }

  // ─── Private ───────────────────────────────────────────────────────────

  private _persistSession(name: string, managed: ManagedSession): void {
    const resumeSessionId = this._managedResumeId(managed);
    if (!resumeSessionId) {
      if (managed.config.engine === 'agy' && this.persistedSessions.delete(name)) {
        this._debouncedSave();
      }
      return;
    }
    managed.claudeSessionId = resumeSessionId;
    const existing = this.persistedSessions.get(name);
    this.persistedSessions.set(name, {
      name,
      claudeSessionId: resumeSessionId,
      cwd: managed.cwd,
      model: managed.config.resolvedModel || managed.config.model,
      engine: managed.config.engine,
      sandboxMode: managed.config.sandboxMode,
      originalCreated: existing?.originalCreated || managed.created,
      lastResumed: new Date().toISOString(),
      lastActivity: managed.lastActivity,
    });
    this._debouncedSave();
  }

  // ─── PID Tracking ──────────────────────────────────────────────────────

  private static PID_FILE = path.join(os.homedir(), '.openclaw', 'session-pids.json');

  private _savePids(): void {
    try {
      const dir = path.dirname(SessionManager.PID_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      // The PID file is host-shared: any SessionManager (gateway, dashboard,
      // standalone test runner) writes here. We MUST NOT overwrite entries
      // owned by another live SessionManager process — that would erase its
      // record of pids it spawned, and its next cleanup pass might decide
      // they're orphans and kill them. Read-merge-write keyed by ownerPid.
      let existing: Record<string, unknown> = {};
      try {
        existing = JSON.parse(fs.readFileSync(SessionManager.PID_FILE, 'utf8')) as Record<string, unknown>;
      } catch {
        /* missing or malformed — start fresh */
      }
      const merged: Record<string, { pid: number; ownerPid: number; since: string }> = {};
      const now = new Date().toISOString();
      // Keep entries from OTHER LIVE owners untouched. Entries whose
      // ownerPid is a dead process are stale bookkeeping — drop them so
      // the file doesn't grow unboundedly across server restarts. The
      // child processes those entries used to track were already reaped
      // by _cleanupOrphanedPids (which runs at SessionManager init,
      // before the first save).
      for (const [name, raw] of Object.entries(existing)) {
        if (typeof raw === 'number') continue; // legacy format — drop on first save
        const entry = raw as { pid?: number; ownerPid?: number; since?: string };
        if (typeof entry.pid !== 'number' || typeof entry.ownerPid !== 'number') continue;
        if (entry.ownerPid === process.pid) continue; // ours; we're about to rewrite
        try {
          process.kill(entry.ownerPid, 0);
        } catch {
          continue; // owner dead — stale entry, drop it
        }
        merged[name] = {
          pid: entry.pid,
          ownerPid: entry.ownerPid,
          since: entry.since ?? now,
        };
      }
      // Add OUR current entries
      for (const [name, pid] of this._activePids) {
        merged[name] = { pid, ownerPid: process.pid, since: now };
      }
      fs.writeFileSync(SessionManager.PID_FILE, JSON.stringify(merged));
    } catch {
      /* best effort */
    }
  }

  /**
   * Verify that a PID belongs to a known coding CLI before killing it.
   * Prevents killing unrelated processes if the OS recycled the PID.
   */
  private _isKnownCliProcess(pid: number): boolean {
    // Match known CLI binaries by basename to avoid false positives
    // (e.g., 'agent' must not match 'ssh-agent' or 'gpg-agent')
    // Anchor each name to executable/path position ((?:^|[/\s])name(?:[\s/]|$))
    // so a hyphenated lookalike ('vim claude-notes.md', 'ssh-agent') can never
    // match, while the real binary ('claude', '/usr/local/bin/claude',
    // 'node /x/claude/cli.js') still does. \b alone treated '-' as a boundary.
    const knownPatterns = [
      /(?:^|[/\s])claude(?:[\s/]|$)/, // claude CLI
      /(?:^|[/\s])codex(?:[\s/]|$)/, // codex CLI
      /(?:^|[/\s])gemini(?:[\s/]|$)/, // gemini CLI
      /(?:^|[/\s])agy(?:[\s/]|$)/, // agy CLI (Google Antigravity)
      /(?:^|[/\s])cursor-agent(?:[\s/]|$)/, // cursor-agent CLI
      /(?:^|[/\s])opencode(?:[\s/]|$)/, // opencode CLI (sst/opencode)
      /(?:^|\/)agent(?:[\s/]|$)/, // 'agent' only as executable/after a slash (not ssh-agent)
    ];
    try {
      const cmd = execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
        encoding: 'utf8',
        timeout: 3_000,
      }).trim();
      return knownPatterns.some((pattern) => pattern.test(cmd));
    } catch {
      return false; // ps failed — process likely dead or not accessible
    }
  }

  private _cleanupOrphanedPids(): void {
    try {
      if (!fs.existsSync(SessionManager.PID_FILE)) return;
      const data = JSON.parse(fs.readFileSync(SessionManager.PID_FILE, 'utf8')) as Record<string, unknown>;
      for (const [name, raw] of Object.entries(data)) {
        // Resolve entry shape: legacy = number; current = { pid, ownerPid, since }.
        let pid: number;
        let ownerPid: number | null;
        if (typeof raw === 'number') {
          pid = raw;
          ownerPid = null; // unknown owner — treat conservatively (skip kill)
        } else if (raw && typeof raw === 'object') {
          const e = raw as { pid?: number; ownerPid?: number };
          if (typeof e.pid !== 'number') continue;
          pid = e.pid;
          ownerPid = typeof e.ownerPid === 'number' ? e.ownerPid : null;
        } else {
          continue;
        }
        // Cross-process safety: if this PID has a known owner SessionManager
        // and that owner is still alive, the child is NOT an orphan — it's
        // owned by another live manager. Only kill if owner is dead or unknown
        // AND the conservative legacy-format path has been ruled out.
        if (ownerPid !== null && ownerPid !== process.pid) {
          let ownerAlive = false;
          try {
            process.kill(ownerPid, 0);
            ownerAlive = true;
          } catch {
            /* owner dead */
          }
          if (ownerAlive) {
            this.logger.info(`PID ${pid} (session: ${name}) owned by live SessionManager pid=${ownerPid} — skipping`);
            continue;
          }
        } else if (ownerPid === null) {
          // Legacy format with no owner info — too risky to kill if a host
          // shares the file across managers. Skip; the entry will be cleaned
          // up on the next save (read-merge-write drops legacy format).
          this.logger.info(`PID ${pid} (session: ${name}) is legacy-format (no ownerPid) — skipping kill`);
          continue;
        }
        try {
          process.kill(pid, 0); // check if alive
          // Alive — but verify it's actually a coding CLI, not a recycled PID
          if (!this._isKnownCliProcess(pid)) {
            this.logger.info(`PID ${pid} (session: ${name}) is alive but not a known CLI — skipping kill`);
            continue;
          }
          this.logger.info(`Killing orphaned process ${pid} (session: ${name})`);
          // Graceful shutdown: SIGTERM first
          try {
            process.kill(-pid, 'SIGTERM');
          } catch {
            /* group kill failed */
          }
          try {
            process.kill(pid, 'SIGTERM');
          } catch {
            /* individual kill failed */
          }
          // Give process time to shut down, then SIGKILL
          const orphanSigkill = setTimeout(() => {
            try {
              process.kill(pid, 0);
              process.kill(-pid, 'SIGKILL');
            } catch {
              /* already dead or group kill failed */
            }
            try {
              process.kill(pid, 0);
              process.kill(pid, 'SIGKILL');
            } catch {
              /* already dead */
            }
          }, STOP_SIGKILL_DELAY_MS);
          orphanSigkill.unref(); // force-kill fallback must not keep the loop alive
        } catch {
          // Process already dead — nothing to do
        }
      }
    } catch {
      /* file doesn't exist or parse error */
    }
    // Clear the PID file
    this._savePids();
  }

  // Circuit breaker is delegated to this._circuitBreaker (src/circuit-breaker.ts)

  private _getSession(name: string): ManagedSession {
    const managed = this.sessions.get(name);
    if (!managed) throw new Error(`Session '${name}' not found`);
    return managed;
  }

  private _toSessionInfo(name: string, managed: ManagedSession): SessionInfo {
    const stats = managed.session.getStats();
    const resumeSessionId = this._managedResumeId(managed);
    if (resumeSessionId) managed.claudeSessionId = resumeSessionId;
    const costUsd = this._spentUsd(managed);
    const info: SessionInfo = {
      name,
      claudeSessionId: resumeSessionId,
      created: managed.created,
      cwd: managed.cwd,
      model: managed.config.resolvedModel || managed.config.model,
      paused: false,
      stats,
      costUsd: Math.round(costUsd * 10000) / 10000,
    };
    if (managed.config.maxBudgetUsd) {
      info.budgetUsd = managed.config.maxBudgetUsd;
      info.budgetExhausted = managed.budgetExhausted || isBudgetExceeded(costUsd, managed.config.maxBudgetUsd);
    }
    return info;
  }

  private _resolveModel(alias: string, overrides?: Record<string, string>): string {
    if (overrides?.[alias]) return overrides[alias];
    return resolveAlias(alias);
  }

  private _managedResumeId(managed: ManagedSession): string | undefined {
    return (
      this._sessionResumeId(managed.config.engine, managed.session) ||
      this._storedResumeId(managed.config.engine, managed.claudeSessionId)
    );
  }

  /**
   * Return only IDs that can actually resume the engine. Agy and Codex expose
   * harvested conversation/thread IDs; their BaseOneShot sessionId values are
   * synthetic wrapper identifiers and must never be persisted for resume.
   */
  private _sessionResumeId(engine: EngineType | undefined, session: ISession): string | undefined {
    if (engine === 'agy') {
      const conversationId = (session as { conversationId?: string }).conversationId;
      return isAgyConversationId(conversationId) ? conversationId : undefined;
    }
    if (engine === 'codex') {
      return (session as { threadId?: string }).threadId;
    }
    return session.sessionId;
  }

  private _storedResumeId(engine: EngineType | undefined, id: string | undefined): string | undefined {
    if (engine === 'agy') return isAgyConversationId(id) ? id : undefined;
    if (engine === 'codex') return id && !/^codex-\d+-/.test(id) ? id : undefined;
    if (engine === 'grok') return id && !/^grok-\d+-/.test(id) ? id : undefined;
    return id;
  }

  private _listMdFiles(dir: string): AgentInfo[] {
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => {
        const content = fs.readFileSync(path.join(dir, f), 'utf8');
        const match = content.match(/^---\n[\s\S]*?description:\s*(.+)/m);
        return { name: f.replace('.md', ''), file: f, description: match?.[1]?.trim() || '' };
      });
  }

  private _createSession(engine: EngineType, config: SessionConfig): ISession {
    switch (engine) {
      case 'gemini':
        return new PersistentGeminiSession(config, process.env.GEMINI_BIN);
      case 'agy':
        return new PersistentAgySession(config, process.env.AGY_BIN);
      case 'codex':
        return new PersistentCodexSession(config, process.env.CODEX_BIN);
      case 'codex-app':
        return new PersistentCodexAppServerSession(config, process.env.CODEX_BIN);
      case 'cursor':
        return new PersistentCursorSession(config, process.env.CURSOR_BIN);
      case 'grok':
        return new PersistentGrokSession(config, process.env.GROK_BIN);
      case 'opencode':
        return new PersistentOpencodeSession(config, process.env.OPENCODE_BIN);
      case 'custom':
        if (!config.customEngine) throw new Error('customEngine config is required for engine type "custom"');
        return new PersistentCustomSession(config);
      case 'claude':
      default:
        return new PersistentClaudeSession(config, this.pluginConfig.claudeBin);
    }
  }

  // ─── Council ──────────────────────────────────────────────────────────
  //
  // The council's lifecycle belongs to the run kernel now. What used to live
  // here — a `Map` of live `Council` objects, a 30-minute TTL timer per entry,
  // and a `councilList` that regex-scraped markdown transcripts to see runs from
  // other processes — is gone. A council is a one-node workflow; its state is
  // the run record, which is durable, cross-process, and does not evaporate.
  //
  // What still needs a live object is in-flight control: `inject` and `abort`
  // have to reach the `Council` instance that is running right now. The kernel
  // publishes it for the duration of the node, and says so honestly — after a
  // restart the run is readable and resumable, but there is no turn to inject
  // into.

  async councilStart(task: string, config: CouncilConfig): Promise<CouncilSession> {
    const runId = `council-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
    const { agents, secrets } = splitAgentSecrets(config.agents);
    const record = await this.kernel.start(
      legacyCouncilWorkflow({
        task,
        cwd: config.projectDir,
        agents,
        maxRounds: config.maxRounds,
        timeoutMs: config.agentTimeoutMs,
        maxTurnsPerAgent: config.maxTurnsPerAgent,
        maxBudgetUsd: config.maxBudgetUsd,
        defaultPermissionMode: config.defaultPermissionMode,
      }),
      { runId, cwd: config.projectDir, secrets: { agentCustomEngines: secrets } },
    );
    return toCouncilSession(record);
  }

  councilStatus(id: string): CouncilSession | undefined {
    const record = loadRun(id);
    if (!record || record.workflow !== 'council') return undefined;
    return toCouncilSession(record);
  }

  /**
   * Every council this machine has run, newest first.
   *
   * Cross-process visibility used to come from scraping `~/.openclaw/council-logs/*.md`
   * with a regex and fabricating a stub session with no responses and an empty
   * config. Runs are stored records now, so the dashboard sees the real thing.
   */
  councilList(): CouncilSession[] {
    return this.kernel
      .list({ workflow: 'council' })
      .map((r) => loadRun(r.runId))
      .filter((r): r is RunRecord => Boolean(r))
      .map(toCouncilSession);
  }

  /** Used by embedded-server to subscribe to a council's event stream. */
  getCouncil(id: string): Council | undefined {
    return this.kernel.handle<Council>(id, LEGACY_NODE);
  }

  /** The live council for a run, or a clear error about why there isn't one. */
  private _liveCouncil(id: string): Council {
    const council = this.kernel.handle<Council>(id, LEGACY_NODE);
    if (council) return council;
    const record = loadRun(id);
    if (!record) throw new Error(`Council '${id}' not found`);
    throw new Error(
      `Council '${id}' is ${record.state} and not running in this process — its record is readable, but there is no live round to act on`,
    );
  }

  councilAbort(id: string): void {
    // Cancel the run first so the kernel stops advancing, then abort the engine
    // so the current round tears down its worktrees.
    if (!this.kernel.cancel(id) && !loadRun(id)) throw new Error(`Council '${id}' not found`);
    this.kernel.handle<Council>(id, LEGACY_NODE)?.abort();
  }

  councilInject(id: string, message: string): void {
    this._liveCouncil(id).injectMessage(message);
  }

  async councilReview(id: string): Promise<CouncilReviewResult> {
    return this._councilForPostProcessing(id).review();
  }

  async councilAccept(id: string): Promise<CouncilAcceptResult> {
    return this._councilForPostProcessing(id).accept();
  }

  async councilReject(id: string, feedback: string): Promise<CouncilRejectResult> {
    return this._councilForPostProcessing(id).reject(feedback);
  }

  /**
   * A `Council` for review / accept / reject.
   *
   * These three act on the git state a finished council left behind — branches,
   * worktrees, plan.md — so they do not need the instance that produced it, only
   * one pointed at the same project directory. Reconstructing from the run
   * record is what makes them work after a restart, which the in-memory map made
   * impossible.
   */
  private _councilForPostProcessing(id: string): Council {
    const live = this.kernel.handle<Council>(id, LEGACY_NODE);
    if (live) return live;
    const record = loadRun(id);
    if (!record || record.workflow !== 'council') throw new Error(`Council '${id}' not found`);
    const session = toCouncilSession(record);
    const council = new Council(session.config, this, this.logger);
    council.adoptSession(session);
    return council;
  }

  // ─── Fan-out (parallel multi-engine task, no consensus) ────────────────
  //
  // Also a one-node workflow. This is the mode the old design failed hardest:
  // a fan-out wrote nothing to disk at all, so 30 minutes after it finished
  // `fanoutStatus` threw "not found" and the results were simply gone.

  /**
   * Start a fan-out: run the task across N engine/model agents in parallel and
   * collect their answers (optional synthesis). Runs in the background; poll
   * with fanoutStatus. Distinct from council — no rounds, votes, or worktrees.
   */
  async fanoutStart(config: FanoutConfig): Promise<FanoutSession> {
    if (!config.agents?.length) throw new Error('fanoutStart: at least one agent is required');
    const names = config.agents.map((a) => a.name);
    if (new Set(names).size !== names.length) {
      throw new Error('fanoutStart: agent names must be unique (they form session names)');
    }
    const runId = `fanout-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
    const { agents, secrets } = splitAgentSecrets(config.agents);
    const record = await this.kernel.start(
      legacyFanoutWorkflow({
        task: config.task,
        cwd: config.projectDir,
        agents,
        synthesize: config.synthesize,
        synthesisEngine: config.synthesisEngine,
        synthesisModel: config.synthesisModel,
        synthesisPermissionMode: config.synthesisPermissionMode,
        maxTurnsPerAgent: config.maxTurnsPerAgent,
        maxBudgetUsd: config.maxBudgetUsd,
        timeoutMs: config.agentTimeoutMs,
      }),
      { runId, cwd: config.projectDir, secrets: { agentCustomEngines: secrets } },
    );
    return toFanoutSession(record);
  }

  fanoutStatus(id: string): FanoutSession {
    const record = loadRun(id);
    if (!record) throw new Error(`Fanout '${id}' not found`);
    return toFanoutSession(record);
  }

  fanoutAbort(id: string): void {
    if (!loadRun(id)) throw new Error(`Fanout '${id}' not found`);
    this.kernel.cancel(id);
    this.kernel.handle<Fanout>(id, LEGACY_NODE)?.abort();
  }

  // ─── Inbox (cross-session messaging) — delegated to InboxManager ────

  private get _sessionLookup(): SessionLookup {
    return {
      getSession: (name) => this.sessions.get(name),
      exists: (name) => this.sessions.has(name),
      allNames: () => this.sessions.keys(),
    };
  }

  async sessionSendTo(
    from: string,
    to: string,
    message: string,
    summary?: string,
  ): Promise<{ delivered: boolean; queued: boolean }> {
    return this._inbox.sendTo(from, to, message, this._sessionLookup, summary, (name, err) => {
      this.logger.error(`Broadcast delivery to '${name}' failed:`, err.message);
    });
  }

  sessionInbox(name: string, unreadOnly = true): InboxMessage[] {
    return this._inbox.inbox(name, unreadOnly);
  }

  async sessionDeliverInbox(name: string): Promise<number> {
    return this._inbox.deliverInbox(name, this._sessionLookup);
  }

  // ─── Ultraplan ────────────────────────────────────────────────────────
  //
  // A one-node workflow. What is gone: a `Map` of results, and an inline
  // 30-minute timer that doubled as the timeout — a plan still running when the
  // TTL fired was rewritten as `error: 'Timed out (TTL expired)'` and then
  // deleted, so a long plan could be destroyed by its own eviction timer. The
  // node's `timeoutMs` is the timeout now, and the record does not expire.

  private _kernel: RunKernel | null = null;
  /**
   * Deferreds resolved by the `autoloop` node once its engine is up, so
   * `autoloopStart` can return the Planner session name the caller expects
   * without polling.
   */
  /**
   * Deferreds resolved by the `autoloop` node once its engine is up.
   *
   * Keyed by the start's tag rather than its run id. A run id gets reused — a
   * start that failed frees it for a retry — so keying on the id let a dying
   * start settle, or clear, the retry's deferred instead of its own, and the
   * retry then waited forever for a signal with nowhere to land.
   */
  private _autoloopReady = new Map<
    string,
    { resolve: (v: { plannerSession: string; state: AutoloopState }) => void; reject: (e: Error) => void }
  >();
  /**
   * Run ids with a start in flight — the window between "run created" and
   * "engine up". Deleting inside it would drop the run while its Planner
   * session is still being created, orphaning a session that finishes a moment
   * later with nothing pointing at it.
   */
  private _autoloopStarting = new Map<string, string>();
  /** Latest role selection per run, published into the node payload. */
  private _autoloopSelection = new Map<string, unknown>();
  /** Per-run checkpoint refreshers, registered by the autoloop node executor. */
  private _autoloopPublishers = new Map<string, () => void>();

  async ultraplanStart(
    task: string,
    opts?: { model?: string; cwd?: string; timeout?: number },
  ): Promise<UltraplanResult> {
    const runId = `ultraplan-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
    const cwd = opts?.cwd || process.cwd();
    const record = await this.kernel.start(
      legacyUltraplanWorkflow({
        task,
        cwd,
        model: opts?.model || 'opus',
        timeoutMs: opts?.timeout || ULTRAPLAN_TIMEOUT_MS,
      }),
      { runId, cwd },
    );
    return toUltraplanResult(record, undefined);
  }

  ultraplanStatus(id: string): UltraplanResult | undefined {
    const record = loadRun(id);
    if (!record || record.workflow !== 'ultraplan') return undefined;
    // Read the plan from the node artifact, not the record's preview: a plan is
    // routinely longer than the inline cap, and returning a truncated one would
    // quietly hand back a broken deliverable.
    return toUltraplanResult(record, readNodeOutput(id, LEGACY_NODE));
  }

  // ─── Ultrareview ──────────────────────────────────────────────────────

  // No map and no poller. Ultrareview used to hold its results in a `Map`, then
  // `setInterval` every 5 seconds asking the fan-out whether it had finished —
  // which meant its correctness depended on the fan-out's 30-minute eviction
  // timer: evict first and the poll threw, the interval was cleared, and the
  // review stayed `running` forever. It is one run now, and there is nothing to
  // poll.
  async ultrareviewStart(
    cwd: string,
    opts?: {
      agentCount?: number;
      maxDurationMinutes?: number;
      model?: string;
      focus?: string;
      engines?: EngineType[];
    },
  ): Promise<UltrareviewResult> {
    const id = `ultrareview-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const agentCount = Math.min(20, Math.max(1, opts?.agentCount || 5));

    const result: UltrareviewResult = {
      id,
      status: 'running',
      councilId: '',
      agentCount,
      startTime: new Date().toISOString(),
    };

    // Build reviewer agents
    const reviewAngles = [
      {
        name: 'SecurityReviewer',
        emoji: '🔒',
        persona:
          'You are a security expert. Focus on: injection vulnerabilities, auth flaws, data exposure, OWASP top 10, secrets in code.',
      },
      {
        name: 'LogicReviewer',
        emoji: '🧠',
        persona:
          'You are a logic analyst. Focus on: off-by-one errors, race conditions, null/undefined handling, edge cases, incorrect assumptions.',
      },
      {
        name: 'PerformanceReviewer',
        emoji: '⚡',
        persona:
          'You are a performance engineer. Focus on: O(n^2) loops, memory leaks, unnecessary allocations, missing caching, N+1 queries.',
      },
      {
        name: 'APIReviewer',
        emoji: '🔌',
        persona:
          'You are an API design reviewer. Focus on: inconsistent interfaces, missing validation, error handling gaps, backwards compatibility.',
      },
      {
        name: 'TestReviewer',
        emoji: '🧪',
        persona:
          'You are a test coverage analyst. Focus on: untested code paths, missing edge case tests, flaky test patterns, assertion quality.',
      },
      {
        name: 'TypeReviewer',
        emoji: '📐',
        persona:
          'You are a type safety reviewer. Focus on: any casts, unsafe assertions, missing null checks, generic misuse, type narrowing gaps.',
      },
      {
        name: 'ConcurrencyReviewer',
        emoji: '🔀',
        persona:
          'You are a concurrency expert. Focus on: race conditions, deadlocks, shared state mutations, async error handling, promise leaks.',
      },
      {
        name: 'ErrorReviewer',
        emoji: '💥',
        persona:
          'You are an error handling reviewer. Focus on: swallowed errors, missing try/catch, unhelpful error messages, crash-on-startup paths.',
      },
      {
        name: 'DependencyReviewer',
        emoji: '📦',
        persona:
          'You are a dependency auditor. Focus on: outdated packages, known CVEs, unnecessary dependencies, license issues.',
      },
      {
        name: 'ReadabilityReviewer',
        emoji: '📖',
        persona:
          'You are a readability reviewer. Focus on: unclear naming, complex functions, missing context, dead code, confusing control flow.',
      },
      {
        name: 'DataReviewer',
        emoji: '💾',
        persona:
          'You are a data integrity reviewer. Focus on: data validation, schema mismatches, migration issues, encoding problems, data loss paths.',
      },
      {
        name: 'ConfigReviewer',
        emoji: '⚙️',
        persona:
          'You are a configuration reviewer. Focus on: hardcoded values, missing env vars, insecure defaults, missing fallbacks.',
      },
      {
        name: 'ScalabilityReviewer',
        emoji: '📈',
        persona:
          'You are a scalability reviewer. Focus on: single points of failure, stateful bottlenecks, missing pagination, unbounded growth.',
      },
      {
        name: 'DocReviewer',
        emoji: '📝',
        persona:
          'You are a documentation reviewer. Focus on: outdated docs, missing API docs, misleading comments, undocumented behavior.',
      },
      {
        name: 'A11yReviewer',
        emoji: '♿',
        persona:
          'You are an accessibility reviewer. Focus on: missing ARIA labels, keyboard navigation, color contrast, screen reader support.',
      },
      {
        name: 'I18nReviewer',
        emoji: '🌍',
        persona:
          'You are an i18n reviewer. Focus on: hardcoded strings, locale handling, date/number formatting, RTL support.',
      },
      {
        name: 'NetworkReviewer',
        emoji: '🌐',
        persona:
          'You are a network reviewer. Focus on: missing timeouts, retry logic, connection pooling, request size limits.',
      },
      {
        name: 'AuthReviewer',
        emoji: '🔑',
        persona:
          'You are an auth reviewer. Focus on: token handling, session management, CSRF protection, permission checks.',
      },
      {
        name: 'CryptoReviewer',
        emoji: '🔐',
        persona:
          'You are a cryptography reviewer. Focus on: weak algorithms, key management, random number generation, hash collisions.',
      },
      {
        name: 'MemoryReviewer',
        emoji: '🧹',
        persona:
          'You are a memory reviewer. Focus on: memory leaks, circular references, large object retention, stream handling.',
      },
    ];

    const maxMinutes = Math.min(25, Math.max(5, opts?.maxDurationMinutes || 10));
    const focus = opts?.focus || 'Find bugs, security issues, and code quality problems';
    const reviewInstruction =
      `# Code Review Task\n\nReview the codebase in this project. ${focus}.\n\n` +
      `Examine the code from your specialty angle and report bugs found with file paths and line numbers.`;

    // Cross-engine review: round-robin the requested engines across reviewers
    // (default claude-only — unchanged behavior). Each reviewer's persona is
    // its prompt; per-agent failures are isolated by the fan-out runner.
    const engines = opts?.engines?.length ? opts.engines : (['claude'] as EngineType[]);
    const agents: FanoutAgentSpec[] = reviewAngles.slice(0, agentCount).map((a, i) => ({
      name: a.name,
      engine: engines[i % engines.length],
      model: opts?.model,
      prompt: `${a.persona}\n\n${reviewInstruction}`,
      // Review is read-only: keep reviewers out of edit mode so they analyse and
      // report without modifying the very code they review. (Unlike council,
      // fan-out shares the project dir — there is no worktree to sandbox edits.
      // `plan` constrains the claude engine; non-claude reviewers, which are
      // opt-in via `engines`, run under their engine's default sandbox.)
      permissionMode: 'plan',
    }));

    const runId = id;
    await this.kernel.start(
      legacyFanoutWorkflow({
        name: 'ultrareview',
        task: reviewInstruction,
        cwd,
        // Each reviewer's own prompt and `permissionMode: 'plan'` travel with it.
        // They were being dropped, so every reviewer got the shared task under
        // `bypassPermissions` — a read-only review that could edit the code.
        agents,
        synthesize: true,
        // The synthesiser reads the reviewers' text, not the code, and it shares
        // the project directory — so it is held to the same read-only rule. It
        // was not, which meant an ultrareview could still write through its
        // final pass.
        synthesisPermissionMode: 'plan',
        maxTurnsPerAgent: 20,
        timeoutMs: maxMinutes * 60 * 1000,
      }),
      { runId, cwd },
    );
    // `councilId` is kept for the UltrareviewResult contract; it holds the run
    // id, which is also the fan-out id — they are the same run now.
    result.councilId = runId;
    return result;
  }

  ultrareviewStatus(id: string): UltrareviewResult | undefined {
    const record = loadRun(id);
    if (!record || record.workflow !== 'ultrareview') return undefined;
    const data = record.nodes[LEGACY_NODE]?.data as FanoutNodeData | undefined;
    return toUltrareviewResult(record, joinFindings(data));
  }

  // ─── Autoloop (three-agent architecture) ───────────────────────────

  // No map, no registry file, and no start/delete fences.
  //
  // What used to live here: `autoloops`, holding the live runner and dispatcher;
  // `_deletingAutoloops` and `_startingAutoloops`, two `Set`s that existed only
  // because a start and a delete could race each other over that map; and four
  // bespoke helpers over `~/.claw-orchestrator/autoloop-registry.jsonl` for
  // cross-process listing. A run has exactly one owner now, run ids collide in
  // the run store rather than in a map that only saw this process, and the
  // record is the registry.

  /**
   * Build and start the Planner/Coder/Reviewer engine for a run.
   *
   * This is everything `autoloopStart` used to be except the bookkeeping: the
   * `autoloops` map and the private JSONL registry are gone, and the kernel owns
   * the lifecycle. Called from the `autoloop` node executor, which holds the
   * returned objects for as long as the loop runs.
   */
  /**
   * Resolve until the loop stops.
   *
   * The runner is an event emitter, not a promise: it settles when a
   * `terminate` envelope is drained or the phase-error circuit trips. Cancelling
   * the run stops it too, which is what makes `workflow_cancel` work on an
   * autoloop.
   */
  private _awaitAutoloopExit(handle: AutoloopHandle, signal: { aborted: boolean }): Promise<void> {
    return new Promise<void>((resolve) => {
      const runner = handle.runner as unknown as {
        state: AutoloopState;
        on(event: string, fn: () => void): void;
        off(event: string, fn: () => void): void;
        stop(): void;
      };
      const done = (): boolean => runner.state.status === 'terminated' || runner.state.status === 'crashed';
      if (done()) return resolve();
      const check = (): void => {
        if (done() || signal.aborted) {
          runner.off('state', check);
          clearInterval(poll);
          if (signal.aborted) {
            // Cancelling a run has to tear the loop down the way a stop does.
            // Without this the three persistent agents keep running and their
            // session names stay claimed, so the run cannot be restarted — the
            // failure looks like "session name already in use" a long way from
            // its cause.
            runner.stop();
            void handle.dispatcher.shutdown('cancelled').catch(() => undefined);
          }
          resolve();
        }
      };
      runner.on('state', check);
      // The runner emits on state changes, but a cancel arrives out of band and
      // a crashed loop may emit nothing at all, so poll as the backstop.
      const poll = setInterval(check, 1000);
      if (typeof poll.unref === 'function') poll.unref();
    });
  }

  private async _bootAutoloop(opts: {
    runId: string;
    workspace: string;
    plannerPromptPath?: string;
    plannerEngine?: EngineType;
    plannerModel?: string;
    plannerCustomEngine?: CustomEngineConfig;
    coderEngine?: EngineType;
    coderModel?: string;
    coderCustomEngine?: CustomEngineConfig;
    reviewerEngine?: EngineType;
    reviewerModel?: string;
    reviewerCustomEngine?: CustomEngineConfig;
    sendTimeoutMs?: number;
  }): Promise<{
    runner: AutoloopRunner;
    dispatcher: ClaudeAgentDispatcher;
    ledgerDir: string;
    pushPolicy: PushPolicy;
  }> {
    const plannerEngine = validateAutoloopRole('planner', opts.plannerEngine, opts.plannerCustomEngine);
    const coderEngine = validateAutoloopRole('coder', opts.coderEngine, opts.coderCustomEngine);
    const reviewerEngine = validateAutoloopRole('reviewer', opts.reviewerEngine, opts.reviewerCustomEngine);
    for (const role of ['planner', 'coder', 'reviewer'] as const) {
      const sessionName = `autoloop-${opts.runId}-${role}`;
      if (this.sessions.has(sessionName) || this._pendingSessions.has(sessionName)) {
        throw new Error(`Autoloop session name '${sessionName}' is already in use`);
      }
    }
    const ledgerDir = path.join(opts.workspace, 'tasks', opts.runId);
    if (!fs.existsSync(ledgerDir)) {
      fs.mkdirSync(ledgerDir, { recursive: true });
    }
    // Per-run policy object — mutable so Planner's update_push_policy is visible
    // to the runner without re-wiring.
    const pushPolicy: PushPolicy = JSON.parse(JSON.stringify(DEFAULT_PUSH_POLICY)) as PushPolicy;
    const runId = opts.runId;
    let runnerRef: AutoloopRunner | null = null;
    let dispatcherRef: ClaudeAgentDispatcher | null = null;
    const dispatcherConfig: ClaudeAgentDispatcherConfig = {
      manager: this,
      runId: opts.runId,
      workspace: opts.workspace,
      plannerPromptPath: opts.plannerPromptPath,
      plannerEngine,
      plannerModel: opts.plannerModel,
      plannerCustomEngine: opts.plannerCustomEngine,
      coderEngine,
      coderModel: opts.coderModel,
      coderCustomEngine: opts.coderCustomEngine,
      reviewerEngine,
      reviewerModel: opts.reviewerModel,
      reviewerCustomEngine: opts.reviewerCustomEngine,
      sendTimeoutMs: opts.sendTimeoutMs,
      logger: this.logger,
      pushPolicyRef: pushPolicy,
      onSpawnSubagents: async (args) => {
        this.logger.info?.(`[autoloop/${runId}] spawn_subagents starting Coder + Reviewer sessions`);
        await dispatcherRef?.spawnSubagents(args);
        runnerRef?.markSubagentsSpawned();
      },
      onRoleSelectionChanged: async (selection) => {
        // Used to write a row into a private append-only registry file. The run
        // record is the registry now, so this just refreshes the published
        // payload the `autoloop_status` projection reads.
        this._autoloopSelection.set(runId, selection);
        this._autoloopPublishers.get(runId)?.();
      },
    };
    const dispatcher = new ClaudeAgentDispatcher(dispatcherConfig);
    dispatcherRef = dispatcher;
    const runner = new AutoloopRunner({
      run_id: opts.runId,
      workspace: opts.workspace,
      ledger_dir: ledgerDir,
      push_policy: pushPolicy,
      notifyUser: async (level: PushLevel, summary: string, detail, channel: PushChannel) => {
        const result = await notifyUserFallbackChain({
          level,
          summary,
          detail,
          channel,
          logger: this.logger,
        });
        appendPushLog(ledgerDir, {
          ts: new Date().toISOString(),
          level,
          summary,
          detail,
          channel_requested: channel,
          channel_used: result.channel_used,
        });
        this.logger.info?.(
          `[autoloop/${runId}] push level=${level} channel=${channel}→${result.channel_used} summary="${summary.slice(0, 80)}"`,
        );
      },
      dispatcher,
    });
    runnerRef = runner;
    try {
      await runner.start();
    } catch (err) {
      try {
        await dispatcher.shutdown('start-failed', { purge: true });
      } catch (cleanupErr) {
        this.logger.warn?.(`[autoloop/${runId}] cleanup after failed start failed: ${(cleanupErr as Error).message}`);
      }
      runner.stop();
      throw err;
    }
    return { runner, dispatcher, ledgerDir, pushPolicy };
  }

  /**
   * Start a v2 autoloop in chat mode. Creates the Planner persistent session,
   * returns the run handle. Coder/Reviewer are NOT started until S3's
   * spawn_subagents tool is called.
   *
   * The run is a kernel run whose single `autoloop` node holds the loop for as
   * long as it lives. That is what replaced the `autoloops` map, the
   * `autoloop-registry.jsonl` file with its four bespoke read/write helpers, and
   * the two `Set`s that fenced start against delete: a run has one owner now,
   * and `runId` collisions are refused by the run store rather than by a map
   * lookup that only saw this process.
   */
  async autoloopStart(opts: {
    runId: string;
    workspace: string;
    plannerPromptPath?: string;
    plannerEngine?: EngineType;
    plannerModel?: string;
    plannerCustomEngine?: CustomEngineConfig;
    coderEngine?: EngineType;
    coderModel?: string;
    coderCustomEngine?: CustomEngineConfig;
    reviewerEngine?: EngineType;
    reviewerModel?: string;
    reviewerCustomEngine?: CustomEngineConfig;
    sendTimeoutMs?: number;
  }): Promise<{ runId: string; plannerSession: string; state: AutoloopState }> {
    // Fail before the run directory exists, so a rejected start leaves nothing.
    validateAutoloopRole('planner', opts.plannerEngine, opts.plannerCustomEngine);
    validateAutoloopRole('coder', opts.coderEngine, opts.coderCustomEngine);
    validateAutoloopRole('reviewer', opts.reviewerEngine, opts.reviewerCustomEngine);
    for (const role of ['planner', 'coder', 'reviewer'] as const) {
      const sessionName = `autoloop-${opts.runId}-${role}`;
      if (this.sessions.has(sessionName) || this._pendingSessions.has(sessionName)) {
        throw new Error(`Autoloop session name '${sessionName}' is already in use`);
      }
    }

    const tag = `${opts.runId}:${randomUUID()}`;
    const ready = new Promise<{ plannerSession: string; state: AutoloopState }>((resolve, reject) => {
      this._autoloopReady.set(tag, { resolve, reject });
    });
    this._autoloopStarting.set(tag, opts.runId);
    // Custom-engine configs hold credentials and the spec is written to disk, so
    // they travel in memory. Without this split, `spec.json` contained the token
    // from `CustomEngineConfig.env` in plain text.
    const { plannerCustomEngine, coderCustomEngine, reviewerCustomEngine, ...persistable } = opts;
    await this.kernel.start(
      {
        name: 'autoloop',
        cwd: opts.workspace,
        nodes: [
          {
            id: LEGACY_NODE,
            kind: 'autoloop',
            workspace: opts.workspace,
            config: persistable as Record<string, unknown>,
          },
        ],
      },
      {
        runId: opts.runId,
        cwd: opts.workspace,
        tag,
        secrets: { plannerCustomEngine, coderCustomEngine, reviewerCustomEngine },
      },
    );
    try {
      const { plannerSession, state } = await ready;
      return { runId: opts.runId, plannerSession, state };
    } catch (err) {
      // A start that never came up must not leave the id claimed. The store
      // refuses to reuse a run id, so without this a failed Planner startup
      // would make that id permanently unusable.
      //
      // Tag-guarded: by the time this runs, a retry may already hold the id, and
      // deleting it would take out the run that replaced us.
      this.kernel.delete(opts.runId, { expectTag: tag });
      throw err;
    } finally {
      this._autoloopReady.delete(tag);
      this._autoloopStarting.delete(tag);
    }
  }

  /**
   * Inject a user chat message into a v2 run's Planner. Returns the Planner's
   * natural-language reply.
   */
  async autoloopChat(runId: string, text: string): Promise<{ reply: string }> {
    const ctx = this._liveAutoloop(runId);
    let reply = '';
    const onReply = (...args: unknown[]) => {
      const t = args[0];
      if (typeof t === 'string') reply = t;
    };
    ctx.dispatcher.on('planner_reply', onReply);
    try {
      await ctx.runner.send(AutoloopMsg.chat(ctx.runner.state.iter, { text }));
    } finally {
      ctx.dispatcher.off('planner_reply', onReply);
    }
    return { reply };
  }

  /**
   * The running loop for a run, or a clear reason why there is not one.
   *
   * Chatting with a Planner needs the live dispatcher; a run that finished or
   * belongs to another process has a readable record and no one to talk to.
   */
  private _liveAutoloop(runId: string): AutoloopHandle & {
    runner: AutoloopRunner;
    dispatcher: ClaudeAgentDispatcher;
  } {
    const handle = this.kernel.handle<AutoloopHandle & { runner: AutoloopRunner; dispatcher: ClaudeAgentDispatcher }>(
      runId,
      LEGACY_NODE,
    );
    if (handle) return handle;
    const record = loadRun(runId);
    if (!record || record.workflow !== 'autoloop') throw new Error(`Autoloop run '${runId}' not found`);
    throw new Error(
      `Autoloop run '${runId}' is ${record.state} and not running in this process — resume it before chatting`,
    );
  }

  autoloopStatus(runId: string): AutoloopState | undefined {
    const live = this.kernel.handle<AutoloopHandle>(runId, LEGACY_NODE)?.runner.state;
    if (live) return live;
    // Not running here. The record still holds the last state the loop
    // published, so a historical run opens with its real iteration count and
    // workspace instead of the all-zero stub the registry fallback produced.
    const record = loadRun(runId);
    if (!record || record.workflow !== 'autoloop') return undefined;
    return autoloopStateFromRecord(record);
  }

  autoloopList(): AutoloopState[] {
    return this.kernel
      .list({ workflow: 'autoloop' })
      .map((r) => this.autoloopStatus(r.runId))
      .filter((s): s is AutoloopState => Boolean(s));
  }

  async autoloopResetAgent(
    runId: string,
    agent: 'planner' | 'coder' | 'reviewer',
    opts: { force?: boolean; eagerRestart?: boolean } = {},
  ): Promise<boolean> {
    const ctx = this.kernel.handle<AutoloopHandle & { dispatcher: ClaudeAgentDispatcher }>(runId, LEGACY_NODE);
    if (!ctx) return false;
    await ctx.dispatcher.resetAgent(agent, opts);
    return true;
  }

  async autoloopStop(runId: string, reason = 'user-stop'): Promise<boolean> {
    const ctx = this.kernel.handle<AutoloopHandle & { runner: AutoloopRunner }>(runId, LEGACY_NODE);
    if (!ctx) return false;
    // Soft stop: a terminate envelope, so the three persistent agents shut down
    // and the persisted sessions survive for a later resume. The node's exit
    // watcher sees the status change and lets the run finish on its own.
    await ctx.runner.send(AutoloopMsg.terminate(ctx.runner.state.iter, { reason }));
    return true;
  }

  /**
   * Re-attach a terminated run that lives in the registry but not in this
   * process's in-memory map. Re-creates dispatcher + runner with the same
   * run_id / workspace; ensurePlanner will pick up the Planner's claudeSessionId
   * from persistedSessions (kept on disk because dispatcher.shutdown was
   * called with keepPersisted) and Claude will resume the prior conversation.
   *
   * Returns the new in-memory state. Throws if the registry has no record
   * of this run.
   *
   * Note: if persistedSessions for the planner is empty (older run that
   * pre-dates this feature, OR the run was explicitly deleted), Claude will
   * start a fresh session with the same system prompt — chat memory from
   * Claude's own context is lost, but the chat.jsonl history we now persist
   * is still served via /autoloop/<id>/chat_history so the dashboard can
   * replay the conversation visually.
   */
  /**
   * Which roles of a stored autoloop run need a custom-engine config before it
   * can be resumed.
   *
   * Custom-engine configs are never persisted, so a resume has to be given them
   * again — and a caller that cannot find out which roles need one can only
   * guess. The dashboard's Resume button used to send an empty body
   * unconditionally, which meant a custom-engine run could be resumed from the
   * library and from the HTTP API but not from the UI that offers the button.
   *
   * Returns role names only. Nothing here is sensitive: the engine kind is
   * already in `spec.json`, and the answer is a list of roles, not credentials.
   */
  autoloopResumeRequirements(runId: string): { runId: string; rolesNeedingCustomEngine: AutoloopRoleName[] } {
    const record = loadRun(runId);
    if (!record || record.workflow !== 'autoloop') throw new Error(`Autoloop run '${runId}' not found`);
    const config = (record.spec.nodes.find((n) => n.id === LEGACY_NODE) as { config?: Record<string, unknown> })
      ?.config;
    const roles: AutoloopRoleName[] = [];
    for (const role of ['planner', 'coder', 'reviewer'] as AutoloopRoleName[]) {
      if (config?.[`${role}Engine`] === 'custom') roles.push(role);
    }
    return { runId, rolesNeedingCustomEngine: roles };
  }

  async autoloopResume(
    runId: string,
    opts: {
      plannerCustomEngine?: CustomEngineConfig;
      coderCustomEngine?: CustomEngineConfig;
      reviewerCustomEngine?: CustomEngineConfig;
    } = {},
  ): Promise<AutoloopState> {
    const live = this.kernel.handle<AutoloopHandle>(runId, LEGACY_NODE);
    if (live) return live.runner.state;

    const record = loadRun(runId);
    if (!record || record.workflow !== 'autoloop') throw new Error(`Autoloop run '${runId}' not found`);
    const config = (record.spec.nodes.find((n) => n.id === LEGACY_NODE) as { config?: Record<string, unknown> })
      ?.config;
    if (!config) throw new Error(`Autoloop run '${runId}' has no stored configuration to restart from`);

    // Validate the full restart configuration before touching anything. The
    // spec is the immutable record of how the run was started, so a resume
    // reproduces it exactly instead of reconstructing it from a registry row
    // whose older versions omitted the engine fields entirely.
    validateAutoloopRole('planner', config.plannerEngine as EngineType | undefined, opts.plannerCustomEngine);
    validateAutoloopRole('coder', config.coderEngine as EngineType | undefined, opts.coderCustomEngine);
    validateAutoloopRole('reviewer', config.reviewerEngine as EngineType | undefined, opts.reviewerCustomEngine);

    // Custom-engine configs are never persisted (they can carry secrets), so a
    // resume must be given them again by the caller.
    const resumed = await this._resumeAutoloopRun(runId, {
      ...config,
      plannerCustomEngine: opts.plannerCustomEngine,
      coderCustomEngine: opts.coderCustomEngine,
      reviewerCustomEngine: opts.reviewerCustomEngine,
    } as Parameters<SessionManager['_bootAutoloop']>[0]);
    return resumed;
  }

  /** Re-attach a stored autoloop run: same run id, same spec, fresh engine. */
  private async _resumeAutoloopRun(
    runId: string,
    config: Parameters<SessionManager['_bootAutoloop']>[0],
  ): Promise<AutoloopState> {
    const tag = `${runId}:${randomUUID()}`;
    const ready = new Promise<{ plannerSession: string; state: AutoloopState }>((resolve, reject) => {
      this._autoloopReady.set(tag, { resolve, reject });
    });
    this._autoloopStarting.set(tag, runId);
    // The custom-engine configs the caller re-supplied go into the run's secret
    // bag, which is where the node reads them from. They used to be stashed in a
    // separate map the executor no longer consulted, so a resume in a fresh
    // process — the case that matters — silently got none of them.
    const secrets = {
      plannerCustomEngine: config.plannerCustomEngine,
      coderCustomEngine: config.coderCustomEngine,
      reviewerCustomEngine: config.reviewerCustomEngine,
    };
    try {
      // `restart: true` because an autoloop resume means "bring the loop back
      // up", not "carry on from where the kernel left off" — the run is
      // normally terminated when someone resumes it.
      const record = await this.kernel.resume(runId, { restart: true, secrets, tag });
      // Race readiness against the run ending: a node that fails before it
      // publishes would otherwise leave this awaiting a signal that is never
      // coming.
      const finished = this.kernel
        .wait(record.runId)
        .then((r) => Promise.reject(new Error(r?.error ?? `autoloop run '${runId}' ended before it came up`)));
      const { state } = await Promise.race([ready, finished]);
      return state;
    } finally {
      this._autoloopReady.delete(tag);
      this._autoloopStarting.delete(tag);
    }
  }

  /**
   * Delete a run: really gone, not paused.
   *
   * The two `Set` fences this used to open with — one refusing a delete while a
   * start was in flight, one blocking a concurrent start during the async
   * teardown — protected a shared `Map` that no longer exists. Cancelling the
   * run is what stops it, and the run store refuses to recreate a live id.
   */
  async autoloopDelete(runId: string): Promise<boolean> {
    // Refuse to tear down a run that is still coming up: its Planner session is
    // mid-startSession, so deleting now would drop the run and orphan a session
    // that finishes starting a moment later. `_autoloopReady` holds an entry for
    // exactly the window between "run created" and "engine up", which is the
    // window that used to need a dedicated `_startingAutoloops` Set.
    if ([...this._autoloopStarting.values()].includes(runId)) {
      throw new Error(`Autoloop with id '${runId}' is still starting`);
    }
    const ctx = this.kernel.handle<AutoloopHandle & { runner: AutoloopRunner; dispatcher: ClaudeAgentDispatcher }>(
      runId,
      LEGACY_NODE,
    );
    let touched = false;
    if (ctx) {
      // Delete = "really gone". Call dispatcher.shutdown directly with
      // purge:true so persistedSessions entries are removed too —
      // otherwise the Claude Planner conversation lingers on disk and the
      // run could be /resume'd back to life. Bypassing runner.send is
      // intentional: the runner's terminate path is meant to be the
      // soft-pause we use for autoloopStop / autoloopResume, which keeps
      // persisted state intact.
      try {
        await ctx.dispatcher.shutdown('user-delete', { purge: true });
      } catch (err) {
        this.logger.warn?.(`[autoloop/${runId}] dispatcher shutdown during delete failed: ${(err as Error).message}`);
      }
      try {
        ctx.runner.stop();
      } catch {
        /* runner may already be stopped */
      }
      this.kernel.cancel(runId);
      touched = true;
    } else {
      // Disk-only run: ensure any leftover persistedSessions entry for the
      // Planner is cleaned up so it isn't resumed by accident later.
      try {
        await this.stopSession(`autoloop-${runId}-planner`);
      } catch {
        /* session not in memory — fine */
      }
      this.persistedSessions.delete(`autoloop-${runId}-planner`);
      this.persistedSessions.delete(`autoloop-${runId}-coder`);
      this.persistedSessions.delete(`autoloop-${runId}-reviewer`);
      savePersistedSessions(this.persistedSessions, this.logger);
    }
    // No registry to scrub: the run record IS the registry, and removing it is
    // the delete. The ledger directory under tasks/<runId>/ is deliberately left
    // alone — postmortem artifacts (chat history, push log, plan.md) outlive the
    // run, exactly as before.
    if (loadRun(runId)) {
      this.kernel.delete(runId);
      touched = true;
    }
    return touched;
  }

  /** Used by embedded-server to attach SSE listeners. Live runs only. */
  getAutoloop(runId: string): { runner: AutoloopRunner; dispatcher: ClaudeAgentDispatcher } | undefined {
    const handle = this.kernel.handle<{ runner: AutoloopRunner; dispatcher: ClaudeAgentDispatcher }>(
      runId,
      LEGACY_NODE,
    );
    return handle ? { runner: handle.runner, dispatcher: handle.dispatcher } : undefined;
  }

  private _cleanupIdleSessions(): void {
    const ttlMs = this.pluginConfig.sessionTtlMinutes * 60_000;
    const now = Date.now();
    for (const [name, managed] of this.sessions) {
      if (now - managed.lastActivity > ttlMs) {
        this.logger.info(`Cleaning up idle in-memory session: ${name}`);
        try {
          managed.session.stop();
        } catch {
          // Best-effort — session may already be dead; must not block TTL cleanup
        }
        this.sessions.delete(name);
        // NOTE: do NOT delete from persistedSessions — idle cleanup is
        // in-memory only. Persisted entries survive for PERSIST_DISK_TTL_MS
        // (7 days) so the session can be resumed after a gateway restart.
      }
    }
    // Prune disk entries that exceeded the longer disk TTL
    let pruned = false;
    for (const [name, entry] of this.persistedSessions) {
      if (now - entry.lastActivity > PERSIST_DISK_TTL_MS) {
        this.persistedSessions.delete(name);
        pruned = true;
      }
    }
    if (pruned) savePersistedSessionsAsync(this.persistedSessions);
  }
}
