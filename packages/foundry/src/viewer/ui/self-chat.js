/**
 * Foundry-self chat pane — a persistent, single-thread helper embedded
 * in the settings modal. Knows what the operator is currently viewing
 * (scope/tab/focus) and uses the default executor model.
 */

import { html, useState, useEffect, useRef } from "./lib.js";
import { signal } from "./lib.js";
import { showToast } from "./store.js";

export const selfChatCollapsed = signal(false);
export const selfChatMessages = signal([]);
const selfChatSending = signal(false);

export async function loadSelfChat() {
  try {
    const res = await fetch("/api/self-chat");
    const data = await res.json();
    selfChatMessages.value = data.messages || [];
  } catch {
    /* ignore — fresh install */
  }
}

async function clearSelfChat() {
  try {
    const res = await fetch("/api/self-chat", { method: "DELETE" });
    const data = await res.json();
    selfChatMessages.value = data.messages || [];
    showToast("Chat cleared", "ok");
  } catch {
    showToast("Failed to clear", "error");
  }
}

async function sendSelfChat(text, focus) {
  selfChatSending.value = true;
  try {
    const res = await fetch("/api/self-chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, focus }),
    });
    const data = await res.json();
    if (data.messages) selfChatMessages.value = data.messages;
    if (data.error) showToast(data.error, "error");
  } catch (err) {
    showToast(`Chat failed: ${err.message}`, "error");
  } finally {
    selfChatSending.value = false;
  }
}

function describeFocus(focus) {
  if (!focus) return null;
  const bits = [];
  if (focus.scope) bits.push(html`<b>${focus.scope}</b>`);
  if (focus.projectId) bits.push(html`project=${focus.projectId}`);
  if (focus.tab) bits.push(html`tab=${focus.tab}`);
  if (focus.focusKind && focus.focusId) bits.push(html`<b>${focus.focusKind}:${focus.focusId}</b>`);
  if (bits.length === 0) return null;
  const joined = [];
  bits.forEach((b, i) => {
    if (i > 0) joined.push(" \u00B7 ");
    joined.push(b);
  });
  return joined;
}

export function SelfChatPane({ focus }) {
  const collapsed = selfChatCollapsed.value;
  const messages = selfChatMessages.value;
  const sending = selfChatSending.value;
  const [draft, setDraft] = useState("");
  const listRef = useRef(null);

  useEffect(() => { loadSelfChat(); }, []);

  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [messages.length, sending]);

  const onSubmit = (e) => {
    e.preventDefault();
    const text = draft.trim();
    if (!text || sending) return;
    setDraft("");
    sendSelfChat(text, focus);
  };

  const onKeyDown = (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      onSubmit(e);
    }
  };

  if (collapsed) {
    return html`
      <div class="settings-chat collapsed">
        <button
          class="settings-chat-toggle"
          onClick=${() => { selfChatCollapsed.value = false; }}
          title="Expand AI helper"
        >AI helper</button>
      </div>
    `;
  }

  const focusDesc = describeFocus(focus);

  return html`
    <div class="settings-chat">
      <div class="settings-chat-header">
        <span class="settings-chat-title">foundry-self</span>
        <span class="settings-chat-meta">${messages.length} msgs</span>
        <button
          class="settings-chat-toggle"
          style="writing-mode: horizontal-tb; transform: none; padding: 2px 6px;"
          onClick=${() => { selfChatCollapsed.value = true; }}
          title="Collapse"
        >\u203A</button>
      </div>
      <div class="settings-chat-actions">
        <button class="settings-chat-action" onClick=${() => loadSelfChat()}>reload</button>
        <button class="settings-chat-action" onClick=${() => clearSelfChat()}>clear history</button>
      </div>
      ${focusDesc ? html`
        <div class="settings-chat-focus">viewing: ${focusDesc}</div>
      ` : null}
      <div class="settings-chat-messages" ref=${listRef}>
        ${messages.length === 0 ? html`
          <div class="settings-chat-msg system">
            Ask about customizing Foundry — agents, layers, providers, sources, or how anything works.
            I can see the full Foundry repo and the object you're currently looking at.
          </div>
        ` : messages.map((m, i) => html`
          <div key=${i} class="settings-chat-msg ${m.role}">
            ${m.role === "assistant" ? html`
              <div class="settings-chat-msg-kind">foundry-self</div>
            ` : null}
            ${m.content}
          </div>
        `)}
        ${sending ? html`
          <div class="settings-chat-msg assistant">
            <div class="settings-chat-msg-kind">foundry-self</div>
            thinking\u2026
          </div>
        ` : null}
      </div>
      <form class="settings-chat-form" onSubmit=${onSubmit}>
        <textarea
          class="settings-chat-input"
          placeholder="Ask about this setting\u2026 (\u2318\u21B5 to send)"
          value=${draft}
          onInput=${(e) => setDraft(e.target.value)}
          onKeyDown=${onKeyDown}
          disabled=${sending}
          rows="2"
        ></textarea>
        <button class="settings-chat-send" type="submit" disabled=${sending || !draft.trim()}>
          send
        </button>
      </form>
    </div>
  `;
}
