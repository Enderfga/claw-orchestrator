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

### Consensus Voting

Every agent must include `[CONSENSUS: YES]` or `[CONSENSUS: NO]` at the end of each round's response. The council continues until:

- **All agents vote YES** — consensus reached
- **Max rounds reached** — timeout
- **Aborted** — user intervention

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

### Mixed Engines

Agents can use different engines and models:

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

| Tool             | Description                                                                             |
| ---------------- | --------------------------------------------------------------------------------------- |
| `council_start`  | Start a council. Runs in background, returns session ID immediately.                    |
| `council_status` | Get current status (running/consensus/max_rounds/error), responses, votes.              |
| `council_abort`  | Stop all agent sessions and terminate the council.                                      |
| `council_inject` | Inject a user message into all agents' prompts in the next round.                       |
| `council_review` | Review completed council output: changed files, branches, plan status, agent summaries. |
| `council_accept` | Accept work and clean up: remove worktrees, branches, plan.md, reviews/.                |
| `council_reject` | Reject work: rewrite plan.md with feedback for the council to retry.                    |

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

### 2. Accept

```json
{ "tool": "council_accept", "args": { "id": "<council-id>" } }
```

Cleans up all council scaffolding:

- Removes the worktrees under `{projectDir}/.worktrees/`, and that directory —
  selection is by containment, so a worktree of yours that merely has `council`
  somewhere in its path is never touched
- Deletes all `council/*` branches
- Removes `plan.md` and `reviews/` directory
- Sets council status to `accepted`

### 3. Reject

```json
{ "tool": "council_reject", "args": { "id": "<council-id>", "feedback": "..." } }
```

Rewrites `plan.md` with rejection feedback and commits it. All worktrees and branches are preserved so the council can be restarted to address the feedback.

## Configuration

| Parameter          | Default            | Description                        |
| ------------------ | ------------------ | ---------------------------------- |
| `maxRounds`        | 15                 | Maximum collaboration rounds       |
| `agentTimeoutMs`   | 1,800,000 (30 min) | Per-agent timeout per round        |
| `maxTurnsPerAgent` | 50                 | Max tool turns per agent per round |
| `maxBudgetUsd`     | —                  | API spend limit per agent          |

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

`councilStart`, `fanoutStart`, `ultraplanStart` and `ultrareviewStart` are
async (each creates a durable run before returning); direct TypeScript callers
need `await`.

## Durable runs

A council is a durable kernel run. `GET /council/list` (and the dashboard)
returns real records from disk, across processes.

`council_review` / `council_accept` / `council_reject` work after a restart:
they act on the git state the council left behind, not on live agents.
`council_inject` needs the live run and says so plainly when there is none.

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
