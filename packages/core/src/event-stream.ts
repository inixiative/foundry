/**
 * @atlas
 * @kind service
 * @partOf primitive:signals
 */
import type { ActionPrompt } from './action-prompt';
import type { LifecycleEvent } from './cache-lifecycle';
import type { Signal } from './signal';

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
  | { kind: 'signal'; threadId: string; signal: Signal }
  | { kind: 'prompt'; threadId: string; prompt: ActionPrompt }
  | { kind: 'session'; event: SessionEvent }
  | {
      kind: 'error';
      source: string;
      message: string;
      severity: 'error' | 'warn';
      timestamp: number;
      /** The thread the error is about, when it is one thread's (the viewer shows it on that thread). */
      threadId?: string;
    }
  | ({
      kind: 'activity';
      timestamp: number;
      /**
       * When this key's current outage began (degraded or failed since then without recovering);
       * absent when it is not in an outage. The viewer advises each thread of an outage once.
       */
      outageStartedAt?: number;
    } & SystemActivity);

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

/** How long after its `until` an outage still counts as the same one: a rate limit's next attempt lands after it. */
export const OUTAGE_GRACE_MS = 5 * 60_000;

/**
 * When the outage `event` belongs to began, or undefined when it is in none. Degraded or failed starts
 * one; a later degraded, failed or working event of the key (a retry) stays in it. It ends on ready or
 * idle, or once `OUTAGE_GRACE_MS` has passed since its `until` with nothing to say it went on.
 */
function outageStartedAt(
  event: ActivityEvent,
  before: ActivityEvent | undefined,
): number | undefined {
  if (event.state === 'ready' || event.state === 'idle') return undefined;
  const began = before?.outageStartedAt;
  const until = before?.until;
  if (began !== undefined && (until === undefined || event.timestamp < until + OUTAGE_GRACE_MS))
    return began;
  return event.state === 'working' ? undefined : event.timestamp;
}

/** What one stored event may hold: the stream is a log for viewers, not the signals' record (the SignalBus keeps those). */
export const EVENT_BOUNDS = { string: 2_000, items: 50, depth: 10 } as const;

/** A cycle or unsupported value found while copying an event: where, so its emitter can be fixed. */
export interface EventCopyProblem {
  readonly path: string;
  readonly problem: 'cycle' | 'depth';
}

/**
 * A JSON-safe, bounded copy of `value`: strings cut to `EVENT_BOUNDS.string`, arrays to
 * `EVENT_BOUNDS.items`, nesting to `EVENT_BOUNDS.depth`; a cycle becomes "[cycle]", a function or
 * symbol is dropped, a bigint becomes its digits and anything with `toJSON` is copied as that.
 * Every cycle or depth cut is reported with its path.
 */
export function boundedPlainCopy(
  value: unknown,
  report: (problem: EventCopyProblem) => void = () => {},
): unknown {
  const ancestors = new Set<object>();
  const copy = (item: unknown, path: string, depth: number): unknown => {
    if (typeof item === 'string')
      return item.length > EVENT_BOUNDS.string
        ? `${item.slice(0, EVENT_BOUNDS.string)}… [+${item.length - EVENT_BOUNDS.string} chars]`
        : item;
    if (typeof item === 'number') return Number.isFinite(item) ? item : null;
    if (item === null || typeof item === 'boolean') return item;
    if (typeof item === 'bigint') return item.toString();
    if (typeof item !== 'object') return undefined;
    if (ancestors.has(item)) {
      report({ path, problem: 'cycle' });
      return '[cycle]';
    }
    if (depth >= EVENT_BOUNDS.depth) {
      report({ path, problem: 'depth' });
      return '[too deep]';
    }
    const json = (item as { toJSON?: unknown }).toJSON;
    if (typeof json === 'function') return copy(json.call(item), path, depth);
    ancestors.add(item);
    try {
      if (Array.isArray(item)) {
        const kept = item
          .slice(0, EVENT_BOUNDS.items)
          .map((entry, i) => copy(entry, `${path}[${i}]`, depth + 1) ?? null);
        if (item.length > EVENT_BOUNDS.items)
          kept.push(`… [+${item.length - EVENT_BOUNDS.items} items]`);
        return kept;
      }
      if (item instanceof Error)
        return { name: item.name, message: copy(item.message, path, depth) };
      const out: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(item)) {
        const kept = copy(entry, `${path}.${key}`, depth + 1);
        if (kept !== undefined) out[key] = kept;
      }
      return out;
    } finally {
      ancestors.delete(item);
    }
  };
  return copy(value, '', 0);
}

/** How many distinct problem sites are warned about before the stream goes quiet. */
const MAX_WARNED_SITES = 200;

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

  /** Problem sites already warned about, by event, signal kind, source and path. */
  private _warned = new Set<string>();

  /**
   * Push an event into the stream. What is kept, and handed to listeners, is a bounded plain copy
   * (`boundedPlainCopy`): emitters hand over live objects, and a viewer must always be able to
   * serialize what it reads. A cycle is warned once per site, naming its path.
   */
  push(given: StreamEvent): void {
    let event = boundedPlainCopy(given, ({ path, problem }) => {
      const signal = given.kind === 'signal' ? given.signal : undefined;
      const site = `${given.kind}:${signal?.kind ?? ''}:${signal?.source ?? ''}:${path}`;
      if (this._warned.has(site) || this._warned.size >= MAX_WARNED_SITES) return;
      this._warned.add(site);
      console.warn(`[EventStream] ${problem} at ${site} (copied as a placeholder)`);
    }) as StreamEvent;
    if (event.kind === 'activity') {
      const before = this._activities.get(event.key);
      const { outageStartedAt: _given, ...fresh } = event;
      const started = outageStartedAt(event, before);
      event = started === undefined ? fresh : { ...fresh, outageStartedAt: started };
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
    /** Any further condition; scanned newest first, so a bounded read stops at its limit. */
    where?: (event: StreamEvent) => boolean;
    limit?: number;
  }): ReadonlyArray<StreamEvent> {
    const limit = opts?.limit !== undefined && opts.limit > 0 ? opts.limit : 100;
    const kept: StreamEvent[] = [];
    for (let i = this._history.length - 1; i >= 0 && kept.length < limit; i--) {
      const e = this._history[i];
      if (opts?.kind && e.kind !== opts.kind) continue;
      // Session events are global.
      if (
        opts?.threadId &&
        e.kind !== 'session' &&
        !('threadId' in e && e.threadId === opts.threadId)
      )
        continue;
      if (opts?.where && !opts.where(e)) continue;
      kept.push(e);
    }
    return kept.reverse();
  }

  /** Push an error event — surfaced as a toast in the viewer UI, on its thread when it names one. */
  pushError(
    source: string,
    message: string,
    severity: 'error' | 'warn' = 'error',
    threadId?: string,
  ): void {
    this.push({
      kind: 'error',
      source,
      message,
      severity,
      timestamp: Date.now(),
      ...(threadId ? { threadId } : {}),
    });
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
