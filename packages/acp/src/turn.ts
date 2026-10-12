import type { SessionUpdate, StopReason, ToolCallStatus } from '@agentclientprotocol/sdk';
import type { LiveActivity, StreamBufferSnapshot } from '@inixiative/foundry/client';
import { type ContextSummary, contextSummary } from './context';
import { guardComments } from './guard';
import { planEntries, toolKind, toolLocations, toolTitle } from './tools';

/** How long a finished turn seen only in a snapshot waits for its own terminal before settling from the snapshot. */
const TERMINAL_GRACE_MS = 1_000;
const JOURNAL_WAIT_MS = 2_000;

export class TurnFailedError extends Error {
  constructor(
    message: string,
    readonly turnId: string,
  ) {
    super(message);
    this.name = 'TurnFailedError';
  }
}

const status = (state: LiveActivity['state']): ToolCallStatus =>
  state === 'completed' ? 'completed' : state === 'failed' ? 'failed' : 'in_progress';

/**
 * One prompt's projection from the daemon's `thread:<id>` and `flow:<id>` streams onto ACP
 * `session/update`s, ending in its stop reason. Each text row's appended text is sent once; each
 * tool row becomes a `tool_call`, then `tool_call_update`s as its state changes.
 */
export class TurnProjection {
  readonly done: Promise<StopReason>;
  cancelRequested = false;
  /** The daemon accepted the turn; from here a snapshot without it means it was lost. */
  accepted = false;
  private settled = false;
  private streamed = false;
  private contextClosed = false;
  private summary: ContextSummary | null = null;
  private readonly text = new Map<string, string>();
  private readonly tools = new Map<string, LiveActivity['state']>();
  private readonly thoughts = new Map<string, string>();
  /** Native call id → the ACP tool call id shown for it, for permission requests. */
  private readonly calls = new Map<string, string>();
  private readonly guards = new Set<string>();
  private lastPlan = '';
  private fallback: ReturnType<typeof setTimeout> | null = null;
  private closing: Promise<void> | null = null;
  private resolve!: (reason: StopReason) => void;
  private reject!: (error: Error) => void;

  constructor(
    readonly turnId: string,
    readonly threadId: string,
    private readonly emit: (update: SessionUpdate) => void,
    private readonly cwd?: string,
    /** The turn's journalled phase rows, for a turn that settles before its flow append arrives. */
    private readonly journal?: () => Promise<unknown>,
  ) {
    this.done = new Promise<StopReason>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }

  private get contextId() {
    return `foundry-context:${this.turnId}`;
  }

  /** The visible middleware item opens as soon as the turn is sent. */
  open(): void {
    this.emit({
      sessionUpdate: 'tool_call',
      toolCallId: this.contextId,
      title: 'Foundry: context',
      kind: 'think',
      status: 'in_progress',
    });
  }

  private closeContext(): void {
    if (this.contextClosed) return;
    this.contextClosed = true;
    const summary = this.summary;
    this.emit({
      sessionUpdate: 'tool_call_update',
      toolCallId: this.contextId,
      status: 'completed',
      content: [
        {
          type: 'content',
          content: {
            type: 'text',
            text: summary?.text ?? 'No routing or advice was recorded for this turn.',
          },
        },
      ],
      _meta: {
        foundry: {
          threadId: this.threadId,
          turnId: this.turnId,
          routing: summary?.routing ?? null,
          participants: summary?.participants ?? [],
        },
      },
    });
  }

