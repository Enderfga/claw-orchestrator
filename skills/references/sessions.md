# Sessions

Sessions are the core abstraction — persistent, multi-turn coding conversations backed by a CLI subprocess.

## Lifecycle

```
start() → send() → send() → ... → stop()
           ↑                          |
           └── resume (7-day TTL) ────┘
```

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

Key options:

| Option               | Description                                                                                                                            |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `engine`             | `'claude'` (default), `'codex'`, `'codex-app'`, `'agy'`, `'grok'`, `'opencode'`, or `'custom'` — see [Multi-Engine](./multi-engine.md) |
| `model`              | Model alias (`fable`, `opus`, `sonnet`, `haiku`, `agy-pro`) or full name                                                               |
| `permissionMode`     | `acceptEdits`, `bypassPermissions`, `plan`, `auto`, `manual`, `dontAsk` (`default` = legacy alias for `manual`)                        |
| `effort`             | `low`, `medium`, `high`, `max`, `auto`                                                                                                 |
| `bare`               | Skip hooks, LSP, auto-memory, CLAUDE.md                                                                                                |
| `worktree`           | Run in isolated git worktree                                                                                                           |
| `appendSystemPrompt` | Append custom instructions to the system prompt. Claude Code and Grok take it natively; Codex, Antigravity and OpenCode have no such flag and receive it at the top of the first message of a conversation |

### Sending Messages

```typescript
const result = await manager.sendMessage('my-task', 'Fix the auth bug', {
  effort: 'high', // override effort for this message
  plan: true, // enter plan mode
  timeout: 600_000, // 10 min timeout
  onChunk: (text) => process.stdout.write(text), // streaming
});

console.log(result.output);
```

### Session Persistence

Sessions automatically persist to `~/.openclaw/claude-sessions.json`:

- **Memory TTL**: configurable (default 120 min) — idle sessions unloaded
- **Disk TTL**: 7 days — sessions can be resumed after gateway restart
- **Auto-resume**: `startSession` with the same name auto-resumes if a persisted session exists

### Session Resume & Fork

```typescript
// Resume a specific Claude Code session
await manager.startSession({
  name: 'continued',
  resumeSessionId: 'abc123-session-id',
});

// Fork for experiments (preserves history, new branch)
await manager.startSession({
  name: 'experiment',
  resumeSessionId: 'abc123',
  forkSession: true,
});
```

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
sandbox mode, effort, spend cap, system prompts, extra directories). It does not inherit anything
written for the source engine — its model, tool allowlists in that engine's tool names, resume ids,
profiles.

**What does not.** The source engine's hidden reasoning, which no engine exposes, and the detail of
tool calls — the new agent sees the replies that described the work, and the workspace itself, which
the framing tells it to check before relying on anything the history describes.

**When it is too long.** Up to `maxChars` (default 240,000 characters, ~60k tokens) the whole
conversation is sent. Past that, the opening request is kept, the newest turns fill what is left,
and one line records how many turns in between were left out: the request says what the work is
for, the newest turns say where it stands, and the middle is what the workspace can answer.

**A fork, not a move.** The two sessions go their separate ways. The new one starts from the
source's record, so handing it off again carries the whole conversation rather than only its own
part. The history is cleared only after a first send succeeds, so a first turn that fails on the
new engine does not strand the conversation it was carrying.

Verified end to end over MCP against the installed engines: a fact planted in a Claude session was
recalled by Codex 0.154.0 after a handoff, and again by Claude after a second handoff back, which
also named Codex as the engine it had taken over from.

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

Mid-turn and thread control via Codex 0.137 v2 RPCs, surfaced as tools: `codex_interrupt` (cancel the in-flight turn), `codex_steer` (add input without restarting), `codex_fork` (branch the thread), `codex_rollback` (drop the last N turns), `codex_models` (list models + supported reasoning efforts).

### Fan-out (cross-engine parallel)

