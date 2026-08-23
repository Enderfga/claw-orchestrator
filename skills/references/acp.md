# Agent Client Protocol (ACP)

Claw Orchestrator can run **as an ACP agent**: a coding agent that any ACP client
drives over JSON-RPC stdio. Zed, JetBrains IDEs, Neovim, Emacs and the VS Code ACP
extension are clients; so is `dsh`, whose `@deepseek-ai/dsh-subagent-acp` provider
spawns an arbitrary command as a subagent.

Every other agent in the ACP ecosystem is a single agent. This one is a fleet: the
model selector spans engines, and the session-mode picker is where orchestration
shapes are chosen.

```bash
clawo acp          # or the dedicated binary:
clawo-acp
```

Both read the protocol from stdin and write it to stdout. **Stdout carries nothing
but protocol frames** — all logging goes to stderr.

## Protocol version

Built against **stable ACP v1** (`@agentclientprotocol/sdk`, pinned `1.3.0`).
ACP v2 exists but is a published draft whose README warns the wire protocol "may
change incompatibly in any SDK release", so it is deliberately not used.

Implemented: `initialize`, `authenticate`, `session/new`, `session/prompt`,
`session/set_mode`, `session/set_config_option`, `session/cancel`.

## Configuration

| Env var | Default | Meaning |
|---|---|---|
| `CLAWO_ACP_MODEL` | `claude-sonnet-4-6` | Model (and therefore engine) for a new session |
| `CLAWO_ACP_PERMISSION` | `acceptEdits` | `plan` \| `acceptEdits` \| `bypassPermissions`; an unrecognised value is ignored with a warning |
| `OPENCLAW_LOG_LEVEL` | `info` | Set `warn` to quieten the stderr channel |

## Session modes

`session/new` returns the mode list and ACP defines `session/set_mode`, but **whether
a client surfaces a mode picker is up to the client** — the VS Code ACP extension
(0.2.0, measured) renders config options and not modes. So every mode also has a
slash command, advertised through `available_commands_update` when the session opens:

| Command | Effect |
|---|---|
| `/single` · `/council` · `/ultraplan` · `/ultrareview` | Switch mode. Text after the command runs in that mode straight away — `/council fix the failing test` is one step, not three. |

That is the only way to reach a mode in a client that does not draw the picker.

| Mode | What a turn does |
|---|---|
| `single` | One engine answers. Text streams as `agent_message_chunk`; tool use becomes `tool_call`. |
| `council` | Several engines debate in isolated git worktrees. Each agent becomes a `tool_call` the client can collapse, each round emits a `plan`, and the synthesis arrives as text. |
| `ultraplan` | Long-horizon planning pass. Result arrives as a `plan` update and as text. |
| `ultrareview` | Parallel reviewers sweep the working tree; findings arrive the same way. |

### Council

Council defaults here are deliberately far below the library's own — that config is
tuned for a long unattended run (three agents, fifteen rounds, one session per agent
*per round*), which is the wrong shape behind an editor turn. The ACP path uses **two
agents on distinct engines (Claude and Codex) and three rounds**.

It still is not fast: a measured two-round run on a one-line bug took **~9 minutes**.
Treat council as a deliberate action, not a default.

Agent deltas are buffered per agent and delivered on that agent's `tool_call_update`
rather than streamed into the text channel. Several agents speak at once, and a
consumer that only reads text — `dsh`'s ACP subagent reads nothing else — would
otherwise receive them interleaved into one unreadable blob.

Council requires a git repository at the session `cwd`; it creates one worktree and
branch per agent. Its guardrails (non-git directory, too-short task, and others)
surface as an `invalid params` error naming the reason.

**Consensus parks the run rather than finishing it.** The turn ends at the gate, and
the decision becomes a slash command, advertised through `available_commands_update`:

| Command | Effect |
|---|---|
| `/council_accept` | Merge the winning agent's worktree. |
| `/council_reject <feedback>` | Discard the result; the text is passed through as feedback. |

Any other prompt while a council is parked is refused, so a second run cannot start
over the same worktrees.

### Ultraplan and ultrareview

