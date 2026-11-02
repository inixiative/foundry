/**
 * @atlas
 * @kind component
 * @partOf feature:viewer, primitive:settings
 */
/**
 * Settings pages — Foundry-wide at /settings/:section, per project at
 * /projects/:id/settings/:section (ui/route.js).
 *
 * Layout: scope + section nav | editor | Forge Master pane. The page's
 * scope/section/selected item is relayed to Forge Master so it knows what
 * the operator is looking at.
 */

import { AboutSection } from './about-settings.js';
import { AccessSettings } from './access-settings.js';
import { ArchiveSettings, ProjectArchive } from './archive-settings.js';
import { ProjectConversations } from './conversation-members.js';
import { devMode, setDevMode } from './dev-mode.js';
import { DevicesSection } from './devices.js';
import { FeedbackSettings } from './feedback.js';
import { FilePicker } from './file-picker.js';
import { IntegrationSection } from './integration-settings.js';
import { KingdomSettings } from './kingdom-settings.js';
import { html, signal, useEffect, useState } from './lib.js';
import { MessageBoxSection } from './message-box.js';
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
import { authFetch, modelRegistry, projects, showToast } from './store.js';
import { Switch } from './switch.js';
import { ThreadSettings } from './thread-settings.js';

export const settingsConfig = signal(null);
/** A setting Search jumped to ({ path, description, value, source, section, projectId }): its section shows it highlighted. */
export const settingsHighlight = signal(null);

const SOURCE_TEXT = {
  yours: 'Set by you',
  everyone: 'Set for everyone (the repository’s .foundry/project.json)',
  default: 'Default',
};

/**
 * The element showing a setting: the `[data-setting]` whose path is the setting's or the longest
 * prefix of it at a dot (`agents.worker` for `agents.worker.model`), inside the settings body.
 */
export function settingAnchor(root, path) {
  let best = null;
  for (const el of root.querySelectorAll('[data-setting]')) {
    const own = el.dataset.setting;
    if (
      (own === path || path.startsWith(`${own}.`)) &&
      own.length > (best?.dataset.setting.length ?? -1)
    )
      best = el;
  }
  return best;
}

const ANCHOR_WAIT_MS = 3000;

/** Scroll to and highlight the searched setting's field; 'missed' when the section shows none. */
function useSettingAnchor(setting, active) {
  const [state, setState] = useState('looking');
  useEffect(() => {
    setState('looking');
    if (!setting || !active) return;
    let anchored = null;
    const started = Date.now();
    const timer = setInterval(() => {
      const root = document.querySelector('.settings-body');
      const el = root && settingAnchor(root, setting.path);
      if (el) {
        anchored = el;
        el.classList.add('setting-searched');
        el.scrollIntoView({ block: 'center' });
        setState('found');
        clearInterval(timer);
      } else if (Date.now() - started > ANCHOR_WAIT_MS) {
        setState('missed');
        clearInterval(timer);
      }
    }, 100);
    return () => {
      clearInterval(timer);
      anchored?.classList.remove('setting-searched');
    };
  }, [setting, active]);
  return state;
}

