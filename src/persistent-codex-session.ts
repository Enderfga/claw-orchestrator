/**
 * Persistent Codex Session — wraps OpenAI `codex` CLI
 *
 * Unlike Claude Code, Codex does not maintain a persistent subprocess with
 * streaming JSON I/O.  Each send() spawns a new `codex` process in
 * `--sandbox workspace-write` mode (the modern replacement for the deprecated
 * `--full-auto` flag) with `--json` to get line-delimited JSON events.
 *
 * The "session" is persistent in the sense that:
 *   - Working directory (cwd) carries accumulated code changes across sends
 *   - Stats, history, and cost are tracked continuously
 *   - The `thread_id` from the first send is captured and reused via
 *     `codex exec resume <id>` for subsequent sends, giving the model real
 *     conversation continuity (Codex 0.119+).
 */

import { spawnEngine } from './engine-spawn.js';

import type { SessionConfig, SessionSendOptions, StreamEvent, TurnResult } from './types.js';
import { SESSION_EVENT } from './constants.js';
import { BaseOneShotSession } from './base-oneshot-session.js';

// ─── Codex JSON event shapes (subset we consume) ────────────────────────────
//
// Captured from `codex exec --json` against Codex CLI 0.128. These are the
// only types we parse; anything else falls through to the log channel.

interface CodexThreadStarted {
  type: 'thread.started';
  thread_id: string;
}
interface CodexItemCompleted {
  type: 'item.completed';
  item: { id?: string; type?: string; text?: string };
}
interface CodexTurnCompleted {
  type: 'turn.completed';
  usage?: {
    input_tokens?: number;
    cached_input_tokens?: number;
    output_tokens?: number;
    reasoning_output_tokens?: number;
  };
}

// ─── PersistentCodexSession ─────────────────────────────────────────────────

export class PersistentCodexSession extends BaseOneShotSession {
  /**
   * Captured from the first `thread.started` event. Each subsequent send()
   * issues `codex exec resume <id>` so the model sees prior turns.
   */
  private codexThreadId?: string;

  constructor(config: SessionConfig, codexBin?: string) {
    super(config, codexBin || process.env.CODEX_BIN || 'codex', {
      enginePrefix: 'codex',
      defaultModel: 'gpt-5.5',
      supportsCachedTokens: true,
      engineDisplayName: 'Codex',
    });
  }

  /** Expose the captured thread ID for the codex_resume tool and stats overlay. */
  get threadId(): string | undefined {
    return this.codexThreadId;
  }

  /**
   * Build the Codex spawn args for this turn.
   *
   * First turn:    `codex exec [--sandbox W] --skip-git-repo-check --json --model M -C cwd <msg>`
   * Resume turns:  `codex exec resume <thread_id> [--sandbox W] --skip-git-repo-check --json --model M -C cwd <msg>`
   */
  private _buildArgs(message: string): string[] {
    const args: string[] = ['exec'];
    const isResume = !!this.codexThreadId;
    if (isResume) {
      // `codex exec resume` rejects --sandbox and -C; the sandbox policy and
      // cwd are inherited from the original session (verified empirically
      // against codex 0.128.0 — passing --sandbox here errors with
      // "unexpected argument").
      args.push('resume', this.codexThreadId!, '--skip-git-repo-check', '--json');
    } else {
      const sandbox = this.options.sandboxMode || 'workspace-write';
      args.push('--sandbox', sandbox, '--skip-git-repo-check', '--json');
      if (this.options.cwd) args.push('-C', this.options.cwd);
    }
    if (this.options.model) args.push('--model', this.resolveModel(this.options.model));
    args.push(message);
    return args;
  }

