/**
 * DetailDrawer — right panel.
 *
 * Shows (in priority order):
 *   1. Trace detail with summary/raw tabs (when a trace is selected)
 *   2. Span detail (when a span within the trace is selected)
 *   3. Layer detail (when a layer is clicked in sidebar)
 *   4. Creation forms (when [+] is clicked)
 *   5. Empty state
 */

import { html, useState } from "./lib.js";
import {
  selectedSpanId, currentTrace, layerColor, threadData,
  submitIntervention, executeAction, createDefinition, definitions,
  detailDrawerOpen, activeProjectId, authFetch, showToast,
  loadDefinitions,
} from "./store.js";
import { settingsConfig } from "./settings.js";
import { LayerBand } from "./layer-band.js";

// ---------------------------------------------------------------------------
// Shared components
// ---------------------------------------------------------------------------

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

function JsonBlock({ data, maxHeight = 300 }) {
  if (data === undefined || data === null) return html`<span class="detail-null">null</span>`;
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return html`<pre class="detail-json" style="max-height: ${maxHeight}px">${text}</pre>`;
}

// ---------------------------------------------------------------------------
// Trace detail — summary / raw tabs
// ---------------------------------------------------------------------------

function TraceDetail({ trace, onSpanSelect }) {
  const [tab, setTab] = useState("summary"); // "summary" | "spans" | "raw"
  const summary = trace.summary || trace;

  return html`
    <div class="detail-content">
      <div class="detail-header">
        <span class="detail-name">${trace.messageId || trace.id}</span>
        <span class="detail-kind-badge">trace</span>
        ${trace.durationMs ? html`
          <span class="detail-status ok">${trace.durationMs.toFixed(0)}ms</span>
        ` : null}
      </div>

      <!-- Tabs: summary / spans / raw -->
      <div class="detail-tabs">
        <button class="detail-tab ${tab === "summary" ? "active" : ""}"
          onClick=${() => setTab("summary")}>Summary</button>
        <button class="detail-tab ${tab === "spans" ? "active" : ""}"
          onClick=${() => setTab("spans")}>Spans</button>
        <button class="detail-tab ${tab === "raw" ? "active" : ""}"
          onClick=${() => setTab("raw")}>Raw</button>
      </div>

      ${tab === "summary" ? html`
        <${TraceSummaryView} trace=${trace} summary=${summary} />
      ` : tab === "spans" ? html`
        <${TraceSpanTree} trace=${trace} onSpanSelect=${onSpanSelect} />
      ` : html`
        <${TraceRawView} trace=${trace} />
      `}
    </div>
  `;
}

function TraceSummaryView({ trace, summary }) {
  const stages = summary.stages || [];
  return html`
    <div class="trace-summary">
      <!-- Timing -->
      <div class="detail-meta-row">
        ${trace.durationMs ? html`<div class="detail-meta"><label>Duration</label><span>${trace.durationMs.toFixed(1)}ms</span></div>` : null}
        ${stages.length ? html`<div class="detail-meta"><label>Stages</label><span>${stages.length}</span></div>` : null}
        ${trace.startedAt ? html`<div class="detail-meta"><label>Started</label><span>${new Date(trace.startedAt).toLocaleTimeString()}</span></div>` : null}
      </div>

      <!-- Pipeline stages -->
      ${stages.length > 0 ? html`
        <${Section} title="Pipeline (${stages.length} stages)">
          <div class="trace-stages-list">
            ${stages.map((s, i) => html`
              <div key=${i} class="trace-stage-row">
                <span class="trace-stage-idx">${i + 1}</span>
                <span class="trace-stage-name">${s.name}</span>
                <span class="trace-stage-status ${s.status}">${s.status}</span>
                ${s.durationMs != null ? html`
                  <span class="trace-stage-dur">${s.durationMs.toFixed(0)}ms</span>
                ` : null}
                ${s.agentId ? html`
                  <span class="trace-stage-agent">${s.agentId}</span>
                ` : null}
              </div>
            `)}
          </div>
        </${Section}>
      ` : null}
    </div>
  `;
}

