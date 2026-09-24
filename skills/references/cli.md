# CLI Reference

The CLI is an HTTP client that talks to the Claw Orchestrator embedded server. In plugin mode, the server auto-starts. In standalone mode, run `clawo serve` first.

## Server

```bash
clawo serve [-p, --port <port>] [-H, --host <host>] [--ultraapp-runtime host|docker]
```

Start standalone embedded server (default port 18796, bound to `127.0.0.1`; pass `-H 0.0.0.0` for remote access). `--ultraapp-runtime` selects how ultraapp builds run: `host` (default, spawns Node directly) or `docker`. CLI commands reach the server at `CLAWO_API_URL` (default `http://127.0.0.1:18796`).

### Rate Limiting

The embedded server limits each IP address to 300 requests per minute (sliding window; override with `OPENCLAW_RATE_LIMIT`). Requests over the limit receive HTTP 429 (Too Many Requests).

### OpenAI-Compatible API

The server exposes an OpenAI-compatible chat completions endpoint, enabling any webchat frontend to use it as a backend.

**Endpoints:**

| Endpoint               | Method | Description                                  |
| ---------------------- | ------ | -------------------------------------------- |
| `/v1/chat/completions` | POST   | Chat completions (streaming + non-streaming) |
| `/v1/models`           | GET    | List available models                        |

**Request format** (same as OpenAI):

```json
{
  "model": "sonnet",
  "messages": [{ "role": "user", "content": "Hello!" }],
  "stream": true
}
```

**Session routing:** Each conversation maps to a persistent session for prompt cache reuse. Session key resolved from (in priority order):

1. `X-Session-Id` header
2. `user` field in the request body
3. A hash of the model, system prompt and tool definitions (`sys-<hash>`)
4. `default`, when all of those are empty

**Model routing:** The `model` field auto-routes to the correct engine:

- `claude-*`, `opus`, `sonnet`, `haiku` → Claude engine
- `gpt-*`, `o3*`, `o4*`, `codex*` → Codex engine
- `grok*` → Grok engine
- `composer*`, `cursor*`, `auto` → Cursor engine (legacy)
- `agy/*`, the `agy-flash` / `agy-pro` aliases, and the registered Antigravity models (e.g. `gemini-3.8-flash`, `gemini-3.1-pro`) → Antigravity (`agy`) engine
- other `gemini*` → the legacy `gemini` engine (Gemini CLI is sunset; prefer `agy`)
- anything else → Claude engine

**CORS:** `/v1/` paths allow cross-origin requests by default. Set `OPENCLAW_CORS_ORIGINS=*` to allow all origins on all paths.

**Auto-compact:** When a session's context utilization exceeds 80%, the endpoint automatically compacts the session before sending the next message.

## ACP agent

```bash
clawo acp
```

Run as an Agent Client Protocol agent over stdio (same as the `clawo-acp` binary). See [acp.md](./acp.md).

## Session Management

### session-start

```bash
clawo session-start [name] [options]
```

