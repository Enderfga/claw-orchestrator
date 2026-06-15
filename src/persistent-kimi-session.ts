/**
 * Persistent Kimi Session — wraps Moonshot `kimi` CLI
 *
 * Kimi CLI is one-shot per send (like Gemini/Codex): each message spawns a
 * fresh `kimi -p <msg> --output-format stream-json` process. The working
 * directory carries accumulated code changes across sends, and stats/history
 * are tracked continuously by this session wrapper.
 *
 * Note: Kimi does not allow combining `--prompt` with `--yolo` or `--auto`.
 * Permission handling is delegated to the user's Kimi configuration
 * (`~/.kimi-code/config.toml`). The `--output-format stream-json` protocol
 * emits JSON lines with roles: assistant, tool, and meta.
 */

import { spawnEngine } from './engine-spawn.js';
import * as readline from 'node:readline';

import type { SessionConfig, SessionSendOptions, StreamEvent, TurnResult } from './types.js';
import { estimateTokens } from './models.js';
import { SESSION_EVENT } from './constants.js';
import { BaseOneShotSession } from './base-oneshot-session.js';

// ─── PersistentKimiSession ──────────────────────────────────────────────────

export class PersistentKimiSession extends BaseOneShotSession {
  private _currentRl: readline.Interface | null = null;

  constructor(config: SessionConfig, kimiBin?: string) {
    super(config, kimiBin || process.env.KIMI_BIN || 'kimi', {
      enginePrefix: 'kimi',
      defaultModel: 'kimi-code/kimi-for-coding',
      supportsCachedTokens: false,
      engineDisplayName: 'Kimi',
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

  // Windows command-line length limit is ~32767 chars. Keep a safe margin so
  // the full `kimi -p "..." --output-format stream-json` invocation fits.
  private static readonly MAX_PROMPT_CHARS = 20_000;

  protected _run(message: string, options: SessionSendOptions): Promise<TurnResult> {
    let prompt = message;
    if (prompt.length > PersistentKimiSession.MAX_PROMPT_CHARS) {
      this.emit(
        SESSION_EVENT.LOG,
        `[kimi] Prompt truncated from ${prompt.length} to ${PersistentKimiSession.MAX_PROMPT_CHARS} chars to avoid Windows command-line limit`,
      );
      prompt = prompt.slice(0, PersistentKimiSession.MAX_PROMPT_CHARS) + '\n\n[truncated]';
    }

    const args: string[] = ['-p', prompt, '--output-format', 'stream-json'];

    // Resolve aliases (e.g. "kimi-k2") to the canonical id the CLI expects.
    if (this.options.model) args.push('--model', this.resolveModel(this.options.model));

    const timeout = options.timeout || 300_000;

    return new Promise<TurnResult>((resolve, reject) => {
      const resultText = { value: '' };
      const streamError = { value: null as string | null };
      let stderr = '';
      let settled = false;

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
          reject(new Error('Timeout waiting for Kimi response'));
        }
      }, timeout);

      // Parse stream-json output line by line
      const rl = readline.createInterface({ input: proc.stdout!, crlfDelay: Infinity });
      this._currentRl = rl;
      rl.on('line', (line: string) => {
        if (!line.trim()) return;
        try {
          const event = JSON.parse(line) as Record<string, unknown>;
          this._handleStreamEvent(event, options, resultText, streamError);
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
          .replace(/KIMI_API_KEY=[^\s]+/g, 'KIMI_API_KEY=***')
          .replace(/MOONSHOT_API_KEY=[^\s]+/g, 'MOONSHOT_API_KEY=***')
          .replace(/Bearer\s+[A-Za-z0-9._\-+/=]+/gi, 'Bearer ***');
        stderr += sanitized;
        this.emit(SESSION_EVENT.LOG, `[kimi-stderr] ${sanitized}`);
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

        // Kimi does not emit usage events; estimate tokens from text length
        if (resultText.value.length > 0) {
          this._stats.tokensIn += estimateTokens(message);
          this._stats.tokensOut += estimateTokens(resultText.value);
          this._updateCost();
        }

        this._addHistory({ text: resultText.value, code });

        const stopReason = code === 0 && !streamError.value ? 'end_turn' : 'error';

        const event: StreamEvent = {
          type: 'result',
          result: resultText.value,
          stop_reason: stopReason,
        };

        this.emit(SESSION_EVENT.RESULT, event);
        this.emit(SESSION_EVENT.TURN_COMPLETE, event);

        if (code !== 0) {
          reject(new Error(stderr || `Kimi exited with code ${code}`));
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
    streamError: { value: string | null },
  ): void {
    const role = event.role as string;

    switch (role) {
      case 'assistant': {
        // Tool calls are emitted separately; collect them for stats but not text
        if (Array.isArray(event.tool_calls)) {
          for (const tool of event.tool_calls as Array<Record<string, unknown>>) {
            this._stats.toolCalls++;
            try {
              options.callbacks?.onToolUse?.(tool);
            } catch {
              // User callback error
            }
            this.emit(SESSION_EVENT.TOOL_USE, tool);
          }
        }
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

      case 'tool': {
        if (event.is_error === true || event.status === 'error' || event.error) {
          this._stats.toolErrors++;
        }
        try {
          options.callbacks?.onToolResult?.(event);
        } catch {
          // User callback error
        }
        this.emit(SESSION_EVENT.TOOL_RESULT, event);
        break;
      }

      case 'meta':
        // Session resume hints and other metadata — log but do not collect as output
        this.emit(SESSION_EVENT.LOG, `[kimi-meta] ${JSON.stringify(event)}`);
        break;

      case 'error': {
        // Surface the error so the turn is not reported as a clean success.
        const detail = String(event.error || JSON.stringify(event));
        streamError.value = detail;
        this.emit(SESSION_EVENT.LOG, `[kimi-error] ${detail}`);
        break;
      }

      default:
        break;
    }
  }
}
