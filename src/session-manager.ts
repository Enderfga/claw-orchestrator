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
import { InboxManager, type SessionLookup } from './inbox-manager.js';
import { sanitizeCwd, validateName } from './validation.js';
import { PersistentClaudeSession } from './persistent-session.js';
import { PersistentGeminiSession } from './persistent-gemini-session.js';
import { PersistentCodexSession } from './persistent-codex-session.js';
import { PersistentCodexAppServerSession } from './persistent-codex-app-session.js';
import { PersistentCursorSession } from './persistent-cursor-session.js';
import { PersistentOpencodeSession } from './persistent-opencode-session.js';
import { PersistentCustomSession } from './persistent-custom-session.js';
import {
  type SessionConfig,
  type SessionInfo,
  type SendResult,
  type PluginConfig,
  type EffortLevel,
  type EngineType,
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
  RESULT_TTL_MS,
  ULTRAPLAN_TIMEOUT_MS,
  ULTRAREVIEW_POLL_INTERVAL_MS,
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
  /**
   * Per-session send chain. Concurrent sendMessage() calls on the same session
   * MUST serialize, otherwise PersistentClaudeSession's single _streamCallbacks
   * field and shared TURN_COMPLETE listener race — the second caller would
   * receive the first caller's response. Each call awaits the previous chain
   * link, then installs its own; release happens in a finally block so a
   * thrown send still unblocks waiters.
   */
  sendChain?: Promise<unknown>;
}

interface SendOptions {
  effort?: EffortLevel;
  plan?: boolean;
  autoResume?: boolean;
  timeout?: number;
  onEvent?: (event: StreamEvent) => void;
  onChunk?: (chunk: string) => void;
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

// ─── Disk enumeration (cross-process visibility) ────────────────────────────
//
// When the dashboard's standalone clawo-serve and the OpenClaw plugin run as
// separate processes, each has its own in-memory map of active runs. To make
// past runs visible across processes we read what's persisted on disk:
//   - Council: transcripts at ~/.openclaw/council-logs/council-*.md
//   - Autoloop: registry at ~/.claw-orchestrator/autoloop-registry.jsonl

const DEFAULT_COUNCIL_LOG_DIR = path.join(os.homedir(), '.openclaw', 'council-logs');
const DEFAULT_AUTOLOOP_REGISTRY = path.join(os.homedir(), '.claw-orchestrator', 'autoloop-registry.jsonl');

/** Public shape returned by listCouncilsFromDisk(). Mirrors a subset of CouncilSession. */
export interface CouncilDiskRecord {
  id: string;
  task: string;
  status: string;
  startTime: string;
}

/**
 * One row in ~/.claw-orchestrator/autoloop-registry.jsonl. Used to make
 * autoloop runs visible across processes (the ledger lives at
 * <workspace>/tasks/<run_id>/, workspaces vary, so we keep a central
 * append-only index here).
 */
export interface AutoloopRegistryEntry {
  run_id: string;
  workspace: string;
  ledger_dir: string;
  started_at: string;
  planner_session: string;
}

/** Append-only registry write. Safe under concurrent writers — append is atomic for short lines. */
export function appendAutoloopRegistry(file: string, entry: AutoloopRegistryEntry): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(entry) + '\n');
}

/**
 * Read the registry, dedup by run_id (newest entry wins), drop entries whose
 * ledger_dir no longer exists on disk (cleanup of moved/deleted workspaces).
 * Returns entries newest-first.
 */
export function listAutoloopsFromRegistry(file = DEFAULT_AUTOLOOP_REGISTRY): AutoloopRegistryEntry[] {
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean);
  const seen = new Set<string>();
  const out: AutoloopRegistryEntry[] = [];
  // Walk in reverse so the latest entry for a given run_id wins.
  for (const line of [...lines].reverse()) {
    try {
      const e = JSON.parse(line) as AutoloopRegistryEntry;
      if (seen.has(e.run_id)) continue;
      seen.add(e.run_id);
      if (!fs.existsSync(e.ledger_dir)) continue; // stale entry, ledger gone
      out.push(e);
    } catch {
      // malformed line; skip
    }
  }
  return out; // already newest-first because we reversed
}

