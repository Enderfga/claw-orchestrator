/**
 * The Codex command table, its RPC helpers, the quota reader, and the rollout readers.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  codexBuiltinCommands,
  codexItemLine,
  codexQuotaFromRateLimits,
  codexSandboxPolicy,
  codexShellArgv,
  codexReviewTarget,
  codexTurnCommand,
  codexSkillCommands,
  revertCodexTurns,
  runCodexInfoCommand,
  unknownCodexCommand,
} from '../codex-commands.js';
import { readCodexQuota } from '../codex-quota.js';
import { quotaEngines } from '../engine-quota.js';
import { findCodexRollout, reviewRolloutUsage, subAgentThreadIds, subAgentUsage } from '../codex-rollout.js';
import type { CodexRpc } from '../codex-app-client.js';

/** An RPC that answers from a table and records what it was asked. */
function rpc(
  answers: Record<string, unknown>,
): CodexRpc & { calls: Array<[string, unknown]>; timeouts: Array<number | undefined> } {
  const calls: Array<[string, unknown]> = [];
  const timeouts: Array<number | undefined> = [];
  return {
    calls,
    timeouts,
    async request(method: string, params: unknown, timeoutMs?: number) {
      calls.push([method, params]);
      timeouts.push(timeoutMs);
      if (!(method in answers)) throw new Error(`unexpected ${method}`);
      const a = answers[method];
      return typeof a === 'function' ? (a as (p: unknown) => unknown)(params) : a;
    },
  };
}

describe('codex command table', () => {
  it('offers ps, stop and diff on codex-app only, and shell only on danger-full-access', () => {
    const exec = codexBuiltinCommands({ engine: 'codex', sandboxMode: 'workspace-write' }).map((c) => c.name);
    const app = codexBuiltinCommands({ engine: 'codex-app', sandboxMode: 'workspace-write' }).map((c) => c.name);
    const open = codexBuiltinCommands({ engine: 'codex-app', sandboxMode: 'danger-full-access' }).map((c) => c.name);
    expect(exec).not.toContain('ps');
    expect(exec).not.toContain('diff');
    expect(app).toEqual(expect.arrayContaining(['ps', 'stop', 'diff', 'review', 'compact', 'status']));
    expect(app).not.toContain('shell');
    expect(open).toContain('shell');
  });

  it('maps review arguments to review/start targets', () => {
    expect(codexReviewTarget(undefined)).toEqual({ type: 'uncommittedChanges' });
    expect(codexReviewTarget('uncommitted')).toEqual({ type: 'uncommittedChanges' });
    expect(codexReviewTarget('base main')).toEqual({ type: 'baseBranch', branch: 'main' });
    expect(codexReviewTarget('commit 1a2b3c')).toEqual({ type: 'commit', sha: '1a2b3c' });
    expect(codexReviewTarget('focus on the parser')).toEqual({ type: 'custom', instructions: 'focus on the parser' });
  });

  it('takes /plan or a skill as turnCommand, and refuses a built-in or text', () => {
    expect(codexTurnCommand(undefined)).toBeUndefined();
    expect(codexTurnCommand('/plan')).toEqual({ plan: true });
    expect(codexTurnCommand('$my-skill')).toEqual({ skill: 'my-skill' });
    expect(() => codexTurnCommand('/review')).toThrow(/turnCommand on Codex/);
    expect(() => codexTurnCommand('/plan now')).toThrow(/turnCommand on Codex/);
  });

  it('points a TUI command clawo offers elsewhere to its home', () => {
    expect(unknownCodexCommand('goal', 'codex-app').message).toMatch(/codex_goal_set/);
    expect(unknownCodexCommand('vim', 'codex').message).toMatch(/TUI only/);
  });

  it('lists enabled skills as commands, a built-in name winning', () => {
    const builtins = codexBuiltinCommands({ engine: 'codex' });
    const cmds = codexSkillCommands(
      [
        { name: 'a', path: '/a', enabled: true, description: 'A' },
        { name: 'status', path: '/s', enabled: true },
        { name: 'off', path: '/o', enabled: false },
      ],
      builtins,
    );
    expect(cmds).toEqual([{ name: 'a', source: 'skill', startsTurn: true, args: '[message]', description: 'A' }]);
  });

  it("counts only turns a user message started: a review's turn and its inner turn are dropped with the turn before", async () => {
    // As 0.172.0 lists a thread after a review: the review turn (no user message), its
    // reviewer's inner turn, then two user turns.
    const r = rpc({
      'thread/turns/list': {
        data: [
          { id: 'rev', rootTurnId: 'rev', items: [{ type: 'agentMessage' }] },
          { id: 'inner', rootTurnId: 'rev', items: [{ type: 'userMessage' }] },
          { id: 'u2', rootTurnId: 'u2', items: [{ type: 'userMessage' }, { type: 'agentMessage' }] },
          { id: 'u1', rootTurnId: 'u1', items: [{ type: 'userMessage' }] },
        ],
        nextCursor: null,
      },
      'thread/revert': {},
    });
    await revertCodexTurns(r, 'T', 1);
    expect(r.calls.at(-1)).toEqual(['thread/revert', { threadId: 'T', beforeTurnId: 'u2' }]);
  });

  it('reverts to before the oldest of the newest N turns', async () => {
    const r = rpc({ 'thread/turns/list': { data: [{ id: 'c' }, { id: 'b' }], nextCursor: null }, 'thread/revert': {} });
    await revertCodexTurns(r, 'T', 2);
    expect(r.calls.at(-1)).toEqual(['thread/revert', { threadId: 'T', beforeTurnId: 'b' }]);
    await expect(revertCodexTurns(r, 'T', 3)).rejects.toThrow(/fewer than 3/);
  });
});

