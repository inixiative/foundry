import { html, useEffect, useState } from './lib.js';

export function KingdomSettings() {
  const [url, setUrl] = useState('http://localhost:8000');
  const [name, setName] = useState('My Foundry');
  const [state, setState] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  /** The paired Kingdom being paired again, or null when adding one. */
  const [replacing, setReplacing] = useState(null);
  const refresh = () =>
    fetch('/api/kingdom/status')
      .then((r) => {
        if (!r.ok) throw Error('Unable to read Kingdom connections');
        return r.json();
      })
      .then(setState);
  const call = async (action, body) => {
    const response = await fetch(`/api/kingdom/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
    const value = await response.json();
    if (!response.ok) throw Error(value.error || 'Connection failed');
    setState(value);
    return value;
  };
  useEffect(() => {
    refresh().catch((e) => setError(e.message));
  }, []);
  const pending = state?.pending;
  // Pairing completes in the background once approved in Kingdom; follow it until it does.
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(() => {
      refresh()
        .then(() => setError(''))
        .catch((e) => setError(e.message));
    }, 2000);
    return () => clearInterval(timer);
  }, [!!pending]);
  const act = async (action, body) => {
    setBusy(true);
    setError('');
    try {
      await call(action, body);
      if (action === 'pair') setReplacing(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  const integrations = state?.integrations ?? [];
  const shown = error || state?.error;
  return html`<section class="settings-card kingdom-connection">
    <h2 class="settings-card-title">Kingdom connections</h2>
    <p class="settings-desc">Connect this Foundry to one or more Kingdoms. Approve it there and it becomes that owner's Foundry integration; it acts only through the Signets Kingdom grants it. Its key and Signets stay on this machine.</p>
    ${shown && html`<p role="alert">${shown}</p>`}
    ${
      !state
        ? html`<p>Loading connections…</p>`
        : html`
      ${integrations.map(
        (integration) => html`<div class="kingdom-integration" key=${integration.id}>
        <p>${integration.status === 'connected' ? 'Connected to' : 'Authorization unavailable at'} ${integration.url}</p>
        <p>Owner: <code>${integration.owner}</code> · Integration: <code>${integration.integrationId}</code> · ID: <code>${integration.id}</code></p>
        <button class="action-btn" disabled=${busy || !!pending} onClick=${() => {
          setUrl(integration.url);
          setReplacing(integration.id);
        }}>Reconnect with Kingdom approval</button>
        <button class="action-btn subtle" disabled=${busy} onClick=${() => act('disconnect', { id: integration.id })}>Disconnect this Kingdom</button>
      </div>`,
      )}
      ${integrations.length ? html`<p class="settings-desc">Disconnecting deletes this machine’s Signet for that Kingdom only. Revoke the Foundry integration in that Kingdom too; grants, expiry and revocation are managed there.</p>` : ''}
      ${
        pending
          ? html`
        <p>Pairing ${pending.url}${pending.replace ? ' again' : ''}. Code: <strong>${pending.reviewCode}</strong></p>
        <p>Expires ${new Date(pending.expiresAt).toLocaleTimeString()}</p>
        <a class="action-btn" href=${pending.review} target="_blank" rel="noopener noreferrer">Log in to Kingdom and approve</a>
        <p class="settings-desc">Only approve a request you started here, and check the code matches. Waiting for approval…</p>
        ${pending.waiting && html`<p class="settings-desc">Still waiting: ${pending.waiting}</p>`}
        <button class="action-btn subtle" disabled=${busy} onClick=${() => act('cancel')}>Cancel pairing</button>
        <p class="settings-desc">If already approved in Kingdom, revoke that Foundry integration there before starting again.</p>
      `
          : html`
        <h3>${replacing ? 'Pair this Kingdom again' : integrations.length ? 'Pair another Kingdom' : 'Pair a Kingdom'}</h3>
        <label class="settings-label" for="kingdom-api-url">Kingdom API address</label>
        <input id="kingdom-api-url" class="settings-input" value=${url} disabled=${!!replacing} onInput=${(e) => setUrl(e.target.value)} placeholder="https://api.your-kingdom.example" />
        <label class="settings-label" for="kingdom-installation-name">Foundry name</label>
        <input id="kingdom-installation-name" class="settings-input" value=${name} maxlength="120" onInput=${(e) => setName(e.target.value)} />
        <button class="action-btn" disabled=${busy || !name.trim() || !url} onClick=${() => act('pair', { url, name, ...(replacing ? { replace: replacing } : {}) })}>${busy ? 'Connecting…' : 'Connect to Kingdom'}</button>
        ${replacing && html`<button class="action-btn subtle" disabled=${busy} onClick=${() => setReplacing(null)}>Cancel</button>`}
      `
      }
    `
    }
  </section>`;
}
