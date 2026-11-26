---
name: claw-orchestrator
description: 'Ask Codex, Gemini, Grok or Claude: second opinions, multi-model reviews, background agents, unattended goals. Run and coordinate coding agents on any engine — Claude Code, Codex, Antigravity (Gemini), Grok, Cursor, OpenCode, ACP agents — from one CLI or MCP server. Use whenever a task is better done by another model, or by more than one: a second opinion or part of the work from Codex, Gemini or Grok; several engines reviewing, analysing, comparing or brainstorming the same thing in parallel (clawo fanout); a coding task handed to a background agent and checked on later; an agent kept working unattended for hours until an objective is met and checked, through usage limits and crashes (clawo goal); a fix or a speed-up proven by checks the agent cannot edit — tests, or a benchmark measured against the commit it started from (clawo solve, acceptance contracts, metric checks, clawo verify); several agents editing one repo in their own worktrees until they agree (council); a careful plan before a big change, or a multi-reviewer code review (ultraplan, ultrareview); an autonomous plan, code and review loop toward a goal (autoloop); a web app built from a short interview (ultraapp); a conversation moved to another engine when one hits its limit (session_handoff); Claude account rotation; cost tracking and spend caps across engines, and which model succeeds more often and at what cost across runs (clawo runs --by model); serving it all to editors over MCP or ACP.'
metadata:
  {
    'openclaw':
      {
        'emoji': '🤖',
        'requires': { 'anyBins': ['claude', 'codex', 'agy', 'grok', 'opencode'] },
        'install':
          [
            {
              'id': 'npm-plugin',
              'kind': 'node',
              'package': '@enderfga/claw-orchestrator',
              'label': 'Install plugin (npm)',
            },
            {
              'id': 'node-claude',
              'kind': 'node',
              'package': '@anthropic-ai/claude-code',
              'bins': ['claude'],
              'label': 'Install Claude Code CLI',
            },
            {
              'id': 'node-codex',
              'kind': 'node',
              'package': '@openai/codex',
              'bins': ['codex'],
              'label': 'Install Codex CLI',
            },
          ],
      },
  }
---

# Claw Orchestrator Skill

Claw Orchestrator — persistent multi-engine coding session manager for claw-style agent systems. Runs as a standalone CLI/server, with first-class OpenClaw plugin support. Wraps Claude Code, Codex, Antigravity, Grok Build, Cursor, OpenCode, any Agent Client Protocol agent, and custom CLIs into headless agentic engines with 81 tools.

## Pick by task

The `clawo` commands talk to `clawo serve` (`127.0.0.1:18796`); start it once if `clawo session-list` cannot reach
it: `nohup clawo serve >/dev/null 2>&1 &`. They work from any shell, so no MCP tool needs loading first, and
`clawo tool <name> '<json>'` calls any of the tools below by name (`clawo tool` lists them). The MCP tools
(`mcp__clawo__*` in Claude Code, often deferred: load them with ToolSearch) are the same tools. A command with
`--wait` returns when the work is done, so run it as a background command and its exit is the completion notice.