describe('codex info commands', () => {
  it('summarises MCP servers, plugins and apps instead of returning megabytes', async () => {
    const r = rpc({
      'mcpServerStatus/list': {
        data: [{ name: 'gh', tools: { a: {}, b: {} }, authStatus: 'ok', toolListMeta: 'x'.repeat(1000) }],
      },
      'plugin/installed': {
        marketplaces: [{ name: 'curated', plugins: [{ id: 'gmail@c', enabled: true, version: '1.0' }] }],
      },
      'app/installed': { apps: [{ id: 'connector_1', runtimeName: 'Sites', enabled: false, callable: true }] },
    });
    const mcp = await runCodexInfoCommand(r, 'mcp', undefined, { engine: 'codex' });
    expect(mcp?.data).toEqual([{ name: 'gh', auth: 'ok', tools: 2 }]);
    const plugins = await runCodexInfoCommand(r, 'plugins', undefined, { engine: 'codex', cwd: '/w' });
    expect(plugins?.text).toBe('gmail@c 1.0');
    expect(r.calls.find((c) => c[0] === 'plugin/installed')?.[1]).toEqual({ cwds: ['/w'] });
    const apps = await runCodexInfoCommand(r, 'apps', undefined, { engine: 'codex' });
    expect(apps?.text).toBe('Sites (disabled)');
  });

  it('reports configuration keys, never MCP server settings that can hold credentials', async () => {
    const r = rpc({
      'config/read': {
        config: {
          model: 'gpt-6',
          sandbox_mode: null,
          mcp_servers: { gh: { env: { GITHUB_TOKEN: 'ghp_secret' } } },
          model_providers: { x: { http_headers: { Authorization: 'Bearer y' } } },
          features: { memories: true },
        },
      },
    });
    const out = await runCodexInfoCommand(r, 'config', undefined, { engine: 'codex' });
    expect(out?.data).toEqual({ model: 'gpt-6', features: { memories: true }, mcp_servers: ['gh'] });
    expect(JSON.stringify(out)).not.toContain('ghp_secret');
    expect(JSON.stringify(out)).not.toContain('Bearer');
  });

  it('sets the thread memory mode with an argument, and needs the thread for it', async () => {
    const r = rpc({ 'thread/memoryMode/set': {}, 'memory/status': { v2Ready: false } });
    await expect(runCodexInfoCommand(r, 'memories', 'off', { engine: 'codex' })).rejects.toThrow(
      /send a first message/,
    );
    const out = await runCodexInfoCommand(r, 'memories', 'off', { engine: 'codex-app', threadId: 'T' });
    expect(out?.ok).toBe(true);
    expect(r.calls.at(-1)).toEqual(['thread/memoryMode/set', { threadId: 'T', mode: 'disabled' }]);
    expect(await runCodexInfoCommand(r, 'nope', undefined, { engine: 'codex' })).toBeUndefined();
  });
});

