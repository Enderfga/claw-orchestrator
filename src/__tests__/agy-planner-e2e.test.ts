import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import { ClaudeAgentDispatcher } from '../autoloop/dispatcher.js';
import { Msg } from '../autoloop/messages.js';
import type { SpawnSubagentsArgs } from '../autoloop/planner-tools.js';
import { nullLogger } from '../logger.js';
import { SessionManager } from '../session-manager.js';

const FIXTURE_PATH = fileURLToPath(new URL('./fixtures/agy-planner-1.1.26.mjs', import.meta.url));
const CONVERSATION_ID = 'a126a126-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const ORIGINAL_PLAN = Buffer.from('# original plan\r\nbyte stable\r\n');
const ORIGINAL_GOAL = Buffer.from('{"original":true}\n');
const RECOVERED_PLAN = '# recovered plan\n\nExact fixture bytes.\n';
const RECOVERED_GOAL = '{\n  "scalar": null,\n  "gates": []\n}\n';
const INITIAL_DIRECTIVE = {
  goal: 'execute the recovered plan',
  constraints: ['preserve exact artifact bytes'],
  success_criteria: ['run the synthetic gate'],
  max_attempts: 1,
};

function plannerTemps(workspace: string): string[] {
  return fs.readdirSync(workspace).filter((name) => name.startsWith('.plan.md.') || name.startsWith('.goal.json.'));
}

describe('agy Planner subprocess recovery', () => {
  it('recovers a soft-denied empty turn in the same conversation before one atomic spawn', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-planner-e2e-'));
    const planPath = path.join(workspace, 'plan.md');
    const goalPath = path.join(workspace, 'goal.json');
    fs.writeFileSync(planPath, ORIGINAL_PLAN);
    fs.writeFileSync(goalPath, ORIGINAL_GOAL);

    const previousAgyBin = process.env.AGY_BIN;
    process.env.AGY_BIN = FIXTURE_PATH;
    const manager = new SessionManager({ maxConcurrentSessions: 1 }, nullLogger);
    const observedAtSpawn: Array<{
      args: SpawnSubagentsArgs;
      plan: Buffer;
      goal: Buffer;
    }> = [];
    const spawnSubagents = vi.fn(async (args: SpawnSubagentsArgs) => {
      observedAtSpawn.push({
        args,
        plan: fs.readFileSync(planPath),
        goal: fs.readFileSync(goalPath),
      });
    });
    const dispatcher = new ClaudeAgentDispatcher({
      manager,
      runId: `agy-e2e-${randomUUID()}`,
      workspace,
      plannerEngine: 'agy',
      onSpawnSubagents: spawnSubagents,
      logger: nullLogger,
    });

    try {
      // The first turn is soft-denied and ends empty; a read-only agy session
      // continues it in the same conversation by itself, so the one delivery
      // comes back with the recovered plan.
      const recoveredMessages = await dispatcher.deliver(Msg.chat(0, { text: 'inspect and propose a plan' }));

      expect(observedAtSpawn).toEqual([
        {
          args: { initial_directive: INITIAL_DIRECTIVE },
          plan: Buffer.from(RECOVERED_PLAN),
          goal: Buffer.from(RECOVERED_GOAL),
        },
      ]);
      expect(spawnSubagents).toHaveBeenCalledTimes(1);
      expect(fs.readFileSync(planPath)).toEqual(Buffer.from(RECOVERED_PLAN));
      expect(fs.readFileSync(goalPath)).toEqual(Buffer.from(RECOVERED_GOAL));
      expect(plannerTemps(workspace)).toEqual([]);
      expect(recoveredMessages.filter(({ type }) => type === 'directive')).toEqual([
        expect.objectContaining({ iter: 0, payload: INITIAL_DIRECTIVE }),
      ]);
      expect(manager.getStatus(dispatcher.sessionNames.planner).stats).toMatchObject({
        agyConversationId: CONVERSATION_ID,
        turns: 2,
        turnsSucceeded: 1,
      });
    } finally {
      await dispatcher.shutdown('agy-e2e-cleanup', { purge: true });
      await manager.shutdown();
      if (previousAgyBin === undefined) delete process.env.AGY_BIN;
      else process.env.AGY_BIN = previousAgyBin;
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });
});
