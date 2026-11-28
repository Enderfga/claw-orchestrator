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
│   └── Wraps: grok -p --output-format streaming-json (xAI Grok Build, per-message spawning)
├── engine: 'cursor'    → PersistentCursorSession
│   └── Wraps: cursor-agent -p --output-format stream-json (Cursor Agent, per-message spawning)
├── engine: 'opencode'  → PersistentOpencodeSession
│   └── Wraps: opencode run --format json, message on stdin (per-message spawning)
├── engine: 'acp'       → PersistentAcpSession
│   └── Wraps: any Agent Client Protocol agent on stdio (long-running, one ACP session)
└── engine: 'custom'    → PersistentCustomSession
    └── Wraps: any CLI via user-provided CustomEngineConfig
```

The `gemini` engine is legacy: still wired for existing callers, not documented as an option
(see the note under [Antigravity](#google-antigravity-engine-agy)).

### At a glance

| Engine      | Process                             | How the conversation carries over                                       | Where cost comes from                                                  |
| ----------- | ----------------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `claude`    | one long-running `claude -p`        | the live process; `--resume <id>` when a session is restarted           | the CLI's own `total_cost_usd` (registry estimate in proxy mode)       |
| `codex`     | one `codex exec` per send           | `codex exec resume <thread_id>`                                         | registry price × reported tokens                                       |
| `codex-app` | one long-running `codex app-server` | the live thread; `thread/resume` when a session is restarted            | registry price × reported tokens                                       |
| `agy`       | one `agy -p` per send               | `--conversation <id>`                                                   | registry price × reported tokens                                       |
| `grok`      | one `grok -p` per send              | `--resume <sessionId>`                                                  | grok's own `total_cost_usd`                                            |
| `cursor`    | one `cursor-agent -p` per send      | `--resume <chatId>`                                                     | registry price × reported tokens, for the model id each turn was given |
| `opencode`  | one `opencode run` per send         | `--session <id>`                                                        | opencode's own `step_finish` cost (registry estimate when none)        |
| `acp`       | one long-running agent process      | one ACP session; `session/resume` or `session/load` on restart          | what the agent reports (estimated from `pricing` when it reports none) |
| `custom`    | persistent, or one process per send | persistent: the live process (`args.resume` on restart); one-shot: none | registry price × reported tokens (see `pricing` below)                 |

## Supported Engines

### Claude Code (`engine: 'claude'`)

Default engine. Long-running subprocess with streaming JSON I/O. Tested with Claude Code CLI **2.1.332**.

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
- `settingSources` → `--setting-sources`, comma-joined: the settings files to load (`user`,
  `project`, `local`). An empty list is passed as `''` and loads none of them, so the user's MCP
  servers, plugins, model and env are not loaded; `settings` still applies. Another value is
  refused at start
- `strictMcpConfig` → `--strict-mcp-config`: only the servers of `mcpConfig`; with no `mcpConfig`,
  no MCP servers at all
- `pluginDir` → one `--plugin-dir` per entry: local plugin directories or `.zip` files, loaded for
  this session only
- `systemPromptSnapshot` → `--system-prompt-snapshot on|off`. With `on`, the CLI's default
  except under `bare`, the system prompt is recorded on the conversation's first request and sent
  as recorded on every later request and resume until the conversation is compacted: a session
  resumed with a different `appendSystemPrompt` keeps answering to the old one. `off` renders the
  prompt on every request, so the new one takes effect, including on a conversation that began
  with a recorded prompt
- `appendSubagentSystemPrompt` → `--append-subagent-system-prompt` (a flag `claude --help` does
  not list): standing instructions for the subagents the session starts
- `autoCompactWindow` → `--autocompact`: the CLI's own auto-compaction window, `auto` or a whole
  token count of at least 100000. It applies inside a turn, unlike `autoCompactPercent`, which
  compacts between turns. Anything else is refused at start; the CLI reads 100 to 1000 as
  thousands, so `200` is refused rather than taken as 200k
- `disableSlashCommands` → `--disable-slash-commands`: messages go in as text, with no skill or
  slash command expanded. That includes `/compact`: `compact()` then fails instead of sending it,
  and `autoCompactPercent` cannot compact the session (each attempt is logged as a failed
  auto-compact)
- `chrome: true` → `--chrome`; otherwise `--no-chrome`, so Claude in Chrome stays off even where
  the user has it on by default
- `sessionName` → `-n <name>`: the conversation's display name, which `--resume <name>` also
  accepts
- `images` on a send go in the stream-json user message as base64 `image` content blocks, media
  type from the file extension, ahead of the text block, which keeps the plan prefix. A file that
  cannot be read fails the send before the turn starts
- Fork subagent (`forkSubagent`), tool search (`enableToolSearch`), OpenTelemetry logging toggles (`otelLogUserPrompts`, `otelLogRawApiBodies`), the `xhigh` effort tier, and `stats.pluginErrors` capture — see [SKILL.md](../SKILL.md#claude-engine-options) and [tools.md](./tools.md)

```typescript
await manager.startSession({
  name: 'claude-task',
  engine: 'claude', // default, can omit
  model: 'opus',
  cwd: '/project',
});
```

#### Claude Code features through clawo

Most of what a Claude session can do beyond a plain message goes through stream-json control
requests, which the CLI answers in milliseconds, between turns or during one, without starting a
turn and without restarting the process.

| Feature | How clawo reaches it |
| --- | --- |
| Commands, skills, custom commands | `session_command list` reads the `initialize` control request: every slash command, skill (`source: skill`), plugin skill (`plugin`) and `.claude/commands` command (`custom`), with its description and argument hint. `session_command run` sends `/name args` as a message. A name the CLI has no command for is refused, since the CLI would pass it to the model as a paid turn. Aliases (`review`, `cost`) run. |
| Commands the CLI answers itself | `/usage`, `/context`, `/model`, a bare `/goal`, `/mcp` and the like end in a result with `local_command` set and no model turn. Such a result keeps the context size the last turn left, does not count in `turnsSucceeded` or `turns`, has no ledger row, and is not recorded for a handoff (`localCommand: true` on the send result). A forked skill such as `/code-review` is reported the same way by the CLI but runs a model: it is counted as a turn, with its spend, and leaves the context size alone. |
| Effort | Per send and `POST /session/effort` set `apply_flag_settings {effortLevel}` (`ultra` → `max`; `auto` clears it, since the CLI ignores `auto` there). A per-send effort is put back after its turn. The `ultrathink` keyword is not sent: on 2.1.332 it raises nothing (`ultrathink_available: false`). |
| Model | `session_switch_model` uses `set_model` in place (`live: true`), with no restart and no MCP or plugin reload. `model` on `session_send` runs that turn on another Claude model and switches back after it; a refused model fails the send. A model of another provider (the proxy) still restarts the session. |
| Plan per send | `plan: true` runs the turn under `set_permission_mode plan` and returns to the session's mode after it, with the planning instruction ahead of the message. The CLI writes the plan to its plans directory; `session_command run get-plan` reads it back. |
| Compaction | `session_compact` sends `/compact` and returns `{ok, preTokens, postTokens, trigger}` from `system/compact_boundary`; `ok: false` with the CLI's reply when nothing was compacted. The context size becomes the size after compaction, including after a compaction the CLI runs itself inside a turn (`stats.compactions` counts both). |
| Side question | `session_aside` uses `side_question`: answered from the conversation's context, nothing added to it, possible while a turn runs. Its spend shows in the next result's running cost. |
| Rewind | `session_rewind` uses `rewind_conversation` to the message that started the first dropped turn (`turns`, counting this session's model turns, or `messageId`); with `files`, `rewind_files` restores the files changed since. File checkpoints are on (`CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING=1` unless the environment sets it); a files rewind is checked with a dry run before anything changes. |
| Context breakdown | `coding_session_status.contextBreakdown` from `get_context_usage`: the categories in the context (system prompt, tools, memory files, skills, messages), read once per result. |
| Quota | `engine_quota` reads the windows of the session's last `rate_limit_event` (one comes with every turn), or `get_usage` before the first turn, which reports them only for a claude.ai login with the profile scope. |
| Turns the CLI starts itself | A `/loop` tick or scheduled wakeup is recognised from its `command_lifecycle` start (`wakeup_source`, or an id no message of the session has), a finished background workflow or task from its `origin`. Neither answers a waiting send nor counts as its success; each is an engine turn (`coding_session_status.engineTurns`, a ledger row with `origin: engine`). `/loop` runs until it is cancelled or the session stops. |
| ultracode | `ultracode: true` adds `Workflow` to `--allowed-tools` (unless `disallowedTools` names it, or in plan mode), since the default spawn denies a tool nobody can approve. `session_command run ultracode on` (or `off`) toggles it in a live session, allowing `Workflow` when on. |
| `fastMode`, `advisor`, `outputStyle` | Session options: `fastMode` and `outputStyle` go in `--settings` (a headless session is refused fast mode without the opt-in; the account and model must allow it, `stats.fastModeState` says what the CLI made of it), `advisor` is `--advisor <model>`, which the CLI ignores when the advisor is less capable than the main model. None writes a settings file. |

Control requests offered as commands (`source: rpc`, run beside a turn): `mcp-status` (servers,
status, tool names; a server's config, which can hold credentials, is left out), `mcp-reconnect
<server>`, `get-plan`, `background-tasks`, `stop-task <id>`, `ultracode on|off`, `applied-settings`
(the model, effort, advisor and ultracode in force; the merged settings, which can hold the
session's credential, are not returned), `permission-rules`, `hooks-listing`, `export-conversation`,
`workspace-diff`.

Not run through `session_command`: `/config` (writes the user settings file; use `settings`),
`/output-style <style>` (writes the project's `.claude/settings.local.json`; use `outputStyle`),
and the commands that need a person (`needsHuman`): `/focus`, `/doctor`, `/import`,
`/usage-credits`, `/design`, `/design-consent`, `/design-revoke`, `/auto-mode-setup`. Commands the
CLI itself refuses headless (`/help`, `/status`, `/btw`) have the control requests above as their
headless form. `fork_conversation` is refused by the CLI (it needs a remote-control server), so a
fork is still a new process with `--resume --fork-session`.

#### Claude accounts and rotation

One server can run Claude sessions under several Claude accounts, and move a session to another
account when one reaches its usage limit. Every account keeps the one Claude Code configuration
directory, so skills, hooks, settings and conversation transcripts are shared, and a conversation
continues under another account by its own session id. Accounts are listed in
`~/.claw-orchestrator/claude-accounts.json` (`CLAWO_CLAUDE_ACCOUNTS` relocates it):

```json
{
  "accounts": {
    "team": { "kind": "oauth" },
    "max": { "kind": "oauth", "tokenCommand": ["security", "find-generic-password", "-s", "claude-max", "-w"] },
    "payg": { "kind": "apiKey", "tokenEnv": "ANTHROPIC_BACKUP_KEY" },
    "gateway": { "kind": "gateway", "baseUrl": "http://127.0.0.1:8080" }
  },
  "rotation": ["team", "max", "payg", "gateway"],
  "default": "auto",
  "switchAt": 0.95
}
```

- **Kinds.** `oauth` is a subscription token from `claude setup-token`; `apiKey` an Anthropic API key,
  billed per use; `gateway` an Anthropic-compatible endpoint (`baseUrl`) with its own auth token, plus
  any environment it needs (`env`). A gateway on another host must use https; plain http is accepted
  only on this machine (`localhost`, `127.0.0.0/8`, `::1`).
- **The file is trusted like your Claude Code settings.** It names commands the server runs and
  endpoints it sends credentials to, so the server reads it only when it belongs to the server's user
  and neither group nor others can write it (`chmod 600`); otherwise sessions that need it fail to
  start, naming the file.
- **Credentials** come from the server's own environment, `tokenEnv` (default
  `CLAWO_CLAUDE_TOKEN_<NAME>`), or from the stdout of `tokenCommand`, an argv run without a shell. A
  session is never started on another login when an account's credential is missing; the start fails
  and names the source. The credential reaches the CLI in a `--settings` file with mode 0600 in a
  private directory, removed when the process ends, when the server exits, or, after a crash, by the
  next server: a `--settings` value outranks the `env` of the user's settings file, which in turn
  outranks the process environment. The other kinds' variables are set to neutral values in the same
  file, so a gateway or token configured in the user settings does not win over the account.
- **Choosing.** `claudeAccount` on `session_start` names an account, or `auto` for the first available
  account in `rotation`; `default` applies the same to sessions that name none, and without it they
  use the CLI's own login. An account runs a Claude model against the account's own endpoint, so it
  cannot be combined with `baseUrl`, a non-Claude model (served through the built-in proxy) or
  `CLAWO_CLAUDE_GATEWAY`; the default simply does not apply to such sessions. The session's status
  reports the account it runs under (`claudeAccount`).
- **Rotation.** A session on an account in `rotation` moves to the next available one, in rotation
  order, when the account refuses a turn (`usage_limit_reached`), and the turn is sent again on the
  same conversation, at most once per account. It also moves before a turn once any of the account's
  usage windows has reached `switchAt`, as reported by the CLI after every turn. A refused account is
  skipped until its window resets, and the server shares this across its sessions. An account outside
  `rotation` never moves. A Claude Code goal (`clawo goal --claude-account auto`, `claudeAccount` on a goal
  node) moves the same way when the account refuses one of its turns, and goes on at once instead of waiting
  for the limit to reset. A session started with `noSessionPersistence` keeps no transcript to
  resume, so it does not move either: its turn fails with the limit.

### OpenAI Codex (`engine: 'codex'`)

Wraps the `codex exec` subcommand. Each `send()` spawns a new process. Tested with `codex` CLI **0.172.0**.

- Non-interactive execution via `codex exec --sandbox workspace-write --skip-git-repo-check --json`
- Real `usage` from the `turn.completed` JSON event (input, output, cached, reasoning tokens). **These are cumulative over the thread, not per turn**, so they replace the session totals rather than being added to them; subtracting consecutive values gives one turn's prompt
- `contextPercent` is the per-turn prompt measured against **codex's own context limit** (`model_context_window`, read from the thread's rollout file), not the model's published window in the registry. Resuming a thread also seeds the token baseline from the rollout, so the first send does not count the whole thread history as one prompt. This is best-effort: an unreadable or `--ephemeral` thread falls back to the registry window
- `item.completed` parsing distinguishes `reasoning` / `todo_list` (logged, not counted) from real tool items (`command_execution`, `file_change`, `mcp_tool_call`, `web_search`, which increment `toolCalls`; a non-zero `command_execution.exit_code` increments `toolErrors`)
- Reasoning effort: the engine-agnostic `effort` maps to `-c model_reasoning_effort=<level>` for `low|medium|high|xhigh|max|ultra`; `auto` passes nothing. Only those levels are passed, because codex does not validate `-c` values at spawn: an unlisted one would fail at the API rather than at the command line. A send's own `effort` applies to that turn's process only
- Per-send model (`perSendModel`): `session_send` `model` → `--model` for that turn's process only, billed at that model; the next turn goes back to the session's. `session_switch_model` and effort switches are live (`live: true`): each turn is a new process, so nothing restarts
- Plan mode: `codex exec` has none, so `plan: true` on a send (or `turnCommand: "/plan"` on the session) puts the planning prefix the Claude and custom engines use in front of the message
- Sub-agents (on by default; proactive at effort `ultra`) are threads of their own, and `turn.completed` reports the main thread's usage only. After each turn the session reads the sub-agents' ids from the thread's rollout (`SubAgentActivity.agent_thread_id`) and each sub-agent's total from its own rollout, and adds them to the session's usage, priced at the sub-agent's model. An `--ephemeral` thread writes no rollouts, so its sub-agents go uncounted
- `appendSystemPrompt`: codex has no system-prompt flag, so it is placed at the top of the first message of each new conversation (a resumed thread already carries it)
- `jsonSchema` → `--output-schema <file>` (written to a temp file, accepted by `exec` and `exec resume`)
- The turn's result is the final message, which codex writes to the file named by `--output-last-message` (a temp file per turn, removed after it is read). The JSON stream carries every agent message of the turn, commentary included ("Running the command." before the answer, with no phase to tell them apart), and those still stream through `onText`; when codex writes no file, the result falls back to all of them
- `images` on a send → one `--image=<path>` per image, before the trailing `-` (accepted by `exec`, `exec resume` and `exec fork`). The `=` form matters: `-i <file>…` takes several values and would read the `-` as one more image
- `codexConfig` → `-c key=value` on every turn (a string value quoted as TOML); `codexFeatures` → `--enable` / `--disable` on every turn; `ignoreRules` → `--ignore-rules`. A `codexConfig` key the wrapper sets itself (`sandbox_mode`, `approval_policy`, `approvals_reviewer`, `model_reasoning_effort`) fails the session at start
- `noSessionPersistence` → `--ephemeral` (accepted by `exec` and `exec resume`); `ignoreUserConfig` → `--ignore-user-config`, which stops `$CODEX_HOME/config.toml` from choosing the model for an orchestrated run (auth still resolves from `CODEX_HOME`); `addDir` → `--add-dir` on the first turn only, since `exec resume` rejects it and the resumed thread keeps the roots it opened with
- `codexProfile` → `--profile <name>` (named config profile from `~/.codex/config.toml`), first turn only
- `forkSession` with `resumeSessionId`: the first send runs `codex exec fork <id>`, which starts a new thread holding that thread's history; the session takes the new thread's id from `thread.started` and resumes it from then on. Like `exec resume`, `exec fork` takes no `--sandbox`, `-C`, `--profile` or `--add-dir`, so the sandbox is restated as `-c sandbox_mode="<mode>"`. The fork continues the source thread's cumulative usage, so the source's rollout is the first turn's token baseline
- Project trust: since codex 0.169.0 a run loads a project's own configuration and MCP servers (`.codex/` in the project) only in a directory codex trusts, whatever the sandbox mode; the user's `~/.codex/config.toml` applies everywhere. The wrapper does not pass `--trust`, which saves the trust for every later run. Trust a project once with `codex exec --trust` or under `[projects]` in `~/.codex/config.toml`
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
- **Through a short-lived app-server.** What `codex exec` cannot do runs on a `codex app-server` started for the
  job, with the session's `codexConfig`, `codexFeatures` and effort, that loads the thread (`thread/resume`) and
  is stopped when the job ends; the next `codex exec resume` goes on from what it left in the rollout. Each
  needs the thread (after the first send) and a persisted one (not `noSessionPersistence`):
  - `session_compact` and `autoCompactPercent`: `thread/compact/start`, waiting for the compaction's turn to end.
    Before the first send, or on an ephemeral thread, the outcome is `ok: false` with the reason, and no process starts
  - `session_aside`: `thread/sample` after the thread's latest turn (`experimentalApi`); the answer is not added
    to the conversation and uses no tools. Its usage, reported in the response only, is added to the session's.
    Loading the thread appends to its rollout, which a running `codex exec` writes too, so on `codex` an aside
    is refused while a turn runs (on `codex-app` it samples the turn in flight)
  - `session_rewind` (`turns`): `thread/revert`, counting the turns a user message started (a review's and a
    compaction's turns go with the turn before them). Files stay as they are; `files: true` and `messageId` are refused.
    A reverted thread goes on in a rollout file of its own (`rollout-…-<thread_id>_<segment>.jsonl`), which the
    session reads from then on
  - `review` and `inject`, `shell`, `rename`, `memories on|off|summary` below
  - `thread`, `items` and `search` read the stored thread on a short-lived app-server without loading it, so they
    also run while a turn does; `exec`, `threads`, `modes`, `providers` and `requirements` need no thread
- **Commands** (`commandStyle: 'rpc'`; `session_command`). Codex parses slash commands in its TUI only: `codex exec`
  and the app-server's `turn/start` hand `/status` to the model as text (0.172.0), so clawo never sends slash text.
  Each command is the RPC behind it ([the list](#codex-commands)); on `codex`, `ps`, `stop`, `diff`, `queue`,
  `turn` and `implement` are not offered (no live app-server holds the thread, its terminals or its diffs), nor
  `mcp reload` or `skills roots` (each `codex exec` turn is a process of its own that reads its configuration).
  `init` sends Codex's own `/init` prompt
  (it writes `AGENTS.md`), and a skill runs as a turn with Codex's `$name` mention
- `turnCommand`: `/plan` (the planning prefix on every message) or a skill name (`$name` before every message);
  anything else is refused at start
- `engine_quota` (`codex`, `codex-app`): `account/rateLimits/read` on a short-lived app-server (free); a live
  `codex-app` session is asked on its own
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

Wraps `codex app-server --listen stdio:// --enable goals` as a long-running JSON-RPC subprocess. **Required for `/goal` long-horizon objective support** — Codex's exec subcommand has no goal surface. Goals are stable and on by default since 0.172; `--enable goals` stays for older builds. Tested with `codex` CLI **0.172.0**.

