# ultraapp — Reference

Turn a structured Q&A interview into a deployed web app reachable at
`localhost:19000/forge/<slug>/`. The dashboard's **Forge** tab and a
14-tool MCP surface drive the end-to-end loop: interview → 3-agent
council → fix-on-failure → deploy → done-mode feedback.

This page is the operator reference. The interview behavioural contract
lives in [`skills/ultraapp/SKILL.md`](../ultraapp/SKILL.md). The
council architectural conventions every generated app must satisfy live
in [`src/ultraapp/conventions.ts`](../../src/ultraapp/conventions.ts).

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

| Mode             | Meaning                                                                         |
| ---------------- | ------------------------------------------------------------------------------- |
| `interview`      | AppSpec being filled by Q&A. Chat input goes to the interview Opus.             |
| `queued`         | Build accepted, waiting for a slot in the FIFO build queue.                     |
| `building`       | Council writing code, fix-on-failure driving install/build/test.                |
| `build-complete` | Codebase ready, awaiting `deploy` step.                                         |
| `deploying`      | Container/process being started, router map being updated.                      |
| `done`           | App live at `/forge/<slug>/`. Chat input now goes to the done-mode classifier.  |
| `failed`         | Council didn't reach consensus, or fix-on-failure couldn't get the build green. |

### The build is a workflow run

Everything from `building` onward is a run on the durable kernel — the same one
`council_start`, `fanout_start` and `autoloop_start` use. The workflow has three
nodes:

| Node     | Kind              | Does                                                         |
| -------- | ----------------- | ------------------------------------------------------------ |
| `synth`  | `ultraapp_synth`  | The 3-agent council; snapshots consensus into `versions/v1/` |
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
super-task prompt verbatim from `src/ultraapp/conventions.ts`.

| §   | Topic                    | Headline rule                                                                                                                                                                                                                                                                                                                                                                |
| --- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Path-based deploy        | Mount at `BASE_PATH=/forge/<slug>/`; in-app links MUST be relative.                                                                                                                                                                                                                                                                                                          |
| 2   | Async file-queue runtime | Exact endpoints: `GET /`, `POST /run`, `GET /status/:jobId`, `GET /result/:jobId`, `GET /health`. File-based job queue under `$DATA_DIR/jobs/<jobId>/`. NO database. Data path from `process.env.DATA_DIR ?? '/data'`.                                                                                                                                                       |
| 3   | BYOK                     | If `runtime.needsLLM`, API keys live in browser localStorage and are sent direct to the provider. The server MUST NEVER receive the key (enforced by `eslint-plugin-no-server-keys`).                                                                                                                                                                                        |
| 4   | Dockerfile + smoke test  | Single multi-stage Dockerfile, `npm run smoke` drives one full job in < 90s using `examples[0].ref`.                                                                                                                                                                                                                                                                         |
| 5   | Council voting protocol  | 3 agents in git worktrees, all-YES vote required, max 8 rounds.                                                                                                                                                                                                                                                                                                              |
| 6   | Tech stack               | Modern TypeScript / JavaScript framework (Next.js, Vite + Hono, SvelteKit). NO Python, NO pure SSGs.                                                                                                                                                                                                                                                                         |
| 7   | **Frontend quality**     | **Real styling system + real type hierarchy + four-state coverage on every async surface + drag-and-drop forms + appropriate result presentation + one deliberate theme.** §7g requires every agent to capture Chrome-headless screenshots at 1440×900 AND 375×812 and visually inspect the PNGs before voting YES — source-code review is explicitly insufficient evidence. |

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
persists to `~/.claw-orchestrator/_router.json`. Host-mode pid metadata
persists to `~/.claw-orchestrator/host-procs.json`.

## File layout (per run)

```text
~/.claw-orchestrator/ultraapps/<runId>/
├── spec.json                  # current AppSpec (latest)
├── spec.history.jsonl         # every accepted update_spec patch
├── chat.jsonl                 # all chat turns (interview + done-mode)
├── state.json                 # { runId, mode, createdAt, updatedAt }
├── examples/                  # uploaded sample files
├── data/                      # passed to host-mode app as DATA_DIR
├── council-project/           # fresh git repo the council collaborates in
│   ├── .worktrees/{agent-A,agent-B,agent-C}/
│   └── (council code, merged to main on consensus)
└── versions/
    ├── v1/
    │   ├── codebase/          # snapshot of council main HEAD
    │   └── artifact.json      # { worktreePath, builtAt, deploy: { url, port, … } }
    └── v2/                    # patcher / spec-delta produces v2, v3, …
```

## HTTP routes (drive headlessly)

All routes are served by the embedded server (default `:18796`), under
`Authorization: Bearer <token>` from `~/.openclaw/server-token`.

| Method + path                         | Purpose                                                                           |
| ------------------------------------- | --------------------------------------------------------------------------------- |
| `GET /ultraapp/list`                  | All runs with mode + createdAt.                                                   |
| `POST /ultraapp/new`                  | Body: `{ firstMessage?: string }`. Returns `{ runId }`.                           |
| `GET /ultraapp/<id>`                  | Full snapshot: spec + chat + state.                                               |
| `POST /ultraapp/<id>/answer`          | Body: `{ value, freeform? }`. Submit interview answer.                            |
| `POST /ultraapp/<id>/spec-edit`       | Body: RFC 6902 patch ops. Edit the spec mid-interview.                            |
| `POST /ultraapp/<id>/files`           | Multipart upload to `examples/`.                                                  |
| `GET /ultraapp/<id>/events`           | SSE stream of build/chat events (mode pill, narrator, council activity).          |
| `POST /ultraapp/<id>/build`           | Validate spec strictly + enqueue.                                                 |
| `POST /ultraapp/<id>/build/cancel`    | Abort the active build.                                                           |
| `GET /ultraapp/<id>/artifacts`        | List `versions/vN/`.                                                              |
| `POST /ultraapp/<id>/start`           | Start the deployed container/process for the active version.                      |
| `POST /ultraapp/<id>/stop`            | Stop without deleting.                                                            |
| `POST /ultraapp/<id>/delete`          | Stop + remove all per-run state.                                                  |
| `POST /ultraapp/<id>/feedback`        | Body: `{ text }`. Done-mode classifier routes cosmetic / spec-delta / structural. |
| `POST /ultraapp/<id>/promote-version` | Body: `{ version: "vN" }`. Atomically swap deployed version.                      |

