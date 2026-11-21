/**
 * @atlas
 * @kind utils
 * @partOf feature:viewer
 */
/**
 * Reactive UI registry for Foundry's composable viewer surfaces:
 * - Left rail tabs (`leftRail.tabs`)
 * - Right panel tabs (`rightPanel.tabs`)
 * - Main views (`scope: 'workspace' | 'thread'`)
 * - Named section slots (`extendSection`)
 * - Component display/behavior flags (`setFlags`, `useComponentFlags`)
 * - Command palette commands (`registerCommand`)
 *
 * Pure `reconcileItems()` handles deterministic topological `before`/`after` chains + cycle breaking,
 * `replace` wrapper chaining (last-wins in `ui.extensions[]` order), `hide`, and additive user slot
 * overrides (`pinned` → `order` → unlisted new built-ins → minus `hidden`).
 */

import { signal } from './lib.js';

const LOCAL_ID_PATTERN = /^[a-z0-9][a-z0-9_.:-]{0,63}$/i;
const VALID_PANEL_SIDES = new Set(['left', 'right']);

/** Reactive mirror of `settingsConfig.value?.ui ?? {}` (empty in `?safe-ui=1` mode). */
export const uiConfigSignal = signal({});

/** Whether `?safe-ui=1` is active (ignores `panelPlacement`, restoring default sides). */
export const safeUiSignal = signal(
  typeof location !== 'undefined' && new URLSearchParams(location.search).get('safe-ui') === '1',
);

/** Becomes true once the initial enabled UI extensions batch has settled (or immediately in safe mode). */
export const extensionsReady = signal(false);

/** Ordered extension ids from `ui.extensions[]` so precedence is deterministic regardless of import order. */
const extensionOrderSignal = signal([]);

// Internal storage signals (mutated immutably via `.value = ...` so Preact components re-render).
const builtinLeftTabs = signal([]);
const extLeftTabs = signal([]);

const builtinRightTabs = signal([]);
const extRightTabs = signal([]);

const builtinMainViews = signal([]);
const extMainViews = signal([]);

const sectionExtensions = signal([]);
const extensionCommandsSignal = signal([]);
const extensionFlags = signal([]); // Array<{ id, extId, componentId, flags, seq }>

const disposersByExt = new Map();
let seqCounter = 0;

function trackDisposer(extId, dispose) {
  let set = disposersByExt.get(extId);
  if (!set) {
    set = new Set();
    disposersByExt.set(extId, set);
  }
  let done = false;
  const wrapped = () => {
    if (done) return;
    done = true;
    set.delete(wrapped);
    if (set.size === 0) disposersByExt.delete(extId);
    dispose();
  };
  set.add(wrapped);
  return wrapped;
}

/** Namespace an extension item id to `<extId>:<localId>`, preventing built-in collisions. */
export function namespaceId(extId, localId) {
  if (!extId || typeof extId !== 'string') throw new Error('extId is required');
  if (!localId || typeof localId !== 'string' || !LOCAL_ID_PATTERN.test(localId)) {
    throw new Error(`Invalid UI item id "${localId}" for extension "${extId}"`);
  }
  if (localId.startsWith(`${extId}:`)) return localId;
  return `${extId}:${localId}`;
}

function extPriority(extId, orderList) {
  if (!extId) return -1;
  const idx = orderList.indexOf(extId);
  return idx === -1 ? orderList.length : idx;
}

function compareExtEntries(a, b, orderList) {
  const pa = extPriority(a.extId, orderList);
  const pb = extPriority(b.extId, orderList);
  if (pa !== pb) return pa - pb;
  return (a._seq ?? 0) - (b._seq ?? 0);
}

/**
 * @typedef {{ id: string, extId?: string | null, _replacements?: Array<{ extId: string, [key: string]: unknown }>, [key: string]: unknown }} ReconciledItem
 */

