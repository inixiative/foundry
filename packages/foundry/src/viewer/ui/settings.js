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
import { devMode, setDevMode } from './dev-mode.js';
import { DevicesSection } from './devices.js';
import { FeedbackSettings } from './feedback.js';
import { FilePicker } from './file-picker.js';
import { IntegrationSection } from './integration-settings.js';
import { KingdomSettings } from './kingdom-settings.js';
import { html, signal, useEffect, useState } from './lib.js';
import { ProfileSection } from './profile-settings.js';
import { ProvidersSection } from './provider-settings.js';
import {
  FOUNDRY_SETTINGS,
  navigate,
  onLink,
  PROJECT_SETTINGS,
  route,
  settingsPath,
} from './route.js';
import { ActivitySection, AgentsSection, LayersSection } from './runtime-panels.js';
import { SelfChatPane } from './self-chat.js';
import { projects, showToast } from './store.js';
import { Switch } from './switch.js';

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
        ${sections.map(([id, label, group, soon], i) => {
          const heading = group && group !== sections[i - 1]?.[2];
          return html`
            ${heading ? html`<li key=${`group-${group}`} class="settings-group" role="presentation">${group}</li>` : null}
            <li key=${id} class=${group ? 'settings-grouped' : ''}>
              <a href=${settingsPath(projectId, id)} aria-current=${section === id ? 'page' : undefined}
                class="settings-section ${section === id ? 'active' : ''}" onClick=${onLink}>${label}${
                  soon ? html` <span class="coming-soon">soon</span>` : null
                }</a>
            </li>`;
        })}
      </ul>
      <label class="dev-mode-switch settings-dev-mode">
        <${Switch} checked=${devMode.value} label="Dev mode" onChange=${setDevMode} />
        <span>Dev mode<span class="settings-desc">Shows dev-only fields, such as a custom Kingdom URL.</span></span>
      </label>
    </nav>
  `;
}

// ---------------------------------------------------------------------------
// Settings page
// ---------------------------------------------------------------------------

const saved = (next) => {
  settingsConfig.value = next;
};

/** A section that exists but is not built yet: it says so, and shows no controls. */
function ComingSoon({ children }) {
  return html`<section class="settings-card coming-soon-card">
    <span class="coming-soon">Coming soon</span>
    <p class="settings-desc">${children}</p>
  </section>`;
}

function FoundrySection({ section, config }) {
  const projectList = Object.entries(config.projects ?? {}).map(([id, p]) => ({
    id,
    label: p.label || id,
  }));
  if (section === 'profile') return html`<${ProfileSection} onSaved=${saved} />`;
  if (section === 'providers')
    return html`<${ProvidersSection} vendors=${config.vendors} onSaved=${saved} />`;
  if (section === 'kingdom')
    return html`<${KingdomSettings} /><${AccessSettings} onSaved=${loadSettings} />`;
  if (section === 'archive') return html`<${ArchiveSettings} projects=${projectList} />`;
  if (section === 'github')
    return html`<${IntegrationSection} key="github" id="github" name="GitHub" />`;
  if (section === 'linear')
    return html`<${IntegrationSection} key="linear" id="linear" name="Linear" />`;
  if (section === 'devices')
    return html`<${DevicesSection} projectIds=${JSON.stringify(projects.value.map((p) => p.id))}
      kingdomPaired=${!!config.kingdomIntegrations?.length} />`;
  if (section === 'layers') return html`<${LayersSection} />`;
  if (section === 'agents') return html`<${AgentsSection} />`;
  if (section === 'activity') return html`<${ActivitySection} />`;
  if (section === 'feedback')
    return html`<${FeedbackSettings} feedback=${config.feedback} onSaved=${saved} />`;
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
    return html`<${ComingSoon}>Gloss: margin commentary kept beside the code instead of in it, for this project's agents to read. Its controls arrive with the Gloss rollout.</${ComingSoon}>`;
  if (section === 'chorus')
    return html`<${ProjectChorus} key=${projectId} projectId=${projectId} />`;
  if (section === 'overrides')
    return html`<${ComingSoon}>Overrides: this project's own defaults, agents and layers on top of Foundry's. Until then a project inherits everything from Foundry settings (edit <code>projects[id]</code> in settings.json to override by hand).</${ComingSoon}>`;
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
