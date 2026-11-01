/**
 * @atlas
 * @kind component
 * @partOf feature:viewer, integration:kingdom
 */
/**
 * Settings → GitHub and Settings → Linear: what is connected today (the local Archive links sessions
 * to the integration's references) and where its account lives: in Kingdom, as an integration this
 * Foundry uses through a Signet.
 */

import { kingdomIntegrationsUrl } from './hosted-archive-link.js';
import { html, useEffect, useState } from './lib.js';
import { kingdomStatus, loadKingdomStatus } from './store.js';

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
  useEffect(() => {
    if (!kingdomStatus.value) loadKingdomStatus();
  }, []);
  const kingdomUrls = [...new Set((kingdomStatus.value?.integrations ?? []).map((i) => i.url))];
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
      <div class="settings-card-header"><span class="settings-card-title">${name} account</span></div>
      <p class="settings-desc">A ${name} account is an integration in Kingdom: its credentials live there, and Kingdom grants this Foundry a revocable Signet to use it. No token is kept on this machine.</p>
      ${
        kingdomUrls.length
          ? kingdomUrls.map((url) => {
              const href = kingdomIntegrationsUrl(url);
              return href
                ? html`<a key=${url} class="action-btn" href=${href} target="_blank" rel="noopener noreferrer">Manage ${name} in ${new URL(href).host} ↗</a>`
                : html`<p key=${url} class="settings-desc">${url} is not an https Kingdom; add ${name} in Kingdom directly.</p>`;
            })
          : html`<p class="settings-desc">Pair a Kingdom in Settings → Kingdom to add a ${name} account.</p>`
      }
    </section>
  `;
}
