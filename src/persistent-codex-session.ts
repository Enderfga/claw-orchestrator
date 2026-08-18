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
import { writeFileSync, unlinkSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
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

  /**
   * Codex's own context limit for this thread, harvested from its rollout file.
   *
   * The registry window is the model's published maximum (1.05M for gpt-5.x);
   * codex enforces a much smaller one of its own (258,400 measured on 0.147.0
   * for gpt-5.6-sol) and that is the limit a request actually dies on. Using the
   * registry value here made `contextPercent` read ~4x low, so the auto-compaction
   * gate stayed below its threshold right up to a hard context-window failure.
   * Undefined until the rollout has been read; falls back to the registry.
   */
  private _codexContextWindow?: number;

  /**
   * Cumulative `input_tokens` codex reported at the end of the previous turn.
   *
   * Codex's `turn.completed.usage` is cumulative over the whole thread, not the
   * turn — three identical trivial turns report 13,856 → 27,727 → 41,613, and
   * each of those equals `total_token_usage.input_tokens` in the rollout exactly.
   * Subtracting consecutive values recovers the per-turn prompt, which for a
   * thread-resuming engine is the live context occupancy.
   */
  private _prevCumulativeIn?: number;

  /** Guards the rollout lookup so it runs at most once per session. */
  private _rolloutRead = false;

  constructor(config: SessionConfig, codexBin?: string) {
    super(config, codexBin || process.env.CODEX_BIN || 'codex', {
      enginePrefix: 'codex',
      defaultModel: 'gpt-5.5',
      supportsCachedTokens: true,
      engineDisplayName: 'Codex',
    });
    if (config.resumeSessionId && !/^codex-\d+-/.test(config.resumeSessionId)) {
      this.codexThreadId = config.resumeSessionId;
    }
  }

  /** Expose the captured thread ID for the codex_resume tool and stats overlay. */
  get threadId(): string | undefined {
    return this.codexThreadId;
  }

  // ── Context accounting ─────────────────────────────────────────────────

  /** Codex's enforced limit when we know it, else the model registry's. */
  protected override _effectiveContextWindow(): number {
    return this._codexContextWindow ?? super._effectiveContextWindow();
  }

  /**
   * Harvest what `codex exec --json` does not emit from the thread's rollout file.
   *
   * The JSON stream carries only `turn.completed.usage`; codex's own context
   * limit and the pre-existing token total of a resumed thread live in
   * `$CODEX_HOME/sessions/**\/rollout-*-<thread_id>.jsonl`. Runs at most once
   * per session and is entirely best-effort: an unreadable, absent or
   * `--ephemeral` thread simply leaves both values unset and the registry
   * fallback applies.
   */
  private _readRollout(): void {
    if (this._rolloutRead || !this.codexThreadId) return;
    this._rolloutRead = true;
    try {
      const root = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'sessions');
      const match = this._findRolloutFile(root, `-${this.codexThreadId}.jsonl`);
      if (!match) return;

      const text = readFileSync(match, 'utf8');

      const windowMatch = /"model_context_window":\s*(\d+)/.exec(text);
      if (windowMatch) this._codexContextWindow = Number(windowMatch[1]);

      // Last entry wins — it is the thread total as of the most recent turn.
      if (this._prevCumulativeIn === undefined) {
        const totals = text.match(/"total_token_usage":\s*\{[^}]*\}/g);
        const last = totals?.[totals.length - 1];
        if (last) {
          const parsed = JSON.parse(`{${last}}`) as { total_token_usage?: { input_tokens?: number } };
          const seed = parsed.total_token_usage?.input_tokens;
          if (typeof seed === 'number') this._prevCumulativeIn = seed;
        }
      }
    } catch {
      /* best effort — registry fallback covers every failure mode */
    }
  }

  /**
   * Locate a thread's rollout under `sessions/<year>/<month>/<day>/`.
   *
   * Walks newest-first and stops at the first hit, so the usual case — a thread
   * from today — costs a handful of small readdirs. A recursive listing would
   * instead materialize every rollout the user has ever recorded, which for a
   * long-lived fleet is tens of thousands of paths to find one file.
   */
  private _findRolloutFile(root: string, suffix: string): string | undefined {
    const newestFirst = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort()
        .reverse();

    for (const year of newestFirst(root)) {
      for (const month of newestFirst(join(root, year))) {
        for (const day of newestFirst(join(root, year, month))) {
          const dir = join(root, year, month, day);
          const hit = readdirSync(dir).find((f) => f.endsWith(suffix));
          if (hit) return join(dir, hit);
        }
      }
    }
    return undefined;
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
    const sandbox = this.options.sandboxMode || 'workspace-write';
    if (isResume) {
      // `codex exec resume` rejects --sandbox and -C (still true as of 0.146.0:
      // passing --sandbox errors with "unexpected argument"), so the policy has
      // to be restated as a `-c` config override, which resume does accept.
      //
      // Do NOT rely on the resumed thread inheriting the first turn's sandbox.
      // It does not: against 0.146.0, a read-only session whose first turn was
      // spawned with `--sandbox read-only` wrote to disk on the very next turn,
      // reproducibly, when resume was left to inherit. Restating the mode keeps
      // a read-only session read-only for its whole life.
      args.push('resume', this.codexThreadId!, '--skip-git-repo-check', '--json');
      args.push('-c', `sandbox_mode="${sandbox}"`);
    } else {
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
    // Read before spawning: on a resumed thread the baseline has to be the
    // cumulative total as of the *previous* turn, and this turn is about to
    // append its own to the same file.
    this._readRollout();
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

        // One expression for the outcome: it feeds the counter here and the
        // `stop_reason` below. Classifying on the exit code alone reported
        // `end_turn` for a `turn.failed` that exits 0 — the same turn the reject
        // below has always treated as a failure.
        const ok = !turnError && code === 0;
        this._recordTurnComplete(ok);

        // Real usage from `turn.completed`. Falls back to zero rather than
        // estimated tokens — better to have an honest "0" than a guess that
        // misleads cost reporting.
        //
        // These are thread-cumulative, so they are *assigned*, not accumulated.
        // Adding them summed a running total of running totals: with a constant
        // per-turn prompt P, N turns reported P*N*(N+1)/2 against a true P*N —
        // an (N+1)/2 overstatement that grew without bound (measured at 3.6x on
        // a seven-turn session). The codex app-server sibling has always
        // assigned; this brings `codex exec` in line with it.
        if (lastUsage) {
          const cumulativeIn = lastUsage.input_tokens ?? 0;
          this._reportTurnInputTokens(cumulativeIn - (this._prevCumulativeIn ?? 0));
          this._prevCumulativeIn = cumulativeIn;
          this._stats.tokensIn = cumulativeIn;
          this._stats.tokensOut = (lastUsage.output_tokens ?? 0) + (lastUsage.reasoning_output_tokens ?? 0);
          this._stats.cachedTokens = lastUsage.cached_input_tokens ?? 0;
        }
        this._updateCost();
        // A fresh session has no rollout to read until its first turn has
        // created one; retry now that the thread id is known.
        this._readRollout();
        this._addHistory({ text: assistantText, code });

        const event: StreamEvent = {
          type: 'result',
          result: assistantText,
          stop_reason: ok ? 'end_turn' : 'error',
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
