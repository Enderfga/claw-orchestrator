/**
 * A fan-out writes every agent's output, and the synthesis, to the run
 * directory, and its results name the files: an MCP client may cut a large
 * tool result, so a caller reads long reports from there whole.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RunKernel } from '../../kernel/engine.js';
import { registerDefaultExecutors } from '../../kernel/nodes/index.js';
import { runDir } from '../../kernel/store.js';
import { toFanoutSession } from '../../kernel/projections.js';

describe('fan-out output files', () => {
  it('writes outputs/<agent>.md and outputs/synthesis.md, failures included, and names them in the results', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clawo-fanout-out-'));
    const report = `# Review\n\n${'A finding with detail. '.repeat(4000)}`;
    const manager = {
      async startSession(config: { name?: string }) {
        return { name: config.name } as never;
      },
      async sendMessage(name: string, _message: string, options: { onChunk?: (t: string) => void } = {}) {
        if (name.endsWith('-slow')) {
          options.onChunk?.('half a report');
          throw new Error('Timeout waiting for Grok response');
        }
        if (name.includes('synth')) return { output: 'merged view', events: [] } as never;
        return { output: name.endsWith('-codex') ? report : 'short', events: [] } as never;
      },
      async stopSession() {},
    };
    const kernel = registerDefaultExecutors(new RunKernel({ manager: manager as never, nodeTimeoutMs: 20_000 }));
    const run = await kernel.start({
      name: 'review',
      cwd: tmp,
      nodes: [
        {
          // `main`: the node id fanout_start's single-node workflow uses, which fanout_status reads.
          id: 'main',
          kind: 'fanout',
          prompt: 'review it',
          synthesize: true,
          agents: [
            { name: 'codex', engine: 'codex', sandboxMode: 'read-only' },
            { name: 'agy', engine: 'agy', model: 'gemini-4-neon-high' },
            { name: 'slow', engine: 'grok' },
          ],
        } as never,
      ],
    });
    const done = await kernel.wait(run.runId);
    try {
      const fan = toFanoutSession(done!);
      const dir = path.join(runDir(run.runId), 'outputs');
      const byName = Object.fromEntries(fan.results.map((r) => [r.agent, r]));
      expect(byName.codex.outputFile).toBe(path.join(dir, 'codex.md'));
      // Whole, however long.
      expect(fs.readFileSync(byName.codex.outputFile!, 'utf8')).toBe(report);
      expect(fs.readFileSync(byName.agy.outputFile!, 'utf8')).toBe('short');
      // A timed-out agent's file says so, and holds what it had written.
      expect(byName.slow).toMatchObject({ ok: false, timedOut: true, output: 'half a report' });
      const slow = fs.readFileSync(byName.slow.outputFile!, 'utf8');
      expect(slow).toMatch(/^<!-- failed: timed out after 30 min/);
      expect(slow).toContain('half a report');
      expect(fan.synthesisFile).toBe(path.join(dir, 'synthesis.md'));
      expect(fs.readFileSync(fan.synthesisFile!, 'utf8')).toBe(fan.synthesis);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
