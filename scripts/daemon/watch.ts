/**
 * @atlas
 * @kind entrypoint
 * @partOf feature:daemon
 */
/**
 * Periodic update check for a daemon that is already running.
 *
 * The supervisor only stages updates at startup, so a daemon left running for
 * days never sees main move. This stages the candidate while running and offers
 * it to the daemon, which spins down (Aron, 2026-11-02: "finish all open
 * threads… once the last one finishes, restart, then reopen"): running turns
 * finish, new ones wait, and it calls back to restart when the last running turn
 * finishes or the backstop timeout passes (packages/foundry/src/daemon/restart-roll.ts).
 * Restarting is exiting 75 so launchd relaunches onto the candidate. A daemon
 * that can't spin down (an older release) is drained on its live turns instead.
 */

import {
  type DaemonRuntimeHook,
  daemonRuntime,
} from '../../packages/foundry/src/daemon/runtime-hook';
import { RESTART_EXIT_CODE, readState, stageUpdate } from './update';

export interface WatchOptions {
  repoRoot: string;
  configDir: string;
  intervalMs: number;
  /** The booted daemon's hook (default: the one it published in this process). */
  runtime?: () => DaemonRuntimeHook | undefined;
  /** Backstop: restart anyway after running turns have had this long (default 60 minutes). */
  drainTimeoutMs?: number;
  /** How often to look again while draining a daemon that can't spin down. */
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
  const runtime = options.runtime ?? daemonRuntime;
  const timeoutMs = options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
  let checking = false;
  let offered: string | undefined;
  let restarting = false;

  const restart = async (candidate: string) => {
    if (restarting) return;
    restarting = true;
    log(`restarting onto candidate ${candidate.slice(0, 8)}`);
    try {
      await options.closeForUpdate?.(EXPECTED_BACK_WITHIN_MS);
    } catch (error) {
      log(`close-for-update failed, restarting anyway — ${String(error)}`);
    }
    exit(RESTART_EXIT_CODE);
  };

  const tick = async () => {
    if (checking || restarting) return;
    checking = true;
    try {
      const result = await stageUpdate(options.repoRoot, options.configDir);
      if (result.action === 'failed') log(`update skipped — ${result.detail}`);
      if (result.action === 'staged')
        log(`staged origin/main ${result.target?.slice(0, 8)} as the candidate`);
      const { candidate } = await readState(options.configDir);
      if (!candidate) return;

      const hook = runtime();
      if (hook?.offerUpdate) {
        // Offered once per candidate: the daemon spins down, or keeps it postponed ("Not now").
        if (offered === candidate) return;
        offered = candidate;
        log(
          `offering ${candidate.slice(0, 8)} to the daemon: it restarts once running turns finish`,
        );
        hook.offerUpdate({ candidate, timeoutMs, restart: () => void restart(candidate) });
        return;
      }
      const drained = await drain(
        () => hook?.liveTurns(),
        timeoutMs,
        options.drainPollMs ?? 5_000,
        log,
      );
      if (!drained)
        log(
          'turns still running after the drain timeout; restarting anyway (each is settled from its native record on boot)',
        );
      await restart(candidate);
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
