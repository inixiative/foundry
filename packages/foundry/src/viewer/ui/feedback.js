/**
 * The feedback lifecycle in front of the user (docs/FEEDBACK-LOOP.md, "Lifecycle"):
 * the tuning card ("what happened / what we did / what we intend") and the Feedback view,
 * one row per item: feedback → routed to → change → uses → recurrence.
 */

import { html, useEffect, useState } from './lib.js';
import { holdStream, openTurnDetail, scopeProjectId, showToast } from './store.js';

const LEVELS = [
  ['project-personal', 'project (personal)'],
  ['org-personal', 'org (personal)'],
  ['computer', 'this computer'],
];

const slotLabel = (slot) => (slot === 'domainKnowledge' ? 'domain knowledge' : 'instructions');
const when = (ms) => (ms ? new Date(ms).toLocaleString() : '');

/** The body of a tuning prompt: three lines, then apply / edit / not a rule / later. */
export function FeedbackPrompt({ prompt }) {
  const meta = prompt.meta.feedback;
  const [editing, setEditing] = useState(false);
  const [statement, setStatement] = useState(meta.statement ?? '');
  const [level, setLevel] = useState(meta.route?.level ?? 'project-personal');
  const [busy, setBusy] = useState(false);
  const act = async (action, input) => {
    setBusy(true);
    const ok = await post(`/api/feedback/${encodeURIComponent(meta.itemId)}/answer`, {
      action,
      input,
    });
    setBusy(false);
    if (ok && action === 'edit') setEditing(false);
  };
  const options = prompt.options ?? [];
  return html`<div class="prompt-card feedback-prompt ${prompt.urgency === 'high' ? 'prompt-high' : ''}"
    data-feedback-item=${meta.itemId}>
    <div class="prompt-card-header">
      <span class="prompt-kind">feedback</span>
      <span class="prompt-agent">${meta.itemId}</span>
      ${meta.blocking ? html`<span class="prompt-urgency prompt-high">turn waiting</span>` : null}
    </div>
    <dl class="feedback-lines">
      <dt>What happened</dt><dd>${meta.shown.happened}</dd>
      <dt>What we did</dt><dd>${meta.shown.did}</dd>
      <dt>What we intend</dt><dd>${meta.shown.intend}</dd>
    </dl>
    ${
      editing
        ? html`<div class="feedback-edit">
          <textarea class="prompt-input" rows="2" aria-label="Rule" value=${statement}
            onInput=${(e) => setStatement(e.target.value)}></textarea>
          <select aria-label="Level" value=${level} onChange=${(e) => setLevel(e.target.value)}>
            ${LEVELS.map(([id, label]) => html`<option value=${id}>${label}</option>`)}
          </select>
          <button class="prompt-btn prompt-btn-approve" disabled=${busy || !statement.trim()}
            onClick=${() => act('edit', JSON.stringify({ statement: statement.trim(), level }))}>Apply</button>
          <button class="prompt-btn" onClick=${() => setEditing(false)}>Cancel</button>
        </div>`
        : html`<div class="prompt-card-actions">
          ${options.map((option) =>
            option.id === 'edit'
              ? html`<button key="edit" class="prompt-btn" disabled=${busy}
                  onClick=${() => setEditing(true)}>${option.label}</button>`
              : html`<button key=${option.id} disabled=${busy}
                  class="prompt-btn ${option.id === 'apply' ? 'prompt-btn-approve' : ''}"
                  onClick=${() => act(option.id)}>${option.label}</button>`,
          )}
        </div>`
    }
  </div>`;
}

function useFeedbackStream(projectId) {
  const [items, setItems] = useState([]);
  useEffect(() => {
    setItems([]);
    return holdStream(projectId ? `feedback:${projectId}` : 'feedback', (frame) => {
      if (frame.action === 'rejected') return;
      if (frame.action === 'snapshot') setItems(frame.payload.items ?? []);
      else if (frame.payload?.item)
        setItems((current) => [
          frame.payload.item,
          ...current.filter((item) => item.id !== frame.payload.item.id),
        ]);
    });
  }, [projectId]);
  return items;
}

/** POST to a feedback route; the server's refusal (an invalid edit, an answered prompt) is shown. */
async function post(path, body) {
  try {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
    if (res.ok) return true;
    showToast((await res.json()).error || 'Feedback request failed', 'error');
  } catch (error) {
    showToast(`Feedback request failed: ${error.message}`, 'error');
  }
  return false;
}

async function undo(itemId, changeId) {
  if (await post(`/api/feedback/${encodeURIComponent(itemId)}/undo`, { changeId }))
    showToast('Change reverted', 'ok');
}

async function tune(itemId) {
  if (await post(`/api/feedback/${encodeURIComponent(itemId)}/tune`))
    showToast('Tuning prompt raised in its thread', 'ok');
}

function Stage({ label, children, empty }) {
  return html`<div class="feedback-stage">
    <div class="feedback-stage-label">${label}</div>
    <div class="feedback-stage-body">${children ?? html`<span class="feedback-dim">${empty}</span>`}</div>
  </div>`;
}

const STAGES = ['captured', 'routed', 'tuned', 'applied', 'in use', 'holding'];
const ATTENTION = ['needs attention', 'in progress', 'healthy'];
const attentionRank = (item) => ATTENTION.indexOf(item.attention);
const byAttention = (a, b) => attentionRank(a) - attentionRank(b) || b.updatedAt - a.updatedAt;