function SearchedSetting({ setting }) {
  return html`<section class="settings-card settings-searched" aria-label=${`Found: ${setting.path}`}>
    <button type="button" class="settings-searched-close" aria-label="Dismiss" onClick=${() => {
      settingsHighlight.value = null;
    }}>✕</button>
    <span class="settings-searched-label">From Search</span>
    <h3><code>${setting.path}</code></h3>
    <p class="settings-desc">${setting.description || 'No description in the config interface.'}</p>
    <dl><dt>Value</dt><dd><code>${setting.value ?? '—'}</code></dd><dt>Comes from</dt><dd>${SOURCE_TEXT[setting.source]}</dd></dl>
  </section>`;
}

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
        <div style="padding: 12px; color: var(--err); font-size: 12px;">${error}</div>
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
    <div class="settings-card" data-setting=${`sources.${draft.id}`} onFocusin=${onAnyFocus}>
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
  const [decision, setDecision] = useState(null);
  useEffect(() => {
    // Stages without a model run on the decision model: name it rather than print "decision".
    fetch('/api/models/selection')
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => setDecision(body?.decision ?? null))
      .catch(() => setDecision(null));
  }, []);
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
    <div class="settings-card" data-setting="chorus">
      <div class="settings-card-header">
        <span class="settings-card-title">Chorus</span>
        <span class="settings-desc">${
          chorus.on
            ? `${chorus.regions.length} region Wardens, ${kb(total)} of knowledge`
            : chorus.available
              ? `Off: ${chorus.available} regions present, not enabled; no Wardens run`
              : 'Off: no Wardens run'
        }</span>
      </div>
      ${
        chorus.reason
          ? html`<p class="settings-desc">${chorus.enabled ? 'The chorus is enabled, but ' : ''}${chorus.reason}.</p>`
          : null
      }
      ${
        chorus.consumed && chorus.reception
          ? html`<p class="settings-desc">Work items (<code>chorus.consumed</code>): ${chorus.consumed.enabled ? 'on' : 'off'}${chorus.consumed.from === 'default' ? ', the default' : `, set in ${chorus.consumed.from === 'settings' ? 'your settings' : 'the repository'}`}. Reception charter (<code>chorus.reception</code>): ${chorus.reception.on ? 'on' : 'off'}${chorus.reception.from === 'default' ? (chorus.on ? ', with the chorus' : ', only with a running chorus') : `, set in ${chorus.reception.from === 'settings' ? 'your settings' : 'the repository'}`}.</p>`
          : null
      }
      <p class="settings-desc">Read-only. A project's chorus is its set of region Wardens, built from layers of regions in order: a later layer's region replaces an earlier one with the same id, whole. Region Wardens are the only Wardens, and run only when enabled: <code>"chorus": { "enabled": true }</code> in the repository's <code>.foundry/project.json</code>, or <code>projects[id].chorus</code> in settings.json, which wins.</p>
      ${
        chorus.missingDocs?.length
          ? html`<p class="settings-desc">Missing docs: ${chorus.missingDocs
              .map(
                (m) =>
                  `region ${m.region} has no ${m.doc} (layer ${m.stages.map((i) => i + 1).join(', ')})`,
              )
              .join('; ')}.</p>`
          : null
      }
      ${chorus.roles ? html`<${ChorusStages} roles=${chorus.roles} decision=${decision} />` : null}
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

const layerName = (from) =>
  from === 'default' ? 'the default' : from === 'settings' ? 'your settings' : 'the repository';

/** How each role classifies (classify): its stages in order, where they came from, and their versions. */
/** A model's display name from the registry: "Claude Haiku 5.5 · Claude Code". */
function modelName(choice) {
  if (!choice) return null;
  const provider = modelRegistry.value?.providers?.find((p) => p.id === choice.provider);
  const model = provider?.models?.find((m) => m.id === choice.model);
  return `${model?.label ?? choice.model} · ${provider?.label ?? choice.provider}`;
}

