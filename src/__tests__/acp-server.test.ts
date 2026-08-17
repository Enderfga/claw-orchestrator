/**
 * Unit tests for the ACP adapter.
 *
 * These cover the pure translation helpers and the config-option shapes, which
 * are what a client renders and therefore what silently breaks a picker when a
 * field name drifts. The end-to-end protocol behaviour (handshake, streaming,
 * stdout purity) is exercised against the real binary — see skills/references/acp.md.
 */

import { describe, it, expect } from 'vitest';

import {
  ACP_MODES,
  ACP_DEFAULT_MODE,
  ACP_CONFIG_MODEL,
  ACP_CONFIG_PERMISSION,
  buildModelConfigOption,
  buildPermissionConfigOption,
  flattenPromptContent,
  parseSlashCommand,
  resolveParkedCouncil,
  ACP_MODE_COMMANDS,
} from '../acp-server.js';

describe('ACP modes', () => {
  it('advertises the default mode among the available ones', () => {
    expect(ACP_MODES.map((m) => m.id)).toContain(ACP_DEFAULT_MODE);
  });

  it('gives every mode a stable id and a human-readable name', () => {
    for (const mode of ACP_MODES) {
      expect(mode.id).toMatch(/^[a-z]+$/);
      expect(mode.name.length).toBeGreaterThan(0);
    }
    expect(new Set(ACP_MODES.map((m) => m.id)).size).toBe(ACP_MODES.length);
  });
});

describe('buildModelConfigOption', () => {
  // A client renders this as its model dropdown. The discriminant and the
  // `currentValue` field name are load-bearing: ACP's SessionConfigOption is a
  // union tagged by `type`, and an option missing either is silently unusable
  // rather than rejected.
  it('is a tagged select carrying the current model', () => {
    const opt = buildModelConfigOption('claude-sonnet-4-6') as unknown as Record<string, unknown>;
    expect(opt.type).toBe('select');
    expect(opt.id).toBe(ACP_CONFIG_MODEL);
    expect(opt.category).toBe('model');
    expect(opt.currentValue).toBe('claude-sonnet-4-6');
  });

  it('groups models by engine so one dropdown spans several CLIs', () => {
    const opt = buildModelConfigOption('claude-sonnet-4-6') as unknown as {
      options: Array<{ group: string; name: string; options: Array<{ value: string }> }>;
    };
    const engines = opt.options.map((g) => g.group);
    expect(engines).toContain('claude');
    expect(engines).toContain('codex');
    expect(engines).toContain('cursor');
    // Every group must be non-empty, or the client renders an empty header.
    for (const group of opt.options) expect(group.options.length).toBeGreaterThan(0);
  });

  // The Gemini CLI is sunset and kept only for callers that already name it.
  // Listing it in a new picker would advertise a dead end.
  it('omits the retired gemini engine', () => {
    const opt = buildModelConfigOption('claude-sonnet-4-6') as unknown as {
      options: Array<{ group: string }>;
    };
    expect(opt.options.map((g) => g.group)).not.toContain('gemini');
  });
});

describe('buildPermissionConfigOption', () => {
  // ACP can ask the user per turn via session/request_permission, but nothing in
  // this codebase can surface such a request — permission resolves once into
  // engine CLI flags. So the choice is offered up-front instead.
  it('offers the three modes the session layer can actually enforce', () => {
    const opt = buildPermissionConfigOption('plan') as unknown as {
      type: string;
      id: string;
      currentValue: string;
      options: Array<{ value: string }>;
    };
    expect(opt.type).toBe('select');
    expect(opt.id).toBe(ACP_CONFIG_PERMISSION);
    expect(opt.currentValue).toBe('plan');
    expect(opt.options.map((o) => o.value)).toEqual(['plan', 'acceptEdits', 'bypassPermissions']);
  });
});

describe('flattenPromptContent', () => {
  it('concatenates text blocks in order', () => {
    expect(
      flattenPromptContent([
        { type: 'text', text: 'a' },
        { type: 'text', text: 'b' },
      ]),
    ).toBe('ab');
  });

  it('renders a resource link as a textual reference rather than fetching it', () => {
    const out = flattenPromptContent([{ type: 'resource_link', name: 'notes', uri: 'file:///tmp/n.md' }]);
    expect(out).toBe('[resource_link name=notes uri=file:///tmp/n.md]');
  });

  it('ignores block types beyond the advertised baseline', () => {
    // promptCapabilities advertises image/audio/embeddedContext as false, so a
    // client should not send them; dropping them is safer than throwing.
    expect(
      flattenPromptContent([
        { type: 'image', data: 'x' },
        { type: 'text', text: 'ok' },
      ]),
    ).toBe('ok');
  });

  it('returns empty for a non-array, so an empty prompt is rejected by the caller', () => {
    expect(flattenPromptContent(undefined)).toBe('');
    expect(flattenPromptContent('hello')).toBe('');
  });
});

