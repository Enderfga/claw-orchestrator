# Autoloop — Design

> Status: **draft**, awaiting user review. Branch: `feat/autoloop`.
>
> One-line: given a git workspace + an idea + a goal spec, an LLM-driven loop iterates and ratchets toward the goal autonomously. Async-push the human only when faithful metric is absent or when aspirational gates need approval. Never block on stdin.

## 1. Design Constraints (extracted from prior-art survey)

These are the hard rules. Violating any of them collapses the loop into rubber-stamp drift or runaway cost.

| # | Rule | Source |
|---|---|---|
| C1 | Ledger and code share a single git tree; `git reset` reverts both atomically. | Karpathy autoresearch, Anthropic harness, AAR — all converge here |
| C2 | Ratchet reviewer is a **separate process** with read-only access to code+metric and write access only to one decision bit in `state.json`. Not a prompt; structurally enforced. | Anthropic harness `passes` field; Lesson 10 |
| C3 | Test data and metric script are **agent-unreadable** from the worktree. Hashed, separate process, isolated dir. | AAR's 4 reward-hacking incidents |
| C4 | Inner loop never blocks on human. Async push only. | Karpathy's explicit ban; AutoResearchClaw SmartPause is async |
| C5 | Three kill switches: per-iter wall-clock (kill subprocess group), global iter cap, global cost cap. Token cap alone does not catch hung subprocesses. | OpenHands #2705 install loops |
| C6 | BOOTSTRAP is a distinct phase. Failure exits before entering loop. | OpenHands; most prod failures are bootstrap, not iteration |
| C7 | `state.json` schema supports parent-of-children from day 1, even though v1 runs serial. Future population mode reuses same ledger. | AlphaEvolve / AAR 9-parallel; Wrong-thing #3 |
| C8 | COMPRESS produces a deterministic fixed-schema artifact, not a free-text chat summary. | Anthropic `claude-progress.txt`; Lesson 9 |
| C9 | Default behavior is to ACT, not ASK. "Sufficient proactivity" is a stated user goal. | User instruction |

## 2. Two Worked Scenarios

### Scenario A — Iterative metric improvement (Karpathy autoresearch shape)

User input:

```yaml
workspace: /Users/x/projects/nano-gpt-experiment
plan.md: |
  Improve val_bpb on shakespeare-char.
  Constraints: must train on single A100 in <10 min/run.
  Don't change tokenizer. Don't change eval set.
  Initial idea: try AdamW betas tuning then explore RoPE variants.
goal.json: see below
```

```jsonc
{
  "scalar": {
    "name": "val_bpb",
    "direction": "min",
    "extract_cmd": "python eval.py --json | jq .val_bpb",
    "target": 0.95,
    "noise_floor": 0.005     // changes within ±noise are not improvements
  },
  "gates": [
    { "name": "trains_in_time", "cmd": "timeout 600 python train.py", "must": "exit-0" },
    { "name": "no_test_leak",   "cmd": "scripts/check_no_test_leak.sh", "must": "exit-0" }
  ],
  "aspirational_gates": [],     // agent may propose; user must lock
  "termination": {
    "scalar_target_hit": true,
    "max_iters": 100,
    "plateau_iters": 10,        // 10 consecutive non-improvements → push human
    "max_cost_usd": 50
  }
}
```

Loop behavior: PROPOSE edits training code → EXECUTE runs `train.py` (with kill at 600s) → MEASURE extracts `val_bpb` → RATCHET (separate process) checks `gates AND scalar_improved_beyond_noise` → commit on success, `git reset --hard` on failure. After 10 plateau iters or scalar target reached → async push user.

