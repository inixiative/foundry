// ---------------------------------------------------------------------------
// Logger — pluggable logging with consola (dev) and pino (production) adapters
// ---------------------------------------------------------------------------
//
// Usage:
//   import { log } from "../logger";
//   log.info("something happened");
//
// With scopes (async-context-aware):
//   import { log, logScope, LogScope } from "../logger";
//   await logScope(LogScope.harness, async () => {
//     log.info("dispatching");  // [2026-04-06T...] [harness] dispatching
//   });
//
// Switch to pino for production:
//   import { initLogger } from "../logger";
//   await initLogger("pino");
// ---------------------------------------------------------------------------

import type { Logger, LoggerConfig } from "./scope";

export {
  type Logger,
  type LoggerConfig,
  type LogLevel,
  type LogBroadcastFn,
  LogScope,
  logScope,
  addLogBroadcast,
} from "./scope";

export { createConsolaLogger } from "./consola";
export { createPinoLogger } from "./pino";

// ---------------------------------------------------------------------------
// Default logger — synchronous fallback until an adapter is initialized
// ---------------------------------------------------------------------------

function makePrefix(): string {
  // Lightweight prefix without scope (scope needs the async imports)
  return `[${new Date().toISOString()}]`;
}

const fallbackLogger: Logger = {
  fatal: (...args) => console.error(makePrefix(), "[FATAL]", ...args),
  error: (...args) => console.error(makePrefix(), "[ERROR]", ...args),
  warn: (...args) => console.warn(makePrefix(), "[WARN]", ...args),
  info: (...args) => console.info(makePrefix(), "[INFO]", ...args),
  debug: (...args) => console.debug(makePrefix(), "[DEBUG]", ...args),
  trace: (...args) => console.debug(makePrefix(), "[TRACE]", ...args),
  box: (msg) => console.info(`\n${"─".repeat(40)}\n${msg}\n${"─".repeat(40)}\n`),
  child(scope: string): Logger {
    return {
      fatal: (...args) => fallbackLogger.fatal(`[${scope}]`, ...args),
      error: (...args) => fallbackLogger.error(`[${scope}]`, ...args),
      warn: (...args) => fallbackLogger.warn(`[${scope}]`, ...args),
      info: (...args) => fallbackLogger.info(`[${scope}]`, ...args),
      debug: (...args) => fallbackLogger.debug(`[${scope}]`, ...args),
      trace: (...args) => fallbackLogger.trace(`[${scope}]`, ...args),
      child: (inner) => fallbackLogger.child(`${scope}:${inner}`),
    };
  },
};

// ---------------------------------------------------------------------------
// Singleton — mutable reference swapped by initLogger()
// ---------------------------------------------------------------------------

let _logger: Logger = fallbackLogger;

/**
 * The global logger instance. Starts as a console fallback, then upgrades
 * to consola or pino when `initLogger()` is called.
 *
 * Uses a Proxy so existing references stay valid after init.
 */
export const log: Logger = new Proxy({} as Logger, {
  get(_target, prop) {
    return (_logger as any)[prop];
  },
});

/**
 * Initialize the logger with a specific adapter.
 * Call once at startup. All existing references to `log` upgrade automatically.
 *
 * @param adapter - "consola" (default, colorful dev output) or "pino" (structured JSON)
 * @param config  - Optional level/timestamp config
 */
export async function initLogger(
  adapter: "consola" | "pino" = "consola",
  config?: LoggerConfig,
): Promise<Logger> {
  if (adapter === "pino") {
    const { createPinoLogger } = await import("./pino");
    _logger = await createPinoLogger(config);
  } else {
    const { createConsolaLogger } = await import("./consola");
    _logger = await createConsolaLogger(config);
  }
  return _logger;
}
