# Verification — acceptance contracts and evidence

An **acceptance contract** is a list of checks the runtime executes itself and
whose results it reads. A run that declares one cannot reach `completed` unless
every required check passes. Completion signals that come from an agent or an
engine (consensus votes, a Coder's reported metric, an engine's `ok`) are
recorded, but they are never treated as verification.

## The one rule about where contracts come from

**A contract comes from the caller or from a mode default. Never from agent
output.** If an agent could declare its own checks, we would be back to
self-grading with more steps. Nothing in the kernel reads a contract out of a
node's result, and `normalizeContract()` drops anything it does not recognise, so
a contract that arrived through a tool call carries no fields the executor did
not model.

Concretely: there is no shell string anywhere. A `command` check is argv.

## Check types

| Type          | What it does                                                                | Passes when                                                               |
| ------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `command`     | Runs argv in a directory                                                    | Exit code equals `expectExit` (default 0)                                 |
| `http`        | Polls a URL until the deadline                                              | Status equals `expectStatus` (default 200)                                |
| `screenshot`  | Captures the page at each viewport with headless Chrome and stores the PNGs | Every viewport produced a non-empty image                                 |
| `diff_policy` | Compares the change set against the recorded baseline                       | File count, forbidden paths, and required paths all satisfied             |
| `file`        | Checks a path                                                               | Exists (or is absent when `exists: false`) and matches `matches` if given |

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

Every check has one; the default is 10 minutes. A check that overruns is killed (its whole process group, with SIGKILL)
and recorded as failed with `timedOut: true`.

### What `screenshot` does and does not claim

It captures images and stores them. It does **not** compare pixels, and it is not
visual regression testing. The runtime performs the capture, so the screenshots
are files on disk rather than an agent's claim. Judging the rendering is still a
human's or an agent's job.

Chrome is resolved from `CLAWO_CHROME_BIN`, then the usual macOS app paths, then
`PATH`. A host with no browser fails the check immediately rather than paying the
timeout to find out.

### `diff_policy` and the baseline

`diff_policy` needs to know what the run changed, which needs a baseline. The
kernel records `git rev-parse HEAD` when a run starts and diffs against that.

The change set is **tracked changes ∪ untracked files**. That union matters: a
bare `git diff` lists tracked modifications only, so files an agent _created_ are
invisible to it.

`requirePaths: ["."]` means "the run must have changed something".

## Evidence bundles

Every verifier attempt writes a directory under the run, named
`<node>-v<visit>-<attempt>`. Both counters are in the id because the attempt
counter is per-visit and restarts at 1 each time a loop comes back round — so a
repair loop keeps every pass rather than overwriting the last one:

```
~/.claw-orchestrator/wf/<runId>/evidence/<evidenceId>/
  bundle.json        verdict, per-check results, changed files, base/head SHA
  checks/<id>.log    output tail for each failed check
  diff.patch         the patch the run produced, new files included
  shot-*.png         screenshots, when a screenshot check ran
```

Read one with `clawo verify <runId>`, `GET /workflow/<id>/evidence`, or
`workflow_status` (which returns the id).

Bundle writes are best-effort. The verdict is already decided by the check
results, so a bundle that fails to land loses the record, never the answer.

## Fix-on-red

`fixOnFailureRounds` spawns a repair session against the failing check and then
**re-runs the whole check list**. The fixer's own claim to have fixed it is
ignored; only the re-run decides. Set it to 0 (the default) to disable.

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
  `*.test.*` and `*.spec.*` scripts; `test_*.py`, `*_test.py`, `*_test.go`, `*_spec.rb`,
  `spec/spec_helper.rb`, `spec/rails_helper.rb`, `spec/support/`, `.rspec`;
  `*Test.java`/`.kt`/`.cs`.
- **Counted as test configuration:** vitest/jest/playwright/cypress config (including
  `.json`), `karma.conf.*`, `vitest.setup.*`/`jest.setup.*`/`setupTests.*`,
  `.mocharc*`, `pytest.ini`, `conftest.py`, `tox.ini`, `phpunit.xml`.
- **In a `package.json`:** the `jest`, `mocha`, `ava`, `vitest`, `c8` and `nyc` keys,
  and every script the checks can reach — the `test`, `pretest` and `posttest` scripts,
  any script a contract command runs by name (`npm run verify`), and whatever those run
  in turn through `npm run`, `yarn`, `pnpm`, `run-s`/`run-p`, including their `pre`/`post`
  hooks. Other scripts, dependencies and key order may change.
- **Allowed:** adding test files, packages, and test configuration that governs no test
  the run started with (a new package with its own `jest.config.ts`). New configuration
  in a directory that holds such a test — a `conftest.py` beside existing tests — is
  refuted, since it changes what they do.
- **Not considered:** installed dependencies (`node_modules/`, `vendor/`,
  `site-packages/`, `.venv/`), which ship their own tests and configs.
- **Opting out:** set `"protectTests": false` when changing existing tests is the task.
- **Where it applies:** kernel runs in a git repository with a `command` check that
  protects tests, including a subflow's verifier, which uses its parent run's record.
  The record is taken only for such runs. A run created before this check existed
  reports it as not checked (not required), and so does a verifier running outside the
  recorded repository. `verify_run`, UltraApp's build gate and Autoloop's gate have no
  record of the tree before the work and are not covered.
- **What it does not catch:** tests inside source files (Rust `#[cfg(test)]`), test
  settings inside general config (`vite.config.*`, `pyproject.toml`, `setup.cfg`),
  files hidden by `.gitignore`, and source code that special-cases the test
  environment. It closes the direct route, not every route.

## Per-mode defaults

| Mode                     | Contract          | Notes                                                                                                                                                                  |
| ------------------------ | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **UltraApp**             | **On by default** | Build: `npm install` → `npm run build` → `npm test` → (`docker build`) → **`npm run smoke`**. Deploy: **screenshots at 1440×900 and 375×812** against the live URL.    |
| **Council**              | Caller-declared   | Consensus votes are recorded on the run as advisory and do not decide completion.                                                                                      |
| **Autoloop**             | Not yet exposed   | Library-level only (the dispatcher's `contract` option); `autoloop_start` and the HTTP API do not accept one. See [`autoloop.md`](./autoloop.md#acceptance-contracts). |
| **Fanout / Ultrareview** | Caller-declared   | Per-agent `ok` is the engine's terminal verdict for its turn.                                                                                                          |
| **Plain sessions**       | None              | Use `verify_run` to check work after the fact.                                                                                                                         |

UltraApp's build gate includes `npm run smoke`, and its deploy gate captures
screenshots at 1440×900 and 375×812 against the live URL.

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

## Three outcomes, not two

A run ends `verified`, `refuted`, or `unverified`.

`unverified` means **no contract was declared and nothing checked the work**. It
is not a failure and it is not a pass. `clawo runs` prints it as `—` and
`clawo workflow list` as `unchecked`, and the `clawo runs` summary line says so in
words, because collapsing it into either bucket would let an unchecked run read
as a checked one. A verdict that expired (see below) also reads `unverified`.

## What the guarantee is, precisely

- The checks are run by the runtime, and their exit codes are read by the
  runtime. No part of the verdict is an agent's report about itself.
- A run carrying a contract cannot reach `completed` unless every required check
  passed.
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
