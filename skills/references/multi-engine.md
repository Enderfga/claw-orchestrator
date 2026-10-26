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
├── engine: 'opencode'  → PersistentOpencodeSession
│   └── Wraps: opencode run --format json, message on stdin (per-message spawning)
├── engine: 'acp'       → PersistentAcpSession
│   └── Wraps: any Agent Client Protocol agent on stdio (long-running, one ACP session)
└── engine: 'custom'    → PersistentCustomSession
    └── Wraps: any CLI via user-provided CustomEngineConfig
```

The `gemini` and `cursor` engines are legacy: still wired for existing callers, not documented
as options (see the notes under [Antigravity](#google-antigravity-engine-agy) and
[Grok Build](#grok-build-engine-grok)).

### At a glance

| Engine      | Process                             | How the conversation carries over                                       | Where cost comes from                                                  |
| ----------- | ----------------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `claude`    | one long-running `claude -p`        | the live process; `--resume <id>` when a session is restarted           | the CLI's own `total_cost_usd` (registry estimate in proxy mode)       |
| `codex`     | one `codex exec` per send           | `codex exec resume <thread_id>`                                         | registry price × reported tokens                                       |
| `codex-app` | one long-running `codex app-server` | the live thread; `thread/resume` when a session is restarted            | registry price × reported tokens                                       |
| `agy`       | one `agy -p` per send               | `--conversation <id>`                                                   | registry price × reported tokens                                       |
| `grok`      | one `grok -p` per send              | `--resume <sessionId>`                                                  | grok's own `total_cost_usd`                                            |
| `opencode`  | one `opencode run` per send         | `--session <id>`                                                        | opencode's own `step_finish` cost (registry estimate when none)        |
| `acp`       | one long-running agent process      | one ACP session; `session/resume` or `session/load` on restart          | what the agent reports (estimated from `pricing` when it reports none) |
| `custom`    | persistent, or one process per send | persistent: the live process (`args.resume` on restart); one-shot: none | registry price × reported tokens (see `pricing` below)                 |

## Supported Engines

### Claude Code (`engine: 'claude'`)

Default engine. Long-running subprocess with streaming JSON I/O. Tested with Claude Code CLI **2.1.310**.

- Persistent multi-turn conversations
- Real-time streaming (text, tool_use, tool_result, system events)
- Session resume via `--resume`
- Cost is the CLI's own `total_cost_usd`, which prices cache writes. It is a running total for the
  process, so spend advances by the difference between reports. The registry estimate is used
  instead in proxy mode (the CLI is told it runs `opus`) and for the first turn of a process started
  with `--resume`, whose first report includes the spend of the turns it resumed
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

Wraps the `codex exec` subcommand. Each `send()` spawns a new process. Tested with `codex` CLI **0.164.0**.

- Non-interactive execution via `codex exec --sandbox workspace-write --skip-git-repo-check --json`
- Real `usage` from the `turn.completed` JSON event (input, output, cached, reasoning tokens). **These are cumulative over the thread, not per turn**, so they replace the session totals rather than being added to them; subtracting consecutive values gives one turn's prompt
- `contextPercent` is the per-turn prompt measured against **codex's own context limit** (`model_context_window`, read from the thread's rollout file), not the model's published window in the registry. Resuming a thread also seeds the token baseline from the rollout, so the first send does not count the whole thread history as one prompt. This is best-effort: an unreadable or `--ephemeral` thread falls back to the registry window
- `item.completed` parsing distinguishes `reasoning` / `todo_list` (logged, not counted) from real tool items (`command_execution`, `file_change`, `mcp_tool_call`, `web_search`, which increment `toolCalls`; a non-zero `command_execution.exit_code` increments `toolErrors`)
- Reasoning effort: the engine-agnostic `effort` maps to `-c model_reasoning_effort=<level>` for `low|medium|high|xhigh|max|ultra`; `auto` passes nothing. Only those levels are passed, because codex does not validate `-c` values at spawn: an unlisted one would fail at the API rather than at the command line
- `appendSystemPrompt`: codex has no system-prompt flag, so it is placed at the top of the first message of each new conversation (a resumed thread already carries it)
- `jsonSchema` → `--output-schema <file>` (written to a temp file, accepted by `exec` and `exec resume`)
- `noSessionPersistence` → `--ephemeral` (accepted by `exec` and `exec resume`); `ignoreUserConfig` → `--ignore-user-config`, which stops `$CODEX_HOME/config.toml` from choosing the model for an orchestrated run (auth still resolves from `CODEX_HOME`); `addDir` → `--add-dir` on the first turn only, since `exec resume` rejects it and the resumed thread keeps the roots it opened with
- `codexProfile` → `--profile <name>` (named config profile from `~/.codex/config.toml`), first turn only
- `--worktree` is not passed. With it, codex writes the turn's edits to `~/.codex/worktrees/<hash>/<repo>` instead of the session's `cwd`, while acceptance contracts, evidence diffs and the baseline change set all read the session's `cwd`. Council's per-agent git worktrees cover the isolation use case
- Continuity: the `thread_id` from the first turn's `thread.started` event is captured and reused via `codex exec resume <id>` for later sends, so the model sees prior turns. The id is persisted too, so a restarted session (and `resumeSessionId`) resumes the same thread
- `sandboxMode` maps to `--sandbox <mode>` on the first turn (default `workspace-write`). A resumed thread does not keep it, and `codex exec resume` rejects `--sandbox`, so the policy is restated as `-c sandbox_mode="<mode>"` on every resumed turn
- Working directory passed via `-C` on the first turn
- Model: with no `model`, codex runs its own default — the `model` in `~/.codex/config.toml` if set. Cost is then priced as the model codex reports it ran (the rollout's `turn_context`; `thread/start` on `codex-app`), and as `gpt-5.5` only when that cannot be read. Cached reads are inside codex's `input_tokens`, so they are taken out and priced at the cached rate
- Requires `codex` CLI >= 0.119 (for `exec resume`): `npm install -g @openai/codex`
- The prompt is sent on stdin (`codex exec … -`), never on the command line.
- **Windows:** the npm `.cmd` shim launches through `src/engine-spawn.ts` (cross-spawn), which escapes the remaining arguments for `cmd.exe`. Because the prompt is on stdin it arrives unchanged, newlines and quotes included. A timed-out turn ends the whole process tree (`taskkill /T /F`), not only `cmd.exe`.
- **Image generation**: ask for an image and Codex generates it with its built-in tool and saves it under
  `$CODEX_HOME/generated_images/<thread_id>/`. `codex exec --json` reports no event for it, so the
  adapter lists the files the turn added there and returns them as `images` on the send result
  (`codex-app` reads them from the `imageGeneration` item, with the revised prompt). It uses the
  account's image-generation allowance.
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

Wraps `codex app-server --listen stdio:// --enable goals` as a long-running JSON-RPC subprocess. **Required for `/goal` long-horizon objective support** — Codex's exec subcommand has no goal surface. Tested with `codex` CLI **0.164.0**.

