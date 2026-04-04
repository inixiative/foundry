/**
 * ThreadTree — left panel showing thread hierarchy (file-tree style).
 * Shows branching threads with status indicators.
 */

import { html, useState, useEffect } from "./lib.js";
import { threadData, loadTraceDetail, traces, layerColor } from "./store.js";

function StatusDot({ status }) {
  const colors = {
    active: "#4ade80",
    idle: "#6c9eff",
    waiting: "#facc15",
    archived: "#888",
  };
  const color = colors[status] || "#888";
  return html`<span style="
    display: inline-block; width: 8px; height: 8px; border-radius: 50%;
    background: ${color}; flex-shrink: 0;
  " title=${status}></span>`;
}

function ThreadNode({ thread, depth = 0, selectedId, onSelect }) {
  const [expanded, setExpanded] = useState(true);
  const isSelected = selectedId === thread.id;
  const hasChildren = thread.children && thread.children.length > 0;

  return html`
    <div style="padding-left: ${depth * 16}px">
      <div
        class="tree-node ${isSelected ? "selected" : ""}"
        onClick=${() => onSelect(thread.id)}
      >
        ${hasChildren ? html`
          <span
            class="tree-caret"
            onClick=${(e) => { e.stopPropagation(); setExpanded(!expanded); }}
          >${expanded ? "▼" : "▶"}</span>
        ` : html`<span class="tree-caret-spacer"></span>`}
        <${StatusDot} status=${thread.status} />
        <span class="tree-label">${thread.id}</span>
        <span class="tree-meta">${thread.agentCount || ""}</span>
      </div>
      ${expanded && hasChildren ? thread.children.map(child =>
        html`<${ThreadNode}
          key=${child.id}
          thread=${child}
          depth=${depth + 1}
          selectedId=${selectedId}
          onSelect=${onSelect}
        />`
      ) : null}
    </div>
  `;
}

export function ThreadTree({ onThreadSelect }) {
  const data = threadData.value;
  const traceList = traces.value;
  const [selectedThread, setSelectedThread] = useState(null);

  // Build thread tree from flat data
  const rootThread = data ? {
    id: data.threadId,
    status: data.meta?.status || "idle",
    description: data.meta?.description || "",
    tags: data.meta?.tags || [],
    agentCount: data.agents?.length || 0,
    children: [], // Future: populate from SessionManager tree
  } : null;

  const handleSelect = (id) => {
    setSelectedThread(id);
    if (onThreadSelect) onThreadSelect(id);
  };

  return html`
    <div class="thread-tree">
      <div class="panel-header">
        <span class="panel-title">THREADS</span>
      </div>

      ${rootThread ? html`
        <${ThreadNode}
          thread=${rootThread}
          selectedId=${selectedThread}
          onSelect=${handleSelect}
        />
      ` : html`<div class="tree-empty">No threads</div>`}

      <div class="panel-header" style="margin-top: 12px">
        <span class="panel-title">LAYERS</span>
      </div>

      <div class="layer-list">
        ${(data?.layers || []).map(l => html`
          <div class="layer-item" key=${l.id}>
            <span class="layer-dot" style="background: ${layerColor(l.id)}"></span>
            <span class="layer-name">${l.id}</span>
            <span class="layer-state ${l.state}">${l.state}</span>
            <span class="layer-trust">${l.trust}</span>
          </div>
        `)}
      </div>

      <div class="panel-header" style="margin-top: 12px">
        <span class="panel-title">AGENTS</span>
      </div>

      <div class="agent-list">
        ${(data?.agents || []).map(a => html`
          <div class="agent-item" key=${a.id}>
            <span class="agent-icon">◆</span>
            <span class="agent-name">${a.agentId}</span>
          </div>
        `)}
      </div>
    </div>
  `;
}
