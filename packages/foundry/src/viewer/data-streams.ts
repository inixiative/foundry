import type { ActionPrompt, ActionQueue, EventStream, StreamEvent, Thread } from "@inixiative/foundry-core";
import type { StreamFamily } from "../ws/types";
import { threadToJSON } from "./http-helpers";
import { StreamBufferRegistry, type StreamBufferSnapshot, type TurnAppend } from "./stream-buffer";
import type { ViewerThreadDirectory } from "./thread-directory";

/**
 * The viewer's data streams. Each panel opens exactly what it shows:
 *
 *   thread:<threadId>   snapshot { threadId, projectId, turns: StreamBufferSnapshot[] }
 *                       append   { kind: 'turn', turn } | { kind: 'delta', turnId, text }
 *                                | { kind: 'activity', turnId, row }
 *                                | { kind: 'event', event }  (journal/learning/dispatch changes to reconcile history)
 *                                | { kind: 'done' | 'error', turnId, result }  to the sending client (tab) only: the
 *                                  full result carries provider input; everyone else sees the bounded turn
 *   threads             snapshot { projectId: null, threads }     append { thread } | { removed: threadId }
 *   threads:<projectId> snapshot { projectId, threads }           append { thread } | { removed: threadId }
 *   prompts             snapshot { prompts }                      append { prompt }  (status says pending or settled)
 *   events              snapshot { events }  (runtime-wide)       append { event }
 *   events:<threadId>   snapshot { events }  (owned by thread)    append { event }  (plus threadless errors, for toasts)
 */
export type ThreadAppend = TurnAppend | { kind: "event"; event: StreamEvent };
export type TurnTerminal = { kind: "done" | "error"; turnId: string; result: Record<string, unknown> };

export interface ThreadSnapshot { threadId: string; projectId?: string; turns: StreamBufferSnapshot[] }

const EVENT_HISTORY = 200;

/** The thread an event belongs to, as the inspector's activity panel reads it. */
export function eventThread(event: StreamEvent): string | undefined {
  if (event.kind === "session") return event.event.threadId;
  return "threadId" in event ? event.threadId : undefined;
}

/** Events that change a thread's durable history, learning or selected turn detail. */
function reconcilable(event: StreamEvent): boolean {
  return event.kind === "journal"
    || (event.kind === "signal" && (event.signal.kind === "dispatch" || event.signal.kind === "domain_learning"));
}

const suffix = (stream: string, prefix: string) => stream.startsWith(prefix) ? stream.slice(prefix.length) : null;

export function createViewerStreams(deps: {
  directory: ViewerThreadDirectory;
  eventStream: EventStream;
  actionQueue?: ActionQueue;
  /** Deliver to one client's connections that hold the stream (the socket's appendTo). */
  deliverTo: (clientId: string, stream: string, payload: TurnTerminal) => void;
}) {
  const { directory, eventStream, actionQueue, deliverTo } = deps;
  const threadSinks = new Map<string, (payload: ThreadAppend) => void>();
  const turns = new StreamBufferRegistry({
    active: threadId => threadSinks.has(threadId),
    publish: (threadId, payload) => threadSinks.get(threadId)?.(payload),
  });
  const threadLists = new Set<(threadId?: string) => void>();

  const thread: StreamFamily = {
    matches: stream => suffix(stream, "thread:") !== null,
    authorize: stream => !!directory.get(suffix(stream, "thread:")!),
    start(stream, append) {
      const threadId = suffix(stream, "thread:")!;
      threadSinks.set(threadId, append);
      const unsubscribe = eventStream.subscribe(event => {
        if (eventThread(event) === threadId && reconcilable(event)) append({ kind: "event", event });
      });
      return {
        snapshot: (): ThreadSnapshot => ({ threadId, projectId: directory.get(threadId)?.meta.projectId, turns: turns.forThread(threadId) }),
        stop() { threadSinks.delete(threadId); unsubscribe(); },
      };
    },
  };

  const threads: StreamFamily = {
    matches: stream => stream === "threads" || suffix(stream, "threads:") !== null,
    authorize: stream => directory.scope(suffix(stream, "threads:") ?? undefined) !== undefined,
    start(stream, append) {
      const projectId = suffix(stream, "threads:");
      const scope = () => directory.scope(projectId ?? undefined) ?? [];
      // What subscribers already hold, so a change is sent once and an unchanged thread never.
      const sent = new Map<string, { text: string; json: ReturnType<typeof threadToJSON> }>();
      const sync = (only?: string) => {
        const current = new Map<string, Thread>(scope().map(t => [t.id, t]));
        for (const id of only ? [only] : new Set([...sent.keys(), ...current.keys()])) {
          const found = current.get(id);
          if (!found) { if (sent.delete(id)) append({ removed: id }); continue; }
          const json = threadToJSON(found), text = JSON.stringify(json);
          if (sent.get(id)?.text === text) continue;
          sent.set(id, { text, json });
          append({ thread: json });
        }
      };
      threadLists.add(sync);
      const unsubscribe = eventStream.subscribe(event => { const id = eventThread(event); if (id) sync(id); });
      return {
        snapshot() {
          sync();
          return { projectId, threads: scope().map(t => sent.get(t.id)!.json) };
        },
        stop() { threadLists.delete(sync); unsubscribe(); },
      };
    },
  };

  const prompts: StreamFamily = {
    matches: stream => stream === "prompts",
    authorize: () => true,
    start(_stream, append) {
      const send = (prompt: ActionPrompt) => append({ prompt });
      const offs = actionQueue ? [actionQueue.onPrompt(send), actionQueue.onSettle(send)] : [];
      return {
        snapshot: () => ({ prompts: actionQueue?.pending() ?? [] }),
        stop() { for (const off of offs) off(); },
      };
    },
  };

  const events: StreamFamily = {
    matches: stream => stream === "events" || suffix(stream, "events:") !== null,
    authorize: stream => stream === "events" || !!directory.get(suffix(stream, "events:")!),
    start(stream, append) {
      const threadId = suffix(stream, "events:");
      const owned = (event: StreamEvent) => threadId === null || eventThread(event) === threadId;
      // Runtime errors name no thread; a thread-scoped viewer still has to hear them.
      const unsubscribe = eventStream.subscribe(event => {
        if (owned(event) || event.kind === "error") append({ event });
      });
      return {
        snapshot: () => ({ events: eventStream.recent({ limit: Number.MAX_SAFE_INTEGER }).filter(owned).slice(-EVENT_HISTORY) }),
        stop: unsubscribe,
      };
    },
  };

  return {
    turns,
    families: [thread, threads, prompts, events],
    /** Deliver a turn's full terminal to the client that sent it, on whichever of its connections holds the thread stream. */
    publishTerminal: (threadId: string, clientId: string | undefined, payload: TurnTerminal) => {
      if (clientId) deliverTo(clientId, `thread:${threadId}`, payload);
    },
    /** A thread was created, renamed or re-homed outside the event stream. */
    threadsChanged: (threadId?: string) => { for (const sync of threadLists) sync(threadId); },
  };
}

export type ViewerStreams = ReturnType<typeof createViewerStreams>;