  protected _run(message: string, options: SessionSendOptions): Promise<TurnResult> {
    const args = this._buildArgs(message);
    const timeout = options.timeout || 300_000;

    return new Promise<TurnResult>((resolve, reject) => {
      let stdoutBuf = '';
      let stderr = '';
      let assistantText = '';
      let lastUsage: CodexTurnCompleted['usage'] | undefined;
      let settled = false;

      const proc = spawnEngine(this.engineBin, args, {
        cwd: this.options.cwd,
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      this.currentProc = proc;

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          proc.kill('SIGTERM');
          reject(new Error('Timeout waiting for Codex response'));
        }
      }, timeout);

      const handleEvent = (line: string) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let event: unknown;
        try {
          event = JSON.parse(trimmed);
        } catch {
          // Not JSON — log it (could be a stray Codex banner or warning).
          this.emit(SESSION_EVENT.LOG, `[codex-stdout] ${trimmed}`);
          return;
        }
        const ev = event as { type?: string };
        switch (ev.type) {
          case 'thread.started': {
            const t = event as CodexThreadStarted;
            if (t.thread_id && !this.codexThreadId) {
              this.codexThreadId = t.thread_id;
            }
            break;
          }
          case 'item.completed': {
            const it = event as CodexItemCompleted;
            if (it.item?.type === 'agent_message' && typeof it.item.text === 'string') {
              const chunk = it.item.text;
              assistantText += chunk;
              try {
                options.callbacks?.onText?.(chunk);
              } catch {
                // User callback errors are not fatal.
              }
              this.emit(SESSION_EVENT.TEXT, chunk);
            } else {
              // Tool-call items (command, apply_patch, mcp_tool_call) — surface as tool events.
              try {
                options.callbacks?.onToolUse?.(event);
              } catch {
                // Same swallow rule.
              }
              this.emit(SESSION_EVENT.LOG, `[codex-tool] ${trimmed}`);
            }
            break;
          }
          case 'turn.completed': {
            const tc = event as CodexTurnCompleted;
            if (tc.usage) lastUsage = tc.usage;
            break;
          }
          default:
            // Unhandled event types still go to the log so users can debug.
            this.emit(SESSION_EVENT.LOG, `[codex-event] ${trimmed}`);
        }
      };

      proc.stdout?.on('data', (data: Buffer) => {
        stdoutBuf += data.toString();
        let nl: number;
        while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
          const line = stdoutBuf.slice(0, nl);
          stdoutBuf = stdoutBuf.slice(nl + 1);
          handleEvent(line);
        }
      });

      proc.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString();
        this.emit(SESSION_EVENT.LOG, `[codex-stderr] ${data.toString()}`);
      });

      proc.on('close', (code) => {
        clearTimeout(timer);
        this.currentProc = null;

        if (settled) return;
        settled = true;

        // Drain any final partial line as an event attempt.
        if (stdoutBuf.trim()) handleEvent(stdoutBuf);

        this._recordTurnComplete();

        // Real usage from `turn.completed`. Falls back to zero rather than
        // estimated tokens — better to have an honest "0" than a guess that
        // misleads cost reporting.
        if (lastUsage) {
          this._stats.tokensIn += lastUsage.input_tokens ?? 0;
          this._stats.tokensOut += (lastUsage.output_tokens ?? 0) + (lastUsage.reasoning_output_tokens ?? 0);
          this._stats.cachedTokens += lastUsage.cached_input_tokens ?? 0;
        }
        this._updateCost();
        this._addHistory({ text: assistantText, code });

        const event: StreamEvent = {
          type: 'result',
          result: assistantText,
          stop_reason: code === 0 ? 'end_turn' : 'error',
          session_id: this.codexThreadId,
        };

        this.emit(SESSION_EVENT.RESULT, event);
        this.emit(SESSION_EVENT.TURN_COMPLETE, event);

        if (code !== 0) {
          reject(new Error(stderr || `Codex exited with code ${code}`));
        } else {
          resolve({ text: assistantText, event });
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

  /** Override getStats to expose the captured thread ID. */
  getStats(): ReturnType<BaseOneShotSession['getStats']> {
    const base = super.getStats();
    return { ...base, codexThreadId: this.codexThreadId };
  }
}
