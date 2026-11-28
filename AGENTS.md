# AGENTS.md — claw-orchestrator

This file provides context for coding agents (Claude Code, Codex, OpenCode, and others) working on
this project. `CLAUDE.md` only imports it, so there is one copy to keep current.

## Architecture

Claw Orchestrator wraps coding CLIs (Claude Code, Codex, Antigravity, Grok Build, Cursor, OpenCode,
any Agent Client Protocol agent, plus arbitrary custom CLIs) into a managed, programmable
session layer for claw-style agent systems. Runs as a standalone CLI/server, an MCP server,
or an ACP agent, with first-class OpenClaw plugin support. Key source files:

| File                                  | Purpose                                                                                                                                                                                                                                          |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/index.ts`                        | Plugin entry — registers all 85 canonical tools; also the SDK's export surface                                                                                                                                                                   |
| `src/session-params.ts`               | The `session_start` parameters — one list, read by the MCP tool, the CLI's session flags and the defaults file                                                                                                                                   |
| `src/clawo-config.ts`                 | The defaults file (`~/.claw-orchestrator/config.json`): the default engine and per-engine session defaults, read on every session start                                                                                                          |
| `src/session-manager.ts`              | Core orchestrator — session lifecycle, handoff, and the entry point of every mode (council, fan-out, ultraplan/ultrareview, autoloop, UltraApp, workflows, `verify_run`)                                                                         |
| `src/base-oneshot-session.ts`         | Abstract base class for one-shot (process-per-send) engines                                                                                                                                                                                      |
| `src/engine-spawn.ts`                 | The one place engine CLIs are spawned (cross-spawn, so Windows `.cmd` shims run without a shell) and their process trees killed                                                                                                                  |
| `src/persistent-session.ts`           | Claude Code CLI wrapper (spawn, JSON protocol, stream parsing)                                                                                                                                                                                   |
| `src/claude-commands.ts`              | Claude Code's commands for `session_command` — slash commands, skills and custom commands from the `initialize` listing, and control requests named as commands — plus its quota and context-breakdown readings                                  |
| `src/persistent-codex-session.ts`     | Codex CLI wrapper (`codex exec --sandbox <mode> --json`, one process per send, thread resume)                                                                                                                                                    |
| `src/persistent-codex-app-session.ts` | Codex app-server wrapper (`codex-app` engine: `codex app-server --listen stdio://`, JSON-RPC) — `/goal`, interrupt, steer, fork, rollback                                                                                                        |
| `src/codex-app-client.ts`             | A short-lived `codex app-server` for one job: what `codex exec` has no surface for (rate limits, skills and MCP listings, compaction, review, side questions, revert)                                                                            |
| `src/codex-commands.ts`               | Codex's commands for both Codex engines, each run as the app-server RPC it maps to (`commandStyle: 'rpc'`), never as message text                                                                                                                |
| `src/codex-quota.ts`                  | The Codex account's rate limits (`account/rateLimits/read`) for `codex` and `codex-app`, read on the session's own app-server or a short-lived one                                                                                               |
| `src/codex-rollout.ts`                | Reads Codex's rollout files for the spend no stream reports: sub-agent threads and review threads                                                                                                                                                |
| `src/persistent-gemini-session.ts`    | Gemini CLI wrapper — **legacy**: Gemini CLI is sunset, superseded by Antigravity (`agy`). Kept working for existing callers; not documented as an option and not version-tracked.                                                                |
| `src/persistent-agy-session.ts`       | Google Antigravity CLI wrapper (`agy -p --output-format stream-json`) — reported token usage, conversation resumed by id (`--conversation`)                                                                                                      |
| `src/agy-conversation.ts`             | Reads agy's own log for the created conversation id and for tool-confirmation denials                                                                                                                                                            |
| `src/agy-commands.ts`                 | Antigravity's slash commands as print mode runs them: info commands (no model turn, structured `data`), system commands and skills (a turn), and the interactive-only ones agy refuses                                                           |
| `src/agy-transcripts.ts`              | Reads agy's conversation transcripts for what `result.usage` lacks: the model each request ran on, and the spend of `/teamwork` members, `/swarm` workers, `/run-workflow` agents and subagents                                                  |
| `src/agy-quota.ts`                    | agy's quota from its own info commands (`agy -p /usage`, `agy -p /credits`), which run no model turn                                                                                                                                             |
| `src/agy-goal-session.ts`             | Antigravity's own `/goal` loop behind `GoalSession` (`nativeGoal`): the goal stays set on the conversation, and a steer cuts the running process and continues it                                                                                |
| `src/persistent-cursor-session.ts`    | Cursor Agent CLI wrapper (`cursor-agent -p --output-format stream-json`) — chat resumed by id, each turn billed at the model id it was run on, Cursor's sandbox for workspace-write. Binary is `cursor-agent`, never the contested `agent` name. |
| `src/cursor-config-dir.ts`            | A per-session Cursor config directory (`CURSOR_CONFIG_DIR`): every entry links to the user's except a copy of `cli-config.json`, so `--model` never rewrites the user's default model                                                            |
| `src/cursor-models.ts`                | Cursor's model ids (`cursor-agent models`), and a session's effort applied by picking the listed id with that effort suffix                                                                                                                      |
| `src/cursor-commands.ts`              | Cursor's commands and skills, listed by a short-lived `cursor-agent acp` with no turn, and the plan tier `cursor-agent about` prints as its quota                                                                                                |
| `src/cursor-goal-session.ts`          | Cursor's own `/goal` behind `GoalSession` (`nativeGoal`): the goal's state read from its `CreateGoal` / `UpdateGoal` tool calls, spend checked as each process ends                                                                              |
| `src/persistent-grok-session.ts`      | Grok Build CLI wrapper (`grok -p --output-format streaming-json`) — engine-reported cost, resumable session id                                                                                                                                   |
| `src/grok-commands.ts`                | Grok Build's slash commands as `grok -p` handles them: local built-ins, skills and workflows as turns, TUI commands refused, and the ones that need the long-lived ACP route                                                                     |
| `src/grok-goal-session.ts`            | Grok Build's own `/goal` behind `GoalSession` (`nativeGoal`): one `grok -p` process plans, implements and verifies; the verdict is read from grok's goal state                                                                                   |
| `src/grok-quota.ts`                   | Grok Build's quota: the plan from ACP `_x.ai/billing`, and the rolling 24-hour token window from the last usage-limit refusal grok logged                                                                                                        |
| `src/grok-acp-client.ts`              | One-off calls to `grok agent stdio` with no session open: the command list with descriptions (`_x.ai/commands/list`) and the account's plan (`_x.ai/billing`)                                                                                    |
| `src/grok-acp-extension.ts`           | Grok's ACP extension for the `acp` engine (`grok` preset): each turn's usage from `_x.ai/session_notification`, turns grok starts itself (`/deep-research`, `/workflow`, `/loop`) included                                                       |
| `src/persistent-opencode-session.ts`  | sst/opencode CLI wrapper (`opencode run --format json`)                                                                                                                                                                                          |
| `src/opencode-server.ts`              | A private OpenCode 2 server (`opencode serve`) held by one session: turns run as `run --server` clients of it; steers, interrupts, commands, compaction, side questions, reverts and `/goal` go through its HTTP API                             |
| `src/opencode-goal-session.ts`        | OpenCode 2's own `/goal` behind `GoalSession` (`nativeGoal`): set on the held server, its state read through `opencode.goal/get`; OpenCode's judge decides when it is met                                                                        |
| `src/opencode-quota.ts`               | OpenCode's quota: OpenCode Go usage limits and account budgets (`/api/experimental/usage/limits`), through the held server or `opencode api --standalone`                                                                                        |
| `src/persistent-custom-session.ts`    | Custom engine — any CLI via user-provided `CustomEngineConfig`                                                                                                                                                                                   |
| `src/persistent-acp-session.ts`       | ACP engine — any Agent Client Protocol agent over stdio (`kimi acp`, `dsh --profile acp`, `grok agent stdio`, `cursor-agent acp`, `agy acp`); an agent's extension (`registerAcpExtension`) reports turn usage and the turns it starts itself    |
| `src/council.ts`                      | Multi-agent collaboration engine with git worktree isolation and post-processing                                                                                                                                                                 |
| `src/consensus.ts`                    | Consensus voting parser for council                                                                                                                                                                                                              |
| `src/fanout.ts`                       | Fan-out — one task across N engine/model agents in parallel, optional synthesis pass; no worktrees                                                                                                                                               |
| `src/autoloop/`                       | Autoloop — the runner, the dispatcher that drives the Planner / Coder / Reviewer sessions, the message protocol, push notifications                                                                                                              |
| `src/autoloop/forum-bridge.ts`        | An autoloop on its run forum: roles as members, its messages mirrored as posts, what each turn carries, reply blocks, the `forum_post` SSE follower                                                                                              |
| `src/ultraapp/`                       | UltraApp — interview → AppSpec → council build → deploy, its build queue and the `/forge/<slug>/` router                                                                                                                                         |
| `src/kernel/types.ts`                 | One state vocabulary — `RunState`, `RunOutcome`, `WorkflowSpec`, node specs                                                                                                                                                                      |
| `src/kernel/engine.ts`                | The run kernel — checkpointed execution, resume, retry, timeout, cancel, steer                                                                                                                                                                   |
| `src/kernel/store.ts`                 | Durable run store (`~/.claw-orchestrator/wf/<runId>/`) — guards, leases, and the one storage transaction                                                                                                                                         |
| `src/kernel/file-lock.ts`             | The one exclusive file lock, shared by the run store and the ultraapp build queue                                                                                                                                                                |
| `src/kernel/exec.ts`                  | The single child-process wrapper — non-throwing, timeout kills the process group, output capped                                                                                                                                                  |
| `src/kernel/agent-step.ts`            | The single start→send→stop lifecycle; success reads `turnsSucceeded`                                                                                                                                                                             |
| `src/kernel/conditions.ts`            | Router conditions — a closed set (`always`, `node_failed`, `node_succeeded`, `verified`, `visits_lt`, `and`), deliberately not an expression language                                                                                            |
| `src/kernel/projections.ts`           | The `*_status` tool shapes (council, fan-out, ultraplan, ultrareview, autoloop), derived from the durable run record                                                                                                                             |
| `src/kernel/forum/`                   | The run forum, every mode's message bus — store and spool, posts and the authored ledger (`user`/`orchestrator`), routing and pushes, briefs and turn inboxes, rosters, metrics; `forum.ts` re-exports it                                        |
| `src/kernel/handover.ts`              | A node's output posted on its run's forum when it ends, and the open-ASKs note of a result                                                                                                                                                       |
| `src/kernel/isolation.ts`             | A run in a git worktree of its own (`isolation: "worktree"`) — created at start, the spec's directories moved into it, committed to `clawo/<runId>` and removed as the run ends, restored on resume                                              |
| `src/kernel/secrets.ts`               | Secret references — a caller names a secret, the server resolves it from its own environment                                                                                                                                                     |
| `src/kernel/nodes/`                   | One executor per node kind; thin wrappers over the existing engines                                                                                                                                                                              |
| `src/turn-goal-session.ts`            | clawo's goal loop for agy, grok, Cursor, OpenCode and ACP agents, unless `nativeGoal` runs the engine's own: clawo runs the turns until the agent declares `GOAL COMPLETE` / `GOAL BLOCKED`                                                      |
| `src/kernel/templates/`               | Built-in workflows (`solve`, `council`, `fanout`, `goal`), UltraApp's build pipeline, and the single-node workflows `council_start` / `fanout_start` / `ultraplan_start` / `ultrareview_start` run on                                            |
| `src/verify/contract.ts`              | `AcceptanceContract` + `CheckSpec`, and the normalizer that keeps agent-authored contracts out                                                                                                                                                   |
| `src/verify/runner.ts`                | Runs the checks — the generalisation of ultraapp's `fix-on-failure`                                                                                                                                                                              |
| `src/verify/baseline.ts`              | Base-commit capture and change sets that include created files                                                                                                                                                                                   |
| `src/verify/protected-tests.ts`       | Refutes a run that changed the tests its contract runs                                                                                                                                                                                           |
| `src/verify/evidence.ts`              | Evidence bundles — verdict, per-check logs, patch, screenshots                                                                                                                                                                                   |
| `src/verify/metric.ts`                | The `metric` check — a number read from a command's output, held to bounds and to the same command on the base commit in a temporary worktree                                                                                                    |
| `src/verify/check-env.ts`             | The environment checks run with — minimal (no secrets, plus `passEnv`) when an agent of the run worked in a sandbox, the server's otherwise, or what the contract's `checkEnv` says                                                              |
| `src/run-ledger.ts`                   | Durable per-turn record (`~/.claw-orchestrator/runs/*.jsonl`) — append, query, summarize, verdict join — and one row per workflow run (`runs/outcomes/`), grouped by model, engine or workflow                                                   |
| `src/concurrency.ts`                  | Bounded parallel map — fan-out and council start no more agents than there are session slots                                                                                                                                                     |
| `src/budget.ts`                       | Runtime-enforced `maxBudgetUsd` spend cap (all engines, not just Claude Code)                                                                                                                                                                    |
| `src/engine-quota.ts`                 | Engine quota readers — each engine registers its own (`registerQuotaReader`); `engine_quota` and `clawo quota` read them                                                                                                                         |
| `src/models.ts`                       | Centralized model registry — pricing, aliases, engine/provider mapping                                                                                                                                                                           |
| `src/engine-presets.ts`               | Community engine presets (`configs/engines/`) — tiering, provenance validation, `customEngine` / `acpAgent` id resolution                                                                                                                        |
| `src/types.ts`                        | Shared types, interfaces; re-exports from `models.ts`                                                                                                                                                                                            |
| `src/logger.ts`                       | Structured `Logger` interface + console implementation                                                                                                                                                                                           |
| `src/circuit-breaker.ts`              | Engine failure tracking with exponential backoff                                                                                                                                                                                                 |
| `src/inbox-manager.ts`                | Cross-session messages on the session forum (`fm-sessions-…`): the delivery policy, the inbox view, answers by reply block, the `<cross-session-message>` envelope                                                                               |
| `src/handoff.ts`                      | Session handoff — per-session conversation record, and its replay onto another engine                                                                                                                                                            |
| `src/validation.ts`                   | Working-directory and input validation shared by the tool handlers and the HTTP server                                                                                                                                                           |
| `src/sanitize.ts`                     | Secret redaction for engine stderr and logged error reasons, used by the Claude, agy, Grok, OpenCode and custom wrappers                                                                                                                         |
| `src/embedded-server.ts`              | HTTP server for standalone/CLI usage                                                                                                                                                                                                             |
| `src/dashboard/`                      | Web dashboard served by the embedded server at `/dashboard` (Autoloop, Council, Forge and Runs tabs)                                                                                                                                             |
| `src/openai-compat.ts`                | OpenAI-compatible `/v1/chat/completions` endpoint                                                                                                                                                                                                |
| `src/acp-server.ts`                   | Agent Client Protocol adapter — runs the orchestrator as an ACP _agent_                                                                                                                                                                          |
| `src/proxy/`                          | Multi-model proxy (Gemini, GPT via Anthropic format translation)                                                                                                                                                                                 |
| `bin/cli.ts`                          | CLI entry point (commander-based)                                                                                                                                                                                                                |
| `bin/session-flags.ts`                | The session flags of `clawo session-start`, built from `session-params.ts`, and the engine shorthands (`--codex`, `--agy`, …)                                                                                                                    |
| `bin/mcp-server.ts`                   | MCP stdio entry (`clawo-mcp`) — serves the tools `src/index.ts` registers                                                                                                                                                                        |
| `bin/acp-server.ts`                   | ACP stdio entry (`clawo-acp` / `clawo acp`)                                                                                                                                                                                                      |

