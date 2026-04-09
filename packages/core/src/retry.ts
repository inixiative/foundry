import type { Middleware, DispatchContext, MiddlewareNext } from "./middleware";
import { CapabilityDeniedError } from "./capability";
import { BudgetExceededError } from "./token-tracker";

export interface RetryConfig {
  /** Maximum retry attempts. Default: 3. */
  maxRetries?: number;
  /** Initial delay in ms before first retry. Default: 1000. */
  initialDelayMs?: number;
  /** Maximum delay cap in ms. Default: 30_000. */
  maxDelayMs?: number;
  /** Backoff multiplier. Default: 2. */
  backoffFactor?: number;
  /** Add jitter to prevent thundering herd. Default: true. */
  jitter?: boolean;
  /** Give-up threshold in ms (total elapsed). Default: 120_000. */
  giveUpAfterMs?: number;
  /** Predicate: which errors should be retried. Default: all except denied/budget. */
  isRetryable?: (error: unknown) => boolean;
  /** Called on each retry attempt (for logging/observability). */
  onRetry?: (attempt: number, error: unknown, delayMs: number) => void;
}

function defaultIsRetryable(error: unknown): boolean {
  if (error instanceof CapabilityDeniedError) return false;
  if (error instanceof BudgetExceededError) return false;
  return true;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Creates a middleware that wraps dispatch with exponential backoff retry.
 *
 * Composable: register globally or per-agent via `middleware.useWhen()`.
 */
export function retryMiddleware(config: RetryConfig = {}): Middleware {
  const {
    maxRetries = 3,
    initialDelayMs = 1000,
    maxDelayMs = 30_000,
    backoffFactor = 2,
    jitter = true,
    giveUpAfterMs = 120_000,
    isRetryable = defaultIsRetryable,
    onRetry,
  } = config;

  return async (ctx: DispatchContext, next: MiddlewareNext) => {
    const startTime = Date.now();
    let lastError: unknown;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await next();
      } catch (error) {
        lastError = error;

        if (attempt >= maxRetries) break;
        if (!isRetryable(error)) break;

        const elapsed = Date.now() - startTime;
        if (elapsed >= giveUpAfterMs) break;

        let delay = initialDelayMs * Math.pow(backoffFactor, attempt);
        delay = Math.min(delay, maxDelayMs);

        if (jitter) {
          // Randomize between 50% and 100% of computed delay
          delay = delay * (0.5 + Math.random() * 0.5);
        }

        // Don't exceed give-up threshold
        const remaining = giveUpAfterMs - elapsed;
        if (delay > remaining) {
          delay = Math.max(0, remaining);
        }

        onRetry?.(attempt + 1, error, delay);
        ctx.annotations["retry:attempt"] = attempt + 1;
        ctx.annotations["retry:lastError"] = String(error);

        await sleep(delay);
      }
    }

    throw lastError;
  };
}
