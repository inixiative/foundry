/**
 * @atlas
 * @kind component
 * @partOf feature:viewer
 */
/**
 * The rail's Status view: this machine and its resources (Aron, 2026-11-01; a rail view of its own
 * since 2026-11-14, so Attention, Open and Projects keep the rail's full height for threads). The machine's name (this
 * Foundry's name, editable in place; the name opens this machine's page) and its tunnel; Kingdoms
 * and Archives as two equal pills, each linking to its settings; your other machines, each with its
 * open threads and no meters (subscriptions are per login and shared across machines, Aron
 * 2026-11-02); Subscriptions: this machine's Claude and Codex logins per runtime with the balancing
 * scale (subscriptions.js), then any other subscription; then Processes, everything this Foundry runs
 * (machine-processes.js). Threads, Wardens and Forge
 * Master live elsewhere.
 */

import { capacityByProvider } from './capacity.js';
import { ComingSoon } from './coming-soon.js';
import { openThreadsLabel, otherMachines } from './device-page.js';
import { html, useEffect, useState } from './lib.js';
import { DeviceIcon, MachineIconPicker, machineIcon, machineProfile } from './machine-icons.js';
import { MachineProcesses } from './machine-processes.js';
import { RenameModal } from './modal.js';
import { navigate, settingsPath } from './route.js';
import {
  authFetch,
  kingdomStatus,
  loadKingdomStatus,
  modelRegistryOnce,
  openDevicePage,
  showToast,
  vendorName,
} from './store.js';
import { StatusPools, useLoginPools } from './subscriptions.js';
import { harnessName } from './thread-labels.js';

const getJson = (url) =>
  authFetch(url)
    .then((res) => (res.ok ? res.json() : null))
    .catch(() => null);

/** A subscription is a login (a native harness sign-in, a profile, or a Kingdom pool), not an API key. */
const SUBSCRIPTION_SOURCES = new Set(['login', 'profile', 'kingdom', 'gateway']);

/** Read when the Status view opens; it is glanceable, not live. */
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
      if (profile) machineProfile.value = profile;
      if (live) setMachine({ profile, tunnel, archive, destinations, accounts, registry });
    });
    return () => {
      live = false;
    };
  }, []);
  return { ...machine, rename };
}

/** One row that opens to every subscription, grouped by the provider that sells it. */
const LIMITS_EVERY_MS = 5 * 60_000;

