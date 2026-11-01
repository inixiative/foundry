/**
 * @atlas
 * @kind component
 * @partOf feature:viewer
 */
/**
 * The rail's footer: this machine and its resources (Aron, 2026-11-01). This device and its tunnel;
 * how many Kingdoms and Archives it reaches, each linking to its settings; and capacity, totalled
 * per provider and expandable to that provider's subscriptions. Threads, Wardens and Forge Master
 * live elsewhere.
 */
import { capacityByProvider } from './capacity.js';
import { html, useEffect, useState } from './lib.js';
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

function Capacity({ accounts, registry }) {
  const [shown, setShown] = useState(false);
  const [open, setOpen] = useState(null);
  const groups = capacityByProvider(accounts, (provider) => vendorName(provider, registry));
  if (!groups.length) return null;
  const ready = groups.reduce((n, g) => n + g.ready, 0);
  const total = groups.reduce((n, g) => n + g.accounts.length, 0);
  return html`<div class="nav-footer-capacity" aria-label="Capacity">
    <button type="button" class="nav-footer-row" aria-expanded=${shown} onClick=${() => setShown(!shown)}>
      <span class="nav-footer-dot ${ready === total ? 'is-ok' : 'is-warn'}"></span>
      <span class="nav-footer-name">Capacity</span>
      <span class="nav-footer-count">${groups.length} provider${groups.length === 1 ? '' : 's'} · ${ready}/${total} ready</span>
      <span class="nav-footer-caret">${shown ? '▾' : '▸'}</span>
    </button>
    ${
      !shown
        ? null
        : groups.map(
            (g) => html`<div key=${g.provider} class="nav-footer-provider">
        <button type="button" class="nav-footer-row" aria-expanded=${open === g.provider}
          onClick=${() => setOpen(open === g.provider ? null : g.provider)}>
          <span class="nav-footer-dot ${g.ready === g.accounts.length ? 'is-ok' : 'is-warn'}"></span>
          <span class="nav-footer-name">${g.provider}</span>
          <span class="nav-footer-count">${g.ready}/${g.accounts.length} ready</span>
          <span class="nav-footer-caret">${open === g.provider ? '▾' : '▸'}</span>
        </button>
        ${
          open === g.provider
            ? html`<ul class="nav-footer-subs">${g.accounts.map(
                (
                  a,
                  i,
                ) => html`<li key=${i} title=${[a.issue ?? a.detail, harnessName(a.provider) ? `through ${harnessName(a.provider)}` : null].filter(Boolean).join(' · ')}>
                  <span class="nav-footer-dot ${a.ready ? 'is-ok' : 'is-warn'}"></span>${a.detail}${a.uses?.length ? html` <span class="nav-footer-dim">· ${a.uses.join(', ')}</span>` : null}
                </li>`,
              )}</ul>`
            : null
        }
      </div>`,
          )
    }
  </div>`;
}

/** This Foundry's name (Settings › Profile's "Foundry name"), editable in place. */
function MachineName({ profile, onSaved }) {
  const [draft, setDraft] = useState(null);
  const name = profile?.installationName ?? 'This machine';
  const save = async () => {
    const next = draft?.trim();
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
    } catch (error) {
      showToast(error.message, 'error');
    }
  };
  if (draft !== null)
    return html`<input class="nav-footer-name-input" aria-label="Foundry name" value=${draft}
      onInput=${(e) => setDraft(e.target.value)}
      onKeyDown=${(e) => {
        if (e.key === 'Enter') save();
        if (e.key === 'Escape') setDraft(null);
      }} onBlur=${save} ref=${(el) => el?.focus()} />`;
  return html`<span class="nav-footer-device" title="This Foundry's name">${name}</span>
    <button type="button" class="nav-footer-edit" title="Rename this Foundry" onClick=${() => setDraft(name)}>Edit</button>`;
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
    <div class="nav-footer-line">
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
    <div class="nav-footer-line">
      <a class="nav-footer-link" href=${settingsPath(null, 'kingdom')} onClick=${go('kingdom')}>Kingdoms ${kingdoms}</a>
      <span class="nav-footer-dim">·</span>
      <a class="nav-footer-link" href=${settingsPath(null, 'archive')} onClick=${go('archive')}
        title=${archive?.reachable ? 'Local Archive running' : 'Local Archive not running'}>Archives ${archives}</a>
    </div>
    <${Capacity} accounts=${accounts} registry=${registry} />
  </footer>`;
}
