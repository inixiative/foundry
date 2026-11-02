/**
 * @atlas
 * @kind component
 * @partOf feature:viewer, integration:kingdom
 */
/**
 * Settings → Kingdom (also the standalone /kingdom page): what Kingdom is, a link to it, and every
 * paired Kingdom as a table row named the way Kingdom describes it (owner, you, the integration this
 * Foundry is, who approved it). Pairing runs in the background: Kingdom shows a review code, a person
 * approves it there, and the row appears. A custom Kingdom URL is a dev-mode field.
 */

import { ComingSoon } from './coming-soon.js';
import { devMode, setDevMode } from './dev-mode.js';
import { operatorOf, ownerName } from './kingdom-holder.js';
import { html, useEffect, useState } from './lib.js';
import { Switch } from './switch.js';

const STATUS_TEXT = {
  connected: 'Connected',
  unavailable: 'Unavailable',
  revoked: 'Revoked in Kingdom',
};

/** Where to open Kingdom: a paired Kingdom's web address, else its API's /dashboard redirect. */
const kingdomHome = (state) => {
  const described = state?.integrations?.find((k) => k.holder?.webUrl);
  if (described) return described.holder.webUrl;
  try {
    return new URL('/dashboard', state?.integrations?.[0]?.url ?? state?.defaultUrl).toString();
  } catch {
    return null;
  }
};

/**
 * One card per paired Kingdom, built around the Signet this Foundry holds from it (concept-v4,
 * Aron 11-02): Look (who it's for and what it grants), Manage (reconnect issues a new Signet;
 * disconnect drops this machine's), Get more (a request the owner approves) and Adjust (narrow it).
 * What Kingdom doesn't give a paired Foundry yet (each grant's resource, actions and anchor, and the
 * request flow) says Coming soon.
 */
function SignetCards({ integrations, busy, pending, onReconnect, onDisconnect }) {
  return html`<div class="signet-cards">${integrations.map((k) => {
    const holder = k.holder;
    const you = operatorOf(holder);
    return html`<article key=${k.id} class="kingdom-row signet-card" data-status=${k.status} aria-label=${`${ownerName(holder) ?? 'Kingdom'} Signet`}>
      <header class="signet-card-head">
        <span><strong>${ownerName(holder) ?? 'Owner'}</strong>
          <span class="settings-desc">${new URL(k.url).host}${holder ? '' : html` · <code title=${k.owner}>${k.owner.split(':')[0]}</code>`}</span></span>
        <span class="mode-chip tone-${k.status === 'connected' ? 'ok' : 'warn'}">${STATUS_TEXT[k.status] ?? k.status}</span>
      </header>
      <div class="signet-card-grid">
        <section aria-label="Look">
          <h4>Look</h4>
          <dl class="signet-facts">
            <dt>Integration</dt><dd>${holder?.integration.name ?? html`<code>${k.integrationId.slice(0, 8)}</code>`}</dd>
            <dt>You</dt><dd>${you ? html`${you.name ?? ''} <span class="settings-desc">${you.email}</span>` : html`<span class="settings-desc">Not described</span>`}</dd>
            <dt>Approved by</dt><dd>${holder?.issuedBy ? html`${holder.issuedBy.name ?? ''} <span class="settings-desc">${holder.issuedBy.email}</span>` : html`<span class="settings-desc">—</span>`}</dd>
          </dl>
          <${ComingSoon} inline=${true} what="Each grant: its resource, actions and anchor." />
        </section>
        <section aria-label="Manage">
          <h4>Manage</h4>
          <p class="settings-desc">Reconnecting pairs again and issues a new Signet; disconnecting deletes this machine's.</p>
          <span class="signet-actions">
            <button class="action-btn subtle" disabled=${busy || !!pending} onClick=${() => onReconnect(k)}>Reconnect</button>
            <button class="action-btn subtle danger" disabled=${busy} onClick=${() => onDisconnect(k)}>Disconnect</button>
          </span>
        </section>
        <section aria-label="Get more">
          <h4>Get more</h4>
          <${ComingSoon} inline=${true} what="Ask for more under it: a request the owner approves in Kingdom." />
        </section>
        <section aria-label="Adjust">
          <h4>Adjust</h4>
          <p class="settings-desc">Narrow what it grants, or revoke it, in Kingdom.</p>
          ${holder?.manageUrl ? html`<a class="action-btn subtle" href=${holder.manageUrl} target="_blank" rel="noopener noreferrer">Manage in Kingdom</a>` : null}
        </section>
      </div>
    </article>`;
  })}</div>`;
}

