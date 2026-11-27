# Session Inbox

Cross-session messaging lets the sessions of one orchestrator send each other messages, and answer
them.

## How It Works

Each `SessionManager` keeps a **session forum**: a forum with no workflow run behind it, with the id
`fm-sessions-<pid>-<start>`. A message is a post on it, addressed to its recipient by name and
visible only to the recipient and the sender. The forum is created by the first message (a process
that never sends one writes nothing), and it is kept in `~/.claw-orchestrator/forums/<id>/`. Plain
sessions are not told about the forum: they see only the messages sent to them, in the envelope
below.

```
Session A (planner)          SessionManager           Session B (coder)
     │                            │                        │
     ├── sendTo(B, "do X") ──────►│ post on session forum  │
     │                            ├── B idle? ─── yes ────►│ new turn
     │                            │         │              │
     │                            │    B busy, takes input mid-turn? ──► into the turn in flight
     │                            │         │              │
     │                            │    otherwise: unread   │
     │                            │         │              │
     │     caller ── deliverInbox(B) ─────────────────────►│ unread messages in one turn
     │                            │                        │
     │◄── answer (busy: mid-turn; idle: unread) ◄──────────┤ <new-forum-post re="p00001">…
```

Per recipient:

- **Idle sessions** (ready and not busy) get the message as a new user turn. The call does not wait
  for the recipient's reply
- **A delivered message is an ordinary turn**: it goes through the same send path as `session_send`,
  so the recipient's spend cap applies and the turn gets its own run-ledger row and a place in the
  conversation a handoff carries
- **Busy sessions whose engine takes input mid-turn** — Claude Code (stream-json input) and
  `codex-app` (`turn/steer`) — get the message in the turn in flight. The engine takes it in at its
  next tool round, so it waits for the tool call that is running, not for the turn to end. Measured on
  Claude Code 2.1.327: a message delivered while a 35-second command ran reached the model when that
  command finished, before the next one started. It joins the session's handoff record as a user turn
- **Other busy sessions** (the one-shot engines between turns) keep the message unread in their
  inbox; so does an idle session whose turn could not start — for example one that has reached its
  spend cap
- **Unread messages wait for a caller**: nothing delivers them on its own. Call
  `sessionDeliverInbox()` once the session is idle

For the call:

- Sender and target must be live sessions on this SessionManager, otherwise the call fails. A session
  cannot send a message to itself
- `to: "*"` sends one message to every other plain session (the sender is skipped)
- Returns `{ delivered, queued }`: `delivered` when a recipient got the message at once (a new turn,
  or the turn in flight), `queued` when a recipient's copy waits unread. On a broadcast both can be
  true; a broadcast with nobody to send to returns both false

## Answers

Under each message is one line that tells the recipient how to answer it: a `<new-forum-post>` block
in its reply, naming the message it answers.

```xml
<new-forum-post title="DONE: rate limiting added" re="p00001">Token bucket in auth/limit.ts, 20 req/s.</new-forum-post>
```

The session manager watches the reply of every turn of a plain session, as it streams and once it
ends. Each block becomes a message to the sender of the message named in `re` (only a message that
was sent to the answering session counts), or, when `re` names none, to the sender of the messages
the turn was started with (when they all came from one session). A block in a turn the caller
started, with no `re`, goes nowhere.

An answer never starts a turn of its own: a busy sender with mid-turn input gets it in the turn in
flight, and any other sender finds it unread in its inbox, where `sessionInbox()` shows it and
`sessionDeliverInbox()` hands it over. Two idle sessions therefore cannot keep waking each other with
answers. In the inbox an answer has the block's title as `summary` and its body as `text`.

## Sessions a Run Started

A session that a council, an autoloop, a fan-out, Ultraplan, Ultrareview or a workflow node started
belongs to that run (`SessionConfig.ownerRunId`, set by the mode). Its messages go through the run's
forum, so the cross-session tools leave it out:

- it is not on the session forum, a broadcast skips it, and `team_list` does not list it
- `session_send_to` and `team_send` to it, or from it, fail with
  `Session '<name>' belongs to run <id>: use workflow_forum post on run <id> instead`
- a Claude Code session started this way refuses Claude Code's own peer messages from other sessions
  on the machine (`crossSessionInbound: 'refuse'`) unless the mode set a policy

## Usage

### Send a Message

```typescript
// Direct message
await manager.sessionSendTo('planner', 'coder', 'The auth module needs rate limiting', 'auth rate limit');

// Broadcast to all sessions
await manager.sessionSendTo('monitor', '*', 'Build failed on main!', 'build failure');
```

### Read Inbox

Reading writes nothing; a message counts as read once it was handed to the session (a turn of its
own, the turn in flight, or a flush).

```typescript
// Unread messages only (default)
const unread = manager.sessionInbox('coder');

// All messages
const all = manager.sessionInbox('coder', false);
```

Each entry is `{ from, text, timestamp, read, summary? }`.

### Deliver Unread Messages

When a session finishes a task and becomes idle, deliver its unread messages. All of them go in one
turn, each in its own envelope, and count as read once the turn has started. The call does not wait
for the reply; if the turn cannot start (spend cap reached) it throws and the messages stay unread:

```typescript
const count = await manager.sessionDeliverInbox('coder');
console.log(`Delivered ${count} queued messages`);
```

## Tools

| Tool                    | Description                          |
| ----------------------- | ------------------------------------ |
| `session_send_to`       | Send a message between sessions      |
| `session_inbox`         | Read a session's messages            |
| `session_deliver_inbox` | Deliver unread messages to a session |

`team_send` (CLI: `clawo session-team-send`) sends through the same path, with the summary
`team message from <sender>`. The three tools above have no CLI command. `clawo forum show <id>`
prints a session forum, with `<id>` the name of its directory under `~/.claw-orchestrator/forums/`.

## Message Format

Messages delivered to sessions are wrapped in XML, with the line on answering under it:

```xml
<cross-session-message from="planner" summary="auth rate limit">
The auth module needs rate limiting. Please add a token bucket...
</cross-session-message>
To answer it, write <new-forum-post title="one-line summary" re="p00001">your answer</new-forum-post> in your reply; it goes back to the sender.
```

The `summary` attribute is present only when a summary was given. Attribute values are XML-escaped.
Inside the body, any `cross-session-message`, `forum-post` or `new-forum-post` tag is escaped,
including spellings padded with characters that render as nothing, so a sender can neither forge a
second envelope nor plant a block the recipient would post by quoting it.

## Inbox Limits

- **The inbox is a view**: the newest 200 messages sent to the session, read or not
- **Kept on disk**: messages are posts on the session forum, kept in the forum's store for the life of
  the record. A new process has a new session forum, so mail from before a restart is not delivered
- **Only what the orchestrator sent**: a message is delivered, starts a turn or shows in an inbox only
  when the orchestrator wrote it, and whether it was handed over is the orchestrator's own record. A
  line or a read record written into the forum's spool by anything else is ignored
- **Stopping ends the mail**: `stopSession()` takes the session off the forum and closes its mail, so
  a new session started under the same name receives none of it. A stop that keeps the session
  resumable (`keepPersisted: true`, used when a session is restarted to continue the same
  conversation), a model or tool change, and an idle-timeout cleanup leave the mail waiting for the
  session that next takes the name
