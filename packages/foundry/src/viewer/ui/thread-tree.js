/**
 * @atlas
 * @kind component
 * @partOf feature:threadTree, feature:viewer
 */
/**
 * Thread list — the lower half of the navigation column: the threads of the selected scope
 * (a project, Global, or Forge Master's one thread), each with its status, branch and references.
 */

import { FeedbackStrip, feedbackIn } from './feedback.js';
import { html, useLayoutEffect, useRef, useState } from './lib.js';
import { DeviceBadge } from './machine-icons.js';
import { RenameModal } from './modal.js';
import {
  isSnoozed,
  snooze,
  snoozeCondition,
  snoozedUntil,
  snoozeUntilQuotaReset,
  tomorrowMorning,
  unsnooze,
} from './snooze.js';
import { isDangerous, StatusIcon } from './status-icons.js';
import {
  activePanel,
  activeProjectId,
  activeThreadId,
  allThreads,
  createThread,
  executeAction,
  feedbackInboxOpen,
  forgeMasterOpen,
  projects,
  promptCounts,
  prompts,
  railExpanded,
  renameThread,
  selectScope,
  selectThread,
  worktrees,
} from './store.js';
import {
  harnessName,
  isUnnamed,
  nameSourceLabel,
  projectLabel,
  threadName,
  threadPlace,
} from './thread-labels.js';
import {
  CLOSED_STATUSES,
  categoryOf,
  statusText,
  subagentParentOf,
  threadState,
} from './thread-status.js';

// ---------------------------------------------------------------------------
// Active/inactive classification
// ---------------------------------------------------------------------------

function isActiveThread(t) {
  return !CLOSED_STATUSES.has(t.status);
}

// ---------------------------------------------------------------------------
// Inactive fold — "N inactive" / "N uninstantiated"
// ---------------------------------------------------------------------------

function InactiveFold({ count, label, defaultOpen = false, children }) {
  const [open, setOpen] = useState(defaultOpen);
  if (count === 0) return null;

  return html`
    <div class="inactive-fold">
      <div class="inactive-fold-header" onClick=${() => setOpen(!open)}>
        <span class="inactive-caret">${open ? '▼' : '▶'}</span>
        <span class="inactive-label">${count} ${label}</span>
      </div>
      ${open ? html`<div class="inactive-fold-body">${children}</div>` : null}
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Thread actions — overflow menu per thread (mirrors MessageActions)
// ---------------------------------------------------------------------------

function ThreadActions({ thread }) {
  const [open, setOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [at, setAt] = useState(null);
  const trigger = useRef(null);
  // Fixed to the viewport beside the ⋯ button, so the list's scroll frame never clips the menu.
  useLayoutEffect(() => {
    if (!open) return;
    const r = trigger.current?.getBoundingClientRect();
    if (r)
      setAt({
        left: Math.max(8, Math.min(window.innerWidth - 248, r.right - 240)),
        top: Math.min(window.innerHeight - 320, r.bottom + 2),
      });
  }, [open]);
  const toggle = (e) => {
    e.stopPropagation();
    setOpen((v) => !v);
  };
  const run = (kind) => (e) => {
    e.stopPropagation();
    setOpen(false);
    executeAction(kind, thread.id);
  };
  const local = (fn) => (e) => {
    e.stopPropagation();
    setOpen(false);
    fn();
  };

  const status = thread.status || 'idle';
  const canPause = status === 'active' || status === 'idle';
  const canResume = status === 'waiting';
  const isArchived = CLOSED_STATUSES.has(status);

  return html`
    <div class="thread-actions ${open ? 'thread-actions-open' : ''}">
      <button ref=${trigger} class="thread-action-btn thread-action-trigger" onClick=${toggle}
        title="Thread actions" aria-haspopup="menu" aria-expanded=${open}>⋯</button>
      ${
        open
          ? html`<div class="thread-action-menu" role="menu" style=${at ? `position:fixed;left:${at.left}px;top:${at.top}px;right:auto;min-width:240px` : ''} onClick=${(e) => e.stopPropagation()}>
        ${canPause ? html`<button role="menuitem" onClick=${run('thread:pause')}>Pause</button>` : null}
        ${canResume ? html`<button role="menuitem" onClick=${run('thread:resume')}>Resume</button>` : null}
        ${!isArchived ? html`<button role="menuitem" onClick=${run('thread:archive')}>Archive</button>` : null}
        ${
          isSnoozed(thread.id)
            ? html`<button role="menuitem" onClick=${local(() => unsnooze(thread.id))}>Wake it (snoozed until ${snoozeCondition(thread.id) === 'quota-reset' ? 'the quota resets, ' : ''}${new Date(snoozedUntil(thread.id)).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })})</button>`
            : !isArchived
              ? html`<div class="thread-action-group" role="group" aria-label="Snooze">
                  <span class="thread-action-label">Snooze</span>
                  <button role="menuitem" onClick=${local(() => snooze(thread.id, Date.now() + 3_600_000))}>1 hour</button>
                  <button role="menuitem" onClick=${local(() => snooze(thread.id, tomorrowMorning()))}>Until tomorrow</button>
                  <button role="menuitem" onClick=${local(() => snoozeUntilQuotaReset(thread.id))}>Until quota resets</button>
                  <button role="menuitem" disabled title="Foundry doesn't track CI for a thread yet">Until CI finishes · not built</button>
                </div>`
              : null
        }
        <button role="menuitem" onClick=${run('thread:inspect')}>Inspect</button>
        <button role="menuitem" onClick=${(e) => {
          e.stopPropagation();
          setOpen(false);
          setRenaming(true);
        }}>Rename</button>
      </div>`
          : null
      }
      ${
        renaming
          ? html`<${RenameModal} title="Rename thread" label="Thread name" value=${thread.name}
              onClose=${() => setRenaming(false)} onSave=${(next) => renameThread(thread.id, next)} />`
          : null
      }
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Thread node — shows metadata (model, temp, agent count, layers)
// ---------------------------------------------------------------------------

