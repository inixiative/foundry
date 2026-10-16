/**
 * Navigation column — the workspace's left column.
 *
 * Top: the pinned scopes, Global (threads no project owns) and Forge Master (the internal
 * thread about this Foundry). Then the projects, and below them the threads of whichever
 * scope is selected; the two lists scroll independently. Collapsed: a thin strip with
 * project dots.
 */

import { html, useEffect, useRef, useState } from './lib.js';
import { Modal } from './modal.js';
import {
  activeProjectId,
  authFetch,
  compactPanel,
  createProject,
  forgeMasterOpen,
  projectSidebarOpen,
  projects,
  projectTags,
  showToast,
  updateProject,
} from './store.js';
import { ThreadList } from './thread-tree.js';

const STATUS_COLORS = {
  active: '#4ade80',
  idle: '#6c9eff',
  archived: '#555',
};

/** Focus (and select) an input once its modal opens. */
function useAutofocus() {
  const ref = useRef(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select?.();
  }, []);
  return ref;
}

// ---------------------------------------------------------------------------
// Add Project modal
// ---------------------------------------------------------------------------

function AddProjectModal({ onDone }) {
  const pathInput = useAutofocus();
  const [path, setPath] = useState('');
  const [label, setLabel] = useState('');
  const [browsing, setBrowsing] = useState(false);
  const [browseDir, setBrowseDir] = useState(null);
  const [browseDirs, setBrowseDirs] = useState([]);
  const [browseParent, setBrowseParent] = useState(null);
  const [browseIsRepo, setBrowseIsRepo] = useState(false);
  const [browseName, setBrowseName] = useState('');

  const browse = async (dir) => {
    try {
      const url = dir ? `/api/browse?path=${encodeURIComponent(dir)}` : '/api/browse';
      const res = await authFetch(url);
      if (!res.ok) return;
      const data = await res.json();
      setBrowseDir(data.current);
      setBrowseDirs(data.dirs || []);
      setBrowseParent(data.parent);
      setBrowseIsRepo(data.isRepo || false);
      setBrowseName(data.name || '');
    } catch {
      showToast('Failed to browse directory', 'error');
    }
  };

  const openBrowser = () => {
    setBrowsing(true);
    browse(path || null);
  };

  const selectDir = () => {
    setPath(browseDir);
    if (!label) setLabel(browseName);
    setBrowsing(false);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!path.trim()) {
      showToast('Path is required', 'error');
      return;
    }
    const ok = await createProject({
      path: path.trim(),
      label: label.trim() || undefined,
    });
    if (ok) onDone();
  };

  return html`
    <${Modal} title="Add project" onClose=${onDone} class="proj-modal">
    <form class="proj-add-form" onSubmit=${handleSubmit}>
      <label class="proj-field-label" for="proj-add-path">Path</label>
      <div class="proj-path-row">
        <input id="proj-add-path" ref=${pathInput} class="proj-input proj-path-input" placeholder="/path/to/repo" value=${path}
          onInput=${(e) => setPath(e.target.value)} />
        <button type="button" class="proj-btn proj-browse-btn" onClick=${openBrowser}
          title="Browse folders">...</button>
      </div>

      ${
        browsing
          ? html`
        <div class="proj-browser">
          <div class="proj-browser-path" title=${browseDir}>${browseDir}</div>
          <div class="proj-browser-list">
            ${
              browseParent
                ? html`
              <div class="proj-browser-item proj-browser-parent" onClick=${() => browse(browseParent)}>
                ${'..'}
              </div>
            `
                : null
            }
            ${browseDirs.map(
              (d) => html`
              <div key=${d} class="proj-browser-item" onClick=${() => browse(browseDir + '/' + d)}>
                ${d}${'/'}
              </div>
            `,
            )}
            ${
              browseDirs.length === 0
                ? html`
              <div class="proj-browser-empty">No subdirectories</div>
            `
                : null
            }
          </div>
          <div class="proj-browser-actions">
            ${browseIsRepo ? html`<span class="proj-browser-repo">repo detected</span>` : null}
            <button type="button" class="proj-btn proj-btn-ok" onClick=${selectDir}>Select</button>
            <button type="button" class="proj-btn" onClick=${() => setBrowsing(false)}>Cancel</button>
          </div>
        </div>
      `
          : null
      }

      <label class="proj-field-label" for="proj-add-label">Label</label>
      <input id="proj-add-label" class="proj-input" placeholder="optional" value=${label}
        onInput=${(e) => setLabel(e.target.value)} />
      <div class="proj-form-actions">
        <button type="button" class="proj-btn" onClick=${onDone}>Cancel</button>
        <button type="submit" class="proj-btn proj-btn-ok">Add</button>
      </div>
    </form>
    <//>
  `;
}

