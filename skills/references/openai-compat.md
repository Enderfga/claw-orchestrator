# OpenAI-Compatible Bridge

> **Cost warning**: This bridge routes requests through the Claude Code CLI, which uses your Claude Max subscription's **extra usage** quota. When OpenClaw's agent loop sends its system prompt (with distinctive tool definitions and agent instructions), Anthropic's backend recognizes this as programmatic/agent traffic and bills it against extra usage — **not** the included allowance. This is by design: the bridge does NOT bypass Anthropic's billing or subscription enforcement. Using it as OpenClaw's primary model backend means every agent turn consumes extra usage credits at standard API rates ($15/M input, $75/M output for Opus). Monitor your usage at [claude.ai/settings/usage](https://claude.ai/settings/usage).

The embedded server exposes a drop-in OpenAI-compatible endpoint so any client that speaks `/v1/chat/completions` can talk to a persistent Claude Code (or Codex / Antigravity / Cursor) session. The bridge is designed to serve **two kinds of clients as first-class citizens**:

1. **Upstream agents** that maintain their own conversation state and forward only the latest user turn — OpenClaw's main agent loop, cron jobs, subagents, programmatic clients.
2. **OpenAI-compatible webchat / labeling tools** that re-send the full transcript on every turn — ChatGPT-Next-Web, Open WebUI, LobeChat, data-labeling pipelines.

Both modes share the same wire protocol; the difference is how a "new conversation" is detected. See [Operator Modes](#operator-modes) below.

## Endpoint

| | |
|---|---|
| **URL** | `http://127.0.0.1:18796/v1/chat/completions` |
| **Models endpoint** | `GET /v1/models` |
| **Inspection endpoint** | `GET /v1/sessions` (lists active openai-compat sessions with caching stats) |
| **Auth** | Bearer token via `Authorization: Bearer $OPENCLAW_SERVER_TOKEN` (set the env var to enable; otherwise no auth and the server is loopback-only) |
| **Wire format** | OpenAI Chat Completions, both streaming (SSE) and non-streaming |

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

| Mode | Best for | New-conversation signals |
|---|---|---|
| **Default** | OpenClaw main agent, cron jobs, subagents, scripted clients | `X-Session-Reset: 1` only |
| **`HEURISTIC=1`** | ChatGPT-Next-Web, Open WebUI, LobeChat, data labeling tools | `X-Session-Reset: 1` **and** `[system, user]` shape |

## Status webhook

When `OPENAI_COMPAT_STATUS_URL` is set (full HTTP URL), each chat completion sends best-effort `POST` requests with `Content-Type: application/json` and body:

| Field | Type | Meaning |
|---|---|---|
| `state` | string | `thinking` (turn started), `working` (a tool is running), or `idle` (turn finished or stream closed). |
| `activity` | string | Short human-readable line, e.g. `Processing request...`, `Reading: foo.ts`, `Running: npm test...`. |
| `tool` | string \| null | Tool name when `state === working`, otherwise `null`. |

Failures are ignored (no retries). Use this from a small local HTTP handler that forwards status into your webchat UI.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `OPENCLAW_SERVER_TOKEN` | (unset) | Bearer token for HTTP auth. Set to enable; written to `~/.openclaw/server-token` for the CLI. |
| `OPENCLAW_RATE_LIMIT` | `300` | Max requests per IP per 60-second sliding window. |
| `OPENCLAW_CORS_ORIGINS` | (loopback only) | Set to `*` to allow all origins (the `/v1/*` paths already do this). |
| `OPENAI_COMPAT_NEW_CONVO_HEURISTIC` | (unset) | Set to `1` to enable webchat mode (see above). |
| `OPENAI_COMPAT_STATUS_URL` | (unset) | If set, the bridge POSTs JSON status updates to this URL (fire-and-forget, 2s timeout). See [Status webhook](#status-webhook). |
| `OPENCLAW_SERVE_MAX_SESSIONS` | `32` | Max concurrent OpenAI-compat sessions in serve mode. Bumped from the in-plugin default of 5 because each distinct caller now gets its own `sys-<hash>` session. |
| `OPENCLAW_SERVE_TTL_MINUTES` | `60` | Idle TTL for OpenAI-compat sessions in serve mode. Idle sessions are reaped by a 60s background loop; persisted disk registry is kept for 7 days so a returning caller is auto-resumed. |

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
      "turns": 14,
      "tokens_in": 248312,
      "tokens_out": 38201,
      "cached_tokens": 198104,
      "context_percent": 28,
      "cost_usd": 0.4123
    }
  ]
}
```

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

| Status | When |
|---|---|
| 400 | `messages` empty/missing, no user message, invalid `max_tokens` |
| 401 | Missing or wrong bearer token (when auth enabled) |
| 415 | POST without `Content-Type: application/json` |
| 429 | Rate limited (`OPENCLAW_RATE_LIMIT` exceeded) |
| 503 | Failed to start a new session (model unavailable, CLI crashed at boot) |
| 500 | Mid-turn failure |

## Related

- [getting-started.md](./getting-started.md) — install + auth setup
- [sessions.md](./sessions.md) — what a session is and how the lifecycle works under the hood
- [tools.md](./tools.md) — the full plugin tool surface (council, ultraplan, etc.)
