/**
 * @atlas
 * @kind component
 * @partOf feature:viewer
 */
/**
 * Thread settings as rows (setting-row.js), shared by Settings › Threads (Foundry-wide) and the
 * project's Work and Agent pages.
 *
 * A project's setting is yours (this machine's settings) over everyone's (the repository's
 * `.foundry/project.json`) over Foundry's over the default (Aron 2026-10-16), read and written at
 * its path through /api/projects/:id/setting. Foundry-wide settings belong to this machine.
 *
 * What a thread does when its branch merges (`threadOnMerge`): `done` (the default) marks it done,
 * light blue, "Merged into main", until your next message; `auto-archive` archives it and frees its
 * worktree. What a message sent during a running turn does (`steer`, CORE-001): steer it into the
 * turn (the default) or queue it after.
 */

import { ComingSoon } from './coming-soon.js';
import { html, useEffect, useState } from './lib.js';
import { SettingRow } from './setting-row.js';
import { authFetch, showToast } from './store.js';

const MERGE_CHOICES = [
  ['done', 'Mark it done', 'Light blue, "Merged into main", until your next message.'],
  ['auto-archive', 'Archive it', 'Archives the thread and frees its worktree.'],
];
const STEER_CHOICES = [
  [true, 'Steers the running turn', 'The running turn takes it in at its next step. ⌘↵ queues.'],
  [
    false,
    'Queues after the turn',
    'It waits for the running turn to finish. "Steer now" sends one in.',
  ],
];
const NO_SHARED_LAYER = 'Foundry-wide settings belong to this machine; there is no shared layer.';
const has = (v) => v !== null && v !== undefined;
/** A Foundry-wide setting shown on a project page: its value and menu live in Foundry settings. */
const FOUNDRY_WIDE = {
  me: 'Foundry-wide: change it in Foundry settings',
  everyone: NO_SHARED_LAYER,
  reset: 'Foundry-wide: change it in Foundry settings',
};

const send = (url, method, body) =>
  authFetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

/**
 * A project setting at `path`: its layers as the daemon reports them (`mine`, `repository`,
 * `foundry`, `from`, `personalOnly`), and `save(scope, values)` for me or for everyone, `values`
 * mapping paths to values (`null` drops one). `reload` reads it again.
 */
