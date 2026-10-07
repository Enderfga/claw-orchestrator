/**
 * Spec-extraction quality regression test.
 *
 * For each reference trace under
 * `src/__tests__/fixtures/ultraapp-traces/<name>.jsonl`, replay it through
 * the real interview engine (with a stubbed Claude that emits the trace's
 * canned replies) and compare the resulting AppSpec against the frozen
 * `expected/<name>.appspec.json`. Any divergence is a regression in either
 * the interview engine or the trace itself.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { replayTrace, stripVolatile } from './trace-replayer.js';

const TRACES = ['text-summariser', 'image-batch-resize', 'vlog-cut', 'llm-agent-pipeline', 'branching-dag'];

const FIXTURES = path.resolve('src/__tests__/fixtures/ultraapp-traces');

for (const trace of TRACES) {
  describe(`reference trace: ${trace}`, () => {
    it('replays to the expected AppSpec', async () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `ua-trace-${trace}-`));
      try {
        const file = path.join(FIXTURES, `${trace}.jsonl`);
        const expected = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'expected', `${trace}.appspec.json`), 'utf8'));
        const { specJson } = await replayTrace(file, tmp);
        expect(stripVolatile(specJson)).toEqual(stripVolatile(expected));
      } finally {
        // Turns the replayer drives are fire-and-forget, so one can still be
        // writing into the store when this runs; a single rmdir then fails with
        // ENOTEMPTY and turns a passing replay red.
        fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      }
    });
  });
}