## Development

```bash
npm run build          # rm -rf dist && tsc && scripts/postbuild.mjs (dist/index.js shim, dashboard assets)
npm run lint           # ESLint (src/ and bin/)
npm run format:check   # Prettier check (src/**/*.ts and bin/**/*.ts)
npm run test           # Vitest unit tests (src/__tests__/)
```

CI (`.github/workflows/ci.yml`) runs these four on Node 22 and 24, on pushes to `main` and on
pull requests against it — nowhere else, so a branch has no CI run until it is in a PR.

Integration test — a manual smoke test, not part of CI; needs `claude` installed and authenticated:

```bash
npx tsx scripts/test-integration.ts
```

Weekly engine sweep — the measurement half of the weekly check, deterministic, no LLM. Reports
installed / pinned / upstream versions, the flag surface of each core engine against what its
wrapper passes, its slash-command listing, one live turn per engine, the ACP + MCP handshakes, and
`src/models.ts` against the OpenAI, Anthropic and xAI published price tables. The flag surface is
`--help` plus, for Claude and Cursor, the options their shipped JavaScript declares, hidden ones
included, and each hidden option is reviewed like a listed flag. On a live run it also checks that
a session-level option does not write the user's engine config: one Cursor turn with `--model`,
on a scratch copy of `CURSOR_CONFIG_DIR`, compared afterwards. Exit 1 on a regression. A flag,
subcommand or slash command with no decision is one; so is a hidden-option scan or command listing
that could not run, a config write, and an unreachable price source — an unverified pass is how a
stale number keeps its cover. The pinned versions it compares against are read from the Tested
Version column of the [Engine CLI Reference](#engine-cli-reference) table below, so keep that
table's shape. Run it before touching any wrapper; its `not in --help` list (flags the wrapper
passes that are neither in `--help` nor in the option list the CLI declares) is a prompt for
judgement, not a verdict.

