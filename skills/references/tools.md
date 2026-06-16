# Tools Reference

All tools are registered as Claw Orchestrator plugin tools. In standalone mode, they're accessible via the embedded HTTP server.

## Session Lifecycle (5)

### `session_start`

Start a persistent coding session with full CLI flag support.

| Parameter | Type | Description |
|-----------|------|-------------|
| `name` | string | Session name (auto-generated if omitted) |
| `cwd` | string | Working directory |
| `engine` | `'claude'` \| `'codex'` \| `'gemini'` \| `'cursor'` \| `'opencode'` \| `'custom'` | Engine to use (default: `claude`). `opencode` wraps sst/opencode (pass model as `provider/model`). Use `custom` with `customEngine` for any CLI. |
| `model` | string | Model alias or full name |
| `permissionMode` | string | `acceptEdits`, `bypassPermissions`, `plan`, `auto`, `default` |
| `effort` | string | `low`, `medium`, `high`, `max`, `auto` |
| `allowedTools` | string[] | Tools to auto-approve |
| `disallowedTools` | string[] | Tools to deny |
| `maxTurns` | number | Max agent loop turns |
| `maxBudgetUsd` | number | Max API spend (USD) |
| `systemPrompt` | string | Replace system prompt |
| `appendSystemPrompt` | string | Append to system prompt |
| `agents` | object | Custom sub-agents JSON |
| `agent` | string | Default agent to use |
| `bare` | boolean | Skip hooks, LSP, auto-memory, CLAUDE.md |
| `worktree` | string \| boolean | Run in git worktree |
| `fallbackModel` | string | Fallback when primary overloaded |
| `resumeSessionId` | string | Resume existing session by ID |
| `jsonSchema` | string | JSON Schema for structured output. Claude: `--json-schema` (inline). Codex: `--output-schema` (written to a temp file, requires Codex 0.132+). Other engines ignore it. |
| `mcpConfig` | string \| string[] | MCP server config file(s) |
| `settings` | string | Settings.json path or inline JSON |
| `ultracode` | boolean | Claude only. Enable "ultracode" / dynamic workflows — Claude plans a JS orchestration script per substantive task and fans out to subagents. Injected as the `ultracode:true` settings key (merged into `settings`), **not** a `--effort` value (the CLI rejects `--effort ultracode`). |
| `noSessionPersistence` | boolean | Do not save session to disk |
| `betas` | string \| string[] | Custom beta headers |
| `enableAgentTeams` | boolean | Enable experimental agent teams |
| `enableAutoMode` | boolean | Enable auto permission mode |
| `customEngine` | object | Custom engine config (required when `engine='custom'`). See [Multi-Engine: Custom Engine](./multi-engine.md#custom-engine-enginecustom). |
| `includeHookEvents` | boolean | Stream hook lifecycle events (PreToolUse/PostToolUse) as `system` events |
| `permissionPromptTool` | string | MCP tool name to delegate permission prompts to (non-interactive use) |
| `excludeDynamicSystemPromptSections` | boolean | Move cwd/env/git context from system prompt to user message for better prompt cache hits; auto-enabled with `bare: true` |
| `enablePromptCaching1H` | boolean | Enable 1-hour prompt cache TTL (vs default 5-min); auto-enabled with `bare: true` |
| `debug` | string | Debug categories to enable (comma-separated, e.g. `"api,mcp"`) |
| `debugFile` | string | File path to write debug output to |
| `fromPr` | string \| number | Resume a session linked to a GitHub PR number or URL |
| `channels` | string \| string[] | MCP channel subscription spec (research preview) |
| `dangerouslyLoadDevelopmentChannels` | string \| string[] | Development MCP channel subscriptions (research preview) |
| `forkSubagent` | boolean | Fork subagent for non-interactive sessions (sets `CLAUDE_CODE_FORK_SUBAGENT=1`) |
| `enableToolSearch` | boolean | Enable Vertex AI tool search (sets `ENABLE_TOOL_SEARCH=1`) |
| `otelLogUserPrompts` | boolean | OpenTelemetry: log user prompts (sets `OTEL_LOG_USER_PROMPTS=1`) |
| `otelLogRawApiBodies` | boolean | OpenTelemetry: log raw API request/response bodies (sets `OTEL_LOG_RAW_API_BODIES=1`); debug only |
| `bedrockServiceTier` | `'default'` \| `'flex'` \| `'priority'` | AWS Bedrock service tier (sets `ANTHROPIC_BEDROCK_SERVICE_TIER`); only effective when routing through Bedrock |
| `effort` | `'low'` \| `'medium'` \| `'high'` \| `'xhigh'` \| `'max'` \| `'auto'` | Reasoning effort level. `xhigh` is Opus 4.7-only (between `high` and `max`); triggers `ultrathink` prefix on user messages, same as `high` and `max`. |

### `session_send`

Send a message and get the response.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | yes | Session name |
| `message` | string | yes | Message to send |
| `effort` | string | | Override effort for this message |
| `plan` | boolean | | Enable plan mode |
| `timeout` | number | | Timeout in ms (default 300000) |
| `stream` | boolean | | Collect streaming chunks in result |

### `session_stop`

Graceful shutdown (SIGTERM, then SIGKILL after 3s).

| Parameter | Type | Required |
|-----------|------|----------|
| `name` | string | yes |

### `session_list`

List all active and persisted sessions. No parameters.

### `sessions_overview`

Dashboard view: all sessions with ready/busy/paused state, cost, context %, last activity. No parameters.

---

## Session Operations (5)

### `coding_session_status`

Detailed status: tokens, cost, context %, tool calls, uptime. (Renamed from `session_status` in v3.2 to avoid collision with OpenClaw's built-in `session_status` tool.)

| Parameter | Type | Required |
|-----------|------|----------|
| `name` | string | yes |

**Returned stats fields** (selected):

| Field | Type | Description |
|-------|------|-------------|
| `retries` | number | Number of API retries that occurred during this session |
| `lastRetryError` | string \| undefined | Error message from the most recent retry (if any) |

### `session_grep`

Regex search over session event history.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | yes | Session name |
| `pattern` | string | yes | Regex pattern |
| `limit` | number | | Max results (default 50) |

### `session_compact`

Reclaim context window via `/compact`.

| Parameter | Type | Required |
|-----------|------|----------|
| `name` | string | yes |
| `summary` | string | |

### `session_update_tools`

Update tool permissions at runtime. Restarts session with `--resume`.

| Parameter | Type | Description |
|-----------|------|-------------|
| `name` | string | Session name |
| `allowedTools` | string[] | New allowed tools (replaces or merges) |
| `disallowedTools` | string[] | New disallowed tools |
| `removeTools` | string[] | Tools to remove from lists |
| `merge` | boolean | Merge with existing (default: replace) |

### `session_switch_model`

Hot-swap model mid-conversation. Restarts with `--resume`.

| Parameter | Type | Required |
|-----------|------|----------|
| `name` | string | yes |
| `model` | string | yes |

---

## Project State (1)

### `project_purge`

Wraps `claude project purge` (CLI 2.1.126+). Deletes Claude Code state for a project — transcripts, tasks, file history, config entry. **Defaults to dry-run for safety**; pass `dry_run=false` to actually delete. The CLI's confirmation prompt is bypassed by default (`--yes`) since the wrapper has no TTY; safety is enforced upstream via the dry-run default.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | | Project path to purge. Resolved to absolute. Ignored when `all=true`. |
| `all` | boolean | | Purge state for every project. Mutually exclusive with `path`. |
| `dry_run` | boolean | | List what would be deleted without deleting. **Defaults to `true`.** |

Returns `{ ok, stdout, stderr, dryRun }`.

---

## Claude (4)

Tools targeting Claude Code's CLI. `plugin_details` is a one-shot wrapper. The `claude_goal_*` tools require a session started with `engine: "claude"` (the default) and pre-format the `/goal` slash command introduced in CLI 2.1.139.

### `plugin_details`

Wraps `claude plugin details <name>` (CLI 2.1.139+). Prints the plugin's component inventory (commands, hooks, MCP servers, agents, skills) plus the per-session token cost of loading it.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | yes | Plugin name (e.g. `superpowers` or `superpowers@claude-plugins-official`). |

Returns `{ ok, stdout, stderr }`.

### `claude_goal_set`

Set a completion condition on a claude session (CLI 2.1.139+). Claude Code keeps working across turns until the condition is met, evaluating after each turn via Haiku. Sends `/goal <objective>` as a normal user message — the CLI's slash-command parser routes it to the goal subsystem. **Requires `engine: "claude"`.**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | yes | Session name. |
| `objective` | string | yes | Completion condition (e.g. "all tests in tests/ pass"). |
| `timeout` | number | | Timeout in ms for the resulting turn (default 300000). |

Returns the regular `session_send` turn result. Unlike Codex's `/goal`, Claude does not emit a separate goal-state notification — the only surface is the assistant's reply text. Use `claude_goal_status` to query later.

### `claude_goal_clear`

Send `/goal clear` to remove the active goal. Requires `engine: "claude"`.

| Parameter | Type | Required |
|-----------|------|----------|
| `name` | string | yes |
| `timeout` | number | |

Returns the regular turn result.

### `claude_goal_status`

Send bare `/goal` to query the active goal (objective, elapsed time, turns, tokens). Requires `engine: "claude"`.

| Parameter | Type | Required |
|-----------|------|----------|
| `name` | string | yes |
| `timeout` | number | |

Returns the regular turn result; goal info is in the assistant's reply text.

> Note: Claude's `/goal` is interactive-only in the upstream TUI sense — it has no dedicated CLI flag or JSON event. These wrappers work because Claude Code interprets slash-prefixed user messages in non-interactive (`-p` / stream-json) mode the same way. The wrappers exist for engine-guard and discoverability, not protocol translation.

---

## Codex (13)

Tools targeting OpenAI's `codex` CLI. The `codex_resume` and `codex_review` tools are one-shot wrappers and work without a managed session. The `codex_goal_*` tools require a session started with `engine: "codex-app"` (see [multi-engine.md](./multi-engine.md)) — the legacy `engine: "codex"` (which uses `codex exec`) has no slash-command surface.

### `codex_resume`

Resume a previously recorded Codex thread by UUID/name, or pick the most recent with `last=true`. Spawns `codex exec resume` with `--json` and parses the JSONL output into structured fields. Independent of session manager state.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `session_id` | string | | Codex thread UUID/name. Mutually exclusive with `last`. |
| `last` | boolean | | Resume the most recent recorded session. |
| `message` | string | yes | Prompt to send after resuming. |
| `cwd` | string | | Working directory. |
| `model` | string | | Override model. |
| `timeout` | number | | Timeout in ms (default 300000). |

> Note: `codex exec resume` does not accept `--sandbox` or `-C` (sandbox policy and cwd are inherited from the original session). The `cwd` parameter only sets the spawn's working directory so `--last`'s session-picker scopes correctly.

Returns `{ ok, text, threadId?, usage?, events }`.

### `codex_review`

Run a non-interactive Codex code review (`codex review`). Pick exactly one diff scope.

| Parameter | Type | Description |
|-----------|------|-------------|
| `prompt` | string | Custom review instructions. |
| `cwd` | string | Repository to review. |
| `uncommitted` | boolean | Review staged + unstaged + untracked. |
| `base` | string | Review changes against this base branch. |
| `commit` | string | Review changes introduced by this commit SHA. |
| `title` | string | Optional commit title shown in review summary. |
| `model` | string | Override model. |
| `timeout` | number | Timeout in ms (default 600000). |

Returns `{ ok, stdout, stderr }`.

### `codex_goal_set`

Set a long-horizon objective. Sends `/goal <objective>` via the app-server. **Requires `engine: "codex-app"`.**

| Parameter | Type | Required |
|-----------|------|----------|
| `name` | string | yes |
| `objective` | string | yes |
| `timeout` | number | |

Returns `{ ok, text, goal }` where `goal` is `{ objective, status: "active"|"paused"|"budgetLimited"|"complete", tokensUsed, timeUsedSeconds, tokenBudget?, ... }` or `null`.

### `codex_goal_get`

Read the cached goal state. Pure read — does not send a turn.

| Parameter | Type | Required |
|-----------|------|----------|
| `name` | string | yes |

Returns `{ ok, goal }` (`null` if no goal active).

### `codex_goal_pause` / `codex_goal_resume` / `codex_goal_clear`

Send `/goal pause`, `/goal resume`, or `/goal clear` respectively. Requires `engine: "codex-app"`.

| Parameter | Type | Required |
|-----------|------|----------|
| `name` | string | yes |
| `timeout` | number | |

Returns `{ ok, text, goal }`.

> **Stability note:** Codex's `goals` feature is flagged "under development" in 0.128.0 and has known bugs (issue #20591). The slash-command parsing on the server side may also evolve. The wrapper is intentionally a thin sugar layer so upstream changes only affect the slash-text we send, not the protocol structure.

### `codex_interrupt` / `codex_steer` / `codex_fork` / `codex_rollback` / `codex_models`

Codex app-server v2 RPCs (require `engine: "codex-app"`). Method names + param shapes verified against `codex app-server generate-json-schema` (Codex 0.137).

| Tool | RPC | Params | Returns |
|------|-----|--------|---------|
| `codex_interrupt` | `turn/interrupt` | `name` | `{ ok, interrupted }` — cancels the in-flight turn (no-op if idle) |
| `codex_steer` | `turn/steer` | `name`, `message` | `{ ok, steered, turnId? , text? }` — adds input to the in-flight turn; falls back to a normal turn when idle |
| `codex_fork` | `thread/fork` | `name` | `{ ok, threadId }` — branches the thread; returns the forked id |
| `codex_rollback` | `thread/rollback` | `name`, `numTurns` | `{ ok, numTurns }` — drops the last N turns |
| `codex_models` | `model/list` | `name` | `{ ok, models }` — incl. each model's `supportedReasoningEfforts` |
| `codex_threads` | `thread/list` | `name`, `searchTerm?`, `cwd?`, `archived?`, `cursor?`, `limit?` | `{ ok, data, nextCursor }` — list threads with filters + pagination |

To **resume** a codex-app thread, start a session with `engine: "codex-app"` and
`resumeSessionId: "<threadId>"` — it loads the existing thread via `thread/resume` instead of
opening a fresh one.

---

## Claude CLI (1)

### `claude_agents_list`

Wraps `claude agents --json` — lists Claude Code background agent sessions (state/model/title/progress). One-shot spawn, not tied to a managed session. (`claude continue/respawn/stop/logs` do not exist as headless subcommands; use `resumeSessionId` on `session_start` to resume.)

| Parameter | Type | Description |
|-----------|------|-------------|
| `all` | boolean | Include completed sessions (`--all`). |
| `cwd` | string | Scope to sessions started under this directory (`--cwd`). |

Returns `{ ok, agents }`.

---

## Fan-out (3)

Run one task across N engine/model agents **in parallel** and collect their answers, with an optional synthesis pass. Cross-engine best-of-N / diverse-perspective primitive — no rounds, votes, or git worktrees. For isolated parallel *editing*, use Council.

### `fanout_start`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `task` | string | yes | Shared prompt sent to every agent (unless an agent overrides via its own `prompt`). |
| `projectDir` | string | yes | Working directory all agents run in. |
| `agents` | array | yes | Specs: `{ name, engine?, model?, prompt?, baseUrl?, permissionMode?, customEngine? }`. |
| `synthesize` | boolean | | Run a final synthesis pass over the successful results (needs ≥2). |
| `synthesisModel` / `synthesisEngine` | string | | Model/engine for the synthesis pass (default engine `claude`). |
| `agentTimeoutMs` | number | | Per-agent timeout (default 600000). |
| `maxTurnsPerAgent` | number | | Max agent loop turns (default 30). |
| `maxBudgetUsd` | number | | Per-agent spend cap. |

Runs in the background; returns `{ ok, id, status, ... }`. Poll with `fanout_status`.

### `fanout_status`

Poll a fan-out by `id`. Returns `{ ok, id, status, results: [{ agent, engine, model, ok, output, error?, durationMs }], synthesis? }`.

### `fanout_abort`

Abort a running fan-out by `id` (already-started agents finish; synthesis is skipped).

---

## Agent Teams (3)

### `coding_agents_list`

List agent definitions from `.claude/agents/` (project + global). (Renamed from `agents_list` in v3.2 to avoid collision with OpenClaw's built-in `agents_list` tool.)

| Parameter | Type |
|-----------|------|
| `cwd` | string |

### `team_list`

List teammates in an agent team session.

| Parameter | Type | Required |
|-----------|------|----------|
| `name` | string | yes |

### `team_send`

Send message to a specific teammate.

| Parameter | Type | Required |
|-----------|------|----------|
| `name` | string | yes |
| `teammate` | string | yes |
| `message` | string | yes |

---

## Council (7)

### `council_start`

Start a multi-agent council. Runs in background, returns session ID immediately.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `task` | string | yes | Task description |
| `projectDir` | string | yes | Working directory |
| `agents` | AgentPersona[] | | Agent list (defaults to 3-agent team) |
| `maxRounds` | number | | Max rounds (default 15) |
| `agentTimeoutMs` | number | | Per-agent timeout (default 1800000) |
| `maxTurnsPerAgent` | number | | Max tool turns per agent (default 30) |
| `maxBudgetUsd` | number | | Max API spend per agent |
| `defaultPermissionMode` | string | | Default permission mode for agents (`acceptEdits`, `bypassPermissions`, etc.). Overridden by agent-level `permissionMode`. Default: `bypassPermissions` |

### `council_status`

Get status of a running or recently completed council.

| Parameter | Type | Required |
|-----------|------|----------|
| `id` | string | yes |

### `council_abort`

Abort a running council, stopping all agent sessions.

| Parameter | Type | Required |
|-----------|------|----------|
| `id` | string | yes |

### `council_inject`

Inject a user message into the next round of a running council.

| Parameter | Type | Required |
|-----------|------|----------|
| `id` | string | yes |
| `message` | string | yes |

### `council_review`

Review a completed council session. Returns a structured report of all changed files, branches, worktrees, plan.md status, review files, and agent summaries. Does not modify any state.

| Parameter | Type | Required |
|-----------|------|----------|
| `id` | string | yes |

**Returns**: `CouncilReviewResult` with `changedFiles`, `branches`, `worktrees`, `reviews`, `planContent`, and `agentSummaries`.

### `council_accept`

Accept and finalize council work. Cleans up all council scaffolding: removes worktrees, deletes `council/*` branches, removes `plan.md` and `reviews/` directory.

| Parameter | Type | Required |
|-----------|------|----------|
| `id` | string | yes |

**Returns**: `CouncilAcceptResult` with `branchesDeleted`, `worktreesRemoved`, `planDeleted`, `reviewsDeleted`.

### `council_reject`

Reject council work and provide feedback. Rewrites `plan.md` with rejection feedback and commits it. Does NOT delete any worktrees or branches — the council can be restarted to retry.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | yes | Council session ID |
| `feedback` | string | yes | Detailed feedback on what needs to be fixed |

**Returns**: `CouncilRejectResult` with `planRewritten` and `feedback`.

---

## Inbox (3)

### `session_send_to`

Send a cross-session message. Delivered immediately if target is idle, queued if busy.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `from` | string | yes | Sender session name |
| `to` | string | yes | Target session name, or `"*"` for broadcast |
| `message` | string | yes | Message text |
| `summary` | string | | Short preview (5-10 words) |

### `session_inbox`

Read inbox messages for a session.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | yes | Session name |
| `unreadOnly` | boolean | | Only unread (default true) |

### `session_deliver_inbox`

Deliver all queued inbox messages to an idle session.

| Parameter | Type | Required |
|-----------|------|----------|
| `name` | string | yes |

---

## Ultraplan (2)

### `ultraplan_start`

Start a dedicated Opus planning session (up to 30 min). Runs in background.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `task` | string | yes | What to plan |
| `cwd` | string | | Project directory |
| `model` | string | | Model (default: opus) |
| `timeout` | number | | Timeout ms (default 1800000) |

### `ultraplan_status`

Get status and plan text when completed.

| Parameter | Type | Required |
|-----------|------|----------|
| `id` | string | yes |

---

## Ultrareview (2)

### `ultrareview_start`

Launch a fleet of bug-hunting agents (1-20) reviewing code from different angles.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `cwd` | string | yes | Project directory |
| `agentCount` | number | | Agents (1-20, default 5) |
| `maxDurationMinutes` | number | | Duration (5-25 min, default 10) |
| `model` | string | | Model for reviewers |
| `focus` | string | | Review focus area |

### `ultrareview_status`

Get status and findings when completed.

| Parameter | Type | Required |
|-----------|------|----------|
| `id` | string | yes |

---

## Autoloop (6)

Three-agent autonomous iteration loop (Planner / Coder / Reviewer) over a git workspace. See [`autoloop.md`](./autoloop.md) for the operator reference (push policy, ledger layout, smoke test).

### `autoloop_start`

Start an autoloop run. Planner is created persistent; Coder + Reviewer are spawned by the Planner once `plan.md` is ready.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `cwd` | string | yes | Workspace (must be a git repo) |
| `goal` | string | yes | High-level user goal in natural language |
| `model` | string | | Planner model (default Opus) |
| `coderModel` | string | | Coder subagent model |
| `reviewerModel` | string | | Reviewer subagent model |
| `maxIters` | number | | Cap on Coder/Reviewer rounds (default 50) |
| `pushChannels` | string[] | | Notification channels (`wechat`, `whatsapp`, `email`) |

### `autoloop_chat`

Send a message into the Planner conversation (e.g. answer a clarifying question, refine the plan, kick off the subloop).

| Parameter | Type | Required |
|-----------|------|----------|
| `id` | string | yes |
| `message` | string | yes |

### `autoloop_status`

Get current state, phase, recent inbox messages, and ledger summary.

| Parameter | Type | Required |
|-----------|------|----------|
| `id` | string | yes |

### `autoloop_list`

List active and recent autoloop runs (in-memory + on-disk registry, deduped by run_id).

(no params)

### `autoloop_reset_agent`

Reset one of the subagent sessions (Coder or Reviewer) without losing Planner state — useful when a subagent loops on a stale belief.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | yes | Run id |
| `agent` | `'coder'` \| `'reviewer'` | yes | Which subagent to reset |

### `autoloop_stop`

Terminate the run. All sessions are stopped and ledger state is finalised.

| Parameter | Type | Required |
|-----------|------|----------|
| `id` | string | yes |

---

## Ultraapp (14)

Forge tab — turn a structured Q&A interview into a deployed web app reachable at `localhost:19000/forge/<slug>/`. See [`ultraapp.md`](./ultraapp.md) for the operator reference (lifecycle, conventions §1–§7, runtime modes, file layout, HTTP routes).

### `ultraapp_list`

List all ultraapp runs.

(no params)

### `ultraapp_get`

Full snapshot of a run: spec + chat + state.

| Parameter | Type | Required |
|-----------|------|----------|
| `id` | string | yes |

### `ultraapp_status`

Lightweight status (mode + timestamps).

| Parameter | Type | Required |
|-----------|------|----------|
| `id` | string | yes |

### `ultraapp_new`

Create a fresh run. Optionally seeds the interview with the user's first message.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `firstMessage` | string | | Free-form opening line; the interview Opus reads it before its first question |

### `ultraapp_answer`

Submit an answer to the current interview question.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | yes | Run id |
| `value` | string | yes | One of the question's `options[].value`, or `''` when using freeform |
| `freeform` | string | | Free-form text when none of the options fit |

### `ultraapp_add_file`

Upload a sample file to `examples/` (the interview engine will `extract_metadata` it).

| Parameter | Type | Required |
|-----------|------|----------|
| `id` | string | yes |
| `path` | string | yes |
| `content` | string \| Buffer | yes |

### `ultraapp_spec_edit`

Apply RFC 6902 JSON Patch ops to the AppSpec mid-interview.

| Parameter | Type | Required |
|-----------|------|----------|
| `id` | string | yes |
| `patch` | object[] | yes |

### `ultraapp_build_start`

Validate the spec strictly (shape + cross-refs + DAG) and enqueue the build. Council picks it up FIFO.

| Parameter | Type | Required |
|-----------|------|----------|
| `id` | string | yes |

### `ultraapp_build_cancel`

Abort an active build. Council sessions are stopped and the worktrees are left as-is for inspection.

| Parameter | Type | Required |
|-----------|------|----------|
| `id` | string | yes |

### `ultraapp_feedback`

Done-mode feedback. Haiku classifier routes into `cosmetic` (Opus patcher), `spec-delta` (focused interview + auto-rerun), or `structural` (suggest fresh run).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | yes | Run id |
| `text` | string | yes | The feedback (1+ chars) |

### `ultraapp_promote_version`

Atomically swap the deployed version. Stops the current container/process, starts the target's, updates the router map.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | yes | Run id |
| `version` | string | yes | Target version label (`v1`, `v2`, …) |

### `ultraapp_start_container`

Start the container/process for the active version (no-op if already running).

| Parameter | Type | Required |
|-----------|------|----------|
| `id` | string | yes |

### `ultraapp_stop_container`

Stop the container/process without deleting any state.

| Parameter | Type | Required |
|-----------|------|----------|
| `id` | string | yes |

### `ultraapp_delete`

Stop + remove the run completely (sessions, container, on-disk state, router entry).

| Parameter | Type | Required |
|-----------|------|----------|
| `id` | string | yes |
