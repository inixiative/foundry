/**
 * @atlas
 * @kind component
 * @partOf feature:viewer
 */
/**
 * The Watchtower's Watching sidebar: what this map covers. Kingdoms are the paired ones
 * (`/api/kingdom/status`), projects the registered ones, connectors the Kingdom access grants
 * (`/api/access/sources`, Manage opens Settings), people and machines this machine and its icon.
 * Choosing what to watch per Kingdom isn't built, and teammates and their machines arrive through
 * Kingdom with the Heralds.
 */

import { html, useEffect, useState } from './lib.js';
import { DeviceIcon, machineIcon } from './machine-icons.js';
import { navigate, settingsPath } from './route.js';
import { authFetch, projects } from './store.js';

function useJson(url) {
  const [value, setValue] = useState(undefined);
  useEffect(() => {
    let live = true;
    authFetch(url)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)
      .then((body) => live && setValue(body));
    return () => {
      live = false;
    };
  }, [url]);
  return value;
}

const host = (url) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

export function WatchingSidebar({ machine }) {
  const kingdom = useJson('/api/kingdom/status');
  const access = useJson('/api/access/sources');
  const kingdoms = kingdom?.integrations ?? [];
  const connectors = access?.sources ?? [];
  const live = projects.value.filter((p) => p.status !== 'archived');
  const archived = projects.value.filter((p) => p.status === 'archived');

  return html`<aside class="watching" aria-label="Watching">
    <h4>Watching</h4>
    <section class="ws" aria-label="Kingdoms">
      <b>Kingdoms</b>
      ${
        kingdom === undefined
          ? html`<small>Reading…</small>`
          : kingdoms.length
            ? kingdoms.map(
                (k) => html`<div key=${k.id} class="wrow">
                  <span class="kd">${(k.owner || '?').slice(0, 1).toUpperCase()}</span>
                  <span>${k.owner}<small>${host(k.url)} · ${k.status}</small></span>
                  <button type="button" disabled title="Choosing what to watch in a Kingdom isn't built yet">Edit</button>
                </div>`,
              )
            : html`<small>No Kingdom paired. Connect one from the top bar.</small>`
      }
    </section>
    <section class="ws" aria-label="Projects">
      <b>Projects</b>
      <div class="wtags">
        ${live.map((p) => html`<span key=${p.id}>${p.label}</span>`)}
        ${archived.map((p) => html`<span key=${p.id} class="mut" title="Archived">${p.label}</span>`)}
      </div>
      <small>Watching = on this map. Listening (Heralds telling you about overlaps) isn't built.</small>
    </section>
    <section class="ws" aria-label="Connectors">
      <b>Connectors</b>
      ${
        access === undefined
          ? html`<small>Reading…</small>`
          : connectors.length
            ? connectors.map(
                (c) => html`<div key=${c.id} class="wrow">
                  <span class="kd">${c.name.slice(0, 1).toUpperCase()}</span>
                  <span>${c.name}<small>${c.projectIds.length} project${c.projectIds.length === 1 ? '' : 's'}${c.credentialStatus === 'unavailable' ? ' · credential unavailable' : ''}</small></span>
                  <button type="button" onClick=${() => navigate(settingsPath(null, 'integrations'))}>Manage</button>
                </div>`,
              )
            : html`<div class="wrow"><span class="kd">+</span><span>None yet<small>Linear, GitHub and Slack come through Kingdom grants</small></span>
                <button type="button" onClick=${() => navigate(settingsPath(null, 'integrations'))}>Manage</button></div>`
      }
    </section>
    <section class="ws" aria-label="People and their machines">
      <b>People and their machines</b>
      <div class="wperson">
        <div class="wp1"><span class="pva">You</span><span>You</span></div>
        <div class="wdev"><${DeviceIcon} icon=${machineIcon()} size=${16} /><span>${machine}</span><small>this machine · active</small></div>
      </div>
      <small>Teammates and your other machines arrive through Kingdom with the Heralds (not built).</small>
    </section>
  </aside>`;
}
