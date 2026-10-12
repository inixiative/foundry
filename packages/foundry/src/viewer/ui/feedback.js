/**
 * The feedback lifecycle in front of the user (docs/FEEDBACK-LOOP.md, "Lifecycle"):
 * the tuning card ("what happened / what we did / what we intend") and the Feedback view,
 * one row per item: feedback → routed to → change → uses → recurrence.
 */

import { html, useEffect, useState } from './lib.js';
import { holdStream, openTurnDetail, resolvePrompt, scopeProjectId, showToast } from './store.js';

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
    await resolvePrompt(prompt.id, action, input);
    setBusy(false);
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

async function undo(itemId, changeId) {
  const res = await fetch(`/api/feedback/${encodeURIComponent(itemId)}/undo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ changeId }),
  });
  if (!res.ok) showToast((await res.json()).error || 'Undo failed', 'error');
  else showToast('Change reverted', 'ok');
}

function Stage({ label, children, empty }) {
  return html`<div class="feedback-stage">
    <div class="feedback-stage-label">${label}</div>
    <div class="feedback-stage-body">${children ?? html`<span class="feedback-dim">${empty}</span>`}</div>
  </div>`;
}

function FeedbackRow({ item }) {
  const route = item.route;
  const active = item.changes.filter((change) => !change.revertedAt);
  return html`<li class="feedback-row" data-status=${item.status} data-item=${item.id}>
    <${Stage} label="Feedback">
      <div class="feedback-statement">${item.statement}</div>
      <div class="feedback-dim">“${item.quote}”</div>
      <div class="feedback-tags">
        <span class="feedback-chip">${item.category}</span>
        ${item.detection ? html`<span class="feedback-chip">${item.detection.kind}</span>` : null}
        <span class="feedback-chip feedback-status">${item.status}</span>
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
                <code title=${change.path}>${change.line}</code>
                <div class="feedback-dim">${change.role} · ${change.level} · ${when(change.appliedAt)}
                  <button class="feedback-link" onClick=${() => undo(item.id, change.changeId)}>undo</button></div>
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
    <${Stage} label="Recurrence">
      <div class=${item.recurrence.sinceChange ? 'feedback-recurred' : ''}>
        ↻ ${item.recurrence.total}${active.length ? ` (${item.recurrence.sinceChange} since the change)` : ''}
      </div>
      ${item.recurrence.whileExposed ? html`<div class="feedback-dim">${item.recurrence.whileExposed} while the Warden had it</div>` : null}
    <//>
  </li>`;
}

/** Center view: every feedback item in scope, newest first. */
export function FeedbackPanel() {
  const items = useFeedbackStream(scopeProjectId());
  const [filter, setFilter] = useState('all');
  const shown = filter === 'all' ? items : items.filter((item) => item.status === filter);
  return html`<div class="feedback-panel">
    <div class="graph-header">
      <div class="graph-tabs" role="tablist" aria-label="Feedback filter">
        ${['all', 'open', 'applied', 'deferred', 'dismissed'].map(
          (id) => html`<button key=${id} role="tab" aria-selected=${filter === id}
            class="graph-tab ${filter === id ? 'graph-tab--active' : ''}"
            onClick=${() => setFilter(id)}>${id}</button>`,
        )}
      </div>
    </div>
    ${
      shown.length
        ? html`<ol class="feedback-list">${shown.map((item) => html`<${FeedbackRow} key=${item.id} item=${item} />`)}</ol>`
        : html`<div class="graph-empty">No feedback yet. Corrections you give while working show up here.</div>`
    }
  </div>`;
}
