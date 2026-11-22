/**
 * @atlas
 * @kind component
 * @partOf feature:viewer
 */
/**
 * The right panel: reference about the open thread, readable beside the conversation.
 *
 * A band holding the tab strip and the size controls, then a framed content area that opens with the
 * tab's title and one line of facts (a title above the tabs read as a stray message, Aron 11-16).
 * Tabs: Plan · Loop · Artifacts · Work · Context · Participants · Permissions · Heralds · Reminders ·
 * Feedback. When something is
 * inspected (an activity event, a span, a turn trace, a layer) the inspector takes the panel over,
 * with a way back to the tabs. Collapsed, it is a strip of the tabs with their counts.
 */
import { AccessSettings } from './access-settings.js';
import { Artifacts } from './artifacts.js';
import { AtlasTouches, SharedConcepts } from './atlas-panels.js';
import { ComingSoon } from './coming-soon.js';
import { ContextStats, TokenBar } from './conversation.js';
import { ParticipantsPanel } from './conversation-members.js';
import { Inspector, inspection, ThreadDetail } from './detail-drawer.js';
import { ExtensionBoundary, safeCall } from './error-boundary.js';
import { disableExtension } from './extension-loader.js';
import { feedbackIn, ThreadFeedback } from './feedback.js';
import { useFlowStream } from './graph-view.js';
import { html, useEffect, useState } from './lib.js';
import { LoopView, loopSummary, PointerLedger, pointerRows } from './loop-view.js';
import { SizeControls } from './panel-sizes.js';
import { Plan } from './plan.js';
import { SPEED_LABELS } from './run-picker.js';
import { Running } from './running.js';
import { SectionList } from './slot.js';
import {
  activeProjectId,
  activeThreadId,
  authFetch,
  boardOpen,
  detailDrawerOpen,
  dismissTraceSelection,
  inspectTarget,
  isFullWidthCustomView,
  launchLabels,
  loadLaunch,
  openRightTab,
  projects,
  RIGHT_TAB_KEYS,
  RIGHT_TAB_LABELS,
  railView,
  rightSize,
  rightTab,
  selectedEvent,
  selectedSpanId,
  showToast,
  threadData,
  threadLaunch,
  turnViewTarget,
  vendorName,
  watchtowerOpen,
} from './store.js';
import { TabIcon } from './tab-icons.js';
import { AgentsFact } from './thread-agents.js';
import { harnessName, projectLabel, ReferenceChips, threadPlace } from './thread-labels.js';
import { TurnView } from './turn-view.js';
import {
  RIGHT_PANEL_FLAG_DEFAULTS,
  readTabInfo,
  registerBuiltinRightTab,
  resolveActiveId,
  rightTabs,
  useComponentFlags,
} from './ui-registry.js';
import { Work } from './work.js';

/** A tab's tooltip: its label, and its key when it has one. */
const tabTitle = (t) => (t.key ? `${t.label} (${t.key})` : t.label);

const openFeedback = (threadId) =>
  feedbackIn({ threadId }).filter((item) => item.inbox === 'open').length;

/** Each tab's one line of facts under its title, and its count for the collapsed strip. */
function tabFacts(tab, threadId) {
  const active = threadId && threadData.value?.threadId === threadId ? threadData.value : null;
  const launch = active ? threadLaunch.value : null;
  const members = active?.conversation?.members ?? 0;
  const meta = active?.meta ?? {};
  switch (tab) {
    case 'plan':
      return { info: 'What the thread is for and why' };
    case 'loop':
      return { info: meta.loop ? loopSummary(meta.loop) : 'How the work is being done' };
    case 'artifacts': {
      const count = meta.artifacts?.length ?? 0;
      return {
        info: count ? `${count} made on this thread` : 'What the agent made to show you',
        count,
      };
    }
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
      return { info: 'Coming soon' };
    case 'pointers':
      return { info: 'What the Wardens reminded the agent of on this thread, newest first' };
    case 'feedback': {
      const open = openFeedback(threadId);
      return { info: `${feedbackIn({ threadId }).length} given · ${open} open`, count: open };
    }
    default:
      return { info: '' };
  }
}

/**
 * "When you send during a turn" (CORE-001), set for you: on this thread's project (over the
 * repository's), or Foundry-wide for a thread outside a project. Settings › Threads sets it for everyone.
 */
