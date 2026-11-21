/**
 * @atlas
 * @kind utils
 * @partOf feature:viewer
 */
/**
 * Composable slot primitives (`SectionList` and `SectionSlot`).
 * Both return a Preact `Fragment` so ZERO wrapper DOM elements are inserted into flex/grid layouts.
 * Only extension-provided renderers are wrapped in `ExtensionBoundary`; built-ins render directly.
 */

import { ExtensionBoundary } from './error-boundary.js';
import { Fragment, html } from './lib.js';
import { sectionItems, sectionSlotExtensions } from './ui-registry.js';

let disableHandler = null;

/** Wire the extension disable callback used by error-boundary fallback UIs. */
export function setDisableExtensionHandler(fn) {
  disableHandler = typeof fn === 'function' ? fn : null;
}

/** Build a nested replacement chain so each extension wrapper runs inside its own ErrorBoundary. */
function renderWithReplacements(slot, itemId, baseRender, replacements, context, onDisable) {
  let innerDefault = (extraProps) =>
    baseRender(extraProps ? { ...context, ...extraProps } : context);
  for (let i = 0; i < replacements.length; i++) {
    const rep = replacements[i];
    const prevDefault = innerDefault;
    const DefaultComp = (props) => prevDefault(props);
    innerDefault = (extraProps) =>
      html`<${ExtensionBoundary}
        key=${`${itemId}:rep:${i}:${rep.extId}`}
        extId=${rep.extId}
        slot=${slot}
        onDisable=${onDisable}
        render=${rep.render}
        ctx=${{ ...context, ...(extraProps || {}), Default: DefaultComp }}
      />`;
  }
  return innerDefault();
}

/**
 * Render an ordered list of named items for `slot`, reconciled with extensions and `ui.slots[slot]`.
 * Returns a `Fragment` (no wrapper DOM node).
 */
export function SectionList({ slot, items, context = {}, onDisable }) {
  const disable = onDisable ?? disableHandler;
  const resolved = sectionItems(slot, items);
  return html`<${Fragment}>${resolved.map((item) => {
    if (item._replacements?.length) {
      return html`<${Fragment} key=${item.id}>${renderWithReplacements(
        slot,
        item.id,
        item.render,
        item._replacements,
        context,
        disable,
      )}</${Fragment}>`;
    }
    if (item.extId) {
      return html`<${ExtensionBoundary}
        key=${item.id}
        extId=${item.extId}
        slot=${slot}
        onDisable=${disable}
        render=${item.render}
        ctx=${context}
      />`;
    }
    return html`<${Fragment} key=${item.id}>${item.render(context)}</${Fragment}>`;
  })}</${Fragment}>`;
}

/**
 * Wrap a single built-in block so extensions can inject `before`, `after`, `replace` (with `Default`), or `hide`.
 * Returns a `Fragment` (no wrapper DOM node).
 */
export function SectionSlot({ name, context = {}, children, onDisable }) {
  const disable = onDisable ?? disableHandler;
  const { before, replace, after, hidden } = sectionSlotExtensions(name);
  if (hidden) return null;
  const body =
    replace.length > 0
      ? renderWithReplacements(name, name, () => children, replace, context, disable)
      : children;
  return html`<${Fragment}>
    ${before.map(
      (ext) => html`<${ExtensionBoundary}
        key=${ext.id}
        extId=${ext.extId}
        slot=${name}
        onDisable=${disable}
        render=${ext.render}
        ctx=${context}
      />`,
    )}
    ${body}
    ${after.map(
      (ext) => html`<${ExtensionBoundary}
        key=${ext.id}
        extId=${ext.extId}
        slot=${name}
        onDisable=${disable}
        render=${ext.render}
        ctx=${context}
      />`,
    )}
  </${Fragment}>`;
}
