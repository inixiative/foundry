import { hostedSetupUrl } from './hosted-archive-link.js';
import { html, useEffect, useState } from './lib.js';

export function ArchiveSettings() {
  const [status, setStatus] = useState(null);
  const [captureErrors, setCaptureErrors] = useState({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [kingdoms, setKingdoms] = useState([]);
  const load = async () => {
    fetch('/api/kingdom/status')
      .then((response) => (response.ok ? response.json() : { runtimes: [] }))
      .then((value) => setKingdoms(value.runtimes ?? []))
      .catch(() => setKingdoms([]));
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
    <h2 class="settings-card-title">Set up an Archive</h2>
    <p class="settings-desc">Foundry captures every session into this machine's local Archive. Hosted Archives are set up in Kingdom; the local Archive publishes to them.</p>
    <h3>Local Archive</h3>
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
    <h3>Hosted Archive</h3>
    ${
      kingdoms.length
        ? html`<p class="settings-desc">Kingdom deploys a hosted Archive on your Railway or Render account and connects it to your owner.</p>
      <ul>${kingdoms.map((kingdom) => {
        const href = hostedSetupUrl(kingdom.url);
        return html`<li key=${kingdom.id}>${
          href
            ? html`<a class="action-btn" href=${href} target="_blank" rel="noopener noreferrer">Set up a hosted Archive in ${new URL(href).host}</a>`
            : html`<span>${kingdom.url} is not an https Kingdom; set up its hosted Archive in Kingdom directly.</span>`
        }</li>`;
      })}</ul>`
        : html`<p class="settings-desc">Pair a Kingdom in Settings → Kingdom to set up a hosted Archive.</p>`
    }
  </section>`;
}

/** A project's Archive: the sessions captured for it and where its sessions publish. */
export function ProjectArchive({ projectId }) {
  const [archives, setArchives] = useState(null);
  const [routing, setRouting] = useState(null);
  const [library, setLibrary] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const query = `projectId=${encodeURIComponent(projectId)}`;
  const get = async (path) => {
    const response = await fetch(path);
    const body = await response.json();
    if (!response.ok) throw Error(body.error || 'Archive unavailable');
    return body;
  };
  const load = async () => {
    const [listed, routed] = await Promise.allSettled([
      get(`/api/archives?${query}`),
      get(`/api/archives/destinations?${query}`),
    ]);
    const reachable = listed.status === 'fulfilled' && listed.value.status.reachable;
    setArchives(reachable ? listed.value.archives : null);
    setRouting(routed.status === 'fulfilled' ? routed.value : null);
    setError(
      listed.status === 'rejected'
        ? listed.reason.message
        : !reachable
          ? `The local Archive is not answering at ${listed.value.status.url}.`
          : routed.status === 'rejected'
            ? `Routing is unavailable: ${routed.reason.message}`
            : '',
    );
  };
  useEffect(() => {
    load();
  }, [projectId]);
  const change = async (action, target) => {
    setBusy(true);
    setError('');
    try {
      const response = await fetch(`/api/archives/destinations/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId, ...target }),
      });
      const body = await response.json();
      if (!response.ok) throw Error(body.error || `Could not ${action} the destination`);
      setLibrary('');
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  const destinations = routing?.destinations ?? [];
  const libraryName = (d) =>
    routing?.libraries.find(
      (l) => l.integrationId === d.integrationId && l.resourceId === d.resourceId,
    )?.name;
  const libraries = (routing?.libraries ?? []).filter(
    (l) =>
      !destinations.some(
        (d) => d.integrationId === l.integrationId && d.resourceId === l.resourceId,
      ),
  );
  return html`<section class="settings-card archive-settings">
    ${error && html`<p role="alert">${error}</p>`}
    <h3>Publishes to</h3>
    <p class="settings-desc">The local Archive keeps every session; it copies this project's sessions to these hosted Archives. With none, they stay on this machine.</p>
    ${
      !routing
        ? html`<p>${error ? 'Routing is unavailable.' : 'Checking routing…'}</p>`
        : destinations.length
          ? html`<ul class="archive-destinations">${destinations.map(
              (d) => html`<li key=${`${d.kind}:${d.url}:${d.resourceId ?? ''}`}>
                <span>${libraryName(d) ?? d.url}</span>
                <span class="settings-card-kind">${d.kind === 'kingdom' ? 'through Kingdom' : 'direct'}</span>
                <span class="settings-desc">${d.delivered} delivered · ${d.pending} pending</span>
                ${d.kind === 'kingdom' ? html`<button class="action-btn subtle" disabled=${busy} onClick=${() => change('remove', { integrationId: d.integrationId, resourceId: d.resourceId })}>Stop publishing</button>` : html`<span class="settings-desc">set with the archive CLI</span>`}
              </li>`,
            )}</ul>`
          : html`<p>Not published: sessions stay in the local Archive.</p>`
    }
    ${
      routing &&
      (routing.paired
        ? libraries.length
          ? html`<div class="settings-row">
              <select class="settings-input small" aria-label="Hosted Archive library" value=${library} onChange=${(e) => setLibrary(e.target.value)}>
                <option value="">Choose a hosted Archive…</option>
                ${libraries.map((l) => html`<option key=${`${l.integrationId}:${l.resourceId}`} value=${`${l.integrationId}:${l.resourceId}`}>${l.name}</option>`)}
              </select>
              <button class="action-btn" disabled=${busy || !library} onClick=${() => {
                const [integrationId, resourceId] = library.split(':');
                change('connect', { integrationId, resourceId });
              }}>Publish here</button>
            </div>`
          : html`<p class="settings-desc">No other hosted Archive library is granted to this Archive. Grant <code>sessions.write</code> on one in Kingdom.</p>`
        : html`<p class="settings-desc">Pair the local Archive with Kingdom to publish to hosted Archives through it.</p>`)
    }
    <h3>Sessions</h3>
    ${
      archives === null
        ? html`<p>${error ? 'Sessions are unavailable.' : 'Loading sessions…'}</p>`
        : archives.length
          ? html`<ul class="archive-sessions">${archives
              .toSorted((a, b) => b.capturedAt - a.capturedAt)
              .map(
                (a) => html`<li key=${a.id}>
                  <span class="archive-session-title">${a.title}</span>
                  <span class="settings-card-kind">${a.source}</span>
                  <span class="settings-desc">${new Date(a.capturedAt).toLocaleString()} · ${a.entries} entries</span>
                </li>`,
              )}</ul>`
          : html`<p>No sessions captured for this project yet.</p>`
    }
  </section>`;
}
