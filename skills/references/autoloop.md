# Autoloop — Reference

Three-agent autonomous iteration loop for a git workspace. You converse with
the **Planner** to design a plan; on your approval, the Planner spawns the
**Coder** + **Reviewer** subloop, monitors it, and pushes you (wechat →
whatsapp → email fallback chain) only when something needs your attention.

This page is the operator reference.

## When to use

- Goal is exploratory and you want to **design the plan with the agent**
  before running. The Planner will read your workspace, surface ambiguity,
  and write `plan.md` / `goal.json` with you.
- You want a long-running loop you can walk away from. The Planner pushes
  you on regressions, completion, decisions, or stalls; otherwise it stays
  silent.
- You can write down what "better" means as a shell command (test pass
  count, latency, loss, gate completion). Without that anchor, Reviewer has
  nothing to ratchet on.

## Roles

| Agent | Default | cwd | Owns |
|---|---|---|---|
| **Planner** | claude / opus | workspace | strategy, `plan.md`, `goal.json`, talking to you |
| **Coder** | claude / sonnet | workspace | code changes, eval execution |
| **Reviewer** | claude / sonnet | `<workspace>/tasks/<run_id>/reviewer_sandbox/` | distrust audit; advance / hold / rollback |

Each role can use any built-in engine, or a `custom` engine config supplied by a
local caller (custom engines name an executable, so the HTTP API does not accept
them — see [tools.md](./tools.md)). If a non-Claude role omits `model`, that CLI
uses its own default model rather than receiving the Claude `opus` / `sonnet`
defaults. Role instructions are included in-band for engines that do not expose a
native system-prompt flag.

Engines without native multi-turn conversation (Gemini, Cursor, OpenCode, one-shot
custom engines) spawn a fresh process per send, so the dispatcher replays that
role's transcript in-band as a `<conversation_history>` block, oldest turns dropped
past a character budget. Claude, Codex and Antigravity keep context themselves and
get no replay.

The Planner runs read-only so strategy cannot turn into source edits, and that is
enforced by the engine rather than requested politely: Claude uses plan mode,
Gemini gets `--approval-mode plan` **plus an admin policy denying `exit_plan_mode`**
(plan mode on its own is model-cooperative — the agent can call that tool and walk
out of it), OpenCode gets a generated `clawo-readonly` agent that denies
`edit`/`bash`/`external_directory` (its built-in `plan` agent is a user-overridable
preset that denies neither), and Antigravity/Cursor use their plan modes. A custom
Planner receives `permissionMode: 'manual'` and its `CustomEngineConfig` **must**
map that mode to the CLI's read-only flag — if it cannot, the session refuses to
start rather than silently running write-enabled.

Coder and Reviewer engine/model choices can be overridden by the first successful
`spawn_subagents`; later attempts to change an already-started role are rejected
instead of silently diverging from the running session.

Coder and Reviewer **never speak to you directly**. Anything they observe
flows through the Planner. The Planner decides what to surface and what to
absorb.

## UX flow

```
1. autoloop_start { run_id, workspace }       → Planner session ready
2. autoloop_chat { run_id, "<your goal>" }    → Planner reads workspace,
                                                drafts plan.md + goal.json,
                                                asks "ready to spawn?"
3. autoloop_chat { run_id, "go" }             → Planner emits spawn_subagents
4. Coder + Reviewer self-iterate              → ledger writes per iter
5. Planner pushes you on target_hit / regression / decision / stall
6. Run terminates on target hit, plan-defined max_iters, or your terminate.
```

## Quick start

