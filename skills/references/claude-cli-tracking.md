# Claude Code CLI Feature Tracking

This document tracks which Claude Code CLI version Claw Orchestrator is currently synced to, and which features have been integrated.

## Currently tracked: **Claude Code CLI 2.1.150** (as of 2026-05-24, plugin v4.1.1)

## Sync history

| Plugin Version | Claude CLI Version | Date | Notable integrations |
| v4.1.1 | 2.1.150 | 2026-05-24 | **No Claude wrapper change** — 2.1.141–2.1.150 are almost entirely TUI / agent-view / security / visual; 2.1.150 itself is "internal infrastructure only". The one scripting-adjacent addition, `claude agents --json` (2.1.145), lists *CLI-managed* sessions and is not used by our own session manager. This release's real engine work was on Codex/Gemini: Codex `--output-schema` wired into `jsonSchema` (Codex 0.132+), Gemini `--skip-trust` for the 0.43 trusted-folders gate. Bumped tested versions Claude 2.1.150 / Codex 0.133.0 / Gemini 0.43.0. |
|---|---|---|---|
| v4.1.0 | 2.1.140 | 2026-05-13 | `claude_goal_set` / `claude_goal_clear` / `claude_goal_status` tools (wrap CLI 2.1.139 `/goal` slash command), `plugin_details` tool (wraps `claude plugin details`, 2.1.139), `pluginUrl` config (maps to `--plugin-url`, 2.1.129). Skipped items that are user-controlled via `--settings` (worktree.baseRef, autoMode.hard_deny, skillOverrides, sandbox.bwrapPath / socatPath, parentSettingsBehavior) or auto-set by the CLI (`CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN`, `CLAUDE_CODE_FORCE_SYNC_OUTPUT` — all TTY-only). Hook `args: string[]`, `continueOnBlock`, hook input `effort.level`, subagent `x-claude-code-agent-id` headers are CLI-internal — no wrapper change needed. |
| v2.14.2 | 2.1.126 | 2026-05-04 | `bedrockServiceTier` (Bedrock service-tier env, 2.1.122), `project_purge` tool (wraps `claude project purge`, 2.1.126); skipped passive-only items (OTel numeric attr, `invocation_trigger`, `/v1/models` gateway discovery, PowerShell shell changes) |
| v2.14.0 | 2.1.121 | 2026-04-28 | `forkSubagent` (fork subagent env), `enableToolSearch` (Vertex AI tool search env), `otelLogUserPrompts` / `otelLogRawApiBodies` (OTEL logging toggles), `xhigh` effort level (Opus 4.7), `stats.pluginErrors` capture from `system/init` |
| v2.13.0 | 2.1.111 | 2026-04-16 | Hook events, permission delegation, prompt cache optimization (exclude-dynamic-sections + 1H cache), debug control, `--from-pr`, MCP channels, `system/api_retry` event tracking |
| v2.12.2 and earlier | 2.1.91 | — | Bare mode, worktree, json-schema, mcp-config, betas, fallback-model, effort, agent teams |

## How to update this

When syncing to a new Claude Code CLI version:

1. Run `claude --version` to confirm target version
2. Check Claude Code changelog / release notes for new flags, events, env vars since the last tracked version
3. Decide which features are valuable for programmatic/agent use (vs human-interactive only)
4. Implement worthwhile features (add to `SessionConfig` → wire into `persistent-session.ts` → expose in tool schema → document)
5. Update this file with the new version + notable integrations
6. Update `CLAUDE.md` and `README.md` engine compatibility tables
