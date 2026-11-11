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

import { html } from './lib.js';
import { SettingRow } from './setting-row.js';
import {
  layeredActions,
  ProjectChoiceRow,
  sourceOf,
  useProjectSetting,
} from './thread-settings.js';

/** Settings › Project › Chorus: whether region Wardens run, set for me or for everyone. */
export function ChorusSwitch({ projectId, onSaved }) {
  return html`<section class="settings-card setting-rows">
    <${ProjectChoiceRow} projectId=${projectId} path="chorus.enabled" label="Wardens"
      choices=${[[true, 'On'], [false, 'Off']]}
      fallback=${false} onSaved=${onSaved}
      help=${(on) => (on ? 'On every turn, Wardens remind the agent what already exists in this project and where it is written down.' : 'Off: threads in this project run without Wardens.')} />
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
  const value = state.mine ?? state.repository;
  // An object's personal keys (your login, your pool) never go to everyone and survive a reset.
  const personal = new Set(state.personalKeys ?? []);
  const values = personal.size
    ? Object.fromEntries(
        Object.entries(value)
          .filter(([k]) => !personal.has(k))
          .map(([k, v]) => [`${key}.${k}`, v]),
      )
    : { [key]: value };
  const actions = layeredActions(state, save, values);
  if (personal.size && !Object.keys(values).length)
    actions.everyone = 'Only your own keys are set here';
  return html`<${SettingRow} path=${key} label=${label} help=${help} busy=${busy}
    source=${sourceOf(state)} actions=${actions}>
    <code class="setting-value">${summary(value)}</code>
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
 * Settings › Project › Sources: this machine's sources for the project, each with its editor. They are
 * yours alone: a source reads files and Archive projects on this machine, so the repository can't
 * carry one, and ⋯ says why.
 */
export function ProjectSources({ projectId, sources, editor }) {
  // Why sources are yours alone, as the daemon says it.
  const why = useProjectSetting(projectId, 'sources').state?.personalOnly ?? 'Yours alone';
  const list = Object.values(sources ?? {});
  if (!list.length)
    return html`<div class="settings-empty">No sources configured for this project.</div>`;
  return list.map(
    (source) => html`<div key=${source.id} class="source-layer">
      <${SettingRow} path=${`sources.${source.id}`} label=${source.label ?? source.id}
        help=${`${source.type ?? ''} · ${source.uri ?? ''}`} source="yours"
        actions=${{ me: 'Edit it below', everyone: why, reset: 'Remove it below' }} />
      ${editor(source.id, source)}
    </div>`,
  );
}
