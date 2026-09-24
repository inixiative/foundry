import { html, useState, useEffect } from "./lib.js";

export function KingdomSettings() {
  const [url, setUrl] = useState("http://localhost:8000");
  const [name, setName] = useState("My Foundry");
  const [state, setState] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const call = async (action, body) => {
    const response = await fetch(`/api/kingdom/${action}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
    const value = await response.json();
    if (!response.ok) throw Error(value.error || "Connection failed");
    setState(value);
    return value;
  };
  useEffect(() => {
    fetch("/api/kingdom/status").then(r => { if (!r.ok) throw Error("Unable to read Kingdom connection"); return r.json(); }).then(setState).catch(e => setError(e.message));
  }, []);
  useEffect(() => {
    if (state?.status !== "pending") return;
    const timer = setInterval(() => { call("poll").then(() => setError("")).catch(e => setError(e.message)); }, 5000);
    return () => clearInterval(timer);
  }, [state?.status]);
  const act = async (action, body) => {
    setBusy(true); setError("");
    try { await call(action, body); if (action === "pair") setReplacing(false); } catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  return html`<section class="settings-card kingdom-connection">
    <h2 class="settings-card-title">Kingdom connection</h2>
    <p class="settings-desc">Connect this Foundry to your Kingdom. Sign in there, compare the pairing code, and approve the runtime. Your credential stays on this machine.</p>
    ${error && html`<p role="alert">${error}</p>`}
    ${!state ? html`<p>Loading connection…</p>` : (state.status === "connected" || state.status === "unavailable") && !replacing ? html`
      <p>${state.status === "connected" ? "Connected to" : "Authorization unavailable at"} ${state.url}</p><p>Runtime: <code>${state.installationId}</code></p>
      <button class="action-btn" onClick=${() => { setUrl(state.url); setReplacing(true); }}>Reconnect with Kingdom approval</button>
      <button class="action-btn subtle" disabled=${busy} onClick=${() => act("disconnect")}>Disconnect this Foundry</button>
      <p class="settings-desc">Disconnecting deletes this machine’s Kingdom credential and unlocks Foundry locally. Revoke the runtime in Kingdom’s Foundry tab too. Manage expiry and revocation there; provider subscriptions and viewer access have separate permissions.</p>
    ` : state.status === "pending" ? html`
      <p>Pairing code: <strong>${state.userCode}</strong></p>
      <p>Expires ${new Date(state.expiresAt).toLocaleTimeString()}</p>
      <a class="action-btn" href=${state.verificationUrl} target="_blank" rel="noopener noreferrer">Log in to Kingdom and approve</a>
      <p class="settings-desc">Or enter this code in Kingdom → Foundry. Only approve a request you started here. Waiting for approval…</p>
      <button class="action-btn subtle" disabled=${busy} onClick=${() => act("cancel")}>Cancel pairing</button>
      <p class="settings-desc">If already approved in Kingdom, revoke that runtime there before starting again.</p>
    ` : html`
      <label class="settings-label" for="kingdom-api-url">Kingdom API address</label>
      <input id="kingdom-api-url" class="settings-input" value=${url} onInput=${e => setUrl(e.target.value)} placeholder="https://api.your-kingdom.example" />
      <label class="settings-label" for="kingdom-runtime-name">Foundry name</label>
      <input id="kingdom-runtime-name" class="settings-input" value=${name} maxlength="120" onInput=${e => setName(e.target.value)} />
      <button class="action-btn" disabled=${busy || !name.trim() || !url} onClick=${() => act("pair", { url, name })}>${busy ? "Connecting…" : "Connect to Kingdom"}</button>
      ${replacing && html`<button class="action-btn subtle" disabled=${busy} onClick=${() => setReplacing(false)}>Cancel</button>`}
    `}
  </section>`;
}
