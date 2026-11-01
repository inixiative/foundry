/**
 * @atlas
 * @kind component
 * @partOf feature:viewer
 */
/**
 * The right panel: reference about the open thread, readable beside the conversation.
 *
 * A header band (the tab's title and one line of facts), a tab strip, and a framed content area.
 * Tabs: Context · Participants · Permissions · Heralds · Pointers · Feedback. When something is
 * inspected (an activity event, a span, a turn trace, a layer) the inspector takes the panel over,
 * with a way back to the tabs. Collapsed, it is a strip of the tabs with their counts.
 */
import { AccessSettings } from './access-settings.js';
import { ContextStats, TokenBar } from './conversation.js';
import { ParticipantsPanel } from './conversation-members.js';
import { Inspector, inspection, ThreadDetail } from './detail-drawer.js';
import { feedbackIn, ThreadFeedback } from './feedback.js';
import { useFlowStream } from './graph-view.js';
import { html } from './lib.js';
import {
  activeThreadId,
  authFetch,
  boardOpen,
  detailDrawerOpen,
  dismissTraceSelection,
  focusTurnId,
  inspectTarget,
  RIGHT_TABS,
  rightTab,
  selectedEvent,
  selectedSpanId,
  showToast,
  threadData,
  threadLaunch,
} from './store.js';
import { harnessName } from './thread-labels.js';

const TAB_LABELS = {
  context: 'Context',
  participants: 'Participants',
  permissions: 'Permissions',
  heralds: 'Heralds',
  pointers: 'Pointers',
  feedback: 'Feedback',
};

const openFeedback = (threadId) =>
  feedbackIn({ threadId }).filter((item) => item.inbox === 'open').length;

/** Each tab's one line of facts for the header band, and its count for the collapsed strip. */
function tabFacts(tab, threadId, pointerCount) {
  const launch = threadLaunch.value;
  const members = threadData.value?.conversation?.members ?? 0;
  switch (tab) {
    case 'context':
      return {
        info: [launch?.model, launch?.effort, harnessName(launch?.provider)]
          .filter(Boolean)
          .join(' · '),
      };
    case 'participants':
      return {
        info: members ? `${members} member${members > 1 ? 's' : ''}` : 'Only you',
        count: members,
      };
    case 'permissions':
      return {
        info: launch?.permissionMode
          ? `Access mode: ${launch.permissionMode}`
          : 'Access follows the host',
      };
    case 'heralds':
      return { info: 'Not running yet' };
    case 'pointers':
      return { info: `${pointerCount} delivered in the last turns`, count: pointerCount };
    case 'feedback': {
      const open = openFeedback(threadId);
      return { info: `${feedbackIn({ threadId }).length} given · ${open} open`, count: open };
    }
    default:
      return { info: '' };
  }
}

/** Warden pointers that reached this thread: one row per contributing domain per turn. */
function pointerRows(flow) {
  const rows = [];
  for (const turn of flow.turns ?? []) {
    const contributions = Array.isArray(turn.plan?.contributions) ? turn.plan.contributions : [];
    for (const c of contributions)
      if (c.decision === 'contribute')
        rows.push({
          key: `${turn.turnId}:${c.domain}`,
          turnId: turn.turnId,
          domain: c.domain,
          input: turn.input?.preview ?? '',
          snippets: Array.isArray(c.snippets)
            ? c.snippets.filter((s) => typeof s === 'string')
            : [],
          reason: c.reason ?? null,
        });
  }
  return rows.reverse();
}

function PointersTab({ rows }) {
  if (!rows.length)
    return html`<div class="rp-empty">
      No Warden has pointed at anything on this thread’s recent turns. When one does, its pointer
      (the rule or doc, and where it’s written) is listed here with the turn it came in.
    </div>`;
  return html`<ul class="rp-list">
    ${rows.map(
      (r) => html`<li key=${r.key} class="rp-pointer">
        <div class="rp-pointer-head">
          <span class="rp-pointer-domain">† ${r.domain}</span>
          <button class="rp-link" onClick=${() => {
            focusTurnId.value = r.turnId;
          }} title="Show the turn">turn ›</button>
        </div>
        ${r.snippets.map((s, i) => html`<div key=${i} class="rp-pointer-text">${s}</div>`)}
        ${!r.snippets.length && r.reason ? html`<div class="rp-pointer-text">${r.reason}</div>` : null}
        ${r.input ? html`<div class="rp-pointer-input" title="The message it answered">${r.input}</div>` : null}
      </li>`,
    )}
  </ul>`;
}