Each engine's own slash commands (codex: its app-server's RPC methods) are listed without a model
turn and reviewed in `scripts/sweep-reviewed.json`, one command name per key (a key ending in `*`
covers a prefix): `slashCommands` for what the listing shows (a decision it no longer matches is
reported stale), `unlistedSlashCommands` for TUI-only commands and others the headless listing
cannot show. A command the engine's source names as a quoted literal (`'/compact'`,
`'thread/start'`) needs no decision. The user's and the project's
skills and commands are left out of every listing — by the source the engine reports, by where their
files are, or by listing on a config of the sweep's own — so the review does not depend on what is
installed on the machine.

```bash
npx tsx scripts/sweep.ts             # human table
npx tsx scripts/sweep.ts --no-live   # no turns: versions, flags, hidden options, slash commands; costs nothing
npx tsx scripts/sweep.ts --only cursor,claude   # those engines only, a partial check
npx tsx scripts/sweep.ts --json --out report.json
```

The installed `opencode` is OpenCode 2 (`@opencode/cli`). The 1.x line (`opencode-ai`) is still supported and
checked through `OPENCODE1_BIN`: install it into a scratch prefix (`npm i --prefix <dir> opencode-ai@latest`) and
point the variable at `<dir>/node_modules/.bin/opencode`; without it that row is skipped.

