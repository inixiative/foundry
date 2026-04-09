/**
 * Project Sidebar — collapsible left-most panel for project management.
 *
 * Shows registered projects grouped by tags, with selection state.
 * Collapsed: thin strip with project icons. Expanded: full list.
 */

import { html, useState, useEffect } from "./lib.js";
import {
  projects, projectTags, activeProjectId, projectSidebarOpen,
  createProject, deleteProject, showToast, authFetch,
} from "./store.js";

const STATUS_COLORS = {
  active: "#4ade80",
  idle: "#6c9eff",
  archived: "#555",
};

// ---------------------------------------------------------------------------
// Add Project form (inline)
// ---------------------------------------------------------------------------

function AddProjectForm({ onDone }) {
  const [path, setPath] = useState("");
  const [label, setLabel] = useState("");
  const [browsing, setBrowsing] = useState(false);
  const [browseDir, setBrowseDir] = useState(null);
  const [browseDirs, setBrowseDirs] = useState([]);
  const [browseParent, setBrowseParent] = useState(null);
  const [browseIsRepo, setBrowseIsRepo] = useState(false);
  const [browseName, setBrowseName] = useState("");

  const browse = async (dir) => {
    try {
      const url = dir ? `/api/browse?path=${encodeURIComponent(dir)}` : "/api/browse";
      const res = await authFetch(url);
      if (!res.ok) return;
      const data = await res.json();
      setBrowseDir(data.current);
      setBrowseDirs(data.dirs || []);
      setBrowseParent(data.parent);
      setBrowseIsRepo(data.isRepo || false);
      setBrowseName(data.name || "");
    } catch {
      showToast("Failed to browse directory", "error");
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
      showToast("Path is required", "error");
      return;
    }
    const ok = await createProject({
      path: path.trim(),
      label: label.trim() || undefined,
    });
    if (ok) onDone();
  };

  return html`
    <form class="proj-add-form" onSubmit=${handleSubmit}>
      <div class="proj-path-row">
        <input class="proj-input proj-path-input" placeholder="/path/to/repo" value=${path}
          onInput=${(e) => setPath(e.target.value)} />
        <button type="button" class="proj-btn proj-browse-btn" onClick=${openBrowser}
          title="Browse folders">...</button>
      </div>

      ${browsing ? html`
        <div class="proj-browser">
          <div class="proj-browser-path" title=${browseDir}>${browseDir}</div>
          <div class="proj-browser-list">
            ${browseParent ? html`
              <div class="proj-browser-item proj-browser-parent" onClick=${() => browse(browseParent)}>
                ${".."}
              </div>
            ` : null}
            ${browseDirs.map((d) => html`
              <div key=${d} class="proj-browser-item" onClick=${() => browse(browseDir + "/" + d)}>
                ${d}${"/"}
              </div>
            `)}
            ${browseDirs.length === 0 ? html`
              <div class="proj-browser-empty">No subdirectories</div>
            ` : null}
          </div>
          <div class="proj-browser-actions">
            ${browseIsRepo ? html`<span class="proj-browser-repo">repo detected</span>` : null}
            <button type="button" class="proj-btn proj-btn-ok" onClick=${selectDir}>Select</button>
            <button type="button" class="proj-btn" onClick=${() => setBrowsing(false)}>Cancel</button>
          </div>
        </div>
      ` : null}

      <input class="proj-input" placeholder="label (optional)" value=${label}
        onInput=${(e) => setLabel(e.target.value)} />
      <div class="proj-form-actions">
        <button type="submit" class="proj-btn proj-btn-ok">add</button>
        <button type="button" class="proj-btn" onClick=${onDone}>cancel</button>
      </div>
    </form>
  `;
}

// ---------------------------------------------------------------------------
// Project item (expanded view)
// ---------------------------------------------------------------------------

