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

## Contributing an engine

Engines sit in one of three tiers, and the line between them is verification —
not code quality, and not how good the model is.

| Tier          | Who maintains it | What this project claims                                                                                              |
| ------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------- |
| **core**      | Maintainers      | Wrapped in `src/persistent-*-session.ts`, exercised with a live turn every week, pinned to a version someone here ran |
| **community** | You              | The schema is validated and the preset is shipped. Whether it runs is *your* dated, attributable claim                |
| **legacy**    | —                | Still wired, no longer tracked                                                                                        |

Core requires that a maintainer can obtain and run the binary, because that tier
promises a weekly live exercise and a tested version pin. Most interesting CLIs
are gated behind credentials this project does not hold, which is what the
community tier is for.

### Which shape is yours?

**A — preset only.** Your CLI already speaks something `CustomEngineConfig` can
describe: a print/non-interactive flag, text or JSON on stdout, optionally a
resume flag. Your contribution is one JSON file in `configs/engines/`. No code.

**B — adapter in your package, preset here.** Your CLI speaks its own wire
protocol. Write the translation as a binary in *your own* npm package and point
the preset's `bin` at it. Keeping it there is what lets this project ship the
preset without owning a protocol it cannot test; `@enderfga/dsh-clawo` is the
existing example of that split.

Do not open a PR that puts protocol translation for an untestable engine into
`src/`. It will be declined for the reason above, not for its quality.

### The smoke record

A preset is accepted on a falsifiable claim, so `provenance` must carry one.
Run two turns through the local `clawo-mcp` server and link the captured input
and output. Give `session_start.customEngine` the `engine` object from your draft
preset, not the outer preset object:

```text
session_start({
  name: "preset-smoke",
  cwd: "<workspace>",
  engine: "custom",
  customEngine: <the draft preset's engine object>
})

session_send({
  name: "preset-smoke",
  message: "Remember the number 4173. Reply with just OK."
})

session_send({
  name: "preset-smoke",
  message: "What number did I ask you to remember?"
}) // must answer 4173

session_stop({ name: "preset-smoke" })
```

Do not send a custom-engine object through `clawo session-start`. That command
uses the HTTP control plane, which deliberately rejects executable-bearing
`customEngine` values; only a local caller such as the MCP tool or
`SessionManager` API may configure one. See [MCP Server](skills/references/mcp.md)
for host setup.

Record the engine version separately:

```bash
my-engine --version
```

Paste both into a gist and put its URL in `provenance.smokeUrl`, the engine
version in `provenance.verifiedAgainst`, and the date in `provenance.verifiedOn`.

Nobody here will reproduce that run — that is the honest position, not a
loophole. It is dated, attributed and checkable by anyone who does hold the
credentials, which is what makes it worth more than an assurance.

### What CI checks

Schema only, because schema is all that can be checked without your engine's
credentials: id shape and filename match, tier, a complete provenance block with
an ISO date, and an `engine` block with a non-absolute `bin`. A preset that
passes CI has not been shown to work.

## Issue Guidelines

- Search existing issues before opening a new one
- Use the provided templates (bug report / feature request)
- Include OpenClaw version, Node.js version, and plugin version
- Redact any sensitive info from logs
