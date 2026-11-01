/**
 * @atlas
 * @kind component
 * @partOf feature:viewer
 */
/**
 * Loop: the life of the work, then how each turn ran.
 *
 * A strip across the top places the thread on plan → build → review → land, from what is recorded
 * (a task list = planned; turns ran = building; guards ran or a pull request is linked = in review;
 * closed = landed). Below it, today's graph panel: the thread tree, each turn's flow and the learning
 * loop.
 */
import { GraphPanel } from './graph-view.js';
import { html } from './lib.js';
import { lifecycle } from './lifecycle.js';
import { activeThreadId, allThreads, threadData } from './store.js';

export function LoopView({ onLayerClick }) {
  // From the thread's own fields: the flow stream is held only while a turn graph is shown.
  const data = threadData.value;
  const last =
    data?.lastTurn ?? allThreads.value.find((t) => t.threadId === activeThreadId.value)?.lastTurn;
  const steps = lifecycle(
    last ? [{ status: last.status === 'running' ? 'active' : last.status }] : [],
    data?.meta,
  );
  return html`<div class="loop-view">
    <ol class="lifecycle" aria-label="Where the work stands">
      ${steps.map(
        (
          s,
        ) => html`<li key=${s.id} class="lifecycle-step ${s.done ? 'is-done' : ''} ${s.current ? 'is-current' : ''}">
          <span class="lifecycle-mark"></span>${s.label}
        </li>`,
      )}
    </ol>
    <div class="loop-graph"><${GraphPanel} onLayerClick=${onLayerClick} /></div>
  </div>`;
}
