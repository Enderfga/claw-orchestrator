# Multi-Engine

Claw Orchestrator supports multiple coding CLI engines behind a unified `ISession` interface. Each engine manages its own subprocess, event stream, and cost tracking independently.

## Architecture

```
SessionManager
├── engine: 'claude'    → PersistentClaudeSession
│   └── Wraps: claude CLI (stream-json protocol, persistent subprocess)
├── engine: 'codex'     → PersistentCodexSession
│   └── Wraps: codex exec --sandbox workspace-write --json (per-message spawning)
├── engine: 'codex-app' → PersistentCodexAppServerSession
│   └── Wraps: codex app-server --listen stdio:// (long-running JSON-RPC; required for /goal)
├── engine: 'agy'       → PersistentAgySession
│   └── Wraps: agy -p (Google Antigravity CLI, per-message spawning, stream-json output)
├── engine: 'grok'      → PersistentGrokSession
│   └── Wraps: grok -p --output-format json (xAI Grok Build, per-message spawning)
├── engine: 'cursor'    → PersistentCursorSession (legacy)
│   └── Wraps: cursor-agent -p --trust --output-format stream-json (per-message spawning)
├── engine: 'opencode'  → PersistentOpencodeSession
│   └── Wraps: opencode run --format json (per-message spawning)
└── engine: 'custom'    → PersistentCustomSession
    └── Wraps: any CLI via user-provided CustomEngineConfig
```

## Supported Engines

### Claude Code (`engine: 'claude'`)

Default engine. Long-running subprocess with streaming JSON I/O. Tested with Claude Code CLI **2.1.280**.

- Persistent multi-turn conversations
- Real-time streaming (text, tool_use, tool_result, system events)
- Session resume via `--resume`
- Full cost tracking from API usage data
- Cross-session peer messaging (`crossSessionInbound`): this session's policy for messages from
  other Claude Code sessions on the same machine — `accept` delivers them, `hold` waits for approval
  in that session's terminal, `refuse` rejects them. It is a settings key, passed through
  `--settings`. Set it explicitly on orchestrated sessions: when it is unset, the CLI holds messages
  whenever the two sides' permission modes differ, so a message can wait for approval in a terminal
  nobody is watching. A user-level `~/.claude/settings.json` value may take precedence over the
  per-session one.
- Hook lifecycle events (`includeHookEvents`), subagent output forwarding (`forwardSubagentText`), permission delegation (`permissionPromptTool`), prompt cache optimization (`bare` + `excludeDynamicSystemPromptSections` + `enablePromptCaching1H`), debug control, `--from-pr` resume, and MCP channel subscriptions
- `--permission-prompts none` is passed whenever no `permissionPromptTool` is configured. The
  session has no TTY and no prompt tool, so a tool call the permission mode does not already decide
  is denied (the model sees the denial and can adapt) instead of waiting until the turn timeout.
  With a prompt tool configured, the CLI's default (`host`) is kept so the tool is asked
- `restricted` → `--restricted`: removes the command- and code-running tools and `WebFetch` from
  the session, and ignores user/project/local settings files (including CLAUDE.md). It is separate
  from `sandboxMode: 'read-only'`, which maps to plan mode
