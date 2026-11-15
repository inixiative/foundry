/**
 * @atlas
 * @kind component
 * @partOf feature:viewer
 */
/**
 * The agents in a thread, beside "Runs on": a count and "+ Add agent". A thread has one agent by
 * default, the host's; more are opt-in (Aron, 2026-11-14): another of your threads on this machine
 * joins as a local member (`/conversation/locals`, CONVERSATIONS.md §4.11), and someone else's agent
 * comes in through a Signet that holds `member.agent` on the conversation (§4.12). Running
 * subagents count too, read-only. The count opens the agents modal, mounted at the app's root
 * beside the run picker. The band's popover and this fact share `threadAgents` / `agentCountOf`, so
 * the two counts cannot disagree.
 */

import { holds, invite, post, useConversationView } from './conversation-members.js';
import { html, signal, useEffect, useRef, useState } from './lib.js';
import { Modal } from './modal.js';
import { runLabel, ThreadRunModal } from './run-picker.js';
import { settingsConfig } from './settings.js';
import {
  activeThreadId,
  allThreads,
  authFetch,
  showToast,
  threadData,
  threadLaunch,
} from './store.js';
import { threadName } from './thread-labels.js';
import { isClosedThread } from './thread-status.js';

/**
 * The agents of a thread besides the host's: local members, members' own agents (a Signet holding
 * `member.agent`) and the executor's running subagents.
 */
export function threadAgents(view, threadId) {
  const members = view?.members ?? [];
  return {
    locals: members.filter((m) => m.member.kind === 'local'),
    remote: members.filter(
      (m) => m.member.kind === 'signet' && !m.ownerClient && holds(m, 'member.agent'),
    ),
    subagents: allThreads.value.filter(
      (t) => t.meta?.parentThreadId === threadId && t.meta?.status === 'active',
    ),
  };
}

/** The host's agent plus every other agent `threadAgents` lists. */
export const agentCountOf = ({ locals, remote, subagents }) =>
  1 + locals.length + remote.length + subagents.length;

export const threadAgentsOpen = signal(false);
const openThreadAgents = () => {
  threadAgentsOpen.value = true;
};

/** The "Agents" fact under Runs on: the count (opens the modal) and "+ Add agent". */
export function AgentsFact() {
  const threadId = activeThreadId.value;
  const [view] = useConversationView(threadId, threadData.value?.conversation ?? null);
  const count = agentCountOf(threadAgents(view, threadId));
  return html`<dt>Agents</dt><dd class="thread-agents-fact">
    <button type="button" class="run-picker-link" data-agents="count" aria-haspopup="dialog"
      onClick=${openThreadAgents} title="The agents in this thread">${count} agent${count === 1 ? '' : 's'}</button>
    <button type="button" class="proj-btn" data-agents="add" aria-haspopup="dialog"
      onClick=${openThreadAgents}>+ Add agent</button>
  </dd>`;
}

const base = (threadId) => `/api/threads/${encodeURIComponent(threadId)}/conversation/locals`;

/**
 * Threads that could join as a local member: same project, open, not a subagent, not in yet. A
 * thread that would close a cycle (one whose own conversation already holds this one) is refused by
 * the server with its reason.
 */
function candidates(threadId, projectId, locals) {
  const taken = new Set([threadId, ...locals.map((m) => m.member.id)]);
  return allThreads.value.filter(
    (t) =>
      !taken.has(t.threadId) &&
      (t.meta?.projectId ?? null) === (projectId ?? null) &&
      !t.meta?.spawn?.observed &&
      !isClosedThread(t),
  );
}

async function readLaunch(threadId) {
  const res = await authFetch(`/api/threads/${encodeURIComponent(threadId)}/launch`);
  if (!res.ok) throw Error(res.statusText);
  return res.json();
}

/**
 * Each local agent's launch view (`/launch`), read when the modal opens and after a change. A
 * per-id sequence drops a slower, older read that lands after a newer one.
 */
function useLaunches(ids) {
  const [launches, setLaunches] = useState({});
  const seq = useRef({});
  const key = ids.join(',');
  const refresh = async (id) => {
    const mine = (seq.current[id] ?? 0) + 1;
    seq.current[id] = mine;
    const launch = await readLaunch(id).catch(() => ({ failed: true }));
    if (seq.current[id] === mine) setLaunches((all) => ({ ...all, [id]: launch }));
  };
  useEffect(() => {
    for (const id of ids) refresh(id);
  }, [key]);
  return [launches, refresh];
}

const runOf = (launch) =>
  !launch
    ? 'reading…'
    : launch.failed
      ? 'couldn’t read what it runs on'
      : (runLabel(launch) ?? '—');