async function setSteer(threadId, projectId, steer) {
  try {
    const res = projectId
      ? await authFetch(`/api/projects/${encodeURIComponent(projectId)}/setting`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ scope: 'me', values: { steer } }),
        })
      : await authFetch('/api/settings/threads', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ steer }),
        });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw Error(body.error ?? res.statusText);
    await loadLaunch(threadId);
    showToast(
      steer ? 'Sends during a turn now steer into it' : 'Sends during a turn now queue',
      'ok',
      { thread: threadId },
    );
  } catch (error) {
    showToast(`Could not change it: ${error.message}`, 'error', { thread: threadId });
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
    showToast(`Could not change it: ${error.message}`, 'error', { thread: threadId });
  }
}

/** The project's hosted repository ({ integration, ref }), from its About record. */
function useRepository(projectId) {
  const [repo, setRepo] = useState(undefined);
  // Only a registered project has an About; an unregistered folder has no repository to show.
  const registered = !!projectId && projects.value.some((p) => p.id === projectId);
  useEffect(() => {
    if (!registered) return setRepo(null);
    let live = true;
    authFetch(`/api/projects/${encodeURIComponent(projectId)}/about`)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)
      .then((about) => live && setRepo(about?.repository ?? null));
    return () => {
      live = false;
    };
  }, [projectId, registered]);
  return repo;
}

function ContextTab({ flags }) {
  const launch = threadLaunch.value;
  const threadId = activeThreadId.value;
  const meta = threadData.value?.meta ?? {};
  const repo = useRepository(meta.projectId ?? null);
  const refs = meta.context?.references ?? [];
  const tickets = refs.filter((r) => r.integration === 'linear' || r.kind === 'issue');
  const pulls = refs.filter((r) => r.integration === 'github' && !tickets.includes(r));
  const other = refs.filter((r) => !tickets.includes(r) && !pulls.includes(r));
  const chips = (references) =>
    html`<div class="rp-refs"><${ReferenceChips} meta=${{ context: { references } }} /></div>`;
  const branch = threadPlace(meta).branch;
  const github = repo?.integration === 'github' ? repo.ref : null;
  const ctx = { threadId, thread: threadData.value, launch, flags };

  const sections = [
    {
      id: 'github',
      render: () => html`<section class="rp-section" aria-label="GitHub">
        <h3 class="rp-section-title">GitHub</h3>
        ${
          github
            ? html`<a class="rp-link-chip" href=${`https://github.com/${github}${branch ? `/tree/${encodeURIComponent(branch)}` : ''}`} target="_blank" rel="noopener noreferrer">${github}${branch ? ` · ${branch}` : ''} ↗</a>`
            : html`<div class="rp-dim">${repo === undefined ? 'Reading the project…' : 'No GitHub repository recorded for this project.'}</div>`
        }
        ${pulls.length ? chips(pulls) : null}
      </section>`,
    },
    {
      id: 'ticket',
      render: () => html`<section class="rp-section" aria-label="Ticket">
        <h3 class="rp-section-title">Ticket</h3>
        ${tickets.length ? chips(tickets) : html`<div class="rp-dim">No ticket yet.</div>`}
        ${flags.showComingSoon ? html`<${ComingSoon} inline=${true} what="New ticket: open one in Linear from this thread." ticket="BOARD-003" />` : null}
      </section>`,
    },
  ];
  if (flags.showComingSoon) {
    sections.push({
      id: 'slack',
      render: () => html`<section class="rp-section" aria-label="Slack">
        <h3 class="rp-section-title">Slack</h3>
        <${ComingSoon} what="The Slack conversation behind this thread, a short excerpt, and Go to Slack to talk to these people or read it there." ticket="BOARD-003" />
      </section>`,
    });
  }
  if (other.length) {
    sections.push({
      id: 'other-links',
      render: () => html`<section class="rp-section" aria-label="Other links">
        <h3 class="rp-section-title">Other links</h3>${chips(other)}
      </section>`,
    });
  }
  sections.push({
    id: 'runs-on',
    render: () => html`<section class="rp-section">
      <h3 class="rp-section-title">Runs on</h3>
      ${
        launch
          ? html`<dl class="rp-facts">
            <dt>Model</dt><dd>
              <select class="rp-select" value=${launch.model ?? ''}
                onChange=${(e) => e.target.value && setLaunch(threadId, { model: e.target.value })}>
                ${(launch.options?.models ?? []).some((m) => m.id === launch.model) ? null : html`<option value=${launch.model ?? ''}>${launchLabels(launch.provider, launch.model).model ?? launch.model ?? '—'}</option>`}
                ${(launch.options?.models ?? []).map((m) => html`<option key=${m.id} value=${m.id}>${m.label ?? m.id}</option>`)}
              </select>
            </dd>
            <dt>Effort</dt><dd>
              <select class="rp-select" value=${launch.effort ?? ''}
                onChange=${(e) => setLaunch(threadId, { effort: e.target.value || null })}>
                <option value="">${launch.effortDefault ? `${launch.effortDefault} (default)` : 'Default'}</option>
                ${(launch.options?.efforts ?? []).map((e) => html`<option key=${e} value=${e}>${e}</option>`)}
              </select>
            </dd>
            ${
              (launch.options?.speeds ?? []).length
                ? html`<dt>Speed</dt><dd>
                    <select class="rp-select" value=${launch.speed ?? ''}
                      onChange=${(e) => setLaunch(threadId, { speed: e.target.value || null })}>
                      <option value="">${launch.speedDefault ? `${SPEED_LABELS[launch.speedDefault] ?? launch.speedDefault} (default)` : 'Default'}</option>
                      ${(launch.options?.speeds ?? []).map((s) => html`<option key=${s} value=${s}>${SPEED_LABELS[s] ?? s}</option>`)}
                    </select>
                  </dd>`
                : null
            }
            <dt>Provider</dt><dd title=${harnessName(launch.provider) ? `Runs through ${harnessName(launch.provider)}` : ''}>${vendorName(launch.provider) ?? '—'}</dd>
            <${AgentsFact} />
          </dl>
          <p class="rp-dim">A change applies on the thread’s next turn.</p>
          <label class="steer-setting" data-setting="steer">When you send during a turn
            <select class="rp-select" value=${launch.steer === false ? 'queue' : 'steer'}
              onChange=${(e) => setSteer(threadId, threadData.value?.meta?.projectId, e.target.value === 'steer')}>
              <option value="steer">Steer it into the turn</option>
              <option value="queue">Queue it after</option>
            </select>
          </label>
          <p class="rp-dim">Set for you${threadData.value?.meta?.projectId ? ' on this project' : ''}. ⌘↵ always queues; a queued message can always be steered in.</p>`
          : html`<div class="rp-dim">Reading the thread’s launch settings…</div>`
      }
    </section>`,
  });
  sections.push({
    id: 'atlas-touches',
    render: () =>
      html`<${AtlasTouches} threadId=${threadData.value?.threadId} project=${projectLabel(threadData.value?.meta?.projectId)} />`,
  });
  if (flags.showComingSoon) {
    sections.push({
      id: 'loaded-on-arrival',
      render: () => html`<section class="rp-section">
        <h3 class="rp-section-title">Loaded when it arrived</h3>
        <${ComingSoon}
          what="For a Slack, Linear or GitHub item that opened this thread: what the agent read before you opened it (the message, the ticket, the files, the sender)."
          ticket="BOARD-003" />
      </section>`,
    });
  }
  if (flags.showUsageBar) {
    sections.push({
      id: 'token-bar',
      render: () => html`<${TokenBar} />`,
    });
  }
  sections.push(
    { id: 'context-stats', render: () => html`<${ContextStats} />` },
    { id: 'thread-detail', render: () => html`<${ThreadDetail} />` },
  );

  return html`<div class="rp-stack">
    <${SectionList} slot="rightPanel.context.sections" items=${sections} context=${ctx} />
  </div>`;
}