## Conventions

- **ESM only** — `"type": "module"` in package.json, `.js` extensions in imports
- **Strict TypeScript** — no `any` (eslint warns), full type annotations
- **Lazy initialization** — SessionManager created on first tool call, not at plugin load
- **Engine-agnostic** — all session engines implement `ISession` interface (types.ts)
- **Adding a new tool** — register in `src/index.ts`, add it to `openclaw.plugin.json` `contracts.tools`
  and give it MCP hints in `src/mcp-annotations.ts` (`tool-registration.test.ts` fails when any of the
  three differ), document it in `skills/references/tools.md` and the annotation table in `mcp.md`,
  and update the tool count where it is quoted: `openclaw-tool-result-contract.test.ts`, `embedded-server-tools.test.ts`, README.md,
  `skills/SKILL.md`, `skills/references/tools.md`, `mcp.md`, `getting-started.md`, and this file
- **Adding a session field** — add it to `src/session-params.ts` (and `SessionConfig` in `src/types.ts`); it is
  then an MCP `session_start` parameter, a `clawo session-start` flag and a `clawo config` key at once
  (`cli-session-flags.test.ts` holds the three together). Document it in `skills/references/tools.md`
- **Legacy engines** — `gemini` and `cursor` stay in `ENGINE_TYPES` for existing callers; they are not
  offered in new surfaces (the ACP model selector hides them) and not documented as options

