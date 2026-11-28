import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  agyCommands,
  claudeBuiltinCommands,
  codexRpcMethods,
  configChanges,
  contradictedDecisions,
  cursorEngineCommands,
  declaredOptions,
  decisionFor,
  grokEngineCommands,
  isUnder,
  opencodeListingEnv,
  programRegion,
  quotedIn,
  reviewListing,
  scanCovers,
  staleDecisions,
  unreviewedNames,
} from '../../scripts/sweep-surface.js';

// The shapes below are copied from the shipped JavaScript: Claude Code 2.1.332
// (Bun single-file binary) and Cursor Agent 2026.11.22 (versions/<v>/index.js).
const CLAUDE_PROGRAM =
  'let b=n.name("claude").description("Claude Code").argument("[prompt]","Your prompt",String)' +
  '.option("-d, --debug [filter]","Enable debug mode with optional category filtering (e.g., --debug=hooks,mcp)",(k)=>!0)' +
  '.addOption(new zs("-d2e, --debug-to-stderr","(deprecated) Enable debug mode (to stderr)").argParser(Boolean).hideHelp())' +
  '.option("-p, --print","Print response and exit")' +
  '.option("--allowedTools, --allowed-tools <tools...>","Comma or space-separated list of tool names to allow")' +
  '.addOption(new zs("--max-budget-usd <amount>","Maximum dollar amount").argParser((k)=>{let E=Number(k);' +
  'if(isNaN(E))throw new Q8("--max-budget-usd must be a number greater than 0");return E}))' +
  '.addOption(new zs("--fast-mode <on|off>").argParser((k)=>k).hideHelp()),' +
  'n.addOption(new zs("--advisor <model>","Turn on the advisor tool with this model (alias or full ID)").hideHelp());' +
  '{let k=new zs("--messaging-socket-path <path>","Cross-session messaging server path");k.hideHelp(),n.addOption(k)}' +
  'n.option("--tmux","Create a tmux session for the worktree");' +
  'function Ini(o,d){o.command("edit-permission-rules",{hidden:!0}).requiredOption("--json","Read the edit as JSON")}';

const CURSOR_PROGRAM =
  'const It=(0,nt.de)(new g.uB,"Cursor Agent").addOption(nt.fp.version())' +
  '.addOption(new g.c$("--stderr","").hideHelp())' +
  '.option("-H, --header <header>","Add custom header to agent requests",((t,e)=>[...e??[],t]))' +
  '.addOption(new g.c$("--image <path>","Attach image(s) to a headless prompt (internal only)").hideHelp())' +
  '.addOption(new g.c$("--repo-endpoint <url>",`API endpoint URL (defaults to ${pt})`).default(pt).hideHelp())' +
  ',Et=It.command("persist").option("--detach","Detach")';

describe('declaredOptions', () => {
  it('reads every commander declaration of a program, hidden ones included', () => {
    const opts = declaredOptions(programRegion(CLAUDE_PROGRAM));
    expect([...opts.keys()].sort()).toEqual([
      '--advisor',
      '--allowed-tools',
      '--allowedTools',
      '--debug',
      '--debug-to-stderr',
      '--fast-mode',
      '--max-budget-usd',
      '--messaging-socket-path',
      '--print',
      '--tmux',
    ]);
    expect(opts.get('--advisor')).toBe('Turn on the advisor tool with this model (alias or full ID)');
    expect(opts.get('--fast-mode')).toBe('');
  });

  it('does not take an error message that starts with a flag for a declaration', () => {
    const opts = declaredOptions('new Q8("--max-budget-usd must be a number greater than 0")');
    expect(opts.size).toBe(0);
  });

  it('reads a minified class name with a namespace and a template-literal description', () => {
    const opts = declaredOptions(programRegion(CURSOR_PROGRAM));
    expect([...opts.keys()].sort()).toEqual(['--header', '--image', '--repo-endpoint', '--stderr']);
    expect(opts.get('--repo-endpoint')).toBe('API endpoint URL (defaults to ${pt})');
  });
});

describe('programRegion', () => {
  it('ends at the first subcommand, whose options are not the program’s', () => {
    expect(declaredOptions(programRegion(CLAUDE_PROGRAM)).has('--json')).toBe(false);
    expect(declaredOptions(CLAUDE_PROGRAM).has('--json')).toBe(true);
  });
});

describe('scanCovers', () => {
  const help = new Set(['--help', '--version', '--print', '--debug', '--tmux', '--allowed-tools']);
  it('accepts a scan that finds what --help lists', () => {
    expect(scanCovers(new Set(['--print', '--debug', '--tmux', '--advisor']), help)).toBe(true);
  });
  it('rejects an empty scan, and one aimed at the wrong program', () => {
    expect(scanCovers(new Set(), help)).toBe(false);
    expect(scanCovers(new Set(['--json', '--print']), help)).toBe(false);
  });
});

