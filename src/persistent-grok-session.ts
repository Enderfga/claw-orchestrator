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

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { killEngineTree, spawnEngine } from './engine-spawn.js';

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
  /** `error` when grok refused the turn outright (usage limit, auth), with `message`. */
  type?: string;
  message?: string;
}

/** grok's warning when a sandbox profile could not be applied (1.0.50). */
const SANDBOX_NOT_APPLIED_RE = /sandbox could not be applied/i;

/** True when `dir` is inside the OS temp directory, which grok's read-only profile leaves writable. */
function underTempDir(dir: string): boolean {
  const real = (p: string): string => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  const target = real(dir);
  const roots = new Set([real(os.tmpdir()), real('/tmp'), real('/var/tmp')]);
  if (process.env.TMPDIR) roots.add(real(process.env.TMPDIR));
  return [...roots].some((root) => target === root || target.startsWith(root + path.sep));
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
      appendsSystemPromptNatively: true,
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

    // The boundary for read-only is grok's own OS sandbox (Seatbelt / Landlock),
    // not a tool allowlist — see _run for what it was measured against.
    if (this.options.sandboxMode === 'read-only') args.push('--sandbox', 'read-only');

    const effort = options.effort ?? this.options.effort;
    if (effort && effort !== 'auto') {
      // grok 1.0.5 takes low|medium|high|xhigh — it names the invalid ones in
      // its own rejection message. Only the two levels above its ceiling clamp;
      // `xhigh` used to clamp too and was silently costing callers a tier.
      args.push('--effort', effort === 'max' || effort === 'ultra' ? 'xhigh' : effort);
    }

    if (this.options.maxTurns) args.push('--max-turns', String(this.options.maxTurns));
    if (this.options.systemPrompt) args.push('--system-prompt-override', this.options.systemPrompt);
    // grok appends `--rules` to its system prompt, which is what our
    // engine-agnostic `appendSystemPrompt` means — distinct from the override
    // above, which replaces it.
    if (this.options.appendSystemPrompt) args.push('--rules', this.options.appendSystemPrompt);

    // Tool control. `--tools` is an allowlist of built-ins and
    // `--disallowed-tools` a denylist; grok validates neither, so a name that
    // does not exist is silently ignored rather than rejected.
    if (this.options.allowedTools?.length) args.push('--tools', this.options.allowedTools.join(','));
    if (this.options.disallowedTools?.length) {
      args.push('--disallowed-tools', this.options.disallowedTools.join(','));
    }

    // Structured output. grok's `--json-schema` takes the schema inline, the
    // same shape our engine-agnostic option carries, and implies the JSON
    // output format we already ask for.
    if (this.options.jsonSchema) args.push('--json-schema', this.options.jsonSchema);

    if (this.options.agent) args.push('--agent', this.options.agent);
    if (this.options.agents) {
      const json = typeof this.options.agents === 'string' ? this.options.agents : JSON.stringify(this.options.agents);
      args.push('--agents', json);
    }

    if (this.options.dangerouslySkipPermissions) args.push('--always-approve');

    // `--session-id` names a NEW conversation, so it is only valid on a first
    // turn — or on a resumed one that is being forked, which is what grok's own
    // help says and what `--fork-session` is for.
    if (this.options.forkSession && this.grokSessionId) args.push('--fork-session');
    if (this.options.customSessionId && (!this.grokSessionId || this.options.forkSession)) {
      args.push('--session-id', this.options.customSessionId);
    }

    return args;
  }

  protected _run(message: string, options: SessionSendOptions): Promise<TurnResult> {
    // Read-only is grok's built-in `--sandbox read-only` profile, enforced by
    // the OS (Seatbelt on macOS, Landlock on Linux): reads anywhere, writes only
    // to ~/.grok/ and the temp directory.
    //
    // It replaced a refusal. A `--tools` allowlist plus plan mode, measured on
    // 1.0.13, held for a direct and a shell write and lost to delegation: the
    // subagent did not inherit the restriction and wrote the file. The sandbox
    // is inherited by the whole process tree. Measured on 1.0.50 against a repo
    // outside temp, with `--permission-mode bypassPermissions`: a direct write, a
    // shell redirect, a delegated subagent, a write on a resumed turn and a write
    // outside the project all failed with `Operation not permitted`, each one
    // actually attempted (the agent reported the error, not a refusal or a quota
    // stop).
    //
    // Two things the profile cannot cover are refused rather than claimed:
    //   - a project under the temp directory, which the profile leaves writable;
    //   - a platform without Seatbelt or Landlock.
    // And a sandbox that fails to apply does not fail closed in grok: it warns
    // and runs unsandboxed. The warning comes at startup, before any model call
    // (13 ms, measured), so the turn is killed on sight of it — see the stderr
    // handler below.
    if (this.options.sandboxMode === 'read-only') {
      if (process.platform !== 'darwin' && process.platform !== 'linux') {
        return Promise.reject(
          new Error(
            `Grok read-only needs grok's OS sandbox (Seatbelt or Landlock), which ${process.platform} does not have. Use a different engine for read-only work.`,
          ),
        );
      }
      if (this.options.cwd && underTempDir(this.options.cwd)) {
        return Promise.reject(
          new Error(
            "Grok read-only cannot protect a project under the temp directory: grok's read-only sandbox leaves temp writable. Move the project or use a different engine for read-only work.",
          ),
        );
      }
    }

    const args = this._buildArgs(message, options);
    const timeout = options.timeout || 300_000;

    return new Promise<TurnResult>((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let settled = false;

      const proc = spawnEngine(this.engineBin, args, {
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
        // grok carries on unsandboxed when a profile cannot be applied. For a
        // read-only session that is the one outcome that must not run.
        if (this.options.sandboxMode === 'read-only' && !settled && SANDBOX_NOT_APPLIED_RE.test(stderr)) {
          settled = true;
          clearTimeout(timer);
          killEngineTree(proc);
          reject(
            new Error(
              `Grok could not apply its read-only sandbox, so the turn was stopped before it ran: ${stderr.trim().split('\n')[0]}`,
            ),
          );
        }
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
        // A refused turn (usage limit, auth) is `{"type":"error","message":...}`
        // rather than a result object; the message is the only reason given.
        const refusal = parsed?.type === 'error' ? parsed.message?.trim() || 'Grok reported an error' : undefined;
        const turnError =
          parsed?.error?.trim() ||
          refusal ||
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