/**
 * Rewrite the registry with every line for the given run_id filtered out.
 * Used by autoloopDelete to scrub a run from cross-process visibility.
 * No-op if the file does not exist. Returns the number of lines removed.
 */
export function removeAutoloopFromRegistry(file: string, runId: string): number {
  if (!fs.existsSync(file)) return 0;
  const lines = fs.readFileSync(file, 'utf-8').split('\n');
  let removed = 0;
  const kept: string[] = [];
  for (const line of lines) {
    if (!line) {
      kept.push(line);
      continue;
    }
    try {
      const e = JSON.parse(line) as AutoloopRegistryEntry;
      if (e.run_id === runId) {
        removed += 1;
        continue;
      }
    } catch {
      // malformed line — keep it, we only filter recognizable entries
    }
    kept.push(line);
  }
  if (removed === 0) return 0;
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, kept.join('\n'));
  fs.renameSync(tmp, file);
  return removed;
}

/**
 * Enumerate council sessions from on-disk transcripts. Called by
 * SessionManager.councilList() to surface runs that the current process didn't
 * spawn itself (e.g. runs started in another process whose transcripts have
 * already been flushed to ~/.openclaw/council-logs/).
 *
 * Format parsed (matches src/council.ts saveTranscript):
 *   - **ID**: <session.id>
 *   - **Time**: <iso>
 *   - **Task**: <text>
 *   - **Status**: <consensus|max_rounds|...>
 *
 * Legacy transcripts written before the ID field was added fall back to a
 * filename-derived id (basename without .md). That's stable across reruns
 * even if uncomfortable as a display id.
 */
export function listCouncilsFromDisk(logDir = DEFAULT_COUNCIL_LOG_DIR): CouncilDiskRecord[] {
  if (!fs.existsSync(logDir)) return [];
  const out: CouncilDiskRecord[] = [];
  for (const entry of fs.readdirSync(logDir)) {
    if (!entry.startsWith('council-') || !entry.endsWith('.md')) continue;
    let head: string;
    try {
      head = fs.readFileSync(path.join(logDir, entry), 'utf-8').slice(0, 2000);
    } catch {
      continue;
    }
    const id = /^-\s+\*\*ID\*\*:\s*([^\n]+)/m.exec(head)?.[1]?.trim() || entry.replace(/\.md$/, '');
    const task = /^-\s+\*\*Task\*\*:\s*([^\n]+)/m.exec(head)?.[1]?.trim() || '(no task recorded)';
    const startTime = /^-\s+\*\*Time\*\*:\s*([^\n]+)/m.exec(head)?.[1]?.trim() || '';
    const status = /^-\s+\*\*Status\*\*:\s*([^\n]+)/m.exec(head)?.[1]?.trim() || 'unknown';
    out.push({ id, task, status, startTime });
  }
  return out;
}

