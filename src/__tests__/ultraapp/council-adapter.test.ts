import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { composeCouncilPrompt, runCouncilSynth } from '../../ultraapp/council-adapter.js';
import { makeEmptySpec } from '../../ultraapp/spec.js';
import type { CouncilSession } from '../../types.js';

describe('composeCouncilPrompt', () => {
  it('embeds the full AppSpec as a JSON code block', () => {
    const spec = makeEmptySpec('ua-1');
    spec.meta.name = 'demo';
    spec.meta.title = 'Demo';
    spec.inputs.push({ name: 'in', type: 'text', required: true, description: 'in' });
    const prompt = composeCouncilPrompt(spec);
    expect(prompt).toContain('"name": "demo"');
    expect(prompt).toContain('"title": "Demo"');
  });
  it('includes architectural conventions verbatim', () => {
    const spec = makeEmptySpec('ua-1');
    const prompt = composeCouncilPrompt(spec);
    expect(prompt).toContain('Path-based deploy');
    expect(prompt).toContain('GET /status/:jobId');
    expect(prompt).toContain('CONSENSUS: YES');
  });
  it('embeds the §7 frontend quality gate so council enforces visual polish', () => {
    // Regression guard: a missing frontend section is what shipped the
    // "looks like a dev demo" v0.1 output. Every regenerated spec must
    // see the gate or the council defaults to "functional minimum".
    const spec = makeEmptySpec('ua-1');
    const prompt = composeCouncilPrompt(spec);
    expect(prompt).toContain('Frontend quality');
    expect(prompt).toContain('§7g');
    expect(prompt).toContain('375px');
    expect(prompt).toContain('Empty');
    expect(prompt).toContain('Loading');
    expect(prompt).toContain('NO vote');
  });
  it('§7g requires actual screenshot evidence at desktop AND 375px, not source-code review', () => {
    // The first live demo on §7 alone produced a polished desktop but a
    // mobile-overflow UI because agents inspected meta tags / @media
    // queries instead of opening rendered PNGs. The gate must spell out
    // "screenshot the rendered pixels" or it gets routed around.
    const spec = makeEmptySpec('ua-1');
    const prompt = composeCouncilPrompt(spec);
    expect(prompt).toContain('screenshot');
    expect(prompt).toContain('1440');
    expect(prompt).toContain('chrome --headless');
    expect(prompt).toContain('Reading the source code');
    expect(prompt).toContain('horizontal overflow');
  });
  it('quotes the AppSpec.meta.name as the slug to use', () => {
    const spec = makeEmptySpec('ua-1');
    spec.meta.name = 'vlog-cutter';
    const prompt = composeCouncilPrompt(spec);
    expect(prompt).toContain('vlog-cutter');
  });
});