function TraceSpanTree({ trace, onSpanSelect }) {
  if (!trace.root) return html`<div class="sidebar-empty-sm">No spans</div>`;

  return html`
    <div class="trace-span-tree">
      ${renderSpanList(trace.root.children || [trace.root], 0, onSpanSelect)}
    </div>
  `;
}

function renderSpanList(spans, depth, onSelect) {
  return spans.map((span, i) => html`
    <${SpanRow} key=${span.id} span=${span} depth=${depth} onSelect=${onSelect} />
  `);
}

function SpanRow({ span, depth, onSelect }) {
  const [expanded, setExpanded] = useState(depth < 2);
  const isSelected = selectedSpanId.value === span.id;
  const hasChildren = span.children && span.children.length > 0;
  const statusColor = span.status === "ok" ? "var(--ok)" : span.status === "error" ? "var(--error)" : "var(--warn)";

  return html`
    <div style="padding-left: ${depth * 12}px">
      <div class="span-row ${isSelected ? "selected" : ""}"
        onClick=${() => { selectedSpanId.value = span.id; if (onSelect) onSelect(span); }}>
        ${hasChildren ? html`
          <span class="tree-caret" onClick=${(e) => { e.stopPropagation(); setExpanded(!expanded); }}>
            ${expanded ? "▼" : "▶"}
          </span>
        ` : html`<span class="tree-caret-spacer"></span>`}
        <span class="span-status-dot" style="background: ${statusColor}"></span>
        <span class="span-kind-badge">${span.kind}</span>
        <span class="span-name-col">${span.name || span.agentId || ""}</span>
        ${span.durationMs ? html`<span class="span-duration">${span.durationMs.toFixed(0)}ms</span>` : null}
      </div>
      ${expanded && hasChildren ? renderSpanList(span.children, depth + 1, onSelect) : null}
    </div>
  `;
}