describe('engine command listings', () => {
  it('Claude: only the built-in commands of the initialize response', () => {
    const response = {
      commands: [
        { name: 'compact', builtin: true },
        { name: 'alphaxiv-paper-lookup', description: 'a user skill' },
        { name: 'superpowers:brainstorming', aliases: ['brainstorming'] },
        { name: 'code-review', aliases: ['review'], builtin: true },
      ],
    };
    expect(claudeBuiltinCommands(response)).toEqual([
      { name: 'compact' },
      { name: 'code-review', aliases: ['review'] },
    ]);
    expect(claudeBuiltinCommands(undefined)).toEqual([]);
  });

  it('agy: the /help commands with their aliases, and the skills it ships', () => {
    const help = {
      command: { name: 'help', data: { commands: [{ name: 'usage', aliases: ['quota'] }, { name: 'help' }] } },
    };
    // 1.5.19: agy's own skills live under antigravity-cli/builtin, the user's under config/skills.
    const skills = {
      command: {
        name: 'skills',
        data: {
          skills: [
            { name: 'swarm', path: '/h/.gemini/antigravity-cli/builtin/skills/native_swarm/SKILL.md', builtin: true },
            { name: 'pdf', path: '/h/.gemini/config/skills/pdf/SKILL.md', builtin: false },
            { name: 'repo-skill', path: '/repo/.agents/skills/repo-skill/SKILL.md', builtin: false },
          ],
        },
      },
    };
    expect(agyCommands(help, skills)).toEqual([
      { name: 'usage', aliases: ['quota'] },
      { name: 'help' },
      { name: 'swarm' },
    ]);
  });

  it('grok: built-ins and bundled skills by bare name; the user’s skills and workflows left out', () => {
    const commands = [
      { name: 'compact', description: 'Compress conversation history' },
      { name: 'deep-research', _meta: { workflowSource: 'builtin' } },
      { name: 'my-flow', _meta: { workflowSource: 'user' } },
      { name: 'bundled:imagine', _meta: { scope: 'bundled', bareName: 'imagine', qualifiedName: 'bundled:imagine' } },
      { name: 'brainstorming', _meta: { scope: 'user', path: '/home/u/.claude/plugins/x/SKILL.md' } },
      { name: 'learn-traces', _meta: { workflowSource: 'bundled' } },
    ];
    expect(grokEngineCommands(commands)).toEqual(['compact', 'deep-research', 'imagine', 'learn-traces']);
  });

  it('grok: a skill or workflow whose file is outside the grok home the listing ran on is the machine’s', () => {
    const home = '/tmp/sweep-grok-cmds-x/grok-home';
    const commands = [
      { name: 'compact' },
      { name: 'code-review', _meta: { scope: 'bundled', path: `${home}/bundled/skills/code-review/SKILL.md` } },
      {
        name: 'deep-research',
        _meta: { workflowSource: 'builtin', workflowPath: `${home}/bundled/workflows/dr.rhai` },
      },
      // Scoped as grok's own, yet loaded from the user's Claude skills.
      { name: 'build-with-ai', _meta: { scope: 'bundled', path: '/home/u/.claude/skills/build-with-ai/SKILL.md' } },
      { name: 'nightly', _meta: { workflowSource: 'builtin', workflowPath: '/home/u/.grok/workflows/nightly.rhai' } },
      // A sibling whose name starts with the home's is not inside it.
      { name: 'sibling', _meta: { scope: 'bundled', path: `${home}-other/skills/sibling/SKILL.md` } },
    ];
    expect(grokEngineCommands(commands, [home])).toEqual(['compact', 'code-review', 'deep-research']);
    // The home as the OS resolves it (macOS /var → /private/var) counts too.
    const real = commands.map((c) =>
      c._meta?.path ? { ...c, _meta: { ...c._meta, path: `/private${c._meta.path}` } } : c,
    );
    expect(grokEngineCommands(real, [home, `/private${home}`])).toContain('code-review');
  });

  it('isUnder: the directory itself and what lies below it, not a sibling with a longer name', () => {
    expect(isUnder('/a/b', '/a/b')).toBe(true);
    expect(isUnder('/a/b/c/SKILL.md', '/a/b/')).toBe(true);
    expect(isUnder('/a/bc/SKILL.md', '/a/b')).toBe(false);
    expect(isUnder('C:\\g\\bundled\\x', 'C:\\g')).toBe(true);
  });

  it('cursor: drops the user’s and the project’s, keeps the rest and any marker it does not know', () => {
    const commands = [
      { name: 'copy-request-id', description: 'Copy the last request ID to clipboard' },
      { name: 'best-of-n', description: 'Fan out one task across multiple models (global)' },
      { name: 'goal', description: 'Set a goal that Cursor will pursue to completion. (builtin skill)' },
      { name: 'probe-cmd', description: 'Reply with one line (project)' },
      { name: 'probe-skill', description: 'A skill (project skill)' },
      { name: 'pdf', description: 'Use this skill for PDFs (user skill)' },
      { name: 'team-cmd', description: 'A command the team shares (team)' },
      { name: 'plugin-skill', description: 'From an installed plugin (skill)' },
      { name: 'later', description: 'Something new (preview)' },
    ];
    expect(cursorEngineCommands(commands)).toEqual(['copy-request-id', 'best-of-n', 'goal', 'later']);
  });

  it('opencode: the listing runs on a config of its own, without the variables that add the user’s', () => {
    const base = {
      PATH: '/usr/bin',
      HOME: '/home/u',
      XDG_CONFIG_HOME: '/home/u/.config',
      OPENCODE_CONFIG: '/home/u/oc.json',
      OPENCODE_CONFIG_DIR: '/home/u/oc',
      OPENCODE_CONFIG_CONTENT: '{"command":{"mine":{"template":"hi"}}}',
      OPENCODE_DISABLE_AUTOUPDATE: '1',
    };
    const env = opencodeListingEnv(base, { configHome: '/s/config', cwd: '/s/ws' }, 'pw');
    expect(env).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/u',
      XDG_CONFIG_HOME: '/s/config',
      OPENCODE_DISABLE_AUTOUPDATE: '1',
      OPENCODE_PASSWORD: 'pw',
      PWD: '/s/ws',
    });
    expect(base.OPENCODE_CONFIG_DIR).toBe('/home/u/oc');
  });

  it('codex: the method names of ClientRequest, enum or const', () => {
    const schema = {
      oneOf: [
        { properties: { method: { enum: ['thread/start'] }, params: {} } },
        { properties: { method: { const: 'turn/start' } } },
        { properties: {} },
      ],
    };
    expect(codexRpcMethods(schema)).toEqual(['thread/start', 'turn/start']);
    expect(codexRpcMethods({})).toEqual([]);
  });
});