## Testing

- Unit tests live in `src/__tests__/*.test.ts` (vitest, no external dependencies)
- `vitest.config.ts` runs at most four forked workers with a 1 GB heap each, so a runaway test fails as
  a heap-limit crash instead of exhausting the machine's memory. Keep those caps
- `scripts/test-integration.ts` is a manual smoke test requiring live CLIs — not part of CI
- `scripts/test-ultraapp-integration.ts --trace=<name|all>` replays UltraApp's reference interview traces
  (spec-extraction quality); manual, not part of CI
- Tests are excluded from TypeScript compilation (tsconfig.json exclude) so they don't ship in dist/.
  `npm run typecheck:tests` type-checks them (`tsconfig.test.json`); it is a diagnostic, not a gate, and
  still reports pre-existing errors in test doubles — read the errors a change adds

## Documentation

All documentation lives in `skills/references/`. This is the **single source of truth**; `docs/` is
gitignored local scratch and never ships.

When you change functionality, update the corresponding reference file:

| What changed                   | Update                                                         |
| ------------------------------ | -------------------------------------------------------------- |
| Tool parameters or behavior    | `skills/references/tools.md`                                   |
| Engine invocation / flags      | `skills/references/multi-engine.md`                            |
| Session lifecycle              | `skills/references/sessions.md`                                |
| ACP agent behaviour            | `skills/references/acp.md`                                     |
| Council protocol               | `skills/references/council.md`                                 |
| Inbox messaging                | `skills/references/inbox.md`                                   |
| Ultraplan/Ultrareview          | `skills/references/ultra.md`                                   |
| Autoloop                       | `skills/references/autoloop.md`                                |
| UltraApp                       | `skills/references/ultraapp.md`                                |
| Run ledger / cost / spend caps | `skills/references/observability.md`                           |
| Workflow kernel, nodes, resume | `skills/references/workflow.md`                                |
| Acceptance contracts, evidence | `skills/references/verification.md`                            |
| CLI commands                   | `skills/references/cli.md`                                     |
| Dashboard                      | `skills/references/dashboard.md`                               |
| MCP server                     | `skills/references/mcp.md`                                     |
| OpenAI-compatible endpoint     | `skills/references/openai-compat.md`                           |
| Setup / prerequisites          | `skills/references/getting-started.md`                         |
| Community engine presets       | `configs/engines/README.md`                                    |
| Engine version alignment       | `skills/references/claude-cli-tracking.md`                     |
| New feature or tool            | Also update `skills/SKILL.md` description for trigger keywords |

