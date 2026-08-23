/**
 * UltraApp's acceptance contracts — the only mode whose contract is on by default.
 *
 * It earns that because it already ran most of these commands, and because its
 * own documentation has claimed two gates that the code never enforced:
 *
 *  1. `conventions.ts` §4 states "fix-on-failure runs `npm run smoke` and gates
 *     build-success on its passing". It did not — the step list was install /
 *     build / test / docker-build, with no smoke anywhere. The claim is now true.
 *  2. `ultraapp.md` recorded, as a known limitation since 4.0.0, that the §7g
 *     frontend gate "relies on per-agent honesty about running the screenshot
 *     capture", with a follow-up promised to make it structural. The capture is
 *     now performed by the runtime against the deployed URL and stored as
 *     evidence, so whether it happened is no longer an agent's word.
 *
 * What §7g still does not do is judge the pixels. A human or an agent still
 * decides whether the render is acceptable; the runtime guarantees only that the
 * images exist and are of the deployed app. Calling that visual regression would
 * be the same overclaim this module exists to remove.
 */

import type { AcceptanceContract, ContractCheck } from '../verify/contract.js';

/** §7g's two viewports, unchanged from the convention text agents were given. */
export const UI_VIEWPORTS = [
  { width: 1440, height: 900, label: 'desktop' },
  { width: 375, height: 812, label: 'mobile' },
];

const TEN_MIN = 10 * 60_000;

export interface BuildContractOptions {
  useDocker: boolean;
  fixRounds?: number;
}

/**
 * Build-stage checks, run in the council's worktree. The order is the old
 * `DEFAULT_STEPS` order, plus the smoke step the docs already promised.
 */
export function ultraappBuildContract(opts: BuildContractOptions): AcceptanceContract {
  const checks: ContractCheck[] = [
    { id: 'install', spec: { type: 'command', cmd: 'npm', args: ['install'], timeoutMs: TEN_MIN }, required: true },
    { id: 'build', spec: { type: 'command', cmd: 'npm', args: ['run', 'build'], timeoutMs: TEN_MIN }, required: true },
    { id: 'test', spec: { type: 'command', cmd: 'npm', args: ['test'], timeoutMs: TEN_MIN }, required: true },
  ];
  if (opts.useDocker) {
    checks.push({
      id: 'docker-build',
      spec: { type: 'command', cmd: 'docker', args: ['build', '-t', 'ultraapp-fix:test', '.'], timeoutMs: TEN_MIN },
      required: true,
    });
  }
  // Required, because §4 of the conventions makes `scripts.smoke` mandatory and
  // tells the council the gate is binding. A codebase without it has not met the
  // brief it was given.
  checks.push({
    id: 'smoke',
    spec: { type: 'command', cmd: 'npm', args: ['run', 'smoke'], timeoutMs: TEN_MIN },
    required: true,
  });

  return { id: 'ultraapp-build', checks, fixOnFailureRounds: opts.fixRounds ?? 5 };
}

/**
 * Whether a missing/failed screenshot capture should fail the deploy.
 *
 * Default is lenient: capture and store, record a failure, but do not sink a
 * working app because the host has no Chrome. `CLAWO_ULTRAAPP_VISUAL_GATE=strict`
 * makes it binding for setups that want §7g fully enforced.
 */
export function visualGateIsStrict(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.CLAWO_ULTRAAPP_VISUAL_GATE || '').toLowerCase() === 'strict';
}

/**
 * Deploy-stage checks, run against the live URL.
 *
 * No health probe here on purpose: `deployArtifact` already polls `/health` and
 * refuses to report success without it, so re-probing would be a second source
 * of truth for a question that is already settled.
 */
export function ultraappDeployContract(url: string, env: NodeJS.ProcessEnv = process.env): AcceptanceContract {
  return {
    id: 'ultraapp-deploy',
    checks: [
      {
        id: 'frontend-gate',
        spec: { type: 'screenshot', url, viewports: UI_VIEWPORTS },
        required: visualGateIsStrict(env),
      },
    ],
  };
}
