/**
 * Analytics — first-class cost & token tracking panel.
 *
 * Shows: session totals, per-thread costs, model rankings, time-series,
 * recent call log with per-span cost, and budget status.
 */

import { html, useState, useEffect, useCallback } from "./lib.js";
import { signal } from "./lib.js";
import { showToast } from "./store.js";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export const analyticsOpen = signal(false);
const analyticsData = signal(null);
const analyticsPeriod = signal("hourly");
const analyticsTab = signal("overview"); // overview | threads | calls | models

// ---------------------------------------------------------------------------
// Data fetching
// ---------------------------------------------------------------------------

async function loadAnalytics() {
  try {
    const res = await fetch("/api/analytics");
    if (!res.ok) {
      analyticsData.value = null;
      return;
    }
    analyticsData.value = await res.json();
  } catch {
    // offline
  }
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function fmt$(n) {
  if (n == null) return "$0.00";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}

function fmtTokens(n) {
  if (n == null) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return `${n}`;
}

function fmtPct(n) {
  if (n == null) return "0%";
  return `${(n * 100).toFixed(1)}%`;
}

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString();
}

function fmtDate(ts) {
  return new Date(ts).toLocaleDateString();
}

// ---------------------------------------------------------------------------
// Overview — session totals + budget
// ---------------------------------------------------------------------------

