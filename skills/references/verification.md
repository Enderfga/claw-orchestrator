# Verification — acceptance contracts and evidence

An **acceptance contract** is a list of checks the runtime executes itself and
whose results it reads. A run that declares one is judged by its last
verification: it ends `failed` when a required check of that verification fails,
and `completed` / `verified` only when every required check passes.
Completion signals that come from an agent or an engine (consensus votes, a
Coder's reported metric, an engine's `ok`) are recorded, but they are never
treated as verification.

## The one rule about where contracts come from

**A contract comes from the caller or from a mode default. Never from agent
output.** If an agent could declare its own checks, we would be back to
self-grading with more steps. Nothing in the kernel reads a contract out of a
node's result.

The `contract` argument of `workflow_start`, `POST /workflow/new` and `verify_run`
goes through `normalizeContract()`, which drops anything it does not recognise, so
it carries no fields the executor did not model; one with no recognised check is
refused before the run starts. That argument takes each check bare,
`{ "type": "command", … }`, or wrapped, `{ "id"?, "spec": { … }, "required"? }`.
A contract written inside a spec — `spec.contract`, or a verifier's inline
`contract` — is used as written, so its checks must be in the wrapped form.

A workflow start normalises every contract the run carries the same way: the
`contract` start option, the spec's own `contract`, and each verifier node's
inline `contract`. A check may be written bare (`{ "type": "command", "cmd": … }`)
or wrapped (`{ "spec": { … }, "required": … }`) in any of them. A contract in
which no check is recognised is refused at start rather than dropped.

Concretely: there is no shell string anywhere. A `command` check is argv.

## Check types

| Type          | Fields                                                                        | What it does                                                                | Passes when                                                                                                       |
| ------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `command`     | `cmd`, `args`, `cwd`, `expectExit`, `timeoutMs`                               | Runs argv in a directory (`cwd` is relative to where the checks run)        | Exit code equals `expectExit` (default 0)                                                                         |
| `http`        | `url`, `expectStatus`, `timeoutMs`, `intervalMs`                              | GETs a URL every `intervalMs` (default 1 s) until the deadline              | Status equals `expectStatus` (default 200)                                                                        |
| `screenshot`  | `url`, `viewports` (`[{ width, height, label? }]`), `browserBin`, `timeoutMs` | Captures the page at each viewport with headless Chrome and stores the PNGs | Every viewport produced a non-empty image                                                                         |
| `diff_policy` | `maxFiles`, `forbidPaths`, `requirePaths`                                     | Compares the change set against the recorded baseline                       | At most `maxFiles` files changed, none under a `forbidPaths` entry, and at least one under a `requirePaths` entry |
| `file`        | `path`, `exists`, `matches`                                                   | Checks a path, relative to where the checks run                             | Exists (or is absent when `exists: false`) and, if `matches` is given, its contents match that regex              |

Each check may also carry an `id` (default `<type>-<n>`, used in the evidence) and
`required`. The contract itself is `{ id?, checks, fixOnFailureRounds?,
protectTests? }`. `forbidPaths` and `requirePaths` are path prefixes matched by
whole segments (`src` covers `src/a.ts`, not `srcfoo/a.ts`), not globs.

As the `contract` argument of `workflow_start` or `verify_run`:

```jsonc
{
  "id": "ship-it",
  "fixOnFailureRounds": 2,
  "checks": [
    { "type": "command", "cmd": "npm", "args": ["run", "build"], "timeoutMs": 600000 },
    { "type": "command", "cmd": "npm", "args": ["test"] },
    { "type": "command", "cmd": "npm", "args": ["run", "lint"], "required": false },
    { "type": "diff_policy", "forbidPaths": ["configs", ".github"], "maxFiles": 40 },
  ],
}
```

### `required`

Default true. A failing non-required check is recorded in the evidence bundle but
does not refute the run — use it for signals you want visible without making them
blocking.

### Timeouts

`timeoutMs` defaults to 10 minutes for a `command` check, 30 seconds for an `http`
check, and 60 seconds per viewport for a `screenshot`. A command or browser that
overruns is killed (its whole process group, with SIGKILL); an overrunning command,
and an `http` check that never saw the expected status, are recorded as failed with
`timedOut: true`. `diff_policy` and `file` take no `timeoutMs`.

### What `screenshot` does and does not claim

It captures images and stores them. It does **not** compare pixels, and it is not
visual regression testing. The runtime performs the capture, so the screenshots
are files on disk rather than an agent's claim. Judging the rendering is still a
human's or an agent's job.

Chrome is resolved from the check's `browserBin`, then `CLAWO_CHROME_BIN`, then
the usual macOS app paths, then `PATH`. A host with no browser fails the check
immediately rather than paying the timeout to find out.

### `diff_policy` and the baseline

`diff_policy` needs to know what the run changed, which needs a baseline. The
kernel records `git rev-parse HEAD` when a run starts and diffs against that.
`verify_run` takes the baseline as `baseSha`; without one, `diff_policy` sees
untracked files only.

