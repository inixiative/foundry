import { html, signal, useState, useEffect, useRef } from "./lib.js";
import { authFetch } from "./store.js";
import { BookOpen, X, RotateCw } from "https://esm.sh/lucide-preact@0.468.0?deps=preact@10.25.4";

export const glossProject = signal(null);
const modes = [["margin", "Side column"], ["hover", "Hover"], ["inline", "Inline"]];

async function request(projectId, endpoint, options = {}) {
  const response = await authFetch(`/api/projects/${encodeURIComponent(projectId)}/gloss/${endpoint}`, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Gloss request failed (${response.status})`);
  return data;
}

const json = (method, body) => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

const descriptions = {
  install: "Add @inixiative/gloss@0.0.4 as a development dependency. This changes package.json, the lockfile and node_modules. Lifecycle scripts will not run.",
  setup: "Create .gloss/README.md and add or update the Gloss block in CLAUDE.md. Existing source comments will not move.",
  harvest: "Move harvestable comments from TypeScript source into .gloss/ and insert markers. Inline why: comments and machine directives stay in source. Review the resulting diff before committing. Stop editors and agents that are modifying these files first.",
  fix: "Repair renamed symbols, moved sidecars and header paths using Gloss. Review the resulting diff before committing. Stop editors and agents that are modifying these files first.",
};

export function GlossSettings({ projectId, onSaved }) {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState(null);
  const [result, setResult] = useState(null);
  const mounted = useRef(true);
  const load = async () => {
    const next = await request(projectId, "status");
    if (mounted.current) setStatus(next);
  };
  useEffect(() => {
    mounted.current = true;
    document.documentElement.classList.add("gloss-settings-open");
    load().catch(e => { if (mounted.current) setError(e.message); });
    return () => { mounted.current = false; document.documentElement.classList.remove("gloss-settings-open"); };
  }, [projectId]);
  const run = async task => {
    setBusy(true); setError("");
    try { await task(); }
    catch (e) { if (mounted.current) setError(e.message); }
    finally { if (mounted.current) setBusy(false); }
  };
  const save = settings => {
    const previous = status;
    setStatus({ ...status, settings });
    return run(async () => {
      try {
        await request(projectId, "settings", json("PUT", settings));
        await load();
        onSaved?.();
      } catch (error) {
        if (mounted.current) setStatus(previous);
        throw error;
      }
    });
  };
  const operate = action => run(async () => {
    setPending(null); setResult(null);
    const next = await request(projectId, "actions", json("POST", { action, confirmed: true }));
    if (mounted.current) setResult(next);
    await load();
  });
  return html`<section class="gloss-settings" aria-label="Gloss settings">
    <h2>Gloss</h2>
    ${error && html`<div class="gloss-error" role="alert">${error}</div>`}
    ${!status ? html`<button onClick=${() => run(load)} disabled=${busy}>${error ? "Retry" : "Loading..."}</button>` : html`
      <label class="gloss-toggle"><input type="checkbox" checked=${status.settings.enabled} disabled=${busy || status.busy}
        onChange=${e => save({ ...status.settings, enabled: e.target.checked })} />Enable Gloss maintenance</label>
      <dl class="gloss-status"><dt>Project dependency</dt><dd>${status.declaredVersion || "Not declared"}</dd>
        <dt>Foundry adapter</dt><dd>${status.adapterVersion}</dd><dt>Margin directory</dt><dd>${status.initialized ? "Present" : "Not initialized"}</dd>
        <dt>Maintenance</dt><dd>${status.busy ? "Running" : status.settings.enabled ? "Manual" : "Disabled"}</dd></dl>
      <label class="gloss-field">Default display<select value=${status.settings.display} disabled=${busy}
        onChange=${e => save({ ...status.settings, display: e.target.value })}>
        ${modes.map(([value, label]) => html`<option value=${value}>${label}</option>`)}</select></label>
      <div class="gloss-actions">
        <button onClick=${() => { glossProject.value = projectId; }}><${BookOpen} size=${16} />Open glosses</button>
        <button disabled=${busy || status.busy} onClick=${() => operate("check")}>Check bindings</button>
        ${Object.keys(descriptions).map(action => html`<button disabled=${busy || status.busy || !status.settings.enabled}
          onClick=${() => setPending(action)}>${{ install: "Install dependency", setup: "Set up / update", harvest: "Harvest comments", fix: "Repair bindings" }[action]}</button>`)}
      </div>
      ${pending && html`<div class="gloss-confirm" role="alertdialog" aria-label="Confirm Gloss changes">
        <p>${descriptions[pending]}</p><div class="gloss-actions">
          <button disabled=${busy} onClick=${() => operate(pending)}>Confirm ${pending}</button>
          <button disabled=${busy} onClick=${() => setPending(null)}>Cancel</button>
        </div></div>`}
      ${busy && html`<p role="status">Running Gloss operation...</p>`}
      ${result && html`<pre class="gloss-result" aria-label="Gloss result">${JSON.stringify(result, null, 2)}</pre>`}
    `}
  </section>`;
}

function Freshness({ projectId, file, symbol, snapshot }) {
  const [state, setState] = useState(null);
  useEffect(() => {
    let live = true;
    setState(null);
    const query = `file=${encodeURIComponent(file)}&snapshot=${encodeURIComponent(snapshot)}${symbol === undefined ? "" : `&symbol=${encodeURIComponent(symbol)}`}`;
    request(projectId, `detail?${query}`).then(data => { if (live) setState(data); })
      .catch(e => { if (live) setState({ error: e.message }); });
    return () => { live = false; };
  }, [projectId, file, symbol, snapshot]);
  if (!state) return html`<div class="gloss-freshness">Checking history...</div>`;
  if (state.error) return html`<div class="gloss-freshness">History unavailable: ${state.error}</div>`;
  const freshness = state.freshness;
  return html`<div class="gloss-freshness">
    <span>${freshness.reliable ? `Written ${freshness.writtenAt.slice(0, 10)}; symbol changed ${freshness.sourceChangesSince} times since` :
      `Freshness unavailable: ${freshness.reason}`}</span>
    ${state.dirty !== false && html`<strong>${state.dirty === true ? "Uncommitted changes; history excludes these edits" : "Working-tree status unavailable"}</strong>`}
  </div>`;
}

function Note({ note, projectId, file, snapshot }) {
  const [history, setHistory] = useState(null);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);
  const showHistory = async () => {
    setBusy(true);
    try {
      const query = `file=${encodeURIComponent(file)}&snapshot=${encodeURIComponent(snapshot)}${note.symbol === undefined ? "" : `&symbol=${encodeURIComponent(note.symbol)}`}`;
      const data = await request(projectId, `history?${query}`);
      if (mounted.current) setHistory(data.history || "No recorded history");
    } catch (e) { if (mounted.current) setHistory(e.message); }
    finally { if (mounted.current) setBusy(false); }
  };
  return html`<section class="gloss-note" aria-label=${`Gloss for ${note.symbol ?? "file"}`}>
    <h3>${note.symbol ?? "File overview"}</h3>
    <span class="gloss-advisory">Advisory commentary</span>
    <${Freshness} projectId=${projectId} file=${file} symbol=${note.symbol} snapshot=${snapshot} />
    <pre class="gloss-prose">${note.body}</pre>
    <button disabled=${busy} onClick=${showHistory}>${busy ? "Loading history..." : "View history"}</button>
    ${history !== null && html`<details open><summary>History</summary><pre class="gloss-history">${history}</pre></details>`}
  </section>`;
}

function Review({ projectId, onClose }) {
  const [files, setFiles] = useState([]);
  const [file, setFile] = useState("");
  const [input, setInput] = useState("");
  const [data, setData] = useState(null);
  const [mode, setMode] = useState("margin");
  const [selected, setSelected] = useState(null);
  const [hovered, setHovered] = useState(null);
  const [pinned, setPinned] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const panel = useRef(null);
  const lineRefs = useRef(new Map());
  useEffect(() => {
    const previous = document.activeElement;
    document.documentElement.classList.add("gloss-review-open");
    panel.current?.focus();
    let live = true;
    request(projectId, "status").then(s => { if (live) setMode(s.settings.display); }).catch(() => {});
    request(projectId, "list").then(d => {
      if (!live) return;
      setFiles(d.files); setFile(d.files[0] || ""); setInput(d.files[0] || ""); setLoading(false);
    }).catch(e => { if (live) { setError(e.message); setLoading(false); } });
    return () => { live = false; document.documentElement.classList.remove("gloss-review-open"); previous?.focus(); };
  }, [projectId]);
  useEffect(() => {
    if (!file) return;
    let live = true;
    setLoading(true); setData(null); setError(""); setSelected(null); setHovered(null); setPinned(false);
    request(projectId, `read?file=${encodeURIComponent(file)}`).then(d => {
      if (!live) return;
      setData(d); setSelected(d.doc.preamble ? "@file" : d.doc.sections[0]?.symbol ?? null); setLoading(false);
    }).catch(e => { if (live) { setError(e.message); setLoading(false); } });
    return () => { live = false; };
  }, [projectId, file, revision]);
  const notes = data ? [
    ...(data.doc.preamble ? [{ key: "@file", body: data.doc.preamble, line: 1 }] : []),
    ...data.doc.sections.map(section => ({ key: section.symbol, ...section,
      line: data.symbols.find(s => s.name === section.symbol)?.markerLine ?? data.symbols.find(s => s.name === section.symbol)?.startLine })),
  ] : [];
  const active = notes.find(n => n.key === selected);
  const byLine = new Map(notes.filter(n => n.line).map(n => [n.line, n]));
  const choose = key => {
    setSelected(key);
    setPinned(true);
    const note = notes.find(n => n.key === key);
    if (note?.line) lineRefs.current.get(note.line)?.scrollIntoView({ block: "center" });
  };
  const onKeyDown = event => {
    event.stopPropagation();
    if (event.key === "Escape") { event.stopPropagation(); onClose(); }
    if (event.key !== "Tab") return;
    const controls = [...panel.current.querySelectorAll('button:not(:disabled), input, select, summary, [tabindex="0"]')];
    const first = controls[0], last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  };
  return html`<div class="gloss-review" role="dialog" aria-modal="true" aria-label="Gloss code review"
    ref=${panel} tabIndex="-1" onKeyDown=${onKeyDown}>
    <header class="gloss-toolbar"><${BookOpen} size=${18} /><h2>Gloss</h2><span class="gloss-revision">Working tree</span>
      <button class="gloss-icon" aria-label="Refresh source" title="Refresh source" onClick=${() => setRevision(r => r + 1)}><${RotateCw} size=${16} /></button>
      <button class="gloss-icon" aria-label="Close Gloss" title="Close Gloss" onClick=${onClose}><${X} size=${18} /></button></header>
    <div class="gloss-controls"><form onSubmit=${e => { e.preventDefault(); setFile(input.trim()); setRevision(r => r + 1); }}>
      <label for="gloss-file">Source file</label><input id="gloss-file" list="gloss-files" value=${input}
        placeholder="src/example.ts" onInput=${e => setInput(e.target.value)} /><datalist id="gloss-files">
        ${files.map(f => html`<option value=${f} />`)}</datalist><button type="submit">Open</button></form>
      <label>Display<select aria-label="Display" value=${mode} onChange=${e => { setMode(e.target.value); setPinned(false); }}>
        ${modes.map(([value, label]) => html`<option value=${value}>${label}</option>`)}</select></label>
      <label>Section<select aria-label="Section" value=${selected ?? ""} onChange=${e => choose(e.target.value)} disabled=${!notes.length}>
        ${!notes.length && html`<option value="">No glosses</option>`}
        ${notes.map(n => html`<option value=${n.key}>${n.symbol ?? "File overview"}${!n.line ? " (unbound)" : ""}</option>`)}</select></label>
    </div>
    ${error && html`<div class="gloss-error" role="alert">${error}</div>`}
    ${loading ? html`<div class="gloss-empty" role="status">Loading...</div>` : !data ? html`<div class="gloss-empty">${file ? "Source unavailable" : "No glossed files"}</div>` : html`
      ${(data.pathMismatch || data.errors.length > 0) && html`<div class="gloss-error">Binding errors detected. ${data.pathMismatch ? "Sidecar path does not match source." : ""}
        ${data.errors.map(e => html`<div>${e.line}: ${e.message}</div>`)}</div>`}
      <div class="gloss-code-layout" data-mode=${mode} data-single=${(mode === "inline" && !!active?.line) || (mode === "hover" && !pinned) ? "true" : "false"}>
        <div class="gloss-code" aria-label="Source code" tabIndex="0">
          ${data.source.split("\n").map((line, i) => {
            const n = byLine.get(i + 1);
            return html`<div key=${i} class="gloss-line-block" ref=${el => el ? lineRefs.current.set(i + 1, el) : lineRefs.current.delete(i + 1)}>
              <div class=${`gloss-code-line ${n?.key === selected ? "gloss-selected" : ""}`}>
                <span class="gloss-line-number">${i + 1}</span><span class="gloss-marker-slot">
                ${n && html`<button class="gloss-marker" aria-label=${`Show gloss for ${n.symbol ?? "file"}`}
                  aria-expanded=${selected === n.key} title=${`Gloss: ${n.symbol ?? "File overview"}`}
                  onMouseEnter=${() => setHovered(n.key)} onMouseLeave=${() => setHovered(null)}
                  onFocus=${() => setHovered(n.key)} onBlur=${() => setHovered(null)}
                  onClick=${() => { setSelected(n.key); setPinned(true); }}><${BookOpen} size=${14} /></button>`}</span><code>${line || " "}</code>
              </div>
              ${mode === "hover" && n && hovered === n.key && html`<div class="gloss-hover" role="tooltip"><strong>${n.symbol ?? "File overview"}</strong><pre>${n.body}</pre></div>`}
              ${mode === "inline" && n && selected === n.key && html`<${Note} key=${`${file}:${n.key}`} note=${n} projectId=${projectId} file=${file} snapshot=${data.snapshot} />`}
            </div>`;
          })}
        </div>
        ${(mode === "margin" || (mode === "hover" && pinned) || (mode === "inline" && !active?.line)) && html`<aside class="gloss-margin" aria-label="Gloss margin">
          ${active ? html`<${Note} key=${`${file}:${active.key}`} note=${active} projectId=${projectId} file=${file} snapshot=${data.snapshot} />` : html`<div class="gloss-empty">No commentary for this file</div>`}
        </aside>`}
      </div>
    `}
  </div>`;
}

export function GlossReview() {
  const projectId = glossProject.value;
  return projectId ? html`<${Review} key=${projectId} projectId=${projectId} onClose=${() => { glossProject.value = null; }} />` : null;
}

export function GlossButton({ projectId }) {
  return html`<button class="gloss-launch" disabled=${!projectId} onClick=${() => { glossProject.value = projectId; }} title="Open project glosses">
    <${BookOpen} size=${16} />Gloss</button>`;
}
