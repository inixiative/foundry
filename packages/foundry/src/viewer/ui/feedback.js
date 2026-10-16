/**
 * Feedback in front of the user. One set of items (the `feedback` stream, `feedbackItems`) in three
 * scopes: the pinned Feedback inbox (everything), a project's strip and list, and a thread (a marker on
 * the turn an item refers to, and the list in the detail panel). Explicit feedback (`/feedback`) is
 * recorded as said; an item the opt-in detector captured also carries its learning-loop state and the
 * tuning card ("what happened / what we did / what we intend", docs/FEEDBACK-LOOP.md).
 */

import { html, useState } from './lib.js';
import {
  activePanel,
  allThreads,
  authFetch,
  feedbackItems,
  giveFeedback,
  openFeedbackSource,
  openTurnDetail,
  projects,
  setFeedbackStatus,
  showToast,
} from './store.js';
import { Switch } from './switch.js';
import { threadName } from './thread-labels.js';

const LEVELS = [
  ['project-personal', 'project (personal)'],
  ['org-personal', 'org (personal)'],
  ['computer', 'this computer'],
];

/** The composer command, as typed. */
const FEEDBACK_COMMAND = '/feedback <text>';

const slotLabel = (slot) => (slot === 'domainKnowledge' ? 'domain knowledge' : 'instructions');
const when = (ms) => {
  if (!ms) return '';
  const date = new Date(ms);
  return date.toDateString() === new Date().toDateString()
    ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString();
};

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

/** Items in a scope: everything, a project's (`null`: threads outside any project), or a thread's. */
export function feedbackIn({ projectId, threadId } = {}) {
  return feedbackItems.value.filter(
    (item) =>
      (projectId === undefined || (item.projectId ?? null) === projectId) &&
      (threadId === undefined || item.origin.threadId === threadId),
  );
}

const openCount = (items) => items.filter((item) => item.inbox === 'open').length;

const projectLabel = (projectId) =>
  projectId ? projects.value.find((p) => p.id === projectId)?.label || projectId : 'Global';

function threadLabel(threadId) {
  const thread = allThreads.value.find((t) => t.threadId === threadId);
  return thread ? threadName(thread) : threadId;
}

const STAGES = ['captured', 'routed', 'tuned', 'applied', 'in use', 'holding'];

/** The learning-loop cycle as a strip: every stage up to the item's, the item's own one marked. */
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

/** A detected or classified item's loop: stage, route, the change it made (undo), tune again. */
function LearningLoop({ item }) {
  const active = item.changes.filter((change) => !change.revertedAt);
  return html`<details class="feedback-loop">
    <summary><span class="feedback-dim">learning loop:</span> ${item.stage} · ${item.reason}</summary>
    <${StageStrip} stage=${item.stage} />
    ${
      item.route
        ? html`<div class="feedback-dim">routed to ${item.route.roles.join(', ')} · ${slotLabel(item.route.slot)} · ${item.route.level}</div>`
        : null
    }
    ${active.map(
      (change) => html`<div class="feedback-change" key=${change.changeId}>
        <code>${change.line}</code>
        <div class="feedback-dim feedback-path" title=${change.path}>${change.role} · ${change.level} · ${change.path}</div>
        <button class="feedback-link" onClick=${() => undo(item.id, change.changeId)}>undo</button>
      </div>`,
    )}
    ${
      active.length
        ? html`<div class="feedback-dim">${item.uses.exposures} Warden call${item.uses.exposures === 1 ? '' : 's'} had it · ↻ ${item.recurrence.total}</div>`
        : null
    }
    ${
      ['captured', 'routed', 'tuned', 'recurred', 'dismissed'].includes(item.stage)
        ? html`<button class="feedback-link" onClick=${() => tune(item.id)}>tune</button>`
        : null
    }
  </details>`;
}

const ORIGIN_LABEL = {
  explicit: 'feedback',
  intervention: 'correction',
  detected: 'detected',
  seed: 'seed',
  mined: 'mined',
};