```bash
# Start a run (creates Planner session)
curl -X POST http://127.0.0.1:18789/v1/openclaw/tools/autoloop_start \
  -H 'content-type: application/json' \
  -d '{"run_id":"my-run","workspace":"/abs/path/to/workspace"}'

# Chat with the Planner
curl -X POST http://127.0.0.1:18789/v1/openclaw/tools/autoloop_chat \
  -H 'content-type: application/json' \
  -d '{"run_id":"my-run","text":"Read the workspace and design a plan to fix X"}'

# Inspect state
curl http://127.0.0.1:18789/autoloop/my-run/state

# Live SSE stream (the 3-pane UI subscribes here)
curl http://127.0.0.1:18789/autoloop/my-run/events

# Reset Coder if it drifts (lazy; eager_restart=true to start a fresh session immediately)
curl -X POST http://127.0.0.1:18789/v1/openclaw/tools/autoloop_reset_agent \
  -H 'content-type: application/json' \
  -d '{"run_id":"my-run","agent":"coder","eager_restart":true}'

# Stop
curl -X POST http://127.0.0.1:18789/v1/openclaw/tools/autoloop_stop \
  -H 'content-type: application/json' \
  -d '{"run_id":"my-run","reason":"done"}'
```

## Plugin tools

| Tool | Args | What |
|---|---|---|
| `autoloop_start` | `run_id`, `workspace`, per-role `*_engine?`, `*_model?`, `*_custom_engine?`, `send_timeout_ms?` | Start a run; launches Planner and stores Coder/Reviewer defaults. Each `custom` role requires its matching config. |
| `autoloop_chat` | `run_id`, `text` | Send a chat message to the Planner; returns the Planner's reply. |
| `autoloop_status` | `run_id` | Current state (status, iter, push count, subagents_spawned). |
| `autoloop_list` | — | All active runs in this manager process. |
| `autoloop_stop` | `run_id`, `reason?` | Terminate; stops Planner / Coder / Reviewer. |
| `autoloop_reset_agent` | `run_id`, `agent` ('planner' / 'coder' / 'reviewer'), `force?`, `eager_restart?` | Reset one subagent. Planner reset requires `force: true`. |

## Planner-emitted control tools

