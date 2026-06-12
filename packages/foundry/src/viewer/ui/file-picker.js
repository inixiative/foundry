/**
 * Shared file/directory picker modal.
 *
 * Usage:
 *   <${FilePicker}
 *     open=${isOpen}
 *     startPath=${somePath}
 *     mode="file"                // "file" | "dir"
 *     onCancel=${() => setOpen(false)}
 *     onPick=${(abs) => ...}
 *   />
 */

import { html, useState, useEffect } from "./lib.js";
import { showToast } from "./store.js";

export function FilePicker({ open, startPath, mode = "file", onCancel, onPick }) {
  const [current, setCurrent] = useState(null);
  const [parent, setParent] = useState(null);
  const [dirs, setDirs] = useState([]);
  const [files, setFiles] = useState([]);

  const load = async (path) => {
    const includeFiles = mode === "file" ? "&files=1" : "";
    const url = path
      ? `/api/browse?path=${encodeURIComponent(path)}${includeFiles}`
      : `/api/browse?_=1${includeFiles}`;
    try {
      const res = await fetch(url);
      const data = await res.json();
      if (data.error) {
        showToast(data.error, "error");
        return;
      }
      setCurrent(data.current);
      setParent(data.parent);
      setDirs(data.dirs || []);
      setFiles(data.files || []);
    } catch {
      showToast("Failed to browse", "error");
    }
  };

  useEffect(() => {
    if (open) load(startPath || null);
  }, [open, startPath]);

  if (!open) return null;

  const pickHere = () => {
    if (mode === "dir" && current) onPick(current);
  };

  const pickFile = (name) => {
    if (mode === "file" && current) onPick(`${current}/${name}`);
  };

  return html`
    <div class="file-picker-overlay" onClick=${(e) => {
      if (e.target.classList.contains("file-picker-overlay")) onCancel?.();
    }}>
      <div class="file-picker-panel" role="dialog" aria-label="File picker">
        <div class="file-picker-header">
          <span class="file-picker-title">
            ${mode === "dir" ? "Pick a directory" : "Pick a file"}
          </span>
          <button class="fullscreen-close" onClick=${onCancel} aria-label="Close">\u00d7</button>
        </div>
        <div class="file-picker-path" title=${current}>${current ?? "..."}</div>
        <div class="file-picker-list">
          ${parent ? html`
            <div class="file-picker-item parent" onClick=${() => load(parent)}>
              <span class="icon">\u2191</span>
              <span>..</span>
            </div>
          ` : null}
          ${dirs.map((d) => html`
            <div key=${d} class="file-picker-item dir" onClick=${() => load(`${current}/${d}`)}>
              <span class="icon">\u{1F4C1}</span>
              <span>${d}/</span>
            </div>
          `)}
          ${mode === "file" ? files.map((f) => html`
            <div key=${f} class="file-picker-item file" onClick=${() => pickFile(f)}>
              <span class="icon">\u00B7</span>
              <span>${f}</span>
            </div>
          `) : null}
          ${dirs.length === 0 && files.length === 0 && !parent ? html`
            <div class="file-picker-item">(empty)</div>
          ` : null}
        </div>
        <div class="file-picker-footer">
          ${mode === "dir" ? html`
            <button class="action-btn" onClick=${pickHere} disabled=${!current}>
              Use this directory
            </button>
          ` : null}
          <button class="action-btn" onClick=${onCancel}>Cancel</button>
        </div>
      </div>
    </div>
  `;
}
