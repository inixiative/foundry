/**
 * @atlas
 * @kind component
 * @partOf feature:scheduler, feature:viewer
 */
/**
 * The Scheduled rail's schedules: each one by its Where (a project, Global, Forge Master, Feedback),
 * its time, next run and last result. Open one for its past runs (each a thread), run it now, pause
 * or resume it, edit or remove it; an agent's draft waits here for Accept (Aron, 2026-11-14: "I
 * should be able to go see past runs of the schedule"). Schedules are local to this Foundry, in its
 * settings, never committed (`scheduler/`, `/api/schedules`).
 */
import { html, useEffect, useState } from './lib.js';
import { Pane } from './rail-pane.js';
import { WherePicker } from './run-picker.js';
import { authFetch, openScheduleId, projects, railView, schedules, selectThread } from './store.js';
import { projectLabel } from './thread-labels.js';

const SCOPE_LABELS = { forge: 'Forge Master', feedback: 'Feedback' };

export const whereLabel = (where) =>
  where.kind === 'project'
    ? projectLabel(where.projectId)
    : where.kind === 'scope'
      ? (SCOPE_LABELS[where.scope] ?? where.scope)
      : 'Global';

const whereKey = (where) =>
  where.kind === 'project'
    ? `project:${where.projectId}`
    : where.kind === 'scope'
      ? `scope:${where.scope}`
      : 'global';

/** A schedule's Where as the New thread picker's value: null Global, '@<scope>', or a project id. */
const pickerWhere = (where) =>
  where.kind === 'project' ? where.projectId : where.kind === 'scope' ? `@${where.scope}` : null;
const scheduleWhere = (value) =>
  value == null
    ? { kind: 'global' }
    : value.startsWith('@')
      ? { kind: 'scope', scope: value.slice(1) }
      : { kind: 'project', projectId: value };

const when = (ms) =>
  new Date(ms).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });

export function whenLabel(schedule) {
  const w = schedule.when;
  if (w.every) return `every ${w.every}`;
  if (w.cron) return `cron ${w.cron}${w.tz ? ` (${w.tz})` : ''}`;
  return `once, ${when(Date.parse(w.at))}`;
}

const OUTCOME = { started: 'ran', skipped: 'skipped', failed: 'failed' };

function stateLabel(view) {
  if (view.schedule.draft) return 'draft · waits for you';
  if (view.schedule.paused) return 'paused';
  if (view.nextDueAt) return `next ${when(view.nextDueAt)}`;
  return 'nothing left to run';
}

/** The drafts agents proposed, waiting for the owner: the Scheduled tab's count. */
export const draftCount = () => schedules.value.filter((view) => view.schedule.draft).length;

async function call(url, method, body) {
  const res = await authFetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Error(json.error ?? `HTTP ${res.status}`);
  return json;
}

const path = (id, rest = '') => `/api/schedules/${encodeURIComponent(id)}${rest}`;

/** The schedules, grouped by Where in the order settings hold them, with a + New. */
export function ScheduleList() {
  const [editing, setEditing] = useState(null); // null | 'new' | a schedule id
  const views = schedules.value;
  const groups = new Map();
  for (const view of views) {
    const key = whereKey(view.where);
    if (!groups.has(key)) groups.set(key, { where: view.where, views: [] });
    groups.get(key).views.push(view);
  }
  const editView =
    editing && editing !== 'new' ? views.find((v) => v.schedule.id === editing) : null;
  return html`<${Pane} title="Schedules" className="schedules-pane" count=${views.length}
    empty=${editing ? null : 'Nothing is scheduled. Add one here, or ask an agent to schedule something: each run is a new thread, listed under its schedule.'}
    action=${html`<button type="button" class="rail-new-thread" onClick=${() => setEditing('new')}>+ New schedule</button>`}
    lead=${
      editing
        ? html`<${ScheduleEditor} key=${editing} view=${editView} onDone=${(id) => {
            setEditing(null);
            if (id) openScheduleId.value = id;
          }} />`
        : null
    }>${[...groups.values()].map(
      (group) => html`<div key=${whereKey(group.where)} class="schedule-group">
        <div class="schedule-group-head">${whereLabel(group.where)}</div>
        ${group.views.map(
          (view) =>
            html`<${ScheduleRow} key=${view.schedule.id} view=${view} onEdit=${() => setEditing(view.schedule.id)} />`,
        )}
      </div>`,
    )}</${Pane}>`;
}

