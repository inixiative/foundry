import type { NativeEvidence } from "@inixiative/foundry-core";
import type { LearningState, ThreadKnowledgeBundle } from "../agents/thread-runtime";
import type { LocalSessionStore, StoredLearning, TurnDetail } from "../persistence/local-session-store";

/**
 * Bounded projection of the owned journal for the viewer's graph panel (`flow:<threadId>`).
 * Recorded fields only, in the shapes the inspector already reads (phase rows, the sealed plan,
 * the delivery record, learning signals), minus the heavy payloads: provider request messages and
 * expert segments become counts, long text is clipped. The full record stays one click away on the
 * turn-detail route.
 */

export const FLOW_TURNS = 16;
export const FLOW_LEARNING = 200;
const MAX_TEXT = 600;
const MAX_ITEMS = 64;
const MAX_DEPTH = 8;

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const clip = (text: string, max = MAX_TEXT) => text.length > max ? `${text.slice(0, max)}…` : text;

/** A recorded provider request without its payload: status, identity and how many messages it held. */
function slimRequest(request: unknown): unknown {
  if (!isObject(request)) return request;
  const out: Record<string, unknown> = {};
  for (const key of ["status", "phase", "providerId", "capturedAt", "reason"]) if (request[key] !== undefined) out[key] = request[key];
  if (Array.isArray(request.messages)) out.messageCount = request.messages.length;
  return out;
}

