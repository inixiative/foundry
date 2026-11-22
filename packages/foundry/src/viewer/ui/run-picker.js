/**
 * @atlas
 * @kind component
 * @partOf feature:viewer
 */
/**
 * What a thread runs on and as: its worker (Claude Code, Codex, Muse: those with a working login),
 * the model (that worker's), the effort (that model's levels) and its thread role (coder, assistant,
 * or the user's own; empty follows the worker's default). One picker, two places: the thread
 * header's run pill (a change applies from the next turn) and "+ New thread" (chosen before the
 * first message, starting from the scope's defaults). The choices come from the daemon (the launch
 * view's `options.workers`, or `/api/workers` for a new thread); nothing here keeps its own list.
 */

import { html, signal, useEffect, useState } from './lib.js';
import { Modal } from './modal.js';
import {
  activeThreadId,
  authFetch,
  composerFill,
  createThread,
  currentScope,
  isScope,
  launchLabels,
  loadLaunch,
  projects,
  showToast,
  threadLaunch,
} from './store.js';
import { harnessName } from './thread-labels.js';

/** "Claude Code", "Codex", "Muse"; the registry label without its "(…subscription)" for anything else. */
export const workerName = (worker) =>
  harnessName(worker?.id ?? worker) ?? worker?.label?.replace(/\s*\(.*\)\s*$/, '') ?? null;

/** A thread role's label from the scope's choices. */
export const roleLabel = (roles, id) =>
  id ? (roles?.find((r) => r.id === id)?.label ?? id) : null;

/**
 * What a thread runs on, from its launch view: worker · model · effort · role (Aron 11-02: the
 * worker goes first when space is tight). An effort the thread didn't choose is its default; only
 * names the registry knows show, never a raw id. Read by the header band and the agents modal.
 */
export function runParts(launch) {
  const named = launchLabels(launch?.provider, launch?.model);
  const effectiveSpeed = launch?.speed ?? launch?.speedDefault ?? null;
  return {
    worker: workerName(launch?.worker ?? launch?.provider) ?? named.provider,
    model: named.model,
    effort: launch?.effort ?? launch?.effortDefault ?? null,
    speed: effectiveSpeed === 'fast' ? 'fast' : null,
    role: roleLabel(launch?.options?.roles, launch?.effectiveRole),
  };
}

/** "Claude Code · Opus 5.5 · high · Coder", or null when nothing about the run is known yet. */
export function runLabel(launch) {
  if (!launch) return null;
  const { worker, model, effort, speed, role } = runParts(launch);
  return [worker, model, effort, speed, role].filter(Boolean).join(' · ') || null;
}

/** The model entry of a worker choice. */
const modelOf = (worker, modelId) => worker?.models?.find((m) => m.id === modelId) ?? null;

export const SPEED_LABELS = { standard: 'Standard', fast: 'Fast' };

/**
 * The choices, controlled. `value` is `{ worker, model, effort, speed, role }`; an empty effort or
 * speed is the model's own default, an empty role the worker's default role (each named, so never blank).
 * `lock` is why the worker can't change now; `musePersonal` replaces the Muse note with what a
 * mid-thread switch means for the Archive.
 */
