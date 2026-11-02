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
import { loadMachineProfile, machineProfile, otherMachine } from './machine-icons.js';
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

export function DevicePage({ deviceId }) {
  useEffect(() => {
    loadMachineProfile();
  }, []);
  const here = deviceId === 'here';
  const { inventory, tunnel } = useHere(here);
  const other = here ? null : otherMachines().find((m) => m.id === deviceId);
  const name = here ? thisMachineName() : (other?.name ?? 'Another machine');
  const open = threadsOnMachine(deviceId);
  const checkouts = inventory?.checkouts ?? [];
  const go = (section) => (e) => {
    e.preventDefault();
    navigate(settingsPath(null, section));
  };

  return html`<section class="project-home device-page" aria-label=${`${name}: machine page`}>
    <header class="ph-head">
      <h2>${name}</h2>
      <span class="ph-meta">${
        here
          ? html`This machine · <span class="device-status is-on"><i></i>online</span>`
          : other?.online == null
            ? html`Your other machine · <span class="device-status" title="Whether it's online comes from Kingdom (VIEWER-007)"><i></i>status unknown</span>`
            : html`Your other machine · <span class="device-status ${other.online ? 'is-on' : ''}"><i></i>${other.online ? 'online' : 'offline'}</span>`
      }</span>
      <span class="ph-head-actions">
        <button type="button" class="proj-btn" onClick=${() => openMachineBoard(name)}>Its threads on the Board →</button>
        <button type="button" class="proj-btn" onClick=${() => openMachineWatchtower(name)}>Show in the Watchtower →</button>
      </span>
    </header>
    <div class="ph-grid">
      <section class="ph-box ph-threads">
        <h4>Threads on this machine · ${open.length} open</h4>
        ${open.length ? open.map((t) => html`<${ThreadRow} key=${t.threadId} thread=${t} />`) : html`<div class="ph-meta">Nothing open here.</div>`}
      </section>
      <section class="ph-box">
        <h4>Checkouts</h4>
        ${
          here
            ? inventory === undefined
              ? html`<div class="ph-meta">Reading this machine…</div>`
              : checkouts.length
                ? html`<div class="ph-line">${checkouts.map((c) => c.label).join(', ')}</div>
                    <div class="ph-meta">${checkouts.length} registered project${checkouts.length === 1 ? '' : 's'} checked out here</div>`
                : html`<div class="ph-meta">No registered project is checked out here.</div>`
            : other?.checkouts
              ? html`<div class="ph-line">${other.checkouts.map((c) => c.label).join(', ') || 'None'}</div>`
              : html`<${ComingSoon} what="The projects this machine has checked out, from Kingdom." ticket="VIEWER-007" />`
        }
      </section>
      <section class="ph-box">
        <h4>Tunnel</h4>
        ${
          here
            ? html`<div class="ph-line">${tunnel === undefined ? 'Checking…' : tunnel?.active ? `on · ${tunnel.url ?? ''}` : 'off'}</div>
                <div class="ph-meta">Reach this Foundry from your other machines through Kingdom.</div>
                <a class="proj-btn ph-link" href=${settingsPath(null, 'devices')} onClick=${go('devices')}>Settings › Devices →</a>`
            : other?.tunnel
              ? html`<div class="ph-line">${other.tunnel.active ? 'on' : 'off'}</div>`
              : html`<${ComingSoon} what="How this machine reaches your Kingdom, from Kingdom." ticket="VIEWER-007" />`
        }
      </section>
      <section class="ph-box">
        <h4>Subscriptions</h4>
        <div class="ph-line">Shared with your other machines</div>
        <div class="ph-meta">Usage counts against the same logins everywhere; see the footer or Analytics.</div>
        <a class="proj-btn ph-link" href="/analytics" onClick=${(e) => {
          e.preventDefault();
          navigate('/analytics');
        }}>Analytics →</a>
      </section>
    </div>
  </section>`;
}
