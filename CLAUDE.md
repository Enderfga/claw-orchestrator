# CLAUDE.md — claw-orchestrator

This file provides context for Claude Code when working on this project.

## Architecture

Claw Orchestrator wraps coding CLIs (Claude Code, Codex, Antigravity, Grok Build, plus
arbitrary custom CLIs) into a managed, programmable session layer for claw-style
agent systems. Runs as a standalone CLI/server, with first-class OpenClaw plugin
support. Key source files:

| File                                 | Purpose                                                                                                                                                                                                                                      |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/index.ts`                       | Plugin entry — registers all 77 canonical tools                                                                                                                                                                                              |
| `src/session-manager.ts`             | Core orchestrator — session lifecycle, council, ultraplan/ultrareview                                                                                                                                                                        |
| `src/base-oneshot-session.ts`        | Abstract base class for one-shot (process-per-send) engines                                                                                                                                                                                  |
| `src/persistent-session.ts`          | Claude Code CLI wrapper (spawn, JSON protocol, stream parsing)                                                                                                                                                                               |
| `src/persistent-codex-session.ts`    | Codex CLI wrapper (`codex exec --full-auto`)                                                                                                                                                                                                 |
| `src/persistent-gemini-session.ts`   | Gemini CLI wrapper — **legacy**: Gemini CLI is sunset, superseded by Antigravity (`agy`). Kept working for existing callers; not documented as an option and not version-tracked.                                                            |
| `src/persistent-agy-session.ts`      | Google Antigravity CLI wrapper (`agy -p`, plain text, log-harvested conversation resume)                                                                                                                                                     |
| `src/persistent-cursor-session.ts`   | Cursor Agent CLI wrapper — **legacy**: superseded in this lineup by Grok Build (`grok`). Kept working for existing callers; not documented as an option and not version-tracked. Binary is `cursor-agent`, never the contested `agent` name. |
| `src/persistent-grok-session.ts`     | Grok Build CLI wrapper (`grok -p --output-format json`) — engine-reported cost, resumable session id                                                                                                                                         |
| `src/persistent-opencode-session.ts` | sst/opencode CLI wrapper (`opencode run --format json`)                                                                                                                                                                                      |
| `src/persistent-custom-session.ts`   | Custom engine — any CLI via user-provided `CustomEngineConfig`                                                                                                                                                                               |
| `src/council.ts`                     | Multi-agent collaboration engine with git worktree isolation and post-processing                                                                                                                                                             |
| `src/consensus.ts`                   | Consensus voting parser for council                                                                                                                                                                                                          |
| `src/kernel/types.ts`                | One state vocabulary — `RunState`, `RunOutcome`, `WorkflowSpec`, node specs                                                                                                                                                                  |
| `src/kernel/engine.ts`               | The run kernel — checkpointed execution, resume, retry, timeout, cancel, steer                                                                                                                                                               |
| `src/kernel/store.ts`                | Durable run store (`~/.claw-orchestrator/wf/<runId>/`) — guards, leases, and the one storage transaction                                                                                                                                     |
| `src/kernel/file-lock.ts`            | The one exclusive file lock, shared by the run store and the ultraapp build queue                                                                                                                                                            |
| `src/kernel/exec.ts`                 | The single child-process wrapper — non-throwing, timeout kills the process group, output capped                                                                                                                                              |
| `src/kernel/agent-step.ts`           | The single start→send→stop lifecycle; success reads `turnsSucceeded`                                                                                                                                                                         |
| `src/kernel/nodes/`                  | One executor per node kind; thin wrappers over the existing engines                                                                                                                                                                          |
| `src/kernel/templates/`              | Built-in workflows (`solve`, `council`, `fanout`, `ultraapp`)                                                                                                                                                                                |
| `src/verify/contract.ts`             | `AcceptanceContract` + `CheckSpec`, and the normalizer that keeps agent-authored contracts out                                                                                                                                               |
| `src/verify/runner.ts`               | Runs the checks — the generalisation of ultraapp's `fix-on-failure`                                                                                                                                                                          |
| `src/verify/baseline.ts`             | Base-commit capture and change sets that include created files                                                                                                                                                                               |
| `src/verify/evidence.ts`             | Evidence bundles — verdict, per-check logs, patch, screenshots                                                                                                                                                                               |
| `src/run-ledger.ts`                  | Durable per-turn record (`~/.claw-orchestrator/runs/*.jsonl`) — append, query, summarize, verdict join                                                                                                                                       |
| `src/budget.ts`                      | Runtime-enforced `maxBudgetUsd` spend cap (all engines, not just Claude Code)                                                                                                                                                                |
| `src/models.ts`                      | Centralized model registry — pricing, aliases, engine/provider mapping                                                                                                                                                                       |
| `src/engine-presets.ts`              | Community engine presets — tiering, provenance validation, `customEngine` id resolution                                                                                                                                                      |
| `src/types.ts`                       | Shared types, interfaces; re-exports from `models.ts`                                                                                                                                                                                        |
| `src/logger.ts`                      | Structured `Logger` interface + console implementation                                                                                                                                                                                       |
| `src/circuit-breaker.ts`             | Engine failure tracking with exponential backoff                                                                                                                                                                                             |
| `src/inbox-manager.ts`               | Cross-session messaging (inbox) manager                                                                                                                                                                                                      |
| `src/embedded-server.ts`             | HTTP server for standalone/CLI usage                                                                                                                                                                                                         |
| `src/openai-compat.ts`               | OpenAI-compatible `/v1/chat/completions` endpoint                                                                                                                                                                                            |
| `src/acp-server.ts`                  | Agent Client Protocol adapter — runs the orchestrator as an ACP _agent_                                                                                                                                                                      |
| `src/proxy/`                         | Multi-model proxy (Gemini, GPT via Anthropic format translation)                                                                                                                                                                             |
| `bin/cli.ts`                         | CLI entry point (commander-based)                                                                                                                                                                                                            |
| `bin/acp-server.ts`                  | ACP stdio entry (`clawo-acp` / `clawo acp`)                                                                                                                                                                                                  |

## Development

```bash
npm run build          # TypeScript compilation (tsc)
npm run lint           # ESLint (src/ and bin/)
npm run format:check   # Prettier check
npm run test           # Vitest unit tests (src/__tests__/)
```

Integration test — a manual smoke test, not part of CI; needs `claude` installed and authenticated:

```bash
npx tsx scripts/test-integration.ts
```

Weekly engine sweep — the measurement half of the weekly check, deterministic, no LLM. Reports
installed / pinned / upstream versions, the flag surface of each core engine against what its
wrapper passes, one live turn per engine, and the ACP + MCP handshakes. Exit 1 on a regression.
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
- **Adding a new tool** — register in `src/index.ts`, add to `openclaw.plugin.json` contracts.tools, document in `skills/references/tools.md`

## Testing

- Unit tests live in `src/__tests__/*.test.ts` (vitest, no external dependencies)
- `scripts/test-integration.ts` is a manual smoke test requiring live CLIs — not part of CI
- Tests are excluded from TypeScript compilation (tsconfig.json exclude) so they don't ship in dist/

## Documentation

All documentation lives in `skills/references/`. This is the **single source of truth** — no `docs/` directory.

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
| Run ledger / cost / spend caps | `skills/references/observability.md`                           |
| Workflow kernel, nodes, resume | `skills/references/workflow.md`                                |
| Acceptance contracts, evidence | `skills/references/verification.md`                            |
| CLI commands                   | `skills/references/cli.md`                                     |
| Setup / prerequisites          | `skills/references/getting-started.md`                         |
| New feature or tool            | Also update `skills/SKILL.md` description for trigger keywords |

Also update:

- **README.md** — if the change affects the feature overview, engine compat table, source tree, or known limitations
- **CHANGELOG.md** — always, for any user-facing change

## PR Guidelines

- Prefix: `feat:`, `fix:`, `docs:`, `chore:`, `test:`
- Run `npm run build && npm run lint && npm run format:check && npm run test` before submitting
- Update CHANGELOG.md for user-facing changes
- Plugin installation requires `--dangerously-force-unsafe-install` (child_process usage)

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

- Engine Compatibility table (test with `claude --version && codex --version && agy --version`)
- Source tree (if files added/removed/renamed)
- Known Limitations (if behavior changed)
- Feature descriptions (if new features added)

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
`publish.yml` upgrades npm to >= 11.5.1 and runs `npm publish --provenance --access public`
with no auth token; credentials come from GitHub OIDC (`id-token: write`) against the Trusted
Publisher configured on npmjs.com (Package → Settings: repo `Enderfga/claw-orchestrator`,
workflow `publish.yml`, no environment). If a publish ever 404s on the PUT, check the Trusted
Publisher config on npmjs.com — it is not a token problem. (Migrated from a 90-day-expiring
`NPM_TOKEN` secret in v4.5.0.)

### 7. Verify

```bash
gh run list --limit 2                          # CI + Publish should both pass
npm view @enderfga/claw-orchestrator version   # should equal X.Y.Z
```

## Engine CLI Reference

Current tested versions (update on each release):

| Engine      | CLI        | Tested Version | Invocation                                                                                                                                                                                                                           |
| ----------- | ---------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Claude      | `claude`   | 2.1.260        | Persistent subprocess, `--output-format stream-json`                                                                                                                                                                                 |
| Codex       | `codex`    | 0.153.2        | `codex exec --sandbox workspace-write --skip-git-repo-check --json -C <dir> [--ephemeral] [--ignore-user-config] [--add-dir D]` (or `codex app-server` for /goal)                                                                    |
| Antigravity | `agy`      | 1.1.25         | `agy -p <msg> --output-format stream-json --log-file <tmp> [--conversation <id>] --dangerously-skip-permissions/--sandbox --print-timeout <n>s`                                                                                      |
| Grok        | `grok`     | 1.0.13         | `grok -p <msg> --output-format json --cwd <dir> [--resume <id>] [--permission-mode M] [--effort E] [--tools/--disallowed-tools] [--json-schema] [--rules]` (read-only refused: a delegated subagent writes through a tool allowlist) |
| OpenCode    | `opencode` | 1.18.27        | `opencode run <msg> --format json [--model provider/model] [--variant E]` (read-only sessions add `--agent clawo-readonly` + `OPENCODE_CONFIG_CONTENT`)                                                                              |

**Important:** When CLI vendors change flags or output format, update the corresponding `persistent-*-session.ts` and re-run integration tests.

See `skills/references/claude-cli-tracking.md` for full sync history.
