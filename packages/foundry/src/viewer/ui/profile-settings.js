/**
 * Settings → Profile: who this Foundry is (its installation name, the one Kingdom pairing uses) and
 * who runs it (the operator, as a paired Kingdom describes them).
 */

import { operatorOf, ownerName } from './kingdom-holder.js';
import { html, useEffect, useState } from './lib.js';
import { onLink, settingsPath } from './route.js';
import { authFetch, showToast } from './store.js';

export function ProfileSection({ onSaved }) {
  const [profile, setProfile] = useState(null);
  const [draft, setDraft] = useState('');
  const [kingdom, setKingdom] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = () =>
    authFetch('/api/profile')
      .then((res) => res.json())
      .then((body) => {
        setProfile(body);
        setDraft(body.installationName);
      })
      .catch(() => setProfile({ error: true }));
  useEffect(() => {
    load();
    authFetch('/api/kingdom/status')
      .then((res) => (res.ok ? res.json() : null))
      .then(setKingdom)
      .catch(() => setKingdom(null));
  }, []);
  const save = async (installationName) => {
    setBusy(true);
    try {
      const res = await authFetch('/api/settings/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ installationName }),
      });
      const body = await res.json();
      if (!res.ok) throw Error(body.error || 'Could not save the name');
      onSaved?.(body);
      await load();
      showToast('Name saved', 'ok');
    } catch (error) {
      showToast(error.message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const paired = (kingdom?.integrations ?? []).filter((k) => operatorOf(k.holder));
  return html`
    <section class="settings-card profile-card">
      <div class="settings-card-header"><span class="settings-card-title">Who are you</span></div>
      ${
        !profile
          ? html`<p class="settings-desc">Loading…</p>`
          : profile.error
            ? html`<p role="alert">The profile could not be read.</p>`
            : html`
        <label class="settings-field">
          <span class="settings-label">Foundry name</span>
          <input id="installation-name" class="settings-input" maxlength="120" value=${draft}
            onInput=${(e) => setDraft(e.target.value)} />
        </label>
        <p class="settings-desc">This machine's Foundry, by name. Kingdom pairing names it with this (<code>bun run setup</code> asks for it on first run). A new name applies to the next pairing; a paired Kingdom keeps the name it was paired with.</p>
        <div class="settings-card-actions">
          <button class="action-btn" disabled=${busy || !draft.trim() || draft.trim() === profile.installationName}
            onClick=${() => save(draft.trim())}>Save name</button>
          ${
            profile.custom
              ? html`<button class="action-btn subtle" disabled=${busy} onClick=${() => save(null)}>Use the default (${profile.defaultName})</button>`
              : null
          }
        </div>`
      }
      <div class="settings-section-label">You</div>
      ${
        paired.length
          ? html`<dl class="access-details operator-identity">${paired.map((k) => {
              const operator = operatorOf(k.holder);
              return html`
                <dt key=${`${k.id}-who`}>${operator.name ?? operator.email}</dt>
                <dd key=${k.id}><code>${operator.email}</code> · ${ownerName(k.holder) ?? 'Personal'} · through ${new URL(k.url).host}</dd>`;
            })}</dl>`
          : html`<p class="settings-desc">Foundry knows who you are from Kingdom. <a href=${settingsPath(null, 'kingdom')} onClick=${onLink}>Pair a Kingdom</a> to show your name, email and organization here.</p>`
      }
    </section>
  `;
}