- Long-running subprocess; one `codex app-server` per session
- JSON-RPC 2.0 over stdio with v2 protocol method names (`initialize`, `thread/start`, `turn/start`, ...)
- Real-time streaming via `item/agentMessage/delta` notifications
- Cumulative token tracking from `thread/tokenUsage/updated` notifications. The same notification's `last` breakdown and `modelContextWindow` drive `contextPercent`, so it reports live occupancy against the window the server enforces rather than a running total over the model's published window
- `appendSystemPrompt` is placed at the top of the first message of a new thread (app-server has no system-prompt flag); a resumed thread already carries it
- Reasoning effort: the session `effort` opens or resumes the thread with `config: { model_reasoning_effort }`, so the goal loop's own turns use it too, and each `turn/start` carries `effort` (the per-send override, else the session's), so `setEffort` reaches the next turn. The levels are the same as `codex`'s; `auto` passes nothing, and codex keeps the last effort it was sent for the turns after it
- Goals through the typed RPCs `thread/goal/set` / `get` / `clear`: setting an objective starts the server's own turn loop, which runs until the goal is `complete`, `budgetLimited`, `blocked`, `usageLimited` or `paused`. Each change arrives as `thread/goal/updated`. The `codex_goal_*` tools wrap these; the kernel's `goal` node drives them for unattended runs ([workflow.md](./workflow.md#goal))
- `error` notifications are read as `{ error: { message, codexErrorInfo }, willRetry }`. The session keeps the last one (`lastError`, with `codexErrorInfo` as a name such as `serverOverloaded`) and emits it as `codex:error`; an error notification never throws when nothing listens for errors
- v2 RPC tools (Codex 0.137): `codex_interrupt` (`turn/interrupt`), `codex_steer` (`turn/steer`, including into a turn the goal loop started), `codex_fork` (`thread/fork`), `codex_rollback` (`thread/rollback`), `codex_models` (`model/list`), `codex_thread_list` (`thread/list`). A `turn/completed` with `status: 'failed'` rejects the turn and increments `toolErrors`.
- Threads are opened and resumed with `approvalPolicy: "never"`, and a server request the session cannot handle (an approval, a request for user input) gets an error reply at once: nothing here can answer one, and an unanswered request blocks its turn. The sandbox mode is the boundary.
- Thread resume: starting with `resumeSessionId` loads the existing thread via `thread/resume` instead of `thread/start`. The id the session manager stores and replays (model switch, restart) is the app-server's own thread id. A thread resumed with an active goal continues it on its own. An id that `thread/resume` rejects falls back to a new thread (logged); the `goal` node refuses that case rather than start the goal over.
- `compact` asks the app-server to compact the thread (`thread/compact/start`).
- `clawo goal "<objective>" --check "npm test"` runs the `goal` workflow from the command line: one goal on one thread, then the runtime's own checks, then repair on the same thread ([cli.md](./cli.md#clawo-goal)).

```typescript
await manager.startSession({
  name: 'codex-goal-task',
  engine: 'codex-app',
  model: 'gpt-5.5',
  cwd: '/project',
});
await manager.codexGoal('codex-goal-task', { action: 'set', objective: 'build a tic-tac-toe app' });
// or via the codex_goal_set tool:
//   await tool('codex_goal_set', { name: 'codex-goal-task', objective: 'build a tic-tac-toe app' });
```

### Google Antigravity (`engine: 'agy'`)

Wraps Google's **Antigravity CLI** (`agy`) — the successor to Gemini CLI (consumer
Gemini CLI tiers stopped serving 2026-06-18). Each `send()` spawns a new process
in print mode, with the message as the `-p` argument. Tested with `agy` **1.4.6**.

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

- Permission modes: `bypassPermissions` (or `dangerouslySkipPermissions`) →
  `--dangerously-skip-permissions`, `default` and `manual` → `--sandbox`
  (terminal-restricted), and
  `sandboxMode: 'read-only'` → `--mode plan` (takes precedence). Other modes
  run agy's own approval flow, which can block in headless print mode. A caller
  must explicitly choose `bypassPermissions` for a write-enabled session; it is
  not a recovery mechanism. In particular, an Autoloop Planner stays on
  `--mode plan` when its preserved conversation is resumed.
- The engine always passes `--print-timeout`, set just inside the send timeout
  (10% earlier, at most 10s). Since agy 1.2.9 a headless run whose agent started a
  background task (a dev server, a watcher) stays open until that deadline and
  delivers the reply when it exits, ending the task; the earlier deadline lets it
  do so before the send times out. A run that reaches the deadline while the agent
  is still working fails as a timeout even though agy reports `SUCCESS` with a
  partial reply. Without the flag a stuck headless agy turn can run indefinitely
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
  per-token billing — registry pricing mirrors Gemini API rates as a value proxy).
  An effort-qualified slug such as `gemini-3.1-pro-high` is priced as its base model
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
> still works for existing callers, but it is no longer a documented option, is not
> version-tracked, and gets no new work. Use `agy` for Google. The OpenAI-compatible
> endpoint and the ACP agent pick the engine from the model name, and there `gemini-*`
> strings outside agy's registered slugs (including the `gemini-pro` and `gemini-flash`
> aliases) still route to the `gemini` engine. (Unrelated: the multi-model **proxy**
> still talks to the Gemini **API**; that is a different subsystem and is unaffected.)

