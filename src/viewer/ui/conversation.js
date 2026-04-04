/**
 * Conversation — center panel showing trace spans as a sequential timeline.
 *
 * Each agent call is an expandable row. Middleware/layer transitions are shown
 * as thin layer bands between calls. Sequential numbering (#1, #2, ...) on each span.
 */

import { html, useState } from "./lib.js";
import {
  traces, currentTrace, selectedSpanId, loadTraceDetail, layerColor,
} from "./store.js";
import { LayerBand } from "./layer-band.js";

function SpanRow({ span, index, depth = 0, onSelect, onLayerClick }) {
  const [expanded, setExpanded] = useState(false);
  const isSelected = selectedSpanId.value === span.id;
  const hasChildren = span.children && span.children.length > 0;
  const isAgent = ["dispatch", "execute", "decide"].includes(span.kind);
  const isMiddleware = span.kind === "middleware";
  const statusColor = span.status === "ok" ? "#4ade80" : span.status === "error" ? "#f87171" : "#facc15";

  const handleClick = () => {
    selectedSpanId.value = span.id;
    if (onSelect) onSelect(span);
  };

  // Middleware spans render thin
  if (isMiddleware && !expanded) {
    return html`
      <div
        class="span-row span-thin ${isSelected ? "selected" : ""}"
        onClick=${handleClick}
        title="${span.name} (${span.durationMs ? span.durationMs.toFixed(1) + "ms" : ""})"
      >
        <span class="span-index">#${index}</span>
        <span class="span-bar" style="background: ${statusColor}20; border-left: 2px solid ${statusColor}">
          <span class="span-thin-label">${span.name}</span>
          ${span.durationMs ? html`<span class="span-dur-tiny">${span.durationMs.toFixed(0)}ms</span>` : null}
        </span>
      </div>
    `;
  }

  return html`
    <div class="span-row-wrap" style="padding-left: ${depth * 12}px">
      <div
        class="span-row ${isAgent ? "span-agent" : ""} ${isSelected ? "selected" : ""}"
        onClick=${handleClick}
      >
        <span class="span-index">#${index}</span>
        <span class="span-status-dot" style="background: ${statusColor}"></span>
        <span class="span-name-col">${span.name}</span>
        <span class="span-kind-badge">${span.kind}</span>
        ${span.agentId ? html`<span class="span-agent-id">${span.agentId}</span>` : null}
        <span class="span-duration">${span.durationMs ? span.durationMs.toFixed(1) + "ms" : ""}</span>
        ${hasChildren ? html`
          <button
            class="span-expand-btn"
            onClick=${(e) => { e.stopPropagation(); setExpanded(!expanded); }}
          >${expanded ? "▼" : "▶"} ${span.children.length}</button>
        ` : null}
      </div>

      ${expanded && hasChildren ? html`
        <div class="span-children">
          ${renderSpanTree(span.children, depth + 1, onSelect, onLayerClick)}
        </div>
      ` : null}
    </div>
  `;
}

function renderSpanTree(spans, depth, onSelect, onLayerClick) {
  if (!spans || spans.length === 0) return null;

  const items = [];
  let globalIndex = 1;

  for (let i = 0; i < spans.length; i++) {
    const span = spans[i];

    // Layer band between spans (shows context that was active)
    if (i > 0 && span.layerIds && span.layerIds.length > 0) {
      items.push(html`
        <${LayerBand}
          key=${"band-" + span.id}
          layerIds=${span.layerIds}
          contextHash=${span.contextHash}
          onClick=${onLayerClick}
        />
      `);
    }

    items.push(html`
      <${SpanRow}
        key=${span.id}
        span=${span}
        index=${globalIndex++}
        depth=${depth}
        onSelect=${onSelect}
        onLayerClick=${onLayerClick}
      />
    `);
  }

  return items;
}

function TraceListItem({ trace, isActive, onClick }) {
  return html`
    <div
      class="trace-list-item ${isActive ? "active" : ""}"
      onClick=${() => onClick(trace.traceId)}
    >
      <span class="trace-msg-id">${trace.messageId}</span>
      <span class="trace-dur">
        ${trace.totalDurationMs ? trace.totalDurationMs.toFixed(0) + "ms" : "..."}
      </span>
      <div class="trace-stages">
        ${(trace.stages || []).map(s => html`
          <span key=${s.name} class="trace-stage ${s.status}">${s.name}</span>
        `)}
      </div>
    </div>
  `;
}

export function Conversation({ onSpanSelect, onLayerClick }) {
  const traceList = traces.value;
  const trace = currentTrace.value;

  // Flatten the span tree for the timeline view
  const flatSpans = trace ? flattenSpanTree(trace.root) : [];

  return html`
    <div class="conversation">
      <!-- Trace list header -->
      <div class="conv-header">
        <span class="panel-title">
          ${trace ? "TRACE: " + trace.messageId : "TRACES"}
        </span>
        ${trace ? html`
          <button class="back-btn" onClick=${() => { currentTrace.value = null; }}>
            ← All traces
          </button>
        ` : null}
      </div>

      ${!trace ? html`
        <!-- Trace list view -->
        <div class="trace-list">
          ${traceList.map(t => html`
            <${TraceListItem}
              key=${t.traceId}
              trace=${t}
              isActive=${false}
              onClick=${loadTraceDetail}
            />
          `)}
          ${traceList.length === 0 ? html`
            <div class="conv-empty">No traces yet. Send a message through the harness.</div>
          ` : null}
        </div>
      ` : html`
        <!-- Trace detail / conversation view -->
        <div class="conv-timeline">
          ${trace.root ? html`
            <!-- Top layer band showing initial context -->
            ${trace.root.layerIds ? html`
              <${LayerBand}
                layerIds=${trace.root.layerIds}
                contextHash=${trace.root.contextHash}
                onClick=${onLayerClick}
              />
            ` : null}

            <!-- Span timeline -->
            ${renderSpanTree(
              trace.root.children || [trace.root],
              0,
              onSpanSelect,
              onLayerClick
            )}
          ` : null}
        </div>
      `}
    </div>
  `;
}

/** Flatten a span tree into an ordered list (pre-order). */
function flattenSpanTree(root) {
  const result = [];
  function walk(span) {
    result.push(span);
    if (span.children) {
      for (const child of span.children) walk(child);
    }
  }
  walk(root);
  return result;
}