export function useProjectSetting(projectId, path, onSaved) {
  const [state, setState] = useState(undefined);
  const [busy, setBusy] = useState(false);
  const base = `/api/projects/${encodeURIComponent(projectId)}/setting`;
  const load = () =>
    authFetch(`${base}?path=${encodeURIComponent(path)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then(setState)
      .catch(() => setState(null));
  // biome-ignore lint/correctness/useExhaustiveDependencies: reload when the project or path changes.
  useEffect(() => {
    load();
  }, [projectId, path]);
  const save = async (scope, values) => {
    setBusy(true);
    try {
      const res = await send(base, 'PUT', { scope, values });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) return showToast(body.error || 'Could not save', 'error');
      await onSaved?.();
      await load();
      const cleared = Object.values(values).every((v) => v === null);
      showToast(
        cleared ? 'Reset' : scope === 'everyone' ? 'Saved for everyone' : 'Saved for you',
        'ok',
      );
    } finally {
      setBusy(false);
    }
  };
  return { state, busy, save, reload: load };
}

/** Where a project setting's value comes from, for its chip. */
export const sourceOf = (state) =>
  state.from === 'settings'
    ? has(state.repository)
      ? 'yours-over-team'
      : 'yours'
    : state.from === 'repository'
      ? 'everyone'
      : state.from === 'foundry'
        ? 'foundry'
        : 'default';

/**
 * The ⋯ menu of a project setting: set the value in effect for me or for everyone; Reset drops
 * yours (back to the team's), else the team's. A machine or person setting has no "for everyone".
 */
export const layeredActions = (state, save, values) => {
  const nulls = Object.fromEntries(Object.keys(values).map((k) => [k, null]));
  return {
    me: () => save('me', values),
    everyone: state.personalOnly ?? (() => save('everyone', values)),
    reset: has(state.mine)
      ? () => save('me', nulls)
      : has(state.repository)
        ? () => save('everyone', nulls)
        : 'Nothing is set here',
  };
};

/** A project setting chosen from a list: yours when you change it, ⋯ for everyone or reset. */
export function ProjectChoiceRow({ projectId, path, label, choices, fallback, help, onSaved }) {
  const { state, busy, save } = useProjectSetting(projectId, path, onSaved);
  if (!state)
    return html`<${SettingRow} path=${path} label=${label}>
      <span class="settings-desc">${state === undefined ? 'Reading…' : 'This setting could not be read.'}</span>
    </${SettingRow}>`;
  const value = state.value ?? fallback;
  return html`<${SettingRow} path=${path} label=${label} source=${sourceOf(state)} busy=${busy}
    actions=${layeredActions(state, save, { [path]: value })}
    help=${state.repositoryError ? `${state.repositoryFile}: ${state.repositoryError}` : help(value)}>
    <select class="settings-input small" aria-label=${label} disabled=${busy} value=${String(value)}
      onChange=${(e) => save('me', { [path]: choices.find(([v]) => String(v) === e.target.value)[0] })}>
      ${choices.map(([v, l]) => html`<option key=${String(v)} value=${String(v)}>${l}</option>`)}
    </select>
  </${SettingRow}>`;
}

/** A Foundry-wide thread setting (PATCH /api/settings/threads): yours or the default. */
function FoundryChoiceRow({ config, settingKey, label, choices, fallback, help, onSaved }) {
  const [busy, setBusy] = useState(false);
  const own = config[settingKey];
  const value = own ?? fallback;
  const save = async (next) => {
    setBusy(true);
    try {
      const res = await send('/api/settings/threads', 'PATCH', { [settingKey]: next });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) return showToast(body.error || 'Could not save', 'error');
      await onSaved?.();
      showToast(next === null ? 'Reset' : 'Saved for you', 'ok');
    } finally {
      setBusy(false);
    }
  };
  const actions = {
    me: () => save(value),
    everyone: NO_SHARED_LAYER,
    reset: has(own) ? () => save(null) : 'Already the default',
  };
  return html`<${SettingRow} path=${settingKey} label=${label} source=${has(own) ? 'yours' : 'default'}
    actions=${actions} busy=${busy} help=${help(value)}>
    <select class="settings-input small" aria-label=${label} disabled=${busy} value=${String(value)}
      onChange=${(e) => save(choices.find(([v]) => String(v) === e.target.value)[0])}>
      ${choices.map(([v, l]) => html`<option key=${String(v)} value=${String(v)}>${l}</option>`)}
    </select>
  </${SettingRow}>`;
}

const MERGE = {
  label: 'When a thread’s branch merges',
  choices: MERGE_CHOICES,
  fallback: 'done',
  help: (v) =>
    `${MERGE_CHOICES.find(([c]) => c === v)?.[2] ?? ''} Never while the thread holds unsaved work.`,
};
const STEER = {
  label: 'When you send during a running turn',
  choices: STEER_CHOICES,
  fallback: true,
  help: (v) => STEER_CHOICES.find(([c]) => c === v)?.[2] ?? '',
};

const AFTER_START_CHOICES = [
  [
    'attention',
    'Back to Attention',
    'The rail returns to Attention once the thread starts; it comes back there when it needs you.',
  ],
  ['stay', 'Stay on Projects', 'The rail stays on the project you started it from.'],
];
const AFTER_START = {
  label: 'After you start a thread from Projects',
  choices: AFTER_START_CHOICES,
  fallback: 'attention',
  help: (v) => AFTER_START_CHOICES.find(([c]) => c === v)?.[2] ?? '',
};

export function MergeRow({ config, projectId, onSaved }) {
  return projectId
    ? html`<${ProjectChoiceRow} projectId=${projectId} path="threadOnMerge" ...${MERGE} onSaved=${onSaved} />`
    : html`<${FoundryChoiceRow} config=${config} settingKey="threadOnMerge" ...${MERGE} onSaved=${onSaved} />`;
}

export function SteerRow({ config, projectId, onSaved }) {
  return projectId
    ? html`<${ProjectChoiceRow} projectId=${projectId} path="steer" ...${STEER} onSaved=${onSaved} />`
    : html`<${FoundryChoiceRow} config=${config} settingKey="steer" ...${STEER} onSaved=${onSaved} />`;
}

/** Settings › Threads (Foundry-wide). */
export function ThreadSettings({ config, onSaved }) {
  return html`<section class="settings-card setting-rows">
    <${MergeRow} config=${config} onSaved=${onSaved} />
    <${SteerRow} config=${config} onSaved=${onSaved} />
    <${FoundryChoiceRow} config=${config} settingKey="afterProjectStart" ...${AFTER_START} onSaved=${onSaved} />
  </section>`;
}

/** Project › Work: how the project's threads use worktrees, and what happens when their branch merges. */
export function ProjectWork({ config, projectId, onSaved }) {
  const [mode, setMode] = useState(undefined);
  useEffect(() => {
    let live = true;
    authFetch(`/api/projects/${encodeURIComponent(projectId)}/about`)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)
      .then((about) => live && setMode(about?.worktreeMode ?? null));
    return () => {
      live = false;
    };
  }, [projectId]);
  return html`<section class="settings-card setting-rows">
    <${SettingRow} path="worktreeMode" label="Worktree mode" source="detected"
      help="Template projects (a worktree:create script) get a slot: ports and a database. Classic runs plain git.">
      <span class="setting-value">${mode === undefined ? 'Reading…' : mode === 'template' ? 'Template: worktree:create / destroy (claims a slot)' : mode === 'classic' ? 'Classic: plain git worktree' : '—'}</span>
    </${SettingRow}>
    <${MergeRow} config=${config} projectId=${projectId} onSaved=${onSaved} />
    <${SettingRow} path="worktreeShareOnSplit" label="Share the worktree on a split"
      help="When work branches into another thread. Threads sharing a worktree are one piece of work.">
      <${ComingSoon} inline=${true} what="Ask each time, a new worktree, or the same one." />
    </${SettingRow}>
  </section>`;
}

/**
 * The project's default worker and its model, chosen together (FEAT-007, the per-thread rule at
 * project level): choosing a worker sets its default model, the model list is that worker's own,
 * and both are stored in the same layer.
 */
function WorkerRow({ projectId, onSaved }) {
  const provider = useProjectSetting(projectId, 'defaults.provider', onSaved);
  const model = useProjectSetting(projectId, 'defaults.model');
  const [workers, setWorkers] = useState(undefined);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the choices follow the saved worker.
  useEffect(() => {
    let live = true;
    authFetch(`/api/projects/${encodeURIComponent(projectId)}/workers`)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)
      .then((body) => live && setWorkers(body?.workers ?? null));
    return () => {
      live = false;
    };
  }, [projectId, provider.state?.value]);
  const p = provider.state;
  const m = model.state;
  if (!p || !m || !workers)
    return html`<${SettingRow} path="defaults.provider" label="Default worker">
      <span class="settings-desc">${p === null || m === null || workers === null ? 'The worker could not be read.' : 'Reading…'}</span>
    </${SettingRow}>`;
  const worker = workers.find((w) => w.id === p.value) ?? workers.find((w) => w.default);
  // The model comes from the layer that names the worker, else that worker's own default.
  const layerModel =
    p.from === 'settings' ? m.mine : p.from === 'repository' ? m.repository : m.foundry;
  const current =
    (layerModel && worker?.models.some((x) => x.id === layerModel) ? layerModel : null) ??
    worker?.defaultModel;
  const busy = provider.busy || model.busy;
  const save = async (scope, values) => {
    await provider.save(scope, values);
    await model.reload();
  };
  const values = { 'defaults.provider': worker?.id ?? null, 'defaults.model': current ?? null };
  return html`<${SettingRow} path="defaults.provider" label="Default worker" source=${sourceOf(p)} busy=${busy}
    actions=${layeredActions(p, save, values)}
    help="Threads start here unless you choose another worker you have a login for. Its model goes with it.">
    <select class="settings-input small" aria-label="Default worker" disabled=${busy} value=${worker?.id}
      onChange=${(e) => {
        const next = workers.find((w) => w.id === e.target.value);
        save('me', { 'defaults.provider': next.id, 'defaults.model': next.defaultModel });
      }}>
      ${workers.map((w) => html`<option key=${w.id} value=${w.id}>${w.label}</option>`)}
    </select>
    <select class="settings-input small" aria-label="Model" disabled=${busy} value=${current}
      onChange=${(e) => save('me', { 'defaults.provider': worker.id, 'defaults.model': e.target.value })}>
      ${(worker?.models ?? []).map((x) => html`<option key=${x.id} value=${x.id}>${x.label ?? x.id}</option>`)}
    </select>
  </${SettingRow}>`;
}

/** Project › Agent: which worker a thread starts on, what it loads from your harness, how it acts. */
export function ProjectAgent({ config, projectId, onSaved }) {
  const composition = config.composition ?? {};
  return html`<section class="settings-card setting-rows">
    <${WorkerRow} projectId=${projectId} onSaved=${onSaved} />
    <${SteerRow} config=${config} projectId=${projectId} onSaved=${onSaved} />
    <${SettingRow} path="composition.harnessSettings" label="Harness settings"
      source=${composition.harnessSettings ? 'foundry' : 'default'} actions=${FOUNDRY_WIDE}
      help="Foundry-wide. Project hooks load only inside a registered project; credentials in them never replace the subscription login.">
      <span class="setting-value">${composition.harnessSettings === 'off' ? 'Don’t load' : 'Load mine: settings, commands, skills, hooks'}</span>
    </${SettingRow}>
    <${SettingRow} path="composition.harnessLoading" label="CLAUDE.md and AGENTS.md"
      source=${composition.harnessLoading ? 'foundry' : 'default'} actions=${FOUNDRY_WIDE}
      help="Foundry-wide. Foundry composes global → org → project → personal.">
      <span class="setting-value">${composition.harnessLoading === 'load' ? 'The harness loads its own too' : composition.harnessLoading === 'suppress' ? 'Composed by Foundry' : 'Composed by Foundry when a layer reads them'}</span>
    </${SettingRow}>
    <${SettingRow} path="accessMode" label="Access mode"
      help="Whatever mode you chose in the host app (Claude, Codex, T3, Paseo), full access included.">
      <span class="setting-value">Follows the host</span>
    </${SettingRow}>
  </section>`;
}
