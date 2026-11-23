/**
 * @atlas
 * @kind component
 * @partOf feature:devices, feature:viewer
 */
/**
 * Settings → Devices: this machine and its peers. Peers are other Foundries your Kingdom knows; this
 * Foundry opens from another machine through Kingdom (Settings → Kingdom).
 */

import { ComingSoon } from './coming-soon.js';
import { html, useEffect, useState } from './lib.js';
import { onLink, settingsPath } from './route.js';
import { authFetch } from './store.js';

export function LocalDevicePanel({ projectIds }) {
  const [inventory, setInventory] = useState(null);
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const refresh = async () => {
    const response = await authFetch('/api/devices');
    if (!response.ok) throw Error('Device inventory is unavailable');
    setInventory(await response.json());
    setError('');
  };
  useEffect(() => {
    refresh().catch(() => setError('Device inventory is unavailable'));
  }, [projectIds]);
  const enroll = async (event) => {
    event.preventDefault();
    setBusy(true);
    try {
      const response = await authFetch('/api/devices/local', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!response.ok) throw Error();
      await refresh();
    } catch {
      setError('Device enrollment could not be completed');
    } finally {
      setBusy(false);
    }
  };
  return html`<div class="device-inventory">
    ${error ? html`<div role="alert">${error}</div>` : null}
    ${
      inventory?.device
        ? html`
      <h3>${inventory.device.name} · this machine</h3>
      <p class="settings-desc">Where each project is checked out here.</p>
      <dl class="access-details">${inventory.checkouts.map(
        (checkout) =>
          html`<dt key=${`${checkout.id}-label`}>${checkout.label}</dt><dd key=${checkout.id}><code>${checkout.path}</code></dd>`,
      )}</dl>
    `
        : inventory
          ? html`<form onSubmit=${enroll}>
      <label>Device name<input class="proj-input" value=${name} maxLength="120" required
        onInput=${(event) => setName(event.target.value)} placeholder="My Mac" /></label>
      <button class="proj-btn" type="submit" disabled=${busy || !name.trim()}>${busy ? 'Registering…' : 'Register this device'}</button>
    </form>`
          : html`<div class="proj-empty">Loading device inventory…</div>`
    }
  </div>`;
}

export function DevicesSection({ projectIds, kingdomPaired }) {
  return html`
    ${
      kingdomPaired
        ? null
        : html`<section class="settings-card devices-kingdom">
      <div class="settings-card-header"><span class="settings-card-title">Peers need Kingdom</span></div>
      <p class="settings-desc">Peers are your other machines running Foundry: once they share a Kingdom, they are listed here with the projects each has checked out. A paired Kingdom is also how you open this Foundry from another machine.</p>
      <a class="action-btn" href=${settingsPath(null, 'kingdom')} onClick=${onLink}>Pair a Kingdom</a>
    </section>`
    }
    <section class="settings-card">
      <div class="settings-card-header"><span class="settings-card-title">This machine</span></div>
      <${LocalDevicePanel} projectIds=${projectIds} />
      ${
        kingdomPaired
          ? html`<${ComingSoon} what="Peers: your other machines, each with its projects and quota." />`
          : html`<p class="settings-desc">Peers: pair a Kingdom to see your other machines.</p>`
      }
    </section>
  `;
}
