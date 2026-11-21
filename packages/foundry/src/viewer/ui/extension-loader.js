/**
 * @atlas
 * @kind utils
 * @partOf feature:viewer
 */
/**
 * Local UI extension & custom theme loader.
 * - Captures `?safe-ui=1` at boot (`SAFE_UI` from `route.js`), bypassing custom CSS and JS extensions.
 * - Loads opt-in extensions from `settingsConfig.value?.ui?.extensions` via native dynamic `import()`.
 * - Resolves `<id>.js` or `<id>/index.js` using `/api/ui/custom` manifest.
 * - Isolates setup/import/effect errors so a broken extension never causes uncaught page errors.
 */

import { safeCall } from './error-boundary.js';
import { bindExtensionKey } from './hotkeys.js';
import {
  Component,
  computed,
  effect,
  Fragment,
  h,
  html,
  signal,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from './lib.js';
import { navigate, SAFE_UI } from './route.js';
import { openNewThread } from './run-picker.js';
import { setDisableExtensionHandler } from './slot.js';
import {
  activeCustomView,
  activePanel,
  activeProjectId,
  activeThreadId,
  allThreads,
  authFetch,
  boardOpen,
  connected,
  executeAction,
  openCustomView,
  openRightTab,
  projects,
  railView,
  rightTab,
  selectScope,
  selectThread,
  showThreadsWorkspace,
  showThreadView,
  showToast,
  threadData,
  watchtowerOpen,
} from './store.js';
import {
  extendSection,
  extensionsReady,
  namespaceId,
  registerCommand,
  registerExtensionDisposer,
  registerLeftTab,
  registerMainView,
  registerRightTab,
  setExtensionOrder,
  setFlags,
  uiConfigSignal,
  unregisterExtension,
  useComponentFlags,
} from './ui-registry.js';

export { extensionsReady, SAFE_UI };

/** Live status per extension id: `{ status: 'loading' | 'active' | 'error', error?, entry? }`. */
export const extensionStatuses = signal({});

/** Discovered themes and extensions from `GET /api/ui/custom`. */
export const customUiManifest = signal({
  themes: [],
  extensions: [],
  extensionEntries: {},
  hasDefaultTheme: false,
});

let settingsRef = null;
let themeNonce = 0;
let importNonce = 0;
let manifestFetched = false;
let initialized = false;
const loadedExtensions = new Map(); // extId -> { entry }
let reconcileChain = Promise.resolve();

function setStatus(extId, next) {
  const cur = { ...extensionStatuses.peek() };
  if (next === null) delete cur[extId];
  else cur[extId] = next;
  extensionStatuses.value = cur;
}

/** Fetch `<configDir>/ui/` themes & extensions manifest from the viewer server. */
export async function refreshCustomUiManifest() {
  try {
    const res = await authFetch('/api/ui/custom');
    if (!res.ok) return customUiManifest.peek();
    const data = await res.json();
    customUiManifest.value = {
      themes: Array.isArray(data.themes) ? data.themes : [],
      extensions: Array.isArray(data.extensions) ? data.extensions : [],
      extensionEntries:
        data.extensionEntries && typeof data.extensionEntries === 'object'
          ? data.extensionEntries
          : {},
      hasDefaultTheme: Boolean(data.hasDefaultTheme),
    };
    manifestFetched = true;
  } catch (err) {
    console.warn('[foundry-ui] failed to fetch /api/ui/custom:', err);
  }
  return customUiManifest.peek();
}

/** Reload or disable the `#foundry-custom-theme` stylesheet link. */
export function refreshCustomTheme() {
  if (typeof document === 'undefined') return;
  const link = document.getElementById('foundry-custom-theme');
  if (!link) return;
  if (SAFE_UI) {
    link.disabled = true;
    return;
  }
  link.disabled = false;
  link.href = `/ui/custom/theme.css?v=${++themeNonce}`;
}

/** Disable an extension by patching `ui.extensions` via `PATCH /api/settings/ui`. */
export async function disableExtension(extId) {
  if (!extId || !settingsRef) return false;
  const current = settingsRef.peek()?.ui?.extensions ?? [];
  const next = current.filter((id) => id !== extId);
  try {
    const res = await authFetch('/api/settings/ui', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ extensions: next }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || res.statusText);
    settingsRef.value = body;
    showToast(`Disabled extension "${extId}"`, 'ok');
    return true;
  } catch (err) {
    showToast(`Could not disable "${extId}": ${err.message}`, 'error');
    return false;
  }
}

