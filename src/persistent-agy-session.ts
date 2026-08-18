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
 *   - Real usage: input/output/cache-read tokens come from the `result` event,
 *     so cost is measured rather than guessed. Earlier versions of this wrapper
 *     read plain text and estimated ~4 chars/token, which is now only the
 *     fallback path when no result event arrives.
 *   - Timeout coherence: agy enforces its own --print-timeout (default 5m);
 *     we derive it from the send timeout so the two never disagree.
 *
 * Unknown --model values do not error — agy silently falls back to its
 * default model (verified empirically on 1.0.16).
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { EffortLevel, SessionConfig, SessionSendOptions, StreamEvent, TurnResult } from './types.js';
import { estimateTokens } from './models.js';
import { sanitizeSecrets } from './sanitize.js';
import { extractCreatedAgyConversationId, isAgyConversationId } from './agy-conversation.js';
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

/** One line of agy `--output-format stream-json`. Captured from agy 1.1.13. */
interface AgyStreamEvent {
  event?: string;
  conversation_id?: string;
  result?: {
    conversation_id?: string;
    status?: string;
    response?: string;
    error?: string;
    usage?: AgyUsage;
  };
}

// ─── PersistentAgySession ───────────────────────────────────────────────────

export class PersistentAgySession extends BaseOneShotSession {
  /**
   * Antigravity conversation ID for this session. Captured from the agy log
   * file after the first turn, then reused via `--conversation <id>` so the
   * model sees prior turns. Seeded from `resumeSessionId` when provided.
   */
  private agyConversationId: string | undefined;

  constructor(config: SessionConfig, agyBin?: string) {
    super(config, agyBin || process.env.AGY_BIN || 'agy', {
      enginePrefix: 'agy',
      defaultModel: 'gemini-3.5-flash',
      supportsCachedTokens: false,
      engineDisplayName: 'Antigravity',
    });
    // Non-UUID ids (synthetic session ids from persistence/restart paths) are
    // ignored: starting a fresh conversation beats resuming a broken one.
    if (isAgyConversationId(config.resumeSessionId)) {
      this.agyConversationId = config.resumeSessionId;
    }
  }

