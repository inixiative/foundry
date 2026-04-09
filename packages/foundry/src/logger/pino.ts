// ---------------------------------------------------------------------------
// Pino adapter — structured JSON output for production
// ---------------------------------------------------------------------------

import {
  type Logger,
  type LoggerConfig,
  type LogLevel,
  LOG_LEVEL_VALUES,
  getLogScopes,
  getLogBroadcasts,
} from "./scope";

function resolveLevel(config?: LoggerConfig): LogLevel {
  if (config?.level) return config.level;
  const env = process.env.LOG_LEVEL as LogLevel | undefined;
  if (env && env in LOG_LEVEL_VALUES) return env;
  return "info";
}

/**
 * Create a pino-backed logger.
 *
 * Features:
 * - Structured JSON output (one object per line)
 * - Automatic scope injection into log objects
 * - Log broadcasting to registered targets
 * - Fast, low-overhead — ideal for production
 *
 * Requires `pino` as a peer dependency. Install with:
 *   bun add pino
 *
 * @example
 * import { createPinoLogger } from "./logger/pino";
 * const log = await createPinoLogger();
 * log.info("server started");
 * // {"level":30,"time":1712...,"scopes":[],"msg":"server started"}
 */
export async function createPinoLogger(
  config?: LoggerConfig,
): Promise<Logger> {
  const pino = (await import("pino")).default;
  const level = resolveLevel(config);
  const timestamps = config?.timestamps !== false;

  const base = pino({
    level,
    timestamp: timestamps ? pino.stdTimeFunctions.isoTime : false,
  });

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
    method: (obj: Record<string, unknown>, msg: string) => void,
    lvl: string,
  ): (...args: unknown[]) => void {
    return (...args: unknown[]) => {
      const scopes = getLogScopes();

      // Separate object args from message args
      let obj: Record<string, unknown> = {};
      const msgParts: string[] = [];

      for (const arg of args) {
        if (typeof arg === "object" && arg !== null && !Array.isArray(arg) && !(arg instanceof Error)) {
          obj = { ...obj, ...(arg as Record<string, unknown>) };
        } else if (arg instanceof Error) {
          obj.err = { message: arg.message, stack: arg.stack, name: arg.name };
          msgParts.push(arg.message);
        } else {
          msgParts.push(String(arg));
        }
      }

      if (scopes.length > 0) obj.scopes = scopes;

      const msg = msgParts.join(" ");
      broadcast(lvl, scopes.length > 0 ? [`[${scopes.join("][")}]`, msg] : [msg]);
      method(obj, msg);
    };
  }

  const logger: Logger = {
    fatal: wrap(base.fatal.bind(base), "fatal"),
    error: wrap(base.error.bind(base), "error"),
    warn: wrap(base.warn.bind(base), "warn"),
    info: wrap(base.info.bind(base), "info"),
    debug: wrap(base.debug.bind(base), "debug"),
    trace: wrap(base.trace.bind(base), "trace"),
    child(scope: string): Logger {
      return createPinoChild(base.child({ scope }), scope);
    },
  };

  return logger;
}

function createPinoChild(pinoChild: any, scope: string): Logger {
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
        // Fire-and-forget
      }
    }
  }

  function wrap(
    method: (obj: Record<string, unknown>, msg: string) => void,
    lvl: string,
  ): (...args: unknown[]) => void {
    return (...args: unknown[]) => {
      const scopes = getLogScopes();
      let obj: Record<string, unknown> = {};
      const msgParts: string[] = [];

      for (const arg of args) {
        if (typeof arg === "object" && arg !== null && !Array.isArray(arg) && !(arg instanceof Error)) {
          obj = { ...obj, ...(arg as Record<string, unknown>) };
        } else if (arg instanceof Error) {
          obj.err = { message: arg.message, stack: arg.stack, name: arg.name };
          msgParts.push(arg.message);
        } else {
          msgParts.push(String(arg));
        }
      }

      if (scopes.length > 0) obj.scopes = scopes;
      const msg = msgParts.join(" ");
      broadcast(lvl, [`[${scope}]`, msg]);
      method(obj, msg);
    };
  }

  const child: Logger = {
    fatal: wrap(pinoChild.fatal.bind(pinoChild), "fatal"),
    error: wrap(pinoChild.error.bind(pinoChild), "error"),
    warn: wrap(pinoChild.warn.bind(pinoChild), "warn"),
    info: wrap(pinoChild.info.bind(pinoChild), "info"),
    debug: wrap(pinoChild.debug.bind(pinoChild), "debug"),
    trace: wrap(pinoChild.trace.bind(pinoChild), "trace"),
    child(innerScope: string): Logger {
      return createPinoChild(pinoChild.child({ scope: innerScope }), innerScope);
    },
  };

  return child;
}
