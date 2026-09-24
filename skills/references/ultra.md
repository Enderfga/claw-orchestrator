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
if (status?.status === 'completed') {
  console.log(status.plan);
}
```

### Tools

| Tool               | Description                         |
| ------------------ | ----------------------------------- |
| `ultraplan_start`  | Start planning session (background) |
| `ultraplan_status` | Get status and plan text            |

### Configuration

| Parameter | Default               | Description                  |
| --------- | --------------------- | ---------------------------- |
| `model`   | `opus`                | Model to use for planning    |
| `cwd`     | `process.cwd()`       | Project directory to explore |
| `timeout` | 1,800,000 ms (30 min) | Maximum planning time        |

Results are stored as a durable run and remain queryable after a restart.

---

## Ultrareview

A set of specialized reviewer agents that review your codebase in parallel, each from a different angle. Built on the fan-out primitive (see `fanout_start` in [tools.md](./tools.md)).

### How It Works

1. Starts a fan-out of N reviewer agents (1-20, default 5)
2. Each agent reviews from a different angle in the project directory, read-only on every engine (`sandboxMode: 'read-only'`, and plan mode on Claude), so no reviewer can change the code it is reviewing
3. Agents run in parallel; one failing reviewer does not stop the others
4. A read-only synthesis pass merges all findings into one report

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

// Poll for completion
const status = manager.ultrareviewStatus(review.id);
if (status?.status === 'completed') {
  console.log(status.findings);
}
```

### Tools

| Tool                 | Description                        |
| -------------------- | ---------------------------------- |
| `ultrareview_start`  | Launch reviewer fleet (background) |
| `ultrareview_status` | Get status and findings            |

### Configuration

| Parameter            | Default                   | Range | Description                                                                     |
| -------------------- | ------------------------- | ----- | ------------------------------------------------------------------------------- |
| `agentCount`         | 5                         | 1-20  | Number of reviewer agents                                                       |
| `maxDurationMinutes` | 10                        | 5-25  | Per-agent timeout                                                               |
| `model`              | session default           | —     | Model for all reviewers                                                         |
| `focus`              | bugs + security + quality | —     | Review focus description                                                        |
| `engines`            | `['claude']`              | —     | Engines assigned to reviewers round-robin. Not `grok`, which refuses a read-only session, or `custom` |

Reviewers run once each (up to 20 turns); there is no cross-review round. Results are stored as a durable run and remain queryable after a restart.