export function RunPicker({
  value,
  workers,
  roles = [],
  unavailable = [],
  lock = null,
  musePersonal = null,
  onChange,
  onNewThread,
}) {
  const worker = workers.find((w) => w.id === value.worker) ?? workers[0];
  const model = modelOf(worker, value.model) ?? modelOf(worker, worker?.defaultModel);
  const efforts = model?.efforts ?? [];
  const speeds = model?.speeds ?? [];
  const pickWorker = (id) => {
    const next = workers.find((w) => w.id === id);
    // A worker and its model are chosen together: the new worker starts on its own default model.
    // A role that was the old worker's default follows the worker to its own default.
    const role =
      value.role && value.role === worker?.defaultRole
        ? (next?.defaultRole ?? '')
        : (value.role ?? '');
    onChange({ worker: id, model: next?.defaultModel ?? '', effort: '', speed: '', role });
  };
  const pickModel = (id) => {
    const next = modelOf(worker, id);
    onChange({
      ...value,
      model: id,
      effort: next?.efforts?.includes(value.effort) ? value.effort : '',
      speed: next?.speeds?.includes(value.speed) ? value.speed : '',
    });
  };
  return html`<div class="run-picker">
    <label class="run-picker-row">Worker
      <select class="rp-select" data-run="worker" value=${worker?.id ?? ''} disabled=${!!lock}
        onChange=${(e) => pickWorker(e.target.value)}>
        ${workers.map((w) => html`<option key=${w.id} value=${w.id}>${workerName(w)}${w.default ? ' (default)' : ''}</option>`)}
      </select>
    </label>
    <label class="run-picker-row">Model
      <select class="rp-select" data-run="model" value=${model?.id ?? ''}
        onChange=${(e) => pickModel(e.target.value)}>
        ${(worker?.models ?? []).map((m) => html`<option key=${m.id} value=${m.id}>${m.label ?? m.id}${m.id === worker.defaultModel ? ' (default)' : ''}</option>`)}
      </select>
    </label>
    <label class="run-picker-row">Effort
      <select class="rp-select" data-run="effort" value=${value.effort ?? ''}
        onChange=${(e) => onChange({ ...value, effort: e.target.value })}>
        <option value="">${model?.defaultEffort ? `${model.defaultEffort} (default)` : 'Default'}</option>
        ${efforts.map((e) => html`<option key=${e} value=${e}>${e}</option>`)}
      </select>
    </label>
    ${
      speeds.length
        ? html`<label class="run-picker-row">Speed
            <select class="rp-select" data-run="speed" value=${value.speed ?? ''}
              onChange=${(e) => onChange({ ...value, speed: e.target.value })}>
              <option value="">${model?.defaultSpeed ? `${SPEED_LABELS[model.defaultSpeed] ?? model.defaultSpeed} (default)` : 'Default'}</option>
              ${speeds.map((s) => html`<option key=${s} value=${s}>${SPEED_LABELS[s] ?? s}</option>`)}
            </select>
          </label>`
        : null
    }
    ${
      roles.length
        ? html`<label class="run-picker-row">Role
            <select class="rp-select" data-run="role" value=${value.role ?? ''}
              onChange=${(e) => onChange({ ...value, role: e.target.value })}>
              <option value="">${roleLabel(roles, worker?.defaultRole) ?? 'Default'} (default)</option>
              ${roles.map((r) => html`<option key=${r.id} value=${r.id}>${r.label}</option>`)}
            </select>
          </label>`
        : null
    }
    ${
      worker?.id === 'muse' && !musePersonal
        ? html`<p class="run-picker-note" data-note="muse-personal">Muse is personal: this thread goes to your personal Archive, whatever project it's in.</p>`
        : null
    }
    ${musePersonal ? html`<p class="run-picker-note" data-note="muse-personal">${musePersonal}</p>` : null}
    ${
      lock
        ? html`<p class="run-picker-note" data-note="worker-lock">The worker can't change right now: ${lock}.
            ${onNewThread ? html` <button type="button" class="run-picker-link" onClick=${onNewThread}>New thread…</button>` : null}</p>`
        : null
    }
    ${
      unavailable.length
        ? html`<p class="run-picker-note run-picker-note--dim" data-note="unavailable">${unavailable.map((u) => html`<span key=${u.id}>${workerName(u)} isn't available: ${u.reason}. </span>`)}</p>`
        : null
    }
  </div>`;
}

// --- The thread header's picker ---------------------------------------------------------------

/**
 * Apply a picked run to a thread. A worker or role change goes first: the thread is rebuilt on the
 * new worker, whose native session starts fresh (after the first turn, seeded with the conversation and
 * marked "continued on" in the transcript); then the model (marked "switched to" after the first turn) and effort, which its idle
 * session picks up on the next turn.
 */
async function applyRun(threadId, launch, next) {
  const json = { 'Content-Type': 'application/json' };
  // The worker and role go together, so a refused role never leaves the worker switched.
  const thread = {
    ...(next.worker !== launch.worker ? { worker: next.worker } : {}),
    ...((next.role || null) !== (launch.role ?? null) ? { role: next.role || null } : {}),
  };
  if (Object.keys(thread).length) {
    const res = await authFetch(`/api/threads/${encodeURIComponent(threadId)}`, {
      method: 'PATCH',
      headers: json,
      body: JSON.stringify(thread),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw Error(body.error ?? res.statusText);
  }
  const res = await authFetch(`/api/threads/${encodeURIComponent(threadId)}/launch`, {
    method: 'PATCH',
    headers: json,
    body: JSON.stringify({
      // The thread holds its own model: only a different pick is sent (a worker switch already set one).
      ...(next.model && next.model !== launch.model ? { model: next.model } : {}),
      effort: next.effort || null,
      ...((next.speed || null) !== (launch.speed ?? null) ? { speed: next.speed || null } : {}),
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Error(body.error ?? res.statusText);
}

/** Whether the open thread's picker is showing (mounted at the app's root, outside the header's containment). */
export const threadRunOpen = signal(false);
export const openThreadRun = () => {
  threadRunOpen.value = true;
};

/**
 * The picker for one thread's run: the open thread's (the header's pill) or an agent of it (the
 * agents modal, which names the agent in `title` and leaves out `onNewThread`).
 */
export function ThreadRunModal({
  threadId,
  launch,
  title = 'Runs on',
  onClose,
  onSaved,
  onNewThread,
}) {
  const workers = launch.options?.workers ?? [];
  // What the picker shows is what Apply sends: a model its worker doesn't list reads as the default.
  const current = workers.find((w) => w.id === launch.worker);
  const [value, setValue] = useState({
    worker: launch.worker,
    model: modelOf(current, launch.model) ? launch.model : (current?.defaultModel ?? launch.model),
    effort: launch.effort ?? '',
    speed: launch.speed ?? '',
    role: launch.role ?? '',
  });
  const [busy, setBusy] = useState(false);
  const switching = value.worker !== launch.worker;
  // What a mid-thread switch means for where the thread is archived (Muse is always personal).
  const ranOnMuse =
    launch.worker === 'muse' || (launch.switches ?? []).some((s) => s.from === 'muse');
  const musePersonal = !launch.started
    ? null
    : switching && value.worker === 'muse' && !ranOnMuse
      ? `Muse is personal: from here this thread goes to your personal Archive${launch.projectLabel ? `, not ${launch.projectLabel}'s` : ''}.`
      : switching && ranOnMuse
        ? 'This thread stays personal: it ran on Muse, so it keeps going to your personal Archive.'
        : null;
  const save = async () => {
    setBusy(true);
    try {
      await applyRun(threadId, launch, value);
      await loadLaunch(threadId);
      await onSaved?.();
      showToast(
        switching
          ? launch.started
            ? `Continued on ${workerName(value.worker)} from here`
            : `This thread now runs on ${workerName(value.worker)}`
          : 'Applies from the next turn',
        'ok',
        { thread: threadId },
      );
      onClose();
    } catch (error) {
      showToast(`Could not change it: ${error.message}`, 'error', { thread: threadId });
      // A worker switch may have landed before the model or effort was refused: show what is true now.
      await loadLaunch(threadId);
      await onSaved?.();
      onClose();
    } finally {
      setBusy(false);
    }
  };
  return html`<${Modal} title=${title} onClose=${onClose} class="run-modal">
    <${RunPicker} value=${value} workers=${workers} roles=${launch.options?.roles ?? []}
      unavailable=${launch.options?.unavailableWorkers ?? []}
      lock=${launch.workerLock} musePersonal=${musePersonal} onChange=${setValue}
      onNewThread=${onNewThread} />
    <p class="run-picker-note run-picker-note--dim" data-note="carry-over">
      ${
        !switching
          ? 'A change applies from the next turn.'
          : launch.started
            ? `Continues on a fresh ${workerName(value.worker)} session that carries the conversation and plan, not the old session's files read or tool state.`
            : `Nothing has run yet: the thread restarts on ${workerName(value.worker)} with a fresh session.`
      }
    </p>
    <div class="rename-actions">
      <button type="button" class="action-btn" onClick=${onClose}>✕ Cancel</button>
      <button type="button" class="action-btn primary" data-run="apply" disabled=${busy} onClick=${save}>✓ Apply</button>
    </div>
  <//>`;
}

