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
import { authFetch, kingdomStatus, loadKingdomStatus } from './store.js';

const getJson = (url) =>
  authFetch(url)
    .then((res) => (res.ok ? res.json() : null))
    .catch(() => null);

/** Read once when the footer mounts; the footer is glanceable, not live. */
function useMachine() {
  const [machine, setMachine] = useState({});
  useEffect(() => {
    if (!kingdomStatus.value) loadKingdomStatus();
    let live = true;
    Promise.all([
      getJson('/api/devices'),
      getJson('/api/tunnel'),
      getJson('/api/archives/status'),
      getJson('/api/archives/destinations'),
      getJson('/api/providers/accounts'),
    ]).then(([devices, tunnel, archive, destinations, accounts]) => {
      if (live) setMachine({ devices, tunnel, archive, destinations, accounts });
    });
    return () => {
      live = false;
    };
  }, []);
  return machine;
}

function Capacity({ accounts }) {
  const [shown, setShown] = useState(false);
  const [open, setOpen] = useState(null);
  const groups = capacityByProvider(accounts);
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
                (a, i) => html`<li key=${i} title=${a.issue ?? a.detail}>
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

export function NavFooter() {
  const { devices, tunnel, archive, destinations, accounts } = useMachine();
  const kingdoms = kingdomStatus.value?.integrations?.length ?? 0;
  const archives = (archive?.reachable ? 1 : 0) + (destinations?.libraries?.length ?? 0);
  const deviceName = devices?.device?.name ?? 'This machine';
  const go = (section) => (e) => {
    e.preventDefault();
    navigate(settingsPath(null, section));
  };
  return html`<footer class="nav-footer">
    <div class="nav-footer-line">
      <span class="nav-footer-device" title="This device">${deviceName}</span>
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
    <${Capacity} accounts=${accounts} />
  </footer>`;
}
