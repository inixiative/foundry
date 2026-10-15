/**
 * Settings pages — Foundry-wide at /settings/:section, per project at
 * /projects/:id/settings/:section (ui/route.js).
 *
 * Layout: scope + section nav | editor | Forge Master pane. The page's
 * scope/section/selected item is relayed to Forge Master so it knows what
 * the operator is looking at.
 */

import { AccessSettings } from './access-settings.js';
import { ArchiveSettings, ProjectArchive } from './archive-settings.js';
import { LocalDevicePanel } from './devices.js';
import { FilePicker } from './file-picker.js';
import { GlossSettings } from './gloss.js';
import { KingdomSettings } from './kingdom-settings.js';
import { html, signal, useEffect, useState } from './lib.js';
import {
  FOUNDRY_SETTINGS,
  navigate,
  onLink,
  PROJECT_SETTINGS,
  route,
  settingsPath,
} from './route.js';
import { SelfChatPane } from './self-chat.js';
import { projects, showToast } from './store.js';

export const settingsConfig = signal(null);
const selectedFocus = signal(null); // { kind: "source"|"agent"|"layer"|"provider", id }

// ---------------------------------------------------------------------------
// Data fetching
// ---------------------------------------------------------------------------

export async function loadSettings() {
  try {
    const res = await fetch('/api/settings');
    settingsConfig.value = await res.json();
  } catch {
    showToast('Failed to load settings', 'error');
  }
}

