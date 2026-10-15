import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { type PrefilterSettings, resolvePrefilterSettings } from '../providers/warden-prefilter';
import { ConfigStore, starterConfig } from '../viewer/config';

export {
  installPrefilterModel,
  prefilterInstalled,
} from '../providers/prefilter-model';
export { WardenPrefilter } from '../providers/warden-prefilter';
export { DAEMON_LOG_DIR, daemonLoaded, installDaemon, installedDaemon } from './install';

/** An installed Foundry's home gets the starter settings a first start would write. */
export async function ensureStarterSettings(home: string): Promise<boolean> {
  const directory = join(home, '.foundry');
  if (existsSync(join(directory, 'settings.json'))) return false;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  await new ConfigStore(directory).save(starterConfig('claude-code', 'fable'));
  return true;
}

/** A Foundry home's Warden pre-filter settings when they turn it on; undefined when off (the default). */
export async function enabledPrefilter(home: string): Promise<PrefilterSettings | undefined> {
  const directory = join(home, '.foundry');
  if (!existsSync(join(directory, 'settings.json'))) return undefined;
  const { prefilter } = await new ConfigStore(directory).load();
  return resolvePrefilterSettings(prefilter).enabled ? prefilter : undefined;
}