- Long-running subprocess; one `codex app-server` per session
- JSON-RPC 2.0 over stdio with v2 protocol method names (`initialize`, `thread/start`, `turn/start`, ...). `initialize` declares `capabilities.experimentalApi`, which plan mode, `thread/sample`, `thread/settings/update`, `thread/memoryMode/set` and the background-terminal RPCs need
- Real-time streaming via `item/agentMessage/delta` notifications (`item/plan/delta` in plan mode)
- **Sub-agents.** Multi-agent is on by default, and the app-server carries each sub-agent's thread beside the session's: its items, usage and `turn/completed` arrive with the sub-agent's thread id, often before the parent's turn ends. Only the session thread's notifications reach the turn (text, answer, tool counts, `turn/completed`), as `codex exec`'s own client filters them; a send resolves on its own turn's `turn/completed` (the id `turn/start` returned). Each thread's cumulative usage is kept, and the session's is their sum, each thread priced at its own model (`subAgentActivity.model`). A sub-agent's messages are logged
- Cumulative token tracking from `thread/tokenUsage/updated` notifications. The same notification's `last` breakdown and `modelContextWindow` drive `contextPercent`, so it reports live occupancy against the window the server enforces rather than a running total over the model's published window. A compaction reports `last.inputTokens: 0` with the compacted context as `last.totalTokens`, which is then the figure
- Turns no send waits for: a goal loop's turns, a turn whose send timed out. They are counted in `turns` but never in `turnsSucceeded`, and emit `result`; without a goal on the thread they are also `unsolicited_result` (an engine turn in the ledger). With a goal, the goal reports its own spend
- `appendSystemPrompt` → `developerInstructions` and `systemPrompt` → `baseInstructions` on `thread/start` (`baseInstructions` replaces codex's own base prompt). Each reaches the model as a developer message of its own; a resumed or forked thread already carries the ones it was opened with, so they are not sent again
- The turn's result is the agent message the server marks `phase: "final_answer"`, else a plan-mode turn's plan, else the turn's last agent message: the turn's commentary arrives as agent messages too. Every message still streams through `onText`
- The turn's diff (`turn/diff/updated`, the last of the turn) is on its result event as `diff` and answers the `diff` command. Codex reports the edits its patch tool made; a file written by a shell command is not in it
- `noSessionPersistence` → `ephemeral: true` on `thread/start` (an ephemeral thread cannot list its turns, so `codex_rollback` does not work on it); `jsonSchema` → `outputSchema` (the parsed schema) on every `turn/start`, refused at start if it is not JSON
- `images` on a send → `localImage` inputs before the text of `turn/start`
- `addDir` (workspace-write only) → `sandboxPolicy` on every `turn/start`: the policy `thread/start` reported, with the directories added to its `writableRoots`, so the network access and roots the user's config gives are kept. It applies from the first send on; a goal loop started before any send runs without them
- Project trust: `thread/start` with a writable sandbox in a git repository records the project as trusted in the
  user's `~/.codex/config.toml` (0.172.0; `thread/resume` and `thread/fork` do not). A new thread is therefore opened
  `read-only` and given the session's sandbox with `thread/settings/update` before any turn: `dangerFullAccess`, or a
  `workspaceWrite` policy built as codex builds it from `[sandbox_workspace_write]` (the user's configuration for the
  directory, read with `config/read`, under the session's `codexConfig` `sandbox_workspace_write.*` keys). As with
  `codex exec`, a project's own `.codex/` configuration then loads only where the user trusts the project
- `codexConfig` → merged into the thread's `config` on `thread/start`, `thread/resume` and `thread/fork`, beside `model_reasoning_effort`; `codexFeatures` → `--enable` / `--disable` on the `codex app-server` command line, after `--enable goals`. `ignoreRules` fails the session at start: `codex app-server` has no `--ignore-rules`
- `item/completed` items that are not messages, reasoning or the plan (`commandExecution`, `fileChange`, `mcpToolCall`, `webSearch`, …) count as `toolCalls`; a `commandExecution` with a non-zero `exitCode` counts as a `toolErrors`
- Reasoning effort: the session `effort` opens or resumes the thread with `config: { model_reasoning_effort }`, so the goal loop's own turns use it too, and each `turn/start` carries `effort` (the per-send override, else the session's), so `setEffort` reaches the next turn. The levels are the same as `codex`'s; `auto` passes nothing. `turn/start`'s model and effort stay on the thread for the turns after it, so a per-send one is undone on the next turn: the session's, else the one the thread opened with
- Per-send model (`perSendModel`): `session_send` `model` → `turn/start` `model` for that turn, billed at that model, restored on the next turn
- Live switches: `session_switch_model` and effort switches go through `thread/settings/update` (`live: true`), with no restart. `auto` has no value to set, so it waits for the next turn
- Plan mode: `plan: true` on a send (or `turnCommand: "/plan"`) → `turn/start` `collaborationMode: { mode: "plan", settings: { model, reasoning_effort } }`. The mode stays on the thread, so the next send without it sends `mode: "default"`. The answer is the `plan` item; a plan turn has no final agent message. `item/tool/requestUserInput` in plan mode is answered with an error like every server request
- `model/rerouted` moves the billing to the model the server rerouted the thread to; `warning`, `configWarning`, `deprecationNotice` and `guardianWarning` go to the log; `hook/started` / `hook/completed` are logged, and emitted as `event` with `includeHookEvents`
- `sessionName` → `thread/name/set` after the thread opens (the TUI's `/rename`)
- Goals through the typed RPCs `thread/goal/set` / `get` / `clear`: setting an objective starts the server's own turn loop, which runs until the goal is `complete`, `budgetLimited`, `blocked`, `usageLimited` or `paused`. Each change arrives as `thread/goal/updated`. The `codex_goal_*` tools wrap these; the kernel's `goal` node drives them for unattended runs ([workflow.md](./workflow.md#goal))
- `error` notifications are read as `{ error: { message, codexErrorInfo }, willRetry }`. The session keeps the last one (`lastError`, with `codexErrorInfo` as a name such as `serverOverloaded`) and emits it as `codex:error`; an error notification never throws when nothing listens for errors
- v2 RPC tools (Codex 0.137): `codex_interrupt` (`turn/interrupt`), `codex_steer` (`turn/steer`, including into a turn the goal loop started), `codex_fork` (`thread/fork`), `codex_rollback`, `codex_models` (`model/list`), `codex_thread_list` (`thread/list`). A `turn/completed` with `status: 'failed'` rejects the turn and increments `toolErrors`.
- `codex_rollback` and `session_rewind` (`turns`): codex 0.171 removed `thread/rollback`. The session lists the newest turns (`thread/turns/list`, newest first), counts the ones a user message started, and reverts the thread to before the oldest of N of them (`thread/revert`). A review's turn and its reviewer's inner turn, and a compaction's turn, have no start boundary to revert to (0.172.0 refuses one), so they go with the turn before them. This changes the conversation history only; files the dropped turns edited stay as they are (`files: true` is refused, as is `messageId`). It is refused while a turn is in flight, and when the thread has fewer than N turns
- `codex_thread_list` passes `sourceKinds: ["cli", "vscode", "exec", "appServer"]`: without it the server lists interactive threads only, leaving out the ones `codex exec` started
- Threads are opened and resumed with `approvalPolicy: "never"`, and a server request the session cannot handle (an approval, a request for user input) gets an error reply at once: nothing here can answer one, and an unanswered request blocks its turn. The sandbox mode is the boundary.
- Thread resume: starting with `resumeSessionId` loads the existing thread via `thread/resume` (with `excludeTurns: true`: the session does not read the history it would return) instead of `thread/start`. With `forkSession` as well, `thread/fork` opens a new thread holding that one's history and the session continues the new thread. The id the session manager stores and replays (model switch, restart) is the app-server's own thread id. A thread resumed with an active goal continues it on its own. An id that `thread/resume` or `thread/fork` rejects falls back to a new thread (logged); the `goal` node refuses that case rather than start the goal over.
- `session_compact` and `autoCompactPercent`: `thread/compact/start`, resolved once the compaction's own turn has ended; a send right after it would otherwise be refused (`ActiveTurnNotSteerable { turn_kind: Compact }`). The compaction's turn is not counted and reports no result; it is refused while a turn is in flight. Codex compacts with its own prompt
- `session_aside`: `thread/sample` after the thread's latest turn, the one in flight included (`allowInProgressTurn`); nothing is added to the conversation and no tool runs. Its usage is in the response only, and is added to the session's. An answer with no text (the model tried a tool) is an error
- `engine_quota`: `account/rateLimits/read` on the session's own app-server
- **Commands** (`commandStyle: 'rpc'`, `session_command`); see [the list](#codex-commands). `review` runs `review/start` on the session's thread (inline, as the TUI's `/review`); its answer is the `exitedReviewMode` review. The reviewer sends no usage while it runs, so its rollout (`"subagent": "review"`, `parent_thread_id` the thread) is read when it ends. `shell` (`thread/shellCommand`, the TUI's `!cmd`) runs unsandboxed whatever the thread's sandbox, so it is offered and run only on a `danger-full-access` session; like a compaction, its turn is no model turn
- `exec` (`command/exec`) runs a command through the platform shell (`/bin/sh -c`, `cmd.exe /c` on Windows) in the
  session's directory and in the thread's own sandbox: the policy `thread/start` or the start-time settings update
  reported, the user's network setting included, with `addDir` writable. On `codex` the policy is built from
  `sandboxMode` with network access off, Codex's default. Nothing reaches the conversation; a timeout is exit code 124
- `queue` drives the thread's message queue (`thread/queue/*`), which Codex keeps with the thread: once the thread
  is idle, after a turn that was not interrupted, the server starts the first queued message as a turn of its own,
  so its result arrives as an engine turn (`coding_session_status` `engineTurns`, a ledger row with
  `origin: "engine"`). A message queued on an idle thread starts at once; between a goal's turns, a queued message
  runs before the goal's next turn. A send while a queued message's turn runs is steered into that turn. A message
  still queued when the session stops runs when the thread is next resumed; `queue start [<id>]` starts one now,
  which an interrupted turn needs (the queue does not move on after an interrupt)
- `turn` (`turn/settings/update`) changes the running turn's model, effort or reasoning summary for the rest of
  that turn; the next turns keep the session's. The rest of the turn bills at the model it switched to. Codex takes
  it only with its `step_model_switching` feature on (under development, off by default in 0.172.0):
  `codexFeatures: { enable: ['step_model_switching'] }`. Codex refuses some model switches within a turn (a model
  with other tool requirements); its reason is passed on
- `implement` (`thread/prepareApprovedPlan`) puts an approved plan in the thread's context, as the output of the
  plan tool, and runs the turn Codex prepares ("Implement the plan."). Given a file instead of text, it is read and
  also named as the plan's attachment, which Codex has the turn read. It needs no turn in flight
- `thread` adds the threads loaded on the session's app-server (`thread/loaded/list`): its own and its
  sub-agents'. `mcp reload` (`config/mcpServer/reload`) rereads the MCP servers' configuration for the next turn;
  `skills roots <dir>...` (`skills/extraRoots/set`) adds skill directories for this app-server only, nothing is
  written to the user's configuration
- A `session_aside` that times out cancels its sample (`thread/sample/cancel`), which would otherwise go on spending
- `turnCommand`: `/plan` or a skill name (the skill as a `skill` input item on every turn); anything else is refused at start
- `clawo goal "<objective>" --check "npm test"` runs the `goal` workflow from the command line: one goal on one thread, then the runtime's own checks, then repair on the same thread ([cli.md](./cli.md#clawo-goal)).

#### Codex commands

`session_command` on `codex` and `codex-app`. Info commands run beside a turn and record no ledger row; the
others wait for the send in flight.

| Command                                                                   | RPC                                                                                                                                     | Turn                 |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| `status`                                                                  | `account/rateLimits/read`: plan and windows; `account/read`: how the account signs in (no address or ids)                               | no                   |
| `usage`                                                                   | `account/usage/read`: lifetime and the last 7 days                                                                                      | no                   |
| `model`                                                                   | `model/list`: ids and reasoning efforts                                                                                                 | no                   |
| `mcp [reload]`                                                            | `mcpServerStatus/list`: name, auth, tool count; `reload` (codex-app) `config/mcpServer/reload`                                          | no                   |
| `skills [roots <dir>...]`                                                 | `skills/list` for the session directory; `roots` (codex-app) `skills/extraRoots/set`, this app-server only                              | no                   |
| `hooks`                                                                   | `hooks/list`                                                                                                                            | no                   |
| `plugins`                                                                 | `plugin/installed`                                                                                                                      | no                   |
| `apps`                                                                    | `app/installed`                                                                                                                         | no                   |
| `experimental`                                                            | `experimentalFeature/list`: stage, on/off                                                                                               | no                   |
| `permissions`                                                             | `permissionProfile/list`                                                                                                                | no                   |
| `config`                                                                  | `config/read`: model, provider, sandbox, approval keys, feature flags, MCP server and profile names; nothing that can hold a credential | no                   |
| `memories [on\|off\|summary]`                                             | `memory/status`; `on`/`off` `thread/memoryMode/set` on the thread; `summary` `thread/memory/read`                                       | no                   |
| `rename <name>`                                                           | `thread/name/set`                                                                                                                       | no                   |
| `rollout`                                                                 | the thread's rollout file                                                                                                               | no                   |
| `ps`, `stop [<processId>]` (codex-app)                                    | `thread/backgroundTerminals/list`, `…/clean`, one with `…/terminate`                                                                    | no                   |
| `thread`                                                                  | `thread/read`: name, status, model, directory, Git, rollout; on codex-app `thread/loaded/list`                                          | no                   |
| `items [<turnId> [<itemId>...]]`                                          | `thread/items/list`: the last 20 items, or a turn's; `thread/items/read` for the items named                                            | no                   |
| `search <text>`                                                           | `thread/searchOccurrences`: where the text occurs in the thread's messages                                                              | no                   |
| `threads <text>`                                                          | `thread/search`: full-text search of the local Codex history                                                                            | no                   |
| `modes`                                                                   | `collaborationMode/list`                                                                                                                | no                   |
| `providers`                                                               | `modelProvider/list` (id, name, kind, default) and `modelProvider/capabilities/read`                                                    | no                   |
| `requirements`                                                            | `configRequirements/read`: what an administrator restricts; provider entries by name only                                               | no                   |
| `exec <command>`                                                          | `command/exec` in the session's sandbox and directory                                                                                   | no                   |
| `queue [add \| delete \| update \| reorder \| start …]` (codex-app)       | `thread/queue/*`: each queued message runs as the next turn once the thread is idle                                                     | an engine turn       |
| `turn model=… effort=… summary=…` (codex-app)                             | `turn/settings/update` on the turn in flight (needs `codexFeatures` `step_model_switching`)                                             | no                   |
| `diff` (codex-app)                                                        | the last turn's `turn/diff/updated`                                                                                                     | no                   |
| `compact`                                                                 | `thread/compact/start`                                                                                                                  | not billed as a turn |
| `review [uncommitted \| base <branch> \| commit <sha> \| <instructions>]` | `review/start` inline                                                                                                                   | yes                  |
| `init`                                                                    | Codex's `/init` prompt as a turn                                                                                                        | yes                  |
| `implement <plan \| plan file>` (codex-app)                               | `thread/prepareApprovedPlan`, then the turn it prepares                                                                                 | yes                  |
| `inject <text>`                                                           | `thread/inject_items`: a user message in the history, no turn                                                                           | no                   |
| `shell <command>` (danger-full-access only)                               | `thread/shellCommand`                                                                                                                   | not a model turn     |
| `<skill>`                                                                 | a turn with the skill (`skill` input on codex-app, `$name` on codex)                                                                    | yes                  |

Not offered, with where clawo has them: `/goal` (`codex_goal_*`, the workflow goal node), `/plan` (`plan` on a
send, `turnCommand`), `/fork` and `/side` (`codex_fork`, `session_aside`), `/model` switching
(`session_switch_model`), `/new` `/clear` `/resume` (`session_start`). The TUI's pickers, account and global
settings commands (`/approve`, `/logout`, `/import`, `/theme`, `/statusline`, `/keymap`, `/vim`, `/voice`,
`/feedback`, `/archive`, `/delete`, …) need a person or change the user's own state, and are not offered.
Of the app-server's other methods, those that sign in, set up providers or the Windows sandbox, write the user's
configuration, plugins or skills settings, send something outward (plugin sharing, emails), or serve a client's own
screens (file pickers, sidebar sections, projects, attachments, read markers, MCP Apps, host file and process access)
are not offered; `memory/reset` (it deletes the user's memories for every thread) and `rollout/compress` (it
compresses every rollout in the user's Codex home) are not either. The decision for each method is in
`scripts/sweep-reviewed.json`.

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
in print mode, with the message as the `-p` argument. Tested with `agy` **1.5.17**.

- One-shot execution per message (no persistent subprocess)
- **Structured output and real usage** — `--output-format stream-json` emits an
  `init` event with the conversation id and the model the run is on, progress
  events, and a final `result` with the response. A turn's usage is the sum of its
  own requests, each reported on its `agent_response` (or, for a compaction,
  `checkpoint`) step: the result's `usage` is the conversation's running total
  (measured on 1.5.18–1.5.19: a resumed conversation's result reports every
  request since it began, and equals the sum of agy's transcript for it). agy's
  input count leaves the cache reads out, so they are counted and priced
  separately, at the model's cached rate. A run cut short is counted from the
  steps it reported; estimated usage remains the fallback when there are none.
- **Billing model**: a turn is priced at the model it ran on — the send's own
  `model` when it has one, the session's otherwise, and agy's reported `init.model`
  for a session that names none (agy's own default, which can be a Pro model).
- **Real conversation continuity**: the engine captures the id from stream-json
  and resumes with `--conversation <id>` on later sends. A private `--log-file`
  scrape remains as a fallback for turns that die before emitting `init`. Seed it
  externally via `resumeSessionId` (bare UUID only); read it back from
  `getStats().agyConversationId`.
- **Empty responses fail**: an exit-0 model turn with a missing or blank response
  is treated as a failed turn, not a successful empty reply, and is not retried.
  An info command's answer and a `/compact` are judged otherwise (below).
  A conversation id already received from `init` is kept for the next send. When
  the failure follows a tool confirmation refused in plan mode, the error says so
  (a fixed message; native log content is not exposed).
- **Refused tools**: when agy refuses tools but still replies, the refused tool
  names are exposed as `SendResult.permissionDenials` alongside the reply.
- `appendSystemPrompt`: agy has no system-prompt flag, so it is placed at the top
  of the first message of each new conversation — after the command, when that
  message is one (`/goal <instructions> --- <objective>`), since agy reads a command
  only at the very start of the prompt. The read-only note goes the same way. An
  info command takes neither.
- **Reasoning effort**: session `effort` and per-turn `session_send` overrides map
  to `--effort`. agy accepts `low`, `medium` and `high`, and `xhigh` on
  `gemini-4-hydrogen` and `gemini-4-neon`; anything above a model's top tier (`xhigh`, `max`,
  `ultra`) clamps to that tier. agy requires an effort with unsuffixed base
  slugs such as `gemini-3.8-flash`, so `auto` resolves those to `high`; a model
  already ending in `-low`, `-medium`, `-high` or `-xhigh` keeps that qualified effort.
  Per-turn overrides also work with qualified slugs: the adapter removes a
  conflicting suffix before passing the new `--effort`, avoiding agy's conflict
  error.

  Tiers are not uniform across agy models — `gemini-4-argon` (the `agy-pro`
  alias) has no `xhigh`, and agy names the tiers a model has when it refuses one.
  The adapter passes `low`, `medium` and `high` through rather than substituting a
  tier the caller did not ask for; run `agy models` to see the tiers a slug actually exposes.

- Permission modes are always passed explicitly, because agy's own default for a
  headless run is Auto mode (since 1.5.7), where its reviewer can let a command run
  that the session was not given:
  - `bypassPermissions` (or `dangerouslySkipPermissions`) → `--dangerously-skip-permissions`;
  - `default`, `manual` and `dontAsk` → `--sandbox` (terminal-restricted) in agy's
    Default mode (`"agentMode": ""` merged into `--settings`). A headless run cannot
    ask, so every tool call that needs permission is refused;
  - `acceptEdits` → `--mode accept-edits`, `auto` → `--mode auto`, `plan` → `--mode plan`.
    Auto mode is agy's own policy and widens with agy releases: since 1.5.14 it reads
    files outside the workspace without asking, and since 1.5.16 it also creates and
    edits them when the file is inside a version-controlled repository or the change
    only adds content;
  - `sandboxMode: 'read-only'` → `--mode plan` (takes precedence). Plan mode refuses shell commands and edits, and
    a headless agy turn whose tool is refused ends with no reply (measured on 1.5.16). So every read-only turn tells
    the agent to read with its file tools, and a turn a refused tool ended empty is continued in the same
    conversation, at most twice within the turn's timeout, naming the refused tool. Allowing commands instead is not
    read-only: an allow rule such as `command(*)` also approves a command's request to run outside agy's terminal
    sandbox, which then wrote to the workspace, the home directory and git (measured).

  Since agy reads only the last `--settings` it is given, the Default mode is merged
  into the session's own `settings`, which must then be a JSON object, inline or in a
  file; anything else fails the turn rather than run without it. A caller must
  explicitly choose `bypassPermissions` for a write-enabled session; it is
  not a recovery mechanism. In particular, an Autoloop Planner stays on
  `--mode plan` when its preserved conversation is resumed.

- `settings` is passed as `--settings`: settings.json keys as inline JSON or a file path, for this run only. agy refuses a key it does not know.
- `autoCompactWindow` → the `AGY_CLI_AUTO_COMPACT_OVERRIDE` environment variable (agy 1.5.15+): the token count
  at which agy compacts the conversation, at least 100000; `auto` leaves agy's own threshold. Measured on 1.5.16 in
  print mode: a window of 110000 compacted a conversation of two 65K-token messages on the second turn, and a
  window smaller than the message failed the turn.
- Session options passed on every turn (each turn is a new process):
  - `jsonSchema` → `--json-schema`. agy enforces it on the turn's final result,
    returning the JSON as the reply text and the parsed value as `structured_output`
    on the result event; if the reply text is empty, the structured value is the
    reply. A value starting with `{` is inline JSON, anything else a file path,
    passed as an absolute path resolved against the session's `cwd`. agy refuses a
    schema whose root is not an object with `"type": "object"`, so `start()` refuses
    it first, along with an unreadable file;
  - `addDir` → one `--add-dir` per entry. Measured on agy 1.5.13 with one added
    directory: a shell command the agent ran without naming a directory ran in the
    added directory, not in `cwd`;
  - `agent` → `--agent`. An unknown name fails the turn with agy's message listing
    the agents there are;
  - `disableSlashCommands` → `--disable-slash-commands`. Without it a message
    starting with `/` that names a skill or command is read as one (see
    [Commands](#agy-commands)). A message starting with an absolute path names
    neither and reaches the model as written. A command run through
    `session_command`, a `plan` send, a compaction and a native goal read commands
    whatever this says; `turnCommand` is refused beside it.
- A message that is a single token starting with `-` (`--version`, `-h`, `-c`) is
  passed with a trailing newline, because agy reads a `-p` value that is exactly
  one of its flags as that flag (printing its version or help, or exiting 2).
- Tool calls are counted in `stats.toolCalls` from the `tool_info` and
  `subagent_info` steps of the stream, once per step (agy reports a tool step when
  it starts and again when it is done), including those of a subagent.
- The engine always passes `--print-timeout`, set just inside the send timeout
  (10% earlier, at most 10s). Since agy 1.2.9 a headless run whose agent started a
  background task (a dev server, a watcher) stays open until that deadline and
  delivers the reply when it exits, ending the task; the earlier deadline lets it
  do so before the send times out. A run that reaches the deadline while the agent
  is still working fails as a timeout, partial reply or not. agy 1.4.11+ reports
  that as `finished_reason: print_timeout` on the result, which decides; for a
  result without the field, agy's stderr line and the elapsed time do. Any other
  `finished_reason` (`interrupted`, `error`) also marks the turn failed. Without
  the flag a stuck headless agy turn can run indefinitely
- Do not rely on an unknown `--model` falling back: current agy versions can
  report `status: ERROR` with no usable response. The adapter rejects result
  errors, non-success statuses, and empty responses. `agy-flash` and the engine
  default resolve to `gemini-3.8-flash`; `agy-pro` resolves to `gemini-4-argon`,
  the Pro-class Gemini 4 model every agy sign-in offers. `gemini-4-hydrogen` and,
  with a `GEMINI_API_KEY` (or, for Neon, Application Default Credentials),
  `gemini-4-carbon` and `gemini-4-neon` are registered too. The registry also
  describes the 3.5/3.6/3.7 Flash and 3.1 Pro API models for pricing and routing,
  but agy's own `agy models` output decides which slugs are executable (agy 1.5.8
  dropped `gemini-3.1-pro`). agy also proxies Claude and GPT-OSS models, which
  pass through unregistered. The `agy/` prefix forces Antigravity routing for
  provider-like model strings.
- Consumer auth is a one-time `agy` Google OAuth login (subscription quotas, no
  per-token billing — registry pricing mirrors Gemini API rates as a value proxy).
  An effort-qualified slug such as `gemini-4-argon-high` is priced as its base model
- Requires `agy` installed: `curl -fsSL https://antigravity.google/cli/install.sh | bash`
- Binary: `agy` (set `AGY_BIN` env var to override)

- **Orchestrator models** (`gemini-pro-orchestrator`, `-neon`, `-argon`, alias
  `agy-orchestrator`) plan on one model and execute on another, both of agy's
  choosing, and take no `--effort`: none is passed, and a session effort is
  ignored with a log line. Measured on 1.5.19, every variant planned on
  `gemini-4-neon-high` and executed on `gemini-4-hydrogen-high`. Such a turn is
  priced request by request from agy's transcript of the conversation, which
  names each request's model; anything the transcript does not account for is
  priced at the registry's orchestrator rate (Neon's).

#### agy commands

The session's `commandStyle` is `text`: a message `/name args` is a command.
`session_command` lists and runs them (`clawo session-command <name> [command] [args]`):

- **Info commands** — `/help`, `/usage` (`/quota`), `/credits`, `/model`, `/effort`,
  `/skills`, `/agents`, `/hooks`, `/permissions`, `/config` (`/settings`),
  `/changelog`, `/plugin list`. agy answers them without a model turn (a
  `command_result`, `num_turns: 0`, no conversation): `session_command run` spawns
  them as a process of their own, beside any turn in flight, with the session's
  `--model`/`--effort` so `/model` and `/effort` report the session, and returns
  the structured answer as `data` and the tab-separated text as `text`. Sent as a
  message they resolve with `localCommand: true`: no ledger row, no turn counted,
  the context figure unchanged, an empty answer (no agents) not a failure. They
  take no arguments (agy refuses `/skills list`), except `/plugin`, run as
  `/plugin list` since a bare `/plugin` is interactive.
- **System commands** — `/goal`, `/compact`, `/plan`, `/boost`, `/teamwork`,
  `/schedule`, `/browser`, `/learn`, `/grill-me` (agy's ACP server lists these; print
  mode has no listing of them). They start a turn. `/teamwork` gets
  `[skip-interview]`, since print mode cannot answer its interview. `/grill-me` is
  listed as needing a person: print mode skips its questions and the agent answers
  them itself. `/schedule` timers fire within the turn, which waits for them up to
  the send timeout; a recurring schedule therefore ends the turn at its timeout, and
  durable schedules belong to a workflow. `/learn` may edit rule and skill files
  outside the workspace, including user-global ones.
- **Skills** — every skill `/skills` lists for the session's directory (agy's own,
  the user's, the workspace's `.agents/skills`, plugins' such as `/swarm` and
  `/run-workflow`), as commands that start a turn.
- **Refused** — interactive-only commands (`/clear`, `/new`, `/resume`, `/fork`,
  `/rewind`, `/diff`, `/context`, `/btw`, `/add-dir`, …) are refused by agy at no
  cost, naming what replaces them; that answer is an error result with
  `localCommand: true`, not a failed turn. clawo already covers `--conversation`
  and `addDir`; a side question is a send after the turn.
- A `/word` that is none of these reaches the model as text; the session logs that
  once per word. `init.expanded_commands` names what each turn ran, and is on the
  result event as `expanded_commands`.

The list is read once (`/help` and `/skills`, both free) and again after ten minutes.

**`turnCommand`** puts every message of the session through one command:
`"/boost"`, `"/teamwork"` (with `[skip-interview]`), `"/swarm"`, `"/run-workflow"`,
`"/plan"`, or a skill. A message that is itself a command is sent as it is.

**`session_send plan: true`** sends `/plan <message>`: agy writes a plan into its own
folder for the conversation and stops for approval. The reply is that plan's text
(the result event's `plan` holds `{ path, text }`); approving it is the next message
(`Approved. Proceed with the plan.`), which executes it on the same conversation.

**`session_send model`** runs that one send on another model (`perSendModel`): each
turn is a process of its own, so the flag goes on that process only and the turn is
priced at that model. `session_switch_model` and the effort switch apply in place
(`live: true`), with nothing to restart.

**Compaction**: `session_compact` (and `autoCompactPercent`) runs agy's `/compact` as a
turn of its own, waits for it, and judges it by its summary pass (a `checkpoint`
step); its reply is empty by design. It is not a turn of the conversation and has no
ledger row. `preTokens` is the summary pass's prompt (the conversation before);
`postTokens` is an estimate — the summary on top of what every request carries —
until the next turn measures it. agy takes no instructions for `/compact` (text after
it is answered as a message once it is done), so a `summary` is not sent, and the
outcome's note says so.

**Native goal** (`nativeGoal: true`, `clawo goal --native-goal`): the goal runs in
agy's own `/goal` loop instead of clawo's turn loop. One process works on it, agy
re-prompting the agent itself until a reply carries `<!-- GOAL_COMPLETE -->`
(`complete`) or `<!-- GOAL_CANCELLED -->` (`blocked`); the markers are stripped from
the text the node sees. The goal belongs to the conversation: a process cut short
leaves it set, and the next message on the conversation is driven by it again. So:

- a **steer** cuts the running process and continues the conversation with the steer
  text (steers that arrive meanwhile go together); the goal stays set;
- a **budget** is checked against each step's usage as the run streams, and a spent
  one cuts the process (`budgetLimited`);
- a **pause**, the node's cancel and an interrupt cut the process (`paused`);
- a failed run is `usageLimited` at a usage limit, `blocked` on a failed login and
  `paused` otherwise; a **resume** sets the goal again (`/goal <objective>` with a
  note to continue from where the work stands), which is harmless when agy still
  holds it;
- one process runs at most 3 hours, then the goal continues in a new one, up to 24
  in a row; a run that ends without a marker is `paused`, and five such endings in
  a row are `blocked`;
- **clearing** a goal agy still holds asks the agent to cancel it (one short turn).

A bare `/goal` is not a status query on agy (it starts a goal with no objective), so
the status is the adapter's own. Against clawo's turn loop: agy's loop costs no
protocol lines or continuation messages per turn and lets agy decide when to go
on, while steers cut a running process rather than wait for a turn boundary.

**Quota**: `engine_quota` (`clawo quota agy`) reads `/usage` and `/credits`, both
free: one window per model group and period (`Gemini Models weekly`, `Gemini Models
5h`, `Claude and GPT models …`), remaining and used percent, reset time; the credit
balance is in `raw.credits`. Under a `GEMINI_API_KEY` there is no account quota and
the reading is empty.

**Agents a turn starts** — `/teamwork` members, `/swarm` workers, `/run-workflow`
agents, subagents — each run in a conversation of their own, and their spend is not
in the turn's usage. The session follows them where agy names them (a subagent step's
conversation id, an `invoke_subagent` or `/swarm` result in agy's transcript, a
workflow agent's line in its task log), reads their transcripts, and adds what each
request spent, priced at its own model, to the turn: to the session's tokens and cost,
so `maxBudgetUsd` and the ledger see it, and as `member_usage` on the result event.
A member still working when the turn ends is counted further by the next turn.
Measured on a `/teamwork` turn whose own usage was 30K input tokens: its members used
528K input, 3.2M cache-read and 124K output tokens.

**ACP**: the `agy-acp` preset runs `agy acp` as an ACP agent (`engine: 'acp'`,
`acpAgent: 'agy-acp'`): one long-lived agy process per session, through which agy
forwards its questions and permission requests to the client. agy reports no cost
there.

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

Wraps xAI's **Grok Build** CLI. Each `send()` spawns `grok -p --output-format streaming-json` with
the message on stdin, which prints one JSON object per line and exits: the reply as `text` pieces, a
`usage` event per request, tool calls, and an `end` event with the rest. Tested with `grok`
**1.0.92**.

- **The message is never an argument.** `-p` with no value reads the prompt from stdin, so a
  message that starts with `-` (`- item`, `-5 degrees`, `--- heading`) arrives as written, where
  grok's option parser would read it as a flag; nor does it show in `ps` or meet the argument size
  limit. `systemPrompt` and `appendSystemPrompt` go in the `--flag=value` form for the same reason.
- **Streaming**: `text` pieces reach `onText` and the `text` event as they arrive. A `tool_call` is
  reported through `onToolUse` and the `tool_use` event, and its final `tool_call_update`
  (`completed` or `failed`) through `onToolResult` and `tool_result`; the session counts them in
  `toolCalls` and `toolErrors`.
- **Only `end_turn` is a completed turn.** grok's stop reasons are open-ended (`max_tokens`,
  `max_turn_requests`, `refusal`, `cancelled`, `hook_blocked`, `hook_stopped`, and more may come),
  and its docs say to treat an unknown one as not a success. Any other reason resolves the send with
  the text it produced and `stop_reason: 'error'`, and does not count toward `turnsSucceeded`; a
  hook that stopped the turn rejects it with the hook's message.

- **Cost comes from the engine, not from the price table.** The `end` event carries
  `total_cost_usd`, and the wrapper writes it straight into the session's spend, so the run ledger
  and the `maxBudgetUsd` gate both read what xAI charged. Other engines multiply tokens by a rate in
  `models.ts`. `grok-4.7` (grok's default since 1.0.67) and `grok-4.6` are still registered, for
  their context window and an indicative breakdown; with no `model` set, the session is labelled with
  the model grok reports under `modelUsage`.
- **Real conversation continuity**: the `sessionId` from turn 1 is replayed as `--resume <id>`.
  `--continue` is not used — it means "the most recent session for this cwd", which collides
  between concurrent sessions.
- Real token counts from the `end` event's `usage` (`input_tokens`, `output_tokens`,
  `cache_read_input_tokens`, `cache_creation_input_tokens`). These are **per-turn**, unlike codex,
  where the same field is cumulative, and `input_tokens` excludes the cached reads. They sum every
  request of the turn, so the context percentage comes from the last request's own `usage` event.
- Permission modes pass straight through: grok's `--permission-mode` takes the same vocabulary we
  use. The one exception is our `manual`, which grok spells `default`.
- Reasoning effort maps to `--effort`; grok accepts `low|medium|high|xhigh`, so `max` and `ultra`
  clamp to `xhigh`.
- Session options that reach grok: `cwd` → `--cwd`, `appendSystemPrompt` → `--rules` (appends,
  unlike `systemPrompt` → `--system-prompt-override`, which replaces), `maxTurns` → `--max-turns`,
  `jsonSchema` → `--json-schema` (inline, and it implies the JSON output format already asked for),
  `agent` → `--agent`, `agents` → `--agents`, `dangerouslySkipPermissions` → `--always-approve`,
  `forkSession` → `--fork-session` (on a resumed turn), `customSessionId` → `--session-id` (on a
  first turn, or a forked one), `trustProject` → `--trust`, `debug` → `--debug`, `debugFile` →
  `--debug-file`.
- **Tool control.** `allowedTools` and `disallowedTools` are permission rules, as on Claude Code:
  - `allowedTools` → one `--allow <rule>` per entry. An allow rule only auto-approves.
  - `disallowedTools` → one `--deny <rule>` per entry. A deny rule refuses every matching call, in
    any permission mode, and wins over allow: with `--deny Bash` a shell call came back "Denied by
    permission policy" and did not run (1.0.92).
  - grok's rules name `Bash`, `Read`, `Edit`, `Write`, `Grep`, `Glob`, `WebFetch`, `WebSearch` and
    `MCPTool`, bare or with a pattern (`Bash(npm *)`, `Read(./src/**)`); `mcp__<server>__<tool>`
    becomes `MCPTool(<server>__<tool>)`. A `disallowedTools` entry naming anything else — a
    subagent (`Agent`, `Agent(explore)`, `Task`), one of grok's own tool ids (`run_terminal_cmd`), a
    Claude tool grok lacks — goes to `--disallowed-tools`, which removes the tool; a name grok does
    not know there only warns. An `allowedTools` entry grok has no rule for is left out and named
    once in the session log: `--allow NotebookEdit` would stop grok at start.
  - `tools` → `--tools a,b`, grok's built-in toolset allowlist, which takes grok's tool ids
    (`read_file`, `grep`, `run_terminal_cmd`), not permission rules: `--tools Bash` or
    `--disallowed-tools Bash` names no tool and changes nothing. `tools: 'default'` passes nothing.

- **No wait for background work.** After a turn, grok would wait up to 600 s for background shells
  and subagents it started, and answer each in a further turn — longer than the default 300 s send
  timeout, so the send would time out without the reply, the cost or the session id. The session
  passes `--no-wait-for-background`: grok exits when the turn ends and stops the work still running,
  with the exit code and the `end` event unchanged (a turn that left `sleep 90` running returned in
  12 s). A model that needs a background result has to wait for it within its turn. The one
  exception is a `/goal` set or resumed (by `session_send`, `session_command` or `nativeGoal`): the
  goal's later rounds are turns grok runs after the prompt, so that process is let wait for them.
- **`sandboxMode: 'read-only'` runs inside grok's `--sandbox read-only` profile**, which the OS
  enforces (Seatbelt on macOS, Landlock on Linux) for the whole process tree: the session reads
  anywhere and can write only to `~/.grok/` and the temp directory. Measured on 1.0.50 with
  `bypassPermissions`: a direct write, a shell write, a delegated subagent, a write on a resumed turn
  and a write outside the project all fail with `Operation not permitted`. A tool allowlist was not
  enough — a delegated subagent does not inherit it. **`sandboxMode: 'workspace-write'` runs inside
  `--sandbox workspace`**, which also lets the session write its working directory. Cases refused
  rather than claimed:
  - for read-only, a project under the temp directory, which the profile leaves writable;
  - a platform other than macOS or Linux;
  - a sandbox grok reports it could not apply. grok itself would carry on unsandboxed; the session
    kills the process on that warning, which grok prints at startup before any model call.

  Child-process network access is not blocked on macOS (grok enforces that part on Linux only). A
  session keeps the profile it was created with; grok refuses a resume under a different one.

- **Images** (`session_send` `images`) go with the message as ACP content blocks in a private
  `.json` file passed as `--prompt-file`, removed when the turn ends. `--prompt-json` takes the same
  blocks as an argument, which caps an image at what one argument may hold (128 KiB on Linux); a
  28 MB prompt file was read whole. Measured on 1.0.92: the model read the number in a PNG sent this
  way, and did not see one sent as a `resource_link` to the file.
- **`addDir`** → one `--add-dir` per entry, on the session's first turn only (grok refuses it beside
  `--resume`; a resumed session keeps its folders). grok refuses a folder it does not trust or that
  the sandbox profile cannot write (`workspace` writes only the working directory), and grok 1.0.92's
  headless route refuses every added folder: "additionalDirectories is not supported: a session
  works only in its cwd". The refusal comes before any model call, as the turn's error.
- **`trustProject`** → `--trust`: grok loads the folder's AGENTS.md, skills, MCP servers and hooks,
  which headless grok otherwise skips, and records the grant in `~/.grok/trusted_folders.toml`, so
  it holds for later runs in that folder too.
- **`debug`** → `--debug`, which takes no categories: grok writes the log to
  `$GROK_HOME/debug/<session-id>.txt`, or to `debugFile` (`--debug-file`), not to stderr.
- **`worktree`** → `--worktree=<name>` (or a bare `--worktree` for `true`) on the first turn: grok
  creates a git worktree under `~/.grok/worktrees/` and runs the session there. Later turns resume
  with `--cwd` set to the worktree, which the first `end` event names and `getStats()` reports as
  `grokWorktreePath`; grok resumes a session in the folder it was created in in any case. The
  worktree outlives the session: remove it with `grok worktree rm <path>`.

- **On an exhausted free tier grok answers with an error object** (`{"type":"error","message":...}`),
  and the session reports that message as the turn's error. A goal reads it as a usage limit
  (`usageLimited`), in each of grok's wordings: "free Grok Build usage limit", "resource-exhausted:
  Too many requests", "429 … free-usage-exhausted".
- Binary: `grok` (set `GROK_BIN` to override). Not `agent`: xAI's installer claims that name too,
  and so did Cursor's.
- Requires Grok Build: see `x.ai/cli`.

#### Grok headless features through clawo

How each of grok's headless features is reached, measured on 1.0.92.

- **Commands** (`session_command`, `commandStyle: 'text'`): a `/name args` message is a grok command.
  `session_command list` returns grok's shell built-ins (`compact`, `session-info`, `goal`,
  `plugins`, `hooks-*`, `always-approve`, `workflow`, `deep-research`, `loop`, …), its skills and
  workflows with grok's own descriptions and argument hints (ACP `_x.ai/commands/list`, read from a
  short-lived `grok agent stdio` with no session, so nothing is created and no model is called), and
  its TUI commands, marked as needing a person. A command grok answers itself (`/session-info`,
  `/goal status`, `/plugins list`, `/workflow runs`, …) runs as a process of its own on the
  conversation, after any turn in flight, and is not a turn: no ledger row, no change to the context
  figure (`localCommand`). The same holds for such a message sent with `session_send`. A skill
  (`/brainstorming …`, `/review`, `/bundled:imagine …`) is an ordinary turn. `turnCommand` puts every
  message through a skill, e.g. `turnCommand: '/review'`.
- **Refused before anything runs**, with what to use instead, unless the session sends text verbatim
  (`disableSlashCommands`):
  - grok's TUI commands (`/help`, `/model`, `/plan`, `/fork`, `/rewind`, `/btw`, `/usage`, `/export`,
    …). Headless grok does not run them: it sends them to the model as text, which costs a turn
    (`/help` measured at $0.066). The refusal names the clawo equivalent (`session_switch_model`,
    `plan` on the send, `forkSession`, `session_aside`, `engine_quota`, …).
  - `/loop`, `/deep-research <query>`, `/workflow <name>` and a workflow's own name
    (`/learn-traces`): the job or run lives in the grok process, which exits after the turn and
    stops it. These run on the long-lived ACP route below.
  - `/feedback` (it sends the session to xAI) and `/context` (headless grok answers it empty).
- **Compaction** (`session_compact`, `autoCompactPercent`): `/compact`, and the proof it worked. grok
  reports the compaction done even when its compaction call was refused, so the context is read
  from `/session-info` before and after, and the outcome is `ok` only when it shrank, with
  `preTokens`/`postTokens`. A conversation with no model turn yet is left alone (compacting one took
  117 s and grew it). grok's `/compact` takes no summary. Its own call is billed nowhere grok
  reports. grok also compacts by itself past its threshold (`auto_compact_threshold_percent`); the
  session logs it.
- **Side questions** (`session_aside`): asked on a fork of the conversation (`--resume <id>
--fork-session`), one model round, every tool removed and the model told so, so the session's
  conversation is unchanged. The fork stays in grok's session store. Its spend counts in the
  session's stats; it is not a turn. Not beside a running turn: it waits for the turn to end.
- **A model for one send** (`session_send` `model`): every turn is its own process, so `--model`
  names it for that turn only. **`plan: true`** on a send runs that turn in grok's plan mode (and
  without `--always-approve`). **`session_switch_model`** switches in place (`live: true`): the next
  process takes the model.
- **Goals.** By default clawo runs a goal on grok turn by turn (`GOAL COMPLETE` / `GOAL BLOCKED`).
  With `nativeGoal` (`clawo goal --native-goal`) grok's own `/goal` runs instead: one process plans,
  implements and has skeptic verifiers check the result, round after round, and the verdict is
  grok's goal state (`goal/state.json` in the session's folder, or `/goal status`), not the turn's
  outcome — a goal refused at the usage limit ends `end_turn` like a finished one. `tokenBudget` is
  grok's `--budget`. Trade-offs against the turn loop: grok's verifiers judge completion and grok
  enforces the budget; but steer text cannot reach a running grok process (`steer` answers
  `steered: false`), and spend is checked between processes, not between rounds.
