# Observability — Run Ledger & Spend Caps

Two related surfaces: a durable record of every turn this runtime executes, and a
spend cap that is enforced by the runtime rather than by whichever CLI happens to
support a budget flag.

## Why

`getStats()` / `getCost()` describe a **live** session. They live in memory, and
per-session history is capped and evicted, so a restart erased everything except
the resume-id registry — there was no way to answer "what did we run today, on
which engine, for how much". The run ledger is that record.

The same gap made `maxBudgetUsd` a promise the runtime did not keep: it was only
ever translated into Claude Code's `--max-budget-usd` flag, so a council of Codex
agents ran with no cap at all. The cap is now applied in `SessionManager`, which
every engine passes through.

## The ledger

- Location: `~/.claw-orchestrator/runs/YYYY-MM-DD.jsonl` (override with
  `CLAWO_RUNS_DIR`).
- One JSON object per line, one line per completed turn — **successful or not**.
- Shards are one file per UTC day. Queries always filter on the row timestamp, so
  the shard boundary is a storage detail; `--since 24h` spans midnight correctly.
- Writes are best-effort: a ledger failure is logged at `warn` and swallowed. It
  can never break the turn it is describing.
- Nothing prunes old shards. A row is roughly 250 bytes; delete shards yourself if
  you want the history gone.

### Row schema

