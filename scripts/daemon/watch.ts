/**
 * Periodic update check for a daemon that is already running.
 *
 * The supervisor only updates at startup, so a daemon left running for days
 * never sees main move. This watches for that, and restarts the same way the
 * supervisor does: exit 75, let launchd relaunch into the new code.
 */
import { applyUpdate, readAutoUpdate, RESTART_EXIT_CODE } from "./update";
import { runtimeJobsInFlight } from "./idle";

export interface WatchOptions {
  repoRoot: string;
  intervalMs: number;
  /** Holds the runtime-jobs directory; absent when this Foundry is not enrolled. */
  runtimeDirectory?: string;
  /** Told how long the runtime expects to be gone, so presence reads "restarting" rather than "offline". */
  closeForUpdate?: (expectedBackWithinMs: number) => Promise<void> | void;
  log?: (message: string) => void;
}

/**
 * launchd's ThrottleInterval is the floor; dependency installs dominate the rest.
 */
const EXPECTED_BACK_WITHIN_MS = 60_000;

export const startUpdateWatcher = (options: WatchOptions): (() => void) => {
  const log = options.log ?? (() => {});
  let checking = false;

  const tick = async () => {
    if (checking) return;
    checking = true;
    try {
      if ((await readAutoUpdate(options.repoRoot)) !== "apply") return;
      if (await runtimeJobsInFlight(options.runtimeDirectory)) return;

      const result = await applyUpdate(options.repoRoot);
      if (result.action !== "applied") {
        if (result.action === "failed") log(`update skipped — ${result.detail}`);
        return;
      }

      log(`pulled ${result.behind} commit(s) from origin/main; restarting`);
      try {
        await options.closeForUpdate?.(EXPECTED_BACK_WITHIN_MS);
      } catch (error) {
        log(`close-for-update failed, restarting anyway — ${String(error)}`);
      }
      process.exit(RESTART_EXIT_CODE);
    } catch (error) {
      log(`update check failed — ${String(error)}`);
    } finally {
      checking = false;
    }
  };

  const timer = setInterval(tick, options.intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
};
