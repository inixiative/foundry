/**
 * @atlas
 * @kind component
 * @partOf feature:usage, feature:viewer
 */
/**
 * Analytics, as designed in concept-v4 (design review 11-02): the headline tiles, the capacity band
 * first (each subscription login's 5-hour and 7-day windows, the same record the footer reads, never
 * per machine), and tokens over a chosen range. They read what Foundry already records:
 * `/api/providers/limits` (with `/api/providers/accounts` for each login's name) and
 * `/api/analytics/timeseries`. What Foundry doesn't record yet (run-out, tokens by spender, the
 * chorus's cost against its value, corrections that came back) shows as "Coming soon".
 */

import { ComingSoon } from './coming-soon.js';
import { html, signal, useEffect, useState } from './lib.js';
import { authFetch, vendorName } from './store.js';

const getJson = (url) =>
  authFetch(url)
    .then((res) => (res.ok ? res.json() : null))
    .catch(() => null);

/** The range every Analytics chart reads: [id, label, period, how far back]. */
export const RANGES = [
  ['window', 'This 5h window', 'hourly', 5 * 3_600_000],
  ['today', 'Today', 'hourly', null],
  ['week', '7 days', 'daily', 7 * 86_400_000],
  ['month', '30 days', 'daily', 30 * 86_400_000],
];
export const analyticsRange = signal('week');

/** Where the chosen range starts (today: local midnight). */
export function rangeSince(id, now = Date.now()) {
  const range = RANGES.find(([r]) => r === id) ?? RANGES[2];
  if (range[3]) return now - range[3];
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  return midnight.getTime();
}

export function RangeControl() {
  const value = analyticsRange.value;
  return html`<span class="an-range" role="group" aria-label="Range">
    ${RANGES.map(
      ([id, label]) => html`<button key=${id} type="button" aria-pressed=${value === id}
        onClick=${() => {
          analyticsRange.value = id;
        }}>${label}</button>`,
    )}
  </span>`;
}

const SUBSCRIPTION_SOURCES = new Set(['login', 'profile', 'kingdom', 'gateway']);

/** Each subscription login with its usage windows: { name, provider, limit }. */
export function useLogins() {
  const [logins, setLogins] = useState(undefined);
  useEffect(() => {
    let live = true;
    Promise.all([getJson('/api/providers/accounts'), getJson('/api/providers/limits')]).then(
      ([accounts, limits]) => {
        if (!live) return;
        const subs = (Array.isArray(accounts) ? accounts : []).filter((a) =>
          SUBSCRIPTION_SOURCES.has(a.source),
        );
        const left = [...(limits?.limits ?? [])];
        // The limits come back in the accounts' order, one per subscription login of a worker.
        setLogins(
          subs.map((a) => {
            const at = left.findIndex((l) => l.provider === a.provider);
            const limit = at >= 0 ? left.splice(at, 1)[0] : null;
            return { name: a.detail || a.provider, provider: a.provider, limit };
          }),
        );
      },
    );
    return () => {
      live = false;
    };
  }, []);
  return logins;
}

const windowOf = (limit, minutes) =>
  limit?.snapshot?.windows?.find((w) =>
    minutes < 1440 ? (w.windowMinutes ?? 0) < 1440 : (w.windowMinutes ?? 0) >= 1440,
  ) ?? null;

