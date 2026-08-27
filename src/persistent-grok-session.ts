/**
 * Grok Build (xAI) session wrapper.
 *
 * One-shot per send: `grok -p <msg> --output-format json`, which prints a single
 * JSON object and exits. That object is unusually complete for this engine class
 * — it carries the reply, a terminal `stopReason`, a resumable `sessionId`, real
 * token usage, the model that actually answered, and the engine's own
 * `total_cost_usd`.
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

import { spawn } from 'node:child_process';

import type { SessionConfig, SessionSendOptions, StreamEvent, TurnResult } from './types.js';
import { sanitizeSecrets } from './sanitize.js';
import { BaseOneShotSession } from './base-oneshot-session.js';
import { SESSION_EVENT } from './constants.js';

/** The shape `--output-format json` prints. Only the fields we consume. */
interface GrokJsonResult {
  text?: string;
  stopReason?: string;
  sessionId?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  total_cost_usd?: number;
  modelUsage?: Record<string, unknown>;
  error?: string;
}

export class PersistentGrokSession extends BaseOneShotSession {
  /** Grok's own session UUID, captured from turn 1 and replayed via `--resume`. */
  private grokSessionId?: string;

  constructor(config: SessionConfig, grokBin?: string) {
    super(config, grokBin || process.env.GROK_BIN || 'grok', {
      enginePrefix: 'grok',
      defaultModel: 'grok-4.6',
      defaultModelDisplay: 'grok-4.6',
      supportsCachedTokens: true,
      // grok reports `total_tokens` as input + output + cache reads + cache
      // writes (30034 = 19393 + 17 + 10624 + 0 on a resumed turn), and its own
      // `total_cost_usd` for that turn decomposes the same way: 19393 at the
      // full input rate plus 10624 at the cached rate. `input_tokens` therefore
      // excludes the cached reads and must not have them subtracted out.
      inputIncludesCachedTokens: false,
      engineDisplayName: 'Grok Build',
    });
    // Same shape cursor and opencode use: the real id is surfaced through
    // `sessionId` behind a `grok-live-` prefix so SessionManager can persist it,
    // and the prefix is stripped again on the way back in. A synthetic wrapper id
    // (`grok-<ts>-<rand>`) must never be handed to `--resume`.
    if (config.resumeSessionId && !/^grok-\d+-/.test(config.resumeSessionId)) {
      this.grokSessionId = config.resumeSessionId.replace(/^grok-live-/, '');
    }
  }

