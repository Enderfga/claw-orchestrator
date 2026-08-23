# Workflow kernel — durable runs

A durable executor for workflow runs: what is running, what happens when a step
fails, when to stop, and — the part none of the previous state machines had — how
to come back after the process dies.

## Every mode runs on it

`council_start`, `fanout_start`, `ultraplan_start`, `ultrareview_start` and
`autoloop_start` all create a kernel run. Their tool signatures are unchanged and
their result shapes are unchanged — `CouncilSession`, `FanoutSession`,
`UltraplanResult`, `UltrareviewResult`, `AutoloopState` are now _projected_ from
the run record rather than held in a map.

The engines that do the work — `Council`, `Fanout`, the autoloop
planner/coder/reviewer dispatcher — are untouched. What they lost is ownership of
a lifecycle. Deleted along the way:

| Gone               | Was                                                                              |
| ------------------ | -------------------------------------------------------------------------------- |
| 5 result maps      | `councils`, `fanouts`, `ultraplans`, `ultrareviews`, `autoloops`                 |
| 4 eviction timers  | a 30-minute TTL per mode, three of them separate implementations                 |
| 1 poller           | ultrareview asking the fan-out every 5s whether it had finished                  |
| 2 fences           | `_startingAutoloops` / `_deletingAutoloops`, guarding a shared map               |
| 2 disk enumerators | a regex over council markdown transcripts; a bespoke JSONL registry for autoloop |

Concretely, three bugs went with them: a fan-out's results vanished 30 minutes
after it finished; an ultraplan still running when its TTL fired was rewritten as
`error: 'Timed out (TTL expired)'` and deleted, so a long plan could be destroyed
by its own eviction timer; and ultrareview's correctness depended on the
fan-out's TTL — evict first and its poll threw, the interval was cleared, and the
review stayed `running` forever.

## Why this exists

Through 5.1.0 each mode carried its own machinery. The same "start in the
background, poll by id, evict after 30 minutes" was written four separate times
(`council`, `fanout`, `ultraplan`, `ultrareview`), with four timer sites and six
status vocabularies that did not overlap. Cross-process listing was implemented
three incompatible ways — council scraped its own markdown transcripts with a
regex, autoloop read a JSONL registry, ultraapp walked a store directory.

More to the point, most of it was not durable. A fan-out wrote nothing to disk at
all and its results vanished after 30 minutes. Ultraplan and ultrareview were
entirely in memory. A council that crashed mid-round left worktrees and branches
on disk with no index pointing at them. UltraApp's build queue documented that it
did not persist, so a restart mid-build failed the build.

## Durability contract

Every state transition is checkpointed **before the next step begins**:

```
~/.claw-orchestrator/wf/<runId>/        (override with CLAWO_WF_DIR)
  spec.json      the WorkflowSpec, written once, never mutated
  run.json       the mutable checkpoint, rewritten atomically (tmp + rename)
  events.jsonl   append-only audit + SSE source
  nodes/<id>/    per-node artifacts
  evidence/<id>/ evidence bundles
```

Splitting the immutable spec from the mutable checkpoint is what makes recovery
total: if `run.json` is missing or half-written, state is rebuilt by replaying
`events.jsonl` against `spec.json`. The atomic rewrite makes that path rare; the
replay makes it survivable anyway.

A kernel resumes at a **node boundary**, never mid-node. Nodes already marked
succeeded are not re-run; the node that was in flight when the process died is
retried from the start, because a half-finished node left no result to trust.

**This makes node execution at-least-once, not exactly-once.** There is no
idempotency key and no side-effect commit marker, so a node that wrote files and
then died before its checkpoint runs again from the top. Workflows whose nodes
are not safe to repeat need to make them safe. Resume is also explicit —
`workflow_resume` — not automatic.

**One owner at a time**, though, and it is enforced rather than agreed:

- **Atomic acquisition.** The check and the write happen inside an `O_EXCL` lock
  file. Read-then-write let two processes both see "free" and both conclude they
  had it, which is the failure a lease exists to prevent.
- **A fencing token.** Each acquisition bumps a counter, and the holder verifies
  it before every state write. A process wrongly declared dead — a long GC pause,
  a suspended laptop — stops instead of writing alongside its replacement.
