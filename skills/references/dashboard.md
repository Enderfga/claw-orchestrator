# Dashboard

The dashboard is a single-page HTML app served by the orchestrator's embedded
HTTP server. It lets you **launch and observe** Council sessions, Autoloop
runs, and Forge (Ultraapp) builds from a browser — no CLI, no webchat, no
plugin tool calls needed.

URL: `http://127.0.0.1:18796/dash` (local) or whatever public hostname you
front the embedded server with (the recommended setup uses a path-based
reverse proxy, e.g. `https://<your-host>/dash`).

## Tabs

| Tab      | Backed by                        | Launch endpoint      |
| -------- | -------------------------------- | -------------------- |
| Autoloop | `SessionManager.autoloopStart()` | `POST /autoloop/new` |
| Council  | `SessionManager.councilStart()`  | `POST /council/new`  |
| Forge    | `UltraappManager.createRun()`    | `POST /ultraapp/new` |

Each tab has a `+ New` button in the sidebar. Council and Autoloop open a
modal form (because they need workspace/task input); Forge POSTs an empty
body and drops you into an interview (the spec is built conversationally).

## Standalone deployment

The recommended way to run the dashboard 24/7 is a separate `clawo serve`
process under launchd — completely decoupled from the OpenClaw gateway. The
gateway's plugin-side embedded server still works (lazy init on first tool
call); when both processes try to bind the default port, the loser gracefully
skips, so the two coexist without conflict.

Example `~/Library/LaunchAgents/com.clawo.serve.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key><string>com.clawo.serve</string>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>ThrottleInterval</key><integer>5</integer>
    <key>ProgramArguments</key>
    <array>
      <string>/opt/homebrew/bin/node</string>
      <string>/opt/homebrew/bin/clawo</string>
      <string>serve</string>
      <string>--port</string><string>18796</string>
      <string>--host</string><string>127.0.0.1</string>
    </array>
    <key>StandardOutPath</key>
    <string>/Users/USER/.openclaw/logs/clawo-serve.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/USER/.openclaw/logs/clawo-serve.log</string>
  </dict>
</plist>
```

Bootstrap:

```sh
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.clawo.serve.plist
launchctl print "gui/$(id -u)/com.clawo.serve" | grep state
```

## Auth

The embedded server self-generates a 32-byte token at startup and writes it
to `~/.openclaw/server-token` (mode 0600). Same-user processes on the box
read it and present it as `Authorization: Bearer <token>` (or
`?token=<v>` query / `clawo_auth` cookie).

### Local access

```
http://127.0.0.1:18796/dash?token=$(cat ~/.openclaw/server-token)
```

The server sets a `clawo_auth` cookie on the first query-token request, so
the bookmark `/dash` works on subsequent visits.

### Hosted access via reverse proxy (recommended)

Don't expose the token to the public internet. Instead, gate the public
hostname with whatever auth layer you already trust (CF Access passkey,
Tailscale, mTLS, etc.) and have the reverse proxy **inject the Bearer
token on behalf of the user** when forwarding to port 18796. The browser
authenticates only against your edge auth; the dashboard's own token stays
inside the box.

Example sasha-doctor pattern (matches the user-side setup):

```js
// after the edge auth check passes:
if (!req.headers.authorization) {
  req.headers.authorization = 'Bearer ' + fs.readFileSync('~/.openclaw/server-token', 'utf-8').trim();
}
proxyHTTP(req, res, 18796);
```

The `/login?token=...&redirect=/dash` endpoint exists as a fallback for
quick one-shot setups (works locally and through proxies that DON'T inject
the Bearer for you), but the proxy-injects-Bearer pattern is preferred
because users never see or paste the token.

Token-file write is deferred to the `listen()`-success callback so a second
process that loses the EADDRINUSE race does NOT clobber the winner's token.
The token is also re-read from disk on every request so that if a different
clawo instance (test runner, nohup launch, etc.) writes a new value mid-life,
the proxy and the server stay in agreement on the next request — no restart
required.