describe('codex app-server reads, the queue and exec', () => {
  it('offers queue, turn and implement on codex-app only, and the thread reads and exec on both', () => {
    const exec = codexBuiltinCommands({ engine: 'codex' });
    const app = codexBuiltinCommands({ engine: 'codex-app' });
    const both = ['thread', 'items', 'search', 'threads', 'modes', 'providers', 'requirements', 'exec'];
    expect(exec.map((c) => c.name)).toEqual(expect.arrayContaining(both));
    expect(app.map((c) => c.name)).toEqual(expect.arrayContaining([...both, 'queue', 'turn', 'implement']));
    for (const name of ['queue', 'turn', 'implement']) expect(exec.map((c) => c.name)).not.toContain(name);
    // A queued message and a turn change run beside the turn in flight; implement runs one.
    expect(app.find((c) => c.name === 'queue')?.startsTurn).toBe(false);
    expect(app.find((c) => c.name === 'turn')?.startsTurn).toBe(false);
    expect(app.find((c) => c.name === 'exec')?.startsTurn).toBe(false);
    expect(app.find((c) => c.name === 'implement')?.startsTurn).toBe(true);
    expect(unknownCodexCommand('queue', 'codex').message).toMatch(/runs on codex-app only/);
  });

  it("builds the sandbox policy of a session's mode, and runs a command through the platform shell", () => {
    expect(codexSandboxPolicy('read-only')).toEqual({ type: 'readOnly', networkAccess: false });
    expect(codexSandboxPolicy('danger-full-access')).toEqual({ type: 'dangerFullAccess' });
    expect(codexSandboxPolicy(undefined, ['/extra'])).toEqual({
      type: 'workspaceWrite',
      writableRoots: ['/extra'],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    });
    expect(codexShellArgv('ls | wc -l', 'darwin')).toEqual(['/bin/sh', '-c', 'ls | wc -l']);
    expect(codexShellArgv('dir', 'win32')).toEqual(['cmd.exe', '/d', '/s', '/c', 'dir']);
  });

  it("runs exec in the session's sandbox and directory, and reports a failed exit", async () => {
    const policy = { type: 'readOnly', networkAccess: true };
    const r = rpc({
      'command/exec': (p: { command: string[] }) =>
        p.command[2] === 'false'
          ? { exitCode: 1, stdout: '', stderr: 'no\n' }
          : { exitCode: 0, stdout: 'hi\n', stderr: 'warn\n' },
    });
    const ctx = { engine: 'codex' as const, cwd: '/w', sandboxPolicy: policy, timeoutMs: 5000 };
    const out = await runCodexInfoCommand(r, 'exec', 'echo hi', ctx);
    expect(out).toEqual({
      name: 'exec',
      ok: true,
      text: 'hi\n[stderr]\nwarn\n',
      data: { exitCode: 0, stdout: 'hi\n', stderr: 'warn\n' },
      startedTurn: false,
    });
    expect(r.calls[0]).toEqual([
      'command/exec',
      { command: [...codexShellArgv('echo hi')], cwd: '/w', sandboxPolicy: policy, timeoutMs: 5000 },
    ]);
    // The request outlives the command's own timeout, so the exit code arrives.
    expect(r.timeouts[0]).toBeGreaterThan(5000);
    const failed = await runCodexInfoCommand(r, 'exec', 'false', ctx);
    expect(failed).toMatchObject({ ok: false, error: 'the command exited with 1' });
    await expect(runCodexInfoCommand(r, 'exec', ' ', ctx)).rejects.toThrow(/takes the command/);
  });

  it('adds how the account signs in to /status, never its address or ids', async () => {
    const r = rpc({
      'account/rateLimits/read': {
        rateLimits: { limitId: 'codex', primary: { usedPercent: 5, windowDurationMins: 10080 }, planType: 'pro' },
      },
      'account/read': {
        account: { type: 'chatgpt', email: 'someone@example.com', planType: 'pro', workspaceName: null },
        userId: 'user-123',
        requiresOpenaiAuth: true,
      },
    });
    const out = await runCodexInfoCommand(r, 'status', undefined, { engine: 'codex' });
    expect(out?.text.split('\n')[0]).toBe('signed in: ChatGPT');
    expect((out?.data as { account?: unknown }).account).toEqual({ kind: 'ChatGPT', plan: 'pro' });
    expect(JSON.stringify(out)).not.toContain('someone@example.com');
    expect(JSON.stringify(out)).not.toContain('user-123');
  });

  it('reads the stored thread, and on codex-app the threads loaded with it', async () => {
    const r = rpc({
      'thread/read': {
        thread: {
          id: 'T',
          name: 'fix',
          status: { type: 'idle' },
          model: 'gpt-5.5',
          cwd: '/w',
          path: '/h/rollout-T.jsonl',
          gitInfo: { branch: 'main', sha: 'abc', originUrl: 'https://example.com/r.git' },
          createdAt: 1_795_856_490,
          ephemeral: false,
        },
      },
      'thread/loaded/list': { data: ['T', 'sub-1'], nextCursor: null },
    });
    const exec = await runCodexInfoCommand(r, 'thread', undefined, { engine: 'codex', threadId: 'T' });
    expect(r.calls.map((c) => c[0])).toEqual(['thread/read']);
    expect(r.calls[0][1]).toEqual({ threadId: 'T', includeTurns: false });
    expect(exec?.text).toContain('status: idle');
    expect(exec?.text).toContain('rollout: /h/rollout-T.jsonl');
    expect(exec?.data).toMatchObject({ git: { branch: 'main', sha: 'abc' }, createdAt: '2026-11-28T09:01:30.000Z' });
    const app = await runCodexInfoCommand(r, 'thread', undefined, { engine: 'codex-app', threadId: 'T' });
    expect(app?.data).toMatchObject({ loadedThreads: ['T', 'sub-1'] });
    await expect(runCodexInfoCommand(r, 'thread', undefined, { engine: 'codex' })).rejects.toThrow(/first message/);
  });

  it("reads the thread's last items in order, a turn's items, or the items named", async () => {
    const entry = (turnId: string, item: Record<string, unknown>) => ({ turnId, item });
    const r = rpc({
      'thread/items/list': (p: { turnId?: string }) =>
        p.turnId
          ? { data: [entry('u1', { id: 'c', type: 'commandExecution', command: 'ls', exitCode: 0 })], nextCursor: 'x' }
          : {
              data: [
                entry('u2', { id: 'm', type: 'agentMessage', text: 'Done.' }),
                entry('u2', { id: 'q', type: 'userMessage', content: [{ type: 'text', text: 'Fix it' }] }),
              ],
              nextCursor: 'more',
            },
      'thread/items/read': { data: [entry('u1', { id: 'f', type: 'fileChange', changes: [{ path: 'a.py' }] })] },
    });
    const ctx = { engine: 'codex' as const, threadId: 'T' };
    const last = await runCodexInfoCommand(r, 'items', undefined, ctx);
    expect(r.calls[0][1]).toEqual({ threadId: 'T', limit: 20, sortDirection: 'desc' });
    expect(last?.text).toBe('u2 q userMessage: Fix it\nu2 m agentMessage: Done.\n… earlier items: /items <turnId>');
    const turn = await runCodexInfoCommand(r, 'items', 'u1', ctx);
    expect(r.calls[1][1]).toEqual({ threadId: 'T', turnId: 'u1', limit: 200 });
    expect(turn?.text).toBe('u1 c commandExecution: ls → exit 0\n… the turn has more items');
    const named = await runCodexInfoCommand(r, 'items', 'u1 f', ctx);
    expect(r.calls[2]).toEqual(['thread/items/read', { threadId: 'T', turnId: 'u1', itemIds: ['f'] }]);
    expect(named?.text).toBe('u1 f fileChange: a.py');
    expect(codexItemLine({ turnId: 't', item: { id: 'r', type: 'reasoning', summary: ['Looking', 'around'] } })).toBe(
      't r reasoning: Looking around',
    );
  });

  it('finds text in the thread, and across the local history', async () => {
    const r = rpc({
      'thread/searchOccurrences': { data: [{ turnId: 'u1', itemId: 'i1', snippet: 'Reply with LUNA' }] },
      'thread/search': { data: [{ thread: { id: 'T2', name: 'luna', cwd: '/w', updatedAt: 1 }, snippet: 'LUNA-OK' }] },
    });
    const inThread = await runCodexInfoCommand(r, 'search', 'LUNA', { engine: 'codex', threadId: 'T' });
    expect(r.calls[0]).toEqual(['thread/searchOccurrences', { threadId: 'T', searchTerm: 'LUNA', limit: 50 }]);
    expect(inThread?.text).toBe('u1 i1: Reply with LUNA');
    const history = await runCodexInfoCommand(r, 'threads', 'LUNA', { engine: 'codex' });
    expect(r.calls[1][1]).toMatchObject({
      searchTerm: 'LUNA',
      sourceKinds: expect.arrayContaining(['exec', 'vscode']),
    });
    expect(history?.text).toBe('T2 (luna): LUNA-OK');
    await expect(runCodexInfoCommand(r, 'search', '', { engine: 'codex', threadId: 'T' })).rejects.toThrow(
      /text to find/,
    );
  });

  it('lists collaboration modes, providers without their settings, and requirements without provider entries', async () => {
    const r = rpc({
      'collaborationMode/list': {
        data: [
          { name: 'Plan', mode: 'plan', model: null, reasoning_effort: 'medium' },
          { name: 'Default', mode: 'default', model: null, reasoning_effort: null },
        ],
      },
      'modelProvider/list': {
        data: [
          { id: 'openai', name: 'OpenAI', settings: { type: 'openai' } },
          { id: 'vertex', name: 'Vertex', settings: { type: 'gcp', credentialFile: '/secret/key.json' } },
        ],
        defaultProviderId: 'openai',
      },
      'modelProvider/capabilities/read': { imageGeneration: true, webSearch: false },
      'configRequirements/read': (() => {
        let n = 0;
        return () =>
          n++ === 0
            ? { requirements: null }
            : {
                requirements: {
                  allowedSandboxModes: ['read-only'],
                  modelProviders: { corp: { base_url: 'https://gw.example.com', headers: { k: 'v' } } },
                  logDir: null,
                },
              };
      })(),
    });
    const modes = await runCodexInfoCommand(r, 'modes', undefined, { engine: 'codex' });
    expect(modes?.text).toBe('Plan (plan), effort medium\nDefault (default)');
    const providers = await runCodexInfoCommand(r, 'providers', undefined, { engine: 'codex' });
    expect(providers?.text).toBe(
      'openai (OpenAI) [default]\nvertex (Vertex)\ncurrent provider: image generation yes, web search no',
    );
    expect(JSON.stringify(providers)).not.toContain('/secret/key.json');
    const none = await runCodexInfoCommand(r, 'requirements', undefined, { engine: 'codex' });
    expect(none?.text).toMatch(/restricts nothing/);
    const req = await runCodexInfoCommand(r, 'requirements', undefined, { engine: 'codex' });
    expect(req?.data).toEqual({ allowedSandboxModes: ['read-only'], modelProviders: ['corp'] });
    expect(JSON.stringify(req)).not.toContain('gw.example.com');
  });

  it("drives the thread's message queue", async () => {
    const r = rpc({
      'thread/queue/list': {
        data: [{ id: 'q1', input: [{ type: 'text', text: 'next step', text_elements: [] }] }],
        nextCursor: null,
      },
      'thread/queue/add': { queuedSubmission: { id: 'q2' } },
      'thread/queue/delete': (p: { queuedSubmissionId: string }) => ({ deleted: p.queuedSubmissionId === 'q1' }),
      'thread/queue/update': {},
      'thread/queue/reorder': {},
      'thread/queue/start': { turn: { id: 'turn-q' } },
    });
    const ctx = { engine: 'codex-app' as const, threadId: 'T' };
    expect((await runCodexInfoCommand(r, 'queue', undefined, ctx))?.text).toBe('q1: next step');
    const added = await runCodexInfoCommand(r, 'queue', 'add  run the tests\nthen report', ctx);
    expect(added?.data).toEqual({ id: 'q2' });
    const addParams = r.calls[1][1] as Record<string, unknown>;
    expect(addParams).toMatchObject({
      threadId: 'T',
      input: [{ type: 'text', text: 'run the tests\nthen report', text_elements: [] }],
    });
    expect(typeof addParams.clientUserMessageId).toBe('string');
    expect((await runCodexInfoCommand(r, 'queue', 'delete q1', ctx))?.ok).toBe(true);
    expect((await runCodexInfoCommand(r, 'queue', 'delete q9', ctx))?.ok).toBe(false);
    await runCodexInfoCommand(r, 'queue', 'update q2 run only the unit tests', ctx);
    expect(r.calls.at(-1)).toEqual([
      'thread/queue/update',
      {
        threadId: 'T',
        queuedSubmissionId: 'q2',
        input: [{ type: 'text', text: 'run only the unit tests', text_elements: [] }],
      },
    ]);
    await runCodexInfoCommand(r, 'queue', 'reorder q2 q1', ctx);
    expect(r.calls.at(-1)).toEqual(['thread/queue/reorder', { threadId: 'T', queuedSubmissionIds: ['q2', 'q1'] }]);
    const started = await runCodexInfoCommand(r, 'queue', 'start', ctx);
    expect(r.calls.at(-1)).toEqual(['thread/queue/start', { threadId: 'T' }]);
    expect(started?.data).toEqual({ turnId: 'turn-q' });
    await expect(runCodexInfoCommand(r, 'queue', 'add', ctx)).rejects.toThrow(/message to queue/);
    await expect(runCodexInfoCommand(r, 'queue', 'push x', ctx)).rejects.toThrow(/takes add <text>/);
  });

  it("reads the thread's memory summary, stops one background terminal, and reloads MCP and skill roots on codex-app only", async () => {
    const r = rpc({
      'thread/memory/read': { summary: '' },
      'thread/backgroundTerminals/terminate': (p: { processId: string }) => ({ terminated: p.processId === '41' }),
      'config/mcpServer/reload': {},
      'skills/extraRoots/set': {},
    });
    const app = { engine: 'codex-app' as const, threadId: 'T', cwd: '/w' };
    expect((await runCodexInfoCommand(r, 'memories', 'summary', app))?.data).toEqual({ summary: null });
    expect(r.calls[0]).toEqual(['thread/memory/read', { threadId: 'T' }]);
    expect((await runCodexInfoCommand(r, 'stop', '41', app))?.ok).toBe(true);
    expect((await runCodexInfoCommand(r, 'stop', '42', app))?.ok).toBe(false);
    expect((await runCodexInfoCommand(r, 'mcp', 'reload', app))?.ok).toBe(true);
    expect(r.calls.at(-1)).toEqual(['config/mcpServer/reload', undefined]);
    await expect(runCodexInfoCommand(r, 'mcp', 'reload', { engine: 'codex' })).rejects.toThrow(/codex-app/);
    await expect(runCodexInfoCommand(r, 'mcp', 'restart', app)).rejects.toThrow(/'reload' or nothing/);
    const roots = await runCodexInfoCommand(r, 'skills', 'roots skills /abs/more', app);
    expect(r.calls.at(-1)).toEqual(['skills/extraRoots/set', { extraRoots: ['/w/skills', '/abs/more'] }]);
    expect(roots?.ok).toBe(true);
    await expect(runCodexInfoCommand(r, 'skills', 'roots x', { engine: 'codex' })).rejects.toThrow(/codex-app/);
  });
});

