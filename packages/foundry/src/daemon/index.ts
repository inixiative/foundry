import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigStore, starterConfig } from '../viewer/config';

export { installedConfigDirectory, installedDaemon } from '../client/daemon';
export { readHold } from './boot-record';
export { daemonLoaded, installDaemon } from './install';
export { DAEMON_LOG_DIR } from './plist';

/** An installed Foundry's home gets the starter settings a first start would write. */
export async function ensureStarterSettings(home: string): Promise<boolean> {
  const directory = join(home, '.foundry');
  if (existsSync(join(directory, 'settings.json'))) return false;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  await new ConfigStore(directory).save(starterConfig('claude-code', 'fable'));
  return true;
}