/** The cycle as a strip: every stage up to the item's, the item's own one marked. */
function StageStrip({ stage }) {
  const end = stage === 'recurred' ? 'recurred' : stage === 'dismissed' ? 'dismissed' : null;
  const reached = end ? STAGES.indexOf('applied') : STAGES.indexOf(stage);
  const stages = end ? [...STAGES.slice(0, reached + 1), end] : STAGES;
  return html`<ol class="feedback-stages" aria-label=${`Stage: ${stage}`}>
    ${stages.map(
      (name, i) => html`<li key=${name}
        class="feedback-stage-step ${name === stage ? 'current' : i <= reached || name === end ? 'done' : ''}"
        data-stage=${name}>${name}</li>`,
    )}
  </ol>`;
}

function Confidence({ item }) {
  const value = item.confidence.value;
  return html`<div class="feedback-confidence"
    title="Exposure-based: how often the rule was in front of its Warden with no recurrence since it was applied. Oracle's recurrence measurement replaces this when it lands.">
    <span class="feedback-stage-label">Confidence it works</span>
    <span>${value === null ? 'n/a (not applied)' : `${Math.round(value * 100)}%`}</span>
    <span class="feedback-dim">exposure-based · ${item.exposures} exposure${item.exposures === 1 ? '' : 's'} · ↻ ${item.recurredSince} since applied</span>
  </div>`;
}

function FeedbackRow({ item }) {
  const route = item.route;
  const active = item.changes.filter((change) => !change.revertedAt);
  const origin = item.origin;
  return html`<li class="feedback-row" data-attention=${item.attention} data-stage=${item.stage} data-item=${item.id}>
    <div class="feedback-row-head">
      <span class="feedback-attention" data-attention=${item.attention}>${item.attention}</span>
      <${StageStrip} stage=${item.stage} />
      <span class="feedback-dim">${item.reason}</span>
      ${
        ['captured', 'routed', 'tuned', 'recurred', 'dismissed'].includes(item.stage)
          ? html`<button class="feedback-link" onClick=${() => tune(item.id)}>tune</button>`
          : null
      }
    </div>
    <${Stage} label="Rule">
      <div class="feedback-statement">${item.statement}</div>
      <div class="feedback-dim">
        “${item.quote}”
        ${origin.turnId ? html` <button class="feedback-link" onClick=${() => openTurnDetail(origin.threadId, origin.turnId)}>open turn</button>` : null}
      </div>
      <div class="feedback-tags">
        <span class="feedback-chip">${item.id}</span>
        <span class="feedback-chip">${item.category}</span>
        ${item.detection ? html`<span class="feedback-chip">${item.detection.kind}</span>` : null}
      </div>
    <//>
    <${Stage} label="Routed to" empty="not routed">
      ${
        route
          ? html`${route.roles.map((role) => html`<span class="feedback-chip">${role}</span>`)}
            <div class="feedback-dim">${slotLabel(route.slot)} · ${route.level}${route.route.source !== 'model' ? ' · weak routing' : ''}</div>`
          : null
      }
    <//>
    <${Stage} label="Change" empty="none yet">
      ${
        active.length
          ? active.map(
              (change) => html`<div class="feedback-change">
                <code>${change.line}</code>
                <div class="feedback-dim" title=${change.path}>${change.role} · ${change.level} · ${when(change.appliedAt)}</div>
                <div class="feedback-dim feedback-path">${change.path}</div>
                <button class="feedback-link" onClick=${() => undo(item.id, change.changeId)}>undo</button>
              </div>`,
            )
          : null
      }
    <//>
    <${Stage} label="Used" empty="—">
      ${
        active.length
          ? html`<div>${item.uses.exposures} Warden call${item.uses.exposures === 1 ? '' : 's'} had it</div>
            ${item.uses.recent.map(
              (
                use,
              ) => html`<button class="feedback-link" onClick=${() => use.turnId && openTurnDetail(use.threadId, use.turnId)}>
                ${use.roles.join(', ') || use.phase} · ${when(use.at)}</button>`,
            )}`
          : null
      }
    <//>
    <${Stage} label="Evidence">
      <${Confidence} item=${item} />
      <div class=${item.recurrence.sinceChange ? 'feedback-recurred' : ''}>↻ ${item.recurrence.total} total</div>
    <//>
  </li>`;
}

/** The feedback cycle, first-class: everything you've said, needs-attention first. */
export function FeedbackPanel() {
  const items = useFeedbackStream(scopeProjectId());
  const [filter, setFilter] = useState('all');
  const shown = (filter === 'all' ? items : items.filter((item) => item.attention === filter))
    .slice()
    .sort(byAttention);
  const count = (attention) => items.filter((item) => item.attention === attention).length;
  return html`<div class="feedback-panel">
    <div class="graph-header">
      <div class="graph-tabs" role="tablist" aria-label="Feedback filter">
        ${['all', ...ATTENTION].map(
          (id) => html`<button key=${id} role="tab" aria-selected=${filter === id}
            class="graph-tab ${filter === id ? 'graph-tab--active' : ''}"
            onClick=${() => setFilter(id)}>${id}${id === 'all' ? ` (${items.length})` : ` (${count(id)})`}</button>`,
        )}
      </div>
    </div>
    ${
      shown.length
        ? html`<ol class="feedback-list">${shown.map((item) => html`<${FeedbackRow} key=${item.id} item=${item} />`)}</ol>`
        : html`<div class="graph-empty">No feedback here. Corrections you give while working show up in this view.</div>`
    }
  </div>`;
}
