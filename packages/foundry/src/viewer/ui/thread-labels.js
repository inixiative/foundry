/**
 * @atlas
 * @kind component
 * @partOf feature:threads, feature:viewer
 */
/**
 * Thread name and work context, shared by the thread list, header, drawer and graph.
 * The server resolves which name is in effect (`title`: a person's name, else the agent's).
 */
import { html } from './lib.js';
import { projects } from './store.js';

/** A thread nothing has named yet: no person's or agent's name and no creation description. */
export const isUnnamed = (t) => !t?.title?.text && !t?.meta?.description;

const createdLabel = (t) => {
  const created = t?.meta?.createdAt;
  return Number.isFinite(created)
    ? `New thread · ${new Date(created).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}`
    : 'New thread';
};

/** The thread's name; an unnamed thread reads "New thread · 11:52" (its id belongs in a tooltip). */
export const threadName = (t) => t?.title?.text || t?.meta?.description || createdLabel(t);

export const nameSourceLabel = {
  human: 'named by you',
  foundry: 'named by Foundry from your message',
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

/** "Claude Code" / "Codex" from a provider id; null for anything else (never a raw id). */
export function harnessName(provider) {
  if (!provider) return null;
  if (/codex/i.test(provider)) return 'Codex';
  if (/claude|anthropic/i.test(provider)) return 'Claude Code';
  return null;
}

/**
 * The Kingdom a project's work belongs to, for filters and lanes. Foundry records no Kingdom link per
 * project yet, so its first organisation tag stands in, else "This Foundry".
 */
export const projectKingdom = (projectId) =>
  projects.value.find((p) => p.id === projectId)?.tags?.[0] ?? 'This Foundry';

/** A project's label by id; Global for none. */
export function projectLabel(projectId) {
  if (!projectId) return 'Global';
  return projects.value.find((p) => p.id === projectId)?.label || projectId;
}