// ─── SessionManager ──────────────────────────────────────────────────────────

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
    // Skip when config.skipPersistence is set (e.g. openai-compat bridge sessions
    // that must NOT resume stale CLI state from a previous server run).
    const skipPersist = !!(config as Record<string, unknown>).skipPersistence;
    const persisted = skipPersist ? undefined : this.persistedSessions.get(name);
    // Unified: only use resumeSessionId (claudeResumeId is an internal alias, not exposed)
    const resumeId = config.resumeSessionId ?? persisted?.claudeSessionId;

    const fullConfig: SessionConfig = {
      name,
      cwd: config.cwd || persisted?.cwd || process.cwd(),
      permissionMode: config.permissionMode || this.pluginConfig.defaultPermissionMode,
      effort: config.effort || this.pluginConfig.defaultEffort,
      model: config.model || persisted?.model || this.pluginConfig.defaultModel,
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
      claudeSessionId: session.sessionId,
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

      const result = await managed.session.send(message, sendOpts);

      // Update session ID if available (skip disk persist for ephemeral
      // sessions that were started with skipPersistence)
      if (managed.session.sessionId) {
        managed.claudeSessionId = managed.session.sessionId;
        if (this.persistedSessions.has(name)) {
          this._persistSession(name, managed);
        }
      }

      if ('text' in result) {
        return {
          output: result.text,
          sessionId: managed.claudeSessionId,
          events: [],
        };
      }

      return { output: '', sessionId: managed.claudeSessionId, events: [] };
    } finally {
      releaseChain();
      // If this was the tail of the chain, clear it so memory doesn't grow.
      if (managed.sendChain === link) managed.sendChain = undefined;
    }
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

    const sessionId = managed.claudeSessionId || managed.session.sessionId;
    if (!sessionId) throw new Error(`Session '${name}' has no claude session ID — cannot resume after restart`);

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
        resumeSessionId: sessionId,
      });
    } catch (err) {
      // Rollback: restart with original config
      this.logger.error(`switchModel failed for '${name}', attempting rollback:`, err);
      try {
        await this.startSession({ ...oldConfig, name, resumeSessionId: sessionId });
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

    const sessionId = managed.claudeSessionId || managed.session.sessionId;
    if (!sessionId) throw new Error(`Session '${name}' has no claude session ID — cannot resume after restart`);

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
        resumeSessionId: sessionId,
      });
    } catch (err) {
      this.logger.error(`updateTools failed for '${name}', attempting rollback:`, err);
      try {
        await this.startSession({ ...oldConfig, name, resumeSessionId: sessionId });
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
      sessionId: managed.claudeSessionId,
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
    // Stop ultrareview pollers
    for (const [, timer] of this.ultrareviewPollers) clearInterval(timer);
    this.ultrareviewPollers.clear();
    // Clear council/fanout cleanup timers — their 30-min closures capture `this`
    // and would otherwise fire after shutdown (and council timers, before this
    // fix, were not unref'd so they blocked a clean process exit).
    for (const [, timer] of this.councilCleanupTimers) clearTimeout(timer);
    this.councilCleanupTimers.clear();
    this.councils.clear();
    for (const [, timer] of this.fanoutCleanupTimers) clearTimeout(timer);
    this.fanoutCleanupTimers.clear();
    this.fanouts.clear();
    // Stop autoloops (graceful: dispatch a terminate envelope so each run
    // shuts down its three persistent agents and cleans up the ledger lock).
    for (const [, ctx] of this.autoloops) {
      try {
        await ctx.runner.send(AutoloopMsg.terminate(ctx.runner.state.iter, { reason: 'manager-shutdown' }));
      } catch {
        // Best-effort.
      }
    }
    this.autoloops.clear();
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
    if (!managed.claudeSessionId) return;
    const existing = this.persistedSessions.get(name);
    this.persistedSessions.set(name, {
      name,
      claudeSessionId: managed.claudeSessionId,
      cwd: managed.cwd,
      model: managed.config.resolvedModel || managed.config.model,
      engine: managed.config.engine,
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
    return {
      name,
      claudeSessionId: managed.claudeSessionId,
      created: managed.created,
      cwd: managed.cwd,
      model: managed.config.resolvedModel || managed.config.model,
      paused: false,
      stats,
    };
  }

  private _resolveModel(alias: string, overrides?: Record<string, string>): string {
    if (overrides?.[alias]) return overrides[alias];
    return resolveAlias(alias);
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
      case 'codex':
        return new PersistentCodexSession(config, process.env.CODEX_BIN);
      case 'codex-app':
        return new PersistentCodexAppServerSession(config, process.env.CODEX_BIN);
      case 'cursor':
        return new PersistentCursorSession(config, process.env.CURSOR_BIN);
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

  private councils = new Map<string, Council>();
  private councilCleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();

  councilStart(task: string, config: CouncilConfig): CouncilSession {
    const council = new Council(config, this, this.logger);
    const initialSession = council.init(task);

    // Store BEFORE running so council_status/abort/inject work while it's active
    this.councils.set(initialSession.id, council);

    // Run in background — callers poll via councilStatus()
    council
      .run()
      .then(() => {
        // Keep completed council queryable; schedule cleanup after TTL
        this._scheduleCouncilCleanup(initialSession.id);
      })
      .catch((err) => {
        this.logger.error(`Council ${initialSession.id} failed:`, err);
        this._scheduleCouncilCleanup(initialSession.id);
      });

    return initialSession;
  }

  private _scheduleCouncilCleanup(id: string): void {
    // Clear any existing timer before scheduling a new one
    const existing = this.councilCleanupTimers.get(id);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      // Abort if still running to prevent orphaned background tasks
      const council = this.councils.get(id);
      if (council) {
        const session = council.getSession();
        if (session?.status === 'running') {
          this.logger.info(`Council ${id} still running at TTL expiry — aborting`);
          council.abort();
        }
      }
      this.councils.delete(id);
      this.councilCleanupTimers.delete(id);
    }, RESULT_TTL_MS);
    // Don't let a pending 30-min cleanup timer keep the process alive or block shutdown.
    timer.unref();
    this.councilCleanupTimers.set(id, timer);
  }

  /** Clear and forget a cleanup timer (used on abort/shutdown so it can't fire late). */
  private _clearCleanupTimer(map: Map<string, ReturnType<typeof setTimeout>>, id: string): void {
    const t = map.get(id);
    if (t) {
      clearTimeout(t);
      map.delete(id);
    }
  }

  councilStatus(id: string): CouncilSession | undefined {
    const council = this.councils.get(id);
    return council?.getSession();
  }

  /**
   * List all council sessions visible to this process.
   *
   * Includes (a) in-memory sessions managed by this SessionManager and (b)
   * sessions reconstructed from on-disk transcripts at ~/.openclaw/council-logs/.
   * The disk path lets the dashboard see runs started in OTHER processes
   * (e.g. plugin-managed runs visible to a standalone clawo-serve dashboard).
   * Dedup by id; in-memory wins. Sorted by startTime descending so the newest
   * appears at the top of the sidebar.
   */
  councilList(): CouncilSession[] {
    const inMemory = Array.from(this.councils.values())
      .map((c) => c.getSession())
      .filter((s): s is CouncilSession => s !== null && s !== undefined);
    const inMemIds = new Set(inMemory.map((s) => s.id));
    const fromDisk: CouncilSession[] = listCouncilsFromDisk()
      .filter((r) => !inMemIds.has(r.id))
      .map(
        (r) =>
          ({
            id: r.id,
            task: r.task,
            status: r.status as CouncilSession['status'],
            startTime: r.startTime,
            responses: [],
            config: { agents: [], maxRounds: 0, projectDir: '' },
          }) as CouncilSession,
      );
    return [...inMemory, ...fromDisk].sort((a, b) => (b.startTime || '').localeCompare(a.startTime || ''));
  }

  /** Used by embedded-server to subscribe to a council's event stream. */
  getCouncil(id: string): Council | undefined {
    return this.councils.get(id);
  }

  councilAbort(id: string): void {
    const council = this.councils.get(id);
    if (!council) throw new Error(`Council '${id}' not found`);
    council.abort();
    this.councils.delete(id);
    // Drop the orphaned cleanup timer so it doesn't fire later on a deleted council.
    this._clearCleanupTimer(this.councilCleanupTimers, id);
  }

  councilInject(id: string, message: string): void {
    const council = this.councils.get(id);
    if (!council) throw new Error(`Council '${id}' not found`);
    council.injectMessage(message);
  }

  async councilReview(id: string): Promise<CouncilReviewResult> {
    const council = this.councils.get(id);
    if (!council) throw new Error(`Council '${id}' not found`);
    this._scheduleCouncilCleanup(id); // reset TTL — user is actively reviewing
    return council.review();
  }

  async councilAccept(id: string): Promise<CouncilAcceptResult> {
    const council = this.councils.get(id);
    if (!council) throw new Error(`Council '${id}' not found`);
    const result = await council.accept();
    // Accepted — no longer needed, clean up after short grace period
    this._scheduleCouncilCleanup(id);
    return result;
  }

  async councilReject(id: string, feedback: string): Promise<CouncilRejectResult> {
    const council = this.councils.get(id);
    if (!council) throw new Error(`Council '${id}' not found`);
    const result = await council.reject(feedback);
    this._scheduleCouncilCleanup(id); // reset TTL — council may be restarted
    return result;
  }

  // ─── Fan-out (parallel multi-engine task, no consensus) ────────────────

  private fanouts = new Map<string, Fanout>();
  private fanoutCleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /**
   * Start a fan-out: run the task across N engine/model agents in parallel and
   * collect their answers (optional synthesis). Runs in the background; poll
   * with fanoutStatus. Distinct from council — no rounds, votes, or worktrees.
   */
  fanoutStart(config: FanoutConfig): FanoutSession {
    if (!config.agents?.length) throw new Error('fanoutStart: at least one agent is required');
    const names = config.agents.map((a) => a.name);
    if (new Set(names).size !== names.length) {
      throw new Error('fanoutStart: agent names must be unique (they form session names)');
    }
    const fanout = new Fanout(config, this, this.logger);
    const session = fanout.init();
    this.fanouts.set(session.id, fanout);
    fanout
      .run()
      .catch((err) => this.logger.error(`Fanout ${session.id} failed:`, err))
      .finally(() => this._scheduleFanoutCleanup(session.id));
    return session;
  }

  fanoutStatus(id: string): FanoutSession {
    const fanout = this.fanouts.get(id);
    if (!fanout) throw new Error(`Fanout '${id}' not found`);
    return fanout.getSession();
  }

  fanoutAbort(id: string): void {
    const fanout = this.fanouts.get(id);
    if (!fanout) throw new Error(`Fanout '${id}' not found`);
    fanout.abort();
    this._scheduleFanoutCleanup(id);
  }

  private _scheduleFanoutCleanup(id: string): void {
    const existing = this.fanoutCleanupTimers.get(id);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.fanouts.delete(id);
      this.fanoutCleanupTimers.delete(id);
    }, RESULT_TTL_MS);
    if (typeof timer.unref === 'function') timer.unref();
    this.fanoutCleanupTimers.set(id, timer);
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

  private ultraplans = new Map<string, UltraplanResult>();
  ultraplanStart(task: string, opts?: { model?: string; cwd?: string; timeout?: number }): UltraplanResult {
    const id = `ultraplan-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const sessionName = `ultraplan-${id}`;
    const timeout = opts?.timeout || ULTRAPLAN_TIMEOUT_MS;

    const result: UltraplanResult = {
      id,
      status: 'running',
      sessionName,
      startTime: new Date().toISOString(),
    };
    this.ultraplans.set(id, result);

    // Run in background
    this._runUltraplan(id, sessionName, task, opts?.model || 'opus', opts?.cwd || process.cwd(), timeout)
      .catch((err) => {
        result.status = 'error';
        result.error = (err as Error).message;
        result.endTime = new Date().toISOString();
      })
      .finally(() => {
        // Cleanup session
        this.stopSession(sessionName).catch((err) => {
          this.logger.error(`Failed to stop ultraplan session '${sessionName}':`, err);
        });
        const ttlTimer = setTimeout(() => {
          // Mark as error if still running at TTL expiry
          const plan = this.ultraplans.get(id);
          if (plan?.status === 'running') {
            this.logger.info(`Ultraplan ${id} still running at TTL expiry — marking as error`);
            plan.status = 'error';
            plan.error = 'Timed out (TTL expired)';
            plan.endTime = new Date().toISOString();
          }
          this.ultraplans.delete(id);
        }, RESULT_TTL_MS);
        ttlTimer.unref(); // don't block process exit on a 30-min TTL timer

      });

    return result;
  }

  private async _runUltraplan(
    id: string,
    sessionName: string,
    task: string,
    model: string,
    cwd: string,
    timeout: number,
  ): Promise<void> {
    const result = this.ultraplans.get(id)!;

    await this.startSession({
      name: sessionName,
      cwd,
      model,
      permissionMode: 'plan',
      effort: 'max',
      appendSystemPrompt:
        'You are in ultraplan mode. Explore the project thoroughly, analyze feasibility, and produce a detailed, actionable plan. Do NOT write code — plan only. Output your final plan in a clear markdown format.',
    });

    const planPrompt = `# Ultraplan Task\n\n${task}\n\nExplore the project, understand the codebase, analyze feasibility, and produce a comprehensive implementation plan. Take your time (up to 30 minutes). Be thorough.`;

    const sendResult = await this.sendMessage(sessionName, planPrompt, { timeout });

    // Detect error responses: empty output or output that looks like an error message
    const output = sendResult.output?.trim() || '';
    const looksLikeError =
      !output ||
      /^(Error|not logged in|authentication|auth failed|permission denied)/i.test(output) ||
      (sendResult.error && sendResult.error.length > 0);

    if (looksLikeError) {
      result.status = 'error';
      result.error = sendResult.error || output || 'Empty response from engine';
    } else {
      result.plan = output;
      result.status = 'completed';
    }
    result.endTime = new Date().toISOString();
  }

  ultraplanStatus(id: string): UltraplanResult | undefined {
    return this.ultraplans.get(id);
  }

  // ─── Ultrareview ──────────────────────────────────────────────────────

  private ultrareviews = new Map<string, UltrareviewResult>();
  private ultrareviewPollers = new Map<string, ReturnType<typeof setInterval>>();
  ultrareviewStart(
    cwd: string,
    opts?: {
      agentCount?: number;
      maxDurationMinutes?: number;
      model?: string;
      focus?: string;
      engines?: EngineType[];
    },
  ): UltrareviewResult {
    const id = `ultrareview-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const agentCount = Math.min(20, Math.max(1, opts?.agentCount || 5));

    const result: UltrareviewResult = {
      id,
      status: 'running',
      councilId: '',
      agentCount,
      startTime: new Date().toISOString(),
    };
    this.ultrareviews.set(id, result);

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

    let fanoutSession: FanoutSession;
    try {
      fanoutSession = this.fanoutStart({
        task: reviewInstruction,
        projectDir: cwd,
        agents,
        synthesize: true,
        agentTimeoutMs: maxMinutes * 60 * 1000,
        maxTurnsPerAgent: 20,
      });
    } catch (err) {
      // Fan-out failed to even start (e.g. validation) — surface it on the
      // stored result instead of leaving it frozen at 'running'.
      result.status = 'error';
      result.error = (err as Error).message;
      result.endTime = new Date().toISOString();
      setTimeout(() => this.ultrareviews.delete(id), RESULT_TTL_MS);
      return result;
    }

    // `councilId` is kept for the UltrareviewResult contract; it now holds the
    // fan-out id (an opaque run id used only by ultrareview_status).
    result.councilId = fanoutSession.id;

    // Poll the fan-out for completion (store ref for shutdown cleanup).
    const pollInterval = setInterval(() => {
      try {
        const status = this.fanoutStatus(fanoutSession.id);
        if (!status || status.status === 'running') return;

        clearInterval(pollInterval);
        this.ultrareviewPollers.delete(id);
        result.status = status.status === 'error' ? 'error' : 'completed';
        result.endTime = new Date().toISOString();

        // Prefer the synthesis pass; fall back to joining successful results.
        if (status.synthesis) {
          result.findings = status.synthesis;
        } else if (status.results.length > 0) {
          result.findings = status.results
            .filter((r) => r.ok)
            .map((r) => `## ${r.agent}\n\n${r.output}`)
            .join('\n\n---\n\n');
        }

        {
          const ttlDelete = setTimeout(() => this.ultrareviews.delete(id), RESULT_TTL_MS);
          ttlDelete.unref();
        }
      } catch {
        // Fan-out may have been cleaned up; stop polling.
        clearInterval(pollInterval);
        this.ultrareviewPollers.delete(id);
      }
    }, ULTRAREVIEW_POLL_INTERVAL_MS);
    this.ultrareviewPollers.set(id, pollInterval);

    return result;
  }

  ultrareviewStatus(id: string): UltrareviewResult | undefined {
    return this.ultrareviews.get(id);
  }

  // ─── Autoloop (three-agent architecture) ───────────────────────────

  private autoloops = new Map<
    string,
    {
      runner: AutoloopRunner;
      dispatcher: ClaudeAgentDispatcher;
      workspace: string;
      ledgerDir: string;
      pushPolicy: PushPolicy;
    }
  >();
  // runIds currently being torn down by autoloopDelete. Guards against a
  // concurrent autoloopStart recreating the same id (or autoloopChat using a
  // dispatcher mid-shutdown) during the async delete window.
  private _deletingAutoloops = new Set<string>();

  /**
   * Start a v2 autoloop in chat mode. Creates the Planner persistent session,
   * returns the run handle. Coder/Reviewer are NOT started until S3's
   * spawn_subagents tool is called.
   */
  async autoloopStart(opts: {
    runId: string;
    workspace: string;
    plannerPromptPath?: string;
    plannerModel?: string;
    sendTimeoutMs?: number;
  }): Promise<{ runId: string; plannerSession: string; state: AutoloopState }> {
    if (this.autoloops.has(opts.runId)) {
      throw new Error(`Autoloop with id '${opts.runId}' already exists`);
    }
    if (this._deletingAutoloops.has(opts.runId)) {
      throw new Error(`Autoloop with id '${opts.runId}' is being deleted`);
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
      plannerModel: opts.plannerModel,
      sendTimeoutMs: opts.sendTimeoutMs,
      logger: this.logger,
      pushPolicyRef: pushPolicy,
      onSpawnSubagents: async (args) => {
        this.logger.info?.(`[autoloop/${runId}] spawn_subagents starting Coder + Reviewer sessions`);
        await dispatcherRef?.spawnSubagents(args);
        runnerRef?.markSubagentsSpawned();
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
    this.autoloops.set(opts.runId, {
      runner,
      dispatcher,
      workspace: opts.workspace,
      ledgerDir,
      pushPolicy,
    });
    await runner.start();
    // Record into the cross-process registry so the dashboard / another
    // SessionManager instance can list this run even after it ends. Best
    // effort — registry failure should not block the run.
    try {
      appendAutoloopRegistry(DEFAULT_AUTOLOOP_REGISTRY, {
        run_id: opts.runId,
        workspace: opts.workspace,
        ledger_dir: ledgerDir,
        started_at: runner.state.started_at,
        planner_session: dispatcher.sessionNames.planner,
      });
    } catch (err) {
      this.logger.warn?.(`[autoloop/${runId}] registry append failed: ${(err as Error).message}`);
    }
    return {
      runId: opts.runId,
      plannerSession: dispatcher.sessionNames.planner,
      state: runner.state,
    };
  }

  /**
   * Inject a user chat message into a v2 run's Planner. Returns the Planner's
   * natural-language reply.
   */
  async autoloopChat(runId: string, text: string): Promise<{ reply: string }> {
    const ctx = this.autoloops.get(runId);
    if (!ctx || this._deletingAutoloops.has(runId)) throw new Error(`Autoloop run '${runId}' not found`);
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

  autoloopStatus(runId: string): AutoloopState | undefined {
    const live = this.autoloops.get(runId)?.runner.state;
    if (live) return live;
    // Fallback: rebuild a terminated-state shape from the cross-process
    // registry so the dashboard can open historical runs (read chat
    // history, view plan.md, push_log) instead of hanging on a 404 forever.
    const entry = listAutoloopsFromRegistry().find((e) => e.run_id === runId);
    if (!entry) return undefined;
    return {
      run_id: entry.run_id,
      status: 'terminated',
      iter: 0,
      subagents_spawned: false,
      started_at: entry.started_at,
      workspace: entry.workspace,
      ledger_dir: entry.ledger_dir,
      push_log_count: 0,
      status_reason: 'reconstructed from registry — not in current process memory',
      consecutive_phase_errors: 0,
      recent_phase_errors: [],
      metric_history: [],
      last_activity_at: 0,
    };
  }

  autoloopList(): AutoloopState[] {
    const inMemory = Array.from(this.autoloops.values()).map((c) => c.runner.state);
    const inMemIds = new Set(inMemory.map((s) => s.run_id));
    const fromDisk: AutoloopState[] = listAutoloopsFromRegistry()
      .filter((e) => !inMemIds.has(e.run_id))
      .map(
        (e): AutoloopState => ({
          run_id: e.run_id,
          status: 'terminated',
          iter: 0,
          subagents_spawned: false,
          started_at: e.started_at,
          workspace: e.workspace,
          ledger_dir: e.ledger_dir,
          push_log_count: 0,
          status_reason: 'reconstructed from registry — not in current process memory',
          consecutive_phase_errors: 0,
          recent_phase_errors: [],
          metric_history: [],
          last_activity_at: 0,
        }),
      );
    return [...inMemory, ...fromDisk].sort((a, b) => (b.started_at || '').localeCompare(a.started_at || ''));
  }

  /**
   * Reset a single subagent on a v2 run. Useful when an agent has drifted
   * (chat memory implies hallucination, repeated rejects, or context bloat).
   * Coder/Reviewer: safe to reset; the next directive/review_request will
   * re-prime from system prompt + ledger artifacts.
   * Planner: requires force=true and discards user-conversation context.
   */
  async autoloopResetAgent(
    runId: string,
    agent: 'planner' | 'coder' | 'reviewer',
    opts: { force?: boolean; eagerRestart?: boolean } = {},
  ): Promise<boolean> {
    const ctx = this.autoloops.get(runId);
    if (!ctx) return false;
    await ctx.dispatcher.resetAgent(agent, opts);
    return true;
  }

  async autoloopStop(runId: string, reason = 'user-stop'): Promise<boolean> {
    const ctx = this.autoloops.get(runId);
    if (!ctx) return false;
    await ctx.runner.send(AutoloopMsg.terminate(ctx.runner.state.iter, { reason }));
    this.autoloops.delete(runId);
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
  async autoloopResume(runId: string): Promise<AutoloopState> {
    const existing = this.autoloops.get(runId);
    if (existing) return existing.runner.state;

    const entry = listAutoloopsFromRegistry().find((e) => e.run_id === runId);
    if (!entry) throw new Error(`Autoloop run '${runId}' not found in registry`);

    // Scrub the prior registry row before autoloopStart appends a new one.
    // Without this, every resume leaves a duplicate JSONL line; listAutoloops
    // dedups on read (newest wins), but the file grows monotonically and the
    // postmortem ledger becomes hard to scan. Best-effort — we don't block
    // the resume on a registry write failure.
    try {
      removeAutoloopFromRegistry(DEFAULT_AUTOLOOP_REGISTRY, runId);
    } catch (err) {
      this.logger.warn?.(`[autoloop/${runId}] registry scrub during resume failed: ${(err as Error).message}`);
    }

    return (
      await this.autoloopStart({
        runId: entry.run_id,
        workspace: entry.workspace,
      })
    ).state;
  }

  /**
   * Delete a run from the system: stop the runner if it's still alive in this
   * process, then scrub the row from the cross-process registry so it stops
   * appearing in `autoloop_list` / the dashboard. The ledger directory on disk
   * is NOT removed — postmortem artifacts (chat history, push log, plan.md)
   * are kept for the user to inspect or `rm` manually.
   *
   * Returns true if anything was removed (in-memory entry OR registry row).
   */
  async autoloopDelete(runId: string): Promise<boolean> {
    // Fence the async teardown so a concurrent start/chat can't race on this id.
    this._deletingAutoloops.add(runId);
    try {
      return await this._autoloopDeleteInner(runId);
    } finally {
      this._deletingAutoloops.delete(runId);
    }
  }

  private async _autoloopDeleteInner(runId: string): Promise<boolean> {
    const ctx = this.autoloops.get(runId);
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
      this.autoloops.delete(runId);
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
    try {
      const removed = removeAutoloopFromRegistry(DEFAULT_AUTOLOOP_REGISTRY, runId);
      if (removed > 0) touched = true;
    } catch (err) {
      this.logger.warn?.(`[autoloop/${runId}] registry scrub failed: ${(err as Error).message}`);
    }
    return touched;
  }

  /** Used by embedded-server to attach SSE listeners. */
  getAutoloop(runId: string): { runner: AutoloopRunner; dispatcher: ClaudeAgentDispatcher } | undefined {
    const ctx = this.autoloops.get(runId);
    if (!ctx) return undefined;
    return { runner: ctx.runner, dispatcher: ctx.dispatcher };
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