async function saveSection(section, data) {
  try {
    const res = await fetch(`/api/settings/${section}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    const body = await res.json();
    // A refused save names what is missing (for example, what a main thread on that provider needs).
    if (!res.ok) return showToast(body?.error || 'Failed to save', 'error');
    settingsConfig.value = body;
    showToast('Settings saved', 'ok');
  } catch {
    showToast('Failed to save', 'error');
  }
}

/** Registry view of each provider: whether it can run a main thread and what that needs. */
const modelRegistry = signal(null);
function loadModelRegistry() {
  if (modelRegistry.value) return;
  fetch('/api/models')
    .then((res) => (res.ok ? res.json() : null))
    .then((body) => {
      if (body) modelRegistry.value = body;
    })
    .catch(() => {});
}

async function saveProjectSection(projectId, section, data) {
  try {
    const res = await fetch(`/api/projects/${projectId}/settings/${section}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (res.ok) {
      await loadSettings();
      showToast('Project settings saved', 'ok');
    } else {
      showToast('Failed to save project settings', 'error');
    }
  } catch {
    showToast('Failed to save', 'error');
  }
}

async function deleteProjectItem(projectId, section, id) {
  try {
    const res = await fetch(
      `/api/projects/${encodeURIComponent(projectId)}/settings/${section}/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    );
    if (!res.ok) return showToast((await res.json())?.error || 'Failed to delete', 'error');
    await loadSettings();
    showToast(`Removed ${id}`, 'ok');
  } catch {
    showToast('Failed to delete', 'error');
  }
}

// ---------------------------------------------------------------------------
// Shared Field component
// ---------------------------------------------------------------------------

function Field({
  label,
  value,
  onChange,
  type = 'text',
  placeholder,
  mono,
  small,
  disabled,
  onFocus,
}) {
  return html`
    <div class="settings-field">
      <label class="settings-label">${label}</label>
      ${
        type === 'textarea'
          ? html`
        <textarea
          class="settings-input ${mono ? 'mono' : ''} ${small ? 'small' : ''}"
          value=${value ?? ''}
          onInput=${(e) => onChange(e.target.value)}
          onFocus=${onFocus}
          placeholder=${placeholder}
          rows="4"
          disabled=${disabled}
        ></textarea>
      `
          : html`
        <input
          class="settings-input ${mono ? 'mono' : ''} ${small ? 'small' : ''}"
          type=${type}
          value=${value ?? ''}
          onInput=${(e) => onChange(type === 'number' ? Number(e.target.value) : e.target.value)}
          onFocus=${onFocus}
          placeholder=${placeholder}
          disabled=${disabled}
        />
      `
      }
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

  const path = uri?.startsWith('file://') ? uri.slice('file://'.length) : null;

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
      const res = await fetch('/api/files', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path, content }),
      });
      const data = await res.json();
      if (data.error) {
        showToast(data.error, 'error');
      } else {
        setOriginal(content);
        showToast('Saved', 'ok');
      }
    } catch (err) {
      showToast(`Save failed: ${err.message}`, 'error');
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
      ${
        loading
          ? html`
        <div style="padding: 12px; color: var(--text-dim); font-size: 12px;">Loading...</div>
      `
          : error
            ? html`
        <div style="padding: 12px; color: var(--error); font-size: 12px;">${error}</div>
      `
            : html`
        <textarea
          class="source-content-editor-area"
          value=${content ?? ''}
          onInput=${(e) => setContent(e.target.value)}
          spellcheck="false"
        ></textarea>
        <div class="source-content-editor-actions">
          <button class="action-btn" onClick=${save} disabled=${!dirty || saving}>
            ${saving ? 'Saving...' : 'Save'}
          </button>
          <button class="action-btn" onClick=${revert} disabled=${!dirty}>Revert</button>
        </div>
      `
      }
    </div>
  `;
}

function SourceEditor({ source, onSave, onDelete, onFocusChange }) {
  const [draft, setDraft] = useState({ ...source });
  const [pickerOpen, setPickerOpen] = useState(false);
  const [showEditor, setShowEditor] = useState(false);
  const update = (k, v) => setDraft({ ...draft, [k]: v });

  const pathFromUri = draft.uri?.startsWith('file://') ? draft.uri.slice('file://'.length) : null;
  const isFileSource = !!pathFromUri;

  const handlePick = (abs) => {
    update('uri', `file://${abs}`);
    setPickerOpen(false);
  };

  const onAnyFocus = () => onFocusChange?.({ kind: 'source', id: draft.id });

  return html`
    <div class="settings-card" onFocusin=${onAnyFocus}>
      <div class="settings-card-header">
        <span class="settings-card-title">${draft.id}</span>
        <span class="settings-card-kind">${draft.type}</span>
        <label class="settings-toggle">
          <input type="checkbox" checked=${draft.enabled} onChange=${(e) => update('enabled', e.target.checked)} />
          ${draft.enabled ? 'enabled' : 'disabled'}
        </label>
      </div>

      <${Field} label="Label" value=${draft.label} onChange=${(v) => update('label', v)} />

      <div class="settings-field">
        <label class="settings-label">URI / Path</label>
        <div class="file-picker-inline">
          <input
            class="settings-input mono"
            type="text"
            value=${draft.uri ?? ''}
            onInput=${(e) => update('uri', e.target.value)}
            placeholder="file://path or postgres://..."
          />
          <button type="button" class="file-picker-btn" onClick=${() => setPickerOpen(true)}>
            Browse\u2026
          </button>
        </div>
      </div>

      ${
        isFileSource
          ? html`
        <button class="source-editor-toggle" onClick=${() => setShowEditor(!showEditor)}>
          ${showEditor ? 'Hide content editor' : 'Edit file content'}
        </button>
      `
          : null
      }

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

function DefaultsEditor({ defaults, providers, apiTokens, onSave, onFocusChange }) {
  const [draft, setDraft] = useState({ ...defaults });
  const update = (k, v) => setDraft({ ...draft, [k]: v });
  const enabledProviders = Object.values(providers).filter((p) => p.enabled);
  useEffect(loadModelRegistry, []);
  const registry = modelRegistry.value?.providers;
  const mainThread = (id) => registry?.find((p) => p.id === id)?.mainThread;
  // Main threads run on Anthropic, OpenAI, Google, Meta and xAI models.
  const executorProviders = registry
    ? enabledProviders.filter((p) => mainThread(p.id) || p.id === draft.provider)
    : enabledProviders;
  const executorNeeds = registry
    ? mainThread(draft.provider) === null
      ? `${draft.provider} cannot run a main thread.`
      : !apiTokens && mainThread(draft.provider)?.requirement
    : null;

  return html`
    <div class="settings-card" onFocusin=${() => onFocusChange?.(null)}>
      <div class="settings-card-header">
        <span class="settings-card-title">Default Models</span>
      </div>

      <div class="settings-section-label">Executor (tool use, code gen)</div>
      <div class="settings-row">
        <div class="settings-field">
          <label class="settings-label">Provider</label>
          <select
            class="settings-input small"
            value=${draft.provider}
            onChange=${(e) => update('provider', e.target.value)}
          >
            ${executorProviders.map((p) => html`<option key=${p.id} value=${p.id}>${p.label}</option>`)}
          </select>
        </div>
        <div class="settings-field">
          <label class="settings-label">Model</label>
          <select
            class="settings-input small mono"
            value=${draft.model}
            onChange=${(e) => update('model', e.target.value)}
          >
            ${(providers[draft.provider]?.models || []).map(
              (m) => html`
              <option key=${m.id} value=${m.id}>${m.label} (${m.tier})</option>
            `,
            )}
          </select>
        </div>
      </div>

      ${executorNeeds ? html`<p class="settings-desc main-thread-needs">${executorNeeds}</p>` : null}

      <div class="settings-section-label">Classifier / Router</div>
      ${
        apiTokens
          ? html`      <div class="settings-row">
        <div class="settings-field">
          <label class="settings-label">Provider</label>
          <select
            class="settings-input small"
            value=${draft.classifierProvider || draft.provider}
            onChange=${(e) => update('classifierProvider', e.target.value)}
          >
            ${enabledProviders.map((p) => html`<option key=${p.id} value=${p.id}>${p.label}</option>`)}
          </select>
        </div>
        <div class="settings-field">
          <label class="settings-label">Model</label>
          <select
            class="settings-input small mono"
            value=${draft.classifierModel || draft.model}
            onChange=${(e) => update('classifierModel', e.target.value)}
          >
            ${(providers[draft.classifierProvider || draft.provider]?.models || []).map(
              (m) => html`
              <option key=${m.id} value=${m.id}>${m.label} (${m.tier})</option>
            `,
            )}
          </select>
        </div>
      </div>`
          : html`<p class="settings-desc">Subscription-only: decision roles run on the subscription decision profile (the Claude login with Haiku 5.5 unless <code>subscriptionOnly</code> names another runtime or model). Set <code>apiTokens: true</code> to choose an API provider here.</p>`
      }

      <div class="settings-card-actions">
        <button class="action-btn" onClick=${() => onSave(draft)}>Save Defaults</button>
      </div>
    </div>
  `;
}

const ACCOUNT_SOURCES = {
  login: 'Local login',
  profile: 'Private profile',
  gateway: 'Gateway',
  kingdom: 'Kingdom',
  'api-key': 'API key',
  local: 'Local server',
  none: 'No account',
};

/** Where each enabled provider's account comes from (server-side: profiles, PATH, env presence). */
const providerAccounts = signal(null);
function loadProviderAccounts() {
  fetch('/api/providers/accounts')
    .then((res) => (res.ok ? res.json() : null))
    .then((body) => {
      if (body) providerAccounts.value = body;
    })
    .catch(() => {});
}

function ProviderAccount({ account }) {
  if (!account) return null;
  return html`
    <div class="provider-account ${account.ready ? 'ready' : 'needs-attention'}">
      <span class="provider-account-source">${ACCOUNT_SOURCES[account.source]}</span>
      ${account.detail ? html`<code class="provider-account-detail">${account.detail}</code>` : null}
      ${account.uses.length ? html`<span class="provider-account-uses">${account.uses.join(' · ')}</span>` : null}
      ${account.issue ? html`<p class="settings-desc">${account.issue}</p>` : null}
    </div>
  `;
}

function ProviderEditor({ provider, account, onSave, onFocusChange }) {
  const [draft, setDraft] = useState({ ...provider });
  const update = (k, v) => setDraft({ ...draft, [k]: v });

  return html`
    <div class="settings-card" onFocusin=${() => onFocusChange?.({ kind: 'provider', id: draft.id })}>
      <div class="settings-card-header">
        <span class="settings-card-title">${draft.label}</span>
        <span class="settings-card-kind">${draft.type}</span>
        <label class="settings-toggle">
          <input type="checkbox" checked=${draft.enabled} onChange=${(e) => update('enabled', e.target.checked)} />
          ${draft.enabled ? 'enabled' : 'disabled'}
        </label>
      </div>

      <${ProviderAccount} account=${account} />

      ${
        draft.baseUrl !== undefined
          ? html`
        <${Field} label="Base URL" value=${draft.baseUrl} mono onChange=${(v) => update('baseUrl', v)} placeholder="https://api.example.com" />
      `
          : null
      }

      <div class="settings-section-label">Models</div>
      ${(draft.models || []).map(
        (m) => html`
        <div key=${m.id} class="model-row">
          <span class="model-id mono">${m.id}</span>
          <span class="model-label">${m.label}</span>
          <span class="model-tier tier-${m.tier}">${m.tier}</span>
          ${m.contextWindow ? html`<span class="model-ctx">${Math.round(m.contextWindow / 1000)}k ctx</span>` : null}
        </div>
      `,
      )}

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
  const [subdomain, setSubdomain] = useState('');
  const [provider, setProvider] = useState('localtunnel');

  const refresh = async () => {
    try {
      const res = await fetch('/api/tunnel');
      const data = await res.json();
      setStatus(data);
      setProvider(data.provider || 'localtunnel');
      setSubdomain(data.subdomain || '');
    } catch {
      /* ignore */
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  const toggle = async () => {
    setLoading(true);
    try {
      const endpoint = status?.active ? '/api/tunnel/stop' : '/api/tunnel/start';
      const res = await fetch(endpoint, { method: 'POST' });
      const data = await res.json();
      if (data.error) showToast(data.error, 'error');
      else showToast(status?.active ? 'Tunnel stopped' : `Tunnel started: ${data.url}`, 'ok');
      await refresh();
    } catch {
      showToast('Tunnel operation failed', 'error');
    }
    setLoading(false);
  };

  const saveConfig = async () => {
    try {
      const body = { provider, subdomain: subdomain || undefined };
      const res = await fetch('/api/tunnel', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (data.ok) showToast('Tunnel config saved', 'ok');
      else showToast(data.error || 'Save failed', 'error');
    } catch {
      showToast('Failed to save tunnel config', 'error');
    }
  };

  return html`
    <div class="settings-card">
      <div class="settings-card-header">
        <span class="settings-card-title">Tunnel</span>
      </div>
      <p class="settings-desc">Expose the viewer over a public URL. All tunneled access requires authentication. Stopping a tunnel keeps the viewer locked.</p>
      <div class="tunnel-status">
        <div class="tunnel-status-row">
          <span class="tunnel-indicator ${status?.active ? 'active' : 'inactive'}"></span>
          <span>${status?.active ? 'Active' : 'Inactive'}</span>
          ${
            status?.active && status?.url
              ? html`
            <a class="tunnel-url" href=${status.url} target="_blank" rel="noopener">${status.url}</a>
          `
              : null
          }
        </div>
        <button class="action-btn ${status?.active ? 'danger' : ''}" onClick=${toggle} disabled=${loading}>
          ${loading ? '...' : status?.active ? 'Stop Tunnel' : 'Start Tunnel'}
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
      <p class="settings-desc">The access token is stored in the private tunnel-token file in this viewer’s configuration directory. It is never returned by these settings.</p>

      <div class="settings-card-actions">
        <button class="action-btn" onClick=${saveConfig}>Save Config</button>
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Project chorus (read-only)
// ---------------------------------------------------------------------------

const kb = (bytes) => `${Math.max(1, Math.round(bytes / 1024))} KB`;

/** The project's chorus: what runs, its layers in order, and each region with its size and key. */
function ProjectChorus({ projectId }) {
  const [chorus, setChorus] = useState(undefined);
  useEffect(() => {
    let live = true;
    setChorus(undefined);
    fetch(`/api/projects/${encodeURIComponent(projectId)}/chorus`)
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => live && setChorus(body?.chorus ?? null))
      .catch(() => live && setChorus(null));
    return () => {
      live = false;
    };
  }, [projectId]);
  if (chorus === undefined) return html`<div class="settings-empty">Reading the chorus…</div>`;
  if (chorus === null)
    return html`<div class="settings-empty">The chorus could not be read; check the project's settings.</div>`;
  const total = chorus.regions.reduce((sum, r) => sum + r.bytes, 0);
  return html`
    <div class="settings-card">
      <div class="settings-card-header">
        <span class="settings-card-title">Chorus</span>
        <span class="settings-desc">${
          chorus.source === 'regions'
            ? `${chorus.regions.length} region Wardens, ${kb(total)} of knowledge, classifier charter`
            : chorus.requested === 'roster'
              ? 'The hand-named roster (chorus.source: roster)'
              : 'The hand-named roster'
        }</span>
      </div>
      ${
        chorus.reason
          ? html`<p class="settings-desc">Regions were asked for, but ${chorus.reason}.</p>`
          : null
      }
      <p class="settings-desc">Read-only. A project's chorus is its set of region Wardens, built from layers of regions in order: a later layer's region replaces an earlier one with the same id, whole. Edit the regions themselves, or <code>projects[id].chorus</code> in settings.json.</p>
      ${
        chorus.layers.length
          ? html`
        <div class="settings-section-label">Layers (${chorus.layers.length}, in order)</div>
        <table class="settings-table chorus-table">
          <thead><tr><th>#</th><th>Label</th><th>Regions directory</th><th>Regions</th></tr></thead>
          <tbody>
            ${chorus.layers.map(
              (layer, i) => html`<tr key=${layer.label}>
                <td>${i + 1}</td><td>${layer.label}</td>
                <td class="chorus-path">${layer.regionsDir}</td><td>${layer.regions}</td>
              </tr>`,
            )}
          </tbody>
        </table>
      `
          : null
      }
      ${
        chorus.regions.length
          ? html`
        <div class="settings-section-label">Regions (${chorus.regions.length})</div>
        <table class="settings-table chorus-table">
          <thead><tr><th>Region</th><th>Layer</th><th>Size</th><th>Key</th></tr></thead>
          <tbody>
            ${chorus.regions.map(
              (region) => html`<tr key=${region.id}>
                <td><strong>${region.id}</strong><div class="settings-desc">${region.title}</div></td>
                <td>${region.layer}${
                  region.replaces.length
                    ? html`<div class="settings-desc">replaces ${region.replaces.join(', ')}</div>`
                    : null
                }</td>
                <td>${kb(region.bytes)}${region.tokens ? html`<div class="settings-desc">~${region.tokens.toLocaleString()} tokens</div>` : null}</td>
                <td>${
                  region.key
                    ? html`<code title=${region.key}>${region.key.slice(0, 12)}</code>`
                    : html`<span class="settings-desc" title=${region.keyError}>unreadable</span>`
                }</td>
              </tr>`,
            )}
          </tbody>
        </table>
      `
          : null
      }
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Project overrides preview
// ---------------------------------------------------------------------------

/** Where each chunk of a project Warden's instructions and domain knowledge came from. */
function ComposedAgents({ projectId }) {
  const [agents, setAgents] = useState(null);
  useEffect(() => {
    let live = true;
    fetch(`/api/projects/${encodeURIComponent(projectId)}/resolved/agents`)
      .then((r) => (r.ok ? r.json() : { agents: [] }))
      .then((body) => live && setAgents(body.agents.filter((a) => a.scope !== 'global')))
      .catch(() => live && setAgents([]));
    return () => {
      live = false;
    };
  }, [projectId]);
  if (!agents?.length) return null;
  const chunks = (field) =>
    (field?.chunks ?? []).map(
      (chunk) =>
        html`<li>${chunk.origin === 'global' ? 'Global' : 'Project'} · ${chunk.heading}</li>`,
    );
  return html`
    <div class="settings-section-label">Composition</div>
    ${agents.map(
      (agent) => html`
        <div class="settings-override-preview">
          <strong>${agent.id}</strong>
          ${agent.extends ? ` extends ${agent.extends}` : ' (standalone)'}
          <ul>${chunks(agent.fields.prompt)}${chunks(agent.fields.domainKnowledge)}</ul>
        </div>
      `,
    )}
  `;
}

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
      </div>
      ${
        hasDefaults
          ? html`
        <div class="settings-section-label">Default overrides</div>
        <pre class="settings-override-preview">${JSON.stringify(project.defaults, null, 2)}</pre>
      `
          : null
      }
      ${
        hasAgents
          ? html`
        <div class="settings-section-label">Project agents (${Object.keys(project.agents).length})</div>
        <pre class="settings-override-preview">${JSON.stringify(project.agents, null, 2)}</pre>
        <${ComposedAgents} projectId=${project.id} />
      `
          : null
      }
      ${
        hasLayers
          ? html`
        <div class="settings-section-label">Layer overrides (${Object.keys(project.layers).length})</div>
        <pre class="settings-override-preview">${JSON.stringify(project.layers, null, 2)}</pre>
      `
          : null
      }
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Scope + section navigation
// ---------------------------------------------------------------------------

function SettingsNav({ projectId, section, projectList }) {
  const sections = projectId ? PROJECT_SETTINGS : FOUNDRY_SETTINGS;
  const projectHref = settingsPath(projectId ?? projectList[0]?.id);
  const known = !projectId || projectList.some((p) => p.id === projectId);
  return html`
    <nav class="settings-nav" aria-label="Settings">
      <div class="settings-scope" aria-label="Settings scope">
        <a href=${settingsPath(null)} aria-current=${projectId ? undefined : 'page'}
          class="settings-scope-tab ${projectId ? '' : 'active'}" onClick=${onLink}>Foundry</a>
        ${
          projectList.length
            ? html`<a href=${projectHref} aria-current=${projectId ? 'page' : undefined}
                class="settings-scope-tab ${projectId ? 'active' : ''}" onClick=${onLink}>Project</a>`
            : html`<span class="settings-scope-tab disabled" title="Add a project first">Project</span>`
        }
      </div>
      ${
        projectId
          ? html`<select class="settings-input small settings-project-select" aria-label="Project"
              value=${projectId}
              onChange=${(e) => navigate(settingsPath(e.target.value, section))}>
              ${known ? null : html`<option value=${projectId}>${projectId} (not registered)</option>`}
              ${projectList.map((p) => html`<option key=${p.id} value=${p.id}>${p.label}</option>`)}
            </select>`
          : html`<p class="settings-scope-note">Everything this Foundry runs on, shared by every project.</p>`
      }
      <ul class="settings-sections">
        ${sections.map(
          ([id, label]) => html`<li key=${id}>
            <a href=${settingsPath(projectId, id)} aria-current=${section === id ? 'page' : undefined}
              class="settings-section ${section === id ? 'active' : ''}" onClick=${onLink}>${label}</a>
          </li>`,
        )}
      </ul>
    </nav>
  `;
}

// ---------------------------------------------------------------------------
// Settings page
// ---------------------------------------------------------------------------

function FoundrySection({ section, config, onFocusChange }) {
  if (section === 'models')
    return html`<${DefaultsEditor}
      defaults=${config.defaults}
      providers=${config.providers}
      apiTokens=${config.apiTokens === true}
      onSave=${(defaults) => saveSection('defaults', defaults)}
      onFocusChange=${onFocusChange}
    />`;
  if (section === 'providers') {
    const accounts = providerAccounts.value ?? [];
    const editor = (p) =>
      html`<${ProviderEditor} key=${p.id} provider=${p}
        account=${accounts.find((a) => a.provider === p.id)}
        onSave=${(provider) => saveSection('providers', { [provider.id]: provider }).then(loadProviderAccounts)}
        onFocusChange=${onFocusChange} />`;
    const all = Object.values(config.providers);
    const off = all.filter((p) => !p.enabled);
    return html`
      <p class="settings-desc">The providers this Foundry has turned on, and where each one's account comes from: a local login, a private profile, Kingdom, or an API key.</p>
      ${all.filter((p) => p.enabled).map(editor)}
      ${off.length ? html`<details class="settings-off"><summary>${off.length} providers off</summary>${off.map(editor)}</details>` : null}
    `;
  }
  if (section === 'kingdom') return html`<${KingdomSettings} />`;
  if (section === 'integrations') return html`<${AccessSettings} onSaved=${loadSettings} />`;
  if (section === 'archive') return html`<${ArchiveSettings} />`;
  if (section === 'tunnel') return html`<${TunnelEditor} />`;
  if (section === 'devices')
    return html`<section class="settings-card"><${LocalDevicePanel} projectIds=${JSON.stringify(projects.value.map((p) => p.id))} /></section>`;
  return null;
}

function ProjectSection({ section, projectId, project, onFocusChange }) {
  if (!project)
    return html`<div class="settings-empty">This project is not registered with Foundry.</div>`;
  if (section === 'integrations')
    return html`<${AccessSettings} key=${projectId} projectId=${projectId} onSaved=${loadSettings} />`;
  if (section === 'archive')
    return html`<${ProjectArchive} key=${projectId} projectId=${projectId} />`;
  if (section === 'gloss')
    return html`<${GlossSettings} key=${projectId} projectId=${projectId} onSaved=${loadSettings} />`;
  if (section === 'chorus')
    return html`<${ProjectChorus} key=${projectId} projectId=${projectId} />`;
  if (section === 'overrides') return html`<${ProjectOverrides} project=${project} />`;
  if (section === 'sources') {
    const sources = Object.values(project.sources || {});
    return html`
      ${sources.map(
        (s) => html`<${SourceEditor}
          key=${s.id}
          source=${s}
          onSave=${(source) => saveProjectSection(projectId, 'sources', { [source.id]: source })}
          onDelete=${(id) => deleteProjectItem(projectId, 'sources', id)}
          onFocusChange=${onFocusChange}
        />`,
      )}
      ${sources.length ? null : html`<div class="settings-empty">No sources configured for this project.</div>`}
    `;
  }
  return null;
}

export function SettingsPage() {
  const [showChat, setShowChat] = useState(false);
  const config = settingsConfig.value;
  const { projectId, section } = route.value;
  const focus = selectedFocus.value;

  useEffect(() => {
    if (!config) loadSettings();
  }, []);
  useEffect(() => {
    selectedFocus.value = null;
    if (section === 'providers') loadProviderAccounts();
  }, [projectId, section]);

  if (!config)
    return html`<main class="settings-page"><div class="settings-empty">Loading settings…</div></main>`;

  const project =
    projectId && Object.hasOwn(config.projects ?? {}, projectId)
      ? config.projects[projectId]
      : null;
  const projectList = Object.entries(config.projects ?? {}).map(([id, p]) => ({
    id,
    label: p.label || id,
  }));
  const label = [...FOUNDRY_SETTINGS, ...PROJECT_SETTINGS].find(([id]) => id === section)?.[1];
  const onFocusChange = (next) => {
    selectedFocus.value = next;
  };
  const chatFocus = {
    scope: projectId ? 'project' : 'global',
    projectId: projectId ?? undefined,
    tab: section,
    focusKind: focus?.kind ?? null,
    focusId: focus?.id ?? null,
  };

  return html`
    <main class=${`settings-page ${showChat ? 'settings-show-chat' : ''}`}>
      <${SettingsNav} projectId=${projectId} section=${section} projectList=${projectList} />
      <div class="settings-main">
        <header class="settings-page-header">
          <span class="settings-breadcrumb">${project ? project.label || projectId : 'Foundry'}</span>
          <h1 class="settings-title">${label}</h1>
          ${focus ? html`<span class="settings-title-focus">${focus.kind}:${focus.id}</span>` : null}
          <button class="action-btn settings-chat-view" onClick=${() => setShowChat(!showChat)}>${showChat ? 'Back to settings' : 'Forge Master'}</button>
        </header>
        <div class="settings-body">
          ${
            projectId
              ? html`<${ProjectSection} section=${section} projectId=${projectId} project=${project} onFocusChange=${onFocusChange} />`
              : html`<${FoundrySection} section=${section} config=${config} onFocusChange=${onFocusChange} />`
          }
        </div>
      </div>
      <${SelfChatPane} focus=${chatFocus} />
    </main>
  `;
}
