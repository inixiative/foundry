/**
 * @atlas
 * @kind entrypoint
 * @partOf feature:daemon
 */
/**
 * Periodic update check for a daemon that is already running.
 *
 * The supervisor only stages updates at startup, so a daemon left running for
 * days never sees main move. This stages the candidate while running, then
 * exits 75 so launchd relaunches onto it. It drains first: it restarts only
 * once no turn is queued or running, because a restart mid-turn loses track of
 * the native session's work (Aron, 2026-11-02). Past the drain timeout it
 * restarts anyway, and the next boot settles each lost turn from the native
 * session's own record (`turns/native-outcome-recovery.ts`).
 */

import { RESTART_EXIT_CODE, readState, stageUpdate } from './update';

export interface WatchOptions {
  repoRoot: string;
  configDir: string;
  intervalMs: number;
  /** Turns queued or running in this process; undefined until the daemon has booted. */
  liveTurns?: () => number | undefined;
  /** How long to wait for running turns before restarting anyway (default 60 minutes). */
  drainTimeoutMs?: number;
  /** How often to look again while draining. */
  drainPollMs?: number;
  /** Told how long the runtime expects to be gone, so presence reads "restarting" rather than "offline". */
  closeForUpdate?: (expectedBackWithinMs: number) => Promise<void> | void;
  exit?: (code: number) => void;
  log?: (message: string) => void;
}

/** The candidate is built before the restart, so this covers launchd's ThrottleInterval and the boot. */
const EXPECTED_BACK_WITHIN_MS = 60_000;
export const DEFAULT_DRAIN_TIMEOUT_MS = 60 * 60_000;

/** Resolves when no turn is live, or `false` once the timeout passes first. */
export const drain = async (
  liveTurns: (() => number | undefined) | undefined,
  timeoutMs: number,
  pollMs: number,
  log: (message: string) => void,
): Promise<boolean> => {
  const started = Date.now();
  let said = -1;
  for (;;) {
    const live = liveTurns?.() ?? 0;
    if (live === 0) return true;
    if (Date.now() - started >= timeoutMs) return false;
    if (live !== said) log(`waiting for ${live} running turn(s) to finish before restarting`);
    said = live;
    await Bun.sleep(pollMs);
  }
};

export const startUpdateWatcher = (options: WatchOptions): (() => void) => {
  const log = options.log ?? (() => {});
  const exit = options.exit ?? ((code: number) => process.exit(code));
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

      const drained = await drain(
        options.liveTurns,
        options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS,
        options.drainPollMs ?? 5_000,
        log,
      );
      if (!drained)
        log(
          `turns still running after the drain timeout; restarting anyway (each is settled from its native record on boot)`,
        );
      log(`restarting onto candidate ${candidate.slice(0, 8)}`);
      try {
        await options.closeForUpdate?.(EXPECTED_BACK_WITHIN_MS);
      } catch (error) {
        log(`close-for-update failed, restarting anyway — ${String(error)}`);
      }
      exit(RESTART_EXIT_CODE);
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
