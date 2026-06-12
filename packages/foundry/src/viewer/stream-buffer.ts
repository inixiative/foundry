// ---------------------------------------------------------------------------
// StreamBufferRegistry — server-side in-memory buffers for in-flight messages
// ---------------------------------------------------------------------------
//
// When a message is sent with streaming, the harness emits deltas as text
// arrives from the model. We accumulate the full content here until the
// turn completes, then do a single DB write. The buffer lives independently
// of the HTTP connection that initiated the stream, so a client navigating
// away (or a dropped connection) does not abort the underlying turn — it
// continues to completion and is persisted.
//
// Multiple concurrent streams across threads are fine: each send gets its
// own buffer keyed by messageId. A buffer drops itself on completion or
// error after persistence has run.
// ---------------------------------------------------------------------------

export interface StreamBufferSnapshot {
  readonly messageId: string;
  readonly threadId: string;
  readonly content: string;
  readonly startedAt: number;
  readonly completedAt?: number;
  readonly error?: string;
}

export class StreamBuffer {
  readonly messageId: string;
  readonly threadId: string;
  readonly startedAt: number;
  private _parts: string[] = [];
  private _completedAt?: number;
  private _error?: string;

  constructor(messageId: string, threadId: string) {
    this.messageId = messageId;
    this.threadId = threadId;
    this.startedAt = Date.now();
  }

  append(text: string): void {
    if (this._completedAt !== undefined) return;
    this._parts.push(text);
  }

  complete(): void {
    if (this._completedAt !== undefined) return;
    this._completedAt = Date.now();
  }

  fail(err: string): void {
    if (this._completedAt !== undefined) return;
    this._error = err;
    this._completedAt = Date.now();
  }

  get content(): string {
    return this._parts.join("");
  }

  get done(): boolean {
    return this._completedAt !== undefined;
  }

  get error(): string | undefined {
    return this._error;
  }

  snapshot(): StreamBufferSnapshot {
    return {
      messageId: this.messageId,
      threadId: this.threadId,
      content: this.content,
      startedAt: this.startedAt,
      completedAt: this._completedAt,
      error: this._error,
    };
  }
}

export class StreamBufferRegistry {
  private _buffers = new Map<string, StreamBuffer>();

  /** Create and register a buffer for a new message. */
  open(messageId: string, threadId: string): StreamBuffer {
    const buf = new StreamBuffer(messageId, threadId);
    this._buffers.set(messageId, buf);
    return buf;
  }

  get(messageId: string): StreamBuffer | undefined {
    return this._buffers.get(messageId);
  }

  /** All live (unfinished) buffers — for diagnostics / multi-thread visibility. */
  live(): StreamBufferSnapshot[] {
    const out: StreamBufferSnapshot[] = [];
    for (const buf of this._buffers.values()) {
      if (!buf.done) out.push(buf.snapshot());
    }
    return out;
  }

  /** Drop a buffer after persistence has run. */
  drop(messageId: string): void {
    this._buffers.delete(messageId);
  }

  /** Buffers for a specific thread — used when recovering UI state after reconnect. */
  forThread(threadId: string): StreamBufferSnapshot[] {
    const out: StreamBufferSnapshot[] = [];
    for (const buf of this._buffers.values()) {
      if (buf.threadId === threadId) out.push(buf.snapshot());
    }
    return out;
  }
}