function PermissionsTab({ flags }) {
  const launch = threadLaunch.value;
  const projectId = threadData.value?.meta?.projectId ?? null;
  const ctx = {
    threadId: activeThreadId.value,
    thread: threadData.value,
    launch,
    projectId,
    flags,
  };
  const sections = [
    {
      id: 'access-mode',
      render: () => html`<section class="rp-section">
        <h3 class="rp-section-title">Beyond its normal set</h3>
        <dl class="rp-facts">
          <dt>Access mode</dt>
          <dd>${launch?.permissionMode ?? html`<span class="rp-dim">follows the host (Claude Code, Codex)</span>`}</dd>
        </dl>
        <p class="rp-dim">
          Members’ Signets and what each may read are on the Participants tab. Signets are issued,
          revised and revoked in Kingdom.
        </p>
      </section>`,
    },
    {
      id: 'kingdom-grants',
      render: () => html`<section class="rp-section">
        <h3 class="rp-section-title">Baseline: this project’s Kingdom grants</h3>
        <${AccessSettings} projectId=${projectId} />
      </section>`,
    },
  ];
  return html`<div class="rp-stack">
    <${SectionList} slot="rightPanel.permissions.sections" items=${sections} context=${ctx} />
  </div>`;
}

function HeraldsTab({ flags }) {
  const ctx = { threadId: activeThreadId.value, thread: threadData.value, flags };
  const sections = [];
  if (flags.showComingSoon) {
    sections.push({
      id: 'coming-soon',
      render: () => html`<${ComingSoon}
        what="How this thread looks to the Heralds: teammates’ threads touching the same files, related threads, past work it repeats, and who else is watching."
        ticket="AGENT-001" />`,
    });
  }
  sections.push({
    id: 'shared-concepts',
    render: () => html`<section class="rp-section">
      <h3 class="rp-section-title">Shared Atlas concepts</h3>
      <p class="rp-dim">Other threads in this project touching the same concepts (this machine’s threads, until Heralds bring teammates’).</p>
      <${SharedConcepts} threadId=${threadData.value?.threadId} project=${projectLabel(threadData.value?.meta?.projectId)} />
    </section>`,
  });
  return html`<div class="rp-stack">
    <${SectionList} slot="rightPanel.heralds.sections" items=${sections} context=${ctx} />
  </div>`;
}

