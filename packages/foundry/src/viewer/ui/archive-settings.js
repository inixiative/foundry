import { html, useEffect, useState } from './lib.js';

export function ArchiveSettings() {
  const [status, setStatus] = useState(null);
  const [captureErrors, setCaptureErrors] = useState({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const load = async () => {
    try {
      const response = await fetch('/api/archives');
      const result = await response.json();
      if (!response.ok) throw Error(result.error || 'Archive unavailable');
      setStatus(result.status);
      setCaptureErrors(result.captureErrors);
      setError('');
    } catch (e) {
      setError(e.message);
    }
  };
  useEffect(() => {
    load();
  }, []);
  const setup = async () => {
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/archives/setup', { method: 'POST' });
      const result = await response.json();
      setStatus(result);
      if (!response.ok) throw Error(result.error || 'Archive setup failed');
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  const failures = Object.keys(captureErrors).length;
  return html`<section class="settings-card archive-settings">
    <h2 class="settings-card-title">Session Archive</h2>
    <p class="settings-desc">Foundry captures every session into this machine's local Archive. Hosted Archives connect through Kingdom; the local Archive publishes to them.</p>
    ${error && html`<p role="alert">${error}</p>`}
    ${
      !status
        ? html`<p>Checking the local Archive…</p>`
        : html`
      <p>${status.reachable ? 'Running at' : status.configured ? 'Not answering at' : 'Not set up. It will run at'} <code>${status.url}</code></p>
      ${
        status.reachable
          ? ''
          : html`<button class="action-btn" disabled=${busy} onClick=${setup}>${busy ? 'Starting the Archive…' : 'Set up an Archive'}</button>
        <p class="settings-desc">Runs <code>archive up</code>: the Archive and its Postgres in Docker Compose. Docker must be running.</p>`
      }
      ${failures ? html`<p class="settings-desc">${failures} thread${failures === 1 ? '' : 's'} waiting to be captured; capture retries every 30 seconds.</p>` : ''}
      ${
        status.integrations?.length
          ? html`<h3>Integrations</h3>
        <p class="settings-desc">What archived sessions can reference. The Archive owns this list.</p>
        <ul>${status.integrations.map((integration) => html`<li key=${integration.key}>${integration.name} <code>${integration.key}</code>${integration.prefix ? html` · <code>${integration.prefix}</code>` : ''}</li>`)}</ul>`
          : ''
      }
      <button class="action-btn subtle" disabled=${busy} onClick=${load}>Refresh</button>
    `
    }
  </section>`;
}