### Grok Build (`engine: 'grok'`)

Wraps xAI's **Grok Build** CLI. Each `send()` spawns `grok -p <msg> --output-format json`, which
prints a single JSON object and exits. Tested with `grok` **1.0.70**.

- **Cost comes from the engine, not from the price table.** The result object carries
  `total_cost_usd`, and the wrapper writes it straight into the session's spend, so the run ledger
  and the `maxBudgetUsd` gate both read what xAI charged. Other engines multiply tokens by a rate in
  `models.ts`. `grok-4.7` (grok's default since 1.0.67) and `grok-4.6` are still registered, for
  their context window and an indicative breakdown; with no `model` set, the session is labelled with
  the model grok reports under `modelUsage`.
- **Real conversation continuity**: the `sessionId` from turn 1 is replayed as `--resume <id>`.
  `--continue` is not used — it means "the most recent session for this cwd", which collides
  between concurrent sessions.
- Real token counts from `usage` (`input_tokens`, `output_tokens`, `cache_read_input_tokens`,
  `cache_creation_input_tokens`). These are **per-turn**, unlike codex, where the same field is
  cumulative, and `input_tokens` excludes the cached reads.
- Permission modes pass straight through: grok's `--permission-mode` takes the same vocabulary we
  use. The one exception is our `manual`, which grok spells `default`.
- Reasoning effort maps to `--effort`; grok accepts `low|medium|high|xhigh`, so `max` and `ultra`
  clamp to `xhigh`.
- Session options that reach grok: `cwd` → `--cwd`, `appendSystemPrompt` → `--rules` (appends,
  unlike `systemPrompt` → `--system-prompt-override`, which replaces), `maxTurns` → `--max-turns`,
  `allowedTools` → `--tools`, `disallowedTools` → `--disallowed-tools`, `jsonSchema` →
  `--json-schema` (inline, and it implies the JSON output format already asked for), `agent` →
  `--agent`, `agents` → `--agents`, `dangerouslySkipPermissions` → `--always-approve`,
  `forkSession` → `--fork-session` (on a resumed turn), `customSessionId` → `--session-id` (on a
  first turn, or a forked one). **grok validates neither tool list**: a name that does not exist is
  ignored rather than rejected, so a typo in a denylist leaves the tool enabled. Prefer an allowlist.
- **`sandboxMode: 'read-only'` runs inside grok's `--sandbox read-only` profile**, which the OS
  enforces (Seatbelt on macOS, Landlock on Linux) for the whole process tree: the session reads
  anywhere and can write only to `~/.grok/` and the temp directory. Measured on 1.0.50 with
  `bypassPermissions`: a direct write, a shell write, a delegated subagent, a write on a resumed turn
  and a write outside the project all fail with `Operation not permitted`. A tool allowlist was not
  enough — a delegated subagent does not inherit it. Three cases are refused rather than claimed:
  - a project under the temp directory, which the profile leaves writable;
  - a platform other than macOS or Linux;
  - a sandbox grok reports it could not apply. grok itself would carry on unsandboxed; the session
    kills the process on that warning, which grok prints at startup before any model call.

  Child-process network access is not blocked on macOS (grok enforces that part on Linux only).

- **On an exhausted free tier grok answers with an error object** (`{"type":"error","message":...}`),
  and the session reports that message as the turn's error.
- Binary: `grok` (set `GROK_BIN` to override). Not `agent`: xAI's installer claims that name too,
  and so did Cursor's.
- Requires Grok Build: see `x.ai/cli`.

```typescript
await manager.startSession({
  name: 'grok-task',
  engine: 'grok',
  model: 'grok-4.7',
  cwd: '/project',
});
```

> **Legacy: `engine: 'cursor'`.** Superseded in this lineup by Grok Build. The `cursor` engine
> still exists and still works for existing callers — it runs `cursor-agent` (`CURSOR_BIN`
> overrides it, never the bare `agent` name) and resumes a chat with `--resume <chatId>` — but it
> is no longer a documented option, is not version-tracked, and gets no new work. It left the
> tracked set because its stream does not say which model ran, so its cost cannot be attributed
> to a model. On the OpenAI-compatible endpoint and the ACP agent,
> `composer-*` and `auto` model names still route to it.

### OpenCode (`engine: 'opencode'`)

Wraps the [OpenCode](https://github.com/anomalyco/opencode) CLI with `run --format json`. Each `send()` spawns a new process. Tested with `opencode` **1.19.4**.

- Conversation continuity: the session id from the event envelope is captured and passed back as `--session <id>` on later sends, so the model sees prior turns. `--continue` is deliberately not used: it means "the last session on this machine", which collides between concurrent sessions.
- NDJSON event stream with envelope `{ type, timestamp, sessionID, ... }`
- Event types: `text`, `reasoning`, `tool_use`, `step_start`, `step_finish`, `error`
- `text` and `tool_use` are **cumulative snapshots** keyed by `part.id` / `part.callID`; the wrapper diffs them to produce streaming deltas for `onText` callbacks and counts each tool invocation once
- Real token counts from `step_finish.part.tokens.{input,output,cache.{read,write}}`. **`input` is the uncached remainder only** — opencode's own `total` is `input + output + cache.read + cache.write` — so the cached part is billed on top of it, not carved out of it, and `contextPercent` is measured against the whole input side. On a resumed turn the uncached remainder is usually a small fraction of the cached part
- Cost is what opencode reports on each `step_finish` (`part.cost`), so a free model costs $0; the registry estimate applies only when no cost is reported. `opencode run --format json` does not name the model it ran
- Reasoning effort maps to `--variant`, opencode's provider-specific effort knob. opencode does not validate the value: a level the provider does not offer runs the turn at its default rather than failing
- `appendSystemPrompt`: opencode has no system-prompt flag, so it is placed at the top of the first message of each new conversation
- The message is written to the subprocess's stdin, which is then closed: opencode waits for EOF before it starts
- Provider-agnostic: opencode's `--model` expects `provider/model` form (e.g. `anthropic/claude-sonnet-4`). The wrapper passes `--model` through only when the value contains a `/`; otherwise opencode's own default applies
- `sandboxMode: 'read-only'` runs a generated `clawo-readonly` agent (`--agent clawo-readonly` plus an `OPENCODE_CONFIG_CONTENT` env var defining it):
  - it denies `edit`, `bash`, `external_directory`, `webfetch` and `task` at the permission level, and also removes those tools via the agent's `tools` map
  - denying `task` matters: otherwise the agent can hand a write to a subagent that runs under the default writable agent
  - OpenCode's built-in `plan` agent is not used, because it permits both `bash` and `edit`
  - if the `clawo-readonly` agent fails to load, the turn is refused rather than run with write access
  - to test a change to this config, use adversarial prompts that include asking the agent to delegate; `opencode agent list` shows compiled rules that look the same for a safe and an unsafe agent
- Requires OpenCode 1.x: `npm install -g opencode-ai` or `brew install anomalyco/tap/opencode`. Auth via `opencode auth login` **or** any provider env var (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, etc.) — opencode picks up either path
- **OpenCode 2 is refused at session start.** Its `run --format json` keeps the event envelope but drops `step_finish` (no tokens or cost) and the `--variant` flag, and the read-only agent could not be verified on it (measured on the `0.0.0-beta-17823` build). The session reads `opencode --version` once and refuses a 2.x or `0.0.0-beta` build with that reason; if the version cannot be read, it starts as before. OpenCode 2 is what `opencode upgrade --major`, the `@opencode/cli` npm package and the `opencode-v2` Homebrew formula install.
- Binary: `opencode` (set `OPENCODE_BIN` env var to override). **Windows:** the npm `.cmd` shim launches through `src/engine-spawn.ts` (cross-spawn), as for codex above.

```typescript
await manager.startSession({
  name: 'opencode-task',
  engine: 'opencode',
  model: 'anthropic/claude-sonnet-4',
  cwd: '/project',
});
```

> **Schema stability:** opencode releases nearly daily and the JSON event schema is not formally documented. The parser tolerates unknown event types and missing fields — but pin a tested `opencode` version in CI if you depend on field names.

### ACP agents (`engine: 'acp'`)

Drives any agent that serves the [Agent Client Protocol](https://agentclientprotocol.com) on stdio, with no per-agent code. Run through it so far: Kimi Code 2.3.1 (`kimi acp`), DeepSeek's dsh 0.2.1-rc.2 (`dsh --profile acp`) and OpenCode 1.19.4 (`opencode acp`). This is the client side of the protocol; [acp.md](./acp.md) is the other side, where the orchestrator is the agent.

- `acpAgent` names the agent: a bundled preset id (`kimi-code`, `dsh`; `clawo engines` lists them), or, from a local caller only, an inline `{ name, command, commandEnv?, args?, env?, contextWindow?, pricing? }`. Over HTTP, which includes the `clawo` CLI, only a preset id is accepted, as for `customEngine`.
- One agent process per session; each send is one `session/prompt` on one ACP session, so the conversation carries over between sends. `initialize` advertises no `fs` or `terminal` capability: the agent reads, writes and runs commands with its own tools.
- A turn succeeds when the agent ends it with `stopReason: "end_turn"`; any other stop reason (`refusal`, `max_tokens`, `cancelled`, …) fails it. A turn that runs past its timeout is cancelled with `session/cancel`. An agent that exits mid-turn fails the turn and the session.
- `session/request_permission` is answered at once from `permissionMode`: `bypassPermissions`, `acceptEdits`, `auto` and `dontAsk` pick an allow option, the others a reject option. Nothing waits on a person.
- Resume: the agent's session id is the resume id (`stats.acpSessionId`). A resumed session reattaches it with `session/resume`, or `session/load` when that is all the agent offers; an agent with neither fails the start rather than opening a new conversation.
- Usage and cost are whatever the agent reports (`PromptResponse.usage`, `usage_update`). With `pricing` set and no reported cost, the cost is estimated from the reported tokens. Kimi Code 2.3.1 and dsh 0.2.1-rc.2 report neither, so their sessions show 0 tokens and $0. OpenCode reports tokens.
- `sandboxMode: 'read-only'` is refused at start. The agent's tools run inside the agent process and this client sees only the permission requests the agent chooses to send, so nothing here can stop a write. `permissionMode: 'plan'` rejects every permission request the agent does send.
- The model and credentials are the agent's own configuration, set in its environment; the session's `model` and `effort` are not sent to the agent, and `compact` is left to it:
  - Kimi Code: `KIMI_MODEL_NAME`, `KIMI_MODEL_API_KEY`, `KIMI_MODEL_BASE_URL`, `KIMI_MODEL_MAX_CONTEXT_SIZE`, `KIMI_MODEL_CAPABILITIES`, or a `kimi` login. `KIMI_BIN` overrides the command.
  - dsh: `DEEPSEEK_API_KEY` (and `DEEPSEEK_BASE_URL`); its profile chooses the model. `DSH_BIN` overrides the command.
- ACP has no system-prompt channel, so `systemPrompt` and `appendSystemPrompt` go at the top of the first message of a new session (a council seat's charter travels this way); a resumed session already holds them.
- `launcher` applies as for every engine.
- Where an ACP agent runs besides `session_start`: each fan-out and council agent, a workflow `agent` node, `solve`'s implementer and scouts, and a fan-out's synthesis pass (`synthesisAcpAgent`) name it by preset id in `acpAgent`; `session_handoff` takes `acpAgent` as `session_start` does. On the CLI an agent in a list is written `acp:<preset>`. Autoloop roles and ultrareview reviewers refuse `acp`: a role cannot name the agent, and a reviewer must be read-only.

```bash
clawo fanout "How would you cut this test suite's run time?" -e claude,acp:kimi-code,acp:dsh --synthesize --wait
clawo session-start kimi -e acp --acp-agent kimi-code --permission-mode bypassPermissions -d ./project
clawo session-send kimi "Fix the failing test in tests/test_io.py"
```

### Community engine presets

`customEngine` accepts either an inline `CustomEngineConfig` or the id of a preset
bundled in `configs/engines/`, and `acpAgent` does the same for the `acp` engine. The
preset form exists so a third-party CLI is described once and shipped, rather than
retyped by every caller. A preset carries exactly one of an `engine` block (started
with `engine: 'custom'`) or an `acp` block (started with `engine: 'acp'`); naming one
with the other engine fails with a message that says which to use. Bundled today:
`zcode` (custom), `kimi-code` and `dsh` (ACP). The format is in
[configs/engines/README.md](../../configs/engines/README.md).

Engines fall into three tiers, decided by how they are verified. Bundled presets
are always `community`:

| Tier          | Maintainer  | What is verified                                                                                    |
| ------------- | ----------- | --------------------------------------------------------------------------------------------------- |
| **core**      | Maintainers | Wrapped in code, exercised live weekly, pinned to a tested version                                  |
| **community** | Contributor | The schema is validated and the preset ships. Whether it runs is the maintainer's dated attestation |
| **legacy**    | —           | Still wired, no longer tracked                                                                      |

A community preset must name its maintainer and the engine version and date it
was verified against (`provenance.maintainer`, `provenance.verifiedAgainst`,
`provenance.verifiedOn`); a link to the captured smoke-test transcript
(`provenance.smokeUrl`) is expected in review but not enforced by the schema check.

A preset never carries protocol translation. A CLI speaking its own wire format
needs an adapter binary in its author's package, with the preset pointing `bin`
at it — as the `zcode` preset does with `zcode-claw-adapter`. An agent that serves
ACP needs no adapter: its preset names the command.

Over HTTP — which includes the `clawo` CLI — a custom engine or an ACP agent may be
given **only** as a preset id. An inline config names a binary and its arguments and
is refused there; a preset id cannot introduce either, so it is the same class as
naming a built-in engine, and `engine: 'codex'` already spawns an executable over
that surface. Presets are therefore the supported way to reach either from the CLI:
`clawo engines` lists what is bundled, and
`clawo session-start <name> -e custom --custom-engine <id>` (or
`-e acp --acp-agent <id>` for an ACP preset) starts one.

Contribution steps and the smoke script: [CONTRIBUTING.md](../../CONTRIBUTING.md#contributing-an-engine).

### Running an engine under a launcher

`SessionConfig.launcher` is an argv prefix the engine binary runs under, for every
engine: `launcher: ['/opt/task/sandbox.sh', 'task', '0 1']` spawns
`/opt/task/sandbox.sh task '0 1' codex app-server …`. This is how a caller puts
the agent inside its own sandbox (bubblewrap, a container entry point, `taskset`)
without a custom engine. The launcher is the caller's own command, at the same
trust level as a contract's command check, which the HTTP API also accepts: set
it through the SessionManager API, the `session_start` tool, `/session/start` or a
workflow spec (the `goal` node's `launcher`, which `workflow_start` and
`clawo goal --launcher` also take). On Windows, a launcher that runs through
`cmd.exe` (a `.cmd` or `.bat`) is held to the same argv rule as an engine shim: an
argument with a newline or an unbalanced double quote is refused before spawning,
so an engine that takes its prompt on the command line needs a launcher that is a
real executable.

## ISession Interface

All engines implement `ISession`, making them interchangeable at the `SessionManager` level:

```typescript
interface ISession {
  // Identity
  sessionId?: string;
  readonly pid?: number;

  // State
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
  once(event, listener): this;
  emit(event, ...args): boolean;
  removeListener(event, listener): this;
}
```

`SessionStats` requires `turnsSucceeded` as well as `turns`, so an engine that
implements this interface has to say which of its turns succeeded — the exit code
is not the answer on every engine. See [Stats & Monitoring](./sessions.md#stats--monitoring).

## Team Tools Across Engines

Team tools (`team_list`, `team_send`) operate on the same virtual-team layer for **every** engine: the "team" is the set of all active sessions managed by SessionManager, whatever engine each one runs. `team_list` lists the other active sessions with their engine and status; `team_send` routes a message through the cross-session inbox.

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

1. The session manager reads `~/.openclaw/openclaw.json` for the gateway port + auth (in plugin and `clawo serve` mode alike)
2. Starts a local proxy server on `127.0.0.1` (random port, auto-managed) the first time a Claude session names a non-Claude model, provided a gateway URL was found
3. Claude Code CLI sends Anthropic-format requests → proxy converts to OpenAI → gateway → any model

### Manual Config (optional)

Override with environment variables if needed:

| Variable         | Default                          | Description                                               |
| ---------------- | -------------------------------- | --------------------------------------------------------- |
| `GATEWAY_URL`    | Auto-detected from openclaw.json | Gateway endpoint (e.g. `http://127.0.0.1:18789/v1`)       |
| `GATEWAY_KEY`    | Auto-detected from openclaw.json | Gateway auth password/token                               |
| `GEMINI_API_KEY` | -                                | Direct Gemini API access, used when no gateway key is set |
| `OPENAI_API_KEY` | -                                | Direct OpenAI API access, used when no gateway key is set |

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

- **Persistent** (`persistent: true`) — long-running subprocess with stream-json I/O over stdin/stdout (like Claude Code). It keeps the conversation; `args.resume` passes `resumeSessionId` when a session is restarted
- **One-shot** (`persistent: false`, default) — new process spawned per `send()`, with the message on the command line right after `args.print`. Nothing carries over between sends. On Windows, a CLI that runs through `cmd.exe` (an npm `.cmd` shim) cannot take a message containing a newline or an unbalanced double quote this way; use persistent mode

`appendSystemPrompt` goes through `args.appendSystemPrompt` when the config maps it. Without that flag it is put at the top of the first message of a conversation: every message in one-shot mode, the first one in persistent mode unless the session resumed through `args.resume`.

`sandboxMode: 'read-only'` needs both `args.permissionMode` and a `permissionModes` entry for the session's permission mode that maps to the CLI's read-only or plan value. Without them the CLI is never run writable: a persistent session refuses to start, and a one-shot session refuses every send.

### CustomEngineConfig

| Field              | Type     | Required | Description                                                  |
| ------------------ | -------- | -------- | ------------------------------------------------------------ |
| `name`             | string   | yes      | Display name (used in logs, session IDs)                     |
| `bin`              | string   | yes      | Binary path or command name                                  |
| `binEnv`           | string   |          | Env var name that overrides `bin` at runtime                 |
| `persistent`       | boolean  |          | `true` = persistent subprocess, `false` = one-shot (default) |
| `args`             | object   | yes      | CLI flag mappings (see below)                                |
| `permissionModes`  | object   |          | Maps OpenClaw mode names to CLI-specific values              |
| `pricing`          | object   |          | `{ input, output, cached? }` per 1M tokens (see below)       |
| `contextWindow`    | number   |          | Context window size (default: 200,000)                       |
| `env`              | object   |          | Extra environment variables for the CLI process              |
| `sanitizePatterns` | string[] |          | Regex patterns to redact from stderr                         |

Cost is the reported tokens priced at the registry rate for the session's `model`,
or at its `pricingOverrides` entry when it has one. An unregistered model, or no
model, is priced at `pricing`, and at the `claude-sonnet-4-6` rate when the engine
sets none. With no model, a `pricingOverrides` entry for `claude-sonnet-4-6` still
takes precedence over `pricing`.

### args field

| Key                      | Example                        | Description                                |
| ------------------------ | ------------------------------ | ------------------------------------------ |
| `print`                  | `"-p"`                         | Non-interactive/print mode flag            |
| `outputFormat`           | `"--output-format"`            | Output format flag                         |
| `outputFormatValue`      | `"stream-json"`                | Value for stream-json output               |
| `inputFormat`            | `"--input-format"`             | Input format flag (persistent only)        |
| `inputFormatValue`       | `"stream-json"`                | Value for stream-json input                |
| `skipPermissions`        | `"-y"`                         | Passed when `dangerouslySkipPermissions`   |
| `permissionMode`         | `"--permission-mode"`          | Permission mode flag                       |
| `model`                  | `"--model"`                    | Model selection flag                       |
| `systemPrompt`           | `"--system-prompt"`            | System prompt override flag                |
| `appendSystemPrompt`     | `"--append-system-prompt"`     | Append system prompt flag                  |
| `maxTurns`               | `"--max-turns"`                | Max agent turns flag                       |
| `resume`                 | `"--resume"`                   | Session resume flag (persistent only)      |
| `verbose`                | `"--verbose"`                  | Verbose output flag (persistent only)      |
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
3. Add a case to `engineHasNativeConversation()` in `src/types.ts` and, if the engine resumes a conversation by id, to `nativeThreadIsLive()` in `src/openai-compat.ts` and to `_sessionResumeId()` / `_storedResumeId()` in `src/session-manager.ts`, so a restart replays an id the engine can resume rather than a synthetic wrapper id
4. Add a case to `SessionManager._createSession()`
5. Add model pricing to `MODELS[]` in `src/models.ts`
6. For a core engine: add it to `ENGINES` in `scripts/sweep.ts` and pin its tested version in the engine table of `AGENTS.md`

The `ISession` interface is deliberately minimal — each engine handles its own subprocess bootstrapping, I/O protocol, and cleanup internally.

For most third-party CLIs, the `custom` engine with `CustomEngineConfig` is sufficient and requires zero code changes.
