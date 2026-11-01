/**
 * @atlas
 * @kind component
 * @partOf feature:viewer
 */
/**
 * Work: what this thread produced and touched.
 *
 * Tasks are the agent's own task list (Claude's TodoWrite, Codex's update_plan) from the flow stream.
 * Each turn's records (journal artifacts, native evidence) open in the inspector. Compare links out to
 * GitHub: the viewer doesn't grow diffs, checkpoints or worktree management (the host apps have them).
 */
import { TaskLists, useFlowStream } from './graph-view.js';
import { html } from './lib.js';
import { StatusIcon } from './status-icons.js';
import {
  activeThreadId,
  allThreads,
  createThread,
  executeAction,
  openTurnDetail,
  selectThread,
  threadData,
  threadStatusOf,
} from './store.js';
import { threadName } from './thread-labels.js';

const githubRef = (ref) => /^#?\d+$/.test(ref) || /^[\w.-]+\/[\w.-]+#\d+$/.test(ref);

function Section({ title, children }) {
  return html`<section class="rp-section"><h3 class="rp-section-title">${title}</h3>${children}</section>`;
}

export function Work() {
  const data = threadData.value;
  const threadId = activeThreadId.value;
  const flow = useFlowStream(threadId, !!threadId);
  if (!data || !threadId) return html`<div class="rp-empty">Open a thread to see its work.</div>`;
  const meta = data.meta || {};
  const context = meta.context ?? {};
  const branch = context.branch ?? meta.branch ?? null;
  const repository = context.repository ?? null;
  const prs = (context.references ?? []).filter(
    (r) => r.integration === 'github' && githubRef(r.ref),
  );
  const children = allThreads.value.filter((t) => t.meta?.parentThreadId === threadId);
  const turns = [...(flow.turns ?? [])].reverse();
  const latestWithTasks = turns.find((t) => t.tasks?.length);

  return html`<div class="rp-stack work">
    <${Section} title="Tasks">
      ${latestWithTasks ? html`<${TaskLists} turn=${latestWithTasks} />` : html`<div class="rp-dim">No task list recorded on this thread’s recent turns.</div>`}
    </${Section}>

    <${Section} title="Compare">
      ${
        repository && branch
          ? html`<div class="work-compare">
            <span class="rp-mono">${branch}</span> against main ·
            <a href=${`https://github.com/${repository}/compare/main...${encodeURIComponent(branch)}`} target="_blank" rel="noopener noreferrer">Open the comparison in GitHub ↗</a>
          </div>`
          : html`<div class="rp-dim">No repository and branch recorded for this thread yet.</div>`
      }
      ${prs.length ? html`<div class="work-prs">${prs.map((r) => (r.url ? html`<a key=${r.ref} href=${r.url} target="_blank" rel="noopener noreferrer">Pull request ${r.ref} ↗</a>` : html`<span key=${r.ref}>Pull request ${r.ref}</span>`))}</div>` : null}
    </${Section}>

    <${Section} title="Turn records">
      ${
        turns.length
          ? html`<ul class="rp-list">${turns.map(
              (t) => html`<li key=${t.turnId} class="work-turn">
                <span class="work-turn-input">${t.input?.preview || '(no message)'}</span>
                <span class="rp-dim">${t.status}</span>
                <button class="rp-link" onClick=${() => openTurnDetail(threadId, t.turnId)}>Inspect ›</button>
              </li>`,
            )}</ul>`
          : html`<div class="rp-dim">No turns recorded yet.</div>`
      }
    </${Section}>

    <${Section} title="Child threads">
      ${
        children.length
          ? html`<ul class="rp-list">${children.map(
              (
                c,
              ) => html`<li key=${c.threadId}><button class="rp-link brief-link" onClick=${() => selectThread(c.threadId)}>
                <${StatusIcon} state=${threadStatusOf(c.threadId)} still=${true} /> ${threadName(c)}
              </button></li>`,
            )}</ul>`
          : html`<div class="rp-dim">None.</div>`
      }
      <div class="work-actions">
        <button class="proj-btn" onClick=${() => createThread({ description: `Follow-up to: ${threadName(data)}`, branch: branch ?? undefined })}>Start another thread for this</button>
        <button class="proj-btn" onClick=${() => executeAction('thread:archive', threadId)}>Close this thread</button>
      </div>
    </${Section}>
  </div>`;
}
