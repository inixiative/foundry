/**
 * @atlas
 * @kind entrypoint
 * @partOf feature:daemon
 */
/**
 * Waiting out a hold (`packages/foundry/src/daemon/boot-record.ts`): the supervisor keeps its status
 * page up and boots nothing until there is a reason to. A daemon the owner stopped waits for Start
 * alone. One held on failing boots also tries again when the settings it read change, when a new
 * release is staged (either is a different boot from the ones that failed), and by itself after a
 * backoff, so a failure that clears on its own (a service still starting at login) still recovers.
 */
import {
  type Hold,
  retryDelayMs,
  settingsHash,
} from '../../packages/foundry/src/daemon/boot-record';
import type { UpdateResult } from './update';

export type HoldRelease = 'started' | 'settings-changed' | 'update-staged' | 'retry-due';

export interface WaitWhileHeldOptions {
  configDir: string;
  hold: Hold;
  /** Resolves when the owner presses Start on the status page. */
  started: Promise<void>;
  /** Stages a newly built release; omitted when update checks are off, so none are made. */
  stageUpdate?: () => Promise<UpdateResult>;
  /** How often to look for a new release (the daemon's update check interval). */
  updateCheckMs: number;
  settingsPollMs?: number;
  /** Default: the backoff for the hold's failures (`retryDelayMs`). */
  retryAfterMs?: number;
}

export const waitWhileHeld = async (options: WaitWhileHeldOptions): Promise<HoldRelease> => {
  const { hold } = options;
  if (hold.reason === 'stopped') {
    await options.started;
    return 'started';
  }
  let wake: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    wake = resolve;
  });
  let over = false;
  /** Sleeps `ms`, or less when the wait is over. */
  const nap = (ms: number) => Promise.race([Bun.sleep(Math.max(ms, 1_000)), done]);
  const loops: Promise<HoldRelease | undefined>[] = [
    (async () => {
      while (!over) {
        await nap(options.settingsPollMs ?? 5_000);
        if (!over && settingsHash(options.configDir) !== hold.settingsHash)
          return 'settings-changed';
      }
      return undefined;
    })(),
    (async () => {
      await nap(options.retryAfterMs ?? retryDelayMs(hold.failures));
      return over ? undefined : 'retry-due';
    })(),
  ];
  const { stageUpdate } = options;
  if (stageUpdate)
    loops.push(
      (async () => {
        while (!over) {
          if ((await stageUpdate()).action === 'staged') return 'update-staged';
          await nap(options.updateCheckMs);
        }
        return undefined;
      })(),
    );
  const first = await Promise.race([
    options.started.then((): HoldRelease => 'started'),
    ...loops.map((loop) => loop.then((released) => released ?? new Promise<never>(() => {}))),
  ]);
  over = true;
  wake();
  // A release build in flight finishes before the supervisor stages again: two builds of one
  // release share a staging directory.
  await Promise.all(loops);
  return first;
};
