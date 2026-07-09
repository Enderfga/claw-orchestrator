# CLI Reference

The CLI is an HTTP client that talks to the Claw Orchestrator embedded server. In plugin mode, the server auto-starts. In standalone mode, run `clawo serve` first.

## Server

```bash
clawo serve [-p, --port <port>]
```

Start standalone embedded server (default port 18796). Set `CLAWO_API_URL` to override the base URL.

### Rate Limiting

The embedded server enforces a sliding-window rate limit of 100 requests per minute per IP address. Requests exceeding the limit receive HTTP 429 (Too Many Requests). This prevents accidental runaway scripts from overwhelming the server.

### OpenAI-Compatible API

The server exposes an OpenAI-compatible chat completions endpoint, enabling any webchat frontend to use it as a backend.

**Endpoints:**

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/v1/chat/completions` | POST | Chat completions (streaming + non-streaming) |
| `/v1/models` | GET | List available models |

**Request format** (same as OpenAI):
```json
{
  "model": "claude-sonnet-4-6",
  "messages": [{"role": "user", "content": "Hello!"}],
  "stream": true
}
```

**Session routing:** Each conversation maps to a persistent session for prompt cache reuse. Session key resolved from (in priority order):
1. `X-Session-Id` header
2. `user` field in the request body
3. Default singleton session

**Model routing:** The `model` field auto-routes to the correct engine:
- `claude-*`, `opus`, `sonnet`, `haiku` → Claude engine
- `gpt-*` → Codex engine
- `composer-*` → Cursor engine
- `gemini-3.5-flash`, `gemini-3.1-pro`, `agy-*`, `agy/*` → Antigravity (`agy`) engine
- other `gemini-*` → Gemini engine

**CORS:** `/v1/` paths allow cross-origin requests by default. Set `OPENCLAW_CORS_ORIGINS=*` to allow all origins on all paths.

**Auto-compact:** When a session's context utilization exceeds 80%, the endpoint automatically compacts the session before sending the next message.

## Session Management

### session-start

```bash
clawo session-start [name] [options]
```

| Flag | Description |
|------|-------------|
| `-d, --cwd <dir>` | Working directory |
| `-e, --engine <engine>` | Engine: `claude` (default), `codex`, `codex-app`, `gemini`, `agy`, `cursor`, `opencode`, or `custom` |
| `-m, --model <model>` | Model name or alias |
| `--permission-mode <mode>` | `acceptEdits`, `plan`, `auto`, `bypassPermissions` |
| `--effort <level>` | `low`, `medium`, `high`, `max`, `auto` |
| `--allowed-tools <tools>` | Comma-separated tool whitelist |
| `--max-turns <n>` | Max agent loop turns |
| `--max-budget <usd>` | API cost ceiling |
| `--system-prompt <text>` | Replace system prompt |
| `--append-system-prompt <text>` | Append to system prompt |
| `--agents <json>` | Custom sub-agents JSON |
| `--agent <name>` | Default agent |
| `--bare` | No CLAUDE.md, no git context |
| `-w, --worktree [name]` | Git worktree |
| `--fallback-model <model>` | Fallback model |
| `--json-schema <schema>` | JSON Schema for structured output |
| `--mcp-config <paths>` | MCP config files (comma-separated) |
| `--settings <path>` | Settings.json path |
| `--skip-persistence` | Disable session persistence |
| `--betas <headers>` | Beta headers (comma-separated) |
| `--enable-agent-teams` | Enable agent teams |
| `--include-hook-events` | Stream hook lifecycle events (PreToolUse/PostToolUse) |
| `--permission-prompt-tool <tool>` | Delegate permission prompts to an MCP tool (non-interactive use) |
| `--exclude-dynamic-system-prompt-sections` | Move cwd/env/git context to user message for better prompt cache hits (auto-enabled with `--bare`) |
| `--debug <categories>` | Enable targeted debug output by category (e.g. `"api,mcp"`) |
| `--debug-file <path>` | Write debug output to file |
| `--from-pr <n>` | Resume a session linked to a GitHub PR number or URL |
| `--channels <spec>` | MCP channel subscription (research preview) |
| `--dangerously-load-development-channels <spec>` | Development MCP channel subscriptions (research preview) |
| `ENABLE_PROMPT_CACHING_1H=1` (env var) | Enable 1-hour prompt cache TTL (auto-set with `--bare`) |

### session-send

```bash
clawo session-send <name> <message> [options]
```

| Flag | Description |
|------|-------------|
| `--effort <level>` | Override effort for this message |
| `--plan` | Enable plan mode |
| `-s, --stream` | Collect streaming chunks |
| `-t, --timeout <ms>` | Timeout (default 300000) |

### session-stop

```bash
clawo session-stop <name>
```

### session-list

```bash
clawo session-list
```

### session-status

```bash
clawo session-status <name>
```

### session-grep

```bash
clawo session-grep <name> <pattern> [-n, --limit <n>]
```

### session-compact

```bash
clawo session-compact <name> [--summary <text>]
```

## Agent Management

```bash
clawo agents-list [-d, --cwd <dir>]
clawo agents-create <name> [--description <desc>] [--prompt <prompt>]
```

## Skills Management

```bash
clawo skills-list [-d, --cwd <dir>]
clawo skills-create <name> [--description <desc>] [--prompt <prompt>] [--trigger <t>]
```

## Rules Management

```bash
clawo rules-list [-d, --cwd <dir>]
clawo rules-create <name> [--description <desc>] [--content <text>] [--paths <glob>] [--condition <expr>]
```

## Agent Teams

```bash
clawo session-team-list <name>
clawo session-team-send <name> <teammate> <message>
```

## SDK-Only Tools (No CLI Wrapper)

The following tools are available through the OpenClaw plugin SDK and TypeScript API but do not have CLI commands. Use the SDK directly or call them via OpenClaw's tool system.

| Tool | Description |
|------|-------------|
| `sessions_overview` | Aggregate dashboard of all active sessions |
| `session_update_tools` | Hot-swap allowed/disallowed tools via `--resume` |
| `session_switch_model` | Switch model mid-session via `--resume` |
| `council_start` | Start multi-agent council with worktree isolation |
| `council_status` | Poll council progress and agent responses |
| `council_abort` | Abort a running council |
| `council_inject` | Inject a message into the next council round |
| `session_send_to` | Cross-session messaging (immediate or queued) |
| `session_inbox` | Read inbox messages for a session |
| `session_deliver_inbox` | Deliver queued messages to an idle session |
| `ultraplan_start` | Start background Opus planning session |
| `ultraplan_status` | Poll ultraplan progress |
| `ultrareview_start` | Start fleet of parallel reviewer agents |
| `ultrareview_status` | Poll ultrareview findings |

See [Tools Reference](./tools.md) for full parameter documentation.
