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

Steers survive a restart. They are logged when they arrive and recorded as
consumed when the node that took them finishes, so on resume every steer no
finished node consumed is queued again — including one a node was holding when
it died, which goes to that node's retry. A `goal` node delivers steers into
the running turn as they arrive, so one delivered before a crash is delivered
again after the resume.

**This makes node execution at-least-once, not exactly-once.** There is no
idempotency key and no side-effect commit marker, so a node that wrote files and
then died before its checkpoint runs again from the top. Workflows whose nodes
are not safe to repeat need to make them safe.

Resume is explicit — `workflow_resume` or `clawo workflow resume` — not automatic.
Resuming a run that already ended returns it unchanged. Custom-engine configs are
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
| `human_gate`                        | Parks the run until a person answers; a rejection fails the run                                                                                                                                                                                                     |
| `router`                            | Picks the next node from declarative conditions; a backwards route is the loop                                                                                                                                                                                      |
| `subflow`                           | Runs another workflow as a child run and adopts its verdict, with the tree digest the verdict was taken against; a child that ends `unverified` hands up no verdict                                                                                                 |
| `autoloop`                          | A long-lived Planner / Coder / Reviewer loop; its executor is injected. On the node's first visit (`visits === 1`) the shared fresh-start boundary applies (dirty-worktree refusal + run-local `tasks/<config.runId>/.gitignore`); resume and later visits skip it. |
| `goal`                              | A `/goal` on one Codex `codex-app` thread or Claude Code session, run until the goal finishes — see [below](#goal)                                                                                                                                                  |
| `ultraapp_synth`, `ultraapp_deploy` | UltraApp's synth and deploy stages; their executors are injected too                                                                                                                                                                                                |

### Spec and node fields

A `WorkflowSpec` is `{ name, nodes, cwd?, contract?, maxNodeVisits? }`. `cwd` is
the run's working directory (a start call's `cwd` overrides it), `contract` is the
run-level acceptance contract, and `maxNodeVisits` (default 50) bounds every loop.
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

