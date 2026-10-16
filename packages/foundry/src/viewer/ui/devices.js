/**
 * Settings → Devices: this machine and its peers, and the tunnel that lets Kingdom (and you, away
 * from this machine) reach this Foundry. Kingdom drives both: peers are other Foundries your Kingdom
 * knows, and the tunnel's address is what this Foundry advertises to it.
 */

import { html, useEffect, useState } from './lib.js';
import { onLink, settingsPath } from './route.js';
import { authFetch, showToast } from './store.js';

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

const MODE_TEXT = {
  auto: 'Automatic: on once a paired Kingdom authorizes this Foundry',
  on: 'On',
  off: 'Off (you stopped it)',
};

function TunnelCard() {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(false);
  const [subdomain, setSubdomain] = useState('');
  const [provider, setProvider] = useState('localtunnel');
  const refresh = async () => {
    try {
      const data = await (await authFetch('/api/tunnel')).json();
      setStatus(data);
      setProvider(data.provider || 'localtunnel');
      setSubdomain(data.subdomain || '');
    } catch {
      /* The card says it is loading. */
    }
  };
  useEffect(() => {
    refresh();
  }, []);
  const toggle = async () => {
    setLoading(true);
    try {
      const endpoint = status?.active ? '/api/tunnel/stop' : '/api/tunnel/start';
      const data = await (await authFetch(endpoint, { method: 'POST' })).json();
      if (data.error) showToast(data.error, 'error');
      else showToast(status?.active ? 'Tunnel stopped' : `Tunnel started: ${data.url}`, 'ok');
      await refresh();
    } catch {
      showToast('Tunnel operation failed', 'error');
    }
    setLoading(false);
  };
  const saveConfig = async () => {
    try {
      const res = await authFetch('/api/tunnel', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, subdomain: subdomain || undefined }),
      });
      const data = await res.json();
      if (data.ok) showToast('Tunnel settings saved', 'ok');
      else showToast(data.error || 'Save failed', 'error');
    } catch {
      showToast('Failed to save tunnel settings', 'error');
    }
  };
  const waiting = status?.mode === 'auto' && !status.active && !status.kingdomConnected;
  return html`<section class="settings-card tunnel-card">
    <div class="settings-card-header"><span class="settings-card-title">Tunnel</span></div>
    <p class="settings-desc">A public address for this viewer, so Kingdom can send you here and you can reach this Foundry away from this machine. Every request through it needs this Foundry's tunnel token; while it runs, so does this machine's own browser.</p>
    ${
      !status
        ? html`<p class="settings-desc">Loading…</p>`
        : html`
      <div class="tunnel-status">
        <div class="tunnel-status-row">
          <span class="tunnel-indicator ${status.active ? 'active' : 'inactive'}"></span>
          <span>${status.active ? 'Running' : 'Not running'}</span>
          ${status.active && status.url ? html`<a class="tunnel-url" href=${status.url} target="_blank" rel="noopener">${status.url}</a>` : null}
        </div>
        <p class="settings-desc tunnel-mode" data-mode=${status.mode}>${MODE_TEXT[status.mode]}${
          waiting
            ? '. No paired Kingdom authorizes this Foundry yet, so it stays off.'
            : status.mode === 'auto' && !status.active
              ? '. A Kingdom authorizes it now: it starts with Foundry next time, or start it here.'
              : '.'
        }</p>
        <button class="action-btn ${status.active ? 'danger' : ''}" onClick=${toggle} disabled=${loading}>
          ${loading ? '…' : status.active ? 'Stop tunnel' : 'Start tunnel'}
        </button>
      </div>
      <div class="settings-row">
        <label class="settings-field">
          <span class="settings-label">Provider</span>
          <select class="settings-input small" value=${provider} onChange=${(e) => setProvider(e.target.value)}>
            <option value="localtunnel">localtunnel (zero-config)</option>
            <option value="cloudflared">cloudflared (production)</option>
          </select>
        </label>
        <label class="settings-field">
          <span class="settings-label">Subdomain hint</span>
          <input class="settings-input small" value=${subdomain} onInput=${(e) => setSubdomain(e.target.value)}
            placeholder="my-foundry (localtunnel only)" />
        </label>
      </div>
      <p class="settings-desc">The token lives in the private tunnel-token file in this Foundry's configuration directory and is never shown here.</p>
      <div class="settings-card-actions"><button class="action-btn" onClick=${saveConfig}>Save tunnel settings</button></div>
    `
    }
  </section>`;
}

export function DevicesSection({ projectIds, kingdomPaired }) {
  return html`
    ${
      kingdomPaired
        ? null
        : html`<section class="settings-card devices-kingdom">
      <div class="settings-card-header"><span class="settings-card-title">Peers and the tunnel need Kingdom</span></div>
      <p class="settings-desc">Peers are your other machines running Foundry: once they share a Kingdom, they are listed here with the projects each has checked out. The tunnel gives this Foundry a public address Kingdom can send you to from anywhere. Kingdom drives both, so they wait until this Foundry is paired.</p>
      <a class="action-btn" href=${settingsPath(null, 'kingdom')} onClick=${onLink}>Pair a Kingdom</a>
    </section>`
    }
    <section class="settings-card">
      <div class="settings-card-header"><span class="settings-card-title">This machine</span></div>
      <${LocalDevicePanel} projectIds=${projectIds} />
      <p class="settings-desc">Peers: ${kingdomPaired ? 'none connected yet; other machines appear here once they pair with the same Kingdom.' : 'pair a Kingdom to see your other machines.'}</p>
    </section>
    <${TunnelCard} />
  `;
}