  private chunk(text: string): void {
    if (!text) return;
    this.output();
    this.streamed = true;
    this.emit({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
  }

  /** The ACP tool call already shown for a native call, if any. */
  toolCallFor(callId: string | undefined): string | undefined {
    return callId ? this.calls.get(callId) : undefined;
  }

  /** A `flow:<threadId>` turn: its sealed route/advice rows complete the context item; Warden notes become comments. */
  flowTurn(turn: unknown): void {
    if (this.settled) return;
    if ((turn as { turnId?: unknown } | null)?.turnId !== this.turnId) return;
    for (const guard of guardComments(turn)) {
      if (this.guards.has(guard.id)) continue;
      this.guards.add(guard.id);
      this.emit({
        sessionUpdate: 'tool_call',
        toolCallId: `foundry-guard:${guard.id}`,
        title: 'Foundry: guard',
        kind: 'think',
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: guard.text } }],
        _meta: { foundry: { threadId: this.threadId, turnId: this.turnId, guard: guard.meta } },
      });
    }
    if (this.contextClosed) return;
    const summary = contextSummary(turn);
    if (!summary) return;
    this.summary = summary;
    this.closeContext();
  }

  delta(text: string): void {
    if (!this.settled) this.chunk(text);
  }

  activity(row: LiveActivity, appended?: string): void {
    if (this.settled) return;
    if (row.kind === 'thought') {
      const prior = this.thoughts.get(row.id) ?? '';
      const next = row.text ?? '';
      this.thoughts.set(row.id, next);
      const text = appended ?? (next.startsWith(prior) ? next.slice(prior.length) : '');
      if (text)
        this.emit({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text } });
      return;
    }
    // The executor's plan tool is the host's plan, not a tool call.
    const plan = row.kind === 'tool' ? planEntries(row.toolName ?? '', row.input) : null;
    if (plan) {
      const key = JSON.stringify(plan);
      if (key !== this.lastPlan) {
        this.lastPlan = key;
        this.emit({ sessionUpdate: 'plan', entries: plan });
      }
      return;
    }
    if (row.kind === 'text') {
      const prior = this.text.get(row.id) ?? '';
      const next = row.text ?? '';
      this.text.set(row.id, next);
      this.chunk(appended ?? (next.startsWith(prior) ? next.slice(prior.length) : ''));
      return;
    }
    const known = this.tools.get(row.id);
    const title = toolTitle(row.toolName ?? 'Tool', row.input);
    const kind = toolKind(row.toolName ?? '');
    if (known === undefined) {
      this.output();
      this.tools.set(row.id, row.state);
      if (row.callId) this.calls.set(row.callId, row.id);
      this.emit({
        sessionUpdate: 'tool_call',
        toolCallId: row.id,
        title,
        kind,
        status: status(row.state),
        ...(row.input ? { rawInput: row.input } : {}),
        locations: toolLocations(row.input, this.cwd),
      });
      if (row.state === 'running') return;
    } else if (known === row.state) return;
    this.tools.set(row.id, row.state);
    if (row.state === 'running') return;
    this.emit({
      sessionUpdate: 'tool_call_update',
      toolCallId: row.id,
      // Repeated so hosts that rebuild a call's label from each update keep it.
      title,
      kind,
      status: status(row.state),
      ...(row.output !== undefined
        ? {
            rawOutput: { output: row.output },
            content: [{ type: 'content', content: { type: 'text', text: row.output } }],
          }
        : {}),
    });
  }

  /** A full live turn from a snapshot or a `turn` append: catch up rows, and settle a finished turn whose terminal never came. */
  snapshot(turn: StreamBufferSnapshot | undefined): void {
    if (this.settled) return;
    if (!turn) {
      if (this.accepted)
        this.fail(
          'Foundry no longer holds this turn (the daemon restarted); see its journal for the outcome.',
        );
      return;
    }
    for (const row of turn.activity) this.activity(row);
    if (turn.status !== 'completed' && turn.status !== 'failed') return;
    this.fallback ??= setTimeout(() => {
      if (this.settled) return;
      if (turn.status === 'completed') this.finish(turn.content);
      else this.fail(turn.error ?? 'Turn failed');
    }, TERMINAL_GRACE_MS);
  }

  /** The sender-only terminal: the full result of this turn. */
  terminal(kind: 'done' | 'error', result: Record<string, unknown>): void {
    if (this.settled) return;
    if (kind === 'done') this.finish(typeof result.content === 'string' ? result.content : '');
    else if (result.cancelled === true) this.finish('', 'cancelled');
    else this.fail(typeof result.error === 'string' ? result.error : 'Turn failed');
  }

  private finish(content: string, reason?: StopReason): void {
    if (!this.settle()) return;
    if (!this.streamed) this.chunk(content);
    void this.closeFromJournal().then(() =>
      this.resolve(reason ?? (this.cancelRequested ? 'cancelled' : 'end_turn')),
    );
  }

  private fail(message: string): void {
    if (!this.settle()) return;
    void this.closeFromJournal().then(() => {
      if (this.cancelRequested) this.resolve('cancelled');
      else this.reject(new TurnFailedError(message, this.turnId));
    });
  }

  /** The executor has produced output, so its route and advice rows are sealed: complete the context item now. */
  private output(): void {
    if (!this.contextClosed) void this.closeFromJournal();
  }

  /** The route and advice rows are durable before the executor runs; read them from the journal once. */
  private closeFromJournal(): Promise<void> {
    this.closing ??= (async () => {
      if (!this.contextClosed && !this.summary && this.journal) {
        const detail = await Promise.race([
          this.journal().catch(() => null),
          Bun.sleep(JOURNAL_WAIT_MS).then(() => null),
        ]);
        this.summary ??= contextSummary(detail);
      }
      this.closeContext();
    })();
    return this.closing;
  }

  /** The daemon has been unreachable too long to wait for this turn's outcome. */
  lost(message: string): void {
    this.fail(message);
  }

  /** The send itself failed; nothing was accepted. */
  abort(error: Error): void {
    if (!this.settle()) return;
    this.summary = {
      text: `Not accepted by Foundry: ${error.message}`,
      routing: null,
      participants: [],
    };
    this.closeContext();
    this.reject(error);
  }

  /** Mark settled once; false when it already was. */
  private settle(): boolean {
    if (this.settled) return false;
    this.settled = true;
    if (this.fallback) clearTimeout(this.fallback);
    return true;
  }

  get isSettled(): boolean {
    return this.settled;
  }
}