The change set is **tracked changes ∪ untracked files**: `git diff <base>` (so
commits made during the run count too) plus every untracked file that
`.gitignore` does not exclude. That union matters: a bare `git diff` lists tracked
modifications only, so files an agent _created_ are invisible to it.

`requirePaths: ["."]` means "the run must have changed something".

## Evidence bundles

Every verifier attempt writes a directory under the run, named
`<node>-v<visit>-<attempt>` with both counters zero-padded (`verify-v02-01`,
`__verify-v01-01`). Both counters are in the id because the attempt counter is
per-visit and restarts at 1 each time a loop comes back round — so a repair loop
keeps every pass rather than overwriting the last one. Fix-on-red rounds inside one
attempt share its bundle, which records how many were used:

```
~/.claw-orchestrator/wf/<runId>/evidence/<evidenceId>/
  bundle.json        verdict, per-check results, fix rounds, changed files,
                     base/head SHA, tree digest
  checks/<id>.log    output tail for each failed check
  diff.patch         the patch the run produced, new files included
  shot-<label>.png   screenshots, when a screenshot check ran
```

A failed command's tail is the last 200 lines of its stderr, or of its stdout when
stderr is empty; a failed `diff_policy` logs the change set it judged.

Read one with `clawo verify <runId>` (`--evidence <id>` for an earlier bundle) or
`GET /workflow/<id>/evidence` (`?evidenceId=`); without an id both return the
bundle behind the run's current verdict, whose id `workflow_status` reports.

Bundle writes are best-effort. The verdict is already decided by the check
results, so a bundle that fails to land loses the record, never the answer.

## Fix-on-red

`fixOnFailureRounds` spawns a repair session against the failing check and then
**re-runs the whole check list**. The fixer's own claim to have fixed it is
ignored; only the re-run decides. Set it to 0 (the default) to disable.

Each round's fixer is a session in the checks' directory, with
`bypassPermissions`, given the first failing required check and its output tail,
framed as data. Fix-on-red runs only inside a workflow's verifier node:
`verify_run` runs the checks once and ignores the field.

## Protected tests

A `command` check runs in the tree the agent just worked in, so an agent could make
it pass by changing the test instead of the code: loosen an assertion, delete the
test, or point `scripts.test` at something that exits 0. A kernel run therefore
records every test file and test configuration in its repository **when it starts**,
and before the checks run, each must still be as recorded. A difference refutes the
run through the required check `protected-tests`, which is recorded in the bundle
whether it passed or not and runs again before every fixer round.

- **Before the checks, not after:** it judges the tree the agent handed over, so a
  test command that rewrites the file back cannot hide the change.
- **As the run found them:** a developer's uncommitted edits, and a new test not yet
  committed, are recorded in that state and stay protected in it — writing a failing
  test and handing the fix to an agent works. A project with no commits yet is covered.
- **Compared by bytes, not through git:** file contents are hashed directly (a
  symlink by its target), so the index, git attributes and filters, line-ending
  conversion and path quoting have no say.
- **Counted as tests:** files under `__tests__/`, `__snapshots__/`, `test/`, `tests/`;
  JavaScript and TypeScript `*.test.*` and `*.spec.*` files; `test_*.py`, `*_test.py`,
  `*_test.go`, `*_spec.rb`, `spec/spec_helper.rb`, `spec/rails_helper.rb`,
  `spec/support/`; `*Test` and `*Tests` files in `.java`, `.kt` and `.cs`.
- **Counted as test configuration:** vitest/jest/playwright/cypress config (including
  `.json`), `vitest.workspace.*`, `karma.conf.*`, `vitest.setup.*`/`jest.setup.*`/
  `setupTests.*`, `.mocharc*`, `.rspec`, `pytest.ini`, `conftest.py`, `tox.ini`,
  `phpunit.xml` and `phpunit.xml.dist`.
- **In a `package.json`:** the `jest`, `mocha`, `ava`, `vitest`, `c8` and `nyc` keys,
  and every script the checks can reach — `test`, `pretest`, `posttest` and any
  `test:*` script (with its `pre`/`post` forms), any script a contract command runs by
  name (`npm run verify`), and whatever those run in turn through `npm run`, `yarn`,
  `pnpm`, `bun`, `npm-run-all` or `run-s`/`run-p`, including their `pre`/`post` hooks.
  Other scripts, dependencies and key order may change.
- **Allowed:** adding test files, packages, and test configuration that governs no test
  the run started with (a new package with its own `jest.config.ts`). New configuration
  in a directory at or above such a test — a `conftest.py` beside existing tests — is
  refuted, since it changes what they do.
- **Not considered:** installed dependencies (`node_modules/`, `vendor/`,
  `site-packages/`, `.venv/`), which ship their own tests and configs.
- **Opting out:** set `"protectTests": false` when changing existing tests is the task.
- **Where it applies:** kernel runs in a git repository with a `command` check that
  protects tests, including a subflow's verifier, which uses its parent run's record.
  The record is taken only for such runs and for runs with a `subflow` node. A run in
  a repository that has no record (created before this check existed, or one git could
  not list) reports it as not checked (not required), and so does a verifier running
  outside the recorded repository. `verify_run`, UltraApp's build gate and Autoloop's
  gate have no record of the tree before the work and are not covered.
