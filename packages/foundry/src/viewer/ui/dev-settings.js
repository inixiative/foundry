/**
 * @atlas
 * @kind component
 * @partOf feature:viewer, feature:wardens
 */
/**
 * Settings → Dev (shown only in dev mode, R-2026-11-25-05): a local Chorus host that serves every
 * chorus-on project's Wardens directly, no Kingdom, and a local Oracle host whose health is checked.
 * Each names the keychain entry holding its token, never the token.
 */

import { html, useEffect, useState } from './lib.js';
import { authFetch, showToast } from './store.js';

const DEFAULT_TOKEN_KEY = 'CHORUS_DEV_TOKEN';

const HOSTS = [
  ['__chorus', 'Chorus', 'Serves the Wardens of every project whose chorus is on.', '/readyz'],
  ['__oracle', 'Oracle', 'Only its health is checked for now.', '/healthz'],
];

const draftOf = (config) =>
  Object.fromEntries(
    HOSTS.map(([key]) => [
      key,
      { url: config?.[key]?.url ?? '', tokenKey: config?.[key]?.tokenKey ?? '' },
    ]),
  );

function ProbeLine({ result }) {
  if (!result) return null;
  const token = result.tokenHeld
    ? html`token entry <code>${result.tokenKey}</code> held`
    : html`no <code>${result.tokenKey}</code> in the keychain or environment`;
  return html`<p class="settings-desc" role="status">
    ${result.ok ? 'Answering' : 'Not answering'}: <code>${result.url}</code> ${result.status ? `(${result.status})` : ''}
    ${result.detail ? html` · ${result.detail}` : null} · ${token}
  </p>`;
}

export function DevSection({ config, onSaved }) {
  const [draft, setDraft] = useState(() => draftOf(config));
  const [probe, setProbe] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => setDraft(draftOf(config)), [config]);
  const set = (key, field, value) =>
    setDraft((d) => ({ ...d, [key]: { ...d[key], [field]: value } }));
  const check = async () => {
    try {
      const res = await authFetch('/api/dev/probe');
      setProbe(res.ok ? await res.json() : null);
    } catch {
      setProbe(null);
    }
  };
  const save = async () => {
    setBusy(true);
    try {
      const patch = Object.fromEntries(
        HOSTS.map(([key]) => {
          const { url, tokenKey } = draft[key];
          if (!url.trim()) return [key, null];
          return [
            key,
            { url: url.trim(), ...(tokenKey.trim() ? { tokenKey: tokenKey.trim() } : {}) },
          ];
        }),
      );
      const res = await authFetch('/api/settings/dev', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw Error(body.error || 'Could not save');
      onSaved?.(body);
      showToast('Saved for this machine', 'ok');
      await check();
    } catch (error) {
      showToast(error.message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return html`<section class="settings-card" data-setting="__chorus">
    <div class="settings-card-header"><span class="settings-card-title">Dev hosts</span></div>
    <p class="settings-desc">While dev mode is on, a project whose chorus is on sends its Warden calls straight to this Chorus host, not through Kingdom and not to this machine's Warden host. Turn dev mode off to go back.</p>
    ${HOSTS.map(
      ([key, label, desc, path]) => html`
      <div key=${key} class="settings-section-label">${label}</div>
      <p class="settings-desc">${desc} Checked at <code>${path}</code>.</p>
      <label class="settings-field" data-setting=${key}>
        <span class="settings-label">URL</span>
        <input class="settings-input" placeholder="http://localhost:4900" value=${draft[key].url}
          onInput=${(e) => set(key, 'url', e.target.value)} />
      </label>
      <label class="settings-field">
        <span class="settings-label">Token keychain entry</span>
        <input class="settings-input" placeholder=${DEFAULT_TOKEN_KEY} value=${draft[key].tokenKey}
          onInput=${(e) => set(key, 'tokenKey', e.target.value)} />
      </label>
      <${ProbeLine} result=${probe?.[key.slice(2)]} />`,
    )}
    <p class="settings-desc">The token is a keychain entry's name, never the token: store it in Settings → Keychain (or set the environment variable of that name before Foundry starts).</p>
    <div class="settings-card-actions">
      <button class="action-btn" disabled=${busy} onClick=${save}>Save</button>
      <button class="action-btn subtle" disabled=${busy} onClick=${check}>Check hosts</button>
    </div>
  </section>`;
}
