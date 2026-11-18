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
 * ever wanted — verified against 1.17.15.) OpenCode 2's `run` rejects an `ask`
 * the same way (measured on 2.3.2), but its default policy allows everything,
 * paths outside the project included, where V1 asked for those.
 *
 * OpenCode 2 (2.x) keeps `run --format json` and the same event stream, and
 * differs where this wrapper touches it (all measured on 2.3.2):
 *   - `--standalone` is required. Without it `run` hands the turn to the
 *     background service when one is running (the desktop app starts one), and
 *     that service has its own configuration and environment: the read-only
 *     agent this wrapper injects comes back "Agent not found".
 *   - effort is `--model provider/model#variant`; `--variant` is gone. A variant
 *     the model does not offer fails the turn (`Variant unavailable`) before the
 *     model is called, where V1 ran the default.
 *   - agent configuration is a different shape (`agents`, ordered `permissions`
 *     rules, no `tools` map) and the shell tool is `shell`, not `bash`, so the
 *     read-only agent has its own V2 definition.
 *   - an `--agent` that does not exist fails the turn instead of falling back to
 *     the default, writable agent.
 */

import { execEngine, killEngineTree, spawnEngine } from './engine-spawn.js';
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

/**
 * The same agent for OpenCode 2, as an allowlist. V2 rules are ordered and the
 * last match wins; agent rules come after the global and project ones, so a
 * user's own `allow` cannot reopen what this denies. Denying `*` first covers
 * every action, including ones a plugin or MCP server adds and the
 * `subagent` action (V1's `task`) that would hand a write to another agent,
 * which on V2 runs under its own permissions rather than these. Measured on
 * 2.3.2: write, a shell heredoc, delegation to a subagent and a read outside the
 * project were all refused, and the denied tools are not offered to the model.
 */
