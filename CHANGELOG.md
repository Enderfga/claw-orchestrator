# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [3.6.0] - 2026-05-11

### Added — autoloop ergonomics & guardrails

- **Reviewer frozen-memory injection.** `reviewer_memory.md` is now read at
  Reviewer-session start and inlined as a `<frozen_memory_snapshot>` block in
  the system prompt. The snapshot stays constant for the session's lifetime,
  so the prefix cache hits on every iter; edits to the file on disk take
  effect on the next Reviewer reset.
- **Phase-error circuit breaker.** Consecutive `phase_error` messages
  (subprocess deaths, failed `git commit`, etc.) count toward a configurable
  threshold (`phaseErrorCircuit`, default `3`). When tripped, the runner
  emits a `decision`-level push and auto-terminates with reason
  `phase_error_circuit`. A successful `iter_done` resets the count.
- **Stall detection.** A wall-clock timer fires `on_stall_30min` when the
  runner has processed no messages for `stallMs` (default 30 min) while
  `status === 'running'`. Configurable via `stallMs` /
  `stallCheckIntervalMs`.
- **`decisions.jsonl` audit trail.** `terminate`, `reset_agent`,
  `update_push_policy`, `compact`, `spawn_subagents`, `phase_error`, and
  rejected silence attempts write structured entries to
  `<ledger>/decisions.jsonl`.
- **`prior_metrics` history.** Runner keeps the last 20 verdict metrics and
  passes the most recent 10 in every `review_request`, finally enabling the
  Reviewer rubric's "metric improved but eval unchanged" check.
- **Ledger `schema_version`.** `directive.json` / `eval_output.json` /
  `verdict.json` now carry `schema_version: 1` for forward-compatible
  migrations.

### Fixed — autoloop correctness

- **`state.iter` no longer pinned at `0`.** It advances by one per committed
  `review_verdict`, so SSE events, `iter_done` payloads, push summaries and
  ledger directories all point at the right iter. The dispatcher also bumps
  the iter passed into Planner-tool handlers when responding to an
  `iter_done(N)`, so follow-up directives correctly target iter `N+1`.
- **`pause_loop` is enforced.** Previously a no-op; the runner now parks
  agent-bound messages in a paused-buffer and replays them in order on
  `resume`. `terminate` / runner-bound messages still process while paused.
- **Coder / Reviewer subprocess death surfaces as `phase_error`.** A failed
  `sendWithRecovery` retry used to masquerade as a "clarification request",
  hiding the most common failure mode. A new `fatal` marker now flows into
  a `phase_error` envelope and feeds the circuit.
- **Reviewer sandbox restage preserves `reviewer_log.jsonl`.** The whitelist
  also keeps the append-only audit log the Reviewer prompt has always
  promised.
- **Git commit failure inside an iter** (hook reject, signing missing) is
  surfaced as `phase_error` instead of writing a stale `iter_artifacts`
  with a phantom diff.
- **Planner prompt drift.** Removed stale references to
  `src/autoloop/v1/types.ts` (file does not exist) and the "S2 has no
  `notify_user`" line that kept Planner from ever pushing the user.

### Changed

- **`update_push_policy` cannot silence `on_phase_error` or
  `on_decision_needed`.** The `silent` flag is stripped (other fields on
  the same rule still apply) and the attempt is recorded in
  `decisions.jsonl`. Prevents a confused Planner from muting the
  operator's lifeline channels.
- **`firePolicyPush` self-drains** when called outside an active drain
  (notably from the stall-detector interval), so policy pushes always
  reach the notifier.
- **`notify` reads recipient env vars at call time** rather than caching
  them at module load — operators can rotate the env without restarting.

### Tests

- New `src/__tests__/autoloop-dispatcher.test.ts` (7 tests) covering
  frozen-memory injection, phase_error surfacing, policy silencing guard,
  sandbox whitelist, auto-compact + decisions.jsonl, ledger schema_version.
- New `src/__tests__/autoloop-notify.test.ts` (5 tests) covering the
  fallback chain (wechat → whatsapp → email), env-var gating, webchat
  no-op, and `appendPushLog` formatting.
- Extended `src/__tests__/autoloop-runner.test.ts` (16 tests, was 10)
  with iter-advance, pause enforcement, phase-error circuit, prior_metrics
  history, and stall detection.

## [3.5.6] - 2026-05-11

### Fixed — embedded HTTP server auth-by-default (closes #61)

The embedded HTTP server now requires authentication on every endpoint
except `/health`. Previously it ran unauthenticated unless `OPENCLAW_SERVER_TOKEN`
was explicitly set (CWE-306).

| Mode | Trigger |
|---|---|
| **Auto-generate** (new default) | unset env var → server writes a fresh 32-byte token to `~/.openclaw/server-token` (mode 0600) at startup. |
| **Explicit token** (unchanged) | `OPENCLAW_SERVER_TOKEN=<value>` |
| **Disabled** (opt-out, new) | `OPENCLAW_SERVER_TOKEN=disabled` — single-user host only; logs a loud warning |

Three ways to authenticate (all equivalent):

1. `Authorization: Bearer <token>` header — for CLIs / scripts.
2. `clawo_auth=<token>` cookie — set automatically when a browser hits
   `/dashboard?token=<token>`. Subsequent same-origin fetches and
   `EventSource` connections inherit the cookie.
3. `?token=<token>` query string — the bootstrap path for the dashboard;
   the server upgrades it to the cookie on the same response.

The `clawo` CLI now reads the token automatically (env vars
`CLAWO_AUTH_TOKEN` / `OPENCLAW_SERVER_TOKEN`, falling back to
`~/.openclaw/server-token`). The dashboard URL printed at server start
contains the token query — clicking it in a browser establishes the
cookie, after which the URL can be bookmarked at plain `/dashboard`.

### Changed

- 4 new tests in `src/__tests__/embedded-server.test.ts` cover the
  query-token → cookie handoff, cookie-only auth, the new auto-generate
  default, and the `disabled` sentinel.

## [3.5.5] - 2026-05-11

### Added — three-agent autoloop architecture

The previous autoloop (single-threaded phase machine that respawned a fresh
Claude session per phase) is replaced with three persistent agents:

- **Planner** (Opus, your chat interface) — long-lived; owns strategy,
  writes `plan.md` / `goal.json`, decides when to push you out-of-band.
- **Coder** (Sonnet) — receives directive, applies change, runs the
  evaluator, emits structured `iter_complete`.
- **Reviewer** (Sonnet, sandboxed cwd) — distrustful audit; advance /
  hold / rollback per iter.