- Fork subagent (`forkSubagent`), tool search (`enableToolSearch`), OpenTelemetry logging toggles (`otelLogUserPrompts`, `otelLogRawApiBodies`), the `xhigh` effort tier, and `stats.pluginErrors` capture — see [SKILL.md](../SKILL.md#claude-engine-options) and [tools.md](./tools.md)

```typescript
await manager.startSession({
  name: 'claude-task',
  engine: 'claude', // default, can omit
  model: 'opus',
  cwd: '/project',
});
```

### OpenAI Codex (`engine: 'codex'`)

Wraps the `codex exec` subcommand. Each `send()` spawns a new process. Tested with `codex` CLI **0.156.1**.

- Non-interactive execution via `codex exec --sandbox workspace-write --skip-git-repo-check --json`
- Real `usage` from the `turn.completed` JSON event (input, output, cached, reasoning tokens). **These are cumulative over the thread, not per turn**, so they replace the session totals rather than being added to them; subtracting consecutive values gives one turn's prompt
- `contextPercent` is the per-turn prompt measured against **codex's own context limit** (`model_context_window`, read from the thread's rollout file), not the model's published window in the registry. Resuming a thread also seeds the token baseline from the rollout, so the first send does not count the whole thread history as one prompt. This is best-effort: an unreadable or `--ephemeral` thread falls back to the registry window
- `item.completed` parsing distinguishes `reasoning` / `todo_list` (logged, not counted) from real tool items (`command_execution`, `file_change`, `mcp_tool_call`, `web_search`, which increment `toolCalls`; a non-zero `command_execution.exit_code` increments `toolErrors`)
- Reasoning effort: the engine-agnostic `effort` maps to `-c model_reasoning_effort=<level>` for `low|medium|high|xhigh|max|ultra`; `auto` and `ultracode` pass nothing. `-c` values are not validated at spawn, so an unknown level fails at the API rather than at the command line
- `appendSystemPrompt`: codex has no system-prompt flag, so it is placed at the top of the first message of each new conversation (a resumed thread already carries it)
- `jsonSchema` → `--output-schema <file>` (written to a temp file, accepted by `exec` and `exec resume`)
- `noSessionPersistence` → `--ephemeral` (accepted by `exec` and `exec resume`); `ignoreUserConfig` → `--ignore-user-config`, which stops `$CODEX_HOME/config.toml` from choosing the model for an orchestrated run (auth still resolves from `CODEX_HOME`); `addDir` → `--add-dir` on the first turn only, since `exec resume` rejects it and the resumed thread keeps the roots it opened with
- `codexProfile` → `--profile <name>` (named config profile from `~/.codex/config.toml`), first turn only
- `--worktree` is not passed. With it, codex writes the turn's edits to `~/.codex/worktrees/<hash>/<repo>` instead of the session's `cwd`, while acceptance contracts, evidence diffs and the baseline change set all read the session's `cwd`. Council's per-agent git worktrees cover the isolation use case
- Per-session continuity: the `thread_id` from the first turn's `thread.started` event is captured and reused via `codex exec resume <id>` for subsequent sends, so the model sees prior turns
- `sandboxMode` maps to `--sandbox <mode>` on the first turn. A resumed thread does not keep it, and `codex exec resume` rejects `--sandbox`, so the policy is restated as `-c sandbox_mode="<mode>"` on every resumed turn
- One-shot execution per message (no persistent subprocess between sends)
- Captures the real Codex thread ID and persists it, so later sends and process-level session resume use `codex exec resume <thread_id>`
- Working directory passed via `-C` on the first turn
- Default model: `gpt-5.5`
- Requires `codex` CLI >= 0.119 (for `exec resume`): `npm install -g @openai/codex`
- **Windows:** npm `.cmd` shims launch via `src/engine-spawn.ts` (cross-spawn). Arguments keep spaces, balanced quotes and `%`; newlines are flattened to spaces for batch targets (cmd.exe cannot carry them); an unbalanced `"` in one argument is a cmd.exe limit.
- **Does not support `/goal`** — for that, use `engine: 'codex-app'` below

```typescript
await manager.startSession({
  name: 'codex-task',
  engine: 'codex',
  model: 'gpt-5.5',
  cwd: '/project',
  sandboxMode: 'workspace-write', // optional, this is the default
});
```

### OpenAI Codex App-Server (`engine: 'codex-app'`)

Wraps `codex app-server --listen stdio:// --enable goals` as a long-running JSON-RPC subprocess. **Required for `/goal` long-horizon objective support** — Codex's exec subcommand has no slash-command surface.

