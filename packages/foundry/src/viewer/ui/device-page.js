/**
 * @atlas
 * @kind component
 * @partOf feature:viewer, feature:devices
 */
/**
 * A machine's page, laid out like a project's home (Aron, 2026-11-02): its open threads, its
 * checkouts, its tunnel, and a note that subscriptions are shared across machines (quota belongs to
 * the login, never to a machine). It leads to the machine's threads on the Board or in the
 * Watchtower, each opened with a removable Machine filter. This machine reads its own inventory
 * (`/api/devices`, `/api/tunnel`). Everything about your other machines comes through one function,
 * `otherMachines()`: today it knows a machine only from threads that carry its `meta.machine`; it
 * switches to the Signet Foundry holds from Kingdom (an entitlement anchored at your user: read
 * online, read tunnel, ...) once Kingdom serves that call (VIEWER-007).
 */

import { ComingSoon } from './coming-soon.js';
import { html, useEffect, useState } from './lib.js';
import {
  DeviceIcon,
  loadMachineProfile,
  machineIcon,
  machineProfile,
  otherMachine,
} from './machine-icons.js';
import { navigate, settingsPath } from './route.js';
import { settingsConfig } from './settings.js';
import { STATES, StatusIcon } from './status-icons.js';
import {
  allThreads,
  authFetch,
  openMachineBoard,
  openMachineWatchtower,
  projects,
  selectThread,
  threadStatusOf,
} from './store.js';
import { threadName } from './thread-labels.js';
import { isClosedThread, subagentParentOf } from './thread-status.js';

const getJson = (url) =>
  authFetch(url)
    .then((res) => (res.ok ? res.json() : null))
    .catch(() => null);

/** This machine's name: its Foundry's name, as the footer and the Board show it. */
export const thisMachineName = () =>
  machineProfile.value?.installationName ??
  settingsConfig.value?.installationName ??
  'This machine';

/** Open top-level threads on a machine ('here' = this one). */
export function threadsOnMachine(deviceId) {
  return allThreads.value.filter((t) => {
    if (subagentParentOf(t.meta) || isClosedThread(t)) return false;
    const other = otherMachine(t);
    return deviceId === 'here' ? !other : other?.deviceId === deviceId;
  });
}

/**
 * Your other machines: { id, name, open, online, checkouts, tunnel }. The one place their data comes
 * from. `online`, `checkouts` and `tunnel` are null until Kingdom serves them through Foundry's
 * Signet (VIEWER-007); every surface shows "Coming soon" for a null.
 */
export function otherMachines() {
  const seen = new Map();
  for (const t of allThreads.value) {
    const m = otherMachine(t);
    if (m && !seen.has(m.deviceId)) seen.set(m.deviceId, { id: m.deviceId, name: m.deviceName });
  }
  return [...seen.values()].map((m) => ({
    ...m,
    open: threadsOnMachine(m.id).length,
    online: null,
    checkouts: null,
    tunnel: null,
  }));
}

export const openThreadsLabel = (n) => `${n} open thread${n === 1 ? '' : 's'}`;

function ThreadRow({ thread }) {
  const state = threadStatusOf(thread.threadId);
  const project = projects.value.find((p) => p.id === thread.meta?.projectId);
  return html`<button type="button" class="ph-row" onClick=${() => selectThread(thread.threadId)}>
    <${StatusIcon} state=${state} still=${true} />
    <span class="ph-row-name">${threadName(thread)}</span>
    <span class="ph-row-state">${STATES[state]?.label ?? state}</span>
    <span class="ph-row-who">${project?.label ?? (thread.meta?.projectId ? thread.meta.projectId : 'Global')}</span>
  </button>`;
}

function useHere(here) {
  const [inventory, setInventory] = useState(undefined);
  const [tunnel, setTunnel] = useState(undefined);
  useEffect(() => {
    if (!here) return;
    let live = true;
    getJson('/api/devices').then((body) => live && setInventory(body));
    getJson('/api/tunnel').then((body) => live && setTunnel(body));
    return () => {
      live = false;
    };
  }, [here]);
  return { inventory, tunnel };
}

/** A status pill in the band: a dot, then what it says. */
function Pill({ on, title, children }) {
  return html`<span class="dp-pill ${on === true ? 'is-on' : on === false ? 'is-off' : ''}" title=${title}><i></i>${children}</span>`;
}

/**
 * The machine page, as redesigned in concept-v4 (Aron 11-02): an icon band with live status pills
 * and its two links as buttons, then what's open on it, its worktrees, what your Signet grants on it,
 * its checkouts and the subscriptions it shares. This machine reads its own inventory; another reads
 * `otherMachines()`, which fills from Kingdom's device operations (VIEWER-007) once they ship.
 */