function ThreadAgentsModal({ onClose }) {
  const threadId = activeThreadId.value;
  const [view] = useConversationView(threadId, threadData.value?.conversation ?? null);
  const { locals, remote, subagents } = threadAgents(view, threadId);
  const [launches, refresh] = useLaunches(locals.map((m) => m.member.id));
  const [changing, setChanging] = useState(null);
  const [pick, setPick] = useState('');
  const [busy, setBusy] = useState(null);
  const changingLaunch = changing ? launches[changing] : null;
  if (changingLaunch && !changingLaunch.failed) {
    const name = locals.find((m) => m.member.id === changing)?.displayName ?? 'This agent';
    return html`<${ThreadRunModal} key=${changing} threadId=${changing} launch=${changingLaunch}
      title=${`${name} runs on`} onSaved=${() => refresh(changing)} onClose=${() => setChanging(null)} />`;
  }
  const options = candidates(threadId, threadData.value?.meta?.projectId, locals);
  const paired = !!settingsConfig.value?.kingdomIntegrations?.length;
  const add = async () => {
    if (!pick) return;
    setBusy('add');
    if (await post(base(threadId), { threadId: pick })) {
      showToast('It joins with the conversation’s default voice', 'ok');
      setPick('');
    }
    setBusy(null);
  };
  const remove = async (m) => {
    setBusy(m.member.id);
    if (await post(`${base(threadId)}/${encodeURIComponent(m.member.id)}`, undefined, 'DELETE')) {
      showToast(`${m.displayName} left`, 'ok');
    }
    setBusy(null);
  };
  return html`<${Modal} title="Agents" onClose=${onClose} class="run-modal thread-agents-modal">
    <ul class="thread-agents-list">
      <li data-agent="host"><strong>This thread’s agent</strong>
        <span class="conversation-dim" data-run="host">the host · ${runLabel(threadLaunch.value) ?? 'runs on what Runs on says'}</span></li>
      ${locals.map(
        (m) => html`<li key=${m.member.id} data-agent="local" data-member=${m.member.id}>
          <strong>${m.displayName}</strong>
          <span class="conversation-dim">your thread on this machine · ${m.voice ?? 'listening'}</span>
          <span class="conversation-dim" data-run="local">${runOf(launches[m.member.id])}</span>
          <button type="button" class="proj-btn" data-agents="change" aria-label=${`Change ${m.displayName}`}
            aria-haspopup="dialog" disabled=${!launches[m.member.id] || launches[m.member.id].failed}
            onClick=${() => setChanging(m.member.id)}>Change</button>
          <button type="button" class="proj-btn" data-agents="remove" aria-label=${`Remove ${m.displayName}`}
            disabled=${busy === m.member.id} onClick=${() => remove(m)}>Remove</button>
        </li>`,
      )}
      ${remote.map(
        (m) => html`<li key=${m.member.id} data-agent="remote">
          <strong>${m.displayName}’s agent</strong>
          <span class="conversation-dim">runs on their side, through their Signet: their own rules apply to it</span>
        </li>`,
      )}
      ${subagents.map(
        (t) => html`<li key=${t.threadId} data-agent="subagent">
          <strong>${threadName(t)}</strong>
          <span class="conversation-dim">a subagent this thread’s agent started; it ends with its task</span>
        </li>`,
      )}
    </ul>
    <h4 class="thread-agents-label">Add one of your threads</h4>
    ${
      options.length
        ? html`<div class="thread-agents-add">
          <select class="rp-select" aria-label="Thread to add" value=${pick} onChange=${(e) => setPick(e.target.value)}>
            <option value="">Choose a thread…</option>
            ${options.map((t) => html`<option key=${t.threadId} value=${t.threadId}>${threadName(t)}</option>`)}
          </select>
          <button type="button" class="action-btn primary" data-agents="join" disabled=${!pick || busy === 'add'}
            onClick=${add}>${busy === 'add' ? 'Adding…' : 'Add'}</button>
        </div>`
        : html`<p class="run-picker-note run-picker-note--dim">No other open thread in this project to add.</p>`
    }
    <h4 class="thread-agents-label">Add someone else’s agent</h4>
    ${
      paired
        ? html`<p class="run-picker-note run-picker-note--dim">Invite them in Kingdom and let their grant bring an agent. Each side’s Signet sets its own rules.</p>
          <button type="button" class="action-btn" data-agents="invite" onClick=${() => invite(threadId)}>Invite in Kingdom</button>`
        : html`<p class="run-picker-note run-picker-note--dim">Pair this Foundry with Kingdom (Settings → Kingdom) to invite someone else’s agent.</p>`
    }
  <//>`;
}

/** Mounted at the app's root (outside the right panel's containment), like the run picker. */
export function ThreadAgentsModals() {
  return threadAgentsOpen.value && activeThreadId.value
    ? html`<${ThreadAgentsModal} key=${activeThreadId.value} onClose=${() => {
        threadAgentsOpen.value = false;
      }} />`
    : null;
}