const READ_ONLY_AGENT_CONFIG_V2 = JSON.stringify({
  agents: {
    [READ_ONLY_AGENT]: {
      mode: 'primary',
      description: 'claw-orchestrator read-only session',
      permissions: [
        { action: '*', resource: '*', effect: 'deny' },
        { action: 'read', resource: '*', effect: 'allow' },
        { action: 'glob', resource: '*', effect: 'allow' },
        { action: 'grep', resource: '*', effect: 'allow' },
        // V2's own default for secrets, which the `read` allow above would
        // otherwise override. `ask` is rejected in a non-interactive run.
        { action: 'read', resource: '*.env', effect: 'ask' },
        { action: 'read', resource: '*.env.*', effect: 'ask' },
        { action: 'read', resource: '*.env.example', effect: 'allow' },
      ],
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
  /** The message of the last `error` event, so a failed turn says why. */
  errorMessage?: string;
  /** OpenCode 2 refused the `#variant` this turn asked for (`Variant unavailable`). */
  variantUnavailable: boolean;
}

/** The text of an `error` event: V2 sends `{ error: { type, message } }`, V1 a string or `{ data: { message } }`. */
function errorEventMessage(event: Record<string, unknown>): string | undefined {
  const err = event.error ?? event.message;
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object') {
    const e = err as { message?: unknown; data?: { message?: unknown }; name?: unknown };
    if (typeof e.message === 'string') return e.message;
    if (typeof e.data?.message === 'string') return e.data.message;
    if (typeof e.name === 'string') return e.name;
  }
  return undefined;
}

// ─── OpenCode 2 ─────────────────────────────────────────────────────────────

/**
 * What `opencode --version` says, once per binary per process. `undefined`
 * when it could not be read — a check that cannot run blocks nothing.
 */
const versionCache = new Map<string, Promise<string | undefined>>();

function opencodeVersion(bin: string): Promise<string | undefined> {
  let v = versionCache.get(bin);
  if (!v) {
    v = execEngine(bin, ['--version'], { timeout: 15_000 }).then(
      (r) => `${r.stdout}${r.stderr}`.trim() || undefined,
      () => undefined,
    );
    versionCache.set(bin, v);
  }
  return v;
}

/** OpenCode 2: a 2.x release, or one of the `0.0.0-beta-N` builds that preceded it. */
export function isOpencodeV2(version: string | undefined): boolean {
  if (!version) return false;
  if (isOpencodeV2Prerelease(version)) return true;
  // No `\b` before the major: 2.3.2 prints `opencode v2.3.2`, and there is no
  // word boundary between the `v` and the `2`.
  const m = version.match(/(\d+)\.\d+\.\d+/);
  return !!m && Number(m[1]) >= 2;
}

/**
 * The OpenCode 2 builds that came before its first release (`0.0.0-beta-N`,
 * from `opencode upgrade --major` and the `@opencode-ai/cli` npm package).
 * Still refused: measured on 0.0.0-beta-17823 they sent no `step_finish`, so a
 * turn had no tokens and no cost. The 2.3.2 release sends it again.
 */
export function isOpencodeV2Prerelease(version: string | undefined): boolean {
  return !!version && (/\b0\.0\.0-(beta|next|dev)/.test(version) || /\bopencode2\b/.test(version));
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

  /**
   * Spend opencode reported itself, summed over every `step_finish.cost`.
   * Undefined until a step reports one. When present it is the bill: the model
   * opencode picked is not in its JSON output, so pricing tokens against the
   * registry charged a free default model at Sonnet rates.
   */
  private _reportedCostUsd?: number;

  /** Set by start() from `opencode --version`. An unreadable version runs as V1, as before. */
  private _v2 = false;

  /**
   * `provider/model#variant` pairs OpenCode 2 refused in this session. Each is
   * asked for once: after the refusal the turn runs on the model's default,
   * which is what V1 did with an effort a provider did not offer.
   */
  private readonly _refusedVariants = new Set<string>();

  /** The "effort not sent without a model" note is logged once per session. */
  private _loggedEffortWithoutModel = false;

  protected override _continuesConversation(): boolean {
    return !!this.opencodeSessionId;
  }

  override async start(): Promise<this> {
    const version = await opencodeVersion(this.engineBin);
    if (isOpencodeV2Prerelease(version)) {
      throw new Error(
        `OpenCode 2 prerelease builds (${version}) are not supported: they send no per-turn usage events. ` +
          'Install an OpenCode 2 release or OpenCode 1.x.',
      );
    }
    this._v2 = isOpencodeV2(version);
    return super.start();
  }

  constructor(config: SessionConfig, opencodeBin?: string) {
    super(config, opencodeBin || process.env.OPENCODE_BIN || 'opencode', {
      enginePrefix: 'opencode',
      defaultModel: 'claude-sonnet-4-6',
      defaultModelDisplay: 'opencode-default',
      supportsCachedTokens: true,
      // `tokens.total` is input + output + cache.read + cache.write, so
      // `tokens.input` holds only the uncached remainder. On a resumed turn
      // that remainder is tiny next to the cached part (58 vs 26240), which is
      // exactly where subtracting one from the other goes wrong.
      inputIncludesCachedTokens: false,
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
    // opencode run --format json [--session <id>], with the message on stdin.
    // On Windows `opencode` is an npm `.cmd` shim that runs through cmd.exe,
    // which would cut a message at its first newline; stdin carries it unchanged.
    const args: string[] = ['run', '--format', 'json'];
    // A private server for this run. Without it OpenCode 2 hands the turn to its
    // background service when one is running, which reads its own configuration
    // and not this process's environment (see the header).
    if (this._v2) args.push('--standalone');

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
    let model = this.options.model && this.options.model.includes('/') ? this.options.model : undefined;

    // `--variant` is opencode's reasoning-effort knob ("provider-specific
    // reasoning effort, e.g., high, max, minimal"). Before this the engine
    // received no effort at all and every caller's setting was dropped on the
    // floor. opencode does not validate the value — an unknown one runs the
    // turn at the provider's default rather than failing — so the level a
    // provider does not offer degrades instead of erroring.
    //
    // OpenCode 2 has no `--variant`: the variant joins the model as
    // `provider/model#variant`, and one the model does not offer fails the turn.
    // That refusal comes before the model is called, so the turn is run again
    // without it (see the close handler) and the level degrades as on V1.
    const effort = options.effort ?? this.options.effort;
    const wantsEffort = !!effort && effort !== 'auto';
    let variantTried: string | undefined;
    if (this._v2 && wantsEffort) {
      if (model && !model.includes('#')) {
        const withVariant = `${model}#${effort}`;
        if (!this._refusedVariants.has(withVariant)) model = variantTried = withVariant;
      } else if (!model && !this._loggedEffortWithoutModel) {
        // A variant names one model's level; with no model OpenCode picks the
        // default, and there is nothing to attach the level to.
        this._loggedEffortWithoutModel = true;
        this.emit(
          SESSION_EVENT.LOG,
          `[opencode] effort '${effort}' not sent: OpenCode 2 takes a reasoning variant only with a provider/model`,
        );
      }
    }
    if (model) args.push('--model', model);
    if (!this._v2 && wantsEffort) args.push('--variant', effort);

    const timeout = options.timeout || 300_000;

    return new Promise<TurnResult>((resolve, reject) => {
      const state: TurnState = {
        textParts: new Map(),
        seenTools: new Set(),
        erroredTools: new Set(),
        gotUsage: false,
        variantUnavailable: false,
      };
      let stderr = '';
      let settled = false;
      // Read-only safety: if our injected agent fails to load, opencode prints
      // `agent "clawo-readonly" not found. Falling back to default agent` (to
      // stdout) and silently runs the DEFAULT, writable agent. We must never let
      // a read-only session degrade to writable — detect that line and fail.
      let readOnlyAgentMissing = false;

      const proc = spawnEngine(this.engineBin, args, {
        launcher: this.options.launcher,
        cwd: this.options.cwd,
        env: readOnly
          ? {
              ...process.env,
              OPENCODE_CONFIG_CONTENT: this._v2 ? READ_ONLY_AGENT_CONFIG_V2 : READ_ONLY_AGENT_CONFIG,
            }
          : { ...process.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.currentProc = proc;
      // Writing the message closes stdin too; opencode waits for EOF before it starts.
      proc.stdin?.on('error', () => {});
      proc.stdin?.end(message);

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          killEngineTree(proc);
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

        // OpenCode 2 refused the variant before calling the model, so nothing ran:
        // not a turn, and safe to run again on the model's default variant.
        if (variantTried && state.variantUnavailable) {
          this._refusedVariants.add(variantTried);
          this.emit(
            SESSION_EVENT.LOG,
            `[opencode] ${state.errorMessage ?? `variant refused: ${variantTried}`}; running on the model's default`,
          );
          this._run(message, options).then(resolve, reject);
          return;
        }

        // A read-only session whose enforcement agent failed to load ran writable.
        // Refuse the result rather than hand back output produced without the
        // sandbox the caller asked for.
        if (readOnlyAgentMissing) {
          // Refused on purpose: it reached the engine, so it counts as a turn, but
          // it is not a success by any reading.
          this._recordTurnComplete(false);
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

        // One expression for the outcome, feeding the counter here and the
        // `stop_reason` below.
        const ok = code === 0;
        this._recordTurnComplete(ok);

        // Fallback: estimate tokens if step_finish never arrived.
        if (!state.gotUsage && finalText.length > 0) {
          this._stats.tokensIn += estimateTokens(message);
          this._stats.tokensOut += estimateTokens(finalText);
          this._markTurnEstimated();
          this._updateCost();
        }

        this._addHistory({ text: finalText, code });

        const event: StreamEvent = {
          type: 'result',
          result: finalText,
          stop_reason: ok ? 'end_turn' : 'error',
        };

        this.emit(SESSION_EVENT.RESULT, event);
        this.emit(SESSION_EVENT.TURN_COMPLETE, event);

        if (code !== 0) {
          reject(new Error(state.errorMessage || stderr || `OpenCode exited with code ${code}`));
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
          const cacheRead = tokens.cache?.read || 0;
          const cacheWrite = tokens.cache?.write || 0;
          this._stats.tokensIn += tokens.input || 0;
          this._stats.tokensOut += tokens.output || 0;
          this._stats.cachedTokens += cacheRead;
          this._stats.cacheCreationTokens += cacheWrite;
          // `tokens.input` is only the uncached remainder, so the context this
          // turn actually filled is the whole input side.
          this._reportTurnInputTokens((tokens.input || 0) + cacheRead + cacheWrite);
          if (typeof part.cost === 'number' && Number.isFinite(part.cost)) {
            this._reportedCostUsd = (this._reportedCostUsd ?? 0) + part.cost;
          }
          this._updateCost();
          state.gotUsage = true;
        }
        break;
      }

      case 'error': {
        const msg = errorEventMessage(event);
        if (msg) state.errorMessage = msg;
        if (msg && /\bVariant unavailable\b/i.test(msg)) state.variantUnavailable = true;
        this.emit(SESSION_EVENT.LOG, `[opencode-error] ${msg ?? JSON.stringify(event)}`);
        break;
      }

      default:
        // Unknown event type — ignore for forward compatibility.
        break;
    }
  }

  protected override _updateCost(): void {
    if (this._reportedCostUsd !== undefined) this._stats.costUsd = this._reportedCostUsd;
    else super._updateCost();
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
