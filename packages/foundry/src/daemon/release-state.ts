/**
 * @atlas
 * @kind service
 * @partOf feature:daemon
 */
/**
 * The daemon's release state as files under `<config>/releases`: which release is stable, which is a
 * candidate on trial, which failed. Written by the supervisor's update machinery
 * (`scripts/daemon/update.ts`); read there, by the update watcher and by the status page.
 */
import { join } from 'node:path';

export type AutoUpdate = 'off' | 'check' | 'apply';

export interface ReleaseState {
  stable?: string;
  previous?: string;
  candidate?: string;
  /** Set while a candidate boots; still set on the next launch means that boot was cut off. */
  booting?: string;
  /** Boots of `booting` cut off before a verdict, so far. */
  interruptedBoots?: number;
  failed: string[];
}

export const releasesRoot = (configDir: string) => join(configDir, 'releases');
export const statePath = (configDir: string) => join(releasesRoot(configDir), 'state.json');

export const readAutoUpdate = async (configDir: string): Promise<AutoUpdate> => {
  try {
    const value = (await Bun.file(join(configDir, 'settings.json')).json())?.daemon?.autoUpdate;
    return value === 'check' || value === 'apply' ? value : 'off';
  } catch {
    return 'off';
  }
};

export const readState = async (configDir: string): Promise<ReleaseState> => {
  try {
    return { failed: [], ...(await Bun.file(statePath(configDir)).json()) };
  } catch {
    return { failed: [] };
  }
};
