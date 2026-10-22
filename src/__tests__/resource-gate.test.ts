import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import plugin from '../index.js';
import {
  DEFAULT_RESOURCE_GATE,
  RESOURCE_GATED_STARTS,
  assertResourceGate,
  isResourceGatedStart,
  resolveResourceGateScript,
} from '../resource-gate.js';

interface RegisteredTool {
  name: string;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
  ) => Promise<{
    details?: { ok?: boolean; runId?: string; state?: string; cancelled?: boolean };
  }>;
}

function collectTools(): Map<string, RegisteredTool> {
  const tools: RegisteredTool[] = [];
  const fakeApi = {
    pluginConfig: {},
    logger: { info: () => {}, error: () => {}, warn: () => {} },
    registerTool: (def: RegisteredTool) => {
      tools.push(def);
    },
    on: () => {},
    registerHttpRoute: () => {},
    registerService: () => {},
  };
  (plugin as unknown as { register: (api: unknown) => void }).register(fakeApi);
  return new Map(tools.map((tool) => [tool.name, tool]));
}

function writeScript(dir: string, name: string, body: string): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, body, { mode: 0o755 });
  fs.chmodSync(file, 0o755);
  return file;
}

describe('resource gate', () => {
  const prev: Record<string, string | undefined> = {};
  let dir = '';

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claw-resource-gate-'));
    for (const key of ['CLAW_RESOURCE_GATE', 'CLAWO_WF_DIR', 'GATE_MAX_LOAD_PER_CORE', 'GATE_MIN_AVAIL_MB']) {
      prev[key] = process.env[key];
    }
    process.env.CLAWO_WF_DIR = path.join(dir, 'wf');
    delete process.env.GATE_MAX_LOAD_PER_CORE;
    delete process.env.GATE_MIN_AVAIL_MB;
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('names exactly the six start tools', () => {
    expect([...RESOURCE_GATED_STARTS].sort()).toEqual(
      [
        'autoloop_start',
        'council_start',
        'fanout_start',
        'ultraplan_start',
        'ultrareview_start',
        'workflow_start',
      ].sort(),
    );
    expect(isResourceGatedStart('workflow_start')).toBe(true);
    expect(isResourceGatedStart('session_start')).toBe(false);
    expect(isResourceGatedStart('workflow_status')).toBe(false);
  });

  it('refuses when the fixture exits non-zero and passes when it exits 0', async () => {
    const overloaded = writeScript(dir, 'over.sh', '#!/bin/sh\necho "OVERLOADED: fixture load"\nexit 1\n');
    process.env.CLAW_RESOURCE_GATE = overloaded;
    await expect(assertResourceGate()).rejects.toThrow(/OVERLOADED: fixture load/);

    const ok = writeScript(dir, 'ok.sh', '#!/bin/sh\necho "OK: fixture"\nexit 0\n');
    process.env.CLAW_RESOURCE_GATE = ok;
    await expect(assertResourceGate()).resolves.toBeUndefined();
  });

  it('errors when CLAW_RESOURCE_GATE points at a missing script', async () => {
    process.env.CLAW_RESOURCE_GATE = path.join(dir, 'missing.sh');
    await expect(assertResourceGate()).rejects.toThrow(/not found/);
  });

  it('is a no-op only when no script is configured', () => {
    process.env.CLAW_RESOURCE_GATE = path.join(dir, 'explicit.sh');
    expect(resolveResourceGateScript()).toBe(path.join(dir, 'explicit.sh'));
    delete process.env.CLAW_RESOURCE_GATE;
    const resolved = resolveResourceGateScript();
    if (fs.existsSync(DEFAULT_RESOURCE_GATE)) expect(resolved).toBe(DEFAULT_RESOURCE_GATE);
    else expect(resolved).toBeNull();
  });

  it('every *_start refuses before it validates arguments when the gate is OVERLOADED', async () => {
    const overloaded = writeScript(dir, 'over.sh', '#!/bin/sh\necho "OVERLOADED: fixture"\nexit 1\n');
    process.env.CLAW_RESOURCE_GATE = overloaded;
    const tools = collectTools();
    for (const name of RESOURCE_GATED_STARTS) {
      const tool = tools.get(name);
      expect(tool, name).toBeTruthy();
      await expect(tool!.execute('call', {}), name).rejects.toThrow(/OVERLOADED: fixture/);
    }
  });

  it('accepts workflow_start when the gate exits 0, then cancels the parked run', async () => {
    const ok = writeScript(dir, 'ok.sh', '#!/bin/sh\necho "OK: fixture"\nexit 0\n');
    process.env.CLAW_RESOURCE_GATE = ok;
    const tools = collectTools();
    const cwd = path.join(dir, 'project');
    fs.mkdirSync(cwd);
    const runId = `b2-gate-ok-${process.pid}`;
    const started = await tools.get('workflow_start')!.execute('call', {
      runId,
      cwd,
      spec: {
        name: 'b2-gate-ok',
        cwd,
        nodes: [{ id: 'hold', kind: 'human_gate', prompt: 'park for the resource-gate proof' }],
      },
    });
    expect(started.details?.ok).toBe(true);
    expect(started.details?.runId).toBe(runId);
    const cancelled = await tools.get('workflow_cancel')!.execute('call', { runId });
    expect(cancelled.details?.ok).toBe(true);
    expect(cancelled.details?.cancelled).toBe(true);
  });

  it.skipIf(!fs.existsSync(DEFAULT_RESOURCE_GATE))(
    'live resource-gate.sh: env-forced OVERLOADED refuses, OK accepts',
    async () => {
      process.env.CLAW_RESOURCE_GATE = DEFAULT_RESOURCE_GATE;
      process.env.GATE_MIN_AVAIL_MB = '1';
      process.env.GATE_MAX_LOAD_PER_CORE = '0.01';
      const tools = collectTools();
      await expect(tools.get('workflow_start')!.execute('call', {})).rejects.toThrow(/OVERLOADED/);

      process.env.GATE_MAX_LOAD_PER_CORE = '1000';
      const cwd = path.join(dir, 'live-project');
      fs.mkdirSync(cwd);
      const runId = `b2-gate-live-${process.pid}`;
      const started = await tools.get('workflow_start')!.execute('call', {
        runId,
        cwd,
        spec: {
          name: 'b2-gate-live',
          cwd,
          nodes: [{ id: 'hold', kind: 'human_gate', prompt: 'park for the live resource-gate proof' }],
        },
      });
      expect(started.details?.ok).toBe(true);
      expect(started.details?.runId).toBe(runId);
      const cancelled = await tools.get('workflow_cancel')!.execute('call', { runId });
      expect(cancelled.details?.cancelled).toBe(true);
    },
  );
});
