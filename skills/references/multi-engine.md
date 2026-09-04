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
│   └── Wraps: agent -p --force --trust --output-format stream-json (per-message spawning)
├── engine: 'opencode'  → PersistentOpencodeSession
│   └── Wraps: opencode run --format json (per-message spawning)
└── engine: 'custom'    → PersistentCustomSession
    └── Wraps: any CLI via user-provided CustomEngineConfig
```

## Supported Engines

### Claude Code (`engine: 'claude'`)

Default engine. Long-running subprocess with streaming JSON I/O. Tested with Claude Code CLI **2.1.207**.

- Persistent multi-turn conversations
- Real-time streaming (text, tool_use, tool_result, system events)
- Session resume via `--resume`
- Full cost tracking from API usage data
- Cross-session peer messaging (`crossSessionInbound`): sets this session's policy for messages sent from other Claude Code sessions on the same machine — `accept` delivers straight in, `hold` waits for a human to approve it in that session's terminal, `refuse` rejects it. There is no CLI flag for this; it is a settings key, delivered through the `--settings` merge. Worth setting explicitly for orchestrated sessions: with no value the CLI decides from the two sides' permission modes and holds when they differ, and an orchestrated session (`bypassPermissions` / `acceptEdits`) versus a human terminal (prompting) is exactly that case — so the message parks waiting for approval in a terminal nobody is watching. Sessions started by the orchestrator do register as addressable peers and do receive messages (verified against 2.1.232 by sending to a live one and getting a reply). Note that a user-level `~/.claude/settings.json` value may take precedence over the per-session one; only the `accept` path has been confirmed end-to-end here.
- Hook lifecycle events (`includeHookEvents`), subagent output forwarding (`forwardSubagentText`), permission delegation (`permissionPromptTool`), prompt cache optimization (`bare` + `excludeDynamicSystemPromptSections` + `enablePromptCaching1H`), debug control, `--from-pr` resume, and MCP channel subscriptions
- `--permission-prompts none` is passed whenever no `permissionPromptTool` is configured (CLI
  2.1.259+). This spawn shape has no TTY and, without a prompt tool, no host to answer a permission
  prompt — so before this a tool call the permission mode did not already decide sat waiting for an
  answer that could never come, until the turn timeout. `none` denies it instead; the model sees the
  denial and can adapt, and the permission mode still decides everything else. With a prompt tool
  configured the CLI's default (`host`) is left in place so the tool is asked
- `restricted` → `--restricted` (CLI 2.1.249+): removes the command- and code-running tools and
  `WebFetch` from the session, and ignores user/project/local settings files. Not folded into
  `sandboxMode: 'read-only'`, which maps to plan mode — measured against 2.1.251, plan mode alone
  refused a direct write, a shell write and a delegated subagent write, so this is defence in depth
  rather than a fix, and switching it on implicitly would silently drop the caller's CLAUDE.md
- Fork subagent (`forkSubagent`), tool search (`enableToolSearch`), OpenTelemetry logging toggles (`otelLogUserPrompts`, `otelLogRawApiBodies`), `xhigh` effort tier (Opus 4.7), and `stats.pluginErrors` capture — see [CLI 2.1.121 options in SKILL.md](../SKILL.md) and [tools.md](./tools.md)

> **Behavior changes from upstream Claude CLI 2.1.121** (worth knowing if you set permission rules):
>
> - `--agent` / `--print` now enforce agent frontmatter `permissionMode`, `tools`, `disallowedTools` (was advisory). Affects `council` agent personas.
> - `Bash(find:*)` permission rule no longer auto-approves `find -exec` or `find -delete`. Add explicit rules if you depend on these.
> - `--dangerously-skip-permissions` also skips prompts for `.claude/skills/` directory. Treat with care.
> - Distributed tracing context (`TRACEPARENT` / `TRACESTATE`) is automatically forwarded to the child process — set them in the parent before starting the session.

```typescript
await manager.startSession({
  name: 'claude-task',
  engine: 'claude', // default, can omit
  model: 'opus',
  cwd: '/project',
});
```

### OpenAI Codex (`engine: 'codex'`)

Wraps the `codex exec` subcommand. Each `send()` spawns a new process. Tested with `codex` CLI **0.147.0**.

- Non-interactive execution via `codex exec --sandbox workspace-write --json` (replaces the deprecated `--full-auto` flag from earlier Codex versions)
- Real `usage` from the `turn.completed` JSON event (input, output, cached, reasoning tokens). **These are cumulative over the thread, not per turn** — three identical turns on 0.147.0 report `input_tokens` 13,856 → 27,727 → 41,613, each matching `total_token_usage` in that thread's rollout exactly. They are assigned to the session totals, never added; subtracting consecutive values recovers the turn's own prompt
- `contextPercent` is that per-turn prompt (which, for a thread-resuming engine, is the live context occupancy) over **codex's own limit**, harvested from the thread's rollout file (`model_context_window`, 258,400 on 0.147.0). The model registry holds the published window — 1,050,000 for gpt-5.x — which codex does not honour, so measuring against it reads ~4x low. Resuming a thread also seeds the token baseline from the rollout, so the first send does not mistake the whole thread history for one prompt. All of this is best-effort: an unreadable or `--ephemeral` thread falls back to the registry window
- `item.completed` parsing distinguishes `reasoning` / `todo_list` (logged, not counted) from real tool items (`command_execution`, `file_change`, `mcp_tool_call`, `web_search`, which increment `toolCalls`; a non-zero `command_execution.exit_code` increments `toolErrors`)
- Reasoning effort: the engine-agnostic `effort` maps to `-c model_reasoning_effort=<level>` and passes straight through. Codex 0.149's ladder runs `low|medium|high|xhigh|max|ultra` — it is the only engine here that reaches `ultra`, and all three top levels were exercised against 0.149.1. `auto` and `ultracode` are omitted. Note `-c` values are not validated at spawn: codex prints `reasoning effort: <whatever>` and sends it, so an unknown level fails at the API rather than at the command line
- `noSessionPersistence` → `--ephemeral` (accepted by `exec` and `exec resume`); `ignoreUserConfig` → `--ignore-user-config`, which stops `$CODEX_HOME/config.toml` from deciding an orchestrated run's model behind the caller's back (auth still resolves from `CODEX_HOME`); `addDir` → `--add-dir` on the first turn only, since `exec resume` rejects it and the resumed thread keeps the roots it opened with
- `codexProfile` → `--profile <name>` (named config profile from `~/.codex/config.toml`)
- Per-session continuity: the `thread_id` from the first turn's `thread.started` event is captured and reused via `codex exec resume <id>` for subsequent sends, so the model sees prior turns
- `sandboxMode` maps to `--sandbox <mode>` on the first turn. **A resumed thread does not inherit it**, and `codex exec resume` rejects `--sandbox`, so the policy is restated as `-c sandbox_mode="<mode>"` on every resume. Without that, a `read-only` session goes writable from its second turn onward — verified against 0.146.0, where such a session wrote to disk on turn 2 on every attempt. Re-probed on 0.147.0 (direct write, shell redirect and delegate-to-subagent, each on a resumed turn): no writes
- One-shot execution per message (no persistent subprocess between sends)
- Captures the real Codex thread ID and persists it, so later sends and process-level session resume use `codex exec resume <thread_id>`
- Working directory passed via `-C` flag
- Default model: `gpt-5.5`
- Requires `codex` CLI >= 0.119 (for `exec resume`): `npm install -g @openai/codex`
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
- Cumulative token tracking from `thread/tokenUsage/updated` notifications. The same notification's `last` breakdown and `modelContextWindow` drive `contextPercent`, so it reports live occupancy against the window the server actually enforces (258,400 on 0.147.0) rather than a running total over the model's published window
- Goal lifecycle observation via `thread/goal/updated` and `thread/goal/cleared` notifications
- Goal control via the `codex_goal_*` tools (which internally send the `/goal` slash command as user text — see [tools.md](./tools.md#codex-13))
- v2 RPC tools (Codex 0.137): `codex_interrupt` (`turn/interrupt`), `codex_steer` (`turn/steer`), `codex_fork` (`thread/fork`), `codex_rollback` (`thread/rollback`), `codex_models` (`model/list`), `codex_thread_list` (`thread/list`). A `turn/completed` with `status: 'failed'` rejects the turn and increments `toolErrors`.
- Thread resume: starting with `resumeSessionId` loads the existing thread via `thread/resume` instead of `thread/start`.

> **Feature-flag risk.** The `goals` feature is marked "under development" in Codex 0.128.0 and has known bugs (e.g. issue #20591). The session class always passes `--enable goals` so it works the moment upstream stabilizes the feature, but during the transition period some goal commands may fail or be silently dropped on the server side. The wrapper layer is unaffected.

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
in print mode. Adapter behavior is covered through `agy` **1.1.26**.

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
- **Empty responses fail adapter-wide and remain recoverable**: an exit-0 result
  with a missing, blank, or whitespace-only response rejects instead of becoming
  a successful empty reply, whether the caller is Autoloop, MCP, HTTP, or the
  library API. agy 1.1.26 may do this after plan mode soft-denies a tool
  confirmation. The adapter clears the per-session log before each spawn and
  recognizes only the narrow current-turn `tool_confirmation_manager` marker,
  returning a fixed sanitized diagnosis without exposing native log content. A
  conversation id already emitted by `init` is retained for the caller's next
  send; the failed turn is not retried automatically.
- **Reasoning effort**: session `effort` and per-turn `session_send` overrides map
  to `--effort`. agy accepts `low`, `medium`, and `high`; everything above that
  (`xhigh`, `max`, `ultra`) clamps to `high`. agy 1.1.25 requires an effort with unsuffixed base
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
  `default` → `--sandbox` (terminal-restricted), and
  `sandboxMode: 'read-only'` → `--mode plan` (takes precedence). Other modes
  run agy's own approval flow, which can block in headless print mode. A caller
  must explicitly choose `bypassPermissions` for a write-enabled session; it is
  not a recovery mechanism. In particular, an Autoloop Planner stays on
  `--mode plan` when its preserved conversation is resumed.
- agy enforces its own print timeout (default 5m); the engine derives
  `--print-timeout` from the send timeout so the wrapper timer decides
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
prints a single JSON object and exits. Verified against `grok` **1.0.5**.

- **Cost comes from the engine, not from our price table.** The result object carries
  `total_cost_usd`, and the wrapper writes it straight into the session's spend. Every other engine
  here multiplies tokens by a rate in `models.ts` — the metadata most prone to going stale — so on
  this engine the run ledger and the `maxBudgetUsd` gate both read what xAI actually charged.
  `grok-4.6` is still registered, for its context window and an indicative breakdown; its two price
  tiers ($2/$0.50/$6 under a 200K prompt, $4/$1/$12 at or above, charged across the whole request)
  therefore never have to be modelled here.
- **Real conversation continuity**: the `sessionId` from turn 1 is replayed as `--resume <id>`.
  `--continue` is deliberately not used — it means "the most recent session for this cwd", which
  collides between concurrent sessions. Confirmed with a two-turn recall test, not inferred.
- Real token counts from `usage` (`input_tokens`, `output_tokens`, `cache_read_input_tokens`).
  These are **per-turn**, not cumulative over the thread — checked by resuming and reading turn 2,
  because the same-looking field on codex is a running total.
- Permission modes pass straight through: grok's `--permission-mode` takes the same vocabulary we
  use. The one exception is our `manual`, which grok spells `default`.
- Reasoning effort maps to `--effort`; grok 1.0.13 accepts `low|medium|high|xhigh` (it names the set in
  its own rejection message), so only `max` and `ultra` clamp — to `xhigh`.
- Session options that reach grok since 1.0.13: `appendSystemPrompt` → `--rules` (appends, unlike
  `systemPrompt` → `--system-prompt-override`, which replaces), `allowedTools` → `--tools`,
  `disallowedTools` → `--disallowed-tools`, `jsonSchema` → `--json-schema` (inline, and it implies the
  JSON output format already asked for), `agent` → `--agent`, `agents` → `--agents`,
  `dangerouslySkipPermissions` → `--always-approve`, `customSessionId` → `--session-id`, `forkSession`
  → `--fork-session`. **grok validates neither tool list**: a name that does not exist is ignored
  rather than rejected, so a typo in a denylist leaves the tool enabled. Prefer an allowlist.
- `-p` is now the short form of `--single`, not `--print`. The short form is what this wrapper passes,
  so the 1.0.5 → 1.0.13 rename is invisible here; a call written against the long name is not.
- **`sandboxMode: 'read-only'` is refused, not approximated — and against 1.0.13 that is measured.**
  The obvious construction is a `--tools` allowlist of read-only built-ins plus `--permission-mode
