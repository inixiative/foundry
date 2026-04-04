import { ContextLayer, type LayerState } from "./context-layer";
import { ContextStack } from "./context-stack";

export interface LifecycleEvent {
  readonly type: string;
  readonly layerId: string;
  readonly timestamp: number;
  readonly meta?: Record<string, unknown>;
}

export type LifecycleHandler = (
  event: LifecycleEvent
) => void | false | Promise<void | false>;

/**
 * A rule that triggers actions based on layer state.
 * Rules are the extension point — callers define what triggers what.
 */
export interface LifecycleRule {
  readonly id: string;
  readonly triggers: LayerState[];
  readonly layerIds?: string[];
  action(
    layer: ContextLayer,
    state: LayerState,
    stack: ContextStack
  ): Promise<void>;
}

/**
 * Manages the lifecycle of layers within a stack.
 *
 * This is the "when things happen" primitive. It doesn't decide
 * what triggers matter — you register rules that do.
 */
export class CacheLifecycle {
  private _stack: ContextStack;
  private _rules: LifecycleRule[] = [];
  private _handlers: Map<string, LifecycleHandler[]> = new Map();
  private _unsubscribes: Array<() => void> = [];
  private _running = false;

  constructor(stack: ContextStack) {
    this._stack = stack;
  }

  // -- Rules --

  addRule(rule: LifecycleRule): void {
    this._rules.push(rule);
  }

  removeRule(id: string): boolean {
    const idx = this._rules.findIndex((r) => r.id === id);
    if (idx === -1) return false;
    this._rules.splice(idx, 1);
    return true;
  }

  // -- Event handlers --

  on(eventType: string, handler: LifecycleHandler): () => void {
    if (!this._handlers.has(eventType)) {
      this._handlers.set(eventType, []);
    }
    this._handlers.get(eventType)!.push(handler);

    return () => {
      const handlers = this._handlers.get(eventType);
      if (handlers) {
        const idx = handlers.indexOf(handler);
        if (idx !== -1) handlers.splice(idx, 1);
      }
    };
  }

  async emit(event: LifecycleEvent): Promise<void> {
    const handlers = this._handlers.get(event.type) ?? [];
    for (const handler of handlers) {
      const result = await handler(event);
      if (result === false) break;
    }
  }

  // -- Activation --

  start(): void {
    if (this._running) return;
    this._running = true;

    for (const layer of this._stack.layers) {
      this._observe(layer);
    }
  }

  stop(): void {
    this._running = false;
    for (const unsub of this._unsubscribes) {
      unsub();
    }
    this._unsubscribes = [];
  }

  observe(layer: ContextLayer): void {
    if (this._running) {
      this._observe(layer);
    }
  }

  // -- Internal --

  private _observe(layer: ContextLayer): void {
    const unsub = layer.onStateChange(async (state, l) => {
      await this.emit({
        type: `layer:${state}`,
        layerId: l.id,
        timestamp: Date.now(),
      });

      for (const rule of this._rules) {
        if (!rule.triggers.includes(state)) continue;
        if (rule.layerIds && !rule.layerIds.includes(l.id)) continue;

        await rule.action(l, state, this._stack);
      }
    });

    this._unsubscribes.push(unsub);
  }
}
