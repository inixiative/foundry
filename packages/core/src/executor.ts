import { computeHash, REQUIRED_CONTEXT_BLOCKED } from "./context-layer";
import { BaseAgent, type AgentConfig, type ExecutionResult } from "./base-agent";
import type { AssembledContext, ContextStack, LayerFilter } from "./context-stack";
import { buildInjectionArtifact, type InjectionArtifact, type MessageDecoration } from "./messages";
import type { LLMMessage } from "./types";
import type { ToolCallObservation } from "./tools";
import type { NativeEvidence, NativeObservation } from "./native-evidence";

/** Runtime metadata passed to executor handlers at dispatch time. */
export interface ExecuteMeta {
  nativeObservation?: NativeObservation;
  recordNative?: (evidence: NativeEvidence) => void;
  recordCompleted?: (output: unknown) => void;
  /** Working directory for this dispatch (from the thread's worktree). */
  cwd?: string;
  /** Thread ID that dispatched this execution. */
  threadId?: string;
  /** Project that owns the dispatching thread. Scopes memory tool reads. */
  projectId?: string;
  /** Logical message identity, not a native session or dispatch ID. */
  messageId?: string;
  /** Identity of this dispatch. Every tool the handler executes is attributed to it. */
  dispatchId?: string;
  /**
   * Report one executed tool call. The thread turns it into a
   * `tool_observation` signal carrying the dispatch identity, so evidence
   * is correlated to this work and never to whichever turn finishes next.
   */
  observeTool?: (observation: ToolCallObservation) => void;
  /** Arbitrary annotations from middleware. */
  annotations?: Record<string, unknown>;
  /**
   * Streaming sink — when provided, the executor should emit text deltas
   * here as they arrive. Accumulates upstream into a StreamBuffer.
   * Absent ⇒ non-streaming (complete → full result) semantics.
   */
  onDelta?: (text: string) => void;
  /** Record the initial messages at the provider boundary for inspection. */
  recordProviderInput?: (messages: LLMMessage[]) => void;
  /** Capture prepared input even on failure; this is not delivery acknowledgment. */
  recordInjection?: (artifact: InjectionArtifact) => void;
}

export type ExecuteHandler<TPayload, TResult> = (
  context: string,
  payload: TPayload,
  meta?: ExecuteMeta
) => Promise<TResult>;

export interface ExecutorConfig<TPayload = unknown, TResult = unknown>
  extends AgentConfig {
  handler: ExecuteHandler<TPayload, TResult>;
}

/**
 * An Executor takes context + payload, goes and does work, returns full results.
 */
export class Executor<TPayload = unknown, TResult = unknown> extends BaseAgent<
  TPayload,
  TResult
