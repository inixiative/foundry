/**
 * DetailDrawer — right panel showing detailed info for selected span/layer.
 *
 * Shows: inputs/outputs, corrections, context state, cache info, layer detail.
 * Content changes based on what's selected in the conversation.
 */

import { html, useState } from "./lib.js";
import {
  selectedSpanId, currentTrace, layerColor, threadData,
  submitIntervention, executeAction,
} from "./store.js";

function Section({ title, open: defaultOpen = true, children }) {
  const [open, setOpen] = useState(defaultOpen);
  return html`
    <div class="detail-section">
      <div class="detail-section-header" onClick=${() => setOpen(!open)}>
        <span class="detail-caret">${open ? "▼" : "▶"}</span>
        <span class="detail-section-title">${title}</span>
      </div>
      ${open ? html`<div class="detail-section-body">${children}</div>` : null}
    </div>
  `;
}

function JsonBlock({ data, maxHeight = 200 }) {
  if (data === undefined || data === null) return html`<span class="detail-null">null</span>`;
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return html`
    <pre class="detail-json" style="max-height: ${maxHeight}px">${text}</pre>
  `;
}

function OverrideForm({ traceId, spanId }) {
  const [correction, setCorrection] = useState("");
  const [reason, setReason] = useState("");
  const [submitted, setSubmitted] = useState(false);

  if (submitted) return html`<div class="detail-ok">Correction submitted</div>`;

  return html`
    <div class="override-form">
      <textarea
        class="override-input"
        placeholder="What should this have been? (JSON or text)"
        value=${correction}
        onInput=${(e) => setCorrection(e.target.value)}
        rows="3"
      ></textarea>
      <input
        class="override-reason"
        placeholder="Reason (optional)"
        value=${reason}
        onInput=${(e) => setReason(e.target.value)}
      />
      <button
        class="override-submit"
        disabled=${!correction.trim()}
        onClick=${async () => {
          await submitIntervention(traceId, spanId, correction, reason);
          setSubmitted(true);
        }}
      >Submit Correction</button>
    </div>
  `;
}

function SpanDetail({ span, traceId }) {
  const isOverrideable = span.kind === "route" || span.kind === "classify";

  return html`
    <div class="detail-content">
      <!-- Header -->
      <div class="detail-header">
        <span class="detail-name">${span.name}</span>
        <span class="detail-kind-badge">${span.kind}</span>
        <span class="detail-status ${span.status}">${span.status}</span>
      </div>

      <!-- Metadata -->
      <div class="detail-meta-row">
        ${span.agentId ? html`<div class="detail-meta"><label>Agent</label><span>${span.agentId}</span></div>` : null}
        ${span.durationMs != null ? html`<div class="detail-meta"><label>Duration</label><span>${span.durationMs.toFixed(1)}ms</span></div>` : null}
        ${span.contextHash ? html`<div class="detail-meta"><label>Context Hash</label><span class="mono">${span.contextHash}</span></div>` : null}
      </div>

      <!-- Context layers -->
      ${span.layerIds && span.layerIds.length > 0 ? html`
        <${Section} title="Context Layers (${span.layerIds.length})">
          <div class="detail-layers">
            ${span.layerIds.map(id => html`
              <span key=${id} class="detail-layer-chip" style="border-color: ${layerColor(id)}">
                <span class="detail-layer-dot" style="background: ${layerColor(id)}"></span>
                ${id}
              </span>
            `)}
          </div>
        </${Section}>
      ` : null}

      <!-- Input -->
      ${span.input !== undefined ? html`
        <${Section} title="Input">
          <${JsonBlock} data=${span.input} />
        </${Section}>
      ` : null}

      <!-- Output -->
      ${span.output !== undefined ? html`
        <${Section} title="Output">
          <${JsonBlock} data=${span.output} />
        </${Section}>
      ` : null}

      <!-- Error -->
      ${span.error ? html`
        <${Section} title="Error">
          <${JsonBlock} data=${span.error} />
        </${Section}>
      ` : null}

      <!-- Annotations -->
      ${span.annotations && Object.keys(span.annotations).length > 0 ? html`
        <${Section} title="Annotations">
          <${JsonBlock} data=${span.annotations} />
        </${Section}>
      ` : null}

      <!-- Override form for route/classify -->
      ${isOverrideable ? html`
        <${Section} title="Correction" open=${false}>
          <${OverrideForm} traceId=${traceId} spanId=${span.id} />
        </${Section}>
      ` : null}
    </div>
  `;
}

function LayerDetail({ layerId }) {
  const data = threadData.value;
  const layer = (data?.layers || []).find(l => l.id === layerId);
  if (!layer) return html`<div class="detail-empty">Layer not found</div>`;

  return html`
    <div class="detail-content">
      <div class="detail-header">
        <span class="detail-layer-dot-lg" style="background: ${layerColor(layer.id)}"></span>
        <span class="detail-name">${layer.id}</span>
        <span class="detail-status ${layer.state}">${layer.state}</span>
      </div>

      <div class="detail-meta-row">
        <div class="detail-meta"><label>Trust</label><span>${layer.trust}</span></div>
        <div class="detail-meta"><label>Content</label><span>${layer.contentLength} chars</span></div>
        <div class="detail-meta"><label>Tokens</label><span>~${Math.ceil(layer.contentLength / 4)}</span></div>
        <div class="detail-meta"><label>Hash</label><span class="mono">${layer.hash || "—"}</span></div>
      </div>

      <div class="detail-actions">
        <button class="action-btn" onClick=${() => executeAction("layer:warm", layer.id)}>
          Touch (warm)
        </button>
        <button class="action-btn danger" onClick=${() => executeAction("layer:invalidate", layer.id)}>
          Invalidate
        </button>
      </div>
    </div>
  `;
}

export function DetailDrawer({ selectedSpan, selectedLayer }) {
  const trace = currentTrace.value;

  // Find the selected span in the trace tree
  let span = null;
  if (selectedSpan && trace?.root) {
    span = findSpan(trace.root, selectedSpan.id || selectedSpanId.value);
  }

  return html`
    <div class="detail-drawer">
      <div class="panel-header">
        <span class="panel-title">DETAIL</span>
      </div>

      ${selectedLayer ? html`
        <${LayerDetail} layerId=${selectedLayer} />
      ` : span && trace ? html`
        <${SpanDetail} span=${span} traceId=${trace.id} />
      ` : html`
        <div class="detail-empty">
          <p>Select a span or layer to inspect</p>
          <div class="detail-hint">
            <kbd>j</kbd>/<kbd>k</kbd> navigate, <kbd>Enter</kbd> expand, <kbd>?</kbd> help
          </div>
        </div>
      `}
    </div>
  `;
}

/** Find a span by ID in a tree. */
function findSpan(root, id) {
  if (root.id === id) return root;
  if (root.children) {
    for (const child of root.children) {
      const found = findSpan(child, id);
      if (found) return found;
    }
  }
  return null;
}
