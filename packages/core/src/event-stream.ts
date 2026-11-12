/**
 * @atlas
 * @kind service
 * @partOf primitive:signals
 */
import type { ActionPrompt } from './action-prompt';
import type { LifecycleEvent } from './cache-lifecycle';
import type { DispatchContext } from './middleware';
import type { Signal } from './signal';
import type { Dispatch } from './thread';

/** Session lifecycle events (minimal type for event stream). */
export interface SessionEvent {
  readonly type: 'thread:added' | 'thread:removed' | 'thread:spawned';
  readonly threadId: string;
  readonly parentId?: string;
  readonly timestamp: number;
}

/**
 * Every observable event in the system, tagged by origin.
 */
export type StreamEvent =
  | {
      kind: 'journal';
      threadId: string;
      turnId: string | null;
      projectId?: string;
      timestamp: number;
      scope?: 'phase' | 'learning';
      outcome?: 'durable' | 'failed';
    }
  | { kind: 'layer'; threadId: string; event: LifecycleEvent }
  | { kind: 'dispatch'; threadId: string; dispatch: Dispatch }
  | { kind: 'signal'; threadId: string; signal: Signal }
  | { kind: 'prompt'; threadId: string; prompt: ActionPrompt }
  | { kind: 'session'; event: SessionEvent }
  | { kind: 'middleware'; threadId: string; phase: 'before' | 'after'; context: DispatchContext }
  | {
      kind: 'error';
      source: string;
      message: string;
      severity: 'error' | 'warn';
      timestamp: number;
    }
  | ({ kind: 'activity'; timestamp: number } & SystemActivity);

export type ActivityEvent = Extract<StreamEvent, { kind: 'activity' }>;

/**
 * What the system is doing around a thread, not in it (Aron, 2026-11-11): a project's Wardens
 * starting, a decision process restarting, a rate limit. The viewer keeps the latest per `key`
 * and shows it above the composer; `error` events stay for what failed and needs the person.
 */
export interface SystemActivity {
  /** One thing that changes over time ("project-wardens:<projectId>"); a later event replaces it. */
  readonly key: string;
  readonly source: string;
  /** The project it concerns; absent when it touches every thread (a login's rate limit). */
  readonly projectId?: string;
  /** `idle` is kept for the log only; the others show, in the status colours. */
  readonly state: 'working' | 'ready' | 'degraded' | 'failed' | 'idle';
  /** Shown until then unless a later event of the same key replaces it (a rate limit's end). */
  readonly until?: number;
  /** One plain sentence for the person. */
  readonly summary: string;
  /** The technical line, for the expanded log. */
  readonly detail: string;
}

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
  /** The latest activity of each key, kept past the history bound: a failure stays until it clears. */
  private _activities = new Map<string, ActivityEvent>();
  private _maxHistory: number;

  constructor(maxHistory: number = 5000) {
    this._maxHistory = maxHistory;
  }

  /** Push an event into the stream. */
  push(event: StreamEvent): void {
    if (event.kind === 'activity') {
      this._activities.delete(event.key);
      this._activities.set(event.key, event);
    }
    this._history.push(event);
    if (this._history.length > this._maxHistory) {
      this._history.shift();
    }

    // Snapshot to avoid mutation during iteration (listener may unsubscribe)
    const listeners = [...this._listeners];
    for (const listener of listeners) {
      try {
        listener(event);
      } catch (err) {
        console.warn('[EventStream] listener error:', (err as Error).message ?? err);
      }
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
    kind?: StreamEvent['kind'];
    threadId?: string;
    limit?: number;
  }): ReadonlyArray<StreamEvent> {
    let events: StreamEvent[] = this._history;

    if (opts?.kind) {
      events = events.filter((e) => e.kind === opts.kind);
    }

    if (opts?.threadId) {
      events = events.filter((e) => {
        if (e.kind === 'session') return true; // session events are global
        return 'threadId' in e && e.threadId === opts.threadId;
      });
    }

    const limit = opts?.limit ?? 100;
    return events.slice(-limit);
  }

  /** Push an error event — surfaced as a toast in the viewer UI. */
  pushError(source: string, message: string, severity: 'error' | 'warn' = 'error'): void {
    this.push({ kind: 'error', source, message, severity, timestamp: Date.now() });
  }

  /** Push what the system is doing (shown above the composer, never as a toast). */
  pushActivity(activity: SystemActivity): void {
    this.push({ kind: 'activity', ...activity, timestamp: Date.now() });
  }

  /** The latest activity of every key, oldest first. */
  activities(): ActivityEvent[] {
    return [...this._activities.values()];
  }

  /** Clear history. */
  clear(): void {
    this._history = [];
    this._activities.clear();
  }
}
