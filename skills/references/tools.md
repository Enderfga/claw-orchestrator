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
| `jsonSchema` | string | JSON Schema for structured output |
| `mcpConfig` | string \| string[] | MCP server config file(s) |
| `settings` | string | Settings.json path or inline JSON |
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

## Codex (7)

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
