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

import { spawn } from 'node:child_process';
import * as readline from 'node:readline';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { SessionConfig, SessionSendOptions, StreamEvent, TurnResult } from './types.js';
import { estimateTokens } from './models.js';
import { sanitizeSecrets } from './sanitize.js';
import { SESSION_EVENT } from './constants.js';
import { BaseOneShotSession } from './base-oneshot-session.js';

/**
 * Admin policy that makes `--approval-mode plan` actually binding.
 *
 * Plan mode on its own is model-cooperative: the agent can call the built-in
 * `exit_plan_mode` tool and walk straight out of read-only into write mode. In
 * Gemini's policy engine, admin policies sit at the top tier ("Admin policies
 * always override User, Workspace, and Default policies") and a model cannot
 * override an admin `deny` — so denying the escape hatch (plus the write tools,
 * belt-and-braces) is what turns "read-only" from a request into a guarantee.
 */
const READ_ONLY_ADMIN_POLICY = [
  '[[rule]]',
  'toolName = "exit_plan_mode"',
  'decision = "deny"',
  'priority = 999',
  'denyMessage = "read-only session: leaving plan mode is not permitted"',
  '',
  '[[rule]]',
  'toolName = ["write_file", "replace"]',
  'decision = "deny"',
  'priority = 999',
  'denyMessage = "read-only session: file writes are not permitted"',
  '',
].join('\n');

// ─── PersistentGeminiSession ────────────────────────────────────────────────

export class PersistentGeminiSession extends BaseOneShotSession {
  private _currentRl: readline.Interface | null = null;
  /** Written lazily on first read-only send; removed in _cleanupProc (stop()). */
  private _policyFilePath?: string;

  constructor(config: SessionConfig, geminiBin?: string) {
    super(config, geminiBin || process.env.GEMINI_BIN || 'gemini', {
      enginePrefix: 'gemini',
      defaultModel: 'gemini-2.5-pro',
      supportsCachedTokens: true,
      engineDisplayName: 'Gemini',
    });
  }

  /** Materialize the read-only admin policy once and return its path. */
  private _ensurePolicyFile(): string {
    if (this._policyFilePath) return this._policyFilePath;
    const file = path.join(os.tmpdir(), `claw-gemini-readonly-${this.sessionId}.toml`);
    fs.writeFileSync(file, READ_ONLY_ADMIN_POLICY, 'utf8');
    this._policyFilePath = file;
    return file;
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
    if (this._policyFilePath) {
      try {
        fs.unlinkSync(this._policyFilePath);
      } catch {
        // Never written / already gone.
      }
      this._policyFilePath = undefined;
    }
    super._cleanupProc();
  }

  protected _run(message: string, options: SessionSendOptions): Promise<TurnResult> {
    // `--skip-trust` bypasses the "trusted folders" gate introduced in Gemini
    // CLI 0.43 — without it, headless runs in worktrees / arbitrary cwds abort
    // with "not running in a trusted directory" before producing any output.
    const args: string[] = ['-p', message, '--output-format', 'stream-json', '--skip-trust'];

    // Permission mode. Autoloop Planner uses the shared read-only sandbox hint,
    // which Gemini exposes as approval-mode=plan — but plan mode alone is
    // escapable via the model's own `exit_plan_mode` tool, so we also pin an
    // admin policy that denies it (admin tier cannot be overridden by the model).
    if (this.options.sandboxMode === 'read-only') {
      args.push('--approval-mode', 'plan', '--admin-policy', this._ensurePolicyFile());
    } else if (this.options.permissionMode === 'bypassPermissions' || this.options.dangerouslySkipPermissions) {
      args.push('--yolo');
    } else if (this.options.permissionMode === 'default' || this.options.permissionMode === 'manual') {
      args.push('--sandbox');
    }

    if (this.options.model) args.push('--model', this.options.model);

    const timeout = options.timeout || 300_000;

    return new Promise<TurnResult>((resolve, reject) => {
      const resultText = { value: '' };
      let stderr = '';
      let settled = false;
      let gotUsageFromEvents = false;

      const proc = spawn(this.engineBin, args, {
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
        const sanitized = sanitizeSecrets(data.toString());
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
