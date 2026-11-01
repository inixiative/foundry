/**
 * @atlas
 * @kind component
 * @partOf feature:viewer
 */
/**
 * Search: one input over threads, messages, docs and Atlas, PRs and tickets, people and feedback,
 * narrowed to a project by scope chips. Threads, PRs and tickets (threads' linked references) and
 * feedback are searched in the browser; messages come from the local Archive
 * (`POST /api/archives/search`); docs and Atlas from each project's Atlas
 * (`GET /api/projects/:id/atlas`). People have no source yet. Esc goes back.
 */

import { html, useEffect, useRef, useState } from './lib.js';
import {
  allThreads,
  authFetch,
  feedbackItems,
  openFeedbackSource,
  projects,
  searchOpen,
  selectThread,
} from './store.js';
import { projectLabel, threadName } from './thread-labels.js';

const LIMIT = 8;

/** The query's matches in `text`, marked. */
function Marked({ text, query }) {
  if (!query) return text;
  const lower = text.toLowerCase();
  const parts = [];
  let at = 0;
  for (let i = lower.indexOf(query); i !== -1; i = lower.indexOf(query, at)) {
    if (i > at) parts.push(text.slice(at, i));
    parts.push(html`<mark>${text.slice(i, i + query.length)}</mark>`);
    at = i + query.length;
  }
  parts.push(text.slice(at));
  return parts;
}

const has = (query, ...texts) =>
  !query || texts.some((t) => (t ?? '').toLowerCase().includes(query));

/** The Archive's messages for the query, read a moment after typing stops. */
function useArchiveSearch(query, projectId) {
  const [result, setResult] = useState({ hits: [], state: 'idle' });
  useEffect(() => {
    if (query.length < 2) return setResult({ hits: [], state: 'idle' });
    let live = true;
    setResult((r) => ({ ...r, state: 'loading' }));
    const timer = setTimeout(() => {
      authFetch('/api/archives/search', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query, limit: 20, ...(projectId ? { projectId } : {}) }),
      })
        .then(async (res) =>
          res.ok
            ? res.json()
            : Promise.reject(
                new Error((await res.json().catch(() => ({}))).error ?? `${res.status}`),
              ),
        )
        .then((body) => live && setResult({ hits: body.archives ?? [], state: 'ready' }))
        .catch((err) => live && setResult({ hits: [], state: 'error', error: err.message }));
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [query, projectId]);
  return result;
}

const atlasCache = new Map();

/** Each scoped project's Atlas concepts, read once per page visit. */
function useAtlas(projectIds) {
  const [byProject, setByProject] = useState(() => new Map(atlasCache));
  const key = projectIds.join('|');
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-read when the scoped projects change.
  useEffect(() => {
    let live = true;
    for (const id of projectIds) {
      if (atlasCache.has(id)) continue;
      authFetch(`/api/projects/${encodeURIComponent(id)}/atlas`)
        .then((res) => (res.ok ? res.json() : { mapped: false }))
        .catch(() => ({ mapped: false }))
        .then((body) => {
          atlasCache.set(id, body);
          if (live) setByProject(new Map(atlasCache));
        });
    }
    return () => {
      live = false;
    };
  }, [key]);
  return byProject;
}

function Hit({ title, sub, where, query, onOpen, why }) {
  return html`<div class="search-hit ${onOpen ? '' : 'is-static'}" role=${onOpen ? 'button' : undefined} tabindex=${onOpen ? 0 : undefined}
    title=${why} onClick=${onOpen} onKeyDown=${(e) => e.key === 'Enter' && onOpen?.()}>
    <b><${Marked} text=${title} query=${query} /></b>
    ${sub ? html`<small><${Marked} text=${sub} query=${query} /></small>` : null}
    ${where ? html`<i>${where}</i>` : null}
  </div>`;
}

function Group({ title, hits, empty }) {
  return html`<section class="search-group" aria-label=${title}>
    <h4>${title}${hits ? ` · ${hits.length}` : ''}</h4>
    ${hits?.length ? hits.slice(0, LIMIT) : html`<p class="search-empty">${empty}</p>`}
  </section>`;
}

const snippet = (text, query) => {
  const flat = text.replace(/\s+/g, ' ').trim();
  const i = query ? flat.toLowerCase().indexOf(query) : 0;
  const start = Math.max(0, i - 60);
  return `${start ? '…' : ''}${flat.slice(start, start + 180)}${flat.length > start + 180 ? '…' : ''}`;
};

