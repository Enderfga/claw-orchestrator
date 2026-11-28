// What agy's own transcripts say about a turn's spend: per-request models, and the conversations a turn started.
// Line shapes from agy 1.5.18 transcripts (teamwork, swarm, run-workflow).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  AgyMemberSpend,
  agyBrainDirOf,
  agyPricedModel,
  agyTranscriptPath,
  agyWorkflowMembers,
  parseAgyTranscript,
  priceAgyRequests,
} from '../agy-transcripts.js';
import { agyCommandPrompt, agyInfoCommands, agyLeadingCommand, agySkillCommands } from '../agy-commands.js';

const PARENT = '370fdbb7-f977-49aa-bd94-3b98f3ad8b8a';
const COORD = '74ec30b9-fd58-49ba-b6b0-6eb2b6674ce2';
const W1 = '34af6b64-bacc-45fd-a35e-b0a995279f91';
const W2 = '0792e1a3-83d8-4122-b113-946263fe21bd';

const req = (step_index: number, model: string, input: number, cache: number, output: number) => ({
  step_index,
  source: 'MODEL',
  type: 'PLANNER_RESPONSE',
  model,
  input_tokens: input,
  cache_read_tokens: cache,
  output_tokens: output,
});
const generic = (step_index: number, content: string) => ({ step_index, source: 'MODEL', type: 'GENERIC', content });

describe('parseAgyTranscript', () => {
  it('reads requests, and members from invoke_subagent and swarm results only', () => {
    const lines = [
      req(1, 'gemini-3.8-flash-low', 27_948, 0, 169),
      generic(
        2,
        `Created the following subagent:\n{\n  "conversationId": "${COORD}",\n  "logAbsoluteUri": "file:///x"\n}`,
      ),
      generic(3, `{"status":"added","name":"w1","model":"gemini-3.8-flash-low","conversation_id":"${W1}"}`),
      // A listing that names conversations is not a delegation.
      generic(4, `{"entries":[{"conversation_id":"${W2}"}]}`),
      {
        step_index: 5,
        source: 'SYSTEM',
        type: 'SYSTEM_MESSAGE',
        content: `Created the following subagent: {"conversationId":"${W2}"}`,
      },
    ];
    const t = parseAgyTranscript(lines.map((l) => JSON.stringify(l)).join('\n'));
    expect(t.requests).toEqual([
      { step: 1, model: 'gemini-3.8-flash-low', inputTokens: 27_948, cacheReadTokens: 0, outputTokens: 169 },
    ]);
    expect(t.members.sort()).toEqual([COORD, W1].sort());
  });

  it('prices each request at its model; agy names models with effort and tier', () => {
    expect(agyPricedModel('gemini-4-hydrogen-tiered-high')).toBe('gemini-4-hydrogen');
    expect(agyPricedModel('gemini-3.8-flash-low')).toBe('gemini-3.8-flash');
    const usd = priceAgyRequests(
      [
        { step: 1, model: 'gemini-4-neon-high', inputTokens: 1_000_000, cacheReadTokens: 0, outputTokens: 0 },
        {
          step: 2,
          model: 'gemini-4-hydrogen-high',
          inputTokens: 0,
          cacheReadTokens: 1_000_000,
          outputTokens: 1_000_000,
        },
      ],
      'gemini-3.8-flash',
    );
    expect(usd).toBeCloseTo(3 + 0.075 + 7.5, 6);
  });

  it('reads the brain folder from a log_uri', () => {
    expect(
      agyBrainDirOf(`file:///Users/x/.gemini/antigravity-cli/brain/${COORD}/.system_generated/logs/transcript.jsonl`),
    ).toBe('/Users/x/.gemini/antigravity-cli/brain');
    expect(agyBrainDirOf('https://example.com/x')).toBeUndefined();
  });
});

