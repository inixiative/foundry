/**
 * @atlas
 * @kind component
 * @partOf feature:viewer, feature:nativeAuth
 */
/**
 * This machine's subscription logins and their balancing (Aron, 2026-11-02: "Maybe under
 * subscriptions we should have a balancing toggle, maybe like a scale… where it's balancing and/or
 * where it stopped"). One record, `/api/providers/pools`, read by the rail footer, Settings ›
 * Providers and Analytics: per runtime, whether it balances across how many logins or why it
 * stopped, and each login's status, meters and turns in the last five hours. The scale toggles the
 * load balancer: balanced ↔ pinned to one login.
 */

import { html, signal, useEffect, useState } from './lib.js';
import { authFetch, showToast } from './store.js';

export const loginPools = signal(null);
const listeners = new Set();
let timer = null;
let inFlight = null;
const POOLS_EVERY_MS = 60_000;

const json = async (res) => {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Error(body?.error || 'Request failed');
  return body;
};

/** Reads the pools now (readings refresh on the daemon when stale; no model call). */
export function readPools() {
  inFlight ??= authFetch('/api/providers/pools')
    .then(json)
    .then((body) => {
      loginPools.value = body;
      return body;
    })
    .catch(() => null)
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/** The pools, re-read every minute while anything shows them. */
export function useLoginPools() {
  const [, tick] = useState(0);
  useEffect(() => {
    const listener = () => tick((n) => n + 1);
    listeners.add(listener);
    if (!loginPools.value) readPools();
    timer ??= setInterval(readPools, POOLS_EVERY_MS);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) {
        clearInterval(timer);
        timer = null;
      }
    };
  }, []);
  return loginPools.value;
}

export const RUNTIME_LABEL = { claude: 'Claude', codex: 'Codex' };
const ROUTING_LABEL = {
  'quartile-balanced': 'least used first',
  'owner-first': 'preferred login first',
  'priority-balanced': 'in the order added',
  pinned: 'pinned to one login',
};
const STATUS_LABEL = {
  ready: 'Ready',
  'signing-in': 'Signing in',
  expired: 'Needs signing in again',
  exhausted: 'Exhausted for now',
};
const STATUS_TONE = {
  ready: 'is-ok',
  'signing-in': 'is-busy',
  expired: 'is-bad',
  exhausted: 'is-warn',
};

/** "Balancing across 3 logins" or why it stopped, in a few words. */
export function balancingText(pool) {
  const b = pool.balancing;
  if (b.state === 'balanced')
    return `Balancing across ${b.across} logins${b.by === 'turns' ? ' by turns (a login reports no usage)' : ''}`;
  if (b.reason === 'pinned') return `Stopped: pinned to ${b.on ?? 'one login'}`;
  if (b.reason === 'one-login') return b.on ? `One login: ${b.on}` : 'No login yet';
  if (b.reason === 'one-left')
    return `Stopped: only ${b.on} can serve; the others are exhausted or signed out`;
  return 'Stopped: every login is exhausted or signed out';
}

/** The scale: tilted when balancing is stopped, level when balanced. */
function ScaleIcon({ on }) {
  return html`<svg class=${`scale-icon${on ? ' is-on' : ''}`} viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
    <path d="M8 2.2v11.2M5 13.6h6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" fill="none"/>
    <g transform=${on ? '' : 'rotate(-12 8 4)'}>
      <path d="M2.4 4.2h11.2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" fill="none"/>
      <path d="M1.2 8.6 3.4 4.4 5.6 8.6Z M10.4 8.6 12.6 4.4 14.8 8.6Z" fill="currentColor" opacity=".85"/>
    </g>
  </svg>`;
}

