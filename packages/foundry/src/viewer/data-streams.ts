import type { ActionPrompt, ActionQueue, EventStream, StreamEvent, Thread } from "@inixiative/foundry-core";
import type { StreamFamily } from "../ws/types";
import { threadToJSON } from "./http-helpers";
import { StreamBufferRegistry, type StreamBufferSnapshot, type TurnAppend } from "./stream-buffer";
import type { ViewerThreadDirectory } from "./thread-directory";
import { FLOW_TURNS, flowSnapshot, readLearning, readTurn, type FlowJournal } from "./turn-flow";

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
 *   flow:<threadId>     snapshot { threadId, journal, turns, learning, knowledge, review, learningError, limits }  (bounded; see turn-flow.ts)
 *                       append   { kind: 'turn', turn } | { kind: 'learning', entries } | { kind: 'knowledge', knowledge, review, learningError }
 */
export type ThreadAppend = TurnAppend | { kind: "event"; event: StreamEvent };
export type TurnTerminal = { kind: "done" | "error"; turnId: string; result: Record<string, unknown> };

export interface ThreadSnapshot { threadId: string; projectId?: string; turns: StreamBufferSnapshot[] }

const EVENT_HISTORY = 200;
/** Journal notices arrive in bursts (every native observation); a flow stream re-reads at most this often. */
const FLOW_SETTLE_MS = 250;
/** An unreadable turn is re-read this many times, this far apart, before it is sent as unreadable. */
const FLOW_READ_ATTEMPTS = 3;
const FLOW_RETRY_MS = 2000;

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
  /** The owned journal behind `flow:<threadId>`; without a store the stream reports it unavailable. */
  journal?: FlowJournal;
}) {
  const { directory, eventStream, actionQueue, deliverTo } = deps;
  const journal: FlowJournal = deps.journal ?? { store: null };
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

  // Graph panel: a thread's recent turns as recorded flows, its learning history and knowledge revisions.
  // Journal notices name the turn that changed; each settle re-reads only those turns and sends what differs.
  // Review status and committed revisions are re-read on every settle: some review changes (queue growth,
  // admission) carry no journal notice of their own, only the thread's signals.
  const flow: StreamFamily = {
    matches: stream => suffix(stream, "flow:") !== null,
    authorize: stream => !!directory.get(suffix(stream, "flow:")!),
    start(stream, append) {
      const threadId = suffix(stream, "flow:")!;
      // What the holders have: turn text by id (the newest FLOW_TURNS, oldest first) with start times.
      const sentTurns = new Map<string, { text: string; startedAt: number | null }>();
      let sentLearning = new Set<string>();
      let sentKnowledge = "";
      const dirtyTurns = new Set<string>();
      const failures = new Map<string, number>();
      let learningDirty = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const record = (turnId: string, text: string, startedAt: number | null) => {
        sentTurns.delete(turnId);
        sentTurns.set(turnId, { text, startedAt });
        while (sentTurns.size > FLOW_TURNS) sentTurns.delete(sentTurns.keys().next().value!);
      };
      // A turn older than everything in a full window is outside it; the holders would only drop it.
      const outsideWindow = (turnId: string, startedAt: number | null) => sentTurns.size >= FLOW_TURNS && !sentTurns.has(turnId)
        && startedAt !== null && [...sentTurns.values()].every(t => t.startedAt !== null && t.startedAt > startedAt);
      const settle = () => {
        if (timer) clearTimeout(timer);
        timer = null;
        const store = journal.store;
        if (!store) { dirtyTurns.clear(); learningDirty = false; return; }
        const retry: string[] = [];
        for (const turnId of [...dirtyTurns].slice(-FLOW_TURNS)) {
          const read = readTurn(store, threadId, turnId);
          if (!read) continue;
          if (!read.ok) {
            // A transient read failure retries; a row that stays unreadable is shown as unreadable.
            const count = (failures.get(turnId) ?? 0) + 1;
            failures.set(turnId, count);
            if (count < FLOW_READ_ATTEMPTS) { retry.push(turnId); continue; }
          } else failures.delete(turnId);
          const text = JSON.stringify(read.turn);
          if (sentTurns.get(turnId)?.text === text || outsideWindow(turnId, read.turn.startedAt)) continue;
          record(turnId, text, read.turn.startedAt);
          append({ kind: "turn", turn: read.turn });
        }
        dirtyTurns.clear();
        for (const turnId of retry) dirtyTurns.add(turnId);
        const learning = readLearning(journal, threadId, learningDirty);
        if (learningDirty && !learning.learningError) {
          const entries = learning.learning.filter(entry => !sentLearning.has(entry.signal.id));
          sentLearning = new Set(learning.learning.map(entry => entry.signal.id));
          if (entries.length) append({ kind: "learning", entries });
        }
        learningDirty = !!learning.learningError && learningDirty;
        const knowledge = { knowledge: learning.knowledge, review: learning.review, learningError: learning.learningError };
        const text = JSON.stringify(knowledge);
        if (text !== sentKnowledge) { sentKnowledge = text; append({ kind: "knowledge", ...knowledge }); }
        if (dirtyTurns.size) timer = setTimeout(settle, FLOW_RETRY_MS);
      };
      const schedule = () => { timer ??= setTimeout(settle, FLOW_SETTLE_MS); };
      const unsubscribe = eventStream.subscribe(event => {
        if (eventThread(event) !== threadId) return;
        if (event.kind === "journal") {
          if (event.scope === "learning") learningDirty = true;
          else if (event.turnId) dirtyTurns.add(event.turnId);
          schedule();
        } else if (event.kind === "signal") {
          if (event.signal.kind === "domain_learning") learningDirty = true;
          schedule();
        }
      });
      return {
        // A later opener joins a running stream: current changes, noticed or not, go to the holders first,
        // so the new snapshot never records as sent a change they have not received.
        snapshot() {
          if (sentTurns.size || sentKnowledge) settle();
          const snapshot = flowSnapshot(journal, threadId);
          for (const turn of snapshot.turns) record(turn.turnId, JSON.stringify(turn), turn.startedAt);
          sentLearning = new Set(snapshot.learning.map(entry => entry.signal.id));
          sentKnowledge = JSON.stringify({ knowledge: snapshot.knowledge, review: snapshot.review, learningError: snapshot.learningError });
          return snapshot;
        },
        stop() { unsubscribe(); if (timer) clearTimeout(timer); timer = null; },
      };
    },
  };

  return {
    turns,
    families: [thread, threads, prompts, events, flow],
    /** Deliver a turn's full terminal to the client that sent it, on whichever of its connections holds the thread stream. */
    publishTerminal: (threadId: string, clientId: string | undefined, payload: TurnTerminal) => {
      if (clientId) deliverTo(clientId, `thread:${threadId}`, payload);
    },
    /** A thread was created, renamed or re-homed outside the event stream. */
    threadsChanged: (threadId?: string) => { for (const sync of threadLists) sync(threadId); },
  };
}

export type ViewerStreams = ReturnType<typeof createViewerStreams>;
