/**
 * ACP `session/resume` and `session/list`, driven over a real client connection.
 *
 * The session layer keeps each engine's own resume handle under the ACP session
 * id, so a client can reattach to a session after the editor or the agent
 * process restarts. `session/load` stays unadvertised: it requires replaying the
 * conversation, which no engine hands back.
 */
import { describe, expect, it } from 'vitest';
import * as acp from '@agentclientprotocol/sdk';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { cancelAcpTurn, createAcpAgent, emitImages } from '../acp-server.js';

type Persisted = { name: string; cwd: string; engine?: 'claude' | 'codex'; model?: string; lastActivity: number };

/**
 * Mirrors the SessionManager surface the adapter uses, including that a session
 * the manager no longer holds in memory refuses a send.
 */
function fakeManager(persisted: Persisted[] = []) {
  const starts: Array<Record<string, unknown>> = [];
  const stops: Array<{ name: string; keepPersisted?: boolean }> = [];
  const live = new Set<string>();
  const manager = {
    starts,
    stops,
    async startSession(config: Record<string, unknown>) {
      starts.push(config);
      live.add(String(config.name));
      return { name: String(config.name) };
    },
    async sendMessage(name: string) {
      if (!live.has(name)) throw new Error(`Session '${name}' not found`);
      return { output: 'ok' };
    },
    async stopSession(name: string, opts?: { keepPersisted?: boolean }) {
      stops.push({ name, keepPersisted: opts?.keepPersisted });
      live.delete(name);
    },
    hasSession: (name: string) => live.has(name),
    listPersistedSessions: () => persisted,
    /** What the idle-TTL sweep does: drop the session from memory, keep it on disk. */
    reap: (name: string) => void live.delete(name),
  };
  return manager;
}

async function connect(manager: ReturnType<typeof fakeManager>) {
  const app = createAcpAgent(manager as never, { defaultModel: 'claude-sonnet-4-6' });
  const conn = acp
    .client({ name: 'test-editor' })
    .onNotification('session/update', () => {})
    .connect(app);
  const init = await conn.agent.request('initialize', {
    protocolVersion: acp.PROTOCOL_VERSION,
    clientCapabilities: {},
  });
  return { conn, init };
}

describe('ACP session resume and list', () => {
  it('advertises resume and list, not load', async () => {
    const { conn, init } = await connect(fakeManager());
    expect(init.agentCapabilities?.loadSession).toBe(false);
    expect(init.agentCapabilities?.sessionCapabilities).toMatchObject({ resume: {}, list: {} });
    conn.close();
  });

  it('starts new sessions persisted, so they can be resumed later', async () => {
    const manager = fakeManager();
    const { conn } = await connect(manager);
    await conn.agent.request('session/new', { cwd: '/repo', mcpServers: [] });
    expect(manager.starts[0]).not.toHaveProperty('skipPersistence');
    conn.close();
  });

  it('resumes a saved session by name, on its engine and model', async () => {
    const manager = fakeManager([
      { name: 'acp-abc', cwd: '/repo', engine: 'codex', model: 'gpt-6-sol', lastActivity: 1_000 },
    ]);
    const { conn } = await connect(manager);
    const res = await conn.agent.request('session/resume', { sessionId: 'acp-abc', cwd: '/repo' });
    expect(manager.starts).toEqual([
      expect.objectContaining({ name: 'acp-abc', cwd: '/repo', engine: 'codex', model: 'gpt-6-sol' }),
    ]);
    expect(res.modes?.currentModeId).toBe('single');
    // The resumed session takes prompts like a new one.
    await expect(
      conn.agent.request('session/prompt', { sessionId: 'acp-abc', prompt: [{ type: 'text', text: 'hi' }] }),
    ).resolves.toMatchObject({ stopReason: 'end_turn' });
    conn.close();
  });

  it('refuses an unknown session, a non-ACP session, and a different working directory', async () => {
    const manager = fakeManager([
      { name: 'acp-abc', cwd: '/repo', lastActivity: 1 },
      { name: 'robot-wx', cwd: '/home', lastActivity: 2 },
    ]);
    const { conn } = await connect(manager);
    await expect(conn.agent.request('session/resume', { sessionId: 'acp-nope', cwd: '/repo' })).rejects.toMatchObject({
      code: -32602,
      data: expect.stringMatching(/Unknown session/),
    });
    await expect(conn.agent.request('session/resume', { sessionId: 'robot-wx', cwd: '/home' })).rejects.toMatchObject({
      code: -32602,
      data: expect.stringMatching(/Unknown session/),
    });
    await expect(
      conn.agent.request('session/resume', { sessionId: 'acp-abc', cwd: '/elsewhere' }),
    ).rejects.toMatchObject({ code: -32602, data: expect.stringMatching(/belongs to \/repo/) });
    expect(manager.starts).toEqual([]);
    conn.close();
  });

  it('lists only ACP sessions, newest first, filtered by cwd', async () => {
    const manager = fakeManager([
      { name: 'acp-old', cwd: '/repo', lastActivity: 1_000 },
      { name: 'acp-new', cwd: '/repo', lastActivity: 3_000 },
      { name: 'acp-other', cwd: '/other', lastActivity: 2_000 },
      { name: 'robot-wx', cwd: '/repo', lastActivity: 4_000 },
    ]);
    const { conn } = await connect(manager);
    const all = await conn.agent.request('session/list', {});
    expect(all.sessions.map((s) => s.sessionId)).toEqual(['acp-new', 'acp-other', 'acp-old']);
    const repo = await conn.agent.request('session/list', { cwd: '/repo' });
    expect(repo.sessions.map((s) => s.sessionId)).toEqual(['acp-new', 'acp-old']);
    expect(repo.sessions[0].updatedAt).toBe(new Date(3_000).toISOString());
    conn.close();
  });

  it('keeps the conversation when a permission change restarts the session', async () => {
    const manager = fakeManager();
    const { conn } = await connect(manager);
    const { sessionId } = await conn.agent.request('session/new', { cwd: '/repo', mcpServers: [] });
    await conn.agent.request('session/set_config_option', { sessionId, configId: 'permission', value: 'plan' });
    expect(manager.stops).toEqual([{ name: sessionId, keepPersisted: true }]);
    conn.close();
  });

  it('refuses a permission mode the selector does not offer, and keeps the session as it was', async () => {
    const manager = fakeManager();
    const { conn } = await connect(manager);
    const { sessionId } = await conn.agent.request('session/new', { cwd: '/repo', mcpServers: [] });
    await expect(
      conn.agent.request('session/set_config_option', { sessionId, configId: 'permission', value: 'yolo' }),
    ).rejects.toMatchObject({ code: -32602, data: expect.stringMatching(/permission mode/) });
    expect(manager.stops).toEqual([]);
    expect(manager.starts).toHaveLength(1);
    conn.close();
  });
});