function ProjectItem({ project, isActive, onSelect }) {
  const statusColor = STATUS_COLORS[project.status] || "#555";

  return html`
    <div
      class="proj-item ${isActive ? "proj-active" : ""}"
      onClick=${() => onSelect(project.id)}
      title=${project.path}
    >
      <div class="proj-item-body">
        <div class="proj-item-label">${project.label}</div>
        <div class="proj-item-meta">
          <span class="proj-status-dot" style="background: ${statusColor}"></span>
          <span>${project.threadCount || 0} threads</span>
          ${(project.tags || []).map(
            (t) => html`<span class="proj-tag" key=${t}>${t}</span>`
          )}
        </div>
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Collapsed strip — just icons
// ---------------------------------------------------------------------------

function CollapsedStrip({ onExpand }) {
  const items = projects.value;
  const active = activeProjectId.value;

  return html`
    <div class="proj-collapsed" onClick=${onExpand} title="Expand projects">
      <div class="proj-collapsed-icon">P</div>
      <div class="proj-collapsed-dots">
        ${items.map((p) => html`
          <span
            key=${p.id}
            class="proj-collapsed-dot ${p.id === active ? "active" : ""}"
            style="background: ${STATUS_COLORS[p.status] || "#555"}"
            title=${p.label}
          ></span>
        `)}
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// ProjectSidebar (exported)
// ---------------------------------------------------------------------------

export function ProjectSidebar() {
  const isOpen = projectSidebarOpen.value;
  const items = projects.value;
  const tags = projectTags.value;
  const active = activeProjectId.value;
  const [adding, setAdding] = useState(false);
  const [filterTag, setFilterTag] = useState(null);

  if (!isOpen) {
    return html`<${CollapsedStrip} onExpand=${() => { projectSidebarOpen.value = true; }} />`;
  }

  const filtered = filterTag
    ? items.filter((p) => (p.tags || []).includes(filterTag))
    : items;

  const handleSelect = (id) => {
    activeProjectId.value = active === id ? null : id;
  };

  return html`
    <div class="proj-sidebar">
      <div class="proj-sidebar-header">
        <span class="proj-sidebar-title">PROJECTS</span>
        <span class="proj-sidebar-count">${items.length}</span>
        <button class="sidebar-add-btn" onClick=${() => setAdding(true)} title="Add project">+</button>
        <button class="proj-collapse-btn" onClick=${() => { projectSidebarOpen.value = false; }}
          title="Collapse">‹</button>
      </div>

      <!-- Tag filter chips -->
      ${tags.length > 0 ? html`
        <div class="proj-tags-bar">
          <span
            class="proj-filter-chip ${!filterTag ? "active" : ""}"
            onClick=${() => setFilterTag(null)}
          >all</span>
          ${tags.map((t) => html`
            <span
              key=${t}
              class="proj-filter-chip ${filterTag === t ? "active" : ""}"
              onClick=${() => setFilterTag(filterTag === t ? null : t)}
            >${t}</span>
          `)}
        </div>
      ` : null}

      <!-- Global scope item -->
      <div
        class="proj-item proj-global ${!active ? "proj-active" : ""}"
        onClick=${() => { activeProjectId.value = null; }}
      >
        <span class="proj-runtime-icon">*</span>
        <div class="proj-item-body">
          <div class="proj-item-label">Global</div>
          <div class="proj-item-meta">
            <span>all projects</span>
          </div>
        </div>
      </div>

      <!-- Project list -->
      <div class="proj-list">
        ${filtered.map((p) => html`
          <${ProjectItem}
            key=${p.id}
            project=${p}
            isActive=${active === p.id}
            onSelect=${handleSelect}
          />
        `)}
        ${filtered.length === 0 && items.length > 0 ? html`
          <div class="proj-empty">No projects match "${filterTag}"</div>
        ` : null}
        ${items.length === 0 ? html`
          <div class="proj-empty">No projects yet</div>
        ` : null}
      </div>

      <!-- Add form -->
      ${adding ? html`<${AddProjectForm} onDone=${() => setAdding(false)} />` : null}
    </div>
  `;
}
