/**
 * @atlas
 * @kind component
 * @partOf feature:viewer
 */
/**
 * Running: what this thread has going right now, pinned at the bottom of the right panel: the
 * background processes its agent started (`GET /api/threads/:id/running`, read every few seconds;
 * Stop when the session can stop one) and its live subagents (child threads whose status is active).
 * Scheduled jobs have no data source: Foundry has no scheduler yet.
 */

import { html, useEffect, useState } from './lib.js';
import { allThreads, authFetch, railExpanded, railView, selectThread, toast } from './store.js';
import { threadName } from './thread-labels.js';

const since = (at) => {
  if (!at) return '';
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  return s < 60 ? `${s} s` : s < 3600 ? `${Math.round(s / 60)} m` : `${Math.round(s / 3600)} h`;
};

const POLL_MS = 3000;
// Ended processes stay listed briefly, so a finish or a stop is seen.
const ENDED_SHOWN_MS = 60_000;

/** The thread's background processes, re-read while it's open. */
function useProcesses(threadId) {
  const [processes, setProcesses] = useState([]);
  const [tick, setTick] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: tick re-reads now (after a Stop).
  useEffect(() => {
    setProcesses([]);
    if (!threadId) return;
    let live = true;
    const read = () =>
      authFetch(`/api/threads/${encodeURIComponent(threadId)}/running`)
        .then((res) => (res.ok ? res.json() : null))
        .then((body) => live && body && setProcesses(body.processes ?? []))
        .catch(() => {});
    read();
    const timer = setInterval(read, POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [threadId, tick]);
  return [processes, () => setTick((n) => n + 1)];
}

async function stop(threadId, taskId, reread) {
  try {
    const res = await authFetch(
      `/api/threads/${encodeURIComponent(threadId)}/running/${encodeURIComponent(taskId)}/stop`,
      { method: 'POST' },
    );
    if (!res.ok) {
      const { error } = await res.json().catch(() => ({}));
      toast.value = { message: `Couldn’t stop it: ${error ?? res.status}`, type: 'error' };
    }
  } catch (err) {
    toast.value = { message: `Couldn’t stop it: ${err.message}`, type: 'error' };
  }
  reread();
}

export function Running({ threadId }) {
  const [all, reread] = useProcesses(threadId);
  const now = Date.now();
  const processes = all.filter(
    (p) => p.state === 'running' || (p.endedAt && now - p.endedAt < ENDED_SHOWN_MS),
  );
  const live = processes.filter((p) => p.state === 'running').length;
  const subagents = allThreads.value.filter(
    // A subagent is live while its thread is active; idle means it finished.
    (t) => t.meta?.parentThreadId === threadId && t.meta?.status === 'active',
  );
  const reveal = () => {
    railView.value = 'open';
    railExpanded.value = new Set([...railExpanded.value, threadId]);
  };
  // Running folds to one line, sized to its content (design review 11-02); it opens by itself while
  // something is live, and a click keeps it the way you left it.
  const [chosen, setChosen] = useState(null);
  const count = live + subagents.length;
  const open = chosen ?? processes.length + subagents.length > 0;
  return html`<section class="running ${open ? '' : 'is-folded'}" aria-label="Running">
    <button type="button" class="running-head" aria-expanded=${open} onClick=${() => setChosen(!open)}>
      <span class="running-caret">${open ? '▾' : '▸'}</span><b>Running</b><span>${count} live</span>
    </button>
    ${
      open
        ? processes.map(
            (
              p,
            ) => html`<div key=${p.taskId} class="running-row ${p.state === 'running' ? 's-running' : 's-ended'}" title=${[p.command, p.summary].filter(Boolean).join('\n')}>
        <span class="running-kind">$</span>
        <span class="running-label"><b>${p.label || p.command || p.taskType}</b><code>${p.taskType}${p.command && p.label ? ` · ${p.command}` : ''}</code></span>
        <span class="running-state"><i>${p.state === 'running' ? since(p.startedAt) : p.state}</i>
          ${
            p.state === 'running'
              ? p.stoppable
                ? html`<button type="button" onClick=${() => stop(threadId, p.taskId, reread)}>Stop</button>`
                : html`<button type="button" disabled title="This thread’s runtime can’t stop a background task">Stop</button>`
              : null
          }</span>
      </div>`,
          )
        : null
    }
    ${
      open
        ? subagents.map(
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
          )
        : null
    }
    ${open && !processes.length && !subagents.length ? html`<div class="running-none">Nothing running.</div>` : null}
    ${open ? html`<div class="running-none" title="Foundry has no scheduler for threads yet">Scheduled and background jobs: not tracked yet.</div>` : null}
  </section>`;
}