Plugin tools: `autoloop_start`, `autoloop_chat`, `autoloop_status`,
`autoloop_list`, `autoloop_stop`, `autoloop_reset_agent`. The Planner
controls the run via fenced ` ```autoloop ` JSON blocks (`notify_user`,
`spawn_subagents`, `send_directive`, `pause_loop`, `resume_loop`,
`terminate`, `update_push_policy`, `write_plan_committed`,
`write_goal_committed`).

Push policy: silent on iter-done-ok; pushes on `target_hit`, 2-iter
regression, 2-iter reviewer reject, phase error, 30-min stall, or
decision-needed. 5-min dedup on (level, summary). Channels are configured
via env vars (`AUTOLOOP_WECHAT_RECIPIENT`, `AUTOLOOP_WECHAT_ACCOUNT`,
`AUTOLOOP_WHATSAPP_RECIPIENT`); an unset channel is silently skipped and
the fallback chain moves to the next tier (email via push-api-skill is
the final tier).

Auto-compact: per-agent thresholds (Planner 80%, Coder/Reviewer 70%) on
`getStats().contextPercent`; `/compact` dispatched with a role-specific
preservation hint; 30 s cooldown; surfaces as a `compact` SSE event.

### Added — embedded dashboard

Single-page vanilla dashboard at `GET /dashboard`. Two tabs:

- **Autoloop**: list of runs in left rail; click into one for a 3-pane
  view (Planner ⇄ user + chat composer / Coder activity / Reviewer
  verdicts). Top bar shows iter/status/push count; bottom strip shows
  recent pushes.
- **Council**: list of council sessions + live agent-response stream
  with round-by-round verdicts and consensus marker.

Backend HTTP/SSE: `GET /autoloop/list`, `/autoloop/<id>/state`,
`/autoloop/<id>/push_log`, `/autoloop/<id>/events`, and the same shape
for `/council/{list,<id>/state,<id>/events}`.

### Changed

- Build now `rm -rf dist` before `tsc` so renamed/relocated sources can't
  leave stale artefacts behind.
- `tasks/` is in `.gitignore` — internal design / WIP notes live locally
  only.

## [3.5.3] - 2026-05-10

### Added — auto-compact on context-budget threshold

Each agent session is monitored after every turn via `getStats().contextPercent`.
When it crosses the per-agent threshold the dispatcher dispatches `/compact`
with an agent-specific summary hint:

| Agent | Default threshold | What `/compact` is told to preserve |
|---|---|---|
| Planner | 80% | current plan / goal, decisions with the user, what's been tried + rejected, user prefs, iter verdicts |
| Coder | 70% | codebase familiarity, attempted patches, current working state, plan + goal |
| Reviewer | 70% | fakery patterns caught, recent metrics, structural rules from goal.json |

Per-run override via `compactThresholds: { planner?, coder?, reviewer? }` on
the dispatcher config. 30-second cooldown prevents back-to-back compactions.

Surfaces as a new `compact` SSE event on `/autoloop/<id>/events` (alongside
`planner_reply` / `coder_reply` / `reviewer_reply`); the embedded dashboard
renders it as an inline `[auto-compact 82% ≥ 80% — /compact dispatched]`
system entry in the relevant pane.

Closes the last design-doc deferred item (auto-compact, design doc §7.1).
Manual `autoloop_reset_agent` still available for nuclear reset.

## [3.5.2] - 2026-05-10

### Fixed

- Autoloop HTTP routes (`/autoloop/<id>/state`, `/autoloop/<id>/push_log`,
  `/autoloop/<id>/events`) returned 404 in 3.5.0 and 3.5.1 because the
  regex patterns were `/^\/autoloop\/v2\/.../` (left-over from when the
  paths still had a `/v2/` prefix); the `/v2/` was stripped from URLs in
  the 3.5.0 collapse but the escaped slashes in the regex source weren't
  caught by the rename. Reported by `/dashboard` failing to populate the
  detail pane.

  `/autoloop/list` was unaffected (its match was a literal string compare,
  not a regex), so the dashboard sidebar populated correctly while the
  detail / push_log / SSE endpoints all 404'd.

## [3.5.1] - 2026-05-10

### Added — embedded dashboard

Single-page vanilla dashboard at `GET /dashboard`, served by the embedded
HTTP server. Two tabs:

- **Autoloop** — list of active runs in the left rail; selecting one shows a
  3-pane view: Planner ⇄ user (with chat composer), Coder activity, Reviewer
  verdicts. Top bar surfaces `status / iter / subagents_spawned / push count`;
  bottom strip shows the last 20 push events. Live via SSE on `/autoloop/<id>/events`.
- **Council** — list of active council sessions; selecting one shows the
  agent-response stream (round-by-round, with a consensus marker on
  `agent-complete`). Live via SSE on `/council/<id>/events` (new in this release).

Zero new dependencies — single static `src/dashboard/index.html` (~870 lines,
inline CSS + vanilla JS using `EventSource`). Visual blueprint cribbed from
`webchat/app/council/council.module.scss` so colours and spacing match.

### Added — council SSE/HTTP endpoints

Mirrors the autoloop endpoints shipped in 3.5.0:

- `GET /council/list` — all council sessions known to the manager
- `GET /council/<id>/state` — current `CouncilSession` snapshot
- `GET /council/<id>/events` — SSE stream of `snapshot` + `council-event`
  events (every `Council` emit lands here)

`SessionManager` gains `councilList()` and `getCouncil(id)` helpers.

### Build

`scripts/postbuild.mjs` now copies non-TS dashboard assets from
`src/dashboard/` into `dist/src/dashboard/` so the published package serves
the page identically to dev.

## [3.5.0] - 2026-05-10

### ⚠️ Breaking — Autoloop replaced with three-agent architecture

The `autoloop_*` plugin tools shipped in 3.4.x kept their **names** but their
**signatures and semantics changed**. Specifically:

- `autoloop_start` now takes `{ run_id, workspace }` — no longer takes
  `plan_path` / `goal_path` (the Planner authors those itself in chat).
- `autoloop_resume` / `autoloop_inject` are **gone**. Replaced by
  `autoloop_chat` (talk to Planner directly) and `autoloop_reset_agent`
  (recover a drifted Coder/Reviewer).
- `tasks/<id>/state.json` schema is different. Old-shape ledgers from 3.4.x
  cannot be resumed by 3.5.x.
- Removed exports: the old phase-machine `AutoloopRunner`, plus `GoalSpec`
  / `GateSpec` / `ScalarSpec` / `AutoloopPhase` / `RatchetOutput` / etc
  (those were specific to the old phase machine; the new architecture's
  goal.json is free-form Planner-authored JSON).

If you have scripts calling 3.4.x autoloop tools, they will fail. Migration:
swap to `autoloop_start { run_id, workspace }` + `autoloop_chat` + give the
Planner a sentence describing the goal instead of writing plan.md/goal.json
yourself.

### Added — three-agent autoloop architecture

Replaced the single-threaded phase machine (BOOTSTRAP → PROPOSE → EXECUTE →
MEASURE → RATCHET → COMPRESS, fresh session per phase) with **three
persistent agents**:

- **Planner** (Opus) — your chat interface. Long-lived. Owns strategy,
  writes plan.md / goal.json, decides when to push you.
- **Coder** (Sonnet) — receives directive, makes the change, runs the
  evaluator, emits structured iter_complete.
- **Reviewer** (Sonnet, sandboxed cwd) — distrustful audit. Decides
  advance / hold / rollback per iter.

**Why:** the old machine paid context-rebuild cost every phase (token
waste) and had no specialisation accumulation. Persistent agents keep
codebase familiarity / fakery patterns warm across iterations.

**Plugin tools**: `autoloop_start`, `autoloop_chat`, `autoloop_status`,
`autoloop_list`, `autoloop_stop`, `autoloop_reset_agent`.

**Planner control** via fenced ` ```autoloop ` JSON blocks the dispatcher
parses out of every reply: `notify_user`, `spawn_subagents`,
`send_directive`, `pause_loop`, `resume_loop`, `terminate`,
`update_push_policy`, `write_plan_committed`, `write_goal_committed`.

**Push policy** (default): silent on iter-done-ok; push on target_hit,
2-iter regression, 2-iter reviewer reject, phase error, 30-min stall, or
explicit decision-needed. WeChat → WhatsApp → email fallback chain
(mirrors push-api-skill SKILL.md §B). 5-minute dedup on (level, summary).

**Backend SSE/HTTP** for the upcoming 3-pane UI:
- `GET /autoloop/list`
- `GET /autoloop/<id>/state`
- `GET /autoloop/<id>/push_log`
- `GET /autoloop/<id>/events` — SSE: `snapshot` / `message` / `state` /
  `push` / `iter_done` / `planner_reply` / `coder_reply` / `reviewer_reply`
  / `terminated`

**Ledger** under `<workspace>/tasks/<run_id>/`: `plan.md`, `goal.json`,
`push_log.jsonl`, `iter/<n>/{directive,eval_output,diff.patch,verdict}.json`,
`reviewer_sandbox/` (Reviewer cwd; runner restages per-iter artifacts).

**Validated**: live e2e smoke (`scripts/smoke-autoloop.ts`) converged the
buggy add_two scenario in one iter with Opus Planner + Sonnet × 2.

### Deferred (v3.5.x follow-ups)

- **Auto-compact on token-budget threshold** — manual `autoloop_reset_agent`
  covers the same recovery paths today.
- **WeChat-inbound replies → Planner** — currently one-way push; reply via
  webchat / `autoloop_chat`.
- **ChatGPT-Next-Web 3-pane UI** — separate cross-repo PR (backend
  contract is shipped in this release).

## [3.4.2] - 2026-05-10

### Changed

- Minor wording cleanup in autoloop reference docs and CHANGELOG. No functional changes; the 3.4.1 release is identical in behaviour. Use 3.4.2 going forward.

## [3.4.1] - 2026-05-10

### Fixed — autoloop production-readiness pass

After end-to-end smoke and Scenario 2 (paper review) live runs, five fixes:

- **Cost tracking via `manager.getCost()`** — replaced events-based extraction (which silently returned `$0` because the event stream is empty without `bare:true`) with `readCostUsd(manager, sessionName, result)` that queries the session's authoritative cost before stop. Verified: smoke now reports `$0.40` (was `$0.00`).
- **`autoloop_resume` tool + SessionManager.autoloopResume()** — recover from orchestrator process death (gateway restart, OOM, machine reboot). Reads `tasks/<id>/state.json` + `plan.md` + `goal.json`, skips BOOTSTRAP, git-resets workspace to last best (or `bootstrap_sha` baseline), continues from next iter. Refuses to resume already-terminated runs.
- **`ScalarSpec.extract_timeout_sec`** — separates the scalar's shell wall-clock from the LLM-call cap. Default 600s; for long ML evals set e.g. `14400` (4h) in `goal.json`. Previously shared `per_iter_timeout_ms`.
- **Scope discipline in propose + ratchet prompts** — `plan.md`'s `## Scope` / `## Constraints` / `## Read-only files` / `## Allowed paths` blocks are now HARD constraints. RATCHET rule #2 is "Scope violation → reset" (between gate-regression and aspirational-only). PROPOSE prompt explicitly enumerates how to interpret each constraint type. Default to narrower interpretation when ambiguous.
- **`state.json.bootstrap_sha`** — captured after BOOTSTRAP succeeds. Used by `gitReset` and `autoloop_resume` as a stable rollback floor when no `best` exists yet (avoids the previous `HEAD~1` ping-pong on failed proposes during early iters).

### Fixed — earlier post-merge fixes already shipped under 3.4.0 are listed here for completeness

