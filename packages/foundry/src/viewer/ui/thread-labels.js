/**
 * Thread name and work context, shared by the thread list, header, drawer and graph.
 * The server resolves which name is in effect (`title`: a person's name, else the agent's).
 */
import { html } from './lib.js';

export const threadName = (t) => t?.title?.text || t?.meta?.description || t?.threadId || '';

export const nameSourceLabel = {
  human: 'named by you',
  agent: 'named by agent',
  description: 'creation description',
};

/** Branch and worktree as observed in the thread's cwd, falling back to the assignment. */
export function threadPlace(meta = {}) {
  const context = meta.context || {};
  const worktree = context.worktree || meta.cwd || null;
  return {
    branch: context.branch || meta.branch || null,
    repository: context.repository || null,
    worktree,
    worktreeShort: worktree ? worktree.split('/').slice(-2).join('/') : null,
  };
}

const refLabel = (r) => (r.integration === 'github' ? `#${r.ref.split('#')[1] ?? r.ref}` : r.ref);
const refTitle = (r) =>
  `${r.integration === 'github' ? 'GitHub' : r.integration === 'linear' ? 'Linear' : r.integration}: ${r.ref}`;

/** Linked PRs and tickets as chips that link out when the reference has a URL. */
export function ReferenceChips({ meta, cls = 'context-bar-chip' }) {
  const refs = meta?.context?.references || [];
  return refs.map((r) =>
    r.url
      ? html`<a key=${r.integration + r.ref} class="${cls} thread-ref thread-ref--${r.integration}" href=${r.url} target="_blank" rel="noopener noreferrer"
        title=${refTitle(r)} onClick=${(e) => e.stopPropagation()}>${refLabel(r)}</a>`
      : html`<span key=${r.integration + r.ref} class="${cls} thread-ref thread-ref--${r.integration}" title=${refTitle(r)}>${refLabel(r)}</span>`,
  );
}
