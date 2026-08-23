# OpenAI-Compatible Bridge

> **Cost warning**: This bridge routes requests through the Claude Code CLI, which uses your Claude Max subscription's **extra usage** quota. When OpenClaw's agent loop sends its system prompt (with distinctive tool definitions and agent instructions), Anthropic's backend recognizes this as programmatic/agent traffic and bills it against extra usage — **not** the included allowance. This is by design: the bridge does NOT bypass Anthropic's billing or subscription enforcement. Using it as OpenClaw's primary model backend means every agent turn consumes extra usage credits at standard API rates ($15/M input, $75/M output for Opus). Monitor your usage at [claude.ai/settings/usage](https://claude.ai/settings/usage).

The embedded server exposes a drop-in OpenAI-compatible endpoint so any client that speaks `/v1/chat/completions` can talk to a persistent Claude Code (or Codex / Antigravity / Grok) session. The bridge is designed to serve **two kinds of clients as first-class citizens**:

1. **Upstream agents** that maintain their own conversation state and forward only the latest user turn — OpenClaw's main agent loop, cron jobs, subagents, programmatic clients.
2. **OpenAI-compatible webchat / labeling tools** that re-send the full transcript on every turn — ChatGPT-Next-Web, Open WebUI, LobeChat, data-labeling pipelines.

