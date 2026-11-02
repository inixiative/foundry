/**
 * @atlas
 * @kind component
 * @partOf feature:conversations, feature:viewer
 */
/**
 * A conversation thread's participants panel (docs/reference/CONVERSATIONS.md §4.7): who the
 * members are and their terms (view, delivery, outbound), who is here now, the floor, posts as they
 * arrived (unread ones marked), held sends to release, and where to invite someone in Kingdom.
 * Everything is read from `GET /api/threads/:id/conversation`, re-read whenever the thread's line in
 * the sessions list changes (the existing `threads` stream).
 */

import { html, useEffect, useState } from './lib.js';
// settings.js imports this module's settings card; the signal is read at render, so the cycle is safe.
import { SettingRow } from './setting-row.js';
import { settingsConfig } from './settings.js';
import { activeThreadId, prompts, resolvePrompt, showToast, threadData } from './store.js';
import { layeredActions, sourceOf } from './thread-settings.js';

const FLOORS = [
  ['talk', 'Talk'],
  ['speak-when-spoken-to', 'Speak when spoken to'],
  ['conch', 'Conch'],
];

async function post(path, body) {
  try {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
    if (res.ok) return true;
    showToast((await res.json()).error || 'Conversation request failed', 'error');
  } catch (error) {
    showToast(`Conversation request failed: ${error.message}`, 'error');
  }
  return false;
}