`fanout_start` runs one task across N engine/model agents in parallel and collects their answers (optional synthesis) — the best-of-N / diverse-perspective primitive. Unlike Council, no rounds/votes/worktrees; use Council for isolated parallel edits. See [tools.md](./tools.md#fan-out-3).

Each agent is a session and counts against `maxConcurrentSessions`. Fan-out and Council run no more agents at once than there are free slots when they start, and the rest wait for an agent to finish. When no slot is free at all, the agents fail on the cap rather than wait for sessions they do not own. On a memory-constrained host, the cap is the knob that bounds how many engine processes run at once. An aborted fan-out starts none of the agents still waiting.

## Runtime Operations

### Model Switching

Switch models mid-conversation. The session restarts with `--resume` to preserve history:

```typescript
await manager.switchModel('my-task', 'haiku'); // fast model for simple tasks
await manager.switchModel('my-task', 'opus'); // back to powerful model
```

### Tool Management

Add/remove tool permissions at runtime:

```typescript
await manager.updateTools('my-task', {
  allowedTools: ['Bash', 'Read'],
  merge: true, // add to existing list
});

await manager.updateTools('my-task', {
  removeTools: ['Bash'], // revoke Bash access
});
```

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
the conversation. `stats.tokensIn` is the different question of how many input
tokens the session has been billed for in total, which only ever grows.
`compactSession()` is a no-op on engines whose CLI has no compaction command
(`codex`, `agy`, `grok`, `opencode`); those sessions log a warning the first
time it is called.

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
requires a `SUCCESS` status _and_ a zero exit (it can report success and then die
in cleanup), `gemini` succeeds on exit 53 because its turn limit resolves,
`codex-app` requires `status: 'completed'` so a turn cancelled through
`interrupt()` does not count, and `opencode` refuses a turn on purpose when
read-only enforcement did not load.

**A succeeded turn is not a turn that did the work.** When the engine refuses a
tool call it usually does not fail the turn. Measured on Claude Code 2.1.269 with
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

See `src/proxy/` for implementation details.

## Circuit Breaker

SessionManager tracks consecutive failures per engine type. After 3 consecutive start failures for an engine, a circuit breaker opens with exponential backoff (1s × 2^(n-1), capped at 5 minutes). During backoff, new session creation for that engine is rejected with a descriptive error.

- Resets on successful session start
- State visible in `health()` response under `circuitBreakers`
- Constants: `CIRCUIT_BREAKER_THRESHOLD` (3), `CIRCUIT_BREAKER_BACKOFF_BASE_MS` (1s), `CIRCUIT_BREAKER_MAX_BACKOFF_MS` (5 min)

## Orphaned Process Cleanup

If the plugin crashes without calling `stop()`, child CLI processes (claude, codex, agy, agent, opencode) may become orphans. SessionManager tracks PIDs in `~/.openclaw/session-pids.json` and cleans up stale processes on startup:

1. Reads PID file from previous run
2. For each PID, checks if process is alive (`kill -0`)
3. Verifies the process command line matches a known CLI binary (prevents killing recycled PIDs)
4. Sends SIGTERM, then SIGKILL after 3 seconds
5. Clears the PID file

## Stats & Monitoring

Session stats are returned by `getStats()` and surfaced through `coding_session_status`.

Fields added in plugin v2.13.0 (Claude CLI 2.1.111):

| Field            | Type                | Description                                        |
| ---------------- | ------------------- | -------------------------------------------------- |
| `retries`        | number              | Total API retries that occurred during the session |
| `lastRetryError` | string \| undefined | Error message from the most recent retry (if any)  |

Fields added in plugin v2.14.0 (Claude CLI 2.1.121):

| Field          | Type                                   | Description                                                                                                                               |
| -------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `pluginErrors` | `Array<{plugin, reason}>` \| undefined | Plugins that failed to load due to unmet dependencies, captured from the `system/init` event. `undefined` when no plugin errors occurred. |

### `system/api_retry` events

When Claude Code CLI performs an API retry (transient errors, overload, etc.) it emits a `system` event with subtype `api_retry`. The plugin parses these events and increments `retries` / updates `lastRetryError` in the session stats. These events are also visible in the session event history returned by `session_grep`.

```typescript
const status = manager.getStatus('my-task');
console.log(`Retries so far: ${status.stats.retries}`);
if (status.stats.lastRetryError) {
  console.log(`Last retry reason: ${status.stats.lastRetryError}`);
}
```

## ISession.pid

All session engine classes expose an optional `pid` readonly property, providing the OS process ID of the underlying CLI subprocess. Returns `undefined` when no process is running.

```typescript
const session = manager.getSession('my-session');
console.log(session.pid); // e.g., 12345 or undefined
```

## Verifying what a session did (6.0.0)

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

`SendOptions` also gained `nodeKind` and `taskKind`, both stamped onto the run
ledger row. `taskKind` is caller-declared and never inferred from the prompt.
