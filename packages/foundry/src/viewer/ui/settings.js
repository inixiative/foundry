/**
 * Settings — fullscreen configuration panel.
 *
 * Layout: left nav rail | main editor | right AI chat pane.
 * Nav rail groups: Global (defaults / providers / tunnel) + Project (sources / overrides).
 * Current focus (scope/tab/selected item) is relayed to the chat so it knows
 * what the operator is looking at.
 */

import { html, useState, useEffect, useRef } from "./lib.js";
import { signal } from "./lib.js";
import { showToast, activeProjectId } from "./store.js";
import { FilePicker } from "./file-picker.js";
import { SelfChatPane } from "./self-chat.js";

// Settings state
export const settingsOpen = signal(false);
export const settingsConfig = signal(null);
const settingsScope = signal("global");
const activeTab = signal("defaults");
const selectedFocus = signal(null); // { kind: "source"|"agent"|"layer"|"provider", id }

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

// ---------------------------------------------------------------------------
// Shared Field component
// ---------------------------------------------------------------------------

function Field({ label, value, onChange, type = "text", placeholder, mono, small, disabled, onFocus }) {
  return html`
    <div class="settings-field">
      <label class="settings-label">${label}</label>
      ${type === "textarea" ? html`
        <textarea
          class="settings-input ${mono ? "mono" : ""} ${small ? "small" : ""}"
          value=${value ?? ""}
          onInput=${(e) => onChange(e.target.value)}
          onFocus=${onFocus}
          placeholder=${placeholder}
          rows="4"
          disabled=${disabled}
        ></textarea>
      ` : html`
        <input
          class="settings-input ${mono ? "mono" : ""} ${small ? "small" : ""}"
          type=${type}
          value=${value ?? ""}
          onInput=${(e) => onChange(type === "number" ? Number(e.target.value) : e.target.value)}
          onFocus=${onFocus}
          placeholder=${placeholder}
          disabled=${disabled}
        />
      `}
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Source editor — with file picker + content editor
// ---------------------------------------------------------------------------

function SourceContentEditor({ uri }) {
  const [content, setContent] = useState(null);
  const [original, setOriginal] = useState(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const path = uri?.startsWith("file://") ? uri.slice("file://".length) : null;

  useEffect(() => {
    if (!path) return;
    setLoading(true);
    setError(null);
    fetch(`/api/files?path=${encodeURIComponent(path)}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.error) {
          setError(data.error);
          setContent(null);
        } else {
          setContent(data.content);
          setOriginal(data.content);
        }
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [path]);

  if (!path) {
    return html`
      <div class="source-content-editor">
        <div class="source-content-editor-header">
          Content editing is only available for file:// sources.
        </div>
      </div>
    `;
  }

  const dirty = content !== original;

  const save = async () => {
    setSaving(true);
    try {
      const res = await fetch("/api/files", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, content }),
      });
      const data = await res.json();
      if (data.error) {
        showToast(data.error, "error");
      } else {
        setOriginal(content);
        showToast("Saved", "ok");
      }
    } catch (err) {
      showToast(`Save failed: ${err.message}`, "error");
    }
    setSaving(false);
  };

  const revert = () => setContent(original);

  return html`
    <div class="source-content-editor">
      <div class="source-content-editor-header">
        <span class="mono">${path}</span>
        ${dirty ? html`<span class="dirty">\u2022 unsaved</span>` : null}
      </div>
      ${loading ? html`
        <div style="padding: 12px; color: var(--text-dim); font-size: 12px;">Loading...</div>
      ` : error ? html`
        <div style="padding: 12px; color: var(--error); font-size: 12px;">${error}</div>
      ` : html`
        <textarea
          class="source-content-editor-area"
          value=${content ?? ""}
          onInput=${(e) => setContent(e.target.value)}
          spellcheck="false"
        ></textarea>
        <div class="source-content-editor-actions">
          <button class="action-btn" onClick=${save} disabled=${!dirty || saving}>
            ${saving ? "Saving..." : "Save"}
          </button>
          <button class="action-btn" onClick=${revert} disabled=${!dirty}>Revert</button>
        </div>
      `}
    </div>
  `;
}

