# Dashboard

The dashboard is a single-page HTML app served by the orchestrator's embedded
HTTP server. It lets you **launch and observe** Council sessions, Autoloop
runs and Forge (Ultraapp) builds, and browse durable workflow runs, from a
browser — no CLI, no webchat, no plugin tool calls needed.

URL: `http://127.0.0.1:18796/dash` (local) or whatever public hostname you
front the embedded server with (the recommended setup uses a path-based
reverse proxy, e.g. `https://<your-host>/dash`).

## Tabs

| Tab      | Backed by                        | Launch endpoint      |
| -------- | -------------------------------- | -------------------- |
| Autoloop | `SessionManager.autoloopStart()` | `POST /autoloop/new` |
| Council  | `SessionManager.councilStart()`  | `POST /council/new`  |
| Forge    | `UltraappManager.createRun()`    | `POST /ultraapp/new` |
| Runs     | `GET /workflow/list`             | — (view only)        |

Autoloop, Council and Forge each have a `+ New` button in the sidebar; Runs is
view-only (start runs with `workflow_start`). Council and Autoloop open a
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

On first start the embedded server generates a 32-byte token and writes it
to `~/.openclaw/server-token` (mode 0600); later starts reuse it. Same-user
processes on the box read it and present it as `Authorization: Bearer <token>`
(or `?token=<v>` query / `clawo_auth` cookie).

`OPENCLAW_SERVER_TOKEN=<v>` sets an explicit token instead.
`OPENCLAW_SERVER_TOKEN=disabled` turns authentication off entirely — only safe
on a trusted single-user host.

### Local access

```
http://127.0.0.1:18796/dash?token=$(cat ~/.openclaw/server-token)
```

The server sets a `clawo_auth` cookie on the first query-token request, so a
bookmarked `/dash` works for the next 24 hours (the cookie's lifetime).

### Hosted access via reverse proxy (recommended)

Don't expose the token to the public internet. Instead, gate the public
hostname with whatever auth layer you already trust (Cloudflare Access,
Tailscale, mTLS, etc.) and have the reverse proxy **inject the Bearer
token on behalf of the user** when forwarding to port 18796. The browser
authenticates only against your edge auth; the dashboard's own token stays
inside the box.

Example reverse-proxy pattern (Node):

```js
// after the edge auth check passes:
if (!req.headers.authorization) {
  const tokenFile = path.join(os.homedir(), '.openclaw', 'server-token');
  req.headers.authorization = 'Bearer ' + fs.readFileSync(tokenFile, 'utf-8').trim();
}
proxyHTTP(req, res, 18796);
```

The `/login?token=...&redirect=/dash` endpoint exists as a fallback for
quick one-shot setups (works locally and through proxies that DON'T inject
the Bearer for you), but the proxy-injects-Bearer pattern is preferred
because users never see or paste the token.

The token file is written only after the server has bound its port, so a
second process that fails to bind does not overwrite the running server's
token. The token is read from disk on every request, so a server and a proxy
that both read the file always agree.

## Resuming a terminated autoloop run

Opening a run whose `status` is `terminated` (because its process has
exited, or because you're viewing it cross-process) fetches
`/autoloop/<id>/chat_history`, replays the conversation into the Planner pane,
and shows a green **Resume run** button in the topbar. Clicking it POSTs `/autoloop/<id>/resume`;
the orchestrator re-attaches the Planner (reusing the persisted Claude
session ID when available, so Claude's context picks up where it left
off) and the dashboard reconnects to `/events` for live updates.

If the run used a **custom engine** for any role, the button first asks
`/autoloop/<id>/resume-requirements` and prompts for one reference name per
role — the name of a `CLAWO_CUSTOM_ENGINE_<NAME>` variable on the orchestrator
host. The config itself is never stored and never sent; only the name is.

A run without a `chat.jsonl` or a persisted session still resumes, with a blank
Planner pane and a fresh Claude context.

## Cross-process visibility

Every council, autoloop and workflow run is a durable kernel run stored under
`~/.claw-orchestrator/wf/`, so the dashboard lists runs started by any process —
the OpenClaw plugin, `clawo serve`, or the CLI — sorted newest-first, until the
run records are deleted. Forge runs are read from
`~/.claw-orchestrator/ultraapps/`.

## Reverse-proxy integration

If you front the embedded server with a reverse proxy, route these paths to
`127.0.0.1:18796`:

- `/dashboard`, `/dash`, `/login`
- `/autoloop/*`, `/council/*`, `/ultraapp/*`
- `/workflow/*`, `/runs`

The dashboard's relative `fetch()` calls expect the proxy to preserve the
path verbatim — no prefix stripping. `/v1/openclaw/*` should keep routing
to the OpenClaw gateway, not the embedded server.

## Reset

To rotate the auth token, delete the token file and restart the server — a
restart alone reuses the existing token:

```sh
rm ~/.openclaw/server-token
launchctl kickstart -k "gui/$(id -u)/com.clawo.serve"
# Then visit /login?token=$(cat ~/.openclaw/server-token)&redirect=/dash once
# to refresh the cookie.
```

## Runs tab

Lists durable workflow runs. Because runs are checkpointed to
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
