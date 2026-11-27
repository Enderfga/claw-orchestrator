/**
 * `workflow_start`'s `forum` parameter puts the agents of every built-in
 * template on a run forum, not only the fan-out's and the council's.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import plugin from '../index.js';
import { SessionManager } from '../session-manager.js';
import type { WorkflowSpec } from '../kernel/types.js';

interface RegisteredTool {
  name: string;
  execute: (toolCallId: string, params: Record<string, unknown>) => Promise<unknown>;
}

function register(): { tool: RegisteredTool; stop: () => void } {
  const tools: RegisteredTool[] = [];
  const services: Array<{ stop: () => void }> = [];
  const fakeApi = {
    pluginConfig: {},
    logger: { info: () => {}, error: () => {}, warn: () => {} },
    registerTool: (def: RegisteredTool) => void tools.push(def),
    on: () => {},
    registerHttpRoute: () => {},
    registerService: (def: { stop: () => void }) => void services.push(def),
  };
  (plugin as unknown as { register: (api: unknown) => void }).register(fakeApi);
  return { tool: tools.find((t) => t.name === 'workflow_start')!, stop: () => services[0]?.stop() };
}

const previousNoServer = process.env.CLAWO_NO_EMBEDDED_SERVER;
afterEach(() => {
  vi.restoreAllMocks();
  if (previousNoServer === undefined) delete process.env.CLAWO_NO_EMBEDDED_SERVER;
  else process.env.CLAWO_NO_EMBEDDED_SERVER = previousNoServer;
});

/** The spec `workflow_start` builds for these arguments. */
async function specFor(args: Record<string, unknown>): Promise<WorkflowSpec> {
  process.env.CLAWO_NO_EMBEDDED_SERVER = '1';
  const start = vi
    .spyOn(SessionManager.prototype, 'workflowStart')
    .mockResolvedValue({ runId: 'r', workflow: 'w', state: 'pending', nodes: {} } as never);
  const { tool, stop } = register();
  try {
    await tool.execute('t', args);
    return start.mock.calls[0][0] as WorkflowSpec;
  } finally {
    stop();
  }
}

const agents = [{ name: 'a' }, { name: 'b' }];

describe('workflow_start forum', () => {
  for (const template of ['solve', 'goal', 'fanout', 'council']) {
    it(`puts the ${template} template's agents on a forum`, async () => {
      expect((await specFor({ template, task: 'do it', agents, forum: true })).forum).toBeTruthy();
      expect((await specFor({ template, task: 'do it', agents, forum: { push: 'all' } })).forum).toEqual({
        push: 'all',
      });
    });
  }

  it('leaves solve and goal off a forum unless it is given', async () => {
    for (const template of ['solve', 'goal']) {
      expect((await specFor({ template, task: 'do it', agents })).forum).toBeUndefined();
      expect((await specFor({ template, task: 'do it', agents, forum: false })).forum).toBeUndefined();
    }
  });
});
