# Autoloop — Reference

Autonomous iteration loop for a git workspace. Given an intent (`plan.md`) and success criteria (`goal.json`), the loop edits the code, runs gates, ratchets on a faithful metric, and pushes you only when it has to.

There are **two architectures** — both supported in 3.5.x:

- **v1** (the rest of this page): single-threaded phase machine (BOOTSTRAP → PROPOSE → EXECUTE → MEASURE → RATCHET → COMPRESS). Each phase spawns a fresh Claude session. Fire-and-forget — no human in the loop. Tools: `autoloop_start` / `autoloop_resume` / `autoloop_status` / `autoloop_inject` / `autoloop_stop`.
- **v2** ([Autoloop v2 below](#autoloop-v2-three-agent-architecture)): three persistent agents — Planner (Opus, your interface), Coder (Sonnet, makes the change), Reviewer (Sonnet, sandboxed audit). You converse with Planner to design the plan; on approval Planner spawns subagents that self-iterate while Planner pushes you on regressions / decisions / completion via wechat → whatsapp → email fallback chain.

Design docs: `tasks/autoloop.md` (v1), `tasks/autoloop-v2.md` (v2).

## When to use

- You can write down what "better" means as a shell command (test pass count, latency, loss, gate completion). Without that, ratchet has no anchor and the loop will drift — see `tasks/autoloop.md` §10.
- The workspace runs on the local box (or wherever the orchestrator is hosted). v1 runner is local subprocess only.
- You want the orchestrator to keep iterating while you do something else, and to push you on new-best / plateau / question.

## Quick start

```bash
# 1. Author plan.md (intent + scope) and goal.json (success criteria) — see §Examples.

# 2. Start the loop
curl -X POST http://127.0.0.1:18789/v1/openclaw/tools/autoloop_start \
  -H 'content-type: application/json' \
  -d '{
    "workspace": "/Users/me/projects/nano-gpt",
    "plan_path": "/Users/me/projects/nano-gpt/plan.md",
    "goal_path": "/Users/me/projects/nano-gpt/goal.json"
  }'
# → { ok: true, id: "autoloop-...", task_dir: ".../tasks/autoloop-...", current_phase: "RUNNING" }

# 3. Watch
curl http://127.0.0.1:18789/autoloop/<id>/events     # SSE stream (one event per phase / state / push)
# or poll
curl -X POST http://127.0.0.1:18789/v1/openclaw/tools/autoloop_status -d '{"id":"<id>"}'

# 4. Inject a hint (becomes input to next PROPOSE via tasks/<id>/inbox.md)
curl -X POST http://127.0.0.1:18789/v1/openclaw/tools/autoloop_inject \
  -d '{"id":"<id>","text":"try LR warmup 500 steps"}'

# 5. Resume after process death (gateway restart, OOM, machine reboot)
curl -X POST http://127.0.0.1:18789/v1/openclaw/tools/autoloop_resume \
  -d '{"workspace":"/path/to/workspace","task_id":"<id>"}'
# Skips BOOTSTRAP, git-resets workspace to last best (or bootstrap baseline if no best yet),
# then continues the loop. Refuses to resume already-terminated runs.

# 6. Stop
curl -X POST http://127.0.0.1:18789/v1/openclaw/tools/autoloop_stop -d '{"id":"<id>"}'
```

## `goal.json` schema

```jsonc
{
  // Optional. When absent, the de-facto metric is gate_completion.
  "scalar": {
    "name": "val_bpb",
    "direction": "min" | "max",
    "extract_cmd": "shell command that prints one number to stdout",
    "extract_timeout_sec": 600,    // hard wall-clock cap on extract_cmd. Default 600.
                                    //   For long ML evals (training+eval), set to your
                                    //   real upper bound, e.g. 14400 = 4 hours.
    "target": 0.95,
    "noise_floor": 0.005           // changes within ±noise are not improvements
  },
  // Required. May be empty only if scalar is set.
  "gates": [
    {
      "name": "tests_pass",
      "cmd": "npm test",
      "must": "exit-0",
      "timeout_sec": 600
    }
  ],
  // Optional. Agent-proposed gates that don't count toward goal_completion
  // until you move them into `gates`. Capped by termination.max_pending_aspirational.
  "aspirational_gates": [],
  "termination": {
    "scalar_target_hit": true,    // stop when scalar.target reached
    "max_iters": 200,
    "plateau_iters": 10,           // N consecutive non-improvements → push (loop continues)
    "max_cost_usd": 200,
    "max_pending_aspirational": 5
  }
}
```

## `plan.md` template

The agent reads `plan.md` for free-text intent. RATCHET also reads it for **Scope** rules (added in v3.4.1). Use this skeleton:

```markdown
# Plan

<one-paragraph statement of what you want the loop to achieve>

## Deliverables

<what artifacts must exist when done — files, sections, etc.>

## Scope (HARD)   ← RATCHET will reset on violations

- **Read-only**: `path/to/frozen-test-data.json`, `eval/golden_outputs/`. Never modify.
- **Allowed paths to write**: `src/configs/`, `src/training/`. No changes elsewhere.
- **Tunable hyperparameters**: `learning_rate`, `warmup_steps`, `batch_size`. Do NOT touch model architecture.
- **No external network calls** beyond what BOOTSTRAP set up.

## Style / Conventions

<optional: code style, naming, citation format, etc.>
```

The Scope section is interpreted by RATCHET (rule #2 in `configs/autoloop-ratchet-prompt.md`): if `current.md` describes changes outside Allowed paths or to Read-only files, RATCHET resets even if gates pass.

## Examples

### Example A — Iterative metric improvement (scalar-driven)

**Use case**: optimise a measurable number — training loss, latency, accuracy, error rate.

`plan.md`:
```
Improve val_bpb on shakespeare-char.
Constraints: must train on single A100 in <10 min/run.
Don't change tokenizer or eval set.
Initial idea: tune AdamW betas, then explore RoPE variants.
```

`goal.json`:
```json
{
  "scalar": {
    "name": "val_bpb",
    "direction": "min",
    "extract_cmd": "python eval.py --json | jq .val_bpb",
    "target": 0.95,
    "noise_floor": 0.005
  },
  "gates": [
    { "name": "trains_in_time", "cmd": "timeout 600 python train.py", "must": "exit-0" },
    { "name": "no_test_leak",   "cmd": "scripts/check_no_test_leak.sh", "must": "exit-0" }
  ],
  "termination": {
    "scalar_target_hit": true,
    "max_iters": 200,
    "plateau_iters": 10,
    "max_cost_usd": 200,
    "max_pending_aspirational": 5
  }
}
```

### Example B — Paper deep-research (gate-driven)

**Use case**: produce a structured research artifact (report, design doc) that satisfies a coverage checklist. No native scalar — the metric is gate completion.

`plan.md`:
```
Deeply research arXiv:2310.06825 (Mistral 7B).
Output research-report.md covering:
  - claim-by-claim extraction
  - related-work map (≥10 papers, each compared)
  - identified open questions
  - critique: which claims are weakest, why
Allow web search. Cite all external sources.
```

`goal.json`:
```json
{
  "gates": [
    { "name": "report_exists",          "cmd": "test -f research-report.md", "must": "exit-0" },
    { "name": "claims_extracted",       "cmd": "scripts/check_claims.sh ge 15", "must": "exit-0" },
    { "name": "related_work_ge_10",     "cmd": "scripts/check_citations.sh ge 10", "must": "exit-0" },
    { "name": "open_questions_present", "cmd": "scripts/check_section.sh 'Open Questions' ge 5", "must": "exit-0" },
    { "name": "critique_present",       "cmd": "scripts/check_section.sh 'Critique' ge 3", "must": "exit-0" },
    { "name": "all_citations_resolve",  "cmd": "scripts/verify_citations.sh", "must": "exit-0" }
  ],
  "termination": {
    "scalar_target_hit": true,
    "max_iters": 100,
    "plateau_iters": 8,
    "max_cost_usd": 100,
    "max_pending_aspirational": 5
  }
}
```

BOOTSTRAP will read the paper and propose ~10 aspirational gates (e.g. "address sliding-window attention's KV-cache implication") via push. Reply via wechat to lock specific ones; they then count toward `gate_completion`.

## Ledger files (under `<workspace>/tasks/<id>/`)

| File | Owner | Purpose |
|---|---|---|
| `plan.md` | human | Intent. Immutable after BOOTSTRAP unless human edits |
| `goal.json` | human + agent | Success criteria. Agent may append to `aspirational_gates` only |
| `current.md` | PROPOSE | "current best summary + next proposal". Re-read every iter |
| `state.json` | runner + RATCHET | Phase, iter, best, decision, plateau count. Only RATCHET writes `decision` |
| `metric.json` | MEASURE | Append-only history of metric points |
| `history.md` | COMPRESS | Compressed log of past iters (every K iters) |
| `iter/<n>/` | various | Per-iter artifacts: `eval.json`, `ratchet.json`, run logs |
| `inbox.md` | runner + human | Push log + injection log |
| `bootstrap-failure.md` | BOOTSTRAP | Only created if BOOTSTRAP failed; aborts the loop |

All files are git-tracked under the autoloop branch (`autoloop/<id>`). `git reset --hard` on RATCHET reset reverts ledger and code atomically.

## Defaults

| | Value |
|---|---|
| `propose_engine` / `propose_model` | `claude` / `opus` |
| `ratchet_engine` / `ratchet_model` | `claude` / `opus` (different process, sandboxed cwd) |
| `compress_every_k` | 10 |
| `per_iter_timeout_ms` | 600 000 (10 min) |
| `push_cmd` | `openclaw message send` |
| `goal.termination.max_iters` | 200 |
| `goal.termination.plateau_iters` | 10 |
| `goal.termination.max_cost_usd` | 200 |
| `goal.termination.max_pending_aspirational` | 5 |

## Push events

| Trigger | Reply expected? |
|---|---|
| `bootstrap_aspirational` (gates proposed at startup) | Yes — reply `lock 1,3,4` or `reject 2` to lock |
| `new_best` (RATCHET committed and metric strictly better) | No |
| `plateau` (N consecutive non-improvements) | Optional — `stop` to halt or `redirect: …` to inject |
| `aspirational_proposed` (PROPOSE added a candidate gate) | Yes if you want it locked |
| `termination` (target hit / max_iters / max_cost) | No |
| `hard_error` (BOOTSTRAP failed / iter crashed) | Investigate the workspace |

Replies arrive asynchronously through whatever your push command supports. The loop never blocks on a reply.

## Known limitations

- Single-track serial loop; no N-worktree population mode (state schema supports it for v2)
- Only `local` runner backend; no remote runner backends (SSH / cloud worker / message bus) yet
- No "explore mode" — multi-step refactors must be neutral-on-metric in one commit (Karpathy's documented trade-off)
- No webchat frontend (SSE endpoint is there, frontend deferred)
- Cross-task lessons store (à la AutoResearchClaw `MetaClaw`) not implemented
- ⚠️ **`bare: true` is not used** when starting child claude sessions because it skips loading `~/.claude/settings.json` env (and so loses custom-env-based auth on this user's setup). Cost: lose the `--exclude-dynamic-system-prompt-sections` + 1H cache optimisations. Real fix is upstream in `persistent-session.ts`.
- ⚠️ **`autoloop_resume` is wired and unit/smoke-tested**, but exotic states (dirty working tree at resume time, mid-COMPRESS death, mid-RATCHET stdin pipe death) are not exercised yet.

See `tasks/autoloop.md` §10 for the full failure-mode register.

---

## Autoloop v2 — three-agent architecture

v2 keeps three Claude sessions persistent across iterations and uses messages
on an inbox bus instead of fresh-spawn-per-phase. Design rationale and full
schemas live in `tasks/autoloop-v2.md`.

### Roles

| Agent | Engine | cwd | Owns |
|---|---|---|---|
| **Planner** | claude / opus | workspace | strategy, plan.md, goal.json, talking to you |
| **Coder** | claude / sonnet (override per spawn) | workspace | code changes, eval execution |
| **Reviewer** | claude / sonnet | `<workspace>/tasks/<run_id>/reviewer_sandbox/` | distrust audit; advance / hold / rollback |

### UX flow

```
1. autoloop_v2_start { run_id, workspace }
2. autoloop_v2_chat { run_id, text } → talk to Planner
3. Planner reads workspace, drafts plan.md + goal.json, asks "ready to spawn?"
4. autoloop_v2_chat { run_id, "go" } → Planner emits spawn_subagents
5. Coder + Reviewer self-iterate; you stay in chat with Planner
6. Planner pushes you (wechat → whatsapp → email fallback) on regression /
   decision / completion per push policy
7. Run terminates on target_hit, plan-defined max_iters, or your `terminate`
```

### Quick start

```bash
# Start
curl -X POST http://127.0.0.1:18789/v1/openclaw/tools/autoloop_v2_start \
  -d '{"run_id":"my-run","workspace":"/abs/path/to/workspace"}'

# Chat with Planner
curl -X POST http://127.0.0.1:18789/v1/openclaw/tools/autoloop_v2_chat \
  -d '{"run_id":"my-run","text":"Read the workspace and design a plan to fix X"}'

# Inspect state
curl http://127.0.0.1:18789/autoloop/v2/my-run/state

# SSE stream (for the upcoming 3-pane UI)
curl http://127.0.0.1:18789/autoloop/v2/my-run/events

# Reset Coder if it drifts
curl -X POST http://127.0.0.1:18789/v1/openclaw/tools/autoloop_v2_reset_agent \
  -d '{"run_id":"my-run","agent":"coder","eager_restart":true}'

# Stop
curl -X POST http://127.0.0.1:18789/v1/openclaw/tools/autoloop_v2_stop \
  -d '{"run_id":"my-run","reason":"done"}'
```

### Planner-emitted control tools

Planner controls the run by emitting fenced ` ```autoloop ` JSON blocks. The
dispatcher parses them out of every reply and applies them. You never see
the JSON — only the Planner's narrative reply.

| Tool | Args | What |
|---|---|---|
| `notify_user` | level, summary, detail?, channel? | push you out-of-band |
| `spawn_subagents` | coder_model?, reviewer_model?, initial_directive? | start Coder + Reviewer |
| `send_directive` | goal, constraints?, success_criteria?, max_attempts? | next iter's instruction |
| `pause_loop` | reason | halt subloop at next boundary (chat keeps working) |
| `resume_loop` | — | resume after pause |
| `terminate` | reason | end run |
| `update_push_policy` | partial PushPolicy | mutate notification rules |
| `write_plan_committed` | message? | git-commit current plan.md |
| `write_goal_committed` | message? | git-commit current goal.json |

### Push policy (defaults)

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

5-minute dedup on (level, summary). Channel chain: `auto` walks
wechat → whatsapp → email; `wechat` / `webchat` / `email` route directly;
`both` does webchat + wechat.

### Ledger layout

```
<workspace>/tasks/<run_id>/
├── plan.md              # Planner-authored, git-committed
├── goal.json            # Planner-authored, git-committed (v1 GoalSpec shape)
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

### Backend HTTP / SSE

| Endpoint | Returns |
|---|---|
| `GET /autoloop/v2/list` | `{ ok, runs: AutoloopV2RunState[] }` |
| `GET /autoloop/v2/<id>/state` | `{ ok, state: AutoloopV2RunState }` |
| `GET /autoloop/v2/<id>/push_log` | `{ ok, entries: PushLogEntry[] }` |
| `GET /autoloop/v2/<id>/events` | SSE: `snapshot` / `message` / `state` / `push` / `iter_done` / `planner_reply` / `coder_reply` / `reviewer_reply` / `terminated` |

The 3-pane UI (left: Planner chat, center: Coder activity, right: Reviewer
verdicts, top: state, bottom: push_log) consumes these endpoints. The UI
itself ships in a separate cross-repo PR.

### Known v2 limitations (3.5.0)

- **No auto-compact on token budget.** Manual `autoloop_v2_reset_agent`
  covers the same recovery path. Auto-compact is queued for a 3.5.x
  follow-up once `ISession.getStats` exposes the right hooks.
- **One-way push only.** WeChat → Planner inbound replies are not yet
  wired (would need an openclaw-gateway tmux-passthrough route). For now
  reply via webchat / `autoloop_v2_chat`.
- **No webchat UI yet.** Backend SSE is shipped; UI is a separate PR.
- **No fork mode** for parallel exploration. Single linear iter trajectory.

### Smoke

`scripts/smoke-autoloop-v2.ts` runs a buggy add_two scenario end-to-end
with Opus Planner + Sonnet × 2. Validates plan.md / goal.json commit,
spawn, iter 0 ledger artifacts, terminate on target_hit. Cost ~$1-3,
wall-clock ~5-15 min.