/**
 * Pure slot reconciliation:
 * 1. Apply `replace` wrappers onto matching items (in `extOrder` order; last wins, with `Default` wrapper chaining).
 * 2. Place `add` extension items via topological `before`/`after` chains (with cycle breaking & missing-target append).
 * 3. Apply extension `hide` entries and user `slotOverride` (`pinned` → `order` → remaining built-ins/extensions → minus `hidden`).
 * 4. If `options.requireNonEmpty` is true and hiding removes every item, fall back to the first built-in/item.
 *
 * @param {Array<{ id: string, [key: string]: unknown }>} builtIns
 * @param {Array<Record<string, unknown>>} [extensions]
 * @param {{ order?: string[], hidden?: string[], pinned?: string[] } | null} [slotOverride]
 * @param {{ extensionOrder?: string[], requireNonEmpty?: boolean }} [options]
 * @returns {ReconciledItem[]}
 */
export function reconcileItems(builtIns, extensions = [], slotOverride = null, options = {}) {
  const orderList = options.extensionOrder ?? extensionOrderSignal.value;
  const sortedExts = [...extensions].sort((a, b) => compareExtEntries(a, b, orderList));

  const replacementsByTarget = new Map();
  const hiddenByExt = new Set();
  const additions = [];

  for (const ext of sortedExts) {
    if (ext.mode === 'hide' || ext.hide) {
      const target = typeof ext.hide === 'string' ? ext.hide : ext.target;
      if (target) hiddenByExt.add(target);
      continue;
    }
    if (ext.mode === 'replace' || ext.replace) {
      const target = typeof ext.replace === 'string' ? ext.replace : ext.target;
      if (!target) continue;
      let list = replacementsByTarget.get(target);
      if (!list) {
        list = [];
        replacementsByTarget.set(target, list);
      } else {
        console.warn(
          `[foundry-ui] multiple extensions replaced "${target}" (${list[list.length - 1].extId} then ${ext.extId}); last wins with Default chaining`,
        );
      }
      list.push(ext);
      continue;
    }
    additions.push(ext);
  }

  const seenIds = new Set();
  const ordered = [];
  for (const item of builtIns) {
    if (!item?.id || seenIds.has(item.id)) continue;
    seenIds.add(item.id);
    const reps = replacementsByTarget.get(item.id);
    ordered.push(reps ? { ...item, _replacements: reps } : item);
  }

  // Filter duplicate addition ids and split unanchored vs anchored additions.
  const validAdditions = [];
  for (const ext of additions) {
    if (!ext?.id) continue;
    if (seenIds.has(ext.id)) {
      console.warn(`[foundry-ui] duplicate item id "${ext.id}" ignored`);
      continue;
    }
    seenIds.add(ext.id);
    const reps = replacementsByTarget.get(ext.id);
    validAdditions.push(reps ? { ...ext, _replacements: reps } : ext);
  }

  // Place unanchored additions at the end first so anchored items targeting them resolve cleanly.
  const anchored = [];
  for (const ext of validAdditions) {
    if (ext.before || ext.after) anchored.push(ext);
    else ordered.push(ext);
  }

  // Track trailing span of items inserted immediately `after` each anchor so multiple `after: X` preserve order.
  const afterTail = new Map();
  const placeItem = (item) => {
    if (item.before) {
      const idx = ordered.findIndex((x) => x.id === item.before);
      if (idx === -1) return false;
      ordered.splice(idx, 0, item);
      return true;
    }
    if (item.after) {
      const tailId = afterTail.get(item.after) ?? item.after;
      const idx = ordered.findIndex((x) => x.id === tailId);
      if (idx === -1) return false;
      ordered.splice(idx + 1, 0, item);
      afterTail.set(item.after, item.id);
      return true;
    }
    ordered.push(item);
    return true;
  };

  let remaining = anchored;
  while (remaining.length > 0) {
    const nextRemaining = [];
    let progressed = false;
    for (const item of remaining) {
      if (placeItem(item)) progressed = true;
      else nextRemaining.push(item);
    }
    if (!progressed) {
      // Break cycle or append missing-target anchor deterministically.
      const fallback = nextRemaining.shift();
      const target = fallback.before ?? fallback.after;
      if (nextRemaining.some((x) => x.id === target)) {
        console.warn(
          `[foundry-ui] cyclic before/after placement involving "${fallback.id}" -> "${target}"; breaking deterministically`,
        );
      }
      ordered.push(fallback);
    }
    remaining = nextRemaining;
  }

  // Apply user slot override: pinned -> order -> remaining unlisted (additive upgrade).
  const pinnedIds = Array.isArray(slotOverride?.pinned) ? slotOverride.pinned : [];
  const orderIds = Array.isArray(slotOverride?.order) ? slotOverride.order : [];
  const userHidden = new Set(Array.isArray(slotOverride?.hidden) ? slotOverride.hidden : []);

  let arranged = ordered;
  if (pinnedIds.length > 0 || orderIds.length > 0) {
    const byId = new Map(ordered.map((item) => [item.id, item]));
    const picked = new Set();
    arranged = [];
    for (const id of pinnedIds) {
      const item = byId.get(id);
      if (item && !picked.has(id)) {
        picked.add(id);
        arranged.push(item);
      }
    }
    for (const id of orderIds) {
      const item = byId.get(id);
      if (item && !picked.has(id)) {
        picked.add(id);
        arranged.push(item);
      }
    }
    for (const item of ordered) {
      if (!picked.has(item.id)) arranged.push(item);
    }
  }

  const visible = arranged.filter((item) => !hiddenByExt.has(item.id) && !userHidden.has(item.id));
  if (visible.length === 0 && options.requireNonEmpty && arranged.length > 0) {
    const firstBuiltin = arranged.find((item) => !item.extId);
    return [firstBuiltin ?? arranged[0]];
  }
  return visible;
}

