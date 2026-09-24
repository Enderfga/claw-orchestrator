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
clawo session-stop myproject
```

### As OpenClaw Plugin

```bash
openclaw plugins install @enderfga/claw-orchestrator --dangerously-force-unsafe-install
openclaw gateway restart
```

> **Why `--dangerously-force-unsafe-install`?** Claw Orchestrator spawns Claude Code / Codex / Antigravity / Grok Build / OpenCode CLI subprocesses via `child_process`, which OpenClaw's security scanner flags by design. The flag is required — there is no way to drive coding CLIs without process spawning.

Agents automatically get access to all session, council, and management tools.

### TypeScript Library

```typescript
import { SessionManager } from '@enderfga/claw-orchestrator';

const manager = new SessionManager({ defaultModel: 'claude-sonnet-5' });

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
- **Claude Code CLI >= 2.1** — `npm install -g @anthropic-ai/claude-code`
- **OpenClaw >= 2026.3.0** — for plugin mode (optional)
- **OpenAI Codex CLI >= 0.112** — `npm install -g @openai/codex` (optional, for codex engine)
- **Antigravity CLI** — `curl -fsSL https://antigravity.google/cli/install.sh | bash` (optional, for the `agy` engine — Google's successor to the sunset Gemini CLI)
- **Grok Build CLI** — optional, for the `grok` engine
- **OpenCode CLI** — `npm install -g opencode-ai` (optional, for the `opencode` engine)

### Engine Authentication

Each engine requires its own authentication before use:

- **Claude Code** — run `claude /login` or set `ANTHROPIC_API_KEY`
- **Codex** — run `codex login` or set `OPENAI_API_KEY`
- **Antigravity** — run `agy` once and complete the Google OAuth login
- **Grok** — run `grok` once and sign in (grok.com account or `XAI_API_KEY`)
- **OpenCode** — run `opencode auth login`, or set a provider key such as `ANTHROPIC_API_KEY`

The plugin does not manage authentication — it expects each CLI to be ready to run.

### Embedded Server Authentication

Authentication on the embedded HTTP server (used by the CLI and standalone mode) is on by default:

| Variable                | Purpose                                                                                                                       |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `OPENCLAW_SERVER_TOKEN` | Unset: a random token is generated. Set to a value: use that token. Set to `disabled`: turn auth off (single-user hosts only) |

On start the server writes the token to `~/.openclaw/server-token` (mode 0600) and reuses it across restarts; the CLI reads it automatically. Every request except `/health` must carry it as `Authorization: Bearer <token>` or the `clawo_auth` cookie. Browsers sign in once via `/login?token=<token>&redirect=/dashboard`, which sets the cookie.

### OpenAI-Compatible Endpoint

The server exposes an OpenAI-compatible API at `/v1/chat/completions`. It serves both kinds of clients as first-class citizens:

- **Upstream agents** (OpenClaw main loop, cron, subagents) that maintain their own transcript and only forward the latest user turn — uses default mode.
- **Webchat / labeling tools** (ChatGPT-Next-Web, Open WebUI, LobeChat) that re-send the full transcript every turn — set `OPENAI_COMPAT_NEW_CONVO_HEURISTIC=1`.

Quick config for any client:

| Setting      | Value                                                                                 |
| ------------ | ------------------------------------------------------------------------------------- |
| API Base URL | `http://127.0.0.1:18796/v1`                                                           |
| API Key      | The server token (from `~/.openclaw/server-token`), or any string if auth is disabled |
| Model        | `claude-fable-5-1`, `claude-opus-5-5`, `claude-sonnet-5`, `gpt-5.5`, `agy-pro`, etc.  |

See [openai-compat.md](./openai-compat.md) for the full session-keying rules, `X-Session-Reset` semantics, the legacy-heuristic env var, and the `/v1/sessions` inspection endpoint.

## Configuration

In `~/.openclaw/openclaw.json`:

```jsonc
{
  "plugins": {
    "entries": {
      "claw-orchestrator": {
        "enabled": true,
        "config": {
          "claudeBin": "claude",
          "defaultModel": "claude-opus-5-5",
          "defaultPermissionMode": "acceptEdits",
          "defaultEffort": "auto",
          "maxConcurrentSessions": 5,
          "sessionTtlMinutes": 120,
          "proxy": {
            "enabled": false,
            "bigModel": "gemini-3.1-pro-preview",
            "smallModel": "gemini-3-flash-preview",
          },
        },
      },
    },
  },
}
```

## Next Steps

- [Sessions](./sessions.md) — persistent session lifecycle and management
- [Session Inbox](./inbox.md) — cross-session messaging
- [Multi-Engine](./multi-engine.md) — one interface over Claude Code, Codex, Antigravity, Grok Build, OpenCode and custom CLIs
- [Council](./council.md) — multi-agent collaboration with consensus voting
- [Ultraplan & Ultrareview](./ultra.md) — deep planning and fleet code review
- [Tools Reference](./tools.md) — complete tool API reference (78 tools)
- [CLI Reference](./cli.md) — command-line interface
- [MCP Server](./mcp.md) — expose the tools to any MCP host
- [ACP Agent](./acp.md) — run the orchestrator as an Agent Client Protocol agent
