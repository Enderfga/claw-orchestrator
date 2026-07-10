/**
 * Persistent Antigravity Session — wraps Google `agy` CLI (Antigravity CLI)
 *
 * Antigravity CLI is Google's successor to Gemini CLI (consumer tiers of
 * Gemini CLI stopped serving 2026-06-18). Like Codex/Gemini, each send()
 * spawns a new `agy` process in print mode.
 *
 * agy (verified against 1.0.16) has NO structured output mode — stdout is
 * the plain response text. Two behaviors make this a real engine rather
 * than a custom-engine recipe:
 *
 *   - Conversation continuity: agy logs `Created conversation <uuid>` to
 *     its log file. We pass a private --log-file per session, harvest the
 *     ID after the first send, and pass `--conversation <id>` on subsequent
 *     sends — true multi-turn context, like Codex thread resume.
 *   - Timeout coherence: agy enforces its own --print-timeout (default 5m);
 *     we derive it from the send timeout so the two never disagree.
 *
 * Token usage is estimated (~4 chars/token) since agy emits no usage data.
 * Unknown --model values do not error — agy silently falls back to its
 * default model (verified empirically on 1.0.16).
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { SessionConfig, SessionSendOptions, StreamEvent, TurnResult } from './types.js';
import { estimateTokens } from './models.js';
import { sanitizeSecrets } from './sanitize.js';
import { extractCreatedAgyConversationId, isAgyConversationId } from './agy-conversation.js';
import { SESSION_EVENT } from './constants.js';
import { BaseOneShotSession } from './base-oneshot-session.js';

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
   * First turn:    `agy -p <msg> --log-file <tmp> [--sandbox|--dangerously-skip-permissions] [--model M] --print-timeout Ns`
   * Resume turns:  same + `--conversation <id>`
   */
  private _buildArgs(message: string, timeoutMs: number): string[] {
    const args: string[] = ['-p', message, '--log-file', this._logFile];

    // Permission mode. agy has no fine-grained permission flags (verified on
    // 1.0.16): bypass maps to --dangerously-skip-permissions, `default` maps
    // to --sandbox (terminal-restricted). Other modes run agy's own default
    // approval behavior — which blocks on unapproved tools in print mode, so
    // bypassPermissions (the SessionConfig default) is the practical choice
    // for headless work.
    if (this.options.permissionMode === 'bypassPermissions' || this.options.dangerouslySkipPermissions) {
      args.push('--dangerously-skip-permissions');
    } else if (this.options.permissionMode === 'default') {
      args.push('--sandbox');
    }

    // Use the SessionManager-resolved model when available so documented
    // aliases (agy-pro → gemini-3.1-pro) do not silently fall back to agy's
    // default model.
    const configuredModel = this.options.resolvedModel || this.options.model;
    const model = configuredModel ? this.resolveModel(configuredModel.replace(/^agy\//, '')) : undefined;
    if (model) args.push('--model', model);
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
    const args = this._buildArgs(message, timeout);

    return new Promise<TurnResult>((resolve, reject) => {
      let resultText = '';
      let stderr = '';
      let settled = false;

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

      // Plain-text stdout — forward chunks as streaming text
      proc.stdout?.on('data', (data: Buffer) => {
        const chunk = data.toString();
        resultText += chunk;
        try {
          options.callbacks?.onText?.(chunk);
        } catch {
          // User callback error
        }
        this.emit(SESSION_EVENT.TEXT, chunk);
      });

      proc.stderr?.on('data', (data: Buffer) => {
        const sanitized = sanitizeSecrets(data.toString());
        stderr += sanitized;
        this.emit(SESSION_EVENT.LOG, `[agy-stderr] ${sanitized}`);
      });

      proc.on('close', (code) => {
        clearTimeout(timer);
        this.currentProc = null;

        // Harvest BEFORE the settled check: a turn that hit the wrapper
        // timeout has already rejected (settled), but agy may still have
        // logged `Created conversation <uuid>` before being killed. Skipping
        // the harvest here would lose the ID permanently and every later
        // send would silently start a fresh conversation.
        this._harvestConversationId();

        if (settled) return;
        settled = true;

        this._recordTurnComplete();

        const text = resultText.replace(/\n$/, '');

        // No usage events exist in agy — always estimate
        if (text.length > 0 || code === 0) {
          this._stats.tokensIn += estimateTokens(message);
          this._stats.tokensOut += estimateTokens(text);
          this._updateCost();
        }

        this._addHistory({ text, code });

        const event: StreamEvent = {
          type: 'result',
          result: text,
          stop_reason: code === 0 ? 'end_turn' : 'error',
        };

        this.emit(SESSION_EVENT.RESULT, event);
        this.emit(SESSION_EVENT.TURN_COMPLETE, event);

        if (code !== 0) {
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
