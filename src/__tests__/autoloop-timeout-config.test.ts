import { describe, expect, it } from 'vitest';

import * as AutoloopTypes from '../autoloop/types.js';

describe('Autoloop timeout configuration', () => {
  it('resolves omitted timeout values to the backward-compatible defaults', () => {
    const api = AutoloopTypes as unknown as {
      resolveAutoloopTimeoutConfig?: (config?: Record<string, number>) => Record<string, number>;
    };

    expect(api.resolveAutoloopTimeoutConfig).toBeTypeOf('function');
    expect(api.resolveAutoloopTimeoutConfig!()).toEqual({
      sendTimeoutMs: 600_000,
      activityLeaseMs: 1_800_000,
      autoloopHardTimeoutMs: 86_400_000,
    });
  });

  it.each([
    {
      label: 'inclusive minimums',
      config: { sendTimeoutMs: 5_000, activityLeaseMs: 60_000, autoloopHardTimeoutMs: 600_000 },
    },
    {
      label: 'inclusive maximums',
      config: { sendTimeoutMs: 7_200_000, activityLeaseMs: 7_200_000, autoloopHardTimeoutMs: 259_200_000 },
    },
    {
      label: 'ordinary values inside the ranges',
      config: { sendTimeoutMs: 45_000, activityLeaseMs: 900_000, autoloopHardTimeoutMs: 7_200_000 },
    },
  ])('accepts $label without changing them', ({ config }) => {
    expect(AutoloopTypes.resolveAutoloopTimeoutConfig(config)).toEqual(config);
  });

  it.each([
    ['sendTimeoutMs', 4_999],
    ['sendTimeoutMs', 7_200_001],
    ['activityLeaseMs', 59_999],
    ['activityLeaseMs', 7_200_001],
    ['autoloopHardTimeoutMs', 599_999],
    ['autoloopHardTimeoutMs', 259_200_001],
  ] as const)('rejects an out-of-range %s value of %s', (field, value) => {
    expect(() => AutoloopTypes.resolveAutoloopTimeoutConfig({ [field]: value })).toThrow(
      `${field} must be a finite number in the inclusive range`,
    );
  });

  it.each([
    ['sendTimeoutMs', Number.NaN],
    ['activityLeaseMs', Number.POSITIVE_INFINITY],
    ['autoloopHardTimeoutMs', '86400000'],
  ] as const)('rejects a non-finite or non-numeric %s value', (field, value) => {
    expect(() =>
      AutoloopTypes.resolveAutoloopTimeoutConfig({
        [field]: value,
      } as unknown as AutoloopTypes.AutoloopTimeoutConfig),
    ).toThrow(`${field} must be a finite number in the inclusive range`);
  });
});
