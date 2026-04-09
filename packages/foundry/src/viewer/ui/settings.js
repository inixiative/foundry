/**
 * Settings — configuration panel.
 *
 * Two scopes with clear visual separation:
 * - Global: providers, default models, viewer prefs
 * - Project: sources (docs, conventions, memory paths)
 *
 * Agents and layers are NOT settings — they're first-class sidebar items.
 */

import { html, useState, useEffect, useRef } from "./lib.js";
import { signal } from "./lib.js";
import { showToast, activeProjectId, projects } from "./store.js";

// Settings state
export const settingsOpen = signal(false);
export const settingsConfig = signal(null);
const settingsScope = signal("global"); // "global" | "project"
const activeTab = signal("defaults");
const aiLoading = signal(false);
const aiSuggestions = signal([]);

// ---------------------------------------------------------------------------
// Data fetching
// ---------------------------------------------------------------------------

export async function loadSettings() {
  try {
    const res = await fetch("/api/settings");
    settingsConfig.value = await res.json();
  } catch {
    showToast("Failed to load settings", "error");
  }
}

async function saveSection(section, data) {
  try {
    const res = await fetch(`/api/settings/${section}`, {
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

async function saveProjectSection(projectId, section, data) {
  try {
    const res = await fetch(`/api/projects/${projectId}/settings/${section}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    if (res.ok) {
      // Reload full settings to get updated project config
      await loadSettings();
      showToast("Project settings saved", "ok");
    } else {
      showToast("Failed to save project settings", "error");
    }
  } catch {
    showToast("Failed to save", "error");
  }
}

async function deleteItem(section, id) {
  try {
    const res = await fetch(`/api/settings/${section}/${id}`, { method: "DELETE" });
    settingsConfig.value = await res.json();
    showToast(`Removed ${id}`, "ok");
  } catch {
    showToast("Failed to delete", "error");
  }
}

async function requestAIAssist(section, target, question) {
  aiLoading.value = true;
  try {
    const res = await fetch("/api/assist", {
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
    const res = await fetch("/api/assist/prompt", {
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
// Shared components
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Scope bar — Global vs Project toggle
// ---------------------------------------------------------------------------

function ScopeBar({ scope, onScopeChange, projectName }) {
  return html`
    <div class="settings-scope-bar">
      <button
        class="settings-scope-tab ${scope === "global" ? "active scope-global" : ""}"
        onClick=${() => onScopeChange("global")}
      >Global</button>
      <button
        class="settings-scope-tab ${scope === "project" ? "active scope-project" : ""}"
        onClick=${() => onScopeChange("project")}
        disabled=${!projectName}
        title=${projectName ? `Project: ${projectName}` : "Select a project first"}
      >${projectName ? `Project: ${projectName}` : "No project selected"}</button>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Global scope: Defaults
// ---------------------------------------------------------------------------

function DefaultsEditor({ defaults, providers, onSave }) {
  const [draft, setDraft] = useState({ ...defaults });
  const update = (k, v) => setDraft({ ...draft, [k]: v });

  const enabledProviders = Object.values(providers).filter(p => p.enabled);

  return html`
    <div class="settings-card">
      <div class="settings-card-header">
        <span class="settings-card-title">Default Models</span>
        <span class="scope-label scope-global">GLOBAL</span>
      </div>

      <div class="settings-section-label">Executor (tool use, code gen)</div>
      <div class="settings-row">
        <div class="settings-field">
          <label class="settings-label">Provider</label>
          <select
            class="settings-input small"
            value=${draft.provider}
            onChange=${(e) => update("provider", e.target.value)}
          >
            ${enabledProviders.map(p => html`
              <option key=${p.id} value=${p.id}>${p.label}</option>
            `)}
          </select>
        </div>
        <div class="settings-field">
          <label class="settings-label">Model</label>
          <select
            class="settings-input small mono"
            value=${draft.model}
            onChange=${(e) => update("model", e.target.value)}
          >
            ${(providers[draft.provider]?.models || []).map(m => html`
              <option key=${m.id} value=${m.id}>${m.label} (${m.tier})</option>
            `)}
          </select>
        </div>
      </div>

      <div class="settings-section-label">Classifier / Router (runs on every message)</div>
      <div class="settings-row">
        <div class="settings-field">
          <label class="settings-label">Provider</label>
          <select
            class="settings-input small"
            value=${draft.classifierProvider || draft.provider}
            onChange=${(e) => update("classifierProvider", e.target.value)}
          >
            ${enabledProviders.map(p => html`
              <option key=${p.id} value=${p.id}>${p.label}</option>
            `)}
          </select>
        </div>
        <div class="settings-field">
          <label class="settings-label">Model</label>
          <select
            class="settings-input small mono"
            value=${draft.classifierModel || draft.model}
            onChange=${(e) => update("classifierModel", e.target.value)}
          >
            ${(providers[draft.classifierProvider || draft.provider]?.models || []).map(m => html`
              <option key=${m.id} value=${m.id}>${m.label} (${m.tier})</option>
            `)}
          </select>
        </div>
      </div>

      <div class="settings-card-actions">
        <button class="action-btn" onClick=${() => onSave(draft)}>Save Defaults</button>
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Global scope: Providers
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
// Project scope: Sources
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
// Global tab bar
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Global scope: Tunnel
// ---------------------------------------------------------------------------

function TunnelEditor() {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(false);
  const [password, setPassword] = useState("");
  const [subdomain, setSubdomain] = useState("");
  const [provider, setProvider] = useState("localtunnel");

  const refresh = async () => {
    try {
      const res = await fetch("/api/tunnel");
      const data = await res.json();
      setStatus(data);
      setProvider(data.provider || "localtunnel");
      setSubdomain(data.subdomain || "");
      if (data.hasPassword) setPassword("••••••••");
    } catch { /* ignore */ }
  };

  useEffect(() => { refresh(); }, []);

  const toggle = async () => {
    setLoading(true);
    try {
      const endpoint = status?.active ? "/api/tunnel/stop" : "/api/tunnel/start";
      const res = await fetch(endpoint, { method: "POST" });
      const data = await res.json();
      if (data.error) {
        showToast(data.error, "error");
      } else {
        showToast(status?.active ? "Tunnel stopped" : `Tunnel started: ${data.url}`, "ok");
      }
      await refresh();
    } catch {
      showToast("Tunnel operation failed", "error");
    }
    setLoading(false);
  };

  const saveConfig = async () => {
    try {
      const body = { provider, subdomain: subdomain || undefined };
      // Only send password if user changed it (not the masked placeholder)
      if (password && password !== "••••••••") body.password = password;
      const res = await fetch("/api/tunnel", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (data.ok) {
        showToast("Tunnel config saved", "ok");
        if (password && password !== "••••••••") setPassword("••••••••");
      } else {
        showToast(data.error || "Save failed", "error");
      }
    } catch {
      showToast("Failed to save tunnel config", "error");
    }
  };

  return html`
    <div class="settings-card">
      <div class="settings-card-header">
        <span class="settings-card-title">Tunnel</span>
        <span class="scope-label scope-global">GLOBAL</span>
      </div>

      <p class="settings-desc">
        Expose the viewer over a public URL. Local/private network requests bypass auth automatically.
      </p>

      <div class="tunnel-status">
        <div class="tunnel-status-row">
          <span class="tunnel-indicator ${status?.active ? "active" : "inactive"}"></span>
          <span>${status?.active ? "Active" : "Inactive"}</span>
          ${status?.active && status?.url ? html`
            <a class="tunnel-url" href=${status.url} target="_blank" rel="noopener">${status.url}</a>
          ` : null}
        </div>
        <button
          class="action-btn ${status?.active ? "danger" : ""}"
          onClick=${toggle}
          disabled=${loading}
        >${loading ? "..." : status?.active ? "Stop Tunnel" : "Start Tunnel"}</button>
      </div>

      <div class="settings-section-label">Configuration</div>

      <div class="settings-field">
        <label class="settings-label">Provider</label>
        <select
          class="settings-input small"
          value=${provider}
          onChange=${(e) => setProvider(e.target.value)}
        >
          <option value="localtunnel">localtunnel (zero-config)</option>
          <option value="cloudflared">cloudflared (production)</option>
        </select>
      </div>

      <${Field}
        label="Subdomain hint"
        value=${subdomain}
        onChange=${setSubdomain}
        placeholder="my-foundry (localtunnel only, not guaranteed)"
        small
      />

      <${Field}
        label="Access password"
        value=${password}
        onChange=${setPassword}
        type="password"
        placeholder="Leave empty for auto-generated token"
        small
      />

      <div class="settings-card-actions">
        <button class="action-btn" onClick=${saveConfig}>Save Config</button>
      </div>
    </div>
  `;
}

function GlobalTabBar() {
  const tabs = [
    { id: "defaults", label: "Defaults" },
    { id: "providers", label: "Providers" },
    { id: "tunnel", label: "Tunnel" },
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

// ---------------------------------------------------------------------------
// Project tab bar
// ---------------------------------------------------------------------------

function ProjectTabBar() {
  const tabs = [
    { id: "sources", label: "Sources" },
    { id: "overrides", label: "Overrides" },
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
// Project overrides — show what the project overrides from global
// ---------------------------------------------------------------------------

function ProjectOverrides({ project }) {
  if (!project) return null;

  const hasDefaults = project.defaults && Object.keys(project.defaults).length > 0;
  const hasAgents = project.agents && Object.keys(project.agents).length > 0;
  const hasLayers = project.layers && Object.keys(project.layers).length > 0;

  if (!hasDefaults && !hasAgents && !hasLayers) {
    return html`
      <div class="settings-empty">
        No overrides — this project inherits all global defaults.
        <p class="wizard-desc dim" style="margin-top: 8px">
          Override defaults per-project by setting custom providers, models, or agent configs here.
        </p>
      </div>
    `;
  }

  return html`
    <div class="settings-card">
      <div class="settings-card-header">
        <span class="settings-card-title">Project Overrides</span>
        <span class="scope-label scope-project">PROJECT</span>
      </div>
      ${hasDefaults ? html`
        <div class="settings-section-label">Default overrides</div>
        <pre class="settings-override-preview">${JSON.stringify(project.defaults, null, 2)}</pre>
      ` : null}
      ${hasAgents ? html`
        <div class="settings-section-label">Agent overrides (${Object.keys(project.agents).length})</div>
        <pre class="settings-override-preview">${JSON.stringify(project.agents, null, 2)}</pre>
      ` : null}
      ${hasLayers ? html`
        <div class="settings-section-label">Layer overrides (${Object.keys(project.layers).length})</div>
        <pre class="settings-override-preview">${JSON.stringify(project.layers, null, 2)}</pre>
      ` : null}
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Main Settings panel
// ---------------------------------------------------------------------------

export function Settings() {
  const isOpen = settingsOpen.value;
  const config = settingsConfig.value;
  const scope = settingsScope.value;

  useEffect(() => {
    if (isOpen && !config) loadSettings();
  }, [isOpen]);

  // When a project is selected in the sidebar, default to project scope
  useEffect(() => {
    if (activeProjectId.value) {
      settingsScope.value = "project";
      activeTab.value = "sources";
    }
  }, [activeProjectId.value]);

  if (!isOpen) return null;
  if (!config) return html`<div class="overlay-backdrop"><div class="settings-panel">Loading...</div></div>`;

  const tab = activeTab.value;
  const projectId = activeProjectId.value;
  const project = projectId ? config.projects?.[projectId] : null;
  const projectName = project?.label || projectId;

  const handleScopeChange = (newScope) => {
    settingsScope.value = newScope;
    activeTab.value = newScope === "global" ? "defaults" : "sources";
  };

  const handleProviderSave = (provider) => saveSection("providers", { [provider.id]: provider });
  const handleDefaultsSave = (defaults) => saveSection("defaults", defaults);
  const handleSourceSave = (source) => {
    if (projectId) {
      saveProjectSection(projectId, "sources", { [source.id]: source });
    } else {
      saveSection("sources", { [source.id]: source });
    }
  };

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

        <${ScopeBar}
          scope=${scope}
          onScopeChange=${handleScopeChange}
          projectName=${projectName}
        />

        <${AISuggestions} />

        ${scope === "global" ? html`
          <${GlobalTabBar} />
          <div class="settings-body">
            ${tab === "defaults" ? html`
              <${DefaultsEditor}
                defaults=${config.defaults}
                providers=${config.providers}
                onSave=${handleDefaultsSave}
              />
            ` : tab === "providers" ? html`
              ${Object.values(config.providers).map(p => html`
                <${ProviderEditor}
                  key=${p.id}
                  provider=${p}
                  onSave=${handleProviderSave}
                />
              `)}
            ` : tab === "tunnel" ? html`
              <${TunnelEditor} />
            ` : null}
          </div>
        ` : html`
          <${ProjectTabBar} />
          <div class="settings-body">
            ${!project ? html`
              <div class="settings-empty">
                Select a project from the sidebar to configure its settings.
              </div>
            ` : tab === "sources" ? html`
              ${Object.values(project.sources || {}).map(s => html`
                <${SourceEditor}
                  key=${s.id}
                  source=${s}
                  onSave=${handleSourceSave}
                  onDelete=${(id) => deleteItem("sources", id)}
                />
              `)}
              ${!project.sources || Object.keys(project.sources).length === 0 ? html`
                <div class="settings-empty">
                  No sources configured for this project.
                  <p class="wizard-desc dim" style="margin-top: 8px">
                    Sources point to docs, conventions, and memory that feed into context layers.
                    Add a project directory first.
                  </p>
                </div>
              ` : null}
            ` : tab === "overrides" ? html`
              <${ProjectOverrides} project=${project} />
            ` : null}
          </div>
        `}
      </div>
    </div>
  `;
}
