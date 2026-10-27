# Council

The council system orchestrates multiple AI agents working in parallel on the same codebase, using git worktree isolation, round-based execution, and consensus voting.

Ported from [three-minds](https://github.com/Enderfga/three-minds) and adapted to run directly through `SessionManager` + `ISession`.

## How It Works

```
┌──────────────────────────────────────────────┐
│                  Council                      │
│                                              │
│  Round 1 (Planning):                         │
│    Agent 1 ──┐                               │
│    Agent 2 ──┼── parallel ── plan.md         │
│    Agent 3 ──┘                               │
│                                              │
│  Round 2+ (Execution):                       │
│    Agent 1 ──┐                               │
│    Agent 2 ──┼── parallel ── code + tests    │
│    Agent 3 ──┘                               │
│                                              │
│  Vote: all YES? ─── yes ──→ Review           │
│         │                    │               │
│         no ──→ next round    ├─ Accept ──→ Cleanup & Done
│                              └─ Reject ──→ Rewrite plan.md
└──────────────────────────────────────────────┘
```

### Two-Phase Protocol

**Round 1 — Planning**: All agents create `plan.md` in parallel. No business code allowed. Each agent works in its own git worktree, merges plan to `main`.

**Rounds 2+ — Execution**: Agents claim tasks from `plan.md`, write code, run tests, merge to `main`, and review each other's work.

### Git Worktree Isolation

Each agent gets a physically isolated working directory:

```
project/
├── .worktrees/
│   ├── Architect/     ← council/Architect branch
│   ├── Engineer/      ← council/Engineer branch
│   └── Reviewer/      ← council/Reviewer branch
└── (main branch)
```

Agents cannot interfere with each other's files. All integration happens via `git merge` to `main`.

If `projectDir` does not exist it is created; if it is not a git repository the council runs `git init`, and if
the repository has no commit yet it commits whatever the directory holds. Commits need a git identity: when the
repository has none at any level, the council sets a local `Council <council@openclaw>` in `.git/config`; an
identity you configured is left untouched. Agent names become branch names, so they must match
`^[a-zA-Z0-9_-]+$`. A council refuses to start with a `projectDir` inside the orchestrator's own package
directory.

### Consensus Voting

Every agent must include `[CONSENSUS: YES]` or `[CONSENSUS: NO]` at the end of each round's response. The council continues until:

- **All agents vote YES** — consensus reached; status becomes `awaiting_user` (ready for review / accept / reject)
- **Max rounds reached** — status `max_rounds`
- **Aborted** — user intervention; status `error`

An agent that fails or errors in a round counts as a NO for that round. A loosely formatted vote (for example
`CONSENSUS=YES`) is still read, and a missing vote counts as NO.

## Quick Start

### Via Tool

```json
{
  "tool": "council_start",
  "args": {
    "task": "Build a REST API with authentication and rate limiting",
    "projectDir": "/tmp/my-api-project",
    "maxRounds": 10
  }
}
```

This starts a 3-agent council (Planner, Generator, Evaluator) with default settings.

### Via TypeScript

```typescript
import { SessionManager } from '@enderfga/claw-orchestrator';

const manager = new SessionManager();

const session = await manager.councilStart('Build a REST API with authentication', {
  agents: [
    {
      name: 'Planner',
      emoji: '🟠',
      persona: 'Technical planner focused on requirements decomposition and architecture',
    },
    { name: 'Generator', emoji: '🟢', persona: 'Implementation engineer focused on shipping correct code per plan' },
    { name: 'Evaluator', emoji: '🔵', persona: 'Independent quality gate focused on verification and acceptance' },
  ],
  maxRounds: 10,
  projectDir: '/tmp/my-api-project',
});

console.log(`Council started: ${session.id}`);
// Poll for status
const status = manager.councilStatus(session.id);
```

`councilStart`, `fanoutStart`, `ultraplanStart` and `ultrareviewStart` are async (each creates a durable run before
returning); direct TypeScript callers need `await`.

### Mixed Engines

Agents can use different engines and models. Each agent also accepts `effort` and, on Claude, `ultracode`:

```json
{
  "agents": [
    { "name": "Claude", "emoji": "🎭", "engine": "claude", "model": "opus", "persona": "Deep reasoning" },
    { "name": "Codex", "emoji": "🧠", "engine": "codex", "model": "gpt-5.5", "persona": "Fast implementation" },
    { "name": "Antigravity", "emoji": "💎", "engine": "agy", "model": "agy-pro", "persona": "Creative solutions" }
  ]
}
```

## Council Tools

| Tool             | Description                                                                                                             |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `council_start`  | Start a council. Runs in background, returns session ID immediately.                                                    |
| `council_status` | Status (`running`, `awaiting_user`, `max_rounds`, `error`, `accepted`, `rejected`) and each response with its vote.     |
| `council_abort`  | Stop all agent sessions, terminate a council running in this process, and remove the worktrees it created.              |
| `council_inject` | Inject a user message into all agents' prompts in the next round. A second inject before that round replaces the first. |
| `council_review` | Review completed council output: changed files, branches, plan status, agent summaries.                                 |
| `council_accept` | Accept work and clean up: remove worktrees, branches, plan.md, reviews/.                                                |
| `council_reject` | Reject work: rewrite plan.md with feedback for the council to retry.                                                    |

## Post-Processing Lifecycle

After a council reaches consensus or hits max rounds, use the review/accept/reject tools to finalize the work.

### 1. Review

```json
{ "tool": "council_review", "args": { "id": "<council-id>" } }
```

Returns a structured report:

- **changedFiles**: all files modified by the council with insertion/deletion counts
- **branches**: remaining `council/*` branches
- **worktrees**: remaining council worktrees
- **planContent**: full plan.md text (check for unchecked tasks)
- **reviews**: review files in `reviews/` directory
- **agentSummaries**: final-round output preview from each agent
- **reviewerGuidance**: the checklist from `configs/council-reviewer-prompt.md`, for whoever reviews the output

### 2. Accept

```json
{ "tool": "council_accept", "args": { "id": "<council-id>" } }
```

Checks out `main` (or `master`), then cleans up all council scaffolding:

- Removes the worktrees under `{projectDir}/.worktrees/`, and that directory —
  selection is by containment, so a worktree of yours that merely has `council`
  somewhere in its path is never touched
- Deletes all `council/*` branches
- Removes `plan.md` and `reviews/` directory
- Sets council status to `accepted`, recorded on the run so `council_status` reports it

### 3. Reject

```json
{ "tool": "council_reject", "args": { "id": "<council-id>", "feedback": "..." } }
```

Rewrites `plan.md` with rejection feedback and commits it, and sets council status to `rejected`, recorded on the run. All worktrees and branches are preserved so the council can be restarted to address the feedback: a new `council_start` on the same `projectDir` with the same agent names reuses those worktrees (resetting each to its branch head, which discards uncommitted changes in them).

## Configuration

| Parameter          | Default            | Description                        |
| ------------------ | ------------------ | ---------------------------------- |
| `maxRounds`        | 15                 | Maximum collaboration rounds       |
| `agentTimeoutMs`   | 1,800,000 (30 min) | Per-agent timeout per round        |
| `maxTurnsPerAgent` | 50                 | Max tool turns per agent per round |
| `maxBudgetUsd`     | —                  | API spend limit per agent          |

These are the `council_start` defaults. The `council` workflow template (`workflow_start`) runs up to 8 rounds.

### defaultPermissionMode

Optional. Sets the default permission mode for council agents when individual agents don't specify one. Defaults to `bypassPermissions`.

```typescript
await manager.councilStart('task', {
  agents: [...],
  maxRounds: 10,
  projectDir: '/project',
  defaultPermissionMode: 'acceptEdits', // override the bypassPermissions default
});
```

Permission priority: agent-level `permissionMode` > `defaultPermissionMode` > `'bypassPermissions'`

## System Prompt

The council system prompt is loaded from `configs/council-system-prompt.md` and supports hot-editing. It has 9 charter sections:

| Section                           | Purpose                                        |
| --------------------------------- | ---------------------------------------------- |
| §0 Must Use Tools to Execute      | Agents must use tools, never fabricate results |
| §1 Blueprint First                | Two-phase protocol with plan.md                |
| §2 Parallel Coordination          | Claim/done protocol for concurrent work        |
| §3 Truth in Git                   | Git state over conversation memory             |
| §4 Integration Is Completion      | Local only, never push                         |
| §5 Cross-Review                   | Structured APPROVE/REQUEST_CHANGES             |
| §6 Autonomous Conflict Resolution | Never stop on merge conflicts                  |
| §7 Action Over Words              | Never ask permission, just work                |
| §8 Efficient Tool Use             | Minimum necessary principle                    |

Placeholders: `{{emoji}}`, `{{name}}`, `{{persona}}`, `{{workDir}}`, `{{projectDir}}`, `{{otherBranches}}`

The charter is each seat's only instruction channel, and it reaches every engine through `appendSystemPrompt`:
natively on Claude Code and Grok, as the top of the seat's first message on Codex, Antigravity and OpenCode.
Nothing is written into the worktrees.

## Member session names

Each council member starts an internal `SessionManager` session named
`{councilRunId}-{memberName}-r{round}` (for example
`council-m1abc2de-9f3c1a2b-Architect-r1`). The name carries the complete council
run id so two concurrent councils that share a member name and round do not
reuse one engine session, working directory, or cleanup target. `sessionKey` on
each agent response is that opaque name; callers should treat it as an opaque
handle, not parse it. `parentRunId` on ledger turns remains the full council run
id.

## Transcript Logging

All council sessions save transcripts to `~/.openclaw/council-logs/council-<timestamp>.md`. Transcripts are for humans to read; nothing parses them. Completed councils stay queryable via `council_status` indefinitely — the run record is on disk.

## Votes end the rounds; contracts decide the verdict

A council stops early when every agent votes YES, but the votes do not decide
whether the work is acceptable. They are recorded on the run as
`consensusVotes`, each with the parse `source` (`strict` / `variant` / `none`),
so a loosely detected vote is visible as such.

To have the result checked, give the run an acceptance contract and the runtime
runs the checks itself:

```jsonc
workflow_start({
  template: "council",
  task: "Fix the failing integration tests",
  agents: [{ name: "alice", engine: "claude" }, { name: "bob", engine: "codex" }],
  contract: { checks: [{ type: "command", cmd: "npm", args: ["test"] }] }
})
```

Without a contract the run completes `unverified` — nothing checked it.

## Durable runs

A council is a durable kernel run. `GET /council/list` (and the dashboard)
returns real records from disk, across processes.

| Route                      | Purpose                                                                                                                                                                |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /council/list`        | Every council run, newest first.                                                                                                                                       |
| `POST /council/new`        | Body `{ task, projectDir, maxRounds? }`. Starts the dashboard preset: three Claude agents, 15 rounds by default.                                                       |
| `GET /council/<id>/state`  | The council session (status, config, responses).                                                                                                                       |
| `GET /council/<id>/events` | SSE: a `snapshot`, then a `council-event` for each session, round and agent event (output chunks included). Only for a council running in this process; 404 otherwise. |

`council_review` / `council_accept` / `council_reject` work after a restart:
they act on the git state the council left behind, not on live agents, and the
accept / reject decision is written to the run record.
`council_inject` and `council_abort` need the live run and say so plainly when
there is none: `council_abort` then returns `ok: false` with the run's state and
leaves the run and its worktrees as they are.

## Changed-file reporting

`council_review` diffs against the **merge-base** of `HEAD` and the first
`council/*` branch — the point where the council's work started — and includes
files the agents created, which a tracked-file diff cannot see.

Each `CouncilChangedFile` carries `change` — git's own account (`added` /
`modified` / `deleted`). `status` is optional and stays undefined until a
reviewer assesses the file.

## Related

- [`verification.md`](./verification.md) — acceptance contracts
- [`workflow.md`](./workflow.md) — the council node inside a durable run
