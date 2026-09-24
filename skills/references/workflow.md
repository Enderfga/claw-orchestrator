# Workflow kernel — durable runs

A durable executor for workflow runs: what is running, what happens when a step
fails, when to stop, and how to come back after the process dies.

## Every mode runs on it

`council_start`, `fanout_start`, `ultraplan_start`, `ultrareview_start` and
`autoloop_start` all create a kernel run. Their result shapes —
`CouncilSession`, `FanoutSession`, `UltraplanResult`, `UltrareviewResult`,
`AutoloopState` — are _projected_ from the run record.

The mode engines (`Council`, `Fanout`, the autoloop planner/coder/reviewer
dispatcher) do the work; the kernel owns lifecycle, persistence and listing. A
run's record stays on disk until you delete it.

## Durability contract

Every state transition is checkpointed **before the next step begins**:

```
~/.claw-orchestrator/wf/<runId>/        (override with CLAWO_WF_DIR)
  spec.json         the WorkflowSpec, written once, never mutated
  run.json          the mutable checkpoint, rewritten atomically (tmp + rename)
  events.jsonl      append-only audit + SSE source
  incarnation.json  which creation of this run id this is, and its fence counter
  lease.json        who is executing it right now
  .tx/              a committed batch awaiting application (see below)
  nodes/<id>/       per-node artifacts
  evidence/<id>/    evidence bundles
```

Splitting the immutable spec from the mutable checkpoint is what makes recovery
total: if `run.json` is missing or half-written, state is rebuilt by replaying
`events.jsonl` against `spec.json`. The atomic rewrite makes that path rare; the
replay makes it survivable anyway.

A kernel resumes at a **node boundary**, never mid-node, and at the node the run
was on — not at the first pending node, since a node on a branch the run never
took stays pending. Nodes already marked succeeded are not re-run; the node that
was in flight when the process died is retried from the start, because a
half-finished node left no result to trust. A node that had finished just before
the process died continues at its successor; a router is evaluated again, since
its choice is not recorded. A run parked at a `human_gate` parks there again.

Steers survive a restart. They are logged when they arrive and recorded as
consumed when the node that took them finishes, so on resume every steer no
finished node consumed is queued again — including one a node was holding when
it died, which goes to that node's retry.

**This makes node execution at-least-once, not exactly-once.** There is no
idempotency key and no side-effect commit marker, so a node that wrote files and
then died before its checkpoint runs again from the top. Workflows whose nodes
are not safe to repeat need to make them safe. Resume is also explicit —
`workflow_resume` — not automatic.

### One owner, and one way to write

Executing a run means holding a **`RunGuard`** — a capability, not a flag. It
names four things, and all four are checked on every durable write:

| Field           | What it pins down                                       |
| --------------- | ------------------------------------------------------- |
| `incarnationId` | which _creation_ of this run id this is                 |
| `ownerId`       | which `RunKernel` instance (never the pid)              |
| `acquisitionId` | which claim by that owner                               |
| `fence`         | monotonic within the incarnation, for ordering and logs |

- **`commit(guard, batch)` is the only way to change anything durable.**
  Checkpoints, events and node artifacts all go through it, inside one `O_EXCL`
  critical section that verifies the guard first. The raw writers are not
  exported, so there is no path around it.
- **A batch lands whole.** It is staged in a scratch directory and published by a
  single atomic directory rename; the rename is the commit point, and what
  follows is replayable application of an already-committed transaction. A reader
  finishes any transaction a crashed owner left, and applying is idempotent — the
  manifest records the event log's length from before, so recovery truncates and
  re-appends rather than duplicating.
- **Creating a run and claiming it are one step.** The run directory is made with
  a non-recursive `mkdir`, which _is_ the claim — it fails for everyone but the
  first caller, so two processes creating the same id cannot both succeed.
- **The lock is exclusive, and release is not "unlink that path".** A vanished
  lock is retried rather than treated as stale debris; a genuinely stale one is
  broken by atomic rename; and a holder removes the lock file only if it is still
  the one it created.
- **A published transaction is authoritative before it is applied.** Readers
  finish any pending transaction first, and refuse rather than hand back the
  older checkpoint if it cannot be applied. Applying carries a marker written
  after the last data step, so a failure during cleanup cannot make a healthy
  transaction permanently unapplicable.
- **`delete` claims before removing**, so no other process can resume the run
  while its directory is being removed.
- **Contention is not a takeover.** `commit` reports `committed`, `superseded` or
  `blocked`, and only `superseded` is permanent. The lock waits briefly rather
  than failing on sight, and an owner that still cannot write stops _and hands
  its claim back_ — a live local pid is never judged stale, so a lease left
  behind by a stopped run could otherwise never be taken over.
- **Copy-on-write.** A change is applied to a clone, committed, and adopted only
  if the disk accepted it, so the record a superseded owner hands back to its
  caller stops advancing too.
- **A deleted run id is a new run.** The fence lives in `incarnation.json`, which
  survives `releaseLease` (so the counter never restarts while the run exists)
  and dies with the run directory (so the next run under the same id gets a new
  random `incarnationId`). An abandoned attempt from a deleted run therefore
  cannot write into a new run that reuses its id.
- **Re-acquiring supersedes.** A second claim, even by the same owner, mints a
  new `acquisitionId` and kills the previous guard.
