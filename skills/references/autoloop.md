# Autoloop — Reference

Three-agent autonomous iteration loop for a git workspace. You converse with
the **Planner** to design a plan; on your approval, the Planner spawns the
**Coder** + **Reviewer** subloop, monitors it, and pushes you (wechat →
whatsapp → email fallback chain) only when something needs your attention.

Design rationale: `tasks/autoloop.md`. This page is the operator reference.

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

| Agent | Engine (default) | cwd | Owns |
|---|---|---|---|
| **Planner** | claude / opus | workspace | strategy, `plan.md`, `goal.json`, talking to you |
| **Coder** | claude / sonnet (override per spawn) | workspace | code changes, eval execution |
| **Reviewer** | claude / sonnet | `<workspace>/tasks/<run_id>/reviewer_sandbox/` | distrust audit; advance / hold / rollback |

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
| `autoloop_start` | `run_id`, `workspace`, `planner_model?`, `send_timeout_ms?` | Start a run; launches Planner session. |
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
| `spawn_subagents` | `coder_model?`, `reviewer_model?`, `initial_directive?` | Start Coder + Reviewer. Only after explicit user approval. |
| `send_directive` | `goal`, `constraints?`, `success_criteria?`, `max_attempts?` | Next iter's instruction to Coder. |
| `pause_loop` | `reason` | Halt subloop at next iter boundary; chat keeps working. |
| `resume_loop` | — | Resume after pause. |
| `terminate` | `reason` | End run. |
| `update_push_policy` | partial PushPolicy | Mutate notification rules (e.g. when you say "tell me every iter"). |
| `write_plan_committed` | `message?` | git-commit current plan.md. |
| `write_goal_committed` | `message?` | git-commit current goal.json. |

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
| `GET /autoloop/<id>/state` | `{ ok, state: AutoloopState }` |
| `GET /autoloop/<id>/push_log` | `{ ok, entries: PushLogEntry[] }` |
| `GET /autoloop/<id>/events` | SSE: `snapshot` / `message` / `state` / `push` / `iter_done` / `planner_reply` / `coder_reply` / `reviewer_reply` / `terminated` |

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
