/**
 * @atlas
 * @kind component
 * @partOf feature:viewer
 */
/**
 * Running: what this thread has going right now, pinned at the bottom of the right panel. Background
 * shells come from the thread's own tool calls (a Bash call run in the background, then BashOutput
 * and KillShell on its id); subagents are the thread's child threads. Foundry keeps no process
 * registry of its own, so a shell's state is what those calls last said.
 */

import { useFlowStream } from './graph-view.js';
import { html } from './lib.js';
import { backgroundShells } from './running-shells.js';
import {
  activeThreadId,
  allThreads,
  inspectTarget,
  railExpanded,
  railView,
  selectThread,
} from './store.js';
import { threadName } from './thread-labels.js';

const CLOSED = new Set(['archived', 'completed', 'done']);
const since = (at) => {
  if (!at) return '';
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  return s < 60 ? `${s} s` : s < 3600 ? `${Math.round(s / 60)} m` : `${Math.round(s / 3600)} h`;
};

export function Running({ threadId }) {
  const flow = useFlowStream(threadId, !!threadId);
  const shells = backgroundShells(flow.turns);
  const subagents = allThreads.value.filter(
    (t) => t.meta?.parentThreadId === threadId && !CLOSED.has(t.meta?.status ?? 'idle'),
  );
  const live = shells.filter((s) => s.state === 'running').length + subagents.length;
  const recent = shells.length - shells.filter((s) => s.state === 'running').length;
  const reveal = () => {
    railView.value = 'open';
    railExpanded.value = new Set([...railExpanded.value, threadId]);
  };
  return html`<section class="running" aria-label="Running">
    <header class="running-head"><b>Running</b><span>${live} live${recent ? ` · ${recent} recent` : ''}</span></header>
    ${
      !shells.length && !subagents.length
        ? html`<div class="running-none">Nothing running for this thread.</div>`
        : null
    }
    ${shells.map(
      (
        s,
      ) => html`<div key=${s.id} class="running-row s-${s.state}" role="button" tabindex="0" title=${s.command}
        onClick=${() => {
          inspectTarget.value = { kind: 'process', threadId, id: s.id };
        }}>
        <span class="running-kind">${s.port ? '▣' : '⚙'}</span>
        <span class="running-label"><b>${s.label}</b><code>${s.command}</code></span>
        <span class="running-state"><i>${s.state === 'running' ? [s.port ? `:${s.port}` : null, since(s.startedAt)].filter(Boolean).join(' · ') : s.state}</i>
          ${s.state === 'running' ? html`<button type="button" disabled title="Stopping a shell from Foundry isn't built yet: ask the agent, or stop it in its terminal">Stop</button>` : null}</span>
      </div>`,
    )}
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
  </section>`;
}

/** A background shell's output, in the inspector. */
export function ProcessInspector({ target }) {
  const flow = useFlowStream(target.threadId, true);
  const shell = backgroundShells(flow.turns).find((s) => s.id === target.id);
  if (!shell)
    return html`<div class="rp-empty">This process is no longer in the thread's recent turns.</div>`;
  return html`<div class="process-inspector">
    <div class="running-label"><b>${shell.label}</b><code>${shell.command}</code></div>
    <div class="ph-meta">${shell.state}${shell.port ? ` · port ${shell.port}` : ''}${shell.startedAt ? ` · started ${new Date(shell.startedAt).toLocaleTimeString()}` : ''}</div>
    <pre class="process-output mono">${shell.output.join('\n') || 'No output read yet: the agent reads it with BashOutput.'}</pre>
  </div>`;
}
