/**
 * Settings — configuration panel for models, agents, layers, sources, prompts.
 * Accessible via gear icon or hotkey 's'. Has AI assist for suggestions.
 */

import { html, useState, useEffect, useRef } from "./lib.js";
import { signal } from "./lib.js";
import { showToast, authFetch } from "./store.js";

// Settings state
export const settingsOpen = signal(false);
export const settingsConfig = signal(null);
const activeTab = signal("agents");
const aiLoading = signal(false);
const aiSuggestions = signal([]);

// ---------------------------------------------------------------------------
// Data fetching
// ---------------------------------------------------------------------------

async function loadSettings() {
  try {
    const res = await authFetch("/api/settings");
    settingsConfig.value = await res.json();
  } catch {
    showToast("Failed to load settings", "error");
  }
}

async function saveSection(section, data) {
  try {
    const res = await authFetch(`/api/settings/${section}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    settingsConfig.value = await res.json();
    showToast("Settings saved", "ok");
  } catch {
    showToast("Failed to save", "error");
  }
}

async function deleteItem(section, id) {
  try {
    const res = await authFetch(`/api/settings/${section}/${id}`, { method: "DELETE" });
    settingsConfig.value = await res.json();
    showToast(`Removed ${id}`, "ok");
  } catch {
    showToast("Failed to delete", "error");
  }
}

async function requestAIAssist(section, target, question) {
  aiLoading.value = true;
  try {
    const res = await authFetch("/api/assist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ section, target, question }),
    });
    const data = await res.json();
    if (data.error) {
      showToast(data.error, "error");
    } else {
      aiSuggestions.value = data.suggestions || [];
      if (data.explanation) showToast(data.explanation, "ok");
    }
  } catch {
    showToast("AI assist failed", "error");
  }
  aiLoading.value = false;
}

async function requestPromptImprove(type, id, currentPrompt, instruction) {
  aiLoading.value = true;
  try {
    const res = await authFetch("/api/assist/prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type, id, currentPrompt, instruction }),
    });
    const data = await res.json();
    aiLoading.value = false;
    if (data.error) {
      showToast(data.error, "error");
      return null;
    }
    return data;
  } catch {
    aiLoading.value = false;
    showToast("Prompt assist failed", "error");
    return null;
  }
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function TabBar() {
  const tabs = [
    { id: "agents", label: "Agents" },
    { id: "layers", label: "Layers" },
    { id: "providers", label: "Providers" },
    { id: "sources", label: "Sources" },
    { id: "defaults", label: "Defaults" },
  ];
  return html`
    <div class="settings-tabs">
      ${tabs.map(t => html`
        <button
          key=${t.id}
          class="settings-tab ${activeTab.value === t.id ? "active" : ""}"
          onClick=${() => { activeTab.value = t.id; }}
        >${t.label}</button>
      `)}
    </div>
  `;
}

function Field({ label, value, onChange, type = "text", placeholder, mono, small, disabled }) {
  return html`
    <div class="settings-field">
      <label class="settings-label">${label}</label>
      ${type === "textarea" ? html`
        <textarea
          class="settings-input ${mono ? "mono" : ""} ${small ? "small" : ""}"
          value=${value ?? ""}
          onInput=${(e) => onChange(e.target.value)}
          placeholder=${placeholder}
          rows="4"
          disabled=${disabled}
        ></textarea>
      ` : type === "select" ? html`
        <select
          class="settings-input ${small ? "small" : ""}"
          value=${value ?? ""}
          onChange=${(e) => onChange(e.target.value)}
          disabled=${disabled}
        >
          ${placeholder}
        </select>
      ` : html`
        <input
          class="settings-input ${mono ? "mono" : ""} ${small ? "small" : ""}"
          type=${type}
          value=${value ?? ""}
          onInput=${(e) => onChange(type === "number" ? Number(e.target.value) : e.target.value)}
          placeholder=${placeholder}
          disabled=${disabled}
        />
      `}
    </div>
  `;
}

function PromptEditor({ type, id, value, onChange }) {
  const [improving, setImproving] = useState(false);
  const [instruction, setInstruction] = useState("");

  const handleImprove = async () => {
    setImproving(true);
    const result = await requestPromptImprove(type, id, value, instruction || undefined);
    if (result) {
      onChange(result.improved);
      showToast(result.explanation, "ok");
    }
    setImproving(false);
    setInstruction("");
  };

  return html`
    <div class="prompt-editor">
      <div class="settings-field">
        <label class="settings-label">
          Prompt
          <button
            class="ai-assist-btn inline"
            onClick=${handleImprove}
            disabled=${improving}
            title="AI: improve this prompt"
          >${improving ? "thinking..." : "AI improve"}</button>
        </label>
        <textarea
          class="settings-input mono"
          value=${value ?? ""}
          onInput=${(e) => onChange(e.target.value)}
          rows="6"
          placeholder="System prompt for this ${type}..."
        ></textarea>
      </div>
      <div class="prompt-assist-row">
        <input
          class="settings-input small"
          placeholder="Optional: tell AI what to change..."
          value=${instruction}
          onInput=${(e) => setInstruction(e.target.value)}
          onKeyDown=${(e) => { if (e.key === "Enter") handleImprove(); }}
        />
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Agent editor
// ---------------------------------------------------------------------------

function AgentEditor({ agent, providers, onSave, onDelete }) {
  const [draft, setDraft] = useState({ ...agent });
  const update = (k, v) => setDraft({ ...draft, [k]: v });

  // Build model options from providers
  const providerConfig = providers[draft.provider];
  const models = providerConfig?.models || [];

  return html`
    <div class="settings-card">
      <div class="settings-card-header">
        <span class="settings-card-title">${draft.id}</span>
        <span class="settings-card-kind">${draft.kind}</span>
        <label class="settings-toggle">
          <input type="checkbox" checked=${draft.enabled} onChange=${(e) => update("enabled", e.target.checked)} />
          ${draft.enabled ? "active" : "disabled"}
        </label>
      </div>

      <${PromptEditor}
        type="agent"
        id=${draft.id}
        value=${draft.prompt}
        onChange=${(v) => update("prompt", v)}
      />

      <div class="settings-row">
        <${Field} label="Provider" value=${draft.provider} small onChange=${(v) => update("provider", v)} />
        <${Field} label="Model" value=${draft.model} small mono onChange=${(v) => update("model", v)} />
      </div>

      <div class="settings-row">
        <${Field} label="Temperature" type="number" value=${draft.temperature} small onChange=${(v) => update("temperature", v)} />
        <${Field} label="Max Tokens" type="number" value=${draft.maxTokens} small onChange=${(v) => update("maxTokens", v)} />
        <${Field} label="Max Depth" type="number" value=${draft.maxDepth} small onChange=${(v) => update("maxDepth", v)} />
      </div>

      <${Field}
        label="Visible Layers (comma-separated)"
        value=${(draft.visibleLayers || []).join(", ")}
        onChange=${(v) => update("visibleLayers", v.split(",").map(s => s.trim()).filter(Boolean))}
        placeholder="all layers"
      />

      <${Field}
        label="Peers (comma-separated)"
        value=${(draft.peers || []).join(", ")}
        onChange=${(v) => update("peers", v.split(",").map(s => s.trim()).filter(Boolean))}
        placeholder="agent IDs for delegation"
      />

      <div class="settings-card-actions">
        <button class="action-btn" onClick=${() => onSave(draft)}>Save</button>
        <button class="action-btn danger" onClick=${() => onDelete(draft.id)}>Remove</button>
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Layer editor
// ---------------------------------------------------------------------------

function LayerEditor({ layer, onSave, onDelete }) {
  const [draft, setDraft] = useState({ ...layer });
  const update = (k, v) => setDraft({ ...draft, [k]: v });

  return html`
    <div class="settings-card">
      <div class="settings-card-header">
        <span class="settings-card-title">${draft.id}</span>
        <label class="settings-toggle">
          <input type="checkbox" checked=${draft.enabled} onChange=${(e) => update("enabled", e.target.checked)} />
          ${draft.enabled ? "active" : "disabled"}
        </label>
      </div>

      <${PromptEditor}
        type="layer"
        id=${draft.id}
        value=${draft.prompt}
        onChange=${(v) => update("prompt", v)}
      />

      <div class="settings-row">
        <${Field} label="Trust (0-1)" type="number" value=${draft.trust} small onChange=${(v) => update("trust", v)} />
        <${Field} label="Staleness (ms)" type="number" value=${draft.staleness} small onChange=${(v) => update("staleness", v)} />
        <${Field} label="Max Tokens" type="number" value=${draft.maxTokens} small onChange=${(v) => update("maxTokens", v)} />
      </div>

      <${Field}
        label="Source IDs (comma-separated)"
        value=${(draft.sourceIds || []).join(", ")}
        onChange=${(v) => update("sourceIds", v.split(",").map(s => s.trim()).filter(Boolean))}
        placeholder="data source IDs"
      />

      <div class="settings-card-actions">
        <button class="action-btn" onClick=${() => onSave(draft)}>Save</button>
        <button class="action-btn danger" onClick=${() => onDelete(draft.id)}>Remove</button>
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Provider editor
// ---------------------------------------------------------------------------

function ProviderEditor({ provider, onSave }) {
  const [draft, setDraft] = useState({ ...provider });
  const update = (k, v) => setDraft({ ...draft, [k]: v });

  return html`
    <div class="settings-card">
      <div class="settings-card-header">
        <span class="settings-card-title">${draft.label}</span>
        <span class="settings-card-kind">${draft.type}</span>
        <label class="settings-toggle">
          <input type="checkbox" checked=${draft.enabled} onChange=${(e) => update("enabled", e.target.checked)} />
          ${draft.enabled ? "enabled" : "disabled"}
        </label>
      </div>

      ${draft.baseUrl !== undefined ? html`
        <${Field} label="Base URL" value=${draft.baseUrl} mono onChange=${(v) => update("baseUrl", v)} placeholder="https://api.example.com" />
      ` : null}

      <div class="settings-section-label">Models</div>
      ${(draft.models || []).map((m, i) => html`
        <div key=${m.id} class="model-row">
          <span class="model-id mono">${m.id}</span>
          <span class="model-label">${m.label}</span>
          <span class="model-tier tier-${m.tier}">${m.tier}</span>
          ${m.contextWindow ? html`<span class="model-ctx">${Math.round(m.contextWindow / 1000)}k ctx</span>` : null}
        </div>
      `)}

      <div class="settings-card-actions">
        <button class="action-btn" onClick=${() => onSave(draft)}>Save</button>
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Source editor
// ---------------------------------------------------------------------------

function SourceEditor({ source, onSave, onDelete }) {
  const [draft, setDraft] = useState({ ...source });
  const update = (k, v) => setDraft({ ...draft, [k]: v });

  return html`
    <div class="settings-card">
      <div class="settings-card-header">
        <span class="settings-card-title">${draft.id}</span>
        <span class="settings-card-kind">${draft.type}</span>
        <label class="settings-toggle">
          <input type="checkbox" checked=${draft.enabled} onChange=${(e) => update("enabled", e.target.checked)} />
          ${draft.enabled ? "enabled" : "disabled"}
        </label>
      </div>

      <${Field} label="Label" value=${draft.label} onChange=${(v) => update("label", v)} />
      <${Field} label="URI / Path" value=${draft.uri} mono onChange=${(v) => update("uri", v)} placeholder="file://path or postgres://..." />

      <div class="settings-card-actions">
        <button class="action-btn" onClick=${() => onSave(draft)}>Save</button>
        <button class="action-btn danger" onClick=${() => onDelete(draft.id)}>Remove</button>
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Defaults editor
// ---------------------------------------------------------------------------

function DefaultsEditor({ defaults, providers, onSave }) {
  const [draft, setDraft] = useState({ ...defaults });
  const update = (k, v) => setDraft({ ...draft, [k]: v });

  return html`
    <div class="settings-card">
      <div class="settings-card-header">
        <span class="settings-card-title">Global Defaults</span>
      </div>

      <div class="settings-row">
        <${Field} label="Default Provider" value=${draft.provider} small onChange=${(v) => update("provider", v)} />
        <${Field} label="Default Model" value=${draft.model} small mono onChange=${(v) => update("model", v)} />
      </div>

      <div class="settings-row">
        <${Field} label="Temperature" type="number" value=${draft.temperature} small onChange=${(v) => update("temperature", v)} />
        <${Field} label="Max Tokens" type="number" value=${draft.maxTokens} small onChange=${(v) => update("maxTokens", v)} />
      </div>

      <div class="settings-card-actions">
        <button class="action-btn" onClick=${() => onSave(draft)}>Save Defaults</button>
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// AI Suggestions panel
// ---------------------------------------------------------------------------

function AISuggestions() {
  const suggestions = aiSuggestions.value;
  if (suggestions.length === 0) return null;

  return html`
    <div class="ai-suggestions">
      <div class="ai-suggestions-header">
        AI Suggestions
        <button class="ai-dismiss" onClick=${() => { aiSuggestions.value = []; }}>dismiss</button>
      </div>
      ${suggestions.map(s => html`
        <div key=${s.id} class="ai-suggestion ${s.kind}">
          <div class="ai-suggestion-header">
            <span class="ai-suggestion-kind">${s.kind}</span>
            <span class="ai-suggestion-title">${s.title}</span>
            <span class="ai-suggestion-confidence">${Math.round(s.confidence * 100)}%</span>
          </div>
          <div class="ai-suggestion-desc">${s.description}</div>
          ${s.patch ? html`
            <button class="action-btn small" onClick=${() => applyPatch(s)}>Apply</button>
          ` : null}
        </div>
      `)}
    </div>
  `;
}

async function applyPatch(suggestion) {
  await saveSection(suggestion.section, suggestion.patch);
  aiSuggestions.value = aiSuggestions.value.filter(s => s.id !== suggestion.id);
  showToast(`Applied: ${suggestion.title}`, "ok");
}

// ---------------------------------------------------------------------------
// Main Settings panel
// ---------------------------------------------------------------------------

export function Settings() {
  const isOpen = settingsOpen.value;
  const config = settingsConfig.value;

  useEffect(() => {
    if (isOpen && !config) loadSettings();
  }, [isOpen]);

  if (!isOpen) return null;
  if (!config) return html`<div class="overlay-backdrop"><div class="settings-panel">Loading...</div></div>`;

  const tab = activeTab.value;

  const handleAgentSave = (agent) => saveSection("agents", { [agent.id]: agent });
  const handleLayerSave = (layer) => saveSection("layers", { [layer.id]: layer });
  const handleProviderSave = (provider) => saveSection("providers", { [provider.id]: provider });
  const handleSourceSave = (source) => saveSection("sources", { [source.id]: source });
  const handleDefaultsSave = (defaults) => saveSection("defaults", defaults);

  return html`
    <div class="overlay-backdrop" onClick=${() => { settingsOpen.value = false; }}>
      <div class="settings-panel" onClick=${(e) => e.stopPropagation()}>
        <div class="settings-header">
          <span class="settings-title">Settings</span>
          <button
            class="ai-assist-btn"
            onClick=${() => requestAIAssist(tab === "defaults" ? "all" : tab)}
            disabled=${aiLoading.value}
          >${aiLoading.value ? "analyzing..." : "AI Analyze"}</button>
          <button class="settings-close" onClick=${() => { settingsOpen.value = false; }}>Esc</button>
        </div>

        <${TabBar} />
        <${AISuggestions} />

        <div class="settings-body">
          ${tab === "agents" ? html`
            ${Object.values(config.agents).map(a => html`
              <${AgentEditor}
                key=${a.id}
                agent=${a}
                providers=${config.providers}
                onSave=${handleAgentSave}
                onDelete=${(id) => deleteItem("agents", id)}
              />
            `)}
            ${Object.keys(config.agents).length === 0 ? html`
              <div class="settings-empty">No agents configured. Agents registered in code will appear here.</div>
            ` : null}
          ` : tab === "layers" ? html`
            ${Object.values(config.layers).map(l => html`
              <${LayerEditor}
                key=${l.id}
                layer=${l}
                onSave=${handleLayerSave}
                onDelete=${(id) => deleteItem("layers", id)}
              />
            `)}
            ${Object.keys(config.layers).length === 0 ? html`
              <div class="settings-empty">No layers configured. Layers from the context stack will appear here.</div>
            ` : null}
          ` : tab === "providers" ? html`
            ${Object.values(config.providers).map(p => html`
              <${ProviderEditor}
                key=${p.id}
                provider=${p}
                onSave=${handleProviderSave}
              />
            `)}
          ` : tab === "sources" ? html`
            ${Object.values(config.sources).map(s => html`
              <${SourceEditor}
                key=${s.id}
                source=${s}
                onSave=${handleSourceSave}
                onDelete=${(id) => deleteItem("sources", id)}
              />
            `)}
            ${Object.keys(config.sources).length === 0 ? html`
              <div class="settings-empty">No data sources configured.</div>
            ` : null}
          ` : tab === "defaults" ? html`
            <${DefaultsEditor}
              defaults=${config.defaults}
              providers=${config.providers}
              onSave=${handleDefaultsSave}
            />
          ` : null}
        </div>
      </div>
    </div>
  `;
}