plan`. It refuses a direct write and a shell write, then loses to the third prompt in the matrix:
  asked to delegate, the session spawns a subagent and the file appears. The subagent does not
  inherit the parent's tool restriction — the same load-bearing hole found in OpenCode, where
  denying the write tools without denying `task` left the delegation path open. grok also ships
  `--no-subagents`, the obvious next probe, deliberately not wired: the run that would have
  confirmed it hit the account's free-tier limit, and a probe that fails for lack of quota writes no
  file either. A read-only grok session throws rather than running writable under a read-only label.
- **On a spent free tier, `grok -p` can hang silently instead of erroring.** Earlier in the same
  session it printed a usage-limit message to stderr and exited 1; later invocations produced nothing
  on either stream and never exited — in any directory, with or without `--no-leader`. The session's
  turn timeout is what ends such a turn, so a caller on that tier pays the full timeout before seeing
  a failure. Nothing in this wrapper can distinguish that hang from a slow turn; check `grok -p` by
  hand when a grok session times out with no output.
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
> Note what this is and is not: Cursor itself is **not** discontinued. Anysphere was acquired by
> SpaceX (closed 2026-08-15) and folded into the SpaceXAI team, and the CLI has shipped since. Two
> practical things pushed it out of the tracked set. Cursor never reports which model actually ran
> — its `system` init event says `"model": "Auto"` — so a router that spans Claude, GPT and Grok
> leaves every cost row attributed to a hardcoded proxy rate. And xAI's Grok installer now claims
> the bare `agent` name, so the binary that name resolves to depends on install order.

Wraps the Cursor Agent CLI with `--print --output-format stream-json`. Write-enabled sessions use `--force`. Each `send()` spawns a new process.

- Conversation continuity: the chat id from the first turn's `system` event is captured and passed back as `--resume <chatId>` on later sends, so the model sees prior turns. `--continue` is deliberately not used: it resumes "the latest chat", which collides between concurrent sessions.
- One-shot execution per message (no persistent subprocess)
- Working directory via `--workspace` flag
- Real token counts from stream-json `result` events (camelCase: `inputTokens`, `outputTokens`, `cacheReadTokens`)
- `--force` enables auto-approval of file changes. `sandboxMode: 'read-only'` does **not** use `--force`; it enforces read-only via a binding `.cursor/cli.json` deny config (`Write`/`Edit`/`Shell` denied) written into an isolated temp dir used as the process cwd, with `--workspace` pointing at the real project (the repo tree is never modified). `--mode plan` is passed too as model steering, but the deny config is the actual boundary — plan mode alone is model-cooperative and was verified to let an adversarial prompt write. Do not add `--sandbox` (it does not restrict in-workspace writes and overrides the mode). Read/grep/search remain available
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

Presets are **community** entries, and the tier line is verification rather than
code quality:

| Tier          | Maintainer  | What this project claims                                                                          |
| ------------- | ----------- | --------------------------------------------------------------------------------------------------- |
| **core**      | Maintainers | Wrapped here, exercised live weekly, pinned to a version someone here ran                          |
| **community** | Contributor | The schema is validated and the preset ships. Whether it runs is the maintainer's dated attestation |
| **legacy**    | —           | Still wired, no longer tracked                                                                     |

Core requires that a maintainer can obtain and run the binary, because that tier
promises the weekly live turn. Most CLIs worth supporting are behind credentials
this project does not hold — a bar nobody can clear would keep the community tier
permanently empty, and an empty tier looks the same as never having done the work.
So the bar is an attributable, dated, falsifiable claim: `provenance.maintainer`,
`provenance.verifiedAgainst` (the engine version), `provenance.verifiedOn`, and a
link to the captured smoke transcript.

A preset never carries protocol translation. A CLI speaking its own wire format
needs an adapter binary in its author's package, with the preset pointing `bin`
at it — the split `@enderfga/dsh-clawo` already uses. That is what makes a preset
something this project can ship without owning a protocol it cannot test.

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
- Real token counts from `step_finish.part.tokens.{input,output,cache.{read,write}}`. **`input` is the uncached remainder only** — opencode's own `total` is `input + output + cache.read + cache.write` — so the cached part is billed on top of it, not carved out of it, and `contextPercent` is measured against the whole input side. On a resumed turn the remainder is tiny next to the cached part (58 against 26,240), which is what makes the distinction matter
- Reasoning effort maps to `--variant`, opencode's provider-specific effort knob. opencode does not validate the value: a level the provider does not offer runs the turn at its default rather than failing
- The wrapper closes the subprocess's stdin immediately after spawn (opencode otherwise reads stdin and blocks on EOF, hanging the call)
- Provider-agnostic: opencode's `--model` expects `provider/model` form (e.g. `anthropic/claude-sonnet-4`). The wrapper passes `--model` through only when the value contains a `/`; otherwise opencode's own default applies
- `sandboxMode: 'read-only'` spawns a generated `clawo-readonly` agent (`--agent clawo-readonly` plus an `OPENCODE_CONFIG_CONTENT` env var defining it) that denies `edit` / `bash` / `external_directory` / `webfetch` / **`task`** at the permission level and additionally removes those tools outright via the agent's `tools` map. It deliberately does **not** use OpenCode's built-in `plan` agent: that is a user-overridable preset whose compiled rules start with `{"permission":"*","action":"allow"}` and deny neither `bash` nor `edit`, so a "read-only" session could still author files through a shell heredoc. **`task` is the load-bearing denial**: denying only the write tools leaves the delegation path open, and the agent will hand the write to a subagent that runs under the default writable agent — asked to delegate, a session denied only `edit`/`bash`/`external_directory` wrote to disk on every attempt. Verify this config only with adversarial writes, and include prompts that ask the agent to delegate; `opencode agent list` renders compiled permission rules that look identical for a safe and an unsafe agent, and a probe that only asks for a direct write passes even when the delegation path is wide open
- Requires opencode installed: `brew install sst/tap/opencode` or `npm install -g opencode-ai`. Auth via `opencode auth login` **or** any provider env var (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, etc.) — opencode picks up either path
- Binary: `opencode` (set `OPENCODE_BIN` env var to override)

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

| Engine      | `team_list`                                | `team_send`                    |
| ----------- | ------------------------------------------ | ------------------------------ |
| Claude      | Lists other active SessionManager sessions | Routes via cross-session inbox |
| Codex       | Lists other active SessionManager sessions | Routes via cross-session inbox |
| Antigravity | Lists other active SessionManager sessions | Routes via cross-session inbox |
| Cursor      | Lists other active SessionManager sessions | Routes via cross-session inbox |

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

> **Note:** `agy` now has first-class support — use [`engine: 'agy'`](#google-antigravity-engine-agy)
> instead, which adds conversation resume and timeout coherence the recipe below
> lacks. This recipe remains as a reference for driving older agy builds or
> forks with a diverged flag surface:

```typescript
await manager.startSession({
  name: 'antigravity-task',
  engine: 'custom',
  cwd: '/project',
  dangerouslySkipPermissions: true,
  customEngine: {
    name: 'antigravity',
    bin: 'agy', // install: curl -fsSL https://antigravity.google/cli/install.sh | bash
    binEnv: 'AGY_BIN',
    persistent: false,
    args: {
      print: '-p', // single-prompt headless mode
      skipPermissions: '--dangerously-skip-permissions',
      workspace: '--add-dir',
      // NOTE: agy 1.0.2 has NO --output-format flag — output is plain text only.
      // Omitting outputFormat makes the wrapper parse plain text and *estimate*
      // tokens (no real usage / tool-call events). Watch for a JSON output mode.
    },
  },
});
```

Caveats with `agy` 1.0.2: (1) no structured/stream-json output → token counts are
estimated, not real; (2) requires a one-time `agy` Google OAuth login; (3) resume
by conversation ID isn't wired (no JSON stream to capture the ID from).

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
2. Add the engine name to `EngineType` in `src/types.ts`
3. Add a case to `SessionManager._createSession()`
4. Add model pricing to `MODELS[]` in `src/models.ts`

The `ISession` interface is deliberately minimal — each engine handles its own subprocess bootstrapping, I/O protocol, and cleanup internally.

For most third-party CLIs, the `custom` engine with `CustomEngineConfig` is sufficient and requires zero code changes.
