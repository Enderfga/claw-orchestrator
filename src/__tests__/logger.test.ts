/**
 * The stderr logger used by the stdio servers, whose stdout carries nothing but
 * protocol frames.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

import { createStderrLogger } from '../logger.js';

describe('createStderrLogger', () => {
  const saved = process.env.OPENCLAW_LOG_LEVEL;
  afterEach(() => {
    vi.restoreAllMocks();
    if (saved === undefined) delete process.env.OPENCLAW_LOG_LEVEL;
    else process.env.OPENCLAW_LOG_LEVEL = saved;
  });

  const capture = () => ({
    out: vi.spyOn(console, 'log').mockImplementation(() => {}),
    warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
    err: vi.spyOn(console, 'error').mockImplementation(() => {}),
  });

  it('writes every level to stderr and nothing to stdout', () => {
    process.env.OPENCLAW_LOG_LEVEL = 'debug';
    const { out, warn, err } = capture();
    const log = createStderrLogger('clawo-acp');
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');
    expect(out).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(err.mock.calls.map((c) => c[0])).toEqual([
      '[clawo-acp] d',
      '[clawo-acp] i',
      '[clawo-acp] w',
      '[clawo-acp] e',
    ]);
  });

  it('drops the levels below OPENCLAW_LOG_LEVEL', () => {
    process.env.OPENCLAW_LOG_LEVEL = 'warn';
    const { err } = capture();
    const log = createStderrLogger('clawo-acp');
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');
    expect(err.mock.calls.map((c) => c[0])).toEqual(['[clawo-acp] w', '[clawo-acp] e']);
  });

  it('defaults to info', () => {
    delete process.env.OPENCLAW_LOG_LEVEL;
    const { err } = capture();
    const log = createStderrLogger();
    log.debug('d');
    log.info('i');
    expect(err.mock.calls.map((c) => c[0])).toEqual(['i']);
  });
});