  private _buildArgs(message: string, options: SessionSendOptions): string[] {
    const args: string[] = ['-p', message, '--output-format', 'json'];

    if (this.options.cwd) args.push('--cwd', this.options.cwd);

    // Resume grok's own thread rather than starting fresh. `--continue` is
    // deliberately not used: it means "the most recent session for this cwd",
    // which collides between concurrent sessions on the same project.
    if (this.grokSessionId) args.push('--resume', this.grokSessionId);

    const model = this.options.resolvedModel || this.options.model;
    if (model) args.push('--model', this.resolveModel(model.replace(/^grok\//, '')));

    // grok's --permission-mode vocabulary is the same set as ours, so this is a
    // passthrough rather than a mapping. 'manual' is ours alone; grok calls the
    // equivalent 'default'.
    const mode = this.options.permissionMode === 'manual' ? 'default' : this.options.permissionMode;
    if (mode) args.push('--permission-mode', mode);

    const effort = options.effort ?? this.options.effort;
    if (effort && effort !== 'auto') {
      // grok 1.0.5 takes low|medium|high|xhigh — it names the invalid ones in
      // its own rejection message. Only the two levels above its ceiling clamp;
      // `xhigh` used to clamp too and was silently costing callers a tier.
      args.push('--effort', effort === 'max' || effort === 'ultra' ? 'xhigh' : effort);
    }

    if (this.options.maxTurns) args.push('--max-turns', String(this.options.maxTurns));
    if (this.options.systemPrompt) args.push('--system-prompt-override', this.options.systemPrompt);

    return args;
  }

  protected _run(message: string, options: SessionSendOptions): Promise<TurnResult> {
    // Read-only is refused rather than approximated. grok exposes --permission-mode
    // plan and --deny rules, but plan mode alone is model-cooperative — the same
    // shape that let an adversarial prompt write through Cursor's plan mode — and
    // the deny rules have not been put through the write × shell × subagent ×
    // resumed-turn matrix this project requires before a read-only claim. Failing
    // loudly beats a session that believes it cannot write and can.
    if (this.options.sandboxMode === 'read-only') {
      return Promise.reject(
        new Error(
          'Grok sessions do not support sandboxMode: read-only yet — its enforcement has not been ' +
            'adversarially verified, and this engine will not claim a boundary it has not proven. ' +
            'Use a different engine for read-only work.',
        ),
      );
    }

    const args = this._buildArgs(message, options);
    const timeout = options.timeout || 300_000;

    return new Promise<TurnResult>((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let settled = false;

      const proc = spawn(this.engineBin, args, {
        cwd: this.options.cwd,
        env: { ...process.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.currentProc = proc;
      proc.stdin?.end();

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          proc.kill('SIGKILL');
          reject(new Error('Timeout waiting for Grok response'));
        }
      }, timeout);

      proc.stdout?.on('data', (d: Buffer) => {
        stdout += d.toString();
      });

      proc.stderr?.on('data', (d: Buffer) => {
        const sanitized = sanitizeSecrets(d.toString());
        stderr += sanitized;
        this.emit(SESSION_EVENT.LOG, `[grok-stderr] ${sanitized}`);
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        this.currentProc = null;
        if (!settled) {
          settled = true;
          reject(err);
        }
      });

      proc.on('close', (code) => {
        clearTimeout(timer);
        this.currentProc = null;
        if (settled) return;
        settled = true;

        let parsed: GrokJsonResult | undefined;
        try {
          const trimmed = stdout.trim();
          if (trimmed) parsed = JSON.parse(trimmed) as GrokJsonResult;
        } catch {
          parsed = undefined;
        }

        // A turn that produced no parseable result object failed, whatever the
        // exit code says: there is no reply to hand back.
        const turnError =
          parsed?.error?.trim() ||
          (!parsed ? stderr.trim() || `Grok exited with code ${code} and no JSON result` : undefined);

        if (parsed?.sessionId) {
          this.grokSessionId = parsed.sessionId;
          if (!this.sessionId?.startsWith('grok-live-')) this.sessionId = `grok-live-${parsed.sessionId}`;
        }

        const text = parsed?.text ?? '';
        const ok = !turnError && code === 0 && parsed?.stopReason !== 'error';

        this._recordTurnComplete(ok);

        const usage = parsed?.usage;
        if (usage) {
          // Per-turn values (see the file header), so accumulate.
          const cacheRead = usage.cache_read_input_tokens ?? 0;
          const cacheWrite = usage.cache_creation_input_tokens ?? 0;
          this._stats.tokensIn += usage.input_tokens ?? 0;
          this._stats.tokensOut += usage.output_tokens ?? 0;
          this._stats.cachedTokens += cacheRead;
          this._stats.cacheCreationTokens += cacheWrite;
          // The prompt is every input-side token, not just the uncached
          // remainder: on a resumed turn `input_tokens` is the small tail and
          // the cached reads are most of the context that has to fit.
          this._reportTurnInputTokens((usage.input_tokens ?? 0) + cacheRead + cacheWrite);
        }
        // Engine-reported spend, not a registry lookup — see the file header.
        if (typeof parsed?.total_cost_usd === 'number' && Number.isFinite(parsed.total_cost_usd)) {
          this._stats.costUsd += parsed.total_cost_usd;
        }

        this._addHistory({ text, code });

        if (text) {
          try {
            options.callbacks?.onText?.(text);
          } catch {
            /* user callback */
          }
          this.emit(SESSION_EVENT.TEXT, text);
        }

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

  /** Grok's resumable session id, surfaced through getStats(). */
  getStats(): ReturnType<BaseOneShotSession['getStats']> & { grokSessionId?: string } {
    return { ...super.getStats(), grokSessionId: this.grokSessionId };
  }
}