/**
 * Resolve an active tab/view id against the current reconciled items with a safe fallback.
 * @param {Array<{ id: string }>} items
 * @param {string | null | undefined} currentId
 * @param {string | null} [fallbackId]
 */
export function resolveActiveId(items, currentId, fallbackId = null) {
  if (items.some((item) => item.id === currentId)) return currentId;
  if (fallbackId && items.some((item) => item.id === fallbackId)) return fallbackId;
  return items[0]?.id ?? null;
}

// ---------------------------------------------------------------------------
// Extension order & cleanup
// ---------------------------------------------------------------------------

export function setExtensionOrder(extIds) {
  extensionOrderSignal.value = Array.isArray(extIds) ? [...extIds] : [];
}

export function unregisterExtension(extId) {
  const set = disposersByExt.get(extId);
  if (set) {
    for (const fn of [...set]) {
      try {
        fn();
      } catch (err) {
        console.warn(`[foundry-ui] disposer for "${extId}" threw:`, err);
      }
    }
    disposersByExt.delete(extId);
  }
  // Defensive sweep so partial state never lingers.
  extLeftTabs.value = extLeftTabs.peek().filter((x) => x.extId !== extId);
  extRightTabs.value = extRightTabs.peek().filter((x) => x.extId !== extId);
  extMainViews.value = extMainViews.peek().filter((x) => x.extId !== extId);
  sectionExtensions.value = sectionExtensions.peek().filter((x) => x.extId !== extId);
  extensionCommandsSignal.value = extensionCommandsSignal.peek().filter((x) => x.extId !== extId);
  extensionFlags.value = extensionFlags.peek().filter((x) => x.extId !== extId);
}

/** Register an arbitrary cleanup callback owned by `extId` (used by extension-loader effects/hotkeys). */
export function registerExtensionDisposer(extId, dispose) {
  return trackDisposer(extId, dispose);
}

// ---------------------------------------------------------------------------
// Built-in registration (bare IDs)
// ---------------------------------------------------------------------------