function ChorusStages({ roles, decision }) {
  const decisionName = modelName(decision) ?? 'the decision model';
  const rows = (role) =>
    role.stages.map(
      (s) => html`<tr key=${s.index}>
        <td>${s.index + 1}</td>
        <td>${s.task}${s.pointer && s.pointer.any === false ? html`<div class="settings-desc">no choose-one</div>` : null}</td>
        <td><code>${s.doc}</code></td>
        <td>${s.outcomes}${s.reason !== 'none' ? html`<div class="settings-desc">why: ${s.reason}</div>` : null}</td>
        <td>${s.model === 'decision' ? html`${decisionName}<div class="settings-desc">decision model</div>` : s.model}
          <div class="settings-desc">${s.effort === 'decision' ? 'decision effort' : `effort ${s.effort}`}</div></td>
        <td>${s.escalate ? s.escalate.join(', ') : '–'}</td>
        <td>${Math.round(s.deadline * 100)}%</td>
        <td><code>${s.charter}</code><div class="settings-desc"><code>${s.protocols.advice}</code> / <code>${s.protocols.guard}</code></div></td>
      </tr>`,
    );
  return html`
    <div class="settings-section-label">Classification (<code>chorus.wardens.stages</code>)</div>
    <p class="settings-desc">Wardens: ${roles.warden.stages.length} stage${roles.warden.stages.length === 1 ? '' : 's'}, from ${layerName(roles.warden.from)}. Heralds: not built${roles.herald.regions ? `; ${roles.herald.regions} Herald region${roles.herald.regions === 1 ? '' : 's'} not run` : ''}.</p>
    <table class="settings-table chorus-table">
      <thead><tr><th>#</th><th>Task</th><th>Doc</th><th>Outcomes</th><th>Model</th><th>Escalates</th><th>Deadline</th><th>Charter / protocols</th></tr></thead>
      <tbody>${rows(roles.warden)}</tbody>
    </table>
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
          projectList.length || projectId
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

/** What this project sets on top of Foundry's settings, read-only (edit `projects[id]` in settings.json). */
const OVERRIDE_GROUPS = [
  ['defaults', 'Defaults', 'Executor and classifier provider and model'],
  ['toolRules', 'Tool rules', 'Capabilities here override the global ones; protected paths add up'],
  ['feedback', 'Feedback', 'Each field overrides the global one'],
  ['prompts', 'Prompts', 'Base identity prompt files'],
  ['agents', 'Agents', 'Standalone, or extending a global agent'],
  ['layers', 'Layers', 'Merged over the global layers'],
];

function overrideEntries(value) {
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).filter(([, v]) => v !== undefined);
}

function overrideValue(key, value) {
  if (key === 'agents' && value && typeof value === 'object')
    return 'extends' in value ? `extends ${value.extends}` : 'standalone';
  if (value === null || typeof value !== 'object') return String(value);
  return JSON.stringify(value);
}

function ProjectOverrides({ project }) {
  const groups = OVERRIDE_GROUPS.map(([key, label, desc]) => ({
    key,
    label,
    desc,
    entries: overrideEntries(project[key]),
  })).filter((g) => g.entries.length);
  return html`<section class="settings-card project-overrides">
    <p class="settings-desc">What this project sets on top of Foundry's settings. Everything not listed is inherited. Read-only here: edit <code>projects[${project.id}]</code> in settings.json.</p>
    ${
      groups.length
        ? groups.map(
            (
              g,
            ) => html`<div key=${g.key} class="override-group" data-override=${g.key} data-setting=${g.key}>
              <h3>${g.label}</h3>
              <p class="settings-desc">${g.desc}</p>
              <dl class="override-list">${g.entries.map(
                ([k, v]) =>
                  html`<div key=${k} data-setting=${`${g.key}.${k}`}><dt><code>${k}</code></dt><dd><code>${overrideValue(g.key, v)}</code></dd></div>`,
              )}</dl>
            </div>`,
          )
        : html`<p class="settings-empty">No overrides: this project inherits everything from Foundry settings.</p>`
    }
  </section>`;
}

function FoundrySection({ section, config }) {
  const projectList = Object.entries(config.projects ?? {}).map(([id, p]) => ({
    id,
    label: p.label || id,
  }));
  if (section === 'profile') return html`<${ProfileSection} onSaved=${saved} />`;
  if (section === 'messagebox')
    return html`<${MessageBoxSection} config=${settingsConfig.value} onSave=${async (patch) => {
      const res = await authFetch('/api/settings/messageBox', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) return showToast(body.error || 'Could not save', 'error');
      saved(body);
      showToast('Saved for you', 'ok');
    }} />`;
  if (section === 'about') return html`<${AboutSection} />`;
  if (section === 'loops')
    return html`<div class="settings-soon"><span class="badge">Coming soon</span><p>Saved loops you reuse: a <b>Repeat until</b> (do, check, stop) or a <b>Learn from this</b> made from a message's ⋯ menu, kept here to run again in any thread.</p></div>`;
  if (section === 'skills')
    return html`<div class="settings-soon"><span class="badge">Coming soon</span><p>Skills your agents can use: the harness's own skills pass through untouched; Foundry's will be listed and managed here.</p></div>`;
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
  if (section === 'threads')
    return html`<${ThreadSettings} config=${config} onSaved=${loadSettings} />`;
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
    return html`<${ComingSoon}>Gloss: margin commentary kept beside the code instead of in it, for this project's agents to read. It arrives with Foundry's code viewer (ticket VIEWER-004).</${ComingSoon}>`;
  if (section === 'chorus')
    return html`<${ProjectChorus} key=${projectId} projectId=${projectId} />`;
  if (section === 'threads')
    return html`<${ThreadSettings} key=${projectId} config=${settingsConfig.value} projectId=${projectId} onSaved=${loadSettings} />`;
  if (section === 'conversations')
    return html`<${ProjectConversations} key=${projectId} projectId=${projectId} />`;
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
  const highlight = settingsHighlight.value;
  const searched =
    highlight &&
    highlight.section === section &&
    (highlight.projectId ?? null) === (projectId ?? null)
      ? highlight
      : null;
  const anchor = useSettingAnchor(searched, !!config);

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
          <span class="settings-breadcrumb">${projectId ? project?.label || projectId : 'Foundry'}</span>
          <h1 class="settings-title">${label}</h1>
          ${focus ? html`<span class="settings-title-focus">${focus.kind}:${focus.id}</span>` : null}
          <button class="action-btn settings-chat-view" onClick=${() => setShowChat(!showChat)}>${showChat ? 'Back to settings' : 'Forge Master'}</button>
        </header>
        <div class="settings-body">
          ${searched && anchor === 'missed' ? html`<${SearchedSetting} setting=${searched} />` : null}
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
