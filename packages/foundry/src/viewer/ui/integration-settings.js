/**
 * Settings → GitHub and Settings → Linear: what is connected today (the local Archive links sessions
 * to the integration's references) and, coming soon, connecting an account, whose credentials will
 * live in Kingdom under the access model rather than on this machine.
 */

import { html, useEffect, useState } from './lib.js';

const REFERENCES = {
  github: 'pull requests, issues and commits',
  linear: 'issues',
};

export function IntegrationSection({ id, name }) {
  const [archive, setArchive] = useState(null);
  useEffect(() => {
    fetch('/api/archives')
      .then((res) => (res.ok ? res.json() : Promise.reject()))
      .then((body) => setArchive(body.status))
      .catch(() => setArchive({ reachable: false }));
  }, [id]);
  const integration = archive?.integrations?.find((i) => i.key === id);
  return html`
    <section class="settings-card integration-card" data-integration=${id}>
      <div class="settings-card-header"><span class="settings-card-title">Connected</span></div>
      ${
        !archive
          ? html`<p class="settings-desc">Checking the local Archive…</p>`
          : !archive.reachable
            ? html`<p class="settings-desc">The local Archive is not running, so nothing links sessions to ${name} yet. Set it up in Settings → Archive.</p>`
            : integration
              ? html`<p><span class="mode-chip tone-ok">Session references</span> The local Archive links each session to the ${name} ${REFERENCES[id] ?? 'items'} it mentions (<code>${integration.key}</code>${integration.prefix ? html`, prefix <code>${integration.prefix}</code>` : ''}).</p>`
              : html`<p class="settings-desc">The local Archive does not list ${name} among its integrations.</p>`
      }
    </section>
    <section class="settings-card integration-card">
      <div class="settings-card-header">
        <span class="settings-card-title">${name} account</span>
        <span class="coming-soon">Coming soon</span>
      </div>
      <p class="settings-desc">Connecting a ${name} account will let agents read and act in ${name}. Its credentials will live in Kingdom, which grants this Foundry a revocable Signet for them; no token is kept here.</p>
      <button class="action-btn" disabled>Connect ${name}</button>
    </section>
  `;
}
