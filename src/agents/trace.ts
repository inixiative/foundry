/**
 * A single span in a message's journey through the system.
 * Each stage (classify, route, dispatch, writeback, middleware) creates a span.
 */
export interface Span {
  readonly id: string;
  readonly parentId?: string;
  readonly name: string;
  readonly kind: SpanKind;
  readonly agentId?: string;
  readonly threadId?: string;

  /** What layers were visible to this stage. */
  readonly layerIds?: string[];

  /** Context hash at the time of this span. */
  readonly contextHash?: string;

  /** Input to this stage. */
  readonly input?: unknown;

  /** Output from this stage. */
  readonly output?: unknown;

  readonly startedAt: number;
  endedAt?: number;
  durationMs?: number;

  /** Status of this span. */
  status: SpanStatus;

  /** If errored, the error detail. */
  error?: unknown;

  /** Arbitrary annotations from middleware or handlers. */
  annotations: Record<string, unknown>;

  /** Child spans (for nested dispatch, fan-out, etc.) */
  children: Span[];
}

export type SpanKind =
  | "ingress"
  | "classify"
  | "route"
  | "dispatch"
  | "execute"
  | "decide"
  | "middleware"
  | "writeback"
  | "egress"
  | "fan"
  | (string & {});

export type SpanStatus = "running" | "ok" | "error";

let _spanCounter = 0;
function nextSpanId(): string {
  return `span_${++_spanCounter}_${Date.now().toString(36)}`;
}

/**
 * A Trace is the full journey of a single message through the system.
 *
 * Created at ingress, it accumulates spans as the message flows through
 * classify → route → dispatch → middleware → execute → writeback → egress.
 * Each span can have child spans (e.g. a dispatch span contains an execute span,
 * a fan span contains multiple dispatch children).
 *
 * The UI renders a Trace as a drillable tree — click any span to see
 * what layers it saw, what it received, what it produced, how long it took.
 */
export class Trace {
  readonly id: string;
  readonly messageId: string;
  readonly startedAt: number;
  endedAt?: number;

  /** The root span — usually "ingress". Children branch from here. */
  readonly root: Span;

  /** Flat index of all spans for quick lookup. */
  private _spans: Map<string, Span> = new Map();

  /** Current active span stack — the innermost is where new children attach. */
  private _stack: Span[] = [];

  constructor(messageId: string) {
    this.id = `trace_${Date.now().toString(36)}_${messageId}`;
    this.messageId = messageId;
    this.startedAt = performance.now();

    this.root = this._createSpan("ingress", "ingress");
    this._stack.push(this.root);
  }

  /** Start a new span as a child of the current active span. */
  start(name: string, kind: SpanKind, detail?: Partial<Span>): Span {
    const parent = this._stack[this._stack.length - 1];
    const span = this._createSpan(name, kind, parent?.id, detail);
    if (parent) {
      parent.children.push(span);
    }
    this._stack.push(span);
    return span;
  }

  /** End the current active span. */
  end(output?: unknown, error?: unknown): Span | undefined {
    const span = this._stack.pop();
    if (!span) return undefined;

    span.endedAt = performance.now();
    span.durationMs = span.endedAt - span.startedAt;

    if (error) {
      span.status = "error";
      span.error = error;
    } else {
      span.status = "ok";
    }

    if (output !== undefined) {
      (span as { output: unknown }).output = output;
    }

    return span;
  }

  /** End the entire trace. Closes any remaining open spans. */
  finish(): void {
    const now = performance.now();
    // Close any unclosed spans — preserve their current status if already set
    while (this._stack.length > 0) {
      const span = this._stack.pop()!;
      if (!span.endedAt) {
        span.endedAt = now;
        span.durationMs = span.endedAt - span.startedAt;
      }
      if (span.status === "running") {
        span.status = "ok";
      }
    }
    this.endedAt = now;
  }

  /** Get a span by id. */
  getSpan(id: string): Span | undefined {
    return this._spans.get(id);
  }

  /** All spans as a flat list, ordered by start time. */
  get spans(): ReadonlyArray<Span> {
    return [...this._spans.values()].sort((a, b) => a.startedAt - b.startedAt);
  }

  /** Total duration of the trace. */
  get durationMs(): number | undefined {
    return this.endedAt ? this.endedAt - this.startedAt : undefined;
  }

  /** The current active span (innermost). */
  get current(): Span | undefined {
    return this._stack[this._stack.length - 1];
  }

  /** How deep we are in the span stack. */
  get depth(): number {
    return this._stack.length;
  }

  /**
   * Produce a summary for display — the key stages and their outcomes.
   * This is what shows up in a message list before you drill in.
   */
  summary(): TraceSummary {
    const stages: StageSummary[] = [];

    const walk = (span: Span, depth: number) => {
      stages.push({
        name: span.name,
        kind: span.kind,
        status: span.status,
        durationMs: span.durationMs,
        agentId: span.agentId,
        depth,
      });
      for (const child of span.children) {
        walk(child, depth + 1);
      }
    };

    walk(this.root, 0);

    return {
      traceId: this.id,
      messageId: this.messageId,
      totalDurationMs: this.durationMs,
      spanCount: this._spans.size,
      stages,
    };
  }

  // -- Internal --

  private _createSpan(
    name: string,
    kind: SpanKind,
    parentId?: string,
    detail?: Partial<Span>
  ): Span {
    const span: Span = {
      id: nextSpanId(),
      parentId,
      name,
      kind,
      agentId: detail?.agentId,
      threadId: detail?.threadId,
      layerIds: detail?.layerIds,
      contextHash: detail?.contextHash,
      input: detail?.input,
      output: undefined,
      startedAt: performance.now(),
      status: "running",
      annotations: detail?.annotations ?? {},
      children: [],
    };

    this._spans.set(span.id, span);
    return span;
  }
}

export interface TraceSummary {
  readonly traceId: string;
  readonly messageId: string;
  readonly totalDurationMs?: number;
  readonly spanCount: number;
  readonly stages: StageSummary[];
}

export interface StageSummary {
  readonly name: string;
  readonly kind: SpanKind;
  readonly status: SpanStatus;
  readonly durationMs?: number;
  readonly agentId?: string;
  readonly depth: number;
}
