/**
 * @atlas
 * @kind utils
 * @partOf feature:viewer
 */
/**
 * Dev mode: the `__devMode` setting (R-2026-11-25-05). On, it reveals dev-only fields (a custom
 * Kingdom URL, a provider's API root) and the Dev section, where a local Chorus host serves the
 * Wardens. Anyone may turn it on; it is this machine's, never a repository's.
 */

import { signal } from './lib.js';
import { authFetch, showToast } from './store.js';

export const devMode = signal(false);

authFetch('/api/settings')
  .then((res) => (res.ok ? res.json() : null))
  .then((config) => {
    if (config) devMode.value = config.__devMode === true;
  })
  .catch(() => {});

/** Turn dev mode on or off; resolves to the saved settings, or null when the save was refused. */
export async function setDevMode(on) {
  const before = devMode.value;
  devMode.value = on;
  try {
    const res = await authFetch('/api/settings/dev', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ __devMode: on }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw Error(body.error || 'Dev mode was not saved');
    return body;
  } catch (error) {
    devMode.value = before;
    showToast(error.message, 'error');
    return null;
  }
}
