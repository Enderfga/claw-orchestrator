/** Default node executors, wired onto a kernel instance. */

import type { RunKernel } from '../engine.js';
import { executeAgentNode } from './agent.js';
import { executeCouncilNode } from './council.js';
import { executeFanoutNode } from './fanout.js';
import { executeGoalNode } from './goal.js';
import { executeHumanGateNode } from './human-gate.js';
import { executeRouterNode } from './router.js';
import { executeVerifierNode } from './verifier.js';
import { makeSubflowExecutor, type WorkflowResolver } from './subflow.js';

export {
  executeAgentNode,
  executeCouncilNode,
  executeFanoutNode,
  executeGoalNode,
  executeHumanGateNode,
  executeRouterNode,
  executeVerifierNode,
};
export { makeSubflowExecutor, type WorkflowResolver };

export function registerDefaultExecutors(kernel: RunKernel, resolve?: WorkflowResolver): RunKernel {
  kernel.setExecutor('agent', executeAgentNode);
  kernel.setExecutor('fanout', executeFanoutNode);
  kernel.setExecutor('council', executeCouncilNode);
  kernel.setExecutor('goal', executeGoalNode);
  kernel.setExecutor('verifier', executeVerifierNode);
  kernel.setExecutor('human_gate', executeHumanGateNode);
  kernel.setExecutor('router', executeRouterNode);
  kernel.setExecutor('subflow', makeSubflowExecutor(kernel, resolve));
  return kernel;
}
