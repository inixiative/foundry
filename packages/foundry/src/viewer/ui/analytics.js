/**
 * Analytics — first-class cost & token tracking panel.
 *
 * Shows: session totals, per-thread costs, model rankings, time-series,
 * recent call log with per-span cost, and budget status.
 */

import { html, signal, useEffect, useState } from './lib.js';
import { analyticsPath, navigate, route } from './route.js';
import { projects } from './store.js';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const analyticsTab = signal('overview'); // overview | threads | calls | models

// ---------------------------------------------------------------------------
// Data fetching
// ---------------------------------------------------------------------------

/** One poll: the snapshot, or why there is none. A refusal (unknown project, analytics off) ends polling. */
async function loadAnalytics(projectId) {
  try {
    const res = await fetch(
      projectId ? `/api/analytics?project=${encodeURIComponent(projectId)}` : '/api/analytics',
    );
    const body = await res.json();
    if (res.ok) return { data: body };
    return { error: body.error || `Analytics unavailable: ${res.status}`, final: res.status < 500 };
  } catch (err) {
    return { error: `Analytics failed to load: ${err.message}`, final: false };
  }
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function fmt$(n) {
  if (n == null) return 'Unavailable';
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}

function fmtTokens(n) {
  if (n == null) return 'Unavailable';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return `${n}`;
}

function fmtPct(n) {
  if (n == null) return '0%';
  return `${(n * 100).toFixed(1)}%`;
}

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString();
}

// ---------------------------------------------------------------------------
// Overview — session totals + budget
// ---------------------------------------------------------------------------

function Overview({ data }) {
  if (!data?.session && !data?.observations?.calls)
    return html`<div class="analytics-empty">No analytics data yet. Make some LLM calls to see costs.</div>`;

  // A project's view has no live session totals; it reads recorded history only.
  const s = data.session ?? {};
  const b = s.budget ?? {};
  const o = data.observations;
  const cacheRead = o ? o.knownCacheRead : s.tokens?.cacheRead;
  const cacheWrite = o ? o.knownCacheWrite : s.tokens?.cacheWrite;

  return html`
    <div class="analytics-overview">
      <!-- Hero stats -->
      <div class="stats-grid">
        <${StatCard} label="Recorded cost" value=${fmt$(o?.unavailableCostCalls ? null : (o?.knownCost ?? s.totalCost))} accent="blue" />
        <${StatCard} label="Recorded tokens" value=${fmtTokens(o?.knownTokens ?? s.totalTokens)} accent="green" />
        <${StatCard} label="Recorded calls" value=${o?.calls ?? s.totalCalls} accent="purple" />
        <${StatCard} label="Avg $/Call" value=${fmt$(o?.unavailableCostCalls ? null : o?.calls ? o.knownCost / o.calls : 0)} accent="orange" />
      </div>
      ${o ? html`<p class="analytics-availability">Recorded history: known subtotals only. Usage unavailable for ${o.unavailableUsageCalls} calls; cost unavailable for ${o.unavailableCostCalls} calls. Persistence: ${o.persistence}.</p>` : null}

      <!-- Budget gauge -->
      ${
        (b.limitTokens || b.limitCost) && !o?.unavailableCostCalls
          ? html`
        <div class="budget-section">
          <div class="section-label">BUDGET</div>
          <${BudgetGauge} budget=${b} />
        </div>
      `
          : null
      }

      <!-- Token breakdown -->
      <div class="breakdown-row">
        <div class="breakdown-half">
          <div class="section-label">INPUT TOKENS</div>
          <div class="breakdown-value">${fmtTokens(o?.knownInput ?? s.totalInput)}</div>
        </div>
        <div class="breakdown-half">
          <div class="section-label">OUTPUT TOKENS</div>
          <div class="breakdown-value">${fmtTokens(o?.knownOutput ?? s.totalOutput)}</div>
        </div>
      </div>

      <div class="breakdown-row">
        <div class="breakdown-half">
          <div class="section-label">CACHE READ TOKENS</div>
          <div class="breakdown-value">${cacheRead == null ? '—' : fmtTokens(cacheRead)}</div>
        </div>
        <div class="breakdown-half">
          <div class="section-label">CACHE WRITE TOKENS</div>
          <div class="breakdown-value">${cacheWrite == null ? '—' : fmtTokens(cacheWrite)}</div>
        </div>
      </div>
      <!-- Top models -->
      ${
        data.topModels?.length > 0
          ? html`
        <div class="ranked-section">
          <div class="section-label">TOP MODELS BY SPEND</div>
          ${data.topModels.slice(0, 5).map(
            (m) => html`
            <${RankedRow} key=${m.key} item=${m} unpriced=${!!o?.unavailableCostCalls} />
          `,
          )}
        </div>
      `
          : null
      }

      <!-- Top agents -->
      ${
        data.topAgents?.length > 0
          ? html`
        <div class="ranked-section">
          <div class="section-label">TOP AGENTS BY SPEND</div>
          ${data.topAgents.slice(0, 5).map(
            (a) => html`
            <${RankedRow} key=${a.key} item=${a} unpriced=${!!o?.unavailableCostCalls} />
          `,
          )}
        </div>
      `
          : null
      }
    </div>
  `;
}