| When the task is…                                                                          | From a shell                                                                                                                                                                                                        | MCP tool                               |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| A second opinion, or a piece of the work, from another model                               | `clawo fanout "<question>" -e codex:gpt-6.2-sol --sandbox read-only --wait` (one agent)                                                                                                                             | `fanout_start`                         |
| Several engines on the same review, analysis or comparison                                 | `clawo fanout "<task>" -e codex:…,agy:…,claude:… --sandbox read-only --synthesize --wait` ([below](#several-engines-on-one-task))                                                                                   | `fanout_start`                         |
| A coding task handed to a background agent, followed up later in the same conversation     | `clawo session-start w --agy -d <dir>`, then `clawo session-send w "<task>" -t 3600000`                                                                                                                             | `session_start`, `session_send`        |
| Keep an agent working until an objective is met and checked — hours, unattended            | `clawo goal "<objective>" --codex --check "<command>" --wait` (any engine; [workflow.md](references/workflow.md#goal))                                                                                              | `workflow_start` (`template: goal`)    |
| A fix proven by checks the agent cannot edit                                               | `clawo solve "<task>" --check "npm test" --wait`, then `clawo verify <runId>`                                                                                                                                       | `workflow_start`, `verify_run`         |
| A change proven faster, smaller or more accurate than before, by measurement               | `clawo solve "<task>" --contract metric.json --isolate --wait`: a `metric` check runs the benchmark on the result and on the base commit ([verification.md](references/verification.md#metric-and-the-base-commit)) |
| Several agents editing one repo, each in its own worktree, until they agree                | `clawo tool council_start '{"task":"…","projectDir":"…","agents":[…]}'` ([council.md](references/council.md))                                                                                                       | `council_start`                        |
| A careful plan before a big change; a multi-reviewer review of a branch or PR              | `clawo tool ultraplan_start '{…}'`, `clawo tool ultrareview_start '{"cwd":"…","engines":["claude","codex"]}'`                                                                                                       | `ultraplan_start`, `ultrareview_start` |
| An autonomous plan → code → review loop on a workspace toward a goal                       | `clawo tool autoloop_start '{…}'` ([autoloop.md](references/autoloop.md))                                                                                                                                           | `autoloop_start`                       |
| A small web app from a short interview, built and deployed                                 | `clawo tool ultraapp_new '{…}'` ([ultraapp.md](references/ultraapp.md))                                                                                                                                             | `ultraapp_new`                         |
| Continue a conversation on another engine (a usage limit, a better model)                  | `clawo tool session_handoff '{"name":"fix","engine":"codex"}'`                                                                                                                                                      | `session_handoff`                      |
| What the agents cost; a spend cap for a session or a whole run                             | `clawo runs --since 24h`; `--max-budget <usd>` on any session, and on `solve`, `goal`, `fanout` for the whole run                                                                                                   |
| Which model succeeds more often, and at what cost, across runs                             | `clawo runs --by model` (verified rate, cost per verified run) ([observability.md](references/observability.md#one-row-per-workflow-run))                                                                           |
| A pipeline of your own that survives restarts: agents, goals, verifier, router, human gate | `clawo workflow list / show / resume` ([workflow.md](references/workflow.md))                                                                                                                                       | `workflow_start`                       |
| Claude Code under several accounts, moving on at a usage limit                             | `--claude-account auto` on `session-start`                                                                                                                                                                          | `session_start` (`claudeAccount`)      |
| clawo inside an editor or another agent host                                               | `clawo-mcp` (MCP server), `clawo acp` (ACP agent)                                                                                                                                                                   | —                                      |

Any engine is picked the same way everywhere: `--claude`, `--codex`, `--agy`, `--grok`, `--opencode`, `--acp <preset>`
or `-e <engine>[:model]`; with none, the default from `clawo config` (Claude Code out of the box). A model is the
engine's own id (`claude-fable-5-2`, `gpt-6.2-astra`, `gemini-4-neon-high`) and goes to the engine as given.

### Several engines on one task

One call runs the same task on every agent in parallel; each agent has its own engine, model, effort, `cwd` and
`sandboxMode`. From a shell, no MCP tool needed:

```bash
clawo fanout "Review the poker game in this repo for correctness, fairness and UX; cite file:line for each finding." \
  -e codex:gpt-6.2-astra,agy:gemini-4-neon-high,claude:claude-fable-5-2 \
  --sandbox read-only --agent-timeout 40 --synthesize --cwd /path/to/repo --wait
```

Run it as a background command: it exits when every agent has answered, so its exit is the completion notice. It
prints each answer, then where each is saved (`~/.claw-orchestrator/wf/<runId>/outputs/<agent>.md`, and
`synthesis.md`). The same through MCP:

```javascript
fanout_start({
  task: 'Review the poker game for correctness, fairness and UX; cite file:line for each finding.',
  projectDir: '/path/to/repo',
  agents: [
    { name: 'codex', engine: 'codex', model: 'gpt-6.2-astra', effort: 'high', sandboxMode: 'read-only' },
    { name: 'agy', engine: 'agy', model: 'gemini-4-neon-high', sandboxMode: 'read-only' },
    { name: 'claude', engine: 'claude', model: 'claude-fable-5-2', sandboxMode: 'read-only' },
  ],
  agentTimeoutMs: 2_400_000, // 40 min; the default is 30
  synthesize: true,
});
fanout_status({ id }); // results[i].output, .outputFile (the whole answer), .timedOut; synthesis, synthesisFile
```

- `model` is the engine's own id (or a clawo alias) and goes to the engine as given; an id the engine does not know
  fails that agent at once with the engine's own error, never a silent fallback.
- An agent that outlives its timeout ends `timedOut: true`, with the text it had streamed so far as its output (agy
  streams nothing before it finishes). The others' answers stand.
- `cwd` per agent (absolute, or relative to `projectDir`) when agents write; `sandboxMode: 'read-only'` for reviewers.
  An agent with an `objective` runs as a goal instead of one turn ([workflow.md](references/workflow.md#goal)).

## Engine Quick Reference

| Engine      | CLI                          | Session Type          | Best For                                                                           |
| ----------- | ---------------------------- | --------------------- | ---------------------------------------------------------------------------------- |
| `claude`    | `claude`                     | Persistent subprocess | Multi-turn, complex tasks                                                          |
| `codex`     | `codex exec`                 | Per-message spawn     | One-shot execution; the thread is resumed on each send                             |
| `codex-app` | `codex app-server`           | Persistent subprocess | Codex `/goal`, plus interrupt / steer / fork / rollback of turns                   |
| `agy`       | `agy -p`                     | Per-message spawn     | Google Antigravity; reported token usage, conversation resumed by id               |
| `grok`      | `grok -p`                    | Per-message spawn     | xAI Grok Build; engine-reported cost, resumable session                            |
| `cursor`    | `cursor-agent -p`            | Per-message spawn     | Cursor Agent; one subscription's Composer, Claude, GPT, Grok and Gemini models     |
| `opencode`  | `opencode run`               | Per-message spawn     | Provider-agnostic (`provider/model`)                                               |
| `acp`       | the agent's own command      | Persistent subprocess | Any Agent Client Protocol agent, named by `acpAgent` (presets: `kimi-code`, `dsh`) |
| `custom`    | yours (`CustomEngineConfig`) | Either (`persistent`) | Any other coding CLI, described by a config or a bundled preset                    |

## Core Workflow

```javascript
// 1. Start session (any engine)
session_start({ name: 'myproject', cwd: '/path/to/project', engine: 'claude' });
session_start({ name: 'codex-task', cwd: '/path/to/project', engine: 'codex' });
session_start({ name: 'agy-task', cwd: '/path/to/project', engine: 'agy' });
session_start({ name: 'grok-task', cwd: '/path/to/project', engine: 'grok' });
session_start({
  name: 'opencode-task',
  cwd: '/path/to/project',
  engine: 'opencode',
  model: 'anthropic/claude-sonnet-5',
});
session_start({ name: 'kimi-task', cwd: '/path/to/project', engine: 'acp', acpAgent: 'kimi-code' });

// 2. Send messages
session_send({ name: 'myproject', message: 'Fix the auth bug' });

// 3. Check status / search history
coding_session_status({ name: 'myproject' });
session_grep({ name: 'myproject', pattern: 'error' });

// 4. Stop when done
session_stop({ name: 'myproject' });
```

## Session Options

| Parameter         | Description                                                                                                                                                                                                                                                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `engine`          | `claude` (default), `codex`, `codex-app`, `agy`, `grok`, `cursor`, `opencode`, `acp`, `custom`                                                                                                                                                                                                                                       |
| `model`           | Model name or alias (`fable`, `opus` → claude-opus-5-5, `sonnet`, `haiku`, `gpt-5.5`, `agy-pro`)                                                                                                                                                                                                                                     |
| `permissionMode`  | `acceptEdits`, `auto`, `plan`, `bypassPermissions`, `manual`, `dontAsk` (`default` = legacy alias for `manual`)                                                                                                                                                                                                                      |
| `effort`          | `low`, `medium`, `high`, `xhigh`, `max`, `ultra`, `auto` (each engine clamps to its own ceiling)                                                                                                                                                                                                                                     |
| `maxBudgetUsd`    | Cost limit in USD, enforced by the runtime on every engine                                                                                                                                                                                                                                                                           |
| `allowedTools`    | List of allowed tool names                                                                                                                                                                                                                                                                                                           |
| `sandboxMode`     | `read-only`, `workspace-write`, `danger-full-access`. Codex applies all three; claude, agy, grok, cursor and opencode enforce `read-only` through their own plan/read-only modes, and cursor also maps `workspace-write` to its sandbox; a custom engine must map it through `permissionModes` or refuses to start; `acp` refuses it |
| `acpAgent`        | With `engine: 'acp'`: a bundled preset id (`clawo engines`), or an inline `{ name, command, args, env }` from a local caller                                                                                                                                                                                                         |
| `customEngine`    | With `engine: 'custom'`: a bundled preset id, or an inline `CustomEngineConfig` from a local caller                                                                                                                                                                                                                                  |
| `resumeSessionId` | Resume an earlier conversation by the engine's own id (session, thread or conversation id)                                                                                                                                                                                                                                           |

### Claude-engine options

| Parameter                                         | Description                                                                                                                             |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `bare`                                            | Minimal mode — no CLAUDE.md, hooks, LSP, auto-memory. Auto-enables prompt cache optimizations (see below).                              |
| `includeHookEvents`                               | Stream hook lifecycle events (PreToolUse/PostToolUse).                                                                                  |
| `forwardSubagentText`                             | Forward subagent text and thinking into the output stream, so sessions that fan out surface intermediate output instead of going quiet. |
| `permissionPromptTool`                            | Delegate permission prompts to an MCP tool for non-interactive use.                                                                     |
| `excludeDynamicSystemPromptSections`              | Move cwd/env/git from system prompt to user message for better prompt cache hits. Auto-enabled with `bare: true`.                       |
| `enablePromptCaching1H`                           | Enable 1-hour prompt cache TTL (vs default 5-min). Auto-enabled with `bare: true`.                                                      |
| `debug` / `debugFile`                             | Targeted debug output by category (e.g. `"api,mcp"`) and optional file path.                                                            |
| `fromPr`                                          | Resume a session linked to a GitHub PR number or URL.                                                                                   |
| `channels` / `dangerouslyLoadDevelopmentChannels` | MCP channel subscriptions (research preview).                                                                                           |
| `forkSubagent`                                    | Fork subagent for non-interactive sessions (sets `CLAUDE_CODE_FORK_SUBAGENT=1`).                                                        |
| `enableToolSearch`                                | Enable Vertex AI tool search (sets `ENABLE_TOOL_SEARCH=1`).                                                                             |
| `otelLogUserPrompts`                              | OpenTelemetry: include user prompts in logs (sets `OTEL_LOG_USER_PROMPTS=1`).                                                           |
| `otelLogRawApiBodies`                             | OpenTelemetry: include raw API bodies in logs (sets `OTEL_LOG_RAW_API_BODIES=1`). Debug only.                                           |

`stats.pluginErrors` lists CLI plugins that failed to load (from the `system/init` event).

`TRACEPARENT` / `TRACESTATE` (W3C distributed tracing) are automatically forwarded from parent process env — set them before starting the session and they propagate to the child Claude CLI.

**Smart defaults:** When `bare: true`, the plugin auto-enables `--exclude-dynamic-system-prompt-sections` and `ENABLE_PROMPT_CACHING_1H=1` unless explicitly set to `false`.

## Multi-Agent Council

Parallel agent collaboration with git worktree isolation and consensus voting. Agents can use different engines.

```javascript
// Start a council
council_start({
  task: 'Build a REST API',
  agents: [
    { name: 'Architect', emoji: '🏗️', persona: 'System design', engine: 'claude' },
    { name: 'Engineer', emoji: '⚙️', persona: 'Implementation', engine: 'codex' },
  ],
  maxRounds: 5,
  projectDir: '/path/to/project',
});
```

Council lifecycle: `council_start` → poll `council_status` → `council_review` → `council_accept` or `council_reject`.

For details: see [references/council.md](references/council.md)

## Cross-Session Messaging

Sessions can communicate. Idle sessions receive immediately; busy sessions queue.

```javascript
session_send_to({ from: 'sender', to: 'receiver', message: 'Auth module needs rate limiting' });
session_send_to({ from: 'monitor', to: '*', message: 'Build failed!' }); // broadcast
session_inbox({ name: 'receiver' });
session_deliver_inbox({ name: 'receiver' });
```

## Team Tools (All Engines)

All engines use the same virtual-team layer: cross-session inbox routing across active SessionManager sessions. (Claude Code's native experimental Agent Teams is in-process TUI only and not reachable from a subprocess wrapper.)

```javascript
team_list({ name: 'myproject' });
team_send({ name: 'myproject', teammate: 'teammate', message: 'Review this' });
```

## Ultraplan & Ultrareview

- **Ultraplan**: Opus deep planning session (default timeout 30 min), produces detailed implementation plan
- **Ultrareview**: 1-20 read-only reviewer agents (default 5) running in parallel, each from one angle (security, logic, perf, types, etc.), merged by a synthesis pass. Reviewers can be spread across engines; `custom` and `acp` are refused because they cannot be held read-only

Both are async — start then poll status.

## Autoloop (autonomous workspace iteration)

Autoloop uses three persistent roles. You chat with the Planner to define `plan.md` and `goal.json`; after explicit approval it starts a Coder/Reviewer iteration loop. Each role may use a different engine (any engine except `acp`).

```javascript
autoloop_start({
  run_id: 'fix-parser',
  workspace: '/path/to/repo',
  planner_engine: 'claude',
  coder_engine: 'codex',
  reviewer_engine: 'agy',
});
autoloop_chat({ run_id: 'fix-parser', text: 'Read the repo and design a plan to fix the parser.' });
autoloop_chat({ run_id: 'fix-parser', text: 'Plan approved; start the loop.' });
autoloop_status({ run_id: 'fix-parser' });
autoloop_stop({ run_id: 'fix-parser', reason: 'done' });
```

Claude roles default to Planner `opus` and Coder/Reviewer `sonnet`. A non-Claude role with no model uses that engine's own default. Custom engine configs come from a local caller at start or resume — via `autoloop_resume` / HTTP resume references (`plannerCustomEngineRef` etc., resolved from a `CLAWO_CUSTOM_ENGINE_<NAME>` variable on the host) — never from Planner output. The Reviewer runs in a restaged sandbox and returns advance/hold/rollback verdicts; push policy and SSE keep long runs observable. `autoloop_rebind_role` moves one role of a running run to another engine, model or effort, applied before that role's next message and kept across a resume.

For the full control protocol, registry/resume behavior, and ledger layout, see [references/autoloop.md](references/autoloop.md).

## Tools Overview

| Category          | Tools                                                                                                                                                                                                                                                                                                        |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Session Lifecycle | `session_start`, `session_send`, `session_handoff`, `session_stop`, `session_list`, `sessions_overview`                                                                                                                                                                                                      |
| Session Ops       | `coding_session_status`, `session_grep`, `session_compact`, `session_update_tools`, `session_switch_model`, `project_purge`                                                                                                                                                                                  |
| Inbox             | `session_send_to`, `session_inbox`, `session_deliver_inbox`                                                                                                                                                                                                                                                  |
| Teams             | `coding_agents_list`, `team_list`, `team_send`                                                                                                                                                                                                                                                               |
| Codex             | `codex_resume`, `codex_review`, `codex_goal_*`, `codex_interrupt`, `codex_steer`, `codex_fork`, `codex_rollback`, `codex_models`, `codex_thread_list`                                                                                                                                                        |
| Claude CLI        | `claude_goal_*`, `claude_agents_list`, `plugin_details`                                                                                                                                                                                                                                                      |
| Fan-out           | `fanout_start`, `fanout_status`, `fanout_abort`                                                                                                                                                                                                                                                              |
| Council           | `council_start`, `council_status`, `council_abort`, `council_inject`, `council_review`, `council_accept`, `council_reject`                                                                                                                                                                                   |
| Ultra             | `ultraplan_start`, `ultraplan_status`, `ultrareview_start`, `ultrareview_status`                                                                                                                                                                                                                             |
| Autoloop          | `autoloop_start`, `autoloop_chat`, `autoloop_status`, `autoloop_list`, `autoloop_resume`, `autoloop_stop`, `autoloop_reset_agent`, `autoloop_rebind_role`                                                                                                                                                    |
| Workflow & verify | `workflow_start`, `workflow_status`, `workflow_list`, `workflow_resume`, `workflow_cancel`, `workflow_steer`, `workflow_forum`, `workflow_approve`, `verify_run`                                                                                                                                             |
| Ultraapp          | `ultraapp_new`, `ultraapp_answer`, `ultraapp_add_file`, `ultraapp_spec_edit`, `ultraapp_build_start`, `ultraapp_build_cancel`, `ultraapp_status`, `ultraapp_get`, `ultraapp_list`, `ultraapp_feedback`, `ultraapp_promote_version`, `ultraapp_start_container`, `ultraapp_stop_container`, `ultraapp_delete` |

`ultracode` (Claude dynamic workflows) is a `session_start` option, not a separate tool: set
`ultracode: true` to have Claude orchestrate a JS workflow and fan out to subagents per task.

For full parameter reference: see [references/tools.md](references/tools.md)

## Run as an ACP agent

`clawo acp` (or the `clawo-acp` binary) serves Agent Client Protocol over stdio, so any ACP
client — Zed, JetBrains, Neovim, Emacs, the VS Code ACP extension, or `dsh` through its
`subagent-acp` provider — drives the orchestrator as its coding agent. The model selector is
grouped by engine, so one dropdown spans Claude, Codex, Antigravity and Grok, and switching it
switches engine mid-session.

For setup, the dsh YAML block, and the cancellation/permission limits: see [references/acp.md](references/acp.md)

## Durable workflows

`workflow_start` runs a declarative graph of `agent` / `fanout` / `council` / `goal` /
`verifier` / `human_gate` / `router` / `subflow` nodes; autoloop runs (`autoloop_start`) and
UltraApp builds use the same kernel through their own `autoloop` / `ultraapp_synth` /
`ultraapp_deploy` nodes. Every state transition is checkpointed to
`~/.claw-orchestrator/wf/<runId>/`, so a run survives a process restart and `workflow_resume`
picks it up at the node boundary — nodes already succeeded are not re-run, and the one that
was in flight is retried because a half-finished node left no result to trust.

Four built-in templates: `solve` (triage → implement → optional review → verify →
repair until green), `council`, `fanout`, and `goal` (a Codex `/goal` on one `codex-app` thread, run
unattended for as long as it takes — reattached on resume, resumed after usage limits and
stalls within a bound, optionally under a sandbox `launcher` — then verify → repair on the
same thread; `clawo goal` from the terminal). Retry, per-node timeout, cancel, steer, human gates, and
bounded loops come from the kernel rather than from each mode's own state machine.

For node shapes, routing conditions, and the control surfaces:
see [references/workflow.md](references/workflow.md)

## Verification — does the work actually pass?

Hand a run an **acceptance contract** and the runtime checks the result itself: shell commands
gated on exit code, HTTP probes, headless-Chrome screenshots, diff policy, file assertions. A
run carrying a contract cannot reach `completed` unless every required check passes; a run
without one completes as `unverified`, which says nothing checked it rather than claiming
success. Every attempt writes an evidence bundle — verdict, per-check output tails, the patch
(created files included), screenshots — readable later with `clawo verify <runId>`.

Contracts come from the caller or a mode default, never from agent output: an agent that
writes its own acceptance criteria is grading itself. UltraApp ships one on by default;
`verify_run` checks work that did not come through a workflow at all.

For the check types, per-mode defaults, and what the screenshot gate does and does not claim:
see [references/verification.md](references/verification.md)

## Cost & spend caps

Every turn on every engine is appended to a durable ledger at
`~/.claw-orchestrator/runs/YYYY-MM-DD.jsonl` — engine, model, per-turn tokens, cost, duration,
and the council / fanout / autoloop it belonged to. Query it with `clawo runs [--since 24h]
[--engine X] [--parent <run id>] [--json]`, `GET /runs`, or `manager.getRunLedger()`; it
survives restarts, so it answers "what did we run today and what did it cost" after the
sessions are gone.

`maxBudgetUsd` on a session (or per council / fanout agent) is enforced by the runtime, so it
holds on Codex, agy, Grok, Cursor, OpenCode and custom engines too — not just Claude Code. Once
cumulative spend reaches the cap, further sends are refused before the engine is spawned.

Rows carry two different judgements and keep them apart: `ok` is the engine's terminal verdict
on its own turn, `verified` is whether an acceptance contract passed. A row with no `verified`
at all means no contract was declared — not that it failed. `clawo runs --verified` /
`--refuted` filter on it.

For the row schema, the query surfaces, and which engines report real token usage versus
estimating it: see [references/observability.md](references/observability.md)

## From the terminal

With `clawo serve` running, the same runtime is scriptable from a shell. Commands that fail exit
with status 1. Full list: [references/cli.md](references/cli.md).

```bash
clawo session-start fix -e codex -d /path/to/project
clawo session-send fix --message-file task.md --json   # the whole result as one JSON line
clawo session-status fix --json
clawo solve "The test fails. Fix it." -e claude --check "npm test" --wait   # exit 0 only if it completes
clawo fanout "Review this design" --engines claude,codex,grok --synthesize --wait
clawo goal --objective-file GOAL.md --check "npm test" --wait
clawo workflow list                                    # then: clawo workflow show <runId>
clawo verify <runId>                                   # the evidence bundle
clawo runs --since 24h                                 # the per-turn ledger
clawo engines                                          # bundled community presets
```

## Authentication Prerequisites

Each engine requires its own auth before use:

- **Claude**: `claude /login` or `ANTHROPIC_API_KEY`
- **Codex**: `codex login` or `OPENAI_API_KEY`
- **Antigravity**: run `agy` once and complete the Google OAuth login
- **Grok**: run `grok` once and sign in (grok.com account or `XAI_API_KEY`)
- **OpenCode**: `opencode auth login` (provider-agnostic; use `provider/model` form for `model`)
- **ACP agents**: log in with the agent's own CLI first; the session runs no ACP authentication step