async function savePool(runtime, patch, project) {
  try {
    await json(
      await authFetch(`/api/providers/pools/${runtime}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...patch, ...(project ? { project } : {}) }),
      }),
    );
    await readPools();
  } catch (error) {
    showToast(error.message, 'error');
  }
}

/** Toggles the load balancer: balanced ↔ pinned to the preferred login (or the one most recently used). */
export function toggleBalancing(pool) {
  if (pool.routing === 'pinned') return savePool(pool.runtime, { routing: null });
  const on = pool.preferredLoginId ?? pool.lastRuns[0]?.loginId ?? pool.logins[0]?.id;
  return savePool(pool.runtime, { routing: 'pinned', preferredLoginId: on });
}

/** The scale button: one click toggles the load balancer. */
export function ScaleButton({ pool }) {
  const several = pool.logins.filter((l) => l.status !== 'signing-in').length > 1;
  const on = pool.routing !== 'pinned';
  const title = several
    ? `${balancingText(pool)}. Click to ${on ? 'turn balancing off (pin to one login)' : 'balance across every login'}.`
    : 'Add another login to balance across them (Settings › Providers)';
  return html`<button type="button" class=${`scale-btn${pool.balancing.state === 'balanced' ? ' is-balanced' : ''}`}
    aria-pressed=${on} aria-label=${`Load balancer for ${RUNTIME_LABEL[pool.runtime]}: ${on ? 'on' : 'off'}`}
    disabled=${!several} title=${title} onClick=${() => toggleBalancing(pool)}>
    <${ScaleIcon} on=${pool.balancing.state === 'balanced'} />
  </button>`;
}

const windowLabel = (w) =>
  w.windowMinutes
    ? w.windowMinutes < 1440
      ? `${Math.round(w.windowMinutes / 60)}h`
      : `${Math.round(w.windowMinutes / 1440)}d`
    : w.id.replace(/_/g, ' ');

/** One login's windows as meters: "5h ▬ 7%". */
export function LoginMeters({ limits }) {
  const windows = limits?.windows ?? [];
  if (!windows.length)
    return html`<span class="nav-footer-limits rp-dim" title="This login hasn't reported its usage windows yet">no reading yet</span>`;
  return html`<span class=${`nav-footer-limits${limits.blocked ? ' is-blocked' : ''}`}>${windows.map(
    (
      w,
    ) => html`<span key=${w.id} class="meterlbl" title=${`${windowLabel(w)} window used${w.resetsAt ? ` · resets ${new Date(w.resetsAt).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}` : ''}`}>
      ${windowLabel(w)} <span class="bar2"><i style=${`width:${Math.min(100, w.usedPercent)}%`}></i></span>${Math.round(w.usedPercent)}%
    </span>`,
  )}</span>`;
}

/** "Last runs: inixiative, personal, inixiative…" */
export function LastRuns({ pool, limit = 6 }) {
  const runs = pool.lastRuns.slice(0, limit);
  if (!runs.length) return html`<div class="pool-last rp-dim">No turns on these logins yet</div>`;
  return html`<div class="pool-last" title=${runs.map((r) => `${new Date(r.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} ${r.name} (${r.why})`).join('\n')}>
    Last runs: ${runs.map((r) => r.name).join(', ')}${pool.lastRuns.length > limit ? '…' : ''}
  </div>`;
}

/** A login row: status dot, name, its meters and the turns it served in the last five hours. */
export function LoginRow({ login }) {
  return html`<li class="pool-login" data-status=${login.status}>
    <div class="pool-login-head" title=${[STATUS_LABEL[login.status], login.issue].filter(Boolean).join(' · ')}>
      <span class=${`nav-footer-dot ${STATUS_TONE[login.status]}`}></span>
      <span class="pool-login-name">${login.name}${login.preferred ? html` <span class="pool-pref" title="The preferred login">★</span>` : null}</span>
      <span class="pool-login-runs" title="Turns it served in the last five hours">${login.runs} in 5h</span>
    </div>
    ${login.status === 'signing-in' ? null : html`<${LoginMeters} limits=${login.limits} />`}
  </li>`;
}

/** Kingdom-pool projects: Kingdom balances those; its balancing state isn't shown here yet. */
export function KingdomPools({ kingdom }) {
  if (!kingdom?.length) return null;
  return html`<div class="pool-kingdom">
    <span>${kingdom.length === 1 ? kingdom[0].name : `${kingdom.length} projects`} on a Kingdom pool</span>
    <a class="coming-soon is-link" href=${KINGDOM_TICKET} target="_blank" rel="noreferrer"
      title="Kingdom balances its pool's logins; showing its balancing here is planned (Kingdom ticket)">Coming soon</a>
  </div>`;
}
export const KINGDOM_TICKET =
  'https://github.com/inixiative/kingdom/blob/main/tickets/FEAT-024-effort-budgets.md';

/** The footer's Subscriptions block for this machine's logins: per runtime, the scale and each login. */
export function FooterPools() {
  const data = useLoginPools();
  const [open, setOpen] = useState({});
  if (!data) return null;
  return html`${data.pools.map((pool) => {
    const isOpen = !!open[pool.runtime];
    return html`<div key=${pool.runtime} class="nav-footer-provider pool">
      <div class="pool-head">
        <button type="button" class="nav-footer-row" aria-expanded=${isOpen}
          onClick=${() => setOpen({ ...open, [pool.runtime]: !isOpen })}>
          <span class="nav-footer-caret">${isOpen ? '▾' : '▸'}</span>
          <span class="nav-footer-name">${RUNTIME_LABEL[pool.runtime]}</span>
          <span class="nav-footer-count">${pool.logins.filter((l) => l.status === 'ready').length}/${pool.logins.length} ready</span>
        </button>
        <${ScaleButton} pool=${pool} />
      </div>
      <div class=${`pool-balancing is-${pool.balancing.state}`}>${balancingText(pool)}</div>
      ${
        isOpen
          ? html`<ul class="pool-logins">${pool.logins.map((l) => html`<${LoginRow} key=${l.id} login=${l} />`)}</ul>
            <${LastRuns} pool=${pool} limit=${4} />`
          : null
      }
    </div>`;
  })}
  <${KingdomPools} kingdom=${data.kingdom} />`;
}

/** Settings › Providers: the logins of each runtime, balancing, adding, naming and removing. */
export function ProviderLogins() {
  const data = useLoginPools();
  if (!data) return html`<div class="settings-empty">Loading logins…</div>`;
  return html`<section class="settings-card login-pools" data-setting="subscriptionPools">
    <h3 class="settings-card-title">Subscription logins</h3>
    <p class="settings-desc">Each login is one subscription, signed in with its own CLI in its own home. With several logins of one runtime, Foundry balances new threads across them by their 5-hour and 7-day usage; a thread stays on its login while that login can serve. The scale turns balancing off (everything runs on the pinned login) and on.</p>
    ${data.pools.map((pool) => html`<${PoolCard} key=${pool.runtime} pool=${pool} setups=${data.setups} />`)}
    ${data.pools.length ? null : html`<p class="settings-desc">No subscription runtime runs on this machine's logins (API keys are on).</p>`}
    <${KingdomPools} kingdom=${data.kingdom} />
  </section>`;
}

function PoolCard({ pool, setups }) {
  const ready = pool.logins.filter((l) => l.status !== 'signing-in');
  const setup = setups.find(
    (s) => s.runtime === pool.runtime && !['done', 'cancelled'].includes(s.state),
  );
  return html`<div class="pool-card" data-runtime=${pool.runtime}>
    <div class="pool-card-head">
      <${ScaleButton} pool=${pool} />
      <strong>${RUNTIME_LABEL[pool.runtime]}</strong>
      <span class=${`pool-balancing is-${pool.balancing.state}`}>${balancingText(pool)}</span>
    </div>
    <div class="pool-controls">
      <label>Balancing
        <select value=${pool.routing} onChange=${(e) => savePool(pool.runtime, { routing: e.target.value === 'quartile-balanced' ? null : e.target.value })}>
          ${Object.entries(ROUTING_LABEL).map(([value, label]) => html`<option key=${value} value=${value}>${label}</option>`)}
        </select>
      </label>
      ${
        ready.length > 1
          ? html`<label>Preferred login
              <select value=${pool.preferredLoginId ?? ''} onChange=${(e) => savePool(pool.runtime, { preferredLoginId: e.target.value || null })}>
                ${ready.map((l) => html`<option key=${l.id} value=${l.id}>${l.name}</option>`)}
              </select>
            </label>`
          : null
      }
      ${pool.from === 'project' ? html`<span class="settings-desc">This project sets its own balancing.</span>` : null}
    </div>
    <table class="settings-table pool-table">
      <thead><tr><th>Login</th><th>Status</th><th>Usage</th><th>Turns (5h)</th><th></th></tr></thead>
      <tbody>${pool.logins.map((l) => html`<${LoginTableRow} key=${l.id} login=${l} />`)}</tbody>
    </table>
    <${LastRuns} pool=${pool} limit=${10} />
    ${setup ? html`<${SignIn} setup=${setup} />` : html`<${AddLogin} runtime=${pool.runtime} />`}
  </div>`;
}

function LoginTableRow({ login }) {
  const [name, setName] = useState(null);
  const rename = async () => {
    const next = name?.trim();
    setName(null);
    if (!next || next === login.name) return;
    try {
      await json(
        await authFetch(`/api/providers/logins/${login.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: next }),
        }),
      );
      await readPools();
    } catch (error) {
      showToast(error.message, 'error');
    }
  };
  const remove = async () => {
    const what = login.own
      ? `Forget ${login.name}? Foundry stops using this machine's own login; the login itself stays.`
      : `Remove ${login.name}? Its sign-in is deleted from this machine.`;
    if (!confirm(what)) return;
    try {
      await json(await authFetch(`/api/providers/logins/${login.id}`, { method: 'DELETE' }));
      await readPools();
    } catch (error) {
      showToast(error.message, 'error');
    }
  };
  if (login.status === 'signing-in')
    return html`<tr data-status="signing-in"><td>${login.name}</td><td><span class="nav-footer-dot is-busy"></span> Signing in</td><td colspan="3"></td></tr>`;
  return html`<tr data-status=${login.status}>
    <td>${
      name === null
        ? html`<span>${login.name}</span>${login.preferred ? html` <span class="pool-pref" title="The preferred login">★</span>` : null}`
        : html`<input class="settings-input small" value=${name} maxlength="40" aria-label="Login name"
            onInput=${(e) => setName(e.target.value)} onKeyDown=${(e) => e.key === 'Enter' && rename()} onBlur=${rename} />`
    }</td>
    <td title=${login.issue ?? ''}><span class=${`nav-footer-dot ${STATUS_TONE[login.status]}`}></span> ${STATUS_LABEL[login.status]}</td>
    <td><${LoginMeters} limits=${login.limits} /></td>
    <td>${login.runs}</td>
    <td class="pool-actions">
      <button class="action-btn subtle" onClick=${() => setName(login.name)}>Name</button>
      <button class="action-btn subtle" onClick=${remove}>${login.own ? 'Forget' : 'Remove'}</button>
    </td>
  </tr>`;
}