function upsertBuiltin(listSignal, def) {
  const prev = listSignal.peek();
  const idx = prev.findIndex((x) => x.id === def.id);
  if (idx === -1) listSignal.value = [...prev, def];
  else {
    const next = [...prev];
    next[idx] = def;
    listSignal.value = next;
  }
}

export function registerBuiltinLeftTab(def) {
  upsertBuiltin(builtinLeftTabs, {
    row: 0,
    wideShare: false,
    ...def,
    defaultSide: 'left',
    extId: null,
  });
}

export function registerBuiltinRightTab(def) {
  upsertBuiltin(builtinRightTabs, { ...def, defaultSide: 'right', extId: null });
}

export function registerBuiltinMainView(def) {
  upsertBuiltin(builtinMainViews, { scope: 'workspace', ...def, extId: null });
}

// ---------------------------------------------------------------------------
// Extension registration (auto-namespaced `<extId>:<id>`)
// ---------------------------------------------------------------------------

export function registerLeftTab(extId, def) {
  const id = namespaceId(extId, def.id);
  const entry = {
    row: 1,
    wideShare: false,
    ...def,
    id,
    defaultSide: 'left',
    extId,
    _seq: ++seqCounter,
  };
  extLeftTabs.value = [...extLeftTabs.peek().filter((x) => x.id !== id), entry];
  return trackDisposer(extId, () => {
    extLeftTabs.value = extLeftTabs.peek().filter((x) => x !== entry);
  });
}

export function registerRightTab(extId, def) {
  const id = namespaceId(extId, def.id);
  const entry = {
    ...def,
    id,
    defaultSide: 'right',
    extId,
    _seq: ++seqCounter,
  };
  extRightTabs.value = [...extRightTabs.peek().filter((x) => x.id !== id), entry];
  return trackDisposer(extId, () => {
    extRightTabs.value = extRightTabs.peek().filter((x) => x !== entry);
  });
}

export function registerMainView(extId, def) {
  const scope = def.scope ?? 'workspace';
  if (scope !== 'workspace' && scope !== 'thread') {
    throw new Error(`Invalid main view scope "${scope}" (expected workspace | thread)`);
  }
  const id = namespaceId(extId, def.id);
  const entry = {
    fullWidth: scope === 'workspace',
    ...def,
    scope,
    id,
    extId,
    _seq: ++seqCounter,
  };
  extMainViews.value = [...extMainViews.peek().filter((x) => x.id !== id), entry];
  return trackDisposer(extId, () => {
    extMainViews.value = extMainViews.peek().filter((x) => x !== entry);
  });
}

export function extendSection(extId, slotId, def) {
  if (!slotId || typeof slotId !== 'string') throw new Error('slotId is required');
  let mode = 'add';
  let id = null;
  let target = null;
  if (def.hide) {
    mode = 'hide';
    target = typeof def.hide === 'string' ? def.hide : '__slot__';
  } else if (def.replace) {
    mode = 'replace';
    target = typeof def.replace === 'string' ? def.replace : '__slot__';
  } else {
    id = namespaceId(extId, def.id ?? `item-${seqCounter + 1}`);
  }
  const entry = {
    ...def,
    slotId,
    mode,
    id,
    target,
    extId,
    _seq: ++seqCounter,
  };
  sectionExtensions.value = [...sectionExtensions.peek(), entry];
  return trackDisposer(extId, () => {
    sectionExtensions.value = sectionExtensions.peek().filter((x) => x !== entry);
  });
}

export function setFlags(extId, componentId, flags) {
  if (!componentId || typeof componentId !== 'string') throw new Error('componentId is required');
  if (!flags || typeof flags !== 'object' || Array.isArray(flags)) {
    throw new Error('flags must be a plain object');
  }
  const entry = { extId, componentId, flags: { ...flags }, _seq: ++seqCounter };
  extensionFlags.value = [...extensionFlags.peek(), entry];
  return trackDisposer(extId, () => {
    extensionFlags.value = extensionFlags.peek().filter((x) => x !== entry);
  });
}

