/**
 * @atlas
 * @kind component
 * @partOf feature:viewer
 */
/**
 * Running: what this thread has going right now, pinned at the bottom of the right panel. Today that
 * is its live subagents: child threads whose status is active (idle means finished). Background
 * processes, Stop and scheduled jobs have no data source: the native session's background-task
 * frames don't reach Foundry yet.
 */

import { html, useEffect } from './lib.js';
import { allThreads, railExpanded, railView, selectThread } from './store.js';
import { threadName } from './thread-labels.js';

const since = (at) => {
  if (!at) return '';
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  return s < 60 ? `${s} s` : s < 3600 ? `${Math.round(s / 60)} m` : `${Math.round(s / 3600)} h`;
};

export function Running({ threadId }) {
  const subagents = allThreads.value.filter(
    // A subagent is live while its thread is active; idle means it finished.
    (t) => t.meta?.parentThreadId === threadId && t.meta?.status === 'active',
  );
  const reveal = () => {
    railView.value = 'open';
    railExpanded.value = new Set([...railExpanded.value, threadId]);
  };
  // Running sits level with the left footer block: same height, so the two bottoms line up.
  useEffect(() => {
    const footer = document.querySelector('.nav-footer');
    const panel = document.querySelector('.running');
    if (!footer || !panel || typeof ResizeObserver === 'undefined') return;
    const sync = () =>
      panel.style.setProperty('--footer-h', `${footer.getBoundingClientRect().height}px`);
    const watch = new ResizeObserver(sync);
    watch.observe(footer);
    sync();
    return () => watch.disconnect();
  }, []);
  return html`<section class="running" aria-label="Running">
    <header class="running-head"><b>Running</b><span>${subagents.length} live</span></header>
    ${subagents.map(
      (
        t,
      ) => html`<div key=${t.threadId} class="running-row s-running" role="button" tabindex="0" title="Show it under this thread in the list"
        onClick=${reveal}>
        <span class="running-kind">↳</span>
        <span class="running-label"><b>${threadName(t)}</b><code>subagent${t.meta?.spawn?.agentType ? ` · ${t.meta.spawn.agentType}` : ''}</code></span>
        <span class="running-state"><i>${since(t.meta?.createdAt)}</i>
          <button type="button" onClick=${(e) => {
            e.stopPropagation();
            selectThread(t.threadId);
          }}>Open</button></span>
      </div>`,
    )}
    <div class="running-none" title="The native session doesn't report its background shells to Foundry yet">Processes: not tracked yet.</div>
    <div class="running-none" title="Foundry has no scheduler for threads yet">Scheduled and background jobs: not tracked yet.</div>
  </section>`;
}