// The manager stops a session idle past its TTL and keeps only the persisted
// resume handle; the adapter still holds the ACP session, so it has to bring the
// engine session back rather than fail on a name the manager no longer knows.
describe('ACP sessions the manager dropped for idling', () => {
  it('restarts the session on the next prompt, with the same engine, model and permission', async () => {
    const manager = fakeManager();
    const { conn } = await connect(manager);
    const { sessionId } = await conn.agent.request('session/new', { cwd: '/repo', mcpServers: [] });
    manager.reap(sessionId);

    await expect(
      conn.agent.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'still there?' }] }),
    ).resolves.toMatchObject({ stopReason: 'end_turn' });
    expect(manager.starts).toHaveLength(2);
    expect(manager.starts[1]).toEqual(manager.starts[0]);
    conn.close();
  });

  it('restarts the session on session/resume rather than treating the id as live', async () => {
    const manager = fakeManager();
    const { conn } = await connect(manager);
    const { sessionId } = await conn.agent.request('session/new', { cwd: '/repo', mcpServers: [] });
    manager.reap(sessionId);

    await conn.agent.request('session/resume', { sessionId, cwd: '/repo' });
    expect(manager.starts).toHaveLength(2);
    expect(manager.hasSession(sessionId)).toBe(true);
    conn.close();
  });

  it('leaves a live session alone', async () => {
    const manager = fakeManager();
    const { conn } = await connect(manager);
    const { sessionId } = await conn.agent.request('session/new', { cwd: '/repo', mcpServers: [] });
    await conn.agent.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'hi' }] });
    await conn.agent.request('session/resume', { sessionId, cwd: '/repo' });
    expect(manager.starts).toHaveLength(1);
    conn.close();
  });
});

describe('cancelAcpTurn keeps the conversation', () => {
  it('restarts with the persisted resume handle kept', async () => {
    const manager = fakeManager();
    const state = {
      name: 'acp-x',
      cwd: '/tmp',
      model: 'claude-sonnet-4-6',
      engine: 'claude',
      permissionMode: 'plan',
      modeId: 'single',
      cancelInFlight: () => {},
    } as Parameters<typeof cancelAcpTurn>[1];
    expect(cancelAcpTurn(manager as never, state)).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(manager.stops).toEqual([{ name: 'acp-x', keepPersisted: true }]);
  });
});

describe('emitImages', () => {
  it('names each image by path and sends it as an image block', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawo-acp-img-'));
    const png = path.join(dir, 'a.png');
    fs.writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const updates: Array<Record<string, unknown>> = [];
    await emitImages([{ path: png }, { path: path.join(dir, 'missing.png') }], async (u) => void updates.push(u));
    const contents = updates.map((u) => u.content as Record<string, unknown>);
    expect(contents[0]).toMatchObject({ type: 'text', text: expect.stringContaining(png) });
    expect(contents[1]).toEqual({ type: 'image', data: 'iVBORw==', mimeType: 'image/png' });
    // An unreadable file is still named, and nothing else is sent for it.
    expect(contents[2]).toMatchObject({ type: 'text', text: expect.stringContaining('missing.png') });
    expect(contents).toHaveLength(3);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