function buildExtensionSdk(extId) {
  return {
    id: extId,
    ui: {
      html,
      h,
      Fragment,
      Component,
      signal,
      computed,
      useState,
      useEffect,
      useRef,
      useMemo,
      useCallback,
    },
    state: {
      activeThreadId,
      activeProjectId,
      threadData,
      allThreads,
      projects,
      railView,
      rightTab,
      activePanel,
      boardOpen,
      watchtowerOpen,
      activeCustomView,
      settingsConfig: settingsRef,
      connected,
    },
    actions: {
      selectThread,
      selectScope,
      openRightTab,
      showThreadView,
      openCustomView,
      showThreadsWorkspace,
      showToast,
      navigate,
      openNewThread,
      executeAction,
    },
    effect(fn) {
      const dispose = effect(() => safeCall(extId, fn, undefined, 'effect'));
      return registerExtensionDisposer(extId, dispose);
    },
    onCleanup(fn) {
      return registerExtensionDisposer(extId, () => safeCall(extId, fn, undefined, 'cleanup'));
    },
    registerLeftTab(def) {
      const disposeTab = registerLeftTab(extId, def);
      let disposeKey = null;
      if (def?.key) {
        const fullId = namespaceId(extId, def.id);
        disposeKey = bindExtensionKey(def.key, {
          description: `Left rail: ${def.label ?? fullId}`,
          category: 'extensions',
          action: () => {
            railView.value = fullId;
          },
        });
        registerExtensionDisposer(extId, disposeKey);
      }
      return () => {
        disposeKey?.();
        disposeTab();
      };
    },
    registerRightTab(def) {
      const disposeTab = registerRightTab(extId, def);
      let disposeKey = null;
      if (def?.key) {
        const fullId = namespaceId(extId, def.id);
        disposeKey = bindExtensionKey(def.key, {
          description: `Right panel: ${def.label ?? fullId}`,
          category: 'extensions',
          action: () => openRightTab(fullId, { toggle: true }),
        });
        registerExtensionDisposer(extId, disposeKey);
      }
      return () => {
        disposeKey?.();
        disposeTab();
      };
    },
    registerMainView(def) {
      const disposeView = registerMainView(extId, def);
      let disposeKey = null;
      if (def?.key) {
        const fullId = namespaceId(extId, def.id);
        const scope = def.scope ?? 'workspace';
        disposeKey = bindExtensionKey(def.key, {
          description: `View: ${def.label ?? fullId}`,
          category: 'extensions',
          action: () => {
            if (scope === 'workspace') openCustomView(fullId);
            else if (scope === 'thread') activePanel.value = fullId;
          },
        });
        registerExtensionDisposer(extId, disposeKey);
      }
      return () => {
        disposeKey?.();
        disposeView();
      };
    },
    extendSection(slotId, def) {
      return extendSection(extId, slotId, def);
    },
    setFlags(componentId, flags) {
      return setFlags(extId, componentId, flags);
    },
    getFlags(componentId, defaults) {
      return useComponentFlags(componentId, defaults);
    },
    registerCommand(def) {
      const disposeCmd = registerCommand(extId, def);
      let disposeKey = null;
      if (def?.key) {
        disposeKey = bindExtensionKey(def.key, {
          description: def.label ?? def.id,
          category: 'extensions',
          action: () => safeCall(extId, () => def.action?.(), undefined, 'command'),
        });
        registerExtensionDisposer(extId, disposeKey);
      }
      return () => {
        disposeKey?.();
        disposeCmd();
      };
    },
  };
}

async function loadOneExtension(extId, entry) {
  setStatus(extId, { status: 'loading', entry });
  loadedExtensions.set(extId, { entry });
  try {
    const mod = await import(`${entry}?v=${++importNonce}`);
    const setup = mod.default ?? mod.setup;
    if (typeof setup !== 'function') {
      throw new Error('Extension must export a default or setup(foundry) function');
    }
    const sdk = buildExtensionSdk(extId);
    const teardown = await setup(sdk);
    if (typeof teardown === 'function') {
      registerExtensionDisposer(extId, () => safeCall(extId, teardown, undefined, 'teardown'));
    }
    setStatus(extId, { status: 'active', entry });
  } catch (error) {
    unregisterExtension(extId);
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[foundry-ui] failed to load extension "${extId}":`, error);
    setStatus(extId, { status: 'error', error: message, entry });
  }
}

async function reconcileEnabledExtensions(enabledIds) {
  const uniqueEnabled = [...new Set(enabledIds.filter((id) => typeof id === 'string' && id))];
  setExtensionOrder(uniqueEnabled);

  const enabledSet = new Set(uniqueEnabled);
  for (const id of [...loadedExtensions.keys()]) {
    if (!enabledSet.has(id)) {
      unregisterExtension(id);
      loadedExtensions.delete(id);
      setStatus(id, null);
    }
  }

  const missing = uniqueEnabled.filter((id) => !loadedExtensions.has(id));
  if (missing.length > 0) {
    let manifest = customUiManifest.peek();
    if (!manifestFetched || missing.some((id) => !manifest.extensionEntries[id])) {
      manifest = await refreshCustomUiManifest();
    }
    for (const id of missing) {
      // Re-check in case settings changed while awaiting previous extension.
      if (!enabledSet.has(id) || loadedExtensions.has(id)) continue;
      const entry =
        manifest.extensionEntries[id] ?? `/ui/custom/extensions/${encodeURIComponent(id)}.js`;
      await loadOneExtension(id, entry);
    }
  }

  extensionsReady.value = true;
}

/** Boot custom theme + local extension loading, synced reactively to `settingsConfig`. */
export function initUiExtensions(settingsConfigSignal) {
  if (initialized) return;
  initialized = true;
  settingsRef = settingsConfigSignal;
  setDisableExtensionHandler(disableExtension);

  if (SAFE_UI) {
    refreshCustomTheme();
    uiConfigSignal.value = {};
    extensionsReady.value = true;
    return;
  }

  let lastTheme;
  effect(() => {
    const cfg = settingsConfigSignal.value;
    if (!cfg) return;
    const ui = cfg.ui ?? {};
    uiConfigSignal.value = ui;

    const nextTheme = ui.theme ?? null;
    if (lastTheme !== undefined && nextTheme !== lastTheme) {
      refreshCustomTheme();
    }
    lastTheme = nextTheme;

    const enabled = Array.isArray(ui.extensions) ? ui.extensions : [];
    reconcileChain = reconcileChain
      .then(() => reconcileEnabledExtensions(enabled))
      .catch((err) => {
        console.warn('[foundry-ui] extension reconcile failed:', err);
        extensionsReady.value = true;
      });
  });
}