// --- "+ New thread" ----------------------------------------------------------------------------

/**
 * The New thread picker: open (with an optional preset worker, role, where or draft) or closed (null).
 * `joinThread` opens it as "New agent in this thread": the thread it starts stays unselected and
 * `onCreated(created, displayName)` joins it to that thread.
 */
export const newThreadChooser = signal(null);

/** Foundry's own scopes in the Where picker, after Global and before the projects. */
const SCOPE_CHOICES = [
  ['@forge', 'Forge Master'],
  ['@feedback', 'Feedback'],
];
/** A Where choice as a select value: '' is Global, else the scope key or project id (never alike). */
const whereValue = (where) => where ?? '';
const whereOf = (value) => value || null;

/** Where a new thread goes: Global, Forge Master, Feedback, or a project (archived ones hidden). */
export function WherePicker({ where, onChange }) {
  const listed = projects.value.filter((p) => p.status !== 'archived' || p.id === where);
  return html`<label class="run-picker-row">Where
    <select class="rp-select" data-run="where" value=${whereValue(where)}
      onChange=${(e) => onChange(whereOf(e.target.value))}>
      <option value="">Global</option>
      ${SCOPE_CHOICES.map(([id, label]) => html`<option key=${id} value=${id}>${label}</option>`)}
      ${
        listed.length
          ? html`<optgroup label="Projects">
              ${listed.map((p) => html`<option key=${p.id} value=${p.id}>${p.label || p.id}</option>`)}
            </optgroup>`
          : null
      }
    </select>
  </label>`;
}
export const openNewThread = (preset = {}) => {
  newThreadChooser.value = preset;
};

/** A new agent's name in the thread it joins, when the person gives none: its worker and model. */
const agentName = (worker, model) =>
  [workerName(worker), modelOf(worker, model)?.label ?? model].filter(Boolean).join(' · ') ||
  'New agent';