function ScheduleRow({ view, onEdit }) {
  const { schedule } = view;
  const open = openScheduleId.value === schedule.id;
  const last = view.lastRun;
  return html`<div class="schedule ${open ? 'is-open' : ''} ${schedule.draft ? 'is-draft' : ''}" data-schedule=${schedule.id}>
    <div class="tree-node tree-node--two" role="button" tabindex="0" title=${`${schedule.name} · ${schedule.id}`}
      onClick=${() => {
        openScheduleId.value = open ? null : schedule.id;
      }}>
      <div class="tree-row tree-row--name"><span class="tree-label">${schedule.name}</span></div>
      <div class="tree-row tree-row--meta">
        <span class="schedule-state" data-state=${schedule.draft ? 'draft' : schedule.paused ? 'paused' : 'on'}>${stateLabel(view)}</span>
        <span class="row-project">· ${whenLabel(schedule)}</span>
        ${last ? html`<span class="schedule-last" data-outcome=${last.outcome} title=${last.reason ?? ''}>· last ${OUTCOME[last.outcome]}</span>` : null}
      </div>
    </div>
    ${open ? html`<${ScheduleDetail} view=${view} onEdit=${onEdit} />` : null}
  </div>`;
}

function ScheduleDetail({ view, onEdit }) {
  const { schedule } = view;
  const [runs, setRuns] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const lastId = view.lastRun?.id ?? '';
  // Re-read when a new run lands (lastId).
  useEffect(() => {
    let live = true;
    call(path(schedule.id, '/runs?limit=30'), 'GET')
      .then((body) => live && setRuns(body.runs))
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [schedule.id, lastId]);

  const act = (fn) => async () => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  const remove = act(async () => {
    if (!confirm(`Remove "${schedule.name}"? Its past runs stay listed in their threads.`)) return;
    await call(path(schedule.id), 'DELETE');
    openScheduleId.value = null;
  });

  return html`<div class="schedule-detail">
    <p class="schedule-prompt">${schedule.prompt}</p>
    ${
      schedule.draft
        ? html`<p class="schedule-draft-note">An agent proposed this; it never runs until you accept it.
            <button type="button" class="schedule-link" onClick=${() => selectThread(schedule.draft.threadId)}>Open the thread that proposed it</button></p>`
        : null
    }
    <div class="schedule-actions">
      ${
        schedule.draft
          ? html`<button type="button" class="schedule-primary" disabled=${busy} onClick=${act(() => call(path(schedule.id, '/accept'), 'POST'))}>Accept</button>`
          : html`<button type="button" disabled=${busy} onClick=${act(() => call(path(schedule.id, '/run'), 'POST'))}>Run now</button>
            <button type="button" disabled=${busy} onClick=${act(() => call(path(schedule.id, '/pause'), 'POST', { paused: !schedule.paused }))}>${schedule.paused ? 'Resume' : 'Pause'}</button>`
      }
      <button type="button" disabled=${busy} onClick=${onEdit}>Edit</button>
      <button type="button" class="schedule-danger" disabled=${busy} onClick=${remove}>${schedule.draft ? 'Reject' : 'Remove'}</button>
    </div>
    ${error ? html`<p class="schedule-error" role="alert">${error}</p>` : null}
    <div class="schedule-runs-head">Past runs</div>
    ${
      runs === null
        ? html`<div class="rail-empty">Loading…</div>`
        : runs.length
          ? html`<ol class="schedule-runs">${runs.map(
              (run) => html`<li key=${run.id} data-outcome=${run.outcome}>
                <span class="schedule-run-time">${when(run.dueAt)}${run.id.includes(':now:') ? ' · by hand' : ''}</span>
                <span class="schedule-run-outcome">${OUTCOME[run.outcome]}</span>
                ${run.threadId ? html`<button type="button" class="schedule-link" onClick=${() => selectThread(run.threadId)}>open thread</button>` : null}
                ${run.reason ? html`<span class="schedule-run-reason">${run.reason}</span>` : null}
              </li>`,
            )}</ol>`
          : html`<div class="rail-empty">No runs yet.</div>`
    }
  </div>`;
}

const slug = (name) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'schedule';

/** A datetime-local value for an ISO time, in this browser's zone. */
const localInput = (iso) => {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** Make or change a schedule. What it doesn't show (worker, role, model, effort) it keeps. */
function ScheduleEditor({ view, onDone }) {
  const prior = view?.schedule;
  const kind = prior ? (prior.when.every ? 'every' : prior.when.cron ? 'cron' : 'at') : 'every';
  const [form, setForm] = useState({
    name: prior?.name ?? '',
    id: prior?.id ?? '',
    prompt: prior?.prompt ?? '',
    kind,
    every: prior?.when.every ?? '1d',
    cron: prior?.when.cron ?? '0 9 * * 1-5',
    tz: prior?.when.tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    at: prior?.when.at ? localInput(prior.when.at) : '',
    where: view ? pickerWhere(view.where) : null,
    paused: !!prior?.paused,
  });
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const set = (key) => (e) =>
    setForm({ ...form, [key]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });

  const save = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    const id = prior?.id ?? (form.id.trim() || slug(form.name));
    const whenValue =
      form.kind === 'every'
        ? { every: form.every.trim() }
        : form.kind === 'cron'
          ? { cron: form.cron.trim(), ...(form.tz.trim() ? { tz: form.tz.trim() } : {}) }
          : { at: form.at ? new Date(form.at).toISOString() : '' };
    const where = scheduleWhere(form.where);
    const { since: _since, draft: _draft, scope: _scope, paused: _paused, ...kept } = prior ?? {};
    const schedule = {
      ...kept,
      id,
      name: form.name.trim(),
      prompt: form.prompt,
      when: whenValue,
      ...(form.paused ? { paused: true } : {}),
    };
    try {
      await call(path(id), 'PUT', { schedule, where });
      onDone(id);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return html`<form class="schedule-editor" onSubmit=${save} aria-label=${prior ? `Edit ${prior.name}` : 'New schedule'}>
    <label>Name<input required maxlength="200" value=${form.name} onInput=${set('name')} placeholder="Morning triage" /></label>
    ${
      prior
        ? null
        : html`<label>Id<input value=${form.id} onInput=${set('id')} placeholder=${slug(form.name || 'schedule')}
            pattern="[a-z0-9][a-z0-9-]{0,63}" title="lowercase letters, digits and dashes" /></label>`
    }
    <label>Prompt<textarea required rows="4" value=${form.prompt} onInput=${set('prompt')}
      placeholder="What each run is asked. It starts a new thread with no memory of this one."></textarea></label>
    <${WherePicker} where=${form.where} onChange=${(where) => setForm({ ...form, where })} />
    <label>When<select value=${form.kind} onChange=${set('kind')}>
      <option value="every">Every</option>
      <option value="cron">Cron</option>
      <option value="at">Once</option>
    </select></label>
    ${
      form.kind === 'every'
        ? html`<label>Interval<input required value=${form.every} onInput=${set('every')} pattern="[1-9][0-9]{0,3}[mhd]" title="a count and a unit: 15m, 2h, 1d (at least 5m)" /></label>`
        : form.kind === 'cron'
          ? html`<label>Cron<input required value=${form.cron} onInput=${set('cron')} title="minute hour day-of-month month day-of-week" /></label>
              <label>Time zone<input value=${form.tz} onInput=${set('tz')} /></label>`
          : html`<label>At<input required type="datetime-local" value=${form.at} onInput=${set('at')} /></label>`
    }
    <label class="schedule-check"><input type="checkbox" checked=${form.paused} onChange=${set('paused')} /> Paused</label>
    ${error ? html`<p class="schedule-error" role="alert">${error}</p>` : null}
    <div class="schedule-actions">
      <button type="submit" class="schedule-primary" disabled=${saving}>${prior?.draft ? 'Save and accept' : prior ? 'Save' : 'Schedule it'}</button>
      <button type="button" onClick=${() => onDone(null)}>Cancel</button>
    </div>
  </form>`;
}

/** A run thread's provenance in its header: "scheduled · <name>", opening the schedule in the rail. */
export function ScheduledLink({ scheduledBy }) {
  if (!scheduledBy) return null;
  const view = schedules.value.find((v) => v.schedule.id === scheduledBy.scheduleId);
  const name = view?.schedule.name ?? scheduledBy.scheduleId;
  const open = () => {
    railView.value = 'scheduled';
    openScheduleId.value = scheduledBy.scheduleId;
  };
  return html`<button type="button" class="band-pill fork-link" title=${`Started by the schedule "${name}", due ${when(scheduledBy.dueAt)}${view ? ': open it' : ' (since removed)'}`}
    onClick=${open}>scheduled · <b>${name}</b></button>`;
}