describe('codex quota', () => {
  const resp = {
    ordinaryUsageAllowed: true,
    rateLimitsByLimitId: {
      codex: {
        limitId: 'codex',
        primary: { usedPercent: 5, windowDurationMins: 10080, resetsAt: 1796281404 },
        secondary: { usedPercent: 40, windowDurationMins: 300, resetsAt: 1796200000 },
        planType: 'pro',
      },
    },
  };

  it('reads the rate-limit windows as quota windows', () => {
    const q = codexQuotaFromRateLimits(resp, 'codex', 'src');
    expect(q).toMatchObject({ engine: 'codex', plan: 'pro', source: 'src' });
    expect(q?.windows).toEqual([
      { name: 'weekly', usedPercent: 5, remainingPercent: 95, resetsAt: new Date(1796281404 * 1000).toISOString() },
      { name: '5h', usedPercent: 40, remainingPercent: 60, resetsAt: new Date(1796200000 * 1000).toISOString() },
    ]);
    expect(codexQuotaFromRateLimits({}, 'codex', 'src')).toBeUndefined();
  });

  it('is registered for both Codex engines, and asks a live codex-app session on its own app-server', async () => {
    expect(quotaEngines()).toEqual(expect.arrayContaining(['codex', 'codex-app']));
    const r = rpc({ 'account/rateLimits/read': resp });
    const session = { codexRpc: () => r } as never;
    const q = await readCodexQuota('codex-app', { session });
    expect(q?.windows[0].name).toBe('weekly');
    expect(r.calls).toEqual([['account/rateLimits/read', {}]]);
  });
});

