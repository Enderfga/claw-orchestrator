/**
 * One set of session flags for every engine.
 *
 * `clawo session-start` takes every `session_start` field as a flag, built from
 * the same schema the MCP tool serves. These pin that the two stay one list,
 * that each flag sets the field it names with the field's type, and that an
 * engine is picked one way at a time.
 */
import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import plugin from '../index.js';
import { SESSION_START_PROPERTIES } from '../session-params.js';
import {
  addEngineFlags,
  addSessionFlags,
  engineFromFlags,
  NOT_FLAGS,
  SESSION_FLAGS,
  sessionBody,
} from '../../bin/session-flags.js';

function sessionStartProperties(): Record<string, unknown> {
  const tools: Array<{ name: string; parameters: { properties: Record<string, unknown> } }> = [];
  const api = {
    pluginConfig: {},
    logger: { info: () => {}, error: () => {}, warn: () => {} },
    registerTool: (def: (typeof tools)[number]) => tools.push(def),
    on: () => {},
    registerHttpRoute: () => {},
    registerService: () => {},
  };
  (plugin as unknown as { register: (api: unknown) => void }).register(api);
  return tools.find((t) => t.name === 'session_start')!.parameters.properties;
}

/** Parse argv the way `clawo session-start` does. */
function parse(argv: string[]): Record<string, unknown> {
  const cmd = addSessionFlags(addEngineFlags(new Command().exitOverride().option('-e, --engine <engine>')));
  cmd.parse(['node', 'clawo', ...argv]);
  return cmd.opts();
}

describe('the session flags', () => {
  it('are the session_start fields: every field a flag, or listed as not one, and no flag without a field', () => {
    const tool = Object.keys(sessionStartProperties());
    expect(tool).toEqual(Object.keys(SESSION_START_PROPERTIES));
    const flagged = new Set(SESSION_FLAGS.map((f) => f.field));
    expect(tool.filter((f) => !flagged.has(f) && !(f in NOT_FLAGS))).toEqual([]);
    expect([...flagged].filter((f) => !tool.includes(f))).toEqual([]);
  });

  it('set the field they name, with its type', () => {
    const body = sessionBody(
      parse([
        '--strict-mcp-config',
        '--setting-sources',
        'project,local',
        '--max-turns',
        '7',
        '--max-budget',
        '2.5',
        '--sandbox',
        'read-only',
        '--codex-config',
        'model_verbosity=low',
        '--codex-config',
        'tools.web_search=true',
        '--launcher',
        'bwrap',
        '--launcher',
        '--bind',
        '-w',
        '--skip-persistence',
        '--auto-compact-window',
        '200000',
        '--tools',
        '',
        '--agents',
        '{"r":{"description":"d","prompt":"p"}}',
        '-m',
        'opus',
        '--turn-command',
        '/boost',
      ]),
    );
    expect(body).toMatchObject({
      strictMcpConfig: true,
      settingSources: ['project', 'local'],
      maxTurns: 7,
      maxBudgetUsd: 2.5,
      sandboxMode: 'read-only',
      codexConfig: { model_verbosity: 'low', 'tools.web_search': true },
      launcher: ['bwrap', '--bind'],
      worktree: true,
      noSessionPersistence: true,
      autoCompactWindow: 200000,
      tools: '',
      agents: { r: { description: 'd', prompt: 'p' } },
      model: 'opus',
      turnCommand: '/boost',
    });
    expect(() => sessionBody(parse(['--max-turns', 'lots']))).toThrow(/needs a number/);
  });

  it('pick the engine one way: -e or one shorthand, none for the default', () => {
    expect(engineFromFlags(parse(['--codex']))).toEqual({ engine: 'codex' });
    expect(engineFromFlags(parse(['-e', 'grok']))).toEqual({ engine: 'grok' });
    expect(engineFromFlags(parse(['--acp', 'kimi-code']))).toEqual({ engine: 'acp', acpAgent: 'kimi-code' });
    expect(engineFromFlags(parse(['-e', 'acp', '--acp-agent', 'dsh']))).toEqual({ engine: 'acp', acpAgent: 'dsh' });
    expect(engineFromFlags(parse(['--codex-app']))).toEqual({ engine: 'codex-app' });
    expect(engineFromFlags(parse([]))).toEqual({});
    // The same engine twice is one pick; two engines are an error.
    expect(engineFromFlags(parse(['-e', 'codex', '--codex']))).toEqual({ engine: 'codex' });
    expect(() => engineFromFlags(parse(['--codex', '--agy']))).toThrow(/pick one engine/);
    expect(() => engineFromFlags(parse(['--acp-agent', 'dsh']))).toThrow(/go with -e acp/);
  });
});