| Kind                                | Fields                                                                                                                                                                                                                                                                                                       |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `agent`                             | `prompt` (required); `engine`, `model`, `effort`, `acpAgent` (a bundled ACP preset id, for `engine: "acp"`); `cwd` (default: the run's); `sessionName`, to reuse one named session across nodes; `permissionMode` (default `bypassPermissions`); `appendSystemPrompt`, standing instructions for the session |
| `fanout`                            | `prompt` (required, the shared task) and `agents` (required); `synthesize`, `synthesisEngine` (default `claude`), `synthesisModel`, `synthesisAcpAgent`, `synthesisPermissionMode` (default `bypassPermissions`); `maxTurnsPerAgent` and `maxBudgetUsd`, per agent; `cwd`; `agentTimeoutMs`                  |
| `council`                           | `task` (required) and `agents` (required); `projectDir` (default: the run's cwd); `maxRounds` (default 15, as for `council_start`); `maxTurnsPerAgent` and `maxBudgetUsd`, per agent; `defaultPermissionMode`; `agentTimeoutMs`                                                                              |
| `verifier`                          | `contract` (required): an inline contract, or `"run"` for the run-level one; `cwd` (default: the run's)                                                                                                                                                                                                      |
| `human_gate`                        | `prompt` (required)                                                                                                                                                                                                                                                                                          |
| `router`                            | `routes` (required): `[{ "when": <condition>, "to": <node id> }]`, first match wins; `default`, taken when nothing matches (omitted: fall through to the next node)                                                                                                                                          |
| `subflow`                           | `workflow` (required): an inline `WorkflowSpec`, or the id of an existing run, whose stored spec runs again as a new child run. Template names do not resolve here                                                                                                                                           |
| `goal`                              | `objective` (required); `engine`, `cwd`, `model`, `effort`, `sandboxMode`, `launcher`, `threadId`, `tokenBudget`, `capacityRetry`, `stallMs` — see [Goal](#goal)                                                                                                                                             |
| `autoloop`                          | `workspace` and `config` (the `autoloop_start` options). Started by `autoloop_start`                                                                                                                                                                                                                         |
| `ultraapp_synth`, `ultraapp_deploy` | `appRunId`, `runDir`, `slug`; the deploy stage adds `version` and `codebasePath`. Started by UltraApp builds                                                                                                                                                                                                 |

An entry in a fan-out's or council's `agents` takes `name` (required), `engine`,
`model`, `effort`, `acpAgent`, `persona`, `prompt`, `permissionMode` and `baseUrl`;
a fan-out agent also takes `sandboxMode`, and a council agent `ultracode` and
`emoji` (shown with its name in its charter and the transcript). An agent
node and each of these entries use `engine`, `model` and `effort` the same way;
`effort` accepts `low`, `medium`, `high`, `xhigh`, `max`, `ultra`, or `auto`, and
omitting any of them preserves the session default. `customEngine` is not a spec
field — a spec is written to disk and a custom-engine config can carry
credentials — so custom engines reach a run in memory, through `fanout_start` or
`council_start`, and are re-supplied on resume as described above.

A council agent's `persona` is its role; one with no `persona` uses its `prompt`
instead. Fan-out agents may also set `persona` for role instructions. When no non-empty
per-agent `prompt` exists, the executor sends the persona followed by a
`## Shared task` section containing the node's shared prompt. A non-empty
per-agent `prompt` remains a complete override and takes precedence over both
persona and the shared task. The spec stores `prompt` and `persona` separately,
so a resumed node reconstructs the same message.

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

A contract written inside a spec — the run-level `contract`, or a verifier's
inline one — is used as written, so each check goes in the `{ "spec": { … } }`
wrapper shown here, with `id` and `required` beside `spec`. The `contract` argument
of `workflow_start` and `POST /workflow/new` is normalized first and also accepts
bare checks (`{ "type": "command", … }`); when given, it replaces the spec's own.
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

| Template  | Nodes                                                                                                                                                                    | Arguments                                                                                                                                                                |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `solve`   | `triage` (fan-out) → `approve` (human gate, only with `humanGate`) → `implement` (agent) → `review` (fan-out, only with `reviewers`) → `verify` → `repair-gate` (router) | `agents` (the triage scouts; default one agent on the default engine), `implementer` (`engine`, `model`), `reviewers`, `humanGate`, `maxRepairs` (default 3), `contract` |
| `council` | `council`, then `__verify` when a contract is declared                                                                                                                   | `agents`, `maxRounds` (default 15), `contract`                                                                                                                           |
| `fanout`  | `fanout`, then `__verify` when a contract is declared                                                                                                                    | `agents`, `contract`                                                                                                                                                     |
| `goal`    | `goal` → `verify` → `repair-gate` (router); `task` is the objective. See [below](#goal)                                                                                  | `engine` (`codex` default, or `claude`), `model`, `tokenBudget`, `launcher`, `maxRepairs` (default 1), `contract`                                                        |

`solve` is the shape above: the triage and review fan-outs add a synthesis pass
when they have two or more agents, `implement` and `review` continue on failure so
the verifier always judges the tree, `verify` continues so a red result reaches
`repair-gate`, and `maxNodeVisits` is `maxRepairs + 3`. Through `workflow_start` a `fanout` template synthesizes when it
has two or more agents; `clawo fanout` synthesizes only with `--synthesize`.
`clawo goal` also takes `--effort`, `--sandbox`, `--thread`, `--goal-timeout`,
`--check-timeout` and `--objective-file`.

These are ordinary specs, not privileged paths. UltraApp's builds run one more
built-in, `ultraapp` (`synth` → `build`, a verifier → `deploy`, when there is
somewhere to deploy to), which only UltraApp starts.

## Goal

A `goal` node runs one `/goal` on one thread: a Codex `codex-app` thread by
default, or a Claude Code session with `"engine": "claude"` (see
[On Claude Code](#on-claude-code)). Codex's app-server runs the goal itself:
`thread/goal/set` starts its turn loop, which keeps going until the goal is
`complete`, out of budget, `blocked`, or stopped by a usage limit. The node adds
what an unattended run needs around that loop.

```jsonc
{
  "id": "goal",
  "kind": "goal",
  "objective": "Reach the goal described in GOAL.md …",
  "engine": "codex", // default; or "claude"
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
- **Repair on the same thread.** Revisited after a red verifier — a red verdict
  other than the one in force when its current objective was set — the node clears
  the finished goal and sets a new objective on the same thread: the failing
  checks first (as diagnostic data, like an agent node's repair brief), then the
  original objective. The agent keeps its context. The original objective is
  always kept whole; when both do not fit in 4,000 characters the checks are cut
  (the full output stays in the run's evidence). A first goal that was never set
  left nothing on its thread, so its revisit starts a new one.
- **Steering is live.** `workflow_steer` text goes into the running turn through
  `turn/steer`; with no turn running it waits for the next one. Text queued
  before the goal is set is put in front of the objective.
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
  agent stops can never be met.
- The session id is the thread id. A new session is started with
  `--session-id` so it is known before the goal is set, and the session is kept
  out of the registry with `skipPersistence` (not `noSessionPersistence`, which
  would stop the CLI writing the transcript `--resume` needs). A reopened
  process resumes it with `--resume`; the goal is still set there, so the node
  continues it at once.
- Steers are written into the running turn, which the CLI folds in. Cancel and
  pause send stream-json's `interrupt` control request; the goal stays set.
- `tokensUsed` counts the session's input, output and cache-read tokens, and is
  carried across reopened processes. `tokenBudget` counts from when the current
  objective was set; past it the turn is interrupted and the goal ends
  `budgetLimited`. `sandboxMode` does not apply; put the boundary in `launcher`.

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
that node: a run whose path skips it ends `completed` / `unverified`, with no
check run.

A run whose spec declares a run-level `contract` cannot complete without having
run it. The kernel appends a terminal verifier unless the spec places its own
`contract: "run"` verifier, but a router can still send control past that
verifier; a run that ends with no verdict from a `contract: "run"` verifier ends
`failed`, with outcome `unverified` (nothing ran, so nothing was refuted). A
pass from a verifier with an inline contract does not stand in for the declared
one.

## Control

| Action        | Tool               | HTTP                              | CLI                                     |
| ------------- | ------------------ | --------------------------------- | --------------------------------------- |
| Start         | `workflow_start`   | `POST /workflow/new`              | `clawo solve` / `fanout` / `goal`       |
| Poll          | `workflow_status`  | `GET /workflow/<id>/state`        | `clawo workflow show <id>`              |
| List          | `workflow_list`    | `GET /workflow/list`              | `clawo workflow list`                   |
| Resume        | `workflow_resume`  | `POST /workflow/<id>/resume`      | `clawo workflow resume <id>`            |
| Cancel        | `workflow_cancel`  | `POST /workflow/<id>/cancel`      | `clawo workflow cancel <id>`            |
| Steer         | `workflow_steer`   | `POST /workflow/<id>/steer`       | `clawo workflow steer <id> "<text>"`    |
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
resumed with the answer attached. On the CLI, `reject`, `false` or `no` as the
last argument of `clawo workflow approve` rejects; anything else approves.

In a running `goal` node, steer text goes into the current turn (`turn/steer`).
Otherwise, steer text is **prepended** to the next agent node's prompt: an instruction that
arrives while the previous node was running is a correction, and corrections
belong before the task.

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
