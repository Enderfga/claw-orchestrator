# Workflow kernel — durable runs

One executor for every orchestration mode: what is running, what happens when a
step fails, when to stop, and — the part none of the previous five state machines
had — how to come back after the process dies.

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
  schedule; the kernel does not pretend to kill it.
- Cancel and a node timeout are different things. A timeout is a node failure
  (it still gets its retries and still honours `onFailure`); cancelling ends the
  run.
- Nothing prunes run directories. Delete them yourself, or with
  `workflowDelete`.

## Related

- [`verification.md`](./verification.md) — contracts, checks, evidence
- [`observability.md`](./observability.md) — how a run's verdict reaches the ledger
- [`council.md`](./council.md), [`autoloop.md`](./autoloop.md), [`ultraapp.md`](./ultraapp.md) — the modes, and what changed for each
