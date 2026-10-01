/**
 * Boot safety for settings. The settings a boot succeeded on are kept as
 * last-good. When a boot fails on settings that differ from them, the failed
 * file is set aside (never deleted) and last-good restored, so the relaunch
 * runs instead of crash-looping on the same file.
 */
import { copyFile, rename } from 'node:fs/promises';
import { join } from 'node:path';

const settingsPath = (dir: string) => join(dir, 'settings.json');
const lastGoodPath = (dir: string) => join(dir, 'settings.last-good.json');

export const recordBooted = async (dir: string): Promise<void> => {
  if (await Bun.file(settingsPath(dir)).exists())
    await copyFile(settingsPath(dir), lastGoodPath(dir));
};

/** Returns where the failed settings were set aside, or undefined when there was nothing to restore. */
export const restoreAfterFailedBoot = async (
  dir: string,
  now = Date.now(),
): Promise<string | undefined> => {
  const settings = Bun.file(settingsPath(dir));
  const lastGood = Bun.file(lastGoodPath(dir));
  if (!(await settings.exists()) || !(await lastGood.exists())) return undefined;
  if ((await settings.text()) === (await lastGood.text())) return undefined;
  const rejected = join(dir, `settings.rejected-${now}.json`);
  await rename(settingsPath(dir), rejected);
  await copyFile(lastGoodPath(dir), settingsPath(dir));
  return rejected;
};
