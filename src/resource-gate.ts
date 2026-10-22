/**
 * Server-side resource gate for Claw `*_start` tools.
 *
 * The fleet script (`resource-gate.sh`) used to be an instruction in each
 * agent's prompt, so a model that never runs shell skipped it. These starts
 * now run the script themselves and refuse before any session, workflow, or
 * agent is created.
 *
 * `CLAW_RESOURCE_GATE` selects the script. When it is unset, the fleet path
 * is used if that file exists. When neither is available the gate is a no-op
 * so a stock install without the script still starts. A path that was set
 * explicitly and is missing is an error — the operator asked for a gate.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';

export const RESOURCE_GATED_STARTS = [
  'workflow_start',
  'fanout_start',
  'council_start',
  'autoloop_start',
  'ultrareview_start',
  'ultraplan_start',
] as const;

export type ResourceGatedStart = (typeof RESOURCE_GATED_STARTS)[number];

/** Fleet copy. Present on vps-ovh; absent on a normal upstream checkout. */
export const DEFAULT_RESOURCE_GATE = '/home/openclaw/.openclaw/workspace-twin/tools/resource-gate.sh';

const GATE_TIMEOUT_MS = 15_000;

export class ResourceGateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResourceGateError';
  }
}

export function isResourceGatedStart(name: string): name is ResourceGatedStart {
  return (RESOURCE_GATED_STARTS as readonly string[]).includes(name);
}

/** Script to run, or null when this process has no gate configured. */
export function resolveResourceGateScript(): string | null {
  const fromEnv = process.env.CLAW_RESOURCE_GATE?.trim();
  if (fromEnv) return fromEnv;
  if (fs.existsSync(DEFAULT_RESOURCE_GATE)) return DEFAULT_RESOURCE_GATE;
  return null;
}

/**
 * Run the gate. Resolves when the script exits 0.
 * Rejects with `ResourceGateError` carrying the script's OVERLOADED line.
 */
export function assertResourceGate(): Promise<void> {
  const script = resolveResourceGateScript();
  if (!script) return Promise.resolve();
  if (!fs.existsSync(script)) {
    return Promise.reject(new ResourceGateError(`resource gate script not found: ${script}`));
  }

  return new Promise((resolve, reject) => {
    const child = spawn(script, [], {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const take = (buf: Buffer): void => {
      if (out.length < 4_000) out += buf.toString();
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new ResourceGateError('resource gate timed out'));
    }, GATE_TIMEOUT_MS);
    timer.unref?.();
    child.on('error', (err: Error) => {
      clearTimeout(timer);
      reject(new ResourceGateError(`resource gate failed to run: ${err.message}`));
    });
    child.on('close', (code: number | null) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
        return;
      }
      const text = out.trim() || `resource gate refused the start (exit ${code ?? 'null'})`;
      reject(new ResourceGateError(text));
    });
  });
}
