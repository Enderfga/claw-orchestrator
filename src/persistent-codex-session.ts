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

import { spawn } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
  item: { id?: string; type?: string; text?: string; exit_code?: number };
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
// Codex 0.13x surfaces turn-level failures as a top-level `error` event and/or
// a `turn.failed` event whose `error.message` carries the reason. Without
// handling these the process can exit 0 and we'd resolve an empty turn.
interface CodexTurnFailed {
  type: 'turn.failed';
  error?: { message?: string };
}
interface CodexError {
  type: 'error';
  message?: string;
}

// ─── PersistentCodexSession ─────────────────────────────────────────────────

export class PersistentCodexSession extends BaseOneShotSession {
  /**
   * Captured from the first `thread.started` event. Each subsequent send()
   * issues `codex exec resume <id>` so the model sees prior turns.
   */
  private codexThreadId?: string;

  /**
   * Path to a temp file holding the `jsonSchema` config, written lazily on
   * first use. Codex's `--output-schema` takes a file path (unlike Claude's
   * `--json-schema`, which takes the schema inline), so we materialize the
   * config string to disk once and reuse it across turns. Removed on stop().
   */
  private _schemaFilePath?: string;

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
    // Structured output: Codex 0.132+ accepts `--output-schema <FILE>` on both
    // `exec` and `exec resume`, enforcing the model's final response shape.
    // The engine-agnostic `jsonSchema` config is inline; Codex needs a path.
    const schemaPath = this._ensureSchemaFile();
    if (schemaPath) args.push('--output-schema', schemaPath);
    if (this.options.model) args.push('--model', this.options.model);
    args.push(...this._reasoningEffortArgs());
    // `--profile` is rejected by `codex exec resume` (like --sandbox/-C); the
    // resumed thread already carries the profile's config, so only pass it on
    // the first turn. (`-c` and `--model` ARE accepted on resume, verified
    // against `codex exec resume --help` on 0.137.)
    if (!isResume && this.options.codexProfile) args.push('--profile', this.options.codexProfile);
    args.push(message);
    return args;
  }

  /**
   * Map the engine-agnostic `effort` to Codex's reasoning-effort config override
   * (`-c model_reasoning_effort=<level>`). Codex accepts minimal|low|medium|high|xhigh;
   * we map `max`→`xhigh` (Codex has no `max`) and ignore `auto` / `ultracode`
   * (ultracode is a Claude-only setting). `-c` is a global override accepted on
   * both `exec` and `exec resume`.
   */
  private _reasoningEffortArgs(): string[] {
    const e = this.options.effort;
    if (!e || e === 'auto') return [];
    const map: Record<string, string> = { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'xhigh' };
    const level = map[e];
    return level ? ['-c', `model_reasoning_effort=${level}`] : [];
  }

  /**
   * Materialize the `jsonSchema` config to a temp file (once) and return its
   * path, or undefined when no schema is configured. The file is removed in
   * _cleanupProc() (i.e. on stop()).
   */
  private _ensureSchemaFile(): string | undefined {
    if (!this.options.jsonSchema) return undefined;
    if (this._schemaFilePath) return this._schemaFilePath;
    const path = join(tmpdir(), `claw-codex-schema-${this.sessionId}-${Date.now()}.json`);
    writeFileSync(path, this.options.jsonSchema, 'utf8');
    this._schemaFilePath = path;
    return path;
  }

  protected override _cleanupProc(): void {
    if (this._schemaFilePath) {
      try {
        unlinkSync(this._schemaFilePath);
      } catch {
        // Already gone / never written — nothing to clean.
      }
      this._schemaFilePath = undefined;
    }
    super._cleanupProc();
  }

  protected _run(message: string, options: SessionSendOptions): Promise<TurnResult> {
    const args = this._buildArgs(message);
    const timeout = options.timeout || 300_000;

    return new Promise<TurnResult>((resolve, reject) => {
      let stdoutBuf = '';
      let stderr = '';
      let assistantText = '';
      let lastUsage: CodexTurnCompleted['usage'] | undefined;
      let turnError: string | undefined;
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
            const itemType = it.item?.type;
            if (itemType === 'agent_message' && typeof it.item.text === 'string') {
              const chunk = it.item.text;
              assistantText += chunk;
              try {
                options.callbacks?.onText?.(chunk);
              } catch {
                // User callback errors are not fatal.
              }
              this.emit(SESSION_EVENT.TEXT, chunk);
            } else if (itemType === 'reasoning') {
              // Reasoning summary — not a tool call; log without inflating toolCalls.
              this.emit(SESSION_EVENT.LOG, `[codex-reasoning] ${trimmed}`);
            } else if (itemType === 'todo_list') {
              // Plan / todo-list updates (model-initiated or via --include-plan-tool).
              this.emit(SESSION_EVENT.LOG, `[codex-plan] ${trimmed}`);
            } else {
              // Real tool-call items: command_execution, file_change, mcp_tool_call, web_search.
              this._stats.toolCalls++;
              if (
                itemType === 'command_execution' &&
                typeof it.item.exit_code === 'number' &&
                it.item.exit_code !== 0
              ) {
                this._stats.toolErrors++;
              }
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
          case 'turn.failed': {
            const tf = event as CodexTurnFailed;
            if (tf.error?.message) turnError = tf.error.message;
            this.emit(SESSION_EVENT.LOG, `[codex-error] ${trimmed}`);
            break;
          }
          case 'error': {
            const er = event as CodexError;
            if (er.message) turnError = er.message;
            this.emit(SESSION_EVENT.LOG, `[codex-error] ${trimmed}`);
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

        // A captured turn.failed/error event means the turn failed even if the
        // process exits 0 — surface it rather than resolving an empty string.
        if (turnError) {
          reject(new Error(turnError));
        } else if (code !== 0) {
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