function TraceRawView({ trace }) {
  return html`
    <div class="trace-raw">
      <${JsonBlock} data=${trace} maxHeight=${600} />
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Span detail (when a specific span is selected within the trace)
// ---------------------------------------------------------------------------

function SpanDetail({ span, traceId }) {
  const isOverrideable = span.kind === "route" || span.kind === "classify";

  return html`
    <div class="detail-content">
      <div class="detail-header">
        <span class="detail-name">${span.name}</span>
        <span class="detail-kind-badge">${span.kind}</span>
        <span class="detail-status ${span.status}">${span.status}</span>
      </div>

      <div class="detail-meta-row">
        ${span.agentId ? html`<div class="detail-meta"><label>Agent</label><span>${span.agentId}</span></div>` : null}
        ${span.durationMs != null ? html`<div class="detail-meta"><label>Duration</label><span>${span.durationMs.toFixed(1)}ms</span></div>` : null}
        ${span.contextHash ? html`<div class="detail-meta"><label>Context</label><span class="mono">${span.contextHash}</span></div>` : null}
      </div>

      ${span.layerIds && span.layerIds.length > 0 ? html`
        <${Section} title="Layers (${span.layerIds.length})">
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

      ${span.input !== undefined ? html`<${Section} title="Input"><${JsonBlock} data=${span.input} /></${Section}>` : null}
      ${span.output !== undefined ? html`<${Section} title="Output"><${JsonBlock} data=${span.output} /></${Section}>` : null}
      ${span.error ? html`<${Section} title="Error"><${JsonBlock} data=${span.error} /></${Section}>` : null}
      ${span.annotations && Object.keys(span.annotations).length > 0 ? html`
        <${Section} title="Annotations"><${JsonBlock} data=${span.annotations} /></${Section}>
      ` : null}

      ${isOverrideable ? html`
        <${Section} title="Correction" open=${false}>
          <${OverrideForm} traceId=${traceId} spanId=${span.id} />
        </${Section}>
      ` : null}
    </div>
  `;
}

function OverrideForm({ traceId, spanId }) {
  const [correction, setCorrection] = useState("");
  const [reason, setReason] = useState("");
  const [submitted, setSubmitted] = useState(false);

  if (submitted) return html`<div class="detail-ok">Correction submitted</div>`;

  return html`
    <div class="override-form">
      <textarea class="override-input" placeholder="What should this have been?"
        value=${correction} onInput=${(e) => setCorrection(e.target.value)} rows="3"></textarea>
      <input class="override-reason" placeholder="Reason (optional)"
        value=${reason} onInput=${(e) => setReason(e.target.value)} />
      <button class="override-submit" disabled=${!correction.trim()}
        onClick=${async () => { await submitIntervention(traceId, spanId, correction, reason); setSubmitted(true); }}
      >Submit Correction</button>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Layer detail
// ---------------------------------------------------------------------------

function LayerDetail({ layerId }) {
  const data = threadData.value;
  const layer = (data?.layers || []).find(l => l.id === layerId);
  const layerDef = (definitions.value?.layers || []).find(l => l.id === layerId);

  if (!layer && !layerDef) return html`<div class="detail-empty">Layer not found</div>`;

  if (layer) {
    return html`
      <div class="detail-content">
        <div class="detail-header">
          <span class="detail-layer-dot-lg" style="background: ${layerColor(layer.id)}"></span>
          <span class="detail-name">${layer.id}</span>
          <span class="detail-status ${layer.state}">${layer.state}</span>
        </div>
        <${ScopeBar} section="layers" itemId=${layer.id} />
        <div class="detail-meta-row">
          <div class="detail-meta"><label>Trust</label><span>${layer.trust}</span></div>
          <div class="detail-meta"><label>Content</label><span>${layer.contentLength} chars</span></div>
          <div class="detail-meta"><label>Tokens</label><span>~${Math.ceil(layer.contentLength / 4)}</span></div>
          <div class="detail-meta"><label>Hash</label><span class="mono">${layer.hash || "\u2014"}</span></div>
        </div>
        ${layerDef ? html`
          <${Section} title="Definition">
            <div class="detail-def-fields">
              ${layerDef.prompt ? html`<div class="def-field"><label>Prompt</label><pre class="detail-json">${layerDef.prompt}</pre></div>` : null}
              <div class="def-field"><label>Sources</label><span>${(layerDef.sourceIds || []).join(", ") || "none"}</span></div>
              <div class="def-field"><label>Staleness</label><span>${layerDef.staleness ? layerDef.staleness + "ms" : "never"}</span></div>
            </div>
          </${Section}>
        ` : null}
        <div class="detail-actions">
          <button class="action-btn" onClick=${() => executeAction("layer:warm", layer.id)}>Touch (warm)</button>
          <button class="action-btn danger" onClick=${() => executeAction("layer:invalidate", layer.id)}>Invalidate</button>
        </div>
      </div>
    `;
  }

  // Uninstantiated definition
  return html`
    <div class="detail-content">
      <div class="detail-header">
        <span class="detail-layer-dot-lg" style="background: ${layerColor(layerDef.id)}; opacity: 0.5"></span>
        <span class="detail-name">${layerDef.id}</span>
        <span class="detail-status cold">not instantiated</span>
      </div>
      <${ScopeBar} section="layers" itemId=${layerDef.id} />
      <div class="detail-def-fields">
        ${layerDef.prompt ? html`<div class="def-field"><label>Prompt</label><pre class="detail-json">${layerDef.prompt}</pre></div>` : null}
        <div class="def-field"><label>Trust</label><span>${layerDef.trust}</span></div>
        <div class="def-field"><label>Sources</label><span>${(layerDef.sourceIds || []).join(", ") || "none"}</span></div>
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Scope bar — global vs project with fork/unfork controls
// ---------------------------------------------------------------------------

function ScopeBar({ section, itemId }) {
  const projectId = activeProjectId.value;
  const config = settingsConfig.value;

  // No project selected → always global
  if (!projectId || !config) {
    return html`<div class="scope-bar"><span class="scope-label scope-global">global</span></div>`;
  }

  const projectConfig = config.projects?.[projectId];
  const hasOverride = projectConfig?.[section]?.[itemId] != null;

  const handleFork = async () => {
    // Copy global config into project overrides
    const globalItem = config[section]?.[itemId];
    if (!globalItem) return;
    try {
      const patch = { [section]: { ...projectConfig?.[section], [itemId]: { ...globalItem } } };
      const res = await authFetch(`/api/settings/projects`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [projectId]: { ...projectConfig, ...patch } }),
      });
      if (res.ok) {
        settingsConfig.value = await res.json();
        showToast(`Created project override for ${itemId}`, "ok");
      }
    } catch { showToast("Failed to create project copy", "error"); }
  };

  const handleUnfork = async () => {
    // Remove the project override — fall back to global
    try {
      const overrides = { ...projectConfig?.[section] };
      delete overrides[itemId];
      const patch = { [section]: overrides };
      const res = await authFetch(`/api/settings/projects`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [projectId]: { ...projectConfig, ...patch } }),
      });
      if (res.ok) {
        settingsConfig.value = await res.json();
        showToast(`Removed project override — using global ${itemId}`, "ok");
      }
    } catch { showToast("Failed to remove project copy", "error"); }
  };

  return html`
    <div class="scope-bar">
      ${hasOverride ? html`
        <span class="scope-label scope-project">${projectId} override</span>
        <button class="scope-btn" onClick=${handleUnfork} title="Remove project override, use global">use global</button>
      ` : html`
        <span class="scope-label scope-global">global</span>
        <button class="scope-btn" onClick=${handleFork} title="Create project-specific copy">fork for ${projectId}</button>
      `}
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Agent detail
// ---------------------------------------------------------------------------

function AgentDetail({ agentId }) {
  const data = threadData.value;
  const instance = (data?.agents || []).find(a => a.agentId === agentId);
  const agentDef = (definitions.value?.agents || []).find(a => a.id === agentId);

  if (!instance && !agentDef) return html`<div class="detail-empty">Agent not found</div>`;

  const def = agentDef || {};

  return html`
    <div class="detail-content">
      <div class="detail-header">
        <span class="agent-icon">${instance ? "◆" : "○"}</span>
        <span class="detail-name">${agentId}</span>
        ${def.kind ? html`<span class="detail-kind-badge">${def.kind}</span>` : null}
        <span class="detail-status ${instance ? "ok" : "cold"}">${instance ? "active" : "defined"}</span>
      </div>

      <${ScopeBar} section="agents" itemId=${agentId} />

      <div class="detail-meta-row">
        ${def.provider ? html`<div class="detail-meta"><label>Provider</label><span>${def.provider}</span></div>` : null}
        ${def.model ? html`<div class="detail-meta"><label>Model</label><span class="mono">${def.model}</span></div>` : null}
        ${def.temperature != null ? html`<div class="detail-meta"><label>Temp</label><span>${def.temperature}</span></div>` : null}
        ${def.maxTokens != null ? html`<div class="detail-meta"><label>Max Tokens</label><span>${def.maxTokens}</span></div>` : null}
        ${def.maxDepth != null ? html`<div class="detail-meta"><label>Max Depth</label><span>${def.maxDepth}</span></div>` : null}
      </div>

      ${def.prompt ? html`
        <${Section} title="Prompt">
          <pre class="detail-json">${def.prompt}</pre>
        </${Section}>
      ` : null}

      ${def.visibleLayers?.length > 0 ? html`
        <${Section} title="Visible Layers" open=${false}>
          <div class="detail-layers">
            ${def.visibleLayers.map(id => html`
              <span key=${id} class="detail-layer-chip" style="border-color: ${layerColor(id)}">
                <span class="detail-layer-dot" style="background: ${layerColor(id)}"></span>
                ${id}
              </span>
            `)}
          </div>
        </${Section}>
      ` : null}

      ${def.peers?.length > 0 ? html`
        <${Section} title="Peers" open=${false}>
          <div class="detail-peers">
            ${def.peers.map(p => html`<span key=${p} class="detail-peer-chip">${p}</span>`)}
          </div>
        </${Section}>
      ` : null}

      ${def.enabled != null ? html`
        <div class="detail-meta-row" style="margin-top: 8px">
          <div class="detail-meta"><label>Status</label><span>${def.enabled ? "enabled" : "disabled"}</span></div>
          ${def.invocation ? html`<div class="detail-meta"><label>Invocation</label><span>${def.invocation}</span></div>` : null}
          ${def.flowRole ? html`<div class="detail-meta"><label>Flow Role</label><span>${def.flowRole}</span></div>` : null}
        </div>
      ` : null}
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Creation forms
// ---------------------------------------------------------------------------