- **What it does not catch:** tests inside source files (Rust `#[cfg(test)]`), test
  settings inside general config (`vite.config.*`, `pyproject.toml`, `setup.cfg`),
  files hidden by `.gitignore`, and source code that special-cases the test
  environment. It closes the direct route, not every route.

## Per-mode defaults

| Mode                        | Contract          | Notes                                                                                                                                                                                               |
| --------------------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **UltraApp**                | **On by default** | Build: `npm install` → `npm run build` → `npm test` → (`docker build`) → **`npm run smoke`**, with up to 5 fix-on-red rounds. Deploy: **screenshots at 1440×900 and 375×812** against the live URL. |
| **`solve` / `goal`**        | Caller-declared   | `workflow_start`'s `contract`, or `--check` / `--contract` on `clawo solve` and `clawo goal`. Without one the `verify` node passes through and the run ends `unverified`.                           |
| **Council**                 | Caller-declared   | Through `workflow_start` (`template: "council"` or a spec); `council_start` takes none. Consensus votes are recorded on the run as advisory and do not decide completion.                           |
| **Fanout**                  | Caller-declared   | Through `workflow_start` (`template: "fanout"` or a spec) or `clawo fanout --check`; `fanout_start` takes none. Per-agent `ok` is the engine's terminal verdict for its turn.                       |
| **Ultrareview / Ultraplan** | None              | `ultrareview_start` and `ultraplan_start` take no contract.                                                                                                                                         |
| **Autoloop**                | Not yet exposed   | Library-level only (the dispatcher's `contract` option); `autoloop_start` and the HTTP API do not accept one. See [`autoloop.md`](./autoloop.md#acceptance-contracts).                              |
| **Plain sessions**          | None              | Use `verify_run` to check work after the fact.                                                                                                                                                      |

The visual gate is **advisory by default** so that a host without Chrome does not
lose a working app to a missing browser. Set
`CLAWO_ULTRAAPP_VISUAL_GATE=strict` to make a failed capture block the deploy.

## Verifying work that did not come through a workflow

```bash
# Tool
verify_run({ cwd: "/repo", contract: { checks: [{ type: "command", cmd: "npm", args: ["test"] }] } })
```

Use it for a plain `session_send` that edited a repo, or for anything from an
older version. The contract is yours; nothing is read from agent output.

`verify_run` is a tool (plugin and MCP); it has no HTTP route or CLI command. It
runs the checks once — no fix-on-red, no protected-tests check — and returns the
bundle. Pass `baseSha` so `diff_policy` sees tracked changes, and `label` to name
the stored evidence: the bundle is written to
`~/.claw-orchestrator/wf/<label>/evidence/verify-01/`, and `clawo verify <label>`
reads it back. A later call with the same label writes over it. It writes no ledger
row and starts no workflow run.

## Three outcomes, not two

A run ends `verified`, `refuted`, or `unverified`.

`unverified` means **no contract was declared and nothing checked the work**. It
is not a failure and it is not a pass. `clawo runs` prints it as `—` and
`clawo workflow list` as `unchecked`, and the `clawo runs` summary line says so in
words, because collapsing it into either bucket would let an unchecked run read
as a checked one. A verdict that expired (see below) also reads `unverified`, and
so does a run that declared a contract and ended without running it — that run
ends `failed`.

## What the guarantee is, precisely

- The checks are run by the runtime, and their exit codes are read by the
  runtime. No part of the verdict is an agent's report about itself.
- A run whose verdict is `refuted` ends `failed`, never `completed`, and a run
  ends `completed` / `verified` only when every required check of its last
  verification passed. A run-level contract appends the terminal verifier
  `__verify`, which every completed run passes through; a spec that places its own
  `"contract": "run"` verifier has to route every path through it — a run that a
  router steered past it ends `failed` (outcome `unverified`), see
  [`workflow.md`](./workflow.md#completion).
- If anything that can touch the workspace runs after the checks and the tree's
  **content** changes, the verdict expires: the outcome drops to `unverified`
  with the reason recorded. Not `refuted` — no check failed.
- Outside a git repository the digest is unavailable. Nothing running after the
  checks means the verdict stands; something running after it means we decline
  to vouch, and the run says so.
- If an abandoned attempt (a node past its timeout, which cannot be killed) is
  still running when the run ends, the outcome is `unverified` with the reason
  recorded. The runtime will not vouch for a tree something may still be writing
  to.

What it is **not**: a promise that nothing can touch the tree after a run ends.
A node past its timeout keeps running, and if it outlives the short settle
window its writes land after the last digest — the run will have said
`unverified`, but the file is still changed. Give such nodes a timeout they will
not hit, or make their writes safe to arrive late.

## Related

- [`workflow.md`](./workflow.md) — the kernel that runs verifiers as nodes
- [`observability.md`](./observability.md) — how verdicts reach the run ledger
- [`ultraapp.md`](./ultraapp.md) — the default contract in context