- **`bare: true` removed from autoloop child sessions** — claude `--bare` skips `~/.claude/settings.json` env loading, breaking auth via the custom env loaded from settings.json. Real fix is upstream in `persistent-session.ts`; autoloop's workaround is to drop `bare`.
- **Robust RATCHET JSON parser** — Sonnet often wraps JSON in prose / code fences. Old parser missed → silently `{decision: "reset", reason: "malformed"}`, which rolled back every successful PROPOSE. New parser tries trim, fence-strip, and brace-balanced extraction; saves raw output to `iter/<n>/ratchet-raw.txt` for forensics.
- **Public exports** — `AutoloopRunner`, `AutoloopConfig`, type re-exports added to `src/index.ts`.

### Added — Scenario 2 starter and tests

- `scripts/scenario2-paper-review.ts` — end-to-end paper-review demo. `ARXIV_ID=<id> npx tsx scripts/scenario2-paper-review.ts` — downloads arxiv PDF, sets up workspace with structural gates (≥1500 words, 6 required sections, ≥5 citations, ≥8 slides), runs autoloop. Verified on arxiv 2210.02747 (Lipman et al, Flow Matching): 11/11 gates, 1 iter, 5 min wall-clock, $0.87 with sonnet/sonnet.
- `scripts/test-resume.ts` — start, stop after BOOTSTRAP, fresh SessionManager + `autoloopResume`, verify pytest passes.
- `scripts/test-multi-iter.ts` — workspace with 4 independent bugs in 4 files, verifies multi-iter ratcheting, monotonic `metric.json`, ≥2 propose commits on the autoloop branch.

### Known limitations

- Multi-day runs are still vulnerable to mid-phase process death — `autoloop_resume` only handles "between phases" deaths cleanly. Mid-COMPRESS or mid-RATCHET pipe death may leave inconsistent ledger.
- Scenario 1 (real ML training loop on remote box) needs `ssh <remote-host> …` wrapped inside `extract_cmd`. Native remote runner is a v2 item.

## [3.4.0] - 2026-05-10

### Added — `autoloop` (autonomous workspace iteration)

New first-class feature alongside session / council / ultraplan / ultrareview. Given a git workspace, a `plan.md` (intent), and a `goal.json` (success criteria with scalar and/or gates), the loop runs autonomously until the goal is met, max iters/cost is hit, or the user stops it.

- **Phase machine**: `BOOTSTRAP → { PROPOSE → EXECUTE → MEASURE → RATCHET → maybe COMPRESS }* → TERMINATED`
- **Asymmetric ratchet reviewer**: separate process, sandboxed cwd (cannot read workspace source), stdin-only artifact passing, JSON-only decision output. Default verdict is reset; commit requires positive evidence (see `configs/autoloop-ratchet-prompt.md`)
- **Two scenarios covered by one schema**: scalar-driven (Karpathy autoresearch shape) and gate-driven (paper deep-research shape with aspirational gates)
- **Push hooks**: async via `openclaw message send` (configurable). Triggers on new-best, plateau, aspirational gate proposed, termination, hard error. Inner loop never blocks on stdin
- **Kill switches**: per-iter wall-clock (process-group SIGKILL via `spawn detached: true`), `max_iters`, `max_cost_usd`. Token cap alone does not catch hung subprocesses
- **Atomic ledger**: `tasks/<id>/{plan.md, goal.json, current.md, state.json, metric.json, history.md, iter/<n>/...}` co-located with the workspace so `git reset` reverts ledger and code atomically
- **State schema supports population from day 1**: `state.json.tree.children_iters` is a list, even though v1 runs serial — future N-worktree mode reuses the same ledger
- **Tools**: `autoloop_start`, `autoloop_status`, `autoloop_list`, `autoloop_inject`, `autoloop_stop`
- **SSE endpoint**: `GET /autoloop/<id>/events` streams phase / state / push events. Frontend (webchat) deferred to a future release

Design doc: `tasks/autoloop.md`. Reference: `skills/references/autoloop.md`.

**Defaults** (cost not optimised per user direction): `propose=opus, ratchet=opus`, `max_iters=200`, `max_cost_usd=200`, `compress_every_k=10`, `per_iter_timeout_ms=600000`. Override via `goal.json.termination` or `autoloop_start` parameters.

Resume after process death is **not** supported in v1 — if the orchestrator process dies, `state.json` and `current.md` are intact but the loop must be restarted. Running concurrent autoloops on the same workspace is not supported (they would race on the same git branch).

## [3.3.1] - 2026-05-07

### Fixed

- **#60 — `/plan` isn't available in this environment.** The `plan: true` option in `sendMessage` previously prepended `/plan` to the message, which is a Claude Code interactive-only slash command not available in `--stream-json` mode or any other engine. Replaced with a universally compatible instruction-based planning prefix (`[Planning Mode] ...`) in both `persistent-session.ts` and `persistent-custom-session.ts`. Tested across Claude Code, Codex, and Gemini.

## [3.3.0] - 2026-05-06

### Added — `engine: 'opencode'` for [sst/opencode](https://github.com/sst/opencode)

New first-class engine wrapper alongside Claude / Codex / Gemini / Cursor. Wraps `opencode run --format json --dangerously-skip-permissions` as a one-shot per `send()`.

