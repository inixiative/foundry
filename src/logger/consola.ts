// ---------------------------------------------------------------------------
// Consola adapter — colorful, human-readable output for development
// ---------------------------------------------------------------------------

import {
  type Logger,
  type LoggerConfig,
  type LogLevel,
  LOG_LEVEL_VALUES,
  getLogScopes,
  getLogBroadcasts,
} from "./scope";

/** Map our levels to consola's numeric levels. */
const CONSOLA_LEVELS: Record<LogLevel, number> = {
  silent: 0,
  fatal: 0,
  error: 0,
  warn: 1,
  info: 3,
  debug: 4,
  trace: 5,
};

function resolveLevel(config?: LoggerConfig): LogLevel {
  if (config?.level) return config.level;
  const env = process.env.LOG_LEVEL as LogLevel | undefined;
  if (env && env in LOG_LEVEL_VALUES) return env;
  return "info";
}

/**
 * Create a consola-backed logger.
 *
 * Features:
 * - Colored output with compact formatting
 * - Automatic scope tags from AsyncLocalStorage
 * - Log broadcasting to registered targets
 * - `box()` for startup banners
 *
 * @example
 * import { createConsolaLogger } from "./logger/consola";
 * const log = createConsolaLogger();
 * log.info("server started");
 */
export async function createConsolaLogger(
  config?: LoggerConfig,
): Promise<Logger> {
  const { createConsola } = await import("consola");
  const level = resolveLevel(config);
  const timestamps = config?.timestamps !== false;

  const base = createConsola({
    level: CONSOLA_LEVELS[level] ?? 3,
    formatOptions: {
      date: false,
      colors: true,
      compact: true,
    },
  });

  function prefix(): string {
    const parts: string[] = [];
    if (timestamps) parts.push(`[${new Date().toISOString()}]`);
    const scopes = getLogScopes();
    if (scopes.length > 0) {
      parts.push(scopes.map((s) => `[${s}]`).join(" "));
    }
    return parts.join(" ");
  }

  function broadcast(lvl: string, args: unknown[]): void {
    const targets = getLogBroadcasts();
    if (targets.length === 0) return;
    const msg = args
      .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
      .join(" ");
    for (const fn of targets) {
      try {
        fn(lvl, msg);
      } catch {
        // broadcast errors never affect the log call
      }
    }
  }

  function wrap(
    method: (...args: unknown[]) => void,
    lvl: string,
  ): (...args: unknown[]) => void {
    return (...args: unknown[]) => {
      const p = prefix();
      broadcast(lvl, p ? [p, ...args] : args);
      if (p) {
        method(p, ...args);
      } else {
        method(...args);
      }
    };
  }

  const logger: Logger = {
    fatal: wrap(base.fatal.bind(base), "fatal"),
    error: wrap(base.error.bind(base), "error"),
    warn: wrap(base.warn.bind(base), "warn"),
    info: wrap(base.info.bind(base), "info"),
    debug: wrap(base.debug.bind(base), "debug"),
    trace: wrap(base.trace.bind(base), "trace"),
    box(message: string) {
      base.box(message);
    },
    child(scope: string): Logger {
      return createChildLogger(logger, scope);
    },
  };

  return logger;
}

function createChildLogger(parent: Logger, scope: string): Logger {
  function addScope(args: unknown[]): unknown[] {
    return [`[${scope}]`, ...args];
  }

  const child: Logger = {
    fatal: (...args) => parent.fatal(...addScope(args)),
    error: (...args) => parent.error(...addScope(args)),
    warn: (...args) => parent.warn(...addScope(args)),
    info: (...args) => parent.info(...addScope(args)),
    debug: (...args) => parent.debug(...addScope(args)),
    trace: (...args) => parent.trace(...addScope(args)),
    box: parent.box?.bind(parent),
    child(innerScope: string): Logger {
      return createChildLogger(child, innerScope);
    },
  };

  return child;
}
