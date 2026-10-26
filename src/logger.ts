/**
 * Structured logging interface with level control.
 *
 * Default implementation logs to console, filtered by OPENCLAW_LOG_LEVEL env var.
 * Valid levels: debug, info, warn, error. Default: info.
 */

export interface Logger {
  debug(msg: string, ...args: unknown[]): void;
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
}

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type LogLevel = keyof typeof LEVELS;

function parseLevel(envVal?: string): LogLevel {
  if (envVal && envVal in LEVELS) return envVal as LogLevel;
  return 'info';
}

/** Create a console-backed logger with optional prefix and env-var level control. */
export function createConsoleLogger(prefix?: string): Logger {
  const level = parseLevel(process.env.OPENCLAW_LOG_LEVEL);
  const threshold = LEVELS[level];
  const pfx = prefix ? `[${prefix}] ` : '';

  return {
    debug: (msg, ...args) => {
      if (threshold <= LEVELS.debug) console.log(`${pfx}${msg}`, ...args);
    },
    info: (msg, ...args) => {
      if (threshold <= LEVELS.info) console.log(`${pfx}${msg}`, ...args);
    },
    warn: (msg, ...args) => {
      if (threshold <= LEVELS.warn) console.warn(`${pfx}${msg}`, ...args);
    },
    error: (msg, ...args) => {
      if (threshold <= LEVELS.error) console.error(`${pfx}${msg}`, ...args);
    },
  };
}

/**
 * Every level to stderr, filtered by OPENCLAW_LOG_LEVEL like the console logger.
 *
 * For the stdio servers, whose stdout carries nothing but protocol frames.
 */
export function createStderrLogger(prefix?: string): Logger {
  const threshold = LEVELS[parseLevel(process.env.OPENCLAW_LOG_LEVEL)];
  const pfx = prefix ? `[${prefix}] ` : '';
  const at =
    (level: LogLevel) =>
    (msg: string, ...args: unknown[]) => {
      if (threshold <= LEVELS[level]) console.error(`${pfx}${msg}`, ...args);
    };
  return { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
}

/** No-op logger — useful in tests to suppress output. */
export const nullLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};
