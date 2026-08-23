# Verification — acceptance contracts and evidence

Before 6.0.0, nothing in this runtime ever checked an agent's work. Every
"finished" signal was the agent grading itself:

- **Council** terminated when a regex found `[CONSENSUS: YES]` in agent prose.
- **Autoloop**'s `eval_output` was whatever the Coder passed to a tool call, and
  the Reviewer that was supposed to catch fabrication had a sandbox containing
  the iteration's artifacts and no code, so it could not re-derive anything.
- **UltraApp**'s frontend gate was a sentence in a persona string telling agents
  to capture screenshots. There was no screenshot code anywhere in the project.
- The run ledger's `ok` was the engine's report on its own turn.

An **acceptance contract** is the opposite of all of that: a list of checks the
runtime executes and whose results it reads. A run that declares one cannot reach
`completed` unless every required check passes.

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

(The predecessor of this module, `ultraapp/fix-on-failure.ts`, declared a
`required` field on its steps and never read it: every step was fatal. It is
honoured now.)

### Timeouts

Every check has one, and the default is 10 minutes. This is not cosmetic — the
old pipeline had no timeout at all, so a wedged `npm test` hung the build
forever. A check that overruns is killed (its whole process group, with SIGKILL)
and recorded as failed with `timedOut: true`.

### What `screenshot` does and does not claim

It captures images and stores them. It does **not** compare pixels, and it is not
visual regression testing. What changed in 6.0.0 is that the capture is performed
by the runtime rather than requested of an agent — so "did anyone actually look"
stops being a claim and starts being a file on disk. Judging the rendering is
still a human's or an agent's job.

Chrome is resolved from `CLAWO_CHROME_BIN`, then the usual macOS app paths, then
`PATH`. A host with no browser fails the check immediately rather than paying the
timeout to find out.

### `diff_policy` and the baseline

`diff_policy` needs to know what the run changed, which needs a baseline. The
kernel records `git rev-parse HEAD` when a run starts and diffs against that.

The change set is **tracked changes ∪ untracked files**. That union matters: a
bare `git diff` lists tracked modifications only, so files an agent _created_ are
invisible to it — which is exactly how `autoloop`'s per-iteration `diff.patch`
used to miss every new file while `git add -A` committed them anyway.

`requirePaths: ["."]` means "the run must have changed something".

## Evidence bundles

Every verifier attempt writes a directory under the run:

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

## Per-mode defaults

| Mode                     | Contract          | Notes                                                                                                                                                       |
| ------------------------ | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **UltraApp**             | **On by default** | Build: `npm install` → `npm run build` → `npm test` → (`docker build`) → **`npm run smoke`**. Deploy: **both §7g viewports captured** against the live URL. |
| **Council**              | Caller-declared   | Consensus votes are recorded on the run as advisory and no longer decide completion.                                                                        |
| **Autoloop**             | Caller-declared   | With a contract, a Reviewer `advance` is held unless the checks pass; passing also fires `on_target_hit`.                                                   |
| **Fanout / Ultrareview** | Caller-declared   | Per-agent `ok` now reads the engine's terminal verdict rather than "the call did not throw".                                                                |
| **Plain sessions**       | None              | Use `verify_run` to check work after the fact.                                                                                                              |

Two of UltraApp's defaults close claims the project had been making without
backing them:

- `conventions.ts` §4 told every council that `npm run smoke` gated build
  success. It was not in the step list at all. It is now.
- `ultraapp.md` recorded, as a known limitation since 4.0.0, that the §7g gate
  "relies on per-agent honesty about running the screenshot capture", with a
  server-side validator promised as a follow-up. That follow-up is this release.

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
is not a failure and it is not a pass. The CLI prints it as `—` and the summary
line says so in words, because collapsing it into either bucket would let an
unchecked run read as a checked one.

## Related

- [`workflow.md`](./workflow.md) — the kernel that runs verifiers as nodes
- [`observability.md`](./observability.md) — how verdicts reach the run ledger
- [`ultraapp.md`](./ultraapp.md) — the default contract in context

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