/** Each subscription login's usage windows (`/api/providers/limits`), re-read every few minutes. */
function useLimits() {
  const [limits, setLimits] = useState([]);
  useEffect(() => {
    let live = true;
    const read = () =>
      authFetch('/api/providers/limits')
        .then((res) => (res.ok ? res.json() : null))
        .then((body) => live && body && setLimits(body.limits ?? []))
        .catch(() => {});
    read();
    const timer = setInterval(read, LIMITS_EVERY_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);
  return limits;
}

/** "5h", "7d": a window's length, from its minutes, else its id. */
const windowLabel = (w) =>
  w.windowMinutes
    ? w.windowMinutes < 1440
      ? `${Math.round(w.windowMinutes / 60)}h`
      : `${Math.round(w.windowMinutes / 1440)}d`
    : w.id.replace(/_/g, ' ');

const resets = (w) =>
  w.resetsAt
    ? ` · resets ${new Date(w.resetsAt).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`
    : '';

/** One login's windows as meters: "5h ▬ 7%". */
function LimitMeters({ limit }) {
  if (!limit) return null;
  if (limit.state === 'kingdom')
    return html`<span class="machine-status-limits rp-dim" title="This subscription is a Kingdom pool; Kingdom reports its limits">pool limits in Kingdom</span>`;
  const windows = limit.snapshot?.windows ?? [];
  if (limit.state !== 'probed' || !windows.length)
    return html`<span class="machine-status-limits rp-dim" title="The CLI didn't report its usage windows">limits unavailable</span>`;
  const plan = limit.snapshot.plan ? `${limit.snapshot.plan} plan · ` : '';
  return html`<span class="machine-status-limits${limit.snapshot.blocked ? ' is-blocked' : ''}">${windows.map(
    (
      w,
    ) => html`<span key=${w.id} class="meterlbl" title=${`${plan}${windowLabel(w)} window used${resets(w)}`}>
      ${windowLabel(w)} <span class="bar2"><i style=${`width:${Math.min(100, w.usedPercent)}%`}></i></span>${Math.round(w.usedPercent)}%
    </span>`,
  )}</span>`;
}

/** Accounts whose subscription is one of this machine's pooled logins (shown by `StatusPools`). */
const POOLED = new Set(['claude-code', 'codex']);

function Subscriptions({ accounts, registry }) {
  const [open, setOpen] = useState({});
  const limits = useLimits();
  const pools = useLoginPools();
  const pooled = new Set(
    (pools?.pools ?? []).map((p) => (p.runtime === 'claude' ? 'claude-code' : 'codex')),
  );
  const limitOf = (provider) => limits.find((l) => l.provider === provider);
  // Claude Code and Codex logins show as their pools (scale, logins, meters); the rest as before.
  const subscriptions = (Array.isArray(accounts) ? accounts : []).filter(
    (a) =>
      SUBSCRIPTION_SOURCES.has(a.source) && !(POOLED.has(a.provider) && pooled.has(a.provider)),
  );
  const groups = capacityByProvider(subscriptions, (provider) => vendorName(provider, registry));
  if (!groups.length && !pools?.pools?.length && !pools?.kingdom?.length) return null;
  return html`<div class="machine-status-subscriptions">
    <div class="machine-status-label">Subscriptions</div>
    <${StatusPools} />
    ${groups.map((g) => {
      const isOpen = !!open[g.provider];
      const total = g.accounts.length;
      return html`<div key=${g.provider} class="machine-status-provider">
        <button type="button" class="machine-status-row" aria-expanded=${isOpen}
          onClick=${() => setOpen({ ...open, [g.provider]: !isOpen })}
          title=${`${g.provider}: ${g.ready} of ${total} subscription${total === 1 ? '' : 's'} ready`}>
          <span class="machine-status-caret">${isOpen ? '▾' : '▸'}</span>
          <span class="machine-status-name">${g.provider}</span>
          <span class="machine-status-dot ${g.ready === total ? 'is-ok' : 'is-warn'}"></span>
          <span class="machine-status-count">${g.ready}/${total} ready</span>
        </button>
        ${g.accounts.map((a, i) => html`<${LimitMeters} key=${`${g.provider}:limits:${i}`} limit=${limitOf(a.provider)} />`)}
        ${
          isOpen
            ? html`<ul class="machine-status-subs">${g.accounts.map(
                (a, i) => html`<li key=${`${g.provider}:${i}`}
                  title=${[a.issue, harnessName(a.provider) ? `through ${harnessName(a.provider)}` : null].filter(Boolean).join(' · ')}>
                  <span class="machine-status-dot ${a.ready ? 'is-ok' : 'is-warn'}"></span>
                  <span class="machine-status-sub-name">${a.detail}</span>
                </li>`,
              )}</ul>`
            : null
        }
      </div>`;
    })}
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
      machineProfile.value = { ...machineProfile.value, installationName: next };
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
          }}><${MachineIconPicker} /><//>`
      : null;
  return html`<${DeviceIcon} icon=${machineIcon()} size=${16} title="This machine's icon" /><button type="button" class="machine-status-device" title="Open this machine's page" onClick=${() => openDevicePage('here')}>${name}</button>
    <button type="button" class="machine-status-edit" title="Rename this machine" onClick=${() => setDraft(name)}>Edit</button>${modal}`;
}

/** Your other machines: each opens its page; listed with its open threads, never metered. */
function OtherMachines() {
  const machines = otherMachines();
  return html`<div class="machine-status-others">
    <div class="machine-status-label">Your other devices</div>
    ${machines.map(
      (
        m,
      ) => html`<button key=${m.id} type="button" class="machine-status-row machine-status-other" onClick=${() => openDevicePage(m.id)}
        title=${`Open ${m.name}'s page. It uses the same subscriptions as this machine.`}>
        <span class="machine-status-name">${m.name}</span>
        <span class=${`machine-status-dot ${m.online ? 'is-ok' : ''}`} title=${m.online == null ? "Whether it's online: coming soon" : m.online ? 'Online' : 'Offline'}></span>
        <span class="machine-status-count">${openThreadsLabel(m.open)}</span>
      </button>`,
    )}
    <${ComingSoon} inline=${true} what=${machines.length ? 'Whether each is online' : 'Your other machines'} ticket="VIEWER-007" />
  </div>`;
}

export function MachineStatus() {
  const { profile, tunnel, archive, destinations, accounts, registry, rename } = useMachine();
  const kingdoms = kingdomStatus.value?.integrations?.length ?? 0;
  const archives = (archive?.reachable ? 1 : 0) + (destinations?.libraries?.length ?? 0);
  const go = (section) => (e) => {
    e.preventDefault();
    navigate(settingsPath(null, section));
  };
  return html`<section class="machine-status" aria-label="Status">
    <div class="machine-status-label">This machine</div>
    <div class="machine-status-line machine-status-machine">
      <${MachineName} profile=${profile} onSaved=${rename} />
      ${
        tunnel
          ? html`<a class="machine-status-link" href=${settingsPath(null, 'devices')} onClick=${go('devices')}
              title=${tunnel.active ? `Tunnel on: ${tunnel.url ?? ''}` : `Tunnel off (${tunnel.mode})`}>
              <span class="machine-status-dot ${tunnel.active ? 'is-ok' : 'is-off'}"></span>tunnel ${tunnel.active ? 'on' : 'off'}
            </a>`
          : null
      }
    </div>
    <div class="machine-status-label">Connections</div>
    <div class="machine-status-pills">
      <a class="machine-status-pill" href=${settingsPath(null, 'kingdom')} onClick=${go('kingdom')}>Kingdoms <b>${kingdoms}</b></a>
      <a class="machine-status-pill" href=${settingsPath(null, 'archive')} onClick=${go('archive')}
        title=${archive?.reachable ? 'Local Archive running' : 'Local Archive not running'}>Archives <b>${archives}</b></a>
    </div>
    <${OtherMachines} />
    <${Subscriptions} accounts=${accounts} registry=${registry} />
    <${MachineProcesses} />
  </section>`;
}