## MCP tools (14)

Same surface as HTTP, callable from any Model Context Protocol host
(Claude Desktop, Hermes Agent, Cursor, Cline, Continue, Zed,
Windsurf, Goose). Param schemas in [`tools.md`](./tools.md#ultraapp).

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

| Class        | Routes to         | Behaviour                                                                                                                                                                                                                             |
| ------------ | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cosmetic`   | Patcher           | Opus generates a unified diff against the deployed worktree → `applyUnifiedDiff` → validate via fix-on-failure → on success snapshot to `versions/vN+1/`, on any failure restore the snapshot atomically and post the reason to chat. |
| `spec-delta` | Focused interview | Flips mode back to `interview` with a bootstrap message that names the field(s) being changed. Completion auto-triggers a fresh `startBuild`.                                                                                         |
| `structural` | Suggestion only   | Posts a narrator note: "this sounds like a different app — click + New".                                                                                                                                                              |

To swap which version is live, use `promote-version` (HTTP) or
`ultraapp_promote_version` (MCP) — the router map and host-procs map
update atomically.

## Reference traces + replay

5 captured JSONL traces of real interviews ground-truth the interview
engine against drift:

```text
src/__tests__/fixtures/ultraapp-traces/
├── text-summariser.jsonl      (synthetic, simple text in/out)
├── image-batch-resize.jsonl   (batch upload + Pillow + zip)
├── vlog-cut.jsonl             (ffmpeg + whisper + branching DAG)
├── llm-agent-pipeline.jsonl   (BYOK, multi-step LLM)
├── branching-dag.jsonl        (parallel paths converging)
├── _format.md                 (trace JSONL schema)
└── expected/<name>.appspec.json   (frozen target)
```

```bash
tsx scripts/test-ultraapp-integration.ts --trace=image-batch-resize
tsx scripts/test-ultraapp-integration.ts --trace=all
```

The `spec-extraction-quality.test.ts` test replays each trace through
the interview engine and asserts the resulting `AppSpec` matches the
frozen snapshot — any future engine or skill drift fails this test.

## Operator quick start

```bash
# 1. Boot
clawo serve   # dashboard at :18796, ultraapp router at :19000
open "http://127.0.0.1:18796/dashboard?token=$(cat ~/.openclaw/server-token)"

# 2. Forge tab → + New → walk through the interview

# 3. After [Start Build] (or POST /ultraapp/<id>/build), watch:
#      mode pill: queued → building → done
#      narrator: short conversational chat updates
#      Versions panel: v1, v2, … with Promote per row

# 4. Live URL appears in the share card. The deployed app is reachable at:
curl http://127.0.0.1:19000/forge/<slug>/health
```

## Acceptance contract (6.0.0)

UltraApp is the one mode whose contract is on by default, because it already ran
most of these commands and because two of its documented gates were not actually
enforced.

**Build stage**, in the council's worktree:

```
npm install → npm run build → npm test → [docker build] → npm run smoke
```

`npm run smoke` is new here. §4 of the architectural conventions has always told
the council that the smoke test gates build success — it was never in the step
list, so the claim was false. A codebase without a working `scripts.smoke` now
fails its build, which is what the brief said all along.

**Deploy stage**, against the live URL: both §7g viewports (1440×900 and
375×812) are captured by the orchestrator with headless Chrome and stored as run
evidence.

Evidence lands under the run directory:

```
~/.claw-orchestrator/ultraapps/<runId>/evidence/
  build-01/    bundle.json, checks/*.log, diff.patch
  deploy-01/   bundle.json, shot-desktop.png, shot-mobile.png
```

### What the visual gate does and does not do

It captures images and stores them, so "did anyone actually look" is now a file
on disk instead of an agent's claim. It does **not** compare pixels — judging
the rendering is still a reader's job, and the §7g instructions in the council
prompt remain the agents' responsibility.

It is **advisory by default**, so a host without Chrome does not lose a working
app to a missing browser. Set `CLAWO_ULTRAAPP_VISUAL_GATE=strict` to make a
failed capture block the deploy. Chrome is resolved from `CLAWO_CHROME_BIN`, then
the usual macOS app paths, then `PATH`.

## Durable build queue (6.0.0)

The build queue is persisted to `<store>/build-queue.json` and restored on
startup. Its own comment used to say a restart mid-build meant "the build is
marked failed and the user can rerun"; in practice nothing was marked — the
pending list vanished along with any queued build the user was waiting on, with
no record it had been asked for.

A build that was in flight when the process died is **re-queued, not resumed**,
and goes to the front: each build starts from a fresh council worktree, so
re-running is safe and continuing a half-built tree is not.

## Known limitations

- The done-mode patcher loop occasionally hangs between
  feedback-classification and the patcher Opus session creation;
  cosmetic changes can be applied manually until the underlying race
  is fixed.