export function DevicePage({ deviceId }) {
  useEffect(() => {
    loadMachineProfile();
  }, []);
  const here = deviceId === 'here';
  const { inventory, tunnel } = useHere(here);
  const other = here ? null : otherMachines().find((m) => m.id === deviceId);
  const name = here ? thisMachineName() : (other?.name ?? 'Another machine');
  const open = threadsOnMachine(deviceId);
  const inWorktrees = open.filter((t) => t.meta?.context?.checkout).length;
  const checkouts = inventory?.checkouts ?? [];
  const openIn = (projectId) =>
    open.filter((t) => (t.meta?.projectId ?? null) === projectId).length;
  const go = (section) => (e) => {
    e.preventDefault();
    navigate(settingsPath(null, section));
  };
  const online = here ? true : (other?.online ?? null);
  const tunnelOn = here ? (tunnel ? !!tunnel.active : null) : (other?.tunnel?.active ?? null);

  return html`<section class="project-home device-page" aria-label=${`${name}: machine page`}>
    <header class="dp-band">
      <span class="dp-icon"><${DeviceIcon} icon=${here ? machineIcon() : undefined} size=${44} /></span>
      <span class="dp-id">
        <span class="dp-eyebrow">${here ? 'This machine' : 'Your other device'}</span>
        <h2>${name}</h2>
        <span class="dp-pills">
          <${Pill} on=${online} title=${online == null ? "Whether it's online: coming soon" : null}>${online == null ? 'Status unknown' : online ? (here ? 'Online · this Foundry' : 'Online') : 'Offline'}</${Pill}>
          <${Pill} on=${tunnelOn} title=${tunnelOn == null ? 'Whether its tunnel is on: coming soon' : null}>${tunnelOn == null ? 'Tunnel unknown' : tunnelOn ? 'Tunnel on' : 'Tunnel off'}</${Pill}>
          <${Pill}>${open.length} open${here ? ` · ${inWorktrees} in worktrees` : ''}</${Pill}>
        </span>
      </span>
      <span class="dp-actions">
        <button type="button" class="proj-btn is-go" onClick=${() => openMachineBoard(name)}>Its threads on the Board →</button>
        <button type="button" class="proj-btn" onClick=${() => openMachineWatchtower(name)}>Show in the Watchtower →</button>
      </span>
    </header>
    <div class="ph-grid dp-grid">
      <section class="ph-box ph-threads">
        <h4>Open on it now · ${open.length}</h4>
        ${open.length ? open.map((t) => html`<${ThreadRow} key=${t.threadId} thread=${t} />`) : html`<div class="ph-meta">Nothing open here.</div>`}
      </section>
      <section class="ph-box">
        <h4>Worktree slots</h4>
        ${
          here
            ? html`<div class="ph-line">${inWorktrees} open thread${inWorktrees === 1 ? '' : 's'} in a worktree</div>`
            : null
        }
        <${ComingSoon} what="Each slot (its ports, database and Redis) and which thread holds it." />
      </section>
      ${
        here
          ? null
          : html`<section class="ph-box">
              <h4>Through your Signet</h4>
              <${ComingSoon} what="What your Signet lets this Foundry do on it (read online, read tunnel, …), and a request to the owner for more." ticket="VIEWER-007" />
            </section>`
      }
      <section class="ph-box">
        <h4>Checkouts${here && inventory ? ` · ${checkouts.length}` : ''}</h4>
        ${
          here
            ? inventory === undefined
              ? html`<div class="ph-meta">Reading this machine…</div>`
              : checkouts.length
                ? checkouts.map(
                    (c) =>
                      html`<div key=${c.id} class="dp-checkout"><span class="mono" title=${c.path}>${c.label}</span><span class="ph-meta">${openIn(c.projectId) ? `${openIn(c.projectId)} open` : '—'}</span></div>`,
                  )
                : html`<div class="ph-meta">No registered project is checked out here.</div>`
            : html`<${ComingSoon} inline=${true} what="Its checkouts, and which thread holds each." ticket="VIEWER-007" />`
        }
      </section>
      ${
        here
          ? html`<section class="ph-box">
              <h4>Tunnel</h4>
              <div class="ph-line">${tunnel === undefined ? 'Checking…' : tunnel?.active ? `on · ${tunnel.url ?? ''}` : 'off'}</div>
              <div class="ph-meta">Reach this Foundry from your other machines through Kingdom.</div>
              <a class="proj-btn ph-link" href=${settingsPath(null, 'devices')} onClick=${go('devices')}>Settings › Devices →</a>
            </section>`
          : null
      }
      <section class="ph-box">
        <h4>Subscriptions</h4>
        <div class="ph-line">Shared with ${here ? 'your other machines' : 'this machine'}</div>
        <div class="ph-meta">The same logins everywhere; usage counts once. See the footer or Analytics.</div>
      </section>
    </div>
  </section>`;
}
