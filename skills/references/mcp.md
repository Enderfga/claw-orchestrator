# MCP integration

Claw Orchestrator ships a Model Context Protocol (MCP) server (`clawo-mcp`) so any MCP-compatible host can drive its 55 tools.

This document covers:

- [How it works](#how-it-works)
- [Host configuration](#host-configuration)
  - [Hermes Agent](#hermes-agent)
  - [Claude Desktop / Claude Code](#claude-desktop--claude-code)
  - [Cursor](#cursor)
  - [Cline (VS Code)](#cline-vs-code)
  - [Continue](#continue)
  - [Zed](#zed)
  - [Windsurf](#windsurf)
  - [Goose](#goose)
  - [Any other MCP host](#any-other-mcp-host)
- [Environment variables](#environment-variables)
- [Tool filtering](#tool-filtering)
- [Tool annotations](#tool-annotations)
- [Troubleshooting](#troubleshooting)
- [MCP vs OpenClaw plugin: when to use which](#mcp-vs-openclaw-plugin-when-to-use-which)

---

## How it works

`clawo-mcp` is a thin stdio MCP server. It reuses the same tool definitions registered by the OpenClaw plugin entry point (`src/index.ts`), so there is exactly one source of truth and zero schema drift between the OpenClaw plugin form and the MCP server form.

Tools fall into a few groups:

| Group | Examples |
|---|---|
| Session lifecycle | `session_start`, `session_send`, `session_stop`, `session_list`, `session_grep`, `session_compact`, `session_update_tools`, `session_switch_model` |
| Cross-session messaging | `session_send_to`, `session_inbox`, `session_deliver_inbox` |
| Status / introspection | `sessions_overview`, `coding_session_status`, `coding_agents_list` |
| Multi-agent council | `council_start`, `council_status`, `council_abort`, `council_inject`, `council_review`, `council_accept`, `council_reject` |
| Ultraplan / ultrareview | `ultraplan_start`, `ultraplan_status`, `ultrareview_start`, `ultrareview_status` |
| Autoloop | `autoloop_start`, `autoloop_chat`, `autoloop_status`, `autoloop_list`, `autoloop_reset_agent`, `autoloop_stop` |
| Codex specifics | `codex_resume`, `codex_review`, `codex_goal_set`, `codex_goal_get`, `codex_goal_pause`, `codex_goal_resume`, `codex_goal_clear` |
| Agent teams | `team_list`, `team_send` |
| Maintenance | `project_purge` |

Full per-tool parameter documentation lives in [`tools.md`](./tools.md).

Install once:

```bash
npm install -g @enderfga/claw-orchestrator
# `clawo-mcp` is on PATH; the OpenClaw `clawo` CLI is also installed
```

When invoked, `clawo-mcp`:

1. Sets `CLAWO_NO_EMBEDDED_SERVER=1` so the orchestrator does not bind its HTTP control plane (port 18796) — MCP-only deployments do not need it.
2. Captures the plugin's registered tools via an in-memory shim.
3. Speaks MCP over stdio. All log lines go to stderr; stdout is reserved for the protocol.

---

## Host configuration

### Hermes Agent

Add to `~/.hermes/config.yaml`:

```yaml
mcp_servers:
  clawo:
    command: clawo-mcp
    env:
      ANTHROPIC_API_KEY: "..."
      OPENAI_API_KEY: "..."
      GEMINI_API_KEY: "..."
    tools:
      include:
        - mcp_clawo_session_start
        - mcp_clawo_session_send
        - mcp_clawo_session_stop
        - mcp_clawo_council_start
        - mcp_clawo_council_status
        - mcp_clawo_council_review
```

Reload without restarting:

```text
/reload-mcp
```

Hermes prefixes tool names with `mcp_<server>_`. The model sees the prefixed names; you do not call them manually.

### Claude Desktop / Claude Code

`~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "clawo": {
      "command": "clawo-mcp",
      "env": {
        "ANTHROPIC_API_KEY": "...",
        "OPENAI_API_KEY": "...",
        "CLAWO_MCP_TOOLS": "session_start,session_send,council_start,council_status"
      }
    }
  }
}
```

For Claude Code (`~/.claude.json` or per-project `.mcp.json`), use the same shape under `mcpServers`.

### Cursor

In Cursor settings → MCP, add a server. The config file is `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "clawo": {
      "command": "clawo-mcp",
      "env": { "ANTHROPIC_API_KEY": "...", "OPENAI_API_KEY": "..." }
    }
  }
}
```

### Cline (VS Code)

VS Code command palette → `Cline: Open MCP Settings`. Add:

```json
{
  "mcpServers": {
    "clawo": {
      "command": "clawo-mcp",
      "env": { "ANTHROPIC_API_KEY": "...", "OPENAI_API_KEY": "..." }
    }
  }
}
```

### Continue

`~/.continue/config.yaml`:

```yaml
mcpServers:
  - name: clawo
    command: clawo-mcp
    env:
      ANTHROPIC_API_KEY: "..."
      OPENAI_API_KEY: "..."
```

### Zed

`~/.config/zed/settings.json` under `context_servers`:

```json
{
  "context_servers": {
    "clawo": {
      "command": { "path": "clawo-mcp", "env": { "ANTHROPIC_API_KEY": "..." } }
    }
  }
}
```

### Windsurf

`~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "clawo": {
      "command": "clawo-mcp",
      "env": { "ANTHROPIC_API_KEY": "..." }
    }
  }
}
```

### Goose

`~/.config/goose/config.yaml`:

```yaml
extensions:
  clawo:
    type: stdio
    cmd: clawo-mcp
    envs:
      ANTHROPIC_API_KEY: "..."
```

### Any other MCP host

Anything that speaks stdio MCP will work. The minimum shape is:

```text
command: clawo-mcp
env:
  ANTHROPIC_API_KEY: "..."
```

Check your host's MCP docs for the exact key names (`command`/`cmd`, `env`/`envs`, `args`/`arguments`).

---

## Environment variables

Hosts deliberately do not forward your full shell environment to MCP subprocesses. Pass every variable your engines need explicitly under the host's `env` block.

| Variable | Used by |
|---|---|
| `ANTHROPIC_API_KEY` | Claude Code engine |
| `OPENAI_API_KEY` | Codex engine |
| `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) | Gemini engine |
| `GATEWAY_URL`, `GATEWAY_KEY` | Routing through an OpenClaw / Anthropic-style gateway |
| `CLAWO_MCP_TOOLS` | Comma-separated allowlist of tool names; unlisted tools are not advertised |
| `CLAWO_NO_EMBEDDED_SERVER` | Suppresses port 18796 binding. `clawo-mcp` sets this automatically |

The engines themselves (`claude`, `codex`, `gemini`, `agy`, `agent`, `opencode`) must also be installed and authenticated on the host machine — `clawo-mcp` spawns them as subprocesses, it does not bundle them.

---

## Tool filtering

55 tools is a lot for a small context window. Reduce noise either at the host level (most hosts have an `include` / `exclude` filter — see Hermes example above) or at the server level via `CLAWO_MCP_TOOLS`:

```bash
CLAWO_MCP_TOOLS="session_start,session_send,session_stop,council_start,council_status" clawo-mcp
```

Both are valid; host-level filtering keeps the config in one place, server-level filtering hides tools before the host even sees them.

A reasonable minimum set for "let the model drive a single Claude Code session":

- `session_start`, `session_send`, `session_stop`, `session_list`, `coding_session_status`

For "let the model run councils and review work":

- `council_start`, `council_status`, `council_review`, `council_accept`, `council_reject`

For "let the model commission an ultrareview before merging":

- `ultrareview_start`, `ultrareview_status`

---

## Tool annotations

`clawo-mcp` advertises [tool annotations](https://modelcontextprotocol.io/specification/server/tools#annotations) so hosts can prefer safer tools when reasoning:

| Annotation | Tools |
|---|---|
| `readOnlyHint` + `idempotentHint` | `session_list`, `sessions_overview`, `coding_session_status`, `session_grep`, `session_inbox`, `coding_agents_list`, `team_list`, `council_status`, `council_review`, `ultraplan_status`, `ultrareview_status`, `autoloop_status`, `autoloop_list`, `codex_goal_get` |
| `destructiveHint` | `session_stop`, `council_abort`, `council_accept`, `council_reject`, `autoloop_stop`, `project_purge` |
| `openWorldHint` | All tools that make outbound model API calls (most session / council / ultraplan / autoloop tools) |

---

## Troubleshooting

**The host shows no tools after restart**
- Confirm `clawo-mcp` resolves on PATH: `which clawo-mcp`. If you used a non-global install, use the absolute path in `command`.
- Confirm the host logs (Hermes: `~/.hermes/logs/`, Claude Desktop: View → Open Logs Folder). Look for the `[clawo-mcp]` lines.

**Engine starts but fails with `command not found`**
- The underlying coding CLI (`claude`, `codex`, `gemini`, etc.) is not on PATH in the host's subprocess environment. Either install globally or set `claudeBin` / `codexBin` etc. via `customEngine.bin` per session, or pass an explicit `PATH` in the host's `env` block.

**`401` / `auth` errors from a session**
- The corresponding API key is missing from the `env` block. Hosts do not inherit your shell environment.

**Tool list comes back empty**
- `CLAWO_MCP_TOOLS` filter is set to names that don't exist. Drop it and check `tools/list` again, then add back the correct names. Stderr will print a warning.

**Port 18796 in use error**
- `clawo-mcp` does not bind it; this is only reachable via the OpenClaw plugin path or `clawo serve`. If you see this, something else (a stale `clawo` or an OpenClaw gateway) is running. `lsof -i :18796`.

---

## MCP vs OpenClaw plugin: when to use which

| Use case | Recommended form |
|---|---|
| You already run OpenClaw and want the tools available to every OpenClaw agent | OpenClaw plugin |
| You want to drive coding agents from Hermes Agent, Claude Desktop, Cursor, Cline, Continue, Zed, Windsurf, Goose, or another MCP host | MCP server |
| You want to call the orchestrator from a non-MCP custom runtime (Python, Go, …) | Standalone `clawo serve` HTTP API |

The same package supports all three — they share the SessionManager and tool definitions. Pick whichever entry point matches your host.
