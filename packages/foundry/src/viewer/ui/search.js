/**
 * @atlas
 * @kind component
 * @partOf feature:viewer
 */
/**
 * Search: its own page (only the top bar beside it). One input over Foundry's settings, the projects'
 * docs, their Atlas, what Heralds would raise, then threads, messages, PRs and tickets, feedback and
 * people, in that order; each group shows five until "Show all". A preview pane shows the highlighted
 * result; ↑↓ moves it, Enter opens it, Esc goes back where you came from.
 *
 * Sources: settings from `GET /api/settings/index` (the catalog generated from the config interfaces,
 * with each value and whether it is yours, everyone's or the default); doc sections from
 * `/api/projects/:id/doc-sections` (the chorus regions' docs); Atlas from `/api/projects/:id/atlas`;
 * Heralds from `/api/projects/:id/overlaps` and the Watchtower's stages; messages from the local
 * Archive; threads, linked PRs and tickets, and feedback from what the viewer already holds.
 */

import { ComingSoon } from './coming-soon.js';
import { html, useEffect, useRef, useState } from './lib.js';
import { closeSearch, navigate, settingSection, settingsPath } from './route.js';
import { settingsHighlight } from './settings.js';
import {
  allThreads,
  authFetch,
  feedbackItems,
  openFeedbackSource,
  openProjectHome,
  projects,
  prompts,
  selectThread,
} from './store.js';
import { projectLabel, threadName } from './thread-labels.js';
import { categoryOf, isClosedThread, threadState } from './thread-status.js';
import { STAGES, stageOf } from './watchtower.js';

const SHOWN = 5;
const SOURCE_LABEL = {
  yours: 'Set by you',
  everyone: 'Set for everyone (the repository’s .foundry/project.json)',
  default: 'Default',
};

