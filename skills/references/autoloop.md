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
+ wechat fallback chain.

## Ledger layout

```
<workspace>/tasks/<run_id>/
├── plan.md              # Planner-authored, git-committed
├── goal.json            # Planner-authored, git-committed
├── push_log.jsonl       # every notify_user attempt + channel used
├── reviewer_sandbox/    # Reviewer cwd; restaged per iter
│   ├── plan.md          # copy
│   ├── goal.json        # copy
│   ├── iter-N/          # this iter's directive + diff + eval
│   ├── prior_verdict.json
│   └── reviewer_memory.md  # persistent across iters
└── iter/<n>/
    ├── directive.json     # Planner → Coder
    ├── eval_output.json   # what Coder reported
    ├── diff.patch         # git diff of the iter
    ├── verdict.json       # Reviewer decision + audit notes
    └── coder_summary.txt
```

The orchestrator git-commits each iter automatically. Coder must NOT call
`git commit` itself — that confuses the diff log.

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

- **No auto-compact on token budget.** Manual `autoloop_reset_agent` covers
  the same recovery path. Auto-compact is queued for a follow-up once
  `ISession.getStats` exposes token-usage hooks.
- **One-way push.** WeChat → Planner inbound replies are not yet wired (would
  need an openclaw-gateway tmux-passthrough route). Reply via webchat /
  `autoloop_chat`.
- **No webchat UI yet.** Backend SSE is shipped; the UI is a separate
  cross-repo PR in ChatGPT-Next-Web.
- **No fork / population mode.** Single linear iter trajectory per run.
- **Cross-run knowledge isolated.** Each run's `reviewer_memory.md` and
  `coder_notes.md` live in that run's ledger; no shared meta-store yet.
