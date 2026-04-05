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
} from "./store.js";

// ---------------------------------------------------------------------------
// Chat input bar
// ---------------------------------------------------------------------------

function ChatInput() {
  const [text, setText] = useState("");
  const inputRef = useRef(null);
  const isSending = sending.value;

  const handleSubmit = () => {
    if (!text.trim() || isSending) return;
    sendMessage(text.trim());
    setText("");
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
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
      <${ChatInput} />
    </div>
  `;
}
