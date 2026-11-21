/**
 * @atlas
 * @kind component
 * @partOf feature:viewer, primitive:settings
 */
/**
 * Settings › Appearance — personal theme selection, local UI extensions opt-in/status,
 * workspace/rail/panel visibility overrides, display flags, and `?safe-ui=1` recovery link.
 */

import {
  customUiManifest,
  extensionStatuses,
  refreshCustomTheme,
  refreshCustomUiManifest,
  SAFE_UI,
} from './extension-loader.js';
import { html, useEffect, useState } from './lib.js';
import { authFetch, showToast } from './store.js';
import { Switch } from './switch.js';
import { getAllBuiltinSlotsMetadata } from './ui-registry.js';

const HEADER_RIGHT_ITEMS = [
  { id: 'update-notice', label: 'Update notice' },
  { id: 'open-pill', label: 'Open threads pill' },
  { id: 'incoming', label: 'Incoming requests' },
  { id: 'kingdom', label: 'Kingdom link' },
  { id: 'connection', label: 'Connection status' },
  { id: 'help', label: 'Help button' },
];

const DISPLAY_FLAGS = [
  {
    component: 'rightPanel',
    flag: 'showComingSoon',
    label: 'Right panel: Coming soon placeholders',
    defaultVal: true,
  },
  {
    component: 'rightPanel',
    flag: 'showUsageBar',
    label: 'Right panel: Thread usage bar',
    defaultVal: true,
  },
  {
    component: 'rightPanel',
    flag: 'showRunningFooter',
    label: 'Right panel: Running tasks footer',
    defaultVal: true,
  },
  {
    component: 'conversation',
    flag: 'showHeaderBand',
    label: 'Thread: Header pill band',
    defaultVal: true,
  },
  {
    component: 'conversation',
    flag: 'showContextFill',
    label: 'Thread: Context fill meter',
    defaultVal: true,
  },
  {
    component: 'conversation',
    flag: 'compactMessages',
    label: 'Thread: Compact message spacing',
    defaultVal: false,
  },
  {
    component: 'projectHome',
    flag: 'showComingSoon',
    label: 'Project home: Coming soon cards',
    defaultVal: true,
  },
];

