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
  saveUiPatch,
  systemPrefersDark,
} from './extension-loader.js';
import { html, useEffect, useRef, useState } from './lib.js';
import { Switch } from './switch.js';
import { sideTabsMetadata } from './ui-registry.js';

const COLOR_SCHEME_OPTIONS = [
  { id: 'dark', label: 'Dark' },
  { id: 'light', label: 'Light' },
  { id: 'system', label: 'System' },
];

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
      return await saveUiPatch(patch, toastMsg, { onSaved });
    } finally {
      setSaving(false);
    }
  };

  const colorSchemeRefs = useRef({});
  const activeColorScheme = ui.colorScheme ?? 'dark';

  const handleColorSchemeChange = async (value) => {
    if (saving || value === activeColorScheme) return;
    await patchUi({ colorScheme: value }, `Color scheme set to ${value}`);
  };

  const handleColorSchemeKeyDown = (e, index) => {
    const count = COLOR_SCHEME_OPTIONS.length;
    let nextIndex = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      nextIndex = (index + 1) % count;
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      nextIndex = (index - 1 + count) % count;
    } else if (e.key === 'Home') {
      nextIndex = 0;
    } else if (e.key === 'End') {
      nextIndex = count - 1;
    }
    if (nextIndex === null) return;
    e.preventDefault();
    if (saving) return;
    const nextOpt = COLOR_SCHEME_OPTIONS[nextIndex];
    colorSchemeRefs.current[nextOpt.id]?.focus();
    handleColorSchemeChange(nextOpt.id);
  };

  const handleThemeChange = async (value) => {
    await patchUi({ theme: value || null }, 'Theme updated');
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

  const moveTab = async (item, targetSide) => {
    const nextSide = targetSide === item.defaultSide ? null : targetSide;
    const targetSlotId = targetSide === 'left' ? 'leftRail.tabs' : 'rightPanel.tabs';
    const curTargetHidden = ui.slots?.[targetSlotId]?.hidden ?? [];
    const patch = { panelPlacement: { [item.id]: nextSide } };
    if (curTargetHidden.includes(item.id)) {
      const nextHidden = curTargetHidden.filter((x) => x !== item.id);
      patch.slots = { [targetSlotId]: { hidden: nextHidden.length ? nextHidden : null } };
    }
    const destLabel = targetSide === 'left' ? 'Left Rail' : 'Right Panel';
    await patchUi(patch, `Moved ${item.label} to ${destLabel}`);
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
  const sideMeta = sideTabsMetadata(ui.panelPlacement ?? null);
  const sideGroups = [
    { slotId: 'leftRail.tabs', side: 'left', title: 'Left rail tabs', items: sideMeta.leftTabs },
    {
      slotId: 'rightPanel.tabs',
      side: 'right',
      title: 'Right panel tabs',
      items: sideMeta.rightTabs,
    },
  ].filter((g) => g.items.length > 0);
  const hasLayoutOverrides =
    (ui.slots && Object.keys(ui.slots).length > 0) ||
    (ui.panelPlacement && Object.keys(ui.panelPlacement).length > 0);

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

    <section class="settings-card" data-setting="ui.colorScheme">
      <h3>Color scheme</h3>
      <p class="settings-desc">
        Choose Foundry’s light or dark appearance, or follow your operating system’s setting.
      </p>
      <div class="appearance-actions-row">
        <div class="color-scheme-segmented" role="radiogroup" aria-label="Color scheme">
          ${COLOR_SCHEME_OPTIONS.map(
            (opt, index) => html`<button
              key=${opt.id}
              ref=${(el) => {
                colorSchemeRefs.current[opt.id] = el;
              }}
              type="button"
              role="radio"
              tabIndex=${activeColorScheme === opt.id ? 0 : -1}
              class=${`color-scheme-option${activeColorScheme === opt.id ? ' is-active' : ''}`}
              aria-checked=${String(activeColorScheme === opt.id)}
              aria-disabled=${saving ? 'true' : undefined}
              data-color-scheme=${opt.id}
              onClick=${() => handleColorSchemeChange(opt.id)}
              onKeyDown=${(e) => handleColorSchemeKeyDown(e, index)}
            >${opt.label}</button>`,
          )}
        </div>
        ${
          activeColorScheme === 'system'
            ? html`<span class="color-scheme-hint">System is currently ${systemPrefersDark.value ? 'Dark' : 'Light'}</span>`
            : null
        }
      </div>
    </section>

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
          ${ui.theme && !manifest.themes.includes(ui.theme) ? html`<option value=${ui.theme}>${ui.theme} (missing)</option>` : null}
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
        Hide, show, or move side-panel tabs between the left rail and right panel. Moved tabs keep receiving updates on whichever side they sit on, and at least one tab always stays visible per side.
      </p>
      ${(() => {
        const headerHidden = new Set(ui.slots?.['header.right']?.hidden ?? []);
        return html`<div class="appearance-slot-group" data-slot-group="header.right">
          <h4>Top bar (right)</h4>
          <div class="appearance-chips">
            ${HEADER_RIGHT_ITEMS.map(
              (item) => html`<label key=${item.id} class="appearance-chip">
                <input
                  type="checkbox"
                  checked=${!headerHidden.has(item.id)}
                  disabled=${saving}
                  onChange=${(e) => toggleSlotItem('header.right', item.id, e.target.checked)}
                />
                <span>${item.label}</span>
              </label>`,
            )}
          </div>
        </div>`;
      })()}
      ${sideGroups.map((group) => {
        const hidden = new Set(ui.slots?.[group.slotId]?.hidden ?? []);
        const visibleCount = group.items.filter((item) => !hidden.has(item.id)).length;
        const targetSide = group.side === 'left' ? 'right' : 'left';
        const moveLabel = group.side === 'left' ? 'Move to Right' : 'Move to Left';
        return html`<div key=${group.slotId} class="appearance-slot-group" data-slot-group=${group.slotId}>
          <h4>${group.title}</h4>
          <div class="appearance-tab-list">
            ${group.items.map((item) => {
              const isHidden = hidden.has(item.id);
              const isLastVisible = group.items.length <= 1 || (!isHidden && visibleCount <= 1);
              return html`<div key=${item.id} class="appearance-tab-row" data-tab-row=${item.id} data-tab-side=${group.side}>
                <label class="appearance-tab-toggle">
                  <input
                    type="checkbox"
                    checked=${!isHidden}
                    disabled=${saving}
                    onChange=${(e) => toggleSlotItem(group.slotId, item.id, e.target.checked)}
                  />
                  <span>${item.label}</span>
                  ${
                    item.moved
                      ? html`<span class="appearance-badge">from ${item.defaultSide === 'left' ? 'Left' : 'Right'}</span>`
                      : null
                  }
                </label>
                <div class="appearance-tab-actions">
                  ${
                    item.moved
                      ? html`<button
                          type="button"
                          class="appearance-tab-btn"
                          data-reset-tab=${item.id}
                          disabled=${saving || isLastVisible}
                          title=${isLastVisible ? 'At least one visible tab must stay on this side' : `Return ${item.label} to ${item.defaultSide === 'left' ? 'Left Rail' : 'Right Panel'}`}
                          onClick=${() => moveTab(item, item.defaultSide)}
                        >Reset</button>`
                      : null
                  }
                  <button
                    type="button"
                    class="appearance-tab-btn"
                    data-move-tab=${item.id}
                    disabled=${saving || isLastVisible}
                    title=${isLastVisible ? 'At least one visible tab must stay on this side' : `Move ${item.label} to ${targetSide === 'left' ? 'Left Rail' : 'Right Panel'}`}
                    onClick=${() => moveTab(item, targetSide)}
                  >${moveLabel}</button>
                </div>
              </div>`;
            })}
          </div>
        </div>`;
      })}
      ${
        hasLayoutOverrides
          ? html`<div class="appearance-actions-row">
              <button type="button" class="proj-btn" disabled=${saving} onClick=${() => patchUi({ slots: null, panelPlacement: null }, 'Layout reset to defaults')}>Reset layout overrides</button>
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
