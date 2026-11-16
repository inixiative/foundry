/**
 * @atlas
 * @kind component
 * @partOf feature:secrets, feature:viewer
 */
/**
 * Settings → Keychain: the secrets Foundry keeps past a thread, in this machine's own keychain.
 * Names and holders only: a value goes in from here or from a thread's scratch pad and never comes back.
 */

import { html, useEffect, useState } from './lib.js';
import { authFetch, showToast } from './store.js';

const HOLDER_HELP =
  'foundry: every agent in Foundry may use it by name. provider:<id>, mcp:<id>, memory:<id>, integration:<id>: only that connector reads it (a provider reads the entry named after its key, ANTHROPIC_API_KEY).';

async function call(method, path, body) {
  const res = await authFetch(path, {
    method,
    ...(body
      ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
      : {}),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Error(json.error || `HTTP ${res.status}`);
  return json;
}

const when = (at) => new Date(at).toLocaleString();

function EntryRow({ entry, onChanged }) {
  const [draft, setDraft] = useState(null);
  const holder = draft ?? entry.holder;
  const regrant = async () => {
    try {
      await call('POST', `/api/keychain/${encodeURIComponent(entry.name)}/holder`, { holder });
      showToast(`${entry.name} is held by ${holder}`, 'ok');
      await onChanged();
      setDraft(null);
    } catch (error) {
      showToast(error.message, 'error');
    }
  };
  const remove = async () => {
    if (!confirm(`Remove ${entry.name} from the keychain? Anything that uses it stops working.`))
      return;
    try {
      await call('DELETE', `/api/keychain/${encodeURIComponent(entry.name)}`);
      onChanged();
    } catch (error) {
      showToast(error.message, 'error');
    }
  };
  return html`<tr data-keychain-entry=${entry.name}>
    <td class="mono">${entry.name}</td>
    <td>
      <input class="settings-input small mono" aria-label=${`Holder of ${entry.name}`} value=${holder}
        onInput=${(e) => setDraft(e.target.value.trim())} />
      ${holder !== entry.holder ? html`<button class="action-btn small" onClick=${regrant}>Save</button>` : null}
    </td>
    <td>${entry.from === 'pad' ? 'scratch pad' : entry.from === 'api' ? 'settings' : entry.from}</td>
    <td>${when(entry.updatedAt)}</td>
    <td><button class="action-btn small danger" onClick=${remove}>Remove</button></td>
  </tr>`;
}

function AddEntry({ onAdded }) {
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [holder, setHolder] = useState('foundry');
  const add = async (event) => {
    event.preventDefault();
    try {
      await call('PUT', `/api/keychain/${encodeURIComponent(name)}`, { value, holder });
      setName('');
      setValue('');
      showToast(`${name} is in the keychain`, 'ok');
      onAdded();
    } catch (error) {
      showToast(error.message, 'error');
    }
  };
  return html`<form class="keychain-add" onSubmit=${add}>
    <input class="settings-input small mono" placeholder="name" aria-label="Name" value=${name}
      onInput=${(e) => setName(e.target.value.trim())} />
    <input class="settings-input small" type="password" autocomplete="off" placeholder="value"
      aria-label="Value" value=${value} onInput=${(e) => setValue(e.target.value)} />
    <input class="settings-input small mono" aria-label="Holder" value=${holder}
      onInput=${(e) => setHolder(e.target.value.trim())} />
    <button class="action-btn" type="submit" disabled=${!name || !value || !holder}>Add</button>
  </form>`;
}

export function KeychainSection() {
  const [entries, setEntries] = useState(null);
  const load = () =>
    call('GET', '/api/keychain')
      .then((body) => setEntries(body.entries))
      .catch((error) => {
        setEntries([]);
        showToast(`Keychain unavailable: ${error.message}`, 'error');
      });
  useEffect(() => {
    load();
  }, []);
  return html`
    <section class="settings-card" data-settings="keychain">
      <div class="settings-card-header"><span class="settings-card-title">Keychain</span></div>
      <p class="settings-desc">Secrets Foundry keeps past a thread, in this machine's own keychain. An agent moves a
        scratch-pad secret here with <code>secret_scratch</code> <code>keep</code>, and uses one by name; a value is
        never shown again. Entries are used only in a turn your own message or one of your schedules opened.</p>
      <p class="settings-desc">${HOLDER_HELP}</p>
      ${
        entries === null
          ? html`<p class="settings-desc">Loading…</p>`
          : entries.length
            ? html`<table class="settings-table keychain-table">
                <thead><tr><th>Name</th><th>Held by</th><th>From</th><th>Updated</th><th></th></tr></thead>
                <tbody>${entries.map((entry) => html`<${EntryRow} key=${entry.name} entry=${entry} onChanged=${load} />`)}</tbody>
              </table>`
            : html`<p class="settings-desc">Nothing in the keychain yet.</p>`
      }
    </section>
    <section class="settings-card">
      <div class="settings-card-header"><span class="settings-card-title">Add a secret</span></div>
      <${AddEntry} onAdded=${load} />
    </section>
  `;
}
