/**
 * @atlas
 * @kind component
 * @partOf feature:viewer, primitive:settings
 */
/**
 * Settings → Providers: one row per vendor (Anthropic, OpenAI, Google, ...) with its on/off switch.
 * A vendor reaches its models in a subscription mode (a native CLI on the person's own login) and an
 * API mode (an API key); either or both may be on. Expanding a vendor shows each mode's models with
 * "Set as default model" and "Set as decision model".
 */

import { devMode } from './dev-mode.js';
import { html, signal, useEffect, useState } from './lib.js';
import { authFetch, showToast } from './store.js';
import { Switch } from './switch.js';

const registry = signal(null);
const accounts = signal(null);
const selection = signal(null);

const json = async (res) => {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Error(body?.error || 'Request failed');
  return body;
};

function refresh() {
  authFetch('/api/models')
    .then(json)
    .then((body) => {
      registry.value = body;
    })
    .catch(() => {});
  authFetch('/api/providers/accounts?all=1')
    .then(json)
    .then((body) => {
      accounts.value = body;
    })
    .catch(() => {});
  authFetch('/api/models/selection')
    .then(json)
    .then((body) => {
      selection.value = body;
    })
    .catch(() => {});
}

const MODE_LABEL = { subscription: 'Subscription', api: 'API' };

/** What a mode needs, in a few words: available, coming soon, or the missing piece. */
function modeStatus(mode, served, account, apiTokens) {
  if (served.comingSoon)
    return {
      tone: 'soon',
      text: 'Coming soon',
      detail: 'Foundry has no subscription transport for it yet.',
    };
  if (!account) return { tone: 'off', text: 'Unavailable', detail: '' };
  if (mode === 'subscription')
    return account.ready
      ? { tone: 'ok', text: 'Available', detail: `Your login: ${account.detail}` }
      : { tone: 'warn', text: 'Needs attention', detail: account.issue ?? '' };
  if (account.source === 'local')
    return { tone: 'ok', text: 'Local server', detail: account.detail };
  if (!apiTokens)
    return {
      tone: 'warn',
      text: 'Needs API keys on',
      detail: `Turn on API keys above, and set ${account.detail}.`,
    };
  return account.ready
    ? { tone: 'ok', text: 'Key set', detail: account.detail }
    : { tone: 'warn', text: `Needs ${account.detail}`, detail: account.issue ?? '' };
}

const contextWindow = (tokens) =>
  tokens ? (tokens >= 1_000_000 ? `${tokens / 1_000_000}M` : `${Math.round(tokens / 1000)}k`) : '';

/** Set by the page: receives the saved settings after a vendor change. */
let onConfig = () => {};

async function saveVendor(id, patch) {
  try {
    const res = await authFetch('/api/settings/vendors', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [id]: patch }),
    });
    onConfig(await json(res));
    refresh();
  } catch (error) {
    showToast(error.message, 'error');
  }
}

