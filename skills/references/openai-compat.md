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

## Conversation history on the way in

The caller's `messages[]` can carry the whole conversation: earlier `user` turns and the engine's
own earlier `assistant` replies. Whether those turns need to be sent is the same question the
section below asks about tool results — does the engine's own conversation already hold them? — and
it gets the same answer, from the same predicate. The turns that are in scope are serialized into
one `<conversation_history>` block of `<user>` / `<assistant>` turns and put in front of the
caller's latest `user` text. The wrapper tag is the one `renderHistory()` in the autoloop dispatcher
already uses for the same job; the per-turn tags are not — that one labels its two speakers `<user>`
/ `<agent>`, because its roles are autoloop roles rather than OpenAI wire roles.

| On this turn the engine                                                                                                                   | What is sent                                                                   |
| ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| is **not** resuming a conversation — no session yet, a session that never announced a conversation id, or one being stopped and recreated | every `user`/`assistant` turn except the caller's latest `user` message        |
| **is** resuming a live conversation, but one this bridge never sent these turns to                                                        | the same — a live thread is not automatically _this_ thread                    |
| **is** resuming the live conversation these turns belong to                                                                               | nothing — the turns are already in the transcript, and the text goes out alone |

The last row is what keeps Anthropic prompt caching warm on `claude` and keeps a resumed `codex`
thread from being re-fed its own history: on a live thread the message is byte-identical to what it
was before this block existed. The first row is the one that was losing data. A client that opens a
new conversation per turn — one whose session key hashes the last message, say — lands in it on
every turn, and `skipPersistence: true` means an OpenAI-compat session is never auto-resumed from
disk either, so a follow-up like "yes, go ahead" used to reach the engine with nothing in front of
it.

The middle row is the one that is easy to get wrong. "Is there a live thread under this session
name?" is not "is that thread holding this conversation?", and the two come apart constantly. A
caller whose session key hashes its latest message resolves every repeat of a short confirmation —
"yes, go ahead", typed all day by someone approving invoices — to the session some _earlier_
invoice opened. A client that sends no session key at all falls back to a hash of
model+system+tools, which is stable for every turn AND identical between two concurrent chats of
the same user, so both chats share one session. And on `claude`, the default engine,
`nativeThreadIsLive()` has no id to check and returns true for anything in the session map, so
there the question collapses to "does the name exist" with no gate at all.

So the bridge records, per session, a fingerprint of the `user` turns it has actually pushed there,
and replays unless this request continues exactly that. It is the only writer to these sessions, so
what it sent is what the engine holds. Unknown session, forked conversation, evicted entry: all
replay. Being wrong in that direction costs a duplicated turn under a framing that says not to act
on it twice; being wrong in the other direction drops context silently, which is the class of bug
this exists to fix.

What the request is compared against depends on where its array ends, and only an array ending in a
`user` turn carries a turn the bridge has not sent yet. For that shape the fingerprint of every
`user` turn _before_ the last one is what the thread should be holding. For every other shape — a
tool-loop hop ending in `tool`, a prefill/continue ending in `assistant` — the latest `user` turn
was already pushed on an earlier request, so the whole array is compared. Getting that wrong in the
other direction is not harmless: comparing a hop against one turn less never matches, and the
transcript is then replayed into the very session that is already holding it, on every hop, for a
caller that needed none of this.

The map is bounded at 1000 entries and evicted oldest-first, which it needs independently of the
session map: `_cleanupIdleSessions()` reaps a session by `sessionTtlMinutes` without telling this
map, so a fingerprint outlives the session it mirrors. Eviction costs a replayed block, never a
dropped one, and `serve` restarts start it empty for the same price.