Neither emits events — they are started and then polled — so progress is reported as
`agent_thought_chunk` heartbeats. Ultraplan has **no abort path at all**, so
cancelling one abandons the poll rather than stopping the work.

## Cross-engine model selector

`session/new` also returns a `category: "model"` config option whose values are
**grouped by engine**, built from the shared registry in `src/models.ts`. One
dropdown holds Claude, Codex and Grok models at once. Changing it restarts the
underlying session on the new engine; the ACP session id is unaffected.

Two engines are absent for different reasons:

- **`gemini`** — the Gemini CLI is sunset and superseded by Antigravity. It still
  works for callers that name it directly; it is not offered in a new picker.
- **`opencode`** — its models are open-ended `provider/model` strings passed
  straight through, so there is nothing in the registry to enumerate. An opencode
  session is reachable by naming the model, just not by picking it from this list.

## Permission

ACP can ask the user mid-turn through `session/request_permission`. This agent does
**not** use it, because nothing in the session layer can surface such a request:
permission is resolved once into engine CLI flags at session start, and
`permissionPromptTool` routes to an MCP tool the caller hosts rather than back
through the manager. Offering a prompt that cannot be honoured would be worse than
saying so, so the choice is a session config option instead — which also suits
`dsh-subagent-acp`, whose default is to auto-reject permission requests.

## Cancellation

`session/cancel` settles the in-flight prompt as `cancelled` immediately, then tears
the underlying session down and recreates it.

The session layer has **no mid-turn cancel** — `stopSession()` is the only lever and
it destroys the session rather than pausing the turn. So the ACP turn returns
promptly while the engine subprocess may take a moment longer to die, and any
partial work in that turn is lost. This is a real limitation, not a detail of the
current implementation.

## Use from `dsh`

`@deepseek-ai/dsh-subagent-acp` takes an arbitrary `command`, so no plugin code is
needed:

```yaml
- id: subagent-acp
  name: '@deepseek-ai/dsh-subagent-acp'
  config:
    providerName: clawo
    command: npx
    args: ['-y', '@enderfga/claw-orchestrator', 'acp']
    permission: reject
```

That provider collects **only `agent_message_chunk` text** into its result — it
ignores tool calls and other updates — and runs a fresh subprocess per run with no
parent context. The adapter therefore keeps the text stream self-sufficient: an
engine that never streams still gets its whole answer emitted as one final chunk.

## Verifying a change

Unit tests cover the translation helpers and the config-option shapes
(`src/__tests__/acp-server.test.ts`). They cannot catch the failure this protocol
actually dies of, so also drive the real binary:

```bash
npm run build
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1}}' \
  | node dist/bin/acp-server.js
```

Then run a full session and assert **every stdout line parses as JSON**. A single
stray `console.log` anywhere in the process corrupts the frame stream, and the
client fails in a way that looks like a protocol bug. Two things prevent it, and
doing only one is the trap: suppress the embedded HTTP server (whose `start()`
prints), and hand `SessionManager` an explicit stderr logger — its default
`createConsoleLogger` writes `info`/`debug` to stdout.

Verified end to end against the real binary:

- handshake, `session/new` (4 engine groups in the selector), a streamed `single`-mode
  turn that read a workspace file under `plan` permission and relayed the answer;
- the mode slash commands: a bare `/ultraplan` switches and reports, `/single <task>`
  switches back and runs the task in one turn;
- a cross-engine model switch (`claude-sonnet-4-6` → `gpt-5.5`) answered by Codex;
- a full `council` run in a git repo — two engines, two rounds to consensus, emitting
  2 `plan`, 4 `tool_call`, 4 `tool_call_update`, the synthesis as text, and the two
  gate commands;
- `usage_update` carrying cross-engine cost;
- graceful exit on stdin EOF.

Every stdout line parsed as JSON throughout. `/council_accept` and `/council_reject`
are covered by unit tests against a fake manager but have not been exercised against a
live parked council.

It was also driven from **VS Code with the ACP Client extension 0.2.0** — the agent
appears in the agents list beside Copilot, Claude Code and Codex CLI, connects, renders
the grouped model dropdown and the permission selector, and answered a prompt about a
workspace file with its tool calls shown as collapsible entries. That run is what
established that this client does not render modes.
