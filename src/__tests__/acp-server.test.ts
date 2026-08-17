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