The Planner controls the run by emitting fenced ` ```autoloop ` JSON blocks
inside its replies. The dispatcher parses them out and applies them. You
never see the JSON — only the Planner's narrative.

| Tool | Args | What |
|---|---|---|
| `notify_user` | `level` ('info' / 'warn' / 'decision' / 'error'), `summary`, `detail?`, `channel?` ('auto' / 'wechat' / 'webchat' / 'both' / 'email') | Push you out-of-band. |
| `spawn_subagents` | `coder_engine?`, `coder_model?`, `reviewer_engine?`, `reviewer_model?`, `initial_directive?` | Start Coder + Reviewer. Omitted values inherit run defaults. An engine change without a model uses the new engine's default. Once a role session has started, changing its engine/model is rejected. Custom configs cannot be emitted by Planner. Only after explicit user approval. |
| `send_directive` | `goal`, `constraints?`, `success_criteria?`, `max_attempts?` | Next iter's instruction to Coder. |
| `pause_loop` | `reason` | Halt subloop at next iter boundary; chat keeps working. |
| `resume_loop` | — | Resume after pause. |
| `terminate` | `reason` | End run. |
| `update_push_policy` | partial PushPolicy | Mutate notification rules (e.g. when you say "tell me every iter"). |
| `write_plan` | `content` (full plan.md body), `commit_message?` | Write `plan.md` to the workspace and git-commit. The **only** way the Planner can author plan.md — Write/Edit are stripped from the Planner session as a hard role boundary. Re-running replaces the whole file. |
| `write_goal` | `content` (full goal.json body), `commit_message?` | Same, for `goal.json`. Content is JSON-validated before write; malformed content errors back to the Planner. |

### Custom engines and resume

Custom engine configs are accepted only by `autoloop_start` (or the HTTP resume
body), never through Planner output. This keeps config fields such as `env` and
static CLI arguments out of the Planner transcript and `decisions.jsonl`.
The central registry persists only each role's engine and model, including the
effective Coder/Reviewer selection after a successful spawn. Resume leaves the
prior append-only row untouched until startup succeeds, so a transient CLI
failure cannot erase the run. When resuming a run that uses `custom`, provide
the matching `planner_custom_engine`, `coder_custom_engine`, or
`reviewer_custom_engine` again; otherwise resume fails with a clear
configuration error rather than silently switching to Claude. Custom config
shape is validated at runtime, while its `env` and static CLI arguments remain
out of registry and audit records. See [`multi-engine.md`](./multi-engine.md)
for the `CustomEngineConfig` shape.

## Default push policy

| Event | Default |
|---|---|
| on_start | info / wechat ("loop started, will notify on issues") |
| on_iter_done_ok | silent |
| on_target_hit | info / both (webchat + wechat) |
| on_metric_regression_2 | warn / both |
| on_reviewer_reject_2 | warn / both |
| on_phase_error | error / both |
| on_stall_30min | warn / wechat |
| on_decision_needed | decision / both |

5-minute dedup on (level, summary) prevents duplicate pushes from the same
event. Channel chain: `auto` walks wechat → whatsapp → email; `wechat` /
`webchat` / `email` route directly; `both` does webchat (if session known)
+ wechat fallback chain. **`on_phase_error` and `on_decision_needed` cannot
be set to `silent: true`** by Planner — `update_push_policy` strips the flag
and records the attempt in `decisions.jsonl` (these channels are the
operator's lifeline; they stay loud).

## Auto-compact

Each agent's context is monitored after every turn. When `getStats().contextPercent`
crosses the per-agent threshold the dispatcher invokes `/compact` with a
role-tuned hint (`compactSummaryFor`). Defaults: Planner 80 %, Coder 70 %,
Reviewer 70 %. Override per run via `compactThresholds`. A 30 s debounce
prevents re-fire while post-compact stats settle. Events: `compact` is
emitted on the dispatcher EventEmitter AND appended to `decisions.jsonl`.

## Phase-error circuit

Subprocess deaths (Claude session lost), failed `git commit` in an iter, and
other phase-bound failures surface as `phase_error` messages instead of
silently masquerading as a "clarification request". The runner counts
consecutive `phase_error`s and:

1. Fires `on_phase_error` on each one (defaults to error / both channels).
2. After `phaseErrorCircuit` consecutive errors (default **3**) emits a
   `decision`-level push and an automatic `terminate { reason:
   'phase_error_circuit' }`.

A successful (non-error) `iter_done` resets the counter. Override the
threshold via `AutoloopConfig.phaseErrorCircuit`.

## Reviewer frozen memory

`reviewer_memory.md` is read at Reviewer-session start and **injected as a
frozen `<frozen_memory_snapshot>` block** into the system prompt. It stays
constant for the lifetime of that session so Claude's prefix cache hits.
Reviewer can append fresh observations to the file on disk; those edits
become visible only on the next Reviewer reset (`autoloop_reset_agent`
with `agent: 'reviewer', eager_restart: true`).

## Decisions audit

`<ledger>/decisions.jsonl` is the auditable trail of runner / dispatcher
decisions:

| Kind | When |
|---|---|
| `spawn_subagents` | Planner emits `spawn_subagents` |
| `reset_agent` | Any agent reset (manual or auto-recovery) |
| `compact` | Auto-compact fires |
| `update_push_policy` | Planner mutates the policy |
| `policy_silence_blocked` | Planner tried to silence a critical channel |
| `phase_error` | Surfaced from dispatcher to runner |
| `terminate` | Run ends (planner reason or `phase_error_circuit`) |

JSONL, one entry per line, ts-prefixed.

## Ledger layout

```
<workspace>/tasks/<run_id>/
├── plan.md              # Planner-authored, git-committed
├── goal.json            # Planner-authored, git-committed
├── push_log.jsonl       # every notify_user attempt + channel used
├── decisions.jsonl      # runner / dispatcher audit trail (see above)
├── reviewer_sandbox/    # Reviewer cwd; restaged per iter
│   ├── plan.md          # copy
│   ├── goal.json        # copy
│   ├── iter-N/          # this iter's directive + diff + eval
│   ├── prior_verdict.json
│   ├── reviewer_memory.md   # persistent (frozen-injected at session start)
│   └── reviewer_log.jsonl   # persistent (Reviewer's append-only audit log)
└── iter/<n>/
    ├── directive.json     # Planner → Coder        (schema_version: 1)
    ├── eval_output.json   # what Coder reported     (schema_version: 1)
    ├── diff.patch         # git diff of the iter
    ├── verdict.json       # Reviewer decision + audit notes (schema_version: 1)
    └── coder_summary.txt