export function AppearanceSection({ config, onSaved }) {
  const [saving, setSaving] = useState(false);
  const manifest = customUiManifest.value;
  const statuses = extensionStatuses.value;
  const ui = config?.ui ?? {};
  const enabledExtensions = Array.isArray(ui.extensions) ? ui.extensions : [];

  useEffect(() => {
    refreshCustomUiManifest();
  }, []);

  const patchUi = async (patch, toastMsg) => {
    setSaving(true);
    try {
      const res = await authFetch('/api/settings/ui', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || res.statusText);
      onSaved?.(body);
      if (toastMsg) showToast(toastMsg, 'ok');
      return true;
    } catch (err) {
      showToast(`Could not save appearance setting: ${err.message}`, 'error');
      return false;
    } finally {
      setSaving(false);
    }
  };

  const handleThemeChange = async (value) => {
    const ok = await patchUi({ theme: value || null }, 'Theme updated');
    if (ok) refreshCustomTheme();
  };

  const toggleExtension = async (id, checked) => {
    const next = checked
      ? [...new Set([...enabledExtensions, id])]
      : enabledExtensions.filter((x) => x !== id);
    await patchUi({ extensions: next }, checked ? `Enabled ${id}` : `Disabled ${id}`);
  };

  const toggleSlotItem = async (slotId, itemId, visible) => {
    const curHidden = ui.slots?.[slotId]?.hidden ?? [];
    const nextHidden = visible
      ? curHidden.filter((x) => x !== itemId)
      : [...new Set([...curHidden, itemId])];
    await patchUi({
      slots: {
        [slotId]: {
          hidden: nextHidden.length ? nextHidden : null,
        },
      },
    });
  };

  const toggleFlag = async (component, flag, checked, defaultVal) => {
    await patchUi({
      flags: {
        [component]: {
          [flag]: checked === defaultVal ? null : checked,
        },
      },
    });
  };

  const discoveredIds = [...new Set([...manifest.extensions, ...enabledExtensions])].sort();
  const builtins = getAllBuiltinSlotsMetadata();
  const slotGroups = [
    { slotId: 'header.right', title: 'Top bar (right)', items: HEADER_RIGHT_ITEMS },
    { slotId: 'leftRail.tabs', title: 'Left rail tabs', items: builtins.leftTabs },
    { slotId: 'rightPanel.tabs', title: 'Right panel tabs', items: builtins.rightTabs },
  ].filter((g) => g.items.length > 0);

  return html`<div class="appearance-section">
    ${
      SAFE_UI
        ? html`<div class="appearance-banner" role="status">
            <span><strong>Safe UI mode is active</strong> (<code>?safe-ui=1</code>). Custom CSS and local extensions are bypassed.</span>
            <a class="proj-btn" href="/settings/appearance">Exit safe mode</a>
          </div>`
        : html`<p class="settings-desc">
            Personal to this machine (never written to a repository). If a custom theme or extension
            causes trouble, open <a href="/?safe-ui=1"><code>/?safe-ui=1</code></a> to boot without custom CSS or JS.
          </p>`
    }

    <section class="settings-card" data-setting="ui.theme">
      <h3>Custom theme</h3>
      <p class="settings-desc">
        Place CSS variable overrides in <code>&lt;configDir&gt;/ui/theme.css</code> or named themes in
        <code>&lt;configDir&gt;/ui/themes/&lt;slug&gt;.css</code>.
      </p>
      <div class="appearance-actions-row">
        <select
          class="settings-input"
          aria-label="Active custom theme"
          value=${ui.theme ?? ''}
          disabled=${saving}
          onChange=${(e) => handleThemeChange(e.target.value)}
        >
          <option value="">${manifest.hasDefaultTheme ? 'Default (theme.css)' : 'Built-in (no theme.css)'}</option>
          ${manifest.themes.map((slug) => html`<option key=${slug} value=${slug}>${slug}</option>`)}
        </select>
        <button type="button" class="proj-btn" onClick=${() => {
          refreshCustomUiManifest();
          refreshCustomTheme();
        }}>Reload CSS</button>
      </div>
    </section>

    <section class="settings-card" data-setting="ui.extensions">
      <h3>Local extensions</h3>
      <p class="settings-desc">
        Extensions under <code>&lt;configDir&gt;/ui/extensions/&lt;id&gt;.js</code> (or
        <code>&lt;id&gt;/index.js</code>) are opt-in and run only when enabled here.
      </p>
      <div class="appearance-actions-row">
        <button type="button" class="proj-btn" onClick=${refreshCustomUiManifest}>Rescan folder</button>
      </div>
      ${
        discoveredIds.length === 0
          ? html`<div class="settings-empty">No local extensions found in <code>ui/extensions/</code>.</div>`
          : html`<div class="appearance-list">
              ${discoveredIds.map((id) => {
                const enabled = enabledExtensions.includes(id);
                const st = statuses[id];
                const badgeClass =
                  st?.status === 'active'
                    ? 'appearance-badge--active'
                    : st?.status === 'error'
                      ? 'appearance-badge--error'
                      : '';
                const badgeText = !enabled ? 'off' : (st?.status ?? 'pending');
                return html`<div key=${id} class="appearance-row" data-ext-row=${id}>
                  <div class="appearance-row-info">
                    <div class="appearance-row-title">
                      <code>${id}</code>
                      <span class="appearance-badge ${badgeClass}">${badgeText}</span>
                    </div>
                    ${st?.entry ? html`<div class="appearance-row-meta mono">${st.entry}</div>` : null}
                    ${st?.error ? html`<div class="appearance-row-error">${st.error}</div>` : null}
                  </div>
                  <${Switch}
                    checked=${enabled}
                    disabled=${saving}
                    label=${`Enable extension ${id}`}
                    onChange=${(checked) => toggleExtension(id, checked)}
                  />
                </div>`;
              })}
            </div>`
      }
    </section>

    <section class="settings-card" data-setting="ui.slots">
      <h3>Visible tabs and controls</h3>
      <p class="settings-desc">
        Hide or show built-in items across the top bar, left rail, and right panel. At least one tab always stays visible.
      </p>
      ${slotGroups.map((group) => {
        const hidden = new Set(ui.slots?.[group.slotId]?.hidden ?? []);
        return html`<div key=${group.slotId} class="appearance-slot-group">
          <h4>${group.title}</h4>
          <div class="appearance-chips">
            ${group.items.map(
              (item) => html`<label key=${item.id} class="appearance-chip">
                <input
                  type="checkbox"
                  checked=${!hidden.has(item.id)}
                  disabled=${saving}
                  onChange=${(e) => toggleSlotItem(group.slotId, item.id, e.target.checked)}
                />
                <span>${item.label}</span>
              </label>`,
            )}
          </div>
        </div>`;
      })}
      ${
        ui.slots && Object.keys(ui.slots).length > 0
          ? html`<div class="appearance-actions-row">
              <button type="button" class="proj-btn" disabled=${saving} onClick=${() => patchUi({ slots: null }, 'Layout reset to defaults')}>Reset layout overrides</button>
            </div>`
          : null
      }
    </section>

    <section class="settings-card" data-setting="ui.flags">
      <h3>Display options</h3>
      <p class="settings-desc">Component display toggles saved under <code>ui.flags</code>.</p>
      <div class="appearance-list">
        ${DISPLAY_FLAGS.map((item) => {
          const val = ui.flags?.[item.component]?.[item.flag] ?? item.defaultVal;
          return html`<div key=${`${item.component}.${item.flag}`} class="appearance-row">
            <div class="appearance-row-info">
              <div class="appearance-row-title">${item.label}</div>
              <div class="appearance-row-meta mono">${item.component}.${item.flag}</div>
            </div>
            <${Switch}
              checked=${Boolean(val)}
              disabled=${saving}
              label=${item.label}
              onChange=${(checked) => toggleFlag(item.component, item.flag, checked, item.defaultVal)}
            />
          </div>`;
        })}
      </div>
    </section>
  </div>`;
}