describe('runCouncilSynth', () => {
  it('initialises the project dir as a git repo, runs council, returns consensus codebase path', async () => {
    const fakeCouncilRun = vi.fn().mockResolvedValue({
      id: 'c1',
      task: 't',
      status: 'consensus',
      config: { agents: [], maxRounds: 8, projectDir: '' },
      responses: [
        {
          agent: 'a',
          round: 4,
          content: '...',
          consensus: true,
          sessionKey: 'k1',
          timestamp: '2026-05-12T00:00:00Z',
        },
        {
          agent: 'b',
          round: 4,
          content: '...',
          consensus: true,
          sessionKey: 'k2',
          timestamp: '2026-05-12T00:00:00Z',
        },
        {
          agent: 'c',
          round: 4,
          content: '...',
          consensus: true,
          sessionKey: 'k3',
          timestamp: '2026-05-12T00:00:00Z',
        },
      ],
      startTime: '2026-05-12T00:00:00Z',
    } satisfies CouncilSession);

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ua-cs-'));
    try {
      const spec = makeEmptySpec('ua-1');
      spec.meta.name = 'demo';
      spec.meta.title = 'Demo';
      spec.inputs.push({ name: 'x', type: 'text', required: true, description: 'x' });
      spec.outputs.push({ name: 'y', type: 'text', description: 'y' });
      spec.pipeline.steps.push({
        id: 's1',
        description: 'noop',
        inputs: ['inputs.x'],
        outputs: ['y'],
        hints: {},
        validates: { outputType: 'text' },
      });
      const r = await runCouncilSynth({
        spec,
        runId: 'ua-1',
        runDir: tmp,
        sessionManager: {
          startSession: vi.fn(),
          sendMessage: vi.fn(),
          stopSession: vi.fn(),
        } as never,
        councilRun: fakeCouncilRun,
      });
      expect(r.ok).toBe(true);
      expect(r.worktreePath).toMatch(/codebase$/);
      expect(fs.existsSync(path.join(r.worktreePath!, '.git'))).toBe(true);
      expect(r.rounds).toBe(4);
      // No signal given, none passed on.
      expect(fakeCouncilRun.mock.calls[0][0].signal).toBeUndefined();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('hands the kernel signal to the council, so a cancelled build opens no further round', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ua-signal-'));
    try {
      const signal = { aborted: false };
      const councilRun = vi.fn().mockResolvedValue({ id: 'c', task: 't', status: 'error', config: {}, responses: [] });
      await runCouncilSynth({
        spec: makeEmptySpec('ua-signal'),
        runId: 'ua-signal',
        runDir: tmp,
        sessionManager: { startSession: vi.fn(), sendMessage: vi.fn(), stopSession: vi.fn() } as never,
        councilRun,
        signal,
      });
      expect(councilRun.mock.calls[0][0].signal).toBe(signal);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("treats council 'awaiting_user' status as success (consensus reached, ready for human review)", async () => {
    // Council's lifecycle on success is: consensus → awaiting_user. Ultraapp
    // doesn't want the human-review step; awaiting_user is the success state.
    const fakeCouncilRun = vi.fn().mockResolvedValue({
      id: 'c1',
      task: 't',
      status: 'awaiting_user',
      config: { agents: [], maxRounds: 8, projectDir: '' },
      responses: [
        {
          agent: 'a',
          round: 4,
          content: '...',
          consensus: true,
          sessionKey: 'k1',
          timestamp: '2026-05-12T00:00:00Z',
        },
      ],
      startTime: '2026-05-12T00:00:00Z',
    } satisfies CouncilSession);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ua-cs-'));
    try {
      const spec = makeEmptySpec('ua-1');
      spec.meta.name = 'demo';
      const r = await runCouncilSynth({
        spec,
        runId: 'ua-1',
        runDir: tmp,
        sessionManager: {
          startSession: vi.fn(),
          sendMessage: vi.fn(),
          stopSession: vi.fn(),
        } as never,
        councilRun: fakeCouncilRun,
      });
      expect(r.ok).toBe(true);
      expect(r.worktreePath).toMatch(/codebase$/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('returns failed when council reaches max rounds without consensus', async () => {
    const fakeCouncilRun = vi.fn().mockResolvedValue({
      id: 'c1',
      task: 't',
      status: 'max_rounds',
      config: { agents: [], maxRounds: 8, projectDir: '' },
      responses: [],
      startTime: '2026-05-12T00:00:00Z',
    } satisfies CouncilSession);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ua-cs-'));
    try {
      const spec = makeEmptySpec('ua-1');
      spec.meta.name = 'd';
      const r = await runCouncilSynth({
        spec,
        runId: 'ua-1',
        runDir: tmp,
        sessionManager: {
          startSession: vi.fn(),
          sendMessage: vi.fn(),
          stopSession: vi.fn(),
        } as never,
        councilRun: fakeCouncilRun,
      });
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/no consensus|max rounds/i);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('catches errors thrown by the council runner', async () => {
    const fakeCouncilRun = vi.fn().mockRejectedValue(new Error('cosmic ray'));
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ua-cs-'));
    try {
      const spec = makeEmptySpec('ua-1');
      spec.meta.name = 'd';
      const r = await runCouncilSynth({
        spec,
        runId: 'ua-1',
        runDir: tmp,
        sessionManager: {
          startSession: vi.fn(),
          sendMessage: vi.fn(),
          stopSession: vi.fn(),
        } as never,
        councilRun: fakeCouncilRun,
      });
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/cosmic ray/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
