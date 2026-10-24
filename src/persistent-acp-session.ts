/**
 * ACP Session — drives any agent that speaks the Agent Client Protocol on stdio.
 *
 * `acp-server.ts` is the other half: there the orchestrator is the agent. Here
 * it is the client, so one wrapper covers every ACP agent (`kimi acp`,
 * `opencode acp`, a Claude Code ACP adapter, …) with no per-agent parsing. The
 * agent process lives as long as the session; each send is one `session/prompt`.
 *
 * Protocol notes (`@agentclientprotocol/sdk` 1.3.0, protocol v1):
 *   - `initialize` → `session/new` (or `session/load` / `session/resume` for a
 *     stored session id) → `session/prompt` per send. The prompt's response
 *     carries the stop reason; text, tool calls and usage arrive before it as
 *     `session/update` notifications.
 *   - The client advertises no `fs` or `terminal` capability, so the agent
 *     reads, writes and runs commands with its own tools, in its own process.
 *   - `session/request_permission` is answered at once from the session's
 *     permission mode. Nothing here can put a question to a person, and an
 *     unanswered request would hold the turn until it times out.
 */

import { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';

import { killEngineTree, spawnEngine } from './engine-spawn.js';
import { resolveAcpAgent } from './engine-presets.js';
import { resolveAlias } from './models.js';
import { SESSION_EVENT, MAX_HISTORY_ITEMS, DEFAULT_HISTORY_LIMIT } from './constants.js';
import type {
  AcpAgentConfig,
  CostBreakdown,
  EffortLevel,
  ISession,
  SessionConfig,
  SessionSendOptions,
  SessionStats,
  StreamEvent,
  TurnResult,
} from './types.js';

const DEFAULT_TURN_TIMEOUT_MS = 600_000;

/** Permission modes under which the agent may act without asking. */
const ALLOWING_MODES = new Set(['bypassPermissions', 'acceptEdits', 'auto', 'dontAsk']);

export class PersistentAcpSession extends EventEmitter implements ISession {
  private readonly options: SessionConfig;
  private readonly agent: AcpAgentConfig;
  private proc: ChildProcess | null = null;
  private conn: acp.ClientConnection | null = null;
  private acpSessionId?: string;
  private _isReady = false;
  private _isPaused = false;
  private _isBusy = false;
  private _startTime: string | null = null;
  private _history: Array<{ time: string; type: string; event: unknown }> = [];
  private _requests = 0;

  /** The turn in flight: its text so far and how to fail it if the process dies. */
  private turnText = '';
  private turnFail: ((e: Error) => void) | null = null;

  public sessionId?: string;
  private _stats = {
    turns: 0,
    turnsSucceeded: 0,
    toolCalls: 0,
    toolErrors: 0,
    tokensIn: 0,
    tokensOut: 0,
    cachedTokens: 0,
    costUsd: 0,
    /** True once the agent has reported a cost; the registry estimate is then never used. */
    costReported: false,
    contextUsed: 0,
    contextSize: 0,
    lastActivity: null as string | null,
  };

  constructor(config: SessionConfig) {
    super();
    const agent = resolveAcpAgent(config.acpAgent);
    if (!agent) throw new Error("engine 'acp' needs `acpAgent`: a bundled preset id or an inline config");
    this.agent = agent;
    this.options = { ...config, permissionMode: config.permissionMode || 'bypassPermissions' };
  }

  // ── Property accessors ─────────────────────────────────────────────────

  get pid(): number | undefined {
    return this.proc?.pid ?? undefined;
  }
  get isReady(): boolean {
    return this._isReady;
  }
  get isPaused(): boolean {
    return this._isPaused;
  }
  get isBusy(): boolean {
    return this._isBusy;
  }
  /** The agent's own session id; a later session resumes it. */
  get agentSessionId(): string | undefined {
    return this.acpSessionId;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  async start(): Promise<this> {
    const cwd = path.resolve(this.options.cwd || process.cwd());
    if (!fs.existsSync(cwd)) fs.mkdirSync(cwd, { recursive: true });
    this.options.cwd = cwd;

    const command = (this.agent.commandEnv && process.env[this.agent.commandEnv]) || this.agent.command;
    const proc = spawnEngine(command, this.agent.args ?? [], {
      launcher: this.options.launcher,
      cwd,
      env: { ...process.env, ...this.agent.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc = proc;
    proc.stderr?.on('data', (d: Buffer) => this.emit(SESSION_EVENT.LOG, `[acp:${this.agent.name}] ${d.toString()}`));
    const exited = new Promise<never>((_, reject) => {
      proc.once('error', (err) => reject(new Error(`could not start ${command}: ${err.message}`)));
      proc.once('exit', (code, signal) => {
        this._isReady = false;
        const err = new Error(`ACP agent ${this.agent.name} exited (${signal ?? `code ${code}`})`);
        this.turnFail?.(err);
        this.turnFail = null;
        this.conn?.close(err);
        reject(err);
        this.emit(SESSION_EVENT.CLOSE, code ?? 0);
      });
    });
    exited.catch(() => undefined);

    const stream = acp.ndJsonStream(
      Writable.toWeb(proc.stdin!) as WritableStream<Uint8Array>,
      Readable.toWeb(proc.stdout!) as ReadableStream<Uint8Array>,
    );
    this.conn = acp
      .client({ name: 'claw-orchestrator' })
      .onRequest(acp.methods.client.session.requestPermission, (ctx) => this._answerPermission(ctx.params))
      .onNotification(acp.methods.client.session.update, (ctx) => this._onUpdate(ctx.params))
      .connect(stream);
    // A closed connection is a dead session, whether or not the exit has been reported yet.
    this.conn.closed.then(
      () => (this._isReady = false),
      () => (this._isReady = false),
    );

    const agent = this.conn.agent;
    const init = await Promise.race([
      agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: 'claw-orchestrator', version: '1' },
      }),
      exited,
    ]);
    const caps = init.agentCapabilities ?? {};

    const resumeId = this.options.resumeSessionId;
    if (resumeId) {
      // A stored id that cannot be honoured is an error, not a fresh session:
      // the caller asked for that conversation, and a new one would silently
      // drop everything it knew.
      if (caps.sessionCapabilities?.resume) {
        await Promise.race([
          agent.request(acp.methods.agent.session.resume, { sessionId: resumeId, cwd, mcpServers: [] }),
          exited,
        ]);
      } else if (caps.loadSession) {
        await Promise.race([
          agent.request(acp.methods.agent.session.load, { sessionId: resumeId, cwd, mcpServers: [] }),
          exited,
        ]);
      } else {
        this.stop();
        throw new Error(`ACP agent ${this.agent.name} cannot resume a session (no loadSession or resume capability)`);
      }
      // Set only now: `session/load` replays the conversation as updates
      // before it returns, and an update for an id not yet ours is dropped —
      // that history is not this session's work.
      this.acpSessionId = resumeId;
    } else {
      const created = await Promise.race([
        agent.request(acp.methods.agent.session.new, { cwd, mcpServers: [] }),
        exited,
      ]);
      this.acpSessionId = created.sessionId;
    }

    this.sessionId = `acp-${this.agent.name}-${Date.now().toString(36)}`;
    this._startTime = new Date().toISOString();
    this._isReady = true;
    this.emit(SESSION_EVENT.READY);
    this.emit(SESSION_EVENT.INIT, { type: 'system', subtype: 'init', session_id: this.sessionId });
    return this;
  }

  stop(): void {
    this._isReady = false;
    this._isPaused = false;
    if (this.conn && this.acpSessionId && this._isBusy) {
      this.conn.agent.notify(acp.methods.agent.session.cancel, { sessionId: this.acpSessionId }).catch(() => undefined);
    }
    this.conn?.close();
    this.conn = null;
    if (this.proc) {
      killEngineTree(this.proc);
      this.proc = null;
    }
  }

  pause(): void {
    this._isPaused = true;
    this.emit(SESSION_EVENT.PAUSED, { sessionId: this.sessionId });
  }
  resume(): void {
    this._isPaused = false;
    this.emit(SESSION_EVENT.RESUMED, { sessionId: this.sessionId });
  }

  // ── send() ─────────────────────────────────────────────────────────────

  async send(
    message: string | unknown[],
    options: SessionSendOptions = {},
  ): Promise<TurnResult | { requestId: number; sent: boolean }> {
    if (!this._isReady || !this.conn || !this.acpSessionId) throw new Error('Session not ready. Call start() first.');
    if (this._isBusy) throw new Error('A turn is already running on this ACP session');
    const text = typeof message === 'string' ? message : JSON.stringify(message);
    const id = ++this._requests;
    if (!options.waitForComplete) {
      this._turn(text, options).catch((err) => this._emitError(err as Error));
      return { requestId: id, sent: true };
    }
    return this._turn(text, options);
  }

  private async _turn(text: string, options: SessionSendOptions): Promise<TurnResult> {
    const conn = this.conn!;
    const sessionId = this.acpSessionId!;
    this._isBusy = true;
    this.turnText = '';
    const onText = (chunk: string) => {
      try {
        options.callbacks?.onText?.(chunk);
      } catch {
        // A caller's callback failing does not fail the turn.
      }
    };
    this.on(SESSION_EVENT.TEXT, onText);
    let timer: NodeJS.Timeout | undefined;
    try {
      const aborted = new Promise<never>((_, reject) => {
        this.turnFail = reject;
        timer = setTimeout(() => {
          conn.agent.notify(acp.methods.agent.session.cancel, { sessionId }).catch(() => undefined);
          reject(new Error(`Timeout waiting for ACP agent ${this.agent.name} to finish the turn`));
        }, options.timeout || DEFAULT_TURN_TIMEOUT_MS);
      });
      const response = await Promise.race([
        conn.agent.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text }] }),
        aborted,
      ]);
      this._absorbUsage(response.usage);
      const ok = response.stopReason === 'end_turn';
      this._stats.turns++;
      if (ok) this._stats.turnsSucceeded++;
      this._stats.lastActivity = new Date().toISOString();
      const event: StreamEvent = {
        type: 'result',
        subtype: ok ? 'success' : 'error',
        result: this.turnText,
        is_error: !ok,
        stop_reason: response.stopReason,
        session_id: this.sessionId,
        total_cost_usd: this._stats.costUsd,
      };
      this._addHistory({ time: this._stats.lastActivity, type: 'result', event });
      this.emit(SESSION_EVENT.RESULT, event);
      this.emit(SESSION_EVENT.TURN_COMPLETE, event);
      if (!ok) throw new Error(`ACP agent ${this.agent.name} stopped the turn: ${response.stopReason}`);
      return { text: this.turnText, event };
    } catch (err) {
      if (!(err instanceof Error && err.message.startsWith(`ACP agent ${this.agent.name} stopped`))) {
        this._stats.turns++;
      }
      // The connection usually ends (stdout EOF) before the exit is reported.
      if (err instanceof Error && /connection closed/i.test(err.message)) {
        throw new Error(`ACP agent ${this.agent.name} exited mid-turn`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
      this.turnFail = null;
      this._isBusy = false;
      this.removeListener(SESSION_EVENT.TEXT, onText);
    }
  }

  // ── Agent → client ─────────────────────────────────────────────────────

  private _answerPermission(params: acp.RequestPermissionRequest): acp.RequestPermissionResponse {
    const allow = ALLOWING_MODES.has(this.options.permissionMode ?? '');
    const kinds = allow ? ['allow_once', 'allow_always'] : ['reject_once', 'reject_always'];
    const option = kinds.map((k) => params.options.find((o) => o.kind === k)).find(Boolean);
    this._addHistory({
      time: new Date().toISOString(),
      type: 'permission',
      event: { tool: params.toolCall.title, answer: option?.kind ?? 'cancelled' },
    });
    return option
      ? { outcome: { outcome: 'selected', optionId: option.optionId } }
      : { outcome: { outcome: 'cancelled' } };
  }

  private _onUpdate(params: acp.SessionNotification): void {
    if (params.sessionId !== this.acpSessionId) return;
    const update = params.update;
    this._stats.lastActivity = new Date().toISOString();
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
        if (update.content.type === 'text') {
          this.turnText += update.content.text;
          this.emit(SESSION_EVENT.TEXT, update.content.text);
        }
        break;
      case 'tool_call':
        this._stats.toolCalls++;
        this.emit(SESSION_EVENT.TOOL_USE, { id: update.toolCallId, name: update.title, input: update.rawInput });
        if (update.status === 'failed') this._stats.toolErrors++;
        break;
      case 'tool_call_update':
        if (update.status === 'failed') this._stats.toolErrors++;
        if (update.status === 'completed' || update.status === 'failed') {
          this.emit(SESSION_EVENT.TOOL_RESULT, {
            id: update.toolCallId,
            is_error: update.status === 'failed',
            output: update.rawOutput,
          });
        }
        break;
      case 'usage_update':
        this._stats.contextUsed = update.used;
        this._stats.contextSize = update.size;
        if (update.cost && update.cost.currency.toUpperCase() === 'USD') {
          this._stats.costUsd = update.cost.amount;
          this._stats.costReported = true;
        }
        break;
      default:
        break;
    }
  }

  /** `PromptResponse.usage` holds session totals, so it replaces, never adds. */
  private _absorbUsage(usage: acp.Usage | null | undefined): void {
    if (!usage) return;
    this._stats.tokensIn = usage.inputTokens;
    this._stats.tokensOut = usage.outputTokens;
    this._stats.cachedTokens = usage.cachedReadTokens ?? 0;
    if (!this._stats.costReported && this.agent.pricing) {
      const p = this.agent.pricing;
      const fresh = Math.max(0, this._stats.tokensIn - this._stats.cachedTokens);
      this._stats.costUsd =
        (fresh * p.input + this._stats.cachedTokens * (p.cached ?? p.input) + this._stats.tokensOut * p.output) /
        1_000_000;
    }
  }

  // ── ISession surface ───────────────────────────────────────────────────

  getStats(): SessionStats & { sessionId?: string; uptime: number } {
    const window = this._stats.contextSize || this.agent.contextWindow || 0;
    return {
      turns: this._stats.turns,
      turnsSucceeded: this._stats.turnsSucceeded,
      toolCalls: this._stats.toolCalls,
      toolErrors: this._stats.toolErrors,
      tokensIn: this._stats.tokensIn,
      tokensOut: this._stats.tokensOut,
      cachedTokens: this._stats.cachedTokens,
      costUsd: Math.round(this._stats.costUsd * 10000) / 10000,
      isReady: this._isReady,
      startTime: this._startTime,
      lastActivity: this._stats.lastActivity,
      contextPercent: window ? Math.min(100, Math.round((this._stats.contextUsed / window) * 100)) : 0,
      retries: 0,
      sessionId: this.sessionId,
      uptime: this._startTime ? Math.round((Date.now() - new Date(this._startTime).getTime()) / 1000) : 0,
      acpSessionId: this.acpSessionId,
    };
  }

  getHistory(limit = DEFAULT_HISTORY_LIMIT): Array<{ time: string; type: string; event: unknown }> {
    return this._history.slice(-limit);
  }

  getCost(): CostBreakdown {
    const p = this.agent.pricing;
    return {
      model: this.options.model || this.agent.name,
      tokensIn: this._stats.tokensIn,
      tokensOut: this._stats.tokensOut,
      cachedTokens: this._stats.cachedTokens,
      pricing: { inputPer1M: p?.input ?? 0, outputPer1M: p?.output ?? 0, cachedPer1M: p?.cached },
      breakdown: { inputCost: 0, cachedCost: 0, outputCost: 0 },
      totalUsd: this._stats.costUsd,
    };
  }

  async compact(_summary?: string): Promise<TurnResult> {
    const event: StreamEvent = { type: 'result', result: 'ACP agents manage their own context' };
    return { text: 'ACP agents manage their own context', event };
  }

  getEffort(): EffortLevel {
    return this.options.effort || 'auto';
  }
  setEffort(level: EffortLevel): void {
    this.options.effort = level;
  }
  resolveModel(alias: string): string {
    return resolveAlias(alias);
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  /** As in codex-app: with no listener, an `'error'` event would throw and take the process down. */
  private _emitError(err: Error): void {
    if (this.listenerCount(SESSION_EVENT.ERROR) > 0) this.emit(SESSION_EVENT.ERROR, err);
    else this.emit(SESSION_EVENT.LOG, `[acp:${this.agent.name}] ${err.message}`);
  }

  private _addHistory(entry: { time: string; type: string; event: unknown }): void {
    this._history.push(entry);
    if (this._history.length > MAX_HISTORY_ITEMS) this._history.shift();
  }
}
