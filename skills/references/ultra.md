# Ultraplan & Ultrareview

High-level orchestration features for deep project planning and fleet code review. Inspired by Claude Code's Ultraplan and Ultrareview commands.

## Ultraplan

A dedicated planning session that explores your project thoroughly (up to 30 minutes) and produces a detailed implementation plan.

### How It Works

1. Starts an Opus session in **plan mode** with **max effort**
2. Appends a system prompt instructing thorough exploration and plan-only output
3. Sends the task description and waits for completion
4. Returns the plan text when done

Runs in background — poll with `ultraplan_status`.

### The planner's forum

The run has a forum by default (`forum: false` turns it off), and the planner is on it as `planner`.
The planner is read-only, so it posts by writing `<new-forum-post>` blocks in its reply. Its brief asks it to:

- post `ASK @user: <the question>` when something must be decided by the user, with the options and the
  one it recommends in the body, and go on with the parts the question does not hold up;
- post `DONE: plan` with a short summary when the plan is finished. The whole plan stays its final reply.

`ultraplan_status` lists the questions nobody has answered as `openAsks` (an author shown as
`user (unverified)` or `orchestrator (unverified)` wrote under that name without speaking for it). Answer one with
`workflow_forum` `post` on the run, as the user, referring to the ASK. The answer reaches a planner on
Claude or `codex-app` during its turn. Other engines take nothing mid-turn: a planner on one of them does
not see an answer, so settle its open questions when you read the plan. Forum blocks in the final reply are
shown as plain text (title in bold, then the body) in `plan`.

### Usage

```typescript
const plan = await manager.ultraplanStart('Add OAuth2 support with Google and GitHub providers', {
  cwd: '/path/to/project',
  model: 'opus', // default
  timeout: 1800000, // 30 min default
});

console.log(`Plan ID: ${plan.id}`);

// Poll for completion
const status = manager.ultraplanStatus(plan.id);
for (const ask of status?.openAsks ?? []) console.log(`${ask.id} ${ask.from}: ${ask.title}`);
if (status?.status === 'completed') {
  console.log(status.plan);
}
```

### Tools

| Tool               | Description                                  |
| ------------------ | -------------------------------------------- |
| `ultraplan_start`  | Start planning session (background)          |
| `ultraplan_status` | Get status, plan text and the open questions |

### Configuration

| Parameter | Default               | Description                                                        |
| --------- | --------------------- | ------------------------------------------------------------------ |
| `model`   | `opus`                | Model to use for planning                                          |
| `cwd`     | `process.cwd()`       | Project directory to explore                                       |
| `timeout` | 1,800,000 ms (30 min) | Maximum planning time                                              |
| `forum`   | on (`{}`)             | The run's forum; `false` turns it off, an object is a forum config |

`sessionName` in the result is the planner's session: `<id>-main-v<visit>a<attempt>`. It is stopped
when the turn ends. Results are stored as a durable run and remain queryable after a restart.

---

## Ultrareview

A set of specialized reviewer agents that review your codebase in parallel, each from a different angle. Built on the fan-out primitive (see `fanout_start` in [tools.md](./tools.md)).

### How It Works

1. Starts a fan-out of N reviewer agents (1-20, default 5)
2. Each agent reviews from a different angle in the project directory, read-only on every engine (`sandboxMode: 'read-only'`, and plan mode on Claude), so no reviewer can change the code it is reviewing
3. Agents run in parallel; one failing reviewer does not stop the others
4. A read-only synthesis pass merges all findings into one report

### The reviewers' forum

The run has a forum by default (`forum: false` turns it off). Each reviewer is on it under its angle's name
(`SecurityReviewer`, …) and posts every finding as it finds it, as a block in its reply:
`FAIL: <file>:<line> <the problem in one line>` with the evidence in the body, then one `DONE: <n> findings`.

Reviewers post and do not read. A reviewer's brief lists no posts, and no other reviewer's post is pushed to
it, so the reviews stay independent: a finding one reviewer made early cannot steer another. The brief comes
after the reviewer's persona and task, so the persona is the first line it reads. A post from the user or the
orchestrator to the run (`workflow_forum` `post`) still reaches the reviewers on engines that take input
mid-turn (Claude, `codex-app`).

