/**
 * @atlas
 * @kind component
 * @partOf feature:viewer
 */
/**
 * A forked thread's provenance in its header: "forked from <source> · turn N", a link that opens the
 * source thread at that turn. A fork is a top-level thread, not nested under its source
 * (`meta.forkedFrom`; `GET /api/threads/:id/forked-from` names the source and the turn).
 */

import { html, useEffect, useState } from './lib.js';
import { authFetch, focusTurnId, selectThread } from './store.js';

export function ForkLink({ threadId, forkedFrom }) {
  const [origin, setOrigin] = useState(null);
  const key = forkedFrom ? `${forkedFrom.threadId}:${forkedFrom.journalSeq}` : '';
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-read when the thread or its source changes.
  useEffect(() => {
    setOrigin(null);
    if (!forkedFrom) return;
    let live = true;
    authFetch(`/api/threads/${encodeURIComponent(threadId)}/forked-from`)
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => live && setOrigin(body))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [threadId, key]);
  if (!forkedFrom) return null;
  const title = origin?.title ?? forkedFrom.threadId;
  const open = () => {
    focusTurnId.value = origin?.turnId ?? null;
    selectThread(forkedFrom.threadId);
  };
  return html`<button type="button" class="band-pill fork-link" title=${`Forked from ${title}${origin?.turn ? `, turn ${origin.turn}` : ''}: open it there`}
    onClick=${open}>forked from <b>${title}</b>${origin?.turn ? ` · turn ${origin.turn}` : ''}</button>`;
}