```

The orchestrator git-commits each iter automatically. Coder must NOT call
`git commit` itself — that confuses the diff log. **If `git commit` fails
inside an iter** (pre-commit hook reject, signing key missing, …) the
dispatcher emits a `phase_error` instead of writing `iter_artifacts`, so
the failure is visible to the runner and counts toward the circuit.

Every JSON artifact in the ledger carries a `schema_version` field (currently
`1`) to make future migrations explicit.

## Backend HTTP / SSE

| Endpoint | Returns |
|---|---|
| `GET /autoloop/list` | `{ ok, runs: AutoloopState[] }` |
| `POST /autoloop/new` | `{ ok, run_id, planner_session }` — body `{ workspace, run_id?, planner_engine?, planner_model?, planner_custom_engine?, coder_engine?, coder_model?, coder_custom_engine?, reviewer_engine?, reviewer_model?, reviewer_custom_engine?, send_timeout_ms? }` |
| `GET /autoloop/<id>/state` | `{ ok, state: AutoloopState }` — also returns a `terminated`-state stub reconstructed from the registry for runs that aren't in this process's memory, so the dashboard can open historical runs without 404'ing. |
| `GET /autoloop/<id>/push_log` | `{ ok, entries: PushLogEntry[] }` — served from the ledger via `autoloopStatus`, so historical runs work the same as live ones. |
| `GET /autoloop/<id>/chat_history` | `{ ok, entries: ChatEntry[] }` — replays `<ledger>/chat.jsonl`. The dashboard fetches this when opening a run so the Planner-pane conversation survives a page refresh / cross-process / re-opening a terminated run. Returns `[]` when the file doesn't exist (e.g. runs that predate the chat-history feature). |
| `GET /autoloop/<id>/events` | SSE: `snapshot` / `message` / `state` / `push` / `iter_done` / `planner_reply` / `planner_error` / `coder_reply` / `reviewer_reply` / `terminated`. For runs that are NOT in this process's memory (terminated, or live in another process), the endpoint emits a single-shot `snapshot` + `terminated` then closes — the dashboard's existing handlers render history without hanging. |
| `POST /autoloop/<id>/chat` | **202** `{ ok, queued: true }` — body `{ text }`. Fire-and-forget: the Planner's reply streams back via the `/events` SSE channel as a `planner_reply` event (or `planner_error` on failure); the HTTP response intentionally does NOT wait for it, because first-contact replies routinely exceed reverse-proxy idle limits (e.g. Cloudflare Tunnel cuts at ~100s → 524). 400 on empty text, 404 when the run is not in this process's memory. The MCP `autoloop_chat` tool path keeps the synchronous await-and-return-reply semantics (it runs in-process). |
| `POST /autoloop/<id>/resume` | `{ ok, state }` — restore the role engine/model choices from the registry and re-create dispatcher + runner. Optional body fields `planner_custom_engine`, `coder_custom_engine`, `reviewer_custom_engine` must be supplied again for roles using `custom` because configs are intentionally not persisted. Existing engine-specific conversation resume behavior is reused where supported; `chat.jsonl` remains the visual history fallback. 404 when the registry has no record. |
| `POST /autoloop/<id>/delete` | `{ ok }` — stops the runner if still alive, scrubs the row from `~/.claw-orchestrator/autoloop-registry.jsonl`, and purges `persistedSessions` so the run cannot be `/resume`'d back. The ledger directory under `<workspace>/tasks/<run_id>/` is kept on disk. 404 if the run was not present in either memory or the registry. |

The 3-pane UI consumes these endpoints:
- **Left**: Planner chat (subscribes to `planner_reply`)
- **Center**: Coder activity (`coder_reply` + `iter_done`)
- **Right**: Reviewer verdicts (`reviewer_reply`)
- **Top bar**: state (status / iter / metric)
- **Bottom**: push_log

The UI itself ships in a separate cross-repo PR.

## `goal.json` shape

The Planner authors goal.json based on your conversation. There is no
hard schema — the Coder reads what's there and runs the eval the Planner
wrote down. A typical shape:

```jsonc
{
  "scalar": {
    "name": "test_pass_rate",
    "direction": "max",
    "extract_cmd": "bash eval.sh | grep -oE 'metric=[0-9.]+' | cut -d= -f2",
    "target": 1.0
  },
  "gates": [
    { "name": "tests_pass", "cmd": "npm test", "must": "exit-0" }
  ],
  "termination": {
    "max_iters": 10,
    "scalar_target_hit": true
  }
}
```

The Planner will riff on this shape during your chat and ask if it's right.

## Hard rules (Coder / Reviewer)

- ❌ Coder does NOT modify `plan.md`, `goal.json`, or anything under `tasks/`. Planner owns those.
- ❌ Coder does NOT manually `git commit` — orchestrator commits per iter.
- ❌ Reviewer modifies nothing outside its sandbox cwd.
- ❌ Reviewer never pings Planner / Coder for clarification — operates from artifacts only.
- ✅ Coder leaves notes in `coder_notes.md` for things future iters need to know.
- ✅ Reviewer accumulates "fakery patterns I've seen" in `reviewer_memory.md` (persists across iters).
- ✅ Reviewer defaults to `hold` under uncertainty; only `advance` after independent verification.

## Smoke test

`scripts/smoke-autoloop.ts` runs a buggy `add_two` scenario end-to-end with
Opus Planner + Sonnet × 2. Validates plan.md / goal.json commit, spawn,
iter 0 ledger artifacts (`directive` + `eval_output` + `diff.patch` +
`verdict`), and termination on `target_hit`. Cost ~$1-3, wall-clock
~5-15 min. Run with `npx tsx scripts/smoke-autoloop.ts` (requires
`~/.claude/settings.json` to have your auth env).

## Known limitations

- **`webchat` channel is a no-op** — `notifyUserFallbackChain` does not yet
  carry a webchat session id at the run level, so `channel: 'webchat'`
  always returns `channel_used: 'none'`. Use `auto` / `wechat` / `email`
  until the inbound route lands.
- **One-way push.** WeChat → Planner inbound replies are not yet wired (would
  need an openclaw-gateway tmux-passthrough route). Reply via webchat /
  `autoloop_chat`.
- **No webchat UI yet.** Backend SSE is shipped; the UI is a separate
  cross-repo PR in ChatGPT-Next-Web.
- **No fork / population mode.** Single linear iter trajectory per run.
- **Cross-run knowledge isolated.** Each run's `reviewer_memory.md` and
  `coder_notes.md` live in that run's ledger; no shared meta-store yet.
- **No cost / wall-clock budget cap.** Only `phaseErrorCircuit` + Reviewer
  hold/reject streaks bound the run; a steady-but-pointless ratchet could
  run for days. Set `max_iters` in `goal.json` to bound iter count.
- **Run state in memory.** SessionManager restart drops the live `autoloops`
  map; the on-disk ledger survives but cannot resume a running state.
- **Multi-run / same workspace** races on `git index.lock`. Run separate
  workspaces (or git worktrees) for concurrent runs.
