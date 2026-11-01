# Getting Started

## Installation

### Standalone CLI

```bash
npm install -g @enderfga/claw-orchestrator

# Start the embedded server (keeps running; use a second terminal for the commands below)
clawo serve

# Drive sessions from the command line
clawo session-start myproject -d ~/project
clawo session-send myproject "fix the auth bug"
clawo session-status myproject
clawo session-stop myproject
```

`clawo serve` listens on `127.0.0.1:18796` (`-p/--port`, `-H/--host`; `OPENCLAW_SERVER_HOST`
also sets the bind address) and prints the dashboard URL, `http://127.0.0.1:18796/dashboard`.
Apart from `clawo engines` and `clawo acp`, which run locally, the other `clawo` commands are
HTTP clients of that server: they read its address from `CLAWO_API_URL` (default
`http://127.0.0.1:18796`) and its token as described under
[Embedded Server Authentication](#embedded-server-authentication), and a request that fails or
cannot reach the server exits with status 1. `session-start -e <engine>` picks the engine
(default `claude`; `codex`, `codex-app`, `agy`, `grok`, `opencode`, `acp` with
`--acp-agent <id>`, `custom` with `--custom-engine <id>`);
`session-send --message-file <file>` sends a long message, and `--json` on `session-send` and
`session-status` prints the full result. See [cli.md](./cli.md) for every command.

`clawo serve` does not read the OpenClaw plugin configuration below; it allows 32 concurrent
sessions and reaps idle ones after 60 minutes (`OPENCLAW_SERVE_MAX_SESSIONS`,
`OPENCLAW_SERVE_TTL_MINUTES`).

### As OpenClaw Plugin

```bash
openclaw plugins install @enderfga/claw-orchestrator --dangerously-force-unsafe-install
openclaw gateway restart
```

> **Why `--dangerously-force-unsafe-install`?** Claw Orchestrator spawns Claude Code / Codex / Antigravity / Grok Build / OpenCode / ACP agent subprocesses via `child_process`, which OpenClaw's security scanner flags by design. The flag is required — there is no way to drive coding CLIs without process spawning.

Agents automatically get access to all session, council, and management tools. The plugin starts
the same embedded HTTP server on the first tool call (set `CLAWO_NO_EMBEDDED_SERVER=1` to skip
it), so the `clawo` CLI and the dashboard work against a running plugin too.

### TypeScript Library

```typescript
import { SessionManager } from '@enderfga/claw-orchestrator';

const manager = new SessionManager({ defaultModel: 'claude-sonnet-5-5' });

const session = await manager.startSession({
  name: 'backend-fix',
  cwd: '/path/to/project',
  permissionMode: 'acceptEdits',
});

const result = await manager.sendMessage('backend-fix', 'Fix the failing tests');
console.log(result.output);

await manager.stopSession('backend-fix');
```

## Requirements

- **Node.js >= 22**
- **Claude Code CLI >= 2.1.259** — `npm install -g @anthropic-ai/claude-code`. A session with no permission-prompt tool passes `--permission-prompts none`, which 2.1.259 added
- **OpenClaw >= 2026.3.0** — for plugin mode (optional)
- **OpenAI Codex CLI** — `npm install -g @openai/codex` (optional). The `codex` engine needs >= 0.119 for `codex exec resume`, which every send after the first uses. The `codex-app` engine and its goal RPCs are tested with 0.164.0
- **Antigravity CLI** — `curl -fsSL https://antigravity.google/cli/install.sh | bash` (optional, for the `agy` engine — Google's successor to the sunset Gemini CLI)
- **Grok Build CLI** — see `x.ai/cli` (optional, for the `grok` engine)
- **OpenCode CLI 1.x** — `npm install -g opencode-ai` (optional, for the `opencode` engine). OpenCode 2 (the `@opencode/cli` package) is refused at session start
- **An ACP agent** — optional, for the `acp` engine: any agent that serves the Agent Client Protocol on stdio, such as Kimi Code (`kimi acp`), dsh (`dsh --profile acp`) or `opencode acp`

Tested versions of each engine are in the [README](../../README.md#engine-compatibility).

### Engine Authentication

Each engine requires its own authentication before use:

- **Claude Code** — run `claude /login` or set `ANTHROPIC_API_KEY`
- **Codex** — run `codex login` or set `OPENAI_API_KEY`
- **Antigravity** — run `agy` once and complete the Google OAuth login
- **Grok** — run `grok` once and sign in (grok.com account or `XAI_API_KEY`)
- **OpenCode** — run `opencode auth login`, or set a provider key such as `ANTHROPIC_API_KEY`
- **ACP agents** — the agent's own login or environment (for example `KIMI_MODEL_*` for Kimi Code, `DEEPSEEK_API_KEY` for dsh); see [Multi-Engine](./multi-engine.md#acp-agents-engine-acp)

The plugin does not manage authentication — it expects each CLI to be ready to run.

### Embedded Server Authentication

Authentication on the embedded HTTP server (used by the CLI and standalone mode) is on by default:

| Variable                | Purpose                                                                                                                       |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `OPENCLAW_SERVER_TOKEN` | Unset: a random token is generated. Set to a value: use that token. Set to `disabled`: turn auth off (single-user hosts only) |

On start the server writes the token to `~/.openclaw/server-token` (mode 0600) and reuses it across restarts; delete the file and restart the server to rotate it. Every request except `/health` must carry it as `Authorization: Bearer <token>`, the `clawo_auth` cookie, or a `?token=` query parameter. Browsers sign in once via `/login?token=<token>&redirect=/dashboard`, which sets the cookie and redirects, so the token does not stay in the address bar.

The CLI finds the token on its own: `CLAWO_AUTH_TOKEN`, then `OPENCLAW_SERVER_TOKEN`, then the token file.

### OpenAI-Compatible Endpoint

The server exposes an OpenAI-compatible API at `/v1/chat/completions`. It serves both kinds of clients as first-class citizens:

- **Upstream agents** (OpenClaw main loop, cron, subagents) that maintain their own transcript and only forward the latest user turn — uses default mode.
- **Webchat / labeling tools** (ChatGPT-Next-Web, Open WebUI, LobeChat) that re-send the full transcript every turn — set `OPENAI_COMPAT_NEW_CONVO_HEURISTIC=1`.

Quick config for any client:

| Setting      | Value                                                                                  |
| ------------ | -------------------------------------------------------------------------------------- |
| API Base URL | `http://127.0.0.1:18796/v1`                                                            |
| API Key      | The server token (from `~/.openclaw/server-token`), or any string if auth is disabled  |
| Model        | `claude-fable-5-1`, `claude-opus-5-5`, `claude-sonnet-5-5`, `gpt-5.5`, `agy-pro`, etc. |

See [openai-compat.md](./openai-compat.md) for the full session-keying rules, `X-Session-Reset` semantics, the legacy-heuristic env var, and the `/v1/sessions` inspection endpoint.

## Configuration

In plugin mode, in `~/.openclaw/openclaw.json`:

```jsonc
{
  "plugins": {
    "entries": {
      "claw-orchestrator": {
        "enabled": true,
        "config": {
          "claudeBin": "claude",
          "defaultPermissionMode": "acceptEdits",
          "defaultEffort": "auto",
          "maxConcurrentSessions": 5,
          "sessionTtlMinutes": 120,
        },
      },
    },
  },
}
```

| Key                     | Default       | Meaning                                                                                                                                                                                      |
| ----------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `claudeBin`             | `claude`      | Claude Code binary                                                                                                                                                                           |
| `defaultModel`          | unset         | Model for a session that names none, on an engine that runs that model; the claude engine takes any model. Other engines, and every engine when it is unset, run their own default           |
| `defaultPermissionMode` | `acceptEdits` | Permission mode for a session that names none                                                                                                                                                |
| `defaultEffort`         | `auto`        | Effort for a session that names none                                                                                                                                                         |
| `maxConcurrentSessions` | `5`           | Most sessions open at once; a start beyond it is refused                                                                                                                                     |
| `sessionTtlMinutes`     | `120`         | Idle sessions are stopped after this long                                                                                                                                                    |
| `pricingOverrides`      | none          | Per-model rates, USD per 1M tokens: `{"gpt-5.5": {"input": 0, "output": 0, "cached": 0}}` for a flat-rate plan. See [Zeroing a model's pricing](./observability.md#zeroing-a-models-pricing) |
| `proxy.enabled`         | on            | `false` stops the plugin from registering the multi-model proxy routes on the OpenClaw gateway                                                                                               |

## Next Steps

- [Sessions](./sessions.md) — persistent session lifecycle and management
- [Session Inbox](./inbox.md) — cross-session messaging
- [Multi-Engine](./multi-engine.md) — one interface over Claude Code, Codex, Antigravity, Grok Build, OpenCode, ACP agents and custom CLIs
- [Council](./council.md) — multi-agent collaboration with consensus voting
- [Ultraplan & Ultrareview](./ultra.md) — deep planning and fleet code review
- [Workflows](./workflow.md) — durable runs and the `solve`, `council`, `fanout` and `goal` templates
- [Verification](./verification.md) — acceptance contracts the runtime checks itself
- [Observability](./observability.md) — the run ledger and spend caps
- [Dashboard](./dashboard.md) — the browser UI served at `/dashboard`
- [Tools Reference](./tools.md) — complete tool API reference (79 tools)
- [CLI Reference](./cli.md) — command-line interface
- [MCP Server](./mcp.md) — expose the tools to any MCP host
- [ACP Agent](./acp.md) — run the orchestrator as an Agent Client Protocol agent
