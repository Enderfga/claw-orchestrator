/**
 * Persistent OpenCode Session — wraps `opencode run` (sst/opencode CLI).
 *
 * Each send() spawns a new `opencode` process in non-interactive mode.
 * `--format json` streams NDJSON events. The schema (from
 * packages/opencode/src/cli/cmd/run.ts) is:
 *
 *     { type, timestamp, sessionID, ...data }
 *
 * with these event types:
 *   - text          { part: { type:"text", text, id, ... } }
 *   - reasoning     { part: { type:"reasoning", text, ... } }
 *   - tool_use      { part: { type:"tool", callID, tool, state, ... } }
 *                   (re-emitted as state transitions; no separate tool_result)
 *   - step_start    { part: { type:"step-start", ... } }
 *   - step_finish   { part: { type:"step-finish", tokens:{input,output,
 *                             reasoning,cache:{read,write}}, cost, ... } }
 *   - error         { error: ... }
 *
 * `text` and `tool_use` events are CUMULATIVE — each emission carries the
 * latest snapshot of the same `part.id`. We diff against the previous
 * snapshot to compute streaming deltas for onText callbacks, and collapse
 * to the final per-part value at turn close.
 *
 * Provider-agnostic: opencode's `--model` uses `provider/model` form (e.g.
 * `anthropic/claude-sonnet-4`). We pass `--model` through only when the
 * configured value contains a `/`; otherwise opencode's default applies.
 *
 * Permissions: opencode 1.1.40's `run` subcommand does not gate tool use
 * behind interactive prompts, so no skip-permissions flag is needed (and
 * `--dangerously-skip-permissions` doesn't exist on this version — yargs
 * strict mode would reject it and print help). If a future opencode version
 * reintroduces prompting on `run`, add a flag here behind a version probe.
 */

import { spawn } from 'node:child_process';
import * as readline from 'node:readline';

import type { SessionConfig, SessionSendOptions, StreamEvent, TurnResult } from './types.js';
import { estimateTokens } from './models.js';
import { SESSION_EVENT } from './constants.js';
import { BaseOneShotSession } from './base-oneshot-session.js';

interface TurnState {
  /** Per-part latest text snapshot, keyed by part.id (preserves insertion order). */
  textParts: Map<string, string>;
  /** Tool callIDs we've seen (count once per unique tool invocation). */
  seenTools: Set<string>;
  /** Tool callIDs that ended in error state. */
  erroredTools: Set<string>;
  gotUsage: boolean;
}

// ─── PersistentOpencodeSession ──────────────────────────────────────────────

export class PersistentOpencodeSession extends BaseOneShotSession {
  private _currentRl: readline.Interface | null = null;