function StatCard({ label, value, accent }) {
  return html`
    <div class="stat-card stat-${accent}">
      <div class="stat-value">${value}</div>
      <div class="stat-label">${label}</div>
    </div>
  `;
}

function BudgetGauge({ budget }) {
  const pct = Math.min(budget.percentage * 100, 100);
  const cls = budget.exceeded ? 'exceeded' : budget.warning ? 'warning' : 'ok';

  return html`
    <div class="budget-gauge">
      <div class="budget-bar">
        <div class="budget-fill budget-${cls}" style="width: ${pct}%"></div>
      </div>
      <div class="budget-labels">
        <span>${fmtPct(budget.percentage)} used</span>
        <span>
          ${budget.limitCost != null ? `${fmt$(budget.usedCost)} / ${fmt$(budget.limitCost)}` : ''}
          ${budget.limitTokens != null ? ` ${fmtTokens(budget.usedTokens)} / ${fmtTokens(budget.limitTokens)} tokens` : ''}
        </span>
      </div>
    </div>
  `;
}

function RankedRow({ item, unpriced }) {
  return html`
    <div class="ranked-row">
      <div class="ranked-bar" style="width: ${Math.max(item.percentage * 100, 2)}%"></div>
      <span class="ranked-key">${item.key}</span>
      <span class="ranked-cost">${fmt$(unpriced ? null : item.cost)}</span>
      <span class="ranked-tokens">${fmtTokens(item.tokens)}</span>
      <span class="ranked-calls">${item.calls} calls</span>
      <span class="ranked-pct">${unpriced ? '—' : fmtPct(item.percentage)}</span>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Threads — per-thread cost breakdown
// ---------------------------------------------------------------------------

function Threads({ data }) {
  const threads = data?.threads ?? [];
  if (threads.length === 0) return html`<div class="analytics-empty">No thread data yet.</div>`;

  return html`
    <div class="analytics-threads">
      <div class="section-label">THREAD COST BREAKDOWN</div>
      <div class="thread-table">
        <div class="thread-header">
          <span class="th-id">Thread</span>
          <span class="th-cost">Cost</span>
          <span class="th-tokens">Tokens</span>
          <span class="th-calls">Calls</span>
          <span class="th-avg">Avg/Call</span>
        </div>
        ${threads.map(
          (t) => html`
          <div key=${t.threadId} class="thread-row">
            <span class="th-id" title=${t.threadId}>${t.threadId}</span>
            <span class="th-cost">${fmt$(data.observations?.unavailableCostCalls ? null : t.cost)}</span>
            <span class="th-tokens">${fmtTokens(t.totalTokens)}</span>
            <span class="th-calls">${t.calls}</span>
            <span class="th-avg">${fmt$(data.observations?.unavailableCostCalls ? null : t.avgCostPerCall)}</span>
          </div>
        `,
        )}
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Calls — recent call log
// ---------------------------------------------------------------------------

function Calls({ data }) {
  const calls = data?.recentCalls ?? [];
  if (calls.length === 0) return html`<div class="analytics-empty">No calls recorded yet.</div>`;

  return html`
    <div class="analytics-calls">
      <div class="section-label">RECENT CALLS (last 100)</div>
      <div class="call-table">
        <div class="call-header">
          <span class="cl-time">Time</span>
          <span class="cl-model">Model</span>
          <span class="cl-agent">Agent</span>
          <span class="cl-in">In</span>
          <span class="cl-out">Out</span>
          <span class="cl-cost">Cost</span>
          <span class="cl-cache-read">Cache read</span>
          <span class="cl-cache-write">Cache write</span>
          <span class="cl-cached">Response cache</span>
        </div>
        ${calls.map(
          (c, i) => html`
          <div key=${i} class="call-row ${c.cached ? 'cached' : ''}">
            <span class="cl-time">${fmtTime(c.timestamp)}</span>
            <span class="cl-model" title=${c.model}>${c.model.split('/').pop()}</span>
            <span class="cl-agent">${c.agentId ?? '-'}</span>
            <span class="cl-in" data-label="Input">${fmtTokens(c.input)}</span>
            <span class="cl-out" data-label="Output">${fmtTokens(c.output)}</span>
            <span class="cl-cost" data-label="Cost">${fmt$(c.cost)}</span>
            <span class="cl-cache-read" data-label="Cache read" title=${JSON.stringify(c.providerUsage ?? {})}>${c.cacheRead == null ? '—' : fmtTokens(c.cacheRead)}</span>
            <span class="cl-cache-write" data-label="Cache write" title=${`5m: ${c.cacheWrite5m ?? 'unreported'}; 1h: ${c.cacheWrite1h ?? 'unreported'}`}>${c.cacheWrite == null ? '—' : fmtTokens(c.cacheWrite)}</span>
            <span class="cl-cached">${c.cached ? 'hit' : ''}</span>
          </div>
        `,
        )}
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Models — provider/model breakdown
// ---------------------------------------------------------------------------

function Models({ data }) {
  if (!data?.session) return html`<${RecordedModels} data=${data} />`;
  const byProvider = data.session.byProvider ?? [];
  const byModel = data.session.byModel ?? [];

  if (byProvider.length === 0 && byModel.length === 0) {
    return html`<div class="analytics-empty">No model usage data yet.</div>`;
  }

  return html`
    <div class="analytics-models">
      ${
        byProvider.length > 0
          ? html`
        <div class="section-label">BY PROVIDER</div>
        <div class="model-table">
          ${byProvider.map(
            (p) => html`
            <div key=${p.key} class="model-row">
              <span class="md-name">${p.key}</span>
              <span class="md-cost">${fmt$(data.observations?.unavailableCostCalls ? null : p.cost)}</span>
              <span class="md-tokens">${fmtTokens(p.total)} tokens</span>
              <span class="md-calls">${p.calls} calls</span>
            </div>
          `,
          )}
        </div>
      `
          : null
      }

      ${
        byModel.length > 0
          ? html`
        <div class="section-label" style="margin-top: 16px">BY MODEL</div>
        <div class="model-table">
          ${byModel.map(
            (m) => html`
            <div key=${m.key} class="model-row">
              <span class="md-name">${m.key}</span>
              <span class="md-cost">${fmt$(data.observations?.unavailableCostCalls ? null : m.cost)}</span>
              <span class="md-in">${fmtTokens(m.input)} in</span>
              <span class="md-out">${fmtTokens(m.output)} out</span>
              <span class="md-calls">${m.calls} calls</span>
            </div>
          `,
          )}
        </div>
      `
          : null
      }
    </div>
  `;
}

function RecordedModels({ data }) {
  const unpriced = !!data?.observations?.unavailableCostCalls;
  const sections = [
    ['BY PROVIDER', data?.topProviders ?? []],
    ['BY MODEL', data?.topModels ?? []],
  ];
  if (!sections.some(([, items]) => items.length))
    return html`<div class="analytics-empty">No model usage data yet.</div>`;
  return html`<div class="analytics-models">
    ${sections.map(
      ([label, items]) => html`<div key=${label} class="ranked-section">
        <div class="section-label">${label}</div>
        ${items.map((item) => html`<${RankedRow} key=${item.key} item=${item} unpriced=${unpriced} />`)}
      </div>`,
    )}
  </div>`;
}

// ---------------------------------------------------------------------------
// Main Analytics Panel
// ---------------------------------------------------------------------------

export function AnalyticsPage() {
  const { projectId } = route.value;
  const [state, setState] = useState({});
  const data = state.data ?? null;
  const tab = analyticsTab.value;
  const projectList = projects.value;
  const known = !projectId || projectList.some((p) => p.id === projectId);

  useEffect(() => {
    let live = true;
    let timer;
    setState({});
    const poll = async () => {
      const next = await loadAnalytics(projectId);
      if (!live) return;
      setState(next);
      if (!next.final) timer = setTimeout(poll, 5000);
    };
    poll();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [projectId]);

  const tabs = [
    { id: 'overview', label: 'Overview' },
    { id: 'threads', label: 'Threads' },
    { id: 'calls', label: 'Call Log' },
    { id: 'models', label: 'Models' },
  ];

  return html`
    <main class="analytics-page">
      <div class="analytics-header">
        <select class="settings-input small analytics-scope" aria-label="Analytics scope" value=${projectId ?? ''}
          onChange=${(e) => navigate(analyticsPath(e.target.value || null))}>
          <option value="">Foundry · every call</option>
          ${known ? null : html`<option value=${projectId}>${projectId} (not registered)</option>`}
          ${projectList.map((p) => html`<option key=${p.id} value=${p.id}>${p.label}</option>`)}
        </select>
        <div class="analytics-tabs">
          ${tabs.map(
            (t) => html`
            <button
              key=${t.id}
              class="analytics-tab ${tab === t.id ? 'active' : ''}"
              onClick=${() => {
                analyticsTab.value = t.id;
              }}
            >${t.label}</button>
          `,
          )}
        </div>
      </div>

      <div class="analytics-body">
        ${state.error ? html`<p class="analytics-empty" role="alert">${state.error}</p>` : null}
        ${projectId ? html`<p class="analytics-availability">Calls recorded on this project's threads. Live session totals and the budget are on the Foundry view.</p>` : null}
        ${tab !== 'overview' && data?.observations ? html`<p class="analytics-availability">Known subtotals only. Usage unavailable for ${data.observations.unavailableUsageCalls} calls; cost unavailable for ${data.observations.unavailableCostCalls} calls. Unpriced subtotals do not establish free usage.</p>` : null}
        ${tab === 'overview' ? html`<${Overview} data=${data} />` : null}
        ${tab === 'threads' ? html`<${Threads} data=${data} />` : null}
        ${tab === 'calls' ? html`<${Calls} data=${data} />` : null}
        ${tab === 'models' ? html`<${Models} data=${data} />` : null}
      </div>
    </main>
  `;
}