- **Owner identity is not the pid.** Two kernels in one process share a pid;
  each has its own owner id, or both would read the other's claim as their own.
- **Atomic acquisition.** The check and the write happen inside the lock, so two
  processes cannot both see "free" and both claim the run.
- **An independent heartbeat.** Renewed on a timer, not only at checkpoints: a
  run executing one long node makes no checkpoints, and must not look abandoned
  for it. On the same host a live pid is the authority and is never judged stale
  for going quiet; the heartbeat is the fallback for a holder on another machine.
- **In-process too.** Starting a run whose id is already live retires the
  previous run first. A lease cannot see inside one process, and two live runs
  sharing an id would write over each other's checkpoints.

A second process trying to resume a run someone else is executing is refused by
name, with the owner's pid and host in the message.

One thing deliberately sits outside the guard: **evidence bundles**. They are
written by the verifier as its checks run, under
`evidence/<node>-v<visit>-<attempt>/`,
and they are append-only artifacts, never read as state. What makes a bundle
authoritative is the run record's `evidenceId` pointing at it, and that reference
_is_ committed under the guard. So a bundle left behind by an owner that has been
superseded is inert: nothing refers to it, and the run it belonged to did not get
to claim it.

The checkpoint and the events describing it are written by one transaction, so
they cannot disagree: a commit either lands both or neither. The replay is a
plain fallback for a lost `run.json`. A run that lost both it and the event log
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
| `autoloop`   | A long-lived Planner / Coder / Reviewer loop; its executor is injected                    |
| `ultraapp_*` | UltraApp's synth and deploy stages; their executors are injected too                      |

Every node takes `retry: { max, backoffMs }`, `timeoutMs`, and
`onFailure: 'fail' | 'continue'`.

On `fanout` and `council`, `timeoutMs` bounds the whole node and `agentTimeoutMs` one
agent's send. They differ because agents beyond the free session slots wait for one, so
the node can run several agents' worth of time. Without `agentTimeoutMs`, `timeoutMs`
serves as both. `fanout_start`, `ultrareview_start`,
`council_start` and the built-in `fanout`, `council` and `solve` workflows set both: the
agent's own default, and a node bound for the worst case — one agent at a time, every
retry taken.

Parallelism is the `fanout` node rather than a general parallel/join construct.
Fan-out is the shape every existing mode actually needed, and a join barrier would
add failure modes (partial joins, orphaned branches) that nothing here exercises.

## Routing is not an expression language

A spec can arrive from a tool call, which means it can arrive from an agent. If
routing accepted a JS expression, the kernel would be an arbitrary code execution
surface. These closed forms are evaluated and nothing else:

```jsonc
{ "type": "always" }
{ "type": "node_failed",    "node": "verify" }
{ "type": "node_succeeded", "node": "verify" }
{ "type": "verified",       "node": "verify" }
{ "type": "visits_lt",      "node": "implement", "n": 4 }
{ "type": "and",            "all": [ /* … */ ] }
```

`and` is the only recursive one, and nesting is capped at six deep. Use it rather
than chaining two routers: **a router whose routes all miss falls through to the
next node**, so a gate that failed to match simply hands control to the router
after it, which then matches on its own. Chaining reads as AND and behaves as
"whatever the last router says".

`maxNodeVisits` (default 50) bounds every loop as a safety backstop. Budget loops
with `visits_lt`.

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
      "routes": [
        {
          "when": {
            "type": "and",
            "all": [
              { "type": "node_failed", "node": "verify" },
              { "type": "visits_lt", "node": "implement", "n": 4 },
            ],
          },
          "to": "implement",
        },
      ],
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
  (optional review) → verify → repair-until-green.
- **`council`** — one council node, plus the implicit verifier when a contract is
  declared.
- **`fanout`** — one fan-out node.

These are ordinary specs, not privileged paths.

## The verifier is a terminal barrier

A passing verdict only stands while it still describes the tree.

This cannot be enforced by inspecting the spec — a router can send control
anywhere, so which node runs last is not a property of the graph. And "nothing
may follow the verifier" would be the wrong rule anyway: what matters is not that
a node ran, but that the tree moved. So the kernel measures. Each evidence bundle
records a content digest of the working tree (HEAD, the full `git diff HEAD`,
and the path and bytes of every untracked file), and when the run ends, if any
workspace-touching node ran after the verdict, the digest is recomputed.

If it moved, the outcome drops from `verified` to `unverified` with the reason
recorded on the run. Not `refuted` — no check failed; we simply stopped knowing,
which is exactly what the third outcome is for.

Outside a git repository the digest is unavailable. Nothing running after the
checks means the verdict stands regardless (a contract that passed in a plain
directory passed); something running after it means we cannot vouch, and the run
says so.

The built-in `solve` template puts its reviewer fan-out **before** the verifier,
so anything the reviewers change is covered by the verdict.

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
- Nothing prunes run directories. Delete them yourself
  (`rm -rf ~/.claw-orchestrator/wf/<runId>`), or programmatically with
  `SessionManager.workflowDelete(runId)`.

## Related

- [`verification.md`](./verification.md) — contracts, checks, evidence
- [`observability.md`](./observability.md) — how a run's verdict reaches the ledger
- [`council.md`](./council.md), [`autoloop.md`](./autoloop.md), [`ultraapp.md`](./ultraapp.md) — the modes that run on the kernel