- **An independent heartbeat.** Renewed on a timer, not only at checkpoints: a
  run executing one long node makes no checkpoints, and must not look abandoned
  for it. On the same host a live pid is the authority and is never judged stale
  for going quiet; the heartbeat is the fallback for a holder on another machine.
- **In-process too.** Starting a run whose id is already live retires the
  previous run first. A lease cannot see inside one process, and two live runs
  sharing an id would write over each other's checkpoints.

A second process trying to resume a run someone else is executing is refused by
name, with the owner's pid and host in the message.

One more caveat worth stating plainly: event appends are best-effort (a log
failure is warned and swallowed so it cannot break the run it describes), yet
the replay path treats that log as authoritative when the checkpoint is gone.
Those two properties are in tension. The checkpoint is the primary record; the
replay covers the narrow window where it was mid-rewrite. A run that lost both
is unrecoverable and reads back as "not found".

## Node kinds

| Kind         | Does                                                                                      |
| ------------ | ----------------------------------------------------------------------------------------- |
| `agent`      | One session, one turn                                                                     |
| `fanout`     | N agents in parallel, optional synthesis                                                  |
| `council`    | The existing council engine, votes recorded as advisory                                   |
| `verifier`   | Runs an acceptance contract, writes evidence — see [`verification.md`](./verification.md) |
| `human_gate` | Parks the run until a person answers                                                      |
| `router`     | Picks the next node from declarative conditions; a backwards route is the loop            |
| `subflow`    | Runs another workflow as a step and adopts its verdict                                    |

Every node takes `retry: { max, backoffMs }`, `timeoutMs`, and
`onFailure: 'fail' | 'continue'`.

Parallelism is the `fanout` node rather than a general parallel/join construct.
Fan-out is the shape every existing mode actually needed, and a join barrier would
add failure modes (partial joins, orphaned branches) that nothing here exercises.

## Routing is not an expression language

A spec can arrive from a tool call, which means it can arrive from an agent. If
routing accepted a JS expression, the kernel would be an arbitrary code execution
surface. Five closed forms are evaluated and nothing else:

```jsonc
{ "type": "always" }
{ "type": "node_failed",    "node": "verify" }
{ "type": "node_succeeded", "node": "verify" }
{ "type": "verified",       "node": "verify" }
{ "type": "visits_lt",      "node": "implement", "n": 4 }
```

`maxNodeVisits` (default 50) bounds every loop as a backstop. Use `visits_lt` for
the actual budget — the backstop failing a run is a bug report, not a feature.

## Example: repair until green

```jsonc
{
  "name": "solve",
  "cwd": "/repo",
  "maxNodeVisits": 6,
  "contract": { "checks": [{ "type": "command", "cmd": "npm", "args": ["test"] }] },
  "nodes": [
    {
      "id": "triage",
      "kind": "fanout",
      "prompt": "Investigate. Change nothing.",
      "agents": [
        { "name": "a", "engine": "claude" },
        { "name": "b", "engine": "codex" },
      ],
      "synthesize": true,
    },
    { "id": "implement", "kind": "agent", "prompt": "Fix the failing test", "onFailure": "continue" },
    { "id": "verify", "kind": "verifier", "contract": "run", "onFailure": "continue" },
    {
      "id": "repair-gate",
      "kind": "router",
      "routes": [{ "when": { "type": "node_failed", "node": "verify" }, "to": "repair-budget" }],
    },
    {
      "id": "repair-budget",
      "kind": "router",
      "routes": [{ "when": { "type": "visits_lt", "node": "implement", "n": 4 }, "to": "implement" }],
    },
  ],
}
```

The run leaves `completed` only if the last `verify` was green. There is no
second verifier at the end on purpose: re-running a contract that shells out to a
test suite would double the most expensive part of the run to learn nothing new.

## Built-in templates

`workflow_start` accepts `template` instead of `spec`:

- **`solve`** — the shape above: triage → (optional human gate) → implement →
  verify → repair-until-green → optional review.
- **`council`** — one council node, plus the implicit verifier when a contract is
  declared.
- **`fanout`** — one fan-out node.

These are ordinary specs, not privileged paths.

## The verifier is a terminal barrier

A passing verdict only stands while it still describes the tree.