export function registerCommand(extId, def) {
  const id = namespaceId(extId, def.id);
  const entry = {
    icon: '◆',
    ...def,
    id,
    extId,
    _seq: ++seqCounter,
  };
  extensionCommandsSignal.value = [
    ...extensionCommandsSignal.peek().filter((x) => x.id !== id),
    entry,
  ];
  return trackDisposer(extId, () => {
    extensionCommandsSignal.value = extensionCommandsSignal.peek().filter((x) => x !== entry);
  });
}

// ---------------------------------------------------------------------------
// Reactive queries
// ---------------------------------------------------------------------------

/** Resolve component flags with precedence: user `ui.flags` > extension `setFlags` > built-in defaults. */
export function useComponentFlags(componentId, defaults = {}) {
  const orderList = extensionOrderSignal.value;
  const contributed = extensionFlags.value
    .filter((entry) => entry.componentId === componentId)
    .sort((a, b) => compareExtEntries(a, b, orderList));
  const merged = { ...defaults };
  for (const entry of contributed) Object.assign(merged, entry.flags);
  const userFlags = uiConfigSignal.value?.flags?.[componentId];
  if (userFlags && typeof userFlags === 'object') Object.assign(merged, userFlags);
  return merged;
}

function resolvedPlacementMap(explicitPlacement) {
  if (explicitPlacement !== undefined) return explicitPlacement ?? null;
  if (safeUiSignal.value) return null;
  return uiConfigSignal.value?.panelPlacement ?? null;
}

function desiredSide(tab, placement) {
  const override = placement?.[tab.id];
  return VALID_PANEL_SIDES.has(override) ? override : tab.defaultSide;
}

function projectToSide(tab, side) {
  if (side === 'left') {
    return {
      ...tab,
      row: tab.defaultSide === 'left' ? (tab.row ?? 0) : 1,
      side: 'left',
    };
  }
  return { ...tab, side: 'right' };
}

function partitionSideTabs(explicitPlacement) {
  const placement = resolvedPlacementMap(explicitPlacement);
  const bLeft = builtinLeftTabs.value;
  const eLeft = extLeftTabs.value;
  const bRight = builtinRightTabs.value;
  const eRight = extRightTabs.value;

  const leftBuiltIns = [];
  const leftExts = [];
  const rightBuiltIns = [];
  const rightExts = [];

  for (const tab of bLeft) {
    if (desiredSide(tab, placement) === 'right') rightBuiltIns.push(tab);
    else leftBuiltIns.push(tab);
  }
  for (const tab of bRight) {
    if (desiredSide(tab, placement) === 'left') leftBuiltIns.push(tab);
    else rightBuiltIns.push(tab);
  }
  for (const tab of eLeft) {
    if (desiredSide(tab, placement) === 'right') rightExts.push(tab);
    else leftExts.push(tab);
  }
  for (const tab of eRight) {
    if (desiredSide(tab, placement) === 'left') leftExts.push(tab);
    else rightExts.push(tab);
  }

  const orderedLeftBuiltIns = [
    ...leftBuiltIns.filter((t) => t.defaultSide === 'left'),
    ...leftBuiltIns.filter((t) => t.defaultSide !== 'left'),
  ];
  const orderedRightBuiltIns = [
    ...rightBuiltIns.filter((t) => t.defaultSide === 'right'),
    ...rightBuiltIns.filter((t) => t.defaultSide !== 'right'),
  ];

  // Guarantee neither side is emptied completely when it has registered native tabs.
  if (orderedLeftBuiltIns.length === 0 && leftExts.length === 0) {
    const rescue = bLeft[0] ?? eLeft[0];
    if (rescue) {
      if (rescue.extId) {
        const idx = rightExts.indexOf(rescue);
        if (idx !== -1) rightExts.splice(idx, 1);
        leftExts.push(rescue);
      } else {
        const idx = orderedRightBuiltIns.indexOf(rescue);
        if (idx !== -1) orderedRightBuiltIns.splice(idx, 1);
        orderedLeftBuiltIns.push(rescue);
      }
    }
  }
  if (orderedRightBuiltIns.length === 0 && rightExts.length === 0) {
    const rescue = bRight[0] ?? eRight[0];
    if (rescue) {
      if (rescue.extId) {
        const idx = leftExts.indexOf(rescue);
        if (idx !== -1) leftExts.splice(idx, 1);
        rightExts.push(rescue);
      } else {
        const idx = orderedLeftBuiltIns.indexOf(rescue);
        if (idx !== -1) orderedLeftBuiltIns.splice(idx, 1);
        orderedRightBuiltIns.push(rescue);
      }
    }
  }

  return {
    leftBuiltIns: orderedLeftBuiltIns.map((t) => projectToSide(t, 'left')),
    leftExts: leftExts.map((t) => projectToSide(t, 'left')),
    rightBuiltIns: orderedRightBuiltIns.map((t) => projectToSide(t, 'right')),
    rightExts: rightExts.map((t) => projectToSide(t, 'right')),
  };
}

