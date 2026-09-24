// Copied from the template's apps/api/src/lib/utils/makeUnrefInterval.ts.
// A background ticker that never keeps the process alive: start once, stop cleanly.

export type UnrefInterval = {
  /** Idempotent — a second call while running is a no-op, so two tickers can't stack. */
  start: () => void;
  stop: () => void;
};

export const makeUnrefInterval = ({ intervalMs, tick }: { intervalMs: number; tick: () => void }): UnrefInterval => {
  let timer: ReturnType<typeof setInterval> | null = null;
  return {
    start: () => {
      if (timer) return;
      timer = setInterval(tick, intervalMs);
      timer.unref?.();
    },
    stop: () => {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    },
  };
};