describe('review matching', () => {
  const reviewed = {
    'fs/*': 'skip: file-system API for a client UI',
    'fs/readFile': 'supported: used by the wrapper',
    'thread/realtime/*': 'skip: voice',
    'thread/*': 'skip: everything else on a thread',
    compact: 'supported: session_compact',
    gone: 'skip: no longer listed',
  };

  it('an exact key wins over a wildcard, and the longest wildcard over a shorter one', () => {
    expect(decisionFor('fs/readFile', reviewed)).toBe('supported: used by the wrapper');
    expect(decisionFor('fs/remove', reviewed)).toBe('skip: file-system API for a client UI');
    expect(decisionFor('thread/realtime/start', reviewed)).toBe('skip: voice');
    expect(decisionFor('thread/start', reviewed)).toBe('skip: everything else on a thread');
    expect(decisionFor('turn/start', reviewed)).toBeUndefined();
    expect(decisionFor('toString', reviewed)).toBeUndefined();
  });

  it('lists what has neither a decision nor a reference in the source, once and sorted', () => {
    const names = ['turn/start', 'compact', 'model/list', 'fs/remove', 'turn/start', 'account/read'];
    expect(unreviewedNames(names, reviewed, new Set(['model/list']))).toEqual(['account/read', 'turn/start']);
  });

  it('a decision matching nothing listed is stale, a wildcard included', () => {
    expect(staleDecisions(reviewed, ['fs/remove', 'compact', 'thread/start'])).toEqual([
      'fs/readFile',
      'gone',
      'thread/realtime/*',
    ]);
  });

  it('a skip the source now uses is contradicted; supported entries and wildcards are not', () => {
    const decisions = { '/x': 'x', compact: 'supported: session_compact', goal: 'skip: TUI only', 'fs/*': 'skip: a' };
    expect(contradictedDecisions(decisions, new Set(['compact', 'goal', 'fs/remove']))).toEqual(['goal']);
  });

  it('finds quoted literals of a name, with the engine’s prefix', () => {
    const src = `args.push('/compact'); send({ method: "thread/start" }); // review`;
    expect([...quotedIn(src, ['compact', 'goal', 'review'], '/')]).toEqual(['compact']);
    expect([...quotedIn(src, ['thread/start', 'thread'], '')]).toEqual(['thread/start']);
  });
});

