# CLI Reference

The CLI is an HTTP client that talks to the Claw Orchestrator embedded server. Under OpenClaw, the plugin starts the server on its first tool call (unless `CLAWO_NO_EMBEDDED_SERVER=1`). In standalone mode, run `clawo serve` first. `clawo acp` and `clawo engines` run locally and do not need the server.

## Connecting to the server

- **Address**: commands reach the server at `CLAWO_API_URL` (default `http://127.0.0.1:18796`).
- **Token**: every request carries the server's token, when the CLI finds one, as `Authorization: Bearer <token>`. The CLI reads it from `CLAWO_AUTH_TOKEN`, then `OPENCLAW_SERVER_TOKEN`, then `~/.openclaw/server-token`, which the server writes when it starts. See [Getting Started](./getting-started.md) for how the server chooses the token.
- **Errors**: when the server reports an error or cannot be reached, a command prints `Failed: <error>` to stderr and exits 1. With `--json`, `session-send` and `session-status` print the JSON result instead and still exit 1.

## Server

```bash
clawo serve [-p, --port <port>] [-H, --host <host>] [--ultraapp-runtime host|docker]
```

Start the standalone embedded server (default port 18796, bound to `127.0.0.1`, or `OPENCLAW_SERVER_HOST` when set; pass `-H 0.0.0.0` for remote access). `--ultraapp-runtime` selects how ultraapp builds run: `host` (default, spawns Node directly) or `docker`. The server also starts the ultraapp reverse-proxy router on port 19000 (or the next free port); if the router cannot start, ultraapp deploys are skipped and the server runs without it. If the server's port is already in use, `clawo serve` prints an error and exits 1.

Under `clawo serve` the session manager allows 32 concurrent sessions and unloads a session after 60 idle minutes (the plugin defaults are 5 and 120). Override with `OPENCLAW_SERVE_MAX_SESSIONS` and `OPENCLAW_SERVE_TTL_MINUTES`.

### Rate Limiting

The embedded server limits each IP address to 300 requests per minute (sliding window; override with `OPENCLAW_RATE_LIMIT`). Requests over the limit receive HTTP 429 (Too Many Requests).

### OpenAI-Compatible API

The server exposes an OpenAI-compatible chat completions endpoint, enabling any webchat frontend to use it as a backend. The full rules — session keying, `X-Session-Reset`, tool calls and environment variables — are in [openai-compat.md](./openai-compat.md).

**Endpoints:**

| Endpoint               | Method | Description                                                                                            |
| ---------------------- | ------ | ------------------------------------------------------------------------------------------------------ |
| `/v1/chat/completions` | POST   | Chat completions (streaming + non-streaming)                                                           |
| `/v1/models`           | GET    | List available models                                                                                  |
| `/v1/sessions`         | GET    | List the live OpenAI-compatible sessions, each with turns, tokens, cached tokens, context use and cost |

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

An `X-Session-Reset: 1` (or `true`) header answers the request from a fresh session: the session under that key is stopped first, and the fresh one is stopped once the reply is sent.

**Model routing:** The `model` field picks the engine. A model id or alias in the model registry routes to the engine it is registered under (`opus` → Claude, `gemini-3.8-flash` / `agy-pro` → Antigravity), and an `agy/` prefix always selects Antigravity (`agy`). Other names route by prefix:

- `gpt*`, `o3*`, `o4*`, `codex*` → Codex engine
- `grok*` → Grok engine
- any other name containing `gemini` → the legacy `gemini` engine (Gemini CLI is sunset; prefer `agy/<model>` or a registered Antigravity model)
- `composer*`, `cursor*`, `auto` → the legacy `cursor` engine
- anything else → Claude engine

**CORS:** `/v1/` paths allow cross-origin requests by default, and `localhost` origins are allowed on every path. Set `OPENCLAW_CORS_ORIGINS=*` to allow all origins on all paths.

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