| Field                                     | Meaning                                                                                                                                                                                          |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ts`                                      | ISO timestamp of turn completion                                                                                                                                                                 |
| `session`                                 | SessionManager session name                                                                                                                                                                      |
| `engine`                                  | `claude` / `codex` / `codex-app` / `grok` / `opencode` / `agy` / `custom`                                                                                                                        |
| `model`                                   | Configured model, or the engine's own reported model when none was set                                                                                                                           |
| `cwd`                                     | Working directory the turn ran in                                                                                                                                                                |
| `turn`                                    | 1-based turn index within the session                                                                                                                                                            |
| `tokensIn` / `tokensOut` / `cachedTokens` | **Per-turn deltas**, not session totals                                                                                                                                                          |
| `costUsd`                                 | Per-turn delta in USD — token count × the registry rate. On a flat-rate plan (a subscription seat) nobody was billed this: set `pricingOverrides` in the plugin config to zero the model out (`{"gpt-5.5": {"input": 0, "output": 0, "cached": 0}}`). Fields merge over the registry rate, so a partial override leaves the rest at list price |
| `tokensEstimated`                         | `true` when the counts came from `estimateTokens()` (see below)                                                                                                                                  |
| `durationMs`                              | Wall-clock for the turn                                                                                                                                                                          |
| `toolCalls` / `toolErrors`                | Per-turn deltas                                                                                                                                                                                  |
| `ok`                                      | `false` for a turn that threw, or that the session's own `turnsSucceeded` counter did not count (see `sessions.md`). Falls back to "nothing was thrown" when the counter cannot be read          |
| `error`                                   | Failure text, truncated to 500 chars. Absent when the turn resolved but the engine did not count it as succeeded (an interrupted or non-SUCCESS turn), so a failed row does not always carry one |
| `parent`                                  | council id / fanout id / autoloop run id, when the turn belongs to one                                                                                                                           |

Deltas rather than totals means summing a query window gives that window's spend
without double-counting.

Every path funnels through `SessionManager.sendMessage`, so council, fanout,
autoloop, ACP, the OpenAI-compatible bridge, the MCP server and the CLI are all
covered by the same hook. `parent` is what lets you reassemble a multi-agent run:

```bash
clawo runs --parent council-1a2b3c4d
```

### Reading it

```bash
clawo runs                                   # last 24h, table
clawo runs --since 7d --engine codex         # one engine, one week
clawo runs --session my-session --json       # raw rows + summary
clawo runs --parent fanout-b5f7c886          # every agent turn of one fan-out
```

Over HTTP (GET query string or POST JSON body):

```bash
curl "http://127.0.0.1:18796/runs?since=24h&limit=200" -H "Authorization: Bearer $TOKEN"
```

Returns `{ ok, rows, summary }`, where `summary` carries `rows`, `costUsd`,
`tokensIn`, `tokensOut`, `estimatedRows` and a per-engine breakdown. The dashboard
header shows the 24-hour figure from the same endpoint.

Programmatically: `manager.getRunLedger({ since, session, engine, parent, limit })`.

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
- `session_list` / `GET /session/list` expose `costUsd`, `budgetUsd` and
  `budgetExhausted` so a stalled session shows _why_ it stopped taking turns.

## Accuracy: which engines report real usage

`costUsd` is derived from token counts times the model's price in `models.ts`.
Where the engine reports usage, those counts are the engine's own. Where it does
not, the wrapper falls back to `estimateTokens()` (characters ÷ 4) and the row is
flagged `tokensEstimated: true`; the CLI marks those costs with a trailing `~`.

| Engine            | Token counts                                                                                                                                                                                             |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `claude`          | Engine-reported                                                                                                                                                                                          |
| `codex`           | Engine-reported                                                                                                                                                                                          |
| `codex-app`       | Engine-reported                                                                                                                                                                                          |
| `grok`            | Engine-reported — and so is the **cost**: this engine reports `total_cost_usd`, which the wrapper passes through instead of pricing tokens from the registry, so registry drift cannot affect a grok row |
| `cursor` (legacy) | Engine-reported when the stream carries `usage`, else estimated                                                                                                                                          |
| `opencode`        | Engine-reported when the run JSON carries `tokens`, else estimated                                                                                                                                       |
| `agy`             | Engine-reported when the result event carries usage, else estimated                                                                                                                                      |
| `custom`          | Depends on the CLI; estimated when it emits no usage                                                                                                                                                     |

So on an estimating engine the cap is best-effort. It will stop a runaway session;
it is not an accounting guarantee, and it is not a substitute for the spend limits
your provider offers.

Cost figures are also only as good as the pricing table: a model missing from
`models.ts` prices at its family default, and subscription plans (Claude Max,
ChatGPT Pro) bill nothing per token while the ledger still reports the API-rate
equivalent. Read `costUsd` as "what this would cost at API rates".

## `ok` vs `verified` (6.0.0)

A row now carries two different judgements, and conflating them is the mistake
this section exists to prevent.

- **`ok`** — the engine's own terminal verdict for that turn. Codex fails a turn
  that emits `turn.failed` while exiting 0; gemini succeeds on exit 53. It is a
  careful signal, but it is the engine talking about itself.
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
from the run record via the row's `parent`, by `annotateVerdicts()`.

Two consequences worth knowing:

- A raw `runs/*.jsonl` line usually has no `verified` field. Read through
  `clawo runs` / `GET /runs` / `getRunLedger()` to get the join.
- Filtering on `--verified` happens _after_ the join. Pushing the filter into the
  ledger read would match on a field no row carries yet and return nothing.

### Other new row fields

| Field                      | Source                                                                                                                                                          |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `evidenceId`, `contractId` | Joined from the run record                                                                                                                                      |
| `nodeKind`                 | The kernel node the turn belonged to (`agent`, `council`, `verifier`, …)                                                                                        |
| `repoLang`                 | Detected from a manifest (`package.json`, `pyproject.toml`, `go.mod`, …). Never guessed — a wrong label would corrupt the comparison the field exists to enable |
| `taskKind`                 | Caller-declared only. Never inferred from the prompt                                                                                                            |

All are optional and absent on rows written before 6.0.0. The reader already
skips unknown and missing keys, so old shards stay readable; nothing backfills
them, because we cannot know retroactively.

```bash
clawo runs --since 7d --verified     # only turns whose contract passed
clawo runs --since 7d --refuted      # only turns whose contract failed
clawo runs --parent wf-abc123        # every turn of one workflow run
```

## Related

- [`verification.md`](./verification.md) — what a contract is and how a verdict is produced
- [`workflow.md`](./workflow.md) — where run records live