## Resuming a terminated autoloop run

Opening a run whose `status` is `terminated` (because its process has
exited, or because you're viewing it cross-process) no longer hangs on
"Waiting…". The dashboard fetches `/autoloop/<id>/chat_history`, replays
the conversation into the Planner pane, and surfaces a green **Resume
run** button in the topbar. Clicking it POSTs `/autoloop/<id>/resume`;
the orchestrator re-attaches the Planner (reusing the persisted Claude
session ID when available, so Claude's context picks up where it left
off) and the dashboard reconnects to `/events` for live updates.

If the run used a **custom engine** for any role, the button first asks
`/autoloop/<id>/resume-requirements` and prompts for one reference name per
role — the name of a `CLAWO_CUSTOM_ENGINE_<NAME>` variable on the orchestrator
host. The config itself is never stored and never sent; only the name is. Until
this existed the button sent an empty body unconditionally, so a custom-engine
run was resumable from the library and the HTTP API but not from the UI that
offers the button.

Runs that pre-date this feature have no `chat.jsonl` and no persisted
session — they still resume cleanly, but with a blank Planner pane and a
fresh Claude context. New runs going forward retain both.

## Cross-process visibility

When the dashboard runs in a different process from where you spawn runs
(e.g. you started a council via the OpenClaw plugin tool from webchat, but
the dashboard is in `clawo serve`), the run state is invisible across
in-memory boundaries. The dashboard fixes this by unioning in-memory state
with on-disk records on every list call:

- **Councils**: `~/.openclaw/council-logs/council-*.md` — parsed for
  `- **ID**:`, `- **Time**:`, `- **Task**:`, `- **Status**:` headers.
  Legacy transcripts (pre-v4.0) fall back to a filename-derived id.
- **Autoloops**: `~/.claw-orchestrator/autoloop-registry.jsonl` — an
  append-only JSONL index written by `autoloopStart()`. Stale entries
  whose ledger directory no longer exists are filtered out at read time.
- **Forge**: `UltraappStore.listRuns()` already reads from disk
  (`~/.claw-orchestrator/ultraapps/`).

Result: any run you've ever started — from any process — shows up in the
sidebar, sorted newest-first, until the underlying files are deleted.

## Reverse-proxy integration

If you front the embedded server with sasha-doctor (or another reverse
proxy), route these paths to `127.0.0.1:18796`:

- `/dashboard`, `/dash`, `/login`
- `/autoloop/*`, `/council/*`, `/ultraapp/*`

The dashboard's relative `fetch()` calls expect the proxy to preserve the
path verbatim — no prefix stripping. `/v1/openclaw/*` should keep routing
to the OpenClaw gateway, not the embedded server.

## Reset

To wipe dashboard state without touching real run data:

```sh
# Forget all known autoloops (council/forge unchanged).
rm ~/.claw-orchestrator/autoloop-registry.jsonl

# Force the standalone server to mint a fresh auth token.
launchctl kickstart -k "gui/$(id -u)/com.clawo.serve"
# Then visit /login?token=$(cat ~/.openclaw/server-token)&redirect=/dash once
# to refresh the cookie.
```

## Runs tab (6.0.0)

A fourth tab listing durable workflow runs. Because runs are checkpointed to
disk, this sees runs started by other processes and by earlier sessions, not just
what the current server started.

Each row shows the run state and its verdict as one of three things:

- **verified** — an acceptance contract ran and passed.
- **refuted** — a contract ran and a required check failed.
- **unchecked** — no contract was declared. Rendered in neutral grey, not red:
  an unchecked run is not a failed one, and colouring it like one would misreport
  every run that simply never asked to be checked.

Opening a run shows per-node state (kind, attempts, visit count for loops, and
any error), the consensus votes when a council node ran — labelled advisory,
because they are recorded rather than used to decide completion — and the
evidence bundle: per-check pass/fail with the failing detail, the fix rounds
consumed, and how many files changed since the base commit.