`name` defaults to `session-<timestamp>`. Starting a name that is already live returns that session unchanged; a name in the resume registry resumes its conversation (see [sessions.md](./sessions.md#session-persistence)).

| Flag                            | Description                                                                                                 |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `-d, --cwd <dir>`               | Working directory                                                                                           |
| `-e, --engine <engine>`         | Engine: `claude` (default), `codex`, `codex-app`, `agy`, `grok`, `opencode`, `acp`, or `custom`             |
| `-m, --model <model>`           | Model name or alias                                                                                         |
| `--permission-mode <mode>`      | `acceptEdits` (default), `plan`, `auto`, `bypassPermissions`, `manual`, `dontAsk`                           |
| `--effort <level>`              | `low`, `medium`, `high`, `xhigh`, `max`, `ultra`, `auto` (default); each engine clamps it to its own ladder |
| `--allowed-tools <tools>`       | Comma-separated tools to auto-approve                                                                       |
| `--disallowed-tools <tools>`    | Comma-separated tools to deny                                                                               |
| `--max-turns <n>`               | Max agent loop turns                                                                                        |
| `--max-budget <usd>`            | Spend cap in USD, checked before every send on every engine                                                 |
| `--system-prompt <text>`        | Replace system prompt                                                                                       |
| `--append-system-prompt <text>` | Append to system prompt                                                                                     |
| `--agents <json>`               | Custom sub-agents JSON                                                                                      |
| `--agent <name>`                | Default agent                                                                                               |
| `--bare`                        | Claude Code minimal mode: skips hooks, LSP, auto-memory and CLAUDE.md discovery                             |
| `-w, --worktree [name]`         | Git worktree                                                                                                |
| `--fallback-model <model>`      | Fallback model                                                                                              |
| `--json-schema <schema>`        | JSON Schema for structured output                                                                           |
| `--mcp-config <paths>`          | MCP config files (comma-separated)                                                                          |
| `--settings <pathOrJson>`       | Settings.json path or inline JSON                                                                           |
| `--skip-persistence`            | Keep the session out of the resume registry; Claude Code and Codex also skip writing their own transcript   |
| `--betas <headers>`             | Beta headers (comma-separated)                                                                              |
| `--enable-agent-teams`          | Enable agent teams                                                                                          |
| `--enable-auto-mode`            | Enable auto permission mode                                                                                 |
| `--resume-session-id <id>`      | Resume an earlier conversation by the engine's own id (Claude session id, Codex thread id, …)               |
| `--base-url <url>`              | Custom API endpoint (for proxy)                                                                             |
| `--add-dir <dirs>`              | Comma-separated additional working directories                                                              |
| `--custom-engine <preset>`      | With `-e custom`: the id of a bundled engine preset (see [`clawo engines`](#clawo-engines))                 |
| `--acp-agent <preset>`          | With `-e acp`: the id of a bundled ACP agent preset, e.g. `kimi-code`, `dsh`                                |

Most of these flags map to Claude Code options; [multi-engine.md](./multi-engine.md) lists which ones each other engine honours. The remaining `session_start` options (`sandboxMode`, `autoCompactPercent`, `ultracode`, hook events, permission-prompt tool, debug output, `fromPr`, MCP channels, prompt-cache settings and others) are tool parameters only and have no CLI flag. See [Tools Reference](./tools.md#session_start).

### session-send

```bash
clawo session-send <name> <message> [options]
clawo session-send <name> --message-file <file> [options]
```

| Flag                    | Description                                                                                                                                  |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `--message-file <file>` | Read the message from a file (long text, or text starting with `-`)                                                                          |
| `--effort <level>`      | Override effort for this message                                                                                                             |
| `--plan`                | Ask for a plan only: Claude Code and persistent custom engines get a plan-only instruction in front of the message; other engines ignore it  |
| `-s, --stream`          | Accepted, but has no effect: the server returns the reply when the turn ends, with no streamed chunks                                        |
| `-t, --timeout <ms>`    | Turn timeout (default 300000)                                                                                                                |
| `--json`                | Print the whole result as one line, including `ok`, `output`, `sessionId`, `error`, and `permissionDenials` / `images` when the turn had any |

`--plan` does not change the permission mode. For a session that cannot write, start it with `--permission-mode plan` (Claude Code, Grok) or the `sandboxMode: 'read-only'` tool parameter.

### session-stop

```bash
clawo session-stop <name>
```

Stops the session and removes it from the resume registry, so a later `session-start` with the same name begins a new conversation.

### session-list

```bash
clawo session-list
```

Lists the server's live sessions as `name — model (cwd)`. Sessions held only in the resume registry are not listed.

### session-status

```bash
clawo session-status <name> [--json]
```

Prints turns, tool calls, cost, tokens and uptime. `--json` prints the whole status as one line: `name`, `cwd`, `model`, `created`, `claudeSessionId` (the engine's resume id), `costUsd` (and `budgetUsd` / `budgetExhausted` when a spend cap is set), and `stats` with turns, `turnsSucceeded`, tool calls, tokens, `contextPercent`, uptime and the engine's own conversation id.

### session-grep

```bash
clawo session-grep <name> <pattern> [-n, --limit <n>]
```

Case-insensitive regular-expression search over the session's recent event history (`--limit` default 50). Prints the time and event type of each match.

### session-compact

```bash
clawo session-compact <name> [--summary <text>]
```

Compacts the conversation; `--summary` is passed to the engine's compaction (`/compact <summary>` on Claude Code). Engines without compaction do nothing — see [sessions.md](./sessions.md#context-management).

## Run Ledger

```bash
clawo runs [-s, --since <window>] [-n, --limit <n>] [--session <name>] [--engine <engine>] [--parent <id>] [--verified | --refuted] [--json]
```

Show the durable per-turn record kept at `~/.claw-orchestrator/runs/`. Unlike
`session-status`, this survives restarts and covers sessions this process never
owned. `--since` takes `30m` / `24h` / `7d` / `2w` or an ISO timestamp (default
`24h`); `--limit` caps the rows (default 50); `--parent` filters to one council /
fanout / autoloop / workflow run; `--verified` / `--refuted` keep only turns whose
acceptance contract passed / failed. Costs marked with a trailing `~` came from
estimated token counts. The `VERIFIED` column reads `yes`, `NO`, or `—` ("no
contract was declared, so nothing checked it"). `--json` prints `{ rows, summary }`.
See [observability.md](observability.md).

## Agents, Skills and Rules

```bash
clawo agents-list [-d, --cwd <dir>]
clawo agents-create <name> [-d, --cwd <dir>] [--description <desc>] [--prompt <prompt>]

clawo skills-list [-d, --cwd <dir>]
clawo skills-create <name> [-d, --cwd <dir>] [--description <desc>] [--prompt <prompt>] [--trigger <t>]

clawo rules-list [-d, --cwd <dir>]
clawo rules-create <name> [-d, --cwd <dir>] [--description <desc>] [--content <text>] [--paths <glob>] [--condition <expr>]
```

These manage Claude Code's `.claude/agents/`, `.claude/skills/` and `.claude/rules/` directories. With `-d`, the create commands write under `<dir>/.claude/`; without it, under the user-level `~/.claude/`. The list commands show the entries under `<dir>/.claude/` first, then the user-level entries whose name the project does not define. A rule's `--paths` and `--condition` become its `paths:` and `if:` frontmatter.

## Agent Teams

```bash
clawo session-team-list <name>
clawo session-team-send <name> <teammate> <message>
```

`session-team-list` lists the server's other live sessions as virtual teammates, with each one's engine, state and turn count. `session-team-send` delivers a message to one of them through the session inbox — at once if it is idle, queued otherwise. See [inbox.md](./inbox.md).

## `clawo solve`

Start the built-in `solve` workflow — triage → implement → verify → repair until
green — and let the runtime decide whether it worked.

```bash
clawo solve "<task>" [--engine <engine[:model]>] [--check "<command>"]... [--contract <file>]
            [--scouts <list>] [--reviewers <list>] [--max-repairs N] [--human-gate]
            [--cwd <dir>] [--wait] [--json]
```

| Option          | Default           | Notes                                                                                                                                        |
| --------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `-e, --engine`  | `claude`          | The implementer, `engine` or `engine:model` (`codex:gpt-6.1-sol`), or `acp:<preset>` for an ACP agent (`acp:kimi-code`)                      |
| `-c, --check`   | —                 | A command check, repeatable. Split on whitespace and run as argv, never through a shell; anything that needs quoting belongs in `--contract` |
| `--contract`    | —                 | A contract JSON file ([verification.md](./verification.md)); `--check` entries are appended to it                                            |
| `--scouts`      | the implementer   | Comma-separated triage agents, `engine[:model]` each (`acp:<preset>` for an ACP agent)                                                       |
| `--reviewers`   | —                 | Comma-separated reviewers of the finished change                                                                                             |
| `--max-repairs` | `3`               | Attempts the router allows while the checks are red; `0` keeps only the first attempt                                                        |
| `--human-gate`  | off               | Park before anything is written until `clawo workflow approve`                                                                               |
| `--cwd`         | current directory | Project directory                                                                                                                            |
| `-w, --wait`    | off               | Follow the run, printing each node transition, then the verdict                                                                              |
| `--json`        | off               | Print `{ runId, state }`, or with `--wait` the final run record                                                                              |

With `--wait` the exit code is the verdict: `0` when the run completed (verified,
or unverified because no check was given), `1` when it was refuted, failed or
cancelled. Unknown engine names are refused before anything starts.

## `clawo fanout`

Ask several engines the same thing in parallel, optionally merging the answers.

```bash
clawo fanout "<task>" [--engines <list>] [--synthesize] [--check "<command>"]...
             [--contract <file>] [--cwd <dir>] [--wait] [--json]
```

| Option             | Default           | Notes                                                                                                          |
| ------------------ | ----------------- | -------------------------------------------------------------------------------------------------------------- |
| `-e, --engines`    | `claude,codex`    | Comma-separated agents, `engine[:model]` each, or `acp:<preset>` for an ACP agent; an engine may repeat        |
| `-s, --synthesize` | off               | Merge the answers in a final pass. It runs only when at least two agents answered                              |
| `-c, --check`      | —                 | A command check, repeatable, run after the fan-out, as for `solve`                                             |
| `--contract`       | —                 | A contract JSON file; `--check` entries are appended to it                                                     |
| `--cwd`            | current directory | Project directory                                                                                              |
| `-w, --wait`       | off               | Follow the run to the end, then print every answer under a `## <agent>` heading — or the synthesis, if one ran |
| `--json`           | off               | Print `{ runId, state }`, or with `--wait` the final run record                                                |

## `clawo goal`

Run a Codex `/goal` on one `codex-app` thread, then have the runtime check the
result: goal → verify → repair on the same thread. See [workflow.md](./workflow.md#goal).

```bash
clawo goal "<objective>" | --objective-file <file>
           [--check "<command>"]... [--contract <file>] [--check-timeout <minutes>]
           [--launcher <arg>]... [--model <model>] [--effort <level>] [--sandbox <mode>] [--thread <id>]
           [--token-budget N] [--goal-timeout <minutes>] [--max-repairs N]
           [--cwd <dir>] [--wait] [--json]
```

| Option             | Default           | Notes                                                                                                               |
| ------------------ | ----------------- | ------------------------------------------------------------------------------------------------------------------- |
| `--objective-file` | —                 | Read the objective from a file instead of the argument. Codex accepts at most 4,000 characters                      |
| `-c, --check`      | —                 | A command check, repeatable, run after the goal. Split on whitespace; quote-needing commands go in `--contract`     |
| `--contract`       | —                 | A contract JSON file; `--check` entries are appended to it                                                          |
| `--check-timeout`  | 10                | Minutes for each `--check` (at least 1). The verifier's node timeout is sized from the checks                       |
| `--launcher`       | —                 | Run codex under this command, one argv element per flag: `--launcher ./sandbox.sh --launcher task --launcher "0 1"` |
| `-m, --model`      | codex's own       | Codex model                                                                                                         |
| `--effort`         | codex's own       | Codex reasoning effort                                                                                              |
| `--sandbox`        | `workspace-write` | Codex's own sandbox mode. With an outer sandbox as the boundary, `danger-full-access`                               |
| `--thread`         | —                 | Start on this existing codex thread: its goal is replaced, its history kept                                         |
| `--token-budget`   | —                 | The goal stops as `budgetLimited` past this                                                                         |
| `--goal-timeout`   | none              | Wall-clock minutes for one goal pass                                                                                |
| `--max-repairs`    | `1`               | Times a red verdict sends the goal back to the same thread                                                          |
| `--cwd`            | current directory | Project directory                                                                                                   |
| `-w, --wait`       | off               | Follow the run; exit `0` only if it completes                                                                       |
| `--json`           | off               | Print `{ runId, state }`, or with `--wait` the final run record                                                     |

`clawo workflow show <runId>` prints the goal's status, tokens, time, resume
attempts and thread id while it runs; `clawo workflow steer <runId> "<text>"`
goes into the running turn.

## `clawo workflow`

```bash
clawo workflow list [--state <s>] [--workflow <name>] [--limit N] [--json]
clawo workflow show <runId> [--json]
clawo workflow resume <runId>          # re-attach to a run whose process died
clawo workflow cancel <runId>
clawo workflow steer <runId> "<text>"  # a correction for the next agent node, or into a running goal
clawo workflow approve <runId> [reject]
```

`list` prints one row per run (default limit 25) with its outcome as `verified` /
`REFUTED` / `unchecked`. `unchecked` means no acceptance contract was declared — it
is not a failure.

`approve` answers the gate a run is parked on: it approves unless the last
argument is `reject`, `false` or `no`.

Runs survive restarts, so `list` sees runs started by other processes and by
earlier sessions.

## `clawo verify`

```bash
clawo verify <runId> [--evidence <id>] [--json]
```

Prints the evidence bundle (the run's latest unless `--evidence` names one):
per-check pass/fail with the failing command and the lines of its output that say
why (an assertion message, an error line — the last few lines when nothing stands
out), the base and head commits, and the files the run changed (created files
included).

## `clawo engines`

Lists the community engine presets bundled with the installed package (custom engines and ACP agents), with each
one's provenance — who attested it, against which engine version, on what date.
Read locally rather than over HTTP, since it is a property of the package and has
to work with no server running.

```bash
clawo engines
clawo engines --json
clawo session-start my-session -e custom --custom-engine <id>
clawo session-start my-session -e acp --acp-agent <id>     # an ACP agent preset
```

A preset id is the only form of custom engine or ACP agent the CLI can pass: it reaches the
session through the HTTP surface, which refuses inline configs because those name
a binary and its arguments. See [multi-engine.md](./multi-engine.md) for the tiers
and what a community preset does and does not claim.

## Tools Without a CLI Command

Tools without a CLI command are reachable through the OpenClaw plugin, the MCP
server (`clawo-mcp`, see [mcp.md](./mcp.md)), or the `SessionManager` API. See
[Tools Reference](./tools.md) for full parameter documentation.