> {
  private _handler: ExecuteHandler<TPayload, TResult>;

  constructor(config: ExecutorConfig<TPayload, TResult>) {
    super(config);
    this._handler = config.handler;
  }

  withStack(stack: ContextStack): Executor<TPayload, TResult> {
    return new Executor<TPayload, TResult>({ ...this.agentConfig(stack), handler: this._handler });
  }

  async run(
    payload: TPayload,
    filterOverride?: LayerFilter,
    meta?: ExecuteMeta
  ): Promise<ExecutionResult<TResult>> {
    // Decoration composed by pre-message middleware (parallel domain advice)
    // rides in on annotations and is appended after the assembled layers, so
    // the executor's context, the provider input and the artifact agree.
    const decoration = meta?.annotations?.decoration as MessageDecoration | undefined;
    const plan = meta?.annotations?.injectionPlan;
    const base = this.assembleContext(filterOverride);
    const blocks = decoration?.blocks.length ? [...base.blocks, ...decoration.blocks] : base.blocks;
    const assembled: AssembledContext = decoration?.blocks.length
      ? { blocks, text: blocks.map((block) => block.text).join("\n\n") }
      : base;
    const context = assembled.text;
    const contextHash = computeHash(context);
    const capturedAt = Date.now();
    const included = new Set(assembled.blocks.map(block => block.id));
    const layers = this._stack.layers.map(layer => ({
      ...layer.snapshotInstance(meta?.threadId),
      id: layer.id,
      prompt: layer.prompt,
      sourceIds: layer.sources.map(source => source.id),
      included: included.has(layer.id),
    }));
    const userMessage = typeof payload === "string" ? payload : JSON.stringify(payload);
    const injection = buildInjectionArtifact({
      userMessage,
      assembled: base,
      decoration,
      layerFreshness: Object.fromEntries(layers.map(layer => [layer.id, {
        state: layer.state, lastWarmed: layer.lastWarmed,
      }])),
    });
    let providerMessages: LLMMessage[] | undefined;
    let providerBoundary: ProviderBoundaryReceipt | undefined;
    const capture = (): InjectionArtifact => ({ ...injection, capturedAt, threadId: meta?.threadId,
      projectId: meta?.projectId, messageId: meta?.messageId, providerBoundary,
      executorContext: context, providerMessages, layers,
      ...(plan !== undefined ? { plan } : {}) });
    const observe = (callback: () => void) => {
      try { callback(); }
      catch (error) { console.warn("[Executor] input evidence observer failed:", error); }
    };
    const record = () => observe(() => meta?.recordInjection?.(structuredClone(capture())));
    // These are in-memory preparation observations, not durable writes or
    // acknowledgment by a provider. A process crash can still lose them.
    record();
    // Shared layers may finish a coalesced load for a later request. Preserve
    // the actual prepared evidence above, but never send it as this request's
    // selection. No retry/replay is implied by refusing this provider call.
    const mismatched = layers.filter(layer => {
      if (!layer.included || !layer.selection) return false;
      const selectedFor = layer.selection.currentMessage;
      // Standalone legacy sources have no request-identity contract. A flow
      // plan does: even its unidentified loads must not replace identified work.
      if (!selectedFor && plan === undefined) return false;
      const expectedId = meta?.messageId && meta.threadId ? meta.messageId : undefined;
      return selectedFor?.messageId !== expectedId || (selectedFor !== undefined &&
        (selectedFor.threadId !== meta?.threadId || selectedFor.projectId !== meta?.projectId));
    });
    if (mismatched.length) {
      throw new Error(`Memory selection changed before provider execution: logical message ownership differs for layer(s) ${mismatched.map(l => l.id).join(", ")}`);
    }
    // A selecting source that could not carry required context is a reason to
    // stop, not a note for the model. Refuse before any provider call; the
    // recorded artifact above keeps the conflict and record ids inspectable.
    const blocked = layers.filter(layer => layer.included).flatMap(layer => (layer.selection?.sources ?? []).flatMap(source =>
      source.report.conflicts.filter(conflict => conflict.kind === REQUIRED_CONTEXT_BLOCKED)
        .map(conflict => `layer ${layer.id}, source ${source.sourceId}: ${conflict.ids.join(", ")}`)));
    if (blocked.length) {
      throw new Error(`Required memory context blocked before provider execution: pinned records exceed the selection cap and no scoped retrieval is available (${blocked.join("; ")})`);
    }
    let output: TResult;
    let native: NativeEvidence | undefined;
    let recording = true;
    try {
      output = await this._handler(context, payload, {
        ...meta,
        recordNative: evidence => { if (recording) { native = evidence; observe(() => meta?.recordNative?.(evidence)); } },
        recordProviderInput: messages => {
          // The initial boundary input must not be replaced by tool followups.
          if (providerMessages === undefined) {
            providerMessages = structuredClone(messages);
            if (meta?.threadId && meta.messageId) providerBoundary = boundaryReceipt(capture(), {
              threadId: meta.threadId, messageId: meta.messageId, ...(meta.projectId ? { projectId: meta.projectId } : {}),
            });
          }
          record();
          observe(() => meta?.recordProviderInput?.(structuredClone(messages)));
        },
      });
    } finally {
      recording = false;
      // The handler can throw a frozen error or a primitive. Observe evidence
      // independently rather than modifying the thrown value or inventing output.
      record();
    }

    observe(() => meta?.recordCompleted?.(structuredClone(output)));

    return {
      output,
      contextHash,
      meta: {
        ...(native ? { native } : {}),
        injection: capture(),
      },
    };
  }
}
import { boundaryReceipt, type ProviderBoundaryReceipt } from "./delivery-evidence";
