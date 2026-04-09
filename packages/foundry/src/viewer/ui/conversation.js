/**
 * Conversation — center panel. Always chat mode.
 *
 * User types a message → harness processes it → agent responds.
 * Each agent response shows classification/route badges and a trace link.
 * Clicking "trace" opens trace details in the right pane (detail drawer).
 */

import { html, useState, useRef, useEffect } from "./lib.js";
import {
  messages, sending, sendMessage, selectedSpanId, loadTraceDetail,
  prompts, resolvePrompt, allThreads,
} from "./store.js";

// ---------------------------------------------------------------------------
// Chat input bar
// ---------------------------------------------------------------------------

const inputHistory = [];
let historyIdx = -1;

function ChatInput() {
  const [text, setText] = useState("");
  const inputRef = useRef(null);
  const isSending = sending.value;

  const handleSubmit = () => {
    if (!text.trim() || isSending) return;
    inputHistory.push(text.trim());
    historyIdx = -1;
    sendMessage(text.trim());
    setText("");
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
    if (e.key === "ArrowUp" && !text.includes("\n")) {
      if (inputHistory.length === 0) return;
      e.preventDefault();
      if (historyIdx === -1) historyIdx = inputHistory.length;
      historyIdx = Math.max(0, historyIdx - 1);
      setText(inputHistory[historyIdx]);
    }
    if (e.key === "ArrowDown" && !text.includes("\n")) {
      if (historyIdx === -1) return;
      e.preventDefault();
      historyIdx += 1;
      if (historyIdx >= inputHistory.length) {
        historyIdx = -1;
        setText("");
      } else {
        setText(inputHistory[historyIdx]);
      }
    }
  };

  return html`
    <div class="chat-input-bar">
      <textarea
        ref=${inputRef}
        class="chat-input"
        placeholder=${isSending ? "Processing..." : "Send a message..."}
        value=${text}
        onInput=${(e) => setText(e.target.value)}
        onKeyDown=${handleKeyDown}
        disabled=${isSending}
        rows="1"
      ></textarea>
      <button
        class="chat-send-btn"
        onClick=${handleSubmit}
        disabled=${!text.trim() || isSending}
      >${isSending ? "..." : "Send"}</button>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Chat messages
// ---------------------------------------------------------------------------

function UserMessage({ msg }) {
  return html`
    <div class="chat-msg chat-user">
      <div class="chat-msg-content">${msg.content}</div>
      <div class="chat-msg-time">${new Date(msg.timestamp).toLocaleTimeString()}</div>
    </div>
  `;
}

function AgentMessage({ msg, onTraceClick }) {
  const hasTrace = msg.traceId && msg.trace;

  return html`
    <div class="chat-msg chat-agent ${msg.error ? "chat-error" : ""}">
      <!-- Pipeline badges -->
      ${msg.classification || msg.route ? html`
        <div class="chat-pipeline">
          ${msg.classification ? html`
            <span class="chat-badge classify">${msg.classification.category}</span>
          ` : null}
          ${msg.route ? html`
            <span class="chat-badge route">${msg.route.destination}</span>
          ` : null}
          ${hasTrace ? html`
            <button class="chat-trace-btn" onClick=${() => onTraceClick(msg.traceId)}
              title="Inspect trace in detail panel">
              trace ${msg.trace.totalDurationMs ? `(${msg.trace.totalDurationMs.toFixed(0)}ms)` : ""}
            </button>
          ` : null}
        </div>
      ` : null}

      <div class="chat-msg-content">${msg.content}</div>
      <div class="chat-msg-time">${new Date(msg.timestamp).toLocaleTimeString()}</div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Prompt cards — pending agent→human interactions
// ---------------------------------------------------------------------------

/** Walk the thread tree to build a breadcrumb path for a given threadId. */
function threadBreadcrumb(threadId) {
  const threads = allThreads.value || [];
  // Build parent map from thread tree
  const parentMap = {};
  const threadMap = {};
  function walk(nodes) {
    for (const t of nodes) {
      const id = t.threadId || t.id;
      threadMap[id] = t;
      for (const child of (t.children || [])) {
        const cid = child.threadId || child.id;
        parentMap[cid] = id;
        walk([child]);
      }
    }
  }
  walk(threads);

  // Walk up from threadId to root
  const path = [];
  let cur = threadId;
  while (cur) {
    path.unshift(cur);
    cur = parentMap[cur];
  }
  return path;
}

function PromptCard({ prompt }) {
  const [input, setInput] = useState("");
  const [resolving, setResolving] = useState(false);

  const urgencyClass = prompt.urgency === "critical" ? "prompt-critical"
    : prompt.urgency === "high" ? "prompt-high" : "";

  const handleAction = async (action) => {
    setResolving(true);
    await resolvePrompt(prompt.id, action, input || undefined);
    setResolving(false);
  };

  const options = prompt.options || [];
  const isInput = prompt.kind === "input";
  const isChoice = prompt.kind === "choice";

  const breadcrumb = prompt.threadId ? threadBreadcrumb(prompt.threadId) : [];

  return html`
    <div class="prompt-card ${urgencyClass}">
      <div class="prompt-card-header">
        <span class="prompt-kind">${prompt.kind}</span>
        ${prompt.agentId ? html`<span class="prompt-agent">${prompt.agentId}</span>` : null}
        ${prompt.capability ? html`<span class="prompt-cap">${prompt.capability}</span>` : null}
        ${prompt.urgency && prompt.urgency !== "normal"
          ? html`<span class="prompt-urgency ${urgencyClass}">${prompt.urgency}</span>` : null}
      </div>
      ${breadcrumb.length > 0 ? html`
        <div class="prompt-breadcrumb">
          ${breadcrumb.map((seg, i) => html`
            <span key=${seg}>
              ${i > 0 ? html`<span class="prompt-breadcrumb-sep">/</span>` : null}
              <span class="prompt-breadcrumb-seg ${i === breadcrumb.length - 1 ? "current" : ""}">${seg}</span>
            </span>
          `)}
        </div>
      ` : null}
      <div class="prompt-card-message">${prompt.message}</div>
      ${prompt.detail ? html`<div class="prompt-card-detail">${prompt.detail}</div>` : null}

      ${isInput ? html`
        <input
          class="prompt-input"
          placeholder="Type your response..."
          value=${input}
          onInput=${(e) => setInput(e.target.value)}
          disabled=${resolving}
        />
      ` : null}

      <div class="prompt-card-actions">
        ${isChoice && options.length > 0 ? options.map(opt => html`
          <button key=${opt.action}
            class="prompt-btn"
            onClick=${() => handleAction(opt.action)}
            disabled=${resolving}
            title=${opt.description || ""}
          >${opt.label}</button>
        `) : html`
          <button class="prompt-btn prompt-btn-approve"
            onClick=${() => handleAction("approve")}
            disabled=${resolving}>Approve</button>
          <button class="prompt-btn prompt-btn-reject"
            onClick=${() => handleAction("reject")}
            disabled=${resolving}>Reject</button>
        `}
      </div>
    </div>
  `;
}

function PromptList() {
  const pending = prompts.value;
  if (!pending || pending.length === 0) return null;

  return html`
    <div class="prompt-list">
      ${pending.map(p => html`<${PromptCard} key=${p.id} prompt=${p} />`)}
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Conversation (exported)
// ---------------------------------------------------------------------------

export function Conversation({ onTraceSelect }) {
  const msgList = messages.value;
  const scrollRef = useRef(null);

  // Auto-scroll on new messages
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [msgList.length]);

  const handleTraceClick = (traceId) => {
    // Load trace and show in detail drawer (right pane)
    loadTraceDetail(traceId);
    if (onTraceSelect) onTraceSelect(traceId);
  };

  return html`
    <div class="conversation">
      <div class="chat-messages" ref=${scrollRef}>
        ${msgList.length === 0 ? html`
          <div class="conv-empty">
            Type a message below to start a conversation.<br/>
            Messages are routed through the agent pipeline.
          </div>
        ` : null}
        ${msgList.map((msg, i) =>
          msg.role === "user"
            ? html`<${UserMessage} key=${i} msg=${msg} />`
            : html`<${AgentMessage} key=${i} msg=${msg}
                onTraceClick=${handleTraceClick} />`
        )}
        ${sending.value ? html`
          <div class="chat-msg chat-agent chat-thinking">
            <div class="chat-msg-content">Processing...</div>
          </div>
        ` : null}
      </div>
      <${PromptList} />
      <${ChatInput} />
    </div>
  `;
}