/** One item: what was said, where (project › thread › turn), by whom, and archive / unarchive. */
function FeedbackRow({ item, selected, onSelect, showProject = true }) {
  const archived = item.inbox === 'archived';
  return html`<li class="feedback-item ${archived ? 'feedback-item--archived' : ''}" data-item=${item.id}
    data-inbox=${item.inbox} data-origin=${item.originKind}>
    ${
      onSelect
        ? html`<input type="checkbox" class="feedback-select" aria-label=${`Select ${item.id}`}
            checked=${selected} onChange=${(e) => onSelect(item.id, e.target.checked)} />`
        : null
    }
    <div class="feedback-item-body">
      <div class="feedback-statement">${item.statement}</div>
      ${
        item.originKind !== 'explicit' && item.quote && item.quote !== item.statement
          ? html`<div class="feedback-dim">“${item.quote}”</div>`
          : null
      }
      <div class="feedback-provenance">
        ${showProject ? html`<span class="feedback-chip feedback-chip--project">${projectLabel(item.projectId)}</span>` : null}
        <button class="feedback-link feedback-source" title="Open the thread at this turn"
          onClick=${() => openFeedbackSource(item)}>
          ${threadLabel(item.origin.threadId)}${item.origin.turnId ? ' › turn' : ''}
        </button>
        ${
          item.origin.turnId
            ? html`<button class="feedback-link" title="Inspect the turn"
                onClick=${() => openTurnDetail(item.origin.threadId, item.origin.turnId)}>inspect</button>`
            : null
        }
        <span class="feedback-dim" title=${new Date(item.origin.at).toLocaleString()}>${when(item.origin.at)}</span>
        ${item.author ? html`<span class="feedback-dim">${item.author.name} · ${item.author.surface}</span>` : null}
      </div>
      <div class="feedback-tags">
        <span class="feedback-chip">${ORIGIN_LABEL[item.originKind] ?? item.originKind}</span>
        ${item.category ? html`<span class="feedback-chip">${item.category}</span>` : null}
        ${item.tags.map((tag) => html`<span class="feedback-chip" key=${tag}>#${tag}</span>`)}
        <span class="feedback-chip feedback-id">${item.id}</span>
      </div>
      ${item.originKind === 'explicit' ? null : html`<${LearningLoop} item=${item} />`}
    </div>
    <button class="proj-btn feedback-archive" onClick=${() => setFeedbackStatus([item.id], archived ? 'open' : 'archived')}>
      ${archived ? 'Unarchive' : 'Archive'}
    </button>
  </li>`;
}

const FILTERS = [
  ['open', 'Open'],
  ['archived', 'Archived'],
  ['all', 'All'],
];

/**
 * The inbox: newest first, open / archived / all, archive one or many. `projectId` scopes it to a
 * project (`null`: Global's threads); left out, it is every item across projects.
 */
export function FeedbackInbox({ projectId }) {
  const scoped = projectId !== undefined;
  const items = feedbackIn(scoped ? { projectId } : {});
  const [filter, setFilter] = useState('open');
  const [selected, setSelected] = useState(() => new Set());
  const shown = filter === 'all' ? items : items.filter((item) => item.inbox === filter);
  const picked = shown.filter((item) => selected.has(item.id));
  const select = (id, on) =>
    setSelected((current) => {
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  const bulk = async (status) => {
    if (
      await setFeedbackStatus(
        picked.map((item) => item.id),
        status,
      )
    )
      setSelected(new Set());
  };
  const allPicked = shown.length > 0 && picked.length === shown.length;
  return html`<div class="feedback-panel feedback-inbox" data-scope=${scoped ? (projectId ?? 'global') : 'all'}>
    <div class="feedback-inbox-header">
      <div class="feedback-inbox-title">
        <span class="feedback-inbox-name">${scoped ? `Feedback · ${projectLabel(projectId)}` : 'Feedback inbox'}</span>
        <span class="feedback-dim">${scoped ? 'given in this scope’s threads' : 'everything you’ve given, across projects'} · <code>${FEEDBACK_COMMAND}</code> in a thread adds one</span>
      </div>
      <div class="graph-tabs" role="tablist" aria-label="Feedback filter">
        ${FILTERS.map(
          ([id, label]) => html`<button key=${id} role="tab" aria-selected=${filter === id}
            class="graph-tab ${filter === id ? 'graph-tab--active' : ''}"
            onClick=${() => {
              setFilter(id);
              setSelected(new Set());
            }}>${label} (${id === 'all' ? items.length : items.filter((item) => item.inbox === id).length})</button>`,
        )}
      </div>
      <div class="feedback-bulk">
        <label class="feedback-dim"><input type="checkbox" aria-label="Select all" checked=${allPicked}
          disabled=${!shown.length}
          onChange=${(e) => setSelected(e.target.checked ? new Set(shown.map((item) => item.id)) : new Set())} /> all</label>
        ${
          filter !== 'archived'
            ? html`<button class="proj-btn" disabled=${!picked.some((item) => item.inbox === 'open')}
                onClick=${() => bulk('archived')}>Archive selected (${picked.filter((item) => item.inbox === 'open').length})</button>`
            : null
        }
        ${
          filter !== 'open'
            ? html`<button class="proj-btn" disabled=${!picked.some((item) => item.inbox === 'archived')}
                onClick=${() => bulk('open')}>Unarchive selected (${picked.filter((item) => item.inbox === 'archived').length})</button>`
            : null
        }
      </div>
    </div>
    ${
      shown.length
        ? html`<ol class="feedback-list">${shown.map(
            (item) =>
              html`<${FeedbackRow} key=${item.id} item=${item} selected=${selected.has(item.id)}
                onSelect=${select} showProject=${!scoped} />`,
          )}</ol>`
        : html`<div class="graph-empty">${
            filter === 'archived'
              ? 'Nothing archived.'
              : 'No open feedback. Type /feedback <text> in a thread’s composer, or use a message’s ⋯ → feedback.'
          }</div>`
    }
  </div>`;
}

/** The top of a project's thread list: its open feedback, one click from its list. */
export function FeedbackStrip({ projectId }) {
  const items = feedbackIn({ projectId });
  const open = openCount(items);
  const current = activePanel.value === 'feedback';
  return html`<button type="button" class="feedback-strip ${open ? 'feedback-strip--open' : ''} ${current ? 'feedback-strip--current' : ''}"
    title="This project’s feedback" aria-pressed=${current}
    onClick=${() => {
      activePanel.value = current ? 'conversation' : 'feedback';
    }}>
    <span class="feedback-strip-icon" aria-hidden="true">◆</span>
    <span class="feedback-strip-label">Feedback</span>
    <span class="feedback-strip-count">${open} open</span>
    ${items.length > open ? html`<span class="feedback-dim">· ${items.length - open} archived</span>` : null}
  </button>`;
}

/** Give feedback on one message's turn: a small inline form (the composer's `/feedback`, aimed). */
export function GiveFeedback({ threadId, msg, onDone }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!text.trim()) return;
    setBusy(true);
    const ok = await giveFeedback(threadId, text.trim(), {
      turnId: msg.turnId,
      ...(msg.id ? { messageId: msg.id } : {}),
    });
    setBusy(false);
    if (ok) onDone();
  };
  return html`<div class="give-feedback" onClick=${(e) => e.stopPropagation()}>
    <textarea class="prompt-input" rows="2" aria-label="Feedback on this turn" placeholder="Feedback on this turn…"
      value=${text} onInput=${(e) => setText(e.target.value)}
      onKeyDown=${(e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          submit();
        }
        if (e.key === 'Escape') onDone();
      }}></textarea>
    <div class="prompt-card-actions">
      <button class="prompt-btn prompt-btn-approve" disabled=${busy || !text.trim()} onClick=${submit}>Give feedback</button>
      <button class="prompt-btn" onClick=${onDone}>Cancel</button>
    </div>
  </div>`;
}

/** The marker on a turn that feedback refers to: count, expandable to what was said. */
export function TurnFeedback({ threadId, turnId }) {
  if (!turnId) return null;
  const items = feedbackIn({ threadId }).filter((item) => item.origin.turnId === turnId);
  if (!items.length) return null;
  const open = openCount(items);
  return html`<details class="turn-feedback" data-turn-feedback=${turnId}>
    <summary><span aria-hidden="true">◆</span> ${items.length} feedback${open < items.length ? ` (${open} open)` : ''}</summary>
    <ul>
      ${items.map(
        (item) =>
          html`<li key=${item.id} class=${item.inbox === 'archived' ? 'feedback-dim' : ''}>${item.statement}</li>`,
      )}
    </ul>
  </details>`;
}

/** The detail panel's list of a thread's feedback. */
export function ThreadFeedback({ threadId }) {
  const items = feedbackIn({ threadId });
  return html`<div class="thread-feedback" data-thread-feedback=${threadId}>
    ${
      items.length
        ? html`<ol class="feedback-list feedback-list--compact">${items.map(
            (item) => html`<${FeedbackRow} key=${item.id} item=${item} showProject=${false} />`,
          )}</ol>`
        : html`<div class="feedback-dim">No feedback on this thread. Type <code>${FEEDBACK_COMMAND}</code> in the composer.</div>`
    }
  </div>`;
}

/**
 * Settings → Advanced → Feedback. Feedback is explicit (`/feedback`); automatic correction detection
 * (the detector → classify → route → tuning prompt loop) is opt-in.
 */
export function FeedbackSettings({ feedback, onSaved }) {
  const [busy, setBusy] = useState(false);
  const capture = feedback?.capture === true;
  const save = async (next) => {
    setBusy(true);
    try {
      const res = await authFetch('/api/settings/feedback', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ capture: next }),
      });
      const body = await res.json();
      if (!res.ok) throw Error(body.error || 'Could not save');
      onSaved?.(body);
      showToast(next ? 'Correction detection on' : 'Correction detection off', 'ok');
    } catch (error) {
      showToast(error.message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return html`<section class="settings-card">
    <div class="settings-card-header"><span class="settings-card-title">Feedback</span></div>
    <p class="settings-desc">Give feedback with <code>${FEEDBACK_COMMAND}</code> in a thread's composer, or from a message's ⋯ menu. It is recorded as you said it, on that thread and turn, and collects in the pinned Feedback inbox.</p>
    <div class="dev-mode-switch">
      <${Switch} label="Detect corrections automatically" checked=${capture} disabled=${busy}
        onChange=${save} />
      <span>Detect corrections automatically</span>
    </div>
    <p class="settings-desc">Off by default. When on, every message you type is checked for a correction; a detected one is classified, routed to a Warden and offered back as a tuning prompt. <code>/correction</code> works either way.</p>
  </section>`;
}
