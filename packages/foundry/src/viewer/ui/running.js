/**
 * Running: what this thread has going right now, pinned at the bottom of the right panel. Today that
 * is its open subagents (child threads). Background processes and scheduled jobs need Foundry's
 * Running record per thread, which isn't built: the flow stream that carries tool calls has one
 * holder at a time (the centre's views), so this panel can't read shells from it.
 */

import { html } from './lib.js';
import { allThreads, railExpanded, railView, selectThread } from './store.js';
import { threadName } from './thread-labels.js';

const CLOSED = new Set(['archived', 'completed', 'done']);

const since = (at) => {
  if (!at) return '';
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  return s < 60 ? `${s} s` : s < 3600 ? `${Math.round(s / 60)} m` : `${Math.round(s / 3600)} h`;
};

export function Running({ threadId }) {
  const subagents = allThreads.value.filter(
    (t) => t.meta?.parentThreadId === threadId && !CLOSED.has(t.meta?.status ?? 'idle'),
  );
  const reveal = () => {
    railView.value = 'open';
    railExpanded.value = new Set([...railExpanded.value, threadId]);
  };
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
    <div class="running-none" title="Needs Foundry's Running record per thread">Background processes and scheduled jobs: not built yet.</div>
  </section>`;
}
