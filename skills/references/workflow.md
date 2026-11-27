# Workflow kernel — durable runs

A durable executor for workflow runs: what is running, what happens when a step
fails, when to stop, and how to come back after the process dies.

## Every mode runs on it

`workflow_start` runs a spec you write or a [built-in template](#built-in-templates);
`clawo solve`, `clawo fanout` and `clawo goal` start the same templates from a
terminal. The mode tools run on the same kernel: `council_start`, `fanout_start`,
`ultraplan_start`, `ultrareview_start` and `autoloop_start` each create a kernel
run, and so does an UltraApp build. The modes' result shapes — `CouncilSession`,
`FanoutSession`, `UltraplanResult`, `UltrareviewResult`, `AutoloopState` — are
_projected_ from the run record, so `workflow_list` lists every one of them.

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
  lease.json        who is executing it right now (removed when the run ends)
  lease.lock        the exclusive lock every write takes, present only while held
  .tx/              a committed batch awaiting application (see below)
  nodes/<id>/       per-node artifacts
  evidence/<id>/    evidence bundles
```

Splitting the immutable spec from the mutable checkpoint is what makes recovery
total: if `run.json` is missing or half-written, state is rebuilt by replaying
`events.jsonl` against `spec.json`: the run's state and outcome, and each node's
state, attempts, visits, output preview and evidence id. Node payloads (`data`),
cost, consensus votes, the base commit and the test snapshot are only in
`run.json`. The atomic rewrite makes that path rare; the replay makes it
survivable anyway.

A kernel resumes at a **node boundary**, never mid-node, and at the node the run
was on — not at the first pending node, since a node on a branch the run never
took stays pending. Nodes already marked succeeded are not re-run; the node that
was in flight when the process died is retried from the start, because a
half-finished node left no result to trust. A node that had finished just before
the process died continues at its successor; a router is evaluated again, since
its choice is not recorded. A run parked at a `human_gate` parks there again.

A process that stops cleanly leaves its runs the same way. On SIGTERM or SIGINT —
a host reboot, a service restart, an upgrade, Ctrl-C — `clawo serve` marks each
live run `suspended` (`{ at, reason }` on the record; `execution: suspended` in
`workflow_status`), freezes its checkpoint, stops its executors without
recording their failures, and hands the claim back. The run stays non-terminal
with its running node to be run again, exactly as after a crash, and the next
resume clears the mark and copies it onto the resume entry. A shutdown is not a
cancel: only `workflow_cancel` ends a run as `cancelled`.

Steers survive a restart. They are logged when they arrive and recorded as
consumed when the node that took them finishes, so on resume every steer no
finished node consumed is queued again — including one a node was holding when
it died, which goes to that node's retry. A `goal` node delivers steers into
the running turn as they arrive, so one delivered before a crash is delivered
again after the resume; one it took and never handed over (the goal ended with
no turn running) goes back to the queue when the node ends, for the next node,
and is not counted as consumed by the goal.

**This makes node execution at-least-once, not exactly-once.** There is no
idempotency key and no side-effect commit marker, so a node that wrote files and
then died before its checkpoint runs again from the top. Workflows whose nodes
are not safe to repeat need to make them safe.

A resume records the interruption on the node it found running (`interrupted` in
the node's record, a count, cleared when the node ends). An `agent` node, and a
`goal` node that starts a new thread, then get a note ahead of their prompt: the
step was interrupted and is running again from the beginning, so check what the
earlier run already did — jobs it submitted, messages it sent, services it
called, files it wrote — before doing it again. A `goal` node that picks its
thread back up has that conversation already and gets no note.

Resume is explicit — `workflow_resume` or `clawo workflow resume` — not automatic.
Resuming a run that already ended returns it unchanged. A resume re-checks with the
contract the run started with; rules a caller declares at the resume are recorded as
drift when they differ, never applied, and every resume is listed on the run
(`resumes`) — see [verification.md](./verification.md#which-rules-a-verdict-was-reached-under). Custom-engine configs are
never written to disk (they can carry credentials), so a run whose agents used one
is resumed through `workflow_resume` with `agentCustomEngineRefs:
{ "<agent>": "<REF>" }`, each config read as JSON from `CLAWO_CUSTOM_ENGINE_<REF>`
(upper-cased) on the orchestrator's host.

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
- **An independent heartbeat.** Renewed every 15 s on a timer, not only at
  checkpoints: a run executing one long node makes no checkpoints, and must not
  look abandoned for it. On the same host a live pid is the authority and is never
  judged stale for going quiet; the heartbeat is the fallback for a holder on
  another machine, whose lease goes stale after 60 s without a renewal.
- **A pid names its owner only within one boot.** On Linux the lease also records
  the host's boot id and the owner process's start time. A lease taken under
  another boot is stale, and so is one whose pid is alive but now belongs to a
  process started at a different time: after a reboot, or once the owner exits,
  the pid can be reused by an unrelated process and would otherwise keep the run
  locked. Leases without these fields are judged by the pid alone.
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

| Kind                                | Does                                                                                                                                                                                                                                                                |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent`                             | One session, one turn. A new session per attempt unless `sessionName` pins one                                                                                                                                                                                      |
| `fanout`                            | N agents in parallel on a shared prompt, optional synthesis pass. Succeeds when at least one agent does                                                                                                                                                             |
| `council`                           | The council engine; its votes are recorded as advisory. Fails only when the council itself errors                                                                                                                                                                   |
| `verifier`                          | Runs an acceptance contract, writes evidence — see [`verification.md`](./verification.md). `"contract": "run"` with no run-level contract passes through and verifies nothing; an inline contract with no recognised check is refused at start                      |
| `human_gate`                        | Parks the run until a person answers; a rejection fails the run. It asks as the orchestrator's `ASK @user` on the run's forum ([Control](#control))                                                                                                                 |
| `router`                            | Picks the next node from declarative conditions; a backwards route is the loop                                                                                                                                                                                      |
| `subflow`                           | Runs another workflow as a child run and adopts its verdict, with the tree digest the verdict was taken against; a child that ends `unverified` hands up no verdict                                                                                                 |
| `autoloop`                          | A long-lived Planner / Coder / Reviewer loop; its executor is injected. On the node's first visit (`visits === 1`) the shared fresh-start boundary applies (dirty-worktree refusal + run-local `tasks/<config.runId>/.gitignore`); resume and later visits skip it. |
| `goal`                              | A `/goal` on one Codex `codex-app` thread or Claude Code session, run until the goal finishes — see [below](#goal)                                                                                                                                                  |
| `ultraapp_synth`, `ultraapp_deploy` | UltraApp's synth and deploy stages; their executors are injected too                                                                                                                                                                                                |

### Spec and node fields

**Engines are fixed when a run starts.** An `agent` or `goal` node, or a fan-out or council agent, that names
no engine is given the configured default engine (`clawo config`, Claude Code out of the box) in the run's spec
when the run starts, so a resume after the default changed keeps the engine its sessions and threads belong to.
A run recorded before this was done resumes with what an unnamed engine meant then: Claude Code for sessions,
Codex for goals.

A `WorkflowSpec` is `{ name, nodes, cwd?, contract?, maxNodeVisits?, forum? }`. `cwd` is
the run's working directory (a start call's `cwd` overrides it), `contract` is the
run-level acceptance contract, `maxNodeVisits` (default 50) bounds every loop, and
`forum` gives the run's agents a shared forum ([below](#the-run-forum)); a forum
config that is malformed, or a forum whose agent names cannot be addressed, is refused.
A spec is checked before anything runs: a missing name, no nodes, a missing or
duplicate node id, a `next`, route or `default` naming a node that does not exist,
a route with no condition, a `retry.max` that is not a non-negative integer, a
`timeoutMs` that is not a positive number, and a `maxNodeVisits` that is not a
positive integer are all refused.

With a run-level contract the kernel appends one more node, the verifier
`__verify`, unless a node already declares `"contract": "run"`.

Every node has an `id` and a `kind`, plus these optional fields:

| Field       | Default                                      | Meaning                                                                                                       |
| ----------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `next`      | the next node in `nodes` order               | Explicit successor; a router ignores it and uses `default`. The run ends after the last node in `nodes` order |
| `retry`     | `{ "max": 0 }`                               | `max` extra attempts per visit, waiting `backoffMs` (default 1000) × the attempt number between them          |
| `timeoutMs` | 30 min; none for `autoloop` and `goal` nodes | Wall clock for one attempt                                                                                    |
| `onFailure` | `fail`                                       | `fail` ends the run; `continue` records the failure and moves on                                              |

The kind-specific fields:

| Kind                                | Fields                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent`                             | `prompt` (required); `engine`, `model`, `effort`, `acpAgent` (a bundled ACP preset id, for `engine: "acp"`); `cwd` (default: the run's); `inputs`, nodes whose output it reads before its prompt (framed as data, at most 12,000 characters each with the path of the whole; a node that has not run is left out; an agent or goal node's output is read from the handover it posted on the run's forum); `continueConversation`, to keep one conversation across this node's visits without naming it; `sessionName`, to keep one conversation across visits and nodes (each turn's process stops, and the next start under the name resumes the conversation; the name outlives the run, so make it unique to the run); `permissionMode` (default `bypassPermissions`); `appendSystemPrompt`, standing instructions for the session; `disallowedTools`, tools the session may not use (engines `claude` and `grok`; refused at start on the others)                                                                                                                                                                                                         |
| `fanout`                            | `prompt` (required, the shared task) and `agents` (required); `synthesize`, `synthesisEngine` (default: the configured default engine), `synthesisModel`, `synthesisAcpAgent`, `synthesisPermissionMode` (ignored — it runs read-only); `maxTurnsPerAgent` and `maxBudgetUsd`, per agent; `cwd`; `agentTimeoutMs`. An agent's own `cwd` (absolute, or relative to the node's) starts it in a directory of its own, so agents that each write code do not edit the same files; every result records the `cwd` it ran in. An agent with an `objective` runs as a goal instead of one turn (on any goal engine, `acp` with `acpAgent`; omitted, the configured default if it runs goals; `tokenBudget`, `timeoutMs`, `stallMs`, `capacityRetry` as on a goal node): each goal runs in a child run of one `goal` node, checkpointed in `data.goalRuns`, so a resumed parent reattaches to it instead of starting it again, and its result carries `goal: { runId, status, tokensUsed, threadId }`. Goal agents run beside the turn agents; `synthesize` is refused with them, and the node's `timeoutMs` must cover the longest goal (`fanout_start` sizes it so) |
| `council`                           | `task` (required) and `agents` (required); `projectDir` (default: the run's cwd); `maxRounds` (default 15, as for `council_start`); `maxTurnsPerAgent` and `maxBudgetUsd`, per agent; `defaultPermissionMode`; `agentTimeoutMs`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `verifier`                          | `contract` (required): an inline contract, or `"run"` for the run-level one; `cwd` (default: the run's); `fixer`, the engine, model, permissions and sandbox of a fix-on-red session (default: the default engine, `bypassPermissions`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `human_gate`                        | `prompt` (required)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `router`                            | `routes` (required): `[{ "when": <condition>, "to": <node id> }]`, first match wins; `default`, taken when nothing matches (omitted: fall through to the next node)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `subflow`                           | `workflow` (required): an inline `WorkflowSpec`, or the id of an existing run, whose stored spec runs again as a new child run. Template names do not resolve here                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `goal`                              | `objective` (required); `engine`, `cwd`, `model`, `effort`, `sandboxMode`, `launcher`, `threadId`, `tokenBudget`, `capacityRetry`, `stallMs`, `acpAgent` (for `engine: "acp"`), `disallowedTools` (`claude` and `grok`; refused at start on the others) — see [Goal](#goal)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `autoloop`                          | `workspace` and `config` (the `autoloop_start` options). Started by `autoloop_start`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `ultraapp_synth`, `ultraapp_deploy` | `appRunId`, `runDir`, `slug`; the deploy stage adds `version` and `codebasePath`. Started by UltraApp builds only: `workflow_start` refuses them, inline subflows included                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

An entry in a fan-out's or council's `agents` takes `name` (required), `engine`,
`model`, `effort`, `acpAgent`, `persona`, `prompt`, `permissionMode`, `sandboxMode`
(forwarded to the seat's session; how a mode is applied is engine-specific) and
`baseUrl`; a council agent also takes `ultracode` and
`emoji` (shown with its name in its charter and the transcript). An agent
node and each of these entries use `engine`, `model` and `effort` the same way;
`effort` accepts `low`, `medium`, `high`, `xhigh`, `max`, `ultra`, or `auto`, and
omitting any of them preserves the session default. `customEngine` is not a spec
field — a spec is written to disk and a custom-engine config can carry
credentials — so custom engines reach a run in memory, through `fanout_start` or
`council_start`, and are re-supplied on resume as described above.

A fan-out's synthesis pass always runs read-only — `permissionMode: "plan"` and
`sandboxMode: "read-only"` (`plan` alone on `acp`, which cannot be held to a
sandbox) — whatever `synthesisPermissionMode` says: it reads the agents' answers
and writes one of its own, in the directory the agents shared.

A council agent's `persona` is its role; one with no `persona` uses its `prompt`
instead. Fan-out agents may also set `persona` for role instructions. When no non-empty
per-agent `prompt` exists, the executor sends the persona followed by a
`## Shared task` section containing the node's shared prompt. A non-empty
per-agent `prompt` remains a complete override and takes precedence over both
persona and the shared task. The spec stores `prompt` and `persona` separately,
so a resumed node reconstructs the same message.

An `agent` node's turn runs as long as the node may: its `timeoutMs`, or the kernel's node default (30 minutes).
Cancelling the run, or the attempt timing out, stops the node's session — and the commands its engine started —
rather than leaving it at work beside a retry. Every directory a run works in (its `cwd`, each node's and each
fan-out agent's) is checked at start as a session's is, so a system or credentials directory is refused.

On `fanout` and `council`, `timeoutMs` bounds the whole node and `agentTimeoutMs` one
agent's send (30 minutes by default on both). A fan-out writes each agent's output, and the synthesis, to
`outputs/<agent>.md` and `outputs/synthesis.md` in the run directory, and its results name them (`outputFile`,
`synthesisFile`); an agent whose send timed out is `timedOut: true`, with what it had streamed as its output. They differ because agents beyond the free session slots wait for one, so
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

`node_failed` and `node_succeeded` read the named node's current state (a node
that has not run is neither). `verified` holds when the named node produced
evidence and the run's current verdict is `verified`. `visits_lt` counts how many
times control has entered the node. Routes are tried in order and the first match
wins.

`and` is the only recursive one, and nesting is capped at six deep; an `and` with
an empty `all` is false. Use it rather than chaining two routers: **a router whose
routes all miss falls through to the next node** (or to its `default`), so a gate
that failed to match simply hands control to the router after it, which then
matches on its own. Chaining reads as AND and behaves as "whatever the last router
says".

`maxNodeVisits` (default 50) bounds every loop as a safety backstop. Budget loops
with `visits_lt`.

## Example: repair until green

```jsonc
{
  "name": "solve",
  "cwd": "/repo",
  "maxNodeVisits": 6,
  "contract": { "checks": [{ "spec": { "type": "command", "cmd": "npm", "args": ["test"] } }] },
  "nodes": [
    {
      "id": "triage",
      "kind": "fanout",
      "prompt": "Investigate. Change nothing.",
      "agents": [
        { "name": "a", "engine": "claude", "effort": "high" },
        { "name": "b", "engine": "codex", "effort": "ultra" },
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

Every contract a run carries — the run-level `contract`, a verifier's inline one,
and the `contract` argument of `workflow_start` and `POST /workflow/new` — is
normalized at start, so a check may be written bare (`{ "type": "command", … }`) or
in the `{ "spec": { … } }` wrapper shown here, with `id` and `required` beside
`spec`. The `contract` argument, when given, replaces the spec's own.
See [`verification.md`](./verification.md#the-one-rule-about-where-contracts-come-from).

When the router sends control back to `implement`, the agent is told what the
last verification found: each failing required check and the lines of its output
that say why, framed as data, ahead of the node's own prompt. This applies to any
`agent` node re-entered after a failed verifier, not only to `solve`.

The run leaves `completed` only if the last `verify` was green. There is no
second verifier at the end on purpose: re-running a contract that shells out to a
test suite would double the most expensive part of the run to learn nothing new.

## Built-in templates

`workflow_start` accepts `template` and `task` instead of `spec` (`template`
defaults to `solve`); `clawo solve`, `clawo fanout` and `clawo goal` build the same
specs and post them.

| Template  | Nodes                                                                                                                                                                    | Arguments                                                                                                                                                                                         |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `solve`   | `triage` (fan-out) → `approve` (human gate, only with `humanGate`) → `implement` (agent) → `review` (fan-out, only with `reviewers`) → `verify` → `repair-gate` (router) | `agents` (the triage scouts; default one agent on the default engine), `implementer` (`engine`, `model`), `reviewers`, `humanGate`, `maxRepairs` (default 3), `contract`                          |
| `council` | `council`, then `__verify` when a contract is declared                                                                                                                   | `agents`, `maxRounds` (default 15), `contract`                                                                                                                                                    |
| `fanout`  | `fanout`, then `__verify` when a contract is declared                                                                                                                    | `agents`, `contract`                                                                                                                                                                              |
| `goal`    | `goal` → `verify` → `repair-gate` (router); `task` is the objective. See [below](#goal)                                                                                  | `engine` (`claude`, `codex`, `agy`, `grok`, `cursor`, `opencode` or `acp`; omitted, the configured default), `acpAgent`, `model`, `tokenBudget`, `launcher`, `maxRepairs` (default 1), `contract` |

`solve` is the shape above: the triage and review fan-outs add a synthesis pass
when they have two or more agents, `implement` and `review` continue on failure so
the verifier always judges the tree, `verify` continues so a red result reaches
`repair-gate`, and `maxNodeVisits` is `maxRepairs + 3`. `implement` reads what the
scouts found, and on a repair what the reviewers found (`inputs`), and a repair
continues its conversation (`continueConversation`). `verify`'s timeout is sized
from the checks, and a fix-on-red round runs as the implementer did. Through `workflow_start` a `fanout` template synthesizes when it
has two or more agents; `clawo fanout` synthesizes only with `--synthesize`.
`clawo goal` also takes `--effort`, `--sandbox`, `--thread`, `--goal-timeout`,
`--check-timeout` and `--objective-file`.

These are ordinary specs, not privileged paths. UltraApp's builds run one more
built-in, `ultraapp` (`synth` → `build`, a verifier → `deploy`, when there is
somewhere to deploy to), which only UltraApp starts.

## Goal

A `goal` node runs one goal on one thread: a Claude Code session
(`"engine": "claude"`, see [On Claude Code](#on-claude-code)), a Codex
`codex-app` thread (`"engine": "codex"`), or a conversation on `agy`, `grok`, `cursor`,
`opencode` or `acp`, where clawo runs the loop turn by turn (see
[On other engines](#on-other-engines)). A goal with no engine takes the
configured default engine when the run starts (Claude Code out of the box), and
a default no goal runs on (`acp`, which needs a preset, or `custom`) is refused then, as is a goal that names an engine no goal runs on. Codex's app-server runs the goal itself:
`thread/goal/set` starts its turn loop, which keeps going until the goal is
`complete`, out of budget, `blocked`, or stopped by a usage limit. The node adds
what an unattended run needs around that loop.

```jsonc
{
  "id": "goal",
  "kind": "goal",
  "objective": "Reach the goal described in GOAL.md …",
  "engine": "codex", // or "claude"; omitted, the configured default
  "cwd": "/work/task/ws",
  "model": "gpt-6.1-sol", // optional; codex's own default otherwise
  "effort": "high", // optional reasoning effort
  "sandboxMode": "workspace-write", // default; or "read-only" / "danger-full-access"
  "launcher": ["/work/goal/sandbox/sandbox.sh", "task", "0 1"], // optional argv prefix
  "threadId": "019c…", // optional: start on this existing thread, replacing its goal
  "tokenBudget": 50000000, // optional; the goal ends as budgetLimited past it
  "capacityRetry": { "max": 20, "backoffMs": 60000 }, // default
  "stallMs": 300000, // default 5 min
  "timeoutMs": 86400000, // optional wall-clock budget; no default
}
```

- **The objective fits Codex's limit.** Codex accepts at most 4,000 characters;
  a longer objective fails the node before a session opens (and `clawo goal`
  refuses it before starting a run). Put a long brief in a file in the working
  directory and name the file in the objective.
- **The thread is checkpointed.** Node data holds `threadId`, the `objective`
  currently set, `status`, `tokensUsed`, `timeUsedSeconds`, `resumes`,
  `lastError`, the agent's last reply (`lastMessage`, at most 4,000 characters)
  and the thread's spend (`costUsd`), updated as the goal moves (progress at most
  every 10 s, status changes at once). `workflow_status` and `clawo workflow show`
  read it while the goal runs. The spend is added to the run's `costUsd`.
- **Resume reattaches, it does not restart.** A resumed run hands the stored
  thread id to `thread/resume`; a goal that had not finished continues where it
  was. If the resume lands on a different thread the node fails rather than
  starting the objective over. An app-server that exits mid-goal is reopened on
  the same thread the same way. A goal that had already ended (`complete`,
  `budgetLimited`, `blocked`) when the process died ends the node with that
  result on resume; it is not set again.
- **Stalls are resumed within a bound.** A goal that is `usageLimited` or
  `paused`, or `active` with no turn running and either no news for `stallMs` or
  a capacity error the server will not retry (`serverOverloaded`,
  `usageLimitExceeded`, `rateLimitExceeded`, `internalServerError`,
  `responseTooManyFailedAttempts`, or a failed or dropped connection), is set back
  to `active` after a backoff that starts at `capacityRetry.backoffMs` and doubles
  to at most 15 min. Every attempt counts before it is made, reopening a dead
  app-server included; past `capacityRetry.max` the node fails. The count is part
  of the checkpoint, so it carries across process restarts and repair visits.
- **A Claude Code goal under a rotation of accounts moves on instead of waiting.** With `claudeAccount`
  (`auto`, or an account in the accounts file's `rotation`), a turn the account refuses for its usage moves
  the session to the next available account, continuing the same conversation, and the goal resumes at once
  without spending an attempt (`accountSwitches` in the node's data). Only when no other account is
  available does it wait as above. See [multi-engine.md](./multi-engine.md#claude-accounts-and-rotation).
  Codex also marks a goal `blocked` when its turn fails on one of those capacity
  errors (a model at capacity ends the turn with `serverOverloaded`); that goal is
  resumed the same way, on the same thread. A goal `blocked` for any other reason
  ends the node. The error is read from the turn itself as well as from `error`
  notifications, so `lastError` names the cause either way.
- **Repair on the same thread.** Revisited after a red verifier — a red verdict
  other than the one in force when its current objective was set — the node clears
  the finished goal and sets a new objective on the same thread, carrying the
  failing checks (as diagnostic data, like an agent node's repair brief) with the
  original objective. The agent keeps its context. On Codex the checks come first,
  as the definition of done. On Claude they are sent as a message of their own
  just before the goal, which is set to the original objective word for word (see
  below). On Codex the original objective is always kept whole; when the rest does
  not fit in 4,000 characters the checks are cut (the full output stays in the
  run's evidence). A
  first goal that was never set left nothing on its thread, so its revisit starts
  a new one.
- **A fresh thread is told why.** Any goal objective set while the run carries a
  red verdict the node has not seen gets the failing checks: a revisit whose
  thread was never set, and a different goal node that takes over after a red
  verdict on its own first visit.
- **Steering is live.** `workflow_steer` text goes into the running turn through
  `turn/steer`; with no turn running it waits for the next one. Text queued
  before the goal is set is put in front of the objective. On a run with a
  forum the steer also arrives as the user's post, pushed to the goal; it is
  handed over once, and a post pushed to the goal is recorded as delivered
  only once it is in a turn. A steer the goal took and could not hand over
  before it ended goes back to the run's queue, for the next node. On Codex
  the forum brief in front of the objective is the short one (at most five
  posts a section, no listing of every title), to leave room in the
  4,000-character objective; a steer that the objective's cut leaves out is
  steered into the running turn instead, or goes back to the run's queue.
- **A finished goal takes news.** A revisit of a goal that ended, with no new red
  verdict, normally returns its result without starting it again. When something
  reached it after it ended — a steer, or a forum post that names it and that it
  has not seen — the revisit sets the goal again on the same thread, with that in
  front of the objective. A fan-out goal agent whose run has finished is taken up
  again the same way when its fan-out node is revisited.
- **No approval prompts.** Nothing can answer one, so the thread runs with
  `approvalPolicy: "never"` and any request the server sends anyway (approval,
  user input) is answered with an error at once; the sandbox mode is the
  boundary.
- **Ends.** `complete` succeeds. `budgetLimited` and `blocked` fail with the
  reason. Cancel interrupts the running turn and pauses the goal, and so does a
  `timeoutMs` that runs out. Like `autoloop`, the node has no default timeout.

### On Claude Code

With `"engine": "claude"` the same node drives Claude Code's `/goal` (CLI
2.1.139 or later) through `ClaudeGoalSession`. Claude Code has no goal RPCs or
goal notifications, so the adapter reads the goal from what the CLI does in
stream-json mode:

- `/goal <objective>` sets the goal and starts working. A Stop hook — a separate
  model judging the condition against the session — runs after every turn and
  feeds the turn back while the condition does not hold, all inside one send;
  one `result` arrives when the goal is met, and the goal clears itself.
- A bare `/goal` answers at once, without a model turn — `Goal active: …` or
  `No goal set.` A failed turn clears the goal too, so a gone goal is not proof:
  the goal is `complete` only when a turn that started with it set ended without
  an error and it is gone after. A goal still set with nothing driving it, a
  failed turn, and a reopened session whose goal is gone are `paused`, which the
  node resumes within its bound. Resuming sends a short "continue" message when
  the goal is still set and sets it again (`/goal <objective>`) when it is not,
  so a goal that was already met costs one turn to confirm.
- A failed turn is read from its text: usage limits become `usageLimited`,
  overloaded and 5xx errors the matching transient codes, so the node backs off
  and resumes as it does for Codex. A failed login is `blocked` at once.
- When the Stop hook blocks the agent's stop nine times running, the CLI ends
  the turn anyway and says so; the goal is then `blocked` (the agent keeps
  asking to stop, and continuing only repeats that). The template's verifier
  still judges the tree. Write the objective as a condition the agent can show
  it met from inside the session; one that depends on something after the
  agent stops can never be met. Everything after `/goal` is that condition, so a
  repair never adds to it: steers and the failing checks are sent first as an
  ordinary message (the agent replies with one word), and `/goal` carries the
  objective alone. The checks run after the agent stops, where the judge could
  never see them pass.
- The session id is the thread id. A new session is started with
  `--session-id` so it is known before the goal is set, and the session is kept
  out of the registry with `skipPersistence` (not `noSessionPersistence`, which
  would stop the CLI writing the transcript `--resume` needs). A reopened
  process resumes it with `--resume`; the goal is still set there, so the node
  continues it at once.
- Steers are written into the running turn, which the CLI folds in. Cancel and
  pause send stream-json's `interrupt` control request; the goal stays set.
- `tokensUsed` counts the session's input, output and cache-write tokens, and is
  carried across reopened processes. Cache reads are not counted: every turn
  re-reads the whole cached conversation, which would spend a budget on re-reading. `tokenBudget` counts from when the current
  objective was set; past it the turn is interrupted and the goal ends
  `budgetLimited`. `sandboxMode` does not apply; put the boundary in `launcher`.

### On other engines

Antigravity (`agy`), Grok Build (`grok`), Cursor (`cursor`), OpenCode (`opencode`) and ACP agents
(`acp`, with `acpAgent` naming the preset) have no goal loop of their own: each
send is one turn, and the turn ends when the model stops. On them the node's
session goes through `TurnGoalSession`, which runs the loop itself on one
conversation:

- The first turn is the objective followed by a short protocol: when the
  objective is achieved the agent ends its reply with the line `GOAL COMPLETE`,
  and when it cannot go on without outside help, `GOAL BLOCKED: <reason>`. A
  turn that ends with neither is followed by a continuation turn on the same
  conversation. Only the last line of a reply counts.
- `complete` and `blocked` are what the agent declared, as on Codex; the
  verifier still judges the tree. A repair sends the failing checks in front of
  the objective and tells the agent the checks run again after it stops.
- `budgetLimited` once the turns have spent `tokenBudget` (input and output
  tokens; cache reads are not counted). A turn refused at a usage or rate limit,
  or for an exhausted quota, is `usageLimited`; any other failed turn — a
  timeout, a network error, a crashed CLI — is `paused`. The node resumes both
  within `capacityRetry`, on the same conversation. A failed login is
  `blocked`. So is an agent that ends 30 turns in a row without declaring
  anything. One turn may run 3 hours; one that runs longer is a failed turn.
- The conversation id is the thread id: the engine's own (agy's conversation,
  grok's and opencode's session, the ACP agent's session). A new conversation
  has one only after its first turn, and the node checkpoints it then; a repair
  visit and a reattach after a crash resume it. A resumed conversation that
  comes back under another id ends the goal `blocked` rather than starting over.
- Steers reach the turn in flight where the engine takes input mid-turn, and
  otherwise open the next turn. A turn in flight cannot be cut short: a pause
  or a spent budget takes effect when it ends, and cancel stops the session.
- `sandboxMode`, `model`, `effort` and `launcher` apply as for a session on that
  engine; `disallowedTools` is refused at start except on `grok`.

The same holds for a fan-out agent with an `objective`, which runs as a child
run of one goal node: a team of goals can mix engines.

The `goal` template wraps this in `goal → verify → repair-gate`. The goal node
continues on failure, so a goal that ran out of budget is still judged. The
verifier's node timeout is sized from the contract — the sum of every check's
timeout (its default when unset), times one plus `fixOnFailureRounds`, plus five
minutes, and never under 30 min — so a judge that takes hours is not cut off at
the 30-minute node default. `maxRepairs` defaults to 1, and `maxNodeVisits` is
`maxRepairs + 3`.

```bash
clawo goal "Make the failing tests in tests/ pass; the brief is in GOAL.md" \
  -c "npm test" --check-timeout 20 --token-budget 50000000 --max-repairs 2 --wait
```

## The verifier is a terminal barrier

A passing verdict only stands while it still describes the tree.

This cannot be enforced by inspecting the spec — a router can send control
anywhere, so which node runs last is not a property of the graph. And "nothing
may follow the verifier" would be the wrong rule anyway: what matters is not that
a node ran, but that the tree moved. So the kernel measures. Each evidence bundle
records a content digest of the working tree (HEAD, the full `git diff HEAD`,
and the path and bytes of every untracked file), and when the run ends, if any
workspace-touching node ran after the verdict, the digest is recomputed in the
directory the checks ran in. Every kind except `verifier`, `router` and
`human_gate` counts as workspace-touching.

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
failed | cancelled`. `verifying` is the state while a verifier node runs; the run
returns to `running` when it finishes, and ends in one of the last three.

`RunOutcome` is `verified | unverified | refuted` and answers a different
question: not "did it stop" but "did anything check it". The outcome is the last
verdict the run produced — each verifier visit replaces it, so a repair loop is
judged by its last check — and a `refuted` run ends `failed`, never `completed`.
A run with no contract completes as `unverified` — it says it does not know,
which is not the same as success.

The implicit `__verify` is the last node, and a run only ends `completed` after
its last node has run, so every such path is checked. A spec that places its own
`"contract": "run"` verifier gets no `__verify`, and must route every path through
that node: a run whose path skips it ends `failed` / `unverified`, with no check
run (see below).

A run whose spec declares a run-level `contract` cannot complete without having
run it. The kernel appends a terminal verifier unless the spec places its own
`contract: "run"` verifier, but a router can still send control past that
verifier; a run that ends with no verdict from a `contract: "run"` verifier ends
`failed`, with outcome `unverified` (nothing ran, so nothing was refuted). A
pass from a verifier with an inline contract does not stand in for the declared
one: when the declared contract's last verdict failed, the run ends `refuted`
whatever a later verifier says (`runContractVerdict` on the run record).

## The run forum

Every run has a forum: a board of titled posts, after the forum in _Test-Time Compute Scales Better
with Parallel Agent Teams_ (arXiv 2611.09798). It carries every message between the run's
participants — its agents, the orchestrator and the user — and it is the run's record of them.
Each mode decides who is on it, who sees what and when, and what it posts. Decisions never come
from it: council votes, verifier verdicts, gate approvals, autoloop controls and acceptance, and
router conditions are read from an agent's own reply or from the kernel. A post may mirror any of
them, and nothing reads one back, because agents can write the forum.

### Log and exposure

The forum of a run exists whether or not its agents are told about it; the runtime posts its
messages there either way (the list below). `forum` decides whether the agents are on it: briefed,
able to run `clawo forum`, and pushed what is addressed to them. It is `true`, `false`, or a config:

```json
{
  "forum": {
    "push": "mentions",
    "digestMs": 60000,
    "score": { "file": "tools/check-last.json", "pick": ["ok", "failures"] }
  }
}
```

On by default: `council_start` and the `council` template (off, with a warning, when a seat name
cannot be a forum name), `autoloop_start`, `ultraplan_start`, `ultrareview_start`. Off by default,
on with `forum`: `fanout_start` (`clawo fanout --forum`), `workflow_start` with any template, a
spec's top-level `forum`.

### Who is on it

| Member                                 | Name                                                                  |
| -------------------------------------- | --------------------------------------------------------------------- |
| An `agent` or `goal` node              | its `forumName`, else its id                                          |
| A fan-out agent                        | its `name`; a fan-out goal agent's child run carries the forum and it |
| A fan-out's synthesis pass (read-only) | `synthesis`, or `<node>.synthesis` with more than one                 |
| A verifier's fixer                     | `<verifier>.fix` (`verify.fix` for the implicit verifier)             |
| A council seat, for its round          | its name                                                              |
| An autoloop role                       | `planner`, `coder`, `reviewer`, or `<node>.<role>` beside another one |
| An ultraplan planner                   | `planner`                                                             |
| An ultrareview reviewer                | its angle's name; write-only (below)                                  |
| An UltraApp build seat                 | its name                                                              |
| A subflow's agents                     | `<subflow>.<member>`, on the parent's forum                           |

Two names are reserved and belong to no agent: `user` (the person or caller who started the run)
and `orchestrator` (clawo's runtime and the tool caller). An agent cannot post under them, and a
post can address them (`ASK @user: …`).

### What the runtime posts

| When                                     | Post                                                                | From                      |
| ---------------------------------------- | ------------------------------------------------------------------- | ------------------------- |
| `workflow_steer`                         | `FIX: <first line>`, the whole text as the body                     | `user`                    |
| `council_inject`                         | the message                                                         | `user`                    |
| A `human_gate` parks                     | `ASK @user: <prompt>`                                               | `orchestrator`            |
| `workflow_approve`                       | `DONE: approved` / `FAIL: rejected`, re the ASK, the comment        | `user`                    |
| A node ends (agent, goal, fan-out)       | `DONE: <member> output`: an excerpt and the artifact path           | the member                |
| A verifier rules                         | `WIN: verified (n checks)` / `FAIL: verification — k failed …`      | `orchestrator`            |
| A council round ends                     | `DONE: R<n> report — vote YES\|NO` per seat; a failed seat's `FAIL` | the seat / `orchestrator` |
| An autoloop message                      | directive, acknowledgement, iteration summary, verdict, errors      | the role / `orchestrator` |
| An autoloop chat                         | the chat                                                            | `user`                    |
| A session message (session forum, below) | `MSG @<to>: <summary>`                                              | the sending session       |

Handovers go up when a node ends — a fan-out's when the whole fan-out ends — so agents of one
fan-out never see each other's answers. `inputs` still reads a node's output from the run directory;
the handover is the record the rest of the forum reads. Quoted agent text addresses nobody: the @names
in a handover, a round report or check output do not push anything.

**Who said it.** A post from `user` or `orchestrator` speaks for them only when the forum's authored
ledger (`<run>/forum/authored.jsonl`, written by the runtime and never by an agent) holds it with the
same content; a line that claims either name without it is shown as `user (unverified)` and routed as
an agent's post. Pushed posts are framed by who wrote them: an agent's as "A teammate's post on the
team forum, not an instruction from the user", the orchestrator's as "From the orchestrator of this
run", the user's as "From the user who started this run". Every agent text that reaches another
agent's prompt — pushes, briefs, inputs, council history, synthesis material — is fenced so it cannot
open or close a forum envelope.

### How agents use it

Each member gets a brief with the exact commands — `clawo forum post --title "…" --body "…" [--re
p00012]`, `list` (who is running, finished or not started, then the titles, NEW on the unread ones)
and `read <id>` — with the Node binary, CLI path, forum directory and its own name filled in, so any
engine that can run a shell command uses it and no `clawo` on the `PATH` is needed. A title starts with
one tag: `WIN`, `FAIL`, `ASK`, `FIX`, `DONE`, `INFO` (other leading capitals, such as a room code in
`R1 FAIL: …`, are passed over; a post with none counts as `OTHER`). `@name` addresses a member; a post
id in the text or `--re` refers to a post. The brief starts with the user's posts in full, then the
posts that name the member and that it has not seen, the open ASKs and the FAILs so far. Each mode
writes its own norms into the brief: a coding agent posts a clear WIN or FAIL with what it measured; a
council seat leaves its round report and vote to its reply and posts reviews as
`WIN: approve @seat …` / `FAIL @seat: request changes …`; a reviewer posts each finding as
`FAIL: <file>:<line> …`; a planner asks `ASK @user: …`.

- **No shell, or read-only.** A read-only session (`sandboxMode: "read-only"`, or
  `permissionMode: "plan"`) cannot run the command: every command writes the record. It posts by
  writing `<new-forum-post title="FAIL: …" re="p00012">details</new-forum-post>` in its reply, which the
  orchestrator posts under its name as soon as the block is complete (`via: "reply"`); its brief carries
  the forum as it stands, and pushes hand it whole posts. Any agent may post this way, so an ACP agent
  or a custom CLI with no shell takes part too.
- **Write-only members.** Ultrareview reviewers and the autoloop Reviewer post and see nothing of their
  teammates — no listing, no pushes of agent posts — so each works independently. They still get what
  the user or the orchestrator addresses to them.
- **What a poster is told.** `post` adds a note when the post has no tag, or when a name it addresses
  is not on the forum, has not started (the post will be in its brief) or has finished — and, when its
  node is on no loop of the workflow, that nobody will answer as it.

### What reaches an agent without reading

`push: "mentions"` (default): an ASK or FAIL that names it. `"all"`: every post by someone else.
`"digest"`: those mentions at once, and the titles of the rest every `digestMs` (default 60 s).
`"none"`: nothing; agents read for themselves, as in the paper. Whatever the setting, a post from the
user or the orchestrator reaches the members it names, or every member when it names none, and a post
addressed to a member explicitly reaches it.

A push reaches the turn in flight: a Claude Code or `codex-app` session at its next tool round, a goal
through its steers. Every other engine — one process per turn (Codex, Antigravity, Grok, Cursor,
OpenCode), an ACP agent, a custom CLI — gets the same posts, in full and once, at the top of its next
`clawo forum` command; the hub then does not push them again. Autoloop roles and council seats also
get what was addressed to them with their next turn's prompt. A post counts as delivered only once it
is in a turn.

**Steers.** A steer is the user's post, so every running member that can take it mid-turn has it at
once. The kernel's queue keeps its own rule and its restart accounting: the next agent or goal node to
start takes the unconsumed steers, a council's next round and a running autoloop's roles take them, and
a node that took steers it could not hand over gives them back for the next one.

### Visibility and direct messages

A post can be addressed to its recipients only (`visibility: "to"`): nobody else sees it in a listing,
a read, a brief or an inbox. Plain sessions use this: each server process has one forum with no run,
`fm-sessions-<pid>-<start>`, made by the first `session_send_to`, whose members are its plain sessions.
A message is a post addressed to its recipient, delivered as before — an idle session gets a new turn,
a busy Claude Code or `codex-app` session gets it mid-turn, any other waits unread for
`session_deliver_inbox` — in the `<cross-session-message>` envelope, which says how to answer: a
`<new-forum-post re="p…">` block in the reply goes back to the sender as a message. Sessions a run
started belong to that run: broadcasts and `team_list` leave them out, `session_send_to` refuses them
(post to the run's forum instead), and Claude Code sessions a mode started refuse native peer messages
unless the mode says otherwise.

### Where it lives

The agents' CLI reads and writes a spool in the temp directory (`<tmp>/clawo-forum/<runId>/`, mode
0700, files 0600; `<tmp>/clawo-forum-<uid>/` when the shared root is not this user's), the one place
outside its workspace every engine's sandbox lets a session write. The runtime's own posts are in
`<run>/forum/` before the call that made them returns; agents' posts are copied there within a second while the
forum has members. When a run ends its spool is copied in and removed; a resume or a later post puts it
back from the store. Spools of finished or deleted runs, and session forums untouched for a week, are
removed when a server starts. Session forums are stored under `~/.claw-orchestrator/forums/<id>/`. Deleting a run
removes its spool, so a run that reuses the id starts on an empty forum. A post or a join waits at most a second
for the forum's lock: a lock no live process holds is broken, and one a live process keeps holding makes the call
fail with `The forum is busy`.

**Score.** With `score.file` (relative to the directory the posting agent works in — its node's `cwd`)
or `score.command` (an argv run there, 30 s bound by default), each agent post carries the agent's
current score, parsed as JSON when it is JSON; `score.pick` keeps only the named fields
(`"ok"`, `"summary.passed"`). A post keeps at most 2,000 characters of score; `read` shows one line of
at most 300, `list` and a push show 60.

### Reading it from outside

- `workflow_forum` — `list`, `read`, `metrics` on any run or session forum (`fm-…`), and `post` to a
  run (`author`: `orchestrator` by default, or `user`; `re`, `to`). A post returns its notes; a listed
  post carries its `authority`.
- `clawo forum show <id>` and `clawo forum metrics <id>`.
- The dashboard's Forum pane on the Runs, Council and Autoloop views: posts live, with who each speaks
  for, and a box to post as the user. `/workflow/<id>/events` sends each new post as `forum_post`
  (`/autoloop/<id>/events` too).

**Metrics** count the agents' own posts (by agent and tag), their reads and lists, every ASK with the
post that answered it and how long that took, the open ASKs, and for every post that names an agent
when it first had it — pushed, in a digest, in its brief, at the top of its next forum command, with a
turn, or read — and how long after the post. A post the named agent never saw but a later agent did
carries `handedTo` and counts in `handedMentions`; `unseenMentions` counts the posts nobody saw. The
runtime's posts are counted apart, under `runtime` (by `via` and by author).

## Isolation and spend

**`isolation: "worktree"`** (top level of the spec; `clawo solve --isolate`, `clawo goal --isolate`,
`isolation` on `workflow_start` templates) runs the whole workflow in a git worktree of the repository's HEAD,
at `~/.claw-orchestrator/worktrees/<runId>`, on a new local branch `clawo/<runId>`. The caller's checkout is
never written: uncommitted changes there are not part of the run, and two runs on one repository do not edit
the same files. Every directory of the checkout the spec names — the run's, each node's and fan-out agent's,
each check's — is moved into the worktree when the run starts. Untracked dependency directories (`node_modules`
and `.venv` unless `{ "mode": "worktree", "link": [...] }` names others) are linked in from the checkout, so
the project's tools run without an install; when git would list a link, `/<name>` is added to the repository's
`.git/info/exclude`, which the checkout already ignores.

When the run ends — verified, refuted, failed or cancelled — what it left is committed to `clawo/<runId>`
(hooks skipped; the message names the outcome), and the worktree is removed. The branch is for you to merge,
inspect or delete; nothing is pushed. `isolation` on the run record names the branch, the base and the commit.
Resuming a finished run checks the branch out again and continues there. A directory not in a git repository
with a commit is refused at start.

**`maxBudgetUsd`** (top level; `--max-budget <usd>` on `solve`, `goal` and `fanout`) caps the whole run's
spend. Before each node the kernel compares what the run has spent with the cap and fails the run when it is
reached (a verifier still runs, to say what state the run left); each node's sessions get what is left as their
own cap, a fan-out's and council's agents too, and a goal stops, paused, once it has spent it.

## Control

| Action        | Tool               | HTTP                              | CLI                                     |
| ------------- | ------------------ | --------------------------------- | --------------------------------------- |
| Start         | `workflow_start`   | `POST /workflow/new`              | `clawo solve` / `fanout` / `goal`       |
| Poll          | `workflow_status`  | `GET /workflow/<id>/state`        | `clawo workflow show <id>`              |
| List          | `workflow_list`    | `GET /workflow/list`              | `clawo workflow list`                   |
| Resume        | `workflow_resume`  | `POST /workflow/<id>/resume`      | `clawo workflow resume <id>`            |
| Cancel        | `workflow_cancel`  | `POST /workflow/<id>/cancel`      | `clawo workflow cancel <id>`            |
| Steer         | `workflow_steer`   | `POST /workflow/<id>/steer`       | `clawo workflow steer <id> "<text>"`    |
| Forum         | `workflow_forum`   | —                                 | `clawo forum show` / `metrics <id>`     |
| Answer a gate | `workflow_approve` | `POST /workflow/<id>/approve`     | `clawo workflow approve <id> [reject]`  |
| Evidence      | —                  | `GET /workflow/<id>/evidence`     | `clawo verify <id>`                     |
| Live events   | —                  | `GET /workflow/<id>/events` (SSE) | `--wait` on `solve` / `fanout` / `goal` |

`POST /workflow/new` takes `{ spec, cwd?, runId?, contract? }`; the templates are
built by the tool and by the CLI, which posts the spec it built. `workflow_status`
returns the run's state, outcome, `outcomeReason`, verdict, current node, evidence
id, cost, error, node records and consensus votes, plus its last N events with
`events: N`; `GET /workflow/<id>/state` and `clawo workflow show <id> --json` return
the whole record. The event stream opens with a `snapshot` (the
run's `workflow_list` entry), then sends each kernel event as a `workflow-event`. `GET /workflow/list` and
`workflow_list` filter by `workflow` and `state`, newest first, 25 by default.

Cancel and steer reach a run only while it executes in this process. Answering a
gate does not need that: a run parked by a process that has since exited is
resumed with the answer attached. `POST /workflow/<id>/approve` takes
`{ approved: true | false, comment? }`; a body without a boolean `approved` gets 400. On the CLI, `reject`, `false` or `no`
as the last argument of `clawo workflow approve` rejects; anything else approves, and `--comment <text>` adds a comment.

A gate asks on the run's forum: the orchestrator posts `ASK @user: <first line of
the prompt>`, with the whole prompt as its body (once; a gate run again while its
question is open does not ask twice). The answer is posted there as the user's —
`DONE: approved` or `FAIL: rejected`, answering that ASK — with the comment as its
body, and a comment is queued as a steer as well, so the next agent hears it
whether or not the run's agents are on a forum. Only `workflow_approve` answers a
gate; nothing reads an answer from a post.

Steer text is posted on the run's forum as the user's (`FIX: <first line>`, the
whole text as its body): agents running on a run with a forum get it pushed at
once, framed as the user's. It is also queued: in a running `goal` node it goes
into the current turn (`turn/steer`); otherwise it is **prepended** to the next
agent or goal node's prompt — an instruction that arrives while the previous node
was running is a correction, and corrections belong before the task. A node whose
forum brief already shows the steer's post whole does not get it a second time.
A fan-out does not take steers; they wait for the node after it.

The runtime writes to every run's forum, whether or not its agents are told about
it: the steers, each agent and goal node's output when the node succeeds and each
fan-out answer and synthesis when the fan-out ends (`DONE: <agent> output`, the
excerpt `inputs` reads), the gate's question and answer, and the verifier's
verdict (`WIN: verified (<n> checks)`, or `FAIL: verification — <k> required
checks failed (<ids>)` with the failing checks). `workflow_forum` lists, reads and
measures it for any run. The verdict post is a mirror: the outcome comes from the
verifier node alone.

## Limits worth knowing

- A node timeout stops the kernel waiting and marks the node failed. The
  in-flight agent turn is owned by the session layer and finishes on its own
  schedule; the kernel does not pretend to kill it. The abandoned attempt keeps
  running, so agent nodes name their session per attempt
  (`<runId>-<nodeId>-a<n>`, unless `sessionName` pins one), and a verifier names
  its fixer sessions per visit and attempt (`<runId>-<nodeId>-v<visit>a<n>-fix-<round>`)
  — otherwise the dying attempt's teardown would stop the retry's session. A
  `goal` node is the exception: it watches its signal, so a timeout interrupts its
  turn. A node that writes to a fixed path outside the run directory can still race
  its own retry; scope such writes per attempt.

  Because such an attempt can still write, a run about to report `verified`
  waits briefly for outstanding attempts to settle, and reports `unverified`
  with the reason if any is still going. It will not hold the run open for one
  that never stops — it declines to vouch instead.

- Cancel and a node timeout are different things. A timeout is a node failure
  (it still gets its retries and still honours `onFailure`); cancelling ends the
  run.
- Nothing prunes run directories. Delete a run that is not executing yourself
  (`rm -rf ~/.claw-orchestrator/wf/<runId>`), or programmatically with
  `SessionManager.workflowDelete(runId)`, which claims the run first. No tool or
  CLI command deletes a workflow run; `POST /autoloop/<id>/delete` removes an
  autoloop's.

## Related

- [`verification.md`](./verification.md) — contracts, checks, evidence
- [`observability.md`](./observability.md) — how a run's verdict reaches the ledger
- [`council.md`](./council.md), [`autoloop.md`](./autoloop.md), [`ultraapp.md`](./ultraapp.md) — the modes that run on the kernel
