/**
 * @atlas
 * @kind component
 * @partOf feature:viewer
 */
/**
 * A project's settings as rows with their layer (Aron 2026-10-16: every setting is set for me or for
 * everyone): the chorus switch, every group the project sets (Overrides), and each source, whether
 * it comes from this machine's settings or the repository's `.foundry/project.json`.
 */

import { html, useEffect, useState } from './lib.js';
import { SettingRow } from './setting-row.js';
import { authFetch } from './store.js';
import {
  layeredActions,
  ProjectChoiceRow,
  sourceOf,
  useProjectSetting,
} from './thread-settings.js';

/** Settings › Project › Chorus: whether region Wardens run, set for me or for everyone. */
export function ChorusSwitch({ projectId, onSaved }) {
  return html`<section class="settings-card setting-rows">
    <${ProjectChoiceRow} projectId=${projectId} path="chorus.enabled" label="Chorus"
      choices=${[[true, 'On'], [false, 'Off']]}
      fallback=${false} onSaved=${onSaved}
      help=${(on) => (on ? 'Region Wardens point at what exists on every turn.' : 'Off: threads in this project run without Wardens.')} />
  </section>`;
}

const GROUPS = [
  ['defaults', 'Defaults', 'The worker, its model and the classifier'],
  ['feedback', 'Feedback', 'How corrections are captured and routed'],
  ['agents', 'Agents', 'Standalone, or extending a global agent'],
  ['layers', 'Layers', 'Merged over the global layers'],
  ['sources', 'Sources', 'Where context comes from'],
  ['gloss', 'Gloss', 'Margin commentary kept beside the code'],
  ['toolRules', 'Tool rules', 'What agents may run here; capabilities override the global ones'],
];

const summary = (value) => {
  if (value === null || value === undefined) return '—';
  if (typeof value !== 'object') return String(value);
  const keys = Object.keys(value);
  return keys.length ? keys.join(', ') : '{}';
};

function GroupRow({ projectId, group: [key, label, help], onSaved }) {
  const { state, busy, save } = useProjectSetting(projectId, key, onSaved);
  if (!state || (state.mine === null && state.repository === null)) return null;
  return html`<${SettingRow} path=${key} label=${label} help=${help} busy=${busy}
    source=${sourceOf(state)} actions=${layeredActions(state, save, { [key]: state.mine ?? state.repository })}>
    <code class="setting-value">${summary(state.mine ?? state.repository)}</code>
  </${SettingRow}>`;
}

/**
 * Settings › Project › Overrides: each group this project sets, from this machine or the repository,
 * with where it comes from and ⋯ to set it for me or for everyone. Everything not listed follows
 * Foundry's settings.
 */
export function ProjectOverrides({ projectId, onSaved }) {
  return html`<section class="settings-card setting-rows project-overrides">
    <p class="settings-desc">What this project sets on top of Foundry's settings, yours or the team's. Everything not listed is inherited.</p>
    ${GROUPS.map((g) => html`<${GroupRow} key=${g[0]} projectId=${projectId} group=${g} onSaved=${onSaved} />`)}
  </section>`;
}

/**
 * Settings › Project › Sources: every source the project has, yours and the team's, each with where
 * it comes from and ⋯; `editor(id, source)` renders its editor (edits are saved as yours).
 */
export function ProjectSources({ projectId, editor, onSaved }) {
  const [layers, setLayers] = useState(undefined);
  const load = () =>
    authFetch(`/api/projects/${encodeURIComponent(projectId)}/setting?path=sources`)
      .then((r) => (r.ok ? r.json() : null))
      .then(setLayers)
      .catch(() => setLayers(null));
  // biome-ignore lint/correctness/useExhaustiveDependencies: reload per project.
  useEffect(() => {
    load();
  }, [projectId]);
  if (layers === undefined) return html`<div class="settings-empty">Reading sources…</div>`;
  if (layers === null)
    return html`<div class="settings-empty">The sources could not be read.</div>`;
  const ids = [
    ...new Set([...Object.keys(layers.repository ?? {}), ...Object.keys(layers.mine ?? {})]),
  ];
  if (!ids.length)
    return html`<div class="settings-empty">No sources configured for this project.</div>`;
  return ids.map(
    (id) => html`<${SourceRow} key=${id} projectId=${projectId} id=${id} editor=${editor}
      onSaved=${async () => {
        await onSaved?.();
        await load();
      }} />`,
  );
}

function SourceRow({ projectId, id, editor, onSaved }) {
  const path = `sources.${id}`;
  const { state, busy, save } = useProjectSetting(projectId, path, onSaved);
  if (!state) return null;
  const source = state.mine ?? state.repository;
  return html`<div class="source-layer">
    <${SettingRow} path=${path} label=${source?.label ?? id} help=${`${source?.type ?? ''} · ${source?.uri ?? ''}`}
      busy=${busy} source=${sourceOf(state)} actions=${layeredActions(state, save, { [path]: source })} />
    ${editor(id, source)}
  </div>`;
}
