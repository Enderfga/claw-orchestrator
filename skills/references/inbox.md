# Session Inbox

Cross-session messaging allows different sessions to communicate with each other.

## How It Works

```
Session A (planner)          SessionManager           Session B (coder)
     │                            │                        │
     ├── sendTo(B, "do X") ──────►│                        │
     │                            ├── B idle? ─── yes ────►│ deliver immediately
     │                            │         │              │
     │                            │         no             │
     │                            │         │              │
     │                            │    queue in inbox      │
     │                            │         │              │
     │                            │    ... B becomes idle  │
     │     caller ── deliverInbox(B) ─────────────────────►│ deliver queued msgs
```

- **Idle sessions** (ready and not busy) receive messages immediately as a new user turn. The call does not wait for the recipient's reply
- **A delivered message is an ordinary turn**: it goes through the same send path as `session_send`, so the recipient's spend cap applies and the turn gets its own run-ledger row and a place in the conversation a handoff carries
- **Busy sessions** have messages queued in an inbox (max 200 messages); so does an idle session whose turn could not start — for example one that has reached its spend cap
- **Queued messages wait for a caller**: nothing delivers them on its own. Call `sessionDeliverInbox()` once the session is idle
- Messages are wrapped in `<cross-session-message>` XML tags
- Supports broadcast to all sessions via `to: "*"`; a broadcast skips the sender
- Sender and target must be live sessions on this SessionManager, otherwise the call fails
- Returns `{ delivered, queued }`. On a broadcast, `delivered` is true when any recipient got the message at once and `queued` when any recipient's copy was queued; a broadcast that fails for one recipient is logged and does not stop the others

## Usage

### Send a Message

```typescript
// Direct message
await manager.sessionSendTo('planner', 'coder', 'The auth module needs rate limiting', 'auth rate limit');

// Broadcast to all sessions
await manager.sessionSendTo('monitor', '*', 'Build failed on main!', 'build failure');
```

### Read Inbox

```typescript
// Unread messages only (default)
const unread = manager.sessionInbox('coder');

// All messages
const all = manager.sessionInbox('coder', false);
```

### Deliver Queued Messages

When a session finishes a task and becomes idle, deliver its queued messages. All unread messages go in one turn, each in its own envelope, and are marked read. The call does not wait for the reply; if the turn cannot start (spend cap reached) it throws and the messages stay unread:

```typescript
const count = await manager.sessionDeliverInbox('coder');
console.log(`Delivered ${count} queued messages`);
```

## Tools

| Tool                    | Description                             |
| ----------------------- | --------------------------------------- |
| `session_send_to`       | Send message between sessions           |
| `session_inbox`         | Read inbox messages                     |
| `session_deliver_inbox` | Deliver queued messages to idle session |

`team_send` (CLI: `clawo session-team-send`) sends through the same inbox, with the summary `team message from <sender>`. The three tools above have no CLI command.

## Message Format

Messages delivered to sessions are wrapped in XML:

```xml
<cross-session-message from="planner" summary="auth rate limit">
The auth module needs rate limiting. Please add a token bucket...
</cross-session-message>
```

The `summary` attribute is present only when a summary was given. Attribute values are XML-escaped, and any `cross-session-message` tag inside the body is escaped, so a sender cannot forge a second envelope.

## Inbox Limits

- **Max size**: 200 messages per session
- **Eviction**: oldest read messages dropped first, then oldest unread
- **No TTL**: messages, read or unread, stay in memory until evicted, the session is stopped, or the process exits. They are not persisted to disk.
- **Stopping clears the inbox**: `stopSession()` drops the session's messages, so a new session started under the same name does not receive mail meant for the old one. A stop that keeps the session resumable (`keepPersisted: true`, used when a session is restarted to continue the same conversation) leaves them in place.