Both modes share the same wire protocol; the difference is how a "new conversation" is detected. See [Operator Modes](#operator-modes) below.

## Endpoint

|                         |                                                                                                                                                |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| **URL**                 | `http://127.0.0.1:18796/v1/chat/completions`                                                                                                   |
| **Models endpoint**     | `GET /v1/models`                                                                                                                               |
| **Inspection endpoint** | `GET /v1/sessions` (lists active openai-compat sessions with caching stats)                                                                    |
| **Auth**                | Bearer token via `Authorization: Bearer $OPENCLAW_SERVER_TOKEN` (set the env var to enable; otherwise no auth and the server is loopback-only) |
| **Wire format**         | OpenAI Chat Completions, both streaming (SSE) and non-streaming                                                                                |

## Session keying

Each request is mapped to a long-running session. Once a session exists, subsequent requests with the same key reuse the same persistent CLI subprocess — so Anthropic prompt caching warms across turns. The key is derived in priority order:

1. **`X-Session-Id` header** — explicit, highest precedence
2. **`user` field in the request body** — OpenAI standard field, treated as a stable caller identifier
3. **`sys-<sha1(model + systemPrompt)[0..12]>`** — automatic fallback so unkeyed callers don't all collapse onto a single shared session
4. **`'default'`** — only when there is no system prompt AND no model (degenerate empty body)

The hash fallback exists because the previous behavior collapsed every unkeyed caller onto one `openai-default` session. In multi-caller setups (OpenClaw routing the main agent + cron jobs + subagents through one gateway) that meant requests serialized against each other and frequently picked up the wrong session's `appendSystemPrompt` — also a privacy leak across distinct callers.

The model is mixed into the hash so that two callers with the same system prompt but different requested models (e.g. one wants `claude-opus-4-6`, another wants `claude-sonnet-4-6`) don't collide and silently get responses from the wrong model.

The full plugin-side session name is `openai-<key>`.

## Operator modes

### Default mode — agent / programmatic clients

When the env var is **not set**, the bridge assumes upstream callers maintain their own conversation transcript and only forward the latest user turn. Sessions are reused indefinitely. The only signal that starts a new conversation is the explicit reset header:

```
X-Session-Reset: 1
```

(also accepted: `true`, case-insensitive, with whitespace)

When the header is present, the existing session for this key is stopped and a fresh one is created. Use this from a client that wants "new chat" semantics under your own control — e.g. when your UI's "Clear History" button is pressed.

### Webchat mode — `OPENAI_COMPAT_NEW_CONVO_HEURISTIC=1`

When the env var is set to `1`, the bridge additionally restores a legacy heuristic: a request whose `messages` array contains exactly one non-system message (i.e. the conversation has no assistant turns yet) is treated as a fresh conversation. This is the only signal that webchat frontends (ChatGPT-Next-Web, Open WebUI, LobeChat) emit when the user clicks "New Chat" — they clear their UI transcript and post `[system, user]`.

Without this flag, those frontends would silently continue the previous CLI session and surface stale context the user thought they had cleared.

The env var is read on every request, so ops can flip it via `launchctl setenv` (or equivalent) without restarting the server.

| Mode              | Best for                                                    | New-conversation signals                            |
| ----------------- | ----------------------------------------------------------- | --------------------------------------------------- |
| **Default**       | OpenClaw main agent, cron jobs, subagents, scripted clients | `X-Session-Reset: 1` only                           |
| **`HEURISTIC=1`** | ChatGPT-Next-Web, Open WebUI, LobeChat, data labeling tools | `X-Session-Reset: 1` **and** `[system, user]` shape |

## Status webhook

When `OPENAI_COMPAT_STATUS_URL` is set (full HTTP URL), each chat completion sends best-effort `POST` requests with `Content-Type: application/json` and body:

| Field      | Type           | Meaning                                                                                               |
| ---------- | -------------- | ----------------------------------------------------------------------------------------------------- |
| `state`    | string         | `thinking` (turn started), `working` (a tool is running), or `idle` (turn finished or stream closed). |
| `activity` | string         | Short human-readable line, e.g. `Processing request...`, `Reading: foo.ts`, `Running: npm test...`.   |
| `tool`     | string \| null | Tool name when `state === working`, otherwise `null`.                                                 |

Failures are ignored (no retries). Use this from a small local HTTP handler that forwards status into your webchat UI.

## Tool definitions and where they live

When the request carries `tools`, the schemas have to reach the CLI somehow. Which
mechanism is used depends on whether the engine keeps the conversation itself.

| Engine                                          | Turn 1                                                        | Later turns                                                                                                                                           |
| ----------------------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `claude`                                        | Schemas go into the session system prompt (`--system-prompt`) | Nothing injected — the system prompt persists                                                                                                         |
| `codex`, `codex-app`, `agy`, `opencode`, `grok` | Full schema block prepended to the message                    | A short reminder of the calling convention, no schemas — but only once the conversation id has been captured; until then the full block is sent again |
| `gemini`, one-shot `custom`                     | Full schema block prepended to the message                    | Full schema block again — these have no resume surface, so nothing persists between sends                                                             |

The middle row is the one worth understanding. Those engines resume a conversation by id, so
everything injected stays in the transcript. Re-sending the full block each turn
grows the prompt without bound — a 54-tool block runs to roughly 17k tokens, so a
handful of turns is enough to overflow the context window mid-loop and fail the
run outright. Sending _nothing_ on resume turns is not the answer either: the
block also carries the "emit a tool call, do not carry out the work yourself"
framing, and without it the CLI starts doing the work directly.

A fresh session always gets the full block, so a thread is never created without
the definitions — including when a session was evicted and is being recreated. A
caller that changes its tool list mid-conversation also gets the full block,
because the tool list is part of the session-name hash, so a different list
resolves to a different session.

The caller's own system prompt follows exactly the same rule on these engines: it
is prepended to the message, and skipped only while the conversation it was sent
to is still the one being resumed. A turn that creates a conversation always
carries it — including a `X-Session-Reset: 1` turn, which stops the existing
session and starts a new one. "The conversation is being resumed" means the
engine has actually announced an id (codex's `thread.started`, agy's log, cursor's
and opencode's session id), not merely that the session is in the manager's map: a
first turn that died before announcing one leaves a session behind that resumes
nothing, and those turns keep receiving the full prompt.

One exception to the sentence above, and it is a defect rather than a design: on a
request whose last non-system message is a `tool` result, `X-Session-Reset` is not
seen at all. The header is parsed after the branch that handles a trailing `tool`
role returns, so on that shape the reset stops nothing, creates nothing, and the
turn is treated as a resumed one — the prompt is skipped if the thread is live.
Every other shape, `[..., tool, user]` included, honors it. A client that needs a
reset mid-tool-loop has to send it on a turn that does not end in a `tool`
message.

`OPENAI_COMPAT_TOOLS_PER_MESSAGE=1` opts out: it re-sends the full block on every
turn for `claude` too, which is what makes a changing tool set work inside one
session (in that mode the tool list is deliberately left out of the session hash).
It costs the per-turn growth described above — only use it if the tool set really
does change mid-conversation.

## Tool results on the way back

A `tool` role message in the caller's array is the result of a call the model asked for on an
earlier turn. The `tool` messages that are in scope are serialized into one `<tool_results>` block
and prepended to the caller's latest `user` text in the message the CLI receives.

What is in scope depends on what the engine is holding, not on where the `tool` messages sit in the
array:

| On this turn the engine                                                                                                                   | What is sent                                                                                                            |
| ----------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| is **not** resuming a conversation — no session yet, a session that never announced a conversation id, or one being stopped and recreated | every `tool` message in the array                                                                                       |
| **is** resuming a live conversation                                                                                                       | only the `tool` messages after the array's last `assistant` message — everything before it is already in the transcript |

Whether the engine is resuming is resolved with the same `nativeThreadIsLive()` check as the
middle row of [Tool definitions](#tool-definitions-and-where-they-live). Engines with no resume
surface (`gemini`, one-shot `custom`) are never in the second row, because
`engineHasNativeConversation()` gates the check.

Two engines reach the second row from map presence alone rather than from a captured id, because
`nativeThreadIsLive()` has no case for them and its `default` arm returns `true`: `claude`, which
holds its context in a live process and has no separate id to check, and `grok` — which does resume
by id (`--resume <sessionUUID>`), but whose id is absent from `SessionStats`, so there is nothing to
check even though there is something to check for. A `grok` session whose first turn died before
emitting its id therefore reports a live thread and gets its earlier rounds scoped away. That is
pre-existing and not addressed here; fixing it means adding the field.

The trailing role of the array does not enter into it — `[..., tool]`, `[..., tool, user]` and
`[..., tool, assistant]` are read the same way, and the caller's latest `user` text, when there is
one, is appended after the block either way. A turn whose latest `user` message carries no text at
all — a multimodal content array holding only an image — gets the block as the whole message. An
array carrying no `tool` message at all is untouched: no block, no wrapper, the message goes as it
came.

The third case in the first row — a session being stopped and recreated — is `X-Session-Reset`, and
it puts the turn in that row on every shape where the header is read at all. That excludes an array
ending in a `tool` result, where the header is not seen; see the note under [Tool definitions](#tool-definitions-and-where-they-live).

### What the scoping is for, and what it does not cover

On a resumed conversation the scoping is what keeps a tool loop linear instead of quadratic. With a
30k-character batch per round, the tenth hop carries ~30k characters of results instead of the
~300k the engine has already seen. Two properties are worth checking against your own client before
relying on it:

- **The boundary is the last `assistant` message, and what matters is whether one sits AFTER the
  earliest unsent `tool` message** — not whether the array contains one at all. The OpenAI wire
  format has the caller echo the `assistant` turn that carried the `tool_calls` ahead of the
  matching `tool` messages, and a client that echoes it pays for one round per hop. When no
  `assistant` message follows the earliest unsent result, `lastIndexOf('assistant')` is behind them
  all and the slice keeps everything, so the scoping is a no-op. Two shapes land there: an array
  with no `assistant` message at all, and one `assistant` announcing N parallel calls followed by
  its N results — the second is a no-op that costs nothing, since those N results _are_ one round.
- **A round can go out twice.** Engine replies are not read back out of the array, so a round the
  caller did not record an `assistant` turn for looks the same as a round the engine never saw, and
  it goes out again. The duplication is bounded to one round wherever the scoping runs — i.e. on a
  resumed conversation whose array does carry an `assistant` message. It is unbounded in the two
  cases where nothing is scoped: the row above, and any turn in the first row of the table (no
  resumed conversation), where the whole array goes out by design because the engine holds none of
  it.

Neither applies to a caller that keeps its own transcript and forwards only the latest turn — it
sends one round at a time.

## Environment variables

| Variable                            | Default         | Purpose                                                                                                                                                                                                          |
| ----------------------------------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OPENCLAW_SERVER_TOKEN`             | (unset)         | Bearer token for HTTP auth. Set to enable; written to `~/.openclaw/server-token` for the CLI.                                                                                                                    |
| `OPENCLAW_RATE_LIMIT`               | `300`           | Max requests per IP per 60-second sliding window.                                                                                                                                                                |
| `OPENCLAW_CORS_ORIGINS`             | (loopback only) | Set to `*` to allow all origins (the `/v1/*` paths already do this).                                                                                                                                             |
| `OPENAI_COMPAT_NEW_CONVO_HEURISTIC` | (unset)         | Set to `1` to enable webchat mode (see above).                                                                                                                                                                   |
| `OPENAI_COMPAT_TOOLS_PER_MESSAGE`   | (unset)         | Set to `1` to re-send the full tool schemas on every turn (see [Tool definitions](#tool-definitions-and-where-they-live)). Needed only when the tool set changes mid-conversation; costs per-turn prompt growth. |
| `OPENAI_COMPAT_STATUS_URL`          | (unset)         | If set, the bridge POSTs JSON status updates to this URL (fire-and-forget, 2s timeout). See [Status webhook](#status-webhook).                                                                                   |
| `OPENCLAW_SERVE_MAX_SESSIONS`       | `32`            | Max concurrent OpenAI-compat sessions in serve mode. Bumped from the in-plugin default of 5 because each distinct caller now gets its own `sys-<hash>` session.                                                  |
| `OPENCLAW_SERVE_TTL_MINUTES`        | `60`            | Idle TTL for OpenAI-compat sessions in serve mode. Idle sessions are reaped by a 60s background loop; persisted disk registry is kept for 7 days so a returning caller is auto-resumed.                          |

## Inspection: `GET /v1/sessions`

Returns a JSON list of every active OpenAI-compat session and its caching statistics:

```bash
TOKEN=$(cat ~/.openclaw/server-token)
curl -s http://127.0.0.1:18796/v1/sessions -H "Authorization: Bearer $TOKEN" | jq
```

Sample response:

```json
{
  "object": "list",
  "data": [
    {
      "key": "sys-a3f81c9d0b27",
      "session_name": "openai-sys-a3f81c9d0b27",
      "model": "claude-opus-4-6",
      "cwd": "/home/user/projects",
      "created": "2026-04-09T03:12:18.441Z",
      "turns": 68,
      "turns_succeeded": 14,
      "tokens_in": 248312,
      "tokens_out": 38201,
      "cached_tokens": 198104,
      "context_percent": 28,
      "cost_usd": 0.4123
    }
  ]
}
```

`turns_succeeded` is one per request; `turns` is not comparable to it on these
sessions — the Claude CLI emits a `user` event per tool-result batch and `turns`
counts those, so the gap above is tool use, not failures. Compare
`turns_succeeded` against your own request count.

The single most important field is **`cached_tokens`**. If it grows turn-over-turn, the persistent CLI is being reused and Anthropic prompt caching is warming. If it stays at 0, something is killing the session every turn — check that no client is sending `X-Session-Reset` unintentionally and that `OPENAI_COMPAT_NEW_CONVO_HEURISTIC` is not set when it shouldn't be.

## Smoke tests

Run after standing up the server. Set `TOKEN=$(cat ~/.openclaw/server-token)` first.

**1. Two distinct system prompts produce two distinct sessions.**

```bash
for SYS in 'You are Alice.' 'You are Bob.'; do
  curl -s http://127.0.0.1:18796/v1/chat/completions \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    -d "{\"model\":\"claude-opus-4-6\",\"messages\":[{\"role\":\"system\",\"content\":\"$SYS\"},{\"role\":\"user\",\"content\":\"hi\"}]}" \
    | jq -r '.id'
done
curl -s http://127.0.0.1:18796/v1/sessions -H "Authorization: Bearer $TOKEN" \
  | jq '.data[] | {key, model, turns}'
# Expected: two rows, distinct sys-<hash> keys.
```

**2. Same system prompt + different model produces two sessions.**

```bash
for M in claude-opus-4-6 claude-sonnet-4-6; do
  curl -s http://127.0.0.1:18796/v1/chat/completions \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    -d "{\"model\":\"$M\",\"messages\":[{\"role\":\"system\",\"content\":\"SAME\"},{\"role\":\"user\",\"content\":\"hi\"}]}" > /dev/null
done
curl -s http://127.0.0.1:18796/v1/sessions -H "Authorization: Bearer $TOKEN" | jq '.data | length'
# Expected: 2
```

**3. `X-Session-Reset: 1` resets cleanly.**

```bash
SID=smoke-reset
curl -s http://127.0.0.1:18796/v1/chat/completions \
  -H "Authorization: Bearer $TOKEN" -H "X-Session-Id: $SID" -H "Content-Type: application/json" \
  -d '{"model":"claude-opus-4-6","messages":[{"role":"user","content":"remember the word banana"}]}' > /dev/null
curl -s http://127.0.0.1:18796/v1/chat/completions \
  -H "Authorization: Bearer $TOKEN" -H "X-Session-Id: $SID" -H "X-Session-Reset: 1" -H "Content-Type: application/json" \
  -d '{"model":"claude-opus-4-6","messages":[{"role":"user","content":"what word did I just tell you"}]}' \
  | jq -r '.choices[0].message.content'
# Expected: model says it has no prior context.
```

**4. `cached_tokens` grows turn-over-turn (the success metric).**

```bash
SID=smoke-cache
PREAMBLE=$(printf 'x%.0s' {1..3000})
for i in 1 2 3 4; do
  curl -s http://127.0.0.1:18796/v1/chat/completions \
    -H "Authorization: Bearer $TOKEN" -H "X-Session-Id: $SID" -H "Content-Type: application/json" \
    -d "{\"model\":\"claude-opus-4-6\",\"messages\":[{\"role\":\"system\",\"content\":\"long preamble: $PREAMBLE\"},{\"role\":\"user\",\"content\":\"turn $i\"}]}" > /dev/null
  curl -s http://127.0.0.1:18796/v1/sessions -H "Authorization: Bearer $TOKEN" \
    | jq ".data[] | select(.session_name == \"openai-$SID\") | {turn: $i, cached_tokens, tokens_in}"
done
# Expected: cached_tokens climbs substantially by turn 3-4. If it stays at 0,
# the persistent CLI is still being killed every turn — regression.
```

## Error responses

Errors use the OpenAI error envelope:

```json
{ "error": { "message": "...", "type": "invalid_request_error" } }
```

| Status | When                                                                   |
| ------ | ---------------------------------------------------------------------- |
| 400    | `messages` empty/missing, no user message, invalid `max_tokens`        |
| 401    | Missing or wrong bearer token (when auth enabled)                      |
| 415    | POST without `Content-Type: application/json`                          |
| 429    | Rate limited (`OPENCLAW_RATE_LIMIT` exceeded)                          |
| 503    | Failed to start a new session (model unavailable, CLI crashed at boot) |
| 500    | Mid-turn failure                                                       |

## Related

- [getting-started.md](./getting-started.md) — install + auth setup
- [sessions.md](./sessions.md) — what a session is and how the lifecycle works under the hood
- [tools.md](./tools.md) — the full plugin tool surface (council, ultraplan, etc.)
