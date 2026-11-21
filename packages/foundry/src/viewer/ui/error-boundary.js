/**
 * @atlas
 * @kind utils
 * @partOf feature:viewer
 */
/**
 * Crash isolation for local UI extensions:
 * - `SlotRenderer` executes an extension's `render(ctx)` inside its own Preact component so
 *   `ExtensionBoundary`'s `getDerivedStateFromError` / `componentDidCatch` actually catch render errors.
 * - `safeCall` guards non-render callbacks (`badge`, `info`, `effect`, `action`, `setup`).
 */

import { Component, Fragment, html } from './lib.js';

/**
 * Safely invoke an extension callback without letting sync throws or async rejections escape.
 * @template T
 * @template [F=undefined]
 * @param {string} extId
 * @param {(() => T) | null | undefined} fn
 * @param {F} [fallback]
 * @param {string} [label]
 * @returns {T | F}
 */
export function safeCall(extId, fn, fallback = /** @type {F} */ (undefined), label = 'callback') {
  if (typeof fn !== 'function') return fallback;
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      return result.catch((error) => {
        console.warn(`[foundry-ui] extension "${extId}" ${label} rejected:`, error);
        return fallback;
      });
    }
    return result;
  } catch (error) {
    console.warn(`[foundry-ui] extension "${extId}" ${label} threw:`, error);
    return fallback;
  }
}

/** Child component that evaluates an extension render function so parent error boundaries catch throws. */
export function SlotRenderer({ fn, ctx }) {
  if (typeof fn !== 'function') return null;
  return fn(ctx) ?? null;
}

/**
 * Per-slot Preact ErrorBoundary isolating extension render failures.
 * Shows `.ext-error-fallback` with Retry (bumps `retryKey` to force remount) and optional Disable.
 */
export class ExtensionBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null, retryKey: 0 };
    this.handleRetry = this.handleRetry.bind(this);
    this.handleDisable = this.handleDisable.bind(this);
  }

  static getDerivedStateFromError(error) {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error, info) {
    console.warn(
      `[foundry-ui] extension "${this.props.extId}" crashed in "${this.props.slot}":`,
      error,
      info,
    );
    this.props.onError?.(error);
  }

  handleRetry() {
    this.setState((prev) => ({ error: null, retryKey: prev.retryKey + 1 }));
  }

  handleDisable() {
    this.props.onDisable?.(this.props.extId);
  }

  render() {
    const { extId, slot, render: renderFn, ctx, onDisable, children } = this.props;
    const { error, retryKey } = this.state;
    if (error) {
      return html`<div class="ext-error-fallback" role="alert" data-ext-id=${extId || ''} data-slot=${slot || ''}>
        <span class="ext-error-label">Extension <code>${extId || 'unknown'}</code> failed</span>
        <span class="ext-error-msg" title=${error.message}>${error.message}</span>
        <span class="ext-error-actions">
          <button type="button" class="ext-error-btn" onClick=${this.handleRetry}>Retry</button>
          ${onDisable && extId ? html`<button type="button" class="ext-error-btn ext-error-btn--disable" onClick=${this.handleDisable}>Disable</button>` : null}
        </span>
      </div>`;
    }
    if (typeof renderFn === 'function') {
      return html`<${SlotRenderer} key=${retryKey} fn=${renderFn} ctx=${ctx} />`;
    }
    return html`<${Fragment} key=${retryKey}>${children}</${Fragment}>`;
  }
}