const ago = (iso) => {
  if (!iso) return 'never';
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} h ago`;
  return `${Math.round(seconds / 86_400)} d ago`;
};

/** One held send or post: release as written, edit then release, or withdraw. */
export function HeldPromptCard({ prompt }) {
  const held = prompt.meta.conversationHeld;
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(held.text ?? '');
  const [busy, setBusy] = useState(false);
  const act = async (action, input) => {
    setBusy(true);
    const ok = await post(`/api/conversations/held/${encodeURIComponent(held.heldId)}/answer`, {
      action,
      ...(input !== undefined ? { input } : {}),
    });
    setBusy(false);
    if (ok) setEditing(false);
  };
  const to =
    held.kind === 'send'
      ? `to ${held.toName ?? held.to?.id}`
      : `into ${held.remoteThreadId} (another Foundry)`;
  return html`<div class="prompt-card conversation-held" data-held=${held.heldId}>
    <div class="prompt-card-header">
      <span class="prompt-kind">${held.kind === 'send' ? 'held send' : 'held post'}</span>
      <span class="prompt-agent">${to}</span>
    </div>
    ${
      editing
        ? html`<div class="conversation-held-edit">
          <textarea class="prompt-input" rows="3" aria-label="Text to release" value=${text}
            onInput=${(e) => setText(e.target.value)}></textarea>
          <div class="prompt-card-actions">
            <button class="prompt-btn prompt-btn-approve" disabled=${busy || !text.trim()}
              onClick=${() => act('edit', text.trim())}>Release edited</button>
            <button class="prompt-btn" onClick=${() => setEditing(false)}>Cancel</button>
          </div>
        </div>`
        : html`<div class="prompt-card-message conversation-held-text">${held.text}</div>
        <div class="prompt-card-actions">
          <button class="prompt-btn prompt-btn-approve" disabled=${busy}
            onClick=${() => act('release')}>Release</button>
          <button class="prompt-btn" disabled=${busy} onClick=${() => setEditing(true)}>Edit, then release</button>
          <button class="prompt-btn" disabled=${busy} onClick=${() => act('withdraw')}>Withdraw</button>
        </div>`
    }
  </div>`;
}

function MemberRow({ member, threadId, conch }) {
  const terms = member.terms;
  return html`<li class="conversation-member ${member.present ? 'is-present' : ''}"
      data-member=${member.member.id}>
    <span class="conversation-presence" title=${member.present ? 'Here now' : `Last seen ${ago(member.lastSeen)}`}></span>
    <span class="conversation-member-name">${member.displayName}</span>
    ${member.listed ? null : html`<span class="context-bar-chip context-bar-chip--dim" title="Kingdom no longer lists this Signet on the thread (revoked, narrowed, or not yet in a snapshot)">unlisted</span>`}
    ${
      terms
        ? html`<span class="context-bar-chip" title="What it reads">${terms.view === 'thread' ? 'reads the thread' : 'reads its own'}</span>
          <span class="context-bar-chip" title="How its posts arrive">${terms.delivery === 'turn' ? 'posts wake the agent' : 'posts as notes'}</span>`
        : null
    }
    <span class="context-bar-chip ${member.outbound === 'review' ? '' : 'context-bar-chip--dim'}"
      title="Sends to this member">${member.outbound === 'review' ? 'sends reviewed' : 'sends leave at once'}</span>
    ${member.holdsConch ? html`<span class="context-bar-chip" title="Holds the conch">conch</span>` : null}
    ${(() => {
      // A raised hand is a Needs-you prompt; answer it here or on the board.
      const hand = prompts.value.find(
        (p) =>
          p.threadId === threadId &&
          p.meta?.conversationFloorRequest?.member?.id === member.member.id,
      );
      return hand
        ? html`<span class="conversation-hand" title=${hand.message}>✋ asks for the conch</span>
          <button class="proj-btn proj-btn-ok" onClick=${() => resolvePrompt(hand.id, 'give')}>Give it</button>
          <button class="proj-btn" onClick=${() => resolvePrompt(hand.id, 'not-now')}>Not now</button>`
        : null;
    })()}
    <span class="conversation-dim">${member.present ? 'here now' : ago(member.lastSeen)}</span>
    ${
      conch && member.listed && !member.holdsConch
        ? html`<button class="proj-btn" onClick=${() => post(`/api/threads/${encodeURIComponent(threadId)}/conversation/conch`, { to: member.member.id })}>Give conch</button>`
        : null
    }
  </li>`;
}

/** Open Kingdom's grant form for this thread (§5.5), read on demand. */
async function invite(threadId) {
  try {
    const res = await fetch(`/api/threads/${encodeURIComponent(threadId)}/conversation`);
    const url = res.ok ? (await res.json()).invites?.find((candidate) => candidate.url)?.url : null;
    if (url) window.open(url, '_blank', 'noopener');
    else
      showToast('Kingdom did not describe where to invite from; check Settings → Kingdom', 'warn');
  } catch (error) {
    showToast(`Invite unavailable: ${error.message}`, 'error');
  }
}

/**
 * The participants panel, shown on a thread that has a conversation (its line in the sessions list
 * carries `conversation`), or folded to its invite link on any other thread.
 */
/**
 * The thread's conversation view (members, floor, posts), read only for a thread whose line in the
 * sessions list carries `conversation`, and re-read whenever that line changes.
 */
export function useConversationView(threadId, line) {
  const [view, setView] = useState(null);
  const lineKey = JSON.stringify(line);
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-read when the thread's line changes.
  useEffect(() => {
    setView(null);
    if (!threadId || !line) return;
    let live = true;
    fetch(`/api/threads/${encodeURIComponent(threadId)}/conversation`)
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        if (live) setView(body);
      })
      .catch(() => {
        if (live) setView(null);
      });
    return () => {
      live = false;
    };
  }, [threadId, lineKey]);
  return [view];
}

export function ParticipantsPanel() {
  const threadId = activeThreadId.value;
  const line = threadData.value?.conversation ?? null;
  const [view] = useConversationView(threadId, line);
  const [open, setOpen] = useState(true);
  if (!threadId) return null;
  if (!line)
    return settingsConfig.value?.kingdomIntegrations?.length
      ? html`<div class="conversation-panel conversation-panel--empty">
        <button class="proj-btn" onClick=${() => invite(threadId)}>Invite to this conversation</button>
      </div>`
      : null;
  if (!view) return null;
  const invite = view.invites?.find((candidate) => candidate.url);
  const unread = view.posts.filter((p) => p.unread).length;
  const conch = view.floor.mode === 'conch';
  const base = `/api/threads/${encodeURIComponent(threadId)}/conversation`;
  return html`<section class="conversation-panel" aria-label="Conversation participants">
    <div class="conversation-panel-head" onClick=${() => setOpen(!open)}>
      <span class="inactive-caret">${open ? '▼' : '▶'}</span>
      <strong>Conversation</strong>
      <span class="context-bar-chip">${view.members.length} member${view.members.length === 1 ? '' : 's'}</span>
      ${unread ? html`<span class="conversation-unread">${unread} unread</span>` : null}
      ${view.paused ? html`<span class="context-bar-chip conversation-paused">paused (${view.paused.reason === 'depth' ? `${view.depth.count} agent turns` : 'by you'})</span>` : null}
      ${view.held.length ? html`<span class="context-bar-chip">${view.held.length} held</span>` : null}
    </div>
    ${
      open
        ? html`<div class="conversation-panel-body">
        <div class="conversation-floor">
          <label>Floor
            <select value=${view.floorFrom === 'thread' ? view.floor.mode : ''}
              onChange=${(e) => post(`${base}/floor`, { mode: e.target.value || null })}>
              <option value="">Inherit (${FLOORS.find(([id]) => id === view.inherited)?.[1] ?? view.inherited})</option>
              ${FLOORS.map(([id, label]) => html`<option value=${id}>${label}</option>`)}
            </select>
          </label>
          <span class="conversation-dim">from ${view.floorFrom}</span>
          <span class="conversation-dim">depth ${view.depth.count}/${view.depth.max}</span>
          ${
            conch
              ? html`<span class="conversation-dim">conch: ${
                  view.floor.holder
                    ? (view.members.find((m) => m.member.id === view.floor.holder.id)
                        ?.displayName ?? view.floor.holder.id)
                    : 'the host'
                }</span>
                ${view.floor.holder ? html`<button class="proj-btn" onClick=${() => post(`${base}/conch`, { to: null })}>Take conch</button>` : null}`
              : null
          }
          <label>Agents
            <select value=${view.settings?.agents ?? ''}
              onChange=${(e) => post(`${base}/agents`, { mode: e.target.value || null })}>
              <option value="">Inherit</option>
              <option value="silent">Agents: listening only</option>
              <option value="drafting">Agents may draft</option>
            </select>
          </label>
          ${
            view.floorFrom === 'shared'
              ? html`<span class="conversation-dim" title="A thread with a member starts from the shared defaults">shared · conch</span>
                <button class="proj-btn" title="Members read from when the thread was shared; this lets them read what came before"
                  onClick=${() => post(`${base}/share-history`)}>Share earlier history</button>`
              : null
          }
          ${
            view.paused
              ? html`<button class="proj-btn proj-btn-ok" onClick=${() => post(`${base}/resume`)}>Resume</button>`
              : html`<button class="proj-btn" onClick=${() => post(`${base}/pause`)}>Pause members</button>`
          }
          ${invite ? html`<a class="proj-btn" href=${invite.url} target="_blank" rel="noopener">Invite</a>` : null}
        </div>
        ${
          view.requests?.length
            ? html`<div class="conversation-requests">Asking for the conch: ${view.requests.map(
                (r) =>
                  html`<button class="proj-btn" onClick=${() => post(`${base}/conch`, { to: r.member.id })}>${r.displayName}</button>`,
              )}</div>`
            : null
        }
        <ul class="conversation-members">
          ${view.members.map(
            (member) =>
              html`<${MemberRow} key=${member.member.id} member=${member} threadId=${threadId} conch=${conch} />`,
          )}
        </ul>
        ${
          view.posts.length
            ? html`<ol class="conversation-posts">
            ${view.posts.slice(-20).map(
              (
                p,
              ) => html`<li key=${p.journalSeq} class="conversation-post ${p.unread ? 'is-unread' : ''} ${p.withdrawn ? 'is-withdrawn' : ''}">
                <div class="conversation-post-head">
                  <span class="conversation-post-who">${p.displayName}</span>
                  <span class="conversation-dim">${p.delivery === 'turn' ? 'woke the agent' : 'note'} · ${ago(p.at)}${p.withdrawn ? ' · withdrawn' : ''}</span>
                </div>
                <div class="conversation-post-text">${p.text}</div>
              </li>`,
            )}
          </ol>`
            : html`<div class="conversation-dim">No posts yet.</div>`
        }
      </div>`
        : null
    }
  </section>`;
}

/** A conversations field: its path under `conversations`, its label, and how to read its value. */
const CONVERSATION_FIELDS = [
  ['floor', 'floor', 'Floor', 'Who may post when more than your agent is in a thread.'],
  [
    'maxAgentTurns',
    'maxAgentTurns',
    'Agent turns before a pause',
    'Other parties pause after this many turns in a row without you.',
  ],
  [
    'holdSeconds',
    'conch.holdSeconds',
    'Conch hold (seconds)',
    'How long the conch stays with whoever holds it.',
  ],
  [
    'agentMayPass',
    'conch.agentMayPass',
    'The agent may pass the conch',
    'Off: only people pass the conch.',
  ],
];

const at = (root, path) => path.split('.').reduce((node, key) => node?.[key], root);

/**
 * A project's `conversations` setting (§4.6), one row per field: the value in effect, where it
 * comes from (yours over the repository's over the default) and ⋯ to set it for me or for everyone,
 * through /api/projects/:id/setting like every project setting.
 */
export function ProjectConversations({ projectId }) {
  const [state, setState] = useState(undefined);
  const [busy, setBusy] = useState(false);
  const base = `/api/projects/${encodeURIComponent(projectId)}`;
  const load = () =>
    fetch(`${base}/conversations`)
      .then((r) => (r.ok ? r.json() : null))
      .then(setState)
      .catch(() => setState(null));
  // biome-ignore lint/correctness/useExhaustiveDependencies: load once per project.
  useEffect(() => {
    load();
  }, [projectId]);
  if (state === undefined) return html`<div class="settings-empty">Reading conversations…</div>`;
  if (state === null)
    return html`<div class="settings-empty">The conversations setting could not be read.</div>`;
  const save = async (scope, values) => {
    setBusy(true);
    try {
      const res = await fetch(`${base}/setting`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope, values }),
      });
      if (!res.ok) return showToast((await res.json()).error || 'Not saved', 'error');
      const cleared = Object.values(values).every((v) => v === null);
      showToast(cleared ? 'Reset' : scope === 'me' ? 'Saved for you' : 'Saved for everyone', 'ok');
      await load();
    } finally {
      setBusy(false);
    }
  };
  const row = ([field, sub, label, help]) => {
    const path = `conversations.${sub}`;
    const value = at(state.settings, sub);
    const layer = {
      mine: at(state.mine, sub) ?? null,
      repository: at(state.repository, sub) ?? null,
      from: state.from[field],
      personalOnly: null,
    };
    const control =
      field === 'floor'
        ? html`<select class="settings-input small" aria-label=${label} disabled=${busy} value=${value}
            onChange=${(e) => save('me', { [path]: e.target.value })}>
            ${FLOORS.map(([id, text]) => html`<option key=${id} value=${id}>${text}</option>`)}
          </select>`
        : field === 'agentMayPass'
          ? html`<input type="checkbox" aria-label=${label} disabled=${busy} checked=${value}
              onChange=${(e) => save('me', { [path]: e.target.checked })} />`
          : html`<input class="settings-input small" type="number" aria-label=${label} disabled=${busy}
              min=${field === 'holdSeconds' ? 10 : 1} max=${field === 'maxAgentTurns' ? 100 : undefined} value=${value}
              onChange=${(e) => save('me', { [path]: Number(e.target.value) })} />`;
    return html`<${SettingRow} key=${field} path=${path} label=${label} help=${help} busy=${busy}
      source=${sourceOf(layer)} actions=${layeredActions(layer, save, { [path]: value })}>${control}</${SettingRow}>`;
  };
  return html`<section class="settings-card setting-rows conversation-settings" data-setting="conversations">
    ${state.repositoryError ? html`<p class="settings-desc">${state.repositoryFile}: ${state.repositoryError}</p>` : null}
    ${CONVERSATION_FIELDS.map(row)}
  </section>`;
}
