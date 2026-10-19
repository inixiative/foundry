/**
 * @atlas
 * @kind utils
 * @partOf feature:viewer
 */
/**
 * Dev mode: a per-viewer switch at the bottom of Settings that reveals dev-only fields (a custom
 * Kingdom URL, a provider's API root). Remembered in this browser only; it changes no setting.
 */

import { signal } from './lib.js';

const KEY = 'foundry.settings.devMode';

const read = () => {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
};

export const devMode = signal(read());

export function setDevMode(on) {
  devMode.value = on;
  try {
    if (on) localStorage.setItem(KEY, '1');
    else localStorage.removeItem(KEY);
  } catch {
    /* Storage blocked: the switch still works for this page. */
  }
}