/** Rows for a list of listed threads: children nest under their parent; unread member posts rise. */
export function threadTree(threads) {
  const nodeById = new Map(
    threads.map((t) => [
      t.threadId,
      {
        id: t.threadId,
        status: t.meta?.status || 'idle',
        name: threadName(t),
        unnamed: isUnnamed(t),
        nameSource: t.title?.source || null,
        meta: t.meta || {},
        branch: threadPlace(t.meta).branch,
        cwd: t.meta?.cwd || null,
        parentThreadId: subagentParentOf(t.meta),
        conversation: t.conversation || null,
        lastTurn: t.lastTurn || null,
        permissionMode: t.permissionMode || null,
        children: [],
      },
    ]),
  );
  const roots = [];
  for (const node of nodeById.values()) {
    const parent = node.parentThreadId ? nodeById.get(node.parentThreadId) : null;
    if (parent && parent !== node) parent.children.push(node);
    else roots.push(node);
  }
  // A thread with an unread member post rises to the top (a post revived it).
  roots.sort((a, b) => (b.conversation?.unread ? 1 : 0) - (a.conversation?.unread ? 1 : 0));
  return roots;
}

/** A row's status: its own fields, its pending prompts, and whether a child (a subagent) is working. */
function nodeState(node) {
  const childrenWorking = (node.children || []).some((c) => categoryOf(nodeState(c)) === 'working');
  return threadState(node, {
    prompts: prompts.value.filter((p) => p.threadId === node.id),
    childrenWorking,
  });
}

/** Subagents nest at most this many levels before they fold under "+N subagents". */
const VISIBLE_DEPTH = 1;

const descendants = (node) =>
  (node.children || []).reduce((n, child) => n + 1 + descendants(child), 0);