Also update:

- **README.md** — if the change affects the Highlights list, the All features table, the News list,
  the Quick Start commands, or the engine compatibility table
- **CHANGELOG.md** — always, for any user-facing change

## PR Guidelines

- Prefix: `feat:`, `fix:`, `docs:`, `chore:`, `test:`
- Run `npm run build && npm run lint && npm run format:check && npm run test` before submitting
- Update CHANGELOG.md for user-facing changes
- Installing through `openclaw plugins install` requires `--dangerously-force-unsafe-install`
  (child_process usage); `install.sh` registers the package through `plugins.load.paths` instead

## Release Process

Follow this checklist for every release. Do not skip steps.

### 1. Pre-flight

```bash
npm run build && npm run lint && npm run format:check && npm run test   # Must all pass

# Tarball + leak sweep (added after the 3.5.0-3.5.4 incident, see git history)
npm pack --dry-run                                                       # Inspect file list
grep -rEn '<personal-or-internal-string>' src configs skills bin scripts README.md CHANGELOG.md package.json  # Tree
git log --all -p -S '<personal-or-internal-string>'                      # History
```

The `build` script must clean `dist/` first (it does: `rm -rf dist && tsc && ...`).
Without that, source-tree refactors leave stale paths in the tarball and ship
content the new source already removed.

**Hard rule on leak-fix releases**: if the patch is sanitising something
previously hard-coded, the commit message / CHANGELOG entry / release title /
release body **must NOT name what was leaked**, list affected versions, or
include words like "security" / "🔒" / "hard-coded" / "sanitize". Frame as a
bland refactor. The CHANGELOG entry ships in the tarball — same treatment.

### 2. Version bump

Update version in `package.json`. Follow semver:

- **patch** (x.y.Z) — bug fixes, no new features
- **minor** (x.Y.0) — new features, backward compatible
- **major** (X.0.0) — breaking changes

### 3. CHANGELOG.md

Add a new section at the top:

```markdown
## [X.Y.Z] - YYYY-MM-DD

### Added / Fixed / Changed / Removed

- Description of each change
```

### 4. README.md sync

Check and update if needed:

- Engine compatibility table — `npx tsx scripts/sweep.ts --no-live` reports installed vs pinned
  versions of every core engine; keep it, and the Engine CLI Reference table below, in step. Its
  ACP row quotes the bundled presets' `provenance.verifiedAgainst`
- News, Highlights and All features (if new features added)

### 5. Commit, tag, push

```bash
git add -A
git commit -m "feat/fix: description (vX.Y.Z)"
git tag vX.Y.Z
git push origin main && git push origin vX.Y.Z
```

### 6. Create GitHub Release

```bash
gh release create vX.Y.Z --title "vX.Y.Z — Title" --notes "release notes"
```

This triggers the `Publish to npm` workflow automatically, and `Publish to ClawHub` once it is set up (see
[ClawHub](#clawhub) below).

**Publishing uses npm trusted publishing (OIDC) — there is no `NPM_TOKEN` to rotate.**
`publish.yml` installs npm 11.x (trusted publishing needs >= 11.5.1; the pin stays on the 11.x line
on purpose) and runs `npm publish --provenance --access public` with no auth token; credentials
come from GitHub OIDC (`id-token: write`) against the Trusted Publisher configured on npmjs.com
(Package → Settings: repo `Enderfga/claw-orchestrator`, workflow `publish.yml`, no environment).
If a publish ever 404s on the PUT, check the Trusted Publisher config on npmjs.com — it is not a
token problem. (Migrated from a 90-day-expiring `NPM_TOKEN` secret in v4.5.0.)

### 7. Verify

```bash
gh run list --limit 3                          # CI + Publish (+ ClawHub) should all pass
npm view @enderfga/claw-orchestrator version   # should equal X.Y.Z
```

### ClawHub

The same GitHub release also triggers `clawhub-publish.yml`. It builds and packs the package, then publishes
it to [ClawHub](https://clawhub.ai) through ClawHub's reusable `package-publish.yml` workflow, pinned by commit
SHA, and waits for ClawHub's security checks. It runs only when the repository secret `CLAWHUB_TOKEN` exists;
without it, release runs skip. One-time setup:

1. Sign in at [clawhub.ai](https://clawhub.ai) with the GitHub account that owns the `@enderfga` scope, and
   create a token under Settings → API tokens. The package scope must match the publishing account.
2. Add it as the repository secret `CLAWHUB_TOKEN`.

The next release is then the first ClawHub publish, which also creates the package there. A manual run
(Actions → Publish to ClawHub → Run workflow) is a dry run by default; a real manual publish, for example to
retry a release, must be started on that release's tag (`vX.Y.Z` matching `package.json`). ClawHub keeps each release hidden until its security
checks pass; if they hold it, the run fails after the wait (30 minutes by default) and the release can be
retried or recovered with `clawhub package recover`. `openclaw.compat.pluginApi` and
`openclaw.build.openclawVersion` in `package.json` are required by ClawHub; `clawhub-metadata.test.ts` keeps them
equal to the `openclaw` peer range and the lockfile version.

## Engine CLI Reference

Current tested versions (update on each release):

| Engine      | CLI            | Tested Version | Invocation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------- | -------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude      | `claude`       | 2.1.332        | Persistent subprocess: `claude -p --input-format stream-json --output-format stream-json --replay-user-messages --verbose --include-partial-messages --permission-mode M [--resume <id>] [--model M] [--effort E] [--advisor M] [--settings S]` (read-only sessions run `--permission-mode plan`; `fastMode` and `outputStyle` go in through `--settings`; `CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING=1` unless the environment sets it, so a rewind can restore files)                                                                                                                                                                                                                                                                             |
| Codex       | `codex`        | 0.172.0        | `codex exec --sandbox <mode> --skip-git-repo-check --json -C <dir> [--model M] [--output-schema F] [--profile P] [--ephemeral] [--ignore-user-config] [--ignore-rules] [-c key=value]... [--add-dir D] --output-last-message <tmp> [--image=<path>]... -` (prompt on stdin; later turns `codex exec resume <thread>`, a fork `codex exec fork <thread>`, with the sandbox restated as `-c sandbox_mode=…`). The `codex-app` engine runs `codex app-server --listen stdio:// --enable goals` for /goal; a `codex` session's commands, quota, side questions, compaction and rewinds run on a short-lived `codex app-server --listen stdio://`                                                                                                        |
| Antigravity | `agy`          | 1.5.19         | `agy -p <msg> --output-format stream-json --log-file <tmp> [--mode plan\|accept-edits\|auto \| --dangerously-skip-permissions \| --sandbox] [--model M] [--effort E] [--conversation <id>] [--settings S] [--json-schema J] [--add-dir D]... [--agent A] [--disable-slash-commands] --print-timeout <n>s` (`--mode plan` for read-only sessions; `--sandbox` runs with `"agentMode": ""` merged into `--settings`). A command or skill is `-p '/name args'` and a `plan` send `-p '/plan <msg>'`, neither with `--disable-slash-commands`; orchestrator models get no `--effort`; quota is `agy -p /usage` and `agy -p /credits`                                                                                                                    |
| Grok        | `grok`         | 1.0.92         | `grok -p --output-format streaming-json --cwd <dir> [--resume <id>] [--model M] [--permission-mode M] [--effort E] [--tools T] [--allow R]... [--deny R]... [--disallowed-tools T] [--json-schema] [--rules=…] [--no-wait-for-background]`, prompt on stdin (a turn with images: `--prompt-file <tmp>.json`). Read-only runs in `--sandbox read-only`, workspace-write in `--sandbox workspace`, OS-enforced; refused under the temp dir for read-only, off macOS/Linux, or if grok cannot apply it. A `plan` send runs `--permission-mode plan`; a native goal's process waits for grok's later rounds (no `--no-wait-for-background`); a side question runs on `--resume <id> --fork-session --max-turns 1` with every tool removed               |
| Cursor      | `cursor-agent` | 2026.11.22     | `cursor-agent -p <msg> [--mode plan\|ask \| --sandbox enabled \| --force] [--auto-review] --trust --output-format stream-json --stream-partial-output [--add-dir D]... [--plugin-dir D]... [--image <path>]... [--resume <chatId>] --model <id> [--workspace <dir>]`, with `CURSOR_CONFIG_DIR` set to a per-session mirror of the user's config directory. `--model` is always passed (`auto` by default, the effort written into the id). Read-only: `--mode ask`, or `--mode plan` for a plan turn, plus a deny-all-writes `.cursor/cli.json` in the process cwd; workspace-write: Cursor's OS sandbox, never with `--force`. Commands are listed by `cursor-agent acp`                                                                           |
| OpenCode    | `opencode`     | 1.19.6         | `opencode run --format json [--command=<name>] --thinking [--session <id> [--fork]] [--title=…] [--model provider/model] [--variant E] [--agent A] [--auto] [--pure] [--file=<image>]...`, prompt on stdin (read-only sessions add `--agent clawo-readonly` + `OPENCODE_CONFIG_CONTENT`; a `plan` send runs `--agent plan`)                                                                                                                                                                                                                                                                                                                                                                                                                         |
| OpenCode 2  | `opencode` 2.x | 2.4.2          | `opencode run --format json --server <url> --thinking [--session <id> [--fork]] [--title=…] [--archived] [--model provider/model[#variant]] [--agent A] [--auto] [-f <image>]...`, prompt on stdin: a client of the session's own `opencode serve --stdio --port 0`, stopped after 30 s unused, whose HTTP API takes steers, interrupts, commands, compaction, side questions, reverts and `/goal`. `--standalone` replaces `--server` when that server cannot start, or with `CLAWO_OPENCODE_STANDALONE=1`. Effort joins the model as `#variant`; a variant the model lacks is retried without it. Read-only sessions add `--agent clawo-readonly` with the agent in the V2 format in `OPENCODE_CONFIG_CONTENT`; a `plan` send runs `--agent plan` |

ACP agents and custom engines are not pinned here: a community preset carries its own tested version
in `provenance.verifiedAgainst` (`configs/engines/*.json`).

**Important:** When CLI vendors change flags or output format, update the corresponding `persistent-*-session.ts` and re-run integration tests.

See `skills/references/claude-cli-tracking.md` for full sync history.