  constructor(config: SessionConfig, opencodeBin?: string) {
    super(config, opencodeBin || process.env.OPENCODE_BIN || 'opencode', {
      enginePrefix: 'opencode',
      defaultModel: 'claude-sonnet-4-6',
      defaultModelDisplay: 'opencode-default',
      supportsCachedTokens: true,
      engineDisplayName: 'OpenCode',
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
    // opencode run <message..> --format json
    const args: string[] = ['run', message, '--format', 'json'];

    // opencode wants `provider/model` format. Only pass through if it looks correct.
    if (this.options.model && this.options.model.includes('/')) {
      args.push('--model', this.options.model);
    }

    const timeout = options.timeout || 300_000;

    return new Promise<TurnResult>((resolve, reject) => {
      const state: TurnState = {
        textParts: new Map(),
        seenTools: new Set(),
        erroredTools: new Set(),
        gotUsage: false,
      };
      let stderr = '';
      let settled = false;

      const proc = spawn(this.engineBin, args, {
        cwd: this.options.cwd,
        env: { ...process.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.currentProc = proc;
      // opencode reads stdin even when the prompt is on argv. Close it
      // immediately so the subprocess doesn't hang waiting for EOF.
      proc.stdin?.end();

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          proc.kill('SIGTERM');
          reject(new Error('Timeout waiting for OpenCode response'));
        }
      }, timeout);

      const rl = readline.createInterface({ input: proc.stdout!, crlfDelay: Infinity });
      this._currentRl = rl;
      rl.on('line', (line: string) => {
        if (!line.trim()) return;
        try {
          const event = JSON.parse(line) as Record<string, unknown>;
          this._handleStreamEvent(event, options, state);
        } catch {
          // Non-JSON line — opencode banner or stray text. Treat as plain text.
          const fallback = line + '\n';
          state.textParts.set(`__raw_${state.textParts.size}`, (state.textParts.get('__raw_acc') || '') + fallback);
          try {
            options.callbacks?.onText?.(fallback);
          } catch {
            // User callback error
          }
          this.emit(SESSION_EVENT.TEXT, fallback);
        }
      });

      proc.stderr?.on('data', (data: Buffer) => {
        const sanitized = data
          .toString()
          .replace(/OPENCODE_API_KEY=[^\s]+/g, 'OPENCODE_API_KEY=***')
          .replace(/ANTHROPIC_API_KEY=[^\s]+/g, 'ANTHROPIC_API_KEY=***')
          .replace(/OPENAI_API_KEY=[^\s]+/g, 'OPENAI_API_KEY=***')
          .replace(/Bearer [a-zA-Z0-9_-]+/g, 'Bearer ***');
        stderr += sanitized;
        this.emit(SESSION_EVENT.LOG, `[opencode-stderr] ${sanitized}`);
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

        // Collapse per-part text snapshots to a single string in insertion order.
        const finalText = Array.from(state.textParts.values()).join('');

        // Account tool usage stats (count uniques only).
        this._stats.toolCalls += state.seenTools.size;
        this._stats.toolErrors += state.erroredTools.size;

        this._recordTurnComplete();

        // Fallback: estimate tokens if step_finish never arrived.
        if (!state.gotUsage && finalText.length > 0) {
          this._stats.tokensIn += estimateTokens(message);
          this._stats.tokensOut += estimateTokens(finalText);
          this._updateCost();
        }

        this._addHistory({ text: finalText, code });

        const event: StreamEvent = {
          type: 'result',
          result: finalText,
          stop_reason: code === 0 ? 'end_turn' : 'error',
        };

        this.emit(SESSION_EVENT.RESULT, event);
        this.emit(SESSION_EVENT.TURN_COMPLETE, event);

        if (code !== 0) {
          reject(new Error(stderr || `OpenCode exited with code ${code}`));
        } else {
          resolve({ text: finalText, event });
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

  private _handleStreamEvent(event: Record<string, unknown>, options: SessionSendOptions, state: TurnState): void {
    const type = event.type as string;

    // Capture session id from envelope on first event that carries one.
    const sid = (event.sessionID as string) || (event.sessionId as string) || (event.session_id as string);
    if (sid && !this.sessionId?.startsWith('opencode-live-')) {
      this.sessionId = `opencode-live-${sid}`;
    }

    const part = event.part as Record<string, unknown> | undefined;

    switch (type) {
      case 'text': {
        if (!part) break;
        const text = (part.text as string) || '';
        const partId = (part.id as string) || `text-${state.textParts.size}`;
        const prev = state.textParts.get(partId) || '';
        if (text === prev) break;
        // Compute streaming delta (text events are cumulative snapshots).
        const delta = text.startsWith(prev) ? text.slice(prev.length) : text;
        state.textParts.set(partId, text);
        if (delta) {
          try {
            options.callbacks?.onText?.(delta);
          } catch {
            // User callback error
          }
          this.emit(SESSION_EVENT.TEXT, delta);
        }
        break;
      }

      case 'reasoning': {
        // Surface reasoning text on the log channel, but don't include it in
        // the user-visible result — it's the model's internal scratchpad.
        if (!part) break;
        const text = (part.text as string) || '';
        if (text) this.emit(SESSION_EVENT.LOG, `[opencode-reasoning] ${text}`);
        break;
      }

      case 'tool_use': {
        if (!part) break;
        const callID = (part.callID as string) || (part.id as string) || '';
        if (!callID) break;
        if (!state.seenTools.has(callID)) {
          state.seenTools.add(callID);
          try {
            options.callbacks?.onToolUse?.(event);
          } catch {
            // User callback error
          }
          this.emit(SESSION_EVENT.TOOL_USE, event);
        }
        // State transitions get re-emitted on the same callID. Check for terminal
        // states to mark errors and emit tool_result.
        const toolState = part.state as Record<string, unknown> | undefined;
        const status = toolState?.status as string | undefined;
        if (status === 'error' && !state.erroredTools.has(callID)) {
          state.erroredTools.add(callID);
        }
        if (status === 'completed' || status === 'error') {
          try {
            options.callbacks?.onToolResult?.(event);
          } catch {
            // User callback error
          }
          this.emit(SESSION_EVENT.TOOL_RESULT, event);
        }
        break;
      }

      case 'step_start':
        // No-op: lifecycle marker only.
        break;

      case 'step_finish': {
        if (!part) break;
        const tokens = part.tokens as
          | { input?: number; output?: number; cache?: { read?: number; write?: number } }
          | undefined;
        if (tokens) {
          this._stats.tokensIn += tokens.input || 0;
          this._stats.tokensOut += tokens.output || 0;
          if (tokens.cache?.read) this._stats.cachedTokens += tokens.cache.read;
          this._updateCost();
          state.gotUsage = true;
        }
        break;
      }

      case 'error':
        this.emit(SESSION_EVENT.LOG, `[opencode-error] ${event.error || JSON.stringify(event)}`);
        break;

      default:
        // Unknown event type — ignore for forward compatibility.
        break;
    }
  }
}