export function ThreadNode({ thread, depth = 0, selectedId, onSelect, inactive = false }) {
  // Two levels show (a thread and its subagents); deeper subagents fold until asked for.
  const [open, setExpanded] = useState(!inactive && depth < VISIBLE_DEPTH);
  const expanded = open || railExpanded.value.has(thread.id);
  const isSelected = selectedId === thread.id;
  const children = thread.children || [];
  const activeChildren = children.filter(isActiveThread);
  const inactiveChildren = children.filter((c) => !isActiveThread(c));
  const hasChildren = children.length > 0;

  return html`
    <div class="tree-level" style="padding-left: ${depth ? 8 : 0}px">
      <div
        class="tree-node tree-node--two ${isSelected ? 'selected' : ''} ${inactive ? 'dimmed' : ''}"
        onClick=${() => onSelect(thread.id)}
        title=${`${thread.name} · ${projectLabel(thread.meta.projectId)}`}
      >
        <div class="tree-row tree-row--name">
          <span class="tree-label ${thread.unnamed ? 'tree-label--unnamed' : ''}" data-name-source=${thread.nameSource || ''}
            title=${`${thread.id}${thread.nameSource ? ` · ${nameSourceLabel[thread.nameSource]}` : ''}`}>${thread.name}</span>
          <${ThreadActions} thread=${thread} />
        </div>
        <div class="tree-row tree-row--meta">
          <span class="row-project" title=${thread.meta.worker ? `Runs on ${thread.meta.worker}` : null}>${projectLabel(thread.meta.projectId)}${thread.meta.worker ? ` · ${harnessName(thread.meta.worker) ?? thread.meta.worker}` : ''}</span>
          <${StatusIcon} state=${nodeState(thread)} />
          ${statusText(thread, nodeState(thread)) ? html`<span class="row-done" title="Your next message clears it">${statusText(thread, nodeState(thread))}</span>` : null}
          <${DeviceBadge} thread=${thread} />
          ${isDangerous(thread.permissionMode) ? html`<span class="row-dangerous" title="Dangerous: every permission check is skipped">Dangerous</span>` : null}
          ${
            thread.conversation?.unread
              ? html`<span class="row-count conversation-unread-badge" title="${thread.conversation.unread} unread member post${thread.conversation.unread > 1 ? 's' : ''}">${thread.conversation.unread}</span>`
              : null
          }
          ${
            thread.conversation?.paused
              ? html`<span class="row-count conversation-paused-badge" title="Conversation paused">paused</span>`
              : null
          }
          ${(() => {
            const count = (promptCounts.value || {})[thread.id] || 0;
            return count > 0
              ? html`<span class="row-count prompt-badge ${count > 2 ? 'urgent' : ''}" title="${count} pending prompt${count > 1 ? 's' : ''}">${count}</span>`
              : null;
          })()}
          ${
            hasChildren
              ? html`<span class="tree-caret" title=${expanded ? 'Fold subagents' : 'Show subagents'}
                  onClick=${(e) => {
                    e.stopPropagation();
                    if (expanded)
                      railExpanded.value = new Set(
                        [...railExpanded.value].filter((id) => id !== thread.id),
                      );
                    setExpanded(!expanded);
                  }}>${expanded ? '▾' : '▸'}</span>`
              : null
          }
        </div>
      </div>

      ${
        !expanded && hasChildren && depth >= VISIBLE_DEPTH
          ? html`<button class="tree-more" type="button" onClick=${(e) => {
              e.stopPropagation();
              setExpanded(true);
            }}>+${descendants(thread)} subagent${descendants(thread) === 1 ? '' : 's'}</button>`
          : null
      }
      ${
        expanded && hasChildren
          ? html`
        ${activeChildren.map(
          (child) =>
            html`<${ThreadNode}
            key=${child.id} thread=${child} depth=${depth + 1}
            selectedId=${selectedId} onSelect=${onSelect}
          />`,
        )}
        <${InactiveFold} count=${inactiveChildren.length} label="inactive">
          ${inactiveChildren.map(
            (child) =>
              html`<${ThreadNode}
              key=${child.id} thread=${child} depth=${depth + 1}
              selectedId=${selectedId} onSelect=${onSelect} inactive=${true}
            />`,
          )}
        </${InactiveFold}>
      `
          : null
      }
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Collapsible section with optional [+] button
// ---------------------------------------------------------------------------

function AddThreadForm({ onDone }) {
  const [name, setName] = useState('');
  const [selectedWorktree, setSelectedWorktree] = useState('');
  const [saving, setSaving] = useState(false);

  const wts = worktrees.value;

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    const wt = wts.find((w) => w.path === selectedWorktree);
    const result = await createThread({
      name: name.trim() || undefined,
      worktreePath: selectedWorktree || undefined,
      branch: wt?.branch || undefined,
    });
    setSaving(false);
    if (result) onDone();
  };

  return html`
    <form class="thread-add-form" onSubmit=${handleSubmit}>
      <input class="proj-input" placeholder="name (optional)" value=${name}
        onInput=${(e) => setName(e.target.value)} />
      ${
        wts.length > 1
          ? html`
        <select class="proj-input" value=${selectedWorktree}
          onChange=${(e) => setSelectedWorktree(e.target.value)}>
          <option value="">main worktree</option>
          ${wts
            .filter((w) => !w.isMain)
            .map(
              (w) => html`
            <option key=${w.path} value=${w.path}>
              ${w.branch || w.path.split('/').pop()}
            </option>
          `,
            )}
        </select>
      `
          : null
      }
      <div class="proj-form-actions">
        <button type="submit" class="proj-btn proj-btn-ok" disabled=${saving}>
          ${saving ? '...' : 'create'}
        </button>
        <button type="button" class="proj-btn" onClick=${onDone}>cancel</button>
      </div>
    </form>
  `;
}

// Signals for creation mode (consumed by detail-drawer)
/** Forge Master is one persistent thread; it shows here when Forge Master is selected. */
function ForgeMasterThread() {
  return html`
    <div class="tree-node selected" title="Forge Master: the persistent thread about this Foundry">
      <span class="tree-caret-spacer"></span>
      <span class="tree-status-dot" style="background: var(--st-idle)"></span>
      <span class="tree-text"><span class="tree-label">Forge Master</span></span>
    </div>
  `;
}

/** In the Feedback inbox the lower list is feedback by project: where it was given, one click away. */
function FeedbackByProject() {
  const items = feedbackIn();
  const scopes = new Map();
  for (const item of items) {
    const key = item.projectId ?? null;
    const entry = scopes.get(key) ?? { open: 0, total: 0 };
    entry.total++;
    if (item.inbox === 'open') entry.open++;
    scopes.set(key, entry);
  }
  return html`
    <section class="thread-list" aria-label="Feedback by project">
      <div class="sidebar-header">
        <span class="sidebar-section-title">BY PROJECT</span>
        <span class="sidebar-scope-chip scope-global">Feedback</span>
      </div>
      <div class="sidebar-threads-list">
        ${
          scopes.size
            ? [...scopes].map(
                ([
                  projectId,
                  counts,
                ]) => html`<button type="button" key=${projectId ?? '*'} class="feedback-scope-row"
                  onClick=${() => {
                    selectScope(projectId);
                    activePanel.value = 'feedback';
                  }}>
                  <span>${projectId ? projects.value.find((p) => p.id === projectId)?.label || projectId : 'Global'}</span>
                  <span class="feedback-dim">${counts.open} open / ${counts.total}</span>
                </button>`,
              )
            : html`<div class="sidebar-empty">No feedback yet</div>`
        }
      </div>
    </section>
  `;
}

export function ThreadList() {
  const [addingThread, setAddingThread] = useState(false);
  if (feedbackInboxOpen.value) return html`<${FeedbackByProject} />`;
  const forge = forgeMasterOpen.value;
  const selectedThread = activeThreadId.value;
  const activeProject = activeProjectId.value;
  const scopeLabel = forge
    ? 'Forge Master'
    : activeProject
      ? projects.value.find((p) => p.id === activeProject)?.label || activeProject
      : 'Global';

  const threadNodes = threadTree(allThreads.value);

  return html`
    <section class="thread-list" aria-label="Threads">
      <div class="sidebar-header">
        <span class="sidebar-section-title">THREADS</span>
        <span class="sidebar-scope-chip ${activeProject && !forge ? 'scope-project' : 'scope-global'}" title=${scopeLabel}>${scopeLabel}</span>
        ${
          forge
            ? null
            : html`<button class="sidebar-add-btn" onClick=${() => setAddingThread(true)} title="New thread">+</button>`
        }
      </div>

      ${!forge && activeProject ? html`<${FeedbackStrip} projectId=${activeProject} />` : null}
      ${!forge && addingThread ? html`<${AddThreadForm} onDone=${() => setAddingThread(false)} />` : null}

      <div class="sidebar-threads-list">
        ${
          forge
            ? html`<${ForgeMasterThread} />`
            : threadNodes.length > 0
              ? threadNodes.map(
                  (t) => html`
            <${ThreadNode} key=${t.id} thread=${t} selectedId=${selectedThread} onSelect=${selectThread} />
          `,
                )
              : html`<div class="sidebar-empty">${activeProject ? 'No threads in this project' : 'No threads'}</div>`
        }
      </div>
    </section>
  `;
}