/** Recursive copy with request payloads reduced, segment text replaced by its length, strings clipped and lists capped. */
export function slim(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return clip(value);
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_DEPTH) return "[depth]";
  if (Array.isArray(value)) return value.slice(0, MAX_ITEMS).map(item => slim(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === "request") out.request = slimRequest(item);
    else if (key === "segments" && isObject(item)) out.segments = Object.fromEntries(Object.entries(item).map(([k, v]) => [k, typeof v === "string" ? v.length : null]));
    else if (key === "messages" && Array.isArray(item)) out.messageCount = item.length;
    else out[key] = slim(item, depth + 1);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Task lists. The executor's own plan tools, recorded as public tool input on the
// turn's native history. A source maps one tool's input to { goal?, items }.
// Extension point: add a source here when another plan shape is journalled
// (e.g. the Planner agent's Plan once plans are recorded per turn).
// ---------------------------------------------------------------------------

export interface TaskItem { text: string; status: string }
export interface TaskList { source: string; observedAt: number | null; goal?: string; items: TaskItem[] }
type TaskSource = (input: Record<string, unknown>) => Omit<TaskList, "source" | "observedAt"> | null;

const text = (value: unknown) => typeof value === "string" ? clip(value, 200) : null;
const items = (list: unknown, label: string) => Array.isArray(list)
  ? list.slice(0, MAX_ITEMS).flatMap(item => isObject(item) && text(item[label]) ? [{ text: text(item[label])!, status: text(item.status) ?? "unknown" }] : [])
  : [];

export const TASK_SOURCES: Record<string, TaskSource> = {
  // Claude Code: { todos: [{ content, status, activeForm }] }
  TodoWrite: input => Array.isArray(input.todos) ? { items: items(input.todos, "content") } : null,
  // Codex: { explanation?, plan: [{ step, status }] }
  update_plan: input => Array.isArray(input.plan)
    ? { ...(text(input.explanation) ? { goal: text(input.explanation)! } : {}), items: items(input.plan, "step") } : null,
};

/** The latest recorded list per task source in one turn's native history. */
export function taskLists(history: readonly NativeEvidence[]): TaskList[] {
  const latest = new Map<string, TaskList>();
  for (const evidence of history) {
    if (evidence.kind !== "tool_use" || !evidence.toolName || !evidence.toolInput) continue;
    const read = TASK_SOURCES[evidence.toolName];
    const list = read?.(evidence.toolInput as Record<string, unknown>);
    if (list) latest.set(evidence.toolName, { source: evidence.toolName, observedAt: evidence.observedAt ?? null, ...list });
  }
  return [...latest.values()];
}

// ---------------------------------------------------------------------------
// Turn, learning and knowledge projections
// ---------------------------------------------------------------------------

type Span = { id?: string; parentId?: string; name?: string; kind?: string; agentId?: string; status?: string; startedAt?: number; endedAt?: number; durationMs?: number };

export function slimTurn(detail: TurnDetail) {
  const user = detail.messages.find(message => message.actor === "user");
  const agent = detail.messages.find(message => message.actor === "agent");
  const meta = agent?.meta ?? {};
  const injection = isObject(detail.injection) ? detail.injection : null;
  const plan = isObject(injection?.plan) ? injection.plan : null;
  const spans = Array.isArray(detail.trace?.spans) ? detail.trace.spans as Span[] : [];
  const outcome = Object.fromEntries(["turnStatus", "executionOutcome", "persistence", "nativeOutcome"]
    .filter(key => typeof meta[key] === "string").map(key => [key, meta[key]]));
  return {
    threadId: detail.threadId, turnId: detail.turnId,
    status: detail.turn.status, startedAt: detail.turn.startedAt, endedAt: detail.turn.endedAt ?? null,
    ...(detail.turn.error ? { error: clip(detail.turn.error, 200) } : {}),
    input: { preview: clip(user?.content ?? "", 160), chars: user?.content.length ?? 0 },
    plan: plan ? slim(Object.fromEntries(["elapsed", "sealedAt", "fresh", "confidence", "domainsConsulted", "layers", "input", "routing", "contributions", "omissions", "conflicts", "outstanding"]
      .filter(key => plan[key] !== undefined).map(key => [key, key === "input" && isObject(plan.input)
        ? { hash: plan.input.hash, capturedAt: plan.input.capturedAt } : plan[key]]))) : null,
    snippets: Array.isArray(plan?.snippets) ? plan.snippets.length : null,
    phases: detail.phases.map(row => slim(row)),
    trace: detail.trace ? { id: detail.trace.id, startedAt: detail.trace.startedAt, durationMs: detail.trace.durationMs ?? null } : null,
    spans: spans.slice(0, MAX_ITEMS).map(span => ({ id: span.id, parentId: span.parentId ?? null, name: span.name, kind: span.kind,
      agentId: span.agentId ?? null, status: span.status, startedAt: span.startedAt ?? null, durationMs: span.durationMs ?? null })),
    delivery: isObject(meta.delivery) ? slim(meta.delivery) : null,
    outcome,
    tasks: taskLists(detail.nativeHistory),
    native: { events: detail.nativeHistory.length, tools: detail.nativeTools.length },
  };
}
export type TurnFlow = ReturnType<typeof slimTurn>;

/** One learning outcome: what the inspector's learning entries read, without the review job's inputs or knowledge text. */
export function slimLearning(entry: StoredLearning) {
  const content = isObject(entry.signal.content) ? entry.signal.content : {};
  const job = isObject(content.job) ? content.job : null;
  const base = isObject(job?.base) ? job.base : null;
  const evidence = isObject(content.evidence) ? content.evidence : null;
  const picked: Record<string, unknown> = Object.fromEntries(["domain", "decision", "revision", "reason", "author", "at", "persistence", "admission"]
    .filter(key => content[key] !== undefined).map(key => [key, slim(content[key])]));
  if (evidence) picked.evidence = Object.fromEntries(["kind", "id", "messageId", "agentId", "ok", "timestamp"].filter(key => evidence[key] !== undefined).map(key => [key, evidence[key]]));
  if (job) picked.job = { id: job.id, ...(base ? { base: { revision: base.revision, hash: base.hash } } : {}) };
  if (content.request !== undefined) picked.request = slimRequest(content.request);
  return { storedAt: entry.storedAt, signal: { id: entry.signal.id, kind: entry.signal.kind, content: picked } };
}

/** Committed revision per domain; the knowledge text stays in the journal. */
export function slimKnowledge(bundle: ThreadKnowledgeBundle | undefined) {
  if (!bundle) return null;
  return { capturedAt: bundle.capturedAt, domains: Object.fromEntries(Object.entries(bundle.domains).map(([domain, snapshot]) =>
    [domain, { revision: snapshot.revision, hash: snapshot.hash, author: snapshot.author, updatedAt: snapshot.updatedAt, chars: snapshot.content.length }])) };
}

/** Live review status per domain, without the job's inputs. */
export function slimReview(state: LearningState | undefined) {
  if (!state) return null;
  return Object.fromEntries(Object.entries(state.domains).map(([domain, s]) => [domain, { status: s.status, queued: s.queued, closed: s.closed ?? false }]));
}

export interface FlowJournal {
  store: LocalSessionStore | null;
  /** The thread runtime's live learning state, when a runtime owns the thread. */
  learningState?: (threadId: string) => LearningState | undefined;
}

/** A thread's recent turns, learning history, committed knowledge and live review state. */
export function flowSnapshot(journal: FlowJournal, threadId: string) {
  const { store } = journal;
  const limits = { turns: FLOW_TURNS, learning: FLOW_LEARNING };
  if (!store) return { threadId, journal: "unavailable" as const, turns: [], learning: [], knowledge: null, review: null, limits };
  try {
    const turns = store.recentTurnIds(threadId, FLOW_TURNS).reverse().flatMap(id => {
      const detail = store.turnDetail(threadId, id);
      return detail ? [slimTurn(detail)] : [];
    });
    return { threadId, journal: "available" as const, turns, learning: store.learningHistory(threadId, FLOW_LEARNING).map(slimLearning),
      knowledge: slimKnowledge(store.knowledge(threadId)), review: slimReview(journal.learningState?.(threadId)), limits };
  } catch (error) {
    // A journal that cannot be read (checksum mismatch, closed store) is reported, not retried in a loop.
    return { threadId, journal: "error" as const, error: clip(error instanceof Error ? error.message : String(error), 300), turns: [], learning: [], knowledge: null, review: null, limits };
  }
}
