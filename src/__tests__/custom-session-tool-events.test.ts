/**
 * A persistent custom engine speaks claude's stream-json, where every tool_use
 * block arrives twice: on `content_block_start` with an empty input, then as an
 * `assistant` event with the same id and the full input.
 */
import { describe, it, expect } from 'vitest';
import { PersistentCustomSession } from '../persistent-custom-session.js';
import { SESSION_EVENT } from '../constants.js';

describe('PersistentCustomSession tool events', () => {
  it('reports each tool call once, with its input', () => {
    const session = new PersistentCustomSession({
      name: 'custom-tools',
      cwd: process.cwd(),
      customEngine: { name: 'stream-json-cli', bin: 'node', persistent: true },
    });
    const seen: unknown[] = [];
    session.on(SESSION_EVENT.TOOL_USE, (e: unknown) => seen.push(e));
    const feed = (session as unknown as { _handlePersistentEvent(e: unknown): void })._handlePersistentEvent.bind(
      session,
    );

    for (const [id, command] of [
      ['toolu_1', 'echo one'],
      ['toolu_2', 'echo two'],
    ]) {
      feed({
        type: 'stream_event',
        event: { type: 'content_block_start', content_block: { type: 'tool_use', id, name: 'Bash', input: {} } },
      });
      feed({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } });
    }

    expect(session.getStats().toolCalls).toBe(2);
    expect(seen).toEqual([
      { tool: { name: 'Bash', input: { command: 'echo one' } } },
      { tool: { name: 'Bash', input: { command: 'echo two' } } },
    ]);
  });
});