`ultrareview_status` reports the forum while the review runs and after it: `forum.posts` (how many),
`forum.failTitles` (the reviewers' FAIL titles so far, `<reviewer>: <title>`, at most 200) and
`forum.openAsks`. `findings`, once the review has completed, is the synthesis, or the reviewers' outputs
joined when there is none, with forum blocks shown as plain text (title in bold, then the body).

### Available Review Angles (20)

| Agent               | Focus                                                    |
| ------------------- | -------------------------------------------------------- |
| SecurityReviewer    | Injection, auth flaws, data exposure, OWASP top 10       |
| LogicReviewer       | Off-by-one, race conditions, null handling, edge cases   |
| PerformanceReviewer | O(n^2) loops, memory leaks, missing caching, N+1 queries |
| APIReviewer         | Inconsistent interfaces, missing validation, error gaps  |
| TestReviewer        | Untested paths, missing edge case tests, flaky patterns  |
| TypeReviewer        | `any` casts, unsafe assertions, missing null checks      |
| ConcurrencyReviewer | Race conditions, deadlocks, async error handling         |
| ErrorReviewer       | Swallowed errors, missing try/catch, crash paths         |
| DependencyReviewer  | Outdated packages, CVEs, unnecessary deps                |
| ReadabilityReviewer | Unclear naming, complex functions, dead code             |
| DataReviewer        | Data validation, schema mismatches, encoding             |
| ConfigReviewer      | Hardcoded values, missing env vars, insecure defaults    |
| ScalabilityReviewer | Single points of failure, unbounded growth               |
| DocReviewer         | Outdated docs, missing API docs, misleading comments     |
| A11yReviewer        | ARIA labels, keyboard nav, color contrast                |
| I18nReviewer        | Hardcoded strings, locale handling, RTL support          |
| NetworkReviewer     | Missing timeouts, retry logic, connection pooling        |
| AuthReviewer        | Token handling, CSRF, permission checks                  |
| CryptoReviewer      | Weak algorithms, key management, RNG                     |
| MemoryReviewer      | Memory leaks, circular references, stream handling       |

### Usage

```typescript
const review = await manager.ultrareviewStart('/path/to/project', {
  agentCount: 10, // use 10 of the 20 angles
  maxDurationMinutes: 15, // 15 min timeout per agent
  model: 'sonnet', // model for all reviewers
  focus: 'Find security and performance bugs',
});

console.log(`Review ID: ${review.id}`);

// Poll for completion; the findings posted so far are on the forum
const status = manager.ultrareviewStatus(review.id);
console.log(status?.forum?.failTitles);
if (status?.status === 'completed') {
  console.log(status.findings);
}
```

### Tools

| Tool                 | Description                                           |
| -------------------- | ----------------------------------------------------- |
| `ultrareview_start`  | Launch reviewer fleet (background)                    |
| `ultrareview_status` | Get status, findings, and the forum's findings so far |

### Configuration

| Parameter            | Default                   | Range | Description                                                                                          |
| -------------------- | ------------------------- | ----- | ---------------------------------------------------------------------------------------------------- |
| `agentCount`         | 5                         | 1-20  | Number of reviewer agents                                                                            |
| `maxDurationMinutes` | 10                        | 5-25  | Per-agent timeout                                                                                    |
| `model`              | session default           | —     | Model for all reviewers                                                                              |
| `focus`              | bugs + security + quality | —     | Review focus description                                                                             |
| `engines`            | `['claude']`              | —     | Engines assigned to reviewers round-robin. Not `custom` or `acp`: neither can be held read-only here |
| `forum`              | on (`{}`)                 | —     | The reviewers' forum; `false` turns it off, an object is a forum config                              |

Reviewers run once each (up to 20 turns) and never see each other's findings; there is no cross-review round.
Results are stored as a durable run and remain queryable after a restart.
