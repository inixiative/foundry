/**
 * @atlas
 * @kind route
 * @partOf feature:viewer
 */
import type { Hono } from 'hono';
import type { Keychain } from '../../secrets/keychain';
import {
  type ConfigStore,
  DEV_TOKEN_KEY_DEFAULT,
  type DevRemoteSettings,
  devHostSetting,
  devModeAnywhere,
  devModeOn,
} from '../config';

const PROBE_TIMEOUT_MS = 3_000;

/** One dev-mode host's probe: whether its health route answered, and whether its token entry is held. */
async function probe(
  remote: Required<DevRemoteSettings> | undefined,
  path: string,
  keychain: Keychain,
) {
  if (!remote) return null;
  const url = `${remote.url}${path}`;
  const { tokenKey } = remote;
  // Foundry reads the token as itself, so only an entry it may read (or the variable) is held.
  const tokenHeld =
    keychain.entry(tokenKey)?.holder === 'foundry' || Boolean(process.env[tokenKey]);
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    const detail = (await res.text()).slice(0, 500);
    return { url, ok: res.ok, status: res.status, detail, tokenKey, tokenHeld };
  } catch (error) {
    return { url, ok: false, status: 0, detail: (error as Error).message, tokenKey, tokenHeld };
  }
}

/**
 * Settings → Dev: probe dev mode's Chorus (`/readyz`) and Oracle (`/healthz`) hosts while dev mode
 * is on anywhere: on this machine, or for one project (`projects[id].__devMode`).
 */
export function registerDevRoutes(app: Hono, configStore: ConfigStore, keychain: Keychain) {
  app.get('/api/dev/probe', async (c) => {
    const config = await configStore.load();
    const defaultTokenKey = DEV_TOKEN_KEY_DEFAULT;
    const devMode = config.__devMode === true;
    const projects = Object.entries(config.projects ?? {})
      .filter(([id]) => devModeOn(config, id))
      .map(([id]) => id);
    if (!devModeAnywhere(config))
      return c.json({ devMode, projects, defaultTokenKey, chorus: null, oracle: null });
    const [chorus, oracle] = await Promise.all([
      probe(devHostSetting(config, '__chorus'), '/readyz', keychain),
      probe(devHostSetting(config, '__oracle'), '/healthz', keychain),
    ]);
    return c.json({ devMode, projects, defaultTokenKey, chorus, oracle });
  });
}