/** Change the thread's model or effort (applies on its next turn: its idle session relaunches). */
async function setLaunch(threadId, patch) {
  try {
    const res = await authFetch(`/api/threads/${encodeURIComponent(threadId)}/launch`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    const body = await res.json();
    if (!res.ok) throw Error(body.error ?? res.statusText);
    threadLaunch.value = body;
  } catch (error) {
    showToast(`Could not change it: ${error.message}`, 'error');
  }
}

function ContextTab() {
  const launch = threadLaunch.value;
  const threadId = activeThreadId.value;
  return html`<div class="rp-stack">
    <section class="rp-section">
      <h3 class="rp-section-title">Model</h3>
      ${
        launch
          ? html`<dl class="rp-facts">
            <dt>Model</dt><dd>
              <select class="rp-select" value=${launch.modelOverride ?? ''}
                onChange=${(e) => setLaunch(threadId, { model: e.target.value || null })}>
                <option value="">Project default (${launch.model ?? 'default'})</option>
                ${(launch.options?.models ?? []).map((m) => html`<option key=${m.id} value=${m.id}>${m.label ?? m.id}</option>`)}
              </select>
            </dd>
            <dt>Effort</dt><dd>
              <select class="rp-select" value=${launch.effort ?? ''}
                onChange=${(e) => setLaunch(threadId, { effort: e.target.value || null })}>
                <option value="">Harness default</option>
                ${(launch.options?.efforts ?? []).map((e) => html`<option key=${e} value=${e}>${e}</option>`)}
              </select>
            </dd>
            <dt>Harness</dt><dd>${harnessName(launch.provider) ?? '—'}</dd>
            <dt>Provider</dt><dd class="rp-mono">${launch.provider ?? '—'}</dd>
          </dl>
          <p class="rp-dim">A change applies on the thread’s next turn.</p>`
          : html`<div class="rp-dim">Reading the thread’s launch settings…</div>`
      }
    </section>
    <${TokenBar} />
    <${ContextStats} />
    <${ThreadDetail} />
  </div>`;
}

function PermissionsTab() {
  const launch = threadLaunch.value;
  const projectId = threadData.value?.meta?.projectId ?? null;
  return html`<div class="rp-stack">
    <section class="rp-section">
      <h3 class="rp-section-title">Beyond its normal set</h3>
      <dl class="rp-facts">
        <dt>Access mode</dt>
        <dd>${launch?.permissionMode ?? html`<span class="rp-dim">follows the host (Claude Code, Codex)</span>`}</dd>
      </dl>
      <p class="rp-dim">
        Members’ Signets and what each may read are on the Participants tab. Signets are issued,
        revised and revoked in Kingdom.
      </p>
    </section>
    <section class="rp-section">
      <h3 class="rp-section-title">Baseline: this project’s Kingdom grants</h3>
      <${AccessSettings} projectId=${projectId} />
    </section>
  </div>`;
}

function HeraldsTab() {
  return html`<div class="rp-empty">
    Heralds aren’t running yet. When they are, this tab shows how this thread looks to them:
    teammates’ threads touching the same files, related threads, past work it repeats, and who
    else is watching.
  </div>`;
}

function TabBody({ tab, threadId, pointers }) {
  if (tab === 'context') return html`<${ContextTab} />`;
  if (tab === 'participants') return html`<${ParticipantsPanel} />`;
  if (tab === 'permissions') return html`<${PermissionsTab} />`;
  if (tab === 'heralds') return html`<${HeraldsTab} />`;
  if (tab === 'pointers') return html`<${PointersTab} rows=${pointers} />`;
  return html`<${ThreadFeedback} threadId=${threadId} />`;
}

/** Leave the inspector: back to the panel's tabs. */
function closeInspector() {
  dismissTraceSelection();
  selectedEvent.value = null;
  selectedSpanId.value = null;
  inspectTarget.value = null;
}

export function RightPanel({ onSpanSelect }) {
  const threadId = activeThreadId.value;
  const tab = rightTab.value;
  // The board takes the width: the panel folds while it is open.
  const open = detailDrawerOpen.value && !boardOpen.value;
  const flow = useFlowStream(threadId, open && tab === 'pointers');
  const pointers = pointerRows(flow);
  const target = inspection(inspectTarget.value?.kind === 'layer' ? inspectTarget.value.id : null);

  if (!open)
    return html`<div class="right-panel detail-drawer detail-drawer--collapsed right-panel--collapsed">
      <button class="rp-strip-toggle" title="Open the right panel (])" onClick=${() => {
        boardOpen.value = false;
        detailDrawerOpen.value = true;
      }}>‹</button>
      ${RIGHT_TABS.map((t) => {
        const count = threadId ? tabFacts(t, threadId, pointers.length).count : 0;
        return html`<button key=${t} class="rp-strip-tab" title=${TAB_LABELS[t]} onClick=${() => {
          rightTab.value = t;
          boardOpen.value = false;
          detailDrawerOpen.value = true;
        }}>
          <span class="rp-strip-label">${TAB_LABELS[t]}</span>
          ${count ? html`<span class="rp-count">${count}</span>` : null}
        </button>`;
      })}
    </div>`;

  if (target)
    return html`<div class="right-panel detail-drawer">
      <header class="rp-band">
        <div class="rp-band-row">
          <button class="rp-back" onClick=${closeInspector}>← ${TAB_LABELS[tab]}</button>
          <span class="rp-eyebrow">Inspector</span>
          ${target.kind === 'trace' || target.kind === 'span' ? html`<button class="rp-back back-btn" onClick=${() => dismissTraceSelection()}>Clear</button>` : null}
          <button class="rp-collapse" title="Collapse (])" onClick=${() => {
            detailDrawerOpen.value = false;
          }}>›</button>
        </div>
        <h2 class="rp-title">${target.title}</h2>
      </header>
      <div class="rp-frame"><${Inspector} target=${target} onSpanSelect=${onSpanSelect} /></div>
    </div>`;

  if (!threadId || !threadData.value)
    return html`<div class="right-panel detail-drawer">
      <header class="rp-band"><h2 class="rp-title">No thread open</h2></header>
      <div class="rp-frame"><div class="rp-empty">Open a thread to see its context, participants, permissions and feedback.</div></div>
    </div>`;

  const facts = tabFacts(tab, threadId, pointers.length);
  return html`<div class="right-panel detail-drawer">
    <header class="rp-band">
      <div class="rp-band-row">
        <span class="rp-eyebrow">This thread</span>
        <button class="rp-collapse" title="Collapse (])" onClick=${() => {
          detailDrawerOpen.value = false;
        }}>›</button>
      </div>
      <h2 class="rp-title">${TAB_LABELS[tab]}</h2>
      ${facts.info ? html`<div class="rp-info">${facts.info}</div>` : null}
      <nav class="rp-tabs" role="tablist" aria-label="Thread reference">
        ${RIGHT_TABS.map((t, i) => {
          const count = tabFacts(t, threadId, pointers.length).count;
          return html`<button key=${t} role="tab" aria-selected=${t === tab}
            class="rp-tab ${t === tab ? 'is-active' : ''}" title=${`${TAB_LABELS[t]} (${i === 5 ? 0 : i + 5})`}
            onClick=${() => {
              rightTab.value = t;
            }}>${TAB_LABELS[t]}${count ? html`<span class="rp-count">${count}</span>` : null}</button>`;
        })}
      </nav>
    </header>
    <div class="rp-frame" role="tabpanel">
      <${TabBody} tab=${tab} threadId=${threadId} pointers=${pointers} />
    </div>
  </div>`;
}
