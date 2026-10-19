/**
 * @atlas
 * @kind component
 * @partOf feature:viewer, integration:archive
 */
import { hostedSetupUrl } from './hosted-archive-link.js';
import { html, useEffect, useState } from './lib.js';
import { onLink, settingsPath } from './route.js';

/** Settings → Archive: session archives only. The local Archive, hosted ones, and where each project publishes. */
export function ArchiveSettings({ projects = [] }) {
  const [status, setStatus] = useState(null);
  const [captureErrors, setCaptureErrors] = useState({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [kingdoms, setKingdoms] = useState([]);
  const load = async () => {
    fetch('/api/kingdom/status')
      .then((response) => (response.ok ? response.json() : { integrations: [] }))
      .then((value) => setKingdoms(value.integrations ?? []))
      .catch(() => setKingdoms([]));
    try {
      const response = await fetch('/api/archives');
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.status)
        throw Error(result.error || 'The local Archive status is unavailable.');
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
    <h2 class="settings-card-title">Session Archives</h2>
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
          : html`<button class="action-btn" disabled=${busy} onClick=${setup}>${busy ? 'Starting the Archive…' : 'Set up local Archive'}</button>
        <p class="settings-desc">Runs <code>archive up</code>: the Archive and its Postgres in Docker Compose. Docker must be running.</p>`
      }
      ${failures ? html`<p class="settings-desc">${failures} thread${failures === 1 ? '' : 's'} waiting to be captured; capture retries every 30 seconds.</p>` : ''}
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
    <h3>Routing</h3>
    <p class="settings-desc">Each project chooses which hosted Archives its sessions publish to; with none, they stay in the local Archive.</p>
    ${
      projects.length
        ? html`<ul class="archive-routing">${projects.map(
            (p) =>
              html`<li key=${p.id}><a href=${settingsPath(p.id, 'archive')} onClick=${onLink}>${p.label}</a></li>`,
          )}</ul>`
        : html`<p class="settings-desc">Add a project to route its sessions.</p>`
    }
  </section>`;
}

/** A project's Archive: the sessions captured for it and where its sessions publish. */
export function ProjectArchive({ projectId }) {
  const [archives, setArchives] = useState(null);
  const [routing, setRouting] = useState(null);
  const [library, setLibrary] = useState('');
  const [organization, setOrganization] = useState('');
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
        body: JSON.stringify({
          projectId,
          ...(routing?.organizationId ? {} : { organizationId: organization.trim() }),
          ...target,
        }),
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
    <p class="settings-desc">The local Archive keeps every session. Hosted Archives are per organization: this project's sessions, and any session that touched it, go to its organization's Archives. With none, they stay on this machine.</p>
    ${
      routing &&
      (routing.organizationId
        ? html`<p class="settings-desc">Organization: <strong>${routing.organizationId}</strong></p>`
        : html`<div class="settings-row">
            <input class="settings-input small" list="archive-organizations" aria-label="Organization" placeholder="Organization this project belongs to" value=${organization} onInput=${(e) => setOrganization(e.target.value)} />
            <datalist id="archive-organizations">${(routing.organizations ?? []).map((id) => html`<option key=${id} value=${id} />`)}</datalist>
          </div>`)
    }
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
              <button class="action-btn" disabled=${busy || !library || (!routing.organizationId && !organization.trim())} onClick=${() => {
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
