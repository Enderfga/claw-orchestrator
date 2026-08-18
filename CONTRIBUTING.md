# Contributing to Claw Orchestrator

## Dev Environment Setup

```bash
git clone https://github.com/Enderfga/claw-orchestrator.git
cd claw-orchestrator
npm install
npm run build
```

No coding CLI is needed to build the project or run the unit tests.

## Running Tests

CI runs these four on Node 22 and 24. **All four must pass before a PR can be merged**, so
run them before pushing rather than discovering it in review:

```bash
npm run build          # rm -rf dist && tsc
npm run lint           # eslint src/ bin/
npm run format:check   # prettier --check
npm run test           # vitest
```

`npm run lint:fix` and `npm run format` fix most of what the middle two report.

There is also a manual smoke test that spawns the real Claude Code CLI. It is not part of CI,
and it needs `claude` installed and authenticated:

```bash
npm install -g @anthropic-ai/claude-code
npx tsx scripts/test-integration.ts
```

## Code Style

- TypeScript with full types — no `any`
- ESM modules (`"type": "module"`)
- Follow existing patterns in `src/`
- No formatting changes to files you didn't modify

## PR Guidelines

- **One feature or fix per PR**
- Use a descriptive title: `feat:`, `fix:`, `docs:`, `chore:`
- Include a clear description of what changed and why
- Run the four commands above before submitting — a red CI blocks the merge
- A maintainer approval is required to merge; passing CI on its own does not merge a PR
- Update `CHANGELOG.md` for user-facing changes

## Documentation

`skills/references/` is the single source of truth — there is no `docs/` directory. A PR that
changes behaviour updates the matching reference file in the same PR:

| What changed | Update |
| --- | --- |
| Tool parameters or behaviour | `skills/references/tools.md` |
| Engine invocation or flags | `skills/references/multi-engine.md` |
| Session lifecycle | `skills/references/sessions.md` |
| Council, inbox, ACP, autoloop, ultra*, CLI, dashboard | the matching file in `skills/references/` |

Also update `README.md` if the change moves the feature overview, the engine compatibility
table, or the source tree.

## Issue Guidelines

- Search existing issues before opening a new one
- Use the provided templates (bug report / feature request)
- Include OpenClaw version, Node.js version, and plugin version
- Redact any sensitive info from logs