- **Spend beyond the `end` line.** grok's `end` leaves out what it could not cost (`cost_is_partial`,
  a cut-off subagent) and some of a native goal's verifier calls ($0.515 over 19 calls on `end`,
  $0.612 over 22 in grok's record). After a goal turn, or a turn whose `end` has no complete cost,
  the session adds the difference from `grok usage <id>` (`costUsdTicks`, 1e10 per dollar).
- **Quota** (`engine_quota`, `clawo quota grok`): the plan from ACP `_x.ai/billing` (no session, no
  model call): tier, billing period, the on-demand cap and its use. No grok command reads the free
  tier's remaining allowance; its rolling 24-hour token window appears only in a refusal, so the
  window is reported from the last usage-limit refusal in grok's log (`~/.grok/logs/unified.jsonl`,
  "tokens (actual/limit): 601197/600000") while no model call has succeeded since.
- **Long-lived route for background features**: the `grok` ACP preset (`engine: 'acp', acpAgent:
'grok'`) runs `grok agent stdio` for the session's life. There `/deep-research <query>`,
  `/workflow <name>` and `/loop` keep running after their turn; a finished workflow run reports back,
  and a loop fires, as a turn grok starts itself, which reaches clawo as an engine turn
  (`coding_session_status.engineTurns`, a ledger row marked `origin: 'engine'`). Turn usage and cost
  come from grok's `turn_completed` notifications (the prompt response carries no standard usage).
  Measured: a deep-research run whose agents were refused at the usage limit reported back as a
  failed engine turn with grok's reason.