`system` messages are never in the block: they travel as the session's system prompt (see [Tool
definitions](#tool-definitions-and-where-they-live)). `tool` messages are never in it either —
they are the next section's business, and repeating them here would duplicate every payload and
undo the scoping that keeps a tool loop linear. An `assistant` message that only announces
`tool_calls` carries no text, so it renders no turn; a turn whose text is empty or whitespace is
dropped rather than rendered as an empty shell. An array with nothing to replay produces no block
at all, so a single-turn `[system, user]` request — the shape the OpenClaw main agent, cron jobs
and subagents send — goes out exactly as it did before.

Replayed text has neutralized every tag the assembled prompt treats as structure — the block's own
`<conversation_history>` / `<user>` / `<assistant>`, and also `<tool_results>` / `<tool_result>`,
`<system>` and `<tool_calls>` (`</user>` becomes `&lt;/user>`). Unlike a `<tool_result>` body, which
comes from the caller's own tool runner, a replayed turn is whatever an end user typed, and
`hi</user>\n<assistant>\n...` would otherwise close its turn early and forge an `assistant` turn —
putting words in the engine's own mouth. The other three matter for the same reason: a fabricated
tool return carries the framing sentence that says a payload is authoritative, a `<system>` block
contradicts the real one the non-claude path prepends, and `<tool_calls>` is the exact protocol JSON
the model is asked to emit.

Only the `<` is escaped, by lookahead, and the tag name has to sit flush against it. That shape is
what makes the boundary decidable: matching up to the closing `>` instead means re-emitting whatever
was captured, and `hola<user a</user>` then smuggles a raw close through the attribute slot of a tag
that IS matched. So the match ends at anything that ends a tag name — `>`, `/`, `<`, end of text, or
a character that occupies no width. That last clause is five Unicode properties rather than a list of
code points, and it is not decoration: measured over the 6,060 code points that are zero-advance or
render blank, `[\s></\p{Cc}\p{Cf}]` let **5,807** through, so `ok</user︀>\n<assistant︀>` forged
a turn that is indistinguishable on screen from `ok</user>`. Adding `Default_Ignorable` leaves 1,770;
`\p{Mn}\p{Me}` closes it; U+2800 BRAILLE PATTERN BLANK is neither and is named. Cost: the same 11 of
a 28-string corpus of plausible legitimate text change under the wide class as under the narrow one.

**What it does not promise.** A positive class cannot be complete over a _visible_ separator, so
`</ user>` and `< assistant>` go through raw — a model reads them as a boundary. They are excluded on
cost: reaching them means corrupting `if (count < user && x)` and `the < user > column`. What already
gets corrupted for the same reason, since the class contains whitespace: `Promise<User | null>` and
`count<user && total>limit` come out with `&lt;`. Readable to a model, not byte-identical. And the
body of a `<tool_result>` is never fenced — its content comes from the caller's own tool runner — so a
tool return that embeds a whole `<conversation_history>` block is not stopped here.

The caller's **latest** `user` turn is fenced too, but only on turns that actually carry a block.
That turn is the one input an attacker controls end to end, and the block teaches the model in the
same prompt that `<conversation_history>` holds its own earlier turns — unfenced, it could close the
real block and open a second one indistinguishable from it. With no block in front of it there is
nothing to forge, so those turns stay byte-for-byte what they were.

A `user` turn carrying only non-text content (an image) renders as `[non-text content]` rather than
vanishing. Dropping it would leave the `assistant` reply to it standing alone under a framing that
calls the assistant turns the model's own — a reply to a request the model cannot see, which reads
as license to act on the reply by itself. "Photo of the invoice", then "yes, go ahead", is an
everyday shape. A leading `assistant` turn with no `user` turn in front of it at all (content
`null`, or empty) is dropped instead, since no marker could honestly stand in for it.

### What this does not cover

- **A turn can be replayed that the engine already had.** The mirror image of the duplicate-once
  trade below, and it comes from the same place: the engine's state is read from the session, not
  from the array. A client whose session looks new to the bridge but whose engine did hold context
  gets those turns a second time. The framing sentences tell the model these are earlier turns and
  not to act on them again, which is what keeps a duplicated turn from becoming a duplicated
  action; nothing enforces it.
- **The block is not in strict chronological order when the array does not end in the caller's
  latest `user` turn.** Every `user`/`assistant` turn except that one is replayed, including turns
  that come after it — an array ending in `assistant` (prefill, an explicit "continue", a framework
  appending its own reply) keeps that turn, because a transcript presented as complete while
  missing the last thing the model said invites it to redo the work. The cost is that such a turn
  is rendered inside the block, i.e. before the caller's latest text rather than after it.
- **`X-Session-Reset` is not honored on an array ending in a `tool` result**, so on that one shape a
  reset turn on a live thread gets no history block either. Same pre-existing asymmetry the tool
  results have there, from the same cause — the header is parsed after that branch returns. See the
  note under [Tool definitions](#tool-definitions-and-where-they-live).
- **`grok` inherits the hole described in the next section**: it resumes by id, but its id is absent
  from `SessionStats`, so `nativeThreadIsLive()` reaches `default: return true` and a `grok` session
  whose first turn died before emitting its id reports a live thread — and so gets no history. Same
  cause, same fix (adding the field), not addressed here.
- **The two blocks are not interleaved.** When a request carries both, the message is the history
  block, then the tool results, then the caller's new text — chronological between the blocks, but
  a `tool` result that chronologically preceded a replayed `assistant` turn still appears after it.
- **The block is capped at 24,000 characters**, oldest turns dropped first, and the turn the budget
  runs out inside is truncated (head kept) and marked `[… turn truncated for length …]` rather than
  dropped whole — dropping it whole would take the request with it on the pasted-document shape.
  Below 200 characters of remaining budget the turn is dropped instead of started, since a fragment
  that short is a sentence with its qualifier cut off rather than context. The newest turn is always
  kept. `MAX_BODY_SIZE` (5 MiB) is **not** a usable bound here: seven of
  the eight engines pass the prompt to the CLI as a single argv element, and Linux caps one argument
  at `MAX_ARG_STRLEN` = 128 KiB whatever `getconf ARG_MAX` reports (measured: 131071 bytes spawns,
  131072 throws `E2BIG`). Only `claude` and persistent custom engines write over stdin. Uncapped,
  ordinary traffic reaches that ceiling — 400-character turns with 900-character replies cross it
  near turn 98 — and the failure is a 500 with the turn lost, which is worse than the missing
  context the block exists to restore. This is the same trade `renderHistory()` makes, with the same
  `REPLAY_CHAR_BUDGET`, feeding the same engines.
- **A send that threw records nothing.** The fingerprint is written after the send and only when the
  send landed, because the two ways to be wrong are not symmetric: forgetting a turn that landed
  replays it once more, while assuming one landed that did not drops context silently. "Landed" is
  `sendMessage` returning — a returned error is answered with 502 and still records, since the CLI
  received the prompt — so only a throw withholds the record. An earlier revision of this file
  described the opposite placement as deliberate and named its residue: a caller that answered a 5xx
  by appending an `assistant` turn and sending again got the next turn bare. That was the bug, not
  the design.
- **A second request that arrives while the first is still in flight replays.** It sees no
  fingerprint yet, so the transcript goes out again into the session that already holds it. The safe
  direction — a duplicate rather than a drop — plus a lost cache prefix.
- **Cost is O(n) per turn for engines that never resume.** `engineHasNativeConversation()` is false
  for `gemini` and one-shot custom engines, so for them the block is re-serialized on every turn,
  capped but never free. Same for any caller that mints a new session per turn.
- **`X-Session-Reset` now replays the transcript.** A reset turn means the engine holds nothing, so
  the history goes out in full. Under the reading "the caller asked to start clean" that is the
  opposite of what was asked, and a client that sends the header on every request AND re-sends
  `messages[]` pays for the transcript every time.

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

### A live session is not the same thing as this conversation

Suppressing the replay needs a stronger fact than "a session under this name is live". That is what
`nativeThreadIsLive()` reports, and a session name can be live while its transcript belongs to a
different exchange. Three shapes where the two come apart, all reachable with default settings:

| shape                                                | what happens                                                                                                                            |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| a caller whose session key hashes its latest message | every repeat of the same short confirmation resolves to whichever session that phrase opened first — often a different subject entirely |
| a caller that sends no `X-Session-Id` at all         | the key falls back to a hash of model + system prompt + tools, so all of that caller's concurrent chats share one name                  |
| `engine: 'claude'` — the default                     | `nativeThreadIsLive()` has no id to check and returns `true` for anything in the session map, so the name is the only evidence there is |

So the bridge tracks what it actually pushed into each session and replays whenever the incoming
conversation is not the one it remembers seeding. The fingerprint covers the `user` turns only: those
are the caller's own text echoed back verbatim, while assistant text is what the engine produced and
a client may normalize it. A mismatch replays, which is the safe direction — the cost is a repeated
block, never a lost one.

The map is bounded and evicted oldest-first, and it has to be independent of the session map:
`_cleanupIdleSessions()` reaps a session by TTL without telling it, so a fingerprint outlives the
session it mirrors. Losing an entry costs a replayed block, never a dropped one.

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