The digest is over **content**, not status: HEAD, the full `git diff HEAD`, and
the bytes of every untracked file. An earlier version hashed
`git status --porcelain`, which reports a file's state rather than its bytes — so
a file already `M` before the checks and rewritten afterwards produced an
identical digest, and the commonest case (an agent editing a file it had already
edited) was the one it could not see.

This cannot be enforced by inspecting the spec — a router can send control
anywhere, so which node runs last is not a property of the graph. And "nothing
may follow the verifier" would be the wrong rule anyway: what matters is not that
a node ran, but that the tree moved. So the kernel measures. Each evidence bundle
records a digest of the working tree (`git rev-parse HEAD` plus
`git status --porcelain`), and when the run ends, if any workspace-touching node
ran after the verdict, the digest is recomputed.

If it moved, the outcome drops from `verified` to `unverified` with the reason
recorded on the run. Not `refuted` — no check failed; we simply stopped knowing,
which is exactly what the third outcome is for.

Outside a git repository the digest is unavailable. Nothing running after the
checks means the verdict stands regardless (a contract that passed in a plain
directory passed); something running after it means we cannot vouch, and the run
says so.

The built-in `solve` template puts its reviewer fan-out **before** the gate for
this reason. It shipped the other way round first, which let reviewers edit a
tree the verifier had already signed off while the run still reported `verified`.

## Completion

`RunState` is `pending | running | awaiting_human | verifying | completed |
failed | cancelled`. **`completed` is reachable only from `verifying`.**

`RunOutcome` is `verified | unverified | refuted` and answers a different
question: not "did it stop" but "did anything check it". A run with no contract
completes as `unverified` — it says it does not know, which is not the same as
success.

## Control

| Action        | Tool               | HTTP                              | CLI                                    |
| ------------- | ------------------ | --------------------------------- | -------------------------------------- |
| Start         | `workflow_start`   | `POST /workflow/new`              | —                                      |
| Poll          | `workflow_status`  | `GET /workflow/<id>/state`        | `clawo workflow show <id>`             |
| List          | `workflow_list`    | `GET /workflow/list`              | `clawo workflow list`                  |
| Resume        | `workflow_resume`  | `POST /workflow/<id>/resume`      | `clawo workflow resume <id>`           |
| Cancel        | `workflow_cancel`  | `POST /workflow/<id>/cancel`      | `clawo workflow cancel <id>`           |
| Steer         | `workflow_steer`   | `POST /workflow/<id>/steer`       | `clawo workflow steer <id> "<text>"`   |
| Answer a gate | `workflow_approve` | `POST /workflow/<id>/approve`     | `clawo workflow approve <id> [reject]` |
| Evidence      | —                  | `GET /workflow/<id>/evidence`     | `clawo verify <id>`                    |
| Live events   | —                  | `GET /workflow/<id>/events` (SSE) | —                                      |

Steer text is **prepended** to the next agent node's prompt: an instruction that
arrives while the previous node was running is a correction, and corrections
belong before the task.

## Limits worth knowing

- A node timeout stops the kernel waiting and marks the node failed. The
  in-flight agent turn is owned by the session layer and finishes on its own
  schedule; the kernel does not pretend to kill it. The abandoned attempt keeps
  running, so agent nodes name their session per attempt
  (`<runId>-<nodeId>-a<n>`) — otherwise the dying attempt's teardown would stop
  the retry's session. A node that writes to a fixed path outside the run
  directory can still race its own retry; scope such writes per attempt.

  Because such an attempt can still write, a run about to report `verified`
  waits briefly for outstanding attempts to settle, and reports `unverified`
  with the reason if any is still going. It will not hold the run open for one
  that never stops — it declines to vouch instead.

- Cancel and a node timeout are different things. A timeout is a node failure
  (it still gets its retries and still honours `onFailure`); cancelling ends the
  run.
- Nothing prunes run directories. Delete them yourself, or with
  `workflowDelete`.

## Related

- [`verification.md`](./verification.md) — contracts, checks, evidence
- [`observability.md`](./observability.md) — how a run's verdict reaches the ledger
- [`council.md`](./council.md), [`autoloop.md`](./autoloop.md), [`ultraapp.md`](./ultraapp.md) — the modes, and what changed for each