function resetsIn(at) {
  if (!at) return null;
  const minutes = Math.max(0, Math.round((new Date(at).getTime() - Date.now()) / 60_000));
  if (minutes < 60) return `${minutes} m`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} m`;
}

function Meter({ label, window }) {
  if (!window) return html`<span class="an-meter is-none">${label} <i>not reported</i></span>`;
  const used = Math.round(window.usedPercent);
  const level = used >= 100 ? 'is-out' : used >= 85 ? 'is-high' : '';
  return html`<span class="an-meter ${level}" title=${`${label} window: ${used}% used`}>
    ${label}<span class="an-bar"><i style=${`width:${Math.min(100, used)}%`}></i></span><b>${used}%</b>
  </span>`;
}

/** The capacity band: one row per subscription login, its 5-hour and 7-day windows and when they reset. */
export function CapacityBand({ logins }) {
  return html`<section class="an-box an-capacity" aria-label="Capacity">
    <h3>Capacity <span>per login · the same record the footer reads</span></h3>
    ${
      logins === undefined
        ? html`<div class="an-dim">Reading your logins…</div>`
        : logins.length
          ? logins.map((l, i) => {
              const five = windowOf(l.limit, 300);
              const week = windowOf(l.limit, 10_080);
              const plan = l.limit?.snapshot?.plan;
              return html`<div key=${i} class="an-cap-row">
                <span class="an-cap-name"><b>${plan ? `${plan} · ` : ''}${l.name}</b><small>${vendorName(l.provider) ?? l.provider}</small></span>
                ${
                  l.limit?.state === 'kingdom'
                    ? html`<span class="an-dim">A Kingdom pool: Kingdom reports its limits</span>`
                    : l.limit?.state === 'probed'
                      ? html`<${Meter} label="5-hour" window=${five} /><${Meter} label="7-day" window=${week} />
                        <span class="an-cap-reset">${five?.resetsAt ? `resets in ${resetsIn(five.resetsAt)}` : ''}</span>`
                      : html`<span class="an-dim">The CLI didn't report its usage windows</span>`
                }
              </div>`;
            })
          : html`<div class="an-dim">No subscription login is set up.</div>`
    }
    <${ComingSoon} inline=${true} what="When each login runs out at today's pace." />
  </section>`;
}

/** The share of the busiest login's 5-hour window used: the headline number when you pay by window. */
export function windowUsed(logins) {
  const used = (logins ?? [])
    .map((l) => windowOf(l.limit, 300)?.usedPercent)
    .filter((n) => typeof n === 'number');
  return used.length ? Math.round(Math.max(...used)) : null;
}

const total = (b) => (b.input ?? 0) + (b.output ?? 0) + (b.cacheRead ?? 0) + (b.cacheWrite ?? 0);

/** Tokens per bucket over the chosen range (hourly within a day, daily beyond). */
export function useSeries(range) {
  const [series, setSeries] = useState(undefined);
  useEffect(() => {
    let live = true;
    const period = (RANGES.find(([r]) => r === range) ?? RANGES[2])[2];
    setSeries(undefined);
    getJson(`/api/analytics/timeseries?period=${period}&since=${rangeSince(range)}`).then(
      (body) => live && setSeries(Array.isArray(body) ? body : []),
    );
    return () => {
      live = false;
    };
  }, [range]);
  return series;
}

export const seriesTokens = (series) => (series ?? []).reduce((n, b) => n + total(b), 0);

function shortNumber(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

/** Tokens over time: one bar per bucket, labelled; the split by spender is coming. */
export function TokensOverTime({ series, rangeLabel }) {
  const max = Math.max(1, ...(series ?? []).map(total));
  return html`<section class="an-box an-tokens" aria-label="Tokens over time">
    <h3>Tokens over time · ${rangeLabel}</h3>
    ${
      series === undefined
        ? html`<div class="an-dim">Reading…</div>`
        : series.length
          ? html`<div class="an-chart" role="img" aria-label=${`Tokens per period, peak ${shortNumber(max)}`}>
              <span class="an-chart-peak">${shortNumber(max)}</span>
              ${series.map((b) => {
                const n = total(b);
                const at = new Date(b.bucket);
                const label =
                  series.length > 14
                    ? ''
                    : at.toLocaleString(
                        [],
                        b.bucket.includes('T00:00') ? { weekday: 'short' } : { hour: 'numeric' },
                      );
                return html`<span key=${b.bucket} class="an-col" title=${`${at.toLocaleString()} · ${n.toLocaleString()} tokens · ${b.calls} calls`}>
                  <i style=${`height:${Math.max(2, (n / max) * 100)}%`}></i><small>${label}</small>
                </span>`;
              })}
            </div>`
          : html`<div class="an-dim">No calls recorded in this range.</div>`
    }
    <${ComingSoon} inline=${true} what="Stacked by who spent them: your agent, Layer 1, Layer 2, the Forge Master." />
  </section>`;
}