function CreateLayerForm({ onCreated }) {
  const [id, setId] = useState("");
  const [prompt, setPrompt] = useState("");
  const [trust, setTrust] = useState("0.5");
  const [staleness, setStaleness] = useState("0");
  const [maxTokens, setMaxTokens] = useState("4000");
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (!id.trim()) return;
    setSaving(true);
    const ok = await createDefinition("layers", id.trim(), {
      id: id.trim(), prompt, sourceIds: [],
      trust: parseFloat(trust) || 0.5, staleness: parseInt(staleness) || 0,
      maxTokens: parseInt(maxTokens) || 4000, enabled: true,
    });
    setSaving(false);
    if (ok && onCreated) onCreated();
  };

  return html`
    <div class="detail-content">
      <div class="detail-header"><span class="detail-name">New Layer</span></div>
      <div class="create-form">
        <div class="settings-field">
          <label class="settings-label">ID</label>
          <input class="settings-input" placeholder="e.g. security-rules"
            value=${id} onInput=${(e) => setId(e.target.value)} />
        </div>
        <div class="settings-field">
          <label class="settings-label">Prompt</label>
          <textarea class="settings-input" rows="3" placeholder="What this layer provides..."
            value=${prompt} onInput=${(e) => setPrompt(e.target.value)}></textarea>
        </div>
        <div class="settings-row">
          <div class="settings-field"><label class="settings-label">Trust (0-1)</label>
            <input class="settings-input small" type="number" step="0.1" min="0" max="1"
              value=${trust} onInput=${(e) => setTrust(e.target.value)} /></div>
          <div class="settings-field"><label class="settings-label">Staleness (ms)</label>
            <input class="settings-input small" type="number" min="0"
              value=${staleness} onInput=${(e) => setStaleness(e.target.value)} /></div>
          <div class="settings-field"><label class="settings-label">Max Tokens</label>
            <input class="settings-input small" type="number" min="0"
              value=${maxTokens} onInput=${(e) => setMaxTokens(e.target.value)} /></div>
        </div>
        <div class="detail-actions" style="margin-top: 12px">
          <button class="action-btn" disabled=${!id.trim() || saving}
            onClick=${handleSave}>${saving ? "Saving..." : "Create Layer"}</button>
        </div>
      </div>
    </div>
  `;
}