/** Find any registered side-panel tab definition across both left rail and right panel registries. */
export function sideTabById(id) {
  if (!id) return null;
  return (
    builtinLeftTabs.value.find((t) => t.id === id) ??
    extLeftTabs.value.find((t) => t.id === id) ??
    builtinRightTabs.value.find((t) => t.id === id) ??
    extRightTabs.value.find((t) => t.id === id) ??
    null
  );
}

/**
 * Effective side (`'left' | 'right'`) for a registered side-panel tab id,
 * respecting `?safe-ui=1` and non-empty side fallbacks, or `null` if unregistered.
 * @param {string} id
 * @param {Record<string, 'left' | 'right'> | null} [placementOverride]
 * @returns {'left' | 'right' | null}
 */
export function effectiveTabSide(id, placementOverride) {
  if (!id) return null;
  const { leftBuiltIns, leftExts, rightBuiltIns, rightExts } = partitionSideTabs(placementOverride);
  if (leftBuiltIns.some((t) => t.id === id) || leftExts.some((t) => t.id === id)) return 'left';
  if (rightBuiltIns.some((t) => t.id === id) || rightExts.some((t) => t.id === id)) return 'right';
  return null;
}

/**
 * Placement summary for a registered side-panel tab, or `null` if unregistered.
 * @param {string} id
 * @param {Record<string, 'left' | 'right'> | null} [placementOverride]
 * @returns {{ defaultSide: 'left' | 'right', side: 'left' | 'right', moved: boolean } | null}
 */
export function tabPlacement(id, placementOverride) {
  const tab = sideTabById(id);
  if (!tab) return null;
  const side = effectiveTabSide(id, placementOverride) ?? tab.defaultSide;
  return {
    defaultSide: tab.defaultSide,
    side,
    moved: side !== tab.defaultSide,
  };
}

export function leftTabs() {
  const { leftBuiltIns, leftExts } = partitionSideTabs();
  return reconcileItems(leftBuiltIns, leftExts, uiConfigSignal.value?.slots?.['leftRail.tabs'], {
    requireNonEmpty: true,
  });
}

export function leftTabById(id) {
  return (
    leftTabs().find((t) => t.id === id) ??
    builtinLeftTabs.value.find((t) => t.id === id) ??
    extLeftTabs.value.find((t) => t.id === id) ??
    null
  );
}

/** Group reconciled left-rail tabs into visual rows (row 0, then row 1+). */
export function leftTabRows() {
  const tabs = leftTabs();
  const row0 = tabs.filter((t) => (t.row ?? 1) === 0);
  const row1 = tabs.filter((t) => (t.row ?? 1) !== 0);
  const rows = [];
  if (row0.length) rows.push(row0);
  if (row1.length) rows.push(row1);
  return rows;
}

export function rightTabs() {
  const { rightBuiltIns, rightExts } = partitionSideTabs();
  return reconcileItems(
    rightBuiltIns,
    rightExts,
    uiConfigSignal.value?.slots?.['rightPanel.tabs'],
    { requireNonEmpty: true },
  );
}

