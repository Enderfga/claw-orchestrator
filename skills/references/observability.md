# Observability — Run Ledger & Spend Caps

Two related surfaces: a durable record of every turn this runtime executes, and a
spend cap that is enforced by the runtime rather than by whichever CLI happens to
support a budget flag.

## Purpose

`getStats()` / `getCost()` describe a **live** session and are held in memory.
The run ledger is the durable record of every turn across restarts: what ran, on
which engine, for how much. `maxBudgetUsd` is enforced in `SessionManager`, which
every engine passes through, not only through Claude Code's `--max-budget-usd`.

## The ledger

- Location: `~/.claw-orchestrator/runs/YYYY-MM-DD.jsonl` (override with
  `CLAWO_RUNS_DIR`).
- One JSON object per line, one line per completed turn — **successful or not**.
  The turns a Codex `/goal` runs on its own (a workflow `goal` node, or the
  `codex_goal_*` tools) are the exception: they do not pass through a send, so they
  write no rows, and a goal node's spend is reported on its run instead
  ([`workflow.md`](./workflow.md#goal)).
- Shards are one file per UTC day. Queries always filter on the row timestamp, so
  the shard boundary is a storage detail; `--since 24h` spans midnight correctly.
- Writes are best-effort: a ledger failure is logged at `warn` and swallowed. It
  can never break the turn it is describing.
- Nothing prunes old shards. A row is roughly 250 bytes; delete shards yourself if
  you want the history gone.

### Row schema

| Field                                     | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ts`                                      | ISO timestamp of turn completion                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `session`                                 | SessionManager session name                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `engine`                                  | `claude` / `codex` / `codex-app` / `grok` / `opencode` / `agy` / `acp` / `custom`, or a legacy `gemini` / `cursor`                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `model`                                   | Configured model, or the engine's own reported model when none was set (Claude Code: the model named in its `init` event). A configured alias such as `opus[1m]` is recorded as the model the engine reports it resolved to. Absent when neither is known                                                                                                                                                                                                                                                                                                                                   |
| `cwd`                                     | Working directory the turn ran in                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `turn`                                    | 1-based index of the send within the session, counted by the process that recorded it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `tokensIn` / `tokensOut` / `cachedTokens` | **Per-turn deltas**, not session totals                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `costUsd`                                 | Per-turn delta in USD — token count × the registry rate, or the engine's own figure where it reports one (`claude`, `grok`, `opencode`; an `acp` agent uses its own figure or its preset's `pricing` — see [Accuracy](#accuracy-which-engines-report-real-usage)). On a flat-rate plan (a subscription seat) nobody was billed this: set `pricingOverrides` in the plugin config to zero a registry-priced model out (`{"gpt-5.5": {"input": 0, "output": 0, "cached": 0}}`). Read [Zeroing a model's pricing](#zeroing-a-models-pricing) first — it disables `maxBudgetUsd` for that model |
| `tokensEstimated`                         | `true` when the counts came from `estimateTokens()` (see below)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `durationMs`                              | Wall-clock for the turn                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `toolCalls` / `toolErrors`                | Per-turn deltas                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `ok`                                      | `false` for a turn that threw, or that the session's own `turnsSucceeded` counter did not count (see `sessions.md`). Falls back to "nothing was thrown" when the counter cannot be read                                                                                                                                                                                                                                                                                                                                                                                                     |
| `error`                                   | Failure text, truncated to 500 chars. Absent when the turn resolved but the engine did not count it as succeeded (an interrupted or non-SUCCESS turn), so a failed row does not always carry one                                                                                                                                                                                                                                                                                                                                                                                            |
| `refusalFallback`                         | `{ from, to, category? }` when the model refused and the engine re-ran the turn on another model (Claude Code’s refusal fallback, for example Opus 5.5 to an older Opus on a `cyber` refusal). Absent otherwise                                                                                                                                                                                                                                                                                                                                                                             |
| `parent`                                  | The run id — workflow, council, fan-out, ultraplan, ultrareview or autoloop — when the turn belongs to one                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

Deltas rather than totals means summing a query window gives that window's spend
without double-counting.

Every send funnels through `SessionManager.sendMessage`, so council, fanout,
autoloop, workflow agent nodes and verifier fixers, cross-session inbox
deliveries, the ACP server, the OpenAI-compatible bridge, the MCP server and the
CLI are all covered by the same hook. `parent` is what lets you reassemble a
multi-agent run:

```bash
clawo runs --parent council-mh3k2x1a-1a2b3c4d
```

### Reading it

```bash
clawo runs                                   # last 24h, table
clawo runs --since 7d --engine codex         # one engine, one week
clawo runs --session my-session --json       # raw rows + summary
clawo runs --parent fanout-mh3k2x1a-b5f7c886 # every agent turn of one fan-out
```

Over HTTP (GET query string or POST JSON body; the body wins). It takes `since`,
`session`, `engine`, `parent`, `verified=true|false` and `limit` (default 200, the
newest rows):

```bash
curl "http://127.0.0.1:18796/runs?since=24h&limit=200" -H "Authorization: Bearer $TOKEN"
```

Returns `{ ok, rows, summary }`, where `summary` carries `rows`, `costUsd`,
`tokensIn`, `tokensOut`, `estimatedRows`, `verifiedRows`, `refutedRows`,
`unverifiedRows` and a per-engine breakdown `byEngine`. The dashboard
header shows the 24-hour figure from the same endpoint.

Programmatically: `manager.getRunLedger({ since, session, engine, parent, verified, limit })`.

`since` takes a relative window (`30m`, `24h`, `7d`, `2w`), an ISO timestamp or
epoch milliseconds; one it cannot parse widens the query rather than emptying it.
`clawo runs` reads the last 24 h and prints 50 rows by default.

## Spend caps

Set `maxBudgetUsd` on a session (or on a council / fanout, which applies it per
agent). Before each turn the runtime compares the session's cumulative
`getCost().totalUsd` against the cap and refuses to send when it has been reached:

```
Budget exceeded for session "my-session" (codex): spent $1.2400 of $1.0000 cap.
Raise maxBudgetUsd or start a new session to continue.
```

The refusal is a typed `BudgetExceededError` carrying `session`, `engine`,
`spentUsd` and `capUsd`, and it happens **before** the engine is spawned.

Notes:

- The check is "has the cap been reached", not "would this turn exceed it" — a
  turn's cost is unknown until it finishes, so the last allowed turn can overshoot.
  Size the cap accordingly.
- A cap of `0` or a negative number means _unset_, not _refuse everything_.
- Claude Code still receives `--max-budget-usd` as well: an in-CLI stop happens
  earlier and therefore costs less than an after-the-fact refusal.
- `session_list` / `GET /session/list` expose `costUsd`, and `budgetUsd` and
  `budgetExhausted` when a cap is set, so a stalled session shows _why_ it stopped
  taking turns.
- The turns a Codex `/goal` runs on its own (a `goal` workflow node, or a goal
  set with `codex_goal_set`) are not sends: they write no ledger row, and the cap
  does not stop a goal while it runs. Their spend does count toward the session's
  total, so the next send on that session is gated by it; a `goal` node's spend
  is added to its run's `costUsd`, and `tokenBudget` and `timeoutMs` are the goal's
  own limits.

### Zeroing a model's pricing

`pricingOverrides` sets a model's per-token rate, so the cost figures for a subscription
seat read 0 instead of an API-rate equivalent. Zeroing a rate also **disables `maxBudgetUsd`
for that model**: the cap compares the session's accrued `getCost().totalUsd` against it,
and that number is pricing-derived, so at a rate of 0 it never reaches any cap. There is
no separate token or turn ceiling behind it.

- `engine: 'claude'` is outside this: its cost is the CLI's own `total_cost_usd`, so an
  override neither zeroes a Claude row nor disables its cap. The registry rate is used only
  for the first turn of a resumed process and for proxy sessions (see below), and the CLI's
  own `--max-budget-usd` applies as well. `engine: 'grok'` is outside it for the same
  reason: it writes the engine's own `total_cost_usd` into `_stats.costUsd` and never
  consults the registry, so zeroing a model's pricing does not disable its cap.
  `engine: 'acp'` is outside it too: it takes the agent's own reported cost, or prices
  tokens from its preset's `pricing`, and never reads the registry — an agent that
  reports no cost and has no `pricing` accrues nothing, so its cap never bites.
  `engine: 'opencode'` is outside it whenever opencode reports a `cost` for its steps,
  which is then the bill; only output that carries none is priced from the registry.
  For `codex`, `codex-app`, `agy`, `custom` and the legacy engines the runtime check
  is the only one.
- `maxTurns` (and `maxRounds` on a council) still bound the work, and they are the right
  ceiling to reach for once a model prices at 0.
- In a council the cap cannot bite before an agent's second turn in any case: the first
  enters with nothing accrued, and one `sendMessage` runs up to `maxTurnsPerAgent` turns
  inside the CLI, so it can pass the whole cap on its own.
- An `opencode` session started without a model, on turns opencode reports no cost for,
  prices at its engine default `claude-sonnet-4-6`, and so does a session on the legacy
  `cursor` engine started without one. Zeroing a Claude subscription therefore zeroes
  those turns too, and their reported ids (`opencode-default`, `cursor-default`) are
  display names that cannot themselves be overridden.

The override is read once, in the `SessionManager` constructor, from the plugin config.
`clawo serve`, `clawo-acp` and `clawo-mcp` do not pass one, so a ledger written by those
processes prices at registry rates whichever way this is set.

## Accuracy: which engines report real usage

`costUsd` is derived from token counts times the model's price in `models.ts`,
except where the engine reports its own cost (marked in the table below).
Where the engine reports usage, those counts are the engine's own. Where it does
not, the wrapper falls back to `estimateTokens()` (characters ÷ 4) and the row is
flagged `tokensEstimated: true`; the CLI marks those costs with a trailing `~`.

| Engine            | Token counts                                                                                                                                                                                                                                                         |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `claude`          | Engine-reported, including the **cost** (see below)                                                                                                                                                                                                                  |
| `codex`           | Engine-reported                                                                                                                                                                                                                                                      |
| `codex-app`       | Engine-reported                                                                                                                                                                                                                                                      |
| `grok`            | Engine-reported — and so is the **cost**: this engine reports `total_cost_usd`, which the wrapper passes through instead of pricing tokens from the registry, so registry drift cannot affect a grok row                                                             |
| `acp`             | Agent-reported when the prompt response carries `usage`. Cost is the agent's own `usage_update` figure when it sends one in USD, else priced from the preset's `pricing`, else 0. Never estimated — see [`multi-engine.md`](./multi-engine.md#acp-agents-engine-acp) |
| `cursor` (legacy) | Engine-reported when the stream carries `usage`, else estimated                                                                                                                                                                                                      |
| `opencode`        | Engine-reported when the run JSON carries `tokens`, else estimated. The **cost** is opencode's own per-step `cost` when it reports one, else priced from the registry                                                                                                |
| `agy`             | Engine-reported when the result event carries usage, else estimated                                                                                                                                                                                                  |
| `custom`          | Depends on the CLI; estimated when it emits no usage                                                                                                                                                                                                                 |

How a `claude` row's cost is taken:

- The `result` event's `total_cost_usd` is used as-is, so pricing-table drift
  cannot affect a Claude row.
- That figure is the session's running total, so a turn's cost is the difference
  from the previous report.
- A process started with `--resume` (a model switch, a session recovered after a
  restart) reports a total that includes the resumed history. Its first report is
  taken as a baseline, and that one turn is priced from the registry instead, so
  the history is not billed twice (`maxBudgetUsd` gates against this number).
- Proxy sessions (a non-Claude `model` with `baseUrl` set) use the registry
  estimate instead: the CLI believes it is running `opus` while another provider
  serves the tokens, so its own figure would be Opus list price.

### What "input tokens" means is not the same on every engine

Two engines can report `input` and `cached` and mean different things by them,
and the difference decides whether the cost math may subtract one from the other:

| Engine     | Its own arithmetic for one turn                      | `input` contains cached reads |
| ---------- | ---------------------------------------------------- | ----------------------------- |
| `codex`    | `total 19704 = input 19699 + output 5`               | yes                           |
| `grok`     | `total 30034 = input 19393 + output 17 + read 10624` | no                            |
| `opencode` | `total 26315 = input 58 + output 17 + read 26240`    | no                            |
| `claude`   | `input_tokens 2` against `cache_read 47371`          | no                            |

On an engine that excludes them, cached reads and cache writes are billed **on
top of** `input`, and the prompt the turn actually carried is the sum of all
three — which is what `contextPercent` measures. Reading `input` alone reports a
nearly-full context as empty on any resumed conversation, because the history
arrives as cached reads.

Anthropic bills cache _writes_ above the input rate, and the premium depends on
the TTL (1.25x for the 5-minute cache, 2x for the 1-hour one); the Claude
estimate prices both tiers from the split the engine reports. Elsewhere cache
writes are priced at the plain input rate, which is a floor rather than an exact
figure — one more reason to prefer the engine's own `total_cost_usd` where it
offers one.

So on an estimating engine the cap is best-effort. It will stop a runaway session;
it is not an accounting guarantee, and it is not a substitute for the spend limits
your provider offers.

Cost figures are also only as good as the pricing table: a model missing from
`models.ts` is priced as its engine's default model (with a warning in the log),
and subscription plans (Claude Max, ChatGPT Pro) bill nothing per token while the
ledger still reports the API-rate equivalent. Read `costUsd` as "what this would
cost at API rates".

## `ok` vs `verified`

A row carries two different judgements.

- **`ok`** — the engine's own terminal verdict for that turn. Codex fails a turn
  that emits `turn.failed` while exiting 0. It is a careful signal, but it is the
  engine talking about itself.
- **`verified`** — an acceptance contract ran against the work and every required
  check passed. That is the runtime's own measurement.

Three states, not two:

| `verified` | Means                                               | CLI column |
| ---------- | --------------------------------------------------- | ---------- |
| `true`     | A contract ran and passed                           | `yes`      |
| `false`    | A contract ran and a required check failed          | `NO`       |
| absent     | **No contract was declared. Nothing checked this.** | `—`        |

Absent is not false. An unchecked run is not a failed one, and reading it as
either would make the ledger useless for the thing it is for.

### Where the verdict comes from

`verified` is **not written at turn time**, deliberately. The turns that produce
the work all finish before the verifier that judges it, so stamping a verdict on
them as they are written would be inventing one. It is joined in at read time
from the run record via the row's `parent`, by `annotateVerdicts()`. A standalone
`verify_run` writes no row at all: its result is the evidence bundle it returns.

Two consequences worth knowing:

- A raw `runs/*.jsonl` line usually has no `verified` field. Read through
  `clawo runs` / `GET /runs` / `getRunLedger()` to get the join.
- Filtering on `--verified` happens _after_ the join. Pushing the filter into the
  ledger read would match on a field no row carries yet and return nothing.

### Verification row fields

| Field                      | Source                                                                                                                                                          |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `verified`                 | Joined from the run record: `true` for `verified`, `false` for `refuted`, absent for `unverified` (see above)                                                   |
| `evidenceId`, `contractId` | Joined from the run record: the evidence behind its current verdict, and the id of its run-level contract                                                       |
| `nodeKind`                 | The kind of node the turn ran in, when the caller stamps one. Today only fan-out agents do (`fanout`)                                                           |
| `repoLang`                 | Detected from a manifest (`package.json`, `pyproject.toml`, `go.mod`, …). Never guessed — a wrong label would corrupt the comparison the field exists to enable |
| `taskKind`                 | Caller-declared only, through `sendMessage`'s `taskKind` option; no tool or route sets it. Never inferred from the prompt                                       |

All are optional and absent on rows written before 6.0.0. The reader already
skips unknown and missing keys, so old shards stay readable; nothing backfills
them, because we cannot know retroactively.

```bash
clawo runs --since 7d --verified     # only turns whose contract passed
clawo runs --since 7d --refuted      # only turns whose contract failed
clawo runs --parent wf-mh3k2x1a-a1b2c3   # every turn of one workflow run
```

## Related

- [`verification.md`](./verification.md) — what a contract is and how a verdict is produced
- [`workflow.md`](./workflow.md) — where run records live
