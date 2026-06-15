/**
 * Persistent Gemini Session — wraps Google `gemini` CLI
 *
 * Like Codex, each send() spawns a new `gemini` process. Unlike Codex,
 * Gemini CLI supports `--output-format stream-json` which provides real
 * token usage data and structured tool call events instead of raw text.
 *
 * The "session" is persistent in the same sense as Codex:
 *   - Working directory carries accumulated code changes across sends
 *   - Stats, history, and cost are tracked continuously
 *   - Consistent lifecycle semantics (start/stop/pause/resume)
 */

import { spawnEngine } from './engine-spawn.js';
import * as readline from 'node:readline';

import type { SessionConfig, SessionSendOptions, StreamEvent, TurnResult } from './types.js';
import { estimateTokens } from './models.js';
import { SESSION_EVENT } from './constants.js';
import { BaseOneShotSession } from './base-oneshot-session.js';

// ─── PersistentGeminiSession ────────────────────────────────────────────────

export class PersistentGeminiSession extends BaseOneShotSession {
  private _currentRl: readline.Interface | null = null;

  constructor(config: SessionConfig, geminiBin?: string) {
    super(config, geminiBin || process.env.GEMINI_BIN || 'gemini', {
      enginePrefix: 'gemini',
      defaultModel: 'gemini-2.5-pro',
      supportsCachedTokens: true,
      engineDisplayName: 'Gemini',
    });
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

  protected _run(message: string, options: SessionSendOptions): Promise<TurnResult> {
    const args: string[] = ['-p', message, '--output-format', 'stream-json'];

    // Permission mode
    if (this.options.permissionMode === 'bypassPermissions' || this.options.dangerouslySkipPermissions) {
      args.push('--yolo');
    } else if (this.options.permissionMode === 'default') {
      args.push('--sandbox');
    }

    if (this.options.model) args.push('--model', this.resolveModel(this.options.model));

    const timeout = options.timeout || 300_000;

    return new Promise<TurnResult>((resolve, reject) => {
      const resultText = { value: '' };
      let stderr = '';
      let settled = false;
      let gotUsageFromEvents = false;

      const proc = spawnEngine(this.engineBin, args, {
        cwd: this.options.cwd,
        env: { ...process.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.currentProc = proc;

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          proc.kill('SIGTERM');
          reject(new Error('Timeout waiting for Gemini response'));
        }
      }, timeout);

      // Parse stream-json output line by line
      const rl = readline.createInterface({ input: proc.stdout!, crlfDelay: Infinity });
      this._currentRl = rl;
      rl.on('line', (line: string) => {
        if (!line.trim()) return;
        try {
          const event = JSON.parse(line) as Record<string, unknown>;
          this._handleStreamEvent(event, options, resultText, () => {
            gotUsageFromEvents = true;
          });
        } catch {
          // Non-JSON line — treat as plain text
          resultText.value += line + '\n';
          try {
            options.callbacks?.onText?.(line + '\n');
          } catch {
            // User callback error
          }
          this.emit(SESSION_EVENT.TEXT, line + '\n');
        }
      });

      proc.stderr?.on('data', (data: Buffer) => {
        const sanitized = data
          .toString()
          .replace(/GEMINI_API_KEY=[^\s]+/g, 'GEMINI_API_KEY=***')
          .replace(/Bearer [a-zA-Z0-9_-]+/g, 'Bearer ***');
        stderr += sanitized;
        this.emit(SESSION_EVENT.LOG, `[gemini-stderr] ${sanitized}`);
      });

      proc.on('close', (code) => {
        clearTimeout(timer);
        this.currentProc = null;
        if (this._currentRl) {
          this._currentRl.close();
          this._currentRl = null;
        }

        if (settled) return;
        settled = true;

        this._recordTurnComplete();

        // Fallback: estimate tokens if stream events didn't provide usage
        if (!gotUsageFromEvents && resultText.value.length > 0) {
          this._stats.tokensIn += estimateTokens(message);
          this._stats.tokensOut += estimateTokens(resultText.value);
          this._updateCost();
        }

        this._addHistory({ text: resultText.value, code });

        // Gemini exit codes: 0=success, 53=turn limit, 1=error, 42=input error
        let stopReason = 'end_turn';
        if (code === 53) stopReason = 'turn_limit';
        else if (code !== 0) stopReason = 'error';

        const event: StreamEvent = {
          type: 'result',
          result: resultText.value,
          stop_reason: stopReason,
        };

        this.emit(SESSION_EVENT.RESULT, event);
        this.emit(SESSION_EVENT.TURN_COMPLETE, event);

        // Exit code 53 = turn limit — a valid completion, not an error
        if (code !== 0 && code !== 53) {
          reject(new Error(stderr || `Gemini exited with code ${code}`));
        } else {
          resolve({ text: resultText.value, event });
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

  private _handleStreamEvent(
    event: Record<string, unknown>,
    options: SessionSendOptions,
    resultText: { value: string },
    markUsageReceived: () => void,
  ): void {
    const type = event.type as string;

    switch (type) {
      case 'message': {
        // Skip user messages (prompt echo) — only collect assistant responses
        if (event.role === 'user') break;
        const text = (event.content as string) || '';
        if (text) {
          resultText.value += text;
          try {
            options.callbacks?.onText?.(text);
          } catch {
            // User callback error
          }
          this.emit(SESSION_EVENT.TEXT, text);
        }
        break;
      }

      case 'tool_use':
        this._stats.toolCalls++;
        try {
          options.callbacks?.onToolUse?.(event);
        } catch {
          // User callback error
        }
        this.emit(SESSION_EVENT.TOOL_USE, event);
        break;

      case 'tool_result':
        try {
          options.callbacks?.onToolResult?.(event);
        } catch {
          // User callback error
        }
        if (event.is_error) this._stats.toolErrors++;
        this.emit(SESSION_EVENT.TOOL_RESULT, event);
        break;

      case 'result': {
        const usage = event.usage as Record<string, number> | undefined;
        if (usage) {
          this._stats.tokensIn += usage.input_tokens || usage.inputTokens || usage.prompt_tokens || 0;
          this._stats.tokensOut += usage.output_tokens || usage.outputTokens || usage.completion_tokens || 0;
          if (usage.cached_tokens) this._stats.cachedTokens += usage.cached_tokens;
          this._updateCost();
          markUsageReceived();
        }
        const content = event.content as string | undefined;
        if (content) resultText.value += content;
        break;
      }

      case 'error':
        this.emit(SESSION_EVENT.LOG, `[gemini-error] ${event.error || JSON.stringify(event)}`);
        break;

      default:
        break;
    }
  }
}
