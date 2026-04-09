import { AsyncLocalStorage } from "node:async_hooks";

// ---------------------------------------------------------------------------
// Scopes — async-context-aware log scoping
// ---------------------------------------------------------------------------

/**
 * Common log scopes used across Foundry.
 * Use these for consistency, or pass custom strings.
 */
export enum LogScope {
  harness = "harness",
  thread = "thread",
  agent = "agent",
  provider = "provider",
  viewer = "viewer",
  tunnel = "tunnel",
  eval = "eval",
  signal = "signal",
  memory = "memory",
  analytics = "analytics",
  db = "db",
  lifecycle = "lifecycle",
  herald = "herald",
  corpus = "corpus",
}

const scopeStore = new AsyncLocalStorage<string[]>();
const broadcastStore = new AsyncLocalStorage<LogBroadcastFn[]>();

/** Get current scope stack (internal). */
export const getLogScopes = (): string[] => scopeStore.getStore() ?? [];

// ---------------------------------------------------------------------------
// Broadcasting — route logs to multiple targets
// ---------------------------------------------------------------------------

export type LogBroadcastFn = (level: string, message: string) => void;

/** Get current broadcast targets (internal). */
export const getLogBroadcasts = (): LogBroadcastFn[] =>
  broadcastStore.getStore() ?? [];

/**
 * Run `fn` within a named log scope. All log calls inside will include
 * this scope tag. Scopes nest — inner scopes appear after outer ones.
 *
 * @example
 * logScope(LogScope.harness, () => {
 *   log.info("dispatching");  // [harness] dispatching
 * });
 */
export function logScope<T>(id: string | LogScope, fn: () => T): T {
  const current = scopeStore.getStore() ?? [];
  const broadcasts = broadcastStore.getStore();
  const run = () => scopeStore.run([...current, id], fn);
  return broadcasts ? run() : broadcastStore.run([], run);
}

/**
 * Register a broadcast target in the current async scope.
 * All log calls in this context also go to this target.
 *
 * @example
 * logScope(LogScope.eval, async () => {
 *   addLogBroadcast((_level, msg) => runLog.push(msg));
 *   log.info("scoring fixture");  // goes to stdout AND runLog
 * });
 */
export function addLogBroadcast(target: LogBroadcastFn): void {
  const broadcasts = broadcastStore.getStore();
  if (broadcasts) broadcasts.push(target);
}

// ---------------------------------------------------------------------------
// Log levels
// ---------------------------------------------------------------------------

export type LogLevel =
  | "silent"
  | "fatal"
  | "error"
  | "warn"
  | "info"
  | "debug"
  | "trace";

export const LOG_LEVEL_VALUES: Record<LogLevel, number> = {
  silent: 0,
  fatal: 1,
  error: 2,
  warn: 3,
  info: 4,
  debug: 5,
  trace: 6,
};

// ---------------------------------------------------------------------------
// Logger interface — what adapters must implement
// ---------------------------------------------------------------------------

/**
 * Minimal logger interface. Both consola and pino adapters implement this.
 * Methods follow the standard log-level convention.
 */
export interface Logger {
  fatal(...args: unknown[]): void;
  error(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  info(...args: unknown[]): void;
  debug(...args: unknown[]): void;
  trace(...args: unknown[]): void;

  /** Print a boxed/highlighted message (for startup banners). Falls back to info. */
  box?(message: string): void;

  /** Create a child logger with a fixed tag/scope prefix. */
  child(scope: string): Logger;
}

/**
 * Config shared by all adapters.
 */
export interface LoggerConfig {
  /** Minimum log level. Default: read from LOG_LEVEL env, or "info". */
  level?: LogLevel;
  /** Whether to include timestamps. Default: true. */
  timestamps?: boolean;
}
