/**
 * UltraApp's default contracts.
 *
 * These pin the two claims the code did not previously honour: the conventions
 * text told every council that `npm run smoke` gates build success (it was not in
 * the step list at all), and `ultraapp.md` recorded since 4.0.0 that the §7g
 * frontend gate depended on agents honestly running the screenshot capture.
 */

import { describe, it, expect } from 'vitest';
import {
  UI_VIEWPORTS,
  ultraappBuildContract,
  ultraappDeployContract,
  visualGateIsStrict,
} from '../../ultraapp/contract.js';
import { stepsToContract, DEFAULT_STEPS } from '../../ultraapp/fix-on-failure.js';

const ids = (c: { checks: Array<{ id?: string }> }) => c.checks.map((x) => x.id);

describe('build contract', () => {
  it('includes the smoke step the conventions always claimed was binding', () => {
    const c = ultraappBuildContract({ useDocker: false });
    expect(ids(c)).toContain('smoke');
    const smoke = c.checks.find((x) => x.id === 'smoke')!;
    expect(smoke.required).toBe(true);
    expect(smoke.spec).toMatchObject({ type: 'command', cmd: 'npm', args: ['run', 'smoke'] });
  });

  it('keeps the original step order and adds docker only in docker mode', () => {
    expect(ids(ultraappBuildContract({ useDocker: false }))).toEqual(['install', 'build', 'test', 'smoke']);
    expect(ids(ultraappBuildContract({ useDocker: true }))).toEqual([
      'install',
      'build',
      'test',
      'docker-build',
      'smoke',
    ]);
  });

  it('gives every command check a timeout, which the predecessor pipeline had none of', () => {
    for (const check of ultraappBuildContract({ useDocker: true }).checks) {
      expect(check.spec).toHaveProperty('timeoutMs');
      expect((check.spec as { timeoutMs: number }).timeoutMs).toBeGreaterThan(0);
    }
  });

  it('carries a fix-on-red budget', () => {
    expect(ultraappBuildContract({ useDocker: false }).fixOnFailureRounds).toBe(5);
    expect(ultraappBuildContract({ useDocker: false, fixRounds: 2 }).fixOnFailureRounds).toBe(2);
  });
});

describe('deploy contract', () => {
  it('captures both §7g viewports against the deployed URL', () => {
    const c = ultraappDeployContract('http://localhost:19000/forge/demo/');
    const gate = c.checks.find((x) => x.id === 'frontend-gate')!;
    expect(gate.spec).toMatchObject({ type: 'screenshot', url: 'http://localhost:19000/forge/demo/' });
    expect((gate.spec as { viewports: unknown[] }).viewports).toEqual(UI_VIEWPORTS);
    expect(UI_VIEWPORTS.map((v) => `${v.width}x${v.height}`)).toEqual(['1440x900', '375x812']);
  });

  it('does not re-probe health, which deployArtifact already gates on', () => {
    expect(ids(ultraappDeployContract('http://x/'))).toEqual(['frontend-gate']);
  });

  it('is advisory by default so a host without Chrome does not lose a working app', () => {
    expect(ultraappDeployContract('http://x/', {}).checks[0].required).toBe(false);
  });

  it('becomes binding under CLAWO_ULTRAAPP_VISUAL_GATE=strict', () => {
    expect(visualGateIsStrict({ CLAWO_ULTRAAPP_VISUAL_GATE: 'strict' })).toBe(true);
    expect(visualGateIsStrict({ CLAWO_ULTRAAPP_VISUAL_GATE: 'STRICT' })).toBe(true);
    expect(visualGateIsStrict({ CLAWO_ULTRAAPP_VISUAL_GATE: 'no' })).toBe(false);
    expect(visualGateIsStrict({})).toBe(false);
    expect(ultraappDeployContract('http://x/', { CLAWO_ULTRAAPP_VISUAL_GATE: 'strict' }).checks[0].required).toBe(true);
  });
});

describe('legacy step translation', () => {
  it('honours required:false, the flag the old runner declared and never read', () => {
    const c = stepsToContract(
      [
        { cmd: 'a', args: [] },
        { cmd: 'b', args: [], required: false },
      ],
      3,
    );
    expect(c.checks.map((x) => x.required)).toEqual([true, false]);
  });

  it('gives untimed legacy steps a timeout', () => {
    const c = stepsToContract(DEFAULT_STEPS, 5);
    for (const check of c.checks) expect((check.spec as { timeoutMs?: number }).timeoutMs).toBeGreaterThan(0);
  });
});
