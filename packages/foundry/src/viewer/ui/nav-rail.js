/**
 * @atlas
 * @kind component
 * @partOf feature:viewer
 */
/**
 * The left rail: Active | Projects.
 *
 * Active is every open thread across projects, in two fixed halves that each scroll on their own:
 * Yours on top, Shared (another party is a member) below. Projects is today's sidebar: the pinned
 * scopes, the project list, and the selected scope's threads. Rows are two lines: the name, then the
 * status icon, the project and any counts.
 */
import { IncomingRows } from './incoming.js';
import { html } from './lib.js';
import { NavFooter } from './nav-footer.js';
import { SizeControls } from './panel-sizes.js';
import { ProjectSidebar } from './project-sidebar.js';
import {
  activeThreadId,
  allThreads,
  leftSize,
  projectSidebarOpen,
  railView,
  selectThread,
} from './store.js';
import { isClosedThread } from './thread-status.js';
import { ThreadNode, threadTree } from './thread-tree.js';

const OPEN = (t) => !isClosedThread(t);
/** Shared: another party (a Signet member) is in the thread. */
const isShared = (node) => (node.conversation?.members ?? 0) > 0;

function RailToggle() {
  const view = railView.value;
  return html`<div class="rail-toggle" role="tablist" aria-label="Left rail">
    ${[
      ['open', 'Open'],
      ['projects', 'Projects'],
    ].map(
      ([id, label]) => html`<button key=${id} role="tab" aria-selected=${view === id}
        class="rail-toggle-btn ${view === id ? 'is-active' : ''}"
        onClick=${() => {
          railView.value = id;
        }}>${label}</button>`,
    )}
  </div>`;
}

function Pane({ title, count, children, empty, lead }) {
  return html`<section class="rail-pane" aria-label=${title}>
    <h3 class="rail-pane-head"><span>${title}</span><span class="rail-pane-count">${count}</span></h3>
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
    <${Pane} title="Yours" count=${yours.length} empty="No open threads of your own.">${rows(yours)}</${Pane}>
    <${Pane} title="Shared" count=${shared.length} empty="No thread is shared with anyone." lead=${html`<${IncomingRows} />`}>${rows(shared)}</${Pane}>
  </div>`;
}

export function NavRail() {
  if (leftSize.value === 'hidden') return html`<div class="panel-hidden" aria-hidden="true"></div>`;
  // Folded, the rail is today's thin strip of project dots.
  if (!projectSidebarOpen.value) return html`<${ProjectSidebar} />`;
  return html`<div class="nav-rail">
    <div class="rail-head-row"><${RailToggle} /><${SizeControls} side="left" /></div>
    ${railView.value === 'open' ? html`<${OpenRail} />` : html`<${ProjectSidebar} />`}
    <${NavFooter} />
  </div>`;
}
