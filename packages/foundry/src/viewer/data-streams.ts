import type { ActionPrompt, ActionQueue, EventStream, StreamEvent, Thread } from "@inixiative/foundry-core";
import type { StreamFamily } from "../ws/types";
import { threadToJSON } from "./http-helpers";
import { StreamBufferRegistry, type StreamBufferSnapshot, type TurnAppend } from "./stream-buffer";
import type { ViewerThreadDirectory } from "./thread-directory";
import { FLOW_LEARNING, FLOW_TURNS, flowSnapshot, slimKnowledge, slimLearning, slimReview, slimTurn, type FlowJournal } from "./turn-flow";

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
 *   flow:<threadId>     snapshot { threadId, journal, turns, learning, knowledge, review, limits }  (bounded; see turn-flow.ts)
 *                       append   { kind: 'turn', turn } | { kind: 'learning', entries } | { kind: 'knowledge', knowledge, review }
 */
export type ThreadAppend = TurnAppend | { kind: "event"; event: StreamEvent };
export type TurnTerminal = { kind: "done" | "error"; turnId: string; result: Record<string, unknown> };

export interface ThreadSnapshot { threadId: string; projectId?: string; turns: StreamBufferSnapshot[] }

const EVENT_HISTORY = 200;
/** Journal notices arrive in bursts (every native observation); a flow stream re-reads at most this often. */
const FLOW_SETTLE_MS = 250;

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
  const flow: StreamFamily = {
    matches: stream => suffix(stream, "flow:") !== null,
    authorize: stream => !!directory.get(suffix(stream, "flow:")!),
    start(stream, append) {
      const threadId = suffix(stream, "flow:")!;
      const sentTurns = new Map<string, string>();
      // Learning ids within the history window last read; older ids fall out with the window.
      let sentLearning = new Set<string>();
      let sentKnowledge = "";
      const dirtyTurns = new Set<string>();
      let learningDirty = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const knowledgeNow = () => {
        const knowledge = slimKnowledge(journal.store!.knowledge(threadId)), review = slimReview(journal.learningState?.(threadId));
        return { knowledge, review, text: JSON.stringify({ knowledge, review }) };
      };
      const settle = () => {
        timer = null;
        const store = journal.store;
        if (!store) return;
        try {
          for (const turnId of [...dirtyTurns].slice(-FLOW_TURNS)) {
            const detail = store.turnDetail(threadId, turnId);
            if (!detail) continue;
            const turn = slimTurn(detail), text = JSON.stringify(turn);
            if (sentTurns.get(turnId) === text) continue;
            sentTurns.delete(turnId);
            sentTurns.set(turnId, text);
            while (sentTurns.size > FLOW_TURNS) sentTurns.delete(sentTurns.keys().next().value!);
            append({ kind: "turn", turn });
          }
          if (learningDirty) {
            const history = store.learningHistory(threadId, FLOW_LEARNING);
            const entries = history.filter(entry => !sentLearning.has(entry.signal.id));
            sentLearning = new Set(history.map(entry => entry.signal.id));
            if (entries.length) append({ kind: "learning", entries: entries.map(slimLearning) });
            const next = knowledgeNow();
            if (next.text !== sentKnowledge) { sentKnowledge = next.text; append({ kind: "knowledge", knowledge: next.knowledge, review: next.review }); }
          }
        } catch { /* An unreadable journal row is reported by the next snapshot; the next notice retries. */ }
        finally { dirtyTurns.clear(); learningDirty = false; }
      };
      const schedule = () => { timer ??= setTimeout(settle, FLOW_SETTLE_MS); };
      const unsubscribe = eventStream.subscribe(event => {
        if (eventThread(event) !== threadId) return;
        if (event.kind === "journal") {
          if (event.scope === "learning") learningDirty = true;
          else if (event.turnId) dirtyTurns.add(event.turnId);
          schedule();
        } else if (event.kind === "signal" && event.signal.kind === "domain_learning") {
          learningDirty = true;
          schedule();
        }
      });
      return {
        // A later opener joins a running stream: pending changes go to the holders first, so the new
        // snapshot never records as sent a change they have not received.
        snapshot() {
          if (timer) { clearTimeout(timer); settle(); }
          const snapshot = flowSnapshot(journal, threadId);
          for (const turn of snapshot.turns) sentTurns.set(turn.turnId, JSON.stringify(turn));
          while (sentTurns.size > FLOW_TURNS) sentTurns.delete(sentTurns.keys().next().value!);
          sentLearning = new Set(snapshot.learning.map(entry => entry.signal.id));
          sentKnowledge = JSON.stringify({ knowledge: snapshot.knowledge, review: snapshot.review });
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