describe('parseSlashCommand', () => {
  it('splits the command from its argument', () => {
    expect(parseSlashCommand('/council_reject too risky')).toEqual({ name: 'council_reject', rest: 'too risky' });
  });

  it('accepts a bare command', () => {
    expect(parseSlashCommand('  /council_accept  ')).toEqual({ name: 'council_accept', rest: '' });
  });

  it('is null for ordinary prose, including a mid-sentence slash', () => {
    expect(parseSlashCommand('fix the bug in src/a.ts')).toBeNull();
    expect(parseSlashCommand('what does /usr/bin do?')).toBeNull();
  });
});

describe('resolveParkedCouncil', () => {
  // A council that reaches consensus parks awaiting a human decision rather than
  // completing, so these two commands are the only way the run ever finishes.
  const parkedState = () =>
    ({
      name: 'acp-x',
      cwd: '/tmp',
      model: 'claude-sonnet-4-6',
      engine: 'claude',
      permissionMode: 'plan',
      modeId: 'council',
      parkedCouncilId: 'council-1',
    }) as Parameters<typeof resolveParkedCouncil>[1];

  it('accepts, clears the park, and withdraws the commands', async () => {
    const calls: string[] = [];
    const manager = {
      councilAccept: async (id: string) => void calls.push(`accept:${id}`),
    } as unknown as Parameters<typeof resolveParkedCouncil>[0];
    const said: string[] = [];
    const emitted: Record<string, unknown>[] = [];
    const state = parkedState();

    const done = await resolveParkedCouncil(
      manager,
      state,
      { name: 'council_accept', rest: '' },
      async (t) => void said.push(t),
      async (u) => void emitted.push(u),
    );

    expect(done).toBe(true);
    expect(calls).toEqual(['accept:council-1']);
    expect(state.parkedCouncilId).toBeUndefined();
    // Restored, not cleared — an empty list would strand the client with no way
    // back to any mode.
    expect(emitted.at(-1)).toEqual({
      sessionUpdate: 'available_commands_update',
      availableCommands: ACP_MODE_COMMANDS,
    });
    expect(said.join(' ')).toContain('accepted');
  });

  it('passes the text after /council_reject through as feedback', async () => {
    const calls: string[] = [];
    const manager = {
      councilReject: async (id: string, feedback: string) => void calls.push(`${id}|${feedback}`),
    } as unknown as Parameters<typeof resolveParkedCouncil>[0];
    const state = parkedState();

    await resolveParkedCouncil(
      manager,
      state,
      { name: 'council_reject', rest: 'the fix breaks negative inputs' },
      async () => {},
      async () => {},
    );

    expect(calls).toEqual(['council-1|the fix breaks negative inputs']);
    expect(state.parkedCouncilId).toBeUndefined();
  });

  // An ordinary prompt while parked must not be swallowed as a decision — the
  // caller falls through and reports that a decision is still outstanding.
  it('leaves the park intact for a non-council command', async () => {
    const state = parkedState();
    const done = await resolveParkedCouncil(
      {} as Parameters<typeof resolveParkedCouncil>[0],
      state,
      { name: 'something_else', rest: '' },
      async () => {},
      async () => {},
    );
    expect(done).toBe(false);
    expect(state.parkedCouncilId).toBe('council-1');
  });
});

describe('ACP_MODE_COMMANDS', () => {
  // The VS Code ACP extension (0.2.0, measured) renders config options but not
  // modes, so without a slash command per mode the orchestration modes are
  // unreachable there — the picker ACP defines is advisory, not guaranteed.
  it('offers one command per advertised mode', () => {
    expect(ACP_MODE_COMMANDS.map((c) => c.name)).toEqual(ACP_MODES.map((m) => m.id));
    for (const cmd of ACP_MODE_COMMANDS) expect(cmd.description.length).toBeGreaterThan(0);
  });

  it('names commands so parseSlashCommand recognises them', () => {
    for (const cmd of ACP_MODE_COMMANDS) {
      expect(parseSlashCommand(`/${cmd.name} do the thing`)).toEqual({ name: cmd.name, rest: 'do the thing' });
    }
  });
});