function Overview({ data }) {
  if (!data?.session) return html`<div class="analytics-empty">No analytics data yet. Make some LLM calls to see costs.</div>`;

  const s = data.session;
  const b = s.budget;

  return html`
    <div class="analytics-overview">
      <!-- Hero stats -->
      <div class="stats-grid">
        <${StatCard} label="Total Cost" value=${fmt$(s.totalCost)} accent="blue" />
        <${StatCard} label="Total Tokens" value=${fmtTokens(s.totalTokens)} accent="green" />
        <${StatCard} label="LLM Calls" value=${s.totalCalls} accent="purple" />
        <${StatCard} label="Avg $/Call" value=${fmt$(s.totalCalls > 0 ? s.totalCost / s.totalCalls : 0)} accent="orange" />
      </div>

      <!-- Budget gauge -->
      ${b.limitTokens || b.limitCost ? html`
        <div class="budget-section">
          <div class="section-label">BUDGET</div>
          <${BudgetGauge} budget=${b} />
        </div>
      ` : null}

      <!-- Token breakdown -->
      <div class="breakdown-row">
        <div class="breakdown-half">
          <div class="section-label">INPUT TOKENS</div>
          <div class="breakdown-value">${fmtTokens(s.totalInput)}</div>
        </div>
        <div class="breakdown-half">
          <div class="section-label">OUTPUT TOKENS</div>
          <div class="breakdown-value">${fmtTokens(s.totalOutput)}</div>
        </div>
      </div>

      <!-- Top models -->
      ${data.topModels?.length > 0 ? html`
        <div class="ranked-section">
          <div class="section-label">TOP MODELS BY SPEND</div>
          ${data.topModels.slice(0, 5).map(m => html`
            <${RankedRow} key=${m.key} item=${m} />
          `)}
        </div>
      ` : null}

      <!-- Top agents -->
      ${data.topAgents?.length > 0 ? html`
        <div class="ranked-section">
          <div class="section-label">TOP AGENTS BY SPEND</div>
          ${data.topAgents.slice(0, 5).map(a => html`
            <${RankedRow} key=${a.key} item=${a} />
          `)}
        </div>
      ` : null}
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
  const cls = budget.exceeded ? "exceeded" : budget.warning ? "warning" : "ok";

  return html`
    <div class="budget-gauge">
      <div class="budget-bar">
        <div class="budget-fill budget-${cls}" style="width: ${pct}%"></div>
      </div>
      <div class="budget-labels">
        <span>${fmtPct(budget.percentage)} used</span>
        <span>
          ${budget.limitCost != null ? `${fmt$(budget.usedCost)} / ${fmt$(budget.limitCost)}` : ""}
          ${budget.limitTokens != null ? ` ${fmtTokens(budget.usedTokens)} / ${fmtTokens(budget.limitTokens)} tokens` : ""}
        </span>
      </div>
    </div>
  `;
}

function RankedRow({ item }) {
  return html`
    <div class="ranked-row">
      <div class="ranked-bar" style="width: ${Math.max(item.percentage * 100, 2)}%"></div>
      <span class="ranked-key">${item.key}</span>
      <span class="ranked-cost">${fmt$(item.cost)}</span>
      <span class="ranked-tokens">${fmtTokens(item.tokens)}</span>
      <span class="ranked-calls">${item.calls} calls</span>
      <span class="ranked-pct">${fmtPct(item.percentage)}</span>
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
        ${threads.map(t => html`
          <div key=${t.threadId} class="thread-row">
            <span class="th-id" title=${t.threadId}>${t.threadId}</span>
            <span class="th-cost">${fmt$(t.cost)}</span>
            <span class="th-tokens">${fmtTokens(t.totalTokens)}</span>
            <span class="th-calls">${t.calls}</span>
            <span class="th-avg">${fmt$(t.avgCostPerCall)}</span>
          </div>
        `)}
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
          <span class="cl-cached">Cache</span>
        </div>
        ${calls.map((c, i) => html`
          <div key=${i} class="call-row ${c.cached ? 'cached' : ''}">
            <span class="cl-time">${fmtTime(c.timestamp)}</span>
            <span class="cl-model" title=${c.model}>${c.model.split("/").pop()}</span>
            <span class="cl-agent">${c.agentId ?? "-"}</span>
            <span class="cl-in">${fmtTokens(c.input)}</span>
            <span class="cl-out">${fmtTokens(c.output)}</span>
            <span class="cl-cost">${fmt$(c.cost)}</span>
            <span class="cl-cached">${c.cached ? "hit" : ""}</span>
          </div>
        `)}
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Models — provider/model breakdown
// ---------------------------------------------------------------------------

function Models({ data }) {
  const byProvider = data?.session?.byProvider ?? [];
  const byModel = data?.session?.byModel ?? [];

  if (byProvider.length === 0 && byModel.length === 0) {
    return html`<div class="analytics-empty">No model usage data yet.</div>`;
  }

  return html`
    <div class="analytics-models">
      ${byProvider.length > 0 ? html`
        <div class="section-label">BY PROVIDER</div>
        <div class="model-table">
          ${byProvider.map(p => html`
            <div key=${p.key} class="model-row">
              <span class="md-name">${p.key}</span>
              <span class="md-cost">${fmt$(p.cost)}</span>
              <span class="md-tokens">${fmtTokens(p.total)} tokens</span>
              <span class="md-calls">${p.calls} calls</span>
            </div>
          `)}
        </div>
      ` : null}

      ${byModel.length > 0 ? html`
        <div class="section-label" style="margin-top: 16px">BY MODEL</div>
        <div class="model-table">
          ${byModel.map(m => html`
            <div key=${m.key} class="model-row">
              <span class="md-name">${m.key}</span>
              <span class="md-cost">${fmt$(m.cost)}</span>
              <span class="md-in">${fmtTokens(m.input)} in</span>
              <span class="md-out">${fmtTokens(m.output)} out</span>
              <span class="md-calls">${m.calls} calls</span>
            </div>
          `)}
        </div>
      ` : null}
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Main Analytics Panel
// ---------------------------------------------------------------------------

export function Analytics() {
  const open = analyticsOpen.value;
  const data = analyticsData.value;
  const tab = analyticsTab.value;

  useEffect(() => {
    if (open) {
      loadAnalytics();
      const interval = setInterval(loadAnalytics, 5000);
      return () => clearInterval(interval);
    }
  }, [open]);

  if (!open) return null;

  const tabs = [
    { id: "overview", label: "Overview" },
    { id: "threads", label: "Threads" },
    { id: "calls", label: "Call Log" },
    { id: "models", label: "Models" },
  ];

  return html`
    <div class="analytics-overlay" onClick=${(e) => {
      if (e.target.classList.contains("analytics-overlay")) analyticsOpen.value = false;
    }}>
      <div class="analytics-panel">
        <div class="analytics-header">
          <span class="analytics-title">Analytics</span>
          <div class="analytics-tabs">
            ${tabs.map(t => html`
              <button
                key=${t.id}
                class="analytics-tab ${tab === t.id ? 'active' : ''}"
                onClick=${() => { analyticsTab.value = t.id; }}
              >${t.label}</button>
            `)}
          </div>
          <button class="analytics-close" onClick=${() => { analyticsOpen.value = false; }}>ESC</button>
        </div>

        <div class="analytics-body">
          ${tab === "overview" ? html`<${Overview} data=${data} />` : null}
          ${tab === "threads" ? html`<${Threads} data=${data} />` : null}
          ${tab === "calls" ? html`<${Calls} data=${data} />` : null}
          ${tab === "models" ? html`<${Models} data=${data} />` : null}
        </div>
      </div>
    </div>
  `;
}
