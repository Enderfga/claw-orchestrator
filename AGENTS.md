# AGENTS.md — claw-orchestrator

This file provides context for coding agents (Claude Code, Codex, OpenCode, and others) working on
this project. `CLAUDE.md` only imports it, so there is one copy to keep current.

## Architecture

Claw Orchestrator wraps coding CLIs (Claude Code, Codex, Antigravity, Grok Build, OpenCode,
any Agent Client Protocol agent, plus arbitrary custom CLIs) into a managed, programmable
session layer for claw-style agent systems. Runs as a standalone CLI/server, an MCP server,
or an ACP agent, with first-class OpenClaw plugin support. Key source files:

| File                                  | Purpose                                                                                                                                                                                                                                      |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/index.ts`                        | Plugin entry — registers all 78 canonical tools; also the SDK's export surface                                                                                                                                                               |
| `src/session-manager.ts`              | Core orchestrator — session lifecycle, handoff, and the entry point of every mode (council, fan-out, ultraplan/ultrareview, autoloop, UltraApp, workflows, `verify_run`)                                                                     |
| `src/base-oneshot-session.ts`         | Abstract base class for one-shot (process-per-send) engines                                                                                                                                                                                  |
| `src/engine-spawn.ts`                 | The one place engine CLIs are spawned (cross-spawn, so Windows `.cmd` shims run without a shell) and their process trees killed                                                                                                              |
| `src/persistent-session.ts`           | Claude Code CLI wrapper (spawn, JSON protocol, stream parsing)                                                                                                                                                                               |
| `src/persistent-codex-session.ts`     | Codex CLI wrapper (`codex exec --sandbox <mode> --json`, one process per send, thread resume)                                                                                                                                                |
| `src/persistent-codex-app-session.ts` | Codex app-server wrapper (`codex-app` engine: `codex app-server --listen stdio://`, JSON-RPC) — `/goal`, interrupt, steer, fork, rollback                                                                                                    |
| `src/persistent-gemini-session.ts`    | Gemini CLI wrapper — **legacy**: Gemini CLI is sunset, superseded by Antigravity (`agy`). Kept working for existing callers; not documented as an option and not version-tracked.                                                            |
| `src/persistent-agy-session.ts`       | Google Antigravity CLI wrapper (`agy -p --output-format stream-json`) — reported token usage, conversation resumed by id (`--conversation`)                                                                                                  |
| `src/agy-conversation.ts`             | Reads agy's own log for the created conversation id and for tool-confirmation denials                                                                                                                                                        |
| `src/persistent-cursor-session.ts`    | Cursor Agent CLI wrapper — **legacy**: superseded in this lineup by Grok Build (`grok`). Kept working for existing callers; not documented as an option and not version-tracked. Binary is `cursor-agent`, never the contested `agent` name. |
| `src/persistent-grok-session.ts`      | Grok Build CLI wrapper (`grok -p --output-format json`) — engine-reported cost, resumable session id                                                                                                                                         |
| `src/persistent-opencode-session.ts`  | sst/opencode CLI wrapper (`opencode run --format json`)                                                                                                                                                                                      |
| `src/persistent-custom-session.ts`    | Custom engine — any CLI via user-provided `CustomEngineConfig`                                                                                                                                                                               |
| `src/persistent-acp-session.ts`       | ACP engine — drives any Agent Client Protocol agent over stdio (`kimi acp`, `dsh --profile acp`, `opencode acp`)                                                                                                                             |
| `src/council.ts`                      | Multi-agent collaboration engine with git worktree isolation and post-processing                                                                                                                                                             |
| `src/consensus.ts`                    | Consensus voting parser for council                                                                                                                                                                                                          |
| `src/fanout.ts`                       | Fan-out — one task across N engine/model agents in parallel, optional synthesis pass; no worktrees                                                                                                                                           |
| `src/autoloop/`                       | Autoloop — the runner, the dispatcher that drives the Planner / Coder / Reviewer sessions, the message protocol, push notifications                                                                                                          |
| `src/ultraapp/`                       | UltraApp — interview → AppSpec → council build → deploy, its build queue and the `/forge/<slug>/` router                                                                                                                                     |
| `src/kernel/types.ts`                 | One state vocabulary — `RunState`, `RunOutcome`, `WorkflowSpec`, node specs                                                                                                                                                                  |
| `src/kernel/engine.ts`                | The run kernel — checkpointed execution, resume, retry, timeout, cancel, steer                                                                                                                                                               |
| `src/kernel/store.ts`                 | Durable run store (`~/.claw-orchestrator/wf/<runId>/`) — guards, leases, and the one storage transaction                                                                                                                                     |
| `src/kernel/file-lock.ts`             | The one exclusive file lock, shared by the run store and the ultraapp build queue                                                                                                                                                            |
| `src/kernel/exec.ts`                  | The single child-process wrapper — non-throwing, timeout kills the process group, output capped                                                                                                                                              |
| `src/kernel/agent-step.ts`            | The single start→send→stop lifecycle; success reads `turnsSucceeded`                                                                                                                                                                         |
| `src/kernel/conditions.ts`            | Router conditions — a closed set (`always`, `node_failed`, `node_succeeded`, `verified`, `visits_lt`, `and`), deliberately not an expression language                                                                                        |
| `src/kernel/projections.ts`           | The `*_status` tool shapes (council, fan-out, ultraplan, ultrareview, autoloop), derived from the durable run record                                                                                                                         |
| `src/kernel/secrets.ts`               | Secret references — a caller names a secret, the server resolves it from its own environment                                                                                                                                                 |
| `src/kernel/nodes/`                   | One executor per node kind; thin wrappers over the existing engines                                                                                                                                                                          |
| `src/kernel/templates/`               | Built-in workflows (`solve`, `council`, `fanout`, `goal`), UltraApp's build pipeline, and the single-node workflows `council_start` / `fanout_start` / `ultraplan_start` / `ultrareview_start` run on                                        |
| `src/verify/contract.ts`              | `AcceptanceContract` + `CheckSpec`, and the normalizer that keeps agent-authored contracts out                                                                                                                                               |
| `src/verify/runner.ts`                | Runs the checks — the generalisation of ultraapp's `fix-on-failure`                                                                                                                                                                          |
| `src/verify/baseline.ts`              | Base-commit capture and change sets that include created files                                                                                                                                                                               |
| `src/verify/protected-tests.ts`       | Refutes a run that changed the tests its contract runs                                                                                                                                                                                       |
| `src/verify/evidence.ts`              | Evidence bundles — verdict, per-check logs, patch, screenshots                                                                                                                                                                               |
| `src/run-ledger.ts`                   | Durable per-turn record (`~/.claw-orchestrator/runs/*.jsonl`) — append, query, summarize, verdict join                                                                                                                                       |
| `src/concurrency.ts`                  | Bounded parallel map — fan-out and council start no more agents than there are session slots                                                                                                                                                 |
| `src/budget.ts`                       | Runtime-enforced `maxBudgetUsd` spend cap (all engines, not just Claude Code)                                                                                                                                                                |
| `src/models.ts`                       | Centralized model registry — pricing, aliases, engine/provider mapping                                                                                                                                                                       |
| `src/engine-presets.ts`               | Community engine presets (`configs/engines/`) — tiering, provenance validation, `customEngine` / `acpAgent` id resolution                                                                                                                    |
| `src/types.ts`                        | Shared types, interfaces; re-exports from `models.ts`                                                                                                                                                                                        |
| `src/logger.ts`                       | Structured `Logger` interface + console implementation                                                                                                                                                                                       |
| `src/circuit-breaker.ts`              | Engine failure tracking with exponential backoff                                                                                                                                                                                             |
| `src/inbox-manager.ts`                | Cross-session messaging (inbox) manager                                                                                                                                                                                                      |
| `src/handoff.ts`                      | Session handoff — per-session conversation record, and its replay onto another engine                                                                                                                                                        |
| `src/validation.ts`                   | Working-directory and input validation shared by the tool handlers and the HTTP server                                                                                                                                                       |
| `src/sanitize.ts`                     | Secret redaction for engine stderr and logged error reasons, used by the Claude, agy, Grok, OpenCode and custom wrappers                                                                                                                     |
| `src/embedded-server.ts`              | HTTP server for standalone/CLI usage                                                                                                                                                                                                         |
| `src/dashboard/`                      | Web dashboard served by the embedded server at `/dashboard` (Autoloop, Council, Forge and Runs tabs)                                                                                                                                         |
| `src/openai-compat.ts`                | OpenAI-compatible `/v1/chat/completions` endpoint                                                                                                                                                                                            |
| `src/acp-server.ts`                   | Agent Client Protocol adapter — runs the orchestrator as an ACP _agent_                                                                                                                                                                      |
| `src/proxy/`                          | Multi-model proxy (Gemini, GPT via Anthropic format translation)                                                                                                                                                                             |
| `bin/cli.ts`                          | CLI entry point (commander-based)                                                                                                                                                                                                            |
| `bin/mcp-server.ts`                   | MCP stdio entry (`clawo-mcp`) — serves the tools `src/index.ts` registers                                                                                                                                                                    |
| `bin/acp-server.ts`                   | ACP stdio entry (`clawo-acp` / `clawo acp`)                                                                                                                                                                                                  |

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
wrapper passes, one live turn per engine, the ACP + MCP handshakes, and `src/models.ts` against
the OpenAI, Anthropic and xAI published price tables. Exit 1 on a regression, and an unreachable
price source counts as one — an unverified pass is how a stale number keeps its cover. The pinned
versions it compares against are read from the Tested Version column of the
[Engine CLI Reference](#engine-cli-reference) table below, so keep that table's shape.
Run it before touching any wrapper; its `not in --help` list is a prompt for judgement, not a
verdict (claude omits hidden options from help and still accepts them).

```bash
npx tsx scripts/sweep.ts             # human table
npx tsx scripts/sweep.ts --no-live   # versions + flags only, costs nothing
npx tsx scripts/sweep.ts --json --out report.json
```

## Conventions

- **ESM only** — `"type": "module"` in package.json, `.js` extensions in imports
- **Strict TypeScript** — no `any` (eslint warns), full type annotations
- **Lazy initialization** — SessionManager created on first tool call, not at plugin load
- **Engine-agnostic** — all session engines implement `ISession` interface (types.ts)
- **Adding a new tool** — register in `src/index.ts`, add it to `openclaw.plugin.json` `contracts.tools`
  and give it MCP hints in `src/mcp-annotations.ts` (`tool-registration.test.ts` fails when any of the
  three differ), document it in `skills/references/tools.md` and the annotation table in `mcp.md`,
  and update the tool count where it is quoted: `openclaw-tool-result-contract.test.ts`, README.md,
  `skills/SKILL.md`, `skills/references/tools.md`, `mcp.md`, `getting-started.md`, and this file
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

This triggers the `Publish to npm` workflow automatically.

**Publishing uses npm trusted publishing (OIDC) — there is no `NPM_TOKEN` to rotate.**
`publish.yml` installs npm 11.x (trusted publishing needs >= 11.5.1; the pin stays on the 11.x line
on purpose) and runs `npm publish --provenance --access public` with no auth token; credentials
come from GitHub OIDC (`id-token: write`) against the Trusted Publisher configured on npmjs.com
(Package → Settings: repo `Enderfga/claw-orchestrator`, workflow `publish.yml`, no environment).
If a publish ever 404s on the PUT, check the Trusted Publisher config on npmjs.com — it is not a
token problem. (Migrated from a 90-day-expiring `NPM_TOKEN` secret in v4.5.0.)

### 7. Verify

```bash
gh run list --limit 2                          # CI + Publish should both pass
npm view @enderfga/claw-orchestrator version   # should equal X.Y.Z
```

## Engine CLI Reference

Current tested versions (update on each release):

| Engine      | CLI        | Tested Version | Invocation                                                                                                                                                                                                                                                                                                                                                                     |
| ----------- | ---------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Claude      | `claude`   | 2.1.310        | Persistent subprocess: `claude -p --input-format stream-json --output-format stream-json --replay-user-messages --verbose --include-partial-messages --permission-mode M [--resume <id>] [--model M]` (read-only sessions run `--permission-mode plan`)                                                                                                                        |
| Codex       | `codex`    | 0.164.0        | `codex exec --sandbox <mode> --skip-git-repo-check --json -C <dir> [--model M] [--output-schema F] [--profile P] [--ephemeral] [--ignore-user-config] [--add-dir D] -` (prompt on stdin; later turns `codex exec resume <thread>` with the sandbox restated as `-c sandbox_mode=…`). The `codex-app` engine runs `codex app-server --listen stdio:// --enable goals` for /goal |
| Antigravity | `agy`      | 1.4.6          | `agy -p <msg> --output-format stream-json --log-file <tmp> [--mode plan \| --dangerously-skip-permissions \| --sandbox] [--model M] [--effort E] [--conversation <id>] --print-timeout <n>s` (`--mode plan` for read-only sessions)                                                                                                                                            |
| Grok        | `grok`     | 1.0.70         | `grok -p <msg> --output-format json --cwd <dir> [--resume <id>] [--permission-mode M] [--effort E] [--tools/--disallowed-tools] [--json-schema] [--rules]` (read-only runs in `--sandbox read-only`, OS-enforced; refused under the temp dir, off macOS/Linux, or if grok cannot apply it)                                                                                     |
| OpenCode    | `opencode` | 1.19.4         | `opencode run --format json [--session <id>] [--model provider/model] [--variant E]`, prompt on stdin (read-only sessions add `--agent clawo-readonly` + `OPENCODE_CONFIG_CONTENT`)                                                                                                                                                                                            |

ACP agents and custom engines are not pinned here: a community preset carries its own tested version
in `provenance.verifiedAgainst` (`configs/engines/*.json`).

**Important:** When CLI vendors change flags or output format, update the corresponding `persistent-*-session.ts` and re-run integration tests.

See `skills/references/claude-cli-tracking.md` for full sync history.
