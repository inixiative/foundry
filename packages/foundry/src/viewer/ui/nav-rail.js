/**
 * @atlas
 * @kind component
 * @partOf feature:viewer
 */
/**
 * The left rail: Attention | Open | Projects (⌥⇧← ⌥⇧→ step between them).
 *
 * Attention is the open top-level threads that need you, across projects: red (can't proceed) first,
 * then orange (a question, an approval, a reply you haven't read), by `effectiveCategory`, the one
 * "needs you" definition. A thread that is working, queued or idle drops out and comes back when it
 * hands back; the thread you have open stays listed until you move on.
 *
 * Open is every open thread across projects, in two fixed halves that each scroll on their own:
 * Yours on top, Shared (another party is a member) below. Projects is today's sidebar: the pinned
 * scopes, the project list, and the selected scope's threads. Rows are two lines: the name, then the
 * status icon, the project and any counts.
 */
import { Attention, effectiveCategory, openRoots } from './attention.js';
import { IncomingRows } from './incoming.js';
import { html } from './lib.js';
import { NavFooter } from './nav-footer.js';
import { panelFit, SizeControls } from './panel-sizes.js';
import { ProjectSidebar } from './project-sidebar.js';
import { openNewThread } from './run-picker.js';
import {
  activeThreadId,
  allThreads,
  leftSize,
  projectSidebarOpen,
  RAIL_VIEWS,
  railView,
  selectThread,
} from './store.js';
import { isClosedThread } from './thread-status.js';
import { ThreadNode, threadTree } from './thread-tree.js';

const OPEN = (t) => !isClosedThread(t);
/** Shared: another party (a Signet member) is in the thread. */
const isShared = (node) => (node.conversation?.members ?? 0) > 0;

const RAIL_LABELS = { attention: 'Attention', open: 'Open', projects: 'Projects' };
/** Red before orange in the Attention rail. */
const URGENCY = { problem: 0, attention: 1 };

function RailToggle() {
  const view = railView.value;
  return html`<div class="rail-toggle" role="tablist" aria-label="Left rail">
    ${RAIL_VIEWS.map(
      (id) => html`<button key=${id} role="tab" aria-selected=${view === id}
        class="rail-toggle-btn ${view === id ? 'is-active' : ''}" title=${`${RAIL_LABELS[id]} (⌥⇧← ⌥⇧→)`}
        onClick=${() => {
          railView.value = id;
        }}>${RAIL_LABELS[id]}</button>`,
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

const RAILS = { attention: AttentionRail, open: OpenRail, projects: ProjectSidebar };

export function NavRail() {
  if (leftSize.value === 'hidden') return html`<div class="panel-hidden" aria-hidden="true"></div>`;
  // Folded, the rail is today's thin strip of project dots.
  if (!projectSidebarOpen.value || panelFit.value.leftFolded)
    return html`<${ProjectSidebar} folded=${true} />`;
  return html`<div class="nav-rail">
    <div class="rail-head-row"><${RailToggle} /><${SizeControls} side="left" /></div>
    ${html`<${RAILS[railView.value] ?? AttentionRail} />`}
    <${NavFooter} />
  </div>`;
}
