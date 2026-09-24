import { html, useEffect, useRef, useState } from "./lib.js";
import { authFetch } from "./store.js";
import { FilePicker } from "./file-picker.js";

async function request(path, method = "GET", body) {
  const response = await authFetch(`/api/access/sources${path}`, { method, cache: "no-store",
    ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
  const value = await response.json();
  if (!response.ok) throw Error(value.error || "Access settings are unavailable.");
  return value;
}
const emptyGrant = projectId => ({ id: crypto.randomUUID(), name: "", url: "", credentialFile: "", connectionId: "", signetId: "", projectIds: projectId ? [projectId] : [] });

export function AccessSettings({ projectId, onSaved }) {
  const [data, setData] = useState(null), [draft, setDraft] = useState(null);
  const [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false), [checking, setChecking] = useState(null), [result, setResult] = useState(null);
  const [picker, setPicker] = useState(false), [removeId, setRemoveId] = useState(null);
  const generation = useRef(0);
  const load = async () => {
    const own = ++generation.current;
    setResult(null); setError("");
    try { const next = await request(""); if (generation.current === own) setData(next); }
    catch (error) { if (generation.current === own) setError(error.message); }
  };
  useEffect(() => { setData(null); setDraft(null); setRemoveId(null); load(); return () => { generation.current++; }; }, [projectId]);
  const edit = source => {
    setError(""); setNotice(""); setResult(null); setRemoveId(null);
    const { credentialStatus, ...fields } = source;
    setDraft({ ...fields, projectIds: [...fields.projectIds], threadText: (fields.threadIds || []).join("\n") });
  };
  const update = (key, value) => setDraft(current => ({ ...current, [key]: value }));
  const save = async event => {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const { threadText, threadIds, ...fields } = draft;
      const threads = (threadText || "").split(/[\n,]/).map(value => value.trim()).filter(Boolean);
      await request(`/${draft.id}`, "PUT", { revision: data.revision, source: { ...fields, ...(threads.length ? { threadIds: [...new Set(threads)] } : {}) } });
      setDraft(null); setNotice("Grant saved. Restart this Foundry instance to apply the change."); await load(); await onSaved?.();
    } catch (error) { setError(error.message); }
    finally { setBusy(false); }
  };
  const remove = async id => {
    setBusy(true); setError("");
    try {
      await request(`/${id}`, "DELETE", { revision: data.revision });
      setRemoveId(null); setDraft(null); setNotice("Grant removed from saved settings. Restart to apply. Revoke it in Kastle to block subsequent requests immediately.");
      await load(); await onSaved?.();
    } catch (error) { setError(error.message); }
    finally { setBusy(false); }
  };
  const check = async id => {
    const own = generation.current; setChecking(id); setError(""); setResult(null);
    try { const checked = await request(`/${id}/check`, "POST"); if (own === generation.current) setResult({ id, ...checked }); }
    catch (error) { if (own === generation.current) setError(error.message); }
    finally { setChecking(null); }
  };
  const sources = (data?.sources || []).filter(source => !projectId || source.projectIds.includes(projectId));
  const disabled = busy || !!checking;
  return html`<section class="access-settings" aria-label="Kastle integrations">
    <div class="settings-card">
      <div class="settings-card-header"><h2 class="settings-card-title">Integrations</h2><span class="settings-card-kind">Kastle access</span></div>
      <p class="settings-desc">Give your agents access to selected resources through Kastle. Provider credentials stay in Kastle; this instance uses revocable access tokens.</p>
      <p class="settings-desc">Grant changes apply after a restart. Use Kastle revocation to block new requests immediately. Inference capacity is configured separately.</p>
      <div class="settings-card-actions">
        <button class="action-btn" disabled=${!data || disabled || !!draft} onClick=${() => edit(emptyGrant(projectId))}>Add grant</button>
        <button class="action-btn" disabled=${disabled} onClick=${() => { setDraft(null); setRemoveId(null); load(); }}>Reload saved settings</button>
      </div>
    </div>
    ${error && html`<p class="access-error" role="alert">${error}</p>`}
    ${notice && html`<p class="access-notice" role="status">${notice}</p>`}
    ${!data && !error && html`<p role="status">Loading integration settings…</p>`}
    ${data && !sources.length && !draft && html`<div class="settings-empty">No integration grants ${projectId ? "for this project" : "configured"}. Add a grant using a connection and Signet from Kastle.</div>`}
    ${draft && html`<form class="settings-card access-editor" onSubmit=${save}>
      <h3>${data.sources.some(source => source.id === draft.id) ? "Edit grant" : "New grant"}</h3>
      <fieldset disabled=${disabled}>
        <label class="settings-field">Name<input class="settings-input" required maxlength="120" value=${draft.name} onInput=${event => update("name", event.target.value)} /></label>
        <label class="settings-field">Kastle origin<input class="settings-input mono" required type="url" placeholder="https://kastle.example" value=${draft.url} onInput=${event => update("url", event.target.value)} /></label>
        <div class="settings-row">
          <label class="settings-field">Connection ID<input class="settings-input mono" required value=${draft.connectionId} onInput=${event => update("connectionId", event.target.value.trim())} /></label>
          <label class="settings-field">Signet ID<input class="settings-input mono" required value=${draft.signetId} onInput=${event => update("signetId", event.target.value.trim())} /></label>
        </div>
        <label class="settings-field">Kastle token file<input class="settings-input mono" required placeholder="/private/path/access.json" value=${draft.credentialFile} onInput=${event => update("credentialFile", event.target.value)} /></label>
        <button type="button" class="action-btn" onClick=${() => setPicker(true)}>Choose file</button>
        <p class="settings-desc">Select a private file on the Foundry host containing your Kastle token. The file must be owned by the current user and accessible only to that user. Its contents are not sent to this browser.</p>
        <fieldset class="access-projects"><legend>Allowed projects · choose at least one</legend>
          ${data.projects.filter(project => project.enabled).map(project => html`<label key=${project.id}><input type="checkbox" checked=${draft.projectIds.includes(project.id)} onChange=${event => update("projectIds", event.target.checked ? [...draft.projectIds, project.id] : draft.projectIds.filter(id => id !== project.id))} /> ${project.name}</label>`)}
          ${!data.projects.some(project => project.enabled) && html`<p>Add an enabled project before saving a grant.</p>`}
        </fieldset>
        <details><summary>Limit to specific tasks</summary><label class="settings-field">Task IDs, one per line<textarea class="settings-input mono" rows="3" value=${draft.threadText || ""} onInput=${event => update("threadText", event.target.value)} /></label><p class="settings-desc">Leave empty to allow tasks in the selected projects. This does not expand the server grant.</p></details>
        <div class="settings-card-actions"><button type="submit" class="action-btn" disabled=${!draft.projectIds.length}>${busy ? "Saving…" : "Save grant"}</button><button type="button" class="action-btn" onClick=${() => setDraft(null)}>Cancel</button></div>
      </fieldset>
    </form>`}
    ${sources.map(source => html`<article key=${source.id} class="settings-card access-grant">
      <div class="settings-card-header"><h3 class="settings-card-title">${source.name}</h3><span class=${`access-badge ${source.credentialStatus === "available" ? "" : "needs-attention"}`}>${source.credentialStatus === "available" ? "Kastle token file available" : "Kastle token file needs attention"}</span></div>
      <p class="settings-desc">${source.url}</p>
      <dl class="access-details"><dt>Connection</dt><dd>${source.connectionId}</dd><dt>Signet</dt><dd>${source.signetId}</dd><dt>Projects</dt><dd>${source.projectIds.map(id => data.projects.find(project => project.id === id)?.name || id).join(", ")}</dd><dt>Task scope</dt><dd>${source.threadIds ? `${source.threadIds.length} selected tasks` : "All tasks in allowed projects"}</dd></dl>
      <p class="settings-desc">Local file status does not confirm server access. Check access to verify the saved grant and list its resources.</p>
      <div class="settings-card-actions"><button class="action-btn" disabled=${disabled || !!draft} onClick=${() => check(source.id)}>${checking === source.id ? "Checking…" : "Check access"}</button><button class="action-btn" disabled=${disabled || !!draft} onClick=${() => edit(source)}>Edit</button><button class="action-btn" disabled=${disabled || !!draft} onClick=${() => setRemoveId(source.id)}>Remove</button></div>
      ${removeId === source.id && html`<div class="access-notice"><p>Remove this local grant? This takes effect after restart and does not revoke its token in Kastle.</p><button class="action-btn" disabled=${disabled} onClick=${() => remove(source.id)}>Remove grant</button> <button class="action-btn" disabled=${disabled} onClick=${() => setRemoveId(null)}>Keep grant</button></div>`}
      ${result?.id === source.id && html`<div class="access-check" role="status">
        <h4>${result.status === "available" ? "Kastle access verified" : result.status === "needs-authentication" ? "Authentication required" : "Access unavailable"}</h4>
        <p class="settings-desc">Checked ${new Date(result.checkedAt).toLocaleString()}. Authorization can change before the next request.</p>
        ${result.message && html`<p>${result.message}</p>`}
        ${result.description && html`<p>${result.description.remainingRequests} requests remaining on this Signet · Access expires ${new Date(result.description.expiresAt).toLocaleString()}</p>
          ${!result.description.operations.length && html`<p>No read operations are currently available. Check resource and credential permissions in Kastle.</p>`}
          ${result.description.operations.map(operation => html`<details key=${operation.key}><summary>${operation.name} · ${operation.resources.length} resources</summary><code>${operation.key}</code><ul>${operation.resources.map(resource => html`<li key=${resource.id}><strong>${resource.name}</strong> <span>(${resource.kind})</span><code class="access-resource-id">${resource.id}</code></li>`)}</ul></details>`)}
        `}
      </div>`}
    </article>`)}
    <${FilePicker} open=${picker} startPath=${draft?.credentialFile ? draft.credentialFile.slice(0, draft.credentialFile.lastIndexOf("/")) || "/" : null} mode="file" onCancel=${() => setPicker(false)} onPick=${path => { update("credentialFile", path); setPicker(false); }} />
  </section>`;
}