| Flag                            | Description                                                                                 |
| ------------------------------- | ------------------------------------------------------------------------------------------- |
| `-d, --cwd <dir>`               | Working directory                                                                           |
| `-e, --engine <engine>`         | Engine: `claude` (default), `codex`, `codex-app`, `agy`, `grok`, `opencode`, or `custom`    |
| `-m, --model <model>`           | Model name or alias                                                                         |
| `--permission-mode <mode>`      | `acceptEdits` (default), `plan`, `auto`, `bypassPermissions`, `manual`, `dontAsk`           |
| `--effort <level>`              | `low`, `medium`, `high`, `xhigh`, `max`, `ultra`, `auto`                                    |
| `--allowed-tools <tools>`       | Comma-separated tool whitelist                                                              |
| `--disallowed-tools <tools>`    | Comma-separated tools to deny                                                               |
| `--max-turns <n>`               | Max agent loop turns                                                                        |
| `--max-budget <usd>`            | API cost ceiling                                                                            |
| `--system-prompt <text>`        | Replace system prompt                                                                       |
| `--append-system-prompt <text>` | Append to system prompt                                                                     |
| `--agents <json>`               | Custom sub-agents JSON                                                                      |
| `--agent <name>`                | Default agent                                                                               |
| `--bare`                        | No CLAUDE.md, no git context                                                                |
| `-w, --worktree [name]`         | Git worktree                                                                                |
| `--fallback-model <model>`      | Fallback model                                                                              |
| `--json-schema <schema>`        | JSON Schema for structured output                                                           |
| `--mcp-config <paths>`          | MCP config files (comma-separated)                                                          |
| `--settings <pathOrJson>`       | Settings.json path or inline JSON                                                           |
| `--skip-persistence`            | Do not save the session — neither the engine's transcript nor the resume registry           |
| `--betas <headers>`             | Beta headers (comma-separated)                                                              |
| `--enable-agent-teams`          | Enable agent teams                                                                          |
| `--enable-auto-mode`            | Enable auto permission mode                                                                 |
| `--resume-session-id <id>`      | Resume an existing session by ID                                                            |
| `--base-url <url>`              | Custom API endpoint (for proxy)                                                             |
| `--add-dir <dirs>`              | Comma-separated additional working directories                                              |
| `--custom-engine <preset>`      | With `-e custom`: the id of a bundled engine preset (see [`clawo engines`](#clawo-engines)) |

The remaining `session_start` options (hook events, permission-prompt tool, debug output, `fromPr`, MCP channels, prompt-cache settings and others) are tool parameters only and have no CLI flag. See [Tools Reference](./tools.md#session_start).

### session-send

```bash
clawo session-send <name> <message> [options]
```

| Flag                 | Description                      |
| -------------------- | -------------------------------- |
| `--effort <level>`   | Override effort for this message |
| `--plan`             | Enable plan mode                 |
| `-s, --stream`       | Collect streaming chunks         |
| `-t, --timeout <ms>` | Timeout (default 300000)         |

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

## Run Ledger

```bash
clawo runs [-s, --since <window>] [-n, --limit <n>] [--session <name>] [--engine <engine>] [--parent <id>] [--verified | --refuted] [--json]
```

Show the durable per-turn record kept at `~/.claw-orchestrator/runs/`. Unlike
`session-status`, this survives restarts and covers sessions this process never
owned. `--since` takes `30m` / `24h` / `7d` / `2w` or an ISO timestamp (default
`24h`); `--parent` filters to one council / fanout / autoloop / workflow run;
`--verified` / `--refuted` keep only turns whose acceptance contract passed /
failed. Costs marked with a trailing `~` came from estimated token counts. The
`VERIFIED` column reads `yes`, `NO`, or `—` ("no contract was declared, so
nothing checked it"). See [observability.md](observability.md).

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

## Tools Without a CLI Command

Tools without a CLI command are reachable through the OpenClaw plugin, the MCP
server (`clawo-mcp`, see [mcp.md](./mcp.md)), or the `SessionManager` API. See
[Tools Reference](./tools.md) for full parameter documentation.

## `clawo workflow`

```bash
clawo workflow list [--state <s>] [--workflow <name>] [--limit N] [--json]
clawo workflow show <runId> [--json]
clawo workflow resume <runId>          # re-attach to a run whose process died
clawo workflow cancel <runId>
clawo workflow steer <runId> "<text>"  # queue a correction for the next agent node
clawo workflow approve <runId> [reject]
```

`list` prints one row per run with its outcome as `verified` / `REFUTED` /
`unchecked`. `unchecked` means no acceptance contract was declared — it is not a
failure.

Runs survive restarts, so `list` sees runs started by other processes and by
earlier sessions.

## `clawo verify`

```bash
clawo verify <runId> [--evidence <id>] [--json]
```

Prints the evidence bundle: per-check pass/fail with the failing command and its
output tail, the base and head commits, and the files the run changed (created
files included).

## `clawo engines`

Lists the community engine presets bundled with the installed package, with each
one's provenance — who attested it, against which engine version, on what date.
Read locally rather than over HTTP, since it is a property of the package and has
to work with no server running.

```bash
clawo engines
clawo engines --json
clawo session-start my-session -e custom --custom-engine <id>
```

A preset id is the only form of custom engine the CLI can pass: it reaches the
session through the HTTP surface, which refuses inline configs because those name
a binary and its arguments. See [multi-engine.md](./multi-engine.md) for the tiers
and what a community preset does and does not claim.