/** The Wardens' pointers that reached this thread, newest first (moved here from Loop, Aron 11-02). */
function PointersTab({ threadId }) {
  const flow = useFlowStream(threadId, !!threadId);
  return html`<div class="rp-stack"><${PointerLedger} rows=${pointerRows(flow)} /></div>`;
}

const BUILTIN_RIGHT_TAB_RENDERERS = {
  plan: () => html`<${Plan} />`,
  loop: () => html`<${LoopView} />`,
  artifacts: () => html`<${Artifacts} />`,
  work: () => html`<${Work} />`,
  context: ({ flags }) => html`<${ContextTab} flags=${flags} />`,
  participants: () => html`<${ParticipantsPanel} />`,
  permissions: ({ flags }) => html`<${PermissionsTab} flags=${flags} />`,
  heralds: ({ flags }) => html`<${HeraldsTab} flags=${flags} />`,
  pointers: ({ threadId }) => html`<${PointersTab} threadId=${threadId} />`,
  feedback: ({ threadId }) => html`<${ThreadFeedback} threadId=${threadId} />`,
};

for (const id of Object.keys(BUILTIN_RIGHT_TAB_RENDERERS)) {
  registerBuiltinRightTab({
    id,
    label: RIGHT_TAB_LABELS[id],
    key: RIGHT_TAB_KEYS[id],
    info: ({ threadId }) => tabFacts(id, threadId).info,
    badge: ({ threadId }) => tabFacts(id, threadId).count ?? null,
    render: BUILTIN_RIGHT_TAB_RENDERERS[id],
  });
}

const RIGHT_PANEL_CONTROLS = [
  { id: 'size-controls', render: () => html`<${SizeControls} side="right" />` },
];

/** Leave the inspector: back to the panel's tabs. */
function closeInspector() {
  dismissTraceSelection();
  selectedEvent.value = null;
  selectedSpanId.value = null;
  inspectTarget.value = null;
}

function readTabBadge(tabDef, ctx) {
  if (typeof tabDef.badge !== 'function') return null;
  return tabDef.extId
    ? safeCall(tabDef.extId, () => tabDef.badge(ctx), null, 'rightTab.badge')
    : tabDef.badge(ctx);
}

function renderRightTabBadge(tabDef, ctx) {
  const val = readTabBadge(tabDef, ctx);
  if (val === null || val === undefined || val === false || val === 0 || val === '') return null;
  if (typeof val === 'number' || typeof val === 'string') {
    return html`<span class="rp-tab-count ${tabDef.id === 'feedback' ? 'is-attention' : ''}">${val}</span>`;
  }
  return val;
}

const tabNeedsThread = (tab) => Boolean(tab?.requiresThread);

