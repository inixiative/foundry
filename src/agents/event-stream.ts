import type { LifecycleEvent } from "./cache-lifecycle";
import type { Dispatch } from "./thread";
import type { Signal } from "./signal";
import type { SessionEvent } from "./session";
import type { DispatchContext } from "./middleware";

/**
 * Every observable event in the system, tagged by origin.
 */
export type StreamEvent =
  | { kind: "layer"; threadId: string; event: LifecycleEvent }
  | { kind: "dispatch"; threadId: string; dispatch: Dispatch }
  | { kind: "signal"; threadId: string; signal: Signal }
  | { kind: "session"; event: SessionEvent }
  | { kind: "middleware"; threadId: string; phase: "before" | "after"; context: DispatchContext };

/**
 * Unified event stream across all threads and sessions.
 *
 * The UI subscribes to this — it's the single source of truth for
 * what's happening in the system. Every layer state change, every dispatch,
 * every signal, every thread spawn shows up here in order.
 *
 * Supports both push (subscribe) and pull (recent history) access patterns.
 */
export class EventStream {
  private _listeners: Array<(event: StreamEvent) => void> = [];
  private _history: StreamEvent[] = [];
  private _maxHistory: number;

  constructor(maxHistory: number = 5000) {
    this._maxHistory = maxHistory;
  }

  /** Push an event into the stream. */
  push(event: StreamEvent): void {
    this._history.push(event);
    if (this._history.length > this._maxHistory) {
      this._history.shift();
    }

    for (const listener of this._listeners) {
      listener(event);
    }
  }

  /** Subscribe to all events. Returns unsubscribe function. */
  subscribe(listener: (event: StreamEvent) => void): () => void {
    this._listeners.push(listener);
    return () => {
      const idx = this._listeners.indexOf(listener);
      if (idx !== -1) this._listeners.splice(idx, 1);
    };
  }

  /** Get recent events, optionally filtered by kind and/or thread. */
  recent(opts?: {
    kind?: StreamEvent["kind"];
    threadId?: string;
    limit?: number;
  }): ReadonlyArray<StreamEvent> {
    let events: StreamEvent[] = this._history;

    if (opts?.kind) {
      events = events.filter((e) => e.kind === opts.kind);
    }

    if (opts?.threadId) {
      events = events.filter((e) => {
        if (e.kind === "session") return true; // session events are global
        return "threadId" in e && e.threadId === opts.threadId;
      });
    }

    const limit = opts?.limit ?? 100;
    return events.slice(-limit);
  }

  /** Clear history. */
  clear(): void {
    this._history = [];
  }
}
