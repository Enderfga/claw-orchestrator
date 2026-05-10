# Autoloop — Reference

Autonomous iteration loop for a git workspace. Given an intent (`plan.md`) and success criteria (`goal.json`), the loop edits the code, runs gates, ratchets on a faithful metric, and pushes you only when it has to.

Full design rationale lives in `tasks/autoloop.md`. This page is the operator reference.

## When to use

- You can write down what "better" means as a shell command (test pass count, latency, loss, gate completion). Without that, ratchet has no anchor and the loop will drift — see `tasks/autoloop.md` §10.
- The workspace runs on the local box (or wherever the orchestrator is hosted). v1 runner is local subprocess only.
- You want the orchestrator to keep iterating while you do something else, and to push you on new-best / plateau / question.

## Quick start

```bash
# 1. Author plan.md (intent) and goal.json (success criteria) somewhere — see §Examples.

# 2. Start the loop (via openclaw plugin tool or HTTP)
curl -X POST http://127.0.0.1:18789/v1/openclaw/tools/autoloop_start \
  -H 'content-type: application/json' \
  -d '{
    "workspace": "/Users/me/projects/nano-gpt",
    "plan_path": "/Users/me/projects/nano-gpt/plan.md",
    "goal_path": "/Users/me/projects/nano-gpt/goal.json"
  }'
# → { ok: true, id: "autoloop-...", task_dir: ".../tasks/autoloop-...", current_phase: "RUNNING" }

# 3. Watch
curl http://127.0.0.1:18789/autoloop/<id>/events     # SSE stream
# or poll
curl -X POST http://127.0.0.1:18789/v1/openclaw/tools/autoloop_status -d '{"id":"<id>"}'

# 4. Inject a hint (becomes input to next PROPOSE)
curl -X POST http://127.0.0.1:18789/v1/openclaw/tools/autoloop_inject \
  -d '{"id":"<id>","text":"try LR warmup 500 steps"}'

# 5. Stop
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
    "target": 0.95,
    "noise_floor": 0.005   // changes within ±noise are not improvements
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

## Known limitations (v1)

- Single-track serial loop; no N-worktree population mode (state schema supports it for v2)
- Only `local` runner backend; no remote runner backends (SSH / cloud worker / message bus) yet
- No "explore mode" — multi-step refactors must be neutral-on-metric in one commit (Karpathy's documented trade-off)
- No process-restart recovery
- No webchat frontend (SSE endpoint is there, frontend deferred)
- Cross-task lessons store (à la AutoResearchClaw `MetaClaw`) not implemented

See `tasks/autoloop.md` §10 for the full failure-mode register.