  /** Expose the captured conversation ID for resume tooling and stats overlay. */
  get conversationId(): string | undefined {
    return this.agyConversationId;
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
   * First turn:    `agy -p <msg> --log-file <tmp> [--sandbox|--dangerously-skip-permissions] [--model M] [--effort E] --print-timeout Ns`
   * Resume turns:  same + `--conversation <id>`
   */
  private _buildArgs(message: string, timeoutMs: number, turnEffort?: EffortLevel): string[] {
    // stream-json gives the conversation id up front, progress events while the
    // turn runs, and a final `result` carrying the answer plus real token usage.
    // Before this, the wrapper read plain text, scraped the id out of the log
    // file, and had to ESTIMATE tokens — so this engine's cost was a guess.
    // --log-file is still passed as the fallback id source for a turn that dies
    // before emitting any event.
    const args: string[] = ['-p', message, '--output-format', 'stream-json', '--log-file', this._logFile];

    // Permission mode. agy has no fine-grained permission flags (verified on
    // 1.0.16): bypass maps to --dangerously-skip-permissions, `default` maps
    // to --sandbox (terminal-restricted). Other modes run agy's own default
    // approval behavior — which blocks on unapproved tools in print mode, so
    // bypassPermissions (the SessionConfig default) is the practical choice
    // for headless work.
    if (this.options.sandboxMode === 'read-only') {
      args.push('--mode', 'plan');
    } else if (this.options.permissionMode === 'bypassPermissions' || this.options.dangerouslySkipPermissions) {
      args.push('--dangerously-skip-permissions');
    } else if (this.options.permissionMode === 'default' || this.options.permissionMode === 'manual') {
      args.push('--sandbox');
    }

    // Use the SessionManager-resolved model when available so documented
    // aliases (agy-pro → gemini-3.1-pro) do not silently fall back to agy's
    // default model.
    // agy 1.1.5+ exposes reasoning variants through --effort. Its accepted
    // values are narrower than the engine-agnostic EffortLevel union: only
    // low|medium|high are valid. Preserve the caller's intent by clamping the
    // two higher aliases to agy's ceiling. A per-turn override wins over the
    // session default, matching session_send's documented contract.
    //
    // Current agy also requires an effort when --model is an unsuffixed base
    // slug, so the provider-specific meaning of auto is high in that case. A
    // fully-qualified `-low|-medium|-high` slug already carries its effort and
    // needs no flag. If a caller overrides such a slug to a different effort,
    // strip the suffix first: agy rejects conflicting --model/--effort pairs.
    const configuredModel = this.options.resolvedModel || this.options.model;
    let model = configuredModel ? this.resolveModel(configuredModel.replace(/^agy\//, '')) : undefined;
    const requestedEffort = turnEffort ?? this.options.effort;
    const explicitEffort =
      requestedEffort === 'max' || requestedEffort === 'xhigh'
        ? 'high'
        : requestedEffort === 'auto'
          ? undefined
          : requestedEffort;
    const modelEffortMatch = model?.match(/-(low|medium|high)$/);
    if (model && modelEffortMatch && explicitEffort && modelEffortMatch[1] !== explicitEffort) {
      model = model.slice(0, -modelEffortMatch[0].length);
    }
    const effort = explicitEffort ?? (model && !modelEffortMatch ? 'high' : undefined);

    if (model) args.push('--model', model);
    if (effort) args.push('--effort', effort);

    if (this.agyConversationId) args.push('--conversation', this.agyConversationId);

    // agy enforces its own print-mode timeout (default 5m). Derive it from the
    // send timeout (+5s margin) so our timer, not agy's, decides the outcome.
    args.push('--print-timeout', `${Math.ceil(timeoutMs / 1000) + 5}s`);

    return args;
  }

  /**
   * Harvest the conversation ID from the agy log file. New conversations log
   * `Created conversation <uuid>`; resumed ones only log lookups, so an
   * existing ID is never overwritten by a miss.
   */
  private _harvestConversationId(): void {
    // Once harvested (or seeded) the ID is final for the life of the session
    // — skip the synchronous whole-log re-read on every later turn.
    if (this.agyConversationId) return;
    try {
      const log = fs.readFileSync(this._logFile, 'utf8');
      this.agyConversationId = extractCreatedAgyConversationId(log);
    } catch {
      // Log file missing — agy failed before logging anything
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

  protected _run(message: string, options: SessionSendOptions): Promise<TurnResult> {
    const timeout = options.timeout || 300_000;
    const args = this._buildArgs(message, timeout, options.effort);

    return new Promise<TurnResult>((resolve, reject) => {
      let resultText = '';
      let stderr = '';
      let settled = false;
      let turnUsage: AgyUsage | undefined;
      let turnStatus: string | undefined;
      // agy reports a rejected invocation (bad model/effort pair, unknown slug)
      // as a stream-json result event carrying `error`, and prints nothing on
      // stderr. Without capturing it the caller only ever saw "Antigravity
      // exited with code 1" — agy's own message names the valid values.
      let turnError: string | undefined;

      const proc = spawn(this.engineBin, args, {
        cwd: this.options.cwd,
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      this.currentProc = proc;

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          proc.kill('SIGTERM');
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
        if (evt.event === 'init' && evt.conversation_id && !this.agyConversationId) {
          this.agyConversationId = evt.conversation_id;
        }
        if (evt.event === 'result' && evt.result) {
          const r = evt.result;
          if (r.conversation_id && !this.agyConversationId) this.agyConversationId = r.conversation_id;
          if (typeof r.response === 'string') {
            resultText = r.response;
            try {
              options.callbacks?.onText?.(r.response);
            } catch {
              /* user callback */
            }
            this.emit(SESSION_EVENT.TEXT, r.response);
          }
          if (r.usage) turnUsage = r.usage;
          // Only a non-SUCCESS status is recorded, and it is sticky on purpose: a later
          // SUCCESS in the same turn must not erase a failure agy already reported.
          if (r.status && r.status !== 'SUCCESS') turnStatus = r.status;
          if (typeof r.error === 'string' && r.error.trim()) turnError = sanitizeSecrets(r.error.trim());
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

        // Harvest BEFORE the settled check: a turn that hit the wrapper timeout
        // has already rejected (settled), but agy may still have announced the
        // conversation before being killed. Skipping this would lose the id
        // permanently and every later send would silently start fresh. The
        // stream normally supplies it from the `init` event; this is the
        // fallback for a turn that died before emitting one.
        this._harvestConversationId();

        if (settled) return;
        settled = true;

        // One expression for the outcome: it feeds the counter here and the `stop_reason`
        // below, and it is the reject condition at the end of this handler. The exit code
        // stays in the conjunction — agy can report SUCCESS and then die in cleanup, and a
        // turn whose promise rejects is not a turn that succeeded.
        const ok = !turnError && !turnStatus && code === 0;
        this._recordTurnComplete(ok);

        const text = resultText.replace(/\n$/, '');

        // Real usage from the `result` event. estimateTokens() is the fallback
        // for a turn that produced no result event (killed, crashed, or an
        // output-format change) — it is a ~4-chars-per-token guess and was the
        // only source before agy grew a structured output mode, which is why
        // this engine's cost figures used to be approximate.
        if (turnUsage) {
          this._stats.tokensIn += turnUsage.input_tokens ?? 0;
          this._stats.tokensOut += turnUsage.output_tokens ?? 0;
          this._stats.cachedTokens += turnUsage.cache_read_tokens ?? 0;
          this._updateCost();
        } else if (text.length > 0 || code === 0) {
          this._stats.tokensIn += estimateTokens(message);
          this._stats.tokensOut += estimateTokens(text);
          this._markTurnEstimated();
          this._updateCost();
        }

        this._addHistory({ text, code });

        const event: StreamEvent = {
          type: 'result',
          result: text,
          // agy can exit 0 while reporting a non-SUCCESS status or an error in the
          // result event (e.g. a turn stopped early), so the status is
          // authoritative when present and the exit code is the fallback.
          stop_reason: ok ? 'end_turn' : 'error',
        };

        this.emit(SESSION_EVENT.RESULT, event);
        this.emit(SESSION_EVENT.TURN_COMPLETE, event);

        // A captured result error means the turn failed even when agy exits 0,
        // so surface it rather than resolving an empty string as a reply.
        if (turnError) {
          reject(new Error(turnError));
        } else if (code !== 0) {
          reject(new Error(stderr || `Antigravity exited with code ${code}`));
        } else {
          resolve({ text, event });
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

  /** Clean up the per-session log file along with the base teardown. */
  stop(): void {
    super.stop();
    try {
      fs.unlinkSync(this._logFile);
    } catch {
      // Never created, or already gone
    }
  }

  /** Override getStats to expose the captured conversation ID. */
  getStats(): ReturnType<BaseOneShotSession['getStats']> {
    const base = super.getStats();
    return { ...base, agyConversationId: this.agyConversationId };
  }
}