describe('reviewListing', () => {
  const listing = [
    { name: 'usage', aliases: ['quota'] },
    { name: 'config', aliases: ['settings'] },
    { name: 'compact' },
    { name: 'automation' },
    { name: 'boost' },
  ];
  const decisions = {
    listed: {
      quota: 'support: alias of /usage',
      config: 'support: info command',
      compact: 'support: session_compact',
      gone: 'skip: removed',
    },
    unlisted: {
      clear: 'skip: interactive-only',
      boost: 'support: turnCommand',
    },
  };

  it('a command is reviewed under any of its names, or when the source names it', () => {
    const r = reviewListing(listing, decisions, new Set(['automation']), { slashInNames: false });
    expect(r.unreviewed).toEqual([]);
    expect(reviewListing(listing, decisions, new Set(), { slashInNames: false }).unreviewed).toEqual(['automation']);
  });

  it('only a listed decision goes stale; an unlisted one the listing shows is flagged to move', () => {
    const r = reviewListing(listing, decisions, new Set(['automation']), { slashInNames: false });
    expect(r.stale).toEqual(['gone']);
    expect(r.nowListed).toEqual(['boost']);
  });

  it('an alias group, a note, and a name in both maps are malformed; a path is not, where names are paths', () => {
    const bad = {
      listed: { 'model/models': 'skip: TUI', 'skills (user:*, bundled:*)': 'support', compact: 'support' },
      unlisted: { 'new/clear': 'skip: TUI', compact: 'skip: TUI' },
    };
    expect(reviewListing(listing, bad, new Set(), { slashInNames: false }).malformed).toEqual([
      'compact',
      'model/models',
      'new/clear',
      'skills (user:*, bundled:*)',
    ]);
    const rpc = { listed: { 'thread/start': 'support', 'fs/*': 'skip' }, unlisted: {} };
    expect(reviewListing([{ name: 'thread/start' }], rpc, new Set(), { slashInNames: true }).malformed).toEqual([]);
  });

  it('a key named like an Object prototype member is not taken for one in the other map', () => {
    const r = reviewListing([{ name: 'constructor' }], { listed: { constructor: 'skip' }, unlisted: {} }, new Set(), {
      slashInNames: false,
    });
    expect(r.malformed).toEqual([]);
  });
});

describe('scripts/sweep-reviewed.json', () => {
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'sweep-reviewed.json');
  const all = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<
    string,
    { slashCommands?: Record<string, string>; unlistedSlashCommands?: Record<string, string> }
  >;

  it('every slash-command key names one command, in one of the two maps', () => {
    for (const [engine, r] of Object.entries(all)) {
      const decisions = { listed: r.slashCommands ?? {}, unlisted: r.unlistedSlashCommands ?? {} };
      const { malformed } = reviewListing([], decisions, new Set(), { slashInNames: engine === 'codex' });
      expect({ engine, malformed }).toEqual({ engine, malformed: [] });
    }
  });

  it('every decision says support or skip', () => {
    for (const r of Object.values(all))
      for (const why of [...Object.values(r.slashCommands ?? {}), ...Object.values(r.unlistedSlashCommands ?? {})])
        expect(why).toMatch(/^(support|skip)\b/);
  });
});

describe('configChanges', () => {
  const before = JSON.stringify({
    model: { modelId: 'auto-smart' },
    selectedModel: { modelId: 'auto-smart' },
    privacyCache: { at: 1 },
    permissions: { allow: [] },
  });

  it('ignores the caches a plain run refreshes', () => {
    const after = JSON.stringify({ ...JSON.parse(before), privacyCache: { at: 2 } });
    expect(configChanges(before, after, /Cache$/)).toEqual([]);
    expect(configChanges(before, after)).toEqual(['privacyCache']);
  });

  it('names the keys a session flag rewrote (Cursor --model, 2026.11.22)', () => {
    const after = JSON.stringify({
      ...JSON.parse(before),
      model: { modelId: 'gpt-5.2' },
      selectedModel: { modelId: 'gpt-5.2' },
      modelSelectionHistory: ['gpt-5.2'],
    });
    expect(configChanges(before, after, /Cache$/)).toEqual(['model', 'modelSelectionHistory', 'selectedModel']);
  });

  it('reports a file that is not JSON, created or deleted as a whole', () => {
    expect(configChanges('a = 1\n', 'a = 2\n')).toEqual(['(content)']);
    expect(configChanges(null, '{}')).toEqual(['(created)']);
    expect(configChanges('{}', null)).toEqual(['(deleted)']);
    expect(configChanges(null, null)).toEqual([]);
  });
});
