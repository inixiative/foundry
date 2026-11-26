/**
 * @atlas
 * @kind route
 * @partOf feature:viewer
 */
import type { Hono } from 'hono';
import type { Keychain } from '../../secrets/keychain';
import { type ConfigStore, DEV_TOKEN_KEY_DEFAULT, type DevRemoteSettings } from '../config';

const PROBE_TIMEOUT_MS = 3_000;

/** One dev-mode host's probe: whether its health route answered, and whether its token entry is held. */
async function probe(remote: DevRemoteSettings | undefined, path: string, keychain: Keychain) {
  if (!remote) return null;
  const url = `${remote.url.replace(/\/+$/, '')}${path}`;
  const tokenKey = remote.tokenKey ?? DEV_TOKEN_KEY_DEFAULT;
  const tokenHeld =
    keychain.list().some((entry) => entry.name === tokenKey) || Boolean(process.env[tokenKey]);
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    const detail = (await res.text()).slice(0, 500);
    return { url, ok: res.ok, status: res.status, detail, tokenKey, tokenHeld };
  } catch (error) {
    return { url, ok: false, status: 0, detail: (error as Error).message, tokenKey, tokenHeld };
  }
}

/** Settings → Dev: probe dev mode's Chorus (`/readyz`) and Oracle (`/healthz`) hosts. */
export function registerDevRoutes(app: Hono, configStore: ConfigStore, keychain: Keychain) {
  app.get('/api/dev/probe', async (c) => {
    const config = await configStore.load();
    const [chorus, oracle] = await Promise.all([
      probe(config.__chorus, '/readyz', keychain),
      probe(config.__oracle, '/healthz', keychain),
    ]);
    return c.json({ devMode: config.__devMode === true, chorus, oracle });
  });
}
