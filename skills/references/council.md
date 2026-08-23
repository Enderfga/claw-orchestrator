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

const session = manager.councilStart('Build a REST API with authentication', {
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

- Removes all `council/*` worktrees and `.worktrees/` directory
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
| `maxTurnsPerAgent` | 30                 | Max tool turns per agent per round |
| `maxBudgetUsd`     | —                  | API spend limit per agent          |

### defaultPermissionMode

Optional. Sets the default permission mode for council agents when individual agents don't specify one. Defaults to `bypassPermissions`.

```typescript
manager.councilStart('task', {
  agents: [...],
  maxRounds: 10,
  projectDir: '/project',
  defaultPermissionMode: 'acceptEdits', // override the bypassPermissions default
});
```

Permission priority: agent-level `permissionMode` > `defaultPermissionMode` > `'bypassPermissions'`

> **Note (Claude CLI 2.1.121+):** When agent personas are persisted as Claude agent files with frontmatter, the `permissionMode`, `tools`, and `disallowedTools` fields are now **enforced** by `--agent` and `--print` modes (previously advisory). If you write agent files with restrictive `tools` lists, expect those agents to refuse calls to other tools at runtime.

## System Prompt

The council system prompt is loaded from `configs/council-system-prompt.md` and supports hot-editing. It includes 9 charter sections tuned through extensive multi-agent collaboration testing:

| Section                     | Purpose                                        |
| --------------------------- | ---------------------------------------------- |
| §0 No Hallucination         | Agents must use tools, never fabricate results |
| §1 Plan First               | Two-phase protocol with plan.md                |
| §2 Parallel Coordination    | Claim/done protocol for concurrent work        |
| §3 Truth in Git             | Git state over conversation memory             |
| §4 Merge to Main            | Local only, never push                         |
| §5 Cross-Review             | Structured APPROVE/REQUEST_CHANGES             |
| §6 Auto-Conflict Resolution | Never stop on merge conflicts                  |
| §7 Action Over Words        | Never ask permission, just work                |
| §8 Efficient Tool Use       | Minimum necessary principle                    |

Placeholders: `{{emoji}}`, `{{name}}`, `{{persona}}`, `{{workDir}}`, `{{otherBranches}}`

## Transcript Logging

All council sessions save transcripts to `~/.openclaw/council-logs/council-<timestamp>.md`. Completed councils remain queryable via `council_status` for 30 minutes after completion.

## Consensus is advisory (6.0.0)

Through 5.1.0 a council ended when `parseConsensus` found `[CONSENSUS: YES]` in
every agent's reply — that is, the termination condition was a regex over agent
prose. Two things made that weaker than it looked: the fallback patterns match a
bare `consensus: yes` anywhere in the text, and when a reply came back short and
unmarked the orchestrator re-prompted twice _asking for the token_, which is
demanding a vote rather than checking anything.

Votes are still collected and still recorded — they are what the agents were
asked for, and they are useful. They are recorded on the run as
`consensusVotes`, each with the parse `source` (`strict` / `variant` / `none`) so
a loosely-detected vote is visible as such.

What changed is that they no longer decide whether the work is acceptable. Give
the run an acceptance contract and the runtime checks the result itself:

```jsonc
workflow_start({
  template: "council",
  task: "Fix the failing integration tests",
  agents: [{ name: "alice", engine: "claude" }, { name: "bob", engine: "codex" }],
  contract: { checks: [{ type: "command", cmd: "npm", args: ["test"] }] }
})
```

Without a contract the council behaves exactly as before and the run completes
`unverified` — nothing checked it.

`council_start` and the rest of the `council_*` tools keep their signatures, with
one change forced by the cutover: **`councilStart` is now async** (it creates a
durable run before returning). The same applies to `fanoutStart`,
`ultraplanStart` and `ultrareviewStart`. Tool callers are unaffected; direct
TypeScript callers need an `await`.

## Lifecycle moved to the kernel

A council is a kernel run. `councils`, its 30-minute eviction timer, and
`listCouncilsFromDisk` — which read `~/.openclaw/council-logs/*.md` with a regex
and fabricated a stub session with no responses and an empty config — are gone.
`council_list` returns real records, from disk, across processes.

`council_review` / `accept` / `reject` work after a restart now. They act on the
git state a finished council left behind, not on live agents, so they run against
a `Council` rebuilt from the record. Only `council_inject` still needs the live
engine, and it says so plainly when there isn't one.

Transcripts are still written to `~/.openclaw/council-logs/` for humans. Nothing
parses them.

## Changed-file reporting

`council_review` used to diff `HEAD~20..HEAD` with a `HEAD~10` fallback: a magic
window unrelated to when the council started, which returned nothing at all on a
shallow or young history. It now diffs against the **merge-base** of `HEAD` and
the first `council/*` branch — the actual fork point — and includes files the
agents created, which a tracked-file diff cannot see.

`CouncilChangedFile.status` was previously hardcoded to `'clean'` for every
entry, which read as "reviewed and found fine" when nothing had looked at it. It
is now optional and left undefined until a reviewer assesses the file; the new
`change` field carries git's own account (`added` / `modified` / `deleted`).

## Related

- [`verification.md`](./verification.md) — acceptance contracts
- [`workflow.md`](./workflow.md) — the council node inside a durable run
