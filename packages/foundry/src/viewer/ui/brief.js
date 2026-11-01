/**
 * @atlas
 * @kind component
 * @partOf feature:viewer
 */
/**
 * The Brief: what this thread is about and where it stands, without scrolling the conversation.
 *
 * Built from what the viewer already holds: the thread's name and living description, where it came
 * from (its references, its parent), what it is doing now, what waits on you, and its subagents. The
 * per-turn thread summary (decisions, open questions) is middleware that isn't built yet; the Brief
 * says so instead of guessing.
 */
import { html } from './lib.js';
import { liveThreadStatus, liveWorkLabel } from './live-state.js';
import { STATES, StatusIcon } from './status-icons.js';
import {
  activeThreadId,
  allThreads,
  messages,
  prompts,
  selectThread,
  threadData,
  threadStatusOf,
} from './store.js';
import { ReferenceChips, threadName } from './thread-labels.js';
import { promptState } from './thread-status.js';

function Line({ label, children }) {
  return html`<div class="brief-line"><span class="brief-label">${label}</span><div class="brief-value">${children}</div></div>`;
}

export function Brief() {
  const data = threadData.value;
  const threadId = activeThreadId.value;
  if (!data || !threadId) return html`<div class="rp-empty">Open a thread to see its brief.</div>`;
  const meta = data.meta || {};
  const state = threadStatusOf(threadId, liveThreadStatus(messages.value));
  const lastAgent = [...messages.value].reverse().find((m) => m.actor === 'agent');
  const waiting = prompts.value.filter((p) => p.threadId === threadId);
  const parent = meta.parentThreadId
    ? allThreads.value.find((t) => t.threadId === meta.parentThreadId)
    : null;
  const children = allThreads.value.filter((t) => t.meta?.parentThreadId === threadId);
  const refs = meta.context?.references ?? [];

  return html`<article class="brief">
    <h2 class="brief-title">${threadName(data)}</h2>
    ${meta.description && meta.description !== threadName(data) ? html`<p class="brief-about">${meta.description}</p>` : null}

    <${Line} label="Now">
      <span class="brief-now"><${StatusIcon} state=${state} still=${true} /> ${STATES[state]?.label}${lastAgent && state === 'working' ? ` · ${liveWorkLabel(lastAgent)}` : ''}</span>
    </${Line}>

    <${Line} label="From">
      ${parent ? html`<button class="rp-link brief-link" onClick=${() => selectThread(parent.threadId)}>Started from “${threadName(parent)}”</button>` : null}
      ${meta.spawn?.description ? html`<div>${meta.spawn.description}</div>` : null}
      ${refs.length ? html`<div class="brief-refs"><${ReferenceChips} meta=${meta} /></div>` : null}
      ${!parent && !meta.spawn && !refs.length ? html`<span class="rp-dim">You started it here.</span>` : null}
    </${Line}>

    <${Line} label="Needs you">
      ${
        waiting.length
          ? html`<ul class="brief-list">${waiting.map(
              (p) => html`<li key=${p.id} class="brief-needs">
                <${StatusIcon} state=${promptState(p)} still=${true} />
                <span>${p.message}</span>
                <span class="rp-dim">answer below</span>
              </li>`,
            )}</ul>`
          : html`<span class="rp-dim">Nothing waits on you.</span>`
      }
    </${Line}>

    ${
      children.length
        ? html`<${Line} label="Subagents">
          <ul class="brief-list">${children.map(
            (c) => html`<li key=${c.threadId}>
              <button class="rp-link brief-link" onClick=${() => selectThread(c.threadId)}>
                <${StatusIcon} state=${threadStatusOf(c.threadId)} still=${true} /> ${threadName(c)}
              </button>
            </li>`,
          )}</ul>
        </${Line}>`
        : null
    }

    <${Line} label="Decided · open">
      <span class="rp-dim">
        The running thread summary (what was decided, what is still open, each linked to its turn) is
        middleware that isn’t built yet. Until it is, read the turns in Thread.
      </span>
    </${Line}>
  </article>`;
}