async function choose(kind, provider, model) {
  try {
    const res = await authFetch(`/api/models/${kind}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider, model }),
    });
    selection.value = await json(res);
    showToast(kind === 'default' ? `Default model: ${model}` : `Decision model: ${model}`, 'ok');
  } catch (error) {
    showToast(error.message, 'error');
  }
}

async function setApiTokens(enabled) {
  try {
    const saved = await json(
      await authFetch('/api/settings/apiTokens', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      }),
    );
    onConfig(saved);
    refresh();
  } catch (error) {
    showToast(error.message, 'error');
  }
}

function ModelTable({ provider, models, apiTokens, current }) {
  const isDefault = (m) =>
    current?.default?.provider === provider.id && current.default.model === m.id;
  const isDecision = (m) =>
    current?.decision?.provider === provider.id && current.decision.model === m.id;
  const apiDecision = provider.credential !== 'subscription';
  return html`<table class="settings-table vendor-models">
    <thead><tr><th>Model</th><th>Tier</th><th>Context</th><th></th></tr></thead>
    <tbody>
      ${models.map(
        (m) => html`<tr key=${m.id} class="vendor-model">
          <td>
            <strong>${m.label}</strong> <code>${m.id}</code>
            ${isDefault(m) ? html`<span class="model-badge default">default</span>` : null}
            ${isDecision(m) ? html`<span class="model-badge decision">decision</span>` : null}
            ${m.notes ? html`<div class="settings-desc">${m.notes}</div>` : null}
          </td>
          <td><span class="model-tier tier-${m.tier}">${m.tier}</span></td>
          <td>${contextWindow(m.contextWindow)}</td>
          <td class="vendor-model-actions">
            <button class="action-btn subtle" disabled=${isDefault(m) || !provider.mainThread}
              title=${provider.mainThread ? '' : `${provider.label} cannot run a main thread`}
              onClick=${() => choose('default', provider.id, m.id)}>Set as default model</button>
            <button class="action-btn subtle" disabled=${isDecision(m) || (apiDecision && !apiTokens)}
              title=${apiDecision && !apiTokens ? 'API decisions need API keys on' : ''}
              onClick=${() => choose('decision', provider.id, m.id)}>Set as decision model</button>
          </td>
        </tr>`,
      )}
    </tbody>
  </table>`;
}

/** Dev mode: the API root this mode posts to; empty means the registry's. */
function ApiRoot({ vendor, provider, value }) {
  const [draft, setDraft] = useState(value);
  return html`<div class="settings-row dev-field">
    <label class="settings-field">
      <span class="settings-label">API root <span class="dev-tag">dev</span></span>
      <input class="settings-input mono small" value=${draft} placeholder=${provider.baseUrl || 'https://…'}
        onInput=${(e) => setDraft(e.target.value)} />
    </label>
    <button class="action-btn subtle" disabled=${draft === value}
      onClick=${() => saveVendor(vendor.id, { api: { baseUrl: draft.trim() || null } })}>Save</button>
  </div>`;
}

function VendorRow({ vendor, settings, providersById, accountsById, apiTokens, current }) {
  const [open, setOpen] = useState(false);
  const enabled = settings?.enabled === true;
  const modes = Object.entries(vendor.modes);
  return html`<section class="settings-card vendor-row ${enabled ? '' : 'vendor-off'}" data-vendor=${vendor.id}>
    <div class="vendor-head">
      <${Switch} checked=${enabled} label=${`${vendor.label} on`}
        onChange=${(on) => saveVendor(vendor.id, { enabled: on })} />
      <button type="button" class="vendor-name" aria-expanded=${open} onClick=${() => setOpen(!open)}>
        <span class="vendor-caret">${open ? '▾' : '▸'}</span> ${vendor.label}
      </button>
      <span class="vendor-modes">
        ${modes.map(([mode, served]) => {
          const status = modeStatus(mode, served, accountsById[served.provider], apiTokens);
          const on = enabled && settings?.[mode]?.enabled;
          return html`<span key=${mode} class="mode-chip tone-${served.comingSoon ? 'soon' : on ? status.tone : 'off'}"
            title=${status.detail}>${MODE_LABEL[mode]}: ${served.comingSoon ? 'coming soon' : on ? status.text : 'off'}</span>`;
        })}
      </span>
    </div>
    ${
      open
        ? html`<div class="vendor-body">
      ${modes.map(([mode, served]) => {
        const provider = served.provider ? providersById[served.provider] : null;
        const status = modeStatus(mode, served, accountsById[served.provider], apiTokens);
        return html`<div key=${mode} class="vendor-mode" data-mode=${mode}>
          <div class="vendor-mode-head">
            ${
              served.comingSoon
                ? html`<span class="mode-chip tone-soon">Coming soon</span>`
                : html`<${Switch} checked=${settings?.[mode]?.enabled === true}
                    label=${`${vendor.label} ${MODE_LABEL[mode]} mode`}
                    onChange=${(on) => saveVendor(vendor.id, { ...(on ? { enabled: true } : {}), [mode]: { enabled: on } })} />`
            }
            <strong>${MODE_LABEL[mode]} mode</strong>
            ${provider ? html`<span class="settings-card-kind">${provider.label}</span>` : null}
            <span class="mode-chip tone-${status.tone}">${status.text}</span>
          </div>
          ${status.detail ? html`<p class="settings-desc">${status.detail}</p>` : null}
          ${
            devMode.value && mode === 'api' && provider
              ? html`<${ApiRoot} vendor=${vendor} provider=${provider} value=${settings?.api?.baseUrl ?? ''} />`
              : null
          }
          ${
            served.comingSoon
              ? html`<p class="settings-desc">${vendor.label} sells a subscription, but Foundry cannot drive it yet. Use API mode for now.</p>`
              : provider
                ? html`<${ModelTable} provider=${provider} models=${provider.models} apiTokens=${apiTokens} current=${current} />`
                : null
          }
        </div>`;
      })}
    </div>`
        : null
    }
  </section>`;
}

function SelectionCard({ current, providersById }) {
  if (!current) return null;
  const name = (choice) => {
    if (!choice) return '—';
    const provider = providersById[choice.provider];
    const model = provider?.models.find((m) => m.id === choice.model);
    return `${model?.label ?? choice.model} · ${provider?.label ?? choice.provider}`;
  };
  return html`<section class="settings-card model-selection">
    <div class="model-selection-row">
      <span class="settings-label">Default model</span>
      <span class="model-selection-value" data-choice="default">${name(current.default)}</span>
    </div>
    <p class="settings-desc">What a new thread runs on. Threads and project agents can choose another.</p>
    <div class="model-selection-row">
      <span class="settings-label">Decision model</span>
      <span class="model-selection-value" data-choice="decision">${name(current.decision)}</span>
    </div>
    <p class="settings-desc decision-hint">${
      current.decisionRoles.length
        ? `The decision roles you added (${current.decisionRoles.join(', ')}) run on it.`
        : 'Decision roles (a classifier or router you add, and the region Wardens of a project whose chorus is enabled) run on it. Threads are unwrapped by default, so nothing uses it yet.'
    }</p>
    ${current.issue ? html`<p class="settings-desc" role="alert">${current.issue}</p>` : null}
    <div class="model-selection-row">
      <span class="settings-label">API keys</span>
      <${Switch} checked=${current.apiTokens} label="Use API keys (paid tokens)" onChange=${setApiTokens} />
    </div>
    <p class="settings-desc">Off: Foundry runs only on your subscription logins and never spends API tokens. On: API modes run with their keys from the environment.</p>
  </section>`;
}

export function ProvidersSection({ vendors, onSaved }) {
  onConfig = onSaved;
  useEffect(refresh, []);
  const reg = registry.value;
  if (!reg) return html`<div class="settings-empty">Loading providers…</div>`;
  const providersById = Object.fromEntries(reg.providers.map((p) => [p.id, p]));
  const accountsById = Object.fromEntries((accounts.value ?? []).map((a) => [a.provider, a]));
  const current = selection.value;
  const apiTokens = current?.apiTokens === true;
  return html`
    <p class="settings-desc">Every vendor Foundry can reach. A vendor runs in subscription mode on your own login (Claude Code, Codex), in API mode with an API key, or both.</p>
    <${SelectionCard} current=${current} providersById=${providersById} />
    <div class="vendor-list">
      ${reg.vendors.map(
        (
          vendor,
        ) => html`<${VendorRow} key=${vendor.id} vendor=${vendor} settings=${vendors?.[vendor.id]}
          providersById=${providersById} accountsById=${accountsById} apiTokens=${apiTokens} current=${current} />`,
      )}
    </div>
  `;
}
