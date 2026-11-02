/**
 * @atlas
 * @kind component
 * @partOf feature:viewer
 */
/**
 * Thread settings as rows (setting-row.js), shared by Settings › Threads (Foundry-wide) and the
 * project's Work and Agent pages.
 *
 * What a thread does when its branch merges (`threadOnMerge`): `done` (the default) marks it done,
 * light blue, "Merged into main", until your next message; `auto-archive` archives it and frees its
 * worktree. Foundry-wide (PATCH /api/settings/threads) and per project, over it (PATCH
 * /api/projects/:id); it has no repository layer.
 *
 * What a message sent during a running turn does (`steer`, CORE-001): steer it into the turn (the
 * default) or queue it after. Foundry-wide (PATCH /api/settings/threads); per project, set for you
 * (this machine's settings, which win) or for everyone (the repository's .foundry/project.json),
 * through /api/projects/:id/steer.
 */

import { ComingSoon } from './coming-soon.js';
import { html, useEffect, useState } from './lib.js';
import { SettingRow } from './setting-row.js';
import { authFetch, showToast } from './store.js';
import { harnessName } from './thread-labels.js';

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
const NO_SHARED_LAYER = 'Foundry-wide settings live on this machine; there is no shared layer.';
const NO_REPOSITORY_LAYER =
  'This setting has no repository layer yet: only chorus, conversations and steer are read from .foundry/project.json.';