export function RightPanel({ onSpanSelect }) {
  const threadId = activeThreadId.value;
  const projectId = activeProjectId.value;
  const tabs = rightTabs();
  const activeId = resolveActiveId(tabs, rightTab.value, 'context');
  const activeTab = tabs.find((t) => t.id === activeId) ?? tabs[0];
  const flags = useComponentFlags('rightPanel', RIGHT_PANEL_FLAG_DEFAULTS);
  const fullWorkspace = boardOpen.value || watchtowerOpen.value || isFullWidthCustomView();
  // The board, Watchtower and full-width custom views take the width: the panel folds while any is open.
  const open = detailDrawerOpen.value && !fullWorkspace;
  const target = inspection(inspectTarget.value?.kind === 'layer' ? inspectTarget.value.id : null);
  const rpCtx = {
    railView: railView.value,
    activeThreadId: threadId,
    threadId,
    projectId,
    thread: threadData.value,
    launch: threadLaunch.value,
    flags,
    side: 'right',
    onSpanSelect,
  };
  const hasThread = Boolean(threadId && threadData.value);
  const hasStandaloneTab = tabs.some((t) => !tabNeedsThread(t));

  // The turn view opens here, at the panel's widest step; the thread stays in the centre.
  if (turnViewTarget.value && !fullWorkspace)
    return html`<div class="right-panel detail-drawer right-panel--turn"><${TurnView} key=${turnViewTarget.value.turnId} /></div>`;

  if (!open)
    return rightSize.value === 'hidden' && !fullWorkspace
      ? html`<div class="panel-hidden" aria-hidden="true"></div>`
      : html`<div class="right-panel detail-drawer detail-drawer--collapsed right-panel--collapsed">
      <div class="rp-strip-controls">
        <${SectionList} slot="rightPanel.controls" items=${RIGHT_PANEL_CONTROLS} context=${rpCtx} />
      </div>
      ${tabs.map((t) => {
        return html`<button key=${t.id} class="rp-strip-tab" data-rtab-id=${t.id} title=${tabTitle(t)} aria-label=${`Open ${t.label}`}
          aria-current=${t.id === activeId ? 'true' : undefined} onClick=${() => openRightTab(t.id)}>
          <${TabIcon} tab=${t.id} icon=${t.icon} extId=${t.extId} /><span class="rp-strip-label">${t.label}</span>
        </button>`;
      })}
    </div>`;

  if (target)
    return html`<div class="right-panel detail-drawer">
      <header class="rp-band">
        <div class="rp-band-row">
          <button class="rp-back" onClick=${closeInspector}>← ${activeTab?.label ?? 'Back'}</button>
          <span class="rp-eyebrow">Inspector</span>
          ${target.kind === 'trace' || target.kind === 'span' ? html`<button class="rp-back back-btn" onClick=${() => dismissTraceSelection()}>Clear</button>` : null}
          <${SectionList} slot="rightPanel.controls" items=${RIGHT_PANEL_CONTROLS} context=${rpCtx} />
        </div>
        <h2 class="rp-title">${target.title}</h2>
      </header>
      <div class="rp-frame"><${Inspector} target=${target} onSpanSelect=${onSpanSelect} /></div>
    </div>`;

  if (!hasThread && !hasStandaloneTab)
    return html`<div class="right-panel detail-drawer">
      <header class="rp-band"><h2 class="rp-title">No thread open</h2></header>
      <div class="rp-frame"><div class="rp-empty">Open a thread to see its plan, loop, artifacts, work and context.</div></div>
    </div>`;

  const missingThread = !hasThread && tabNeedsThread(activeTab);
  const info = activeTab && !missingThread ? readTabInfo(activeTab, rpCtx, 'rightTab.info') : '';
  const renderedBody = missingThread
    ? html`<div class="rp-empty">Open a thread to view ${activeTab?.label ?? 'this tab'}.</div>`
    : activeTab?.extId
      ? html`<${ExtensionBoundary} key=${activeTab.id} extId=${activeTab.extId} slot="rightPanel.tabs" onDisable=${disableExtension} render=${activeTab.render} ctx=${rpCtx} />`
      : activeTab?.render(rpCtx);

  return html`<div class="right-panel detail-drawer">
    <header class="rp-band">
      <div class="rp-band-row rp-head-row">
        <nav class="rp-tabs" role="tablist" aria-label="Thread reference">
        ${tabs.map((t) => {
          const badge = !hasThread && tabNeedsThread(t) ? null : renderRightTabBadge(t, rpCtx);
          return html`<button key=${t.id} role="tab" aria-selected=${t.id === activeId}
            data-rtab-id=${t.id} aria-label=${t.label}
            class="rp-tab ${t.id === activeId ? 'is-active' : ''}" title=${tabTitle(t)}
            onClick=${() => {
              rightTab.value = t.id;
            }}><${TabIcon} tab=${t.id} icon=${t.icon} extId=${t.extId} /><span class="rp-tab-label">${t.label}</span>${badge}</button>`;
        })}
      </nav>
      <${SectionList} slot="rightPanel.controls" items=${RIGHT_PANEL_CONTROLS} context=${rpCtx} />
      </div>
    </header>
    <div class="rp-frame" role="tabpanel" aria-label=${activeTab?.label ?? ''}>
      <header class="rp-tab-head">
        <h2 class="rp-title">${activeTab?.label ?? ''}</h2>
        ${info ? html`<div class="rp-info">${info}</div>` : null}
      </header>
      ${
        !missingThread && activeTab?.defaultSide === 'left'
          ? html`<div class="rp-moved-rail">${renderedBody}</div>`
          : renderedBody
      }
    </div>
    ${hasThread && flags.showRunningFooter ? html`<${Running} threadId=${threadId} />` : null}
  </div>`;
}
