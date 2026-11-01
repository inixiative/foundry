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
import { html } from './lib.js';
import { SizeControls } from './panel-sizes.js';
import { Running } from './running.js';
import { STEER_NOT_BUILT } from './steering.js';
import {
  activeThreadId,
  authFetch,
  boardOpen,
  detailDrawerOpen,
  dismissTraceSelection,
  inspectTarget,
  launchLabels,
  RIGHT_TABS,
  rightSize,
  rightTab,
  selectedEvent,
  selectedSpanId,
  showToast,
  threadData,
  threadLaunch,
  vendorName,
  watchtowerOpen,
} from './store.js';
import { TabIcon } from './tab-icons.js';
import { harnessName, ReferenceChips } from './thread-labels.js';
import { Work } from './work.js';

const TAB_LABELS = {
  work: 'Work',
  context: 'Context',
  participants: 'Participants',
  permissions: 'Permissions',
  heralds: 'Heralds',
  feedback: 'Feedback',
};

const openFeedback = (threadId) =>
  feedbackIn({ threadId }).filter((item) => item.inbox === 'open').length;

/** Each tab's one line of facts for the header band, and its count for the collapsed strip. */
function tabFacts(tab, threadId) {
  const launch = threadLaunch.value;
  const members = threadData.value?.conversation?.members ?? 0;
  switch (tab) {
    case 'context':
      return {
        info: [
          launchLabels(launch?.provider, launch?.model).provider,
          launchLabels(launch?.provider, launch?.model).model,
          launch?.effort,
        ]
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
    case 'feedback': {
      const open = openFeedback(threadId);
      return { info: `${feedbackIn({ threadId }).length} given · ${open} open`, count: open };
    }
    default:
      return { info: '' };
  }
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
                <option value="">${launchLabels(launch.provider, launch.model).model ? `Project default (${launchLabels(launch.provider, launch.model).model})` : 'Project default'}</option>
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
            <dt>Provider</dt><dd title=${harnessName(launch.provider) ? `Runs through ${harnessName(launch.provider)}` : ''}>${vendorName(launch.provider) ?? '—'}</dd>
          </dl>
          <p class="rp-dim">A change applies on the thread’s next turn.</p>
          <label class="steer-setting" title=${STEER_NOT_BUILT}>When you send during a turn
            <select class="rp-select" disabled>
              <option>Steer it in (project default)</option>
              <option>Queue it</option>
            </select>
          </label>
          <p class="rp-dim">${STEER_NOT_BUILT}: every message queues for now. The setting will inherit project, then device.</p>`
          : html`<div class="rp-dim">Reading the thread’s launch settings…</div>`
      }
    </section>
    <section class="rp-section">
      <h3 class="rp-section-title">Linked work</h3>
      ${
        (threadData.value?.meta?.context?.references ?? []).length
          ? html`<div class="rp-refs"><${ReferenceChips} meta=${threadData.value?.meta || {}} /></div>`
          : html`<div class="rp-dim">No linked tickets or pull requests.</div>`
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

function TabBody({ tab, threadId }) {
  if (tab === 'work') return html`<${Work} />`;
  if (tab === 'context') return html`<${ContextTab} />`;
  if (tab === 'participants') return html`<${ParticipantsPanel} />`;
  if (tab === 'permissions') return html`<${PermissionsTab} />`;
  if (tab === 'heralds') return html`<${HeraldsTab} />`;
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
  // The board and the Watchtower take the width: the panel folds while either is open.
  const open = detailDrawerOpen.value && !boardOpen.value && !watchtowerOpen.value;
  const target = inspection(inspectTarget.value?.kind === 'layer' ? inspectTarget.value.id : null);

  if (!open)
    return rightSize.value === 'hidden' && !boardOpen.value && !watchtowerOpen.value
      ? html`<div class="panel-hidden" aria-hidden="true"></div>`
      : html`<div class="right-panel detail-drawer detail-drawer--collapsed right-panel--collapsed">
      <div class="rp-strip-controls"><${SizeControls} side="right" /></div>
      ${RIGHT_TABS.map((t) => {
        return html`<button key=${t} class="rp-strip-tab" title=${TAB_LABELS[t]} onClick=${() => {
          rightTab.value = t;
          boardOpen.value = false;
          detailDrawerOpen.value = true;
        }}>
          <${TabIcon} tab=${t} /><span class="rp-strip-label">${TAB_LABELS[t]}</span>
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
          <${SizeControls} side="right" />
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

  const facts = tabFacts(tab, threadId);
  return html`<div class="right-panel detail-drawer">
    <header class="rp-band">
      <div class="rp-band-row">
        <span class="rp-eyebrow">This thread</span>
        <${SizeControls} side="right" />
      </div>
      <h2 class="rp-title">${TAB_LABELS[tab]}</h2>
      ${facts.info ? html`<div class="rp-info">${facts.info}</div>` : null}
      <nav class="rp-tabs" role="tablist" aria-label="Thread reference">
        ${RIGHT_TABS.map((t, i) => {
          return html`<button key=${t} role="tab" aria-selected=${t === tab}
            class="rp-tab ${t === tab ? 'is-active' : ''}" title=${`${TAB_LABELS[t]} (${i + 5})`}
            onClick=${() => {
              rightTab.value = t;
            }}><${TabIcon} tab=${t} />${TAB_LABELS[t]}</button>`;
        })}
      </nav>
    </header>
    <div class="rp-frame" role="tabpanel">
      <${TabBody} tab=${tab} threadId=${threadId} />
    </div>
    <${Running} threadId=${threadId} />
  </div>`;
}
