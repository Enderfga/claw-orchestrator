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
  model: 'opus',                    // alias or full name
  permissionMode: 'acceptEdits',
  effort: 'high',
  allowedTools: ['Bash', 'Read', 'Edit', 'Write'],
  maxTurns: 50,
  maxBudgetUsd: 5.0,
});
```

Key options:

| Option | Description |
|--------|-------------|
| `engine` | `'claude'` (default), `'codex'`, or `'gemini'` — see [Multi-Engine](./multi-engine.md) |
| `model` | Model alias (`opus`, `sonnet`, `haiku`, `gemini-pro`) or full name |
| `permissionMode` | `acceptEdits`, `bypassPermissions`, `plan`, `auto`, `default` |
| `effort` | `low`, `medium`, `high`, `max`, `auto` |
| `bare` | Skip hooks, LSP, auto-memory, CLAUDE.md |
| `worktree` | Run in isolated git worktree |
| `appendSystemPrompt` | Append custom instructions to the system prompt |

### Sending Messages

```typescript
const result = await manager.sendMessage('my-task', 'Fix the auth bug', {
  effort: 'high',       // override effort for this message
  plan: true,           // enter plan mode
  timeout: 600_000,     // 10 min timeout
  onChunk: (text) => process.stdout.write(text),  // streaming
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

### ultracode (Claude dynamic workflows)

Set `ultracode: true` on a Claude `session_start` to have Claude orchestrate a JS workflow per substantive task and fan out to subagents. It is injected as the `ultracode: true` settings key merged into `--settings` (not a `--effort` value — the CLI rejects `--effort ultracode`):

```typescript
await manager.startSession({ name: 'big-task', engine: 'claude', ultracode: true });
```

### Codex app-server turn control (`engine: 'codex-app'`)

Mid-turn and thread control via Codex 0.137 v2 RPCs, surfaced as tools: `codex_interrupt` (cancel the in-flight turn), `codex_steer` (add input without restarting), `codex_fork` (branch the thread), `codex_rollback` (drop the last N turns), `codex_models` (list models + supported reasoning efforts).

### Fan-out (cross-engine parallel)

`fanout_start` runs one task across N engine/model agents in parallel and collects their answers (optional synthesis) — the best-of-N / diverse-perspective primitive. Unlike Council, no rounds/votes/worktrees; use Council for isolated parallel edits. See [tools.md](./tools.md#fan-out-3).

## Runtime Operations

### Model Switching

Switch models mid-conversation. The session restarts with `--resume` to preserve history:

```typescript
await manager.switchModel('my-task', 'haiku');  // fast model for simple tasks
await manager.switchModel('my-task', 'opus');   // back to powerful model
```

### Tool Management

Add/remove tool permissions at runtime:

```typescript
await manager.updateTools('my-task', {
  allowedTools: ['Bash', 'Read'],
  merge: true,                    // add to existing list
});

await manager.updateTools('my-task', {
  removeTools: ['Bash'],          // revoke Bash access
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

If the plugin crashes without calling `stop()`, child CLI processes (claude, codex, gemini, agent) may become orphans. SessionManager tracks PIDs in `~/.openclaw/session-pids.json` and cleans up stale processes on startup:

1. Reads PID file from previous run
2. For each PID, checks if process is alive (`kill -0`)
3. Verifies the process command line matches a known CLI binary (prevents killing recycled PIDs)
4. Sends SIGTERM, then SIGKILL after 3 seconds
5. Clears the PID file

## Stats & Monitoring

Session stats are returned by `getStats()` and surfaced through `coding_session_status`.

Fields added in plugin v2.13.0 (Claude CLI 2.1.111):

| Field | Type | Description |
|-------|------|-------------|
| `retries` | number | Total API retries that occurred during the session |
| `lastRetryError` | string \| undefined | Error message from the most recent retry (if any) |

Fields added in plugin v2.14.0 (Claude CLI 2.1.121):

| Field | Type | Description |
|-------|------|-------------|
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
