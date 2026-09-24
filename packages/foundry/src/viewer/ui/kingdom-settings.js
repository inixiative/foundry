import { html, useState, useEffect } from "./lib.js";

export function KingdomSettings() {
  const [url, setUrl] = useState("http://localhost:8000");
  const [name, setName] = useState("My Foundry");
  const [state, setState] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [replacing, setReplacing] = useState(null);
  const call = async (action, body) => {
    const response = await fetch(`/api/kingdom/${action}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
    const value = await response.json();
    if (!response.ok) throw Error(value.error || "Connection failed");
    setState(value);
    return value;
  };
  useEffect(() => {
    fetch("/api/kingdom/status").then(r => { if (!r.ok) throw Error("Unable to read Kingdom connections"); return r.json(); }).then(setState).catch(e => setError(e.message));
  }, []);
  useEffect(() => {
    if (state?.status !== "pending") return;
    const timer = setInterval(() => { call("poll").then(() => setError("")).catch(e => setError(e.message)); }, 5000);
    return () => clearInterval(timer);
  }, [state?.status]);
  const act = async (action, body) => {
    setBusy(true); setError("");
    try { await call(action, body); if (action === "pair") setReplacing(null); } catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  const runtimes = state?.runtimes ?? [];
  return html`<section class="settings-card kingdom-connection">
    <h2 class="settings-card-title">Kingdom connections</h2>
    <p class="settings-desc">Connect this Foundry to one or more Kingdoms. Sign in there, compare the pairing code, and approve the runtime. Credentials stay on this machine.</p>
    ${error && html`<p role="alert">${error}</p>`}
    ${!state ? html`<p>Loading connections…</p>` : html`
      ${runtimes.map(runtime => html`<div class="kingdom-runtime" key=${`${runtime.url} ${runtime.installationId}`}>
        <p>${runtime.status === "connected" ? "Connected to" : "Authorization unavailable at"} ${runtime.url}</p><p>Runtime: <code>${runtime.installationId}</code></p>
        <button class="action-btn" disabled=${busy || state.status === "pending"} onClick=${() => { setUrl(runtime.url); setReplacing(runtime); }}>Reconnect with Kingdom approval</button>
        <button class="action-btn subtle" disabled=${busy} onClick=${() => act("disconnect", { url: runtime.url, installationId: runtime.installationId })}>Disconnect from this Kingdom</button>
      </div>`)}
      ${runtimes.length > 0 && html`<p class="settings-desc">Disconnecting deletes this machine’s credential for that Kingdom. Revoke the runtime in that Kingdom’s Foundry tab too. Manage expiry and revocation there; provider subscriptions and viewer access have separate permissions.</p>`}
      ${state.status === "pending" ? html`
        <p>Pairing code for ${state.url}: <strong>${state.userCode}</strong></p>
        <p>Expires ${new Date(state.expiresAt).toLocaleTimeString()}</p>
        <a class="action-btn" href=${state.verificationUrl} target="_blank" rel="noopener noreferrer">Log in to Kingdom and approve</a>
        <p class="settings-desc">Or enter this code in Kingdom → Foundry. Only approve a request you started here. Waiting for approval…</p>
        <button class="action-btn subtle" disabled=${busy} onClick=${() => act("cancel")}>Cancel pairing</button>
        <p class="settings-desc">If already approved in Kingdom, revoke that runtime there before starting again.</p>
      ` : html`
        <h3 class="settings-card-title">${replacing ? `Reconnect ${replacing.url}` : runtimes.length ? "Connect another Kingdom" : "Connect to Kingdom"}</h3>
        <label class="settings-label" for="kingdom-api-url">Kingdom API address</label>
        <input id="kingdom-api-url" class="settings-input" value=${url} disabled=${!!replacing} onInput=${e => setUrl(e.target.value)} placeholder="https://api.your-kingdom.example" />
        <label class="settings-label" for="kingdom-runtime-name">Foundry name</label>
        <input id="kingdom-runtime-name" class="settings-input" value=${name} maxlength="120" onInput=${e => setName(e.target.value)} />
        <button class="action-btn" disabled=${busy || !name.trim() || !url} onClick=${() => act("pair", { url, name, ...(replacing ? { replaces: replacing.installationId } : {}) })}>${busy ? "Connecting…" : "Connect to Kingdom"}</button>
        ${replacing && html`<button class="action-btn subtle" disabled=${busy} onClick=${() => setReplacing(null)}>Cancel</button>`}
      `}
    `}
  </section>`;
}
