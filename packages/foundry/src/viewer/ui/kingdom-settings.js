import { html, useEffect, useState } from './lib.js';

export function KingdomSettings() {
  const [url, setUrl] = useState('http://localhost:8000');
  const [name, setName] = useState('My Foundry');
  const [state, setState] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  /** The paired Kingdom being paired again, or null when adding one. */
  const [replacing, setReplacing] = useState(null);
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
    fetch('/api/kingdom/status')
      .then((r) => {
        if (!r.ok) throw Error('Unable to read Kingdom connections');
        return r.json();
      })
      .then(setState)
      .catch((e) => setError(e.message));
  }, []);
  const pending = state?.pending;
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(() => {
      call('poll')
        .then(() => setError(''))
        .catch((e) => setError(e.message));
    }, 5000);
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
  const runtimes = state?.runtimes ?? [];
  return html`<section class="settings-card kingdom-connection">
    <h2 class="settings-card-title">Kingdom connections</h2>
    <p class="settings-desc">Connect this Foundry to one or more Kingdoms. Sign in there, compare the pairing code, and approve the runtime. Each Kingdom's jobs and archives go only to that Kingdom. Credentials stay on this machine.</p>
    ${error && html`<p role="alert">${error}</p>`}
    ${
      !state
        ? html`<p>Loading connections…</p>`
        : html`
      ${runtimes.map(
        (runtime) => html`<div class="kingdom-runtime" key=${runtime.id}>
        <p>${runtime.status === 'connected' ? 'Connected to' : 'Authorization unavailable at'} ${runtime.url}</p>
        <p>Owner: <code>${runtime.owner}</code> · Runtime: <code>${runtime.installationId}</code> · ID: <code>${runtime.id}</code></p>
        <button class="action-btn" disabled=${busy || !!pending} onClick=${() => {
          setUrl(runtime.url);
          setReplacing(runtime.id);
        }}>Reconnect with Kingdom approval</button>
        <button class="action-btn subtle" disabled=${busy} onClick=${() => act('disconnect', { id: runtime.id })}>Disconnect this Kingdom</button>
      </div>`,
      )}
      ${runtimes.length ? html`<p class="settings-desc">Disconnecting deletes this machine’s credential for that Kingdom only. Revoke the runtime in that Kingdom’s Foundry tab too. Manage expiry and revocation there; provider subscriptions and viewer access have separate permissions.</p>` : ''}
      ${
        pending
          ? html`
        <p>Pairing ${pending.url}${pending.replace ? ' again' : ''}. Code: <strong>${pending.userCode}</strong></p>
        <p>Expires ${new Date(pending.expiresAt).toLocaleTimeString()}</p>
        <a class="action-btn" href=${pending.verificationUrl} target="_blank" rel="noopener noreferrer">Log in to Kingdom and approve</a>
        <p class="settings-desc">Or enter this code in Kingdom → Foundry. Only approve a request you started here. Waiting for approval…</p>
        <button class="action-btn subtle" disabled=${busy} onClick=${() => act('cancel')}>Cancel pairing</button>
        <p class="settings-desc">If already approved in Kingdom, revoke that runtime there before starting again.</p>
      `
          : html`
        <h3>${replacing ? 'Pair this Kingdom again' : runtimes.length ? 'Pair another Kingdom' : 'Pair a Kingdom'}</h3>
        <label class="settings-label" for="kingdom-api-url">Kingdom API address</label>
        <input id="kingdom-api-url" class="settings-input" value=${url} disabled=${!!replacing} onInput=${(e) => setUrl(e.target.value)} placeholder="https://api.your-kingdom.example" />
        <label class="settings-label" for="kingdom-runtime-name">Foundry name</label>
        <input id="kingdom-runtime-name" class="settings-input" value=${name} maxlength="120" onInput=${(e) => setName(e.target.value)} />
        <button class="action-btn" disabled=${busy || !name.trim() || !url} onClick=${() => act('pair', { url, name, ...(replacing ? { replace: replacing } : {}) })}>${busy ? 'Connecting…' : 'Connect to Kingdom'}</button>
        ${replacing && html`<button class="action-btn subtle" disabled=${busy} onClick=${() => setReplacing(null)}>Cancel</button>`}
      `
      }
    `
    }
  </section>`;
}
