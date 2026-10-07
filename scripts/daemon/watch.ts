/**
 * Periodic update check for a daemon that is already running.
 *
 * The supervisor only stages updates at startup, so a daemon left running for
 * days never sees main move. This stages the candidate while running, then
 * exits 75 so launchd relaunches onto it.
 */

import { RESTART_EXIT_CODE, readState, stageUpdate } from './update';

export interface WatchOptions {
  repoRoot: string;
  configDir: string;
  intervalMs: number;
  /** Told how long the runtime expects to be gone, so presence reads "restarting" rather than "offline". */
  closeForUpdate?: (expectedBackWithinMs: number) => Promise<void> | void;
  log?: (message: string) => void;
}

/** The candidate is built before the restart, so this covers launchd's ThrottleInterval and the boot. */
const EXPECTED_BACK_WITHIN_MS = 60_000;

export const startUpdateWatcher = (options: WatchOptions): (() => void) => {
  const log = options.log ?? (() => {});
  let checking = false;

  const tick = async () => {
    if (checking) return;
    checking = true;
    try {
      const result = await stageUpdate(options.repoRoot, options.configDir);
      if (result.action === 'failed') log(`update skipped — ${result.detail}`);
      if (result.action === 'staged')
        log(`staged origin/main ${result.target?.slice(0, 8)} as the candidate`);
      const { candidate } = await readState(options.configDir);
      if (!candidate) return;

      log(`restarting onto candidate ${candidate.slice(0, 8)}`);
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
