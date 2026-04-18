/**
 * Conversation — center panel. Always chat mode.
 *
 * User types a message → harness processes it → agent responds.
 * Each agent response shows classification/route badges and a trace link.
 * Clicking "trace" opens trace details in the right pane (detail drawer).
 */

import { html, useState, useRef, useEffect } from "./lib.js";
import {
  messages, sending, inflight, sendMessage, selectedSpanId, loadTraceDetail,
  prompts, resolvePrompt, allThreads, tokenUsage, revertThread, forkThread,
} from "./store.js";

// ---------------------------------------------------------------------------
// Token bar — session usage + budget at top of conversation
// ---------------------------------------------------------------------------

function fmtNum(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(n);
}

function TokenBar() {
  const usage = tokenUsage.value;
  if (!usage) return null;

  const { usedTokens, totalInput, totalOutput, usedCost, totalCalls, percentage, warning, exceeded, limitCost, contextWindow, contextTokens, contextPct } = usage;
  if (usedTokens === 0 && totalCalls === 0) return null;

  const budgetPct = Math.min(percentage * 100, 100);
  const budgetColor = exceeded ? "#f87171" : warning ? "#facc15" : "#4ade80";
  const barClass = exceeded ? "token-bar--exceeded" : warning ? "token-bar--warning" : "";

  // Context window fill
  const ctxPct = contextPct != null ? Math.min(contextPct * 100, 100) : null;
  const ctxColor = ctxPct > 90 ? "#f87171" : ctxPct > 70 ? "#facc15" : "#6c9eff";

  return html`
    <div class="token-bar ${barClass}">
      <div class="token-bar-stats">
        <span class="token-stat">
          <span class="token-stat-value">${fmtNum(totalInput)}</span>
          <span class="token-stat-label">in</span>
        </span>
        <span class="token-stat-sep">/</span>
        <span class="token-stat">
          <span class="token-stat-value">${fmtNum(totalOutput)}</span>
          <span class="token-stat-label">out</span>
        </span>
        <span class="token-stat-divider"></span>
        <span class="token-stat">
          <span class="token-stat-value">${fmtNum(usedTokens)}</span>
          <span class="token-stat-label">tokens</span>
        </span>
        <span class="token-stat-divider"></span>
        <span class="token-stat">
          <span class="token-stat-value">$${usedCost.toFixed(4)}</span>
          <span class="token-stat-label">cost</span>
        </span>
        <span class="token-stat-divider"></span>
        <span class="token-stat">
          <span class="token-stat-value">${totalCalls}</span>
          <span class="token-stat-label">calls</span>
        </span>
      </div>
      <div class="token-bar-meters">
        ${ctxPct != null ? html`
          <div class="token-bar-meter" title="${fmtNum(contextTokens)} / ${fmtNum(contextWindow)} context window">
            <span class="token-bar-meter-label" style="color: ${ctxColor}">ctx</span>
            <div class="token-bar-track">
              <div class="token-bar-fill" style="width: ${ctxPct}%; background: ${ctxColor}"></div>
            </div>
            <span class="token-bar-pct" style="color: ${ctxColor}">${ctxPct.toFixed(0)}%</span>
          </div>
        ` : null}
        ${limitCost ? html`
          <div class="token-bar-meter" title="$${usedCost.toFixed(4)} / $${limitCost.toFixed(2)} budget">
            <span class="token-bar-meter-label" style="color: ${budgetColor}">$$$</span>
            <div class="token-bar-track">
              <div class="token-bar-fill" style="width: ${budgetPct}%; background: ${budgetColor}"></div>
            </div>
            <span class="token-bar-pct" style="color: ${budgetColor}">${budgetPct.toFixed(0)}%</span>
          </div>
        ` : null}
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Chat input bar
// ---------------------------------------------------------------------------

const inputHistory = [];
let historyIdx = -1;

function ChatInput() {
  const [text, setText] = useState("");
  const inputRef = useRef(null);

  const handleSubmit = () => {
    if (!text.trim()) return;
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
        placeholder="Send a message..."
        value=${text}
        onInput=${(e) => setText(e.target.value)}
        onKeyDown=${handleKeyDown}
        rows="1"
      ></textarea>
      <button
        class="chat-send-btn"
        onClick=${handleSubmit}
        disabled=${!text.trim()}
      >Send</button>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Chat messages
// ---------------------------------------------------------------------------

function MessageActions({ index }) {
  return html`
    <div class="msg-actions">
      <button class="msg-action-btn" onClick=${(e) => { e.stopPropagation(); revertThread(index); }}
        title="Revert to this point">revert</button>
      <button class="msg-action-btn" onClick=${(e) => { e.stopPropagation(); forkThread(index); }}
        title="Fork thread from here">fork</button>
    </div>
  `;
}

function UserMessage({ msg, index }) {
  return html`
    <div class="chat-msg chat-user">
      <${MessageActions} index=${index} />
      <div class="chat-msg-content">${msg.content}</div>
      <div class="chat-msg-time">${new Date(msg.timestamp).toLocaleTimeString()}</div>
    </div>
  `;
}

/** Thin expandable bar showing pipeline stage details. */
function PipelineBar({ stages, label, className, onTraceClick, traceId }) {
  const [expanded, setExpanded] = useState(false);
  if (!stages || stages.length === 0) return null;

  const totalMs = stages.reduce((sum, s) => sum + (s.durationMs || 0), 0);
  const summary = stages.map(s => s.name).join(" → ");

  return html`
    <div class="pipeline-bar ${className}" onClick=${() => setExpanded(!expanded)}>
      <span class="pipeline-bar-label">${label}</span>
      <span class="pipeline-bar-summary">${summary}</span>
      <span class="pipeline-bar-time">${totalMs > 0 ? `${totalMs.toFixed(0)}ms` : ""}</span>
      <span class="pipeline-bar-caret">${expanded ? "▼" : "▶"}</span>
    </div>
    ${expanded ? html`
      <div class="pipeline-bar-detail">
        ${stages.map((s, i) => html`
          <div key=${i} class="pipeline-stage ${s.status || ""}">
            <span class="pipeline-stage-name">${s.name}</span>
            ${s.agentId ? html`<span class="pipeline-stage-agent">${s.agentId}</span>` : null}
            ${s.durationMs ? html`<span class="pipeline-stage-ms">${s.durationMs.toFixed(0)}ms</span>` : null}
            ${s.tokens ? html`<span class="pipeline-stage-tokens">${s.tokens.input}→${s.tokens.output}t</span>` : null}
            ${s.cost ? html`<span class="pipeline-stage-cost">$${s.cost.toFixed(4)}</span>` : null}
          </div>
        `)}
        ${traceId ? html`
          <button class="pipeline-trace-btn" onClick=${(e) => { e.stopPropagation(); onTraceClick(traceId); }}>
            full trace
          </button>
        ` : null}
      </div>
    ` : null}
  `;
}

function AgentMessage({ msg, index, onTraceClick }) {
  const hasTrace = msg.traceId && msg.trace;
  const stages = msg.trace?.stages || [];

  // Split stages into pre-execution (classify, route, middleware) and post (guards, writeback)
  const execIdx = stages.findIndex(s => s.kind === "execute" || s.name?.includes("execut"));
  const preStages = execIdx > 0 ? stages.slice(0, execIdx) : [];
  const postStages = execIdx >= 0 && execIdx < stages.length - 1 ? stages.slice(execIdx + 1) : [];
  const execStage = execIdx >= 0 ? stages[execIdx] : null;

  return html`
    <div class="chat-msg chat-agent ${msg.error ? "chat-error" : ""}">
      <${MessageActions} index=${index} />
      <!-- Pre-execution bar: classify → route → context loading -->
      <${PipelineBar}
        stages=${preStages}
        label="pre"
        className="pipeline-pre"
        onTraceClick=${onTraceClick}
        traceId=${msg.traceId}
      />

      <!-- Classification + route badges (inline) -->
      ${msg.classification || msg.route || execStage ? html`
        <div class="chat-pipeline">
          ${msg.classification ? html`
            <span class="chat-badge classify">${msg.classification.category}</span>
          ` : null}
          ${msg.route ? html`
            <span class="chat-badge route">${msg.route.destination}</span>
          ` : null}
          ${execStage ? html`
            <span class="chat-badge exec">${execStage.agentId || "executor"}${execStage.durationMs ? ` ${(execStage.durationMs / 1000).toFixed(1)}s` : ""}</span>
          ` : null}
          ${hasTrace ? html`
            <button class="chat-trace-btn" onClick=${() => onTraceClick(msg.traceId)}
              title="Inspect trace in detail panel">
              trace ${msg.trace.totalDurationMs ? `(${(msg.trace.totalDurationMs / 1000).toFixed(1)}s)` : ""}
            </button>
          ` : null}
        </div>
      ` : null}

      <div class="chat-msg-content">${msg.content}</div>

      <!-- Post-execution bar: guards, writeback -->
      <${PipelineBar}
        stages=${postStages}
        label="post"
        className="pipeline-post"
        onTraceClick=${onTraceClick}
        traceId=${msg.traceId}
      />

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
      <${TokenBar} />
      <div class="chat-messages" ref=${scrollRef}>
        ${msgList.length === 0 ? html`
          <div class="conv-empty">
            Type a message below to start a conversation.<br/>
            Messages are routed through the agent pipeline.
          </div>
        ` : null}
        ${msgList.map((msg, i) =>
          msg.role === "user"
            ? html`<${UserMessage} key=${i} msg=${msg} index=${i} />`
            : html`<${AgentMessage} key=${i} msg=${msg} index=${i}
                onTraceClick=${handleTraceClick} />`
        )}
        ${sending.value ? html`
          <div class="chat-msg chat-agent chat-thinking">
            <div class="chat-msg-content">Processing${inflight.value > 1 ? ` (${inflight.value} in flight)` : ""}...</div>
          </div>
        ` : null}
      </div>
      <${PromptList} />
      <${ChatInput} />
    </div>
  `;
}
