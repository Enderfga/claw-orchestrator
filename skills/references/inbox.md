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
     │                            ├── deliverInbox(B) ────►│ deliver queued msgs
```

- **Idle sessions** receive messages immediately as a new user turn
- **Busy sessions** have messages queued in an inbox (max 200 messages)
- Messages are wrapped in `<cross-session-message>` XML tags
- Supports broadcast to all sessions via `to: "*"`; a broadcast skips the sender
- Sender and target must be existing sessions, otherwise the call fails
- Returns `{ delivered, queued }`

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

When a session finishes a task and becomes idle, deliver its queued messages:

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

## Message Format

Messages delivered to sessions are wrapped in XML:

```xml
<cross-session-message from="planner" summary="auth rate limit">
The auth module needs rate limiting. Please add a token bucket...
</cross-session-message>
```

Attribute values are XML-escaped, and any `cross-session-message` tag inside the body is escaped, so a sender cannot forge a second envelope.

## Inbox Limits

- **Max size**: 200 messages per session
- **Eviction**: oldest read messages dropped first, then oldest unread
- **No TTL**: messages, read or unread, stay in memory until evicted or the process exits. They are not persisted to disk.