function SourceEditor({ source, onSave, onDelete, onFocusChange }) {
  const [draft, setDraft] = useState({ ...source });
  const [pickerOpen, setPickerOpen] = useState(false);
  const [showEditor, setShowEditor] = useState(false);
  const update = (k, v) => setDraft({ ...draft, [k]: v });

  const pathFromUri = draft.uri?.startsWith("file://") ? draft.uri.slice("file://".length) : null;
  const isFileSource = !!pathFromUri;

  const handlePick = (abs) => {
    update("uri", `file://${abs}`);
    setPickerOpen(false);
  };

  const onAnyFocus = () => onFocusChange?.({ kind: "source", id: draft.id });

  return html`
    <div class="settings-card" onFocusin=${onAnyFocus}>
      <div class="settings-card-header">
        <span class="settings-card-title">${draft.id}</span>
        <span class="settings-card-kind">${draft.type}</span>
        <label class="settings-toggle">
          <input type="checkbox" checked=${draft.enabled} onChange=${(e) => update("enabled", e.target.checked)} />
          ${draft.enabled ? "enabled" : "disabled"}
        </label>
      </div>

      <${Field} label="Label" value=${draft.label} onChange=${(v) => update("label", v)} />

      <div class="settings-field">
        <label class="settings-label">URI / Path</label>
        <div class="file-picker-inline">
          <input
            class="settings-input mono"
            type="text"
            value=${draft.uri ?? ""}
            onInput=${(e) => update("uri", e.target.value)}
            placeholder="file://path or postgres://..."
          />
          <button type="button" class="file-picker-btn" onClick=${() => setPickerOpen(true)}>
            Browse\u2026
          </button>
        </div>
      </div>

      ${isFileSource ? html`
        <button class="source-editor-toggle" onClick=${() => setShowEditor(!showEditor)}>
          ${showEditor ? "Hide content editor" : "Edit file content"}
        </button>
      ` : null}

      ${isFileSource && showEditor ? html`<${SourceContentEditor} uri=${draft.uri} />` : null}

      <div class="settings-card-actions">
        <button class="action-btn" onClick=${() => onSave(draft)}>Save</button>
        <button class="action-btn danger" onClick=${() => onDelete(draft.id)}>Remove</button>
      </div>

      <${FilePicker}
        open=${pickerOpen}
        startPath=${pathFromUri}
        mode="file"
        onCancel=${() => setPickerOpen(false)}
        onPick=${handlePick}
      />
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Defaults + Providers editors (unchanged shape, minor tidy)
// ---------------------------------------------------------------------------

function DefaultsEditor({ defaults, providers, onSave, onFocusChange }) {
  const [draft, setDraft] = useState({ ...defaults });
  const update = (k, v) => setDraft({ ...draft, [k]: v });
  const enabledProviders = Object.values(providers).filter(p => p.enabled);

  return html`
    <div class="settings-card" onFocusin=${() => onFocusChange?.(null)}>
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
            ${enabledProviders.map(p => html`<option key=${p.id} value=${p.id}>${p.label}</option>`)}
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

      <div class="settings-section-label">Classifier / Router</div>
      <div class="settings-row">
        <div class="settings-field">
          <label class="settings-label">Provider</label>
          <select
            class="settings-input small"
            value=${draft.classifierProvider || draft.provider}
            onChange=${(e) => update("classifierProvider", e.target.value)}
          >
            ${enabledProviders.map(p => html`<option key=${p.id} value=${p.id}>${p.label}</option>`)}
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

function ProviderEditor({ provider, onSave, onFocusChange }) {
  const [draft, setDraft] = useState({ ...provider });
  const update = (k, v) => setDraft({ ...draft, [k]: v });

  return html`
    <div class="settings-card" onFocusin=${() => onFocusChange?.({ kind: "provider", id: draft.id })}>
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
      ${(draft.models || []).map((m) => html`
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
// Tunnel editor (kept from prior version; wraps in focus handler)
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
      if (data.hasPassword) setPassword("\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022");
    } catch { /* ignore */ }
  };

  useEffect(() => { refresh(); }, []);

  const toggle = async () => {
    setLoading(true);
    try {
      const endpoint = status?.active ? "/api/tunnel/stop" : "/api/tunnel/start";
      const res = await fetch(endpoint, { method: "POST" });
      const data = await res.json();
      if (data.error) showToast(data.error, "error");
      else showToast(status?.active ? "Tunnel stopped" : `Tunnel started: ${data.url}`, "ok");
      await refresh();
    } catch {
      showToast("Tunnel operation failed", "error");
    }
    setLoading(false);
  };

  const saveConfig = async () => {
    try {
      const body = { provider, subdomain: subdomain || undefined };
      if (password && password !== "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022") body.password = password;
      const res = await fetch("/api/tunnel", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (data.ok) showToast("Tunnel config saved", "ok");
      else showToast(data.error || "Save failed", "error");
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
      <p class="settings-desc">Expose the viewer over a public URL. Local/private network requests bypass auth automatically.</p>
      <div class="tunnel-status">
        <div class="tunnel-status-row">
          <span class="tunnel-indicator ${status?.active ? "active" : "inactive"}"></span>
          <span>${status?.active ? "Active" : "Inactive"}</span>
          ${status?.active && status?.url ? html`
            <a class="tunnel-url" href=${status.url} target="_blank" rel="noopener">${status.url}</a>
          ` : null}
        </div>
        <button class="action-btn ${status?.active ? "danger" : ""}" onClick=${toggle} disabled=${loading}>
          ${loading ? "..." : status?.active ? "Stop Tunnel" : "Start Tunnel"}
        </button>
      </div>

      <div class="settings-section-label">Configuration</div>
      <div class="settings-field">
        <label class="settings-label">Provider</label>
        <select class="settings-input small" value=${provider} onChange=${(e) => setProvider(e.target.value)}>
          <option value="localtunnel">localtunnel (zero-config)</option>
          <option value="cloudflared">cloudflared (production)</option>
        </select>
      </div>
      <${Field} label="Subdomain hint" value=${subdomain} onChange=${setSubdomain}
        placeholder="my-foundry (localtunnel only, not guaranteed)" small />
      <${Field} label="Access password" value=${password} onChange=${setPassword} type="password"
        placeholder="Leave empty for auto-generated token" small />

      <div class="settings-card-actions">
        <button class="action-btn" onClick=${saveConfig}>Save Config</button>
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Project overrides preview
// ---------------------------------------------------------------------------

function ProjectOverrides({ project }) {
  if (!project) return null;
  const hasDefaults = project.defaults && Object.keys(project.defaults).length > 0;
  const hasAgents = project.agents && Object.keys(project.agents).length > 0;
  const hasLayers = project.layers && Object.keys(project.layers).length > 0;

  if (!hasDefaults && !hasAgents && !hasLayers) {
    return html`
      <div class="settings-empty">
        No overrides \u2014 this project inherits all global defaults.
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
// Navigation rail — groups global + project tabs
// ---------------------------------------------------------------------------

function NavRail({ scope, tab, projectName, onScopeChange, onTabChange }) {
  const globalTabs = [
    { id: "defaults", label: "Defaults" },
    { id: "providers", label: "Providers" },
    { id: "tunnel", label: "Tunnel" },
  ];
  const projectTabs = [
    { id: "sources", label: "Sources" },
    { id: "overrides", label: "Overrides" },
  ];

  const selectTab = (newScope, newTab) => {
    onScopeChange(newScope);
    onTabChange(newTab);
  };

  return html`
    <nav class="settings-nav">
      <div class="settings-nav-section">Global</div>
      ${globalTabs.map((t) => html`
        <button
          key=${t.id}
          class="settings-nav-item ${scope === "global" && tab === t.id ? "active scope-global" : ""}"
          onClick=${() => selectTab("global", t.id)}
        >${t.label}</button>
      `)}
      <div class="settings-nav-section">
        ${projectName ? `Project: ${projectName}` : "Project"}
      </div>
      ${projectTabs.map((t) => html`
        <button
          key=${t.id}
          class="settings-nav-item ${scope === "project" && tab === t.id ? "active scope-project" : ""}"
          disabled=${!projectName}
          onClick=${() => selectTab("project", t.id)}
        >${t.label}</button>
      `)}
    </nav>
  `;
}

// ---------------------------------------------------------------------------
// Main Settings — fullscreen layout with chat pane
// ---------------------------------------------------------------------------

export function Settings() {
  const isOpen = settingsOpen.value;
  const config = settingsConfig.value;
  const scope = settingsScope.value;
  const tab = activeTab.value;
  const focus = selectedFocus.value;

  useEffect(() => {
    if (isOpen && !config) loadSettings();
  }, [isOpen]);

  useEffect(() => {
    if (activeProjectId.value && scope === "global" && tab === "defaults") {
      settingsScope.value = "project";
      activeTab.value = "sources";
    }
  }, [activeProjectId.value]);

  if (!isOpen) return null;
  if (!config) return html`
    <div class="fullscreen-backdrop">
      <div class="fullscreen-modal settings-panel"><div style="padding: 20px">Loading...</div></div>
    </div>
  `;

  const projectId = activeProjectId.value;
  const project = projectId ? config.projects?.[projectId] : null;
  const projectName = project?.label || projectId;

  const close = () => { settingsOpen.value = false; };

  const onScopeChange = (newScope) => { settingsScope.value = newScope; };
  const onTabChange = (newTab) => {
    activeTab.value = newTab;
    selectedFocus.value = null;
  };
  const onFocusChange = (next) => { selectedFocus.value = next; };

  const handleProviderSave = (provider) => saveSection("providers", { [provider.id]: provider });
  const handleDefaultsSave = (defaults) => saveSection("defaults", defaults);
  const handleSourceSave = (source) => {
    if (projectId) saveProjectSection(projectId, "sources", { [source.id]: source });
    else saveSection("sources", { [source.id]: source });
  };

  // Build focus packet for chat
  const chatFocus = {
    scope,
    projectId: projectId ?? undefined,
    tab,
    focusKind: focus?.kind ?? null,
    focusId: focus?.id ?? null,
  };

  // Settings main body content
  const body = scope === "global" ? (
    tab === "defaults" ? html`
      <${DefaultsEditor}
        defaults=${config.defaults}
        providers=${config.providers}
        onSave=${handleDefaultsSave}
        onFocusChange=${onFocusChange}
      />
    ` : tab === "providers" ? html`
      ${Object.values(config.providers).map(p => html`
        <${ProviderEditor} key=${p.id} provider=${p} onSave=${handleProviderSave} onFocusChange=${onFocusChange} />
      `)}
    ` : tab === "tunnel" ? html`<${TunnelEditor} />` : null
  ) : (
    !project ? html`
      <div class="settings-empty">Select a project from the sidebar to configure its settings.</div>
    ` : tab === "sources" ? html`
      ${Object.values(project.sources || {}).map(s => html`
        <${SourceEditor}
          key=${s.id}
          source=${s}
          onSave=${handleSourceSave}
          onDelete=${(id) => deleteItem("sources", id)}
          onFocusChange=${onFocusChange}
        />
      `)}
      ${!project.sources || Object.keys(project.sources).length === 0 ? html`
        <div class="settings-empty">
          No sources configured for this project.
        </div>
      ` : null}
    ` : tab === "overrides" ? html`
      <${ProjectOverrides} project=${project} />
    ` : null
  );

  return html`
    <div class="fullscreen-backdrop" onClick=${(e) => {
      if (e.target.classList.contains("fullscreen-backdrop")) close();
    }}>
      <div class="fullscreen-modal settings-panel">
        <div class="settings-header">
          <span class="settings-title">
            Settings
            ${focus ? html`<span class="settings-title-focus">\u00B7 ${focus.kind}:${focus.id}</span>` : null}
          </span>
          <button class="fullscreen-close" onClick=${close} aria-label="Close">\u00d7</button>
        </div>
        <div class="settings-layout">
          <${NavRail}
            scope=${scope}
            tab=${tab}
            projectName=${projectName}
            onScopeChange=${onScopeChange}
            onTabChange=${onTabChange}
          />
          <div class="settings-main">
            <div class="settings-body">${body}</div>
          </div>
          <${SelfChatPane} focus=${chatFocus} />
        </div>
      </div>
    </div>
  `;
}