export function KingdomSettings({ standalone = false }) {
  const [url, setUrl] = useState('');
  const [state, setState] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  /** The paired Kingdom being paired again, or null when adding one. */
  const [replacing, setReplacing] = useState(null);
  const refresh = () =>
    fetch('/api/kingdom/status')
      .then((r) => {
        if (!r.ok) throw Error('Unable to read paired Kingdoms');
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
    if (!response.ok) throw Error(value.error || 'Pairing failed');
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
  const target = replacing?.url ?? (devMode.value && url.trim() ? url.trim() : state?.defaultUrl);
  const home = kingdomHome(state);
  return html`<section class="kingdom-pairing">
    <div class="settings-card kingdom-intro">
      <p class="settings-desc">Kingdom is where you and your organization decide what may act for you: it approves this Foundry, grants it models and resources through revocable Signets, and hosts your Archives. Keys and Signets stay on this machine.</p>
      ${home ? html`<a class="kingdom-home" href=${home} target="_blank" rel="noopener noreferrer">Open Kingdom ↗</a>` : null}
    </div>
    ${shown && html`<p role="alert">${shown}</p>`}
    ${
      !state
        ? html`<p>Loading paired Kingdoms…</p>`
        : html`
      <div class="settings-card" data-setting="kingdomIntegrations">
        <div class="settings-card-header"><span class="settings-card-title">Your Signets · one per paired Kingdom</span></div>
        ${
          integrations.length
            ? html`<${SignetCards} integrations=${integrations} busy=${busy} pending=${pending}
                onReconnect=${(k) => setReplacing(k)}
                onDisconnect=${(k) => act('disconnect', { id: k.id })} />
              <p class="settings-desc">Disconnecting deletes this machine's Signet for that Kingdom only; revoke the Foundry integration in Kingdom too. Grants, expiry and revocation are managed there.</p>`
            : html`<p class="settings-desc">Not paired with a Kingdom yet.</p>`
        }
      </div>
      <div class="settings-card kingdom-pair">
      ${
        pending
          ? html`
        <p>Pairing ${pending.url}${pending.replace ? ' again' : ''}. Code: <strong class="review-code">${pending.reviewCode}</strong></p>
        <p>Expires ${new Date(pending.expiresAt).toLocaleTimeString()}</p>
        <a class="action-btn" href=${pending.review} target="_blank" rel="noopener noreferrer">Log in to Kingdom and approve</a>
        <p class="settings-desc">Only approve a request you started here, and check the code matches. Waiting for approval…</p>
        ${pending.waiting && html`<p class="settings-desc">Still waiting: ${pending.waiting}</p>`}
        <button class="action-btn subtle" disabled=${busy} onClick=${() => act('cancel')}>Cancel pairing</button>
        <p class="settings-desc">If already approved in Kingdom, revoke that Foundry integration there before starting again.</p>
      `
          : html`
        <h3>${replacing ? `Reconnect ${ownerName(replacing.holder) ?? new URL(replacing.url).host}` : integrations.length ? 'Pair another Kingdom' : 'Pair a Kingdom'}</h3>
        <p class="settings-desc">Pairs as <strong>${state.installationName}</strong> (change it in Profile) with ${target}. Kingdom shows a review code; approve it there.</p>
        ${
          devMode.value && !replacing
            ? html`<label class="settings-field dev-field">
                <span class="settings-label">Kingdom API address <span class="dev-tag">dev</span></span>
                <input id="kingdom-api-url" class="settings-input mono" value=${url} placeholder=${state.defaultUrl}
                  onInput=${(e) => setUrl(e.target.value)} />
              </label>`
            : null
        }
        <div class="settings-card-actions">
          <button class="action-btn" disabled=${busy || !target}
            onClick=${() => act('pair', { url: target, ...(replacing ? { replace: replacing.id } : {}) })}>${busy ? 'Connecting…' : replacing ? 'Reconnect with Kingdom approval' : 'Connect to Kingdom'}</button>
          ${replacing && html`<button class="action-btn subtle" disabled=${busy} onClick=${() => setReplacing(null)}>Cancel</button>`}
        </div>
      `
      }
      </div>
    `
    }
    ${
      standalone
        ? html`<label class="dev-mode-switch"><${Switch} checked=${devMode.value} label="Dev mode" onChange=${setDevMode} /> Dev mode</label>`
        : null
    }
  </section>`;
}
