# Sessions

Sessions are the core abstraction — persistent, multi-turn coding conversations backed by a coding CLI. `claude`, `codex-app`, `acp` and a persistent `custom` engine keep one process alive for the whole session; the one-shot engines (`codex`, `agy`, `grok`, `opencode`) start a process per send and resume their conversation by its id.

## Lifecycle

```
startSession() → sendMessage() → sendMessage() → ... → stopSession()
```

A session that sits idle past the memory TTL is unloaded, and one whose server restarts is gone from memory. Both stay in the resume registry for 7 days, and `startSession()` with the same name resumes the conversation. `stopSession()` ends a session for good: it removes the registry entry too, so the same name later starts a new conversation. See [Session Persistence](#session-persistence).

### Starting a Session

```typescript
const info = await manager.startSession({
  name: 'my-task',
  cwd: '/path/to/project',
  model: 'opus', // alias or full name
  permissionMode: 'acceptEdits',
  effort: 'high',
  allowedTools: ['Bash', 'Read', 'Edit', 'Write'],
  maxTurns: 50,
  maxBudgetUsd: 5.0,
});
```

Starting a name that is already live returns that session's info unchanged. The number of live sessions is capped by `maxConcurrentSessions` (default 5; 32 under `clawo serve`).

Key options:

| Option               | Description                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `engine`             | `'claude'` (default), `'codex'`, `'codex-app'`, `'agy'`, `'grok'`, `'opencode'`, `'acp'` (with `acpAgent`), or `'custom'` (with `customEngine`) — see [Multi-Engine](./multi-engine.md)                                                                                                                                                                                             |
| `model`              | Model alias (`fable`, `opus`, `sonnet`, `haiku`, `agy-pro`, `agy-flash`, `grok`) or full name. A non-Claude model on the `claude` engine goes through the [multi-model proxy](#multi-model-proxy)                                                                                                                                                                                   |
| `permissionMode`     | `acceptEdits` (default), `bypassPermissions`, `plan`, `auto`, `manual`, `dontAsk` (`default` = legacy alias for `manual`)                                                                                                                                                                                                                                                           |
| `effort`             | `low`, `medium`, `high`, `xhigh`, `max`, `ultra`, `auto` (default) — each engine clamps to its own ladder (see [Multi-Engine](./multi-engine.md))                                                                                                                                                                                                                                   |
| `sandboxMode`        | `read-only`, `workspace-write`, `danger-full-access`. `codex` and `codex-app` support all three (default `workspace-write`); `read-only` is enforced on `claude`, `agy`, `grok` and `opencode` through their own read-only modes; a custom engine must map it or the session refuses to start; an `acp` session refuses `read-only`, because the agent's tools run inside the agent |
| `maxBudgetUsd`       | Spend cap in USD, checked before every send on every engine; once spend reaches it, further sends are refused                                                                                                                                                                                                                                                                       |
| `bare`               | Claude Code: skip hooks, LSP, auto-memory, CLAUDE.md                                                                                                                                                                                                                                                                                                                                |
| `worktree`           | Claude Code: run in an isolated git worktree                                                                                                                                                                                                                                                                                                                                        |
| `appendSystemPrompt` | Append custom instructions to the system prompt. Claude Code and Grok take it natively; Codex, Antigravity and OpenCode have no such flag and receive it at the top of the first message of a conversation, as does `codex-app` on a new thread and an `acp` session on a new session                                                                                               |

### Sending Messages

```typescript
const result = await manager.sendMessage('my-task', 'Fix the auth bug', {
  effort: 'high', // override effort for this message
  plan: true, // ask for a plan only (claude and persistent custom engines)
  timeout: 600_000, // 10 min timeout (default 5 min)
  onChunk: (text) => process.stdout.write(text), // streaming
});

console.log(result.output);
```

Sends to one session run one at a time: a second `sendMessage()` waits for the first to finish. `plan` puts a plan-only instruction in front of the message and leaves the permission mode unchanged; start the session with `sandboxMode: 'read-only'` to enforce it. The result carries `output`, the engine's resume id as `sessionId`, `error` when the engine reported the turn as failed, and `permissionDenials` / `images` when the turn had any.

`SendOptions` also accepts `parentRunId`, `nodeKind` and `taskKind`, all stamped onto the turn's run ledger row ([observability.md](./observability.md)). `taskKind` is caller-declared and never inferred from the prompt.

### Session Persistence

A session is recorded in the resume registry, `~/.openclaw/claude-sessions.json` (the directory can be moved with `CLAWO_SESSIONS_DIR`), once its engine has reported a resume id:

- **Memory TTL**: an idle session is unloaded after `sessionTtlMinutes` (default 120; 60 under `clawo serve`). Its registry entry stays.
- **Disk TTL**: 7 days since the last activity.
- **Auto-resume**: `startSession` with a registered name resumes that conversation, restoring its engine, model, working directory, `sandboxMode`, `autoCompactPercent` and `chrome`. Other options — permission mode, tool lists, system prompts — are not stored; pass them again.
- **Not recorded**: sessions started with `noSessionPersistence`, and sessions whose engine has not reported a resume id yet.

### Session Resume & Fork

```typescript
// Resume a conversation by the engine's own id
await manager.startSession({
  name: 'continued',
  resumeSessionId: 'abc123-session-id',
});

// Claude Code and Grok: fork it for experiments (preserves history, new branch)
await manager.startSession({
  name: 'experiment',
  resumeSessionId: 'abc123',
  forkSession: true,
});
```

`resumeSessionId` is the id the engine itself uses: a Claude Code session id, a Codex or `codex-app` thread id, an Antigravity conversation id, a Grok or OpenCode session id, an ACP agent's session id, or a custom engine's id when its config maps a resume flag. `forkSession` becomes `--fork-session` on Claude Code and Grok; it is a `SessionManager` option and not a `session_start` tool parameter.

> `claude continue/respawn/stop/logs` are not headless subcommands — session continuation is via `resumeSessionId`/`forkSession`. Use the `claude_agents_list` tool (`claude agents --json`) to enumerate Claude Code background agent sessions.

### Handing off to another engine

`resumeSessionId` and `forkSession` continue a conversation on the engine that holds it. To continue
it somewhere else — a stuck Claude session into Codex, an expensive model into a cheaper one —
use `handoffSession` (tool: `session_handoff`):

```typescript
await manager.handoffSession('refactor', {
  engine: 'codex',
  message: 'Carry on from where we stopped.', // optional: send now and return the reply
});
// → new session 'refactor-codex', same cwd; 'refactor' keeps running untouched
```

`newName` names the new session (default `<name>-<engine>`) and `model` picks its model (default:
that engine's default). The result reports the new session's `name` and `engine`, what was carried
as `carried: { turns, omitted, chars }`, and the reply as `result` when `message` was given. A
session with no recorded exchange yet cannot be handed off.

**How the conversation travels.** No engine can resume another's session, and each keeps its
history in its own undocumented on-disk format. So the conversation is replayed as text: a
`<conversation_history>` block in front of the new session's first message, after which the new
engine holds it itself. Every turn in it is fenced, so a reply that contains the block's own tags
cannot close it early and speak as another role. Nothing is written into either engine's session
store.

**What carries across.** What was said: every message sent through `sendMessage` and every reply,
recorded per session as it happens. The session's own history buffer is not used for this — it is
capped by event count, and on a long session the opening request is the first thing it loses. The
new session inherits the source's working directory and its engine-neutral settings (permission and
sandbox mode, effort, spend cap, auto-compact threshold, system prompts, extra directories). It does
not inherit anything written for the source engine — its model, tool allowlists in that engine's
tool names, resume ids, profiles.

**What does not.** The source engine's hidden reasoning, which no engine exposes, and the detail of
tool calls — the new agent sees the replies that described the work, and the workspace itself, which
the framing tells it to check before relying on anything the history describes.

**When it is too long.** Up to `maxChars` (default 240,000 characters, ~60k tokens; minimum 4,000)
the whole conversation is sent. Past that, the opening request is kept, the newest turns fill what
is left, and one line records how many turns in between were left out: the request says what the
work is for, the newest turns say where it stands, and the middle is what the workspace can answer.

**A fork, not a move.** The two sessions go their separate ways. The new one starts from the
source's record, so handing it off again carries the whole conversation rather than only its own
part. The history is cleared only after a first send succeeds, so a first turn that fails on the
new engine does not strand the conversation it was carrying.

### ultracode (Claude dynamic workflows)

Set `ultracode: true` on a Claude `session_start` to have Claude orchestrate a JS workflow per substantive task and fan out to subagents. It is injected as the `ultracode: true` settings key merged into `--settings`:

```typescript
await manager.startSession({ name: 'big-task', engine: 'claude', ultracode: true });
```

A workflow runs in the background, so `session_send` returns once it is launched — the reply is
Claude saying so, not the workflow's result. When the workflow finishes, Claude Code starts a turn of
its own to report it. That turn answers no send: it is never returned as the reply to a later
`session_send`, it does not count toward `turnsSucceeded`, and its cost is included in the session's
spend. The same holds for any turn the session did not send, such as a message from another Claude
Code session. Read the outcome by sending a follow-up once the workflow has had time to finish.

### Codex app-server turn control (`engine: 'codex-app'`)

Mid-turn and thread control via the Codex app-server v2 RPCs, surfaced as tools: `codex_interrupt` (cancel the in-flight turn), `codex_steer` (add input without restarting), `codex_fork` (branch the thread), `codex_rollback` (drop the last N turns), `codex_models` (list models + supported reasoning efforts), `codex_thread_list` (list the threads the session can see).

The same engine carries Codex's `/goal`: set and manage it on a session with the `codex_goal_*` tools, or run it as a checked workflow — goal, then verify, then repair on the same thread — with the `goal` node and `clawo goal` ([workflow.md](./workflow.md#goal)).

### Fan-out (cross-engine parallel)

`fanout_start` runs one task across N engine/model agents in parallel and collects their answers (optional synthesis) — the best-of-N / diverse-perspective primitive. Unlike Council, no rounds/votes/worktrees; use Council for isolated parallel edits. See [tools.md](./tools.md#fanout_start).

Each agent is a session and counts against `maxConcurrentSessions`. Fan-out and Council run no more agents at once than there are free slots when they start, and the rest wait for an agent to finish. When no slot is free at all, the agents fail on the cap rather than wait for sessions they do not own. On a memory-constrained host, the cap is the knob that bounds how many engine processes run at once. An aborted fan-out starts none of the agents still waiting.

## Runtime Operations

### Model Switching

Switch models mid-conversation with `switchModel()` (tool: `session_switch_model`). The session restarts on the new model and resumes the engine's own conversation by its resume id, so history is preserved:

```typescript
await manager.switchModel('my-task', 'haiku'); // fast model for simple tasks
await manager.switchModel('my-task', 'opus'); // back to powerful model
```

The switch is refused while a turn is running, for a model the registry does not know (a `provider/model` string is accepted), and for a session with no resume id yet — except `agy`, which then restarts fresh. If the restart fails, the session is restarted with its old configuration and the call throws. `setModel()` only changes the stored model, which takes effect at the next restart.

### Tool Management

Add/remove tool permissions at runtime with `updateTools()` (tool: `session_update_tools`), which restarts the session the same way:

```typescript
await manager.updateTools('my-task', {
  allowedTools: ['Bash', 'Read'],
  merge: true, // add to the existing lists
});

await manager.updateTools('my-task', {
  removeTools: ['Bash'], // drop Bash from both lists
  merge: true, // keep the rest of each list
});
```

Without `merge: true` both lists are replaced, so a list you omit is cleared — including on a call that only passes `removeTools`. The busy and resume-id guards of `switchModel()` apply here too.

### Context Management

```typescript
// Compact to reclaim context window
await manager.compactSession('my-task', 'We fixed the auth bug, now working on tests');

// Check context usage
const status = manager.getStatus('my-task');
console.log(`Context: ${status.stats.contextPercent}%`);
```

`contextPercent` is how full the live context is right now — the current turn's
prompt over the window the engine actually enforces — so it rises and falls with
the conversation. A persistent `custom` engine is the exception: there it is the
session's cumulative tokens over the engine config's `contextWindow` (200,000 when
unset), so it only grows (and a one-shot `custom` engine reports 0).
`stats.tokensIn` is the different question of how many input tokens the session
has been billed for in total, which only ever grows.

`compactSession()` runs `/compact` (with the optional summary) on `claude` and a
persistent `custom` engine, and starts the thread's own compaction on `codex-app`.
It is a no-op on the one-shot engines whose CLI has no compaction command (`codex`,
`agy`, `grok`, `opencode`), which log a warning the first time it is called, and a
silent no-op on `acp` agents, which manage their own context, and on one-shot
`custom` engines.

A long-lived session can compact itself: start it with `autoCompactPercent`
(1–99, off by default) and, before each send, the session is compacted first
if `contextPercent` has reached that value. Every call in a turn re-reads the
whole context from cache, so cost grows with context size; compacting earlier
trades detail of older turns for cheaper ones. The setting survives a restart
of the server, and a failed compaction never costs the send.

```typescript
await manager.startSession({ name: 'assistant', cwd: '/srv/bot', autoCompactPercent: 85 });
```

`stats.turns` and `stats.turnsSucceeded` are the same kind of distinction.
`turns` counts turns that reached the engine, whatever their outcome, including
the ones that then failed. `turnsSucceeded` counts only the ones the engine
reported as successful, and it is one per send on every engine.

**The two are only comparable on the one-shot engines.** There `turns` is also
one per send, so the difference between them is the failure count. On `claude`
and a persistent `custom`, `turns` counts `user` events — and the CLI emits one
per tool-result batch as well as the prompt echo, so a send that used eight tools
counts nine. Compare `turnsSucceeded` against the number of sends there, never
against `turns`.

Which outcome counts as a success is the engine's own verdict, not the exit
code's: `codex` fails a turn that emits `turn.failed` while exiting 0, `agy`
requires a `SUCCESS` status, a zero exit _and_ a non-empty reply (it can report
success and then die in cleanup), `codex-app` requires `status: 'completed'` so a
turn cancelled through `interrupt()` does not count, an `acp` agent must end the
turn with the stop reason `end_turn`, `opencode` refuses a turn on purpose when
read-only enforcement did not load, and the legacy `gemini` engine succeeds on
exit 53 because its turn limit resolves.

**A succeeded turn is not a turn that did the work.** When the engine refuses a
tool call it usually does not fail the turn. On Claude Code with
`--permission-prompts none` — which a session gets whenever no prompt tool is
configured — a turn asked to write a file came back `subtype: 'success'`,
`is_error: false`, with the refused Bash call listed in the result event and no
file on disk. It counts in `turnsSucceeded` and sets no `error`. The refused calls
reach the caller as `permissionDenials` on the send result; read that before
treating a successful turn as work done.

The run ledger's `ok` reads this same counter, so a turn cannot be a failure on
`/v1/sessions` and a success in `clawo runs`.

### Cost Tracking

```typescript
const cost = manager.getCost('my-task');
console.log(`Model: ${cost.model}`);
console.log(`Input: $${cost.breakdown.inputCost.toFixed(4)}`);
console.log(`Output: $${cost.breakdown.outputCost.toFixed(4)}`);
console.log(`Total: $${cost.totalUsd.toFixed(4)}`);
```

## Multi-Model Proxy

Built-in format translation lets Claude Code CLI talk to non-Anthropic models:

- **Anthropic ↔ OpenAI** bidirectional message/tool conversion
- **Streaming SSE** format conversion
- **Gemini** schema cleaning (removes unsupported JSON Schema keys)
- **Gemini** thought signature caching (round-trip thinking)
- Auto-detect provider from model name patterns

A `claude` session started with a non-Claude model and no `baseUrl` starts the proxy on a local port and points the session at it. Configuration is in the proxy section of [Multi-Engine](./multi-engine.md); see [`src/proxy/`](https://github.com/Enderfga/claw-orchestrator/tree/main/src/proxy) for implementation details.

## Circuit Breaker

SessionManager tracks consecutive failures per engine type. After 3 consecutive start failures for an engine, a circuit breaker opens with exponential backoff (1s × 2^(n-1) after the n-th consecutive failure, capped at 5 minutes). During backoff, new session creation for that engine is rejected with a descriptive error.

- Resets on successful session start
- State visible in the `health()` response (the `sessions_overview` tool) under `circuitBreakers`
- Constants: `CIRCUIT_BREAKER_THRESHOLD` (3), `CIRCUIT_BREAKER_BACKOFF_BASE_MS` (1s), `CIRCUIT_BREAKER_MAX_BACKOFF_MS` (5 min)

## Orphaned Process Cleanup

If the process that owns the sessions exits without stopping them, their engine processes can outlive it. When a session starts, SessionManager records the PID of its engine process in `~/.openclaw/session-pids.json`, together with its own PID, and cleans up on startup:

1. Reads the PID file left by earlier runs
2. Skips entries whose owning SessionManager is still alive, and old-format entries that name no owner
3. For each remaining PID, checks if the process is alive (`kill -0`)
4. Verifies the process command line names a known engine binary — `claude`, `codex`, `agy`, `grok`, `opencode`, or the legacy `gemini` / `cursor-agent` / `agent` — so a recycled PID is never killed
5. Sends SIGTERM to the process group and the process, then SIGKILL after 3 seconds
6. Rewrites the PID file without the stale entries

The one-shot engines have no process running when a session starts, so they have no PID to record. ACP agents and persistent custom engines are recorded, but their binaries are not in the known list, so an orphaned one is left running.

## Stats & Monitoring

Session stats are `manager.getStatus(name).stats`, surfaced through `coding_session_status`.

Claude Code–specific stats:

| Field                 | Type                                   | Description                                                                                                                               |
| --------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `retries`             | number                                 | Total API retries that occurred during the session (present on every engine; only Claude Code reports retries)                            |
| `lastRetryError`      | string \| undefined                    | Error category of the most recent retry (e.g. `overloaded`, `rate_limit`), or its HTTP status when the CLI gives no category              |
| `pluginErrors`        | `Array<{plugin, reason}>` \| undefined | Plugins that failed to load due to unmet dependencies, captured from the `system/init` event. `undefined` when no plugin errors occurred. |
| `refusalFallbacks`    | number \| undefined                    | Turns the model refused and the CLI re-ran on another model (`system/model_refusal_fallback`). `undefined` when none happened             |
| `lastRefusalFallback` | `{from, to, category?}` \| undefined   | The most recent of those: the refusing model, the model that re-ran the turn, and the refusal category when the CLI reports one           |

### `system/api_retry` events

When Claude Code CLI performs an API retry (transient errors, overload, etc.) it emits a `system` event with subtype `api_retry`. The plugin parses these events and increments `retries` / updates `lastRetryError` in the session stats. These events are also visible in the session event history returned by `session_grep`, which holds the session's last 100 events.

```typescript
const status = manager.getStatus('my-task');
console.log(`Retries so far: ${status.stats.retries}`);
if (status.stats.lastRetryError) {
  console.log(`Last retry reason: ${status.stats.lastRetryError}`);
}
```

## ISession.pid

All session engine classes expose an optional `pid` readonly property, providing the OS process ID of the underlying CLI subprocess. Returns `undefined` when no process is running — on the one-shot engines, between sends. SessionManager reads it for [orphan cleanup](#orphaned-process-cleanup) and does not expose it; read it from an engine class you construct yourself:

```typescript
import { PersistentClaudeSession } from '@enderfga/claw-orchestrator';

const session = new PersistentClaudeSession({ name: 'probe', cwd: '/path/to/project', permissionMode: 'acceptEdits' });
await session.start();
console.log(session.pid); // e.g., 12345
```

## Verifying what a session did

A plain session leaves no verdict — it ran, and nothing checked the result. To
check it, hand `verify_run` a contract and the directory:

```jsonc
verify_run({
  cwd: "/repo",
  contract: { checks: [{ type: "command", cmd: "npm", args: ["test"] }] }
})
```

For work that should be checked as part of running it, use a workflow instead —
see [`workflow.md`](./workflow.md).
