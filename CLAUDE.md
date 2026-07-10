# CLAUDE.md — claw-orchestrator

This file provides context for Claude Code when working on this project.

## Architecture

Claw Orchestrator wraps coding CLIs (Claude Code, Codex, Gemini, Cursor Agent, plus
arbitrary custom CLIs) into a managed, programmable session layer for claw-style
agent systems. Runs as a standalone CLI/server, with first-class OpenClaw plugin
support. Key source files:

| File | Purpose |
|------|---------|
| `src/index.ts` | Plugin entry — registers all 63 canonical tools |
| `src/session-manager.ts` | Core orchestrator — session lifecycle, council, ultraplan/ultrareview |
| `src/base-oneshot-session.ts` | Abstract base class for one-shot (process-per-send) engines |
| `src/persistent-session.ts` | Claude Code CLI wrapper (spawn, JSON protocol, stream parsing) |
| `src/persistent-codex-session.ts` | Codex CLI wrapper (`codex exec --full-auto`) |
| `src/persistent-gemini-session.ts` | Gemini CLI wrapper (`gemini -p --output-format stream-json`) |
| `src/persistent-agy-session.ts` | Google Antigravity CLI wrapper (`agy -p`, plain text, log-harvested conversation resume) |
| `src/persistent-cursor-session.ts` | Cursor Agent CLI wrapper (`agent -p --force --output-format stream-json`) |
| `src/persistent-opencode-session.ts` | sst/opencode CLI wrapper (`opencode run --format json`) |
| `src/persistent-custom-session.ts` | Custom engine — any CLI via user-provided `CustomEngineConfig` |
| `src/council.ts` | Multi-agent collaboration engine with git worktree isolation and post-processing |
| `src/consensus.ts` | Consensus voting parser for council |
| `src/models.ts` | Centralized model registry — pricing, aliases, engine/provider mapping |
| `src/types.ts` | Shared types, interfaces; re-exports from `models.ts` |
| `src/logger.ts` | Structured `Logger` interface + console implementation |
| `src/circuit-breaker.ts` | Engine failure tracking with exponential backoff |
| `src/inbox-manager.ts` | Cross-session messaging (inbox) manager |
| `src/embedded-server.ts` | HTTP server for standalone/CLI usage |
| `src/openai-compat.ts` | OpenAI-compatible `/v1/chat/completions` endpoint |
| `src/proxy/` | Multi-model proxy (Gemini, GPT via Anthropic format translation) |
| `bin/cli.ts` | CLI entry point (commander-based) |

## Development

```bash
npm run build          # TypeScript compilation (tsc)
npm run lint           # ESLint (src/ and bin/)
npm run format:check   # Prettier check
npm run test           # Vitest unit tests (src/__tests__/)
```

Integration test (requires all 3 CLIs installed and authenticated):
```bash
npx tsx scripts/test-integration.ts
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

| What changed | Update |
|---|---|
| Tool parameters or behavior | `skills/references/tools.md` |
| Engine invocation / flags | `skills/references/multi-engine.md` |
| Session lifecycle | `skills/references/sessions.md` |
| Council protocol | `skills/references/council.md` |
| Inbox messaging | `skills/references/inbox.md` |
| Ultraplan/Ultrareview | `skills/references/ultra.md` |
| CLI commands | `skills/references/cli.md` |
| Setup / prerequisites | `skills/references/getting-started.md` |
| New feature or tool | Also update `skills/SKILL.md` description for trigger keywords |

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
- Engine Compatibility table (test with `claude --version && codex --version && gemini --version`)
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

| Engine | CLI | Tested Version | Invocation |
|--------|-----|---------------|------------|
| Claude | `claude` | 2.1.199 | Persistent subprocess, `--output-format stream-json` |
| Codex | `codex` | 0.142.4 | `codex exec --sandbox workspace-write --skip-git-repo-check --json -C <dir>` (or `codex app-server --listen stdio://` for /goal) |
| Gemini | `gemini` | 0.43.0 | `gemini -p <msg> --output-format stream-json --skip-trust --yolo/--sandbox` |
| Antigravity | `agy` | 1.0.16 | `agy -p <msg> --log-file <tmp> [--conversation <id>] --dangerously-skip-permissions/--sandbox --print-timeout <n>s` |
| Cursor | `agent` | 2026.03.30 | `agent -p <msg> --force --trust --output-format stream-json --workspace <dir>` |
| OpenCode | `opencode` | 1.1.40 | `opencode run <msg> --format json [--model provider/model]` |

**Important:** When CLI vendors change flags or output format, update the corresponding `persistent-*-session.ts` and re-run integration tests.

See `skills/references/claude-cli-tracking.md` for full sync history.