export function mainViews(scope = 'workspace') {
  if (scope !== 'workspace' && scope !== 'thread') {
    throw new Error(`Invalid main view scope "${scope}" (expected workspace | thread)`);
  }
  const builtins = builtinMainViews.value.filter((v) => v.scope === scope);
  const exts = extMainViews.value.filter((v) => v.scope === scope);
  const slotKey = scope === 'workspace' ? 'workspace.views' : 'center.tabs';
  return reconcileItems(builtins, exts, uiConfigSignal.value?.slots?.[slotKey], {
    requireNonEmpty: true,
  });
}

export function sectionItems(slotId, builtInItems) {
  const exts = sectionExtensions.value.filter((e) => e.slotId === slotId);
  return reconcileItems(builtInItems, exts, uiConfigSignal.value?.slots?.[slotId]);
}

export function sectionSlotExtensions(slotName) {
  const orderList = extensionOrderSignal.value;
  const exts = sectionExtensions.value
    .filter((e) => e.slotId === slotName)
    .sort((a, b) => compareExtEntries(a, b, orderList));
  const slotOverride = uiConfigSignal.value?.slots?.[slotName];
  const hiddenByUser =
    Array.isArray(slotOverride?.hidden) && slotOverride.hidden.includes('__slot__');
  let hidden = hiddenByUser;
  const before = [];
  const after = [];
  const replace = [];
  for (const ext of exts) {
    if (ext.mode === 'hide') {
      hidden = true;
    } else if (ext.mode === 'replace') {
      replace.push(ext);
    } else if (ext.before === true) {
      before.push(ext);
    } else {
      after.push(ext);
    }
  }
  return { before, replace, after, hidden };
}

export function extensionCommands() {
  const orderList = extensionOrderSignal.value;
  return [...extensionCommandsSignal.value].sort((a, b) => compareExtEntries(a, b, orderList));
}

export function builtinSlotsMetadata() {
  return {
    leftTabs: builtinLeftTabs.value.map((t) => ({ id: t.id, label: t.label })),
    rightTabs: builtinRightTabs.value.map((t) => ({ id: t.id, label: t.label })),
    workspaceViews: builtinMainViews.value
      .filter((v) => v.scope === 'workspace')
      .map((v) => ({ id: v.id, label: v.label })),
  };
}

/**
 * Side-panel tabs grouped by their effective side for Settings -> Appearance.
 * Pass `config.ui?.panelPlacement` explicitly to reflect saved overrides even in safe mode.
 * @param {Record<string, 'left' | 'right'> | null} [placementOverride]
 */
export function sideTabsMetadata(placementOverride) {
  const { leftBuiltIns, leftExts, rightBuiltIns, rightExts } = partitionSideTabs(placementOverride);
  const toMeta = (tab) => ({
    id: tab.id,
    label: tab.label ?? tab.id,
    defaultSide: tab.defaultSide,
    side: tab.side,
    moved: tab.side !== tab.defaultSide,
    extId: tab.extId ?? null,
  });
  return {
    leftTabs: [...leftBuiltIns, ...leftExts].map(toMeta),
    rightTabs: [...rightBuiltIns, ...rightExts].map(toMeta),
  };
}

/** Test helper: reset all registry state. */
export function _resetRegistryForTests() {
  for (const extId of [...disposersByExt.keys()]) unregisterExtension(extId);
  builtinLeftTabs.value = [];
  extLeftTabs.value = [];
  builtinRightTabs.value = [];
  extRightTabs.value = [];
  builtinMainViews.value = [];
  extMainViews.value = [];
  sectionExtensions.value = [];
  extensionCommandsSignal.value = [];
  extensionFlags.value = [];
  extensionOrderSignal.value = [];
  uiConfigSignal.value = {};
  safeUiSignal.value = false;
  extensionsReady.value = false;
  seqCounter = 0;
}