- **Not reached, and why**: rewind (print mode has none; ACP `_x.ai/rewind/execute` exists but is
  not driven), the `/context` breakdown (TUI only; ACP `_x.ai/session/info` has it), mid-turn
  interjection (ACP `_x.ai/interject`), cross-session memory (`/memory`, `/flush`, `/dream`: TUI
  commands, and memory is off unless configured), and `/feedback`.

```typescript
await manager.startSession({
  name: 'grok-task',
  engine: 'grok',
  model: 'grok-4.7',
  cwd: '/project',
});
```

### Cursor (`engine: 'cursor'`)

Wraps the [Cursor Agent](https://cursor.com/cli) CLI in print mode. Each `send()` spawns
`cursor-agent -p … --trust --output-format stream-json --stream-partial-output --model <id>`.
Tested with `cursor-agent` **2026.11.22**.

- **Models.** `model` takes the ids `cursor-agent models` lists — Composer (`composer-2.5`),
  Claude (`claude-opus-5-5-high`), GPT (`gpt-5.6-sol-xhigh`), Grok, Gemini — or a bracketed id
  (`gpt-5.4-mini[reasoning=low]`). Every process is given `--model`, `auto` when the session names
  none: without it Cursor runs the model last selected by any Cursor run on the machine.
- **Cursor's own config is not touched.** Cursor stores every `--model` it is given as the user's
  default in `~/.cursor/cli-config.json`, and refreshes caches there on every run. Each session runs
  Cursor with `CURSOR_CONFIG_DIR` set to a directory of its own under the temp directory: every
  entry links to the user's (chats, skills, commands, MCP servers, plugins, permissions), except
  `cli-config.json`, which is copied in before each turn. What Cursor writes into the copy stays
  there; chats are written through the link, so `--resume` and the user's own `cursor-agent` see
  them. The login is not in that directory (the keychain on macOS). `cursor-agent models` and
  `about` run the same way. The directory is removed when the session stops. Cursor starts a
  per-workspace helper (`cursor-agent worker-server`) that outlives the process; it is Cursor's,
  not the session's.
- **Effort** is written into the model id: `effort` (session or send) picks the listed id
  `<model>-<effort>` (`-fast` stays last), or the nearest lower effort the model is listed with;
  `ultra` is `max`. An id that already names an effort or parameters, and `auto`, are passed as
  given, and an effort no listed id carries is logged once and not applied. The listing is read
  once an hour.
- **A model per send** (`session_send` `model`) runs that turn on another model; the session's own
  is unchanged. `session_switch_model` is in place (`live: true`): the next process takes the new
  `--model`, nothing restarts.
- **Cost**: real token counts from the `result` event's `usage`. Its `inputTokens` is the uncached
  remainder, so cache reads (`cacheReadTokens`) and writes are billed on top of it, and
  `outputTokens` includes `reasoningTokens`. Each turn is priced at the id it was given — never the
  name the init event displays (`Auto Balance`, `GPT-5.4 Mini Low`), which is kept as
  `stats.cursorModelName` — so a send on another model does not reprice the turns before it. A
  third-party model is priced at its provider's registry price (Cursor bills those at list price),
  with the effort, `-fast` and bracket parts dropped; `auto`, which has no per-token price, as
  Composer 2.5, the Cursor model it bills as. A fast variant's surcharge (2x on GPT and Grok) is not
  modelled, and a model the registry does not know is priced as Composer 2.5. Cursor reports usage
  once per process, in the `result` it writes as it exits: a process stopped mid-request reports
  none, and its turn falls back to an estimate.
- Conversation continuity: the chat id from the `system` init event is passed back as
  `--resume <chatId>`; `--continue` (the latest chat) is not used, as it collides between
  concurrent sessions.
- Text streams as Cursor writes it (`--stream-partial-output`): the deltas go to `onText`, and the
  complete message Cursor sends after them is not counted twice.
- Permissions:
  - default (`bypassPermissions`): `--force`.
  - `permissionMode: 'auto'`: `--auto-review` instead — Cursor's server-side classifier runs safe
    tool calls and declines the rest; headless, a declined call is skipped, not waited on.
  - `sandboxMode: 'workspace-write'`: Cursor's OS sandbox (`--sandbox enabled`) and never `--force`,
    which runs commands outside it. Edits and commands inside the workspace run; a write outside
    it and the network are refused (measured on 2026.11.22; `/tmp` stays writable).
  - `sandboxMode: 'read-only'`: Ask mode (`--mode ask`), which always answers in text, plus the
    actual boundary: a `.cursor/cli.json` that denies `Write(**)`, `Edit(**)` and `Shell(**)`,
    written to a temporary directory that is the process's cwd while `--workspace` names the
    project. Deny rules hold even under `--force` and against a permissive config in the
    repository; the modes only steer the model.
  - `permissionMode: 'plan'`, and `plan` on one send: Plan mode (`--mode plan`) behind the same deny
    config. Cursor writes the plan with its CreatePlan tool and no text beside it; the plan (name,
    overview, body, todos) is put into the reply as markdown.
- **Images**: `session_send` `images` are attached with `--image <path>`, one per image (a flag
  `--help` does not list).
- **Commands and skills**: a `/name args` message runs a Cursor command (`.cursor/commands`, user
  and team commands) or skill (Cursor's built-in ones, `.cursor/skills`, user skills — which include
  `~/.claude/skills`). `session_command list` returns what the session's directory offers, read
  from a short-lived `cursor-agent acp` (no prompt, no turn; its ACP session is kept out of
  `~/.cursor/acp-sessions`), cached for five minutes; `copy-request-id`, a TUI clipboard action, is
  marked as needing a person. `session_command run` and `turnCommand` (e.g. `/best-of-n`) send
  `/<command> <text>`. `/best-of-n` and `/multi-model-review` make their worktrees under
  `~/.cursor/worktrees`, outside clawo's isolation, and wait for every sub-agent: a sub-agent that
  never finishes holds the turn until its timeout. There is no switch that stops command expansion,
  so `disableSlashCommands` does not apply.
- **`agents`**: written as Cursor subagents (`agents/<name>.md`) to a plugin directory the session
  loads with `--plugin-dir`. Cursor runs a subagent only on the models it allows for subagents.
- **`/goal`**: Cursor's goal runs in one process until the model marks it done, past any send's
  timeout, so a plain `/goal <objective>` send is refused with a pointer to the goal surface. A goal
  runs either way:
  - `clawo goal --cursor` (default): clawo's turn loop (`TurnGoalSession`), one turn per send,
    ended by the agent's `GOAL COMPLETE` / `GOAL BLOCKED` line; steers reach the next turn, the
    token budget is checked after every turn.
  - `clawo goal --cursor --native-goal` (`nativeGoal`): Cursor's own loop (`CursorGoalSession`).
    clawo sends `/goal <objective>` once and reads the goal's state from Cursor's CreateGoal /
    UpdateGoal tool calls; `GOAL_STATUS_COMPLETE` ends it. Because usage arrives only when a
    process ends, `tokenBudget` and the run's spend cap are checked between processes, and a steer
    waits for the running process to end and opens the next one. A process that ends with the goal
    still armed is continued on the same chat (Cursor picks the goal back up), up to 30 times in a
    row; a failed one is resumed by the goal node like any other.
- **`/loop`**: a `/loop <interval> <prompt>` send returns with the loop's first turn — at its first
  tick, or once the stream has been quiet for 15 s after the loop's background shell started — and
  the process runs on. Each tick is an engine turn (`coding_session_status.engineTurns`, a ledger
  row with `origin: 'engine'`); a message to the session is refused while the loop runs.
  `session_interrupt` ends the loop between ticks, when Cursor writes its usage, which comes with the
  last tick (within a minute); `session_stop` ends it at once, without it.
- **Quota**: `engine_quota` reports the subscription tier `cursor-agent about` prints, with no usage
  windows: Cursor shows those only in its TUI (`/usage`).
- `addDir` → `--add-dir` (repeated); `pluginDir` → `--plugin-dir` (Cursor plugin directories).
- Not available headless: compaction (Cursor summarises server-side; `/summarize` exists only in the
  TUI, so `session_compact` reports it as not supported and `autoCompactPercent` stops trying),
  rewind and fork, side questions, and the TUI-only commands (`/usage`, `/context`, `/model`, `/mcp`,
  `/rewind`, `/fork`, …). `disallowedTools` is not passed.
- Cursor also serves ACP (`cursor-agent acp`): the `cursor` preset runs it as an
  [ACP agent](#acp-agents-engine-acp) — one long-lived process, Cursor's own sessions and modes,
  and its stored default model.
- Binary: `cursor-agent` (set `CURSOR_BIN` to override), never the bare `agent`, which xAI's
  installer links to `grok`. Install with `curl https://cursor.com/install -fsS | bash` and sign in
  with `cursor-agent login`, or set `CURSOR_API_KEY`.

```typescript
await manager.startSession({
  name: 'cursor-task',
  engine: 'cursor',
  model: 'claude-opus-5-5',
  effort: 'high', // runs claude-opus-5-5-high
  cwd: '/project',
});
```

### OpenCode (`engine: 'opencode'`)

Wraps the [OpenCode](https://github.com/anomalyco/opencode) CLI with `run --format json`. Each `send()` spawns a new `run` process; on OpenCode 2 it is a client of a server the session holds (see [OpenCode 2](#opencode-2)). Tested with `opencode` **1.19.6** and OpenCode 2 **2.4.2**; the session reads `opencode --version` once at start and drives either line.

- Conversation continuity: the session id from the event envelope is captured and passed back as `--session <id>` on later sends, so the model sees prior turns. `--continue` is deliberately not used: it means "the last session on this machine", which collides between concurrent sessions.
- NDJSON event stream with envelope `{ type, timestamp, sessionID, ... }`
- Event types: `text`, `reasoning`, `tool_use`, `step_start`, `step_finish`, `error`
- `text` and `tool_use` are **cumulative snapshots** keyed by `part.id` / `part.callID`; the wrapper diffs them to produce streaming deltas for `onText` callbacks and counts each tool invocation once
- Real token counts from `step_finish.part.tokens.{input,output,cache.{read,write}}`. **`input` is the uncached remainder only** — opencode's own `total` is `input + output + cache.read + cache.write` — so the cached part is billed on top of it, not carved out of it, and `contextPercent` is measured against the whole input side. On a resumed turn the uncached remainder is usually a small fraction of the cached part
- Cost is what opencode reports on each `step_finish` (`part.cost`), so a free model costs $0; the registry estimate applies only when no cost is reported. `opencode run --format json` does not name the model it ran
- A failed turn reports the message of opencode's `error` event when there is one
- Reasoning effort maps to `--variant`, opencode's provider-specific effort knob. opencode does not validate the value: a level the provider does not offer runs the turn at its default rather than failing
- Every turn runs with `--thinking`, without which opencode sends no `reasoning` events; reasoning goes to the log channel, never into the result
- `appendSystemPrompt`: opencode has no system-prompt flag, so it is placed at the top of the first message of each new conversation
- `plan` on a send → `--agent plan`, OpenCode's plan mode (it refuses edits outside its plan directory). A read-only session keeps its read-only agent, which is stricter
- `model` on a send runs that turn on the model (`perSendModel`); `session_switch_model` and `effort` apply from the next turn with nothing restarted (`live: true`), since every turn names its model and variant
- `agent` → `--agent <name>`. When 1.x cannot run the agent (not found, or a subagent), it prints a warning to stderr and runs the default agent; the wrapper kills the turn on sight of that warning and fails it instead. `agent` together with `sandboxMode: 'read-only'` is refused at session start
- `dangerouslySkipPermissions` → `--auto`: a request that would have asked for permission is approved once instead of rejected; a rule that denies still denies. Never sent on a read-only session, and not derived from `permissionMode`
- The turn that creates a session passes `--title <sessionName, else the session name>`. opencode applies a title only to a session it creates, not to a resumed one or a fork
- `forkSession` with `resumeSessionId`: the first turn runs `--session <id> --fork`, and the session continues the fork's own id from then on; that id is also what a restart (model switch, tool update) resumes
- `noSessionPersistence` (or `skipPersistence`): when the session stops, the opencode session it created (or forked) is deleted with `opencode session delete <id>`, run under the session's `launcher`; best effort, and stopping never fails because of it. The delete waits two seconds, so a restart that resumes the same id takes the session over and deletes it when it stops in turn. A session the caller named (`resumeSessionId` without `forkSession`, or `customSessionId`) is never deleted
- `images` on a send: one `--file=<path>` per image. opencode reads the file with its Read tool, which passes an image to the model as an attachment, so the model must take images
- `bare` → `--pure` (no external plugins)
- The message is written to the subprocess's stdin, which is then closed: opencode waits for EOF before it starts
- Provider-agnostic: opencode's `--model` expects `provider/model` form (e.g. `anthropic/claude-sonnet-4`). The wrapper passes `--model` through only when the value contains a `/`; otherwise opencode's own default applies
- `sandboxMode: 'read-only'` runs a generated `clawo-readonly` agent (`--agent clawo-readonly` plus an `OPENCODE_CONFIG_CONTENT` env var defining it):
  - it denies `edit`, `bash`, `external_directory`, `webfetch` and `task` at the permission level, and also removes those tools via the agent's `tools` map
  - denying `task` matters: otherwise the agent can hand a write to a subagent that runs under the default writable agent
  - OpenCode's built-in `plan` agent is not used, because it permits both `bash` and `edit`
  - if the `clawo-readonly` agent fails to load, the turn is killed when 1.x warns that it is falling back to the default agent (before the prompt is sent) and refused, rather than run with write access
  - to test a change to this config, use adversarial prompts that include asking the agent to delegate; `opencode agent list` shows compiled rules that look the same for a safe and an unsafe agent
- Install OpenCode 2 with `npm install -g @opencode/cli` (the package its installer, `curl -fsSL https://opencode.ai/v2/install | bash`, downloads), or OpenCode 1.x with `npm install -g opencode-ai`. Both provide `opencode`; uninstall one before installing the other. OpenCode 2 keeps the session database in the same place and migrates a V1 database in place on first start. Auth via `opencode auth login` **or** any provider env var (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, etc.) — opencode picks up either path
- The `0.0.0-beta-N` builds that preceded OpenCode 2's first release (from `opencode upgrade --major` and the `@opencode-ai/cli` npm package) are refused at session start: they send no `step_finish`, so a turn has no tokens and no cost. If the version cannot be read, the session starts as OpenCode 1.x
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

#### OpenCode 2

OpenCode 2 keeps `run --format json` and the same event stream, including `step_finish` with tokens and cost. Where it differs, the wrapper follows it (measured on 2.3.2):

- The session holds a private server, `opencode serve --stdio --port 0`, started on first use in the session's directory with the session's environment (the read-only agent's `OPENCODE_CONFIG_CONTENT` included), on 127.0.0.1 behind a random `OPENCODE_PASSWORD`. Turns run as `run --server <url>` clients of it. It is stopped once nothing has used it for 30 seconds and started again when needed, so an idle session holds no process (a server is about 0.5 GB resident). A server that does not start leaves the turn on `--standalone`, a private server for that one run; after two failures in a row the session stops trying. `CLAWO_OPENCODE_STANDALONE=1` runs every turn on `--standalone`. Never the background service: without `--server` or `--standalone`, `run` hands the turn to OpenCode's background service when one is running (the desktop app starts one), and that service uses its own configuration and environment instead of the session's
- An `--agent` or `--model` stays the conversation's for the turns after it. The turn after a `plan` turn passes the session's agent (`build` when it names none); after a send with its own model, a session that names no model passes the model the conversation had before (or the server's default)
- Effort is sent as part of the model, `--model provider/model#effort`; there is no `--variant`. A variant the model does not offer fails the turn before the model is called (`Variant unavailable`), so the wrapper runs the turn again without it and does not ask for that variant again in the session; the level degrades as it does on 1.x. A model already written as `provider/model#variant` is passed as is. Without a `provider/model`, effort is not sent, and the session logs that once
- The read-only agent is defined in the V2 format: ordered `permissions` rules that deny every action and then allow only `read`, `glob` and `grep`, with `.env` reads left to ask (a non-interactive run rejects an ask). Agent rules apply after the user's global and project rules, so a user's `allow` cannot reopen them. Measured: a write, a shell heredoc, a delegation to a subagent and a read outside the project were each refused, and the denied tools are not offered to the model
- An `--agent` that does not exist fails the turn, rather than falling back to the default agent as 1.x does
- Images are passed as `-f <path>` and sent to the model as data URLs; OpenCode 2 refuses a file over 10 MiB, which fails the turn
- `noSessionPersistence` (or `skipPersistence`) also creates the session (or fork) with `--archived`, and the delete on stop runs with `--standalone`: without it the command goes to the background service and starts one when none is running
- `customSessionId` (an id starting with `ses`; anything else is refused at session start): the first turn runs `--session <id>`, which creates the session under that id, or continues it if it already exists. OpenCode 1 cannot create a session under a given id, so there the option is not sent and the session logs that once
- `bare` has no equivalent; the session logs that once
- `retry` events (an API call being retried) count in the session's `retries`, with the error's type, else its HTTP status, as `lastRetryError`
- Writable sessions run under OpenCode 2's default policy, which allows file access outside the project without asking; 1.x asked, which a non-interactive run rejects. To keep the 1.x behaviour, add `{ "action": "external_directory", "resource": "*", "effect": "ask" }` to `permissions` in your OpenCode configuration
- The shell tool is named `shell` (1.x: `bash`), and the permission actions `subagent` and `edit` replace `task`, `write` and `patch`
- A `background_wait` event (`run` waiting for a subagent it started) is logged as `waiting for N background job(s)`

#### What a session reaches on OpenCode

Through the held server (OpenCode 2 only, except where noted):

| Feature                                                                                                                                        | How                                                                                                                                                                                                                                                          | Through clawo                                                      |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| Steering the turn in flight                                                                                                                    | `POST /api/session/<id>/prompt` with delivery `steer`; the agent reads it before its next model call, in the same turn                                                                                                                                       | `deliverMidTurn`: inbox messages, `workflow_steer`, goal steers    |
| Interrupt                                                                                                                                      | `POST /api/session/<id>/interrupt`, which also stops the turn's background shells and subagents; `run` ends with `Session interrupted`, read as `stop_reason: 'interrupted'`. A first turn whose conversation id is not known yet is stopped with its server | `session_interrupt`                                                |
| OpenCode's commands: `init`, `review [commit\|branch\|pr]`, `goal`, `automation`, and the user's and project's own (`.opencode/commands/*.md`) | `POST /api/session/<id>/command`, followed until the session is idle; text, tools, tokens and cost come from the messages it wrote, and it counts as a turn. A command OpenCode refuses (unknown name, bad arguments) is no turn                             | `session_command` (`commandStyle: 'rpc'`), `turnCommand`           |
| `/compact`                                                                                                                                     | `POST /api/session/<id>/compact`, waited for; `preTokens` is the last prompt, `postTokens` the summary; its tokens and cost are the session's. OpenCode writes the summary with its own prompt, so a `summary` is not sent                                   | `session_compact`, `autoCompactPercent`, `session_command compact` |
| `/btw` side question                                                                                                                           | `POST /api/session/<id>/generate`: an answer from the conversation's context, which stays as it was; no tools run                                                                                                                                            | `session_aside`                                                    |
| `/undo`                                                                                                                                        | `revert/stage` at the user message `turns` back (or `messageId`), then `revert/commit`; with `files` the files those turns changed are restored from OpenCode's snapshots and named in the note                                                              | `session_rewind`                                                   |
| `!cmd` shell                                                                                                                                   | `POST /api/session/<id>/shell`: the output goes into the conversation for the agent's next turn, with no model call. Refused on a read-only session: it is the user's shell, not the agent's                                                                 | `session_command shell <command>`                                  |
| Skills                                                                                                                                         | `POST /api/experimental/session/<id>/skill` loads a skill without a turn. OpenCode loads the user's Claude Code skills as well (`OPENCODE_DISABLE_CLAUDE_CODE_SKILLS` turns that off)                                                                        | `session_command skill <id>`                                       |
| Info                                                                                                                                           | `models`, `agents`, `skills`, `mcp`, `usage`, `goal-status`: read from the server, no turn. An OpenCode command of the same name wins                                                                                                                        | `session_command <name>`                                           |
| Native `/goal`                                                                                                                                 | `OpencodeGoalSession`: `/goal <objective>`, `pause`, `resume`, `clear`; state from `POST /api/rpc/opencode.goal/get`. OpenCode's judge model decides after each round whether the objective is met; at most 50 rounds                                        | goal node `nativeGoal: true`, `clawo goal --native-goal`           |
| Quota                                                                                                                                          | `GET /api/experimental/usage/limits` (OpenCode Go's rolling, weekly and monthly meters, and budgets), through the session's server or `opencode api --standalone`; nothing to report without a subscription or budget                                        | `engine_quota`, `clawo quota opencode`                             |

While it follows a command, a compaction or a goal, the session does what `run` does for its own turns: a permission request is rejected (answered `once` under `dangerouslySkipPermissions`, never on a read-only session), and a question form is cancelled with `run`'s message, since nobody is there to answer it; requests from subagents are answered too. Before the work, the conversation is moved to the session's agent (the read-only agent on a read-only session) and model. A session with no conversation yet creates one (`POST /api/session`, titled, archived when ephemeral), and a fork not yet made is forked (`POST /api/session/<id>/fork`).

The native goal against clawo's turn loop (`TurnGoalSession`, the default): OpenCode's judge, not a `GOAL COMPLETE` line in the reply, decides the goal is complete; a steer reaches the round in flight, or waits in the conversation for the next round; OpenCode's goal has no token budget, so clawo checks `tokenBudget` every few seconds and, when it is spent, pauses the goal and interrupts the round (`budgetLimited`); a loop that ends with the plugin still `active` (a timeout, a server that stopped) reads `paused`, which the node resumes with `/goal resume`, or sets again when the server no longer holds the goal. Automations (`/automation create`) fire from a running OpenCode server; the session's server stops with the session, so a scheduled automation needs OpenCode's own background service.

OpenCode 1 has no server API clawo drives: a command runs as `run --command <name>` with its arguments on stdin (and `turnCommand` the same way); an unknown one fails before any model call and is no turn. Listing commands, compaction, asides, rewinds, steering and the native goal are not supported there.

### ACP agents (`engine: 'acp'`)

Drives any agent that serves the [Agent Client Protocol](https://agentclientprotocol.com) on stdio, with no per-agent code. Run through it so far: Kimi Code 2.3.1 (`kimi acp`), DeepSeek's dsh 0.2.1-rc.2 (`dsh --profile acp`), OpenCode 1.19.4 (`opencode acp`) and Cursor Agent 2026.11.22 (`cursor-agent acp`). This is the client side of the protocol; [acp.md](./acp.md) is the other side, where the orchestrator is the agent.

- `acpAgent` names the agent: a bundled preset id (`kimi-code`, `dsh`, `grok`, `cursor`; `clawo engines` lists them), or, from a local caller only, an inline `{ name, command, commandEnv?, args?, env?, contextWindow?, pricing?, extension? }`. Over HTTP, which includes the `clawo` CLI, only a preset id is accepted, as for `customEngine`.
- `extension` names an agent's own protocol extensions the client reads (registered in code; `grok` today): a notification that reports every turn's end and usage, including a turn the agent started itself — a background run reporting back, a scheduled prompt. Such a turn is delivered as an engine turn, with the text that arrived while no prompt was in flight. The `grok` preset is Grok Build's long-lived route; see [Grok headless features through clawo](#grok-headless-features-through-clawo).
- One agent process per session; each send is one `session/prompt` on one ACP session, so the conversation carries over between sends. `initialize` advertises no `fs` or `terminal` capability: the agent reads, writes and runs commands with its own tools.
- A turn succeeds when the agent ends it with `stopReason: "end_turn"`; any other stop reason (`refusal`, `max_tokens`, `cancelled`, …) fails it. A turn that runs past its timeout is cancelled with `session/cancel`. An agent that exits mid-turn fails the turn and the session.
- `session/request_permission` is answered at once from `permissionMode`: `bypassPermissions`, `acceptEdits`, `auto` and `dontAsk` pick an allow option, the others a reject option. Nothing waits on a person.
- Resume: the agent's session id is the resume id (`stats.acpSessionId`). A resumed session reattaches it with `session/resume`, or `session/load` when that is all the agent offers; an agent with neither fails the start rather than opening a new conversation.
- Usage and cost are whatever the agent reports (`PromptResponse.usage`, `usage_update`, or its extension's turn reports). With `pricing` set and no reported cost, the cost is estimated from the reported tokens. Kimi Code 2.3.1 and dsh 0.2.1-rc.2 report neither, so their sessions show 0 tokens and $0. OpenCode reports tokens; grok, through its extension, tokens and cost.
- `sandboxMode: 'read-only'` is refused at start. The agent's tools run inside the agent process and this client sees only the permission requests the agent chooses to send, so nothing here can stop a write. `permissionMode: 'plan'` rejects every permission request the agent does send.
- The model and credentials are the agent's own configuration, set in its environment; the session's `model` and `effort` are not sent to the agent, and `compact` is left to it:
  - Kimi Code: `KIMI_MODEL_NAME`, `KIMI_MODEL_API_KEY`, `KIMI_MODEL_BASE_URL`, `KIMI_MODEL_MAX_CONTEXT_SIZE`, `KIMI_MODEL_CAPABILITIES`, or a `kimi` login. `KIMI_BIN` overrides the command.
  - dsh: `DEEPSEEK_API_KEY` (and `DEEPSEEK_BASE_URL`); its profile chooses the model. `DSH_BIN` overrides the command.
  - Cursor: a `cursor-agent login` (or `CURSOR_API_KEY`); it runs the model last selected in Cursor and reports no usage, so its sessions show 0 tokens and $0. `CURSOR_BIN` overrides the command. A `/name` prompt runs a Cursor command or skill, as in print mode.
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
`zcode` (custom), `kimi-code`, `dsh`, `grok` and `cursor` (ACP). The format is in
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

Team tools (`team_list`, `team_send`) operate on the same virtual-team layer for **every** engine: the "team" is the set of active plain sessions managed by SessionManager, whatever engine each one runs. `team_list` lists the other active sessions with their engine and status; `team_send` sends a message the way `session_send_to` does, as a post on the session forum.

Delivery is the inbox's (see [inbox.md](./inbox.md)): an idle session gets the message as a new turn, a busy Claude Code or `codex-app` session in the turn in flight, and any other session keeps it unread until `session_deliver_inbox`. A teammate answers with a `<new-forum-post re="…">` block in its reply, which comes back to the sender.

Sessions that a council, an autoloop, a fan-out or a workflow node started belong to their run: `team_list` leaves them out, and `team_send` to one fails with the way to reach it (`workflow_forum` `post` on that run). A Claude Code session started this way also refuses Claude Code's own peer messages (`crossSessionInbound: 'refuse'`) unless its mode set a policy.

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

The proxy forwards with the gateway key and any provider keys in the environment, so it serves only the
sessions it started. Each process draws a random secret, and a session's base URL carries it as the first path
segment (`http://127.0.0.1:<port>/<secret>`). A request without it gets 401 before its body is read, so a process
that only knows the port cannot spend those credentials. The secret is in the Claude child's environment, so the
processes that session runs, and other processes of the same user that can read it, still reach the proxy. It is
not persisted, and a restarted process uses a new one. Under the secret, `POST` must be `application/json` (415
otherwise), bodies are capped at 32 MB (413), and methods other than `POST`, `GET` and `HEAD` get 405.

### Your own Anthropic-compatible gateway

A gateway that speaks the Anthropic API and serves other models under their own names (an internal model
gateway, for instance) needs none of this. Set `CLAWO_CLAUDE_GATEWAY=1` in the environment clawo runs in,
with the gateway in `ANTHROPIC_BASE_URL` (and its token in `ANTHROPIC_AUTH_TOKEN`) or in a session's
`baseUrl`. A `claude` session then passes any model name to the CLI as given (`--model gw-model-1`), starts no
proxy, and does not rewrite the base URL. Because it is read from the environment, it applies to every
`claude` session the process starts, including those of workflow, fan-out and council nodes.

Such a model is priced only from `pricingOverrides` (or the registry, if it knows the name). The CLI's own
cost figure is ignored, since it prices tokens from Anthropic's table, and without an override the cost is
recorded as 0, with a single warning per model name.

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
