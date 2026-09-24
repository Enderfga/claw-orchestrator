# OpenAI-Compatible Bridge

> **Cost note**: the bridge drives the Claude Code CLI, so usage counts against your Claude account. It does not bypass Anthropic's billing or subscription limits. Heavy agent traffic can consume extra-usage credits at API rates. Check your usage at [claude.ai/settings/usage](https://claude.ai/settings/usage).

The embedded server exposes a drop-in OpenAI-compatible endpoint so any client that speaks `/v1/chat/completions` can talk to a persistent Claude Code (or Codex / Antigravity / Grok / OpenCode) session. The bridge is designed to serve **two kinds of clients as first-class citizens**:

1. **Upstream agents** that maintain their own conversation state and forward only the latest user turn — OpenClaw's main agent loop, cron jobs, subagents, programmatic clients.
2. **OpenAI-compatible webchat / labeling tools** that re-send the full transcript on every turn — ChatGPT-Next-Web, Open WebUI, LobeChat, data-labeling pipelines.

Both modes share the same wire protocol; the difference is how a "new conversation" is detected. See [Operator Modes](#operator-modes) below.

## Endpoint

|                         |                                                                                                                                                                                                                                                                          |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **URL**                 | `http://127.0.0.1:18796/v1/chat/completions`                                                                                                                                                                                                                             |
| **Models endpoint**     | `GET /v1/models`                                                                                                                                                                                                                                                         |
| **Inspection endpoint** | `GET /v1/sessions` (lists active openai-compat sessions with caching stats)                                                                                                                                                                                              |
| **Auth**                | `Authorization: Bearer <token>`. By default the server generates a token and writes it to `~/.openclaw/server-token` (mode 0600). Set `OPENCLAW_SERVER_TOKEN=<value>` to choose the token, or `OPENCLAW_SERVER_TOKEN=disabled` to turn auth off (single-user hosts only) |
| **Wire format**         | OpenAI Chat Completions, both streaming (SSE) and non-streaming                                                                                                                                                                                                          |
| **Default model**       | `claude-sonnet-4-6` when the request has no `model`                                                                                                                                                                                                                      |

## Session keying

Each request is mapped to a long-running session. Once a session exists, subsequent requests with the same key reuse the same persistent CLI subprocess — so Anthropic prompt caching warms across turns. The key is derived in priority order:

1. **`X-Session-Id` header** — explicit, highest precedence
2. **`user` field in the request body** — OpenAI standard field, treated as a stable caller identifier
3. **`sys-<sha1(model + systemPrompt)[0..12]>`** — automatic fallback so unkeyed callers don't all collapse onto a single shared session
4. **`'default'`** — only when there is no system prompt AND no model (degenerate empty body)

Without the hash fallback, unkeyed callers (for example OpenClaw's main agent, cron jobs and subagents behind one gateway) would share one session: their requests would queue behind each other and could receive another caller's system prompt.

The model is mixed into the hash so that two callers with the same system prompt but different requested models (e.g. one wants `opus`, another wants `sonnet`) get separate sessions rather than responses from the wrong model.

The full plugin-side session name is `openai-<key>`. The key becomes a directory
name — the bridge starts each session in `os.tmpdir()/openclaw-compat-<name>` —
so a key that is not already `[A-Za-z0-9._-]` is replaced by a hash of itself.
An ordinary id is used unchanged; a key containing path separators cannot choose
where the session runs.

The tool list is fingerprinted into the hash fallback by name, a description
prefix, and the **parameter schema** (with object keys normalised, so a
re-serialised identical schema still resolves to the same session). On the
Claude engine the schemas are written into the session's system prompt when the
session is created and are not re-sent per turn, so a changed schema has to
resolve to a new session for the model to see it.

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

The engines in the middle row resume a conversation by id, so everything injected
stays in the transcript. Re-sending the full block each turn would grow the prompt
without bound (a 54-tool block is roughly 17k tokens), so a few turns could
overflow the context window. The short reminder is still needed, because the
block carries the "emit a tool call, do not carry out the work yourself" framing;
without it the CLI starts doing the work directly.

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
engine has actually announced an id (codex's `thread.started`, agy's `init` event,
cursor's, grok's and opencode's session id), not merely that the session is in the
manager's map: a first turn that failed before announcing one leaves a session
that resumes nothing, and later turns keep receiving the full prompt.

See [Known limitations](#known-limitations) for the one request shape where
`X-Session-Reset` is not honoured.

`OPENAI_COMPAT_TOOLS_PER_MESSAGE=1` opts out: it re-sends the full block on every
turn for `claude` too, which is what makes a changing tool set work inside one
session (in that mode the tool list is deliberately left out of the session hash).
It costs the per-turn growth described above — only use it if the tool set really
does change mid-conversation.

## Conversation history on the way in

The caller's `messages[]` can carry the whole conversation: earlier `user` turns and the engine's
own earlier `assistant` replies. The bridge sends those turns only when the engine's conversation
does not already hold them. The turns that are sent are serialized into one
`<conversation_history>` block of `<user>` / `<assistant>` turns, placed in front of the caller's
latest `user` text.

| On this turn the engine                                                                                                                   | What is sent                                                                   |
| ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| is **not** resuming a conversation — no session yet, a session that never announced a conversation id, or one being stopped and recreated | every `user`/`assistant` turn except the caller's latest `user` message        |
| **is** resuming a live conversation, but one this bridge never sent these turns to                                                        | the same — a live thread is not automatically _this_ thread                    |
| **is** resuming the live conversation these turns belong to                                                                               | nothing — the turns are already in the transcript, and the text goes out alone |

The last row keeps Anthropic prompt caching warm on `claude` and stops a resumed `codex` thread
from being sent its own history again: on a live thread the message is exactly the caller's text.
The first row covers clients that open a new conversation every turn (for example, one whose
session key hashes the last message). Bridge sessions are created with `skipPersistence: true` and
are never resumed from disk, so without the replay a follow-up like "yes, go ahead" would reach
the engine with no context. How the bridge tells the second row from the third is described in
[A live session is not the same thing as this conversation](#a-live-session-is-not-the-same-thing-as-this-conversation).

What goes into the block:

- `system` messages are never in it: they travel as the session's system prompt (see
  [Tool definitions](#tool-definitions-and-where-they-live)).
- `tool` messages are never in it either; they are handled by the `<tool_results>` block described
  under [Tool results on the way back](#tool-results-on-the-way-back).
- An `assistant` message that only announces `tool_calls` carries no text, so it renders no turn. A
  turn whose text is empty or whitespace is dropped.
- A `user` turn carrying only non-text content (an image) renders as `[non-text content]`, so the
  `assistant` reply to it does not appear to answer nothing. A leading `assistant` turn with no
  `user` turn before it (content `null`, or empty) is dropped.
- An array with nothing to replay produces no block, so a single-turn `[system, user]` request —
  the shape the OpenClaw main agent, cron jobs and subagents send — goes out unchanged.

Replayed text has the `<` of every structural tag escaped (`</user>` becomes `&lt;/user>`): the
block's own `<conversation_history>` / `<user>` / `<assistant>`, and also `<tool_results>` /
`<tool_result>`, `<system>` and `<tool_calls>`. Forms padded with invisible or zero-width
characters (`</​user>`, `<user︀>`) are caught too. This stops a user message from closing its own
turn or forging an `assistant` turn, a `<system>` block, a tool result, or a tool call. Limits:

- A visible space inside the tag (`</ user>`, `< assistant>`) is not caught, and filler inside the
  tag name (`</us␀er>`) is not caught either.
- Text that merely looks like a tag, such as `Promise<User | null>`, comes out with `&lt;`. It stays
  readable to a model but is not byte-identical.
- The body of a `<tool_result>` is never escaped, since it comes from the caller's own tool runner.

The caller's **latest** `user` turn is escaped the same way, but only on turns that carry a block.
With no block in front of it there is nothing to forge, so those turns go out unchanged.

### What this does not cover

- **A turn can be replayed that the engine already had.** The engine's state is read from the
  session, not from the array, so a client whose session looks new to the bridge but whose engine
  did hold context gets those turns a second time. The framing tells the model these are earlier
  turns and not to act on them again; nothing enforces it.
- **The block is not in strict chronological order when the array does not end in the caller's
  latest `user` turn.** Every `user`/`assistant` turn except that one is replayed, including turns
  after it — an array ending in `assistant` (prefill, an explicit "continue") keeps that turn, so it
  is rendered inside the block, before the caller's latest text.
- **The two blocks are not interleaved.** When a request carries both, the message is the history
  block, then the tool results, then the caller's new text. A `tool` result that chronologically
  preceded a replayed `assistant` turn still appears after it.
- **The block is capped at 24,000 characters, counting tags, markers and framing.** Oldest turns are
  dropped first. The turn where the budget runs out is cut (start kept) and marked
  `[… turn truncated for length …]`. A turn with under 200 characters of room is dropped instead.
  The most recent `user` turn in the block always keeps at least its first 200 characters, so the
  block is never left with only `assistant` turns.

  The cap exists because most engines (`codex`, `agy`, `grok`, `opencode`, `cursor`, `gemini`,
  one-shot `custom`) receive the prompt as a single command-line argument, and Linux limits one
  argument to 128 KiB (`MAX_ARG_STRLEN`). Going over fails the request with a 500. The 5 MiB request
  body limit does not protect against this. `claude`, `codex-app` and a persistent `custom` engine
  write over stdin instead. The cap bounds only the part of the prompt that grows with the
  transcript; the tool block, the system prompt and the caller's own turn are added on top.

- **A send that threw records nothing.** The fingerprint is written only after the send returns. A
  send that returns an error is answered with 502 and still records, since the CLI received the
  prompt; only a thrown send leaves no record, so the next request replays the turns.
- **A second request that arrives while the first is still in flight replays.** It sees no
  fingerprint yet, so the transcript goes out again into the session that already holds it: a
  duplicate rather than a loss, plus a lost cache prefix.
- **Cost is O(n) per turn for engines that never resume.** `gemini` and one-shot custom engines have
  no native conversation, so the block is rebuilt and sent on every turn (capped). The same applies
  to any caller that creates a new session per turn.
- **`X-Session-Reset` replays the transcript.** A reset turn means the engine holds nothing, so the
  history goes out in full. A client that sends the header on every request and also re-sends
  `messages[]` pays for the transcript every time.

### A live session is not the same thing as this conversation

Suppressing the replay needs a stronger fact than "a session under this name is live". That is what
`nativeThreadIsLive()` reports, and a session name can be live while its transcript belongs to a
different exchange. Three shapes where the two come apart, all reachable with default settings:

| shape                                                | what happens                                                                                                                            |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| a caller whose session key hashes its latest message | every repeat of the same short confirmation resolves to whichever session that phrase opened first — often a different subject entirely |
| a caller that sends no `X-Session-Id` at all         | the key falls back to a hash of model + system prompt + tools, so all of that caller's concurrent chats share one name                  |
| `engine: 'claude'` — the default                     | `nativeThreadIsLive()` has no id to check and returns `true` for anything in the session map, so the name is the only evidence there is |

So the bridge records, per session, a fingerprint of the `user` turns it has sent there, and
replays whenever the incoming conversation is not the one it recorded. It is the only writer to
these sessions, so what it sent is what the engine holds. The fingerprint covers the `user` turns
only: those are the caller's own text echoed back verbatim, while assistant text is what the engine
produced and a client may normalize it. A mismatch replays: the cost is a repeated block, never a
lost one.

What the request is compared against depends on how the array ends. For an array ending in a `user`
turn, the `user` turns before that last one are compared, since the last one has not been sent yet.
For any other ending (a tool-loop hop ending in `tool`, a prefill ending in `assistant`) the latest
`user` turn was already sent, so all `user` turns are compared.

The fingerprint map holds at most 1,000 entries, evicted oldest-first. It is separate from the
session map: `_cleanupIdleSessions()` reaps idle sessions by TTL without updating it, so a
fingerprint can outlive its session. Losing an entry (eviction, or a `serve` restart, which starts
the map empty) costs a replayed block, never a dropped one.

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
`engineHasNativeConversation()` gates the check. `claude` (and a persistent `custom` engine) holds
its context in a live process and has no separate id to check, so it is in the second row whenever
the session exists.

The trailing role of the array does not enter into it — `[..., tool]`, `[..., tool, user]` and
`[..., tool, assistant]` are read the same way, and the caller's latest `user` text, when there is
one, is appended after the block either way. A turn whose latest `user` message carries no text at
all — a multimodal content array holding only an image — gets the block as the whole message. An
array carrying no `tool` message at all is untouched: no block, no wrapper, the message goes as it
came.

The third case in the first row — a session being stopped and recreated — is `X-Session-Reset`,
except on the one shape listed under [Known limitations](#known-limitations).

### What the scoping is for, and what it does not cover

On a resumed conversation the scoping keeps a tool loop linear instead of quadratic. With a
30k-character batch per round, the tenth hop carries ~30k characters of results instead of the
~300k the engine has already seen. Two properties are worth checking against your own client before
relying on it:

- **The boundary is the last `assistant` message, and what matters is whether one sits after the
  earliest unsent `tool` message** — not whether the array contains one at all. The OpenAI wire
  format has the caller echo the `assistant` turn that carried the `tool_calls` ahead of the
  matching `tool` messages, and a client that echoes it pays for one round per hop. When no
  `assistant` message follows the earliest unsent result, the slice keeps everything, so the scoping
  has no effect. Two shapes land there: an array with no `assistant` message at all, and one
  `assistant` announcing N parallel calls followed by its N results — the second costs nothing,
  since those N results _are_ one round.
- **A round can go out twice.** Engine replies are not read back out of the array, so a round the
  caller did not record an `assistant` turn for looks the same as a round the engine never saw, and
  it goes out again. The duplication is bounded to one round wherever the scoping runs — i.e. on a
  resumed conversation whose array does carry an `assistant` message. It is unbounded in the two
  cases where nothing is scoped: the shape above with no `assistant` message, and any turn in the
  first row of the table (no resumed conversation), where the whole array goes out because the
  engine holds none of it.

Neither applies to a caller that keeps its own transcript and forwards only the latest turn — it
sends one round at a time.

## Known limitations

- **`X-Session-Reset` is ignored on a request whose last non-system message is a `tool` result.** On
  that shape the reset stops nothing and creates nothing, and the turn is treated as a resumed one:
  the system prompt is skipped if the thread is live, and tool results are scoped as for a live
  thread. Every other shape,
  `[..., tool, user]` included, honours it. To reset in the middle of a tool loop, send the header on
  a turn that ends in a `user` message.

## Environment variables

| Variable                            | Default          | Purpose                                                                                                                                                                                                          |
| ----------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OPENCLAW_SERVER_TOKEN`             | (auto-generated) | Overrides the auto-generated bearer token; `disabled` turns auth off. The active token is written to `~/.openclaw/server-token` for the CLI.                                                                     |
| `OPENCLAW_RATE_LIMIT`               | `300`            | Max requests per IP per 60-second sliding window.                                                                                                                                                                |
| `OPENCLAW_CORS_ORIGINS`             | (loopback only)  | Set to `*` to allow all origins (the `/v1/*` paths already do this).                                                                                                                                             |
| `OPENAI_COMPAT_NEW_CONVO_HEURISTIC` | (unset)          | Set to `1` to enable webchat mode (see above).                                                                                                                                                                   |
| `OPENAI_COMPAT_TOOLS_PER_MESSAGE`   | (unset)          | Set to `1` to re-send the full tool schemas on every turn (see [Tool definitions](#tool-definitions-and-where-they-live)). Needed only when the tool set changes mid-conversation; costs per-turn prompt growth. |
| `OPENAI_COMPAT_STATUS_URL`          | (unset)          | If set, the bridge POSTs JSON status updates to this URL (fire-and-forget, 2s timeout). See [Status webhook](#status-webhook).                                                                                   |
| `OPENCLAW_SERVE_MAX_SESSIONS`       | `32`             | Max concurrent OpenAI-compat sessions in serve mode. The plugin default is 5; serve mode raises it because each distinct caller gets its own `sys-<hash>` session.                                               |
| `OPENCLAW_SERVE_TTL_MINUTES`        | `60`             | Idle TTL for OpenAI-compat sessions in serve mode. Idle sessions are reaped by a 60s background loop and are not resumed from disk.                                                                              |

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
      "model": "claude-opus-5-5",
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
    -d "{\"model\":\"opus\",\"messages\":[{\"role\":\"system\",\"content\":\"$SYS\"},{\"role\":\"user\",\"content\":\"hi\"}]}" \
    | jq -r '.id'
done
curl -s http://127.0.0.1:18796/v1/sessions -H "Authorization: Bearer $TOKEN" \
  | jq '.data[] | {key, model, turns}'
# Expected: two rows, distinct sys-<hash> keys.
```

**2. Same system prompt + different model produces two sessions.**

```bash
for M in opus sonnet; do
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
  -d '{"model":"opus","messages":[{"role":"user","content":"remember the word banana"}]}' > /dev/null
curl -s http://127.0.0.1:18796/v1/chat/completions \
  -H "Authorization: Bearer $TOKEN" -H "X-Session-Id: $SID" -H "X-Session-Reset: 1" -H "Content-Type: application/json" \
  -d '{"model":"opus","messages":[{"role":"user","content":"what word did I just tell you"}]}' \
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
    -d "{\"model\":\"opus\",\"messages\":[{\"role\":\"system\",\"content\":\"long preamble: $PREAMBLE\"},{\"role\":\"user\",\"content\":\"turn $i\"}]}" > /dev/null
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
| 413    | Request body over 5 MiB                                                |
| 401    | Missing or wrong bearer token (when auth enabled)                      |
| 415    | POST without `Content-Type: application/json`                          |
| 429    | Rate limited (`OPENCLAW_RATE_LIMIT` exceeded)                          |
| 503    | Failed to start a new session (model unavailable, CLI crashed at boot) |
| 502    | The CLI finished the turn with an error (`type: upstream_error`)       |
| 500    | Mid-turn failure                                                       |

## Related

- [getting-started.md](./getting-started.md) — install + auth setup
- [sessions.md](./sessions.md) — what a session is and how the lifecycle works under the hood
- [tools.md](./tools.md) — the full plugin tool surface (council, ultraplan, etc.)