/**
 * Start a thread where it is picked (the active scope by default) on the picked worker, model,
 * effort and role. A Foundry scope's thread takes the scope's role, so it has no role to pick.
 */
export function NewThreadModal() {
  const preset = newThreadChooser.value;
  const [scope, setScope] = useState(null);
  const [value, setValue] = useState(null);
  const [name, setName] = useState('');
  const [where, setWhere] = useState(null);
  // Each open starts where the workspace is, unless the opener named a place. The name is cleared on
  // close, not here: an effect runs after the first paint and would wipe what was typed in it.
  useEffect(() => {
    if (!preset) return;
    setWhere(preset.where !== undefined ? preset.where : currentScope());
  }, [preset]);
  const pinned = isScope(where);
  const projectId = pinned ? null : where;
  useEffect(() => {
    if (!preset) return undefined;
    let live = true;
    setScope(null);
    setValue(null);
    authFetch(projectId ? `/api/projects/${encodeURIComponent(projectId)}/workers` : '/api/workers')
      .then((res) => (res.ok ? res.json() : Promise.reject(Error(res.statusText))))
      .then((body) => {
        if (!live) return;
        const workers = body.workers ?? [];
        const worker =
          workers.find((w) => w.id === preset.worker) ??
          workers.find((w) => w.default) ??
          workers[0];
        setScope({ workers, unavailable: body.unavailable ?? [], roles: body.roles ?? [] });
        setValue({
          worker: worker?.id ?? '',
          model: worker?.defaultModel ?? '',
          effort: '',
          speed: '',
          role: preset.role ?? '',
        });
      })
      .catch((error) => live && setScope({ error: error.message }));
    return () => {
      live = false;
    };
  }, [preset, projectId]);
  if (!preset) return null;
  const close = () => {
    newThreadChooser.value = null;
    // The next open reads its scope afresh, never picking from this one's choices.
    setScope(null);
    setValue(null);
    setName('');
  };
  const joining = preset.joinThread ?? null;
  const start = async () => {
    const worker = scope.workers.find((w) => w.id === value.worker);
    close();
    const created = await createThread({
      where,
      ...(joining ? { select: false } : {}),
      ...(name.trim() ? { name: name.trim() } : {}),
      ...(worker && !worker.default ? { worker: worker.id } : {}),
      ...(value.model && value.model !== worker?.defaultModel ? { model: value.model } : {}),
      ...(value.effort ? { effort: value.effort } : {}),
      ...(value.speed ? { speed: value.speed } : {}),
      ...(value.role && !pinned ? { role: value.role } : {}),
    });
    // A draft from the opener (a settings page asking the Forge Master) waits in the new thread's box.
    if (created && preset.draft) composerFill.value = preset.draft;
    if (created && preset.onCreated)
      await preset.onCreated(created, name.trim() || agentName(worker, value.model));
  };
  return html`<${Modal} title=${joining ? 'New agent in this thread' : 'New thread'} onClose=${close} class="run-modal new-thread-modal">
    <div class="run-picker">
      <label class="run-picker-row">Name
        <input class="rp-select" data-run="name" placeholder="Optional" maxlength="200" value=${name}
          onInput=${(e) => setName(e.target.value)} />
      </label>
      ${joining ? null : html`<${WherePicker} where=${where} onChange=${setWhere} />`}
    </div>
    ${
      joining
        ? html`<p class="run-picker-note run-picker-note--dim" data-note="joins">Starts as its own thread in this project and joins this one as a local member: it hears the conversation and speaks when the floor lets it.</p>`
        : null
    }
    ${
      scope?.error
        ? html`<p class="run-picker-note">Could not read the workers: ${scope.error}</p>`
        : scope && value
          ? html`<${RunPicker} value=${value} workers=${scope.workers} roles=${pinned ? [] : scope.roles} unavailable=${scope.unavailable} onChange=${setValue} />`
          : html`<p class="run-picker-note run-picker-note--dim">Reading the workers…</p>`
    }
    <div class="rename-actions">
      <button type="button" class="action-btn" onClick=${close}>✕ Cancel</button>
      <button type="button" class="action-btn primary" data-run="start" disabled=${!value}
        onClick=${start}>${joining ? '✓ Add agent' : '✓ Start thread'}</button>
    </div>
  <//>`;
}

/** Both pickers, mounted once at the app's root. */
export function RunPickers() {
  const launch = threadLaunch.value;
  const close = () => {
    threadRunOpen.value = false;
  };
  return html`
    ${
      threadRunOpen.value && launch
        ? html`<${ThreadRunModal} key=${launch.threadId} threadId=${activeThreadId.value} launch=${launch} onClose=${close}
      onNewThread=${() => {
        close();
        openNewThread();
      }} />`
        : null
    }
    <${NewThreadModal} />
  `;
}