/** The query's matches in `text`, marked. */
function Marked({ text, query }) {
  if (!query || !text) return text ?? '';
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

const has = (query, ...texts) => texts.some((t) => (t ?? '').toLowerCase().includes(query));
/** Title matches first, then the rest, each in source order. */
const ranked = (items, query) => [
  ...items.filter((i) => i.title.toLowerCase().includes(query)),
  ...items.filter((i) => !i.title.toLowerCase().includes(query)),
];

const snippet = (text, query) => {
  const flat = (text ?? '').replace(/\s+/g, ' ').trim();
  const i = query ? flat.toLowerCase().indexOf(query) : 0;
  const start = Math.max(0, i - 60);
  return `${start ? '…' : ''}${flat.slice(start, start + 180)}${flat.length > start + 180 ? '…' : ''}`;
};

const cache = new Map();

/** GET each url once per page visit (null when it fails); re-renders as they arrive. */
function useReads(urls) {
  const [, setTick] = useState(0);
  const key = urls.join('|');
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-read when the urls change.
  useEffect(() => {
    let live = true;
    for (const url of urls) {
      if (cache.has(url)) continue;
      cache.set(url, undefined);
      authFetch(url)
        .then((res) => (res.ok ? res.json() : null))
        .catch(() => null)
        .then((body) => {
          cache.set(url, body);
          if (live) setTick((n) => n + 1);
        });
    }
    return () => {
      live = false;
    };
  }, [key]);
  return urls.map((url) => cache.get(url));
}

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

/** Leave Search for the workspace, then act there (open a thread, a project home). */
const inWorkspace = (act) => {
  navigate('/');
  act();
};

function settingHits(settings, scopeProject, query) {
  return settings
    .filter((s) => has(query, s.path, s.description, s.value))
    .map((s) => {
      const section = settingSection(s.scope, s.path.split('.')[0]);
      const projectId = s.scope === 'project' ? scopeProject : null;
      return {
        key: `setting:${s.scope}:${projectId}:${s.path}`,
        title: s.path,
        sub: s.description || 'No description in the config interface',
        where: s.scope === 'project' ? projectLabel(projectId) : 'Foundry',
        badge: s.source,
        preview: () => html`<div class="sp-setting">
          <h3><code>${s.path}</code></h3>
          <p>${s.description || 'No description in the config interface.'}</p>
          <dl>
            <dt>Value</dt><dd><code>${s.value ?? '—'}</code></dd>
            <dt>Comes from</dt><dd>${SOURCE_LABEL[s.source]}</dd>
            <dt>Scope</dt><dd>${s.scope === 'project' ? `Project · ${projectLabel(projectId)}` : 'Foundry-wide'}</dd>
            <dt>In Settings</dt><dd>${section ?? 'not shown in Settings: edit settings.json'}</dd>
          </dl>
        </div>`,
        open: section
          ? () => {
              settingsHighlight.value = { ...s, projectId, section };
              navigate(settingsPath(projectId, section));
            }
          : null,
      };
    });
}

export function SearchPage() {
  const [raw, setRaw] = useState('');
  const [scope, setScope] = useState('all');
  const [expanded, setExpanded] = useState(() => new Set());
  const [at, setAt] = useState(0);
  const [reading, setReading] = useState(null);
  const input = useRef(null);
  useEffect(() => input.current?.focus(), []);
  const query = raw.trim().toLowerCase();
  const live = projects.value.filter((p) => p.status !== 'archived');
  const projectId = scope === 'all' ? null : scope;
  const scoped = projectId ? [projectId] : live.map((p) => p.id);
  const inScope = (id) => !projectId || (id ?? null) === projectId;
  const enc = encodeURIComponent;
  const [foundrySettings, ...projectSettings] = useReads([
    '/api/settings/index',
    ...scoped.map((id) => `/api/settings/index?projectId=${enc(id)}`),
  ]);
  const docs = useReads(scoped.map((id) => `/api/projects/${enc(id)}/doc-sections`));
  const atlas = useReads(scoped.map((id) => `/api/projects/${enc(id)}/atlas`));
  const overlaps = useReads(scoped.map((id) => `/api/projects/${enc(id)}/overlaps`));
  const archive = useArchiveSearch(query, projectId);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new query or scope starts at the top.
  useEffect(() => {
    setAt(0);
    setExpanded(new Set());
  }, [query, scope]);

  const groups = [];
  if (query) {
    const settings = [
      ...(projectId ? [] : settingHits(foundrySettings?.settings ?? [], null, query)),
      ...scoped.flatMap((id, i) =>
        settingHits(
          (projectSettings[i]?.settings ?? []).filter((x) => x.scope === 'project'),
          id,
          query,
        ),
      ),
    ];
    groups.push({
      title: 'Settings',
      items: ranked(settings, query),
      empty: foundrySettings === undefined ? 'Reading settings…' : 'No setting matches.',
    });

    const docHits = scoped.flatMap((id, i) =>
      (docs[i]?.sections ?? [])
        .filter((d) => has(query, d.heading, d.text, d.doc, d.region))
        .map((d) => ({
          key: `doc:${id}:${d.pointer}`,
          title: d.heading,
          sub: d.pointer,
          where: projectLabel(id),
          preview: () =>
            html`<div class="sp-doc"><h3>${d.heading}</h3><p class="sp-pointer">${d.pointer} · region ${d.region}</p><pre>${d.text || '(no text under this heading)'}</pre></div>`,
          open: () => setReading({ title: d.heading, pointer: d.pointer, text: d.text }),
        })),
    );
    groups.push({
      title: 'Docs',
      items: ranked(docHits, query),
      empty: docs.every((d) => !d?.sections?.length)
        ? 'Not indexed yet: no project in scope has chorus regions with docs.'
        : 'No doc section matches.',
    });

    const atlasHits = scoped.flatMap((id, i) =>
      atlas[i]?.mapped
        ? atlas[i].concepts
            .filter((c) =>
              has(
                query,
                c.concept,
                c.doc,
                ...(c.phrases ?? []),
                ...(c.members ?? []).map((m) => m.path),
              ),
            )
            .map((c) => ({
              key: `atlas:${id}:${c.concept}`,
              title: c.concept,
              sub: `${c.concept.split(':')[0]} · ${c.files} file${c.files === 1 ? '' : 's'}${c.doc ? ` · † ${c.doc}` : ''}`,
              where: projectLabel(id),
              preview: () => html`<div class="sp-atlas">
                <h3>${c.concept}</h3>
                ${c.doc ? html`<p class="sp-pointer">† ${c.doc}</p>` : null}
                <ul>${(c.members ?? []).map((m) => html`<li key=${m.path}><code>${m.path}</code>${m.kind ? html` <small>${m.kind}</small>` : null}</li>`)}</ul>
                ${c.files > (c.members ?? []).length ? html`<p class="sp-dim">and ${c.files - c.members.length} more</p>` : null}
              </div>`,
              open: () => inWorkspace(() => openProjectHome(id)),
            }))
        : [],
    );
    groups.push({
      title: 'Atlas',
      items: ranked(atlasHits, query),
      empty: atlas.some((a) => a?.mapped)
        ? 'No concept matches.'
        : 'Not indexed yet: no project in scope has an Atlas.',
    });

    const watch = allThreads.value
      .filter((t) => !t.meta?.parentThreadId && !isClosedThread(t) && inScope(t.meta?.projectId))
      .map((t) => {
        const state = threadState(t, {
          prompts: prompts.value.filter((p) => p.threadId === t.threadId),
        });
        const stage = STAGES.find(([id]) => id === stageOf(t, categoryOf(state)))?.[1];
        return { t, stage };
      });
    const heraldHits = [
      ...scoped.flatMap((id, i) =>
        (overlaps[i]?.overlaps ?? [])
          .filter((o) => has(query, o.a.name, o.b.name, ...o.concepts))
          .map((o) => ({
            key: `overlap:${o.a.id}:${o.b.id}`,
            title: `${o.a.name} and ${o.b.name}`,
            sub: `Both touch ${o.concepts.join(', ')}`,
            where: projectLabel(id),
            preview: () =>
              html`<div class="sp-herald"><h3>Overlapping work</h3><p><b>${o.a.name}</b> and <b>${o.b.name}</b> both touch:</p><ul>${o.concepts.map((c) => html`<li key=${c}><code>${c}</code></li>`)}</ul></div>`,
            open: () => inWorkspace(() => selectThread(o.a.id)),
          })),
      ),
      ...watch
        .filter(({ t, stage }) => has(query, threadName(t), stage))
        .map(({ t, stage }) => ({
          key: `watch:${t.threadId}`,
          title: `${threadName(t)} · ${stage}`,
          sub: 'On the Watchtower',
          where: projectLabel(t.meta?.projectId),
          preview: () =>
            html`<div class="sp-herald"><h3>${threadName(t)}</h3><p>Watchtower stage: <b>${stage}</b></p><p class="sp-dim">${projectLabel(t.meta?.projectId)}</p></div>`,
          open: () => inWorkspace(() => selectThread(t.threadId)),
        })),
    ];
    groups.push({
      title: 'Heralds',
      items: ranked(heraldHits, query),
      empty: html`Nothing matches. <${ComingSoon} inline what="Teammates’ work, with the Heralds." ticket="AGENT-001" />`,
    });

    const threadHits = allThreads.value
      .filter((t) => inScope(t.meta?.projectId) && has(query, threadName(t), t.meta?.description))
      .map((t) => ({
        key: `thread:${t.threadId}`,
        title: threadName(t),
        sub: t.meta?.description && t.meta.description !== threadName(t) ? t.meta.description : '',
        where: projectLabel(t.meta?.projectId),
        preview: () =>
          html`<div class="sp-thread"><h3>${threadName(t)}</h3><p>${t.meta?.description ?? ''}</p><p class="sp-dim">${projectLabel(t.meta?.projectId)} · ${t.meta?.status ?? ''}</p></div>`,
        open: () => inWorkspace(() => selectThread(t.threadId)),
      }));
    groups.push({
      title: 'Threads',
      items: ranked(threadHits, query),
      empty: 'No thread matches.',
    });

    const messageHits = archive.hits.map((a) => {
      const text = snippet(a.chunks?.[0]?.text ?? '', query) || a.title;
      const thread =
        a.source === 'foundry' && allThreads.value.find((t) => t.threadId === a.sessionId);
      return {
        key: `message:${a.archiveId}`,
        title: text,
        sub: [
          text === a.title ? null : a.title,
          a.source ?? [...new Set((a.models ?? []).map((m) => m.model))].join(', '),
        ]
          .filter(Boolean)
          .join(' · '),
        where: a.projectId ? projectLabel(a.projectId) : '',
        preview: () =>
          html`<div class="sp-message"><h3>${a.title}</h3><pre>${(a.chunks ?? []).map((c) => c.text).join('\n\n…\n\n')}</pre></div>`,
        open: thread ? () => inWorkspace(() => selectThread(thread.threadId)) : null,
      };
    });
    groups.push({
      title: 'Messages',
      items: messageHits,
      empty:
        query.length < 2
          ? 'Type two letters to search the Archive.'
          : archive.state === 'loading'
            ? 'Searching the Archive…'
            : archive.state === 'error'
              ? `The Archive couldn’t be searched: ${archive.error}.`
              : 'No message matches.',
    });

    const referenceHits = allThreads.value
      .filter((t) => inScope(t.meta?.projectId))
      .flatMap((t) => (t.meta?.context?.references ?? []).map((r) => ({ r, t })))
      .filter(({ r, t }) => has(query, r.ref, r.integration, threadName(t)))
      .map(({ r, t }) => ({
        key: `ref:${t.threadId}:${r.integration}:${r.ref}`,
        title: r.ref,
        sub: `${r.integration} · ${threadName(t)}`,
        where: projectLabel(t.meta?.projectId),
        preview: () =>
          html`<div class="sp-ref"><h3>${r.ref}</h3><p>${r.integration}, linked from <b>${threadName(t)}</b></p>${r.url ? html`<p class="sp-pointer">${r.url}</p>` : null}</div>`,
        open: r.url
          ? () => window.open(r.url, '_blank', 'noopener')
          : () => inWorkspace(() => selectThread(t.threadId)),
      }));
    groups.push({
      title: 'PRs and tickets',
      items: ranked(referenceHits, query),
      empty: 'No linked PR or ticket matches.',
    });

    const feedbackHits = feedbackItems.value
      .filter((f) => inScope(f.projectId) && has(query, f.statement, f.quote))
      .map((f) => ({
        key: `feedback:${f.id}`,
        title: f.statement,
        sub: `${f.inbox} · ${f.status}`,
        where: projectLabel(f.projectId),
        preview: () =>
          html`<div class="sp-feedback"><h3>Feedback</h3><p>${f.statement}</p>${f.quote ? html`<blockquote>${f.quote}</blockquote>` : null}<p class="sp-dim">${f.inbox} · ${f.status}</p></div>`,
        open: () => inWorkspace(() => openFeedbackSource(f)),
      }));
    groups.push({
      title: 'Feedback',
      items: ranked(feedbackHits, query),
      empty: 'No feedback matches.',
    });
    groups.push({
      title: 'People',
      items: [],
      empty: html`<${ComingSoon}
        inline
        what="People: teammates and what each is working on, through Kingdom and the Heralds."
        ticket="AGENT-001" />`,
    });
  }

  // The rows on screen, in order: ↑↓ walks them.
  const visible = groups.flatMap((g) =>
    expanded.has(g.title) ? g.items : g.items.slice(0, SHOWN),
  );
  const current = visible[Math.min(at, visible.length - 1)] ?? null;
  const open = (item) => item?.open?.();
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (reading) setReading(null);
      else closeSearch();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setAt((n) => Math.min(n + 1, Math.max(visible.length - 1, 0)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setAt((n) => Math.max(n - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      open(current);
    }
  };

  return html`<main class="search-page" aria-label="Search">
    <header class="search-head">
      <h2>Search</h2>
      <span class="search-meta">Settings, docs, Atlas and Heralds first; then threads, messages, PRs and tickets, feedback and people</span>
    </header>
    <input ref=${input} class="search-input" type="search" placeholder="Search everything…" autocomplete="off"
      aria-label="Search everything" value=${raw} onInput=${(e) => setRaw(e.target.value)} onKeyDown=${onKey} />
    <div class="search-scope" role="group" aria-label="Scope">
      <button type="button" aria-pressed=${scope === 'all'} onClick=${() => setScope('all')}>Everywhere</button>
      ${live.map((p) => html`<button key=${p.id} type="button" aria-pressed=${scope === p.id} onClick=${() => setScope(p.id)}>${p.label}</button>`)}
    </div>
    ${
      reading
        ? html`<article class="search-reading" aria-label=${reading.title}>
            <button type="button" class="proj-btn" onClick=${() => setReading(null)}>‹ Results</button>
            <h3>${reading.title}</h3><p class="sp-pointer">${reading.pointer}</p><pre>${reading.text}</pre>
          </article>`
        : html`<div class="search-columns">
            <div class="search-results">
              ${
                query
                  ? groups.map((g) => {
                      const shown = expanded.has(g.title) ? g.items : g.items.slice(0, SHOWN);
                      return html`<section key=${g.title} class="search-group" aria-label=${g.title}>
                        <h4>${g.title}${g.items.length ? ` · ${g.items.length}` : ''}</h4>
                        ${
                          shown.length
                            ? shown.map((item) => {
                                const on = item === current;
                                return html`<div key=${item.key} class="search-hit ${on ? 'is-current' : ''} ${item.open ? '' : 'is-static'}" role="option" aria-selected=${on}
                                  onMouseEnter=${() => setAt(visible.indexOf(item))} onClick=${() => open(item)}>
                                  <b><${Marked} text=${item.title} query=${query} /></b>
                                  ${item.sub ? html`<small><${Marked} text=${item.sub} query=${query} /></small>` : null}
                                  <i>${item.badge ? html`<span class="search-source" data-source=${item.badge}>${item.badge}</span> ` : null}${item.where}</i>
                                </div>`;
                              })
                            : html`<p class="search-empty">${g.empty}</p>`
                        }
                        ${
                          g.items.length > SHOWN
                            ? html`<button type="button" class="search-more" onClick=${() => {
                                const next = new Set(expanded);
                                next.has(g.title) ? next.delete(g.title) : next.add(g.title);
                                setExpanded(next);
                              }}>${expanded.has(g.title) ? 'Show fewer' : `Show all ${g.items.length}`}</button>`
                            : null
                        }
                      </section>`;
                    })
                  : html`<p class="search-empty">Type to search Foundry’s settings, the projects’ docs and Atlas, what others are working on, and your threads.</p>`
              }
            </div>
            <aside class="search-preview" aria-label="Preview">
              ${current ? current.preview() : html`<p class="search-empty">The highlighted result shows here. ↑↓ to move, Enter to open, Esc to go back.</p>`}
              ${current?.open ? html`<button type="button" class="proj-btn is-go" onClick=${() => open(current)}>Open ↵</button>` : null}
            </aside>
          </div>`
    }
  </main>`;
}
