/**
 * Spec A (docs/THREAD-TREE.md): each middleware call of a turn becomes one small entry — its state
 * and its result, never the message it was sent. Raw middleware rows stay in the journal under a
 * retention setting; Archive only ever gets these.
 */

/** Phase rows that carry a middleware call's full input, reduced at the end of their turn. */
export const RAW_MIDDLEWARE_PHASES = ['route', 'advice', 'guard-request', 'guard-outcome'] as const;

export const REDUCED_PHASE = 'middleware-reduced';

export interface ReducedMiddleware {
  /** Stable per call: `<source row id>` or `<source row id>:<domain>`. */
  readonly callId: string;
  /** `cartographer`, or the Warden's domain. */
  readonly role: string;
  readonly trigger: string;
  /** What it was asked about: `turn:<id>` for a message or a turn's actions, a tool call id (`guard: per-call`), `handoff:<child>` for a brief. */
  readonly wraps: string;
  readonly decision: string;
  readonly reason?: string;
  /** What it said: snippets or notes; null when it had nothing to add. */
  readonly result: unknown;
  /** The versions it ran with (spec B) and its thread knowledge revision; no composed text. */
  readonly state: Record<string, unknown>;
  readonly served?: { readonly model: string; readonly effort?: string };
  readonly at: number;
  /** The raw rows this entry reduces: retention deletes a raw row only when an entry names it. */
  readonly sources: readonly string[];
}

interface PhaseRow {
  readonly id: string;
  readonly turnId: string | null;
  readonly phase: string;
  readonly record: Record<string, unknown>;
  readonly storedAt: number;
}

type Rec = Record<string, unknown>;
const obj = (value: unknown): Rec | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Rec) : undefined;
const served = (request: unknown) => {
  const s = obj(obj(request)?.served);
  return typeof s?.model === 'string'
    ? { model: s.model, ...(typeof s.effort === 'string' ? { effort: s.effort } : {}) }
    : undefined;
};

/**
 * One turn's middleware rows as reduced entries, in row order. Rows of other phases are ignored.
 * `keep` stores text the entry refers to by hash (a call's thread knowledge, stored raw).
 */
export function reduceMiddleware(
  rows: readonly PhaseRow[],
  keep: (text: string) => string = () => '',
): ReducedMiddleware[] {
  const requests = new Map(rows.filter((r) => r.phase === 'guard-request').map((r) => [r.id, r]));
  const out: ReducedMiddleware[] = [];
  for (const row of rows) {
    const r = row.record;
    // A row says what it wraps (a handoff, a call, a turn); one that does not wraps its turn.
    const wraps = typeof r.wraps === 'string' ? r.wraps : `turn:${row.turnId ?? 'none'}`;
    if (row.phase === 'route') {
      const routing = obj(r.routing) ?? {};
      out.push({
        callId: row.id,
        role: 'cartographer',
        trigger: 'user-message',
        wraps,
        decision: String(routing.status ?? 'unknown'),
        ...(typeof routing.reason === 'string' ? { reason: routing.reason } : {}),
        result: {
          ...(Array.isArray(routing.layers) ? { layers: routing.layers } : {}),
          ...(Array.isArray(routing.domains) ? { domains: routing.domains } : {}),
        },
        state: { ...(obj(obj(routing.request)?.versions) ?? {}) },
        ...(served(routing.request) ? { served: served(routing.request)! } : {}),
        at: row.storedAt,
        sources: [row.id],
      });
      continue;
    }
    if (row.phase === 'advice') {
      for (const p of (r.participants as Rec[] | undefined) ?? []) {
        const snippets = Array.isArray(p.snippets) ? (p.snippets as string[]) : [];
        const knowledge = obj(p.segments)?.threadKnowledge;
        out.push({
          callId: `${row.id}:${String(p.domain)}`,
          role: String(p.domain),
          trigger: String(r.trigger ?? 'user-message'),
          wraps,
          decision: String(p.decision),
          ...(typeof p.reason === 'string' ? { reason: p.reason } : {}),
          result: snippets.length ? snippets : null,
          state: {
            ...(typeof r.charter === 'string' ? { charter: r.charter } : {}),
            ...(obj(obj(p.request)?.versions) ? { versions: obj(obj(p.request)?.versions) } : {}),
            ...(typeof p.threadKnowledgeRevision === 'number'
              ? {
                  threadKnowledge: {
                    revision: p.threadKnowledgeRevision,
                    ...(typeof knowledge === 'string' ? { hash: keep(knowledge) } : {}),
                  },
                }
              : {}),
            ...(typeof p.cacheHash === 'string' ? { cacheHash: p.cacheHash } : {}),
          },
          ...(served(p.request) ? { served: served(p.request)! } : {}),
          at: row.storedAt,
          sources: [row.id],
        });
      }
      continue;
    }
    if (row.phase === 'guard-outcome') {
      for (const o of (r.outcomes as Rec[] | undefined) ?? []) {
        const requestRow =
          typeof o.requestRecord === 'string' ? requests.get(o.requestRecord) : undefined;
        const request = obj(requestRow?.record.request);
        const notes = Array.isArray(o.notes) ? o.notes : [];
        out.push({
          callId: `${row.id}:${String(o.domain)}`,
          role: String(o.domain),
          trigger: String(r.trigger ?? 'agent-action'),
          wraps,
          decision: String(o.status ?? 'unknown'),
          ...(typeof o.error === 'string' ? { reason: o.error } : {}),
          result: notes.length ? notes : null,
          state: {
            ...(typeof r.charter === 'string' ? { charter: r.charter } : {}),
            ...(obj(request?.versions) ? { versions: obj(request?.versions) } : {}),
            ...(typeof o.threadKnowledgeRevision === 'number'
              ? { threadKnowledge: { revision: o.threadKnowledgeRevision } }
              : {}),
          },
          ...(o.served && obj(o.served)?.model
            ? { served: served({ served: o.served })! }
            : served(request)
              ? { served: served(request)! }
              : {}),
          at: row.storedAt,
          sources: requestRow ? [row.id, requestRow.id] : [row.id],
        });
      }
    }
    // A guard request is reduced with its outcome; a request whose outcome never came stays raw.
  }
  return out;
}