This is essentially Karpathy autoresearch, with hard gates added (Anthropic's `passes` field pattern).

### Scenario B — Paper deep-research (subjective shape, no native scalar)

User input:

```yaml
workspace: /Users/x/research/paper-2310.06825-deepdive
plan.md: |
  Deeply research arXiv:2310.06825 (Mistral 7B).
  Output: research-report.md covering:
    - claim-by-claim extraction with original-vs-derived attribution
    - related-work map (≥10 relevant papers, each with comparison)
    - identified open questions + my reasoning on each
    - critique: which claims are weakest, why
  Allow web search. Cite all external sources.
goal.json: see below
```

```jsonc
{
  "scalar": {
    "name": "gate_completion",
    "direction": "max",
    "extract_cmd": "scripts/count_gates.sh",   // computed from gate states
    "target": 1.0,
    "noise_floor": 0
  },
  "gates": [
    { "name": "report_exists",         "cmd": "test -f research-report.md", "must": "exit-0" },
    { "name": "claims_extracted",      "cmd": "scripts/check_claims.sh ≥15", "must": "exit-0" },
    { "name": "related_work_≥10",      "cmd": "scripts/check_citations.sh ≥10", "must": "exit-0" },
    { "name": "open_questions_present", "cmd": "scripts/check_section.sh 'Open Questions' ≥5", "must": "exit-0" },
    { "name": "critique_present",      "cmd": "scripts/check_section.sh 'Critique' ≥3", "must": "exit-0" },
    { "name": "all_citations_resolve", "cmd": "scripts/verify_citations.sh", "must": "exit-0" }
  ],
  "aspirational_gates": [],     // agent will populate during BOOTSTRAP after reading paper
  "termination": {
    "scalar_target_hit": true,
    "max_iters": 50,
    "plateau_iters": 8,
    "max_cost_usd": 30
  }
}
```

Loop behavior:
- BOOTSTRAP reads the paper, **proposes ~10 aspirational_gates** (e.g., "compare to LLaMA-2 7B param efficiency", "address sliding-window attention's KV-cache implication"), pushes them to user.
- User async-replies via wechat: lock 6 of 10, reject 2, modify 2. Locked ones move to `gates`. Loop never blocked — agent works on aspirational ones in the background; only locked ones count toward `gate_completion`.
- PROPOSE edits `research-report.md` to fill the next unfilled gate.
- EXECUTE runs gate-check scripts (no model invocation).
- MEASURE recomputes `gate_completion`.
- RATCHET commits if `gate_completion` strictly increased AND no previously-passing gate broke (regression detection is just a re-check).
- New aspirational gates can be added by agent any time → async push for approval.

**This is the deep-research shape.** Note: the entire correctness mechanism is still scalar+gates — but here the "scalar" is itself derived from gate states. The agent cannot game it because gate-check scripts run in a separate process and the gates' `cmd` fields are user-locked once approved.

## 3. Phase Machine

```
BOOTSTRAP   ─┐
             │ (one-shot, validated, must succeed before entering loop)
             ▼
  ┌────  PROPOSE  ───── EXECUTE  ───── MEASURE  ───── RATCHET ──┐
  │                                                              │
  │     (every K iters, run COMPRESS, then continue)             │
  │                                                              │
  └────────────────  loop until termination  ────────────────────┘

termination triggers:
  - goal.json.termination.scalar_target_hit reached
  - max_iters
  - plateau_iters consecutive non-improvements (push human, await ack/redirect)
  - max_cost_usd
  - hard error in BOOTSTRAP or unrecoverable invariant violation
```

### 3.1 Phase contracts

Each phase has a strict contract: which files it reads, which it writes, what it must produce. Anything outside the contract is a violation that RATCHET catches.

| Phase | Reads | Writes | Subprocess | Time cap | Notes |
|---|---|---|---|---|---|
| BOOTSTRAP | `plan.md`, `goal.json`, workspace tree | `current.md`, initial `metric.json`, optional `aspirational_gates` push | one-shot LLM with worktree access | 5 min | Validates workspace runs; produces baseline metric. Failure aborts. |
| PROPOSE | `current.md`, `plan.md`, `goal.json`, `history.md`, last few `iter/<n>/` | code edits + updated `current.md` | one-shot LLM with worktree access | 3 min | Must commit changes (incl. ledger) on its own branch `autoloop/iter-<n>`. |
| EXECUTE | post-PROPOSE worktree | `iter/<n>/run.log`, `iter/<n>/eval.json` | shell subprocess (gate `cmd`s + scalar `extract_cmd`); **no LLM** | gate-specific timeouts | Process group; killed on timeout. |
| MEASURE | `iter/<n>/eval.json`, prior `metric.json` | appends to `metric.json`, sets `state.json.last_metric` | pure JS, no LLM, no shell beyond reading | 5 sec | Mechanical aggregation. |
| RATCHET | `metric.json`, gate results, `goal.json`, prior `state.json.best` | flips `state.json.decision` to `commit` or `reset`, may push human | **separate LLM subprocess, different model**, only sees: scalar, gate results, `current.md` summary. **Cannot read worktree code.** | 1 min | Asymmetric: prompt insists on finding regressions / reward hacks. On `reset`: shells out `git reset --hard <prev>`. |
| COMPRESS | `iter/<n_old>..<n_recent>/`, prior `history.md` | new `history.md`, deletes `iter/<n_old..n-K>/` artifacts | one-shot LLM | 2 min | Fixed schema (see §5). Runs every K iters (default 10). |

### 3.2 Process isolation enforced

- **PROPOSE / BOOTSTRAP**: standard claw-orchestrator session, full worktree write access, scoped to `tasks/<id>/` + workspace.
- **EXECUTE**: spawned via `child_process.spawn` with `detached: true` for kill-on-timeout. No LLM in the loop. Pure shell.
- **RATCHET**: spawned as separate `claude --output-format stream-json` (or different engine entirely; see §6) **with a custom prompt that pipes only `eval.json + metric.json + current.md (summary section)` via stdin**. Worktree is not on its `cwd`. Cannot read source code. Output JSON parsed for `{ decision: "commit"|"reset", reason: string, push_user?: PushReq }`.
- **MEASURE / COMPRESS**: trivial; MEASURE in JS, COMPRESS in standard session.

This is C2 + C3 made concrete.

## 4. Ledger Files (all under `tasks/<id>/`, all git-tracked)

```
tasks/<id>/
  plan.md                      # human-authored; immutable after BOOTSTRAP unless human edits
  goal.json                    # human-authored; gates can grow via approved aspirational
  current.md                   # PROPOSE writes; "current best summary + next proposal"
  state.json                   # canonical state; only RATCHET writes decision; PROPOSE/MEASURE write their own subkeys
  metric.json                  # append-only history of metric points
  history.md                   # COMPRESS writes; fixed schema
  iter/
    <n>/
      diff.patch               # produced by PROPOSE
      run.log                  # EXECUTE stdout/stderr
      eval.json                # EXECUTE structured output: gate results + scalar
      ratchet.json             # RATCHET decision + reason
```

### 4.1 `state.json` schema (frozen)

```jsonc
{
  "task_id": "<id>",
  "branch": "feat/autoloop-<id>",
  "phase": "BOOTSTRAP" | "PROPOSE" | "EXECUTE" | "MEASURE" | "RATCHET" | "COMPRESS" | "IDLE" | "TERMINATED",
  "iter": 7,
  "started_at": "2026-05-10T12:00:00Z",
  "best": {
    "iter": 5,
    "metric": 0.41,
    "git_sha": "abc123",
    "gate_completion": 0.83
  },
  "last_metric": { "iter": 7, "metric": 0.40, "gate_completion": 0.83 },
  "plateau_count": 2,
  "decision": null | "commit" | "reset",   // only RATCHET writes
  "decision_reason": null | "scalar improved beyond noise; all gates pass",
  "tree": {                          // C7: parent-of-children from day 1
    "parent_iter": 5,                // for serial: always points to last commit
    "children_iters": [7]            // for population: list of forks
  },
  "termination": {
    "fired": false,
    "reason": null
  },
  "cost_usd_so_far": 4.12
}
```

### 4.2 `metric.json` schema (append-only)

```jsonc
[
  { "iter": 0, "ts": "...", "metric": 0.50, "gate_completion": 0.0, "phase_at_record": "BOOTSTRAP" },
  { "iter": 1, "ts": "...", "metric": 0.48, "gate_completion": 0.17, "phase_at_record": "MEASURE", "git_sha_pre": "...", "git_sha_post": "..." }
]
```

### 4.3 `history.md` schema (fixed; COMPRESS output)

```markdown
# History — autoloop <id>

## Iters 0–9 (compressed at iter 10)

**Best so far**: 0.41 at iter 5 (sha abc123).

**Tried and worked**:
- iter 1: AdamW betas (0.9, 0.99) → val_bpb 0.50 → 0.48
- iter 5: cosine schedule with min_lr=3e-5 → 0.43 → 0.41

**Tried and rolled back** (reasons in iter/<n>/ratchet.json):
- iter 2: bigger batch 32→64 → metric same but gate `trains_in_time` failed
- iter 3: RoPE base 10000→500000 → val_bpb regressed to 0.51
- iter 4: dropout 0.0→0.1 → val_bpb 0.52
...

**Open hypotheses** (carry forward):
- LR warmup length under-tuned; try 200→500 steps
- (etc.)

**Aspirational gates approved this segment**: 0
```

Fixed schema means: PROPOSE can parse `Best so far`, `Open hypotheses`, etc. without fuzzy regex.

## 5. Push Contract

The loop pushes via `openclaw message send` (microsoft → wechat). Inner loop never awaits a reply. Pushes are fire-and-forget; replies come back through a separate `inbox/` directory polled by RATCHET only.

| Trigger | What | Reply expected? | Reply handling |
|---|---|---|---|
| BOOTSTRAP completes with aspirational_gates | "I read the paper. Proposing 10 aspirational gates: [...] Reply with `lock 1,3,4` or `reject 2,5` or paste your edits." | yes (async) | Polled by every RATCHET; locked gates appear in `goal.json` next iter |
| RATCHET hits new best | "iter 7: 0.41 → 0.40. Sha def456." | no | — |
| RATCHET sees plateau ≥ N | "Plateau 8 iters; metric stuck at 0.41. Continue / redirect / stop?" | yes | Default: continue if no reply within next iter cycle |
| RATCHET on no-faithful-metric task and unsure | "iter 7 produced X. I'm unsure if it's better. Approve / reset / paste guidance?" | optional | Default: reset (conservative) |
| Termination | "Done. Best 0.39 at iter 23. Cost $12.40." | no | — |
| Hard error | "BOOTSTRAP failed: <reason>. Loop not started." | no | — |

C9 (proactivity) means: when in doubt, the loop **acts** (defaults to reset, defaults to continue) and informs you. It does not stop and wait.

## 6. Ratchet Reviewer — Why a Different Engine

C2 says RATCHET is a separate process. Stronger version: **use a different engine** if available. Reasoning:

1. Same model + same prompt-style → correlated failure modes (a coder Sonnet that misses a bug will likely also rubber-stamp itself when reviewing).
2. claw-orchestrator already has 5 engines wired (Claude / Codex / Gemini / Cursor / OpenCode). RATCHET defaults to whichever is **not** the PROPOSE engine.
3. The RATCHET prompt (see `src/autoloop-prompts/ratchet.md` once written) is effectively the council-reviewer prompt minus the council parts: "do NOT trust metric.json. find rewards being hacked. find regressions. your job is to reset, not commit."

This costs more tokens. Worth it; C2 is a hard rule.

## 7. CLI / API surface

```bash
# Start
clawd autoloop start <workspace> --plan ./plan.md --goal ./goal.json [--id my-task]

# Status (cheap, just reads state.json)
clawd autoloop status <id>

# Inject a message into the loop (becomes input to next PROPOSE)
clawd autoloop inject <id> "try lr warmup 500 steps"

# Stop
clawd autoloop stop <id>
```

Plus tool variants for openclaw plugin consumers: `autoloop_start`, `autoloop_status`, `autoloop_inject`, `autoloop_stop`.

Plus SSE endpoint stub (no v1 frontend): `GET /autoloop/<id>/events` streams `{ phase, iter, ledger_diff }`.

## 8. v1 Scope and Cuts

**In v1**:
- Scenarios A and B from §2
- Single-track serial loop, but `state.json.tree` schema supports population
- Ratchet via different engine (Sonnet propose / Opus ratchet by default; configurable)
- `local` runner only (subprocess on the box running claw-orchestrator)
- Push via `openclaw message send`
- SSE endpoint stub, no frontend

**Deferred**:
- remote runner backends (SSH / cloud worker / message bus) → v2
- N-worktree population mode → v2
- "Explore mode" suspending RATCHET for multi-step refactors → v3
- Webchat visualization frontend → v3 (SSE endpoint already there for it)
- Cross-task `MetaClaw`-style lessons store → v3

## 9. Open Questions for User

1. **Ratchet engine pairing**: default `propose=sonnet, ratchet=opus`? Or different mix? Cost vs strictness.
2. **Aspirational gates approval flow**: lock-on-reply (current §5) vs lock-after-N-iters-of-self-validation (more autonomous, higher gaming risk)?
3. **`tasks/<id>/` location**: inside the workspace repo (so ledger versions with code, C1) — but this litters the user's repo. Alternative: separate `~/.clawd/autoloop/<id>/` dir + symlinks. Recommendation: **inside the workspace** for C1, but only `tasks/<id>/` (not `tasks/`) is added; user gitignores `tasks/` if they don't want it tracked, with a warning that they lose atomic rollback.
4. **Plateau push default**: continue or stop? Currently defaults to continue (C9 proactivity), reverses the conservative default.

## 10. Failure Modes We Are Knowingly Accepting

| Mode | Source | Mitigation we have | Residual |
|---|---|---|---|
| Reward hacking on scalar | AAR's 4 hacks | C3 isolates test data; gates re-checked separately | Possible if gates are weak; user-locked gates are user's responsibility |
| Plateau on hard task | AlphaEvolve | Plateau push to human | No population escape; v1 limitation |
| Multi-step refactor blocked | Karpathy's "by design" | None | Accepted; v3 explore mode |
| Bootstrap loops on broken workspace | OpenHands #2705 | BOOTSTRAP wall-clock cap; abort on failure | None — workspace must be runnable to start |
| Aspirational gates ballooning | Novel; not seen in prior art | User must approve to lock; cap on aspirational count? **TBD in §9.2** | Untested |