// ---------------------------------------------------------------------------
// Rename Project modal
// ---------------------------------------------------------------------------

function RenameProjectModal({ project, onDone }) {
  const input = useAutofocus();
  const [label, setLabel] = useState(project.label || '');
  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!label.trim()) {
      showToast('Label is required', 'error');
      return;
    }
    if (await updateProject(project.id, { label: label.trim() })) onDone();
  };
  return html`
    <${Modal} title="Rename project" onClose=${onDone} class="proj-modal">
      <form class="proj-add-form" onSubmit=${handleSubmit}>
        <label class="proj-field-label" for="proj-rename-label">Label</label>
        <input id="proj-rename-label" ref=${input} class="proj-input" value=${label}
          onInput=${(e) => setLabel(e.target.value)} />
        <div class="proj-form-actions">
          <button type="button" class="proj-btn" onClick=${onDone}>Cancel</button>
          <button type="submit" class="proj-btn proj-btn-ok">Rename</button>
        </div>
      </form>
    <//>
  `;
}

// ---------------------------------------------------------------------------
// Project item (expanded view)
// ---------------------------------------------------------------------------

function ProjectItem({ project, isActive, onSelect, onRename }) {
  const statusColor = STATUS_COLORS[project.status] || '#555';
  const archived = project.status === 'archived';
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => {
    if (!menuOpen) return;
    const close = () => setMenuOpen(false);
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [menuOpen]);
  const act = (e, action) => {
    e.stopPropagation();
    setMenuOpen(false);
    action();
  };

  return html`
    <div
      class="proj-item ${isActive ? 'proj-active' : ''} ${archived ? 'proj-archived' : ''}"
      onClick=${() => onSelect(project.id)}
      title=${project.path}
    >
      <div class="proj-item-body">
        <div class="proj-item-label">${project.label}</div>
        <div class="proj-item-meta">
          <span class="proj-status-dot" style="background: ${statusColor}"></span>
          <span>${archived ? 'archived · ' : ''}${project.threadCount || 0} threads</span>
          ${(project.tags || []).map((t) => html`<span class="proj-tag" key=${t}>${t}</span>`)}
        </div>
      </div>
      <button
        type="button"
        class="proj-menu-btn ${menuOpen ? 'open' : ''}"
        aria-label="Project actions"
        aria-haspopup="menu"
        aria-expanded=${menuOpen}
        onClick=${(e) => {
          e.stopPropagation();
          setMenuOpen(!menuOpen);
        }}
      >⋯</button>
      ${
        menuOpen
          ? html`
        <div class="proj-menu" role="menu" onClick=${(e) => e.stopPropagation()}>
          <button type="button" role="menuitem" onClick=${(e) => act(e, () => onRename(project))}>Rename</button>
          <button type="button" role="menuitem" onClick=${(e) =>
            act(e, () => updateProject(project.id, { status: archived ? 'active' : 'archived' }))}>
            ${archived ? 'Unarchive' : 'Archive'}
          </button>
        </div>
      `
          : null
      }
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Collapsed strip — just icons
// ---------------------------------------------------------------------------

function CollapsedStrip({ onExpand }) {
  const items = projects.value.filter((p) => p.status !== 'archived');
  const active = activeProjectId.value;

  return html`
    <div class="proj-collapsed" onClick=${onExpand} title="Expand projects">
      <div class="proj-collapsed-icon">P</div>
      <div class="proj-collapsed-dots">
        ${items.map(
          (p) => html`
          <span
            key=${p.id}
            class="proj-collapsed-dot ${p.id === active ? 'active' : ''}"
            style="background: ${STATUS_COLORS[p.status] || '#555'}"
            title=${p.label}
          ></span>
        `,
        )}
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// ProjectSidebar (exported)
// ---------------------------------------------------------------------------

export function ProjectSidebar() {
  const isOpen = projectSidebarOpen.value;
  const all = projects.value;
  const tags = projectTags.value;
  const active = activeProjectId.value;
  const [adding, setAdding] = useState(false);
  const [renaming, setRenaming] = useState(null);
  const [filterTag, setFilterTag] = useState(null);
  const [showArchived, setShowArchived] = useState(false);
  const [listOpen, setListOpen] = useState(true);
  const archivedCount = all.filter((p) => p.status === 'archived').length;
  // Archived projects are hidden until asked for; the active one stays visible.
  const items = showArchived ? all : all.filter((p) => p.status !== 'archived' || p.id === active);

  if (!isOpen) {
    return html`<${CollapsedStrip} onExpand=${() => {
      projectSidebarOpen.value = true;
    }} />`;
  }

  const filtered = filterTag ? items.filter((p) => (p.tags || []).includes(filterTag)) : items;

  const forge = forgeMasterOpen.value;
  const handleSelect = (id) => {
    forgeMasterOpen.value = false;
    activeProjectId.value = id;
  };

  return html`
    <div class="proj-sidebar nav-column">
      <!-- Pinned scopes. A future pinned item (Feedback) joins these. -->
      <div class="proj-defaults nav-pinned">
        <div
          class="proj-item proj-global ${!active && !forge ? 'proj-active' : ''}"
          onClick=${() => {
            forgeMasterOpen.value = false;
            activeProjectId.value = null;
          }}
        >
          <span class="proj-runtime-icon">*</span>
          <div class="proj-item-body">
            <div class="proj-item-label">Global</div>
            <div class="proj-item-meta"><span>threads outside any project</span></div>
          </div>
        </div>
        <div
          class="proj-item proj-global ${forge ? 'proj-active' : ''}"
          onClick=${() => {
            forgeMasterOpen.value = true;
            compactPanel.value = 'conversation';
          }}
        >
          <span class="proj-runtime-icon">\u2692</span>
          <div class="proj-item-body">
            <div class="proj-item-label">Forge Master</div>
            <div class="proj-item-meta"><span>this Foundry and its settings</span></div>
          </div>
        </div>
      </div>

      <section class="nav-projects ${listOpen ? '' : 'nav-projects--collapsed'}" aria-label="Projects">
        <div class="proj-sidebar-header">
          <button type="button" class="nav-section-toggle" aria-expanded=${listOpen}
            title=${listOpen ? 'Collapse projects' : 'Expand projects'} onClick=${() => setListOpen(!listOpen)}>
            <span class="sidebar-caret">${listOpen ? '\u25BC' : '\u25B6'}</span>
            <span class="proj-sidebar-title">PROJECTS</span>
            <span class="proj-sidebar-count">${items.length}</span>
          </button>
          <button class="sidebar-add-btn" onClick=${() => setAdding(true)} title="Add project">+</button>
          <button class="proj-collapse-btn" onClick=${() => {
            projectSidebarOpen.value = false;
          }}
            title="Collapse">\u2039</button>
        </div>

        ${
          listOpen && tags.length > 0
            ? html`
          <div class="proj-tags-bar">
            <span
              class="proj-filter-chip ${!filterTag ? 'active' : ''}"
              onClick=${() => setFilterTag(null)}
            >all</span>
            ${tags.map(
              (t) => html`
              <span
                key=${t}
                class="proj-filter-chip ${filterTag === t ? 'active' : ''}"
                onClick=${() => setFilterTag(filterTag === t ? null : t)}
              >${t}</span>
            `,
            )}
          </div>
        `
            : null
        }

        ${
          listOpen
            ? html`
        <div class="proj-list">
          ${filtered.map(
            (p) => html`
            <${ProjectItem}
              key=${p.id}
              project=${p}
              isActive=${!forge && active === p.id}
              onSelect=${handleSelect}
              onRename=${setRenaming}
            />
          `,
          )}
          ${
            filtered.length === 0 && items.length > 0
              ? html`<div class="proj-empty">No projects match "${filterTag}"</div>`
              : null
          }
          ${all.length === 0 ? html`<div class="proj-empty">No projects yet</div>` : null}
          ${
            archivedCount > 0
              ? html`
            <button type="button" class="proj-archived-toggle" onClick=${() => setShowArchived(!showArchived)}>
              ${showArchived ? 'Hide archived' : `Show archived (${archivedCount})`}
            </button>
          `
              : null
          }
        </div>
      `
            : null
        }
      </section>

      <div class="nav-threads" id="workspace-threads">
        <${ThreadList} />
      </div>

      ${adding ? html`<${AddProjectModal} onDone=${() => setAdding(false)} />` : null}
      ${renaming ? html`<${RenameProjectModal} project=${renaming} onDone=${() => setRenaming(null)} />` : null}
    </div>
  `;
}