function AddLogin({ runtime }) {
  const [name, setName] = useState('');
  const start = async () => {
    try {
      await json(
        await authFetch('/api/providers/logins', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ runtime, name: name.trim() }),
        }),
      );
      setName('');
      await readPools();
    } catch (error) {
      showToast(error.message, 'error');
    }
  };
  return html`<div class="pool-add">
    <input class="settings-input small" placeholder="Name it (inixiative, personal, work…)" value=${name} maxlength="40"
      aria-label=${`New ${RUNTIME_LABEL[runtime]} login name`} onInput=${(e) => setName(e.target.value)}
      onKeyDown=${(e) => e.key === 'Enter' && name.trim() && start()} />
    <button class="action-btn" disabled=${!name.trim()} onClick=${start}>Add a ${RUNTIME_LABEL[runtime]} login</button>
  </div>`;
}

/** A sign-in in progress: the page to open, the code box when the CLI asks, and its output. */
function SignIn({ setup }) {
  const [view, setView] = useState(setup);
  const [code, setCode] = useState('');
  useEffect(() => {
    let live = true;
    const poll = async () => {
      const next = await authFetch(`/api/providers/logins/setup/${setup.id}`)
        .then(json)
        .catch(() => null);
      if (!live || !next) return;
      setView(next);
      if (['done', 'failed', 'cancelled'].includes(next.state)) {
        readPools();
        if (next.state === 'done') showToast(`${next.name} is signed in`, 'ok');
        return;
      }
      setTimeout(poll, 1_000);
    };
    poll();
    return () => {
      live = false;
    };
  }, [setup.id]);
  const send = async () => {
    try {
      await json(
        await authFetch(`/api/providers/logins/setup/${setup.id}/code`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code }),
        }),
      );
      setCode('');
    } catch (error) {
      showToast(error.message, 'error');
    }
  };
  const cancel = async () => {
    await authFetch(`/api/providers/logins/setup/${setup.id}`, { method: 'DELETE' }).catch(
      () => {},
    );
    readPools();
  };
  return html`<div class="pool-signin" data-state=${view.state}>
    <div><strong>Signing in “${view.name}”.</strong> ${
      view.state === 'failed'
        ? html`<span role="alert">${view.error}</span>`
        : view.url
          ? html`Your browser should open Anthropic's sign-in. Sign in with the account for this subscription. If it didn't open, <a href=${view.url} target="_blank" rel="noreferrer">open the sign-in page</a>.`
          : 'Starting the sign-in…'
    }</div>
    ${
      view.wantsCode || view.url
        ? html`<div class="pool-add">
            <input class="settings-input small mono" placeholder="Paste the code the page shows, if it asks" value=${code}
              aria-label="Sign-in code" onInput=${(e) => setCode(e.target.value)} onKeyDown=${(e) => e.key === 'Enter' && code.trim() && send()} />
            <button class="action-btn" disabled=${!code.trim()} onClick=${send}>Send code</button>
          </div>`
        : null
    }
    <details><summary>Sign-in output</summary><pre class="pool-output">${view.output}</pre></details>
    <button class="action-btn subtle" onClick=${cancel}>${view.state === 'failed' ? 'Dismiss' : 'Cancel'}</button>
  </div>`;
}