- Parses opencode's NDJSON envelope (`{ type, timestamp, sessionID, ...data }`) with `text`, `reasoning`, `tool_use`, `step_start`, `step_finish`, `error` event types
- `text` and `tool_use` are cumulative snapshots keyed by `part.id` / `part.callID`; the parser diffs them so `onText` callbacks receive streaming deltas and tool-call counts only increment on first sight
- Real token usage from `step_finish.part.tokens.{input, output, cache.read}` (falls back to estimation if no `step_finish` arrives)
- `--model` is passed through only when the configured model contains a `/` (opencode's `provider/model` convention); otherwise opencode's default applies
- Wrapper closes child stdin immediately after spawn (opencode otherwise blocks waiting for EOF and the subprocess hangs)
- Auth: opencode reads either its own credential store (`opencode auth login`) **or** the standard provider env vars (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, …); the wrapper passes through the parent process env unchanged
- New env var `OPENCODE_BIN` to override the binary path (defaults to `opencode`)
- 17 unit tests covering the parser; verified end-to-end against opencode CLI **1.1.40** with both a plain text send (`say hi`) and a tool-calling send (`create hello.txt`)

Schema is undocumented upstream and the project releases nearly daily — pin a version in CI if you depend on field names.

## [3.2.0] - 2026-05-06

### Fixed

- **#57 — `dist/index.js` missing.** OpenClaw's plugin loader resolves entry points by convention (`./dist/index.js`) rather than reading `package.json#main`, so v3.1.0 installs emitted a load-time warning. Added a `postbuild` step that writes `dist/index.js` and `dist/index.d.ts` shims re-exporting from `dist/src/index.js`. `package.json#main` is unchanged.

### Changed — Tool name collisions with OpenClaw built-ins (#58)

OpenClaw 2026.5.x ships its own `session_status` and `agents_list` tools at the gateway level. The plugin's identically-named tools triggered `plugin tool name conflict` warnings on every gateway restart, and dispatch was ambiguous when an LLM called either name. Renamed the two colliding tools:

| Before | After |
|--------|-------|
| `session_status` | `coding_session_status` |
| `agents_list` | `coding_agents_list` |

No aliases — the conflicting names couldn't be invoked reliably anyway. All other tool names (and the rest of the API surface) are unchanged. If you have callers that hard-coded these two names, update them.

## [3.1.0] - 2026-05-04

### Breaking — Hard Brand Cleanup

- Removed the `claude-code-skill` CLI alias; `clawo` is now the only package binary.
- Removed the deprecated `claude_*` tool aliases from plugin registration and `openclaw.plugin.json` contracts.
- Removed the `skills/claude-code-skill/` back-compat symlink.

### Removed

- Removed old-name references from current docs, help text, examples, skill text, comments, package metadata, and proxy identifiers outside explicit migration/history material.

### Changed

- Bumped the package version to `3.1.0`.
- Updated tests to assert that only engine-neutral tool names are registered.
- Added canonical plugin proxy route `/v1/claw-orchestrator-proxy`; the old `/v1/claude-code-proxy` route remains registered as a compatibility alias for callers that did not receive a v3.0 deprecation window.
- Added canonical CLI base URL override env var `CLAWO_API_URL`; `CLAUDE_CODE_API_URL` remains accepted as a fallback for callers that did not receive a v3.0 deprecation window.
- Kept the install-time cleanup for stale `openclaw-claude-code` plugin config so direct v2.x -> v3.1 upgrades still remove legacy OpenClaw entries; also restored the symmetric `npm ls -g` warning when the deprecated global package is still installed, so users on a v2.x -> v3.1 jump are reminded to `npm uninstall -g @enderfga/openclaw-claude-code` at their convenience.

## [3.0.0] - 2026-05-04

### Brand Rebrand

Project repositioned as **Claw Orchestrator** — a multi-engine coding-agent runtime for claw-style agent systems. Runs standalone, with first-class OpenClaw plugin support and a path to other claw-style agent platforms.

- npm package renamed: `@enderfga/openclaw-claude-code` → `@enderfga/claw-orchestrator`. The old package has been deprecated on npm with a moved-to message; existing installs keep working.
- GitHub repository renamed: `Enderfga/openclaw-claude-code` → `Enderfga/claw-orchestrator`. GitHub auto-redirects existing URLs and clones; `install.sh` raw URL is now `https://raw.githubusercontent.com/Enderfga/claw-orchestrator/main/install.sh`.
- OpenClaw plugin id renamed: `openclaw-claude-code` → `claw-orchestrator`. The new `install.sh` strips legacy v2.x entries from `~/.openclaw/openclaw.json` automatically on upgrade and warns if the legacy global package is still installed.
- CLI binary renamed: `claude-code-skill` → `clawo`. The old binary remains installed as an alias for the v3.0.x line and will be removed in v3.1.
- Skill name renamed: `claude-code-skill` → `claw-orchestrator`. The `skills/claude-code-skill/` directory is preserved as a back-compat symlink for the v3.0.x line.
- Banner updated; the v2.x banner is preserved at `assets/banner-legacy.jpg`.
- Log prefixes updated from `[openclaw-claude-code]` to `[claw-orchestrator]`.

### Breaking — Tool API rename (with deprecation aliases)

The 17 `claude_*`-prefixed tools were renamed to engine-neutral names. The old names remain registered as deprecated aliases for the v3.0.x line and will be removed in v3.1. The `codex_*`, `council_*`, `ultraplan_*`, `ultrareview_*` tool names are unchanged.

| Old name (alias, deprecated) | New name (canonical) |
|---|---|
| `claude_session_start` | `session_start` |
| `claude_session_send` | `session_send` |
| `claude_session_stop` | `session_stop` |
| `claude_session_list` | `session_list` |
| `claude_sessions_overview` | `sessions_overview` |
| `claude_session_status` | `session_status` |
| `claude_session_grep` | `session_grep` |
| `claude_session_compact` | `session_compact` |
| `claude_agents_list` | `agents_list` |
| `claude_team_list` | `team_list` |
| `claude_team_send` | `team_send` |
| `claude_session_update_tools` | `session_update_tools` |
| `claude_session_switch_model` | `session_switch_model` |
| `claude_project_purge` | `project_purge` |
| `claude_session_send_to` | `session_send_to` |
| `claude_session_inbox` | `session_inbox` |
| `claude_session_deliver_inbox` | `session_deliver_inbox` |

Calling a deprecated name still works; the tool description in OpenClaw's tool listing is prefixed with `[DEPRECATED — use <new-name>; this alias is removed in v3.1]` to nudge migration.

The plugin manifest (`openclaw.plugin.json`) `contracts.tools` now lists 35 canonical tools plus 17 deprecated aliases (52 entries total) so both old and new names remain discoverable.

### Fixed

- **CLI version reporting** — `clawo --version` (and the legacy `claude-code-skill --version`) now correctly reads the package version. Previously resolved `../package.json` relative to `dist/bin/cli.js`, which silently fell back to `0.0.0`.

### Migration Guide

```bash
# 1. Uninstall the old package
npm uninstall -g @enderfga/openclaw-claude-code

# 2. Install the new package
npm install -g @enderfga/claw-orchestrator

# 3. (If you use OpenClaw) re-run install.sh to migrate the plugin entry
curl -fsSL https://raw.githubusercontent.com/Enderfga/claw-orchestrator/main/install.sh | bash
```

Update any scripts that invoke the CLI by name from `claude-code-skill` to `clawo`. Tool callers in agents/MCP clients can continue using `claude_*` names through v3.0.x but should plan to migrate to the engine-neutral names before upgrading to v3.1.

### Unchanged

- `OPENCLAW_*` environment variables (`OPENCLAW_LOG_LEVEL`, `OPENCLAW_SERVE_MAX_SESSIONS`, `OPENCLAW_SERVE_TTL_MINUTES`, `OPENCLAW_RATE_LIMIT`, `OPENCLAW_CORS_ORIGINS`, `OPENCLAW_SERVER_TOKEN`)
- TypeScript public exports (`SessionManager`, `Council`, `PersistentClaudeSession`, etc.)
- `peerDependencies.openclaw` requirement
- Engine compatibility (Claude Code 2.1.126, Codex 0.128.0, Gemini 0.36.0, Cursor Agent 2026.03.30)

---

## [2.15.0] - 2026-05-04

### Added — Codex CLI 0.128.0 alignment + `/goal` support

Bumped tested Codex CLI from `0.118.0` to `0.128.0`. The wrapper had drifted ten minor versions; this release brings it current and adds long-horizon objective support via Codex's app-server protocol.

#### Codex `exec` path (`engine: 'codex'`)

- **Spawn args modernized**. Replaced the deprecated `--full-auto` flag with `--sandbox workspace-write` (avoids the per-spawn deprecation warning Codex 0.124+ emits). Added `--json` so output is line-delimited JSON events instead of free-form text.
- **JSONL event parser**. New parser consumes Codex's `thread.started`, `turn.started`, `item.completed` (`agent_message` and tool-use variants), and `turn.completed` events. Replaces the old char-count token estimate with the real `usage` payload (`input_tokens`, `output_tokens`, `cached_input_tokens`, `reasoning_output_tokens` — the latter two are new in Codex 0.125).
- **Per-session thread continuity**. The `thread_id` from each session's first `thread.started` event is captured and reused via `codex exec resume <id>` for subsequent sends, so the model sees prior turns instead of starting fresh each send.
- **`supportsCachedTokens: true`**. The Codex engine now reports cached input tokens and applies cached pricing in cost calculations (the path was already implemented in `BaseOneShotSession`; this just flips the flag).
- **Default model bumped** from `o4-mini` → `gpt-5.5`. New `gpt-5.5` entry added to `models.ts` (pricing currently mirrors `gpt-5.4` as a `TODO` placeholder until OpenAI publishes official numbers).
- **New `sandboxMode` field** on `SessionConfig` — `'read-only' | 'workspace-write' | 'danger-full-access'`. Defaults to `workspace-write` (matches old `--full-auto` behavior).

#### New one-shot tools

- **`codex_resume`** — wraps `codex exec resume [SESSION_ID|--last] [PROMPT]` (Codex 0.119+) for cross-process thread continuity. Returns `{ text, threadId, usage, events }`.
- **`codex_review`** — wraps `codex review [PROMPT] [--uncommitted | --base BRANCH | --commit SHA]`. Plain-text output (Codex's review subcommand does not emit JSON).

#### `/goal` long-horizon objectives — new `codex-app` engine

- **`PersistentCodexAppServerSession`** — new session class wrapping `codex app-server --listen stdio:// --enable goals`. Speaks Codex's v2 JSON-RPC 2.0 protocol over stdio. Required for `/goal` because `codex exec` has no slash-command surface.
- **`engine: 'codex-app'`** — new engine type. Long-running subprocess (one `app-server` per session); real-time streaming via `item/agentMessage/delta` notifications; cumulative token tracking via `thread/tokenUsage/updated`.
- **Goal lifecycle observation** — subscribes to `thread/goal/updated` and `thread/goal/cleared` notifications. Cached state available via `getStats().goal` and the `codex_goal_get` tool.
- **5 new tools**: `codex_goal_set`, `codex_goal_get`, `codex_goal_pause`, `codex_goal_resume`, `codex_goal_clear`. The mutation tools are convenience wrappers — internally they send `/goal <args>` as user text via `turn/start`, since Codex's v2 protocol has no client-side goal-mutation RPCs (verified via `codex app-server generate-json-schema`). Each tool errors clearly when called against a non-`codex-app` session.

> **Feature-flag risk.** The `goals` feature is marked "under development" in Codex 0.128.0 and has a known bug (issue #20591). The session class always passes `--enable goals` so it works the moment upstream stabilizes; during the transition some goal commands may fail server-side. The wrapper layer is unaffected by upstream churn.

#### Skipped

`codex cloud`, `codex apply`, MCP-server management subcommands, `codex exec-server`, `codex sandbox`, the `@openai/codex-sdk` npm package — all noted in research but deferred. None affect existing wrapper behavior.

## [2.14.2] - 2026-05-04

### Added — Claude Code CLI 2.1.122 → 2.1.126 sync

Bumped the tested Claude CLI from `2.1.121` to `2.1.126`. Net-new surface from this window:

- **`bedrockServiceTier`** (CLI 2.1.122) — new `SessionConfig` field. Sets `ANTHROPIC_BEDROCK_SERVICE_TIER`, which the CLI forwards as the `X-Amzn-Bedrock-Service-Tier` header. Values: `default | flex | priority`. Only effective when routing through AWS Bedrock.
- **`claude_project_purge` tool** (CLI 2.1.126) — wraps `claude project purge` to delete Claude Code project state (transcripts, tasks, file history, config entry). **Defaults to dry-run** for safety; pass `dry_run: false` to actually delete. Supports per-path purge or `all: true`.

Skipped (passive / interactive-only): OTel numeric attribute fix and `invocation_trigger` (passive — no wrapper change), `/v1/models` gateway discovery (handled at the gateway, not here), `--dangerously-skip-permissions` scope expansion, PowerShell primary-shell improvements, `/resume` PR-URL search.

## [2.14.1] - 2026-04-29

### Fixed
- **`team_list` / `team_send` on Claude engine** — earlier code assumed Claude Code CLI exposed `/team` and `@teammate` as user-facing commands. They do not. `team_list` returned `Unknown command: /team` and `team_send` sent the message as plain prose with a stray `@name` prefix. Both tools now use the same engine-agnostic virtual-team layer (cross-session inbox routing) for every engine. Claude Code's native experimental Agent Teams (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`, v2.1.32+) is an in-process TUI mechanism with no stdin-driven messaging surface, so a subprocess wrapper cannot drive it. Thanks @shendiid ([#48](https://github.com/Enderfga/openclaw-claude-code/issues/48))
- Removed unused `TEAM_LIST_TIMEOUT_MS` and `TEAM_SEND_TIMEOUT_MS` constants
- Updated README, SKILL.md, and `multi-engine.md` to describe the unified virtual-team behavior

## [2.14.0] - 2026-04-28

### Added — Claude Code CLI 2.1.121 sync

Bumped the tested Claude CLI from `2.1.111` to `2.1.121`. New `SessionConfig` fields:

- **`forkSubagent`** — sets `CLAUDE_CODE_FORK_SUBAGENT=1` to fork subagent for non-interactive sessions
- **`enableToolSearch`** — sets `ENABLE_TOOL_SEARCH=1` to enable Vertex AI tool search
- **`otelLogUserPrompts`** — sets `OTEL_LOG_USER_PROMPTS=1` for OpenTelemetry user prompt logging
- **`otelLogRawApiBodies`** — sets `OTEL_LOG_RAW_API_BODIES=1` for OpenTelemetry raw API body logging (debug only)
- **`xhigh` effort level** — new Opus 4.7 effort tier between `high` and `max`. Triggers `ultrathink` prefix on user messages, same as `high` and `max`
- **`stats.pluginErrors`** — captured from `system/init` event when CLI plugins fail to load due to unmet dependencies (`{plugin, reason}[]`)

Distributed tracing (`TRACEPARENT` / `TRACESTATE`) is automatically forwarded since the parent process env is inherited by the child — no new code needed, just set them in the parent before starting the session.

### Notes — behavior changes from upstream Claude CLI 2.1.121

- `--agent` / `--print` now enforce agent frontmatter `permissionMode`, `tools`, and `disallowedTools` (previously advisory). Affects `council` agent personas.
- `Bash(find:*)` permission rule no longer auto-approves `find -exec` or `find -delete`. If you were relying on the previous behavior, add explicit rules.
- `--dangerously-skip-permissions` now also skips prompts for `.claude/skills/`. Treat with care.

## [2.13.1] - 2026-04-28

### Fixed
- **Windows path resolution in council** — replaced manual `import.meta.url.replace('file://', '')` with `fileURLToPath()` in `src/council.ts`. The hand-rolled stripping left a leading `/` on Windows file URLs (`file:///C:/...` → `/C:/...`), breaking config path resolution and the project-directory safety check. Thanks @shendiid ([#47](https://github.com/Enderfga/openclaw-claude-code/pull/47))
- **Council safety check now uses `path.relative` instead of POSIX-only `'/'` separator** — the `moduleRoot + '/'` prefix check was Windows-incorrect (`\` vs `/`); now uses `path.relative()` so the safety guard works across platforms

## [2.13.0] - 2026-04-16

### Added
- **Claude Code CLI 2.1.111 support** — updated tested version from 2.1.91 to 2.1.111
- **Hook event streaming** — `includeHookEvents` option passes `--include-hook-events` for PreToolUse/PostToolUse lifecycle events
- **Permission delegation** — `permissionPromptTool` option passes `--permission-prompt-tool` for non-interactive MCP-based permission handling
- **Prompt cache optimization** — `excludeDynamicSystemPromptSections` option passes `--exclude-dynamic-system-prompt-sections` to improve prompt cache hit rate. Auto-enabled when `bare: true`
- **1-hour prompt cache** — `enablePromptCaching1H` option sets `ENABLE_PROMPT_CACHING_1H=1` env var for 1-hour cache TTL. Auto-enabled when `bare: true`
- **Debug control** — `debug` and `debugFile` options pass `--debug` and `--debug-file` for targeted debug output by category
- **GitHub PR sessions** — `fromPr` option passes `--from-pr` to resume sessions linked to a pull request
- **MCP Channels** — `channels` and `dangerouslyLoadDevelopmentChannels` options for MCP channel subscriptions (research preview)
- **API retry tracking** — `system/api_retry` events are now parsed, with `retries` and `lastRetryError` exposed in session stats
- **Smart defaults** — `bare: true` now auto-enables `--exclude-dynamic-system-prompt-sections` and `ENABLE_PROMPT_CACHING_1H=1` unless explicitly disabled

## [2.12.2] - 2026-04-16

### Fixed
- **OpenAI-compat: eliminated periodic 30–50s latency spikes** — tool definitions (`<available_tools>`) are now embedded in the session system prompt at create time instead of being prepended to every user message. For callers with many tools (e.g. 90+ MCP tools, ~50 KB payload), this enables reliable Anthropic prompt cache hits and eliminates a class of latency spikes that occurred every ~4 calls. Warm call latency drops from 3–45s (with spikes) to a stable 3–4s ([#43](https://github.com/Enderfga/openclaw-claude-code/pull/43))
- **OpenAI-compat: session key now includes tool fingerprint** — prevents two callers with the same system prompt but different tool lists from sharing a stale session
- **OpenAI-compat: extracted `buildSessionSystemPrompt()` helper** — deduplicated near-identical prompt strings, improved testability

### Added
- **Opt-out env var `OPENAI_COMPAT_TOOLS_PER_MESSAGE=1`** — restores pre-fix per-turn tool injection for callers that mutate their tool list within a single session
- 13 new unit tests covering tool fingerprinting, system prompt construction, and env var parsing (421 total)

## [2.12.1] - 2026-04-14

### Fixed
- **Proxy: configurable Anthropic base URL** — three-layer fallback (`ANTHROPIC_BASE_URL` env var → `~/.openclaw/openclaw.json` providers → official API), enabling MiniMax and other Anthropic-compatible endpoints without patching code
- **Proxy: removed hardcoded `minimax-portal` provider preference** — now uses first provider with a `baseUrl` from config, making the fallback generic
- **Proxy: base URL resolution cached** — avoids synchronous filesystem reads on every request
- **Proxy: config parse errors now logged** — `console.warn` instead of silent swallow
- **Skill directory** — added `skills/claude-code-skill/` subdirectory symlink for OpenClaw skill loader compatibility

### Changed
- `skills/claude-code-skill/SKILL.md` is a symlink to `skills/SKILL.md` (single source of truth)

## [2.12.0] - 2026-04-13

### Added
- **Structured logging** — new `Logger` interface with `createConsoleLogger(prefix)` and `nullLogger`. Log level controlled via `OPENCLAW_LOG_LEVEL` env var (debug/info/warn/error). SessionManager and Council now accept optional `logger` parameter instead of using bare `console.*`
- **`BaseOneShotSession` base class** — shared abstract class for one-shot (process-per-send) engines. Eliminates ~600 lines of duplication across Codex, Gemini, and Cursor session implementations
- **`CircuitBreaker` class** — extracted from SessionManager into standalone module (`src/circuit-breaker.ts`) with `check()`, `recordFailure()`, `reset()`, `getStatus()` API
- **`InboxManager` class** — extracted cross-session messaging from SessionManager into standalone module (`src/inbox-manager.ts`) with `sendTo()`, `inbox()`, `deliverInbox()`, `clear()` API
- New exports: `BaseOneShotSession`, `OneShotEngineConfig`, `Logger`, `createConsoleLogger`, `nullLogger`, `CircuitBreaker`, `InboxManager`, `SessionLookup`

### Fixed
- **openai-compat: unsafe type assertion in `parseToolCallsFromText`** — tool call array elements are now validated at runtime before use, preventing crashes on malformed model output
- **gemini-session / cursor-session: redundant dead branches** — merged identical error-handling branches in process close handlers
- **Sensitive content removed** — cleaned internal service references and personal paths from code comments and documentation examples

### Changed
- `PersistentCodexSession` now extends `BaseOneShotSession` (317 → 120 lines)
- `PersistentGeminiSession` now extends `BaseOneShotSession` (419 → 238 lines)
- `PersistentCursorSession` now extends `BaseOneShotSession` (441 → 264 lines)
- `SessionManager` reduced from ~1704 to ~1596 lines via CircuitBreaker and InboxManager extraction
- All `console.log/warn/error` calls in SessionManager and Council replaced with injected `Logger`
- `skills/SKILL.md` examples updated from CLI format to tool-call format

## [2.11.1] - 2026-04-11

### Fixed
- **openai-compat: `--system-prompt` replaces CLI default tools during function calling** — when tools are provided via the OpenAI API, the bridge now uses `--system-prompt` (replace mode) instead of `--append-system-prompt` to suppress Claude Code's built-in tools, preventing the agent from executing host tools instead of returning `tool_calls`
- **openai-compat: `tool_calls` arguments not always valid JSON** — `parseToolCallsFromText` now ensures the `arguments` field is always a JSON string, wrapping raw values in a JSON object when needed
- **openai-compat: only first `<tool_calls>` block parsed** — all `<tool_calls>` blocks in a response are now parsed, with output limited to one block per response to match the OpenAI protocol
- **openai-compat: single-block restriction in tool prompt removed** — `buildToolPromptBlock` no longer restricts the prompt to a single tool definition block, allowing multi-tool prompts
- **openai-compat: `<tool_result>` tags leaked into response content** — response text is now stripped of `<tool_result>` tags before being returned to the client
- **openai-compat: tool results processed even when last message is not tool role** — tool result serialization now only triggers when the last non-system message has `role: 'tool'`, preventing stale tool results from being re-injected on user follow-ups
- **openai-compat: ephemeral sessions not cleaned up** — sessions created for one-shot `/v1/chat/completions` requests without an `X-Session-Id` are now stopped immediately after the response completes

## [2.11.0] - 2026-04-10

### Added
- **OpenAI function calling support for openai-compat endpoint** — the `/v1/chat/completions` bridge now supports the full OpenAI tool use protocol:
  - Accepts `tools` array from requests (previously silently dropped)
  - Injects tool definitions into the prompt via `<available_tools>` block
  - Parses `<tool_calls>` tags from model responses into proper `message.tool_calls` format
  - Returns `finish_reason: 'tool_calls'` when tool calls are detected
  - Supports `tool` role messages for multi-turn tool result injection
  - Streaming mode buffers response when tools present, emits `delta.tool_calls` chunks
  - For Claude engine: disables CLI built-in tools (`--tools ""`) to prevent the agent from executing tools on the host instead of returning `tool_calls`
- New exported functions: `buildToolPromptBlock()`, `parseToolCallsFromText()`, `serializeToolResults()`
- 19 new unit tests for function calling (tool prompt building, response parsing, tool result serialization, multi-turn flow)

### Fixed
- **openai-compat session cwd** — uses empty temp directory instead of `process.cwd()` to prevent the CLI from loading CLAUDE.md and workspace context from the serve directory
- **`tools: ''` falsy check** — empty string is now correctly passed through as `--tools ""` (previously skipped due to truthiness check)

## [2.10.0] - 2026-04-10

### Added
- **Custom Engine (`engine: 'custom'`)** — integrate any coding agent CLI without writing engine-specific code. Users provide a `CustomEngineConfig` that maps CLI flags to OpenClaw session concepts. Supports two modes:
  - **Persistent** (`persistent: true`) — long-running subprocess with stream-json I/O over stdin/stdout (for Claude Code-compatible CLIs)
  - **One-shot** (`persistent: false`, default) — new process per `send()` (for simpler CLIs)
- Full config surface: binary path, flag mappings, permission mode translation, pricing, context window, env vars, stderr sanitization patterns
- Custom engines work in **council** — set `engine: 'custom'` + `customEngine` on agent personas
- New source file: `src/persistent-custom-session.ts` implementing `ISession`
- New type: `CustomEngineConfig` in `src/types.ts`
- New export: `PersistentCustomSession` from package entry point

## [2.9.4] - 2026-04-09

### Fixed
- **openai-compat: system prompt not injected for non-Claude engines** — Cursor, Codex, and Gemini CLIs don't support `--append-system-prompt`, so the upstream caller's system prompt (OpenClaw agent identity, tool definitions, workspace context) was silently dropped. Now prepended as `<system>...</system>` to the user message on every turn for non-Claude engines.
- **openai-compat: removed forceNonStream** — returning JSON when the gateway sent `stream: true` caused a protocol mismatch; the OpenAI SDK expected SSE, so webchat received no reply. Streaming with the fixed heartbeat comment format handles cold-start delay correctly.

### Added
- **Cursor Auto model routing** — `model: "auto"` now resolves to the `cursor` engine, enabling Cursor's unlimited Auto mode as a primary backend via the OpenAI-compat bridge.
- **openai-compat: optional status webhook (`OPENAI_COMPAT_STATUS_URL`)** — best-effort `POST` JSON `{ state, activity, tool }` at request start, on each CLI `tool_use` event (human-readable `activity`), when the turn completes (`state: idle`), and on handler failure (so UIs don't stick on `thinking`). Enables a webchat status bar or other dashboard to show live agent activity without parsing SSE.

## [2.9.3] - 2026-04-09

### Fixed
- **openai-compat: persistent CLI destroyed every turn (#40)** — `extractUserMessage()`'s `nonSystemMessages.length <= 1` heuristic fired on every request for clients that forward only the latest user turn (OpenClaw main agent, cron jobs, subagents), causing `stopSession` + `startSession` on every turn, destroying the persistent CLI, and preventing Anthropic prompt caching from ever warming. The heuristic is now off by default; clients that want the old behavior set `OPENAI_COMPAT_NEW_CONVO_HEURISTIC=1`. All clients can still force a reset via `X-Session-Reset: 1` (now also accepted case-insensitively with whitespace).
- **openai-compat: unkeyed callers collapsed onto one shared session (#40)** — `resolveSessionKey()` returned the literal string `'default'` when neither `X-Session-Id` nor `user` was set, so multi-caller setups all shared one `openai-default` plugin session and could see each other's `appendSystemPrompt` (a privacy leak across distinct callers). Now falls back to `'sys-<sha1(model + systemPrompt)>'` so distinct callers land on distinct sessions.
- **openai-compat: session key ignored requested model (#40)** — two callers with the same system prompt but different requested models collided onto one session and silently got responses from whichever model the session was created with. Model is now mixed into the hash input.
- **session-manager: concurrent `sendMessage()` race on the same session** — `PersistentClaudeSession`'s single-slot `_streamCallbacks` and shared `TURN_COMPLETE` listener could race when two callers sent on the same session simultaneously, causing the second caller to receive the first caller's response. `SessionManager.sendMessage()` now serializes per-session via a chained promise, with failure isolation so a thrown send doesn't poison the chain.
- **openai-compat: SSE heartbeat killed streaming for OpenAI SDK clients** — `writeSSE(':keepalive')` produced `data: :keepalive\n\n` which the OpenAI SDK's `SSEDecoder` tried to `JSON.parse`, throwing `SyntaxError` and aborting the stream. Replaced with a proper SSE comment (`': keepalive\n\n'`), interval increased from 15s to 30s. This was the root cause of `outputs: []` when the OpenClaw gateway's agent loop (43KB system prompt, >15s first-token latency) streamed through the bridge.
- **openai-compat: new sessions forced non-streaming on first turn** — Claude CLI needs 3-15s to boot and process the system prompt. Upstream clients (OpenClaw gateway, OpenAI SDK) would close the streaming connection before the first content chunk arrived. The bridge now forces non-streaming mode for the first turn of a new session, then allows streaming on subsequent turns where the CLI is already warm (<1s first-token).
- **openai-compat: poisoned session auto-resume from disk** — sessions that crashed during creation (e.g. `claude` not in PATH) were persisted to `claude-sessions.json`. On every server restart, `SessionManager._doStartSession` auto-resumed the broken `claudeSessionId`, producing zero-output sessions that could never recover. OpenAI-compat sessions now set `skipPersistence: true` + `noSessionPersistence: true` so they never persist to disk and never auto-resume stale CLI state.
- **openai-compat: `content` field as array not handled** — the OpenAI API allows `content` as `string | Array<{type, text}>` (multimodal messages). `extractUserMessage` now normalizes array content via a `textOf()` helper instead of assuming string.
- **openai-compat: `OpenAIChatMessage` type too narrow** — added `role: 'tool'`, `content: null | Array`, `tool_calls`, `tool_call_id` fields. `OpenAIChatCompletionRequest` now includes `tools`, `max_completion_tokens`. These fields are accepted but intentionally not forwarded to the Claude CLI — the bridge delegates all tool use to Claude Code's own tool system.

### Added
- **`OPENAI_COMPAT_NEW_CONVO_HEURISTIC` env var** — opt-in legacy heuristic for webchat frontends that re-send the full transcript (ChatGPT-Next-Web, Open WebUI, etc).
- **`GET /v1/sessions` inspection endpoint** — lists active OpenAI-compat sessions with `cached_tokens`, `tokens_in/out`, `turns`, `context_percent`, `cost_usd`. Production observability for verifying that prompt caching is actually warming. Bearer-token gated like the rest of `/v1/*`.
- **Serve-mode tuning env vars** — `OPENCLAW_SERVE_MAX_SESSIONS` (default 32, was 5) and `OPENCLAW_SERVE_TTL_MINUTES` (default 60, was 120). Plugin-mode defaults are unchanged.
- **`skills/references/openai-compat.md`** — dedicated reference for the OpenAI-compat bridge: session keying rules, the two operator modes, env vars, smoke-test recipes.
- **Tests** — 11 new unit tests covering: positive `X-Session-Reset` (1/true/case-insensitive/whitespace), negative reset values, distinct hash by system prompt, distinct hash by model, model-only hash, legacy-heuristic env-var restore, per-session send mutex serialization, mutex recovery from a failed send.

### Important
- **Extra usage billing**: When OpenClaw's agent loop routes through this bridge, Anthropic recognizes the system prompt signature as programmatic/agent traffic and bills it against Claude Code's **extra usage** quota at standard API rates. This bridge does NOT bypass Anthropic's subscription enforcement or billing — it is not a workaround for API access restrictions.

### Credits
- Bug diagnosis (#40) by @megayounus786.

## [2.9.2] - 2026-04-05

### Fixed
- **Session creation race condition** — concurrent `startSession()` calls for the same name now check `_pendingSessions` before `sessions.has()`, preventing duplicate session creation
- **Streaming proxy timeout** — `handleStreamingResponse` now uses `fetchWithRetry` (1 retry) instead of bare `fetch`, preventing indefinite hangs on upstream failures
- **Swallowed errors in PersistentClaudeSession** — 7 empty `catch {}` blocks now log errors via `SESSION_EVENT.LOG` instead of silently ignoring them; process kill catches distinguish `ESRCH` (expected) from `EPERM` (logged)
- **Hook errors logged** — `_fireHook` catch block now emits error message instead of swallowing
- **Unsafe type casts** — removed `as unknown as` double casts in `openai-compat.ts` (body validation before cast, `usage` field added to chunk type) and `persistent-session.ts` (StreamEvent index signature makes direct cast valid)
- **`max_tokens` validation** — OpenAI-compat endpoint now rejects non-positive `max_tokens` with 400

## [2.9.1] - 2026-04-05

### Fixed
- **CLI argument parsing** — comma-separated `--allowed-tools`, `--disallowed-tools`, `--add-dir`, `--mcp-config`, and `--betas` flags now trim whitespace and filter empty entries
- **API key sanitization** — stderr redaction now catches `sk-proj-*` and other `sk-*` key formats (previously only matched `sk-ant-*`)
- **Council worktree cleanup** — if a worktree creation fails mid-batch, already-created worktrees are cleaned up instead of left dangling
- **Council history pollution** — empty agent responses are now filtered from collaboration history prompts
- **Council TTL abort** — still-running councils are aborted at TTL expiry instead of silently deleted
- **Ultraplan TTL** — still-running ultraplans are marked as error at TTL expiry

### Added
- **`estimateTokens()`** — shared token estimation utility (`~4 chars/token`), replaces 3 inline duplicates across Codex/Gemini/Cursor sessions
- **`lookupModelStrict()`** — throws for unknown models instead of returning `undefined`
- **Pricing fallback warning** — `getModelPricing()` now logs a `console.warn` when falling back to default pricing for unknown models
- **Tests: `persistent-session.test.ts`** — 31 tests for Claude CLI engine (arg assembly, events, cost, send, stderr sanitization, stop)
- **Tests: `proxy-handler.test.ts`** — 17 tests for proxy handler (routing, retry, streaming, errors)
- **Tests: `embedded-server.test.ts`** — 22 tests for HTTP server (health, auth, rate limiting, body limits, routing, CORS, errors)

### Changed
- **Model detection** — deduplicated inline `CLAUDE_PATTERNS` arrays in `persistent-session.ts` and `session-manager.ts`; both now use centralized `isClaudeModel()` from `models.ts`

## [2.9.0] - 2026-04-05

### Added
- **Centralized model registry** (`src/models.ts`) — single source of truth for all 17 models across 4 providers. Model definitions, pricing, aliases, engine mappings, context windows, and `/v1/models` list are all auto-generated from one `MODELS[]` array. Adding a model is now a one-line change
- **Per-model context window** — `contextPercent` in session stats now uses the actual model's context window (e.g. 1M for Gemini, 256k for GPT-5.4) instead of a fixed 200k assumption
- **Session engine persistence** — `engine` field is now saved/restored across session restarts, so resumed sessions pick up the correct engine without re-specifying it
- **`x-session-reset` header** — OpenAI-compat endpoint now supports an explicit `x-session-reset: true` header to force a new conversation, in addition to the existing message-count heuristic
- **Proxy retry with backoff** — non-streaming proxy requests auto-retry on 429/5xx (up to 2 retries, exponential backoff, respects `Retry-After` header)
- **SSE heartbeat** — streaming responses (both OpenAI-compat and proxy) now send `:keepalive` comments every 15s to prevent proxy/client timeouts
- **Streaming usage** — final SSE chunk in OpenAI-compat streaming now includes `usage` (prompt_tokens, completion_tokens, total_tokens)
- **Configurable rate limit** — `OPENCLAW_RATE_LIMIT` env var overrides the default per-IP rate limit

### Changed
- **`MAX_BODY_SIZE`** increased from 1 MB to 5 MB for larger request payloads
- **`RATE_LIMIT_MAX_REQUESTS`** increased from 100 to 300 per window
- **Error format consistency** — `/v1/*` routes now return OpenAI-standard `{ error: { message, type, code } }` format; internal routes keep `{ ok: false, error }` format
- **Proxy provider detection** — `resolveProvider` now correctly returns `'google'` (not `'gemini'`) as the provider name, matching the `ProviderName` type

### Removed
- **`CONTEXT_WINDOW_SIZE` constant** — replaced by per-model `getContextWindow()` from the model registry
- **Duplicate model definitions** — `MODEL_ENGINE_MAP` (openai-compat.ts), `resolveProviderModel` (handler.ts), `isGeminiModel`/`isClaudeModel` (anthropic-adapter.ts), `DEFAULT_MODEL_PRICING`/`MODEL_PRICING` (types.ts) all consolidated into `src/models.ts`

## [2.8.1] - 2026-04-05

### Changed
- **Model references updated to current flagships** — all code and docs now use current SOTA models: `gpt-5.4`/`gpt-5.4-mini` (OpenAI), `gemini-3.1-pro-preview`/`gemini-3-flash-preview` (Google), `composer-2`/`composer-2-fast` (Cursor). Deprecated model names (`gpt-4o`, `cursor-small`, etc.) removed from docs and `/v1/models` list
- **Updated pricing table** — Opus 4.6 corrected to $5/$25, added GPT-5.4 series, Gemini 3.x, and Composer 2 pricing
- **Council default roles** — renamed default agents from model-based names (GPT/Claude/Gemini) to delivery-stage roles (Planner/Generator/Evaluator) with specialized personas aligned to the Plan → Build → Verify workflow. Engine mappings preserved: Planner→claude, Generator→gpt, Evaluator→gemini

## [2.8.0] - 2026-04-04

### Added
- **OpenAI-compatible `/v1/chat/completions` endpoint** — drop-in backend for webchat apps (ChatGPT-Next-Web, Open WebUI, LobeChat, etc.). Stateful sessions maximize Anthropic prompt caching (90% discount on cached tokens). Supports streaming (SSE) and non-streaming responses
- **`/v1/models` endpoint** — lists supported models for OpenAI client discovery
- **Auto session management** — sessions created/reused per conversation via `X-Session-Id` header or `user` field. Auto-compact when context reaches 80%
- **Multi-engine model routing** — OpenAI `model` field auto-routes to the correct engine (claude/codex/gemini)
- **Configurable CORS** — `/v1/` paths allow cross-origin requests for remote webchat frontends; `OPENCLAW_CORS_ORIGINS=*` for all paths

## [2.7.1] - 2026-04-04

### Added
- **Embedded server authentication** — opt-in bearer token via `OPENCLAW_SERVER_TOKEN` env var; written to `~/.openclaw/server-token` for CLI. `/health` exempt. Default: no auth (localhost binding is the primary boundary)
- **Orphaned process cleanup** — PID file tracking (`~/.openclaw/session-pids.json`) with startup cleanup. Verifies process command line matches known CLIs (claude/codex/gemini/agent) before killing to prevent PID reuse mishaps
- **Circuit breaker** — engine-level failure tracking with exponential backoff prevents cascading failures from broken CLIs
- **Rate limiting** — sliding-window rate limiter (100 req/min per IP) on embedded server
- **Council `defaultPermissionMode`** — new `CouncilConfig` option to override the `bypassPermissions` default for council agents
- **Shared constants module** — `src/constants.ts` consolidates 30+ magic numbers (timeouts, limits, thresholds) from across the codebase

### Changed
- **Council cleanup consolidation** — extracted `_cleanup()` method from `accept()` for reusable worktree/branch/file cleanup
- **Strongly typed event names** — `SESSION_EVENT` constant object replaces magic strings in event emission
- **Type cast fix** — eliminated `as unknown as` double cast in proxy handler registration

## [2.7.0] - 2026-04-04

### Added
- **Cursor Agent engine** — new `engine: 'cursor'` option wraps the Cursor Agent CLI (`agent`) with headless print mode, stream-json parsing, and full `ISession` interface support. Resolves #32
- `PersistentCursorSession` class (`src/persistent-cursor-session.ts`) implementing the same pattern as Codex/Gemini engines
- Unit tests for Cursor session (spawn flags, stream-json parsing, lifecycle, stderr sanitization)
- Cursor engine support in council agents — use `engine: 'cursor'` in agent personas for mixed-engine councils

## [2.6.1] - 2026-04-03

### Added
- **Zero-config proxy** — non-Claude models on the `claude` engine automatically start a local proxy server that converts Anthropic → OpenAI format and forwards to the OpenClaw gateway. Gateway port and auth are auto-detected from `~/.openclaw/openclaw.json`. No env vars, no baseUrl, no config changes needed
- Proxy documentation in `skills/references/multi-engine.md`

### Fixed
- **Proxy model URL extraction** — `extractRealModel` regex fixed to handle Claude Code CLI's `/real/<model>/v1/messages` URL pattern
- **Gateway model name** — `forwardToGateway` now sends `model: "openclaw"` as required by gateway
- **HEAD request handling** — proxy returns 200 for CLI probe requests instead of JSON parse errors

## [2.6.0] - 2026-04-03

### Changed
- **Skill restructure** — SKILL.md rewritten from scratch: removed hardcoded local paths, migrated metadata from `clawdis` to `openclaw` format, install via `kind: "node"` npm package instead of local path
- **Docs moved into skill** — `docs/` directory moved to `skills/references/` for progressive disclosure. AI agents load reference files on demand instead of duplicating content. All README/CLAUDE.md links updated
- **Skill description** — comprehensive trigger keywords covering all 27 tools, multi-engine, council, ultraplan, ultrareview

### Removed
- `docs/` directory (content lives in `skills/references/` now)
- Hardcoded `~/clawd/claude-code-skill` path from skill metadata

## [2.5.5] - 2026-04-03

### Fixed
- **Codex engine fully reworked** — migrated from `codex --full-auto --quiet` to `codex exec --full-auto --skip-git-repo-check -C <dir>`. Fixes `--quiet` rejection, `--cwd` rejection, TTY requirement, and git-repo-check in non-git directories (codex-cli 0.112.0+)
- **Gemini engine fake success** — non-zero exit codes (except 53/turn-limit) now correctly reject instead of resolving with empty output
- **Gemini prompt echo** — user-role messages from `stream-json` output are now filtered; only assistant responses are collected
- **Council consensus false positives** — removed loose tail-fallback heuristic that matched prompt instructions echoed back by agents. Only explicit `[CONSENSUS: YES/NO]` tags (and common variants) are accepted
- **Team tools fake execution** — `team_list` and `team_send` now reject with a clear error on non-Claude engines instead of sending raw text commands
- **Ultraplan error masking** — error responses (auth failures, empty output) no longer marked as `status: 'completed'` with error text in the `plan` field; correctly set `status: 'error'` with `error` field

### Added
- **Cross-engine team tools** — `team_list` and `team_send` now work on all engines. Claude uses native `/team` and `@teammate`; Codex/Gemini use SessionManager's cross-session messaging as a virtual team layer
- Engine Compatibility Matrix in README with tested CLI versions (Claude 2.1.91, Codex 0.118.0, Gemini 0.36.0)
- Known Limitations section in README
- Engine authentication prerequisites in docs/getting-started.md
- Full functional audit test script (`test-full-audit.ts`) — 47 tests covering all 27 tools across all 3 engines

### Changed
- Codex stdin set to `'ignore'` (was `'pipe'`) to prevent `codex exec` from waiting for piped input
- Consensus tail-fallback tests updated to match stricter parsing behavior

## [2.5.0] - 2026-04-03

### Added
- Council post-processing lifecycle: `council_review`, `council_accept`, `council_reject` tools — completes the council workflow with structured review, cleanup, and rejection-with-feedback
- `CouncilReviewResult`, `CouncilAcceptResult`, `CouncilRejectResult` types for structured post-processing responses
- Council `accepted` and `rejected` status states

### Changed
- Translated `configs/council-system-prompt.md` from Chinese to English for project-wide consistency
- Translated all Chinese strings in `council.ts` agent prompts and CLAUDE.md worktree templates to English
- `openclaw.plugin.json` contracts.tools updated from 24 → 27

## [2.4.0] - 2026-04-01

### Added
- Gemini CLI engine (`engine: 'gemini'`) — third engine alongside Claude Code and Codex. Per-message spawning with `--output-format stream-json` for real token usage tracking. Permission mapping: `bypassPermissions` → `--yolo`, `default` → `--sandbox` (#29)
- 88 new unit tests: SessionManager (74 tests, #28) and Gemini session (14 tests, #29). Total: 162 tests
- CLAUDE.md project context file for contributors
- README architecture diagram (mermaid), test badge, "Why not Claude API" callout

### Fixed
- Test files no longer compiled to `dist/` or shipped in npm package (tsconfig exclude)
- `openclaw.plugin.json` contracts.tools updated from 10 → 24 to match actual registered tools
- `SessionManagerLike` interface in council.ts uses real types instead of `Record<string, unknown>`
- CI switched from `npm install` to `npm ci` with committed lockfile for reproducible builds
- docs/cli.md: added SDK-only tools reference table (14 tools without CLI wrappers)

## [2.3.1] - 2026-04-01

### Fixed
- Plugin installation blocked on OpenClaw 2026.3.31 — resolved security scanner false positive for "credential harvesting" in CLI by deferring env var access (#24)
- Added `openclaw.hooks` declaration to prevent hook pack validation error
- Added `capabilities.childProcess` and `capabilities.networkAccess` to plugin manifest for scanner whitelisting

## [2.3.0] - 2026-03-31

### Added
- Session Inbox — cross-session messaging with `claude_session_send_to`, `claude_session_inbox`, `claude_session_deliver_inbox`. Idle sessions receive immediately; busy sessions queue for later delivery. Broadcast via `"*"` (#22)
- Ultraplan — dedicated Opus planning session (up to 30 min) with `ultraplan_start`, `ultraplan_status` (#22)
- Ultrareview — fleet of 5-20 specialized reviewer agents in parallel via council system with `ultrareview_start`, `ultrareview_status`. 20 review angles: security, logic, performance, types, concurrency, etc. (#22)
- Tool count: 17 → 24

### Fixed
- Session creation race condition — concurrent `startSession()` calls no longer create duplicates (#23)
- File persistence error handling — proper error callbacks, orphan `.tmp` cleanup on rename failure (#23)
- HTTP stream reader leak — `try/finally { reader.cancel() }` on all streaming paths (#23)
- CORS restricted to localhost origins only (#23)
- Agent name validation prevents git branch injection (#23)
- CWD path normalization via `path.resolve()` (#23)
- Session resume logic uses `??` instead of `||` for explicit null handling (#23)
- Stderr API key sanitization masks `sk-ant-*`, `*_API_KEY=*`, `Bearer *` patterns (#23)
- Council git errors now logged instead of silently swallowed (#23)
- SKILL.md cleaned up: removed 8 references to unimplemented CLI commands (#23)
- README tool count and CLI version accuracy (#23)

## [2.2.0] - 2026-03-31

### Added
- Stream output support — `onChunk` callback and `stream` param for `claude_session_send` (#9)
- Session persistence — registry saved to `~/.openclaw/claude-sessions.json` with 7-day disk TTL, atomic writes, debounced saves (#11)
- Dynamic tool/model switching — `claude_session_update_tools` and `claude_session_switch_model` with rollback on failure (#12)
- Session health overview — `claude_sessions_overview` tool for plugin-wide stats (#10)
- Premature CLI exit detection — startup crash no longer leaves sessions stuck in busy state (#13)

### Fixed
- Stale close listener on fallback ready path (follow-up to #13)
- Truncated code comments in startup flow

### Improved
- Project governance: CONTRIBUTING.md, CHANGELOG.md, issue/PR templates, CI workflows, npm publish automation

## [2.1.0] - 2026-03-31

### Added
- Cross-platform PATH inheritance from `process.env.PATH`
- `CLAUDE_BIN` env var override for custom binary locations
- `resumeSessionId` exposed in tool schema
- Lazy initialization — zero memory when unused

### Fixed
- `contextPercent` calculation (was hardcoded 0)
- Process blocking on detached child (`proc.unref()`)
- Ready event now listens for CLI init signal instead of blind 2s timeout

## [2.0.0] - 2026-03-31

### Added
- Complete rewrite as native OpenClaw plugin
- 10 native tools (`claude_session_start/send/stop/list/status/grep/compact`, `claude_agents_list`, `claude_team_list/send`)
- Plugin hooks: `before_prompt_build`, `registerHttpRoute`
- Embedded HTTP server for backward-compatible CLI access

### Breaking Changes
- Requires OpenClaw >= 2026.3.0 with plugin SDK
- Standalone Express backend deprecated
- FastAPI proxy now optional

## [1.2.0] - 2026-03-27

### Added
- Cost tracking per session
- Git branch awareness
- Hook system for pre/post execution
- Model aliases support

## [1.1.0] - 2026-03-25

### Added
- Effort levels (low/medium/high/max)
- Plan mode (`--plan` flag)
- Compact command for context reclamation
- Context percentage tracking
- Model switching within sessions

## [1.0.0] - 2026-03-23

### Added
- Initial release
- Persistent Claude Code sessions via MCP
- Multi-model proxy support
- Agent teams support
- SKILL.md for ClawHub discovery
