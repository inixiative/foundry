/**
 * @atlas
 * @kind component
 * @partOf feature:viewer
 */
/**
 * The rail's footer: this machine and its resources (Aron, 2026-11-01). The machine's name (this
 * Foundry's name, editable in place) and its tunnel; Kingdoms and Archives as two equal pills, each
 * linking to its settings; one Subscriptions row that opens to each subscription. Threads, Wardens
 * and Forge Master live elsewhere.
 */

import { capacityByProvider } from './capacity.js';
import { html, useEffect, useState } from './lib.js';
import { RenameModal } from './modal.js';
import { navigate, settingsPath } from './route.js';
import {
  authFetch,
  kingdomStatus,
  loadKingdomStatus,
  modelRegistryOnce,
  showToast,
  vendorName,
} from './store.js';
import { harnessName } from './thread-labels.js';

const getJson = (url) =>
  authFetch(url)
    .then((res) => (res.ok ? res.json() : null))
    .catch(() => null);

/** A subscription is a login (a native harness sign-in, a profile, or a Kingdom pool), not an API key. */
const SUBSCRIPTION_SOURCES = new Set(['login', 'profile', 'kingdom', 'gateway']);

/** Read once when the footer mounts; the footer is glanceable, not live. */
function useMachine() {
  const [machine, setMachine] = useState({});
  const rename = (profile) => setMachine((m) => ({ ...m, profile }));
  useEffect(() => {
    if (!kingdomStatus.value) loadKingdomStatus();
    let live = true;
    Promise.all([
      getJson('/api/profile'),
      getJson('/api/tunnel'),
      getJson('/api/archives/status'),
      getJson('/api/archives/destinations'),
      getJson('/api/providers/accounts'),
      modelRegistryOnce(),
    ]).then(([profile, tunnel, archive, destinations, accounts, registry]) => {
      if (live) setMachine({ profile, tunnel, archive, destinations, accounts, registry });
    });
    return () => {
      live = false;
    };
  }, []);
  return { ...machine, rename };
}

/** One row that opens to every subscription, grouped by the provider that sells it. */
function Subscriptions({ accounts, registry }) {
  const [open, setOpen] = useState(false);
  const subscriptions = (Array.isArray(accounts) ? accounts : []).filter((a) =>
    SUBSCRIPTION_SOURCES.has(a.source),
  );
  const groups = capacityByProvider(subscriptions, (provider) => vendorName(provider, registry));
  if (!groups.length) return null;
  const ready = groups.reduce((n, g) => n + g.ready, 0);
  const total = groups.reduce((n, g) => n + g.accounts.length, 0);
  return html`<div class="nav-footer-subscriptions">
    <button type="button" class="nav-footer-row" aria-expanded=${open} onClick=${() => setOpen(!open)}
      title=${`${ready} of ${total} ready`}>
      <span class="nav-footer-dot ${ready === total ? 'is-ok' : 'is-warn'}"></span>
      <span class="nav-footer-name">Subscriptions</span>
      <span class="nav-footer-caret">${open ? '▾' : '▸'}</span>
    </button>
    ${
      open
        ? html`<ul class="nav-footer-subs">${groups.flatMap((g) =>
            g.accounts.map(
              (a, i) => html`<li key=${`${g.provider}:${i}`}
                title=${[a.issue, harnessName(a.provider) ? `through ${harnessName(a.provider)}` : null].filter(Boolean).join(' · ')}>
                <span class="nav-footer-dot ${a.ready ? 'is-ok' : 'is-warn'}"></span>
                <span class="nav-footer-sub-name">${g.provider} · ${a.detail}</span>
              </li>`,
            ),
          )}</ul>`
        : null
    }
  </div>`;
}

/** The machine's name (this Foundry's name in Settings › Profile): Edit on hover, ✓ saves, ✕ cancels. */
function MachineName({ profile, onSaved }) {
  const [draft, setDraft] = useState(null);
  const name = profile?.installationName ?? 'This machine';
  const save = async (value) => {
    const next = (value ?? draft)?.trim();
    if (!next || next === name) return setDraft(null);
    try {
      const res = await authFetch('/api/settings/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ installationName: next }),
      });
      if (!res.ok)
        throw Error((await res.json().catch(() => ({}))).error || 'Could not save the name');
      onSaved({ ...profile, installationName: next, custom: true });
      setDraft(null);
      return true;
    } catch (error) {
      showToast(error.message, 'error');
      return false;
    }
  };
  const modal =
    draft !== null
      ? html`<${RenameModal} title="Rename this machine" label="Machine name" value=${name}
          onClose=${() => setDraft(null)}
          onSave=${async (next) => {
            setDraft(next);
            return save(next);
          }} />`
      : null;
  return html`<span class="nav-footer-device" title="This machine's name">${name}</span>
    <button type="button" class="nav-footer-edit" title="Rename this machine" onClick=${() => setDraft(name)}>Edit</button>${modal}`;
}

export function NavFooter() {
  const { profile, tunnel, archive, destinations, accounts, registry, rename } = useMachine();
  const kingdoms = kingdomStatus.value?.integrations?.length ?? 0;
  const archives = (archive?.reachable ? 1 : 0) + (destinations?.libraries?.length ?? 0);
  const go = (section) => (e) => {
    e.preventDefault();
    navigate(settingsPath(null, section));
  };
  return html`<footer class="nav-footer">
    <div class="nav-footer-line nav-footer-machine">
      <${MachineName} profile=${profile} onSaved=${rename} />
      ${
        tunnel
          ? html`<a class="nav-footer-link" href=${settingsPath(null, 'devices')} onClick=${go('devices')}
              title=${tunnel.active ? `Tunnel on: ${tunnel.url ?? ''}` : `Tunnel off (${tunnel.mode})`}>
              <span class="nav-footer-dot ${tunnel.active ? 'is-ok' : 'is-off'}"></span>Tunnel ${tunnel.active ? 'on' : 'off'}
            </a>`
          : null
      }
    </div>
    <div class="nav-footer-pills">
      <a class="nav-footer-pill" href=${settingsPath(null, 'kingdom')} onClick=${go('kingdom')}>Kingdoms ${kingdoms}</a>
      <a class="nav-footer-pill" href=${settingsPath(null, 'archive')} onClick=${go('archive')}
        title=${archive?.reachable ? 'Local Archive running' : 'Local Archive not running'}>Archives ${archives}</a>
    </div>
    <${Subscriptions} accounts=${accounts} registry=${registry} />
  </footer>`;
}
