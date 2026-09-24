import { html, useState, useEffect } from "./lib.js";
import { authFetch, activeProjectId } from "./store.js";

export function LocalDevicePanel({ projectIds }) {
  const [inventory, setInventory] = useState(null);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const refresh = async () => {
    const response = await authFetch("/api/devices");
    if (!response.ok) throw Error("Device inventory is unavailable");
    setInventory(await response.json());
    setError("");
  };
  useEffect(() => { refresh().catch(() => setError("Device inventory is unavailable")); }, [projectIds]);
  const enroll = async event => {
    event.preventDefault();
    setBusy(true);
    try {
      const response = await authFetch("/api/devices/local", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }),
      });
      if (!response.ok) throw Error();
      await refresh();
    } catch { setError("Device enrollment could not be completed"); }
    finally { setBusy(false); }
  };
  return html`<div class="proj-add-form">
    <strong>DEVICES</strong>
    ${error ? html`<div role="alert">${error}</div>` : null}
    ${inventory?.device ? html`
      <div>${inventory.device.name} · this machine</div>
      <div>${inventory.checkouts.length} registered projects</div>
      ${inventory.checkouts.map(checkout => html`<button key=${checkout.id} class="proj-btn"
        title=${checkout.path} onClick=${() => { activeProjectId.value = checkout.projectId; }}>
        ${checkout.label}
      </button>`)}
      <div class="proj-empty">Local inventory. Other devices are not connected yet.</div>
    ` : inventory ? html`<form onSubmit=${enroll}>
      <label>Device name<input class="proj-input" value=${name} maxLength="120" required
        onInput=${event => setName(event.target.value)} placeholder="My Mac" /></label>
      <button class="proj-btn" type="submit" disabled=${busy || !name.trim()}>${busy ? "Registering…" : "Register this device"}</button>
    </form>` : html`<div class="proj-empty">Loading device inventory…</div>`}
  </div>`;
}