export function SearchPage() {
  const [raw, setRaw] = useState('');
  const [scope, setScope] = useState('all');
  const input = useRef(null);
  useEffect(() => input.current?.focus(), []);
  const query = raw.trim().toLowerCase();
  const live = projects.value.filter((p) => p.status !== 'archived');
  const projectId = scope === 'all' ? null : scope;
  const inScope = (id) => !projectId || (id ?? null) === projectId;
  const archive = useArchiveSearch(query, projectId);
  const atlas = useAtlas((projectId ? [projectId] : live.map((p) => p.id)).filter(Boolean));

  const threads = allThreads.value.filter(
    (t) =>
      inScope(t.meta?.projectId) &&
      has(query, threadName(t), t.meta?.description, projectLabel(t.meta?.projectId)),
  );
  const references = allThreads.value
    .filter((t) => inScope(t.meta?.projectId))
    .flatMap((t) => (t.meta?.context?.references ?? []).map((r) => ({ r, t })))
    .filter(({ r, t }) => has(query, r.ref, r.integration, threadName(t)));
  const feedback = feedbackItems.value.filter(
    (f) => inScope(f.projectId) && has(query, f.statement, f.quote),
  );
  const concepts = [...atlas.entries()]
    .filter(([id]) => inScope(id))
    .flatMap(([id, body]) =>
      body?.mapped ? body.concepts.map((c) => ({ ...c, projectId: id })) : [],
    )
    .filter((c) => query && has(query, c.concept, c.doc, ...(c.phrases ?? [])));
  const mapped = [...atlas.entries()].some(([id, body]) => inScope(id) && body?.mapped);

  return html`<section class="search-page" aria-label="Search">
    <header class="search-head">
      <h2>Search</h2>
      <span class="search-meta">Threads, messages, docs and Atlas, PRs and tickets, people and feedback</span>
    </header>
    <div class="search-body">
      <input ref=${input} class="search-input" type="search" placeholder="Search everything…" autocomplete="off"
        value=${raw} onInput=${(e) => setRaw(e.target.value)}
        onKeyDown=${(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            searchOpen.value = false;
          }
        }} />
      <div class="search-scope" role="group" aria-label="Scope">
        <button type="button" aria-pressed=${scope === 'all'} onClick=${() => setScope('all')}>Everywhere</button>
        ${live.map((p) => html`<button key=${p.id} type="button" aria-pressed=${scope === p.id} onClick=${() => setScope(p.id)}>${p.label}</button>`)}
      </div>
      <${Group} title="Threads" empty="No thread matches."
        hits=${threads.map(
          (t) => html`<${Hit} key=${t.threadId} query=${query} title=${threadName(t)}
          sub=${t.meta?.description && t.meta.description !== threadName(t) ? t.meta.description : ''}
          where=${projectLabel(t.meta?.projectId)} onOpen=${() => selectThread(t.threadId)} />`,
        )} />
      <${Group} title="Messages"
        empty=${
          query.length < 2
            ? 'Type to search the messages your local Archive holds.'
            : archive.state === 'loading'
              ? 'Searching the Archive…'
              : archive.state === 'error'
                ? `The Archive couldn’t be searched: ${archive.error}.`
                : 'No message matches.'
        }
        hits=${
          archive.hits.length
            ? archive.hits.map((a) => {
                const text = snippet(a.chunks?.[0]?.text ?? '', query) || a.title;
                const thread =
                  a.source === 'foundry' &&
                  allThreads.value.find((t) => t.threadId === a.sessionId);
                return html`<${Hit} key=${a.archiveId} query=${query} title=${text}
                  sub=${text === a.title ? a.source : `${a.title} · ${a.source}`} where=${a.projectId ? projectLabel(a.projectId) : ''}
                  why=${thread ? undefined : 'Not a thread on this machine: open it in the Archive'}
                  onOpen=${thread ? () => selectThread(thread.threadId) : undefined} />`;
              })
            : null
        } />
      <${Group} title="Docs and Atlas"
        empty=${!mapped ? 'Not indexed yet: no project in scope has an Atlas.' : query ? 'No concept or doc matches.' : 'Type to search the projects’ Atlas concepts and their docs.'}
        hits=${
          concepts.length
            ? concepts.map(
                (
                  c,
                ) => html`<${Hit} key=${`${c.projectId}:${c.concept}`} query=${query} title=${c.doc ? `${c.concept} † ${c.doc}` : c.concept}
                sub=${`Atlas concept · ${c.files} file${c.files === 1 ? '' : 's'}`} where=${projectLabel(c.projectId)} />`,
              )
            : null
        } />
      <${Group} title="PRs and tickets" empty="No linked PR or ticket matches."
        hits=${references.map(
          ({ r, t }) => html`<${Hit} key=${`${t.threadId}:${r.integration}:${r.ref}`} query=${query}
          title=${r.ref} sub=${`${r.integration} · ${threadName(t)}`} where=${projectLabel(t.meta?.projectId)}
          onOpen=${r.url ? () => window.open(r.url, '_blank', 'noopener') : () => selectThread(t.threadId)} />`,
        )} />
      <${Group} title="People" empty="Not indexed yet: Foundry has no people directory (teammates come with Heralds and Kingdom)." />
      <${Group} title="Feedback" empty="No feedback matches."
        hits=${feedback.map(
          (f) => html`<${Hit} key=${f.id} query=${query} title=${f.statement}
          sub=${`${f.inbox} · ${f.status}`} where=${projectLabel(f.projectId)} onOpen=${() => openFeedbackSource(f)} />`,
        )} />
    </div>
  </section>`;
}
