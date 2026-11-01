/**
 * @atlas
 * @kind component
 * @partOf feature:viewer
 */
/**
 * A project's home page (and Global's): its threads with their status, the chorus, feedback, the
 * Archive and its links. Opened from the Projects list; a thread row opens the thread.
 */

import { feedbackIn } from './feedback.js';
import { html, useEffect, useState } from './lib.js';
import { navigate } from './route.js';
import { STATES, StatusIcon } from './status-icons.js';
import {
  activeProjectId,
  allThreads,
  createThread,
  projects,
  selectScope,
  selectThread,
  threadStatusOf,
} from './store.js';
import { threadName } from './thread-labels.js';
import { isClosedThread } from './thread-status.js';

const INACTIVE = new Set(['paused', 'idle']);

function useJson(url) {
  const [value, setValue] = useState(undefined);
  useEffect(() => {
    if (!url) return setValue(null);
    let live = true;
    setValue(undefined);
    fetch(url)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)
      .then((body) => live && setValue(body));
    return () => {
      live = false;
    };
  }, [url]);
  return value;
}

function ThreadRow({ thread }) {
  const state = threadStatusOf(thread.threadId);
  return html`<button type="button" class="ph-row" onClick=${() => selectThread(thread.threadId)}>
    <${StatusIcon} state=${state} still=${true} />
    <span class="ph-row-name">${threadName(thread)}</span>
    <span class="ph-row-state">${STATES[state]?.label ?? state}</span>
  </button>`;
}

function Chorus({ projectId }) {
  const body = useJson(`/api/projects/${encodeURIComponent(projectId)}/chorus`);
  const chorus = body?.chorus;
  if (body === undefined) return html`<div class="ph-meta">Reading the chorus…</div>`;
  if (!chorus) return html`<div class="ph-meta">No chorus for this project.</div>`;
  const ready = chorus.on && chorus.enabled;
  const regions = chorus.regions?.length ?? 0;
  const stages = chorus.roles?.warden?.stages ?? [];
  return html`
    <div class="ph-line ${ready ? '' : 'is-warn'}"><i></i>${ready ? `Ready · ${regions} region Wardens` : `Off${chorus.reason ? ` · ${chorus.reason}` : ''}`}</div>
    ${stages.length ? html`<div class="ph-meta">${stages.map((s) => `${s.task}: ${s.model === 'decision' ? 'the decision model' : s.model}`).join(' · ')}</div>` : null}
    ${chorus.missingDocs?.length ? html`<div class="ph-line is-warn"><i></i>${chorus.missingDocs.length} docs missing</div>` : null}`;
}

export function ProjectHome() {
  const projectId = activeProjectId.value;
  const isGlobal = !projectId;
  const project = projects.value.find((p) => p.id === projectId);
  const threads = allThreads.value.filter(
    (t) => (t.meta?.projectId ?? null) === (projectId ?? null) && !t.meta?.parentThreadId,
  );
  // Closed is the stored status; open vs inactive is the live one (a waiting request is open).
  const closed = threads.filter(isClosedThread);
  const live = threads.filter((t) => !isClosedThread(t));
  const inactive = live.filter((t) => INACTIVE.has(threadStatusOf(t.threadId)));
  const open = live.filter((t) => !INACTIVE.has(threadStatusOf(t.threadId)));
  const feedback = feedbackIn(isGlobal ? {} : { projectId });
  const openFeedback = feedback.filter((item) => item.inbox === 'open').length;
  const archive = useJson('/api/archives/status');
  const title = isGlobal ? 'Global' : (project?.label ?? projectId);

  return html`<section class="project-home" aria-label=${`${title} home`}>
    <header class="ph-head">
      <h2>${title}</h2>
      <span class="ph-meta">${isGlobal ? 'Threads outside any project' : 'Project'}${project?.path ? html` · <span class="mono">${project.path}</span>` : null}</span>
    </header>
    <div class="ph-grid">
      <section class="ph-box ph-threads">
        <h4>Threads · ${open.length} open</h4>
        ${open.length ? open.map((t) => html`<${ThreadRow} key=${t.threadId} thread=${t} />`) : html`<div class="ph-meta">Nothing open.</div>`}
        ${inactive.length ? html`<div class="ph-sub">Inactive · ${inactive.length}</div>${inactive.map((t) => html`<${ThreadRow} key=${t.threadId} thread=${t} />`)}` : null}
        ${closed.length ? html`<div class="ph-meta">${closed.length} closed</div>` : null}
        <div class="ph-actions"><button type="button" class="proj-btn" onClick=${() => createThread()}>+ New thread</button></div>
      </section>
      ${
        isGlobal
          ? null
          : html`<section class="ph-box"><h4>Chorus</h4><${Chorus} projectId=${projectId} />
          <button type="button" class="proj-btn ph-link" onClick=${() => navigate(`/projects/${encodeURIComponent(projectId)}/settings/chorus`)}>Settings › Chorus →</button></section>`
      }
      <section class="ph-box">
        <h4>Feedback</h4>
        <div class="ph-line"><b>${openFeedback}</b> open · ${feedback.length} in all</div>
        <button type="button" class="proj-btn ph-link" onClick=${() => selectScope('feedback')}>Open the feedback →</button>
      </section>
      <section class="ph-box">
        <h4>Archive</h4>
        <div class="ph-line ${archive && !archive.reachable ? 'is-warn' : ''}"><i></i>${archive === undefined ? 'Checking…' : archive?.reachable ? 'Local Archive running' : 'Local Archive not running'}</div>
        <div class="ph-meta">Sessions here are captured to it; closed threads stay readable there.</div>
        ${archive?.url ? html`<a class="proj-btn ph-link" href=${archive.url} target="_blank" rel="noopener">Open in Archive ↗</a>` : null}
      </section>
      ${
        isGlobal
          ? null
          : html`<section class="ph-box"><h4>Links</h4>
          ${project?.path ? html`<div class="ph-line mono">${project.path}</div>` : null}
          <div class="ph-meta">GitHub, Linear and Slack links show here once the project records them.</div></section>
          <section class="ph-box"><h4>Organisation</h4><div class="ph-meta">${project?.tags?.length ? project.tags.join(' · ') : 'No organisation tags'} · GitHub and Kingdom orgs attached to this project will show here</div></section>`
      }
    </div>
  </section>`;
}
