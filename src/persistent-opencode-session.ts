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
 * Permissions: on opencode 1.17.15's `run`, a tool that would prompt for a
 * permission is auto-REJECTED in non-interactive mode (it does not hang), so a
 * write-enabled session needs no skip flag. (`--dangerously-skip-permissions`,
 * `--auto`, and `--yolo` do exist as of opencode 1.4.0 if an allow-all run is
 * ever wanted — verified against 1.17.15.)
 */

import { spawn } from 'node:child_process';
import * as readline from 'node:readline';

import type { SessionConfig, SessionSendOptions, StreamEvent, TurnResult } from './types.js';
import { estimateTokens } from './models.js';
import { sanitizeSecrets } from './sanitize.js';
import { SESSION_EVENT } from './constants.js';
import { BaseOneShotSession } from './base-oneshot-session.js';

/**
 * Read-only enforcement for opencode.
 *
 * opencode ships a `plan` agent, but it is a user-overridable preset: on a
 * stock install its rules begin with `{"permission":"*","action":"allow"}` and
 * deny neither `bash` nor `edit`, so a "read-only" session could still author
 * files through a shell heredoc. We therefore define our own agent and hand it
 * to the CLI via `OPENCODE_CONFIG_CONTENT`, with the write paths denied at the
 * permission-engine level AND the corresponding tools removed.
 *
 * Verify this config only with adversarial writes, and include prompts that ask
 * the agent to delegate — `opencode agent list` renders compiled rules that look
 * identical for a safe and an unsafe agent, and a probe that only asks the agent
 * to write directly passes even when the delegation path is wide open.
 */
const READ_ONLY_AGENT = 'clawo-readonly';
const READ_ONLY_AGENT_CONFIG = JSON.stringify({
  agent: {
    [READ_ONLY_AGENT]: {
      mode: 'primary',
      permission: {
        edit: 'deny',
        bash: 'deny',
        external_directory: 'deny',
        // Denying the write tools is not enough on its own: the agent can hand
        // the work to a subagent via `task`, and the subagent runs under the
        // default (writable) agent, so the denials above never apply to it.
        // Asked to "delegate this to a subagent", a session denied only
        // edit/bash/external_directory wrote to disk on every attempt.
        task: 'deny',
        webfetch: 'deny',
      },
      // Belt-and-suspenders: drop the tools outright as well, so enforcement
      // does not depend on the permission engine resolving our rules the way we
      // expect. `task` is the escalation path; the rest are the direct ones.
      tools: {
        task: false,
        write: false,
        edit: false,
        bash: false,
        patch: false,
      },
    },
  },
});

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

  /**
   * OpenCode's own session id, once the first turn has announced one.
   *
   * `opencode run` starts a brand-new session unless `--session <id>` names an
   * existing one, so without this every send was an amnesiac first turn. The id
   * was already being harvested off the event stream for `sessionId`; it just
   * was never fed back, which is what made this engine look like it had no
   * conversation of its own.
   */
  private opencodeSessionId?: string;

  constructor(config: SessionConfig, opencodeBin?: string) {
    super(config, opencodeBin || process.env.OPENCODE_BIN || 'opencode', {
      enginePrefix: 'opencode',
      defaultModel: 'claude-sonnet-4-6',
      defaultModelDisplay: 'opencode-default',
      supportsCachedTokens: true,
      engineDisplayName: 'OpenCode',
    });
    // Process-level resume: a persisted id comes back as the raw OpenCode id,
    // never one of our generated `opencode-<ts>-<rand>` handles.
    if (config.resumeSessionId && !/^opencode-\d+-/.test(config.resumeSessionId)) {
      this.opencodeSessionId = config.resumeSessionId.replace(/^opencode-live-/, '');
    }
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
    // opencode run <message..> --format json [--session <id>]
    const args: string[] = ['run', message, '--format', 'json'];

    // Continue OpenCode's own session rather than starting a fresh one. Verified
    // against 1.18.18: without this the second turn answers "you never asked me
    // to remember anything"; with it the same turn recalls the first turn's
    // content. `--continue` is deliberately not used — it means "the last
    // session on this machine", which would collide across concurrent sessions.
    if (this.opencodeSessionId) args.push('--session', this.opencodeSessionId);

    const readOnly = this.options.sandboxMode === 'read-only';
    if (readOnly) {
      // NOT opencode's built-in `plan` agent: that is a user-overridable preset
      // whose rules start with {"permission":"*","action":"allow"} and deny
      // neither `bash` nor `edit` — a "read-only" session could still write via
      // a shell heredoc. Instead we inject our own agent whose permissions deny
      // edit/bash/external_directory outright, so read-only is enforced by the
      // permission engine rather than requested politely.
      args.push('--agent', READ_ONLY_AGENT);
    }

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
      // Read-only safety: if our injected agent fails to load, opencode prints
      // `agent "clawo-readonly" not found. Falling back to default agent` (to
      // stdout) and silently runs the DEFAULT, writable agent. We must never let
      // a read-only session degrade to writable — detect that line and fail.
      let readOnlyAgentMissing = false;

      const proc = spawn(this.engineBin, args, {
        cwd: this.options.cwd,
        env: readOnly ? { ...process.env, OPENCODE_CONFIG_CONTENT: READ_ONLY_AGENT_CONFIG } : { ...process.env },
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
          if (readOnly && /\bnot found\. Falling back to default agent/i.test(line)) {
            readOnlyAgentMissing = true;
          }
          const fallback = line + '\n';
          // Accumulate fallback text under one stable key (the old code wrote to
          // __raw_<size> but read __raw_acc, so it never actually accumulated).
          state.textParts.set('__raw_acc', (state.textParts.get('__raw_acc') || '') + fallback);
          try {
            options.callbacks?.onText?.(fallback);
          } catch {
            // User callback error
          }
          this.emit(SESSION_EVENT.TEXT, fallback);
        }
      });

      proc.stderr?.on('data', (data: Buffer) => {
        const sanitized = sanitizeSecrets(data.toString());
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

        // A read-only session whose enforcement agent failed to load ran writable.
        // Refuse the result rather than hand back output produced without the
        // sandbox the caller asked for.
        if (readOnlyAgentMissing) {
          this._recordTurnComplete();
          reject(
            new Error(
              "OpenCode read-only enforcement failed: the 'clawo-readonly' agent did not load, so the session " +
                'would have run with write access. Refusing the turn. (Check that OPENCODE_CONFIG_CONTENT is honored ' +
                'by this opencode version.)',
            ),
          );
          return;
        }

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

    // Capture session id from envelope on first event that carries one. The raw
    // id is kept separately because that is the form `--session` expects; the
    // prefixed one is our display/persistence handle.
    const sid = (event.sessionID as string) || (event.sessionId as string) || (event.session_id as string);
    if (sid && !this.opencodeSessionId) this.opencodeSessionId = sid;
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

  /**
   * Override getStats to expose the captured session ID.
   *
   * Consumers use its presence to tell "this session resumes a real conversation"
   * from "the session is merely in the manager's map". Without it a caller has to
   * assume the conversation exists, and a session whose first turn died before the
   * run reported an id looks identical to a healthy one.
   */
  getStats(): ReturnType<BaseOneShotSession['getStats']> {
    const base = super.getStats();
    return { ...base, opencodeSessionId: this.opencodeSessionId };
  }
}