const patch = (url, body) =>
  authFetch(url, {
    method: url.endsWith('/steer') ? 'PUT' : 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

/** Settings › Threads (Foundry-wide). */
export function ThreadSettings({ config, onSaved }) {
  return html`<section class="settings-card setting-rows">
    <${MergeRow} config=${config} onSaved=${onSaved} />
    <${SteerRow} config=${config} onSaved=${onSaved} />
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

/** Project › Agent: which worker a thread starts on, what it loads from your harness, how it acts. */
export function ProjectAgent({ config, projectId, onSaved }) {
  const own = config.projects?.[projectId]?.defaults?.provider;
  const worker = own ?? config.defaults?.provider;
  const composition = config.composition ?? {};
  return html`<section class="settings-card setting-rows">
    <${SettingRow} path="defaults.provider" label="Default worker" source=${own ? 'yours' : 'foundry'}
      help="Any thread can start on another worker you have a login for. Change the Foundry-wide default in Providers.">
      <span class="setting-value">${harnessName(worker) ?? worker ?? '—'}</span>
    </${SettingRow}>
    <${SteerRow} config=${config} projectId=${projectId} onSaved=${onSaved} />
    <${SettingRow} path="composition.harnessSettings" label="Harness settings"
      source=${composition.harnessSettings ? 'foundry' : 'default'}
      help="Foundry-wide. Project hooks load only inside a registered project; credentials in them never replace the subscription login.">
      <span class="setting-value">${composition.harnessSettings === 'off' ? 'Don’t load' : 'Load mine: settings, commands, skills, hooks'}</span>
    </${SettingRow}>
    <${SettingRow} path="composition.harnessLoading" label="CLAUDE.md and AGENTS.md"
      source=${composition.harnessLoading ? 'foundry' : 'default'}
      help="Foundry-wide. Foundry composes global → org → project → personal.">
      <span class="setting-value">${composition.harnessLoading === 'load' ? 'The harness loads its own too' : composition.harnessLoading === 'suppress' ? 'Composed by Foundry' : 'Composed by Foundry when a layer reads them'}</span>
    </${SettingRow}>
    <${SettingRow} path="accessMode" label="Access mode"
      help="Whatever mode you chose in the host app (Claude, Codex, T3, Paseo), full access included.">
      <span class="setting-value">Follows the host</span>
    </${SettingRow}>
  </section>`;
}

const STEER_SOURCE = (state) =>
  state.from === 'settings'
    ? state.repository !== null && state.repository !== undefined
      ? 'yours-over-team'
      : 'yours'
    : state.from === 'repository'
      ? 'everyone'
      : state.from === 'foundry'
        ? 'foundry'
        : 'default';

export function SteerRow({ config, projectId, onSaved }) {
  const [state, setState] = useState(undefined);
  const [busy, setBusy] = useState(false);
  const base = projectId ? `/api/projects/${encodeURIComponent(projectId)}/steer` : null;
  const load = () =>
    base
      ? authFetch(base)
          .then((r) => (r.ok ? r.json() : null))
          .then(setState)
          .catch(() => setState(null))
      : setState({
          steer: config.steer ?? true,
          from: config.steer === undefined ? 'default' : 'settings',
          mine: config.steer ?? null,
        });
  // biome-ignore lint/correctness/useExhaustiveDependencies: reload when the project or saved settings change.
  useEffect(() => {
    load();
  }, [projectId, config.steer]);
  const save = async (scope, value) => {
    setBusy(true);
    try {
      const res = base
        ? await patch(base, { scope, value })
        : await patch('/api/settings/threads', { steer: value });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) return showToast(body.error || 'Could not save', 'error');
      await onSaved?.();
      await load();
      showToast(
        value === null ? 'Reset' : scope === 'everyone' ? 'Saved for everyone' : 'Saved for you',
        'ok',
      );
    } finally {
      setBusy(false);
    }
  };
  const label = 'When you send during a running turn';
  if (!state)
    return html`<${SettingRow} path="steer" label=${label}>
      <span class="settings-desc">${state === undefined ? 'Reading…' : 'The steer setting could not be read.'}</span>
    </${SettingRow}>`;
  const has = (v) => v !== null && v !== undefined;
  const actions = {
    me: () => save('me', state.steer),
    everyone: base ? () => save('everyone', state.steer) : NO_SHARED_LAYER,
    reset: has(state.mine)
      ? () => save('me', null)
      : base && has(state.repository)
        ? () => save('everyone', null)
        : 'Already the default',
  };
  return html`<${SettingRow} path="steer" label=${label} source=${STEER_SOURCE(state)} actions=${actions} busy=${busy}
    help=${state.repositoryError ? `${state.repositoryFile}: ${state.repositoryError}` : STEER_CHOICES.find(([v]) => v === state.steer)?.[2]}>
    <select class="settings-input small" aria-label=${label} disabled=${busy} value=${String(state.steer)}
      onChange=${(e) => save('me', e.target.value === 'true')}>
      ${STEER_CHOICES.map(([v, l]) => html`<option key=${String(v)} value=${String(v)}>${l}</option>`)}
    </select>
  </${SettingRow}>`;
}

export function MergeRow({ config, projectId, onSaved }) {
  const [busy, setBusy] = useState(false);
  // The choice shows at once; the saved settings take over when they reload.
  const [chosen, setChosen] = useState(undefined);
  const foundry = config.threadOnMerge ?? null;
  const saved = projectId ? (config.projects?.[projectId]?.threadOnMerge ?? null) : foundry;
  const own = chosen === undefined ? saved : chosen;
  const effective = own ?? (projectId ? foundry : null) ?? 'done';
  const source = own ? 'yours' : projectId && foundry ? 'foundry' : 'default';
  const save = async (value) => {
    setChosen(value);
    setBusy(true);
    try {
      const res = await patch(
        projectId ? `/api/projects/${encodeURIComponent(projectId)}` : '/api/settings/threads',
        { threadOnMerge: value },
      );
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setChosen(undefined);
        return showToast(body.error || 'Could not save', 'error');
      }
      await onSaved?.();
      setChosen(undefined);
      showToast(value === null ? 'Reset' : 'Saved for you', 'ok');
    } finally {
      setBusy(false);
    }
  };
  const label = 'When a thread’s branch merges';
  const actions = {
    me: () => save(effective),
    everyone: projectId ? NO_REPOSITORY_LAYER : NO_SHARED_LAYER,
    reset: own ? () => save(null) : 'Already the default',
  };
  return html`<${SettingRow} path="threadOnMerge" label=${label} source=${source} actions=${actions} busy=${busy}
    help=${`${MERGE_CHOICES.find(([v]) => v === effective)?.[2] ?? ''} Never while the thread holds unsaved work.`}>
    <select class="settings-input small" aria-label=${label} disabled=${busy} value=${effective}
      onChange=${(e) => save(e.target.value)}>
      ${MERGE_CHOICES.map(([v, l]) => html`<option key=${v} value=${v}>${l}</option>`)}
    </select>
  </${SettingRow}>`;
}