describe('codex rollouts', () => {
  const root = mkdtempSync(join(tmpdir(), 'clawo-codex-rollouts-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const day = join(root, '2026', '11', '28');
  mkdirSync(day, { recursive: true });
  const write = (id: string, lines: unknown[]) => {
    const file = join(day, `rollout-2026-11-28T10-00-00-${id}.jsonl`);
    writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    return file;
  };
  const total = (i: number) => ({
    payload: { info: { total_token_usage: { input_tokens: i, cached_input_tokens: 0, output_tokens: 1 } } },
  });
  const A = '01a22100-0000-7000-8000-00000000000a';
  const B = '01a22100-0000-7000-8000-00000000000b';
  const C = '01a22100-0000-7000-8000-00000000000c';

  it('finds the file a reverted thread goes on in, the newest of its files', () => {
    const T = '01a22165-b61f-7901-8d32-234995b4c8fb';
    writeFileSync(join(day, `rollout-2026-11-28T17-04-03-${T}.jsonl`), '{}\n');
    expect(findCodexRollout(T, root)).toBe(join(day, `rollout-2026-11-28T17-04-03-${T}.jsonl`));
    writeFileSync(join(day, `rollout-2026-11-28T17-04-59-${T}_01a22166-90df-7491-8c4e-2461002d425c.jsonl`), '{}\n');
    expect(findCodexRollout(T, root)).toBe(
      join(day, `rollout-2026-11-28T17-04-59-${T}_01a22166-90df-7491-8c4e-2461002d425c.jsonl`),
    );
    // Another thread whose id shares the prefix is not this one's.
    expect(findCodexRollout(T.slice(0, 30), root)).toBeUndefined();
  });

  it("reads sub-agents' totals and their own sub-agents', each once", () => {
    write(A, [{ item: { agent_thread_id: B } }, total(10)]);
    write(B, [
      { type: 'turn_context', payload: { model: 'gpt-5.4-mini' } },
      { item: { agent_thread_id: C } },
      total(20),
    ]);
    write(C, [{ item: { agent_thread_id: B } }, total(30)]);
    expect(subAgentThreadIds(`{"agent_thread_id":"${B}"} {"agent_thread_id": "${B}"}`)).toEqual([B]);
    const u = subAgentUsage([B], root);
    expect(u.map((x) => [x.threadId, x.totals.input, x.model])).toEqual([
      [B, 20, 'gpt-5.4-mini'],
      [C, 30, undefined],
    ]);
  });

  it("finds a review's reviewer thread by its parent, and only one started since the review began", () => {
    const old = write('01a22100-0000-7000-8000-0000000000e1', [
      {
        timestamp: '2026-11-01T00:00:00Z',
        type: 'session_meta',
        payload: { parent_thread_id: A, source: { subagent: 'review' } },
      },
      total(999),
    ]);
    utimesSync(old, new Date('2026-11-01'), new Date('2026-11-01'));
    const since = Date.now();
    expect(reviewRolloutUsage(A, since, root)).toEqual({});
    write('01a22100-0000-7000-8000-0000000000e2', [
      {
        timestamp: new Date().toISOString(),
        type: 'session_meta',
        payload: { parent_thread_id: A, source: { subagent: 'review' } },
      },
      total(300),
    ]);
    expect(reviewRolloutUsage(A, since, root)).toMatchObject({
      threadId: '01a22100-0000-7000-8000-0000000000e2',
      totals: { input: 300, cached: 0, output: 1 },
    });
  });
});