function CreateAgentForm({ onCreated }) {
  const [id, setId] = useState("");
  const [kind, setKind] = useState("executor");
  const [prompt, setPrompt] = useState("");
  const [temperature, setTemperature] = useState("");
  const [maxTokens, setMaxTokens] = useState("");
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (!id.trim()) return;
    setSaving(true);
    const data = {
      id: id.trim(), kind, prompt,
      visibleLayers: [], peers: [], maxDepth: 3, enabled: true,
    };
    if (temperature !== "") data.temperature = parseFloat(temperature);
    if (maxTokens !== "") data.maxTokens = parseInt(maxTokens);
    const ok = await createDefinition("agents", id.trim(), data);
    setSaving(false);
    if (ok && onCreated) onCreated();
  };

  return html`
    <div class="detail-content">
      <div class="detail-header"><span class="detail-name">New Agent</span></div>
      <div class="create-form">
        <div class="settings-field">
          <label class="settings-label">ID</label>
          <input class="settings-input" placeholder="e.g. code-reviewer"
            value=${id} onInput=${(e) => setId(e.target.value)} />
        </div>
        <div class="settings-field">
          <label class="settings-label">Kind</label>
          <select class="settings-input" value=${kind} onChange=${(e) => setKind(e.target.value)}>
            <option value="executor">Executor</option>
            <option value="classifier">Classifier</option>
            <option value="router">Router</option>
            <option value="decider">Decider</option>
          </select>
        </div>
        <div class="settings-field">
          <label class="settings-label">System Prompt</label>
          <textarea class="settings-input" rows="4" placeholder="What this agent does..."
            value=${prompt} onInput=${(e) => setPrompt(e.target.value)}></textarea>
        </div>
        <div class="settings-row">
          <div class="settings-field"><label class="settings-label">Temperature</label>
            <input class="settings-input small" type="number" step="0.1" min="0" max="2"
              value=${temperature} onInput=${(e) => setTemperature(e.target.value)} /></div>
          <div class="settings-field"><label class="settings-label">Max Tokens</label>
            <input class="settings-input small" type="number" min="0"
              value=${maxTokens} onInput=${(e) => setMaxTokens(e.target.value)} /></div>
        </div>
        <div class="detail-actions" style="margin-top: 12px">
          <button class="action-btn" disabled=${!id.trim() || saving}
            onClick=${handleSave}>${saving ? "Saving..." : "Create Agent"}</button>
        </div>
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Detail drawer (main export)
// ---------------------------------------------------------------------------

export function DetailDrawer({ selectedSpan, selectedLayer, selectedAgent, creating, onCreated, onSpanSelect }) {
  const trace = currentTrace.value;
  const spanId = selectedSpanId.value;

  // Find selected span in trace tree
  let span = null;
  if (spanId && trace?.root) {
    span = findSpan(trace.root, spanId);
  }

  // Priority: creation form > selected span > trace > selected agent > selected layer > empty
  let content;
  if (creating === "layer") {
    content = html`<${CreateLayerForm} onCreated=${onCreated} />`;
  } else if (creating === "agent") {
    content = html`<${CreateAgentForm} onCreated=${onCreated} />`;
  } else if (span && trace) {
    content = html`
      <div>
        <button class="back-btn" style="margin: 8px 8px 0"
          onClick=${() => { selectedSpanId.value = null; }}>← Back to trace</button>
        <${SpanDetail} span=${span} traceId=${trace.id} />
      </div>
    `;
  } else if (trace) {
    content = html`<${TraceDetail} trace=${trace} onSpanSelect=${onSpanSelect} />`;
  } else if (selectedAgent) {
    content = html`<${AgentDetail} agentId=${selectedAgent} />`;
  } else if (selectedLayer) {
    content = html`<${LayerDetail} layerId=${selectedLayer} />`;
  } else {
    content = html`
      <div class="detail-empty">
        <p>Select a trace, span, agent, or layer to inspect</p>
        <div class="detail-hint">
          Click <kbd>trace</kbd> on a message to see pipeline details
        </div>
      </div>
    `;
  }

  const isOpen = detailDrawerOpen.value;

  if (!isOpen) {
    return html`
      <div class="detail-drawer detail-drawer--collapsed">
        <button class="panel-collapse-strip"
          onClick=${() => { detailDrawerOpen.value = true; }}
          title="Expand detail panel">
          <span class="panel-collapse-label">DETAIL</span>
        </button>
      </div>
    `;
  }

  return html`
    <div class="detail-drawer">
      <div class="panel-header">
        <span class="panel-title">DETAIL</span>
        <div style="margin-left: auto; display: flex; gap: 4px;">
          ${trace ? html`
            <button class="back-btn"
              onClick=${() => { currentTrace.value = null; selectedSpanId.value = null; }}>
              Clear
            </button>
          ` : null}
          <button class="panel-collapse-btn"
            onClick=${() => { detailDrawerOpen.value = false; }}
            title="Collapse detail panel">\u00bb</button>
        </div>
      </div>
      ${content}
    </div>
  `;
}

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
