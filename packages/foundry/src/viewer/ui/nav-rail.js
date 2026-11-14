/**
 * @atlas
 * @kind component
 * @partOf feature:viewer
 */
/**
 * The left rail, two rows of tabs: Attention | Open | Projects, then Scheduled | Status (⌥⇧← ⌥⇧→
 * step through all five; Aron, 2026-11-14: "You can have those tabs be two rows").
 *
 * Attention is the open top-level threads that need you, across projects: red (can't proceed) first,
 * then orange (a decision for you: a question, an approval, a request; or an answer you haven't
 * read), by `effectiveCategory`, the one "needs you" definition. A thread only waiting (a plan
 * outcome left on you, a draft, a pause) is in Open, not here (Aron, 2026-11-14: "Attention means I
 * have to look at it, and it needs a decision from me, or it has an answer for me"). A thread that is
 * working, queued or idle drops out and comes back when it hands back; the thread you have open stays
 * listed until you move on.
 *
 * Open is every open thread across projects, in two fixed halves that each scroll on their own:
 * Yours on top, Shared (another party is a member) below. Projects is today's sidebar: the pinned
 * scopes, the project list, and the selected scope's threads. Rows are two lines: the name, then the
 * status icon, the project and any counts. Scheduled is the work that runs on its own: schedules (each
 * with its past runs; an agent's draft counts on the tab) and every thread running a loop.
 * Status is this machine and its resources (machine-status.js), a view of its own so the thread
 * views keep the rail's full height (Aron, 2026-11-14).
 */
import { Attention, effectiveCategory, openRoots } from './attention.js';
import { IncomingRows } from './incoming.js';
import { html } from './lib.js';
import { MachineStatus } from './machine-status.js';
import { panelFit, SizeControls } from './panel-sizes.js';
import { ProjectSidebar } from './project-sidebar.js';
import { openNewThread } from './run-picker.js';
import { draftCount, ScheduleList } from './schedules.js';
import {
  activeThreadId,
  allThreads,
  leftSize,
  projectSidebarOpen,
  RAIL_ROWS,
  railView,
  selectThread,
} from './store.js';
import { isClosedThread } from './thread-status.js';
import { ThreadNode, threadTree } from './thread-tree.js';

const OPEN = (t) => !isClosedThread(t);
/** Shared: another party (a Signet member) is in the thread. */
const isShared = (node) => (node.conversation?.members ?? 0) > 0;

const RAIL_LABELS = {
  attention: 'Attention',
  open: 'Open',
  projects: 'Projects',
  scheduled: 'Scheduled',
  status: 'Status',
};
/** The tabs in their two rows: where you work, then what runs without you and the machine. */
/** Red before orange in the Attention rail. */
const URGENCY = { problem: 0, attention: 1 };

function RailToggle() {
  const view = railView.value;
  return html`<div class="rail-toggle" role="tablist" aria-label="Left rail">
    ${RAIL_ROWS.map(
      (row, i) =>
        html`<div key=${i} class="rail-toggle-row">${row.map(
          (id) => html`<button key=${id} role="tab" aria-selected=${view === id}
          class="rail-toggle-btn ${view === id ? 'is-active' : ''}" title=${`${RAIL_LABELS[id]} (⌥⇧← ⌥⇧→)`}
          onClick=${() => {
            railView.value = id;
          }}>${RAIL_LABELS[id]}${
            id === 'scheduled' && draftCount()
              ? html`<span class="rail-toggle-badge" title="Schedules an agent proposed, waiting for you">${draftCount()}</span>`
              : null
          }</button>`,
        )}</div>`,
    )}
  </div>`;
}

function Pane({ title, count, children, empty, lead, nodes = [], action = null }) {
  return html`<section class="rail-pane" aria-label=${title}>
    <h3 class="rail-pane-head"><span>${title}</span><span class="rail-pane-count">${count}</span><${Attention} nodes=${nodes} />${action}</h3>
    <div class="rail-frame">${lead ?? null}${count ? children : html`<div class="rail-empty">${empty}</div>`}</div>
  </section>`;
}

function OpenRail() {
  const roots = threadTree(allThreads.value.filter(OPEN));
  const yours = roots.filter((n) => !isShared(n));
  const shared = roots.filter(isShared);
  const selected = activeThreadId.value;
  const rows = (nodes) =>
    nodes.map(
      (n) =>
        html`<${ThreadNode} key=${n.id} thread=${n} selectedId=${selected} onSelect=${selectThread} />`,
    );
  return html`<div class="active-rail">
    <${Pane} title="Yours" count=${yours.length} nodes=${yours} empty="No open threads of your own."
      action=${html`<button type="button" class="rail-new-thread" onClick=${() => openNewThread()}>+ New thread</button>`}>${rows(yours)}</${Pane}>
    <${Pane} title="Shared" count=${shared.length} nodes=${shared} empty="No thread is shared with anyone." lead=${html`<${IncomingRows} />`}>${rows(shared)}</${Pane}>
  </div>`;
}

function AttentionRail() {
  const selected = activeThreadId.value;
  const needs = openRoots()
    .map((node) => ({ node, cat: effectiveCategory(node) }))
    .filter(({ node, cat }) => cat in URGENCY || node.id === selected)
    .sort((a, b) => (URGENCY[a.cat] ?? 2) - (URGENCY[b.cat] ?? 2))
    .map(({ node }) => node);
  return html`<div class="active-rail">
    <${Pane} title="Needs you" count=${needs.length} nodes=${needs} empty="Nothing needs you. Open shows what's running."
      action=${html`<button type="button" class="rail-new-thread" onClick=${() => openNewThread()}>+ New thread</button>`}>
      ${needs.map((n) => html`<${ThreadNode} key=${n.id} thread=${n} selectedId=${selected} onSelect=${selectThread} />`)}
    </${Pane}>
  </div>`;
}

/**
 * Work that runs without you: schedules (schedules.js; triggers are not built yet), then every open
 * thread running a loop (`meta.loop`, the agent's set_loop).
 */
function ScheduledRail() {
  const selected = activeThreadId.value;
  const looping = threadTree(
    allThreads.value.filter((t) => OPEN(t) && t.meta?.loop?.state === 'running'),
  );
  return html`<div class="active-rail">
    <${ScheduleList} />
    <${Pane} title="Loops" count=${looping.length} nodes=${looping} empty="No thread is running a loop.">
      ${looping.map((n) => html`<${ThreadNode} key=${n.id} thread=${n} selectedId=${selected} onSelect=${selectThread} />`)}
    </${Pane}>
  </div>`;
}

const RAILS = {
  attention: AttentionRail,
  open: OpenRail,
  projects: ProjectSidebar,
  scheduled: ScheduledRail,
  status: MachineStatus,
};

export function NavRail() {
  if (leftSize.value === 'hidden') return html`<div class="panel-hidden" aria-hidden="true"></div>`;
  // Folded, the rail is today's thin strip of project dots.
  if (!projectSidebarOpen.value || panelFit.value.leftFolded)
    return html`<${ProjectSidebar} folded=${true} />`;
  return html`<div class="nav-rail">
    <div class="rail-head-row"><${RailToggle} /><${SizeControls} side="left" /></div>
    ${html`<${RAILS[railView.value] ?? AttentionRail} />`}
  </div>`;
}
