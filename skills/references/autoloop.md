# Autoloop — Reference

Three-agent autonomous iteration loop for a git workspace. You converse with
the **Planner** to design a plan; on your approval, the Planner spawns the
**Coder** + **Reviewer** subloop, monitors it, and pushes you (WeChat →
WhatsApp → email fallback chain, see [Notification setup](#notification-setup))
only when something needs your attention.

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

| Agent        | Default         | cwd                                            | Owns                                             |
| ------------ | --------------- | ---------------------------------------------- | ------------------------------------------------ |
| **Planner**  | claude / opus   | workspace                                      | strategy, `plan.md`, `goal.json`, talking to you |
| **Coder**    | claude / sonnet | workspace                                      | code changes, eval execution                     |
| **Reviewer** | claude / sonnet | `<workspace>/tasks/<run_id>/reviewer_sandbox/` | distrust audit; advance / hold / rollback        |

Each role can use any built-in engine, or a `custom` engine config supplied by a
local caller (custom engines name an executable, so the HTTP API does not accept
them — see [tools.md](./tools.md)). If a non-Claude role omits `model`, that CLI
uses its own default model rather than receiving the Claude `opus` / `sonnet`
defaults. Role instructions are included in-band for engines that do not expose a
native system-prompt flag.

Engines without native multi-turn conversation (one-shot custom engines) spawn a
fresh process per send with nothing to resume, so the dispatcher replays that
role's transcript in-band as a `<conversation_history>` block, oldest turns dropped
past a character budget. Claude, Codex, Antigravity, Grok and OpenCode each
resume their own conversation by id and get no replay — see
`engineHasNativeConversation` in `types.ts`, which is the single source of truth for
this and is checked with a two-turn recall test per engine.

The Planner runs read-only so strategy cannot turn into source edits, and that is
enforced by the engine rather than requested politely: Claude uses plan mode,
Antigravity uses its plan mode, and OpenCode gets a generated
`clawo-readonly` agent that denies `edit`/`bash`/`external_directory` (its built-in
`plan` agent is a user-overridable preset that denies neither, so a "read-only"
session could otherwise still author files through a shell heredoc). A custom
Planner receives `permissionMode: 'manual'` and its `CustomEngineConfig` **must**
map that mode to the CLI's read-only flag — if it cannot, the session refuses to
start rather than silently running write-enabled.

Antigravity's read-only boundary is `--mode plan` on every Planner turn,
including recovery. An empty or whitespace-only agy reply is a failed turn, not
an empty Planner reply. When agy's log for that turn shows a soft-denied tool
confirmation, the caller receives a fixed diagnosis (native log content is never
returned); when agy instead returns a non-empty reply for a soft denial, the
reply is kept and the refused tool names are reported in
`SendResult.permissionDenials`. The Planner's conversation id stays resumable,
the failed message is not retried automatically, and permissions are not
relaxed. A failed reply never reaches the control parser, so it cannot change
`plan.md` or `goal.json`, spawn subagents, or emit an initial directive.

Coder and Reviewer engine/model choices can be overridden by the first successful
`spawn_subagents`; later attempts to change an already-started role are rejected
instead of silently diverging from the running session.

Coder and Reviewer **never speak to you directly**. Anything they observe
flows through the Planner. The Planner decides what to surface and what to
absorb.

A run left idle past `sessionTtlMinutes` has its role sessions evicted like any
other session. The next message to a role starts it again under the same name,
which resumes the persisted conversation where the engine supports it, instead of
failing with "Session not found".

## UX flow

```
1. autoloop_start { run_id, workspace }       → Planner session ready
2. autoloop_chat { run_id, "<your goal>" }    → Planner reads workspace,
                                                drafts plan.md + goal.json,
                                                asks "ready to spawn?"
3. autoloop_chat { run_id, "go" }             → Planner emits spawn_subagents
4. Coder + Reviewer self-iterate              → ledger writes per iter
5. Planner pushes you on target_hit / regression / decision / stall
6. Run ends when the Planner emits terminate, the phase-error circuit trips,
   the hard deadline passes, or you stop it. An expired activity lease
   pauses the run instead.
```

Stopping at a target or at `max_iters` from `goal.json` is the Planner's
decision: the runtime does not evaluate `goal.json`.

## Timeout hierarchy and recoverable sends

Autoloop has three independent start-time controls. Their bounds are inclusive,
and omitting them retains the defaults:

| Wire field                 | Runtime field           | Default  | Minimum | Maximum   | Meaning                                                            |
| -------------------------- | ----------------------- | -------- | ------- | --------- | ------------------------------------------------------------------ |
| `send_timeout_ms`          | `sendTimeoutMs`         | 600000   | 5000    | 7200000   | Wall-clock cap for one Planner, Coder, or Reviewer delivery        |
| `activity_lease_ms`        | `activityLeaseMs`       | 1800000  | 60000   | 7200000   | Inactivity lease, renewed only by validated user or agent progress |
| `autoloop_hard_timeout_ms` | `autoloopHardTimeoutMs` | 86400000 | 600000  | 259200000 | Absolute run deadline, anchored to start and never renewed         |

Timer checks and runner-generated bookkeeping do not renew the activity lease.
The hard deadline cannot be extended by repeated activity and wins if it fires
at the same instant as lease expiry.

A genuine per-agent send timeout is recoverable but is never retried
automatically: the underlying agent may still complete and cause side effects.
The runner pauses with an `awaiting_resume` reason and records the immutable
logical dispatch as `pending_dispatch`, including its stable `dispatch_id`.
Resume may supply only a finite, in-range `send_timeout_ms` that is strictly
larger than the latest effective value, together with the matching
`pending_dispatch_id` when a dispatch is pending. Legacy runs start comparison
at 600000 ms. Equality, decreases, stale identities, and any `allow_decrease`
field are rejected; `activity_lease_ms` and `autoloop_hard_timeout_ms` cannot be
overridden on resume.

A successful increase appends exactly one `timeout_migration` record to
`decisions.jsonl` with its timestamp, run id, old/new values, reason, and the
pending dispatch identity when available. It does not rewrite the original
stored spec, chat or iteration evidence, or any earlier audit bytes.

## Quick start

Over HTTP, against `clawo serve` (default `127.0.0.1:18796`):

```bash
TOKEN=$(cat ~/.openclaw/server-token)

# Start a run (creates the Planner session)
curl -X POST http://127.0.0.1:18796/autoloop/new \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"run_id":"my-run","workspace":"/abs/path/to/workspace"}'

# Chat with the Planner (202; the reply arrives on /events as planner_reply)
curl -X POST http://127.0.0.1:18796/autoloop/my-run/chat \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"text":"Read the workspace and design a plan to fix X"}'

# Inspect state
curl http://127.0.0.1:18796/autoloop/my-run/state -H "Authorization: Bearer $TOKEN"

# Live SSE stream (the dashboard's 3-pane view subscribes here)
curl -N http://127.0.0.1:18796/autoloop/my-run/events -H "Authorization: Bearer $TOKEN"
```

Resetting an agent and stopping a run have no HTTP route; call the tools
(plugin or MCP):

```jsonc
// Reset the Coder if it drifts (lazy by default; eager_restart starts a fresh session now)
autoloop_reset_agent({ "run_id": "my-run", "agent": "coder", "eager_restart": true })

// Stop
autoloop_stop({ "run_id": "my-run", "reason": "done" })
```

## Plugin tools

| Tool                   | Args                                                                                                                                               | What                                                                                                                                    |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `autoloop_start`       | `run_id`, `workspace`, per-role `*_engine?`, `*_model?`, `*_custom_engine?`, `send_timeout_ms?`, `activity_lease_ms?`, `autoloop_hard_timeout_ms?` | Start a run; launches Planner and stores Coder/Reviewer defaults and timeout controls. Each `custom` role requires its matching config. |
| `autoloop_chat`        | `run_id`, `text`                                                                                                                                   | Send a chat message to the Planner; returns the Planner's reply.                                                                        |
| `autoloop_status`      | `run_id`                                                                                                                                           | Current state (status, iter, push count, subagents_spawned).                                                                            |
| `autoloop_list`        | —                                                                                                                                                  | All autoloop runs in the run store, live or not.                                                                                        |
| `autoloop_stop`        | `run_id`, `reason?`                                                                                                                                | Terminate; stops Planner / Coder / Reviewer.                                                                                            |
| `autoloop_reset_agent` | `run_id`, `agent` ('planner' / 'coder' / 'reviewer'), `force?`, `eager_restart?`                                                                   | Reset one subagent. Planner reset requires `force: true`.                                                                               |

## Planner-emitted control tools

The Planner controls the run by emitting fenced ` ```autoloop ` JSON blocks
inside its replies. The dispatcher parses them out and applies them. You
never see the JSON — only the Planner's narrative.

These fenced reply blocks are the only Planner control channel. Native shell or
file-tool activity is never interpreted as a control, and the read-only Planner
still cannot write the artifacts directly. The dispatcher parses and validates
the complete block batch before applying any effect, including rejecting
malformed blocks and duplicate `write_plan`, `write_goal`, or
`spawn_subagents` controls. A valid batch has fixed ordering even when the
blocks appear in another order: all plan/goal bodies are staged and replaced as
one failure-atomic artifact transaction, then policy effects run, then at most
one subagent spawn runs, and only then are directive messages returned to the
runner. A staging or replacement failure restores the prior artifact bytes,
removes partial files, and suppresses both spawn and directives.

| Tool                 | Args                                                                                                                                  | What                                                                                                                                                                                                                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `notify_user`        | `level` ('info' / 'warn' / 'decision' / 'error'), `summary`, `detail?`, `channel?` ('auto' / 'wechat' / 'webchat' / 'both' / 'email') | Push you out-of-band.                                                                                                                                                                                                                                                                |
| `spawn_subagents`    | `coder_engine?`, `coder_model?`, `reviewer_engine?`, `reviewer_model?`, `initial_directive?`                                          | Start Coder + Reviewer. Omitted values inherit run defaults. An engine change without a model uses the new engine's default. Once a role session has started, changing its engine/model is rejected. Custom configs cannot be emitted by Planner. Only after explicit user approval. |
| `send_directive`     | `goal`, `constraints?`, `success_criteria?`, `max_attempts?`                                                                          | Next iter's instruction to Coder.                                                                                                                                                                                                                                                    |
| `pause_loop`         | `reason`                                                                                                                              | Halt subloop at next iter boundary; chat keeps working.                                                                                                                                                                                                                              |
| `resume_loop`        | —                                                                                                                                     | Resume after pause.                                                                                                                                                                                                                                                                  |
| `terminate`          | `reason`                                                                                                                              | End run.                                                                                                                                                                                                                                                                             |
| `update_push_policy` | partial PushPolicy                                                                                                                    | Mutate notification rules (e.g. when you say "tell me every iter").                                                                                                                                                                                                                  |
| `write_plan`         | `content` (full plan.md body), `commit_message?`                                                                                      | Write `plan.md` to the workspace and git-commit. The **only** way the Planner can author plan.md — Write/Edit are stripped from the Planner session as a hard role boundary. Re-running replaces the whole file.                                                                     |
| `write_goal`         | `content` (full goal.json body), `commit_message?`                                                                                    | Same, for `goal.json`. Content is JSON-validated before write; malformed content errors back to the Planner.                                                                                                                                                                         |

### Custom engines and resume

Custom engine configs are accepted only by `autoloop_start` (and, on resume, by
`SessionManager.autoloopResume()` or by reference in the HTTP resume body), never
through Planner output. This keeps config fields such as `env` and static CLI
arguments out of the Planner transcript and `decisions.jsonl`. The run record
stores only each role's engine and model, including the effective Coder/Reviewer
selection after a successful spawn. When resuming a run that uses `custom`,
supply the matching config again (over HTTP, as a `*CustomEngineRef`, see
[Backend HTTP / SSE](#backend-http--sse)); otherwise resume fails with a clear
configuration error rather than silently switching to Claude. Custom config
shape is validated at runtime, while its `env` and static CLI arguments stay
out of the run record and audit logs. See [`multi-engine.md`](./multi-engine.md)
for the `CustomEngineConfig` shape.

## Default push policy

| Event                  | Default                                               |
| ---------------------- | ----------------------------------------------------- |
| on_start               | info / wechat ("loop started, will notify on issues") |
| on_iter_done_ok        | silent                                                |
| on_target_hit          | info / both                                           |
| on_metric_regression_2 | warn / both                                           |
| on_reviewer_reject_2   | warn / both                                           |
| on_phase_error         | error / both                                          |
| on_stall_30min         | warn / wechat                                         |
| on_decision_needed     | decision / both                                       |

The runtime fires five of these itself: `on_stall_30min` (30 minutes without
activity), `on_metric_regression_2`, `on_reviewer_reject_2` (two in a row),
`on_phase_error`, and `on_target_hit` (only when an acceptance contract passes,
see [Acceptance contracts](#acceptance-contracts)). `on_start`,
`on_iter_done_ok` and `on_decision_needed` are policy entries for the Planner's
own `notify_user` calls.

A 5-minute dedup on (level, summary) prevents duplicate pushes from the same
event. Channels: `auto` and `both` walk WeChat → WhatsApp → email and stop at
the first that succeeds; `wechat` and `email` go to that channel only;
`webchat` is a no-op (see [Known limitations](#known-limitations)).
**`on_phase_error` and `on_decision_needed` cannot be set to `silent: true`**
by the Planner: `update_push_policy` strips the flag and records the attempt in
`decisions.jsonl`.

## Notification setup

- **WeChat** needs `AUTOLOOP_WECHAT_RECIPIENT` and `AUTOLOOP_WECHAT_ACCOUNT`.
- **WhatsApp** needs `AUTOLOOP_WHATSAPP_RECIPIENT`.
- Both send through the `openclaw` CLI, which must be on `PATH`.
- **Email** is sent by running `bash "$AUTOLOOP_EMAIL_SCRIPT" -s "<subject>"`
  with the message body on stdin.

Any channel whose variables are unset is skipped silently. With none set,
pushes are recorded in `push_log.jsonl` only.

## Auto-compact

Each agent's context is monitored after every turn. When `getStats().contextPercent`
crosses the per-agent threshold the dispatcher invokes `/compact` with a
role-tuned hint (`compactSummaryFor`). Defaults: Planner 80 %, Coder 70 %,
Reviewer 70 %. The dispatcher's `compactThresholds` option overrides them; it
is library-level only and not exposed through `autoloop_start` or the HTTP
API. A 30 s debounce
prevents re-fire while post-compact stats settle. Events: `compact` is
emitted on the dispatcher EventEmitter AND appended to `decisions.jsonl`.

One-shot engines (`codex`, `agy`, `grok`, `opencode`) cannot compact — their
CLIs expose no such command. The threshold is still meaningful there because
`contextPercent` tracks real occupancy, but crossing it cannot free space:
the session emits a single warning on its log channel the first time compaction
is requested, then the thread keeps growing until the CLI refuses the request.
Treat that warning as the signal to start a fresh session.

## Phase-error circuit

Subprocess deaths (Claude session lost), failed `git commit` in an iter, and
other phase-bound failures surface as `phase_error` messages instead of
silently masquerading as a "clarification request". The runner counts
consecutive `phase_error`s and:

1. Fires `on_phase_error` on each one (defaults to error / both channels).
2. After `phaseErrorCircuit` consecutive errors (default **3**) emits a
   `decision`-level push and an automatic `terminate { reason:
'phase_error_circuit' }`.

A successful (non-error) `iter_done` resets the counter. The threshold is
`AutoloopConfig.phaseErrorCircuit`, which is library-level only and not exposed
through `autoloop_start` or the HTTP API.

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

| Kind                     | When                                               |
| ------------------------ | -------------------------------------------------- |
| `spawn_subagents`        | Planner emits `spawn_subagents`                    |
| `reset_agent`            | Any agent reset (manual or auto-recovery)          |
| `compact`                | Auto-compact fires                                 |
| `update_push_policy`     | Planner mutates the policy                         |
| `policy_silence_blocked` | Planner tried to silence a critical channel        |
| `phase_error`            | Surfaced from dispatcher to runner                 |
| `terminate`              | Run ends (planner reason or `phase_error_circuit`) |

JSONL, one entry per line, ts-prefixed.

## Ledger layout

```
<workspace>/tasks/<run_id>/
├── plan.md              # Planner-authored, git-committed
├── goal.json            # Planner-authored, git-committed
├── push_log.jsonl       # every notify_user attempt + channel used
├── decisions.jsonl      # runner / dispatcher audit trail (see above)
├── chat.jsonl           # Planner-pane conversation, replayed by /chat_history
├── evidence/iter-<n>/   # acceptance-contract bundle, when a contract is configured
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
    ├── diff.patch         # git diff of the iter, created files included
    ├── verdict.json       # Reviewer decision + audit notes (schema_version: 1)
    └── coder_summary.txt
```

The orchestrator git-commits each iter automatically. Coder must NOT call
`git commit` itself — that confuses the diff log. **If `git commit` fails
inside an iter** (pre-commit hook reject, signing key missing, …) the
dispatcher emits a `phase_error` instead of writing `iter_artifacts`, so
the failure is visible to the runner and counts toward the circuit.

`files_changed` in the iteration artifacts is taken from git, never from the
Coder's own report.

Every JSON artifact in the ledger carries a `schema_version` field (currently
`1`) to make future migrations explicit.

## Backend HTTP / SSE

| Endpoint                                 | Returns                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /autoloop/list`                     | `{ ok, runs: AutoloopState[] }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `POST /autoloop/new`                     | `{ ok, run_id, planner_session }` — body `{ workspace, run_id?, planner_engine?, planner_model?, coder_engine?, coder_model?, reviewer_engine?, reviewer_model?, send_timeout_ms?, activity_lease_ms?, autoloop_hard_timeout_ms? }`. Timeout fields use the defaults and inclusive bounds documented above; malformed or out-of-range values return 400 before a run starts.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `GET /autoloop/<id>/state`               | `{ ok, state: AutoloopState, live }` — `live` is `true` only when the run is running in this process. For a run that is not live here, `state` is the last state recorded in the run store, so historical runs open with their real iteration count. 404 when there is no such run.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `GET /autoloop/<id>/push_log`            | `{ ok, entries: PushLogEntry[] }` — served from the ledger via `autoloopStatus`, so historical runs work the same as live ones.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `GET /autoloop/<id>/chat_history`        | `{ ok, entries: ChatEntry[] }` — replays `<ledger>/chat.jsonl`. The dashboard fetches this when opening a run so the Planner-pane conversation survives a page refresh / cross-process / re-opening a terminated run. Returns `[]` when the file doesn't exist.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `GET /autoloop/<id>/events`              | SSE: `snapshot` / `message` / `state` / `push` / `iter_done` / `planner_reply` / `planner_error` / `coder_reply` / `reviewer_reply` / `terminated`. For runs that are NOT in this process's memory (terminated, or live in another process), the endpoint emits a single-shot `snapshot` + `terminated` then closes — the dashboard's existing handlers render history without hanging. A run still in memory that has already reached `terminated` or `crashed` gets the same single-shot pair instead of an open stream that would never receive another event. Every such stream sets `retry: 864000000`, so an `EventSource` does not keep reconnecting to a stream that can only end again.                                                                                                                                                                                                                                                                                            |
| `POST /autoloop/<id>/chat`               | **202** `{ ok, queued: true }` — body `{ text }`. Fire-and-forget: the Planner's reply streams back via the `/events` SSE channel as a `planner_reply` event (or `planner_error` on failure); the HTTP response intentionally does NOT wait for it, because first-contact replies routinely exceed reverse-proxy idle limits (e.g. Cloudflare Tunnel cuts at ~100s → 524). 400 on empty text. 404 when the run is not in this process's memory: if the store still holds it, the error says so and names `POST /autoloop/<id>/resume`; an unknown or malformed id is plain `not found`. The MCP `autoloop_chat` tool path keeps the synchronous await-and-return-reply semantics (it runs in-process).                                                                                                                                                                                                                                                                                      |
| `GET /autoloop/<id>/resume-requirements` | `{ ok, runId, rolesNeedingCustomEngine }` — the roles whose engine was `custom`, so a caller knows which secret references a resume needs. Role names only; nothing sensitive. 404 when there is no such run.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `POST /autoloop/<id>/resume`             | `{ ok, state }` — restore the role engine/model choices from the run's spec and re-create dispatcher + runner. For recoverable send timeouts, body fields `send_timeout_ms` and `pending_dispatch_id` apply the increase-only migration described above; `allow_decrease`, lease overrides, and hard-cap overrides are rejected. A custom-engine config is never persisted and is never accepted over HTTP, so a role using `custom` is re-supplied by **reference**: `plannerCustomEngineRef` / `coderCustomEngineRef` / `reviewerCustomEngineRef` name an environment variable `CLAWO_CUSTOM_ENGINE_<NAME>` on the orchestrator host, which the server reads and resolves. The name is not sensitive, the value never crosses the wire, and an unknown name is an error rather than a silent start without credentials. Existing engine-specific conversation resume behavior is reused where supported; `chat.jsonl` remains the visual history fallback. 404 when there is no such run. |
| `POST /autoloop/<id>/delete`             | `{ ok }` — stops the loop if still live, deletes the run record from the run store, and purges the role sessions' persisted resume ids so the run cannot be resumed. The ledger directory under `<workspace>/tasks/<run_id>/` is kept on disk. 404 when there is no such run.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

The dashboard's 3-pane autoloop view (`/dashboard`) consumes these endpoints:

- **Left**: Planner chat (subscribes to `planner_reply`)
- **Center**: Coder activity (`coder_reply` + `iter_done`)
- **Right**: Reviewer verdicts (`reviewer_reply`)
- **Top bar**: state (status / iter / metric)
- **Bottom**: push_log

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
    "target": 1.0,
  },
  "gates": [{ "name": "tests_pass", "cmd": "npm test", "must": "exit-0" }],
  "termination": {
    "max_iters": 10,
    "scalar_target_hit": true,
  },
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

## Acceptance contracts

The Reviewer's sandbox holds the iteration's artifacts (`directive.json`,
`diff.patch`, `eval_output.json`, `coder_summary.txt`, `plan.md`, `goal.json`,
the prior verdict) but no code or evaluator, so its `advance` is a judgement of
the Coder's report rather than a measurement.

An acceptance contract closes that gap. When one is configured, an `advance`
stands only if the checks pass against the workspace: otherwise the verdict is
rewritten to `hold`, the failing checks are appended to `audit_notes`, and the
bundle is written to `<ledger>/evidence/iter-<n>/`. A passing contract fires
`on_target_hit`. Without a contract the Reviewer's verdict is used as-is.

**The contract is library-level only.** It is set on the dispatcher config
(`contract` in `ClaudeAgentDispatcherConfig`) and is not yet exposed through
`autoloop_start` or the HTTP API, so a run started from the tool or
`POST /autoloop/new` has no contract.

## Lifecycle and resume

An autoloop is a kernel run whose single node holds the loop for as long as it
lives. The run record holds the last state the loop published and the engines
`spawn_subagents` chose, so `autoloop_status` and `GET /autoloop/<id>/state`
show a run's real state after it stops or the process restarts.

Resume is explicit. `POST /autoloop/<id>/resume` (or
`SessionManager.autoloopResume()`) restarts a run from its stored spec.
Custom-engine configs are the one thing the spec does not carry (they can hold
secrets), so a resume must be given them again. Cancelling a run stops all three
agents, the same as `autoloop_stop`.

## Known limitations

- **`webchat` channel is a no-op.** No webchat session id is carried at the run
  level, so `channel: 'webchat'` always returns `channel_used: 'none'`. Use
  `auto` / `wechat` / `email`.
- **One-way push.** Replies to a push are not routed back to the Planner;
  answer with `autoloop_chat`.
- **No fork / population mode.** Single linear iter trajectory per run.
- **Cross-run knowledge isolated.** Each run's `reviewer_memory.md` and
  `coder_notes.md` live in that run's ledger; there is no shared store.
- **No cost cap.** `maxBudgetUsd` is not exposed for autoloop. Wall-clock time
  is bounded by `autoloop_hard_timeout_ms` (default 24 h); the iteration count
  is bounded only by the Planner honouring `max_iters` in `goal.json`.
- **Resume is not automatic.** After a restart a run is not live in the new
  process until it is resumed, and a send that was in flight is not retried.
- **Multi-run / same workspace** races on `git index.lock`. Run separate
  workspaces (or git worktrees) for concurrent runs.

## Related

- [`verification.md`](./verification.md) — contracts, checks, evidence
- [`workflow.md`](./workflow.md) — the kernel that stores and resumes runs
