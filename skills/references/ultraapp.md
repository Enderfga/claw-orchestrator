# ultraapp — Reference

Turn a structured Q&A interview into a deployed web app reachable at
`localhost:19000/forge/<slug>/`. The dashboard's **Forge** tab and a
14-tool MCP surface drive the end-to-end loop: interview → 3-agent
council → fix-on-failure → deploy → done-mode feedback.

This page is the operator reference. The interview behavioural contract
lives in [`skills/ultraapp/SKILL.md`](../ultraapp/SKILL.md). The
council architectural conventions every generated app must satisfy live
in [`src/ultraapp/conventions.ts`](https://github.com/Enderfga/claw-orchestrator/blob/main/src/ultraapp/conventions.ts).

## When to use

- You have a workflow in your head (or a sample input file) and want a
  shareable web app for it without writing code.
- You want to iterate cosmetically on a deployed app via chat ("make
  the button green", "shrink the hero h1") without touching the
  codebase yourself.
- You want to evolve the AppSpec ("also output a thumbnail") and
  rebuild without restarting the interview.

## Lifecycle

```text
interview ─► queued ─► building ─► build-complete ─► deploying ─► done
                                                                    │
                                                                    ▼
                                                              done-mode chat
                                                              (cosmetic /
                                                               spec-delta /
                                                               structural)
```

| Mode             | Meaning                                                                            |
| ---------------- | ---------------------------------------------------------------------------------- |
| `interview`      | AppSpec being filled by Q&A. Chat input goes to the interview agent (Claude Opus). |
| `queued`         | Build accepted, waiting for a slot in the FIFO build queue.                        |
| `building`       | Council writing code, fix-on-failure driving install/build/test.                   |
| `build-complete` | Codebase ready. The resting state when no router is wired (see Runtime modes).     |
| `deploying`      | Container/process being started, router map being updated.                         |
| `done`           | App live at `/forge/<slug>/`. Chat input now goes to the done-mode classifier.     |
| `failed`         | Council didn't reach consensus, or fix-on-failure couldn't get the build green.    |
| `cancelled`      | The build was cancelled (`build/cancel` or `ultraapp_build_cancel`).               |

### The build is a workflow run

Everything from `building` onward is a run on the durable kernel — the same one
`council_start`, `fanout_start` and `autoloop_start` use. The workflow has three
nodes (two when no router is wired — there is then nowhere to deploy):

| Node     | Kind              | Does                                                         |
| -------- | ----------------- | ------------------------------------------------------------ |
| `synth`  | `ultraapp_synth`  | The 3-agent council; snapshots consensus into `versions/vN/` |
| `build`  | `verifier`        | The build contract, with its fix-on-red loop and evidence    |
| `deploy` | `ultraapp_deploy` | Starts the app, registers the route, runs the §7g gate       |

Three consequences worth knowing:

- The run is listed by `workflow_list` and `clawo workflow list`, and shows up in
  the dashboard's Runs tab, under the id `ultraapp-<run_id>`.
- **A crash between stages does not redo the stage before it.** A build that died
  after the council resumes into the build stage rather than paying for the
  council twice.
- The mode column above is a **projection** of that run's state, not a second
  state machine. `interview` and `queued` are the exception — nothing is running
  yet, so there is no run to project from.

The interview and the done-mode conversation are deliberately not workflows.
They are user-driven and open-ended, with no predetermined sequence of steps;
a workflow expressing them would be a router self-loop or a single node with a
state machine hidden inside it.

## Architectural conventions (§1–§7)

Every generated app MUST satisfy these. They're embedded in the council
super-task prompt verbatim from [`src/ultraapp/conventions.ts`](https://github.com/Enderfga/claw-orchestrator/blob/main/src/ultraapp/conventions.ts).

| §   | Topic                    | Headline rule                                                                                                                                                                                                          |
| --- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Path-based deploy        | Mount at `BASE_PATH=/forge/<slug>/`; in-app links MUST be relative.                                                                                                                                                    |
| 2   | Async file-queue runtime | Exact endpoints: `GET /`, `POST /run`, `GET /status/:jobId`, `GET /result/:jobId`, `GET /health`. File-based job queue under `$DATA_DIR/jobs/<jobId>/`. NO database. Data path from `process.env.DATA_DIR ?? '/data'`. |
| 3   | BYOK                     | If `runtime.needsLLM`, API keys live in browser localStorage and are sent direct to the provider. The server MUST NEVER receive the key (enforced by `eslint-plugin-no-server-keys`).                                  |
| 4   | Dockerfile + smoke test  | Single multi-stage Dockerfile, `npm run smoke` drives one full job in < 90s using `examples[0].ref`.                                                                                                                   |
| 5   | Council voting protocol  | 3 agents in git worktrees, all-YES vote required, max 8 rounds.                                                                                                                                                        |
| 6   | Tech stack               | Modern TypeScript / JavaScript framework (Next.js, Vite + Hono, SvelteKit). NO Python, NO pure SSGs.                                                                                                                   |
| 7   | Frontend quality         | Real styling + type hierarchy, full async-state coverage, drag-and-drop forms, one deliberate theme; §7g screenshot gate (below).                                                                                      |

**§7g:** every agent captures headless-Chrome screenshots at 1440×900 and
375×812 and inspects them before voting YES; reading source code is not
accepted as evidence.

## Runtime modes

```bash
clawo serve --ultraapp-runtime host    # default
clawo serve --ultraapp-runtime docker  # opt-in
```

| Mode     | Build                          | Run                                         | Pros                                                      | Cons                                                 |
| -------- | ------------------------------ | ------------------------------------------- | --------------------------------------------------------- | ---------------------------------------------------- |
| `host`   | `npm install && npm run build` | `npm start` (detached, `setsid`-equivalent) | Zero extra deps; works anywhere Node works; faster start. | No process isolation; deps installed under the user. |
| `docker` | `docker build .`               | `docker run -d --restart unless-stopped`    | Per-app isolation, restart policy, image is the artefact. | Requires a running Docker daemon.                    |

Both modes allocate a backend port in `[19100, 19999]`. The reverse-
proxy router runs at port `19000` (auto-fallback up to `19099` if
taken) and maps `/forge/<slug>/*` to the right backend. Slug→port map
persists to `~/.claw-orchestrator/ultraapps/_router.json`. Host-mode pid metadata
persists to `~/.claw-orchestrator/host-procs.json`.

The router is started by `clawo serve`. The OpenClaw plugin does not start one,
and `clawo serve` runs without one when the router cannot start (for example,
no free port in `19000`–`19099`): builds then stop at `build-complete` and are
not deployed.

## File layout (per run)

```text
~/.claw-orchestrator/ultraapps/<runId>/
├── spec.json                  # current AppSpec (latest)
├── spec.history.jsonl         # the full spec after every write (interview update_spec or manual edit)
├── chat.jsonl                 # all chat turns (interview + done-mode)
├── state.json                 # { runId, mode, createdAt, updatedAt, failure? }
├── examples/                  # uploaded sample files
├── data/                      # passed to host-mode app as DATA_DIR
├── evidence/deploy-01/        # deploy-stage evidence (see Acceptance contract)
├── council-project/           # fresh git repo the council collaborates in
│   ├── .worktrees/{agent-A,agent-B,agent-C}/
│   └── (council code, merged to main on consensus)
└── versions/
    ├── v1/
    │   ├── codebase/          # snapshot of council main HEAD, its own git repo
    │   └── artifact.json      # { worktreePath, builtAt, deploy: { url, port, … }, deployedAt }
    └── v2/                    # each build and each successful patch takes the next vN
```

Every version keeps its own `codebase/`, so any of them can be promoted. The live
version is the one most recently deployed or promoted; `start`, `stop` and the
patcher act on it.

Run ids have the form `ua-<timestamp>-<hex>`. The build queue
(`build-queue.json`) and the router map (`_router.json`) sit beside the run
directories, in `~/.claw-orchestrator/ultraapps/`. A run is read back from its
directory on first use, so every route works on a run started before the
orchestrator restarted; its interview session is restarted by name on the run's
next turn, which resumes the persisted conversation.

## HTTP routes (drive headlessly)

All routes are served by the embedded server (default `:18796`), under
`Authorization: Bearer <token>` from `~/.openclaw/server-token`. Request bodies
are JSON (`Content-Type: application/json`) and capped at 5 MB.

| Method + path                         | Purpose                                                                                                                                |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /ultraapp/list`                  | All runs (runId, title, mode, createdAt, updatedAt), newest first.                                                                     |
| `POST /ultraapp/new`                  | No body. Returns `{ runId }`.                                                                                                          |
| `GET /ultraapp/<id>`                  | Full snapshot: spec + chat + state.                                                                                                    |
| `POST /ultraapp/<id>/answer`          | Body: `{ value, freeform? }`. Submit interview answer.                                                                                 |
| `POST /ultraapp/<id>/spec-edit`       | Body: `{ patch: [...] }` (RFC 6902 ops). Edit the spec mid-interview.                                                                  |
| `POST /ultraapp/<id>/files`           | Add an example file: body `{ filename, dataB64 }` or `{ absolutePath }` (below).                                                       |
| `GET /ultraapp/<id>/events`           | SSE stream of `ultraapp` events: questions, spec updates, chat, completeness, interview completion, build events, the app URL, errors. |
| `POST /ultraapp/<id>/build`           | Validate spec strictly + enqueue.                                                                                                      |
| `POST /ultraapp/<id>/build/cancel`    | Cancel a queued or in-flight build.                                                                                                    |
| `GET /ultraapp/<id>/artifacts`        | List `versions/vN/`.                                                                                                                   |
| `POST /ultraapp/<id>/start`           | Start the deployed container/process of the live version and re-register its route.                                                    |
| `POST /ultraapp/<id>/stop`            | Stop without deleting; the route is deregistered until `start`.                                                                        |
| `POST /ultraapp/<id>/delete`          | Stop every deployed version, remove the images, and delete all per-run state.                                                          |
| `POST /ultraapp/<id>/feedback`        | Body: `{ text }`. Done-mode classifier routes cosmetic / spec-delta / structural.                                                      |
| `POST /ultraapp/<id>/promote-version` | Body: `{ version: "vN" }`. Make that version live, deploying it first if it never was.                                                 |

`files` with `{ filename, dataB64 }` copies an upload into `examples/`; an upload
may be up to 100 MiB, and this route accepts a body sized for its base64 text
(every other route caps bodies at 5 MiB). With `{ absolutePath }` it references a file
on the server host in place; the path must be under `$HOME` or `/tmp`, with no
dotfile segment and no symlink. `feedback` sent before the run reaches `done`
goes to the interview as a free-form answer.

## MCP tools (14)

The same operations as HTTP, minus the SSE stream and the artifacts listing,
plus a cheap `ultraapp_status`. Callable from any Model Context Protocol host
(Claude Desktop, Hermes Agent, Cursor, Cline, Continue, Zed,
Windsurf, Goose). `ultraapp_add_file` takes an `absolutePath` only; browser
uploads go through the dashboard. Param schemas in [`tools.md`](./tools.md#ultraapp-14).

```text
ultraapp_list           ultraapp_get             ultraapp_status
ultraapp_new            ultraapp_answer          ultraapp_add_file
ultraapp_spec_edit      ultraapp_build_start     ultraapp_build_cancel
ultraapp_feedback       ultraapp_promote_version
ultraapp_start_container ultraapp_stop_container ultraapp_delete
```

## Done-mode feedback classification

After the run reaches `done`, chat input goes to a per-run Haiku
classifier. Three classes:

| Class        | Routes to         | Behaviour                                                                                                                                                                                                                                                                                                                                                           |
| ------------ | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cosmetic`   | Patcher           | Copies the live version's codebase to the next `versions/vN/`, then a Claude Opus session generates a unified diff against the copy → `applyUnifiedDiff` → validate via fix-on-failure. On success the copy is recorded as `vN` (not deployed; the live app is untouched until you promote it); on any failure the copy is discarded and the reason posted to chat. |
| `spec-delta` | Focused interview | Flips mode back to `interview` with a bootstrap message that names the field(s) being changed. Completion auto-triggers a fresh `startBuild`, which builds the next `vN`, deploys it in place of the live version and stops the one it replaced.                                                                                                                    |
| `structural` | Suggestion only   | Posts a narrator note: "this sounds like a different app — click + New".                                                                                                                                                                                                                                                                                            |

To change which version is live, use `promote-version` (HTTP),
`ultraapp_promote_version` (MCP) or **Promote** in the dashboard's Versions panel.
A version deployed before is restarted on its recorded port and the live one
stopped; if it does not start, the previous version is put back. A version never
deployed is built and deployed first.

## Reference traces + replay

5 reference interview traces (JSONL) pin the interview engine's
output against drift:

```text
src/__tests__/fixtures/ultraapp-traces/
├── text-summariser.jsonl      (hand-written; text in, one LLM step, text out)
├── image-batch-resize.jsonl   (batch image upload, resize + watermark, zip out)
├── vlog-cut.jsonl             (ffmpeg silence detection, cut + concat)
├── llm-agent-pipeline.jsonl   (BYOK, multi-step LLM)
├── branching-dag.jsonl        (whisper transcript + ffmpeg keyframes, converging)
├── _format.md                 (trace JSONL schema)
└── expected/<name>.appspec.json   (frozen target)
```

```bash
npx tsx scripts/test-ultraapp-integration.ts --trace=image-batch-resize
npx tsx scripts/test-ultraapp-integration.ts --trace=all
```

The `spec-extraction-quality.test.ts` test replays each trace through
the interview engine, with the model's replies taken from the trace, and
asserts the resulting `AppSpec` matches the frozen snapshot — a change in
how replies are parsed or applied to the spec fails it. Because the replies
are recorded, it does not exercise the live model or `SKILL.md`.

## Operator quick start

```bash
# 1. Boot
clawo serve   # dashboard at :18796, ultraapp router at :19000
open "http://127.0.0.1:18796/dashboard?token=$(cat ~/.openclaw/server-token)"

# 2. Forge tab → + New → walk through the interview

# 3. After [Start Build] (or POST /ultraapp/<id>/build), watch:
#      mode pill: queued → building → build-complete → done
#      narrator: short conversational chat updates
#      Versions panel: v1, v2, …; the live one links to the app, the others have Promote

# 4. Live URL appears in the share card. The deployed app is reachable at:
curl http://127.0.0.1:19000/forge/<slug>/health
```

## Acceptance contract

UltraApp is the one mode whose acceptance contract is on by default.

**Build stage**, in the consensus snapshot (`versions/v1/codebase/`):

```
npm install → npm run build → npm test → [docker build] → npm run smoke
```

`docker build` runs only in `docker` runtime mode. On a red check a repair
session is started and the whole list re-runs, up to 5 times. A codebase
without a working `scripts.smoke` fails its build (§4).

**Deploy stage**, against the live URL: both §7g viewports (1440×900 and
375×812) are captured by the orchestrator with headless Chrome and stored as run
evidence.

Evidence lands in two places. The build stage is an ordinary `verifier` node,
so its bundle is in the workflow run's directory; the deploy stage writes its own
into the app's run directory:

```
~/.claw-orchestrator/wf/ultraapp-<runId>/evidence/
  build-v01-01/   bundle.json, checks/*.log, diff.patch
~/.claw-orchestrator/ultraapps/<runId>/evidence/
  deploy-01/      bundle.json, shot-desktop.png, shot-mobile.png
```

### What the visual gate does and does not do

It captures images and stores them as run evidence. It does **not** compare pixels — judging
the rendering is still a reader's job, and the §7g instructions in the council
prompt remain the agents' responsibility.

It is **advisory by default**, so a host without Chrome does not lose a working
app to a missing browser. Set `CLAWO_ULTRAAPP_VISUAL_GATE=strict` to make a
failed capture block the deploy. Chrome is resolved from `CLAWO_CHROME_BIN`, then
the usual macOS app paths, then `PATH`.

## Durable build queue

The build queue is persisted to `~/.claw-orchestrator/ultraapps/build-queue.json`
and restored on startup. Builds run one at a time, first in, first out. Only one
process owns the queue: restoring it takes a lease, and a process that cannot
take the lease starts with an empty queue.

A build that was in flight when the process died goes back to the **front** of
the queue. When it runs again, its workflow run resumes from the last stage it
finished (see [The build is a workflow run](#the-build-is-a-workflow-run)), so a
finished council is not paid for twice. A build started again after it completed,
failed or was cancelled is a fresh run under the same id.

## Known limitations

- The interview, spec edits, file additions, builds, done-mode feedback and the
  `events` stream work only on a run created by the running process. After a
  restart they answer `unknown runId`; listing, reading, start / stop / delete
  and promote still work.
- The done-mode patcher loop occasionally hangs between
  feedback classification and the start of the patcher's Claude Opus session;
  cosmetic changes can be applied manually until the underlying race
  is fixed.