describe('AgyMemberSpend', () => {
  let brain: string;
  const write = (id: string, lines: unknown[]) => {
    const file = agyTranscriptPath(id, brain);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  };
  beforeEach(() => {
    brain = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-brain-'));
  });
  afterEach(() => fs.rmSync(brain, { recursive: true, force: true }));

  it('follows members through the conversations they start, and counts each request once', () => {
    write(PARENT, [
      req(1, 'gemini-3.8-flash-low', 30_000, 0, 300),
      generic(2, `Created the following subagent: {"conversationId":"${COORD}"}`),
    ]);
    write(COORD, [
      req(1, 'gemini-4-hydrogen-tiered-high', 100, 1_000, 10),
      generic(2, `{"status":"added","conversation_id":"${W1}"}`),
    ]);
    write(W1, [req(1, 'gemini-3.8-flash-low', 200, 2_000, 20)]);
    const spend = new AgyMemberSpend('gemini-3.8-flash');
    expect(spend.collect(PARENT, [], brain)).toMatchObject({
      conversations: 2,
      tokensIn: 300,
      cachedTokens: 3_000,
      tokensOut: 30,
    });
    expect(spend.collect(PARENT, [], brain)).toMatchObject({ conversations: 0, tokensIn: 0 });
    // A member still working when the turn ended: its later requests count next time.
    write(W1, [req(1, 'gemini-3.8-flash-low', 200, 2_000, 20), req(3, 'gemini-3.8-flash-low', 50, 0, 5)]);
    expect(spend.collect(PARENT, [], brain)).toMatchObject({ conversations: 1, tokensIn: 50, tokensOut: 5 });
  });

  it("finds a workflow's agents in its task logs", () => {
    const tasks = path.join(brain, PARENT, '.system_generated', 'tasks');
    fs.mkdirSync(tasks, { recursive: true });
    fs.writeFileSync(
      path.join(tasks, 'task-2.log'),
      `- [agent:self] Write w1.txt: done (${W1}): "ok"\n- [agent:self] Write w2.txt: done (${W2}): "ok"\n`,
    );
    expect(agyWorkflowMembers(PARENT, brain).sort()).toEqual([W1, W2].sort());
  });
});

describe('agy commands', () => {
  it('reads the leading command, not a path', () => {
    expect(agyLeadingCommand('/goal do it')).toBe('goal');
    expect(agyLeadingCommand('/plugin:skill x')).toBe('plugin:skill');
    expect(agyLeadingCommand('/Users/x/y.ts is broken')).toBeUndefined();
    expect(agyLeadingCommand('hello /goal')).toBeUndefined();
  });

  it('builds a command prompt', () => {
    expect(agyCommandPrompt('/boost', 'x')).toBe('/boost x');
    expect(agyCommandPrompt('teamwork', 'x')).toBe('/teamwork [skip-interview] x');
    expect(agyCommandPrompt('teamwork', undefined)).toBe('/teamwork [skip-interview]');
    expect(agyCommandPrompt('compact', undefined)).toBe('/compact');
  });

  it('lists the info commands /help names, and the known ones when it could not be read', () => {
    expect(
      agyInfoCommands({
        commands: [
          { name: 'usage', description: 'View' },
          { name: 'new-one', description: 'New' },
        ],
      }),
    ).toEqual([
      { name: 'usage', source: 'builtin', startsTurn: false, description: 'Show model quota usage' },
      { name: 'new-one', source: 'builtin', startsTurn: false, description: 'New' },
    ]);
    expect(agyInfoCommands(undefined).map((c) => c.name)).toContain('plugin');
  });

  it('lists skills, skipping names already taken', () => {
    expect(
      agySkillCommands(
        {
          skills: [
            { name: 'a', description: 'A', path: '/ws/.agents/skills/a/SKILL.md' },
            { name: 'goal' },
            { name: 'bad name' },
          ],
        },
        new Set(['goal']),
      ),
    ).toEqual([{ name: 'a', source: 'skill', startsTurn: true, description: 'A' }]);
  });
});