- Long-running subprocess; one `codex app-server` per session
- JSON-RPC 2.0 over stdio with v2 protocol method names (`initialize`, `thread/start`, `turn/start`, ...)
- Real-time streaming via `item/agentMessage/delta` notifications
- Cumulative token tracking from `thread/tokenUsage/updated` notifications. The same notification's `last` breakdown and `modelContextWindow` drive `contextPercent`, so it reports live occupancy against the window the server enforces rather than a running total over the model's published window
- `appendSystemPrompt` is placed at the top of the first message of a new thread (app-server has no system-prompt flag); a resumed thread already carries it
- Goal lifecycle observation via `thread/goal/updated` and `thread/goal/cleared` notifications
- Goal control via the `codex_goal_*` tools (which internally send the `/goal` slash command as user text — see [tools.md](./tools.md#codex-13))
- v2 RPC tools (Codex 0.137): `codex_interrupt` (`turn/interrupt`), `codex_steer` (`turn/steer`), `codex_fork` (`thread/fork`), `codex_rollback` (`thread/rollback`), `codex_models` (`model/list`), `codex_thread_list` (`thread/list`). A `turn/completed` with `status: 'failed'` rejects the turn and increments `toolErrors`.
- Thread resume: starting with `resumeSessionId` loads the existing thread via `thread/resume` instead of `thread/start`.

> **Feature flag.** `goals` is an experimental Codex feature. The session always passes `--enable goals`; some goal commands may still fail or be ignored by the server.

```typescript
await manager.startSession({
  name: 'codex-goal-task',
  engine: 'codex-app',
  model: 'gpt-5.5',
  cwd: '/project',
});
// Then either:
//   await manager.codexGoalCommand('codex-goal-task', 'build a tic-tac-toe app');
// or via the codex_goal_set tool:
//   await tool('codex_goal_set', { name: 'codex-goal-task', objective: 'build a tic-tac-toe app' });
```

### Google Antigravity (`engine: 'agy'`)

Wraps Google's **Antigravity CLI** (`agy`) — the successor to Gemini CLI (consumer
Gemini CLI tiers stopped serving 2026-06-18). Each `send()` spawns a new process
in print mode. Tested with `agy` **1.2.8**.

- One-shot execution per message (no persistent subprocess)
- **Structured output and real usage** — `--output-format stream-json` emits an
  `init` event with the conversation id, progress events, and a final `result`
  with the response plus input/output/cache-read token counts. Plain text and
  estimated usage remain as compatibility fallbacks when a result event is absent.
- **Real conversation continuity**: the engine captures the id from stream-json
  and resumes with `--conversation <id>` on later sends. A private `--log-file`
  scrape remains as a fallback for turns that die before emitting `init`. Seed it
  externally via `resumeSessionId` (bare UUID only); read it back from
  `getStats().agyConversationId`.
- **Empty responses fail**: an exit-0 result with a missing or blank response
  is treated as a failed turn, not a successful empty reply, and is not retried.
  A conversation id already received from `init` is kept for the next send. When
  the failure follows a tool confirmation refused in plan mode, the error says so
  (a fixed message; native log content is not exposed).
- **Refused tools**: when agy refuses tools but still replies, the refused tool
  names are exposed as `SendResult.permissionDenials` alongside the reply.
- `appendSystemPrompt`: agy has no system-prompt flag, so it is placed at the top
  of the first message of each new conversation.
- **Reasoning effort**: session `effort` and per-turn `session_send` overrides map
  to `--effort`. agy accepts `low`, `medium`, and `high`; everything above that
  (`xhigh`, `max`, `ultra`) clamps to `high`. agy requires an effort with unsuffixed base
  slugs such as `gemini-3.7-flash`, so `auto` resolves those to `high`; a model
  already ending in `-low`, `-medium`, or `-high` keeps that qualified effort.
  Per-turn overrides also work with qualified slugs: the adapter removes a
  conflicting suffix before passing the new `--effort`, avoiding agy's conflict
  error.

  Tiers are not uniform across agy models — `gemini-3.1-pro` (the `agy-pro`
  alias) offers `low` and `high` only, so `effort: 'medium'` on it fails with
  `gemini-3.1-pro has no "medium" effort (available: low, high)`. The adapter
  passes the requested effort through rather than substituting a tier the caller
  did not ask for; run `agy models` to see the tiers a slug actually exposes.

- Permission modes: `bypassPermissions` → `--dangerously-skip-permissions`,
  `default` and `manual` → `--sandbox` (terminal-restricted), and
  `sandboxMode: 'read-only'` → `--mode plan` (takes precedence). Other modes
  run agy's own approval flow, which can block in headless print mode. A caller
  must explicitly choose `bypassPermissions` for a write-enabled session; it is
  not a recovery mechanism. In particular, an Autoloop Planner stays on
  `--mode plan` when its preserved conversation is resumed.
- The engine always passes `--print-timeout` (the send timeout plus 5s), so the
  wrapper's timer decides when a turn ends; without it a stuck headless agy turn
  can run indefinitely
- Do not rely on an unknown `--model` falling back: current agy versions can
  report `status: ERROR` with no usable response. The adapter rejects result
  errors, non-success statuses, and empty responses. `agy-flash` and the engine
  default resolve to `gemini-3.8-flash`; `agy-pro` resolves to
  `gemini-3.1-pro`. The registry also describes the 3.5/3.6/3.7 Flash API
  families for pricing and routing, but agy's own `agy models` output decides
  which slugs are executable. agy also proxies Claude and GPT-OSS models, which
  pass through unregistered. The `agy/` prefix forces Antigravity routing for
  provider-like model strings.
- Consumer auth is a one-time `agy` Google OAuth login (subscription quotas, no
  per-token billing — registry pricing mirrors Gemini API rates as a value proxy)
- Requires `agy` installed: `curl -fsSL https://antigravity.google/cli/install.sh | bash`
- Binary: `agy` (set `AGY_BIN` env var to override)

```typescript
await manager.startSession({
  name: 'antigravity-task',
  engine: 'agy',
  model: 'gemini-3.8-flash',
  effort: 'high',
  cwd: '/project',
});
```

> **Legacy: `engine: 'gemini'`.** Google sunset the consumer Gemini CLI (tiers stopped
> serving 2026-06-18) in favour of Antigravity. The `gemini` engine still exists and
> still works — existing callers are not broken, and `gemini-*` model strings outside
> agy's registered slugs still route to it — but it is no longer a documented option,
> is not version-tracked, and gets no new work. Use `agy` for Google. (Unrelated: the
> multi-model **proxy** still talks to the Gemini **API**; that is a different
> subsystem and is unaffected.)

### Grok Build (`engine: 'grok'`)

Wraps xAI's **Grok Build** CLI. Each `send()` spawns `grok -p <msg> --output-format json`, which
prints a single JSON object and exits. Tested with `grok` **1.0.41**.

- **Cost comes from the engine, not from the price table.** The result object carries
  `total_cost_usd`, and the wrapper writes it straight into the session's spend, so the run ledger
  and the `maxBudgetUsd` gate both read what xAI charged. Other engines multiply tokens by a rate in
  `models.ts`. `grok-4.6` is still registered, for its context window and an indicative breakdown.
- **Real conversation continuity**: the `sessionId` from turn 1 is replayed as `--resume <id>`.
  `--continue` is not used — it means "the most recent session for this cwd", which collides
  between concurrent sessions.
- Real token counts from `usage` (`input_tokens`, `output_tokens`, `cache_read_input_tokens`).
  These are **per-turn**, unlike codex, where the same field is cumulative.
- Permission modes pass straight through: grok's `--permission-mode` takes the same vocabulary we
  use. The one exception is our `manual`, which grok spells `default`.
- Reasoning effort maps to `--effort`; grok accepts `low|medium|high|xhigh`, so `max` and `ultra`
  clamp to `xhigh`.
- Session options that reach grok: `appendSystemPrompt` → `--rules` (appends, unlike
  `systemPrompt` → `--system-prompt-override`, which replaces), `allowedTools` → `--tools`,
  `disallowedTools` → `--disallowed-tools`, `jsonSchema` → `--json-schema` (inline, and it implies the
  JSON output format already asked for), `agent` → `--agent`, `agents` → `--agents`,
  `dangerouslySkipPermissions` → `--always-approve`, `customSessionId` → `--session-id`, `forkSession`
  → `--fork-session`. **grok validates neither tool list**: a name that does not exist is ignored
  rather than rejected, so a typo in a denylist leaves the tool enabled. Prefer an allowlist.
- **`sandboxMode: 'read-only'` is refused.** A read-only `--tools` allowlist plus
  `--permission-mode plan` does not stop a delegated subagent from writing, because the subagent
  does not inherit the parent's tool restriction. A read-only grok session therefore throws at start instead of running
  writable.
- **On an exhausted free tier, `grok -p` may hang with no output instead of exiting with an error.**
  The session's turn timeout is then the only thing that ends the turn. If a grok turn times out with
  no output, run `grok -p` by hand to check your quota.
- Binary: `grok` (set `GROK_BIN` to override). Not `agent`: xAI's installer claims that name too,
  and so did Cursor's.
- Requires Grok Build: see `x.ai/cli`.

```typescript
await manager.startSession({
  name: 'grok-task',
  engine: 'grok',
  model: 'grok-4.6',
  cwd: '/project',
});
```

### Cursor Agent (`engine: 'cursor'`) — legacy

> **Legacy: `engine: 'cursor'`.** Superseded in this lineup by Grok Build (`engine: 'grok'`).
> The `cursor` engine still exists and still works — existing callers are not broken — but it is
> no longer a documented option, is not version-tracked, and gets no new work.
>
> Cursor itself is still maintained. It left the tracked set because it does not report which
> model ran (its `system` init event says `"model": "Auto"`), so costs cannot be attributed to a
> model, and because xAI's Grok installer also claims the bare `agent` binary name.

Wraps the Cursor Agent CLI with `-p --output-format stream-json`. Write-enabled sessions use `--force`. Each `send()` spawns a new process.

- Conversation continuity: the chat id from the first turn's `system` event is captured and passed back as `--resume <chatId>` on later sends, so the model sees prior turns. `--continue` is deliberately not used: it resumes "the latest chat", which collides between concurrent sessions.
- One-shot execution per message (no persistent subprocess)
- Working directory via `--workspace` flag
- Real token counts from stream-json `result` events (camelCase: `inputTokens`, `outputTokens`, `cacheReadTokens`)
- `--force` enables auto-approval of file changes. `sandboxMode: 'read-only'` does **not** use `--force`:
  - read-only is enforced by a `.cursor/cli.json` deny config (`Write`/`Edit`/`Shell` denied), written into an isolated temp dir used as the process cwd, with `--workspace` pointing at the real project (the repo tree is never modified)
  - `--mode plan` is passed as well, but it only steers the model; the deny config is the boundary
  - `--sandbox` is not added, since it does not restrict in-workspace writes and overrides the mode
  - read/grep/search remain available
- `--trust` auto-trusts the workspace without prompting
- Cursor uses its own model routing (e.g., `sonnet-4`, `gpt-5`, `auto`)
- Requires Cursor Agent CLI: `curl https://cursor.com/install -fsSL | bash`
- Binary: `cursor-agent` (set `CURSOR_BIN` env var to override). The generic `agent` name is
  deliberately not used: xAI's Grok installer symlinks `agent` to its own binary, which rejects
  `--force`/`--trust`/`--workspace` and fails the turn with "unexpected argument"

```typescript
await manager.startSession({
  name: 'cursor-task',
  engine: 'cursor',
  model: 'sonnet-4',
  cwd: '/project',
});
```

### Community engine presets

`customEngine` accepts either an inline `CustomEngineConfig` or the id of a preset
bundled in `configs/engines/`. The preset form exists so a third-party CLI is
described once and shipped, rather than retyped by every caller.

Engines fall into three tiers, decided by how they are verified. Bundled presets
are always `community`:

| Tier          | Maintainer  | What is verified                                                                                    |
| ------------- | ----------- | --------------------------------------------------------------------------------------------------- |
| **core**      | Maintainers | Wrapped in code, exercised live weekly, pinned to a tested version                                  |
| **community** | Contributor | The schema is validated and the preset ships. Whether it runs is the maintainer's dated attestation |
| **legacy**    | —           | Still wired, no longer tracked                                                                      |

A community preset must name its maintainer and the engine version and date it
was verified against (`provenance.maintainer`, `provenance.verifiedAgainst`,
`provenance.verifiedOn`), with a link to the captured smoke-test transcript.

A preset never carries protocol translation. A CLI speaking its own wire format
needs an adapter binary in its author's package, with the preset pointing `bin`
at it — as `@enderfga/dsh-clawo` does.

Over HTTP — which includes the `clawo` CLI — a custom engine may be given **only**
as a preset id. An inline config names a binary and its arguments and is refused
there; a preset id cannot introduce either, so it is the same class as naming a
built-in engine, and `engine: 'codex'` already spawns an executable over that
surface. Presets are therefore the supported way to reach a custom engine from
the CLI: `clawo engines` lists what is bundled, and
`clawo session-start <name> -e custom --custom-engine <id>` starts one.

Contribution steps and the smoke script: [CONTRIBUTING.md](../../CONTRIBUTING.md#contributing-an-engine).

### OpenCode (`engine: 'opencode'`)

Wraps the [sst/opencode](https://github.com/sst/opencode) CLI with `run --format json`. Each `send()` spawns a new process.

- Conversation continuity: the session id from the event envelope is captured and passed back as `--session <id>` on later sends, so the model sees prior turns. `--continue` is deliberately not used: it means "the last session on this machine", which collides between concurrent sessions.
- One-shot execution per message (no persistent subprocess)
- NDJSON event stream with envelope `{ type, timestamp, sessionID, ... }`
- Event types: `text`, `reasoning`, `tool_use`, `step_start`, `step_finish`, `error`
- `text` and `tool_use` are **cumulative snapshots** keyed by `part.id` / `part.callID`; the wrapper diffs them to produce streaming deltas for `onText` callbacks and counts each tool invocation once
- Real token counts from `step_finish.part.tokens.{input,output,cache.{read,write}}`. **`input` is the uncached remainder only** — opencode's own `total` is `input + output + cache.read + cache.write` — so the cached part is billed on top of it, not carved out of it, and `contextPercent` is measured against the whole input side. On a resumed turn the uncached remainder is usually a small fraction of the cached part
- Reasoning effort maps to `--variant`, opencode's provider-specific effort knob. opencode does not validate the value: a level the provider does not offer runs the turn at its default rather than failing
- `appendSystemPrompt`: opencode has no system-prompt flag, so it is placed at the top of the first message of each new conversation
- The wrapper closes the subprocess's stdin immediately after spawn (opencode otherwise reads stdin and blocks on EOF, hanging the call)
- Provider-agnostic: opencode's `--model` expects `provider/model` form (e.g. `anthropic/claude-sonnet-4`). The wrapper passes `--model` through only when the value contains a `/`; otherwise opencode's own default applies
- `sandboxMode: 'read-only'` runs a generated `clawo-readonly` agent (`--agent clawo-readonly` plus an `OPENCODE_CONFIG_CONTENT` env var defining it):
  - it denies `edit`, `bash`, `external_directory`, `webfetch` and `task` at the permission level, and also removes those tools via the agent's `tools` map
  - denying `task` matters: otherwise the agent can hand a write to a subagent that runs under the default writable agent
  - OpenCode's built-in `plan` agent is not used, because it permits both `bash` and `edit`
  - if the `clawo-readonly` agent fails to load, the turn is refused rather than run with write access
  - to test a change to this config, use adversarial prompts that include asking the agent to delegate; `opencode agent list` shows compiled rules that look the same for a safe and an unsafe agent
- Requires opencode installed: `brew install sst/tap/opencode` or `npm install -g opencode-ai`. Auth via `opencode auth login` **or** any provider env var (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, etc.) — opencode picks up either path
- Binary: `opencode` (set `OPENCODE_BIN` env var to override). **Windows:** npm `.cmd` shims launch via `src/engine-spawn.ts` (cross-spawn) — same quoting limits as the codex entry above.

```typescript
await manager.startSession({
  name: 'opencode-task',
  engine: 'opencode',
  model: 'anthropic/claude-sonnet-4',
  cwd: '/project',
});
```

> **Schema stability:** opencode releases nearly daily and the JSON event schema is not formally documented. The parser tolerates unknown event types and missing fields — but pin a tested `opencode` version in CI if you depend on field names.

## ISession Interface

All engines implement `ISession`, making them interchangeable at the `SessionManager` level:

```typescript
interface ISession {
  // State
  sessionId?: string;
  readonly isReady: boolean;
  readonly isPaused: boolean;
  readonly isBusy: boolean;

  // Lifecycle
  start(): Promise<this>;
  stop(): void;
  pause(): void;
  resume(): void;

  // Communication
  send(message, options?): Promise<TurnResult | { requestId; sent }>;

  // Observability
  getStats(): SessionStats & { sessionId?; uptime };
  getHistory(limit?): Array<{ time; type; event }>;
  getCost(): CostBreakdown;

  // Context
  compact(summary?): Promise<TurnResult | { requestId; sent }>;
  getEffort(): EffortLevel;
  setEffort(level): void;

  // Model
  resolveModel(alias): string;

  // Events (EventEmitter)
  on(event, listener): this;
  emit(event, ...args): boolean;
}
```

`SessionStats` requires `turnsSucceeded` as well as `turns`, so an engine that
implements this interface has to say which of its turns succeeded — the exit code
is not the answer on every engine. See "Stats & Monitoring" in `sessions.md`.

## Team Tools Across Engines

Team tools (`team_list`, `team_send`) operate on the same virtual-team layer for **every** engine: the "team" is the set of all active sessions managed by SessionManager.

| Engine              | `team_list`                                | `team_send`                    |
| ------------------- | ------------------------------------------ | ------------------------------ |
| Claude              | Lists other active SessionManager sessions | Routes via cross-session inbox |
| Codex / `codex-app` | Lists other active SessionManager sessions | Routes via cross-session inbox |
| Antigravity         | Lists other active SessionManager sessions | Routes via cross-session inbox |
| Grok                | Lists other active SessionManager sessions | Routes via cross-session inbox |
| OpenCode            | Lists other active SessionManager sessions | Routes via cross-session inbox |
| Custom              | Lists other active SessionManager sessions | Routes via cross-session inbox |

Messages are delivered via the inbox system — idle sessions receive immediately, busy sessions queue for later delivery.

> **Note:** Claude Code does have a native experimental "Agent Teams" feature (v2.1.32+, `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`), but it is an in-process TUI mechanism with no slash command or stdin-driven messaging — a subprocess wrapper cannot access its mailbox. Plugin team tools therefore use the engine-agnostic virtual team across the board.

## Proxy: Any Model via OpenClaw Gateway

Claude Code CLI only speaks Anthropic protocol. The built-in proxy translates Anthropic ↔ OpenAI format, letting you drive Claude Code with **any model** routed through the OpenClaw gateway.

### Zero Config

If OpenClaw gateway is running, everything is automatic:

```typescript
// No baseUrl, no env vars, no extra config
await manager.startSession({
  name: 'task',
  engine: 'claude',
  model: 'openclaw', // gateway routes to your configured model
  cwd: '/project',
});
```

What happens behind the scenes:

1. Plugin reads `~/.openclaw/openclaw.json` for gateway port + auth
2. Starts a local proxy server (random port, auto-managed)
3. Claude Code CLI sends Anthropic-format requests → proxy converts to OpenAI → gateway → any model

### Manual Config (optional)

Override with environment variables if needed:

| Variable         | Default                          | Description                                         |
| ---------------- | -------------------------------- | --------------------------------------------------- |
| `GATEWAY_URL`    | Auto-detected from openclaw.json | Gateway endpoint (e.g. `http://127.0.0.1:18789/v1`) |
| `GATEWAY_KEY`    | Auto-detected from openclaw.json | Gateway auth password/token                         |
| `GEMINI_API_KEY` | -                                | Direct Gemini API access (bypasses gateway)         |
| `OPENAI_API_KEY` | -                                | Direct OpenAI API access (bypasses gateway)         |

### Architecture

```
Claude Code CLI (Anthropic format)
  → Auto-proxy (Anthropic → OpenAI conversion)
    → OpenClaw Gateway (/v1/chat/completions, model="openclaw")
      → Any model (Gemini, GPT, local, etc.)
```

## Custom Engine (`engine: 'custom'`)

Integrate **any** coding agent CLI without writing engine-specific code. You provide a `CustomEngineConfig` that maps your CLI's flags to OpenClaw session concepts.

Two protocol modes:

- **Persistent** (`persistent: true`) — long-running subprocess with stream-json I/O over stdin/stdout (like Claude Code)
- **One-shot** (`persistent: false`, default) — new process spawned per `send()` (like Codex/Antigravity)

### CustomEngineConfig

| Field              | Type     | Required | Description                                                  |
| ------------------ | -------- | -------- | ------------------------------------------------------------ |
| `name`             | string   | yes      | Display name (used in logs, session IDs)                     |
| `bin`              | string   | yes      | Binary path or command name                                  |
| `binEnv`           | string   |          | Env var name that overrides `bin` at runtime                 |
| `persistent`       | boolean  |          | `true` = persistent subprocess, `false` = one-shot (default) |
| `args`             | object   | yes      | CLI flag mappings (see below)                                |
| `permissionModes`  | object   |          | Maps OpenClaw mode names to CLI-specific values              |
| `pricing`          | object   |          | `{ input, output, cached? }` per 1M tokens                   |
| `contextWindow`    | number   |          | Context window size (default: 200,000)                       |
| `env`              | object   |          | Extra environment variables for the CLI process              |
| `sanitizePatterns` | string[] |          | Regex patterns to redact from stderr                         |

### args field

| Key                      | Example                        | Description                                |
| ------------------------ | ------------------------------ | ------------------------------------------ |
| `print`                  | `"-p"`                         | Non-interactive/print mode flag            |
| `outputFormat`           | `"--output-format"`            | Output format flag                         |
| `outputFormatValue`      | `"stream-json"`                | Value for stream-json output               |
| `inputFormat`            | `"--input-format"`             | Input format flag (persistent only)        |
| `inputFormatValue`       | `"stream-json"`                | Value for stream-json input                |
| `skipPermissions`        | `"-y"`                         | Skip all permissions flag                  |
| `permissionMode`         | `"--permission-mode"`          | Permission mode flag                       |
| `model`                  | `"--model"`                    | Model selection flag                       |
| `systemPrompt`           | `"--system-prompt"`            | System prompt override flag                |
| `appendSystemPrompt`     | `"--append-system-prompt"`     | Append system prompt flag                  |
| `maxTurns`               | `"--max-turns"`                | Max agent turns flag                       |
| `resume`                 | `"--resume"`                   | Session resume flag (persistent only)      |
| `verbose`                | `"--verbose"`                  | Verbose output flag                        |
| `replayUserMessages`     | `"--replay-user-messages"`     | Replay user messages (persistent only)     |
| `includePartialMessages` | `"--include-partial-messages"` | Include partial messages (persistent only) |
| `effort`                 | `"--effort"`                   | Effort level flag                          |
| `workspace`              | `"--workspace"`                | Workspace/cwd flag (one-shot only)         |
| `extra`                  | `["--trust"]`                  | Additional static arguments                |

### Example: Persistent mode (Claude Code-compatible CLI)

```typescript
await manager.startSession({
  name: 'my-agent-task',
  engine: 'custom',
  cwd: '/project',
  customEngine: {
    name: 'my-agent',
    bin: 'my-agent',
    binEnv: 'MY_AGENT_BIN',
    persistent: true,
    args: {
      print: '-p',
      outputFormat: '--output-format',
      outputFormatValue: 'stream-json',
      inputFormat: '--input-format',
      inputFormatValue: 'stream-json',
      skipPermissions: '-y',
      permissionMode: '--permission-mode',
      model: '--model',
      systemPrompt: '--system-prompt',
      appendSystemPrompt: '--append-system-prompt',
      maxTurns: '--max-turns',
      resume: '--resume',
      verbose: '--verbose',
      replayUserMessages: '--replay-user-messages',
      includePartialMessages: '--include-partial-messages',
    },
    pricing: { input: 3, output: 15, cached: 0.3 },
    contextWindow: 200_000,
    sanitizePatterns: ['MY_API_KEY=[^\\s]+'],
  },
});
```

### Example: One-shot mode (simple CLI)

```typescript
await manager.startSession({
  name: 'simple-agent-task',
  engine: 'custom',
  cwd: '/project',
  customEngine: {
    name: 'simple-agent',
    bin: '/usr/local/bin/simple-agent',
    persistent: false, // default
    args: {
      print: '-p',
      outputFormat: '--output-format',
      outputFormatValue: 'stream-json',
      skipPermissions: '--yolo',
      model: '--model',
      workspace: '--workspace',
      extra: ['--no-color'],
    },
    permissionModes: {
      bypassPermissions: 'yolo',
      default: 'sandbox',
    },
    pricing: { input: 1, output: 5 },
  },
});
```

### Example: Google Antigravity CLI (`agy`)

Use the built-in [`engine: 'agy'`](#google-antigravity-engine-agy) instead of a custom config.

### Custom Engine in Council

Custom engines work in council by setting `engine: 'custom'` and `customEngine` on the agent persona:

```typescript
manager.councilStart('Build feature X', {
  agents: [
    {
      name: 'Planner',
      emoji: '🟠',
      persona: 'Architecture expert',
      engine: 'custom',
      customEngine: { name: 'my-agent', bin: 'my-agent', persistent: true, args: { ... } },
    },
    { name: 'Reviewer', emoji: '🔵', persona: 'Code reviewer', engine: 'claude', model: 'opus' },
  ],
  maxRounds: 10,
  projectDir: '/project',
});
```

## Adding a New Built-in Engine

To add a built-in engine (for CLIs that need custom protocol handling beyond what `CustomEngineConfig` supports):

1. Create `src/persistent-<engine>-session.ts` implementing `ISession`
2. Add the engine name to `ENGINE_TYPES` (from which `EngineType` is derived) and its binary to `ENGINE_BINARY_NAMES` in `src/types.ts`
3. Add a case to `engineHasNativeConversation()` in `src/types.ts` and, if the engine resumes a conversation by id, to `nativeThreadIsLive()` in `src/openai-compat.ts`
4. Add a case to `SessionManager._createSession()`
5. Add model pricing to `MODELS[]` in `src/models.ts`

The `ISession` interface is deliberately minimal — each engine handles its own subprocess bootstrapping, I/O protocol, and cleanup internally.

For most third-party CLIs, the `custom` engine with `CustomEngineConfig` is sufficient and requires zero code changes.
