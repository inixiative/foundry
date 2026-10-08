import { html, useEffect, useState } from './lib.js';
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
      <p class="settings-desc">Where each project is checked out here. Other devices are not connected yet.</p>
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
